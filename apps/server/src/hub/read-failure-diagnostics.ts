import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import { isDeliverySnapshotReadRejected } from './delivery-reader-protocol.js';

/** Original read-owner evidence before sanitization. Numeric classification
 * is observation only, never permission to replay, replace or release a writer.
 * A cleanup failure remains unknown; it is not a settled snapshot or COMMIT. */
export function reportHubReadFailure(operation: 'hub-delivery-read' | 'hub-preference-read' | 'hub-users-read' | 'hub-connections-read' | 'hub-workspace-revisions-read' | 'hub-workspace-preferences-read' | 'hub-workspace-layout-read' | 'hub-workspace-board-read' | 'hub-notebook-snapshot-read' | 'hub-completion-summary-read', error: unknown,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, rollback?: { error: unknown }): void {
  try {
    const trace = diagnostics.start(operation);
    trace.add('step', 2);
    if (isDeliverySnapshotReadRejected(error) && !rollback) {
      trace.add('deferred', 1); trace.add('settled', 1);
    } else addSqlFailure(trace, error);
    if (rollback) {
      trace.add('rollbackFailed', 1); trace.add('unknown', 1);
      addSqlFailure(trace, rollback.error, 'rollbackErrorCode');
    }
    trace.finish(true);
  } catch { /* Observation cannot replace the original read or cleanup outcome. */ }
}
