import type { LoginAttemptDecision } from './security.js';
import { AuthPersistenceError } from './private-store.js';

/** Exact detached result, not a cached permission or a live bucket reference.
 * A malformed ACK cannot become allowed by truthiness or supply private fields
 * to HTTP/audit/logs. The original mutation, if any, must never be replayed. */
export function copyLoginAttemptDecision(input: unknown): LoginAttemptDecision {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuthPersistenceError();
    const keys = Object.keys(input);
    if (keys.some(key => !['allowed', 'failureCount', 'retryAfterSeconds'].includes(key))
      || !Object.hasOwn(input, 'allowed') || !Object.hasOwn(input, 'failureCount')) throw new AuthPersistenceError();
    const { allowed, failureCount, retryAfterSeconds } = input as LoginAttemptDecision;
    if (typeof allowed !== 'boolean' || !Number.isSafeInteger(failureCount) || failureCount < 0
      || retryAfterSeconds !== undefined && (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1)) throw new AuthPersistenceError();
    return Object.freeze({ allowed, failureCount, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
  } catch { throw new AuthPersistenceError(); }
}
