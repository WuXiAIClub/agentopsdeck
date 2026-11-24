import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRoles } from './async-member-roles.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { validHubRoleCommand, validHubRoleReply, type HubRoleCommand } from './member-role-domain.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (n: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === n;
function seed(store: HubStore, file: string) {
  const admin = store.createUser('Administrator'), member = store.createUser('Member');
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(admin.id);
  const key = store.identities.issueKey(admin.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: admin.id, admin: true }) };
  const command = (c: HubRoleCommand) => c.action === 'read'
    ? executeHubMemberCommand(store, 'roleRead', { ...proof, command: c })
    : executeHubMemberCommand(store, 'roleSet', { ...proof, command: c });
  return { store, file, db, admin, member, key, token, request, proof, command };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-role-owner-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'role-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function grants(f: ReturnType<typeof seed>) {
  const connection = f.store.upsertConnection({ ownerUserId: f.admin.id, label: 'Original node', connectorUrl: 'http://fixture.invalid' });
  const target = { ownerUserId: f.admin.id, connectionId: connection.id, userId: f.member.id };
  const managed = f.store.grants.create(target, { runtime: 'codex', sessionKey: 'session', actions: ['messages:read'] });
  const direct = f.store.grants.create(target, { runtime: 'codex', sessionKey: 'session', actions: ['messages:read'] });
  f.db.prepare("INSERT INTO role_grants VALUES (?, 'hub')").run(managed.id);
  return { managed, direct };
}
const durable = (f: ReturnType<typeof seed>) => ({ role: f.store.roles.hubRole(f.member.id),
  grants: f.db.prepare('SELECT id, version, revoked FROM node_grants ORDER BY id').all(),
  audit: f.db.prepare('SELECT * FROM hub_auth_audit ORDER BY sequence').all() });

