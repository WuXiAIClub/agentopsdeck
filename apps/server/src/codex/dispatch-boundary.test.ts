import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { RunControlConflict } from '../commands/run-control.js';

// Identity/projection tests are not deadline tests. Give their native proof
// window headroom under joint-suite contention; deadline cases opt in below.
function fixture(database: ConnectorUserStore, requestTimeoutMs = 1000) {
  const store = new DeckStore(), sessionKey = 'codex:synthetic';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic boundary', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: () => true,
    requestTimeoutMs });
  const runtime = codex as any;
  runtime.connectionId = "synthetic-connection";
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  // Native recovery has its own isolated worker; direct queue passes no longer
  // scan empty-queue executions. Tests below exercise that original owner.
  assert.ok(runtime.turnWorker.recoveryWorker);
  // Direct dispatch tests begin after the worker's validated predecessor read.
  runtime.threadRefreshResult.set(sessionKey, { at: 0, available: true });
  const passLanes = async () => {
    await runtime.turnWorker.pass();
    assert.ok(runtime.turnWorker.recoveryWorker, 'Codex recovery must retain its isolated lane');
    await runtime.turnWorker.recoveryWorker.pass();
  };
  return { store, sessionKey, codex, runtime, passLanes };
}

function history(clientId: string) {
  return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'native', status: 'completed', items: [
    { type: 'userMessage', id: 'echo', clientId, content: [{ type: 'text', text: 'historical echo' }] },
  ] }] } };
}

function completeCompaction(runtime: any, turnId = 'compact') {
  for (const method of ['item/started', 'item/completed']) runtime.handleNotification(method, {
    threadId: 'synthetic', turnId, item: { type: 'contextCompaction', id: 'compact-item' }, startedAtMs: 1, completedAtMs: 2,
  });
  runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: turnId, status: 'completed' } });
}

for (const retirement of ['close', 'disconnect']) {
  test(`Codex compact waiters retire promptly after ${retirement}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    f.runtime.request = async () => ({});
    let settled = false;
    const compact = f.runtime.compactThread('synthetic').then(() => assert.fail('retired compaction cannot succeed'), () => { settled = true; });
    try {
      await Promise.resolve();
      if (retirement === 'close') await f.codex.close();
      else f.runtime.recycleChild(undefined, new Error('synthetic disconnect'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.runtime.compactWaiters.size, 0, 'retirement must release existing compaction timers');
      assert.equal(settled, true, 'shutdown must not wait for the two-minute compaction deadline');
    } finally {
      for (const waiter of f.runtime.compactWaiters.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error('test cleanup')); }
      await compact; await f.codex.close(); database.close();
    }
  });
}

test('Codex compact refuses a duplicate thread operation without replacing its waiter or dispatching again', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  let calls = 0;
  f.runtime.request = async () => { calls++; return {}; };
  const compact = f.runtime.compactThread('synthetic').catch(() => {});
  const original = f.runtime.compactWaiters.get('synthetic');
  let duplicateSettled = false;
  const duplicate = f.runtime.compactThread('synthetic').then(() => assert.fail('duplicate must reject'), () => { duplicateSettled = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(duplicateSettled, true);
    assert.equal(calls, 1);
    assert.equal(f.runtime.compactWaiters.get('synthetic'), original);
  } finally {
    for (const waiter of new Set([original, ...f.runtime.compactWaiters.values()])) {
      clearTimeout(waiter.timeout); waiter.reject(new Error('test cleanup'));
    }
    await Promise.all([compact, duplicate]); await f.codex.close(); database.close();
  }
});

for (const failure of ['terminal', 'timeout']) {
  test(`Codex compact handles ${failure} failure before its RPC ACK without waiting or orphan rejection`, async (t) => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let acknowledge!: (value: unknown) => void;
    let error: Error | undefined;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.runtime.request = () => new Promise((resolve) => { acknowledge = resolve; });
    const compact = f.runtime.compactThread('synthetic').then(() => assert.fail('failed compact cannot succeed'), (reason: Error) => { error = reason; });
    try {
      if (failure === 'timeout') t.mock.timers.tick(120_000);
      else {
        f.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'compact', item: { type: 'contextCompaction', id: 'compact-item' }, startedAtMs: 1 });
        f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'compact', status: 'failed', error: { message: 'synthetic compact failure' } } });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(error?.message ?? '', failure === 'timeout' ? /timed out/ : /synthetic compact failure/);
      assert.equal(f.runtime.compactWaiters.size, 0);
    } finally { acknowledge({}); await compact; await f.codex.close(); database.close(); t.mock.timers.reset(); }
  });
}

for (const first of ['ack', 'terminal']) {
  test(`Codex compact requires both RPC ACK and completion when ${first} arrives first`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let acknowledge!: (value: unknown) => void, settled = false;
    f.runtime.request = () => new Promise((resolve) => { acknowledge = resolve; });
    const compact = f.runtime.compactThread('synthetic').then(() => { settled = true; });
    const complete = () => completeCompaction(f.runtime);
    try {
      if (first === 'ack') acknowledge({}); else complete();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      if (first === 'terminal') await assert.rejects(f.runtime.compactThread('synthetic'), /not available/,
        'a terminal notification cannot release the operation slot while its RPC is unacknowledged');
      if (first === 'ack') complete(); else acknowledge({});
      await compact;
      assert.equal(settled, true);
      assert.equal(f.runtime.compactWaiters.size, 0);
    } finally { acknowledge({}); await f.codex.close(); database.close(); }
  });
}

test('Codex retired compaction cleanup cannot remove the next connection waiter', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  f.runtime.request = async () => ({});
  const previous = f.runtime.compactThread('synthetic').catch(() => {});
  let next: Promise<unknown> | undefined;
  try {
    f.runtime.recycleChild(undefined, new Error('synthetic retirement'));
    f.runtime.setConnection('replacement');
    next = f.runtime.compactThread('synthetic').catch(() => {});
    const waiter = f.runtime.compactWaiters.get('synthetic');
    await previous;
    assert.equal(f.runtime.compactWaiters.get('synthetic'), waiter);
    assert.ok(waiter);
    completeCompaction(f.runtime, 'new-compact');
    await next;
    assert.equal(f.runtime.compactWaiters.size, 0);
  } finally { await f.codex.close(); await next; database.close(); }
});

for (const noise of ['none', 'bare-terminal', 'deprecated-event', 'wrong-item', 'completion-without-start']) {
test(`Codex shutdown preserves queued compaction command after ${noise} without dispatching its successor`, async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  let started!: () => void;
  const compactStarted = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  f.store.addMessage({ id: 'old-failure', sessionKey: f.sessionKey, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
  f.runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: 'synthetic', turns: [{ id: 'failed', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] }] } };
    if (method === 'thread/compact/start') started();
    return {};
  };
  let drain: Promise<unknown> | undefined;
  try {
    const accepted = await f.codex.send(f.sessionKey, 'Queued user request');
    const batchMate = await f.codex.send(f.sessionKey, 'Handle in the same turn');
    drain = f.runtime.drainQueuedTurn(f.sessionKey);
    await compactStarted;
    const successor = await f.codex.send(f.sessionKey, 'Keep successor queued');
    if (noise === 'deprecated-event') f.runtime.handleNotification('thread/compacted', { threadId: 'synthetic', turnId: 'foreign' });
    if (noise === 'wrong-item') for (const method of ['item/started', 'item/completed']) {
      f.runtime.handleNotification(method, { threadId: 'synthetic', turnId: 'foreign', item: { type: 'commandExecution', id: 'tool' } });
    }
    if (noise === 'completion-without-start') f.runtime.handleNotification('item/completed', {
      threadId: 'synthetic', turnId: 'foreign', item: { type: 'contextCompaction', id: 'foreign-item' },
    });
    if (noise !== 'none') f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'foreign', status: 'completed' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['thread/read', 'thread/rollback', 'thread/compact/start']);
    assert.equal(f.runtime.compactWaiters.size, 1, 'unrelated completion must not release admission');
    let closed = false;
    const closing = f.codex.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, true, 'shutdown must not wait two minutes for native completion');
    await closing; await drain;
    assert.deepEqual(calls, ['thread/read', 'thread/rollback', 'thread/compact/start']);
    assert.equal(database.turns.head('codex', f.sessionKey)?.id, accepted.idempotencyKey);
    assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'outcome_unknown');
    assert.deepEqual(database.turns.list('codex', f.sessionKey).map(({ id, state }) => ({ id, state })), [
      { id: accepted.idempotencyKey, state: 'outcome_unknown' }, { id: batchMate.idempotencyKey, state: 'outcome_unknown' },
      { id: successor.idempotencyKey, state: 'queued' },
    ]);
  } finally {
    for (const waiter of f.runtime.compactWaiters.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error('test cleanup')); }
    await drain; await f.codex.close(); database.close();
  }
});
}

test('Codex interrupt uses its durable ACK identity after transient maps are cleared', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  const calls: unknown[] = [];
  try {
    database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
    database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
    f.runtime.request = async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'synthetic', turns: [{ id: 'native', items: [] }] } };
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      return {};
    };
    await f.codex.interrupt(f.sessionKey, 'native', 'actor');
    assert.deepEqual(calls, [{ method: 'turn/interrupt', params: { threadId: 'synthetic', turnId: 'native' } },
      { method: 'thread/read', params: { threadId: 'synthetic', includeTurns: true } },
      { method: 'thread/backgroundTerminals/list', params: { threadId: 'synthetic', limit: 100 } }]);
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running', 'interrupt ACK does not prove native quiescence');
  } finally { await f.codex.close(); database.close(); }
});

for (const outcome of ['ack', 'lost-ack']) {
  test(`Codex managed interrupt preserves execution and queued successor after ${outcome}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let calls = 0;
    try {
      database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
      database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
      const successor = await f.codex.send(f.sessionKey, 'Queued successor');
      f.runtime.activeTurnIds.set(f.sessionKey, 'stale-native');
      f.runtime.ensureStarted = async () => { database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'running'); };
      f.runtime.request = async (method: string, params: unknown) => {
        if (method === 'thread/read') return { thread: { id: 'synthetic', turns: [{ id: 'native', items: [] }] } };
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        calls++; assert.equal(method, 'turn/interrupt');
        assert.deepEqual(params, { threadId: 'synthetic', turnId: 'native' });
        if (outcome === 'lost-ack') throw new Error('synthetic lost interrupt ACK');
        return {};
      };
      const result = f.codex.interrupt(f.sessionKey, 'native', 'actor');
      if (outcome === 'lost-ack') await assert.rejects(result, /lost interrupt ACK/);
      else await result;
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(calls, 1, 'neither a control ACK nor its loss can start a successor or resend');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, 'original');
      assert.equal(database.turns.head('codex', f.sessionKey)?.id, successor.idempotencyKey);
      assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'queued');
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const change of ['starting', 'terminal', 'unknown', 'foreign-native', 'connection', 'invalidation', 'close']) {
  test(`Codex interrupt refuses stale transient authority before preparation: ${change}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let preparations = 0, calls = 0;
    try {
      database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
      if (change !== 'starting') database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId,
        change === 'foreign-native' ? 'other-native' : 'native', () => {});
      if (change === 'terminal') database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
      if (change === 'unknown') database.codexExecutions.recoverInterrupted();
      if (change === 'connection') f.runtime.setConnection('replacement');
      if (change === 'invalidation') f.runtime.invalidateExecution();
      if (change === 'close') await f.codex.close();
      f.runtime.activeTurnIds.set(f.sessionKey, 'native');
      f.runtime.ensureStarted = async () => { preparations++; };
      f.runtime.request = async () => { calls++; return {}; };
      await assert.rejects(f.codex.interrupt(f.sessionKey, 'native', 'actor'), RunControlConflict);
      assert.equal(preparations, 0, 'untrusted identity must not start or reconnect native transport');
      assert.equal(calls, 0);
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const change of ['command', 'connection', 'terminal', 'unknown', 'invalidation', 'close', 'legacy-admission']) {
  test(`Codex interrupt rechecks durable identity after preparation: ${change}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let calls = 0;
    try {
      if (change !== 'legacy-admission') {
        database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
        database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
      }
      f.runtime.activeTurnIds.set(f.sessionKey, 'native');
      f.runtime.ensureStarted = async () => {
        if (change === 'connection') f.runtime.setConnection('replacement');
        else if (change === 'invalidation') f.runtime.invalidateExecution();
        else if (change === 'close') await f.codex.close();
        else if (change === 'unknown') database.codexExecutions.recoverInterrupted();
        else {
          const before = database.codexExecutions.get(f.sessionKey);
          if (before) {
            database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
            assert.equal(database.codexExecutions.settleHistory(database.codexExecutions.get(f.sessionKey)!, 'current'), true);
          }
          if (change !== 'terminal') {
            assert.equal(database.codexExecutions.begin(f.sessionKey, 'successor', f.runtime.connectionId), true);
            assert.equal(database.codexExecutions.acknowledge(f.sessionKey, 'successor', f.runtime.connectionId, 'native', () => {}), true);
          }
        }
      };
      f.runtime.request = async () => { calls++; return {}; };
      await assert.rejects(f.codex.interrupt(f.sessionKey, 'native', 'actor'), RunControlConflict);
      assert.equal(calls, 0, 'an old control must not target a successor even if it reuses the same native ID');
    } finally { await f.codex.close(); database.close(); }
  });
}

