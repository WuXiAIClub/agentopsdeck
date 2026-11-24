import { guardedTrace } from '../diagnostics/guarded-trace.js';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { synchronousParticipantInspector, withSynchronousParticipants } from './synchronous-participant.js';
import { markConnectionCleanupFault, requireConnectionReady, retireConnectionForAsyncWork } from './connection-recovery.js';
import { createHash } from 'node:crypto';
import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import { addSqlFailure, sqlFailureCode } from './sql-failure-diagnostics.js';

export type StorageWorkClass = 'recovery' | 'durable' | 'projection' | 'export';
type Reservation = { requestId: string; fingerprint: string; workClass: StorageWorkClass; bytes: number; state: 'reserved' | 'started' | 'released'; expiresAt: number };
export class StorageAdmissionDeferred extends Error {}
const floors: Record<StorageWorkClass, number> = { recovery: 64 * 1024 ** 2, durable: 256 * 1024 ** 2, projection: 512 * 1024 ** 2, export: 768 * 1024 ** 2 };
const valid = (v: string) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v)
  && Buffer.from(v, 'utf8').toString('utf8') === v;
// TEXT extraction may truncate NUL or replace invalid UTF-8. Retrieve bounded
// raw bytes, retain the original SQL type check, and decode without replacement.
const receiptPayloadSql = "CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB))<=8192 THEN CAST(payload AS BLOB) ELSE NULL END";
const receiptRequestSql = "CASE WHEN typeof(request)='text' AND length(CAST(request AS BLOB))<=1024 THEN CAST(request AS BLOB) ELSE NULL END";
const receiptDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// The coordinator owns its schema for the lifetime of this connection. Share
// initialization across destination-specific ledger facades, not across files.
const initializedDatabases = new WeakSet<DatabaseSync>();
/** Isolated admission ledger, not a filesystem quota. One coordinator/database
 * per physical volume is required before runtime enablement. OS free-space
 * samples are advisory: reserve WAL/temporary overhead in bytes, and propagate
 * ENOSPC from actual writes. No expiry releases an already-started operation. */
