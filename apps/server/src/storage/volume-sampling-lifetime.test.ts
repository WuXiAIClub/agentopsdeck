import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { StorageAdmissionDeferred } from './work-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerStorageDiagnostics } from './diagnostics-http.js';

class Owner extends EventEmitter {
  messages: { id: number; kind: string }[] = [];
  terminations = 0;
  postMessage(message: { id: number; kind: string }) {
    this.messages.push(message);
    queueMicrotask(() => this.emit('message', { id: message.id, kind: message.kind, ok: true,
      ...(message.kind === 'begin' ? { volume: '42' } : {}) }));
  }
  ref() {} unref() {}
  terminate() { this.terminations++; return Promise.resolve(1); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const timeout = (error: unknown) => error instanceof StorageAdmissionDeferred && error.message === 'volume-sample-timeout';
const capacity = (error: unknown) => error instanceof StorageAdmissionDeferred && error.message === 'coordinator-capacity';
const root = '/private-sampling-lifetime-fixture';

for (const late of ['resolve', 'reject'] as const) for (const sinkFails of [false, true]) {
  test(`sampling deadline releases only unstarted request; late ${late}, sink failure=${sinkFails}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = new Owner(), rows: any[] = [];
    let resolve!: (v: string) => void, reject!: (e: unknown) => void, calls = 0, samples = 0, launches = 0;
    const originalSample = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const diagnostics = new PerformanceDiagnostics(line => { rows.push(JSON.parse(line)); if (sinkFails) throw Error('private-sink'); });
    const admission = new AsyncVolumeAdmission(() => { launches++; return owner as unknown as Worker; }, diagnostics,
      { requestTimeoutMs: 10 }, () => ++samples === 1 ? originalSample : '42');
    const original = admission.run(root, 'durable', 1, async () => ++calls);
    const refused = assert.rejects(original, timeout);
    t.mock.timers.tick(10); await refused;
    assert.equal(admission.snapshot().acceptedRequests, 0);
    assert.equal(admission.snapshot().activeWriters, 0);
    assert.equal(admission.snapshot().pendingVolumeSamples, 1);
    assert.equal(admission.snapshot().recoveryProofs, 0);
    assert.equal(owner.messages.length, 0); assert.equal(calls, 0);
    const failed = diagnostics.snapshot().events.find(row => row.step === 5 && row.timedOut === 1);
    assert.equal(failed?.deferred, 1); assert.equal(failed?.unknown ?? 0, 0);
    assert.equal(failed?.phase, 'finished'); assert.equal(failed?.category, 'failed');
    assert.equal(await admission.run(root, 'durable', 1, async () => ++calls), 1);
    assert.equal(launches, 1); assert.equal(owner.terminations, 0);
    assert.deepEqual(owner.messages.map(m => [m.id, m.kind]), [[1, 'begin'], [1, 'finish']]);
    if (late === 'resolve') resolve('42'); else reject(Error('private-late-sample'));
    await flush(); t.mock.timers.tick(100_000); await flush();
    assert.equal(admission.snapshot().pendingVolumeSamples, 0);
    assert.equal(owner.messages.length, 2); assert.equal(calls, 1);
    assert.equal(rows.filter(row => row.step === 5 && row.phase === 'finished').length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private-|transient-/);
  });
}

for (const sharedPromise of [false, true]) test(`detached samples retain budget until actual settlement; shared Promise=${sharedPromise}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new Owner(), resolves: ((v: string) => void)[] = []; let samples = 0, calls = 0;
  const common = new Promise<string>(resolve => { if (sharedPromise) resolves.push(resolve); });
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}),
    { requestTimeoutMs: 10 }, () => { samples++; return sharedPromise ? common : new Promise<string>(resolve => resolves.push(resolve)); });
  const originals = Array.from({ length: 256 }, () => admission.run(root, 'durable', 1, async () => ++calls));
  const results = Promise.allSettled(originals);
  try {
    assert.equal(admission.snapshot().pendingVolumeSamples, 256);
    t.mock.timers.tick(10);
    assert.ok((await results).every(result => result.status === 'rejected' && timeout(result.reason)));
    assert.equal(admission.snapshot().acceptedRequests, 0); assert.equal(admission.snapshot().activeWriters, 0);
    assert.equal(admission.snapshot().pendingVolumeSamples, 256);
    const before = admission.snapshot();
    await assert.rejects(admission.run(root, 'durable', 1, async () => ++calls), capacity);
    assert.deepEqual(admission.snapshot(), before); assert.equal(samples, 256);
    resolves[0]!('42'); await flush();
    assert.equal(admission.snapshot().pendingVolumeSamples, sharedPromise ? 0 : 255);
    assert.equal(owner.messages.length, 0); assert.equal(calls, 0);
  } finally {
    for (const resolve of resolves) resolve('42');
    await results; await flush();
  }
  assert.equal(admission.snapshot().pendingVolumeSamples, 0);
});

