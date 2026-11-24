import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import type { NativeResumeInput, NativeResumeReceipt } from './native-resume.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-final-outcome-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
    runtime: { turnId: 'turn', phase: 'finalizing', connection: 'connected', sync: 'syncing', lastEventAt: 1 } });
  store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
  t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  return { codex, runtime, store, users, key, dir };
}

const outcomes = ['completed', 'failed', 'interrupted'] as const;
const completedGoal = { threadId: 'synthetic', objective: 'Finished task', status: 'complete',
  tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 };
function failedReloadFixture(t: test.TestContext) {
  const f = fixture(t), calls: string[] = [];
  f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'failed');
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  const path = join(f.dir, 'rollout.jsonl');
  writeFileSync(path, '');
  const snapshot = (status = 'systemError') => ({ thread: { id: 'synthetic', path,
    status: { type: status }, canAcceptDirectInput: status === 'idle', turns: [{ id: 'turn', status: 'failed', items: [] }] } });
  let loaded = false;
  const request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/goal/get') return { threadId: 'synthetic', goal: null };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (method === 'thread/resume') { loaded = true; return {}; }
    assert.equal(method, 'thread/read');
    return snapshot(loaded ? 'idle' : 'systemError');
  };
  f.runtime.request = request;
  return { ...f, calls, request, snapshot, reload: () => f.runtime.reloadErroredTerminal(f.key, snapshot()) };
}

for (const boundary of ['unsubscribe', 'resume', 'confirm'] as const) {
  test(`terminal reload tolerates load-only availability notification at ${boundary}`, async context => {
    const state = failedReloadFixture(context);
    state.runtime.request = async (method: string) => {
      const response = await state.request(method);
      if (method === `thread/${boundary === 'confirm' ? 'read' : boundary}`) {
        await state.runtime.projectNotification('thread/status/changed', {
          threadId: 'synthetic', status: { type: boundary === 'unsubscribe' ? 'notLoaded' : 'idle' },
        });
      }
      return response;
    };
    assert.equal((await state.reload()).thread.status.type, 'idle');
    assert.equal(state.calls.filter(method => method === 'thread/unsubscribe').length, 1);
    assert.equal(state.calls.filter(method => method === 'thread/resume').length, 1);
    assert.equal(state.calls.includes('turn/start'), false);
    assert.equal(state.users.codexExecutions.get(state.key)?.sync, 'error');
  });
}

for (const checkpoint of [false, true]) {
  test(`terminal reload ignores no-op thread-started projection: checkpoint=${checkpoint}`, async context => {
    const state = failedReloadFixture(context);
    if (checkpoint) state.users.codexExecutions.invalidateNativeHistory(state.key);
    state.runtime.request = async (method: string) => {
      const response = await state.request(method);
      if (method === 'thread/resume') {
        await state.runtime.projectNotification('thread/started', state.snapshot('idle'));
        await state.runtime.projectNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'idle' } });
      }
      return response;
    };
    assert.equal((await state.reload()).thread.status.type, 'idle');
    assert.equal(state.calls.includes('turn/start'), false);
    assert.notEqual(state.users.codexExecutions.get(state.key)?.sync, 'current');
    if (checkpoint) assert.equal(state.users.codexExecutions.get(state.key)?.nativeHistory?.state, 'blocked');
  });
}

for (const boundary of ['active', 'systemError', 'projection', 'revision', 'connection', 'goal', 'successor'] as const) {
  test(`terminal reload retains ${boundary} protection after load effects start`, async context => {
    const state = failedReloadFixture(context);
    state.runtime.request = async (method: string) => {
      const response = await state.request(method);
      if (method === 'thread/resume') {
        if (boundary === 'active' || boundary === 'systemError') {
          await state.runtime.projectNotification('thread/status/changed', { threadId: 'synthetic', status: { type: boundary } });
        } else if (boundary === 'projection') state.runtime.touchProjection(state.key);
        else if (boundary === 'revision') state.users.codexExecutions.settleHistory(state.users.codexExecutions.get(state.key)!, 'current');
        else if (boundary === 'connection') state.runtime.connectionId = 'replacement';
        else if (boundary === 'goal') await state.runtime.projectNotification('thread/goal/cleared', { threadId: 'synthetic' });
        else await state.runtime.projectNotification('turn/started', { threadId: 'synthetic', turn: { id: 'successor' } });
      }
      return response;
    };
    await assert.rejects(state.reload());
    const calls = [...state.calls];
    if (boundary === 'connection') state.runtime.connectionId = 'synthetic-connection';
    assert.equal((await state.reload()).thread.status.type, 'systemError');
    assert.deepEqual(state.calls, calls);
    assert.equal(state.runtime.erroredThreadReloads.get(state.key)?.effectStarted, true);
    assert.equal(state.runtime.erroredThreadReloads.get(state.key)?.reloading, false);
    assert.equal(state.users.codexExecutions.get(state.key)?.runId, 'turn');
  });
}

test('terminal reload limits availability deferral to its own active effect window', async context => {
  const state = failedReloadFixture(context);
  let refreshes = 0;
  state.runtime.refreshSession = async () => { refreshes++; };
  state.runtime.request = async (method: string) => {
    if (method === 'thread/resume') throw Error('synthetic lost resume reply');
    return state.request(method);
  };
  await assert.rejects(state.reload());
  const version = state.runtime.projectionVersion(state.key);
  await state.runtime.projectNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'idle' } });
  assert.ok(state.runtime.projectionVersion(state.key) > version);
  assert.equal(refreshes, 1);
  assert.equal(state.runtime.erroredThreadReloads.get(state.key)?.reloading, false);
});

test('terminal reload tolerates asynchronously settled availability without changing readiness', async context => {
  const state = failedReloadFixture(context);
  const settle = state.runtime.settleNativeNotification.bind(state.runtime);
  state.runtime.settleNativeNotification = async (event: any) => settle(event);
  state.runtime.request = async (method: string) => {
    const response = await state.request(method);
    if (method === 'thread/resume') {
      state.runtime.recordNativeActivity('synthetic');
      await state.runtime.projectNotification('thread/started', state.snapshot('idle'));
      await state.runtime.projectNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'idle' } });
    }
    return response;
  };
  assert.equal((await state.reload()).thread.status.type, 'idle');
  assert.equal(state.codex.isSessionHistoryReady(state.key), false);
  assert.equal(state.calls.includes('turn/start'), false);
});

test('cold worker tolerates loading notifications but still requires fresh final reconciliation', async context => {
  const state = failedReloadFixture(context);
  state.runtime.request = async (method: string) => {
    const response = await state.request(method);
    if (['thread/unsubscribe', 'thread/resume'].includes(method)) state.runtime.recordNativeActivity('synthetic');
    if (method === 'thread/resume') {
      await state.runtime.projectNotification('thread/started', state.snapshot('idle'));
      await state.runtime.projectNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'idle' } });
    }
    return response;
  };
  await state.runtime.rehydrateCheckpointThread(state.key);
  assert.equal(state.codex.isSessionHistoryReady(state.key), false);
  assert.equal(state.users.codexExecutions.get(state.key)?.sync, 'error');
  assert.equal(state.calls.filter(method => method === 'thread/resume').length, 1);
  assert.equal(state.calls.includes('turn/start'), false);
});

