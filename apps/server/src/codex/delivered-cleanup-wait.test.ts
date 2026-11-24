import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from './app-server.js';
import { CodexRolloutReader, RolloutObservationPendingError } from './rollout-reader.js';
import { RolloutProjection } from './rollout-projection.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(done => setImmediate(done));
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('observer never returned')), 500); })]); }
  finally { clearTimeout(timer); }
}
function fixture(outcome: 'completed' | 'failed' | 'interrupted' = 'completed') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-delivered-cleanup-'));
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory, defaultModel: 'fixture',
    approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 30 });
  const runtime = codex as any, key = 'codex:synthetic', held = gate(), started = gate();
  let reads = 0, disposals = 0, wakes = 0;
  runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
    runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Keep visible', createdAt: 1 });
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'history cleanup cannot replay or resume');
    return { thread: { id: 'synthetic', path: 'private-native-path', status: { type: 'idle' }, turns: [
      { id: 'turn', status: outcome, items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered' }] },
    ] } };
  };
  runtime.rolloutReader.readSnapshot = async () => {
    reads++;
    return new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close: async () => {
      disposals++; started.resolve(); await held.promise;
    } }]);
  };
  const originalWake = runtime.turnWorker.wake.bind(runtime.turnWorker);
  runtime.turnWorker.wake = () => { wakes++; };
  return { codex, runtime, users, store, key, held, started, originalWake, counts: () => ({ reads, disposals, wakes }),
    async drain() { held.resolve(); await Promise.allSettled([...runtime.rolloutReader.snapshotWaits.keys()]); },
    async close() { held.resolve(); await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('fresh history waits for original cleanup before publication and returns bounded pending', async t => {
  const f = fixture(); t.after(() => f.close());
  const refresh = f.codex.refreshSession(f.key, { fresh: true });
  // Observe immediately so an early rejection is never unhandled.
  const result = refresh.then(() => undefined, error => error);
  await f.started.promise;
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible', 'no partial history publication before cleanup');
  assert.ok(await bounded(result) instanceof RolloutObservationPendingError);
  await assert.rejects(f.codex.refreshSession(f.key, { fresh: true }), RolloutObservationPendingError);
  assert.equal(f.counts().reads, 1, 'pending original cleanup prevents a replacement snapshot');
  await f.drain(); assert.equal(f.counts().disposals, 1);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible', 'late cleanup alone cannot publish');
  await f.codex.refreshSession(f.key, { fresh: true });
  assert.equal(f.counts().reads, 2); assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Recovered'));
});

for (const outcome of ['completed', 'failed', 'interrupted'] as const) test(`final ${outcome} cleanup preserves fencing until original disposal settles`, async t => {
  const f = fixture(outcome); t.after(() => f.close());
  f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
  const task = f.runtime.completingTurns.get(f.key); await f.started.promise;
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
  assert.equal(f.users.codexExecutions.canStart(f.key), false, 'cleanup is part of original proof, not execution clearance');
  await bounded(task); assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error'); assert.equal(f.counts().wakes, 0);
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', outcome); await bounded(f.runtime.completingTurns.get(f.key));
  assert.equal(f.counts().reads, 1);
  await f.drain(); assert.equal(f.counts().disposals, 1); assert.equal(f.users.codexExecutions.canStart(f.key), false);
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', outcome); await bounded(f.runtime.completingTurns.get(f.key));
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current'); assert.equal(f.counts().reads, 2); assert.equal(f.counts().wakes, 1);
});

test('fresh cleanup settlement rechecks original connection before any history publication', async t => {
  const f = fixture(); t.after(() => f.close()); f.runtime.options.requestTimeoutMs = 1000;
  const work = f.codex.refreshSession(f.key, { fresh: true }).then(() => undefined, error => error);
  await f.started.promise; f.runtime.setConnection('replacement-connection'); f.held.resolve();
  assert.ok(await bounded(work) instanceof Error);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
});

test('existing worker restores terminal history after original cleanup settles without browser or resend', async t => {
  const f = fixture(); t.after(() => f.close());
  f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
  await f.started.promise; await bounded(f.runtime.completingTurns.get(f.key));
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
  const attempted = gate(), restored = gate();
  const reconcile = f.runtime.turnWorker.options.reconcile;
  f.runtime.turnWorker.options.reconcile = async (key: string) => {
    try { return await reconcile(key); } finally { attempted.resolve(); }
  };
  const settle = f.users.codexExecutions.settleHistory.bind(f.users.codexExecutions);
  f.users.codexExecutions.settleHistory = (expected, sync) => {
    const result = settle(expected, sync);
    if (expected.sessionKey === f.key && sync === 'current') restored.resolve();
    return result;
  };
  // Use the actual worker and its existing retry mechanism. Only the test
  // scheduling interval is shortened; the production cold-read cooldown and
  // original cleanup ownership are unchanged.
  f.runtime.turnWorker.options.retryMs = 5;
  f.runtime.turnWorker.wake = f.originalWake;
  f.codex.startQueueWorker();
  await bounded(attempted.promise);
  assert.equal(f.counts().reads, 1, 'worker cannot replace the pending original snapshot');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
  f.held.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([restored.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('existing worker did not restore history')), 35_000);
    })]);
  } finally { clearTimeout(timer); }
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Recovered'));
  assert.ok(f.counts().reads >= 2);
  assert.equal(f.counts().disposals, f.counts().reads, 'each original lease disposes once');
});

