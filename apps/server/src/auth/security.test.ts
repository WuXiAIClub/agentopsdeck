import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthAuditLog,
  LoginAttemptLimiter,
  PasskeyCredentialStore,
  fingerprintRequest,
  keyIdentityHash,
  loginLimiterSubject,
} from './security.js';

test('passkey store supports multiple active credentials for one key identity', () => {
  const store = new PasskeyCredentialStore();
  const keyHash = keyIdentityHash('operator-key');

  const laptop = store.bind({ keyIdentityHash: keyHash, credentialId: 'laptop-credential-id', label: 'Laptop', transports: ['internal'] });
  const desktop = store.bind({ keyIdentityHash: keyHash, credentialId: 'desktop-credential-id', label: 'Desktop', transports: ['usb', 'usb'] });

  const passkeys = store.list(keyHash);
  assert.equal(passkeys.length, 2);
  assert.deepEqual(passkeys.map((passkey) => passkey.label).sort(), ['Desktop', 'Laptop']);
  assert.notEqual(laptop.credentialIdHash, 'laptop-credential-id');
  assert.notEqual(desktop.credentialIdHash, 'desktop-credential-id');
  assert.deepEqual(desktop.transports, ['usb']);
});

test('passkey store revokes one device without removing sibling passkeys', () => {
  const store = new PasskeyCredentialStore();
  const keyHash = keyIdentityHash('operator-key');
  const laptop = store.bind({ keyIdentityHash: keyHash, credentialId: 'laptop-credential-id', label: 'Laptop' });
  store.bind({ keyIdentityHash: keyHash, credentialId: 'desktop-credential-id', label: 'Desktop' });

  assert.equal(store.revoke(keyHash, laptop.id), true);

  const passkeys = store.list(keyHash);
  assert.equal(passkeys.length, 1);
  assert.equal(passkeys[0]?.label, 'Desktop');
});

test('audit log stores sanitized hashes and reasons only', () => {
  const log = new AuthAuditLog();
  const request = new Request('https://deck.example.com/api/auth/login', {
    headers: {
      'x-forwarded-for': '203.0.113.50',
      'user-agent': 'UnitTestBrowser/1.0',
    },
  });
  const fingerprint = fingerprintRequest(request);

  const record = log.append({
    event: 'access_key_login',
    outcome: 'failure',
    ...fingerprint,
    reason: 'bad key with spaces and $ecret',
    failureCount: 1,
  });

  assert.equal(record.ipHash?.length, 24);
  assert.equal(record.userAgentHash?.length, 24);
  assert.doesNotMatch(JSON.stringify(record), /203\.0\.113\.50|UnitTestBrowser|\$ecret/);
  assert.equal(record.reason, 'bad_key_with_spaces_and__ecret');
});

test('login limiter throttles after threshold and resets after success', () => {
  let now = 1_000;
  const limiter = new LoginAttemptLimiter({ maxFailures: 3, windowMs: 60_000, lockoutMs: 30_000, now: () => now });
  const subject = loginLimiterSubject({ ipHash: 'ip', userAgentHash: 'ua' });

  assert.equal(limiter.check(subject).allowed, true);
  assert.equal(limiter.recordFailure(subject).allowed, true);
  assert.equal(limiter.recordFailure(subject).allowed, true);
  const blocked = limiter.recordFailure(subject);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.failureCount, 3);
  assert.equal(blocked.retryAfterSeconds, 30);
  assert.equal(limiter.check(subject).allowed, false);

  now += 31_000;
  assert.equal(limiter.check(subject).allowed, true);
  limiter.recordSuccess(subject);
  assert.equal(limiter.check(subject).failureCount, 0);
});

function limitedLogin(options: { maxBuckets?: number; maxFailures?: number; windowMs?: number; lockoutMs?: number } = {}) {
  let now = 1_000;
  return {
    limiter: new LoginAttemptLimiter({ maxBuckets: 2, maxFailures: 2, windowMs: 60_000, lockoutMs: 30_000, ...options, now: () => now }),
    advance: (ms: number) => { now += ms; },
  };
}

test('login preflight does not consume bucket capacity', () => {
  const { limiter } = limitedLogin({ maxBuckets: 1 });
  for (let i = 0; i < 100; i++) assert.equal(limiter.check(`check-${i}`).allowed, true);
  limiter.recordFailure('tracked');
  assert.equal(limiter.check('other').failureCount, 0);
  assert.equal(limiter.recordFailure('tracked').allowed, false);
  assert.equal(limiter.check('other').allowed, true);
});

test('capacity overflow shares bounded evidence without evicting existing bans', () => {
  const { limiter } = limitedLogin();
  for (const subject of ['a', 'b']) {
    limiter.recordFailure(subject);
    limiter.recordFailure(subject);
  }
  assert.equal(limiter.recordFailure('overflow-1').allowed, true);
  assert.equal(limiter.recordFailure('overflow-2').allowed, false);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(limiter.check(`overflow-${i}`), { allowed: false, failureCount: 2, retryAfterSeconds: 30 });
  }
  assert.equal(limiter.check('a').allowed, false);
  assert.equal(limiter.check('b').allowed, false);
});

