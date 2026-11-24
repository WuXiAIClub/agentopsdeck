import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { CodexAppServer } from './app-server.js';
import { RunControlConflict } from '../commands/run-control.js';
import type { NativeResumeInput, NativeResumeReceipt } from './native-resume.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-final-log-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
    runtime: { turnId: 'turn', phase: 'completed', connection: 'connected', sync: 'syncing', lastEventAt: 1 } });
  users.codexExecutions.begin(key, 'command', 'synthetic-connection');
  users.codexExecutions.acknowledge(key, 'command', 'synthetic-connection', 'turn', () => {});
  users.codexExecutions.observe(key, 'synthetic-connection', 'turn', 'completed');
  let wakes = 0; runtime.turnWorker.wake = () => { wakes++; };
  t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  return { codex, runtime, store, users, key, wakes: () => wakes };
}

function observe(t: test.TestContext, onLog?: () => void, broken = false) {
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => {
    rows.push(JSON.parse(line)); onLog?.(); if (broken) throw Error('private-sink-error');
  }, () => 0);
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<PerformanceDiagnostics['start']>[0]) => diagnostics.start(operation));
  return { rows, diagnostics, final: () => rows.filter(row => row.operation === 'codex-final-history') };
}

function snapshot(active = false) {
  return { thread: { id: 'synthetic', status: { type: active ? 'active' : 'idle' }, canAcceptDirectInput: !active, turns: [
    { id: 'turn', status: 'completed', itemsView: 'full', items: [{ id: 'reply', type: 'agentMessage', text: 'private-response-content' }] },
    ...(active ? [{ id: 'continuation', status: 'inProgress', itemsView: 'full', items: [{ id: 'next', type: 'agentMessage', text: 'private-continuation' }] }] : []),
  ] } };
}

for (const dispatched of [false, true]) test(`native resume failure preserves the actual transport boundary (${dispatched})`, async t => {
  const f = fixture(t), fact = f.users.codexExecutions.get(f.key)!;
  const resumes = f.users.codexExecutions.nativeResumes;
  const outcomes: string[] = [];
  f.runtime.options.nativeJournal = {
    prepareResume: async (input: NativeResumeInput) => resumes.prepare(input, () => true),
    beginResume: async (receipt: NativeResumeReceipt) => resumes.begin(receipt, () => true),
    finishResume: async (receipt: NativeResumeReceipt, outcome: 'acknowledged' | 'not_dispatched') => {
      outcomes.push(outcome);
      return resumes.finish(receipt, outcome);
    },
  };
  f.runtime.request = async (_method: string, _params: unknown, _timeout: number | undefined,
    _goal: unknown, beforeDispatch: () => void) => {
    if (dispatched) beforeDispatch();
    throw new Error('synthetic transport refusal');
  };
  try {
    await assert.rejects(f.runtime.resumeRecoveredThread(fact, 'synthetic', 'a'.repeat(64), () => {}),
      /synthetic transport refusal/);
    assert.deepEqual(outcomes, dispatched ? [] : ['not_dispatched']);
    assert.equal(resumes.pending(f.key), dispatched);
    assert.equal(f.runtime.executionUnavailable, dispatched);
    assert.deepEqual(f.users.codexExecutions.get(f.key), fact);
    assert.equal(f.runtime.authorizingEffects.size, 0);
    assert.equal(f.wakes(), 0);
    if (!dispatched) assert.equal(f.store.getSessionsState().groups[0]!.sessions.length, 1);
  } finally { f.runtime.options.nativeJournal = undefined; }
});

test('native resume admission refusal does not invalidate unrelated sessions', async t => {
  const f = fixture(t), fact = f.users.codexExecutions.get(f.key)!;
  f.runtime.options.nativeJournal = { prepareResume: async () => null };
  f.runtime.request = async () => assert.fail('refused admission must not dispatch native work');
  try {
    await assert.rejects(f.runtime.resumeRecoveredThread(fact, 'synthetic', 'a'.repeat(64), () => {}),
      RunControlConflict);
    assert.equal(f.runtime.executionUnavailable, false);
    assert.equal(f.store.getSessionsState().groups[0]!.sessions.length, 1);
    assert.deepEqual(f.users.codexExecutions.get(f.key), fact);
    assert.equal(f.wakes(), 0);
  } finally { f.runtime.options.nativeJournal = undefined; }
});

