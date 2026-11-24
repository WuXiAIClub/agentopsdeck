import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectNativeChildren, nativeChildIds, rehydrateNativeChildren } from './child-drain.js';

const activity = (id = 'child') => ({ id: `activity-${id}`, type: 'subAgentActivity', kind: 'interacted', agentThreadId: id });
function fixture() {
  const calls: Array<{ method: string; id?: string }> = [];
  const threads: Record<string, any> = { child: { id: 'child', parentThreadId: 'parent', status: { type: 'idle' },
    turns: [{ id: 'turn', status: 'completed', itemsView: 'full', items: [{ id: 'reply', type: 'agentMessage', text: 'PRIVATE' }] }] } };
  const goals: Record<string, unknown> = {}, terminals: Record<string, unknown[]> = {};
  let loaded = ['child'], changed = false;
  const request = async (method: string, p: any) => {
    calls.push({ method, id: p.threadId });
    if (method === 'thread/loaded/list') return { data: loaded, nextCursor: null };
    if (method === 'thread/read') return { thread: structuredClone(threads[p.threadId]) };
    if (method === 'thread/goal/get') return { goal: goals[p.threadId] ?? null };
    if (method === 'thread/backgroundTerminals/list') return { data: terminals[p.threadId] ?? [], nextCursor: null };
    throw new Error('Unexpected mutation');
  };
  const check = () => { if (changed) throw new Error('activity changed'); };
  return { calls, threads, goals, terminals, request, check, setLoaded: (ids: string[]) => { loaded = ids; },
    invalidate: () => { changed = true; } };
}

test('completed child is proven twice without projecting content or reading unrelated loaded history', async () => {
  const f = fixture(); f.setLoaded(['child', 'unrelated-running']);
  assert.equal(await inspectNativeChildren('parent', [activity()], f.request, f.check), undefined);
  assert.equal(f.calls.filter(c => c.method === 'thread/read').length, 2);
  assert.ok(f.calls.every(c => !c.id || c.id === 'child'));
  assert.equal(JSON.stringify(f.calls).includes('PRIVATE'), false);
});

test('unloaded terminal child after restart needs explicit native absence and empty processes', async () => {
  const f = fixture(); f.setLoaded([]); f.threads.child.status.type = 'notLoaded';
  await inspectNativeChildren('parent', [activity()], f.request, f.check);
  f.terminals.child = [{ itemId: 'tool', processId: 'process' }];
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
});

test('empty child list makes no RPC; invalid and oversized structured references fail closed', async () => {
  const f = fixture(); await inspectNativeChildren('parent', [], f.request, f.check); assert.equal(f.calls.length, 0);
  for (const items of [[{ type: 'subAgentActivity' }], [{ type: 'collabToolCall', receiverThreadIds: [] }],
    [activity('bad\n')], Array.from({length:33}, (_,i) => activity(String(i)))]) assert.throws(() => nativeChildIds(items));
  assert.deepEqual(nativeChildIds([{ type: 'collabAgentToolCall', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } }]), ['child']);
});

