import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { sqlFailureCode } from './sql-failure-diagnostics.js';
import { observeReadonlySqlFailure, type ReadonlySqlFailureNotice } from './readonly-failure-relay.js';

const steps = { auth: { open: 1, read: 2, close: 3 }, hub: { open: 4, read: 5, close: 6 } } as const;
const points = { 'main-identity': 1, 'directory-identity': 2, 'sidecar-identity': 3,
  'database-open': 4, 'configure-readonly': 5, protocol: 6, 'snapshot-read': 7, reply: 8, close: 9 } as const;
export type ReadonlyOwnerFailurePoint = keyof typeof points;

/** Original read-only thread evidence before sanitization. No exception text,
 * SQL, path, identity or credential crosses the diagnostic boundary. Numeric
 * classification is never proof of close/exit, permission or writer recovery.
 * Hub snapshot reads retain their separate pre-sanitization SQL diagnostic. */
export function reportReadonlySqlOwnerFailure(owner: 'auth' | 'hub', phase: 'open' | 'read' | 'close', error: unknown,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, point?: ReadonlyOwnerFailurePoint,
  relay?: (notice: ReadonlySqlFailureNotice) => void): void {
  const code = sqlFailureCode(error);
  const notice: ReadonlySqlFailureNotice = { kind: 'readonly-owner-failure', step: steps[owner][phase],
    ...(code === undefined ? {} : { sqlErrorCode: code }),
    ...(point === undefined ? {} : { ownerFailureCode: points[point] }) };
  observeReadonlySqlFailure(notice, diagnostics);
  try { relay?.(notice); } catch { /* Log transport cannot interrupt original cleanup. */ }
}
