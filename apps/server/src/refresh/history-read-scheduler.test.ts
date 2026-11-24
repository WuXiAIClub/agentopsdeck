import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createHistoryReadScheduler } from './history-read-scheduler.js';
import { createHistoryRefresh, HistoryReadDeferred } from './history.js';
import { createHistoryPreparation } from './history-preparation.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';

const display = { readOnly: true, maxAgeMs: 1500 };
test('default display budget admits 3 active and 128 waiting distinct sessions', async () => {
  assert.throws(() => createHistoryReadScheduler({ concurrency: 4 }));
  assert.throws(() => createHistoryReadScheduler({ maxPending: 129 }));
  const scheduler = createHistoryReadScheduler(), held = gate();
  const reads = Array.from({ length: 131 }, (_, i) => scheduler.run(String(i), display, () => held.promise));
  await tick();
  assert.equal(scheduler.inspect().active, 3);
  assert.equal(scheduler.inspect().pending, 128);
  await assert.rejects(scheduler.run('overflow', display, async () => {}), HistoryReadDeferred);
  held.resolve(); await Promise.all(reads);
  await scheduler.close();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('display reads are bounded across sessions, coalesced per session and FIFO without retaining results', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 2, maxPending: 3 });
  const gates = Array.from({ length: 5 }, gate), started: number[] = [];
  const reads = gates.map((g, i) => scheduler.run(String(i), display, async () => { started.push(i); await g.promise; }));
  const joined = scheduler.run('0', display, async () => { assert.fail('duplicate'); });
  assert.equal(joined, reads[0]);
  assert.equal(started.length, 0, 'even synchronous projections yield before starting');
  await tick(); assert.deepEqual(started, [0, 1]);
  assert.equal(scheduler.inspect().pending, 3);
  for (const [i, g] of gates.entries()) {
    g.resolve(); await reads[i]; await tick();
    assert.deepEqual(started, Array.from({ length: Math.min(i + 3, 5) }, (_, n) => n));
  }
  await joined;
  await scheduler.run('0', display, async () => { started.push(0); });
  assert.equal(started.length, 6, 'scheduler is not a freshness cache');
  const stats = scheduler.inspect();
  assert.equal(stats.active, 0); assert.equal(stats.pending, 0); assert.equal(stats.completed, 6);
  assert.equal(stats.coalesced, 1); assert.ok(stats.queueMs >= 0 && stats.readMs >= 0);
  assert.ok(Object.values(stats).every(n => typeof n === 'number'), 'content-free telemetry');
  await scheduler.close();
});

test('saturation is typed preparation pressure; real source failure remains failed and releases capacity', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1, maxPending: 0 }), held = gate();
  const first = scheduler.run('held', display, () => held.promise);
  await assert.rejects(scheduler.run('overflow', display, async () => {}), HistoryReadDeferred);
  const prepare = createHistoryPreparation();
  assert.equal(await prepare('overflow', () => scheduler.run('overflow', display, async () => {}), () => true, new AbortController().signal), 'pending');
  held.resolve(); await first;
  const original = new Error('original source error');
  assert.equal(await prepare('bad', () => scheduler.run('bad', display, async () => { throw original; }), () => true, new AbortController().signal), 'failed');
  await scheduler.run('next', display, async () => {});
  assert.equal(scheduler.inspect().deferred, 2); assert.equal(scheduler.inspect().failed, 1);
  await scheduler.close();
});

