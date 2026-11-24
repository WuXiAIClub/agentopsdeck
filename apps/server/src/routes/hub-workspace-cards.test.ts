import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { HubStore } from '../hub/hub-store.js';
import { registerHubRoutes } from './hub.js';

test('cards use authenticated current user without admin inheritance or Agent capability access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-cards-http-')), hub = new HubStore(join(dir, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Admin'), id = randomUUID();
  let current = alice.id;
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: dir, AOD_SERVER_ROLE: 'hub' }), hubStore: hub, normalizeError: () => 'Synthetic',
    principal: req => req.headers.has('x-fixture') ? { userId: current, admin: current === bob.id } : undefined, connectorClient: () => { throw Error('Must not use Connector'); } });
  const path = `/api/hub/v1/workspace/cards/${id}`, input = { title: 'Private', value: '99%', detail: 'confidential', progress: 99, tone: 'blue', revision: 0, mutationId: randomUUID() };
  const request = (method = 'GET', body?: unknown, target = path) => app.request(target, { method, headers: { 'x-fixture': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request(path, { headers: { authorization: 'Bearer wcap-not-a-user-key' } })).status, 401);
    assert.equal((await request('PUT', input)).status, 200); assert.equal((await request('PUT', input)).status, 200);
    const saved = await request(); assert.equal(saved.headers.get('cache-control'), 'no-store'); assert.equal((await saved.json()).revision, 1);
    current = bob.id; assert.equal((await request()).status, 404); assert.deepEqual(await (await request('GET', undefined, '/api/hub/v1/workspace/cards')).json(), { cards: [] });
    current = alice.id; assert.equal((await request('PUT', { ...input, mutationId: randomUUID() })).status, 409);
    assert.equal((await request('PUT', { ...input, owner: bob.id })).status, 400);
    assert.equal((await request('PUT', { ...input, detail: 'x'.repeat(33000) })).status, 413);
  } finally { routes?.close(); hub.close(); rmSync(dir, { recursive: true, force: true }); }
});
