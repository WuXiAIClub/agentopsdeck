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
import { AsyncCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexPreparation, type CodexPreparedCompaction } from './async-codex-preparation.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import type { ConnectorOwnerKind } from './connector-owner-domain.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const silent = new PerformanceDiagnostics(() => {});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: import('node:test').TestContext, count = 1, recoveryMode = false) {
  const directory = mkdtempSync(join(tmpdir(), 'owned-codex-preparation-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-preparation' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const actor = tokens.authenticateAuthorization(`Bearer ${config.bootstrapToken}`)!.tokenId;
  const key = 'codex:original', connectionId = 'original-connection';
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  for (let i = 0; i < count; i++) await seed.turns.enqueueAsync('codex', { id: `command-${i}`, sessionKey: key, createdAt: i,
    payload: { text: `PRIVATE-${i}`, images: [], actorId: actor } });
  const entries = seed.turns.list<{ text: string; images: []; actorId: string }>('codex', key), batch = describeBatch(entries);
  const claim = { sessionKey: key, commandId: 'command-0', connectionId, preparing: true, blockedGoalInput: false,
    proof: codexAdmissionProof(seed.turns, entries), ...(batch ? { batch } : {}) };
  seed.close();
  const owner = new AsyncConnectorOwner(config, silent); await owner.open();
  const receipt = await owner.command('codexDispatchClaim', claim); assert.ok(receipt);
  const input: CodexPreparedCompaction = { expected: { sessionKey: key, commandId: claim.commandId, connectionId,
    revision: receipt.execution.revision, proof: receipt.proof }, previousRunId: 'old-run' };
  const localDB = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: 'C:\\isolated\\cwd',
    defaultModel: 'synthetic', approvalPolicy: 'never', store: recoveryMode ? new DeckStore() : store, turnQueue: localDB.turns,
    executions: localDB.codexExecutions, authorizeTurn: () => { throw Error('Synchronous authority forbidden'); }, requestTimeoutMs: 30 });
  const runtime = codex as any, writes: any[] = [], written = deferred();
  // Isolate the legacy constructor's binding from the recovery display lane;
  // this fixture is not evidence of production startup/cutover integration.
  if (recoveryMode) runtime.options.store = store;
  let onWrite: ((row: any) => void) | undefined;
  runtime.connectionId = connectionId;
  runtime.loadedThreadIds.add('original');
  runtime.child = { stdin: { writable: true, write(line: string) {
    const row = JSON.parse(line); writes.push(row); written.resolve(); onWrite?.(row); return true;
  } } };
  const get = localDB.codexExecutions.get, list = localDB.turns.list, getSession = store.getSession;
  localDB.codexExecutions.get = () => { throw Error('Main-thread execution SQL forbidden'); };
  localDB.turns.list = () => { throw Error('Main-thread queue SQL forbidden'); };
  store.getSession = () => { throw Error('Decorated synchronous projection forbidden'); };
  const kinds: ConnectorOwnerKind[] = [], diagnostics: any[] = [];
  let hook: ((kind: ConnectorOwnerKind, input: any, run: () => Promise<any>) => Promise<any>) | undefined;
  const port = { command: ((kind: ConnectorOwnerKind, value: any) => {
    kinds.push(kind); const run = () => owner.command(kind, value); return hook ? hook(kind, value, run) : run();
  }) as AsyncConnectorOwner['command'] };
  let local: (() => void) | undefined;
  // Compaction/rollback fixtures model the already-loaded original thread;
  // cold owned loading is covered separately, not by an empty native reply.
  runtime.loadedThreadIds.add('original');
  const preparation = new AsyncCodexPreparation({ owner: port, runtime: codex, local: () => local?.(),
    diagnostics: new PerformanceDiagnostics(line => diagnostics.push(JSON.parse(line)), () => 0) });
  const dispatch = new AsyncCodexDispatch({ owner: port, runtime: codex, local() {} });
  let projection: AsyncCodexProjection | undefined;
  t.after(async () => {
    await preparation.close(); await dispatch.close();
    await projection?.close();
    localDB.codexExecutions.get = get; localDB.turns.list = list; store.getSession = getSession;
    runtime.child = undefined; await codex.close(); localDB.close(); await owner.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const ack = (row = writes.at(-1), result?: unknown) => runtime.receive(JSON.stringify({ id: row.id,
    result: result ?? (row.method === 'turn/start' ? { turn: { id: 'next-run' } } : {}) }));
  const complete = (turnId = 'compact-run') => {
    for (const method of ['item/started', 'item/completed']) runtime.handleNotification(method, {
      threadId: 'original', turnId, item: { id: 'compact-item', type: 'contextCompaction' },
    });
    runtime.handleNotification('turn/completed', { threadId: 'original', turn: { id: turnId, status: 'completed' } });
  };
  return { owner, actor, key, codex, runtime, preparation, dispatch, input, claim, receipt, kinds, diagnostics, writes, written, ack, complete,
    store,
    async recovery() {
      assert.ok(recoveryMode);
      projection = new AsyncCodexProjection({ owner: port, deck: store, connectionId: () => connectionId, diagnostics: silent });
      await projection.open(); store.getSession = getSession;
      runtime.options.historyReader = new AsyncCodexHistory(port, silent);
      store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'isolated recovery', status: 'idle' });
      store.addMessage({ id: 'old-failure', sessionKey: key, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
      runtime.threadRefreshResult.set(key, { at: Date.now(), available: true });
    },
    onWrite(fn: NonNullable<typeof onWrite>) { onWrite = fn; }, hook(fn: NonNullable<typeof hook>) { hook = fn; },
    local(fn: () => void) { local = fn; } };
}

for (const count of [1, 2]) test(`real worker + ORIGINAL compactor completes preparation and ${count}-member original continuation`, async t => {
  const f = await fixture(t, count);
  f.onWrite(row => { f.ack(row); if (row.method === 'thread/compact/start') f.complete(); });
  assert.equal(await f.preparation.compact(f.input), 'ready');
  assert.deepEqual(f.kinds, ['codexPreparationReady', 'codexPreparationFinish']);
  const ready = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
  assert.equal(ready?.preparation, 'ready'); assert.equal(ready?.revision, f.input.expected.revision + 1);
  assert.equal(await f.dispatch.dispatch({ claim: { ...f.claim, preparing: false, proof: f.receipt.proof },
    input: [{ type: 'text', text: 'PRIVATE-ORIGINAL' }], interactive: false }), 'admitted');
  assert.deepEqual(f.writes.map(row => row.method), ['thread/compact/start', 'turn/start']);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.runId, 'next-run');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  assert.equal(await f.preparation.compact(f.input), 'unknown'); assert.equal(f.writes.length, 2);
  assert.ok(f.diagnostics.some(row => row.step === 10 && row.phase === 'pending'));
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|command-0|original-connection|old-run|compact-run/);
});

