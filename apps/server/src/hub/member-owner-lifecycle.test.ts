import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubLifecycleCommands } from './async-lifecycle-commands.js';
import { LifecycleClient } from './lifecycle-client.js';
import { registerHubLifecycleRoutes } from './lifecycle-http.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { MAINTENANCE_PROTOCOL_HEADER, createMaintenanceApp } from '../lifecycle/maintenance-http.js';
import { SqliteMaintenanceJournal } from '../lifecycle/maintenance-journal.js';
import { MaintenanceSupervisor } from '../lifecycle/maintenance-supervisor.js';
import type { MaintenanceAdapter } from '../lifecycle/connector-maintenance.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validHubLifecycleCommand, validHubLifecycleReply, validHubLifecycleResult } from './member-lifecycle-domain.js';
import { validHubMemberInput } from './member-owner-domain.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const target = { connectionId: 'remote', operation: 'restart' as const };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Seed/reconfiguration closes the sole Hub writer first, including its effects.
 * The loopback node has an independent DB and real maintenance protocol. */
async function fixture(t: TestContext, kind: 'worker' | 'original', administrator = false) {
  const root = mkdtempSync(join(tmpdir(), 'async-lifecycle-chain-')), file = join(root, 'hub.sqlite');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const token = tokens.create({ label: 'Synthetic lifecycle', scopes: ['connector:lifecycle'] });
  const remoteDb = new DatabaseSync(join(root, 'node.sqlite'));
  const journal = new SqliteMaintenanceJournal(remoteDb);
  const supervisor = new MaintenanceSupervisor(journal, {} as MaintenanceAdapter,
    async actor => tokens.hasScope(actor, 'connector:lifecycle'), { nodeId, operations: ['restart', 'upgrade'] });
  const maintenance = createMaintenanceApp({ supervisor, tokens: () => tokens, workerState: () => 'running' });
  const calls: { method: string; path: string }[] = [], logs: string[] = [];
  let lostPost = false, blockedReads = false, wrongNode = false;
  let after: (() => void | Promise<void>) | undefined;
  const callbackErrors: unknown[] = [];
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    calls.push({ method: request.method, path: new URL(request.url).pathname });
    if (blockedReads && request.method === 'GET') return new Response('', { status: 503 });
    const response = await maintenance.fetch(request);
    try { await after?.(); } catch (error) { callbackErrors.push(error); return new Response('', { status: 503 }); }
    if (lostPost && request.method === 'POST') return new Response('', { status: 503 });
    if (wrongNode) response.headers.set(NODE_ID_HEADER, 'wrong-node');
    return response;
  } });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let endpoints = [{ ownerUserId: 'default', connectionId: 'remote', nodeId, origin }];
  const seed = new HubStore(file, 'synthetic-vault', endpoints);
  seed.upsertConnection({ id: 'remote', kind: 'remote', label: 'fixture', connectorUrl: origin });
  seed.pinConnectionNode('remote', 'default', seed.connectionAuthority('remote')!, nodeId);
  seed.updateMaintenanceCredential('remote', token.token);
  const login = seed.identities.issueKey('default');
  await seed.close();
  if (administrator) {
    const db = new DatabaseSync(file);
    try { db.prepare("INSERT INTO hub_roles VALUES ('default', 'admin', 1)").run(); }
    finally { db.close(); }
  }
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  let original: HubStore | undefined;
  const open = () => {
    const owner = kind === 'worker' ? new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault', lifecycleEndpoints: endpoints }, diagnostics)
      : new OriginalHubAdministrativeCommands(original = new HubStore(file, 'synthetic-vault', endpoints), diagnostics);
    return { owner, lifecycle: new AsyncHubLifecycleCommands(owner, diagnostics) };
  };
  let services = open();
  const close = async () => { await services.lifecycle.close(); await services.owner.close(); await original?.close(); original = undefined; };
  const app = new Hono();
  registerHubLifecycleRoutes(app, {
    mode: 'async',
    asyncLifecycle: { open: (request, target) => services.lifecycle.open(request, target), close: () => services.lifecycle.close() },
  });
  const base = '/api/hub/v1/connections/remote/lifecycle';
  const request = (path: string, method = 'GET', body?: unknown, credential = login.token) => app.request(base + path, {
    method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  t.after(async () => {
    after = undefined;
    await close(); remoteDb.close(); if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(callbackErrors, [], 'maintenance fixture callbacks must not silently fail');
  });
  return { calls, logs, login, token, request, close, callbackErrors,
    get lifecycle() { return services.lifecycle; },
    get owner() { return services.owner; },
    loseAck() { lostPost = true; blockedReads = true; },
    allowReads() { blockedReads = false; },
    wrongNode() { wrongNode = true; },
    afterRequest(fn?: () => void | Promise<void>) { after = fn; },
    async reopen(edit?: (hub: HubStore) => void, removeEndpoints = false) {
      await close();
      if (edit) { const hub = new HubStore(file, 'synthetic-vault', endpoints); try { edit(hub); } finally { await hub.close(); } }
      if (removeEndpoints) endpoints = [];
      services = open();
    },
  };
}

for (const kind of ['worker', 'original'] as const) {
  for (const operation of ['restart', 'upgrade'] as const) test(`${kind}: real lifecycle ${operation} route, status and duplicate use one POST`, async t => {
    const f = await fixture(t, kind);
    const status = await f.request('/status'); assert.equal(status.status, 200);
    assert.equal((await status.json() as any).configured, true);
    const path = `/commands/${operation}`, reply = await f.request(path, 'POST', { idempotencyKey: 'original' });
    assert.equal(reply.status, 202); assert.equal(reply.headers.get('cache-control'), 'no-store');
    const receipt = await reply.json() as any;
    assert.equal(receipt.command.state, 'accepted'); assert.equal(receipt.command.key, 'original');
    assert.equal(receipt.job.operation, operation); assert.equal(receipt.observationUnavailable, false);
    assert.equal((await f.request(path, 'POST', { idempotencyKey: 'original' })).status, 202);
    const historical = await f.request(path + '/original'); assert.equal(historical.status, 200);
    assert.equal((await historical.json() as any).job.id, receipt.job.id);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    const effects = f.logs.map(line => JSON.parse(line)).filter(row => row.operation === 'hub-maintenance-effect');
    for (const step of [1, 2, 3]) assert.ok(effects.some(row => row.step === step && row.settled === 1));
    for (const secret of [f.login.token, f.token.token, '127.0.0.1', receipt.job.id]) assert.ok(!f.logs.join('\n').includes(secret));
  });

  test(`${kind}: unknown ACK survives reopen, credential rotation and endpoint removal; GET only`, async t => {
    const f = await fixture(t, kind); f.loseAck();
    const reply = await f.request('/commands/restart', 'POST', { idempotencyKey: 'lost' }); assert.equal(reply.status, 202);
    assert.equal((await reply.json() as any).command.state, 'outcome_unknown');
    await f.reopen(hub => hub.updateMaintenanceCredential('remote', 'synthetic-rotated'), true); f.allowReads();
    const recovered = await f.request('/commands/restart/lost'); assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal((await f.request('/commands/restart', 'POST', { idempotencyKey: 'lost' })).status, 202);
    assert.equal((await f.request('/commands/restart', 'POST', { idempotencyKey: 'new' })).status, 503);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });

  test(`${kind}: invalid JSON domain and revoked original key never invoke network or sync fallback`, async t => {
    const f = await fixture(t, kind);
    for (const body of [{ idempotencyKey: 'key', origin: 'https://arbitrary.invalid' }, { idempotencyKey: 'key', userId: 'default' }, {}]) {
      assert.equal((await f.request('/commands/restart', 'POST', body)).status, 400);
    }
    assert.equal((await f.request('/commands/restart', 'POST', { idempotencyKey: 'bad/key' })).status, 409);
    assert.equal((await f.request('/commands/restart/missing')).status, 404);
    await f.reopen(hub => { hub.identities.revokeKey('default', f.login.id); });
    assert.equal((await f.request('/status')).status, 401);
    assert.equal((await f.request('/commands/restart', 'POST', { idempotencyKey: 'key' })).status, 401);
    assert.equal(f.calls.length, 0);
  });

  test(`${kind}: close drains held original effect, fences every request, reopen only queries original`, async t => {
    const f = await fixture(t, kind);
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    f.afterRequest(() => { arrive(); return held; });
    const pending = Promise.resolve(f.request('/commands/restart', 'POST', { idempotencyKey: 'held' }));
    await Promise.race([arrived, pending.then(() => { throw Error('Lifecycle effect was never dispatched'); })]);
    const closing = f.lifecycle.close(); let drained = false; void closing.then(() => { drained = true; });
    try {
      assert.equal(f.lifecycle.close(), closing);
      assert.equal((await f.request('/status')).status, 503);
      await tick(); assert.equal(drained, false);
    } finally { release(); f.afterRequest(); }
    assert.equal((await pending).status, 503); await closing;
    await f.reopen();
    const recovered = await f.request('/commands/restart/held'); assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });

  test(`${kind}: wrong pinned node preserves original unknown, never a second POST`, async t => {
    const f = await fixture(t, kind); f.wrongNode();
    const reply = await f.request('/commands/restart', 'POST', { idempotencyKey: 'pin' }); assert.equal(reply.status, 202);
    assert.equal((await reply.json() as any).command.state, 'outcome_unknown');
    assert.equal((await f.request('/commands/restart', 'POST', { idempotencyKey: 'pin' })).status, 202);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });

  test(`${kind}: key revoked during original POST prevents response delivery and further effects`, async t => {
    const f = await fixture(t, kind, true), evidence = { accessKey: f.login.token };
    let revoked = false;
    const snapshot = await f.owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    f.afterRequest(async () => {
      f.afterRequest();
      assert.deepEqual(await f.owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope,
        userId: 'default', keyId: f.login.id }), { ok: true });
      assert.equal(await f.owner.command('memberSnapshot', evidence), null);
      revoked = true;
    });
    const response = await f.request('/commands/restart', 'POST', { idempotencyKey: 'revoked-in-flight' });
    assert.deepEqual(f.callbackErrors, [], 'revocation callback');
    assert.equal(f.calls.length, 1, 'original POST dispatched');
    assert.equal(revoked, true, 'in-flight revocation callback completed');
    assert.equal(response.status, 401);
    assert.equal(f.calls.length, 1);
    let replacement = '';
    await f.reopen(hub => { replacement = hub.identities.issueKey('default').token; });
    const recovered = await f.request('/commands/restart/revoked-in-flight', 'GET', undefined, replacement);
    assert.equal(recovered.status, 200); assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });

  test(`${kind}: lost owner settlement ACK fences the request; reopening only reads original receipt`, async t => {
    const f = await fixture(t, kind);
    const lifecycle = new AsyncHubLifecycleCommands({ command: async (kind, input) => {
      const value = await f.owner.command(kind, input);
      if (kind === 'lifecycleCommand' && (input as any).command.action === 'observe') throw Error('synthetic lost owner ACK');
      return value;
    } }, new PerformanceDiagnostics(() => {}));
    const port = await lifecycle.open(new Request('http://hub/', { headers: { authorization: `Bearer ${f.login.token}` } }), target);
    try { await assert.rejects(port.send('owner-ack'), { status: 503 }); }
    finally { await lifecycle.close(); }
    assert.equal(f.calls.length, 1);
    await f.reopen();
    const recovered = await f.request('/commands/restart/owner-ack'); assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });
}

