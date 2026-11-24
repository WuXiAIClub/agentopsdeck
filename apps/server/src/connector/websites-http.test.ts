import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { WEBSITE_MAX_BYTES } from '@agentopsdeck/shared';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { parseWebsiteServices, readWebsiteSnapshot } from './websites.js';
import { registerConnectorWebsiteRoutes } from './websites-http.js';

const service = { id: 'dev', label: 'Development', url: 'http://127.0.0.1:3000/' };
test('website config is explicit, loopback-only and never logs invalid values', () => {
  assert.deepEqual(parseWebsiteServices(undefined), []);
  assert.equal(DEFAULT_SCOPES.includes('websites:read'), false);
  assert.deepEqual(parseWebsiteServices(JSON.stringify([service])), [service]);
  assert.equal(parseWebsiteServices(JSON.stringify([{ ...service, url: 'http://localhost:3000/' }]))[0]?.url, service.url);
  for (const url of ['file:///etc/passwd', 'http://169.254.169.254:80/', 'http://example.test:3000/', 'http://127.1:3000/', 'http://127.0.0.1/', 'http://name:secret@127.0.0.1:3000/', 'http://127.0.0.1:3000/?key=secret', 'http://127.0.0.1:3000/#secret', 'http://127.0.0.1:3000/\nsecret']) {
    assert.throws(() => parseWebsiteServices(JSON.stringify([{ ...service, url }])), error => !String(error).includes('secret'));
  }
  for (const values of [null, {}, [service, service], Array(17).fill(service), [{ ...service, id: '../x' }], [{ ...service, headers: { cookie: 'private' } }]]) assert.throws(() => parseWebsiteServices(JSON.stringify(values)));
});

test('website snapshot uses an actual HTTP service without credentials, redirect or scripts/assets fetch', async () => {
  const requests: { url: string; auth?: string; cookie?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/secret' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'private=never-forward' }); res.end('<h1>Hello</h1><img src="/asset">'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const result = await readWebsiteSnapshot({ ...service, url: `${origin}/` });
    assert.equal(result.content, '<h1>Hello</h1><img src="/asset">'); assert.equal(result.format, 'html');
    await assert.rejects(readWebsiteSnapshot({ ...service, url: `${origin}/redirect` }));
    assert.deepEqual(requests, [{ url: '/' }, { url: '/redirect' }]);
    assert.deepEqual(Object.keys(result).sort(), ['content', 'fetchedAt', 'format', 'label', 'serviceId']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('snapshot MIME, decoded byte and UTF-8 boundaries reject and cancel bodies', async () => {
  for (const [type, content] of [['application/json', '{}'], ['text/html; charset=latin1', 'hello'], ['text/plain', 'x'.repeat(WEBSITE_MAX_BYTES + 1)]] as const) {
    await assert.rejects(readWebsiteSnapshot(service, undefined, async () => new Response(content, { headers: { 'content-type': type } })));
  }
  await assert.rejects(readWebsiteSnapshot(service, undefined, async () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/plain' } })));
  const snapshot = await readWebsiteSnapshot(service, undefined, async () => new Response('x'.repeat(WEBSITE_MAX_BYTES), { headers: { 'content-type': 'text/plain' } }));
  assert.equal(snapshot.content.length, WEBSITE_MAX_BYTES);
  let cancelled = false;
  await assert.rejects(readWebsiteSnapshot(service, undefined, async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(WEBSITE_MAX_BYTES + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/plain' } })));
  assert.equal(cancelled, true);
});

test('actual hanging website bodies respect the total deadline and caller cancellation', { timeout: 15_000 }, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { ...service, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
  try {
    const started = Date.now();
    await assert.rejects(readWebsiteSnapshot(target), { status: 504 });
    assert.ok(Date.now() - started < 12_000, 'deadline also covers reading a stalled body');
    const controller = new AbortController();
    const pending = readWebsiteSnapshot(target, controller.signal);
    const timer = setTimeout(() => controller.abort(), 50);
    try { await assert.rejects(pending, { status: 502 }); }
    finally { clearTimeout(timer); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('snapshot cancellation settles even if fetch ignores abort; late bodies are cancelled', { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  let respond!: (response: Response) => void;
  let cancelled = false;
  const pending = readWebsiteSnapshot(service, controller.signal, () => new Promise(resolve => { respond = resolve; }));
  controller.abort();
  await assert.rejects(pending, { status: 502 });
  respond(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/plain' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('snapshot body cancellation does not wait for non-cooperative stream cleanup', { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  let cancelled = false;
  const pending = readWebsiteSnapshot(service, controller.signal, async () => new Response(new ReadableStream({
    pull() { reading(); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'text/plain' } }));
  await started;
  controller.abort();
  await assert.rejects(pending, { status: 502 });
  assert.equal(cancelled, true);
});

test('snapshot deadline is independent of fetch abort handling', { timeout: 12_000 }, async () => {
  await assert.rejects(readWebsiteSnapshot(service, undefined, () => new Promise(() => {})), { status: 504 });
});

test('snapshot MIME rejection does not wait for non-cooperative cleanup', { timeout: 2_000 }, async () => {
  await assert.rejects(readWebsiteSnapshot(service, undefined, async () => new Response(new ReadableStream({
    cancel() { return new Promise(() => {}); },
  }), { headers: { 'content-type': 'application/json' } })), { status: 415 });
});

test('website HTTP checks default deny, exact service, revocation during read and bounded concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'website-http-'));
  try {
    const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'test-bootstrap');
    const reader = tokens.createTransient(['websites:read']), regular = tokens.createTransient(['sessions:read', 'files:read']);
    const headers = { authorization: `Bearer ${reader.token}` };
    const base = '/api/connector/v1/websites';
    const disabled = new Hono(); registerConnectorWebsiteRoutes(disabled, tokens);
    assert.equal((await disabled.request(`${base}/catalog`)).status, 401);
    assert.equal((await disabled.request(`${base}/catalog`, { headers })).status, 409);
    const releases: (() => void)[] = [];
    const app = new Hono(); let calls = 0;
    registerConnectorWebsiteRoutes(app, tokens, [service], async () => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return new Response('Hello', { headers: { 'content-type': 'text/plain' } }); });
    for (const token of [regular.token, 'test-bootstrap']) assert.equal((await app.request(`${base}/catalog`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
    const catalog = await app.request(`${base}/catalog`, { headers });
    assert.equal(catalog.headers.get('cache-control'), 'no-store'); assert.deepEqual(await catalog.json(), { services: [{ id: 'dev', label: 'Development' }] });
    assert.equal((await app.request(`${base}/other/snapshot`, { headers })).status, 404);
    assert.equal((await app.request(`${base}/dev/snapshot?url=http://private`, { headers })).status, 400); assert.equal(calls, 0);
    const pending = Array.from({ length: 4 }, () => app.request(`${base}/dev/snapshot`, { headers }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 4);
    assert.equal((await app.request(`${base}/dev/snapshot`, { headers })).status, 429);
    reader.dispose(); releases.forEach(resolve => resolve());
    for (const response of await Promise.all(pending)) { assert.equal(response.status, 403); assert.ok(!(await response.text()).includes('Hello')); }
    assert.equal((await app.request(`${base}/catalog`, { headers })).status, 401);
  } finally { await rm(root, { recursive: true, force: true }); }
});
