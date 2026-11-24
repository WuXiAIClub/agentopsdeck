import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { recordStoppedCodexRecovery } from './stopped-recovery.js';

async function fixture(acknowledged = true, queued = true) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-restarted-terminal-'));
  const file = join(directory, 'connector.sqlite'), sessionKey = 'codex:synthetic';
  const previous = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  try {
  previous.codexExecutions.begin(sessionKey, 'original-command', 'original-connection');
  if (acknowledged) previous.codexExecutions.acknowledge(sessionKey, 'original-command', 'original-connection', 'original-run', () => {});
  if (queued) await previous.turns.enqueueAsync('codex', { id: 'successor', sessionKey, createdAt: 1, payload: { text: 'next', images: [] } });
  } catch (error) {
    // Preserve the original setup failure while retiring its original DB.
    // Do not erase fixture evidence if either setup or close is unresolved.
    try { previous.close(); } catch { /* Original failure retains precedence. */ }
    throw error;
  }
  previous.close();
  const database = new ConnectorUserStore(file, undefined, { runtimeOwner: true }), store = new DeckStore();
  let authorized = true;
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions,
    authorizeTurn: () => authorized });
  const runtime = codex as any, calls: string[] = [];
  runtime.connectionId = 'replacement-connection';
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  const history = { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
    { id: 'original-run', status: 'completed', itemsView: 'full', items: [
      { type: 'agentMessage', id: 'reply', text: 'Persisted original reply', phase: 'final_answer' },
    ] },
  ] } };
  runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/read') return history;
    assert.equal(method, 'turn/start');
    assert.ok(store.getMessages(sessionKey).some(message => message.text === 'Persisted original reply'));
    return { turn: { id: 'successor-run' } };
  };
  return { database, store, codex, runtime, sessionKey, calls, history, directory,
    revoke: () => { authorized = false; },
    close: async () => { await codex.close(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const checkpoint of [false, true]) for (const sync of ['error', 'syncing'] as const)
test(`stopped proof preserves cold ${sync} history without loading or releasing execution (checkpoint=${checkpoint})`, async () => {
  const context = await fixture();
  try {
    const facts = context.database.codexExecutions;
    assert.equal(facts.recoverTerminal(facts.get(context.sessionKey)!, 'original-run', 'interrupted'), true);
    if (checkpoint) facts.invalidateNativeHistory(context.sessionKey, 'restarted');
    if (sync === 'error') facts.settleHistory(facts.get(context.sessionKey)!, 'error');
    context.history.thread.status = { type: 'notLoaded' };
    context.history.thread.turns[0]!.status = 'interrupted';
    const path = join(context.directory, 'stopped-display.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'session_meta' }) + '\n');
    Object.assign(context.history.thread, { path });
    const { sessionKey, commandId, connectionId, runId, revision } = facts.get(context.sessionKey)!;
    const db = (context.database as any).db;
    db.exec('PRAGMA synchronous=FULL');
    recordStoppedCodexRecovery(db, [{ sessionKey, commandId, connectionId, runId: runId!, revision }], {
      nodeId: context.database.nodeId, jobId: 'display-test-job', fenceId: 'display-test-empty-group',
      backupId: 'display-test-backup', verifiedAt: Date.now(),
    });
    const original = context.runtime.request;
    context.runtime.request = async (method: string, params: unknown) => {
      assert.notEqual(method, 'thread/resume');
      assert.notEqual(method, 'thread/backgroundTerminals/list');
      assert.notEqual(method, 'turn/start');
      if (method === 'thread/goal/get') return { goal: null };
      return original(method, params);
    };
    await context.codex.refreshSession(context.sessionKey, { fresh: true, readOnly: true });
    assert.ok(context.store.getMessages(context.sessionKey).some(message => message.text === 'Persisted original reply'));
    assert.ok(context.runtime.threadRefreshResult.get(context.sessionKey)?.display);
    assert.equal(facts.canStart(context.sessionKey), false);
    assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
    assert.equal(facts.cleanupRecovered(context.sessionKey, 'original-run'), true);
  } finally { await context.close(); }
});

test('stopped proof settles a cold interrupted session with a blocked Goal to sync current without loading or listing background terminals', async () => {
  const context = await fixture(true, false);
  try {
    const facts = context.database.codexExecutions;
    assert.equal(facts.recoverTerminal(facts.get(context.sessionKey)!, 'original-run', 'interrupted'), true);
    facts.invalidateNativeHistory(context.sessionKey, 'restarted');
    context.history.thread.status = { type: 'notLoaded' };
    context.history.thread.turns[0]!.status = 'interrupted';
    const path = join(context.directory, 'stopped-goal-blocked.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'session_meta' }) + '\n');
    Object.assign(context.history.thread, { path });
    const { sessionKey, commandId, connectionId, runId, revision } = facts.get(context.sessionKey)!;
    const db = (context.database as any).db;
    db.exec('PRAGMA synchronous=FULL');
    recordStoppedCodexRecovery(db, [{ sessionKey, commandId, connectionId, runId: runId!, revision }], {
      nodeId: context.database.nodeId, jobId: 'goal-blocked-job', fenceId: 'goal-blocked-empty-group',
      backupId: 'goal-blocked-backup', verifiedAt: Date.now(),
    });
    const original = context.runtime.request;
    context.runtime.request = async (method: string, params: unknown) => {
      assert.notEqual(method, 'thread/resume');
      assert.notEqual(method, 'thread/backgroundTerminals/list');
      assert.notEqual(method, 'turn/start');
      if (method === 'thread/goal/get') return { goal: { threadId: 'synthetic', status: 'blocked', objective: 'Blocked goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 } };
      return original(method, params);
    };
    await context.runtime.turnWorker.options.reconcile(context.sessionKey);
    const settled = facts.get(context.sessionKey)!;
    assert.equal(settled.phase, 'interrupted');
    assert.equal(settled.sync, 'current');
    assert.equal(settled.nativeHistory?.state, 'blocked');
    assert.equal(settled.nativeHistory?.reason, 'goal-blocked');
    assert.equal(context.codex.isSessionHistoryReady(context.sessionKey), true);
    await context.codex.refreshSession(context.sessionKey, { fresh: true, readOnly: true });
    assert.ok(context.runtime.threadRefreshResult.get(context.sessionKey)?.display);
    assert.equal(facts.canStart(context.sessionKey), false);
    assert.equal(context.database.turns.head('codex', context.sessionKey), undefined);
  } finally { await context.close(); }
});

test('stopped proof loads an interrupted sync-error thread before native terminal inspection', async () => {
  const context = await fixture();
  try {
    const facts = context.database.codexExecutions;
    assert.equal(facts.recoverTerminal(facts.get(context.sessionKey)!, 'original-run', 'interrupted'), true);
    facts.settleHistory(facts.get(context.sessionKey)!, 'error');
    context.history.thread.status = { type: 'notLoaded' };
    context.history.thread.turns[0]!.status = 'interrupted';
    const original = context.runtime.request;
    context.runtime.request = async (method: string, params: unknown) => {
      if (method === 'thread/resume') {
        context.calls.push(method);
        context.history.thread.status = { type: 'idle' };
        return context.history;
      }
      if (method === 'thread/backgroundTerminals/list') assert.equal(context.history.thread.status.type, 'idle');
      return original(method, params);
    };
    await context.codex.refreshSession(context.sessionKey);
    assert.equal(context.calls.includes('thread/resume'), false);
    const { sessionKey, commandId, connectionId, runId, revision } = facts.get(context.sessionKey)!;
    const db = (context.database as any).db;
    db.exec('PRAGMA synchronous=FULL');
    recordStoppedCodexRecovery(db, [{ sessionKey, commandId, connectionId, runId: runId!, revision }], {
      nodeId: context.database.nodeId, jobId: 'test-job', fenceId: 'test-empty-group', backupId: 'test-backup', verifiedAt: Date.now(),
    });
    await context.codex.recoverMaintenanceHistory(context.sessionKey, () => {});
    assert.ok(context.calls.includes('thread/resume'));
    assert.equal(facts.get(context.sessionKey)?.sync, 'current');
    assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
    assert.equal(context.calls.includes('turn/start'), false);
  } finally { await context.close(); }
});

test('maintenance terminal recovery synchronizes real projection without dispatching its queued successor', async () => {
  const context = await fixture();
  try {
    const facts = context.database.codexExecutions;
    assert.equal(facts.recoverTerminal(facts.get(context.sessionKey)!, 'original-run', 'completed'), true);
    assert.equal(facts.get(context.sessionKey)?.sync, 'syncing');
    await context.codex.recoverMaintenanceHistory(context.sessionKey, () => {});
    assert.equal(facts.get(context.sessionKey)?.sync, 'current');
    assert.equal(facts.get(context.sessionKey)?.commandId, 'original-command');
    assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
    assert.equal(context.calls.includes('turn/start'), false);
    assert.equal(context.codex.isSessionHistoryReady(context.sessionKey), true);
  } finally { await context.close(); }
});

test('maintenance recovers a completed sync-error terminal without rollout after native idle and terminal drain proof', async () => {
  const context = await fixture();
  try {
    const facts = context.database.codexExecutions;
    assert.equal(facts.recoverTerminal(facts.get(context.sessionKey)!, 'original-run', 'completed'), true);
    facts.settleHistory(facts.get(context.sessionKey)!, 'error');
    context.history.thread.status = { type: 'notLoaded' };
    (context.history.thread as any).path = join(context.directory, 'missing-rollout.jsonl');
    const request = context.runtime.request;
    let resumed = false;
    context.runtime.request = async (method: string, params: unknown) => {
      if (method === 'thread/resume') {
        resumed = true;
        return { thread: { ...context.history.thread, status: { type: 'idle' } } };
      }
      if (method === 'thread/read' && resumed) return { thread: { ...context.history.thread, status: { type: 'idle' } } };
      return request(method, params);
    };
    await context.codex.recoverMaintenanceHistory(context.sessionKey, () => {});
    assert.equal(facts.get(context.sessionKey)?.sync, 'current');
    assert.equal(facts.canStart(context.sessionKey), true);
    assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
    assert.equal(context.calls.includes('turn/start'), false);
    assert.equal(context.store.getSession(context.sessionKey)?.runtime?.sync, 'current');
    assert.equal(context.store.getSession(context.sessionKey)?.hasActiveRun, false);
    context.codex.startQueueWorker();
    for (let attempt = 0; attempt < 200 && !context.calls.includes('turn/start'); attempt++) await delay(10);
    assert.equal(context.calls.filter(call => call === 'turn/start').length, 1,
      'the preserved successor dispatches exactly once after recovery');
  } finally { await context.close(); }
});

test('maintenance recovery refuses unknown execution and revoked authority without native reads', async () => {
  const context = await fixture();
  try {
    await assert.rejects(context.codex.recoverMaintenanceHistory(context.sessionKey, () => {}), /durable terminal/);
    await assert.rejects(context.codex.recoverMaintenanceHistory(context.sessionKey, () => { throw new Error('revoked'); }), /revoked/);
    assert.deepEqual(context.calls, []);
  } finally { await context.close(); }
});

for (const toolType of ['custom_tool_call', 'function_call'] as const) {
  for (const toolName of ['exec', 'search'] as const) {
  for (const outcome of ['interrupted', 'completed', 'failed', 'background', 'unavailable'] as const) {
    test(`restarted ${outcome} with an unanswered ${toolName} ${toolType} preserves evidence and gates its successor`, async () => {
      const context = await fixture();
      const path = join(context.directory, 'rollout.jsonl');
      const history = context.history as any;
      history.thread.path = path;
      history.thread.turns[0].status = ['background', 'unavailable'].includes(outcome) ? 'interrupted' : outcome;
      const outputType = toolType === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output';
      writeFileSync(path, [
        { type: 'turn_context', payload: { turn_id: 'older-run' } },
        { type: 'response_item', payload: { type: toolType, call_id: 'older-tool', name: 'exec', input: 'older input' } },
        { type: 'turn_context', payload: { turn_id: 'original-run' } },
        { type: 'response_item', payload: { type: toolType, call_id: 'finished-tool', name: 'exec', input: 'finished input' } },
        { type: 'response_item', payload: { type: outputType, call_id: 'finished-tool', output: 'real output' } },
        { type: 'response_item', payload: { type: toolType, call_id: 'unanswered-tool', name: toolName, input: 'interrupted input', arguments: '{"command":"interrupted input"}', status: 'completed' } },
      ].map(entry => JSON.stringify(entry)).join('\n'));
      const request = context.runtime.request;
      context.runtime.request = async (method: string, params: unknown) => {
        if (method === 'thread/backgroundTerminals/list' && outcome === 'background') {
          return { data: [{ processId: 'process', itemId: 'unanswered-tool' }] };
        }
        if (method === 'thread/backgroundTerminals/list' && outcome === 'unavailable') throw new Error('Unavailable');
        return request(method, params);
      };
      try {
        await context.runtime.turnWorker.options.reconcile(context.sessionKey).catch(() => {});
        const messages = context.store.getMessages(context.sessionKey);
        const unanswered = messages.find(message => message.toolCallId === 'unanswered-tool');
        if (outcome === 'interrupted') {
          assert.equal(unanswered?.status, 'failed');
          assert.match(unanswered?.failureReason ?? '', /interrupted/i);
          assert.match(unanswered?.text ?? '', /interrupted input/);
          assert.equal(messages.some(message => message.toolCallId === 'unanswered-tool' && message.toolPhase === 'result'), false);
          assert.equal(messages.find(message => message.toolCallId === 'older-tool')?.status, 'sending');
          assert.equal(messages.find(message => message.toolCallId === 'finished-tool' && message.toolPhase === 'result')?.status, 'sent');
          if (toolName !== 'exec') {
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.commandId, 'successor');
            assert.equal(context.calls.filter(method => method === 'turn/start').length, 1);
            await context.runtime.turnWorker.options.reconcile(context.sessionKey).catch(() => {});
            assert.equal(context.calls.filter(method => method === 'turn/start').length, 1);
          } else {
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.commandId, 'original-command');
            assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
            assert.equal(context.calls.includes('turn/start'), false);
            // Transcript synchronization is independent from execution
            // admission: unproven cleanup must retain its explicit fence even
            // when the interrupted transcript has been delivered completely.
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.phase, 'interrupted');
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.sync, 'current');
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.nativeHistory?.state, 'blocked');
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.nativeHistory?.reason, 'cleanup-unconfirmed');
            assert.equal(context.database.codexExecutions.canStart(context.sessionKey), false);
            await context.runtime.turnWorker.options.reconcile(context.sessionKey).catch(() => {});
            assert.equal(context.calls.includes('turn/start'), false);
            assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.nativeHistory?.state, 'blocked');
            assert.equal(context.database.codexExecutions.get(context.sessionKey)?.nativeHistory?.reason, 'cleanup-unconfirmed');
            assert.equal(context.database.codexExecutions.canStart(context.sessionKey), false);
          }
        } else {
          assert.notEqual(unanswered?.status, 'failed');
          assert.equal(context.database.codexExecutions.get(context.sessionKey)?.commandId, 'original-command');
          assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
          assert.equal(context.calls.includes('turn/start'), false);
        }
      } finally { await context.close(); }
    });
  }
  }
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`restarted acknowledged ${phase} is read and synchronized before its successor runs`, async () => {
    const context = await fixture();
    context.history.thread.turns[0]!.status = phase;
    try {
      assert.deepEqual(context.database.codexExecutions.recoveryPage('', 64), [context.sessionKey]);
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.reason, 'restarted');
      await context.runtime.turnWorker.options.reconcile(context.sessionKey);
      assert.deepEqual(context.calls, phase === 'interrupted'
        ? ['thread/read', 'thread/backgroundTerminals/list', 'thread/read', 'thread/backgroundTerminals/list', 'turn/start']
        : ['thread/read', 'thread/backgroundTerminals/list', 'thread/read', 'thread/backgroundTerminals/list', 'turn/start']);
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.commandId, 'successor');
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.runId, 'successor-run');
    } finally { await context.close(); }
  });
}

