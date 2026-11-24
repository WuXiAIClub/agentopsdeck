import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '@agentopsdeck/shared';
import { randomUUID } from 'node:crypto';
import { notebookHash } from '../hub/notebook-operations.js';

test('move/search routes enforce owner, versions, immutable UUID and bounded payloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-notebook-moves-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('No Connector writes'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: false } : undefined; } });
  const path = '/api/hub/v1/notebooks/default';
  const request = (suffix: string, body?: object, user = alice.id) => app.request(path + suffix, { method: body ? 'POST' : 'GET', headers: { 'x-test-user': user }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const hot = await (await request('')).json();
    hub.notebooks.save(alice.id, { ...hot, text: 'new old', revision: 0 });
    const input = { requestId: randomUUID(), hotRevision: 1, coldRevision: 0, direction: 'archive', ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
    assert.equal((await app.request(path + '/moves', { method: 'POST', body: JSON.stringify(input) })).status, 401);
    const result = await request('/moves', input); assert.equal(result.status, 200);
    const receipt = await result.json();
    assert.deepEqual(await (await request('/moves', input)).json(), receipt);
    assert.equal((await request('/moves', { ...input, direction: 'restore' })).status, 409);
    assert.equal((await request('/moves', { ...input, userId: bob.id })).status, 400);
    assert.equal((await request('/moves/' + input.requestId, undefined, bob.id)).status, 404);
    assert.deepEqual(await (await request('/moves/' + input.requestId)).json(), receipt);
    assert.deepEqual((await (await request('/search?q=old')).json()).results, []);
    const found = await request('/search?q=old&archive=1');
    assert.equal(found.headers.get('cache-control'), 'no-store');
    assert.equal((await found.json()).results[0].area, 'cold');
    assert.equal((await request('/search?q=old&archive=true')).status, 400);
    assert.deepEqual((await (await request('/search?q=old&archive=1', undefined, bob.id)).json()).results, []);
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('50k hot and 100k cold HTTP budgets accept Unicode and escaped JSON without projecting archives', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-cold-notebooks-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Cold notes never contact a Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: false } : undefined; } });
  const path = '/api/hub/v1/notebooks/default', archive = `${path}/archive`;
  const get = (url: string, user = alice.id) => app.request(url, { headers: { 'x-test-user': user } });
  const put = (url: string, value: object, escaped = false) => app.request(url, { method: 'PUT', headers: { 'x-test-user': alice.id },
    body: escaped ? JSON.stringify(value).replaceAll('文', '\\u6587') : JSON.stringify(value) });
  try {
    assert.equal((await app.request(archive)).status, 401);
    const doc = await (await get(path)).json(), cold = await (await get(archive)).json();
    const hotValue = { resourceId: doc.resourceId, revision: 0, text: '文'.repeat(50_000) };
    const coldValue = { resourceId: cold.resourceId, revision: 0, text: '文'.repeat(100_000) };
    assert.equal((await put(path, hotValue)).status, 200);
    assert.equal((await put(archive, coldValue, true)).status, 200, '600k escaped text is within transport cap');
    assert.equal((await put(archive, coldValue)).status, 409);
    assert.equal((await put(archive, { ...coldValue, revision: 1, text: coldValue.text + 'x' })).status, 400);
    assert.equal((await put(path, { ...hotValue, revision: 1, text: hotValue.text + 'x' })).status, 400);
    assert.equal((await put(archive, { ...coldValue, resourceId: 'foreign' })).status, 409);
    assert.equal((await put(archive, { ...coldValue, userId: bob.id })).status, 400);
    assert.equal((await get(archive)).headers.get('cache-control'), 'no-store');
    assert.equal((await (await get(archive, bob.id)).json()).text, '');
    assert.equal((await (await get(path)).json()).text, hotValue.text);
    assert.equal((await (await get('/api/hub/v1/notebook')).json()).text, hotValue.text);
    assert.equal((await (await get('/api/hub/v1/notebooks')).json()).items.length, 1);
    assert.equal((await put(archive, { ...coldValue, revision: 1, text: '' })).status, 200);
    assert.equal((await put(archive, coldValue)).status, 409);
    assert.equal((await get('/api/hub/v1/notebooks/invalid/archive')).status, 404);
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('formatted notebooks fence legacy writes across global, named, owned and shared routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-styled-notebooks-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice');
  hub.upsertConnection({ id: 'test', ownerUserId: 'default', kind: 'local', label: 'Fixture', connectorUrl: 'local://aod-connector', credentialToken: 'synthetic' });
  const nodeId = 'node_11111111-1111-4111-8111-111111111111';
  hub.pinConnectionNode('test', 'default', hub.connectionAuthority('test', 'default')!, nodeId);
  hub.grants.create({ ownerUserId: 'default', connectionId: 'test', userId: alice.id }, { runtime: 'codex', sessionKey: 'codex:one', actions: ['messages:read'] });
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Notes never contact a Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: userId === 'default' } : undefined; } });
  const id = encodeURIComponent(encodeHubSessionId('test', 'codex:one'));
  const paths = ['notebook', 'notebooks/default', 'notebooks/00000000-0000-4000-8000-000000000001', `sessions/${id}/notebook`, `shared/default/sessions/${id}/notebook`];
  try {
    for (const path of paths) {
      const userId = path.startsWith('shared/') ? alice.id : 'default';
      const read = () => app.request(`/api/hub/v1/${path}`, { headers: { 'x-test-user': userId } });
      const initial = await (await read()).json();
      const put = (text: string, revision: number, supported: boolean | 'v2' = false) => app.request(`/api/hub/v1/${path}`, { method: 'PUT',
        headers: { 'x-test-user': userId, ...(supported ? { 'x-agentopsdeck-notebook-format': supported === 'v2' ? 'styled-markdown-v2' : 'styled-markdown-v1' } : {}) },
        body: JSON.stringify({ resourceId: initial.resourceId, revision, text }) });
      assert.equal((await put('Plain legacy note', initial.revision)).status, 200);
      const styled = '<span data-agentopsdeck-note="v1;135;#1d4ed8;#fef08a">**Ship**</span>';
      assert.equal((await put(styled, initial.revision + 1)).status, 409, 'legacy client cannot introduce format it cannot preserve');
      assert.equal((await put(styled, initial.revision + 1, true)).status, 200);
      assert.equal((await put('Silently flattened', initial.revision + 2)).status, 409, path);
      assert.equal((await put('', initial.revision + 2)).status, 409, 'legacy clear also needs explicit refresh');
      assert.equal((await (await read()).json()).text, styled);
      assert.equal((await put('Stale write', initial.revision + 1, true)).status, 409, 'format support does not bypass CAS');
      assert.equal((await put('Explicitly removed formatting', initial.revision + 2, true)).status, 200);
      assert.equal((await put('Plain notes remain compatible', initial.revision + 3)).status, 200);
      const font = '<span data-agentopsdeck-note="v2;135;#1d4ed8;-;serif">**Font**</span>';
      assert.equal((await put(font, initial.revision + 4, true)).status, 409, 'v1 cannot introduce font markers');
      assert.equal((await put(font, initial.revision + 4, 'v2')).status, 200);
      assert.equal((await put('Silently flattened font', initial.revision + 5, true)).status, 409, 'v1 cannot flatten existing fonts');
      assert.equal((await put('', initial.revision + 5)).status, 409, 'legacy clear cannot discard fonts');
      assert.equal((await (await read()).json()).text, font);
      assert.equal((await put('Explicitly removed font', initial.revision + 5, 'v2')).status, 200);
    }
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('multiple Hub notes preserve the singleton, paginate, isolate users and validate layout CAS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-multiple-notebooks-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Notes never contact a Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: userId === 'default' } : undefined; } });
  const request = (path: string, userId = alice.id, body?: object) => app.request(`/api/hub/v1/${path}`, { headers: { 'x-test-user': userId }, ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await app.request('/api/hub/v1/notebooks')).status, 401);
    const old = await (await request('notebook')).json();
    assert.equal((await request('notebook', alice.id, { resourceId: old.resourceId, revision: old.revision, text: 'existing singleton' })).status, 200);
    assert.equal((await (await request('notebooks/default')).json()).text, 'existing singleton');
    const id = '00000000-0000-4000-8000-000000000001';
    const doc = await (await request(`notebooks/${id}/layout`)).json();
    const body = { resourceId: doc.resourceId, revision: doc.revision, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Tips', hidden: false }) };
    assert.equal((await request(`notebooks/${id}/layout`, alice.id, body)).status, 200);
    assert.equal((await request(`notebooks/${id}/layout`, alice.id, body)).status, 409);
    assert.equal((await request(`notebooks/${id}/layout`, alice.id, { ...body, revision: 1, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, opacity: 0 }) })).status, 400);
    assert.equal((await request(`notebooks/${id}/layout`, alice.id, { ...body, resourceId: old.resourceId })).status, 409);
    const smaller = { ...body, revision: 1, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, width: 208, height: 160 }) };
    assert.equal((await request(`notebooks/${id}/layout`, alice.id, smaller)).status, 200, '20% smaller notes save through the real API');
    const restored = await (await request(`notebooks/${id}/layout`)).json();
    assert.equal(JSON.parse(restored.text).width, 208); assert.equal(JSON.parse(restored.text).height, 160);
    for (const dimensions of [{ width: 207, height: 160 }, { width: 208, height: 159 }]) {
      assert.equal((await request(`notebooks/${id}/layout`, alice.id, { ...smaller, revision: 2, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, ...dimensions }) })).status, 400);
    }
    const list = await (await request('notebooks')).json(); assert.equal(list.items.length, 2);
    assert.equal((await (await request('notebooks', bob.id)).json()).items.length, 1);
    assert.equal((await (await request(`notebooks/${id}/layout`, bob.id)).json()).revision, 0);
    for (let index = 2; index < 110; index++) hub.notebooks.save(alice.id, { resourceId: JSON.stringify(['hub-notebook-layout', 1, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`]), revision: 0, text: JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) });
    const first = await (await request('notebooks')).json(), second = await (await request(`notebooks?after=${encodeURIComponent(first.nextCursor)}`)).json();
    assert.equal(first.items.length + second.items.length, 110); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.resourceId)).size, 110);
    assert.equal((await request('notebooks?after=foreign')).status, 400);
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('global notebook is user-private, independent of connections, CAS protected and reauthorizes delayed writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-global-notebook-'));
  let hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  let revoked = false;
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw Error('Global notebook must not contact Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId && !revoked ? { userId, admin: userId === 'default' } : undefined; } });
  const path = '/api/hub/v1/notebook';
  const get = (user: string) => app.request(path, { headers: { 'x-test-user': user } });
  const put = (user: string, value: object) => app.request(path, { method: 'PUT', headers: { 'x-test-user': user }, body: JSON.stringify(value) });
  try {
    assert.equal((await app.request(path)).status, 401);
    const response = await get(alice.id);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json(), { resourceId } = first;
    const note = { resourceId, text: 'all my sessions', revision: 0 };
    assert.equal((await put(alice.id, note)).status, 200);
    assert.equal((await put(alice.id, note)).status, 409);
    assert.equal((await (await get(bob.id)).json()).text, '');
    assert.equal((await (await get('default')).json()).text, '', 'administrator cannot read another user notebook');
    assert.equal((await put(alice.id, { ...note, userId: bob.id })).status, 400);
    assert.equal((await put(alice.id, { ...note, resourceId: '["owner","node","codex","one"]' })).status, 409);
    assert.equal((await put(alice.id, { ...note, text: 'x'.repeat(50_001) })).status, 400);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const pending = app.fetch(new Request(`http://hub${path}`, { method: 'PUT', headers: { 'x-test-user': alice.id }, body, duplex: 'half' } as RequestInit));
    await new Promise(resolve => setImmediate(resolve)); revoked = true;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...note, text: 'revoked', revision: 1 }))); controller.close();
    assert.equal((await pending).status, 401);
    assert.equal(hub.notebooks.get(alice.id, resourceId).text, note.text);
    await routes?.close(); await hub.close(); hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
    assert.equal(hub.notebooks.get(alice.id, resourceId).text, note.text, 'survives Hub restart');
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const archive of [false, true]) test(`${archive ? 'archive' : 'notebook'} HTTP enforces actor privacy, shared read access, resource pinning and body-read revocation without contacting Connector`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-notebook-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const connection = { id: 'test', ownerUserId: 'default', kind: 'local' as const, label: 'Test', connectorUrl: 'local://aod-connector', credentialToken: 'synthetic' };
  hub.upsertConnection(connection);
  hub.pinConnectionNode('test', 'default', hub.connectionAuthority('test', 'default')!, 'node_11111111-1111-4111-8111-111111111111');
  const resource = { runtime: 'codex' as const, sessionKey: 'codex:one' };
  const target = { ownerUserId: 'default', connectionId: 'test', userId: alice.id };
  const grant = hub.grants.create(target, { ...resource, actions: ['messages:read'] });
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw new Error('Notebook must not call Connector'); }, normalizeError: () => 'Synthetic',
    principal: req => { const userId = req.headers.get('x-test-user'); return userId ? { userId, admin: userId === 'default' } : undefined; } });
  const id = encodeURIComponent(encodeHubSessionId('test', 'codex:one'));
  const suffix = archive ? '/archive' : '';
  const storedNote = (user: string, resourceId: string) => archive ? hub.notebooks.getArchive(user, resourceId) : hub.notebooks.get(user, resourceId);
  const owned = `/api/hub/v1/sessions/${id}/notebook${suffix}`, shared = `/api/hub/v1/shared/default/sessions/${id}/notebook${suffix}`;
  const get = (user: string, path = shared) => app.request(path, { headers: { 'x-test-user': user } });
  const put = (user: string, body: object, path = shared) => app.request(path, { method: 'PUT', headers: { 'x-test-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await app.request(owned)).status, 401);
    const first = await get('default', owned); assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
    const { resourceId } = await first.json();
    const value = { resourceId, text: 'owner private', revision: 0 };
    assert.equal((await put('default', value, owned)).status, 200);
    assert.equal((await put('default', value, owned)).status, 409);
    assert.equal((await (await get(alice.id)).json()).text, '', 'shared viewer never gets owner notes');
    assert.equal((await put(alice.id, { ...value, text: 'observer private' })).status, 200, 'read-only observer can write own notes');
    assert.equal((await (await get('default', owned)).json()).text, 'owner private');
    assert.equal((await get(bob.id)).status, 404);
    assert.equal((await put(alice.id, { ...value, userId: 'default' })).status, 400);
    assert.equal((await put(alice.id, { ...value, resourceId: 'old-node' })).status, 409);
    assert.equal((await put(alice.id, { ...value, text: 'x'.repeat(archive ? 100_001 : 50_001) })).status, 400);
    assert.equal((await get(alice.id, owned)).status, 404, 'owner route cannot borrow another owner');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const pending = app.fetch(new Request(`http://hub${shared}`, { method: 'PUT', headers: { 'x-test-user': alice.id, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
    await new Promise(resolve => setTimeout(resolve, 0));
    hub.grants.revoke(target, grant.id, grant.version);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...value, revision: 1, text: 'revoked' }))); controller.close();
    assert.equal((await pending).status, 403);
    assert.equal(storedNote(alice.id, resourceId).text, 'observer private');
    assert.equal((await get(alice.id)).status, 404);
    hub.deleteConnection('test', 'default'); hub.upsertConnection(connection);
    assert.throws(() => hub.pinConnectionNode('test', 'default', hub.connectionAuthority('test', 'default')!, 'node_22222222-2222-4222-8222-222222222222'), /identity or authorization changed/, 'deleting an alias does not reset its identity pin');
    assert.equal((await (await get('default', owned)).json()).text, 'owner private');
    hub.upsertConnection({ ...connection, id: 'replacement' });
    hub.pinConnectionNode('replacement', 'default', hub.connectionAuthority('replacement', 'default')!, 'node_22222222-2222-4222-8222-222222222222');
    const replacementPath = `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('replacement', 'codex:one'))}/notebook${suffix}`;
    const replacement = await (await get('default', replacementPath)).json();
    assert.equal(replacement.text, ''); assert.notEqual(replacement.resourceId, resourceId);
    assert.equal((await put('default', { ...value, revision: 1 }, replacementPath)).status, 409, 'old browser cannot save to replacement node');
    assert.equal(storedNote('default', resourceId).text, 'owner private', 'old note remains intact');
  } finally { await routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
