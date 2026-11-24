import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

test('Codex drain after preparation read but before first mutation preserves the original queued command', async () => {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:synthetic';
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: database.turns,
    executions: database.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, calls: string[] = [];
  runtime.connectionId = 'connection'; runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {};
  runtime.threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle' });
  store.addMessage({ id: 'failed', sessionKey, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
  runtime.request = async (method: string) => {
    calls.push(method); assert.equal(method, 'thread/read', 'no native mutation may follow the stopped begin');
    database.stopTurnStarts();
    return { thread: { id: 'synthetic', turns: [{ id: 'old', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] }] } };
  };
  try {
    const sent = await codex.send(sessionKey, 'keep this exact input');
    await runtime.drainQueuedTurn(sessionKey);
    assert.deepEqual(calls, ['thread/read']);
    assert.equal(database.codexExecutions.get(sessionKey), undefined);
    assert.equal(database.turns.head('codex', sessionKey)?.id, sent.idempotencyKey);
    assert.equal(database.turns.head('codex', sessionKey)?.state, 'queued');
    assert.equal(store.getMessages(sessionKey).find(row => row.id === sent.idempotencyKey)?.text, 'keep this exact input');
    assert.equal(store.getMessages(sessionKey).find(row => row.id === sent.idempotencyKey)?.status, 'queued');
  } finally { await codex.close(); database.close(); }
});

for (const stage of ['thread/rollback', 'thread/compact/start', 'ready']) {
  for (const outcome of ['success', 'disconnect', 'revoke', 'rpc-failure', ...(stage === 'ready' ? ['history-failure', 'pending-history', 'drain'] : [])]) {
    test(`Codex durable preparation owns ${stage} through ${outcome}`, async () => {
      const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:synthetic';
      let authorized = true, release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const dispatched = new Promise<void>((resolve) => { entered = resolve; });
      let invalidating = false, readEntered!: () => void, releaseRead!: () => void;
      const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
      const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
      let refresh: Promise<void> | undefined;
      const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
        defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: database.turns,
        executions: database.codexExecutions, authorizeTurn: () => authorized });
      const runtime = codex as any, calls: string[] = [];
      runtime.connectionId = 'connection'; runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {};
      // Direct dispatch tests begin after the worker's validated predecessor read.
      runtime.threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
      if (stage === 'ready') {
        const recover = runtime.recoverPayloadTooLargeThread.bind(runtime);
        runtime.recoverPayloadTooLargeThread = async (...args: unknown[]) => {
          const context = await recover(...args);
          entered(); await blocked;
          if (outcome === 'rpc-failure') throw new Error('synthetic post-preparation failure');
          return context;
        };
      }
      store.upsertSession({ sessionKey, agentId: 'codex', title: 'Preparation fixture', status: 'idle' });
      store.addMessage({ id: 'old-failure', sessionKey, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
      database.codexExecutions.begin(sessionKey, 'predecessor', 'connection');
      database.codexExecutions.acknowledge(sessionKey, 'predecessor', 'connection', 'old-native', () => {});
      database.codexExecutions.observe(sessionKey, 'connection', 'old-native', 'failed');
      database.codexExecutions.settleHistory(database.codexExecutions.get(sessionKey)!, 'current');
      runtime.request = async (method: string) => {
        calls.push(method);
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        if (method === 'thread/read' && invalidating) {
          readEntered();
          if (outcome === 'history-failure') throw new Error('synthetic history failure');
          await heldRead;
        }
        if (method === stage) { entered(); await blocked; }
        if (method === stage && outcome === 'rpc-failure') throw new Error('synthetic RPC failure after possible mutation');
        if (method === 'thread/read') return { thread: { id: 'synthetic', turns: [
          { id: 'old-native', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] },
        ] } };
        if (method === 'thread/compact/start') {
          for (const event of ['item/started', 'item/completed']) runtime.handleNotification(event, {
            threadId: 'synthetic', turnId: 'compact', item: { id: 'compact-item', type: 'contextCompaction' }, startedAtMs: 1, completedAtMs: 2,
          });
          runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'compact', status: 'completed' } });
        }
        return method === 'turn/start' ? { turn: { id: 'new-native' } } : {};
      };
      let drain: Promise<void> | undefined;
      try {
        const first = await codex.send(sessionKey, 'explicit recovery');
        const batchMate = await codex.send(sessionKey, 'same recovery turn');
        drain = runtime.drainQueuedTurn(sessionKey);
        await dispatched;
        const next = await codex.send(sessionKey, 'successor');
        const preparation = database.codexExecutions.get(sessionKey)!;
        assert.equal(preparation.commandId, first.idempotencyKey, 'preparation cannot leave the predecessor as the execution owner');
        assert.equal(preparation.phase, 'starting');
        assert.equal(preparation.preparation, stage === 'ready' ? 'ready' : 'active');
        assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'starting');
        assert.equal(database.codexExecutions.canStart(sessionKey), false);
        assert.equal(database.codexExecutions.begin(sessionKey, next.idempotencyKey, 'connection'), false);
        // Pre-start native noise is not ACK evidence for the future user turn.
        runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'foreign' } });
        assert.deepEqual(database.codexExecutions.get(sessionKey), preparation);
        if (outcome === 'disconnect') runtime.setConnection('replacement');
        if (outcome === 'revoke') authorized = false;
        if (outcome === 'drain') database.stopTurnStarts();
        if (outcome === 'history-failure' || outcome === 'pending-history') {
          invalidating = true;
          refresh = assert.rejects(codex.refreshSession(sessionKey), /synthetic history failure|obsolete/);
          await readStarted;
          if (outcome === 'history-failure') await refresh;
          assert.equal(codex.isSessionHistoryReady(sessionKey), false);
        }
        release(); await drain;
        const fact = database.codexExecutions.get(sessionKey)!;
        if (outcome === 'success') {
          assert.deepEqual(calls, ['thread/read', 'thread/rollback', 'thread/compact/start', 'turn/start']);
          assert.equal(fact.phase, 'running'); assert.equal(fact.runId, 'new-native');
          assert.equal(fact.preparation, undefined);
          assert.deepEqual(fact.batch?.members.map(member=>member.id), [first.idempotencyKey,batchMate.idempotencyKey]);
          assert.equal(database.turns.head('codex', sessionKey)?.id, next.idempotencyKey);
        } else {
          assert.equal(fact.phase, 'unknown'); assert.equal(fact.reason, 'preparation_unknown');
          assert.equal(fact.runId, undefined);
          assert.deepEqual(database.turns.list('codex', sessionKey).map(({ id, state }) => ({ id, state })), [
            { id: first.idempotencyKey, state: 'outcome_unknown' }, { id: batchMate.idempotencyKey, state: 'outcome_unknown' },
            { id: next.idempotencyKey, state: 'queued' },
          ]);
          assert.deepEqual(calls, stage === 'thread/rollback' ? ['thread/read', 'thread/rollback']
            : ['thread/read', 'thread/rollback', 'thread/compact/start', ...(invalidating ? ['thread/read'] : [])]);
        }
        authorized = true;
        if (invalidating) {
          releaseRead(); await refresh; invalidating = false;
          await codex.refreshSession(sessionKey);
          assert.equal(codex.isSessionHistoryReady(sessionKey), true);
          assert.deepEqual(database.codexExecutions.get(sessionKey), fact, 'a fresh read cannot authorize replay of owned uncertain preparation');
        }
        const count = calls.length;
        await runtime.drainQueuedTurn(sessionKey);
        assert.equal(calls.length, count, 'neither running nor uncertain preparation may release its successor');
      } finally { release(); releaseRead(); await drain; await refresh; await codex.close(); database.close(); }
    });
  }
}

