import assert from 'node:assert/strict';
import test from 'node:test';
import { createFreshRead, createLiveRefresh, createInFlightCoalescer, createLatestRequestGate, createLatestWinsRunner, createMessageSnapshotGate, createQueuedRefresh } from './refresh-control.js';
import { historyRefreshInterval } from './history-refresh-budget.js';
import { retryAfterMilliseconds } from './retry-after.js';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('session list does not poll a healthy stream but refreshes on events and falls back when disconnected', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let connected = true, calls = 0;
  const c = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => connected, fallbackMs: 15_000, eventDelayMs: 100, pollWhileConnected: false });
  t.after(() => c.stop()); c.start(); await settle();
  t.mock.timers.tick(120_000); await settle(); assert.equal(calls, 1);
  c.request(); c.request(); t.mock.timers.tick(100); await settle(); assert.equal(calls, 2);
  c.boost(); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 3);
  connected = false; c.connectionChanged();
  t.mock.timers.tick(15_000); await settle(); assert.equal(calls, 4);
  connected = true; c.connectionChanged(); await settle(); assert.equal(calls, 5);
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 5);
});

test('pursuitWhileConnected allows bounded post-command pursuit ticks even when pollWhileConnected is false', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const c = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => true, fallbackMs: 15_000, eventDelayMs: 100, pollWhileConnected: false, pursuitWhileConnected: true });
  t.after(() => c.stop()); c.start(); await settle();
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 1);
  c.boost(); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1_000); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(60_000); await settle();
  const afterWindow = calls;
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, afterWindow, 'pursuit stops once bounded window expires');
});

test('a failed event-driven list refresh still retries on a connected stream', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const c = createLiveRefresh({ refresh: async () => { if (++calls === 2) throw Error('unavailable'); },
    isVisible: () => true, isConnected: () => true, fallbackMs: 15_000, eventDelayMs: 100, pollWhileConnected: false });
  t.after(() => c.stop()); c.start(); await settle();
  c.request(); t.mock.timers.tick(100); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(999); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 3);
});

test('send acknowledgement bypasses normal debounce and spacing without inventing runtime state', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const calls: number[] = [];
  const c = createLiveRefresh({ refresh: async () => { calls.push(Date.now()); }, isVisible: () => true,
    isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 1_000, minIntervalMs: () => 4_000 });
  t.after(() => c.stop()); c.start(); await settle();
  c.boost(); await settle(); assert.deepEqual(calls, [0, 0]);
  c.request(); t.mock.timers.tick(999); await settle(); assert.equal(calls.length, 2);
});

test('restoring visibility immediately revalidates and coalesces duplicate focus notifications', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let visible = true, calls = 0;
  const c = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => visible,
    isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 750, minIntervalMs: () => 4_000 });
  t.after(() => c.stop()); c.start(); await settle();
  visible = false; c.wake(); t.mock.timers.tick(100); await settle(); assert.equal(calls, 1);
  visible = true; c.wake(); await settle(); assert.equal(calls, 2);
  for (let i = 0; i < 50; i++) c.wake();
  t.mock.timers.tick(249); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(59_749); await settle(); assert.equal(calls, 2, 'wake does not enable pursuit polling');
});

test('resume during an old read guarantees one fresh trailing read, not an old snapshot as acknowledgement', async t => {
  let release!: () => void, calls = 0;
  const c = createLiveRefresh({ refresh: async () => { if (++calls === 1) await new Promise<void>(r => { release = r; }); },
    isVisible: () => true, isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 750, minIntervalMs: () => 4_000 });
  t.after(() => c.stop()); c.start();
  c.wake(); c.wake(); c.prioritize(); assert.equal(calls, 1);
  release(); await settle(); assert.equal(calls, 2);
});

test('resume, send and reconnect priority cannot bypass server backoff', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let connected = false, calls = 0;
  const c = createLiveRefresh({ refresh: async () => { if (++calls === 1) throw { retryAfterMs: 15_000 }; },
    isVisible: () => true, isConnected: () => connected, fallbackMs: 60_000, eventDelayMs: 750 });
  t.after(() => c.stop()); c.start(); await settle();
  c.wake(); c.boost(); connected = true; c.connectionChanged();
  t.mock.timers.tick(14_999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
});

