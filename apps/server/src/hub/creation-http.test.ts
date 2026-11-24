import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandReceipts } from '../commands/receipts.js';
import { registerCreationReceipts } from '../commands/http.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { ConnectorClient } from './connector-client.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubCreationRoutes } from './creation-http.js';

test('creation delivery keys isolate two owners, two nodes and two Hubs sharing credentials', async () => {
  const a = fixture(), b = fixture(a.nodes);
  try {
    for (const [f, owner, node] of [[a, 'a', 0], [a, 'b', 0], [a, 'a', 1], [b, 'a', 0]] as const) {
      const response = await f.create(owner, 'same', node), body = await response.json() as any;
      assert.equal(response.status, 201); assert.equal(body.command.key, 'same');
      assert.equal(body.command.state, 'accepted'); assert.equal(body.sessionRef.nodeId, f.nodes[node]!.id);
      assert.equal(body.key, encodeHubSessionId(`${owner}-${node}`, body.remoteSessionKey));
      assert.equal(JSON.stringify(body).includes('synthetic-private'), false);
      assert.equal((await f.create(owner, 'same', node)).status, 201);
    }
    assert.equal(new Set([...a.deliveries, ...b.deliveries]).size, 4);
    assert.equal(a.nodes[0]!.writes, 3); assert.equal(a.nodes[1]!.writes, 1);
    await a.create('a', 'private');
    assert.equal((await a.read('b', 'private')).status, 404);
    assert.equal((await a.read('a', 'private', 1)).status, 404);
    assert.equal((await a.create('a', 'same', 0, '{"label":"changed"}')).status, 409);
    assert.equal((await a.create('a', 'same', 0, '{"label":"synthetic"}', 'other-agent')).status, 201);
  } finally { b.close(); a.close(); }
});

test('lost creation ACK survives Hub restart and recovers only by GET without a session ID', async () => {
  const f = fixture();
  try {
    f.mode.lose = true;
    assert.equal((await f.create('a', 'lost')).status, 202);
    assert.equal(f.nodes[0]!.writes, 1);
    f.reopen();
    assert.equal((await f.create('a', 'lost')).status, 202);
    assert.equal(f.deliveries.length, 1);
    f.mode.lose = false;
    const recovery = await f.read('a', 'lost'), body = await recovery.json() as any;
    assert.equal(body.command.state, 'accepted');
    assert.equal(body.command.result.body.remoteSessionKey, 'codex:synthetic-1');
    assert.equal(recovery.headers.get('cache-control'), 'no-store');
    const accepted = await f.create('a', 'lost');
    assert.equal(accepted.status, 201); assert.equal((await accepted.json() as any).key, body.command.result.body.key);
    assert.equal(f.deliveries.length, 1);
  } finally { f.close(); }
});

test('concurrent creation submits once and settled receipts need no online Connector', async () => {
  const f = fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.create('a', 'concurrent')));
    assert.ok(responses.every(response => [201, 202].includes(response.status)));
    assert.equal(f.deliveries.length, 1); assert.equal(f.nodes[0]!.writes, 1);
    assert.equal((await f.create('a', 'concurrent')).status, 201);
    f.reopen(); f.mode.lose = true;
    const calls = f.calls.length;
    assert.equal((await (await f.read('a', 'concurrent')).json() as any).command.state, 'accepted');
    assert.equal((await f.create('a', 'concurrent')).status, 201);
    assert.equal(f.calls.length, calls);
  } finally { f.close(); }
});

test('invalid creation bodies and command keys never reach the Connector', async () => {
  const f = fixture();
  try {
    for (const [key, body, status] of [
      ['bad key', '{}', 400], ['', '{}', 400], ['x'.repeat(201), '{}', 400],
      ['valid', 'null', 400], ['valid', '[]', 400], ['valid', '{', 400],
      ['valid', '{"idempotencyKey":"other"}', 400],
      ['valid', JSON.stringify({ label: 'x'.repeat(128 * 1024) }), 413],
    ] as const) assert.equal((await f.create('a', key, 0, body)).status, status);
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.store.commands.get(f.scope('a', 0), 'valid'), undefined);
    assert.equal((await f.create('a', 'valid', 0, '{"label":"synthetic","idempotencyKey":"valid"}')).status, 201);
    assert.equal((await f.create('a', 'valid')).status, 201);
    assert.equal(f.deliveries.length, 1);
  } finally { f.close(); }
});

