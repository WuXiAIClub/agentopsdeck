import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { type MaintenanceTarget, type LocalMaintenance } from './maintenance-commands.js';
import { CommandConflict, CommandReceipts } from '../commands/receipts.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from '../routes/hub.js';
import { createConnectorClientResolver } from './connector-client.js';
import type { HubPrincipal } from './identity.js';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';

const body = { version: 'v1', manifestSha256: 'a'.repeat(64) };
const allow = { read() {}, send() {} };
const scope = (target: MaintenanceTarget) => JSON.stringify([['pause', 'resume'].includes(target.operation) ? 'maintenance' : 'update', JSON.stringify([target.userId, target.ownerUserId, target.connectionId, target.operation])]);

async function fixture(t: TestContext, kind: 'local' | 'remote' = 'local') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-binding-')), file = join(directory, 'hub.sqlite');
  let hub = new HubStore(file, 'synthetic-vault');
  const db = new DatabaseSync(file), remoteDb = new DatabaseSync(':memory:'), commands = new CommandReceipts(remoteDb);
  const nodeId = `node_${randomUUID()}`, otherNode = `node_${randomUUID()}`;
  const target: MaintenanceTarget = { userId: 'default', ownerUserId: 'default', connectionId: 'alias', operation: 'apply' };
  const calls: Array<{ method: string; path: string; actor: string }> = [];
  let reads = true, wrongPin = false, corruptKey = false, revoke = false, postReply = 200, fullPost = false;
  let afterPost = async () => {}, afterRead = () => {};
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header(NODE_ID_HEADER, wrongPin ? otherNode : nodeId);
    const token = c.req.header('authorization');
    const actor = token === 'Bearer synthetic-old' ? (kind === 'local' ? 'local:maintenance' : 'old')
      : token === 'Bearer synthetic-new' ? (kind === 'local' ? 'local:maintenance' : 'new') : 'invalid';
    calls.push({ method: c.req.method, path: c.req.path, actor });
    if (actor === 'invalid' || (revoke && actor === 'old')) return c.json({ error: 'denied' }, 403);
    if (c.req.header(EXPECTED_NODE_HEADER) !== nodeId) return c.json({ error: 'node mismatch' }, 409);
    await next();
  });
  const actor = (auth: string | undefined) => kind === 'local' ? 'local:maintenance' : auth === 'Bearer synthetic-old' ? 'old' : 'new';
  app.post('/api/connector/v1/:boundary/commands/:operation', async c => {
    const input = await c.req.json();
    const { idempotencyKey, ...payload } = input;
    const key = `${actor(c.req.header('authorization'))}:${c.req.param('operation')}`;
    commands.claim(key, idempotencyKey, payload);
    commands.settle(key, idempotencyKey, { status: 200, body: c.req.param('boundary') === 'maintenance'
      ? { state: c.req.param('operation') === 'pause' ? 'paused' : 'released', boundary: 'admission_only', nativeQuiescent: false, fenceId: 'a'.repeat(36) }
      : { state: 'failed', error: 'synthetic install failure' } });
    await afterPost();
    const { result, ...command } = commands.get(key, idempotencyKey)!;
    return c.json(fullPost ? { ...result!.body, command } : { ok: true }, postReply as 200);
  });
  app.get('/api/connector/v1/:boundary/commands/:operation/:key', c => {
    afterRead();
    if (!reads) return c.json({ error: 'synthetic unavailable' }, 503);
    const command = commands.get(`${actor(c.req.header('authorization'))}:${c.req.param('operation')}`, c.req.param('key'));
    return command ? c.json({ command: corruptKey ? { ...command, key: 'wrong-original' } : command }) : c.json({ error: 'missing' }, 404);
  });
  const server = kind === 'remote' ? serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server?.address();
  const origin = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : 'local://aod-connector';
  const connection = { id: 'alias', label: 'synthetic', kind, connectorUrl: origin };
  hub.upsertConnection(connection);
  hub.pinConnectionNode('alias', 'default', hub.connectionAuthority('alias')!, nodeId);
  if (kind === 'remote') hub.updateMaintenanceCredential('alias', 'synthetic-old');
  const local: LocalMaintenance | undefined = kind === 'local' ? { connectionId: 'alias', maintenanceToken: 'synthetic-old', dispatch: request => app.fetch(request) } : undefined;
  const closers: Array<() => void> = [];
  t.after(async () => {
    closers.forEach(close => close());
    await hub.maintenanceCommands.close(); hub.close(); db.close(); remoteDb.close();
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(directory, { recursive: true, force: true });
  });
  return { get hub() { return hub; }, db, commands, local, target, calls, connection, nodeId,
    http(authenticate: (request: Request) => HubPrincipal | undefined = () => ({ userId: 'default', admin: true })) {
      const frontend = new Hono();
      const config = loadConfig({ AOD_SERVER_ROLE: 'hub', AOD_HUB_DATABASE_FILE: file,
        AOD_HUB_VAULT_SECRET: 'synthetic-vault', AOD_LOCAL_OPENCLAW_CLI: 'false' } as NodeJS.ProcessEnv);
      const registered = registerHubRoutes(frontend, { config, hubStore: hub, connectorClient: createConnectorClientResolver(hub),
        normalizeError: () => 'synthetic failure', principal: authenticate, ...(local ? { localMaintenanceTransport: local } : {}) });
      if (registered) closers.push(() => registered.close());
      return frontend;
    },
    async reopen() { await hub.maintenanceCommands.close(); hub.close(); hub = new HubStore(file, 'synthetic-vault'); },
    setReads(value: boolean) { reads = value; }, setWrongPin(value: boolean) { wrongPin = value; },
    setCorruptKey(value: boolean) { corruptKey = value; }, revoke() { revoke = true; }, setPostReply(value: number) { postReply = value; },
    fullPost() { fullPost = true; },
    afterPost(callback: () => Promise<void>) { afterPost = callback; }, afterRead(callback: () => void) { afterRead = callback; },
  };
}

