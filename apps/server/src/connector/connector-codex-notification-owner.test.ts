import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexNotifications } from './async-codex-notifications.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorCodexNotification, validConnectorCodexNotificationInput, validConnectorCodexNotificationOutput } from './connector-codex-notification-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { CodexAppServer, type CodexNativeJournal } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import type { CodexNativeNotification } from '../codex/native-notification.js';
import { projectionFileEvidence } from '../messages/session-file-evidence.js';
import { AsyncUpdatePersistence } from './async-update-persistence.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { registerRequestDrain } from '../lifecycle/request-drain.js';
import { AsyncMaintenanceLifecycle } from './async-maintenance-lifecycle.js';
import { ConnectorUpdateService } from './update-service.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';
import { createAsyncRuntimeProjection } from './async-runtime-projection.js';
import { createAsyncRuntimeMaintenanceInspection } from './async-runtime-maintenance-inspection.js';
import { createAsyncRuntimeMaintenanceProbe } from './async-runtime-maintenance-probe.js';
import { registerAsyncMaintenanceReadiness } from './maintenance-readiness.js';

const key = 'codex:synthetic', connection = 'native-connection';
const event = (changes: Partial<CodexNativeNotification> = {}): CodexNativeNotification => ({ sessionKey: key,
  connectionId: connection, runId: 'native-run', kind: 'item', phase: null, successorItemTurnId: null,
  projectable: true, tool: null, ...changes });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}

test('fixed native notification DTO rejects authority/payload/SQL and invalid identities before owner access', () => {
  const owner = new Proxy({}, { get() { throw Error('must not touch owner'); } }) as ConnectorUserStore;
  assert.equal(validConnectorCodexNotificationInput('codexNativeNotification', event()), true);
  for (const field of ['sql', 'callback', 'authorized', 'replay', 'release', 'params', 'payload', 'actorId']) {
    const forged = { ...event(), [field]: true };
    assert.equal(validConnectorCodexNotificationInput('codexNativeNotification', forged), false);
    assert.throws(() => executeConnectorCodexNotification('codexNativeNotification', forged, owner), /unavailable/);
  }
  for (const changes of [
    { sessionKey: 'claude:wrong' }, { connectionId: 'a'.repeat(129) }, { runId: 'bad\nidentity' },
    { phase: 'running' }, { kind: 'start', phase: null }, { kind: 'goal', successorItemTurnId: 'run' },
    { tool: { id: 'tool', event: 'release' } }, { kind: 'start', phase: 'running', tool: { id: 'tool', event: 'started' } },
  ]) assert.equal(validConnectorCodexNotificationInput('codexNativeNotification', { ...event(), ...changes }), false);
  for (const result of [null, {}, { kind: 'late_tool', invalidate: false, wake: false, execution: null },
    { kind: 'project', invalidate: false, wake: true, execution: null }]) {
    assert.equal(validConnectorCodexNotificationOutput('codexNativeNotification', result), false);
  }
});

async function workerFixture(records = 1, restarted = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-notification-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json') }, logs: any[] = [];
  const seed = new ConnectorUserStore(config.file);
  seed.codexExecutions.begin(key, 'original-command', connection);
  seed.codexExecutions.acknowledge(key, 'original-command', connection, 'native-run', () => {});
  for (let index = 1; index < records; index++) {
    const session = `codex:page-${String(index).padStart(3, '0')}`;
    seed.codexExecutions.begin(session, 'page-command', connection);
    seed.codexExecutions.acknowledge(session, 'page-command', connection, 'page-run', () => {});
    seed.codexExecutions.observe(session, connection, 'page-run', 'completed');
    seed.codexExecutions.settleNativeHistory(seed.codexExecutions.get(session)!, {
      turnId: 'page-run', connectionId: connection, fingerprint: 'a'.repeat(64), state: 'verified', reason: 'settled' });
  }
  if (restarted) seed.codexExecutions.recoverInterrupted();
  seed.close(); // Only one physical owner of this original file.
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const owner = new AsyncConnectorOwner(config, diagnostics);
  await owner.open();
  const notifications = new AsyncCodexNotifications(owner);
  return { directory, owner, notifications, logs, config, diagnostics,
    async close() { await owner.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('original metadata port physically commits a large UTF-8 window and close drains before reopening the sole file', async () => {
  const f = await workerFixture(), projection = new AsyncCodexProjection({ owner: f.owner, deck: new DeckStore(), bind: false,
    connectionId: () => connection });
  try {
    await projection.open();
    const expected = await f.owner.command('codexExecutionRead', { sessionKey: key });
    const evidence = projectionFileEvidence(key, Array.from({ length: 1100 }, (_, i) => ({
      id: `${i}:${'用'.repeat(1300)}`, sessionKey: key, role: 'tool' as const, toolPhase: 'result' as const,
      status: 'sent' as const, createdAt: i, text: 'PRIVATE_LARGE_BODY',
      sourceFiles: [{ path: `/workspace/${i}.ts`, kind: 'modified' as const }],
    })));
    assert.ok(!('invalid' in evidence));
    assert.ok(evidence.index.limited && evidence.snapshot.limited);
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) > 4 * 1024 * 1024, 'must exercise the separate large-input reservation');
    const committing = projection.nativeJournal().fileIndexProjection({ sessionKey: key, expected, evidence });
    await projection.close();
    assert.equal(await committing, true);
    await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      assert.equal(reopened.fileIndex.page(key).retained?.count, evidence.index.rows.length);
      const retained: typeof evidence.snapshot.rows = [];
      let cursor: string | undefined;
      do {
        const page = reopened.fileIndex.projectionEvidencePage(key, cursor);
        retained.unshift(...page.messages.flatMap(message => message.sourceFiles!.map(file => ({
          ...file, messageId: message.id, createdAt: message.createdAt,
        })))); cursor = page.before;
      } while (cursor);
      assert.deepEqual(retained, evidence.snapshot.rows);
      assert.deepEqual(reopened.codexExecutions.get(key), expected, 'metadata commit must not change execution protection');
    } finally { reopened.close(); }
    assert.ok(f.logs.some(log => log.step === 280));
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_LARGE_BODY|用|\/workspace\//);
  } finally { await projection.close(); await f.close(); }
});

test('original metadata port commits the full row-limited history without invalidating execution facts', async () => {
  const fixture = await workerFixture();
  const projection = new AsyncCodexProjection({ owner: fixture.owner, deck: new DeckStore(), bind: false,
    connectionId: () => connection });
  try {
    await projection.open();
    const expected = await fixture.owner.command('codexExecutionRead', { sessionKey: key });
    const evidence = projectionFileEvidence(key, Array.from({ length: 10_001 }, (_, index) => ({
      id: `file:${index}`, sessionKey: key, role: 'tool' as const, toolPhase: 'result' as const,
      status: 'sent' as const, createdAt: index, text: 'PRIVATE_HISTORY_BODY',
      sourceFiles: [{ path: `/workspace/${index}.ts`, kind: 'modified' as const }],
    })));
    assert.ok(!('invalid' in evidence));
    assert.equal(evidence.index.rows.length, 4000);
    assert.equal(evidence.snapshot.rows.length, 10_000);
    assert.equal(await projection.nativeJournal().fileIndexProjection({ sessionKey: key, expected, evidence }), true);
    assert.equal(projection.status().unavailable, false);
    assert.deepEqual(await fixture.owner.command('codexExecutionRead', { sessionKey: key }), expected);
    await projection.close();
    await fixture.owner.close();
    const reopened = new ConnectorUserStore(fixture.config.file);
    try {
      assert.equal(reopened.fileIndex.page(key).retained?.count, 4000);
      const retained: typeof evidence.snapshot.rows = [];
      let cursor: string | undefined;
      do {
        const page = reopened.fileIndex.projectionEvidencePage(key, cursor);
        retained.unshift(...page.messages.flatMap(message => message.sourceFiles!.map(file => ({
          ...file, messageId: message.id, createdAt: message.createdAt,
        }))));
        cursor = page.before;
      } while (cursor);
      assert.deepEqual(retained, evidence.snapshot.rows);
      assert.deepEqual(reopened.codexExecutions.get(key), expected);
    } finally { reopened.close(); }
    assert.doesNotMatch(JSON.stringify(fixture.logs), /PRIVATE_HISTORY_BODY|\/workspace\//);
  } finally { await projection.close(); await fixture.close(); }
});

test('real owner settles full native lifecycle/tool chain, drains close and persists identity without replay', async () => {
  const f = await workerFixture();
  try {
    assert.equal((await f.notifications.settle(event({ tool: { id: 'command-tool', event: 'started' } }))).kind, 'project');
    const completed = await f.notifications.settle(event({ kind: 'complete', phase: 'completed' }));
    assert.equal(completed.kind, 'project'); assert.equal(completed.execution?.phase, 'running');
    assert.equal((await f.notifications.settle(event({ tool: { id: 'late-tool', event: 'started' } }))).kind, 'late_tool');
    assert.equal((await f.notifications.settle(event({ tool: { id: 'late-tool', event: 'started' } }))).kind, 'ignore');
    assert.equal((await f.notifications.settle(event({ runId: 'different', tool: { id: 'foreign-tool', event: 'started' } }))).kind, 'ignore');
    const physical = f.notifications.settle(event({ tool: { id: 'late-tool', event: 'completed' } }));
    await f.owner.close(); await physical;
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      const fact = reopened.codexExecutions.get(key)!;
      assert.equal(fact.commandId, 'original-command'); assert.equal(fact.runId, 'native-run');
      assert.equal(fact.phase, 'completed'); assert.deepEqual(fact.pendingCommandTools, ['command-tool', 'late-tool']);
      assert.equal(reopened.codexExecutions.canStart(key), false);
    } finally { reopened.close(); }
    assert.ok(f.logs.some(log => log.step === 217));
    assert.doesNotMatch(JSON.stringify(f.logs), /original-command|native-run|native-connection|late-tool|command-tool/);
  } finally { await f.close(); }
});

