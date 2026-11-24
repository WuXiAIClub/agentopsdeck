import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberDirectory } from './async-member-directory.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, type HubMemberCommands } from './member-owner-domain.js';
import { HUB_ACCESS_DIRECTORY_ROWS, validHubAccessDirectoryReply } from './member-access-directory-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoleAccessRoutes } from '../routes/hub-role-access.js';
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: string, input: unknown) => unknown): Port => ({
  command: (async (kind: string, input: unknown) => call(kind, input)) as Port['command'],
});
function seed(store: HubStore, file: string) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), manager = store.createUser('Manager'), observer = store.createUser('Observer'), unrelated = store.createUser('Unrelated');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  store.roles.save({ userId: 'default', admin: true }, { ownerUserId: owner.id, connectionId: 'node', userId: manager.id }, {
    role: 'admin', version: 0, nodeVersion: store.connectionAuthority('node', owner.id)!,
    environments: { codex: 'developer', openclaw: 'observer' }, migrateLegacy: true,
  });
  store.grants.create({ ownerUserId: owner.id, connectionId: 'node', userId: observer.id }, {
    runtime: 'codex', sessionKey: 'codex:directory', actions: ['messages:read'],
  });
  db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(unrelated.id);
  const credentials = (userId: string, admin = false) => {
    const key = store.identities.issueKey(userId), token = store.identities.createSession(key.token)!;
    const headers = { cookie: 'agentopsdeck_session=' + token };
    return { token, key, headers, request: new Request('http://fixture.invalid', { headers }),
      proof: { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId, admin }) } };
  };
  const actor = credentials(manager.id);
  const command = (proof = actor.proof) => executeHubMemberCommand(store, 'accessDirectory', proof);
  const original = (userId: string, admin: boolean) => ({ administrator: admin,
    connections: store.roles.connections({ userId, admin }), users: store.roles.members({ userId, admin }) });
  return { store, file, db, owner, manager, observer, unrelated, actor, credentials, command, original };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-directory-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'directory-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('access directory retains exact original management visibility without granting execution', () => fixture(f => {
  const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const result = f.command()!;
  assert.deepEqual(result.directory, f.original(f.manager.id, false));
  assert.deepEqual(new Set(result.directory.users.map(u => u.id)), new Set([f.manager.id, f.owner.id, f.observer.id]));
  assert.equal(result.directory.connections[0]!.appointAdministrators, false);
  assert.equal(result.directory.connections[0]!.creationReady, false);
  assert.equal(JSON.stringify(result).includes('private.invalid'), false);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.store.grants.authorize({ ownerUserId: f.owner.id, connectionId: 'node', userId: f.manager.id },
    'messages:send', { runtime: 'codex', sessionKey: 'codex:directory' }), undefined);
}));
test('access directory matches original owner, administrator, ordinary member and empty visibility', () => fixture(f => {
  for (const [userId, admin] of [[f.owner.id, false], [f.unrelated.id, true], [f.observer.id, false]] as const) {
    const actor = f.credentials(userId, admin);
    assert.deepEqual(f.command(actor.proof)!.directory, f.original(userId, admin));
  }
  assert.equal(f.command(f.credentials(f.observer.id).proof)!.directory.connections.length, 0);
}));
test('access directory checks current credentials and scope in its original identity transaction', () => fixture(f => {
  assert.equal(f.command({ ...f.actor.proof, expectedScope: '0'.repeat(64) }), null);
  f.store.identities.revokeSession(f.actor.token);
  assert.equal(f.command(), null);
}));
test('access directory rejects transported booleans, partial rows, duplicated IDs and wrong account ACKs', () => fixture(f => {
  assert.equal(validHubMemberInput('accessDirectory', { ...f.actor.proof, authorized: true }), false);
  const good = f.command()!;
  assert.equal(validHubMemberOutput('accessDirectory', good), true);
  assert.equal(validHubAccessDirectoryReply('f'.repeat(64), good), false);
  for (const bad of [
    { ...good, directory: { ...good.directory, users: [{ ...good.directory.users[0], usage: { lastLoginAt: null, lastActiveAt: null } }] } },
    { ...good, directory: { ...good.directory, connections: [good.directory.connections[0], good.directory.connections[0]] } },
    { ...good, directory: { ...good.directory, connections: [{ ...good.directory.connections[0], nodeVersion: NaN }] } },
    { ...good, directory: { ...good.directory, connections: [{ ...good.directory.connections[0], connectorUrl: 'private' }] } },
    { ...good, directory: { ...good.directory, users: [{ ...good.directory.users[0], label: '\0secret' }] } },
  ]) assert.equal(validHubMemberOutput('accessDirectory', bad), false);
}));
test('access directory refuses oversized database text before calling original policy and resumes after valid data', () => fixture(f => {
  let calls = 0;
  const original = f.store.roles.connections.bind(f.store.roles);
  f.store.roles.connections = actor => { calls++; return original(actor); };
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('x'.repeat(16_385), f.observer.id);
  assert.throws(() => f.command(), /hub_access_directory_unavailable/);
  assert.equal(calls, 0);
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('Observer', f.observer.id);
  assert.equal(f.command()!.directory.users.length, 3);
}));
test('access directory bounds original scans without decoding or partial truncation', () => fixture(f => {
  const insert = f.db.prepare('INSERT INTO users VALUES (?, ?, 1, 1)');
  f.db.exec('BEGIN');
  for (let i = 0; i < HUB_ACCESS_DIRECTORY_ROWS; i++) insert.run('bounded-user-' + i, 'Bounded');
  f.db.exec('COMMIT');
  assert.throws(() => f.command(), /hub_access_directory_unavailable/);
}));
test('access directory SQL failure rolls back read savepoint and never fabricates an empty success', () => fixture(async f => {
  const directory = new AsyncHubMemberDirectory(port((kind, input) => {
    if (kind === 'accessDirectory') throw new Error('SQL private fault');
    return executeHubMemberCommand(f.store, kind as never, input as never);
  }), quiet);
  await assert.rejects(directory.read(f.actor.request), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
  assert.equal(f.command()!.directory.connections.length, 1);
}));
test('awaited access directory preserves original frontend payload and no-store without synchronous authority', () => fixture(async f => {
  const directory = new AsyncHubMemberDirectory(port((kind, input) => executeHubMemberCommand(f.store, kind as never, input as never)), quiet);
  const app = new Hono();
  registerHubRoleAccessRoutes(app, { hubStore: f.store, asyncDirectory: directory,
    principal() { throw new Error('Must not read synchronous authority'); } });
  const response = await app.request('/api/hub/v1/access/directory', { headers: f.actor.headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), f.original(f.manager.id, false));
  const denied = await app.request('/api/hub/v1/access/directory');
  assert.equal(denied.status, 401);
}));
test('awaited access directory rechecks final credentials and rejects administrator changes after read', () => fixture(async f => {
  const directory = new AsyncHubMemberDirectory(port((kind, input) => {
    const result = executeHubMemberCommand(f.store, kind as never, input as never);
    if (kind === 'accessDirectory') f.db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(f.manager.id);
    return result;
  }), quiet);
  await assert.rejects(directory.read(f.actor.request), (e: unknown) => e instanceof HubMemberRequestError && e.status === 401);
}));
test('awaited access directory pins headers before await and rejects a mismatched scope', () => fixture(async f => {
  const directory = new AsyncHubMemberDirectory(port(async (kind, input) => {
    await tick();
    const result = executeHubMemberCommand(f.store, kind as never, input as never);
    return kind === 'accessDirectory' ? { ...(result as NonNullable<HubMemberCommands['accessDirectory']['output']>), recoveryScope: '0'.repeat(64) } : result;
  }), quiet);
  const request = new Request(f.actor.request);
  const running = directory.read(request);
  request.headers.set('cookie', 'agentopsdeck_session=other');
  await assert.rejects(running, (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
}));
test('directory timeout keeps original admission, logs fixed phase, and late settlement releases it once', () => fixture(async f => {
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line), () => 0);
  let release!: (value: unknown) => void;
  const directory = new AsyncHubMemberDirectory(port((kind, input) => kind === 'accessDirectory'
    ? new Promise(resolve => { release = resolve; }) : executeHubMemberCommand(f.store, kind as never, input as never)), diagnostics, 1, 10);
  await assert.rejects(directory.read(f.actor.request), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
  assert.equal(directory.pending, 1);
  assert.ok(logs.some(line => { const event = JSON.parse(line); return event.step === 37 && event.timedOut === 1; }));
  for (const secret of [f.actor.token, f.actor.key.token, f.manager.id, 'private.invalid']) assert.equal(logs.some(line => line.includes(secret)), false);
  release(f.command()); await tick(); await tick();
  assert.equal(directory.pending, 0);
}));
test('aborted directory never dispatches and yields a recoverable canceled response', () => fixture(async f => {
  let calls = 0;
  const directory = new AsyncHubMemberDirectory(port(() => { calls++; throw new Error('No dispatch'); }), quiet);
  const app = new Hono();
  registerHubRoleAccessRoutes(app, { hubStore: f.store, asyncDirectory: directory, principal: () => ({ userId: f.manager.id, admin: false }) });
  const controller = new AbortController(); controller.abort();
  const response = await app.request(new Request('http://localhost/api/hub/v1/access/directory', { headers: f.actor.headers, signal: controller.signal }));
  assert.equal(response.status, 499); assert.equal(calls, 0);
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
test('wrong-scope directory ACK cannot retire original owner or release its reservation before physical exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-directory-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
  const createWorker = () => worker as unknown as Worker;
  const owner = new AsyncHubMemberOwner({ file }, quiet, createWorker);
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64) };
  try {
    const result = owner.command('accessDirectory', proof); void result.catch(() => {});
    worker.emit('message', { kind: 'ready' }); await tick();
    const message = worker.messages[0]!;
    worker.emit('message', { id: message.id, kind: message.kind, ok: true,
      body: JSON.stringify({ recoveryScope: 'b'.repeat(64), directory: { administrator: false, connections: [], users: [] } }) });
    await assert.rejects(result); assert.equal(worker.stops, 0);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, createWorker));
    const closing = owner.close(); await tick(); assert.equal(worker.stops, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, createWorker));
    worker.emit('exit', 1); await assert.rejects(closing);
  } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
test('real directory worker uses the original database and leaves synchronous reopening compatible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-directory-real-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'directory-fixture'), f = seed(store, file), expected = f.original(f.manager.id, false), request = f.actor.request;
  await store.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'directory-fixture' }, quiet);
  try {
    const result = await new AsyncHubMemberDirectory(owner, quiet).read(request);
    assert.deepEqual(result, expected);
    await owner.close();
    const reopened = new HubStore(file, 'directory-fixture');
    try { assert.deepEqual(reopened.roles.connections({ userId: f.manager.id, admin: false }), expected.connections); }
    finally { await reopened.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
