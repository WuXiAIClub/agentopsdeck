import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodexGoal } from '@agentopsdeck/shared';
import { CodexAppServer } from './app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

const goal = { threadId: 'thread', objective: 'Finish the scoped task', status: 'active', tokenBudget: 1000,
  tokensUsed: 45, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 };

test('native goal observations distinguish explicit absence, unknown, zero and unlimited budget', () => {
  assert.equal(readCodexGoal({}, 'thread'), undefined);
  assert.equal(readCodexGoal({ goal: null }, 'thread'), null);
  for (const tokenBudget of [null, 0, 100]) {
    const result = readCodexGoal({ goal: { ...goal, tokenBudget, privateExtra: 'secret' } }, 'thread')!;
    assert.equal(result.tokenBudget, tokenBudget);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  for (const patch of [{ threadId: 'other' }, { status: 'invented' }, { objective: '' }, { tokenBudget: undefined },
    { tokensUsed: -1 }, { timeUsedSeconds: NaN }, { updatedAt: 0 }, { tokenBudget: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(readCodexGoal({ goal: { ...goal, ...patch } }, 'thread'), undefined);
  }
  const preview = readCodexGoal({ goal: { ...goal, objective: 'x'.repeat(3000) } }, 'thread')!;
  assert.equal(preview.objective.length, 2000); assert.equal(preview.objectiveTruncated, true);
});

test('goal notifications project counters without issuing RPCs, adopting turns or changing run outcome', async t => {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
    authorizeTurn: () => true });
  const runtime = codex as any;
  t.after(async () => { await codex.close(); users.close(); });
  runtime.ensureStarted = async () => { throw new Error('Must not start native'); };
  runtime.request = async () => { throw new Error('Must not poll'); };
  runtime.setConnection('connection');
  const sessionKey = 'codex:thread';
  store.upsertSession({ sessionKey, title: 'Test', agentId: 'codex', status: 'idle',
    runtime: { phase: 'completed', turnId: 'original', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  for (const status of ['active', 'blocked', 'paused', 'usageLimited', 'budgetLimited', 'complete']) {
    runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status } });
    assert.equal(store.getSession(sessionKey)?.codexGoal?.status, status);
    assert.equal(store.getSession(sessionKey)?.runtime?.turnId, 'original');
    assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'completed');
  }
  runtime.handleNotification('thread/goal/cleared', { threadId: 'thread' });
  assert.equal(store.getSession(sessionKey)?.codexGoal, null);
  runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal });
  runtime.setConnection('replacement');
  assert.equal(store.getSession(sessionKey)?.codexGoal, undefined, 'old native connection cannot certify a goal');
  assert.equal(users.codexExecutions.get(sessionKey), undefined, 'display never creates an execution');
});

for (const superseded of ['none', 'notification', 'clear', 'connection', 'close']) {
  test(`on-demand goal hydration is bounded and cannot overwrite newer ${superseded} evidence`, async t => {
    const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
      defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
      authorizeTurn: () => true });
    const runtime = codex as any, key = 'codex:thread';
    t.after(async () => { await codex.close(); users.close(); });
    runtime.setConnection('connection');
    store.upsertSession({ sessionKey: key, title: 'Test', agentId: 'codex', status: 'idle' });
    let release!: (value: unknown) => void, reads = 0;
    runtime.request = async (method: string, params: unknown, timeout: number) => {
      assert.equal(method, 'thread/goal/get'); assert.deepEqual(params, { threadId: 'thread' });
      assert.ok(timeout <= 2000); reads++;
      return new Promise(resolve => { release = resolve; });
    };
    const first = runtime.hydrateGoal(key), duplicate = runtime.hydrateGoal(key, true);
    assert.equal(first, duplicate); assert.equal(reads, 1);
    if (superseded === 'notification') runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'paused' } });
    if (superseded === 'clear') runtime.handleNotification('thread/goal/cleared', { threadId: 'thread' });
    if (superseded === 'connection') runtime.setConnection('replacement');
    if (superseded === 'close') await codex.close();
    release({ goal }); await first;
    assert.equal(store.getSession(key)?.codexGoal?.status, superseded === 'none' ? 'active' : superseded === 'notification' ? 'paused' : undefined);
    if (superseded === 'clear') assert.equal(store.getSession(key)?.codexGoal, null);
    if (superseded === 'none') { await runtime.hydrateGoal(key); assert.equal(reads, 1); }
    assert.equal(users.codexExecutions.get(key), undefined);
  });
}