test('original worker settles failed history after load notifications without replaying the turn', async context => {
  const state = failedReloadFixture(context);
  state.users.codexExecutions.invalidateNativeHistory(state.key);
  state.runtime.request = async (method: string) => {
    const response = await state.request(method);
    if (['thread/unsubscribe', 'thread/resume'].includes(method)) state.runtime.recordNativeActivity('synthetic');
    if (method === 'thread/resume') {
      await state.runtime.projectNotification('thread/started', state.snapshot('idle'));
      await state.runtime.projectNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'idle' } });
    }
    return response;
  };
  await state.runtime.rehydrateCheckpointThread(state.key);
  await state.runtime.turnWorker.options.reconcile(state.key);
  assert.equal(state.codex.isSessionHistoryReady(state.key), true);
  assert.equal(state.users.codexExecutions.get(state.key)?.phase, 'failed');
  assert.equal(state.users.codexExecutions.get(state.key)?.sync, 'current');
  assert.equal(state.users.codexExecutions.get(state.key)?.nativeHistory?.state, 'verified');
  assert.equal(state.calls.filter(method => method === 'thread/resume').length, 1);
  assert.equal(state.calls.includes('turn/start'), false);
});

for (const changed of [false, true]) {
  test(`terminal reload preserves a complete Goal and verifies its exact version: changed=${changed}`, async t => {
    const f = failedReloadFixture(t);
    let reads = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/goal/get') {
        f.calls.push(method);
        return { goal: { ...completedGoal, objective: changed && reads++ ? 'Replaced task' : completedGoal.objective } };
      }
      return f.request(method);
    };
    if (changed) await assert.rejects(f.reload());
    else assert.equal((await f.reload()).thread.status.type, 'idle');
    assert.equal(f.calls.filter(method => method === 'thread/unsubscribe').length, 1);
    assert.equal(f.calls.filter(method => method === 'thread/resume').length, 1);
    assert.equal(f.calls.includes('turn/start'), false);
    assert.equal(f.calls.some(method => ['thread/goal/set', 'thread/goal/clear'].includes(method)), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
  });
}

for (const gate of ['goal', 'background', 'read-error', 'rollout-error'] as const) {
  test(`terminal reload can retry a no-effect preflight (${gate})`, async t => {
    const f = failedReloadFixture(t);
    let blocked = true;
    f.runtime.request = async (method: string) => {
      if (blocked && method === 'thread/goal/get') {
        if (gate === 'read-error') throw Error('private-preflight');
        if (gate === 'goal') return { threadId: 'synthetic', goal: {} };
      }
      if (blocked && gate === 'background' && method === 'thread/backgroundTerminals/list') {
        return { data: [{ processId: 'private-process', itemId: 'private-tool' }] };
      }
      return f.request(method);
    };
    if (gate === 'rollout-error') {
      const validate = f.runtime.validateRolloutSnapshot.bind(f.runtime);
      f.runtime.validateRolloutSnapshot = async (path: unknown) => {
        if (blocked) throw Error('private-rollout');
        return validate(path);
      };
    }
    if (gate.endsWith('error')) await assert.rejects(f.reload());
    else assert.equal((await f.reload()).thread.status.type, 'systemError');
    assert.equal(f.calls.includes('thread/unsubscribe'), false);
    assert.equal(f.runtime.erroredThreadReloads.has(f.key), false);
    blocked = false;
    assert.equal((await f.reload()).thread.status.type, 'idle');
    assert.equal(f.calls.filter(method => method === 'thread/unsubscribe').length, 1);
    assert.equal(f.calls.filter(method => method === 'thread/resume').length, 1);
    assert.equal(f.calls.includes('turn/start'), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error', 'reload alone must not release execution');
  });
}

test('concurrent terminal reloads reserve one native effect attempt', async t => {
  const f = failedReloadFixture(t);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.runtime.request = async (method: string) => {
    if (method === 'thread/goal/get') { entered(); await held; }
    return f.request(method);
  };
  const first = f.reload();
  await started;
  try { assert.equal((await f.reload()).thread.status.type, 'systemError'); }
  finally { release(); }
  assert.equal((await first).thread.status.type, 'idle');
  assert.equal(f.calls.filter(method => method === 'thread/unsubscribe').length, 1);
});

for (const boundary of ['unsubscribe-error', 'unsubscribe-no-ack', 'resume-error', 'confirm-error'] as const) {
  test(`terminal reload never repeats a possibly dispatched effect (${boundary})`, async t => {
    const f = failedReloadFixture(t);
    f.runtime.request = async (method: string) => {
      if (method === 'thread/unsubscribe' && boundary.startsWith('unsubscribe')) {
        f.calls.push(method);
        if (boundary === 'unsubscribe-error') throw Error('private-unsubscribe');
        return { status: 'notLoaded' };
      }
      if (boundary === 'resume-error' && method === 'thread/resume'
        || boundary === 'confirm-error' && method === 'thread/read') {
        f.calls.push(method); throw Error('private-effect');
      }
      return f.request(method);
    };
    if (boundary === 'unsubscribe-no-ack') await f.reload();
    else await assert.rejects(f.reload());
    const calls = [...f.calls];
    f.runtime.request = f.request;
    assert.equal((await f.reload()).thread.status.type, 'systemError');
    assert.deepEqual(f.calls, calls);
    assert.equal(f.runtime.erroredThreadReloads.get(f.key)?.effectStarted, true);
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
  });
}

test('cold worker rehydrates an owned systemError without resending the failed turn', async t => {
  const f = failedReloadFixture(t);
  f.runtime.request = async (method: string) => {
    // Real dispatch invalidates native activity for our own effects. Recovery
    // must not reuse that old observation to certify a history/queue release.
    if (['thread/unsubscribe', 'thread/resume'].includes(method)) f.runtime.recordNativeActivity('synthetic');
    return f.request(method);
  };
  await f.runtime.rehydrateCheckpointThread(f.key);
  assert.equal(f.calls.filter(method => method === 'thread/unsubscribe').length, 1);
  assert.equal(f.calls.filter(method => method === 'thread/resume').length, 1);
  assert.equal(f.calls.includes('turn/start'), false);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
});

test('cold worker checks authority before systemError reload effects', async t => {
  const f = failedReloadFixture(t);
  await assert.rejects(f.runtime.rehydrateCheckpointThread(f.key, () => { throw Error('authority revoked'); }));
  assert.equal(f.calls.includes('thread/unsubscribe'), false);
});

for (const boundary of ['goal', 'unsubscribe'] as const) {
  test(`cold worker rechecks revoked authority after ${boundary}`, async t => {
    const f = failedReloadFixture(t);
    let authorized = true;
    f.runtime.request = async (method: string) => {
      const result = await f.request(method);
      if (method === `thread/${boundary === 'goal' ? 'goal/get' : 'unsubscribe'}`) authorized = false;
      return result;
    };
    await assert.rejects(f.runtime.rehydrateCheckpointThread(f.key, () => {
      if (!authorized) throw Error('authority revoked');
    }));
    assert.equal(f.calls.includes('thread/resume'), false);
    assert.equal(f.calls.filter(method => method === 'thread/unsubscribe').length, boundary === 'goal' ? 0 : 1);
  });
}

for (const timeout of [undefined, 1234]) {
  test(`rollout recovery validation uses history budget and honors override (${timeout ?? 'default'})`, async t => {
    const f = fixture(t);
    f.runtime.options.requestTimeoutMs = timeout;
    f.runtime.rolloutReader.validateWithin = async (_path: unknown, budget: number) => budget;
    assert.equal(await f.runtime.validateRolloutSnapshot('private-path'), timeout ?? 120000);
  });
}

for (const boundary of ['connection', 'projection', 'revision', 'unknown'] as const) {
  test(`preflight ${boundary} change prevents terminal reload effects`, async t => {
    const f = failedReloadFixture(t);
    const readFact = f.runtime.readHistoryFact.bind(f.runtime);
    const initialFact = await readFact(f.key);
    let changed = false;
    if (boundary === 'unknown') f.runtime.readHistoryFact = async () => ({
      ...initialFact, outcomeUnknown: changed,
    });
    f.runtime.request = async (method: string) => {
      const response = await f.request(method);
      if (method === 'thread/goal/get') {
        changed = true;
        if (boundary === 'connection') f.runtime.connectionId = 'new-connection';
        if (boundary === 'projection') f.runtime.touchProjection(f.key);
        if (boundary === 'revision') f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'current');
      }
      return response;
    };
    // Unknown-effect facts are provided by the async journal path in production.
    // Make the guard select the mocked fact rather than legacy synchronous reads.
    if (boundary === 'unknown') f.runtime.options.nativeJournal = {};
    try { await assert.rejects(f.reload()); }
    finally { if (boundary === 'unknown') f.runtime.options.nativeJournal = undefined; }
    assert.equal(f.calls.includes('thread/unsubscribe'), false);
    assert.equal(f.runtime.erroredThreadReloads.has(f.key), false);
  });
}