for (const kind of ['local', 'remote'] as const) test(`${kind} original maintenance receipt survives secret rotation and store reopen without a second POST`, async t => {
  const f = await fixture(t, kind); f.setReads(false);
  const unknown = await f.hub.maintenanceCommands.send(f.target, 'original', body, allow, f.local);
  assert.equal(unknown.state, 'outcome_unknown');
  assert.doesNotMatch(JSON.stringify(unknown), /synthetic-old|"origin"|"authority"|"binding"/);
  const saved = f.hub.commands.binding(scope(f.target), 'original')!;
  if (kind === 'remote') {
    f.hub.updateMaintenanceCredential('alias', 'synthetic-new');
    f.hub.upsertConnection({ ...f.connection, connectorUrl: 'http://127.0.0.1:1' });
    f.hub.deleteConnection('alias');
  } else f.local!.maintenanceToken = 'synthetic-new';
  await f.reopen(); f.setReads(true);
  const result = await f.hub.maintenanceCommands.send(f.target, 'original', body, { ...allow, send() { throw Error('must not reacquire'); } }, f.local);
  assert.equal(result.state, 'accepted');
  assert.equal(result.result?.body.state, 'failed', 'accepted command does not mean successful install');
  assert.equal(result.id, unknown.id);
  assert.deepEqual(f.hub.commands.binding(scope(f.target), 'original'), saved);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.at(-1)?.actor, kind === 'local' ? 'local:maintenance' : 'old');
});

test('revoked remote credential and wrong node/key remain unknown, never replay with replacement authority', async t => {
  const f = await fixture(t, 'remote'); f.setReads(false);
  await f.hub.maintenanceCommands.send(f.target, 'key', body, allow);
  f.setReads(true); f.setWrongPin(true);
  assert.equal((await f.hub.maintenanceCommands.recover(f.target, 'key', allow.read))?.state, 'outcome_unknown');
  f.setWrongPin(false); f.setCorruptKey(true);
  assert.equal((await f.hub.maintenanceCommands.recover(f.target, 'key', allow.read))?.state, 'outcome_unknown');
  f.setCorruptKey(false); f.revoke(); f.hub.updateMaintenanceCredential('alias', 'synthetic-new');
  assert.equal((await f.hub.maintenanceCommands.send(f.target, 'key', body, allow))?.state, 'outcome_unknown');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.some(call => call.actor === 'new'), false);
});

