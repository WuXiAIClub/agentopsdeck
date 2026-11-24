import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedDispatch } from './transport.js';

for (const reason of ['abort', 'deadline'] as const) {
  test(`${reason} releases a stalled source reader even when cancellation never settles`, async () => {
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}); } });
    const controller = new AbortController();
    const response = await boundedDispatch(() => new Response(source), 20)(new Request('http://synthetic', { signal: controller.signal }));
    const reader = response.body!.getReader();
    const reading = reader.read();
    if (reason === 'abort') controller.abort(new Error('synthetic abort'));
    await assert.rejects(reading, reason === 'abort' ? /synthetic abort/ : /Deadline/);
    reader.releaseLock();
    assert.equal(cancelled, 1);
    assert.equal(source.locked, false);
  });
}

test('caller cancellation releases a non-cooperative source without awaiting it', async () => {
  let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}); } });
  const response = await boundedDispatch(() => new Response(source), 1000)(new Request('http://synthetic'));
  assert.equal(await Promise.race([response.body!.cancel().then(() => true), delay(100, false)]), true);
  assert.equal(cancelled, 1);
  assert.equal(source.locked, false);
});

test('ordinary EOF releases the source without cancelling completed work', async () => {
  let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); }, cancel() { cancelled++; } });
  const response = await boundedDispatch(() => new Response(source), 1000)(new Request('http://synthetic'));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2]));
  assert.equal(source.locked, false);
  assert.equal(cancelled, 0);
});

test('abort between response resolution and reader ownership cancels without acquiring a lock', async () => {
  let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}); } });
  const controller = new AbortController();
  const dispatch = boundedDispatch(() => {
    queueMicrotask(() => queueMicrotask(() => controller.abort(new Error('handoff abort'))));
    return new Response(source);
  }, 1000);
  await assert.rejects(dispatch(new Request('http://synthetic', { signal: controller.signal })), /handoff abort/);
  assert.equal(cancelled, 1);
  assert.equal(source.locked, false);
});
