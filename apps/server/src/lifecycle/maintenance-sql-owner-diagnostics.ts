import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { sqlFailureCode } from '../storage/sql-failure-diagnostics.js';
import { observeSqlOwnerFailure, type SqlOwnerFailureNotice } from '../storage/sql-owner-failure-relay.js';

const steps = { open: 1, read: 2, close: 3, command: 4 } as const;

/** Original worker evidence before sanitization. No SQL, exception text, paths,
 * receipt IDs, tokens or permission claims. Cleanup failure remains unknown. */
export function reportMaintenanceSqlOwnerFailure(phase: keyof typeof steps, error: unknown,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, relay?: (notice: SqlOwnerFailureNotice) => void): void {
  const code = sqlFailureCode(error);
  const notice: SqlOwnerFailureNotice = { kind: 'sql-owner-failure', owner: 'maintenance', step: steps[phase],
    ...(code === undefined ? {} : { sqlErrorCode: code }) };
  observeSqlOwnerFailure(notice, diagnostics);
  try { relay?.(notice); } catch { /* Transport cannot change original failure or interrupt cleanup. */ }
}
