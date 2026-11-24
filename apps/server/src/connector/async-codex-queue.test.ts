import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { nativeHistoryFingerprint, type NativeHistoryCheckpoint } from '../codex/native-history.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';
import { AsyncCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexPreparation } from './async-codex-preparation.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexStartup, codexStartupDeckPublisher } from './async-codex-startup.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue, type CodexQueuePreparation } from './async-codex-queue.js';
import { createConnectorCodexContextCommands } from './connector-codex-context-domain.js';
import { createConnectorCodexQueuePlanCommands, decodeCodexQueuePlan, CODEX_QUEUE_PLAN_CHUNK_BYTES,
  type CodexQueuePlan, type CodexQueueEntry } from './connector-codex-queue-plan-domain.js';

const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: import('node:test').TestContext, texts = ['private-first', 'private-second'], legacy = false,
  timestamps?: number[]) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-live-queue-'));
  const config = { file: join(directory, 'worker.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-live-plan' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const key = 'codex:original', store = new ConnectorUserStore(config.file, (id, action) =>
    tokens.hasScope(id, 'execution:delegate') && tokens.hasScope(id, 'messages:send')
      && (action !== 'messages:mirror' || tokens.hasScope(id, 'messages:mirror')), { runtimeOwner: true });
  const turns = texts.map((text, i) => ({ id: `command-${i}`, sessionKey: key, createdAt: timestamps?.[i] ?? i + 1, state: 'queued' as const,
    payload: { text, images: [], actorId: actor } }));
  if (legacy) {
    const file = join(directory, 'legacy.json'); writeFileSync(file, JSON.stringify({ queues: { [key]: turns } }));
    store.turns.importLegacy('codex', file, (_key, entry) => entry as typeof turns[number]);
  } else for (const turn of turns) await store.turns.enqueueAsync('codex', turn);
  const domain = createConnectorCodexQueuePlanCommands(store, tokens);
  const contextDomain = createConnectorCodexContextCommands(store, tokens);
  const command = (async (kind: any, input: any) => kind === 'codexQueueContext' ? contextDomain(input) : domain(kind, input)) as AsyncConnectorOwner['command'];
  let closed = false;
  const closeStore = () => { if (!closed) { domain.dispose(); store.close(); closed = true; } };
  const beforeRootCleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of beforeRootCleanup.reverse()) await close();
    closeStore(); rmSync(directory, { recursive: true, force: true });
  });
  return { directory, config, actor, key, store, tokens, domain, command, closeStore,
    closeBeforeRootCleanup(close: () => Promise<void>) { beforeRootCleanup.push(close); } };
}