test('only a disconnected-to-connected transition immediately revalidates', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let connected = false, calls = 0;
  const c = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => connected, fallbackMs: 15_000, eventDelayMs: 750, minIntervalMs: () => 4_000 });
  t.after(() => c.stop()); c.start(); await settle();
  connected = true; c.connectionChanged(); await settle(); assert.equal(calls, 2);
  for (let i = 0; i < 50; i++) c.connectionChanged();
  t.mock.timers.tick(1_000); await settle(); assert.equal(calls, 2);
});

test('hidden and stopped surfaces never dispatch prioritized reads', async t => {
  let visible = false, calls = 0;
  const c = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => visible,
    isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 750 });
  c.start(); c.boost(); c.wake(); c.prioritize(); await settle(); assert.equal(calls, 0);
  visible = true; c.stop(); c.boost(); c.wake(); c.prioritize(); await settle(); assert.equal(calls, 0);
});

test('completion bypasses 10s spacing and debounce, ordinary events retain budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const c = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 500, minIntervalMs: () => 10_000 });
  t.after(() => c.stop()); c.start(); await settle();
  c.request(); t.mock.timers.tick(100); await settle(); assert.equal(calls, 1);
  await c.complete(); assert.equal(calls, 2);
  c.request(); t.mock.timers.tick(9_999); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3);
});

test('completion during an old in-flight read waits for a post-event read, coalescing callers', async t => {
  let finish!: () => void, calls = 0;
  const old = new Promise<void>(resolve => { finish = resolve; });
  const c = createLiveRefresh({ refresh: async () => { if (++calls === 1) await old; },
    isVisible: () => true, isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 500, minIntervalMs: () => 10_000 });
  t.after(() => c.stop()); c.start();
  let done = false;
  const completion = Promise.all([c.complete(), c.complete()]).then(() => { done = true; });
  await settle(); assert.equal(calls, 1); assert.equal(done, false);
  finish(); await completion; assert.equal(calls, 2); assert.equal(done, true);
});

test('completion cannot bypass server retry advice and stopping rejects queued confirmation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const c = createLiveRefresh({ refresh: async () => { if (++calls === 1) throw { retryAfterMs: 15_000 }; },
    isVisible: () => true, isConnected: () => true, fallbackMs: 60_000, eventDelayMs: 500 });
  t.after(() => c.stop()); c.start(); await settle();
  const completion = c.complete(); t.mock.timers.tick(14_999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await completion; assert.equal(calls, 2);
});

test('retry advice accepts bounded seconds and HTTP dates, not malformed numeric dates', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(retryAfterMilliseconds('15', now), 15_000);
  assert.equal(retryAfterMilliseconds(' 30 ', now), 30_000);
  assert.equal(retryAfterMilliseconds('999999', now), 60_000);
  assert.equal(retryAfterMilliseconds('Fri, 02 Oct 2026 00:00:25 GMT', now), 25_000);
  for (const value of [null, '', '0', '-1', '1.5', 'NaN', 'Infinity', 'Fri, 02 Oct 2026 00:00:00 GMT']) {
    assert.equal(retryAfterMilliseconds(value, now), undefined);
  }
});

test('server retry advice survives invalidations and resets after a successful read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let calls = 0;
  const controller = createLiveRefresh({ refresh: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('busy'), { retryAfterMs: 15_000 });
    return { changed: false };
  }, isVisible: () => true, isConnected: () => false,
  fallbackMs: unchanged => unchanged ? 30_000 : 15_000, eventDelayMs: 0 });
  t.after(() => controller.stop());
  controller.start(); await settle();
  controller.request(); t.mock.timers.tick(14_999); await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(29_999); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3);
  controller.request(); t.mock.timers.tick(1); await settle(); assert.equal(calls, 4);
});

test('stateful history failures reach active 15s ceiling, idle backoff and server advice take precedence', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let idle = false, hint = 0;
  const calls: number[] = [];
  const controller = createLiveRefresh({ refresh: async () => { calls.push(Date.now()); throw { retryAfterMs: hint }; },
    isVisible: () => true, isConnected: () => false, fallbackMs: n => Math.min(idle ? 60_000 : 15_000, (idle ? 15_000 : 3_000) * 2 ** n), eventDelayMs: 0 });
  t.after(() => controller.stop()); controller.start(); await settle();
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) { t.mock.timers.tick(delay); await settle(); }
  assert.deepEqual(calls, [0, 1000, 3000, 7000, 15000, 30000, 45000]);
  idle = true; t.mock.timers.tick(15000); await settle();
  t.mock.timers.tick(59999); await settle(); assert.equal(calls.at(-1), 60000);
  hint = 60_000; idle = false; t.mock.timers.tick(1); await settle();
  t.mock.timers.tick(59999); await settle(); assert.equal(calls.at(-1), 120000);
  t.mock.timers.tick(1); await settle(); assert.equal(calls.at(-1), 180000);
});

