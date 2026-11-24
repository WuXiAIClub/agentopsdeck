import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { createHistoryPreparation } from '../refresh/history-preparation.js';

function fixture(t: test.TestContext, phase: 'completed' | 'failed' | 'running' | 'restarted' = 'completed') {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-successor-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {};
  runtime.setConnection('connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'unknown',
    runtime: { turnId: 'tracked', phase: 'completed', connection: 'connected', sync: 'syncing', lastEventAt: 1 } });
  users.codexExecutions.begin(key, 'command', 'connection');
  users.codexExecutions.acknowledge(key, 'command', 'connection', 'tracked', () => {});
  if (phase === 'completed' || phase === 'failed') users.codexExecutions.observe(key, 'connection', 'tracked', phase);
  if (phase === 'restarted') users.codexExecutions.recoverInterrupted();
  const turns: any[] = ['tracked', 'successor-1', 'successor-2'].map(id => ({
    id, status: id === 'tracked' && phase === 'failed' ? 'failed' : 'completed', itemsView: 'full', items: [{ id: `reply-${id}`, type: 'agentMessage', text: `Reply ${id}` }],
  }));
  const thread = { id: 'synthetic', status: { type: 'idle' }, turns };
  const methods: string[] = [];
  runtime.request = async (method: string) => {
    methods.push(method);
    // Older/unknown native goal capability must fail closed, not impersonate
    // a native runtime that proved there is no continuing goal.
    if (method === 'thread/goal/get') return {};
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'History must not resume, send, cancel or start native work');
    return { thread };
  };
  let wakes = 0;
  runtime.turnWorker.wake = () => { wakes++; };
  t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  return { codex, runtime, key, users, store, thread, methods, wakes: () => wakes,
    reconcile: () => runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'tracked', phase === 'failed' ? 'failed' : 'completed') };
}

test('worker finalization projects an already completed syncing turn only once', async testContext => {
  const fixtureResult = fixture(testContext);
  fixtureResult.thread.turns.splice(1);
  fixtureResult.runtime.loadedThreadIds.add('synthetic');
  let snapshots = 0;
  const readSnapshot = fixtureResult.runtime.rolloutReader.readSnapshot.bind(fixtureResult.runtime.rolloutReader);
  fixtureResult.runtime.rolloutReader.readSnapshot = async (...args: unknown[]) => {
    snapshots++;
    return readSnapshot(...args);
  };
  await fixtureResult.runtime.turnWorker.options.reconcile(fixtureResult.key);
  assert.equal(snapshots, 1, 'Final reconciliation owns the projection; an earlier full hydration is redundant');
  assert.equal(fixtureResult.users.codexExecutions.get(fixtureResult.key)?.sync, 'current');
  assert.equal(fixtureResult.codex.isSessionHistoryReady(fixtureResult.key), true);
  assert.ok(fixtureResult.store.getMessages(fixtureResult.key).some(message => message.text === 'Reply tracked'));
});

for (const change of ['connection', 'closed', 'unavailable', 'projection'] as const) {
  test(`original final reconciliation refuses stale async storage publication (${change})`, async t => {
    const f = fixture(t);
    f.store.addMessage({ id: 'live', sessionKey: f.key, role: 'assistant', text: 'Keep live', createdAt: 1 });
    const before = f.store.getMessages(f.key), queue = f.users.turns.list('codex', f.key);
    let reads = 0;
    f.runtime.options.historyReader = { close: async () => {}, prepare: async (key: string, messages: any[]) => {
      const plan = f.runtime.prepareHistorySync(key, messages);
      await Promise.resolve(); reads++;
      assert.deepEqual(f.store.getMessages(f.key), before);
      if (change === 'connection') f.runtime.setConnection('replacement');
      if (change === 'closed') f.runtime.closed = true;
      if (change === 'unavailable') f.runtime.executionUnavailable = true;
      if (change === 'projection') f.runtime.touchProjection(f.key);
      return plan;
    } };
    f.reconcile(); await f.runtime.completingTurns.get(f.key);
    assert.ok(reads > 0);
    assert.deepEqual(f.store.getMessages(f.key), before);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.wakes(), 0);
    assert.ok(!f.methods.some(method => ['turn/start', 'thread/resume', 'thread/rollback'].includes(method)));
    assert.notEqual(f.users.codexExecutions.get(f.key)?.sync, 'current');
  });
}

test('final native goal verification shares the thread read budget and stays protected on exhaustion', async t => {
  const f = fixture(t);
  f.runtime.options.requestTimeoutMs = 100;
  const request = f.runtime.request;
  const budgets: number[] = [];
  f.runtime.request = async (method: string, params: unknown, timeout?: number) => {
    budgets.push(timeout!);
    if (method === 'thread/goal/get') {
      assert.ok(timeout! < 100, 'goal verification must use the remaining budget');
      await new Promise(resolve => setTimeout(resolve, timeout! + 5));
      throw Error('synthetic timeout');
    }
    return request(method, params);
  };
  f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  assert.ok(budgets.length >= 2);
  assert.ok(budgets.every(ms => ms > 0 && ms <= 100));
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-unknown');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true, 'complete history remains readable with execution fenced');
});

test('async reader joining worker hydration waits for the successor reconciliation handoff', async t => {
  const f = fixture(t);
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = f.runtime.request;
  let reads = 0;
  f.runtime.request = async (method: string) => {
    if (++reads === 1) { entered(); await held; }
    return request(method);
  };
  const worker = f.runtime.turnWorker.options.reconcile(f.key);
  await started;
  const prepare = createHistoryPreparation({ waitMs: 1000 });
  const read = () => f.codex.refreshSession(f.key, { readOnly: true, maxAgeMs: 1500 });
  const ready = () => f.codex.isSessionHistoryReady(f.key);
  const browser = prepare(f.key, read, ready, new AbortController().signal);
  release();
  try {
    const outcome = await browser;
    assert.equal(outcome, 'pending', 'Worker started finalization after hydration: this is preparation, not ready or failed');
    await worker;
    assert.equal(await prepare(f.key, read, ready, new AbortController().signal), 'ready');
    assert.equal(ready(), true);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
    assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-unknown');
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
  } finally { release(); await worker; }
});

for (const status of ['idle', 'notLoaded']) test(`completed native successors remain readable without execution clearance (${status})`, async t => {
  const f = fixture(t);
  f.thread.status.type = status;
  f.users.turns.enqueue('codex', { id: 'pending', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Keep waiting', images: [] } });
  f.reconcile();
  // Browser history joins finalization, including the first failed terminal sync.
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.deepEqual(f.store.getMessages(f.key).filter(m => m.role === 'assistant').map(m => m.turnId),
    ['tracked', 'successor-1', 'successor-2']);
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.store.getSession(f.key)?.runtime?.turnId, 'tracked');
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.equal(f.store.getSession(f.key)?.runtime?.executionProtection?.reason, 'goal-unknown');
  assert.equal(f.wakes(), 0);
  assert.deepEqual(f.methods, ['thread/read', ...(status === 'idle' ? ['thread/backgroundTerminals/list'] : []), 'thread/goal/get']);
  // Repeated recovery must not turn readable history into a successful execution.
  f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
  assert.deepEqual(f.users.turns.list('codex', f.key).map(entry => [entry.id, entry.state]), [['pending', 'queued']]);
});

test('the exact latest terminal still reconciles normally', async t => {
  const f = fixture(t);
  f.thread.turns.splice(1);
  f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.wakes(), 1);
});

test('unrelated old tool projections do not block the tracked terminal and its successors', async t => {
  const f = fixture(t);
  f.thread.turns.unshift({ id: 'old', status: 'completed', itemsView: 'full', items: [
    { id: 'old-tool', type: 'mcpToolCall', status: 'inProgress', server: 'synthetic', tool: 'test' },
  ] });
  f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
});

test('connection replacement during successor projection cannot publish history or clear execution', async t => {
  const f = fixture(t);
  f.runtime.options.projectAssistant = async (text: string) => {
    f.runtime.setConnection('replacement');
    return { text, media: [] };
  };
  f.reconcile();
  await assert.rejects(f.codex.refreshSession(f.key, { readOnly: true }), /final history unavailable/);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.store.getMessages(f.key).length, 0);
  assert.equal(f.wakes(), 0);
});

for (const timing of ['joining', 'already-readable', 'unreconciled']) test(`maintenance reads successor history without clearing execution protection (${timing})`, async t => {
  const f = fixture(t);
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  if (timing !== 'unreconciled') f.reconcile();
  if (timing === 'already-readable') await f.codex.refreshSession(f.key, { readOnly: true });
  await f.codex.recoverMaintenanceHistory(f.key, () => {});
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-unknown');
  assert.equal(f.wakes(), 0);
  assert.equal(f.runtime.rolloutlessHistoryRecovered.has(f.key), false);
});

test('maintenance preserves a blocked native goal and every queued message while making history readable', async t => {
  const f = fixture(t), request = f.runtime.request;
  f.runtime.request = async (method: string) => method === 'thread/goal/get'
    ? { goal: { threadId: 'synthetic', status: 'blocked', createdAt: 1, updatedAt: 2,
      objective: 'Task', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } } : request(method);
  for (const id of ['first', 'second']) f.users.turns.enqueue('codex', {
    id, sessionKey: f.key, createdAt: 5, payload: { text: 'Preserved private input', images: [] },
  });
  const queue = f.users.turns.list('codex', f.key);
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  for (let round = 0; round < 2; round++) {
    await f.codex.recoverMaintenanceHistory(f.key, () => {});
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
    assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-blocked');
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.runtime.rolloutlessHistoryRecovered.has(f.key), false);
  }
  assert.equal(f.wakes(), 0);
});

for (const race of ['goal-notification', 'authority-revoked', 'connection-changed'] as const) {
  test(`maintenance resume ${race} preserves owned identity and never repeats native resume`, async t => {
    const f = fixture(t), originalRequest = f.runtime.request;
    f.thread.turns.splice(1);
    f.thread.status.type = 'notLoaded';
    let resumed = false, authorized = true;
    f.users.turns.enqueue('codex', { id: 'preserved', sessionKey: f.key, createdAt: 1,
      payload: { text: 'Do not resend', images: [] } });
    const queue = f.users.turns.list('codex', f.key);
    const before = f.users.codexExecutions.get(f.key)!;
    f.runtime.request = async (method: string) => {
      if (method !== 'thread/resume') return originalRequest(method);
      assert.equal(resumed, false);
      resumed = true;
      f.thread.status.type = 'idle';
      f.runtime.handleNotification('thread/goal/cleared', { threadId: 'synthetic' });
      if (race === 'authority-revoked') authorized = false;
      if (race === 'connection-changed') f.runtime.setConnection('replacement');
      return { thread: f.thread };
    };
    const recover = () => f.codex.recoverMaintenanceHistory(f.key, () => {
      if (!authorized) throw new Error('maintenance authority revoked');
    });
    if (race === 'goal-notification') {
      await recover();
      assert.equal(f.codex.isSessionHistoryReady(f.key), true);
      assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
      assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-unknown');
    } else await assert.rejects(recover());
    const after = f.users.codexExecutions.get(f.key)!;
    for (const field of ['commandId', 'connectionId', 'runId', 'phase'] as const) assert.equal(after[field], before[field]);
    assert.equal(resumed, true);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.runtime.rolloutlessHistoryRecovered.has(f.key), false);
  });
}

test('revoked maintenance authority after native head observation cannot reconcile or clear protection', async t => {
  const f = fixture(t);
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  const before = f.users.codexExecutions.get(f.key);
  let authorized = true;
  const request = f.runtime.request;
  f.runtime.request = async (method: string) => {
    const result = await request(method);
    if (method === 'thread/read') authorized = false;
    return result;
  };
  await assert.rejects(f.codex.recoverMaintenanceHistory(f.key, () => {
    if (!authorized) throw new Error('maintenance authority revoked');
  }), /authority revoked/);
  assert.deepEqual(f.users.codexExecutions.get(f.key), before);
  assert.deepEqual(f.methods, ['thread/read']);
  assert.equal(f.wakes(), 0);
});

