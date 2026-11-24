import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandReceipts } from '../commands/receipts.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubQueueRoutes } from './queue-http.js';

test('Hub owners sharing a Connector credential have distinct mutation deliveries and private receipts', async () => {
  const f = fixture();
  try {
    const a = await f.mutate('a', 'edit', 'first'), b = await f.mutate('b', 'edit', 'second');
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const one = await a.json() as any, two = await b.json() as any;
    assert.equal(one.command.key, 'edit'); assert.notEqual(one.command.id, two.command.id);
    assert.equal(f.deliveries.length, 2); assert.notEqual(f.deliveries[0], f.deliveries[1]);
    const privateA = await f.mutate('a', 'a-only'); assert.equal(privateA.status, 200);
    assert.equal((await f.read('b', 'a-only')).status, 404);
    assert.equal((await f.mutate('a', 'edit', 'first')).status, 200); assert.equal(f.deliveries.length, 3);
    assert.equal((await f.mutate('a', 'edit', 'different')).status, 409);
    const receipt = await (await f.read('a', 'edit')).json() as any;
    assert.deepEqual(receipt.command.result, { status: 200, body: { ok: true } });
    assert.equal(JSON.stringify(receipt).includes('synthetic-private-upstream-field'), false);
  } finally { f.close(); }
});

test('Hub rejects unverified mutation targets and never recovers unknown receipts on changed authority', async () => {
  const f = fixture();
  try {
    f.store.upsertConnection({ id: 'unverified', ownerUserId: 'a', label: 'unverified', connectorUrl: 'http://synthetic', kind: 'remote', capabilities: [] });
    const unverified = `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('unverified', 'codex:s'))}/queue/q`;
    assert.equal((await f.app.request(unverified, { method: 'DELETE', headers: { owner: 'a', 'idempotency-key': 'key', 'if-match': '"1:1"' } })).status, 409);
    assert.equal(f.deliveries.length, 0);
    f.mode.lose = true;
    assert.equal((await f.mutate('a', 'unknown')).status, 202);
    const calls = f.calls.length;
    f.bump('a'); f.mode.lose = false;
    assert.equal((await f.read('a', 'unknown')).status, 409);
    assert.equal((await f.mutate('a', 'unknown')).status, 409);
    assert.equal(f.calls.length, calls, 'neither lookup nor redispatch may cross the original authority');
    assert.equal((await f.mutate('b', 'unknown')).status, 200, 'other owner remains independent');
  } finally { f.close(); }
});

test('Hub post-delivery authority failure leaves receipt unknown, not a false rejection', async () => {
  const f = fixture();
  try {
    f.mode.afterMutation = () => f.bump('a');
    assert.equal((await f.mutate('a', 'race')).status, 403);
    const scope = JSON.stringify(['owner-queue-mutation-v1', 'a', encodeHubSessionId('a-node', 'codex:s'), 'q']);
    assert.equal(f.store.commands.get(scope, 'race')?.state, 'outcome_unknown');
    assert.equal(f.deliveries.length, 1);
    assert.equal((await f.read('a', 'race')).status, 409); assert.equal(f.deliveries.length, 1);
  } finally { f.close(); }
});

test('Hub request-body wait cannot carry authorization to a new node generation', async () => {
  const f = fixture();
  try {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const response = f.app.request(f.path('a'), { method: 'PATCH', headers: { owner: 'a', 'idempotency-key': 'slow', 'if-match': '"1:1"' }, body, duplex: 'half' } as any);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.bump('a'); controller.enqueue(Buffer.from('{"message":"new text"}')); controller.close();
    assert.equal((await response).status, 403); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('Hub cannot settle a mismatched or malformed queue receipt; retries are GET-only', async () => {
  const f = fixture();
  try {
    for (const malformed of ['wrong-key', 'wrong-result', 'legacy-no-receipt']) {
      f.mode.malformed = malformed;
      assert.equal((await f.mutate('a', malformed)).status, 202);
      assert.equal((await f.mutate('a', malformed)).status, 202);
      assert.equal((await (await f.read('a', malformed)).json() as any).command.state, 'outcome_unknown');
    }
    assert.equal(f.deliveries.length, 3);
    f.mode.malformed = '';
    assert.equal((await (await f.read('a', 'wrong-key')).json() as any).command.state, 'accepted');
    assert.equal(f.deliveries.length, 3);
  } finally { f.close(); }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-queue-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic-vault');
  const db = new DatabaseSync(':memory:'), connectorReceipts = new CommandReceipts(db);
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  const deliveries: string[] = [], calls: string[] = [];
  const mode = { lose: false, malformed: '', afterMutation: () => {} };
  const bump = (owner: string) => store.upsertConnection({ id: `${owner}-node`, ownerUserId: owner, label: 'node', connectorUrl: 'http://synthetic', kind: 'remote', capabilities: [] });
  for (const owner of ['a', 'b']) { bump(owner); store.pinConnectionNode(`${owner}-node`, owner, store.connectionAuthority(`${owner}-node`, owner)!, nodeId); }
  const client = () => new ConnectorClient('http://synthetic', 'synthetic-shared-credential', async request => {
    calls.push(request.method);
    let command;
    if (request.method === 'GET') command = connectorReceipts.get('same-actor-session-queue', decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!));
    else {
      const key = request.headers.get('idempotency-key')!;
      deliveries.push(key);
      connectorReceipts.claim('same-actor-session-queue', key, { method: request.method, body: await request.text() });
      command = connectorReceipts.settle('same-actor-session-queue', key, { status: 200, body: { ok: true, private: 'synthetic-private-upstream-field' } });
      mode.afterMutation();
    }
    const headers = { [NODE_ID_HEADER]: nodeId };
    if (mode.lose) return Response.json({}, { status: 502, headers });
    if (command && mode.malformed === 'wrong-key') command = { ...command, key: 'forged' };
    if (command && mode.malformed === 'wrong-result') command = { ...command, result: { status: 200, body: { ok: false } } };
    if (mode.malformed === 'legacy-no-receipt') command = undefined;
    return Response.json(request.method === 'GET' ? { command } : { ok: command?.result?.body.ok, command }, { headers });
  }, undefined, undefined, { nodeId });
  const app = new Hono();
  registerHubQueueRoutes(app, '/api/hub/v1/sessions/:hubSessionId', { store, client,
    owner: c => { const owner = c.req.header('owner'); if (!owner || !['a', 'b'].includes(owner)) throw new HTTPException(401); return owner; },
    error: (c, error) => c.json({ error: 'synthetic request failure' }, error instanceof ConnectorClientError ? error.status as 502 : 502) });
  const path = (owner: string) => `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId(`${owner}-node`, 'codex:s'))}/queue/q`;
  const mutate = (owner: string, key: string, message = 'text') => app.request(path(owner), {
    method: 'PATCH', headers: { owner, 'idempotency-key': key, 'if-match': '"1:1"' }, body: JSON.stringify({ message }) });
  return { store, app, mode, deliveries, calls, bump, path, mutate,
    read: (owner: string, key: string) => app.request(`${path(owner)}/commands/${key}`, { headers: { owner } }),
    close: (() => {
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        try { store.close(); } finally { try { db.close(); } finally { rmSync(dir, { recursive: true, force: true }); } }
        assert.equal(existsSync(dir), false);
      };
    })() };
}

test('queue fixture cleanup is idempotent', () => {
  const fixtureState = fixture();
  fixtureState.close(); fixtureState.close();
});
