import type { DatabaseSync } from 'node:sqlite';
import { transactionObservation } from './transaction-observation.js';
import { types } from 'node:util';
import { markConnectionCleanupFault, requireConnectionReady, retireConnectionForAsyncWork } from './connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from './sql-failure-diagnostics.js';
import { synchronousParticipantInspector, withSynchronousParticipants } from './synchronous-participant.js';

const savepoints = {
  'hub-notebook-machine': 'hub_notebook_machine',
  'hub-event-feed-command': 'hub_event_feed_command',
  'auth-audit-initialize': 'auth_audit_initialize',
  'auth-audit-append': 'auth_audit_append',
  'auth-audit-page': 'auth_audit_page',
  'auth-audit-list': 'auth_audit_list',
  'checkpoint-authority-check': 'checkpoint_authority_check',
  'execution-issuer-check': 'execution_issuer_check',
  'content-authority-check': 'content_authority_check',
  'node-authority-check': 'node_authority_check',
  'maintenance-policy-check': 'maintenance_policy_check',
  'delegation-authority-check': 'delegation_authority_check',
  'mirror-outbox-change': 'mirror_outbox_write',
  'command-receipt-reclaim': 'command_receipt_reclaim',
  'native-token-snapshot': 'native_token_snapshot',
  'native-token-cumulative': 'native_token_cumulative',
  'hermes-journal-change': 'hermes_journal',
  'claude-transcript-append': 'claude_transcript_append',
  'copilot-transcript-append': 'copilot_transcript_append',
  'sdk-transcript-counts-install': 'sdk_transcript_counts_install',
  'sdk-execution-change': 'sdk_execution_journal',
  'turn-dispatch-snapshot': 'turn_dispatch_snapshot',
  'turn-bootstrap-body': 'turn_bootstrap_body',
  'session-file-index-rebuild': 'file_index_rebuild',
  'session-file-index-change': 'optional_file_index',
  'hub-identity-change': 'hub_identity_write',
  'hub-connection-change': 'hub_connection_write',
  'hub-connection-display-migration': 'hub_connection_display_migration',
  'hub-preference-migration': 'hub_session_preference_migration',
  'hub-identity-check': 'hub_identity_check',
  'weixin-binding-change': 'weixin',
  'role-access-change': 'role_access',
  'execution-issuer-change': 'configure_execution_issuer',
  'execution-usage-migration': 'execution_usage_migration',
  'execution-usage-reserve': 'execution_usage_reserve',
  'session-creation-ownership': 'session_creation_ownership',
  'session-share-change': 'session_share',
  'workspace-board-binding-change': 'workspace_board_binding',
  'workspace-board-file-change': 'workspace_board_file',
  'workspace-card-file-change': 'workspace_card_file',
  'workspace-board-capability-change': 'workspace_board_capability',
  'workspace-card-configuration-change': 'workspace_card_configuration',
  'workspace-card-change': 'workspace_card_write',
  'workspace-board-change': 'workspace_board_write',
  'workspace-drawing-change': 'workspace_drawing_write',
  'workspace-native-drawio-change': 'native_drawio_write',
  'workspace-report-change': 'workspace_report',
  'workspace-file-prepare': 'workspace_file_prepare',
  'workspace-file-write-prepare': 'workspace_file_write_prepare',
  'workspace-file-revoke': 'workspace_file_revoke',
  'workspace-file-reconcile': 'workspace_file_reconcile',
  'notebook-bound-move': 'notebook_bound_move',
  'notebook-bound-finish': 'notebook_bound_finish',
  'notebook-bound-prepare': 'notebook_bound_prepare',
  'archive-upgrade-prepare': 'archive_upgrade_prepare',
} as const;

/** Preserve the existing deferred SAVEPOINT boundary, including nested callers.
 * No await, callback retry or second connection. A failed RELEASE can have
 * committed: preserve the original exception and diagnose uncertainty. */
