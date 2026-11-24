import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerStorageDiagnostics } from './diagnostics-http.js';
import { HistoryDiagnostics, observeHistoryStage } from './history-diagnostics.js';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
test('coordinator diagnostics sample only after authority recheck and never launch a worker', async () => {
  let allowed = false, revoke = false, samples = 0, launches = 0;
  const coordinator = new AsyncVolumeAdmission(() => { launches++; throw Error('must not launch'); });
  const app = new Hono();
  registerStorageDiagnostics(app, '/storage', {
    authorize: () => { const check = () => { if (!allowed) throw new HTTPException(403); }; check(); return check; },
    stats: async () => { if (revoke) allowed = false; return { databaseBytes: 0, walBytes: 0, availableBytes: 1, lowSpace: false, walPressure: false }; },
    checkpoint: () => { throw Error('must not write'); }, coordinator: () => { samples++; return coordinator.snapshot(); },
  });
  assert.equal((await app.request('/storage')).status, 403); assert.equal(samples, 0);
  allowed = true; const response = await app.request('/storage'); assert.equal(response.status, 200);
  assert.equal((await response.json()).coordinator.scope, 'process'); assert.equal(samples, 1); assert.equal(launches, 0);
  revoke = true; assert.equal((await app.request('/storage')).status, 403); assert.equal(samples, 1);
});

test('async checkpoint rechecks authority before SQL and reserves rate limit before waiting', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const app = new Hono(); let allowed = true, writes = 0, entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  registerStorageDiagnostics(app, '/storage', {
    authorize: () => { const check = () => { if (!allowed) throw new HTTPException(403); }; check(); return check; },
    stats: async () => { throw Error('unused'); },
    checkpoint: async check => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      check(); writes++; return { deferred: true };
    },
  });
  const post = () => app.request('/storage/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const first = post(); await enteredPromise;
  assert.equal((await post()).status, 429);
  t.mock.timers.tick(60_001);
  assert.equal((await post()).status, 429, 'a slow in-flight owner cannot overlap after the rate window');
  allowed = false; release(); assert.equal((await first).status, 403); assert.equal(writes, 0);
});

test('storage diagnostics are demand-only, authorized before I/O and rechecked before delivery', async () => {
  const app = new Hono(); let allowed = false, reads = 0, writes = 0, revoke = false;
  registerStorageDiagnostics(app, '/storage', {
    authorize: () => { const check = () => { if (!allowed) throw new HTTPException(403); }; check(); return check; },
    stats: async () => { reads++; if (revoke) allowed = false;
      return { databaseBytes: 100, walBytes: 20, availableBytes: 1234, lowSpace: true, walPressure: false }; },
    checkpoint: () => { writes++; return { deferred: false, busy: 0, logFrames: 1, checkpointedFrames: 1 }; },
  });
  assert.equal(reads, 0); assert.equal((await app.request('/storage')).status, 403); assert.equal(reads, 0);
  allowed = true;
  const response = await app.request('/storage'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(writes, 0);
  revoke = true; assert.equal((await app.request('/storage')).status, 403); assert.equal(reads, 2);
  assert.equal(writes, 0);
});

test('checkpoint only accepts an explicit empty JSON command and is rate limited without automatic retries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const app = new Hono(); let writes = 0;
  registerStorageDiagnostics(app, '/storage', { authorize: () => () => {}, stats: async () => { throw Error('private path'); },
    checkpoint: () => { writes++; return { deferred: true }; } });
  const post = (body: string, type = 'application/json') => app.request('/storage/checkpoint', {
    method: 'POST', headers: { 'Content-Type': type }, body,
  });
  assert.equal((await post('{}', 'text/plain')).status, 415);
  for (const body of ['null', '[]', '{"force":true}', 'bad']) assert.equal((await post(body)).status, 400);
  assert.equal(writes, 0); assert.equal((await post('{}')).status, 200); assert.equal(writes, 1);
  const busy = await post('{}'); assert.equal(busy.status, 429); assert.equal(busy.headers.get('Retry-After'), '60');
  assert.equal(writes, 1); t.mock.timers.tick(60_000);
  assert.equal((await post('{}')).status, 200); assert.equal(writes, 2);
  const failed = await app.request('/storage'); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('private path'));
});

test('admin snapshot includes history phases without adding reads or crossing authorization', async () => {
  const app = new Hono(), history = new HistoryDiagnostics(); let allowed = true;
  app.use('/messages', history.middleware());
  app.get('/messages', c => { observeHistoryStage('page', 4); return c.json({ error: 'unavailable' }, 503); });
  registerStorageDiagnostics(app, '/storage', {
    authorize: () => { if (!allowed) throw new HTTPException(403); return () => {}; },
    stats: async () => ({ databaseBytes: 100, walBytes: 0, availableBytes: 1234, lowSpace: false, walPressure: false }),
    checkpoint: () => { throw Error('GET must never checkpoint'); }, history,
  });
  await app.request('/messages');
  const first = await (await app.request('/storage')).json();
  assert.equal(first.history.statuses['503'], 1); assert.equal(first.history.stages.page.ms, 4);
  const second = await (await app.request('/storage')).json();
  assert.deepEqual(second.history, first.history, 'reading diagnostics is not a history request');
  allowed = false;
  const denied = await app.request('/storage'); assert.equal(denied.status, 403);
  assert.equal(Object.hasOwn(await denied.json(), 'history'), false);
});
