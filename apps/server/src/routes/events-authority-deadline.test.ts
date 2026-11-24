import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { AwaitedRequestAuthorization } from '../auth/awaited-request-authorization.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerEventRoutes } from './events.js';

for (const late of ['resolve', 'reject'] as const) test(`event route close retains original admission after timeout, late ${late}`, { timeout: 3000 }, async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}), 2, 5);
  const app = new Hono(), store = new DeckStore();
  let resolve!: (value: boolean) => void, reject!: (error: unknown) => void, calls = 0, closed = false;
  const original = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const routes = registerEventRoutes(app, store, () => { calls++; return original; }, gate);
  assert.equal((await app.request('/api/events/stream')).status, 503);
  const closing = routes.close(); void closing.then(() => { closed = true; });
  assert.equal(routes.close(), closing);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(gate.pending, 1);
    assert.equal((await app.request('/api/events/stream')).status, 503);
    assert.equal((await app.request('/api/attention')).status, 503);
    assert.equal(calls, 1); assert.equal(store.changes.waiting, 0);
  } finally {
    if (late === 'resolve') resolve(true); else reject(Error('PRIVATE original authority error'));
    await closing;
  }
  assert.equal(closed, true); assert.equal(gate.pending, 0);
});

for (const late of ['resolve', 'reject'] as const) test(`event route close aborts active stream but drains its late ${late} authority`, { timeout: 3000 }, async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}));
  const app = new Hono(), store = new DeckStore();
  let resolve!: (value: boolean) => void, reject!: (error: unknown) => void, entered!: () => void, calls = 0, closed = false;
  const original = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const waiting = new Promise<void>(yes => { entered = yes; });
  const routes = registerEventRoutes(app, store, () => { if (++calls === 4) { entered(); return original; } return true; }, gate);
  const response = await app.request('/api/events/stream'), reader = response.body!.getReader();
  let closing: Promise<void> | undefined;
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
    const next = reader.read(); store.append('session.updated', { text: 'PRIVATE frame' });
    await waiting; closing = routes.close(); void closing.then(() => { closed = true; });
    assert.equal(routes.close(), closing); assert.equal((await next).done, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(store.changes.waiting, 0); assert.equal(gate.pending, 1); assert.equal(closed, false);
    assert.equal(calls, 4); assert.equal((await app.request('/api/events/stream')).status, 503);
  } finally {
    if (late === 'resolve') resolve(true); else reject(Error('PRIVATE late authority failure'));
    await reader.cancel(); await (closing ?? routes.close());
  }
  assert.equal(closed, true); assert.equal(gate.pending, 0); assert.equal(calls, 4);
});

for (const consume of [false, true]) test(`event route close drains ${consume ? 'idle' : 'unconsumed'} stream without client cooperation`, { timeout: 3000 }, async () => {
  const app = new Hono(), store = new DeckStore();
  const routes = registerEventRoutes(app, store, () => true);
  const response = await app.request('/api/events/stream');
  const reader = consume ? response.body!.getReader() : undefined;
  try {
    if (reader) await reader.read();
    await routes.close(); assert.equal(store.changes.waiting, 0);
    if (reader) assert.equal((await reader.read()).done, true);
    assert.equal((await app.request('/api/events/stream')).status, 503);
  } finally { if (reader) await reader.cancel(); else await response.body!.cancel(); await routes.close(); }
});

test('event admission read deadline returns no-store 503 while retaining original authority', { timeout: 3000 }, async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}), 2, 5);
  const app = new Hono(), store = new DeckStore();
  let resolve!: (value: boolean) => void, calls = 0;
  const original = new Promise<boolean>(yes => { resolve = yes; });
  registerEventRoutes(app, store, () => { calls++; return original; }, gate);
  try {
    const response = await app.request('/api/events/stream');
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
    assert.equal(gate.pending, 1); assert.equal(calls, 1); assert.equal(store.changes.waiting, 0);
    resolve(true); await new Promise(yes => setImmediate(yes));
    assert.equal(gate.pending, 0); assert.equal(calls, 1); assert.equal(store.changes.waiting, 0);
  } finally { resolve(false); }
});

for (const late of ['success', 'failure'] as const) test(`active event stream read timeout closes without private frame, late ${late}`, { timeout: 3000 }, async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 2, 10);
  const app = new Hono(), store = new DeckStore(); let calls = 0;
  let resolve!: (value: boolean) => void, reject!: (error: unknown) => void, entered!: () => void;
  const original = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const waiting = new Promise<void>(yes => { entered = yes; });
  registerEventRoutes(app, store, () => { if (++calls === 4) { entered(); return original; } return true; }, gate);
  const response = await app.request('/api/events/stream'), reader = response.body!.getReader();
  try {
    const heartbeat = await reader.read(); assert.match(new TextDecoder().decode(heartbeat.value), /heartbeat/);
    const next = reader.read(); store.append('session.updated', { text: 'PRIVATE' });
    await waiting;
    const rest: string[] = []; const chunk = await next;
    if (!chunk.done) rest.push(new TextDecoder().decode(chunk.value));
    for (;;) { const row = await reader.read(); if (row.done) break; rest.push(new TextDecoder().decode(row.value)); }
    assert.doesNotMatch(rest.join(''), /PRIVATE/); assert.equal(store.changes.waiting, 0);
    assert.equal(gate.pending, 1); assert.equal(calls, 4);
    assert.ok(diagnostics.snapshot().events.some(e => e.timedOut === 1 && e.step === 6));
    if (late === 'success') resolve(true); else reject(Error('PRIVATE late database failure'));
    await new Promise(yes => setImmediate(yes));
    assert.equal(gate.pending, 0); assert.equal(calls, 4); assert.equal(store.changes.waiting, 0);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
  } finally { resolve(false); await reader.cancel(); }
});
