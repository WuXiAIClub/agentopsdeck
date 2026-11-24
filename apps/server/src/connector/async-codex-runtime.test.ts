import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { recordStoppedCodexRecovery } from '../codex/stopped-recovery.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createAsyncCodexRuntime } from './async-codex-runtime.js';
import { registerCodexCreationHttp } from './codex-creation-http.js';
import { ConnectorAgentRuntimes } from './agent-runtimes.js';
import { registerAsyncConnectorAutomation } from './async-automation-http.js';
import { registerCodexCatalogHttp } from './codex-catalog-http.js';
import { registerCodexSettingsHttp } from './codex-settings-http.js';
import { registerCodexDeletionHttp } from './codex-deletion-http.js';
import { registerCodexPublicUsageHttp } from './codex-public-usage-http.js';
import { registerCodexFilesHttp } from './codex-files-http.js';
import { projectionFileEvidence } from '../messages/session-file-evidence.js';
import { loadConfig } from '../config.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { ConnectorUpdateService } from './update-service.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { createAsyncRuntimeMaintenanceInspection } from './async-runtime-maintenance-inspection.js';
import { registerAsyncMaintenanceInspection } from './maintenance-inspection.js';

const authorization = 'Bearer isolated-runtime-token', key = 'codex:original';
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; }

async function fixture(t: TestContext, queued = false, enabled = true, restartedTerminal = false, coldOwnedTerminal = false, restartedUnknown = false, stoppedProof = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-runtime-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json'),
    bootstrapToken: 'isolated-runtime-token', codexBoardTools: false };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  // Opt-in automation authority stays separate from the unchanged bootstrap.
  const automationCredential = tokens.create({ label: 'original automation', scopes: ['automation:manage', 'messages:send'] });
  const catalogCredential = tokens.create({ label: 'original catalog', scopes: ['models:read', 'messages:read'] });
  if (queued || coldOwnedTerminal || restartedUnknown) {
    const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
    try {
      if (restartedUnknown) {
        store.codexExecutions.begin(key, 'original-predecessor', 'previous-connection');
        store.codexExecutions.acknowledge(key, 'original-predecessor', 'previous-connection', 'previous-run', () => {});
      } else if (restartedTerminal || coldOwnedTerminal) {
        store.codexExecutions.begin(key, 'original-predecessor', 'previous-connection');
        store.codexExecutions.acknowledge(key, 'original-predecessor', 'previous-connection', 'previous-run', () => {});
        store.codexExecutions.observe(key, 'previous-connection', 'previous-run', stoppedProof ? 'interrupted' : 'completed');
        if (restartedTerminal) store.codexExecutions.settleNativeHistory(store.codexExecutions.get(key)!, {
          turnId: 'previous-run', fingerprint: '0'.repeat(64), connectionId: 'previous-connection', state: 'blocked', reason: 'restarted',
        });
        if (restartedTerminal) store.codexExecutions.invalidateNativeHistory(key, 'restarted');
      }
      if (stoppedProof) {
        const facts = store.codexExecutions;
        facts.settleHistory(facts.get(key)!, 'error');
        const { sessionKey, commandId, connectionId, runId, revision } = facts.get(key)!;
        const database = (store as any).db;
        database.exec('PRAGMA synchronous=FULL');
        recordStoppedCodexRecovery(database, [{ sessionKey, commandId, connectionId, runId: runId!, revision }], {
          nodeId: store.nodeId, jobId: 'isolated-display-proof', fenceId: 'isolated-stopped-group',
          backupId: 'isolated-display-backup', verifiedAt: Date.now(),
        });
      }
      for (let i = 0; i < (queued ? 2 : 0); i++) await store.turns.enqueueAsync('codex', {
        id: `original-${i}`, sessionKey: key, createdAt: i + 1, state: 'queued',
        payload: { text: `PRIVATE input ${i}`, actorId: actor, images: i ? [{ filePath: 'C:\\workspace\\original.png',
          media: { type: 'image', name: 'original.png', url: '/api/media/inbound/original.png', size: 1, mimeType: 'image/png' } }] : [] },
      });
    } finally { store.close(); }
  }
  const owner = new AsyncConnectorOwner(config, silence); await owner.open();
  const nodeId = await owner.command('nodeIdentity', {});
  let hook: ((kind: string, run: () => Promise<any>) => Promise<any>) | undefined;
  const calls: string[] = [];
  const port = { command: (async (kind: any, input: any) => {
    calls.push(kind); const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const deck = new DeckStore(); deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  let runtime: any;
  const nativeReadyEntered = deferred();
  const originalReady = CodexAppServer.prototype.ready;
  CodexAppServer.prototype.ready = function () {
    runtime = this; nativeReadyEntered.resolve(); return originalReady.call(this);
  };
  const logs: string[] = [];
  const assembled = createAsyncCodexRuntime({ owner: port, deck, nodeId,
    native: { enabled, command: 'must-not-launch', defaultCwd: directory, defaultModel: 'original-model',
      approvalPolicy: 'never', requestTimeoutMs: 100,
      // A JS caller cannot smuggle synchronous handles into the constructor.
      turnQueue: { get() { assert.fail('legacy SQL'); } }, executions: { get() { assert.fail('legacy SQL'); } },
    } as any,
    snapshot: capture => capture('original-cursor'), diagnostics: new PerformanceDiagnostics(line => logs.push(line)), timeoutMs: 2000 });
  t.after(async () => {
    CodexAppServer.prototype.ready = originalReady;
    try { await assembled.close(); } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function begin() {
    const work = assembled.open(); void work.catch(() => {});
    await Promise.race([nativeReadyEntered.promise, work]);
    assert.ok(runtime); CodexAppServer.prototype.ready = originalReady;
    return { work };
  }
  const writes: any[] = [], threadId = randomUUID();
  let onWrite: ((message: any, reply: (result: unknown) => void) => void) | undefined;
  function transport() {
    runtime.connectionId = 'original-connection'; runtime.ensureStarted = async () => {};
    runtime.child = { stdin: { writable: true, write(line: string) {
      const message = JSON.parse(line); writes.push(message);
      const reply = (result: unknown) => runtime.receive(JSON.stringify({ id: message.id, result }));
      if (onWrite) onWrite(message, reply);
      else queueMicrotask(() => reply(message.method === 'thread/start' ? { thread: { id: threadId } }
        : message.method === 'turn/start' ? { turn: { id: 'original-run' } } : {}));
      return true;
    } } };
    runtime.threadRefreshResult.set(key, { at: Date.now(), available: true });
  }
  return { owner, assembled, deck, writes, logs, calls, threadId, nodeId, actor, begin, transport,
    catalogAuthorization: `Bearer ${catalogCredential.token}`,
    automationActor: automationCredential.record.id, automationAuthorization: `Bearer ${automationCredential.token}`,
    runtime: () => runtime,
    intercept(fn: typeof onWrite) { onWrite = fn; },
    hook(fn: typeof hook) { hook = fn; } };
}

for (const joiningCompletion of [false, true]) test(`cold owned transcript hydrates through the real worker journal without settling execution or dispatching queued input (${joiningCompletion ? 'completion-handoff' : 'direct'})`, async t => {
  const f = await fixture(t, true, true, false, true);
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  await (await f.begin()).work; f.transport();
  const native = f.runtime(); native.threadRefreshResult.clear(); native.options.requestTimeoutMs = 2000;
  const path = join(native.options.defaultCwd, 'cold-owned.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta' }) + '\n');
  f.intercept((message, reply) => {
    if (message.method === 'thread/read') reply({ thread: { id: 'original', path, status: { type: 'notLoaded' },
      turns: [{ id: 'previous-run', status: 'completed', itemsView: 'full', items: [
        { id: 'cold-reply', type: 'agentMessage', text: 'Readable cold transcript' },
      ] }] } });
    else if (message.method === 'thread/goal/get') reply({ goal: { threadId: 'original', status: 'active',
      createdAt: 1, updatedAt: 2, objective: 'isolated test', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } });
    else assert.fail('History read must not perform ' + message.method);
  });
  const before = await f.owner.command('codexExecutionRead', { sessionKey: key });
  const pendingBefore = await native.options.nativeJournal.readHistory(key);
  // Startup legitimately projects the two durable queued inputs. Neither is
  // native transcript evidence, and neither may be dispatched by this GET.
  const projectedBefore = f.deck.getMessages(key);
  assert.equal(projectedBefore.length, 2);
  assert.ok(projectedBefore.every((message: any) => message.text.startsWith('PRIVATE input ')));
  const completion = deferred();
  if (joiningCompletion) native.completingTurns.set(key, completion.promise.finally(() => native.completingTurns.delete(key)));
  const refresh = native.refreshSession(key, { readOnly: true });
  try {
    if (joiningCompletion) {
      await tick(); assert.equal(f.writes.length, 0, 'display must wait for the old physical owner');
      completion.resolve();
    }
    await refresh;
  } finally { completion.resolve(); }
  assert.ok(f.deck.getMessages(key).some((message: any) => message.text === 'Readable cold transcript'));
  const display = await native.prepareSessionDisplay(key);
  assert.ok(display); assert.equal(await display.verify(), true);
  assert.deepEqual(await f.owner.command('codexExecutionRead', { sessionKey: key }), before);
  assert.deepEqual(await native.options.nativeJournal.readHistory(key), pendingBefore);
  assert.ok(f.calls.includes('codexFileIndexProjection'), 'publication must pass the original worker CAS');
  assert.ok(!f.calls.some(kind => ['codexResumePrepare', 'codexDispatchClaim', 'codexExecutionRecoverTerminal'].includes(kind)));
  assert.ok(f.writes.every(message => ['thread/read', 'thread/goal/get'].includes(message.method)));
});

for (const checkpoint of [false, true]) test(`stopped proof retains verified cold display through the original worker journal (checkpoint=${checkpoint})`, async t => {
  const f = await fixture(t, true, true, checkpoint, true, false, true);
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  await (await f.begin()).work; f.transport();
  const native = f.runtime(); native.threadRefreshResult.clear(); native.options.requestTimeoutMs = 2000;
  const path = join(native.options.defaultCwd, 'stopped-owned.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta' }) + '\n');
  f.intercept((message, reply) => {
    if (message.method === 'thread/read') reply({ thread: { id: 'original', path, status: { type: 'notLoaded' },
      turns: [{ id: 'previous-run', status: 'interrupted', itemsView: 'full', items: [
        { id: 'stopped-reply', type: 'agentMessage', text: 'Readable stopped transcript' },
      ] }] } });
    else if (message.method === 'thread/goal/get') reply({ goal: null });
    else assert.fail('Read-only stopped history must not perform ' + message.method);
  });
  const before = await native.options.nativeJournal.readHistory(key);
  assert.equal(await native.options.nativeJournal.cleanupRecovered(key, 'previous-run'), true);
  await native.refreshSession(key, { readOnly: true });
  assert.ok(f.deck.getMessages(key).some((message: any) => message.text === 'Readable stopped transcript'));
  const display = await native.prepareSessionDisplay(key);
  assert.ok(display); assert.equal(await display.verify(), true);
  assert.deepEqual(await native.options.nativeJournal.readHistory(key), before);
  assert.ok(!f.calls.some(kind => ['codexResumePrepare', 'codexDispatchClaim', 'codexExecutionRecoverTerminal'].includes(kind)));
  assert.ok(f.writes.every(message => ['thread/read', 'thread/goal/get'].includes(message.method)));
});

