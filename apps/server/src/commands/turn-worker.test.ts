import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TurnQueue } from './turn-queue.js';
import { TurnWorker } from './turn-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

async function until(condition: () => boolean) {
  for (let count = 0; count < 200; count++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail('worker did not reach expected state');
}

test('manual wake reports paused, unstarted and closed workers as unavailable', async () => {
  const worker = new TurnWorker({ runtime: 'test', queue: { sessionPage: () => [], onAdmission: () => () => {} },
    reconcile: async () => assert.fail('No work admitted') });
  assert.equal(worker.wake(), false);
  worker.start();
  assert.equal(worker.wake(), true);
  const lease = worker.pause();
  assert.equal(worker.wake(), false);
  await lease.drained;
  assert.equal(lease.resume(), true);
  assert.equal(worker.wake(), true);
  await worker.close();
  assert.equal(worker.wake(), false);
});

test('isolated recovery preserves defaults when optional scheduling and diagnostics are omitted', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  queue.enqueue('test', { id: 'fresh', sessionKey: 'fresh', createdAt: 1, payload: {} });
  const recovery = new Set(['recovery']), seen: string[] = [];
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true,
    additionalSessionPage: (after, limit) => [...recovery].filter(key => key > after).slice(0, limit),
    reconcile: async key => {
      seen.push(key);
      if (key === 'fresh') queue.complete('test', key); else recovery.delete(key);
    } });
  try {
    worker.start();
    await until(() => seen.length === 2);
    assert.deepEqual([...seen].sort(), ['fresh', 'recovery']);
    assert.equal(queue.head('test', 'fresh'), undefined);
    assert.equal(recovery.size, 0);
  } finally { await worker.close(); database.close(); }
});

for (const stage of ['wake', 'pass', 'completion-probe'] as const) {
  test(`worker recovers ${stage} read failure without ad-hoc wake or lost durable work`, async () => {
    const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db), logs: any[] = [];
    queue.enqueue('test', { id: 'original', sessionKey: 'private-session', createdAt: 1, payload: {} });
    let probes = 0, calls = 0, fail = true;
    const page = queue.sessionPage.bind(queue);
    queue.sessionPage = (...args) => {
      probes++;
      if (fail && probes === ({ wake: 1, pass: 2, 'completion-probe': 3 })[stage]) {
        fail = false; throw new Error('private-page-error');
      }
      return page(...args);
    };
    const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 5,
      diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))),
      reconcile: async () => { calls++; queue.complete('test', 'original'); } });
    try {
      assert.doesNotThrow(() => worker.start());
      await until(() => calls === 1 && !(worker as any).inflight && !(worker as any).timer);
      assert.equal(queue.head('test', 'private-session'), undefined);
      assert.equal(calls, 1);
      assert.ok(logs.some(row => row.category === 'failed' && row.deferred === 1));
      assert.doesNotMatch(JSON.stringify(logs), /private-session|private-page-error/);
    } finally { await worker.close(); db.close(); }
  });
}

test('worker synchronous callback failure does not suppress peer and pause drains recovery timer', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db), calls: string[] = [];
  for (const id of ['a', 'b']) queue.enqueue('test', { id, sessionKey: id, createdAt: 1, payload: {} });
  let fail = true;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 50,
    reconcile: key => {
      calls.push(key);
      if (key === 'a' && fail) { fail = false; throw new Error('synthetic synchronous failure'); }
      queue.complete('test', key); return Promise.resolve();
    } });
  worker.start();
  try {
    await until(() => calls.length === 2 && !(worker as any).inflight);
    assert.deepEqual(calls, ['a', 'b']);
    const lease = worker.pause(); await lease.drained;
    assert.equal((worker as any).timer, undefined);
    assert.equal(queue.head('test', 'a')?.id, 'a');
    assert.equal(lease.resume(), true);
    await until(() => calls.length === 3 && !(worker as any).inflight);
    assert.deepEqual(calls, ['a', 'b', 'a']);
    assert.equal((worker as any).timer, undefined);
  } finally { await worker.close(); db.close(); }
});