for (const boundary of ['initial', 'recheck'] as const) {
  test(`maintenance recovery rejects unknown native outcome (${boundary})`, async t => {
    const f = failedReloadFixture(t);
    const readFact = f.runtime.readHistoryFact.bind(f.runtime);
    let reads = 0;
    f.runtime.readHistoryFact = async (key: string) => ({
      ...await readFact(key), outcomeUnknown: boundary === 'initial' || ++reads > 1,
    });
    f.runtime.request = async (method: string) => {
      assert.equal(method, 'thread/read'); f.calls.push(method); return f.snapshot('idle');
    };
    await assert.rejects(f.runtime.recoverMaintenanceHistoryWork(f.key, () => {}));
    assert.deepEqual(f.calls, boundary === 'initial' ? [] : ['thread/read']);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
  });
}

for (const initialStatus of ['notLoaded', 'systemError']) test(`cold failed recovery dispatches its preserved authorized successor exactly once (${initialStatus})`, async t => {
  const f = fixture(t);
  f.runtime.authorized = () => true;
  f.users.codexExecutions.begin(f.key, 'original-command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'original-command', 'synthetic-connection', 'turn', () => {});
  f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'failed');
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
  const queued = await f.codex.send(f.key, 'Preserved authorized successor');
  const rolloutPath = join(f.dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');
  let loaded = false, starts = 0;
  f.runtime.request = async (method: string, params: any) => {
    if (method === 'thread/goal/get') return { threadId: 'synthetic', goal: null };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (method === 'thread/resume') {
      assert.equal(params.excludeTurns, initialStatus === 'notLoaded' ? true : undefined);
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
      loaded = true;
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [] } };
    }
    if (method === 'turn/start') {
      starts++;
      assert.equal(f.users.turns.head('codex', f.key)?.id, queued.runId);
      assert.equal(params.clientUserMessageId, queued.runId);
      return { turn: { id: 'authorized-successor' } };
    }
    assert.equal(method, 'thread/read');
    return { thread: { id: 'synthetic', path: rolloutPath, status: { type: loaded ? 'idle' : initialStatus }, canAcceptDirectInput: loaded, turns: [
      { id: 'turn', status: 'failed', items: [{ id: 'notice', type: 'agentMessage', phase: 'commentary', text: 'Preserved progress' }] },
    ] } };
  };
  await f.runtime.turnWorker.options.reconcile(f.key);
  await f.runtime.drainQueuedTurn(f.key);
  assert.equal(starts, 1);
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
  assert.equal(f.users.codexExecutions.get(f.key)?.commandId, queued.runId);
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'authorized-successor');
});

for (const boundary of ['safe', 'complete-goal', 'goal', 'changed', 'authorization'] as const) {
  test(`authorized continuation loads a cold failed history without dispatch (${boundary})`, async t => {
    const f = fixture(t), calls: string[] = [];
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
    f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'failed');
    f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
    const rolloutPath = join(f.dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, '');
    let loaded = false, authorized = true;
    f.runtime.request = async (method: string) => {
      calls.push(method);
      if (method === 'thread/goal/get') return { threadId: 'synthetic',
        goal: boundary === 'goal' ? {} : boundary === 'complete-goal' ? completedGoal : null };
      if (method === 'thread/resume') { loaded = true; if (boundary === 'authorization') authorized = false; return {}; }
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', path: rolloutPath, status: { type: loaded ? 'idle' : 'notLoaded' }, canAcceptDirectInput: loaded, turns: [
        { id: loaded && boundary === 'changed' ? 'different' : 'turn', status: 'failed', items: [] },
      ] } };
    };
    const action = () => f.runtime.loadFailedContinuation(f.key, () => { if (!authorized) throw new Error('Authorization changed'); });
    if (boundary === 'changed' || boundary === 'authorization') await assert.rejects(action());
    else await action();
    assert.equal(calls.includes('thread/resume'), boundary !== 'goal');
    assert.equal(calls.includes('turn/start'), false);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
  });
}