/** Actual receiver with complete owned ports and no secondary SQL handles.
 * This deliberately does NOT certify the entire production composition root. */
async function receiverFixture(records = 1, restarted = false) {
  const f = await workerFixture(records, restarted);
  const store = new DeckStore();
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original receiver', status: 'running' });
  let runtime: any;
  const projection = new AsyncCodexProjection({ owner: f.owner, deck: store, bind: false,
    connectionId: () => runtime?.connectionId });
  const journal: CodexNativeJournal = projection.nativeJournal();
  // This receiver harness starts at an already ACKed live connection. Running
  // restart recovery here would deliberately retire that live fixture fact.
  // Real recovery/queue bootstrap is covered by the dedicated startup suite.
  const startup = { open: () => projection.open(), close: async () => {} };
  const scheduling = new AsyncCodexScheduling(f.owner);
  const queuedConsumer = new AsyncCodexQueue({ owner: f.owner,
    local() { assert.equal(runtime.closed, false); },
    dispatch: { async dispatch() { assert.fail('notification fixture cannot dispatch native'); } },
    async prepare() { return null; } });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: f.directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store,
    nativeJournal: journal, startup, scheduling, queuedConsumer, historyReader: new AsyncCodexHistory(f.owner),
    credentialExecutionReader: new AsyncConnectorExecutionReads(f.owner).codex,
    authorizeTurn() { assert.fail('notification fixture cannot authorize on host'); } });
  runtime = codex as any;
  const close = async () => {
    try { await codex.close(); }
    finally { try { await queuedConsumer.close(); }
      finally { try { await projection.close(); } finally { await f.close(); } } }
  };
  try {
    await codex.ready();
    runtime.setConnection(connection);
    await runtime.nativeObservations.drain();
    assert.equal(runtime.executionUnavailable, false, 'initial connection must use the constructor journal, not a legacy fallback');
  } catch (error) {
    // A failed startup must not strand a worker and hide the actual assertion
    // behind a process-level test timeout.
    await close();
    throw error;
  }
  const receive = (method: string, item?: unknown) => runtime.receive(JSON.stringify({ method,
    params: { threadId: 'synthetic', turnId: 'native-run', ...(item ? { item } : {}) } }));
  return { ...f, codex, runtime, journal, store, receive, projection, close };
}

test('worker-owned assistant completion projects through the original journal without synchronous executions', async () => {
  const f = await receiverFixture();
  try {
    f.receive('item/completed', { id: 'assistant-reply', type: 'agentMessage', text: 'Worker-owned reply', phase: 'final_answer' });
    await f.runtime.nativeObservations.drain();
    await Promise.all(f.runtime.assistantProjections.get(key) ?? []);
    const reply = f.store.getMessages(key).find(message => message.role === 'assistant');
    assert.equal(reply?.text, 'Worker-owned reply');
    assert.equal(reply?.turnId, 'native-run');
    assert.equal(reply?.status, 'sent');
    assert.equal(f.runtime.executionUnavailable, false);
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.commandId, 'original-command');
    assert.equal(fact?.phase, 'running', 'message projection must never certify execution completion');
  } finally { await f.close(); }
});

for (const boundary of ['projector', 'journal-read'] as const) {
  for (const mode of ['replacement', 'aba', 'close'] as const) {
    test(`worker-owned assistant completion rejects stale ${boundary} after ${mode}`, async () => {
      const f = await receiverFixture(), hold = deferred(), entered = deferred();
      let closing: Promise<void> | undefined;
      if (boundary === 'projector') f.runtime.options.projectAssistant = async (text: string) => {
        entered.resolve(); await hold.promise; return { text, media: [] };
      };
      else {
        const read = f.journal.readExecution;
        f.journal.readExecution = async (sessionKey: string) => {
          const original = await read(sessionKey);
          entered.resolve(); await hold.promise; return original;
        };
      }
      try {
        f.receive('item/completed', { id: 'stale-reply', type: 'agentMessage', text: 'Must not publish' });
        await entered.promise;
        if (mode === 'close') closing = f.codex.close();
        else {
          f.runtime.setConnection('replacement');
          if (mode === 'aba') f.runtime.setConnection(connection);
        }
        hold.resolve();
        await f.runtime.nativeObservations.drain();
        await Promise.all(f.runtime.assistantProjections.get(key) ?? []);
        await closing;
        assert.equal(f.store.getMessages(key).length, 0, 'late callback cannot alter replacement or closed projection');
      } finally { hold.resolve(); await closing; await f.close(); }
    });
  }
}

function completedHistory(f: Awaited<ReturnType<typeof receiverFixture>>, successor = false, files = false, includeUser = false) {
  // This fixture already owns an initialized synthetic connection. Never launch
  // a real native process when exercising the original refresh/recovery chain.
  f.runtime.ensureStarted = async () => {};
  const path = join(f.directory, 'rollout.jsonl');
  writeFileSync(path, '');
  const turn = { id: 'native-run', status: 'completed', items: [
    ...(includeUser ? [{ type: 'userMessage', id: 'original-user', content: [{ type: 'text', text: 'Original question' }] }] : []),
    { type: 'agentMessage', id: 'final', text: 'Done', phase: 'final_answer' },
    ...(files ? [{ type: 'fileChange', id: 'file-result', status: 'completed', changes: [
      { path: '/workspace/owned.ts', kind: { type: 'update' }, diff: 'PRIVATE_FILE_DIFF' },
      { path: 'C:\\workspace\\owned.ts', kind: { type: 'add' }, diff: 'PRIVATE_WINDOWS_DIFF' },
    ] }] : []),
  ] };
  f.runtime.request = async (method: string) => {
    if (method === 'thread/read') return { thread: { id: 'synthetic', path,
      status: { type: successor ? 'active' : 'idle' }, canAcceptDirectInput: true,
      turns: [turn, ...(successor ? [{ id: 'successor', status: 'inProgress', items: [] }] : [])] } };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/goal/get') return { goal: successor ? { threadId: 'synthetic', status: 'active',
      createdAt: 1, updatedAt: 2, objective: 'Continue', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } : null };
    assert.fail(`unexpected native effect: ${method}`);
  };
  return async () => {
    f.runtime.receive(JSON.stringify({ method: 'turn/completed', params: { threadId: 'synthetic', turn } }));
    await f.runtime.nativeObservations.drain();
    await f.runtime.completingTurns.get(key);
  };
}

/** Original full worker/executor chain; only native stdin/stdout is synthetic.
 * Unlike request mocks this runs the real awaited/final transport guards. */
