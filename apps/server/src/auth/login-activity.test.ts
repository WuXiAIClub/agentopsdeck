import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApplication } from '../application.js';
import { loadConfig } from '../config.js';
import { HubStore } from '../hub/hub-store.js';
import { HubIdentities } from '../hub/identity.js';
import { AuthAuditLog } from './security.js';

test('member activity is sampled without counting cookie requests as key logins or key use', context => {
  const database = new DatabaseSync(':memory:');
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('member')");
  const identities = new HubIdentities(database);
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  try {
    const key = identities.issueKey('member');
    const session = identities.createSession(key.token)!;
    const request = new Request('http://test', { headers: { cookie: `agentopsdeck_session=${session}` } });
    const original = identities.listKeys('member')[0]!;
    now += 30_000;
    identities.recordActivity(request);
    assert.equal(identities.listKeys('member')[0]!.lastActiveAt, original.lastActiveAt);
    now += 31_000;
    identities.recordActivity(request);
    let usage = identities.listKeys('member')[0]!;
    assert.equal(usage.lastActiveAt, now);
    assert.equal(usage.lastUsedAt, original.lastUsedAt);
    assert.equal(usage.lastLoginAt, original.lastLoginAt);
    assert.equal(usage.loginCount, 1);
    identities.recordActivity(new Request('http://test', { headers: { authorization: `Bearer ${key.token}` } }));
    usage = identities.listKeys('member')[0]!;
    assert.equal(usage.lastUsedAt, now);
    assert.equal(usage.loginCount, 1);
    assert.equal(identities.userUsage('member').lastActiveAt, now);
  } finally { database.close(); }
});

