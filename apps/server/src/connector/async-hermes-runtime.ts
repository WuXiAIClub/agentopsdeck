import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { AsyncHermesDispatch } from './async-hermes-dispatch.js';
import { AsyncHermesExecution } from './async-hermes-execution.js';
import { AsyncHermesHistory } from './async-hermes-history.js';
import { AsyncHermesLifecycle } from './async-hermes-lifecycle.js';
import { AsyncHermesDeletion } from './async-hermes-deletion.js';
import { AsyncHermesCreation } from './async-hermes-creation.js';
import { AsyncHermesStop } from './async-hermes-stop.js';
import { AsyncHermesLocalControl } from './async-hermes-local-control.js';
import { sameHermesStopExecution } from './connector-hermes-stop-domain.js';
import type { HermesConfig } from '../hermes/config.js';
import type { HermesExecution, HermesToolObservation } from '../hermes/journal.js';
import { HermesProcess } from '../hermes/process.js';
import { HermesRemoteError } from '../hermes/rpc-peer.js';
import type { HermesTransport } from '../hermes/runtime.js';
import { terminalStatus, type HermesEvent } from '../hermes/protocol.js';
import { hermesNativeAttachment, hermesNativeHistory } from '../hermes/native-session.js';
import { attachHermesSession, refreshHermesHistory } from '../hermes/session-history.js';
import { hermesSessionView } from '../hermes/session-view.js';
import { hermesTerminalReceiptMatches } from '../hermes/terminal-settlement.js';
import type { DeckStore } from '../projection/deck-store.js';
import { runNativeOperation } from './native-operation.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Options = { owner: Pick<AsyncConnectorOwner, 'command'>; config: HermesConfig; store: DeckStore;
  deadlineMs: number; executionAvailable(): boolean; diagnostics?: PerformanceDiagnostics;
  /** Queue projections remain in their original application consumer. */
  queueChanged(key: string): void | Promise<void> };
type Factory = (event: (e: HermesEvent) => void, lost: () => void) => HermesTransport;

/** One native execution loop consuming the application's sole database owner.
 * No store constructor, SQL, second native executor or HTTP authorization.
 * Application composition must never register this alongside HermesRuntime. */
