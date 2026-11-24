import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { emptyNativeDrawio, NATIVE_DRAWIO_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
const base = '/api/hub/v1/workspace/native-drawio';
test('native routes enforce identity, independent owner namespace, bounds and explicit editor configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-native-drawio-')), hub = new HubStore(join(root, 'db.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_DRAWIO_EDITOR_URL: 'https://editor.example/' });
  const routes = registerHubRoutes(app, { config, hubStore: hub, connectorClient: () => { throw Error('No Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: userId === bob.id } : undefined; } });
  const headers = { 'x-test-user': alice.id, 'content-type': 'application/json' }, value = { ...emptyNativeDrawio(), revision: 0, mutationId: randomUUID() };
  try {
    for (const url of [base, `${base}/config`, `${base}/default`]) assert.equal((await app.request(url)).status, 401);
    assert.deepEqual(await (await app.request(`${base}/config`, { headers })).json(), { editorUrl: 'https://editor.example/' });
    const saved = await app.request(`${base}/default`, { method: 'PUT', headers, body: JSON.stringify(value) });
    assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.equal(hub.drawings.get(alice.id, 'default').revision, 0, 'native never overwrites whiteboard');
    assert.equal((await (await app.request(`${base}/default`, { headers: { 'x-test-user': bob.id } })).json()).revision, 0);
    assert.equal((await app.request(`${base}/default`, { method: 'PUT', headers, body: JSON.stringify({ ...value, mutationId: randomUUID() }) })).status, 409);
    assert.equal((await app.request(`${base}/default`, { method: 'PUT', headers, body: JSON.stringify({ ...value, owner: bob.id }) })).status, 400);
    assert.equal((await app.request(`${base}/bad-id`, { headers })).status, 404);
    assert.equal((await app.request(`${base}/default`, { method: 'PUT', headers, body: ' '.repeat(NATIVE_DRAWIO_MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal((await app.request(`${base}/default`, { headers: { ...headers, authorization: 'Bearer aod_board_synthetic' } })).status, 401);
  } finally { routes?.close(); hub.close(); rmSync(root, { recursive: true, force: true }); }
});
test('native write rechecks revoked identity after request body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-native-revoked-')), hub = new HubStore(join(root, 'db.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'); let allowed = true;
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('No Connector'); }, normalizeError: () => 'Synthetic', principal: () => allowed ? { userId: alice.id, admin: false } : undefined });
  try {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { allowed = false; controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...emptyNativeDrawio(), revision: 0, mutationId: randomUUID() }))); controller.close(); } }, { highWaterMark: 0 });
    assert.equal((await app.request(`${base}/default`, { method: 'PUT', body, duplex: 'half' } as RequestInit)).status, 401);
    assert.equal(hub.nativeDrawio.get(alice.id, 'default').revision, 0);
  } finally { routes?.close(); hub.close(); rmSync(root, { recursive: true, force: true }); }
});
