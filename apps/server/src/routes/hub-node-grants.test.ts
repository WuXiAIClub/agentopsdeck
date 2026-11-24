import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { NodeGrantRecord } from '../hub/node-grants.js';
import { loadConfig } from '../config.js';
import { createConnectorClientResolver } from '../hub/connector-client.js';
import { registerHubRoutes } from './hub.js';
import type { SharedGrantPage } from '@agentopsdeck/shared';
import { encodeHubSessionId } from '../hub/session-id.js';

async function fixture(transport: 'local' | 'http' = 'local') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-grant-api-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
  const alice = store.createUser('Alice'), bob = store.createUser('Bob');
  const connection = { id: 'node', ownerUserId: alice.id, kind: 'remote' as const, label: 'Synthetic', connectorUrl: 'http://unused.invalid' };
  const nodeId = `node_${randomUUID()}`;
  store.upsertConnection(connection);
  store.pinConnectionNode('node', alice.id, store.connectionAuthority('node', alice.id)!, nodeId);
  store.upsertConnection({ ...connection, ownerUserId: bob.id });
  const app = new Hono(); let actor: HubPrincipal | undefined = { userId: alice.id, admin: false };
  const resolve = createConnectorClientResolver(store); let connectorCalls = 0;
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
    connectorClient: (...args: Parameters<typeof resolve>) => { connectorCalls++; return resolve(...args); }, normalizeError: () => 'Synthetic', principal: () => actor });
  const server = transport === 'http' ? serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://hub.example.invalid';
  const path = '/api/hub/v1/connections/node/grants';
  const request = (suffix = '', method = 'GET', body?: unknown) => {
    const init = { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    return server ? fetch(origin + path + suffix, init) : app.request(path + suffix, init);
  };
  const policy = { runtime: 'codex' as const, sessionKey: 'codex:synthetic/空 格', actions: ['messages:send' as const] };
  const input = () => ({ userId: bob.id, nodeVersion: store.connectionAuthority('node', alice.id)!, policy });
  const received = (query = '') => server ? fetch(origin + '/api/hub/v1/shared/grants' + query) : app.request('/api/hub/v1/shared/grants' + query);
  return { app, store, alice, bob, connection, nodeId, path, request, input, policy, received, connectorCalls: () => connectorCalls,
    actor: (next: HubPrincipal | undefined) => { actor = next; },
    close: async () => { routes?.close();
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      store.close(); rmSync(directory, { recursive: true, force: true });
    } };
}