for (const fault of ['active', 'unknown', 'wrong-id', 'wrong-parent', 'missing', 'partial', 'running-turn', 'empty-turns',
  'duplicate-turn', 'duplicate-item', 'goal', 'unknown-goal', 'background', 'loaded-mismatch', 'interrupted', 'pending-tool']) {
  test(`${fault} child stays protected even after a final assistant reply`, async () => {
    const f = fixture(), child = f.threads.child;
    if (fault === 'active') child.status.type = 'active';
    if (fault === 'unknown') child.status.type = 'systemError';
    if (fault === 'wrong-id') child.id = 'other';
    if (fault === 'wrong-parent') child.parentThreadId = 'other';
    if (fault === 'missing') delete f.threads.child;
    if (fault === 'partial') child.turns[0].itemsView = 'summary';
    if (fault === 'running-turn') child.turns[0].status = 'inProgress';
    if (fault === 'interrupted') child.turns[0].status = 'interrupted';
    if (fault === 'pending-tool') child.turns[0].items.push({ id: 'tool', type: 'commandExecution', status: 'inProgress' });
    if (fault === 'empty-turns') child.turns = [];
    if (fault === 'duplicate-turn') child.turns.push(structuredClone(child.turns[0]));
    if (fault === 'duplicate-item') child.turns[0].items.push(structuredClone(child.turns[0].items[0]));
    if (fault === 'goal') f.goals.child = { threadId: 'child', objective: 'Child task', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, status: 'active', createdAt: 1, updatedAt: 2 };
    if (fault === 'unknown-goal') f.goals.child = {};
    if (fault === 'background') f.terminals.child = [{ itemId: 'tool', processId: 'process' }];
    if (fault === 'loaded-mismatch') f.setLoaded([]);
    await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
  });
}

test('descendant ownership/terminal proof is recursive and cycles stay protected', async () => {
  const f = fixture(); f.threads.child.turns[0].items.push(activity('grandchild'));
  f.threads.grandchild = { ...structuredClone(f.threads.child), id: 'grandchild', parentThreadId: 'child' };
  f.threads.grandchild.turns[0].items = [];
  f.setLoaded(['child', 'grandchild']);
  await inspectNativeChildren('parent', [activity()], f.request, f.check);
  f.threads.grandchild.turns[0].items.push(activity('parent'));
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
  f.threads.grandchild.turns[0].items = [{ id: 'a-cycle', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'parent', agentPath: '/root' }];
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
});

test('root self-targeted /root subAgentActivity does not deadlock child drain while real children are still verified', async () => {
  const f = fixture();
  const rootSelf = { id: 'self-root', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'parent', agentPath: '/root' };
  await inspectNativeChildren('parent', [rootSelf], f.request, f.check);
  assert.equal(f.calls.length, 0);
  await inspectNativeChildren('parent', [rootSelf, activity('child')], f.request, f.check);
  assert.ok(f.calls.some(c => c.id === 'child'));
  // Missing /root path on parent ID still fails closed.
  await assert.rejects(inspectNativeChildren('parent', [activity('parent')], f.request, f.check));
});

for (const change of ['history', 'goal', 'activity', 'loaded', 'process']) test(`late ${change} invalidates child proof`, async () => {
  const f = fixture(); let reads = 0, lists = 0;
  await assert.rejects(inspectNativeChildren('parent', [activity()], async (method, params) => {
    if (method === 'thread/read' && ++reads === 2) {
      if (change === 'history') f.threads.child.turns[0].items[0].text = 'changed';
      if (change === 'goal') f.goals.child = { threadId: 'child', objective: 'Child task', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, status: 'complete', createdAt: 1, updatedAt: 2 };
      if (change === 'activity') f.invalidate();
      if (change === 'process') f.terminals.child = [{ itemId: 'tool', processId: 'process' }];
    }
    if (method === 'thread/loaded/list' && ++lists === 2 && change === 'loaded') f.setLoaded([]);
    return f.request(method, params);
  }, f.check));
});

test('unsupported queries, malformed pages, expired budget and activity invalidation never unlock', async () => {
  for (const method of ['thread/loaded/list', 'thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list']) {
    const f = fixture();
    await assert.rejects(inspectNativeChildren('parent', [activity()], (m,p) => m === method
      ? Promise.reject(new Error('unsupported')) : f.request(m,p), f.check));
  }
  const f = fixture();
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check, Date.now()-1));
  assert.equal(f.calls.length, 0);
  await assert.rejects(inspectNativeChildren('parent', [activity()], async () => ({data:['same','same']}), f.check));
});

