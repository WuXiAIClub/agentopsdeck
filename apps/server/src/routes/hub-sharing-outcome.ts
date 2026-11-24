import { SessionShareConflict } from '../hub/node-grants.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

/** Observation only. Never retry, unlock or replace the original SQL owner. */
export function sharingOutcome<T>(step: 1 | 2 | 3 | 4 | 5 | 6, work: () => T,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): { ok: true; value: T } | { ok: false; status: 409 | 503 } {
  const trace = guardedTrace(diagnostics, 'session-share-change');trace.add('step', step);
  let failed = true;
  try { const value = work();trace.add('settled', 1);failed = false;return { ok: true, value }; }
  catch (error) {
    const definite = error instanceof SessionShareConflict;
    trace.add(definite ? 'deferred' : 'unknown', 1);
    return { ok: false, status: definite ? 409 : 503 };
  } finally { trace.finish(failed); }
}
export const SHARING_UNKNOWN = 'Could not confirm whether access was saved. Reload sharing before deciding what to do; do not automatically resubmit.';