/** No manual preparing claim or proof substitution: the live queue owns both. */
async function recoveryQueue(t: import('node:test').TestContext, count = 2, needsRecovery = true,
  checkpoint?: NativeHistoryCheckpoint['state'], configure?: (f: Awaited<ReturnType<typeof fixture>>) => void,
  blockedGoalInput = false) {
  const f = await fixture(t, Array.from({ length: count }, (_, i) => `PRIVATE request ${i}`));
  const thread = { id: 'original', status: { type: 'idle' }, canAcceptDirectInput: true, turns: [
    { id: 'kept', status: 'completed', items: [
      { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'PRIVATE old input' }] },
      { id: 'assistant', type: 'agentMessage', text: 'PRIVATE retained context' },
    ] }, { id: 'old-run', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] },
  ] };
  if (checkpoint) {
    assert.ok(f.store.codexExecutions.begin(f.key, 'previous-command', 'original-connection'));
    assert.ok(f.store.codexExecutions.acknowledge(f.key, 'previous-command', 'original-connection', 'old-run', () => {}));
    assert.ok(f.store.codexExecutions.observe(f.key, 'original-connection', 'old-run', 'failed'));
    assert.ok(f.store.codexExecutions.settleNativeHistory(f.store.codexExecutions.get(f.key)!, {
      turnId: 'old-run', fingerprint: nativeHistoryFingerprint(thread), connectionId: 'original-connection',
      state: checkpoint, reason: checkpoint === 'verified' ? 'settled' : 'cleanup-unconfirmed',
    }));
  }
  configure?.(f);
  f.closeStore();
  const owner = new AsyncConnectorOwner(f.config, silence); await owner.open();
  const db = new ConnectorUserStore(':memory:'), deck = new DeckStore();
  let runtime: any;
  let hook: ((kind: string, value: any, run: () => Promise<any>) => Promise<any>) | undefined;
  const calls: string[] = [], writes: any[] = [], stages: string[] = [];
  const port = { command: (async (kind: any, value: any) => {
    calls.push(kind); const run = () => owner.command(kind, value); return hook ? hook(kind, value, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const projection = new AsyncCodexProjection({ owner: port, deck, bind: false,
    connectionId: () => runtime?.connectionId, diagnostics: silence });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: f.directory, defaultModel: 'test',
    approvalPolicy: 'never', store: deck, turnQueue: db.turns, executions: db.codexExecutions,
    credentialExecutionReader: new AsyncConnectorExecutionReads(owner).codex,
    nativeJournal: projection.nativeJournal(),
    authorizeTurn: () => { throw Error('main-thread authority forbidden'); }, requestTimeoutMs: 30 });
  // Constructor isolation only; production root assembly remains a separate PRD gate.
  runtime = codex as any; runtime.connectionId = 'original-connection';
  runtime.loadedThreadIds.add('original');
  let nativeReply: ((method: string, result: any) => any) | undefined;
  runtime.child = { stdin: { writable: true, write(line: string) {
    const row = JSON.parse(line); writes.push(row);
    const result = row.method === 'thread/read' ? { thread: structuredClone(thread) }
      : row.method === 'thread/goal/get' ? { goal: null }
      : row.method === 'thread/backgroundTerminals/list' ? { data: [] }
      : row.method === 'turn/start' ? { turn: { id: 'next-run' } } : {};
    runtime.receive(JSON.stringify({ id: row.id, result: nativeReply ? nativeReply(row.method, result) : result }));
    if (row.method === 'thread/compact/start') {
      for (const method of ['item/started', 'item/completed']) runtime.handleNotification(method, {
        threadId: 'original', turnId: 'compact-run', item: { id: 'compact-item', type: 'contextCompaction' },
      });
      runtime.handleNotification('turn/completed', { threadId: 'original', turn: { id: 'compact-run', status: 'completed' } });
    }
    return true;
  } } };
  const get = db.codexExecutions.get, list = db.turns.list;
  db.codexExecutions.get = () => { throw Error('main-thread execution SQL forbidden'); };
  db.turns.list = () => { throw Error('main-thread queue SQL forbidden'); };
  await projection.open();
  runtime.options.historyReader = new AsyncCodexHistory(port, silence);
  deck.upsertSession({ sessionKey: f.key, agentId: 'codex', title: 'Original', status: 'idle' });
  deck.addMessage({ id: 'assistant', sessionKey: f.key, role: 'assistant', status: 'sent', text: 'PRIVATE retained context', createdAt: 0 });
  if (needsRecovery) deck.addMessage({ id: 'old-failure', sessionKey: f.key, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
  runtime.threadRefreshResult.set(f.key, { at: Date.now(), available: true });
  const preparation = new AsyncCodexPreparation({ owner: port, runtime: codex, local() {}, diagnostics: silence });
  const dispatch = new AsyncCodexDispatch({ owner: port, runtime: codex, local() {}, diagnostics: silence });
  const outcomes: string[] = [];
  let observe: (() => Promise<void>) | undefined, prepare: (() => Promise<void>) | undefined;
  let mismatch = false, skip = false;
  const queue = new AsyncCodexQueue({ owner: port, dispatch, local() {}, diagnostics: silence,
    recovery: { consumer: preparation, async observe(plan) {
      stages.push('observe'); await observe?.();
      const observation = await codex.observeOwnedQueue(f.key, blockedGoalInput);
      // Observation cannot replace the queue's private FIFO identity.
      plan.proof.digest = '0'.repeat(64); plan.commandId = 'forged';
      return observation;
    } },
    async prepare(plan, entries, context) {
      stages.push('prepare'); await prepare?.(); if (skip) return null;
      assert.equal(context, needsRecovery ? 'PRIVATE retained context' : undefined);
      const credentials = await codex.prepareOwnedCredentials(f.key, entries.map(e => e.payload.text).join(plan.batch?.separator ?? ''), plan.commandId);
      plan.proof.digest = 'f'.repeat(64);
      return { input: [{ type: 'text', text: context ? `[Recovered context from the oversized failed turn]\n${context}\n\n[Current request]\n${credentials.text}` : credentials.text }],
        connectionId: mismatch ? 'replacement' : credentials.connectionId, blockedGoalInput, interactive: false,
        dispatching: () => credentials.dispatching(), async finish(outcome) { outcomes.push(outcome); await credentials.finish(outcome); } };
    } });
  f.closeBeforeRootCleanup(async () => {
    await queue.close(); await preparation.close(); await dispatch.close();
    db.codexExecutions.get = get; db.turns.list = list;
    runtime.child = undefined; await codex.close(); await projection.close(); db.close(); await owner.close();
  });
  return { ...f, owner, queue, deck, runtime, codex, writes, calls, stages, outcomes,
    nativeReply(fn: NonNullable<typeof nativeReply>) { nativeReply = fn; },
    hook(fn: NonNullable<typeof hook>) { hook = fn; }, observe(fn: NonNullable<typeof observe>) { observe = fn; },
    prepare(fn: NonNullable<typeof prepare>) { prepare = fn; }, mismatch() { mismatch = true; }, skip() { skip = true; } };
}

for (const count of [1, 2]) test(`live ${count}-member queue owns preparing receipt → ORIGINAL recovery → credentials → native ACK`, async t => {
  const f = await recoveryQueue(t, count);
  assert.equal(await f.queue.run(f.key), 'admitted');
  assert.deepEqual(f.stages, ['observe', 'prepare']);
  assert.deepEqual(f.writes.map(row => row.method), ['thread/read', 'thread/rollback', 'thread/compact/start', 'turn/start']);
  assert.deepEqual(f.outcomes, ['admitted']);
  assert.equal(f.calls.filter(kind => kind === 'codexDispatchClaim').length, 2);
  const execution = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
  assert.equal(execution?.runId, 'next-run');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  assert.ok(f.deck.getMessages(f.key).some(message => message.text === 'PRIVATE retained context'));
  assert.ok(!f.deck.getMessages(f.key).some(message => message.id === 'old-failure'));
  assert.match(f.writes.at(-1).params.input[0].text, /PRIVATE retained context/);
  assert.equal(await f.queue.run(f.key), 'not_started');
  assert.equal(f.writes.length, 4, 'empty queue must not replay recovery or native input');
});

for (const fault of ['lost-preparing-claim', 'foreign-preparing-receipt', 'lost-finish', 'prepare-refused', 'connection-mismatch',
  'revoke-after-recovery', 'close-after-recovery'] as const) test(`live recovery handoff retains protection: ${fault}`, async t => {
  const f = await recoveryQueue(t);
  f.hook(async (kind, value, run) => {
    const result = await run();
    if (kind === 'codexDispatchClaim' && value.preparing) {
      if (fault === 'lost-preparing-claim') throw Error('reply lost after commit');
      if (fault === 'foreign-preparing-receipt') return { ...result, execution: { ...result.execution, commandId: 'foreign' } };
    }
    if (kind === 'codexPreparationFinish' && fault === 'lost-finish') throw Error('finish reply lost');
    return result;
  });
  if (fault === 'prepare-refused') f.skip();
  if (fault === 'connection-mismatch') f.mismatch();
  if (fault === 'revoke-after-recovery') f.prepare(async () => { await f.owner.command('tokenRevoke', { tokenId: f.actor }); });
  let closing: Promise<void> | undefined;
  if (fault === 'close-after-recovery') f.prepare(async () => { closing = f.queue.close(); });
  assert.equal(await f.queue.run(f.key), 'unknown'); await closing;
  assert.ok(!f.writes.some(row => row.method === 'turn/start'));
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
  assert.ok(await f.owner.command('codexExecutionRead', { sessionKey: f.key }));
  const before = f.writes.length;
  await f.queue.run(f.key);
  assert.equal(f.writes.length, before, 'original preparing receipt must never replay');
  if (f.outcomes.length) assert.deepEqual(f.outcomes, ['unknown']);
});

test('live recovery close drains original observation before any claim or credential creation', async t => {
  const f = await recoveryQueue(t), entered = deferred(), gate = deferred();
  f.observe(async () => { entered.resolve(); await gate.promise; });
  const work = f.queue.run(f.key); await entered.promise;
  let closed = false; const closing = f.queue.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  gate.resolve(); assert.equal(await work, 'not_started'); await closing;
  assert.equal(f.calls.includes('codexDispatchClaim'), false);
  assert.equal(f.stages.includes('prepare'), false); assert.equal(f.writes.length, 0);
});

test('original scheduler observation keeps ordinary sends outside recovery and compaction', async t => {
  const f = await recoveryQueue(t, 2, false);
  assert.equal(await f.queue.run(f.key), 'admitted');
  assert.deepEqual(f.writes.map(row => row.method), ['turn/start']);
  assert.equal(f.calls.filter(kind => kind === 'codexDispatchClaim').length, 1);
  assert.equal(f.calls.some(kind => kind.startsWith('codexPreparation')), false);
  assert.deepEqual(f.outcomes, ['admitted']);
});

test('readonly history refresh cannot invalidate an already observed ordinary dispatch', async t => {
  const f = await recoveryQueue(t, 1, false), gate = deferred();
  let refresh: Promise<unknown> | undefined;
  const ensureStarted = f.runtime.ensureStarted.bind(f.runtime);
  f.runtime.ensureStarted = async (...args: unknown[]) => { await gate.promise; return ensureStarted(...args); };
  f.hook(async (kind, _value, run) => {
    const result = await run();
    if (kind === 'codexDispatchClaim') {
      refresh = f.codex.refreshSession(f.key, { readOnly: true, fresh: true }).catch(() => {});
      await tick(); await tick();
    }
    return result;
  });
  try {
    assert.equal(await f.queue.run(f.key), 'admitted');
    assert.equal(f.writes.filter(row => row.method === 'turn/start').length, 1);
  } finally { gate.resolve(); await refresh; }
});

for (const observation of ['absent', 'unchanged', 'changed', 'aba'] as const) {
  test(`goal observation during dispatch claim preserves semantic fence: ${observation}`, async t => {
    const f = await recoveryQueue(t, 1, false);
    const goal = { threadId: 'original', objective: 'Scoped task', status: 'paused', tokenBudget: null,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 };
    if (observation === 'unchanged') f.runtime.projectGoal(f.key, { goal }, 'original');
    f.hook(async (kind, value, run) => {
      const result = await run();
      if (kind === 'codexDispatchClaim') {
        f.runtime.projectGoal(f.key, { goal: observation === 'absent' ? null : goal }, 'original');
        if (observation === 'aba') f.runtime.projectGoal(f.key, { goal: null }, 'original');
      }
      return result;
    });
    const valid = observation === 'absent' || observation === 'unchanged';
    assert.equal(await f.queue.run(f.key), valid ? 'admitted' : 'unknown');
    assert.equal(f.writes.filter(row => row.method === 'turn/start').length, valid ? 1 : 0);
    assert.deepEqual(f.outcomes, [valid ? 'admitted' : 'unknown']);
    const writes = f.writes.length;
    await f.queue.run(f.key);
    assert.equal(f.writes.length, writes, 'neither admitted nor uncertain work may replay');
  });
}

for (const recovery of [false, true]) {
  test(`verified native history repeats original proof before ${recovery ? 'recovery' : 'ordinary'} FIFO dispatch`, async t => {
    const f = await recoveryQueue(t, 2, recovery, 'verified');
    const goalVersion = f.runtime.goalObservationVersions.get(f.key);
    assert.equal(await f.queue.run(f.key), 'admitted');
    assert.deepEqual(f.writes.slice(0, 5).map(row => row.method), [
      'thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list', 'thread/read', 'thread/goal/get',
    ]);
    assert.equal(f.runtime.goalObservationVersions.get(f.key), goalVersion, 'read-only proof must not project over its own lease');
    assert.equal(f.writes.filter(row => row.method === 'turn/start').length, 1);
    assert.equal(f.calls.some(kind => kind === 'codexNativeHistorySettle' || kind === 'codexNativeHistoryInvalidate'), false);
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  });
}

for (const fault of ['fingerprint', 'successor', 'goal-active', 'goal-unknown', 'goal-changed', 'background', 'availability', 'activity'] as const) {
  test(`original verified-head proof refuses ${fault} without claiming or rewriting the predecessor`, async t => {
    const f = await recoveryQueue(t, 2, false, 'verified');
    const previous = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
    let reads = 0, goals = 0;
    f.nativeReply((method, result) => {
      if (method === 'thread/read') {
        reads++;
        if (fault === 'fingerprint') result.thread.turns[0].items[0].content[0].text = 'changed';
        if (fault === 'successor' && reads === 2) result.thread.turns.push({ id: 'new-successor', status: 'inProgress', items: [] });
        if (fault === 'availability') result.thread.canAcceptDirectInput = false;
        if (fault === 'activity') f.runtime.nativeActivityVersions.set('original', 99);
      }
      if (method === 'thread/goal/get') {
        goals++;
        if (fault === 'goal-active' || fault === 'goal-changed' && goals === 2) result.goal = {
          threadId: 'original', status: fault === 'goal-active' ? 'active' : 'complete', objective: 'PRIVATE goal',
          tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2,
        };
        if (fault === 'goal-unknown') return {};
      }
      if (method === 'thread/backgroundTerminals/list' && fault === 'background') result.data = [{ processId: 'process', itemId: 'item' }];
      return result;
    });
    assert.equal(await f.queue.run(f.key), 'not_started');
    assert.equal(f.calls.includes('codexDispatchClaim'), false);
    assert.equal(f.writes.some(row => !['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(row.method)), false);
    assert.deepEqual(await f.owner.command('codexExecutionRead', { sessionKey: f.key }), previous);
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
  });
}

test('blocked native history remains with its original reconciliation owner', async t => {
  const f = await recoveryQueue(t, 2, false, 'blocked');
  assert.equal(await f.queue.run(f.key), 'not_started');
  assert.equal(f.calls.includes('codexDispatchClaim'), false); assert.equal(f.writes.length, 0);
});

for (const fault of ['none', 'active', 'paused', 'background', 'cleanup', 'goal-race', 'revoked', 'compaction'] as const) {
  test(`async original queued input continues blocked Goal safely: ${fault}`, async t => {
    const f = await recoveryQueue(t, 2, fault === 'compaction', 'blocked', f => {
      const fact = f.store.codexExecutions.get(f.key)!;
      assert.ok(f.store.codexExecutions.settleNativeHistory(fact, { ...fact.nativeHistory!, reason: 'goal-blocked' }));
    }, true);
    const previous = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
    let disposed = 0, goals = 0;
    f.runtime.rolloutReader.readSnapshot = async () => {
      if (fault === 'cleanup') throw Error('original snapshot unavailable');
      return { dispose: async () => { disposed++; } };
    };
    f.nativeReply((method, result) => {
      if (method === 'thread/goal/get') {
        goals++;
        return { goal: { threadId: 'original', status: fault === 'active' || fault === 'paused' ? fault : 'blocked',
          createdAt: 1, updatedAt: fault === 'goal-race' && goals > 1 ? 3 : 2,
          objective: 'PRIVATE goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } };
      }
      if (method === 'thread/backgroundTerminals/list' && fault === 'background') return { data: [{ processId: 'p', itemId: 'i' }] };
      return result;
    });
    if (fault === 'revoked') f.hook(async (kind, _value, run) => {
      if (kind === 'codexDispatchClaim') f.tokens.revoke(f.actor);
      return run();
    });
    const result = await f.queue.run(f.key);
    assert.equal(result, fault === 'none' ? 'admitted' : 'not_started');
    assert.equal(f.writes.filter(row => row.method === 'turn/start').length, fault === 'none' ? 1 : 0);
    assert.equal(f.writes.some(row => ['thread/goal/set', 'thread/goal/clear', 'thread/rollback', 'thread/compact/start'].includes(row.method)), false);
    if (fault === 'none') {
      assert.equal(disposed, 1);
      assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
      assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.runId, 'next-run');
      assert.equal(await f.queue.run(f.key), 'not_started', 'original input is never replayed');
    } else {
      assert.deepEqual(await f.owner.command('codexExecutionRead', { sessionKey: f.key }), previous);
      assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
    }
  });
}

for (const recovery of [false, true]) {
  test(`worker admission binds the original predecessor even after ${recovery ? 'recovery' : 'ordinary'} observation has returned`, async t => {
    const f = await recoveryQueue(t, 2, recovery, 'verified');
    let changed = false;
    f.hook(async (kind, value, run) => {
      if (kind === 'codexDispatchClaim' && !changed) {
        changed = true;
        const expected = (await f.owner.command('codexExecutionRead', { sessionKey: f.key }))!;
        assert.deepEqual(value.predecessor, { commandId: expected.commandId, connectionId: expected.connectionId, revision: expected.revision });
        assert.equal(await f.owner.command('codexNativeHistorySettle', { expected, checkpoint: {
          ...expected.nativeHistory!, fingerprint: 'f'.repeat(64),
        } }), true);
        assert.notEqual((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))!.revision, expected.revision,
          'the fixture must genuinely change the predecessor, not settle an identical checkpoint');
      }
      return run();
    });
    assert.equal(await f.queue.run(f.key), 'not_started'); assert.equal(changed, true);
    assert.equal(f.writes.some(row => row.method === 'turn/start' || row.method === 'thread/compact/start'), false);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))!.commandId, 'previous-command');
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
  });
}

test('original runtime close physically drains its in-flight worker observation', async t => {
  const f = await recoveryQueue(t), entered = deferred(), gate = deferred();
  const original = f.runtime.options.credentialExecutionReader;
  f.runtime.options.credentialExecutionReader = { async get(key: string) {
    entered.resolve(); await gate.promise; return original.get(key);
  } };
  const work = f.queue.run(f.key); await entered.promise;
  assert.equal(f.runtime.ownedHistoryPreparations.size, 1);
  let closed = false; const closing = f.codex.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  gate.resolve(); assert.equal(await work, 'not_started'); await closing;
  assert.equal(f.runtime.ownedHistoryPreparations.size, 0);
  assert.equal(f.calls.includes('codexDispatchClaim'), false);
  assert.deepEqual(f.stages, ['observe']); assert.equal(f.writes.length, 0);
});

for (const count of [1, 2]) for (const checkpoint of [undefined, 'verified'] as const) {
  test(`live worker blocks send-only recovery without mutation and retains it after reopen: ${count}/${checkpoint}`, async t => {
    const f = await recoveryQueue(t, count, true, checkpoint, seed => {
      const issuer = seed.tokens.create({ label: 'isolated-send-only', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub' });
      const grant = seed.store.executionGrants.issue({ principalId: 'member', grantKey: 'send-only', version: 1,
        runtime: 'codex', sessionKey: seed.key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 60_000);
      for (const row of seed.store.turns.list('codex', seed.key)) assert.ok(seed.store.turns.edit('codex', seed.key, row.id, () => ({
        text: 'PRIVATE recovery input', images: [], actorId: grant.actorId, executionGrant: { ...grant, issuerTokenId: issuer.record.id },
      })));
    });
    assert.equal(await f.queue.run(f.key), 'not_started');
    assert.equal(f.calls.filter(kind => kind === 'codexDispatchFailure').length, 1);
    assert.equal(f.stages.includes('prepare'), false);
    assert.ok(!f.writes.some(row => ['thread/rollback', 'thread/compact/start', 'turn/start'].includes(row.method)));
    const writes = f.writes.length;
    assert.equal(await f.queue.run(f.key), 'not_started');
    assert.equal(f.writes.length, writes, 'blocked original input must not be retried');
    await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      assert.deepEqual(reopened.turns.list('codex', f.key).map(row => row.state), Array(count).fill('blocked'));
      assert.equal(reopened.codexExecutions.get(f.key)?.commandId, checkpoint ? 'previous-command' : undefined);
    } finally { reopened.close(); }
    const worker = new AsyncConnectorOwner(f.config, silence);
    try {
      await worker.open();
      assert.deepEqual(await worker.command('codexQueuePlan', { sessionKey: f.key }), { state: 'blocked', sessionKey: f.key });
    } finally { await worker.close(); }
  });
}

for (const boundary of ['before-read', 'after-read'] as const) {
  test(`runtime close drains full public refresh at initial worker ${boundary}`, async t => {
    const f = await recoveryQueue(t), entered = deferred(), gate = deferred();
    let intercepted = false;
    f.hook(async (kind, _input, run) => {
      if (kind !== 'codexHistoryObservation' || intercepted) return run();
      intercepted = true;
      if (boundary === 'before-read') { entered.resolve(); await gate.promise; return run(); }
      const result = await run(); entered.resolve(); await gate.promise; return result;
    });
    const work = f.codex.refreshSession(f.key);
    const observed = work.then(() => undefined, error => error);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      assert.equal(f.runtime.threadRefreshInflight.size, 0, 'native deduplication has not begun');
      work.then = (() => Promise.resolve()) as typeof work.then;
      let closed = false;
      closing = f.codex.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false, 'public promise tampering cannot release physical work');
      assert.equal(f.runtime.historyRefreshDrains.size, 1, 'full operation is already owned');
      gate.resolve();
      assert.match((await observed)?.message ?? '', /closed/);
      await closing;
      assert.equal(f.runtime.historyRefreshDrains.size, 0);
      assert.equal(f.writes.length, 0, 'no native request starts after close');
      await assert.rejects(f.codex.refreshSession(f.key), /closed/);
    } finally {
      closing ??= f.codex.close();
      gate.resolve(); await observed; await closing;
    }
  });
}

test('observed absence cannot replace a competing worker claim during admission', async t => {
  const f = await recoveryQueue(t, 2, false);
  let competed = false;
  f.hook(async (kind, input, run) => {
    if (kind === 'codexDispatchClaim' && !competed) {
      competed = true;
      assert.equal(input.predecessor, null);
      const competing = await f.owner.command('codexDispatchClaim', { ...input, connectionId: 'competing-connection' });
      assert.ok(competing);
    }
    return run();
  });
  assert.equal(await f.queue.run(f.key), 'not_started');
  assert.equal(competed, true);
  assert.equal(f.writes.some(row => row.method === 'turn/start'), false);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.connectionId, 'competing-connection');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
});

test('live queue ACK and original native tool receiver use the same worker journal', async t => {
  const f = await recoveryQueue(t, 2, false);
  assert.equal(await f.queue.run(f.key), 'admitted');
  f.runtime.receive(JSON.stringify({ method: 'item/started', params: { threadId: 'original', turnId: 'next-run',
    item: { id: 'live-tool', type: 'commandExecution', command: 'synthetic command' } } }));
  await f.runtime.nativeObservations.drain();
  assert.equal(f.runtime.executionUnavailable, false);
  assert.deepEqual((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.pendingCommandTools, ['live-tool']);
  assert.ok(f.deck.getMessages(f.key).some(message => message.role === 'tool'));
  assert.equal(f.writes.filter(row => row.method === 'turn/start').length, 1);
});

for (const stage of ['prepare', 'claim', 'ready'] as const) {
  for (const change of ['thread', 'unscoped', 'projection', 'unrelated'] as const) {
    test(`ordinary observation remains bound through ${stage}: ${change}`, async t => {
      const f = await recoveryQueue(t, 2, false);
      const invalidate = () => {
        if (change === 'projection') f.runtime.projectionVersions.set(f.key, 99);
        else f.runtime.recordNativeActivity(change === 'unscoped' ? undefined : change === 'unrelated' ? 'unrelated' : 'original');
      };
      if (stage === 'prepare') f.prepare(async () => { invalidate(); });
      else f.hook(async (kind, _value, run) => {
        const result = await run();
        if (kind === (stage === 'claim' ? 'codexDispatchClaim' : 'codexDispatchReady')) invalidate();
        return result;
      });
      const admitted = change === 'unrelated';
      const expected = admitted ? 'admitted' : stage === 'prepare' ? 'not_started' : 'unknown';
      assert.equal(await f.queue.run(f.key), expected);
      assert.equal(f.writes.filter(row => row.method === 'turn/start').length, Number(admitted));
      assert.equal(f.calls.filter(kind => kind === 'codexDispatchClaim').length, Number(admitted || stage !== 'prepare'));
      assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), admitted ? 0 : 2);
      assert.deepEqual(f.outcomes, [expected]);
      if (!admitted && stage !== 'prepare') {
        assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'unknown');
      }
    });
  }
}

