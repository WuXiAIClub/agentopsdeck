import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawDispatch } from './async-openclaw-dispatch.js';
import { TurnWorker } from '../commands/turn-worker.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { OpenClawExecution } from '../openclaw/executions.js';
import { gatewayEventRunState, gatewayRunId } from '../openclaw/gateway-observation.js';
import { parseGatewayReply } from '../openclaw/gateway-reply.js';
import { isNormalOpenClawCompletion, type OpenClawRecoverySource } from '../openclaw/recovery.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { CONNECTOR_NATIVE_REPLY_COMMAND_BYTES } from './connector-native-reply-domain.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

type DispatchOptions = ConstructorParameters<typeof AsyncOpenClawDispatch>[0];
type Stage = 'event' | 'mirror' | 'query' | 'history' | 'refresh' | 'projection';
type Options = {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  dispatch: Omit<DispatchOptions, 'owner' | 'canDispatch'>;
  recovery: OpenClawRecoverySource;
  refreshSessions(): Promise<void>;
  refreshMessages(key: string, options?: { fresh: true }): Promise<void>;
  // Original native session evidence, not the display getter or permission.
  nativeSession(key: string): { status: string; hasActiveRun?: boolean } | undefined;
  project(key: string, committed: OpenClawExecution | null): void | Promise<void>;
  invalidate(): void;
  reconcileMirror?(key: string): Promise<void>;
  onAdmission?(listener: (runtime: string) => void): () => void;
  diagnostic?(stage: Stage): void;
  retryMs?: number;
};

/** Original queue/journal and TurnWorker, with all SQL owned by the SAME worker.
 * No startup recovery here: B7 must restore the sole owner before start().
 * Native events are fixed bounded evidence, never payload-supplied authority.
 * Root closes this consumer BEFORE its shared DB, projection and transports. */
