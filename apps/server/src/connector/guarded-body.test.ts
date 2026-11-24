import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { guardedBody, cancelGuardedBody } from './guarded-body.js';

test('transport error is not a failed cancel ACK, but its original drain is still awaited', async () => {
  const error = new Error('original transport abort');
  let release!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>;
  const ack = new Promise<void>(resolve => { release = resolve; });
  const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, { highWaterMark: 0 });
  const abort = new AbortController();
  const body = guardedBody(source, { authorize() {}, signal: abort.signal, drain: () => ack });
  controller.error(error); abort.abort(error);
  let drained = false;
  const closing = cancelGuardedBody(body).then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false);
  } finally { release(); }
  await closing; assert.equal(source.locked, false);
  await assert.rejects(new Response(body).text(), candidate => candidate === error);
});

test('real source cancellation failure remains a failed close after original drain', async () => {
  const error = new Error('cancel hook failed');
  let drained = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { throw error; } }, { highWaterMark: 0 });
  const body = guardedBody(source, { authorize() {}, drain: async () => { drained = true; } });
  await assert.rejects(cancelGuardedBody(body), candidate => candidate === error);
  assert.equal(drained, true); assert.equal(source.locked, false);
});

test('errored guarded body retains the original abort cancellation ACK', async () => {
  const abort = new AbortController();
  let release!: () => void, cancelled = 0;
  const ack = new Promise<void>(resolve => { release = resolve; });
  const body = guardedBody(new ReadableStream({ async cancel() { cancelled++; await ack; } }, { highWaterMark: 0 }), {
    signal: abort.signal, authorize() {},
  });
  abort.abort();
  let drained = false; const drain = cancelGuardedBody(body).then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(drained, false);
  release(); await drain; await cancelGuardedBody(body); assert.equal(cancelled, 1);
});

for (const length of [2, 3, 4]) test(`guarded body enforces declared length ${length} and cleans up`, async () => {
  const controller = new AbortController();
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(3)); c.close(); } });
  const response = new Response(guardedBody(source, { authorize() {}, signal: controller.signal, expectedBytes: length, maxBytes: length }));
  if (length === 3) assert.equal((await response.arrayBuffer()).byteLength, 3);
  else await assert.rejects(response.arrayBuffer(), length === 2 ? /size limit/ : /declared length/);
  assert.equal(source.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const phase of ['before-read', 'during-read', 'eof', 'cancel'] as const) test(`guarded media body releases source and abort listener at ${phase}`, async () => {
  const controller = new AbortController();
  let pulls = 0, cancels = 0;
  const source = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (phase === 'eof') c.close(); }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const body = guardedBody(source, { signal: controller.signal, authorize: () => {} });
  const reader = body.getReader();
  assert.equal(pulls, 0);
  if (phase === 'cancel') await reader.cancel();
  else if (phase === 'eof') assert.equal((await reader.read()).done, true);
  else {
    const pending = phase === 'during-read' ? reader.read() : undefined;
    if (pending) await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error('stopped'));
    await assert.rejects(pending ?? reader.read(), /stopped/);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancels, phase === 'eof' ? 0 : 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(source.locked, false);
  reader.releaseLock();
});

for (const phase of ['before-read', 'before-delivery'] as const) test(`async body gate blocks ${phase} and cancels without another source read`, async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(yes => { resolve = yes; });
  let checks = 0, pulls = 0, cancels = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(c) { pulls++; c.enqueue(new Uint8Array([1])); }, cancel() { cancels++; },
  }, { highWaterMark: 0 });
  const body = guardedBody(source, { authorize: () => ++checks === (phase === 'before-read' ? 1 : 2) ? gate : undefined });
  const reader = body.getReader(), next = reader.read();
  await new Promise<void>(yes => setImmediate(yes));
  assert.equal(pulls, phase === 'before-read' ? 0 : 1);
  await reader.cancel(); assert.equal((await next).done, true);
  resolve(); await new Promise<void>(yes => setImmediate(yes));
  assert.equal(pulls, phase === 'before-read' ? 0 : 1); assert.equal(cancels, 1);
  assert.equal(source.locked, false); reader.releaseLock();
});