test('ordinary observation is never rechecked after its own native ACK', async t => {
  const f = await recoveryQueue(t, 2, false);
  f.nativeReply((method, result) => {
    if (method === 'turn/start') {
      f.runtime.recordNativeActivity('original');
      f.runtime.projectionVersions.set(f.key, 99);
    }
    return result;
  });
  assert.equal(await f.queue.run(f.key), 'admitted');
  assert.deepEqual(f.outcomes, ['admitted']);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.runId, 'next-run');
  assert.equal(f.writes.filter(row => row.method === 'turn/start').length, 1);
});

for (const fault of ['projection', 'goal', 'activity', 'history', 'busy', 'generation', 'child'] as const) {
  test(`original preclaim observation refuses ${fault} changes during worker read`, async t => {
    const f = await recoveryQueue(t), original = f.runtime.options.credentialExecutionReader;
    f.runtime.options.credentialExecutionReader = { async get(key: string) {
      const fact = await original.get(key);
      if (fault === 'projection') f.runtime.projectionVersions.set(key, 99);
      if (fault === 'goal') f.runtime.goalExecutionVersions.set(key, 99);
      if (fault === 'activity') f.runtime.nativeActivityVersions.set('original', 99);
      if (fault === 'history') f.runtime.threadRefreshResult.delete(key);
      if (fault === 'busy') f.deck.upsertSession({ ...f.deck.getSession(key)!, status: 'running', hasActiveRun: true });
      if (fault === 'generation') f.runtime.nativeConnectionGeneration++;
      if (fault === 'child') f.runtime.child = { ...f.runtime.child };
      return fact;
    } };
    assert.equal(await f.queue.run(f.key), 'not_started');
    assert.equal(f.calls.includes('codexDispatchClaim'), false);
    assert.deepEqual(f.stages, ['observe']); assert.equal(f.writes.length, 0);
    assert.equal(await f.owner.command('codexExecutionRead', { sessionKey: f.key }), null);
  });
}