test('creation uncertainty cannot migrate to a replacement node or credential', async () => {
  const f = fixture();
  try {
    f.mode.afterMutation = () => { f.bump('a', 0); };
    assert.equal((await f.create('a', 'race')).status, 403);
    assert.equal(f.store.commands.get(f.scope('a', 0), 'race')?.state, 'outcome_unknown');
    const calls = f.calls.length;
    assert.equal((await f.read('a', 'race')).status, 409);
    assert.equal((await f.create('a', 'race')).status, 409);
    assert.equal(f.calls.length, calls); assert.equal(f.nodes[0]!.writes, 1);
  } finally { f.close(); }
});

test('unverified, disabled, foreign and full-budget creation targets fail before dispatch', async () => {
  const f = fixture(undefined, true);
  try {
    assert.equal((await f.create('a', 'unverified')).status, 409);
    f.store.upsertConnection({ id: 'b-0', ownerUserId: 'b', label: 'disabled', connectorUrl: 'http://synthetic-0', kind: 'remote', status: 'disabled', capabilities: [] });
    assert.equal((await f.create('b', 'disabled')).status, 404);
    assert.equal((await f.app.request('/api/hub/v1/connections/a-1/agents/codex/sessions', { method: 'POST', headers: { owner: 'b' }, body: '{}' })).status, 404);
    const db = new DatabaseSync(f.file);
    try { db.exec('UPDATE command_receipt_usage SET bytes = 16777216 WHERE singleton = 1'); } finally { db.close(); }
    assert.equal((await f.create('a', 'full', 1)).status, 503);
    assert.equal(f.deliveries.length, 0);
  } finally { f.close(); }
});

test('creation only accepts the bound receipt with a valid canonical identity', async () => {
  const f = fixture();
  try {
    for (const malformed of ['node', 'key', 'missing', 'result', 'identity']) {
      f.mode.malformed = malformed;
      assert.equal((await f.create('a', malformed)).status, 202, malformed);
      assert.equal((await f.create('a', malformed)).status, 202, malformed);
      assert.equal((await (await f.read('a', malformed)).json() as any).command.state, 'outcome_unknown');
    }
    assert.equal(f.deliveries.length, 5); assert.equal(f.nodes[0]!.writes, 5);
    f.mode.malformed = '';
    assert.equal((await (await f.read('a', 'node')).json() as any).command.state, 'accepted');
    assert.equal(f.deliveries.length, 5);
  } finally { f.close(); }
});

test('only a durable rejection resolves rejected creation, not a bare upstream error', async () => {
  const f = fixture();
  try {
    f.nodes[0]!.reject = true;
    const rejected = await f.create('a', 'rejected');
    assert.equal(rejected.status, 409); assert.equal((await rejected.json() as any).command.state, 'rejected');
    assert.equal((await f.create('a', 'rejected')).status, 409); assert.equal(f.deliveries.length, 1);
    f.mode.lose = true;
    assert.equal((await f.create('a', 'bare-error')).status, 202);
  } finally { f.close(); }
});

test('creation pins original owner and node authority across asynchronous body reads', async () => {
  for (const change of ['owner', 'connection']) {
    const f = fixture();
    try {
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (change === 'owner') f.mode.owner = 'b'; else f.bump('a', 0);
        controller.enqueue(new TextEncoder().encode('{}')); controller.close();
      } }, { highWaterMark: 0 });
      const response = await f.app.fetch(new Request('http://synthetic/api/hub/v1/connections/a-0/agents/codex/sessions', {
        method: 'POST', headers: { owner: 'a', 'idempotency-key': 'body-race' }, body, duplex: 'half',
      } as RequestInit));
      assert.equal(response.status, 403); assert.equal(f.deliveries.length, 0);
      assert.equal(f.store.commands.get(f.scope('a', 0), 'body-race'), undefined);
    } finally { f.close(); }
  }
});

