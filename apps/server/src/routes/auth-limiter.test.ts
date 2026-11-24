import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PasskeyManager } from '../auth/passkeys.js';
import { AuthAuditLog, LoginAttemptLimiter } from '../auth/security.js';
import { registerAuthRoutes } from './auth.js';
import { authRequestSource } from '../auth/request-source.js';

function harness(maxBuckets = 2) {
  let now = 1_000;
  const limiter = new LoginAttemptLimiter({ maxBuckets, maxFailures: 2, windowMs: 60_000, lockoutMs: 30_000, now: () => now });
  const auditLog = new AuthAuditLog();
  const sessions = new Set<string>();
  const memberAttempts: Array<string | undefined> = [];
  const app = new Hono();
  app.use('*', authRequestSource());
  registerAuthRoutes(app, {
    accessKey: 'test-administrator-key',
    passkeys: { status: () => ({ available: false, count: 0 }) } as PasskeyManager,
    sessions,
    isAuthorizedRequest: () => false,
    auditLog,
    loginLimiter: limiter,
    lockoutSeconds: 30,
    memberLogin: key => {
      memberAttempts.push(key);
      return key === 'hub_key_test-member' ? 'test-member-session' : undefined;
    },
    memberSessionCurrent: token => token === 'test-member-session',
  });
  const headers = (subject: string) => ({ 'content-type': 'application/json', 'user-agent': subject, 'x-forwarded-for': '192.0.2.1' });
  const peers = new Map<string, string>();
  const environment = (subject: string) => {
    if (!peers.has(subject)) peers.set(subject, `192.0.2.${peers.size + 1}`);
    return { incoming: { socket: { remoteAddress: peers.get(subject) } } };
  };
  const login = (subject: string, accessKey = 'wrong-test-key') => app.request('/api/auth/login', {
    method: 'POST', headers: headers(subject), body: JSON.stringify({ accessKey }),
  }, environment(subject));
  return { app, limiter, auditLog, sessions, memberAttempts, headers, login, environment, advance: (ms: number) => { now += ms; } };
}

test('login saturation returns consistent 429/audit and does not evict a known subject', async () => {
  const h = harness(1);
  assert.equal((await h.login('known')).status, 401);
  assert.equal((await h.login('new-1')).status, 401);
  const overflow = await h.login('new-2');
  assert.equal(overflow.status, 429);
  assert.equal(overflow.headers.get('retry-after'), '30');
  assert.deepEqual(await overflow.json(), { error: 'too_many_attempts', retryAfterSeconds: 30 });
  const before = h.memberAttempts.length;
  const blocked = await h.login('new-3', 'hub_key_test-member');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('set-cookie'), null);
  assert.equal(h.memberAttempts.length, before);
  assert.equal((await h.login('known', 'test-administrator-key')).status, 200);
  assert.equal(h.sessions.size, 1);
  // A freed slot and valid credentials cannot clear shared overflow evidence.
  assert.equal((await h.login('new-4', 'test-administrator-key')).status, 429);
  const event = h.auditLog.list(1)[0]!;
  assert.equal(event.outcome, 'throttled');
  assert.equal(event.failureCount, 2);
  assert.equal(event.retryAfterSeconds, 30);
  assert.doesNotMatch(JSON.stringify(h.auditLog.list()), /test-administrator-key|hub_key_test-member|wrong-test-key|192\.0\.2\.1|new-4/);
  h.advance(60_001);
  const recovered = await h.login('new-4', 'test-administrator-key');
  assert.equal(recovered.status, 200);
  assert.ok(recovered.headers.get('set-cookie'));
});

for (const key of ['wrong-test-key', 'test-administrator-key', 'hub_key_test-member']) {
  test(`pending login rechecks a newly established ban before credential side effects (${key.startsWith('hub_') ? 'member' : key.startsWith('wrong') ? 'invalid' : 'admin'})`, async context => {
    const h = harness();
    let observed!: () => void;
    const firstCheck = new Promise<void>(resolve => { observed = resolve; });
    const check = h.limiter.check.bind(h.limiter);
    context.mock.method(h.limiter, 'check', (subject: string) => {
      const result = check(subject);
      observed();
      return result;
    });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    context.after(() => { try { body.close(); } catch { /* Already consumed. */ } });
    const pending = h.app.request(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: h.headers('same'), body: stream, duplex: 'half',
    } as RequestInit & { duplex: 'half' }), undefined, h.environment('same'));
    await firstCheck;
    assert.equal((await h.login('same')).status, 401);
    assert.equal((await h.login('same')).status, 429);
    h.advance(10_000);
    const before = h.memberAttempts.length;
    body.enqueue(new TextEncoder().encode(JSON.stringify({ accessKey: key })));
    body.close();
    const response = await pending;
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '20');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(h.memberAttempts.length, before);
    assert.equal(h.sessions.size, 0);
    const event = h.auditLog.list(1)[0]!;
    assert.equal(event.failureCount, 2);
    assert.equal(event.reason, 'too_many_failures');
    assert.equal(event.retryAfterSeconds, 20);
  });
}

test('malformed and null JSON count as failed logins instead of throwing', async () => {
  const h = harness();
  for (const [body, expected] of [['null', 401], ['{invalid', 429]] as const) {
    const response = await h.app.request('/api/auth/login', { method: 'POST', headers: h.headers('same'), body });
    assert.equal(response.status, expected);
  }
  assert.equal(h.sessions.size, 0);
});

test('successful independent subjects still create their original admin/member sessions', async () => {
  const h = harness();
  for (const key of ['test-administrator-key', 'hub_key_test-member']) {
    assert.equal((await h.login(key)).status, 401);
    const success = await h.login(key, key);
    assert.equal(success.status, 200);
    assert.ok(success.headers.get('set-cookie'));
    assert.equal((await h.login(key)).status, 401);
  }
  assert.equal(h.sessions.size, 1);
  assert.equal(h.auditLog.list().filter(e => e.outcome === 'success').length, 2);
});
