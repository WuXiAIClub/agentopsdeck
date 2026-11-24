import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createIndependentDrain } from './independent-drain.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const quiet = new PerformanceDiagnostics(() => {});

test('failure and pending peers cannot omit original signals or replay close', async () => {
  const failure = Error('private owner');
  let finish!: () => void, calls = 0, settled = false;
  const drain = createIndependentDrain([() => { calls++; throw failure; },
    () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); },
    () => { calls++; }], 'hub-route-drain', quiet);
  const original = drain();
  const observed = original.then(() => { settled = true; }, error => { settled = true; assert.equal(error, failure); });
  assert.equal(calls, 3);
  assert.equal(drain(), original);
  assert.deepEqual(drain.snapshot(), { state: 'draining', pending: 1, failed: 1, drained: 1 });
  await turn(); assert.equal(settled, false);
  finish(); await observed;
  assert.deepEqual(drain.snapshot(), { state: 'failed', pending: 0, failed: 1, drained: 2 });
  assert.equal(drain(), original); assert.equal(calls, 3);
});

test('first input-order failure wins even when a later failure settles first', async () => {
  let reject!: (error: Error) => void;
  const first = Error('first'), second = Error('second');
  const drain = createIndependentDrain([() => new Promise<void>((_resolve, fail) => { reject = fail; }),
    () => { throw second; }], 'hub-route-drain', quiet);
  const expected = assert.rejects(drain(), error => error === first);
  reject(first); await expected;
});

test('native Promise ACK ignores hostile then properties; thenables and nonvoid ACK fail closed', async () => {
  let reads = 0;
  const original = Promise.resolve();
  Object.defineProperty(original, 'then', { get() { reads++; throw Error('must not read'); } });
  await createIndependentDrain([() => original], 'hub-route-drain', quiet)();
  const thenable = Object.defineProperty({}, 'then', { get() { reads++; throw Error('must not read'); } });
  for (const invalid of [thenable, false, null, Promise.resolve('not void')]) {
    const drain = createIndependentDrain([() => invalid as Promise<void>], 'hub-route-drain', quiet);
    await assert.rejects(drain(), /Invalid independent drain acknowledgement/);
    assert.equal(drain.snapshot().state, 'failed');
  }
  assert.equal(reads, 0);
});

test('reentrant owner and diagnostic sink receive original flight without repeating lanes', async () => {
  let calls = 0, reentrant: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => { reentrant = drain(); });
  const drain = createIndependentDrain([() => { calls++; reentrant = drain(); }], 'hub-route-drain', diagnostics);
  const original = drain(); await original;
  assert.equal(reentrant, original); assert.equal(calls, 1);
});

test('pending warning is one numeric observation and never grants release; sink failure retains evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void, calls = 0, clock = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private sink'); }, () => clock);
  const drain = createIndependentDrain([() => { calls++; return new Promise<void>(resolve => { finish = resolve; }); }],
    'browser-owner-drain', diagnostics, 1000);
  const original = drain(); clock = 1000; t.mock.timers.tick(1000);
  assert.equal(drain.snapshot().state, 'draining'); assert.equal(calls, 1);
  clock = 5000; t.mock.timers.tick(4000);
  assert.equal(diagnostics.snapshot().events.length, 1);
  const pending = diagnostics.snapshot().events[0]!;
  assert.equal(pending.step, 1); assert.equal(pending.phase, 'pending'); assert.equal(pending.delivery, 'failed');
  finish(); await original;
  const ended = diagnostics.snapshot().events[1]!;
  assert.equal(ended.sequence, pending.sequence); assert.equal(ended.phase, 'finished');
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private sink/);
});

test('empty owner set drains once and invalid configurations cannot start', async () => {
  const drain = createIndependentDrain([], 'hub-route-drain', quiet);
  await drain(); assert.equal(drain.snapshot().state, 'drained');
  for (const value of [0, 999, Infinity, 86_400_001]) assert.throws(() => createIndependentDrain([], 'hub-route-drain', quiet, value));
  assert.throws(() => createIndependentDrain(Array.from({ length: 33 }, () => () => {}), 'hub-route-drain', quiet));
});

test('nested lifecycle groups signal every original before awaiting even when a peer fails', async () => {
  const failure = Error('content close failed');
  const signals: number[] = [];
  let finish!: () => void;
  const content = createIndependentDrain([
    () => { signals.push(1); throw failure; },
    () => { signals.push(2); return new Promise<void>(resolve => { finish = resolve; }); },
    () => { signals.push(3); },
  ], 'hub-route-drain', quiet);
  const outer = createIndependentDrain([
    () => { signals.push(0); }, content, () => { signals.push(4); },
  ], 'hub-route-drain', quiet);
  const original = outer();
  const observed = assert.rejects(original, error => error === failure);
  assert.deepEqual(signals, [0, 1, 2, 3, 4]);
  assert.equal(outer(), original);
  assert.equal(content.snapshot().pending, 1);
  assert.equal(outer.snapshot().pending, 1);
  finish(); await observed;
  assert.equal(outer.snapshot().state, 'failed');
  assert.deepEqual(signals, [0, 1, 2, 3, 4]);
});
