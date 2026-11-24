import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { AuthAuditLog, LoginAttemptLimiter } from '../auth/security.js';
import type { LoginAttemptDecision } from '../auth/security.js';
import type { AuthPasskeyStore, AuthRouteLoginLimiter } from '../auth/route-persistence.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from './auth.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(readWaitMs = 1000) {
  const records = new AuthAuditLog(), logs: string[] = [], sessions = new Set<string>();
  const passkeys: AuthPasskeyStore = {
    status: () => ({ available: true, count: 0 }), list: () => [], revoke: () => false,
    registrationOptions: async () => { throw Error('Unexpected registration'); },
    verifyRegistration: async () => { throw Error('Unexpected registration'); },
    authenticationOptions: async () => { throw Error('Unexpected authentication'); },
    verifyAuthentication: async () => { throw Error('Unexpected authentication'); },
  };
  const limiter = new LoginAttemptLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 1000 });
  // The port still delegates to the original owner; no second limiter bucket.
  const injected: AuthRouteLoginLimiter = {
    check: subject => limiter.check(subject),
    recordFailure: subject => limiter.recordFailure(subject),
    recordSuccess: subject => limiter.recordSuccess(subject),
  };
  const deps = { accessKey: 'fixture-key', passkeys, sessions, auditLog: records,
    loginLimiter: injected, isAuthorizedRequest: () => true, lockoutSeconds: 1,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)), readWaitMs };
  const app = new Hono(); registerAuthRoutes(app, deps);
  const login = (key = 'fixture-key', signal?: AbortSignal) => Promise.resolve(app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }),
    ...(signal ? { signal } : {}),
  }));
  return { app, deps, records, logs, sessions, injected, login };
}

test('login awaits original limiter check before reading body or issuing a session', async () => {
  const h = fixture(), pending = deferred<LoginAttemptDecision>(); let calls = 0, settled = false;
  h.injected.check = () => { calls++; return calls === 1 ? pending.promise : { allowed: true, failureCount: 0 }; };
  const request = h.login(); void request.then(() => { settled = true; });
  try {
    await turn(); assert.equal(settled, false); assert.equal(calls, 1); assert.equal(h.sessions.size, 0);
  } finally { pending.resolve({ allowed: true, failureCount: 0 }); }
  const response = await request; assert.equal(response.status, 200); assert.equal(calls, 2);
  assert.equal(h.sessions.size, 1); assert.ok(response.headers.has('set-cookie'));
});

test('after-body awaited limiter recheck observes a new ban without creating a session', async () => {
  const h = fixture(), pending = deferred<LoginAttemptDecision>(); let calls = 0, settled = false;
  h.injected.check = () => ++calls === 1 ? { allowed: true, failureCount: 0 } : pending.promise;
  const request = h.login(); void request.then(() => { settled = true; });
  try { await turn(); assert.equal(calls, 2); assert.equal(settled, false); assert.equal(h.sessions.size, 0); }
  finally { pending.resolve({ allowed: false, failureCount: 2, retryAfterSeconds: 3 }); }
  const response = await request;
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(h.sessions.size, 0); assert.equal(h.records.list()[0]!.outcome, 'throttled');
  assert.equal(response.headers.has('set-cookie'), false);
});

for (const operation of ['check', 'recordFailure', 'recordSuccess'] as const)
  for (const outcome of ['reject', 'invalid-ack'] as const)
    test(`limiter ${operation} ${outcome} is observed without replay or cookie`, async () => {
      const h = fixture(); let calls = 0;
      const work = () => {
        calls++;
        return outcome === 'reject' ? Promise.reject(Error('private-token-SQL-path'))
          : Promise.resolve(operation === 'recordSuccess' ? true : { allowed: 'true', failureCount: 0 });
      };
      // Deliberately malformed domain ACK at the untrusted persistence boundary.
      Object.assign(h.injected, { [operation]: work });
      const response = await h.login(operation === 'recordFailure' ? 'invalid' : undefined);
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
      assert.equal(calls, 1); assert.equal(h.records.list().length, 0);
      assert.equal(response.headers.has('set-cookie'), false);
      const step = operation === 'check' ? 17 : operation === 'recordFailure' ? 18 : 19;
      assert.ok(h.logs.map(line => JSON.parse(line)).some(event => event.step === step && event.unknown === 1));
      assert.doesNotMatch(h.logs.join('\n'), /private-token|SQL-path|fixture-key/);
    });