for (const fault of ['missing-tracked', 'wrong-outcome', 'partial', 'duplicate', 'running-successor',
  'unknown-successor', 'missing-live-reply', 'unfinished-tool'] as const) {
  test(`successor history rejects ${fault} without releasing execution`, async t => {
    const f = fixture(t);
    switch (fault) {
      case 'missing-tracked': f.thread.turns.shift(); break;
      case 'wrong-outcome': f.thread.turns[0].status = 'interrupted'; break;
      case 'partial': f.thread.turns[1].itemsView = 'partial'; break;
      case 'duplicate': f.thread.turns[1].items[0].id = 'reply-tracked'; break;
      case 'running-successor': f.thread.turns[1].status = 'inProgress'; break;
      case 'unknown-successor': f.thread.turns[1].status = 'unknown'; break;
      case 'missing-live-reply': f.store.addMessage({ id: `${f.key}:codex-live`, sessionKey: f.key,
        turnId: 'tracked', role: 'assistant', status: 'sent', text: 'Already delivered', createdAt: 1 }); break;
      case 'unfinished-tool': f.thread.turns[1].items.push({ id: 'tool', type: 'mcpToolCall', status: 'inProgress', server: 'synthetic', tool: 'test' }); break;
    }
    f.reconcile();
    await assert.rejects(f.codex.refreshSession(f.key, { readOnly: true }), /final history unavailable/);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.ok(!f.store.getMessages(f.key).some(m => m.turnId === 'successor-1'));
  });
}

test('active native thread does not invalidate a complete old terminal transcript or release its protection', async t => {
  const f = fixture(t);
  f.thread.status.type = 'active';
  f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-unknown');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
});

function verifiedFixture(t: test.TestContext, phase: 'completed' | 'failed' | 'running' | 'restarted' = 'completed') {
  const f = fixture(t, phase);
  (f.thread as any).canAcceptDirectInput = true;
  let goal: any = null;
  const terminals: any[] = [];
  f.runtime.request = async (method: string) => {
    f.methods.push(method);
    if (method === 'thread/read') return { thread: structuredClone(f.thread) };
    if (method === 'thread/goal/get') return { goal: structuredClone(goal) };
    if (method === 'thread/backgroundTerminals/list') return { data: structuredClone(terminals), nextCursor: null };
    throw new Error(`Unexpected mutating RPC: ${method}`);
  };
  return { ...f, terminals, setGoal: (status: string | null) => { goal = status === null ? null
    : { threadId: 'synthetic', status, createdAt: 1, updatedAt: 2, objective: 'PRIVATE MUST NOT PERSIST',
      tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 }; } };
}

function compactedToolRollout(f: ReturnType<typeof verifiedFixture>, options: {
  name?: string; compactTurn?: string; afterBoundary?: boolean; output?: boolean; compact?: boolean;
} = {}) {
  const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: '2026-10-25T13:45:50Z', payload });
  const start = record('event_msg', { type: 'task_started', turn_id: 'tracked' });
  const call = record('response_item', { type: 'function_call', name: options.name ?? 'update_plan',
    call_id: 'orphan', arguments: '{"plan":[]}' });
  const boundary = [...(options.compactTurn ? [record('turn_context', { turn_id: options.compactTurn })] : []),
    ...(options.compact === false ? [] : [record('compacted', { message: 'Compacted' })])];
  const lines = [start, ...(options.afterBoundary ? [...boundary, call] : [call, ...boundary]),
    ...(options.output ? [record('response_item', { type: 'function_call_output', call_id: 'orphan', output: 'Actual output' })] : [])];
  const file = join(f.runtime.options.defaultCwd, 'compacted-tools.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  (f.thread as any).path = file;
}

for (const name of ['update_plan', 'functions.exec', 'unknown_custom_tool']) {
  test(`completed compacted rollout call preserves unknown result without blocking original queue (${name})`, async t => {
    const f = verifiedFixture(t); f.setGoal('complete');
    compactedToolRollout(f, { name });
    f.users.turns.enqueue('codex', { id: 'original-input', sessionKey: f.key, createdAt: 5,
      payload: { text: 'Original queued input', images: [] } });
    const queue = f.users.turns.list('codex', f.key);
    f.reconcile();
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
    assert.deepEqual(f.users.turns.list('codex', f.key), queue, 'no replay, removal or replacement');
    const orphan = f.store.getMessages(f.key).find(m => m.toolCallId === 'orphan');
    assert.equal(orphan?.status, 'failed');
    assert.equal(orphan?.toolName, name);
    assert.match(orphan?.failureReason ?? '', /Result unavailable; side effects are unknown/);
    assert.ok(!f.store.getMessages(f.key).some(m => m.toolCallId === 'orphan' && m.toolPhase === 'result'));
    await f.codex.refreshSession(f.key, { readOnly: true });
    assert.equal(f.store.getMessages(f.key).find(m => m.id === orphan?.id)?.status, 'failed', 'refresh must not resurrect sending');
    assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
  });
}

for (const fault of ['no-compaction', 'later-call', 'other-turn', 'no-reply', 'running-turn', 'native-running-tool', 'background-terminal', 'active-goal'] as const) {
  test(`compacted transcript does not bypass independent execution evidence (${fault})`, async t => {
    const f = verifiedFixture(t); f.setGoal('complete');
    compactedToolRollout(f, { compact: fault !== 'no-compaction', afterBoundary: fault === 'later-call',
      ...(fault === 'other-turn' ? { compactTurn: 'successor-1' } : {}) });
    if (fault === 'no-reply') f.thread.turns[0].items = [];
    if (fault === 'running-turn') f.thread.turns[0].status = 'inProgress';
    if (fault === 'native-running-tool') f.thread.turns[0].items.push({ id: 'orphan', type: 'mcpToolCall',
      status: 'inProgress', server: 'synthetic', tool: 'test' });
    if (fault === 'background-terminal') f.terminals.push({ processId: 'actual-process', itemId: 'actual-command' });
    if (fault === 'active-goal') f.setGoal('active');
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.ok(!f.methods.includes('thread/backgroundTerminals/terminate'));
  });
}

test('failed compacted rollout without a final reply preserves failure and unknown tool effects', async t => {
  const f = verifiedFixture(t, 'failed'); f.setGoal('complete');
  f.thread.turns.splice(1);
  f.thread.turns[0].items = [];
  f.users.codexExecutions.settleNativeHistory(f.users.codexExecutions.get(f.key)!, {
    turnId: 'tracked', fingerprint: '0'.repeat(64), connectionId: 'connection', state: 'blocked', reason: 'native-unavailable',
  });
  compactedToolRollout(f, { name: 'exec_command' });
  f.users.turns.enqueue('codex', { id: 'original-input', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Original queued input', images: [] } });
  const queue = f.users.turns.list('codex', f.key);
  f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'failed');
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, 'verified');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.turnId, 'tracked');
  assert.deepEqual(f.users.turns.list('codex', f.key), queue);
  const orphan = f.store.getMessages(f.key).find(message => message.toolCallId === 'orphan');
  assert.equal(orphan?.status, 'failed');
  assert.match(orphan?.failureReason ?? '', /Result unavailable; side effects are unknown/);
  assert.ok(!f.store.getMessages(f.key).some(message => message.toolPhase === 'result'
    || message.role === 'assistant' && message.turnId === 'tracked' && message.status !== 'failed'));
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.store.getMessages(f.key).find(message => message.id === orphan?.id)?.status, 'failed');
  assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
});

for (const fault of ['no-compaction', 'later-call', 'other-turn', 'native-running-tool', 'background-terminal', 'active-goal', 'native-active', 'input-unavailable'] as const) {
  test(`failed compacted transcript retains independent execution protection (${fault})`, async t => {
    const f = verifiedFixture(t, 'failed'); f.setGoal('complete');
    f.thread.turns[0].items = [];
    compactedToolRollout(f, { name: 'exec_command', compact: fault !== 'no-compaction', afterBoundary: fault === 'later-call',
      ...(fault === 'other-turn' ? { compactTurn: 'successor-1' } : {}) });
    if (fault === 'native-running-tool') f.thread.turns[0].items.push({ id: 'orphan', type: 'mcpToolCall',
      status: 'inProgress', server: 'synthetic', tool: 'test' });
    if (fault === 'background-terminal') f.terminals.push({ processId: 'actual-process', itemId: 'actual-command' });
    if (fault === 'active-goal') f.setGoal('active');
    if (fault === 'native-active') f.thread.status.type = 'active';
    if (fault === 'input-unavailable') (f.thread as any).canAcceptDirectInput = false;
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
  });
}

test('late real output after compaction takes precedence over missing-output marker', async t => {
  const f = verifiedFixture(t); f.setGoal('complete');
  compactedToolRollout(f, { output: true });
  await f.runtime.turnWorker.options.reconcile(f.key);
  const messages = f.store.getMessages(f.key).filter(m => m.toolCallId === 'orphan');
  assert.equal(messages.length, 2);
  assert.ok(messages.every(m => m.status === 'sent' && !m.failureReason));
  assert.match(messages.find(m => m.toolPhase === 'result')?.text ?? '', /Actual output/);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
});

for (const phase of ['running', 'restarted'] as const) {
  test(`lost completion retains an unfinished draft while recovering its original execution (${phase})`, async t => {
    const f = verifiedFixture(t, phase);
    f.setGoal('complete');
    f.store.addMessage({ id: `${f.key}:codex-orphan`, sessionKey: f.key, turnId: 'tracked',
      role: 'assistant', text: 'Abandoned stream draft', createdAt: 1 });
    f.users.turns.enqueue('codex', { id: 'original-input', sessionKey: f.key, createdAt: 5,
      payload: { text: 'Original queued input', images: [] } });
    const queue = f.users.turns.list('codex', f.key);
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    const draft = f.store.getMessages(f.key).find(message => message.id.endsWith(':codex-orphan'));
    assert.equal(draft?.text, 'Abandoned stream draft');
    assert.equal(draft?.status, 'failed');
    assert.match(draft?.failureReason ?? '', /partial text preserved/);
    assert.ok(!f.methods.includes('turn/start'));
  });
}

for (const phase of ['completed', 'failed', 'restarted'] as const) {
  test(`cold owned ${phase} transcript loads without resuming or settling its execution`, async t => {
    const f = verifiedFixture(t, phase);
    f.thread.turns.splice(1);
    f.thread.status.type = 'notLoaded';
    f.setGoal('active');
    const file = join(f.runtime.options.defaultCwd, 'cold-rollout.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
    (f.thread as any).path = file;
    f.users.turns.enqueue('codex', { id: 'preserve-cold-input', sessionKey: f.key, createdAt: 5,
      payload: { text: 'Never replay from a history read', images: [] } });
    const execution = structuredClone(f.users.codexExecutions.get(f.key));
    const queue = f.users.turns.list('codex', f.key);
    assert.equal(f.store.getMessages(f.key).length, 0, 'no warm projection may hide this regression');
    await f.codex.refreshSession(f.key, { readOnly: true });
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Reply tracked'));
    const display = await f.codex.prepareSessionDisplay(f.key);
    assert.ok(display);
    assert.equal(await display.verify(), true);
    assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get'].includes(method)),
      'display must not resume native work or enumerate terminals on an unloaded thread');
  });
}

