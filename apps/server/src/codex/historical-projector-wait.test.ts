import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer, historicalProjection } from './app-server.js';
import { RolloutProjection } from './rollout-projection.js';

for (const outcome of ['completed', 'failed', 'interrupted'] as const) {
  test(`historical projector hang is bounded for ${outcome} without releasing its original owner`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-historical-projector-'));
    const users = new ConnectorUserStore(':memory:');
    const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
    let release!: () => void, calls = 0, wakes = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
      defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
      executions: users.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 20,
      projectAssistant: async text => { calls++; await held; return { text, media: [] }; } });
    const runtime = codex as any, key = 'codex:synthetic';
    runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
    store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
      runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
    store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Keep visible', createdAt: 1 });
    users.codexExecutions.begin(key, 'command', 'synthetic-connection');
    users.codexExecutions.acknowledge(key, 'command', 'synthetic-connection', 'turn', () => {});
    runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'only history reads, never input replay');
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: outcome, items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered' }] },
      ] } };
    };
    runtime.rolloutReader.readSnapshot = async () => new RolloutProjection([]);
    runtime.turnWorker.wake = () => { wakes++; };
    const logs: unknown[][] = [], previous = console.error;
    console.error = (...args) => { logs.push(args); };
    t.after(async () => { release(); console.error = previous; await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
    runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
    const task = runtime.completingTurns.get(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = await Promise.race([task.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), 500);
    })]);
    clearTimeout(timer);
    if (!bounded) { release(); await task; }
    assert.equal(bounded, true, 'historical projector must not hold final history indefinitely');
    assert.equal(calls, 1); assert.equal(wakes, 0);
    assert.equal(runtime.assistantProjections.get(key)?.size, 1);
    assert.equal(users.codexExecutions.canStart(key), false);
    assert.equal(users.codexExecutions.get(key)?.sync, 'error');
    assert.equal(store.getMessages(key)[0]?.text, 'Keep visible');
    assert.ok(logs.some(args => JSON.stringify(args).includes('history-projection')));
    runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'turn', outcome);
    await runtime.completingTurns.get(key);
    assert.equal(calls, 1, 'retry cannot replace or duplicate the still-pending projector');
    const pending = [...runtime.assistantProjections.get(key)] as Promise<void>[];
    release(); await Promise.all(pending);
    assert.equal(users.codexExecutions.canStart(key), false, 'settlement alone is not native safety proof');
    runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'turn', outcome);
    await runtime.completingTurns.get(key);
    assert.equal(store.getSession(key)?.runtime?.sync, 'current');
    assert.equal(calls, 2); assert.equal(wakes, 1, 'fresh original safety proof resumes the normal worker');
  });
}

function fixture(projector: (text: string) => Promise<{ text: string; media: [] }>) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-projector-boundary-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 20,
    projectAssistant: projector });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
    runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Keep visible', createdAt: 1 });
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'only history reads, never input replay');
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered' }] },
    ] } };
  };
  runtime.rolloutReader.readSnapshot = async () => new RolloutProjection([]);
  return { codex, runtime, key, users, store, async close() {
    await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('history refresh timeout retains visible messages and recovers only after original settlement and a fresh read', async t => {
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async text => { calls++; await held; return { text, media: [] }; });
  t.after(async () => { release(); await f.close(); });
  await assert.rejects(f.codex.refreshSession(f.key, { fresh: true }), /(?:Historical assistant projection|Codex rollout read) is still pending/);
  assert.equal(calls, 1); assert.equal(f.runtime.assistantProjections.get(f.key)?.size, 1);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
  await assert.rejects(f.codex.refreshSession(f.key, { fresh: true }), /(?:Historical assistant projection|Codex rollout read) is still pending/);
  assert.equal(calls, 1, 'refresh cannot duplicate the pending original projection');
  release(); await Promise.all([...f.runtime.assistantProjections.get(f.key)]);
  await Promise.allSettled([...f.runtime.rolloutReader.snapshotWaits.keys()]);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible', 'late result cannot apply a disposed snapshot');
  await f.codex.refreshSession(f.key, { fresh: true });
  assert.equal(calls, 2); assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Recovered'));
});

test('shutdown drains the original historical projector after its observer timed out', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async text => { await held; return { text, media: [] }; });
  t.after(async () => { release(); await f.close(); });
  await assert.rejects(f.runtime.historyAssistantProjector(f.key, performance.now() + 20)('Recovered'));
  let closed = false;
  const closing = f.codex.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, false, 'observer timeout is not proof of original owner exit');
  release(); await closing;
  assert.equal(closed, true);
});

