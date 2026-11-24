import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

function fixture() {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:synthetic';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic recovery', status: 'idle' });
  store.addMessage({ id: 'old-failure', sessionKey, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
  let authorized = true, projections = 0;
  const calls: string[] = [];
  const hooks = { at: (_stage: string) => {} };
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions,
    authorizeTurn: () => authorized, projectAssistant: async (text) => {
      projections++; hooks.at('projection');
      return { text, media: [] };
    } });
  const runtime = codex as any;
  runtime.connectionId = 'connection';
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  // Direct dispatch tests begin after the worker's validated predecessor read.
  runtime.threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  const history = { thread: { id: 'synthetic', turns: [
    { id: 'ok', status: 'completed', items: [{ type: 'agentMessage', id: 'reply', text: 'Keep completed edits' }] },
    { id: 'failed', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] },
  ] } };
  runtime.request = async (method: string) => {
    calls.push(method); hooks.at(method);
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/read') return history;
    assert.equal(method, 'thread/rollback'); return {};
  };
  // Only test the recovery boundary here; compaction evidence has its own tests.
  runtime.compactThread = async () => { calls.push('compact'); };
  return { database, store, sessionKey, runtime, codex, hooks, calls, history,
    projections: () => projections,
    revoke: () => { authorized = false; },
    recover: () => runtime.recoverPayloadTooLargeThread(sessionKey, 'synthetic', 'recovery-command', 'writer'),
    close: async () => { await codex.close(); database.close(); } };
}

for (const fault of ['systemError', 'rpc-failure', 'foreign-thread', 'missing-turns', 'null-turn', 'array-turn', 'missing-items', 'null-item',
  'partial-retained-turn', 'partial-trailing-turn',
  'missing-turn-id', 'duplicate-turn-id', 'missing-item-id', 'duplicate-item-id', 'cross-turn-item-id',
  'retained-prefix-collision', 'trailing-prefix-collision', 'retained-alias-collision', 'trailing-alias-collision', 'no-rollback-prefix-collision',
  'active-failed', 'active-completed', 'active-interrupted', 'waiting-failed', 'inProgress', 'in_progress', 'running', 'notLoaded-running', 'unknown-empty']) {
  test(`worker defers recovery on ${fault} before native mutation and recovers original command once`, async () => {
    const f = fixture();
    let reads = 0, starts = 0;
    const bad: any = structuredClone(f.history);
    if (fault === 'systemError') bad.thread.status = { type: 'systemError' };
    if (fault === 'foreign-thread') bad.thread.id = 'foreign';
    if (fault === 'missing-turns') delete bad.thread.turns;
    if (fault === 'null-turn') bad.thread.turns.unshift(null);
    if (fault === 'array-turn') bad.thread.turns.unshift([]);
    if (fault === 'missing-items') delete bad.thread.turns[0].items;
    if (fault === 'partial-retained-turn') bad.thread.turns[0].itemsView = 'partial';
    if (fault === 'partial-trailing-turn') bad.thread.turns[1].itemsView = 'partial';
    if (fault === 'null-item') bad.thread.turns[0].items.push(null);
    if (fault === 'missing-turn-id') delete bad.thread.turns[0].id;
    if (fault === 'duplicate-turn-id') bad.thread.turns[0].id = 'failed';
    if (fault === 'missing-item-id') delete bad.thread.turns[0].items[0].id;
    if (fault === 'duplicate-item-id') bad.thread.turns[0].items.push({ ...bad.thread.turns[0].items[0] });
    if (fault === 'cross-turn-item-id') bad.thread.turns[1].items.push({ ...bad.thread.turns[0].items[0] });
    if (fault.endsWith('-collision')) {
      const items = bad.thread.turns[fault.startsWith('retained-') ? 0 : 1].items;
      if (fault.includes('-prefix-')) items.push({ id: 'tool-command-call', type: 'agentMessage', text: 'Colliding assistant' },
        { id: 'command', type: 'commandExecution', status: 'completed', command: 'synthetic' });
      else for (const id of ['input-one', 'input-two']) items.push({ id, type: 'userMessage', clientId: 'shared-client-id',
        content: [{ type: 'text', text: id }] });
      if (fault.startsWith('no-rollback-')) bad.thread.turns.at(-1).status = 'completed';
    }
    if (fault.startsWith('active-') || fault === 'waiting-failed') {
      bad.thread.status = { type: 'active', activeFlags: fault === 'waiting-failed' ? ['waitingOnApproval'] : [] };
      bad.thread.turns.at(-1).status = fault.split('-')[1];
    }
    if (['inProgress', 'in_progress', 'running', 'notLoaded-running'].includes(fault)) {
      bad.thread.status = { type: fault === 'notLoaded-running' ? 'notLoaded' : 'idle' };
      bad.thread.turns.push({ id: 'external', status: fault === 'notLoaded-running' ? 'inProgress' : fault, items: [] });
    }
    if (fault === 'unknown-empty') bad.thread.turns = [];
    f.runtime.request = async (method: string) => {
      f.calls.push(method);
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      if (method === 'thread/read') {
        if (++reads === 2) {
          if (fault === 'rpc-failure') throw new Error('synthetic recovery read failure');
          return bad;
        }
        return f.history;
      }
      if (method === 'turn/start') { starts++; return { turn: { id: 'recovered' } }; }
      assert.equal(method, 'thread/rollback'); return {};
    };
    try {
      const first = await f.codex.send(f.sessionKey, 'preserve recovery input'), next = await f.codex.send(f.sessionKey, 'preserve successor');
      await f.runtime.turnWorker.pass();
      assert.deepEqual(f.calls, ['thread/read', 'thread/backgroundTerminals/list', 'thread/read'], 'unverified recovery history cannot authorize rollback, compact or turn/start');
      assert.equal(f.database.codexExecutions.get(f.sessionKey), undefined);
      assert.equal(f.codex.isSessionHistoryReady(f.sessionKey), false, 'a failed recovery read invalidates previously warm history');
      assert.deepEqual(f.database.turns.list('codex', f.sessionKey).map(({ id, state }) => ({ id, state })), [
        { id: first.idempotencyKey, state: 'queued' }, { id: next.idempotencyKey, state: 'queued' },
      ]);
      assert.ok(f.store.getMessages(f.sessionKey).some(message => message.id === first.idempotencyKey && message.text === 'preserve recovery input' && message.status === 'queued'));
      assert.ok(f.store.getMessages(f.sessionKey).some(message => message.text === 'Keep completed edits'));
      await f.runtime.turnWorker.pass();
      assert.equal(starts, 1);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.commandId, first.idempotencyKey);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.runId, 'recovered');
      assert.equal(f.database.turns.head('codex', f.sessionKey), undefined);
      assert.deepEqual(f.database.codexExecutions.batchForRun(f.sessionKey, 'recovered')?.members.map(member=>member.id),
        [first.idempotencyKey,next.idempotencyKey]);
    } finally { await f.close(); }
  });
}

