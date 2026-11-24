import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { projectRuntime, snapshotRuntime } from './run-state.js';
import { CodexExecutions } from './executions.js';

function memoryPersistence() {
  const db = new DatabaseSync(':memory:');
  return { turnQueue: new TurnQueue(db), executions: new CodexExecutions(db) };
}

function fixture() {
  const store = new DeckStore();
  const sessionKey = 'codex:thread';
  store.upsertSession({ sessionKey, agentId: 'codex', source: 'codex', title: 'Test', status: 'idle' });
  const codex = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(), enabled: true, command: 'codex', defaultCwd: '/tmp', defaultModel: 'test', approvalPolicy: 'never', store });
  const bridge = codex as any;
  bridge.connectionId = "synthetic-connection";
  bridge.ensureStarted = async () => undefined;
  bridge.loadedThreadIds.add('thread');
  // Direct dispatch tests begin after the worker's validated predecessor read.
  bridge.threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  const notify = (method: string, params: any) => bridge.handleNotification(method, { threadId: 'thread', ...params });
  return { store, sessionKey, codex, bridge, notify };
}

test('commentary from history cannot make an active Codex turn idle or bypass queue', async () => {
  const { store, sessionKey, codex, bridge, notify } = fixture();
  notify('turn/started', { turn: { id: 't1' } });
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'active' }, turns: [{ id: 't1', status: 'inProgress', items: [{ type: 'agentMessage', id: 'comment', text: 'Working', phase: 'commentary' }] }] } });
  await codex.refreshSession(sessionKey);
  assert.equal(store.getSession(sessionKey)?.status, 'running');
  assert.equal(store.getMessages(sessionKey)[0]?.phase, 'commentary');
  assert.equal(store.getMessages(sessionKey)[0]?.turnId, 't1');
  assert.equal((await codex.send(sessionKey, 'next')).status, 'queued');
});

test('late completed notification cannot end a different active turn', () => {
  const { store, sessionKey, bridge, notify } = fixture();
  notify('turn/started', { turn: { id: 'new' } });
  notify('turn/completed', { turn: { id: 'old', status: 'completed' } });
  assert.equal(bridge.activeTurnIds.get(sessionKey), 'new');
  assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'running');
});

test('slow history read cannot erase a message arriving while projection is pending', { timeout: 5000 }, async t => {
  const { store, sessionKey, codex, bridge, notify } = fixture();
  t.after(() => codex.close());
  let resolveRead!: (value: any) => void;
  let readStarted!: () => void;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  bridge.request = () => new Promise((resolve) => { resolveRead = resolve; readStarted(); });
  const refresh = codex.refreshSession(sessionKey);
  await reading;
  notify('turn/started', { turn: { id: 'live' } });
  notify('item/agentMessage/delta', { turnId: 'live', itemId: 'reply', delta: 'new message' });
  resolveRead({ thread: { id: 'thread', status: { type: 'idle' }, turns: [] } });
  await assert.rejects(refresh, /snapshot obsolete/);
  assert.equal(store.getMessages(sessionKey).at(-1)?.text, 'new message');
  assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'running');
});

test('stale list restore cannot overwrite the state of a newer turn', async () => {
  const { store, sessionKey, bridge, notify } = fixture();
  notify('turn/started', { turn: { id: 'new' } });
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'idle' }, turns: [{ id: 'old', status: 'completed', items: [] }] } });
  await bridge.restoreThread({ id: 'thread', status: { type: 'idle' }, preview: 'Test' });
  assert.equal(store.getSession(sessionKey)?.runtime?.turnId, 'new');
  assert.equal(store.getSession(sessionKey)?.status, 'running');
});

test('incomplete final snapshot is visible and retry can recover without losing the queue', async () => {
  const { store, sessionKey, codex, bridge, notify } = fixture();
  notify('turn/started', { turn: { id: 't1' } });
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'idle' }, turns: [] } });
  notify('turn/completed', { turn: { id: 't1', status: 'completed' } });
  assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'finalizing');
  await bridge.completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
  assert.equal(store.getSession(sessionKey)?.status, 'unknown');
  assert.equal((await codex.send(sessionKey, 'wait until the reply is synchronized')).status, 'queued');
  bridge.drainQueuedTurn = async () => undefined;
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'idle' }, turns: [{ id: 't1', status: 'completed', itemsView: 'full', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' }] }] } });
  await codex.refreshSession(sessionKey);
  await bridge.completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'completed');
  assert.equal(store.getMessages(sessionKey).filter((message) => message.role === 'assistant').at(-1)?.phase, 'final_answer');
  assert.equal(bridge.options.turnQueue.list('codex', sessionKey).length, 1);
});

