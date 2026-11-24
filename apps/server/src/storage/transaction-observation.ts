import type { PerformanceDiagnostics, PerformanceTrace } from '../diagnostics/performance.js';

/** Transaction diagnostics are observation only. Neither method invocation nor
 * a diagnostic property getter may replace SQL's result, skip original rollback,
 * or promote a successful cleanup to an unknown outcome. Preserve the normal
 * trace identity and delivery policy; never retry the observer or business work.
 * This does not authorize SQL reentry, settlement, recovery or a new owner. */
export function transactionObservation(diagnostics: PerformanceDiagnostics,
  operation: Parameters<PerformanceDiagnostics['start']>[0]): PerformanceTrace {
  let trace: PerformanceTrace | undefined;
  const observe = (action: () => void) => {
    try { action(); } catch { /* Logging is not transaction authority. */ }
  };
  observe(() => { trace = diagnostics.start(operation); });
  return {
    add: (metric, value) => observe(() => trace?.add(metric, value)),
    reportPending: snapshot => observe(() => trace?.reportPending(snapshot)),
    finish: failed => observe(() => trace?.finish(failed)),
  };
}
