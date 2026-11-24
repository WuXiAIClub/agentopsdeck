import { guardedTrace } from '../diagnostics/guarded-trace.js';
import type { DatabaseSync } from 'node:sqlite';
import { statSync, statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { StorageWorkAdmission, StorageAdmissionDeferred, type StorageWorkClass } from './work-admission.js';
import { addSqlFailure } from './sql-failure-diagnostics.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { isStorageFull } from './storage-pressure.js';

const initializedPressureDatabases = new WeakSet<DatabaseSync>();

/** Local-process and same-UID cross-process admission on a shared filesystem.
 * st_dev chooses the volume, not a caller's arbitrary path label. SQLite must
 * live in the same private coordinator directory in all participating runtimes.
 * This is advisory admission, not a quota against unrelated writers. */
export class VolumeAdmission {
  private readonly ledger: StorageWorkAdmission;
  private readonly volume: string;
  private readonly pendingReleases = new Map<string, { workClass: StorageWorkClass; bytes: number }>();
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveringRelease = false;
  constructor(private readonly db: DatabaseSync, private readonly root: string, private readonly now = Date.now,
    private readonly sample = () => { const s = statfsSync(root, { bigint: true }); return s.bavail * s.bsize; },
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.volume = String(statSync(root, { bigint: true }).dev);
    // Admission and its original ledger transaction share the caller's sink.
    // Falling back to global diagnostics here loses BEGIN-refusal evidence
    // from the owner's local snapshot and bypasses its logging configuration.
    this.ledger = new StorageWorkAdmission(db, now, diagnostics);
    if (!initializedPressureDatabases.has(db)) {
      db.exec('CREATE TABLE IF NOT EXISTS storage_volume_pressure(volume TEXT PRIMARY KEY, denied_at INTEGER NOT NULL)');
      // A caller-owned transaction may roll back: its DDL is not a receipt.
      if (!db.isTransaction) initializedPressureDatabases.add(db);
    }
  }
  private pressured() { return this.db.prepare('SELECT denied_at FROM storage_volume_pressure WHERE volume=?').get(this.volume); }
  private deny() {
    // Strictly advance even when two failures share the same clock tick.
    // An older admission must not clear a newly reported pressure condition.
    this.db.prepare('INSERT INTO storage_volume_pressure VALUES(?,?) ON CONFLICT(volume) DO UPDATE SET denied_at=max(storage_volume_pressure.denied_at+1,excluded.denied_at)').run(this.volume, this.now());
  }
  /** The callback must resolve/reject only once ALL its writes are quiescent.
   * No timeout races, background writes, remote work or durable request replay.
   * A crashed process leaves a charged started lease: never expire it by age. */
  private acquire(workClass: StorageWorkClass, bytes: number, requestId?: string) {
    if (String(statSync(this.root, { bigint: true }).dev) !== this.volume) throw new StorageAdmissionDeferred('volume-changed');
    if (requestId !== undefined && !/^transient-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new StorageAdmissionDeferred('persistent-receipt');
    const id = requestId ?? `transient-${randomUUID()}`, pressure = this.pressured(), now = this.now();
    if (pressure && workClass !== 'recovery' && now - Number(pressure.denied_at) < 1000) throw new StorageAdmissionDeferred('pressure-backoff');
    // Hysteresis applies across processes. Recovery keeps its emergency floor
    // and bypasses backoff, but is not permitted to pretend space is unlimited.
    const margin = pressure && workClass !== 'recovery' ? 64n * 1024n ** 2n : 0n;
    try {
      const outcome = this.ledger.tryStartTransient(this.volume, id, workClass, bytes, () => {
        const sample = this.sample();
        return { freeBytes: sample > margin ? sample - margin : 0n, observedAt: this.now() };
      }, pressure && workClass !== 'recovery' ? Number(pressure.denied_at) : undefined);
      if (!outcome.started) return outcome;
    } catch (e) {
      try { if (e instanceof StorageAdmissionDeferred && e.message === 'insufficient-space') this.deny(); }
      catch { this.pressureUnknown(); }
      throw e;
    }
    return { started: true as const, id };
  }
  private failed(error: unknown) {
    // node:sqlite reports SQLite's numeric result separately from the generic
    // Node error code. Test against a genuinely full bounded SQLite database;
    // checking only a synthetic code='SQLITE_FULL' misses production failures.
    try {
      if (isStorageFull(error)) this.deny();
    } catch { this.pressureUnknown(); }
  }
  private pressureUnknown() {
    // No paths or error values; this records missing pressure feedback only,
    // not an unknown writer lifetime or permission to reclaim its capacity.
    const trace = guardedTrace(this.diagnostics, 'storage-admission');
    trace.add('pressureUnknown', 1); trace.finish(true);
  }
  private release(id: string, failed: boolean, expected: { workClass: StorageWorkClass; bytes: number }, writerFailed = failed) {
    // Uncertain bookkeeping intentionally leaks capacity; never reclaim a
    // potentially running/crashed writer merely by age.
    const trace = guardedTrace(this.diagnostics, 'storage-admission-release');
    const at = performance.now(); let releaseFailed = false;
    // The original writer is quiescent or was never invoked; this is NOT a
    // business COMMIT receipt or permission to replay it. step 1=returned,
    // 2=threw/rejected (including a failed pre-dispatch binding).
    trace.add('step', writerFailed ? 2 : 1); trace.add('settled', 1);
    try {
      const outcome = this.ledger.finishQuiescentTransient(this.volume, id, expected);
      if (!outcome.released) {
        if (this.pendingReleases.size + Number(this.recoveringRelease) < 128) {
          this.pendingReleases.set(id, { ...expected }); this.scheduleRelease(); trace.add('deferred', 1);
        }
        throw outcome.error;
      }
    }
    catch (e) {
      releaseFailed = true; trace.add('unknown', 1); addSqlFailure(trace, e);
      if (!failed) throw e;
    } finally {
      trace.add('releaseMs', performance.now() - at); trace.finish(releaseFailed);
    }
  }
  private scheduleRelease() {
    if (this.releaseTimer || this.recoveringRelease || !this.pendingReleases.size) return;
    this.releaseTimer = setTimeout(() => { this.releaseTimer = undefined; this.retryRelease(); }, 250);
    this.releaseTimer.unref();
  }
  private retryRelease() {
    const next = this.pendingReleases.entries().next().value;
    if (!next || this.recoveringRelease) return;
    const [id, expected] = next;
    this.recoveringRelease = true;
    // Move only a refused original attempt to the tail for bounded fairness.
    // No deadline, lease age, process replacement or business replay occurs.
    this.pendingReleases.delete(id);
    const trace = guardedTrace(this.diagnostics, 'storage-admission-release-recovery');
    trace.add('settled', 1); let failed = true;
    try {
      if (String(statSync(this.root, { bigint: true }).dev) !== this.volume) throw new StorageAdmissionDeferred('volume-changed');
      const outcome = this.ledger.finishQuiescentTransient(this.volume, id, expected);
      if (!outcome.released) {
        this.pendingReleases.set(id, expected); trace.add('pending', 1); trace.add('deferred', 1); addSqlFailure(trace, outcome.error);
      } else { trace.add('recovered', 1); failed = false; }
    } catch (error) {
      // Any uncertainty after BEGIN stops automatic retries. The charged row
      // remains protected; neither absence nor timer is a replay permission.
      trace.add('unknown', 1); addSqlFailure(trace, error);
    } finally {
      // Retain the reentrancy fence while the diagnostic sink runs.
      trace.finish(failed); this.recoveringRelease = false; this.scheduleRelease();
    }
  }
  /** Sole-owner synchronous SQLite maintenance; never accepts async work. */
  runSync<T>(workClass: StorageWorkClass, bytes: number, write: () => T extends PromiseLike<unknown> ? never : T): T {
    // Reject known async functions before their body can start. Runtime JS and
    // untyped callers still need a returned-value fence below.
    if (types.isAsyncFunction(write)) {
      const trace = guardedTrace(this.diagnostics, 'storage-sync-contract');
      trace.add('admitted', 0); trace.add('deferred', 1); trace.finish(true);
      throw new Error('Storage admission callback must be synchronous');
    }
    const acquisition = this.acquire(workClass, bytes);
    if (!acquisition.started) throw acquisition.error;
    const { id } = acquisition; let failed = false, retained = false;
    try {
      const value = write();
      const nativePromise = types.isPromise(value);
      // Mark uncertainty BEFORE inspecting user getters. A throwing getter is
      // not evidence that the original writer has stopped.
      retained = nativePromise;
      if (!nativePromise && value !== null && (typeof value === 'object' || typeof value === 'function')) {
        retained = true;
        try { retained = typeof (value as { then?: unknown }).then === 'function'; }
        catch (error) {
          const trace = guardedTrace(this.diagnostics, 'storage-sync-contract');
          trace.add('admitted', 1); trace.add('unknown', 1); trace.finish(true);
          throw error;
        }
      }
      if (!retained) return value;
      const trace = guardedTrace(this.diagnostics, 'storage-sync-contract');
      trace.add('admitted', 1);
      // This reports the contract violation, never authorizes cancellation,
      // writer replay or replacement. Arbitrary thenables are NOT invoked.
      trace.reportPending({ pending: 1, unknown: 1 });
      if (nativePromise) {
        let settled = false;
        const quiesced = (error?: unknown, rejected = false) => {
          if (settled) return;
          settled = true;
          if (rejected) { try { this.failed(error); } catch { /* Do not lose original cleanup evidence. */ } }
          try { this.release(id, false, { workClass, bytes }, rejected); trace.add('settled', 1); }
          catch { trace.add('unknown', 1); }
          trace.finish(true);
        };
        try {
          // Intrinsic observation ignores an overridden/hidden .then. Species
          // or constructor inspection may still fail: keep the charged lease.
          Promise.prototype.then.call(value, () => quiesced(), error => quiesced(error, true));
        } catch { trace.add('unknown', 1); trace.finish(true); }
      } else { trace.add('unknown', 1); trace.finish(true); }
      throw new Error('Storage admission callback must be synchronous');
    }
    catch (e) { failed = true; this.failed(e); throw e; }
    finally { if (!retained) this.release(id, failed, { workClass, bytes }); }
  }
  async run<T>(workClass: StorageWorkClass, bytes: number, write: () => Promise<T>, lease?: {
    requestId: string; acquired: (volume: string) => void; expectedVolume?: string;
  }): Promise<T> {
    if (lease?.expectedVolume !== undefined && lease.expectedVolume !== this.volume) throw new StorageAdmissionDeferred('volume-changed');
    // A busy BEGIN has no transaction body, sample or admitted writer to
    // replay. Yield between at most four original lock attempts, within the
    // existing coordinator RPC deadline. Never retry a body/COMMIT error or
    // an uncertain BEGIN; only the ledger's per-invocation proof permits this.
    let acquisition = this.acquire(workClass, bytes, lease?.requestId);
    for (let attempt = 1; !acquisition.started; attempt++) {
      const trace = guardedTrace(this.diagnostics, 'storage-admission');
      trace.add('step', 5); trace.add('busy', attempt); trace.add('deferred', 1); trace.finish(true);
      if (attempt === 4) throw new StorageAdmissionDeferred('coordinator-busy');
      await new Promise<void>(resolve => setTimeout(resolve, attempt * 10));
      acquisition = this.acquire(workClass, bytes, lease?.requestId);
    }
    const { id } = acquisition;
    let failed = false;
    try { lease?.acquired(this.volume); return await write(); }
    catch (e) {
      failed = true;
      this.failed(e);
      throw e;
    } finally {
      // A failed bookkeeping write intentionally leaks capacity instead of
      // authorizing a second writer with an uncertain free-space reservation.
      this.release(id, failed, { workClass, bytes });
    }
  }
  /** Called by the replacement coordinator only with original writer/exit
   * proof held in the surviving parent. Never enumerate or expire other leases.
   * A removed/remounted destination cannot select a different volume ledger. */
  reconcileTransient(requestId: string, volume: string, full: boolean, expected?: { workClass: StorageWorkClass; bytes: number }) {
    if (volume !== this.volume || String(statSync(this.root, { bigint: true }).dev) !== volume) throw new StorageAdmissionDeferred('volume-changed');
    if (full) this.deny();
    return this.ledger.reconcileTransient(volume, requestId, expected);
  }
}
