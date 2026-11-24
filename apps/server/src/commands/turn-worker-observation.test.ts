import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue } from './turn-queue.js';
import { TurnWorker } from './turn-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

for (const failure of [false, true]) test(`held reconciliation ${failure ? 'failure' : 'success'} warns without ending the original drain`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'original', sessionKey: 'private-session-token', createdAt: 1, payload: {} });
  const rows: Record<string, unknown>[] = [];
  let release!: () => void, calls = 0, now = 0;
  const held = new Promise<void>((resolve, reject) => {
    release = () => failure ? reject(Error('private-path credential native-output')) : resolve();
  });
  const worker = new TurnWorker({ queue, runtime: 'test', stallWarningMs: 1000,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now),
    reconcile: async () => { calls++; await held; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    assert.equal(calls, 1);
    const pause = worker.pause();
    let drained = false, closed = false;
    void pause.drained.then(() => { drained = true; });
    const closing = worker.close().then(() => { closed = true; });
    assert.equal(pause.resume(), false);
    now = 1000; t.mock.timers.tick(1000); await flush();
    const observations = () => rows.filter(row => row.operation === 'turn-worker-pass');
    assert.equal(observations().length, 1);
    assert.equal(observations()[0]!.phase, 'pending');
    assert.equal(observations()[0]!.pending, 1);
    assert.equal(observations()[0]!.category, 'failed');
    assert.equal(observations()[0]!.elapsedMs, 1000);
    worker.wake(); t.mock.timers.tick(100_000); await flush();
    assert.equal(observations().length, 1, 'one bounded warning for the retained pass');
    assert.equal(calls, 1); assert.equal(drained, false); assert.equal(closed, false);
    assert.equal(pause.resume(), false);
    assert.equal(queue.sessionPage('test', '', 10).length, 1, 'warning cannot remove durable work');
    release(); await closing; await pause.drained;
    assert.equal(closed, true); assert.equal(drained, true); assert.equal(calls, 1);
    assert.equal(observations().length, 2);
    const [pending, finished] = observations();
    assert.equal(finished!.phase, 'finished');
    assert.equal(finished!.instance, pending!.instance); assert.equal(finished!.sequence, pending!.sequence);
    assert.equal(finished!.pending, undefined, 'observation snapshot cannot alter final counters');
    assert.equal(finished!.deferred, failure ? 1 : undefined);
    assert.equal(pause.resume(), false, 'closed worker cannot reopen');
    assert.doesNotMatch(JSON.stringify(rows), /private-session|private-path|credential|native-output/);
    const count = rows.length; t.mock.timers.tick(100_000); await flush(); assert.equal(rows.length, count);
  } finally { release(); await worker.close(); db.close(); }
});

test('a completed pass cancels its pending warning and preserves the next original retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'original', sessionKey: 'session', createdAt: 1, payload: {} });
  const rows: Record<string, unknown>[] = []; let calls = 0;
  const worker = new TurnWorker({ queue, runtime: 'test', retryMs: 60_000, stallWarningMs: 1000,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    reconcile: async () => { calls++; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    await (worker as any).inflight;
    assert.equal(calls, 1);
    const count = rows.length; t.mock.timers.tick(1000); await flush();
    assert.equal(rows.length, count); assert.equal(rows.filter(row => row.phase === 'pending').length, 0);
    assert.equal(calls, 1, 'warning interval is not a reconciliation retry interval');
    t.mock.timers.tick(59_000); await flush(); assert.equal(calls, 2);
  } finally { await worker.close(); db.close(); }
});

test('wake bursts and an observation cannot overlap a live pass; only its real settlement permits the next pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'original', sessionKey: 'session', createdAt: 1, payload: {} });
  const rows: Record<string, unknown>[] = [];
  let release!: () => void, calls = 0, active = 0, maximum = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', stallWarningMs: 1000,
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    reconcile: async () => {
      calls++; active++; maximum = Math.max(maximum, active);
      try {
        if (calls === 1) await held;
        else queue.complete('test', 'original');
      } finally { active--; }
    } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    for (let count = 0; count < 100; count++) worker.wake();
    t.mock.timers.tick(1000); await flush();
    t.mock.timers.tick(100_000); await flush();
    assert.equal(calls, 1); assert.equal(active, 1); assert.equal(maximum, 1);
    assert.equal(rows.filter(row => row.operation === 'turn-worker-pass' && row.phase === 'pending').length, 1);
    release(); await (worker as any).inflight; t.mock.timers.tick(0);
    await (worker as any).inflight;
    assert.equal(calls, 2); assert.equal(active, 0); assert.equal(maximum, 1);
    assert.equal(queue.sessionPage('test', '', 10).length, 0);
    const passes = rows.filter(row => row.operation === 'turn-worker-pass');
    assert.equal(passes.length, 3);
    assert.equal(passes[0]!.sequence, passes[1]!.sequence);
    assert.notEqual(passes[1]!.sequence, passes[2]!.sequence);
    const size = rows.length; t.mock.timers.tick(100_000); await flush(); assert.equal(rows.length, size);
  } finally { release(); await worker.close(); db.close(); }
});

test('the default warning observes at 30 seconds, not as a work deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'original', sessionKey: 'session', createdAt: 1, payload: {} });
  const rows: Record<string, unknown>[] = []; let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test',
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    reconcile: async () => { calls++; await held; } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    t.mock.timers.tick(29_999); await flush(); assert.equal(rows.filter(row => row.phase === 'pending').length, 0);
    t.mock.timers.tick(1); await flush(); assert.equal(rows.filter(row => row.phase === 'pending').length, 1);
    assert.equal(calls, 1); assert.equal(queue.sessionPage('test', '', 10).length, 1);
  } finally { release(); await worker.close(); db.close(); }
});

test('a throwing observation sink cannot settle, retry or fail the original reconciliation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  queue.enqueue('test', { id: 'original', sessionKey: 'session', createdAt: 1, payload: {} });
  let release!: () => void, calls = 0, observations = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', stallWarningMs: 1000,
    diagnostics: new PerformanceDiagnostics(() => { observations++; throw Error('private sink'); }),
    reconcile: async () => { calls++; await held; queue.complete('test', 'original'); } });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    const before = observations; assert.doesNotThrow(() => t.mock.timers.tick(1000)); await flush();
    assert.equal(observations, before + 1); assert.equal(calls, 1);
    const pause = worker.pause(); assert.equal(pause.resume(), false);
    release(); await pause.drained;
    assert.equal(queue.sessionPage('test', '', 10).length, 0); assert.equal(calls, 1);
  } finally { release(); await worker.close(); db.close(); }
});

test('observation interval rejects invalid configuration without acquiring queue authority', () => {
  for (const stallWarningMs of [NaN, Infinity, -1, 0, 999, 1000.5, 86_400_001]) {
    assert.throws(() => new TurnWorker({ queue: {} as TurnQueue, runtime: 'test', stallWarningMs,
      reconcile: async () => {} }), /Invalid turn worker observation interval/);
  }
  for (const stallWarningMs of [1000, 30_000, 86_400_000]) {
    assert.doesNotThrow(() => new TurnWorker({ queue: {} as TurnQueue, runtime: 'test', stallWarningMs,
      reconcile: async () => {} }));
  }
});