test('safety calibrations align across staggered pane mounts while events and disconnected reads remain ordinary', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let connected = true;
  const calls: { at: number; calibration: boolean | undefined }[][] = [[], []];
  const controllers = calls.map(log => createLiveRefresh({ refresh: async calibration => { log.push({ at: Date.now(), calibration }); },
    isVisible: () => true, isConnected: () => connected, fallbackMs: 10_000, eventDelayMs: 100, alignSafety: true }));
  t.after(() => controllers.forEach(c => c.stop()));
  controllers[0]!.start(); await settle(); t.mock.timers.tick(25_000);
  controllers[1]!.start(); await settle(); t.mock.timers.tick(25_000); await settle();
  assert.deepEqual(calls.map(log => log.at(-1)), [{ at: 60_000, calibration: true }, { at: 60_000, calibration: true }]);
  controllers[0]!.request(); t.mock.timers.tick(100); await settle();
  assert.equal(calls[0]!.at(-1)!.calibration, false);
  connected = false; controllers.forEach(c => c.connectionChanged()); t.mock.timers.tick(10_000); await settle();
  assert.ok(calls.every(log => log.at(-1)!.calibration === false));
});

test('ordinary invalidation wins over a queued calibration and is never downgraded', async () => {
  let release!: () => void;
  const modes: (boolean | undefined)[] = [];
  const refresh = createQueuedRefresh(async calibration => {
    modes.push(calibration);
    if (modes.length === 1) await new Promise<void>(resolve => { release = resolve; });
  });
  const done = refresh.run(true); refresh.run(true); refresh.run(); refresh.run(true);
  release(); await done;
  assert.deepEqual(modes, [true, false]);
});

test('multi-pane event budget preserves a trailing update and gives foreground priority', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let foreground = false, calls = 0;
  const refresh = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 750,
    minIntervalMs: () => historyRefreshInterval(6, foreground) });
  t.after(() => refresh.stop());
  refresh.start(); await settle();
  for (let i = 0; i < 39; i++) { refresh.request(); t.mock.timers.tick(100); await settle(); }
  assert.equal(calls, 1);
  t.mock.timers.tick(100); await settle();
  assert.equal(calls, 2, 'continuous events cannot postpone refresh forever');
  foreground = true;
  refresh.request(); t.mock.timers.tick(1_999); await settle();
  assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls, 3, 'foreground uses its shorter interval without resubscription');
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 4, 'safety calibration remains available');
});

test('six visible sessions with one event-producing run bound history reads without polling the other five faster', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const calls = Array(6).fill(0);
  const controllers = calls.map((_, index) => createLiveRefresh({ refresh: async () => { calls[index]++; },
    isVisible: () => true, isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 750,
    minIntervalMs: () => historyRefreshInterval(6, index === 0) }));
  t.after(() => controllers.forEach(controller => controller.stop()));
  controllers.forEach(controller => controller.start()); await settle();
  for (let tick = 0; tick < 600; tick++) {
    controllers[0]!.request(); t.mock.timers.tick(100); await settle();
  }
  assert.equal(calls[0], 31, 'initial + at most thirty automatic reads/minute in foreground');
  assert.deepEqual(calls.slice(1), [2, 2, 2, 2, 2], 'initial + one safety read/minute for idle peers');
});

test('events arriving during a budgeted in-flight read are caught up once, then unsubscribe cancels trailing work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let complete!: () => void, calls = 0;
  const refresh = createLiveRefresh({ refresh: () => ++calls === 1 ? new Promise<void>(resolve => { complete = resolve; }) : Promise.resolve(),
    isVisible: () => true, isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 750, minIntervalMs: () => 4_000 });
  refresh.start(); refresh.request(); refresh.request(); complete(); await settle();
  t.mock.timers.tick(4_000); await settle();
  assert.equal(calls, 2);
  refresh.request(); refresh.stop(); t.mock.timers.tick(120_000); await settle();
  assert.equal(calls, 2);
});