test('audit write failures roll back key issuance and revocation instead of losing the historical event', () => {
  const database = new DatabaseSync(':memory:');
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('member')");
  const identities = new HubIdentities(database);
  const fail = () => database.exec("CREATE TRIGGER reject_auth_audit BEFORE INSERT ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
  try {
    fail();
    assert.throws(() => identities.issueKey('member'), /synthetic audit failure/);
    assert.equal(identities.listKeys('member').length, 0);
    database.exec('DROP TRIGGER reject_auth_audit');
    const key = identities.issueKey('member');
    const session = identities.createSession(key.token)!;
    fail();
    assert.throws(() => identities.revokeKey('member', key.id), /synthetic audit failure/);
    assert.equal(identities.listKeys('member').length, 1);
    assert.equal(identities.requestIdentity(new Request('http://test', { headers: { cookie: `agentopsdeck_session=${session}` } }))?.keyId, key.id);
  } finally { database.close(); }
});

test('persistent audit filters before paging, bounds retention, and survives restart without secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-audit-'));
  const file = join(directory, 'audit.sqlite');
  let database = new DatabaseSync(file);
  try {
    let audit = new AuthAuditLog(4, database);
    audit.append({ event: 'access_key_login', outcome: 'success', userId: 'alice', ts: Date.now() - 91 * 86_400_000 });
    for (const userId of ['alice', 'bob', 'alice', 'alice', 'bob']) audit.append({ event: 'access_key_login', outcome: 'success', userId });
    assert.equal(audit.list(100).length, 4);
    assert.deepEqual(audit.list(0), []);
    assert.deepEqual(audit.list(-1), []);
    const first = audit.page({ userId: 'alice', limit: 1 });
    assert.equal(first.records.length, 1);
    assert.equal(first.persistent, true);
    assert.ok(first.nextCursor);
    audit.append({ event: 'member_key_revoked', outcome: 'success', userId: 'bob', keyId: 'deleted-key' });
    const next = audit.page({ userId: 'alice', limit: 1, before: Number(first.nextCursor) });
    assert.equal(next.records.length, 1);
    assert.equal(next.records[0]!.userId, 'alice');
    assert.notEqual(next.records[0]!.id, first.records[0]!.id);
    assert.equal(next.nextCursor, undefined);
    database.close(); database = new DatabaseSync(file); audit = new AuthAuditLog(4, database);
    assert.equal(audit.page().startedAt, first.startedAt);
    assert.equal(audit.list().at(-1)!.keyId, 'deleted-key');
    assert.equal(audit.list().length, 4);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('existing Hub keys migrate without fabricated use; cookie activity differs from key use and login', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-key-usage-'));
  const file = join(directory, 'hub.sqlite');
  let store = new HubStore(file, 'test-vault');
  const user = store.createUser('Member');
  const key = store.identities.issueKey(user.id);
  store.close();
  const database = new DatabaseSync(file);
  database.exec('DROP TABLE hub_key_usage; DROP TABLE hub_user_usage; DROP TABLE hub_auth_audit; DROP TABLE hub_auth_audit_metadata');
  database.close();
  store = new HubStore(file, 'test-vault');
  try {
    const initial = store.identities.listKeys(user.id)[0]!;
    assert.equal(initial.lastLoginAt, null);
    assert.equal(initial.lastUsedAt, null);
    assert.equal(initial.loginCount, 0);
    assert.equal(store.identities.audit.list().length, 0);
    const cookie = store.identities.createSession(key.token)!;
    const afterLogin = store.identities.listKeys(user.id)[0]!;
    store.identities.recordActivity(new Request('http://test', { headers: { cookie: `agentopsdeck_session=${cookie}` } }));
    assert.deepEqual(store.identities.listKeys(user.id)[0], afterLogin);
    assert.equal(afterLogin.loginCount, 1);
    assert.equal(afterLogin.lastUsedAt, afterLogin.lastLoginAt);
    assert.equal(store.identities.revokeKey(user.id, key.id, { actorUserId: 'default' }), true);
    assert.equal(store.identities.revokeKey(user.id, key.id), false);
    assert.equal(store.identities.listKeys(user.id).length, 0);
    assert.ok(store.identities.userUsage(user.id).lastLoginAt);
    const events = store.identities.audit.list();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'member_key_revoked');
    assert.equal(events[0]!.actorUserId, 'default');
    assert.equal(store.identities.requestIdentity(new Request('http://test', { headers: { cookie: `agentopsdeck_session=${cookie}` } })), undefined);
    store.close(); store = new HubStore(file, 'test-vault');
    assert.equal(store.identities.audit.list()[0]!.keyId, key.id);
    assert.equal(readFileSync(file).includes(Buffer.from(key.token)), false);
    assert.equal(readFileSync(file).includes(Buffer.from(cookie)), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Hub HTTP login, logout, key use, revoke and restart have attributed private durable history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-http-'));
  const config = loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: 'synthetic-admin-key',
    AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic-vault',
    AOD_PASSKEYS_FILE: join(directory, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(directory, 'sessions.json'),
    AOD_SESSION_TITLES_FILE: join(directory, 'titles.json') });
  let application = createApplication(config);
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { authorization: 'Bearer synthetic-admin-key' }) =>
    application.app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const user = (await (await request('/api/hub/v1/users', 'POST', { label: 'Alice' })).json()).user;
    const keyPath = `/api/hub/v1/users/${user.id}/login-keys`;
    const key = await (await request(keyPath, 'POST')).json();
    const direct = { authorization: `Bearer ${key.token}` };
    assert.equal((await request('/api/hub/v1/me', 'GET', undefined, direct)).status, 200);
    const directUsage = (await (await request(keyPath)).json()).keys[0];
    assert.equal(directUsage.loginCount, 0);
    assert.equal(directUsage.lastLoginAt, null);
    assert.ok(directUsage.lastUsedAt);
    const login = await request('/api/auth/login', 'POST', { accessKey: key.token }, { 'user-agent': 'SyntheticPrivateBrowser', 'x-forwarded-for': '203.0.113.99' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const member = { cookie };
    assert.equal((await request('/api/hub/v1/me', 'GET', undefined, member)).status, 200);
    for (const headers of [member, direct]) {
      assert.equal((await request('/api/auth/audit?page=true', 'GET', undefined, headers)).status, 403);
      assert.equal((await request(keyPath, 'GET', undefined, headers)).status, 403);
      assert.equal((await request(keyPath, 'POST', {}, headers)).status, 403);
    }
    const ownUsers = await (await request('/api/hub/v1/users', 'GET', undefined, member)).json();
    assert.equal(ownUsers.users.length, 1);
    assert.equal(ownUsers.users[0].usage, undefined);
    assert.equal((await request('/api/auth/audit?page=true', 'GET', undefined, {})).status, 401);
    assert.equal((await request('/api/auth/audit?page=true&before=no')).status, 400);
    assert.equal((await request('/api/auth/login', 'POST', { accessKey: 'hub_key_invalid' }, {})).status, 401);
    assert.equal((await request('/api/auth/logout', 'POST', {}, { ...member, authorization: 'Bearer synthetic-admin-key' })).status, 200);
    assert.equal((await request('/api/hub/v1/me', 'GET', undefined, member)).status, 401);
    let audit = await (await request(`/api/auth/audit?page=true&userId=${user.id}`)).json();
    assert.deepEqual(audit.records.map((record: any) => record.event), ['access_key_logout', 'access_key_login', 'member_key_issued']);
    assert.ok(audit.records.every((record: any) => record.userId === user.id && record.keyId === key.id));
    assert.equal(audit.records[0].authMethod, 'member');
    assert.equal(audit.records[0].keyIdentityHash, undefined);
    const keys = await (await request(keyPath)).json();
    assert.equal(keys.keys[0].loginCount, 1);
    const all = await (await request('/api/auth/audit?page=true')).json();
    assert.ok(all.records.some((record: any) => record.event === 'access_key_login' && record.outcome === 'failure' && !record.userId));
    const serialized = JSON.stringify(all);
    for (const secret of [key.token, 'synthetic-admin-key', 'SyntheticPrivateBrowser', '203.0.113.99', cookie]) assert.equal(serialized.includes(secret), false);
    await application.close(); application = createApplication(config);
    audit = await (await request(`/api/auth/audit?page=true&userId=${user.id}`)).json();
    assert.equal(audit.records.length, 3);
    assert.equal((await (await request(keyPath)).json()).keys[0].loginCount, 1);
    const secondLogin = await request('/api/auth/login', 'POST', { accessKey: key.token }, {});
    const secondCookie = secondLogin.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await request(keyPath + '/' + key.id, 'DELETE')).status, 200);
    assert.equal((await request('/api/hub/v1/me', 'GET', undefined, { cookie: secondCookie })).status, 401);
    audit = await (await request(`/api/auth/audit?page=true&userId=${user.id}`)).json();
    assert.equal(audit.records[0].event, 'member_key_revoked');
    assert.equal(audit.records[0].actorUserId, 'default');
    assert.ok((await (await request('/api/hub/v1/users')).json()).users.find((entry: any) => entry.id === user.id).usage.lastLoginAt);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});
