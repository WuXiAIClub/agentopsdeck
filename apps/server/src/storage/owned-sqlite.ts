import type { DatabaseSync } from 'node:sqlite';
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { statSync } from 'node:fs';
import { types } from 'node:util';
import type { VolumeAdmission } from "./volume-admission.js";
import { StorageAdmissionDeferred } from "./work-admission.js";
import { asyncVolumeAdmission } from "./async-volume-admission.js";
import { performanceDiagnostics, type PerformanceDiagnostics } from "../diagnostics/performance.js";
import { requireConnectionReady, StorageConnectionUnavailable } from "./connection-recovery.js";
import { observedParticipant } from './observed-participant.js';

/** Called only by the existing owner. Does not change durability or run VACUUM.
 * journal_size_limit bounds recycled WAL, NOT an active WAL with pinned readers. */
export function configureOwnedWal(db: DatabaseSync) {
  db.exec('PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=67108864');
}
export async function ownedStorageStats(file: string) {
  const size = async (path: string) => {
    try { return (await stat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  const [databaseBytes, walBytes, space] = await Promise.all([size(file), size(`${file}-wal`), statfs(dirname(file), { bigint: true })]);
  const available = space.bavail * space.bsize;
  return { databaseBytes, walBytes, availableBytes: Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available),
    lowSpace: available < 512n * 1024n * 1024n, walPressure: walBytes > 64 * 1024 * 1024 };
}
/** Explicit maintenance only; never poll/checkpoint on a user history request.
 * PASSIVE respects other readers. No restart/truncate, no second connection. */
export function checkpointOwnedWal(db: DatabaseSync, file?: string, admission?: (root: string) => Pick<VolumeAdmission, 'runSync'>) {
  if (db.isTransaction) return { deferred: true as const };
  let executed = false;
  const checkpoint = () => {
    executed = true;
    const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!;
    return { deferred: false as const, busy: Number(row.busy), logFrames: Number(row.log), checkpointedFrames: Number(row.checkpointed) };
  };
  if (!file || file === ':memory:') return checkpoint();
  if (!admission) return { deferred: true as const };
  try {
    let walBytes = 0;
    try { walBytes = statSync(`${file}-wal`).size; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // Worst-case DB growth is bounded by the current WAL, plus metadata.
    // This is the existing owner connection: no extra connection, truncate,
    // deletion, vacuum or weakened synchronous durability.
    return admission(dirname(file)).runSync('recovery', walBytes + 65536, checkpoint);
  } catch (e) {
    // Once original SQL was attempted, a deferral-shaped failure is not a
    // pre-admission decision. Never hide it or inspect it as retry permission.
    let deferred = false, classificationUnknown = false;
    if (!executed) {
      try { deferred = e instanceof StorageAdmissionDeferred; }
      catch { classificationUnknown = true; }
    }
    if (deferred) return { deferred: true as const };
    const trace = performanceDiagnostics.start('owned-wal-checkpoint');
    if (executed) trace.add('unknown', 1);
    if (classificationUnknown) trace.add('classificationUnknown', 1);
    trace.finish(true);
    throw e;
  }
}

export type WalCheckpointResult = ReturnType<typeof checkpointOwnedWal>;
type AsyncAdmission = <T>(root: string, bytes: number, write: () => Promise<T>) => Promise<T>;

/** Async sampling/admission only. SQL remains on the exclusive owning connection.
 * Recheck lifetime, authority and transaction ownership after every await.
 * The current WAL is sampled again before SQL: growth cannot exceed the lease.
 * No retry, second connection, forced checkpoint or weakened durability. */
export async function checkpointOwnedWalAsync(db: DatabaseSync, file?: string, options: {
  available?: () => boolean;
  check?: (() => void) | undefined;
  admission?: AsyncAdmission;
  sample?: (file: string) => Promise<number>;
  diagnostics?: PerformanceDiagnostics;
} = {}): Promise<WalCheckpointResult> {
  const trace = (options.diagnostics ?? performanceDiagnostics).start('owned-wal-checkpoint');
  let failed = true, executed = false, step = 0, active = true;
  let failureStep: number | undefined;
  // Observation only: a pending stat/admission/release is not an unlock,
  // checkpoint failure, cancellation or permission to replay original SQL.
  // Steps: initial sample=1, admission=2, admitted sample=3, release ACK=4.
  const warning = setTimeout(() => trace.reportPending({ pending: 1, step, unknown: Number(executed) }), 30_000);
  warning.unref();
  const inspectHook = (hook: () => unknown, expected: 'void' | 'boolean') => {
    // These original-owner policy hooks are synchronous, not async preflights.
    // Refuse a known async body before starting it. A runtime native Promise
    // belongs to the rollback inspector, never to a truthiness/await grant.
    if (types.isAsyncFunction(hook)) throw new StorageConnectionUnavailable();
    return observedParticipant(db, 'checkpoint-authority-check', () => {
      const value = hook();
      if (types.isPromise(value)) return value as never;
      // Reject malformed objects before touching their then/getters/coercion.
      if (expected === 'void' ? value !== undefined : typeof value !== 'boolean') throw new StorageConnectionUnavailable();
      return value;
    });
  };
  const authorized = () => { if (options.check) inspectHook(options.check, 'void'); };
  const available = () => options.available === undefined || inspectHook(options.available, 'boolean') === true;
  const ready = () => {
    // A known closed original owner is already deferred; do not open a
    // SAVEPOINT or call a policy hook against an unavailable native handle.
    if (!db.isOpen) return false;
    authorized(); return available() && !db.isTransaction;
  };
  const deferred = (): WalCheckpointResult => { trace.add('deferred', 1); return { deferred: true }; };
  const sample = options.sample ?? (async path => {
    try { return (await stat(`${path}-wal`)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  });
  const measure = async () => {
    const at = performance.now();
    try {
      const bytes = await sample(file!);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER - 65536) throw Error('Invalid WAL size');
      return bytes;
    } finally { trace.add('sampleMs', performance.now() - at); }
  };
  const checkpoint = () => {
    if (!ready()) return deferred();
    const at = performance.now();
    try {
      executed = true;
      const result = checkpointOwnedWal(db);
      if (!result.deferred) {
        trace.add('busy', result.busy); trace.add('logFrames', result.logFrames);
        trace.add('checkpointedFrames', result.checkpointedFrames);
      }
      return result;
    } finally { trace.add('bodyMs', performance.now() - at); }
  };
  try {
    let result: WalCheckpointResult;
    if (!ready()) result = deferred();
    else if (!file || file === ':memory:') result = checkpoint();
    else {
      step = 1;
      const bytes = await measure();
      if (!ready()) result = deferred();
      else {
        const queued = performance.now();
        const admission = options.admission ?? ((root, charge, write) => asyncVolumeAdmission.run(root, 'recovery', charge, write));
        step = 2;
        let entered = false, completed = false, writerFailed = false;
        let original!: WalCheckpointResult, writerError: unknown;
        let releaseAt: number | undefined;
        try { await admission(dirname(file), bytes + 65536, async () => {
          // Admission owns capacity, not the result or the SQL callback lifetime.
          // Check before touching authority, telemetry, sampling or the owner DB.
          if (!active) throw Error('WAL checkpoint admission ended');
          if (entered) throw Error('WAL checkpoint admission writer already attempted');
          entered = true;
          trace.add('admitted', 1);
          try {
            trace.add('queueMs', performance.now() - queued);
            if (!ready()) original = deferred();
            else {
              step = 3;
              const current = await measure();
              // A detached callback can still be awaiting its sample when the
              // admission adapter settles. It may never continue into SQL.
              if (!active) throw Error('WAL checkpoint admission ended');
              // The async stat can race a same-owner commit. This final sync stat is
              // metadata only and closes that gap; it never waits on a SQLite lock.
              if (!ready()) original = deferred();
              else {
                let finalBytes = 0;
                try { finalBytes = statSync(`${file}-wal`).size; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                original = current > bytes || finalBytes > bytes ? deferred() : checkpoint();
              }
            }
            completed = true;
            return original;
          } catch (error) { writerFailed = true; writerError = error; failureStep ??= step; throw error; }
          finally { if (active) { step = 4; releaseAt = performance.now(); } }
        }); } catch (error) {
          failureStep ??= step;
          throw writerFailed ? writerError : error;
        } finally {
          active = false;
          if (!entered) trace.add('queueMs', performance.now() - queued);
          if (releaseAt !== undefined) trace.add('releaseMs', performance.now() - releaseAt);
        }
        if (writerFailed) throw writerError;
        if (!completed) throw Error('WAL checkpoint admission writer not completed');
        result = original;
      }
    }
    if (!result.deferred) {
      // Release acknowledgement is another await boundary. The completed SQL
      // must not certify authority or lifetime that has since been revoked.
      authorized();
      requireConnectionReady(db);
      if (!db.isOpen || !available()) throw new StorageConnectionUnavailable();
    }
    if (!result.deferred) trace.add('settled', 1);
    failed = false; return result;
  } catch (error) {
    failureStep ??= step;
    if (!executed) {
      let admissionDeferred = false;
      try { admissionDeferred = error instanceof StorageAdmissionDeferred; }
      catch { trace.add('classificationUnknown', 1); }
      if (admissionDeferred) { failed = false; return deferred(); }
    }
    if (executed) trace.add('unknown', 1);
    throw error;
  } finally { active = false; clearTimeout(warning); trace.add('step', failureStep ?? step); trace.finish(failed); }
}
