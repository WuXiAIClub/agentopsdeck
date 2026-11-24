import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerEventRoutes } from './events.js';
import { AsyncConnectorEventProjection } from '../connector/async-event-projection.js';
import type { AsyncConnectorOwner } from '../connector/async-connector-owner.js';

test('async Deck SSE requires an explicit owner replay before route registration', () => {
  const projection = new AsyncConnectorEventProjection({ command: async () => { throw Error('not dispatched'); } } as unknown as AsyncConnectorOwner);
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  assert.throws(() => registerEventRoutes(new Hono(), store, () => true), /awaited event replay/);
  assert.equal(store.changes.waiting, 0);
});

test('async Deck SSE emits only owner cursor IDs and drains without synchronous reads', { timeout: 3000 }, async () => {
  const epoch = 'ce1_00000000-0000-4000-8000-000000000001:';
  const events: any[] = [];
  const projection = new AsyncConnectorEventProjection({ command: async (kind: string, input: any) => {
    if (kind === 'eventProjectionAppend') {
      for (const event of input.events) events.push({ ...event, id: epoch + (events.length + 1) });
      return { cursor: epoch + events.length };
    }
    if (kind === 'eventReplay') return { cursor: epoch + events.length, known: true,
      events: input.after === null ? [] : events.filter(event => Number(event.id.slice(epoch.length)) > Number(input.after.slice(epoch.length))) };
    throw Error('unexpected command');
  } } as unknown as AsyncConnectorOwner);
  const store = new DeckStore({ projectionEvents: projection.deckEvents }), app = new Hono();
  const routes = registerEventRoutes(app, store, () => true, undefined, after => projection.replay(after));
  const controller = new AbortController();
  const reader = (await app.request('/api/events/stream', { signal: controller.signal })).body!.getReader();
  try {
    assert.match(text(await reader.read()), /heartbeat/);
    // Finish the initial tail observation before publishing a new event.
    await new Promise(resolve => setImmediate(resolve));
    const pending = reader.read();
    const local = store.append('session.updated', { text: 'new owner event' });
    const frame = text(await pending);
    assert.match(frame, /new owner event/); assert.ok(frame.includes(epoch + '1'));
    assert.equal(frame.includes(local.id), false);
  } finally { controller.abort(); await reader.cancel(); await routes.close(); await projection.close(); }
  assert.equal(store.changes.waiting, 0);
});

const text = (chunk: ReadableStreamReadResult<Uint8Array>) => new TextDecoder().decode(chunk.value);

test('legacy events wake on changes, cancel their waiter, and do not replay the tail to fresh clients', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore(), controller = new AbortController();
  store.append('session.updated', { private: 'old' });
  registerEventRoutes(app, store, () => true);
  const response = await app.request('/api/events/stream', { signal: controller.signal });
  const reader = response.body!.getReader();
  try {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(text(await reader.read()), /heartbeat/);
    const next = reader.read(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.changes.waiting, 1);
    const start = Date.now(), event = store.append('session.updated', { private: 'new' });
    const frame = text(await next);
    assert.match(frame, new RegExp(event.id)); assert.match(frame, /new/); assert.doesNotMatch(frame, /old/);
    assert.ok(Date.now() - start < 1000, 'event delivery should not wait for the two-second authority interval');
    const end = reader.read(); controller.abort();
    assert.equal((await end).done, true); assert.equal(store.changes.waiting, 0);
  } finally { controller.abort(); await reader.cancel(); }
});

test('legacy replay checks authority again between each frame and never leaks later records', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore(); let authorized = true;
  const anchor = store.append('session.updated', {});
  store.append('session.updated', { text: 'visible' }); store.append('session.updated', { text: 'PRIVATE' });
  registerEventRoutes(app, store, () => authorized);
  const response = await app.request('/api/events/stream', { headers: { 'last-event-id': anchor.id } });
  const reader = response.body!.getReader();
  try {
    assert.match(text(await reader.read()), /heartbeat/);
    assert.match(text(await reader.read()), /visible/);
    authorized = false;
    const rest: string[] = [];
    for (;;) { const value = await reader.read(); if (value.done) break; rest.push(text(value)); }
    assert.doesNotMatch(rest.join(''), /PRIVATE/);
    assert.equal(store.changes.waiting, 0);
  } finally { await reader.cancel(); }
});