test('Codex history echo cannot acknowledge an unknown queue head or admit its successor, including after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-ack-'));
  let database = new ConnectorUserStore(join(dir, 'connector.sqlite'));
  let f = fixture(database);
  try {
    const accepted = await f.codex.send(f.sessionKey, 'original request');
    database.turns.start('codex', f.sessionKey, accepted.idempotencyKey);
    database.turns.uncertain('codex', accepted.idempotencyKey);
    await f.codex.send(f.sessionKey, 'successor');
    for (let attempt = 0; attempt < 2; attempt++) {
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read', 'history/queue recovery must never launch the successor');
        return history(accepted.idempotencyKey);
      };
      await f.codex.refreshSession(f.sessionKey);
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.deepEqual(database.turns.list('codex', f.sessionKey).map((row) => row.state), ['outcome_unknown', 'queued']);
      assert.equal(database.turns.head('codex', f.sessionKey)?.id, accepted.idempotencyKey);
      const message = f.store.getMessages(f.sessionKey).find((row) => row.id === accepted.idempotencyKey);
      assert.equal(message?.status, 'outcome_unknown');
      assert.equal(message?.text, 'original request');
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown', 'an idle snapshot is not dispatch confirmation');
      const events = f.store.getEventsSince().length;
      await f.codex.refreshSession(f.sessionKey);
      assert.equal(f.store.getEventsSince().length, events, 'identical history must not produce sent/unknown oscillation or new timestamps');
      if (attempt === 0) {
        await f.codex.close(); database.close();
        database = new ConnectorUserStore(join(dir, 'connector.sqlite'));
        f = fixture(database);
      }
    }
  } finally { await f.codex.close(); database.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Codex history during dispatch cannot remove the pending command before its ACK', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  let acknowledge!: (value: unknown) => void;
  let started!: () => void;
  const written = new Promise<void>((resolve) => { started = resolve; });
  const accepted = await f.codex.send(f.sessionKey, 'original request');
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/read') return history(accepted.idempotencyKey);
    assert.equal(method, 'turn/start');
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'starting', 'fact commits before native dispatch');
    assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, accepted.idempotencyKey);
    started();
    return new Promise((resolve) => { acknowledge = resolve; });
  };
  try {
    const drain = f.runtime.drainQueuedTurn(f.sessionKey);
    await written;
    await f.codex.refreshSession(f.sessionKey);
    assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'dispatching');
    assert.equal(f.store.getMessages(f.sessionKey).find((row) => row.id === accepted.idempotencyKey)?.text, 'original request');
    acknowledge({ turn: { id: 'native' } });
    await drain;
    assert.equal(database.turns.head('codex', f.sessionKey), undefined);
    assert.equal(f.store.getMessages(f.sessionKey).find((row) => row.id === accepted.idempotencyKey)?.status, 'sent');
    assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'running');
  } finally { acknowledge?.({ turn: { id: 'native' } }); await f.codex.close(); database.close(); }
});

