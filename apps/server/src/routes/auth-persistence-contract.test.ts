import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from '../auth/security.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import type { AuthPasskeyStore, AuthRouteAuthority } from '../auth/route-persistence.js';
import { registerAuthRoutes } from './auth.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const unsupported = async (): Promise<never> => { throw Error('Unexpected verification call'); };
function fixture(overrides: Partial<Parameters<typeof registerAuthRoutes>[1]> = {}) {
  const diagnostics = new PerformanceDiagnostics(() => {}), auditLog = new AuthAuditLog();
  const passkeys: AuthPasskeyStore = { status: () => ({ available: true, count: 1 }), list: () => [], revoke: () => false,
    registrationOptions: unsupported, verifyRegistration: unsupported,
    authenticationOptions: unsupported, verifyAuthentication: unsupported };
  const deps = { accessKey: 'fixture-key', passkeys, sessions: new Set<string>(), isAuthorizedRequest: () => true,
    auditLog, diagnostics, loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }),
    lockoutSeconds: 1, ...overrides };
  const app = new Hono(); registerAuthRoutes(app, deps);
  return { app, deps, passkeys, diagnostics, auditLog };
}
const login = (app: Hono) => app.request('/api/auth/login', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'fixture-key' }) });
const assertion = (app: Hono) => app.request('/api/auth/passkeys/login/verify', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: '{}' });

test('legacy route authorization never starts a native async guard or leaks a denial as permission', async () => {
  let calls = 0;
  const { app, passkeys } = fixture({ isAuthorizedRequest: (async () => {
    calls++; return true;
  }) as unknown as () => boolean });
  passkeys.list = () => { throw Error('Must not reach persistence'); };
  assert.equal((await app.request('/api/auth/passkeys')).status, 401);
  assert.equal(calls, 0);
});

test('status waits for persistence and observes current authentication after the wait', async () => {
  let authorized = true;
  const { app, passkeys } = fixture({ isAuthorizedRequest: () => authorized });
  const status = deferred<{ available: boolean; count: number }>(); passkeys.status = () => status.promise;
  let settled = false;
  const response = Promise.resolve(app.request('/api/auth/status')); void response.then(() => { settled = true; });
  await turn(); assert.equal(settled, false);
  authorized = false; status.resolve({ available: true, count: 2 });
  const result = await response;
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { authenticated: false, passkeys: { available: true, count: 2 } });
});

test('passkey list rechecks revocation after persistence, without leaking the completed list', async () => {
  let authorized = true, calls = 0;
  const { app, passkeys } = fixture({ isAuthorizedRequest: () => authorized });
  const list = deferred<Awaited<ReturnType<AuthPasskeyStore['list']>>>();
  passkeys.list = () => { calls++; return list.promise; };
  const response = app.request('/api/auth/passkeys'); await turn();
  authorized = false; list.resolve([{ id: 'private-credential', label: 'private-label', transports: [], createdAt: 1 }]);
  const result = await response;
  assert.equal(result.status, 401); assert.doesNotMatch(await result.text(), /private-/); assert.equal(calls, 1);
});

test('unauthorized passkey list never reaches the persistence port', async () => {
  const { app, passkeys } = fixture({ isAuthorizedRequest: () => false });
  let calls = 0; passkeys.list = () => { calls++; return []; };
  assert.equal((await app.request('/api/auth/passkeys')).status, 401); assert.equal(calls, 0);
});

test('async revoke false remains not-found, not a truthy promise success', async () => {
  const { app, passkeys, auditLog } = fixture(), revoked = deferred<boolean>();
  let calls = 0; passkeys.revoke = () => { calls++; return revoked.promise; };
  const response = app.request('/api/auth/passkeys/id', { method: 'DELETE' });
  await turn(); assert.equal(auditLog.list().length, 0);
  revoked.resolve(false); const result = await response;
  assert.equal(result.status, 404); assert.deepEqual(await result.json(), { ok: false });
  assert.equal(calls, 1); assert.equal(auditLog.list()[0]!.outcome, 'failure');
});

test('login waits for both session ACK and status before cookie and success audit', async () => {
  const add = deferred<void>(), status = deferred<{ available: boolean; count: number }>();
  let calls = 0, statusCalls = 0;
  const { app, passkeys, auditLog } = fixture({ sessions: { add: () => { calls++; return add.promise; }, delete: () => false } });
  passkeys.status = () => { statusCalls++; return status.promise; };
  let settled = false;
  const response = Promise.resolve(login(app)); void response.then(() => { settled = true; });
  await turn(); assert.equal(calls, 1); assert.equal(statusCalls, 0); assert.equal(settled, false); assert.equal(auditLog.list().length, 0);
  add.resolve(); await turn(); assert.equal(statusCalls, 1); assert.equal(settled, false); assert.equal(auditLog.list().length, 0);
  status.resolve({ available: true, count: 1 }); const result = await response;
  assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie')!, /agentopsdeck_session=/);
  assert.equal(auditLog.list()[0]!.outcome, 'success'); assert.equal(calls, 1);
});

