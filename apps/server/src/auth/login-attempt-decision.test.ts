import assert from 'node:assert/strict';
import test from 'node:test';
import { copyLoginAttemptDecision } from './login-attempt-decision.js';
import { AuthPersistenceError } from './private-store.js';

test('limiter decision is a detached frozen DTO, not a frozen original bucket', () => {
  const input = { allowed: false, failureCount: 2, retryAfterSeconds: 3 };
  const result = copyLoginAttemptDecision(input);
  input.allowed = true; input.failureCount = 0;
  assert.deepEqual(result, { allowed: false, failureCount: 2, retryAfterSeconds: 3 });
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(input), false);
});

test('limiter ACK validates exact booleans, bounded integers and own decision fields', () => {
  for (const input of [undefined, null, [], true, {}, { allowed: 'true', failureCount: 0 },
    { allowed: 1, failureCount: 0 }, { allowed: true, failureCount: -1 },
    { allowed: true, failureCount: NaN }, { allowed: true, failureCount: Infinity },
    { allowed: true, failureCount: Number.MAX_SAFE_INTEGER + 1 }, { allowed: true, failureCount: 0.5 },
    { allowed: false, failureCount: 1, retryAfterSeconds: 0 },
    { allowed: false, failureCount: 1, retryAfterSeconds: 1.5 },
    { allowed: true, failureCount: 0, secret: 'private-token' },
    Object.create({ allowed: true, failureCount: 0 })]) {
    assert.throws(() => copyLoginAttemptDecision(input), AuthPersistenceError);
  }
});

test('throwing getter and revoked proxy ACKs become only sanitized persistence errors', () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  const getter = { get allowed() { throw Error('private-token-path'); }, failureCount: 0 };
  for (const input of [proxy.proxy, getter]) assert.throws(() => copyLoginAttemptDecision(input),
    error => error instanceof AuthPersistenceError && error.message === 'auth_persistence_failed');
});