test('maintenance commands isolate users, owners, operations and downstream delivery keys', async t => {
  const f = await fixture(t, 'remote');
  const first = await f.hub.maintenanceCommands.send(f.target, 'same', body, allow);
  const otherUser = f.hub.createUser('second');
  f.hub.upsertConnection({ ...f.connection, ownerUserId: otherUser.id });
  f.hub.pinConnectionNode('alias', otherUser.id, f.hub.connectionAuthority('alias', otherUser.id)!, f.nodeId);
  f.hub.updateMaintenanceCredential('alias', 'synthetic-old', otherUser.id);
  const other = { ...f.target, userId: otherUser.id, ownerUserId: otherUser.id };
  assert.equal(await f.hub.maintenanceCommands.recover(other, 'same', allow.read), undefined);
  const second = await f.hub.maintenanceCommands.send(other, 'same', body, allow);
  assert.notEqual(first.id, second.id);
  assert.notEqual(f.hub.commands.deliveryKey(scope(f.target), 'same'), f.hub.commands.deliveryKey(scope(other), 'same'));
  const rollback = { ...f.target, operation: 'rollback' as const };
  assert.equal(await f.hub.maintenanceCommands.recover(rollback, 'same', allow.read), undefined);
  assert.equal((await f.hub.maintenanceCommands.send(rollback, 'same', {}, allow)).state, 'accepted');
  await assert.rejects(f.hub.maintenanceCommands.send(f.target, 'same', { ...body, version: 'different' }, allow), CommandConflict);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3);
});

