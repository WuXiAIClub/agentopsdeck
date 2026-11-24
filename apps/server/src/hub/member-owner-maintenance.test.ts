import assert from 'node:assert/strict';
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
import { AsyncHubMaintenanceCommands } from './async-maintenance-commands.js';
import { registerHubMaintenanceRoutes } from './maintenance-http.js';
import { CommandReceipts } from '../commands/receipts.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validHubMaintenanceCommand, validHubMaintenanceReply, validMaintenanceEffect } from './member-maintenance-domain.js';
import { validHubMemberInput } from './member-owner-domain.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const payload = (operation: string) => operation === 'apply' ? { version: 'v1', manifestSha256: 'a'.repeat(64) }
  : operation === 'resume' ? { fenceId: 'a'.repeat(36) } : {};

/** The node has its own DB. Seed/reconfigure only while the sole Hub owner is closed. */
async function fixture(t: TestContext, mode: 'worker' | 'original', kind: 'local' | 'remote') {
  const root = mkdtempSync(join(tmpdir(), 'async-maintenance-chain-')), file = join(root, 'hub.sqlite');
  const nodeDb = new DatabaseSync(join(root, 'node.sqlite')), receipts = new CommandReceipts(nodeDb);
  const calls: { method: string; path: string; actor: string }[] = [], logs: string[] = [], callbackErrors: unknown[] = [];
  let blockedReads = false, lostPost = false, corrupt = false, wrongNode = false, localToken = 'synthetic-old';
  let after: (() => void | Promise<void>) | undefined;
  const connector = new Hono();
  connector.use('*', async (c, next) => {
    c.header(NODE_ID_HEADER, wrongNode ? 'wrong-node' : nodeId);
    const token = c.req.header('authorization');
    const actor = kind === 'local' && token === `Bearer ${localToken}` ? 'local:maintenance'
      : kind === 'remote' && token === 'Bearer synthetic-old' ? 'old'
        : kind === 'remote' && token === 'Bearer synthetic-new' ? 'new' : 'invalid';
    calls.push({ method: c.req.method, path: c.req.path, actor });
    if (actor === 'invalid') return c.json({ error: 'denied' }, 403);
    if (c.req.header(EXPECTED_NODE_HEADER) !== nodeId) return c.json({ error: 'wrong pin' }, 409);
    await next();
  });
  const scope = (auth: string | undefined, operation: string) => `${kind === 'local' ? 'local:maintenance' : auth === 'Bearer synthetic-old' ? 'old' : 'new'}:${operation}`;
  connector.post('/api/connector/v1/:boundary/commands/:operation', async c => {
    const { idempotencyKey, ...input } = await c.req.json();
    const originalScope = scope(c.req.header('authorization'), c.req.param('operation'));
    receipts.claim(originalScope, idempotencyKey, input);
    receipts.settle(originalScope, idempotencyKey, { status: 200, body: c.req.param('boundary') === 'maintenance'
      ? { state: c.req.param('operation') === 'pause' ? 'paused' : 'released', boundary: 'admission_only', nativeQuiescent: false, fenceId: 'a'.repeat(36) }
      : { state: 'failed', error: 'synthetic install failure' } });
    try { await after?.(); } catch (error) { callbackErrors.push(error); return c.json({ error: 'fixture callback failed' }, 503); }
    if (lostPost) return c.json({ error: 'synthetic lost ACK' }, 503);
    const { result, ...command } = receipts.get(originalScope, idempotencyKey)!;
    return c.json({ ...result!.body, command });
  });
  connector.get('/api/connector/v1/:boundary/commands/:operation/:key', c => {
    if (blockedReads) return c.json({ error: 'synthetic unavailable' }, 503);
    const command = receipts.get(scope(c.req.header('authorization'), c.req.param('operation')), c.req.param('key'));
    return command ? c.json({ command: corrupt ? { ...command, key: 'wrong-key' } : command }) : c.json({ error: 'missing' }, 404);
  });
  const server = kind === 'remote' ? serve({ hostname: '127.0.0.1', port: 0, fetch: connector.fetch }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server?.address(), origin = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : 'local://aod-connector';
  const seed = new HubStore(file, 'synthetic-vault');
  seed.upsertConnection({ id: 'alias', kind, label: 'fixture', connectorUrl: origin });
  seed.pinConnectionNode('alias', 'default', seed.connectionAuthority('alias')!, nodeId);
  if (kind === 'remote') seed.updateMaintenanceCredential('alias', 'synthetic-old');
  const login = seed.identities.issueKey('default'); await seed.close();
  const adminDb = new DatabaseSync(file);
  try { adminDb.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run(); } finally { adminDb.close(); }
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  let original: HubStore | undefined;
  let trustedLocal = kind === 'local';
  const local = () => kind === 'local' ? { connectionId: 'alias', maintenanceToken: localToken, dispatch: (request: Request) => connector.fetch(request) } : undefined;
  const open = () => {
    const localId = trustedLocal ? 'alias' : undefined;
    const owner = mode === 'worker' ? new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault', ...(localId ? { localMaintenanceConnectionId: localId } : {}) }, diagnostics)
      : new OriginalHubAdministrativeCommands(original = new HubStore(file, 'synthetic-vault', [], undefined, undefined, localId), diagnostics);
    return { owner, maintenance: new AsyncHubMaintenanceCommands(owner, local(), diagnostics) };
  };
  let services = open();
  const close = async () => { await services.maintenance.close(); await services.owner.close(); await original?.close(); original = undefined; };
  const app = new Hono();
  registerHubMaintenanceRoutes(app, {
    mode: 'async',
    asyncMaintenance: { open: (request, target) => services.maintenance.open(request, target), close: () => services.maintenance.close() },
  });
  const request = (operation: 'apply' | 'rollback' | 'pause' | 'resume', method = 'POST', key = 'original', body: unknown = payload(operation), credential = login.token) => {
    const base = `/api/hub/v1/connections/alias/${operation === 'pause' || operation === 'resume' ? 'maintenance' : 'update'}/commands/${operation}`;
    return app.request(base + (method === 'GET' ? '/' + key : ''), { method,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ ...(body as object), idempotencyKey: key }) } : {}) });
  };
  t.after(async () => {
    after = undefined; await close(); nodeDb.close();
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    rmSync(root, { recursive: true, force: true }); assert.deepEqual(callbackErrors, [], 'fixture callback errors');
  });
  return { request, calls, logs, login, close, local,
    get owner() { return services.owner; }, get maintenance() { return services.maintenance; },
    loseAck() { lostPost = true; blockedReads = true; }, allowReads() { blockedReads = false; },
    corrupt() { corrupt = true; }, wrongNode() { wrongNode = true; },
    afterRequest(fn?: () => void | Promise<void>) { after = fn; },
    async reopen(edit?: (hub: HubStore) => void, privateLocal = true) {
      await close(); trustedLocal = kind === 'local' && privateLocal;
      if (edit) { const hub = new HubStore(file, 'synthetic-vault'); try { edit(hub); } finally { await hub.close(); } }
      if (kind === 'local') localToken = 'synthetic-new';
      services = open();
    },
  };
}

