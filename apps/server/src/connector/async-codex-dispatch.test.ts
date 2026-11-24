import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CodexAppServer } from '../codex/app-server.js';
import { codexAdmissionProof } from '../codex/dispatch-admission.js';
import { describeBatch } from '../codex/queued-batch.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexDispatch, type PreparedCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexStartup, codexStartupDeckPublisher } from './async-codex-startup.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';
import type { ConnectorOwnerKind } from './connector-owner-domain.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const silence = new PerformanceDiagnostics(() => {});
async function fixture(t: import('node:test').TestContext, count = 1, ownedAutomation = false) {
  const directory = mkdtempSync(join(tmpdir(), 'async-codex-native-'));
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const close of cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); } }
    finally { rmSync(directory, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'Isolated dispatch cleanup failed');
  });
  const config = { file: join(directory, 'worker.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-native-proof' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const key = 'codex:original', connectionId = 'original-connection';
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  for (let i = 0; i < count; i++) await seed.turns.enqueueAsync('codex', { id: `command-${i}`, sessionKey: key, createdAt: 1,
    payload: { text: `PRIVATE-BODY-${i}`, images: [], actorId: actor } });
  const entries = seed.turns.list<{ text: string; images: []; actorId: string }>('codex', key), batch = describeBatch(entries);
  const prepared: PreparedCodexDispatch = { claim: { sessionKey: key, commandId: 'command-0', connectionId,
    proof: codexAdmissionProof(seed.turns, entries), preparing: false, blockedGoalInput: false, ...(batch ? { batch } : {}) },
    input: [{ type: 'text', text: entries.map(e => e.payload.text).join(batch?.separator ?? '') }], interactive: false };
  seed.close();
  const owner = new AsyncConnectorOwner(config, silence);
  cleanup.push(() => owner.close()); await owner.open();
  const store = new DeckStore();
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original executor', status: 'idle', codexGoal: null });
  let runtime: any;
  const projection = new AsyncCodexProjection({ owner, deck: store,
    connectionId: () => runtime?.connectionId, bind: false, diagnostics: silence });
  cleanup.push(() => projection.close());
  const startup = new AsyncCodexStartup({ owner, projection, publish: codexStartupDeckPublisher(store), diagnostics: silence });
  const scheduling = new AsyncCodexScheduling(owner);
  const queuedConsumer = new AsyncCodexQueue({ owner, diagnostics: silence, local() {},
    dispatch: { async dispatch() { assert.fail('dispatch fixture uses explicit original dispatch'); } },
    async prepare() { assert.fail('dispatch fixture does not activate the scheduler'); } });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: 'C:\\isolated\\cwd',
    defaultModel: 'test-model', approvalPolicy: 'never', store,
    authorizeTurn: () => { throw Error('Synchronous auth forbidden'); }, requestTimeoutMs: 20,
    nativeJournal: projection.nativeJournal(), startup, scheduling, queuedConsumer, historyReader: new AsyncCodexHistory(owner, silence),
    credentialExecutionReader: new AsyncConnectorExecutionReads(owner).codex });
  runtime = codex as any;
  cleanup.push(async () => { runtime.child = undefined; await codex.close(); });
  await codex.ready();
  const writes: any[] = [], written = deferred();
  let onWrite: (() => void) | undefined;
  const child = { stdin: { writable: true, write(line: string) { writes.push(JSON.parse(line)); written.resolve(); onWrite?.(); return true; } } };
  runtime.child = child; runtime.connectionId = connectionId; runtime.automationConnectedSince = Date.now();
  // Ordinary dispatch tests model an already loaded thread. Cold loading is
  // exercised separately and must never be smuggled in through a warm fixture.
  runtime.loadedThreadIds.add('original');
  const kinds: ConnectorOwnerKind[] = [];
  let hook: ((kind: ConnectorOwnerKind, input: any, work: () => Promise<any>) => Promise<any>) | undefined;
  const port = { command: ((kind: ConnectorOwnerKind, input: any) => {
    kinds.push(kind);
    const run = () => owner.command(kind, input);
    return hook ? hook(kind, input, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const diagnostics: any[] = [];
  let local: (() => void) | undefined, settled: (() => void | Promise<void>) | undefined =
    ownedAutomation ? () => projection.project(key) : undefined;
  const dispatch = new AsyncCodexDispatch({ owner: port, runtime: codex, local: () => local?.(), settled: () => settled?.(),
    diagnostics: new PerformanceDiagnostics(line => diagnostics.push(JSON.parse(line)), () => 0) });
  cleanup.push(() => dispatch.close());
  const ack = () => { assert.equal(writes.length, 1); runtime.receive(JSON.stringify({ id: writes[0].id, result: { turn: { id: 'native-run' } } })); };
  return { owner, prepared, codex, runtime, dispatch, writes, written, kinds, diagnostics, actor, key, ack, projection, store,
    onWrite(fn: () => void) { onWrite = fn; }, hook(fn: NonNullable<typeof hook>) { hook = fn; },
    local(fn: () => void) { local = fn; }, settled(fn: () => void | Promise<void>) { settled = fn; } };
}

function coldTransport(f: Awaited<ReturnType<typeof fixture>>, options: {
  goal?: any; background?: any[]; changed?: boolean; missingResumeAck?: boolean; busy?: boolean;
  items?: any[]; resume?: () => void; read?: (resumed: boolean) => void;
} = {}) {
  f.runtime.loadedThreadIds.delete('original');
  f.runtime.options.requestTimeoutMs = 250;
  let resumed = false;
  f.onWrite(() => {
    const request = f.writes.at(-1)!;
    let result: any;
    if (request.method === 'thread/read') {
      options.read?.(resumed);
      result = { thread: { id: 'original',
      status: { type: resumed ? 'idle' : 'notLoaded' }, canAcceptDirectInput: resumed && !options.busy,
      turns: [{ id: 'prior', status: 'completed', items: options.items ?? [],
        ...(resumed && options.changed ? { extra: 'new-history' } : {}) }] } };
    }
    else if (request.method === 'thread/goal/get') result = options.goal ?? { goal: null };
    else if (request.method === 'thread/backgroundTerminals/list') {
      assert.equal(resumed, true, 'installed native terminal enumeration is loaded-only');
      result = { data: options.background ?? [] };
    }
    else if (request.method === 'thread/resume') {
      resumed = true; options.resume?.();
      if (options.missingResumeAck) return;
      result = { thread: { id: 'original' } };
    } else if (request.method === 'turn/start') result = { turn: { id: 'native-run' } };
    else assert.fail(`Unexpected cold-load method ${request.method}`);
    f.runtime.receive(JSON.stringify({ id: request.id, result }));
  });
}

test('cold original FIFO durably authorizes one resume, persists its ACK, re-proves idle, then starts once', async t => {
  const f = await fixture(t, 2); coldTransport(f);
  assert.equal(await f.dispatch.dispatch(f.prepared), 'admitted');
  assert.deepEqual(f.writes.filter(w => ['thread/resume', 'turn/start'].includes(w.method)).map(w => w.method),
    ['thread/resume', 'turn/start']);
  assert.ok(f.kinds.indexOf('codexOwnedLoadBegin') < f.kinds.indexOf('codexOwnedLoadAcknowledge'));
  assert.ok(f.kinds.indexOf('codexOwnedLoadAcknowledge') < f.kinds.indexOf('codexOwnedLoadFinish'));
  assert.ok(f.writes.findIndex(w => w.method === 'thread/resume')
    < f.writes.findIndex(w => w.method === 'thread/backgroundTerminals/list'));
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.runId, 'native-run');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
});

function resumeNotifications(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [method, params] of [
    ['thread/status/changed', { threadId: 'original', status: { type: 'idle' } }],
    ['thread/tokenUsage/updated', { threadId: 'original', tokenUsage: null }],
    ['thread/goal/cleared', { threadId: 'original' }],
  ] as const) f.runtime.receive(JSON.stringify({ method, params }));
}

test('delayed resume notifications re-prove read-only evidence without repeating resume or input', async t => {
  const f = await fixture(t, 2);
  let loadedReads = 0;
  coldTransport(f, { read(loaded) { if (loaded && ++loadedReads === 1) resumeNotifications(f); } });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'admitted');
  assert.equal(loadedReads, 3, 'one invalidated read, then two fresh consistent history reads');
  assert.deepEqual(f.writes.filter(w => ['thread/resume', 'turn/start'].includes(w.method)).map(w => w.method),
    ['thread/resume', 'turn/start']);
  assert.equal(f.kinds.filter(k => k === 'codexOwnedLoadAcknowledge').length, 1);
  assert.equal(f.kinds.filter(k => k === 'codexOwnedLoadFinish').length, 1);
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
});