for (const operation of ['session-add', 'status-after-session', 'revoke', 'session-delete'] as const)
  test(`${operation} rejected ACK remains sanitized unknown, without cookie or automatic retry`, async () => {
    const original = deferred<never>(); let calls = 0, memberRevokes = 0;
    const { app, passkeys, auditLog, diagnostics, deps } = fixture({ revokeMemberSession: () => { memberRevokes++; } });
    const fail = () => { calls++; return original.promise; };
    if (operation === 'session-add') deps.sessions = { add: fail, delete: () => false };
    if (operation === 'session-delete') deps.sessions = { add: () => {}, delete: fail };
    // Re-register with modified session port: the fixture registration captured
    // the same dependency object, so no second router/owner is introduced.
    if (operation === 'status-after-session') passkeys.status = fail;
    if (operation === 'revoke') passkeys.revoke = fail;
    const response = operation === 'revoke' ? app.request('/api/auth/passkeys/id', { method: 'DELETE' })
      : operation === 'session-delete' ? app.request('/api/auth/logout', { method: 'POST', headers: { cookie: 'agentopsdeck_session=fixture-token' } }) : login(app);
    await turn(); original.reject(Error('private-database-path-and-secret')); const result = await response;
    assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
    assert.deepEqual(await result.json(), { error: 'auth_persistence_failed' });
    assert.equal(calls, 1); assert.equal(memberRevokes, 0);
    assert.equal(auditLog.list().filter(event => event.outcome === 'success').length, 0);
    assert.ok(diagnostics.snapshot().events.some(event => event.operation === 'auth-route-persistence' && event.unknown === 1));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-|fixture-token|database-path|secret/);
  });

test('logout waits for original session deletion before member revoke and cookie clear', async () => {
  const deleted = deferred<boolean>(); let calls = 0, memberRevokes = 0;
  const { app } = fixture({ sessions: { add: () => {}, delete: () => { calls++; return deleted.promise; } },
    revokeMemberSession: () => { memberRevokes++; } });
  let settled = false;
  const response = Promise.resolve(app.request('/api/auth/logout', { method: 'POST', headers: { cookie: 'agentopsdeck_session=fixture-token' } }));
  void response.then(() => { settled = true; }); await turn();
  assert.equal(settled, false); assert.equal(memberRevokes, 0);
  deleted.resolve(true); const result = await response;
  assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(calls, 1); assert.equal(memberRevokes, 1);
});

for (const change of ['revoked', 'key-rotated'] as const)
  test(`queued revoke rechecks ${change} at original mutation and does not publish success`, async () => {
    let authorized = true, mutations = 0, checks = 0;
    const gate = deferred<void>();
    const { app, passkeys, deps, auditLog } = fixture({ isAuthorizedRequest: () => authorized });
    passkeys.revoke = async (_key, _id, _at, isAuthorized) => {
      await gate.promise; checks++;
      if (!isAuthorized()) return false;
      mutations++; return true;
    };
    const pending = app.request('/api/auth/passkeys/id', { method: 'DELETE' });
    await turn();
    if (change === 'revoked') authorized = false;
    else deps.accessKey = 'rotated-fixture-key';
    gate.resolve(); const response = await pending;
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(checks, 1); assert.equal(mutations, 0); assert.equal(auditLog.list().length, 0);
    assert.equal(response.headers.get('set-cookie'), null);
  });

for (const outcome of ['ack', 'failure'] as const)
  test(`client abort does not cancel or replay an original session write with late ${outcome}`, async () => {
    const controller = new AbortController(), original = deferred<void>();
    let calls = 0, settled = false;
    const { app, auditLog, diagnostics } = fixture({ sessions: {
      add: () => { calls++; return original.promise; }, delete: () => false,
    } });
    const pending = Promise.resolve(app.request(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey: 'fixture-key' }), signal: controller.signal,
    })));
    void pending.then(() => { settled = true; });
    await turn(); assert.equal(calls, 1); controller.abort(); await turn();
    assert.equal(settled, false); assert.equal(calls, 1); assert.equal(auditLog.list().length, 0);
    assert.equal(diagnostics.snapshot().events.some(e => e.step === 4 && e.phase === 'finished'), false);
    if (outcome === 'ack') original.resolve(); else original.reject(Error('private-original-write'));
    const response = await pending;
    // The original write still settles exactly once. An aborted client cannot
    // receive a late Cookie or success after the final read/proof boundary.
    assert.equal(response.status, outcome === 'ack' ? 408 : 503); assert.equal(calls, 1);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(auditLog.list().filter(e => e.outcome === 'success').length, 0);
    if (outcome === 'failure') {
      assert.equal(response.headers.get('set-cookie'), null);
      assert.ok(diagnostics.snapshot().events.some(e => e.step === 4 && e.unknown === 1));
    }
  });

