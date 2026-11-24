import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { BOARD_MAX_BODY_BYTES } from '@agentopsdeck/shared';

test('real Hub routes isolate boards, authenticate and reject stale/injected writes without Connector reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-boards-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Boards never contact Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: false } : undefined; } });
  const path = '/api/hub/v1/workspace/boards/default';
  const request = (userId: string, body?: object) => app.request(path, { headers: { 'x-test-user': userId }, ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await (await request(alice.id)).json()).revision, 0);
    const body = { title: 'Alice board', tasks: [], revision: 0, mutationId: randomUUID() };
    assert.equal((await request(alice.id, body)).status, 200);
    assert.equal((await request(alice.id, body)).status, 200);
    assert.equal((await request(alice.id, { ...body, mutationId: randomUUID() })).status, 409);
    assert.equal((await request(alice.id, { ...body, userId: bob.id })).status, 400);
    assert.equal((await request(alice.id, { ...body, title: 'x'.repeat(BOARD_MAX_BODY_BYTES) })).status, 413);
    assert.equal((await (await request(bob.id)).json()).revision, 0);
    assert.equal((await app.request(path.replace('default', 'invalid'), { headers: { 'x-test-user': alice.id } })).status, 404);
    assert.equal(hub.notebooks.get(alice.id, 'default').revision, 0, 'does not reuse private notebook storage');
    const escaped = { ...body, revision: 1, mutationId: randomUUID(), tasks: Array.from({ length: 200 }, () => ({ id: randomUUID(), title: 'Task', detail: '\u0000'.repeat(310), status: 'todo' })) };
    assert.equal((await request(alice.id, escaped)).status, 200, 'legal content still fits when JSON-escaped');
    const secondId = randomUUID();
    hub.boards.save(alice.id, secondId, { ...body, title: 'Second board', mutationId: randomUUID(), tasks: [{ id: randomUUID(), title: 'Private task', detail: 'Never in summary', status: 'done' }] });
    const catalog = '/api/hub/v1/workspace/boards';
    for (const endpoint of [catalog, `${path}/summary`]) {
      assert.equal((await app.request(endpoint)).status, 401);
      const response = await app.request(endpoint, { headers: { 'x-test-user': alice.id } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const raw = await response.text(); assert.ok(!raw.includes('detail')); assert.ok(!raw.includes('tasks'));
    }
    const list = await (await app.request(catalog, { headers: { 'x-test-user': alice.id } })).json();
    assert.equal(list.boards.length, 2);
    assert.equal(list.boards.find((board: { resourceId: string }) => board.resourceId === 'default').counts.todo, 200);
    const otherList = await (await app.request(catalog, { headers: { 'x-test-user': bob.id } })).json();
    assert.equal(otherList.boards.length, 1); assert.equal(otherList.boards[0].revision, 0);
    assert.equal((await (await app.request(`${catalog}/${secondId}/summary`, { headers: { 'x-test-user': bob.id } })).json()).revision, 0);
    assert.equal((await app.request(`${catalog}/bad/summary`, { headers: { 'x-test-user': alice.id } })).status, 404);
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('revoking identity while consuming a board write prevents mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-boards-revoked-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice');
  let authorized = true, checks = 0;
  const app = new Hono();
  const routes = registerHubRoutes(app, {
    config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('No Connector access'); }, normalizeError: () => 'Synthetic',
    principal: () => { checks++; return authorized ? { userId: alice.id, admin: false } : undefined; },
  });
  try {
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      assert.ok(checks > 0, 'initial authorization must precede body consumption');
      authorized = false;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ title: 'Revoked write', tasks: [], revision: 0, mutationId: randomUUID() })));
      controller.close();
    } }, { highWaterMark: 0 });
    const response = await app.request('/api/hub/v1/workspace/boards/default', { method: 'PUT', body, duplex: 'half' } as RequestInit);
    assert.equal(response.status, 401);
    assert.equal(hub.boards.get(alice.id, 'default').revision, 0);
    assert.ok(checks >= 2);
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
