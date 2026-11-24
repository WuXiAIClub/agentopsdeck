import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { sqlFailureCode } from '../storage/sql-failure-diagnostics.js';
import { observeSqlOwnerFailure, type SqlOwnerFailureNotice } from '../storage/sql-owner-failure-relay.js';
import type { StandaloneAuthKind } from './standalone-owner-domain.js';

// Fixed, non-secret phases. Do not derive these from input or array ordering.
const steps: Record<StandaloneAuthKind | 'open' | 'close', number> = {
  open: 0, status: 1, list: 2, authorized: 3, sessionCurrent: 4, accessKeySession: 5,
  issueAdministratorSession: 6, deleteSession: 7, clearSessions: 8, credentialCurrent: 9,
  revoke: 10, registrationOptions: 11, authenticationOptions: 12,
  verifyRegistration: 13, verifyAuthentication: 14, close: 15,
  originalJsonSession: 16, originalJsonAuthorized: 17, issueUnrestrictedSession: 18, currentKeyBinding: 19,
  localPreference: 20, localPreferenceSnapshot: 21,
};

/** Original owner evidence before a sanitized negative ACK (or startup exit).
 * Never returns retry/recovery authority or forwards exception text. */
export function reportSqliteAuthOwnerFailure(kind: StandaloneAuthKind | 'open' | 'close', error: unknown,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, relay?: (notice: SqlOwnerFailureNotice) => void): void {
  const code = sqlFailureCode(error);
  const notice: SqlOwnerFailureNotice = { kind: 'sql-owner-failure', owner: 'auth', step: steps[kind],
    ...(code === undefined ? {} : { sqlErrorCode: code }) };
  observeSqlOwnerFailure(notice, diagnostics);
  try { relay?.(notice); } catch { /* Transport cannot interrupt original cleanup or ACK. */ }
}
