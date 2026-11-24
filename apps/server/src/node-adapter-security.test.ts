import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { registerWebBundle } from './web-bundle.js';

function rawRequest(port: number, path: string, options?: { method?: string; body?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, agent: false,
      method: options?.method ?? 'GET', headers: options?.headers }, incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode!, body, headers: incoming.headers }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Disposable HTTP request timed out')));
    outgoing.on('error', reject);
    outgoing.end(options?.body);
  });
}

async function withServer(app: Hono, check: (port: number) => Promise<void>) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await check(address.port);
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (server instanceof Server) server.closeAllConnections();
    await closed;
  }
}

test('Node adapter rejects raw path backslashes without rewriting them into protected routes', async () => {
  const app = new Hono();
  let protectedReads = 0;
  app.get('/private/secret', context => { protectedReads++; return context.text('protected fixture'); });
  app.get('/public', context => context.text('public fixture'));
  await withServer(app, async port => {
    for (const path of ['/private\\secret', '/public\\..\\private/secret', 'http://example.invalid/private\\secret']) {
      assert.equal((await rawRequest(port, path)).status, 400, path);
    }
    assert.equal(protectedReads, 0);
    assert.equal((await rawRequest(port, '/public?value=back\\slash')).status, 200);
    assert.equal((await rawRequest(port, '/public')).body, 'public fixture');
  });
});

test('Node static serving preserves prefix authorization for encoded and malformed paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-adapter-security-'));
  try {
    mkdirSync(join(directory, 'private'));
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>fixture</title>');
    writeFileSync(join(directory, 'private', 'secret.txt'), 'protected static fixture');
    writeFileSync(join(directory, 'assets', 'hello world.txt'), 'public spaced fixture');
    writeFileSync(join(directory, 'assets', '中文.txt'), 'public unicode fixture');
    const app = new Hono();
    app.use('/private/*', async (context, next) => {
      if (context.req.header('x-fixture-access') !== 'allowed') return context.text('denied', 401);
      await next();
    });
    registerWebBundle(app, directory);
    await withServer(app, async port => {
      for (const method of ['GET', 'HEAD']) {
        for (const path of ['/private/secret.txt', '/%70rivate/secret.txt', '/%2570rivate/secret.txt',
          '/pri%2576ate/secret.txt', '/private%5Csecret.txt', '/%70rivate%/secret.txt']) {
          const response = await rawRequest(port, path, { method });
          assert.ok(!response.body.includes('protected static fixture'), `${method} ${path}`);
          if (path === '/private/secret.txt' || path === '/%70rivate/secret.txt') assert.equal(response.status, 401, path);
        }
        const allowed = await rawRequest(port, '/private/secret.txt', { method, headers: { 'x-fixture-access': 'allowed' } });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body, method === 'HEAD' ? '' : 'protected static fixture');
      }
      assert.equal((await rawRequest(port, '/assets/hello%20world.txt')).body, 'public spaced fixture');
      assert.equal((await rawRequest(port, '/assets/%E4%B8%AD%E6%96%87.txt')).body, 'public unicode fixture');
      assert.equal((await rawRequest(port, '/assets/missing.js')).status, 404);
      assert.equal((await rawRequest(port, '/nested/view')).headers['cache-control'], 'no-store');
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Node adapter preserves JSON bodies, cookies and streamed responses', async () => {
  const app = new Hono();
  app.post('/echo', async context => context.json({ body: await context.req.json(), cookie: context.req.header('cookie') }));
  app.get('/stream', context => context.body(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first\n'));
      controller.enqueue(new TextEncoder().encode('second\n'));
      controller.close();
    },
  })));
  await withServer(app, async port => {
    const response = await rawRequest(port, '/echo', { method: 'POST', body: JSON.stringify({ fixture: 'bilingual 中文' }),
      headers: { 'content-type': 'application/json', cookie: 'fixture=allowed' } });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { body: { fixture: 'bilingual 中文' }, cookie: 'fixture=allowed' });
    assert.equal((await rawRequest(port, '/stream')).body, 'first\nsecond\n');
  });
});