for (const transport of ['local', 'http'] as const) test(`${transport}: recipient directory is account scoped and performs zero Connector I/O`, async () => {
  const f = await fixture(transport);
  try {
    const target = { ownerUserId: f.alice.id, connectionId: 'node', userId: f.bob.id };
    f.store.grants.create(target, { ...f.policy, actions: ['messages:read', 'messages:send'] });
    f.store.grants.create({ ...target, userId: f.alice.id }, { ...f.policy, sessionKey: 'codex:private-to-alice', actions: ['messages:read'] });
    f.actor({ userId: f.bob.id, admin: false });
    const response = await f.received(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json() as SharedGrantPage;
    assert.equal(page.grants.length, 1); const grant = page.grants[0]!;
    assert.equal(grant.ownerUserId, f.alice.id); assert.equal(grant.sessionId, encodeHubSessionId('node', f.policy.sessionKey));
    assert.equal(grant.availability, 'available');
    assert.deepEqual(Object.keys(grant).sort(), ['availability', 'connectionId', 'id', 'nodeVersion', 'ownerUserId', 'policy', 'sessionId', 'version']);
    assert.equal(JSON.stringify(page).includes('private-to-alice'), false);
    assert.equal(JSON.stringify(page).includes('unused.invalid'), false);
    assert.equal(f.store.executionIssuers.current(f.alice.id, 'node'), undefined);
    assert.equal(f.connectorCalls(), 0);
    f.actor({ userId: 'default', admin: true });
    const administrator = await (await f.received()).json() as SharedGrantPage;
    assert.equal(administrator.grants.length, 2);
    assert.ok(administrator.grants.every(item => item.ownerUserId === f.alice.id && item.policy.actions.includes('messages:read') && !item.policy.actions.includes('messages:send')));
    assert.equal(f.connectorCalls(), 0);
    f.actor({ userId: 'default', admin: false });
    assert.deepEqual(await (await f.received()).json(), { grants: [], nextCursor: null }, 'Default member keys do not inherit bootstrap administrator access');
    f.actor(undefined); assert.equal((await f.received()).status, 401);
  } finally { await f.close(); }
});

test('received directory keeps broad/agent/non-readable policies visible without inventing session links', async () => {
  const f = await fixture();
  try {
    const target = { ownerUserId: f.alice.id, connectionId: 'node', userId: f.bob.id };
    const broad = f.store.grants.create(target, { actions: ['messages:read'] });
    const agent = f.store.grants.create(target, { ...f.policy, agentId: 'main', actions: ['messages:read'] });
    const wrongRuntime = f.store.grants.create(target, { ...f.policy, runtime: 'openclaw', actions: ['messages:read'] });
    const exact = f.store.grants.create(target, f.policy);
    f.actor({ userId: f.bob.id, admin: false });
    let page = await (await f.received()).json() as SharedGrantPage;
    assert.equal(page.grants.length, 4);
    for (const id of [broad.id, agent.id, wrongRuntime.id]) assert.equal(page.grants.find(grant => grant.id === id)!.sessionId, null);
    assert.equal(page.grants.find(grant => grant.id === exact.id)!.sessionId, encodeHubSessionId('node', f.policy.sessionKey), 'independent broad read can authorize this exact target');
    f.store.grants.revoke(target, broad.id, 1);
    page = await (await f.received()).json() as SharedGrantPage;
    assert.equal(page.grants.length, 3);
    assert.equal(page.grants.find(grant => grant.id === exact.id)!.sessionId, null, 'send-only cannot read; agent assertion is not a verified mapping');
    assert.equal(f.connectorCalls(), 0);
  } finally { await f.close(); }
});

test('received directory shows stale generations/unverified/disabled nodes without navigation authority', async () => {
  const f = await fixture();
  try {
    const target = { ownerUserId: f.alice.id, connectionId: 'node', userId: f.bob.id };
    f.store.grants.create(target, { ...f.policy, actions: ['messages:read'] });
    f.store.grants.create({ ...target, ownerUserId: f.bob.id }, { ...f.policy, actions: ['messages:read'] });
    f.actor({ userId: f.bob.id, admin: false });
    f.store.upsertConnection({ ...f.connection, credentialToken: 'synthetic-rotation' });
    let page = await (await f.received()).json() as SharedGrantPage;
    assert.equal(page.grants.find(grant => grant.ownerUserId === f.alice.id)!.availability, 'reauthorization_required');
    assert.equal(page.grants.find(grant => grant.ownerUserId === f.bob.id)!.availability, 'unverified');
    assert.ok(page.grants.every(grant => grant.sessionId === null));
    f.store.upsertConnection({ ...f.connection, status: 'disabled' });
    page = await (await f.received()).json() as SharedGrantPage;
    assert.equal(page.grants.find(grant => grant.ownerUserId === f.alice.id)!.availability, 'disabled');
    assert.equal(f.connectorCalls(), 0);
  } finally { await f.close(); }
});

test('received directory uses bounded cursor pages across owners/nodes and rejects caller identity filters', async () => {
  const f = await fixture();
  try {
    const target = { ownerUserId: f.alice.id, connectionId: 'node', userId: f.bob.id };
    for (let i = 0; i < 103; i++) f.store.grants.create(target, f.policy);
    f.store.grants.create({ ...target, ownerUserId: f.bob.id }, f.policy);
    f.store.upsertConnection({ ...f.connection, id: 'second' });
    f.store.grants.create({ ...target, connectionId: 'second' }, f.policy);
    f.actor({ userId: f.bob.id, admin: false });
    const first = await (await f.received('?limit=100')).json() as SharedGrantPage;
    assert.equal(first.grants.length, 100); assert.equal(first.nextCursor, first.grants.at(-1)!.id);
    const last = await (await f.received('?limit=100&after=' + first.nextCursor)).json() as SharedGrantPage;
    assert.equal(last.grants.length, 5); assert.equal(last.nextCursor, null);
    const all = [...first.grants, ...last.grants]; assert.equal(new Set(all.map(grant => grant.id)).size, 105);
    assert.equal(new Set(all.map(grant => `${grant.ownerUserId}/${grant.connectionId}`)).size, 3);
    for (const query of ['?limit=0', '?limit=101', '?after=bad', '?ownerUserId=' + f.alice.id, '?userId=' + f.alice.id]) {
      assert.equal((await f.received(query)).status, 400);
    }
    assert.equal(f.connectorCalls(), 0);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: owner grant API is bounded CAS policy administration, not execution`, async () => {
  const f = await fixture(transport);
  try {
    const created = await f.request('', 'POST', f.input());
    assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store');
    const first = (await created.json() as { grant: NodeGrantRecord }).grant;
    assert.equal(first.userId, f.bob.id); assert.equal(first.version, 1);
    const target = { ownerUserId: f.alice.id, connectionId: 'node', userId: f.bob.id };
    const proof = f.store.grants.authorize(target, 'messages:send', f.policy, first.id)!;
    const lease = f.store.executionLeases.reserve(proof, f.nodeId, 'synthetic-issuer', ['messages:send']);
    assert.equal(f.store.executionIssuers.current(f.alice.id, 'node'), undefined, 'policy creation cannot provision execution credentials');
    const update = { version: 1, nodeVersion: first.nodeVersion, policy: { ...f.policy, actions: ['messages:read', 'messages:send'] } };
    const replaced = await f.request('/' + first.id, 'PUT', update);
    assert.equal(replaced.status, 200);
    assert.equal((await replaced.json() as { grant: NodeGrantRecord }).grant.version, 2);
    assert.equal(f.store.grants.revalidate(proof), false);
    assert.equal(f.store.executionLeases.get(lease.id)?.state, 'revoking', 'policy transaction revokes old leases');
    assert.equal((await f.request('/' + first.id, 'PUT', update)).status, 409);
    assert.equal((await f.request('/' + first.id, 'DELETE', { version: 1 })).status, 409);
    const revoked = await f.request('/' + first.id, 'DELETE', { version: 2 });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as { grant: NodeGrantRecord }).grant.revoked, true);
    assert.equal((await f.request('/' + first.id, 'PUT', { ...update, version: 3 })).status, 409);
    const page = await f.request();
    assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
    const result = await page.json() as { grants: NodeGrantRecord[]; nextCursor: string | null };
    assert.equal(result.grants.length, 1); assert.equal(result.nextCursor, null);
    assert.equal(result.grants[0]!.version, 3);
  } finally { await f.close(); }
});

test('grant API never uses admin or supplied owner/actor IDs to cross node ownership', async () => {
  const f = await fixture();
  try {
    const response = await f.request('', 'POST', f.input());
    const { grant } = await response.json() as { grant: NodeGrantRecord };
    for (const extra of [{ ownerUserId: 'default' }, { actorId: f.alice.id }, { token: 'synthetic' }]) {
      assert.equal((await f.request('', 'POST', { ...f.input(), ...extra })).status, 400);
    }
    f.actor({ userId: 'default', admin: true });
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.equal((await f.request(method === 'PUT' || method === 'DELETE' ? '/' + grant.id : '', method, method === 'GET' ? undefined : f.input())).status, 404);
    }
    f.actor({ userId: f.bob.id, admin: false });
    const page = await f.request(); assert.deepEqual((await page.json() as { grants: unknown[] }).grants, []);
    f.store.pinConnectionNode('node', f.bob.id, f.store.connectionAuthority('node', f.bob.id)!, `node_${randomUUID()}`);
    assert.equal((await f.request('/' + grant.id, 'PUT', { version: 1, nodeVersion: f.store.connectionAuthority('node', f.bob.id), policy: f.policy })).status, 404);
    assert.equal((await f.request('/' + grant.id, 'DELETE', { version: 1 })).status, 404);
    f.actor(undefined); assert.equal((await f.request()).status, 401);
  } finally { await f.close(); }
});

test('grant API rejects malformed/oversized policy and requires explicit current verified node generation', async () => {
  const f = await fixture();
  try {
    for (const policy of [null, [], {}, { actions: [] }, { actions: ['fake'] }, { actions: ['node:manage'], runtime: 'codex' },
      { ...f.policy, token: 'synthetic' }, { ...f.policy, sessionKey: 'x'.repeat(2049) }, { ...f.policy, runtime: 'bad' }]) {
      assert.equal((await f.request('', 'POST', { ...f.input(), policy })).status, 400);
    }
    assert.equal((await f.request('', 'POST', { ...f.input(), policy: { actions: ['x'.repeat(8192)] } })).status, 413);
    assert.equal((await f.request('', 'POST', { ...f.input(), userId: 'missing' })).status, 400);
    assert.equal((await f.request('', 'POST', { ...f.input(), nodeVersion: 1 })).status, 409);
    f.actor({ userId: f.bob.id, admin: false });
    assert.equal((await f.request('', 'POST', { ...f.input(), nodeVersion: f.store.connectionAuthority('node', f.bob.id) })).status, 409, 'unverified pin rejected');
    f.actor({ userId: f.alice.id, admin: false });
    const response = await f.request('', 'POST', f.input()), { grant } = await response.json() as { grant: NodeGrantRecord };
    for (const version of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await f.request('/' + grant.id, 'DELETE', { version })).status, 400);
    }
    f.store.upsertConnection({ ...f.connection, status: 'disabled' });
    assert.equal((await f.request('', 'POST', f.input())).status, 409);
    assert.equal((await f.request('/' + grant.id, 'DELETE', { version: 1 })).status, 200, 'disabled node still permits explicit revocation');
  } finally { await f.close(); }
});

test('grant directory pagination stays within owner/node and includes revocation tombstones', async () => {
  const f = await fixture();
  try {
    const target = { ownerUserId: f.alice.id, connectionId: 'node', userId: f.bob.id };
    for (let i = 0; i < 103; i++) f.store.grants.create(target, f.policy);
    f.store.grants.create({ ...target, ownerUserId: f.bob.id }, f.policy);
    const first = await (await f.request('?limit=100')).json() as { grants: NodeGrantRecord[]; nextCursor: string };
    assert.equal(first.grants.length, 100); assert.equal(first.nextCursor, first.grants.at(-1)!.id);
    f.store.grants.revoke(target, first.grants[0]!.id, 1);
    const second = await (await f.request('?limit=100&after=' + first.nextCursor)).json() as { grants: NodeGrantRecord[]; nextCursor: null };
    assert.equal(second.grants.length, 3); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.grants, ...second.grants].map(grant => grant.id)).size, 103);
    for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?limit=NaN', '?after=garbage']) assert.equal((await f.request(query)).status, 400);
  } finally { await f.close(); }
});

for (const change of ['logout', 'node'] as const) test(`grant API rechecks ${change} after a held request body`, async () => {
  const f = await fixture();
  let release!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const body = new ReadableStream<Uint8Array>({ start: controller => { release = controller; }, pull: () => { ready(); } }, { highWaterMark: 0 });
  try {
    const input = f.input();
    const response = f.app.fetch(new Request('http://hub.example.invalid' + f.path, { method: 'POST', body, duplex: 'half' } as RequestInit));
    await entered;
    if (change === 'logout') f.actor(undefined);
    else f.store.upsertConnection({ ...f.connection, credentialToken: 'synthetic-changed' });
    release.enqueue(Buffer.from(JSON.stringify(input))); release.close();
    assert.equal((await response).status, change === 'logout' ? 401 : 409);
    assert.deepEqual(f.store.grants.list({ ownerUserId: f.alice.id, connectionId: 'node' }).grants, []);
  } finally { await f.close(); }
});
