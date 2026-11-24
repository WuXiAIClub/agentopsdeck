import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registerRequestDrain } from './request-drain.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('projection reads participate in pause across canonical and legacy routes without counting the recovery handler', async () => {
  const app = new Hono(), legacy = new Hono();
  const drain = registerRequestDrain(app, { writesOnRead: true,
    isControl: request => new URL(request.url).pathname === '/maintenance' });
  drain.register(legacy);
  const entered = latch(), held = latch(), cleanup = latch();
  let settled = false, reads = 0;
  legacy.get('/history', async context => {
    reads++; entered.release();
    try { await held.promise; return context.text('projected'); }
    finally { await cleanup.promise; }
  });
  app.get('/sessions', context => { reads++; return context.text('projected'); });
  app.post('/maintenance', async context => {
    await drain.pauseWrites().drained;
    settled = true;
    return context.text('paused');
  });
  const pending = legacy.request('/history');
  await entered.promise;
  const paused = app.request('/maintenance', { method: 'POST' });
  try {
    assert.equal((await app.request('/sessions')).status, 503);
    assert.equal((await legacy.request('/history', { method: 'HEAD' })).status, 503);
    held.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(reads, 1);
  } finally { held.release(); cleanup.release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await paused).status, 200);
  assert.equal(drain.pauseWrites().resume(), true);
  assert.equal((await legacy.request('/history')).status, 200);
  assert.equal((await app.request('/sessions')).status, 200);
  await drain();
});

test('one admission owner can cover legacy handlers without gating earlier independent routes', async () => {
  const canonical = new Hono(), legacy = new Hono();
  const drain = registerRequestDrain(canonical);
  canonical.post('/write', context => context.text('canonical'));
  legacy.post('/hub', context => context.text('independent'));
  drain.register(legacy);
  const entered = latch(), held = latch();
  legacy.post('/legacy', async context => { entered.release(); await held.promise; return context.text('legacy'); });
  const request = legacy.request('/legacy', { method: 'POST' });
  await entered.promise;
  const pause = drain.pauseWrites();
  try {
    assert.equal(pause.resume(), false);
    assert.equal((await canonical.request('/write', { method: 'POST' })).status, 503);
    assert.equal((await legacy.request('/legacy', { method: 'POST' })).status, 503);
    assert.equal((await legacy.request('/hub', { method: 'POST' })).status, 200);
  } finally { held.release(); await request; }
  await pause.drained;
  assert.equal(pause.resume(), true);
  assert.equal((await legacy.request('/legacy', { method: 'POST' })).status, 200);
  await drain();
  assert.equal((await canonical.request('/write', { method: 'POST' })).status, 503);
  assert.equal((await legacy.request('/legacy', { method: 'POST' })).status, 503);
});

test('recoverable write pause drains original handlers without waiting for its control handler', async () => {
  const app = new Hono();
  const close = registerRequestDrain(app, { isControl: request => new URL(request.url).pathname === '/maintenance' });
  const writeEntered = latch(), finishWrite = latch(), cleanup = latch(), paused = latch(), finishControl = latch();
  let lease: ReturnType<typeof close.pauseWrites> | undefined;
  app.post('/write', async context => {
    writeEntered.release();
    try { await finishWrite.promise; return context.text('written'); }
    finally { await cleanup.promise; }
  });
  app.get('/read', context => context.text('readable'));
  app.post('/maintenance', async context => {
    lease = close.pauseWrites();
    await lease.drained;
    paused.release();
    await finishControl.promise;
    return context.text('paused');
  });
  const write = app.request('/write', { method: 'POST' });
  await writeEntered.promise;
  const control = app.request('/maintenance', { method: 'POST' });
  try {
    assert.ok(lease);
    assert.equal(close.pauseWrites(), lease);
    assert.equal(lease.resume(), false, 'cannot release a pause before its original handlers drain');
    assert.equal((await app.request('/read')).status, 200);
    const late = await app.request('/write', { method: 'POST' });
    assert.equal(late.status, 503);
    assert.equal(late.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await late.json(), { error: 'connector_maintenance' });
    finishWrite.release();
    let drained = false;
    void lease.drained.then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    cleanup.release(); await paused.promise;
    let stopped = false;
    const stopping = close().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'shutdown still owns the maintenance handler');
    assert.equal(lease.resume(), false, 'a pause cannot reopen permanent shutdown');
    finishControl.release(); await stopping;
  } finally { finishWrite.release(); cleanup.release(); finishControl.release(); await write; await control; await close(); }
});