for (const mode of ['worker', 'original'] as const) for (const kind of ['local', 'remote'] as const) {
  for (const operation of ['apply', 'rollback', 'pause', 'resume'] as const) test(`${mode}/${kind}: ${operation} full route, duplicate and history keep one original POST`, async t => {
    const f = await fixture(t, mode, kind);
    const response = await f.request(operation); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json() as any; assert.equal(first.command.key, 'original');
    assert.equal(first.command.state, 'accepted');
    assert.equal((await f.request(operation)).status, 200);
    const history = await f.request(operation, 'GET'); assert.equal(history.status, 200);
    assert.equal((await history.json() as any).command.id, first.command.id);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    assert.match(f.logs.join('\n'), /hub-maintenance-effect/);
    assert.doesNotMatch(f.logs.join('\n'), /synthetic-old|synthetic-new|synthetic-vault/);
  });
  test(`${mode}/${kind}: unknown ACK survives reopen and rotation, recovery is original GET only`, async t => {
    const f = await fixture(t, mode, kind); f.loseAck();
    const response = await f.request('pause'); assert.equal(response.status, 202);
    const first = await response.json() as any; assert.equal(first.command.state, 'outcome_unknown');
    await f.reopen(hub => { if (kind === 'remote') hub.updateMaintenanceCredential('alias', 'synthetic-new'); }); f.allowReads();
    const recovered = await f.request('pause', 'GET'); assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal((await f.request('pause')).status, 200);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    assert.ok(f.calls.slice(1).every(c => c.actor === (kind === 'local' ? 'local:maintenance' : 'old')));
  });
  test(`${mode}/${kind}: malformed historical key cannot settle or repeat original POST`, async t => {
    const f = await fixture(t, mode, kind); f.loseAck(); await f.request('rollback'); f.allowReads(); f.corrupt();
    const response = await f.request('rollback', 'GET'); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).command.state, 'outcome_unknown');
    assert.equal((await f.request('rollback')).status, 202);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });
  test(`${mode}/${kind}: node mismatch cannot settle original command`, async t => {
    const f = await fixture(t, mode, kind); f.wrongNode();
    const response = await f.request('pause'); assert.equal(response.status, 202);
    assert.equal((await response.json() as any).command.state, 'outcome_unknown');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });
  test(`${mode}/${kind}: revoked login after original effect blocks response and further effects`, async t => {
    const f = await fixture(t, mode, kind), evidence = { accessKey: f.login.token };
    const actor = await f.owner.command('memberSnapshot', evidence); assert.ok(actor);
    f.afterRequest(async () => { f.afterRequest(); assert.deepEqual(await f.owner.command('memberKeyRevoke', {
      evidence, expectedScope: actor.recoveryScope, userId: 'default', keyId: f.login.id }), { ok: true }); });
    assert.equal((await f.request('pause')).status, 401); assert.equal(f.calls.length, 1);
    let replacement = '';
    await f.reopen(hub => { replacement = hub.identities.issueKey('default').token; });
    const response = await f.request('pause', 'GET', 'original', {}, replacement);
    assert.equal(response.status, 200); assert.equal((await response.json() as any).command.state, 'accepted');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });
  test(`${mode}/${kind}: close waits for held original effect and fences all further work`, async t => {
    const f = await fixture(t, mode, kind);
    let release!: () => void, entered!: () => void, drained = false;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.afterRequest(async () => { f.afterRequest(); entered(); await held; });
    const pending = Promise.resolve(f.request('pause')); await started;
    const closing = f.maintenance.close(); void closing.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal((await f.request('pause')).status, 503);
    release(); assert.equal((await pending).status, 503); await closing;
    await f.reopen(); const recovered = await f.request('pause', 'GET');
    assert.equal(recovered.status, 200); assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });
  test(`${mode}/${kind}: lost settlement ACK fences request, next request only reads receipt`, async t => {
    const f = await fixture(t, mode, kind);
    const service = new AsyncHubMaintenanceCommands({ command: async (name, input) => {
      const result = await f.owner.command(name, input);
      if (name === 'maintenanceCommand' && (input as any).command.action === 'observe') throw Error('synthetic lost owner ACK');
      return result;
    } }, f.local(), new PerformanceDiagnostics(() => {}));
    try {
      const port = await service.open(new Request('http://hub/', { headers: { authorization: `Bearer ${f.login.token}` } }), { connectionId: 'alias', operation: 'pause' });
      await assert.rejects(port.send('owner-ack', {}), { status: 503 });
    } finally { await service.close(); }
    const response = await f.request('pause', 'GET', 'owner-ack'); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).command.state, 'accepted'); assert.equal(f.calls.length, 1);
  });
  test(`${mode}/${kind}: lost claim ACK retains unknown and never authorizes replacement POST`, async t => {
    const f = await fixture(t, mode, kind);
    const service = new AsyncHubMaintenanceCommands({ command: async (name, input) => {
      const result = await f.owner.command(name, input);
      if (name === 'maintenanceCommand' && (input as any).command.action === 'claim') throw Error('synthetic lost claim ACK');
      return result;
    } }, f.local(), new PerformanceDiagnostics(() => {}));
    try {
      const port = await service.open(new Request('http://hub/', { headers: { authorization: `Bearer ${f.login.token}` } }), { connectionId: 'alias', operation: 'pause' });
      await assert.rejects(port.send('claim-ack', {}), { status: 503 });
    } finally { await service.close(); }
    assert.equal(f.calls.length, 0);
    await f.reopen();
    const response = await f.request('pause', 'GET', 'claim-ack'); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).command.state, 'outcome_unknown');
    assert.equal((await f.request('pause', 'POST', 'claim-ack')).status, 202);
    assert.ok(f.calls.every(c => c.method === 'GET'));
  });
  test(`${mode}/${kind}: invalid payload, conflict, missing receipt and unauthorized request are bounded`, async t => {
    const f = await fixture(t, mode, kind);
    assert.equal((await f.request('apply', 'POST', 'bad', {})).status, 409);
    assert.equal((await f.request('pause', 'GET', 'absent')).status, 404);
    assert.equal((await f.request('pause', 'POST', 'bad', {}, 'invalid')).status, 401);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('apply')).status, 200);
    assert.equal((await f.request('apply', 'POST', 'original', { version: 'v2', manifestSha256: 'b'.repeat(64) })).status, 409);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  });
  if (kind === 'local') test(`${mode}: caller cannot create local execution authority without private owner configuration`, async t => {
    const f = await fixture(t, mode, kind); await f.reopen(undefined, false);
    assert.equal((await f.request('pause')).status, 503); assert.equal(f.calls.length, 0);
  });
}

