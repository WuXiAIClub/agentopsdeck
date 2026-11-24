import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type ShutdownState = 'open' | 'draining' | 'drain-failed' | 'cleaning' | 'cleanup-required' | 'closed';
export type ShutdownCleanup = (() => Promise<void>) & { snapshot: () => Readonly<{
  state: ShutdownState; active: boolean; attempts: number; pending: number; settled: number; step: number;
}> };

/** Shutdown-only cleanup of exact retained owners. A failed/pending drain is
 * never replayed or treated as quiescent. After its successful ACK, subsequent
 * explicit close calls retry only unacknowledged cleanup steps, sharing one
 * attempt. Callbacks must close the same owner; no business replay, replacement
 * connection, admission reset or timeout-based release is permitted. Warning
 * timers observe only: they cannot settle a Promise, replay work or release an
 * owner. A permanently pending drain/cleanup remains fenced and single-flight. */
export function createShutdownCleanup(drain: () => Promise<void>,
  cleanup: readonly (() => void | Promise<void>)[],
  diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  options: { stallWarningMs?: number; stopAfterFailure?: boolean; independent?: boolean } = {}): ShutdownCleanup {
  const warningMs = options.stallWarningMs ?? 30_000;
  if (!Number.isSafeInteger(warningMs) || warningMs < 1000 || warningMs > 86_400_000) throw Error('Invalid shutdown observation interval');
  // Independent signal-and-drain lanes must all be invoked even if another
  // stays pending. Dependent database consumers retain sequential ordering.
  const independent = options.independent === true, stopAfterFailure = options.stopAfterFailure === true;
  if (independent && stopAfterFailure) throw Error('Independent cleanup cannot stop after failure');
  // Capture callbacks once: caller mutation cannot change the retained owners.
  const steps = [...cleanup], settled = new Set<number>();
  let drained: Promise<void> | undefined, flight: Promise<void> | undefined, attempts = 0;
  let state: ShutdownState = 'open', step = 0;
  // Diagnostics are observers, not shutdown owners. Even an overridden start,
  // clock or trace method must not strand admission, replace the original
  // failure, or make an acknowledged cleanup look like work to retry.
  const observe = (action: () => void) => { try { action(); } catch { /* observation only */ } };
  const start = (operation: 'shutdown-drain' | 'shutdown-cleanup') => {
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    observe(() => { trace = diagnostics.start(operation); });
    return trace;
  };
  const close = () => {
    if (flight) return flight;
    let resolveAttempt!: () => void, rejectAttempt!: (error: unknown) => void;
    const active = new Promise<void>((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject; });
    // Install the single-flight before calling user-owned synchronous drains.
    // A reentrant close observes the same attempt, never a second shutdown.
    flight = active;
    if (!drained) {
      state = 'draining';
      const trace = start('shutdown-drain');
      const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: 1 })), warningMs);
      warning.unref();
      // Invoke synchronously so admission is fenced before close() returns.
      try { drained = Promise.resolve(drain()); }
      catch (error) { drained = Promise.reject(error); }
      drained = drained.then(() => {
        clearTimeout(warning); observe(() => trace?.add('settled', 1)); observe(() => trace?.finish());
      }, error => {
        clearTimeout(warning); state = 'drain-failed';
        observe(() => trace?.add('unknown', 1)); observe(() => trace?.finish(true)); throw error;
      });
    }
    const quiescence = drained;
    const attempt = async () => {
      await quiescence;
      if (settled.size === steps.length) { state = 'closed'; return; }
      const retry = attempts++ > 0;
      state = 'cleaning';
      const trace = start('shutdown-cleanup');
      const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: steps.length - settled.size,
        settled: settled.size, step })), warningMs);
      warning.unref();
      let failed = false, firstError: unknown;
      const acknowledge = async (index: number, close: () => void | Promise<void>) => {
        await close(); settled.add(index);
        observe(() => trace?.add(retry ? 'recovered' : 'settled', 1));
      };
      const recordFailure = (error: unknown, observed = false) => {
        if (!failed) firstError = error;
        failed = true; if (!observed) observe(() => trace?.add('unknown', 1));
      };
      try {
        if (independent) {
          // step=0 denotes independent lanes, not a sequential owner index.
          // Catch synchronous throws per lane and retain every actual Promise.
          const attempts = steps.flatMap((close, index) => settled.has(index) ? []
            : [Promise.resolve().then(() => acknowledge(index, close)).catch(error => {
              observe(() => trace?.add('unknown', 1));
              // An independent peer may never settle: expose this failure now
              // without certifying shutdown or dropping the retained attempt.
              observe(() => trace?.reportPending({ pending: steps.length - settled.size, settled: settled.size, step: 0 }));
              throw error;
            })]);
          for (const result of await Promise.allSettled(attempts)) {
            // Input order, not rejection timing, determines the first error.
            if (result.status === 'rejected') recordFailure(result.reason, true);
          }
        } else {
          for (const [index, close] of steps.entries()) {
            if (settled.has(index)) continue;
            step = index + 1;
            try { await acknowledge(index, close); }
            catch (error) {
              recordFailure(error);
              // Ordered dependent owners cannot close until their consumer ACKs.
              // A retry resumes at the first unsettled step, never replays a drain.
              if (stopAfterFailure) break;
            }
          }
        }
        if (failed) throw firstError;
      } finally {
        clearTimeout(warning); step = 0; state = failed ? 'cleanup-required' : 'closed';
        observe(() => trace?.add('pending', steps.length - settled.size)); observe(() => trace?.finish(failed));
      }
    };
    void attempt().then(() => { flight = undefined; resolveAttempt(); }, error => {
      flight = undefined; rejectAttempt(error);
    });
    return active;
  };
  return Object.assign(close, { snapshot: () => Object.freeze({ state, active: !!flight, attempts,
    pending: steps.length - settled.size, settled: settled.size, step }) });
}