for (const phase of ['completed', 'failed', 'restarted'] as const) {
  for (const settlement of ['syncing', 'error'] as const) {
   for (const nativeState of ['notLoaded', 'idle'] as const) {
    test(`display survives drained completion owner (${phase}, ${settlement}, ${nativeState})`, async t => {
      const f = verifiedFixture(t, phase);
      f.thread.turns.splice(1); f.thread.status.type = nativeState; f.setGoal('active');
      const file = join(f.runtime.options.defaultCwd, 'completion-handoff.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
      (f.thread as any).path = file;
      f.users.turns.enqueue('codex', { id: 'original-pending', sessionKey: f.key, createdAt: 5,
        payload: { text: 'Never dispatch from display', images: [] } });
      let release!: () => void;
      const completion = new Promise<void>(resolve => { release = resolve; }).then(() => {
        if (settlement === 'error') f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
        f.runtime.completingTurns.delete(f.key);
      });
      f.runtime.completingTurns.set(f.key, completion);
      const browser = f.codex.refreshSession(f.key, { readOnly: true });
      // Let the browser actually join the old owner; no negative cache or warm
      // projection may bypass this lifecycle boundary.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.methods.length, 0);
      release(); await completion;
      const execution = structuredClone(f.users.codexExecutions.get(f.key));
      const queue = f.users.turns.list('codex', f.key);
      await browser;
      assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Reply tracked'));
      const display = await f.codex.prepareSessionDisplay(f.key);
      assert.ok(display); assert.equal(await display.verify(), true);
      assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
      assert.deepEqual(f.users.turns.list('codex', f.key), queue);
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
      assert.equal(f.wakes(), 0);
      assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get'].includes(method)));
    });
   }
  }
}

for (const nativeState of ['idle', 'notLoaded', 'active'] as const) {
  test(`drained completion display preserves successor ownership (${nativeState})`, async t => {
    const f = verifiedFixture(t);
    f.thread.status.type = nativeState; f.setGoal('active');
    if (nativeState === 'active') f.thread.turns.at(-1)!.status = 'inProgress';
    const file = join(f.runtime.options.defaultCwd, 'successor-handoff.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
    (f.thread as any).path = file;
    f.users.turns.enqueue('codex', { id: 'original-successor-input', sessionKey: f.key, createdAt: 5,
      payload: { text: 'Never transfer ownership to a successor', images: [] } });
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; }).then(() => {
      f.runtime.completingTurns.delete(f.key);
    });
    f.runtime.completingTurns.set(f.key, completion);
    const browser = f.codex.refreshSession(f.key, { readOnly: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.methods.length, 0);
    const execution = structuredClone(f.users.codexExecutions.get(f.key));
    const queue = f.users.turns.list('codex', f.key);
    release(); await completion; await browser;
    for (const turnId of ['tracked', 'successor-1', 'successor-2'])
      assert.ok(f.store.getMessages(f.key).some(message => message.text === `Reply ${turnId}`));
    const display = await f.codex.prepareSessionDisplay(f.key);
    if (nativeState === 'active') {
      assert.equal(display, undefined, 'an in-progress native head is not an immutable terminal display proof');
    } else {
      assert.ok(display); assert.equal(await display.verify(), true);
    }
    assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get'].includes(method)));
  });
}

for (const changed of ['connection', 'generation', 'unavailable', 'deleted', 'unknown-delivery', 'command', 'run', 'not-readonly'] as const) {
  test(`completion handoff does not grant stale display authority (${changed})`, async t => {
    const f = verifiedFixture(t);
    const execution = structuredClone(f.users.codexExecutions.get(f.key));
    const queue = f.users.turns.list('codex', f.key);
    let release!: () => void, drained = false;
    const completion = new Promise<void>(resolve => { release = resolve; }).then(() => {
      drained = true; f.runtime.completingTurns.delete(f.key);
      if (changed === 'connection') f.runtime.connectionId = 'replaced';
      if (changed === 'generation') f.runtime.nativeConnectionGeneration++;
      if (changed === 'unavailable') f.runtime.executionUnavailable = true;
    });
    const read = f.runtime.readHistoryFact.bind(f.runtime);
    f.runtime.readHistoryFact = async (key: string) => {
      const fact = await read(key);
      if (!drained) return fact;
      if (changed === 'deleted') return { ...fact, deleted: true };
      if (changed === 'unknown-delivery') return { ...fact, outcomeUnknown: true };
      if (changed === 'command' || changed === 'run') return { ...fact, execution: { ...fact.execution,
        [changed === 'command' ? 'commandId' : 'runId']: 'replacement' } };
      return fact;
    };
    f.runtime.completingTurns.set(f.key, completion);
    const browser = f.codex.refreshSession(f.key, { readOnly: changed !== 'not-readonly' });
    const rejected = assert.rejects(browser, /Codex final history unavailable/);
    await new Promise<void>(resolve => setImmediate(resolve));
    release(); await rejected;
    assert.equal(f.methods.length, 0);
    assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.wakes(), 0);
  });
}

test('cold browser history joining failed worker recovery obtains independent text without repeating resume', async t => {
  const f = verifiedFixture(t);
  f.thread.turns.splice(1); f.thread.status.type = 'notLoaded';
  const file = join(f.runtime.options.defaultCwd, 'cold-joined.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
  (f.thread as any).path = file;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const request = f.runtime.request;
  let first = true;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/read' && first) { first = false; entered(); await held; }
    return request(method);
  };
  const execution = structuredClone(f.users.codexExecutions.get(f.key));
  const worker = f.codex.refreshSession(f.key);
  const rejected = assert.rejects(worker, /Unexpected mutating RPC: thread\/resume/);
  await started;
  const browser = f.codex.refreshSession(f.key, { readOnly: true, maxAgeMs: 1500 });
  const secondBrowser = f.codex.refreshSession(f.key, { readOnly: true, maxAgeMs: 1500 });
  release();
  await rejected; await Promise.all([browser, secondBrowser]);
  assert.ok(f.store.getMessages(f.key).length > 0);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(f.methods.filter(method => method === 'thread/read').length, 2,
    'concurrent browser waiters share one replacement snapshot after the failed worker');
  assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
});

for (const exhausted of [false, true]) test(`blocked Goal terminal reproof retains supplied native read authority (${exhausted ? 'expired' : 'current'})`, async t => {
  const f = verifiedFixture(t);
  f.setGoal('blocked');
  const authoritativeRead = f.runtime.request;
  const before = structuredClone(f.users.codexExecutions.get(f.key));
  let fallbackCalls = 0, terminalReads = 0, disposed = 0;
  f.runtime.request = async () => { fallbackCalls++; throw Error('must not bypass supplied read authority'); };
  f.runtime.rolloutReader.readSnapshot = async () => ({ dispose: async () => { disposed++; } });
  const read = async (method: string, params: unknown, timeoutMs?: number) => {
    if (method === 'thread/backgroundTerminals/list') {
      terminalReads++;
      if (exhausted) throw Error('original read budget exhausted');
    }
    return authoritativeRead(method, params, timeoutMs);
  };
  const result = await f.runtime.inspectNativeHistory(f.thread, f.users.codexExecutions.get(f.key), () => {}, false, true, read);
  assert.equal(fallbackCalls, 0, 'terminal cleanup must not create a fresh unrestricted native request');
  assert.equal(result.state, exhausted ? 'blocked' : 'verified');
  assert.equal(result.reason, exhausted ? 'cleanup-unconfirmed' : 'settled');
  assert.equal(terminalReads, exhausted ? 1 : 2, 'one thread-scoped cleanup observation and one independent final observation');
  assert.equal(disposed, 1, 'the original delivered snapshot retains one cleanup owner');
  assert.deepEqual(f.users.codexExecutions.get(f.key), before, 'a read-only proof cannot release or replace the original execution');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
  assert.ok(!f.methods.some(method => ['turn/start', 'thread/resume', 'thread/backgroundTerminals/terminate', 'thread/goal/set'].includes(method)));
});

for (const position of [32, 64]) for (const output of ['missing', 'aborted', 'completed'] as const) {
  test(`long blocked Goal cleanup checks each interrupted successor (${position}, ${output})`, async t => {
    const f = verifiedFixture(t);
    f.setGoal('blocked');
    f.thread.turns = Array.from({ length: 65 }, (_, index) => ({
      id: index === 0 ? 'tracked' : `successor-${index}`,
      status: index === position ? 'interrupted' : 'completed', itemsView: 'full',
      items: [{ id: `reply-${index}`, type: 'agentMessage', text: `Reply ${index}` }],
    }));
    const rows = [
      { type: 'turn_context', payload: { turn_id: `successor-${position}` } },
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec', call_id: 'original-exec' } },
      ...(output === 'missing' ? [] : [{ type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'original-exec', output: output === 'aborted' ? 'aborted by user' : 'finished',
      } }]),
    ].map(row => JSON.stringify(row));
    let disposed = 0, scanned = 0;
    f.runtime.rolloutReader.readSnapshot = async () => ({
      async *[Symbol.asyncIterator]() { scanned++; yield* rows; },
      dispose: async () => { disposed++; },
    });
    const before = structuredClone(f.users.codexExecutions.get(f.key));
    const result = await f.runtime.inspectNativeHistory(f.thread, f.users.codexExecutions.get(f.key),
      () => {}, false, true, f.runtime.request);
    assert.equal(result.state, output === 'completed' ? 'verified' : 'blocked');
    assert.equal(result.reason, output === 'completed' ? 'settled' : 'cleanup-unconfirmed');
    assert.equal(scanned, 1, 'interrupted successor must inspect its own original dispatch evidence');
    assert.equal(disposed, 1, 'one original snapshot cleanup owner');
    assert.equal(f.methods.filter(method => method === 'thread/backgroundTerminals/list').length,
      output === 'completed' ? 2 : 1, 'one batch list; successful cleanup also needs an independent final list');
    assert.deepEqual(f.users.codexExecutions.get(f.key), before, 'read-only proof must not mutate original execution');
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
  });
}

for (const stage of ['read', 'proof', 'cleanup'] as const) test(`blocked Goal inspector bounds the original ${stage} wait without releasing execution`, async t => {
  const f = verifiedFixture(t); f.setGoal('blocked'); f.runtime.options.requestTimeoutMs = 15;
  const before = structuredClone(f.users.codexExecutions.get(f.key));
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let reads = 0, proofs = 0, closes = 0;
  const snapshot = { dispose: async () => { closes++; if (stage === 'cleanup') await held; } };
  const read = async () => { reads++; if (stage === 'read') await held; return snapshot; };
  f.runtime.readRolloutSnapshot = read;
  f.runtime.rolloutReader.readSnapshot = read;
  f.runtime.requireBackgroundTerminalsDrained = async (_thread: unknown, _turn: unknown, check: () => void) => {
    proofs++; if (stage === 'proof') await held; check();
  };
  let cancelWatchdog = () => {};
  try {
    const inspect = () => f.runtime.inspectNativeHistory(f.thread, f.users.codexExecutions.get(f.key), () => {}, false, true, f.runtime.request);
    const result = await Promise.race([inspect(), new Promise<undefined>(done => {
      const watchdog = setTimeout(done, 250); cancelWatchdog = () => clearTimeout(watchdog);
    })]);
    assert.notEqual(result, undefined, 'native inspector must return a bounded blocked checkpoint, not hang');
    assert.equal(result.state, 'blocked'); assert.equal(result.reason, 'cleanup-unconfirmed');
    const retry = await inspect(); assert.equal(retry.reason, 'cleanup-unconfirmed');
    assert.equal(reads, 1, 'an expired original must prevent a replacement terminal proof');
    assert.deepEqual(f.users.codexExecutions.get(f.key), before);
    assert.equal(f.users.codexExecutions.canStart(f.key), false); assert.equal(f.wakes(), 0);
    const proofCount = proofs; release();
    await Promise.allSettled([...f.runtime.rolloutReader.snapshotWaits.keys()]);
    assert.equal(proofs, proofCount, 'expired proof must not continue onto successor turns');
    assert.equal(closes, 1); assert.deepEqual(f.users.codexExecutions.get(f.key), before);
    const recovered = await inspect(); assert.equal(recovered.state, 'verified'); assert.equal(reads, 2); assert.equal(closes, 2);
    assert.ok(!f.methods.some(method => ['turn/start', 'thread/resume', 'thread/backgroundTerminals/terminate', 'thread/goal/set'].includes(method)));
  } finally { cancelWatchdog(); release(); }
});

function failedColdFixture(t: test.TestContext, phase: 'completed' | 'failed' = 'failed') {
  const f = verifiedFixture(t, phase);
  f.thread.turns.splice(1);
  f.thread.status.type = 'notLoaded';
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  f.runtime.rolloutReader.validate = async () => {};
  const request = f.runtime.request;
  f.runtime.request = async (method: string, params: unknown) => {
    if (method === 'thread/resume') {
      f.methods.push(method);
      f.thread.status.type = 'idle';
      return { thread: structuredClone(f.thread) };
    }
    if (method === 'thread/backgroundTerminals/list' && f.thread.status.type === 'notLoaded') throw Error('thread not loaded');
    if (method === 'turn/start') {
      f.methods.push(method);
      return { turn: { id: 'next-owned' } };
    }
    return request(method, params);
  };
  return f;
}

for (const phase of ['completed', 'failed'] as const) test(`worker recovers cold ${phase} final-read failure without a checkpoint and sends preserved input once`, async t => {
  const f = failedColdFixture(t, phase);
  f.users.turns.enqueue('codex', { id: 'waiting', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Preserved input', images: [] } });
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.methods.includes('thread/resume'), false, 'browser cannot load protected history');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory, undefined);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'next-owned');
  assert.equal(f.users.turns.head('codex', f.key), undefined);
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
});