test('failed reconciliation still visits the remaining bounded page and close ends failed probes', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db), seen: string[] = [];
  for (const id of ['a', 'b', 'c', 'd']) queue.enqueue('test', { id, sessionKey: id, createdAt: 1, payload: {} });
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 4, retryMs: 100,
    reconcile: async key => { seen.push(key); if (key === 'a') throw Error('failed'); queue.complete('test', key); } });
  worker.start();
  try {
    await until(() => seen.length === 4 && !(worker as any).inflight);
    assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
    queue.sessionPage = () => { throw Error('unavailable'); };
    assert.doesNotThrow(() => worker.wake());
    assert.ok((worker as any).timer);
    await worker.close();
    assert.equal((worker as any).timer, undefined);
    worker.wake(); assert.equal((worker as any).timer, undefined);
    assert.equal(queue.head('test', 'a')?.state, 'queued');
  } finally { await worker.close(); db.close(); }
});

test('pause before start retains queued work and stale resumes cannot reopen a newer pause', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  let calls = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', reconcile: async sessionKey => {
    calls++;
    queue.complete('test', sessionKey);
  } });
  try {
    const first = worker.pause();
    assert.equal(worker.pause(), first);
    queue.enqueue('test', { id: 'first', sessionKey: 'first', createdAt: 1, payload: {} });
    worker.start();
    await first.drained;
    await delay(10);
    assert.equal(calls, 0);
    assert.equal(first.resume(), true);
    const second = worker.pause();
    assert.equal(first.resume(), false);
    worker.wake();
    await second.drained;
    await delay(10);
    assert.equal(calls, 0);
    assert.equal(second.resume(), true);
    await until(() => calls === 1);
    const last = worker.pause();
    await last.drained;
    await worker.close();
    assert.equal(last.resume(), false);
    worker.start(); worker.wake();
    assert.equal((worker as any).timer, undefined);
  } finally { await worker.close(); database.close(); }
});

test('pause waits current reconciliation cleanup and leaves unstarted page entries in the original queue', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  for (const sessionKey of ['a', 'b', 'c']) {
    queue.enqueue('test', { id: sessionKey, sessionKey, createdAt: 1, payload: {} });
  }
  let release!: () => void, releaseB!: () => void, releaseCleanup!: () => void, cleanupStarted = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const heldB = new Promise<void>(resolve => { releaseB = resolve; });
  const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const seen: string[] = [];
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 3, reconcile: async sessionKey => {
    seen.push(sessionKey);
    try { if (sessionKey === 'a') await held; if (sessionKey === 'b') await heldB; }
    finally {
      if (sessionKey === 'a') { cleanupStarted = true; await cleanup; }
      queue.complete('test', sessionKey);
    }
  } });
  worker.start();
  try {
    await until(() => seen.length === 2);
    const pause = worker.pause();
    let drained = false;
    void pause.drained.then(() => { drained = true; });
    assert.equal(pause.resume(), false);
    queue.enqueue('test', { id: 'd', sessionKey: 'd', createdAt: 2, payload: {} });
    releaseB();
    release(); await until(() => cleanupStarted);
    assert.equal(drained, false);
    releaseCleanup(); await pause.drained;
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(queue.head('test', 'c')?.state, 'queued');
    assert.equal(queue.head('test', 'd')?.state, 'queued');
    assert.equal((worker as any).timer, undefined);
    assert.equal(pause.resume(), true);
    await until(() => seen.length === 4);
    assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  } finally { release(); releaseB(); releaseCleanup(); await worker.close(); database.close(); }
});

