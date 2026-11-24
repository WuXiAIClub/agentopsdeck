import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { connectionCompletionTarget } from '../hub/completion-unread-store.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { registerHubCompletions } from './hub-completions.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'completion-routes-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), app = new Hono();
  store.upsertConnection({ id: 'node', label: 'Synthetic', connectorUrl: 'http://node', capabilities: ['events'], credentialToken: 'test' });
  store.pinConnectionNode('node', 'default', store.connectionAuthority('node')!, 'node_00000000-0000-4000-8000-000000000001');
  let authorized = true;
  registerHubCompletions(app, store, c => {
    if (!authorized || !c.req.header('x-user')) throw new HTTPException(401);
    return { userId: c.req.header('x-user')!, admin: false };
  });
  const key = encodeHubSessionId('node', 'codex:one'), target = () => connectionCompletionTarget(store.getConnection('node')!.nodeId!, 'node', store.connectionAuthority('node')!, 'codex:one');
  const request = (action: string, body: unknown, user = 'default') => app.request(`/api/hub/v1/completions/${action}`, { method: 'POST', headers: { 'x-user': user }, body: JSON.stringify(body) });
  let cursor = 0;
  const event = (phase: string, turnId = 'turn1', time = 110, since = 100, extra = {}) => store.appendDelivery({
    envConnectionId: 'node', type: 'session.updated', remoteSessionKey: 'codex:one', ts: time,
    payload: { runtime: { phase, turnId, lastEventAt: time, operation: 'message', connection: 'connected', sync: 'current', ...extra } },
  }, 'domain', String(++cursor), 'default', since);
  return { store, app, key, target, request, event, revoke: () => { authorized = false; }, close: async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Hub database reopen preserves completed unread but removes pending live witnesses and marks coverage gap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'completion-restart-')), path = join(dir, 'hub.sqlite');
  let store = new HubStore(path, 'synthetic');
  try {
    store.completions.baseline('default', 'target', 'epoch', 10);
    store.completions.record({ owner: 'default', target: 'target', epoch: 'epoch', turnId: 'completed', sourceCursor: 11, provenance: 'live-successful-message' });
    const db = (store as any).db;
    db.exec('BEGIN IMMEDIATE');
    store.completions.ingest('default', 'target', 'epoch', {
      runtime: { phase: 'running', turnId: 'pending', lastEventAt: 110, operation: 'message', connection: 'connected', sync: 'current' },
    }, 100, 110);
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT count(*) n FROM completion_runtime').get().n, 1);
    await store.close(); store = new HubStore(path, 'synthetic');
    assert.equal((store as any).db.prepare('SELECT count(*) n FROM completion_runtime').get().n, 0);
    const summary = store.completions.summary('default', ['target'])[0]!;
    assert.equal(summary.unread, true); assert.equal(summary.coverage, 'gap'); assert.equal(summary.latestSequence, 1);
  } finally { await store.close(); rmSync(dir, { recursive: true }); }
});

test('real Codex projection run events create unread for a session in an inactive layout', async () => {
  const f = fixture(), database = new ConnectorUserStore(':memory:'), deck = new DeckStore();
  const sessionKey = 'codex:one', since = Date.now() - 1000;
  deck.bindCodexExecutions(database.codexExecutions, () => 'connection');
  const forward = () => {
    for (const event of deck.getEventsSince()) {
      f.store.appendDelivery({ ...event, envConnectionId: 'node', remoteSessionKey: event.sessionKey },
        'domain', event.id, 'default', since);
    }
  };
  try {
    const facts = database.codexExecutions;
    facts.begin(sessionKey, 'command', 'connection');
    facts.acknowledge(sessionKey, 'command', 'connection', 'turn', () => {});
    deck.upsertSession({ sessionKey, agentId: 'codex', source: 'codex', title: 'Synthetic', status: 'running' });
    forward();
    facts.observe(sessionKey, 'connection', 'turn', 'completed');
    deck.projectOpenClawExecution(sessionKey);
    forward();
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.unread, false, 'syncing is not complete');
    facts.settleHistory({ sessionKey, commandId: 'command', runId: 'turn' }, 'current');
    deck.projectOpenClawExecution(sessionKey);
    forward();
    const response = await f.request('summary', { sessions: [f.key] });
    const { items } = await response.json();
    assert.equal(items[0]?.unread, true);
    assert.equal(items[0]?.latestSequence, 1);
    forward();
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.latestSequence, 1, 'replayed transport IDs do not duplicate');
  } finally { database.close(); await f.close(); }
});

test('journal ingestion requires a fresh successful message witness and commits with the source cursor', async () => {
  const f = fixture();
  try {
    f.event('completed');
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.unread, false);
    f.event('running', 'history', 50); f.event('completed', 'history', 60);
    f.event('running', 'compact', 110, 100, { operation: 'compact' }); f.event('completed', 'compact', 115);
    f.event('running', 'failed'); f.event('failed', 'failed'); f.event('completed', 'failed');
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.latestSequence, 0);
    f.event('running');
    const db = (f.store as any).db;
    db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON remote_event_cursors BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(() => f.event('completed'), /test rollback/);
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.latestSequence, 0);
    db.exec('DROP TRIGGER fail_cursor');
    f.event('completed'); f.event('running'); f.event('completed');
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.latestSequence, 1, 'turn dedup survives repeated running snapshots');
    f.event('running', 'disconnected', 120); f.event('completed', 'disconnected', 220, 200);
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.latestSequence, 1, 'old witness cannot bridge a reconnect');
    f.event('running', 'fresh', 210, 200); f.event('completed', 'fresh', 220, 200);
    assert.equal(f.store.completions.summary('default', [f.target()])[0]?.latestSequence, 2);
  } finally { await f.close(); }
});

