import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkCompactDispatch } from './async-sdk-compact-dispatch.js';
import type { SdkCompactAdapter, SdkCompactExecution } from './sdk-compact-dispatch.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import { connectorSdkCompactSteps, validConnectorSdkCompactInput, validConnectorSdkCompactOutput } from './connector-sdk-compact-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const authorization = 'Bearer isolated-compact-test-token';
const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixtureStorage(runtime: SdkAgentId, file: string) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-async-compact-'));
  const tokenFile = join(directory, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile, 'isolated-compact-test-token');
  const actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(file, (token, action) => tokens.hasScope(token, 'execution:delegate')
    && tokens.hasScope(token, 'messages:send') && (action !== 'messages:mirror' || tokens.hasScope(token, 'messages:mirror')), { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal, key = `${runtime}:session`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const turn = { id: 'original', sessionKey: key, createdAt: 0, payload: { actorId, text: 'first', images: [] } };
  return { directory, tokenFile, tokens, actorId, store, journal, key, turn };
}
function fixture(runtime: SdkAgentId) {
  const setup = fixtureStorage(runtime, ':memory:');
  setup.store.turns.enqueue(runtime, setup.turn);
  return finishFixture(runtime, setup);
}
async function fixtureAsync(runtime: SdkAgentId, file: string) {
  const setup = fixtureStorage(runtime, file);
  await setup.store.turns.enqueueAsync(runtime, setup.turn);
  return finishFixture(runtime, setup);
}
function finishFixture(runtime: SdkAgentId, setup: ReturnType<typeof fixtureStorage>) {
  const { directory, tokenFile, tokens, actorId, store, journal, key } = setup;
  const first = { key, id: 'first', epoch: 'old' };
  journal.begin(first, ['original'], store.turns); journal.observeTerminal(first, 'completed', store.turns); journal.confirmSettled(first);
  const owner = { command: createConnectorOwnerCommands(store, tokens) }, calls: SdkCompactExecution[] = [];
  const adapter: SdkCompactAdapter = { runtime, epoch: 'epoch', ready: true,
    compact: async e => { calls.push(e); return { ...e, nativeRequestId: 'request', completionEventId: 'boundary', outcome: 'completed' }; },
    inspectSettlement: async e => ({ ...e, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }) };
  const options = { owner, adapter, deadlineMs: 1000, models: { model: 'default' }, diagnostics: silent };
  const scope = JSON.stringify(['compact', JSON.stringify([actorId, key])]);
  const request = { runtime, key, id: 'compact', epoch: 'epoch', commandKey: 'command', nativeSessionId: 'native', model: null, authorization };
  const db = (store as unknown as { db: DatabaseSync }).db;
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { directory, tokenFile, tokens, actorId, store, journal, key, owner, calls, adapter, options, scope, request, db, close };
}

test('compact protocol appends fixed commands and rejects supplied authority/native options', () => {
  assert.deepEqual(Object.values(connectorSdkCompactSteps), [86, 87, 88, 111]);
  const f = fixture('ghcp');
  try {
    assert.equal(validConnectorSdkCompactInput('sdkCompactClaim', f.request), true);
    for (const extra of ['actorId', 'authorized', 'executionGrant', 'sql', 'callback', 'summaryContent', 'models']) {
      assert.equal(validConnectorSdkCompactInput('sdkCompactClaim', { ...f.request, [extra]: true }), false);
    }
    for (const bad of [{ runtime: 'codex' }, { key: 'claude-code:other' }, { commandKey: 'bad key' }, { model: 'bad model' }, { authorization: 'bad\nheader' }]) {
      assert.equal(validConnectorSdkCompactInput('sdkCompactClaim', { ...f.request, ...bad }), false);
    }
    assert.equal(validConnectorSdkCompactOutput('sdkCompactClaim', { error: '403' }), false);
  } finally { f.close(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: maintenance blocks fresh compact admission but preserves original terminal and history settlement`, async () => {
    const f = fixture(runtime), result = deferred<void>();
    let admission = false;
    try {
      f.adapter.compact = async e => {
        f.calls.push(e); await result.promise;
        return { ...e, nativeRequestId: 'request', completionEventId: 'boundary', outcome: 'completed' };
      };
      const dispatcher = new AsyncSdkCompactDispatch({ ...f.options, admissionReady: () => admission });
      assert.equal(await dispatcher.dispatch(f.key, 'paused', authorization), 'not_started');
      assert.equal(f.store.commands.get(f.scope, 'paused'), undefined);
      admission = true;
      const pending = dispatcher.dispatch(f.key, 'command', authorization);
      while (!f.calls.length) await tick();
      admission = false; dispatcher.pause(); result.resolve();
      assert.equal(await pending, 'accepted');
      assert.equal(f.journal.current(f.key)?.phase, 'settling');
      assert.equal(await dispatcher.settle(f.calls[0]!), true);
      assert.equal(f.journal.current(f.key)?.phase, 'completed');
      assert.equal(f.calls.length, 1);
    } finally { result.resolve(); f.close(); }
  });

  test(`${runtime}: receipt and original compact intent commit together, duplicate never invokes native`, async () => {
    const f = fixture(runtime), observations: string[] = [];
    try {
      f.adapter.compact = async e => {
        assert.equal(f.journal.current(f.key)?.id, e.id);
        assert.equal(f.store.commands.get(f.scope, 'command')?.result?.body.runId, e.id);
        f.calls.push(e); return { ...e, nativeRequestId: 'request', completionEventId: 'boundary', outcome: 'completed' };
      };
      const dispatcher = new AsyncSdkCompactDispatch({ ...f.options, diagnostics: new PerformanceDiagnostics(line => observations.push(line)) });
      assert.equal(await dispatcher.dispatch(f.key, 'command', authorization), 'accepted');
      assert.equal(f.calls.length, 1); assert.equal(f.journal.current(f.key)?.phase, 'settling');
      assert.equal(await dispatcher.settle(f.calls[0]!), true);
      assert.equal(f.journal.current(f.key)?.phase, 'completed');
      assert.equal(await dispatcher.dispatch(f.key, 'command', authorization), 'accepted');
      assert.equal(f.calls.length, 1);
      assert.ok(observations.some(line => line.includes('sdk-async-compact')));
      assert.ok(!observations.join('').includes('isolated-compact-test-token'));
      assert.ok(!observations.join('').includes('boundary'));
    } finally { f.close(); }
  });
  for (const fault of ['queue', 'settings', 'model', 'native-id', 'not-ready', 'revoked', 'read-only'] as const) {
    test(`${runtime}: compact ${fault} cannot admit native`, async () => {
      const f = fixture(runtime);
      try {
        if (fault === 'queue') f.store.turns.enqueue(runtime, { id: 'waiting', sessionKey: f.key, createdAt: 0, payload: {} });
        if (fault === 'settings') await f.store.commands.claimAsync(JSON.stringify(['settings', JSON.stringify([f.actorId, f.key])]), 'settings', {}, false,
          undefined, undefined, undefined, true);
        if (fault === 'model') f.journal.updateModel(f.key, 'unlisted', () => {});
        if (fault === 'not-ready') (f.adapter as { ready: boolean }).ready = false;
        if (fault === 'revoked') f.tokens.revoke(f.actorId);
        let auth = authorization;
        if (fault === 'read-only') {
          const created = f.tokens.create({ label: 'reader', scopes: ['messages:read'] }); auth = `Bearer ${created.token}`;
        }
        const owner = fault === 'native-id' ? { command: (async (kind, input) => {
          if (kind === 'sdkCompactClaim') f.db.prepare("UPDATE sdk_agent_sessions SET data=json_set(data,'$.nativeSessionId','changed') WHERE runtime=?").run(runtime);
          return f.owner.command(kind, input);
        }) as typeof f.owner.command } : f.owner;
        const task = new AsyncSdkCompactDispatch({ ...f.options, owner }).dispatch(f.key, 'command', auth);
        // A changed stored identity invalidates the correlated snapshot. Its
        // failure is not a definitive rejection of a possibly durable claim.
        if (fault === 'native-id') await assert.rejects(task);
        else assert.ok(['not_started', 'blocked'].includes(await task));
        assert.equal(f.calls.length, 0);
        assert.equal(f.journal.current(f.key)?.id, 'first');
      } finally { f.close(); }
    });
  }
  for (const fault of ['revoke', 'epoch', 'pause', 'abort', 'wrong-ref', 'wrong-receipt', 'wrong-native', 'timeout'] as const) {
    test(`${runtime}: compact ${fault} after original claim preserves protection, never invokes native`, async () => {
      const f = fixture(runtime), controller = new AbortController(), late = deferred<void>();
      let dispatcher!: AsyncSdkCompactDispatch;
      const owner = { command: (async (kind, input) => {
        const value = await f.owner.command(kind, input);
        if (kind === 'sdkCompactClaim' && value && typeof value === 'object' && 'execution' in value && 'receipt' in value) {
          if (fault === 'revoke') f.tokens.revoke(f.actorId);
          if (fault === 'epoch') (f.adapter as { epoch: string }).epoch = 'new';
          if (fault === 'pause') dispatcher.pause();
          if (fault === 'abort') controller.abort();
          if (fault === 'wrong-ref') return { ...value, execution: { ...value.execution!, id: 'wrong' }, receipt: { ...value.receipt, result: { status: 200, body: { ok: true, status: 'compacting', runId: 'wrong' } } } };
          if (fault === 'wrong-receipt') return { ...value, receipt: { ...value.receipt, key: 'other' } };
          if (fault === 'wrong-native') return { ...value, execution: { ...value.execution!, nativeSessionId: 'other' } };
          if (fault === 'timeout') await late.promise;
        }
        return value;
      }) as typeof f.owner.command };
      dispatcher = new AsyncSdkCompactDispatch({ ...f.options, owner, deadlineMs: fault === 'timeout' ? 20 : 1000 });
      try {
        const task = dispatcher.dispatch(f.key, 'command', authorization, controller.signal);
        if (['abort', 'wrong-ref', 'wrong-receipt', 'wrong-native', 'timeout'].includes(fault)) await assert.rejects(task);
        else assert.equal(await task, 'unknown');
        late.resolve(); await tick(); await tick();
        assert.equal(f.calls.length, 0); assert.equal(f.store.commands.get(f.scope, 'command')?.state, 'accepted');
        assert.equal(f.journal.canStart(f.key), false);
        assert.ok(['unknown', 'dispatching'].includes(f.journal.current(f.key)!.phase));
      } finally { late.resolve(); f.close(); }
    });
  }
  test(`${runtime}: rollback of receipt acceptance also rolls back compact intent and settings fence`, async () => {
    const f = fixture(runtime);
    try {
      f.db.exec("CREATE TRIGGER isolated_compact_failure BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'isolated receipt failure'); END");
      await assert.rejects(f.owner.command('sdkCompactClaim', f.request), /isolated receipt failure/);
      assert.equal(f.store.commands.get(f.scope, 'command'), undefined);
      assert.equal(f.journal.current(f.key)?.id, 'first'); assert.equal(f.journal.session(f.key)?.nativeState, 'ready');
      assert.equal(f.journal.canStart(f.key), true);
    } finally { f.close(); }
  });
  test(`${runtime}: lost native result stays unknown, late result cannot settle or replay`, async () => {
    const f = fixture(runtime), native = deferred<Awaited<ReturnType<SdkCompactAdapter['compact']>>>();
    try {
      f.adapter.compact = async e => { f.calls.push(e); return native.promise; };
      const dispatcher = new AsyncSdkCompactDispatch({ ...f.options, deadlineMs: 20 });
      assert.equal(await dispatcher.dispatch(f.key, 'command', authorization), 'unknown');
      assert.equal(f.journal.current(f.key)?.phase, 'unknown');
      native.resolve({ ...f.calls[0]!, nativeRequestId: 'late', completionEventId: 'late', outcome: 'completed' }); await tick();
      assert.equal(f.journal.current(f.key)?.phase, 'unknown'); assert.equal(f.calls.length, 1);
      assert.equal(await dispatcher.dispatch(f.key, 'command', authorization), 'not_started');
    } finally { f.close(); }
  });
  test(`${runtime}: dedicated compact stop persists before native and ACK is not settlement`, async () => {
    const f = fixture(runtime);
    try {
      const admitted = await f.owner.command('sdkCompactClaim', f.request); assert.ok('execution' in admitted && admitted.execution);
      const ref = admitted.execution as SdkCompactRef;
      let stops = 0;
      f.adapter.interruptCompact = async e => { stops++; assert.equal(f.journal.current(f.key)?.stopRequested, true); assert.equal(e.id, ref.id); };
      const dispatcher = new AsyncSdkCompactDispatch(f.options);
      assert.equal(await dispatcher.interrupt(ref, authorization), 'accepted'); assert.equal(stops, 1);
      assert.equal(f.journal.current(f.key)?.phase, 'dispatching'); assert.equal(f.journal.canStart(f.key), false);
      assert.equal(await dispatcher.interrupt(ref, authorization), 'not_started'); assert.equal(stops, 1);
    } finally { f.close(); }
  });
  for (const fault of ['wrong-boundary', 'wrong-native', 'not-quiescent'] as const) {
    test(`${runtime}: compact settlement ${fault} cannot release the original protection`, async () => {
      const f = fixture(runtime);
      try {
        const dispatcher = new AsyncSdkCompactDispatch(f.options);
        assert.equal(await dispatcher.dispatch(f.key, 'command', authorization), 'accepted');
        f.adapter.inspectSettlement = async e => ({ ...e, completionEventId: fault === 'wrong-boundary' ? 'wrong' : 'boundary',
          nativeSessionId: fault === 'wrong-native' ? 'wrong' : e.nativeSessionId, historyPersisted: true, nativeQuiescent: fault !== 'not-quiescent' });
        assert.equal(await dispatcher.settle(f.calls[0]!), false); assert.equal(f.journal.canStart(f.key), false);
      } finally { f.close(); }
    });
  }
}

test('real isolated Connector owner preserves compact receipt and unknown intent across reopen without native replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-reopen-')), file = join(directory, 'connector.sqlite');
  const f = await fixtureAsync('ghcp', file);
  f.store.close();
  let owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent);
  try {
    await owner.open();
    const native = deferred<Awaited<ReturnType<SdkCompactAdapter['compact']>>>();
    f.adapter.compact = async e => { f.calls.push(e); return native.promise; };
    assert.equal(await new AsyncSdkCompactDispatch({ ...f.options, owner, deadlineMs: 2000 }).dispatch(f.key, 'command', authorization), 'unknown');
    assert.equal(f.calls.length, 1); await owner.close();
    owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, silent); await owner.open();
    assert.equal((await owner.command('sdkSnapshotRead', { runtime: 'ghcp', key: f.key })).execution?.phase, 'unknown');
    const duplicate = await owner.command('sdkCompactClaim', f.request);
    assert.ok('admitted' in duplicate && !duplicate.admitted && duplicate.receipt.state === 'accepted');
    native.resolve({ ...f.calls[0]!, nativeRequestId: 'late', completionEventId: 'late', outcome: 'completed' }); await tick();
    assert.equal(f.calls.length, 1);
  } finally { await owner.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});

class ReplyWorker extends EventEmitter {
  sent: Array<{ id: number; kind: string }> = [];
  postMessage(value: { id: number; kind: string }) { this.sent.push(value); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}
for (const mismatch of ['claim-key', 'claim-id', 'claim-epoch', 'claim-native', 'claim-receipt', 'interrupt-id', 'interrupt-native'] as const) {
  test(`compact ${mismatch} valid-shaped reply retires the original owner without replay`, async () => {
    const f = fixture('ghcp'), root = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-reply-')), fake = new ReplyWorker();
    const owner = new AsyncConnectorOwner({ file: join(root, 'owner.sqlite') }, silent, () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' });
    try {
      const admitted = await f.owner.command('sdkCompactClaim', f.request);
      assert.ok('execution' in admitted && admitted.execution);
      const interrupt = mismatch.startsWith('interrupt');
      const kind = interrupt ? 'sdkCompactInterruptClaim' : 'sdkCompactClaim';
      const ref = { key: f.key, id: 'compact', epoch: 'epoch', nativeSessionId: 'native' };
      const pending = interrupt ? owner.command('sdkCompactInterruptClaim', { runtime: 'ghcp', authorization, ref })
        : owner.command('sdkCompactClaim', f.request);
      const rejected = assert.rejects(pending, /connector_storage_unavailable/);
      await tick();
      const output = structuredClone(admitted);
      assert.ok('execution' in output && output.execution);
      if (mismatch === 'claim-key') { output.key = 'ghcp:other'; output.execution.key = output.key; }
      else if (mismatch.endsWith('id')) { output.execution.id = 'other'; output.receipt.result!.body.runId = 'other'; }
      else if (mismatch === 'claim-epoch') output.execution.epoch = 'other';
      else if (mismatch.endsWith('native')) output.execution.nativeSessionId = 'other';
      else output.receipt.key = 'other';
      const body = interrupt ? { ...output.execution, stopRequested: true } : output;
      assert.equal(validConnectorSdkCompactOutput(kind, body), true);
      fake.emit('message', { ...fake.sent[0], ok: true, body: JSON.stringify(body) });
      await rejected; await owner.closeForShutdown(); assert.equal(fake.sent.length, 1);
    } finally { await owner.closeForShutdown(); f.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
