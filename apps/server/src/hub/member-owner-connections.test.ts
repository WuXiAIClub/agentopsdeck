import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, hubMemberResultBytes, HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { HUB_CONNECTION_RPC_BYTES, HUB_CONNECTION_ROW_LIMIT } from './member-connection-domain.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-connections-r67-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'connection-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Member'), other = store.createUser('Other');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  const connection = store.upsertConnection({ id: 'member-connection', ownerUserId: member.id,
    label: 'Old connection', connectorUrl: 'http://localhost:4567', credentialToken: 'private-connector-token', capabilities: ['sessions'] });
  store.upsertConnection({ id: 'other-connection', ownerUserId: other.id, label: 'Private', connectorUrl: 'http://private.invalid' });
  const read = () => executeHubMemberCommand(store, 'connectionSnapshot', proof)!;
  return { store, file, db, member, other, key, token, proof, connection, read };
}
test('connection domain matches original public data and cannot include another account or secret', () => fixture(f => {
  const result = f.read();
  assert.equal(validHubMemberOutput('connectionSnapshot', JSON.parse(JSON.stringify(result))), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.connections)), JSON.parse(JSON.stringify(f.store.listConnections(f.member.id))));
  assert.deepEqual(result.users, [f.store.getUser(f.member.id)]);
  assert.equal(JSON.stringify(result).includes('private-connector-token'), false);
  assert.equal(JSON.stringify(result).includes('private.invalid'), false);
  assert.equal(hubMemberResultBytes('connectionSnapshot'), HUB_CONNECTION_RPC_BYTES);
}));
test('original sort, disabled/degraded status, deletion and malformed capabilities fallback survive', () => fixture(f => {
  f.db.prepare("UPDATE env_connections SET status='degraded', capabilities_json=? WHERE owner_user_id=?").run('[1,"old","old",null]', f.member.id);
  assert.deepEqual(f.read().connections[0]!.capabilities, ['old', 'old']);
  f.db.prepare("UPDATE env_connections SET capabilities_json='broken', status='disabled' WHERE owner_user_id=?").run(f.member.id);
  assert.deepEqual(f.read().connections[0]!.capabilities, []);
  assert.equal(f.read().connections[0]!.status, 'disabled');
  f.db.prepare('UPDATE env_connections SET deleted_at=1 WHERE owner_user_id=?').run(f.member.id);
  assert.deepEqual(f.read().connections, []);
}));
test('caller user IDs, boolean proof, stale role/scope and revoked sessions never select display rows', () => fixture(f => {
  for (const extra of [{ ownerUserId: f.other.id }, { admin: true }, { authorized: true }, { sql: 'SELECT' }])
    assert.equal(validHubMemberInput('connectionSnapshot', { ...f.proof, ...extra }), false);
  assert.equal(executeHubMemberCommand(f.store, 'connectionSnapshot', { ...f.proof, expectedScope: '0'.repeat(64) }), null);
  f.db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(f.member.id);
  assert.equal(executeHubMemberCommand(f.store, 'connectionSnapshot', f.proof), null);
  const admin = { ...f.proof, expectedScope: f.store.identities.recoveryScope({ userId: f.member.id, admin: true }) };
  const result = executeHubMemberCommand(f.store, 'connectionSnapshot', admin)!;
  assert.equal(result.users.length, f.store.listUsers().length);
  assert.equal(result.connections.length, 1);
  f.store.identities.revokeSession(f.token);
  assert.equal(executeHubMemberCommand(f.store, 'connectionSnapshot', admin), null);
}));
test('non-admin SQL never decodes other users or connections even if those rows are oversized', () => fixture(f => {
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('x'.repeat(100_000), f.other.id);
  f.db.prepare('UPDATE env_connections SET label=? WHERE owner_user_id=?').run('y'.repeat(100_000), f.other.id);
  assert.equal(f.read().connections.length, 1);
  assert.equal(f.read().users.length, 1);
}));
for (const column of ['label', 'capabilities_json']) test('bounded SQL refuses oversize '+column+' without partial visibility', () => fixture(f => {
  f.db.prepare('UPDATE env_connections SET '+column+'=? WHERE owner_user_id=?').run('x'.repeat(100_000), f.member.id);
  assert.throws(f.read, /hub_delivery_read_unavailable/);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.store.getConnection('member-connection', f.member.id)!.label.length > 0, true);
}));
test('read failure and nested savepoint never settle an outer transaction or overwrite existing rows', () => fixture(f => {
  f.db.exec('BEGIN');
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('outer-change', f.other.id);
  f.db.prepare("UPDATE env_connections SET label=CAST(x'ff' AS TEXT) WHERE owner_user_id=?").run(f.member.id);
  assert.throws(f.read);
  assert.equal(f.db.isTransaction, true);
  assert.equal(f.store.getUser(f.other.id)!.label, 'outer-change');
  f.db.exec('ROLLBACK'); assert.equal(f.read().connections.length, 1);
}));
test('snapshot validator rejects authority drift, credential fields, duplicate rows and corrupted envelopes', () => fixture(f => {
  const result = JSON.parse(JSON.stringify(f.read()));
  for (const altered of [
    { ...result, authorized: true }, { ...result, principal: { ...result.principal, admin: 'true' } },
    { ...result, connections: [result.connections[0], result.connections[0]] },
    { ...result, connections: [{ ...result.connections[0], ownerUserId: f.other.id }] },
    { ...result, connections: [{ ...result.connections[0], credentialToken: 'secret' }] },
    { ...result, users: [f.store.getUser(f.other.id)] },
  ]) assert.equal(validHubMemberOutput('connectionSnapshot', altered), false);
}));
test('real worker owns the complete original file, closes and permits original facade reopen', () => fixture(async f => {
  const expected = JSON.parse(JSON.stringify(f.read())); await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'connection-fixture' }, quiet);
  try {
    await owner.open(); assert.deepEqual(await owner.command('connectionSnapshot', f.proof), expected);
    let getters = 0;
    const bad = { ...f.proof, get authorized() { getters++; return true; } };
    await assert.rejects(owner.command('connectionSnapshot', bad)); assert.equal(getters, 0);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'connection-fixture');
  try { assert.equal(reopened.listConnections(f.member.id).length, 1); } finally { await reopened.close(); }
}));
const port = (command: (kind: string) => unknown | Promise<unknown>) => ({ command: async (kind: string) => command(kind) }) as Pick<AsyncHubMemberOwner, 'command'>;
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const display = () => ({ principal: snapshot().principal, connections: [], users: [] });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid', { ...(signal ? { signal } : {}) });
const status = (n: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === n;
test('fresh delivery proof rejects credentials revoked after the original snapshot without retry', async () => {
  let current: ReturnType<typeof snapshot> | null = snapshot(), reads = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return current;
    assert.equal(kind, 'connectionSnapshot'); reads++; current = null; return display();
  }), quiet);
  const caller = await service.begin(request());
  await assert.rejects(caller.connections(), status(401));
  await assert.rejects(caller.connections(), status(401)); assert.equal(reads, 1);
});
for (const cancel of [false, true]) test('connection '+(cancel ? 'cancellation' : 'timeout')+' stops HTTP wait, not owner admission or original work', async () => {
  let settle!: (v: unknown) => void; let reads = 0;
  const pending = new Promise(resolve => { settle = resolve; }), controller = new AbortController(), logs: string[] = [];
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); reads++; return pending;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 10);
  const caller = await service.begin(request(controller.signal));
  const result = caller.connections();
  await new Promise<void>(resolve => setImmediate(resolve));
  if (cancel) controller.abort();
  await assert.rejects(result, status(cancel ? 499 : 503));
  assert.equal(service.pendingReads, 1); assert.equal(reads, 1);
  settle(display()); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(service.pendingReads, 0);
  assert.ok(logs.some(line => line.includes(cancel ? '"cancelled":1' : '"timedOut":1')));
});