test('R20 worker hydrates an initial cold completed history through the real journal without resuming a blocked Goal', async t => {
  const f = await fixture(t, false, true, false, true);
  await (await f.begin()).work; f.transport();
  const native = f.runtime(); native.threadRefreshResult.clear(); native.options.requestTimeoutMs = 2000;
  const path = join(native.options.defaultCwd, 'r20-cold-owned.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 'original' } }) + '\n');
  const thread = { id: 'original', path, status: { type: 'notLoaded' }, canAcceptDirectInput: true,
    turns: [{ id: 'previous-run', status: 'completed', itemsView: 'full', items: [
      { id: 'r20-reply', type: 'agentMessage', text: 'R20 readable completed reply' },
    ] }] };
  f.intercept((message, reply) => {
    if (message.method === 'thread/read') reply({ thread: structuredClone(thread) });
    else if (message.method === 'thread/goal/get') reply({ goal: { threadId: 'original', status: 'blocked',
      createdAt: 1, updatedAt: 2, objective: 'Isolated blocked Goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } });
    else assert.fail('Background history hydration must not perform ' + message.method);
  });
  const before = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(before?.nativeHistory, undefined);
  await native.turnWorker.options.reconcile(key);
  const after = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(after?.runId, before?.runId); assert.equal(after?.commandId, before?.commandId);
  assert.equal(after?.sync, 'current'); assert.equal(after?.nativeHistory?.state, 'blocked');
  assert.equal(after?.nativeHistory?.reason, 'goal-blocked');
  assert.ok(f.deck.getMessages(key).some(message => message.text === 'R20 readable completed reply'));
  const display = await native.prepareSessionDisplay(key);
  assert.ok(display); assert.equal(await display.verify(), true);
  assert.ok(f.writes.every(message => ['thread/read', 'thread/goal/get'].includes(message.method)));
  assert.ok(!f.calls.some(kind => ['codexResumePrepare', 'codexDispatchClaim'].includes(kind)));
});

test('R20 worker recovers a restarted terminal through the real journal without resuming a blocked Goal', async t => {
  const f = await fixture(t, false, true, false, false, true);
  await (await f.begin()).work; f.transport();
  const native = f.runtime(); native.threadRefreshResult.clear(); native.options.requestTimeoutMs = 2000;
  const path = join(native.options.defaultCwd, 'r20-restarted-blocked-goal.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 'original' } }) + '\n');
  const thread = { id: 'original', path, status: { type: 'notLoaded' }, canAcceptDirectInput: true,
    turns: [{ id: 'previous-run', status: 'completed', itemsView: 'full', items: [
      { id: 'r20-restarted-reply', type: 'agentMessage', text: 'R20 restarted blocked goal reply' },
    ] }] };
  f.intercept((message, reply) => {
    if (message.method === 'thread/read') reply({ thread: structuredClone(thread) });
    else if (message.method === 'thread/goal/get') reply({ goal: { threadId: 'original', status: 'blocked',
      createdAt: 1, updatedAt: 2, objective: 'Isolated blocked Goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } });
    else assert.fail('Restarted terminal recovery with blocked Goal must not perform ' + message.method);
  });
  const before = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(before?.phase, 'unknown'); assert.equal(before?.reason, 'restarted');
  assert.equal(before?.sync, 'current'); assert.equal(before?.nativeHistory, undefined);
  await native.turnWorker.options.reconcile(key);
  const after = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(after?.runId, before?.runId); assert.equal(after?.commandId, before?.commandId);
  assert.equal(after?.phase, 'completed');
  assert.equal(after?.sync, 'current'); assert.equal(after?.nativeHistory?.state, 'blocked');
  assert.equal(after?.nativeHistory?.reason, 'goal-blocked');
  assert.ok(f.deck.getMessages(key).some(message => message.text === 'R20 restarted blocked goal reply'));
  const session = f.deck.getSession(key);
  assert.notEqual(session?.runtime?.phase, 'unknown');
  const display = await native.prepareSessionDisplay(key);
  assert.ok(display); assert.equal(await display.verify(), true);
  assert.ok(f.writes.every(message => ['thread/read', 'thread/goal/get'].includes(message.method)));
  assert.ok(f.calls.includes('codexExecutionRecoverTerminal'));
  assert.ok(!f.calls.some(kind => ['codexResumePrepare', 'codexDispatchClaim'].includes(kind)));
});

test('owned file-tool local fence never opens the forbidden legacy execution store', async t => {
  const f = await fixture(t);
  assert.equal(f.assembled.boardToolsAvailable(), false);
  await (await f.begin()).work;
  const native = f.runtime();
  native.options.boardToolsDirectory = '/synthetic/private';
  assert.equal(f.assembled.boardToolsAvailable(), true);
  native.executionUnavailable = true;
  assert.equal(f.assembled.boardToolsAvailable(), false);
  native.executionUnavailable = false;
  await f.assembled.close();
  assert.equal(f.assembled.boardToolsAvailable(), false);
});

test('runtime execution refresh shares startup, maintenance and physical close ownership', async t => {
  const f = await fixture(t);
  await assert.rejects(f.assembled.refreshProjection());
  await (await f.begin()).work; f.transport();
  const lease = f.assembled.pauseQueueWorker(); await lease.drained;
  const gate = deferred(), entered = deferred();
  let blocked = false, closed = false;
  f.hook(async (kind, run) => {
    if (kind === 'executionSessionPage' && !blocked) { blocked = true; entered.resolve(); await gate.promise; }
    return run();
  });
  const work = f.assembled.refreshProjection();
  try {
    await entered.promise;
    const closing = f.assembled.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    await assert.rejects(f.assembled.refreshProjection());
    gate.resolve(); await work; await closing;
    assert.equal(closed, true); assert.equal(f.assembled.status().state, 'closed');
    assert.equal(typeof await f.owner.command('nodeIdentity', {}), 'string');
  } finally { gate.resolve(); await Promise.allSettled([work]); }
});

test('owned deletion HTTP archives once, settles original receipt, and reads it while admission is paused', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  const app = new Hono(); registerCodexDeletionHttp(app, '/sessions/:sessionKey', f.assembled.codexDeletion);
  const path = `/sessions/${encodeURIComponent(key)}`, headers = { authorization, 'idempotency-key': 'archive-once' };
  assert.equal((await app.request(path, { method: 'DELETE', headers })).status, 200);
  assert.equal(f.deck.getSession(key), undefined);
  assert.deepEqual(f.writes.map(rpc => rpc.method), ['thread/archive']);
  assert.equal((await app.request(path, { method: 'DELETE', headers })).status, 200);
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  const view = await app.request(`${path}/deletion-commands/archive-once`, { headers });
  assert.equal(view.status, 200); assert.equal((await view.json()).command.state, 'accepted');
  assert.equal((await app.request(path, { method: 'DELETE', headers })).status, 200);
  assert.equal(f.writes.length, 1); assert.equal(pause.resume(), true);
});

test('runtime public usage stays readable while paused and close drains original snapshot commit', async t => {
  const f = await fixture(t); await (await f.begin()).work;
  const app = new Hono(); registerCodexPublicUsageHttp(app, '/sessions/:sessionKey', f.assembled.codexPublicUsage);
  const path = `/sessions/${key}/token-usage`, headers = { authorization: f.catalogAuthorization }, requestId = randomUUID();
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  for (const suffix of ['?from=0&to=120000&bucketMs=60000', '/export?from=0&to=120000&bucketMs=60000'])
    assert.equal((await app.request(path + suffix, { headers })).status, 200);
  const entered = deferred(), release = deferred();
  f.hook(async (kind, run) => { if (kind === 'codexPublicUsageSnapshotCreate') { entered.resolve(); await release.promise; } return run(); });
  const pending = app.request(path + '/snapshots', { method: 'POST', headers, body: JSON.stringify({ from: 0, to: 120000, bucketMs: 60000, requestId }) });
  await entered.promise;
  try {
    let drained = false; const closing = f.assembled.close().then(() => { drained = true; });
    assert.equal((await pending).status, 503); await tick(); assert.equal(drained, false);
    release.resolve(); await closing;
    const snapshot = await f.owner.command('codexPublicUsageSnapshotRead', { runtime: 'codex', key, authorization: f.catalogAuthorization, requestId });
    assert.ok(!('error' in snapshot)); assert.equal(snapshot.body.requestId, requestId);
    assert.equal((await app.request(path + `/snapshots/${requestId}`, { headers })).status, 503);
  } finally { release.resolve(); }
});

test('runtime file directory stays readable while paused and close drains original rebuild step', async t => {
  const f = await fixture(t); await (await f.begin()).work;
  const expected = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(await f.owner.command('codexFileIndexProjection', { sessionKey: key, expected: expected ?? null,
    evidence: projectionFileEvidence(key, [{ id: 'tool', sessionKey: key, role: 'tool', toolPhase: 'result', status: 'sent', createdAt: 1,
      text: 'PRIVATE', sourceFiles: [{ path: '/original/repo/file.ts', kind: 'modified' }] }]) }), true);
  const app = new Hono(); registerCodexFilesHttp(app, '/sessions/:sessionKey', f.assembled.codexFiles);
  const path = `/sessions/${key}/files`, headers = { authorization: f.catalogAuthorization };
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  const page = await app.request(path, { headers }); assert.equal(page.status, 200); assert.equal((await page.json()).entries.length, 1);
  const start = await app.request(path + '/rebuild', { method: 'POST', headers }); assert.equal(start.status, 200); const job = await start.json();
  const entered = deferred(), release = deferred();
  f.hook(async (kind, run) => { if (kind === 'codexFilesStep') { entered.resolve(); await release.promise; } return run(); });
  const pending = app.request(path + `/rebuild/${job.id}`, { method: 'POST', headers, body: JSON.stringify({ step: 0 }) }); await entered.promise;
  try {
    let drained = false; const closing = f.assembled.close().then(() => { drained = true; });
    assert.equal((await pending).status, 503); await tick(); assert.equal(drained, false);
    release.resolve(); await closing;
    const recovered = await f.owner.command('codexFilesStep', { runtime: 'codex', key, authorization: f.catalogAuthorization, jobId: job.id, step: 0 });
    assert.ok(!('error' in recovered)); assert.equal(recovered.body.state, 'completed');
    assert.equal((await app.request(path, { headers })).status, 503);
  } finally { release.resolve(); }
});

test('owned deletion timeout stays unknown and settles only the original late ACK without another archive', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  f.intercept(() => {});
  const result = await f.assembled.codexDeletion.deletion.remove(key, 'late', authorization);
  assert.ok(!('error' in result)); assert.equal(result.receipt.state, 'outcome_unknown');
  assert.equal(f.deck.getSession(key)?.sessionKey, key); assert.equal(f.writes.length, 1);
  const duplicate = await f.assembled.codexDeletion.deletion.remove(key, 'late', authorization);
  assert.ok(!('error' in duplicate)); assert.equal(duplicate.receipt.state, 'outcome_unknown'); assert.equal(f.writes.length, 1);
  f.runtime().receive(JSON.stringify({ id: f.writes[0].id, result: {} }));
  // Runtime owns the physical ACK, independently of the completed HTTP waiter.
  await Promise.all([...f.runtime().goalAcknowledgementDrains]);
  const view = await f.assembled.codexDeletion.deletion.receipt(key, 'late', authorization);
  assert.ok(!('error' in view)); assert.equal(view.receipt?.state, 'accepted');
  assert.equal(f.deck.getSession(key), undefined); assert.equal(f.writes.length, 1);
});

test('deletion worker begin followed by native activity conservatively stays unknown without archive or Goal idle polling', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  f.hook(async (kind, run) => { const result = await run();
    if (kind === 'codexDeletionBegin') f.runtime().recordNativeActivity('original');
    return result; });
  const result = await f.assembled.codexDeletion.deletion.remove(key, 'observation', authorization);
  assert.ok(!('error' in result)); assert.equal(result.receipt.state, 'outcome_unknown');
  assert.equal(f.writes.length, 0); assert.ok(f.deck.getSession(key));
});

test('deletion preflight local veto releases fence but post-begin local veto cannot authorize another effect', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  f.deck.removeSession(key);
  const before = await f.assembled.codexDeletion.deletion.remove(key, 'missing', authorization);
  assert.ok(!('error' in before)); assert.equal(before.receipt.state, 'rejected'); assert.equal(f.writes.length, 0);
  f.deck.upsertSession({ sessionKey: key, title: 'Original', agentId: 'codex', status: 'idle' });
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'codexDeletionBegin') f.deck.removeSession(key); return result; });
  const after = await f.assembled.codexDeletion.deletion.remove(key, 'post-begin', authorization);
  assert.ok(!('error' in after)); assert.equal(after.receipt.state, 'outcome_unknown'); assert.equal(f.writes.length, 0);
});

test('deletion native ACK without durable acceptance stays unknown and never removes or replays', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  f.hook(async (kind, run) => {
    if (kind === 'codexDeletionAccept') throw new Error('synthetic settlement unavailable');
    return run();
  });
  const failed = await f.assembled.codexDeletion.deletion.remove(key, 'settlement-failed', authorization);
  assert.ok(!('error' in failed)); assert.equal(failed.receipt.state, 'outcome_unknown');
  assert.ok(f.deck.getSession(key)); assert.equal(f.writes.length, 1);
  f.hook(undefined);
  const view = await f.assembled.codexDeletion.deletion.receipt(key, 'settlement-failed', authorization);
  assert.ok(!('error' in view)); assert.equal(view.receipt?.state, 'outcome_unknown');
  const duplicate = await f.assembled.codexDeletion.deletion.remove(key, 'settlement-failed', authorization);
  assert.ok(!('error' in duplicate)); assert.equal(duplicate.receipt.state, 'outcome_unknown');
  assert.ok(f.deck.getSession(key)); assert.equal(f.writes.length, 1);
  // A different command key cannot bypass the original uncertain archive.
  const competing = await f.assembled.codexDeletion.deletion.remove(key, 'new-delete', authorization);
  assert.ok('error' in competing || competing.receipt.state === 'rejected');
  assert.equal(f.writes.length, 1);
});

