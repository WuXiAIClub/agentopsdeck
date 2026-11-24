import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands, encodeConnectorOwnerJson, CONNECTOR_RESULT_BYTES } from './connector-owner-domain.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { executeConnectorSdkDispatch, validConnectorSdkDispatchInput, validConnectorSdkDispatchOutput } from './connector-sdk-dispatch-domain.js';
import type { SdkDispatchAdapter, SdkTextInput } from './sdk-dispatch.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { SdkExecutionJournal } from './sdk-execution-journal.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { recoverableConnection, connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { validConnectorSdkAttachmentInput, validConnectorSdkAttachmentOutput } from './connector-sdk-attachment-domain.js';
import { SDK_ATTACHMENT_CHUNK_BYTES } from './sdk-attachment-store.js';
import { reserveSdkAttachmentAssembly } from './async-sdk-attachments.js';

function fixture(runtime: SdkAgentId, deadlineMs = 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-async-sdk-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'isolated-test-token');
  const actorId = tokens.authenticateAuthorization('Bearer isolated-test-token')!.tokenId;
  const store = new ConnectorUserStore(':memory:', (token, action) => tokens.hasScope(token, 'execution:delegate')
    && tokens.hasScope(token, 'messages:send') && (action !== 'messages:mirror' || tokens.hasScope(token, 'messages:mirror')), { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
  const key = `${runtime}:session`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const owner = { command: createConnectorOwnerCommands(store, tokens) };
  const calls: string[] = [];
  const adapter: SdkDispatchAdapter = { epoch: 'epoch', ready: true,
    send: async (e, text) => {
      assert.equal(journal.current(key)?.id, e.id);
      assert.equal(store.turns.head(runtime, key)?.state, 'dispatching');
      calls.push(text); return { nativeRequestId: 'native-request' };
    }, interrupt: async () => { calls.push('interrupt'); },
    inspectSettlement: async e => ({ ...e, historyPersisted: true, nativeQuiescent: true }),
  };
  const dispatch = new AsyncSdkDispatch({ owner, runtime, adapter, deadlineMs });
  const payload = (text: string, attachmentCount?: number): SdkTextInput => ({ text, images: [], actorId,
    ...(attachmentCount ? { attachmentCount } : {}) });
  let originalDb!: DatabaseSync;
  const enqueue = (id: string, text = id, attachmentCount?: number) => store.turns.enqueue(runtime,
    { id, sessionKey: key, createdAt: 0, payload: payload(text, attachmentCount) }, db => {
      originalDb = db;
      if (attachmentCount) store.sdkAttachments.save(key, id, store.sdkAttachments.prepare(Array.from({ length: attachmentCount },
        (_, index) => ({ name: `file-${index}.txt`, mimeType: 'text/plain', data: Buffer.from('private attachment body').toString('base64') }))));
    });
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { store, journal, tokens, actorId, owner, adapter, dispatch, key, calls, enqueue, payload, close, db: () => originalDb };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: attachments cross bounded chunks, validate before native send and stay out of diagnostics`, async () => {
    const f = fixture(runtime), observations: unknown[] = [];
    const diagnostics = new PerformanceDiagnostics(event => { observations.push(JSON.parse(event)); });
    try {
      f.enqueue('media', 'one', 1);
      const body = Buffer.from('z'.repeat(90_000));
      f.db().prepare('UPDATE sdk_attachments SET body=?, size=?').run(body, body.length);
      const chunks: number[] = [];
      const owner = { command: (async (kind, input) => {
        const value = await f.owner.command(kind, input);
        if (kind === 'sdkExecutionAttachmentChunk') chunks.push((value as { data: string }).data.length);
        return value;
      }) as typeof f.owner.command };
      f.adapter.send = async (_e, _text, _context, attachments) => {
        assert.deepEqual(attachments, [{ name: 'file-0.txt', mimeType: 'text/plain', data: body.toString('base64') }]);
        f.calls.push('native'); return { nativeRequestId: 'ack' };
      };
      assert.equal(await new AsyncSdkDispatch({ owner, runtime, adapter: f.adapter, deadlineMs: 1000, diagnostics }).dispatch(f.key), 'accepted');
      assert.equal(f.calls.length, 1); assert.equal(chunks.length, 2);
      assert.ok(chunks.every(size => size <= Math.ceil(SDK_ATTACHMENT_CHUNK_BYTES / 3) * 4));
      assert.ok(observations.some(event => (event as { operation: string }).operation === 'sdk-async-attachments'));
      assert.ok(!JSON.stringify(observations).includes('file-0.txt')); assert.ok(!JSON.stringify(observations).includes(body.toString('base64')));
    } finally { f.close(); }
  });
  for (const fault of ['missing', 'oversized', 'changed-body', 'revoke', 'stop', 'wrong-ref', 'wrong-offset', 'bad-utf8'] as const) {
    test(`${runtime}: attachment ${fault} preserves unknown without native call or replay`, async () => {
      const f = fixture(runtime);
      try {
        f.enqueue('media', 'one', 1);
        if (fault === 'missing') f.store.sdkAttachments.remove(f.key, 'media');
        if (fault === 'oversized') f.db().prepare('UPDATE sdk_attachments SET body=zeroblob(?),size=?').run(5 * 1024 * 1024 + 1, 5 * 1024 * 1024 + 1);
        if (fault === 'bad-utf8') f.db().prepare('UPDATE sdk_attachments SET body=?,size=1').run(Buffer.from([255]));
        let manifests = 0;
        const owner = { command: (async (kind, input) => {
          const value = await f.owner.command(kind, input);
          if (kind === 'sdkExecutionAttachmentManifest' && ++manifests === 1) {
            if (fault === 'changed-body') f.db().prepare('UPDATE sdk_attachments SET body=?,size=?').run(Buffer.from('changed attachment body'), 23);
            if (fault === 'revoke') f.tokens.revoke(f.actorId);
            if (fault === 'stop') {
              const e = f.journal.current(f.key)!;
              assert.equal(f.journal.acknowledge(e, 'concurrent-ack', f.store.turns), true);
              assert.equal(f.journal.requestStop(e), true);
            }
            if (fault === 'wrong-ref') (value as { ref: { id: string } }).ref = { ...(value as { ref: { id: string } }).ref, id: 'other' };
          }
          if (kind === 'sdkExecutionAttachmentChunk' && fault === 'wrong-offset') (value as { offset: number }).offset += SDK_ATTACHMENT_CHUNK_BYTES;
          return value;
        }) as typeof f.owner.command };
        const dispatch = new AsyncSdkDispatch({ owner, runtime, adapter: f.adapter, deadlineMs: 1000 });
        assert.equal(await dispatch.dispatch(f.key), 'unknown');
        assert.equal(f.journal.current(f.key)?.phase, 'unknown');
        // The concurrent durable ACK already consumed its queue admission.
        // Its execution still remains unknown; do not recreate that row.
        assert.equal(f.store.turns.head(runtime, f.key)?.state, fault === 'stop' ? undefined : 'outcome_unknown');
        assert.equal(f.calls.length, 0); assert.equal(await dispatch.dispatch(f.key), 'not_started');
      } finally { f.close(); }
    });
  }
  for (const mode of ['timeout', 'abort', 'epoch'] as const) {
    test(`${runtime}: attachment ${mode} fences late reader and never sends`, async () => {
      const f = fixture(runtime), entered = deferred<void>(), late = deferred<void>(), controller = new AbortController();
      let reads = 0;
      try {
        f.enqueue('media', 'one', 1);
        const owner = { command: (async (kind, input) => {
          const value = await f.owner.command(kind, input);
          if (kind === 'sdkExecutionAttachmentManifest') { reads++; entered.resolve(); await late.promise; }
          return value;
        }) as typeof f.owner.command };
        const dispatch = new AsyncSdkDispatch({ owner, runtime, adapter: f.adapter, deadlineMs: mode === 'timeout' ? 30 : 1000 });
        const work = dispatch.dispatch(f.key, controller.signal); await entered.promise;
        if (mode === 'abort') controller.abort();
        if (mode === 'epoch') { (f.adapter as { epoch: string }).epoch = 'replacement'; late.resolve(); }
        assert.equal(await work, 'unknown'); late.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(reads, 1); assert.equal(f.calls.length, 0); assert.equal(f.journal.current(f.key)?.phase, 'unknown');
      } finally { late.resolve(); f.close(); }
    });
  }
}

test('fixed attachment protocol rejects caller permissions, arbitrary offsets and oversized noncanonical output', () => {
  const ref = { key: 'claude-code:session', id: 'intent', epoch: 'epoch', nativeSessionId: 'native' };
  const input = { runtime: 'claude-code', ref, admissionId: 'one', id: 'file', offset: 0, size: 1 };
  assert.equal(validConnectorSdkAttachmentInput('sdkExecutionAttachmentChunk', input), true);
  for (const patch of [{ offset: 1 }, { size: 0 }, { size: 5 * 1024 * 1024 + 1 }, { runtime: 'ghcp' }, { authorized: true }]) {
    assert.equal(validConnectorSdkAttachmentInput('sdkExecutionAttachmentChunk', { ...input, ...patch }), false);
  }
  const output = { ref, admissionId: 'one', id: 'file', offset: 0, size: 1, data: 'YQ==' };
  assert.equal(validConnectorSdkAttachmentOutput('sdkExecutionAttachmentChunk', output), true);
  for (const data of ['YQ', 'YQ===', 'Yg==\n', 'a'.repeat(100_000)]) assert.equal(validConnectorSdkAttachmentOutput('sdkExecutionAttachmentChunk', { ...output, data }), false);
});

test('shared attachment assembly budget rejects overflow and releases idempotently', () => {
  const release = reserveSdkAttachmentAssembly(40 * 1024 * 1024);
  try { assert.throws(() => reserveSdkAttachmentAssembly(1), /connector_storage_unavailable/); }
  finally { release(); release(); }
  reserveSdkAttachmentAssembly(40 * 1024 * 1024)();
  for (const value of [-1, NaN, Infinity, 0.5]) assert.throws(() => reserveSdkAttachmentAssembly(value));
});

test('native ACK deadline retains original body budget until late original invocation settles', async () => {
  const f = fixture('claude-code', 30), native = deferred<{ nativeRequestId: string }>();
  try {
    f.enqueue('media', 'one', 1);
    f.adapter.send = () => native.promise;
    assert.equal(await f.dispatch.dispatch(f.key), 'unknown');
    assert.throws(() => reserveSdkAttachmentAssembly(40 * 1024 * 1024));
    native.resolve({ nativeRequestId: 'late-ack' }); await new Promise<void>(resolve => setImmediate(resolve));
    reserveSdkAttachmentAssembly(40 * 1024 * 1024)();
    assert.equal(f.journal.current(f.key)?.phase, 'unknown');
  } finally { native.resolve({ nativeRequestId: 'cleanup' }); f.close(); }
});
for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: async FIFO claim, ACK, terminal, independent settlement and next dispatch`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one'); f.enqueue('two');
      assert.equal(await f.dispatch.dispatch(f.key), 'accepted');
      const e = f.journal.current(f.key)!;
      assert.deepEqual(e.members, ['one', 'two']); assert.equal(e.phase, 'running');
      assert.equal(f.calls[0], ['one', 'two'].join(e.batch!.separator));
      f.enqueue('three'); assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      assert.equal(await f.dispatch.terminal(e, 'completed'), true);
      const gate = deferred<Awaited<ReturnType<SdkDispatchAdapter['inspectSettlement']>>>();
      let inspections = 0;
      f.adapter.inspectSettlement = () => { inspections++; return gate.promise; };
      const a = f.dispatch.settle(e), b = f.dispatch.settle(e);
      assert.equal(a, b);
      gate.resolve({ ...e, historyPersisted: true, nativeQuiescent: true });
      assert.equal(await a, true); assert.equal(inspections, 1);
      assert.equal(await f.dispatch.dispatch(f.key), 'accepted'); assert.equal(f.calls.length, 2);
      assert.equal(await f.dispatch.terminal(e, 'failed'), false);
    } finally { f.close(); }
  });
  test(`${runtime}: plans cannot survive changed queue, settings or fresh authorization`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one');
      const plan = await f.owner.command('sdkDispatchPlan', { runtime, key: f.key });
      assert.ok(plan && plan !== 'blocked');
      f.enqueue('two');
      assert.equal(await f.owner.command('sdkDispatchClaim', { runtime, key: f.key, id: 'intent', epoch: 'epoch', digest: plan.digest }), null);
      assert.equal(f.journal.current(f.key), undefined); assert.equal(f.store.turns.head(runtime, f.key)?.state, 'queued');
      const second = await f.owner.command('sdkDispatchPlan', { runtime, key: f.key }); assert.ok(second && second !== 'blocked');
      f.journal.updateModel(f.key, 'test-model', () => {});
      assert.equal(await f.owner.command('sdkDispatchClaim', { runtime, key: f.key, id: 'intent', epoch: 'epoch', digest: second.digest,
        separator: second.batch!.separator }), null);
      const third = await f.owner.command('sdkDispatchPlan', { runtime, key: f.key }); assert.ok(third && third !== 'blocked');
      f.tokens.revoke(f.actorId);
      assert.equal(await f.owner.command('sdkDispatchClaim', { runtime, key: f.key, id: 'intent', epoch: 'epoch', digest: third.digest,
        separator: third.batch!.separator }), null);
      assert.equal(f.journal.current(f.key), undefined);
      assert.equal(await f.owner.command('sdkDispatchPlan', { runtime, key: f.key }), 'blocked');
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'blocked'); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  test(`${runtime}: context-await revocation and cancellation prevent durable admission`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one'); const gate = deferred<string>(), entered = deferred<void>();
      const dispatch = new AsyncSdkDispatch({ runtime, owner: f.owner, adapter: f.adapter, deadlineMs: 1000,
        turnContext: async (_key, payload) => { assert.equal(payload.text, 'one'); entered.resolve(); return gate.promise; } });
      const pending = dispatch.dispatch(f.key); await entered.promise;
      assert.equal(await dispatch.dispatch(f.key), 'not_started');
      f.tokens.revoke(f.actorId); gate.resolve('context');
      assert.equal(await pending, 'not_started'); assert.equal(f.journal.current(f.key), undefined); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  test(`${runtime}: epoch change after claim preserves unknown without native send or replay`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one');
      const owner = { command: (async (kind, input) => {
        const reply = await f.owner.command(kind, input);
        if (kind === 'sdkDispatchClaim') (f.adapter as { epoch: string }).epoch = 'replacement';
        return reply;
      }) as typeof f.owner.command };
      const dispatch = new AsyncSdkDispatch({ runtime, owner, adapter: f.adapter, deadlineMs: 1000 });
      assert.equal(await dispatch.dispatch(f.key), 'unknown');
      assert.equal(f.journal.current(f.key)?.phase, 'unknown');
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'outcome_unknown');
      assert.equal(f.calls.length, 0); assert.equal(await dispatch.dispatch(f.key), 'not_started');
    } finally { f.close(); }
  });
  test(`${runtime}: lost ACK is unknown; terminal-before-ACK proves original admission`, async () => {
    const f = fixture(runtime, 15);
    try {
      f.enqueue('one'); const ack = deferred<{ nativeRequestId: string }>();
      f.adapter.send = async () => { f.calls.push('one'); return ack.promise; };
      assert.equal(await f.dispatch.dispatch(f.key), 'unknown');
      const e = f.journal.current(f.key)!; ack.resolve({ nativeRequestId: 'late' });
      assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      assert.equal(await f.dispatch.terminal(e, 'completed'), false); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
    const g = fixture(runtime);
    try {
      g.enqueue('one'); g.adapter.send = async e => { await g.dispatch.terminal(e, 'completed'); throw Error('lost ACK'); };
      assert.equal(await g.dispatch.dispatch(g.key), 'accepted'); assert.equal(g.journal.current(g.key)?.phase, 'settling');
    } finally { g.close(); }
  });
  test(`${runtime}: media batching, text bound, stop auth and incomplete settlement retain protection`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one', 'one', 1); f.enqueue('two');
      assert.equal(await f.dispatch.dispatch(f.key), 'accepted'); const e = f.journal.current(f.key)!;
      assert.deepEqual(e.members, ['one']);
      assert.equal(await f.dispatch.interrupt(e, { ...f.payload(''), actorId: 'denied' }), 'blocked');
      assert.equal(f.journal.current(f.key)?.stopRequested, false);
      assert.equal(await f.dispatch.interrupt(e, f.payload('')), 'accepted');
      assert.equal(f.journal.current(f.key)?.stopRequested, true);
      assert.equal(await f.dispatch.terminal(e, 'interrupted'), true);
      f.adapter.inspectSettlement = async e => ({ ...e, historyPersisted: false, nativeQuiescent: true });
      assert.equal(await f.dispatch.settle(e), false); assert.equal(f.journal.current(f.key)?.phase, 'settling');
    } finally { f.close(); }
  });
}
test('dispatch-prefix rejects corrupt/oversize stored payload without loading body or rewriting', () => {
  const f = fixture('claude-code');
  try {
    f.enqueue('one'); const db = (f.store as unknown as { db: DatabaseSync }).db;
    // This fixture explicitly bounds retained rows at 1MiB. The production
    // queue admits a legal large first row alone, so 1MiB is not its row limit.
    const bounded = new TurnQueue(db, 10_000, 1024 * 1024);
    for (const value of [Buffer.from('{}'), JSON.stringify('x'.repeat(1024 * 1024 + 1))]) {
      db.prepare('UPDATE connector_turns SET payload = ?').run(value);
      assert.throws(() => bounded.dispatchPrefix('claude-code', f.key), /connector_storage_unavailable/);
      assert.equal(db.prepare('SELECT state FROM connector_turns').get()!.state, 'queued');
    }
    // Only this isolated corruption fixture removes expression indexes so an
    // impossible-through-normal-writes malformed on-disk row can be injected.
    db.exec('DROP INDEX connector_turn_actor_order; DROP INDEX connector_turn_execution_usage');
    db.prepare('UPDATE connector_turns SET payload = ?').run('{');
    assert.throws(() => f.store.turns.dispatchPrefix('claude-code', f.key));
    assert.equal(db.prepare('SELECT payload FROM connector_turns').get()!.payload, '{');
  } finally { f.close(); }
});
test('valid long FIFO backlog produces bounded prefix; escaped maximum message fits reply budget', async () => {
  const f = fixture('claude-code');
  try {
    for (let i = 0; i < 16; i++) f.enqueue(`large-${i}`, 'x'.repeat(MAX_MESSAGE_CHARS));
    const prefix = f.store.turns.dispatchPrefix('claude-code', f.key);
    assert.ok(prefix.length > 1 && prefix.length < 16);
    assert.equal(await f.dispatch.dispatch(f.key), 'accepted');
    assert.deepEqual(f.journal.current(f.key)!.members, ['large-0']);
  } finally { f.close(); }
  const g = fixture('claude-code');
  try {
    g.enqueue('escaped', 'x' + '\u0001'.repeat(MAX_MESSAGE_CHARS - 1));
    const plan = await g.owner.command('sdkDispatchPlan', { runtime: 'claude-code', key: g.key });
    assert.ok(plan && plan !== 'blocked');
    assert.ok(Buffer.byteLength(encodeConnectorOwnerJson(plan, CONNECTOR_RESULT_BYTES)) < CONNECTOR_RESULT_BYTES);
    assert.equal(await g.dispatch.dispatch(g.key), 'accepted');
  } finally { g.close(); }
});
test('fixed dispatch envelopes reject permission witnesses, missing authority and malformed replies', () => {
  assert.equal(validConnectorSdkDispatchInput('sdkDispatchPlan', { runtime: 'claude-code', key: 'claude-code:x', authorized: true }), false);
  assert.equal(validConnectorSdkDispatchInput('sdkDispatchClaim', { runtime: 'ghcp', key: 'claude-code:x', id: 'i', epoch: 'e', digest: 'a'.repeat(64) }), false);
  assert.equal(validConnectorSdkDispatchOutput('sdkDispatchClaim', { key: 'claude-code:x' }), false);
  const f = fixture('claude-code');
  try { assert.throws(() => executeConnectorSdkDispatch('sdkDispatchPlan', { runtime: 'claude-code', key: f.key }, f.store), /connector_storage_unavailable/); }
  finally { f.close(); }
});