test('continuous post-resume activity has a bounded read-only budget and never repeats native effects', async t => {
  const f = await fixture(t);
  let loadedReads = 0;
  coldTransport(f, { read(loaded) { if (loaded) { loadedReads++; resumeNotifications(f); } } });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
  assert.equal(loadedReads, 3);
  assert.equal(f.writes.filter(w => w.method === 'thread/resume').length, 1);
  assert.equal(f.writes.some(w => w.method === 'turn/start'), false);
  assert.equal(f.kinds.includes('codexOwnedLoadFinish'), false);
  const count = f.writes.length;
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
  assert.equal(f.writes.length, count);
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
});

test('resume stabilization does not retry an original pre-load activity veto', async t => {
  const f = await fixture(t);
  let reads = 0;
  coldTransport(f, { read(loaded) { assert.equal(loaded, false); reads++; resumeNotifications(f); } });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
  assert.equal(reads, 1);
  assert.equal(f.writes.some(w => ['thread/resume', 'turn/start'].includes(w.method)), false);
});

test('post-resume stabilization never retries a failed native read', async t => {
  const f = await fixture(t);
  let loadedReads = 0, rejectNextRead = false;
  coldTransport(f, { read(loaded) {
    if (loaded && ++loadedReads === 1) { resumeNotifications(f); rejectNextRead = true; }
  } });
  const request = f.runtime.request.bind(f.runtime);
  let failedReads = 0;
  f.runtime.request = (method: string, ...args: unknown[]) => {
    if (method === 'thread/read' && rejectNextRead) { failedReads++; throw Error('unavailable read'); }
    return request(method, ...args);
  };
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
  assert.equal(failedReads, 1);
  assert.equal(f.writes.filter(w => w.method === 'thread/resume').length, 1);
  assert.equal(f.writes.some(w => w.method === 'turn/start'), false);
  assert.equal(f.kinds.includes('codexOwnedLoadFinish'), false);
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
});

