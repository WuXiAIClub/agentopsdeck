import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HubStore, type HubConnection } from './hub-store.js';
import { HubEventBroker, HubEventBrokers } from './event-broker.js';
import { ConnectorClient } from './connector-client.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, 'original work did not settle'); await delay(5); }
}
function fixture(file = false, reconcileMs = 5) {
  const directory = file ? mkdtempSync(join(tmpdir(), 'agentopsdeck-async-directory-')) : undefined;
  const store = new HubStore(directory ? join(directory, 'hub.sqlite') : ':memory:', 'synthetic');
  store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://node', capabilities: ['events'], credentialToken: 'one' });
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: Request[] = [];
  const client = () => new ConnectorClient('http://node', store.getCredentialToken('node')!, async request => {
    requests.push(request);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.push(controller); controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const broker = new HubEventBroker(store, client, 'default', reconcileMs, 5);
  return { store, broker, client, streams, requests, async close() {
    await broker.drain(); await store.close(); if (directory) rmSync(directory, { recursive: true, force: true });
  } };
}
function delayedDirectory(store: HubStore) {
  const snapshot = store.listConnections();
  let resolve!: (rows: HubConnection[]) => void, reject!: (error: unknown) => void, calls = 0;
  const original = store.listConnectionsAsync.bind(store);
  const pending = new Promise<HubConnection[]>((yes, no) => { resolve = yes; reject = no; });
  store.listConnectionsAsync = () => { calls++; return pending; };
  return { snapshot, calls: () => calls, resolve: () => resolve(snapshot), reject,
    restore() { store.listConnectionsAsync = original; } };
}

// Hold the completed underlying read, not the public listConnectionsAsync
// method: its real before/after generation fence must observe the mutation.
function heldSnapshots(t: TestContext, store: HubStore) {
  const internals = store as any;
  const original = internals.readBrowserState.bind(store);
  const resumes: (() => void)[] = [];
  let calls = 0;
  t.mock.method(internals, 'readBrowserState', async (...args: any[]) => {
    const rows = await original(...args);
    if (args[2] === 'hub-connections-read') {
      calls++;
      await new Promise<void>(resolve => { resumes.push(resolve); });
    }
    return rows;
  });
  return { calls: () => calls, release: () => resumes.shift()?.(),
    restore() { t.mock.restoreAll(); for (const resume of resumes.splice(0)) resume(); } };
}

test('initial directory invalidation retains readiness and one original read across 40 browsers', async t => {
  const f = fixture(), h = heldSnapshots(t, f.store);
  const stops = Array.from({ length: 40 }, () => f.broker.acquire());
  let ready = false;
  const readiness = f.broker.directoryReady().then(() => { ready = true; });
  try {
    await until(() => h.calls() === 1);
    f.store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://node', credentialToken: 'two' });
    h.release();
    await until(() => h.calls() === 2);
    assert.equal(f.broker.isClosed, false);
    assert.equal(ready, false, 'a refused initial snapshot cannot authorize empty-scope replay');
    assert.equal(f.broker.pendingDirectoryReads, 1);
    assert.equal(f.streams.length, 0);
    await delay(25); assert.equal(h.calls(), 2, 'timer ticks cannot queue more original reads');
    h.restore(); await readiness;
    await until(() => f.streams.length === 1);
    assert.equal(f.broker.visibleDomain('node'), f.client().eventDomain);
  } finally { h.restore(); for (const stop of stops) stop(); await f.close(); }
});

test('credential rotation during a real directory read recovers without stale replay or broker closure', async t => {
  const f = fixture(), stop = f.broker.acquire();
  let h: ReturnType<typeof heldSnapshots> | undefined;
  try {
    await until(() => f.streams.length === 1); await f.broker.directoryReady();
    const oldDomain = f.client().eventDomain;
    f.streams[0]!.enqueue(new TextEncoder().encode('id: old-cursor\nevent: session.updated\ndata: {"type":"session.updated","payload":{}}\n\n'));
    await until(() => f.store.upstreamCursor('node', oldDomain) === 'old-cursor');
    h = heldSnapshots(t, f.store); await until(() => h!.calls() === 1);
    f.store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://node', credentialToken: 'two' });
    assert.equal(f.broker.visibleDomain('node'), undefined, 'old credentials disappear before directory refresh');
    assert.equal(f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.length, 0);
    h.release(); await until(() => h!.calls() === 2);
    assert.equal(f.broker.isClosed, false); h.restore();
    await until(() => f.streams.length === 2);
    assert.equal(f.requests[1]!.headers.get('last-event-id'), null);
    assert.equal(f.requests[1]!.headers.get('authorization'), 'Bearer two');
    assert.equal(f.store.upstreamCursor('node', f.client().eventDomain), undefined);
    assert.equal(f.store.upstreamCursor('node', oldDomain), 'old-cursor', 'rotation never rewrites the old cursor');
  } finally { h?.restore(); stop(); await f.close(); }
});

test('removal during initial enumeration recovers to an empty directory without admitting stale candidates', async t => {
  const f = fixture(), h = heldSnapshots(t, f.store), stop = f.broker.acquire();
  const ready = f.broker.directoryReady();
  try {
    await until(() => h.calls() === 1); f.store.deleteConnection('node');
    h.release(); await until(() => h.calls() === 2);
    assert.equal(f.broker.isClosed, false); h.restore(); await ready;
    assert.equal(f.streams.length, 0); assert.equal(f.broker.visibleDomains().size, 0);
  } finally { h.restore(); stop(); await f.close(); }
});

test('shutdown cancels only idle generation retry and does not wait for its long cadence', async t => {
  const f = fixture(false, 60_000), h = heldSnapshots(t, f.store), stop = f.broker.acquire();
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  try {
    await until(() => h.calls() === 1);
    f.store.upsertConnection({ id: 'node', label: 'Changed', connectorUrl: 'http://node' }); h.release();
    await until(() => performanceDiagnostics.snapshot().events.some(e => e.sequence > sequence
      && e.operation === 'hub-event-broker' && e.step === 8 && e.changed === 1));
    assert.equal(f.broker.pendingDirectoryReads, 1);
    let drained = false; const flight = f.broker.drain().then(() => { drained = true; });
    await until(() => drained); await flight;
    assert.equal(h.calls(), 1); assert.equal(f.broker.pendingWork, 0); assert.equal(f.streams.length, 0);
  } finally { h.restore(); stop(); await f.close(); }
});

test('only a completed generation refusal is retryable, not matching SQL error text', async t => {
  const f = fixture(); let reads = 0;
  const error = Error('hub_delivery_read_unavailable');
  t.mock.method(f.store, 'listConnectionsAsync', async () => { reads++; throw error; });
  const stop = f.broker.acquire();
  try {
    await f.broker.directoryReady(); assert.equal(f.broker.isClosed, true);
    await delay(25); assert.equal(reads, 1); assert.equal(f.streams.length, 0);
  } finally { t.mock.restoreAll(); stop(); await f.close(); }
});

test('broken diagnostics cannot replace a completed generation refusal or prevent recovery', async t => {
  const f = fixture(), h = heldSnapshots(t, f.store);
  t.mock.method(performanceDiagnostics, 'start', () => { throw Error('private-broken-sink'); });
  const stop = f.broker.acquire();
  try {
    await until(() => h.calls() === 1);
    f.store.upsertConnection({ id: 'node', label: 'Changed', connectorUrl: 'http://node' });
    h.release(); await until(() => h.calls() === 2);
    assert.equal(f.broker.isClosed, false); h.restore(); await f.broker.directoryReady();
    await until(() => f.streams.length === 1);
  } finally { h.restore(); stop(); await f.close(); }
});

test('file-backed directory uses the existing async reader without any synchronous whole-directory fallback', async t => {
  const f = fixture(true);
  t.mock.method(f.store, 'listConnections', () => { throw Error('forbidden whole-directory scan'); });
  try {
    const release = f.broker.acquire();
    await until(() => f.streams.length === 1);
    assert.equal(f.broker.visibleDomains().size, 1);
    assert.deepEqual(f.broker.deniedConnections(), []);
    f.streams[0]!.enqueue(new TextEncoder().encode('id: live\nevent: session.updated\ndata: {"type":"session.updated","payload":{"n":1}}\n\n'));
    await until(() => f.store.deliveryPage(undefined, f.broker.visibleDomains()).events.some(e => e.remoteEventId === 'live'));
    release();
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('timer ticks and concurrent browser interests coalesce one original directory read', async () => {
  const f = fixture(), d = delayedDirectory(f.store), handles: (() => void)[] = [];
  try {
    handles.push(f.broker.acquire());
    await until(() => d!.calls() === 1);
    for (let i = 0; i < 40; i++) handles.push(f.broker.acquire('node'));
    await delay(40);
    assert.equal(d.calls(), 1); assert.equal(f.broker.pendingDirectoryReads, 1);
    assert.equal(f.streams.length, 0);
    d.restore(); d.resolve();
    await until(() => f.streams.length === 1);
  } finally { d.restore(); d.resolve(); for (const stop of handles) stop(); await f.close(); }
});

for (const rejected of [false, true]) test(`retired directory retains owner admission until original ${rejected ? 'rejection' : 'reply'} and never starts a late feed`, async () => {
  const f = fixture(), d = delayedDirectory(f.store), registry = new HubEventBrokers(f.store, f.client);
  const handle = registry.acquire('default');
  try {
    await until(() => d.calls() === 1);
    handle.release();
    assert.equal(handle.events.pendingFeeds, 0); assert.equal(handle.events.pendingDirectoryReads, 1);
    assert.throws(() => registry.acquire('default'), /draining/);
    let settled = false;
    const drain = handle.events.drain().then(() => { settled = true; });
    await delay(20); assert.equal(settled, false);
    if (rejected) d.reject(Error('private-path-token-SQL')); else d.resolve();
    await drain;
    assert.equal(f.streams.length, 0);
    d.restore();
    await until(() => (registry as any).retiring.size === 0);
    const fresh = registry.acquire('default');
    await until(() => f.streams.length === 1); fresh.release();
  } finally { d.restore(); d.resolve(); handle.release(); await registry.drain(); await f.close(); }
});

test('stale enumeration cannot admit a node removed from the original owner', async () => {
  const f = fixture(), d = delayedDirectory(f.store), stop = f.broker.acquire();
  try {
    await until(() => d.calls() === 1);
    f.store.deleteConnection('node');
    d.resolve();
    await until(() => f.broker.pendingDirectoryReads === 0);
    assert.equal(f.streams.length, 0); assert.equal(f.broker.visibleDomains().size, 0);
  } finally { d.restore(); d.resolve(); stop(); await f.close(); }
});

test('node revocation suppresses live delivery before the next asynchronous directory reconciliation', async () => {
  const f = fixture(), stop = f.broker.acquire();
  let d: ReturnType<typeof delayedDirectory> | undefined;
  try {
    await until(() => f.streams.length === 1);
    const domain = f.client().eventDomain;
    d = delayedDirectory(f.store);
    await until(() => d!.calls() === 1);
    f.store.deleteConnection('node');
    f.streams[0]!.enqueue(new TextEncoder().encode('id: revoked\nevent: session.updated\ndata: {"type":"session.updated"}\n\n'));
    await delay(20);
    assert.equal(f.broker.visibleDomain('node'), undefined);
    assert.equal(f.store.deliveryPage(undefined, new Map([['node', domain]])).events.some(e => e.remoteEventId === 'revoked'), false);
    d.restore(); d.resolve();
  } finally { d?.restore(); d?.resolve(); stop(); await f.close(); }
});

test('pending directory diagnostics are numeric and cannot release original work', async () => {
  const f = fixture(), d = delayedDirectory(f.store), sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  const stop = f.broker.acquire();
  try {
    await until(() => d.calls() === 1); await delay(1_050);
    const rows = performanceDiagnostics.snapshot().events.filter(e => e.sequence > sequence && e.operation === 'hub-event-broker' && e.step === 8);
    assert.ok(rows.some(e => e.pending === 1));
    assert.doesNotMatch(JSON.stringify(rows), /synthetic|node|token|SELECT|sqlite|http:/);
    assert.equal(f.broker.pendingDirectoryReads, 1); assert.equal(d.calls(), 1);
  } finally { d.restore(); d.resolve(); stop(); await f.close(); }
});

test('an open original transaction refuses admission before launching any asynchronous read', async () => {
  const f = fixture(), d = delayedDirectory(f.store);
  const db = (f.store as any).db;
  try {
    db.exec('BEGIN');
    assert.throws(() => f.broker.acquire());
    assert.equal(d.calls(), 0); assert.equal(f.broker.pendingWork, 0);
    assert.equal(db.isTransaction, true, 'refusal never commits or rolls back the caller transaction');
  } finally { db.exec('ROLLBACK'); d.restore(); d.resolve(); await f.close(); }
});

test('a broken directory diagnostic cannot prevent original enumeration and feed cleanup', async t => {
  const f = fixture();
  t.mock.method(performanceDiagnostics, 'start', () => { throw Error('private-broken-sink'); });
  try {
    const stop = f.broker.acquire(); await until(() => f.streams.length === 1);
    stop(); await f.broker.drain(); assert.equal(f.broker.pendingWork, 0);
  } finally { t.mock.restoreAll(); await f.close(); }
});
