import type { AgentReadiness } from '@agentopsdeck/shared';
import type { HermesConfig } from '../hermes/config.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { ConnectorAgentLifecycle } from './agent-runtimes.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesRuntime } from './async-hermes-runtime.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';
import { AsyncHermesQueue } from './async-hermes-queue.js';
import { AsyncHermesReads } from './async-hermes-reads.js';
import type { HermesReadsHttp } from './hermes-reads-http.js';
import type { AsyncHermesStop } from './async-hermes-stop.js';
import type { AsyncHermesLocalControl } from './async-hermes-local-control.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import type { HermesMessagesHttp } from './hermes-messages-http.js';
import type { HermesCreationHttp } from './hermes-creation-http.js';
import type { HermesDeletionHttp } from './hermes-deletion-http.js';
import type { HermesQueueHttp } from './hermes-queue-http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type AsyncHermesApplicationHttp = {
  hermesMessages: HermesMessagesHttp & Required<Pick<HermesMessagesHttp, 'stop' | 'localControl'>>;
  hermesCreation: HermesCreationHttp; hermesDeletion: HermesDeletionHttp; hermesQueue: HermesQueueHttp;
  hermesReads: HermesReadsHttp;
};
export type AsyncHermesApplicationOptions = {
  owner: Pick<AsyncConnectorOwner, 'command'>; projection: DeckStore; config?: HermesConfig;
  eventSnapshot: EventSnapshotRead;
  executionAvailable(): boolean; queueChanged(key: string): void | Promise<void>;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
};
type Factory = NonNullable<ConstructorParameters<typeof AsyncHermesRuntime>[1]>;

/** Complete Hermes control/execution assembly, consuming (never creating or
 * closing) startup's sole SQL owner. Never register alongside HermesRuntime.
 * Construction is inert; activation waits original recovery and projection. */