test('revoked successor does not prevent read-only recovery of its original acknowledged run', async () => {
  const context = await fixture();
  context.revoke();
  try {
    await context.runtime.turnWorker.options.reconcile(context.sessionKey);
    const fact = context.database.codexExecutions.get(context.sessionKey)!;
    assert.equal(fact.commandId, 'original-command');
    assert.equal(fact.connectionId, 'original-connection');
    assert.equal(fact.phase, 'completed');
    assert.equal(fact.sync, 'current');
    assert.equal(fact.reason, undefined);
    assert.deepEqual(context.calls, ['thread/read', 'thread/backgroundTerminals/list', 'thread/read', 'thread/backgroundTerminals/list']);
    assert.equal(context.database.turns.head('codex', context.sessionKey)?.state, 'blocked');
  } finally { await context.close(); }
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`restarted acknowledged ${phase} loads only the exact terminal thread without replaying its command`, async () => {
    const context = await fixture();
    context.history.thread.turns[0]!.status = phase;
    let loaded = false;
    const request = context.runtime.request;
    context.runtime.request = async (method: string, params: unknown) => {
      if (method === 'thread/resume') {
        context.calls.push(method);
        assert.deepEqual(params, { threadId: 'synthetic', excludeTurns: true });
        assert.equal(context.database.codexExecutions.canStart(context.sessionKey), false);
        loaded = true;
        return { thread: { ...context.history.thread, turns: [] } };
      }
      if (method === 'thread/read' && !loaded) {
        context.calls.push(method);
        return { thread: { ...context.history.thread, status: { type: 'notLoaded' } } };
      }
      return request(method, params);
    };
    try {
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.reason, 'restarted');
      await context.runtime.turnWorker.options.reconcile(context.sessionKey);
      assert.deepEqual(context.calls, phase === 'interrupted'
        ? ['thread/read', 'thread/resume', 'thread/read', 'thread/backgroundTerminals/list',
          'thread/read', 'thread/backgroundTerminals/list', 'turn/start']
        : ['thread/read', 'thread/resume', 'thread/read', 'thread/backgroundTerminals/list', 'thread/read', 'thread/backgroundTerminals/list', 'turn/start']);
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.commandId, 'successor');
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.runId, 'successor-run');
    } finally { await context.close(); }
  });
}

