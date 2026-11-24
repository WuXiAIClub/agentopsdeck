import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { AsyncSdkCompactDispatch } from './async-sdk-compact-dispatch.js';
import { sameSdkCompactRef } from './connector-sdk-compact-domain.js';
import type { SdkCompactExecution } from './sdk-compact-dispatch.js';
import type { SdkOwnedCompactWorker } from './sdk-compact-worker.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import type { SdkDispatchResult } from './sdk-dispatch.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { SdkMessageStopRequest } from './connector-sdk-stop-domain.js';
import { dispatchSdkMessageStop } from './async-sdk-message-stop.js';

export type AsyncSdkCompactOptions = {
  models: { model: string; modelChoices?: readonly string[] };
  timeoutMs?: number;
  start: (execution: SdkCompactExecution) => SdkOwnedCompactWorker;
};
type Entry = { ref: SdkCompactRef; worker: SdkOwnedCompactWorker; result: SdkOwnedCompactWorker['result']; closed: boolean };

/** Physical ownership is deliberately longer than the durable terminal write.
 * A timeout never forgets the original worker/promise or permits a successor. */
export class AsyncSdkCompactDriver {
  private readonly dispatch: AsyncSdkCompactDispatch;
  private readonly entries = new Map<string, Entry>();
  private readonly reserved = new Set<string>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly controls = new Set<Promise<unknown>>();
  private closed = false;
  private paused = false;
  private failed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: AsyncSdkCompactOptions & {
    owner: Pick<AsyncConnectorOwner, 'command'>; runtime: SdkAgentId; epoch: string; deadlineMs: number;
    ready: () => boolean; occupied: (key: string) => boolean;
    controlReady?: () => boolean;
    drained: (key: string) => void; faulted: () => void; diagnostics?: PerformanceDiagnostics;
  }) {
    const self = this;
    this.dispatch = new AsyncSdkCompactDispatch({ owner: options.owner, deadlineMs: options.deadlineMs,
      admissionReady: options.ready,
      models: options.models, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      adapter: { runtime: options.runtime, epoch: options.epoch,
        // Maintenance closes admission, not the original physical runtime's
        // terminal/history evidence path. Never strand its committed intent.
        get ready() { return !self.closed && !self.failed && (options.controlReady ?? options.ready)() === true; },
        compact: async execution => {
          if (this.closed || this.paused || this.failed || options.ready() !== true || options.occupied(execution.key)
            || this.entries.has(execution.key) || !this.reserved.has(execution.key)) throw Error('connector_storage_unavailable');
          let worker: SdkOwnedCompactWorker;
          try { worker = options.start(execution); }
          catch (error) { this.fault(); throw error; }
          const entry: Entry = { ref: { key: execution.key, id: execution.id, epoch: execution.epoch,
            nativeSessionId: execution.nativeSessionId }, worker, result: worker.result, closed: false };
          this.entries.set(execution.key, entry);
          void entry.result.catch(() => {});
          // Even substituted early-result ports cannot certify physical exit.
          const result = await entry.result;
          await worker.finished;
          if (await worker.inspectQuiescence() !== true) { this.fault(); throw Error('connector_storage_unavailable'); }
          return result;
        },
        inspectSettlement: async execution => this.original(execution).worker.inspectSettlement(),
        interruptCompact: execution => {
          const task = this.original(execution).worker.interrupt();
          this.controls.add(task);
          void task.finally(() => this.controls.delete(task)).catch(() => {});
          return task;
        },
      } });
  }
  has(key: string) { return this.reserved.has(key); }
  inspect() { return { nativeWorkers: this.entries.size, jobs: this.jobs.size, cleanupUnconfirmed: this.failed }; }
  pause() { this.paused = true; this.dispatch.pause(); }
  resume() { if (!this.closed && !this.failed) { this.paused = false; this.dispatch.resume(); } }
  private original(ref: SdkCompactRef): Entry {
    const entry = this.entries.get(ref.key);
    if (!entry || !sameSdkCompactRef(entry.ref, ref)) throw Error('connector_storage_unavailable');
    return entry;
  }
  private fault() {
    this.failed = true; this.pause();
    this.options.faulted();
  }
  private closeEntry(entry: Entry) {
    if (entry.closed) return;
    entry.closed = true;
    try { entry.worker.close(); } catch { this.fault(); }
  }
  compact(key: string, commandKey: string, authorization: string, signal?: AbortSignal,
    application?: ApplicationTransactionEvidence, authority?: ApplicationCommandScope): Promise<SdkDispatchResult> {
    if (this.closed || this.paused || this.failed || this.options.ready() !== true || this.options.occupied(key)
      || this.reserved.has(key) || this.reserved.size >= 128) return Promise.resolve('not_started');
    this.reserved.add(key);
    const task = this.dispatch.dispatch(key, commandKey, authorization, signal, application, authority).then(async result => {
      const entry = this.entries.get(key);
      if (result === 'accepted' && entry && !await this.dispatch.settle(entry.ref, !!authority)) return 'unknown' as const;
      return result;
    }).finally(async () => {
      const entry = this.entries.get(key);
      if (entry) {
        this.closeEntry(entry);
        // Observe original result AND physical finish, including after timeout.
        const outcomes = await Promise.allSettled([entry.result, entry.worker.finished]);
        try {
          if (outcomes[1]?.status !== 'fulfilled' || await entry.worker.inspectQuiescence() !== true) this.fault();
          else this.entries.delete(key);
        } catch { this.fault(); }
      }
      if (!this.entries.has(key)) this.reserved.delete(key);
      this.options.drained(key);
    });
    this.jobs.add(task);
    void task.finally(() => this.jobs.delete(task)).catch(() => {});
    return task;
  }
  interrupt(key: string, expectedRunId: string, authorization: string): Promise<SdkDispatchResult> {
    const entry = this.entries.get(key);
    if (this.closed || !entry || entry.ref.id !== expectedRunId) return Promise.resolve('not_started');
    const task = this.dispatch.interrupt(entry.ref, authorization);
    this.jobs.add(task);
    void task.finally(() => this.jobs.delete(task)).catch(() => {});
    return task;
  }
  interruptMessage(input: SdkMessageStopRequest, authority?: ApplicationCommandScope) {
    const request = { ...input }, entry = this.entries.get(request.key);
    const task = dispatchSdkMessageStop(request, { owner: this.options.owner, runtime: this.options.runtime, authority,
      kind: 'compact', ref: entry ? { ...entry.ref } : null,
      available: ref => !this.closed && !this.failed && (this.options.controlReady ?? this.options.ready)() === true
        && !!entry && !entry.closed && this.entries.get(ref.key) === entry && sameSdkCompactRef(entry.ref, ref),
      interrupt: execution => this.original(execution).worker.interrupt(),
      ...(this.options.diagnostics ? { diagnostics: this.options.diagnostics } : {}) });
    this.jobs.add(task);
    void task.finally(() => this.jobs.delete(task)).catch(() => {});
    return task;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.pause();
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.closing = (async () => {
      while (this.jobs.size || this.controls.size) await Promise.allSettled([...this.jobs, ...this.controls]);
      if (this.failed || this.entries.size) throw Error('SDK compact cleanup could not be confirmed');
    })();
    return this.closing;
  }
}
