import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createShutdownCleanup } from './shutdown-cleanup.js';

type ObservationFault = 'start' | 'clock' | 'sink' | 'add' | 'reportPending' | 'finish';
function faultyDiagnostics(fault: ObservationFault) {
  const diagnostics = new PerformanceDiagnostics(() => {
    if (fault === 'sink') throw Error('private diagnostic sink');
  }, () => {
    if (fault === 'clock') throw Error('private diagnostic clock');
    return performance.now();
  });
  const original = diagnostics.start.bind(diagnostics);
  diagnostics.start = operation => {
    if (fault === 'start') throw Error('private diagnostic start');
    const trace = original(operation);
    if (fault === 'add' || fault === 'reportPending' || fault === 'finish') {
      trace[fault] = () => { throw Error('private diagnostic trace'); };
    }
    return trace;
  };
  return diagnostics;
}

for (const fault of ['start', 'clock', 'sink', 'add', 'reportPending', 'finish'] as const) {
  test(`${fault} observation failure preserves held drain and exact cleanup acknowledgements`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let drainAck!: () => void, cleanupAck!: () => void, drains = 0;
    const calls = [0, 0];
    const drain = new Promise<void>(resolve => { drainAck = resolve; });
    const cleanup = new Promise<void>(resolve => { cleanupAck = resolve; });
    const close = createShutdownCleanup(() => { drains++; return drain; }, [() => { calls[0]!++; },
      () => { calls[1]!++; return cleanup; }], faultyDiagnostics(fault), { stallWarningMs: 1000 });
    let ended = false;
    const first = close(), completion = first.then(() => { ended = true; });
    try {
      assert.equal(drains, 1); assert.equal(close(), first);
      t.mock.timers.tick(1000);
      assert.deepEqual(calls, [0, 0]); assert.equal(close.snapshot().state, 'draining');
      drainAck(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(calls, [1, 1]); assert.equal(close.snapshot().state, 'cleaning');
      assert.equal(close.snapshot().settled, 1); assert.equal(close.snapshot().step, 2);
      t.mock.timers.tick(1000); assert.equal(close(), first); assert.equal(ended, false);
    } finally { drainAck(); cleanupAck(); await completion; }
    await close(); assert.deepEqual(calls, [1, 1]); assert.equal(drains, 1);
    assert.equal(close.snapshot().state, 'closed'); assert.equal(close.snapshot().pending, 0);
  });

  test(`${fault} observation failure cannot replace or replay a failed drain`, async () => {
    const original = Error('original drain'); let drains = 0, cleanup = 0;
    const close = createShutdownCleanup(async () => { drains++; throw original; }, [() => { cleanup++; }], faultyDiagnostics(fault));
    await assert.rejects(close(), error => error === original);
    await assert.rejects(close(), error => error === original);
    assert.equal(drains, 1); assert.equal(cleanup, 0);
    assert.equal(close.snapshot().state, 'drain-failed'); assert.equal(close.snapshot().active, false);
  });

  for (const independent of [false, true]) test(`${fault} diagnostics preserve ${independent ? 'independent' : 'ordered'} failed cleanup identity and retry`, async () => {
    const original = Error('original cleanup'); const calls = [0, 0, 0]; let drains = 0;
    const close = createShutdownCleanup(async () => { drains++; }, calls.map((_, index) => () => {
      calls[index]!++; if (index === 1 && calls[index] === 1) throw original;
    }), faultyDiagnostics(fault), { independent, stopAfterFailure: !independent });
    await assert.rejects(close(), error => error === original);
    assert.deepEqual(calls, independent ? [1, 1, 1] : [1, 1, 0]);
    assert.equal(close.snapshot().state, 'cleanup-required');
    const retry = close(); assert.equal(close(), retry); await retry; await close();
    assert.deepEqual(calls, [1, 2, 1]); assert.equal(drains, 1);
    assert.equal(close.snapshot().state, 'closed'); assert.equal(close.snapshot().attempts, 2);
  });
}

test('shutdown fences admission synchronously, coalesces and waits for actual drain ACK', async () => {
  let release!: () => void, drains = 0, closes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const close = createShutdownCleanup(() => { drains++; return held; }, [() => { closes++; }]);
  const first = close();
  assert.equal(drains, 1);
  assert.equal(close(), first);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closes, 0, 'pending drain cannot be converted into cleanup authority');
  release(); await first; await close();
  assert.equal(drains, 1); assert.equal(closes, 1);
});