async function maintenanceRecoveryFixture(includeUser = false) {
  const f = await receiverFixture();
  const nodeId = await f.owner.command('nodeIdentity', {});
  const actor = await f.owner.command('tokenCreate', { label: 'recovery', scopes: ['connector:lifecycle'] });
  let afterCommand: ((kind: string, input: any, output: unknown) => Promise<void>) | undefined;
  const command: AsyncConnectorOwner['command'] = async (kind, input) => {
    const output = await f.owner.command(kind, input);
    await afterCommand?.(kind, input, output);
    return output;
  };
  const authority = new AsyncUpdatePersistence({ command }, nodeId);
  const generation = await f.owner.command('maintenancePause', {});
  await f.owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection,
    runId: 'native-run', phase: 'completed', expected: null });
  const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
  await f.owner.command('codexHistoryCompareSettle', { expected: fact, sync: 'error' });
  completedHistory(f, false, false, includeUser);
  const response = f.runtime.request;
  const writes: string[] = [];
  let loaded = false;
  let beforeReply: ((method: string) => Promise<void>) | undefined;
  f.runtime.request = (CodexAppServer.prototype as any).request;
  f.runtime.child = { stdin: { writable: true, write(line: string) {
    const rpc = JSON.parse(line); writes.push(rpc.method);
    void (async () => {
      if (beforeReply) await beforeReply(rpc.method);
      if (rpc.method === 'thread/resume') loaded = true;
      const result = rpc.method === 'thread/loaded/list' ? { data: loaded ? ['synthetic'] : [] }
        : rpc.method === 'thread/list' ? { data: [(await response('thread/read')).thread] }
        : await response(rpc.method === 'thread/resume' ? 'thread/read' : rpc.method);
      if (result.thread) result.thread.status.type = loaded ? 'idle' : 'notLoaded';
      f.runtime.receive(JSON.stringify({ id: rpc.id, result }));
    })().catch(error => {
      f.runtime.receive(JSON.stringify({ id: rpc.id, error: { code: -32000, message: String(error) } }));
    });
    return true;
  } } };
  // Model one physical owned transport, not a fabricated native-idle proof.
  // The original inspection still enumerates its loaded threads and terminals.
  f.runtime.childLifetimes.set(f.runtime.child, { closed: Promise.resolve(), stopRequested: false });
  const request = (signal?: AbortSignal) => new Request('http://local/maintenance', { ...(signal ? { signal } : {}), headers: {
    authorization: `Bearer ${actor.token}`, [EXPECTED_NODE_HEADER]: nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' } });
  return { ...f, actor, authority, generation, writes, request,
    beforeReply(callback: (method: string) => Promise<void>) { beforeReply = callback; },
    afterCommand(callback: NonNullable<typeof afterCommand>) { afterCommand = callback; },
    async close() { await authority.close(); f.runtime.childLifetimes.clear(); f.runtime.child = undefined; await f.close(); } };
}

test('complete async readiness holds the original maintenance lock through worker recovery and original frontend proof', async () => {
  const f = await maintenanceRecoveryFixture(true), app = new Hono();
  const requests = registerRequestDrain(app, { writesOnRead: true, isControl: request =>
    request.method === 'POST' && new URL(request.url).pathname === '/api/connector/v1/maintenance/readiness' });
  const lifecycle = new AsyncMaintenanceLifecycle(f.owner, [() => requests.pauseWrites()]);
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(f.directory, 'update.json') });
  const updates = new ConnectorUpdateService(config, f.authority);
  updates.bindAsyncMaintenanceLifecycle(lifecycle.pause);
  const persistence = new RuntimeMaintenancePersistence(f.authority.maintenance);
  const projection = createAsyncRuntimeProjection([() => f.projection.project(key)]);
  let probe!: ReturnType<typeof createAsyncRuntimeMaintenanceProbe>;
  const inspection = createAsyncRuntimeMaintenanceInspection({ nodeId: f.authority.nodeId, updateService: updates,
    persistence, codex: f.codex, sdk: [], requests, unsupportedNative: () => false, probes: () => probe.probes() });
  probe = createAsyncRuntimeMaintenanceProbe({ nodeId: f.authority.nodeId, revision: () => 'a'.repeat(40), requests,
    unsupportedNative: () => false, codex: f.codex, sdk: [], projection, deck: f.store, persistence,
    inspect: inspection.inspect, resumes: local => f.authority.maintenanceResumes(f.journal, local) });
  const readiness = registerAsyncMaintenanceReadiness(app, { nodeId: f.authority.nodeId, authority: f.authority,
    updateService: updates, probe: probe.probe });
  try {
    const pause = await f.authority.run(f.request(), 'maintenance', operator =>
      updates.changeMaintenance(operator.actorId, 'pause', 'original-pause', undefined, operator.check));
    assert.equal(pause.state, 'accepted');
    const fence = await f.authority.run(f.request(), 'readiness', operator => updates.maintenanceStatus(operator.check));
    const result = await app.request('/api/connector/v1/maintenance/readiness', { method: 'POST',
      headers: { ...Object.fromEntries(f.request().headers), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: key, fenceId: fence.fenceId }) });
    const body = await result.json() as any;
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.equal(body.businessReadVerified, true); assert.equal(body.fenceId, fence.fenceId);
    assert.equal(body.preservation.execution.commandId, 'original-command');
    assert.equal(body.preservation.execution.runId, 'native-run');
    assert.equal(body.preservation.execution.sync, 'current');
    assert.equal(f.writes.filter(method => method === 'thread/resume').length, 1);
    assert.ok(f.writes.includes('thread/loaded/list')); assert.ok(f.writes.includes('thread/list'));
    assert.equal(requests.isPaused(), true); assert.equal(probe.probes(), 0);
    assert.doesNotMatch(JSON.stringify(body), /Original question|Done|Bearer/);
  } finally {
    await readiness.close(); await probe.close(); await inspection.close(); await projection.close();
    await persistence.close(); await lifecycle.close(); await f.close();
  }
});

test('full original maintenance recovery uses current worker identity, sole resume journal and frontend history', async () => {
  const f = await maintenanceRecoveryFixture();
  try {
    let checks = 0;
    await f.authority.run(f.request(), 'readiness', async operator => {
      await f.codex.recoverMaintenanceHistoryAsync(key, {
        authorize: async () => { checks++; await operator.check(); }, local() {},
        resumes: f.authority.maintenanceResumes(f.journal, () => {}),
      });
    });
    assert.equal(f.writes.filter(method => method === 'thread/resume').length, 1);
    assert.ok(checks > f.writes.length, 'initial/final and every original RPC use current worker authority');
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    assert.equal(fact.sync, 'current'); assert.equal(fact.commandId, 'original-command'); assert.equal(fact.runId, 'native-run');
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, false);
    assert.ok(f.store.getMessages(key).some(message => message.role === 'assistant' && message.text === 'Done'));
    assert.equal(await f.owner.command('maintenanceResume', { generation: f.generation }), true);
    assert.doesNotMatch(JSON.stringify(f.logs), /Bearer|original-command|native-run/);
  } finally { await f.close(); }
});

for (const stage of ['codexResumePrepare', 'codexResumeBegin'] as const)
for (const change of ['abort', 'revoke'] as const)
test(`maintenance recovery retains ${stage} receipt after late ${change} and settles without native replay`, async () => {
  const f = await maintenanceRecoveryFixture(), controller = new AbortController();
  try {
    let handedOff = false;
    f.afterCommand(async (kind, input, output) => {
      if (kind !== 'runtimeMaintenanceResumeAuthorized' || input.kind !== stage) return;
      assert.equal((output as any).status, 200); handedOff = true;
      if (change === 'abort') controller.abort();
      else await f.owner.command('tokenRevoke', { tokenId: f.actor.record.id });
    });
    await assert.rejects(f.authority.run(f.request(controller.signal), 'readiness', operator =>
      f.codex.recoverMaintenanceHistoryAsync(key, { authorize: operator.check, local() {},
        resumes: f.authority.maintenanceResumes(f.journal, () => {}) })));
    assert.equal(handedOff, true);
    assert.equal(f.writes.includes('thread/resume'), false);
    const observation = await f.owner.command('codexHistoryObservation', { sessionKey: key });
    assert.equal(observation.outcomeUnknown, false, 'known prewrite uses the original not_dispatched receipt');
    assert.equal(observation.execution?.runId, 'native-run');
    assert.equal(observation.execution?.sync, 'error', 'denied recovery cannot certify current history');
  } finally { await f.close(); }
});

test('maintenance recovery settles an actual resume ACK after revocation but cannot deliver private history', async () => {
  const f = await maintenanceRecoveryFixture();
  try {
    f.beforeReply(async method => {
      if (method === 'thread/resume') await f.owner.command('tokenRevoke', { tokenId: f.actor.record.id });
    });
    await assert.rejects(f.authority.run(f.request(), 'readiness', operator =>
      f.codex.recoverMaintenanceHistoryAsync(key, { authorize: operator.check, local() {},
        resumes: f.authority.maintenanceResumes(f.journal, () => {}) })));
    assert.equal(f.writes.filter(method => method === 'thread/resume').length, 1);
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, false,
      'original ACK settlement must not depend on a new operator check');
  } finally { await f.close(); }
});

for (const failure of ['native-ack', 'finish-ack'] as const)
test(`maintenance recovery retains unknown ${failure} and refuses another native resume`, async () => {
  const f = await maintenanceRecoveryFixture();
  try {
    if (failure === 'native-ack') f.beforeReply(async method => {
      if (method === 'thread/resume') throw Error('synthetic unconfirmed native response');
    });
    const journal = failure === 'finish-ack' ? { ...f.journal,
      finishResume: async () => { throw Error('synthetic unconfirmed settlement'); } } : f.journal;
    const recover = () => f.authority.run(f.request(), 'readiness', operator =>
      f.codex.recoverMaintenanceHistoryAsync(key, { authorize: operator.check, local() {},
        resumes: f.authority.maintenanceResumes(journal, () => {}) }));
    await assert.rejects(recover());
    assert.equal(f.writes.filter(method => method === 'thread/resume').length, 1);
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, true);
    await assert.rejects(recover());
    assert.equal(f.writes.filter(method => method === 'thread/resume').length, 1, 'unknown native effects must never be replayed');
  } finally { await f.close(); }
});

