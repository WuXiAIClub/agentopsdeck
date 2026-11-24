import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { workspaceSyncTransfer } from './workspace-sync-transfer.js';

test('batch NDJSON is losslessly compressed and honors explicit negotiation', async () => {
  const app = new Hono(), text = JSON.stringify({ text: 'history 文本 '.repeat(10_000) }) + '\n';
  app.use('*', workspaceSyncTransfer);
  app.post('*', c => c.body(text, 200, { 'content-type': 'application/x-ndjson', vary: 'Origin' }));
  for (const encoding of ['gzip', 'gzip;q=0', 'identity', '']) {
    const response = await app.request('/', { method: 'POST', headers: { 'accept-encoding': encoding } });
    assert.equal(response.headers.get('vary'), 'Origin, Accept-Encoding');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (encoding === 'gzip') {
      assert.equal(response.headers.get('content-encoding'), 'gzip');
      assert.equal(gunzipSync(bytes).toString(), text);
      assert.ok(bytes.length < Buffer.byteLength(text) / 10);
    } else { assert.equal(response.headers.get('content-encoding'), null); assert.equal(bytes.toString(), text); }
  }
});

test('real HTTP gzip flushes fast frames before a slow session completes', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const app = new Hono(); app.use('*', workspaceSyncTransfer);
  app.post('*', c => { c.header('content-type', 'application/x-ndjson'); return stream(c, async output => {
    await output.write('{"fast":true}\n'); await hold; await output.write('{"slow":true}\n');
  }); });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), '{"fast":true}\n');
    release(); let rest = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.equal(rest, '{"slow":true}\n');
  } finally { release(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('cancelling compressed response cancels the underlying history stream', async () => {
  let cancelled = false;
  const app = new Hono(); app.use('*', workspaceSyncTransfer);
  app.post('*', () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"fast":true}\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const response = await app.request('/', { method: 'POST', headers: { 'accept-encoding': 'gzip' } });
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});
