import type { GoalControlSnapshot, SessionSettingsResult } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorCodexSettingsOutput, type CodexSettingsResult, type ConnectorCodexSettingsCommands,
  type ConnectorCodexSettingsKind } from './connector-codex-settings-domain.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { CodexAppServer } from '../codex/app-server.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';

type Scope = { authorization: string; key: string };
type Failure = { error: 403 | 404 | 409 | 503 };
/** Owns physical work, not HTTP waiters. Neither timeout nor retry can turn
 * an ambiguous effect into a fresh dispatch. SQL remains in the sole worker. */
export class AsyncCodexSettings {
  private readonly pending = new Set<Promise<void>>();
  private frozen = false;
  private closing?: Promise<void>;
  private readonly deps: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    deck: Pick<DeckStore, 'getSession' | 'renameSessionOwned'>;
    runtime: Pick<CodexAppServer, 'readGoalControl' | 'changeGoalOwned' | 'updateSessionRuntimeOwned'>;
    local(): void;
    writable(): boolean;
    diagnostics?: PerformanceDiagnostics;
  };
  constructor(deps: AsyncCodexSettings['deps']) { this.deps = { ...deps }; }
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.frozen || this.pending.size >= 16) return Promise.reject(new ConnectorOwnerUnavailable());
    const work = Promise.resolve().then(run);
    const release = () => { this.pending.delete(drain); };
    const drain = Promise.prototype.then.call(work, release, release) as Promise<void>;
    this.pending.add(drain);
    return work;
  }
  private async command<K extends ConnectorCodexSettingsKind>(kind: K, input: ConnectorCodexSettingsCommands[K]['input']) {
    const value = await this.deps.owner.command(kind, input);
    if (!validConnectorCodexSettingsOutput(kind, value)) throw new ConnectorOwnerUnavailable();
    return value;
  }
  private local(key: string, write = false) {
    if (this.frozen || write && !this.deps.writable()) throw new ConnectorOwnerUnavailable();
    this.deps.local();
    if (!this.deps.deck.getSession(key)) throw new ConnectorOwnerUnavailable();
  }
  receipt(input: Scope & { commandKey: string }): Promise<CodexSettingsResult | Failure> {
    const original = structuredClone(input);
    return this.track(() => this.command('codexSettingsReceipt', original));
  }
  goal(input: Scope, authority?: ApplicationCommandScope): Promise<{ value: GoalControlSnapshot } | Failure> {
    const original = structuredClone(input);
    return this.track(async () => {
      await authority?.authorize('prepare'); authority?.local();
      const before = await this.command('codexSettingsAuthorize', original);
      if ('error' in before) return before;
      if (!this.deps.deck.getSession(original.key)) return { error: 404 };
      const check = () => { authority?.local(); this.local(original.key); };
      check();
      const value = await this.deps.runtime.readGoalControl(original.key, check);
      await authority?.authorize('prepare'); authority?.local();
      const after = await this.command('codexSettingsAuthorize', { ...original, readerId: before.readerId });
      if ('error' in after) return after;
      if (after.readerId !== before.readerId) throw new ConnectorOwnerUnavailable();
      check(); return { value };
    });
  }
  change(input: Scope & { commandKey: string; payloadJson: string; application?: ApplicationTransactionEvidence }, authority?: ApplicationCommandScope): Promise<CodexSettingsResult | Failure> {
    const original = structuredClone(input);
    return this.track(async () => {
      const trace = guardedTrace(this.deps.diagnostics ?? performanceDiagnostics, 'codex-dispatch');
      let failed = true;
      try {
        trace.add('step', 56);
        await authority?.authorize('prepare'); authority?.local();
        const claimed = await this.command('codexSettingsClaim', { ...original,
          ...(!this.deps.writable() || this.frozen ? { rejectFresh: 'runtime_unavailable' as const } : {}) });
        if ('error' in claimed || !claimed.intent) return claimed;
        if (!this.deps.deck.getSession(original.key)) {
          await this.command('codexSettingsAbandon', { intent: claimed.intent, reason: 'session_missing' });
          return this.command('codexSettingsReceipt', { authorization: original.authorization, key: original.key, commandKey: original.commandKey });
        }
        const intent = claimed.intent, change = intent.change;
        const local = () => { authority?.local(); this.local(original.key, true); };
        const begin = async () => {
          await authority?.authorize('effect');
          local();
          if (!await this.command('codexSettingsBegin', { intent, authorization: original.authorization })) throw new ConnectorOwnerUnavailable();
          // If connection/version/readiness changed while SQL committed, the
          // original receipt is unknown, not evidence that dispatch was absent.
          local(); trace.add('step', 57);
        };
        const acknowledge = async (settings: SessionSettingsResult['settings']) => {
          // An original effect ACK is a fact, not a new user authorization.
          const accepted = await this.command('codexSettingsAccept', { intent, settings });
          if (accepted === false || accepted.receipt?.state !== 'accepted') throw new ConnectorOwnerUnavailable();
          trace.add('settled', 1);
          // Preserve the ACK first; current authority gates only publication.
          await authority?.authorize('prepare'); local();
        };
        try {
          local();
          if (change.kind === 'goal') {
            await this.deps.runtime.changeGoalOwned(original.key, change.control, local, begin,
              () => acknowledge({ goalControl: change.control.action }));
          } else {
            await begin();
            // No async gap between final local veto and the original file effect.
            local();
            if (change.kind === 'title') await this.deps.deck.renameSessionOwned(original.key, change.title,
              session => acknowledge({ title: session.title! }));
            else await this.deps.runtime.updateSessionRuntimeOwned(original.key, { model: change.model,
              ...(change.thinking === undefined ? {} : { thinking: change.thinking }) }, session => acknowledge({
              model: session.model || null, modelProvider: session.modelProvider ?? null,
              ...(change.thinking === undefined ? {} : { thinkingLevel: change.thinking === null ? null : session.thinkingLevel ?? change.thinking }),
            }), local);
          }
        } catch {
          // A prewrite failure is rejected; after begin this is observation
          // only. Worker keeps the binding for an original late native ACK.
          await this.command('codexSettingsAbandon', { intent }).catch(() => false);
        }
        const current = await this.command('codexSettingsReceipt', { authorization: original.authorization, key: original.key, commandKey: original.commandKey });
        failed = 'error' in current || current.receipt?.state !== 'accepted';
        return current;
      } finally { trace.finish(failed); }
    });
  }
  freeze() { this.frozen = true; }
  drain(): Promise<void> { return Promise.all([...this.pending]).then(() => {}); }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= this.drain();
  }
}