test('native fork inheritance excludes old sibling references, not new child references', async () => {
  const f = fixture(), child = f.threads.child;
  child.forkedFromId = 'parent';
  child.turns.unshift({ id: 'parent-old-turn', status: 'completed', itemsView: 'full', items: [activity('sibling'),
    { id: 'inherited-tool', type: 'commandExecution', status: 'inProgress' }] });
  const parentTurns = new Set(['parent-old-turn']);
  await inspectNativeChildren('parent', [activity()], f.request, f.check, undefined, parentTurns);
  assert.ok(!f.calls.some(c => c.id === 'sibling'));
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
  child.turns[1].items.push(activity('new-child'));
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check, undefined, parentTurns));
});

for (const fault of ['other-fork', 'non-prefix', 'no-own-turn']) test(`ambiguous inherited history cannot unlock: ${fault}`, async () => {
  const f = fixture(), child = f.threads.child;
  child.forkedFromId = fault === 'other-fork' ? 'foreign' : 'parent';
  if (fault === 'non-prefix') child.turns.push({ id: 'parent-old', status: 'completed', itemsView: 'full', items: [] });
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check, undefined,
    new Set(fault === 'no-own-turn' ? ['turn'] : ['parent-old'])));
});

function coldFixture() {
  const f = fixture();
  f.threads.child.status.type = 'notLoaded'; f.threads.child.path = '/fixture/child.jsonl'; f.setLoaded([]);
  const request = async (method: string, params: any) => {
    if (method === 'thread/backgroundTerminals/list' && f.threads.child.status.type === 'notLoaded') throw Error('thread not found');
    if (method === 'thread/resume') {
      f.calls.push({ method, id: params.threadId }); f.threads.child.status.type = 'idle'; f.setLoaded(['child']);
      return { thread: structuredClone(f.threads.child) };
    }
    return f.request(method, params);
  };
  return { ...f, request, prepare: (validate = async (_path: unknown) => {}) => rehydrateNativeChildren(
    'parent', [activity()], request, () => f.check, validate, new Set(['parent-turn'])) };
}

test('cold preparation loads once; unsupported process query stays blocked until independent proof', async () => {
  const f = coldFixture();
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
  assert.equal(f.calls.some(c => c.method === 'thread/resume'), false);
  const paths: unknown[] = [];
  assert.equal(await f.prepare(async path => { paths.push(path); }), true);
  assert.deepEqual(paths, ['/fixture/child.jsonl']);
  // Loading is NOT drain evidence: a newly observed process still blocks.
  f.terminals.child = [{ itemId: 'tool', processId: 'process' }];
  await assert.rejects(inspectNativeChildren('parent', [activity()], f.request, f.check));
  delete f.terminals.child;
  await inspectNativeChildren('parent', [activity()], f.request, f.check);
  assert.equal(await f.prepare(), false);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
});

for (const fault of ['goal-active', 'path', 'history-change', 'goal-change', 'authority', 'activity']) {
  test(`cold preparation does not load unsafe child: ${fault}`, async () => {
    const f = coldFixture();
    if (fault === 'goal-active') f.goals.child = { threadId: 'child', objective: 'Child task', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, status: 'active', createdAt: 1, updatedAt: 2 };
    await assert.rejects(f.prepare(async () => {
      if (fault === 'path') throw Error('untrusted rollout');
      if (fault === 'history-change') f.threads.child.turns[0].items[0].text = 'late';
      if (fault === 'goal-change') f.goals.child = { threadId: 'child', objective: 'Child task', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, status: 'active', createdAt: 1, updatedAt: 2 };
      if (fault === 'authority' || fault === 'activity') f.invalidate();
    }));
    assert.equal(f.calls.some(c => c.method === 'thread/resume'), false);
  });
}

test('authority lost while loading never produces clearance', async () => {
  const f = coldFixture();
  await assert.rejects(rehydrateNativeChildren('parent', [activity()], async (m,p) => {
    const r = await f.request(m,p); if (m === 'thread/resume') f.invalidate(); return r;
  }, () => f.check, async () => {}, new Set()));
});