for (const boundary of ['safe', 'goal', 'background', 'identity', 'unsubscribe', 'changed', 'projection', 'path', 'history', 'after-goal', 'after-active', 'read-only'] as const) {
  test(`failed network turn reloads only a quiescent same-thread snapshot (${boundary})`, async t => {
    const f = fixture(t), calls: string[] = [];
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
    f.runtime.loadedThreadIds.add('synthetic');
    const rolloutPath = join(f.dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, '');
    let reloaded = false;
    f.runtime.request = async (method: string, params: any) => {
      calls.push(method);
      assert.equal(params.threadId, 'synthetic');
      if (method === 'thread/goal/get') return { threadId: 'synthetic', goal: boundary === 'goal' || boundary === 'after-goal' && reloaded ? {} : null };
      if (method === 'thread/backgroundTerminals/list') return { data: boundary === 'background' ? [{}] : [] };
      if (method === 'thread/unsubscribe') {
        if (boundary === 'changed') f.runtime.connectionId = 'replacement-connection';
        if (boundary === 'projection') f.runtime.touchProjection(f.key);
        return { status: boundary === 'unsubscribe' ? 'notLoaded' : 'unsubscribed' };
      }
      if (method === 'thread/resume') { reloaded = true; return {}; }
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', path: boundary === 'path' ? '' : rolloutPath,
        status: { type: reloaded ? boundary === 'after-active' ? 'active' : 'idle' : 'systemError' }, turns: [
        { id: boundary === 'identity' ? 'different' : 'turn', status: 'failed', items: [
          { id: 'notice', type: 'agentMessage', phase: 'commentary', text: boundary === 'history' && reloaded ? 'Changed progress' : 'Preserved progress' },
        ] },
      ] } };
    };
    if (boundary === 'read-only') {
      f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'failed');
      await assert.rejects(f.codex.refreshSession(f.key, { readOnly: true }), /unavailable/);
    } else {
      f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'failed' } });
      await f.runtime.completingTurns.get(f.key);
    }
    assert.equal(f.codex.isSessionHistoryReady(f.key), boundary === 'safe');
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
    assert.equal(calls.includes('turn/start'), false);
    assert.equal(calls.filter(method => method === 'thread/unsubscribe').length, ['safe', 'unsubscribe', 'changed', 'projection', 'history', 'after-goal', 'after-active'].includes(boundary) ? 1 : 0);
    assert.equal(calls.filter(method => method === 'thread/resume').length, ['safe', 'history', 'after-goal', 'after-active'].includes(boundary) ? 1 : 0);
    if (boundary === 'projection') assert.equal(f.runtime.loadedThreadIds.has('synthetic'), false);
    if (boundary === 'safe') {
      assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
      assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Preserved progress'));
    }
  });
}
for (const outcome of outcomes) for (const managed of [false, true]) {
  test(`final ${outcome} retries a transient native read failure (${managed ? 'managed' : 'external'})`, async t => {
    const f = fixture(t);
    if (managed) {
      f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
      f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
    }
    let reads = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'final synchronization must not resend the turn');
      if (++reads === 1) throw new Error('private-native-read-error');
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: outcome, items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered final response' }] },
      ] } };
    };
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
    await f.runtime.completingTurns.get(f.key);
    assert.equal(reads, 2);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, outcome);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.equal(f.users.codexExecutions.canStart(f.key), true);
    assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Recovered final response'));
  });
}

for (const outcome of outcomes) test(`persistent final ${outcome} native read failure stays fenced and hides private details`, async t => {
  const f = fixture(t);
  f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  let reads = 0;
  f.runtime.request = async (method: string) => {
    assert.equal(method, 'thread/read'); reads++;
    throw new Error('private-native-read-error');
  };
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
  const queued = await f.codex.send(f.key, 'Preserve successor');
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 5);
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, outcome);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.equal(f.users.turns.head('codex', f.key)?.id, queued.runId);
  assert.equal(f.users.turns.head('codex', f.key)?.state, 'queued');
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
  assert.ok(!JSON.stringify(f.store.getSession(f.key)).includes('private-native-read-error'));
  assert.ok(!JSON.stringify(logs).includes('private-native-read-error'));
  assert.match(f.store.getSession(f.key)?.runtime?.reason ?? '', new RegExp(`Codex ${outcome},`));
  assert.ok(logs.some(args => args[0] === '[codex-final-history-failed]' && JSON.stringify(args).includes('native-read')));
  const failures = logs.filter(args => args[0] === '[codex-final-history-failed]');
  assert.doesNotMatch(JSON.stringify(failures), /synthetic|private-native/);
  assert.match((failures[0]![1] as { turn: string }).turn, /^[a-f0-9]{16}$/);
});

test('final native read timeout consumes a shared budget instead of five full request timeouts', async t => {
  const f = fixture(t);
  f.runtime.options.requestTimeoutMs = 10;
  let reads = 0;
  f.runtime.request = async (method: string, _params: unknown, timeoutMs: number) => {
    assert.equal(method, 'thread/read'); reads++;
    assert.ok(timeoutMs > 0 && timeoutMs <= 10);
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('private-timeout-details');
  };
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 1);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.ok(!JSON.stringify(f.store.getSession(f.key)).includes('private-timeout-details'));
});

for (const change of ['connection', 'command'] as const) test(`transient final read failure cannot overwrite a newer ${change}`, async t => {
  const f = fixture(t);
  f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  let reads = 0;
  f.runtime.request = async (method: string) => {
    assert.equal(method, 'thread/read'); reads++;
    if (change === 'connection') f.runtime.setConnection('replacement');
    else {
      f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'current');
      f.users.codexExecutions.begin(f.key, 'successor', 'synthetic-connection');
      f.users.codexExecutions.acknowledge(f.key, 'successor', 'synthetic-connection', 'successor-turn', () => {});
    }
    throw new Error('private-obsolete-read');
  };
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 1);
  const execution = f.users.codexExecutions.get(f.key)!;
  assert.equal(execution.phase, change === 'command' ? 'running' : 'completed');
  assert.equal(execution.sync, change === 'command' ? 'current' : 'syncing');
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
});

test('refresh diagnostics distinguish native RPC rejection from snapshot validation without exposing the error', async t => {
  const f = fixture(t);
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  f.runtime.request = async () => { throw new Error('private-native-transcript'); };
  await assert.rejects(f.codex.refreshSession(f.key));
  assert.ok(logs.some(args => args[0] === '[codex-history-refresh-failed]' && args.some(arg =>
    typeof arg === 'object' && arg !== null && (arg as { stage?: string }).stage === 'native-read')));
  assert.ok(!JSON.stringify(logs).includes('private-native-transcript'));
  assert.doesNotMatch(JSON.stringify(logs.filter(args => args[0] === '[codex-history-refresh-failed]')), /synthetic/);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
});

test('broken history error sink does not invalidate the original execution or release its successor', async t => {
  const f = fixture(t);
  f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  f.users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: f.key, createdAt: 1,
    payload: { text: 'Preserved successor', images: [] } });
  const queued = f.users.turns.list('codex', f.key);
  let reads = 0, errors = 0;
  t.mock.method(console, 'error', () => { errors++; throw Error('private-sink-failure'); });
  f.runtime.request = async () => { reads++; throw Error('private-native-failure'); };
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 5); assert.equal(errors, 1);
  assert.equal(f.runtime.executionUnavailable, false);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
  assert.equal(f.users.codexExecutions.canStart(f.key), false);
  assert.deepEqual(f.users.turns.list('codex', f.key), queued);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.equal(f.runtime.completingTurns.size, 0);
});

test('broken refresh error sink preserves native refusal, cooldown and a later read-only recovery', async t => {
  const f = fixture(t);
  let errors = 0, reads = 0;
  t.mock.method(console, 'error', () => { errors++; throw Error('private-sink-failure'); });
  f.runtime.request = async () => { reads++; throw Error('private-native-failure'); };
  await assert.rejects(f.codex.refreshSession(f.key), error => error instanceof Error
    && !error.message.includes('private-sink-failure'));
  assert.equal(reads, 1); assert.equal(errors, 1);
  assert.equal(f.runtime.executionUnavailable, false);
  assert.equal(f.runtime.threadRefreshInflight.size, 0);
  assert.equal(f.runtime.threadRefreshResult.get(f.key)?.available, false);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.ok(f.store.getMessages(f.key).some(message => message.id === 'known'));
  f.runtime.request = async (method: string) => {
    reads++;
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'Recovery only synchronizes history; never resends a turn');
    return { thread: { id: 'synthetic', status: { type: 'notLoaded' }, turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered history' }] },
    ] } };
  };
  await f.codex.refreshSession(f.key, { fresh: true });
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Recovered history'));
  assert.equal(errors, 1);
});

