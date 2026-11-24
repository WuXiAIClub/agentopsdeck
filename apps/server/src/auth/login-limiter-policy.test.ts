import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LoginAttemptLimiter, type LoginAttemptLimiterOptions } from './security.js';
import { PersistentLoginAttemptLimiter } from './persistent-login-limiter.js';

for (const persistent of [false, true]) {
  test(`limiter owns its captured policy after caller mutation (${persistent})`, () => {
    const db = persistent ? new DatabaseSync(':memory:') : undefined;
    let now = 10_000;
    const original = { maxFailures: 2, windowMs: 1_000, lockoutMs: 2_000, maxBuckets: 2, now: () => now };
    const policy = { ...original };
    const limiter = db ? new PersistentLoginAttemptLimiter(db, policy) : new LoginAttemptLimiter(policy);
    try {
      assert.equal(Object.isFrozen(policy), false, 'caller configuration is not frozen');
      limiter.recordFailure('a');
      policy.maxFailures = 100; policy.windowMs = 1; policy.lockoutMs = 1; policy.maxBuckets = 100;
      policy.now = () => 999_999;
      const banned = limiter.recordFailure('a');
      assert.deepEqual(banned, { allowed: false, failureCount: 2, retryAfterSeconds: 2 });
      if (db) {
        const peer = new PersistentLoginAttemptLimiter(db, original);
        assert.deepEqual(peer.check('a'), banned, 'persisted policy matches the captured behavior');
        // A newly constructed owner uses its own clock. Keep that clock at the
        // active ban; jumping beyond expiry legitimately permits migration.
        assert.throws(() => new PersistentLoginAttemptLimiter(db, { ...policy, now: () => now }), /policy_conflict/);
      }
      now += 1_001;
      assert.deepEqual(limiter.check('a'), { allowed: false, failureCount: 0, retryAfterSeconds: 1 });
      now += 999;
      assert.deepEqual(limiter.check('a'), { allowed: true, failureCount: 0 });
    } finally { db?.close(); }
  });

  test(`limiter captures each configuration property once before validation (${persistent})`, () => {
    const db = persistent ? new DatabaseSync(':memory:') : undefined;
    const reads: Record<string, number> = {};
    const values = { maxFailures: 2, windowMs: 1_000, lockoutMs: 2_000, maxBuckets: 2, now: () => 10_000 };
    const policy = {} as LoginAttemptLimiterOptions;
    for (const key of Object.keys(values) as (keyof typeof values)[]) {
      Object.defineProperty(policy, key, { enumerable: true, get() {
        reads[key] = (reads[key] ?? 0) + 1;
        if (reads[key] !== 1) throw Error('configuration was read after capture');
        return values[key];
      } });
    }
    try {
      const limiter = db ? new PersistentLoginAttemptLimiter(db, policy) : new LoginAttemptLimiter(policy);
      assert.equal(limiter.recordFailure('a').allowed, true);
      assert.deepEqual(limiter.recordFailure('a'), { allowed: false, failureCount: 2, retryAfterSeconds: 2 });
      assert.deepEqual(reads, { maxFailures: 1, windowMs: 1, lockoutMs: 1, maxBuckets: 1, now: 1 });
    } finally { db?.close(); }
  });
}