export class AsyncHermesRuntime {
  readonly id = 'hermes' as const;
  private native: HermesTransport | undefined;
  private readonly persistence: AsyncHermesExecution;
  private readonly historyPort: AsyncHermesHistory;
  private readonly lifecycle: AsyncHermesLifecycle;
  private readonly dispatcher: AsyncHermesDispatch;
  private readonly deletionPort: AsyncHermesDeletion;
  private readonly creationPort: AsyncHermesCreation;
  private readonly stopPort: AsyncHermesStop;
  private readonly localControlPort: AsyncHermesLocalControl;
  private readonly active = new Map<string, HermesExecution>();
  private readonly live = new Map<string, string>();
  private readonly sequences = new Map<string, number>();
  private readonly attaching = new Map<string, Promise<string>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();
  private readonly refreshed = new Map<string, number>();
  private readonly tools = new Map<string, Promise<void>>();
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly early = new Map<string, HermesEvent>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly physical = new Set<Promise<unknown>>();
  private readonly physicalByKey = new Map<string, Set<Promise<unknown>>>();
  private readonly attachmentUncertain = new Set<string>();
  private readonly deleting = new Set<string>();
  private readonly preparedFailures = new Set<string>();
  private toolPending = 0;
  private stopped = false;
  private paused = false;
  private faulted = false;
  private initialized = false;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private waking: Promise<void> | undefined;
  private wakeGeneration = 0;
  constructor(private readonly options: Options, private readonly factory: Factory = (event, lost) => new HermesProcess(options.config, event, lost)) {
    this.localControlPort = new AsyncHermesLocalControl(options.owner, key => {
      const session = options.store.getSession(key);
      const fields = ['modelProvider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'contextTokens', 'compactionCount'] as const;
      return { connected: this.ready, gateway: '', session: Object.fromEntries(fields.filter(field => session?.[field] !== undefined)
        .map(field => [field, session![field]])) };
    }, report => { for (const message of report) options.store.addMessage(message); }, options.diagnostics);
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw Error('Invalid Hermes operation deadline');
    this.persistence = new AsyncHermesExecution(options.owner);
    this.historyPort = new AsyncHermesHistory(options.owner);
    const diagnostics = options.diagnostics ?? performanceDiagnostics;
    this.lifecycle = new AsyncHermesLifecycle({ owner: options.owner, connected: () => this.ready, diagnostics,
      projection: {
        getMessages: key => options.store.getMessages(key), removeSession: key => options.store.removeSession(key),
        replaceMessages: (key, messages, flags) => options.store.replaceMessages(key, messages, flags),
        upsertSession: session => {
          const local = this.active.get(session.sessionKey);
          options.store.upsertSession(local?.phase === 'unknown' && local.id === session.runtime?.turnId
            ? hermesSessionView(session.sessionKey, session.title, local, this.ready, true) : session);
        },
      } });
    this.dispatcher = new AsyncHermesDispatch({ owner: options.owner, deadlineMs: options.deadlineMs, diagnostics, blockPreparationFailures: true,
      native: { available: () => this.canDispatch, epoch: () => this.native?.epoch,
        attach: key => this.attach(key), history: live => this.history(live),
        submit: (live, text) => this.request('prompt.submit', { session_id: live, text, queued: true }) },
      claimed: execution => { this.revise(execution.key); this.active.set(execution.key, execution); },
      admitted: async (execution, rows) => {
        await this.serializeHistory(execution.key, async () => {
          if (!this.current(execution)) return;
          const snapshot = await this.historyPort.snapshot(execution.key);
          if (!snapshot || !await this.historyPort.commit(snapshot, rows)) throw new ConnectorOwnerUnavailable();
        });
        if (!this.current(execution)) return;
        // Projection is an observer, not native admission authority. A busy
        // paginated projection cannot undo the committed original row ACK.
        try { await this.publish(execution.key); } catch { this.trace('hermes-lifecycle', 7, true); }
        const early = this.early.get(execution.key); this.early.delete(execution.key);
        if (early) await this.finish(execution, early);
      },
    });
    this.stopPort = new AsyncHermesStop({ owner: options.owner, deadlineMs: options.deadlineMs, diagnostics,
      native: { available: () => this.ready, epoch: () => this.native?.epoch ?? '', current: key => this.active.get(key),
        interrupt: execution => {
          const current = this.active.get(execution.key);
          if (!this.ready || this.deleting.has(execution.key) || current?.phase !== 'running'
            || !sameHermesStopExecution(current, execution) || this.native?.epoch !== execution.epoch) return Promise.reject(new ConnectorOwnerUnavailable());
          return this.physicalRequest('session.interrupt', { session_id: execution.live }, execution.key);
        } },
      settled: () => { if (this.canDispatch) this.background(this.wake()); },
    });
    this.creationPort = new AsyncHermesCreation({ owner: options.owner, deadlineMs: options.deadlineMs, workspace: options.config.workspace, diagnostics,
      native: { available: () => this.canDispatch, epoch: () => this.native?.epoch ?? '',
        create: (key, title, cwd) => this.physicalRequest('session.create', { title, cwd, source: 'agentopsdeck' }, key) },
      created: async (key, live, epoch) => {
        if (!this.ready || this.native?.epoch !== epoch || this.deleting.has(key)) return;
        this.live.set(key, live); this.revise(key);
        await this.publish(key);
      },
    });
    this.deletionPort = new AsyncHermesDeletion({ owner: options.owner, diagnostics,
      native: { available: () => this.ready, epoch: () => this.native?.epoch ?? '', live: key => this.live.get(key),
        request: (method, params) => this.request(method, params) },
      fence: key => this.fenceDeletion(key),
      closed: (key, live) => {
        if (this.live.get(key) === live) this.live.delete(key);
        this.sequences.delete(live); this.revise(key);
      },
      removed: key => {
        this.revise(key); this.preparedFailures.delete(key); this.early.delete(key);
        this.options.store.removeSession(key);
      },
    });
  }
  /** Original HTTP authorization/receipt port, not another native executor. */
  get deletion(): Pick<AsyncHermesDeletion, 'remove' | 'receipt'> { return this.deletionPort; }
  get creation(): Pick<AsyncHermesCreation, 'create' | 'receipt' | 'createPhysical' | 'receiptPhysical'> { return this.creationPort; }
  get localControl(): Pick<AsyncHermesLocalControl, 'send' | 'read' | 'sendPhysical' | 'readPhysical'> { return this.localControlPort; }
  get stop(): Pick<AsyncHermesStop, 'stop' | 'receipt' | 'stopPhysical'> { return this.stopPort; }
  get enabled() { return true; }
  // Connection readiness is not admission authority: maintenance/pause must
  // still accept tools and terminal facts for the original running execution.
  get ready() { return this.initialized && !this.stopped && !this.faulted
    && this.native?.ready === true && !!this.native.epoch; }
  private get canDispatch() { return this.ready && !this.paused && this.options.executionAvailable() === true; }
  get status() { return this.stopped ? 'closed' : this.faulted ? 'startup_failed' : this.ready ? 'ready' : 'unavailable'; }
  owns(key: string) { return key.startsWith('hermes:'); }
  private track<T>(work: Promise<T>): Promise<T> {
    this.tasks.add(work); void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work)); return work;
  }
  private trace(operation: 'hermes-lifecycle' | 'hermes-execution-protection' | 'hermes-runtime-close', step: number, failed: boolean) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, operation);
    trace.add('step', step); trace.add('pending', this.tasks.size); trace.finish(failed);
  }
  private background(work: Promise<unknown>) { void work.catch(() => this.trace('hermes-lifecycle', 5, true)); }
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.starting ??= this.track(Promise.resolve().then(async () => {
      try {
        await this.lifecycle.restore(); if (this.stopped) return;
        this.native = this.factory(event => this.event(event), () => this.disconnected());
        if (this.stopped || this.faulted) return;
        await this.native.start();
        if (this.stopped || this.faulted || this.native.ready !== true || !this.native.epoch) throw new ConnectorOwnerUnavailable();
        this.initialized = true;
        await this.lifecycle.refreshProjection();
        this.background(this.wake()); this.trace('hermes-lifecycle', 6, false);
      } catch (error) { this.faulted = true; this.trace('hermes-lifecycle', 6, true); throw error; }
    }));
  }
  private physicalRequest(method: string, params: Record<string, unknown>, key?: string): Promise<unknown> {
    const native = this.native;
    key ??= [...this.live].find(([, live]) => live === params.session_id)?.[0];
    const target = key;
    if (!native || !this.ready) return Promise.reject(new ConnectorOwnerUnavailable());
    let work: Promise<unknown>;
    try { work = Promise.resolve(native.request(method, params)); } catch (error) { return Promise.reject(error); }
    this.physical.add(work);
    if (target) {
      const pending = this.physicalByKey.get(target) ?? new Set<Promise<unknown>>();
      pending.add(work); this.physicalByKey.set(target, pending);
    }
    const settled = () => {
      this.physical.delete(work);
      if (target) {
        const pending = this.physicalByKey.get(target); pending?.delete(work);
        if (!pending?.size) this.physicalByKey.delete(target);
      }
    };
    void work.then(settled, settled);
    return work;
  }
  private request(method: string, params: Record<string, unknown>, key?: string): Promise<unknown> {
    const absent = Symbol('original-delete-absence');
    let absence: HermesRemoteError | undefined;
    return runNativeOperation(() => {
      const work = this.physicalRequest(method, params, key);
      return work.catch(error => {
        // Only the typed reply to THIS delete proves absence. Preserve that
        // proof across the deadline wrapper without trusting a JSON lookalike
        // or a reply arriving after the bounded wait already expired.
        if (method === 'session.delete' && error instanceof HermesRemoteError && error.code === 4007) {
          absence = error; return absent;
        }
        throw error;
      });
    }, { timeoutMs: this.options.deadlineMs }).then(result => {
      if (result === absent && absence) throw absence;
      return result;
    });
  }
  private async history(live: string) { return hermesNativeHistory(await this.request('session.history', { session_id: live })); }
  private attach(key: string): Promise<string> {
    if (this.deleting.has(key) || this.attachmentUncertain.has(key) && !this.attaching.has(key)) return Promise.reject(new ConnectorOwnerUnavailable());
    const live = this.live.get(key); if (live) return Promise.resolve(live);
    const previous = this.attaching.get(key); if (previous) return previous;
    if (!this.ready || this.attaching.size >= 128 || this.preparedFailures.has(key)) return Promise.reject(new ConnectorOwnerUnavailable());
    const epoch = this.native!.epoch;
    const current = () => this.ready && !this.deleting.has(key) && this.native?.epoch === epoch && this.active.get(key)?.phase !== 'unknown';
    const work = this.track(Promise.resolve().then(() => attachHermesSession(key, this.historyPort, async snapshot => {
      // A timeout is not proof that create/resume did not occur. Clear this
      // only after the ORIGINAL stored identity and live mapping both commit.
      this.attachmentUncertain.add(key);
      const resume = snapshot.started || snapshot.nativeAllocated === true;
      const result = await this.request(resume ? 'session.resume' : 'session.create', resume
        ? { session_id: snapshot.stored, source: 'agentopsdeck' }
        : { title: snapshot.title, cwd: this.options.config.workspace, source: 'agentopsdeck' }, key);
      return hermesNativeAttachment(snapshot, result);
    }, current)).then(live => {
      if (!current() || [...this.live].some(([other, existing]) => other !== key && existing === live)) throw new ConnectorOwnerUnavailable();
      this.live.set(key, live); this.attachmentUncertain.delete(key); return live;
    }).finally(() => this.attaching.delete(key)));
    this.attaching.set(key, work); return work;
  }
  /** Explicit admission/terminal notification. Coalesce successor scans; a
   * failed preparation does not silently spin or retry a native operation. */
  wake(): Promise<void> {
    if (!this.canDispatch) return Promise.resolve();
    ++this.wakeGeneration; if (this.waking) return this.waking;
    const work = this.track(Promise.resolve().then(async () => {
      for (let pass = 0; this.canDispatch; pass++) {
        const generation = this.wakeGeneration; let after = '';
        while (this.canDispatch) {
          const page = await this.persistence.page(after, 64);
          for (const key of page) {
            if (!this.canDispatch) return;
            if (this.deleting.has(key) || this.preparedFailures.has(key) || this.active.has(key)) continue;
            try {
              const result = await this.dispatcher.dispatch(key);
              const active = this.active.get(key);
              if (result === 'unknown' && active) await this.freeze(active);
              if (result === 'blocked') await this.publish(key);
            } catch {
              const active = this.active.get(key);
              if (active) await this.freeze(active);
              else this.preparedFailures.add(key);
              this.trace('hermes-execution-protection', 3, true);
            }
          }
          if (page.length < 64) break;
          after = page.at(-1)!;
        }
        if (generation === this.wakeGeneration) return;
        // Bound each scheduling slice, not the number of legitimate terminal
        // successors. Dropping the fifth wake can strand a continuous queue.
        if (pass % 4 === 3) await new Promise<void>(resolve => setImmediate(resolve));
      }
    }).finally(() => { if (this.waking === work) this.waking = undefined; }));
    this.waking = work; return work;
  }
  private current(execution: HermesExecution) { return this.ready && this.native?.epoch === execution.epoch
    && this.active.get(execution.key) === execution && ['starting', 'running'].includes(execution.phase); }
  private revise(key: string) { this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1); this.refreshed.delete(key); }
  private async publish(key: string) {
    await this.lifecycle.refresh(key);
    if (!this.stopped) await this.options.queueChanged(key);
  }
  /** Persisted Hermes fragment for the application's causal event snapshot.
   * This does not attach native sessions or claim final history readiness. */
  readonly refreshProjection = (): Promise<void> => {
    if (this.stopped || !this.lifecycle.recovered) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.track(this.lifecycle.refreshProjection());
  };
  isSessionHistoryReady(key: string) { return !this.stopped && !this.deleting.has(key) && this.refreshed.has(key) && !this.refreshing.has(key); }
  refreshSession(key: string, options: { maxAgeMs?: number } = {}): Promise<void> {
    if (!this.ready || this.deleting.has(key) || this.attachmentUncertain.has(key) && !this.attaching.has(key)) return Promise.reject(new ConnectorOwnerUnavailable());
    const pending = this.refreshing.get(key); if (pending) return pending;
    if (options.maxAgeMs && Date.now() - (this.refreshed.get(key) ?? 0) < options.maxAgeMs) return Promise.resolve();
    if (this.refreshing.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const revision = this.revisions.get(key), epoch = this.native!.epoch;
    const current = () => this.ready && !this.deleting.has(key) && epoch === this.native?.epoch && revision === this.revisions.get(key);
    const work = this.serializeHistory(key, async () => {
      // A failed unknown write can leave durable phase=running. The local
      // protection fence still forbids native history I/O and history-ready.
      if (this.active.get(key)?.phase === 'unknown') { if (current()) await this.publish(key); return; }
      const result = await refreshHermesHistory(key, this.historyPort, { current, attach: () => this.attach(key), history: live => this.history(live) },
        () => {}, this.options.diagnostics);
      if (current() && result !== 'stale') { await this.publish(key); if (current()) this.refreshed.set(key, Date.now()); }
    }).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, work); return work;
  }
  private async fenceDeletion(key: string) {
    this.deleting.add(key); this.revise(key);
    // Draining logical promises alone loses timed-out physical requests. A
    // late create/resume must NEVER let deletion act on the old stored id.
    for (;;) {
      const pending = [this.attaching.get(key), this.refreshing.get(key), this.tools.get(key),
        ...(this.physicalByKey.get(key) ?? [])].filter((work): work is Promise<unknown> => !!work);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    if (this.attachmentUncertain.has(key)) throw new ConnectorOwnerUnavailable();
  }
  private event(event: HermesEvent) {
    if (this.stopped || this.faulted) return;
    try {
      if (event.type === 'session.reclaimed' && typeof event.payload?.session_id === 'string') {
        for (const [key, live] of this.live) if (live === event.payload.session_id) {
          const active = this.active.get(key); if (active) this.background(this.freeze(active));
          this.live.delete(key); this.sequences.delete(live); this.revise(key);
        }
        return;
      }
      if (!event.sessionId) return;
      const key = [...this.live].find(([, live]) => live === event.sessionId)?.[0]; if (!key) return;
      const execution = this.active.get(key), previous = this.sequences.get(event.sessionId);
      if (!Number.isSafeInteger(event.seq) || event.seq! < 0 || previous !== undefined && event.seq !== previous + 1) {
        if (execution) this.background(this.freeze(execution)); return;
      }
      this.sequences.set(event.sessionId, event.seq!);
      if (!execution || !this.current(execution)) return;
      if ((event.type === 'tool.start' || event.type === 'tool.complete') && typeof event.payload?.tool_id === 'string') this.observeTool(execution, event);
      if (!this.current(execution)) return;
      if (event.type === 'message.delta' && typeof event.payload?.text === 'string') {
        const id = `hermes-stream:${execution.id}`, old = this.options.store.getMessage(key, id);
        if (Buffer.byteLength(old?.text ?? '') + Buffer.byteLength(event.payload.text) > 8 * 1024 * 1024) { this.background(this.freeze(execution)); return; }
        this.options.store.addMessage({ id, sessionKey: key, role: 'assistant', text: (old?.text ?? '') + event.payload.text,
          createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now() });
      }
      if (!this.current(execution)) return;
      if (terminalStatus(event)) {
        if (execution.phase === 'starting') this.early.set(key, event);
        else this.background(this.finish(execution, event));
      }
    } catch { this.disconnected(); }
  }
  private observeTool(execution: HermesExecution, event: HermesEvent) {
    if (this.finishing.has(execution.id) || this.toolPending >= 64) { this.background(this.freeze(execution)); return; }
    const payload = event.payload!, observation: HermesToolObservation = { toolId: payload.tool_id as string,
      phase: event.type === 'tool.start' ? 'call' : 'result', at: Date.now(),
      ...(typeof payload.name === 'string' ? { name: payload.name.slice(0, 256) } : {}) };
    if (!observation.toolId || Buffer.byteLength(observation.toolId) > 512 || /[\x00-\x1f\x7f]/.test(observation.toolId)) { this.background(this.freeze(execution)); return; }
    const expected = structuredClone(execution); this.toolPending++; this.revise(execution.key);
    const work = this.serializeHistory(execution.key, async () => {
      if (!this.current(execution)) return;
      const message = await this.persistence.tool(expected, observation);
      if (!message) throw new ConnectorOwnerUnavailable();
      if (!this.current(execution)) return;
      if (!this.options.store.hasMessage(execution.key, message.id)) this.options.store.addMessage(message);
      if (!this.current(execution)) return;
      const duration = typeof payload.duration_s === 'number' ? payload.duration_s * 1000 : 0;
      this.options.store.replaceActivities(execution.key, [{ id: message.toolCallId!, sessionKey: execution.key, runId: execution.id,
        toolCallId: observation.toolId, toolName: message.toolName!, status: observation.phase === 'call' ? 'running' : 'done',
        hiddenArgumentCount: 0, updatedAt: message.createdAt, durationMs: Number.isFinite(duration) ? Math.max(0, duration) : 0 }]);
    }).catch(() => { this.background(this.freeze(execution)); }).finally(() => { this.toolPending--; });
    this.background(work);
  }
  private serializeHistory(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.tools.get(key);
    const work = this.track(Promise.resolve(previous).then(run).finally(() => {
      if (this.tools.get(key) === work) this.tools.delete(key);
    }));
    this.tools.set(key, work); return work;
  }
  private async toolBarrier(key: string) { while (this.tools.has(key)) await this.tools.get(key); }
  private finish(execution: HermesExecution, event: HermesEvent): Promise<void> {
    const previous = this.finishing.get(execution.id); if (previous) return previous;
    const work = this.track(Promise.resolve().then(async () => {
      await this.toolBarrier(execution.key);
      const phase = terminalStatus(event); if (!phase || execution.phase !== 'running' || !this.current(execution)) return;
      this.revise(execution.key);
      try {
        const result = await this.persistence.settle(execution, phase, { current: () => this.current(execution),
          snapshot: live => this.request('session.activate', { session_id: live, omit_messages: true }), history: live => this.history(live) });
        if (!this.current(execution)) return;
        Object.assign(execution, result.execution); this.active.delete(execution.key);
        // Commit fact before any observer can throw/reenter. Projection errors
        // cannot turn terminal into a second native submission.
        await this.publish(execution.key); this.refreshed.set(execution.key, Date.now());
      } catch {
        // The terminal transaction may have committed before projection I/O
        // failed. Only the exact original terminal receipt can release this
        // execution fence; a different id/row/batch/epoch is never evidence.
        let confirmed = false;
        if (this.current(execution)) {
          try {
            const receipt = await this.persistence.read(execution.key);
            if (this.current(execution) && hermesTerminalReceiptMatches(execution, receipt, phase)) {
              Object.assign(execution, receipt); this.active.delete(execution.key); confirmed = true;
            }
          } catch { /* No receipt is not terminal proof. */ }
        }
        this.trace('hermes-execution-protection', 4, true);
        if (!confirmed) await this.freeze(execution);
      }
      finally { if (this.canDispatch) this.background(this.wake()); }
    }).finally(() => this.finishing.delete(execution.id)));
    this.finishing.set(execution.id, work); return work;
  }
  private freeze(execution: HermesExecution): Promise<void> {
    if (!['starting', 'running'].includes(execution.phase)) return Promise.resolve();
    const expected = structuredClone(execution); execution.phase = 'unknown'; this.revise(execution.key); this.early.delete(execution.key);
    return this.track(Promise.resolve().then(async () => {
      let failed = false;
      try { if (await this.persistence.unknown(expected) !== true) failed = true; } catch { failed = true; }
      try { await this.publish(execution.key); } catch { failed = true; }
      // A failed durable unknown still retains the in-memory execution fence.
      this.trace('hermes-execution-protection', 1, failed);
    }));
  }
  private disconnected() {
    if (this.stopped || this.faulted) return;
    this.faulted = true; this.refreshed.clear(); this.live.clear(); this.sequences.clear();
    for (const execution of this.active.values()) this.background(this.freeze(execution));
    if (this.lifecycle.recovered) this.background(this.track(this.lifecycle.refreshProjection()));
    this.trace('hermes-execution-protection', 2, true);
  }
  pauseQueueWorker() {
    this.paused = true; const pause = this.dispatcher.pause();
    return { drained: pause.drained, resume: () => {
      if (this.stopped || this.faulted) return false;
      this.paused = false; pause.resume(); this.background(this.wake()); return true;
    } };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.paused = true; this.refreshed.clear();
    const deletion = this.deletionPort.close();
    const creation = this.creationPort.close();
    const stop = this.stopPort.close();
    const localControl = this.localControlPort.close();
    return this.closing = Promise.resolve().then(async () => {
      let failure: unknown;
      for (const execution of this.active.values()) this.background(this.freeze(execution));
      // A startup may still produce a live transport after close freezes
      // admission. Retire that SAME transport after its original start settles;
      // closing it earlier can let a late startup resurrect an orphan process.
      const nativeClose = Promise.resolve(this.starting).catch(() => {}).then(() => this.native?.close());
      const results = await Promise.allSettled([this.dispatcher.close(), deletion, creation, stop, localControl, nativeClose]);
      for (const result of results) if (result.status === 'rejected') failure ??= result.reason;
      while (this.tasks.size || this.physical.size) await Promise.allSettled([...this.tasks, ...this.physical]);
      try { await this.lifecycle.close(); } catch (error) { failure ??= error; }
      this.trace('hermes-runtime-close', 1, failure !== undefined);
      if (failure !== undefined) throw failure;
    });
  }
}
