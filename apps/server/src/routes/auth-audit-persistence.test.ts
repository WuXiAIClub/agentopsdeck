import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from '../auth/security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AuthPasskeyStore, AuthRouteAuditStore } from '../auth/route-persistence.js';
import { registerAuthRoutes } from './auth.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(overrides: Partial<Parameters<typeof registerAuthRoutes>[1]> = {}) {
  const records = new AuthAuditLog(), logs: string[] = [];
  const passkeys: AuthPasskeyStore = {
    status: () => ({ available: true, count: 1 }), list: () => [], revoke: () => false,
    registrationOptions: async () => { throw Error('Unexpected registration'); },
    verifyRegistration: async () => { throw Error('Unexpected registration'); },
    authenticationOptions: async () => { throw Error('Unexpected authentication'); },
    verifyAuthentication: async () => { throw Error('Unexpected authentication'); },
  };
  const audit: AuthRouteAuditStore = {
    append: (record: Parameters<AuthAuditLog['append']>[0]) => records.append(record),
    page: (options?: Parameters<AuthAuditLog['page']>[0]) => records.page(options),
    list: (limit?: number) => records.list(limit),
  };
  const sessions = new Set<string>();
  const deps = {
    accessKey: 'fixture-key', passkeys, sessions, isAuthorizedRequest: () => true,
    auditLog: audit,
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 1000 }),
    lockoutSeconds: 1,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)), ...overrides,
  };
  const app = new Hono(); registerAuthRoutes(app, deps);
  return { app, deps, records, audit, passkeys, logs, sessions };
}
const login = (app: Hono, key = 'fixture-key') => app.request('/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }),
});

for (const revoked of [false, true]) test(`login waits for original audit ACK and rechecks key rotation (${revoked})`, async () => {
  const h = fixture(), ack = deferred<ReturnType<AuthAuditLog['append']>>();
  let calls = 0, settled = false;
  h.audit.append = record => { calls++; const row = h.records.append(record); return ack.promise.then(() => row); };
  const pending = Promise.resolve(login(h.app)); void pending.then(() => { settled = true; });
  await turn(); assert.equal(calls, 1); assert.equal(settled, false);
  assert.equal(h.sessions.size, 1);
  if (revoked) h.deps.accessKey = 'rotated-fixture-key';
  ack.resolve(h.records.list()[0]!);
  const response = await pending;
  assert.equal(response.status, revoked ? 401 : 200);
  assert.equal(response.headers.has('set-cookie'), !revoked);
  assert.equal(calls, 1); assert.equal(h.sessions.size, 1);
});

for (const paged of [false, true]) for (const refusal of ['revoked', 'member', 'rotated'] as const)
  test(`audit ${paged ? 'page' : 'list'} rechecks ${refusal} before publishing private records`, async () => {
    let authorized = true, administrator = true;
    const h = fixture({ isAuthorizedRequest: () => authorized,
      auditIdentity: () => ({ userId: 'test-user', authMethod: administrator ? 'administrator' : 'member' }) });
    const list = deferred<ReturnType<AuthAuditLog['list']>>(), page = deferred<ReturnType<AuthAuditLog['page']>>();
    let calls = 0, settled = false;
    if (paged) h.audit.page = () => { calls++; return page.promise; };
    else h.audit.list = () => { calls++; return list.promise; };
    const pending = Promise.resolve(h.app.request('/api/auth/audit' + (paged ? '?page=true' : '')));
    void pending.then(() => { settled = true; });
    await turn(); assert.equal(calls, 1); assert.equal(settled, false);
    if (refusal === 'revoked') authorized = false;
    if (refusal === 'member') administrator = false;
    if (refusal === 'rotated') h.deps.accessKey = 'rotated-fixture-key';
    const records = [{ id: 'private-record', ts: 1, event: 'access_key_login' as const, outcome: 'success' as const }];
    if (paged) page.resolve({ ...h.records.page(), records }); else list.resolve(records);
    const response = await pending;
    assert.equal(response.status, refusal === 'member' ? 403 : 401);
    assert.doesNotMatch(await response.text(), /private-record/); assert.equal(calls, 1);
  });

test('lost audit ACK after original login mutation is sanitized unknown, never replayed or delivered as a cookie', async () => {
  const h = fixture(), ack = deferred<never>(); let calls = 0;
  h.audit.append = record => { calls++; h.records.append(record); return ack.promise; };
  const pending = login(h.app); await turn();
  ack.reject(Error('secret-db-path SQL fixture-key'));
  const response = await pending;
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal(calls, 1); assert.equal(h.sessions.size, 1); assert.equal(h.records.list().length, 1);
  assert.ok(h.logs.some(line => { const row = JSON.parse(line); return row.operation === 'auth-route-persistence' && row.step === 14 && row.unknown === 1; }));
  assert.doesNotMatch(h.logs.join('\n'), /secret-db-path|SQL|fixture-key/);
});

