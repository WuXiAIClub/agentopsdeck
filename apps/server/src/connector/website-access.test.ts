import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { parseWebsiteServices } from './websites.js';
import { registerConnectorWebsiteAccess } from './website-access-http.js';
import { WebsiteAccessStore, WEBSITE_ACCESS_TTL, WEBSITE_RESOURCE_BYTES, readWebsiteResource, websiteResourceUrl, validWebsiteResource } from './website-access.js';

const service = { id: 'app', label: 'Dev app', url: 'http://127.0.0.1:3000/', browse: true };
test('website lease rotation at full quota is atomic, owner-bound and cannot extend its deadline', () => {
  let now = 10;
  const store = new WebsiteAccessStore<string>(() => now, { total: 2, perOwner: 1 });
  const alice = store.create('alice', 'old'), bob = store.create('bob', 'other');
  assert.throws(() => store.create('alice', 'bad', NaN, alice.id), { status: 410 });
  assert.equal(store.get(alice.id, 'alice').value, 'old');
  assert.equal(alice.controller.signal.aborted, false);
  assert.throws(() => store.create('mallory', 'bad', undefined, alice.id), { status: 404 });
  now += 100;
  const replacement = store.create('alice', 'new', undefined, alice.id);
  assert.equal(replacement.expiresAt, alice.expiresAt);
  assert.equal(alice.controller.signal.aborted, true);
  assert.throws(() => store.get(alice.id, 'alice'), { status: 404 });
  assert.throws(() => store.create('alice', 'fork', undefined, alice.id), { status: 404 });
  assert.throws(() => store.create('alice', 'extra'), { status: 429 });
  assert.equal(store.get(bob.id, 'bob').value, 'other');
  store.close();
});
test('website leases bind owners, enforce quotas, expire without timers and abort on close', () => {
  let now = 10; const store = new WebsiteAccessStore<string>(() => now);
  const lease = store.create('alice', 'app');
  assert.equal(lease.expiresAt, now + WEBSITE_ACCESS_TTL);
  assert.throws(() => store.get(lease.id, 'bob'), { status: 404 });
  for (let i = 0; i < 15; i++) store.create('alice', 'app');
  assert.throws(() => store.create('alice', 'app'), { status: 429 });
  for (let i = 0; i < 112; i++) store.create(`other-${i}`, 'app');
  assert.throws(() => store.create('other', 'app'), { status: 429 });
  now += WEBSITE_ACCESS_TTL;
  assert.throws(() => store.get(lease.id, 'alice'), { status: 404 });
  assert.equal(lease.controller.signal.aborted, true);
  const fresh = store.create('alice', 'app'); store.close();
  assert.equal(fresh.controller.signal.aborted, true);
  assert.throws(() => store.get(fresh.id, 'alice'), { status: 404 });
});

test('browse is explicit origin-level opt-in; canonical paths cannot change origin', () => {
  assert.equal(parseWebsiteServices(JSON.stringify([service]))[0]?.browse, true);
  for (const changed of [{ browse: 'true' }, { url: 'http://127.0.0.1:3000/project/' }]) {
    assert.throws(() => parseWebsiteServices(JSON.stringify([{ ...service, ...changed }])));
  }
  assert.equal(parseWebsiteServices(JSON.stringify([{ ...service, browse: false }]))[0]?.browse, undefined);
  assert.equal(websiteResourceUrl(service, '/assets/app.js?v=1'), `${service.url}assets/app.js?v=1`);
  for (const path of ['//evil.test/', 'http://evil.test', '/\\evil.test', '/x#y', '/a/../b', '/%2e%2e/b', '/bad%Q0', '/space here', '/x\n', '/?']) {
    assert.throws(() => websiteResourceUrl(service, path), { status: 400 });
  }
  assert.throws(() => websiteResourceUrl({ ...service, browse: false }, '/'), { status: 400 });
  const max = Buffer.alloc(WEBSITE_RESOURCE_BYTES).toString('base64');
  assert.ok(validWebsiteResource({ status: 200, contentType: 'image/png', bodyBase64: max }));
  for (const bodyBase64 of ['bad!!', 'YQ=', 'YR==', `${max}AAAA`]) assert.equal(validWebsiteResource({ status: 200, contentType: 'text/plain', bodyBase64 }), false);
});

