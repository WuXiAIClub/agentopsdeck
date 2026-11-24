import { types } from 'node:util';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Drain = () => void | Promise<void>;
type Lane = 'idle' | 'pending' | 'drained' | 'failed';
export type IndependentDrain = (() => Promise<void>) & {
  snapshot: () => Readonly<{ state: 'idle' | 'draining' | 'drained' | 'failed'; pending: number; failed: number; drained: number }>;
};

/** Signal every independent original owner before waiting. A failure is not
 * permission to omit peers or replay their close. Only literal void or a native
 * Promise fulfilling void acknowledges drain. Warnings are observation only;
 * a pending lane never authorizes dependent connection close or replacement. */
export function createIndependentDrain(drains: readonly Drain[],
  operation: 'hub-route-drain' | 'auth-route-drain' | 'browser-owner-drain',
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000): IndependentDrain {
  if (drains.length > 32 || !Number.isSafeInteger(warningMs) || warningMs < 1000 || warningMs > 86_400_000) {
    throw Error('Invalid independent drain configuration');
  }
  const steps = [...drains], lanes: Lane[] = steps.map(() => 'idle');
  const failures: { error: unknown }[] = [];
  let flight: Promise<void> | undefined, settled = false;
  const close = () => {
    if (flight) return flight;
    let resolve!: () => void, reject!: (error: unknown) => void;
    // Publish before invoking an owner or diagnostic sink (both may reenter).
    flight = new Promise<void>((ok, bad) => { resolve = ok; reject = bad; });
    const waiting = steps.map((drain, index) => {
      lanes[index] = 'pending';
      const trace = guardedTrace(diagnostics, operation); trace.add('step', index + 1);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), warningMs); warning.unref();
      return new Promise<void>(done => {
        let acknowledged = false;
        const finish = (failure?: { error: unknown }) => {
          if (acknowledged) return;
          acknowledged = true; clearTimeout(warning);
          lanes[index] = failure ? 'failed' : 'drained';
          if (failure) { failures[index] = failure; trace.add('unknown', 1); }
          else trace.add('settled', 1);
          trace.finish(!!failure); done();
        };
        try {
          const result: unknown = drain();
          if (result === undefined) finish();
          else if (!types.isPromise(result)) finish({ error: Error('Invalid independent drain acknowledgement') });
          else {
            // Never read owner-controlled then/finally or assimilate thenables.
            void Promise.prototype.then.call(result, (value: unknown) => finish(value === undefined ? undefined
              : { error: Error('Invalid independent drain acknowledgement') }), (error: unknown) => finish({ error }));
          }
        } catch (error) { finish({ error }); }
      });
    });
    void Promise.all(waiting).then(() => {
      settled = true;
      const failure = failures.find(Boolean);
      if (failure) reject(failure.error); else resolve();
    });
    return flight;
  };
  return Object.assign(close, { snapshot: () => ({
    state: !flight ? 'idle' as const : !settled ? 'draining' as const : failures.some(Boolean) ? 'failed' as const : 'drained' as const,
    pending: lanes.filter(lane => lane === 'pending').length,
    failed: lanes.filter(lane => lane === 'failed').length,
    drained: lanes.filter(lane => lane === 'drained').length,
  }) });
}