for (const change of ['revoke', 'abort', 'connection-aba'] as const)
test(`awaited maintenance recovery blocks native writes on ${change} and preserves original terminal`, async () => {
  const f = await maintenanceRecoveryFixture(), controller = new AbortController();
  try {
    await assert.rejects(f.authority.run(f.request(controller.signal), 'readiness', async operator => {
      let checks = 0;
      await f.codex.recoverMaintenanceHistoryAsync(key, { local() {}, resumes: f.authority.maintenanceResumes(f.journal, () => {}),
        authorize: async () => {
          checks++;
          if (checks === 2) {
            if (change === 'revoke') await f.owner.command('tokenRevoke', { tokenId: f.actor.record.id });
            if (change === 'abort') controller.abort();
            if (change === 'connection-aba') f.runtime.nativeConnectionGeneration++;
          }
          await operator.check();
        },
      });
    }));
    assert.deepEqual(f.writes, []);
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    assert.equal(fact.commandId, 'original-command'); assert.equal(fact.runId, 'native-run'); assert.notEqual(fact.sync, 'current');
    assert.equal(f.runtime.executionUnavailable, false);
  } finally { await f.close(); }
});

test('maintenance recovery close drains the real awaited worker authorization even when caller hides then', async () => {
  const f = await maintenanceRecoveryFixture(), entered = deferred(), release = deferred();
  try {
    const action = f.authority.run(f.request(), 'readiness', async operator => {
      let checks = 0;
      const recovery = f.codex.recoverMaintenanceHistoryAsync(key, { local() {}, resumes: f.authority.maintenanceResumes(f.journal, () => {}),
        authorize: async () => { if (++checks === 2) { entered.resolve(); await release.promise; } await operator.check(); } });
      Object.defineProperty(recovery, 'then', { value: undefined });
      await recovery;
    });
    const rejected = assert.rejects(action);
    await entered.promise;
    let closed = false;
    const closing = f.codex.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.deepEqual(f.writes, []);
    release.resolve(); await rejected; await closing;
    assert.equal(closed, true); assert.deepEqual(f.writes, []);
  } finally { release.resolve(); await f.close(); }
});

async function persistedFileIndex(f: Awaited<ReturnType<typeof receiverFixture>>) {
  // Reopen only AFTER physical owner close, never beside a second writer.
  await f.codex.close(); await f.projection.close(); await f.owner.close();
  const reopened = new ConnectorUserStore(f.config.file);
  try { return { page: reopened.fileIndex.page(key), snapshot: reopened.fileIndex.projectionEvidencePage(key) }; }
  finally { reopened.close(); }
}

for (const entry of ['refresh', 'final'] as const)
test(`original ${entry} persists Linux/Windows file evidence through sole owner and original reopen`, async () => {
  const f = await receiverFixture();
  const original = f.owner.command.bind(f.owner), inputs: unknown[] = [];
  f.owner.command = (async (kind: any, input: any) => {
    if (kind === 'codexFileIndexProjection') inputs.push(structuredClone(input));
    return original(kind, input);
  }) as typeof f.owner.command;
  try {
    const complete = completedHistory(f, false, true);
    if (entry === 'refresh') await f.codex.refreshSession(key, { fresh: true });
    else await complete();
    await f.runtime.nativeObservations.drain(); await f.runtime.completingTurns.get(key);
    assert.equal(f.runtime.executionUnavailable, false);
    assert.ok(inputs.length > 0);
    assert.doesNotMatch(JSON.stringify(inputs), /PRIVATE_.*DIFF|Done|changes|toolPreview/);
    assert.ok(f.logs.some(log => log.step === 280));
    assert.doesNotMatch(JSON.stringify(f.logs), /owned\.ts|PRIVATE_.*DIFF/);
    const result = await persistedFileIndex(f);
    assert.deepEqual(result.page.entries.map(e => e.path).sort(), ['/workspace/owned.ts', 'C:\\workspace\\owned.ts'].sort());
    assert.equal(result.snapshot.messages.flatMap(m => m.sourceFiles ?? []).length, 2);
    assert.ok(result.snapshot.messages.every(m => m.text === ''));
  } finally { await f.close(); }
});

for (const mutation of ['cas', 'generation', 'close'] as const)
test(`original history metadata await fences stale publication and physically drains: ${mutation}`, { timeout: 15_000 }, async () => {
  const f = await receiverFixture(), entered = deferred(), hold = deferred();
  const original = f.owner.command.bind(f.owner);
  let once = false;
  f.owner.command = (async (kind: any, input: any) => {
    if (kind === 'codexFileIndexProjection' && !once) { once = true; entered.resolve(); await hold.promise; }
    return original(kind, input);
  }) as typeof f.owner.command;
  let refresh: Promise<unknown> | undefined;
  try {
    completedHistory(f, false, true);
    refresh = f.codex.refreshSession(key, { fresh: true }).catch(() => {});
    await entered.promise;
    let closed = false, closing: Promise<void> | undefined;
    if (mutation === 'cas') await original('codexExecutionTool', { sessionKey: key, connectionId: connection,
      runId: 'native-run', itemId: 'new-file-evidence', completed: false });
    else if (mutation === 'generation') f.runtime.nativeConnectionGeneration++;
    else closing = f.codex.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    hold.resolve(); await refresh; await closing;
    assert.equal(f.store.getMessages(key).some(m => m.text === 'Done'), false, 'obsolete read cannot publish');
    await f.codex.close(); await f.projection.close(); await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try { assert.equal(reopened.fileIndex.page(key).entries.length, mutation === 'cas' ? 0 : 2); }
    finally { reopened.close(); }
    if (mutation === 'close') assert.equal(closed, true);
  } finally { hold.resolve(); await refresh; await f.close(); }
});

function usageSample(f: Awaited<ReturnType<typeof receiverFixture>>, inputTokens: number, outputTokens: number, turnId = 'native-run') {
  f.runtime.receive(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'synthetic', turnId,
    tokenUsage: { total: { inputTokens, outputTokens }, last: { totalTokens: 7 } } } }));
}

async function persistedUsage(f: Awaited<ReturnType<typeof receiverFixture>>) {
  // Inspect only after all original producers and the sole worker are closed.
  await f.codex.close(); await f.projection.close(); await f.owner.close();
  const reopened = new ConnectorUserStore(f.config.file);
  try {
    const end = Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000;
    return reopened.tokenUsage.range('codex', key, end - 86_400_000, end, 3_600_000);
  } finally { reopened.close(); }
}

test('owned original receiver persists baseline/high-water deltas, rejects old run and survives reopen', async () => {
  const f = await receiverFixture();
  try {
    usageSample(f, 100, 10); await f.runtime.nativeObservations.drain();
    usageSample(f, 9999, 9999, 'old-run'); await f.runtime.nativeObservations.drain();
    usageSample(f, 150, 20); await f.runtime.nativeObservations.drain();
    usageSample(f, 150, 20); await f.runtime.nativeObservations.drain();
    usageSample(f, 120, 15); await f.runtime.nativeObservations.drain();
    usageSample(f, 170, 25); await f.runtime.nativeObservations.drain();
    assert.equal(f.runtime.executionUnavailable, false);
    assert.equal(f.store.getSession(key)?.inputTokens, 170);
    const usage = await persistedUsage(f);
    assert.deepEqual(usage.buckets.map(b => [b.inputTokens, b.outputTokens]), [[70, 15]]);
    assert.ok(f.logs.some(log => log.step === 279));
    assert.doesNotMatch(JSON.stringify(f.logs), /native-run|native-connection|original-command/);
  } finally { await f.close(); }
});

for (const mutation of ['cas', 'connection', 'aba', 'close'] as const)
test(`owned receiver usage ACK is physically drained and stale projection rejected: ${mutation}`, { timeout: 15_000 }, async () => {
  const f = await receiverFixture(), entered = deferred(), hold = deferred();
  const original = f.owner.command.bind(f.owner);
  let calls = 0;
  f.owner.command = (async (kind: any, input: any) => {
    if (kind === 'codexCumulativeUsage' && ++calls === 2) { entered.resolve(); await hold.promise; }
    return original(kind, input);
  }) as typeof f.owner.command;
  try {
    usageSample(f, 100, 10); await f.runtime.nativeObservations.drain();
    usageSample(f, 150, 20); await entered.promise;
    let closed = false, closing: Promise<void> | undefined;
    if (mutation === 'cas') await original('codexExecutionTool', { sessionKey: key, connectionId: connection,
      runId: 'native-run', itemId: 'new-evidence', completed: false });
    else if (mutation === 'close') closing = f.codex.close().then(() => { closed = true; });
    else { f.runtime.setConnection('replacement'); if (mutation === 'aba') f.runtime.setConnection(connection); }
    await tick(); assert.equal(closed, false);
    hold.resolve(); await f.runtime.nativeObservations.drain(); await closing;
    if (mutation === 'close') assert.equal(closed, true);
    else assert.equal(f.store.getSession(key)?.inputTokens, 100, 'stale result cannot overwrite current display');
    const usage = await persistedUsage(f);
    assert.deepEqual(usage.buckets.map(b => [b.inputTokens, b.outputTokens]), mutation === 'cas' ? [] : [[50, 10]],
      'CAS refusal changes no ledger; already admitted observation drains before connection cleanup');
  } finally { hold.resolve(); await f.close(); }
});

