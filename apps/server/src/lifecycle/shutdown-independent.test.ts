import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createShutdownCleanup } from './shutdown-cleanup.js';

function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('independent cleanup starts every lane and waits for original settlement despite an early failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retained = held(), failure = Error('private-independent-fault');
  const calls = [0, 0, 0], rows: any[] = []; let ended = false;
  const close = createShutdownCleanup(async () => {}, [
    () => { calls[0]!++; return retained.promise; },
    () => { calls[1]!++; throw failure; },
    () => { calls[2]!++; },
  ], new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { independent: true, stallWarningMs: 1000 });
  const first = close(), rejection = first.then(() => assert.fail('missing failure'), error => { ended = true; assert.equal(error, failure); });
  try {
    await turn(); assert.deepEqual(calls, [1, 1, 1]); assert.equal(ended, false);
    assert.equal(close(), first); assert.equal(close.snapshot().state, 'cleaning');
    assert.equal(close.snapshot().step, 0); assert.equal(close.snapshot().settled, 1);
    const immediate = rows.find(row => row.operation === 'shutdown-cleanup' && row.phase === 'pending');
    assert.equal(immediate.unknown, 1, 'peer failure is logged before retained work settles');
    t.mock.timers.tick(1000); t.mock.timers.tick(100_000);
    assert.equal(ended, false); assert.deepEqual(calls, [1, 1, 1]);
    assert.equal(rows.filter(row => row.operation === 'shutdown-cleanup' && row.phase === 'pending').length, 2);
  } finally { retained.release(); await rejection; }
  assert.equal(close.snapshot().state, 'cleanup-required'); assert.equal(close.snapshot().pending, 1);
  const final = rows.find(row => row.operation === 'shutdown-cleanup' && row.phase === 'finished');
  assert.equal(final.unknown, 1); assert.equal(final.settled, 2); assert.equal(final.category, 'failed');
  assert.doesNotMatch(JSON.stringify(rows), /private-independent-fault/);
});

test('independent retry skips acknowledged owners and never repeats a drain', async () => {
  let drains = 0; const calls = [0, 0, 0]; const failure = Error('retained close');
  const close = createShutdownCleanup(async () => { drains++; }, calls.map((_, index) => () => {
    calls[index]!++; if (index === 1 && calls[index] === 1) throw failure;
  }), new PerformanceDiagnostics(() => {}), { independent: true });
  await assert.rejects(close(), error => error === failure);
  const retry = close(); assert.equal(close(), retry); await retry; await close();
  assert.deepEqual(calls, [1, 2, 1]); assert.equal(drains, 1); assert.equal(close.snapshot().state, 'closed');
});

test('independent failures retain input-order error identity, not fastest rejection timing', async () => {
  const gate = held(), original = Error('first owner'), secondary = Error('later owner');
  const close = createShutdownCleanup(async () => {}, [async () => { await gate.promise; throw original; },
    () => { throw secondary; }], new PerformanceDiagnostics(() => {}), { independent: true });
  const rejection = assert.rejects(close(), error => error === original);
  await turn(); gate.release(); await rejection;
  assert.equal(close.snapshot().pending, 2);
});

test('an independent undefined rejection is not acknowledged and can explicitly retry', async () => {
  let calls = 0, rejected = false;
  const close = createShutdownCleanup(async () => {}, [() => { if (++calls === 1) throw undefined; }],
    new PerformanceDiagnostics(() => {}), { independent: true });
  await close().then(() => assert.fail('expected failure'), error => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true); await close(); assert.equal(calls, 2);
});

test('independence cannot be combined with dependent stop-after-failure ordering', () => {
  assert.throws(() => createShutdownCleanup(async () => {}, [], undefined,
    { independent: true, stopAfterFailure: true }), /Independent cleanup/);
});

test('a caller cannot mutate admitted cleanup ordering while the original drain is pending', async () => {
  const gate = held(), order: number[] = [], failure = Error('dependent owner');
  const options = { independent: false, stopAfterFailure: true };
  const close = createShutdownCleanup(() => gate.promise, [() => { order.push(1); throw failure; },
    () => { order.push(2); }], new PerformanceDiagnostics(() => {}), options);
  const rejection = assert.rejects(close(), error => error === failure);
  options.independent = true; options.stopAfterFailure = false;
  gate.release(); await rejection; assert.deepEqual(order, [1]);
});

test('diagnostic sink failure cannot release held independent cleanup or alter its original error', async () => {
  const gate = held(), failure = Error('original error'); let ended = false;
  const close = createShutdownCleanup(async () => {}, [() => { throw failure; }, () => gate.promise],
    new PerformanceDiagnostics(() => { throw Error('sink fault'); }), { independent: true });
  const rejection = close().then(() => assert.fail('expected failure'), error => { ended = true; assert.equal(error, failure); });
  await turn(); assert.equal(ended, false); gate.release(); await rejection;
});
