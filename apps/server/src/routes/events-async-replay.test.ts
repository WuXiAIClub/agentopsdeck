import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from '../connector/async-connector-owner.js';
import { AsyncConnectorEventProjection } from '../connector/async-event-projection.js';
import { registerEventRoutes, replayStoreEvents, type EventReplayPage, type EventReplayRead } from './events.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
const decode = (value: ReadableStreamReadResult<Uint8Array>) => new TextDecoder().decode(value.value);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(replay: EventReplayRead, authorize: () => boolean = () => true, waitMs?: number) {
  const app = new Hono(), store = new DeckStore(), rows: string[] = [];
  const routes = registerEventRoutes(app, store, authorize, undefined, replay, new PerformanceDiagnostics(row => rows.push(row)),
    waitMs === undefined ? {} : { waitMs });
  return { app, store, rows, routes };
}
const empty: EventReplayPage = { cursor: 'head', known: true, events: [] };

for (const outcome of ['resolve', 'reject'] as const) test(`event replay timeout stops delivery but retains original ${outcome} until close drains`, { timeout: 5000 }, async () => {
  const original = deferred<EventReplayPage>(), entered = deferred<void>(); let calls = 0;
  const { app, routes, rows, store } = setup(() => { calls++; entered.resolve(); return original.promise; }, () => true, 80);
  const reader = (await app.request('/api/events/stream?lastEventId=old')).body!.getReader();
  let close: Promise<void> | undefined;
  try {
    await entered.promise;
    assert.equal((await reader.read()).done, true, 'client wait ends without original owner settlement');
    let drained = false; close = routes.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(calls, 1);
    if (outcome === 'resolve') original.resolve({ cursor: 'new', known: true, events: [{ id: 'new', type: 'session.updated', ts: 1, payload: 'PRIVATE LATE BODY' }] });
    else original.reject(Error('PRIVATE SQL FAILURE'));
    await close; assert.equal(drained, true); assert.equal(calls, 1); assert.equal(store.changes.waiting, 0);
    assert.ok(rows.map(row => JSON.parse(row)).some(row => row.operation === 'connector-event-stream' && row.timedOut === 1));
    assert.doesNotMatch(rows.join(''), /PRIVATE|new|old/);
  } finally { original.resolve(empty); await reader.cancel(); await (close ?? routes.close()); }
});

test('compatibility replay reads fresh tail and expired cursor without replaying private records', () => {
  const store = new DeckStore();
  const anchor = store.append('session.updated', { private: 'old' });
  const latest = store.append('session.updated', { private: 'new' });
  assert.deepEqual(replayStoreEvents(store, null), { cursor: latest.id, known: true, events: [] });
  assert.deepEqual(replayStoreEvents(store, 'expired'), { cursor: latest.id, known: false, events: [] });
  assert.deepEqual(replayStoreEvents(store, ''), { cursor: latest.id, known: false, events: [] });
  assert.deepEqual(replayStoreEvents(store, anchor.id).events.map(event => event.id), [latest.id]);
});

for (const outcome of ['resolve', 'reject'] as const) test(`drain waits the original async replay after client cancellation, late ${outcome}`, { timeout: 3000 }, async () => {
  const original = deferred<EventReplayPage>(), entered = deferred<void>(); let calls = 0;
  const { app, rows, routes } = setup(() => { calls++; entered.resolve(); return original.promise; });
  const controller = new AbortController();
  const response = await app.request('/api/events/stream?lastEventId=anchor', { signal: controller.signal });
  const reader = response.body!.getReader(); await entered.promise;
  controller.abort(); await reader.cancel();
  let closed = false; const close = routes.close(); void close.then(() => { closed = true; });
  assert.equal(close, routes.close()); await tick(); assert.equal(closed, false); assert.equal(calls, 1);
  if (outcome === 'resolve') original.resolve({ cursor: 'anchor', known: true, events: [] }); else original.reject(Error('PRIVATE SQL and body'));
  await close; assert.equal(closed, true); assert.equal(calls, 1);
  const logs = rows.map(row => JSON.parse(row)).filter(row => row.operation === 'connector-event-stream');
  // The original read settled, but its result can no longer be delivered after
  // cancellation. Record both facts instead of calling the late resolve a
  // successful request or labelling a read rejection an unknown business write.
  assert.ok(logs.some(row => row.step === 2 && row.admitted === 1 && row.settled === 1 && row.category === 'failed'));
  assert.ok(logs.some(row => row.step === 0 && row.cancelled === 1 && row.category === 'failed'));
  assert.equal(logs.some(row => row.unknown === 1), false);
  assert.doesNotMatch(rows.join(''), /PRIVATE|anchor|head/);
});

