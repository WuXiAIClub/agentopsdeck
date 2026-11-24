import { types } from 'node:util';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Identity at an original synchronous effect boundary, not an async preflight.
 * Only a nonempty string is an actor. Never inspect arbitrary thenables, await
 * a principal, or use object identity as authorization. Failure closes access;
 * diagnostics cannot grant it or start a replacement lookup. */
export function synchronousActorCall<Args extends unknown[]>(lookup: (...args: Args) => string | undefined,
  args: Args, receiver?: unknown, diagnostics: PerformanceDiagnostics = performanceDiagnostics): string | undefined {
  let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
  try { trace = diagnostics.start('auth-compatibility-check'); } catch { /* Observation is not authority. */ }
  let failed = true, unknown = false;
  try {
    if (types.isAsyncFunction(lookup)) return undefined;
    const result: unknown = Reflect.apply(lookup, receiver, args);
    if (types.isPromise(result)) {
      unknown = true;
      // Observe late rejection without calling arbitrary .then properties.
      // Constructor/species failure is still denial, never permission.
      try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* Denied regardless. */ }
      return undefined;
    }
    if (typeof result !== 'string' || result.length === 0) return undefined;
    failed = false;
    return result;
  } catch { return undefined; }
  finally {
    try {
      trace?.add('step', 5);
      if (failed) trace?.add(unknown ? 'unknown' : 'deferred', 1);
      trace?.finish(failed);
    } catch { /* Never replace the original authorization result. */ }
  }
}