test('original maintenance inspection reads sole-worker metadata without native startup or legacy counters', async () => {
  const f = await receiverFixture();
  try {
    assert.equal(Object.hasOwn(f.runtime.options, 'executions'), false);
    assert.equal(Object.hasOwn(f.runtime.options, 'turnQueue'), false);
    f.runtime.ensureStarted = async () => assert.fail('maintenance must not launch native');
    const { assertCurrent, ...snapshot } = await f.codex.inspectMaintenance();
    assertCurrent();
    assert.deepEqual(snapshot, { loadedThreads: 0, activeRuns: 0, backgroundTerminals: 0,
      pendingExecutions: 1, queuedMessages: 0, inFlightWrites: 0 });
    assert.ok(f.logs.some(log => log.step === 249));
  } finally { await f.close(); }
});

for (const mutation of ['authority', 'connection', 'generation', 'closed'] as const)
test(`original maintenance inspection rejects worker ACK after local fence changes: ${mutation}`, async () => {
  const f = await receiverFixture(), read = f.journal.readMaintenance;
  let allowed = true;
  f.journal.readMaintenance = async () => {
    const result = await read();
    if (mutation === 'authority') allowed = false;
    if (mutation === 'connection') f.runtime.connectionId = 'replaced';
    if (mutation === 'generation') f.runtime.nativeConnectionGeneration++;
    if (mutation === 'closed') f.runtime.closed = true;
    return result;
  };
  try {
    await assert.rejects(f.codex.inspectMaintenance(() => { if (!allowed) throw Error('revoked'); }), /revoked|unavailable/);
  } finally { f.runtime.closed = false; f.runtime.connectionId = connection; await f.close(); }
});

for (const operation of ['inspect', 'recover'] as const)
test(`maintenance ${operation} rejects asynchronous authority before worker or native effects`, async () => {
  const f = await receiverFixture();
  try {
    f.journal.readMaintenance = async () => assert.fail('authority must precede durable observation');
    f.journal.readHistory = async () => assert.fail('authority must precede durable history');
    f.runtime.request = async () => assert.fail('authority must precede native effects');
    const asyncAuthority = async () => {};
    await assert.rejects(operation === 'inspect' ? f.codex.inspectMaintenance(asyncAuthority)
      : f.codex.recoverMaintenanceHistory(key, asyncAuthority));
  } finally { await f.close(); }
});

test('original close waits physical maintenance ACK even if caller overwrites Promise.then', async () => {
  const f = await receiverFixture(), read = f.journal.readMaintenance, gate = deferred(), entered = deferred();
  f.journal.readMaintenance = async () => { entered.resolve(); await gate.promise; return read(); };
  try {
    const observing = f.codex.inspectMaintenance(), rejected = assert.rejects(observing, /unavailable/);
    await entered.promise;
    observing.then = (() => Promise.resolve()) as typeof observing.then;
    let closed = false;
    const closing = f.codex.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    gate.resolve(); await rejected; await closing; assert.equal(closed, true);
  } finally { gate.resolve(); await f.close(); }
});

for (const successor of [false, true])
test(`original maintenance recovery joins real worker and original final-history owner, successor=${successor}`, async () => {
  const f = await receiverFixture();
  try {
    completedHistory(f, successor);
    await f.journal.settle(event({ kind: 'complete', phase: 'completed' }));
    assert.equal(Object.hasOwn(f.runtime.options, 'turnQueue'), false);
    f.runtime.drainQueuedTurn = async () => assert.fail('maintenance may not dispatch a successor');
    await f.codex.recoverMaintenanceHistory(key, () => {});
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.commandId, 'original-command'); assert.equal(fact?.runId, 'native-run');
    if (successor) {
      assert.equal(fact?.nativeHistory?.state, 'blocked');
      assert.equal(fact?.nativeHistory?.turnId, 'successor');
      assert.equal(fact?.sync, 'current');
      assert.equal(f.codex.isSessionHistoryReady(key), true, 'readable old history does not authorize execution');
    } else { assert.equal(fact?.sync, 'current'); assert.equal(f.codex.isSessionHistoryReady(key), true); }
    assert.equal(f.runtime.executionUnavailable, false);
  } finally { await f.close(); }
});

test('maintenance revocation during refreshed worker observation prevents native cold resume', async () => {
  const f = await receiverFixture();
  try {
    completedHistory(f);
    await f.journal.settle(event({ kind: 'complete', phase: 'completed' }));
    const terminal = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.ok(terminal);
    assert.equal(await f.journal.settleHistory(terminal, 'error'), true);
    let reads = 0, allowed = true;
    const request = f.runtime.request, history = f.journal.readHistory;
    f.runtime.request = async (method: string) => {
      assert.notEqual(method, 'thread/resume', 'revoked authority cannot cold-resume native execution');
      const result = await request(method);
      if (method === 'thread/read') {
        reads++;
        result.thread.path = join(f.directory, 'missing-rollout.jsonl');
        result.thread.status = { type: 'notLoaded' };
      }
      return result;
    };
    f.journal.readHistory = async (...args) => {
      const result = await history(...args);
      if (reads >= 2) allowed = false;
      return result;
    };
    f.journal.settleHistory = async () => assert.fail('revoked maintenance cannot settle success');
    await assert.rejects(f.codex.recoverMaintenanceHistory(key, () => { if (!allowed) throw Error('revoked'); }), /revoked/);
    assert.equal(reads, 2, 'revocation occurs inside original refresh, after initial maintenance head read');
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.sync, 'error');
    assert.equal(f.runtime.rolloutlessHistoryRecovered.has(key), false);
  } finally { await f.close(); }
});

for (const fault of ['none', 'cas-refused', 'lost-ack', 'post-commit-generation'] as const)
test(`original rolloutless maintenance settles exact worker revision without replay: ${fault}`, async () => {
  const f = await receiverFixture();
  try {
    completedHistory(f);
    await f.journal.settle(event({ kind: 'complete', phase: 'completed' }));
    const terminal = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.ok(terminal);
    assert.equal(await f.journal.settleHistory(terminal, 'error'), true);
    const request = f.runtime.request;
    let resumed = false, resumes = 0, settlements = 0;
    f.runtime.request = async (method: string) => {
      if (method === 'thread/resume') { resumed = true; resumes++; }
      if (method === 'thread/read' || method === 'thread/resume') {
        const result = await request('thread/read');
        result.thread.path = join(f.directory, 'missing-rollout.jsonl');
        result.thread.status = { type: resumed ? 'idle' : 'notLoaded' };
        return result;
      }
      return request(method);
    };
    f.runtime.drainQueuedTurn = async () => assert.fail('maintenance must not dispatch');
    const settle = f.journal.settleHistory;
    f.journal.settleHistory = async (...args) => {
      settlements++;
      if (fault === 'cas-refused') return false;
      const accepted = await settle(...args);
      if (fault === 'lost-ack') throw Error('commit ACK lost');
      if (fault === 'post-commit-generation') f.runtime.nativeConnectionGeneration++;
      return accepted;
    };
    const recovery = f.codex.recoverMaintenanceHistory(key, () => {});
    if (fault === 'none') await recovery;
    else await assert.rejects(recovery);
    assert.equal(settlements, 1);
    assert.equal(resumes, 1);
    assert.equal(f.runtime.rolloutlessHistoryRecovered.has(key), fault === 'none');
    const after = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(after?.commandId, terminal.commandId);
    assert.equal(after?.runId, terminal.runId);
    if (fault === 'none') {
      assert.equal(after?.sync, 'current');
      assert.equal(after?.nativeHistory?.state, 'verified');
    }
    if (fault === 'cas-refused') {
      assert.equal(after?.sync, 'syncing', 'known resume ACK strengthened protection before refused settlement');
      assert.equal(after?.nativeHistory?.state, 'blocked');
    }
    if (fault === 'post-commit-generation') assert.equal(after?.nativeHistory?.state, 'blocked');
    if (fault === 'lost-ack') {
      assert.equal(f.runtime.executionUnavailable, true);
      await assert.rejects(f.codex.recoverMaintenanceHistory(key, () => {}));
      assert.equal(resumes, 1, 'unknown commit cannot replay the native resume');
      assert.equal(settlements, 1, 'unknown commit cannot replay settlement');
    }
  } finally { await f.close(); }
});

test('original history refresh recovers worker lifecycle then joins original final history without synchronous journal reads', async () => {
  const f = await receiverFixture();
  try {
    completedHistory(f);
    assert.equal(Object.hasOwn(f.runtime.options, 'turnQueue'), false);
    await f.codex.refreshSession(key, { fresh: true });
    await f.runtime.nativeObservations.drain();
    await f.runtime.completingTurns.get(key);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.sync, 'current');
    assert.ok(f.store.getMessages(key).some(message => message.text === 'Done'));
    assert.equal(f.runtime.executionUnavailable, false);
    assert.ok(f.logs.some(log => log.step === 248));
  } finally { await f.close(); }
});