test('permission revoked during original replay prevents every private frame', { timeout: 3000 }, async () => {
  const original = deferred<EventReplayPage>(), entered = deferred<void>(); let allowed = true;
  const { app, store, routes } = setup(() => { entered.resolve(); return original.promise; }, () => allowed);
  const reader = (await app.request('/api/events/stream?lastEventId=old')).body!.getReader();
  await entered.promise; allowed = false;
  original.resolve({ cursor: 'new', known: true, events: [{ id: 'new', type: 'session.updated', ts: 1, payload: 'PRIVATE' }] });
  const chunks: string[] = [];
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(decode(chunk)); }
  assert.doesNotMatch(chunks.join(''), /PRIVATE|session.updated/);
  assert.equal(store.changes.waiting, 0); await routes.close();
});

test('one async page produces explicit reset and never invokes synchronous journal methods', { timeout: 3000 }, async () => {
  let calls = 0;
  const { app, store, routes } = setup(after => {
    calls++; assert.equal(after, 'expired'); return Promise.resolve({ cursor: 'new', known: false, events: [] });
  });
  store.latestEventId = () => { throw Error('must not use sync fallback'); };
  store.hasEvent = () => { throw Error('must not use sync fallback'); };
  store.getEventsSince = () => { throw Error('must not use sync fallback'); };
  const reader = (await app.request('/api/events/stream?lastEventId=expired')).body!.getReader();
  assert.match(decode(await reader.read()), /heartbeat/);
  const reset = decode(await reader.read()); assert.match(reset, /stream.reset/); assert.match(reset, /id: new/);
  assert.equal(calls, 1); await reader.cancel(); await routes.close(); assert.equal(store.changes.waiting, 0);
});

test('bounded pages continue from last delivered event rather than jumping to observed head', { timeout: 3000 }, async () => {
  const requested: (string | null)[] = [];
  const { app, routes } = setup(after => {
    requested.push(after);
    const id = after === 'anchor' ? 'one' : 'two';
    return Promise.resolve({ cursor: 'two', known: true, events: [{ id, type: 'session.updated', ts: 1, payload: id }] });
  });
  const reader = (await app.request('/api/events/stream?lastEventId=anchor')).body!.getReader();
  assert.match(decode(await reader.read()), /heartbeat/);
  assert.match(decode(await reader.read()), /id: one/);
  assert.match(decode(await reader.read()), /id: two/);
  assert.deepEqual(requested, ['anchor', 'one']); await reader.cancel(); await routes.close();
});

test('fresh async stream anchors before heartbeat so an event arriving while sending heartbeat is replayed', { timeout: 3000 }, async () => {
  let head = 'old'; const requested: (string | null)[] = [];
  const { app, store, routes } = setup(after => {
    requested.push(after);
    return Promise.resolve({ cursor: head, known: true, events: after === 'old' && head === 'new'
      ? [{ id: 'new', type: 'session.updated', ts: 1, payload: 'visible' }] : [] });
  });
  const reader = (await app.request('/api/events/stream')).body!.getReader();
  assert.match(decode(await reader.read()), /heartbeat/);
  head = 'new'; store.changes.notify();
  assert.match(decode(await reader.read()), /visible/);
  assert.equal(requested[0], null); assert.ok(requested.includes('old'));
  await reader.cancel(); await routes.close();
});

