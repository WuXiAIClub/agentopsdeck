import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { AwaitedRequestAuthorization } from './awaited-request-authorization.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = (signal?: AbortSignal) => new Request('http://fixture/', signal ? { signal } : undefined);

for (const late of ['success', 'failure'] as const) test(`read wait expires without granting or releasing original authority, late ${late}`, { timeout: 3000 }, async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 2, 5);
  const original = deferred<boolean>(), controller = new AbortController(), req = request(controller.signal);
  let calls = 0;
  assert.equal(await gate.check(req, () => { calls++; return original.promise; }), 'unavailable');
  assert.equal(gate.pending, 1); assert.equal(calls, 1);
  assert.equal(getEventListeners(req.signal, 'abort').length, 0);
  const row = diagnostics.snapshot().events.find(e => e.timedOut === 1)!;
  assert.equal(row.step, 6); assert.equal(row.pending, 1); assert.equal(row.settled, undefined);
  if (late === 'success') original.resolve(true); else original.reject(Error('PRIVATE late SQL authority'));
  await new Promise(yes => setImmediate(yes));
  assert.equal(gate.pending, 0); assert.equal(calls, 1);
  assert.equal(await gate.check(request(), () => false), 'denied');
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|SQL authority/);
});

test('256 timed out HTTP waits retain original capacity until actual settlement', { timeout: 3000 }, async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 2, 5);
  const original = deferred<boolean>(); let calls = 0;
  try {
    const flights = Array.from({ length: 256 }, () => gate.check(request(), () => { calls++; return original.promise; }));
    assert.deepEqual(await Promise.all(flights), Array(256).fill('unavailable'));
    assert.equal(gate.pending, 256); assert.equal(calls, 256);
    assert.equal(await gate.check(request(), () => { calls++; return true; }), 'unavailable');
    assert.equal(calls, 256); assert.equal(gate.pending, 256);
  } finally { original.resolve(false); }
  await new Promise(yes => setImmediate(yes));
  assert.equal(gate.pending, 0); assert.equal(await gate.check(request(), () => true), 'authorized');
});

for (const source of ['request', 'stream'] as const) test(`${source} abort precedes deadline, logs cancellation and removes listeners`, { timeout: 3000 }, async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 2, 20);
  const original = deferred<boolean>(), requestController = new AbortController(), streamController = new AbortController();
  const req = request(requestController.signal);
  const flight = gate.check(req, () => original.promise, streamController.signal);
  if (source === 'request') requestController.abort(); else streamController.abort();
  assert.equal(await flight, 'cancelled'); assert.equal(gate.pending, 1);
  const outcomes = diagnostics.snapshot().events.filter(e => e.cancelled || e.timedOut);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.cancelled, 1);
  assert.equal(outcomes[0]!.step, 6); assert.equal(outcomes[0]!.pending, 1);
  assert.equal(outcomes[0]!.settled, undefined);
  assert.equal(getEventListeners(req.signal, 'abort').length, 0);
  assert.equal(getEventListeners(streamController.signal, 'abort').length, 0);
  await delay(30);
  assert.ok(diagnostics.snapshot().events.every(e => e.timedOut === undefined));
  original.resolve(true); await new Promise(yes => setImmediate(yes)); assert.equal(gate.pending, 0);
});

test('immediate authority and pre-dispatch cancellation do not leave deadlines behind', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 2, 5);
  assert.equal(await gate.check(request(), () => true), 'authorized');
  assert.equal(await gate.check(request(), () => false), 'denied');
  const controller = new AbortController(); controller.abort(); let calls = 0;
  assert.equal(await gate.check(request(controller.signal), () => { calls++; return true; }), 'cancelled');
  assert.equal(calls, 0); assert.equal(gate.pending, 0);
  const outcomes = diagnostics.snapshot().events.filter(e => e.cancelled || e.timedOut);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.cancelled, 1);
  assert.equal(outcomes[0]!.pending, 0); assert.equal(outcomes[0]!.step, 6);
  await delay(10); assert.ok(diagnostics.snapshot().events.every(e => e.timedOut === undefined));
});

test('invalid read wait deadlines fail closed before any authority dispatch', () => {
  for (const timeout of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => new AwaitedRequestAuthorization(new PerformanceDiagnostics(() => {}), 2, timeout), AuthPersistenceError);
  }
});

test('failed timeout log sink cannot grant or release original authorization', { timeout: 3000 }, async () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  const gate = new AwaitedRequestAuthorization(diagnostics, 2, 5), original = deferred<boolean>();
  try {
    assert.equal(await gate.check(request(), () => original.promise), 'unavailable'); assert.equal(gate.pending, 1);
    assert.ok(diagnostics.snapshot().events.some(e => e.timedOut === 1 && e.delivery === 'failed'));
  } finally { original.resolve(false); }
  await new Promise(yes => setImmediate(yes)); assert.equal(gate.pending, 0);
});

test('queued authorization deadline cannot duplicate cancellation or release original authority', async t => {
  const diagnostics = new PerformanceDiagnostics(() => {}), gate = new AwaitedRequestAuthorization(diagnostics, 5000, 30_000);
  const originalTimer = globalThis.setTimeout;
  let deadline!: () => void;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    if (ms === 30_000) deadline = callback;
    return originalTimer(callback, ms);
  });
  const original = deferred<boolean>(), controller = new AbortController(); let calls = 0;
  try {
    const flight = gate.check(request(controller.signal), () => { calls++; return original.promise; });
    controller.abort(); deadline(); assert.equal(await flight, 'cancelled');
    const outcomes = diagnostics.snapshot().events.filter(e => e.cancelled || e.timedOut);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.cancelled, 1);
    assert.equal(outcomes[0]!.timedOut, undefined); assert.equal(outcomes[0]!.pending, 1);
    assert.equal(gate.pending, 1); assert.equal(calls, 1);
  } finally { original.reject(Error('PRIVATE late authority')); await new Promise(yes => setImmediate(yes)); }
  assert.equal(gate.pending, 0); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
});

test('failed cancellation log sink cannot grant, replay or release original authorization', async () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  const gate = new AwaitedRequestAuthorization(diagnostics, 5000), original = deferred<boolean>(), controller = new AbortController();
  let calls = 0;
  try {
    const flight = gate.check(request(controller.signal), () => { calls++; return original.promise; });
    controller.abort(); assert.equal(await flight, 'cancelled');
    assert.equal(gate.pending, 1); assert.equal(calls, 1);
    const row = diagnostics.snapshot().events.find(e => e.cancelled === 1)!;
    assert.equal(row.step, 6); assert.equal(row.pending, 1); assert.equal(row.delivery, 'failed');
    assert.equal(row.settled, undefined);
  } finally { original.resolve(false); await new Promise(yes => setImmediate(yes)); }
  assert.equal(gate.pending, 0); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
});
