import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorClient } from './connector-client.js';
import { HubEventBrokers } from './event-broker.js';
import { HubStore } from './hub-store.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, 'original feed must settle'); await delay(5); }
}
function fixture() {
  const store = new HubStore(':memory:', 'private-key');
  store.upsertConnection({ id: 'node', label: 'private-node', connectorUrl: 'http://private-node',
    capabilities: ['events'], credentialToken: 'private-token' });
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const registry = new HubEventBrokers(store, () => new ConnectorClient('http://private-node', store.getCredentialToken('node')!, async () =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.push(controller); controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
    }), { headers: { 'content-type': 'text/event-stream' } })));
  return { store, registry, streams, db: (store as unknown as { db: DatabaseSync }).db,
    async close() { await registry.drain(); await store.close(); } };
}
const sqlError = () => Object.assign(Error('private-local-SQL-token-path'), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
function originalFailure(sequence: number, step: number) {
  const rows = performanceDiagnostics.snapshot().events.filter(e => e.sequence > sequence && e.operation === 'hub-event-broker');
  assert.ok(rows.some(e => e.step === step && e.sqlErrorCode === 1811 && e.unknown === 1 && e.category === 'failed'));
  assert.doesNotMatch(JSON.stringify(rows), /private|SQL-token|http:\/\//);
}

for (const kind of ['cursor', 'append'] as const) test(`original ${kind} SQL failure closes the feed without network retry or capacity leakage`, async t => {
  const f = fixture(), error = sqlError();
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  let calls = 0;
  if (kind === 'cursor') t.mock.method(f.store, 'upstreamCursor', () => { calls++; throw error; });
  else t.mock.method(f.store, 'appendDelivery', () => { calls++; throw error; });
  const handle = f.registry.acquire('default');
  try {
    await until(() => handle.events.isClosed);
    assert.ok(handle.events.closedSignal.aborted);
    assert.equal((handle.events as any).upstreams.size, 0);
    assert.equal((handle.events as any).timer, undefined);
    await delay(25);
    assert.equal(calls, 1, 'an unknown original SQL attempt is never replayed');
    originalFailure(sequence, 3);
    handle.release(); handle.release();
    assert.equal((f.registry as any).subscribers, 0);
    assert.equal((f.registry as any).brokers.size, 0);
    t.mock.restoreAll();
    const fresh = f.registry.acquire('default');
    assert.equal(fresh.events.isClosed, false); fresh.release();
  } finally { t.mock.restoreAll(); handle.release(); await f.close(); }
});

for (const kind of ['disconnected', 'rotated'] as const) test(`${kind} gap SQL failure is not swallowed or replayed during cleanup`, async t => {
  const f = fixture(), handle = f.registry.acquire('default');
  await until(() => f.streams.length === 1 && f.store.latestDeliveryCursor() !== undefined);
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  let gaps = 0;
  try {
    t.mock.method(f.store.completions, 'markGap', () => { gaps++; throw sqlError(); });
    const wait = handle.events.wait(handle.events.revision, new AbortController().signal, 60_000);
    if (kind === 'disconnected') f.streams[0]!.close();
    else {
      f.store.upsertConnection({ id: 'node', label: 'private-node', connectorUrl: 'http://private-node',
        capabilities: ['events'], credentialToken: 'private-rotated-token' });
      assert.doesNotThrow(() => (handle.events as any).reconcileSafely());
    }
    await until(() => handle.events.isClosed);
    await wait;
    assert.equal((handle.events as any).upstreams.size, 0);
    assert.equal((handle.events as any).timer, undefined);
    handle.release(); handle.release();
    assert.equal(gaps, 1, 'cleanup does not retry the failed original gap');
    assert.equal(f.streams.length, 1);
    assert.equal((f.registry as any).subscribers, 0);
    originalFailure(sequence, kind === 'disconnected' ? 3 : 2);
  } finally { t.mock.restoreAll(); handle.release(); await f.close(); }
});

test('first admission requires an independent successful gap before opening a new feed', async t => {
  const f = fixture();
  let gaps = 0;
  const error = sqlError(), original = f.store.completions.markGap.bind(f.store.completions);
  try {
    t.mock.method(f.store.completions, 'markGap', () => { gaps++; throw error; });
    assert.throws(() => f.registry.acquire('default'), e => e === error);
    assert.equal(gaps, 1); assert.equal(f.streams.length, 0);
    assert.equal((f.registry as any).subscribers, 0); assert.equal((f.registry as any).brokers.size, 0);
    t.mock.method(f.store.completions, 'markGap', original);
    const handle = f.registry.acquire('default');
    assert.equal(handle.events.isClosed, false); handle.release();
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('fresh admission after failed gap preserves unread facts and invalidates old runtime witnesses', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  await until(() => f.streams.length === 1);
  f.store.completions.baseline('default', 'session', 'epoch', 1);
  f.store.completions.record({ owner: 'default', target: 'session', epoch: 'epoch', turnId: 'turn',
    sourceCursor: 2, provenance: 'live-successful-message' });
  const before = f.db.prepare('SELECT * FROM completion_events').all();
  f.db.exec("CREATE TRIGGER fail_gap BEFORE UPDATE OF gap ON completion_targets BEGIN SELECT RAISE(ABORT,'private-gap-SQL'); END");
  try {
    assert.throws(() => handle.release());
    assert.equal(f.db.prepare('SELECT gap FROM completion_targets').get()!.gap, 0);
    f.db.exec('DROP TRIGGER fail_gap');
    // The failed SQL release is not an ACK for its still-pending pump.
    await handle.events.drain();
    const fresh = f.registry.acquire('default');
    try {
      assert.equal(f.db.prepare('SELECT gap FROM completion_targets').get()!.gap, 1);
      assert.deepEqual(f.db.prepare('SELECT * FROM completion_events').all(), before);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM completion_runtime').get()!.n, 0);
    } finally { fresh.release(); }
  } finally { f.db.exec('DROP TRIGGER IF EXISTS fail_gap'); handle.release(); await f.close(); }
});

test('real append cursor SQL abort rolls back its event and retains the original cursor without replay', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  await until(() => f.streams.length === 1 && f.store.latestDeliveryCursor() !== undefined);
  f.store.appendDelivery({ envConnectionId: 'node', type: 'message.created', ts: 1, payload: {} },
    // Match the exact original upstream credential domain, not a replacement.
    (handle.events as any).upstreams.get('node').domain, 'original-cursor');
  const events = f.db.prepare('SELECT * FROM hub_events').all();
  const cursors = f.db.prepare('SELECT * FROM remote_event_cursors').all();
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  f.db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON remote_event_cursors BEGIN SELECT RAISE(ABORT,'private-cursor-SQL'); END");
  try {
    f.streams[0]!.enqueue(new TextEncoder().encode('id: next-cursor\nevent: message.created\ndata: {"type":"message.created","payload":{}}\n\n'));
    await until(() => handle.events.isClosed);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(f.db.prepare('SELECT * FROM hub_events').all(), events);
    assert.deepEqual(f.db.prepare('SELECT * FROM remote_event_cursors').all(), cursors);
    await delay(25); assert.equal(f.streams.length, 1);
    originalFailure(sequence, 3);
    handle.release(); assert.equal((f.registry as any).subscribers, 0);
  } finally { f.db.exec('DROP TRIGGER IF EXISTS fail_cursor'); handle.release(); await f.close(); }
});