test('optional goal read failure stays unknown without a retry loop; fresh read can recover', async t => {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
    authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:thread';
  t.after(async () => { await codex.close(); users.close(); });
  runtime.setConnection('connection');
  store.upsertSession({ sessionKey: key, title: 'Test', agentId: 'codex', status: 'idle' });
  let reads = 0;
  runtime.request = async () => { reads++; throw new Error('unsupported'); };
  await runtime.hydrateGoal(key); await runtime.hydrateGoal(key);
  assert.equal(reads, 1); assert.equal(store.getSession(key)?.codexGoal, undefined);
  runtime.request = async () => { reads++; return { goal }; };
  await runtime.hydrateGoal(key, true);
  assert.equal(reads, 2); assert.equal(store.getSession(key)?.codexGoal?.status, 'active');
});

for (const unavailable of ['malformed', 'unsupported', 'old-connection']) {
  test(`safety goal read ${unavailable} does not trigger redundant observation or suppress a new connection`, async t => {
    const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
      defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
      authorizeTurn: () => true });
    const runtime = codex as any, key = 'codex:thread';
    t.after(async () => { await codex.close(); users.close(); });
    runtime.setConnection('connection');
    store.upsertSession({ sessionKey: key, title: 'Test', agentId: 'codex', status: 'idle' });
    let reads = 0;
    runtime.request = async (method: string) => {
      assert.equal(method, 'thread/goal/get'); reads++;
      if (unavailable === 'unsupported') throw new Error('unsupported');
      if (unavailable === 'old-connection') runtime.setConnection('replacement');
      return {};
    };
    const check = () => {
      if (runtime.connectionId !== 'connection') throw new Error('connection changed');
    };
    const read = runtime.inspectNativeHistory({ id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [] }] }, {}, check);
    if (unavailable === 'old-connection') await assert.rejects(read, /connection changed/);
    else assert.equal((await read).reason, 'goal-unknown');
    assert.equal(store.getSession(key)?.codexGoal, undefined);
    runtime.request = async (method: string) => { assert.equal(method, 'thread/goal/get'); reads++; return { goal }; };
    await runtime.hydrateGoal(key);
    assert.equal(reads, unavailable === 'old-connection' ? 2 : 1);
    if (unavailable !== 'old-connection') await runtime.hydrateGoal(key, true);
    assert.equal(store.getSession(key)?.codexGoal?.status, 'active');
    assert.equal(users.codexExecutions.get(key), undefined);
  });
}

for (const kind of ['started', 'interacted', 'interrupted']) {
  test(`sub-agent ${kind} activity remains visible without declaring child completion`, async t => {
    const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
      defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
      authorizeTurn: () => true });
    const runtime = codex as any, key = 'codex:thread';
    t.after(async () => { await codex.close(); users.close(); });
    runtime.setConnection('connection');
    store.upsertSession({ sessionKey: key, title: 'Test', agentId: 'codex', status: 'running' });
    runtime.request = async () => { throw new Error('No RPC needed for activity projection'); };
    runtime.handleNotification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
    const item = { type: 'subAgentActivity', id: 'activity', kind, agentThreadId: 'child', agentPath: '/root/review', privateExtra: 'private payload' };
    for (const method of ['item/started', 'item/completed']) runtime.handleNotification(method, { threadId: 'thread', turnId: 'turn', item });
    const result = store.getMessages(key).find(message => message.toolName === 'subagent/activity' && message.toolPhase === 'result');
    assert.ok(result); assert.match(result.text, /not proof/); assert.ok(result.text.includes(kind));
    assert.ok(!result.text.includes('status: completed')); assert.ok(!result.text.includes('private payload'));
    assert.equal(store.getSession(key)?.runtime?.phase, 'running');
    assert.equal(users.codexExecutions.get(key), undefined);
  });
}

test('opening cached history hydrates goal once and preserves historical child activity', async t => {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
    authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:thread', calls: string[] = [];
  t.after(async () => { await codex.close(); users.close(); });
  runtime.ensureStarted = async () => {}; runtime.setConnection('connection');
  store.upsertSession({ sessionKey: key, title: 'Test', agentId: 'codex', status: 'idle' });
  runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/goal/get') return { goal };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    return { thread: { id: 'thread', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
      { type: 'subAgentActivity', id: 'activity', kind: 'interacted', agentThreadId: 'child', agentPath: '/root/review' },
    ] }] } };
  };
  await codex.refreshSession(key);
  await runtime.completingTurns.get(key);
  assert.equal(calls.filter(v => v === 'thread/goal/get').length, 0, 'internal history reads do not add optional metadata RPCs');
  const historyReads = calls.filter(v => v === 'thread/read').length;
  for (let i = 0; i < 3; i++) await codex.refreshSession(key, { readOnly: true, maxAgeMs: 60_000 });
  assert.equal(calls.filter(v => v === 'thread/goal/get').length, 1);
  assert.equal(calls.filter(v => v === 'thread/read').length, historyReads);
  assert.equal(store.getSession(key)?.codexGoal?.status, 'active');
  assert.ok(store.getMessages(key).some(v => v.toolName === 'subagent/activity' && v.text.includes('not proof')));
  assert.equal(users.codexExecutions.get(key), undefined);
});
