import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { StartupDatabaseOwners } from '../storage/startup-owner.js';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { StartupApplicationCleanup } from './startup-cleanup.js';
import { createIndependentDrain } from './independent-drain.js';
import { observeBackgroundStartup, reportStartupFailure } from './startup-observation.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const faults = ['start', 'clock', 'sink', 'add', 'reportPending', 'finish'] as const;
function faulty(fault: typeof faults[number]) {
  const fail = () => { throw Error('private diagnostic failure'); };
  const diagnostics = new PerformanceDiagnostics(fault === 'sink' ? fail : () => {},
    fault === 'clock' ? fail : () => 1000);
  const start = diagnostics.start.bind(diagnostics);
  diagnostics.start = operation => {
    if (fault === 'start') return fail();
    const trace = start(operation);
    if (fault === 'add' || fault === 'reportPending' || fault === 'finish') trace[fault] = fail;
    return trace;
  };
  return diagnostics;
}

for (const fault of faults) {
  test(`guarded trace isolates every callback independently: ${fault}`, () => {
    const trace = guardedTrace(faulty(fault), 'storage-startup-cleanup');
    assert.doesNotThrow(() => { trace.add('step', 1); trace.reportPending({ pending: 1 }); trace.finish(true); });
  });

  test(`parallel drain preserves input-order failure and original flight through ${fault}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const first = Error('original first failure'), second = Error('original second failure');
    let reject!: (error: unknown) => void, calls = 0, ended = false;
    const drain = createIndependentDrain([
      () => { calls++; return new Promise<void>((_, fail) => { reject = fail; }); },
      () => { calls++; throw second; }, () => { calls++; },
    ], 'hub-route-drain', faulty(fault), 1000);
    const original = drain();
    const observation = original.then(() => assert.fail('failed drain must not acknowledge'), error => {
      assert.equal(error, first); ended = true;
    });
    assert.equal(calls, 3); assert.equal(drain(), original);
    assert.doesNotThrow(() => t.mock.timers.tick(5000)); await turn();
    assert.equal(ended, false); assert.equal(drain.snapshot().pending, 1);
    reject(first); await observation;
    assert.deepEqual(drain.snapshot(), { state: 'failed', pending: 0, failed: 2, drained: 1 });
    assert.equal(drain(), original); assert.equal(calls, 3);
  });

  for (const failed of [false, true]) test(`startup work outcome survives ${fault}; failed=${failed}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release!: () => void, reject!: (error: unknown) => void, calls = 0, ended = false;
    const diagnostics = faulty(fault);
    const result = observeBackgroundStartup(1, () => {
      calls++; return new Promise<void>((ok, bad) => { release = ok; reject = bad; });
    }, diagnostics, 1000);
    void result.then(() => { ended = true; });
    assert.doesNotThrow(() => reportStartupFailure(2, diagnostics));
    assert.doesNotThrow(() => t.mock.timers.tick(5000)); await turn();
    assert.equal(ended, false); assert.equal(calls, 1);
    if (failed) reject(undefined); else release();
    assert.equal(await result, !failed); assert.equal(calls, 1);
  });

  test(`abandoned startup retries only failed cleanup through ${fault}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release!: () => void, now = 0, drains = 0, closes = 0, broken = true;
    const owners = new StartupApplicationCleanup(faulty(fault), () => now);
    assert.doesNotThrow(() => owners.abandon([
      () => { drains++; return new Promise<void>(ok => { release = ok; }); },
    ], [() => { closes++; if (broken) throw Error('original cleanup'); }]));
    assert.doesNotThrow(() => t.mock.timers.tick(60_000)); await turn();
    assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
    assert.equal(drains, 1); assert.equal(closes, 0);
    release(); await assert.rejects(owners.waitForCurrentCleanup(), StorageConnectionUnavailable);
    assert.equal(closes, 1);
    broken = false; now = 1000;
    assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
    await owners.waitForCurrentCleanup(); owners.assertAvailable();
    assert.equal(drains, 1); assert.equal(closes, 2);
  });

  test(`abandoned startup never replays a failed drain through ${fault}`, async () => {
    let drains = 0, closes = 0, now = 0;
    const owners = new StartupApplicationCleanup(faulty(fault), () => now);
    owners.abandon([() => { drains++; throw undefined; }], [() => { closes++; }]);
    await assert.rejects(owners.waitForCurrentCleanup(), StorageConnectionUnavailable);
    now = 10_000;
    assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
    await assert.rejects(owners.closeRetainedOwners(), StorageConnectionUnavailable);
    assert.equal(drains, 1); assert.equal(closes, 0); assert.equal(owners.snapshot().pending, 1);
  });

  test(`database startup retains exact close-only owner and cooldown through ${fault}`, () => {
    let now = 0, calls = 0, broken = true;
    const owners = new StartupDatabaseOwners(faulty(fault), () => now);
    const db = owners.open(':memory:'), cached = db.prepare('SELECT 1');
    const native = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () {
      calls++; if (broken) throw Error('original native cleanup'); return native.call(this);
    };
    try {
      db.exec('BEGIN');
      assert.doesNotThrow(() => owners.abandon(db)); assert.equal(calls, 1);
      assert.throws(() => cached.get(), StorageConnectionUnavailable);
      now = NaN; assert.doesNotThrow(() => owners.abandon(db));
      assert.equal(calls, 1); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      broken = false; now = 999; owners.abandon(db); assert.equal(calls, 1);
      now = 1000; owners.abandon(db); assert.equal(calls, 2);
      assert.equal(connectionRecoverySnapshot(db).state, 'closed');
      owners.abandon(db); assert.equal(calls, 2);
    } finally { broken = false; DatabaseSync.prototype.close = native; db.close(); }
  });
}
