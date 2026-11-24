import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

for (const recovery of ['active', 'settled', 'unknown-goal', 'late-terminal'] as const) {
  test(`long Goal terminal history survives original database close/reopen (${recovery})`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-long-goal-reopen-'));
    const file = join(dir, 'connector.sqlite'), key = 'codex:synthetic';
    let users: ConnectorUserStore | undefined;
    let codex: CodexAppServer | undefined;
    t.after(async () => { await codex?.close(); users?.close(); rmSync(dir, { recursive: true, force: true }); });
    const open = (connection: string, state: typeof recovery) => {
      users = new ConnectorUserStore(file);
      const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
      codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
        defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
        executions: users.codexExecutions, authorizeTurn: () => true });
      const runtime = codex as any;
      runtime.ensureStarted = async () => { throw Error('Read-only recovery must not start native work'); };
      runtime.setConnection(connection);
      store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'unknown',
        runtime: { turnId: 'tracked', phase: 'completed', connection: 'connected', sync: 'error', lastEventAt: 1 } });
      const methods: string[] = [];
      let terminalReads = 0, wakes = 0;
      runtime.turnWorker.wake = () => { wakes++; };
      runtime.request = async (method: string) => {
        methods.push(method);
        if (method === 'thread/goal/get') return state === 'unknown-goal' ? {} : { goal: state === 'active' ? {
          threadId: 'synthetic', status: 'active', createdAt: 1, updatedAt: 2,
          objective: 'Synthetic', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } : null };
        if (method === 'thread/backgroundTerminals/list') {
          terminalReads++;
          return { data: state === 'late-terminal' && terminalReads > 1
            ? [{ processId: 'new-background-process', itemId: 'unattributed-command' }] : [] };
        }
        assert.equal(method, 'thread/read', 'Recovery cannot send, resume, interrupt or terminate');
        return { thread: { id: 'synthetic', status: { type: state === 'active' ? 'active' : 'idle' },
          canAcceptDirectInput: state !== 'active', turns: Array.from({ length: 65 }, (_, index) => ({
            id: index === 0 ? 'tracked' : `successor-${index}`,
            status: state === 'active' && index === 64 ? 'inProgress' : 'completed', itemsView: 'full',
            items: [{ id: `reply-${index}`, type: 'agentMessage', text: `Preserved response ${index}` }],
          })) } };
      };
      return { runtime, store, methods, terminalReads: () => terminalReads, wakes: () => wakes,
        reconcile: async () => {
          runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'tracked', 'completed');
          await runtime.completingTurns.get(key);
        } };
    };
    const first = open('original-connection', 'active');
    users!.codexExecutions.begin(key, 'original-command', 'original-connection');
    users!.codexExecutions.acknowledge(key, 'original-command', 'original-connection', 'tracked', () => {});
    users!.codexExecutions.observe(key, 'original-connection', 'tracked', 'completed');
    await users!.turns.enqueueAsync('codex', { id: 'preserved-input', sessionKey: key, createdAt: 1,
      payload: { text: 'Do not replay after recovery', images: [] } });
    const queue = users!.turns.list('codex', key);
    await first.reconcile();
    assert.equal(codex!.isSessionHistoryReady(key), true);
    assert.equal(users!.codexExecutions.get(key)?.nativeHistory?.reason, 'goal-active');
    assert.equal(users!.codexExecutions.canStart(key), false);
    assert.equal(first.wakes(), 0);
    assert.equal(first.store.getMessages(key).filter(message => message.role === 'assistant').length, 65);
    assert.ok(first.terminalReads() <= 3,
      `Thread-scoped terminal observation must not be repeated for every historical turn (${first.terminalReads()})`);
    const beforeClose = users!.codexExecutions.get(key)!;
    await codex!.close(); codex = undefined;
    users!.close(); users = undefined;

    const second = open('recovered-connection', recovery);
    const persisted = users!.codexExecutions.get(key)!;
    assert.equal(persisted.commandId, beforeClose.commandId);
    assert.equal(persisted.runId, beforeClose.runId);
    assert.equal(persisted.nativeHistory?.state, 'blocked', 'A new connection must re-prove, not reuse old verification');
    assert.deepEqual(users!.turns.list('codex', key), queue);
    await second.reconcile();
    assert.equal(codex!.isSessionHistoryReady(key), true);
    const recovered = users!.codexExecutions.get(key)!;
    assert.equal(recovered.sync, 'current');
    assert.equal(recovered.commandId, 'original-command');
    assert.equal(recovered.runId, 'tracked');
    assert.equal(recovered.nativeHistory?.connectionId, 'recovered-connection');
    assert.equal(recovered.nativeHistory?.state, recovery === 'settled' ? 'verified' : 'blocked');
    assert.equal(recovered.nativeHistory?.reason, recovery === 'settled' ? 'settled'
      : recovery === 'active' ? 'goal-active' : recovery === 'unknown-goal' ? 'goal-unknown' : 'background-work');
    assert.equal(users!.codexExecutions.canStart(key), recovery === 'settled');
    assert.equal(second.wakes(), recovery === 'settled' ? 1 : 0);
    assert.deepEqual(users!.turns.list('codex', key), queue, 'History verification never sends the preserved queue');
    assert.equal(second.store.getMessages(key).filter(message => message.role === 'assistant').length, 65);
    assert.ok(second.terminalReads() <= 3, 'Independent final proof is fresh but not per historical turn');
    assert.equal(second.methods.filter(method => method === 'thread/read').length, recovery === 'settled' ? 2 : 1);
  });
}