test('deletion durable acceptance survives projection failure without replay', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  t.mock.method(f.deck, 'removeSession', () => { throw new Error('synthetic projection failure'); });
  const accepted = await f.assembled.codexDeletion.deletion.remove(key, 'projection', authorization);
  assert.ok(!('error' in accepted)); assert.equal(accepted.receipt.state, 'accepted'); assert.ok(f.deck.getSession(key));
  const duplicate = await f.assembled.codexDeletion.deletion.remove(key, 'projection', authorization);
  assert.ok(!('error' in duplicate)); assert.equal(duplicate.receipt.state, 'accepted'); assert.equal(f.writes.length, 1);
});

test('deletion close freezes new effects and drains pending original ACK persistence', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  const entered = deferred(), release = deferred();
  f.hook(async (kind, run) => { if (kind === 'codexDeletionAccept') { entered.resolve(); await release.promise; } return run(); });
  const removing = f.assembled.codexDeletion.deletion.remove(key, 'closing', authorization);
  try {
    await entered.promise;
    assert.ok(f.deck.getSession(key));
    let closed = false; const closing = f.assembled.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    await assert.rejects(f.assembled.codexDeletion.deletion.remove(key, 'new', authorization));
    release.resolve(); await Promise.all([removing, closing]); assert.equal(f.writes.length, 1);
    const receipt = await f.owner.command('codexDeletionReceipt', { key, commandKey: 'closing', authorization });
    assert.ok(!('error' in receipt)); assert.equal(receipt.receipt?.state, 'accepted');
  } finally { release.resolve(); await removing; }
});

