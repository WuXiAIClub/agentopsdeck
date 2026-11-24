import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorBoardBindings } from '../connector/board-bindings-http.js';
import { registerHubBoardBindings } from './hub-workspace-board-bindings.js';
import { registerWorkspaceAgentRoutes } from './workspace-agent.js';
import { BOARD_READ_TOOL, loadWorkerBoardTools } from '../tools/workspace-board-worker.js';
import { CodexBoardTools } from '../codex/board-tools.js';

async function fixture(t: { after: (fn: () => unknown) => void }, runtime: 'ghcp' | 'codex' = 'ghcp') {
  const root = await mkdtemp(join(tmpdir(), 'hub-board-binding-http-')), directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic-vault'), app = new Hono(), connector = new Hono();
  const owner = hub.createUser('Alice').id, other = hub.createUser('Bob').id, task = randomUUID(), sessionId = randomUUID();
  const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
  hub.boards.save(owner, 'default', { title: 'Board', revision: 0, mutationId: randomUUID(), tasks: [{ id: task, title: 'Task', detail: '', status: 'todo' }] });
  hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example' });
  hub.pinConnectionNode('dev', owner, hub.connectionAuthority('dev', owner)!, `node_${randomUUID()}`);
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), token = tokens.createTransient(['boards:bind'], 'hub-token');
  connector.use('*', async (c, next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); });
  const bindings = registerConnectorBoardBindings(connector, { tokens, directories: { [runtime]: directory }, policies: [{ owner: 'hub-token', runtime, endpoint }],
    resolveSession: key => key === `${runtime}:fixture` ? { runtime, sessionId, ready: true } : undefined });
  await bindings.ready;
  let puts = 0, gets = 0, drop = false, offline = false;
  const routes = registerHubBoardBindings(app, { hubStore: hub, endpoint, principal: c => { const userId = c.req.header('x-test-user'); if (!userId) throw new HTTPException(401); return { userId, admin: false }; },
    connectorClient: () => new ConnectorClient('https://connector.example', token.token, async request => {
      if (offline) throw new Error('private transport error');
      if (request.method === 'PUT') puts++; if (request.method === 'GET') gets++;
      const response = await connector.request(request);
      if (drop && request.method === 'PUT') throw new Error('lost response containing private diagnostic');
      return response;
    }) });
  const input = { requestId: randomUUID(), sessionId: encodeHubSessionId('dev', `${runtime}:fixture`), grant: { taskIds: [task], fields: ['status'], expiresAt: Date.now() + 60_000 } };
  const base = '/api/hub/v1/workspace/boards/default/bindings';
  const req = (method = 'GET', body?: unknown, suffix = '', actor = owner) => app.request(base + suffix, { method, headers: { 'x-test-user': actor }, ...(body ? { body: JSON.stringify(body) } : {}) });
  t.after(async () => { await routes.close(); token.dispose(); await bindings.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { hub, app, owner, other, input, req, directory, sessionId, task, get puts() { return puts; }, get gets() { return gets; },
    loseResponse: () => { drop = true; }, offline: () => { offline = true; } };
}

test('UI-shaped request binds actual Connector private worker without exposing credential', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('POST', f.input, '', f.other)).status, 404); assert.equal(f.gets, 0);
  assert.equal((await f.req('POST', { ...f.input, endpoint: 'https://evil.example' })).status, 400);
  const response = await f.req('POST', f.input); assert.equal(response.status, 201);
  const body = await response.json(); assert.equal(body.binding.state, 'installed');
  const credential = f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId)!;
  assert.ok(!JSON.stringify(body).includes(credential.token));
  assert.equal((await f.req('POST', f.input)).status, 200); assert.equal(f.puts, 1);
  assert.equal((await f.req('POST', { ...f.input, grant: { ...f.input.grant, fields: ['status', 'detail'] } })).status, 409);
  const agent = new Hono(); registerWorkspaceAgentRoutes(agent, f.hub.boardCapabilities);
  const worker = await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true, ((url, init) => agent.request(String(url), init)) as typeof fetch);
  assert.ok(worker); const read = await worker.invoke(BOARD_READ_TOOL, {});
  assert.ok(JSON.stringify(read).includes('Task'));
  assert.equal((await f.req('GET', undefined, `/${f.input.requestId}`, f.other)).status, 404);
  const revoked = await (await f.req('DELETE', undefined, `/${f.input.requestId}`)).json();
  assert.equal(revoked.binding.state, 'revoked'); assert.equal(revoked.cleanup, 'confirmed');
  assert.equal(f.hub.boardCapabilities.authorized(credential.token), false);
  assert.equal(await loadWorkerBoardTools(f.directory, 'ghcp', f.sessionId, () => true), undefined);
});

