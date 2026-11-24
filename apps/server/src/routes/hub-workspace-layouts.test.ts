import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { validLayoutWrite } from '../hub/workspace-layouts.js';
import type { DatabaseSync } from 'node:sqlite';
const content = (active: string | null = null) => JSON.stringify({ id: 'current', name: 'Current', workspace: { version: 2, panes: [], floating: [], dock: null, active }, collapsedKeys: [] });
test('named blank canvas is supported by account layout synchronization', () => {
  assert.equal(validLayoutWrite({ revision: 0, content: JSON.stringify([{ ...JSON.parse(content()), id: 'blank', name: 'Blank' }]) }, 'saved'), true);
});
test('actual layout HTTP refuses damaged content, retains original row and recovers through unchanged CAS', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-layouts-recovery-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const db = (hub as unknown as { db: DatabaseSync }).db;
  const app = new Hono(), routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Forbidden'); }, normalizeError: () => 'Synthetic', principal: () => ({ userId: 'alice', admin: false }) });
  const path = '/api/hub/v1/workspace/layouts/current';
  try {
    db.prepare('INSERT INTO hub_workspace_layouts VALUES(?,?,?,?)').run('alice', 'current', 1, '{');
    const sync = t.mock.method(hub.layouts, 'get', () => { throw Error('main layout GET forbidden'); });
    const response = await app.request(path); assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /main layout|SELECT|sqlite/);
    sync.mock.restore(); assert.equal(hub.layouts.get('alice', 'current').content, '{');
    const saved = await app.request(path, { method: 'PUT', body: JSON.stringify({ revision: 1, content: content() }) });
    assert.equal(saved.status, 200); const value = await saved.json(); assert.equal(value.revision, 2);
    const noSync = t.mock.method(hub.layouts, 'get', () => { throw Error('main layout GET forbidden'); });
    const recovered = await app.request(path); assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), value);
    noSync.mock.restore();
    const conflict = await app.request(path, { method: 'PUT', body: JSON.stringify({ revision: 1, content: content('conflict') }) });
    assert.equal(conflict.status, 409); assert.equal(hub.layouts.get('alice', 'current').revision, 2);
  } finally { routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('layouts authenticate, isolate owners, bound writes, CAS and survive Hub restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-layouts-'));
  let hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Layouts must never contact Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: userId === 'admin' } : undefined; } });
  const path = '/api/hub/v1/workspace/layouts/current';
  const request = (userId: string, body?: object, endpoint = path) => app.request(endpoint, { headers: { 'x-test-user': userId }, ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await app.request(path)).status, 401);
    assert.deepEqual(await (await request('alice')).json(), { revision: 0, content: null });
    const body = { revision: 0, content: content() };
    const saved = await request('alice', body); assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.equal((await (await request('alice', body)).json()).revision, 1, 'lost response idempotent');
    assert.equal((await request('alice', { ...body, content: content('changed') })).status, 409);
    assert.equal((await request('alice', { ...body, userId: 'bob' })).status, 400);
    assert.equal((await request('alice', { ...body, content: 'x'.repeat(70_000) })).status, 400);
    assert.equal((await request('alice', { ...body, content: 'x'.repeat(300_000) })).status, 413);
    for (const user of ['bob', 'admin']) assert.equal((await (await request(user)).json()).content, null);
    assert.equal((await request('alice', { revision: 0, content: '[]' }, path.replace('current', 'saved'))).status, 200);
    assert.equal((await request('alice', undefined, path.replace('current', 'unknown'))).status, 404);
    routes?.close(); await hub.close(); hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
    assert.deepEqual({ ...hub.layouts.get('alice', 'current') }, { revision: 1, content: content() });
    assert.equal(hub.layouts.get('alice', 'saved').content, '[]');
  } finally { routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('layouts reject dangerous envelopes/deep data and recheck revocation after body read', async () => {
  assert.equal(validLayoutWrite({ revision: 0, content: null }, 'current'), false);
  assert.equal(validLayoutWrite({ revision: -1, content: content() }, 'current'), false);
  assert.equal(validLayoutWrite({ revision: 0, content: content().replace('"active":null', '"__proto__":{}') }, 'current'), false);
  const directory = mkdtempSync(join(tmpdir(), 'hub-layouts-revoke-')), hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  let authorized = true;
  const app = new Hono(), routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Forbidden'); }, normalizeError: () => 'Synthetic', principal: () => authorized ? { userId: 'alice', admin: false } : undefined });
  try {
    const body = new ReadableStream({ pull(controller) { authorized = false; controller.enqueue(new TextEncoder().encode(JSON.stringify({ revision: 0, content: content() }))); controller.close(); } });
    const response = await app.request('/api/hub/v1/workspace/layouts/current', { method: 'PUT', body, duplex: 'half' } as RequestInit);
    assert.equal(response.status, 401); assert.equal(hub.layouts.get('alice', 'current').revision, 0);
  } finally { routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