for (const fault of ['unacknowledged', 'foreign-run', 'unfinished', 'preparation', 'lost-ack', 'active',
  'changed-run', 'changed-outcome', 'connection', 'revision', 'changed-read', 'missing-rollout', 'background'] as const) {
  test(`restarted unloaded terminal refuses ${fault} without releasing or replaying commands`, async () => {
    const context = await fixture(fault !== 'unacknowledged');
    const original = context.database.codexExecutions.get(context.sessionKey)!;
    const history: any = context.history;
    history.thread.turns[0].status = 'interrupted';
    if (fault === 'foreign-run') history.thread.turns[0].id = 'foreign';
    if (fault === 'unfinished') history.thread.turns[0].status = 'inProgress';
    if (fault === 'missing-rollout') history.thread.path = '/nonexistent/agentopsdeck-restarted-rollout.jsonl';
    if (fault === 'preparation') (context.database as any).db.prepare(`UPDATE connector_codex_executions
      SET fact = json_set(fact, '$.preparation', 'active') WHERE session_key = ?`).run(context.sessionKey);
    let reads = 0;
    context.runtime.request = async (method: string, params: unknown) => {
      context.calls.push(method);
      if (method === 'thread/read') return { thread: { ...history.thread,
        status: { type: ++reads === 1 ? 'notLoaded' : fault === 'changed-read' ? 'active' : 'idle' } } };
      if (method === 'thread/resume') {
        assert.deepEqual(params, { threadId: 'synthetic' });
        if (fault === 'lost-ack') throw new Error('Synthetic lost resume ACK');
        if (fault === 'connection') context.runtime.setConnection('replacement');
        if (fault === 'revision') (context.database as any).db.prepare(`UPDATE connector_codex_executions
          SET fact = json_set(fact, '$.revision', ?) WHERE session_key = ?`).run(original.revision + 1, context.sessionKey);
        return { thread: { ...history.thread, status: { type: fault === 'active' ? 'active' : 'idle' },
          turns: [{ ...history.thread.turns[0], id: fault === 'changed-run' ? 'foreign' : 'original-run',
            status: fault === 'changed-outcome' ? 'completed' : 'interrupted' }] } };
      }
      assert.equal(method, 'thread/backgroundTerminals/list');
      return { data: [{ processId: 'unbound-process', itemId: 'unbound-tool' }] };
    };
    try {
      await context.runtime.turnWorker.options.reconcile(context.sessionKey).catch(() => {});
      const fact = context.database.codexExecutions.get(context.sessionKey)!;
      assert.equal(fact.commandId, original.commandId);
      assert.equal(fact.runId, original.runId);
      assert.equal(fact.phase, 'unknown');
      assert.equal(context.database.codexExecutions.canStart(context.sessionKey), false);
      assert.equal(context.database.turns.head('codex', context.sessionKey)?.id, 'successor');
      assert.equal(context.calls.includes('turn/start'), false);
      assert.equal(context.calls.includes('thread/backgroundTerminals/terminate'), false);
      if (['unacknowledged', 'foreign-run', 'unfinished', 'preparation', 'missing-rollout'].includes(fault)) {
        assert.equal(context.calls.includes('thread/resume'), false);
      }
    } finally { await context.close(); }
  });
}