test('Codex host reads a Hub-transferred managed binding and rejects it after revocation', async t => {
  const f = await fixture(t, 'codex');
  assert.equal((await f.req('POST', f.input)).status, 201);
  const agent = new Hono(); registerWorkspaceAgentRoutes(agent, f.hub.boardCapabilities);
  const host = new CodexBoardTools(f.directory, ((url, init) => agent.request(String(url), init)) as typeof fetch);
  t.after(() => host.close());
  host.begin(f.sessionId, turn => turn === 'admitted-turn');
  const call = { threadId: f.sessionId, turnId: 'admitted-turn', callId: 'read-1', namespace: null, tool: BOARD_READ_TOOL, arguments: {} };
  const result = await host.invoke(call);
  assert.equal(result.success, true); assert.match(result.contentItems[0]!.text, /Task/);
  const credential = f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId)!;
  assert.ok(!JSON.stringify(result).includes(credential.token));
  assert.equal((await f.req('DELETE', undefined, `/${f.input.requestId}`)).status, 200);
  assert.equal((await host.invoke({ ...call, callId: 'read-2' })).success, false);
  assert.equal(f.puts, 1);
});

test('lost installation response remains uncertain; recovery only reads and never reinstalls', async t => {
  const f = await fixture(t); f.loseResponse();
  const result = await f.req('POST', f.input); assert.equal(result.status, 202);
  assert.equal((await result.json()).binding.state, 'uncertain'); assert.equal(f.puts, 1);
  assert.equal((await f.req('POST', f.input)).status, 200); assert.equal(f.puts, 1);
  const recovered = await (await f.req('GET', undefined, `/${f.input.requestId}`)).json();
  assert.equal(recovered.binding.state, 'installed'); assert.equal(f.puts, 1);
  f.offline();
  const revoked = await (await f.req('DELETE', undefined, `/${f.input.requestId}`)).json();
  assert.equal(revoked.binding.state, 'revoked'); assert.equal(revoked.cleanup, 'pending');
  assert.equal(f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId), undefined);
});

test('explicit cancellation fences a never-received request and its late admission without installing', async t => {
  const f = await fixture(t), suffix = `/${f.input.requestId}/cancel-intent`;
  assert.equal((await f.req('GET', undefined, `/${f.input.requestId}`)).status, 404);
  assert.equal((await f.req('POST', { token: 'forbidden' }, suffix)).status, 400);
  assert.equal((await f.req('POST', {}, suffix + '?retry=true')).status, 400);
  const response = await f.req('POST', {}, suffix);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cancelled: true, requestId: f.input.requestId, binding: null });
  assert.equal((await f.req('POST', {}, suffix)).status, 200, 'cancellation is idempotent');
  assert.equal(f.puts, 0); assert.equal(f.gets, 0, 'cancellation does not contact Connector');
  assert.equal((await f.req('POST', f.input)).status, 409, 'late original request cannot grant');
  assert.equal(f.puts, 0);
  assert.equal(f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId), undefined);
});

test('cancellation denies an already admitted credential immediately while offline; owner isolated', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('POST', f.input)).status, 201);
  const credential = f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId)!;
  const suffix = `/${f.input.requestId}/cancel-intent`;
  await f.req('POST', {}, suffix, f.other);
  assert.equal(f.hub.boardCapabilities.authorized(credential.token), true);
  f.offline(); const requests = f.gets;
  const response = await f.req('POST', {}, suffix); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.binding.state, 'revoked');
  assert.equal(f.hub.boardCapabilities.authorized(credential.token), false);
  assert.equal(f.hub.boardBindings.credential(f.owner, 'default', f.input.requestId), undefined);
  assert.equal(f.gets, requests); assert.equal(f.puts, 1);
  assert.ok(!JSON.stringify(body).includes(credential.token));
});