for (const ack of [{}, { turn: {} }, { turn: { id: '' } }]) {
  test(`Codex malformed start ACK ${JSON.stringify(ack)} retains the unknown command`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let starts = 0;
    f.runtime.request = async (method: string) => { assert.equal(method, 'turn/start'); starts++; return ack; };
    try {
      const accepted = await f.codex.send(f.sessionKey, 'one');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      await f.codex.send(f.sessionKey, 'two');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(database.turns.head('codex', f.sessionKey)?.id, accepted.idempotencyKey);
      assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'outcome_unknown');
      assert.equal(starts, 1);
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
      assert.equal(f.store.getSession(f.sessionKey)?.runCompletedAt, undefined);
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const boundary of ['before-ack', 'during-ack', 'after-ack', 'after-terminal'] as const) {
  test(`Codex process kill ${boundary} preserves the dispatch fence and atomic ACK`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-kill-')), file = join(dir, 'connector.sqlite');
    const script = `
      import { ConnectorUserStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? '../connector/connector-user-store.ts' : '../connector/connector-user-store.js', import.meta.url).href)};
      const store = new ConnectorUserStore(${JSON.stringify(file)}), facts = store.codexExecutions;
      await store.turns.enqueueAsync('codex', {id:'command', sessionKey:'codex:synthetic', createdAt:1, payload:{text:'synthetic', images:[]}});
      store.turns.start('codex', 'codex:synthetic', 'command');
      facts.begin('codex:synthetic', 'command', 'old-connection');
      if (${JSON.stringify(boundary)} !== 'before-ack') facts.acknowledge('codex:synthetic', 'command', 'old-connection', 'native', (db) => {
        store.turns.completeInTransaction(db, 'codex', 'command');
        if (${JSON.stringify(boundary)} === 'during-ack') process.kill(process.pid, 'SIGKILL');
      });
      if (${JSON.stringify(boundary)} === 'after-terminal') facts.observe('codex:synthetic', 'old-connection', 'native', 'completed');
      process.kill(process.pid, 'SIGKILL');
    `;
    try {
      const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const database = new ConnectorUserStore(file), f = fixture(database);
      try {
        const acked = boundary === 'after-ack' || boundary === 'after-terminal';
        const fact = database.codexExecutions.get(f.sessionKey)!;
        assert.equal(fact.runId, acked ? 'native' : undefined);
        assert.equal(database.turns.list('codex').length, acked ? 0 : 1);
        assert.equal(fact.phase, boundary === 'after-terminal' ? 'completed' : 'unknown');
        assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, fact.phase);
        await f.codex.send(f.sessionKey, 'successor');
        f.runtime.request = async (method: string) => {
          if (method === 'thread/backgroundTerminals/list') return { data: [] };
          assert.equal(method, 'thread/read', 'restart/idle/history cannot authorize another native turn');
          return history('command');
        };
        if (boundary !== 'after-terminal') await f.codex.refreshSession(f.sessionKey);
        await f.runtime.drainQueuedTurn(f.sessionKey);
        assert.equal(database.turns.list('codex').length, acked ? 1 : 2);
        assert.equal(database.codexExecutions.canStart(f.sessionKey), false);
      } finally { await f.codex.close(); database.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('Codex notification journal failure cannot escape stdio callback or expose a healthy terminal snapshot', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  f.runtime.request = async () => ({ turn: { id: 'native' } });
  try {
    await f.codex.send(f.sessionKey, 'synthetic');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
    database.events.appendInTransaction = () => { throw new Error('injected persistence outage'); };
    assert.doesNotThrow(() => f.runtime.receive(JSON.stringify({ method: 'turn/completed',
      params: { threadId: 'synthetic', turn: { id: 'native', status: 'completed' } } })));
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running', 'uncommitted terminal rolled back');
    assert.throws(() => f.store.getSession(f.sessionKey), /facts unavailable/);
    assert.throws(() => f.store.getSessionExecution(f.sessionKey), /facts unavailable/);
    await assert.rejects(f.codex.send(f.sessionKey, 'must not dispatch'), /facts unavailable/);
    f.runtime.request = async () => assert.fail('unavailable owner must not dispatch or reconcile');
    await f.runtime.drainQueuedTurn(f.sessionKey);
  } finally { await f.codex.close(); database.close(); }
});

for (const count of [1, 2]) test(`Codex ACK journal failure rolls back the entire ${count}-member batch and restart never replays it`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-ack-rollback-'));
  const file = join(directory, 'connector.sqlite');
  const database = new ConnectorUserStore(file), f = fixture(database);
  let starts = 0;
  let before: ReturnType<typeof database.codexExecutions.get>;
  let queueBefore: ReturnType<typeof database.turns.list>;
  f.runtime.request = async () => {
    starts++;
    before = database.codexExecutions.get(f.sessionKey);
    queueBefore = database.turns.list('codex', f.sessionKey);
    database.events.appendInTransaction = () => { throw new Error('injected ACK persistence outage'); };
    return { turn: { id: 'native' } };
  };
  try {
    await f.codex.send(f.sessionKey, 'synthetic');
    if (count === 2) await f.codex.send(f.sessionKey, 'same atomic batch');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    // Neither the ACK nor its failure settlement can commit while the shared
    // evidence sink is unavailable. A standalone queue-only unknown update
    // would violate the owning transaction, not improve recoverability.
    assert.equal(queueBefore!.length, count);
    assert.ok(queueBefore!.every(entry => entry.state === 'dispatching'));
    assert.deepEqual(database.turns.list('codex', f.sessionKey), queueBefore!);
    assert.deepEqual(database.codexExecutions.get(f.sessionKey), before);
    assert.equal(before?.phase, 'starting');
    assert.equal(before?.runId, undefined);
    assert.equal(f.runtime.executionUnavailable, true);
    assert.throws(() => f.store.getSession(f.sessionKey), /facts unavailable/);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(starts, 1);
  } finally { await f.codex.close(); database.close(); }
  const reopened = new ConnectorUserStore(file);
  let recovered: ReturnType<typeof fixture> | undefined;
  try {
    assert.deepEqual(reopened.turns.list('codex', f.sessionKey), queueBefore!);
    assert.deepEqual(reopened.codexExecutions.get(f.sessionKey), before);
    recovered = fixture(reopened); // Original startup recovery, no test-only release.
    recovered.runtime.request = async () => assert.fail('an unrecorded ACK must not authorize replay');
    assert.equal(reopened.codexExecutions.get(f.sessionKey)?.phase, 'unknown');
    assert.equal(reopened.codexExecutions.get(f.sessionKey)?.reason, 'restarted');
    assert.deepEqual(reopened.turns.list('codex', f.sessionKey).map(entry => ({ ...entry, state: 'dispatching' })), queueBefore!);
    assert.ok(reopened.turns.list('codex', f.sessionKey).every(entry => entry.state === 'outcome_unknown'));
    await recovered.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(starts, 1);
  } finally { await recovered?.codex.close(); reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`Codex native ${phase} preceding a valid ACK cannot be republished as running`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      if (method === 'thread/read') return { thread: { id: 'synthetic', turns: [{ id: 'native', status: phase, items: [
        { id: 'reply', type: 'agentMessage', text: 'Early reply restored after ACK', phase: 'final_answer' },
      ] }] } };
      assert.equal(method, 'turn/start');
      f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'native' } });
      f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native',
        item: { id: 'reply', type: 'agentMessage', text: 'Early reply restored after ACK', phase: 'final_answer' } });
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
      return { turn: { id: 'native' } };
    };
    try {
      await f.codex.send(f.sessionKey, 'synthetic');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, phase);
      assert.equal(database.turns.head('codex', f.sessionKey), undefined);
      assert.equal(f.runtime.activeTurnIds.has(f.sessionKey), false);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'syncing');
      assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Early reply restored after ACK'));
      f.codex.startQueueWorker();
      for (let attempt = 0; attempt < 100 && database.codexExecutions.get(f.sessionKey)?.sync !== 'current'; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
      assert.equal(f.store.getMessages(f.sessionKey).filter((message) => message.text === 'Early reply restored after ACK').length, 1);
    } finally { await f.codex.close(); database.close(); }
  });

  test(`Codex cold ${phase} history sync runs without a browser or queued command`, async () => {
    const database = new ConnectorUserStore(':memory:');
    database.codexExecutions.begin('codex:synthetic', 'original', 'old-connection');
    database.codexExecutions.acknowledge('codex:synthetic', 'original', 'old-connection', 'native', () => {});
    database.codexExecutions.observe('codex:synthetic', 'old-connection', 'native', phase);
    const f = fixture(database);
    f.store.removeSession(f.sessionKey);
    let reads = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'terminal recovery is read-only'); reads++;
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'native', status: phase, itemsView: 'full',
        items: [{ id: 'reply', type: 'agentMessage', text: 'Synthetic final response', phase: 'final_answer' }] }] } };
    };
    try {
      assert.equal(database.turns.list('codex').length, 0);
      f.codex.startQueueWorker();
      // Durable history is committed before the original projector's finally
      // wakes the queue. Wait for that owner AND its bounded scheduling hint;
      // sync=current alone is not a worker-quiescence acknowledgement.
      const settled = () => database.codexExecutions.get(f.sessionKey)?.sync === 'current'
        && !f.runtime.completingTurns.size && !f.runtime.turnWorker.inflight
        && !f.runtime.turnWorker.timer && !f.runtime.turnWorker.wakePending;
      for (let attempt = 0; attempt < 100 && !settled(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(settled(), true, 'the original projector and its queue wake must actually settle');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, phase);
      assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Synthetic final response'));
      const stableReads = reads;
      assert.equal(f.runtime.turnWorker.timer, undefined, 'settled facts leave no idle polling timer');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(reads, stableReads);
    } finally { await f.codex.close(); database.close(); }
  });
}

test('Codex connection loss publishes unknown without changing durable facts; terminal remains terminal', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  f.runtime.request = async () => ({ turn: { id: 'native' } });
  try {
    await f.codex.send(f.sessionKey, 'synthetic');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    const before = database.codexExecutions.get(f.sessionKey), events = f.store.getEventsSince().length;
    f.runtime.setConnection(undefined);
    assert.deepEqual(database.codexExecutions.get(f.sessionKey), before);
    assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
    assert.equal(f.store.getSession(f.sessionKey)?.runtime?.connection, 'disconnected');
    assert.ok(f.store.getEventsSince().length > events, 'connection loss must wake stream readers');
    f.runtime.setConnection('replacement');
    assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
    const recovery = database.codexExecutions.get(f.sessionKey)!;
    assert.equal(recovery.phase, 'unknown');
    assert.equal(recovery.reason, 'restarted');
    assert.equal(recovery.runId, before!.runId);
    assert.equal(recovery.connectionId, before!.connectionId);
    // A replaced lease cannot finish the execution via late notifications.
    assert.equal(database.codexExecutions.observe(f.sessionKey, before!.connectionId, 'native', 'completed'), false);
    // Model the independently verified terminal, then another disconnect must
    // retain that durable outcome. Full proof paths are covered by successor tests.
    assert.equal(database.codexExecutions.recoverTerminal(recovery, 'native', 'completed'), true);
    f.runtime.setConnection(undefined);
    assert.equal(f.store.getSessionExecution(f.sessionKey)?.runtime?.phase, 'completed');
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
    assert.equal(f.store.getSession(f.sessionKey)?.hasActiveRun, false);
  } finally { await f.codex.close(); database.close(); }
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const blockedBeforeStart of [false, true]) {
    test(`Codex ${phase} history recovery is independent of a revoked successor (${blockedBeforeStart ? 'blocked' : 'queued'})`, async () => {
      const database = new ConnectorUserStore(':memory:');
      database.codexExecutions.begin('codex:synthetic', 'original', 'old-connection');
      database.codexExecutions.acknowledge('codex:synthetic', 'original', 'old-connection', 'native', () => {});
      database.codexExecutions.observe('codex:synthetic', 'old-connection', 'native', phase);
      const f = fixture(database);
      const successor = await f.codex.send(f.sessionKey, 'revoked successor');
      f.runtime.options.authorizeTurn = () => false;
      if (blockedBeforeStart) database.turns.block('codex', successor.idempotencyKey);
      let reads = 0;
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read', 'recovery may not start, resume, compact or interrupt a turn');
        reads++;
        return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'native', status: phase, itemsView: 'full',
          items: [{ id: 'reply', type: 'agentMessage', text: 'Already executed result', phase: 'final_answer' }] }] } };
      };
      try {
        await f.runtime.turnWorker.options.reconcile(f.sessionKey);
        assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
        assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
        assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, 'original');
        assert.equal(database.turns.head('codex', f.sessionKey)?.id, successor.idempotencyKey);
        assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'blocked');
        assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Already executed result'));
        const settledReads = reads;
        await f.runtime.turnWorker.options.reconcile(f.sessionKey);
        assert.equal(reads, settledReads, 'settled terminal must not authorize further revoked-head reads');
        assert.deepEqual(database.codexExecutions.recoveryPage('', 64), []);
        assert.deepEqual(database.turns.sessionPage('codex'), []);
      } finally { await f.codex.close(); database.close(); }
    });
  }
}