for (const recovery of [false, true]) for (const phase of ['claim', 'ready'] as const) {
  for (const fault of ['generation-ABA', 'child', 'goal'] as const) {
    test(`original observation lease survives ${recovery ? 'recovery' : 'ordinary'} ${phase}: ${fault}`, async t => {
      const f = await recoveryQueue(t, 2, recovery);
      const target = phase === 'claim' ? 'codexDispatchClaim' : recovery ? 'codexPreparationReady' : 'codexDispatchReady';
      let changed = false;
      f.hook(async (kind, _value, run) => {
        const result = await run();
        if (kind === target && !changed) {
          changed = true;
          if (fault === 'generation-ABA') {
            const connection = f.runtime.connectionId;
            f.runtime.connectionId = 'temporary-other-connection'; f.runtime.nativeConnectionGeneration++;
            f.runtime.connectionId = connection;
          }
          if (fault === 'child') f.runtime.child = { ...f.runtime.child };
          if (fault === 'goal') f.runtime.goalExecutionVersions.set(f.key, 99);
        }
        return result;
      });
      assert.equal(await f.queue.run(f.key), 'unknown'); assert.equal(changed, true);
      assert.equal(f.writes.length, 0, 'no thread read, rollback, compaction or native start after lease loss');
      assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
      assert.ok(await f.owner.command('codexExecutionRead', { sessionKey: f.key }));
      await f.queue.run(f.key); assert.equal(f.writes.length, 0);
    });
  }
}

