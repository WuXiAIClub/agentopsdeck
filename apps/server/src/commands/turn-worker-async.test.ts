import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnWorker, type TurnWorkerQueue } from './turn-worker.js';
import { readRecoveryPage } from './recovery-page.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
for (const [name, value] of [
  ['not-array', {}], ['null', null], ['oversize', ['a', 'b']],
  ['empty-key', ['']], ['non-string', [1]], ['nul', ['a\0b']],
  ['unsorted', ['b', 'a']], ['duplicate', ['a', 'a']],
] as const) test(`invalid async queue page ${name} stays deferred, never empty or dispatched`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0, calls = 0, recoveryReads = 0;
  const logs: Record<string, unknown>[] = [];
  const worker = new TurnWorker({ runtime: 'test', retryMs: 5,
    queue: queue(async () => { reads++; return value as unknown as string[]; }),
    diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))),
    additionalSessionPage: () => { recoveryReads++; return []; },
    reconcile: async () => { calls++; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    assert.equal(reads, 1); assert.equal(calls, 0); assert.equal(recoveryReads, 0);
    assert.ok((worker as any).timer, 'failed read retains a bounded retry');
    assert.ok(logs.some(row => row.operation === 'turn-worker-probe' && row.deferred === 1));
    t.mock.timers.tick(5); await flush(); assert.equal(reads, 2); assert.equal(calls, 0);
  } finally { await worker.close(); }
});

test('async queue cursor is fenced before a recovery source or reconciliation starts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const worker = new TurnWorker({ runtime: 'test', queue: queue(async () => ['a']),
    diagnostics: new PerformanceDiagnostics(() => {}), reconcile: async () => { calls++; } });
  try {
    await assert.rejects((worker as any).sessionPage('a'), /Recovery page unavailable/);
    assert.equal(calls, 0);
  } finally { await worker.close(); }
});

for (const failing of ['start', 'add', 'reportPending', 'finish'] as const)
  test(`throwing ${failing} diagnostics cannot strand an original async flight or its drain`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const retained = deferred<void>(); let calls = 0;
    const pending = new Set(['a']);
    const fault = () => { throw Error('synthetic-private-diagnostic'); };
    const trace = { add: () => {}, reportPending: () => {}, finish: () => {}, [failing]: fault };
    const diagnostics = { start: failing === 'start' ? fault : () => trace } as unknown as PerformanceDiagnostics;
    const worker = new TurnWorker({ runtime: 'test', stallWarningMs: 1000, diagnostics,
      queue: queue(async () => [...pending]),
      reconcile: async () => { calls++; await retained.promise; pending.clear(); } });
    try {
      worker.start(); assert.doesNotThrow(() => t.mock.timers.tick(0)); await flush();
      assert.equal(calls, 1);
      assert.doesNotThrow(() => t.mock.timers.tick(1000)); await flush();
      let drained = false;
      const pause = worker.pause(); void pause.drained.then(() => { drained = true; });
      await flush(); assert.equal(drained, false); assert.equal(pause.resume(), false);
      retained.resolve(); await pause.drained;
      assert.equal(drained, true); assert.equal(calls, 1); assert.equal(pending.size, 0);
      assert.equal((worker as any).inflight, undefined);
    } finally { retained.resolve(); await worker.close(); }
  });