for (const order of ['ack-first', 'event-first'] as const) test(`original compaction requires BOTH ACK and completion: ${order}`, async t => {
  const f = await fixture(t); let done = false;
  f.onWrite(() => { if (order === 'ack-first') f.ack(); else f.complete(); });
  const result = f.preparation.compact(f.input).then(value => { done = true; return value; });
  await f.written.promise; await tick();
  assert.equal(done, false); assert.equal(f.kinds.includes('codexPreparationFinish'), false);
  if (order === 'ack-first') f.complete(); else f.ack();
  assert.equal(await result, 'ready');
});

for (const fault of ['revoked', 'connection', 'local-promise', 'native-observation', 'bad-revision', 'old-proof'] as const) {
  test(`preparation ${fault} refuses native write and retains original protection`, async t => {
    const f = await fixture(t), observation = deferred();
    if (fault === 'bad-revision') f.input.expected.revision++;
    if (fault === 'old-proof') f.input.expected.proof = f.claim.proof;
    f.hook(async (kind, _input, run) => {
      if (kind === 'codexPreparationReady') {
        if (fault === 'revoked') await f.owner.command('tokenRevoke', { tokenId: f.actor });
        if (fault === 'connection') f.runtime.connectionId = 'replacement';
        if (fault === 'local-promise') f.local(async () => {});
        const value = await run();
        if (fault === 'native-observation') f.runtime.nativeObservations.accept(() => observation.promise, 1, 1);
        return value;
      }
      return run();
    });
    assert.equal(await f.preparation.compact(f.input), 'unknown'); observation.resolve();
    assert.equal(f.writes.length, 0); assert.equal(f.kinds.includes('codexPreparationFinish'), false);
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
    assert.equal(await f.preparation.compact(f.input), 'unknown'); assert.equal(f.writes.length, 0);
  });
}