test('administrator reads the original users projection but only its own connections', () => fixture(f => {
  f.store.roles.setHubRole({ userId: 'default', admin: true }, f.member.id, 'admin', 0);
  const proof = { ...f.proof, expectedScope: f.store.identities.recoveryScope({ userId: f.member.id, admin: true }) };
  const result = executeHubMemberCommand(f.store, 'connectionSnapshot', proof)!;
  assert.equal(result.principal.admin, true);
  assert.ok(result.users.some(row => row.id === f.other.id));
  assert.deepEqual(result.connections.map(row => row.id), [f.connection.id]);
  assert.equal(validHubMemberOutput('connectionSnapshot', result), true);
}));

test('aggregate snapshot and row budgets reject the whole response without altering the original rows', () => fixture(f => {
  const insert = f.db.prepare(`INSERT INTO env_connections
    (id, owner_user_id, kind, label, connector_url, status, capabilities_json, created_at, updated_at)
    VALUES (?, ?, 'remote', ?, 'http://fixture.invalid', 'enabled', '[]', 1, 1)`);
  f.db.exec('BEGIN');
  try { for (let i = 0; i < 530; i++) insert.run('large-'+i, f.member.id, 'x'.repeat(16_384)); f.db.exec('COMMIT'); }
  catch (error) { f.db.exec('ROLLBACK'); throw error; }
  assert.throws(f.read);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM env_connections WHERE owner_user_id=?').get(f.member.id)!.n, 531);
  const small = { principal: { userId: f.member.id, admin: false }, connections: Array(HUB_CONNECTION_ROW_LIMIT+1).fill({}), users: [] };
  assert.equal(validHubMemberOutput('connectionSnapshot', small), false);
  f.db.prepare("DELETE FROM env_connections WHERE id LIKE 'large-%'").run();
  assert.equal(f.read().connections.length, 1);
}));

