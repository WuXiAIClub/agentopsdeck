import assert from 'node:assert/strict';
import test from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { loadConfig } from '../config.js';
import { WebsiteGateway, parseWebsiteGateway } from './website-gateway.js';

const env = { AOD_WEBSITE_GATEWAY_ORIGIN: 'https://{access}.preview.example.net',
  AOD_WEBSITE_GATEWAY_HUB_ORIGIN: 'https://hub.example.org', AOD_WEBSITE_GATEWAY_PORT: '9898' };
const config = parseWebsiteGateway(env)!;
const resource = { status: 200, contentType: 'text/html', bodyBase64: Buffer.from('<h1>Preview</h1>').toString('base64') };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('gateway is opt-in, separate origin/port and Hub-only; rejects partial and ambiguous configuration', () => {
  assert.equal(parseWebsiteGateway({}), undefined);
  assert.deepEqual(config, { originTemplate: env.AOD_WEBSITE_GATEWAY_ORIGIN, parentOrigin: env.AOD_WEBSITE_GATEWAY_HUB_ORIGIN, port: 9898 });
  for (const patch of [
    { AOD_WEBSITE_GATEWAY_PORT: '' }, { AOD_WEBSITE_GATEWAY_PORT: '80' },
    { AOD_WEBSITE_GATEWAY_ORIGIN: 'https://{access}.example.org' },
    { AOD_WEBSITE_GATEWAY_ORIGIN: 'https://{access}.hub.example.org' },
    { AOD_WEBSITE_GATEWAY_ORIGIN: 'https://{access}.example.net/' },
    { AOD_WEBSITE_GATEWAY_ORIGIN: 'http://{access}.example.net' },
    { AOD_WEBSITE_GATEWAY_ORIGIN: 'https://user:secret@{access}.example.net' },
    { AOD_WEBSITE_GATEWAY_ORIGIN: 'https://{access}.{access}.example.net' },
    { AOD_WEBSITE_GATEWAY_HUB_ORIGIN: 'https://hub.example.org/path' },
  ]) assert.throws(() => parseWebsiteGateway({ ...env, ...patch }));
  assert.throws(() => parseWebsiteGateway({ AOD_WEBSITE_GATEWAY_PORT: '9898' }));
  assert.throws(() => loadConfig({ ...env, PORT: '9898' }));
  assert.throws(() => loadConfig({ ...env, AOD_SERVER_ROLE: 'connector' }));
  assert.throws(() => loadConfig({ ...env, AOD_HUB_ENABLED: 'false' }));
  assert.ok(parseWebsiteGateway({ ...env, AOD_WEBSITE_GATEWAY_ORIGIN: 'http://{access}.preview.localhost:9898', AOD_WEBSITE_GATEWAY_HUB_ORIGIN: 'http://127.0.0.1:8791' }));
});

test('gateway exposes only scoped resources, sandbox headers and no upstream credentials/headers', async () => {
  const gateway = new WebsiteGateway(config), controller = new AbortController();
  let calls = 0;
  const binding = { key: 'lease', owner: 'alice', expiresAt: Date.now() + 20_000, signal: controller.signal,
    authorize: () => {}, read: async (path: string) => { calls++; assert.equal(path, '/asset?q=1'); return { ...resource, cookie: 'never' }; } };
  const visit = await gateway.open(binding);
  assert.equal((await gateway.open(binding)).url, visit.url);
  assert.match(visit.url, /^https:\/\/[a-f0-9]{48}\.preview\.example.net\/$/);
  const response = await gateway.fetch(new Request(visit.url + 'asset?q=1', { headers: { origin: 'null', cookie: 'not-forwarded' } }));
  assert.equal(response.status, 200); assert.equal(await response.text(), '<h1>Preview</h1>');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  assert.match(response.headers.get('content-security-policy')!, /sandbox allow-scripts$/);
  assert.ok(!response.headers.get('content-security-policy')!.includes('allow-same-origin'));
  for (const [init, status] of [ [{ method: 'POST' }, 405], [{ method: 'OPTIONS' }, 405],
    [{ headers: { 'sec-fetch-dest': 'document' } }, 405], [{ headers: { 'service-worker': 'script' } }, 404] ] as const) {
    assert.equal((await gateway.fetch(new Request(visit.url, init))).status, status);
  }
  assert.equal((await gateway.fetch(new Request('https://hub.example.org/', { headers: { 'x-forwarded-host': new URL(visit.url).host } }))).status, 404);
  assert.equal((await gateway.fetch(new Request(visit.url.replace('example.net', 'example.com')))).status, 404);
  assert.equal(calls, 1);
  controller.abort(); assert.equal((await gateway.fetch(new Request(visit.url))).status, 404);
  await gateway.close(); await assert.rejects(gateway.open({ ...binding, signal: new AbortController().signal }));
});

