import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

function fixture(context: test.TestContext, managed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-error-recovery-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  const key = 'codex:synthetic';
  runtime.ensureStarted = async () => {};
  runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running', hasActiveRun: true,
    runtime: { turnId: 'turn', phase: 'running', threadActivity: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  if (managed) {
    users.codexExecutions.begin(key, 'command', 'synthetic-connection');
    users.codexExecutions.acknowledge(key, 'command', 'synthetic-connection', 'turn', () => {});
  } else runtime.activeTurnIds.set(key, 'turn');
  context.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  const notify = (willRetry: boolean, turnId: string | undefined = 'turn') => runtime.handleNotification('error', {
    threadId: 'synthetic', turnId, willRetry, error: { message: 'private-upstream-detail' },
  });
  return { codex, runtime, users, store, key, notify };
}

test('self-service recovery is a wake hint, never an execution or queue mutation', async context => {
  const { codex, runtime, users, key } = fixture(context, true);
  let wakes = 0;
  runtime.turnWorker.wake = () => { wakes++; return true; };
  runtime.request = async () => assert.fail('Manual recheck must not dispatch native work');
  const before = users.codexExecutions.get(key);
  assert.equal(await codex.requestSessionRecovery(key, 'turn'), true);
  assert.equal(wakes, 1);
  assert.deepEqual(users.codexExecutions.get(key), before);
  assert.equal(await codex.requestSessionRecovery(key, 'other'), false);
  assert.equal(wakes, 1);
});

test('recovery cannot schedule across a runtime connection replacement', async context => {
  const { codex, runtime, key } = fixture(context, true);
  const read = runtime.readHistoryFact.bind(runtime);
  runtime.turnWorker.wake = () => assert.fail('Changed connection must not accept the hint');
  runtime.readHistoryFact = async (sessionKey: string) => {
    const fact = await read(sessionKey);
    runtime.setConnection('replacement');
    return fact;
  };
  assert.equal(await codex.requestSessionRecovery(key, 'turn'), false);
});

for (const managed of [false, true]) {
  test(`nonretry error prompts existing recovery once (${managed ? 'managed' : 'external'})`, context => {
    const fixtureState = fixture(context, managed);
    const { runtime, users, store, key, notify } = fixtureState;
    let wakes = 0;
    let refreshes = 0;
    runtime.turnWorker.wake = () => { wakes++; };
    runtime.refreshSession = async (sessionKey: string, options: unknown) => {
      assert.equal(sessionKey, key);
      assert.deepEqual(options, { fresh: true });
      refreshes++;
    };
    const execution = users.codexExecutions.get(key);
    runtime.threadRefreshResult.set(key, { at: Date.now(), available: true });
    for (const turnId of [undefined, 'foreign']) runtime.handleNotification('error', {
      threadId: 'synthetic', turnId, willRetry: false,
    });
    notify(true);
    assert.equal(wakes + refreshes, 0);
    assert.equal(runtime.threadRefreshResult.has(key), true);
    notify(false);
    notify(false);
    assert.equal(wakes, managed ? 1 : 0);
    assert.equal(refreshes, managed ? 0 : 1);
    assert.equal(runtime.threadRefreshResult.has(key), false);
    assert.deepEqual(users.codexExecutions.get(key), execution);
    assert.equal(store.getSession(key)?.runtime?.phase, 'running');
    assert.equal(store.getSession(key)?.hasActiveRun, true);
    assert.equal(JSON.stringify(store.getSession(key)).includes('private-upstream-detail'), false);
  });
}

test('missing completion notification recovers an external failed turn from native evidence', async context => {
  const { runtime, store, key, notify } = fixture(context);
  let reads = 0;
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    reads++;
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'failed', items: [] },
    ] } };
  };
  notify(false);
  await Promise.all([...runtime.historyRefreshDrains]);
  await runtime.completingTurns.get(key);
  assert.ok(reads > 0 && reads <= 2);
  assert.equal(store.getSession(key)?.runtime?.phase, 'failed');
  assert.equal(store.getSession(key)?.runtime?.sync, 'current');
  assert.equal(store.getSession(key)?.hasActiveRun, false);
  assert.equal(runtime.activeTurnIds.has(key), false);
  assert.equal(store.getMessages(key).filter(message => message.status === 'failed').length, 1);
});

test('managed error recovery uses the original worker and retains the acknowledged execution identity', async context => {
  const { runtime, users, store, key, notify } = fixture(context, true);
  let wakes = 0;
  runtime.turnWorker.wake = () => { wakes++; };
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'failed', items: [] },
    ] } };
  };
  notify(false);
  assert.equal(wakes, 1);
  assert.equal(users.codexExecutions.get(key)?.phase, 'running');
  await runtime.turnWorker.options.reconcile(key);
  await runtime.completingTurns.get(key);
  const execution = users.codexExecutions.get(key);
  assert.equal(execution?.commandId, 'command');
  assert.equal(execution?.runId, 'turn');
  assert.equal(execution?.phase, 'failed');
  assert.equal(execution?.sync, 'current');
  assert.equal(store.getSession(key)?.hasActiveRun, false);
  assert.equal(users.turns.list('codex', key).length, 0);
});