test('owned settings HTTP uses original model/thinking writer and worker receipts without native dispatch', async t => {
  const f = await fixture(t), { work } = await f.begin(); await work; f.transport();
  const app = new Hono(); registerCodexSettingsHttp(app, '/sessions/:sessionKey', f.assembled.codexSettings);
  const path = `/sessions/${encodeURIComponent(key)}`, headers = { authorization, 'content-type': 'application/json', 'idempotency-key': 'model-change' };
  const payload = JSON.stringify({ model: 'original-provider-model', thinking: 'high' });
  const changed = await app.request(path, { method: 'PATCH', headers, body: payload });
  assert.equal(changed.status, 200);
  const body = await changed.json() as any;
  assert.deepEqual(body.settings, { model: 'original-provider-model', modelProvider: null, thinkingLevel: 'high' });
  assert.equal(f.deck.getSession(key)?.model, 'original-provider-model'); assert.equal(f.deck.getSession(key)?.thinkingLevel, 'high');
  assert.equal(f.calls.filter(k => k === 'codexSettingsBegin').length, 1);
  assert.equal((await app.request(path, { method: 'PATCH', headers, body: payload })).status, 200);
  assert.equal(f.calls.filter(k => k === 'codexSettingsBegin').length, 1); assert.equal(f.writes.length, 0);
  const reset = await app.request(path, { method: 'PATCH', headers: { ...headers, 'idempotency-key': 'model-reset' }, body: '{"model":null,"thinking":null}' });
  assert.equal(reset.status, 200); assert.equal(f.deck.getSession(key)?.model, 'original-model');
  assert.equal(f.deck.getSession(key)?.thinkingLevel, undefined);
});

for (const closeDuringAck of [false, true]) test(`owned settings model ACK retains current projection fields; close during ACK=${closeDuringAck}`, async t => {
  const f = await fixture(t), { work } = await f.begin(); await work; f.transport();
  const entered = deferred(), release = deferred();
  f.hook(async (kind, run) => { if (kind === 'codexSettingsAccept') { entered.resolve(); await release.promise; } return run(); });
  const changing = f.assembled.codexSettings.settings.change({ authorization, key, commandKey: 'model-change', payloadJson: '{"model":"new-model"}' });
  try {
    await entered.promise;
    f.deck.upsertSession({ ...f.deck.getSession(key)!, title: 'New notification' });
    const project = f.deck.upsertSession.bind(f.deck);
    let projected = false;
    f.deck.upsertSession = session => {
      if (session.sessionKey === key && session.model === 'new-model') {
        assert.equal(session.title, 'New notification'); projected = true;
      }
      return project(session);
    };
    let closed = false; const closing = closeDuringAck ? f.assembled.close().then(() => { closed = true; }) : undefined; await tick();
    assert.equal(closed, false); assert.equal(f.runtime().closed, false);
    release.resolve(); await changing; await closing;
    const receipt = await f.owner.command('codexSettingsReceipt', { authorization, key, commandKey: 'model-change' });
    assert.ok(!('error' in receipt)); assert.equal(receipt.receipt?.state, 'accepted');
    assert.equal(projected, !closeDuringAck, 'ACK must merge the latest view only while publication authority remains open');
  } finally { release.resolve(); await changing; }
});

test('owned catalog uses original native model/skills caches with worker authority on every HTTP delivery', async t => {
  const f = await fixture(t), { work } = await f.begin(); await work; f.transport();
  f.intercept((message, reply) => {
    if (message.method === 'config/read') {
      assert.deepEqual(message.params, { includeLayers: false, cwd: null });
      reply({ config: {} });
    }
    else if (message.method === 'model/list') reply({ data: [{ model: 'native-model', displayName: 'Native Model' }], nextCursor: null });
    else if (message.method === 'thread/read') reply({ thread: { id: message.params.threadId, cwd: tmpdir() } });
    else if (message.method === 'skills/list') reply({ data: [{ cwd: tmpdir(), skills: [], errors: [] }] });
    else assert.fail(`Unexpected native catalog method: ${message.method}`);
  });
  const app = new Hono(); registerCodexCatalogHttp(app, '/connector', f.assembled.codexCatalog);
  const headers = { authorization: f.catalogAuthorization };
  for (let i = 0; i < 2; i++) {
    const models = await app.request('/connector/models/codex', { headers });
    assert.equal(models.status, 200);
    // Configuration defaults are not proof that a model is offered by the
    // current provider. Preserve the native catalog without inventing entries.
    assert.deepEqual(await models.json(), { models: [{ id: 'native-model', label: 'Native Model' }] });
    const skills = await app.request(`/connector/sessions/${key}/skills`, { headers });
    assert.equal(skills.status, 200); assert.deepEqual((await skills.json()).skills, []);
  }
  assert.deepEqual(f.writes.map(message => message.method), ['config/read', 'model/list', 'thread/read', 'skills/list', 'config/read']);
  assert.equal(f.calls.filter(kind => kind === 'codexCatalogAuthorize').length, 4);
  assert.equal(f.calls.filter(kind => kind === 'codexCatalogDeliver').length, 4);
  await f.assembled.close(); const count = f.calls.length;
  assert.equal((await app.request('/connector/models/codex', { headers })).status, 503);
  assert.equal(f.calls.length, count);
  assert.doesNotMatch(f.logs.join('\n'), /isolated-runtime-token|original-connection|PRIVATE/);
});

test('assembly close freezes catalogs but drains original native catalog request before native close', async t => {
  const f = await fixture(t), { work } = await f.begin(); await work; f.transport();
  const entered = deferred(); let reply!: (result: unknown) => void;
  f.intercept((message, respond) => {
    if (message.method === 'config/read') {
      assert.deepEqual(message.params, { includeLayers: false, cwd: null });
      respond({ config: {} });
      return;
    }
    assert.equal(message.method, 'model/list'); reply = respond; entered.resolve();
  });
  const read = f.assembled.codexCatalog.catalog.models({ authorization: f.catalogAuthorization });
  const rejected = assert.rejects(read);
  await entered.promise;
  try {
    let closed = false; const closing = f.assembled.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.runtime().closed, false);
    await assert.rejects(f.assembled.codexCatalog.catalog.models({ authorization: f.catalogAuthorization }));
    reply({ data: [], nextCursor: null }); await rejected; await closing;
    assert.equal(f.runtime().closed, true);
  } finally { reply({ data: [], nextCursor: null }); await rejected; }
});