for (const failure of ['busy', 'history-changed', 'goal', 'background', 'revoked', 'connection'] as const)
  test(`post-resume read stabilization never hides ${failure}`, async t => {
    const f = await fixture(t);
    let loadedReads = 0;
    const options: NonNullable<Parameters<typeof coldTransport>[1]> = { read(loaded) {
      if (!loaded || ++loadedReads !== 1) return;
      resumeNotifications(f);
      if (failure === 'busy') options.busy = true;
      if (failure === 'history-changed') options.changed = true;
      if (failure === 'goal') options.goal = {};
      if (failure === 'background') options.background = [{ processId: 'unsettled', itemId: 'tool' }];
      if (failure === 'revoked') f.local(() => { throw Error('revoked'); });
      if (failure === 'connection') f.runtime.connectionId = 'replacement';
    } };
    coldTransport(f, options);
    assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
    assert.equal(f.writes.filter(w => w.method === 'thread/resume').length, 1);
    assert.equal(f.writes.some(w => w.method === 'turn/start'), false);
    assert.equal(f.kinds.includes('codexOwnedLoadFinish'), false);
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
  });

for (const failure of ['goal', 'background', 'history-changed', 'busy', 'unknown-ack', 'begin-reply', 'ack-reply',
  'finish-reply', 'revoked', 'connection', 'cleanup', 'child'] as const)
  test(`cold original FIFO retains unknown and never starts/retries on ${failure}`, async t => {
    const f = await fixture(t);
    coldTransport(f, {
      ...(failure === 'goal' ? { goal: {} } : {}),
      ...(failure === 'background' ? { background: [{ processId: 'original-process', itemId: 'original-tool' }] } : {}),
      ...(failure === 'history-changed' ? { changed: true } : {}),
      ...(failure === 'busy' ? { busy: true } : {}),
      ...(failure === 'unknown-ack' ? { missingResumeAck: true } : {}),
      ...(failure === 'cleanup' ? { items: [{ type: 'commandExecution', id: 'unproven-command', status: 'completed' }] } : {}),
      ...(failure === 'child' ? { items: [{ type: 'subAgentActivity', id: 'unproven-child' }] } : {}),
      ...(failure === 'revoked' ? { resume: () => f.local(() => { throw Error('revoked'); }) } : {}),
      ...(failure === 'connection' ? { resume: () => { f.runtime.connectionId = 'replacement'; } } : {}),
    });
    const lostReplies: Partial<Record<typeof failure, ConnectorOwnerKind>> = {
      'begin-reply': 'codexOwnedLoadBegin', 'ack-reply': 'codexOwnedLoadAcknowledge',
      'finish-reply': 'codexOwnedLoadFinish' };
    const lostKind = lostReplies[failure];
    if (lostKind) f.hook(async (kind, _input, run) => {
      const result = await run(); if (kind === lostKind) throw Error('lost original reply'); return result;
    });
    assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
    assert.equal(f.writes.some(w => w.method === 'turn/start'), false);
    const count = f.writes.length;
    assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
    assert.equal(f.writes.length, count);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'unknown');
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
    if (failure === 'revoked' || failure === 'connection') assert.ok(f.kinds.includes('codexOwnedLoadAcknowledge'));
    if (failure === 'background') {
      assert.equal(f.writes.filter(w => w.method === 'thread/resume').length, 1);
      assert.ok(f.kinds.includes('codexOwnedLoadAcknowledge'), 'post-load orphan work never loses the original ACK');
      assert.equal(f.kinds.includes('codexOwnedLoadFinish'), false);
    }
  });