for (const evidence of ['read-failure', 'native-active']) test(`recovery ${evidence} deferral survives a concurrent successful refresh before dispatch resumes`, async () => {
  const f = fixture(), recover = f.runtime.recoverPayloadTooLargeThread.bind(f.runtime);
  const request = f.runtime.request;
  let fail = true;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/read' && fail) {
      f.calls.push(method);
      if (evidence === 'read-failure') throw new Error('synthetic readonly failure');
      return { thread: { ...f.history.thread, status: { type: 'active' } } };
    }
    return request(method);
  };
  f.runtime.recoverPayloadTooLargeThread = async (...args: unknown[]) => {
    const result = await recover(...args);
    fail = false;
    await f.codex.refreshSession(f.sessionKey);
    return result;
  };
  try {
    const first = await f.codex.send(f.sessionKey, 'keep recovery');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(f.codex.isSessionHistoryReady(f.sessionKey), true);
    assert.deepEqual(f.calls, ['thread/read', 'thread/read', 'thread/backgroundTerminals/list']);
    assert.equal(f.database.codexExecutions.get(f.sessionKey), undefined);
    assert.equal(f.database.turns.head('codex', f.sessionKey)?.id, first.idempotencyKey);
    assert.equal(f.database.turns.head('codex', f.sessionKey)?.state, 'queued');
  } finally { await f.close(); }
});

for (const change of ['connection', 'revoke']) {
  test(`recovery read failure does not swallow ${change} fencing`, async () => {
    const f = fixture();
    f.runtime.request = async (method: string) => {
      f.calls.push(method);
      if (change === 'connection') f.runtime.setConnection('replacement');
      else f.revoke();
      throw new Error('synthetic readonly failure');
    };
    try {
      await assert.rejects(f.recover());
      assert.deepEqual(f.calls, ['thread/read']);
      assert.equal(f.database.codexExecutions.get(f.sessionKey), undefined);
      assert.equal(f.store.getMessages(f.sessionKey)[0]?.id, 'old-failure');
    } finally { await f.close(); }
  });
}