for (const fault of ['unacknowledged', 'foreign-thread', 'foreign-run', 'active', 'inProgress',
  'partial', 'missing-rollout', 'connection-race', 'revision-race', 'late-notification'] as const) {
  test(`restarted ${fault} evidence cannot release the original run or its successor`, async () => {
    const context = await fixture(fault !== 'unacknowledged');
    const expected = context.database.codexExecutions.get(context.sessionKey)!;
    const history: any = context.history;
    if (fault === 'foreign-thread') history.thread.id = 'foreign';
    if (fault === 'foreign-run') history.thread.turns[0].id = 'foreign';
    if (fault === 'active') history.thread.status.type = fault;
    if (fault === 'inProgress') history.thread.turns[0].status = 'inProgress';
    if (fault === 'partial') history.thread.turns[0].itemsView = 'partial';
    if (fault === 'missing-rollout') history.thread.path = '/nonexistent/agentopsdeck-restarted-rollout.jsonl';
    context.runtime.request = async (method: string) => {
      context.calls.push(method);
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      if (fault === 'connection-race') context.runtime.connectionId = 'raced-connection';
      if (fault === 'revision-race') (context.database as any).db.prepare(`UPDATE connector_codex_executions
        SET fact = json_set(fact, '$.revision', ?) WHERE session_key = ?`).run(expected.revision + 1, context.sessionKey);
      return history;
    };
    try {
      if (fault === 'late-notification') {
        context.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: history.thread.turns[0] });
      } else {
        await context.runtime.turnWorker.options.reconcile(context.sessionKey).catch(() => {});
      }
      const fact = context.database.codexExecutions.get(context.sessionKey)!;
      assert.equal(fact.phase, 'unknown');
      assert.equal(fact.reason, 'restarted');
      assert.equal(fact.commandId, 'original-command');
      if (fault === 'revision-race') assert.equal(fact.revision, expected.revision + 1);
      assert.equal(context.database.codexExecutions.canStart(context.sessionKey), false);
      assert.equal(context.database.turns.head('codex', context.sessionKey)?.state, 'queued');
      assert.equal(context.calls.includes('turn/start'), false);
      if (fault === 'unacknowledged') assert.deepEqual(context.database.codexExecutions.recoveryPage('', 64), []);
    } finally { await context.close(); }
  });
}