for (const count of [1, 2]) test(`real worker + original executor completes ${count}-member claim/ready/native/ACK without sync SQL`, async t => {
  const f = await fixture(t, count); f.onWrite(f.ack);
  assert.equal(Object.hasOwn((f.codex as any).options, 'turnQueue'), false);
  assert.equal(Object.hasOwn((f.codex as any).options, 'executions'), false);
  assert.equal(await f.dispatch.dispatch(f.prepared), 'admitted');
  assert.deepEqual(f.kinds, ['codexDispatchClaim', 'codexDispatchReady', 'codexExecutionAcknowledge']);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].params.cwd, 'C:\\isolated\\cwd');
  assert.equal(f.writes[0].params.model, 'test-model'); assert.equal(f.writes[0].params.clientUserMessageId, 'command-0');
  assert.deepEqual(f.writes[0].params.input, f.prepared.input);
  const fact = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
  assert.equal(fact?.runId, 'native-run'); assert.equal(fact?.phase, 'running');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  assert.ok(f.diagnostics.some(e => e.phase === 'pending' && e.step === 1));
  assert.ok(f.diagnostics.some(e => e.settled === 1));
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|command-0|original-connection|isolated|native-run/);
});

test('prepared input is snapshotted and the same session cannot dispatch twice while physical work waits', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  f.hook(async (kind, _input, run) => { if (kind === 'codexDispatchClaim') { entered.resolve(); await held.promise; } return run(); });
  f.onWrite(f.ack);
  const result = f.dispatch.dispatch(f.prepared); f.prepared.input[0] = { type: 'text', text: 'MUTATED' };
  await entered.promise;
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
  assert.equal(f.kinds.length, 1); held.resolve(); assert.equal(await result, 'admitted');
  assert.equal(f.writes[0].params.input[0].text, 'PRIVATE-BODY-0');
});