test('legacy NULL binding never attaches current credentials or authorizes dispatch', async t => {
  const f = await fixture(t, 'remote');
  await f.hub.commands.claimAsync(scope(f.target), 'legacy', body, true);
  const result = await f.hub.maintenanceCommands.send(f.target, 'legacy', body, allow);
  assert.equal(result.state, 'outcome_unknown'); assert.equal(f.calls.length, 0);
  assert.equal(f.hub.commands.binding(scope(f.target), 'legacy'), undefined);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM env_credentials WHERE owner_user_id = char(0) || 'maintenance-command'`).get()!.n, 0);
});

test('retained encrypted secret is atomically bound, budgeted and deleted with its receipt', async t => {
  const f = await fixture(t, 'remote'); f.setReads(false);
  const unknown = await f.hub.maintenanceCommands.send(f.target, 'key', body, allow);
  const retained = f.db.prepare(`SELECT * FROM env_credentials WHERE connection_id = ? AND owner_user_id = char(0) || 'maintenance-command'`).get(unknown.id)!;
  assert.ok(retained); assert.doesNotMatch(JSON.stringify(retained), /synthetic-old/);
  const row = f.db.prepare('SELECT retained_bytes, binding_json FROM command_receipts WHERE id = ?').get(unknown.id)!;
  assert.ok(Number(row.retained_bytes) >= Buffer.byteLength(JSON.stringify(retained)));
  assert.doesNotMatch(String(row.binding_json), /synthetic-old/);
  f.hub.deleteConnection('alias');
  assert.ok(f.db.prepare('SELECT 1 FROM env_credentials WHERE connection_id = ?').get(unknown.id), 'connection deletion does not erase original recovery');
  f.db.exec(`CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON env_credentials BEGIN SELECT RAISE(ABORT, 'vault delete failed'); END`);
  assert.throws(() => f.db.prepare('DELETE FROM command_receipts WHERE id = ?').run(unknown.id), /vault delete failed/);
  assert.ok(f.hub.commands.get(scope(f.target), 'key'));
  f.db.exec('DROP TRIGGER synthetic_delete_failure');
  f.db.prepare('DELETE FROM command_receipts WHERE id = ?').run(unknown.id);
  assert.equal(f.db.prepare('SELECT 1 FROM env_credentials WHERE connection_id = ?').get(unknown.id), undefined);
  assert.equal(f.db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes, 0);
});

test('vault or receipt failure rolls back both records and performs no network dispatch', async t => {
  const f = await fixture(t, 'remote');
  for (const table of ['env_credentials', 'command_receipts']) {
    f.db.exec(`CREATE TRIGGER synthetic_insert_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic write failed'); END`);
    await assert.rejects(f.hub.maintenanceCommands.send(f.target, 'key', body, allow), /synthetic write failed/);
    f.db.exec('DROP TRIGGER synthetic_insert_failure');
    assert.equal(f.hub.commands.get(scope(f.target), 'key'), undefined);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM env_credentials WHERE owner_user_id = char(0) || 'maintenance-command'`).get()!.n, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('late HTTP403 after a switch is reconciled by original receipt, not marked as rejected', async t => {
  const f = await fixture(t); f.setPostReply(403);
  const result = await f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local);
  assert.equal(result.state, 'accepted'); assert.equal(result.result?.body.state, 'failed');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('reader revocation after response suppresses settlement and disclosure but preserves the original request', async t => {
  const f = await fixture(t); f.setReads(false);
  await f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local);
  f.setReads(true); let authorized = true;
  f.afterRead(() => { authorized = false; });
  await assert.rejects(f.hub.maintenanceCommands.recover(f.target, 'key', () => { if (!authorized) throw Error('reader revoked'); }, f.local), /reader revoked/);
  assert.equal(f.hub.commands.get(scope(f.target), 'key')?.state, 'outcome_unknown');
});

test('concurrent duplicate and close cannot redispatch or admit after closure', async t => {
  const f = await fixture(t);
  let release!: () => void, posted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { posted = resolve; });
  f.afterPost(async () => { posted(); await gate; });
  const first = f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local);
  const rejected = assert.rejects(first, /closed/);
  await started;
  const duplicate = await f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local);
  assert.equal(duplicate.state, 'accepted');
  const saved = f.hub.commands.binding(scope(f.target), 'key');
  let closed = false;
  const closing = f.hub.maintenanceCommands.close().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close must retain the original held dispatch');
  } finally { release(); }
  await closing; await rejected;
  assert.deepEqual(f.hub.commands.binding(scope(f.target), 'key'), saved);
  assert.deepEqual(f.hub.commands.get(scope(f.target), 'key'), duplicate);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await assert.rejects(f.hub.maintenanceCommands.send(f.target, 'new', body, allow, f.local), /closed/);
  assert.equal(f.hub.commands.get(scope(f.target), 'new'), undefined);
});

for (const operation of ['send', 'recover'] as const) for (const phase of ['dispatch', 'cancel'] as const) {
  test(`maintenance ${operation} store close retains original ${phase} and cancellation ACK`, async t => {
    const f = await fixture(t);
    if (operation === 'recover') {
      f.setReads(false);
      assert.equal((await f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local)).state, 'outcome_unknown');
    }
    let enter!: () => void, releaseDispatch!: () => void, cancel!: () => void, releaseCancel!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve; });
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
    const requests: Request[] = [];
    f.local!.dispatch = async request => {
      requests.push(request); enter();
      if (phase === 'dispatch') await dispatchGate;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancel(); return cancelGate; } }), {
        headers: { [NODE_ID_HEADER]: f.nodeId, [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) },
      });
    };
    const controller = new AbortController();
    const pending = operation === 'send'
      ? f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local, controller.signal)
      : f.hub.maintenanceCommands.recover(f.target, 'key', allow.read, f.local, controller.signal);
    const rejected = assert.rejects(pending, /synthetic abort|closed/);
    let closed = false, finished = false;
    void rejected.then(() => { finished = true; });
    let closing: Promise<void> | undefined;
    try {
      await started;
      if (phase === 'cancel') await new Promise<void>(resolve => setImmediate(resolve));
      const saved = f.db.prepare('SELECT * FROM command_receipts WHERE command_key = ?').get('key');
      assert.equal(saved?.state, 'outcome_unknown');
      const binding = f.hub.commands.binding(scope(f.target), 'key');
      assert.ok(binding);
      controller.abort(new Error('synthetic abort'));
      closing = Promise.resolve(f.hub.close()).then(() => { closed = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false); assert.equal(finished, false);
      releaseDispatch(); await cancelled;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false, 'original cancellation ACK is still held');
      assert.equal(finished, false);
      assert.deepEqual(f.hub.commands.binding(scope(f.target), 'key'), binding);
      assert.deepEqual(f.db.prepare('SELECT * FROM command_receipts WHERE command_key = ?').get('key'), saved);
      releaseCancel(); await rejected; await closing;
      assert.equal(closed, true); assert.equal(finished, true);
      assert.deepEqual(f.db.prepare('SELECT * FROM command_receipts WHERE command_key = ?').get('key'), saved);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, operation === 'send' ? 'POST' : 'GET');
      assert.equal(requests[0]!.headers.get(EXPECTED_NODE_HEADER), f.nodeId);
      assert.equal(f.calls.filter(call => call.method === 'POST').length, operation === 'send' ? 0 : 1);
    } finally {
      releaseDispatch(); releaseCancel(); controller.abort(new Error('synthetic abort'));
      await rejected; await closing;
    }
  });
}

test('terminal POST receipt settles without redundant GET; missing metadata requires original GET', async t => {
  const f = await fixture(t); f.fullPost();
  const result = await f.hub.maintenanceCommands.send(f.target, 'key', body, allow, f.local);
  assert.equal(result.state, 'accepted'); assert.equal(result.result?.body.state, 'failed');
  assert.deepEqual(f.calls.map(call => call.method), ['POST']);
});

test('changed authority immediately before dispatch preserves original unknown without any POST', async t => {
  const f = await fixture(t, 'remote');
  let rotated = false;
  const result = await f.hub.maintenanceCommands.send(f.target, 'key', body, { read() {}, send() {
    if (!rotated && f.hub.commands.get(scope(f.target), 'key')) {
      rotated = true; f.hub.updateMaintenanceCredential('alias', 'synthetic-new');
    }
  } });
  assert.equal(rotated, true);
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(f.calls.at(-1)?.actor, 'old');
  assert.notEqual(f.hub.commands.binding(scope(f.target), 'key')?.authority, f.hub.connectionAuthority('alias'));
});

test('missing pin, missing credential, disabled target and unavailable local runtime reject before admission', async t => {
  const f = await fixture(t, 'remote');
  const second = { ...f.target, connectionId: 'unverified' };
  f.hub.upsertConnection({ id: second.connectionId, label: 'unverified', connectorUrl: f.connection.connectorUrl });
  await assert.rejects(f.hub.maintenanceCommands.send(second, 'key', body, allow), /Verified/);
  f.hub.pinConnectionNode(second.connectionId, 'default', f.hub.connectionAuthority(second.connectionId)!, f.nodeId);
  await assert.rejects(f.hub.maintenanceCommands.send(second, 'key', body, allow), /credential/);
  f.hub.upsertConnection({ ...f.connection, status: 'disabled' });
  await assert.rejects(f.hub.maintenanceCommands.send(f.target, 'key', body, allow), /Verified/);
  f.hub.upsertConnection({ ...f.connection, kind: 'local', status: 'enabled', connectorUrl: 'local://aod-connector' });
  await assert.rejects(f.hub.maintenanceCommands.send(f.target, 'key', body, allow), /Local/);
  assert.equal(f.hub.commands.get(scope(f.target), 'key'), undefined);
  assert.equal(f.calls.length, 0);
});

const httpBase = '/api/hub/v1/connections/alias/update/commands';
test('Hub HTTP requires original key, returns full receipts and never uses legacy writes', async t => {
  const f = await fixture(t); const app = f.http(); f.setReads(false);
  const request = (input: unknown) => app.request(`${httpBase}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await request(body)).status, 400);
  assert.equal((await request({ ...body, idempotencyKey: 'key', ownerUserId: 'someone-else' })).status, 409);
  assert.equal((await request({ ...body, idempotencyKey: 'key' })).status, 202);
  f.setReads(true);
  const received = await app.request(`${httpBase}/apply/key`);
  assert.equal(received.status, 200); assert.equal(received.headers.get('cache-control'), 'no-store');
  const result = await received.json() as any;
  assert.equal(result.command.key, 'key'); assert.equal(result.command.result.body.state, 'failed');
  assert.equal((await request({ ...body, idempotencyKey: 'key' })).status, 200);
  assert.equal((await request({ ...body, version: 'v2', idempotencyKey: 'key' })).status, 409);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(f.calls.every(call => call.path.includes('/update/commands/')));
});