for (const phase of ['absent', 'unknown', 'completed'] as const) {
  test(`Codex revoked successor performs no runtime reads for ${phase} without pending terminal history`, async () => {
    const database = new ConnectorUserStore(':memory:');
    if (phase !== 'absent') {
      database.codexExecutions.begin('codex:synthetic', 'original', 'old-connection');
      if (phase === 'completed') {
        database.codexExecutions.acknowledge('codex:synthetic', 'original', 'old-connection', 'native', () => {});
        database.codexExecutions.observe('codex:synthetic', 'old-connection', 'native', 'completed');
        database.codexExecutions.settleHistory({ sessionKey: 'codex:synthetic', commandId: 'original', runId: 'native' }, 'current');
      }
    }
    const f = fixture(database);
    try {
      // This case is already hydrated in this owner, not an old process's
      // persisted cache marker (restart hydration has separate coverage).
      if (phase === 'completed') database.codexExecutions.settleHistory({ sessionKey: 'codex:synthetic', commandId: 'original', runId: 'native' }, 'current');
      await f.codex.send(f.sessionKey, 'revoked successor');
      f.runtime.options.authorizeTurn = () => false;
      f.runtime.ensureStarted = async () => { assert.fail('no native preparation authorized'); };
      f.runtime.request = async () => { assert.fail('no native request authorized'); };
      await f.runtime.turnWorker.options.reconcile(f.sessionKey);
      assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'blocked');
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const projection of ['run', 'message']) {
  test(`Codex ${projection} projection failure after ACK preserves execution and fails snapshots closed`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let starts = 0, cleanups = 0;
    const original = await f.codex.send(f.sessionKey, 'accepted command');
    const batchMate = await f.codex.send(f.sessionKey, 'same accepted turn');
    let successor!: Awaited<ReturnType<typeof f.codex.send>>;
    f.runtime.request = async (method: string) => {
      assert.equal(method, 'turn/start'); starts++;
      successor = await f.codex.send(f.sessionKey, 'must stay queued');
      return { turn: { id: 'native' } };
    };
    f.runtime.cleanupSecretFiles = async () => { cleanups++; };
    if (projection === 'run') {
      const publish = f.runtime.publishRun.bind(f.runtime);
      f.runtime.publishRun = (key: string, runtime: any, timing: any) => {
        if (runtime.phase === 'running') throw new Error('synthetic post-ACK run projection failure');
        return publish(key, runtime, timing);
      };
    } else {
      const add = f.store.addMessage.bind(f.store);
      f.store.addMessage = (message) => {
        if (message.id === original.idempotencyKey && message.status === 'sent') throw new Error('synthetic post-ACK message projection failure');
        return add(message);
      };
    }
    try {
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, original.idempotencyKey);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.runId, 'native');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
      assert.deepEqual(database.codexExecutions.batchForRun(f.sessionKey, 'native')?.members.map(row=>row.id), [original.idempotencyKey,batchMate.idempotencyKey]);
      assert.deepEqual(database.turns.list('codex', f.sessionKey).map((row) => [row.id, row.state]), [[successor.idempotencyKey, 'queued']]);
      assert.equal(cleanups, 0, 'post-ACK projection failure must not remove files still used by the running turn');
      assert.throws(() => f.store.getSessionExecution(f.sessionKey), /unavailable/);
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(starts, 1);
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const revokedSuccessor of [false, true]) {
    test(`Codex worker recovers missed ${phase} on its ACK connection without browser reads (${revokedSuccessor ? 'revoked successor' : 'empty queue'})`, async () => {
      const database = new ConnectorUserStore(':memory:'), f = fixture(database);
      let starts = 0, reads = 0;
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        if (method === 'turn/start') { starts++; return { turn: { id: 'native' } }; }
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read'); reads++;
        return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'native', status: phase, itemsView: 'full',
          items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered without terminal notification', phase: 'final_answer' }] }] } };
      };
      try {
        await f.codex.send(f.sessionKey, 'original');
        await f.runtime.drainQueuedTurn(f.sessionKey);
        f.runtime.activeTurnIds.clear(); // Scheduling/recovery cannot depend on transient correlation maps.
        if (revokedSuccessor) {
          await f.codex.send(f.sessionKey, 'revoked successor');
          f.runtime.options.authorizeTurn = () => false;
        }
        assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
        await f.runtime.turnWorker.recoveryWorker.pass();
        assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
        assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
        assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Recovered without terminal notification'));
        if (revokedSuccessor) assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'blocked');
        const settledReads = reads;
        await f.runtime.turnWorker.recoveryWorker.pass();
        assert.equal(reads, settledReads, 'settled execution leaves no recovery work');
        assert.equal(starts, 1);
      } finally { await f.codex.close(); database.close(); }
    });
  }
}