for (const stage of ['thread/read', 'projection']) for (const fault of ['readiness', 'projection-version']) {
  test(`recovery defers ${fault} change during ${stage} before claiming native preparation`, async () => {
    const f = fixture();
    const request = f.runtime.request;
    let starts = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'turn/start') { starts++; return { turn: { id: 'recovered' } }; }
      return request(method);
    };
    f.hooks.at = actual => {
      if (actual !== stage) return;
      if (fault === 'readiness') f.runtime.threadRefreshResult.delete(f.sessionKey);
      else f.runtime.touchProjection(f.sessionKey);
    };
    try {
      const first = await f.codex.send(f.sessionKey, 'keep recovery');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.deepEqual(f.calls, ['thread/read']);
      assert.equal(f.database.codexExecutions.get(f.sessionKey), undefined);
      assert.equal(f.database.turns.head('codex', f.sessionKey)?.id, first.idempotencyKey);
      assert.equal(f.database.turns.head('codex', f.sessionKey)?.state, 'queued');
      assert.equal(f.store.getMessages(f.sessionKey)[0]?.id, 'old-failure');
      f.hooks.at = () => {};
      await f.runtime.turnWorker.pass();
      assert.equal(starts, 1);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.commandId, first.idempotencyKey);
    } finally { await f.close(); }
  });
}

for (const stage of ['thread/read', 'projection', 'thread/rollback', 'history-storage-read']) {
  for (const change of ['connection', 'command', 'invalidation', 'closed', 'revoke']) {
    test(`Codex recovery fences ${change} during ${stage} before further mutation or projection`, async () => {
      const f = fixture(), before = f.store.getMessages(f.sessionKey);
      const ownsPreparation = stage === 'thread/rollback' || stage === 'history-storage-read';
      if (stage === 'history-storage-read') f.runtime.options.historyReader = {
        close: async () => {}, prepare: async (key: string, messages: any[]) => {
          const plan = f.runtime.prepareHistorySync(key, messages);
          await Promise.resolve(); f.hooks.at('history-storage-read'); return plan;
        },
      };
      f.hooks.at = (current) => {
        if (current !== stage) return;
        if (change === 'connection') f.runtime.setConnection('replacement');
        if (change === 'command') assert.equal(f.database.codexExecutions.begin(f.sessionKey, 'successor', 'connection'), !ownsPreparation);
        if (change === 'invalidation') f.runtime.executionUnavailable = true;
        if (change === 'closed') f.runtime.closed = true;
        if (change === 'revoke') f.revoke();
      };
      try {
        if (change === 'command' && ownsPreparation) {
          await f.recover();
          assert.deepEqual(f.calls, ['thread/read', 'thread/rollback', 'compact']);
          assert.equal(f.database.codexExecutions.get(f.sessionKey)?.commandId, 'recovery-command');
          assert.equal(f.database.codexExecutions.get(f.sessionKey)?.preparation, 'ready');
          return;
        }
        await assert.rejects(f.recover());
        assert.deepEqual(f.calls, ownsPreparation ? ['thread/read', 'thread/rollback'] : ['thread/read']);
        assert.deepEqual(f.store.getMessages(f.sessionKey), before, 'old history must not replace the current projection');
      } finally { await f.close(); }
    });
  }
}

for (const phase of ['starting', 'running', 'unknown', 'unsynced-terminal', 'legacy-active']) {
  test(`Codex recovery cannot read or mutate history while ${phase}`, async () => {
    const f = fixture();
    if (phase === 'legacy-active') f.runtime.activeTurnIds.set(f.sessionKey, 'unmanaged');
    else {
      f.database.codexExecutions.begin(f.sessionKey, 'previous', 'connection');
      if (phase === 'unknown') f.database.codexExecutions.uncertain(f.sessionKey, 'previous');
      if (phase === 'running' || phase === 'unsynced-terminal') f.database.codexExecutions.acknowledge(f.sessionKey, 'previous', 'connection', 'native', () => {});
      if (phase === 'unsynced-terminal') f.database.codexExecutions.observe(f.sessionKey, 'connection', 'native', 'completed');
    }
    try { await assert.rejects(f.recover()); assert.deepEqual(f.calls, []); }
    finally { await f.close(); }
  });
}

for (const kind of ['foreign-thread', 'missing-thread', 'missing-turns']) {
  test(`Codex recovery refuses ${kind} read evidence without history mutation`, async () => {
    const f = fixture();
    if (kind === 'foreign-thread') f.history.thread.id = 'foreign';
    if (kind === 'missing-thread') delete (f.history.thread as any).id;
    if (kind === 'missing-turns') delete (f.history.thread as any).turns;
    try {
      assert.equal(await f.recover(), false);
      assert.deepEqual(f.calls, ['thread/read']);
      assert.equal(f.store.getMessages(f.sessionKey)[0]?.id, 'old-failure');
    } finally { await f.close(); }
  });
}

