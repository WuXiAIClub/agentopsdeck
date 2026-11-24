import assert from 'node:assert/strict';
import test from 'node:test';
import { HubExecutionWorker } from './execution-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const page = { examined: 0, acknowledged: 0, nextCursor: null };

for (const synchronous of [true, false]) test(`failed ${synchronous ? 'synchronous' : 'asynchronous'} synchronization close still starts usage close and drains both original lanes`, async () => {
  const revocation = held(), usage = held(), entered = held();
  const failure = Error('private-close-fault');
  let syncCalls = 0, usageCalls = 0, usageCloses = 0, settled = false;
  const worker = new HubExecutionWorker({
    reconcileRevocations: async () => { syncCalls++; await revocation.promise; return page; },
    close: () => { if (synchronous) throw failure; return Promise.reject(failure); },
  }, 60_000, {
    reconcile: async () => { usageCalls++; entered.release(); await usage.promise; return { examined: 0 }; },
    close: async () => { usageCloses++; },
  });
  const polling = worker.poll(); await entered.promise;
  const closing = worker.close();
  const outcome = closing.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await turn();
    assert.equal(usageCloses, 1, 'one failed owner cannot suppress another independent close');
    assert.equal(settled, false, 'close failure is not acknowledgment of original lane settlement');
    assert.equal(worker.close(), closing, 'pending shutdown keeps the same attempt');
    await worker.poll(); assert.equal(syncCalls, 1); assert.equal(usageCalls, 1);
    revocation.release(); await polling; await turn();
    assert.equal(settled, false, 'usage still retains its original callback');
  } finally { revocation.release(); usage.release(); await polling; }
  assert.equal(await outcome, failure);
});

test('an explicit close retries only unacknowledged owners after original lane settlement', async () => {
  const failure = Error('private-retry-fault'); let scans = 0, syncCloses = 0, usageCloses = 0;
  const worker = new HubExecutionWorker({
    reconcileRevocations: async () => { scans++; return page; },
    close: async () => { if (++syncCloses === 1) throw failure; },
  }, 60_000, {
    reconcile: async () => ({ examined: 0 }), close: async () => { usageCloses++; },
  });
  await worker.poll();
  await assert.rejects(worker.close(), error => error === failure);
  const retry = worker.close(); assert.equal(worker.close(), retry); await retry; await worker.close();
  await worker.poll();
  assert.equal(syncCloses, 2); assert.equal(usageCloses, 1); assert.equal(scans, 1);
});

test('rejection with undefined remains a failed close instead of a successful acknowledgment', async () => {
  let closes = 0, rejected = false;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => page,
    close: () => { if (++closes === 1) throw undefined; return Promise.resolve(); },
  });
  await worker.close().then(() => assert.fail('missing close failure'), error => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true); await worker.close(); assert.equal(closes, 2);
});

test('held independent client close is observable but never unlocks a replacement attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retained = held(), rows: any[] = [];
  let scans = 0, syncCloses = 0, usageCloses = 0, ended = false;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => { scans++; return page; },
    close: () => { syncCloses++; return retained.promise; },
  }, 60_000, { reconcile: async () => ({ examined: 0 }), close: async () => { usageCloses++; } },
  new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  await worker.poll();
  const first = worker.close(), closing = first.then(() => { ended = true; });
  await turn(); assert.equal(usageCloses, 1); assert.equal(worker.shutdownSnapshot().state, 'cleaning');
  t.mock.timers.tick(30_000); t.mock.timers.tick(100_000);
  const warning = rows.find(row => row.operation === 'shutdown-cleanup' && row.phase === 'pending');
  assert.equal(warning.pending, 1); assert.equal(warning.step, 0);
  assert.equal(ended, false); assert.equal(worker.close(), first);
  await worker.poll(); assert.equal(scans, 1); assert.equal(syncCloses, 1);
  retained.release(); await closing; await worker.close();
  assert.equal(worker.shutdownSnapshot().state, 'closed');
  const final = rows.find(row => row.operation === 'shutdown-cleanup' && row.phase === 'finished');
  assert.equal(final.sequence, warning.sequence); assert.equal(final.pending, 0);
  assert.equal(final.settled, 4); assert.equal(syncCloses, 1); assert.equal(usageCloses, 1);
});

test('closing before a scheduled or admitted poll starts fences both lanes synchronously', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let scans = 0, usage = 0, syncCloses = 0, usageCloses = 0;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => { scans++; return page; },
    close: async () => { syncCloses++; },
  }, 1000, { reconcile: async () => { usage++; return { examined: 0 }; }, close: async () => { usageCloses++; } },
  new PerformanceDiagnostics(() => {}));
  const queued = worker.poll(), closing = worker.close();
  await Promise.all([queued, closing]); t.mock.timers.tick(100_000); await turn(); await worker.poll();
  assert.equal(scans, 0); assert.equal(usage, 0); assert.equal(syncCloses, 1); assert.equal(usageCloses, 1);
});