for (const fault of ['wrong-thread', 'wrong-turn', 'idle-only', 'system-error', 'connection-replaced']) {
  test(`Codex history ${fault} cannot complete an acknowledged execution`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      const before = database.codexExecutions.get(f.sessionKey);
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read');
        if (fault === 'connection-replaced') f.runtime.setConnection('replacement');
        return { thread: { id: fault === 'wrong-thread' ? 'foreign' : 'synthetic', status: { type: fault === 'system-error' ? 'systemError' : 'idle' },
          turns: [{ id: fault === 'wrong-turn' ? 'foreign' : 'native',
            ...(fault === 'idle-only' ? {} : { status: fault === 'system-error' ? 'inProgress' : 'completed' }),
            items: [{ id: 'foreign-reply', type: 'agentMessage', text: 'Unverified snapshot reply', phase: 'final_answer' }] }] } };
      };
      if (fault === 'wrong-thread') await assert.rejects(f.codex.refreshSession(f.sessionKey), /Invalid Codex thread history/);
      else if (fault === 'system-error') await assert.rejects(f.codex.refreshSession(f.sessionKey), /Codex thread unavailable/);
      else if (fault === 'connection-replaced') await assert.rejects(f.codex.refreshSession(f.sessionKey), /snapshot obsolete/);
      else await f.codex.refreshSession(f.sessionKey);
      await f.runtime.completingTurns.get(f.sessionKey);
      if (fault === 'connection-replaced') {
        const after = database.codexExecutions.get(f.sessionKey)!;
        assert.equal(after.phase, 'unknown');
        assert.equal(after.reason, 'restarted');
        assert.equal(after.runId, before!.runId);
        assert.equal(after.commandId, before!.commandId);
        assert.equal(after.connectionId, before!.connectionId);
        assert.equal(database.codexExecutions.canStart(f.sessionKey), false);
      } else assert.deepEqual(database.codexExecutions.get(f.sessionKey), before);
      if (fault === 'wrong-thread' || fault === 'system-error' || fault === 'connection-replaced') {
        assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Unverified snapshot reply'));
      }
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const readFails of [false, true]) {
  test(`Codex running recovery reuses the read cooldown after ${readFails ? 'failure' : 'in-progress history'}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let reads = 0;
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      f.runtime.request = async (method: string, params: any) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read');
        assert.equal(params.includeTurns, true);
        reads++;
        if (readFails) throw new Error('synthetic read outage');
        return { thread: { id: 'synthetic', status: { type: 'active' }, turns: [{ id: 'native', status: 'inProgress', items: [] }] } };
      };
      // Direct internal passes expose a deferred reconciliation failure; the
      // scheduler consumes/logs it and retains its bounded recovery timer.
      const pass = () => readFails
        ? assert.rejects(f.runtime.turnWorker.recoveryWorker.pass(), /Turn reconciliation deferred/)
        : f.runtime.turnWorker.recoveryWorker.pass();
      await pass();
      assert.equal(reads, 1);
      t.mock.timers.tick(29_999);
      await pass();
      assert.equal(reads, 1, 'no full history read on every worker pass');
      t.mock.timers.tick(1);
      await pass();
      assert.equal(reads, 2, 'recovery remains retryable without a browser');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
      f.runtime.setConnection(undefined);
      t.mock.timers.tick(30_000);
      await f.runtime.turnWorker.recoveryWorker.pass();
      assert.equal(reads, 2, 'a disconnected execution is not a reason to start a new native connection');
      assert.equal(f.runtime.turnWorker.timer, undefined, 'manual passes create no second timer');
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const during of ['preparation', 'read', 'projection']) {
  for (const change of ['connection', 'command', 'revision']) {
    test(`Codex recovery discards ${change} changes during ${during}`, async () => {
      const database = new ConnectorUserStore(':memory:'), f = fixture(database);
      f.runtime.request = async () => ({ turn: { id: 'native' } });
      let reads = 0, changed = false;
      const mutate = () => {
        if (changed) return;
        changed = true;
        const before = database.codexExecutions.get(f.sessionKey)!;
        if (change === 'connection') f.runtime.setConnection('replacement');
        else {
          database.codexExecutions.observe(f.sessionKey, before.connectionId, before.runId!, 'completed');
          if (change === 'command') {
            assert.equal(database.codexExecutions.settleHistory(database.codexExecutions.get(f.sessionKey)!, 'current'), true);
            assert.equal(database.codexExecutions.begin(f.sessionKey, 'successor', before.connectionId), true);
            assert.equal(database.codexExecutions.acknowledge(f.sessionKey, 'successor', before.connectionId, 'native', () => {}), true);
          }
        }
      };
      try {
        await f.codex.send(f.sessionKey, 'original');
        await f.runtime.drainQueuedTurn(f.sessionKey);
        if (during === 'preparation') f.runtime.ensureStarted = async () => { mutate(); };
        if (during === 'projection') f.runtime.options.projectAssistant = async (text: string) => { mutate(); return { text, media: [] }; };
        f.runtime.request = async (method: string) => {
          if (method === 'thread/backgroundTerminals/list') return { data: [] };
          assert.equal(method, 'thread/read'); reads++;
          if (during === 'read') mutate();
          return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'native', status: 'completed',
            items: [{ id: 'stale', type: 'agentMessage', text: 'Stale asynchronous history', phase: 'final_answer' }] }] } };
        };
        if (during === 'preparation') await f.runtime.turnWorker.recoveryWorker.pass();
        else await assert.rejects(f.codex.refreshSession(f.sessionKey), /snapshot obsolete/);
        assert.equal(changed, true);
        assert.equal(reads, during === 'preparation' ? 0 : 1);
        assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Stale asynchronous history'));
        assert.equal(f.runtime.completingTurns.size, 0, 'stale reads cannot initiate final-history reconciliation');
        assert.equal(database.codexExecutions.get(f.sessionKey)?.phase,
          change === 'revision' ? 'completed' : change === 'connection' ? 'unknown' : 'running');
      } finally { await f.codex.close(); database.close(); }
    });
  }
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`Codex thread outage cannot reinterpret durable ${phase} or replay its command`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let type = 'idle', starts = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      if (method === 'turn/start') { starts++; return { turn: { id: 'native' } }; }
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', status: { type }, turns: [{ id: 'native', status: phase, items: [
        { id: 'reply', type: 'agentMessage', text: 'Durable terminal reply' },
      ] }] } };
    };
    try {
      await f.codex.send(f.sessionKey, 'original'); await f.runtime.drainQueuedTurn(f.sessionKey);
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
      await f.runtime.completingTurns.get(f.sessionKey);
      const fact = database.codexExecutions.get(f.sessionKey), messages = f.store.getMessages(f.sessionKey);
      assert.equal(fact?.sync, 'current');
      f.runtime.completedTurnIds.clear(); type = 'systemError';
      f.runtime.handleNotification('thread/status/changed', { threadId: 'synthetic', status: { type } });
      await assert.rejects(f.codex.refreshSession(f.sessionKey), /Codex thread unavailable/);
      assert.deepEqual(database.codexExecutions.get(f.sessionKey), fact);
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, phase);
      assert.equal(f.codex.isSessionHistoryReady(f.sessionKey), false);
      assert.deepEqual(f.store.getMessages(f.sessionKey), messages);
      type = 'idle'; await f.codex.refreshSession(f.sessionKey);
      await f.runtime.turnWorker.recoveryWorker.pass();
      assert.equal(f.codex.isSessionHistoryReady(f.sessionKey), true);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
      assert.equal(starts, 1);
    } finally { await f.codex.close(); database.close(); }
  });

  for (const fault of ['late-start', 'foreign-start', 'conflicting-terminal', 'missing-terminal-status']) {
    test(`Codex durable ${phase} cannot be reopened or contradicted by ${fault}`, async () => {
      const database = new ConnectorUserStore(':memory:'), f = fixture(database);
      f.runtime.request = async () => ({ turn: { id: 'native' } });
      f.runtime.reconcileCompletedTurn = () => {};
      try {
        await f.codex.send(f.sessionKey, 'original');
        await f.runtime.drainQueuedTurn(f.sessionKey);
        f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
        const before = database.codexExecutions.get(f.sessionKey)!;
        database.codexExecutions.settleHistory(before, 'current');
        // No correctness may depend on this in-memory completion cache surviving.
        f.runtime.completedTurnIds.clear();
        const count = f.store.getEventsSince().length;
        const fact = database.codexExecutions.get(f.sessionKey);
        const start = fault === 'late-start' || fault === 'foreign-start';
        f.runtime.handleNotification(start ? 'turn/started' : 'turn/completed', { threadId: 'synthetic', turn: {
          id: fault === 'foreign-start' ? 'foreign' : 'native',
          ...(fault === 'missing-terminal-status' ? {} : { status: start ? 'inProgress' : phase === 'failed' ? 'completed' : 'failed' }),
        } });
        if (fault === 'foreign-start') {
          const protectedFact = database.codexExecutions.get(f.sessionKey)!;
          for (const key of ['commandId', 'runId', 'phase', 'startedAt', 'completedAt'] as const) {
            assert.equal(protectedFact[key], fact![key], 'foreign activity cannot adopt command ownership');
          }
          assert.equal(protectedFact.nativeHistory?.state, 'blocked');
          assert.equal(database.codexExecutions.canStart(f.sessionKey), false);
        } else assert.deepEqual(database.codexExecutions.get(f.sessionKey), fact);
        assert.equal(f.runtime.activeTurnIds.has(f.sessionKey), false, 'terminal facts must not acquire an active transient run');
        assert.equal(f.store.getEventsSince().length, count, 'contradictory lifecycle cannot publish run, tool or failure messages');
        f.runtime.request = async () => ({ turn: { id: 'native-successor' } });
        const successor = await f.codex.send(f.sessionKey, 'next authorized command');
        await f.runtime.drainQueuedTurn(f.sessionKey);
        if (fault === 'foreign-start') {
          assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, fact!.commandId);
          assert.equal(database.turns.list('codex', f.sessionKey).some(entry => entry.id === successor.idempotencyKey), true);
          return;
        }
        assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, successor.idempotencyKey);
        assert.equal(database.codexExecutions.get(f.sessionKey)?.runId, 'native-successor');
      } finally { await f.codex.close(); database.close(); }
    });
  }
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`Codex matching trailing reply remains accepted after durable ${phase}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    f.runtime.reconcileCompletedTurn = () => {};
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
      f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native',
        item: { id: 'trailing-reply', type: 'agentMessage', text: 'Valid terminal reply', phase: 'final_answer' } });
      await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      assert.equal(f.store.getMessages(f.sessionKey).filter((message) => message.text === 'Valid terminal reply').length, 1);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
      assert.equal(f.runtime.activeTurnIds.has(f.sessionKey), false);
    } finally { await f.codex.close(); database.close(); }
  });

  test(`Codex early ${phase} ACK projection does not depend on the completion Map`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    f.runtime.reconcileCompletedTurn = () => {};
    f.runtime.request = async () => {
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
      f.runtime.completedTurnIds.clear();
      return { turn: { id: 'native' } };
    };
    try {
      await f.codex.send(f.sessionKey, 'early terminal');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
      assert.equal(f.runtime.activeTurnIds.has(f.sessionKey), false);
      assert.equal(database.turns.list('codex', f.sessionKey).length, 0);
    } finally { await f.codex.close(); database.close(); }
  });
}

