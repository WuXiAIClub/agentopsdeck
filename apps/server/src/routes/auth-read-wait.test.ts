import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from '../auth/security.js';
import type { AuthPasskeyStore } from '../auth/route-persistence.js';
import { registerAuthRoutes } from './auth.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const unsupported = async (): Promise<never> => { throw Error('Unexpected verification call'); };
function fixture(overrides: Partial<Parameters<typeof registerAuthRoutes>[1]> = {}) {
  const rows: string[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(line)), auditLog = new AuthAuditLog();
  const passkeys: AuthPasskeyStore = { status: () => ({ available: true, count: 1 }), list: () => [], revoke: () => false,
    registrationOptions: unsupported, verifyRegistration: unsupported, authenticationOptions: unsupported, verifyAuthentication: unsupported };
  const deps = { accessKey: 'fixture-key', passkeys, sessions: new Set<string>(), isAuthorizedRequest: () => true,
    diagnostics, auditLog, readWaitMs: 10,
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }), lockoutSeconds: 1, ...overrides };
  const app = new Hono(), owner = registerAuthRoutes(app, deps); return { app, owner, deps, passkeys, diagnostics, auditLog, rows };
}
async function bounded(response: Promise<Response> | Response) {
  return Promise.race([response, delay(200).then(() => 'STILL_WAITING' as const)]);
}

for (const outcome of ['resolve', 'reject'] as const) test(`auth route close retains timed-out ${outcome} original`, async () => {
  const gate = held<{ available: boolean; count: number }>(); let calls = 0, closed = false;
  const h = fixture(); h.passkeys.status = () => { calls++; return gate.promise; };
  const response = await h.app.request('/api/auth/status');
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
  const closing = h.owner.close(); void closing.then(() => { closed = true; });
  assert.equal(h.owner.close(), closing); await tick();
  assert.equal(closed, false); assert.equal(h.owner.pending, 1);
  assert.equal((await h.app.request('/api/auth/status')).status, 503); assert.equal(calls, 1);
  if (outcome === 'resolve') gate.resolve({ available: true, count: 1 }); else gate.reject(Error('PRIVATE'));
  await closing; assert.equal(h.owner.pending, 0);
  assert.equal((await h.app.request('/api/auth/status')).status, 503); assert.equal(calls, 1);
  assert.doesNotMatch(h.rows.join('\n'), /PRIVATE/);
});

for (const endpoint of ['status', 'passkeys'] as const) for (const late of ['resolve', 'reject'] as const)
  test(`${endpoint}: stalled read returns bounded 503; late ${late} cannot deliver credentials`, { timeout: 3000 }, async () => {
    const { app, passkeys, diagnostics } = fixture(); let calls = 0;
    const original = held<any>();
    if (endpoint === 'status') passkeys.status = () => { calls++; return original.promise; };
    else passkeys.list = () => { calls++; return original.promise; };
    try {
      const response = await bounded(app.request('/api/auth/' + endpoint));
      assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 503);
      assert.deepEqual(await (response as Response).json(), { error: 'auth_persistence_failed' });
      assert.equal((response as Response).headers.get('set-cookie'), null); assert.equal(calls, 1);
      assert.equal(diagnostics.snapshot().events.find(row => row.timedOut === 1)?.pending, 1);
    } finally {
      if (late === 'resolve') original.resolve(endpoint === 'status' ? { available: true, count: 1 } : []);
      else original.reject(Error('PRIVATE token path SQL'));
      await tick();
    }
    if (endpoint === 'status') passkeys.status = () => ({ available: true, count: 1 }); else passkeys.list = () => [];
    assert.equal((await app.request('/api/auth/' + endpoint)).status, 200);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE token path SQL/);
  });

test('cancelled status returns 408, original result remains observed and cannot produce a cookie', async () => {
  const { app, passkeys, diagnostics } = fixture(), original = held<{ available: boolean; count: number }>();
  passkeys.status = () => original.promise;
  const controller = new AbortController();
  const flight = app.fetch(new Request('http://fixture/api/auth/status', { signal: controller.signal }));
  await tick(); controller.abort();
  try {
    const response = await bounded(flight);
    assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 408);
    assert.deepEqual(await (response as Response).json(), { error: 'request_cancelled' });
    assert.equal((response as Response).headers.get('set-cookie'), null);
  } finally { original.reject(Error('PRIVATE late read')); await tick(); }
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE late read/);
});

test('recovery scope timeout cannot publish authenticated state or cached scope', async () => {
  const original = held<string>(), { app, diagnostics } = fixture({ recoveryScope: () => original.promise });
  try {
    const response = await bounded(app.request('/api/auth/status'));
    assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 503);
    assert.deepEqual(await (response as Response).json(), { error: 'auth_persistence_failed' });
    assert.equal(diagnostics.snapshot().events.find(row => row.timedOut === 1)?.step, 12);
  } finally { original.resolve('PRIVATE recovery scope'); await tick(); }
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE recovery scope/);
});

