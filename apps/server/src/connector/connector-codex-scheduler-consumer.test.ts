import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer, type CodexAppServerOptions } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexStartup, codexStartupDeckPublisher } from './async-codex-startup.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';

const key = 'codex:scheduler-consumer', connection = 'original-native';
const silence = new PerformanceDiagnostics(() => {});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(5); }
  assert.fail('original scheduler did not reach expected boundary');
}

/** Real sole-file worker, original bootstrap/TurnWorker/FIFO reader. The
 * scheduler's history consumers are observed here, not certified by these
 * tests; their physical native effects have a separate fault-window matrix. */
async function fixture(t: import('node:test').TestContext, predecessor = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-original-scheduler-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'synthetic-scheduler-token' };
  const tokenStore = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokenStore.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  await seed.turns.enqueueAsync('codex', { id: 'original-input', sessionKey: key, createdAt: 1,
    payload: { text: 'PRIVATE original input', images: [], actorId: actor } });
  if (predecessor) {
    seed.codexExecutions.begin(key, 'original-command', connection);
    seed.codexExecutions.acknowledge(key, 'original-command', connection, 'original-run', () => {});
    seed.codexExecutions.observe(key, connection, 'original-run', 'completed');
    seed.codexExecutions.settleHistory(seed.codexExecutions.get(key)!, 'error');
  }
  seed.close();
  const owner = new AsyncConnectorOwner(config, silence);
  let codex: CodexAppServer | undefined, projection: AsyncCodexProjection | undefined;
  t.after(async () => {
    try { await codex?.close(); }
    finally {
      try { await projection?.close(); }
      finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  });
  await owner.open();
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original scheduler', status: 'idle' });
  let runtime: any, intercept: ((kind: string) => Promise<void>) | undefined;
  const kinds: string[] = [];
  const scheduling = new AsyncCodexScheduling({ command: (async (kind: any, input: any) => {
    kinds.push(kind);
    const result = await owner.command(kind, input);
    await intercept?.(kind);
    return result;
  }) as AsyncConnectorOwner['command'] });
  projection = new AsyncCodexProjection({ owner, deck, bind: false, connectionId: () => runtime?.connectionId, diagnostics: silence });
  const startup = new AsyncCodexStartup({ owner, projection, publish: codexStartupDeckPublisher(deck), diagnostics: silence });
  const preparations: unknown[] = [], recoveries: any[][] = [], refreshes: string[] = [];
  const queuedConsumer = new AsyncCodexQueue({ owner, diagnostics: silence,
    local() { assert.equal(runtime.closed, false); },
    dispatch: { async dispatch() { assert.fail('test preparation never permits a native effect'); } },
    async prepare(plan, entries) { preparations.push({ plan, entries }); return null; } });
  codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store: deck,
    nativeJournal: projection.nativeJournal(), startup, scheduling, queuedConsumer, historyReader: new AsyncCodexHistory(owner, silence),
    credentialExecutionReader: new AsyncConnectorExecutionReads(owner).codex,
    authorizeTurn() { assert.fail('host authorization is not worker authority'); } });
  runtime = codex as any;
  runtime.rehydrateCheckpointThread = async (...args: any[]) => { recoveries.push(args); };
  runtime.refreshSession = async (sessionKey: string) => { refreshes.push(sessionKey); };
  runtime.reconcileCompletedTurn = () => {};
  runtime.dispatchQueuedTurn = () => assert.fail('worker scheduler must not fall back to synchronous dispatcher');
  await codex.ready();
  return { owner, codex, runtime, scheduling, deck, preparations, recoveries, refreshes, kinds, actor,
    intercept(fn: (kind: string) => Promise<void>) { intercept = fn; },
    reconcile: () => runtime.turnWorker.options.reconcile(key) as Promise<void> };
}