test('Codex ACK running projection cannot be suppressed by a stale native completion marker', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  f.runtime.completedTurnIds.set(f.sessionKey, 'native');
  f.runtime.reconcileCompletedTurn = () => {};
  f.runtime.request = async () => ({ turn: { id: 'native' } });
  try {
    await f.codex.send(f.sessionKey, 'new command');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
    assert.equal(database.codexExecutions.get(f.sessionKey)?.runId, 'native');
    assert.equal(f.runtime.activeTurnIds.size, 0, 'managed ACK must not create a second lifecycle owner');
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: 'completed' } });
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
    assert.equal(f.runtime.activeTurnIds.has(f.sessionKey), false, 'predecessor marker must not suppress the new completion');
  } finally { await f.codex.close(); database.close(); }
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const injection of ['before-dispatch', 'during-load']) {
    test(`Codex ${phase} synchronized predecessor ignores stale active Map ${injection}`, async () => {
      const database = new ConnectorUserStore(':memory:'), f = fixture(database);
      database.codexExecutions.begin(f.sessionKey, 'predecessor', f.runtime.connectionId);
      database.codexExecutions.acknowledge(f.sessionKey, 'predecessor', f.runtime.connectionId, 'old-native', () => {});
      database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'old-native', phase);
      database.codexExecutions.settleHistory(database.codexExecutions.get(f.sessionKey)!, 'current');
      const inject = () => { f.runtime.activeTurnIds.set(f.sessionKey, 'stale-native'); };
      if (injection === 'before-dispatch') inject();
      else f.runtime.ensureThreadLoaded = async () => { inject(); };
      let starts = 0;
      f.runtime.request = async (method: string) => { assert.equal(method, 'turn/start'); starts++; return { turn: { id: 'successor' } }; };
      try {
        const next = await f.codex.send(f.sessionKey, 'successor');
        await f.runtime.drainQueuedTurn(f.sessionKey);
        assert.equal(starts, 1, 'legacy marker cannot strand an authorized queued successor');
        assert.equal(database.codexExecutions.get(f.sessionKey)?.commandId, next.idempotencyKey);
        assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'running');
        assert.equal(database.turns.head('codex', f.sessionKey), undefined);
        assert.equal(f.runtime.activeTurnIds.size, 0);
        assert.equal(f.runtime.completedTurnIds.size, 0);
      } finally { await f.codex.close(); database.close(); }
    });
  }

  test(`Codex ${phase} notification and reply recovery ignore conflicting legacy Maps`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let reads = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'turn/start') return { turn: { id: 'native' } };
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); reads++;
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'native', status: phase,
        items: [{ type: 'commandExecution', id: 'tool', command: 'synthetic', status: 'completed', exitCode: 0 },
          { type: 'agentMessage', id: 'reply', text: 'Recovered final reply' }] }] } };
    };
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      f.runtime.activeTurnIds.set(f.sessionKey, 'foreign');
      f.runtime.completedTurnIds.set(f.sessionKey, 'native');
      f.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'native',
        item: { id: 'tool', type: 'commandExecution', command: 'synthetic', status: 'inProgress' } });
      assert.equal(f.store.getMessages(f.sessionKey).filter((message) => message.role === 'tool').length, 1);
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(reads, 1);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
      assert.equal(f.store.getMessages(f.sessionKey).filter((message) => message.text === 'Recovered final reply').length, 1);
      assert.equal(f.runtime.activeTurnIds.get(f.sessionKey), 'foreign', 'managed notifications must not write legacy lifecycle');
      assert.equal(f.runtime.completedTurnIds.get(f.sessionKey), 'native');
      f.runtime.activeTurnIds.clear(); f.runtime.completedTurnIds.clear();
      const messages = f.store.getMessages(f.sessionKey), events = f.store.getEventsSince().length;
      f.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'native',
        item: { id: 'tool', type: 'commandExecution', command: 'synthetic', status: 'inProgress' } });
      f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native',
        item: { id: 'late-reply', type: 'agentMessage', text: 'Duplicate tail' } });
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: phase } });
      await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(reads, 1, 'duplicate synchronized tool notification does not repeat history reads; new identities require reconciliation');
      assert.deepEqual(f.store.getMessages(f.sessionKey), messages);
      assert.equal(f.store.getEventsSince().length, events);
      assert.equal(f.runtime.activeTurnIds.size + f.runtime.completedTurnIds.size, 0);
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const phase of ['running', 'completed', 'failed', 'interrupted'] as const) {
  test(`Codex thread active hint uses durable ${phase} identity rather than legacy markers`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    database.codexExecutions.begin(f.sessionKey, 'command', f.runtime.connectionId);
    database.codexExecutions.acknowledge(f.sessionKey, 'command', f.runtime.connectionId, 'native', () => {});
    if (phase !== 'running') {
      database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', phase);
      database.codexExecutions.settleHistory(database.codexExecutions.get(f.sessionKey)!, 'current');
      f.runtime.activeTurnIds.set(f.sessionKey, 'stale-active');
    }
    f.runtime.publishRun(f.sessionKey, { phase: 'completed', connection: 'connected', sync: 'current', lastEventAt: 1 });
    let refreshes = 0;
    f.runtime.refreshSession = async () => { refreshes++; };
    try {
      f.runtime.handleNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'active' } });
      assert.equal(refreshes, phase === 'running' ? 0 : 1);
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, phase);
      if (phase === 'running') assert.equal(f.store.getSession(f.sessionKey)?.runtime?.turnId, 'native');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, phase);
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const fault of ['foreign-terminal', 'missing-terminal', 'foreign-tool', 'missing-tool', 'foreign-reply', 'missing-reply', 'missing-delta', 'replacement-connection']) {
    test(`Codex ${phase} notification ${fault} cannot poison the terminal projection or successor`, async () => {
      const database = new ConnectorUserStore(':memory:'), f = fixture(database);
      let reconciles = 0, cleanups = 0, projections = 0;
      try {
        database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
        database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
        database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', phase);
        if (fault === 'replacement-connection') f.runtime.setConnection('replacement');
        const successor = await f.codex.send(f.sessionKey, 'successor');
        f.runtime.reconcileCompletedTurn = () => { reconciles++; };
        f.runtime.cleanupSecretFiles = async () => { cleanups++; };
        f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
        const before = database.codexExecutions.get(f.sessionKey)!, events = f.store.getEventsSince().length;
        const method = fault.includes('tool') ? 'item/started' : fault.includes('reply') ? 'item/completed'
          : fault === 'missing-delta' ? 'item/agentMessage/delta' : 'turn/completed';
        const id = fault.startsWith('missing') ? undefined : fault === 'replacement-connection' ? 'native' : 'foreign';
        f.runtime.handleNotification(method, { threadId: 'synthetic', turnId: id, turn: { id, status: phase },
          item: method === 'item/started' ? { id: 'alien', type: 'commandExecution', command: 'synthetic', status: 'inProgress' }
            : { id: 'alien', type: 'agentMessage', text: 'Unowned reply' }, itemId: 'alien', delta: 'Unowned delta' });
        await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
        assert.equal(projections, 0);
        assert.equal(reconciles, 0);
        assert.equal(cleanups, 0);
        assert.deepEqual(database.codexExecutions.get(f.sessionKey), before);
        assert.equal(f.store.getEventsSince().length, events);
        assert.equal(f.runtime.completedTurnIds.size, 0);
        assert.equal(f.runtime.assistantText.size, 0);
        assert.equal(f.runtime.toolStartedAt.size, 0);
        assert.equal(database.turns.head('codex', f.sessionKey)?.id, successor.idempotencyKey);
        // Once the real predecessor history is synchronized, rejected noise
        // must not leave a legacy active marker that strands its successor.
        database.codexExecutions.settleHistory(before, 'current');
        let starts = 0;
        f.runtime.request = async (method: string) => {
          if (method === 'thread/backgroundTerminals/list') return { data: [] };
          if (method === 'thread/read') return { thread: { id: 'synthetic', turns: [{ id: 'native', status: phase, items: [] }] } };
          assert.equal(method, 'turn/start'); starts++; return { turn: { id: 'successor-native' } };
        };
        await f.codex.refreshSession(f.sessionKey);
        await f.runtime.drainQueuedTurn(f.sessionKey);
        assert.equal(starts, 1);
        assert.equal(database.turns.head('codex', f.sessionKey), undefined);
      } finally { await f.codex.close(); database.close(); }
    });
  }
}

for (const fault of ['foreign-start', 'foreign-terminal', 'foreign-tool', 'foreign-reply', 'missing-tool', 'missing-reply', 'missing-delta', 'missing-id', 'invalid-status', 'running-status', 'replacement-connection']) {
  test(`Codex running notification ${fault} cannot bypass durable identity when transient maps are empty`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let reads = 0, cleanups = 0, projections = 0;
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      f.runtime.activeTurnIds.clear(); f.runtime.completedTurnIds.clear();
      if (fault === 'replacement-connection') f.runtime.setConnection('replacement');
      f.runtime.cleanupSecretFiles = async () => { cleanups++; };
      f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
      f.runtime.request = async (method: string) => { assert.equal(method, 'thread/read'); reads++; return history('unrelated'); };
      const before = database.codexExecutions.get(f.sessionKey), eventCount = f.store.getEventsSince().length;
      const method = fault === 'foreign-start' ? 'turn/started' : fault.includes('tool') ? 'item/started'
        : fault.includes('reply') ? 'item/completed' : fault === 'missing-delta' ? 'item/agentMessage/delta' : 'turn/completed';
      const nativeId = fault.startsWith('missing') ? undefined
        : fault === 'invalid-status' || fault === 'running-status' || fault === 'replacement-connection' ? 'native' : 'foreign';
      const params = method.startsWith('item/')
        ? { threadId: 'synthetic', turnId: nativeId, itemId: 'alien', delta: 'Unowned delta', item: fault.includes('tool')
          ? { id: 'alien', type: 'commandExecution', status: 'inProgress', command: 'synthetic' }
          : { id: 'alien', type: 'agentMessage', text: 'Foreign live reply', phase: 'final_answer' } }
        : { threadId: 'synthetic', turn: { ...(fault === 'missing-id' ? {} : { id: nativeId }),
          status: fault === 'invalid-status' ? 'inProgress' : fault === 'running-status' ? 'running' : 'completed' } };
      f.runtime.handleNotification(method, params);
      await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(cleanups, 0, 'unverified completion cannot delete files used by the acknowledged run');
      assert.equal(reads, 0);
      assert.equal(projections, 0);
      assert.deepEqual(database.codexExecutions.get(f.sessionKey), before);
      assert.equal(f.runtime.activeTurnIds.size, 0);
      assert.equal(f.runtime.assistantText.size, 0);
      assert.equal(f.runtime.toolStartedAt.size, 0);
      assert.equal(f.store.getEventsSince().length, eventCount, 'foreign notifications must not publish misleading runtime/tools/messages');
      assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Foreign live reply'));
      assert.equal(f.store.getSessionExecution(f.sessionKey)?.runtime?.phase, fault === 'replacement-connection' ? 'unknown' : 'running');
    } finally { await f.codex.close(); database.close(); }
  });
}