test('cancelled/timed-out context is pre-admission; late resolution cannot send or leave a local gate stuck', async () => {
  for (const mode of ['abort', 'timeout'] as const) {
    const f = fixture('claude-code'), context = deferred<string>(), entered = deferred<void>(), controller = new AbortController();
    const diagnostics = new PerformanceDiagnostics(() => { throw Error('broken diagnostic sink'); });
    const dispatch = new AsyncSdkDispatch({ runtime: 'claude-code', owner: f.owner, adapter: f.adapter,
      deadlineMs: mode === 'timeout' ? 15 : 1000, diagnostics,
      turnContext: () => { entered.resolve(); return context.promise; } });
    try {
      f.enqueue('one'); const work = dispatch.dispatch(f.key, controller.signal);
      const rejected = assert.rejects(work); await entered.promise;
      if (mode === 'abort') controller.abort();
      await rejected;
      assert.equal(f.journal.current(f.key), undefined); assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
      context.resolve('late context');
      assert.equal(await dispatch.dispatch(f.key), 'accepted'); assert.equal(f.calls.length, 1);
      assert.ok(diagnostics.snapshot().totals.failed >= 1);
      assert.ok(diagnostics.snapshot().totals.sinkFailures >= 1);
    } finally { f.close(); }
  }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: real sole worker dispatch and reopened unknown never send again`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-real-owner-'));
  const file = join(root, 'connector.sqlite'), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, 'isolated-worker-test');
  const actorId = tokens.authenticateAuthorization('Bearer isolated-worker-test')!.tokenId;
  const original = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? original.claudeJournal : original.copilotJournal, key = `${runtime}:session`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const attachment = { name: 'file.txt', mimeType: 'text/plain', data: Buffer.from('z'.repeat(90_000)).toString('base64') };
  await original.turns.enqueueAsync(runtime, { id: 'one', sessionKey: key, createdAt: 0, payload: { text: 'one', images: [], actorId, attachmentCount: 1 } }, () => {
    original.sdkAttachments.save(key, 'one', original.sdkAttachments.prepare([attachment]));
  });
  original.close();
  const silent = new PerformanceDiagnostics(() => {});
  let owner = new AsyncConnectorOwner({ file, tokenFile }, silent), sends = 0;
  const adapter: SdkDispatchAdapter = { epoch: 'epoch', ready: true,
    send: async (_e, _text, _context, attachments) => { assert.deepEqual(attachments, [attachment]); sends++; throw Error('uncertain-native-result'); },
    interrupt: async () => {}, inspectSettlement: async e => ({ ...e, historyPersisted: true, nativeQuiescent: true }) };
  try {
    await owner.open();
    assert.equal(await new AsyncSdkDispatch({ owner, runtime, adapter, deadlineMs: 1000, diagnostics: silent }).dispatch(key), 'unknown');
    assert.equal((await owner.command('sdkSnapshotRead', { runtime, key })).execution?.phase, 'unknown');
    await owner.close();
    owner = new AsyncConnectorOwner({ file, tokenFile }, silent); await owner.open();
    assert.equal((await owner.command('sdkSnapshotRead', { runtime, key })).unresolved, true);
    assert.equal(await new AsyncSdkDispatch({ owner, runtime, adapter, deadlineMs: 1000, diagnostics: silent }).dispatch(key), 'not_started');
    assert.equal(sends, 1);
  } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
});

test('atomic begin rejects async authority participant and rolls back the original queue/intent', async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), turns = new TurnQueue(db);
  const journal = new SdkExecutionJournal(db, 'claude-code'), key = 'claude-code:session';
  try {
    journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
    await turns.enqueueAsync('claude-code', { id: 'one', sessionKey: key, createdAt: 0, payload: {} });
    assert.throws(() => journal.begin({ key, id: 'intent', epoch: 'epoch' }, ['one'], turns,
      undefined, (() => Promise.resolve(true)) as unknown as () => boolean), /must be synchronous/);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM sdk_agent_executions').get()!.n, 0);
    assert.equal(raw.prepare('SELECT state FROM connector_turns').get()!.state, 'queued');
    assert.equal(raw.isTransaction, false); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

class ReplyWorker extends EventEmitter {
  sent: { id: number; kind: string }[] = [];
  postMessage(v: { id: number; kind: string }) { this.sent.push(v); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}
for (const mismatch of ['key', 'id', 'epoch', 'nativeSessionId', 'admissionId', 'file-id', 'offset', 'size'] as const) {
  test(`attachment ${mismatch} reply retires original owner without replacement or replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-attachment-reply-')), fake = new ReplyWorker();
    const owner = new AsyncConnectorOwner({ file: join(root, 'store.sqlite') }, new PerformanceDiagnostics(() => {}), () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' });
    const ref = { key: 'claude-code:session', id: 'intent', epoch: 'epoch', nativeSessionId: 'native' };
    try {
      const input = { runtime: 'claude-code' as const, ref, admissionId: 'one', id: 'file', offset: 0, size: SDK_ATTACHMENT_CHUNK_BYTES * 2 };
      const rejected = assert.rejects(owner.command('sdkExecutionAttachmentChunk', input), /connector_storage_unavailable/);
      await new Promise<void>(resolve => setImmediate(resolve));
      const output = { ref: { ...ref }, admissionId: 'one', id: 'file', offset: 0, size: input.size,
        data: Buffer.alloc(SDK_ATTACHMENT_CHUNK_BYTES, 97).toString('base64') };
      if (mismatch === 'key') output.ref.key = 'claude-code:other';
      else if (mismatch === 'id' || mismatch === 'epoch' || mismatch === 'nativeSessionId') output.ref[mismatch] = 'other';
      else if (mismatch === 'admissionId') output.admissionId = 'other';
      else if (mismatch === 'file-id') output.id = 'other';
      else if (mismatch === 'offset') output.offset = SDK_ATTACHMENT_CHUNK_BYTES;
      else output.size += 1;
      assert.equal(validConnectorSdkAttachmentOutput('sdkExecutionAttachmentChunk', output), true);
      fake.emit('message', { ...fake.sent[0], ok: true, body: JSON.stringify(output) });
      await rejected; await owner.closeForShutdown(); assert.equal(fake.sent.length, 1);
    } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
  });
}
for (const mismatch of ['plan-key', 'claim-id', 'claim-epoch', 'interrupt-native'] as const) {
  test(`valid-looking ${mismatch} reply retires sole owner without replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-reply-')), fake = new ReplyWorker();
    const owner = new AsyncConnectorOwner({ file: join(root, 'store.sqlite') }, new PerformanceDiagnostics(() => {}), () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' });
    const key = 'claude-code:session', ref = { id: 'intent', key, epoch: 'epoch', nativeSessionId: 'native' };
    try {
      const request = mismatch === 'plan-key' ? owner.command('sdkDispatchPlan', { runtime: 'claude-code', key })
        : mismatch === 'interrupt-native' ? owner.command('sdkInterruptClaim', { runtime: 'claude-code', ref, actorId: 'actor' })
          : owner.command('sdkDispatchClaim', { runtime: 'claude-code', key, id: ref.id, epoch: ref.epoch, digest: 'a'.repeat(64) });
      const rejected = assert.rejects(request, /connector_storage_unavailable/);
      await new Promise<void>(resolve => setImmediate(resolve));
      const value = mismatch === 'plan-key' ? { key: 'claude-code:other', digest: 'a'.repeat(64), text: 'text',
        actor: { actorId: 'actor', images: [] }, members: ['one'] }
        : { ...ref, ...(mismatch === 'claim-id' ? { id: 'other' } : mismatch === 'claim-epoch' ? { epoch: 'other' } : { nativeSessionId: 'other' }),
          kind: 'message', members: ['one'], nativeMode: 'create', phase: 'dispatching', stopRequested: false, createdAt: 0, updatedAt: 0 };
      assert.equal(validConnectorSdkDispatchOutput(mismatch === 'plan-key' ? 'sdkDispatchPlan' : mismatch === 'interrupt-native' ? 'sdkInterruptClaim' : 'sdkDispatchClaim', value), true);
      fake.emit('message', { ...fake.sent[0], ok: true, body: JSON.stringify(value) });
      await rejected; await owner.closeForShutdown(); assert.equal(fake.sent.length, 1);
    } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
  });
}
