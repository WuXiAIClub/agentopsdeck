import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { ConnectorClient } from './connector-client.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerCompactReceipts } from '../commands/http.js';
import { registerHubCompactRoutes } from './compact-http.js';
import { encodeHubSessionId } from './session-id.js';

test('compact response loss/reopen uses isolated original receipt and never redispatches', async t => {
  const f = fixture(); t.after(f.close); f.mode.lose = true;
  assert.equal((await f.post('a', 'original')).status, 202);
  assert.equal((await f.post('a', 'original')).status, 202); assert.equal(f.starts(), 1);
  f.reopen(); f.mode.lose = false;
  const receipt = (await (await f.read('a', 'original')).json()).command;
  assert.equal(receipt.state, 'accepted'); assert.equal(receipt.result.body.status, 'compacting');
  assert.equal((await f.post('a', 'original')).status, 200); assert.equal(f.starts(), 1);
  assert.equal((await f.read('b', 'original')).status, 404);
});

test('compact duplicate concurrency, owner isolation and input limits', async t => {
  const f = fixture(); t.after(f.close);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.post('a', 'same')));
  assert.ok(results.every(r => [200, 202].includes(r.status))); assert.equal(f.starts(), 1);
  assert.equal((await f.post('b', 'same')).status, 200); assert.equal(f.starts(), 2);
  assert.equal(new Set(f.deliveries).size, 2);
  assert.equal((await f.post('a', 'bad', { message: '/compact' })).status, 400);
  assert.equal((await f.post('a', 'bad', { text: 'x'.repeat(5000) })).status, 413);
  assert.equal((await f.post('a', 'bad', { idempotencyKey: 'conflict' })).status, 400);
  assert.equal(f.starts(), 2);
});

test('compact receipt cannot migrate across node/credential generations', async t => {
  const f = fixture(); t.after(f.close); f.mode.lose = true;
  assert.equal((await f.post('a', 'old')).status, 202); f.bump('a');
  assert.equal((await f.read('a', 'old')).status, 409);
  assert.equal((await f.post('a', 'old')).status, 409); assert.equal(f.starts(), 1);
});

for (const malformed of ['run', 'state', 'key', 'node', 'missing']) test(`compact ${malformed} proof fails closed until original receipt is valid`, async t => {
  const f = fixture(); t.after(f.close); f.mode.malformed = malformed;
  assert.equal((await f.post('a', 'original')).status, 202);
  assert.equal((await f.post('a', 'original')).status, 202); assert.equal(f.starts(), 1);
  f.mode.malformed = '';
  assert.equal((await (await f.read('a', 'original')).json()).command.state, 'accepted');
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-http-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic-vault');
  const setup = new DatabaseSync(file);
  for (const owner of ['a', 'b']) setup.prepare('INSERT INTO users (id,label,created_at,updated_at) VALUES (?,?,1,1)').run(owner, owner);
  setup.close();
  const node = new ConnectorUserStore(join(dir, 'connector.sqlite'));
  const native = `claude-code:${randomUUID()}`, id = (owner: string) => encodeHubSessionId(owner, native);
  const mode = { lose: false, malformed: '' }, deliveries: string[] = []; let starts = 0;
  const connector = new Hono();
  registerCompactReceipts(connector, '/api/connector/v1/sessions/:sessionKey', { receipts: node.commands,
    scope: () => JSON.stringify(['synthetic-owner', native]) });
  connector.post('/api/connector/v1/sessions/:sessionKey/compact', c => {
    starts++; return c.json({ ok: true, status: 'compacting', runId: randomUUID() });
  });
  const bump = (owner: string) => {
    store.upsertConnection({ id: owner, ownerUserId: owner, label: 'Synthetic', connectorUrl: 'http://synthetic', kind: 'remote', capabilities: [] });
    store.pinConnectionNode(owner, owner, store.connectionAuthority(owner, owner)!, node.nodeId);
  };
  bump('a'); bump('b');
  const client = () => new ConnectorClient('http://synthetic', 'synthetic-credential', async request => {
    if (request.method === 'POST') deliveries.push(request.headers.get('idempotency-key')!);
    const response = await connector.fetch(request), body = await response.json() as any;
    const headers = { [NODE_ID_HEADER]: mode.malformed === 'node' ? 'other-node' : node.nodeId };
    if (mode.lose) return Response.json({}, { status: 502, headers });
    const result = body.command?.result?.body ?? body;
    if (mode.malformed === 'run') result.runId = 'invalid';
    if (mode.malformed === 'state') result.status = 'sent';
    if (mode.malformed === 'key' && body.command) body.command.key = 'other-key';
    if (mode.malformed === 'missing') delete body.command;
    return Response.json(body, { status: response.status, headers });
  }, undefined, undefined, { nodeId: node.nodeId });
  const create = () => {
    const app = new Hono(); registerHubCompactRoutes(app, { store, client, owner: c => {
      const owner = c.req.header('owner'); if (owner !== 'a' && owner !== 'b') throw new HTTPException(401); return owner;
    }, error: c => c.json({ error: 'Synthetic error' }, 502) }); return app;
  };
  let app = create();
  return { mode, bump, deliveries, starts: () => starts,
    post: (owner: string, key: string, body: unknown = {}) => app.request(`/api/hub/v1/sessions/${encodeURIComponent(id(owner))}/compact`, {
      method: 'POST', headers: { owner, 'idempotency-key': key }, body: JSON.stringify(body) }),
    read: (owner: string, key: string) => app.request(`/api/hub/v1/sessions/${encodeURIComponent(id(owner))}/compact-commands/${key}`, { headers: { owner } }),
    reopen: () => { store.close(); store = new HubStore(file, 'synthetic-vault'); app = create(); },
    close: () => { store.close(); node.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
