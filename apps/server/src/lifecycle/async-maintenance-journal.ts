import { snapshotMaintenanceJournalRequest, maintenanceJournalPendingBytes, MaintenanceJournalInputConflict } from './maintenance-journal-protocol.js';
import { Worker } from 'node:worker_threads';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { createSqlOwnerFailureReceiver } from '../storage/sql-owner-failure-relay.js';
import { isDeepStrictEqual } from 'node:util';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { validMaintenanceJob, type MaintenanceJob, type MaintenanceOperation } from './connector-maintenance.js';
import { MaintenanceConflict } from './maintenance-journal.js';
import type { UnstartedPreparationProof, SupersededPreFenceProof } from './maintenance-reconciliation.js';
import type { RecoveredReadinessProof } from './maintenance-recovery-reconciliation.js';
import { validMaintenanceConnectionObservation, type MaintenanceConnectionObservation, type MaintenanceRecoveryObservation } from './maintenance-recovery.js';

export class MaintenanceJournalUnavailable extends Error {
  constructor() { super('Maintenance journal owner unavailable; inspect the original receipt'); }
}
type ReconciliationKind = 'cancelUnstartedPreparation' | 'cancelSupersededObservation' | 'completeRecoveredReadiness';
type Kind = 'get' | 'unresolved' | 'enqueue' | 'compareAndSwap' | 'observe' | 'close' | ReconciliationKind;
const rpcSteps: Record<Kind, number> = { get: 1, unresolved: 2, enqueue: 3, compareAndSwap: 4,
  cancelUnstartedPreparation: 5, cancelSupersededObservation: 6, completeRecoveredReadiness: 7, observe: 8, close: 9 };
export type MaintenanceJournalOwnerConfig = { file: string; dev: number; ino: number; readOnly?: boolean;
  reconciliation?: { nodeId: string; tokenFile: string; operations: readonly MaintenanceOperation[] } };
const reconciles = (kind: Kind): kind is ReconciliationKind =>
  ['cancelUnstartedPreparation', 'cancelSupersededObservation', 'completeRecoveredReadiness'].includes(kind);