export class AsyncHermesApplication implements ConnectorAgentLifecycle {
  readonly id = 'hermes' as const;
  readonly http: AsyncHermesApplicationHttp & { hermesMessages: { messages: Pick<AsyncHermesMessages, 'sendPhysical' | 'readReceiptPhysical' | 'readSendReceiptPhysical'>; stop: Pick<AsyncHermesStop, 'stopPhysical'>; localControl: Pick<AsyncHermesLocalControl, 'sendPhysical' | 'readPhysical'> } };
  private readonly runtime: AsyncHermesRuntime | undefined;
  private readonly messages: AsyncHermesMessages;
  private readonly queue: AsyncHermesQueue;
  private readonly reads: AsyncHermesReads;
  private readonly diagnostics: PerformanceDiagnostics;
  private readonly tasks = new Set<Promise<unknown>>();
  private closed = false;
  private admitted = false;
  private failed = false;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: AsyncHermesApplicationOptions, factory?: Factory) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite Hermes application deadline required');
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    if (options.config?.enabled === true) this.runtime = new AsyncHermesRuntime({ owner: options.owner,
      config: options.config, store: options.projection, deadlineMs: timeoutMs, diagnostics: this.diagnostics,
      executionAvailable: () => this.ready && options.executionAvailable() === true,
      queueChanged: key => options.queueChanged(key) }, factory);
    const original = () => {
      if (this.closed || !this.runtime) throw new ConnectorOwnerUnavailable();
      return this.runtime;
    };
    const changed = async (key: string) => {
      if (this.closed) return;
      try { await options.queueChanged(key); }
      finally { if (this.ready) await this.runtime!.wake(); }
    };
    this.messages = new AsyncHermesMessages(options.owner, key => this.observe(changed(key), 11), this.diagnostics);
    this.queue = new AsyncHermesQueue({ owner: options.owner, changed: key => changed(key), diagnostics: this.diagnostics });
    this.reads = new AsyncHermesReads(options.owner, { projection: options.projection, snapshot: options.eventSnapshot,
      refresh: (key, readOptions) => this.refreshSession(key, readOptions), historyReady: key => this.isSessionHistoryReady(key),
      timeoutMs, diagnostics: this.diagnostics });
    const controls = { ready: () => this.ready, timeoutMs, diagnostics: this.diagnostics };
    this.http = {
      hermesMessages: { ...controls, messages: this.messages,
        stop: { stop: input => original().stop.stop(input), receipt: (input, wait) => original().stop.receipt(input, wait),
          stopPhysical: (input, authority) => original().stop.stopPhysical(input, authority) },
        localControl: { send: (input, wait) => original().localControl.send(input, wait), read: (input, wait) => original().localControl.read(input, wait),
          sendPhysical: (input, authority) => original().localControl.sendPhysical(input, authority),
          readPhysical: (input, authority) => original().localControl.readPhysical(input, authority) } },
      hermesCreation: { ...controls, creation: {
        create: input => original().creation.create(input), receipt: (authorization, key) => original().creation.receipt(authorization, key) },
        physical: { createPhysical: (input, authority) => original().creation.createPhysical(input, authority),
          receiptPhysical: (authorization, key) => original().creation.receiptPhysical(authorization, key) } },
      hermesDeletion: { ...controls, lifecycle: {
        remove: (key, commandKey, authorization, application, authority) => original().deletion.remove(key, commandKey, authorization, application, authority),
        receipt: (key, commandKey, authorization) => original().deletion.receipt(key, commandKey, authorization) } },
      hermesQueue: { ...controls, queue: this.queue },
      hermesReads: { reads: this.reads },
    };
  }
  get ready(): boolean { return !this.closed && this.admitted && this.runtime?.ready === true; }
  get status(): AgentReadiness {
    if (this.closed) return 'closed';
    if (!this.runtime) return 'disabled';
    if (this.failed || this.runtime.status === 'startup_failed') return 'failed';
    if (this.ready) return this.options.executionAvailable() === true ? 'ready' : 'maintenance';
    return 'starting';
  }
  get agents(): readonly ConnectorAgentLifecycle[] { return this.runtime ? [this] : []; }
  private track<T>(work: Promise<T>): Promise<T> {
    this.tasks.add(work);
    void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work));
    return work;
  }
  private async observe(work: Promise<void>, step: number): Promise<void> {
    try { await work; }
    catch { const trace = guardedTrace(this.diagnostics, 'hermes-lifecycle'); trace.add('step', step); trace.finish(true); }
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new ConnectorOwnerUnavailable());
    if (!this.runtime) return Promise.resolve();
    return this.starting ??= this.track(Promise.resolve().then(async () => {
      try {
        if (this.closed) throw new ConnectorOwnerUnavailable();
        await this.runtime!.start();
        if (this.closed || this.runtime!.ready !== true) throw new ConnectorOwnerUnavailable();
        this.admitted = true;
        await this.runtime!.wake();
      } catch (error) { this.admitted = false; this.failed = true; throw error; }
    }));
  }
  activate(): void { if (!this.closed) void this.observe(this.start(), 12); }
  readonly refreshProjection = (): Promise<void> => {
    if (this.closed || this.runtime && !this.admitted) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.runtime ? this.track(this.runtime.refreshProjection()) : Promise.resolve();
  };
  refreshSession(key: string, options: Parameters<ConnectorAgentLifecycle['refreshSession']>[1]): Promise<void> {
    if (!this.ready || !this.runtime) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.track(this.runtime.refreshSession(key, options));
  }
  isSessionHistoryReady(key: string): boolean { return this.ready && this.runtime?.isSessionHistoryReady(key) === true; }
  pauseQueueWorker(): ReturnType<ConnectorAgentLifecycle['pauseQueueWorker']> {
    if (this.closed || !this.runtime) throw new ConnectorOwnerUnavailable();
    return this.runtime.pauseQueueWorker();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.admitted = false;
    // Freeze all entry points synchronously; neither a caller deadline nor a
    // rejected sibling close can retire shared DB ownership prematurely.
    const consumers = [this.messages.close(), this.queue.close(), this.reads.close(), this.runtime?.close()];
    return this.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(consumers);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      const failed = results.some(result => result.status === 'rejected');
      const trace = guardedTrace(this.diagnostics, 'hermes-runtime-close'); trace.add('step', 2); trace.finish(failed);
      if (failed) throw new ConnectorOwnerUnavailable();
    });
  }
}