test('Hub HTTP recovery remains owner scoped and login revocation cannot disclose a late reply', async t => {
  const f = await fixture(t, 'remote'); const member = f.hub.createUser('member');
  let revoked = false;
  const app = f.http(request => revoked ? undefined : ({ userId: request.headers.get('x-synthetic-member') ? member.id : 'default', admin: !request.headers.get('x-synthetic-member') }));
  f.setReads(false);
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, idempotencyKey: 'key' }) };
  assert.equal((await app.request(`${httpBase}/apply`, init)).status, 202);
  assert.equal((await app.request(`${httpBase}/apply/key?ownerUserId=default`, { headers: { 'x-synthetic-member': '1' } })).status, 404);
  assert.equal((await app.request(`${httpBase}/apply`, { ...init, headers: { ...init.headers, 'x-synthetic-member': '1' } })).status, 404);
  f.hub.deleteConnection('alias'); f.setReads(true); f.afterRead(() => { revoked = true; });
  assert.equal((await app.request(`${httpBase}/apply/key`)).status, 401);
  assert.equal(f.hub.commands.get(scope(f.target), 'key')?.state, 'outcome_unknown');
  revoked = false; f.afterRead(() => {});
  const recovered = await app.request(`${httpBase}/apply/key`);
  assert.equal((await recovered.json() as any).command.state, 'accepted');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