export class StorageWorkAdmission {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  private synchronous<T>(work: () => T): T {
    const inspect = synchronousParticipantInspector(this.db);
    if (!inspect) throw new Error('Admission participant requires its original boundary');
    inspect(undefined);
    const value = work(); inspect(value); return value;
  }
  private transaction<T>(fn: (trace: PerformanceTrace) => T, refusal?: { error?: unknown }): T {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new StorageAdmissionDeferred('outer-transaction');
    const trace = guardedTrace(this.diagnostics, 'storage-admission');
    let escapedAsyncWork = false;
    const inspect = (value: unknown) => {
      if (escapedAsyncWork) throw new Error('Admission work must be synchronous');
      escapedAsyncWork = types.isPromise(value);
      if (!escapedAsyncWork && value !== null && (typeof value === 'object' || typeof value === 'function')) {
        // A throwing then getter leaves the original owner uncertain too.
        escapedAsyncWork = true;
        escapedAsyncWork = typeof (value as { then?: unknown }).then === 'function';
      }
      if (escapedAsyncWork) {
        try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Never invoke arbitrary thenables. */ }
        throw new Error('Admission work must be synchronous');
      }
    };
    let failed = true, began = false, beginConfirmed = false, commitAttempted = false, step = 1;
    try {
      requireConnectionReady(this.db);
      if (this.db.isTransaction) throw new StorageAdmissionDeferred('outer-transaction');
      let at = performance.now();
      try { began = true; this.db.exec('BEGIN IMMEDIATE'); beginConfirmed = true; } finally { trace.add('beginMs', performance.now() - at); }
      step = 2; at = performance.now();
      let value: T;
      try {
        if (!initializedDatabases.has(this.db)) this.db.exec('CREATE TABLE IF NOT EXISTS storage_work_reservations(volume TEXT,request TEXT,payload TEXT,PRIMARY KEY(volume,request))');
        value = withSynchronousParticipants(this.db, inspect, () => fn(trace));
        inspect(value);
      } finally { trace.add('bodyMs', performance.now() - at); }
      at = performance.now();
      step = 3; commitAttempted = true;
      try { this.db.exec('COMMIT'); } finally { trace.add('commitMs', performance.now() - at); }
      trace.add('settled', 1);
      // Never memoize DDL which was rolled back by a failed admission/sample.
      initializedDatabases.add(this.db); failed = false; return value;
    } catch (e) {
      trace.add('step', step); addSqlFailure(trace, e);
      // Per-invocation evidence, captured before rollback/log reentrancy. Only
      // a rejected BEGIN with no transaction and SQLite BUSY is retryable.
      // Body/COMMIT errors, closed owners and arbitrary errors stay unknown.
      let beginRefused = false;
      if (refusal && began && !beginConfirmed && !commitAttempted && !escapedAsyncWork
        && sqlFailureCode(e) === 5) {
        try { if (!this.db.isTransaction) { refusal.error = e; beginRefused = true; trace.add('deferred', 1); } } catch { /* No proof. */ }
      }
      let unknown = escapedAsyncWork || commitAttempted || (began && !beginConfirmed && !beginRefused);
      if (began && this.db.isTransaction) {
        const at = performance.now();
        try { this.db.exec('ROLLBACK'); } catch (error) { markConnectionCleanupFault(this.db, false); trace.add('rollbackFailed', 1); addSqlFailure(trace, error, 'rollbackErrorCode'); unknown = true; }
        finally { trace.add('rollbackMs', performance.now() - at); }
      }
      if (unknown) trace.add('unknown', 1);
      throw e;
    } finally {
      // Fence late SQL only after the original rollback has had its chance.
      if (escapedAsyncWork) retireConnectionForAsyncWork(this.db);
      trace.finish(failed);
    }
  }
  private scope(volume: string, requestId: string) { if (!valid(volume) || !valid(requestId)) throw new StorageAdmissionDeferred('scope'); }
  private decode(payload: unknown, requestId: unknown): Reservation {
    // Persisted JSON is data, not a typed receipt. Corruption must not look like
    // absence, negative capacity, an expired reservation or another row's ID.
    // Never repair/overwrite it on a request path or disclose the raw payload.
    try {
      if (!(payload instanceof Uint8Array) || payload.length > 8192) throw Error();
      const text = receiptDecoder.decode(payload);
      if (requestId instanceof Uint8Array) requestId = receiptDecoder.decode(requestId);
      if (text.length > 2048 || typeof requestId !== 'string' || !valid(requestId)) throw Error();
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      const receipt = value as Reservation;
      if (Object.keys(receipt).length !== 6 || receipt.requestId !== requestId || !valid(receipt.requestId)
        || typeof receipt.workClass !== 'string' || !Object.hasOwn(floors, receipt.workClass) || !Number.isSafeInteger(receipt.bytes)
        || receipt.bytes < 1 || receipt.bytes > 4 * 1024 ** 3
        || !['reserved', 'started', 'released'].includes(receipt.state)
        || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt < 5000
        || receipt.fingerprint !== createHash('sha256').update(JSON.stringify([receipt.workClass, receipt.bytes])).digest('hex')) throw Error();
      return receipt;
    } catch { throw new StorageAdmissionDeferred('corrupt-receipt'); }
  }
  read(volume: string, requestId: string): Reservation | undefined {
    this.scope(volume, requestId);
    if (!initializedDatabases.has(this.db) && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_work_reservations'").get()) return undefined;
    const row = this.db.prepare(`SELECT ${receiptPayloadSql} payload FROM storage_work_reservations WHERE volume=? AND request=?`).get(volume, requestId);
    return row ? this.decode(row.payload, requestId) : undefined;
  }
  private write(volume: string, value: Reservation) {
    this.db.prepare('INSERT INTO storage_work_reservations VALUES(?,?,?) ON CONFLICT(volume,request) DO UPDATE SET payload=excluded.payload').run(volume, value.requestId, JSON.stringify(value));
  }
  reserve(volume: string, requestId: string, workClass: StorageWorkClass, bytes: number,
    observation: { freeBytes: bigint; observedAt: number } | (() => { freeBytes: bigint; observedAt: number })) {
    return this.reserveInternal(volume, requestId, workClass, bytes, observation, false);
  }
  /** Process-generated IO only: commit a charged started lease BEFORE invoking
   * the writer. Durable/external requests retain their separate claim receipt. */
  startTransient(volume: string, requestId: string, workClass: StorageWorkClass, bytes: number,
    observation: () => { freeBytes: bigint; observedAt: number }, clearPressureAt?: number) {
    return this.startTransientInternal(volume, requestId, workClass, bytes, observation, clearPressureAt);
  }
  /** Evidence from this exact original BEGIN, not from an error's spelling.
   * Only a rejected lock acquisition can be attempted again before any sample
   * or writer ran. Keep the synchronous API's original error contract above. */
  tryStartTransient(volume: string, requestId: string, workClass: StorageWorkClass, bytes: number,
    observation: () => { freeBytes: bigint; observedAt: number }, clearPressureAt?: number):
    { started: true; receipt: Reservation } | { started: false; error: unknown } {
    const refusal: { error?: unknown } = {};
    try {
      return { started: true, receipt: this.startTransientInternal(volume, requestId, workClass, bytes, observation, clearPressureAt, refusal) };
    } catch (error) {
      if (Object.hasOwn(refusal, 'error') && refusal.error === error) return { started: false, error };
      throw error;
    }
  }
  private startTransientInternal(volume: string, requestId: string, workClass: StorageWorkClass, bytes: number,
    observation: () => { freeBytes: bigint; observedAt: number }, clearPressureAt?: number, refusal?: { error?: unknown }) {
    if (clearPressureAt !== undefined && (!Number.isSafeInteger(clearPressureAt) || clearPressureAt < 0)) throw new StorageAdmissionDeferred('pressure-sample');
    if (!requestId.startsWith('transient-')) throw new StorageAdmissionDeferred('persistent-receipt');
    return this.reserveInternal(volume, requestId, workClass, bytes, observation, true, clearPressureAt, refusal);
  }
  private reserveInternal(volume: string, requestId: string, workClass: StorageWorkClass, bytes: number,
    observation: { freeBytes: bigint; observedAt: number } | (() => { freeBytes: bigint; observedAt: number }), started: boolean,
    clearPressureAt?: number, refusal?: { error?: unknown }) {
    this.scope(volume, requestId);
    if (typeof workClass !== 'string' || !Object.hasOwn(floors, workClass) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 4 * 1024 ** 3) throw new StorageAdmissionDeferred('estimate');
    const fingerprint = createHash('sha256').update(JSON.stringify([workClass, bytes])).digest('hex');
    return this.transaction(trace => {
      const old = this.read(volume, requestId);
      if (old) { if (started || old.fingerprint !== fingerprint) throw new StorageAdmissionDeferred('request-reused'); return old; }
      // Runtime samples under the same write transaction as the reservation.
      // Sampling before lock acquisition could reuse stale free bytes after
      // another writer finishes and releases its charge while we wait.
      let at = performance.now();
      let sample: { freeBytes: bigint; observedAt: number };
      try { sample = this.synchronous(() => typeof observation === 'function' ? observation() : observation); }
      finally { trace.add('sampleMs', performance.now() - at); }
      const now = this.synchronous(() => this.now());
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + 5000) || now < 0 || !Number.isSafeInteger(sample.observedAt)
        || sample.observedAt > now || now - sample.observedAt > 1000 || typeof sample.freeBytes !== 'bigint' || sample.freeBytes < 0n) throw new StorageAdmissionDeferred('stale-space-sample');
      at = performance.now();
      let rows: Reservation[];
      // Bound materialization even when the persisted table exceeds its normal
      // capacity. Byte limits retain complete values or fail closed, never
      // accept a truncated JSON prefix or replacement-decoded row identity.
      // UTF-8 is at most four bytes per allowed character; decode also enforces
      // the tighter JS character limits. Capacity refusal precedes all writes.
      try { rows = this.db.prepare(`SELECT ${receiptRequestSql} request,${receiptPayloadSql} payload FROM storage_work_reservations WHERE volume=? LIMIT 4096`).all(volume).map(r => this.decode(r.payload, r.request)); }
      finally { trace.add('receiptScanMs', performance.now() - at); }
      trace.add('receipts', rows.length);
      if (rows.length >= 4096) throw new StorageAdmissionDeferred('receipt-capacity');
      let reserved = 0n;
      for (const row of rows) {
        if (row.state === 'reserved' && now >= row.expiresAt) { row.state = 'released'; this.write(volume, row); }
        if (row.state !== 'released') reserved += BigInt(row.bytes);
      }
      if (sample.freeBytes < BigInt(floors[workClass]) + reserved + BigInt(bytes)) throw new StorageAdmissionDeferred('insufficient-space');
      const result: Reservation = { requestId, fingerprint, workClass, bytes, state: started ? 'started' : 'reserved', expiresAt: now + 5000 };
      this.write(volume, result);
      // Charge and pressure CAS are one original-connection transaction. A
      // failed cleanup must not leave a started lease for an uninvoked writer.
      // A newer pressure report or another volume is never cleared here.
      if (clearPressureAt !== undefined) this.db.prepare('DELETE FROM storage_volume_pressure WHERE volume=? AND denied_at=?').run(volume, clearPressureAt);
      return result;
    }, refusal);
  }
  claim(volume: string, requestId: string) {
    return this.transaction(() => {
      const receipt = this.read(volume, requestId); if (!receipt) throw new StorageAdmissionDeferred('missing');
      if (receipt.state !== 'reserved') return { claimed: false, receipt };
      const now = this.synchronous(() => this.now()); if (!Number.isSafeInteger(now) || now < receipt.expiresAt - 5000) throw new StorageAdmissionDeferred('clock');
      if (now >= receipt.expiresAt) { receipt.state = 'released'; this.write(volume, receipt); return { claimed: false, receipt }; }
      receipt.state = 'started'; this.write(volume, receipt); return { claimed: true, receipt };
    });
  }
  /** Call only after writer is definitively quiescent, including failed writes.
   * Unknown/crashed writers require original-operation reconciliation first. */
  release(volume: string, requestId: string) {
    return this.transaction(() => {
      const receipt = this.read(volume, requestId); if (!receipt) throw new StorageAdmissionDeferred('missing');
      receipt.state = 'released'; this.write(volume, receipt); return receipt;
    });
  }
  /** One commit after actual IO quiescence; absence is not permission to replay.
   * Never use for recoverable operations or external mutation request IDs. */
  finishTransient(volume: string, requestId: string) {
    if (!requestId.startsWith('transient-')) throw new StorageAdmissionDeferred('persistent-receipt');
    return this.transaction(() => {
      const receipt = this.read(volume, requestId);
      if (!receipt || receipt.state !== 'started') throw new StorageAdmissionDeferred('not-started');
      this.db.prepare('DELETE FROM storage_work_reservations WHERE volume=? AND request=?').run(volume, requestId);
    });
  }
  /** Original quiescent writer only. Retry admission-ledger cleanup, never
   * business work, and never after body/COMMIT/rollback uncertainty. */
  finishQuiescentTransient(volume: string, requestId: string, expected: { workClass: StorageWorkClass; bytes: number }):
    { released: true } | { released: false; error: unknown } {
    if (!/^transient-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new StorageAdmissionDeferred('persistent-receipt');
    if (!Object.hasOwn(floors, expected.workClass) || !Number.isSafeInteger(expected.bytes)
      || expected.bytes < 1 || expected.bytes > 4 * 1024 ** 3) throw new StorageAdmissionDeferred('estimate');
    const refusal: { error?: unknown } = {};
    try {
      this.transaction(() => {
        const receipt = this.read(volume, requestId);
        if (!receipt || receipt.state !== 'started') throw new StorageAdmissionDeferred('not-started');
        if (receipt.workClass !== expected.workClass || receipt.bytes !== expected.bytes
          || receipt.fingerprint !== createHash('sha256').update(JSON.stringify([expected.workClass, expected.bytes])).digest('hex')) throw new StorageAdmissionDeferred('request-reused');
        this.db.prepare('DELETE FROM storage_work_reservations WHERE volume=? AND request=?').run(volume, requestId);
      }, refusal);
      return { released: true };
    } catch (error) {
      if (Object.hasOwn(refusal, 'error') && refusal.error === error) return { released: false, error };
      throw error;
    }
  }
  /** An exact, original-process lease after its writer settled (or was never
   * invoked) and its old coordinator exited. A never-invoked writer also needs
   * the prebound volume and exact payload proof. Missing means already deleted, never replay permission.
   * This must not be used for external command receipts or age-based sweeping. */
  reconcileTransient(volume: string, requestId: string, expected?: { workClass: StorageWorkClass; bytes: number }) {
    if (!/^transient-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
      throw new StorageAdmissionDeferred('persistent-receipt');
    }
    if (expected && (!Object.hasOwn(floors, expected.workClass) || !Number.isSafeInteger(expected.bytes)
      || expected.bytes < 1 || expected.bytes > 4 * 1024 ** 3)) throw new StorageAdmissionDeferred('estimate');
    return this.transaction(() => {
      const receipt = this.read(volume, requestId);
      if (!receipt) return false;
      if (expected && (receipt.requestId !== requestId || receipt.workClass !== expected.workClass || receipt.bytes !== expected.bytes
        || receipt.fingerprint !== createHash('sha256').update(JSON.stringify([expected.workClass, expected.bytes])).digest('hex'))) {
        throw new StorageAdmissionDeferred('request-reused');
      }
      if (receipt.state !== 'started') throw new StorageAdmissionDeferred('not-started');
      this.db.prepare('DELETE FROM storage_work_reservations WHERE volume=? AND request=?').run(volume, requestId);
      return true;
    });
  }
  /** Only for coordinator-generated, non-recoverable IO lease IDs. External
   * mutation receipts must NEVER use this: their IDs remain replay fences. */
  retireTransient(volume: string, requestId: string) {
    if (!requestId.startsWith('transient-')) throw new StorageAdmissionDeferred('persistent-receipt');
    return this.transaction(() => {
      const receipt = this.read(volume, requestId);
      if (!receipt || receipt.state !== 'released') throw new StorageAdmissionDeferred('not-quiescent');
      this.db.prepare('DELETE FROM storage_work_reservations WHERE volume=? AND request=?').run(volume, requestId);
    });
  }
}