function connector(index: number) {
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  const node = { db, app, writes: 0, reject: false, id: `node_00000000-0000-4000-8000-00000000000${index + 1}` };
  app.use('*', async (c, next) => { c.header(NODE_ID_HEADER, node.id); await next(); });
  const path = '/api/connector/v1/agents/:agentId/sessions';
  registerCreationReceipts(app, path, { receipts, scope: c => JSON.stringify(['synthetic-shared-token', c.req.param('agentId')]) });
  app.post(path, c => {
    if (node.reject) return c.json({ error: 'synthetic-private' }, 409);
    node.writes++; const body = { key: `codex:synthetic-${node.writes}`, private: 'synthetic-private' };
    c.get('acknowledgeCreation')({ status: 201, body }); return c.json(body, 201);
  });
  return node;
}

function fixture(shared?: ReturnType<typeof connector>[], unverified = false) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-create-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic-vault');
  const setup = new DatabaseSync(file);
  for (const owner of ['a', 'b']) setup.prepare('INSERT INTO users (id,label,created_at,updated_at) VALUES (?,?,1,1)').run(owner, owner);
  setup.close();
  const nodes = shared ?? [connector(0), connector(1)], deliveries: string[] = [], calls: string[] = [];
  const mode = { lose: false, malformed: '', owner: '', afterMutation: (() => {}) as () => void };
  const bump = (owner: string, index: number, pin = true) => {
    const id = `${owner}-${index}`;
    store.upsertConnection({ id, ownerUserId: owner, label: 'node', connectorUrl: `http://synthetic-${index}`, kind: 'remote', capabilities: [] });
    if (pin) store.pinConnectionNode(id, owner, store.connectionAuthority(id, owner)!, nodes[index]!.id);
  };
  for (const owner of ['a', 'b']) for (const index of [0, 1]) bump(owner, index, !(unverified && owner === 'a' && index === 0));
  const client = (id: string) => {
    const node = nodes[Number(id.at(-1))]!;
    return new ConnectorClient('http://synthetic', 'synthetic-shared-credential', async request => {
      calls.push(request.method);
      if (request.method === 'POST') deliveries.push(request.headers.get('idempotency-key')!);
      const response = await node.app.fetch(request), body = await response.json() as any;
      if (request.method === 'POST') mode.afterMutation();
      const headers = { [NODE_ID_HEADER]: mode.malformed === 'node' ? nodes[1]!.id : node.id };
      if (mode.lose) return Response.json({}, { status: 502, headers });
      if (mode.malformed === 'missing') delete body.command;
      if (body.command && mode.malformed === 'key') body.command.key = 'wrong';
      if (body.command && mode.malformed === 'result') {
        body.command.state = 'outcome_unknown';
        if (body.command.result) body.command.result.status = 202;
      }
      if (mode.malformed === 'identity') {
        body.key = 'codex:';
        if (body.command?.result) body.command.result.body.key = 'codex:';
      }
      return Response.json(body, { status: response.status, headers });
    }, undefined, undefined, { nodeId: node.id });
  };
  const createApp = () => {
    const app = new Hono();
    registerHubCreationRoutes(app, { store, client,
      owner: c => { const owner = mode.owner || c.req.header('owner'); if (!owner || !['a', 'b'].includes(owner)) throw new HTTPException(401); return owner; },
      error: c => c.json({ error: 'synthetic failure' }, 502) });
    return app;
  };
  let app = createApp();
  const path = (owner: string, node: number, agent = 'codex') => `/api/hub/v1/connections/${owner}-${node}/agents/${agent}/sessions`;
  return { get app() { return app; }, get store() { return store; }, file, mode, nodes, calls, deliveries, bump,
    scope: (owner: string, node: number) => JSON.stringify(['create', JSON.stringify(['owner-session-create-v1', owner, `${owner}-${node}`, 'codex'])]),
    create: (owner: string, key: string, node = 0, body = '{"label":"synthetic"}', agent = 'codex') => app.request(path(owner, node, agent), { method: 'POST', headers: { owner, 'idempotency-key': key }, body }),
    read: (owner: string, key: string, node = 0) => app.request(`${path(owner, node)}/creation-commands/${key}`, { headers: { owner } }),
    reopen: () => { store.close(); store = new HubStore(file, 'synthetic-vault'); app = createApp(); },
    close: () => { store.close(); if (!shared) for (const node of nodes) node.db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
