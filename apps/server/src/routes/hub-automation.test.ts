import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_PROTOCOL } from '@agentopsdeck/shared';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { ConnectorAutomationHost } from '../connector/automation-host.js';
import { registerConnectorAutomation } from '../connector/automation-http.js';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { registerHubAutomation } from './hub-automation.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hub-automation-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic');
  const owner = hub.createUser('Alice').id, other = hub.createUser('Bob').id;
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const token = tokens.createTransient(['automation:manage', 'messages:send'], 'fixture');
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const codex = new CodexAppServer({ enabled: false, command: 'must-not-launch', defaultCwd: root,
    defaultModel: 'synthetic', approvalPolicy: 'never', store: new DeckStore(), turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const allowed = (id: string) => tokens.hasScope(id, 'automation:manage') && tokens.hasScope(id, 'messages:send');
  const host = new ConnectorAutomationHost(id => users.createCodexAutomation(codex, id, users.nodeId, () => allowed(id)), allowed);
  host.start([], false);
  const remote = new Hono();
  remote.use('*', async (c, next) => { c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, users.nodeId); await next(); });
  registerConnectorAutomation(remote, '/api/connector/v1/automation', { tokens, host, nodeId: users.nodeId });
  hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example' });
  hub.pinConnectionNode('dev', owner, hub.connectionAuthority('dev', owner)!, users.nodeId);
  let posts = 0, drop = false, revoke = false, corrupt = false;
  const app = new Hono();
  registerHubAutomation(app, { hubStore: hub, principal: c => ({ userId: c.req.header('x-user') ?? owner, admin: false }),
    connectorClient: () => new ConnectorClient('https://connector.example', token.token, async req => {
      if (req.method === 'POST') posts++;
      const response = await remote.fetch(req);
      if (drop && req.method === 'POST') throw Error('ACK lost');
      if (revoke) hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example', status: 'disabled' });
      if (corrupt) return new Response(JSON.stringify({ ownerId: 'fixture', connectionId: 'foreign', rules: [] }), { headers: response.headers });
      return response;
    }, 1000, 8 * 1024 * 1024, { nodeId: users.nodeId }),
  });
  const request = (method = 'GET', suffix = '', body?: unknown, actor = owner, key = 'codex:test') => app.request(
    `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('dev', key))}/automation${suffix}`, {
      method, headers: { 'x-user': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = { kind: 'save', expectedRevision: 0, confirmEnable: false, template: 'Synthetic message',
    rule: { id: 'rule', revision: 1, authorityEpoch: 1, enabled: false,
      target: { ownerId: 'fixture', connectionId: users.nodeId, runtime: 'codex', sessionId: 'codex:test' },
      startsAt: 1000, expiresAt: 1000000, maxSends: 1, maxPerHour: 1, minIntervalMs: 60000,
      mode: { kind: 'interval', intervalMs: 60000 } } };
  t.after(async () => { await host.close(); await codex.close(); users.close(); token.dispose(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { request, input, owner, other, users, posts: () => posts, drop: () => { drop = true; }, revoke: () => { revoke = true; }, corrupt: () => { corrupt = true; } };
}
test('Hub config traverses actual Connector scope/owner stores, original receipt, no sends', async t => {
  const f = fixture(t);
  const view = await f.request(); assert.equal(view.status, 200); assert.equal(view.headers.get('cache-control'), 'no-store');
  const saved = await f.request('POST', '/configuration/original', f.input); assert.equal(saved.status, 200);
  const receipt = await saved.json();
  assert.deepEqual(await (await f.request('GET', '/configuration/original')).json(), receipt);
  assert.deepEqual(await (await f.request('POST', '/configuration/original', f.input)).json(), receipt);
  assert.equal((await f.request('POST', '/configuration/original', { ...f.input, template: 'changed' })).status, 409);
  assert.equal(f.users.turns.maintenanceCount(), 0);
});
test('Hub fences foreign owner, target, node, runtime and cross-session rule revocation', async t => {
  const f = fixture(t);
  assert.equal((await f.request('GET', '', undefined, f.other)).status, 404);
  assert.equal((await f.request('GET', '', undefined, f.owner, 'ghcp:test')).status, 404);
  for (const field of ['ownerId', 'connectionId', 'sessionId', 'runtime']) {
    assert.equal((await f.request('POST', '/configuration/wrong', { ...f.input, rule: { ...f.input.rule,
      target: { ...f.input.rule.target, [field]: 'foreign' } } })).status, 403);
  }
  assert.equal(f.posts(), 0);
  await f.request('POST', '/configuration/original', f.input);
  assert.deepEqual((await (await f.request('GET', '', undefined, f.owner, 'codex:other')).json()).rules, []);
  assert.equal((await f.request('POST', '/configuration/revoke', { kind: 'revoke', ruleId: 'rule', expectedRevision: 1 }, f.owner, 'codex:other')).status, 404);
  assert.equal((await f.request('GET', '/configuration/original', undefined, f.owner, 'codex:other')).status, 502);
  assert.equal(f.posts(), 1);
});
test('lost configuration ACK is recovered by exact request without a second POST', async t => {
  const f = fixture(t); f.drop();
  assert.equal((await f.request('POST', '/configuration/original', f.input)).status, 503);
  const recovered = await f.request('GET', '/configuration/original'); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).result.rule.revision, 1); assert.equal(f.posts(), 1);
});
test('revocation across snapshot await stops dispatch; forged node is rejected', async t => {
  const f = fixture(t); f.revoke();
  assert.equal((await f.request('POST', '/configuration/original', f.input)).status, 403); assert.equal(f.posts(), 0);
  const g = fixture(t); g.corrupt(); assert.equal((await g.request()).status, 502);
});
test('bounded Hub input and no public completion or dispatch endpoint', async t => {
  const f = fixture(t);
  assert.equal((await f.request('POST', '/configuration/original', { ...f.input, template: 'x'.repeat(50000) })).status, 413);
  for (const endpoint of ['trigger', 'completed', 'dispatch', 'retry']) assert.equal((await f.request('POST', `/${endpoint}`, {})).status, 404);
  assert.equal(f.posts(), 0);
});

for (const change of ['generation', 'owner'] as const) test(`automation rejects changed ${change} during async resolution before dispatch`, async t => {
  const store = new HubStore(':memory:', 'synthetic'), app = new Hono();
  store.upsertConnection({ id: 'node', connectorUrl: 'https://fixture.invalid', label: 'Fixture' });
  store.pinConnectionNode('node', 'default', store.connectionAuthority('node', 'default')!, `node_${randomUUID()}`);
  let owner = 'default', dispatches = 0, release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  registerHubAutomation(app, { hubStore: store, principal: () => ({ userId: owner, admin: false }),
    connectorClient: () => { throw Error('Legacy fallback forbidden'); },
    async asyncConnectorClient() {
      enter(); await held;
      return new ConnectorClient('https://fixture.invalid', 'synthetic', () => {
        dispatches++; return Response.json({}, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      });
    } });
  const pending = app.request(`/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('node', 'codex:fixture'))}/automation`);
  t.after(async () => { release(); await pending; await store.close(); });
  await entered;
  if (change === 'owner') owner = 'replacement';
  else store.upsertConnection({ id: 'node', connectorUrl: 'https://replacement.invalid', label: 'Replacement' });
  release();
  assert.equal((await pending).status, 403);
  assert.equal(dispatches, 0);
});

test('automation close retains aborted original physical POST and source cancel ACK without replay', async t => {
  const store = new HubStore(':memory:', 'synthetic'), app = new Hono();
  const nodeId = `node_${randomUUID()}`;
  store.upsertConnection({ id: 'node', connectorUrl: 'https://fixture.invalid', label: 'Fixture' });
  store.pinConnectionNode('node', 'default', store.connectionAuthority('node', 'default')!, nodeId);
  let posts = 0, cancellations = 0, started!: () => void, dispatch!: (response: Response) => void, releaseCancel!: () => void;
  const postEntered = new Promise<void>(resolve => { started = resolve; });
  const postHeld = new Promise<Response>(resolve => { dispatch = resolve; });
  const routes = registerHubAutomation(app, {
    hubStore: store, principal: () => ({ userId: 'default', admin: false }),
    connectorClient: () => { throw Error('Legacy fallback forbidden'); },
    async asyncConnectorClient() {
      return new ConnectorClient('https://fixture.invalid', 'synthetic', async request => {
        if (request.method === 'GET') {
          return Response.json({ ownerId: 'fixture', connectionId: nodeId, runtime: 'codex', sessionId: 'codex:fixture', rules: [], recentExecutions: [] },
            { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
        }
        posts++; started(); return postHeld;
      });
    },
  });
  t.after(async () => { await store.close(); });
  const controller = new AbortController();
  const input = { kind: 'save', expectedRevision: 0, confirmEnable: false, template: 'Synthetic',
    rule: { id: 'rule', revision: 1, authorityEpoch: 1, enabled: false,
      target: { ownerId: 'fixture', connectionId: nodeId, runtime: 'codex', sessionId: 'codex:fixture' },
      startsAt: 1000, expiresAt: 1000000, maxSends: 1, maxPerHour: 1, minIntervalMs: 60000,
      mode: { kind: 'interval', intervalMs: 60000 } } };
  const pending = app.request(`/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('node', 'codex:fixture'))}/automation/configuration/original`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
  await postEntered;
  controller.abort();
  let settled = false;
  void pending.then(() => { settled = true; });
  let closed = false;
  const closing = routes.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(closed, false, 'close waits for held physical POST');
  dispatch(new Response(new ReadableStream({
    cancel() { cancellations++; return new Promise<void>(resolve => { releaseCancel = resolve; }); },
  }), { status: 200, headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }));
  for (let i = 0; cancellations === 0 && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(settled, false);
  assert.equal(closed, false, 'close waits for source cancel ACK');
  releaseCancel();
  await closing;
  const response = await pending;
  assert.ok([499, 503].includes(response.status));
  assert.equal(posts, 1);
});
