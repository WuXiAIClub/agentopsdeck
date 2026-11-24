import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ConnectorClient } from '../hub/connector-client.js';
import { historyTransfer } from './history-transfer.js';
import { createConditionalHistory } from './conditional-history.js';
import { HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';

test('real HTTP compression interoperates with full, changed delta and empty 304 history responses', async () => {
  const app = new Hono(), respond = createConditionalHistory();
  let page = { messages: Array.from({ length: 200 }, (_, id) => ({ id: String(id), text: `message ${id}: ` + 'history '.repeat(200) })), updatedAt: 1 };
  const modes: string[] = [];
  app.use('*', async (c, next) => { await next(); modes.push(`${c.res.status}:${c.res.headers.get(HISTORY_DELTA_HEADER) ?? 'full'}:${c.res.headers.get('content-encoding') ?? 'identity'}`); });
  app.use('*', historyTransfer);
  app.get('*', c => respond(c, page));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const client = new ConnectorClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'fixture');
    assert.deepEqual((await client.messages('codex:test')).messages, page.messages);
    page = { messages: [...page.messages.slice(0, -1), { id: '199', text: 'new content '.repeat(300) }], updatedAt: 2 };
    assert.deepEqual((await client.messages('codex:test')).messages, page.messages);
    page = { ...page, updatedAt: 3 };
    assert.equal((await client.messages('codex:test')).updatedAt, 3);
    assert.deepEqual(modes, ['200:full:gzip', '200:1:gzip', '304:full:identity']);
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

const payload = { messages: [{ id: 'tool:1', text: '工具输出 / tool output\n'.repeat(15_000) }], totalCount: 1, hiddenCount: 0, updatedAt: 1 };
const json = JSON.stringify(payload);
const paths = ['/api/hub/v1/sessions/remote%3Asession/messages', '/api/connector/v1/sessions/codex%3Atest/messages',
  '/api/hub/v1/shared/owner/sessions/shared/messages', '/api/sessions/legacy/messages',
  '/api/hub/v1/sessions/remote/messages/tool%3A1'];

for (const path of paths) test(`history transfer losslessly compresses ${path}`, async () => {
  const app = new Hono();
  app.use('*', historyTransfer);
  app.get('*', context => { context.header('Vary', 'Origin'); return context.json(payload); });
  const response = await app.request(path, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('vary'), 'Origin, Accept-Encoding');
  assert.match(response.headers.get('server-timing') ?? '', /^agentopsdeck_history;dur=\d+\.\d;desc="History handler"$/);
  assert.equal(response.headers.get('timing-allow-origin'), null, 'do not expose private history timing to other origins');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(gunzipSync(bytes).toString(), json);
  assert.ok(bytes.length < Buffer.byteLength(json) / 10);
});

test('history transport respects negotiation and excludes errors, writes, credentials, streams, files and no-transform', async () => {
  for (const scenario of [
    { encoding: 'identity' }, { encoding: 'gzip;q=0, deflate;q=0' }, { encoding: '' },
    { status: 403 }, { status: 503 }, { method: 'POST' }, { method: 'HEAD' },
    { path: '/api/auth/login' }, { path: '/api/connector/v1/tokens' },
    { path: '/api/hub/v1/sessions/remote/events/stream', type: 'text/event-stream' },
    { path: '/api/hub/v1/sessions/remote/messages/a/media/b', status: 206 },
    { type: 'text/event-stream' }, { cache: 'private, no-transform' },
    { encoded: true },
  ]) {
    const app = new Hono();
    app.use('*', historyTransfer);
    app.all('*', () => new Response(json, { status: scenario.status ?? 200, headers: {
      'content-type': scenario.type ?? 'application/json', 'content-length': String(Buffer.byteLength(json)),
      ...(scenario.cache ? { 'cache-control': scenario.cache } : {}),
      ...(scenario.encoded ? { 'content-encoding': 'br' } : {}),
    } }));
    const response = await app.request(scenario.path ?? paths[0]!, { method: scenario.method ?? 'GET',
      headers: { 'accept-encoding': scenario.encoding ?? 'gzip' } });
    assert.equal(response.headers.get('content-encoding'), scenario.encoded ? 'br' : null, JSON.stringify(scenario));
    if ((scenario.status && scenario.status !== 200) || scenario.method || scenario.path || scenario.type) {
      assert.equal(response.headers.get('server-timing'), null, JSON.stringify(scenario));
    }
    await response.body?.cancel();
  }
});

test('history handler timing preserves existing metrics without exposing session paths', async () => {
  const app = new Hono();
  app.use('*', historyTransfer);
  app.get('*', context => {
    context.header('Server-Timing', 'fixture;dur=1.5');
    return context.json(payload);
  });
  const response = await app.request(paths[0]!);
  assert.match(response.headers.get('server-timing') ?? '', /^fixture;dur=1\.5, agentopsdeck_history;dur=\d+\.\d;desc="History handler"$/);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.deepEqual(await response.json(), payload);
});

test('real HTTP Connector client decompresses history and retains decoded response size limits', async () => {
  const app = new Hono();
  let encoding: string | undefined;
  app.use('*', historyTransfer);
  app.get('*', context => {
    encoding = context.req.header('accept-encoding');
    context.header('x-agentopsdeck-protocol', '1');
    return context.json(payload);
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(await new ConnectorClient(origin, 'fixture').messages('codex:test'), { ...payload, limits: { maxMessageChars: 20_000 } });
    assert.match(encoding ?? '', /gzip/);
    await assert.rejects(new ConnectorClient(origin, 'fixture', undefined, 10_000, 1024).messages('codex:test'));
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