for (const fault of ['lost-ack', 'native-error', 'revoke-after-effect', 'lost-finish-reply', 'lost-failure-reply'] as const) {
  test(`preparation ${fault} never replays compaction or releases FIFO`, async t => {
    const f = await fixture(t);
    f.onWrite(row => {
      f.complete();
      if (fault === 'lost-ack' || fault === 'lost-failure-reply') return;
      if (fault === 'native-error') f.runtime.receive(JSON.stringify({ id: row.id, error: { message: 'PRIVATE native failure' } }));
      else f.ack(row);
    });
    f.hook(async (kind, _input, run) => {
      if (kind === 'codexPreparationFinish' && fault === 'revoke-after-effect') await f.owner.command('tokenRevoke', { tokenId: f.actor });
      const value = await run();
      if (kind === 'codexPreparationFinish' && fault === 'lost-finish-reply'
        || kind === 'codexDispatchFailure' && fault === 'lost-failure-reply') throw Error('lost original IPC');
      return value;
    });
    assert.equal(await f.preparation.compact(f.input), 'unknown');
    assert.equal(f.writes.length, 1); assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
    if (fault === 'lost-finish-reply') assert.equal(fact?.preparation, 'ready');
    else if (fault !== 'revoke-after-effect') assert.equal(fact?.phase, 'unknown');
    assert.equal(await f.preparation.compact(f.input), 'unknown'); assert.equal(f.writes.length, 1);
  });
}

test('private physical drain survives caller Promise tampering while worker authorization waits', async t => {
  const f = await fixture(t), entered = deferred(), held = deferred();
  f.hook(async (kind, _input, run) => {
    if (kind === 'codexPreparationReady') { entered.resolve(); await held.promise; }
    return run();
  });
  const task = f.preparation.compact(f.input);
  Object.defineProperty(task, 'then', { value() { throw Error('caller Promise must not own physical drain'); } });
  await entered.promise;
  assert.equal(f.runtime.compactWaiters.get('original').accepting, false);
  let closed = false; const closing = f.preparation.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); held.resolve();
  assert.equal(await task, 'unknown'); await closing; assert.equal(f.writes.length, 0);
});

test('runtime close drains owned authorization and original waiter without leaving a compact timer', async t => {
  const f = await fixture(t), entered = deferred(), held = deferred();
  f.hook(async (kind, _input, run) => { if (kind === 'codexPreparationReady') { entered.resolve(); await held.promise; } return run(); });
  const task = f.preparation.compact(f.input); await entered.promise;
  let closed = false; f.runtime.child = undefined;
  const closing = f.codex.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  held.resolve(); assert.equal(await task, 'unknown'); await closing;
  assert.equal(f.writes.length, 0); assert.equal(f.runtime.compactWaiters.size, 0);
});

test('predecessor completion cannot satisfy the original compaction completion proof', async t => {
  const f = await fixture(t); f.onWrite(() => { f.ack(); f.complete('old-run'); });
  let done = false; const task = f.preparation.compact(f.input).then(value => { done = true; return value; });
  await f.written.promise; await tick(); assert.equal(done, false);
  assert.equal(f.kinds.includes('codexPreparationFinish'), false); f.complete(); assert.equal(await task, 'ready');
});