type Waiter = { kind: Kind; args: unknown[]; acknowledged: boolean;
  resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** One worker owns opening, FULL transactions and closing the independent DB.
 * Unknown transport outcomes permanently halt this writer. After confirmed
 * exit, explicit observations may use one read-only owner of the same inode.
 * This never revives writer admission, resends a command or replays an effect. */
export class AsyncMaintenanceJournal {
  private readonly ownerConfig: MaintenanceJournalOwnerConfig;
  private stoppedReader: AsyncMaintenanceJournal | undefined;
  private sequence = 0;
  private failed = false;
  // Same fixed reason map as the read-only observer, but this owner's original
  // mutations remain unknown until durable receipts are inspected. Exit logs
  // never assert COMMIT or grant writer replacement/replay authority.
  private failureCode: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | undefined;
  private closing: Promise<void> | undefined;
  private shutdownClosing: Promise<void> | undefined;
  private observing: Promise<MaintenanceConnectionObservation> | undefined;
  private readonly reading = new Map<string, Promise<MaintenanceJob | undefined>>();
  private readonly unresolvedReading = new Map<string, Promise<MaintenanceJob | undefined>>();
  private readonly pending = new Map<number, Waiter>();
  private readonly accepted = new Set<Promise<unknown>>();
  private acceptedBytes = 0;
  get metadataUsage() { return { bytes: this.acceptedBytes, limit: maintenanceJournalPendingBytes }; }
  private readonly worker: Worker;
  private readonly originalStop: ReturnType<typeof createOriginalWorkerStop>;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private exitConfirmed = false;
  private closeAcknowledged = false;
  private closeExitFailed = false;
  private readonly receiveFailure: ReturnType<typeof createSqlOwnerFailureReceiver>;
  constructor(config: MaintenanceJournalOwnerConfig,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly onFailure: () => void = () => {},
    launch?: () => Worker, private readonly timeoutMs = 30_000) {
    this.receiveFailure = createSqlOwnerFailureReceiver('maintenance', diagnostics);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new MaintenanceJournalUnavailable();
    this.ownerConfig = { file: config.file, dev: config.dev, ino: config.ino, readOnly: config.readOnly === true,
      ...(config.reconciliation ? { reconciliation: { ...config.reconciliation, operations: [...config.reconciliation.operations] } } : {}) };
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './maintenance-journal-worker.ts' : './maintenance-journal-worker.js', import.meta.url);
    this.worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      ...this.ownerConfig, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    this.originalStop = createOriginalWorkerStop(this.worker, () => this.observeOwner(3, this.pending.size, 9));
    // Install before startup/failure listeners can request termination.
    this.exited = new Promise<void>(resolve => {
      this.worker.once('exit', code => {
        const pending = this.pending.size;
        this.exitConfirmed = true;
        this.originalStop.confirmExit();
        if (!this.failed && (!this.closing || pending > 0 || !this.closeAcknowledged || code !== 0)) this.fail(false, 3);
        resolve();
        this.observeOwner(2, pending, this.failureCode);
      });
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(true, 1); reject(new MaintenanceJournalUnavailable()); }, timeoutMs);
      const settled = () => clearTimeout(timer);
      const initialError = () => { settled(); this.fail(false, 2); reject(new MaintenanceJournalUnavailable()); };
      this.worker.once('error', initialError); this.worker.once('exit', initialError);
      const initialMessage = (message: unknown) => {
        if (this.receiveFailure(message)) return;
        this.worker.off('message', initialMessage);
        settled(); this.worker.off('error', initialError); this.worker.off('exit', initialError);
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || Object.keys(message).length !== 1 || (message as { kind?: unknown }).kind !== 'ready') {
          this.fail(false, 4); reject(new MaintenanceJournalUnavailable()); return;
        }
        this.worker.on('message', value => this.receive(value)); resolve();
      };
      this.worker.on('message', initialMessage);
    });
    // No unhandled rejection when an owner dies before its first request.
    void this.ready.catch(() => {});
    this.worker.on('error', () => this.fail(false, 2));
  }
  get unavailable() { return this.failed; }
  snapshot() {
    return { scope: 'process' as const, pending: this.pending.size, accepted: this.accepted.size,
      unavailable: this.failed, closing: !!this.closing, ownerExitConfirmed: this.exitConfirmed };
  }
  private terminate() {
    // Existing retirement policy only: never stop a healthy writer, resend
    // SQL or revive admission. Preserve unknown outcomes until receipts are
    // inspected after actual exit. A refusal may retry this exact cleanup.
    if (!this.failed || this.exitConfirmed) return;
    this.originalStop.request();
  }
  private observeOwner(step: 1 | 2 | 3, pending: number, failureCode?: number, timedOut = false) {
    try {
      const trace = this.diagnostics.start('maintenance-journal-owner');
      trace.add('step', step); trace.add('pending', pending);
      if (failureCode !== undefined) trace.add('ownerFailureCode', failureCode);
      if (step !== 2) trace.add('unknown', 1);
      if (timedOut) trace.add('timedOut', 1);
      trace.finish(failureCode !== undefined);
    } catch { /* Logs are not settlement, release or reconciliation authority. */ }
  }
  private fail(timedOut = false, failureCode: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 = timedOut ? 5 : 4) {
    if (this.failed) return;
    if (this.closing) this.closeExitFailed = true;
    this.failed = true;
    this.failureCode = failureCode;
    const pending = this.pending.size;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new MaintenanceJournalUnavailable()); }
    this.pending.clear();
    // Install first cause and reject original waiters before a diagnostic sink
    // or onFailure hook can synchronously reenter the owner's lifecycle.
    this.observeOwner(1, pending, failureCode, timedOut);
    try { this.onFailure(); } catch {}
    this.terminate();
  }
  private receive(message: unknown) {
    if (this.receiveFailure(message)) return;
    if (this.failed) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail(); return; }
    const r = message as { id?: number; kind?: Kind; ok?: boolean; value?: unknown; conflict?: boolean };
    const waiter = r && Number.isSafeInteger(r.id) ? this.pending.get(r.id!) : undefined;
    if (!r || !waiter || r.kind !== waiter.kind || typeof r.ok !== 'boolean'
      || Object.keys(r).some(key => !(r.ok ? ['id', 'kind', 'ok', 'value'] : ['id', 'kind', 'ok', 'conflict']).includes(key))) { this.fail(); return; }
    if (r.ok) {
      const valid = r.kind === 'observe' ? validMaintenanceConnectionObservation(r.value)
        : r.kind === 'close' ? r.value === undefined : r.kind === 'compareAndSwap' ? typeof r.value === 'boolean'
        : r.value === undefined ? r.kind !== 'enqueue' : validMaintenanceJob(r.value);
      if (!valid) { this.fail(); return; }
      if (validMaintenanceJob(r.value)) {
        const job = r.value;
        const matches = r.kind === 'get' ? job.id === waiter.args[0]
          : r.kind === 'unresolved' ? job.nodeId === waiter.args[0] && !['succeeded', 'cancelled'].includes(job.stage)
          : r.kind === 'enqueue' ? ['version', 'id', 'nodeId', 'actorId', 'operation', 'createdAt', 'deadline', 'archiveBootstrap']
            .every(key => isDeepStrictEqual(job[key as keyof MaintenanceJob], (waiter.args[0] as MaintenanceJob)[key as keyof MaintenanceJob]))
          : reconciles(r.kind!) ? isDeepStrictEqual(job, reconciliationResult(waiter.args[0] as MaintenanceJob, r.kind!)) : false;
        if (!matches) { this.fail(); return; }
      }
    } else if (typeof r.conflict !== 'boolean' || r.value !== undefined) { this.fail(); return; }
    // Only a fully validated reply proves settlement, including SQL refusal.
    // Keep this evidence on the original waiter after removal from pending.
    waiter.acknowledged = true;
    this.pending.delete(r.id!); clearTimeout(waiter.timer);
    if (r.ok) {
      if (r.kind === 'close') this.closeAcknowledged = true;
      waiter.resolve(r.value);
    }
    else {
      waiter.reject(r.conflict ? new MaintenanceConflict() : new MaintenanceJournalUnavailable());
      // A read-only owner cannot repeatedly query a damaged/replaced receipt
      // source. A negative close ACK also retires this exact owner before an
      // immediately following exit can overwrite its settled SQL cause.
      // Neither refusal grants replacement or replay authority.
      if (this.ownerConfig.readOnly || r.kind === 'close') this.fail(false, 10);
    }
  }
  private request(kind: Kind, args: unknown[]): Promise<unknown> {
    const refused = (conflict = false) => {
      const trace = guardedTrace(this.diagnostics, 'maintenance-journal-rpc');
      trace.add('step', rpcSteps[kind]);
      trace.add('pending', this.accepted.size); trace.add('sourceBytes', this.acceptedBytes); trace.add('deferred', 1); trace.finish(true);
      // No dispatch or SQL has occurred. This known refusal must not be
      // confused with the unknown outcome of an already transmitted command.
      return Promise.reject(conflict ? new MaintenanceConflict() : new MaintenanceJournalUnavailable());
    };
    const unavailable = () => this.failed || this.closing && kind !== 'close' || this.accepted.size >= 256
      || this.acceptedBytes >= maintenanceJournalPendingBytes
      || this.ownerConfig.readOnly === true && !['get', 'unresolved', 'observe', 'close'].includes(kind);
    // Refuse before inspecting caller-owned data: a full/closed owner cannot
    // allocate an arbitrary snapshot or invoke its getters. Recheck after the
    // synchronous clone too; a getter may have closed or filled this owner.
    if (unavailable()) return refused();
    let snapshot: unknown[], bytes: number;
    try { const metadata = snapshotMaintenanceJournalRequest(kind, args); snapshot = metadata.args; bytes = metadata.bytes; }
    catch (error) { return refused(error instanceof MaintenanceJournalInputConflict); }
    if (unavailable() || this.acceptedBytes + bytes > maintenanceJournalPendingBytes) return refused();
    // Snapshot and capacity reservation remain before the first await,
    // including when worker startup is pending.
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const work = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    // Publish original admission BEFORE diagnostics or any other synchronous
    // callback can close/reenter. Close must capture this exact retained work.
    this.accepted.add(work); this.acceptedBytes += bytes;
    // Every accepted SQL command can change the original connection's
    // recovery state, including a read that attempts a retained rollback.
    // Observation sharing is valid only until that next command. Preserve
    // the original flight for its callers, but do not let later observers
    // inherit a pre-command ready/fenced snapshot. Refusals above leave it.
    if (kind !== 'observe') this.observing = undefined;
    // A subsequently admitted receipt read must queue behind this mutation,
    // never join a pre-mutation SQL snapshot. Refused writes do not change the
    // original read, and an old flight's cleanup cannot erase a newer flight.
    if (kind !== 'get' && kind !== 'unresolved' && kind !== 'observe') {
      this.reading.clear(); this.unresolvedReading.clear();
    }
    const release = () => { if (this.accepted.delete(work)) this.acceptedBytes -= bytes; };
    void work.then(release, release);
    try { void this.dispatch(kind, snapshot).then(resolve, reject); }
    catch (error) { reject(error); }
    return work;
  }
  private async dispatch(kind: Kind, snapshot: unknown[]): Promise<unknown> {
    const trace = guardedTrace(this.diagnostics, 'maintenance-journal-rpc');
    trace.add('step', rpcSteps[kind]);
    const at = performance.now(); let failed = true, waiter: Waiter | undefined;
    try {
      await this.ready;
      if (this.failed) throw new MaintenanceJournalUnavailable();
      trace.add('queueMs', performance.now() - at); trace.add('pending', this.pending.size);
      if (this.sequence === Number.MAX_SAFE_INTEGER) { this.fail(false, 7); throw new MaintenanceJournalUnavailable(); }
      const id = ++this.sequence;
      const value = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(true, kind === 'close' ? 8 : 5), this.timeoutMs);
        waiter = { kind, args: snapshot, acknowledged: false, resolve, reject, timer };
        this.pending.set(id, waiter);
        try { this.worker.postMessage({ id, kind, args: snapshot }); } catch { this.fail(false, 6); }
      });
      if (reconciles(kind)) {
        trace.add('changed', Number(value !== undefined));
        if (kind === 'completeRecoveredReadiness' && value !== undefined) trace.add('recovered', 1);
      }
      failed = false; return value;
    } finally {
      trace.add(waiter?.acknowledged ? 'settled' : waiter ? 'unknown' : 'deferred', 1);
      trace.finish(failed);
    }
  }
  async get(id: string): Promise<MaintenanceJob | undefined> {
    return this.read('get', id, this.reading);
  }
  private async read(kind: 'get' | 'unresolved', id: string, flights: Map<string, Promise<MaintenanceJob | undefined>>) {
    // Share only identical in-flight reads in the same mutation epoch. Never
    // cache settled receipts, unresolved ownership or authority. Distinct
    // reads still consume the existing 256-request bound before any await.
    if (this.failed || this.closing || typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      return await this.request(kind, [id]) as MaintenanceJob | undefined;
    }
    let flight = flights.get(id);
    if (!flight) {
      if (this.accepted.size >= 256) return await this.request(kind, [id]) as MaintenanceJob | undefined;
      let resolve!: (value: MaintenanceJob | undefined) => void, reject!: (error: unknown) => void;
      flight = new Promise<MaintenanceJob | undefined>((yes, no) => { resolve = yes; reject = no; });
      flights.set(id, flight);
      const original = flight;
      const clear = () => { if (flights.get(id) === original) flights.delete(id); };
      void flight.then(clear, clear);
      try { void this.request(kind, [id]).then(value => resolve(value as MaintenanceJob | undefined), reject); }
      catch (error) { reject(error); }
    }
    // A caller cannot rewrite another observer's nested original receipt.
    return structuredClone(await flight);
  }
  async observe(): Promise<MaintenanceConnectionObservation> {
    // Join only in-flight observation with no intervening accepted command.
    // Joining in-flight read-only work does not allocate another SQL command.
    // It is NOT a readiness cache, and does not waive closed-owner admission.
    if (this.failed || this.closing) return await this.request('observe', []) as MaintenanceConnectionObservation;
    let flight = this.observing;
    if (!flight) {
      let resolve!: (value: MaintenanceConnectionObservation) => void, reject!: (error: unknown) => void;
      flight = new Promise<MaintenanceConnectionObservation>((yes, no) => { resolve = yes; reject = no; });
      this.observing = flight;
      const original = flight;
      const clear = () => { if (this.observing === original) this.observing = undefined; };
      void flight.then(clear, clear);
      try { void this.request('observe', []).then(value => resolve(value as MaintenanceConnectionObservation), reject); }
      catch (error) { reject(error); }
    }
    // Consumers cannot rewrite another caller's original worker observation.
    return { ...await flight };
  }
  async recovery(): Promise<MaintenanceRecoveryObservation> {
    let connection: MaintenanceRecoveryObservation['connection'] = { state: 'unobserved' };
    if (!this.failed && !this.closing) {
      try { connection = await this.observe(); } catch { /* Local state stays readable; never invent a ready owner. */ }
    }
    const transport = this.snapshot();
    if (transport.unavailable || transport.closing) connection = { state: 'unavailable' };
    return { scope: 'maintenance-journal', transport, connection };
  }
  async unresolved(nodeId: string) { return this.read('unresolved', nodeId, this.unresolvedReading); }
  /** Explicit receipt inspection, not reconnection of the original writer.
   * No owner starts before original exit and accepted-request settlement.
   * The first read-only failure remains latched; no repair/replacement loop. */
  async inspectStopped(kind: 'get' | 'unresolved', key: string): Promise<MaintenanceJob | undefined> {
    const trace = guardedTrace(this.diagnostics, 'maintenance-stopped-receipt');
    trace.add('step', kind === 'get' ? 1 : 2);
    let failed = true;
    try {
      if (!this.failed || !this.exitConfirmed || this.closing || this.accepted.size
        || this.ownerConfig.readOnly || !['get', 'unresolved'].includes(kind)
        || typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
        trace.add('deferred', 1); throw new MaintenanceJournalUnavailable();
      }
      if (!this.stoppedReader) {
        const { file, dev, ino } = this.ownerConfig;
        this.stoppedReader = new AsyncMaintenanceJournal({ file, dev, ino, readOnly: true }, this.diagnostics,
          () => {}, undefined, this.timeoutMs);
      }
      const result = await (kind === 'get' ? this.stoppedReader.get(key) : this.stoppedReader.unresolved(key));
      if (this.closing) { trace.add('deferred', 1); throw new MaintenanceJournalUnavailable(); }
      trace.add('settled', 1); failed = false;
      return result;
    } finally { trace.finish(failed); }
  }
  async enqueue(job: MaintenanceJob) { return await this.request('enqueue', [job]) as MaintenanceJob; }
  async compareAndSwap(previous: MaintenanceJob, next: MaintenanceJob) { return await this.request('compareAndSwap', [previous, next]) as boolean; }
  async cancelUnstartedPreparation(previous: MaintenanceJob, proof: UnstartedPreparationProof, at: number) {
    return await this.request('cancelUnstartedPreparation', [previous, proof, at]) as MaintenanceJob | undefined;
  }
  async cancelSupersededObservation(previous: MaintenanceJob, proof: SupersededPreFenceProof, at: number) {
    return await this.request('cancelSupersededObservation', [previous, proof, at]) as MaintenanceJob | undefined;
  }
  async completeRecoveredReadiness(previous: MaintenanceJob, proof: RecoveredReadinessProof, at: number) {
    return await this.request('completeRecoveredReadiness', [previous, proof, at]) as MaintenanceJob | undefined;
  }
  async open() { await this.ready; if (this.failed) throw new MaintenanceJournalUnavailable(); }
  /** Physical shutdown proof only, not a successful SQL close/COMMIT ACK.
   * Keep close()'s original result unchanged. The host has already stopped
   * admissions and drained effects; it may release these exact resources only
   * after every retained worker has actually exited and original calls settled.
   * Never replace a writer or replay an unknown command through this method. */
  closeForShutdown(): Promise<void> {
    if (this.shutdownClosing) return this.shutdownClosing;
    let original: Promise<void>;
    try { original = this.close(); } catch (error) { original = Promise.reject(error); }
    const attempt = original.catch(error => {
      if (!this.allOwnersExited()) throw error;
    });
    this.shutdownClosing = attempt;
    void attempt.catch(() => {
      if (this.shutdownClosing === attempt) this.shutdownClosing = undefined;
    });
    return attempt;
  }
  private allOwnersExited(): boolean {
    return !!this.closing && this.exitConfirmed && this.pending.size === 0 && this.accepted.size === 0
      && (!this.stoppedReader || this.stoppedReader.allOwnersExited());
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await Promise.allSettled([...this.accepted]);
      let readerCloseFailed = false;
      if (this.stoppedReader) {
        try { await this.stoppedReader.close(); } catch { readerCloseFailed = true; }
      }
      // A well-formed negative close ACK is a settled SQL refusal, not a
      // malformed transport response. Earlier transport failures retain their
      // first cause; neither kind of rejection proves owner exit.
      if (!this.failed) { try { await this.request('close', []); } catch { this.fail(false, 10); } }
      // Successful close ACK means the worker closes its port and exits itself.
      // Terminating it here could turn a normal exit into a forced nonzero exit.
      if (this.failed) this.terminate();
      const timer = setTimeout(() => {
        this.closeExitFailed = true; this.fail(true, 8);
      }, this.timeoutMs);
      try { await this.exited; } finally { clearTimeout(timer); }
      if (this.closeExitFailed || readerCloseFailed) throw new MaintenanceJournalUnavailable();
    })();
    return this.closing;
  }
}

function reconciliationResult(previous: MaintenanceJob, kind: ReconciliationKind): MaintenanceJob {
  const next: MaintenanceJob = { ...previous, revision: previous.revision + 1,
    stage: kind === 'completeRecoveredReadiness' ? 'succeeded' : 'cancelled' };
  delete next.reason; delete next.failedStage; delete next.failureCode; delete next.observationRetry;
  return next;
}
