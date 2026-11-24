import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { types } from 'node:util';
import type { StorageWorkClass } from "./work-admission.js";
import { StorageAdmissionDeferred } from "./work-admission.js";
import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from "../diagnostics/performance.js";
import { createOriginalWorkerStop } from "./original-worker-stop.js";
import { isStorageFull } from "./storage-pressure.js";
import { isVolumeAdmissionReason } from './volume-admission-refusal.js';

/** A single background owner for asynchronous IO admission. Only ledger work
 * crosses the boundary: the authorized writer stays in its original process.
 * Dead protocol waits are bounded; only future requests may use a replacement
 * owner after confirmed termination and writer quiescence. No callback replay
 * or unrelated crashed-lease reclamation is permitted. */
export class AsyncVolumeAdmission {
  private worker: Worker | undefined;
  private originalStop: ReturnType<typeof createOriginalWorkerStop> | undefined;
  private unavailable = false;
  private stopped = false;
  private retiring = false;
  private failedAt = 0;
  private sequence = 0;
  // Includes calls waiting at the recovery barrier, before a writer lease can
  // be admitted. These slots are NOT live writers or reconciliation authority.
  private acceptedRequests = 0;
  // A user deadline ends ONLY the unstarted request. Detached readonly IO
  // still consumes a separate budget until its original Promise settles.
  private pendingVolumeSamples = 0;
  private readonly pending = new Map<number, { kind: 'begin' | 'finish' | 'reconcile'; timer: ReturnType<typeof setTimeout>; resolve(volume?: string): void; reject(error: Error): void }>();
  private readonly leases = new Set<string>();
  private readonly recovery = new Map<string, { root: string; volume: string; full: boolean;
    unstarted?: true; workClass?: StorageWorkClass; bytes?: number }>();
  private reconciliation: Promise<void> | undefined;
  constructor(private readonly launch = () => {
    // tsImport namespaces nested worker modules with a query string. Detect
    // the file extension, not the full URL, or a source owner launches missing JS.
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './volume-admission-worker.ts' : './volume-admission-worker.js', import.meta.url);
    // Source tests/dev need the repository's loader; compiled production does
    // not import tsx or inherit arbitrary parent exec flags/environment dumps.
    const loader = source ? import.meta.resolve('tsx/esm/api') : undefined;
    return new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) {
        const { tsImport } = await import(workerData.loader);
        await tsImport(workerData.entry, workerData.entry);
      } else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: { entry: entry.href, loader } });
  }, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  private readonly policy: { requestTimeoutMs?: number; recoveryDelayMs?: number; stallWarningMs?: number } = {},
  private readonly bindVolume: (root: string) => string | Promise<string> = async root => String((await stat(root, { bigint: true })).dev)) {
    for (const value of [policy.requestTimeoutMs ?? 30_000, policy.recoveryDelayMs ?? 1000, policy.stallWarningMs ?? 30_000]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new RangeError('Invalid coordinator recovery policy');
    }
  }
  /** Process-local observation only: never launches or repairs an owner. */
  snapshot() {
    const cooldownMs = this.unavailable
      ? Math.max(0, Math.ceil((this.policy.recoveryDelayMs ?? 1000) - (performance.now() - this.failedAt))) : 0;
    const blockedBy = !this.unavailable ? null : !this.stopped ? 'owner-exit'
      : this.leases.size ? 'active-writers' : cooldownMs ? 'cooldown' : this.recovery.size ? 'exact-proof-reconciliation' : 'next-request';
    return { scope: 'process' as const,
      status: this.unavailable ? 'unavailable' as const : this.reconciliation ? 'reconciling' as const : this.worker ? 'ready' as const : 'idle' as const,
      pending: this.pending.size, acceptedRequests: this.acceptedRequests, pendingVolumeSamples: this.pendingVolumeSamples,
      activeWriters: this.leases.size, recoveryProofs: this.recovery.size,
      ownerExitConfirmed: this.stopped, cooldownMs, blockedBy };
  }
  private owner() {
    let recovering = false;
    if (this.unavailable && this.stopped && !this.retiring && !this.leases.size &&
      performance.now() - this.failedAt >= (this.policy.recoveryDelayMs ?? 1000)) {
      this.unavailable = false; this.stopped = false; this.worker = undefined;
      recovering = true;
    }
    if (this.unavailable) throw new StorageAdmissionDeferred('coordinator-unavailable');
    if (!this.worker) {
      let worker: Worker;
      try { worker = this.launch(); }
      catch { this.fail(); throw new StorageAdmissionDeferred('coordinator-unavailable'); }
      this.worker = worker;
      const stop = createOriginalWorkerStop(worker, () => {
        const trace = guardedTrace(this.diagnostics, 'storage-coordinator-recovery');
        trace.add('step', 5); trace.add('unknown', 1); trace.finish(true);
      });
      this.originalStop = stop;
      worker.on('message', (message: unknown) => {
        if (this.worker !== worker || this.unavailable) return;
        const value = message as { id?: unknown; kind?: unknown; ok?: unknown; reason?: unknown; volume?: unknown } | null;
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || !Number.isSafeInteger(value.id) || typeof value.ok !== 'boolean'
          || Object.keys(value).some(key => !(value.ok ? ['id', 'kind', 'ok', 'volume'] : ['id', 'kind', 'ok', 'reason']).includes(key))
          || (value.reason !== undefined && !isVolumeAdmissionReason(value.reason))) { this.fail(); return; }
        if (value.volume !== undefined && (typeof value.volume !== 'string' || !/^[0-9]{1,32}$/.test(value.volume))) { this.fail(); return; }
        const waiter = this.pending.get(value.id as number);
        if (!waiter || value.kind !== waiter.kind || (value.volume !== undefined && waiter.kind !== 'begin')) { this.fail(); return; }
        this.pending.delete(value.id as number);
        clearTimeout(waiter.timer);
        if (value.ok) waiter.resolve(value.volume as string | undefined);
        else {
          const reason = typeof value.reason === 'string' ? value.reason : 'coordinator-unavailable';
          // A sanitized owner failure does not prove that BEGIN/COMMIT never
          // happened. Fence this generation BEFORE the rejected begin settles,
          // so its exact prebound, never-invoked proof survives in run(). Known
          // admission denials remain reusable and do not acquire recovery rights.
          if (reason === 'coordinator-unavailable') this.fail();
          waiter.reject(new StorageAdmissionDeferred(reason));
        }
        this.reference();
      });
      worker.on('error', () => { if (this.worker === worker) this.fail(); });
      worker.on('exit', () => {
        stop.confirmExit();
        if (this.worker === worker) { this.stopped = true; this.fail(); }
      });
      worker.unref();
      if (recovering) {
        const trace = guardedTrace(this.diagnostics, 'storage-coordinator-recovery');
        trace.add('step', 1); trace.add('recovered', 1); trace.finish();
      }
    }
    return this.worker;
  }
  private reference() {
    if (this.pending.size || this.leases.size) this.worker?.ref(); else this.worker?.unref();
  }
  private fail(timedOut = false) {
    if (this.unavailable) return;
    this.unavailable = true;
    this.retiring = true;
    const worker = this.worker, stop = this.originalStop;
    const pending = this.pending.size, writers = this.leases.size;
    try {
      this.failedAt = performance.now();
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new StorageAdmissionDeferred('coordinator-unavailable'));
      }
      this.pending.clear(); worker?.unref();
      if (!worker) this.stopped = true;
      // Original physical cleanup only; pending/fulfilled is NOT exit proof.
      // Capture the generation before any stop/log callback can reenter.
      else if (!this.stopped) stop?.request();
    } finally { this.retiring = false; }
    // Publish after all original-generation cleanup. A slow/reentrant sink
    // can now admit a replacement only after exit/quiescence/cooldown proofs;
    // this retired generation cannot clear or terminate that replacement.
    const trace = guardedTrace(this.diagnostics, 'storage-coordinator-recovery');
    trace.add('step', 1);
    trace.add('pending', pending); trace.add('unknown', writers);
    if (timedOut) trace.add('timedOut', 1);
    trace.finish(true);
    // Started receipts remain charged in SQLite, including lost begin ACKs.
  }
  private request(id: number, message: { kind: 'begin'; root: string; workClass: StorageWorkClass; bytes: number; lease: string; volume: string } |
    { kind: 'finish'; full: boolean } | { kind: 'reconcile'; root: string; lease: string; volume: string; full: boolean;
      unstarted?: true; workClass?: StorageWorkClass; bytes?: number }) {
    const worker = this.owner();
    return new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(true), this.policy.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { kind: message.kind, timer, resolve, reject }); this.reference();
      try { worker.postMessage({ ...message, id }); }
      catch { this.fail(); }
    });
  }
  private recover() {
    if (this.reconciliation) return this.reconciliation;
    let resolveBarrier!: () => void, rejectBarrier!: (reason: unknown) => void;
    const barrier = new Promise<void>((resolve, reject) => { resolveBarrier = resolve; rejectBarrier = reject; });
    // Publish before request()/postMessage(): transport adapters can reenter.
    this.reconciliation = barrier;
    const work = (async () => {
      for (const [lease, proof] of this.recovery) {
        if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new StorageAdmissionDeferred('coordinator-capacity');
        try { await this.request(++this.sequence, { kind: 'reconcile', lease, ...proof }); }
        catch (error) { this.fail(); throw error; }
        this.recovery.delete(lease);
      }
    })();
    void work.then(resolveBarrier, rejectBarrier);
    // Cleanup only this original barrier; never clear another owner's proof.
    void barrier.then(
      () => { if (this.reconciliation === barrier) this.reconciliation = undefined; },
      () => { if (this.reconciliation === barrier) this.reconciliation = undefined; }
    );
    return barrier;
  }
  private sampleVolume(root: string, trace: PerformanceTrace): string | Promise<string> {
    if (this.pendingVolumeSamples >= 256) throw new StorageAdmissionDeferred('coordinator-capacity');
    // Reserve before invoking IO, including synchronous/reentrant adapters.
    this.pendingVolumeSamples++;
    let binding: string | Promise<string>;
    try { binding = this.bindVolume(root); }
    catch (error) { this.pendingVolumeSamples--; throw error; }
    if (typeof binding === 'string') { this.pendingVolumeSamples--; return binding; }
    if (!types.isPromise(binding)) {
      this.pendingVolumeSamples--;
      // Do not execute arbitrary thenable getters or callback protocols.
      throw new StorageAdmissionDeferred('volume-changed');
    }
    return new Promise<string>((resolve, reject) => {
      let ended = false;
      const timer = setTimeout(() => {
        ended = true; trace.add('timedOut', 1);
        reject(new StorageAdmissionDeferred('volume-sample-timeout'));
      }, this.policy.requestTimeoutMs ?? 30_000);
      const settled = () => { clearTimeout(timer); this.pendingVolumeSamples--; };
      // Observe BOTH original outcomes even after the deadline; neither late
      // result may resume begin/writer or create an unstarted recovery proof.
      // Native then ignores a Promise's own then getter. If observation itself
      // cannot attach, conservatively retain its budget: no settlement proof.
      try {
        void Promise.prototype.then.call(binding, (value: string) => {
          settled(); if (!ended) { ended = true; resolve(value); }
        }, (error: unknown) => {
          settled(); if (!ended) { ended = true; reject(error); }
        });
      } catch (error) { clearTimeout(timer); ended = true; reject(error); }
    });
  }
  async run<T>(root: string, workClass: StorageWorkClass, bytes: number, write: () => Promise<T>): Promise<T> {
    // Reserve before ANY await, including original-proof reconciliation. The
    // writer-only bound below cannot limit callers parked at that barrier.
    // Do not insert a lease early: recovery still needs actual writer quiescence.
    if (this.acceptedRequests >= 256 || this.pendingVolumeSamples >= 256) {
      const trace = guardedTrace(this.diagnostics, 'async-storage-admission');
      trace.add('pending', Math.max(this.acceptedRequests, this.pendingVolumeSamples));
      trace.add('step', this.pendingVolumeSamples >= 256 ? 5 : 1);
      trace.add('deferred', 1); trace.finish(true);
      throw new StorageAdmissionDeferred('coordinator-capacity');
    }
    this.acceptedRequests++;
    try { return await this.runAccepted(root, workClass, bytes, write); }
    finally { this.acceptedRequests--; }
  }
  private async runAccepted<T>(root: string, workClass: StorageWorkClass, bytes: number, write: () => Promise<T>): Promise<T> {
    const trace = guardedTrace(this.diagnostics, 'async-storage-admission');
    trace.add('pending', this.leases.size);
    // Fixed numeric phases: 1 original-proof reconciliation, 2 begin ACK,
    // 3 original writer, 4 finish ACK, 5 asynchronous physical-volume binding.
    // Observation cannot settle the writer,
    // end its lease, replace an owner or grant reconciliation authority.
    let step = 1;
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step }), this.policy.stallWarningMs ?? 30_000);
    warning.unref();
    const finish = (failed: boolean) => { clearTimeout(warning); trace.finish(failed); };
    // Recovery must be checked BEFORE adding this new lease. It never resumes
    // an old call, and cannot replace an owner while any old writer is active.
    try { this.owner(); } catch (error) { trace.add('deferred', 1); finish(true); throw error; }
    if (this.recovery.size || this.reconciliation) {
      try { await this.recover(); }
      catch (error) { trace.add('deferred', 1); finish(true); throw error; }
    }
    if (this.leases.size >= 256 || this.sequence >= Number.MAX_SAFE_INTEGER) {
      trace.add('deferred', 1); finish(true);
      throw new StorageAdmissionDeferred('coordinator-capacity');
    }
    const lease = `transient-${randomUUID()}`; this.leases.add(lease);
    let id = 0;
    let volume: string | undefined;
    let started = false, beginAttempted = false, released = false, failed = false, full = false;
    let failureStep: number | undefined;
    try {
      step = 5;
      // Bind BEFORE the begin RPC, so a lost begin ACK cannot erase the
      // original physical-volume proof. Production sampling is asynchronous;
      // Sampling has its own original IO budget as well as this request slot.
      const sampleAt = performance.now();
      try {
        const binding = this.sampleVolume(root, trace);
        volume = typeof binding === 'string' ? binding : await binding;
      } finally { trace.add('sampleMs', performance.now() - sampleAt); }
      if (typeof volume !== 'string' || !/^[0-9]{1,32}$/.test(volume)) throw new StorageAdmissionDeferred('volume-changed');
      // Samples may resolve out of order. Allocate the protocol sequence only
      // at dispatch, with no intervening await. A lease still occupies its
      // bounded slot throughout sampling and cannot permit owner replacement.
      if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new StorageAdmissionDeferred('coordinator-capacity');
      id = ++this.sequence;
      step = 2;
      const queued = performance.now();
      try {
        beginAttempted = true;
        const acknowledged = await this.request(id, { kind: 'begin', root, workClass, bytes, lease, volume });
        if (acknowledged !== volume) { this.fail(); throw new StorageAdmissionDeferred('volume-changed'); }
      }
      finally { trace.add('queueMs', performance.now() - queued); }
      started = true; trace.add('admitted', 1);
      step = 3;
      const at = performance.now();
      try { return await write(); }
      finally { trace.add('bodyMs', performance.now() - at); }
    } catch (error) {
      failed = true; failureStep = step;
      // Capacity feedback is best effort, not a new error/settlement authority.
      // Getter/proxy failures must not obscure the original binding/writer
      // failure. Read once and never coerce arbitrary objects or SQLite codes.
      try {
        full = isStorageFull(error);
      } catch { trace.add('pressureUnknown', 1); }
      throw error;
    } finally {
      step = 4;
      const releaseAt = performance.now();
      try {
        // Only the settled writer releases. Losing an acknowledgment never
        // permits callback replay or releasing a potentially running writer.
        if (started) { await this.request(id, { kind: 'finish', full }); released = true; trace.add('settled', 1); }
      } catch (error) { this.fail(); const originalFailed = failed; failed = true;
        failureStep ??= step; if (!originalFailed) throw error; }
      finally {
        trace.add('releaseMs', performance.now() - releaseAt);
        if (this.unavailable || (started && !released)) trace.add('unknown', 1);
        if (!started && !this.unavailable) trace.add('deferred', 1);
        // Executed only after the original writer settles, or when it was
        // NEVER invoked. Missing begin ACK is reconciled only after actual
        // old-owner exit, against this prebound volume and exact payload.
        if (volume !== undefined && !released && (started || (beginAttempted && this.unavailable))) {
          this.recovery.set(lease, { root, volume, full,
            ...(!started ? { unstarted: true as const, workClass, bytes } : {}) });
        }
        trace.add('step', failureStep ?? step);
        this.leases.delete(lease); this.reference(); finish(failed);
      }
    }
  }
}

export const asyncVolumeAdmission = new AsyncVolumeAdmission();