test('maintenance fixed DTOs bind target/key/action/digest and exclude caller authority or arbitrary effects', () => {
  const target = { connectionId: 'alias', operation: 'pause' as const }, command = { action: 'prepare' as const, target };
  assert.equal(validHubMaintenanceCommand(command), true);
  for (const extra of [{ userId: 'default' }, { sql: 'SELECT 1' }, { local: true }, { url: 'http://elsewhere' }]) {
    assert.equal(validHubMaintenanceCommand({ ...command, ...extra }), false);
    assert.equal(validHubMaintenanceCommand({ ...command, target: { ...target, ...extra } }), false);
  }
  const effect = { kind: 'local', nodeId, origin: 'local://aod-connector', delivery: 'original', digest: 'a'.repeat(64) };
  assert.equal(validMaintenanceEffect(effect), true);
  assert.equal(validMaintenanceEffect({ ...effect, credential: 'synthetic-local' }), false);
  assert.equal(validMaintenanceEffect({ ...effect, kind: 'remote', origin: ['http://', 'user', ':', 'pass', '@', 'host/'].join(''), credential: 'synthetic' }), false);
  assert.equal(validHubMaintenanceReply(command, { action: 'prepare', target, pin: null }), true);
  assert.equal(validHubMaintenanceReply(command, { action: 'prepare', target: { ...target, connectionId: 'other' }, pin: null }), false);
  assert.equal(validHubMemberInput('maintenanceCommand', { evidence: {}, expectedScope: 'a'.repeat(64), command, local: true }), false);
});