for (const fault of ['projection', 'goal', 'activity'] as const) {
  test(`ordinary preparation retains original preclaim ${fault} fence`, async t => {
    const f = await recoveryQueue(t, 2, false);
    f.prepare(async () => {
      if (fault === 'projection') f.runtime.projectionVersions.set(f.key, 99);
      if (fault === 'goal') f.runtime.goalExecutionVersions.set(f.key, 99);
      if (fault === 'activity') f.runtime.nativeActivityVersions.set('original', 99);
    });
    assert.equal(await f.queue.run(f.key), 'not_started');
    assert.equal(f.calls.includes('codexDispatchClaim'), false); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.outcomes, ['not_started']);
  });
}

async function read(f: Awaited<ReturnType<typeof fixture>>, plan: CodexQueuePlan) {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < plan.bytes; offset += CODEX_QUEUE_PLAN_CHUNK_BYTES) {
    const part = f.domain('codexQueuePlanChunk', { sessionKey: f.key, planId: plan.planId, offset }); assert.ok(part);
    parts.push(Buffer.from(part.chunk, 'base64'));
  }
  return Buffer.concat(parts);
}
const getPlan = (f: Awaited<ReturnType<typeof fixture>>) => {
  const plan = f.domain('codexQueuePlan', { sessionKey: f.key }); assert.ok(plan?.state === 'ready'); return plan;
};