test('cold recovery RPC failure is bounded across worker ticks and browser reads, then retries', async t => {
  const f = failedColdFixture(t);
  f.users.turns.enqueue('codex', { id: 'waiting', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Preserved input', images: [] } });
  const request = f.runtime.request;
  let unavailable = true;
  f.runtime.request = async (method: string, params: unknown) => {
    if (method === 'thread/goal/get' && unavailable) {
      f.methods.push(method); throw Error('synthetic unavailable');
    }
    return request(method, params);
  };
  await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), /synthetic unavailable/);
  const count = f.methods.length;
  for (let i = 0; i < 3; i++) await assert.doesNotReject(f.runtime.turnWorker.options.reconcile(f.key));
  assert.equal(f.methods.length, count);
  assert.equal(f.users.turns.head('codex', f.key)?.id, 'waiting');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  unavailable = false;
  const failureAt = f.runtime.threadRefreshResult.get(f.key).coldFailure.at;
  await f.codex.refreshSession(f.key, { readOnly: true, fresh: true });
  assert.equal(f.runtime.threadRefreshResult.get(f.key).coldFailure.at, failureAt);
  const browserCount = f.methods.length;
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.length, browserCount, 'browser reads neither bypass nor extend failure cooldown');
  f.runtime.threadRefreshResult.get(f.key).coldFailure.at -= 30_001;
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
});

test('native activity during a failed cold read prevents recording an obsolete cooldown', async t => {
  const f = failedColdFixture(t);
  const request = f.runtime.request;
  f.runtime.request = async (method: string, params: unknown) => {
    if (method === 'thread/goal/get') {
      f.runtime.handleNotification('thread/goal/cleared', { threadId: 'synthetic' });
      throw Error('synthetic unavailable');
    }
    return request(method, params);
  };
  await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), /synthetic unavailable/);
  assert.equal(f.runtime.threadRefreshResult.get(f.key)?.coldFailure, undefined);
  await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), /synthetic unavailable/);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
});

for (const change of ['native-activity', 'execution-revision', 'connection'] as const) {
  test(`cold recovery failure cooldown cannot hide ${change}`, async t => {
    const f = failedColdFixture(t);
    const request = f.runtime.request;
    f.runtime.request = async (method: string, params: unknown) => {
      if (method === 'thread/goal/get') throw Error('synthetic unavailable');
      return request(method, params);
    };
    await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), /synthetic unavailable/);
    if (change === 'native-activity') f.runtime.handleNotification('thread/goal/cleared', { threadId: 'synthetic' });
    if (change === 'execution-revision') {
      // Repeating the same sync value is intentionally a no-op, not a revision.
      f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'current');
      f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
    }
    if (change === 'connection') f.runtime.setConnection('replacement');
    await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), /synthetic unavailable/);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
  });
}

for (const fault of ['active-goal', 'unknown-goal', 'background-work', 'changed-history', 'wrong-outcome', 'successor'] as const) {
  test(`cold final-read failure retains execution protection on ${fault}`, async t => {
    const f = failedColdFixture(t);
    const before = f.users.codexExecutions.get(f.key)!;
    if (fault === 'active-goal') f.setGoal('active');
    if (fault === 'background-work') f.terminals.push({ processId: 'still-running', itemId: 'background-item' });
    if (fault === 'wrong-outcome') f.thread.turns[0].status = 'completed';
    if (fault === 'successor') f.thread.turns.push({ id: 'external', status: 'completed', itemsView: 'full', items: [] });
    const request = f.runtime.request;
    f.runtime.request = async (method: string, params: unknown) => {
      if (fault === 'unknown-goal' && method === 'thread/goal/get') throw Error('provider unavailable');
      if (fault === 'changed-history' && method === 'thread/goal/get') f.thread.turns[0].items[0].text += 'changed';
      return request(method, params);
    };
    if (fault === 'unknown-goal') await assert.rejects(f.runtime.rehydrateCheckpointThread(f.key), /provider unavailable/);
    else await f.runtime.rehydrateCheckpointThread(f.key);
    if (fault === 'background-work') {
      f.reconcile(); await f.runtime.completingTurns.get(f.key);
    }
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, before.commandId);
    assert.equal(f.methods.includes('turn/start'), false);
    if (fault !== 'background-work') assert.equal(f.methods.includes('thread/resume'), false);
  });
}

test('worker repairs a cold failed final read without queued input and preserves the acknowledged identity', async t => {
  const f = failedColdFixture(t);
  const before = f.users.codexExecutions.get(f.key)!;
  await f.runtime.turnWorker.options.reconcile(f.key);
  const after = f.users.codexExecutions.get(f.key)!;
  assert.equal(after.commandId, before.commandId);
  assert.equal(after.runId, before.runId);
  assert.equal(after.phase, 'failed');
  assert.equal(after.sync, 'current');
  assert.equal(after.nativeHistory?.state, 'verified');
  assert.equal(f.methods.includes('turn/start'), false);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
});

test('recovered cold terminal with newly active Goal uses the existing worker cooldown', async t => {
  const f = failedColdFixture(t);
  const request = f.runtime.request;
  f.runtime.request = async (method: string, params: unknown) => {
    const result = await request(method, params);
    if (method === 'thread/resume') f.setGoal('active');
    return result;
  };
  await f.codex.refreshSession(f.key, { readOnly: true });
  await f.runtime.turnWorker.options.reconcile(f.key);
  const recoveryAt = f.runtime.threadRefreshResult.get(f.key).recoveryAt;
  const before = f.methods.length;
  for (let i = 0; i < 3; i++) await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.length, before, 'worker does not reread the large transcript every queue tick');
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.runtime.threadRefreshResult.get(f.key).recoveryAt, recoveryAt);
  assert.equal(f.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
});

test('cold interrupted sync-error without a checkpoint still requires explicit cleanup evidence', async t => {
  const g = verifiedFixture(t, 'running');
  g.thread.turns.splice(1);
  g.thread.turns[0].status = 'interrupted';
  g.thread.status.type = 'notLoaded';
  g.users.codexExecutions.observe(g.key, 'connection', 'tracked', 'interrupted');
  g.users.codexExecutions.settleHistory(g.users.codexExecutions.get(g.key)!, 'error');
  await g.runtime.rehydrateCheckpointThread(g.key);
  assert.equal(g.methods.length, 0);
  assert.equal(g.users.codexExecutions.canStart(g.key), false);
});

for (const noise of ['skills/changed', 'thread/status/changed']) {
  test(`unrelated ${noise} does not revoke a settled dispatch proof`, async t => {
    const f = verifiedFixture(t);
    f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
    const before = f.users.codexExecutions.get(f.key)!;
    const request = f.runtime.request;
    f.runtime.request = async (method: string, params: any) => {
      f.runtime.handleNotification(noise, { threadId: 'unrelated', status: { type: 'idle' } });
      return request(method, params);
    };
    const check = await f.runtime.requireNativeHistoryForDispatch(f.key, 'synthetic');
    f.runtime.handleNotification(noise, { threadId: 'unrelated', status: { type: 'active' } });
    assert.doesNotThrow(check, 'the final microtask is scoped to the proved thread');
    assert.deepEqual(f.users.codexExecutions.get(f.key), before);
    assert.equal(f.methods.includes('turn/start'), false);
  });
}

for (const threadId of ['synthetic', 'unrelated', undefined]) {
  for (const source of ['request', 'notification', 'server-request']) {
    test(`dispatch activity guard scopes ${source} for ${threadId ?? 'unknown thread'}`, async t => {
      const f = verifiedFixture(t);
      f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
      const check = await f.runtime.requireNativeHistoryForDispatch(f.key, 'synthetic');
      const params = threadId ? { threadId } : {};
      if (source === 'request') {
        f.runtime.write = (message: any) => f.runtime.receive(JSON.stringify({ id: message.id, result: {} }));
        await (CodexAppServer.prototype as any).request.call(f.runtime, 'thread/goal/set', params);
      } else if (source === 'notification') f.runtime.handleNotification('thread/status/changed', params);
      else {
        f.runtime.write = () => {};
        f.runtime.receive(JSON.stringify({ id: 'native-request', method: 'unsupported/native/request', params }));
      }
      if (threadId === 'unrelated') assert.doesNotThrow(check);
      else assert.throws(check, /deferred|dispatch/i);
      assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
    });
  }
}

test('unrelated activity does not starve an idle checkpoint worker', async t => {
  const f = verifiedFixture(t);
  f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  const request = f.runtime.request;
  f.runtime.request = async (method: string, params: any) => {
    f.runtime.handleNotification('thread/status/changed', { threadId: 'unrelated', status: { type: 'active' } });
    return request(method, params);
  };
  await assert.doesNotReject(f.runtime.rehydrateCheckpointThread(f.key));
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
});

for (const replacement of ['replacement', undefined]) test(`lost completion survives native connection replacement (${replacement ?? 'disconnect'})`, async t => {
  const f = verifiedFixture(t, 'running');
  f.setGoal('complete');
  const before = f.users.codexExecutions.get(f.key)!;
  f.runtime.setConnection(replacement);
  if (!replacement) assert.deepEqual(f.users.codexExecutions.get(f.key), before);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  f.runtime.setConnection('replacement');
  assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'unknown');
  assert.equal(f.users.codexExecutions.get(f.key)?.reason, 'restarted');
  assert.deepEqual(f.users.codexExecutions.recoveryPage('', 64, 'replacement'), [f.key]);
  await f.runtime.turnWorker.options.reconcile(f.key);
  const after = f.users.codexExecutions.get(f.key)!;
  assert.equal(after.phase, 'completed');
  assert.equal(after.runId, before.runId);
  assert.equal(after.commandId, before.commandId);
  assert.equal(after.connectionId, before.connectionId, 'original ownership is not transferred');
  assert.equal(after.nativeHistory?.connectionId, 'replacement');
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
});

test('native replacement keeps active Goal and late old notifications protected until independent proof', async t => {
  const f = verifiedFixture(t, 'running');
  f.setGoal('active');
  f.runtime.setConnection('replacement');
  const disconnected = f.users.codexExecutions.get(f.key)!;
  assert.equal(f.users.codexExecutions.observe(f.key, 'connection', 'tracked', 'completed'), false);
  assert.deepEqual(f.users.codexExecutions.get(f.key), disconnected);
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'completed');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-active');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
  f.setGoal('complete');
  f.runtime.threadRefreshResult.clear(); // advance existing cooldown, not a notification
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.wakes(), 1);
});

for (const phase of ['running', 'restarted'] as const) {
  test(`worker recovers lost owned completion behind finished Goal successors (${phase})`, async t => {
    const f = verifiedFixture(t, phase);
    f.setGoal('complete');
    const before = f.users.codexExecutions.get(f.key)!;
    await f.runtime.turnWorker.options.reconcile(f.key);
    const after = f.users.codexExecutions.get(f.key)!;
    assert.equal(after.phase, 'completed');
    assert.equal(after.commandId, before.commandId);
    assert.equal(after.runId, before.runId, 'successor never becomes the acknowledged command');
    assert.equal(after.sync, 'current');
    assert.equal(after.nativeHistory?.state, 'verified');
    assert.equal(after.nativeHistory?.turnId, 'successor-2');
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    const runtime = f.store.getSession(f.key)?.runtime;
    assert.equal(runtime?.phase, 'completed');
    assert.equal(runtime?.sync, 'current');
    assert.equal(runtime?.connection, 'connected');
    assert.equal(runtime?.executionProtection?.state, 'verified');
    assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
  });
  test(`worker recovers cold Goal successors after lost completion (${phase})`, async t => {
    const f = verifiedFixture(t, phase);
    f.setGoal('complete');
    f.thread.status.type = 'notLoaded';
    f.runtime.rolloutReader.validate = async () => {};
    const request = f.runtime.request;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list' && f.thread.status.type === 'notLoaded') throw new Error('thread not found');
      if (method === 'thread/resume') {
        f.methods.push(method);
        f.thread.status.type = 'idle';
        return { thread: structuredClone(f.thread) };
      }
      return request(method);
    };
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'completed');
    assert.equal(f.users.codexExecutions.canStart(f.key), false, 'cold snapshot is not cleanup proof');
    assert.equal(f.methods.includes('thread/resume'), false);
    f.runtime.threadRefreshResult.clear(); // advance the existing recovery interval without wall-clock sleep
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
    assert.equal(f.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(f.methods.includes('turn/start'), false);
  });
}