export class AsyncOpenClawTurnQueue {
  private readonly dispatch: AsyncOpenClawDispatch;
  private readonly worker: TurnWorker;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly reconciliation = new Map<string, Promise<void>>();
  private readonly events = new Map<string, Promise<boolean>>();
  private eventBytes = 0;
  private eventCount = 0;
  private closed = false;
  private healthy = true;
  private pauseLease: AdmissionPause | undefined;
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {
    this.dispatch = new AsyncOpenClawDispatch({ ...options.dispatch, owner: options.owner,
      canDispatch: key => this.canDispatch(key),
      settled: async (claim, result) => {
        await this.publish(claim.turn.sessionKey);
        await options.dispatch.settled?.(claim, result);
        this.wake();
      },
    });
    this.worker = new TurnWorker({ runtime: 'openclaw',
      ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}),
      ...(options.dispatch.diagnostics ? { diagnostics: options.dispatch.diagnostics } : {}),
      queue: {
        sessionPage: (runtime, after, limit) => options.owner.command('turnSessionPage', { runtime, after, limit }),
        onAdmission: listener => options.onAdmission?.(listener) ?? (() => {}),
      },
      additionalSessionPage: (after, limit) => options.owner.command('turnRecoveryPage', {
        runtime: 'openclaw', after, limit, connectionId: options.recovery.connectionId() ?? null,
        mirror: !!options.reconcileMirror,
      }),
      reconcile: key => this.reconcile(key),
    });
  }
  start() { if (!this.closed) this.worker.start(); }
  wake() { if (!this.closed) this.worker.wake(); }
  private note(stage: Stage) {
    const trace = guardedTrace(this.options.dispatch.diagnostics ?? performanceDiagnostics, 'openclaw-reconcile');
    trace.add('step', ['event', 'mirror', 'query', 'history', 'refresh', 'projection'].indexOf(stage) + 1);
    trace.finish(true);
    try { this.options.diagnostic?.(stage); } catch { /* observation only */ }
  }
  private lostObservation() {
    // A lost write is not proof of quiescence. Only root recovery/recreation
    // may reestablish this consumer; never unlock by timer or display refresh.
    this.healthy = false;
    try { this.options.invalidate(); } catch { /* local veto remains */ }
    this.note('event');
  }
  private retain<T>(work: Promise<T>): Promise<T> {
    this.tasks.add(work);
    void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work));
    return work;
  }
  private async drain() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
  pause(): AdmissionPause {
    if (this.pauseLease) return this.pauseLease;
    const consumer = this.worker.pause(), dispatch = this.dispatch.pause();
    let settled = false;
    const lease: AdmissionPause = {
      drained: Promise.all([consumer.drained, dispatch.drained, this.drain()]).then(() => { settled = true; }),
      resume: () => {
        if (this.closed || this.pauseLease !== lease || !settled || this.tasks.size) return false;
        if (!dispatch.resume() || !consumer.resume()) return false;
        this.pauseLease = undefined; this.wake(); return true;
      },
    };
    return this.pauseLease = lease;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= Promise.all([this.worker.close(), this.dispatch.close(), this.drain()]).then(() => {});
  }
  private canDispatch(key: string) {
    const session = this.options.nativeSession(key);
    return this.healthy && !this.closed && !this.pauseLease && !!session && !session.hasActiveRun
      && ['idle', 'failed'].includes(session.status);
  }
  private async read(key: string): Promise<OpenClawExecution | null> {
    const fact = await this.options.owner.command('openClawExecutionRead', { sessionKey: key });
    if (!validConnectorExecutionOutput('openClawExecutionRead', fact) || fact && fact.sessionKey !== key)
      throw new ConnectorOwnerUnavailable();
    return fact;
  }
  private async publish(key: string) {
    const fact = await this.read(key);
    try { await this.options.project(key, fact); }
    catch {
      this.healthy = false;
      try { this.options.invalidate(); } catch { /* original ACK remains committed */ }
      this.note('projection');
    }
  }

  /** Called by trusted transport binding, not an HTTP/payload connectionId.
   * Normalize synchronously into immutable primitives: no raw object retained
   * over await, at most 128 pending envelopes / 8 MiB of original text. */
  observe(raw: any, connectionId: string | undefined): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    let key: string, runId: string | undefined, phase: string | undefined;
    let reply: ReturnType<typeof parseGatewayReply>;
    try {
      raw = JSON.parse(encodeConnectorOwnerJson(raw, CONNECTOR_NATIVE_REPLY_COMMAND_BYTES));
      const name = String(raw?.event ?? raw?.type ?? raw?.name ?? '').toLowerCase();
      const payload = raw?.payload ?? raw?.data ?? raw;
      const candidate = payload?.sessionKey ?? payload?.session?.key ?? payload?.session?.sessionKey ?? raw?.sessionKey;
      if (typeof candidate !== 'string' || !candidate.trim() || Buffer.byteLength(candidate) > 4096
        || /^(?:codex|hermes|claude-code|ghcp|antigravity):/.test(candidate)) return Promise.resolve(false);
      key = candidate;
      const runState = gatewayEventRunState(name, payload);
      const chatState = name === 'chat' || name.startsWith('chat.') ? payload?.state : undefined;
      reply = parseGatewayReply(raw);
      phase = runState === 'idle' ? 'completed' : runState
        ?? (chatState === 'error' || chatState === 'aborted' ? 'failed' : reply ? 'completed' : undefined);
      runId = gatewayRunId(payload);
      if (!phase) return Promise.resolve(false);
      // Preserve the journal contract: reply plus conflicting active/failure
      // state is not completed reply evidence. Do not manufacture its phase.
      if (reply && phase !== 'completed') return Promise.resolve(false);
      if (!connectionId || Buffer.byteLength(connectionId) > 512) { this.lostObservation(); return Promise.reject(new ConnectorOwnerUnavailable()); }
    } catch { this.lostObservation(); return Promise.reject(new ConnectorOwnerUnavailable()); }
    const bytes = Buffer.byteLength(key) + (reply ? Buffer.byteLength(reply.text) : 0) + 1024;
    if (this.eventCount >= 128 || this.eventBytes + bytes > 8 * 1024 * 1024) {
      this.lostObservation(); return Promise.reject(new ConnectorOwnerUnavailable());
    }
    this.eventCount++; this.eventBytes += bytes;
    const previous = this.events.get(key);
    const work = Promise.resolve(previous).catch(() => {}).then(async () => {
      let changed = false;
      if (runId) {
        if (reply) changed = await this.options.owner.command('openClawGatewayFinalReply', { sessionKey: key,
          event: { runId, gatewayConnectionId: connectionId!, phase: 'completed', reply, replyOnly: true } });
        else changed = await this.options.owner.command('openClawExecutionObserve', { sessionKey: key,
          event: { runId, gatewayConnectionId: connectionId!, phase: phase as 'running' | 'waiting' | 'unknown' | 'completed' | 'failed' } });
      } else if (phase === 'running' || phase === 'waiting' || phase === 'unknown') {
        changed = await this.options.owner.command('openClawExecutionUnowned', { sessionKey: key });
      }
      await this.publish(key);
      this.wake();
      return changed;
    }).catch(error => { this.lostObservation(); throw error; });
    this.events.set(key, work);
    const release = () => {
      this.eventCount--; this.eventBytes -= bytes;
      if (this.events.get(key) === work) this.events.delete(key);
    };
    void work.then(release, release);
    return this.retain(work);
  }

  reconcile(key: string): Promise<void> {
    if (this.closed || this.pauseLease) return Promise.resolve();
    const previous = this.reconciliation.get(key);
    if (previous) return previous;
    if (this.reconciliation.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const work = Promise.resolve().then(() => this.run(key));
    this.reconciliation.set(key, work);
    const release = () => { if (this.reconciliation.get(key) === work) this.reconciliation.delete(key); };
    void work.then(release, release);
    return this.retain(work);
  }
  private async recover(key: string) {
    const candidate = await this.options.owner.command('openClawRecoveryCandidate', {
      sessionKey: key, connectionId: this.options.recovery.connectionId() ?? null,
    });
    if (!validConnectorExecutionOutput('openClawRecoveryCandidate', candidate) || candidate && candidate.sessionKey !== key)
      throw new ConnectorOwnerUnavailable();
    if (!candidate?.runId || !candidate.gatewayConnectionId || this.closed) return;
    let snapshot: unknown;
    try { snapshot = await this.options.recovery.query(candidate.runId, candidate.gatewayConnectionId); }
    catch { this.note('query'); return; }
    if (this.options.recovery.connectionId() !== candidate.gatewayConnectionId || !isNormalOpenClawCompletion(snapshot, candidate.runId)) return;
    if (await this.options.owner.command('openClawExecutionCompleteQuery', { expected: candidate })) await this.publish(key);
  }
  private async history(key: string): Promise<boolean> {
    const sync = (await this.read(key))?.historySync;
    if (!sync || sync.state === 'current') return false;
    let state: 'current' | 'error' = 'current';
    try { await this.options.refreshMessages(key, { fresh: true }); }
    catch { state = 'error'; this.note('history'); }
    await this.options.owner.command('openClawHistorySettle', { sessionKey: key, revision: sync.revision, state });
    await this.publish(key);
    // History failure is independent of native completion. The original worker
    // will revisit the durable sync revision, without replaying a message.
    return true;
  }
  private async run(key: string) {
    let stage: Stage = 'mirror';
    let failed = false;
    const trace = guardedTrace(this.options.dispatch.diagnostics ?? performanceDiagnostics, 'openclaw-reconcile');
    try {
      if (this.closed) return;
      await this.events.get(key);
      await this.options.reconcileMirror?.(key);
      if (this.closed) return;
      stage = 'query'; await this.recover(key);
      if (this.closed) return;
      stage = 'history'; const synced = await this.history(key);
      if (this.closed || this.pauseLease) return;
      if (!await this.options.owner.command('turnQueuePending', { runtime: 'openclaw', sessionKey: key })) return;
      stage = 'refresh'; await this.options.refreshSessions();
      if (this.closed || this.pauseLease) return;
      if (!synced) await this.options.refreshMessages(key);
      if (this.canDispatch(key)) await this.dispatch.dispatch(key);
    } catch (error) { failed = true; this.note(stage); throw error; }
    finally { trace.add('step', ['event', 'mirror', 'query', 'history', 'refresh', 'projection'].indexOf(stage) + 1); trace.finish(failed); }
  }
}
