import { randomUUID } from 'node:crypto';
import { requiredSynchronousEffectAuthority as synchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import type { ChatMessage } from '@agentopsdeck/shared';
import { hermesSessionView } from './session-view.js';
import { hermesNativeIdentity, hermesNativeAttachment, hermesNativeHistory } from './native-session.js';
import { editHermesQueued, cancelHermesQueued } from './queue-mutations.js';
import { RunControlConflict } from '../commands/run-control.js';
import { SessionDeletionConflict, TurnAuthorizationError, type TurnQueue, type TurnQueueCommit } from '../commands/turn-queue.js';
import type { AuthorizeTurn, ExecutionGrantAuthority } from '../connector/execution-grants.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { HermesConfig } from './config.js';
import { HermesJournal, type HermesExecution, type HermesSession, type HermesToolObservation } from './journal.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { HermesProcess } from './process.js';
import { terminalStatus, type HermesEvent } from './protocol.js';
import { inspectHermesDeletion, deleteHermesNative } from './session-deletion.js';
import { hermesUnconfirmedTools, type HermesHistoryRow } from './history.js';
import { attachHermesSession, refreshHermesHistory, type HermesHistoryPort } from './session-history.js';
import { prepareHermesMessageAdmission } from './message-admission.js';
import { claimHermesDispatch, hermesDispatchNativeReady, planHermesDispatch, type HermesDispatchContext } from './dispatch-admission.js';
import { dispatchHermes } from './dispatch.js';
import { settleHermesTerminal } from './terminal-settlement.js';

type Payload = { text: string; images: []; actorId: string; executionGrant?: ExecutionGrantAuthority };
type Row = HermesHistoryRow;
export type HermesTransport = Pick<HermesProcess, 'ready' | 'epoch' | 'start' | 'request' | 'close'>;
export type HermesToolPort = { tool(execution: HermesExecution, observation: HermesToolObservation): ChatMessage | null | Promise<ChatMessage | null> };

/** Opt-in, exclusive text runtime. Native pending prompts are never our queue.
 * Only this Connector's sessions are attached; foreign desktop/CLI sessions are
 * deliberately not enumerated or imported into the execution namespace. */
export class HermesRuntime {
  private readonly native: HermesTransport;
  private readonly live = new Map<string, string>();
  private readonly attaching = new Map<string, Promise<string>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly refreshed = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly active = new Map<string, HermesExecution>();
  private readonly earlyTerminal = new Map<string, HermesEvent>();
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly sequences = new Map<string, number>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly toolWrites = new Map<string, Promise<void>>();
  private toolPending = 0;
  private readonly scheduled = new Set<string>();
  private readonly deleting = new Set<string>();
  private closed = false;
  private paused = false;
  private unsubscribe: (() => void) | undefined;
  private starting: Promise<void> | undefined;
  private startFailed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: { config: HermesConfig; journal: HermesJournal;
    turns: TurnQueue; store: DeckStore; authorize: AuthorizeTurn; admissionAvailable?: () => boolean; tools?: HermesToolPort },
    factory = (event: (e: HermesEvent) => void, lost: () => void): HermesTransport => new HermesProcess(options.config, event, lost)) {
    this.native = factory(event => this.event(event), () => this.disconnected());
    options.journal.recover(options.turns);
    for (const key of options.journal.deletedKeys()) options.store.removeSession(key);
    for (const session of options.journal.sessions()) {
      for (const execution of options.journal.executions(session.key)) this.settleTools(execution);
      options.store.replaceMessages(session.key, options.journal.session(session.key)!.messages);
      this.project(session.key);
    }
  }
  get enabled() { return true; }
  get ready() { return !this.closed && this.native.ready; }
  get status() { return this.ready ? 'ready' : this.startFailed ? 'startup_failed' : this.closed ? 'closed' : this.starting ? 'unavailable' : 'starting'; }
  owns(key: string) { return key.startsWith('hermes:'); }
  private deletionBlocked(key: string) { return this.deleting.has(key) || !!this.options.journal.deletion(key); }
  async remove(key: string, authorize: () => void, acknowledge: () => void) {
    const { journal, turns, store } = this.options;
    synchronousEffectAuthority(authorize);
    if (this.deletionBlocked(key)) throw new SessionDeletionConflict('Hermes deletion is already pending or accepted; check the original receipt');
    if (!journal.session(key)) throw new SessionDeletionConflict('Hermes session not found');
    if (!journal.canStart(key) || turns.hasPending('hermes', key)) {
      throw new SessionDeletionConflict('Wait for the Hermes run to finish and cancel queued messages before deleting');
    }
    if (!this.ready) throw new SessionDeletionConflict('Hermes is not ready; reconnect before deleting');
    this.deleting.add(key); this.revise(key);
    try {
      // Drain reads/attachments already in flight; new reads and dispatches are
      // fenced above. Never resume an absent native session just to delete it.
      await Promise.all([this.attaching.get(key), this.refreshing.get(key), this.finishing.get(journal.current(key)?.id ?? '')]);
      synchronousEffectAuthority(authorize);
      const session = journal.session(key)!;
      const live = this.live.get(key), epoch = this.native.epoch;
      await inspectHermesDeletion(session.stored, live, this.native);
      synchronousEffectAuthority(authorize);
      if (!this.ready || this.native.epoch !== epoch) throw new SessionDeletionConflict('Hermes connection changed before deletion');
      if (live && this.live.get(key) !== live) throw new SessionDeletionConflict('Hermes session ownership changed before deletion');
      // Persistent intent prevents reads, sends and restart from reattaching a
      // session after a lost close/delete ACK. No automatic mutation replay.
      journal.beginDeletion(key);
      try {
        await deleteHermesNative(session.stored, live, this.native, () => {
          synchronousEffectAuthority(authorize);
          if (!this.ready || this.native.epoch !== epoch) throw Error('Hermes connection changed during deletion');
        }, () => { this.live.delete(key); if (live) this.sequences.delete(live); });
        journal.finishDeletion(key);
        acknowledge();
        store.removeSession(key);
        this.active.delete(key); this.refreshed.delete(key); this.revisions.delete(key);
      } catch {
        // Even a revoke after close is not a rejection of the whole operation.
        // 5xx preserves the existing durable unknown receipt and its fence.
        throw new Error('Hermes deletion could not be fully confirmed; check the original deletion receipt. Do not resend.');
      }
    } finally { this.deleting.delete(key); }
  }
  isSessionHistoryReady(key: string) { return !this.closed && !this.deletionBlocked(key) && this.refreshed.has(key) && !this.refreshing.has(key); }
  start() {
    return this.starting ??= this.track((async () => {
      try { await this.native.start(); } catch (error) { this.startFailed = true; throw error; }
      if (this.closed) return;
      for (const session of this.options.journal.sessions()) this.project(session.key);
      this.unsubscribe = this.options.turns.onAdmission(runtime => { if (runtime === 'hermes') this.wake(); });
      this.wake();
    })());
  }
  async createSession(title: string, acknowledge: (key: string) => void, authorize: () => void) {
    if (!this.ready) throw new Error('Hermes is not ready');
    if (title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Invalid Hermes title');
    synchronousEffectAuthority(authorize);
    const result = await this.native.request('session.create', { title, cwd: this.options.config.workspace, source: 'agentopsdeck' });
    const identity = hermesNativeIdentity(result);
    const key = `hermes:${randomUUID()}`;
    // Preserve the native result even if the HTTP caller disappears. No retry.
    const session: HermesSession = { key, stored: identity.stored, title, started: false, messages: [] };
    this.options.journal.save(session); this.live.set(key, identity.live); this.project(key);
    synchronousEffectAuthority(authorize); acknowledge(key);
    return { key };
  }
  async send(key: string, text: string, options: { actorId: string; executionGrant?: ExecutionGrantAuthority; signal?: AbortSignal;
    accept: (result: Record<string, unknown>) => TurnQueueCommit }) {
    const actor = { actorId: options.actorId, signal: options.signal,
      ...(options.executionGrant ? { executionGrant: { ...options.executionGrant } } : {}) };
    const pending = prepareHermesMessageAdmission({ journal: this.options.journal, turns: this.options.turns,
      authorize: () => this.authorized(key, { text, images: [], ...actor }), assertAvailable: () => {
      if (!this.ready) throw new Error('Hermes is not ready');
      if (this.options.admissionAvailable && !this.options.journal.checkPermission(this.options.admissionAvailable, [], this.options))
        throw new SessionDeletionConflict('Hermes command admission is paused or closed');
      if (this.deletionBlocked(key)) throw new SessionDeletionConflict();
    } }, key, text, { ...actor, accept: options.accept });
    const id = pending.turn.id;
    let notified = false;
    const unlisten = this.options.turns.onAdmission(runtime => {
      if (runtime !== 'hermes' || notified || !this.options.turns.hasCommand(runtime, id)) return;
      notified = true;
      try { this.projectQueue(key); } catch { /* A projection failure cannot undo durable admission. */ }
      this.wake();
    });
    try {
      await this.options.turns.enqueueAsync<Payload>('hermes', pending.turn, pending.commit, pending.check);
      return pending.result;
    } finally { unlisten(); }
  }
  wake() {
    if (!this.ready || this.paused) return;
    for (const key of this.options.turns.sessions('hermes')) {
      if (this.deletionBlocked(key) || this.scheduled.has(key) || !this.options.journal.canStart(key)) continue;
      const previousExecution = this.options.journal.current(key)?.id;
      this.scheduled.add(key);
      this.track(Promise.resolve().then(() => this.dispatch(key)).catch(() => {
        const execution = this.active.get(key);
        if (execution) this.freeze(execution);
        else {
          // Nothing was submitted. Keep the durable input visible/cancellable,
          // but do not spin or silently retry an unhealthy session attachment.
          const head = this.options.turns.head('hermes', key);
          if (head?.state === 'queued') this.options.turns.block('hermes', head.id);
          this.projectQueue(key);
        }
      }).finally(() => {
        this.scheduled.delete(key);
        if (this.options.journal.current(key)?.id !== previousExecution && this.options.journal.canStart(key)
          && this.options.turns.head('hermes', key)?.state === 'queued') this.wake();
      }));
    }
  }
  private authorized(key: string, payload: Payload) {
    return this.options.journal.checkPermission(this.options.authorize,
      [payload.actorId, { runtime: 'hermes', sessionKey: key }, 'messages:send', payload.executionGrant], this.options);
  }
  private async dispatch(key: string) {
    const context: HermesDispatchContext = { journal: this.options.journal, turns: this.options.turns,
      authorize: (target, payload) => this.authorized(target, payload), available: () => this.ready && !this.paused && !this.deletionBlocked(key)
        && (!this.options.admissionAvailable || this.options.journal.checkPermission(this.options.admissionAvailable, [], this.options)) };
    await dispatchHermes(key, {
      plan: async target => {
        const plan = planHermesDispatch(context, target, undefined, true);
        if (plan === 'blocked') this.projectQueue(target);
        return plan;
      },
      claim: async (plan, live, epoch, id) => {
        const execution = claimHermesDispatch(context, { key: plan.key, digest: plan.digest, live, epoch, id,
          ...(plan.batch ? { separator: plan.batch.separator } : {}) });
        if (!execution) this.projectQueue(plan.key);
        return execution;
      },
      nativeReady: async execution => hermesDispatchNativeReady(context, execution),
      admitted: async execution => this.options.journal.admitted(execution, this.options.turns),
      unknown: async execution => this.freeze(execution),
    }, { available: () => this.ready && !this.paused && !this.deletionBlocked(key), epoch: () => this.native.epoch,
      attach: target => this.attach(target), history: live => this.history(live),
      submit: (live, text) => this.native.request('prompt.submit', { session_id: live, text, queued: true }) }, {
      claimed: execution => { this.revise(key); this.active.set(key, execution); this.project(key); this.projectQueue(key); },
      admitted: async (execution, after) => {
        this.projectHistory(key, after); this.projectQueue(key); this.project(key);
        const early = this.earlyTerminal.get(key); this.earlyTerminal.delete(key);
        if (early) await this.finish(execution, early);
      },
    });
  }
  async refreshSession(key: string, options: { maxAgeMs?: number } = {}) {
    if (this.deletionBlocked(key)) return;
    if (!this.options.journal.session(key)) throw new Error('Hermes session not found');
    if (this.refreshing.has(key)) return this.refreshing.get(key);
    if (options.maxAgeMs && Date.now() - (this.refreshed.get(key) ?? 0) < options.maxAgeMs) return;
    // Cached history remains available for unknown executions; reading does not
    // resume or resolve them. There is no automatic recovery/re-execution.
    if (this.options.journal.current(key)?.phase === 'unknown') { this.refreshed.set(key, Date.now()); return; }
    this.refreshed.delete(key);
    const task = this.track(Promise.resolve().then(async () => {
      await this.toolBarrier(key);
      const revision = this.revisions.get(key);
      const epoch = this.native.epoch;
      const result = await refreshHermesHistory(key, this.historyPort(), {
        attach: () => this.attach(key), history: live => this.history(live),
        current: () => revision === this.revisions.get(key) && !this.closed && this.ready
          && this.native.epoch === epoch && !this.deleting.has(key),
      }, messages => this.publishHistory(key, messages));
      if (result === 'cached' && !this.closed) this.refreshed.set(key, Date.now());
    }).finally(() => { this.refreshing.delete(key); }));
    this.refreshing.set(key, task); return task;
  }
  async interrupt(key: string, expected: string, actorId: string, grant?: ExecutionGrantAuthority) {
    const execution = this.active.get(key);
    if (!execution || execution.id !== expected || execution.phase !== 'running') throw new RunControlConflict();
    if (!this.options.authorize(actorId, { runtime: 'hermes', sessionKey: key }, 'runs:interrupt', grant)) throw new TurnAuthorizationError();
    await this.native.request('session.interrupt', { session_id: execution.live });
  }
  private attach(key: string): Promise<string> {
    const live = this.live.get(key); if (live) return Promise.resolve(live);
    const pending = this.attaching.get(key); if (pending) return pending;
    const epoch = this.native.epoch;
    const task = attachHermesSession(key, this.historyPort(), async session => {
      const resume = session.started || session.nativeAllocated === true;
      const result = await this.native.request(resume ? 'session.resume' : 'session.create', resume
        ? { session_id: session.stored, source: 'agentopsdeck' }
        : { title: session.title, cwd: this.options.config.workspace, source: 'agentopsdeck' });
      return hermesNativeAttachment(session, result);
    }, () => this.ready && this.native.epoch === epoch && !this.deleting.has(key))
      .then(live => {
        if (!this.ready || this.native.epoch !== epoch || this.deletionBlocked(key)
          || this.options.journal.current(key)?.phase === 'unknown') throw new Error('Hermes attachment is no longer current');
        this.live.set(key, live); return live;
      }).finally(() => this.attaching.delete(key));
    this.attaching.set(key, task); return task;
  }
  private async history(live: string): Promise<Row[]> {
    return hermesNativeHistory(await this.native.request('session.history', { session_id: live }));
  }
  private projectHistory(key: string, rows: Row[]) {
    const journal = this.options.journal, snapshot = journal.historySnapshot(key);
    const committed = snapshot && journal.commitHistory(key, snapshot.digest, rows);
    if (!committed) throw new Error('Hermes history snapshot changed');
    this.publishHistory(key, journal.historyMessages(key, committed.digest)!);
  }
  private historyPort(): HermesHistoryPort {
    const journal = this.options.journal;
    return { snapshot: key => journal.historySnapshot(key),
      attached: (snapshot, stored) => journal.attachSnapshot(snapshot.key, snapshot.digest, stored),
      commit: (snapshot, rows) => journal.commitHistory(snapshot.key, snapshot.digest, rows),
      projection: snapshot => journal.historyMessages(snapshot.key, snapshot.digest) };
  }
  private publishHistory(key: string, history: ChatMessage[]) {
    const execution = this.active.get(key);
    const streaming = execution && !this.finishing.has(execution.id)
      ? this.options.store.getMessages(key).filter(m => m.id === `hermes-stream:${execution.id}`) : [];
    // Keep bounded event records across refresh/restart; native history has no
    // stable call identities and cannot replace these call/result pairs.
    this.options.store.replaceMessages(key, [...history, ...streaming], { authoritative: true });
    this.projectQueue(key); this.refreshed.set(key, Date.now());
  }
  projectQueue(key: string) {
    for (const item of this.options.turns.list<Payload>('hermes', key)) this.options.store.addMessage({
      id: item.id, sessionKey: key, role: 'user', text: item.payload.text, createdAt: item.createdAt,
      status: item.state === 'outcome_unknown' ? 'outcome_unknown' : item.state === 'blocked' ? 'failed' : 'queued',
      queueDisposition: this.options.journal.canStart(key) ? 'preparing' : 'waiting',
      queueVersion: this.options.turns.version('hermes', key, item.id),
    });
  }
  private event(event: HermesEvent) {
    if (!this.closed && event.type === 'session.reclaimed' && typeof event.payload?.session_id === 'string') {
      for (const [key, live] of this.live) if (live === event.payload.session_id) {
        const execution = this.active.get(key); if (execution) this.freeze(execution);
        this.live.delete(key); this.sequences.delete(live); this.refreshed.delete(key);
      }
      return;
    }
    if (this.closed || !event.sessionId) return;
    const key = [...this.live].find(([, live]) => live === event.sessionId)?.[0]; if (!key) return;
    const execution = this.active.get(key);
    const previous = this.sequences.get(event.sessionId);
    if (event.seq === undefined || previous !== undefined && event.seq !== previous + 1) { if (execution) this.freeze(execution); return; }
    this.sequences.set(event.sessionId, event.seq);
    if (!execution || execution.phase === 'unknown') return;
    if ((event.type === 'tool.start' || event.type === 'tool.complete')
      && typeof event.payload?.tool_id === 'string') {
      this.observeTool(execution, event);
    }
    if (event.type === 'message.delta' && typeof event.payload?.text === 'string') {
      const id = `hermes-stream:${execution.id}`;
      const old = this.options.store.getMessage(key, id);
      this.options.store.addMessage({ id, sessionKey: key, role: 'assistant', text: (old?.text ?? '') + event.payload.text,
        createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now() });
    }
    if (terminalStatus(event)) {
      if (execution.phase === 'starting') this.earlyTerminal.set(key, event);
      else this.track(this.finish(execution, event).catch(() => this.freeze(execution)));
    }
  }
  private observeTool(execution: HermesExecution, event: HermesEvent) {
    if (this.finishing.has(execution.id) || this.toolPending >= 64) { this.freeze(execution); return; }
    const p = event.payload!, observation: HermesToolObservation = { toolId: p.tool_id as string,
      phase: event.type === 'tool.start' ? 'call' : 'result', at: Date.now(),
      ...(typeof p.name === 'string' ? { name: p.name.slice(0, 256) } : {}) };
    if (!observation.toolId || Buffer.byteLength(observation.toolId) > 512 || /[\x00-\x1f\x7f]/.test(observation.toolId)) {
      this.freeze(execution); return;
    }
    const trace = guardedTrace(performanceDiagnostics, 'hermes-tool-commit');
    const expected = structuredClone(execution);
    const current = () => !this.closed && this.ready === true && this.native.epoch === expected.epoch
      && this.active.get(expected.key) === execution && ['starting', 'running'].includes(execution.phase)
      && !this.deletionBlocked(expected.key);
    const publish = (message: ChatMessage | null) => {
      if (!message) throw Error('Hermes tool fact not committed');
      if (!current()) return;
      if (this.options.store.hasMessage(expected.key, message.id)) return;
      this.options.store.addMessage(message);
      // Projection observers can synchronously close/disconnect this execution.
      if (!current()) return;
      const duration = typeof p.duration_s === 'number' ? p.duration_s * 1000 : 0;
      this.options.store.replaceActivities(expected.key, [{ id: message.toolCallId!, sessionKey: expected.key,
        runId: expected.id, toolCallId: observation.toolId, toolName: message.toolName!,
        status: observation.phase === 'call' ? 'running' : 'done', hiddenArgumentCount: 0,
        updatedAt: message.createdAt, durationMs: Number.isFinite(duration) ? Math.max(0, duration) : 0 }]);
      trace.add('settled', 1);
    };
    const submit = () => {
      if (!current()) return null;
      trace.add('step', 1);
      return this.options.tools ? this.options.tools.tool(expected, observation) : this.options.journal.observeTool(expected, observation);
    };
    const previous = this.toolWrites.get(execution.key);
    try {
      // The original local transaction stays synchronous, including immediate
      // disconnect/close. Awaitable owners serialize call/result in event order.
      // Register physical drain before an injected port can reenter pause/close.
      // Keep the original local transaction synchronous for immediate shutdown.
      const result = previous ? previous.then(submit)
        : this.options.tools ? Promise.resolve().then(submit) : submit();
      if (!result || typeof (result as Promise<unknown>).then !== 'function') {
        publish(result as ChatMessage | null); trace.finish(false); return;
      }
      this.toolPending++;
      const task = Promise.resolve(result).then(publish).catch(() => { trace.add('step', 2); this.freeze(execution); })
        .finally(() => { this.toolPending--; if (this.toolWrites.get(execution.key) === task) this.toolWrites.delete(execution.key); trace.finish(execution.phase === 'unknown'); });
      this.toolWrites.set(execution.key, task); this.track(task);
    } catch { trace.finish(true); this.freeze(execution); }
  }
  private async toolBarrier(key: string) {
    while (this.toolWrites.has(key)) await this.toolWrites.get(key);
  }
  private finish(execution: HermesExecution, event: HermesEvent): Promise<void> {
    const pending = this.finishing.get(execution.id); if (pending) return pending;
    const task = Promise.resolve().then(() => this.finishOnce(execution, event)).finally(() => this.finishing.delete(execution.id));
    this.finishing.set(execution.id, task); return task;
  }
  private async finishOnce(execution: HermesExecution, event: HermesEvent) {
    await this.toolBarrier(execution.key);
    if (execution.phase !== 'running' || !terminalStatus(event)) return;
    this.revise(execution.key);
    const result = await settleHermesTerminal(execution, terminalStatus(event)!, {
      terminal: (expected, phase, stored, rows) => this.options.journal.settleTerminal(expected, phase, stored, rows),
      read: key => this.options.journal.current(key) ?? null,
    }, this.historyPort(), {
      current: () => this.ready === true && this.native.epoch === execution.epoch
        && this.active.get(execution.key) === execution && !this.deletionBlocked(execution.key),
      snapshot: live => this.native.request('session.activate', { session_id: live, omit_messages: true }),
      history: live => this.history(live),
    });
    // No await between the final local fence and the original projection.
    if (this.ready !== true || this.native.epoch !== execution.epoch || execution.phase !== 'running'
      || this.active.get(execution.key) !== execution || this.deletionBlocked(execution.key)) return;
    const settled = result.execution;
    execution.phase = settled.phase; execution.updated = settled.updated;
    this.active.delete(execution.key);
    this.options.store.replaceMessages(execution.key, result.messages, { authoritative: true });
    this.projectQueue(execution.key); this.refreshed.set(execution.key, Date.now()); this.project(execution.key);
    this.wake();
  }
  private revise(key: string) { this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1); }
  private settleTools(execution: HermesExecution) {
    const session = this.options.journal.session(execution.key)!;
    const results = hermesUnconfirmedTools(session, execution);
    if (!results.length) return;
    this.options.journal.save({ ...session, messages: [...session.messages, ...results] });
    for (const result of results) this.options.store.addMessage(result);
  }
  private freeze(execution: HermesExecution) {
    if (['completed', 'failed', 'interrupted', 'unknown'].includes(execution.phase)) return;
    const trace = guardedTrace(performanceDiagnostics, 'hermes-execution-protection');
    const expected = structuredClone(execution);
    // The local fence must survive a rejected/failed durable write. It is not
    // evidence that the transaction committed and never permits replay.
    execution.phase = 'unknown';
    this.revise(execution.key);
    this.earlyTerminal.delete(execution.key);
    let failed = false;
    trace.add('unknown', 1);
    trace.add('step', 1);
    try {
      const frozen = this.options.journal.unknown(expected, this.options.turns);
      if (!frozen) failed = true;
      else {
        trace.add('settled', 1);
        // Only project facts from the original atomic unknown transaction.
        for (const message of this.options.journal.session(execution.key)?.messages ?? [])
          if (message.turnId === execution.id && message.toolPhase === 'result' && message.status === 'outcome_unknown')
            this.options.store.addMessage(message);
      }
    } catch { failed = true; }
    trace.add('step', 2);
    try { this.project(execution.key); } catch { failed = true; }
    try { this.projectQueue(execution.key); } catch { failed = true; }
    trace.finish(failed);
  }
  private disconnected() {
    if (this.closed) return;
    for (const execution of this.active.values()) this.freeze(execution);
    const trace = guardedTrace(performanceDiagnostics, 'hermes-execution-protection');
    let failed = false;
    try {
      for (const session of this.options.journal.sessions()) {
        try { this.project(session.key); } catch { failed = true; }
      }
    } catch { failed = true; }
    trace.finish(failed);
  }
  private project(key: string) {
    const local = this.active.get(key);
    let session: Pick<HermesSession, 'title'> | undefined, execution: HermesExecution | undefined, blocked: boolean;
    try {
      session = this.options.journal.session(key);
      execution = this.options.journal.current(key);
      blocked = !!this.options.journal.deletion(key);
    } catch (error) {
      if (local?.phase !== 'unknown') throw error;
      session = this.options.store.getSession(key); execution = local; blocked = true;
    }
    if (!session) return;
    this.options.store.upsertSession(hermesSessionView(key, session.title, execution, this.ready,
      blocked || local?.id === execution?.id && local?.phase === 'unknown'));
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {}); return task;
  }
  pauseQueueWorker() {
    this.paused = true;
    return { drained: Promise.allSettled([...this.tasks]).then(() => undefined),
      resume: () => { if (this.closed) return false; this.paused = false; this.wake(); return true; } };
  }
  editQueued(key: string, id: string, text: string, version: string, commit?: TurnQueueCommit) {
    const changed = editHermesQueued(this.options.turns, key, id, text, version, commit);
    if (changed) this.projectQueue(key); return changed;
  }
  cancelQueued(key: string, id: string, version: string, commit?: TurnQueueCommit) {
    const changed = cancelHermesQueued(this.options.turns, key, id, version, commit);
    if (changed) this.options.store.removeMessage(key, id); this.wake(); return changed;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Register the close flight before any native/user callback can reenter.
    this.closing = Promise.resolve().then(async () => {
      const trace = guardedTrace(performanceDiagnostics, 'hermes-runtime-close');
      let failed = false, failure: unknown;
      const remember = (error: unknown) => { if (!failed) failure = error; failed = true; };
      try { this.unsubscribe?.(); } catch (error) { remember(error); }
      for (const execution of this.active.values()) this.freeze(execution);
      trace.add('step', 1);
      try { await this.native.close(); } catch (error) { remember(error); }
      trace.add('step', 2);
      // A native close failure is not permission to retire an in-flight ACK.
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      trace.add('settled', 1); trace.finish(failed);
      if (failed) throw failure;
    });
    return this.closing;
  }
}
