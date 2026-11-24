import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
function fixture(t: TestContext) {
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const deck = new DeckStore(), key = 'codex:synthetic';
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Fixture', status: 'idle', codexGoal: null });
  const codex = new CodexAppServer({ enabled: true, command: 'never-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store: deck, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any; runtime.setConnection('lease');
  // Isolate native I/O, retain real startTurn/receive/queue/execution hooks.
  runtime.reconcileCompletedTurn = () => {};
  const emit = (live: boolean) => {
    const params = { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } };
    if (live) runtime.receive(JSON.stringify({ method: 'turn/completed', params }));
    else runtime.handleNotification('turn/completed', params);
  };
  const settle = (historyReady = true) => {
    users.codexExecutions.observe(key, 'lease', 'turn', 'completed');
    users.codexExecutions.settleNativeHistory(users.codexExecutions.get(key)!, {
      turnId: 'turn', fingerprint: 'a'.repeat(64), connectionId: 'lease', state: 'verified', reason: 'settled' });
    if (historyReady) deck.replaceMessages(key, [{ id: 'synthetic:completed', sessionKey: key,
      role: 'assistant', text: 'Synthetic completed history', status: 'sent', createdAt: Date.now(), updatedAt: Date.now() }]);
    runtime.threadRefreshResult.set(key, { at: Date.now(), available: true });
  };
  t.after(async () => { await codex.close(); users.close(); });
  return { codex, runtime, users, key, emit, settle };
}
for (const variant of ['live-before-ack', 'live-after-ack', 'history', 'foreign-owner', 'missing-owner', 'reconnect', 'missing-history'] as const) {
  test(`native completion hooks: ${variant}`, async t => {
    const f = fixture(t), actor = variant === 'missing-owner' ? undefined : 'owner';
    f.users.turns.enqueue('codex', { id: 'command', sessionKey: f.key, createdAt: Date.now(),
      payload: { text: 'synthetic', images: [], ...(actor ? { actorId: variant === 'foreign-owner' ? 'foreign' : actor } : {}) } });
    f.runtime.request = async (method: string) => { assert.equal(method, 'turn/start'); if (variant === 'live-before-ack') f.emit(true); return { turn: { id: 'turn' } }; };
    await f.runtime.startTurn(f.key, 'synthetic', [], 'command', actor);
    if (variant !== 'live-before-ack') f.emit(variant !== 'history');
    f.settle(variant !== 'missing-history');
    assert.equal(f.codex.isSessionHistoryReady(f.key), variant !== 'missing-history');
    if (variant === 'reconnect') f.runtime.setConnection('new');
    assert.equal(f.codex.takeAutomationCompletions('owner').length, variant.startsWith('live-') ? 1 : 0);
    assert.deepEqual(f.codex.takeAutomationCompletions('owner'), []);
  });
}