test('close waits for the original error recovery read rather than releasing its owner', async context => {
  const { codex, runtime, key, notify } = fixture(context);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  runtime.request = async () => {
    entered();
    await held;
    return { thread: { id: 'synthetic', status: { type: 'active' }, turns: [
      { id: 'turn', status: 'inProgress', items: [] },
    ] } };
  };
  notify(false);
  await started;
  let closed = false;
  const closing = codex.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try { assert.equal(closed, false); }
  finally { release(); }
  await closing;
  assert.equal(runtime.historyRefreshDrains.size, 0);
  assert.equal(runtime.completingTurns.has(key), false);
});

test('original recovery worker confirms a failed execution even when both error and completion notices are lost', async context => {
  const { codex, runtime, users, store, key } = fixture(context, true);
  const calls: string[] = [];
  runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'failed', items: [] },
    ] } };
  };
  await runtime.turnWorker.options.reconcile(key);
  await runtime.completingTurns.get(key);
  assert.equal(users.codexExecutions.get(key)?.commandId, 'command');
  assert.equal(users.codexExecutions.get(key)?.runId, 'turn');
  assert.equal(users.codexExecutions.get(key)?.phase, 'failed');
  assert.equal(users.codexExecutions.get(key)?.sync, 'current');
  assert.equal(store.getSession(key)?.hasActiveRun, false);
  assert.equal(codex.isSessionHistoryReady(key), true);
  assert.ok(calls.length > 0);
  assert.equal(calls.some(method => method === 'turn/start' || method === 'thread/resume'), false);
  assert.equal(users.turns.list('codex', key).length, 0);
});

for (const managed of [false, true]) {
  test(`late identified events cannot resurrect recovered failure (${managed ? 'managed' : 'external'})`, async context => {
    const { runtime, users, store, key, notify } = fixture(context, managed);
    runtime.turnWorker.wake = () => {};
    runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: 'failed', items: [] },
      ] } };
    };
    notify(false);
    if (managed) await runtime.turnWorker.options.reconcile(key);
    await Promise.all([...runtime.historyRefreshDrains]);
    await runtime.completingTurns.get(key);
    const execution = users.codexExecutions.get(key);
    runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'turn' } });
    runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'old', delta: 'synthetic' });
    runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
    notify(false);
    assert.equal(store.getSession(key)?.runtime?.phase, 'failed');
    assert.equal(store.getSession(key)?.runtime?.sync, 'current');
    assert.equal(store.getSession(key)?.hasActiveRun, false);
    assert.deepEqual(users.codexExecutions.get(key), execution);
  });
}

test('old recovery read cannot settle an execution on a replacement connection', async context => {
  const { codex, runtime, users, store, key, notify } = fixture(context, true);
  runtime.turnWorker.wake = () => {};
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    entered();
    await held;
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'failed', items: [] },
    ] } };
  };
  notify(false);
  const recovering = runtime.turnWorker.options.reconcile(key);
  const rejected = assert.rejects(recovering, /Codex thread snapshot obsolete/);
  await started;
  let execution;
  try {
    runtime.setConnection('replacement-connection');
    await runtime.nativeObservations.drain();
    execution = users.codexExecutions.get(key);
  } finally { release(); }
  await rejected;
  await Promise.all([...runtime.historyRefreshDrains]);
  assert.deepEqual(users.codexExecutions.get(key), execution);
  assert.equal(users.codexExecutions.get(key)?.phase, 'unknown');
  assert.equal(codex.isSessionHistoryReady(key), false);
  assert.equal(store.getSession(key)?.hasActiveRun, true);
});

test('systemError history after a missing completion is not availability or safe continuation proof', async context => {
  const { codex, runtime, users, store, key, notify } = fixture(context, true);
  runtime.turnWorker.wake = () => {};
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    return { thread: { id: 'synthetic', status: { type: 'systemError' }, turns: [
      { id: 'turn', status: 'failed', items: [] },
    ] } };
  };
  notify(false);
  await assert.rejects(runtime.turnWorker.options.reconcile(key), /Codex thread unavailable/);
  await runtime.completingTurns.get(key);
  assert.equal(store.getSession(key)?.hasActiveRun, true);
  assert.equal(users.codexExecutions.get(key)?.phase, 'running');
  assert.equal(codex.isSessionHistoryReady(key), false);
  assert.equal(users.turns.list('codex', key).length, 0);
});

for (const result of ['running', 'read-failure', 'foreign-turn'] as const) {
  test(`nonretry error does not unlock without terminal evidence (${result})`, async context => {
    const { runtime, users, store, key, notify } = fixture(context);
    let reads = 0;
    runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      reads++;
      if (result === 'read-failure') throw new Error('Synthetic native outage');
      return { thread: { id: 'synthetic', status: { type: result === 'running' ? 'active' : 'idle' }, turns: [
        { id: result === 'foreign-turn' ? 'foreign' : 'turn', status: result === 'running' ? 'inProgress' : 'failed', items: [] },
      ] } };
    };
    notify(false);
    await Promise.all([...runtime.historyRefreshDrains]);
    assert.equal(reads, 1);
    assert.equal(runtime.activeTurnIds.get(key), 'turn');
    assert.equal(store.getSession(key)?.runtime?.phase, 'running');
    assert.equal(users.turns.list('codex', key).length, 0);
    notify(false);
    await Promise.all([...runtime.historyRefreshDrains]);
    assert.equal(reads, 1);
  });
}
