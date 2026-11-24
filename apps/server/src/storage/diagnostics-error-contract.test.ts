import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerStorageDiagnostics } from './diagnostics-http.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncVolumeAdmission } from './async-volume-admission.js';

const faults: { name: string; create: () => unknown }[] = [
  { name: 'revoked proxy', create: () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; } },
  { name: 'throwing prototype trap', create: () => new Proxy({}, { getPrototypeOf() { throw Error('private-prototype'); } }) },
  { name: 'throwing HTTP status getter', create: () => Object.defineProperty(new HTTPException(403), 'status', {
    get() { throw Error('private-status'); } }) },
  { name: 'non-numeric HTTP status', create: () => Object.defineProperty(new HTTPException(403), 'status', {
    value: { [Symbol.toPrimitive]() { throw Error('private-coercion'); } } }) },
  { name: 'successful HTTP status', create: () => new HTTPException(200) },
  { name: 'lookalike authority failure', create: () => ({ status: 403, message: 'private-credential' }) },
];
const endpoints = ['/storage', '/storage/recovery', '/storage/checkpoint'];
const request = (app: Hono, path: string) => app.request(path, path.endsWith('/checkpoint')
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : undefined);

for (const fault of faults) {
  test(`all storage diagnostic error exits fail closed without arbitrary exception inspection (${fault.name})`, async () => {
    for (const path of endpoints) {
      const app = new Hono(); let escaped = 0, effects = 0;
      app.onError((_error, c) => { escaped++; return c.json({ error: 'escaped' }, 500); });
      registerStorageDiagnostics(app, '/storage', {
        authorize: () => { throw fault.create(); },
        stats: () => { effects++; throw Error('private-stat'); },
        checkpoint: () => { effects++; throw Error('private-write'); },
      });
      const response = await request(app, path);
      assert.equal(response.status, 503, path); assert.equal(escaped, 0); assert.equal(effects, 0);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Storage maintenance unavailable' });
    }
  });
}

for (const status of [400, 401, 403, 415, 426, 429, 503] as const) {
  test(`real guarded HTTP exceptions preserve status ${status} without raw private responses`, async () => {
    for (const path of endpoints) {
      const app = new Hono(); let reads = 0;
      registerStorageDiagnostics(app, '/storage', {
        authorize: () => { throw new HTTPException(status, { res: new Response('private-token', { status }) }); },
        stats: () => { reads++; throw Error('unused'); }, checkpoint: () => { reads++; throw Error('unused'); },
      });
      const response = await request(app, path); assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: 'Storage maintenance unavailable' }); assert.equal(reads, 0);
    }
  });
}

test('arbitrary original storage failures remain sanitized on all diagnostic routes', async () => {
  for (const path of endpoints) {
    const app = new Hono(); let escaped = 0;
    app.onError((_error, c) => { escaped++; return c.json({ error: 'escaped' }, 500); });
    const error = faults[0]!.create();
    registerStorageDiagnostics(app, '/storage', {
      authorize: () => () => {}, stats: () => { throw error; }, checkpoint: () => { throw error; },
      coordinator: () => { throw error; },
    });
    const response = await request(app, path); assert.equal(response.status, 503); assert.equal(escaped, 0);
    assert.deepEqual(await response.json(), { error: 'Storage maintenance unavailable' });
  }
});

test('classification failure is queryable even with a throwing log sink and does not bypass authority', async () => {
  let time = 0, sinkCalls = 0;
  const app = new Hono(), diagnostics = new PerformanceDiagnostics(() => { sinkCalls++; throw Error('private-sink'); },
    () => time += 100);
  let authorized = false, observations = 0;
  registerStorageDiagnostics(app, '/storage', {
    diagnostics, performance: () => { observations++; return diagnostics.snapshot(); },
    coordinator: () => { observations++; return new AsyncVolumeAdmission().snapshot(); },
    authorize: () => { if (!authorized) throw faults[0]!.create(); return () => {}; },
    stats: () => { throw Error('unused'); }, checkpoint: () => { throw Error('unused'); },
  });
  const response = await app.request('/storage/recovery'); assert.equal(response.status, 503); assert.equal(observations, 0);
  authorized = true;
  const recovered = await (await app.request('/storage/recovery')).json();
  const event = recovered.performance.events.find((event: { operation: string }) => event.operation === 'storage-diagnostics-failure');
  assert.equal(event.operation, 'storage-diagnostics-failure'); assert.equal(event.classificationUnknown, 1);
  assert.equal(event.delivery, 'failed');
  assert.equal(recovered.performance.totals.sinkFailures,
    recovered.performance.events.filter((event: { delivery: string }) => event.delivery === 'failed').length);
  // The response snapshot precedes its own outer request's finally trace.
  // Observe the completed request separately; never require future evidence
  // to have existed in the earlier HTTP payload.
  const completed = diagnostics.snapshot();
  assert.ok(completed.events.some(event => event.operation === 'system-read-wait'));
  assert.equal(completed.totals.sinkFailures, sinkCalls);
  assert.equal(completed.totals.sinkFailures, completed.events.filter(event => event.delivery === 'failed').length);
  assert.ok(completed.totals.sinkFailures > recovered.performance.totals.sinkFailures);
  assert.doesNotMatch(JSON.stringify(recovered), /private-|credential/);
});

test('HTTP status is inspected exactly once, without inspecting exception message or response', async () => {
  const app = new Hono(); let reads = 0;
  const failure = new HTTPException(403);
  Object.defineProperties(failure, {
    status: { get() { reads++; if (reads > 1) throw Error('second inspection'); return 403; } },
    message: { get() { throw Error('private-message'); } }, res: { get() { throw Error('private-response'); } },
  });
  registerStorageDiagnostics(app, '/storage', { diagnostics: new PerformanceDiagnostics(() => {}),
    authorize: () => { throw failure; }, stats: () => { throw Error('unused'); }, checkpoint: () => { throw Error('unused'); } });
  const response = await app.request('/storage/recovery'); assert.equal(response.status, 403); assert.equal(reads, 1);
  assert.deepEqual(await response.json(), { error: 'Storage maintenance unavailable' });
});

test('aborted recovery observation with an arbitrary rejection reason stays sanitized without starting an owner', async () => {
  const app = new Hono(), controller = new AbortController(), diagnostics = new PerformanceDiagnostics(() => {});
  let launches = 0, observations = 0;
  const coordinator = new AsyncVolumeAdmission(() => { launches++; throw Error('must not start'); });
  registerStorageDiagnostics(app, '/storage', { diagnostics,
    authorize: () => () => {}, coordinator: () => coordinator.snapshot(),
    performance: () => { observations++; return diagnostics.snapshot(); },
    stats: () => { throw Error('must not read'); }, checkpoint: () => { throw Error('must not checkpoint'); } });
  controller.abort(faults[0]!.create());
  const response = await app.request(new Request('http://localhost/storage/recovery', { signal: controller.signal }));
  assert.equal(response.status, 503); assert.equal(launches, 0); assert.equal(observations, 0);
  assert.deepEqual(await response.json(), { error: 'Storage maintenance unavailable' });
  const event = diagnostics.snapshot().events.at(-1)!;
  assert.equal(event.operation, 'storage-diagnostics-failure'); assert.equal(event.cancelled, 1);
  assert.equal(event.classificationUnknown, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-|credential/);
});