test('resource transport preserves bounded binary/text while stripping credentials, cookies, redirects and downloads', async () => {
  const observed: { url: string; cookie: string | undefined; auth: string | undefined; method: string | undefined }[] = [];
  const server = createServer((req, res) => {
    observed.push({ url: req.url!, cookie: req.headers.cookie, auth: req.headers.authorization, method: req.method });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/private' }); res.end(); }
    else if (req.url === '/attachment') { res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=private.txt' }); res.end('private'); }
    else { res.writeHead(200, { 'content-type': 'application/javascript', 'set-cookie': 'secret=private', 'x-secret': 'private' }); res.end('window.answer = 42;'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { ...service, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
  try {
    const resource = await readWebsiteResource(target, '/app.js?v=1', new AbortController().signal);
    assert.deepEqual(resource, { status: 200, contentType: 'application/javascript', bodyBase64: Buffer.from('window.answer = 42;').toString('base64') });
    await assert.rejects(readWebsiteResource(target, '/redirect', new AbortController().signal), { status: 502 });
    await assert.rejects(readWebsiteResource(target, '/attachment', new AbortController().signal), { status: 415 });
    assert.deepEqual(observed.map(r => r.url), ['/app.js?v=1', '/redirect', '/attachment']);
    assert.ok(observed.every(r => !r.cookie && !r.auth && r.method === 'GET'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('oversized decoded resources and unsupported media are rejected and cancelled', async () => {
  for (const contentType of ['application/octet-stream', 'text/event-stream', 'image/svg+xml', '']) {
    await assert.rejects(readWebsiteResource(service, '/', new AbortController().signal,
      async () => new Response('x', { headers: { 'content-type': contentType } })), { status: 415 });
  }
  let cancelled = false;
  await assert.rejects(readWebsiteResource(service, '/', new AbortController().signal, async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(WEBSITE_RESOURCE_BYTES + 1)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/png', 'content-length': '1' } })), { status: 413 });
  assert.equal(cancelled, true);
});

test('real stalled resource is interrupted by total deadline or caller cancellation', { timeout: 15_000 }, async t => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const target = { ...service, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
  try {
    const started = Date.now();
    await assert.rejects(readWebsiteResource(target, '/', new AbortController().signal), { status: 504 });
    assert.ok(Date.now() - started < 12_000);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30);
    try { await assert.rejects(readWebsiteResource(target, '/', controller.signal), { status: 502 }); }
    finally { clearTimeout(timer); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('abort closes a pending body even if source cancellation never settles', { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  let cancelled = false;
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(readWebsiteResource(service, '/', controller.signal, async () => new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { 'content-type': 'text/plain' } })), { status: 502 });
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test('Connector access requires separate scope and service opt-in; close/revoke abort reads and release admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'website-access-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'synthetic-bootstrap');
  const browser = tokens.createTransient(['websites:browse']), other = tokens.createTransient(['websites:browse']);
  const snapshot = tokens.createTransient(['websites:read']);
  const app = new Hono(), base = '/api/connector/v1/website-access';
  let reads = 0, fast = false;
  const routes = registerConnectorWebsiteAccess(app, tokens, [service, { ...service, id: 'snapshot', browse: false }], async (_url, init) => {
    reads++;
    if (fast) return new Response('OK', { headers: { 'content-type': 'text/plain' } });
    return new Response(new ReadableStream({ start(c) { init!.signal!.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); } }), { headers: { 'content-type': 'text/plain' } });
  });
  const request = (path: string, body?: unknown, token = browser.token, method = 'POST') => app.request(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    for (const token of [snapshot.token, 'synthetic-bootstrap']) assert.equal((await request('', { serviceId: 'app' }, token)).status, 403);
    assert.equal((await request('', { serviceId: 'app' }, 'invalid')).status, 401);
    assert.equal((await request('', { serviceId: 'snapshot' })).status, 404);
    assert.equal((await request('', { serviceId: 'app', url: 'http://private' })).status, 400);
    const opened = await request('', { serviceId: 'app' }); assert.equal(opened.status, 200);
    const { accessId } = await opened.json();
    assert.equal((await request(`/${accessId}/resource`, { path: '/' }, other.token)).status, 404);
    assert.equal((await request(`/${accessId}/resource`, { path: '/', headers: { cookie: 'private' } })).status, 400);
    assert.equal((await request(`/${accessId}/resource?url=private`, { path: '/' })).status, 400);
    const pending = Array.from({ length: 4 }, () => request(`/${accessId}/resource`, { path: '/' }));
    for (let i = 0; reads < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(reads, 4);
    assert.equal((await request(`/${accessId}/resource`, { path: '/' })).status, 429);
    assert.equal((await request(`/${accessId}`, undefined, browser.token, 'DELETE')).status, 200);
    assert.ok((await Promise.all(pending)).every(response => response.status !== 200));
    assert.equal(tokens.changes.waiting, 0);
    assert.equal((await request(`/${accessId}/resource`, { path: '/' })).status, 404);
    const second = await (await request('', { serviceId: 'app' })).json();
    const revoked = request(`/${second.accessId}/resource`, { path: '/' });
    for (let i = 0; reads < 5 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    browser.dispose();
    assert.notEqual((await revoked).status, 200); assert.equal(tokens.changes.waiting, 0);
    fast = true;
    const third = await (await request('', { serviceId: 'app' }, other.token)).json();
    assert.equal((await request(`/${third.accessId}/resource`, { path: '/' }, other.token)).status, 200);
    routes.close();
    assert.equal((await request(`/${third.accessId}/resource`, { path: '/' }, other.token)).status, 503);
  } finally { routes.close(); await rm(root, { recursive: true, force: true }); }
});