test('failed original async page closes without fallback or write replay and logs redacted failure', { timeout: 3000 }, async () => {
  let calls = 0;
  const { app, store, rows, routes } = setup(() => { calls++; return Promise.reject(Error('PRIVATE path cookie body')); });
  store.getEventsSince = () => { throw Error('must not fall back'); };
  const reader = (await app.request('/api/events/stream?lastEventId=old')).body!.getReader();
  assert.equal((await reader.read()).done, true); await routes.close();
  assert.equal(calls, 1); assert.equal(store.changes.waiting, 0);
  const logs = rows.map(row => JSON.parse(row)).filter(row => row.operation === 'connector-event-stream');
  assert.ok(logs.some(row => row.step === 2 && row.admitted === 1 && row.settled === 1 && row.category === 'failed'));
  assert.equal(logs.some(row => row.unknown === 1), false, 'a failed read is not an unknown business write');
  assert.doesNotMatch(rows.join(''), /PRIVATE|cookie|body|path/);
});

test('non-progressing async page is refused once instead of creating a hot retry loop', { timeout: 3000 }, async () => {
  let calls = 0;
  const { app, routes } = setup(() => { calls++; return Promise.resolve(empty); });
  const reader = (await app.request('/api/events/stream?lastEventId=behind')).body!.getReader();
  assert.equal((await reader.read()).done, true); await routes.close(); assert.equal(calls, 1);
});

test('compatibility observation paginates without advancing beyond the last delivered row', () => {
  const store = new DeckStore(), anchor = store.append('session.updated', {});
  for (let i = 0; i < 130; i++) store.append('session.updated', { index: i });
  const first = replayStoreEvents(store, anchor.id);
  assert.equal(first.events.length, 64); assert.notEqual(first.cursor, first.events.at(-1)!.id);
  const second = replayStoreEvents(store, first.events.at(-1)!.id);
  assert.equal(second.events.length, 64);
  const third = replayStoreEvents(store, second.events.at(-1)!.id);
  assert.equal(third.events.length, 2); assert.equal(third.cursor, third.events.at(-1)!.id);
});

test('real original event worker page crosses the existing SSE wire without message resend or a second writer', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'events-async-replay-'));
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, diagnostics);
  await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, diagnostics);
  const { app, routes } = setup(after => projection.replay(after));
  try {
    // This SSE-only fixture has no worker fact producer or memory snapshot.
    const anchor = await projection.snapshot(cursor => cursor, async () => {});
    const cursor = await projection.append([{ id: '', type: 'session.updated', ts: 1, payload: { text: 'visible' } }]);
    const reader = (await app.request('/api/events/stream?lastEventId=' + encodeURIComponent(anchor))).body!.getReader();
    try {
      assert.match(decode(await reader.read()), /heartbeat/);
      const frame = decode(await reader.read());
      assert.ok(frame.includes('id: ' + cursor)); assert.match(frame, /event: session.updated/); assert.match(frame, /visible/);
    } finally { await reader.cancel(); }
  } finally {
    await routes.close(); await projection.close(); await owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('async event read refusal evidence survives routine and unrelated failure saturation', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore(), rows: string[] = [];
  const diagnostics = new PerformanceDiagnostics(row => rows.push(row), () => 0);
  for (let index = 0; index < 100; index++) {
    diagnostics.start('storage-admission').finish(); diagnostics.start('storage-admission').finish(true);
  }
  const routes = registerEventRoutes(app, store, () => true, undefined,
    () => Promise.reject(Error('PRIVATE SQL')), diagnostics);
  const reader = (await app.request('/api/events/stream')).body!.getReader();
  assert.equal((await reader.read()).done, true); await routes.close();
  assert.ok(rows.map(row => JSON.parse(row)).some(row => row.operation === 'connector-event-stream' && row.category === 'failed'));
  assert.doesNotMatch(rows.join(''), /PRIVATE/);
});
