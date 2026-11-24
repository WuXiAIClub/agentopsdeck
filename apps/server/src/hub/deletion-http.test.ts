import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandReceipts } from '../commands/receipts.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { ConnectorClient } from './connector-client.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubDeletionRoutes } from './deletion-http.js';

test('deletion delivery keys isolate owners and Hubs sharing one Connector credential', async () => {
  const a = fixture(), b = fixture(a.connectorReceipts);
  try {
    for (const [f, owner] of [[a, 'a'], [a, 'b'], [b, 'a']] as const) {
      const response = await f.remove(owner, 'same');
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.command.key, 'same'); assert.equal(body.status, 'delete_accepted');
      assert.equal(JSON.stringify(body).includes('synthetic-private'), false);
    }
    assert.equal(new Set([...a.deliveries, ...b.deliveries]).size, 3);
    await a.remove('a', 'private');
    assert.equal((await a.read('b', 'private')).status, 404);
    assert.equal((await a.remove('a', 'same')).status, 200);
    assert.equal(a.deliveries.length, 3);
    assert.equal((await a.remove('a', 'same', 'codex:other')).status, 200);
    assert.equal(a.deliveries.length, 4, 'session identity is also isolated');
  } finally { b.close(); a.close(); }
});

test('lost deletion ACK and Hub restart recover only by GET; accepted replay preserves newer preferences', async () => {
  const f = fixture();
  try {
    f.store.setSessionPreference(f.id('a'), 'pinned', true, 'a');
    f.mode.lose = true;
    assert.equal((await f.remove('a', 'lost')).status, 202);
    assert.equal((await f.remove('a', 'lost')).status, 202);
    assert.equal(f.store.sessionPreferences('a').get(f.id('a'))?.pinned, true);
    f.reopen(); f.mode.lose = false;
    const read = await (await f.read('a', 'lost')).json() as any;
    assert.deepEqual(read.command.result, { status: 200, body: { ok: true, status: 'delete_accepted' } });
    assert.equal((await f.remove('a', 'lost')).status, 200);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.store.sessionPreferences('a').get(f.id('a'))?.pinned, true);
  } finally { f.close(); }
});

test('concurrent deletion duplicates never dispatch twice while the first response is pending', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    f.mode.afterMutation = () => held;
    const first = f.remove('a', 'concurrent');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await f.remove('a', 'concurrent')).status, 200);
    release(); assert.equal((await first).status, 200);
    assert.equal(f.deliveries.length, 1);
  } finally { release?.(); f.close(); }
});

test('unknown deletion cannot migrate to replaced credentials or node authority', async () => {
  const f = fixture();
  try {
    f.mode.lose = true; assert.equal((await f.remove('a', 'old')).status, 202);
    const calls = f.calls.length;
    f.bump('a'); f.mode.lose = false;
    f.store.pinConnectionNode('a-node', 'a', f.store.connectionAuthority('a-node', 'a')!, f.nodeId);
    assert.equal((await f.read('a', 'old')).status, 409);
    assert.equal((await f.remove('a', 'old')).status, 409);
    assert.equal(f.calls.length, calls);
    assert.equal((await f.remove('b', 'old')).status, 200);
  } finally { f.close(); }
});

test('post-delivery authorization failure is unknown and never retried on a replacement', async () => {
  const f = fixture();
  try {
    f.mode.afterMutation = () => { f.bump('a'); };
    assert.equal((await f.remove('a', 'race')).status, 403);
    assert.equal(f.store.commands.get(f.scope('a'), 'race')?.state, 'outcome_unknown');
    assert.equal((await f.read('a', 'race')).status, 409);
    assert.equal(f.deliveries.length, 1);
  } finally { f.close(); }
});

test('wrong node, receipt key, result or missing receipt cannot establish deletion success', async () => {
  const f = fixture();
  try {
    for (const malformed of ['node', 'key', 'result', 'missing']) {
      f.mode.malformed = malformed;
      assert.equal((await f.remove('a', malformed)).status, 202);
      assert.equal((await f.remove('a', malformed)).status, 202);
      assert.equal((await (await f.read('a', malformed)).json() as any).command.state, 'outcome_unknown');
    }
    assert.equal(f.deliveries.length, 4);
    f.mode.malformed = '';
    assert.equal((await (await f.read('a', 'node')).json() as any).command.state, 'accepted');
    assert.equal(f.deliveries.length, 4);
  } finally { f.close(); }
});

test('only matching durable rejection settles a deletion 4xx', async () => {
  const f = fixture();
  try {
    f.mode.status = 403;
    const response = await f.remove('a', 'reject');
    assert.equal(response.status, 403);
    assert.equal((await response.json() as any).command.state, 'rejected');
    assert.equal((await f.remove('a', 'reject')).status, 403);
    assert.equal(f.deliveries.length, 1);
    f.mode.malformed = 'missing';
    assert.equal((await f.remove('a', 'ambiguous')).status, 202);
  } finally { f.close(); }
});

