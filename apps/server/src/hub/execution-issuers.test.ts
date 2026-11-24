import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { HubExecutionIssuers } from './execution-issuers.js';
import { HubExecutionSync } from './execution-sync.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { registerHubRoutes } from '../routes/hub.js';
import { createConnectorClientResolver } from './connector-client.js';
import { loadConfig } from '../config.js';
import type { HubPrincipal } from './identity.js';
import { createApplication } from '../application.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HubExecutionWorker } from './execution-worker.js';

async function fixture(transport: 'local' | 'http' = 'local') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-issuers-')), file = join(directory, 'hub.sqlite');
  const hub = new HubStore(file, 'synthetic-vault'), db = new DatabaseSync(file), remoteDb = new DatabaseSync(':memory:');
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  const createIssuer = (hubId = hub.identities.hubId) => tokens.create({ label: 'Synthetic issuer',
    delegationHubId: hubId, scopes: ['execution:delegate', 'messages:send'] });
  const first = createIssuer(), second = createIssuer(), nodeId = `node_${randomUUID()}`;
  const grants = new ExecutionGrants(remoteDb, id => !!tokens.delegationHubId(id));
  const app = new Hono(); registerExecutionGrantRoutes(app, { nodeId, tokens, grants });
  let afterProbe = () => {}, dropRevocation = false, calls = 0;
  const dispatch = async (request: Request) => {
    calls++; const response = await app.fetch(request);
    if (request.url.endsWith('/issuer')) afterProbe();
    if (request.url.endsWith('/revoke') && dropRevocation) { await response.body?.cancel(); throw new Error('Synthetic lost ACK'); }
    return response;
  };
  const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.example.invalid';
  const connection = { id: 'node', kind: transport === 'local' ? 'local' as const : 'remote' as const, label: 'Synthetic', connectorUrl: origin };
  hub.upsertConnection(connection);
  hub.pinConnectionNode('node', 'default', hub.connectionAuthority('node')!, nodeId);
  const local = transport === 'local' ? { connectionId: 'node', dispatch } : undefined;
  const configure = (token = first.token, authorize = () => {}) => hub.executionIssuers.configure('default', 'node', token, authorize, local);
  const target = { ownerUserId: 'default', connectionId: 'node', userId: hub.createUser('Member').id };
  const resource = { runtime: 'codex' as const, sessionKey: 'codex:synthetic/空 格' };
  const policy = { ...resource, actions: ['messages:send'] as const };
  const createProof = () => {
    const grant = hub.grants.create(target, { ...policy, actions: [...policy.actions] });
    return hub.grants.authorize(target, 'messages:send', resource, grant.id)!;
  };
  const sync = new HubExecutionSync(hub.executionLeases, hub.identities.hubId, lease => hub.executionIssuers.clientFor(lease, local));
  return { directory, hub, db, file, tokens, nodeId, createIssuer, first, second, grants, configure, createProof, sync, local, connection,
    calls: () => calls, afterProbe: (callback: () => void) => { afterProbe = callback; }, drop: (value: boolean) => { dropRevocation = value; },
    close: async () => {
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      remoteDb.close(); db.close(); hub.close(); rmSync(directory, { recursive: true, force: true });
    } };
}

