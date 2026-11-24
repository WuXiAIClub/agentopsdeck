import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubMemberSessions } from '../hub/async-member-session.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthAuditLog, LoginAttemptLimiter } from '../auth/security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from './auth.js';

const quiet = new PerformanceDiagnostics(() => {});
const passkeys = { available: false, count: 0 };
const fixtureKey = 'hub_key_' + 'k'.repeat(43), fixtureSession = 'hub_session_' + 's'.repeat(43);
type Dependencies = Parameters<typeof registerAuthRoutes>[1];
function routes(service: AsyncHubMemberSessions, overrides: Partial<Dependencies> = {}) {
  const app = new Hono(), auditLog = new AuthAuditLog();
  const unexpected = async (): Promise<never> => { throw Error('unexpected_passkey_operation'); };
  registerAuthRoutes(app, {
    accessKey: 'fixture-admin', sessions: new Set<string>(), isAuthorizedRequest: () => false,
    auditLog, loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }),
    lockoutSeconds: 1, diagnostics: quiet,
    passkeys: { status: () => passkeys, list: () => [], revoke: () => false,
      registrationOptions: unexpected, verifyRegistration: unexpected,
      authenticationOptions: unexpected, verifyAuthentication: unexpected },
    memberLogin: service.memberLogin, memberSessionCurrent: service.memberSessionCurrent,
    revokeMemberSession: service.revokeMemberSession, ...overrides,
  });
  return { app, auditLog };
}
const login = (app: Hono, key: string) => app.request('/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }),
});
const logout = (app: Hono, cookie: string) => app.request('/api/auth/logout', {
  method: 'POST', headers: { cookie },
});
const sessionToken = (response: Response) => {
  const cookie = response.headers.get('set-cookie'); assert.ok(cookie);
  const match = /agentopsdeck_session=(hub_session_[A-Za-z0-9_-]{43})/.exec(cookie); assert.ok(match);
  return match[1]!;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function withOwner(work: (owner: AsyncHubMemberOwner, fixture: {
  file: string; key: string; oldCookie: string; userId: string; logs: string[];
}) => Promise<void>, prepare?: (db: DatabaseSync) => void) {
  const root = mkdtempSync(join(tmpdir(), 'auth-member-owner-http-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'fixture-vault'); let owner: AsyncHubMemberOwner | undefined;
  try {
    const user = original.createUser('Existing member'), key = original.identities.issueKey(user.id).token;
    const oldCookie = original.identities.createSession(key)!;
    await original.close();
    if (prepare) { const db = new DatabaseSync(file); try { prepare(db); } finally { db.close(); } }
    const logs: string[] = [];
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault' }, new PerformanceDiagnostics(line => logs.push(line)));
    await work(owner, { file, key, oldCookie, userId: user.id, logs });
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
}

test('worker-backed member login/logout retain existing frontend JSON/cookie contract and old unrelated session', async () => {
  await withOwner(async (owner, { file, key, oldCookie, userId, logs }) => {
    const service = new AsyncHubMemberSessions(owner, quiet);
    const requests: Request[] = [];
    const { app, auditLog } = routes(service, {
      memberLogin: (value, request) => { requests.push(request); return service.memberLogin(value, request); },
      memberSessionCurrent: (value, request) => { requests.push(request); return service.memberSessionCurrent(value, request); },
    });
    const response = await login(app, key); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, passkeys });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const token = sessionToken(response);
    assert.equal(requests.length, 3); assert.ok(requests.every(request => request === requests[0]));
    assert.equal(service.forRequest(requests[0]!), service.forRequest(requests[0]!));
    assert.deepEqual((await owner.command('memberSnapshot', { sessionToken: token }))?.principal, { userId, admin: false });
    const revoked = await logout(app, 'agentopsdeck_session=' + token);
    assert.equal(revoked.status, 200); assert.deepEqual(await revoked.json(), { ok: true });
    assert.match(revoked.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal(await owner.command('memberSnapshot', { sessionToken: token }), null);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: oldCookie }));
    assert.equal(auditLog.list().filter(row => row.event === 'access_key_login' && row.outcome === 'success').length, 1);
    await owner.close();
    const reopened = new HubStore(file, 'fixture-vault');
    try {
      const request = new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + oldCookie } });
      assert.deepEqual(reopened.identities.requestPrincipal(request, () => false), { userId, admin: false });
    } finally { await reopened.close(); }
    assert.equal(logs.join('').includes(key), false); assert.equal(logs.join('').includes(token), false);
  });
});