for (const kind of ['local', 'remote'] as const) for (const operation of ['pause', 'resume'] as const) {
  test(`Hub admission ${kind} ${operation} recovers only its original receipt after rotation and deletion`, async context => {
    const setup = await fixture(context, kind);
    const app = setup.http();
    const target: MaintenanceTarget = { ...setup.target, operation };
    const route = `/api/hub/v1/connections/alias/maintenance/commands/${operation}`;
    const payload = operation === 'resume' ? { fenceId: 'a'.repeat(36) } : {};
    const init = { method: 'POST', body: JSON.stringify({ ...payload, idempotencyKey: 'original' }) };
    setup.setReads(false);
    const response = await app.request(route, init);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).command.state, 'outcome_unknown');
    assert.equal(setup.hub.commands.get(scope(target), 'original')?.state, 'outcome_unknown');
    assert.equal(setup.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(setup.calls[0]?.path, `/api/connector/v1/maintenance/commands/${operation}`);
    if (kind === 'remote') setup.hub.updateMaintenanceCredential('alias', 'synthetic-new');
    else setup.local!.maintenanceToken = 'synthetic-new';
    await setup.reopen();
    const reopened = setup.http();
    assert.equal((await reopened.request(route, init)).status, 202);
    setup.hub.deleteConnection('alias');
    setup.setReads(true);
    const recovered = await reopened.request(`${route}/original`);
    assert.equal(recovered.status, 200);
    const { command } = await recovered.json();
    assert.equal(command.state, 'accepted');
    assert.equal(command.result.body.state, operation === 'pause' ? 'paused' : 'released');
    assert.equal(command.result.body.boundary, 'admission_only');
    assert.equal(command.result.body.nativeQuiescent, false);
    assert.equal((await reopened.request(`${route.replace(operation, operation === 'pause' ? 'resume' : 'pause')}/original`)).status, 404);
    assert.equal(setup.calls.filter(call => call.method === 'POST').length, 1);
    assert.ok(setup.calls.every(call => call.actor === (kind === 'local' ? 'local:maintenance' : 'old')));
  });
}

test('Hub admission validates fence and fields before claiming or contacting a Connector', async context => {
  const setup = await fixture(context);
  const app = setup.http();
  for (const [operation, payload] of [
    ['pause', { fenceId: 'a'.repeat(36) }], ['pause', { version: 'v1' }], ['resume', {}],
    ['resume', { fenceId: '../another' }], ['resume', { fenceId: 'a'.repeat(36), actorId: 'other' }],
  ] as const) {
    const response = await app.request(`/api/hub/v1/connections/alias/maintenance/commands/${operation}`,
      { method: 'POST', body: JSON.stringify({ idempotencyKey: 'invalid', ...payload }) });
    assert.equal(response.status, 409);
  }
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 0);
});

test('Hub maintenance slow/oversize bodies fail before claim and preserve authenticated recovery scope', async t => {
  const f = await fixture(t); let revoked = false;
  const app = f.http(() => revoked ? undefined : ({ userId: 'default', admin: true }));
  const path = `${httpBase}/rollback`;
  assert.equal((await app.request(path, { method: 'POST', body: ' '.repeat(8193) })).status, 413);
  assert.equal((await app.request(path, { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await app.request(path, { method: 'POST', headers: { 'x-agentopsdeck-recovery-scope': 'different-installation' }, body: JSON.stringify({ idempotencyKey: 'key' }) })).status, 409);
  let controller!: ReadableStreamDefaultController<Uint8Array>, readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { readStarted(); } });
  const pending = app.request(new Request(`http://hub.test${path}`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit));
  await started; revoked = true;
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ idempotencyKey: 'key' }))); controller.close();
  assert.equal((await pending).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 0);
});