test('owned interaction port uses original notifications and freezes synchronously while close drains accepted worker reads', async t => {
  const f = await fixture(t), { work } = await f.begin(); await work; f.transport();
  assert.equal(f.assembled.codexInteractions.interactions, f.assembled.interactions);
  f.runtime().nativeQuestionsSupported = true;
  assert.equal(f.assembled.codexInteractions.ready(), true);
  const input = { key, authorization };
  const before = f.deck.latestEventId();
  const mode = await f.assembled.codexInteractions.interactions.mode({ ...input, mode: 'automatic', nativeReady: true });
  assert.ok(mode.ok);
  assert.ok(f.deck.getEventsSince(before).some(event => event.type === 'interaction.updated' && event.sessionKey === key));
  const hold = deferred(), entered = deferred(); let closed = false;
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'codexInteractionObserve') { entered.resolve(); await hold.promise; } return result; });
  const read = f.assembled.codexInteractions.interactions.observe(input);
  try {
    await entered.promise;
    const closing = f.assembled.close(); void closing.then(() => { closed = true; });
    assert.equal(f.assembled.codexInteractions.ready(), false);
    assert.deepEqual(await f.assembled.codexInteractions.interactions.observe(input), { ok: false, error: 503 });
    await tick(); assert.equal(closed, false);
    hold.resolve(); assert.ok((await read).ok); await closing;
    assert.equal(closed, true);
    assert.doesNotMatch(f.logs.join('\n'), /isolated-runtime-token|original-connection|PRIVATE/);
  } finally { hold.resolve(); await read; }
});

test('assembly gates all effects on original startup, strips sync handles and leaves owner closure to parent', async t => {
  const f = await fixture(t, true), gate = deferred(), entered = deferred();
  f.hook(async (kind, run) => { if (kind === 'codexStartupRecover') { entered.resolve(); await gate.promise; } return run(); });
  assert.deepEqual(f.assembled.status(), { state: 'new', available: false });
  assert.equal(f.calls.length, 0); assert.equal('send' in f.assembled, false); assert.equal('createSession' in f.assembled, false);
  const { work } = await f.begin(); await entered.promise;
  try {
    assert.equal(f.assembled.codexMessages.ready(), false);
    assert.equal(f.assembled.codexCreation.ready(), false);
    await assert.rejects(f.assembled.runQueued(key));
    assert.equal(Object.hasOwn(f.runtime().options, 'turnQueue'), false);
    assert.equal(Object.hasOwn(f.runtime().options, 'executions'), false);
    assert.equal(f.writes.length, 0);
  } finally { gate.resolve(); }
  await work;
  assert.equal(f.assembled.status().available, true);
  assert.equal(f.deck.getMessages(key).filter(m => m.status === 'queued').length, 2);
  const closed = f.assembled.close(); assert.equal(f.assembled.close(), closed);
  assert.equal(f.assembled.status().available, false); await closed;
  assert.deepEqual(f.assembled.status(), { state: 'closed', available: false });
  assert.equal(await f.owner.command('codexExecutionRead', { sessionKey: key }), null);
  await assert.rejects(f.assembled.open());
});

test('failed original startup never admits effects; cleanup can still use the original worker', async t => {
  const f = await fixture(t); f.hook(async (kind, run) => {
    if (kind === 'codexStartupRecover') throw Error('isolated startup failure'); return run();
  });
  const { work } = await f.begin(); await assert.rejects(work);
  assert.equal(f.assembled.status().state, 'failed');
  await assert.rejects(f.assembled.runQueued(key)); await f.assembled.close();
  assert.equal(f.writes.length, 0);
  assert.equal(await f.owner.command('codexExecutionRead', { sessionKey: key }), null);
});

for (const lostAck of [false, true]) test(`complete original FIFO, tools and interaction ports; lost native ACK=${lostAck}`, async t => {
  const f = await fixture(t, true); await (await f.begin()).work; f.transport();
  // Isolate turn/start ACK loss from the separately tested cold-resume ACK.
  f.runtime().loadedThreadIds.add('original');
  if (lostAck) f.intercept(() => {});
  assert.equal(await f.assembled.runQueued(key), lostAck ? 'unknown' : 'admitted');
  const turns = f.writes.filter(m => m.method === 'turn/start'); assert.equal(turns.length, 1);
  assert.match(turns[0].params.input[0].text, /PRIVATE input 0[\s\S]*PRIVATE input 1/);
  assert.deepEqual(turns[0].params.input[1], { type: 'localImage', path: 'C:\\workspace\\original.png' });
  assert.ok(f.calls.includes('codexToolsBind')); assert.ok(f.calls.includes('codexInteractionBind'));
  const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(fact?.commandId, 'original-0');
  if (!lostAck) {
    assert.equal(fact?.runId, 'original-run');
    assert.equal(f.deck.getMessages(key).filter(m => m.status === 'sent' && m.turnId === 'original-run').length, 2);
  }
  assert.equal(await f.assembled.runQueued(key), 'not_started');
  assert.equal(f.writes.filter(m => m.method === 'turn/start').length, 1);
  assert.equal(f.logs.some(line => line.includes('PRIVATE input')), false);
});

test('assembled original HTTP creation preserves receipt and never invokes legacy create', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  const app = new Hono(); registerCodexCreationHttp(app, '/api', f.assembled.codexCreation);
  const send = () => app.request('/api/agents/codex/sessions', { method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'Idempotency-Key': 'original-creation' },
    body: JSON.stringify({ title: 'PRIVATE original title' }) });
  const first = await send(); assert.equal(first.status, 201);
  const body = await first.json(); assert.equal(JSON.stringify(body).includes(f.threadId), true);
  const duplicate = await send(); assert.equal(duplicate.status, 201); assert.deepEqual(await duplicate.json(), body);
  assert.deepEqual(f.writes.map(m => m.method), ['thread/start', 'thread/name/set']);
  assert.equal(f.deck.getSession(`codex:${f.threadId}`)?.title, 'PRIVATE original title');
});

test('close drains original native ACK before executor teardown even when public waiter is modified', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  const entered = deferred(); let respond: ((result: unknown) => void) | undefined;
  f.intercept((message, reply) => {
    if (message.method === 'thread/start') { respond = reply; entered.resolve(); }
    else queueMicrotask(() => reply({}));
  });
  const request = { authorization, commandKey: 'closing-creation', payloadJson: JSON.stringify({ title: 'Original' }) };
  const creating = f.assembled.codexCreation.creation.create(request); await entered.promise;
  const physical = Promise.prototype.then.call(creating, (value: unknown) => value);
  Object.defineProperty(creating, 'then', { value: () => Promise.resolve() });
  let closed = false; const closing = f.assembled.close(); void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.runtime().closed, false);
  assert.equal(f.assembled.codexMessages.ready(), false);
  respond!({ thread: { id: f.threadId } }); await physical; await closing;
  assert.equal(f.writes.length, 1, 'closing vetoes naming without replaying the original thread/start');
  assert.equal(await f.owner.command('codexExecutionRead', { sessionKey: key }), null);
  assert.equal(f.assembled.status().state, 'closed');
});

test('original registry pauses fresh execution but retains history and worker maintenance evidence', async t => {
  const f = await fixture(t, true); await (await f.begin()).work;
  const registry = new ConnectorAgentRuntimes([f.assembled]);
  assert.equal(registry.forSession(key), f.assembled);
  assert.equal(f.assembled.owns(key), true);
  assert.equal(f.assembled.owns('hermes:original'), false);
  const original = f.assembled.pauseQueueWorker();
  assert.equal(f.assembled.pauseQueueWorker(), original);
  assert.equal(original.resume(), false);
  await original.drained;
  assert.equal(f.assembled.codexMessages.ready(), false);
  assert.equal(f.assembled.codexCreation.ready(), false);
  await assert.rejects(f.assembled.runQueued(key));
  assert.equal(registry.historyReady(key), false, 'unhydrated history is not proof');
  f.runtime().threadRefreshResult.set(key, { at: Date.now(), available: true });
  assert.equal(registry.historyReady(key), true);
  let checked = 0;
  const observation = await f.assembled.inspectMaintenance(() => { checked++; });
  assert.equal(observation.queuedMessages, 2);
  assert.equal(observation.pendingExecutions, 0);
  assert.equal(observation.activeRuns, 0);
  assert.ok(f.calls.includes('codexMaintenanceObservation'));
  observation.assertCurrent(); assert.ok(checked > 0);
  assert.equal(f.writes.length, 0);
  assert.equal(original.resume(), true);
  assert.equal(original.resume(), false);
  assert.equal(f.assembled.codexMessages.ready(), true);
  const next = registry.pauseQueueWorkers(); await next.drained;
  const closing = registry.close();
  await tick();
  assert.throws(() => observation.assertCurrent());
  assert.equal(next.resume(), false); await closing;
  assert.equal(registry.historyReady(key), false);
});