test('projection failure after deletion acceptance cannot revert a durable ACK', async () => {
  const f = fixture();
  try {
    f.store.removeSessionPreferences = () => { throw new Error('synthetic projection failure'); };
    assert.equal((await f.remove('a', 'ack')).status, 200);
    f.reopen();
    assert.equal((await (await f.read('a', 'ack')).json() as any).command.state, 'accepted');
    assert.equal((await f.remove('a', 'ack')).status, 200);
    assert.equal(f.deliveries.length, 1);
  } finally { f.close(); }
});

test('unverified target, invalid key and receipt capacity prevent deletion dispatch', async () => {
  const f = fixture();
  try {
    assert.equal((await f.remove('a', 'invalid/key')).status, 400);
    f.bump('unverified');
    assert.equal((await f.remove('unverified', 'unverified')).status, 409);
    const db = new DatabaseSync(f.file);
    try { db.exec('UPDATE command_receipt_usage SET rows = 20000 WHERE singleton = 1'); } finally { db.close(); }
    assert.equal((await f.remove('b', 'capacity')).status, 503);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

function fixture(shared?: CommandReceipts) {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-delete-')), 'hub.sqlite');
  let store = new HubStore(file, 'synthetic-vault');
  const setup = new DatabaseSync(file);
  try {
    for (const owner of ['a', 'b']) setup.prepare('INSERT INTO users (id, label, created_at, updated_at) VALUES (?, ?, 1, 1)').run(owner, owner);
  } finally { setup.close(); }
  const db = new DatabaseSync(':memory:'), connectorReceipts = shared ?? new CommandReceipts(db);
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  const deliveries: string[] = [], calls: string[] = [];
  const mode = { lose: false, malformed: '', status: 200, afterMutation: (() => {}) as () => void | Promise<void> };
  const bump = (owner: string) => store.upsertConnection({ id: `${owner}-node`, ownerUserId: owner, label: 'node', connectorUrl: 'http://synthetic', kind: 'remote', capabilities: [] });
  for (const owner of ['a', 'b']) { bump(owner); store.pinConnectionNode(`${owner}-node`, owner, store.connectionAuthority(`${owner}-node`, owner)!, nodeId); }
  const client = () => new ConnectorClient('http://synthetic', 'synthetic-shared-credential', async request => {
    calls.push(request.method);
    const parts = new URL(request.url).pathname.split('/');
    const scope = `synthetic-actor-${parts[5]}`;
    let command;
    if (request.method === 'GET') command = connectorReceipts.get(scope, decodeURIComponent(parts.at(-1)!));
    else {
      const key = request.headers.get('idempotency-key')!;
      deliveries.push(key); connectorReceipts.claim(scope, key, {});
      command = connectorReceipts.settle(scope, key, { status: mode.status, body: { ok: mode.status === 200, private: 'synthetic-private' } });
      await mode.afterMutation();
    }
    const headers = { [NODE_ID_HEADER]: mode.malformed === 'node' ? 'node_00000000-0000-4000-8000-000000000002' : nodeId };
    if (mode.lose) return Response.json({}, { status: 502, headers });
    if (command && mode.malformed === 'key') command = { ...command, key: 'wrong' };
    if (command && mode.malformed === 'result') command = { ...command, result: { status: 200, body: { ok: false } } };
    if (mode.malformed === 'missing') command = undefined;
    return Response.json(request.method === 'GET' ? { command } : { ok: command?.result?.body.ok, command }, {
      status: request.method === 'GET' ? 200 : mode.status, headers,
    });
  }, undefined, undefined, { nodeId });
  const createApp = () => {
    const app = new Hono();
    registerHubDeletionRoutes(app, { store, client,
      owner: c => { const value = c.req.header('owner'); if (!value || !['a', 'b', 'unverified'].includes(value)) throw new HTTPException(401); return value; },
      error: c => c.json({ error: 'synthetic failure' }, 502) });
    return app;
  };
  let app = createApp();
  const id = (owner: string, session = 'codex:s') => encodeHubSessionId(`${owner}-node`, session);
  return { get store() { return store; }, file, mode, calls, deliveries, nodeId, connectorReceipts, bump, id,
    scope: (owner: string) => JSON.stringify(['owner-session-delete-v1', owner, id(owner)]),
    remove: (owner: string, key: string, session?: string) => app.request(`/api/sessions/${encodeURIComponent(id(owner, session))}`, { method: 'DELETE', headers: { owner, 'idempotency-key': key } }),
    read: (owner: string, key: string) => app.request(`/api/hub/v1/sessions/${encodeURIComponent(id(owner))}/deletion-commands/${key}`, { headers: { owner } }),
    reopen: () => { store.close(); store = new HubStore(file, 'synthetic-vault'); app = createApp(); },
    close: () => { store.close(); db.close(); },
  };
}
