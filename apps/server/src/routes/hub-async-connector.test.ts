import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient, ConnectorClientError } from '../hub/connector-client.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { registerHubQueueRoutes } from '../hub/queue-http.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import type { AsyncConnectorClientResolver, AsyncConnectorOptions } from '../hub/async-connector-client.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const forbidden = () => { throw Error('synchronous Connector fallback is forbidden'); };
const headers = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) };

test('Hub HTTP propagates request-bound async resolution across control, website, users and queue reads without wire changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-async-http-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  store.upsertConnection({ id: 'node', connectorUrl: 'https://synthetic.invalid', label: 'Fixture' });
  let legacyCalls = 0;
  const calls: { path: string; options: AsyncConnectorOptions }[] = [];
  const asyncConnectorClient: AsyncConnectorClientResolver = async (request, id, options = {}) => {
    assert.equal(options.expectedUserId, 'default');
    assert.equal(request.headers.get('x-fixture'), 'evidence');
    await tick();
    return new ConnectorClient('http://fixture', 'synthetic', upstream => {
      const path = new URL(upstream.url).pathname;
      calls.push({ path, options });
      return Response.json(path.endsWith('/websites/catalog') ? { services: [{ id: 'fixture', label: 'Site', private: 'not-projected' }] }
        : path.endsWith('/users') ? { users: [] }
        : { ok: true, id }, { headers });
    });
  };
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
    normalizeError: () => 'Synthetic', connectorClient: () => { legacyCalls++; return forbidden(); }, asyncConnectorClient });
  const session = encodeURIComponent(encodeHubSessionId('node', 'codex:fixture'));
  try {
    for (const path of ['connections/node/agents', 'connections/node/gateway/model-set',
      'connections/node/websites/catalog', 'connector-users', `sessions/${session}/queue`]) {
      const response = await app.request(`/api/hub/v1/${path}`, { headers: { 'x-fixture': 'evidence' } });
      assert.equal(response.status, 200, path);
      if (path.endsWith('/websites/catalog')) assert.deepEqual(await response.json(), { services: [{ id: 'fixture', label: 'Site' }] });
    }
    assert.equal(legacyCalls, 0);
    assert.ok(calls.some(row => row.path.endsWith('/gateway/model-set') && row.options.maintenance === true));
    assert.ok(calls.some(row => row.path.endsWith('/queue') && row.options.maintenance === false));
  } finally { await routes?.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const change of ['generation', 'identity'] as const) test(`owner controls recheck original ${change} after async resolution before dispatch`, async () => {
  const store = new HubStore(':memory:', 'synthetic'), app = new Hono();
  store.upsertConnection({ id: 'node', connectorUrl: 'https://synthetic.invalid', label: 'Fixture' });
  let owner = 'default', dispatches = 0, releases!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { releases = resolve; });
  registerHubQueueRoutes(app, '/api/hub/v1/sessions/:hubSessionId', { store, client: forbidden,
    owner: () => owner, error: c => c.json({ error: 'unavailable' }, 503),
    async asyncConnectorClient() {
      entered(); await hold;
      return new ConnectorClient('http://fixture', 'synthetic', () => { dispatches++; return Response.json({}, { headers }); });
    } });
  const session = encodeURIComponent(encodeHubSessionId('node', 'codex:fixture'));
  const pending = app.request(`/api/hub/v1/sessions/${session}/queue`);
  try {
    await reached;
    if (change === 'generation') store.upsertConnection({ id: 'node', connectorUrl: 'https://replacement.invalid', label: 'Changed' });
    else owner = 'other';
    releases(); assert.equal((await pending).status, 403); assert.equal(dispatches, 0);
  } finally { releases(); await pending; await store.close(); }
});

test('failed async control authorization preserves a receipt as unknown without sync fallback or mutation replay', async () => {
  const store = new HubStore(':memory:', 'synthetic'), app = new Hono();
  store.upsertConnection({ id: 'node', connectorUrl: 'https://synthetic.invalid', label: 'Fixture' });
  const epoch = store.connectionAuthority('node', 'default')!;
  const sessionId = encodeHubSessionId('node', 'codex:fixture');
  const scope = JSON.stringify(['owner-queue-mutation-v1', 'default', sessionId, 'message']);
  (await store.commands.claimAsync(scope, 'original', { method: 'PATCH' }, true, epoch));
  let resolves = 0;
  registerHubQueueRoutes(app, '/api/hub/v1/sessions/:hubSessionId', { store, client: forbidden,
    owner: () => 'default', error: c => c.json({ error: 'unavailable' }, 503),
    async asyncConnectorClient() { resolves++; throw new ConnectorClientError(503, 'Original owner unavailable'); } });
  try {
    const path = `/api/hub/v1/sessions/${encodeURIComponent(sessionId)}/queue/message/commands/original`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(path); assert.equal(response.status, 200);
      assert.equal((await response.json() as { command: { state: string } }).command.state, 'outcome_unknown');
    }
    assert.equal(resolves, 2); assert.equal(store.commands.get(scope, 'original')!.state, 'outcome_unknown');
  } finally { await store.close(); }
});