test('expired legacy cursors reset once, then cancellation releases all listeners', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore();
  const tail = store.append('session.updated', { private: 'must not replay' });
  registerEventRoutes(app, store, () => true);
  const reader = (await app.request('/api/events/stream?lastEventId=missing')).body!.getReader();
  try {
    assert.match(text(await reader.read()), /heartbeat/);
    const reset = text(await reader.read());
    assert.match(reset, /event: stream.reset/); assert.match(reset, new RegExp(tail.id));
    assert.doesNotMatch(reset, /must not replay/);
  } finally { await reader.cancel(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(store.changes.waiting, 0);
});

for (const [status, authorize] of [[401, () => false], [503, () => { throw Error('PRIVATE authority failure'); }]] as const) test('legacy stream denies absent or failed authority before streaming', async () => {
  const app = new Hono(), store = new DeckStore(); registerEventRoutes(app, store, authorize);
  const response = await app.request('/api/events/stream');
  assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: status === 401 ? 'unauthorized' : 'auth_persistence_failed' });
  assert.equal(store.changes.waiting, 0);
});

test('legacy event admission awaits asynchronous false rather than granting its Promise', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore();
  const authorize = async () => false;
  registerEventRoutes(app, store, authorize);
  const response = await app.request('/api/events/stream');
  try {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  assert.equal(store.changes.waiting, 0);
});

test('disconnect during original event authority wait ends HTTP without replaying the authority', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore(), controller = new AbortController();
  let calls = 0, resolve!: (value: boolean) => void;
  const original = new Promise<boolean>(yes => { resolve = yes; });
  registerEventRoutes(app, store, () => { calls++; return original; });
  const flight = app.request('/api/events/stream', { signal: controller.signal });
  await new Promise(yes => setImmediate(yes)); controller.abort();
  const response = await flight;
  try { assert.equal(response.status, 408); assert.deepEqual(await response.json(), { error: 'request_cancelled' }); }
  finally { resolve(true); if (!response.bodyUsed) await response.body?.cancel(); }
  assert.equal(calls, 1); assert.equal(store.changes.waiting, 0);
});

test('legacy stream async authority failure is sanitized before stream construction', async () => {
  const app = new Hono(), store = new DeckStore();
  registerEventRoutes(app, store, () => Promise.reject(Error('PRIVATE credentials and SQL path')));
  const response = await app.request('/api/events/stream');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal(store.changes.waiting, 0);
});

test('replay waits for original async final frame authority, and denial prevents private frame delivery', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore(); let calls = 0, resolve!: (value: boolean) => void;
  const original = new Promise<boolean>(yes => { resolve = yes; });
  const anchor = store.append('session.updated', {});
  store.append('session.updated', { text: 'visible' }); store.append('session.updated', { text: 'PRIVATE' });
  registerEventRoutes(app, store, () => ++calls === 5 ? original : Promise.resolve(true));
  const response = await app.request('/api/events/stream', { headers: { 'last-event-id': anchor.id } });
  const reader = response.body!.getReader();
  try {
    assert.match(text(await reader.read()), /heartbeat/);
    assert.match(text(await reader.read()), /visible/);
    await new Promise(yes => setImmediate(yes)); assert.equal(calls, 5);
    resolve(false);
    const rest: string[] = [];
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest.push(text(chunk)); }
    assert.doesNotMatch(rest.join(''), /PRIVATE/); assert.equal(store.changes.waiting, 0);
  } finally { resolve(false); await reader.cancel(); }
});

test('reader cancellation during async authority wait closes stream without settling or replaying original check', { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore(); let calls = 0, resolve!: (value: boolean) => void, entered!: () => void;
  const original = new Promise<boolean>(yes => { resolve = yes; }), waiting = new Promise<void>(yes => { entered = yes; });
  registerEventRoutes(app, store, () => { if (++calls === 4) { entered(); return original; } return Promise.resolve(true); });
  const response = await app.request('/api/events/stream'); const reader = response.body!.getReader();
  try {
    assert.match(text(await reader.read()), /heartbeat/);
    const pending = reader.read(); store.append('session.updated', { text: 'PRIVATE' });
    await waiting; await reader.cancel(); assert.equal((await pending).done, true);
    assert.equal(calls, 4); assert.equal(store.changes.waiting, 0);
    resolve(true); await new Promise(yes => setImmediate(yes));
    assert.equal(calls, 4); assert.equal(store.changes.waiting, 0);
  } finally { resolve(false); await reader.cancel(); }
});