test('restarted terminal still needs a second consistent full history before releasing queued work', async () => {
  const context = await fixture();
  context.runtime.request = async (method: string) => {
    context.calls.push(method);
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    if (context.calls.length > 1) throw new Error('synthetic history unavailable');
    return context.history;
  };
  try {
    await context.runtime.turnWorker.options.reconcile(context.sessionKey);
    const fact = context.database.codexExecutions.get(context.sessionKey)!;
    assert.equal(fact.phase, 'completed');
    assert.equal(fact.sync, 'error');
    assert.equal(context.database.codexExecutions.canStart(context.sessionKey), false);
    assert.equal(context.database.turns.head('codex', context.sessionKey)?.state, 'queued');
    assert.deepEqual(context.calls, ['thread/read', 'thread/backgroundTerminals/list', ...Array(5).fill('thread/read')]);
  } finally { await context.close(); }
});

for (const fault of ['command', 'run', 'connection', 'revision', 'fenced', 'preparation'] as const) {
  test(`restarted terminal compare-and-set rejects changed ${fault}`, async () => {
    const context = await fixture();
    const expected = context.database.codexExecutions.get(context.sessionKey)!;
    try {
      if (fault === 'command') expected.commandId = 'foreign';
      if (fault === 'run') expected.runId = 'foreign';
      if (fault === 'connection') expected.connectionId = 'foreign';
      if (fault === 'revision') expected.revision++;
      if (fault === 'fenced' || fault === 'preparation') (context.database as any).db.prepare(`UPDATE connector_codex_executions
        SET fact = json_set(fact, ?, ?) WHERE session_key = ?`)
        .run(fault === 'fenced' ? '$.fenced' : '$.preparation', fault === 'fenced' ? 1 : 'active', context.sessionKey);
      assert.equal(context.database.codexExecutions.recoverTerminal(expected, 'original-run', 'completed'), false);
      assert.equal(context.database.codexExecutions.get(context.sessionKey)?.phase, 'unknown');
      if (fault === 'fenced' || fault === 'preparation') assert.deepEqual(context.database.codexExecutions.recoveryPage('', 64), []);
    } finally { await context.close(); }
  });
}
