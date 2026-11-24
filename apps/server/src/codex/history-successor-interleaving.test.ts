import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';

const scenarios = [
  { name: 'message delta during read', method: 'item/agentMessage/delta', stage: 'read', safe: true },
  { name: 'message delta during Goal proof', method: 'item/agentMessage/delta', stage: 'goal', safe: true },
  { name: 'message delta during rollout snapshot', method: 'item/agentMessage/delta', stage: 'rollout', safe: true },
  { name: 'message delta during delivered cleanup', method: 'item/agentMessage/delta', stage: 'cleanup', safe: true },
  { name: 'owned item during delivered cleanup', method: 'item/agentMessage/delta', stage: 'cleanup', safe: false, turn: 'tracked' },
  { name: 'connection changes during delivered cleanup', method: 'item/agentMessage/delta', stage: 'cleanup', safe: false, reconnect: true },
  { name: 'owned revision changes during delivered cleanup', method: 'item/agentMessage/delta', stage: 'cleanup', safe: false, revision: true },
  { name: 'successor ends during delivered cleanup', method: 'turn/completed', stage: 'cleanup', safe: false },
  { name: 'command output during read', method: 'item/commandExecution/outputDelta', stage: 'read', safe: true },
  { name: 'successor tool started during read', method: 'item/started', stage: 'read', safe: true },
  { name: 'successor tool completed during read', method: 'item/completed', stage: 'read', safe: true },
  { name: 'late owned item', method: 'item/agentMessage/delta', stage: 'read', safe: false, turn: 'tracked' },
  { name: 'unknown predecessor item', method: 'item/agentMessage/delta', stage: 'read', safe: false, turn: 'predecessor' },
  { name: 'new native head', method: 'turn/started', stage: 'read', safe: false },
  { name: 'successor natural completion', method: 'turn/completed', stage: 'read', safe: false },
  { name: 'unscoped event', method: 'item/agentMessage/delta', stage: 'read', safe: false, unscoped: true },
  { name: 'unknown event', method: 'item/unknown/delta', stage: 'read', safe: false },
  { name: 'connection changes', method: 'item/agentMessage/delta', stage: 'read', safe: false, reconnect: true },
  { name: 'owned revision changes', method: 'item/agentMessage/delta', stage: 'read', safe: false, revision: true },
  { name: 'unrelated verification failure', method: 'item/agentMessage/delta', stage: 'verification', safe: false, verificationFault: true },
  { name: 'contradictory turn aliases', method: 'item/agentMessage/delta', stage: 'read', safe: false, aliases: { turn: { id: 'different' } } },
  { name: 'contradictory thread object', method: 'item/agentMessage/delta', stage: 'goal', safe: false, aliases: { thread: { id: 'different' } } },
  { name: 'primary other thread cannot mask this thread', method: 'item/agentMessage/delta', stage: 'read', safe: false, aliases: { threadId: 'different', thread: { id: 'synthetic' } } },
  { name: 'contradictory nested turn scope', method: 'item/agentMessage/delta', stage: 'rollout', safe: false, aliases: { turn: { id: 'successor', threadId: 'different' } } },
  { name: 'contradictory item scope', method: 'item/started', stage: 'read', safe: false, aliases: { item: { threadId: 'different' } } },
  { name: 'matching redundant aliases', method: 'item/agentMessage/delta', stage: 'read', safe: true, aliases: { thread: { id: 'synthetic' }, turn: { id: 'successor', threadId: 'synthetic' }, item: { threadId: 'synthetic' } } },
] as const;