for (const mutation of ['revision', 'connection', 'generation', 'child'] as const)
test(`original history refresh cannot publish an obsolete worker/native observation: ${mutation}`, async () => {
  const f = await receiverFixture();
  try {
    completedHistory(f);
    const request = f.runtime.request;
    const before = await f.owner.command('codexExecutionRead', { sessionKey: key });
    let changed = false;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      const result = await request(method, ...args);
      if (method === 'thread/read' && !changed) {
        changed = true;
        if (mutation === 'revision') await f.owner.command('codexExecutionTool', {
          sessionKey: key, connectionId: connection, runId: 'native-run', itemId: 'racing-tool', completed: false });
        if (mutation === 'connection') f.runtime.connectionId = 'replacement';
        if (mutation === 'generation') f.runtime.nativeConnectionGeneration++;
        if (mutation === 'child') f.runtime.child = {};
      }
      return result;
    };
    await assert.rejects(f.codex.refreshSession(key, { fresh: true }));
    assert.equal(changed, true, 'must reach the native read, not fail during fixture startup');
    assert.equal(f.store.getMessages(key).length, 0);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.sync, before?.sync);
  } finally { f.runtime.child = undefined; await f.close(); }
});

test('original live history cache reads worker fact without re-reading native transcript on every browser refresh', async () => {
  const f = await receiverFixture();
  try {
    completedHistory(f);
    const request = f.runtime.request;
    let nativeReads = 0;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      const result = await request(method, ...args);
      if (method === 'thread/read') {
        nativeReads++;
        result.thread.status.type = 'active'; result.thread.turns[0].status = 'inProgress';
      }
      return result;
    };
    await f.codex.refreshSession(key, { fresh: true, readOnly: true });
    const reads = nativeReads;
    await f.codex.refreshSession(key, { maxAgeMs: 1500, readOnly: true });
    assert.equal(nativeReads, reads);
    assert.equal(f.store.getSession(key)?.runtime?.phase, 'running');
    assert.equal(f.runtime.executionUnavailable, false);
  } finally { await f.close(); }
});

for (const fault of ['none', 'prepare-ack', 'begin-ack', 'native-ack', 'malformed-ack', 'finish-ack', 'racing-tool'] as const)
test(`ordinary terminal refresh uses the original durable resume and never replays a lost ACK: ${fault}`, async () => {
  const f = await receiverFixture();
  try {
    await f.owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection,
      runId: 'native-run', phase: 'completed', expected: null });
    completedHistory(f);
    const request = f.runtime.request;
    let resumes = 0;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      if (method === 'thread/resume') {
        if (typeof args[3] === 'function') (args[3] as () => void)();
        resumes++;
        if (fault === 'native-ack') throw Error('synthetic lost native ACK');
        if (fault === 'malformed-ack') return { thread: { id: 'wrong-identity', turns: [] } };
        return request('thread/read');
      }
      const result = await request(method, ...args);
      if (method === 'thread/read' && !resumes) result.thread.status.type = 'notLoaded';
      return result;
    };
    const prepare = f.journal.prepareResume, begin = f.journal.beginResume, finish = f.journal.finishResume;
    f.journal.prepareResume = async (...args) => {
      const receipt = await prepare(...args);
      if (fault === 'prepare-ack') throw Error('synthetic lost prepare ACK');
      return receipt;
    };
    f.journal.beginResume = async (...args) => {
      const result = await begin(...args);
      if (fault === 'begin-ack') throw Error('synthetic lost begin ACK');
      return result;
    };
    f.journal.finishResume = async (...args) => {
      const result = await finish(...args);
      if (fault === 'finish-ack') throw Error('synthetic lost finish ACK');
      if (fault === 'racing-tool') await f.owner.command('codexExecutionTool', {
        sessionKey: key, connectionId: connection, runId: 'native-run', itemId: 'racing-tool', completed: false });
      return result;
    };
    if (fault === 'none') {
      await f.codex.refreshSession(key, { fresh: true });
      await f.runtime.nativeObservations.drain();
      await f.runtime.completingTurns.get(key);
      assert.ok(f.store.getMessages(key).some(message => message.text === 'Done'));
      assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.sync, 'current');
    } else {
      await assert.rejects(f.codex.refreshSession(key, { fresh: true }));
      assert.equal(f.store.getMessages(key).length, 0, 'unknown ACK or unrelated revision cannot publish a stale snapshot');
      try { await f.codex.refreshSession(key, { fresh: true }); } catch { /* Still fenced. */ }
    }
    assert.equal(resumes, fault === 'prepare-ack' || fault === 'begin-ack' ? 0 : 1);
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown,
      fault === 'prepare-ack' || fault === 'native-ack' || fault === 'malformed-ack');
  } finally { await f.close(); }
});

test('ordinary restarted refresh loads its original terminal once without transferring execution ownership', async () => {
  const f = await receiverFixture(1, true);
  try {
    const before = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    assert.equal(before.phase, 'unknown'); assert.equal(before.reason, 'restarted');
    completedHistory(f);
    const request = f.runtime.request;
    let loaded = false, resumes = 0;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      if (method === 'thread/resume') { loaded = true; resumes++; return request('thread/read'); }
      const result = await request(method, ...args);
      if (method === 'thread/read' && !loaded) result.thread.status.type = 'notLoaded';
      return result;
    };
    await f.codex.refreshSession(key, { fresh: true });
    const after = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    assert.equal(after.commandId, before.commandId); assert.equal(after.runId, before.runId);
    assert.equal(after.phase, 'completed');
    assert.equal(after.nativeHistory?.state, 'blocked');
    assert.notEqual(after.sync, 'current', 'a history GET is not final execution-safety settlement');
    await f.codex.refreshSession(key, { fresh: true });
    assert.equal(resumes, 1);
    assert.ok(f.store.getMessages(key).some(message => message.text === 'Done'));
  } finally { await f.close(); }
});

for (const protection of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'unknown',
  'changed-goal', 'changed-head', 'activity-during-begin'] as const)
test(`ordinary history refresh cannot resume a protected or changed Goal/head: ${protection}`, async () => {
  const f = await receiverFixture();
  try {
    await f.owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection,
      runId: 'native-run', phase: 'completed', expected: null });
    completedHistory(f);
    const request = f.runtime.request;
    let resumes = 0, goals = 0, reads = 0;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      if (method === 'thread/resume') { resumes++; assert.fail('history read must not activate protected native work'); }
      const result = await request(method, ...args);
      if (method === 'thread/read') {
        result.thread.status.type = 'notLoaded'; reads++;
        if (protection === 'changed-head' && reads > 1) result.thread.turns[0].items[0].text = 'Changed';
      }
      if (method === 'thread/goal/get') {
        goals++;
        if (protection !== 'changed-head' && protection !== 'activity-during-begin') {
          result.goal = { threadId: 'synthetic', status: protection === 'changed-goal' ? 'complete' : protection,
            createdAt: 1, updatedAt: protection === 'changed-goal' ? goals : 2,
            objective: 'Original goal', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 };
        }
      }
      return result;
    };
    const begin = f.journal.beginResume;
    f.journal.beginResume = async (...args) => {
      const result = await begin(...args);
      if (protection === 'activity-during-begin') f.runtime.recordNativeActivity('synthetic');
      return result;
    };
    await assert.rejects(f.codex.refreshSession(key, { fresh: true }));
    assert.equal(resumes, 0); assert.equal(f.store.getMessages(key).length, 0);
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, false,
      'no transport write permits exact original not-dispatched settlement');
    assert.equal(f.runtime.executionUnavailable, false);
  } finally { await f.close(); }
});

