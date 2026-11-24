import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';

test('workspace HTTP preferences bind to current identity, reject foreign user IDs and fail closed after body-read revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-workspace-'));
  const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  const app = new Hono();
  let revoked = false;
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    connectorClient: () => { throw new Error('Preferences must not access Connector'); }, normalizeError: () => 'Synthetic',
    principal: request => {
      const userId = request.headers.get('x-test-user');
      return userId && !revoked ? { userId, admin: userId === 'admin' } : undefined;
    } });
  const path = '/api/hub/v1/workspace/preferences';
  const value = { revision: 0, groups: [{ id: 'g', name: 'Group' }], sessions: {} };
  const save = (user: string, body: object) => app.request(path, { method: 'PUT', headers: { 'x-test-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await save('alice', value)).status, 200);
    assert.equal((await save('alice', value)).status, 409);
    assert.equal((await save('admin', { ...value, userId: 'alice' })).status, 400);
    const other = await app.request(path, { headers: { 'x-test-user': 'bob' } });
    assert.equal(other.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await other.json(), { revision: 0, groups: [], sessions: {} });
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const pending = app.fetch(new Request(`http://hub${path}`, { method: 'PUT', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
    revoked = true;
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify({ ...value, revision: 1, groups: [] }))); bodyController.close();
    assert.equal((await pending).status, 401);
    assert.equal(hub.workspace.get('alice').revision, 1);
  } finally { routes?.close(); await hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