test('owner routes pin authority and proof ceiling; old ACK cannot clear new completions', async () => {
  const f = fixture();
  try {
    f.event('running'); f.event('completed');
    const summary = await f.request('summary', { sessions: [f.key, f.key] });
    assert.equal(summary.headers.get('cache-control'), 'no-store');
    assert.equal((await summary.json()).items.length, 1);
    assert.deepEqual((await (await f.request('summary', { sessions: [f.key] }, 'other')).json()).items, []);
    assert.equal((await f.request('observe', { sessionKey: f.key }, 'other')).status, 404);
    assert.equal((await f.request('summary', { sessions: Array(257).fill(f.key) })).status, 400);
    assert.equal((await f.request('summary', { sessions: ['invalid'] })).status, 400);
    const proof = await (await f.request('observe', { sessionKey: f.key })).json();
    f.event('running', 'turn2'); f.event('completed', 'turn2');
    assert.equal(proof.turnId, 'turn1', 'automatic read can verify the rendered turn against this ceiling');
    const successorProof = await (await f.request('observe', { sessionKey: f.key })).json();
    assert.equal(successorProof.turnId, 'turn2');
    assert.equal(successorProof.throughSequence, proof.throughSequence + 1);
    const ack = { sessionKey: f.key, requestId: randomUUID(), token: proof.token, throughSequence: proof.throughSequence };
    assert.equal((await f.request('read', { ...ack, throughSequence: 2 })).status, 409);
    assert.equal((await f.request('read', ack)).status, 200);
    assert.equal((await f.request('read', ack)).status, 200);
    const row = (await (await f.request('summary', { sessions: [f.key] })).json()).items[0];
    assert.equal(row.unread, true); assert.equal(row.readThrough, 1); assert.equal(row.latestSequence, 2);
    f.store.upsertConnection({ id: 'node', label: 'Rotated', connectorUrl: 'http://node', capabilities: ['events'], credentialToken: 'rotated' });
    assert.equal((await f.request('read', ack)).status, 409, 'old proof/receipt cannot cross authority rotation');
    assert.deepEqual((await (await f.request('summary', { sessions: [f.key] })).json()).items, []);
    f.revoke(); assert.equal((await f.request('summary', { sessions: [f.key] })).status, 401);
  } finally { await f.close(); }
});

test('authorization is rechecked after request body await', async () => {
  const f = fixture();
  try {
    const body = new ReadableStream({ start(controller) { setTimeout(() => { f.revoke(); controller.enqueue(new TextEncoder().encode(JSON.stringify({ sessions: [f.key] }))); controller.close(); }, 5); } });
    const request = new Request('http://local/api/hub/v1/completions/summary', { method: 'POST', headers: { 'x-user': 'default' }, body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401);
  } finally { await f.close(); }
});

test('same-node aliases deduplicate display identity but cannot borrow an observation proof', async () => {
  const f = fixture();
  try {
    f.store.upsertConnection({ id: 'alias', label: 'Alias', connectorUrl: 'http://alias', capabilities: ['events'], credentialToken: 'other-scope' });
    f.store.pinConnectionNode('alias', 'default', f.store.connectionAuthority('alias')!, f.store.getConnection('node')!.nodeId!);
    f.event('running'); f.event('completed');
    for (const phase of ['running', 'completed']) f.store.appendDelivery({ envConnectionId: 'alias', type: 'session.updated', remoteSessionKey: 'codex:one', ts: 120,
      payload: { runtime: { phase, turnId: 'turn1', lastEventAt: 120, operation: 'message', connection: 'connected', sync: 'current' } } }, 'alias-domain', phase, 'default', 100);
    const alias = encodeHubSessionId('alias', 'codex:one');
    const rows = (await (await f.request('summary', { sessions: [f.key, alias] })).json()).items;
    assert.equal(rows.length, 2); assert.equal(rows[0].displayTarget, rows[1].displayTarget);
    assert.notEqual(rows[0].generation, rows[1].generation);
    const proof = await (await f.request('observe', { sessionKey: f.key })).json();
    assert.equal((await f.request('read', { sessionKey: alias, token: proof.token, throughSequence: proof.throughSequence, requestId: randomUUID() })).status, 409);
  } finally { await f.close(); }
});

test('coverage gaps preserve observed completions but invalidate unfinished witnesses', async () => {
  const f = fixture();
  try {
    f.event('running'); f.event('completed'); f.event('running', 'pending');
    f.store.completions.markGap('default');
    f.event('completed', 'pending');
    let row = f.store.completions.summary('default', [f.target()])[0]!;
    assert.equal(row.coverage, 'gap'); assert.equal(row.latestSequence, 1); assert.equal(row.unread, true);
    f.event('running', 'new'); f.event('completed', 'new');
    row = f.store.completions.summary('default', [f.target()])[0]!;
    assert.equal(row.latestSequence, 2); assert.equal(row.coverage, 'gap', 'fresh event is not complete-history proof');
  } finally { await f.close(); }
});