for (const fault of ['prepare-ack', 'begin-ack', 'native-ack', 'malformed-ack', 'finish-ack'] as const)
test(`original cold recovery handles physical resume ACK loss without replay: ${fault}`, async () => {
  const f = await receiverFixture();
  try {
    await f.owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection,
      runId: 'native-run', phase: 'completed', expected: null });
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    await f.owner.command('codexHistoryCompareSettle', { expected: fact, sync: 'error' });
    completedHistory(f);
    const request = f.runtime.request;
    let resumes = 0;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      if (method === 'thread/resume') {
        if (typeof args[3] === 'function') (args[3] as () => void)();
        resumes++;
        if (fault === 'native-ack') throw Error('synthetic lost native ACK after write');
        if (fault === 'malformed-ack') return { thread: { id: 'wrong-identity', turns: [] } };
        return request('thread/read');
      }
      const result = await request(method, ...args);
      if (method === 'thread/read') result.thread.status.type = resumes ? 'idle' : 'notLoaded';
      return result;
    };
    const prepare = f.journal.prepareResume, begin = f.journal.beginResume, finish = f.journal.finishResume;
    f.journal.prepareResume = async (...args) => {
      const result = await prepare(...args);
      if (fault === 'prepare-ack') throw Error('synthetic lost prepare ACK');
      return result;
    };
    f.journal.beginResume = async (...args) => {
      const result = await begin(...args);
      if (fault === 'begin-ack') throw Error('synthetic lost begin ACK');
      return result;
    };
    f.journal.finishResume = async (...args) => {
      const result = await finish(...args);
      if (fault === 'finish-ack') throw Error('synthetic lost finish ACK');
      return result;
    };
    await assert.rejects(f.runtime.rehydrateCheckpointThread(key));
    assert.equal(resumes, fault === 'prepare-ack' || fault === 'begin-ack' ? 0 : 1);
    const pending = fault === 'prepare-ack' || fault === 'native-ack' || fault === 'malformed-ack';
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, pending);
    assert.equal(f.runtime.executionUnavailable, fault !== 'begin-ack', 'only original proven not-dispatched cleanup can keep executor available');
    assert.equal(f.store.getMessages(key).length, 0);
    if (fault !== 'begin-ack') {
      // Protected histories can return without native IO; unavailable local
      // executors can reject. Neither result is authority to replay resume.
      try { await f.runtime.rehydrateCheckpointThread(key); } catch { /* Still fenced. */ }
    }
    assert.equal(resumes, fault === 'prepare-ack' || fault === 'begin-ack' ? 0 : 1);
    await f.codex.close(); await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      reopened.codexExecutions.recoverInterrupted();
      assert.equal(reopened.codexExecutions.nativeResumes.pending(key), fault === 'native-ack' || fault === 'malformed-ack');
      assert.equal(reopened.codexExecutions.canStart(key), false, 'unknown outcome or stale history is never new dispatch authority');
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('original close drains physical resume authorization even if caller hides its Promise.then', async () => {
  const f = await receiverFixture(), entered = deferred(), release = deferred();
  try {
    await f.owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection,
      runId: 'native-run', phase: 'completed', expected: null });
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    const begin = f.journal.beginResume;
    f.journal.beginResume = async receipt => { entered.resolve(); await release.promise; return begin(receipt); };
    let nativeCalls = 0;
    f.runtime.request = async () => { nativeCalls++; assert.fail('closed original executor must not dispatch resume'); };
    const physical = f.runtime.resumeRecoveredThread(fact, 'synthetic', 'a'.repeat(64), () => {});
    const rejected = assert.rejects(new Promise((ok, no) => Promise.prototype.then.call(physical, ok, no)));
    Object.defineProperty(physical, 'then', { value: undefined });
    await entered.promise;
    let drained = false;
    const closing = f.codex.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    release.resolve(); await rejected; await closing;
    assert.equal(nativeCalls, 0);
    assert.equal((await f.owner.command('codexHistoryObservation', { sessionKey: key })).outcomeUnknown, false);
  } finally { release.resolve(); await f.close(); }
});

for (const mutation of ['none', 'before-resume', 'after-resume', 'after-resume-revision', 'after-resume-protection',
  'after-resume-protection-and-tool', 'lost-settlement'] as const)
test(`original cold recovery uses worker revision and keeps blocked checkpoint without replay: ${mutation}`, async () => {
  const f = await receiverFixture();
  try {
    await f.owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection,
      runId: 'native-run', phase: 'completed', expected: null });
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    await f.owner.command('codexHistoryCompareSettle', { expected: fact, sync: 'error' });
    completedHistory(f);
    const request = f.runtime.request;
    let reads = 0, resumes = 0;
    f.runtime.request = async (method: string, ...args: unknown[]) => {
      if (method === 'thread/resume') {
        if (typeof args[3] === 'function') (args[3] as () => void)();
        resumes++;
        if (mutation === 'after-resume') f.runtime.nativeConnectionGeneration++;
        if (mutation === 'after-resume-protection' || mutation === 'after-resume-protection-and-tool')
          await f.journal.settle({ sessionKey: key, connectionId: connection, runId: null, kind: 'goal',
            phase: null, successorItemTurnId: null, projectable: true, tool: null });
        if (mutation === 'after-resume-revision' || mutation === 'after-resume-protection-and-tool')
          await f.owner.command('codexExecutionTool', { sessionKey: key,
          connectionId: connection, runId: 'native-run', itemId: 'racing-tool', completed: false });
        return request('thread/read');
      }
      const result = await request(method, ...args);
      if (method === 'thread/read') { reads++; result.thread.status.type = resumes ? 'idle' : 'notLoaded'; }
      if (method === 'thread/goal/get' && reads >= 2 && mutation === 'before-resume')
        await f.owner.command('codexExecutionTool', { sessionKey: key, connectionId: connection,
          runId: 'native-run', itemId: 'racing-tool', completed: false });
      return result;
    };
    let settlements = 0;
    const settle = f.journal.settleHistory;
    f.journal.settleHistory = async (...args) => {
      settlements++; const result = await settle(...args);
      if (mutation === 'lost-settlement') throw Error('synthetic lost settlement ACK');
      return result;
    };
    if (mutation === 'none' || mutation === 'after-resume-protection') await f.runtime.rehydrateCheckpointThread(key);
    else await assert.rejects(f.runtime.rehydrateCheckpointThread(key));
    assert.equal(resumes, mutation === 'before-resume' ? 0 : 1);
    assert.ok(settlements <= 1);
    const final = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    assert.equal(final.commandId, 'original-command'); assert.equal(final.runId, 'native-run');
    if (mutation === 'none' || mutation === 'after-resume-protection' || mutation === 'lost-settlement') assert.equal(final.nativeHistory?.state, 'blocked');
    else assert.notEqual(final.sync, 'current');
    if (mutation === 'lost-settlement') {
      assert.equal(f.runtime.executionUnavailable, true);
      await assert.rejects(f.runtime.rehydrateCheckpointThread(key));
      assert.equal(resumes, 1, 'unknown settlement must not replay native resume');
    }
    assert.equal(f.store.getMessages(key).length, 0);
  } finally { await f.close(); }
});

for (const successor of [false, true]) test(`original final receiver settles real worker history without legacy journal: successor=${successor}`, async () => {
  const f = await receiverFixture();
  try {
    await completedHistory(f, successor)();
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.sync, 'current');
    assert.ok(f.store.getMessages(key).some(message => message.text === 'Done'));
    assert.equal(f.store.getSession(key)?.runtime?.sync, 'current');
    assert.equal(f.runtime.executionUnavailable, false);
    if (successor) {
      assert.equal(fact?.nativeHistory?.state, 'blocked');
      assert.equal(fact?.nativeHistory?.turnId, 'successor');
      assert.equal(f.store.getSession(key)?.runtime?.executionProtection?.state, 'blocked');
    }
  } finally { await f.close(); }
});

test('original final receiver retries a rejected revision, never a committed effect', async () => {
  const f = await receiverFixture(), settle = f.journal.settleHistory;
  let calls = 0;
  f.journal.settleHistory = async (...args) => {
    if (++calls === 1) {
      await f.owner.command('codexNativeHistoryInvalidate', { sessionKey: key, reason: 'changed', readableSuccessorTurnId: null });
      assert.equal(await settle(...args), false);
      assert.equal(f.store.getMessages(key).length, 0, 'stale CAS cannot publish any final message');
      return false;
    }
    return settle(...args);
  };
  try {
    await completedHistory(f)();
    assert.equal(calls, 2);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.sync, 'current');
    assert.ok(f.store.getMessages(key).some(message => message.text === 'Done'));
  } finally { await f.close(); }
});

test('original final receiver fences a physical success when visible publication fails', async () => {
  const f = await receiverFixture(); let calls = 0;
  const settle = f.journal.settleHistory;
  f.journal.settleHistory = (...args) => { calls++; return settle(...args); };
  f.store.replaceMessages = () => { throw Error('synthetic publication failure'); };
  try {
    await completedHistory(f)();
    assert.equal(calls, 1, 'post-commit publication failure cannot become another settlement');
    assert.equal(f.runtime.executionUnavailable, true);
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.sync, 'syncing');
    assert.equal(fact?.nativeHistory?.state, 'blocked');
    assert.equal(f.store.getMessages(key).length, 0);
  } finally { await f.close(); }
});

for (const mode of ['replacement', 'aba', 'close', 'lost-ack'] as const) test(`original final settlement retains post-ACK local fence: ${mode}`, async () => {
  const f = await receiverFixture(), entered = deferred(), hold = deferred();
  const settle = f.journal.settleHistory; let calls = 0;
  f.journal.settleHistory = async (...args) => {
    calls++;
    const accepted = await settle(...args);
    entered.resolve(); await hold.promise;
    if (mode === 'lost-ack') throw Error('lost acknowledgement');
    return accepted;
  };
  let closing: Promise<void> | undefined;
  try {
    const completing = completedHistory(f)();
    await entered.promise;
    assert.equal(f.store.getMessages(key).length, 0, 'DB settlement precedes visible mutation');
    let closed = false;
    if (mode === 'close') closing = f.codex.close().then(() => { closed = true; });
    else if (mode !== 'lost-ack') {
      f.runtime.setConnection('replacement');
      if (mode === 'aba') f.runtime.setConnection(connection);
    }
    await tick(); assert.equal(closed, false);
    hold.resolve(); await completing; await closing;
    assert.equal(calls, 1, 'unknown/stale settlement must not be replayed or followed by error settlement');
    assert.equal(f.store.getMessages(key).length, 0);
    if (mode === 'lost-ack') assert.equal(f.runtime.executionUnavailable, true);
    else {
      const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
      assert.equal(fact?.nativeHistory?.state, 'blocked');
      assert.equal(fact?.sync, 'syncing');
    }
    if (mode === 'close') assert.equal(closed, true);
  } finally { hold.resolve(); await closing; await f.close(); }
});