for (const rejected of [false, true]) test(`failed refresh backs off despite live events and resets after recovery (reject=${rejected})`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let calls = 0, healthy = false;
  const refresh = createLiveRefresh({ refresh: async () => {
    calls++;
    if (!healthy && rejected) throw new Error('503');
    return healthy;
  }, isVisible: () => true, isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 100 });
  t.after(() => refresh.stop());
  refresh.start(); await settle();
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const before = calls;
    for (let i = 0; i < 30; i++) refresh.request();
    t.mock.timers.tick(delay - 1); await settle();
    assert.equal(calls, before);
    t.mock.timers.tick(1); await settle();
    assert.equal(calls, before + 1);
  }
  healthy = true;
  t.mock.timers.tick(30_000); await settle();
  const before = calls;
  refresh.request(); t.mock.timers.tick(100); await settle();
  assert.equal(calls, before + 1);
});

test('healthy live stream uses one safety read per minute and coalesces event/wake bursts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let calls = 0;
  const refresh = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 750 });
  t.after(() => refresh.stop());
  refresh.start(); await settle();
  t.mock.timers.tick(59_999); await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls, 2);
  for (let i = 0; i < 20; i++) { refresh.request(); refresh.wake(); }
  t.mock.timers.tick(750); await settle();
  assert.equal(calls, 3);
  refresh.boost(); t.mock.timers.tick(750); await settle();
  t.mock.timers.tick(10_000); await settle();
  assert.equal(calls, 5, 'post-command pursuit survives a connected but stale event stream');
});

test('connected command pursuit is bounded, bypasses calibration and leaves idle controllers alone', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const reads: { at: number; calibration: boolean }[] = [];
  let idleReads = 0;
  const options = { isVisible: () => true, isConnected: () => true, fallbackMs: 15_000, eventDelayMs: 100, alignSafety: true };
  const active = createLiveRefresh({ ...options, refresh: async calibration => { reads.push({ at: Date.now(), calibration: !!calibration }); } });
  const idle = createLiveRefresh({ ...options, refresh: async () => { idleReads++; } });
  t.after(() => { active.stop(); idle.stop(); });
  active.start(); idle.start(); await settle();
  active.boost();
  for (let i = 0; i < 600; i++) { t.mock.timers.tick(100); await settle(); }
  assert.ok(reads.length >= 20 && reads.length <= 30, `bounded target-only reads: ${reads.length}`);
  assert.equal(idleReads, 2, 'other panes keep minute calibration');
  assert.equal(reads.some(read => read.calibration), false, 'pursuit cannot reuse the minute revision cache');
  t.mock.timers.tick(5_000); await settle();
  const afterWindow = reads.length;
  t.mock.timers.tick(54_999); await settle();
  assert.equal(reads.length, afterWindow);
  t.mock.timers.tick(1); await settle();
  assert.equal(reads.at(-1)?.calibration, true, 'returns to the aligned minute cadence');
});

test('connected active history safety is state-dependent and never minute-cached', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let active = true;
  const reads: boolean[] = [];
  const refresh = createLiveRefresh({ refresh: async calibration => { reads.push(!!calibration); }, isVisible: () => true,
    isConnected: () => true, fallbackMs: 15_000, eventDelayMs: 100, alignSafety: true, safetyMs: () => active ? 5_000 : 60_000 });
  t.after(() => refresh.stop());
  refresh.start(); await settle();
  t.mock.timers.tick(5_000); await settle();
  assert.deepEqual(reads, [false, false]);
  active = false; refresh.connectionChanged();
  t.mock.timers.tick(55_000); await settle();
  assert.deepEqual(reads, [false, false, true]);
});

test('connected pursuit respects Retry-After, pane budget and hidden-page suspension', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let visible = true, calls = 0;
  const refresh = createLiveRefresh({ refresh: async () => { if (++calls === 1) throw { retryAfterMs: 15_000 }; },
    isVisible: () => visible, isConnected: () => true, fallbackMs: 15_000, eventDelayMs: 100, minIntervalMs: () => 2_000 });
  t.after(() => refresh.stop());
  refresh.start(); await settle(); refresh.boost();
  t.mock.timers.tick(14_999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  refresh.boost(); await settle();
  t.mock.timers.tick(249); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3, 'explicit send priority has a bounded 250ms budget');
  visible = false; refresh.wake(); t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 3);
});

