import type { PerformanceDiagnostics, PerformanceTrace } from './performance.js';

/** Diagnostics are observations, never an acknowledgement or recovery owner.
 * Guard each callback separately so a broken clock/sink cannot skip work,
 * strand a published flight or replace its original failure. */
export function guardedTrace(diagnostics: PerformanceDiagnostics,
  operation: Parameters<PerformanceDiagnostics['start']>[0]): PerformanceTrace {
  let trace: PerformanceTrace | undefined;
  try { trace = diagnostics.start(operation); } catch { /* Original work still owns its result. */ }
  return {
    add(metric, value) { try { trace?.add(metric, value); } catch { /* Observation only. */ } },
    reportPending(metrics) { try { trace?.reportPending(metrics); } catch { /* Not a release deadline. */ } },
    finish(failed) { try { trace?.finish(failed); } catch { /* Original ACK remains authoritative. */ } },
  };
}
