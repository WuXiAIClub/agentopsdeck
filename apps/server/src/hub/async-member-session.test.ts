import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncHubMemberSessions } from './async-member-session.js';
import type { AsyncHubMemberOwner as Owner } from './async-member-owner.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubStore } from './hub-store.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthReadCancelledError } from '../auth/route-read-wait.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const token = 'hub_session_' + 'x'.repeat(43), key = 'hub_key_' + 'z'.repeat(43);
const snapshot = { principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) };
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', signal ? { signal } : undefined);
const port = (command: (kind: HubMemberKind, input: unknown) => unknown) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<Owner, 'command'>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('request dependencies use original session commands and fresh issued-session proof', async () => {
  const calls: { kind: string; input: unknown }[] = [];
  const service = new AsyncHubMemberSessions(port((kind, input) => {
    calls.push({ kind, input });
    return kind === 'memberSessionCreate' ? { token } : kind === 'memberSnapshot' ? snapshot : null;
  }), quiet);
  const caller = service.forRequest(request());
  assert.equal(await caller.memberLogin(undefined), undefined);
  assert.equal(await caller.memberLogin(key), token);
  await caller.revokeMemberSession(token);
  assert.deepEqual(calls, [{ kind: 'memberSessionCreate', input: { key } },
    { kind: 'memberSnapshot', input: { sessionToken: token } },
    { kind: 'memberSessionDelete', input: { token } }]);
});

test('revocation before final session proof never delivers the issued token or reissues it', async () => {
  let writes = 0;
  const caller = new AsyncHubMemberSessions(port(kind => {
    if (kind === 'memberSessionCreate') { writes++; return { token }; }
    return null;
  }), quiet).forRequest(request());
  assert.equal(await caller.memberLogin(key), undefined);
  assert.equal(writes, 1);
});

test('administrator and malformed member login probes are no-ops only before lifecycle or unknown-write fences', async () => {
  let calls = 0;
  const service = new AsyncHubMemberSessions(port(() => { calls++; throw Error('isolated-unknown'); }), quiet);
  const caller = service.forRequest(request());
  const probes = [undefined, '', 'administrator-key', 'hub_key_invalid', 'hub_key_' + 'a'.repeat(44)];
  for (const value of probes) assert.equal(await caller.memberLogin(value), undefined);
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.forRequest(request(controller.signal)).memberLogin('administrator-key'), AuthReadCancelledError);
  await assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  for (const value of probes) await assert.rejects(caller.memberLogin(value), AuthPersistenceError);
  assert.equal(calls, 1);
  const retained = service.forRequest(request()); await service.close();
  for (const value of probes) await assert.rejects(retained.memberLogin(value), AuthPersistenceError);
  assert.equal(calls, 1);
});

test('non-member logout tokens are no-ops only while the request facade remains usable', async () => {
  let calls = 0;
  const service = new AsyncHubMemberSessions(port(() => { calls++; return null; }), quiet);
  const caller = service.forRequest(request());
  for (const value of ['a'.repeat(43), '', 'invalid-cookie', 'hub_session_invalid']) {
    await caller.revokeMemberSession(value);
  }
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.forRequest(request(controller.signal)).revokeMemberSession('a'.repeat(43)), AuthReadCancelledError);
  await service.close();
  await assert.rejects(caller.revokeMemberSession('a'.repeat(43)), AuthPersistenceError);
  assert.equal(calls, 0);
});

test('unknown member deletion still fences later non-member no-ops on the same request', async () => {
  let calls = 0;
  const service = new AsyncHubMemberSessions(port(() => { calls++; throw Error('isolated-unknown'); }), quiet);
  const caller = service.forRequest(request());
  await assert.rejects(caller.revokeMemberSession(token), AuthPersistenceError);
  await assert.rejects(caller.revokeMemberSession('a'.repeat(43)), AuthPersistenceError);
  assert.equal(calls, 1);
  await service.close();
});

test('cancelled admitted login waits actual settlement, logs pending, and never fabricates cookie delivery', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const service = new AsyncHubMemberSessions(port(() => { writes++; return wait.promise; }),
    new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const caller = service.forRequest(request(controller.signal));
  let settled = false;
  const done = assert.rejects(caller.memberLogin(key), AuthReadCancelledError).then(() => { settled = true; });
  await tick(); controller.abort(); await pause(20);
  assert.equal(service.pending, 1); assert.equal(settled, false);
  assert.ok(logs.some(line => line.includes('"phase":"pending"')));
  wait.resolve({ token }); await done;
  assert.equal(service.pending, 0);
  await assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  assert.equal(writes, 1);
  assert.equal(logs.join('').includes(token), false); assert.equal(logs.join('').includes(key), false);
});

test('pre-dispatch abort performs no mutation; unknown owner failure fences this request only', async () => {
  const controller = new AbortController(); controller.abort(); let writes = 0;
  const service = new AsyncHubMemberSessions(port(() => { writes++; throw Error('private-fixture-error'); }), quiet);
  await assert.rejects(service.forRequest(request(controller.signal)).memberLogin(key), AuthReadCancelledError);
  assert.equal(writes, 0);
  const caller = service.forRequest(request());
  await assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  await assert.rejects(caller.revokeMemberSession(token), AuthPersistenceError);
  assert.equal(writes, 1);
});