test('hidden tabs suspend timers/events and returning catches up exactly once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let visible = true, calls = 0;
  const refresh = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => visible,
    isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 750 });
  t.after(() => refresh.stop());
  refresh.start(); await settle();
  refresh.request(); visible = false; refresh.wake();
  for (let i = 0; i < 10; i++) refresh.request();
  t.mock.timers.tick(180_000); await settle();
  assert.equal(calls, 1);
  visible = true; refresh.wake(); refresh.wake(); refresh.request();
  t.mock.timers.tick(750); await settle();
  assert.equal(calls, 2);
});

test('disconnection restores bounded fallback polling and reconnect restores the safety cadence', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let connected = true, calls = 0;
  const refresh = createLiveRefresh({ refresh: async () => { calls++; }, isVisible: () => true,
    isConnected: () => connected, fallbackMs: 10_000, eventDelayMs: 750 });
  t.after(() => refresh.stop());
  refresh.start(); await settle();
  connected = false; refresh.connectionChanged();
  t.mock.timers.tick(10_000); await settle();
  assert.equal(calls, 2);
  connected = true; refresh.connectionChanged(); refresh.request();
  await settle(); assert.equal(calls, 3, 'reconnect revalidates without the old event debounce');
  t.mock.timers.tick(59_999); await settle();
  assert.equal(calls, 3);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls, 4);
});

test('slow refreshes never overlap and disposal cancels an outstanding follow-up', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending = deferred<void>();
  let calls = 0;
  const refresh = createLiveRefresh({ refresh: () => { calls++; return pending.promise; }, isVisible: () => true,
    isConnected: () => false, fallbackMs: 10_000, eventDelayMs: 750 });
  refresh.start();
  for (let i = 0; i < 10; i++) refresh.request();
  t.mock.timers.tick(100_000); await settle();
  assert.equal(calls, 1);
  refresh.stop(); pending.resolve(); await settle();
  t.mock.timers.tick(100_000); await settle();
  assert.equal(calls, 1);
});

test('events during an in-flight read yield one throttled follow-up', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending = deferred<void>();
  let calls = 0;
  const refresh = createLiveRefresh({ refresh: () => ++calls === 1 ? pending.promise : Promise.resolve(),
    isVisible: () => true, isConnected: () => true, fallbackMs: 10_000, eventDelayMs: 750 });
  t.after(() => refresh.stop());
  refresh.start(); for (let i = 0; i < 20; i++) refresh.request();
  pending.resolve(); await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(750); await settle();
  assert.equal(calls, 2);
});

test('metadata cache expires, bypasses on manual refresh and never reuses a different scope/reset', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const read = createFreshRead<number>();
  let calls = 0;
  const fetch = async () => ++calls;
  assert.equal(await read('account:origin:reset1', 60_000, fetch), 1);
  assert.equal(await read('account:origin:reset1', 60_000, fetch), 1);
  t.mock.timers.tick(60_000);
  assert.equal(await read('account:origin:reset1', 60_000, fetch), 2);
  assert.equal(await read('account:origin:reset2', 60_000, fetch), 3);
  assert.equal(await read('other:origin:reset2', 60_000, fetch), 4);
  assert.equal(await read('other:origin:reset2', 0, fetch), 5);
});