test('original scheduler uses the real worker FIFO consumer, never synchronous queue or authorization', async t => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn((f.codex as any).options, 'turnQueue'), false);
  assert.equal(Object.hasOwn((f.codex as any).options, 'executions'), false);
  await f.reconcile();
  assert.equal(f.preparations.length, 1);
  assert.equal(f.recoveries.length, 1);
  assert.equal(f.recoveries[0]![2], true);
  assert.deepEqual(f.recoveries[0]![3], { headId: 'original-input', headVersion: (await f.scheduling.observe(key)).head!.version });
  assert.equal((await f.scheduling.observe(key)).head?.state, 'queued', 'read preparation cannot consume the original message');
  assert.ok(f.kinds.includes('codexSchedulingRecheck'));
});

test('worker-owned constructor rejects incomplete or mixed ownership before touching the view', () => {
  const forbidden = new Proxy({}, { get() { assert.fail('constructor touched a runtime resource before validating ownership'); } });
  const options: CodexAppServerOptions = {
    enabled: true, command: 'must-not-launch', defaultCwd: 'C:\\isolated\\cwd', defaultModel: 'synthetic', approvalPolicy: 'never',
    store: forbidden as any, nativeJournal: forbidden as any, startup: forbidden as any, scheduling: forbidden as any,
    queuedConsumer: forbidden as any, historyReader: forbidden as any, credentialExecutionReader: forbidden as any,
    authorizeTurn() { assert.fail('constructor cannot authorize a turn'); },
  };
  for (const missing of ['nativeJournal', 'startup', 'scheduling', 'queuedConsumer', 'historyReader', 'credentialExecutionReader']) {
    const input: any = { ...options }; delete input[missing];
    assert.throws(() => new CodexAppServer(input), /complete async ports/);
  }
  for (const mixed of ['turnQueue', 'executions', 'interactions', 'fileIndex', 'tokenUsage', 'fileBoardContext']) {
    assert.throws(() => new CodexAppServer({ ...options, [mixed]: forbidden } as any), /complete async ports/);
  }
});

test('worker-owned runtime rejects legacy store branches without a synthetic database handle', async t => {
  const f = await fixture(t);
  assert.throws(() => (f.codex as any).legacyTurnQueue, /Synchronous queue is unavailable/);
  assert.throws(() => (f.codex as any).legacyExecutions, /Synchronous executions are unavailable/);
  assert.equal((await f.scheduling.observe(key)).head?.state, 'queued');
  await f.reconcile(); assert.equal(f.preparations.length, 1);
});

test('revoked successor cannot suppress predecessor recovery or authorize native continuation', async t => {
  const f = await fixture(t, true);
  await f.owner.command('tokenRevoke', { tokenId: f.actor });
  await f.reconcile();
  assert.equal(f.recoveries.length, 1); assert.equal(f.recoveries[0]![2], false); assert.equal(f.recoveries[0]![3], null);
  assert.deepEqual(f.refreshes, [key]); assert.equal(f.preparations.length, 0);
  assert.equal((await f.scheduling.observe(key)).head?.state, 'blocked');
  assert.equal(f.deck.getMessages(key).find(message => message.id === 'original-input')?.status, 'failed');
  assert.ok(f.kinds.includes('codexSchedulingRejectHead'));
});

test('original scheduler durably rejects unauthorized head with no predecessor and never enters preparation', async t => {
  const f = await fixture(t);
  await f.owner.command('tokenRevoke', { tokenId: f.actor });
  await f.reconcile();
  assert.equal((await f.scheduling.observe(key)).head?.state, 'blocked');
  assert.equal(f.preparations.length, 0); assert.equal(f.recoveries.length, 0);
  const rejected = f.deck.getMessages(key).find(message => message.id === 'original-input');
  assert.equal(rejected?.status, 'failed'); assert.match(rejected.failureReason!, /not sent/);
  const count = f.kinds.filter(kind => kind === 'codexSchedulingRejectHead').length;
  await f.reconcile();
  assert.equal(f.kinds.filter(kind => kind === 'codexSchedulingRejectHead').length, count, 'blocked head is not repeatedly mutated');
});

