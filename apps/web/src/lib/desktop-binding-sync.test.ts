import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDesktopBindingSync,
  extractBindingSessionIds,
  pruneBindingMap,
  updateBindingMap,
} from './desktop-binding-sync.js';

function createFakeClock() {
  let current = 1_000;
  let nextId = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  return {
    now: () => current,
    scheduleTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { due: current + Math.max(0, ms), fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer as unknown as number);
    },
    advance: async (ms: number) => {
      const target = current + ms;
      for (;;) {
        let earliestId: number | undefined;
        let earliestDue = Infinity;
        for (const [id, item] of timers) {
          if (item.due <= target && item.due < earliestDue) {
            earliestDue = item.due;
            earliestId = id;
          }
        }
        if (earliestId === undefined) break;
        const item = timers.get(earliestId)!;
        timers.delete(earliestId);
        current = item.due;
        item.fn();
        await new Promise((r) => setImmediate(r));
      }
      current = target;
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('coalesces burst initial notifications into 1 read per resource and refreshes only notified resource', async () => {
  const clock = createFakeClock();
  const nbCalls: string[] = [];
  const tbCalls: string[] = [];
  let nbMap: Record<string, string[]> = {};
  let tbMap: Record<string, string[]> = {};

  const nbIds = Array.from({ length: 8 }, (_, i) => `nb-${i}`);
  const tbIds = Array.from({ length: 8 }, (_, i) => `tb-${i}`);

  const sync = createDesktopBindingSync({
    notebookIds: nbIds,
    taskboardIds: tbIds,
    readNotebook: async (id) => {
      nbCalls.push(id);
      return [`sess-${id}`];
    },
    readTaskboard: async (id) => {
      tbCalls.push(id);
      return id === 'tb-0' ? ['sess-tb-0'] : [];
    },
    onNotebook: (id, sIds) => {
      nbMap = updateBindingMap(nbMap, id, sIds);
    },
    onTaskboard: (id, sIds) => {
      tbMap = updateBindingMap(tbMap, id, sIds);
    },
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    clearTimer: clock.clearTimer,
  });

  // Simulate workspaceResourceEvents synchronous cached-revision callbacks during mount
  for (const id of nbIds) sync.notify('notebook', id, 5);
  for (const id of tbIds) sync.notify('taskboard', id, 3);
  sync.start();

  await clock.advance(200);

  assert.equal(nbCalls.length, 8);
  assert.equal(tbCalls.length, 8);
  assert.deepEqual(nbMap['nb-0'], ['sess-nb-0']);
  assert.deepEqual(tbMap, { 'tb-0': ['sess-tb-0'] });

  // Duplicate revision notifications must be ignored
  sync.notify('notebook', 'nb-2', 5);
  sync.notify('taskboard', 'tb-1', 3);
  await clock.advance(200);
  assert.equal(nbCalls.length, 8);
  assert.equal(tbCalls.length, 8);

  // Higher revision on a single notebook refreshes ONLY that notebook
  sync.notify('notebook', 'nb-2', 6);
  sync.notify('notebook', 'nb-2', 7);
  await clock.advance(200);
  assert.equal(nbCalls.length, 9);
  assert.equal(nbCalls[8], 'nb-2');
  assert.equal(tbCalls.length, 8);
});

test('bounds concurrency to 2 and yields while message history loads are busy up to maxBusyDeferMs', async () => {
  const clock = createFakeClock();
  let busy = true;
  let inFlight = 0;
  let maxObservedInFlight = 0;
  const started: string[] = [];

  const sync = createDesktopBindingSync({
    notebookIds: ['a', 'b', 'c', 'd'],
    taskboardIds: [],
    readNotebook: async (id) => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      started.push(id);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return [`s-${id}`];
    },
    readTaskboard: async () => [],
    onNotebook: () => {},
    onTaskboard: () => {},
    isMessageLoadBusy: () => busy,
    getConcurrency: () => 4, // should clamp to 2
    coalesceMs: 80,
    busyDeferSliceMs: 120,
    maxBusyDeferMs: 500,
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    clearTimer: clock.clearTimer,
  });

  sync.start();
  await clock.advance(300);
  // Still deferring while message load is busy (< 500ms after first drain check at +80ms)
  assert.equal(started.length, 0);

  // Once message load finishes, binding reads proceed with concurrency <= 2
  busy = false;
  await clock.advance(200);
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  assert.equal(maxObservedInFlight, 2);
});

test('extractBindingSessionIds and map helpers preserve referential identity when unchanged', () => {
  assert.deepEqual(extractBindingSessionIds(null), []);
  assert.deepEqual(extractBindingSessionIds({ state: 'revoked', sessionId: 's1' }), []);
  assert.deepEqual(extractBindingSessionIds({ state: 'active', problem: { code: 'missing' }, sessionId: 's1' }), []);
  assert.deepEqual(
    extractBindingSessionIds({ state: 'active', sessionId: 's1', sessionIds: ['s1', 's2', ''] }),
    ['s1', 's2'],
  );

  const base = { a: ['s1'], b: ['s2'] };
  assert.equal(updateBindingMap(base, 'a', ['s1']), base);
  assert.equal(pruneBindingMap(base, new Set(['a', 'b'])), base);
  assert.deepEqual(pruneBindingMap(base, new Set(['a'])), { a: ['s1'] });
  assert.deepEqual(updateBindingMap(base, 'b', []), { a: ['s1'] });
});

test('updateResources preserves clean resources without re-fetching and adopts delayed initial SSE revision', async () => {
  const clock = createFakeClock();
  const nbCalls: string[] = [];
  const tbCalls: string[] = [];

  const sync = createDesktopBindingSync({
    notebookIds: ['default'],
    taskboardIds: ['default'],
    readNotebook: async (id) => {
      nbCalls.push(id);
      return [`s-${id}`];
    },
    readTaskboard: async (id) => {
      tbCalls.push(id);
      return [];
    },
    onNotebook: () => {},
    onTaskboard: () => {},
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    clearTimer: clock.clearTimer,
  });

  // Mount starts with ['default'] before notebooks list arrives from /api/hub/v1/notebooks
  sync.start();
  await clock.advance(120);
  assert.deepEqual(nbCalls, ['default']);
  assert.deepEqual(tbCalls, ['default']);

  // Async notebooks list arrives with ['default', 'nb-1', 'nb-2']: 'default' must NOT re-fetch!
  sync.updateResources(['default', 'nb-1', 'nb-2'], ['default', 'tb-1']);
  await clock.advance(200);
  assert.deepEqual(nbCalls, ['default', 'nb-1', 'nb-2']);
  assert.deepEqual(tbCalls, ['default', 'tb-1']);

  // Delayed initial SSE snapshot arrives AFTER baseline read completed (appliedRevision === 0):
  // it must adopt baseline revision without triggering a duplicate second GET wave!
  sync.notify('notebook', 'nb-1', 4);
  sync.notify('taskboard', 'tb-1', 2);
  await clock.advance(200);
  assert.equal(nbCalls.length, 3);
  assert.equal(tbCalls.length, 2);

  // Subsequent genuine mutation (revision 5 > 4) still refreshes ONLY nb-1
  sync.notify('notebook', 'nb-1', 5);
  await clock.advance(200);
  assert.equal(nbCalls.length, 4);
  assert.equal(nbCalls[3], 'nb-1');
});
