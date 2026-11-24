import assert from 'node:assert/strict';
import test from 'node:test';
import { HubExecutionWorker } from './execution-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const page = { examined: 0, acknowledged: 0, nextCursor: null };
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function held(failed: boolean) {
  let release!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = () => failed ? reject(Error('private SQL token /private/path')) : resolve();
  });
  return { promise, release };
}
type Row = Record<string, unknown>;

for (const failure of ['start','clock','sink'] as const) test(`diagnostic ${failure} failure does not suppress either original worker lane`, async () => {
  const diagnostics = new PerformanceDiagnostics(() => { if (failure === 'sink') throw Error('private sink'); },
    () => { if (failure === 'clock') throw Error('private clock'); return 100; });
  if (failure === 'start') diagnostics.start = () => { throw Error('private start'); };
  let scans = 0, usage = 0;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => { scans++; return page; }, close: async () => {} },
    60_000, { reconcile: async () => { usage++; return { examined: 0 }; }, close: async () => {} }, diagnostics);
  try { await worker.poll(); await flush(); assert.equal(scans, 1); assert.equal(usage, 1); }
  finally { await worker.close(); }
});

for (const failed of [false, true]) test(`retained revocation ${failed ? 'failure' : 'success'} is observed without replacement or drain ACK`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retained = held(failed), rows: Row[] = [];
  let calls = 0, now = 0, ended = false;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => {
    calls++; await retained.promise; return page;
  }, close: async () => {} }, 60_000, undefined,
  new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now));
  const first = worker.poll();
  try {
    await flush(); assert.equal(worker.poll(), first);
    now = 30_000; t.mock.timers.tick(30_000); await flush();
    const pending = rows.filter(row => row.operation === 'hub-revocation-pass' && row.phase === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0]!.pending, 1);
    const closing = worker.close().then(() => { ended = true; });
    await flush(); assert.equal(ended, false);
    now += 120_000; t.mock.timers.tick(120_000); await flush();
    assert.equal(calls, 1); assert.equal(ended, false);
    retained.release(); await first; await closing;
    const finished = rows.filter(row => row.operation === 'hub-revocation-pass' && row.phase === 'finished');
    assert.equal(finished.length, 1); assert.equal(finished[0]!.sequence, pending[0]!.sequence);
    assert.equal(finished[0]!.category, failed ? 'failed' : 'slow');
    assert.equal(finished[0]![failed ? 'deferred' : 'settled'], 1);
    assert.equal(rows.filter(row => row.operation === 'hub-revocation-pass' && row.phase === 'pending').length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private SQL|private\/path|token/);
  } finally { retained.release(); await first; await worker.close(); }
});

for (const failed of [false, true]) test(`retained usage ${failed ? 'failure' : 'success'} is observed while the original revocation lane progresses`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retained = held(failed), rows: Row[] = [];
  let scans = 0, usage = 0, now = 0, ended = false;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => { scans++; return page; }, close: async () => {} },
    60_000, { reconcile: async () => { usage++; await retained.promise; return { examined: 0 }; }, close: async () => {} },
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now));
  try {
    await worker.poll(); await worker.poll(); await worker.poll(); await flush();
    assert.equal(scans, 3); assert.equal(usage, 1);
    now = 30_000; t.mock.timers.tick(30_000); await flush();
    const pending = rows.filter(row => row.operation === 'hub-usage-pass' && row.phase === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0]!.pending, 1);
    const closing = worker.close().then(() => { ended = true; });
    await flush(); assert.equal(ended, false);
    retained.release(); await closing;
    const finished = rows.filter(row => row.operation === 'hub-usage-pass' && row.phase === 'finished');
    assert.equal(finished.length, 1); assert.equal(finished[0]!.sequence, pending[0]!.sequence);
    assert.equal(finished[0]!.category, failed ? 'failed' : 'slow');
    assert.equal(finished[0]![failed ? 'deferred' : 'settled'], 1);
    assert.doesNotMatch(JSON.stringify(rows), /private SQL|private\/path|token/);
  } finally { retained.release(); await worker.close(); }
});

test('diagnostic sink failure cannot settle or replace either retained lane', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retained = held(false); let scans = 0, usage = 0, ended = false, observed = 0;
  const worker = new HubExecutionWorker({ reconcileRevocations: async () => { scans++; await retained.promise; return page; },
    close: async () => {} }, 60_000,
  { reconcile: async () => { usage++; await retained.promise; return { examined: 0 }; }, close: async () => {} },
  new PerformanceDiagnostics(() => { observed++; throw Error('private sink'); }));
  const first = worker.poll();
  try {
    await flush(); t.mock.timers.tick(30_000); await flush();
    assert.equal(observed, 2); assert.equal(worker.poll(), first);
    const closing = worker.close().then(() => { ended = true; });
    await flush(); assert.equal(ended, false); assert.equal(scans, 1); assert.equal(usage, 1);
    retained.release(); await first; await closing;
  } finally { retained.release(); await first; await worker.close(); }
});

test('settled lanes clear observation timers and a stopped scheduled poll starts no lane', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: Row[] = []; let scans = 0, usage = 0;
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const clients = { reconcileRevocations: async () => { scans++; return page; }, close: async () => {} };
  const usageClient = { reconcile: async () => { usage++; return { examined: 0 }; }, close: async () => {} };
  const worker = new HubExecutionWorker(clients, 60_000, usageClient, diagnostics);
  await worker.poll(); await worker.close();
  t.mock.timers.tick(150_000); await flush();
  const lanes = rows.filter(row => ['hub-revocation-pass', 'hub-usage-pass'].includes(String(row.operation)));
  assert.equal(lanes.length, 2); assert.ok(lanes.every(row => row.phase === 'finished'));
  const stopped = new HubExecutionWorker(clients, 60_000, usageClient, diagnostics);
  const pending = stopped.poll(); const closing = stopped.close(); await pending; await closing;
  t.mock.timers.tick(150_000); await flush();
  assert.equal(scans, 1); assert.equal(usage, 1);
  assert.equal(rows.filter(row => ['hub-revocation-pass', 'hub-usage-pass'].includes(String(row.operation))).length, 2);
});
