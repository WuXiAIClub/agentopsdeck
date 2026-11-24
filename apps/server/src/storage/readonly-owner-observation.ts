import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Fixed, private-data-free reasons. They describe a read-only observer, never
 * the shared writer's COMMIT state, authority, or permission to replay work. */
export type ReadonlyOwnerFailureCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
// 1 startup deadline, 2 worker error, 3 unexpected exit, 4 protocol refusal,
// 5 query deadline, 6 dispatch failure, 7 RPC sequence exhaustion,
// 8 close deadline, 9 termination request refused.
export function observeReadonlyOwner(diagnostics: PerformanceDiagnostics,
  operation: 'auth-display-read' | 'hub-delivery-read',
  step: 6 | 7 | 8, pending: number, failureCode?: ReadonlyOwnerFailureCode) {
  try {
    const trace = diagnostics.start(operation);
    trace.add('step', step); trace.add('pending', pending);
    if (failureCode !== undefined) trace.add('ownerFailureCode', failureCode);
    if (step === 7) trace.add('settled', 1); // Actual observer exit only.
    else if (pending > 0 || step === 8) trace.add('unknown', 1);
    trace.finish(failureCode !== undefined);
  } catch { /* Observation cannot interrupt rejection, disposal or drain. */ }
}