for (const [code, classification] of [[-32700, 1], [-32600, 2], [-32601, 3], [-32602, 4], [-32603, 5],
  [-32000, 6], [-32099, 6], [-31999, 0], [123456, 0], [undefined, 0]] as const) {
  test(`native RPC rejection class ${classification} is observable without releasing or replaying unknown input (${code})`, async t => {
    const f = await fixture(t);
    f.onWrite(() => f.runtime.receive(JSON.stringify({ id: f.writes[0].id,
      error: { code, message: 'PRIVATE native failure /private/path', data: { token: 'PRIVATE credential' } } })));
    assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
    const failure = f.diagnostics.find(row => row.phase === 'finished' && row.dispatchFailureStage !== undefined);
    assert.equal(failure?.dispatchFailureStage, 4);
    assert.equal(failure?.nativeRpcRejection, 1);
    assert.equal(failure?.nativeRpcErrorClass, classification);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'unknown');
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
    assert.equal(f.kinds.includes('codexExecutionAcknowledge'), false);
    assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
    assert.equal(f.writes.length, 1);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|private\/path|command-0|original-connection/);
  });
}

test('a transport write failure is not misreported as a native RPC rejection or safe to replay', async t => {
  const f = await fixture(t);
  f.onWrite(() => { throw Error('PRIVATE transport failure'); });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
  const failure = f.diagnostics.find(row => row.phase === 'finished' && row.dispatchFailureStage !== undefined);
  assert.equal(failure?.dispatchFailureStage, 4);
  assert.equal(failure?.nativeRpcRejection, 0);
  assert.equal(failure?.nativeRpcErrorClass, undefined);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'unknown');
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
  assert.equal(f.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE/);
});

for (const callback of ['async', 'promise', 'throw'] as const) {
  test(`original before-effect ${callback} callback cannot authorize native dispatch`, async t => {
    const f = await fixture(t);
    let invoked = false;
    const beforeEffect = callback === 'async' ? async () => { invoked = true; }
      : callback === 'promise' ? () => { invoked = true; return Promise.resolve(); }
      : () => { invoked = true; throw Error('observation changed'); };
    assert.equal(await f.dispatch.dispatch(f.prepared, undefined, beforeEffect), 'unknown');
    assert.equal(invoked, callback !== 'async', 'an async authority body must not be started');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'unknown');
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
  });
}

for (const race of ['revoked', 'connection', 'local-promise', 'observation', 'drained-activity', 'unscoped-activity']) test(`postclaim ${race} refuses write and preserves durable protection`, async t => {
  const f = await fixture(t), observation = deferred();
  f.hook(async (kind, _input, run) => {
    if (kind === 'codexDispatchReady') {
      if (race === 'revoked') await f.owner.command('tokenRevoke', { tokenId: f.actor });
      if (race === 'connection') f.runtime.connectionId = 'replacement';
      if (race === 'local-promise') f.local(async () => {});
      const result = await run();
      if (race === 'observation') f.runtime.nativeObservations.accept(() => observation.promise, 1, 1);
      if (race === 'drained-activity') f.runtime.recordNativeActivity(f.key.slice('codex:'.length));
      if (race === 'unscoped-activity') f.runtime.recordNativeActivity(undefined);
      return result;
    }
    return run();
  });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown'); observation.resolve();
  assert.equal(f.writes.length, 0); assert.equal(f.kinds.includes('codexExecutionAcknowledge'), false);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'unknown');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started', 'must never replay claimed unknown work');
});