test('Codex acknowledged live tool/reply/terminal notifications survive missing transient maps', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  let cleanups = 0;
  f.runtime.request = async () => ({ turn: { id: 'native' } });
  const tool = { id: 'tool', type: 'commandExecution', status: 'completed', command: 'synthetic', exitCode: 0, aggregatedOutput: 'Synthetic output' };
  const reply = { id: 'reply', type: 'agentMessage', text: 'Verified live reply', phase: 'final_answer' };
  try {
    await f.codex.send(f.sessionKey, 'original');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    f.runtime.activeTurnIds.clear(); f.runtime.completedTurnIds.clear();
    f.runtime.cleanupSecretFiles = async () => { cleanups++; };
    for (const item of [tool, reply]) f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native', item });
    await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
    assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === reply.text));
    assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.role === 'tool'));
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', turns: [{ id: 'native', status: 'completed', itemsView: 'full', items: [tool, reply] }] } };
    };
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: 'completed' } });
    await f.runtime.completingTurns.get(f.sessionKey);
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
    assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
    assert.equal(cleanups, 1);
    assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === reply.text));
  } finally { await f.codex.close(); database.close(); }
});

for (const change of ['connection', 'command', 'invalidation', 'close', 'legacy-admission']) {
  test(`Codex async live reply cannot overwrite a newer projection after ${change}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      if (change !== 'legacy-admission') {
        await f.codex.send(f.sessionKey, 'original');
        await f.runtime.drainQueuedTurn(f.sessionKey);
      }
      f.runtime.options.projectAssistant = async () => { await gate; return { text: 'Stale asynchronous live reply', media: [] }; };
      f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native', item: { id: 'reply', type: 'agentMessage', text: 'Original live reply' } });
      const projection = Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      let closing: Promise<void> | undefined;
      if (change === 'connection') f.runtime.setConnection('replacement');
      else if (change === 'invalidation') f.runtime.invalidateExecution();
      else if (change === 'close') closing = f.codex.close();
      else {
        const before = database.codexExecutions.get(f.sessionKey);
        if (before) {
          database.codexExecutions.observe(f.sessionKey, before.connectionId, 'native', 'completed');
          assert.equal(database.codexExecutions.settleHistory(database.codexExecutions.get(f.sessionKey)!, 'current'), true);
        }
        assert.equal(database.codexExecutions.begin(f.sessionKey, 'successor', f.runtime.connectionId), true);
        assert.equal(database.codexExecutions.acknowledge(f.sessionKey, 'successor', f.runtime.connectionId, 'native', () => {}), true);
      }
      const id = `${f.sessionKey}:codex-reply`;
      f.store.addMessage({ id, sessionKey: f.sessionKey, turnId: 'native', role: 'assistant', text: 'Newer projected view', createdAt: 1 });
      const eventCount = f.store.getEventsSince().length;
      release(); await projection; await closing;
      assert.equal(f.store.getMessages(f.sessionKey).find((message) => message.id === id)?.text, 'Newer projected view');
      assert.equal(f.store.getEventsSince().length, eventCount, 'discarded callback must not mutate aliases or emit messages');
      if (change === 'command') {
        f.runtime.activeTurnIds.clear();
        f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'native', itemId: 'reply', delta: 'New command delta' });
        assert.equal(f.store.getMessages(f.sessionKey).find((message) => message.id === id)?.text, 'New command delta',
          'a completion marker from the predecessor must not suppress a reused item ID in the successor');
      }
    } finally { release(); await f.codex.close(); database.close(); }
  });
}

test('Codex live projection remains valid when its own execution reaches terminal during artifact work', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.runtime.request = async () => ({ turn: { id: 'native' } });
  try {
    await f.codex.send(f.sessionKey, 'original');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    f.runtime.options.projectAssistant = async (text: string) => { await gate; return { text, media: [] }; };
    f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native', item: { id: 'reply', type: 'agentMessage', text: 'Valid trailing reply' } });
    database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
    release(); await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
    assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Valid trailing reply'));
    assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
  } finally { release(); await f.codex.close(); database.close(); }
});

for (const state of ['starting', 'send_unknown', 'restarted', 'identity_conflict', 'evidence_overflow', 'foreign-connection'] as const) {
  test(`Codex ${state} notifications retain evidence without projecting an unowned run`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let projections = 0, reconciles = 0, cleanups = 0;
    try {
      database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
      if (state === 'send_unknown') database.codexExecutions.uncertain(f.sessionKey, 'original');
      if (state === 'restarted') database.codexExecutions.recoverInterrupted();
      if (state === 'identity_conflict') {
        database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
        database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'different', () => {});
      }
      if (state === 'evidence_overflow') {
        for (let index = 0; index < 5; index++) database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, `candidate-${index}`, 'running');
      }
      if (state === 'foreign-connection') f.runtime.setConnection('replacement');
      const before = database.codexExecutions.get(f.sessionKey)!, events = f.store.getEventsSince().length;
      f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
      f.runtime.reconcileCompletedTurn = () => { reconciles++; };
      f.runtime.cleanupSecretFiles = async () => { cleanups++; };
      for (const [method, params] of [
        ['turn/started', { turn: { id: 'native' } }],
        ['item/started', { turnId: 'native', item: { id: 'tool', type: 'commandExecution', command: 'synthetic', status: 'inProgress' } }],
        ['item/agentMessage/delta', { turnId: 'native', itemId: 'reply', delta: 'Unowned early reply' }],
        ['item/completed', { turnId: 'native', item: { id: 'reply', type: 'agentMessage', text: 'Unowned early reply' } }],
        ['turn/completed', { turn: { id: 'native', status: 'completed' } }],
      ] as const) f.runtime.handleNotification(method, { threadId: 'synthetic', ...params });
      await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      const fact = database.codexExecutions.get(f.sessionKey)!;
      assert.equal(fact.commandId, before.commandId);
      assert.equal(fact.phase, before.phase);
      assert.equal(fact.runId, before.runId);
      assert.equal(f.store.getEventsSince().length, events);
      assert.equal(projections, 0);
      assert.equal(reconciles, 0);
      assert.equal(cleanups, 0);
      for (const map of ['activeTurnIds', 'completedTurnIds', 'assistantText', 'toolStartedAt']) assert.equal(f.runtime[map].size, 0);
      if (state === 'starting' || state === 'send_unknown') {
        assert.ok(fact.revision > before.revision, 'bounded native observations survive without owning the command');
        database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
        assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
        assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'syncing');
      } else assert.deepEqual(fact, before);
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const cause of ['restarted', 'identity_conflict']) {
  test(`Codex asynchronous live projection is discarded if its execution becomes ${cause}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
      database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'native', () => {});
      f.runtime.options.projectAssistant = async (text: string) => { await gate; return { text, media: [] }; };
      f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native',
        item: { id: 'reply', type: 'agentMessage', text: 'Invalidated in-flight reply' } });
      if (cause === 'restarted') database.codexExecutions.recoverInterrupted();
      else database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, 'different', () => {});
      const events = f.store.getEventsSince().length;
      release(); await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'unknown');
      assert.equal(f.store.getEventsSince().length, events);
      assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Invalidated in-flight reply'));
    } finally { release(); await f.codex.close(); database.close(); }
  });
}

