import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InteractionStore } from '../commands/interaction-store.js';
import { InteractionRuntime } from '../commands/interaction-runtime.js';
import { CodexInteractionBridge } from './interaction-bridge.js';

const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'), store = new InteractionStore(db), runtime = new InteractionRuntime(store, () => true, undefined, Date.now, 20);
  const scope = { ownerId: 'owner', nodeId: 'node', sessionKey: 'codex:thread', runId: 'turn' };
  const writes: any[] = [], calls: { method: string; params: unknown }[] = [];
  let goal: unknown = null, connection: string | undefined = 'connection';
  let beforeRead = async () => {}, turns: unknown[] = [];
  const execution = { commandId: 'command', connectionId: 'connection', runId: 'turn', phase: 'running' };
  const bridge = new CodexInteractionBridge({ runtime, nodeId: scope.nodeId, connection: () => connection, execution: () => execution,
    permitted: () => true, request: async (method, params) => { calls.push({ method, params }); await beforeRead();
      return method === 'thread/turns/list' ? { data: turns } : { goal }; }, write: value => writes.push(value) });
  store.setMode(scope, 'interactive'); bridge.begin(scope.sessionKey, scope.ownerId, 'command', false);
  bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  const request = (extra: Record<string, unknown> = {}) => bridge.handle('item/commandExecution/requestApproval', 'rpc',
    { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'pwd', cwd: '/workspace', ...extra });
  const answer = (text?: string) => { const view = runtime.list(scope).find(v => v.status === 'pending')!;
    return runtime.answer({ scope: { ...scope, runId: view.request.runId }, requestId: view.request.requestId, responseId: view.request.requestId,
      expectedRevision: view.revision, answer: text ? { kind: 'text', text } : { kind: 'approval', decision: 'allow-once' }, authorize: () => true }); };
  t.after(() => { bridge.reset(); runtime.close(); db.close(); });
  return { bridge, runtime, scope, writes, calls, execution, request, answer, goal: (value: unknown) => { goal = value; },
    beforeRead: (value: () => Promise<void>) => { beforeRead = value; }, turns: (value: unknown[]) => { turns = value; },
    disconnect: () => { connection = undefined; bridge.reset(); } };
}
test('approval requires original native resolved ACK; duplicate started does not close it', async t => {
  const f = fixture(t); f.request(); await tick();
  f.bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  const result = f.answer(); await tick(); assert.deepEqual(f.writes, [{ id: 'rpc', result: { decision: 'accept' } }]);
  f.bridge.notification('serverRequest/resolved', { threadId: 'thread', requestId: 'rpc' });
  assert.equal((await result).delivery, 'confirmed');
});
test('missing ACK is unknown and does not redeliver approval', async t => {
  const f = fixture(t); f.request(); await tick(); assert.equal((await f.answer()).delivery, 'unknown');
  assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 1);
  assert.equal(f.writes.length, 1, 'timeout must never send a second JSON-RPC result/cancel');
});

test('completed ordinary turn releases retained owner', async t => {
  const f = fixture(t);
  f.bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
  await tick();
  f.bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'foreign' } });
  assert.equal(f.request({ turnId: 'foreign' }), false);
});

test('late completed-turn goal read cannot erase a running goal successor', async t => {
  const f = fixture(t);
  const goal = { threadId: 'thread', status: 'active', objective: 'Original', createdAt: 1, updatedAt: 2, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
  f.goal(goal);
  f.bridge.notification('thread/goal/updated', { threadId: 'thread', turnId: 'turn', goal });
  let release!: () => void;
  f.beforeRead(() => new Promise<void>(resolve => { release = resolve; }));
  f.bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
  f.bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'successor' } });
  f.beforeRead(async () => {});
  release(); await tick();
  assert.equal(f.request({ turnId: 'successor' }), true);
  await tick();
  assert.equal(f.runtime.list(f.scope)[0]?.request.runId, 'successor');
});