for (const race of ['connection', 'close', 'revoked', 'projection-failure', 'lost-settlement-reply']) {
  test(`native ACK survives ${race} without downgrade or replay`, async t => {
    const f = await fixture(t); let closing: Promise<void> | undefined;
    if (race === 'projection-failure') f.settled(() => { throw Error('PRIVATE projection'); });
    f.hook(async (kind, _input, run) => {
      if (kind === 'codexExecutionAcknowledge' && race === 'revoked') await f.owner.command('tokenRevoke', { tokenId: f.actor });
      const value = await run();
      if (kind === 'codexExecutionAcknowledge' && race === 'lost-settlement-reply') throw Error('lost original reply');
      return value;
    });
    f.onWrite(() => {
      if (race === 'connection') f.runtime.connectionId = 'replacement';
      if (race === 'close') closing = f.dispatch.close();
      f.ack();
    });
    assert.equal(await f.dispatch.dispatch(f.prepared), race === 'lost-settlement-reply' ? 'unknown' : 'admitted');
    await closing;
    assert.equal(f.kinds.filter(k => k === 'codexDispatchFailure').length, 0);
    assert.equal(f.kinds.filter(k => k === 'codexExecutionAcknowledge').length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.runId, 'native-run');
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  });
}

test('close cannot drop an accepted worker claim that has not replied', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  f.hook(async (kind, _input, run) => {
    const value = await run();
    if (kind === 'codexDispatchClaim') { entered.resolve(); await held.promise; }
    return value;
  });
  const result = f.dispatch.dispatch(f.prepared); await entered.promise;
  let closed = false; const closing = f.dispatch.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
  held.resolve(); assert.equal(await result, 'unknown'); await closing;
  assert.equal(f.writes.length, 0); assert.equal(f.kinds.filter(k => k === 'codexDispatchFailure').length, 1);
});

test('native timeout retains original queue protection and a late ACK cannot start a retry', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.dispatch.dispatch(f.prepared); await f.written.promise;
  t.mock.timers.tick(21); assert.equal(await result, 'unknown');
  f.ack();
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
  assert.equal(f.writes.length, 1);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.reason, 'send_unknown');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
});

test('close drains private claim even when public Promise then is replaced', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred();
  f.hook(async (kind, _input, run) => {
    const value = await run();
    if (kind === 'codexDispatchClaim') { entered.resolve(); await gate.promise; }
    return value;
  });
  const work = f.dispatch.dispatch(f.prepared); await entered.promise;
  Object.defineProperty(work, 'then', { value: (done: (value: string) => unknown) => Promise.resolve(done('not_started')) });
  let closed = false; const closing = f.dispatch.close().then(() => { closed = true; });
  try { await tick(); assert.equal(closed, false); }
  finally { gate.resolve(); await closing; }
  assert.equal(await work, 'unknown'); assert.equal(f.writes.length, 0);
});

test('reentrant close during input clone sees private physical reservation', async t => {
  const f = await fixture(t); let closing: Promise<void> | undefined, closed = false;
  const input = { ...f.prepared, get input() {
    closing = f.dispatch.close().then(() => { closed = true; });
    return f.prepared.input;
  } };
  const work = f.dispatch.dispatch(input);
  assert.ok(closing); assert.equal(closed, false);
  assert.equal(await work, 'not_started'); await closing;
  assert.equal(f.writes.length, 0);
});

test('worker settlement failure never reconstructs owner or retries native', async t => {
  const f = await fixture(t);
  f.hook(async (kind, _input, run) => {
    if (kind === 'codexDispatchReady' || kind === 'codexDispatchFailure') throw Error('PRIVATE-worker-failure');
    return run();
  });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.kinds, ['codexDispatchClaim', 'codexDispatchReady', 'codexDispatchFailure']);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'starting');
});

test('lost committed claim reply is unknown, never a proof of not-started or permission to replay', async t => {
  const f = await fixture(t);
  f.hook(async (kind, _input, run) => {
    const result = await run();
    if (kind === 'codexDispatchClaim' && result) throw Error('lost original claim reply');
    return result;
  });
  assert.equal(await f.dispatch.dispatch(f.prepared), 'unknown');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.kinds, ['codexDispatchClaim']);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.phase, 'starting');
  assert.equal(await f.dispatch.dispatch(f.prepared), 'not_started');
  assert.equal(f.writes.length, 0);
});