test('live FIFO plan preserves original batch and private proof ownership', async t => {
  const f = await fixture(t), plan = getPlan(f), original = structuredClone(plan);
  plan.commandId = 'forged'; plan.proof.digest = '0'.repeat(64);
  const body = await read(f, original), entries = decodeCodexQueuePlan(original, body);
  assert.deepEqual(entries.map(e => e.id), ['command-0', 'command-1']);
  assert.equal(original.batch?.members.length, 2);
  assert.throws(() => decodeCodexQueuePlan(plan, body));
  assert.equal(f.store.codexExecutions.get(f.key), undefined);
  assert.equal(f.domain('codexQueuePlanRelease', { sessionKey: f.key, planId: original.planId }), false);
});

test('legal legacy first message above 1MiB is delivered alone with bounded chunks', async t => {
  const text = '长'.repeat(700_000), f = await fixture(t, [text, 'next'], true), plan = getPlan(f);
  assert.equal(plan.proof.count, 1); assert.equal(plan.batch, undefined);
  assert.equal(decodeCodexQueuePlan(plan, await read(f, plan))[0]!.payload.text, text);
  assert.equal(f.store.turns.list('codex', f.key).length, 2);
});

for (const legacy of [false, true]) {
  test(`live FIFO preserves original finite timestamps through ${legacy ? 'legacy import' : 'admission'}`, async t => {
    const timestamps = [-0.75, 1.125], f = await fixture(t, ['old-first', 'old-second'], legacy, timestamps);
    f.closeStore();
    const worker = new AsyncConnectorOwner(f.config, silence);
    try {
      await worker.open();
      const plan = await worker.command('codexQueuePlan', { sessionKey: f.key }); assert.ok(plan?.state === 'ready');
      const parts: Buffer[] = [];
      for (let offset = 0; offset < plan.bytes; offset += CODEX_QUEUE_PLAN_CHUNK_BYTES) {
        const part = await worker.command('codexQueuePlanChunk', { sessionKey: f.key, planId: plan.planId, offset }); assert.ok(part);
        parts.push(Buffer.from(part.chunk, 'base64'));
      }
      const entries = decodeCodexQueuePlan(plan, Buffer.concat(parts));
      assert.deepEqual(entries.map(entry => entry.createdAt), timestamps);
      assert.deepEqual(entries.map(entry => entry.id), ['command-0', 'command-1']);
      assert.deepEqual(plan.batch?.members.map(member => member.createdAt), timestamps);
      const claim = { sessionKey: f.key, commandId: plan.commandId, proof: plan.proof, batch: plan.batch!,
        connectionId: 'legacy-compatible', preparing: false, blockedGoalInput: false };
      const forged = structuredClone(claim); forged.batch.members[0]!.createdAt += 1;
      assert.equal(await worker.command('codexDispatchClaim', forged), null, 'finite does not mean caller-owned batch identity');
      const receipt = await worker.command('codexDispatchClaim', claim); assert.ok(receipt);
      assert.deepEqual(receipt.execution.batch?.members.map(member => member.createdAt), timestamps);
      assert.equal(await worker.command('codexDispatchReady', { sessionKey: f.key, commandId: plan.commandId,
        connectionId: claim.connectionId, proof: receipt.proof }), true);
    } finally { await worker.close(); }
  });
}

