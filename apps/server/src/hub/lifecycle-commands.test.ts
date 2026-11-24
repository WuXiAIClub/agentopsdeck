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
import { LifecycleClient, parseLifecycleEndpoints } from './lifecycle-client.js';
import { registerHubLifecycleRoutes } from './lifecycle-http.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { MAINTENANCE_API, MAINTENANCE_PROTOCOL_HEADER, createMaintenanceApp } from '../lifecycle/maintenance-http.js';
import { SqliteMaintenanceJournal } from '../lifecycle/maintenance-journal.js';
import { MaintenanceSupervisor } from '../lifecycle/maintenance-supervisor.js';
import type { MaintenanceAdapter } from '../lifecycle/connector-maintenance.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const target = { userId: 'default', connectionId: 'remote', operation: 'restart' as const };
const allow = () => {};

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-lifecycle-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const token = tokens.create({ label: 'synthetic', scopes: ['connector:lifecycle'] });
  const remoteDb = new DatabaseSync(join(root, 'node.sqlite'));
  remoteDb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const journal = new SqliteMaintenanceJournal(remoteDb);
  const supervisor = new MaintenanceSupervisor(journal, {} as MaintenanceAdapter,
    async actor => tokens.hasScope(actor, 'connector:lifecycle'), { nodeId, operations: ['restart', 'upgrade'] });
  const maintenance = createMaintenanceApp({ supervisor, tokens: () => tokens, workerState: () => 'running' });
  const calls: { method: string; path: string }[] = [];
  let lostPost = false, rejectReads = false, wrongNode = false, afterRequest = () => {};
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    calls.push({ method: request.method, path: new URL(request.url).pathname });
    if (rejectReads && request.method === 'GET') return new Response('', { status: 503 });
    const response = await maintenance.fetch(request);
    afterRequest();
    if (lostPost && request.method === 'POST') return new Response('', { status: 503 });
    if (wrongNode) response.headers.set(NODE_ID_HEADER, 'wrong-node');
    return response;
  } });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoints = [{ ownerUserId: 'default', connectionId: 'remote', nodeId, origin }];
  const file = join(root, 'hub.sqlite'); let hub = new HubStore(file, 'synthetic', endpoints);
  hub.upsertConnection({ id: 'remote', kind: 'remote', label: 'test', connectorUrl: origin });
  hub.pinConnectionNode('remote', 'default', hub.connectionAuthority('remote')!, nodeId);
  hub.updateMaintenanceCredential('remote', token.token);
  t.after(async () => {
    await hub.lifecycleCommands.close(); hub.close(); remoteDb.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return { get hub() { return hub; }, calls, journal, token, origin, endpoints,
    losePost() { lostPost = true; }, rejectReads() { rejectReads = true; }, wrongNode() { wrongNode = true; },
    afterRequest(fn: () => void) { afterRequest = fn; },
    async reopen() { await hub.lifecycleCommands.close(); hub.close(); hub = new HubStore(file, 'synthetic', []); },
    http(userId = 'default') {
      const app = new Hono(); registerHubLifecycleRoutes(app, { store: hub, principal: () => ({ userId, admin: true }) }); return app;
    },
  };
}

test('endpoint opt-in is strict, TLS or loopback only, no browser-selected destinations', () => {
  const valid = { ownerUserId: 'default', connectionId: 'remote', nodeId, origin: 'https://maintenance.example' };
  assert.deepEqual(parseLifecycleEndpoints(undefined), []);
  assert.deepEqual(parseLifecycleEndpoints(JSON.stringify([valid])), [valid]);
  for (const origin of ['http://10.0.0.2:8793', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?secret=x', 'file:///tmp/file']) {
    assert.throws(() => parseLifecycleEndpoints(JSON.stringify([{ ...valid, origin }])), /Invalid AOD_HUB_LIFECYCLE_ENDPOINTS_JSON/);
  }
  for (const value of [[valid, valid], [{ ...valid, command: 'restart' }], [{ ...valid, nodeId: '' }], {}]) {
    assert.throws(() => parseLifecycleEndpoints(JSON.stringify(value)), /Invalid AOD_HUB_LIFECYCLE_ENDPOINTS_JSON/);
  }
});

test('Hub HTTP admits once, distinguishes acceptance, and reads original job after process reopen/config removal', async t => {
  const f = await fixture(t), app = f.http();
  const status = await app.request('/api/hub/v1/connections/remote/lifecycle/status');
  assert.equal(status.status, 200); assert.equal((await status.json()).configured, true);
  const path = '/api/hub/v1/connections/remote/lifecycle/commands/restart';
  const post = () => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'original' }) });
  const first = await post(); assert.equal(first.status, 202);
  const body = await first.json();
  assert.equal(body.command.state, 'accepted'); assert.equal(body.job.stage, 'prepare');
  assert.equal(body.job.actorId, undefined); assert.equal(body.job.fenceId, undefined);
  await post(); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await f.reopen();
  const recovered = await f.hub.lifecycleCommands.recover(target, 'original', allow);
  assert.equal(recovered?.command.id, body.command.id); assert.equal(recovered?.job?.id, body.job.id);
  assert.deepEqual(await f.hub.lifecycleCommands.status('default', 'remote', allow), { configured: false });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('lost POST reply recovers by GET; unavailable GET remains unknown and never resends', async t => {
  const f = await fixture(t); f.losePost(); f.rejectReads();
  const first = await f.hub.lifecycleCommands.send(target, 'unknown', allow);
  assert.equal(first.command.state, 'outcome_unknown'); assert.equal(first.observationUnavailable, true);
  await f.hub.lifecycleCommands.send(target, 'unknown', allow);
  await f.hub.lifecycleCommands.recover(target, 'unknown', allow);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.journal.unresolved(nodeId)?.stage, 'prepare');
});

