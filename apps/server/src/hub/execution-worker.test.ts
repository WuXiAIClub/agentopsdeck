import assert from 'node:assert/strict';
import test from 'node:test';
import { HubExecutionWorker } from './execution-worker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function runningServer<T>(work: Promise<T>) {
  // Production has an HTTP listener; keep this synthetic process alive while
  // verifying that the worker's own timer is deliberately unref'ed.
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Synthetic worker deadline')), 1000);
  })]); } finally { clearTimeout(timer); }
}

test('revocation worker starts without browser activity, advances pages, and retries old failures on the next scan', { timeout: 2000 }, async () => {
  const complete = deferred<void>(), calls: number[] = [];
  let closed = 0;
  const worker = new HubExecutionWorker({
    reconcileRevocations: async (after = 0, limit = 32) => {
      assert.equal(limit, 16); calls.push(after);
      if (calls.length === 3) complete.resolve();
      return { examined: after === 0 ? 16 : 0, acknowledged: 0, nextCursor: after === 0 ? 16 : null };
    }, close: async () => { closed++; },
  }, 10);
  try {
    await runningServer(complete.promise);
    assert.deepEqual(calls.slice(0, 3), [0, 16, 0]);
  } finally { await worker.close(); await worker.close(); }
  assert.equal(closed, 1);
});

test('worker single-flight shutdown drains current page and never schedules new work', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let calls = 0, closes = 0;
  const worker = new HubExecutionWorker({
    reconcileRevocations: async () => { calls++; entered.resolve(); await release.promise;
      return { examined: 16, acknowledged: 0, nextCursor: 16 }; },
    close: async () => { closes++; release.resolve(); },
  });
  const first = worker.poll(); assert.equal(worker.poll(), first);
  await entered.promise;
  await Promise.all([worker.close(), worker.close(), first]);
  await worker.poll();
  assert.equal(calls, 1); assert.equal(closes, 1);
});

test('database failure is contained and worker retries instead of permanently stopping', { timeout: 2000 }, async () => {
  const retried = deferred<void>(); let calls = 0;
  const worker = new HubExecutionWorker({
    reconcileRevocations: async (after = 0) => {
      calls++; assert.equal(after, 0);
      if (calls === 1) throw new Error('Synthetic SQLite busy');
      retried.resolve(); return { examined: 0, acknowledged: 0, nextCursor: null };
    }, close: async () => {},
  }, 10);
  try { await runningServer(retried.promise); assert.equal(calls, 2); }
  finally { await worker.close(); }
});

test('held usage does not block later revocations and shutdown drains both lanes', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let scans = 0, probes = 0, closes = 0;
  const worker = new HubExecutionWorker({
    reconcileRevocations: async () => { scans++; return { examined: 0, acknowledged: 0, nextCursor: null }; },
    close: async () => {},
  }, 60_000, {
    reconcile: async () => { probes++; entered.resolve(); await release.promise; return { examined: 16 }; },
    close: async () => { closes++; release.resolve(); },
  });
  try {
    await worker.poll(); await entered.promise;
    await worker.poll(); await worker.poll();
    assert.equal(scans, 3); assert.equal(probes, 1);
  } finally { await worker.close(); }
  await worker.poll(); assert.equal(scans, 3); assert.equal(closes, 1);
});
