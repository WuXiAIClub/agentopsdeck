import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { registerHubWebsiteRoutes } from './hub-websites.js';

test('website Hub route is exact-owner-only, rejects arbitrary parameters and rechecks identity/authority after read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-websites-')), hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Admin');
  const connection = hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: alice.id });
  let calls = 0, allowed = true, afterRead = () => {}, bad = false, remoteStatus = 200;
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub, normalizeError: () => 'Synthetic',
    principal: req => allowed && req.headers.has('x-test-user') ? { userId: req.headers.get('x-test-user')!, admin: req.headers.get('x-test-user') === bob.id } : undefined,
    connectorClient: (id, maintenance, owner) => {
      assert.equal(id, connection.id); assert.equal(maintenance, false); assert.equal(owner, alice.id);
      return new ConnectorClient('http://connector', 'test', async request => {
        calls++; afterRead(); const path = new URL(request.url).pathname;
        if (remoteStatus !== 200) return new Response('{}', { status: remoteStatus, headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
        return new Response(JSON.stringify(path.endsWith('/catalog') ? { services: [{ id: 'dev', label: 'Dev', url: 'never-forward' }] } : { serviceId: bad ? 'other' : 'dev', label: 'Dev', format: 'text', content: 'Hello', fetchedAt: Date.now(), secret: 'never-forward' }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      });
    } });
  const base = `/api/hub/v1/connections/${connection.id}/websites`, headers = { 'x-test-user': alice.id };
  try {
    assert.equal((await app.request(`${base}/catalog`)).status, 401);
    assert.equal((await app.request(`${base}/catalog`, { headers: { 'x-test-user': bob.id } })).status, 404);
    assert.equal((await app.request(`${base}/dev/snapshot?url=http://private`, { headers })).status, 400); assert.equal(calls, 0);
    const catalog = await app.request(`${base}/catalog`, { headers }); assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), { services: [{ id: 'dev', label: 'Dev' }] });
    const snapshot = await app.request(`${base}/dev/snapshot`, { headers }); assert.equal(snapshot.headers.get('cache-control'), 'no-store'); assert.ok(!(await snapshot.text()).includes('never-forward'));
    bad = true; assert.equal((await app.request(`${base}/dev/snapshot`, { headers })).status, 502); bad = false;
    remoteStatus = 401; assert.equal((await app.request(`${base}/dev/snapshot`, { headers })).status, 403); remoteStatus = 200;
    afterRead = () => { allowed = false; }; assert.equal((await app.request(`${base}/dev/snapshot`, { headers })).status, 401); allowed = true;
    afterRead = () => { hub.upsertConnection({ ...connection, status: 'disabled' }); };
    assert.equal((await app.request(`${base}/dev/snapshot`, { headers })).status, 403);
  } finally { routes?.close(); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('website Hub route close retains aborted physical dispatch and source cancel ACK', async () => {
  const hub = new HubStore(':memory:', 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice');
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: alice.id });
  let calls = 0, cancellations = 0, started!: () => void, dispatch!: (response: Response) => void, releaseCancel!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<Response>(resolve => { dispatch = resolve; });
  const routes = registerHubWebsiteRoutes(app, {
    hubStore: hub,
    principal: () => ({ userId: alice.id, admin: false }),
    connectorClient: () => new ConnectorClient('http://connector', 'test', () => { calls++; started(); return held; }),
  });
  try {
    const controller = new AbortController();
    const pending = app.request('/api/hub/v1/connections/dev/websites/catalog', { signal: controller.signal });
    await entered;
    controller.abort();
    let settled = false;
    void pending.then(() => { settled = true; });
    let closed = false;
    const closing = routes.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(closed, false);
    dispatch(new Response(new ReadableStream({
      cancel() { cancellations++; return new Promise<void>(resolve => { releaseCancel = resolve; }); },
    }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }));
    for (let i = 0; cancellations === 0 && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancellations, 1);
    assert.equal(settled, false);
    assert.equal(closed, false);
    releaseCancel();
    await closing;
    assert.ok([499, 503].includes((await pending).status));
    assert.equal(calls, 1);
  } finally { await hub.close(); }
});