test('original native receiver waits real worker settlement before original command tool projection', async () => {
  const f = await receiverFixture(), hold = deferred();
  const settle = f.journal.settle;
  f.journal.settle = async (input: CodexNativeNotification) => { await hold.promise; return settle(input); };
  try {
    const guard = f.runtime.nativeHistoryActivityGuard('synthetic');
    f.receive('item/started', { id: 'tool', type: 'commandExecution', command: 'synthetic-command' });
    assert.equal(guard.current(), false, 'ingress invalidates original history before worker reply');
    assert.equal(f.store.getMessages(key).length, 0);
    assert.equal(f.runtime.nativeObservations.status().pending, 1);
    hold.resolve(); await f.runtime.nativeObservations.drain();
    assert.ok(f.store.getMessages(key).some(message => message.role === 'tool'));
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.deepEqual(fact?.pendingCommandTools, ['tool']);
  } finally { hold.resolve(); await f.close(); }
});

test('original receiver never fabricates command lifecycle identity for an incomplete native item', async () => {
  const f = await receiverFixture(); let calls = 0;
  const settle = f.journal.settle;
  f.journal.settle = (input: CodexNativeNotification) => { calls++; return settle(input); };
  try {
    for (const method of ['item/started', 'item/completed']) {
      for (const item of [{ type: 'commandExecution' }, { type: 'commandExecution', id: '' }]) {
        // itemId is valid for output deltas, not a substitute for the native
        // lifecycle item's own id (especially after terminal settlement).
        f.runtime.receive(JSON.stringify({ method, params: { threadId: 'synthetic', turnId: 'native-run',
          itemId: 'alias-only', item } }));
      }
    }
    await f.runtime.nativeObservations.drain();
    assert.equal(calls, 0); assert.equal(f.store.getMessages(key).length, 0);
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.phase, 'running'); assert.equal(fact?.pendingCommandTools, undefined);
    assert.equal(f.runtime.executionUnavailable, false);
  } finally { await f.close(); }
});

for (const mode of ['replacement', 'aba', 'close'] as const) test(`original receiver rejects stale projection after worker wait: ${mode}`, async () => {
  const f = await receiverFixture(), hold = deferred(), entered = deferred();
  const settle = f.journal.settle;
  f.journal.settle = async (input: CodexNativeNotification) => {
    const result = await settle(input); entered.resolve(); await hold.promise; return result;
  };
  try {
    f.receive('item/started', { id: 'tool', type: 'commandExecution', command: 'synthetic-command' });
    await entered.promise;
    let closed = false;
    let closing: Promise<void> | undefined;
    if (mode === 'close') closing = f.codex.close().then(() => { closed = true; });
    else {
      f.runtime.setConnection('replacement');
      if (mode === 'aba') f.runtime.setConnection(connection);
    }
    await tick(); assert.equal(closed, false);
    hold.resolve(); await f.runtime.nativeObservations.drain(); await closing;
    assert.equal(f.store.getMessages(key).length, 0);
    assert.deepEqual((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.pendingCommandTools, ['tool'],
      'discarding stale projection must not undo accepted native evidence');
    if (mode === 'close') assert.equal(closed, true);
  } finally { hold.resolve(); await f.close(); }
});

test('original receiver worker failure freezes execution facts and never replays native observation', async () => {
  const f = await receiverFixture(); let calls = 0;
  f.journal.settle = async () => { calls++; throw Error('private-payload-must-not-log'); };
  try {
    f.receive('item/started', { id: 'tool', type: 'commandExecution' });
    await f.runtime.nativeObservations.drain();
    assert.equal(f.runtime.executionUnavailable, true);
    assert.throws(() => f.store.getSession(key), /facts unavailable/);
    f.receive('item/started', { id: 'tool', type: 'commandExecution' });
    await f.runtime.nativeObservations.drain();
    assert.equal(calls, 1); assert.equal(f.store.getMessages(key).length, 0);
  } finally { await f.close(); }
});

test('original connection observer drains real worker pages before notification and fences only on replacement', async () => {
  const f = await receiverFixture(66), hold = deferred(), entered = deferred();
  const page = f.journal.settleConnectionPage;
  const calls: { after: string; size: number; next: string | undefined }[] = [];
  f.journal.settleConnectionPage = async (after: string, previous: string | undefined, next: string | undefined) => {
    const result = await page(after, previous, next); calls.push({ after, size: result.length, next });
    if (calls.length === 1) { entered.resolve(); await hold.promise; }
    return result;
  };
  let notifications = 0;
  const notification = f.journal.settle;
  f.journal.settle = (input: CodexNativeNotification) => { notifications++; return notification(input); };
  try {
    f.runtime.setConnection(undefined); await entered.promise;
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.phase, 'running',
      'disconnect is not evidence of replacement or completion');
    f.runtime.setConnection('replacement');
    f.receive('item/started', { id: 'old-tool', type: 'commandExecution' });
    await tick(); assert.equal(notifications, 0);
    hold.resolve(); await f.runtime.nativeObservations.drain();
    assert.deepEqual(calls.map(call => call.size), [64, 2, 64, 2]);
    assert.deepEqual(calls.map(call => call.after === ''), [true, false, true, false]);
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.phase, 'unknown'); assert.equal(fact?.runId, 'native-run');
    assert.equal(fact?.reason, 'restarted'); assert.equal(f.store.getMessages(key).length, 0);
    const terminal = await f.owner.command('codexExecutionRead', { sessionKey: 'codex:page-001' });
    assert.equal(terminal?.nativeHistory?.state, 'blocked');
    assert.ok(f.logs.some(log => log.step === 42) || f.diagnostics.snapshot().totals.suppressed > 0);
    assert.doesNotMatch(JSON.stringify(f.logs), /page-001|original-command|native-run|replacement|old-tool/);
  } finally { hold.resolve(); await f.close(); }
});

for (const mode of ['aba', 'close'] as const) test(`connection page physical ownership and final projection isolation: ${mode}`, async () => {
  const f = await receiverFixture(65), hold = deferred(), entered = deferred();
  const page = f.journal.settleConnectionPage;
  let calls = 0, projections = 0, closed = false;
  f.store.projectCodexConnection = () => { projections++; };
  f.journal.settleConnectionPage = (after: string, previous: string | undefined, next: string | undefined) => {
    calls++;
    if (calls !== 1) return page(after, previous, next);
    const physical = new Promise<string[]>((resolve, reject) => {
      void page(after, previous, next).then(async (result: string[]) => {
        entered.resolve(); await hold.promise; resolve(result);
      }, reject);
    });
    physical.then = () => { throw Error('public then is not physical ownership'); };
    return physical;
  };
  try {
    f.runtime.setConnection('replacement'); await entered.promise;
    let closing: Promise<void> | undefined;
    if (mode === 'close') closing = f.codex.close().then(() => { closed = true; });
    else f.runtime.setConnection(connection);
    await tick(); assert.equal(closed, false); assert.equal(projections, 0);
    hold.resolve(); await f.runtime.nativeObservations.drain(); await closing;
    assert.equal(calls, 4, 'old physical second page must finish before successor pages');
    assert.equal(projections, 1, 'only latest generation may project connection');
    assert.equal(f.runtime.executionUnavailable, false);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.phase, 'unknown');
    if (mode === 'close') assert.equal(closed, true);
  } finally { hold.resolve(); await f.close(); }
});

for (const mode of ['rejected', 'repeated-cursor'] as const) test(`later connection page fails closed without retry: ${mode}`, async () => {
  const f = await receiverFixture(65);
  const page = f.journal.settleConnectionPage;
  let calls = 0, projections = 0;
  f.store.projectCodexConnection = () => { projections++; };
  f.journal.settleConnectionPage = async (after: string, previous: string | undefined, next: string | undefined) => {
    calls++;
    if (calls === 1) return page(after, previous, next);
    if (mode === 'rejected') throw Error('private-connection-failure');
    return [after];
  };
  try {
    f.runtime.setConnection('replacement'); await f.runtime.nativeObservations.drain();
    assert.equal(calls, 2); assert.equal(projections, 0); assert.equal(f.runtime.executionUnavailable, true);
    f.runtime.setConnection('later'); await f.runtime.nativeObservations.drain(); assert.equal(calls, 2);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: 'codex:page-001' }))?.nativeHistory?.state, 'blocked');
    assert.doesNotMatch(JSON.stringify(f.logs), /private-connection-failure/);
  } finally { await f.close(); }
});