test('key rotation during after-body policy wait cannot start old session issuance', async () => {
  const h = fixture(), pending = deferred<LoginAttemptDecision>(); let checks = 0;
  h.injected.check = () => ++checks === 1 ? { allowed: true, failureCount: 0 } : pending.promise;
  const request = h.login();
  try { await turn(); h.deps.accessKey = 'rotated-key'; }
  finally { pending.resolve({ allowed: true, failureCount: 0 }); }
  const response = await request;
  assert.equal(response.status, 401); assert.equal(h.sessions.size, 0); assert.equal(h.records.list().length, 0);
});

test('key rotation during original success accounting refuses cookie without replaying issuance', async () => {
  const h = fixture(), pending = deferred<void>(); let calls = 0;
  h.injected.recordSuccess = () => { calls++; return pending.promise; };
  const request = h.login();
  try { await turn(); assert.equal(h.sessions.size, 1); h.deps.accessKey = 'rotated-key'; }
  finally { pending.resolve(); }
  const response = await request;
  assert.equal(response.status, 401); assert.equal(calls, 1); assert.equal(h.sessions.size, 1);
  assert.equal(response.headers.has('set-cookie'), false);
});

test('original persistent limiter failures and lockout remain authoritative through awaited port', async () => {
  const h = fixture();
  assert.equal((await h.login('wrong')).status, 401);
  assert.equal((await h.login('wrong')).status, 429);
  const response = await h.login();
  assert.equal(response.status, 429); assert.equal(h.sessions.size, 0);
  assert.equal(response.headers.has('set-cookie'), false);
});

for (const operation of ['recordFailure', 'recordSuccess'] as const)
  test(`cancel during ${operation} keeps request pending until the original write settles`, async () => {
    const h = fixture(), pending = deferred<void | LoginAttemptDecision>(), abort = new AbortController();
    let calls = 0, settled = false;
    Object.assign(h.injected, { [operation]: () => { calls++; return pending.promise; } });
    const request = h.login(operation === 'recordFailure' ? 'invalid' : undefined, abort.signal);
    void request.then(() => { settled = true; });
    try {
      await turn(); assert.equal(calls, 1); abort.abort(); await turn();
      assert.equal(settled, false); assert.equal(h.records.list().length, 0);
    } finally { pending.resolve(operation === 'recordFailure' ? { allowed: true, failureCount: 1 } : undefined); }
    const response = await request;
    assert.equal(response.status, 408); assert.equal(calls, 1); assert.equal(response.headers.has('set-cookie'), false);
  });

test('invalid login awaits original failure accounting once before status and audit', async () => {
  const h = fixture(), pending = deferred<LoginAttemptDecision>(); let calls = 0, settled = false;
  h.injected.recordFailure = () => { calls++; return pending.promise; };
  const request = h.login('invalid'); void request.then(() => { settled = true; });
  try {
    await turn(); assert.equal(settled, false); assert.equal(calls, 1); assert.equal(h.records.list().length, 0);
  } finally { pending.resolve({ allowed: true, failureCount: 1 }); }
  const response = await request; assert.equal(response.status, 401); assert.equal(calls, 1);
  assert.equal(h.records.list()[0]!.failureCount, 1); assert.equal(h.sessions.size, 0);
});

test('successful login awaits original success accounting before audit or cookie delivery', async () => {
  const h = fixture(), pending = deferred<void>(); let calls = 0, settled = false;
  h.injected.recordSuccess = () => { calls++; return pending.promise; };
  const request = h.login(); void request.then(() => { settled = true; });
  try {
    await turn(); assert.equal(settled, false); assert.equal(calls, 1); assert.equal(h.records.list().length, 0);
    assert.equal(h.sessions.size, 1);
  } finally { pending.resolve(); }
  const response = await request; assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(h.records.list().length, 1); assert.ok(response.headers.has('set-cookie'));
});
