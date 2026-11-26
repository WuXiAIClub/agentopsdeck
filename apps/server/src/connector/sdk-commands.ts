import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { prepareSdkMessageAdmission, type SdkMessageAdmission as Admission } from './sdk-message-admission.js';
import type { SdkInputAttachment } from './sdk-attachment-input.js';
import { SessionDeletionConflict, TurnAuthorizationError, type TurnQueueCommit } from '../commands/turn-queue.js';
import { requireExpectedRun, RunControlConflict } from '../commands/run-control.js';
import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { SdkTextInput } from '../connector/sdk-dispatch.js';
import type { SdkExecutionDriver, SdkOwnedTurn } from './sdk-execution-driver.js';
import type { SdkAgentId, SdkExecutionJournal } from './sdk-execution-journal.js';
import { sdkModelAllowed } from './sdk-models.js';
import { isSdkCompactCommand, SdkUnsupportedTextCommand } from './sdk-text-command.js';

type Actor = Pick<SdkTextInput, 'actorId' | 'executionGrant'> & { signal?: AbortSignal };
type Creation<R extends SdkAgentId> = { key: string; agentId: R; title: string };
export type SdkCommandOptions<R extends SdkAgentId> = {
  runtime: R; journal: SdkExecutionJournal;
  store: ConnectorUserStore; driver: Pick<SdkExecutionDriver<SdkOwnedTurn>, 'wake' | 'interrupt'> & Partial<Pick<SdkExecutionDriver<SdkOwnedTurn>, 'compact'>>;
  assertAvailable: (requireStartup: boolean) => void;
  authorize: (key: string, actor: SdkTextInput, action: 'messages:send' | 'runs:interrupt' | 'runs:compact') => boolean;
  changed: (key: string) => void;
  models: { model?: string; modelChoices?: string[]; dynamicModels?: boolean };
};

/** Internal owner-only command boundary; NOT an HTTP authorization layer.
 * Routes must authenticate the Connector owner and claim actor-scoped receipts
 * before calling. These methods never replay an unknown/accepted receipt.
 * No native session is created until the first separately admitted message. */
export class SdkCommands<R extends SdkAgentId> {
  constructor(private readonly options: SdkCommandOptions<R>) {
    if (options.journal.runtime !== options.runtime) throw new Error('SDK command runtime mismatch');
  }

  updateModel(key: string, model: string | null, authorize: () => void, acknowledge: (model: string) => void) {
    this.assertSettingsAvailable(key);
    this.options.journal.checkAuthority(authorize);
    const { store, journal, models } = this.options;
    if (!models.model) throw new Error('Model override is not supported for this runtime');
    if (!journal.session(key) || store.commands.sessionDeletion(key)
      || !journal.canStart(key) || store.turns.hasPending(this.options.runtime, key)) throw new SessionDeletionConflict();
    const defaultModel = models.model;
    if (model !== null && !sdkModelAllowed(models, model)) {
      throw new Error('Model is not in this Connector catalog');
    }
    journal.updateModel(key, model, () => {
      this.options.assertAvailable(true); journal.checkAuthority(authorize);
      return acknowledge(model ?? defaultModel);
    });
    this.notify(key);
  }

  /** Definitive pre-write denial, never an uncertain native dispatch. */
  assertSettingsAvailable(key: string) {
    try { this.options.assertAvailable(true); }
    catch { throw new SessionDeletionConflict('Agent settings are unavailable until the runtime is ready'); }
    if (!this.options.journal.session(key) || !this.options.journal.canStart(key)
      || this.options.store.commands.sessionDeletion(key)
      || this.options.store.turns.hasPending(this.options.runtime, key)) {
      throw new SessionDeletionConflict('Session settings require an idle session with an empty queue');
    }
  }

