import type { DeckStore } from '../projection/deck-store.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { GatewayAsyncObserver } from '../gateway/ws-client.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { AsyncOpenClawStop } from './async-openclaw-stop.js';
import { AsyncOpenClawStatus } from './async-openclaw-status.js';
import { AsyncOpenClawCompact } from './async-openclaw-compact.js';
import { AsyncOpenClawTurnQueue } from './async-openclaw-turn-queue.js';
import { AsyncOpenClawProjection } from './async-openclaw-projection.js';
import type { OpenClawMessagesHttp } from './openclaw-messages-http.js';
import { AsyncOpenClawReads, type AsyncOpenClawReadsOptions } from './async-openclaw-reads.js';
import type { OpenClawReadsHttp } from './openclaw-reads-http.js';
import { AsyncMirrorDispatcher } from './async-mirror-dispatcher.js';

type QueueOptions = ConstructorParameters<typeof AsyncOpenClawTurnQueue>[0];
type MessageOptions = ConstructorParameters<typeof AsyncOpenClawMessages>[0];
export type AsyncOpenClawApplicationOptions = Pick<QueueOptions,
  'recovery' | 'refreshSessions' | 'refreshMessages' | 'nativeSession' | 'reconcileMirror' | 'onAdmission' | 'retryMs'> & {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  deck: DeckStore;
  /** Original read-only hydration, not the queue's execution reconciliation. */
  history: Pick<AsyncOpenClawReadsOptions, 'snapshot' | 'refresh' | 'historyReady' | 'preparationWaitMs'> & {
    invalidate(): void;
    close(): Promise<void>;
  };
  /** Original session-discovery cache, invalidated on every Gateway generation. */
  invalidateDiscovery(): void;
  dispatch: QueueOptions['dispatch'];
  defaultAgentId: string;
  /** Maintenance veto only. Native availability belongs to dispatch.native. */
  admissionAvailable(): boolean;
  gatewayStatus(): string;
  queueChanged?(key: string): void | Promise<void>;
  persist?: MessageOptions['persist'];
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
  mirror?: Pick<ConstructorParameters<typeof AsyncMirrorDispatcher>[0], 'localOpenClawCli' | 'sendOutbound'>;
};
export type AsyncOpenClawApplicationHttp = {
  openClawMessages: OpenClawMessagesHttp & Required<Pick<OpenClawMessagesHttp, 'stop' | 'status' | 'compact'>>;
  openClawReads: OpenClawReadsHttp;
};

/** Consumes startup's recovered, sole SQL owner and original transport. Never
 * register alongside the synchronous OpenClaw queue/projection. Construction
 * binds display only; start must run under the root's recovery/transport gate.
 * Root freezes transport callbacks before close and closes shared owners last. */
export class AsyncOpenClawApplication {
  readonly http: AsyncOpenClawApplicationHttp & { openClawMessages: { messages: Pick<AsyncOpenClawMessages, 'sendPhysical' | 'readReceiptPhysical' | 'readSendReceiptPhysical'>; stop: Pick<AsyncOpenClawStop, 'stopPhysical'>; status: Pick<AsyncOpenClawStatus, 'sendPhysical' | 'readPhysical'>; compact: Pick<AsyncOpenClawCompact, 'compactPhysical' | 'readPhysical'> } };
  readonly gatewayObserver: GatewayAsyncObserver = {
    event: (raw, connectionId) => this.observe(raw, connectionId),
    connectionChanged: () => this.connectionChanged(),
    unavailable: () => this.fail(6),
  };
  private readonly projection: AsyncOpenClawProjection;
  private readonly queue: AsyncOpenClawTurnQueue;
  private readonly messages: AsyncOpenClawMessages;
  private readonly stop: AsyncOpenClawStop;
  private readonly report: AsyncOpenClawStatus;
  private readonly compact: AsyncOpenClawCompact;
  private readonly reads: AsyncOpenClawReads;
  private readonly mirror?: AsyncMirrorDispatcher;
  private readonly diagnostics: PerformanceDiagnostics;
  private readonly tasks = new Set<Promise<unknown>>();
  private activated = false;
  private failed = false;
  private closed = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private paused = false;
  private pauseLease: AdmissionPause | undefined;

