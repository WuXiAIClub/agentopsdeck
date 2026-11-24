import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { validHubConnectionChange, type HubConnectionChange } from './member-connection-change-domain.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const status = (n: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === n;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const configuration = { connectorUrl: 'https://connector.example.invalid', label: 'Original', token: 'private-connection-token' };
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-connection-r90-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'connection-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Member'), other = store.createUser('Other');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const change = (change: HubConnectionChange) => executeHubMemberCommand(store, 'connectionChange', { ...proof, change });
  const created = change({ action: 'create', configuration });
  assert.ok(created && 'connection' in created);
  const pin = () => executeHubMemberCommand(store, 'connectionTarget', { ...proof, id: created.connection.id });
  return { store, file, db, member, other, key, token, request, proof, change, created, pin };
}

test('member connection domain preserves owner policy, original credentials and display-only authority', () => fixture(f => {
  const { connection, epoch } = f.created;
  assert.equal(connection.ownerUserId, f.member.id); assert.equal(connection.hasCredential, true);
  assert.equal(f.store.getCredentialToken(connection.id, f.member.id), configuration.token);
  assert.equal(f.store.getConnection(connection.id, f.other.id), undefined);
  const changed = f.change({ action: 'patch', id: connection.id, expectedEpoch: epoch, configuration: { label: 'Renamed' } });
  assert.ok(changed && 'connection' in changed); assert.equal(changed.connection.label, 'Renamed'); assert.equal(changed.epoch, epoch);
  assert.equal(f.store.getCredentialToken(connection.id, f.member.id), configuration.token);
  assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
}));
test('original epoch rejects replacement; absent fields retain latest same-epoch display edits', () => fixture(f => {
  const { connection, epoch } = f.created;
  f.store.renameConnection(connection.id, { label: 'Concurrent rename' }, f.member.id);
  const merged = f.change({ action: 'patch', id: connection.id, expectedEpoch: epoch, configuration: { environmentLabel: 'Environment' } });
  assert.ok(merged && 'connection' in merged); assert.equal(merged.connection.label, 'Concurrent rename');
  f.store.updateMaintenanceCredential(connection.id, 'private-maintenance', f.member.id);
  const before = f.store.getConnection(connection.id, f.member.id);
  assert.deepEqual(f.change({ action: 'delete', id: connection.id, expectedEpoch: epoch }), { error: 'changed' });
  assert.deepEqual(f.change({ action: 'maintenance', id: connection.id, expectedEpoch: epoch, token: 'forbidden-token' }), { error: 'changed' });
  assert.deepEqual(f.store.getConnection(connection.id, f.member.id), before);
  assert.equal(f.store.getMaintenanceCredentialToken(connection.id, f.member.id), 'private-maintenance');
}));
test('fresh original credential and scope proof deny mutations after revocation', () => fixture(f => {
  const before = f.store.getConnection(f.created.connection.id, f.member.id);
  const change = { action: 'patch' as const, id: before!.id, expectedEpoch: f.created.epoch, configuration: { label: 'Forbidden' } };
  assert.equal(executeHubMemberCommand(f.store, 'connectionChange', { ...f.proof, expectedScope: '0'.repeat(64), change }), null);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(f.change(change), null); assert.equal(f.pin(), null);
  assert.deepEqual(f.store.getConnection(before!.id, f.member.id), before);
}));
for (const action of ['create', 'patch', 'maintenance', 'delete'] as const) {
  test(action + ' audit SQL failure rolls back configuration, epoch and both credentials together', () => fixture(f => {
    const { connection, epoch } = f.created;
    f.store.updateMaintenanceCredential(connection.id, 'old-maintenance', f.member.id);
    const expectedEpoch = f.store.connectionAuthority(connection.id, f.member.id)!;
    const before = f.store.getConnection(connection.id, f.member.id), count = f.store.listConnections(f.member.id).length;
    f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'private_audit_failure'); END");
    const change: HubConnectionChange = action === 'create' ? { action, configuration: { ...configuration, label: 'New' } }
      : action === 'patch' ? { action, id: connection.id, expectedEpoch, configuration: { enabled: false } }
      : action === 'maintenance' ? { action, id: connection.id, expectedEpoch, token: 'new-private-maintenance' }
      : { action, id: connection.id, expectedEpoch };
    assert.throws(() => f.change(change));
    assert.equal(f.db.isTransaction, false); assert.deepEqual(f.store.getConnection(connection.id, f.member.id), before);
    assert.equal(f.store.connectionAuthority(connection.id, f.member.id), expectedEpoch);
    assert.equal(f.store.listConnections(f.member.id).length, count);
    assert.equal(f.store.getCredentialToken(connection.id, f.member.id), configuration.token);
    assert.equal(f.store.getMaintenanceCredentialToken(connection.id, f.member.id), 'old-maintenance');
    assert.ok(expectedEpoch > epoch);
    f.db.exec('DROP TRIGGER reject_audit'); assert.ok(f.change(change));
  }));
}
test('connection mutation preserves enclosing original transaction and rollback', () => fixture(f => {
  f.db.exec('BEGIN');
  assert.ok(f.change({ action: 'patch', id: f.created.connection.id, expectedEpoch: f.created.epoch, configuration: { enabled: false } }));
  assert.equal(f.db.isTransaction, true); f.db.exec('ROLLBACK');
  assert.equal(f.store.getConnection(f.created.connection.id, f.member.id)!.status, 'enabled');
  assert.equal(f.store.connectionAuthority(f.created.connection.id, f.member.id), f.created.epoch);
}));
for (const executed of [false, true]) test('original RELEASE ACK loss keeps actual outcome without replay: ' + executed, () => fixture(f => {
  const original = Object.assign(new Error('private_release_failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  const native = f.db.exec.bind(f.db), start = performanceDiagnostics.start, logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line)); let releases = 0;
  f.db.exec = (sql: string) => { if (sql === 'RELEASE hub_identity_check') { releases++; if (executed) native(sql); throw original; } native(sql); };
  performanceDiagnostics.start = diagnostics.start.bind(diagnostics);
  try {
    assert.throws(() => f.change({ action: 'maintenance', id: f.created.connection.id, expectedEpoch: f.created.epoch, token: 'private-new-maintenance' }), e => e === original);
    assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
    assert.equal(f.store.getMaintenanceCredentialToken(f.created.connection.id, f.member.id), executed ? 'private-new-maintenance' : undefined);
    assert.equal(f.store.connectionAuthority(f.created.connection.id, f.member.id), f.created.epoch + Number(executed));
    assert.ok(logs.some(line => { const v = JSON.parse(line); return v.operation === 'hub-identity-check' && v.unknown === 1 && v.sqlErrorCode === 10; }));
    for (const secret of [f.token, f.key.token, configuration.token, original.message, 'private-new-maintenance']) assert.equal(logs.join('').includes(secret), false);
  } finally { f.db.exec = native; performanceDiagnostics.start = start; }
}));
test('protocol refuses account claims, extra fields, invalid epochs and plaintext result fields', () => fixture(f => {
  const good = { ...f.proof, change: { action: 'delete', id: f.created.connection.id, expectedEpoch: f.created.epoch } };
  for (const input of [{ ...good, authorized: true }, { ...good, ownerUserId: f.other.id }, { ...good, change: { ...good.change, admin: true } }])
    assert.equal(validHubMemberInput('connectionChange', input), false);
  for (const epoch of [0, -1, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(validHubConnectionChange({ ...good.change, expectedEpoch: epoch }), false);
  for (const v of [{ ...f.created, token: configuration.token }, { ...f.created, connection: { ...f.created.connection, credentialToken: configuration.token } }, { ok: false, epoch: 1 }])
    assert.equal(validHubMemberOutput('connectionChange', v), false);
}));
test('real complete async owner drains and reopens original configuration, encrypted credentials and member session', () => fixture(async f => {
  await f.store.close(); const logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'connection-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await owner.open(); const caller = await new AsyncHubMemberRequests(owner, quiet).begin(f.request);
    assert.equal(caller.principal.admin, false);
    const pinned = await caller.connection(f.created.connection.id);
    const changed = await pinned.patch({ label: 'Async renamed' }); assert.ok(changed && 'connection' in changed);
    assert.equal(changed.connection.label, 'Async renamed');
    await pinned.maintenance('async-private-maintenance');
    await assert.rejects(pinned.delete(), status(409));
    let getters = 0;
    await assert.rejects(caller.createConnection({ get connectorUrl() { getters++; return configuration.connectorUrl; } }), status(400));
    assert.equal(getters, 0); assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'connection-fixture');
  try {
    assert.equal(reopened.getConnection(f.created.connection.id, f.member.id)!.label, 'Async renamed');
    assert.equal(reopened.getCredentialToken(f.created.connection.id, f.member.id), configuration.token);
    assert.equal(reopened.getMaintenanceCredentialToken(f.created.connection.id, f.member.id), 'async-private-maintenance');
    assert.deepEqual(reopened.identities.requestPrincipal(f.request, () => false), { userId: f.member.id, admin: false });
  } finally { await reopened.close(); }
  assert.ok(logs.some(line => line.includes('hub-member-sqlite-command')));
  for (const secret of [f.token, configuration.token, 'async-private-maintenance', 'Async renamed']) assert.equal(logs.join('').includes(secret), false);
}));

const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const row = () => ({ id: 'connection', ownerUserId: 'member', kind: 'remote' as const, label: 'Original', connectorUrl: configuration.connectorUrl,
  status: 'enabled' as const, capabilities: [], hasCredential: false, createdAt: 1, updatedAt: 1 });
const port = (command: (kind: string, input: any) => unknown | Promise<unknown>) => ({ command: async (kind: string, input: any) => command(kind, input) }) as Pick<AsyncHubMemberOwner, 'command'>;
const req = (signal?: AbortSignal) => new Request('http://fixture.invalid', { ...(signal ? { signal } : {}) });

test('member caller copies config before await; later consumer edits and executable descriptors cannot change mutation', async () => {
  const effects: any[] = [];
  const service = new AsyncHubMemberRequests(port((kind, input) => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return { connection: row(), epoch: 1 };
    effects.push(input.change); return { connection: row(), epoch: 1 };
  }), quiet);
  const caller = await service.begin(req()), c = { ...configuration, capabilities: ['sessions'] };
  const saving = caller.createConnection(c); c.label = 'Mutated'; c.capabilities.push('events'); await saving;
  assert.equal(effects.length, 1); assert.equal(effects[0].configuration.label, 'Original'); assert.deepEqual(effects[0].configuration.capabilities, ['sessions']);
  let traps = 0;
  await assert.rejects(caller.createConnection(new Proxy(c, { ownKeys() { traps++; return []; } })), status(400));
  assert.equal(traps, 0); assert.equal(effects.length, 1);
});
test('pin is a fixed owner/version CAS: initial epoch advances once, same node is idempotent, replacement/disabled fail', () => fixture(f => {
  const nodeId = `node_${randomUUID()}`, {connection, epoch} = f.created;
  const command = {action: 'pin' as const, id: connection.id, expectedEpoch: epoch, nodeId};
  for (const extra of [{authorized: true}, {nodeId: 'bad'}, {token: 'private'}])
    assert.equal(validHubConnectionChange({...command, ...extra}), false);
  const pinned = f.change(command); assert.ok(pinned && 'connection' in pinned);
  assert.equal(pinned.connection.nodeId, nodeId); assert.equal(pinned.epoch, epoch + 1);
  assert.deepEqual(f.change(command), {error: 'changed'});
  const repeat = f.change({...command, expectedEpoch: pinned.epoch}); assert.ok(repeat && 'connection' in repeat); assert.equal(repeat.epoch, pinned.epoch);
  assert.deepEqual(f.change({...command, expectedEpoch: pinned.epoch, nodeId: `node_${randomUUID()}`}), {error: 'changed'});
  f.store.upsertConnection({...pinned.connection, status: 'disabled'}, {preserveCredential: true});
  assert.deepEqual(f.change({...command, expectedEpoch: f.store.connectionAuthority(connection.id, f.member.id)!}), {error: 'changed'});
}));
for (const executed of [false, true]) test('pin RELEASE ACK failure preserves actual transaction outcome without replay: ' + executed, () => fixture(f => {
  const nodeId = `node_${randomUUID()}`, native = f.db.exec.bind(f.db); let releases = 0;
  f.db.exec = sql => {if (sql === 'RELEASE hub_identity_check') {releases++; if (executed) native(sql); throw Error('private-pin-ack');} native(sql);};
  try {
    assert.throws(() => f.change({action: 'pin', id: f.created.connection.id, expectedEpoch: f.created.epoch, nodeId}));
    assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
    assert.equal(f.store.getConnection(f.created.connection.id, f.member.id)!.nodeId, executed ? nodeId : undefined);
    assert.equal(f.store.connectionAuthority(f.created.connection.id, f.member.id), f.created.epoch + Number(executed));
  } finally {f.db.exec = native;}
}));
for (const furtherChange of [false, true]) test('pin delivery checks committed new epoch, not its old pin: further change ' + furtherChange, async () => {
  const nodeId = `node_${randomUUID()}`; let writes = 0, epoch = 1;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return {connection: {...row(), ...(writes ? {nodeId} : {})}, epoch};
    writes++; epoch = furtherChange ? 3 : 2; return {connection: {...row(), nodeId}, epoch: 2};
  }), quiet);
  try {
    const caller = await service.begin(req()), pinned = await caller.connection('connection');
    if (furtherChange) await assert.rejects(pinned.pin(nodeId), status(409));
    else {const value = await pinned.pin(nodeId); assert.ok(value && 'connection' in value); assert.equal(value.epoch, 2);}
    assert.equal(writes, 1);
  } finally {await service.close();}
});
test('pin unknown commit ACK is not automatically replayed or compensated', async () => {
  let writes = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return {connection: row(), epoch: 1};
    writes++; throw Error('private-pin-unknown');
  }), quiet);
  const caller = await service.begin(req()), pinned = await caller.connection('connection');
  await assert.rejects(pinned.pin(`node_${randomUUID()}`), status(503)); assert.equal(writes, 1); await service.close();
});
test('successful mutation followed by target replacement denies stale delivery without retry or compensation', async () => {
  let writes = 0, epoch = 1;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return { connection: row(), epoch };
    writes++; epoch = 2; return { connection: row(), epoch: 1 };
  }), quiet);
  const caller = await service.begin(req()), pinned = await caller.connection('connection');
  await assert.rejects(pinned.patch({ label: 'Saved' }), status(409)); assert.equal(writes, 1);
});
test('final identity denial wins over unknown effect error; no replay', async () => {
  let current: ReturnType<typeof snapshot> | null = snapshot(), writes = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return current;
    writes++; current = null; throw new Error('private-effect-error');
  }), quiet);
  const caller = await service.begin(req()); await assert.rejects(caller.createConnection(configuration), status(401));
  await assert.rejects(caller.createConnection(configuration), status(401)); assert.equal(writes, 1);
});
test('disconnect cannot release an admitted connection write before its original settlement', async () => {
  let settle!: (v: unknown) => void, writes = 0;
  const pending = new Promise(resolve => { settle = resolve; }), abort = new AbortController(), logs: string[] = [];
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return pending;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 10);
  const caller = await service.begin(req(abort.signal)); const saving = caller.createConnection(configuration);
  await tick(); abort.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writes, 1); assert.equal(service.pendingReads, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":34')));
  settle({ connection: row(), epoch: 1 }); await assert.rejects(saving, status(499)); await tick();
  assert.equal(service.pendingReads, 0); assert.equal(writes, 1);
});
test('optional undefined configuration is omitted without invoking getters, then or toJSON', async () => {
  let writes = 0, calls = 0;
  const service = new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return { connection: row(), epoch: 1 };
    writes++; return { connection: row(), epoch: 1 };
  }), quiet);
  const caller = await service.begin(req());
  await caller.createConnection({ ...configuration, id: undefined, capabilities: undefined } as unknown as Parameters<typeof caller.createConnection>[0]); assert.equal(writes, 1);
  for (const c of [{ ...configuration, get label() { calls++; return 'Forbidden'; } },
    { ...configuration, toJSON() { calls++; return configuration; } },
    { ...configuration, capabilities: new Proxy(['sessions'], { get() { calls++; return 'sessions'; } }) }])
    await assert.rejects(caller.createConnection(c as any), status(400));
  assert.equal(calls, 0); assert.equal(writes, 1);
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
for (const action of ['patch-target', 'maintenance-shape', 'delete-shape', 'create-target'] as const)
test('caller rejects well-formed mismatched ' + action + ' ACK without replay', async () => {
  let writes = 0;
  const caller = await new AsyncHubMemberRequests(port((kind, input) => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return { connection: { ...row(), id: input.id }, epoch: 1 };
    writes++;
    return { connection: { ...row(), id: action === 'patch-target' || action === 'create-target' ? 'replacement' : 'connection' }, epoch: 1 };
  }), quiet).begin(req());
  const pinned = await caller.connection('connection');
  const result = action === 'patch-target' ? pinned.patch({ label: 'Saved' })
    : action === 'maintenance-shape' ? pinned.maintenance('private-maintenance')
    : action === 'delete-shape' ? pinned.delete() : caller.createConnection({ ...configuration, id: 'connection' });
  await assert.rejects(result, status(503));
  assert.equal(writes, 1);
});
test('caller rejects a well-formed target read for another connection before dispatching a write', async () => {
  let writes = 0;
  const caller = await new AsyncHubMemberRequests(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    if (kind === 'connectionTarget') return { connection: { ...row(), id: 'replacement' }, epoch: 1 };
    writes++; return { ok: true };
  }), quiet).begin(req());
  await assert.rejects(caller.connection('connection'), status(503));
  assert.equal(writes, 0);
});
for (const action of ['target', 'create', 'patch', 'maintenance', 'delete'] as const)
test('owner rejects mismatched ' + action + ' ACK and fences replacement until physical exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-connection-correlated-')), file = join(root, 'hub.sqlite');
  const fake = new FakeWorker(), logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file }, new PerformanceDiagnostics(line => logs.push(line)), () => fake as unknown as Worker, 5);
  fake.emit('message', { kind: 'ready' });
  try {
    const proof = { evidence: {}, expectedScope: 'a'.repeat(64) };
    const kind = action === 'target' ? 'connectionTarget' : 'connectionChange';
    const change: HubConnectionChange = action === 'create' ? { action, configuration: { ...configuration, id: 'connection' } }
      : action === 'patch' ? { action, id: 'connection', expectedEpoch: 1, configuration: { label: 'Saved' } }
      : action === 'maintenance' ? { action, id: 'connection', expectedEpoch: 1, token: 'private-maintenance' }
      : { action: 'delete', id: 'connection', expectedEpoch: 1 };
    const input = kind === 'connectionTarget' ? { ...proof, id: 'connection' } : { ...proof, change };
    const pending = owner.command(kind, input as any), rejection = assert.rejects(pending, HubMemberOwnerUnavailable);
    await tick();
    const value = { connection: { ...row(), id: action === 'maintenance' || action === 'delete' ? 'connection' : 'replacement' }, epoch: 1 };
    assert.equal(validHubMemberOutput(kind, value), true, 'result passes generic wire shape validation');
    fake.emit('message', { id: fake.messages[0]!.id, kind, ok: true, body: JSON.stringify(value) });
    await rejection;
    assert.equal(owner.snapshot().unavailable, true);
    let replacements = 0;
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, () => { replacements++; return new FakeWorker() as unknown as Worker; }), HubMemberOwnerUnavailable);
    assert.equal(replacements, 0);
    await assert.rejects(owner.command(kind, input as any), HubMemberOwnerUnavailable);
    assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
    let closed = false;
    const closing = owner.close().then(() => { closed = true; }, () => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.ok(logs.some(line => line.includes('"ownerFailureCode":4')));
    for (const secret of [configuration.token, 'private-maintenance', 'replacement']) assert.equal(logs.join('').includes(secret), false);
    fake.emit('exit', 1); await closing;
    const nextFake = new FakeWorker();
    const next = new AsyncHubMemberOwner({ file }, quiet, () => nextFake as unknown as Worker);
    nextFake.emit('message', { kind: 'ready' });
    assert.equal(next.snapshot().unavailable, false);
    nextFake.emit('exit', 1); await next.close().catch(() => {});
  } finally { fake.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
test('corrupt connection ACK retains unknown owner until physical exit, never replaces or replays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-connection-ack-r90-')), fake = new FakeWorker(), logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, new PerformanceDiagnostics(line => logs.push(line)), () => fake as unknown as Worker, 5);
  fake.emit('message', { kind: 'ready' });
  try {
    const input = { evidence: {}, expectedScope: 'a'.repeat(64), change: { action: 'create' as const, configuration } };
    const pending = owner.command('connectionChange', input), rejection = assert.rejects(pending, HubMemberOwnerUnavailable);
    await tick(); fake.emit('message', { id: fake.messages[0]!.id, kind: 'connectionChange', ok: true, body: '{broken-ack' });
    await rejection; assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
    await assert.rejects(owner.command('connectionChange', input));
    let closed = false; const closing = owner.close().then(() => { closed = true; }, () => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(fake.messages.length, 1);
    fake.emit('exit', 1); await closing; assert.equal(owner.snapshot().ownerExitConfirmed, true);
    assert.equal(logs.join('').includes(configuration.token), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
