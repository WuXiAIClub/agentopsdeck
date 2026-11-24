import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

async function fixture(phase: 'completed' | 'failed' | 'interrupted' = 'completed', queued = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-restart-sync-')), file = join(directory, 'connector.sqlite');
  const sessionKey = 'codex:synthetic', commandId = 'previous', runId = 'native';
  const previous = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  previous.codexExecutions.begin(sessionKey, commandId, 'old-connection');
  previous.codexExecutions.acknowledge(sessionKey, commandId, 'old-connection', runId, () => {});
  previous.codexExecutions.observe(sessionKey, 'old-connection', runId, phase);
  previous.codexExecutions.settleHistory({ sessionKey, commandId, runId }, 'current');
  if (queued) await previous.turns.enqueueAsync('codex', { id: 'successor', sessionKey, createdAt: 1, payload: { text: 'next request', images: [] } });
  previous.close();
  const database = new ConnectorUserStore(file, undefined, { runtimeOwner: true }), store = new DeckStore();
  assert.equal(database.codexExecutions.get(sessionKey)?.sync, 'current', 'old cache marker is persisted');
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent', defaultModel: 'test',
    approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, calls: string[] = [];
  runtime.connectionId = 'new-connection';
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  const history = { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
    { id: runId, status: phase, itemsView: 'full', items: [{ type: 'agentMessage', id: 'reply', text: 'Persisted native reply', phase: 'final_answer' }] },
  ] } };
  runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/goal/get') return { goal: null };
    assert.equal(method, 'thread/read'); return history;
  };
  return { database, store, sessionKey, runtime, codex, calls, history,
    close: async () => { await codex.close(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`Codex cold ${phase} reply is restored by the existing worker without a queue or browser`, async () => {
    const f = await fixture(phase);
    let deadline: NodeJS.Timeout | undefined;
    try {
      assert.equal(f.store.getMessages(f.sessionKey).length, 0);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.phase, phase);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.sync, 'syncing');
      const settled = new Promise<void>((resolve) => {
        const original = f.database.codexExecutions.settleHistory.bind(f.database.codexExecutions);
        f.database.codexExecutions.settleHistory = (expected, sync) => {
          const result = original(expected, sync);
          if (sync === 'current') resolve();
          return result;
        };
      });
      f.codex.startQueueWorker();
      await Promise.race([settled, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('worker did not restore cold reply')), 1500); })]);
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.deepEqual(f.calls, ['thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get', 'thread/read', 'thread/backgroundTerminals/list']);
      assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Persisted native reply' && message.role === 'assistant'));
      if (phase === 'failed') assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.status === 'failed'));
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.sync, 'current');
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.commandId, 'previous');
      assert.deepEqual(f.database.codexExecutions.recoveryPage('', 64), []);
    } finally { clearTimeout(deadline); await f.close(); }
  });

  test(`Codex queued successor cannot bypass cold ${phase} reply synchronization`, async () => {
    const f = await fixture(phase, true);
    f.store.upsertSession({ sessionKey: f.sessionKey, agentId: 'codex', title: 'Cold placeholder', status: 'idle' });
    try {
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.deepEqual(f.calls, []);
      assert.equal(f.database.turns.head('codex', f.sessionKey)?.state, 'queued');
      f.runtime.request = async (method: string) => {
        f.calls.push(method);
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        if (method === 'thread/goal/get') return { goal: null };
        if (method === 'thread/read') return f.history;
        assert.equal(method, 'turn/start');
        assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Persisted native reply'));
        return { turn: { id: 'successor-native' } };
      };
      await f.runtime.turnWorker.options.reconcile(f.sessionKey);
      assert.deepEqual(f.calls, ['thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get', 'thread/read', 'thread/backgroundTerminals/list', 'turn/start']);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.commandId, 'successor');
      assert.equal(f.database.turns.head('codex', f.sessionKey), undefined);
    } finally { await f.close(); }
  });
}

test('Codex unavailable cold history remains pending and never releases queued work', async () => {
  const f = await fixture('completed', true);
  f.runtime.request = async (method: string) => { f.calls.push(method); assert.equal(method, 'thread/read'); throw new Error('synthetic offline'); };
  try {
    await assert.rejects(f.runtime.turnWorker.options.reconcile(f.sessionKey), /synthetic offline/);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.deepEqual(f.calls, ['thread/read']);
    assert.equal(f.database.codexExecutions.get(f.sessionKey)?.sync, 'syncing');
    assert.equal(f.database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
    assert.equal(f.database.turns.head('codex', f.sessionKey)?.state, 'queued');
    assert.deepEqual(f.database.codexExecutions.recoveryPage('', 64), [f.sessionKey]);
  } finally { await f.close(); }
});

for (const invalid of ['foreign-thread', 'conflicting-terminal', 'partial-items', 'new-connection'] as const) {
  test(`Codex cold recovery rejects ${invalid} evidence and retains its queued successor`, async () => {
    const f = await fixture('completed', true);
    f.runtime.request = async (method: string) => {
      f.calls.push(method);
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      if (method === 'thread/goal/get') return { goal: null };
      assert.equal(method, 'thread/read');
      // The first refresh can populate a preview, but only final reconciliation
      // may certify it and release the durable queue.
      if (f.calls.length === 1) return f.history;
      const history = structuredClone(f.history);
      if (invalid === 'foreign-thread') history.thread.id = 'different';
      if (invalid === 'conflicting-terminal') history.thread.turns[0]!.status = 'failed';
      if (invalid === 'partial-items') history.thread.turns[0]!.itemsView = 'partial';
      if (invalid === 'new-connection') f.runtime.connectionId = 'replacement';
      return history;
    };
    try {
      await f.runtime.turnWorker.options.reconcile(f.sessionKey);
      await f.runtime.drainQueuedTurn(f.sessionKey);
      const fact = f.database.codexExecutions.get(f.sessionKey)!;
      assert.equal(fact.phase, 'completed');
      assert.equal(fact.commandId, 'previous');
      assert.equal(fact.sync, invalid === 'new-connection' ? 'syncing' : 'error');
      assert.equal(f.database.codexExecutions.canStart(f.sessionKey), false);
      assert.equal(f.database.turns.head('codex', f.sessionKey)?.state, 'queued');
      assert.deepEqual(f.database.codexExecutions.recoveryPage('', 64), [f.sessionKey]);
      assert.equal(f.calls.length, invalid === 'new-connection' ? 4 : 8);
    } finally { await f.close(); }
  });
}