for (const valid of [true, false]) test(`metadata resume ACK must match the original thread (${valid})`, async t => {
  const f = fixture(t), fact = f.users.codexExecutions.get(f.key)!;
  const resumes = f.users.codexExecutions.nativeResumes;
  f.runtime.options.nativeJournal = {
    prepareResume: async (input: NativeResumeInput) => resumes.prepare(input, () => true),
    beginResume: async (receipt: NativeResumeReceipt) => resumes.begin(receipt, () => true),
    finishResume: async (receipt: NativeResumeReceipt, outcome: 'acknowledged' | 'not_dispatched') => resumes.finish(receipt, outcome),
  };
  f.runtime.request = async (method: string, params: { excludeTurns?: boolean }, _timeout: number | undefined,
    _goal: unknown, beforeDispatch: () => void) => {
    assert.equal(method, 'thread/resume');
    assert.equal(params.excludeTurns, true);
    beforeDispatch();
    return { thread: { id: valid ? 'synthetic' : 'different-thread', status: { type: 'idle' }, turns: [] } };
  };
  try {
    const result = f.runtime.resumeRecoveredThread(fact, 'synthetic', 'a'.repeat(64), () => {}, null, undefined, true);
    if (valid) await result;
    else await assert.rejects(result, /Invalid Codex thread history/);
    assert.equal(resumes.pending(f.key), !valid);
    assert.equal(f.users.codexExecutions.canStart(f.key), false, 'an ACK alone is not fresh execution proof');
  } finally { f.runtime.options.nativeJournal = undefined; }
});

test('maintenance rejects unresolved native resume or delivery before reading native history', async t => {
  const f = fixture(t), fact = f.users.codexExecutions.get(f.key)!;
  f.runtime.options.nativeJournal = {
    readHistory: async () => ({ execution: fact, deleted: false, outcomeUnknown: true }),
  };
  f.runtime.request = async () => assert.fail('unresolved maintenance must not read or resume native');
  try {
    await assert.rejects(f.codex.recoverMaintenanceHistory(f.key, () => {}), RunControlConflict);
    assert.deepEqual(f.users.codexExecutions.get(f.key), fact);
    assert.equal(f.wakes(), 0);
    assert.equal(f.runtime.completingTurns.size, 0);
    assert.equal(f.runtime.maintenanceDrains.size, 0);
  } finally { f.runtime.options.nativeJournal = undefined; }
});

for (const { outcomeUnknown, changedFact } of [
  { outcomeUnknown: false, changedFact: false },
  { outcomeUnknown: true, changedFact: false },
  { outcomeUnknown: true, changedFact: true },
]) test(`rejected history CAS stops full rereads only for unchanged unresolved outcome (${outcomeUnknown}, changed=${changedFact})`, async t => {
  const f = fixture(t), fact = f.users.codexExecutions.get(f.key)!;
  let reads = 0, settlements = 0;
  f.runtime.options.nativeJournal = {
    readExecution: async () => structuredClone(fact),
    readHistory: async () => ({ execution: changedFact ? { ...structuredClone(fact), revision: fact.revision + 1 }
      : structuredClone(fact), deleted: false, outcomeUnknown }),
    settleHistory: async () => { settlements++; return false; },
  };
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read'); reads++; return snapshot();
  };
  try {
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
    await f.runtime.completingTurns.get(f.key);
    const expectedReads = outcomeUnknown && !changedFact ? 1 : 5;
    assert.equal(reads, expectedReads);
    assert.equal(settlements, expectedReads + 1);
    assert.deepEqual(f.users.codexExecutions.get(f.key), fact);
    assert.equal(f.wakes(), 0);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.runtime.completingTurns.size, 0);
  } finally { f.runtime.options.nativeJournal = undefined; }
});

