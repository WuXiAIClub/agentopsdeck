import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput, connectorOwnerSteps, CONNECTOR_PENDING_INPUT_BYTES } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import type { SdkDispatchAdapter } from './sdk-dispatch.js';
import type { SdkExecution } from './sdk-execution-journal.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { NativeOperationError } from './native-operation.js';
import { SDK_ATTACHMENT_MAX_BYTES } from './sdk-attachment-input.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const token = 'isolated-sdk-message-owner-test', authorization = `Bearer ${token}`;
const catalogs = { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } };
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const wait = { timeoutMs: 10_000 };
function fixture(runtime: SdkAgentId) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-message-owner-'));
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const owner = createConnectorOwnerCommands(store, tokens, catalogs);
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
  const key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const request = { runtime, key, authorization, commandKey: 'original-message', payloadJson: JSON.stringify({ message: '  original text  ', metadata: 'fingerprint' }) };
  const read = { runtime, key, authorization, commandKey: request.commandKey };
  const scope = JSON.stringify([actor, key]);
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { dir, tokens, actor, store, owner, journal, key, request, read, scope, db,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('message protocol is append-only, fixed fields, no caller authority or native options', () => {
  assert.equal(connectorOwnerSteps.sdkMessageSend, 96); assert.equal(connectorOwnerSteps.sdkMessageReceiptRead, 97);
  const f = fixture('ghcp');
  try {
    assert.equal(validConnectorOwnerInput('sdkMessageSend', f.request), true);
    for (const field of ['actorId', 'authorized', 'models', 'driver', 'sql', 'ready', 'executionGrant']) {
      assert.equal(validConnectorOwnerInput('sdkMessageSend', { ...f.request, [field]: true }), false);
    }
    for (const payloadJson of ['null', '[]', '1', '{} trailing', '{"idempotencyKey":"other"}']) {
      assert.equal(validConnectorOwnerInput('sdkMessageSend', { ...f.request, payloadJson }), false);
    }
    assert.equal(validConnectorOwnerInput('sdkMessageSend', { ...f.request, key: 'claude-code:wrong' }), false);
  } finally { f.close(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: original receipt + queue + attachment accepted atomically and duplicate never wakes twice`, async () => {
    const f = fixture(runtime); let wakes = 0;
    const messages = new AsyncSdkMessages({ command: f.owner }, () => { wakes++; });
    const media = [{ name: 'input.txt', mimeType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=' }];
    try {
      const request = { ...f.request, payloadJson: JSON.stringify({ message: '  original text  ', media }) };
      const result = await messages.send(request, wait);
      assert.ok('receipt' in result && result.receipt?.state === 'accepted' && result.admitted);
      assert.equal(validConnectorOwnerOutput('sdkMessageSend', result), true);
      assert.equal(result.receipt.result?.status, 200); assert.equal(wakes, 1);
      const turn = f.store.turns.head<{ text: string; actorId: string; attachmentCount: number }>(runtime, f.key)!;
      assert.equal(turn.payload.text, 'original text'); assert.equal(turn.payload.actorId, f.actor); assert.equal(turn.payload.attachmentCount, 1);
      assert.equal(turn.id, result.receipt.result?.body.idempotencyKey);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM sdk_attachments').get()!.n, 1);
      assert.deepEqual(f.store.commands.get(f.scope, f.request.commandKey), result.receipt);
      const duplicate = await messages.send(request, wait);
      assert.ok('receipt' in duplicate && !duplicate.admitted); assert.equal(wakes, 1);
      assert.deepEqual(duplicate.receipt, result.receipt);
      assert.deepEqual((await messages.readReceipt(f.read, wait) as { receipt: unknown }).receipt, result.receipt);
      assert.deepEqual(await messages.send({ ...request, payloadJson: JSON.stringify({ message: 'original text', media }) }, wait), { error: 409 });
      assert.equal(f.store.turns.maintenanceCount(), 1);
      assert.equal(JSON.stringify(result).includes('aGVsbG8='), false);
    } finally { f.close(); }
  });
  test(`${runtime}: accepted duplicate and read recover under maintenance/disabled catalogs, never replay unknown`, async () => {
    const f = fixture(runtime);
    try {
      const accepted = await f.owner('sdkMessageSend', f.request);
      assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted');
      f.store.pauseTurnStarts();
      const disabled = createConnectorOwnerCommands(f.store, f.tokens);
      const duplicate = await disabled('sdkMessageSend', f.request);
      assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
      const read = await disabled('sdkMessageReceiptRead', f.read);
      assert.ok('receipt' in read); assert.deepEqual(read.receipt, accepted.receipt);
      const other = { ...f.request, commandKey: 'unknown' };
      f.store.commands.claim(f.scope, other.commandKey, JSON.parse(other.payloadJson));
      const unknown = await disabled('sdkMessageSend', other);
      assert.ok('receipt' in unknown && unknown.receipt?.state === 'outcome_unknown' && !unknown.admitted);
      assert.equal(f.store.turns.maintenanceCount(), 1);
      const fresh = await disabled('sdkMessageSend', { ...f.request, commandKey: 'maintenance-denied' });
      assert.ok('receipt' in fresh && fresh.receipt?.state === 'rejected');
      assert.equal(fresh.receipt.result?.status, 409);
    } finally { f.close(); }
  });
  for (const message of ['', '/stop', '/status', '/compact']) test(`${runtime}: invalid/control message ${JSON.stringify(message)} cannot create ordinary turn`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.owner('sdkMessageSend', { ...f.request, payloadJson: JSON.stringify({ message }) });
      assert.ok('receipt' in result && result.receipt?.state === 'rejected' && !result.admitted);
      assert.equal(f.store.turns.maintenanceCount(), 0);
    } finally { f.close(); }
  });
  test(`${runtime}: changed authority after original receipt admission cannot queue work`, async () => {
    const f = fixture(runtime), claim = f.store.commands.claimAsync.bind(f.store.commands);
    try {
      f.store.commands.claimAsync = async (...args) => { const result = await claim(...args); f.tokens.revoke(f.actor); return result; };
      const result = await f.owner('sdkMessageSend', f.request);
      assert.ok('receipt' in result && result.receipt?.state === 'rejected');
      assert.equal(result.receipt.result?.status, 403); assert.equal(f.store.turns.maintenanceCount(), 0);
      assert.deepEqual(await f.owner('sdkMessageReceiptRead', f.read), { error: 401 });
    } finally { f.close(); }
  });
  test(`${runtime}: original receipt callback rollback leaves no queue or attachment`, async () => {
    const f = fixture(runtime), original = f.store.commands.queueCommit.bind(f.store.commands);
    try {
      f.store.commands.queueCommit = (...args) => {
        const commit = original(...args);
        return (db, admission) => { commit(db, admission); throw Error('injected transaction rollback'); };
      };
      await assert.rejects(f.owner('sdkMessageSend', { ...f.request, payloadJson: JSON.stringify({ message: '', media: [{ name: 'input.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' }] }) }));
      assert.equal(f.store.turns.maintenanceCount(), 0);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM sdk_attachments').get()!.n, 0);
      assert.equal(f.store.commands.get(f.scope, f.request.commandKey)?.state, 'outcome_unknown');
      assert.equal(f.db.isTransaction, false);
    } finally { f.close(); }
  });
  test(`${runtime}: lost postcommit ACK returns original proof and one wake, not a second admission`, async () => {
    const f = fixture(runtime), enqueue = f.store.turns.enqueueAsync.bind(f.store.turns); let wakes = 0;
    try {
      f.store.turns.enqueueAsync = async (...args) => { await enqueue(...args); throw Error('lost physical release ACK'); };
      const messages = new AsyncSdkMessages({ command: f.owner }, () => { wakes++; });
      const result = await messages.send(f.request, wait);
      assert.ok('receipt' in result && result.receipt?.state === 'accepted' && result.admitted);
      await messages.send(f.request, wait);
      assert.equal(wakes, 1); assert.equal(f.store.turns.maintenanceCount(), 1);
    } finally { f.close(); }
  });
  test(`${runtime}: timeout freezes caller wait, late physical acceptance wakes and read recovers without send`, async () => {
    const f = fixture(runtime); let release!: () => void, wakes = 0, sends = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const messages = new AsyncSdkMessages({ command: async (kind, input) => {
      if (kind === 'sdkMessageSend') { sends++; await gate; }
      return f.owner(kind, input);
    } }, () => { wakes++; });
    try {
      await assert.rejects(messages.send(f.request, { timeoutMs: 5 }), e => e instanceof NativeOperationError && e.outcome === 'unknown');
      assert.equal(f.store.turns.maintenanceCount(), 0);
      release(); await tick(); await tick();
      const result = await messages.readReceipt(f.read, wait);
      assert.ok('receipt' in result && result.receipt?.state === 'accepted');
      assert.equal(wakes, 1); assert.equal(sends, 1); assert.equal(f.store.turns.maintenanceCount(), 1);
    } finally { release(); f.close(); }
  });
  test(`${runtime}: recovery isolates current actor and needs read scope, not runtime readiness`, async () => {
    const f = fixture(runtime);
    try {
      await f.owner('sdkMessageSend', f.request);
      const other = f.tokens.create({ label: 'other', scopes: ['messages:read'] });
      const isolated = await f.owner('sdkMessageReceiptRead', { ...f.read, authorization: `Bearer ${other.token}` });
      assert.ok('receipt' in isolated && isolated.receipt === null);
      assert.deepEqual(await f.owner('sdkMessageSend', { ...f.request, authorization: `Bearer ${other.token}` }), { error: 403 });
      const sender = f.tokens.create({ label: 'send only', scopes: ['messages:send'] });
      assert.deepEqual(await f.owner('sdkMessageReceiptRead', { ...f.read, authorization: `Bearer ${sender.token}` }), { error: 403 });
    } finally { f.close(); }
  });
}

class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; kind: string; body: string }> = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.sent.push(message); }
  async terminate() { this.emit('exit', 1); return 1; }
}
test('real worker admits original full 20 MiB attachment wire and reopens the same receipt without enabled catalog', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-message-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  let owner = new AsyncConnectorOwner({ ...config, sdkModels: catalogs }, silence);
  try {
    await owner.open();
    for (const runtime of ['claude-code', 'ghcp'] as const) {
      const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
      assert.ok('receipt' in created && created.receipt.state === 'accepted' && created.key);
      const bytes = Buffer.alloc(SDK_ATTACHMENT_MAX_BYTES, 1);
      Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
      const media = Array.from({ length: 4 }, (_, n) => ({ name: `input-${n}.png`, mimeType: 'image/png',
        size: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }));
      const input = { runtime, key: created.key, authorization, commandKey: `large-${runtime}`, payloadJson: JSON.stringify({ message: '', media }) };
      const admitted = await owner.command('sdkMessageSend', input);
      assert.ok('receipt' in admitted && admitted.receipt?.state === 'accepted' && admitted.admitted);
      assert.ok(Array.isArray(admitted.receipt.result?.body.media));
      assert.equal(admitted.receipt.result.body.media.length, 4);
      assert.equal(admitted.queue.presence, 'present');
      await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
      const { payloadJson: _, ...read } = input;
      const recovered = await owner.command('sdkMessageReceiptRead', read);
      assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, admitted.receipt);
      const duplicate = await owner.command('sdkMessageSend', input);
      assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, admitted.receipt);
      // Restore the trusted catalog for the next runtime, never for duplicate recovery.
      await owner.close(); owner = new AsyncConnectorOwner({ ...config, sdkModels: catalogs }, silence); await owner.open();
    }
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('pre-aborted wait cannot invoke owner and original physical callback retains copied identity', async () => {
  const f = fixture('ghcp');
  let calls = 0;
  const seen: string[] = [];
  const messages = new AsyncSdkMessages({ command: ((kind: 'sdkMessageSend', input: typeof f.request) => {
    calls++;
    const work = f.owner(kind, input);
    // A reentrant caller must not redirect the original success notification.
    f.request.key = 'ghcp:mutated';
    return work;
  }) as typeof f.owner }, (runtime, key) => { seen.push(`${runtime}/${key}`); });
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(messages.send(f.request, { ...wait, signal: abort.signal }));
    assert.equal(calls, 0);
    await messages.send(f.request, wait);
    assert.deepEqual(seen, ['ghcp/ghcp:original']);
  } finally { f.close(); }
});

for (const fault of ['runtime', 'key', 'commandKey'] as const) test(`message ${fault} correlation mismatch retires owner without replay`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-message-correlation-')), fake = new FakeWorker();
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  try {
    const work = owner.command('sdkMessageReceiptRead', { runtime: 'ghcp', key: 'ghcp:original', authorization, commandKey: 'original' });
    const rejected = assert.rejects(work);
    await tick();
    const result = { runtime: 'ghcp', key: 'ghcp:original', commandKey: 'original', receipt: null, queue: { presence: 'unknown' } };
    if (fault === 'runtime') { result.runtime = 'claude-code'; result.key = 'claude-code:original'; }
    else result[fault] = 'ghcp:different';
    assert.equal(validConnectorOwnerOutput('sdkMessageReceiptRead', result), true);
    fake.emit('message', { ...fake.sent[0], ok: true, body: JSON.stringify(result) });
    await rejected; assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.sent.length, 1);
  } finally { fake.emit('exit', 1); await owner.closeForShutdown().catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
});

test('large SDK physical input remains single-flight beyond deadline while ordinary RPC budget remains available', async () => {
  const fake = new FakeWorker(), directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-message-large-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const input = { runtime: 'ghcp' as const, key: 'ghcp:original', authorization, commandKey: 'large',
    payloadJson: JSON.stringify({ message: 'original', metadata: 'x'.repeat(CONNECTOR_PENDING_INPUT_BYTES + 1) }) };
  const messages = new AsyncSdkMessages(owner, () => {});
  try {
    await assert.rejects(messages.send(input, { timeoutMs: 5 }), e => e instanceof NativeOperationError && e.outcome === 'unknown');
    assert.equal(fake.sent.length, 1);
    await assert.rejects(owner.command('sdkMessageSend', input));
    const read = owner.command('nodeIdentity', {}); await tick();
    assert.equal(fake.sent.length, 2);
    fake.emit('message', { ...fake.sent[1], ok: true, body: JSON.stringify('node-original') });
    assert.equal(await read, 'node-original');
    fake.emit('message', { id: fake.sent[0]!.id, kind: 'sdkMessageSend', ok: true, body: JSON.stringify({ error: 403 }) });
    await tick();
    const second = owner.command('sdkMessageSend', input); await tick();
    assert.equal(fake.sent.length, 3);
    fake.emit('message', { id: fake.sent[2]!.id, kind: 'sdkMessageSend', ok: true, body: JSON.stringify({ error: 403 }) });
    assert.deepEqual(await second, { error: 403 });
    const closing = owner.close(); await tick();
    const close = fake.sent.at(-1)!;
    fake.emit('message', { id: close.id, kind: 'close', ok: true, body: 'null' }); fake.emit('exit', 0);
    await closing;
  } finally {
    if (!owner.snapshot().ownerExitConfirmed) { fake.emit('exit', 1); await owner.closeForShutdown().catch(() => {}); }
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: real owner message admission drives one original native effect and settlement, not another send on recovery`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-message-chain-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'),
    bootstrapToken: token, sdkModels: catalogs }, silence);
  let invoked = 0, execution: SdkExecution | undefined, dispatchWork: Promise<unknown> | undefined;
  const adapter: SdkDispatchAdapter = { epoch: 'original-private-epoch', ready: true,
    send: async (ref, text, _context, attachments) => {
      invoked++; execution = ref; assert.equal(text, 'original native input');
      assert.equal(attachments?.[0]?.data, 'aGVsbG8=');
      return { nativeRequestId: 'original-native-request' };
    }, interrupt: async () => { throw Error('not a control command'); },
    inspectSettlement: async ref => ({ ...ref, historyPersisted: true, nativeQuiescent: true }),
  };
  const dispatch = new AsyncSdkDispatch({ owner, runtime, adapter, deadlineMs: 10_000 });
  const messages = new AsyncSdkMessages(owner, (_runtime, key) => { dispatchWork = dispatch.dispatch(key); });
  try {
    await owner.open();
    const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'allocate', payloadJson: '{}' });
    assert.ok('receipt' in created && created.key);
    const input = { runtime, key: created.key, authorization, commandKey: 'send-original', payloadJson: JSON.stringify({ message: 'original native input',
      media: [{ name: 'input.txt', mimeType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=' }] }) };
    const accepted = await messages.send(input, wait);
    assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted');
    assert.equal(await dispatchWork, 'accepted'); assert.equal(invoked, 1); assert.ok(execution);
    assert.equal(await dispatch.terminal(execution, 'completed'), true);
    assert.equal(await dispatch.settle(execution), true);
    const { payloadJson: _, ...read } = input;
    const recovered = await messages.readReceipt(read, wait);
    assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, accepted.receipt);
    const duplicate = await messages.send(input, wait);
    assert.ok('admitted' in duplicate && !duplicate.admitted); assert.equal(invoked, 1);
    assert.equal(await dispatch.dispatch(input.key), 'not_started'); assert.equal(invoked, 1);
  } finally { await dispatchWork; await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