for (const status of [401, 429]) test(`failed login ${status} waits for audit without repeating failure accounting`, async () => {
  const h = fixture(), ack = deferred<ReturnType<AuthAuditLog['append']>>();
  if (status === 429) assert.equal((await login(h.app, 'invalid')).status, 401);
  let calls = 0, settled = false;
  h.audit.append = record => { calls++; return ack.promise.then(() => h.records.append(record)); };
  const pending = Promise.resolve(login(h.app, 'invalid')); void pending.then(() => { settled = true; });
  await turn(); assert.equal(settled, false); assert.equal(calls, 1);
  ack.resolve({ id: 'test', ts: 1, event: 'access_key_login', outcome: 'failure' });
  const response = await pending; assert.equal(response.status, status); assert.equal(calls, 1);
  assert.equal(h.records.list().at(-1)!.failureCount, status === 401 ? 1 : 2);
  assert.equal(h.sessions.size, 0);
});

test('member login rechecks the original issued session after audit, without issuing or revoking another session', async () => {
  let current = true, issued = 0, revoked = 0;
  const h = fixture({ memberLogin: () => { issued++; return 'original-member-session'; },
    memberSessionCurrent: () => current, revokeMemberSession: () => { revoked++; } });
  const ack = deferred<ReturnType<AuthAuditLog['append']>>();
  h.audit.append = record => ack.promise.then(() => h.records.append(record));
  const pending = login(h.app, 'hub_key_fixture'); await turn();
  assert.equal(issued, 1); current = false;
  ack.resolve({ id: 'test', ts: 1, event: 'access_key_login', outcome: 'success' });
  const response = await pending;
  assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(issued, 1); assert.equal(revoked, 0); assert.equal(h.sessions.size, 0);
});

for (const refusal of ['revoked', 'rotated'] as const)
  test(`Passkey original session is not reissued or delivered after ${refusal} during audit`, async () => {
    let current = true, checks = 0;
    const h = fixture(), ack = deferred<ReturnType<AuthAuditLog['append']>>();
    h.passkeys.verifyAuthentication = async () => ({ verified: true, credentialHash: 'test-credential', keyIdentityHash: keyIdentityHash('fixture-key'),
      sessionToken: 'original-passkey-session', isCurrent: () => { checks++; return current; } });
    h.audit.append = record => ack.promise.then(() => h.records.append(record));
    const pending = h.app.request('/api/auth/passkeys/login/verify', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    await turn(); assert.equal(checks, 2); assert.equal(h.sessions.size, 0);
    if (refusal === 'revoked') current = false; else h.deps.accessKey = 'rotated-fixture-key';
    ack.resolve({ id: 'test', ts: 1, event: 'passkey_assertion', outcome: 'success' });
    const response = await pending;
    assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(checks, 3); assert.equal(h.sessions.size, 0);
  });

test('cancelled login waits for original audit settlement but never delivers a cookie or releases its original session', async () => {
  const h = fixture(), controller = new AbortController(), ack = deferred<ReturnType<AuthAuditLog['append']>>();
  let calls = 0, settled = false;
  h.audit.append = record => { calls++; return ack.promise.then(() => h.records.append(record)); };
  const pending = Promise.resolve(h.app.request(new Request('http://localhost/api/auth/login', { method: 'POST',
    signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'fixture-key' }) })));
  void pending.then(() => { settled = true; });
  await turn(); controller.abort(); await turn(); assert.equal(settled, false); assert.equal(calls, 1);
  ack.resolve({ id: 'test', ts: 1, event: 'access_key_login', outcome: 'success' });
  const response = await pending;
  assert.equal(response.status, 408); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(h.sessions.size, 1); assert.equal(calls, 1);
});

for (const paged of [false, true]) test(`audit ${paged ? 'page' : 'list'} unknown is sanitized and never rerun`, async () => {
  const h = fixture(), ack = deferred<never>(); let calls = 0;
  if (paged) h.audit.page = () => { calls++; return ack.promise; };
  else h.audit.list = () => { calls++; return ack.promise; };
  const pending = h.app.request('/api/auth/audit' + (paged ? '?page=true' : '')); await turn();
  ack.reject(Error('secret-db-path SQL fixture-key')); const response = await pending;
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal(calls, 1); assert.doesNotMatch(h.logs.join('\n'), /secret-db-path|SQL|fixture-key/);
});