for (const fault of ['system-error', 'schema', 'identity', 'item-view'] as const) {
  test(`final and refresh diagnostics distinguish ${fault} without exposing native history`, async t => {
    const f = fixture(t);
    const logs: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
    const thread = { id: 'synthetic', status: { type: fault === 'system-error' ? 'systemError' : 'idle' }, turns: [
      { id: 'turn', status: 'failed', itemsView: fault === 'item-view' ? 'partial' : 'full', items: [
        { id: fault === 'identity' ? '' : 'reply', type: 'agentMessage', text: 'private-native-transcript' },
      ] },
    ] };
    f.runtime.request = async () => ({ thread: fault === 'schema' ? { ...thread, id: 'foreign' } : thread });
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'failed' } });
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    await assert.rejects(f.codex.refreshSession(f.key), /unavailable|Invalid/);
    for (const event of ['[codex-final-history-failed]', '[codex-history-refresh-failed]']) {
      assert.ok(logs.some(args => args[0] === event && args.some(arg =>
        typeof arg === 'object' && arg !== null && (arg as { fault?: string }).fault === fault)));
    }
    assert.ok(!JSON.stringify(logs).includes('private-native-transcript'));
    assert.ok(!JSON.stringify(f.store.getMessages(f.key)).includes('private-native-transcript'));
  });
}

for (const outcome of outcomes) for (const mismatch of [undefined, 'text', 'phase', 'turn', 'duplicate', 'reserved', 'unsent', 'media'] as const) {
  test(`renumbered ${outcome} assistant history ${mismatch ?? 'matches exact sent content'}`, async context => {
    const setup = fixture(context);
    setup.users.codexExecutions.begin(setup.key, 'command', 'synthetic-connection');
    setup.users.codexExecutions.acknowledge(setup.key, 'command', 'synthetic-connection', 'turn', () => {});
    const observed = { id: 'encrypted-live-id', sessionKey: setup.key, turnId: 'turn', role: 'assistant' as const,
      phase: 'commentary' as const, status: 'sent' as const, text: 'Exact response', createdAt: 2 };
    setup.store.addMessage({ ...observed,
      ...(mismatch === 'unsent' ? { status: 'sending' as const } : {}),
      ...(mismatch === 'media' ? { media: [{ type: 'image' as const, name: 'image.png', url: 'https://example.invalid/image.png' }] } : {}) });
    if (mismatch === 'duplicate' || mismatch === 'reserved') {
      setup.store.addMessage({ ...observed, id: mismatch === 'reserved' ? 'item-6' : 'another-encrypted-id' });
    }
    const item = { id: 'item-6', type: 'agentMessage', text: mismatch === 'text' ? 'Exact  response' : observed.text,
      phase: mismatch === 'phase' ? 'final_answer' : 'commentary' };
    setup.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] }
      : { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        ...(mismatch === 'turn' ? [{ id: 'previous', status: 'completed', items: [item] }] : []),
        { id: 'turn', status: outcome, items: mismatch === 'turn' ? [] : [item] },
      ] } };
    setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
    await setup.runtime.completingTurns.get(setup.key);
    assert.equal(setup.store.getSession(setup.key)?.runtime?.sync, mismatch ? 'error' : 'current');
    assert.equal(setup.users.codexExecutions.canStart(setup.key), !mismatch);
    assert.equal(setup.codex.isSessionHistoryReady(setup.key), !mismatch);
    if (mismatch) assert.ok(setup.store.getMessages(setup.key).some(message => message.id === observed.id));
    else {
      assert.equal(setup.store.getMessages(setup.key).filter(message => message.role === 'assistant' && message.status === 'sent').length, 1);
      assert.equal(setup.store.getMessages(setup.key).some(message => message.id === observed.id), false);
    }
  });
}

for (const managed of [false, true]) test(`native retry notice is fenced and nonterminal (${managed ? 'managed' : 'external'})`, async t => {
  const { runtime, store, users, key } = fixture(t);
  store.upsertSession({ ...store.getSession(key)!, runtime: { turnId: 'turn', phase: 'running', threadActivity: 'running',
    connection: 'connected', sync: 'current', lastEventAt: 1 } });
  if (managed) {
    users.codexExecutions.begin(key, 'command', 'synthetic-connection');
    users.codexExecutions.acknowledge(key, 'command', 'synthetic-connection', 'turn', () => {});
  } else runtime.activeTurnIds.set(key, 'turn');
  const execution = users.codexExecutions.get(key);
  for (const turnId of [undefined, 'previous']) {
    runtime.handleNotification('error', { threadId: 'synthetic', turnId, willRetry: true, error: { message: 'private-error-details' } });
    assert.equal(store.getSession(key)?.runtime?.reason, undefined);
  }
  runtime.handleNotification('error', { threadId: 'synthetic', turnId: 'turn', willRetry: true, error: { message: 'private-error-details' } });
  assert.equal(store.getSession(key)?.runtime?.phase, 'running');
  assert.equal(store.getSession(key)?.hasActiveRun, true);
  assert.match(store.getSession(key)!.runtime!.reason!, /Codex is retrying/);
  assert.ok(!JSON.stringify(store.getSession(key)).includes('private-error-details'));
  assert.deepEqual(users.codexExecutions.get(key), execution);
  runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', status: { type: 'active', activeFlags: [] }, turns: [{ id: 'turn', status: 'inProgress', items: [] }] } });
  await runtime.refreshSession(key);
  assert.match(store.getSession(key)!.runtime!.reason!, /Codex is retrying/);
  runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'reply', delta: 'Recovered' });
  assert.equal(store.getSession(key)?.runtime?.reason, undefined);
  runtime.handleNotification('error', { threadId: 'synthetic', turnId: 'turn', willRetry: false });
  assert.match(store.getSession(key)!.runtime!.reason!, /waiting for final run status/);
  assert.deepEqual(users.codexExecutions.get(key), execution);
  if (managed) users.codexExecutions.observe(key, 'synthetic-connection', 'turn', 'completed');
  store.upsertSession({ ...store.getSession(key)!, runtime: { turnId: 'turn', phase: 'completed', threadActivity: 'idle', connection: 'connected', sync: 'current', lastEventAt: 2 } });
  runtime.handleNotification('error', { threadId: 'synthetic', turnId: 'turn', willRetry: true });
  assert.equal(store.getSession(key)?.runtime?.phase, 'completed');
  assert.equal(store.getSession(key)?.runtime?.reason, undefined);
});
for (const boundary of ['loading', 'recovery']) for (const managed of [false, true]) for (const fault of ['systemError', 'read-failure', 'pending-read', 'invalidated-read'] as const) {
  test(`worker retains ${managed ? 'managed' : 'external'} successor when ${fault} invalidates history during ${boundary}`, async t => {
    const f = fixture(t);
    const history = { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
      { id: 'reply', type: 'agentMessage', text: 'Confirmed predecessor response' },
    ] }] } };
    let releasePreparation!: () => void, prepared!: () => void, releaseRead!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    const entered = new Promise<void>(resolve => { prepared = resolve; });
    let enteredRead!: () => void;
    const reading = new Promise<void>(resolve => { enteredRead = resolve; });
    const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let broken = false, starts = 0;
    if (boundary === 'recovery') {
      const recover = f.runtime.recoverPayloadTooLargeThread.bind(f.runtime);
      f.runtime.recoverPayloadTooLargeThread = async (...args: unknown[]) => {
        const context = await recover(...args);
        prepared(); await preparation;
        return context;
      };
    }
    f.runtime.request = async (method: string) => {
      if (method === 'thread/resume') { if (boundary === 'loading') { prepared(); await preparation; } return {}; }
      if (method === 'turn/start') { starts++; return { turn: { id: 'successor' } }; }
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      if (broken) {
        enteredRead();
        if (fault === 'read-failure') throw new Error('Synthetic read failure');
        if (fault === 'systemError') return { thread: { ...history.thread, status: { type: 'systemError' } } };
        if (fault === 'invalidated-read') f.runtime.touchProjection(f.key);
        if (fault === 'pending-read') await heldRead;
      }
      return history;
    };
    if (managed) {
      f.users.codexExecutions.begin(f.key, 'predecessor', 'synthetic-connection');
      f.users.codexExecutions.acknowledge(f.key, 'predecessor', 'synthetic-connection', 'turn', () => {});
    }
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
    await f.runtime.completingTurns.get(f.key);
    const queued = await f.codex.send(f.key, 'Keep this exact successor');
    const pass = f.runtime.turnWorker.pass();
    let refresh: Promise<void> | undefined;
    try {
      await Promise.race([entered, pass.then(() => assert.fail('worker returned before preparation boundary'))]);
      const predecessor = f.users.codexExecutions.get(f.key);
      broken = true;
      refresh = fault === 'pending-read' ? f.codex.refreshSession(f.key)
        : assert.rejects(f.codex.refreshSession(f.key), /unavailable|Synthetic read failure|obsolete/);
      await reading;
      if (fault !== 'pending-read') await refresh;
      assert.equal(f.codex.isSessionHistoryReady(f.key), false);
      releasePreparation(); await pass;
      assert.equal(starts, 0, 'an earlier worker read cannot authorize sending after readiness is lost');
      assert.equal(f.users.turns.head('codex', f.key)?.id, queued.runId);
      assert.equal(f.users.turns.head('codex', f.key)?.state, 'queued');
      assert.deepEqual(f.users.codexExecutions.get(f.key), predecessor, 'readiness loss must not replace or rewrite a durable predecessor');
      assert.ok(f.store.getMessages(f.key).some(message => message.id === queued.runId && message.text === 'Keep this exact successor' && message.status === 'queued'));
      releaseRead(); await refresh; broken = false;
      await f.runtime.turnWorker.pass();
      assert.equal(starts, 1, 'the existing worker recovers and sends once after a fresh valid read');
      assert.equal(f.users.codexExecutions.get(f.key)?.commandId, queued.runId);
      assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'successor');
    } finally { releasePreparation(); releaseRead(); await Promise.allSettled([pass, refresh]); }
  });
}