for (const scenario of scenarios) {
test(`owned terminal read remains protected with ${scenario.name}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-successor-interleave-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const key = 'codex:synthetic';
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('connection');
  let wakes = 0;
  runtime.turnWorker.wake = () => { wakes++; };
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'unknown',
    runtime: { turnId: 'tracked', phase: 'completed', connection: 'connected', sync: 'error', lastEventAt: 1 } });
  users.codexExecutions.begin(key, 'command', 'connection');
  users.codexExecutions.acknowledge(key, 'command', 'connection', 'tracked', () => {});
  users.codexExecutions.observe(key, 'connection', 'tracked', 'completed');
  users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: key, createdAt: 1, payload: { text: 'Do not resend', images: [] } });
  const queue = users.turns.list('codex', key);
  const emit = () => {
    runtime.handleNotification(scenario.method, {
      ...('unscoped' in scenario ? {} : { threadId: 'synthetic' }),
      turnId: 'turn' in scenario ? scenario.turn : 'successor',
      ...(['turn/started', 'turn/completed'].includes(scenario.method) ? { turn: { id: 'successor', status: 'completed' } } : {}),
      itemId: 'new-reply', delta: 'Still running',
      ...('aliases' in scenario ? scenario.aliases : {}),
    });
    if ('reconnect' in scenario) runtime.setConnection('new-connection');
    if ('revision' in scenario) {
      const before = users.codexExecutions.get(key)!;
      users.codexExecutions.settleHistory(before, before.sync === 'error' ? 'current' : 'error');
      assert.notEqual(users.codexExecutions.get(key)?.revision, before.revision,
        'Every read attempt must race a real owned revision change');
    }
    store.addMessage({ id: `${key}:codex-new-reply`, sessionKey: key, role: 'assistant', turnId: 'successor',
      text: 'Newer live content must survive', createdAt: 20, updatedAt: 30, status: 'sending' });
    store.addMessage({ id: 'newer-live-only', sessionKey: key, role: 'assistant', turnId: 'successor',
      text: 'Additional live content must survive', createdAt: 30, status: 'sending' });
  };
  if (scenario.stage === 'rollout') {
    const snapshot = runtime.rolloutReader.readSnapshot.bind(runtime.rolloutReader);
    runtime.rolloutReader.readSnapshot = async (...args: unknown[]) => { const result = await snapshot(...args); emit(); return result; };
  }
  if (scenario.stage === 'cleanup') {
    const retire = runtime.rolloutReader.disposeSnapshotWithin.bind(runtime.rolloutReader);
    runtime.rolloutReader.disposeSnapshotWithin = async (...args: unknown[]) => { emit(); return retire(...args); };
  }
  if ('verificationFault' in scenario) {
    runtime.inspectNativeHistory = async () => { emit(); throw new Error('Synthetic unexpected verification failure'); };
  }
  let reads = 0;
  runtime.request = async (method: string) => {
    if (method === 'thread/goal/get') { if (scenario.stage === 'goal') emit(); return { goal: null }; }
    assert.equal(method, 'thread/read');
    reads++;
    if (scenario.stage === 'read') emit();
    return { thread: { id: 'synthetic', status: { type: 'active' }, canAcceptDirectInput: false, turns: [
      { id: 'tracked', status: 'completed', itemsView: 'full', items: [{ id: 'old-reply', type: 'agentMessage', text: 'Original reply' }] },
      { id: 'successor', status: 'inProgress', itemsView: 'full', items: [{ id: 'new-reply', type: 'agentMessage', text: 'Continues' }] },
    ] } };
  };
  t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'tracked', 'completed');
  await runtime.completingTurns.get(key);
  const fact = users.codexExecutions.get(key)!;
  assert.equal(fact.runId, 'tracked');
  assert.equal(fact.commandId, 'command');
  assert.equal(fact.sync === 'current', scenario.safe);
  assert.equal(users.codexExecutions.canStart(key), false);
  assert.deepEqual(users.turns.list('codex', key), queue);
  assert.equal(runtime.terminalHistoryObservers.size, 0, 'No per-read observer retained after settlement');
  if (scenario.safe) {
    assert.equal(reads, 1);
    assert.equal(fact.nativeHistory?.state, 'blocked');
    assert.equal(fact.nativeHistory?.reason, 'background-work');
    assert.equal(fact.nativeHistory?.turnId, 'successor');
    assert.equal(store.getSession(key)?.runtime?.sync, 'current');
    assert.equal(store.getSession(key)?.runtime?.threadActivity, 'running');
    assert.ok(store.getMessages(key).some(message => message.text === 'Original reply'));
    assert.ok(store.getMessages(key).some(message => message.text === 'Newer live content must survive'));
    assert.ok(store.getMessages(key).some(message => message.text === 'Additional live content must survive'));
    assert.equal(wakes, 0, 'Readable predecessor proof never releases the send worker');
    for (let i = 0; i < 100; i++) runtime.handleNotification('item/agentMessage/delta', {
      threadId: 'synthetic', turnId: 'successor', itemId: 'new-reply', delta: 'Continues',
    });
    assert.equal(users.codexExecutions.get(key)?.revision, fact.revision, 'Known protected-head deltas do not churn SQL revisions');
    assert.equal(users.codexExecutions.get(key)?.sync, 'current');
    assert.equal(wakes, 0, 'Known protected-head deltas are not dispatch wake-ups');
  }
});
}