test('real SQLite lock refusal never replays or rewrites connection rows and remains recoverable', () => fixture(f => {
  f.db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0');
  const blocker = new DatabaseSync(f.file);
  try {
    blocker.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    assert.throws(f.read, (error: unknown) => !!error && typeof error === 'object' && 'errcode' in error && error.errcode === 5);
    assert.equal(f.db.isTransaction, false);
    blocker.exec('ROLLBACK');
    assert.deepEqual(f.read().connections.map(row => row.id), [f.connection.id]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM env_connections').get()!.n, 2);
  } finally { if (blocker.isTransaction) blocker.exec('ROLLBACK'); blocker.close(); }
}));

for (const executed of [false, true]) test('lost snapshot RELEASE acknowledgment is unknown without retry ('+executed+')', () => fixture(f => {
  const original = Object.assign(new Error('private-release-fault'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  const native = f.db.exec.bind(f.db), observedStart = performanceDiagnostics.start;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  let releases = 0;
  f.db.exec = (sql: string) => {
    if (sql === 'RELEASE hub_identity_check') { releases++; if (executed) native(sql); throw original; }
    native(sql);
  };
  performanceDiagnostics.start = diagnostics.start.bind(diagnostics);
  try {
    assert.throws(f.read, error => error === original);
    assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
    assert.ok(logs.some(line => { const row = JSON.parse(line); return row.operation === 'hub-identity-check'
      && row.step === 3 && row.unknown === 1 && row.sqlErrorCode === 10; }));
    for (const secret of [f.token, f.key.token, 'private-release-fault', 'Old connection']) assert.equal(logs.join('').includes(secret), false);
  } finally { f.db.exec = native; performanceDiagnostics.start = observedStart; }
  assert.equal(f.read().connections.length, 1);
}));

class SnapshotWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.stops++; return Promise.resolve(1); }
  reply(index: number, value: unknown) { const row = this.messages[index]!;
    this.emit('message', { id: row.id, kind: row.kind, ok: true, body: JSON.stringify(value) }); }
}
test('connection result reservation survives warning and graceful close; exhaustion never invokes a supplied getter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-connections-capacity-')), worker = new SnapshotWorker(), logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, new PerformanceDiagnostics(line => logs.push(line)),
    () => worker as unknown as Worker, 5);
  worker.emit('message', { kind: 'ready' });
  try {
    const proof = { evidence: {}, expectedScope: 'a'.repeat(64) }, original = owner.command('connectionSnapshot', proof);
    assert.equal(owner.snapshot().acceptedResultBytes, HUB_CONNECTION_RPC_BYTES);
    let getters = 0;
    await assert.rejects(owner.command('connectionSnapshot', { get evidence() { getters++; return {}; }, expectedScope: proof.expectedScope }), HubMemberOwnerUnavailable);
    assert.equal(getters, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    const close = owner.close(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(worker.messages.length, 1); assert.equal(worker.stops, 0);
    assert.equal(owner.snapshot().acceptedResultBytes, HUB_CONNECTION_RPC_BYTES);
    worker.reply(0, display()); await original; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(owner.snapshot().acceptedResultBytes, 0); assert.equal(worker.messages[1]!.kind, 'close');
    worker.reply(1, null); worker.emit('exit', 0); await close;
    assert.ok(logs.some(line => line.includes('"phase":"pending"')));
    assert.ok(logs.some(line => line.includes('"deferred":1')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bad stored snapshot produces safe worker diagnostics without retiring a usable original owner', () => fixture(async f => {
  f.db.prepare('UPDATE env_connections SET label=? WHERE id=?').run('x'.repeat(16_385), f.connection.id);
  await f.store.close(); const logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'connection-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await owner.open(); await assert.rejects(owner.command('connectionSnapshot', f.proof), HubMemberOwnerUnavailable);
    assert.ok(await owner.command('memberSnapshot', f.proof.evidence));
    assert.equal(owner.snapshot().unavailable, false); assert.equal(owner.snapshot().acceptedResultBytes, 0);
    assert.ok(logs.some(line => line.includes('"operation":"hub-member-sqlite-command"') && line.includes('"unknown":1')));
    for (const secret of [f.token, f.key.token, 'private-connector-token']) assert.equal(logs.join('').includes(secret), false);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'connection-fixture');
  try { assert.equal(reopened.listConnections(f.member.id)[0]!.label.length, 16_385); }
  finally { await reopened.close(); }
}));