test('ordinary notLoaded completed history remains usable without starting a native agent', async t => {
  const f = fixture(t);
  const { runtime: _runtime, ...cold } = f.store.getSession(f.key)!;
  f.store.upsertSession(cold);
  f.runtime.request = async (method: string) => {
    assert.equal(method, 'thread/read');
    return { thread: { id: 'synthetic', status: { type: 'notLoaded' }, turns: [{ id: 'turn', status: 'completed', items: [
      { id: 'reply', type: 'agentMessage', text: 'Unloaded completed history' },
    ] }] } };
  };
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'completed');
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Unloaded completed history'));
});

for (const outcome of outcomes) {
  test(`thread systemError preserves confirmed external ${outcome}, invalidates warm history and retains successor`, async t => {
    const f = fixture(t);
    const history = (type: string) => ({ thread: { id: 'synthetic', status: { type }, turns: [{ id: 'turn', status: outcome, items: [
      { id: 'reply', type: 'agentMessage', text: 'Confirmed final response' },
    ] }] } });
    const notify = () => f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
    f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : history('idle'); notify();
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    const queued = await f.codex.send(f.key, 'Preserve successor during thread outage');
    const messages = f.store.getMessages(f.key);
    f.runtime.handleNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'systemError' } });
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, outcome);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.deepEqual(f.store.getMessages(f.key), messages);
    f.runtime.request = async () => history('systemError');
    await assert.rejects(f.codex.refreshSession(f.key), /unavailable/);
    f.runtime.ensureThreadLoaded = async () => assert.fail('thread outage cannot prepare successor');
    await f.runtime.drainQueuedTurn(f.key);
    assert.equal(f.users.turns.list('codex', f.key)[0]?.id, queued.runId);
    assert.equal(f.users.turns.list('codex', f.key)[0]?.state, 'queued');
    f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : history('idle'); notify();
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, outcome);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    let starts = 0;
    f.runtime.ensureThreadLoaded = async () => {};
    f.runtime.request = async (method: string) => { assert.equal(method, 'turn/start'); starts++; return { turn: { id: 'next' } }; };
    await f.runtime.drainQueuedTurn(f.key);
    assert.equal(starts, 1);
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, queued.runId);
  });

  for (const path of ['ordinary', 'final']) test(`${path} external ${outcome} history rejects systemError without projecting and recovers`, async t => {
    const f = fixture(t);
    let type = 'systemError', reads = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      reads++;
      return { thread: { id: 'synthetic', status: { type }, turns: [{ id: 'turn', status: outcome, items: [
        { id: 'reply', type: 'agentMessage', text: 'Unverified native response' },
      ] }] } };
    };
    const notify = () => f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
    if (path === 'ordinary') await assert.rejects(f.codex.refreshSession(f.key), /unavailable/);
    else { notify(); await f.runtime.completingTurns.get(f.key); }
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(reads, path === 'ordinary' ? 1 : 5);
    assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Known projection'));
    assert.ok(!f.store.getMessages(f.key).some(message => message.text === 'Unverified native response'));
    type = 'idle'; notify(); await f.runtime.completingTurns.get(f.key);
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, outcome);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  });
}

test('a distinct external turn can complete after predecessor final synchronization failed', async t => {
  const f = fixture(t);
  f.runtime.request = async () => { throw new Error('Synthetic predecessor history outage'); };
  failTurn(f);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'new' } });
  assert.equal(f.store.getSession(f.key)?.runtime?.turnId, 'new');
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'running');
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [{ id: 'new', status: 'completed', items: [
    { id: 'new-reply', type: 'agentMessage', text: 'New external response' },
  ] }] } });
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'new', status: 'completed' } });
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.turnId, 'new');
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'completed');
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'New external response'));
});

for (const expected of outcomes) for (const observed of outcomes) {
  if (expected === observed) continue;
  test(`external ${expected} sync error cannot be reinterpreted by contradictory ${observed} notification`, async t => {
    const f = fixture(t);
    const notify = (status: string) => f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status } });
    f.runtime.request = async () => { throw new Error('Synthetic final history unavailable'); };
    notify(expected);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, expected);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
    const queued = await f.codex.send(f.key, 'Preserve successor');
    let reads = 0, cleanups = 0;
    const read = (status: string) => ({ thread: { id: 'synthetic', turns: [{ id: 'turn', status, items: [] }] } });
    f.runtime.request = async () => { reads++; return read(observed); };
    f.runtime.cleanupSecretFiles = async () => { cleanups++; };
    const admitted = f.store.getSession(f.key), admittedMessages = f.store.getMessages(f.key), admittedEvents = f.store.getEventsSince().length;
    notify(observed);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(reads, 0, 'conflicting terminal notification cannot replace the original expected outcome');
    assert.equal(cleanups, 0);
    assert.deepEqual(f.store.getSession(f.key), admitted);
    assert.deepEqual(f.store.getMessages(f.key), admittedMessages);
    assert.equal(f.store.getEventsSince().length, admittedEvents);
    assert.equal(f.runtime.completedTurnIds.get(f.key), 'turn');
    assert.equal(f.users.turns.list('codex', f.key)[0]?.id, queued.runId);
    assert.equal(f.users.turns.list('codex', f.key)[0]?.state, 'queued');
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); reads++; return read(expected);
    };
    notify(expected);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(reads, 1, 'matching retry still recovers final history');
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, expected);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
    assert.equal(f.users.turns.list('codex', f.key)[0]?.id, queued.runId);
  });
}