test('committed shared-auth session is never issued twice and a late revoke prevents its cookie', async () => {
  let current = true, added = 0;
  const { app, passkeys, auditLog } = fixture({ sessions: { add: () => { added++; }, delete: () => false } });
  const status = deferred<{ available: boolean; count: number }>();
  passkeys.verifyAuthentication = async () => ({ verified: true as const, credentialHash: 'fixture-hash',
    keyIdentityHash: undefined, sessionToken: 'fixture-committed-token', isCurrent: () => current });
  passkeys.status = () => status.promise;
  const response = assertion(app); await turn();
  current = false; status.resolve({ available: true, count: 1 }); const result = await response;
  assert.equal(result.status, 401); assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(added, 0); assert.equal(auditLog.list().filter(event => event.outcome === 'success').length, 0);
});

test('JSON passkey session issuance is awaited once before publishing success', async () => {
  const add = deferred<void>(); let calls = 0;
  const { app, passkeys, auditLog } = fixture({ sessions: { add: () => { calls++; return add.promise; }, delete: () => false } });
  passkeys.verifyAuthentication = async () => ({ verified: true as const, credentialHash: 'fixture-hash', keyIdentityHash: undefined, isCurrent: () => true });
  const response = assertion(app); await turn(); assert.equal(calls, 1); assert.equal(auditLog.list().length, 0);
  add.resolve(); const result = await response;
  assert.equal(result.status, 200); assert.ok(result.headers.get('set-cookie')); assert.equal(calls, 1);
  assert.equal(auditLog.list()[0]!.outcome, 'success');
});