for (const runtime of ['codex', 'claude-code', 'ghcp', 'openclaw', 'hermes']) {
  test(`${runtime}: control and fresh reads bypass a saturated display queue, never join its proof`, async () => {
    const scheduler = createHistoryReadScheduler({ concurrency: 1, maxPending: 1 }), held = gate();
    const key = `${runtime}:synthetic`;
    const reading = scheduler.run(key, display, () => held.promise);
    const queued = scheduler.run('other', display, async () => {});
    const calls: string[] = [];
    await scheduler.run(key, { fresh: true, readOnly: true }, async () => { calls.push('fresh'); });
    await scheduler.run(key, {}, async () => { calls.push('control'); });
    assert.deepEqual(calls, ['fresh', 'control']);
    assert.equal(scheduler.inspect().pending, 1);
    assert.equal(scheduler.inspect().bypassed, 2);
    held.resolve(); await Promise.all([reading, queued]); await scheduler.close();
  });
}

test('same-session terminal still drains display and then obtains its own authoritative validated read', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1 }), held = gate();
  const proofs: boolean[] = [];
  const refresh = createHistoryRefresh(async (_key, authoritative) => { proofs.push(authoritative); if (!authoritative) await held.promise; });
  const reading = scheduler.run('one', display, () => refresh('one', display));
  await tick();
  const terminal = scheduler.run('one', { fresh: true }, () => refresh('one', { fresh: true }));
  await tick(); assert.deepEqual(proofs, [false]); assert.equal(refresh.ready('one'), false);
  held.resolve(); await Promise.all([reading, terminal]);
  assert.deepEqual(proofs, [false, true]); assert.equal(refresh.ready('one'), true);
  await Promise.all([scheduler.close(), refresh.close()]);
});

test('close rejects new reads, drains active/queued/control ownership, and retains the original rejection', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1 }), held = gate(), control = gate();
  const first = scheduler.run('one', display, () => held.promise);
  const error = new Error('original disk failure');
  const queued = scheduler.run('two', display, () => { throw error; });
  const rejection = assert.rejects(queued, caught => caught === error);
  const authority = scheduler.run('control', { fresh: true }, () => control.promise);
  let closed = false;
  const closing = scheduler.close(); assert.equal(scheduler.close(), closing);
  void closing.then(() => { closed = true; });
  await assert.rejects(scheduler.run('one', display, async () => {}), /closed/);
  await assert.rejects(scheduler.run('control', { fresh: true }, async () => {}), /closed/);
  held.resolve(); await Promise.all([first, rejection]); assert.equal(closed, false);
  control.resolve(); await Promise.all([authority, closing]); assert.equal(closed, true);
  assert.equal(scheduler.inspect().active, 0); assert.equal(scheduler.inspect().controls, 0);
});

test('maintenance cannot drain past queued display work; resume restores admission', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1 }), drain = createTaskDrain(), held = gate();
  const one = drain.run(() => scheduler.run('one', display, () => held.promise));
  let second = false;
  const two = drain.run(() => scheduler.run('two', display, async () => { second = true; }));
  const pause = drain.pause(); assert.equal(pause.resume(), false);
  await assert.rejects(drain.run(() => scheduler.run('three', display, async () => {})), /paused/);
  held.resolve(); await Promise.all([one, two, pause.drained]); assert.equal(second, true);
  assert.equal(pause.resume(), true);
  await drain.run(() => scheduler.run('three', display, async () => {}));
  await Promise.all([drain.close(), scheduler.close()]);
});

test('aborted browser detaches without cancelling or duplicating the queued shared hydration', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1 }), prepare = createHistoryPreparation({ waitMs: 1 });
  const held = gate(), controller = new AbortController(); let reads = 0, ready = false;
  const first = scheduler.run('held', display, () => held.promise);
  const read = () => scheduler.run('queued', display, async () => { reads++; ready = true; });
  const browser = prepare('queued', read, () => ready, controller.signal);
  controller.abort(new Error('transport gone')); await assert.rejects(browser, /transport gone/);
  assert.equal(await prepare('queued', read, () => ready, new AbortController().signal), 'pending');
  held.resolve(); await first; await scheduler.close();
  assert.equal(await prepare('queued', read, () => ready, new AbortController().signal), 'ready');
  assert.equal(reads, 1);
});