test('fixed lifecycle DTOs reject arbitrary authority, destination, RPC and wrong-target replies', () => {
  const command = { action: 'prepare', target };
  assert.ok(validHubLifecycleCommand(command));
  for (const extra of [{ userId: 'default' }, { admin: true }, { sql: 'SELECT 1' }, { method: 'send' }, { origin: 'https://arbitrary.invalid' }]) {
    assert.equal(validHubLifecycleCommand({ ...command, ...extra }), false);
  }
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64), command };
  assert.ok(validHubMemberInput('lifecycleCommand', proof));
  assert.equal(validHubMemberInput('lifecycleCommand', { ...proof, userId: 'default' }), false);
  const reply = { action: 'prepare', target, pin: null };
  assert.ok(validHubLifecycleResult(reply)); assert.ok(validHubLifecycleReply(command as any, reply));
  assert.equal(validHubLifecycleReply(command as any, { ...reply, target: { ...target, connectionId: 'another' } }), false);
  assert.equal(validHubLifecycleReply(command as any, { ...reply, target: { ...target, operation: 'upgrade' } }), false);
});

test('LifecycleClient awaits async authority before dispatch and every response chunk', async () => {
  const actorId = 'actor', key = 'original';
  const job = { version: 1, nodeId, actorId, operation: 'restart', createdAt: 1, deadline: 1001, revision: 0, stage: 'prepare',
    id: `maintenance:${createHash('sha256').update(JSON.stringify([nodeId, actorId, key])).digest('hex')}` };
  let release!: () => void, calls = 0, checks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new LifecycleClient(nodeId, 'https://maintenance.invalid', 'synthetic', async () => {
    checks++; if (checks === 1) await gate; else throw Error('revoked before body delivery');
  }, () => { calls++; return new Response(JSON.stringify({ command: job }), {
    headers: { [NODE_ID_HEADER]: nodeId, [MAINTENANCE_PROTOCOL_HEADER]: '1' },
  }); });
  const pending = assert.rejects(client.command(key, 'restart'));
  await tick(); assert.equal(calls, 0); release(); await pending;
  assert.equal(calls, 1); assert.equal(checks, 2);
});