test('final proof timeout retains original read budget and does not replay the committed login', async () => {
  const wait = deferred<unknown>(), logs: string[] = []; let writes = 0;
  const service = new AsyncHubMemberSessions(port(kind => {
    if (kind === 'memberSessionCreate') { writes++; return { token }; }
    return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const caller = service.forRequest(request());
  await assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  assert.equal(service.pending, 1); assert.equal(writes, 1);
  await assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  wait.reject(Error('private-late-read')); await tick();
  assert.equal(service.pending, 0); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"timedOut":1')));
  assert.equal(logs.join('').includes('private-late-read'), false);
});

test('logout disconnect waits the original delete and does not start a replacement mutation', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(); let writes = 0;
  const service = new AsyncHubMemberSessions(port(() => { writes++; return wait.promise; }), quiet, 5, 5);
  const caller = service.forRequest(request(controller.signal));
  let settled = false;
  const done = assert.rejects(caller.revokeMemberSession(token), AuthReadCancelledError).then(() => { settled = true; });
  await tick(); controller.abort(); await pause(15);
  assert.equal(service.pending, 1); assert.equal(settled, false);
  wait.resolve(null); await done;
  await assert.rejects(caller.revokeMemberSession(token), AuthPersistenceError);
  assert.equal(writes, 1); assert.equal(service.pending, 0);
});

test('256 original mutations retain shared admission after disconnect; no 257th dispatch or late replay', async () => {
  const wait = deferred<unknown>(); let writes = 0;
  const service = new AsyncHubMemberSessions(port(() => { writes++; return wait.promise; }), quiet, 5000, 5000);
  const controllers = Array.from({ length: 256 }, () => new AbortController());
  const accepted = controllers.map(c => assert.rejects(service.forRequest(request(c.signal)).memberLogin(key), AuthReadCancelledError));
  await tick(); assert.equal(service.pending, 256);
  controllers.forEach(c => c.abort());
  await assert.rejects(service.forRequest(request()).memberLogin(key), AuthPersistenceError);
  assert.equal(service.pending, 256); assert.equal(writes, 256);
  wait.resolve({ token }); await Promise.all(accepted);
  assert.equal(service.pending, 0); assert.equal(writes, 256);
});

test('real complete Hub owner login/logout preserves member role and old cookies across original facade reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-member-session-r39-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'fixture-vault'); let owner: AsyncHubMemberOwner | undefined;
  try {
    const user = original.createUser('Existing member'), issued = original.identities.issueKey(user.id);
    const oldCookie = original.identities.createSession(issued.token)!;
    await original.close();
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault' }, quiet);
    const caller = new AsyncHubMemberSessions(owner, quiet).forRequest(request());
    const cookie = await caller.memberLogin(issued.token); assert.ok(cookie);
    const current = await owner.command('memberSnapshot', { sessionToken: cookie }); assert.ok(current);
    assert.deepEqual(current.principal, { userId: user.id, admin: false });
    await caller.revokeMemberSession(cookie);
    assert.equal(await caller.memberSessionCurrent(cookie), false);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: oldCookie }));
    await owner.close();
    const reopened = new HubStore(file, 'fixture-vault');
    try {
      assert.equal(reopened.identities.requestPrincipal(new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + cookie } }), () => false), undefined);
      assert.deepEqual(reopened.identities.requestPrincipal(new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + oldCookie } }), () => false), { userId: user.id, admin: false });
    } finally { await reopened.close(); }
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real usage-write and logout faults roll back session state and keep the original owner healthy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-member-session-fault-r39-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'fixture-vault'); let owner: AsyncHubMemberOwner | undefined;
  const rows = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
      return ['hub_login_sessions', 'hub_key_usage', 'hub_user_usage'].map(table =>
        db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort());
    } finally { db.close(); }
  };
  try {
    const user = original.createUser('Existing member'), issued = original.identities.issueKey(user.id);
    const cookie = original.identities.createSession(issued.token)!;
    await original.close(); const before = rows();
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TRIGGER fail_session_usage BEFORE INSERT ON hub_user_usage BEGIN SELECT RAISE(ABORT,'private-fixture-usage-error'); END");
      db.exec("CREATE TRIGGER fail_session_delete BEFORE DELETE ON hub_login_sessions BEGIN SELECT RAISE(ABORT,'private-fixture-delete-error'); END");
    } finally { db.close(); }
    const logs: string[] = [];
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault' }, new PerformanceDiagnostics(line => logs.push(line)));
    const service = new AsyncHubMemberSessions(owner, new PerformanceDiagnostics(line => logs.push(line)));
    await assert.rejects(service.forRequest(request()).memberLogin(issued.token), AuthPersistenceError);
    await assert.rejects(service.forRequest(request()).revokeMemberSession(cookie), AuthPersistenceError);
    assert.equal(await service.forRequest(request()).memberSessionCurrent(cookie), true);
    assert.equal(owner.snapshot().unavailable, false);
    await owner.close(); assert.deepEqual(rows(), before);
    const failures = logs.map(line => JSON.parse(line)).filter(entry =>
      entry.operation === 'hub-member-sqlite-command' && entry.category === 'failed');
    for (const step of [2, 3]) {
      assert.ok(failures.some(entry => entry.step === step && entry.unknown === 1));
    }
    assert.equal(logs.join('').includes('private-fixture-'), false);
    assert.equal(logs.join('').includes(issued.token), false); assert.equal(logs.join('').includes(cookie), false);
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
});