test('async authority timeout is unavailable, not denied and not fallback authorized', async () => {
  const original = held<boolean>(); let fallbacks = 0, lists = 0;
  const { app, passkeys, diagnostics } = fixture({ isAuthorizedRequest: () => { fallbacks++; return true; },
    authority: { keyIdentityHash: keyIdentityHash('fixture-key'), authorize: () => original.promise,
      revoke: () => false, verifyRegistration: unsupported, sessionCurrent: () => false } });
  passkeys.list = () => { lists++; return []; };
  try {
    const response = await bounded(app.request('/api/auth/passkeys'));
    assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 503);
    assert.equal(fallbacks, 0); assert.equal(lists, 0);
    assert.equal(diagnostics.snapshot().events.find(row => row.timedOut === 1)?.step, 6);
  } finally { original.resolve(true); await tick(); }
  assert.equal(fallbacks, 0); assert.equal(lists, 0);
});

test('post-issuance status timeout never publishes successful login, audit or retries original issuance', async () => {
  const original = held<{ available: boolean; count: number }>(); let issued = 0;
  const { app, passkeys, auditLog, rows } = fixture({ sessions: { add: () => { issued++; }, delete: () => false } });
  passkeys.status = () => original.promise;
  try {
    const response = await bounded(app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey: 'fixture-key' }) }));
    assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 503);
    assert.equal((response as Response).headers.get('set-cookie'), null); assert.equal(issued, 1); assert.equal(auditLog.list().length, 0);
  } finally { original.resolve({ available: true, count: 1 }); await tick(); }
  assert.equal(issued, 1); assert.equal(auditLog.list().length, 0);
  // Routine successful writes intentionally are not retained in the bounded
  // recovery ring. Inspect the captured sink without changing that policy.
  assert.equal(rows.map(row => JSON.parse(row)).filter(row => row.step === 4 && row.admitted === 1).length, 1);
});

for (const member of [false, true]) for (const late of ['resolve', 'reject'] as const)
  test(`${member ? 'member' : 'administrator'} final session proof timeout cannot publish a late cookie (${late})`, async () => {
    const original = held<boolean>(); let issued = 0, proved = 0;
    const { app, auditLog, diagnostics } = fixture({
      sessions: { add: () => { issued++; }, delete: () => false },
      ...(member ? {
        memberLogin: () => { issued++; return 'PRIVATE member session'; },
        memberSessionCurrent: () => { proved++; return original.promise; },
      } : {
        authority: { keyIdentityHash: keyIdentityHash('fixture-key'), authorize: () => true,
          revoke: () => false, verifyRegistration: unsupported,
          sessionCurrent: () => { proved++; return original.promise; } },
      }),
    });
    try {
      const response = await bounded(app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessKey: member ? 'hub_key_fixture' : 'fixture-key' }) }));
      assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 503);
      assert.equal((response as Response).headers.get('set-cookie'), null);
      assert.equal(issued, 1); assert.equal(proved, 1); assert.equal(auditLog.list().length, 0);
      assert.equal(diagnostics.snapshot().events.find(row => row.timedOut === 1)?.step, member ? 13 : 7);
    } finally {
      if (late === 'resolve') original.resolve(true); else original.reject(Error('PRIVATE final proof'));
      await tick();
    }
    assert.equal(issued, 1); assert.equal(proved, 1); assert.equal(auditLog.list().length, 0);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE member session|PRIVATE final proof/);
  });

test('cancelled logout identity read neither starts revocation nor clears the cookie', async () => {
  const original = held<undefined>(); let deleted = 0, revoked = 0;
  const { app, auditLog } = fixture({ auditIdentity: () => original.promise,
    sessions: { add: () => {}, delete: () => { deleted++; return true; } }, revokeMemberSession: () => { revoked++; } });
  const controller = new AbortController();
  const flight = app.fetch(new Request('http://fixture/api/auth/logout', { method: 'POST',
    headers: { cookie: 'agentopsdeck_session=PRIVATE' }, signal: controller.signal }));
  await tick(); controller.abort();
  try {
    const response = await bounded(flight);
    assert.notEqual(response, 'STILL_WAITING'); assert.equal((response as Response).status, 408);
    assert.equal((response as Response).headers.get('set-cookie'), null);
    assert.equal(deleted, 0); assert.equal(revoked, 0); assert.equal(auditLog.list().length, 0);
  } finally { original.resolve(undefined); await tick(); }
  assert.equal(deleted, 0); assert.equal(revoked, 0); assert.equal(auditLog.list().length, 0);
});