for (const mutation of ['revoke', 'cancel', 'edit-ABA', 'offset', 'expiry'] as const) {
  test(`plan invalidates remaining chunks after ${mutation}, without execution claim`, async t => {
    const f = await fixture(t, ['x'.repeat(140_000)]);
    let now = 0; const domain = createConnectorCodexQueuePlanCommands(f.store, f.tokens, () => now);
    t.after(() => domain.dispose());
    const plan = domain('codexQueuePlan', { sessionKey: f.key }); assert.ok(plan?.state === 'ready');
    assert.ok(domain('codexQueuePlanChunk', { sessionKey: f.key, planId: plan.planId, offset: 0 }));
    if (mutation === 'revoke') f.tokens.revoke(f.actor);
    if (mutation === 'cancel') f.store.turns.cancel('codex', f.key, 'command-0');
    if (mutation === 'edit-ABA') {
      f.store.turns.edit<any>('codex', f.key, 'command-0', p => ({ ...p, text: 'changed' }));
      f.store.turns.edit<any>('codex', f.key, 'command-0', p => ({ ...p, text: 'x'.repeat(140_000) }));
    }
    if (mutation === 'expiry') now = 120_001;
    assert.equal(domain('codexQueuePlanChunk', { sessionKey: f.key, planId: plan.planId,
      offset: mutation === 'offset' ? 0 : CODEX_QUEUE_PLAN_CHUNK_BYTES }), null);
    assert.equal(f.store.codexExecutions.get(f.key), undefined);
  });
}

test('consumer keeps original claim despite preparation mutation and drains physical finish', async t => {
  const f = await fixture(t), finish = deferred(), prepared = deferred(), finishing = deferred();
  let captured: any, calls = 0;
  const queue = new AsyncCodexQueue({ owner: { command: f.command },
    local() {}, diagnostics: silence, dispatch: { async dispatch(value) { calls++; captured = value; return 'admitted'; } },
    async prepare(plan, entries) {
      assert.equal(entries.length, 2); plan.commandId = 'forged'; plan.proof.digest = '0'.repeat(64); prepared.resolve();
      return { input: [], connectionId: 'original', interactive: false, blockedGoalInput: false,
        async finish(outcome) { assert.equal(outcome, 'admitted'); finishing.resolve(); await finish.promise; } };
    } });
  const work = queue.run(f.key); await prepared.promise;
  assert.equal(await queue.run(f.key), 'not_started'); await finishing.promise;
  let closed = false; const closing = queue.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  finish.resolve(); assert.equal(await work, 'admitted'); await closing;
  assert.equal(calls, 1); assert.equal(captured.claim.commandId, 'command-0'); assert.notEqual(captured.claim.proof.digest, '0'.repeat(64));
});

for (const phase of ['prepare', 'finish'] as const) {
  test(`close drains private physical ${phase} despite public Promise tampering`, async t => {
    const f = await fixture(t), entered = deferred(), gate = deferred();
    const queue = new AsyncCodexQueue({ owner: { command: f.command },
      local() {}, diagnostics: silence, dispatch: { async dispatch() { return 'admitted'; } },
      async prepare() {
        if (phase === 'prepare') { entered.resolve(); await gate.promise; }
        return { input: [], connectionId: 'original', interactive: false, blockedGoalInput: false,
          async finish() { if (phase === 'finish') { entered.resolve(); await gate.promise; } } };
      } });
    const work = queue.run(f.key); await entered.promise;
    Object.defineProperty(work, 'then', { value: (done: (value: string) => unknown) => Promise.resolve(done('not_started')) });
    let closed = false; const closing = queue.close().then(() => { closed = true; });
    try {
      await tick(); assert.equal(closed, false);
      assert.equal(await queue.run(f.key), 'not_started');
    } finally { gate.resolve(); await closing; }
    assert.equal(await work, phase === 'prepare' ? 'not_started' : 'admitted');
  });
}

