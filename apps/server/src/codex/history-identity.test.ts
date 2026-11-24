import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

const faults: Record<string, (thread: any) => void> = {
  'partial older turn': thread => { thread.turns[0].itemsView = 'partial'; },
  'partial final turn': thread => { thread.turns[1].itemsView = 'partial'; },
  'missing turn id': thread => { delete thread.turns[0].id; },
  'empty turn id': thread => { thread.turns[0].id = ''; },
  'numeric turn id': thread => { thread.turns[0].id = 1; },
  'whitespace turn id': thread => { thread.turns[0].id = ' older '; },
  'duplicate turn id': thread => { thread.turns[0].id = 'turn'; },
  'missing assistant id': thread => { delete thread.turns[1].items[0].id; },
  'empty assistant id': thread => { thread.turns[1].items[0].id = ''; },
  'numeric assistant id': thread => { thread.turns[1].items[0].id = 1; },
  'whitespace assistant id': thread => { thread.turns[1].items[0].id = ' reply '; },
  'duplicate item id': thread => { thread.turns[1].items.push({ id: 'reply', type: 'agentMessage', text: 'Overwrites first reply' }); },
  'cross-turn duplicate item id': thread => { thread.turns[0].items.push({ id: 'reply', type: 'agentMessage', text: 'Older overwritten reply' }); },
  'missing user id': thread => { thread.turns[1].items.push({ type: 'userMessage', content: [{ type: 'text', text: 'Anonymous input' }] }); },
  'missing tool id': thread => { thread.turns[1].items.push({ type: 'commandExecution', status: 'completed', command: 'synthetic' }); },
};

const collisions: Record<string, (thread: any) => void> = {
  'assistant/tool prefix collision': thread => { thread.turns[1].items.push(
    { id: 'tool-command-call', type: 'agentMessage', text: 'Overwritten by tool' },
    { id: 'command', type: 'commandExecution', status: 'completed', command: 'synthetic' }); },
  'assistant/failure prefix collision': thread => {
    thread.turns[0].status = 'failed'; thread.turns[0].error = { message: 'Synthetic failure' };
    thread.turns[1].items.push({ id: 'turn-failure-older', type: 'agentMessage', text: 'Overwrites failure' });
  },
  'user/assistant alias collision': thread => { thread.turns[1].items.push({ id: 'input', type: 'userMessage',
    clientId: 'codex:synthetic:codex-reply', content: [{ type: 'text', text: 'Overwrites assistant' }] }); },
  'cross-turn user alias collision': thread => {
    for (const [index, turn] of thread.turns.entries()) turn.items.push({ id: `input-${index}`, type: 'userMessage',
      clientId: 'repeated-client-id', content: [{ type: 'text', text: `Input ${index}` }] });
  },
};

function fixture(t: test.TestContext, managed: boolean) {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore(), key = 'codex:synthetic';
  let projections = 0, starts = 0;
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
    authorizeTurn: () => true, projectAssistant: async text => { projections++; return { text, media: [] }; } });
  const runtime = codex as any;
  runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {}; runtime.setConnection('connection');
  t.after(async () => { await codex.close(); users.close(); });
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running',
    runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
  if (managed) {
    users.codexExecutions.begin(key, 'original', 'connection');
    users.codexExecutions.acknowledge(key, 'original', 'connection', 'turn', () => {});
  }
  const thread = { id: 'synthetic', status: { type: 'idle' }, turns: [
    { id: 'older', status: 'completed', items: [] as any[] },
    { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'First reply' }] },
  ] };
  runtime.request = async (method: string) => {
    if (method === 'turn/start') { starts++; return { turn: { id: 'next-turn' } }; }
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read'); return { thread };
  };
  const complete = async () => {
    runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
    await runtime.completingTurns.get(key);
  };
  return { users, store, key, codex, runtime, thread, complete, counts: () => ({ projections, starts }) };
}

for (const managed of [false, true]) for (const path of ['ordinary', 'final']) for (const [fault, corrupt] of Object.entries({ ...faults, ...collisions })) {
  test(`${managed ? 'managed' : 'external'} ${path} history rejects ${fault} before publication and retains the queue`, async t => {
    const f = fixture(t, managed), valid = structuredClone(f.thread);
    if (path === 'ordinary') await f.complete();
    const first = await f.codex.send(f.key, 'Keep original input'), second = await f.codex.send(f.key, 'Keep successor');
    const before = f.store.getMessages(f.key), projected = f.counts().projections;
    corrupt(f.thread);
    if (path === 'ordinary') await assert.rejects(f.codex.refreshSession(f.key), /Invalid Codex thread history/);
    else { await f.complete(); assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error'); }
    if (fault in faults) assert.equal(f.counts().projections, projected, 'native identity validation precedes media and message projection');
    assert.deepEqual(f.store.getMessages(f.key), before);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    if (managed) {
      assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'original');
      assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'completed');
    }
    assert.deepEqual(f.users.turns.list('codex', f.key).map(item => item.id), [first.idempotencyKey, second.idempotencyKey]);
    assert.equal(f.counts().starts, 0);
    Object.assign(f.thread, valid);
    if (path === 'final') await f.complete();
    await f.runtime.turnWorker.pass();
    assert.equal(f.counts().starts, 1);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, first.idempotencyKey);
    assert.equal(f.users.turns.head('codex', f.key), undefined, 'both waiting messages were accepted in one turn');
    assert.deepEqual(f.users.codexExecutions.batchForRun(f.key, 'next-turn')?.members.map(member => member.id),
      [first.idempotencyKey, second.idempotencyKey]);
  });
}

for (const managed of [false, true]) test(`compatible ${managed ? 'managed' : 'external'} history keeps distinct equal-text items and ignores opaque extensions`, async t => {
  const f = fixture(t, managed);
  f.thread.turns[0]!.items.push({ type: 'futureKind', arbitrary: true });
  f.thread.turns[1]!.items.push({ id: 'second-reply', type: 'agentMessage', text: 'First reply' });
  await f.complete();
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.equal(f.store.getMessages(f.key).filter(message => message.text === 'First reply').length, 2);
});

for (const itemsView of [undefined, 'full']) test(`ordinary and final history accept ${itemsView ?? 'legacy omitted'} item views`, async t => {
  const f = fixture(t, false);
  for (const turn of f.thread.turns) Object.assign(turn, { itemsView });
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  await f.complete();
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'First reply'));
});