for (const transport of ['local', 'http'] as const) test(`${transport}: issuer rotation retains exact encrypted old credential for durable revocation`, async () => {
  const f = await fixture(transport);
  try {
    assert.equal(f.hub.executionIssuers.current('default', 'node'), undefined);
    const before = f.hub.connectionAuthority('node')!;
    const configured = await f.configure();
    assert.deepEqual(configured, { issuerId: f.first.record.id, nodeId: f.nodeId, version: before + 1 });
    const proof = f.createProof(), first = await f.sync.acquire(proof, f.nodeId, f.first.record.id, ['messages:send']);
    assert.equal(first.state, 'active');
    const oldClient = f.hub.executionIssuers.clientFor(first, f.local);
    await f.configure(f.second.token);
    assert.equal(f.hub.executionLeases.get(first.id)?.state, 'revoking');
    assert.equal(f.hub.grants.revalidate(proof), false, 'issuer rotation requires explicit policy reauthorization');
    await assert.rejects(oldClient.json('/execution-grants', { method: 'POST', body: '{}' }), /retired/);
    for (const path of ['/sessions/state', '/execution-grants/issuer', '/execution-grants/revoke?x=1', '/sessions/x/messages']) {
      await assert.rejects(oldClient.json(path, { method: 'POST', body: '{}' }), /restricted/);
    }
    if (transport === 'local') {
      f.drop(true); assert.equal((await f.sync.reconcileRevocations()).acknowledged, 0);
      assert.equal(f.hub.executionLeases.get(first.id)?.state, 'revoking'); f.drop(false);
    }
    assert.equal((await f.sync.reconcileRevocations()).acknowledged, 1);
    assert.equal(f.grants.authorize(first.ref!, f.first.record.id, proof.resource as any, 'messages:send'), false);
    const next = await f.sync.acquire(f.createProof(), f.nodeId, f.second.record.id, ['messages:send']);
    assert.equal(next.state, 'active');
    assert.equal(f.hub.getCredentialToken('node'), undefined, 'issuer never becomes ordinary owner credential');
    const encrypted = f.db.prepare('SELECT * FROM env_credentials').all();
    assert.equal(encrypted.length, 2);
    assert.equal(JSON.stringify(encrypted).includes(f.first.token), false);
    assert.equal(JSON.stringify(encrypted).includes(f.second.token), false);
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(readFileSync(f.file).includes(Buffer.from(f.first.token)), false);
    const reopened = new HubStore(f.file, 'synthetic-vault');
    try {
      assert.equal(reopened.executionIssuers.current('default', 'node')?.issuerId, f.second.record.id);
      assert.equal(reopened.executionIssuers.disable('default', 'node'), true);
      assert.equal(reopened.executionIssuers.disable('default', 'node'), false);
      assert.equal(reopened.executionLeases.get(next.id)?.state, 'revoking');
      const recovery = new HubExecutionSync(reopened.executionLeases, reopened.identities.hubId,
        lease => reopened.executionIssuers.clientFor(lease, f.local));
      assert.equal((await recovery.reconcileRevocations()).acknowledged, 1);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('issuer configuration rejects unverified/wrong owner/Hub/token and races without overwriting active credentials', async () => {
  const f = await fixture();
  try {
    await f.configure(); const old = f.hub.executionIssuers.current('default', 'node');
    const count = () => (f.db.prepare('SELECT count(*) AS n FROM env_credentials').get() as { n: number }).n;
    await assert.rejects(f.configure(f.createIssuer('another-hub').token), /binding mismatch/);
    await assert.rejects(f.configure(f.tokens.create({ label: 'ordinary' }).token), { status: 403 });
    for (const token of ['', 'has whitespace', 'x'.repeat(4097)]) await assert.rejects(f.configure(token), /Invalid/);
    await assert.rejects(f.hub.executionIssuers.configure('another-user', 'node', f.first.token, () => {}, f.local), /Verified/);
    f.hub.upsertConnection({ ...f.connection, id: 'unverified' });
    await assert.rejects(f.hub.executionIssuers.configure('default', 'unverified', f.first.token, () => {}, f.local), /Verified/);
    assert.deepEqual(f.hub.executionIssuers.current('default', 'node'), old); assert.equal(count(), 1);
    let authorized = true;
    f.afterProbe(() => { authorized = false; });
    await assert.rejects(f.configure(f.second.token, () => { if (!authorized) throw new Error('synthetic login revoked'); }), /login revoked/);
    assert.deepEqual(f.hub.executionIssuers.current('default', 'node'), old); assert.equal(count(), 1);
    f.afterProbe(() => { f.hub.upsertConnection({ ...f.connection, status: 'disabled' }); });
    await assert.rejects(f.configure(f.second.token), /authority changed/);
    assert.equal(count(), 1); assert.equal(f.hub.executionIssuers.current('default', 'node'), undefined);
  } finally { await f.close(); }
});

test('issuer install rollback preserves lease authority; capacity is bounded including retired credentials', async () => {
  const f = await fixture();
  try {
    await f.configure(); const old = f.hub.executionIssuers.current('default', 'node');
    const lease = await f.sync.acquire(f.createProof(), f.nodeId, f.first.record.id, ['messages:send']);
    f.db.exec(`CREATE TRIGGER synthetic_vault_failure BEFORE INSERT ON env_credentials BEGIN SELECT RAISE(ABORT, 'synthetic vault failure'); END;`);
    await assert.rejects(f.configure(f.second.token), /synthetic vault failure/);
    assert.deepEqual(f.hub.executionIssuers.current('default', 'node'), old);
    assert.equal(f.hub.executionLeases.get(lease.id)?.state, 'active');
    f.db.exec('DROP TRIGGER synthetic_vault_failure');
    const bounded = new HubExecutionIssuers(f.db, f.hub.identities.hubId, {
      read: () => { throw new Error('unexpected read'); }, write: () => { throw new Error('unexpected write'); },
    }, 1);
    await assert.rejects(bounded.configure('default', 'node', f.second.token, () => {}, f.local), /capacity/);
    assert.deepEqual(f.hub.executionIssuers.current('default', 'node'), old);
    assert.equal(f.hub.executionLeases.get(lease.id)?.state, 'active');
  } finally { await f.close(); }
});

test('retired issuer uses captured origin and pin after connection deletion; never falls back to a replacement', async () => {
  const f = await fixture('http');
  try {
    await f.configure();
    const lease = await f.sync.acquire(f.createProof(), f.nodeId, f.first.record.id, ['messages:send']);
    f.hub.deleteConnection('node');
    assert.equal(f.hub.executionIssuers.current('default', 'node'), undefined);
    assert.equal((await f.sync.reconcileRevocations()).acknowledged, 1);
    assert.throws(() => f.hub.executionIssuers.clientFor({ ...lease, issuerId: f.second.record.id }), /unavailable/);
    assert.throws(() => f.hub.executionIssuers.clientFor({ ...lease, nodeId: `node_${randomUUID()}` }), /unavailable/);
  } finally { await f.close(); }
});

test('Hub issuer routes enforce owner/login boundaries and never return credentials', async () => {
  const f = await fixture(), app = new Hono();
  let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
  const config = loadConfig({ HOME: f.directory, AOD_SERVER_ROLE: 'hub' });
  const routes = registerHubRoutes(app, { config, hubStore: f.hub, connectorClient: createConnectorClientResolver(f.hub),
    normalizeError: () => 'Synthetic', principal: () => actor, ...(f.local ? { localIssuerTransport: f.local } : {}) });
  const path = '/api/hub/v1/connections/node/execution-issuer';
  const put = (body: unknown) => app.request(path, { method: 'PUT', body: JSON.stringify(body) });
  try {
    const before = await app.request(path);
    assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await before.json(), { hubId: f.hub.identities.hubId, issuer: null, localSetupAllowed: false });
    for (const body of [null, [], { token: 1 }, { token: f.first.token, ownerUserId: 'default' }]) {
      assert.equal((await put(body)).status, 400);
    }
    assert.equal((await put({ token: 'x'.repeat(8193) })).status, 413);
    actor = { userId: f.hub.createUser('Other').id, admin: false };
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await app.request(path, { method,
      ...(method === 'PUT' ? { body: JSON.stringify({ token: f.first.token }) } : {}) })).status, 404);
    actor = { userId: 'default', admin: true };
    const response = await put({ token: f.first.token });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text(); assert.equal(body.includes(f.first.token), false); assert.equal(body.includes(f.first.record.id), true);
    const active = f.hub.executionIssuers.current('default', 'node');
    f.afterProbe(() => { actor = undefined; });
    const rejected = await put({ token: f.second.token });
    assert.equal(rejected.status, 401); assert.deepEqual(f.hub.executionIssuers.current('default', 'node'), active);
    actor = { userId: 'default', admin: true };
    const deleted = await app.request(path, { method: 'DELETE' });
    assert.equal(deleted.status, 200); assert.equal(f.hub.executionIssuers.current('default', 'node'), undefined);
    assert.equal((await app.request(path, { method: 'DELETE' })).status, 200);
  } finally { routes?.close(); await f.close(); }
});

test('concurrent issuer setup is bounded per node and releases its slot after failure', async () => {
  const f = await fixture();
  let unblock!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const local = { connectionId: 'node', dispatch: async (request: Request) => { started(); await gate; return f.local!.dispatch(request); } };
  try {
    const first = f.hub.executionIssuers.configure('default', 'node', f.first.token, () => {}, local);
    await ready;
    await assert.rejects(f.configure(f.second.token), /busy/);
    unblock(); await first;
    await f.configure(f.second.token);
    assert.equal(f.hub.executionIssuers.current('default', 'node')?.issuerId, f.second.record.id);
  } finally { unblock(); await f.close(); }
});

test('Hub-only application startup reconciles durable revocations without any browser request', async () => {
  const f = await fixture('http');
  let application: ReturnType<typeof createApplication> | undefined;
  try {
    await f.configure();
    const lease = await f.sync.acquire(f.createProof(), f.nodeId, f.first.record.id, ['messages:send']);
    f.hub.executionIssuers.disable('default', 'node');
    assert.equal(f.hub.executionLeases.get(lease.id)?.state, 'revoking');
    const before = f.calls();
    const config = loadConfig({ HOME: f.directory, AOD_SERVER_ROLE: 'hub',
      AOD_HUB_DATABASE_FILE: f.file, AOD_HUB_VAULT_SECRET: 'synthetic-vault' });
    application = createApplication(config, () => { throw new Error('Hub must not instantiate an Agent runtime'); });
    for (let attempt = 0; attempt < 100 && f.hub.executionLeases.get(lease.id)?.state !== 'revoked'; attempt++) await delay(10);
    assert.equal(f.hub.executionLeases.get(lease.id)?.state, 'revoked');
    assert.equal(f.calls(), before + 1, 'only one revoke, no session GET or Agent command');
    assert.equal(f.grants.authorize(lease.ref!, f.first.record.id, lease.proof.resource as any, 'messages:send'), false);
  } finally { await application?.close(); await f.close(); }
});

test('idle worker never renews unused leases or performs network polling', async () => {
  const f = await fixture(); let worker: HubExecutionWorker | undefined;
  try {
    await f.configure();
    const lease = await f.sync.acquire(f.createProof(), f.nodeId, f.first.record.id, ['messages:send']);
    const calls = f.calls();
    worker = new HubExecutionWorker(f.sync);
    for (let index = 0; index < 5; index++) await worker.poll();
    assert.equal(f.calls(), calls); assert.equal(f.hub.executionLeases.get(lease.id)?.state, 'active');
  } finally { await worker?.close(); await f.close(); }
});

test('issuer setup shutdown aborts a held verification body before closing SQLite', async () => {
  const f = await fixture();
  const handle = new HubStore(f.file, 'synthetic-vault');
  let entered!: () => void, cancelled = false, closed = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const local = { connectionId: 'node', dispatch: () => {
    entered(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'x-agentopsdeck-node-id': f.nodeId, 'content-type': 'application/json' } });
  } };
  try {
    const pending = handle.executionIssuers.configure('default', 'node', f.first.token, () => {}, local);
    const rejected = assert.rejects(pending, /closed/);
    await ready;
    handle.close(); closed = true;
    await rejected;
    assert.equal(cancelled, true); assert.equal(f.hub.executionIssuers.current('default', 'node'), undefined);
    await assert.rejects(handle.executionIssuers.configure('default', 'node', f.first.token, () => {}, local), /closed/);
  } finally { if (!closed) handle.close(); await f.close(); }
});