for (const synchronous of [true, false]) test(`failed ${synchronous ? 'synchronous' : 'async'} drain is never replayed or mistaken for quiescence`, async () => {
  const original = Error('private-drain-fault'); let drains = 0, closes = 0;
  const logs: any[] = [];
  const close = createShutdownCleanup(() => {
    drains++;
    if (synchronous) throw original;
    return Promise.reject(original);
  }, [() => { closes++; }], new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  await assert.rejects(close(), error => error === original);
  await assert.rejects(close(), error => error === original);
  assert.equal(drains, 1); assert.equal(closes, 0);
  assert.equal(logs.length, 1); assert.equal(logs[0].unknown, 1);
  assert.doesNotMatch(JSON.stringify(logs), /private-drain-fault/);
});

test('failed cleanup attempts every retained owner, retries only unresolved steps and preserves original error', async () => {
  const original = Error('private-owner-fault'), secondary = Error('private-secondary-fault');
  const logs: any[] = [], calls = [0, 0, 0]; let drains = 0;
  const close = createShutdownCleanup(async () => { drains++; }, calls.map((_, index) => () => {
    calls[index] = calls[index]! + 1;
    if (calls[index] === 1 && index !== 1) throw index === 0 ? original : secondary;
  }), new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  await assert.rejects(close(), error => error === original);
  assert.deepEqual(calls, [1, 1, 1]);
  const retry = close(); assert.equal(close(), retry); await retry; await close();
  assert.deepEqual(calls, [2, 1, 2]); assert.equal(drains, 1);
  const attempts = logs.filter(row => row.operation === 'shutdown-cleanup');
  assert.equal(attempts[0].pending, 2); assert.equal(attempts[0].category, 'failed');
  assert.equal(attempts[1].recovered, 2); assert.equal(attempts[1].pending, 0);
  assert.doesNotMatch(JSON.stringify(logs), /private|owner-fault|secondary/);
});

test('undefined thrown by cleanup remains a rejection and never becomes a successful ACK', async () => {
  let calls = 0;
  const close = createShutdownCleanup(async () => {}, [() => { calls++; if (calls === 1) throw undefined; }]);
  let rejected = false;
  await close().then(() => { throw Error('Expected rejection'); }, error => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true); await close(); assert.equal(calls, 2);
});

test('an unresolved cleanup keeps the shared attempt pending without callback replay', async () => {
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const close = createShutdownCleanup(async () => {}, [() => { calls++; return held; }]);
  const first = close(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(close(), first); assert.equal(calls, 1);
  release(); await first; await close(); assert.equal(calls, 1);
});

test('diagnostic sink failure does not change cleanup authority or original errors', async () => {
  let calls = 0; const original = Error('private-close-fault');
  const close = createShutdownCleanup(async () => {}, [() => { if (++calls === 1) throw original; }],
    new PerformanceDiagnostics(() => { throw Error('private-log-fault'); }));
  await assert.rejects(close(), error => error === original); await close();
  assert.equal(calls, 2);
});

test('cleanup callbacks are captured once and cannot be replaced by later array mutation', async () => {
  let original = 0, replacement = 0;
  const owners = [() => { original++; }];
  const close = createShutdownCleanup(async () => {}, owners);
  owners[0] = () => { replacement++; };
  await close(); assert.equal(original, 1); assert.equal(replacement, 0);
});

test('synchronous drain reentrancy observes the same shutdown attempt', async () => {
  let nested: Promise<void> | undefined, drains = 0;
  const close = createShutdownCleanup(() => { drains++; nested = close(); return Promise.resolve(); }, []);
  const first = close(); assert.equal(nested, first); await first; assert.equal(drains, 1);
});

test('stalled drain reports pending with the original trace but never grants cleanup authority', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = []; let release!: () => void, drains = 0, closes = 0, now = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const close = createShutdownCleanup(() => { drains++; return held; }, [() => { closes++; }],
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now), { stallWarningMs: 1000 });
  assert.equal(close.snapshot().state, 'open');
  const first = close(); const before = close.snapshot();
  assert.equal(before.state, 'draining'); assert.equal(before.active, true); assert.equal(before.pending, 1);
  assert.equal(Object.isFrozen(before), true);
  now = 1000; t.mock.timers.tick(1000);
  assert.equal(rows.length, 1); assert.equal(rows[0].operation, 'shutdown-drain'); assert.equal(rows[0].phase, 'pending');
  assert.equal(rows[0].pending, 1); assert.equal(rows[0].elapsedMs, 1000);
  t.mock.timers.tick(100_000); assert.equal(rows.length, 1, 'one bounded warning per drain');
  assert.equal(close(), first); assert.equal(drains, 1); assert.equal(closes, 0);
  assert.equal(close.snapshot().state, 'draining');
  release(); await first;
  assert.equal(rows[1].sequence, rows[0].sequence); assert.equal(rows[1].phase, 'finished');
  assert.equal(close.snapshot().state, 'closed'); assert.equal(close.snapshot().active, false);
  assert.equal(before.state, 'draining', 'old snapshots cannot be mutated by later state changes');
  assert.equal(closes, 1);
});

test('stalled cleanup snapshot identifies its exact step; warning neither retries nor skips it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const rows: any[] = [], calls = [0, 0, 0];
  const close = createShutdownCleanup(async () => {}, [() => { calls[0] = calls[0]! + 1; },
    () => { calls[1] = calls[1]! + 1; return held; }, () => { calls[2] = calls[2]! + 1; }],
  new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { stallWarningMs: 1000 });
  const first = close(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(close.snapshot().state, 'cleaning'); assert.equal(close.snapshot().step, 2);
  assert.equal(close.snapshot().settled, 1); assert.equal(close.snapshot().pending, 2);
  t.mock.timers.tick(1000);
  const warning = rows.find(row => row.phase === 'pending');
  assert.equal(warning.operation, 'shutdown-cleanup'); assert.equal(warning.step, 2);
  assert.equal(warning.pending, 2); assert.equal(warning.settled, 1);
  assert.equal(close(), first); t.mock.timers.tick(100_000);
  assert.deepEqual(calls, [1, 1, 0]); assert.equal(rows.filter(row => row.phase === 'pending').length, 1);
  release(); await first; await close(); assert.deepEqual(calls, [1, 1, 1]);
  assert.equal(close.snapshot().state, 'closed'); assert.equal(close.snapshot().step, 0);
  const completed = rows.find(row => row.phase === 'finished' && row.operation === 'shutdown-cleanup');
  assert.equal(completed.sequence, warning.sequence); assert.equal(completed.pending, 0);
  assert.equal(completed.settled, 3, 'snapshot counters must not inflate completion counters');
});

test('completed or failed shutdown cancels warnings and keeps drain failure fenced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const completed = createShutdownCleanup(async () => {}, [() => {}], diagnostics, { stallWarningMs: 1000 });
  await completed();
  const original = Error('private-drain-error'); let drainCalls = 0, closes = 0;
  const failed = createShutdownCleanup(async () => { drainCalls++; throw original; }, [() => { closes++; }], diagnostics,
    { stallWarningMs: 1000 });
  await assert.rejects(failed(), error => error === original);
  assert.equal(failed.snapshot().state, 'drain-failed'); assert.equal(failed.snapshot().active, false);
  const size = rows.length; t.mock.timers.tick(10_000); assert.equal(rows.length, size);
  await assert.rejects(failed(), error => error === original);
  assert.equal(drainCalls, 1); assert.equal(closes, 0);
  assert.doesNotMatch(JSON.stringify(rows), /private|drain-error/);
});

test('pending warning sink failure does not change drain or exact cleanup retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void, calls = 0; const original = Error('private-close-error');
  const close = createShutdownCleanup(() => new Promise<void>(resolve => { release = resolve; }),
    [() => { if (++calls === 1) throw original; }], new PerformanceDiagnostics(() => { throw Error('private-log-error'); }),
    { stallWarningMs: 1000 });
  const first = close(); t.mock.timers.tick(1000); assert.equal(close.snapshot().state, 'draining');
  release(); await assert.rejects(first, error => error === original);
  assert.equal(close.snapshot().state, 'cleanup-required'); assert.equal(close.snapshot().pending, 1);
  await close(); assert.equal(calls, 2); assert.equal(close.snapshot().state, 'closed');
});

test('invalid shutdown warning configuration is rejected before any owner side effect', () => {
  let calls = 0;
  for (const stallWarningMs of [0, 999, 1000.5, NaN, Infinity, 86_400_001]) {
    assert.throws(() => createShutdownCleanup(async () => { calls++; }, [() => { calls++; }],
      undefined, { stallWarningMs }), /Invalid shutdown observation interval/);
  }
  assert.equal(calls, 0);
});
