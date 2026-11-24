import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';

/** Observation of a readonly HTTP aggregation, NOT original SQL settlement,
 * authority, retry permission or evidence that a worker has exited. The one
 * delayed pending sample and final sample share a trace; no IDs or exceptions.
 * Success means the response was constructed, not delivered to the client. */
export function observeSessionState(signal: AbortSignal,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, pendingMs = 1_000) {
  return observeHubAggregation('hub-session-state-read', signal, diagnostics, pendingMs);
}

export function observeHubAggregation(operation: 'hub-session-state-read' | 'hub-connector-users-read',
  signal: AbortSignal, diagnostics: PerformanceDiagnostics = performanceDiagnostics, pendingMs = 1_000) {
  let trace: PerformanceTrace | undefined, step = 1, changed = false, finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observe = (action: () => void) => { try { action(); } catch { /* Diagnostics cannot affect delivery. */ } };
  observe(() => { trace = diagnostics.start(operation); });
  observe(() => {
    timer = setTimeout(() => {
      if (finished) return;
      observe(() => trace?.reportPending({ step, pending: 1, ...(signal.aborted ? { cancelled: 1 } : {}) }));
    }, pendingMs);
    timer.unref?.();
  });
  return {
    admission(pending: number, admitted: boolean) {
      if (finished) return;
      observe(() => { trace?.add('pending', pending); trace?.add('admitted', admitted ? 1 : 0); });
    },
    responseBudget(bytes: number, refused: boolean) {
      if (finished) return;
      observe(() => { trace?.add('snapshotBytes', bytes); if (refused) trace?.add('busy', 1); });
    },
    stage(next: 1 | 2 | 3 | 4 | 5) { if (!finished) step = next; },
    changed() { if (!finished) changed = true; },
    finish(success: boolean, records = 0) {
      if (finished) return;
      finished = true;
      observe(() => { clearTimeout(timer); });
      observe(() => {
        trace?.add('step', step);
        if (signal.aborted) trace?.add('cancelled', 1);
        if (changed) trace?.add('changed', 1);
        if (!success) trace?.add('deferred', 1);
        trace?.add('records', records);
        trace?.finish(!success);
      });
    },
  };
}
