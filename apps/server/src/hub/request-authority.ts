import { HTTPException } from 'hono/http-exception';
import { types } from 'node:util';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubPrincipal } from './identity.js';

/** A synchronous proof is plain own data, never a pending lookup or executable
 * accessor. Do not read .then or property values before descriptor validation. */
export function copyHubPrincipal(value: unknown): HubPrincipal | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  if (types.isPromise(value)) {
    try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Denied regardless. */ }
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => key !== 'userId' && key !== 'admin')) return undefined;
  const user = fields.userId, role = fields.admin;
  if (!user || !role || !('value' in user) || !('value' in role)
    || typeof user.value !== 'string' || !user.value || typeof role.value !== 'boolean') return undefined;
  return Object.freeze({ userId: user.value, admin: role.value });
}

/** Preserve synchronous persistence exceptions; denial must not conceal a SQL
 * failure, start an async lookup, or substitute a cached authorization grant. */
export function synchronousHubPrincipalCall<Args extends unknown[]>(lookup: (...args: Args) => HubPrincipal | undefined,
  args: Args, diagnostics: PerformanceDiagnostics = performanceDiagnostics): HubPrincipal | undefined {
  let result: HubPrincipal | undefined;
  try {
    if (!types.isProxy(lookup) && !types.isAsyncFunction(lookup)) result = copyHubPrincipal(Reflect.apply(lookup, undefined, args));
    return result;
  } finally {
    if (!result) try {
      const trace = diagnostics.start('auth-compatibility-check');
      trace.add('step', 6); trace.add('deferred', 1); trace.finish(true);
    } catch { /* Observation cannot grant authority or replace a SQL exception. */ }
  }
}

/** Pin primitive identity values, not a mutable principal object. Every check
 * still reads current authority; this snapshot is not a cached grant, a SQL
 * transaction proof or permission to release/replay an admitted command. */
export function pinHubRequestAuthority(initial: HubPrincipal, authenticate: () => HubPrincipal | undefined,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
  const proof = copyHubPrincipal(initial);
  if (!proof) throw new HTTPException(401, { message: 'unauthorized' });
  const { userId, admin } = proof;
  const principal: HubPrincipal = Object.freeze({ userId, admin });
  let observed = false;
  const refuse = (step: 1 | 2 | 3) => {
    if (!observed) {
      observed = true;
      try {
        const trace = diagnostics.start('hub-request-authority');
        trace.add('step', step); trace.add('deferred', 1); trace.finish(true);
      } catch { /* Diagnostics cannot grant authority or change a refusal. */ }
    }
    throw new HTTPException(401, { message: 'unauthorized' });
  };
  return {
    principal,
    check(): HubPrincipal {
      // Once this request observed revocation, restoring an account must not
      // resurrect its old buffered response or its pending mutation callback.
      if (observed) return refuse(1);
      const current = synchronousHubPrincipalCall(authenticate, []);
      if (!current) return refuse(1);
      if (current.userId !== userId) return refuse(2);
      if (current.admin !== admin) return refuse(3);
      // Callers never receive the mutable live object as their next proof.
      return principal;
    },
  };
}
