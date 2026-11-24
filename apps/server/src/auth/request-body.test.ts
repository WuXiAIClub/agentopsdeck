import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthBodyError, AuthBodyReader } from './request-body.js';

function request(body: BodyInit | null, signal?: AbortSignal, headers?: HeadersInit) {
  return new Request('http://localhost/auth', { method: 'POST', body, signal, headers, duplex: 'half' } as RequestInit);
}
const rejection = (status: number, message: string) => (error: unknown) => {
  assert.ok(error instanceof AuthBodyError); assert.equal(error.status, status); assert.equal(error.message, message); return true;
};

test('auth body counts actual streamed UTF-8 bytes, not character count or declared length', async () => {
  for (const headers of [undefined, { 'content-length': '1' }, { 'content-length': '9999999' }]) {
    const reader = new AuthBodyReader(1);
    const bytes = new TextEncoder().encode('"中文"');
    assert.equal(await reader.read(request(bytes, undefined, headers), 8), '中文');
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 4)); c.enqueue(bytes.slice(4)); }, cancel() { cancelled = true; } });
    await assert.rejects(reader.read(request(stream, undefined, headers), 7), rejection(413, 'auth_body_too_large'));
    assert.equal(cancelled, true);
    assert.deepEqual(await reader.read(request('{}'), 8), {});
  }
});

test('full budget rejects immediately, cancels unread input, and releases after abort', async () => {
  const reader = new AuthBodyReader(1);
  const abort = new AbortController();
  let cancelled = false;
  const pending = reader.read(request(new ReadableStream({ cancel() { cancelled = true; } }), abort.signal), 32);
  const rejected = assert.rejects(pending, rejection(408, 'auth_body_timeout'));
  let refused = false;
  await assert.rejects(reader.read(request(new ReadableStream({ cancel() { refused = true; } })), 32), rejection(429, 'auth_body_capacity'));
  assert.equal(refused, true);
  abort.abort(); await rejected;
  assert.equal(cancelled, true);
  assert.deepEqual(await reader.read(request('{}'), 32), {});
});

test('stalled input times out, cancels even a never-settling producer, and restores budget', async () => {
  const reader = new AuthBodyReader(1, 15);
  let cancelled = false;
  await assert.rejects(reader.read(request(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } })), 32), rejection(408, 'auth_body_timeout'));
  assert.equal(cancelled, true);
  assert.deepEqual(await reader.read(request('{}'), 32), {});
});

test('empty, malformed, producer-error and pre-aborted bodies never leak content or retain slots', async () => {
  const reader = new AuthBodyReader(1);
  for (const body of [null, '', '{fixture-secret', new ReadableStream({ start(c) { c.error(new Error('fixture-secret')); } })]) {
    await assert.rejects(reader.read(request(body), 64), rejection(400, 'auth_body_invalid'));
    assert.equal(await reader.read(request('null'), 64), null);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(reader.read(request('{}', abort.signal), 64), rejection(408, 'auth_body_timeout'));
  assert.deepEqual(await reader.read(request('{}'), 64), {});
});

test('body reader configuration cannot silently disable the bounds', () => {
  for (const value of [0, -1, 33, NaN, Infinity, 1.5]) assert.throws(() => new AuthBodyReader(value));
  for (const value of [0, -1, 30_001, NaN, Infinity, 1.5]) assert.throws(() => new AuthBodyReader(8, value));
});