// Keep the actual worker, original stdin writer and receive/ACK hooks. Only the
// unrelated native-history fetch is isolated: its terminal and checkpoint are
// settled through the real worker journal, never by inserting a display fact.
for (const variant of ['live-before-ack', 'live-after-ack', 'history-only', 'batch', 'foreign-owner',
  'reconnect', 'pending-history', 'active-goal', 'malformed-goal', 'absent-goal', 'active-native',
  'unavailable-projection', 'revoked-before-claim'] as const) {
  test(`owned automation provenance and SQL-free local veto: ${variant}`, async t => {
    const f = await fixture(t, variant === 'batch' ? 2 : 1, true), journal = f.projection!.nativeJournal();
    f.runtime.handleNotification = () => {}; // receive's live capture remains original.
    const emit = () => f.runtime.receive(JSON.stringify({ method: 'turn/completed',
      params: { threadId: 'original', turn: { id: 'native-run', status: 'completed' } } }));
    f.onWrite(() => { if (variant === 'live-before-ack') emit(); f.ack(); });
    if (variant === 'revoked-before-claim') await f.owner.command('tokenRevoke', { tokenId: f.actor });
    assert.equal(await f.dispatch.dispatch(f.prepared), variant === 'revoked-before-claim' ? 'not_started' : 'admitted');
    if (variant === 'revoked-before-claim') {
      assert.equal(f.writes.length, 0); assert.deepEqual(f.codex.takeOwnedAutomationCompletions(f.actor), []); return;
    }
    if (variant !== 'live-before-ack' && variant !== 'history-only') emit();
    let fact = await journal.readExecution(f.key); assert.ok(fact);
    assert.equal(await journal.observeTerminal(fact, 'original-connection', 'native-run', 'completed'), true);
    fact = await journal.readExecution(f.key); assert.ok(fact);
    if (variant !== 'pending-history') assert.equal(await journal.settleHistory(fact, 'current', {
      turnId: 'native-run', fingerprint: 'a'.repeat(64), connectionId: 'original-connection', state: 'verified', reason: 'settled',
    }), true);
    f.runtime.threadRefreshResult.set(f.key, { at: Date.now(), available: true });
    if (variant === 'active-goal' || variant === 'malformed-goal') f.store.upsertSession({ sessionKey: f.key, agentId: 'codex', title: 'Original', status: 'idle',
      codexGoal: { status: variant === 'active-goal' ? 'active' : 'complete', objective: 'Original goal',
        objectiveTruncated: false, tokenBudget: null, tokensUsed: variant === 'malformed-goal' ? -1 : 0,
        timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
    if (variant === 'absent-goal') f.store.upsertSession({ sessionKey: f.key, agentId: 'codex', title: 'Original', status: 'idle' });
    if (variant === 'active-native') f.runtime.activeTurnIds.set(f.key, 'successor');
    if (variant === 'reconnect') f.runtime.setConnection('replacement');
    if (variant === 'unavailable-projection') await f.projection!.close();
    const originalGet = f.store.getSession;
    f.store.getSession = () => { throw Error('Decorated main-thread SQL forbidden'); };
    try {
      assert.throws(() => f.codex.automationObservation(f.key, f.actor), /owned|journal|synchronous/i);
      assert.throws(() => f.codex.takeAutomationCompletions(f.actor), /owned|journal|synchronous/i);
      assert.equal(Object.hasOwn(f.codex.ownedAutomationObservation(f.key), 'admissionAllowed'), false);
      const result = f.codex.takeOwnedAutomationCompletions(variant === 'foreign-owner' ? 'foreign' : f.actor);
      assert.equal(result.length, variant === 'live-before-ack' || variant === 'live-after-ack' ? 1 : 0);
      if (result.length) {
        assert.equal(result[0]!.actorId, f.actor); assert.equal(result[0]!.commandId, 'command-0');
        assert.equal(result[0]!.turnId, 'native-run'); emit();
        assert.deepEqual(f.codex.takeOwnedAutomationCompletions(f.actor), []);
      }
    } finally { f.store.getSession = originalGet; }
  });
}