for (const expected of outcomes) for (const observed of outcomes) {
  if (expected === observed) continue;
  test(`external turn ${expected} rejects contradictory ${observed} history and recovers only from matching history`, async t => {
    const f = fixture(t);
    let status: string = observed, reads = 0, projections = 0;
    f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); reads++;
      return { thread: { id: 'synthetic', turns: [{ id: 'turn', status,
        items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered reply' }] }] } };
    };
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100, 'turn', expected);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, expected);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
    assert.equal(projections, 0);
    assert.equal(reads, 5, 'retain the existing bounded retry budget');
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
    status = expected;
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100, 'turn', expected);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, expected);
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.equal(projections, 1);
    assert.equal(reads, 6);
  });
}

for (const expected of ['completed', 'interrupted'] as const) {
  test(`external ${expected} notification cannot certify failed history and same-turn retry recovers`, async t => {
    const f = fixture(t);
    let status: string = 'failed';
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', turns: [{ id: 'turn', status, items: [] }] } };
    };
    const notify = (method: string, turn: object) => f.runtime.handleNotification(method, { threadId: 'synthetic', turn });
    notify('turn/started', { id: 'turn' });
    notify('turn/completed', { id: 'turn', status: expected });
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, expected);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
    status = expected;
    notify('turn/completed', { id: 'turn', status: expected });
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, expected);
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  });
}

function failedHistory(items: object[] = [{ id: 'reply', type: 'agentMessage', text: 'Final explanation' }]) {
  return { thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'failed', error: { message: 'Synthetic failure' }, items }] } };
}
function failTurn(f: ReturnType<typeof fixture>) {
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: {
    id: 'turn', status: 'failed', error: { message: 'Synthetic failure' },
  } });
}

for (const status of outcomes) test(`external valid ${status} notification retains top-level turnId compatibility`, async t => {
  const f = fixture(t);
  f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turnId: 'turn' });
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'running');
  assert.equal(f.runtime.activeTurnIds.get(f.key), 'turn');
  let reads = 0;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read'); reads++;
    return { thread: { id: 'synthetic', turns: [{ id: 'turn', status, items: [{ id: 'reply', type: 'agentMessage', text: 'Verified final response' }] }] } };
  };
  f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turnId: 'turn', turn: { status } });
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 1);
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, status);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Verified final response'));
});

for (const method of ['turn/started', 'turn/completed']) for (const id of [undefined, null, '', ' ', 42]) {
  test(`external ${method} rejects missing or invalid identity ${JSON.stringify(id)}`, async t => {
    const f = fixture(t);
    f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'turn' } });
    const queued = await f.codex.send(f.key, 'Keep queued message');
    const before = f.store.getSession(f.key), messages = f.store.getMessages(f.key), events = f.store.getEventsSince().length;
    let reads = 0, cleanups = 0;
    f.runtime.request = async () => { reads++; return failedHistory(); };
    f.runtime.cleanupSecretFiles = async () => { cleanups++; };
    f.runtime.handleNotification(method, { threadId: 'synthetic', turn: { id, status: 'failed' } });
    await f.runtime.completingTurns.get(f.key);
    assert.equal(cleanups, 0, 'unidentified completion cannot clean resources belonging to a running turn');
    assert.equal(reads, 0, 'missing identity is not authority to reconcile an arbitrary final turn');
    assert.deepEqual(f.store.getSession(f.key), before);
    assert.deepEqual(f.store.getMessages(f.key), messages);
    assert.equal(f.store.getEventsSince().length, events);
    assert.equal(f.runtime.activeTurnIds.get(f.key), 'turn');
    assert.equal(f.runtime.completedTurnIds.has(f.key), false);
    assert.equal(f.users.turns.list('codex', f.key)[0]?.id, queued.runId);
    assert.equal(f.users.turns.list('codex', f.key)[0]?.state, 'queued');
  });
}

for (const status of [undefined, null, '', 'inProgress', 'running', 'unknown', 42, { type: 'completed' }]) {
  test(`external completion rejects invalid terminal status ${JSON.stringify(status)}`, async t => {
    const f = fixture(t);
    f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'turn' } });
    const before = f.store.getSession(f.key), messages = f.store.getMessages(f.key), events = f.store.getEventsSince().length;
    let reads = 0, cleanups = 0;
    f.runtime.request = async () => { reads++; return { thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'completed', items: [] }] } }; };
    f.runtime.cleanupSecretFiles = async () => { cleanups++; };
    f.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status } });
    await f.runtime.completingTurns.get(f.key);
    assert.equal(cleanups, 0);
    assert.equal(reads, 0);
    assert.deepEqual(f.store.getSession(f.key), before);
    assert.deepEqual(f.store.getMessages(f.key), messages);
    assert.equal(f.store.getEventsSince().length, events);
    assert.equal(f.runtime.activeTurnIds.get(f.key), 'turn');
    assert.equal(f.runtime.completedTurnIds.has(f.key), false);
  });
}

test('external failure invalidates warm history and keeps successor queued throughout final read', async t => {
  const f = fixture(t);
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [] } });
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  f.runtime.handleNotification('turn/started', { threadId: 'synthetic', turn: { id: 'turn' } });
  const queued = await f.codex.send(f.key, 'Preserve successor');
  let finish!: (value: unknown) => void, entered!: () => void, reads = 0, preparations = 0;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  f.runtime.ensureThreadLoaded = async () => { preparations++; };
  f.runtime.request = async (method: string) => { if (method === 'thread/backgroundTerminals/list') return { data: [] }; assert.equal(method, 'thread/read'); reads++; entered(); return held; };
  try {
    failTurn(f);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'failed');
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'syncing');
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    await reading;
    await f.runtime.drainQueuedTurn(f.key);
    assert.equal(preparations, 0, 'successor must not even prepare while final history is pending');
    assert.equal(f.users.turns.list('codex', f.key)[0]?.id, queued.runId);
    assert.equal(f.users.turns.list('codex', f.key)[0]?.state, 'queued');
    assert.equal(reads, 1);
  } finally { finish(failedHistory()); }
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.equal(f.users.turns.list('codex', f.key)[0]?.state, 'queued');
  let starts = 0;
  f.runtime.request = async (method: string) => { assert.equal(method, 'turn/start'); starts++; return { turn: { id: 'next' } }; };
  await f.runtime.drainQueuedTurn(f.key);
  assert.equal(starts, 1);
  assert.equal(preparations, 1);
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
  assert.equal(f.users.codexExecutions.get(f.key)?.commandId, queued.runId);
});

