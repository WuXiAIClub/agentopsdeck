import type { DatabaseSync } from 'node:sqlite';
import { transactionObservation } from './transaction-observation.js';
import { types } from 'node:util';
import { markConnectionCleanupFault, requireConnectionReady, retireConnectionForAsyncWork } from './connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import { addSqlFailure } from './sql-failure-diagnostics.js';
import { synchronousParticipantInspector, withSynchronousParticipants } from './synchronous-participant.js';

type Operation = 'command-receipt-claim' | 'command-receipt-recovery' | 'command-receipt-migration'
  | 'turn-queue-change' | 'openclaw-execution-change' | 'openclaw-execution-recovery'
  | 'hub-preference-migration' | 'hub-delivery-append'
  | 'automation-store-change' | 'automation-configuration-change' | 'interaction-store-change'
  | 'execution-grant-change' | 'connector-event-change' | 'mirror-outbox-change'
  | 'auth-login-check' | 'auth-login-change' | 'auth-passkey-change' | 'auth-passkey-schema' | 'maintenance-journal-change'
  | 'quick-chat-change' | 'completion-unread-change' | 'delegation-store-change' | 'content-replica-change'
  | 'usage-manifest-change' | 'session-guidance-change' | 'task-session-change' | 'auth-issue-change'
  | 'codex-stopped-recovery' | 'codex-stopped-unknown-disposition' | 'codex-native-resume' | 'codex-creation-change'
  | 'content-proposal-change' | 'content-batch-change' | 'notebook-capability-change' | 'notebook-move-change'
  | 'connector-maintenance-change';

/** Synchronous owner boundary, not an async SQL facade. Never retries a write.
 * Explicit commit supports receipt policy updates which must survive rejection.
 * Nested queue claims use a savepoint and never settle the caller's transaction.
 */