for (const acknowledgedTurn of ['native', 'other-native']) {
  test(`Codex early live reply is recovered only from acknowledged native history: ${acknowledgedTurn}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let projections = 0;
    try {
      database.codexExecutions.begin(f.sessionKey, 'original', f.runtime.connectionId);
      f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
      const events = f.store.getEventsSince().length;
      f.runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'native', item: { id: 'reply', type: 'agentMessage', text: 'Early live reply' } });
      await Promise.all(f.runtime.assistantProjections.get(f.sessionKey) ?? []);
      assert.equal(projections, 0);
      assert.equal(f.store.getEventsSince().length, events);
      database.codexExecutions.acknowledge(f.sessionKey, 'original', f.runtime.connectionId, acknowledgedTurn, () => {});
      database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, acknowledgedTurn, 'completed');
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read');
        return { thread: { id: 'synthetic', turns: [{ id: acknowledgedTurn, status: 'completed', itemsView: 'full',
          items: acknowledgedTurn === 'native' ? [{ id: 'reply', type: 'agentMessage', text: 'Early live reply', phase: 'final_answer' }] : [] }] } };
      };
      await f.runtime.turnWorker.options.reconcile(f.sessionKey);
      assert.equal(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Early live reply'), acknowledgedTurn === 'native');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
      if (acknowledgedTurn !== 'native') assert.equal(projections, 0);
    } finally { await f.codex.close(); database.close(); }
  });
}

test('Codex actual start RPC timeout is unknown, not a failed execution, and never replays', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database, 5);
  let writes = 0;
  f.runtime.child = { stdin: { writable: true, write: () => { writes++; return true; } } };
  try {
    await f.codex.send(f.sessionKey, 'possibly executed');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(f.runtime.pending.size, 0);
    assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'outcome_unknown');
    assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
    assert.equal(f.store.getSession(f.sessionKey)?.runCompletedAt, undefined);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(writes, 1);
  } finally { await f.codex.close(); database.close(); }
});

test('Codex start RPC error is not evidence that native execution failed without side effects', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database);
  f.runtime.request = async () => { throw new Error('transport closed after write'); };
  try {
    await f.codex.send(f.sessionKey, 'possibly executed');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'outcome_unknown');
    assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
    assert.equal(f.store.getSession(f.sessionKey)?.runCompletedAt, undefined);
  } finally { await f.codex.close(); database.close(); }
});

for (const fault of ['wrong-thread', 'missing-thread', 'conflicting-outcome']) {
  test(`Codex final-history reconciliation rejects ${fault} before projecting content`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    let reads = 0, projections = 0;
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
      f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read'); reads++;
        return { thread: { ...(fault === 'missing-thread' ? {} : { id: fault === 'wrong-thread' ? 'foreign' : 'synthetic' }),
          turns: [{ id: 'native', status: fault === 'conflicting-outcome' ? 'failed' : 'completed', itemsView: 'full',
            items: [{ id: 'invalid-final', type: 'agentMessage', text: 'Untrusted final history', phase: 'final_answer' }] }] } };
      };
      f.runtime.reconcileCompletedTurn(f.sessionKey, 'synthetic', Date.now(), 'native');
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(projections, 0, 'invalid source must not reach artifact projection');
      assert.equal(reads, 5, 'invalid reads share the existing bounded retry budget');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, 'completed');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'error');
      assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Untrusted final history'));
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const during of ['wait', 'read', 'projection']) {
  for (const change of ['connection', 'command']) {
    test(`Codex final history is fenced when ${change} changes during ${during}`, async () => {
      // This matrix checks identity fences, not timeouts. A 5ms wall-clock
      // budget can expire before projection under joint-test contention and
      // skip the very mutation this test must exercise. Deadline tests retain
      // their separate short budget; no production deadline is changed.
      const database = new ConnectorUserStore(':memory:'), f = fixture(database, 1000);
      let reads = 0, projections = 0, changed = false;
      f.runtime.request = async () => ({ turn: { id: 'native' } });
      const mutate = () => {
        if (changed) return;
        changed = true;
        if (change === 'connection') f.runtime.setConnection('replacement');
        else {
          const before = database.codexExecutions.get(f.sessionKey)!;
          assert.equal(database.codexExecutions.settleHistory(before, 'current'), true);
          assert.equal(database.codexExecutions.begin(f.sessionKey, 'successor', before.connectionId), true);
          assert.equal(database.codexExecutions.acknowledge(f.sessionKey, 'successor', before.connectionId, 'native', () => {}), true);
        }
      };
      try {
        await f.codex.send(f.sessionKey, 'original');
        await f.runtime.drainQueuedTurn(f.sessionKey);
        database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
        f.runtime.options.projectAssistant = async (text: string) => {
          projections++; if (during === 'projection') mutate(); return { text, media: [] };
        };
        f.runtime.request = async (method: string) => {
          if (method === 'thread/backgroundTerminals/list') return { data: [] };
          assert.equal(method, 'thread/read'); reads++;
          if (during === 'read') mutate();
          return { thread: { id: 'synthetic', turns: [{ id: 'native', status: 'completed', itemsView: 'full',
            items: [{ id: 'stale-final', type: 'agentMessage', text: 'Stale final history', phase: 'final_answer' }] }] } };
        };
        f.runtime.reconcileCompletedTurn(f.sessionKey, 'synthetic', Date.now(), 'native');
        if (during === 'wait') mutate();
        await f.runtime.completingTurns.get(f.sessionKey);
        assert.equal(reads, during === 'wait' ? 0 : 1);
        assert.equal(projections, during === 'projection' ? 1 : 0);
        assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Stale final history'));
        const fact = database.codexExecutions.get(f.sessionKey)!;
        assert.equal(fact.phase, change === 'command' ? 'running' : 'completed');
        assert.equal(fact.sync, change === 'command' ? 'current' : 'syncing');
      } finally { await f.codex.close(); database.close(); }
    });
  }
}

for (const during of ['read', 'projection']) {
  test(`Codex final history retries a changed fact revision during ${during} without publishing the stale snapshot`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database, 1000);
    let reads = 0, projections = 0;
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
      const execution = database.codexExecutions.get(f.sessionKey)!;
      f.runtime.options.projectAssistant = async (text: string) => {
        projections++;
        if (during === 'projection' && reads === 1) database.codexExecutions.settleHistory(execution, 'error');
        return { text, media: [] };
      };
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read'); reads++;
        if (during === 'read' && reads === 1) database.codexExecutions.settleHistory(execution, 'error');
        return { thread: { id: 'synthetic', turns: [{ id: 'native', status: 'completed', itemsView: 'full',
          items: [{ id: 'final', type: 'agentMessage', text: reads === 1 ? 'Discarded revision' : 'Current revision', phase: 'final_answer' }] }] } };
      };
      f.runtime.reconcileCompletedTurn(f.sessionKey, 'synthetic', Date.now(), 'native');
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(reads, 2);
      assert.equal(projections, during === 'read' ? 1 : 2);
      assert.ok(!f.store.getMessages(f.sessionKey).some((message) => message.text === 'Discarded revision'));
      assert.ok(f.store.getMessages(f.sessionKey).some((message) => message.text === 'Current revision'));
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
    } finally { await f.codex.close(); database.close(); }
  });
}

test('Codex legacy history publication failure after settlement retains the execution fence without resend', async () => {
  const database = new ConnectorUserStore(':memory:'), f = fixture(database, 1000);
  let starts = 0, publications = 0;
  f.runtime.request = async () => { starts++; return { turn: { id: 'native' } }; };
  try {
    await f.codex.send(f.sessionKey, 'original');
    await f.runtime.drainQueuedTurn(f.sessionKey);
    database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
    const original = database.codexExecutions.get(f.sessionKey)!;
    f.runtime.applyHistory = () => {
      publications++;
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current', 'settlement precedes publication');
      throw new Error('synthetic publication failure');
    };
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', turns: [{ id: 'native', status: 'completed', itemsView: 'full',
        items: [{ id: 'final', type: 'agentMessage', text: 'Unpublished history', phase: 'final_answer' }] }] } };
    };
    f.runtime.reconcileCompletedTurn(f.sessionKey, 'synthetic', Date.now(), 'native');
    await f.runtime.completingTurns.get(f.sessionKey);
    assert.equal(publications, 1);
    assert.equal(starts, 1);
    const current = database.codexExecutions.get(f.sessionKey)!;
    assert.equal(current.commandId, original.commandId);
    assert.equal(current.runId, original.runId);
    assert.equal(database.codexExecutions.canStart(f.sessionKey), false);
    assert.equal(f.runtime.executionUnavailable, true);
    assert.ok(!f.store.getMessages(f.sessionKey).some(message => message.text === 'Unpublished history'));
  } finally { await f.codex.close(); database.close(); }
});

for (const change of ['revision', 'successor'] as const) {
  test(`Codex legacy final settlement rejects stale CAS before publication after ${change}`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database, 1000);
    let reads = 0, changed = false;
    const settle = database.codexExecutions.settleHistory.bind(database.codexExecutions);
    f.runtime.request = async () => ({ turn: { id: 'native' } });
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      database.codexExecutions.observe(f.sessionKey, f.runtime.connectionId, 'native', 'completed');
      database.codexExecutions.settleHistory = (expected, sync) => {
        if (!changed && sync === 'current') {
          changed = true;
          assert.equal(settle(database.codexExecutions.get(f.sessionKey)!, 'error'), true);
          if (change === 'successor') {
            assert.equal(settle(database.codexExecutions.get(f.sessionKey)!, 'current'), true);
            assert.equal(database.codexExecutions.begin(f.sessionKey, 'successor', f.runtime.connectionId), true);
            assert.equal(database.codexExecutions.acknowledge(f.sessionKey, 'successor', f.runtime.connectionId, 'successor-native', () => {}), true);
          }
        }
        return settle(expected, sync);
      };
      f.runtime.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read'); reads++;
        return { thread: { id: 'synthetic', turns: [{ id: 'native', status: 'completed', itemsView: 'full',
          items: [{ id: 'final', type: 'agentMessage', text: reads === 1 ? 'Rejected CAS history' : 'Current CAS history', phase: 'final_answer' }] }] } };
      };
      f.runtime.reconcileCompletedTurn(f.sessionKey, 'synthetic', Date.now(), 'native');
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(changed, true);
      assert.equal(reads, change === 'revision' ? 2 : 1);
      assert.ok(!f.store.getMessages(f.sessionKey).some(message => message.text === 'Rejected CAS history'));
      const current = database.codexExecutions.get(f.sessionKey)!;
      assert.equal(current.sync, 'current');
      if (change === 'revision') assert.ok(f.store.getMessages(f.sessionKey).some(message => message.text === 'Current CAS history'));
      else { assert.equal(current.commandId, 'successor'); assert.equal(current.phase, 'running'); }
    } finally { await f.codex.close(); database.close(); }
  });
}

for (const outcome of ['failed', 'completed', 'interrupted']) {
  test(`Codex early ${outcome} evidence does not bind a command whose ACK was lost`, async () => {
    const database = new ConnectorUserStore(':memory:'), f = fixture(database);
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      if (method === 'thread/read') {
        const result = history('unrelated');
        result.thread.turns[0]!.status = outcome;
        return result;
      }
      assert.equal(method, 'turn/start');
      f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'native' } });
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'native', status: outcome } });
      throw new Error('ACK lost after terminal event');
    };
    try {
      await f.codex.send(f.sessionKey, 'original');
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
      await f.runtime.completingTurns.get(f.sessionKey);
      assert.equal(f.store.getSession(f.sessionKey)?.runtime?.phase, 'unknown');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.runId, undefined);
      assert.equal(database.turns.head('codex', f.sessionKey)?.state, 'outcome_unknown', 'terminal alone cannot bind a missing command ACK');
      const commandId = database.turns.head('codex', f.sessionKey)!.id;
      assert.equal(database.codexExecutions.acknowledge(f.sessionKey, commandId, f.runtime.connectionId, 'native',
        (db) => database.turns.completeInTransaction(db, 'codex', commandId)), true);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.phase, outcome, 'ACK binds, but cannot overwrite, the saved terminal evidence');
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'syncing');
      await f.runtime.turnWorker.options.reconcile(f.sessionKey);
      assert.equal(database.codexExecutions.get(f.sessionKey)?.sync, 'current');
    } finally { await f.codex.close(); database.close(); }
  });
}