test('registration preserves its synchronous atomic authorization callback and checks after status wait', async () => {
  let authorized = true, checked = 0;
  const { app, passkeys } = fixture({ isAuthorizedRequest: () => authorized });
  const status = deferred<{ available: boolean; count: number }>();
  passkeys.status = () => status.promise;
  passkeys.verifyRegistration = async (_request, _response, metadata) => {
    checked++; assert.equal(metadata!.isAuthorized!(), true);
    return { verified: true as const, count: 1, credentialHash: 'fixture-hash' };
  };
  const response = app.request('/api/auth/passkeys/register/verify', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  await turn(); authorized = false; status.resolve({ available: true, count: 1 });
  assert.equal((await response).status, 401); assert.equal(checked, 1);
});

function authority(overrides: Partial<AuthRouteAuthority> = {}): AuthRouteAuthority {
  return { keyIdentityHash: keyIdentityHash('fixture-key'), authorize: async () => true,
    revoke: unsupported, verifyRegistration: unsupported, sessionCurrent: async () => true, ...overrides };
}

for (const path of ['/api/auth/passkeys', '/api/auth/passkeys/id', '/api/auth/passkeys/register/options',
  '/api/auth/passkeys/register/verify', '/api/auth/audit']) {
  test(`awaited authority denies ${path} without legacy fallback, mutation or audit`, async () => {
    let legacy = 0, checks = 0;
    const { app, auditLog, passkeys } = fixture({ authority: authority({ authorize: async () => { checks++; return false; } }),
      isAuthorizedRequest: () => { legacy++; return true; } });
    passkeys.list = () => { throw Error('must not list'); };
    const response = await app.request(path, { method: path.endsWith('/id') ? 'DELETE' : path.includes('/register/') ? 'POST' : 'GET' });
    assert.equal(response.status, 401); assert.equal(checks, 1); assert.equal(legacy, 0);
    assert.equal(auditLog.list().length, 0);
  });
}

test('authority rejection is sanitized 503, observed once and never falls back to legacy authority', async () => {
  let calls = 0;
  const { app, diagnostics } = fixture({ authority: authority({ authorize: () => {
    calls++; return Promise.reject(Error('private-path-and-token')); } }), isAuthorizedRequest: () => { throw Error('no fallback'); } });
  const response = await app.request('/api/auth/passkeys');
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal(calls, 1);
  assert.ok(diagnostics.snapshot().events.some(e => e.step === 6 && e.unknown === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-path-and-token/);
});

for (const path of ['/api/auth/passkeys/register/options', '/api/auth/passkeys/login/options']) {
  test(`${path} reports storage unavailability as 503, not malformed WebAuthn input`, async () => {
    const { app, passkeys } = fixture({ authority: authority() });
    passkeys.registrationOptions = passkeys.authenticationOptions = async () => { throw new AuthPersistenceError(); };
    const response = await app.request(path, { method: 'POST' });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  });
}

for (const outcome of ['false', 'reject', 'rotation'] as const) {
  test(`key login awaits final original session check (${outcome}) without delivering stale cookie`, async () => {
    const current = deferred<boolean>(); let calls = 0;
    const { app, deps, auditLog } = fixture({ authority: authority({ sessionCurrent: () => { calls++; return current.promise; } }) });
    let settled = false;
    const pending = Promise.resolve(login(app)); void pending.then(() => { settled = true; });
    await turn(); assert.equal(calls, 1); assert.equal(settled, false);
    if (outcome === 'reject') current.reject(Error('private-original-sql-error'));
    else { if (outcome === 'rotation') deps.accessKey = 'rotated-key'; current.resolve(outcome === 'rotation'); }
    const response = await pending;
    assert.equal(response.status, outcome === 'reject' ? 503 : 401);
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(auditLog.list().length, 0); assert.equal(calls, 1);
  });
}

for (const check of [1, 2]) for (const outcome of ['false', 'reject', 'rotation'] as const) {
  test(`passkey login awaits isCurrent check ${check} (${outcome}), no extra issuance or cookie`, async () => {
    const current = deferred<boolean>(); let calls = 0, issued = 0;
    const { app, passkeys, deps, auditLog } = fixture({ sessions: { add: () => { issued++; }, delete: () => false } });
    passkeys.verifyAuthentication = async () => ({ verified: true, credentialHash: 'fixture-hash',
      keyIdentityHash: undefined, sessionToken: 'original-session', isCurrent: () => ++calls === check ? current.promise : true });
    let settled = false;
    const pending = Promise.resolve(assertion(app)); void pending.then(() => { settled = true; });
    await turn(); assert.equal(calls, check); assert.equal(settled, false);
    if (outcome === 'reject') current.reject(Error('private-original-sql-error'));
    else { if (outcome === 'rotation') deps.accessKey = 'rotated-key'; current.resolve(outcome === 'rotation'); }
    const response = await pending;
    assert.equal(response.status, outcome === 'reject' ? 503 : 401);
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(issued, 0);
    assert.equal(auditLog.list().filter(e => e.outcome === 'success').length, 0); assert.equal(calls, check);
  });
}

test('request-aware revoke uses original authority command, allowing self-revoke then reauthentication', async () => {
  let allowed = true, mutations = 0;
  const { app, passkeys } = fixture({ authority: authority({ authorize: async () => allowed,
    revoke: async (request, key, id) => { assert.ok(request instanceof Request); assert.equal(key, keyIdentityHash('fixture-key'));
      assert.equal(id, 'id'); mutations++; allowed = false; return true; } }) });
  passkeys.revoke = () => { throw Error('legacy callback must not run'); };
  const response = await app.request('/api/auth/passkeys/id', { method: 'DELETE' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, reauthenticate: true });
  assert.match(response.headers.get('set-cookie')!, /Max-Age=0/); assert.equal(mutations, 1);
});

test('request-aware registration uses original request and no serialized callback', async () => {
  let mutations = 0;
  const { app } = fixture({ isAuthorizedRequest: () => { throw Error('legacy authority must not run'); },
    authority: authority({ verifyRegistration: async (request, _response, metadata) => {
      assert.ok(request instanceof Request); assert.equal('isAuthorized' in metadata, false); mutations++;
      return { verified: true, count: 1, credentialHash: 'fixture-hash' };
    } }) });
  const response = await app.request('/api/auth/passkeys/register/verify', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal(mutations, 1);
});

test('list cannot deliver old-key data after rotation during final awaited authority check', async () => {
  const gate = deferred<boolean>(); let checks = 0;
  const { app, deps } = fixture({ authority: authority({ authorize: () => ++checks === 2 ? gate.promise : true }) });
  const pending = app.request('/api/auth/passkeys'); await turn(); assert.equal(checks, 2);
  deps.accessKey = 'rotated-key'; gate.resolve(true); assert.equal((await pending).status, 401);
});