for (const phase of ['running', 'restarted'] as const) {
  for (const fault of ['active-successor', 'unknown-successor', 'active-head', 'missing-owner', 'partial-items', 'duplicate-owner']) {
    test(`lost completion recovery rejects incomplete native evidence (${phase}, ${fault})`, async t => {
      const f = verifiedFixture(t, phase);
      f.store.addMessage({ id: `${f.key}:codex-orphan`, sessionKey: f.key, turnId: 'tracked',
        role: 'assistant', text: 'Abandoned stream draft', createdAt: 1 });
      f.setGoal('complete');
      if (fault === 'active-successor') f.thread.turns[1].status = 'inProgress';
      if (fault === 'unknown-successor') f.thread.turns[1].status = 'unknown';
      if (fault === 'active-head') f.thread.status.type = 'active';
      if (fault === 'missing-owner') f.thread.turns.shift();
      if (fault === 'partial-items') f.thread.turns[0].itemsView = 'summary';
      if (fault === 'duplicate-owner') f.thread.turns.push(structuredClone(f.thread.turns[0]));
      const read = f.runtime.turnWorker.options.reconcile(f.key);
      if (fault === 'partial-items' || fault === 'duplicate-owner') await assert.rejects(read, /Invalid Codex thread history/);
      else await read;
      const fact = f.users.codexExecutions.get(f.key)!;
      assert.equal(fact.phase, phase === 'running' ? 'running' : 'unknown');
      assert.equal(fact.runId, 'tracked');
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
      assert.equal(f.methods.includes('thread/resume'), false);
    });
  }
  for (const goal of ['active', 'paused', 'blocked', 'budgetLimited', 'usageLimited', 'unavailable']) {
    test(`lost completion preserves ${goal} Goal protection and later recovers without a notification (${phase})`, async t => {
      const f = verifiedFixture(t, phase);
      f.store.addMessage({ id: `${f.key}:codex-orphan`, sessionKey: f.key, turnId: 'tracked',
        role: 'assistant', text: 'Abandoned stream draft', createdAt: 1 });
      f.setGoal(goal === 'unavailable' ? 'complete' : goal);
      const request = f.runtime.request;
      let unavailable = goal === 'unavailable';
      f.runtime.request = async (method: string) => {
        if (method === 'thread/goal/get' && unavailable) throw new Error('temporary failure');
        return request(method);
      };
      await f.runtime.turnWorker.options.reconcile(f.key);
      assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'completed');
      assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
      assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, 'blocked');
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
      assert.equal(f.methods.includes('thread/resume'), false);
      unavailable = false;
      f.setGoal('complete');
      f.runtime.threadRefreshResult.clear();
      await f.runtime.turnWorker.options.reconcile(f.key);
      assert.equal(f.users.codexExecutions.canStart(f.key), true);
      assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
      assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
    });
  }
  for (const fault of ['connection', 'revision', 'projection']) {
    test(`lost completion snapshot cannot settle a changed ${fault} (${phase})`, async t => {
      const f = verifiedFixture(t, phase);
      f.setGoal('complete');
      const request = f.runtime.request;
      let changed = false;
      f.runtime.request = async (method: string) => {
        const result = await request(method);
        if (method === 'thread/backgroundTerminals/list' && !changed) {
          changed = true;
          if (fault === 'connection') f.runtime.setConnection('replacement');
          if (fault === 'revision') {
            if (phase === 'running') f.users.codexExecutions.observe(f.key, 'connection', 'tracked', 'failed');
            else f.users.codexExecutions.recoverTerminal(f.users.codexExecutions.get(f.key)!, 'tracked', 'failed');
          }
          if (fault === 'projection') f.runtime.projectionVersions.set(f.key, f.runtime.projectionVersion(f.key) + 1);
        }
        return result;
      };
      await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key));
      assert.equal(f.users.codexExecutions.get(f.key)?.phase, fault === 'revision' ? 'failed'
        : fault === 'connection' || phase === 'restarted' ? 'unknown' : 'running');
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
    });
  }
}

for (const fault of ['background', 'child', 'missing-reply']) {
  test(`lost completion keeps ${fault} protected, then converges after proof returns`, async t => {
    const f = verifiedFixture(t, 'running');
    f.store.addMessage({ id: `${f.key}:codex-orphan`, sessionKey: f.key, turnId: 'tracked',
      role: 'assistant', text: 'Abandoned stream draft', createdAt: 1 });
    f.setGoal('complete');
    if (fault === 'background') f.terminals.push({ itemId: 'bg', processId: '123' });
    if (fault === 'child') f.thread.turns[1].items.push({ id: 'child-activity', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'child', agentPath: '/root/child' });
    if (fault === 'missing-reply') f.store.addMessage({ id: `${f.key}:codex-live`, sessionKey: f.key,
      turnId: 'tracked', role: 'assistant', status: 'sent', text: 'Delivered live', createdAt: 1 });
    const first = f.runtime.turnWorker.options.reconcile(f.key);
    if (fault === 'background') await assert.rejects(first, /background terminals are still running/);
    else await first;
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.methods.includes('thread/resume'), false);
    if (fault === 'background') f.terminals.length = 0;
    if (fault === 'child') f.thread.turns[1].items.pop();
    if (fault === 'missing-reply') f.thread.turns[0].items.push({ id: 'live', type: 'agentMessage', text: 'Delivered live' });
    f.runtime.threadRefreshResult.clear();
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  });
}

for (const phase of ['running', 'restarted'] as const) for (const outcome of ['failed', 'interrupted']) {
  test(`lost completion retains the owned ${outcome} outcome, not successful successor outcome (${phase})`, async t => {
    const f = verifiedFixture(t, phase);
    f.setGoal('complete');
    f.thread.turns[0].status = outcome;
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.get(f.key)?.phase, outcome);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
    assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, 'verified');
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, outcome);
  });
}

for (const phase of ['running', 'restarted'] as const) {
  test(`cold lost completion never loads an active Goal (${phase})`, async t => {
    const f = verifiedFixture(t, phase);
    f.setGoal('active');
    f.thread.status.type = 'notLoaded';
    const request = f.runtime.request;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') throw new Error('thread not found');
      return request(method);
    };
    await f.runtime.turnWorker.options.reconcile(f.key);
    f.runtime.threadRefreshResult.clear();
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'completed');
    assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-active');
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.methods.includes('thread/resume'), false);
  });

  test(`lost completion releases preserved input exactly once (${phase})`, async t => {
    const f = verifiedFixture(t, phase);
    f.setGoal('complete');
    f.runtime.loadedThreadIds.add('synthetic');
    f.users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: f.key, createdAt: 5,
      payload: { text: 'Preserved input', images: [] } });
    const request = f.runtime.request;
    f.runtime.request = async (method: string) => {
      if (method === 'turn/start') {
        f.methods.push(method);
        const turn = { id: 'new-owned', status: 'inProgress', items: [] };
        f.thread.turns.push(turn);
        f.thread.status.type = 'active';
        return { turn };
      }
      return request(method);
    };
    await f.runtime.turnWorker.options.reconcile(f.key);
    await f.runtime.turnWorker.options.reconcile(f.key);
    assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'preserved-input');
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'new-owned');
    assert.equal(f.users.turns.list('codex', f.key).length, 0);
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'tracked', status: 'completed' } });
    f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'successor-2' } });
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'new-owned');
    assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'running');
    assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
  });
}

for (const status of [null, 'complete']) test(`verified native successors settle without rebinding command (${status ?? 'no-goal'})`, async t => {
  const f = verifiedFixture(t);
  f.setGoal(status);
  const before = f.users.codexExecutions.get(f.key)!;
  f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  const after = f.users.codexExecutions.get(f.key)!;
  assert.equal(after.commandId, before.commandId);
  assert.equal(after.runId, before.runId);
  assert.equal(after.phase, before.phase);
  assert.equal(after.completedAt, before.completedAt);
  assert.equal(after.nativeHistory?.turnId, 'successor-2');
  assert.equal(after.nativeHistory?.state, 'verified');
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.wakes(), 1);
  assert.equal(JSON.stringify(after).includes('PRIVATE'), false);
  assert.deepEqual(f.methods, ['thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get', 'thread/backgroundTerminals/list', 'thread/read', 'thread/goal/get']);
});

for (const kind of ['started', 'interacted', 'interrupted']) test(`activity-only child ${kind} protects successor admission when native proof is unavailable`, async t => {
  const f = verifiedFixture(t);
  f.setGoal(null);
  f.thread.turns[1].items.push({ id: 'child-activity', type: 'subAgentActivity', kind,
    agentThreadId: 'child', agentPath: '/root/child' });
  f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'subagent-review');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
  assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list', 'thread/loaded/list'].includes(method)));
});

for (const unloaded of [false, true]) test(`settled child releases successor protection without rebinding or replay (unloaded=${unloaded})`, async t => {
  const f = verifiedFixture(t);
  f.thread.turns[1].items.push({ id: 'child-activity', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'child' });
  const child = { id: 'child', parentThreadId: 'synthetic', status: { type: unloaded ? 'notLoaded' : 'idle' },
    turns: [{ id: 'child-turn', status: 'completed', itemsView: 'full', items: [{ id: 'private-reply', type: 'agentMessage', text: 'PRIVATE CHILD' }] }] };
  const request = f.runtime.request;
  f.runtime.request = async (method: string, params: any) => {
    if (method === 'thread/loaded/list') { f.methods.push(method); return { data: unloaded ? [] : ['child'], nextCursor: null }; }
    if (method === 'thread/read' && params.threadId === 'child') { f.methods.push(method); return { thread: structuredClone(child) }; }
    return request(method, params);
  };
  const before = f.users.codexExecutions.get(f.key)!;
  f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  const after = f.users.codexExecutions.get(f.key)!;
  assert.equal(after.nativeHistory?.state, 'verified');
  assert.equal(after.runId, before.runId); assert.equal(after.commandId, before.commandId);
  assert.equal(f.users.codexExecutions.canStart(f.key), true); assert.equal(f.wakes(), 1);
  assert.ok(!JSON.stringify(f.store.getMessages(f.key)).includes('PRIVATE CHILD'));
  const read = f.runtime.request;
  f.runtime.request = async (method: string, params: any) => {
    f.runtime.handleNotification('thread/status/changed', { threadId: 'unrelated', status: { type: 'active' } });
    return read(method, params);
  };
  const finalCheck = await f.runtime.requireNativeHistoryForDispatch(f.key, 'synthetic');
  f.runtime.handleNotification('thread/status/changed', { threadId: 'child', status: { type: 'active', activeFlags: [] } });
  assert.throws(finalCheck, /deferred|dispatch/i, 'late child activity invalidates the last dispatch microtask');
  child.status.type = 'active';
  await assert.rejects(f.runtime.requireNativeHistoryForDispatch(f.key, 'synthetic'));
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
});

for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'unknown']) {
  test(`native ${status} goal does not clear protection or interrupt readable history`, async t => {
    const f = verifiedFixture(t);
    f.setGoal(status);
    f.reconcile();
    await f.codex.refreshSession(f.key, { readOnly: true });
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
    assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, `goal-${status}`);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.wakes(), 0);
    assert.deepEqual(f.users.codexExecutions.recoveryPage('', 64), [f.key]);
    await assert.rejects(f.runtime.sendQueued(f.key, 'new', [], 'new-command'), /not available for dispatch/);
    assert.equal(f.methods.includes('thread/resume'), false);
  });
}

for (const fault of ['background', 'subagent', 'unavailable', 'unsupported-terminals', 'interrupted-cleanup']) {
  test(`native-head proof fails closed for ${fault}`, async t => {
    const f = verifiedFixture(t);
    if (fault === 'background') f.terminals.push({ itemId: 'bg', processId: '123' });
    if (fault === 'subagent') f.thread.turns[1].items.push({ id: 'child', type: 'collabAgentToolCall', status: 'completed' });
    if (fault === 'unavailable') (f.thread as any).canAcceptDirectInput = null;
    if (fault === 'interrupted-cleanup') {
      f.thread.turns[1].status = 'interrupted';
      // A missing native list must not prove interrupted wrappers stopped.
    }
    const request = f.runtime.request;
    if (fault === 'unsupported-terminals' || fault === 'interrupted-cleanup') f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') throw new Error('unsupported');
      return request(method);
    };
    f.reconcile();
    await f.codex.refreshSession(f.key, { readOnly: true });
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, 'blocked');
    assert.equal(f.wakes(), 0);
  });
}