test('worker merges bounded queue/recovery pages with SQLite ordering and no duplicate sessions', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  const recovery = ['a', 'b', '\u{10000}'];
  for (const key of ['a', '\uE000', '😀']) queue.enqueue('test', { id: key, sessionKey: key, createdAt: 1, payload: {} });
  const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 2, reconcile: async () => {},
    additionalSessionPage: (after, limit) => recovery.filter((key) => binary(key, after) > 0).sort(binary).slice(0, limit) });
  try {
    assert.deepEqual(await (worker as any).sessionPage(''), ['a', 'b']);
    assert.deepEqual(await (worker as any).sessionPage('b'), ['\uE000', '\u{10000}']);
    assert.deepEqual(await (worker as any).sessionPage('\u{10000}'), ['😀']);
  } finally { await worker.close(); db.close(); }
});

test('recovery-only work shares the original worker concurrency and leaves no idle timer', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  const recovery = new Set(['a', 'b', 'c', 'd', 'e']);
  const seen: string[] = [];
  let active = 0, maximum = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 3, retryMs: 5,
    additionalSessionPage: (after, limit) => [...recovery].filter((key) => key > after).sort().slice(0, limit),
    reconcile: async (key) => { active++; maximum = Math.max(maximum, active); seen.push(key); await delay(3); recovery.delete(key); active--; } });
  worker.start();
  try {
    await until(() => seen.length === 5 && !(worker as any).inflight);
    assert.equal(maximum, 2);
    assert.equal((worker as any).timer, undefined);
    assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
  } finally { await worker.close(); db.close(); }
});

test('blocked authorization has no retry timer and scoped cancellation wakes the tail', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  for (const id of ['denied', 'tail']) queue.enqueue('test', { id, sessionKey: 's', createdAt: 1, payload: {} });
  let calls = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 5, reconcile: async () => {
    calls++;
    const head = queue.head('test', 's')!;
    if (head.id === 'denied') queue.block('test', head.id);
    else queue.complete('test', head.id);
  } });
  worker.start();
  try {
    await until(() => calls === 1 && !(worker as any).inflight);
    assert.equal((worker as any).timer, undefined);
    await delay(15); assert.equal(calls, 1);
    assert.equal(queue.cancel('test', 's', 'denied'), true);
    await until(() => calls === 2 && !(worker as any).inflight);
    assert.equal((worker as any).timer, undefined);
  } finally { await worker.close(); db.close(); }
});

test('worker is explicit, idle has no timer, new admission wakes without browser reads', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  let reads = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 5, reconcile: async (key) => {
    reads++;
    queue.complete('test', queue.head('test', key)!.id);
  } });
  const enqueue = (id: string, runtime = 'test') => queue.enqueue(runtime, { id, sessionKey: id, payload: {}, createdAt: 1 });
  enqueue('before-start');
  await delay(10); assert.equal(reads, 0);
  worker.start(); worker.start();
  try {
    await until(() => reads === 1 && !(worker as any).inflight);
    assert.equal((worker as any).timer, undefined);
    enqueue('wrong-runtime', 'other'); await delay(10); assert.equal(reads, 1);
    enqueue('new'); await until(() => reads === 2 && !(worker as any).inflight);
    assert.equal((worker as any).timer, undefined);
  } finally { await worker.close(); db.close(); }
});

test('worker bounds concurrency, rotates session pages and waits for work on close', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  for (const id of ['a', 'b', 'c', 'd', 'e']) queue.enqueue('test', { id, sessionKey: id, payload: {}, createdAt: 1 });
  const seen = new Set<string>();
  let active = 0, maximum = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let block = false, blockedStarted = false;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 5, pageSize: 2, reconcile: async (key) => {
    active++; maximum = Math.max(maximum, active); seen.add(key);
    if (block) { blockedStarted = true; await gate; }
    else await delay(3);
    active--;
    if (key === 'a') throw new Error('one unavailable session must not starve the rest');
  } });
  worker.start();
  try {
    await until(() => seen.size === 5);
    assert.equal(maximum, 2);
    block = true;
    await until(() => blockedStarted);
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await delay(10); assert.equal(closed, false);
    release(); await closing;
    assert.equal(active, 0);
    assert.equal((worker as any).timer, undefined);
    assert.equal((queue as any).admissionListeners.size, 0);
  } finally { release(); await worker.close(); db.close(); }
});