for (const changed of ['revision', 'connection', 'command', 'local-generation'] as const)
  test(`rejected history CAS does not treat changed ${changed} as unchanged unresolved proof`, async t => {
    const f=fixture(t), fact=f.users.codexExecutions.get(f.key)!;
    let current=structuredClone(fact), reads=0, settlements=0;
    f.runtime.options.nativeJournal={
      readExecution: async () => structuredClone(current),
      readHistory: async () => ({execution:structuredClone(current),deleted:false,outcomeUnknown:true}),
      settleHistory: async () => {
        settlements++;
        if(changed==='revision') current={...current,revision:current.revision+1};
        if(changed==='connection') current={...current,connectionId:'successor-connection'};
        if(changed==='command') current={...current,commandId:'successor-command'};
        if(changed==='local-generation') f.runtime.nativeConnectionGeneration++;
        return false;
      },
    };
    f.runtime.request=async (method:string) => {
      if(method==='thread/backgroundTerminals/list') return {data:[]};
      assert.equal(method,'thread/read'); reads++; return snapshot();
    };
    try {
      f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn','completed');
      await f.runtime.completingTurns.get(f.key);
      if(changed==='revision') { assert.equal(reads,5); assert.equal(settlements,6); }
      else if(changed==='connection') { assert.ok(reads>1); }
      else { assert.equal(reads,1); assert.equal(settlements,1); }
      assert.deepEqual(f.users.codexExecutions.get(f.key),fact);
      assert.equal(f.wakes(),0); assert.equal(f.codex.isSessionHistoryReady(f.key),false);
      assert.equal(f.runtime.completingTurns.size,0);
    } finally { f.runtime.options.nativeJournal=undefined; }
  });

test('pending final native read has correlated bounded logs without releasing execution or resending', async t => {
  const f = fixture(t), o = observe(t);
  let release!: () => void, entered!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read'); reads++; entered(); await held; return snapshot();
  };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
  const task = f.runtime.completingTurns.get(f.key); await started;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const pending = o.final().filter(row => row.phase === 'pending');
  try {
    assert.equal(pending.length, 1); assert.equal(pending[0]!.step, 1);
    assert.equal(f.users.codexExecutions.canStart(f.key), false); assert.equal(f.wakes(), 0);
    assert.equal(reads, 1); assert.equal(f.runtime.completingTurns.get(f.key), task);
  } finally { release(); await task; }
  const ended = o.final().find(row => row.phase === 'finished')!;
  assert.ok(ended); assert.equal(ended.sequence, pending[0]!.sequence);
  assert.equal(ended.settled, 1); assert.equal(ended.deferred, 0); assert.equal(ended.unknown, 0);
  assert.equal(reads, 1); assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.doesNotMatch(JSON.stringify(o.final()), /private-|synthetic|command|turnId|sessionKey/);
});

test('old terminal history delivered during active Goal logs success separately from execution protection', async t => {
  const f = fixture(t), o = observe(t); let reads = 0;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/goal/get') return { goal: { threadId: 'synthetic', status: 'active', createdAt: 1,
      updatedAt: 2, objective: 'private-goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } };
    assert.equal(method, 'thread/read'); reads++; return snapshot(true);
  };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true); assert.equal(reads, 1);
  assert.equal(f.users.codexExecutions.canStart(f.key), false); assert.equal(f.wakes(), 0);
  const ended = o.final().find(row => row.phase === 'finished')!;
  assert.ok(ended); assert.equal(ended.settled, 1); assert.equal(ended.deferred, 1); assert.equal(ended.unknown, 0);
  assert.doesNotMatch(JSON.stringify(o.final()), /private-|synthetic|sessionKey|turnId/);
});

test('obsolete final read logs cancellation without altering replacement connection or replaying', async t => {
  const f = fixture(t), o = observe(t); let reads = 0;
  f.runtime.request = async (method: string) => {
    assert.equal(method, 'thread/read'); reads++; f.runtime.setConnection('replacement'); return snapshot();
  };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
  await f.runtime.completingTurns.get(f.key);
  assert.equal(reads, 1); assert.equal(f.wakes(), 0); assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  const ended = o.final().find(row => row.phase === 'finished')!;
  assert.ok(ended); assert.equal(ended.cancelled, 1); assert.equal(ended.settled, 0); assert.equal(ended.unknown, 0);
});