test('diagnostic sink failure cannot revoke a proven preparation finish', async t => {
  const f = await fixture(t); f.onWrite(() => { f.ack(); f.complete(); });
  const preparation = new AsyncCodexPreparation({ owner: f.owner, runtime: f.codex, local() {},
    diagnostics: new PerformanceDiagnostics(() => { throw Error('diagnostics unavailable'); }, () => 0) });
  assert.equal(await preparation.compact(f.input), 'ready'); await preparation.close();
  assert.equal(f.writes.length, 1);
});

function recoverySnapshot() {
  return { thread: { id: 'original', status: { type: 'idle' }, turns: [
    { id: 'kept-run', status: 'completed', items: [
      { id: 'kept-input', type: 'userMessage', content: [{ type: 'text', text: 'PRIVATE retained input' }] },
      { id: 'kept-output', type: 'agentMessage', text: 'PRIVATE retained context' },
    ] },
    { id: 'old-run', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] },
  ] } };
}

for (const count of [1, 2]) test(`owned original recovery closes history→rollback→projection→compaction→${count}-member continuation`, async t => {
  const f = await fixture(t, count, true); await f.recovery();
  f.onWrite(row => {
    f.ack(row, row.method === 'thread/read' ? recoverySnapshot() : undefined);
    if (row.method === 'thread/compact/start') f.complete();
  });
  assert.deepEqual(await f.preparation.recover(f.input), { state: 'ready', context: 'PRIVATE retained context' });
  assert.deepEqual(f.writes.map(row => row.method), ['thread/read', 'thread/rollback', 'thread/compact/start']);
  assert.equal(f.writes[1].params.numTurns, 1);
  const messages = f.store.getMessages(f.key);
  assert.ok(messages.some(message => message.text === 'PRIVATE retained input'));
  assert.ok(messages.some(message => message.text === 'PRIVATE retained context'));
  assert.ok(!messages.some(message => message.id === 'old-failure'));
  for (let index = 0; index < count; index++) assert.ok(messages.some(message => message.id === `command-${index}`));
  assert.equal(await f.dispatch.dispatch({ claim: { ...f.claim, preparing: false, proof: f.receipt.proof },
    input: [{ type: 'text', text: 'original continuation' }], interactive: false }), 'admitted');
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
  assert.equal((await f.preparation.recover(f.input)).state, 'unknown');
  assert.equal(await f.preparation.compact(f.input), 'unknown');
  assert.equal(f.writes.length, 4, 'one receipt cannot replay via the other preparation API');
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE retained/);
});

test('recovery without rollback finishes original preparation without unsolicited compaction', async t => {
  const f = await fixture(t, 1, true); await f.recovery();
  const snapshot = recoverySnapshot(); snapshot.thread.turns.pop();
  f.onWrite(row => f.ack(row, snapshot));
  assert.deepEqual(await f.preparation.recover(f.input), { state: 'ready' });
  assert.deepEqual(f.writes.map(row => row.method), ['thread/read']);
  assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: f.key }))?.preparation, 'ready');
});