  createSession(title: string, options: {
    authorize: () => void;
    accept: (result: Creation<R>) => (db: DatabaseSync) => void;
  }): Creation<R> {
    this.options.assertAvailable(true);
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) {
      throw new Error('Invalid SDK session title');
    }
    this.options.journal.checkAuthority(options.authorize, options);
    const result: Creation<R> = { key: `${this.options.runtime}:${randomUUID()}`, agentId: this.options.runtime, title: title.trim() };
    const commit = options.accept(result);
    this.options.journal.create({ key: result.key, title: result.title,
      nativeSessionId: randomUUID(), createdAt: Date.now() }, db => {
      this.options.assertAvailable(true);
      this.options.journal.checkAuthority(options.authorize, options);
      if (this.options.store.commands.sessionDeletion(result.key)) throw new SessionDeletionConflict();
      return commit(db);
    });
    this.notify(result.key);
    return result;
  }

  send(key: string, text: string, actor: Actor & { accept: (result: Admission) => TurnQueueCommit }, attachments: SdkInputAttachment[] = []): Admission {
    const pending = this.prepareSend(key, text, actor, attachments);
    this.options.store.turns.enqueue<SdkTextInput>(this.options.runtime, pending.turn, pending.commit);
    this.changed(key);
    return pending.result;
  }

  /** Wait only for physical admission, then commit queue, attachments and the
   * original receipt together. A lost release reply must not strand committed
   * work or turn an uncertain response into permission to resend. */
  async sendAsync(key: string, text: string, actor: Actor & { accept: (result: Admission) => TurnQueueCommit }, attachments: SdkInputAttachment[] = []): Promise<Admission> {
    const pending = this.prepareSend(key, text, { ...actor }, attachments);
    const { store, runtime } = this.options;
    let notified = false;
    const unlisten = store.turns.onAdmission(admittedRuntime => {
      if (admittedRuntime !== runtime || notified || !store.turns.hasCommand(runtime, pending.turn.id)) return;
      notified = true;
      this.changed(key);
    });
    try {
      await store.turns.enqueueAsync<SdkTextInput>(runtime, pending.turn, pending.commit, pending.check);
      return pending.result;
    } finally { unlisten(); }
  }

  private prepareSend(key: string, text: string, actor: Actor & { accept: (result: Admission) => TurnQueueCommit }, attachments: SdkInputAttachment[]) {
    return prepareSdkMessageAdmission(this.options, key, text, actor, attachments);
  }

  async interrupt(key: string, expectedRunId: string, actor: Actor) {
    this.assertSession(key);
    const expected = requireExpectedRun(expectedRunId);
    this.authorize(key, actor, 'runs:interrupt');
    const execution = this.options.journal.current(key);
    if (!execution || execution.id !== expected || !(execution.phase === 'running'
      || execution.kind === 'compact' && execution.phase === 'dispatching') || execution.stopRequested) throw new RunControlConflict();
    // The driver checks the exact identity again; its dispatch persists stop
    // intent BEFORE calling native. 'unknown' must remain unknown to callers.
    const result = await this.options.driver.interrupt(key, expected, { actorId: actor.actorId, text: '', images: [] });
    if (result === 'blocked') throw new TurnAuthorizationError();
    if (result === 'not_started') throw new RunControlConflict();
    return result;
  }

  compact(key: string, actor: Actor & { accept: (result: { status: 'compacting'; runId: string }) => (db: DatabaseSync) => void }) {
    this.assertSettingsAvailable(key);
    this.authorize(key, actor, 'runs:compact');
    if (!sdkModelAllowed(this.options.models, this.options.journal.session(key)?.model)) throw new SessionDeletionConflict();
    const result = { status: 'compacting' as const, runId: randomUUID() };
    const commit = actor.accept(result);
    if (!this.options.driver.compact?.(key, result.runId, actor.actorId, db => {
      // beginCompact has already fenced settings; do not re-test canStart here.
      this.assertSession(key); this.authorize(key, actor, 'runs:compact'); return commit(db);
    }, actor.signal)) throw new SessionDeletionConflict('Compaction requires a ready, idle session with an empty queue');
    this.notify(key); return result;
  }

  editQueued(key: string, id: string, text: string, version: string, actor: Actor, commit?: TurnQueueCommit) {
    this.assertSession(key);
    this.validateText(text); this.validateVersion(version);
    this.authorize(key, actor, 'messages:send', text);
    const changed = this.options.store.turns.edit<SdkTextInput>(this.options.runtime, key, id, payload => {
      if (payload.actorId !== actor.actorId) throw new TurnAuthorizationError();
      this.authorize(key, actor, 'messages:send', text);
      return { ...payload, text };
    }, version, commit);
    if (changed) this.changed(key);
    return changed;
  }

  cancelQueued(key: string, id: string, version: string, actor: Actor, commit?: TurnQueueCommit) {
    // Canceling provably unsent work remains possible when startup failed.
    // It cannot remove dispatching/unknown inputs or bypass maintenance.
    this.assertSession(key, false); this.validateVersion(version);
    this.authorize(key, actor, 'messages:send');
    const changed = this.options.store.turns.cancel<SdkTextInput>(this.options.runtime, key, id, version, (db, admission) => {
      this.options.store.sdkAttachments.remove(key, id);
      return commit?.(db, admission);
    }, (_db, payload) => {
      if (payload.actorId !== actor.actorId) throw new TurnAuthorizationError();
      this.authorize(key, actor, 'messages:send');
    });
    if (changed) this.changed(key);
    return changed;
  }

  private assertSession(key: string, requireStartup = true) {
    this.options.assertAvailable(requireStartup);
    const { store } = this.options;
    if (!this.options.journal.session(key)) throw new Error('SDK session not found');
    if (store.commands.sessionDeletion(key) || this.options.journal.deletion(key)) throw new SessionDeletionConflict();
    if (store.commands.sessionSettingsPending(key)) throw new Error('SDK session settings are pending');
  }
  private authorize(key: string, actor: Actor, action: 'messages:send' | 'runs:interrupt' | 'runs:compact', text = '') {
    actor.signal?.throwIfAborted();
    // Delegation/sharing is explicitly not supported for this runtime yet.
    if (typeof actor.actorId !== 'string' || !actor.actorId || actor.actorId.startsWith('actor_') || actor.executionGrant
      || !this.options.journal.checkPermission(this.options.authorize,
        [key, { actorId: actor.actorId, text, images: [] }, action], this.options)) throw new TurnAuthorizationError();
  }
  private validateText(text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(`SDK text must contain 1–${MAX_MESSAGE_CHARS} characters`);
    if (isSdkCompactCommand(text)) throw new SdkUnsupportedTextCommand();
  }
  private validateVersion(version: string) {
    if (typeof version !== 'string' || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(version)) throw new Error('SDK queue version is required');
  }
  private changed(key: string) { this.notify(key); void this.options.driver.wake(key); }
  private notify(key: string) {
    try { this.options.changed(key); } catch { /* durable receipt survives projection failure */ }
  }
}