function queue(read: TurnWorkerQueue['sessionPage']) {
  const listeners = new Set<(runtime: string) => void>();
  return { sessionPage: read,
    onAdmission(listener: (runtime: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    wake() { for (const listener of listeners) listener('test'); }, listeners };
}

test('async probe retains original pause/close ownership; observation is not an idle acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = deferred<string[]>(), rows: Record<string, unknown>[] = [];
  let reads = 0, reconciliations = 0, recoveryReads = 0;
  const port = queue(() => { reads++; return held.promise; });
  const worker = new TurnWorker({ queue: port, runtime: 'test', stallWarningMs: 1000,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    additionalSessionPage: async () => { recoveryReads++; return ['private-session']; },
    reconcile: async () => { reconciliations++; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush(); assert.equal(reads, 1);
    const pause = worker.pause(); let drained = false, closed = false;
    void pause.drained.then(() => { drained = true; });
    const closing = worker.close().then(() => { closed = true; });
    for (let i = 0; i < 100; i++) port.wake();
    t.mock.timers.tick(60_000); await flush();
    assert.equal(drained, false); assert.equal(closed, false);
    assert.equal(pause.resume(), false); assert.equal(reads, 1);
    assert.equal(rows.filter(row => row.phase === 'pending').length, 1);
    assert.equal(rows.filter(row => row.operation === 'turn-worker-pass' && row.phase === 'finished').length, 0);
    held.resolve(['private-session']); await closing; await pause.drained;
    assert.equal(reconciliations, 0); assert.equal(recoveryReads, 0);
    assert.equal(pause.resume(), false); assert.equal(port.listeners.size, 0);
    assert.doesNotMatch(JSON.stringify(rows), /private-session/);
  } finally { held.resolve([]); await worker.close(); }
});

test('pause during async recovery read preserves queued work until the original read settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recovery = deferred<string[]>(); let reads = 0, calls = 0;
  const port = queue(async () => ['queued']);
  const worker = new TurnWorker({ queue: port, runtime: 'test',
    additionalSessionPage: () => { reads++; return recovery.promise; },
    diagnostics: new PerformanceDiagnostics(() => {}), reconcile: async () => { calls++; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush(); assert.equal(reads, 1);
    const pause = worker.pause(); let drained = false;
    void pause.drained.then(() => { drained = true; });
    await flush(); assert.equal(drained, false); assert.equal(calls, 0);
    recovery.resolve(['recovery']); await pause.drained; assert.equal(calls, 0);
    assert.equal(pause.resume(), true);
    t.mock.timers.tick(0); await flush(); assert.equal(calls, 2);
  } finally { recovery.resolve([]); await worker.close(); }
});

test('async queue and recovery pages retain bounded binary ordering, deduplication and two rolling slots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const durable = new Set(['a', '\uE000', '😀']), recovery = new Set(['a', 'b', '\u{10000}']);
  const limits: number[] = [], seen: string[] = [];
  const held = deferred<void>(); let active = 0, maximum = 0;
  const page = (keys: Set<string>, after: string, limit: number) => [...keys].filter(key => binary(key, after) > 0).sort(binary).slice(0, limit);
  const port = queue(async (_runtime, after, limit) => { limits.push(limit); return page(durable, after, limit); });
  const worker = new TurnWorker({ queue: port, runtime: 'test', pageSize: 4, retryMs: 1,
    additionalSessionPage: async (after, limit) => { limits.push(limit); return page(recovery, after, limit); },
    diagnostics: new PerformanceDiagnostics(() => {}), reconcile: async key => {
      seen.push(key); active++; maximum = Math.max(maximum, active);
      try { if (key === 'a') await held.promise; durable.delete(key); recovery.delete(key); }
      finally { active--; }
    } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    assert.deepEqual(seen, ['a', 'b', '\uE000', '\u{10000}']);
    assert.equal(maximum, 2); assert.equal(active, 1);
    t.mock.timers.tick(60_000); await flush(); assert.equal(seen.length, 4);
    held.resolve(); await flush(); t.mock.timers.tick(1); await flush();
    assert.deepEqual(seen, ['a', 'b', '\uE000', '\u{10000}', '😀']);
    assert.equal((worker as any).timer, undefined); assert.equal((worker as any).inflight, undefined);
    assert.ok(limits.every(limit => limit >= 1 && limit <= 4));
  } finally { held.resolve(); await worker.close(); }
});

test('pause fences later recovery sources without acknowledging a retained original source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = deferred<string[]>(); let reads = 0, calls = 0;
  const worker = new TurnWorker({ queue: queue(async () => ['queued']), runtime: 'test',
    additionalSessionPage: (after, limit, isCurrent) => readRecoveryPage(after, limit,
      [() => original.promise, () => { reads++; return ['later']; }], isCurrent),
    diagnostics: new PerformanceDiagnostics(() => {}), reconcile: async () => { calls++; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    const pause = worker.pause(); let drained = false;
    void pause.drained.then(() => { drained = true; });
    await flush(); assert.equal(drained, false);
    original.resolve(['earlier']); await pause.drained;
    assert.equal(reads, 0); assert.equal(calls, 0);
  } finally { original.resolve([]); await worker.close(); }
});

for (const source of ['queue', 'recovery'] as const) {
  test(`async ${source} read failure retries observation without losing or resending durable work`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const held = deferred<string[]>(), pending = new Set(['private-session']);
    const rows: Record<string, unknown>[] = []; let reads = 0, calls = 0;
    const read = async () => { reads++; return reads === 1 ? held.promise : [...pending]; };
    const port = queue(source === 'queue' ? read : async () => [...pending]);
    const worker = new TurnWorker({ queue: port, runtime: 'test', retryMs: 1000,
      ...(source === 'recovery' ? { additionalSessionPage: read } : {}),
      diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
      reconcile: async key => { calls++; pending.delete(key); } });
    try {
      worker.start(); t.mock.timers.tick(0); await flush(); assert.equal(calls, 0);
      held.reject(Error('private-read-failure')); await flush();
      assert.equal(calls, 0); assert.ok((worker as any).timer);
      t.mock.timers.tick(999); await flush(); assert.equal(calls, 0);
      t.mock.timers.tick(1); await flush(); assert.equal(calls, 1); assert.equal(pending.size, 0);
      assert.equal((worker as any).timer, undefined);
      assert.ok(rows.some(row => row.operation === 'turn-worker-probe' && row.category === 'failed'));
      assert.doesNotMatch(JSON.stringify(rows), /private-session|private-read-failure/);
    } finally { held.resolve([]); await worker.close(); }
  });
}

test('an admission during the final async empty snapshot receives another original scan without overlap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const final = deferred<string[]>(), pending = new Set(['a']);
  const seen: string[] = []; let reads = 0, active = 0, maximum = 0;
  const port = queue(async () => { reads++; return reads === 3 ? final.promise : [...pending]; });
  const worker = new TurnWorker({ queue: port, runtime: 'test', retryMs: 60_000,
    diagnostics: new PerformanceDiagnostics(() => {}), reconcile: async key => {
      active++; maximum = Math.max(maximum, active); seen.push(key); pending.delete(key); active--;
    } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush(); assert.equal(reads, 3);
    assert.deepEqual(seen, ['a']); pending.add('b'); port.wake();
    t.mock.timers.tick(60_000); await flush(); assert.equal(reads, 3);
    final.resolve([]); await flush(); t.mock.timers.tick(0); await flush();
    assert.deepEqual(seen, ['a', 'b']); assert.equal(maximum, 1);
    assert.equal((worker as any).timer, undefined); assert.equal((worker as any).inflight, undefined);
  } finally { final.resolve([]); await worker.close(); }
});

test('close during the bounded async page read prevents new reconciliation and waits real read settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = deferred<string[]>(); let reads = 0, calls = 0;
  const port = queue(async () => ++reads === 1 ? ['queued'] : page.promise);
  const worker = new TurnWorker({ queue: port, runtime: 'test',
    diagnostics: new PerformanceDiagnostics(() => {}), reconcile: async () => { calls++; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush(); assert.equal(reads, 2);
    let closed = false; const closing = worker.close().then(() => { closed = true; });
    await flush(); assert.equal(closed, false); assert.equal(calls, 0);
    page.resolve(['queued']); await closing; assert.equal(calls, 0);
    t.mock.timers.tick(60_000); await flush(); assert.equal(reads, 2);
  } finally { page.resolve([]); await worker.close(); }
});