test('runtime close drains a delayed durable rejection without publishing after close', async t => {
  const f = await fixture(t), held = deferred(); let waiting = false;
  await f.owner.command('tokenRevoke', { tokenId: f.actor });
  f.intercept(async kind => { if (kind === 'codexSchedulingRejectHead') { waiting = true; await held.promise; } });
  try {
    f.codex.startQueueWorker(); await until(() => waiting);
    let closed = false; const closing = f.codex.close().then(() => { closed = true; });
    await delay(10); assert.equal(closed, false);
    held.resolve(); await closing;
    assert.equal((await f.scheduling.observe(key)).head?.state, 'blocked');
    assert.notEqual(f.deck.getMessages(key).find(message => message.id === 'original-input')?.status, 'failed');
    assert.equal(f.preparations.length, 0);
  } finally { held.resolve(); }
});

for (const mutation of ['none', 'revoke', 'pause', 'revision'] as const)
test(`original scheduler rechecks exact continuation after observation: ${mutation}`, async t => {
  const f = await fixture(t, true);
  let changed = false;
  f.intercept(async kind => {
    if (changed || kind !== 'codexSchedulingObservation') return;
    changed = true;
    if (mutation === 'revoke') await f.owner.command('tokenRevoke', { tokenId: f.actor });
    if (mutation === 'pause') await f.owner.command('maintenancePause', {});
    if (mutation === 'revision') await f.owner.command('codexExecutionTool', { sessionKey: key, connectionId: connection,
      runId: 'original-run', itemId: 'racing-tool', completed: false });
  });
  await f.reconcile();
  assert.equal(f.recoveries.length, mutation === 'none' ? 1 : 0);
  if (mutation === 'none') {
    assert.equal(f.recoveries[0]![2], true);
    assert.equal(f.recoveries[0]![3].headId, 'original-input');
  }
});

test('original scheduler does not replay a durable unknown resume', async t => {
  const f = await fixture(t, true), fact = (await f.scheduling.observe(key)).execution!;
  assert.ok(fact.runId);
  const receipt = await f.owner.command('codexResumePrepare', { expected: { sessionKey: key, commandId: fact.commandId,
    connectionId: fact.connectionId, runId: fact.runId, revision: fact.revision }, nativeConnectionId: 'current-native',
    threadId: 'scheduler-consumer', fingerprint: 'a'.repeat(64), continuation: null });
  assert.ok(receipt); assert.equal(await f.owner.command('codexResumeBegin', receipt), true);
  await f.reconcile();
  assert.equal(f.recoveries.length, 0); assert.equal(f.preparations.length, 0); assert.equal(f.refreshes.length, 0);
  assert.equal((await f.scheduling.observe(key)).outcomeUnknown, true);
  const observed = await f.scheduling.observe(key);
  assert.ok(observed.head);
  assert.equal(await f.scheduling.rejectHead({ sessionKey: key, executionRevision: observed.execution?.revision ?? null,
    headId: observed.head.id, headVersion: observed.head.version }), false, 'unknown resume is not rejection authority');
});

for (const stage of ['turnSessionPage', 'turnRecoveryPage', 'codexSchedulingObservation', 'codexSchedulingRecheck'] as const)
test(`original runtime close drains scheduler ${stage} and cannot fall back after a delayed reply`, async t => {
  const f = await fixture(t), held = deferred(); let waiting = false;
  f.intercept(async kind => { if (kind === stage && !waiting) { waiting = true; await held.promise; } });
  try {
    f.codex.startQueueWorker(); await until(() => waiting);
    let closed = false; const closing = f.codex.close().then(() => { closed = true; });
    await delay(10); assert.equal(closed, false);
    held.resolve(); await closing;
    assert.equal(f.preparations.length, 0); assert.equal(f.recoveries.length, 0);
  } finally { held.resolve(); }
});