test('revocation during I/O, expiry, invalid resources and bounded visit/read budgets fail closed', async () => {
  let now = 1000, authorized = true;
  const gateway = new WebsiteGateway(config, () => now);
  const bind = (key: string) => ({ key, owner: 'alice', expiresAt: now + 1000, signal: new AbortController().signal,
    authorize: () => { if (!authorized) throw new HTTPException(403); }, read: async () => resource });
  const visit = await gateway.open({ ...bind('revoke'), read: async () => { authorized = false; return resource; } });
  assert.equal((await gateway.fetch(new Request(visit.url))).status, 403);
  authorized = true; assert.equal((await gateway.fetch(new Request(visit.url))).status, 404);
  const expires = await gateway.open(bind('expires')); now += 1001;
  assert.equal((await gateway.fetch(new Request(expires.url))).status, 404);
  const bad = await gateway.open({ ...bind('bad'), read: async () => ({ ...resource, bodyBase64: 'invalid!' }) });
  assert.equal((await gateway.fetch(new Request(bad.url))).status, 502);
  const budget = await gateway.open(bind('budget'));
  for (let i = 0; i < 256; i++) assert.equal((await gateway.fetch(new Request(budget.url))).status, 200);
  assert.equal((await gateway.fetch(new Request(budget.url))).status, 429);
  for (let i = 0; i < 14; i++) await gateway.open(bind(`cap-${i}`));
  await assert.rejects(gateway.open(bind('excess')), (error: unknown) => error instanceof HTTPException && error.status === 429);
  await gateway.close();
});

test('normal asset bursts wait within bounded concurrency; closing aborts pending and active reads', async () => {
  const gateway = new WebsiteGateway(config), controller = new AbortController();
  let active = 0, peak = 0;
  const releases: Array<() => void> = [];
  const visit = await gateway.open({ key: 'lease', owner: 'alice', expiresAt: Date.now() + 20_000, signal: controller.signal,
    authorize: () => {}, read: async (_path, signal) => {
      active++; peak = Math.max(peak, active);
      try { await new Promise<void>((resolve, reject) => { releases.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
      finally { active--; }
      return resource;
    } });
  const reads = Array.from({ length: 40 }, () => gateway.fetch(new Request(visit.url)));
  await tick(); assert.equal(active, 4);
  releases.splice(0).forEach(release => release()); await tick(); assert.equal(active, 4);
  controller.abort(); const results = await Promise.all(reads);
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(results.filter(r => r.status === 429).length, 4);
  assert.equal(results.filter(r => r.status === 200).length, 4);
  assert.equal((await gateway.fetch(new Request(visit.url))).status, 404);
  await gateway.close();
});

test('async admission is awaited and close retains the original authorization ACK', async () => {
  const gateway = new WebsiteGateway(config); let release!: () => void, entered!: () => void, drained = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opening = gateway.open({ key: 'lease', owner: 'owner', expiresAt: Date.now() + 20_000,
    signal: new AbortController().signal, authorize: async () => { entered(); await gate; }, read: async () => resource });
  const rejected = assert.rejects(opening);
  await started; const closing = gateway.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  release(); await rejected; await closing;
});

test('parallel async authorizations reserve visit quotas only after awaiting proof', async () => {
  const gateway = new WebsiteGateway(config); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opens = Array.from({ length: 17 }, (_, index) => gateway.open({ key: String(index), owner: 'owner',
    expiresAt: Date.now() + 20_000, signal: new AbortController().signal, authorize: () => gate, read: async () => resource }));
  const results = Promise.allSettled(opens); release();
  const settled = await results;
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 16);
  assert.equal(settled.filter(result => result.status === 'rejected' && result.reason instanceof HTTPException && result.reason.status === 429).length, 1);
  await gateway.close();
});

test('resource authorization waits, then revoked proof prevents any upstream read', async () => {
  const gateway = new WebsiteGateway(config); let revoked = false, calls = 0, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const visit = await gateway.open({ key: 'lease', owner: 'owner', expiresAt: Date.now() + 20_000,
    signal: new AbortController().signal, authorize: async () => { if (revoked) { entered(); await gate; throw new HTTPException(401); } },
    read: async () => { calls++; return resource; } });
  revoked = true; const response = gateway.fetch(new Request(visit.url)); await started; assert.equal(calls, 0);
  release(); assert.equal((await response).status, 401); assert.equal(calls, 0); await gateway.close();
});

test('socket async authorization retains original connect and exact late peer cleanup through close', async () => {
  const gateway = new WebsiteGateway(config); let release!: () => void, entered!: () => void, releaseClose!: () => void, closingPeer!: () => void, closes = 0, drained = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const cleanupStarted = new Promise<void>(resolve => { closingPeer = resolve; }), cleanupGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const visit = await gateway.open({ key: 'lease', owner: 'owner', expiresAt: Date.now() + 20_000,
    signal: new AbortController().signal, authorize: async () => {}, read: async () => resource,
    connect: async () => { entered(); await gate; return { protocol: '', read: async () => ({ frames: [] }), send: async () => {},
      close: async () => { closes++; closingPeer(); await cleanupGate; } }; } });
  const opening = gateway.openSocket(new URL(visit.url).host, '/socket', [], new AbortController().signal), rejected = assert.rejects(opening);
  await started; const closing = gateway.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  release(); await cleanupStarted; await tick(); assert.equal(drained, false); releaseClose(); await rejected; await closing;
  assert.equal(closes, 1);
});