test('native Promise observation does not execute its own then getter', async () => {
  const owner = new Owner(); let getters = 0;
  const sample = Promise.resolve('42');
  Object.defineProperty(sample, 'then', { get() { getters++; throw Error('private-then'); } });
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}), {}, () => sample);
  assert.equal(await admission.run(root, 'durable', 1, async () => 17), 17);
  assert.equal(getters, 0); assert.equal(admission.snapshot().pendingVolumeSamples, 0);
});

test('non-native thenable and revoked Proxy binding refuse without executing getters or writer', async () => {
  const owner = new Owner(); let getters = 0, calls = 0;
  const thenable = Object.defineProperty({}, 'then', { get() { getters++; throw Error('private-thenable'); } });
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  for (const value of [thenable, proxy]) {
    const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}), {},
      () => value as Promise<string>);
    await assert.rejects(admission.run(root, 'durable', 1, async () => ++calls), /volume-changed/);
    assert.equal(admission.snapshot().pendingVolumeSamples, 0); assert.equal(admission.snapshot().activeWriters, 0);
  }
  assert.equal(getters, 0); assert.equal(calls, 0); assert.equal(owner.messages.length, 0);
});

test('sample deadline cannot settle or release an already dispatched original writer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new Owner(); let release!: () => void, calls = 0, settled = false;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}),
    { requestTimeoutMs: 10 }, () => Promise.resolve('42'));
  const work = admission.run(root, 'durable', 1, async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return 7; });
  const observed = work.then(value => { settled = true; return value; });
  await flush();
  t.mock.timers.tick(100_000); await flush();
  assert.equal(settled, false); assert.equal(calls, 1);
  assert.equal(admission.snapshot().pendingVolumeSamples, 0); assert.equal(admission.snapshot().activeWriters, 1);
  assert.equal(admission.snapshot().acceptedRequests, 1); assert.equal(owner.messages.length, 1);
  release(); assert.equal(await observed, 7);
  assert.equal(admission.snapshot().activeWriters, 0); assert.equal(owner.messages.length, 2);
});

test('operator recovery snapshot exposes detached sample budget without sampling again or changing authority', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new Owner(); let resolve!: (v: string) => void, samples = 0, allowed = true;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}),
    { requestTimeoutMs: 10 }, () => { samples++; return new Promise<string>(yes => { resolve = yes; }); });
  const refused = assert.rejects(admission.run(root, 'durable', 1, async () => assert.fail('must not write')), timeout);
  const app = new Hono();
  registerStorageDiagnostics(app, '/storage', {
    authorize: () => { const check = () => { if (!allowed) throw new HTTPException(403); }; check(); return check; },
    stats: () => assert.fail('recovery observation must not stat'), checkpoint: () => assert.fail('must not checkpoint'),
    coordinator: () => admission.snapshot(),
  });
  t.mock.timers.tick(10); await refused;
  const before = admission.snapshot();
  const response = await app.request('/storage/recovery');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).coordinator.pendingVolumeSamples, 1);
  assert.deepEqual(admission.snapshot(), before); assert.equal(samples, 1);
  allowed = false; const denied = await app.request('/storage/recovery');
  assert.equal(denied.status, 403); assert.equal(Object.hasOwn(await denied.json(), 'coordinator'), false);
  resolve('42'); await flush(); assert.equal(admission.snapshot().pendingVolumeSamples, 0);
  assert.equal(owner.messages.length, 0);
});
