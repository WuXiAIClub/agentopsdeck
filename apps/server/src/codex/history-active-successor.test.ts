import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

for (const outcome of ['completed', 'failed'] as const) {
for (const goal of ['active', 'unavailable', 'absent'] as const) {
 for (const terminalGoal of ['absent', 'complete', 'paused'] as const) {
  test(`old terminal history remains readable during native continuation (${outcome}; ${goal} -> ${terminalGoal})`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-active-successor-'));
    const users = new ConnectorUserStore(':memory:');
    const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
    const key = 'codex:synthetic';
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
      defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
      executions: users.codexExecutions, authorizeTurn: () => true });
    const runtime = codex as any;
    // Exercise the original final reconciliation with an actual async storage
    // boundary, not just its synchronous compatibility path.
    let storageReads = 0;
    runtime.options.historyReader = { close: async () => {}, prepare: async (key: string, messages: any[]) => {
      const plan = runtime.prepareHistorySync(key, messages);
      await Promise.resolve(); storageReads++; return plan;
    } };
    runtime.ensureStarted = async () => {};
    runtime.setConnection('connection');
    store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'unknown',
      runtime: { turnId: 'tracked', phase: outcome, connection: 'connected', sync: 'error', lastEventAt: 1 } });
    users.codexExecutions.begin(key, 'command', 'connection');
    users.codexExecutions.acknowledge(key, 'command', 'connection', 'tracked', () => {});
    users.codexExecutions.observe(key, 'connection', 'tracked', outcome);
    users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: key, createdAt: 1,
      payload: { text: 'Do not resend', images: [] } });
    const queue = users.turns.list('codex', key);
    const methods: string[] = [];
    let wakes = 0;
    let settled = false;
    runtime.turnWorker.wake = () => { wakes++; };
    runtime.request = async (method: string) => {
      methods.push(method);
      const observedGoal = settled ? terminalGoal : goal;
      if (method === 'thread/goal/get') return observedGoal === 'absent' ? { goal: null } : observedGoal === 'unavailable' ? {} : {
        goal: { threadId: 'synthetic', status: observedGoal, createdAt: 1, updatedAt: settled ? 3 : 2,
          objective: 'Synthetic', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } };
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'History recovery must not launch, resume, cancel or resend');
      return { thread: { id: 'synthetic', status: { type: settled ? 'idle' : 'active' }, canAcceptDirectInput: settled, turns: [
        { id: 'tracked', status: outcome, itemsView: 'full', items: [
          { id: 'old-reply', type: 'agentMessage', text: 'Old completed response' }] },
        { id: 'continuation', status: settled ? 'completed' : 'inProgress', itemsView: 'full', items: [
          { id: 'new-reply', type: 'agentMessage', text: 'Goal continues' },
          { id: 'new-tool', type: 'mcpToolCall', status: settled ? 'completed' : 'inProgress', server: 'synthetic', tool: 'test' }] },
      ] } };
    };
    t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
    runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'tracked', outcome);
    await runtime.completingTurns.get(key);
    assert.equal(codex.isSessionHistoryReady(key), true);
    const fact = users.codexExecutions.get(key)!;
    assert.equal(fact.sync, 'current');
    assert.equal(fact.runId, 'tracked');
    assert.equal(fact.commandId, 'command');
    assert.equal(fact.nativeHistory?.state, 'blocked');
    assert.equal(fact.nativeHistory?.reason, goal === 'active' ? 'goal-active' : goal === 'unavailable' ? 'goal-unknown' : 'background-work');
    assert.equal(users.codexExecutions.canStart(key), false);
    assert.equal(store.getSession(key)?.runtime?.threadActivity, 'running');
    assert.equal(store.getSession(key)?.runtime?.sync, 'current');
    assert.ok(store.getMessages(key).some(message => message.text === 'Old completed response'));
    assert.ok(store.getMessages(key).some(message => message.text === 'Goal continues'));
    assert.ok(store.getMessages(key).some(message => message.role === 'tool' && message.status === 'sending'));
    assert.deepEqual(users.turns.list('codex', key), queue);
    assert.equal(wakes, 0);
    assert.equal(methods.filter(method => method === 'thread/read').length, 1, 'No five-read retry loop for a valid old terminal');
    // A natural stop is not permission by itself. Only independent native
    // availability, Goal, terminal list and repeated immutable reads release.
    settled = true;
    runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'tracked', outcome);
    await runtime.completingTurns.get(key);
    const terminal = users.codexExecutions.get(key)!;
    assert.equal(terminal.sync, 'current');
    assert.equal(terminal.runId, 'tracked');
    assert.equal(terminal.commandId, 'command');
    assert.equal(terminal.nativeHistory?.state, terminalGoal === 'paused' ? 'blocked' : 'verified');
    assert.equal(terminal.nativeHistory?.reason, terminalGoal === 'paused' ? 'goal-paused' : 'settled');
    assert.equal(users.codexExecutions.canStart(key), terminalGoal !== 'paused');
    assert.equal(wakes, terminalGoal === 'paused' ? 0 : 1);
    assert.equal(store.getSession(key)?.runtime?.threadActivity, 'idle');
    assert.deepEqual(users.turns.list('codex', key), queue, 'History verification never sends queued input');
    assert.equal(storageReads, 2, 'old-terminal and natural-stop reconciliation both use the async port');
  });
 }
}
}