async function inspectionFixture(t: TestContext) {
  const f = await fixture(t, true); await (await f.begin()).work;
  const lifecycle = await f.owner.command('tokenCreate', { label: 'original lifecycle', scopes: ['connector:lifecycle'] });
  const authority = new AsyncUpdatePersistence(f.owner, f.nodeId, silence);
  const durable = new RuntimeMaintenancePersistence(f.owner, silence);
  const updater = new ConnectorUpdateService(loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(tmpdir(), `inspection-unused-${randomUUID()}.json`) }), authority);
  const inspection = createAsyncRuntimeMaintenanceInspection({ nodeId: f.nodeId, updateService: updater,
    persistence: durable, codex: f.assembled, sdk: [],
    requests: { isStopping: () => false, isPaused: () => false, activeWrites: () => 0 },
    unsupportedNative: () => false, probes: () => 0 });
  const app = new Hono();
  // A broken diagnostics sink must not alter authority, delivery or physical drain.
  const closeHttp = registerAsyncMaintenanceInspection(app, { nodeId: f.nodeId, authority,
    inspect: inspection.inspect, diagnostics: new PerformanceDiagnostics(() => { throw Error('sink unavailable'); }) });
  const headers = { authorization: `Bearer ${lifecycle.token}`, [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.nodeId };
  const request = (extra?: Record<string, string>, signal?: AbortSignal) =>
    app.request(new Request('http://local/api/connector/v1/maintenance/inspection', { headers: { ...headers, ...extra }, ...(signal ? { signal } : {}) }));
  const cleanup = async () => { await closeHttp(); await inspection.close(); await durable.close(); await authority.close(); };
  return { ...f, lifecycle, authority, durable, inspection, app, headers, request, closeHttp, cleanup };
}

test('real worker HTTP lifecycle identity reaches original Codex algorithm and complete durable counts without replay', async t => {
  const f = await inspectionFixture(t), runtime = f.runtime();
  f.transport();
  const child = runtime.child;
  runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
  f.intercept((message, reply) => {
    const { method, params } = message;
    if (method === 'thread/loaded/list') reply({ data: ['parent', 'unprojected-child'], nextCursor: null });
    else if (method === 'thread/list') {
      assert.equal(params.useStateDbOnly, true);
      assert.deepEqual(params.modelProviders, []);
      assert.ok(params.sourceKinds.includes('subAgentThreadSpawn'));
      reply({ data: ['parent', 'unprojected-child'].map(id => ({ id,
        status: { type: id === 'parent' ? 'idle' : 'active' } })), nextCursor: null });
    } else if (method === 'thread/backgroundTerminals/list') reply({ data: params.threadId === 'parent'
      ? [{ processId: 'original-service', itemId: 'service-item' }] : [], nextCursor: null });
    else assert.fail('inspection must never mutate native');
  });
  try {
    const response = await f.request(); assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(result.nodeId, f.nodeId);
    assert.equal(result.nativeVerified, true); assert.equal(result.queuedMessages, 2);
    assert.equal(result.pendingExecutions, 0); assert.equal(result.activeRuns, 1); assert.equal(result.backgroundTerminals, 1);
    assert.equal(Object.hasOwn(result, 'assertCurrent'), false);
    assert.deepEqual(f.writes.map(m => m.method), ['thread/loaded/list', 'thread/list', 'thread/backgroundTerminals/list',
      'thread/backgroundTerminals/list', 'thread/loaded/list']);
    assert.ok(f.calls.includes('codexMaintenanceObservation'));
    assert.equal((await f.owner.command('nodeIdentity', {})), f.nodeId);
  } finally { runtime.child = undefined; runtime.childLifetimes.clear(); await f.cleanup(); }
});

test('only state-only status reads preserve the maintenance epoch; ordinary lists still invalidate it', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  f.intercept((message, reply) => {
    assert.equal(message.method, 'thread/list');
    reply({ data: [], nextCursor: null });
  });
  const runtime = f.runtime(), epoch = runtime.maintenanceEpoch;
  try {
    await runtime.request('thread/list', { useStateDbOnly: true });
    assert.equal(runtime.maintenanceEpoch, epoch);
    await runtime.request('thread/list', { useStateDbOnly: false });
    assert.equal(runtime.maintenanceEpoch, epoch + 1);
    await runtime.request('thread/list', {});
    assert.equal(runtime.maintenanceEpoch, epoch + 2);
  } finally { runtime.child = undefined; }
});

test('async worker HTTP inspection exposes only the fixed error-thread reason and never proves idle', async t => {
  const f = await inspectionFixture(t), runtime = f.runtime();
  f.transport();
  const child = runtime.child;
  runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
  f.intercept((message, reply) => {
    if (message.method === 'thread/loaded/list') reply({ data: ['error-thread'], nextCursor: null });
    else if (message.method === 'thread/list') reply({ data: [{ id: 'error-thread',
      status: { type: 'systemError', message: 'PRIVATE native input /private/path' } }], nextCursor: null });
    else assert.fail('error-thread inspection must not hydrate history or mutate native');
  });
  try {
    const response = await f.request();
    assert.equal(response.status, 503);
    const result = await response.json() as any;
    assert.equal(result.reason, 'native_thread_system_error');
    assert.equal(Object.hasOwn(result, 'nativeVerified'), false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\/path|error-thread/);
  } finally { runtime.child = undefined; runtime.childLifetimes.clear(); await f.cleanup(); }
});

test('async inspection keeps original protocol/node/Origin and lifecycle-only authority gates', async t => {
  const f = await inspectionFixture(t);
  try {
    assert.equal((await f.request({ Origin: 'http://browser' })).status, 403);
    assert.equal((await f.request({ [CONNECTOR_PROTOCOL_HEADER]: '' })).status, 426);
    assert.equal((await f.request({ [EXPECTED_NODE_HEADER]: 'other-node' })).status, 409);
    for (const scopes of [['connector:update'], ['messages:read']] as const) {
      const token = await f.owner.command('tokenCreate', { label: 'not lifecycle', scopes: [...scopes] });
      assert.equal((await f.request({ authorization: `Bearer ${token.token}` })).status, 403);
    }
    assert.equal(f.calls.includes('codexMaintenanceObservation'), false);
    const unsupported = new Hono(); const close = registerAsyncMaintenanceInspection(unsupported, {
      nodeId: f.nodeId, authority: f.authority });
    assert.equal((await unsupported.request('/api/connector/v1/maintenance/inspection', { headers: f.headers })).status, 501);
    await close();
  } finally { await f.cleanup(); }
});

for (const mutation of ['revoke', 'connection ABA', 'abort', 'close'] as const) {
  test(`original worker maintenance read retains physical ownership and rejects ${mutation} during await`, async t => {
    const f = await inspectionFixture(t), held = deferred(), entered = deferred(), controller = new AbortController();
    f.hook(async (kind, run) => {
      if (kind === 'codexMaintenanceObservation') { entered.resolve(); await held.promise; }
      return run();
    });
    const work = f.request(undefined, controller.signal); let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (mutation === 'revoke') await f.owner.command('tokenRevoke', { tokenId: f.lifecycle.record.id });
      if (mutation === 'connection ABA') { f.runtime().setConnection('other'); f.runtime().setConnection(undefined); }
      if (mutation === 'abort') controller.abort();
      if (mutation === 'close') {
        closing = f.closeHttp().then(() => { closed = true; });
        await tick(); assert.equal(closed, false, 'HTTP close waits physical native/durable work, not caller cancellation');
      }
      held.resolve(); const response = await work;
      assert.equal(response.status, mutation === 'revoke' ? 403 : 503);
      assert.doesNotMatch(await response.text(), /PRIVATE|Bearer|original-connection/);
      await closing;
      assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId, 'consumer does not close shared owner');
    } finally { held.resolve(); await Promise.allSettled([work, ...(closing ? [closing] : [])]); await f.cleanup(); }
  });
}