test('overflow leaves tracked subjects independent and success cannot erase shared failures', () => {
  const { limiter } = limitedLogin({ maxBuckets: 1 });
  limiter.recordFailure('tracked');
  limiter.recordFailure('overflow-1');
  limiter.recordSuccess('overflow-1');
  assert.equal(limiter.check('overflow-2').failureCount, 1);
  limiter.recordFailure('overflow-2');
  assert.equal(limiter.check('tracked').allowed, true);
  limiter.recordSuccess('tracked');
  // Freeing capacity must not provide a way to discard the active overflow ban.
  assert.equal(limiter.check('new').allowed, false);
  assert.equal(limiter.recordFailure('new').allowed, false);
});

test('locked and already admitted concurrent failures neither grow nor extend a ban', () => {
  const { limiter, advance } = limitedLogin({ maxBuckets: 1 });
  limiter.recordFailure('a');
  limiter.recordFailure('a');
  advance(10_000);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(limiter.recordFailure('a'), { allowed: false, failureCount: 2, retryAfterSeconds: 20 });
  }
  advance(20_000);
  assert.equal(limiter.check('a').allowed, true);
  // The window still contains failures, but its timestamp list remains capped.
  assert.deepEqual(limiter.recordFailure('a'), { allowed: false, failureCount: 2, retryAfterSeconds: 30 });
});

test('inactive buckets expire without revisiting their subjects, preserving the inclusive window boundary', () => {
  const { limiter, advance } = limitedLogin({ maxBuckets: 1, windowMs: 1_000, lockoutMs: 500 });
  limiter.recordFailure('old');
  advance(1_000);
  assert.equal(limiter.check('old').failureCount, 1);
  advance(1);
  limiter.recordFailure('new');
  limiter.recordFailure('overflow-1');
  // New owns the freed slot; overflow starts at one instead of inheriting new's failure.
  assert.equal(limiter.check('overflow-2').failureCount, 1);
  assert.equal(limiter.check('new').failureCount, 1);
});

test('expiry waits for both the failure window and longer lockout', () => {
  const { limiter, advance } = limitedLogin({ maxBuckets: 1, windowMs: 1_000, lockoutMs: 5_000 });
  limiter.recordFailure('locked');
  limiter.recordFailure('locked');
  advance(1_001);
  assert.deepEqual(limiter.check('locked'), { allowed: false, failureCount: 0, retryAfterSeconds: 4 });
  advance(3_999);
  limiter.recordFailure('fresh');
  assert.equal(limiter.check('other').failureCount, 0);
  assert.equal(limiter.check('fresh').failureCount, 1);
});

test('overflow expires and incremental reclamation covers multiple sweeps', () => {
  const { limiter, advance } = limitedLogin({ maxBuckets: 100, windowMs: 1_000, lockoutMs: 500 });
  for (let i = 0; i < 100; i++) limiter.recordFailure(`old-${i}`);
  limiter.recordFailure('overflow-1');
  limiter.recordFailure('overflow-2');
  advance(1_001);
  for (let i = 0; i < 10; i++) limiter.check('sweep');
  for (let i = 0; i < 100; i++) {
    assert.equal(limiter.recordFailure(`new-${i}`).failureCount, 1);
    assert.equal(limiter.check(`new-${i}`).allowed, true);
  }
  assert.equal(limiter.check('overflow-new').failureCount, 0);
});

test('limiter state is process-local, not a claim of restart-persistent throttling', () => {
  const { limiter } = limitedLogin();
  limiter.recordFailure('a');
  limiter.recordFailure('a');
  assert.equal(limiter.check('a').allowed, false);
  assert.equal(limitedLogin().limiter.check('a').allowed, true);
});

test('default limiter cardinality is bounded even under unique failed subjects', () => {
  const limiter = new LoginAttemptLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 30_000, now: () => 1_000 });
  for (let i = 0; i < 10_000; i++) assert.equal(limiter.recordFailure(`subject-${i}`).failureCount, 1);
  assert.equal(limiter.recordFailure('overflow-a').allowed, true);
  assert.equal(limiter.recordFailure('overflow-b').allowed, false);
  assert.equal(limiter.check('unseen').allowed, false);
  assert.equal(limiter.check('subject-0').allowed, true);
});

test('invalid limiter budgets fail configuration instead of silently disabling bounds', () => {
  for (const key of ['maxBuckets', 'maxFailures', 'windowMs', 'lockoutMs']) {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => limitedLogin({ [key]: value }), /positive safe integer/);
    }
  }
});

test('expired subjects not yet swept cannot bypass a newer overflow lock', () => {
  const { limiter, advance } = limitedLogin({ maxBuckets: 1_000, windowMs: 1_000, lockoutMs: 5_000 });
  for (let i = 0; i < 1_000; i++) limiter.recordFailure(`old-${i}`);
  advance(500);
  limiter.recordFailure('overflow-a');
  limiter.recordFailure('overflow-b');
  advance(501);
  assert.equal(limiter.check('old-999').allowed, false);
  assert.equal(limiter.recordFailure('old-998').allowed, false);
});
