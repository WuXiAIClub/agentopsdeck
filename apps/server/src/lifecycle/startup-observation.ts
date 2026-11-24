import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

// Stable numeric steps only: never include paths, SQL, native output or errors.
export type StartupStep = 1 | 2 | 3 | 4 | 5 | 6;

/** Observe an already authorized background startup task. A pending warning is
 * not a deadline, cancellation or recovery authority. Failure is consumed here
 * to prevent an unhandled rejection, not retried or converted into success.
 * The caller retains the original owner and all its durable execution fences.
 */
export function observeBackgroundStartup(step: StartupStep, work: () => void | Promise<void>,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000): Promise<boolean> {
  const trace = guardedTrace(diagnostics, 'connector-startup-task');
  trace.add('step', step);
  const warning = setTimeout(() => trace.reportPending({ pending: 1 }), warningMs);
  warning.unref();
  let result: Promise<void>;
  try { result = Promise.resolve(work()); }
  catch (error) { result = Promise.reject(error); }
  return result.then(() => {
    clearTimeout(warning); trace.add('settled', 1); trace.finish(); return true;
  }, () => {
    clearTimeout(warning); trace.add('unknown', 1); trace.finish(true); return false;
  });
}

/** A caught sub-step is still a failure even if independent startup continues. */
export function reportStartupFailure(step: StartupStep, diagnostics: PerformanceDiagnostics = performanceDiagnostics): void {
  const trace = guardedTrace(diagnostics, 'connector-startup-task');
  trace.add('step', step); trace.add('unknown', 1); trace.finish(true);
}
