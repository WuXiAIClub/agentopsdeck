import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as nativeSetTimeout } from 'node:timers';
import { awaitHttpAdmission, controlledHttpDeadline } from './http-deadline-test-support.js';

const realTimer = nativeSetTimeout;
function gate() { let release!: () => void; return { promise: new Promise<void>(ok => { release = ok; }), release: () => release() }; }

test('barrier reports original early HTTP status without resubmission', async () => {
  const entered = gate(); let sends = 0;
  const response = (() => { sends++; return Promise.resolve({ status: 503 }); })();
  await assert.rejects(awaitHttpAdmission(entered.promise, response), /before admission \(503\)/);
  assert.equal(sends, 1);
});

test('barrier propagates the original rejection', async () => {
  const failure = Error('original transport failure');
  await assert.rejects(awaitHttpAdmission(gate().promise, Promise.reject(failure)), error => error === failure);
});

test('synchronous Hono response is observed once and deadline controls are restored', async t => {
  let calls = 0;
  const original = (() => { calls++; return new Response(null, { status: 503 }); })();
  await assert.rejects(awaitHttpAdmission(gate().promise, original), /before admission \(503\)/);
  const before = performance.now, clock = controlledHttpDeadline(t);
  assert.equal(await clock.expire(10, original), original);
  assert.equal(performance.now, before); assert.equal(calls, 1);
});

test('barrier accepts actual entry and bounds neither-side-settled fixtures', async () => {
  const original = gate();
  await awaitHttpAdmission(Promise.resolve(), original.promise.then(() => ({ status: 200 })));
  await assert.rejects(awaitHttpAdmission(gate().promise, new Promise(() => {}), 'isolated barrier', 5), /isolated barrier: admission barrier did not settle/);
  original.release();
});

test('controlled deadline waits real admission then expires the original budget and restores time', async t => {
  const clock = controlledHttpDeadline(t), entered = gate(), retained = gate();
  const started = performance.now(); let effects = 0, settled = false;
  const physical = (async () => {
    // Real admission can exceed the synthetic HTTP window without a race.
    await new Promise<void>(ok => realTimer(ok, 30));
    effects++; entered.release(); await retained.promise; settled = true;
    return { status: 200 };
  })();
  const original = Promise.race([physical, new Promise<{ status: number }>(ok => setTimeout(() => ok({ status: 503 }), 10))]);
  try {
    await awaitHttpAdmission(entered.promise, original);
    assert.equal(performance.now(), started);
    assert.equal((await clock.expire(10, original)).status, 503);
    assert.equal(settled, false); assert.equal(effects, 1);
    // expire() restored both timers and monotonic time before physical drain.
    await new Promise<void>(ok => setTimeout(ok, 1));
    assert.ok(performance.now() > started);
    retained.release(); assert.equal((await physical).status, 200);
    assert.equal(settled, true); assert.equal(effects, 1);
  } finally { clock.restore(); retained.release(); await physical; }
});

test('invalid expiry restores mocks and restore is idempotent', async t => {
  const original = performance.now, clock = controlledHttpDeadline(t);
  await assert.rejects(clock.expire(0, Promise.resolve()), /Invalid controlled/);
  clock.restore(); clock.restore(); assert.equal(performance.now, original);
});

test('missing original HTTP expiry is bounded by real watchdog and restores time', async t => {
  const original = performance.now, clock = controlledHttpDeadline(t, 5);
  await assert.rejects(clock.expire(10, new Promise(() => {})), /did not settle after controlled expiry/);
  assert.equal(performance.now, original);
});