for (const fault of ['active', 'unready', 'missing-reader', 'resources', 'projection-during-read', 'read-error', 'rollback-error',
  'rollback-lost-ack', 'projection-during-plan', 'revoke-after-rollback', 'connection-after-rollback',
  'generation-aba-after-rollback', 'child-after-rollback', 'finish-lost-reply'] as const) {
  test(`owned recovery preserves original protection and never replays: ${fault}`, async t => {
    const f = await fixture(t, 1, true); await f.recovery();
    if (fault === 'unready') f.runtime.threadRefreshResult.delete(f.key);
    if (fault === 'missing-reader') f.runtime.options.historyReader = undefined;
    if (fault === 'resources') f.runtime.activeSecretFiles.set(f.key, { commandId: 'predecessor', directory: 'must-not-delete', dispatched: true });
    if (fault === 'projection-during-plan') {
      const reader = f.runtime.options.historyReader, prepare = reader.prepare.bind(reader);
      reader.prepare = async (...args: any[]) => {
        const plan = await prepare(...args); f.runtime.projectionVersions.set(f.key, 10); return plan;
      };
    }
    if (fault === 'finish-lost-reply') f.hook(async (kind, _input, run) => {
      const value = await run(); if (kind === 'codexPreparationFinish') throw Error('lost reply'); return value;
    });
    if (['revoke-after-rollback', 'connection-after-rollback', 'generation-aba-after-rollback', 'child-after-rollback'].includes(fault)) {
      f.hook(async (kind, _input, run) => {
        const value = await run();
        if (kind === 'codexHistoryOpen') {
          if (fault === 'revoke-after-rollback') await f.owner.command('tokenRevoke', { tokenId: f.actor });
          if (fault === 'connection-after-rollback') f.runtime.connectionId = 'replacement';
          if (fault === 'generation-aba-after-rollback') f.runtime.nativeConnectionGeneration++;
          if (fault === 'child-after-rollback') f.runtime.child = { stdin: f.runtime.child.stdin };
        }
        return value;
      });
    }
    f.onWrite(row => {
      if (row.method === 'thread/read') {
        const snapshot = recoverySnapshot();
        if (fault === 'active') snapshot.thread.status.type = 'active';
        if (fault === 'projection-during-read') f.runtime.projectionVersions.set(f.key, 10);
        if (fault === 'read-error') f.runtime.receive(JSON.stringify({ id: row.id, error: { message: 'synthetic read failure' } }));
        else f.ack(row, snapshot);
      } else if (row.method === 'thread/rollback') {
        if (fault === 'rollback-lost-ack') return;
        if (fault === 'rollback-error') f.runtime.receive(JSON.stringify({ id: row.id, error: { message: 'synthetic rollback failure' } }));
        else f.ack(row);
      } else { f.ack(row); f.complete(); }
    });
    try {
      assert.deepEqual(await f.preparation.recover(f.input), { state: 'unknown' });
      const methods = f.writes.map(row => row.method);
      assert.equal(methods.filter(method => method === 'thread/rollback').length,
        ['unready', 'missing-reader', 'resources', 'active', 'projection-during-read', 'read-error'].includes(fault) ? 0 : 1);
      assert.equal(methods.includes('thread/compact/start'), fault === 'finish-lost-reply');
      assert.equal((await f.preparation.recover(f.input)).state, 'unknown');
      assert.equal(await f.preparation.compact(f.input), 'unknown');
      assert.deepEqual(f.writes.map(row => row.method), methods);
      assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
      const fact = await f.owner.command('codexExecutionRead', { sessionKey: f.key });
      if (fault === 'finish-lost-reply') assert.equal(fact?.preparation, 'ready');
      else assert.notEqual(fact?.preparation, 'ready');
    } finally { if (fault === 'resources') f.runtime.activeSecretFiles.delete(f.key); }
  });
}

test('recovery close drains physical authorization and never continues rollback', async t => {
  const f = await fixture(t, 1, true); await f.recovery();
  const held = deferred(), entered = deferred();
  f.onWrite(row => f.ack(row, recoverySnapshot()));
  f.hook(async (kind, _input, run) => {
    if (kind === 'codexPreparationReady' && f.writes.length === 1) { entered.resolve(); await held.promise; }
    return run();
  });
  const task = f.preparation.recover(f.input); await entered.promise;
  let closed = false;
  const closing = f.preparation.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  held.resolve(); assert.deepEqual(await task, { state: 'unknown' }); await closing;
  assert.deepEqual(f.writes.map(row => row.method), ['thread/read']);
  assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1);
});