test('recovery uses original endpoint/token after credential and connection replacement, never cross-owner', async t => {
  const f = await fixture(t);
  const first = await f.hub.lifecycleCommands.send(target, 'bound', allow);
  f.hub.upsertConnection({ id: 'remote', kind: 'remote', label: 'replacement', connectorUrl: 'https://other.invalid' });
  f.hub.updateMaintenanceCredential('remote', 'synthetic-replacement');
  const recovered = await f.hub.lifecycleCommands.recover(target, 'bound', allow);
  assert.equal(recovered?.job?.id, first.job?.id); assert.equal(recovered?.observationUnavailable, false);
  assert.equal(await f.hub.lifecycleCommands.recover({ ...target, userId: 'someone-else' }, 'bound', allow), undefined);
  await assert.rejects(f.hub.lifecycleCommands.send({ ...target, userId: 'someone-else' }, 'bound', allow));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('node mismatch cannot establish acceptance, revoked login cannot disclose status/receipt', async t => {
  const f = await fixture(t); f.wrongNode();
  const reply = await f.hub.lifecycleCommands.send(target, 'pin', allow);
  assert.equal(reply.command.state, 'outcome_unknown'); assert.equal(reply.job, undefined);
  await assert.rejects(f.hub.lifecycleCommands.status('default', 'remote', allow));
  let authorized = true;
  f.afterRequest(() => { authorized = false; });
  await assert.rejects(f.hub.lifecycleCommands.recover(target, 'pin', () => { if (!authorized) throw new Error('revoked'); }));
});

test('HTTP rejects arbitrary fields and never treats another account administrator as owner', async t => {
  const f = await fixture(t), app = f.http();
  const path = '/api/hub/v1/connections/remote/lifecycle/commands/restart';
  for (const body of [{ idempotencyKey: 'key', origin: f.origin }, { idempotencyKey: 'key', branch: 'main' }, { idempotencyKey: 'key', userId: 'default' }]) {
    assert.equal((await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await f.http('other-admin').request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"idempotencyKey":"key"}' })).status, 503);
  assert.equal(f.calls.length, 0);
});

test('client rejects wrong original job, overlarge body, protocol mismatch and redirection', async () => {
  const key = 'original', actorId = 'actor', job = { version: 1, nodeId, actorId, operation: 'restart', createdAt: 1, deadline: 1001,
    revision: 0, stage: 'prepare', id: `maintenance:${createHash('sha256').update(JSON.stringify([nodeId, actorId, key])).digest('hex')}` };
  for (const variant of ['wrong-key', 'oversize', 'protocol', 'redirect'] as const) {
    let calls = 0;
    const client = new LifecycleClient(nodeId, 'https://maintenance.example', 'synthetic', allow, request => {
      calls++; assert.equal(request.redirect, 'error'); assert.equal(request.headers.get(EXPECTED_NODE_HEADER), nodeId);
      assert.equal(new URL(request.url).pathname, `${MAINTENANCE_API}/commands/original`);
      return new Response(variant === 'oversize' ? ' '.repeat(32769) : JSON.stringify({ command: { ...job, ...(variant === 'wrong-key' ? { id: 'wrong' } : {}) } }), {
        status: variant === 'redirect' ? 302 : 200, headers: { [NODE_ID_HEADER]: nodeId, [MAINTENANCE_PROTOCOL_HEADER]: variant === 'protocol' ? '2' : '1' },
      });
    });
    await assert.rejects(client.command(key, 'restart')); assert.equal(calls, 1);
  }
});
