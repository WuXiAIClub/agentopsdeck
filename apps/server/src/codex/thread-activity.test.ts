import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

for (const managed of [false, true]) for (const boundary of ['read', 'final', 'notification']) {
  for (const activity of ['running', 'waiting']) for (const outcome of ['completed', 'failed', 'interrupted']) {
    test(`${managed ? 'managed' : 'external'} ${outcome} remains terminal while ${boundary} observes thread ${activity}`, async t => {
      const users = new ConnectorUserStore(':memory:'), store = new DeckStore(), key = 'codex:synthetic';
      const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
        defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
        authorizeTurn: () => true });
      const runtime = codex as any;
      runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {};
      runtime.setConnection('connection');
      t.after(async () => { await codex.close(); users.close(); });
      store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running',
        runtime: { turnId: 'previous', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
      let active = false, starts = 0;
      const status = () => active ? { type: 'active', activeFlags: activity === 'waiting' ? ['waitingOnApproval'] : [] } : { type: 'idle' };
      const turn = { id: 'previous', status: outcome, items: [{ id: 'reply', type: 'agentMessage', text: 'Previous final reply' }] };
      runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        if (method === 'turn/start') { starts++; return { turn: { id: 'successor' } }; }
        assert.equal(method, 'thread/read');
        return { thread: { id: 'synthetic', status: status(), turns: [turn] } };
      };
      if (managed) {
        users.codexExecutions.begin(key, 'original', 'connection');
        users.codexExecutions.acknowledge(key, 'original', 'connection', 'previous', () => {});
      }
      runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn });
      await runtime.completingTurns.get(key);
      active = true;
      if (boundary === 'read') await codex.refreshSession(key);
      if (boundary === 'final') {
        runtime.reconcileCompletedTurn(key, 'synthetic', 1, 'previous', outcome);
        await runtime.completingTurns.get(key);
      }
      if (boundary === 'notification') {
        let refresh: Promise<void> | undefined;
        const original = codex.refreshSession.bind(codex);
        codex.refreshSession = (...args) => refresh = original(...args);
        runtime.handleNotification('thread/status/changed', { threadId: 'synthetic', status: status() });
        assert.equal(store.getSession(key)?.status, activity, 'native activity is visible before a refresh completes');
        assert.ok(refresh, 'notification must invoke the public refresh operation');
        await refresh;
      }
      const session = store.getSession(key)!;
      assert.equal(session.runtime?.phase, outcome, 'thread activity must not reopen the previous turn');
      assert.equal(session.runtime?.threadActivity, activity);
      assert.equal(session.runtime?.sync, 'current');
      assert.equal(session.status, activity);
      assert.equal(session.hasActiveRun, true);
      assert.equal(codex.isSessionHistoryReady(key), true, 'busy history remains readable');
      assert.ok(store.getMessages(key).some(message => message.text === 'Previous final reply'));
      if (managed) assert.equal(users.codexExecutions.get(key)?.phase, outcome);
      const first = await codex.send(key, 'Keep original queue input'), next = await codex.send(key, 'Keep successor');
      await runtime.turnWorker.pass();
      assert.equal(starts, 0, 'readable terminal history does not authorize dispatch on an active thread');
      assert.deepEqual(users.turns.list('codex', key).map(({ id, state }) => ({ id, state })), [
        { id: first.idempotencyKey, state: 'queued' }, { id: next.idempotencyKey, state: 'queued' },
      ]);
      active = false;
      await runtime.turnWorker.pass();
      assert.equal(starts, 1);
      assert.equal(users.codexExecutions.get(key)?.commandId, first.idempotencyKey);
      assert.equal(users.turns.head('codex', key), undefined);
      assert.deepEqual(users.codexExecutions.get(key)?.batch?.members.map(member=>member.id),
        [first.idempotencyKey,next.idempotencyKey]);
    });
  }
}

for (const managed of [false, true]) for (const boundary of ['read', 'final', 'connection']) for (const initial of ['idle', 'active']) {
  test(`${managed ? 'managed' : 'external'} ${boundary} cannot retain obsolete idle thread evidence after ${initial}`, async t => {
    const users = new ConnectorUserStore(':memory:'), store = new DeckStore(), key = 'codex:synthetic';
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
      defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
      authorizeTurn: () => true });
    const runtime = codex as any;
    runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {};
    runtime.setConnection('original-connection');
    t.after(async () => { await codex.close(); users.close(); });
    store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running',
      runtime: { turnId: 'previous', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
    const turn = { id: 'previous', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Final reply' }] };
    const snapshot = (type: string) => ({ thread: { id: 'synthetic', status: { type }, turns: [turn] } });
    runtime.request = async (method: string) => { if (method === 'thread/backgroundTerminals/list') return { data: [] }; assert.equal(method, 'thread/read'); return snapshot(initial); };
    if (managed) {
      users.codexExecutions.begin(key, 'original', 'original-connection');
      users.codexExecutions.acknowledge(key, 'original', 'original-connection', 'previous', () => {});
    }
    runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn });
    await runtime.completingTurns.get(key);
    if (boundary === 'connection') {
      runtime.setConnection(undefined);
      assert.equal(store.getSession(key)?.runtime?.threadActivity, 'unknown');
      assert.equal(store.getSession(key)?.hasActiveRun, true);
      assert.equal(codex.isSessionHistoryReady(key), false);
      runtime.setConnection('replacement-connection');
      assert.equal(store.getSession(key)?.runtime?.threadActivity, 'unknown');
      runtime.request = async (method: string) => { if (method === 'thread/backgroundTerminals/list') return { data: [] }; assert.equal(method, 'thread/read'); return snapshot('idle'); };
      await codex.refreshSession(key);
      assert.equal(store.getSession(key)?.runtime?.threadActivity, 'idle');
    } else {
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      let reads = 0;
      runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read');
        if (++reads === 1) { entered(); await released; return snapshot('idle'); }
        return snapshot('active');
      };
      const pending = boundary === 'read' ? codex.refreshSession(key).catch(error => error)
        : (runtime.reconcileCompletedTurn(key, 'synthetic', 1, 'previous'), runtime.completingTurns.get(key));
      await reading;
      runtime.handleNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'active', activeFlags: [] } });
      release();
      await pending;
      await runtime.threadRefreshInflight.get(key);
      assert.equal(store.getSession(key)?.runtime?.threadActivity, 'running');
      assert.equal(store.getSession(key)?.hasActiveRun, true, 'obsolete idle snapshot cannot release the queue');
    }
    assert.equal(store.getSession(key)?.runtime?.phase, 'completed');
    assert.ok(store.getMessages(key).some(message => message.text === 'Final reply'));
    if (managed) assert.equal(users.codexExecutions.get(key)?.phase, 'completed');
  });
}