test('wake preempts retry and a burst shares one immediate pass', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'one', sessionKey: 's', createdAt: 1, payload: {} });
  let reads = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 60_000, reconcile: async () => {
    if (++reads === 2) queue.complete('test', 'one');
  } });
  worker.start();
  try {
    await until(() => reads === 1 && !(worker as any).inflight);
    const retryTimer = (worker as any).timer;
    worker.wake();
    const immediateTimer = (worker as any).timer;
    assert.notEqual(immediateTimer, retryTimer);
    for (let i = 0; i < 100; i++) worker.wake();
    assert.equal((worker as any).timer, immediateTimer);
    await until(() => reads === 2 && !(worker as any).inflight);
    assert.equal((worker as any).timer, undefined);
  } finally { await worker.close(); db.close(); }
});

test('admission during an active pass schedules one trailing pass without overlap', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'a', sessionKey: 'a', createdAt: 1, payload: {} });
  const seen: string[] = [];
  let release!: () => void, active = 0, maximum = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 1, retryMs: 60_000, reconcile: async (key) => {
    active++; maximum = Math.max(maximum, active); seen.push(key);
    if (key === 'a') await gate;
    queue.complete('test', key); active--;
  } });
  worker.start();
  try {
    await until(() => seen.length === 1);
    queue.enqueue('test', { id: 'b', sessionKey: 'b', createdAt: 1, payload: {} });
    for (let i = 0; i < 100; i++) worker.wake();
    assert.equal((worker as any).timer, undefined);
    release();
    await until(() => seen.length === 2 && !(worker as any).inflight);
    assert.deepEqual(seen, ['a', 'b']); assert.equal(maximum, 1);
    assert.equal((worker as any).timer, undefined);
  } finally { release(); await worker.close(); db.close(); }
});

test('synchronous admission from reconcile cannot create a parallel timer', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'a', sessionKey: 'a', createdAt: 1, payload: {} });
  let release!: () => void, calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 1, retryMs: 60_000, reconcile: async (key) => {
    calls++;
    if (key === 'a') {
      queue.enqueue('test', { id: 'b', sessionKey: 'b', createdAt: 1, payload: {} });
      await gate;
    }
    queue.complete('test', key);
  } });
  worker.start();
  try {
    await until(() => calls === 1);
    assert.equal((worker as any).timer, undefined);
    assert.equal((worker as any).wakePending, true);
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await delay(5); assert.equal(closed, false);
    release(); await closing;
    assert.equal(calls, 1, 'closing drops the pending scheduling hint, not queued work');
    assert.equal(queue.head('test', 'b')?.id, 'b');
    assert.equal((worker as any).timer, undefined);
    assert.equal((worker as any).wakePending, false);
  } finally { release(); await worker.close(); db.close(); }
});

test('completion wake during an empty final probe performs one bounded scan then becomes idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'one', sessionKey: 's', createdAt: 1, payload: {} });
  let probes = 0, calls = 0, release!: () => void;
  const finalProbe = new Promise<void>(resolve => { release = resolve; });
  const page = queue.sessionPage.bind(queue);
  const worker = new TurnWorker({ queue: {
    onAdmission: listener => queue.onAdmission(listener),
    sessionPage: async (...args) => {
      probes++;
      const snapshot = page(...args);
      if (probes === 3) await finalProbe;
      return snapshot;
    },
  }, runtime: 'test', reconcile: async key => { calls++; queue.complete('test', key === 's' ? 'one' : key); } });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    worker.start(); t.mock.timers.tick(1); await flush();
    assert.equal(probes, 3);
    assert.equal(calls, 1);
    assert.ok((worker as any).inflight, 'the final read still owns the pass');
    worker.wake(); release(); await flush();
    assert.equal((worker as any).inflight, undefined);
    assert.ok((worker as any).timer, 'a late completion hint must not be discarded');
    t.mock.timers.tick(1); await flush();
    assert.equal(probes, 4, 'one empty scan consumes the hint without polling');
    assert.equal(calls, 1, 'a scheduling hint cannot replay a completed command');
    assert.equal((worker as any).timer, undefined);
    assert.equal((worker as any).inflight, undefined);
    t.mock.timers.tick(60_000); await flush();
    assert.equal(probes, 4);
  } finally { release(); await worker.close(); db.close(); }
});

