import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from './turn-queue.js';
import { TurnWorker } from './turn-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

for (const mode of ['queue', 'recovery', 'sync-failure']) test(`one retained ${mode} reconciliation cannot strand the idle slot in its bounded page`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  const keys = ['a', 'b', 'c', 'd', 'e'], recovery = new Set(keys), seen: string[] = [];
  if (mode !== 'recovery') for (const key of keys) queue.enqueue('test', { id: key, sessionKey: key, createdAt: 1, payload: {} });
  let release!: () => void, active = 0, maximum = 0, drained = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', pageSize: 4, retryMs: 60_000,
    diagnostics: new PerformanceDiagnostics(() => {}),
    ...(mode === 'recovery' ? { additionalSessionPage: (after: string, limit: number) => [...recovery].filter(key => key > after).sort().slice(0, limit) } : {}),
    reconcile: key => {
      seen.push(key);
      if (mode === 'sync-failure' && key === 'b') throw Error('private failure');
      active++; maximum = Math.max(maximum, active);
      return (async () => {
        try { if (key === 'a') await held; }
        finally { active--; recovery.delete(key); if (mode !== 'recovery') queue.complete('test', key); }
      })();
    },
  });
  try {
    worker.start(); t.mock.timers.tick(0); await flush();
    assert.deepEqual(seen, ['a', 'b', 'c', 'd']); assert.equal(maximum, 2); assert.equal(active, 1);
    for (let i = 0; i < 50; i++) worker.wake();
    t.mock.timers.tick(120_000); await flush();
    assert.deepEqual(seen, ['a', 'b', 'c', 'd'], 'no new pass or retry while the original remains pending');
    const pause = worker.pause(); void pause.drained.then(() => { drained = true; });
    assert.equal(pause.resume(), false); assert.equal(drained, false);
    release(); await pause.drained; assert.equal(drained, true); assert.equal(active, 0);
    assert.equal(pause.resume(), true); t.mock.timers.tick(0); await flush();
    assert.ok(seen.includes('e'), 'next bounded page starts only after original settlement');
    assert.equal(seen.filter(key => key === 'a').length, 1);
  } finally { release(); await worker.close(); db.close(); }
});

test('two retained original reconciliations keep the two-slot bound and close waits for both', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db), seen: string[] = [];
  for (const key of ['a', 'b', 'c', 'd']) queue.enqueue('test', { id: key, sessionKey: key, createdAt: 1, payload: {} });
  let releaseA!: () => void, releaseB!: () => void, closed = false;
  const a = new Promise<void>(resolve => { releaseA = resolve; }), b = new Promise<void>(resolve => { releaseB = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', reconcile: async key => {
    seen.push(key); await (key === 'a' ? a : b); queue.complete('test', key);
  }, diagnostics: new PerformanceDiagnostics(() => {}) });
  try {
    worker.start(); t.mock.timers.tick(0); await flush(); assert.deepEqual(seen, ['a', 'b']);
    const closing = worker.close().then(() => { closed = true; });
    releaseA(); await flush(); assert.equal(closed, false); assert.deepEqual(seen, ['a', 'b']);
    releaseB(); await closing; assert.equal(closed, true);
    assert.equal(queue.head('test', 'c')?.state, 'queued'); assert.equal(queue.head('test', 'd')?.state, 'queued');
  } finally { releaseA(); releaseB(); await worker.close(); db.close(); }
});

test('pause requested by a completing slot fences unstarted entries until the retained slot settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db), seen: string[] = [];
  for (const key of ['a', 'b', 'c']) queue.enqueue('test', { id: key, sessionKey: key, createdAt: 1, payload: {} });
  let release!: () => void, pause: ReturnType<TurnWorker['pause']> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new TurnWorker({ queue, runtime: 'test', reconcile: async key => {
    seen.push(key); if (key === 'a') await held;
    if (key === 'b') pause = worker.pause();
    queue.complete('test', key);
  }, diagnostics: new PerformanceDiagnostics(() => {}) });
  try {
    worker.start(); t.mock.timers.tick(0); await flush(); assert.deepEqual(seen, ['a', 'b']);
    assert.ok(pause); assert.equal(pause.resume(), false); assert.equal(queue.head('test', 'c')?.state, 'queued');
    release(); await pause.drained; assert.equal(pause.resume(), true);
    t.mock.timers.tick(0); await flush(); assert.deepEqual(seen, ['a', 'b', 'c']);
  } finally { release(); await worker.close(); db.close(); }
});