  constructor(private readonly options: AsyncOpenClawApplicationOptions) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      throw new RangeError('Finite OpenClaw application deadline required');
    if (typeof options.history?.invalidate !== 'function' || typeof options.history?.close !== 'function'
      || typeof options.invalidateDiscovery !== 'function')
      throw new TypeError('Original OpenClaw history and discovery lifecycle required');
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    if (options.mirror && options.reconcileMirror) throw new TypeError('Only one original mirror executor is allowed');
    const { owner, deck } = options, gateway = options.dispatch.gateway;
    if (options.mirror) this.mirror = new AsyncMirrorDispatcher({ ...options.mirror, owner,
      defaultAgentId: options.defaultAgentId, diagnostics: this.diagnostics });
    this.reads = new AsyncOpenClawReads(owner, { ...options.history, projection: deck, timeoutMs, diagnostics: this.diagnostics });
    this.projection = new AsyncOpenClawProjection({ owner, deck, diagnostics: this.diagnostics,
      connectionId: () => gateway.connectionId(), observe: (raw, connection) => this.queue.observe(raw, connection) });
    this.queue = new AsyncOpenClawTurnQueue({ owner,
      dispatch: { ...options.dispatch, diagnostics: this.diagnostics,
        native: { available: () => this.ready, epoch: () => options.dispatch.native.epoch() } },
      recovery: options.recovery, refreshSessions: () => options.refreshSessions(),
      refreshMessages: (key, read) => options.refreshMessages(key, read), nativeSession: key => options.nativeSession(key),
      project: (key, fact) => this.projection.project(key, fact), invalidate: () => this.fail(3),
      ...(this.mirror ? { reconcileMirror: this.mirror.reconcileSession }
        : options.reconcileMirror ? { reconcileMirror: key => options.reconcileMirror!(key) } : {}),
      ...(options.onAdmission ? { onAdmission: options.onAdmission } : {}),
      ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}),
    });
    this.messages = new AsyncOpenClawMessages({ owner, defaultAgentId: options.defaultAgentId,
      ready: () => this.ready, sessionExists: key => !!options.nativeSession(key),
      admitted: async key => {
        try { await options.queueChanged?.(key); }
        finally { if (this.ready) this.queue.wake(); }
      }, diagnostics: this.diagnostics, ...(options.persist ? { persist: options.persist } : {}) });
    this.stop = new AsyncOpenClawStop({ owner, gateway, available: () => this.available, diagnostics: this.diagnostics });
    this.report = new AsyncOpenClawStatus({ owner, diagnostics: this.diagnostics,
      display: key => {
        const session = deck.getSession(key);
        const fields = ['modelProvider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'contextTokens', 'compactionCount'] as const;
        return { gateway: options.gatewayStatus(), connectionId: gateway.connectionId() ?? null,
          session: session ? Object.fromEntries(fields.filter(field => session[field] !== undefined).map(field => [field, session[field]])) : null };
      }, project: messages => { for (const message of messages) deck.addMessage(message); } });
    this.compact = new AsyncOpenClawCompact({ owner, gateway, available: () => this.ready, diagnostics: this.diagnostics,
      session: key => {
        const native = options.nativeSession(key), session = deck.getSession(key);
        return { exists: !!native, busy: !!native && (native.hasActiveRun === true || !['idle', 'failed'].includes(native.status)),
          totalTokens: session?.totalTokens ?? null, contextTokens: session?.contextTokens ?? null };
      }, project: async result => {
        await this.projection.project(result.key);
        if (!this.closed && result.projection?.operation === 'message') {
          const message = result.projection;
          deck.addMessage({ id: message.id, sessionKey: result.key, role: 'user', text: message.text,
            status: 'sent', createdAt: message.createdAt });
        }
      } });
    // No HTTP business command enters a not-yet-recovered application. Once
    // opened, receipt reads remain available through maintenance/native loss;
    // the worker still revalidates current authority on each original receipt.
    this.http = { openClawMessages: {
      messages: {
        send: (input, wait) => this.use(() => this.messages.send(input, wait)),
        sendPhysical: (input, authority) => this.use(() => this.messages.sendPhysical(input, authority)),
        readReceiptPhysical: input => this.use(() => this.messages.readReceiptPhysical(input)),
        readSendReceiptPhysical: input => this.use(() => this.messages.readSendReceiptPhysical(input)),
        readReceipt: (input, wait) => this.use(() => this.messages.readReceipt(input, wait)),
        readSendReceipt: (input, wait) => this.use(() => this.messages.readSendReceipt(input, wait)),
      }, stop: { stop: (input, wait) => this.use(() => this.stop.stop(input, wait)),
        stopPhysical: (input, authority) => this.use(() => this.stop.stopPhysical(input, authority)) },
      status: {
        send: (input, wait) => this.use(() => this.report.send(input, wait)),
        sendPhysical: (input, authority) => this.use(() => this.report.sendPhysical(input, authority)),
        read: (input, wait) => this.use(() => this.report.read(input, wait)),
        readPhysical: (input, authority) => this.use(() => this.report.readPhysical(input, authority)),
        readForSend: (input, wait) => this.use(() => this.report.readForSend(input, wait)),
      }, compact: {
        compactPhysical: (input, authority) => this.use(() => this.compact.compactPhysical(input, authority)),
        readPhysical: (input, authority) => this.use(() => this.compact.readPhysical(input, authority)),
        compact: (input, wait) => this.use(() => this.compact.compact(input, wait)),
        read: (input, wait) => this.use(() => this.compact.read(input, wait)),
        readForSend: (input, wait) => this.use(() => this.compact.readForSend(input, wait)),
      }, ready: () => this.ready, timeoutMs, diagnostics: this.diagnostics }, openClawReads: { reads: {
        state: (input, request) => this.use(() => this.reads.state(input, request)),
        page: (input, request) => this.use(() => this.reads.page(input, request)),
        message: (input, request) => this.use(() => this.reads.message(input, request)),
      } } };
  }
  private use<T>(work: () => Promise<T>): Promise<T> {
    if (!this.activated || this.closed) return Promise.reject(new ConnectorOwnerUnavailable());
    return work();
  }
  private get available() {
    const status = this.projection.status();
    return this.activated && !this.closed && !this.failed && status.ready && !status.unavailable
      && !status.closing && this.options.dispatch.native.available() === true;
  }
  get ready() { return !this.paused && this.available && this.options.admissionAvailable() === true; }
  get status() { return this.closed ? 'closed' : this.failed || this.projection.status().unavailable ? 'unavailable'
    : this.activated ? 'ready' : this.starting ? 'opening' : 'created'; }
  private fail(step: number) {
    this.failed = true;
    try { this.options.deck.invalidateOpenClawExecutionFacts(); } catch { /* Local veto remains latched. */ }
    const trace = guardedTrace(this.diagnostics, 'openclaw-application'); trace.add('step', step); trace.finish(true);
  }
  private retain<T>(physical: Promise<T>) {
    this.tasks.add(physical);
    void physical.then(() => this.tasks.delete(physical), () => this.tasks.delete(physical));
    return physical;
  }
  /** Execution-facts fragment; maintenance pauses execution, not observation. */
  readonly refreshProjection = (): Promise<void> => {
    if (!this.activated || this.closed || this.failed) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.retain(this.projection.refreshProjection());
  };
  start(): Promise<void> {
    if (this.closed || this.failed) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.starting ??= this.retain(Promise.resolve().then(async () => {
      try {
        if (this.closed) throw new ConnectorOwnerUnavailable();
        await this.projection.open();
        if (this.closed) throw new ConnectorOwnerUnavailable();
        this.activated = true; this.queue.start();
      } catch { this.fail(1); throw new ConnectorOwnerUnavailable(); }
    }));
  }
  observe(raw: unknown, connectionId: string | undefined): Promise<boolean> {
    if (!this.activated || this.closed || this.failed) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.retain(this.projection.observe(raw, connectionId).catch(() => {
      this.fail(2); throw new ConnectorOwnerUnavailable();
    }));
  }
  connectionChanged(): Promise<void> {
    if (!this.activated || this.closed || this.failed) return Promise.reject(new ConnectorOwnerUnavailable());
    try {
      // Freeze stale history before any async observation can yield to HTTP.
      this.invalidateOriginal(() => this.options.history.invalidate());
      this.invalidateOriginal(() => this.options.invalidateDiscovery());
    } catch { this.fail(4); return Promise.reject(new ConnectorOwnerUnavailable()); }
    const work = this.projection.connectionChanged().then(() => { if (this.ready) this.queue.wake(); })
      .catch(() => { this.fail(4); throw new ConnectorOwnerUnavailable(); });
    return this.retain(work);
  }
  private invalidateOriginal(invalidate: () => unknown) {
    const result = invalidate();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      // A JS caller must not silently replace the synchronous generation fence
      // with fire-and-forget work, including an unhandled rejected promise.
      this.retain(Promise.resolve(result).catch(() => {}));
      throw new ConnectorOwnerUnavailable();
    }
  }
  wake() { if (this.ready) this.queue.wake(); }
  /** Pauses NEW execution/file effects; original stop and receipt reads remain
   * available. This is not proof that the native run has ended. */
  pauseQueueWorker(): AdmissionPause {
    if (this.pauseLease) return this.pauseLease;
    this.paused = true;
    const queue = this.queue.pause(); let drained = false;
    let mirror = this.mirror?.pauseAdmissions();
    const lease: AdmissionPause = {
      drained: Promise.all([queue.drained, mirror?.drained, this.messages.drain(), this.compact.drain()]).then(() => { drained = true; }),
      resume: () => {
        const projection = this.projection.status();
        if (this.closed || this.failed || projection.unavailable || projection.closing
          || this.pauseLease !== lease || !drained) return false;
        if (mirror && !mirror.resume()) return false;
        if (!queue.resume()) {
          // A failed queue resume must not reopen another effect lane.
          mirror = this.mirror?.pauseAdmissions();
          return false;
        }
        this.pauseLease = undefined; this.paused = false; this.wake(); return true;
      },
    };
    return this.pauseLease = lease;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Freeze synchronously, before any pending promise can reenter a port.
    this.closed = true;
    this.messages.freeze(); this.stop.freeze(); this.report.freeze(); this.compact.freeze();
    let history: Promise<void>;
    try { history = Promise.resolve(this.options.history.close()); }
    catch (error) { history = Promise.reject(error); }
    const reads = this.reads.close();
    const queue = this.queue.close();
    const mirror = this.mirror?.close();
    return this.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([queue, mirror, reads, history, this.messages.close(), this.stop.close(), this.report.close(), this.compact.close()]);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      await this.projection.close();
      if (results.some(value => value.status === 'rejected')) { this.fail(5); throw new ConnectorOwnerUnavailable(); }
    });
  }
}