test('final original operator check cannot deliver a native proof invalidated during its worker await', async t => {
  const f = await inspectionFixture(t), app = new Hono(); let invalidate = false;
  const port = { run: ((request: Request, mode: any, action: any) => f.authority.run(request, mode, async operator => {
    const result = await action(operator); invalidate = true;
    await operator.check();
    if (invalidate) f.runtime().maintenanceEpoch++;
    return result;
  })) as AsyncUpdatePersistence['run'] };
  const close = registerAsyncMaintenanceInspection(app, { nodeId: f.nodeId, authority: port, inspect: f.inspection.inspect });
  try {
    const response = await app.request('/api/connector/v1/maintenance/inspection', { headers: f.headers });
    assert.equal(response.status, 503); assert.equal(invalidate, true);
  } finally { await close(); await f.cleanup(); }
});

test('production refresh, model and skills ports preserve original arguments and safe paused access', async t => {
  const f = await fixture(t); await (await f.begin()).work;
  const original = f.runtime(), observed: unknown[] = [];
  original.refreshSession = async (...args: unknown[]) => { observed.push(['session', ...args]); };
  original.refreshSessions = async (...args: unknown[]) => { observed.push(['sessions', ...args]); };
  original.listModels = async () => ['original-model'];
  original.listSessionSkills = async (sessionKey: string) => [{ name: sessionKey }];
  original.recoverMaintenanceHistory = async (sessionKey: string, check: () => void) => { check(); observed.push(['recover', sessionKey]); };
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  const settings = { maxAgeMs: 1500, readOnly: true, fresh: true };
  const refreshing = f.assembled.refreshSession(key, settings); settings.readOnly = false;
  await refreshing; await f.assembled.refreshSessions({ maxAgeMs: 321 });
  assert.deepEqual(await f.assembled.listModels(), ['original-model']);
  assert.deepEqual(await f.assembled.listSessionSkills(key), [{ name: key }]);
  let checks = 0; await f.assembled.recoverMaintenanceHistory(key, () => { checks++; });
  assert.equal(checks, 1);
  assert.deepEqual(observed, [ ['session', key, { maxAgeMs: 1500, readOnly: true, fresh: true }],
    ['sessions', { maxAgeMs: 321 }], ['recover', key] ]);
  assert.equal(f.writes.length, 0);
  assert.equal(pause.resume(), true);
});

test('maintenance lease waits physical creation ACK and cannot be resumed by changing a public promise', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  const entered = deferred(); let respond: ((result: unknown) => void) | undefined;
  f.intercept((message, reply) => {
    if (message.method === 'thread/start') { respond = reply; entered.resolve(); }
    else queueMicrotask(() => reply({}));
  });
  const creating = f.assembled.codexCreation.creation.create({ authorization, commandKey: 'paused-creation',
    payloadJson: JSON.stringify({ title: 'Original' }) });
  const physical = Promise.prototype.then.call(creating, (value: unknown) => value);
  await entered.promise;
  try {
    Object.defineProperty(creating, 'then', { value: () => Promise.resolve() });
    const pause = f.assembled.pauseQueueWorker();
    let drained = false; void pause.drained.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(pause.resume(), false);
    respond!({ thread: { id: f.threadId } }); await physical; await pause.drained;
    assert.equal(f.writes.length, 1, 'pause vetoes naming, not original identity settlement');
    const receipt = await f.assembled.codexCreation.creation.receipt(authorization, 'paused-creation');
    assert.ok('receipt' in receipt && receipt.receipt);
    assert.equal(pause.resume(), true);
    await f.assembled.codexCreation.creation.create({ authorization, commandKey: 'paused-creation',
      payloadJson: JSON.stringify({ title: 'Original' }) });
    assert.equal(f.writes.length, 1, 'original receipt prevents native replay after resume');
  } finally { respond?.({ thread: { id: f.threadId } }); }
});

test('maintenance pause retains existing stop receipt and never replays the interrupt or unlocks execution', async t => {
  const f = await fixture(t, true); await (await f.begin()).work; f.transport();
  f.runtime().loadedThreadIds.add('original');
  assert.equal(await f.assembled.runQueued(key), 'admitted');
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  const request = { authorization, key, commandKey: 'paused-stop',
    payloadJson: JSON.stringify({ message: '/stop', expectedRunId: 'original-run' }) };
  const first = await f.assembled.codexMessages.stop!.stop(request, { timeoutMs: 2000 });
  assert.ok('receipt' in first);
  assert.equal(first.receipt?.state, 'accepted');
  assert.deepEqual(await f.assembled.codexMessages.stop!.stop(request, { timeoutMs: 2000 }), first);
  assert.equal(f.writes.filter(message => message.method === 'turn/interrupt').length, 1);
  const execution = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.ok(execution, 'interrupt ACK without terminal evidence must retain execution protection');
  assert.equal(f.assembled.codexMessages.ready(), false);
  assert.equal(pause.resume(), true);
});

test('maintenance drains already-entered message admission before allowing resume', async t => {
  const f = await fixture(t); await (await f.begin()).work; f.transport();
  const gate = deferred(), entered = deferred();
  f.hook(async (kind, run) => {
    if (kind === 'codexMessageClaim') { entered.resolve(); await gate.promise; }
    return run();
  });
  const sending = f.assembled.codexMessages.messages.send({ authorization, key, commandKey: 'paused-message',
    payloadJson: JSON.stringify({ message: 'Original admission' }) }, { timeoutMs: 2000 });
  try {
    await entered.promise;
    const pause = f.assembled.pauseQueueWorker();
    let drained = false; void pause.drained.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(pause.resume(), false);
    gate.resolve(); await assert.rejects(sending); await pause.drained;
    assert.equal(f.writes.length, 0, 'paused admission cannot launch native work');
    assert.equal(pause.resume(), true);
  } finally { gate.resolve(); await sending.catch(() => {}); }
});

