import { types } from 'node:util';
import { AuthPersistenceError } from './private-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';

/** Read-only permission check at the original synchronous mutation boundary.
 * A Promise is not a grant. This callback must not be serialized to a worker
 * or replaced with a cached preflight when its owning connection migrates. */
export function synchronousAuthorization(check?: () => boolean, inspectParticipant?: (value: unknown) => void): boolean {
  if (check === undefined) return true; // Trusted non-route callers retain their contract.
  return synchronousAuthorizationCall(check, [], inspectParticipant);
}

/** Preserve the original callable for async-function detection. Binding first
 * hides that identity on Node, so argument-bearing guards must enter here. */
export function synchronousAuthorizationCall<Args extends unknown[]>(check: (...args: Args) => boolean,
  args: Args, inspectParticipant?: (value: unknown) => void, receiver?: unknown,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): boolean {
  // Observation cannot change a permission decision or skip original native
  // rejection inspection. Never retry either the observer or the guard.
  let observed: PerformanceTrace | undefined;
  const observe = (work: () => void) => { try { work(); } catch { /* Observation is not authority. */ } };
  observe(() => { observed = diagnostics.start('auth-compatibility-check'); });
  const trace = {
    add: (metric: Parameters<PerformanceTrace['add']>[0], value: number) => observe(() => observed?.add(metric, value)),
    finish: (failed: boolean) => observe(() => observed?.finish(failed)),
  };
  let failed = false, step = 1;
  try {
    if (types.isAsyncFunction(check)) {
      trace.add('deferred', 1); failed = true; return false; // Do not start an async guard.
    }
    step = 2;
    const result: unknown = Reflect.apply(check, receiver, args);
    step = 3;
    const promised = types.isPromise(result);
    if (promised) {
      trace.add('unknown', 1); failed = true;
    }
    // SQL callers must inspect on their ORIGINAL transaction owner before a
    // returned Promise is converted to denial and its continuation discarded.
    // Non-SQL callers retain the literal-true, no-thenable-inspection contract.
    try { inspectParticipant?.(result); }
    finally {
      // First latch original SQL authority: intrinsic .then can invoke a
      // constructor/species getter. Observe rejection even if inspection
      // throws, without granting authority or calling an arbitrary thenable.
      if (promised) {
        try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* Denied regardless. */ }
      }
    }
    step = 4;
    return result === true;
  } catch { failed = true; throw new AuthPersistenceError(); }
  finally { trace.add('step', step); trace.finish(failed); }
}