test('cancelling the last queued input drains its read without another reconciliation', async () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'one', sessionKey: 's', createdAt: 1, payload: {} });
  let reads = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 60_000, reconcile: async () => { reads++; } });
  worker.start();
  try {
    await until(() => reads === 1 && !(worker as any).inflight);
    assert.ok((worker as any).timer);
    queue.cancel('test', 's', 'one');
    await until(() => !(worker as any).timer && !(worker as any).inflight);
    assert.equal((worker as any).timer, undefined);
    assert.equal(reads, 1);
  } finally { await worker.close(); db.close(); }
});

test('isolated recovery preserves defaults when optional scheduling and diagnostics are omitted', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  queue.enqueue('test', { id: 'fresh', sessionKey: 'fresh', createdAt: 1, payload: {} });
  const recovery = new Set(['recovery']), seen: string[] = [];
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true,
    additionalSessionPage: (after, limit) => [...recovery].filter(key => key > after).slice(0, limit),
    reconcile: async key => {
      seen.push(key);
      if (key === 'fresh') queue.complete('test', key); else recovery.delete(key);
    } });
  try {
    worker.start(); await until(() => seen.length === 2);
    assert.deepEqual([...seen].sort(), ['fresh', 'recovery']);
    assert.equal(queue.head('test', 'fresh'), undefined);
    assert.equal(recovery.size, 0);
  } finally { await worker.close(); database.close(); }
});

test('isolated recovery retains one slot while new queue admissions use the other slot', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  const recovery = new Set(['a', 'b']);
  const seen: string[] = [];
  let release!: () => void, active = 0, maximum = 0, recoveryActive = 0, recoveryMaximum = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true, retryMs: 5,
    additionalSessionPage: (after, limit) => [...recovery].filter(key => key > after).sort().slice(0, limit),
    reconcile: async key => {
      active++; maximum = Math.max(maximum, active); seen.push(key);
      try {
        if (recovery.has(key)) {
          recoveryActive++; recoveryMaximum = Math.max(recoveryMaximum, recoveryActive);
          try { await held; recovery.delete(key); } finally { recoveryActive--; }
        } else queue.complete('test', key);
      } finally { active--; }
    } });
  worker.start();
  try {
    await until(() => seen.includes('a'));
    queue.enqueue('test', { id: 'fresh', sessionKey: 'fresh', createdAt: 1, payload: {} });
    await until(() => queue.head('test', 'fresh') === undefined);
    assert.deepEqual(seen, ['a', 'fresh']);
    assert.equal(active, 1);
    assert.equal(maximum, 2);
    assert.equal(recoveryMaximum, 1);
    release();
    await until(() => recovery.size === 0 && active === 0);
    assert.deepEqual(seen, ['a', 'fresh', 'b']);
  } finally { release(); await worker.close(); database.close(); }
});

