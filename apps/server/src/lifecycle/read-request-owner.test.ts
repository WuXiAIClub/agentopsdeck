import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { ReadRequestOwner, ReadRequestError } from './read-request-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const quiet = () => new PerformanceDiagnostics(() => {});
const request = (signal?: AbortSignal) => new Request('http://synthetic.invalid', signal ? { signal } : {});
test('read context awaits both authorities and provider in order', async () => {
  const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet() });
  const initial = held<string>(), provider = held<string>(), final = held<boolean>(); const calls: number[] = [];
  const work = owner.run(request(), async context => {
    calls.push(1); const before = (await context.stage(1, () => initial.promise)).value; assert.equal(before, 'actor');
    calls.push(2); const body = (await context.stage(2, () => provider.promise)).value;
    calls.push(3); assert.equal((await context.stage(3, () => final.promise)).value, true); return body;
  });
  assert.equal(owner.pending, 1); await tick(); assert.deepEqual(calls, [1]);
  initial.resolve('actor'); await tick(); assert.deepEqual(calls, [1, 2]);
  provider.resolve('body'); await tick(); assert.deepEqual(calls, [1, 2, 3]);
  final.resolve(true); assert.deepEqual(await work, { value: 'body' }); await owner.close(); assert.equal(owner.pending, 0);
});
for (const phase of [1, 2, 3]) for (const ending of ['timeout', 'abort', 'close'] as const) {
  test(`${ending} at original phase ${phase} retains ownership and prevents later stages`, async () => {
    const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet(), waitMs: ending === 'timeout' ? 10 : 1000 });
    const gate = held<string>(), entered = held<void>(), abort = new AbortController(); let calls = 0;
    const req = request(abort.signal);
    const work = owner.run(req, async context => {
      for (let step = 1; step <= 3; step++) await context.stage(step, () => {
        calls++; if (step === phase) { entered.resolve(); return gate.promise; } return 'settled';
      });
      return 'body';
    });
    const observed = assert.rejects(work, error => error instanceof ReadRequestError && error.status === (ending === 'abort' ? 408 : 503));
    await entered.promise; let closeFinished = false, close: Promise<void> | undefined;
    if (ending === 'abort') abort.abort();
    if (ending === 'close') { close = owner.close(); void close.then(() => { closeFinished = true; }); }
    if (ending !== 'close') await observed;
    assert.equal(owner.pending, 1); await tick(); assert.equal(closeFinished, false);
    gate.resolve('late'); await observed; await (close ?? owner.close()); assert.equal(owner.pending, 0); assert.equal(calls, phase);
    assert.equal(getEventListeners(req.signal, 'abort').length, 0);
  });
}
test('timed out originals keep capacity, late rejections are observed, and no retry starts', async () => {
  const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet(), waitMs: 10, limit: 2 });
  const gates = [held<string>(), held<string>()]; let starts = 0;
  const outcomes = gates.map(gate => assert.rejects(owner.run(request(), () => { starts++; return gate.promise; }), ReadRequestError));
  await Promise.all(outcomes); assert.equal(owner.pending, 2);
  await assert.rejects(owner.run(request(), () => { starts++; return 'unexpected'; }), ReadRequestError);
  assert.equal(starts, 2); const close = owner.close(); gates[0]!.reject(Error('PRIVATE error')); gates[1]!.resolve('late'); await close;
  assert.equal(owner.pending, 0); await assert.rejects(owner.run(request(), () => 'closed'), ReadRequestError);
});
test('abort before admission does not dispatch or reserve work', async () => {
  const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet() }), abort = new AbortController(); abort.abort();
  let calls = 0; await assert.rejects(owner.run(request(abort.signal), () => { calls++; return 'bad'; }), ReadRequestError);
  assert.equal(calls, 0); assert.equal(owner.pending, 0); await owner.close();
});
test('diagnostic reentrant close owns the original before any stage starts', async () => {
  let owner!: ReadRequestOwner, reentered = false, calls = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); }, () => {
    if (!reentered) { reentered = true; assert.equal(owner.pending, 1); void owner.close(); } return 0;
  });
  owner = new ReadRequestOwner('system-read-wait', { diagnostics });
  await assert.rejects(owner.run(request(), () => { calls++; return 'bad'; }), ReadRequestError);
  assert.equal(calls, 0); await owner.close();
});
test('boxed stage and result do not re-inspect a fulfilled value then getter', async () => {
  const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet() }); let inspections = 0;
  const value = { get then() { inspections++; return undefined; } };
  const result = await owner.run(request(), async context => (await context.stage(1, () => value)));
  assert.equal(result.value.value, value); assert.equal(inspections, 1); await owner.close();
});
for (const options of [{ waitMs: 0 }, { waitMs: NaN }, { limit: 0 }, { limit: 257 }]) {
  test(`invalid read owner bound ${JSON.stringify(options)} is refused`, () => {
    assert.throws(() => new ReadRequestOwner('system-read-wait', options), ReadRequestError);
  });
}
for (const ending of ['timeout', 'abort', 'close'] as const) {
  test(`${ending} signals advisory cancellation without acknowledging an ignoring provider`, async () => {
    const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet(), waitMs: ending === 'timeout' ? 10 : 1000 });
    const gate = held<string>(), entered = held<AbortSignal>(), abort = new AbortController();
    const read = owner.run(request(abort.signal), context => { entered.resolve(context.signal); return gate.promise; });
    const observed = assert.rejects(read, ReadRequestError), signal = await entered.promise;
    let closeFinished = false;
    signal.addEventListener('abort', () => { if (ending === 'close') void owner.close(); }, { once: true });
    if (ending === 'abort') abort.abort();
    const close = ending === 'close' ? owner.close() : undefined;
    if (close) void close.then(() => { closeFinished = true; });
    if (ending !== 'close') await observed;
    assert.equal(signal.aborted, true); assert.equal(owner.pending, 1); assert.equal(closeFinished, false);
    gate.resolve('late'); await observed; await (close ?? owner.close()); assert.equal(owner.pending, 0);
  });
}
test('a synchronous callback crossing the shared deadline cannot publish success', async () => {
  const owner = new ReadRequestOwner('system-read-wait', { diagnostics: quiet(), waitMs: 10 });
  let stages = 0;
  await assert.rejects(owner.run(request(), async context => {
    await context.stage(1, () => { stages++; const end = performance.now() + 15; while (performance.now() < end) { /* synthetic CPU hold */ } return 'late'; });
    await context.stage(2, () => { stages++; return 'must not start'; });
    return 'must not publish';
  }), ReadRequestError);
  assert.equal(stages, 1); await owner.close();
});