test('goal can become complete through native authority and generic worker re-evaluates, without mutating goal', async t => {
  const f = verifiedFixture(t);
  f.setGoal('blocked'); f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  f.setGoal('complete');
  f.runtime.handleNotification('thread/goal/updated', { threadId: 'synthetic' });
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
});

for (const mutation of ['head', 'goal', 'connection', 'notification', 'late-owned-tool']) {
  test(`dispatch revalidates native head against ${mutation} after history was settled`, async t => {
    const f = verifiedFixture(t);
    f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    if (mutation === 'head') f.thread.turns[2].items[0].text += ' changed';
    if (mutation === 'goal') f.setGoal('active');
    if (mutation === 'connection') f.runtime.setConnection('replacement');
    if (mutation === 'notification') f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'new-head' } });
    if (mutation === 'late-owned-tool') f.users.codexExecutions.observeCommandTool(f.key, 'connection', 'tracked', 'late-tool');
    await assert.rejects(f.runtime.startTurn(f.key, 'synthetic', [], 'new-command'), /not available for dispatch/);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
    assert.equal(f.methods.includes('turn/start'), false);
  });
}

test('restarted checkpoint must be re-proven, preserving command and latest native identities', async t => {
  const f = verifiedFixture(t);
  f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  f.users.codexExecutions.recoverInterrupted();
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'restarted');
  const before = f.users.codexExecutions.get(f.key);
  f.users.codexExecutions.recoverInterrupted();
  assert.deepEqual(f.users.codexExecutions.get(f.key), before);
  f.runtime.setConnection('replacement');
  f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.connectionId, 'connection');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.connectionId, 'replacement');
});

test('native connection replacement schedules checkpoint revalidation without a Connector restart or queued work', async t => {
  const f = verifiedFixture(t);
  f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  f.runtime.setConnection('replacement');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.deepEqual(f.users.codexExecutions.recoveryPage('', 64, 'replacement'), [f.key]);
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.connectionId, 'connection');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.connectionId, 'replacement');
});

test('verified successors allow an independently bound new authorized turn', async t => {
  const f = verifiedFixture(t);
  f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  const request = f.runtime.request;
  f.runtime.request = async (method: string) => {
    if (method === 'turn/start') { f.methods.push(method); return { turn: { id: 'new-owned' } }; }
    return request(method);
  };
  await f.runtime.startTurn(f.key, 'synthetic', [], 'new-command');
  const fact = f.users.codexExecutions.get(f.key)!;
  assert.equal(fact.commandId, 'new-command');
  assert.equal(fact.runId, 'new-owned');
  assert.equal(fact.nativeHistory, undefined, 'old observation is not ownership for the new command');
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
});

async function coldCheckpointFixture(t: test.TestContext, successors = false) {
  const f = verifiedFixture(t);
  if (!successors) f.thread.turns.splice(1);
  f.reconcile();
  await f.codex.refreshSession(f.key, { readOnly: true });
  const fact = f.users.codexExecutions.get(f.key)!;
  f.users.codexExecutions.settleNativeHistory(fact, { turnId: f.thread.turns.at(-1)!.id, fingerprint: '0'.repeat(64),
    connectionId: 'connection', state: 'blocked', reason: 'restarted' });
  f.thread.status.type = 'notLoaded';
  f.runtime.threadRefreshResult.clear();
  f.runtime.rolloutReader.validate = async () => {};
  const request = f.runtime.request;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list' && f.thread.status.type === 'notLoaded') {
      throw new Error('thread not found');
    }
    if (method === 'thread/resume') {
      f.methods.push(method);
      f.thread.status.type = 'idle';
      f.runtime.handleNotification('thread/goal/updated', { threadId: 'synthetic' });
      return { thread: structuredClone(f.thread) };
    }
    if (method === 'turn/start') {
      f.methods.push(method);
      return { turn: { id: 'new-owned' } };
    }
    return request(method);
  };
  return f;
}

test('cold recovery native reads share a budget and exhaustion never resumes or releases execution', async t => {
  const f = await coldCheckpointFixture(t);
  f.runtime.options.requestTimeoutMs = 100;
  const before = f.users.codexExecutions.get(f.key);
  const request = f.runtime.request;
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const reads: { method: string; timeout: number | undefined }[] = [];
  f.runtime.request = async (method: string, params: unknown, timeout?: number) => {
    reads.push({ method, timeout });
    assert.ok(timeout !== undefined && timeout > 0 && timeout <= 100, 'every proof read needs a remaining budget');
    const cost = method === 'thread/goal/get' ? 30 : 60;
    elapsed += Math.min(cost, timeout!);
    if (cost >= timeout!) throw Error('synthetic read timeout');
    return request(method, params);
  };
  await assert.rejects(f.runtime.rehydrateCheckpointThread(f.key), /synthetic read timeout/);
  assert.deepEqual(reads.map(read => read.timeout), [100, 40, 10]);
  assert.equal(f.methods.includes('thread/resume'), false);
  assert.deepEqual(f.users.codexExecutions.get(f.key), before);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
});

test('cold recovery acknowledges metadata-only resume and then verifies history within the read-only budget', async t => {
  const f = await coldCheckpointFixture(t);
  f.runtime.options.requestTimeoutMs = 100;
  const request = f.runtime.request;
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const reads: number[] = [];
  let resumes = 0;
  f.runtime.request = async (method: string, params: { excludeTurns?: boolean }, timeout?: number) => {
    if (method === 'thread/resume') {
      resumes++;
      assert.equal(timeout, undefined, 'native writes retain the ordinary request timeout');
      assert.equal(params.excludeTurns, true);
      const result = await request(method, params);
      return { ...result, thread: { ...result.thread, turns: [] } };
    } else {
      assert.ok(timeout !== undefined && timeout > 0 && timeout <= 100);
      reads.push(timeout!);
      elapsed += 10;
    }
    return request(method, params);
  };
  await f.runtime.rehydrateCheckpointThread(f.key);
  assert.deepEqual(reads, [100, 90, 80, 70, 60]);
  assert.equal(resumes, 1);
  assert.equal(f.users.codexExecutions.canStart(f.key), false, 'loading alone is not fresh execution proof');
});

test('post-ACK history timeout blocks execution without leaving an unresolved resume', async t => {
  const f = await coldCheckpointFixture(t);
  const resumes = f.users.codexExecutions.nativeResumes;
  const request = f.runtime.request;
  let acknowledged = false;
  f.runtime.options.nativeJournal = {
    readHistory: async () => ({ execution: f.users.codexExecutions.get(f.key), deleted: false, outcomeUnknown: resumes.pending(f.key) }),
    prepareResume: async (...[input]: [Parameters<typeof resumes.prepare>[0]]) => resumes.prepare(input, () => true),
    beginResume: async (...[receipt]: [Parameters<typeof resumes.begin>[0]]) => resumes.begin(receipt, () => true),
    finishResume: async (...[receipt, outcome]: Parameters<typeof resumes.finish>) => {
      const ok = resumes.finish(receipt, outcome);
      acknowledged = outcome === 'acknowledged' && ok;
      return ok;
    },
  };
  f.runtime.request = async (method: string, params: { excludeTurns?: boolean }, _timeout?: number, _goal?: unknown,
    beforeDispatch?: () => void) => {
    if (method === 'thread/resume') {
      assert.equal(params.excludeTurns, true);
      assert.ok(beforeDispatch);
      beforeDispatch();
      f.thread.status.type = 'idle';
      return { thread: { ...f.thread, turns: [] } };
    }
    if (method === 'thread/read' && acknowledged) throw Error('synthetic post-ACK history timeout');
    return request(method);
  };
  try {
    await assert.rejects(f.runtime.rehydrateCheckpointThread(f.key), /synthetic post-ACK history timeout/);
    assert.equal(acknowledged, true);
    assert.equal(resumes.pending(f.key), false);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.methods.includes('turn/start'), false);
  } finally { f.runtime.options.nativeJournal = undefined; }
});

test('cold checkpoint history stays read-only; worker loads, re-proves and dispatches the preserved queue once', async t => {
  const f = await coldCheckpointFixture(t);
  const checkpoint = f.users.codexExecutions.get(f.key);
  f.users.turns.enqueue('codex', { id: 'waiting', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Preserved input', images: [] } });
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(f.methods.includes('thread/resume'), false);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.deepEqual(f.users.codexExecutions.get(f.key), checkpoint, 'display cannot certify or replace the cold checkpoint');
  f.runtime.threadRefreshResult.clear();
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'new-owned');
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
});

for (const parentCold of [true, false]) test(`worker loads cold children without sending child messages (parentCold=${parentCold})`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await coldCheckpointFixture(t, true);
  if (!parentCold) f.thread.status.type = 'idle';
  f.thread.turns[1].items.push({ id: 'activity', type: 'subAgentActivity', agentThreadId: 'child' });
  const child = { id: 'child', parentThreadId: 'synthetic', path: '/fixture/child.jsonl', status: { type: 'notLoaded' },
    turns: [{ id: 'child-turn', status: 'completed', itemsView: 'full', items: [{ id: 'private', type: 'agentMessage', text: 'CHILD PRIVATE' }] }] };
  const request = f.runtime.request, resumes: string[] = [];
  f.runtime.request = async (method: string, params: any) => {
    if (method === 'thread/loaded/list') return { data: child.status.type === 'idle' ? ['child'] : [] };
    if (params?.threadId === 'child') {
      if (method === 'thread/read') return { thread: structuredClone(child) };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/backgroundTerminals/list') {
        if (child.status.type === 'notLoaded') throw Error('thread not found');
        return { data: [] };
      }
      assert.equal(method, 'thread/resume', 'No turn/start or message may target the child');
      resumes.push(params.threadId); child.status.type = 'idle';
      f.runtime.handleNotification('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
      return { thread: structuredClone(child) };
    }
    return request(method, params);
  };
  const original = f.users.codexExecutions.get(f.key)!;
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.deepEqual(resumes, [], 'Browser history is observation only');
  f.users.turns.enqueue('codex', { id: 'waiting', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Preserved input', images: [] } });
  for (let n = 0; n < 3 && !f.methods.includes('turn/start'); n++) {
    await f.codex.refreshSession(f.key, { readOnly: true, fresh: true });
    await f.runtime.turnWorker.options.reconcile(f.key);
    t.mock.timers.tick(30_001);
  }
  assert.deepEqual(resumes, ['child']);
  assert.equal(f.methods.filter(m => m === 'turn/start').length, 1);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'new-owned');
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
  assert.ok(!JSON.stringify(f.store.getMessages(f.key)).includes('CHILD PRIVATE'));
  assert.equal(original.runId, 'tracked');
});

for (const cold of [false, true]) test(`explicit queued input continues a blocked goal exactly once (${cold ? 'cold' : 'loaded'})`, async t => {
  const f = cold ? await coldCheckpointFixture(t, true) : verifiedFixture(t);
  f.setGoal('blocked');
  if (!cold) {
    f.runtime.loadedThreadIds.add('synthetic');
    const request = f.runtime.request;
    f.runtime.request = async (method: string) => {
      if (method === 'turn/start') { f.methods.push(method); return { turn: { id: 'new-owned' } }; }
      return request(method);
    };
  }
  for (const id of ['first', 'second']) f.users.turns.enqueue('codex', { id, sessionKey: f.key, createdAt: 5,
    payload: { text: `Preserved ${id}`, images: [] } });
  await f.codex.recoverMaintenanceHistory(f.key, () => {});
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-blocked');
  assert.equal(f.methods.includes('thread/resume'), false, 'maintenance cannot load a blocked goal');
  assert.equal(f.users.turns.list('codex', f.key).length, 2);
  f.runtime.threadRefreshResult.clear();
  await f.runtime.turnWorker.options.reconcile(f.key);
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'new-owned');
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
  assert.ok(!f.methods.some(method => ['thread/goal/set','thread/goal/clear','thread/compact/start','thread/rollback'].includes(method)));
});