test('metadata failures are retried and late old reads cannot replace a new scope', async () => {
  const read = createFreshRead<number>();
  const old = deferred<number>();
  const first = read('old', 60_000, () => old.promise);
  assert.equal(await read('new', 60_000, async () => 2), 2);
  old.resolve(1); await first;
  assert.equal(await read('new', 60_000, async () => 3), 2);
  await assert.rejects(read('failed', 60_000, async () => { throw Error('offline'); }));
  assert.equal(await read('failed', 60_000, async () => 4), 4);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('selection fences late callbacks without letting them displace the active message lane', () => {
  let selection: string | undefined = 'old';
  const gate = createMessageSnapshotGate(() => 'account', () => selection);
  const old = gate.begin('old');
  assert.equal(old(), true);
  selection = 'new';
  assert.equal(old(), false);
  assert.equal(old.accept(undefined), false);
  const active = gate.begin('new');
  assert.equal(active.accept(cursor(10)), true);
  const stale = gate.begin('old');
  assert.equal(stale(), false);
  assert.equal(stale.accept(cursor(99)), false);
  assert.equal(gate.observe(cursor(99), 'old'), false);
  assert.equal(active(), true);
  assert.equal(gate.begin('new').accept(cursor(9)), false, 'stale callback cannot reset active watermark');
  selection = undefined;
  assert.equal(active(), false);
  assert.equal(gate.begin('new').accept(cursor(100)), false);
});

test('same-resource in-flight refresh coalesces to one underlying call', async () => {
  const coalescer = createInFlightCoalescer<string>();
  const pending = deferred<number>();
  let calls = 0;

  const first = coalescer.run('messages:s1:36', () => {
    calls += 1;
    return pending.promise;
  });
  const second = coalescer.run('messages:s1:36', () => {
    calls += 1;
    return Promise.resolve(2);
  });

  assert.equal(calls, 1);
  assert.equal(first, second);
  pending.resolve(1);
  assert.equal(await second, 1);
  assert.equal(coalescer.has('messages:s1:36'), false);
});

test('queued timer/adaptive refresh produces at most one follow-up after the current request', async () => {
  const pending = [deferred<number>(), deferred<number>()];
  let calls = 0;
  const refresh = createQueuedRefresh(() => pending[calls++]!.promise);

  const first = refresh.run();
  const duplicateA = refresh.run();
  const duplicateB = refresh.run();

  assert.equal(calls, 1);
  assert.equal(first, duplicateA);
  assert.equal(first, duplicateB);

  pending[0]!.resolve(10);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);

  pending[1]!.resolve(20);
  assert.equal(await first, 20);
  assert.equal(calls, 2);
});

test('late stale response does not apply over a newer response', async () => {
  const runner = createLatestWinsRunner<number>();
  const slow = deferred<number>();
  const fast = deferred<number>();
  const applied: number[] = [];

  const first = runner.run(() => slow.promise, (value) => applied.push(value));
  const second = runner.run(() => fast.promise, (value) => applied.push(value));

  fast.resolve(2);
  assert.deepEqual(await second, { value: 2, applied: true });
  slow.resolve(1);
  assert.deepEqual(await first, { value: 1, applied: false });
  assert.deepEqual(applied, [2]);
});

test('snapshot fence checks after unrelated Promise.all work, before UI and cache writes', async () => {
  const gate = createLatestRequestGate();
  const metadata = deferred<void>();
  const applied: string[] = [];
  const cache: string[] = [];
  const stale = gate.begin();
  const first = (async () => {
    const [snapshot] = await Promise.all([Promise.resolve('old'), metadata.promise]);
    if (!stale()) return;
    applied.push(snapshot);
    cache.push(snapshot);
  })();
  await Promise.resolve();
  const latest = gate.begin();
  if (latest()) { applied.push('new'); cache.push('new'); }
  metadata.resolve();
  await first;
  assert.deepEqual(applied, ['new']);
  assert.deepEqual(cache, ['new']);
});

test('background, immediate and history refresh share one lane; lanes stay independent', () => {
  const messages = createLatestRequestGate();
  const sessions = createLatestRequestGate();
  const list = sessions.begin();
  const background = messages.begin();
  const immediate = messages.begin();
  const history = messages.begin();
  assert.equal(background(), false);
  assert.equal(immediate(), false);
  assert.equal(history(), true);
  assert.equal(list(), true);
  messages.invalidate();
  assert.equal(history(), false, 'selection cleanup also blocks late cache writes and errors');
  assert.equal(messages.begin()(), true, 'new session remains usable after cleanup');
});

test('account switch and unmount invalidate responses even after fetch already resolved', () => {
  let scope = 'account-a';
  const gate = createLatestRequestGate(() => scope);
  const first = gate.begin();
  scope = 'account-b';
  assert.equal(first(), false);
  const second = gate.begin();
  assert.equal(second(), true);
  gate.invalidate();
  assert.equal(second(), false);
});

test('failure of a newer request never reauthorizes an older snapshot', async () => {
  const runner = createLatestWinsRunner<string>();
  const stale = deferred<string>();
  const applied: string[] = [];
  const first = runner.run(() => stale.promise, value => applied.push(value));
  await assert.rejects(runner.run(async () => { throw new Error('offline'); }, value => applied.push(value)), /offline/);
  stale.resolve('old');
  assert.equal((await first).applied, false);
  await runner.run(async () => 'recovered', value => applied.push(value));
  assert.deepEqual(applied, ['recovered']);
});

const cursor = (seq: number, epoch = '11111111-1111-4111-8111-111111111111') => `ce1_${epoch}:${seq}`;

test('session proof covers only invalidations already observed at dispatch without fabricating a global cursor', () => {
  const gate = createMessageSnapshotGate();
  gate.begin('session-a').accept(cursor(1));
  gate.observe(cursor(10));
  assert.equal(gate.isCaughtUp(), false);
  assert.equal(gate.begin('session-a').acceptSession(), true);
  assert.equal(gate.isCaughtUp(), true);
  assert.equal(gate.observe(cursor(11)), true);
  assert.equal(gate.isCaughtUp(), false, 'a newer event invalidates the session proof');
  assert.equal(gate.begin('session-a').accept(cursor(0)), false, 'session proof must not erase the existing global regression floor');
  assert.equal(gate.begin('session-a').accept(cursor(1)), true);
  assert.equal(gate.isCaughtUp(), false, 'ordinary snapshots cannot inherit session coverage');
});

for (const invalidation of [cursor(10), undefined, 'legacy-event']) {
  test(`session proof started before ${String(invalidation)} invalidation requires one bounded trailing read`, () => {
    const gate = createMessageSnapshotGate();
    gate.begin('session-a').accept(cursor(1));
    let refreshes = 0;
    gate.subscribe(() => refreshes++);
    const pending = gate.begin('session-a');
    assert.equal(gate.observe(invalidation), true);
    assert.equal(pending.acceptSession(), false);
    assert.equal(pending.acceptSession(), false);
    assert.equal(refreshes, 1);
    assert.equal(gate.begin('session-a').acceptSession(), true);
    assert.equal(gate.isCaughtUp(), true);
    assert.equal(gate.observe(undefined), true, 'cursorless events also invalidate a session proof');
    assert.equal(gate.begin('session-a').acceptSession(), true);
    assert.equal(pending.acceptSession(), false, 'superseded requests cannot queue extra catch-ups');
    assert.equal(refreshes, 1);
  });
}

test('session proof cannot survive account changes, selection changes, reset or newer requests', () => {
  let scope = 'account-a', selection = 'session-a';
  const gate = createMessageSnapshotGate(() => scope, () => selection);
  let pending = gate.begin(selection);
  scope = 'account-b';
  assert.equal(pending.acceptSession(), false);
  pending = gate.begin(selection);
  selection = 'session-b';
  assert.equal(pending.acceptSession(), false);
  assert.equal(gate.begin('session-a').acceptSession(), false);
  pending = gate.begin(selection);
  gate.invalidate();
  assert.equal(pending.acceptSession(), false);
  pending = gate.begin(selection);
  const latest = gate.begin(selection);
  assert.equal(pending.acceptSession(), false);
  assert.equal(latest.acceptSession(), true);
  gate.observe(cursor(10));
  assert.equal(gate.isCaughtUp(), false);
  assert.equal(gate.begin(selection).acceptSession(), true);
  scope = 'account-c';
  const next = gate.begin(selection);
  assert.equal(next.accept(cursor(1)), true);
  gate.observe(cursor(2));
  assert.equal(gate.isCaughtUp(), false, 'new account cannot inherit old proof');
});

test('source watermark rejects regressing snapshots from later requests, allows equal history boundaries', () => {
  const gate = createMessageSnapshotGate();
  assert.equal(gate.begin('session-a').accept(cursor(10)), true);
  assert.equal(gate.begin('session-a').accept(cursor(9)), false);
  assert.equal(gate.begin('session-a').accept(cursor(10)), true, 'same watermark can carry a larger history window');
  assert.equal(gate.begin('session-a').accept(cursor(11)), true);
});

test('snapshot-covered invalidations and duplicate events do not request another read', () => {
  const gate = createMessageSnapshotGate();
  gate.begin('session-a').accept(cursor(10));
  assert.equal(gate.observe(cursor(9)), false);
  assert.equal(gate.observe(cursor(10)), false);
  assert.equal(gate.observe(cursor(12)), true);
  assert.equal(gate.observe(cursor(12)), false);
  assert.equal(gate.observe(cursor(11)), false);
});

test('events during a slow snapshot coalesce to one catch-up, without starving forward rendering', () => {
  const gate = createMessageSnapshotGate();
  let refreshes = 0;
  gate.subscribe(() => refreshes++);
  const pending = gate.begin('session-a');
  for (let seq = 1; seq <= 512; seq++) gate.observe(cursor(seq));
  assert.equal(pending.accept(cursor(128)), true, 'partial forward progress still renders');
  assert.equal(refreshes, 1);
  assert.equal(gate.begin('session-a').accept(cursor(128)), true);
  assert.equal(refreshes, 1, 'unchanged source lag cannot create a retry loop');
  gate.observe(cursor(513));
  gate.begin('session-a').accept(cursor(256));
  assert.equal(refreshes, 2);
  gate.begin('session-a').accept(cursor(513));
  assert.equal(gate.observe(cursor(513)), false);
});

test('invalidations before request start also receive one bounded catch-up if snapshot lags', () => {
  const gate = createMessageSnapshotGate();
  gate.begin('session-a').accept(cursor(1));
  let refreshes = 0;
  gate.subscribe(() => refreshes++);
  gate.observe(cursor(10));
  gate.begin('session-a').accept(cursor(2));
  gate.begin('session-a').accept(cursor(2));
  assert.equal(refreshes, 1);
});

test('reset invalidates pre-reset results; new epoch sequence zero is not compared with old sequence', () => {
  const gate = createMessageSnapshotGate();
  gate.begin('session-a').accept(cursor(100));
  const pending = gate.begin('session-a');
  gate.invalidate();
  assert.equal(pending.accept(cursor(101)), false);
  assert.equal(gate.begin('session-a').accept(cursor(0, '22222222-2222-4222-8222-222222222222')), true);
});

test('scope/selection changes clear source state; old callbacks and cleanup cannot revive it', () => {
  let scope = 'account-a';
  const gate = createMessageSnapshotGate(() => scope);
  gate.begin('session-a').accept(cursor(100));
  const stale = gate.begin('session-a');
  scope = 'account-b';
  assert.equal(stale.accept(cursor(101)), false);
  assert.equal(gate.begin('session-a').accept(cursor(1)), true);
  assert.equal(gate.begin('session-b').accept(cursor(0)), true);
  assert.equal(gate.observe(cursor(500), 'session-a'), false, 'old selection listener cannot contaminate new session watermark');
  let refreshes = 0;
  const cleanup = gate.subscribe(() => refreshes++);
  cleanup();
  gate.observe(cursor(10));
  gate.begin('session-b').accept(cursor(1));
  assert.equal(refreshes, 0);
});

test('legacy snapshots remain supported but malformed or missing established cursors cannot silently regress', () => {
  const gate = createMessageSnapshotGate();
  assert.equal(gate.begin('legacy').accept(undefined), true);
  assert.equal(gate.observe('hub-delivery-uuid'), true);
  assert.equal(gate.begin('legacy').accept(cursor(0)), true);
  for (const invalid of [undefined, null, '', 'hub-delivery-uuid', cursor(-1), cursor(Number.MAX_SAFE_INTEGER + 1), `${cursor(0)}extra`]) {
    assert.equal(gate.begin('legacy').accept(invalid), false);
  }
  gate.invalidate();
  assert.equal(gate.begin('legacy').accept(undefined), true, 'explicit reset allows compatibility renegotiation');
});

test('foreground wake clears client-side transient failure backoff while preserving explicit server retry advice', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let visible = true, calls = 0, failMode: 'none' | 'transient' | 'server' = 'transient';
  const c = createLiveRefresh({
    refresh: async () => {
      calls++;
      if (failMode === 'transient') throw new Error('network suspended');
      if (failMode === 'server') throw { retryAfterMs: 10_000 };
    },
    isVisible: () => visible,
    isConnected: () => true,
    fallbackMs: 60_000,
    eventDelayMs: 750,
  });
  t.after(() => c.stop());
  c.start(); await settle();
  assert.equal(calls, 1);
  visible = false; c.wake();
  t.mock.timers.tick(300);
  failMode = 'none';
  visible = true; c.wake(); await settle();
  assert.equal(calls, 2, 'foreground wake bypasses client transient error backoff immediately');
});
