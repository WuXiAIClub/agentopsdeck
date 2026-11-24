import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { observeCompaction, type CompactionEvidence } from './compaction.js';

// Static protocol shapes exported by Codex 0.147.0. No native server or host state.
function fixture() {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:synthetic';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic compact', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns,
    executions: database.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  runtime.connectionId = 'connection';
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  runtime.reconcileCompletedTurn = () => {};
  let requests = 0;
  runtime.request = async (method: string) => { assert.equal(method, 'thread/compact/start'); requests++; return {}; };
  const notify = (method: string, params: any) => runtime.handleNotification(method, { threadId: 'synthetic', ...params });
  const item = (method: 'item/started' | 'item/completed', turnId = 'compact-turn', id = 'compact-item', type = 'contextCompaction') =>
    notify(method, { turnId, item: { id, type }, ...(method === 'item/started' ? { startedAtMs: 1 } : { completedAtMs: 2 }) });
  const terminal = (id = 'compact-turn', status = 'completed') => notify('turn/completed', { turn: { id, status } });
  const start = () => {
    let result: 'pending' | 'completed' | Error = 'pending';
    const promise = runtime.compactThread('synthetic').then(() => { result = 'completed'; }, (error: Error) => { result = error; });
    return { promise, result: () => result };
  };
  return { database, store, sessionKey, codex, runtime, notify, item, terminal, start, requests: () => requests,
    close: async () => { await codex.close(); database.close(); } };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Compaction evidence bounds identities and ignores invalid terminal status without losing valid duplicates', () => {
  const state: CompactionEvidence = {};
  const item = (turnId: unknown, id: unknown) => ({ turnId, item: { id, type: 'contextCompaction' } });
  for (const invalid of ['', ' ', 'bad\n', 'x'.repeat(513), '界'.repeat(180), null, 1]) {
    observeCompaction(state, 'item/started', item(invalid, 'item'));
    observeCompaction(state, 'item/started', item('turn', invalid));
    assert.deepEqual(state, {});
  }
  observeCompaction(state, 'item/started', item('turn', 'item'));
  observeCompaction(state, 'item/started', item('turn', 'item'));
  for (const status of [undefined, 'inProgress', 'unknown']) observeCompaction(state, 'turn/completed', { turn: { id: 'turn', status } });
  assert.equal(state.terminal, undefined);
  observeCompaction(state, 'item/completed', item('turn', 'item'));
  observeCompaction(state, 'turn/completed', { turn: { id: 'turn', status: 'completed' } });
  observeCompaction(state, 'turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(state, { turnId: 'turn', itemId: 'item', itemCompleted: true, terminal: 'completed' });
  observeCompaction(state, 'turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
  const failed = { ...state };
  observeCompaction(state, 'turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(state, failed, 'contradictory outcome must remain sticky');
  assert.ok(state.failure);
});

for (const evidence of ['bare-terminal', 'wrong-item-type', 'missing-native', 'completion-without-start', 'deprecated-event']) {
  test(`Codex compaction does not accept ${evidence} as matching completion`, async () => {
    const f = fixture(), pending = f.start();
    try {
      if (evidence === 'wrong-item-type') { f.item('item/started', 'compact-turn', 'tool', 'commandExecution'); f.item('item/completed', 'compact-turn', 'tool', 'commandExecution'); }
      if (evidence === 'missing-native') { f.notify('item/started', { item: { type: 'contextCompaction', id: 'item' } }); f.notify('item/completed', { item: { type: 'contextCompaction', id: 'item' } }); }
      if (evidence === 'completion-without-start') f.item('item/completed');
      if (evidence === 'deprecated-event') f.notify('thread/compacted', { turnId: 'compact-turn' });
      f.terminal();
      await flush();
      assert.equal(pending.result(), 'pending');
      f.item('item/started'); f.item('item/completed'); f.terminal();
      await pending.promise;
      assert.equal(pending.result(), 'completed');
      assert.equal(f.requests(), 1);
    } finally { await f.close(); await pending.promise; }
  });
}

test('Codex compaction requires item completion even when matching turn terminal arrives first', async () => {
  const f = fixture(), pending = f.start();
  try {
    f.item('item/started'); f.terminal(); await flush();
    assert.equal(pending.result(), 'pending');
    f.item('item/completed'); await pending.promise;
    assert.equal(pending.result(), 'completed');
  } finally { await f.close(); await pending.promise; }
});

for (const mismatch of ['turn', 'item']) {
  test(`Codex compaction rejects conflicting ${mismatch} evidence`, async () => {
    const f = fixture(), pending = f.start();
    try {
      f.item('item/started');
      f.item('item/completed', mismatch === 'turn' ? 'other-turn' : 'compact-turn', mismatch === 'item' ? 'other-item' : 'compact-item');
      await flush();
      assert.ok(pending.result() instanceof Error);
      assert.equal(f.requests(), 1);
    } finally { await f.close(); await pending.promise; }
  });
}

for (const status of ['failed', 'interrupted']) {
  test(`Codex compaction never accepts matching ${status} as success`, async () => {
    const f = fixture(), pending = f.start();
    try {
      f.item('item/started'); f.terminal('compact-turn', status);
      await flush();
      assert.ok(pending.result() instanceof Error);
    } finally { await f.close(); await pending.promise; }
  });
}

for (const change of ['connection', 'command', 'invalidation', 'contradictory-evidence']) {
  test(`Codex compaction rejects ${change} after completion evidence but before ACK`, async () => {
    const f = fixture();
    let acknowledge!: (value: unknown) => void;
    f.runtime.request = () => new Promise((resolve) => { acknowledge = resolve; });
    const pending = f.start();
    try {
      f.item('item/started'); f.item('item/completed'); f.terminal();
      if (change === 'connection') f.runtime.setConnection('replacement');
      if (change === 'command') f.database.codexExecutions.begin(f.sessionKey, 'new-command', 'connection');
      if (change === 'invalidation') f.runtime.executionUnavailable = true;
      if (change === 'contradictory-evidence') f.item('item/started', 'foreign', 'foreign-item');
      acknowledge({}); await pending.promise;
      assert.ok(pending.result() instanceof Error);
    } finally { acknowledge({}); await f.close(); await pending.promise; }
  });
}

test('Codex compaction ignores predecessor evidence and does not publish a normal run lifecycle', async () => {
  const f = fixture();
  f.database.codexExecutions.begin(f.sessionKey, 'previous', 'connection');
  f.database.codexExecutions.acknowledge(f.sessionKey, 'previous', 'connection', 'previous-turn', () => {});
  f.database.codexExecutions.observe(f.sessionKey, 'connection', 'previous-turn', 'completed');
  f.database.codexExecutions.settleHistory({ sessionKey: f.sessionKey, commandId: 'previous', runId: 'previous-turn' }, 'current');
  const before = f.database.codexExecutions.get(f.sessionKey), events = f.store.getEventsSince().length;
  const pending = f.start();
  try {
    f.item('item/started', 'previous-turn'); f.item('item/completed', 'previous-turn'); f.terminal('previous-turn');
    await flush(); assert.equal(pending.result(), 'pending');
    f.notify('turn/started', { turn: { id: 'compact-turn', status: 'inProgress' } });
    f.item('item/started'); f.item('item/completed'); f.terminal();
    await pending.promise;
    assert.equal(pending.result(), 'completed');
    assert.deepEqual(f.database.codexExecutions.get(f.sessionKey), before);
    assert.equal(f.store.getEventsSince().length, events);
    assert.equal(f.runtime.activeTurnIds.size, 0);
  } finally { await f.close(); await pending.promise; }
});

for (const phase of ['starting', 'running', 'unknown', 'unsynced-terminal']) {
  test(`Codex compaction cannot overlap ${phase} managed execution`, async () => {
    const f = fixture();
    f.database.codexExecutions.begin(f.sessionKey, 'original', 'connection');
    if (phase === 'unknown') f.database.codexExecutions.uncertain(f.sessionKey, 'original');
    if (phase === 'running' || phase === 'unsynced-terminal') f.database.codexExecutions.acknowledge(f.sessionKey, 'original', 'connection', 'native', () => {});
    if (phase === 'unsynced-terminal') f.database.codexExecutions.observe(f.sessionKey, 'connection', 'native', 'completed');
    const pending = f.start();
    try {
      await flush();
      assert.ok(pending.result() instanceof Error);
      assert.equal(f.requests(), 0);
      assert.equal(f.runtime.compactWaiters.size, 0);
    } finally { await f.close(); await pending.promise; }
  });
}
