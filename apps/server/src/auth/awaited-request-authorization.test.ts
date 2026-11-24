import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AwaitedRequestAuthorization, type RequestAuthorization } from './awaited-request-authorization.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/api/events/stream', signal ? { signal } : undefined);

for (const late of ['resolve', 'reject'] as const) test(`authority closure retains timed-out original until late ${late}`, async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}), 2, 5);
  const original = deferred<boolean>(); let calls = 0, closed = false;
  assert.equal(await gate.check(request(), () => { calls++; return original.promise; }), 'unavailable');
  const closing = gate.close(); void closing.then(() => { closed = true; });
  assert.equal(gate.close(), closing);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(gate.pending, 1);
    assert.equal(await gate.check(request(), () => { calls++; return true; }), 'unavailable');
    assert.equal(calls, 1);
  } finally {
    if (late === 'resolve') original.resolve(true); else original.reject(Error('PRIVATE late SQL'));
    await closing;
  }
  assert.equal(gate.pending, 0); assert.equal(closed, true);
});

test('authority granted during close cannot publish a late authorization result', async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}));
  const original = deferred<boolean>();
  const checking = gate.check(request(), () => original.promise);
  const closing = gate.close(); original.resolve(true);
  assert.equal(await checking, 'unavailable'); await closing;
});

test('awaited request authority grants only literal true and observes sanitized failures', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics);
  for (const value of [false, null, undefined, {}, 1, 'true']) {
    assert.equal(await gate.check(request(), (() => Promise.resolve(value)) as RequestAuthorization), 'denied');
  }
  assert.equal(await gate.check(request(), () => true), 'authorized');
  assert.equal(await gate.check(request(), async () => true), 'authorized');
  assert.equal(await gate.check(request(), () => { throw Error('PRIVATE sync secret'); }), 'unavailable');
  assert.equal(await gate.check(request(), () => Promise.reject(Error('PRIVATE async secret'))), 'unavailable');
  assert.equal(gate.pending, 0);
  assert.ok(diagnostics.snapshot().events.some(e => e.step === 6 && e.unknown === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|secret|fixture/);
});

test('authority rejection with hostile then getter is unavailable, not a grant or an escaped rejection', async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}));
  let reads = 0;
  const value = Object.defineProperty({}, 'then', { get() { reads++; throw Error('PRIVATE getter'); } });
  assert.equal(await gate.check(request(), (() => value) as unknown as RequestAuthorization), 'unavailable');
  assert.equal(reads, 1); assert.equal(gate.pending, 0);
});

for (const source of ['request', 'stream'] as const) test(`${source} cancellation detaches HTTP but retains original authority until settlement`, async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 2);
  const controller = new AbortController(), original = deferred<boolean>();
  const req = request(source === 'request' ? controller.signal : undefined);
  let calls = 0;
  const flight = gate.check(req, () => { calls++; return original.promise; }, source === 'stream' ? controller.signal : undefined);
  controller.abort();
  assert.equal(await flight, 'cancelled'); assert.equal(gate.pending, 1); assert.equal(calls, 1);
  await delay(8);
  const warning = diagnostics.snapshot().events.find(e => e.phase === 'pending')!;
  assert.equal(warning.step, 6); assert.equal(warning.pending, 1); assert.equal(warning.settled, undefined);
  original.reject(Error('PRIVATE late authority'));
  await new Promise(yes => setImmediate(yes));
  assert.equal(gate.pending, 0); assert.equal(calls, 1);
  assert.ok(diagnostics.snapshot().events.some(e => e.unknown === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|late authority/);
  assert.equal(await gate.check(request(), () => true), 'authorized');
});

test('pre-aborted and reentrant-aborted authority requests never publish a grant', async () => {
  const gate = new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}));
  const controller = new AbortController(); controller.abort(); let calls = 0;
  assert.equal(await gate.check(request(controller.signal), () => { calls++; return true; }), 'cancelled');
  assert.equal(calls, 0); assert.equal(gate.pending, 0);
  const reentrant = new AbortController();
  assert.equal(await gate.check(request(reentrant.signal), () => { calls++; reentrant.abort(); return true; }), 'cancelled');
  assert.equal(calls, 1); assert.equal(gate.pending, 0);
});

test('256 cancelled HTTP waits cannot release original authority capacity; settlement recovers admission', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics);
  const controllers = Array.from({ length: 256 }, () => new AbortController()), original = deferred<boolean>(); let calls = 0;
  const flights = controllers.map(controller => gate.check(request(controller.signal), () => { calls++; return original.promise; }));
  for (const controller of controllers) controller.abort();
  assert.deepEqual(await Promise.all(flights), Array(256).fill('cancelled'));
  assert.equal(gate.pending, 256); assert.equal(calls, 256);
  let excess = 0;
  assert.equal(await gate.check(request(), () => { excess++; return true; }), 'unavailable');
  assert.equal(excess, 0); assert.equal(gate.pending, 256);
  assert.ok(diagnostics.snapshot().events.some(e => e.deferred === 1 && e.pending === 256 && e.unknown === undefined));
  original.resolve(false); await new Promise(yes => setImmediate(yes));
  assert.equal(gate.pending, 0);
  assert.equal(await gate.check(request(), () => true), 'authorized');
});