test('delivered disposal deadline retains original cleanup in reader close without double disposal', async () => {
  const reader = new CodexRolloutReader(), held = gate(); let calls = 0, closed = false;
  const snapshot = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close: async () => { calls++; await held.promise; } }]);
  try {
    await assert.rejects((reader as any).disposeSnapshotWithin('private-native-path', snapshot, 10), RolloutObservationPendingError);
    const close = reader.close(); void close.then(() => { closed = true; }); await tick();
    assert.equal(closed, false); assert.equal(calls, 1);
    held.resolve(); await close; assert.equal(calls, 1); assert.equal(reader.cacheStats().pendingSnapshotWaits, 0);
  } finally { held.resolve(); await snapshot.dispose(); await reader.close(); }
});

test('fresh cleanup settlement after admission closes never applies its history', async t => {
  const f = fixture(); t.after(() => f.close()); f.runtime.options.requestTimeoutMs = 1000;
  const work = f.codex.refreshSession(f.key, { fresh: true }).then(() => undefined, error => error);
  await f.started.promise; f.runtime.executionUnavailable = true; f.held.resolve();
  assert.ok(await bounded(work) instanceof Error);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
});

test('cleanup-only retirement is retained even when new read admission is saturated', async () => {
  const reader = new CodexRolloutReader(), held = gate(); let calls = 0;
  const originals: Promise<void>[] = [];
  for (let n = 0; n < 64; n++) originals.push((reader as any).observeWithin('path-' + n, 1000, () => held.promise, async () => {}).catch(() => {}));
  const snapshot = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close: async () => { calls++; await held.promise; } }]);
  try {
    await assert.rejects((reader as any).disposeSnapshotWithin('private-native-path', snapshot, 10), RolloutObservationPendingError);
    assert.equal(calls, 1, 'existing resources must retire even when new reads cannot be admitted');
    assert.equal(reader.cacheStats().pendingSnapshotWaits, 65);
    held.resolve(); await Promise.all(originals); await reader.close(); assert.equal(calls, 1);
  } finally { held.resolve(); await Promise.all(originals); await snapshot.dispose(); await reader.close(); }
});

test('failed delivered cleanup remains an original reader failure, not completed execution evidence', async () => {
  const reader = new CodexRolloutReader(), original = Error('private-cleanup'); let calls = 0;
  const snapshot = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close: async () => { calls++; throw original; } }]);
  await assert.rejects((reader as any).disposeSnapshotWithin('private-native-path', snapshot, 1000), (error: unknown) => error === original);
  assert.equal(calls, 1); await assert.rejects(reader.close(), error => error === original);
});

test('reader close drains delivered retirement registered while original reads are closing', async () => {
  const reader = new CodexRolloutReader(), reading = gate(), cleaning = gate(); let closed = false;
  const original = (reader as any).observeWithin('read-path', 1000, () => reading.promise, async () => {});
  const snapshot = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close: () => cleaning.promise }]);
  const close = reader.close(); void close.then(() => { closed = true; });
  await tick();
  const retirement = (reader as any).disposeSnapshotWithin('delivered-path', snapshot, 10);
  try {
    await assert.rejects(retirement, RolloutObservationPendingError);
    reading.resolve(); await original; await tick(); await tick();
    assert.equal(closed, false, 'the first drain snapshot cannot drop a later original retirement');
    cleaning.resolve(); await close;
    assert.equal(reader.cacheStats().pendingSnapshotWaits, 0);
  } finally { reading.resolve(); cleaning.resolve(); await original; await snapshot.dispose(); await close; }
});

test('delivered cleanup logs distinguish observer expiry from actual original settlement without private data', async () => {
  const logs: any[] = [], held = gate();
  const reader = new CodexRolloutReader({ diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))) });
  const snapshot = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close: () => held.promise }]);
  try {
    await assert.rejects(reader.disposeSnapshotWithin('private-native-path', snapshot, 10), RolloutObservationPendingError);
    assert.ok(logs.some(log => log.operation === 'rollout-snapshot-wait' && log.step === 3 && log.timedOut === 1));
    assert.equal(logs.some(log => log.step === 4 && log.settled === 1), false);
    held.resolve(); await reader.close();
    assert.ok(logs.some(log => log.operation === 'rollout-snapshot-wait' && log.step === 4 && log.settled === 1));
    assert.doesNotMatch(JSON.stringify(logs), /private-native-path/);
  } finally { held.resolve(); await snapshot.dispose(); await reader.close(); }
});
