import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { AuthReadCancelledError, AuthRouteReadWait, type AuthRouteReadStep } from './route-read-wait.js';
import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence } from './route-persistence.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const req = (signal?: AbortSignal) => new Request('http://fixture/', signal ? { signal } : undefined);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AuthRoutePersistence(diagnostics, 2);
  return { diagnostics, owner, wait: new AuthRouteReadWait(owner, diagnostics, 5) };
}
for (const step of [1, 2, 6, 7, 9, 10, 12, 13, 17, 20, 22, 26, 31, 33, 35, 37, 38, 40, 43, 48, 49, 63, 64, 110] as const) for (const late of ['resolve', 'reject'] as const)
  test(`phase ${step}: expired HTTP wait retains original read until late ${late}`, { timeout: 3000 }, async () => {
    const { diagnostics, owner, wait } = fixture(), original = held<unknown>(), request = req();
    let calls = 0;
    try {
      await assert.rejects(wait.run(request, step, () => { calls++; return original.promise; }), AuthPersistenceError);
      assert.equal(calls, 1); assert.equal(owner.pending, 1);
      assert.equal(getEventListeners(request.signal, 'abort').length, 0);
      const timeout = diagnostics.snapshot().events.find(row => row.timedOut === 1)!;
      assert.equal(timeout.step, step); assert.equal(timeout.pending, 1); assert.equal(timeout.settled, undefined);
    } finally {
      if (late === 'resolve') original.resolve({ privateResult: 'NEVER_LOG_THIS' });
      else original.reject(Error('NEVER_LOG_THIS token and SQL'));
      await tick();
    }
    assert.equal(owner.pending, 0); assert.equal(calls, 1);
    assert.equal((await wait.run(req(), step, () => false)).value, false);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /NEVER_LOG_THIS|token and SQL/);
  });

test('cancellation does not release original admission, late rejection is observed', async () => {
  const { owner, wait, diagnostics } = fixture(), original = held<unknown>(), controller = new AbortController(), request = req(controller.signal);
  const flight = wait.run(request, 1, () => original.promise);
  controller.abort();
  await assert.rejects(flight, AuthReadCancelledError);
  assert.equal(owner.pending, 1); assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  const cancelled = diagnostics.snapshot().events.filter(row => row.cancelled === 1);
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0]!.step, 1); assert.equal(cancelled[0]!.pending, 1);
  assert.equal(cancelled[0]!.settled, undefined); assert.equal(cancelled[0]!.timedOut, undefined);
  original.reject(Error('private')); await tick(); assert.equal(owner.pending, 0);
});
test('pre-cancelled request never invokes a read', async () => {
  const { owner, wait, diagnostics } = fixture(), controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(wait.run(req(controller.signal), 1, () => { calls++; }), AuthReadCancelledError);
  assert.equal(calls, 0); assert.equal(owner.pending, 0);
  assert.equal(diagnostics.snapshot().events.find(row => row.cancelled === 1)?.pending, 0);
});
test('abort and an already queued deadline report only the winning cancellation', async t => {
  const diagnostics = new PerformanceDiagnostics(() => {}), owner = new AuthRoutePersistence(diagnostics, 5000);
  const wait = new AuthRouteReadWait(owner, diagnostics, 30_000), original = held<boolean>();
  const originalTimer = globalThis.setTimeout;
  let deadline!: () => void;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    if (ms === 30_000) deadline = callback;
    return originalTimer(callback, ms);
  });
  const controller = new AbortController(), request = req(controller.signal); let calls = 0;
  try {
    const flight = wait.run(request, 1, () => { calls++; return original.promise; });
    controller.abort(); deadline();
    await assert.rejects(flight, AuthReadCancelledError);
    const outcomes = diagnostics.snapshot().events.filter(row => row.cancelled || row.timedOut);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.cancelled, 1);
    assert.equal(outcomes[0]!.timedOut, undefined); assert.equal(outcomes[0]!.pending, 1);
    assert.equal(owner.pending, 1); assert.equal(calls, 1);
    assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  } finally { original.reject(Error('PRIVATE late read')); await tick(); }
  assert.equal(owner.pending, 0); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
});
test('256 expired reads share original budget with writes; real settlement restores admission', { timeout: 3000 }, async () => {
  const { owner, wait } = fixture(), original = held<unknown>(); let calls = 0;
  try {
    const reads = Array.from({ length: 256 }, () => wait.run(req(), 1, () => { calls++; return original.promise; }));
    assert.ok((await Promise.allSettled(reads)).every(row => row.status === 'rejected'));
    assert.equal(owner.pending, 256); assert.equal(calls, 256);
    await assert.rejects(wait.run(req(), 2, () => { calls++; }), AuthPersistenceError);
    await assert.rejects(owner.run(5, () => { calls++; return false; }), AuthPersistenceError);
    assert.equal(calls, 256); assert.equal(owner.pending, 256);
  } finally { original.resolve(undefined); await tick(); }
  assert.equal(owner.pending, 0); assert.equal((await owner.run(5, () => true)).value, true);
});
test('result boxing preserves a single then inspection', async () => {
  const { wait } = fixture(); let inspected = 0;
  const value = Object.defineProperty({}, 'then', { get() {
    if (++inspected > 1) throw Error('private second inspection'); return undefined;
  } });
  assert.equal((await wait.run(req(), 1, () => value)).value, value); assert.equal(inspected, 1);
});
test('mutation phases and invalid timeout configuration are rejected before work', async () => {
  const { owner, diagnostics, wait } = fixture(); let calls = 0;
  for (const step of [0, 3, 4, 5, 8, 11, 14, NaN, Infinity])
    await assert.rejects(wait.run(req(), step as AuthRouteReadStep, () => { calls++; }), AuthPersistenceError);
  assert.equal(calls, 0); assert.equal(owner.pending, 0);
  for (const timeout of [0, -1, 1.5, NaN, Infinity, 2_147_483_648])
    assert.throws(() => new AuthRouteReadWait(owner, diagnostics, timeout), AuthPersistenceError);
});
test('abort during original observation prevents successful delivery', async () => {
  const controller = new AbortController(), request = req(controller.signal);
  let armed = true;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => { if (armed) { armed = false; controller.abort(); } return 0; });
  const owner = new AuthRoutePersistence(diagnostics), wait = new AuthRouteReadWait(owner, diagnostics, 10);
  await assert.rejects(wait.run(request, 1, () => true), AuthReadCancelledError);
  await tick(); assert.equal(owner.pending, 0); assert.equal(getEventListeners(request.signal, 'abort').length, 0);
});

