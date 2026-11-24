import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CodexAppServer } from '../codex/app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { registerSessionSettingsRoutes } from '../connector/session-settings-http.js';
import { DeckStore } from '../projection/deck-store.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { ConnectorClient } from './connector-client.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubSettingsRoutes } from './settings-http.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-goal-hub-')), file = join(directory, 'hub.sqlite');
  let hub = new HubStore(file, 'synthetic-vault');
  const setup = new DatabaseSync(file); setup.prepare('INSERT INTO users (id,label,created_at,updated_at) VALUES (?,?,1,1)').run('a', 'a'); setup.close();
  const users = new ConnectorUserStore(join(directory, 'node.sqlite')), store = new DeckStore();
  const native = 'codex:thread', id = encodeHubSessionId('a', native);
  const goal = { threadId: 'thread', objective: 'Private goal', status: 'active', tokenBudget: 100,
    tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2, secret: 'native-extra' };
  store.upsertSession({ sessionKey: native, title: 'Goal', agentId: 'codex', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'never-run', defaultCwd: directory,
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions, authorizeTurn: () => true });
  const calls: string[] = [], runtime = codex as any;
  let readFailure = false;
  runtime.setConnection('connection'); runtime.ensureStarted = () => assert.fail('No model');
  runtime.request = async (method: string, _params: unknown, _timeout?: number, receipt?: { beforeWrite: () => void }) => {
    calls.push(method); assert.ok(['thread/goal/get', 'thread/goal/set'].includes(method));
    if (readFailure && method === 'thread/goal/get') throw new Error('synthetic preflight read failure');
    if (method === 'thread/goal/set') receipt?.beforeWrite();
    return { goal: { ...goal, status: method === 'thread/goal/set' ? 'paused' : 'active' } };
  };
  const connector = new Hono();
  registerSessionSettingsRoutes(connector, '/api/connector/v1/sessions/:sessionKey', { store, codex, receipts: users.commands,
    actor: () => 'node-actor', sessionKey: c => c.req.param('sessionKey')!, settingsAdmission: k => users.canChangeSettings(k),
    gateway: {} as any, refreshSessions: async () => {} });
  const bump = () => {
    hub.upsertConnection({ id: 'a', ownerUserId: 'a', label: 'Node', connectorUrl: 'http://synthetic', kind: 'remote', capabilities: [] });
    hub.pinConnectionNode('a', 'a', hub.connectionAuthority('a', 'a')!, users.nodeId);
  };
  bump();
  const mode = { lose: false, badNode: false, replaceDuringRead: false, privateExtras: false }, deliveries: string[] = [];
  const client = () => new ConnectorClient('http://synthetic', 'synthetic-token', async request => {
    deliveries.push(request.method);
    const response = await connector.fetch(request), body = await response.json() as any;
    if (mode.replaceDuringRead) bump();
    if (mode.privateExtras && body.goal) { body.secret = 'envelope-extra'; body.goal.secret = 'native-extra'; }
    const headers = { [NODE_ID_HEADER]: mode.badNode ? 'other-node' : users.nodeId };
    return mode.lose ? Response.json({}, { status: 502, headers }) : Response.json(body, { status: response.status, headers });
  }, undefined, undefined, { nodeId: users.nodeId });
  const create = () => {
    const app = new Hono(); registerHubSettingsRoutes(app, { store: hub, client,
      owner: c => { if (c.req.header('owner') !== 'a') throw new HTTPException(403); return 'a'; },
      error: c => c.json({ error: 'unavailable' }, 502) }); return app;
  };
  let app = create();
  t.after(async () => { await codex.close(); hub.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  return { mode, calls, deliveries, bump, failReads: () => { readFailure = true; },
    read: (owner = 'a') => app.request(`/api/hub/v1/sessions/${encodeURIComponent(id)}/goal`, { headers: { owner } }),
    patch: (payload: object) => app.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { owner: 'a', 'idempotency-key': 'original' }, body: JSON.stringify(payload) }),
    receipt: () => app.request(`/api/hub/v1/sessions/${encodeURIComponent(id)}/settings-commands/original`, { headers: { owner: 'a' } }),
    reopen: () => { hub.close(); hub = new HubStore(file, 'synthetic-vault'); app = create(); } };
}

test('Goal Hub owner read whitelists native observations and rejects foreign users/nodes', async t => {
  const f = fixture(t); f.mode.privateExtras = true;
  const read = await f.read(); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  const body = await read.json(); assert.ok(!JSON.stringify(body).includes('extra'));
  assert.equal((await f.read('b')).status, 403);
  f.mode.badNode = true; assert.notEqual((await f.read()).status, 200);
  assert.equal(f.calls.filter(v => v === 'thread/goal/set').length, 0);
});

test('Goal Hub rejects observation if owner connection authority changes during the read', async t => {
  const f = fixture(t); f.mode.replaceDuringRead = true;
  assert.notEqual((await f.read()).status, 200);
});

test('Goal Hub rejects invalid or mixed intent before transport and receipt admission', async t => {
  const f = fixture(t);
  for (const payload of [{ goal: { action: 'resume', expectedRevision: 'stale' } },
    { goal: { action: 'pause', expectedRevision: 'a'.repeat(64) }, title: 'unrelated' },
    { goal: { action: 'create', expectedRevision: 'a'.repeat(64), objective: 'Task', tokenBudget: null } },
    { goal: { action: 'create', expectedRevision: 'a'.repeat(64), objective: 'Task', tokenBudget: 0 } }]) {
    assert.equal((await f.patch(payload)).status, 400);
    assert.equal((await f.receipt()).status, 404, 'invalid intent must not reserve an unknown receipt');
  }
  assert.deepEqual(f.deliveries, [], 'no native or Connector calls');
});

test('Goal lost Hub ACK survives reopen and recovers using GET only', async t => {
  const f = fixture(t), snapshot = await (await f.read()).json() as any;
  const payload = { goal: { action: 'pause', expectedRevision: snapshot.revision } };
  f.mode.lose = true; assert.equal((await f.patch(payload)).status, 202);
  f.reopen(); assert.equal((await f.patch(payload)).status, 202);
  f.mode.lose = false;
  const receipt = await (await f.receipt()).json() as any;
  assert.equal(receipt.command.state, 'accepted');
  assert.deepEqual(receipt.command.result.body.settings, { goalControl: 'pause' });
  assert.ok(!JSON.stringify(receipt).includes('Private goal'));
  assert.equal(f.deliveries.filter(v => v === 'PATCH').length, 1);
  assert.equal(f.calls.filter(v => v === 'thread/goal/set').length, 1);
});

test('Goal failed preflight with lost Hub response recovers rejection without repeating the intent', async t => {
  const f = fixture(t), snapshot = await (await f.read()).json() as any;
  const payload = { goal: { action: 'pause', expectedRevision: snapshot.revision } };
  f.failReads(); f.mode.lose = true;
  assert.equal((await f.patch(payload)).status, 202);
  f.reopen(); f.mode.lose = false;
  const receipt = await (await f.receipt()).json() as any;
  assert.equal(receipt.command.state, 'rejected');
  assert.equal((await f.patch(payload)).status, 409);
  assert.equal(f.deliveries.filter(v => v === 'PATCH').length, 1);
  assert.equal(f.calls.filter(v => v === 'thread/goal/set').length, 0);
});