test('late completed-turn cleanup does not erase a replacement admitted owner', async t => {
  const f = fixture(t); let release!: () => void;
  f.beforeRead(() => new Promise<void>(resolve => { release = resolve; }));
  f.bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
  f.beforeRead(async () => {});
  f.execution.commandId = 'replacement';
  f.bridge.begin(f.scope.sessionKey, 'owner', 'replacement', false);
  f.bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  release(); await tick();
  assert.equal(f.request(), true); await tick();
  assert.equal(f.runtime.list(f.scope).length, 1);
});
test('multiple native questions preserve native IDs and send one combined response', async t => {
  const f = fixture(t);
  f.bridge.handle('item/tool/requestUserInput', 42, { threadId: 'thread', turnId: 'turn', itemId: 'item',
    questions: [{ id: 'one', question: 'First?' }, { id: 'two', question: 'Second?' }] });
  await tick(); assert.equal((await f.answer('A')).delivery, 'confirmed'); await tick(); assert.equal(f.writes.length, 0);
  const result = f.answer('B'); await tick();
  assert.deepEqual(f.writes, [{ id: 42, result: { answers: { one: { answers: ['A'] }, two: { answers: ['B'] } } } }]);
  f.bridge.notification('serverRequest/resolved', { threadId: 'thread', requestId: 42 });
  assert.equal((await result).delivery, 'confirmed');
});
for (const status of ['paused', 'usageLimited', 'budgetLimited']) test(`goal ${status} is not resumed by an answer`, async t => {
  const f = fixture(t); f.request(); await tick(); f.goal({ threadId: 'thread', status, createdAt: 1, updatedAt: 2,
    objective: 'Task', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 });
  await assert.rejects(f.answer()); assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
});
test('unknown successor cannot inherit actor; active goal successor can', async t => {
  const f = fixture(t);
  const goal = { threadId: 'thread', status: 'active', objective: 'Task', createdAt: 1, updatedAt: 2, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
  f.bridge.notification('thread/goal/updated', { threadId: 'thread', turnId: 'turn', goal });
  f.bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'successor' } });
  f.request({ turnId: 'successor' }); await tick(); assert.equal(f.runtime.list(f.scope).length, 0);
  f.goal(goal);
  f.bridge.handle('item/tool/requestUserInput', 'new-rpc', { threadId: 'thread', turnId: 'successor', itemId: 'item', questions: [{ id: 'q', question: 'Continue?' }] });
  await tick(); assert.equal(f.runtime.list(f.scope)[0]?.request.runId, 'successor');
});
test('additional permission grants are not silently downgraded to allow once', async t => {
  const f = fixture(t); f.request({ additionalPermissions: { network: true } }); await tick();
  assert.equal(f.runtime.list(f.scope).length, 0); assert.equal(f.writes[0]?.result.decision, 'cancel');
});
test('disconnect during delivery preserves uncertainty', async t => {
  const f = fixture(t); f.request(); await tick(); const result = f.answer(); await tick(); f.disconnect();
  assert.equal((await result).delivery, 'unknown');
});

test('active to blocked is a continuing goal; replacement must not receive the old answer', async t => {
  const f = fixture(t), goal = { threadId: 'thread', status: 'active', objective: 'Original', createdAt: 1, updatedAt: 2, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
  f.goal(goal); f.request(); await tick(); f.goal({ ...goal, status: 'blocked', updatedAt: 9, tokensUsed: 100 });
  const result = f.answer(); await tick();
  f.bridge.notification('serverRequest/resolved', { threadId: 'thread', requestId: 'rpc' });
  assert.equal((await result).delivery, 'confirmed');
  f.bridge.handle('item/tool/requestUserInput', 'next', { threadId: 'thread', turnId: 'turn', itemId: 'next', questions: [{ id: 'q', question: 'More?' }] });
  await tick(); f.goal({ ...goal, objective: 'Replacement' });
  await assert.rejects(f.answer('old answer'));
  assert.equal(f.writes.filter(v => v.id === 'next' && v.result).length, 0);
});
test('a replaced autonomous goal cannot inherit the original owner', async t => {
  const f = fixture(t), goal = { threadId: 'thread', status: 'active', objective: 'Original', createdAt: 1, updatedAt: 2, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
  f.bridge.notification('thread/goal/updated', { threadId: 'thread', turnId: 'turn', goal });
  f.bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'successor' } });
  f.goal({ ...goal, objective: 'Replacement' }); f.request({ turnId: 'successor' }); await tick();
  assert.equal(f.runtime.list(f.scope).length, 0);
});
for (const change of ['stopping', 'connection']) test(`execution ${change} during goal read rejects late answer`, async t => {
  const f = fixture(t); f.request(); await tick(); let resume!: () => void;
  f.beforeRead(() => new Promise<void>(resolve => { resume = resolve; }));
  const result = f.answer(), rejection = assert.rejects(result); await tick();
  if (change === 'stopping') f.execution.phase = 'stopping'; else f.execution.connectionId = 'replacement';
  resume(); await rejection; assert.equal(f.writes.filter(v => v.result?.decision === 'accept').length, 0);
});
test('native completion retires unknown delivery but never confirms it', async t => {
  const f = fixture(t); f.request(); await tick(); assert.equal((await f.answer()).delivery, 'unknown');
  assert.equal(f.runtime.store.hasUnresolvedSession(f.scope), true);
  f.bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
  assert.equal(f.runtime.store.hasUnresolvedSession(f.scope), false);
  assert.equal(f.runtime.list(f.scope)[0]!.delivery, 'unknown');
});
test('file approval reads only the exact latest turn and item, not full history', async t => {
  const f = fixture(t); f.turns([{ id: 'turn', items: [{ id: 'file', type: 'fileChange', changes: [{ path: '/workspace/a', kind: { type: 'update' }, diff: '+safe' }] }] }]);
  f.bridge.handle('item/fileChange/requestApproval', 'file-rpc', { threadId: 'thread', turnId: 'turn', itemId: 'file' });
  await tick(); assert.match(f.runtime.list(f.scope)[0]!.request.prompt, /workspace\/a/);
  assert.deepEqual(f.calls.find(c => c.method === 'thread/turns/list')?.params,
    { threadId: 'thread', limit: 1, sortDirection: 'desc', itemsView: 'full' });
  assert.equal(f.calls.some(c => c.method === 'thread/read'), false);
});