for (const boundary of ['begin-failure', 'finish-failure', 'retire-resources', 'unresolved-resources']) {
  test(`Codex recovery guards native mutation at ${boundary}`, async () => {
    const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:synthetic';
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
      defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: () => true });
    const runtime = codex as any, calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-preparation-resource-'));
    runtime.connectionId = 'connection'; runtime.ensureStarted = async () => {}; runtime.ensureThreadLoaded = async () => {};
    runtime.threadRefreshResult.set(sessionKey, { at: 0, available: true });
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle' });
    store.addMessage({ id: 'old-failure', sessionKey, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
    database.codexExecutions.begin(sessionKey, 'predecessor', 'connection');
    database.codexExecutions.acknowledge(sessionKey, 'predecessor', 'connection', 'old-native', () => {});
    database.codexExecutions.observe(sessionKey, 'connection', 'old-native', 'failed');
    database.codexExecutions.settleHistory(database.codexExecutions.get(sessionKey)!, 'current');
    if (boundary.endsWith('resources')) runtime.activeSecretFiles.set(sessionKey, {
      commandId: boundary === 'retire-resources' ? 'predecessor' : 'unproven-command', directory, dispatched: true,
    });
    const failJournal = () => (database as any).db.exec(`CREATE TRIGGER fail_codex_event BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END`);
    runtime.request = async (method: string) => {
      calls.push(method);
      if (method === 'thread/read') {
        if (boundary === 'begin-failure') failJournal();
        return { thread: { id: 'synthetic', turns: [{ id: 'old-native', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] }] } };
      }
      if (boundary === 'retire-resources') assert.equal(existsSync(directory), false, 'proven predecessor resources retire before native mutation');
      if (method === 'thread/compact/start') {
        for (const event of ['item/started', 'item/completed']) runtime.handleNotification(event, {
          threadId: 'synthetic', turnId: 'compact', item: { id: 'compact-item', type: 'contextCompaction' }, startedAtMs: 1, completedAtMs: 2,
        });
        runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'compact', status: 'completed' } });
        if (boundary === 'finish-failure') failJournal();
      }
      return method === 'turn/start' ? { turn: { id: 'new-native' } } : {};
    };
    try {
      await codex.send(sessionKey, 'explicit recovery');
      await codex.send(sessionKey, 'successor');
      await runtime.drainQueuedTurn(sessionKey);
      assert.deepEqual(calls, boundary === 'retire-resources' ? ['thread/read', 'thread/rollback', 'thread/compact/start', 'turn/start']
        : boundary === 'finish-failure' ? ['thread/read', 'thread/rollback', 'thread/compact/start'] : ['thread/read']);
      if (boundary === 'begin-failure' || boundary === 'unresolved-resources') assert.equal(database.codexExecutions.get(sessionKey)?.commandId, 'predecessor');
      if (boundary === 'unresolved-resources') assert.equal(existsSync(directory), true, 'unproven resources cannot be deleted');
      if (boundary === 'finish-failure') assert.equal(runtime.executionUnavailable, true, 'failed uncertainty persistence fences execution until recovery');
      if (boundary !== 'retire-resources') {
        // Persistent journal failure rolls the complete batch back. The owner
        // is fenced; original startup recovery, not a queue-only write, will
        // mark its dispatching rows unknown after physical reopen.
        const state = boundary === 'finish-failure' ? 'dispatching' : 'queued';
        assert.deepEqual(database.turns.list('codex', sessionKey).map(({ state }) => state), [state, state]);
        assert.equal(runtime.executionUnavailable, true, 'storage/resource failure cannot enter an automatic retry loop');
      }
      const before = calls.length;
      await runtime.drainQueuedTurn(sessionKey);
      assert.equal(calls.length, before, 'failure does not retry or release the successor');
    } finally { await codex.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
