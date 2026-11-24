import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { emptyDrawing, DRAWING_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';

test('drawing routes require identity, isolate even administrators and bound writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-drawings-')), hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('No Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: true } : undefined; } });
  const path = '/api/hub/v1/workspace/drawings/default';
  const request = (userId: string, body?: object) => app.request(path, { headers: { 'x-test-user': userId }, ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await app.request(path)).status, 401);
    const body = { ...emptyDrawing(), title: 'Private', revision: 0, mutationId: randomUUID(), strokes: [{ id: randomUUID(), color: '#60a5fa', width: 4, points: [[0, 0], [1600, 1000]] }] };
    assert.equal((await request(alice.id, body)).status, 200);
    assert.deepEqual((await (await request(alice.id)).json()).strokes, body.strokes);
    assert.equal((await request(alice.id, { ...body, strokes: [{ ...body.strokes[0], points: [[1601, 1000]] }] })).status, 400);
    assert.equal((await request(alice.id, { ...body, strokes: [{ ...body.strokes[0], points: Array.from({ length: 513 }, () => [0, 0]) }] })).status, 400);
    assert.equal((await request(alice.id, body)).status, 200);
    assert.equal((await request(alice.id, { ...body, mutationId: randomUUID() })).status, 409);
    assert.equal((await request(alice.id, { ...body, userId: bob.id })).status, 400);
    assert.equal((await request(alice.id, { ...body, title: 'x'.repeat(DRAWING_MAX_BODY_BYTES) })).status, 413);
    assert.equal((await (await request(bob.id)).json()).revision, 0);
    const catalog = path.replace('/default', '');
    assert.equal((await app.request(catalog)).status, 401);
    const response = await app.request(catalog, { headers: { 'x-test-user': alice.id } });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.text()).includes('nodes'), false);
    assert.deepEqual(await (await app.request(catalog, { headers: { 'x-test-user': bob.id } })).json(), { drawings: [] });
    assert.equal((await app.request(`${catalog}/invalid`, { headers: { 'x-test-user': alice.id } })).status, 404);
    assert.equal(hub.boards.get(alice.id, 'default').revision, 0);
    assert.equal(hub.notebooks.get(alice.id, 'default').revision, 0);
  } finally { routes?.close(); hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('drawing writes recheck identity after consuming request body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-drawings-revoked-')), hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'); let authorized = true, checks = 0;
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('No Connector'); }, normalizeError: () => 'Synthetic',
    principal: () => { checks++; return authorized ? { userId: alice.id, admin: false } : undefined; } });
  try {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { assert.ok(checks > 0); authorized = false;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...emptyDrawing(), revision: 0, mutationId: randomUUID() }))); controller.close(); } }, { highWaterMark: 0 });
    assert.equal((await app.request('/api/hub/v1/workspace/drawings/default', { method: 'PUT', body, duplex: 'half' } as RequestInit)).status, 401);
    assert.equal(hub.drawings.get(alice.id, 'default').revision, 0);
  } finally { routes?.close(); hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