test('role domain retains original default, CAS, managed-only invalidation and audit', () => fixture(f => {
  const { managed, direct } = grants(f), before = durable(f);
  assert.deepEqual(f.command({ action: 'read', userId: f.member.id }), { userId: f.member.id, role: 'member', version: 0 });
  assert.deepEqual(f.command({ action: 'set', userId: f.member.id, role: 'admin', version: 0 }), { userId: f.member.id, role: 'admin', version: 1 });
  assert.deepEqual({ ...f.db.prepare('SELECT version, revoked FROM node_grants WHERE id=?').get(managed.id) }, { version: 2, revoked: 1 });
  assert.deepEqual({ ...f.db.prepare('SELECT version, revoked FROM node_grants WHERE id=?').get(direct.id) }, { version: 1, revoked: 0 });
  const after = durable(f); assert.equal(after.audit.length, before.audit.length + 1);
  const record = JSON.parse(String(after.audit.at(-1)!.record));
  assert.equal(record.event, 'role_changed'); assert.equal(record.userId, f.member.id);
  assert.equal(record.actorUserId, f.admin.id); assert.equal(record.reason, 'hub:admin');
  assert.deepEqual(f.command({ action: 'set', userId: f.member.id, role: 'member', version: 0 }), { error: 'changed' });
  assert.deepEqual(durable(f), after); assert.equal(f.db.isTransaction, false);
}));
test('role domain denies self, missing, stale scope, lost admin and revoked credentials without effects', () => fixture(f => {
  const set = { action: 'set' as const, userId: f.member.id, role: 'admin' as const, version: 0 }, before = durable(f);
  assert.deepEqual(f.command({ ...set, userId: f.admin.id, version: 1 }), { error: 'self' });
  assert.deepEqual(f.command({ ...set, userId: 'missing' }), { error: 'missing' });
  assert.deepEqual(f.command({ action: 'read', userId: 'missing' }), { error: 'missing' });
  assert.equal(executeHubMemberCommand(f.store, 'roleSet', { ...f.proof, expectedScope: '0'.repeat(64), command: set }), null);
  f.db.prepare("UPDATE hub_roles SET role='member', version=2 WHERE user_id=?").run(f.admin.id);
  assert.equal(f.command(set), null);
  f.db.prepare("UPDATE hub_roles SET role='admin', version=3 WHERE user_id=?").run(f.admin.id);
  f.store.identities.revokeKey(f.admin.id, f.key.id);
  assert.equal(f.command(set), null); assert.deepEqual(f.store.roles.hubRole(f.member.id), before.role);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_auth_audit WHERE record LIKE '%role_changed%'").get()!.n, 0);
}));
for (const [table, event] of [['hub_roles', 'INSERT'], ['node_grants', 'UPDATE'], ['hub_auth_audit', 'INSERT']] as const) {
  test('role '+table+' fault rolls back role, all grants and audit together; later request recovers', () => fixture(f => {
    grants(f); const before = durable(f);
    f.db.exec(`CREATE TRIGGER reject_role BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'private-role-body'); END`);
    const set = { action: 'set' as const, userId: f.member.id, role: 'admin' as const, version: 0 };
    assert.throws(() => f.command(set)); assert.deepEqual(durable(f), before); assert.equal(f.db.isTransaction, false);
    f.db.exec('DROP TRIGGER reject_role'); assert.deepEqual(f.command(set), { userId: f.member.id, role: 'admin', version: 1 });
    assert.equal(f.db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  }));
}
for (const committed of [false, true]) test('outer role commit ACK fault remains unknown, no internal replay; committed='+committed, () => fixture(f => {
  const exec = f.db.exec.bind(f.db), originalStart = performanceDiagnostics.start, logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const fault = Object.assign(new Error('private-role-commit'), { code: 'ERR_SQLITE_ERROR', errcode: 10 }); let releases = 0;
  f.db.exec = sql => {
    if (sql === 'RELEASE hub_identity_check') {
      releases++; if (committed) exec(sql); throw fault;
    }
    exec(sql);
  };
  performanceDiagnostics.start = diagnostics.start.bind(diagnostics);
  try {
    assert.throws(() => f.command({ action: 'set', userId: f.member.id, role: 'admin', version: 0 }), e => e === fault);
    assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
    assert.deepEqual({ ...f.store.roles.hubRole(f.member.id) }, committed ? { role: 'admin', version: 1 } : { role: 'member', version: 0 });
    assert.ok(logs.some(line => { const r = JSON.parse(line); return r.operation === 'hub-identity-check' && r.unknown === 1 && r.sqlErrorCode === 10; }));
    for (const secret of [f.token, f.key.token, fault.message, f.member.id]) assert.equal(logs.join('').includes(secret), false);
  } finally { f.db.exec = exec; performanceDiagnostics.start = originalStart; }
}));
test('role protocol only transports bounded primitives and fixed actions, never authority or callbacks', () => fixture(f => {
  const command = { action: 'set', userId: f.member.id, role: 'admin', version: 0 };
  assert.equal(validHubMemberInput('roleSet', { ...f.proof, command }), true);
  for (const c of [{ ...command, admin: true }, { ...command, version: -1 }, { ...command, version: Number.MAX_SAFE_INTEGER },
    { ...command, version: 0.5 }, { ...command, role: 'owner' }, { ...command, userId: '' }, { ...command, userId: 'x'.repeat(16_385) }]) assert.equal(validHubRoleCommand(c), false);
  assert.equal(validHubMemberInput('roleRead', { ...f.proof, command }), false);
  assert.equal(validHubMemberInput('roleSet', { ...f.proof, command, authorized: true }), false);
  assert.equal(validHubMemberOutput('roleSet', { userId: f.member.id, role: 'admin', version: 1, callback() {} }), false);
  assert.equal(validHubRoleReply({ action: 'read', userId: f.member.id }, { error: 'self' }), false);
  assert.equal(validHubRoleCommand({ action: 'read', userId: f.member.id }), true);
}));
test('nested role domain cannot settle its enclosing transaction; outer rollback restores role, grants and audit', () => fixture(f => {
  grants(f); const before = durable(f); f.db.exec('BEGIN');
  try {
    assert.deepEqual(f.command({ action: 'set', userId: f.member.id, role: 'admin', version: 0 }), { userId: f.member.id, role: 'admin', version: 1 });
    assert.equal(f.db.isTransaction, true);
  } finally { f.db.exec('ROLLBACK'); }
  assert.deepEqual(durable(f), before);
}));
test('role read is pure and does not rewrite a legacy safe-integer version', () => fixture(f => {
  f.db.prepare("INSERT INTO hub_roles VALUES (?, 'member', ?)").run(f.member.id, Number.MAX_SAFE_INTEGER);
  const before = durable(f);
  assert.deepEqual(f.command({ action: 'read', userId: f.member.id }), { userId: f.member.id, role: 'member', version: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(durable(f), before);
}));
test('real complete worker changes role once, persists original audit and reopens original store', () => fixture(async f => {
  grants(f); await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'role-fixture' }, quiet);
  try {
    const roles = new AsyncHubMemberRoles(owner, quiet);
    assert.deepEqual(await roles.read(f.request, f.member.id), { role: 'member', version: 0 });
    assert.deepEqual(await roles.set(f.request, f.member.id, 'admin', 0), { role: 'admin', version: 1 });
    await assert.rejects(roles.set(f.request, f.member.id, 'member', 0), status(409));
    assert.equal(roles.pending, 0);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'role-fixture');
  try {
    assert.deepEqual({ ...reopened.roles.hubRole(f.member.id) }, { role: 'admin', version: 1 });
    assert.equal(reopened.identities.audit.list().filter(r => r.event === 'role_changed').length, 1);
  } finally { await reopened.close(); }
}));
const snapshot = (admin = true, scope = 'a'.repeat(64)) => ({ principal: { userId: 'administrator', admin }, recoveryScope: scope });
const port = (command: (kind: string, input: any) => unknown | Promise<unknown>) => ({ command: async (kind: string, input: any) => command(kind, input) }) as Pick<AsyncHubMemberOwner, 'command'>;
const req = (signal?: AbortSignal) => new Request('http://fixture.invalid', { ...(signal ? { signal } : {}) });
for (const value of [{ userId: 'other', role: 'admin', version: 1 }, { userId: 'target', role: 'member', version: 1 },
  { userId: 'target', role: 'admin', version: 2 }]) test('caller rejects unrelated/wrong-role/wrong-version ACK without replay: '+JSON.stringify(value), async () => {
  let writes = 0; const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return value;
  }), quiet);
  await assert.rejects(roles.set(req(), 'target', 'admin', 0), status(503)); assert.equal(writes, 1); assert.equal(roles.pending, 0);
});
for (const [error, code] of [['missing', 404], ['self', 403], ['changed', 409]] as const) test('role caller preserves explicit rejection status '+code, async () => {
  let writes = 0; const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return { error };
  }), quiet);
  await assert.rejects(roles.set(req(), 'target', 'admin', 0), status(code)); assert.equal(writes, 1);
});
test('role caller rejects invalid input, non-admin and already aborted request before any effect', async () => {
  let writes = 0; const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(false); writes++; return null;
  }), quiet);
  await assert.rejects(roles.set(req(), '', 'admin', 0), status(400));
  await assert.rejects(roles.set(req(), 'target', 'admin', 0), status(403));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(roles.set(req(abort.signal), 'target', 'admin', 0), status(499)); assert.equal(writes, 0);
});
test('role read timeout retains original pending slot, never retries; late reply safely settles', async () => {
  let reads = 0, settle!: (v: unknown) => void; const logs: string[] = [];
  const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); reads++; return new Promise(resolve => { settle = resolve; });
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 10);
  await assert.rejects(roles.read(req(), 'target'), status(503));
  assert.equal(reads, 1); assert.equal(roles.pending, 1);
  settle({ userId: 'target', role: 'member', version: 0 }); await tick(); assert.equal(roles.pending, 0);
  assert.ok(logs.some(line => { const r = JSON.parse(line); return r.step === 35 && r.timedOut === 1; }));
});
test('role write has no timeout, cancellation cannot settle original effect; warning logs carry no credentials', async () => {
  let writes = 0, settle!: (v: unknown) => void; const logs: string[] = [], abort = new AbortController();
  const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return new Promise(resolve => { settle = resolve; });
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 10);
  const request = new Request('http://fixture.invalid', { signal: abort.signal, headers: { cookie: 'private-role-cookie' } });
  let finished = false; const saving = roles.set(request, 'private-target', 'admin', 0); const rejection = assert.rejects(saving, status(499)).then(() => { finished = true; });
  await tick(); abort.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finished, false); assert.equal(roles.pending, 1); assert.equal(writes, 1);
  settle({ userId: 'private-target', role: 'admin', version: 1 }); await rejection; assert.equal(roles.pending, 0);
  assert.ok(logs.some(line => { const r = JSON.parse(line); return r.step === 36 && r.phase === 'pending'; }));
  for (const secret of ['private-role-cookie', 'private-target']) assert.equal(logs.join('').includes(secret), false);
});
test('post-commit authority withdrawal denies delivery without rollback, compensation or replay', async () => {
  let writes = 0, withdrawn = false;
  const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(!withdrawn); writes++; withdrawn = true; return { userId: 'target', role: 'admin', version: 1 };
  }), quiet);
  await assert.rejects(roles.set(req(), 'target', 'admin', 0), status(401)); assert.equal(writes, 1);
});
test('mutation ACK loss reports unavailable, never sends roleSet twice', async () => {
  let writes = 0; const roles = new AsyncHubMemberRoles(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; throw new Error('private-role-unknown');
  }), quiet);
  await assert.rejects(roles.set(req(), 'target', 'admin', 0), status(503)); assert.equal(writes, 1);
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
for (const value of [{ userId: 'other', role: 'admin', version: 1 }, { userId: 'target', role: 'member', version: 1 },
  { userId: 'target', role: 'admin', version: 2 }]) test('owner rejects mismatched role ACK, keeps reservation until physical exit: '+JSON.stringify(value), async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-role-ack-')), file = join(root, 'hub.sqlite'), fake = new FakeWorker(), logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file }, new PerformanceDiagnostics(line => logs.push(line)), () => fake as unknown as Worker, 5);
  fake.emit('message', { kind: 'ready' });
  try {
    const input = { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'set' as const, userId: 'target', role: 'admin' as const, version: 0 } };
    const pending = owner.command('roleSet', input), rejection = assert.rejects(pending, HubMemberOwnerUnavailable);
    await tick(); fake.emit('message', { id: fake.messages[0]!.id, kind: 'roleSet', ok: true, body: JSON.stringify(value) });
    await rejection; assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, () => new FakeWorker() as unknown as Worker), HubMemberOwnerUnavailable);
    let exited = false; const closing = owner.close().then(() => { exited = true; }, () => { exited = true; });
    // Explicit shutdown may retire the original worker once. A resolved
    // terminate promise is not its exit and cannot release its reservation.
    await tick(); assert.equal(exited, false); assert.equal(fake.stops, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, () => new FakeWorker() as unknown as Worker), HubMemberOwnerUnavailable);
    fake.emit('exit', 1); await closing; assert.equal(owner.snapshot().ownerExitConfirmed, true);
    assert.ok(logs.some(line => { const r = JSON.parse(line); return r.ownerFailureCode === 4; }));
  } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