export function observedTransaction<T>(db: DatabaseSync, operation: Operation,
  work: (commit: () => void, checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  savepoint = false, beginMode: 'immediate' | 'deferred' = 'immediate'): T {
  requireConnectionReady(db);
  const originalInspector = synchronousParticipantInspector(db);
  originalInspector?.(undefined);
  const parentTransaction = db.isTransaction;
  const trace = transactionObservation(diagnostics, operation);
  let failed = true, began = false, beginConfirmed = false, committed = false, commitAttempted = false;
  let commitMs = 0;
  let escapedAsyncWork = false, bodyActive = false, rejectionReported = false;
  let step = 1; // BEGIN/SAVEPOINT=1, synchronous body=2, COMMIT/RELEASE=3.
  const nested = savepoint && parentTransaction;
  const savepointName = operation === 'automation-store-change' ? 'automation_store'
    : operation === 'delegation-store-change' ? 'delegation_store'
    : operation === 'auth-passkey-schema' ? 'auth_passkey_schema' : 'turn_batch_claim';
  trace.add('nested', Number(nested));
  const timed = <R>(metric: 'beginMs' | 'bodyMs' | 'commitMs' | 'rollbackMs', fn: () => R): R => {
    const at = performance.now();
    try { return fn(); } finally {
      const duration = performance.now() - at;
      if (metric === 'commitMs') commitMs += duration;
      trace.add(metric, metric === 'bodyMs' ? Math.max(0, duration - commitMs) : duration);
    }
  };
  const settle = () => {
    originalInspector?.(undefined);
    if (escapedAsyncWork) throw new Error('Transaction work must be synchronous');
    if (!began || committed || commitAttempted) throw new Error('Transaction settlement already attempted');
    commitAttempted = true;
    step = 3;
    timed('commitMs', () => db.exec(nested ? `RELEASE ${savepointName}` : 'COMMIT'));
    committed = true;
    // Releasing a savepoint is not a durable commit of the enclosing operation.
    trace.add('settled', Number(!nested));
    step = 2; // An explicit commit may be followed by a policy/body rejection.
  };
  const commit = () => {
    // This capability belongs only to the synchronous body. Rollback, result
    // inspection and diagnostics must never leave it able to settle a later
    // owner's transaction (or a later savepoint with the same name).
    if (!bodyActive) {
      if (!rejectionReported) {
        // Latch before delivery: even a reentrant or throwing diagnostic sink
        // cannot revive authority or recursively emit unbounded observations.
        rejectionReported = true;
        const rejected = transactionObservation(diagnostics, 'storage-settlement-rejected');
        rejected.add('nested', Number(nested));
        rejected.finish(true);
      }
      throw new Error('Transaction settlement callback ended');
    }
    settle();
  };
  const observeRejection = (value: unknown) => {
    const promised = types.isPromise(value);
    if (promised) {
      // Every original native rejection needs an observer, even after an
      // earlier participant has already fenced the transaction. This neither
      // invokes arbitrary thenables nor grants settlement or replay authority.
      try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Remains denied. */ }
    }
    return promised;
  };
  const checkResult = (value: unknown) => {
    const promised = types.isPromise(value);
    try {
      // Direct nested return/participant escapes belong to the original owner
      // too, not just observedParticipant authority hooks. Keep inner cleanup
      // usable until the outer rollback ends, then retire that old facade once.
      if (originalInspector) { originalInspector(value); return; }
      if (escapedAsyncWork) throw new Error('Transaction work must be synchronous');
      escapedAsyncWork = promised;
      if (!escapedAsyncWork && value !== null && (typeof value === 'object' || typeof value === 'function')) {
        escapedAsyncWork = true; // A throwing getter leaves an uncertain owner.
        escapedAsyncWork = typeof (value as { then?: unknown }).then === 'function';
      }
      if (!escapedAsyncWork) return;
      throw new Error('Transaction work must be synchronous');
    } finally {
      // Native .then still performs constructor/species lookup. Latch the
      // ORIGINAL owner's refusal first, then observe even a repeated refusal
      // or an inspector exception. Reentrant getters cannot use old commit.
      if (promised) observeRejection(value);
    }
  };
  // Inner void callbacks can discard async returns before the outer body is
  // inspected. This capability has the same synchronous lifetime as commit.
  const checkParticipant = (value: unknown) => {
    if (!bodyActive) {
      observeRejection(value);
      throw new Error('Transaction participant callback ended');
    }
    checkResult(value);
  };
  try {
    requireConnectionReady(db);
    originalInspector?.(undefined);
    if (db.isTransaction !== parentTransaction) throw new Error('Transaction changed during observation');
    if (!nested && db.isTransaction) throw new Error('Transaction requires its owning database boundary');
    timed('beginMs', () => {
      began = true;
      db.exec(nested ? `SAVEPOINT ${savepointName}` : beginMode === 'deferred' ? 'BEGIN' : 'BEGIN IMMEDIATE'); beginConfirmed = true;
    });
    const value = timed('bodyMs', () => {
      step = 2;
      bodyActive = true;
      try { return withSynchronousParticipants(db, checkParticipant, () => work(commit, checkParticipant)); }
      finally { bodyActive = false; }
    });
    // Also reject untyped/JavaScript callers. Async work must migrate with the
    // entire owner, not escape this lock while receipts or queue updates await.
    // A native Promise remains asynchronous even if its then property was
    // hidden or replaced. Reading an arbitrary then getter can also throw;
    // classify that inspection failure as unknown until the old owner closes.
    checkResult(value);
    if (!committed) settle();
    failed = false;
    return value;
  } catch (error) {
    trace.add('step', step); addSqlFailure(trace, error);
    // A failed commit/release is uncertain even when the SQL already took effect.
    let unknown = escapedAsyncWork || (commitAttempted && !committed) || (began && !beginConfirmed);
    if (nested && began && !beginConfirmed && db.isTransaction) markConnectionCleanupFault(db, true);
    else if (began && !committed && db.isTransaction) unknown = rollback(db, nested, savepointName, trace, timed) || unknown;
    if (unknown) trace.add('unknown', 1);
    throw error;
  } finally {
    if (escapedAsyncWork) retireConnectionForAsyncWork(db);
    trace.finish(failed);
  }
}

function rollback(db: DatabaseSync, nested: boolean, savepointName: string, trace: PerformanceTrace,
  timed: <R>(metric: 'rollbackMs', fn: () => R) => R) {
  try {
    timed('rollbackMs', () => db.exec(nested ? `ROLLBACK TO ${savepointName}; RELEASE ${savepointName}` : 'ROLLBACK'));
    return false;
  } catch (error) {
    // Cleanup cannot replace the original failure or grant a replay.
    addSqlFailure(trace, error, 'rollbackErrorCode');
    markConnectionCleanupFault(db, nested);
    trace.add('rollbackFailed', 1); return true;
  }
}