test('timeout log sink failure does not release SQL or expose private errors', async () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  const owner = new AuthRoutePersistence(diagnostics, 2), wait = new AuthRouteReadWait(owner, diagnostics, 5);
  const original = held<unknown>();
  try {
    await assert.rejects(wait.run(req(), 12, () => original.promise), AuthPersistenceError);
    assert.equal(owner.pending, 1);
    assert.ok(diagnostics.snapshot().events.some(row => row.timedOut === 1 && row.delivery === 'failed'));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE sink/);
  } finally { original.reject(Error('PRIVATE late owner')); await tick(); }
  assert.equal(owner.pending, 0);
});

test('cancellation log sink failure cannot release, retry or acknowledge original SQL', async () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  const owner = new AuthRoutePersistence(diagnostics, 2), wait = new AuthRouteReadWait(owner, diagnostics, 30_000);
  const original = held<unknown>(), controller = new AbortController(); let calls = 0;
  try {
    const flight = wait.run(req(controller.signal), 6, () => { calls++; return original.promise; });
    controller.abort();
    await assert.rejects(flight, AuthReadCancelledError);
    assert.equal(owner.pending, 1); assert.equal(calls, 1);
    const row = diagnostics.snapshot().events.find(row => row.cancelled === 1)!;
    assert.equal(row.step, 6); assert.equal(row.pending, 1); assert.equal(row.delivery, 'failed');
    assert.equal(row.settled, undefined); assert.doesNotMatch(JSON.stringify(row), /PRIVATE/);
  } finally { original.reject(Error('PRIVATE late owner')); await tick(); }
  assert.equal(owner.pending, 0); assert.equal(calls, 1);
});

test('limiter write phases cannot use cancellable read waits or dispatch through them', async () => {
  const { owner, wait } = fixture(); let calls = 0;
  for (const step of [18, 19]) await assert.rejects(
    wait.run(req(), step as AuthRouteReadStep, () => { calls++; }), AuthPersistenceError);
  assert.equal(calls, 0); assert.equal(owner.pending, 0);
});

test('stage 64 control read cancellation retains admission and logs original late settlement', async () => {
  let elapsed = 0;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => elapsed), owner = new AuthRoutePersistence(diagnostics, 2);
  const wait = new AuthRouteReadWait(owner, diagnostics, 5), original = held<unknown>(), controller = new AbortController();
  let calls = 0;
  const flight = wait.run(req(controller.signal), 64, () => { calls++; return original.promise; });
  try {
    controller.abort();
    await assert.rejects(flight, AuthReadCancelledError);
    assert.equal(owner.pending, 1); assert.equal(calls, 1);
    const cancelled = diagnostics.snapshot().events.find(row => row.step === 64 && row.cancelled === 1)!;
    assert.equal(cancelled.pending, 1); assert.equal(cancelled.settled, undefined);
  } finally { elapsed = 100; original.resolve({ private: 'PRIVATE_CONTROL_RESULT' }); await tick(); }
  assert.equal(owner.pending, 0); assert.equal(calls, 1);
  assert.ok(diagnostics.snapshot().events.some(row => row.step === 64 && row.settled === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE_CONTROL_RESULT/);
});

test('cancelled limiter check retains original owner admission and observes late rejection', async () => {
  const { owner, wait, diagnostics } = fixture(), pending = held<unknown>(), controller = new AbortController();
  let calls = 0;
  const flight = wait.run(req(controller.signal), 17, () => { calls++; return pending.promise; });
  try {
    controller.abort(); await assert.rejects(flight, AuthReadCancelledError);
    assert.equal(owner.pending, 1); assert.equal(calls, 1);
    const event = diagnostics.snapshot().events.find(row => row.step === 17 && row.cancelled === 1)!;
    assert.equal(event.pending, 1); assert.equal(event.settled, undefined);
  } finally { pending.reject(Error('private-limiter-SQL')); await tick(); }
  assert.equal(owner.pending, 0); assert.equal(calls, 1);
  assert.ok(diagnostics.snapshot().events.some(row => row.step === 17 && row.unknown === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-limiter-SQL/);
});