test('logout awaits audit after original deletion without restarting, reissuing or repeating the original mutation', async () => {
  let deletes = 0;
  const h = fixture({ sessions: { add: () => { throw Error('No issuance'); }, delete: () => { deletes++; return true; } },
    auditIdentity: () => ({ userId: 'test-user', authMethod: 'administrator' }) });
  const ack = deferred<ReturnType<AuthAuditLog['append']>>(); let settled = false;
  h.audit.append = record => ack.promise.then(() => h.records.append(record));
  const pending = Promise.resolve(h.app.request('/api/auth/logout', { method: 'POST', headers: { cookie: 'agentopsdeck_session=original' } }));
  void pending.then(() => { settled = true; });
  await turn(); assert.equal(deletes, 1); assert.equal(settled, false);
  ack.resolve({ id: 'test', ts: 1, event: 'access_key_logout', outcome: 'success' });
  const response = await pending; assert.equal(response.status, 200); assert.equal(deletes, 1);
  assert.match(response.headers.get('set-cookie')!, /Max-Age=0/);
});

test('legacy audit list/page payloads retain their exact frontend-compatible shapes', async () => {
  const h = fixture(); h.records.append({ event: 'access_key_login', outcome: 'success' });
  assert.deepEqual(await (await h.app.request('/api/auth/audit')).json(), { records: h.records.list() });
  const page = h.records.page({ limit: 50 });
  assert.deepEqual(await (await h.app.request('/api/auth/audit?page=true')).json(), JSON.parse(JSON.stringify(page)));
});

for (const passkey of [false, true]) test(`original legacy ${passkey ? 'Passkey' : 'administrator'} session deletion during audit prevents cookie delivery`, async () => {
  const h = fixture(), ack = deferred<ReturnType<AuthAuditLog['append']>>();
  if (passkey) h.passkeys.verifyAuthentication = async () => ({ verified: true, credentialHash: 'test-credential',
    keyIdentityHash: keyIdentityHash('fixture-key'), isCurrent: () => true });
  h.audit.append = record => ack.promise.then(() => h.records.append(record));
  const pending = passkey ? h.app.request('/api/auth/passkeys/login/verify', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' }) : login(h.app);
  await turn(); assert.equal(h.sessions.size, 1); h.sessions.clear();
  ack.resolve({ id: 'test', ts: 1, event: 'access_key_login', outcome: 'success' });
  const response = await pending;
  assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(h.sessions.size, 0);
});

test('original SQLite audit retention failure rolls back its insert without a second insert, connection or cookie', async context => {
  const db = new DatabaseSync(':memory:'); context.after(() => db.close());
  const h = fixture(); h.deps.auditLog = new AuthAuditLog(1000, db);
  const prepare = db.prepare.bind(db);
  context.mock.method(db, 'prepare', (sql: string) => {
    if (sql.startsWith('DELETE FROM hub_auth_audit')) throw Error('secret-db-path SQL fixture-key');
    return prepare(sql);
  });
  const response = await login(h.app);
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal((prepare('SELECT count(*) AS n FROM hub_auth_audit').get() as { n: number }).n, 0);
  assert.equal(db.isTransaction, false);
  assert.equal(h.sessions.size, 1);
  assert.ok(h.logs.some(line => { const row = JSON.parse(line); return row.step === 14 && row.unknown === 1; }));
  assert.doesNotMatch(h.logs.join('\n'), /secret-db-path|SQL|fixture-key/);
});

for (const paged of [false, true]) test(`original SQLite audit ${paged ? 'page' : 'list'} prune failure is not treated as successful read recovery`, async context => {
  const db = new DatabaseSync(':memory:'); context.after(() => db.close());
  const h = fixture(), records = new AuthAuditLog(1000, db); h.deps.auditLog = records;
  records.append({ event: 'access_key_login', outcome: 'success' });
  const prepare = db.prepare.bind(db); let pruneAttempts = 0;
  context.mock.method(db, 'prepare', (sql: string) => {
    if (sql.startsWith('DELETE FROM hub_auth_audit')) { pruneAttempts++; throw Error('secret-db-path SQL fixture-key'); }
    return prepare(sql);
  });
  const response = await h.app.request('/api/auth/audit' + (paged ? '?page=true' : ''));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal(pruneAttempts, 1);
  assert.equal((prepare('SELECT count(*) AS n FROM hub_auth_audit').get() as { n: number }).n, 1);
  assert.ok(h.logs.some(line => { const row = JSON.parse(line); return row.step === (paged ? 15 : 16) && row.unknown === 1; }));
  assert.doesNotMatch(h.logs.join('\n'), /secret-db-path|SQL|fixture-key/);
});
