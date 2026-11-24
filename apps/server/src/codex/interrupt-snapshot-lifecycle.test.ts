import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { RolloutProjection } from './rollout-projection.js';
import { RolloutObservationPendingError } from './rollout-reader.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import { RunControlConflict } from '../commands/run-control.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-interrupt-owned-lifecycle-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 20 });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {};
  runtime.setConnection('connection');
  users.codexExecutions.begin(key, 'command', 'connection');
  users.codexExecutions.acknowledge(key, 'command', 'connection', 'tracked', () => {});
  const methods: string[] = [];
  runtime.request = async (method: string) => {
    methods.push(method);
    if (method === 'turn/interrupt') return {};
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    return { thread: { id: 'synthetic', path: 'synthetic-path', turns: [{ id: 'tracked', status: 'interrupted', items: [] }] } };
  };
  runtime.rolloutReader.options.diagnostics = diagnostics;
  let wakes = 0;
  runtime.turnWorker.wake = () => { wakes++; };
  t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  return { codex, runtime, users, key, methods, logs, wakes: () => wakes };
}

test('worker-owned interrupt uses original executor without synchronous SQL authority, settles ACK before cleanup', async t => {
  const f = fixture(t), before = structuredClone(f.users.codexExecutions.get(f.key));
  const sqlRead = f.users.codexExecutions.get.bind(f.users.codexExecutions);
  f.users.codexExecutions.get = () => assert.fail('worker interrupt cannot read main-thread execution SQL');
  f.users.codexExecutions.cleanupRecovered = () => assert.fail('worker interrupt cannot read main-thread cleanup proof');
  f.runtime.options.authorizeTurn = () => assert.fail('worker interrupt cannot use synchronous authorization');
  f.runtime.rolloutReader.readSnapshot = async () => new RolloutProjection([]);
  let acknowledged = false, dispatched = 0, checks = 0;
  await f.codex.interruptOwned({ id: 'intent', receiptId: 'receipt', key: f.key, commandKey: 'stop',
    commandId: 'command', runId: 'tracked', connectionId: 'connection' }, {
    check: async after => { checks++; if (after) assert.equal(acknowledged, true); return { pendingCommandTools: [], cleanupRecovered: true }; },
    dispatched() { dispatched++; }, acknowledged: async () => { assert.equal(f.methods.length, 1); acknowledged = true; },
  });
  assert.equal(dispatched, 1); assert.ok(checks >= 5);
  assert.deepEqual(sqlRead(f.key), before); assert.equal(f.wakes(), 0);
  // Restore before runtime close; shutdown remains owned by the original fixture.
  f.users.codexExecutions.get = sqlRead;
});

test('worker-owned Goal stop keeps a final runtime-local veto after async permission', async t => {
  const f = fixture(t);
  f.runtime.activeTurnIds.set(f.key, 'tracked');
  await assert.rejects(f.codex.interruptOwned({ id: 'intent', receiptId: 'receipt', key: f.key, commandKey: 'stop',
    commandId: null, runId: 'tracked', connectionId: 'connection' }, {
    check: async () => { f.runtime.activeTurnIds.set(f.key, 'successor'); return { pendingCommandTools: [], cleanupRecovered: false }; },
    dispatched() { assert.fail('successor must veto native interrupt'); }, acknowledged: async () => assert.fail('not dispatched'),
  }), RunControlConflict);
  assert.deepEqual(f.methods, []); assert.equal(f.wakes(), 0);
});

