import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConnectorEvents } from './sse.js';

test('SSE parses split UTF-8, CRLF, comments and multiline data without committing partial EOF frames', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nid: 1\r\nevent: message.created\r\ndata: 汉字\r\ndata: second\r\n\r\nid: partial\ndata: incomplete');
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { if (at === bytes.length) c.close(); else c.enqueue(bytes.slice(at, ++at)); } });
  const frames = [];
  for await (const frame of parseConnectorEvents(stream, new AbortController().signal)) frames.push(frame);
  assert.deepEqual(frames, [{ id: '1', event: 'message.created', data: '汉字\nsecond' }]);
});

test('SSE rejects oversized unterminated or complete frames and cancels its reader', async () => {
  for (const suffix of ['', '\n\n']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(100)}${suffix}`)); }, cancel() { cancelled = true; } });
    await assert.rejects(async () => { for await (const _ of parseConnectorEvents(stream, new AbortController().signal, 64)) { /* consume */ } }, /size limit/);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test('SSE abort releases a stalled reader and early iterator exit cancels upstream', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const iterator = parseConnectorEvents(stalled, controller.signal);
  const pending = iterator.next(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, 1); assert.equal(stalled.locked, false);
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode('id: a\ndata: {}\n\n')); }, cancel() { cancelled++; } });
  for await (const _ of parseConnectorEvents(stream, new AbortController().signal)) break;
  assert.equal(cancelled, 2); assert.equal(stream.locked, false);
});