test('concurrent idle sends both enter FIFO and only the worker creates a turn', async () => {
  const { sessionKey, codex, bridge } = fixture();
  let starts = 0;
  bridge.request = async (method: string) => { assert.equal(method, 'turn/start'); starts++; return { turn: { id: 'started' } }; };
  const results = await Promise.all([codex.send(sessionKey, 'one'), codex.send(sessionKey, 'two')]);
  assert.equal(starts, 0);
  assert.deepEqual(results.map((result) => result.status), ['queued', 'queued']);
  await Promise.all([bridge.drainQueuedTurn(sessionKey), bridge.drainQueuedTurn(sessionKey)]);
  assert.equal(starts, 1);
  assert.equal(bridge.options.turnQueue.head('codex', sessionKey), undefined);
  assert.deepEqual(bridge.options.executions.batchForRun(sessionKey, 'started').members.map((member: {id:string})=>member.id),
    results.map(result=>result.idempotencyKey));
});

test('queue entry survives until start acknowledgement, including failed dispatch', async () => {
  const { store, sessionKey, codex, bridge, notify } = fixture();
  notify('turn/started', { turn: { id: 'old' } });
  const queued = await codex.send(sessionKey, 'keep me');
  bridge.activeTurnIds.clear();
  store.upsertSession(projectRuntime(store.getSession(sessionKey)!, { phase: 'completed', connection: 'connected', sync: 'current', lastEventAt: 1 }));
  bridge.request = async () => {
    assert.equal(bridge.options.turnQueue.list('codex', sessionKey)[0].id, queued.idempotencyKey);
    assert.equal(bridge.options.turnQueue.list('codex', sessionKey)[0].state, 'dispatching');
    throw new Error('lost acknowledgement');
  };
  await bridge.drainQueuedTurn(sessionKey);
  assert.equal(bridge.options.turnQueue.list('codex', sessionKey)[0].state, 'outcome_unknown');
  assert.equal(store.getMessages(sessionKey).find((message) => message.id === queued.idempotencyKey)?.status, 'outcome_unknown');
});

test('inProgress tool history never fabricates a completed result', async () => {
  const { store, sessionKey, codex, bridge } = fixture();
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'active' }, turns: [{ id: 't1', status: 'inProgress', items: [{ id: 'tool', type: 'commandExecution', command: 'long job', status: 'inProgress' }] }] } });
  await codex.refreshSession(sessionKey);
  const messages = store.getMessages(sessionKey);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.status, 'sending');
  assert.equal(messages[0]?.turnId, 't1');
});

test('waiting and unloaded running threads remain busy, never idle', () => {
  assert.equal(snapshotRuntime({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } }, 1).phase, 'waiting');
  assert.equal(snapshotRuntime({ status: { type: 'notLoaded' }, turns: [{ id: 't', status: 'inProgress' }] }, 1).phase, 'unknown');
});

for (const status of [undefined, 'inProgress', 'completed', 'failed', 'interrupted']) {
  test(`systemError snapshot is unavailable, not a new ${status ?? 'missing'} turn outcome`, () => {
    const runtime = snapshotRuntime({ status: { type: 'systemError' }, turns: [{ id: 't', status }] }, 1);
    assert.equal(runtime.phase, 'unknown');
    assert.equal(runtime.sync, 'error');
    assert.equal(runtime.connection, 'connected', 'thread availability is not transport disconnection');
  });
}

test('live tools retain turn identity and a failed turn stops their executing indicator', () => {
  const { store, sessionKey, notify } = fixture();
  notify('turn/started', { turn: { id: 't1' } });
  notify('item/started', { turnId: 't1', item: { id: 'tool', type: 'commandExecution', command: 'job', status: 'inProgress' } });
  assert.equal(store.getMessages(sessionKey)[0]?.turnId, 't1');
  notify('turn/completed', { turn: { id: 't1', status: 'failed', error: { message: 'failed' } } });
  assert.equal(store.getMessages(sessionKey).find((message) => message.role === 'tool')?.status, 'failed');
});

test('a terminal snapshot with an executing tool is not reported as synchronized', async () => {
  const { store, sessionKey, bridge, notify } = fixture();
  notify('turn/started', { turn: { id: 't1' } });
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'idle' }, turns: [{ id: 't1', status: 'completed', items: [{ id: 'tool', type: 'commandExecution', command: 'job', status: 'inProgress' }] }] } });
  notify('turn/completed', { turn: { id: 't1', status: 'completed' } });
  await bridge.completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
});

test('repeated stable snapshots do not emit a self-triggering status refresh loop', async () => {
  const { store, sessionKey, codex, bridge } = fixture();
  bridge.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread', status: { type: 'active' }, turns: [{ id: 't1', status: 'inProgress', items: [] }] } });
  await codex.refreshSession(sessionKey);
  const tail = store.latestEventId();
  await codex.refreshSession(sessionKey);
  assert.equal(store.latestEventId(), tail);
});