test('completed pause can resume once and a stale lease cannot release a newer pause', async () => {
  const app = new Hono(), close = registerRequestDrain(app);
  app.post('/write', context => context.text('ok'));
  const first = close.pauseWrites();
  await first.drained;
  assert.equal(first.resume(), true);
  assert.equal((await app.request('/write', { method: 'POST' })).status, 200);
  const second = close.pauseWrites();
  await second.drained;
  assert.notEqual(first, second);
  assert.equal(first.resume(), false);
  assert.equal((await app.request('/write', { method: 'POST' })).status, 503);
  assert.equal(second.resume(), true);
  await close();
  assert.equal(close.pauseWrites().resume(), false);
});

test('write pause keeps a disconnected caller until handler cleanup, and controls still require route authorization', async () => {
  const app = new Hono(), close = registerRequestDrain(app, { isControl: request => new URL(request.url).pathname === '/maintenance' });
  const entered = latch(), finish = latch();
  app.post('/maintenance', context => context.json({ error: 'unauthorized' }, 403));
  app.post('/write', async context => { entered.release(); await finish.promise; return context.text('ok'); });
  const controller = new AbortController();
  const request = app.fetch(new Request('http://connector/write', { method: 'POST', signal: controller.signal }));
  await entered.promise;
  const lease = close.pauseWrites();
  let drained = false;
  void lease.drained.then(() => { drained = true; });
  controller.abort();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal((await app.request('/maintenance', { method: 'POST' })).status, 403);
    assert.equal((await app.request('/maintenance/other', { method: 'POST' })).status, 503);
  } finally { finish.release(); await request; await lease.drained; await close(); }
});

test('drain accounts for every handler, including failed handlers and cleanup awaits', async () => {
  const app = new Hono(), close = registerRequestDrain(app);
  const first = latch(), second = latch(), cleanup = latch();
  let entered = 0, cleaned = false, done = false;
  app.onError((_error, c) => c.json({ error: 'synthetic failure' }, 500));
  app.get('/:id', async c => {
    entered++;
    if (c.req.param('id') === 'first') { await first.promise; return c.text('ok'); }
    try { await second.promise; throw new Error('synthetic'); }
    finally { await cleanup.promise; cleaned = true; }
  });
  const a = app.request('/first'), b = app.request('/second');
  assert.equal(entered, 2);
  const draining = close(); assert.equal(close(), draining);
  void draining.then(() => { done = true; });
  try {
    assert.equal((await app.request('/late')).status, 503); assert.equal(entered, 2);
    first.release(); assert.equal((await a).status, 200); assert.equal(done, false);
    second.release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(done, false); assert.equal(cleaned, false);
  } finally { first.release(); second.release(); cleanup.release(); await a; await b; await draining; }
  assert.equal(cleaned, true); assert.equal((await b).status, 500);
  assert.equal((await app.request('/after-close')).status, 503);
});

test('a disconnected loopback HTTP caller does not drain a still-running handler', async () => {
  const app = new Hono(), close = registerRequestDrain(app);
  const entered = latch(), finish = latch();
  let settled = false, drained = false;
  app.post('/write', async c => { entered.release(); await finish.promise; settled = true; return c.json({ ok: true }); });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  const request = fetch(`${origin}/write`, { method: 'POST', body: '{}', signal: controller.signal }).catch(() => undefined);
  await entered.promise;
  controller.abort(); await request;
  const closing = close().then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.equal(settled, false);
    const rejected = await fetch(`${origin}/write`, { method: 'POST' });
    assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await rejected.json(), { error: 'server_draining' });
  } finally {
    finish.release(); await closing;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(settled, true);
});

test('response stream lifetime is separate from handler admission; empty drain is permanent', async () => {
  const app = new Hono(), close = registerRequestDrain(app);
  let cancelled = false;
  app.get('/stream', () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const response = await app.request('/stream');
  await close();
  assert.equal(cancelled, false, 'the stream owner, not the handler barrier, must close long-lived streams');
  await response.body!.cancel(); assert.equal(cancelled, true);
  const another = new Hono(), stopEmpty = registerRequestDrain(another);
  const empty = stopEmpty(); assert.equal(stopEmpty(), empty); await empty;
  assert.equal((await another.request('/missing')).status, 503);
});
