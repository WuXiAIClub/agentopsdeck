import { types } from 'node:util';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export class SynchronousEffectAuthorityError extends Error {
  constructor() { super('Synchronous effect authorization is unavailable'); }
}

/** Original void-or-throw authority at a native effect boundary. This is not
 * an async preflight or a cached grant. Keep guard and effect in one turn.
 * Pass the original callback: wrapping first hides async-function identity.
 * A returned Promise never authorizes the effect or proves writer settlement.
 */
export function synchronousEffectAuthority(check?: () => void,
  invalid: () => Error = () => new SynchronousEffectAuthorityError(),
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): void {
  if (check === undefined) return;
  checkEffectAuthority(check, invalid, diagnostics);
}

/** Required native authority cannot inherit the optional trusted-caller path.
 * Keep the original function identity; do not bind or wrap an async callback. */
export function requiredSynchronousEffectAuthority(check: () => void,
  invalid: () => Error = () => new SynchronousEffectAuthorityError(),
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): void {
  checkEffectAuthority(check, invalid, diagnostics);
}

function checkEffectAuthority(check: () => void, invalid: () => Error, diagnostics: PerformanceDiagnostics): void {
  const trace = guardedTrace(diagnostics, 'auth-compatibility-check');
  let failed = true;
  try {
    if (typeof check !== 'function' || types.isAsyncFunction(check)) {
      trace.add('deferred', 1);
      throw invalid(); // Do not start the async callback's body.
    }
    const result: unknown = check(); // Preserve original synchronous throws.
    if (result !== undefined) {
      if (types.isPromise(result)) {
        trace.add('unknown', 1);
        // Never inspect arbitrary thenables. Observe native late rejection;
        // a hostile constructor/species getter still cannot authorize work.
        try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* Denied regardless. */ }
      } else trace.add('deferred', 1);
      throw invalid();
    }
    failed = false;
  } finally {
    trace.add('step', 6);
    trace.finish(failed);
  }
}