for (const mode of ['defer', 'throw', 'malformed', 'closing', 'unknown'] as const) {
  test(`preparation ${mode} cannot cause replay or premature resource release`, async t => {
    const f = await fixture(t), entered = deferred(), gate = deferred(), finishes: string[] = []; let calls = 0, releases = 0;
    const queue = new AsyncCodexQueue({ owner: { command: f.command },
      local() {}, diagnostics: silence, dispatch: { async dispatch() { calls++; throw Error('lost claim reply'); } },
      recovery: { async observe() {
        return { connectionId: 'original', blockedGoalInput: false, needed: false, release() { releases++; } };
      }, consumer: { async recover() { assert.fail('unneeded recovery must not consume a claim'); } } },
      async prepare() {
        entered.resolve(); if (mode === 'closing') await gate.promise;
        if (mode === 'defer') return null; if (mode === 'throw') throw Error('private preparation error');
        if (mode === 'malformed') return { input: [] } as unknown as CodexQueuePreparation;
        return { input: [], connectionId: 'original', interactive: false, blockedGoalInput: false, async finish(outcome) { finishes.push(outcome); } };
      } });
    const work = queue.run(f.key); await entered.promise;
    const closing = mode === 'closing' ? queue.close() : undefined; gate.resolve();
    assert.equal(await work, mode === 'unknown' ? 'unknown' : 'not_started'); await closing; await queue.close();
    assert.equal(releases, 1);
    assert.equal(calls, mode === 'unknown' ? 1 : 0);
    assert.deepEqual(finishes, mode === 'unknown' ? ['unknown'] : mode === 'closing' ? ['not_started'] : []);
    assert.equal(f.store.turns.list('codex', f.key).length, 2);
  });
}

for (const mode of ['terminal', 'lost-claim', 'lost-ack'] as const) {
test(`real worker FIFO and original credential lifecycle ${mode} without main-thread database handles`, async t => {
  const secret = 'AbCd0123+/'.repeat(31) + '==';
  const f = await fixture(t, [`Synthetic value: ${secret}`, 'private-second']); f.closeStore();
  const owner = new AsyncConnectorOwner(f.config, silence);
  let codex: CodexAppServer | undefined, runtime: any, dispatch: AsyncCodexDispatch | undefined;
  let projection: AsyncCodexProjection | undefined, queue: AsyncCodexQueue | undefined;
  try {
  await owner.open();
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey: f.key, agentId: 'codex', title: 'Original', status: 'idle' });
  projection = new AsyncCodexProjection({ owner, deck, connectionId: () => runtime?.connectionId, bind: false, diagnostics: silence });
  const startup = new AsyncCodexStartup({ owner, projection, publish: codexStartupDeckPublisher(deck), diagnostics: silence });
  const dispatchOwner = { command: (async (kind: any, value: any) => {
    const result = await owner.command(kind, value);
    if (mode === 'lost-claim' && kind === 'codexDispatchClaim') throw Error('claim reply lost after original commit');
    return result;
  }) as AsyncConnectorOwner['command'] };
  let entries: CodexQueueEntry[] = [], final: string | undefined, file = '';
  queue = new AsyncCodexQueue({ owner, dispatch: { dispatch: value => dispatch!.dispatch(value) }, local() {}, diagnostics: silence,
    async prepare(plan, original) {
      entries = original;
      const credentials = await codex!.prepareOwnedCredentials(f.key, original.map(e => e.payload.text).join(plan.batch?.separator ?? ''), plan.commandId);
      file = credentials.text.match(/stored at ([^\]]+)/)?.[1] ?? '';
      assert.ok(file); assert.equal(readFileSync(file, 'utf8'), secret);
      return { connectionId: credentials.connectionId, interactive: false, blockedGoalInput: false,
        input: [{ type: 'text', text: credentials.text }], dispatching: () => credentials.dispatching(),
        async finish(outcome) { final = outcome; await credentials.finish(outcome); } };
    } });
  codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: f.directory, defaultModel: 'test-model',
    approvalPolicy: 'never', store: deck, nativeJournal: projection.nativeJournal(), startup,
    scheduling: new AsyncCodexScheduling(owner), queuedConsumer: queue, historyReader: new AsyncCodexHistory(owner, silence),
    credentialExecutionReader: new AsyncConnectorExecutionReads(owner).codex,
    authorizeTurn: () => { throw Error('sync authorization forbidden'); }, requestTimeoutMs: 20 });
  runtime = codex as any;
  await codex.ready();
  const writes: any[] = [];
  runtime.connectionId = 'original-connection';
  runtime.loadedThreadIds.add('original');
  runtime.child = { stdin: { writable: true, write(line: string) {
    const request = JSON.parse(line); writes.push(request);
    if (mode !== 'lost-ack') queueMicrotask(() => runtime.receive(JSON.stringify({ id: request.id, result: { turn: { id: 'original-native' } } })));
    return true;
  } } };
  dispatch = new AsyncCodexDispatch({ owner: dispatchOwner, runtime: codex, local() {}, diagnostics: silence });
  assert.equal(Object.hasOwn(runtime.options, 'turnQueue'), false);
  assert.equal(Object.hasOwn(runtime.options, 'executions'), false);
    const expected = mode === 'terminal' ? 'admitted' : 'unknown';
    assert.equal(await queue.run(f.key), expected); assert.equal(final, expected);
    assert.equal(writes.length, mode === 'lost-claim' ? 0 : 1);
    assert.deepEqual(entries.map(e => e.id), ['command-0', 'command-1']);
    if (mode !== 'terminal') {
      await runtime.cleanupSecretFiles(f.key); assert.equal(existsSync(file), true);
      runtime.child = undefined; await codex.close(); assert.equal(existsSync(file), true);
      return;
    }
    const execution = await owner.command('codexExecutionRead', { sessionKey: f.key });
    assert.equal(execution?.runId, 'original-native');
    assert.equal(JSON.stringify(writes).includes(secret), false);
    await runtime.cleanupSecretFiles(f.key); assert.equal(existsSync(file), true, 'ACK alone is not terminal proof');
    assert.equal(await owner.command('codexExecutionObserve', { sessionKey: f.key, connectionId: 'original-connection',
      runId: 'original-native', phase: 'completed', expected: { commandId: execution!.commandId, revision: execution!.revision } }), true);
    await runtime.cleanupSecretFiles(f.key); assert.equal(existsSync(file), false);
  } finally {
    try { await queue?.close(); }
    finally { try { await dispatch?.close(); }
      finally { try { if (runtime) runtime.child = undefined; await codex?.close(); }
        finally { try { await projection?.close(); } finally { await owner.close(); } } } }
  }
});
}
