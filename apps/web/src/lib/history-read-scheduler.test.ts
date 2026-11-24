import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryReadScheduler } from './history-read-scheduler.js';
import { HistoryPreparing, readPreparedHistory } from './history-preparation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options = (priority = 1) => ({ priority: () => priority, signal: new AbortController().signal });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('same-commit startup is deferred and limited to two automatic reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler();
  const pending = Array.from({ length: 12 }, () => deferred<number>());
  let active = 0, peak = 0;
  const starts: number[] = [];
  const jobs = pending.map((item, i) => queue.schedule(async () => {
    starts.push(i); active++; peak = Math.max(peak, active);
    try { return await item.promise; } finally { active--; }
  }, options()));
  assert.deepEqual(starts, []);
  t.mock.timers.tick(0);
  assert.deepEqual(starts, [0, 1]);
  for (let i = 0; i < 12; i += 2) {
    pending[i]!.resolve(i); pending[i + 1]!.resolve(i + 1);
    await settle(); t.mock.timers.tick(0);
  }
  assert.deepEqual(await Promise.all(jobs.map(job => job.promise)), Array.from({ length: 12 }, (_, i) => i));
  assert.equal(peak, 2);
});

test('dispatch samples current priority and prefers startup to automatic backfill', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(1), starts: string[] = [];
  let foreground = false;
  const backfill = queue.schedule(async () => { starts.push('backfill'); }, options(3));
  const visible = queue.schedule(async () => { starts.push('visible'); }, options(1));
  const selected = queue.schedule(async () => { starts.push('selected'); }, {
    ...options(), priority: () => foreground ? 0 : 5,
  });
  foreground = true;
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(0); await settle(); }
  await Promise.all([backfill.promise, visible.promise, selected.promise]);
  assert.deepEqual(starts, ['selected', 'visible', 'backfill']);
});

test('oldest waiting background work gets a slot despite foreground arrivals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(1), starts: string[] = [];
  const jobs = [queue.schedule(async () => { starts.push('background'); }, options(5))];
  for (let i = 0; i < 9; i++) jobs.push(queue.schedule(async () => { starts.push('foreground'); }, options(0)));
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(0); await settle(); }
  await Promise.all(jobs.map(job => job.promise));
  assert.equal(starts.indexOf('background'), 4);
});

test('queued or already-aborted scope never dispatches after pane disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(), controller = new AbortController();
  let calls = 0;
  const job = queue.schedule(async () => { calls++; }, { ...options(), signal: controller.signal });
  const rejected = assert.rejects(job.promise, { name: 'AbortError' });
  controller.abort(); job.expedite();
  const next = queue.schedule(async () => { calls++; }, { ...options(), signal: controller.signal });
  await assert.rejects(next.promise, { name: 'AbortError' });
  await rejected; t.mock.timers.tick(0);
  assert.equal(calls, 0);
});

test('manual upward intent expedites only its queued page, once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(1), slow = deferred<void>(), starts: string[] = [];
  const running = queue.schedule(() => { starts.push('slow'); return slow.promise; }, options());
  t.mock.timers.tick(0);
  const other = queue.schedule(async () => { starts.push('other'); }, options());
  const user = queue.schedule(async () => { starts.push('user'); }, options(5));
  user.expedite(); user.expedite();
  await user.promise;
  t.mock.timers.tick(0);
  assert.deepEqual(starts, ['slow', 'user']);
  slow.resolve(); await running.promise; t.mock.timers.tick(0); await other.promise;
  assert.deepEqual(starts, ['slow', 'user', 'other']);
});

test('aborting a running scope does not release its slot before the transport settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(1), slow = deferred<void>(), controller = new AbortController();
  const first = queue.schedule(() => slow.promise, { ...options(), signal: controller.signal });
  let started = false;
  const second = queue.schedule(async () => { started = true; }, options());
  t.mock.timers.tick(0); controller.abort(); t.mock.timers.tick(0);
  assert.equal(started, false);
  slow.resolve(); await first.promise; t.mock.timers.tick(0); await second.promise;
  assert.equal(started, true);
});

test('sync throws and failed requests release slots without poisoning the queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(1), error = new Error('unavailable');
  const first = queue.schedule<void>(() => { throw error; }, options());
  const second = queue.schedule(() => Promise.reject(error), options());
  const third = queue.schedule(async () => 42, options());
  const checks = [assert.rejects(first.promise, error), assert.rejects(second.promise, error)];
  t.mock.timers.tick(0); await settle(); t.mock.timers.tick(0);
  await Promise.all(checks);
  assert.equal(await third.promise, 42);
});

test('invalid concurrency cannot create a queue that never drains', () => {
  for (const value of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => createHistoryReadScheduler(value));
});

test('preparation retry delays release slots for other panes and retries reenter the queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createHistoryReadScheduler(1), signal = new AbortController().signal;
  let attempts = 0, otherRead = false;
  const preparing = readPreparedHistory(() => queue.schedule(async () => {
    if (++attempts === 1) throw new HistoryPreparing(1000);
    return 'prepared';
  }, { ...options(), signal }).promise, () => {}, signal);
  t.mock.timers.tick(0); await settle();
  const other = queue.schedule(async () => { otherRead = true; }, options());
  t.mock.timers.tick(0); await other.promise;
  assert.equal(otherRead, true); assert.equal(attempts, 1);
  t.mock.timers.tick(1000); await settle(); t.mock.timers.tick(0);
  assert.equal(await preparing, 'prepared'); assert.equal(attempts, 2);
});