test('isolated lanes never reconcile the same session concurrently', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  queue.enqueue('test', { id: 'same', sessionKey: 'same', createdAt: 1, payload: {} });
  const recovery = new Set(['same']);
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true, retryMs: 5,
    additionalSessionPage: (after, limit) => [...recovery].filter(key => key > after).slice(0, limit),
    reconcile: async key => { calls++; await held; queue.complete('test', key); recovery.delete(key); } });
  worker.start();
  try {
    await until(() => calls > 0);
    await delay(20);
    assert.equal(calls, 1);
    release();
    await until(() => queue.head('test', 'same') === undefined);
    await worker.close();
    assert.equal(calls, 1);
  } finally { release(); await worker.close(); database.close(); }
});

test('isolated recovery pause drains both real lifetimes and preserves later admissions', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  const recovery = new Set(['recovery']);
  let releaseQueue!: () => void, releaseRecovery!: () => void;
  const heldQueue = new Promise<void>(resolve => { releaseQueue = resolve; });
  const heldRecovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
  const seen: string[] = [];
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true, retryMs: 5,
    additionalSessionPage: (after, limit) => [...recovery].filter(key => key > after).slice(0, limit),
    reconcile: async key => {
      seen.push(key);
      if (key === 'recovery') { await heldRecovery; recovery.delete(key); }
      else { await heldQueue; queue.complete('test', key); }
    } });
  queue.enqueue('test', { id: 'first', sessionKey: 'first', createdAt: 1, payload: {} });
  worker.start();
  try {
    await until(() => seen.length === 2);
    const lease = worker.pause();
    assert.equal(worker.pause(), lease);
    let drained = false;
    void lease.drained.then(() => { drained = true; });
    assert.equal(lease.resume(), false);
    queue.enqueue('test', { id: 'later', sessionKey: 'later', createdAt: 2, payload: {} });
    releaseQueue(); await delay(15);
    assert.equal(drained, false);
    assert.equal(seen.length, 2);
    releaseRecovery(); await lease.drained;
    assert.equal(queue.head('test', 'later')?.state, 'queued');
    assert.equal(lease.resume(), true);
    await until(() => seen.includes('later'));
    const second = worker.pause();
    assert.equal(lease.resume(), false);
    await second.drained;
    await worker.close();
    assert.equal(second.resume(), false);
  } finally { releaseQueue(); releaseRecovery(); await worker.close(); database.close(); }
});

test('isolated queue makes progress while recovery page storage is retained and close still waits', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  let release!: () => void, recoveryReads = 0;
  const retained = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true, retryMs: 5,
    additionalSessionPage: async () => { recoveryReads++; await retained; return []; },
    reconcile: async key => { queue.complete('test', key); } });
  worker.start();
  try {
    await until(() => recoveryReads > 0);
    queue.enqueue('test', { id: 'fresh', sessionKey: 'fresh', createdAt: 1, payload: {} });
    await until(() => queue.head('test', 'fresh') === undefined);
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await delay(15); assert.equal(closed, false);
    release(); await closing;
    assert.equal(closed, true);
    assert.equal(recoveryReads, 1);
  } finally { release(); await worker.close(); database.close(); }
});

test('isolated recovery storage failures retain bounded retries without blocking queue admissions', async () => {
  const database = new DatabaseSync(':memory:'), queue = new TurnQueue(database);
  let reads = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', isolateRecovery: true, retryMs: 10,
    additionalSessionPage: () => { reads++; throw Error('private storage detail'); },
    reconcile: async key => { queue.complete('test', key); } });
  worker.start();
  try {
    await until(() => reads >= 2);
    queue.enqueue('test', { id: 'fresh', sessionKey: 'fresh', createdAt: 1, payload: {} });
    await until(() => queue.head('test', 'fresh') === undefined);
    const lease = worker.pause();
    await lease.drained;
    const pausedReads = reads;
    await delay(30);
    assert.equal(reads, pausedReads);
    assert.equal(lease.resume(), true);
    await until(() => reads > pausedReads);
    await worker.close();
    const closedReads = reads;
    worker.wake(); worker.start();
    await delay(30);
    assert.equal(reads, closedReads);
  } finally { await worker.close(); database.close(); }
});
