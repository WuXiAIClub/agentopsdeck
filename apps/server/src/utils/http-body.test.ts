import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonBody, readOptionalJsonBody, requireEmptyBody } from './http-body.js';

test('optional JSON checks bytes, distinguishing empty HTTP streams from invalid input', async () => {
  assert.equal(await readOptionalJsonBody(new Request('http://test', { method: 'DELETE' }), 128), undefined);
  assert.equal(await readOptionalJsonBody(new Request('http://test', { method: 'DELETE', body: '' }), 128), undefined);
  assert.deepEqual(await readOptionalJsonBody(new Request('http://test', { method: 'DELETE', body: '{}' }), 128), {});
  for (const body of [' ', '{']) {
    await assert.rejects(readOptionalJsonBody(new Request('http://test', { method: 'DELETE', body }), 128), { status: 400 });
  }
  await assert.rejects(readOptionalJsonBody(new Request('http://test', { method: 'DELETE', body: ' '.repeat(129) }), 128), { status: 413 });
});

test('empty body accepts absent and drained streams, rejects actual bytes regardless of headers', async () => {
  await requireEmptyBody(new Request('http://test', { method: 'DELETE' }));
  const empty = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array()); c.close(); } });
  await requireEmptyBody(new Request('http://test', { method: 'DELETE', body: empty, duplex: 'half' } as any));
  assert.equal(empty.locked, false);
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(' ')); }, cancel() { canceled = true; } });
  await assert.rejects(requireEmptyBody(new Request('http://test', {
    method: 'DELETE', body, headers: { 'content-length': '0' }, duplex: 'half',
  } as any)), { status: 400 });
  assert.equal(canceled, true); assert.equal(body.locked, false);
});

for (const reason of ['abort', 'timeout']) test(`empty body ${reason} cancels stalled input`, async () => {
  const controller = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; return new Promise(() => {}); } });
  const pending = requireEmptyBody(new Request('http://test', {
    method: 'DELETE', body, signal: controller.signal, duplex: 'half',
  } as any), 15);
  if (reason === 'abort') controller.abort();
  await assert.rejects(pending, { status: 408 });
  assert.equal(canceled, true); assert.equal(body.locked, false);
});

test('bounded JSON reads split UTF-8 without trusting Content-Length and releases reader', async () => {
  const bytes = Buffer.from(JSON.stringify({ message: '你好' }));
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  assert.deepEqual(await readJsonBody(new Request('http://test', { method: 'PATCH', body, duplex: 'half' } as any), bytes.length), { message: '你好' });
  assert.equal(body.locked, false);
  let canceled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { canceled = true; } });
  await assert.rejects(readJsonBody(new Request('http://test', { method: 'PATCH', headers: { 'content-length': '1' }, body: oversized, duplex: 'half' } as any), 4), { status: 413 });
  assert.equal(canceled, true); assert.equal(oversized.locked, false);
});

for (const reason of ['abort', 'timeout']) test(`bounded JSON ${reason} cancels a stalled body without awaiting its source`, async () => {
  const controller = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; return new Promise(() => {}); } });
  const result = readJsonBody(new Request('http://test', { method: 'PATCH', body, signal: controller.signal, duplex: 'half' } as any), 128, 15);
  if (reason === 'abort') controller.abort();
  await assert.rejects(result, { status: 408 });
  assert.equal(canceled, true); assert.equal(body.locked, false);
});

test('bounded JSON rejects malformed and absent bodies', async () => {
  await assert.rejects(readJsonBody(new Request('http://test', { method: 'PATCH', body: '{' }), 128), { status: 400 });
  await assert.rejects(readJsonBody(new Request('http://test', { method: 'PATCH' }), 128), { status: 400 });
});