test('Codex recovery rejects changed predecessor revision while reading history', async () => {
  const f = fixture();
  f.database.codexExecutions.begin(f.sessionKey, 'previous', 'connection');
  f.database.codexExecutions.acknowledge(f.sessionKey, 'previous', 'connection', 'previous-run', () => {});
  f.database.codexExecutions.observe(f.sessionKey, 'connection', 'previous-run', 'completed');
  const expected = { sessionKey: f.sessionKey, commandId: 'previous', runId: 'previous-run' };
  f.database.codexExecutions.settleHistory(expected, 'current');
  f.hooks.at = (stage) => { if (stage === 'thread/read') f.database.codexExecutions.settleHistory(expected, 'error'); };
  try { await assert.rejects(f.recover()); assert.deepEqual(f.calls, ['thread/read']); }
  finally { await f.close(); }
});

test('Codex recovery preserves context and replaces history only after matching rollback and projection', async () => {
  const f = fixture();
  try {
    assert.equal(await f.recover(), 'Keep completed edits');
    assert.deepEqual(f.calls, ['thread/read', 'thread/rollback', 'compact']);
    assert.deepEqual(f.store.getMessages(f.sessionKey).map((message) => message.text), ['Keep completed edits']);
    assert.equal(f.projections(), 1, 'context and retained history reuse one staged projection');
  } finally { await f.close(); }
});

test('staged recovery retains earlier non-payload failures by their turn identity', async () => {
  const f = fixture();
  f.history.thread.turns.unshift({ id: 'earlier-failure', status: 'failed', error: { message: 'Unrelated failure' }, items: [] });
  try {
    assert.equal(await f.recover(), 'Keep completed edits');
    assert.deepEqual(f.calls, ['thread/read', 'thread/rollback', 'compact']);
    assert.ok(f.store.getMessages(f.sessionKey).some(message => message.turnId === 'earlier-failure' && message.text === 'Unrelated failure'));
    assert.equal(f.store.getMessages(f.sessionKey).length, 2);
    assert.equal(f.projections(), 1);
  } finally { await f.close(); }
});

test('recovery overlays durable queue entries when native client aliases match pending input', async () => {
  const f = fixture();
  try {
    const first = await f.codex.send(f.sessionKey, 'Keep original input'), second = await f.codex.send(f.sessionKey, 'Keep successor');
    for (const [index, id] of [first.idempotencyKey, second.idempotencyKey].entries()) {
      (f.history.thread.turns[0]!.items as any[]).push({ id: `native-input-${index}`, type: 'userMessage', clientId: id,
        content: [{ type: 'text', text: 'Unverified historical echo' }] });
    }
    let compacted = false;
    let pendingMessages: ReturnType<typeof f.store.getMessages> = [];
    f.runtime.compactThread = async () => {
      compacted = true;
      pendingMessages = structuredClone(f.store.getMessages(f.sessionKey));
    };
    const request = f.runtime.request;
    f.runtime.request = async (method: string) => method === 'turn/start' ? { turn: { id: 'next-turn' } } : request(method);
    await f.runtime.turnWorker.pass();
    assert.equal(compacted, true);
    for (const [id, text, status] of [[first.idempotencyKey, 'Keep original input', 'outcome_unknown'],
      [second.idempotencyKey, 'Keep successor', 'outcome_unknown']]) {
      const message = pendingMessages.find(item => item.id === id)!;
      assert.equal(message.text, text); assert.equal(message.status, status);
    }
    assert.equal(f.database.codexExecutions.get(f.sessionKey)?.runId, 'next-turn');
    assert.equal(f.database.codexExecutions.get(f.sessionKey)?.commandId, first.idempotencyKey);
    assert.equal(f.database.turns.head('codex', f.sessionKey), undefined);
    assert.deepEqual(f.database.codexExecutions.batchForRun(f.sessionKey, 'next-turn')?.members.map(member=>member.id),
      [first.idempotencyKey,second.idempotencyKey]);
    assert.equal(f.store.getMessages(f.sessionKey).find(item => item.id === second.idempotencyKey)?.text, 'Keep successor');
  } finally { await f.close(); }
});

test('Codex recovery connection change before atomic claim preserves the waiting batch without native mutation', async () => {
  const f = fixture();
  f.hooks.at = (stage) => { if (stage === 'thread/read') f.runtime.setConnection('replacement'); };
  try {
    const first = await f.codex.send(f.sessionKey, 'explicit recovery'), next = await f.codex.send(f.sessionKey, 'next');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.deepEqual(f.calls, ['thread/read']);
    assert.deepEqual(f.database.turns.list('codex', f.sessionKey).map(({ id, state }) => ({ id, state })), [
      { id: first.idempotencyKey, state: 'queued' }, { id: next.idempotencyKey, state: 'queued' },
    ]);
    assert.equal(f.database.codexExecutions.get(f.sessionKey), undefined);
  } finally { await f.close(); }
});