for (const broken of [false, true]) test(`final log reentry/broken sink never starts a replacement reconciliation (${broken})`, async t => {
  const f = fixture(t); let reads = 0, reentries = 0;
  const o = observe(t, () => { reentries++; f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed'); }, broken);
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read'); reads++; return snapshot();
  };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
  await f.runtime.completingTurns.get(f.key);
  assert.equal(o.final().length, 1); assert.ok(reentries > 0); assert.equal(reads, 1);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true); assert.equal(f.runtime.completingTurns.size, 0);
  if (broken) assert.ok(o.diagnostics.snapshot().totals.sinkFailures > 0);
});

test('failed original final read logs bounded attempts and keeps recoverable error without resending', async t => {
  const f = fixture(t), o = observe(t); let reads = 0;
  f.users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: f.key, createdAt: 1,
    payload: { text: 'private-queued-input', images: [] } });
  const queue = f.users.turns.list('codex', f.key);
  f.runtime.request = async () => { reads++; throw Error('private-native-failure'); };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
  await f.runtime.completingTurns.get(f.key);
  const ended = o.final().find(row => row.phase === 'finished')!;
  assert.ok(ended); assert.equal(ended.unknown, 1); assert.equal(ended.settled, 0);
  assert.equal(ended.cancelled, 0); assert.equal(ended.records, 5); assert.equal(reads, 5);
  assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
  assert.equal(f.wakes(), 0); assert.deepEqual(f.users.turns.list('codex', f.key), queue);
  assert.doesNotMatch(JSON.stringify(o.final()), /private-|synthetic|sessionKey|turnId/);
});

for (const stage of ['assistant-projection-wait', 'rollout-snapshot', 'execution-verification', 'rollout-cleanup'] as const) {
  test(`pending ${stage} has one stage observation and retains the original owner`, async t => {
    const f = fixture(t), o = observe(t); let release!: () => void, entered!: () => void, reads = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') {
        if (stage === 'execution-verification') { entered(); await held; }
        return { data: [] };
      }
      assert.equal(method, 'thread/read'); reads++; return snapshot();
    };
    if (stage === 'assistant-projection-wait') {
      f.runtime.assistantProjections.set(f.key, new Set([held]));
      entered();
    } else if (stage === 'rollout-snapshot') {
      const original = f.runtime.rolloutReader.readProjectedSnapshotWithin.bind(f.runtime.rolloutReader);
      f.runtime.rolloutReader.readProjectedSnapshotWithin = async (...args: unknown[]) => { entered(); await held; return original(...args); };
    } else if (stage === 'rollout-cleanup') {
      const original = f.runtime.rolloutReader.disposeSnapshotWithin.bind(f.runtime.rolloutReader);
      f.runtime.rolloutReader.disposeSnapshotWithin = async (...args: unknown[]) => { entered(); await held; return original(...args); };
    }
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
    const task = f.runtime.completingTurns.get(f.key);
    try {
      await started; await new Promise(resolve => setTimeout(resolve, 1100));
      const pending = o.final().filter(row => row.phase === 'pending');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.step, { 'assistant-projection-wait': 2, 'rollout-snapshot': 4,
        'execution-verification': 6, 'rollout-cleanup': 7 }[stage]);
      assert.equal(f.runtime.completingTurns.get(f.key), task);
      assert.equal(f.users.codexExecutions.canStart(f.key), false); assert.equal(f.wakes(), 0);
      assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    } finally { release(); await task; }
    assert.equal(reads, 1); assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    const ended = o.final().find(row => row.phase === 'finished')!;
    assert.ok(ended); assert.equal(ended.settled, 1); assert.equal(ended.unknown, 0);
    assert.equal(ended.sequence, o.final().find(row => row.phase === 'pending')!.sequence);
  });
}

test('starting diagnostic clock reentry cannot replace the already reserved task', async t => {
  const f = fixture(t); let reads = 0, clocks = 0;
  const d = new PerformanceDiagnostics(() => {}, () => {
    clocks++; f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed'); return 0;
  });
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<PerformanceDiagnostics['start']>[0]) => d.start(operation));
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    reads++; return snapshot();
  };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 1, 'turn', 'completed');
  await f.runtime.completingTurns.get(f.key);
  assert.ok(clocks > 0); assert.equal(reads, 1); assert.equal(f.runtime.completingTurns.size, 0);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
});