for (const fault of ['private-error', 'hostile-value', 'logger-failure'] as const) {
  test(`late historical projection failure is safely observed: ${fault}`, async t => {
    let reject!: (error: unknown) => void, coercions = 0;
    const secret = 'PRIVATE_HISTORY_PATH_TOKEN_REPLY';
    const held = new Promise<never>((_, fail) => { reject = fail; });
    const f = fixture(async () => held);
    const logs: unknown[][] = [], previous = console.warn;
    console.warn = (...args) => { logs.push(args); if (fault === 'logger-failure') throw Error(secret); };
    t.after(async () => { reject(Error(secret)); console.warn = previous; await f.close(); });
    await assert.rejects(f.runtime.historyAssistantProjector(f.key, performance.now() + 20)('Recovered'));
    const tasks = [...f.runtime.assistantProjections.get(f.key)] as Promise<void>[];
    reject(fault === 'hostile-value' ? { [Symbol.toPrimitive]() { coercions++; throw Error(secret); } } : Error(secret));
    await Promise.all(tasks);
    assert.equal(coercions, 0); assert.equal(f.runtime.assistantProjections.get(f.key)?.size, 0);
    assert.deepEqual(logs, [['[codex-assistant-projection-failed]', { stage: 'history-projection', fault: 'unavailable' }]]);
    assert.equal(JSON.stringify(logs).includes(secret), false);
    assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
  });
}

test('sequential historical projections retire each original and preserve optional enrichment fallback', async t => {
  const calls: string[] = [];
  const f = fixture(async text => {
    calls.push(text); if (text === 'Fallback') throw Error('PRIVATE_ENRICHMENT_ERROR');
    return { text: 'Projected ' + text, media: [] };
  });
  t.after(() => f.close());
  const projected = await historicalProjection(f.key, [{ id: 'turn', status: 'completed', items: [
    { id: 'a', type: 'agentMessage', text: 'First' },
    { id: 'b', type: 'agentMessage', text: 'Fallback' },
    { id: 'c', type: 'agentMessage', text: 'Last' },
  ] }], f.runtime.historyAssistantProjector(f.key, performance.now() + 1000));
  assert.deepEqual(calls, ['First', 'Fallback', 'Last']);
  assert.deepEqual(projected.messages.map(message => message.text), ['Projected First', 'Fallback', 'Projected Last']);
  assert.equal(f.runtime.assistantProjections.get(f.key)?.size, 0);
});

test('reconnection during a held historical refresh cannot publish its late result', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async text => { await held; return { text, media: [] }; });
  t.after(async () => { release(); await f.close(); });
  const refreshing = f.codex.refreshSession(f.key, { fresh: true });
  while (!f.runtime.assistantProjections.get(f.key)?.size) await new Promise(resolve => setImmediate(resolve));
  f.runtime.setConnection('different-connection');
  release(); await assert.rejects(refreshing, /obsolete/);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Keep visible');
});

for (const sink of ['available', 'throwing'] as const) {
test(`oversized-input recovery defers a held projector before native mutation with ${sink} diagnostics`, async t => {
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async text => { calls++; await held; return { text, media: [] }; });
  const logs: unknown[][] = [], previous = console.warn;
  console.warn = (...args) => { logs.push(args); if (sink === 'throwing') throw Error('private diagnostic failure'); };
  t.after(async () => { release(); console.warn = previous; await f.close(); });
  f.store.addMessage({ id: 'old-failure', sessionKey: f.key, role: 'assistant', status: 'failed',
    text: '413 Payload Too Large', createdAt: 2 });
  f.runtime.isSessionHistoryReady = () => true;
  const methods: string[] = [];
  f.runtime.request = async (method: string) => {
    methods.push(method);
    assert.equal(method, 'thread/read', 'pending history must precede every native mutation');
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'ok', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered' }] },
      { id: 'failed', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] },
    ] } };
  };
  const recovering = f.runtime.recoverPayloadTooLargeThread(f.key, 'synthetic', 'original-command');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = await Promise.race([recovering.then(() => true), new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), 500);
  })]);
  clearTimeout(timer);
  if (!bounded) { release(); await recovering.catch(() => {}); }
  assert.equal(bounded, true, 'recovery history must not wait forever before native mutation');
  assert.equal(await recovering, false);
  assert.equal(calls, 1);
  assert.equal(await f.runtime.recoverPayloadTooLargeThread(f.key, 'synthetic', 'original-command'), false);
  assert.equal(calls, 1, 'retry cannot duplicate the unresolved original projector');
  assert.deepEqual(methods, ['thread/read', 'thread/read']);
  assert.deepEqual(logs, Array.from({ length: 2 }, () => [
    '[codex-history-recovery-deferred]', { stage: 'history-projection', fault: 'unverified' },
  ]));
  assert.equal(f.users.codexExecutions.get(f.key), undefined);
  assert.equal(f.runtime.assistantProjections.get(f.key)?.size, 1);
  assert.ok(f.store.getMessages(f.key).some(message => message.id === 'old-failure'));
  release(); await Promise.all([...f.runtime.assistantProjections.get(f.key)]);
  assert.equal(f.users.codexExecutions.get(f.key), undefined, 'settlement alone cannot admit execution');
  assert.ok(f.store.getMessages(f.key).some(message => message.id === 'old-failure'));
});
}
