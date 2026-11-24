import { types } from 'node:util';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type State = 'open' | 'draining' | 'drain-failed' | 'closing' | 'close-required' | 'close-outcome-unknown' | 'closed';
type Drain = () => void | Promise<void>;
export type StorageOwnerClose = (() => void | Promise<void>) & {
  snapshot: () => Readonly<{ state: State; active: boolean; pending: number; attempts: number }>;
};

/** Stop the original independent consumers before closing their one connection.
 * A void drain is a synchronous, confirmed idle ACK, never a cached preflight.
 * Retain pending drains and their original outcome; failure does not authorize
 * SQL close, replay, reconnect or cancellation. Retry is allowed only for the
 * original connection's synchronous close after all consumers confirmed idle.
 * Parent HTTP/background admissions must already have been fenced by shutdown.
 */
export function createStorageOwnerClose(drains: readonly Drain[], closeConnection: () => void,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000): StorageOwnerClose {
  if (!Number.isSafeInteger(warningMs) || warningMs < 1000 || warningMs > 86_400_000
    || drains.length > 32 || types.isAsyncFunction(closeConnection)) throw Error('Invalid storage owner close configuration');
  const steps = [...drains];
  let state: State = 'open', flight: Promise<void> | undefined, pending = 0, attempts = 0;
  let drainFailure: { error: unknown } | undefined;
  let closeFailure: { error: unknown } | undefined;
  const close = () => {
    if (flight) return flight;
    if (state === 'closed') return;
    let resolveAttempt!: () => void, rejectAttempt!: (error: unknown) => void;
    const active = new Promise<void>((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject; });
    // Reentrant abort/diagnostic callbacks cannot start another close attempt.
    flight = active; attempts++;
    // Diagnostics are not drain/exit evidence. A failed observer must neither
    // retain an otherwise settled attempt nor replace the original failure.
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    const observe = (action: () => void) => { try { action(); } catch { /* Observation only. */ } };
    observe(() => { trace = diagnostics.start('storage-owner-close'); });
    let step = 1;
    const warning = setTimeout(() => observe(() => trace?.reportPending({ pending, step })), warningMs);
    warning.unref();
    const finish = (failure?: { error: unknown }) => {
      clearTimeout(warning); observe(() => trace?.add('pending', pending));
      observe(() => { if (failure) trace?.add('unknown', 1); else trace?.add('settled', 1); });
      // Keep the attempt installed through diagnostic sink reentrancy.
      observe(() => trace?.finish(!!failure)); flight = undefined;
      if (failure) rejectAttempt(failure.error); else resolveAttempt();
    };
    const finishConnection = () => {
      if (drainFailure) { state = 'drain-failed'; throw drainFailure.error; }
      if (closeFailure) { state = 'close-outcome-unknown'; throw closeFailure.error; }
      state = 'closing'; step = 2; observe(() => trace?.add('step', step));
      try {
        const result: unknown = closeConnection();
        if (result !== undefined) {
          // No asynchronous/malformed close can be claimed as synchronous
          // proof or invoked again while its original outcome is unknown.
          closeFailure = { error: Error('Invalid storage close acknowledgement') };
          if (types.isPromise(result)) {
            try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* Remain fenced. */ }
          }
          throw closeFailure.error;
        }
        state = 'closed';
      }
      catch (error) { state = closeFailure ? 'close-outcome-unknown' : 'close-required'; throw error; }
    };
    try {
      const waiting: Promise<void>[] = [];
      if (state === 'open') {
        state = 'draining'; observe(() => trace?.add('step', step));
        // Start every original stop-and-drain lane, even if an earlier one
        // throws or stays pending. Never close while another is still running.
        for (const drain of steps) {
          try {
            const result = drain();
            if (result === undefined) continue;
            if (!types.isPromise(result)) throw Error('Invalid storage drain acknowledgement');
            pending++;
            // Do not read a drain-owned then/finally accessor or let a
            // subclass's returned observer become the authority for idle.
            // An unobservable native Promise remains a failed drain, never
            // connection-close proof, even if its original work later ends.
            const observed = new Promise<void>(resolve => {
              try {
                void Promise.prototype.then.call(result, (value: unknown) => {
                  if (value !== undefined) drainFailure ??= { error: Error('Invalid storage drain acknowledgement') };
                  resolve();
                }, (error: unknown) => { drainFailure ??= { error }; resolve(); });
              } catch (error) { drainFailure ??= { error }; resolve(); }
            }).then(() => { pending--; });
            waiting.push(observed);
          } catch (error) { drainFailure ??= { error }; }
        }
      }
      if (waiting.length) {
        void Promise.allSettled(waiting).then(() => {
          try { finishConnection(); finish(); }
          catch (error) { finish({ error }); }
        });
        return active;
      }
      finishConnection(); finish();
      return;
    } catch (error) {
      // Synchronous callers retain their original throwing close contract.
      // Reentrant callers can already hold active, so settle it too and observe
      // its rejection without inspecting/coercing the original error.
      void active.catch(() => {});
      finish({ error });
      throw error;
    }
  };
  return Object.assign(close, { snapshot: () => Object.freeze({ state, active: !!flight, pending, attempts }) });
}
