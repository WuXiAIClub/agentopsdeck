import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

for (const managed of [false, true]) for (const fault of ['rpc', 'schema']) {
  for (const superseded of ['none', 'notification', 'connection', 'command', ...(managed ? ['revision'] : [])]) {
    test(`${managed ? 'managed' : 'external'} ${fault} failure invalidates activity only without newer ${superseded} evidence`, async t => {
      const users = new ConnectorUserStore(':memory:'), store = new DeckStore(), key = 'codex:synthetic';
      const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
        defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
        authorizeTurn: () => true });
      const runtime = codex as any;
      runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {}; runtime.setConnection('connection');
      t.after(async () => { await codex.close(); users.close(); });
      store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running',
        runtime: { turnId: 'previous', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
      const turn = { id: 'previous', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Retained reply' }] };
      const snapshot = { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [turn] } };
      runtime.request = async (method: string) => { if (method === 'thread/backgroundTerminals/list') return { data: [] }; assert.equal(method, 'thread/read'); return snapshot; };
      if (managed) {
        users.codexExecutions.begin(key, 'original', 'connection');
        users.codexExecutions.acknowledge(key, 'original', 'connection', 'previous', () => {});
      }
      runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn });
      await runtime.completingTurns.get(key);
      const first = await codex.send(key, 'Original queued message'), second = await codex.send(key, 'Successor');
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read'); entered(); await released;
        if (fault === 'rpc') throw new Error('synthetic read failure');
        return { thread: { ...snapshot.thread, turns: null } };
      };
      const pending = codex.refreshSession(key).catch(error => error);
      await reading;
      if (superseded === 'notification') runtime.handleNotification('thread/status/changed', {
        threadId: 'synthetic', status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      });
      if (superseded === 'connection') runtime.setConnection('replacement');
      if (superseded === 'command') {
        assert.ok(users.codexExecutions.begin(key, 'new-command', 'connection'));
        assert.ok(users.codexExecutions.acknowledge(key, 'new-command', 'connection', 'new-turn', () => {}));
      }
      if (superseded === 'revision') assert.ok(users.codexExecutions.settleHistory(users.codexExecutions.get(key)!, 'error'));
      const before = store.getSession(key)!, fact = users.codexExecutions.get(key);
      release();
      assert.ok(await pending instanceof Error);
      assert.deepEqual(users.codexExecutions.get(key), fact, 'a read failure never rewrites execution facts');
      assert.equal(codex.isSessionHistoryReady(key), false);
      const current = store.getSession(key)!;
      assert.equal(current.runtime?.phase, before.runtime?.phase);
      assert.equal(current.runtime?.threadActivity, superseded === 'none' ? 'unknown' : before.runtime?.threadActivity);
      assert.ok(store.getMessages(key).some(message => message.text === 'Retained reply'));
      assert.deepEqual(users.turns.list('codex', key).map(item => item.id), [first.idempotencyKey, second.idempotencyKey]);
      if (superseded !== 'none') return;
      assert.equal(current.status, 'unknown'); assert.equal(current.hasActiveRun, true);
      let starts = 0;
      runtime.request = async (method: string) => {
        if (method === 'turn/start') { starts++; return { turn: { id: 'next-turn' } }; }
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read'); return snapshot;
      };
      await runtime.turnWorker.pass();
      assert.equal(starts, 1);
      assert.equal(users.codexExecutions.get(key)?.commandId, first.idempotencyKey);
      assert.equal(users.turns.head('codex', key), undefined);
      assert.deepEqual(users.codexExecutions.batchForRun(key, 'next-turn')?.members.map(member=>member.id),
        [first.idempotencyKey,second.idempotencyKey]);
    });
  }
}