test('invalid limits cannot create an unbounded or permanently stalled scheduler', () => {
  for (const concurrency of [0, -1, 65, NaN, 1.5]) assert.throws(() => createHistoryReadScheduler({ concurrency }));
  for (const maxPending of [-1, 1025, Infinity, 1.5]) assert.throws(() => createHistoryReadScheduler({ maxPending }));
});

test('higher-priority hot reads jump ahead of background warm reads and coalescing promotes priority', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1, maxPending: 16 });
  const held = gate();
  const started: string[] = [];

  const first = scheduler.run('held', display, () => held.promise);
  await tick();

  // Enqueue background warm reads (priority 6) followed by a hot foreground read (priority -2)
  const warmA = scheduler.run('warm-a', { ...display, priority: 6 }, async () => { started.push('warm-a'); });
  const warmB = scheduler.run('warm-b', { ...display, priority: 6 }, async () => { started.push('warm-b'); });
  const hotRead = scheduler.run('hot-active', { ...display, priority: -2 }, async () => { started.push('hot-active'); });

  // Coalescing warm-b with a foreground request promotes its priority to -1
  const promotedWarmB = scheduler.run('warm-b', { ...display, priority: -1 }, async () => { assert.fail('should coalesce'); });
  assert.equal(promotedWarmB, warmB);

  held.resolve();
  await Promise.all([first, warmA, warmB, hotRead]);
  assert.deepEqual(started, ['hot-active', 'warm-b', 'warm-a']);
  await scheduler.close();
});

test('background warm reads are shed early when queue pressure rises while foreground reads still admit', async () => {
  const scheduler = createHistoryReadScheduler({ concurrency: 1, maxPending: 8 });
  const held = gate();
  const first = scheduler.run('active-slot', display, () => held.promise);
  await tick();

  // Fill half of maxPending (4 of 8) with foreground reads
  const fgReads = [1, 2, 3, 4].map(i => scheduler.run(`fg-${i}`, { ...display, priority: 0 }, async () => {}));

  // Background warm read (priority >= 4) is shed to preserve headroom for foreground requests
  await assert.rejects(
    scheduler.run('bg-warm', { ...display, priority: 5 }, async () => {}),
    (err: unknown) => err instanceof HistoryReadDeferred
  );

  // Foreground high-priority read (priority -1) is still admitted in the remaining half of the queue!
  const urgentFg = scheduler.run('fg-urgent', { ...display, priority: -1 }, async () => {});

  const stats = scheduler.inspect();
  assert.equal(stats.lowPriorityShed, 1);
  assert.equal(stats.highPriorityAdmitted, 1);
  assert.ok(Object.values(stats).every(n => typeof n === 'number'));

  held.resolve();
  await Promise.all([first, ...fgReads, urgentFg]);
  await scheduler.close();
});

test('default scheduler grants one urgent burst slot when baseline slots are occupied by background warm reads', async () => {
  const scheduler = createHistoryReadScheduler();
  const bgGates = [gate(), gate(), gate()];
  const started: string[] = [];
  const bgReads = bgGates.map((g, i) =>
    scheduler.run(`bg-${i}`, { ...display, priority: 6 }, async () => {
      started.push(`bg-${i}`);
      await g.promise;
    })
  );
  await tick();
  assert.equal(started.length, 3);

  // Foreground urgent read (priority -2) gets the single urgent burst slot immediately!
  const urgentGate = gate();
  const urgentRead = scheduler.run('urgent-fg', { ...display, priority: -2 }, async () => {
    started.push('urgent-fg');
    await urgentGate.promise;
  });
  await tick();
  assert.ok(started.includes('urgent-fg'), 'urgent foreground read starts in burst slot without waiting for background reads');
  assert.equal(scheduler.inspect().urgentBurstDispatched, 1);

  urgentGate.resolve();
  bgGates.forEach(g => g.resolve());
  await Promise.all([...bgReads, urgentRead]);
  await scheduler.close();
});