export function observedSavepoint<T>(db: DatabaseSync, operation: keyof typeof savepoints,
  work: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): T {
  if (!Object.hasOwn(savepoints, operation)) throw new Error('Unsupported savepoint operation');
  requireConnectionReady(db);
  const originalInspector = synchronousParticipantInspector(db);
  // A caught escape has already revoked the enclosing owner's settlement.
  // Do not invoke another nested body or acquire its savepoint afterward.
  originalInspector?.(undefined);
  const name = savepoints[operation], nested = db.isTransaction;
  const trace = transactionObservation(diagnostics, operation);
  trace.add('nested', Number(nested));
  let failed = true, began = false, beginConfirmed = false, releaseAttempted = false;
  let escapedAsyncWork = false, bodyActive = false;
  let step = 1; // SAVEPOINT=1, synchronous body=2, RELEASE=3.
  const timed = <R>(metric: 'beginMs' | 'bodyMs' | 'commitMs' | 'rollbackMs', run: () => R) => {
    const at = performance.now();
    try { return run(); } finally { trace.add(metric, performance.now() - at); }
  };
  const observeRejection = (value: unknown) => {
    if (types.isPromise(value)) {
      try { void Promise.prototype.then.call(value, () => {}, () => {}); }
      catch { /* Observation cannot grant an asynchronous participant. */ }
    }
  };
  const checkResult = (value: unknown) => {
    const promised = types.isPromise(value);
    try {
      // The enclosing owner must roll back BEFORE it retires the facade. An
      // inner boundary cannot retire it early and fence that original rollback.
      if (originalInspector) { originalInspector(value); return; }
      if (escapedAsyncWork) throw new Error('Savepoint work must be synchronous');
      escapedAsyncWork = promised;
      if (!escapedAsyncWork && value !== null && (typeof value === 'object' || typeof value === 'function')) {
        escapedAsyncWork = true;
        escapedAsyncWork = typeof (value as { then?: unknown }).then === 'function';
      }
      if (escapedAsyncWork) throw new Error('Savepoint work must be synchronous');
    } finally {
      // Latch refusal before native observation. A constructor/species getter
      // cannot revive this body's participant or the original RELEASE.
      if (promised) observeRejection(value);
    }
  };
  const checkParticipant = (value: unknown) => {
    if (!bodyActive) {
      observeRejection(value);
      throw new Error('Savepoint participant callback ended');
    }
    checkResult(value);
  };
  try {
    // Observation cannot grant a boundary after retiring/changing its original owner.
    requireConnectionReady(db);
    originalInspector?.(undefined);
    if (db.isTransaction !== nested) throw new Error('Savepoint transaction changed during observation');
    timed('beginMs', () => { began = true; db.exec(`SAVEPOINT ${name}`); beginConfirmed = true; });
    step = 2;
    const value = timed('bodyMs', () => {
      bodyActive = true;
      try { return withSynchronousParticipants(db, checkParticipant, () => work(checkParticipant)); }
      finally { bodyActive = false; }
    });
    checkResult(value);
    releaseAttempted = true;
    step = 3;
    timed('commitMs', () => db.exec(`RELEASE ${name}`));
    trace.add('settled', Number(!nested));
    failed = false;
    return value;
  } catch (error) {
    trace.add('step', step); addSqlFailure(trace, error);
    let unknown = escapedAsyncWork || releaseAttempted || (began && !beginConfirmed);
    if (nested && began && !beginConfirmed && db.isTransaction) {
      // Acquisition is uncertain; a same-named parent savepoint may exist.
      // Never roll it back speculatively. Only the outer owner can settle.
      markConnectionCleanupFault(db, true);
    } else if (began && db.isTransaction) {
      try { timed('rollbackMs', () => db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK')); }
      catch (rollbackError) {
        addSqlFailure(trace, rollbackError, 'rollbackErrorCode');
        markConnectionCleanupFault(db, nested); trace.add('rollbackFailed', 1); unknown = true;
      }
    }
    if (unknown) trace.add('unknown', 1);
    throw error;
  } finally {
    if (escapedAsyncWork) retireConnectionForAsyncWork(db);
    trace.finish(failed);
  }
}