for (const failure of ['unattributed-terminal', 'list-unavailable'] as const) {
  test(`cold blocked-goal input still requires loaded terminal proof: ${failure}`, async t => {
    const f = await coldCheckpointFixture(t, true);
    f.setGoal('blocked');
    f.users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: f.key, createdAt: 5,
      payload: { text: 'Preserve original input', images: [] } });
    await f.codex.recoverMaintenanceHistory(f.key, () => {});
    assert.equal(f.methods.includes('thread/resume'), false, 'read-only maintenance cannot resume a blocked goal');
    const request = f.runtime.request;
    let loadedLists = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list' && f.thread.status.type === 'idle') {
        loadedLists++;
        if (failure === 'list-unavailable') throw new Error('synthetic list unavailable');
        return { data: [{ processId: 'unknown-process', itemId: 'unknown-tool' }] };
      }
      return request(method);
    };
    f.runtime.threadRefreshResult.clear();
    const expectedError = failure === 'list-unavailable'
      ? /synthetic list unavailable/ : /Codex background terminals are still running/;
    if (failure === 'list-unavailable') {
      await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), expectedError);
      await assert.rejects(f.runtime.turnWorker.options.reconcile(f.key), expectedError);
    } else {
      await f.runtime.turnWorker.options.reconcile(f.key);
      await f.runtime.turnWorker.options.reconcile(f.key);
      assert.equal(f.codex.isSessionHistoryReady(f.key), true, 'terminal protection does not hide readable history');
    }
    assert.ok(loadedLists > 0, 'explicit continuation must recheck native terminals after loading');
    assert.equal(f.methods.includes('turn/start'), false);
    assert.equal(f.methods.includes('thread/backgroundTerminals/terminate'), false);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    const queued = f.users.turns.list<{ text: string }>('codex', f.key);
    assert.deepEqual(queued.map(row => ({ id: row.id, state: row.state, text: row.payload.text })),
      [{ id: 'preserved-input', state: 'queued', text: 'Preserve original input' }]);
  });
}

for (const unsafe of ['active','paused','usageLimited','budgetLimited','unknown','background','subagent','cleanup','no-direct-input','authority','goal-race','connection-race']) {
  test(`blocked-goal user continuation refuses ${unsafe} and preserves queued identity`, async t => {
    const f = verifiedFixture(t);
    f.setGoal('blocked'); f.runtime.loadedThreadIds.add('synthetic');
    f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
    const queued = { id: 'preserved', sessionKey: f.key, createdAt: 5, payload: { text: 'Keep this input', images: [] } };
    f.users.turns.enqueue('codex', queued);
    if (['active','paused','usageLimited','budgetLimited','unknown'].includes(unsafe)) f.setGoal(unsafe);
    if (unsafe === 'background') f.terminals.push({ itemId: 'background', processId: '123' });
    if (unsafe === 'subagent') f.thread.turns[1].items.push({ id: 'child', type: 'collabAgentToolCall', status: 'completed' });
    if (unsafe === 'cleanup') f.runtime.requireBackgroundTerminalsDrained = async () => { throw new Error('unconfirmed'); };
    if (unsafe === 'no-direct-input') (f.thread as any).canAcceptDirectInput = false;
    if (unsafe === 'authority') f.runtime.options.authorizeTurn = () => false;
    if (unsafe === 'goal-race' || unsafe === 'connection-race') {
      const request = f.runtime.request; let reads = 0;
      f.runtime.request = async (method: string) => {
        if (method === 'thread/goal/get' && ++reads === 2) {
          if (unsafe === 'goal-race') f.setGoal('active'); else f.runtime.setConnection('replacement');
        }
        return request(method);
      };
    }
    await f.runtime.dispatchQueuedTurn(f.key);
    assert.equal(f.methods.includes('turn/start'), false);
    assert.equal(f.methods.includes('thread/resume'), false);
    const remaining = f.users.turns.list('codex', f.key);
    assert.equal(remaining.length, 1); assert.equal(remaining[0]!.id, queued.id);
    assert.equal(remaining[0]!.state, unsafe === 'authority' ? 'blocked' : 'queued');
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  });
}

test('maintenance cold checkpoint recovery tolerates load notifications without granting a turn', async t => {
  const f = await coldCheckpointFixture(t);
  await f.codex.recoverMaintenanceHistory(f.key, () => {});
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
  assert.equal(f.methods.includes('turn/start'), false);
});

test('cold terminal successors recover without adopting a foreign run, then dispatch the original queue exactly once', async t => {
  const f = await coldCheckpointFixture(t, true);
  f.users.turns.enqueue('codex', { id: 'preserved-successor-input', sessionKey: f.key, createdAt: 5,
    payload: { text: 'Preserved input', images: [] } });
  await f.codex.recoverMaintenanceHistory(f.key, () => {});
  const recovered = f.users.codexExecutions.get(f.key)!;
  assert.equal(recovered.commandId, 'command');
  assert.equal(recovered.runId, 'tracked');
  assert.equal(recovered.nativeHistory?.turnId, 'successor-2');
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  const waiting = f.users.turns.list('codex', f.key);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]?.id, 'preserved-successor-input');
  assert.equal(f.methods.includes('turn/start'), false);
  await f.runtime.turnWorker.options.reconcile(f.key);
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
});

for (const fault of ['active-middle', 'child-middle', 'missing-owned', 'owned-phase', 'blocked-goal', 'history-race']) {
  test(`cold successor chain refuses unsafe loading: ${fault}`, async t => {
    const f = await coldCheckpointFixture(t, true);
    if (fault === 'active-middle') f.thread.turns[1].status = 'inProgress';
    if (fault === 'child-middle') f.thread.turns[1].items.push({ id: 'child', type: 'collabToolCall' });
    if (fault === 'missing-owned') f.thread.turns.shift();
    if (fault === 'owned-phase') f.thread.turns[0].status = 'interrupted';
    if (fault === 'blocked-goal') f.setGoal('blocked');
    const request = f.runtime.request;
    f.runtime.request = async (method: string) => {
      const result = await request(method);
      if (fault === 'history-race' && method === 'thread/goal/get') f.thread.turns[1].items.push({ id: 'late', type: 'agentMessage', text: 'Changed' });
      return result;
    };
    if (['active-middle', 'missing-owned', 'owned-phase'].includes(fault)) {
      await assert.rejects(f.codex.recoverMaintenanceHistory(f.key, () => {}), /Maintenance native history unavailable/);
    } else await f.codex.recoverMaintenanceHistory(f.key, () => {});
    assert.equal(f.methods.includes('thread/resume'), false);
    assert.equal(f.methods.includes('turn/start'), false);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  });
}

for (const fault of ['blocked-goal', 'unknown-goal', 'successor', 'subagent', 'goal-race', 'revision-race', 'connection-race', 'background']) {
  test(`cold checkpoint recovery does not dispatch unsafe work: ${fault}`, async t => {
    const f = await coldCheckpointFixture(t);
    if (fault === 'blocked-goal') f.setGoal('blocked');
    if (fault === 'successor') f.thread.turns.push({ id: 'foreign', status: 'completed', itemsView: 'full', items: [] });
    if (fault === 'subagent') f.thread.turns[0].items.push({ id: 'child', type: 'collabAgentToolCall', status: 'completed' });
    if (fault === 'background') f.terminals.push({ itemId: 'bg', processId: '123' });
    const request = f.runtime.request;
    let goals = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/goal/get') {
        if (fault === 'unknown-goal') return {};
        if (++goals === 2) {
          if (fault === 'goal-race') f.setGoal('active');
          if (fault === 'revision-race') f.users.codexExecutions.invalidateNativeHistory(f.key);
          if (fault === 'connection-race') f.runtime.setConnection('replacement');
        }
      }
      return request(method);
    };
    if (fault === 'revision-race' || fault === 'connection-race') {
      await assert.rejects(f.codex.recoverMaintenanceHistory(f.key, () => {}));
    } else await f.codex.recoverMaintenanceHistory(f.key, () => {});
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.equal(f.methods.includes('turn/start'), false);
    if (fault !== 'background') assert.equal(f.methods.includes('thread/resume'), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  });
}

for (const operation of ['startTurn', 'sendQueued', 'compactThread']) {
  test(`${operation} checks proof again after final await before any mutating RPC`, async t => {
    const f = verifiedFixture(t);
    f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
    const verify = f.runtime.requireNativeHistoryForDispatch.bind(f.runtime);
    f.runtime.requireNativeHistoryForDispatch = async (...args: any[]) => {
      const check = await verify(...args);
      queueMicrotask(() => f.runtime.handleNotification('thread/goal/updated', { threadId: 'synthetic' }));
      return check;
    };
    const attempt = operation === 'startTurn' ? f.runtime.startTurn(f.key, 'synthetic', [], 'new-command')
      : operation === 'sendQueued' ? f.runtime.sendQueued(f.key, 'next', [], 'new-command')
        : f.runtime.compactThread('synthetic');
    await assert.rejects(attempt, /not available for dispatch/);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'tracked');
    assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
  });
}

for (const mutation of ['revision', 'connection', 'projection', 'goal', 'history']) {
  test(`native proof rejects ${mutation} changes during asynchronous verification`, async t => {
    const f = verifiedFixture(t);
    f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
    const request = f.runtime.request;
    let goals = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/goal/get' && ++goals === 2) {
        if (mutation === 'revision') f.users.codexExecutions.invalidateNativeHistory(f.key);
        if (mutation === 'connection') f.runtime.setConnection('replacement');
        if (mutation === 'projection') f.runtime.projectionVersions.set(f.key, f.runtime.projectionVersion(f.key) + 1);
        if (mutation === 'goal') f.setGoal('active');
      }
      if (mutation === 'history' && method === 'thread/read' && goals === 1) f.thread.turns[2].items[0].text += ' changed';
      return request(method);
    };
    await assert.rejects(f.runtime.startTurn(f.key, 'synthetic', [], 'new-command'), /not available for dispatch/);
    assert.equal(f.methods.includes('turn/start'), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
  });
}

test('readable protected histories reuse bounded worker recovery age, not every queue tick', async t => {
  const f = verifiedFixture(t);
  f.setGoal('blocked'); f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.ok(Number.isFinite(f.runtime.threadRefreshResult.get(f.key).recoveryAt));
  const count = f.methods.length;
  const initialRecoveryAt = f.runtime.threadRefreshResult.get(f.key).recoveryAt;
  await f.codex.refreshSession(f.key, { readOnly: true, fresh: true });
  const browserCount = f.methods.length;
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.ok(browserCount > count);
  assert.equal(f.methods.length, browserCount, 'A browser read must not defeat the worker cooldown either');
  assert.equal(f.runtime.threadRefreshResult.get(f.key).recoveryAt, initialRecoveryAt);
  f.setGoal('complete');
  f.runtime.threadRefreshResult.get(f.key).recoveryAt -= 30_001;
  const recoveryAt = f.runtime.threadRefreshResult.get(f.key).recoveryAt;
  await f.codex.refreshSession(f.key, { readOnly: true, fresh: true });
  assert.equal(f.runtime.threadRefreshResult.get(f.key).recoveryAt, recoveryAt,
    'Browser reads must not postpone worker recovery');
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true, 'missed notification still recovers on the bounded periodic pass');
});

test('native activity bypasses the protected worker cooldown', async t => {
  const f = verifiedFixture(t);
  f.setGoal('blocked'); f.reconcile(); await f.codex.refreshSession(f.key, { readOnly: true });
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.ok(Number.isFinite(f.runtime.threadRefreshResult.get(f.key).recoveryAt));
  f.setGoal('complete');
  f.runtime.handleNotification('thread/goal/cleared', { threadId: 'synthetic' });
  await f.codex.refreshSession(f.key, { readOnly: true, fresh: true });
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
});