test('external failure loads final explanation and retains one stable failure message', async t => {
  const f = fixture(t);
  let reads = 0;
  f.runtime.request = async (method: string) => { if (method === 'thread/backgroundTerminals/list') return { data: [] }; assert.equal(method, 'thread/read'); reads++; return failedHistory(); };
  failTurn(f);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 1);
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'failed');
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Final explanation'));
  const failures = f.store.getMessages(f.key).filter(message => message.status === 'failed');
  assert.equal(failures.length, 1);
  failTurn(f);
  assert.equal(reads, 1, 'duplicate synchronized failure does not reread');
  assert.equal(f.store.getMessages(f.key).filter(message => message.status === 'failed')[0]?.id, failures[0]?.id);
});

test('successor rechecks external failed synchronization after thread preparation and retains queue identity', async t => {
  const f = fixture(t);
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : failedHistory();
  failTurn(f);
  await f.runtime.completingTurns.get(f.key);
  const queued = await f.codex.send(f.key, 'Preserve prepared successor');
  f.runtime.ensureThreadLoaded = async () => {
    const current = f.store.getSession(f.key)!;
    f.store.upsertSession({ ...current, runtime: { ...current.runtime!, sync: 'syncing' } });
  };
  f.runtime.request = async () => assert.fail('pending final synchronization cannot start a successor');
  await f.runtime.drainQueuedTurn(f.key);
  const retained = f.users.turns.list('codex', f.key);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.id, queued.runId);
  assert.equal(retained[0]?.state, 'queued');
  assert.equal(f.users.codexExecutions.get(f.key), undefined);
  assert.ok(f.store.getMessages(f.key).some(message => message.id === queued.runId && message.status === 'queued'));
});

test('external failed final read exposes sync error, preserves messages and same-turn retry recovers', async t => {
  const f = fixture(t);
  f.runtime.request = async () => { throw new Error('Synthetic history outage'); };
  failTurn(f);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'failed');
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
  const failureId = f.store.getMessages(f.key).find(message => message.status === 'failed')?.id;
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : failedHistory();
  failTurn(f);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getMessages(f.key).find(message => message.status === 'failed')?.id, failureId);
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Final explanation'));
});

for (const invalid of ['outcome', 'turn'] as const) test(`external failed notification rejects mismatched ${invalid} final history`, async t => {
  const f = fixture(t), result = failedHistory();
  if (invalid === 'outcome') result.thread.turns[0]!.status = 'completed';
  else result.thread.turns[0]!.id = 'foreign';
  let reads = 0;
  f.runtime.request = async () => { reads++; return result; };
  failTurn(f);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(reads, 5);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
});

test('external failure stops live tool indicator but incomplete native tool still blocks final sync', async t => {
  const f = fixture(t);
  const item = { id: 'tool', type: 'commandExecution', command: 'synthetic', status: 'inProgress' };
  f.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'turn', item });
  f.runtime.request = async () => failedHistory([item]);
  failTurn(f);
  assert.equal(f.store.getMessages(f.key).find(message => message.role === 'tool')?.status, 'failed');
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.equal(f.store.getMessages(f.key).find(message => message.role === 'tool')?.status, 'failed');
});

for (const unknownDispatch of [false, true]) {
  test(`owned-journal loadFailedContinuation records durable resume receipt and invalidates on unknown dispatch (${unknownDispatch})`, async t => {
    const f = fixture(t);
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
    f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'failed');
    f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
    const rolloutPath = join(f.dir, 'rollout-journal.jsonl');
    writeFileSync(rolloutPath, '');
    const resumes = f.users.codexExecutions.nativeResumes;
    const outcomes: string[] = [];
    let preparedContinuation: NativeResumeInput['continuation'] = null;
    f.runtime.options.nativeJournal = {
      readHistory: async (sessionKey: string) => ({
        execution: f.users.codexExecutions.get(sessionKey),
        deleted: f.users.codexExecutions.isDeletedTerminal(sessionKey),
        outcomeUnknown: resumes.pending(sessionKey),
      }),
      prepareResume: async (input: NativeResumeInput) => {
        preparedContinuation = input.continuation;
        return resumes.prepare(input, () => true);
      },
      beginResume: async (receipt: NativeResumeReceipt) => resumes.begin(receipt, () => true),
      finishResume: async (receipt: NativeResumeReceipt, outcome: 'acknowledged' | 'not_dispatched') => {
        outcomes.push(outcome);
        return resumes.finish(receipt, outcome);
      },
    };
    let loaded = false;
    f.runtime.request = async (method: string, params: any, _timeout?: number, _goal?: unknown, beforeDispatch?: () => void) => {
      if (method === 'thread/goal/get') return { threadId: 'synthetic', goal: null };
      if (method === 'thread/resume') {
        assert.equal(params.excludeTurns, true);
        beforeDispatch?.();
        if (unknownDispatch) throw new Error('synthetic lost resume ack');
        loaded = true;
        return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [] } };
      }
      assert.equal(method, 'thread/read');
      return {
        thread: {
          id: 'synthetic',
          path: rolloutPath,
          status: { type: loaded ? 'idle' : 'notLoaded' },
          canAcceptDirectInput: loaded,
          turns: [{ id: 'turn', status: 'failed', items: [] }],
        },
      };
    };
    try {
      const continuation = { headId: 'queued-1', headVersion: '1:2' };
      const action = f.runtime.loadFailedContinuation(f.key, () => {}, continuation);
      if (unknownDispatch) {
        await assert.rejects(action, /synthetic lost resume ack/);
        assert.equal(resumes.pending(f.key), true);
        assert.equal(f.runtime.executionUnavailable, true);
        assert.deepEqual(outcomes, []);
      } else {
        await action;
        assert.deepEqual(preparedContinuation, continuation);
        assert.deepEqual(outcomes, ['acknowledged']);
        assert.equal(resumes.pending(f.key), false);
        assert.equal(f.runtime.loadedThreadIds.has('synthetic'), true);
      }
    } finally {
      f.runtime.options.nativeJournal = undefined;
    }
  });
}

test('owned-journal mode prohibits unjournaled unsubscribe/resume in reloadErroredTerminal', async t => {
  const f = failedReloadFixture(t);
  const resumes = f.users.codexExecutions.nativeResumes;
  f.runtime.options.nativeJournal = {
    readHistory: async (sessionKey: string) => ({
      execution: f.users.codexExecutions.get(sessionKey),
      deleted: f.users.codexExecutions.isDeletedTerminal(sessionKey),
      outcomeUnknown: resumes.pending(sessionKey),
    }),
    prepareResume: async (input: NativeResumeInput) => resumes.prepare(input, () => true),
    beginResume: async (receipt: NativeResumeReceipt) => resumes.begin(receipt, () => true),
    finishResume: async (receipt: NativeResumeReceipt, outcome: 'acknowledged' | 'not_dispatched') => resumes.finish(receipt, outcome),
  };
  try {
    const result = await f.reload();
    assert.equal(result.thread.status.type, 'systemError');
    assert.deepEqual(f.calls, []);
    assert.equal(f.runtime.erroredThreadReloads.has(f.key), false);
  } finally {
    f.runtime.options.nativeJournal = undefined;
  }
});
