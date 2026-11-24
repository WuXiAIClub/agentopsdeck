import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorUserStore } from './connector-user-store.js';
import { SdkExecutionDriver } from './sdk-execution-driver.js';
import type { SdkAgentId, SdkCompactRef, SdkCompactResult } from './sdk-execution-journal.js';
import type { SdkOwnedCompactWorker } from './sdk-compact-worker.js';

function fixture(runtime: SdkAgentId) {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const key = `${runtime}:${randomUUID()}`, epoch = randomUUID(), nativeSessionId = randomUUID();
  journal.create({ key, nativeSessionId, title: 'Fixture', createdAt: 0 });
  const first = { key, id: randomUUID(), epoch };
  store.turns.enqueue(runtime, { id: first.id, sessionKey: key, createdAt: 0, payload: {} });
  journal.begin(first, [first.id], store.turns); journal.observeTerminal(first, 'completed', store.turns); journal.confirmSettled(first);
  let authorized = true, available = true, quiet = false, starts = 0, closes = 0, stops = 0;
  let complete!: (proof: SdkCompactRef & SdkCompactResult) => void, fail!: (error: Error) => void, finish!: () => void;
  let proof!: SdkCompactRef & SdkCompactResult;
  const driver = new SdkExecutionDriver({ journal, turns: store.turns, deadlineMs: 1000,
    compactTimeoutMs: 1000, admissionReady: () => available, authorize: () => authorized,
    start: () => assert.fail('Compaction must not dispatch an ordinary message'), endStreams: () => {},
    adapter: () => ({ runtime, epoch, ready: true, send: async () => assert.fail('No message send'),
      inspectSettlement: async () => assert.fail('No message settlement'), interrupt: async () => assert.fail('No message stop'), close() {} }),
    startCompact: execution => {
      starts++;
      proof = { ...execution, nativeRequestId: execution.id, completionEventId: randomUUID(), outcome: 'completed' };
      const result = new Promise<SdkCompactRef & SdkCompactResult>((resolve, reject) => { complete = resolve; fail = reject; });
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const worker: SdkOwnedCompactWorker = { result, finished,
        inspectSettlement: async () => ({ ...proof, historyPersisted: true, nativeQuiescent: quiet }),
        inspectQuiescence: async () => quiet,
        interrupt: async () => { assert.equal(journal.current(key)?.stopRequested, true); stops++; },
        close: () => { closes++; quiet = true; fail(new Error('closed')); finish(); } };
      return worker;
    },
  });
  const admit = (commit: () => void = () => {}) => driver.compact(key, randomUUID(), 'owner', commit);
  return { store, journal, key, driver, admit, proof: () => proof,
    counts: () => ({ starts, closes, stops }), authorized: (v: boolean) => { authorized = v; }, available: (v: boolean) => { available = v; },
    complete: () => { quiet = true; complete(proof); finish(); }, fail: () => { quiet = true; fail(new Error('lost native IPC')); finish(); },
    close: async () => { await driver.close(); store.close(); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: denied concurrent compaction never closes the admitted worker`, async () => {
    const f = fixture(runtime);
    try {
      assert.equal(f.admit(), true); const original = f.journal.current(f.key);
      assert.equal(f.admit(), false); await setImmediate();
      assert.deepEqual(f.counts(), { starts: 1, closes: 0, stops: 0 });
      assert.deepEqual(f.journal.current(f.key), original);
      f.complete(); await setImmediate(); await f.driver.wake(f.key);
      assert.equal(f.journal.current(f.key)?.phase, 'completed');
      assert.equal(f.journal.canStart(f.key), true);
      assert.equal(f.driver.inspect().nativeWorkers, 0);
    } finally { await f.close(); }
  });
  test(`${runtime}: receipt rollback, owner denial, maintenance and queued input prevent worker launch`, async () => {
    const f = fixture(runtime);
    try {
      assert.throws(() => f.admit(() => { throw new Error('receipt failure'); }), /receipt failure/);
      f.authorized(false); assert.equal(f.admit(), false); f.authorized(true);
      f.available(false); assert.equal(f.admit(), false); f.available(true);
      storeQueue(f); assert.equal(f.admit(), false);
      await setImmediate(); assert.equal(f.counts().starts, 0);
    } finally { await f.close(); }
  });
  test(`${runtime}: exact stop is persisted before native ACK; failed control stays unknown without replay`, async () => {
    const f = fixture(runtime);
    try {
      assert.equal(f.admit(), true);
      assert.equal(await f.driver.interrupt(f.key, 'other', { actorId: 'owner', text: '', images: [] }), 'not_started');
      assert.equal(await f.driver.interrupt(f.key, f.proof().id, { actorId: 'owner', text: '', images: [] }), 'accepted');
      assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
      assert.equal(f.journal.canStart(f.key), false);
      f.fail(); await setImmediate(); await f.driver.wake(f.key);
      assert.equal(f.journal.current(f.key)?.phase, 'unknown');
      f.journal.recover(f.store.turns);
      assert.equal(f.admit(), false); await setImmediate();
      assert.equal(f.counts().starts, 1); assert.equal(f.counts().stops, 1);
    } finally { await f.close(); }
  });
}
function storeQueue(f: ReturnType<typeof fixture>) {
  f.store.turns.enqueue(f.journal.runtime, { id: randomUUID(), sessionKey: f.key, createdAt: 1,
    payload: { text: 'keep queued', actorId: 'owner', images: [] } });
}