test('original automation HTTP configuration and receipt share the assembled owner through maintenance', async t => {
  const f = await fixture(t); await (await f.begin()).work;
  const app = new Hono(); registerAsyncConnectorAutomation(app, '/api/automation', { configuration: f.assembled.automationConfiguration });
  const request = (path: string, body?: unknown, auth = f.automationAuthorization) => app.request(`/api/automation${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const now = Date.now();
  const input = { kind: 'save', rule: { id: 'original-rule', revision: 1, authorityEpoch: 1,
    target: { ownerId: f.automationActor, connectionId: f.nodeId, runtime: 'codex', sessionId: key }, enabled: false,
    startsAt: now, expiresAt: now + 3600000, maxSends: 2, maxPerHour: 2, minIntervalMs: 60000,
    mode: { kind: 'interval', intervalMs: 60000 } }, template: 'PRIVATE original automation template', expectedRevision: 0, confirmEnable: false };
  assert.equal((await request('', undefined, authorization)).status, 403, 'bootstrap does not gain automation authority');
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  const saved = await request('/configuration/original-config', input); assert.equal(saved.status, 200);
  const receipt = await saved.json();
  assert.deepEqual(await (await request('/configuration/original-config', input)).json(), receipt);
  assert.deepEqual(await (await request('/configuration/original-config')).json(), receipt);
  const view = await (await request('')).json(); assert.equal(view.connectionId, f.nodeId); assert.equal(view.rules.length, 1);
  assert.equal(f.writes.length, 0, 'configuration never dispatches a native effect');
  await f.assembled.close(); assert.equal(pause.resume(), false);
  assert.equal((await request('')).status, 503);
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE|isolated-runtime-token|original automation template/);
});

test('production original FIFO wires blocked-Goal input permission through fresh observation and dispatch', async t => {
  const f = await fixture(t, true); await (await f.begin()).work; f.transport();
  const pause = f.assembled.pauseQueueWorker(); await pause.drained;
  const native = f.runtime(), observed: unknown[][] = [], claims: any[] = [], finishes: unknown[] = [];
  native.observeOwnedQueue = async (...args: unknown[]) => {
    observed.push(args);
    return { connectionId: 'original-connection', blockedGoalInput: args[1], needed: false, predecessor: null };
  };
  native.prepareOwnedCredentials = async (_key: string, text: string) => ({
    connectionId: 'original-connection', text, dispatching() {}, async finish(outcome: unknown) { finishes.push(outcome); },
  });
  // The separate real executor tests prove terminal/child/process/Goal safety.
  // This assembly regression proves production did not omit either permission
  // between that observation and the worker's original-payload dispatch claim.
  native.options.queuedConsumer.options.dispatch.dispatch = async (prepared: any) => {
    claims.push(prepared.claim); return 'not_started';
  };
  assert.equal(pause.resume(), true);
  assert.equal(await native.options.queuedConsumer.run(key), 'not_started');
  assert.deepEqual(observed, [[key, true]]);
  assert.equal(claims.length, 1); assert.equal(claims[0].blockedGoalInput, true);
  assert.deepEqual(claims[0].predecessor, null);
  assert.deepEqual(finishes, ['not_started']); assert.equal(f.writes.length, 0);
});

for (const directoryPolling of [false, true]) test(`production cold restarted blocked Goal reaches original native dispatch without maintenance settlement (directory polling: ${directoryPolling})`, async t => {
  const f = await fixture(t, true, true, true);
  await (await f.begin()).work; f.transport();
  const native = f.runtime();
  native.options.requestTimeoutMs = 2000;
  native.threadRefreshResult.clear();
  native.rolloutReader.validate = async () => {};
  const thread = { id: 'original', status: { type: 'notLoaded' }, canAcceptDirectInput: true,
    turns: [{ id: 'previous-run', status: 'completed', itemsView: 'full',
      items: [{ id: 'previous-answer', type: 'agentMessage', text: 'Previous answer' }] }] };
  const goal = { threadId: 'original', status: 'blocked', createdAt: 1, updatedAt: 2,
    objective: 'PRIVATE original blocked Goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
  f.intercept((message, reply) => {
    if (message.method === 'thread/read') {
      if (directoryPolling) {
        // Exercise real native request accounting while the original cold
        // history proof is in flight, not just a guard in isolation.
        void Promise.all([native.request('thread/list', { limit: 100 }), native.request('model/list', {})])
          .then(() => reply({ thread: structuredClone(thread) }));
      } else reply({ thread: structuredClone(thread) });
    }
    else if (directoryPolling && ['thread/list', 'model/list'].includes(message.method)) reply({ data: [], nextCursor: null });
    else if (message.method === 'thread/goal/get') reply({ goal });
    else if (message.method === 'thread/resume') { thread.status.type = 'idle'; reply({ thread: structuredClone(thread) }); }
    else if (message.method === 'thread/backgroundTerminals/list') reply({ data: [], nextCursor: null });
    else if (message.method === 'turn/start') reply({ turn: { id: 'original-run' } });
    else assert.fail(`Unexpected native method: ${message.method}`);
  });
  for (let attempt = 0; attempt < 3 && !f.writes.some(m => m.method === 'turn/start'); attempt++) {
    await native.turnWorker.options.reconcile(key);
  }
  const starts = f.writes.filter(m => m.method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.match(starts[0].params.input[0].text, /PRIVATE input 0[\s\S]*PRIVATE input 1/);
  assert.equal(f.writes.filter(m => m.method === 'thread/resume').length, 1);
  if (directoryPolling) {
    assert.ok(f.writes.some(m => m.method === 'thread/list'));
    assert.ok(f.writes.some(m => m.method === 'model/list'));
  }
  const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
  assert.equal(fact?.runId, 'original-run');
  assert.equal(fact?.commandId, 'original-0');
  assert.equal(f.deck.getMessages(key).filter(m => m.status === 'sent' && m.turnId === 'original-run').length, 2);
  assert.ok(!f.writes.some(m => ['thread/goal/set', 'thread/goal/clear', 'thread/compact/start', 'thread/rollback'].includes(m.method)));
});

test('one production start coordinates original queue and automation; maintenance fences an entered plan', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t); await (await f.begin()).work;
  const entered = deferred(), gate = deferred(), resumed = deferred(); let blocked = true;
  f.hook(async (kind, run) => {
    const result = await run();
    if (kind === 'automationBackgroundPlan') {
      if (blocked) { blocked = false; entered.resolve(); await gate.promise; }
      else resumed.resolve();
    }
    return result;
  });
  await f.assembled.startWorkers(); await f.assembled.startWorkers();
  t.mock.timers.tick(1000); await entered.promise;
  try {
    const pause = f.assembled.pauseQueueWorker();
    let drained = false; void pause.drained.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(pause.resume(), false);
    gate.resolve(); await pause.drained;
    assert.equal(f.calls.filter(kind => kind === 'automationBackgroundPlan').length, 1);
    t.mock.timers.tick(3000); await tick();
    assert.equal(f.calls.filter(kind => kind === 'automationBackgroundPlan').length, 1);
    assert.equal(f.calls.includes('automationBackgroundPoll'), false);
    assert.equal(pause.resume(), true);
    t.mock.timers.tick(1000);
    // With no rules the real worker has no poll target; the resumed plan is
    // still awaited below via close, never fabricated from a projection.
    await resumed.promise; await f.assembled.close();
    assert.equal(f.calls.filter(kind => kind === 'automationBackgroundStop').length, 1);
    assert.equal(f.writes.length, 0);
    const count = f.calls.length; t.mock.timers.tick(5000); await tick(); assert.equal(f.calls.length, count);
    await assert.rejects(f.assembled.startWorkers());
  } finally { gate.resolve(); }
});

for (const boundary of ['automationConfigurationView', 'automationBackgroundPlan'] as const) {
  test(`close waits physical ${boundary} before closing original native runtime`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = await fixture(t); await (await f.begin()).work;
    const entered = deferred(), gate = deferred();
    f.hook(async (kind, run) => { if (kind === boundary) { entered.resolve(); await gate.promise; } return run(); });
    let physical: Promise<unknown> | undefined;
    if (boundary === 'automationConfigurationView') {
      const visible = f.assembled.automationConfiguration.view({ authorization: f.automationAuthorization });
      physical = Promise.prototype.then.call(visible, () => {}, () => {});
      Object.defineProperty(visible, 'then', { value: () => Promise.resolve() });
    } else { await f.assembled.startWorkers(); t.mock.timers.tick(1000); }
    await entered.promise;
    try {
      let closed = false; const closing = f.assembled.close(); void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false); assert.equal(f.runtime().closed, false);
      await assert.rejects(f.assembled.automationConfiguration.view({ authorization: f.automationAuthorization }));
      gate.resolve(); await physical; await closing;
      assert.equal(f.runtime().closed, true);
      assert.equal(f.calls.filter(kind => kind === 'automationBackgroundStop').length, 1);
    } finally { gate.resolve(); }
  });
}

for (const operation of ['refreshSession', 'refreshSessions', 'listModels', 'listSessionSkills', 'recoverMaintenanceHistory'] as const)
test(`close waits physical ${operation} before executor teardown`, async t => {
  const f = await fixture(t); await (await f.begin()).work;
  const gate = deferred(), entered = deferred();
  f.runtime()[operation] = async () => { entered.resolve(); await gate.promise; };
  const task = operation === 'refreshSession' ? f.assembled.refreshSession(key, { readOnly: true })
    : operation === 'refreshSessions' ? f.assembled.refreshSessions()
    : operation === 'listModels' ? f.assembled.listModels()
    : operation === 'listSessionSkills' ? f.assembled.listSessionSkills(key)
    : f.assembled.recoverMaintenanceHistory(key, () => {});
  const physical = Promise.prototype.then.call(task, () => {});
  await entered.promise;
  try {
    Object.defineProperty(task, 'then', { value: () => Promise.resolve() });
    let closed = false; const closing = f.assembled.close(); void closing.then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.runtime().closed, false);
    await assert.rejects(f.assembled.listModels());
    gate.resolve(); await physical; await closing;
    assert.equal(f.runtime().closed, true);
    assert.throws(() => f.assembled.pauseQueueWorker());
  } finally { gate.resolve(); }
});

test('disabled original runtime keeps directory refresh no-op and never launches native', async t => {
  const f = await fixture(t, true, false); await (await f.begin()).work;
  assert.equal(f.assembled.enabled, false);
  assert.equal(f.assembled.codexMessages.ready(), false);
  await f.assembled.refreshSessions();
  assert.equal(f.assembled.isSessionListReady(), true);
  let checks = 0;
  const observation = await f.assembled.inspectMaintenanceAsync(async () => { checks++; }, () => {});
  assert.equal(observation.activeRuns, 0);
  assert.equal(observation.queuedMessages, 2, 'disabled native still reports original durable work');
  assert.ok(checks >= 3, 'disabled native does not bypass current worker authority');
  observation.assertCurrent();
  assert.ok(f.calls.includes('executionSessionPage'), 'read-only projection is initialized');
  assert.equal(f.calls.includes('codexStartupRecover'), false, 'disabled native never runs execution recovery');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 2);
  assert.equal(f.writes.length, 0);
});
