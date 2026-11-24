import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorClient } from './connector-client.js';
import { HubEventBrokers } from './event-broker.js';
import { HubStore } from './hub-store.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import type { DatabaseSync } from 'node:sqlite';

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) { assert.ok(performance.now() < deadline); await delay(5); }
}
function fixture() {
  const store = new HubStore(':memory:', 'private-key');
  const member = store.createUser('private-member').id;
  for (const ownerUserId of ['default', member]) store.upsertConnection({ id: `node-${ownerUserId}`,
    ownerUserId, label: 'private-node', connectorUrl: 'http://private-node',
    capabilities: ['events'], credentialToken: 'private-token' });
  let cancelled = 0;
  const registry = new HubEventBrokers(store, () => new ConnectorClient('http://private-node', 'private-token', async () =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
      cancel() { cancelled++; },
    }), { headers: { 'content-type': 'text/event-stream' } })));
  return { store, member, registry, cancelled: () => cancelled,
    async close() { try { await registry.drain(); } finally { await store.close(); } } };
}

test('gap SQL failure cannot retain a released subscription or prevent fresh admission', async t => {
  const f = fixture(), original = f.store.completions.markGap.bind(f.store.completions);
  const error = Object.assign(Error('private-gap-SQL'), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  const handle = f.registry.acquire('default');
  await delay(10);
  try {
    t.mock.method(f.store.completions, 'markGap', () => { throw error; });
    assert.throws(() => handle.release(), e => e === error);
    assert.doesNotThrow(() => handle.release(), 'original release is idempotent after SQL failure');
    assert.equal((f.registry as any).subscribers, 0);
    assert.equal((f.registry as any).brokers.size, 0);
    assert.equal((handle.events as any).upstreams.size, 0);
    assert.equal((handle.events as any).timer, undefined);
    await until(() => f.cancelled() === 1);
    await handle.events.drain();
    const observations = performanceDiagnostics.snapshot().events.filter(row => row.sequence > sequence && row.operation === 'hub-event-broker');
    assert.ok(observations.some(row => row.sqlErrorCode === 1811 && row.unknown === 1 && row.category === 'failed'));
    assert.doesNotMatch(JSON.stringify(observations), /private|1811.*SQL/);
    t.mock.method(f.store.completions, 'markGap', original);
    const fresh = f.registry.acquire('default');
    assert.equal(fresh.events.isClosed, false); fresh.release();
    assert.equal((f.registry as any).subscribers, 0);
  } finally { t.mock.restoreAll(); handle.release(); await f.close(); }
});

test('registry shutdown cleans all owner feeds and wakes waiters despite the first gap SQL failure', async t => {
  const f = fixture();
  const handles = [f.registry.acquire('default'), f.registry.acquire(f.member)];
  await delay(10);
  const error = Error('private-gap-SQL');
  const waits = handles.map(handle => handle.events.wait(handle.events.revision, new AbortController().signal, 60_000));
  try {
    t.mock.method(f.store.completions, 'markGap', () => { throw error; });
    assert.throws(() => f.registry.close(), e => e === error);
    assert.ok(handles.every(handle => handle.events.isClosed && handle.events.closedSignal.aborted));
    assert.ok(handles.every(handle => (handle.events as any).upstreams.size === 0));
    assert.equal((f.registry as any).brokers.size, 0);
    await Promise.all(waits);
    await until(() => f.cancelled() === 2);
    for (const handle of handles) { handle.release(); handle.release(); }
    assert.equal((f.registry as any).subscribers, 0);
    assert.throws(() => f.registry.acquire('default'), /closed/);
  } finally { t.mock.restoreAll(); for (const handle of handles) handle.release(); await assert.rejects(f.close(), e => e === error); }
});

test('real gap transaction abort preserves completion facts while original subscription capacity releases', async () => {
  const f = fixture(), db = (f.store as unknown as { db: DatabaseSync }).db;
  const handle = f.registry.acquire('default');
  f.store.completions.baseline('default', 'session', 'epoch', 1);
  f.store.completions.record({ owner: 'default', target: 'session', epoch: 'epoch', turnId: 'turn',
    sourceCursor: 2, provenance: 'live-successful-message' });
  const before = db.prepare('SELECT * FROM completion_targets').all();
  const events = db.prepare('SELECT * FROM completion_events').all();
  db.exec("CREATE TRIGGER fail_gap BEFORE UPDATE OF gap ON completion_targets BEGIN SELECT RAISE(ABORT,'private-gap-SQL'); END");
  await delay(10);
  try {
    assert.throws(() => handle.release(), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
    assert.equal(db.isTransaction, false);
    assert.deepEqual(db.prepare('SELECT * FROM completion_targets').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM completion_events').all(), events);
    assert.equal((f.registry as any).subscribers, 0);
    await until(() => f.cancelled() === 1);
    db.exec('DROP TRIGGER fail_gap');
    // Only the explicit later operation writes a gap. Cleanup never claims a
    // successful original COMMIT, clears unread, or replays the failed SQL.
    f.store.completions.markGap('default');
    assert.equal(db.prepare('SELECT gap FROM completion_targets').get()!.gap, 1);
    assert.deepEqual(db.prepare('SELECT * FROM completion_events').all(), events);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_gap'); handle.release(); await f.close(); }
});

test('periodic reconciliation failure still closes and wakes its original feed when gap persistence also fails', async t => {
  const f = fixture(), handle = f.registry.acquire('default');
  await delay(10);
  const waiting = handle.events.wait(handle.events.revision, new AbortController().signal, 60_000);
  try {
    t.mock.method(f.store, 'listConnectionsAsync', async () => { throw Error('private-read-SQL'); });
    t.mock.method(f.store.completions, 'markGap', () => { throw Error('private-gap-SQL'); });
    assert.doesNotThrow(() => (handle.events as any).reconcileSafely());
    await until(() => handle.events.isClosed);
    await waiting;
    await until(() => f.cancelled() === 1);
    handle.release(); handle.release();
    assert.equal((f.registry as any).subscribers, 0);
    assert.equal((f.registry as any).brokers.size, 0);
  } finally { t.mock.restoreAll(); handle.release(); await f.close(); }
});