for (const stage of ['read', 'proof', 'cleanup'] as const) test(`interrupt bounds original ${stage} without releasing execution or racing its iterator`, async t => {
  const f = fixture(t), before = structuredClone(f.users.codexExecutions.get(f.key));
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let reads = 0, iterators = 0, closes = 0, active = false;
  const snapshot = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0,
    lines: async function* () { iterators++; active = true; try { if (stage === 'proof') await held; } finally { active = false; } },
    close: async () => { assert.equal(active, false, 'timeout must not dispose an active original iterator'); closes++; if (stage === 'cleanup') await held; },
  }]);
  const read = async () => { reads++; if (stage === 'read') await held; return snapshot; };
  f.runtime.readRolloutSnapshot = read;
  f.runtime.rolloutReader.readSnapshot = read;
  let cancelWatchdog = () => {};
  try {
    const original = f.codex.interrupt(f.key, 'tracked', 'actor').then(() => 'success', error => error);
    const result = await Promise.race([original, new Promise<undefined>(done => {
      const watchdog = setTimeout(done, 500); cancelWatchdog = () => clearTimeout(watchdog);
    })]);
    assert.notEqual(result, undefined, 'interrupt must report pending cleanup instead of hanging indefinitely');
    assert.ok(result instanceof RolloutObservationPendingError);
    assert.deepEqual(f.users.codexExecutions.get(f.key), before);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    await assert.rejects(f.runtime.rolloutReader.projectAndDisposeSnapshotWithin('synthetic-path', {}, 20, async () => {}), RolloutObservationPendingError);
    assert.equal(reads, 1, 'pending original proof cannot be replaced');
    if (stage !== 'cleanup') assert.equal(closes, 0);
    release();
    await original;
    await Promise.allSettled([...f.runtime.rolloutReader.snapshotWaits.keys()]);
    assert.equal(closes, 1);
    if (stage === 'read') assert.equal(iterators, 0, 'late snapshot must not start optional proof');
    assert.deepEqual(f.users.codexExecutions.get(f.key), before);
    assert.equal(f.methods.filter(method => method === 'turn/interrupt').length, 1);
    assert.ok(!f.methods.some(method => ['turn/start', 'thread/resume', 'thread/goal/set'].includes(method)));
    assert.ok(f.logs.some(line => JSON.parse(line).operation === 'rollout-snapshot-wait' && JSON.parse(line).timedOut === 1));
    const interruptLog = f.logs.map(line => JSON.parse(line)).find(row => row.operation === 'codex-interrupt-observation');
    assert.equal(interruptLog.step, 6); assert.equal(interruptLog.admitted, 1); assert.equal(interruptLog.unknown, 1);
    assert.doesNotMatch(JSON.stringify(interruptLog), /synthetic-path|tracked|actor|command|turn\/interrupt/);
    f.runtime.rolloutReader.readSnapshot = async () => new RolloutProjection([]);
    await f.runtime.rolloutReader.projectAndDisposeSnapshotWithin('synthetic-path', {}, 1000, async () => 1);
    assert.equal(f.users.codexExecutions.canStart(f.key), false, 'settled observation is not execution release authority');
  } finally { cancelWatchdog(); release(); }
});

test('timely interrupt awaits original cleanup without releasing the execution', async t => {
  const f = fixture(t), before = structuredClone(f.users.codexExecutions.get(f.key));
  f.runtime.options.requestTimeoutMs = 1000;
  let closes = 0;
  f.runtime.rolloutReader.readSnapshot = async () => new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0,
    lines: async function* () {}, close: async () => { closes++; },
  }]);
  await f.codex.interrupt(f.key, 'tracked', 'actor');
  assert.equal(closes, 1);
  assert.deepEqual(f.users.codexExecutions.get(f.key), before);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  const interruptLog = f.logs.map(line => JSON.parse(line)).find(row => row.operation === 'codex-interrupt-observation');
  assert.equal(interruptLog.step, 7); assert.equal(interruptLog.admitted, 1); assert.equal(interruptLog.unknown, 0);
});

test('interrupt records native ACK before a post-ACK authority change, without releasing execution', async t => {
  const f = fixture(t);
  let acknowledgements = 0;
  await assert.rejects(f.codex.interrupt(f.key, 'tracked', 'actor', undefined, () => {
    acknowledgements++;
    assert.deepEqual(f.methods, ['turn/interrupt']);
    f.runtime.options.authorizeTurn = () => false;
  }), TurnAuthorizationError);
  assert.equal(acknowledgements, 1);
  assert.deepEqual(f.methods, ['turn/interrupt']);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
});

for (const change of ['revocation', 'connection', 'successor'] as const) test(`interrupt rechecks original authority after cleanup (${change})`, async t => {
  const f = fixture(t);
  f.runtime.options.requestTimeoutMs = 1000;
  let entered!: () => void, release!: () => void;
  const cleaning = new Promise<void>(done => { entered = done; });
  const held = new Promise<void>(done => { release = done; });
  f.runtime.rolloutReader.readSnapshot = async () => new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0,
    lines: async function* () {}, close: async () => { entered(); await held; },
  }]);
  const result = f.codex.interrupt(f.key, 'tracked', 'actor');
  const rejected = assert.rejects(result, change === 'revocation' ? TurnAuthorizationError : RunControlConflict);
  try {
    await cleaning;
    if (change === 'revocation') f.runtime.options.authorizeTurn = () => false;
    else if (change === 'connection') f.runtime.setConnection('replacement');
    else {
      f.users.codexExecutions.observe(f.key, 'connection', 'tracked', 'interrupted');
      f.users.codexExecutions.invalidateNativeHistory(f.key, 'changed');
    }
    const afterChange = structuredClone(f.users.codexExecutions.get(f.key));
    release();
    await rejected;
    assert.deepEqual(f.users.codexExecutions.get(f.key), afterChange);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.equal(f.methods.filter(method => method === 'turn/interrupt').length, 1);
  } finally { release(); }
});