test('final protected history retains source-validated display without authorizing execution', async t => {
  const f = verifiedFixture(t);
  const file = join(f.runtime.options.defaultCwd, 'rollout.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
  (f.thread as any).path = file;
  f.setGoal('blocked'); f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  const cached = f.runtime.threadRefreshResult.get(f.key);
  assert.ok(cached.display);
  cached.at -= 10_000;
  const reads = f.methods.filter(method => method === 'thread/read').length;
  const execution = structuredClone(f.users.codexExecutions.get(f.key));
  const queue = f.users.turns.list('codex', f.key);
  for (let attempt = 0; attempt < 3; attempt++) await f.codex.refreshSession(f.key, { maxAgeMs: 1500, readOnly: true });
  assert.equal(f.methods.filter(method => method === 'thread/read').length, reads);
  assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
  assert.deepEqual(f.users.turns.list('codex', f.key), queue);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
  await f.codex.refreshSession(f.key, { maxAgeMs: 1500, readOnly: true, fresh: true });
  assert.ok(f.methods.filter(method => method === 'thread/read').length > reads);
});

test('cold restarted terminal reuses display while its original execution remains syncing', async t => {
  const f = await coldCheckpointFixture(t);
  const wakes = f.wakes();
  const file = join(f.runtime.options.defaultCwd, 'rollout.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
  (f.thread as any).path = file;
  f.users.codexExecutions.invalidateNativeHistory(f.key, 'restarted');
  const execution = structuredClone(f.users.codexExecutions.get(f.key));
  const queue = f.users.turns.list('codex', f.key);
  assert.equal(execution?.sync, 'syncing');
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.ok(f.runtime.threadRefreshResult.get(f.key).display);
  const reads = f.methods.filter(method => method === 'thread/read').length;
  for (let attempt = 0; attempt < 3; attempt++) {
    f.runtime.threadRefreshResult.get(f.key).at -= 10_000;
    await f.codex.refreshSession(f.key, { maxAgeMs: 1500, readOnly: true });
  }
  assert.equal(f.methods.filter(method => method === 'thread/read').length, reads);
  assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
  assert.deepEqual(f.users.turns.list('codex', f.key), queue);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.methods.includes('thread/resume'), false);
  assert.equal(f.methods.includes('turn/start'), false);
  assert.equal(f.wakes(), wakes);
  writeFileSync(file, JSON.stringify({ type: 'event_msg', changed: true }) + '\n', { flag: 'a' });
  f.runtime.threadRefreshResult.get(f.key).at -= 10_000;
  await f.codex.refreshSession(f.key, { maxAgeMs: 1500, readOnly: true });
  assert.ok(f.methods.filter(method => method === 'thread/read').length > reads);
  assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
});

for (const successors of [false, true]) test(`original FIFO recovers a restarted cold blocked Goal without maintenance pre-settlement (${successors ? 'successors' : 'owned-head'})`, async t => {
  const f = await coldCheckpointFixture(t, successors);
  f.setGoal('blocked');
  f.users.codexExecutions.invalidateNativeHistory(f.key, 'restarted');
  const previous = f.users.codexExecutions.get(f.key)!;
  assert.equal(previous.nativeHistory?.reason, 'restarted');
  assert.equal(previous.sync, 'syncing');
  for (const id of ['original-first', 'original-second', 'original-third']) {
    f.users.turns.enqueue('codex', { id, sessionKey: f.key, createdAt: 5,
      payload: { text: `Preserve ${id}`, images: [] } });
  }
  // Unlike the earlier blocked-Goal test, no maintenance reconciliation has
  // first converted the checkpoint to goal-blocked. Production must recover
  // the original restarted checkpoint and dispatch its original FIFO itself.
  for (let attempt = 0; attempt < 3 && !f.methods.includes('turn/start'); attempt++) {
    await f.runtime.turnWorker.options.reconcile(f.key);
  }
  assert.equal(f.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'new-owned');
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
  assert.ok(!f.methods.some(method => ['thread/goal/set', 'thread/goal/clear', 'thread/compact/start', 'thread/rollback'].includes(method)));
});

async function displayFixture(t: test.TestContext) {
  const f = await coldCheckpointFixture(t);
  const file = join(f.runtime.options.defaultCwd, 'display-rollout.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
  (f.thread as any).path = file;
  f.users.codexExecutions.invalidateNativeHistory(f.key, 'restarted');
  await f.codex.refreshSession(f.key, { readOnly: true });
  return { ...f, file };
}

test('unrelated native traffic does not discard a source-verified display checkpoint', async context => {
  const fixture = await displayFixture(context);
  const proof = await fixture.codex.prepareSessionDisplay(fixture.key);
  assert.ok(proof);
  const execution = structuredClone(fixture.users.codexExecutions.get(fixture.key));
  const reads = fixture.methods.length;
  fixture.runtime.handleNotification('item/agentMessage/delta', {
    threadId: 'unrelated', turnId: 'other-turn', itemId: 'other-item', delta: 'Other session output',
  });
  assert.equal(proof.current(), true);
  assert.equal(await proof.verify(), true);
  assert.ok(await fixture.codex.prepareSessionDisplay(fixture.key));
  assert.equal(fixture.methods.length, reads);
  assert.deepEqual(fixture.users.codexExecutions.get(fixture.key), execution);
  assert.equal(fixture.users.codexExecutions.canStart(fixture.key), false);
});

test('display proof remains independently readable while native recovery owns history readiness', async t => {
  const f = await displayFixture(t);
  const execution = structuredClone(f.users.codexExecutions.get(f.key)), queue = f.users.turns.list('codex', f.key);
  const reads = f.methods.length, wakes = f.wakes();
  let release!: () => void;
  const recovery = new Promise<void>(resolve => { release = resolve; });
  f.runtime.threadRefreshResult.delete(f.key);
  f.runtime.threadRefreshInflight.set(f.key, recovery);
  f.runtime.completingTurns.set(f.key, recovery);
  try {
    const proof = await f.codex.prepareSessionDisplay(f.key);
    assert.ok(proof);
    assert.equal(proof.current(), true);
    assert.equal(await proof.verify(), true);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.users.codexExecutions.canStart(f.key), false);
    assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
    assert.deepEqual(f.users.turns.list('codex', f.key), queue);
    assert.equal(f.methods.length, reads);
    assert.equal(f.wakes(), wakes);
  } finally { release(); f.runtime.threadRefreshInflight.delete(f.key); f.runtime.completingTurns.delete(f.key); }
});

for (const mutation of ['source', 'projection', 'execution', 'connection', 'runtime', 'activity', 'unknown', 'closed'] as const) {
  test(`display proof refuses changed ${mutation} before delivery without execution side effects`, async t => {
    const f = await displayFixture(t);
    const proof = await f.codex.prepareSessionDisplay(f.key);
    assert.ok(proof);
    const methods = f.methods.length, wakes = f.wakes();
    if (mutation === 'source') writeFileSync(f.file, JSON.stringify({ type: 'event_msg' }) + '\n', { flag: 'a' });
    if (mutation === 'projection') f.runtime.touchProjection(f.key);
    if (mutation === 'execution') f.users.codexExecutions.invalidateNativeHistory(f.key, 'changed');
    if (mutation === 'connection') f.runtime.setConnection('replacement');
    if (mutation === 'runtime') f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: { ...f.store.getSession(f.key)!.runtime!, threadActivity: 'running' } });
    if (mutation === 'activity') f.runtime.nativeUnscopedActivityEpoch++;
    if (mutation === 'unknown') {
      const read = f.runtime.readHistoryFact.bind(f.runtime);
      f.runtime.readHistoryFact = async (key: string) => ({ ...await read(key), outcomeUnknown: true });
    }
    if (mutation === 'closed') f.runtime.closed = true;
    try {
      if (mutation === 'closed') await assert.rejects(proof.verify());
      else assert.equal(await proof.verify(), false);
      if (mutation === 'closed') await assert.rejects(f.codex.prepareSessionDisplay(f.key));
      else assert.equal(await f.codex.prepareSessionDisplay(f.key), undefined);
      assert.equal(f.methods.length, methods);
      assert.equal(f.wakes(), wakes);
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
    } finally { if (mutation === 'closed') f.runtime.closed = false; }
  });
}

for (const sync of ['error', 'syncing'] as const) test(`cold ${sync} blocked-goal terminal with commandExecution items settles to current history without loading thread and skips unchanged periodic rollout reads`, async t => {
  const f = verifiedFixture(t);
  f.thread.turns.splice(1);
  f.thread.status.type = 'notLoaded';
  f.thread.turns[0].items.push({
    id: 'cmd-1',
    type: 'commandExecution',
    status: 'completed',
    command: 'echo ok',
    aggregatedOutput: 'ok\n',
    exitCode: 0,
  });
  const file = join(f.runtime.options.defaultCwd, 'rollout.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
  (f.thread as any).path = file;
  f.setGoal('blocked');
  if (sync === 'error') f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, sync);
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory, undefined);

  const request = f.runtime.request;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list' && f.thread.status.type === 'notLoaded') {
      throw new Error('thread not loaded');
    }
    return request(method);
  };

  let rolloutReads = 0;
  const originalReadProjected = f.runtime.rolloutReader.readProjectedSnapshotWithin.bind(f.runtime.rolloutReader);
  f.runtime.rolloutReader.readProjectedSnapshotWithin = async (...args: any[]) => {
    rolloutReads++;
    return originalReadProjected(...args);
  };

  await f.runtime.turnWorker.options.reconcile(f.key);
  const settled = f.users.codexExecutions.get(f.key)!;
  assert.equal(settled.sync, 'current');
  assert.equal(settled.nativeHistory?.state, 'blocked');
  assert.equal(settled.nativeHistory?.reason, 'goal-blocked');
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.ok(f.runtime.threadRefreshResult.get(f.key)?.display);
  const displayProof = await f.codex.prepareSessionDisplay(f.key);
  assert.ok(displayProof);
  assert.equal(await displayProof.verify(), true);
  assert.equal(f.methods.includes('thread/resume'), false);

  const readsBeforePeriodic = rolloutReads;
  f.runtime.threadRefreshResult.get(f.key).recoveryAt -= 30_001;
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(rolloutReads, readsBeforePeriodic, 'unchanged cold blocked-goal periodic recovery must not re-read the rollout file');
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'goal-blocked');
});

for (const activity of ['idle', 'active']) test(`initial completed history stays readable while a native terminal is ${activity}`, async t => {
  const f = verifiedFixture(t);
  f.thread.turns.splice(1);
  f.thread.status.type = activity;
  f.thread.turns[0].items.push({ id: 'cmd-1', type: 'commandExecution', status: 'completed', command: 'echo ok', exitCode: 0 });
  const file = join(f.runtime.options.defaultCwd, 'rollout.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
  (f.thread as any).path = file;
  f.terminals.push({ processId: 'process-1', itemId: 'cmd-1' });
  f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, 'background-work');
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.wakes(), 0);
  assert.match(JSON.stringify(f.store.getMessages(f.key)), /Reply tracked/);
  const display = await f.codex.prepareSessionDisplay(f.key);
  assert.ok(display, 'complete immutable history has a display-only proof even while execution is protected');
  assert.equal(await display.verify(), true);
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.ok(await f.codex.prepareSessionDisplay(f.key));
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  f.terminals.splice(0);
  f.thread.status.type = 'idle';
  f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, 'verified');
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.ok(f.methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)));
});

test("cold native-unavailable checkpoint with cached display proof still rehydrates and settles on worker reconcile", async t => {
  const f = await coldCheckpointFixture(t);
  const file = join(f.runtime.options.defaultCwd, "cold-display-rehydrate.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");
  (f.thread as any).path = file;
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.ok(f.runtime.threadRefreshResult.get(f.key)?.display, "read-only refresh caches display proof on cold blocked checkpoint");
  assert.equal(f.methods.includes("thread/resume"), false);
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, "blocked");
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.filter(method => method === "thread/resume").length, 1);
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.state, "verified");
  assert.equal(f.users.codexExecutions.get(f.key)?.nativeHistory?.reason, "settled");
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
});

test("unacknowledged preparing execution after connection replacement does not spin worker on unloaded terminal-cleanup proof", async t => {
  const f = verifiedFixture(t, "completed");
  f.setGoal("complete");
  f.reconcile();
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.users.codexExecutions.canStart(f.key), true);
  assert.equal(f.users.codexExecutions.begin(f.key, "cmd-prep-1", "connection", true), true);
  f.runtime.setConnection("replacement");
  f.thread.status.type = "notLoaded";
  const request = f.runtime.request;
  f.runtime.request = async (method: string, params: any) => {
    if (method === "thread/backgroundTerminals/list" && f.thread.status.type === "notLoaded") {
      throw new Error("thread not loaded");
    }
    return request(method, params);
  };
  f.methods.length = 0;
  await f.runtime.turnWorker.options.reconcile(f.key);
  assert.equal(f.methods.length, 0, "worker reconcile must not poll native history for an unacknowledged preparing execution");
  await assert.doesNotReject(f.codex.refreshSession(f.key));
  assert.equal(f.methods.includes("thread/backgroundTerminals/list"), false);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
});
