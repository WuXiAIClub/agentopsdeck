import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { downloadUpdate } from './update-download.js';

const limits = { maxBytes: 8, deadlineMs: 1000 };

for (const length of [undefined, '1', '8']) {
  test(`actual bytes enforce limit despite content-length ${length}`, async t => {
    let cancelled = 0;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) { if (pulls++ < 9) c.enqueue(new Uint8Array([1])); else c.close(); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async () => new Response(source, { headers: length ? { 'content-length': length } : {} }));
    await assert.rejects(downloadUpdate('https://synthetic.test', limits), /size limit/);
    assert.equal(cancelled, 1);
    assert.equal(source.locked, false);
  });
}

for (const length of ['9', '-1', 'NaN', '9007199254740993']) {
  test(`invalid or oversized content-length ${length} cancels without pulling`, async t => {
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() { assert.fail('must not read body'); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async () => new Response(source, { headers: { 'content-length': length } }));
    await assert.rejects(downloadUpdate('https://synthetic.test', limits), /download/);
    assert.equal(cancelled, 1);
    assert.equal(source.locked, false);
  });
}

test('exact bound succeeds with many small chunks; length is not decoded body size', async t => {
  let sent = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(c) { if (sent < 8) c.enqueue(new Uint8Array([sent++])); else c.close(); },
    cancel() { assert.fail('EOF is not cancelled'); },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(source, { headers: { 'content-length': '3' } }));
  assert.deepEqual(await downloadUpdate('https://synthetic.test', limits), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.equal(source.locked, false);
});

test('buffer growth preserves all bytes across boundaries', async t => {
  const expected = Buffer.alloc(180_000, 42);
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(c) { if (sent < expected.length) { c.enqueue(expected.subarray(sent, sent + 997)); sent += 997; } else c.close(); },
  })));
  assert.deepEqual(await downloadUpdate('https://synthetic.test', { ...limits, maxBytes: expected.length }), expected);
});

test('header deadline aborts transport and cancels a late response', async t => {
  let transportSignal: AbortSignal | undefined;
  let release!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    transportSignal = init.signal!;
    assert.equal(init.redirect, 'error');
    return new Promise<Response>(resolve => { release = resolve; });
  });
  await assert.rejects(downloadUpdate('https://synthetic.test', { ...limits, deadlineMs: 30 }), /download failed/);
  assert.equal(transportSignal?.aborted, true);
  let cancelled = 0;
  release(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

for (const mode of ['stalled', 'trickling', 'abort'] as const) {
  test(`${mode} body stops and unlocks without cooperative cancellation`, async t => {
    let cancelled = 0;
    let transportSignal: AbortSignal | undefined;
    const source = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (mode !== 'trickling') return;
        await new Promise(resolve => setTimeout(resolve, 5));
        if (!cancelled) c.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      transportSignal = init.signal!;
      return new Response(source);
    });
    const pending = downloadUpdate('https://synthetic.test', { maxBytes: 1000, deadlineMs: 40 }, controller.signal);
    if (mode === 'abort') setImmediate(() => controller.abort(new Error('secret')));
    await assert.rejects(pending, error => error instanceof Error && error.message === 'update download failed');
    assert.equal(transportSignal?.aborted, true, 'not merely eventual size exhaustion');
    assert.equal(cancelled, 1);
    assert.equal(source.locked, false);
  });
}

for (const status of [206, 302, 404, 500]) {
  test(`HTTP ${status} cancels response without leaking content`, async t => {
    let cancelled = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status }));
    await assert.rejects(downloadUpdate('https://synthetic.test', limits), /^Error: update download failed$/);
    assert.equal(cancelled, 1);
  });
}

test('real loopback redirect is refused without contacting its target', async t => {
  let targetRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/target' }); res.end(); }
    else { targetRequests++; res.end('secret'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(downloadUpdate(`http://127.0.0.1:${address.port}/redirect`, limits), /download failed/);
  assert.equal(targetRequests, 0);
});