for (const operation of ['login', 'logout'] as const) {
  test('real HTTP ' + operation + ' SQL failure preserves cookie state, reports 503 and leaves owner available', async () => {
    await withOwner(async (owner, { file, key, oldCookie, logs }) => {
      const rows = () => {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
          return ['hub_login_sessions', 'hub_key_usage', 'hub_user_usage'].map(table =>
            db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort());
        } finally { db.close(); }
      };
      const before = rows(), { app, auditLog } = routes(new AsyncHubMemberSessions(owner, quiet));
      const response = operation === 'login' ? await login(app, key) : await logout(app, 'agentopsdeck_session=' + oldCookie);
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
      assert.equal(response.headers.get('set-cookie'), null); assert.equal(auditLog.list().length, 0);
      assert.deepEqual(rows(), before); assert.ok(await owner.command('memberSnapshot', { sessionToken: oldCookie }));
      assert.equal(owner.snapshot().unavailable, false);
      assert.ok(logs.map(line => JSON.parse(line)).some(entry => entry.operation === 'hub-member-sqlite-command'
        && entry.category === 'failed' && entry.unknown === 1 && entry.step === (operation === 'login' ? 2 : 3)));
      assert.equal(logs.join('').includes('private-fixture'), false);
      assert.equal(logs.join('').includes(key), false); assert.equal(logs.join('').includes(oldCookie), false);
    }, db => db.exec(operation === 'login'
      ? "CREATE TRIGGER fail_usage BEFORE INSERT ON hub_user_usage BEGIN SELECT RAISE(ABORT,'private-fixture-usage'); END"
      : "CREATE TRIGGER fail_delete BEFORE DELETE ON hub_login_sessions BEGIN SELECT RAISE(ABORT,'private-fixture-delete'); END"));
  });
}

test('revocation during awaited login audit suppresses cookie response without issuing another session', async () => {
  await withOwner(async (owner, { key, oldCookie }) => {
    const service = new AsyncHubMemberSessions(owner, quiet);
    let issued: string | undefined, writes = 0;
    const auditLog = new AuthAuditLog();
    const { app } = routes(service, {
      memberLogin: async (value, request) => { writes++; issued = await service.memberLogin(value, request); return issued; },
      auditLog: { append: async record => {
        assert.ok(issued); await owner.command('memberSessionDelete', { token: issued }); return auditLog.append(record);
      }, list: (limit) => auditLog.list(limit), page: (options) => auditLog.page(options) },
    });
    const response = await login(app, key);
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(writes, 1);
    assert.equal(await owner.command('memberSnapshot', { sessionToken: issued! }), null);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: oldCookie }));
  });
});

test('failed HTTP dependency context stays fenced on the same Request but not an independent request', async () => {
  let calls = 0;
  const service = new AsyncHubMemberSessions({ command: async () => { calls++; throw Error('private-fixture'); } }, quiet);
  const request = new Request('http://fixture.invalid/');
  assert.equal(service.forRequest(request), service.forRequest(request));
  await assert.rejects(service.memberLogin(fixtureKey, request), AuthPersistenceError);
  await assert.rejects(service.memberSessionCurrent(fixtureSession, request), AuthPersistenceError);
  await assert.rejects(service.revokeMemberSession(fixtureSession, request), AuthPersistenceError);
  assert.equal(calls, 1);
  await assert.rejects(service.memberLogin(fixtureKey, new Request(request)), AuthPersistenceError);
  assert.equal(calls, 2);
});

test('HTTP disconnect after original login admission keeps mutation pending until real ACK and never publishes a cookie', async () => {
  const mutation = deferred<unknown>(), admitted = deferred<void>(), logs: string[] = [];
  let writes = 0, proofs = 0;
  const owner = { command: async () => { writes++; admitted.resolve(); return mutation.promise; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const service = new AsyncHubMemberSessions(owner, new PerformanceDiagnostics(line => logs.push(line)), 5, 100);
  const { app, auditLog } = routes(service, { memberSessionCurrent: (token, request) => {
    proofs++; return service.memberSessionCurrent(token, request);
  } });
  const controller = new AbortController();
  const request = new Request('http://fixture.invalid/api/auth/login', { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: fixtureKey }) });
  let settled = false;
  const response = Promise.resolve(app.request(request)).then(value => { settled = true; return value; });
  await admitted.promise; controller.abort(); await pause(20);
  assert.equal(settled, false); assert.equal(service.pending, 1); assert.equal(auditLog.list().length, 0);
  mutation.resolve({ token: 'hub_session_' + 'x'.repeat(43) });
  const result = await response;
  // Existing outer persistence boundary sanitizes rejected mutation delivery.
  assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: 'auth_persistence_failed' });
  assert.equal(result.headers.get('set-cookie'), null); assert.equal(service.pending, 0);
  assert.equal(writes, 1); assert.equal(proofs, 0); assert.equal(auditLog.list().length, 0);
  assert.ok(logs.some(line => JSON.parse(line).cancelled === 1));
  assert.equal(logs.join('').includes(fixtureKey), false);
});

test('HTTP final-proof timeout retains original read budget and observes late rejection without login replay', async () => {
  const proof = deferred<unknown>(), entered = deferred<void>(), logs: string[] = []; let writes = 0;
  const owner = { command: async (kind: string) => {
    if (kind === 'memberSessionCreate') { writes++; return { token: 'hub_session_' + 'x'.repeat(43) }; }
    entered.resolve(); return proof.promise;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const service = new AsyncHubMemberSessions(owner, new PerformanceDiagnostics(line => logs.push(line)), 5, 15);
  const { app, auditLog } = routes(service);
  const response = login(app, fixtureKey); await entered.promise;
  const result = await response;
  assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(service.pending, 1); assert.equal(writes, 1); assert.equal(auditLog.list().length, 0);
  assert.ok(logs.some(line => JSON.parse(line).timedOut === 1));
  proof.reject(Error('private-fixture-late-error')); await tick(); await tick();
  assert.equal(service.pending, 0); assert.equal(writes, 1);
  assert.equal(logs.join('').includes('private-fixture'), false);
});
