import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { connectorOwnerCommandBytes, createConnectorOwnerCommands,
  validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { NativeOperationError } from './native-operation.js';
import { validConnectorHermesMessageInput, executeConnectorHermesMessage } from './connector-hermes-message-domain.js';

const token = 'isolated-hermes-original-message-test', authorization = `Bearer ${token}`, key = 'hermes:original';
const wait = { timeoutMs: 10_000 }, tick = () => new Promise<void>(resolve => setImmediate(resolve));
const silence = new PerformanceDiagnostics(() => {});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-message-chain-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] });
  const owner = createConnectorOwnerCommands(store, tokens);
  const request = { key, authorization, commandKey: 'original-message', payloadJson: JSON.stringify({ message: ' original text ', metadata: 'original fingerprint' }) };
  const read = { key, authorization, commandKey: request.commandKey }, scope = JSON.stringify([actor, key]);
  return { directory, tokens, actor, store, owner, request, read, scope, db: (store as unknown as { db: DatabaseSync }).db,
    close() { owner.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Hermes message protocol rejects caller authority/SQL/closures and malformed scope before owner access', async () => {
  const f = fixture();
  try {
    assert.equal(validConnectorOwnerInput('hermesMessageSend', f.request), true);
    const absent = new Proxy({}, { get() { throw Error('owner touched'); } }) as ConnectorUserStore;
    for (const field of ['actorId', 'authorized', 'sql', 'callback', 'executionGrant', 'ready', 'runtime']) {
      const input = { ...f.request, [field]: true };
      assert.equal(validConnectorHermesMessageInput('hermesMessageSend', input), false);
      await assert.rejects(executeConnectorHermesMessage('hermesMessageSend', input, absent, undefined), /unavailable/);
    }
    for (const payloadJson of ['null', '[]', '{} trailing', '{"idempotencyKey":"other"}'])
      assert.equal(validConnectorOwnerInput('hermesMessageSend', { ...f.request, payloadJson }), false);
    for (const foreign of ['hermes:', 'codex:original', 'hermes:bad\n'])
      assert.equal(validConnectorOwnerInput('hermesMessageSend', { ...f.request, key: foreign }), false);
  } finally { f.close(); }
});

test('Hermes original fingerprint, actor receipt and queue commit atomically; duplicate never notifies twice', async () => {
  const f = fixture(); let wakes = 0;
  const messages = new AsyncHermesMessages({ command: f.owner }, () => { wakes++; });
  try {
    const accepted = await messages.send(f.request, wait);
    assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted' && accepted.admitted);
    assert.equal(validConnectorOwnerOutput('hermesMessageSend', accepted), true); assert.equal(wakes, 1);
    const turn = f.store.turns.head<{ text: string; images: []; actorId: string }>('hermes', key)!;
    assert.equal(turn.payload.text, 'original text'); assert.equal(turn.payload.actorId, f.actor); assert.deepEqual(turn.payload.images, []);
    assert.equal(turn.id, accepted.receipt.result?.body.idempotencyKey);
    assert.deepEqual(f.store.commands.get(f.scope, f.request.commandKey), accepted.receipt);
    const duplicate = await messages.send(f.request, wait);
    assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
    assert.equal(wakes, 1); assert.equal(f.store.turns.maintenanceCount(), 1);
    assert.deepEqual(await messages.send({ ...f.request, payloadJson: JSON.stringify({ message: 'original text' }) }, wait), { error: 409 });
    assert.equal(JSON.stringify(accepted).includes('original text'), false);
  } finally { f.close(); }
});

for (const change of ['maintenance', 'closed', 'deleted', 'unknown', 'unready'] as const)
  test(`Hermes ${change}: reject only fresh work, recover prior accepted/unknown without resubmission`, async () => {
    const f = fixture();
    try {
      const accepted = await f.owner('hermesMessageSend', f.request);
      await f.store.commands.claimAsync(f.scope, 'uncertain', { message: 'uncertain' });
      if (change === 'maintenance') f.store.pauseTurnStarts();
      if (change === 'closed') f.store.stopTurnStarts();
      if (change === 'deleted') f.store.hermesJournal.beginDeletion(key);
      if (change === 'unknown') f.store.hermesJournal.update({ id: 'unknown', key, live: 'live', epoch: 'epoch', phase: 'unknown', members: ['member'], at: 1, updated: 1 });
      const rejectFresh = change === 'unready' ? { rejectFresh: 'runtime_unavailable' as const } : {};
      const duplicate = await f.owner('hermesMessageSend', { ...f.request, ...rejectFresh });
      assert.ok('receipt' in duplicate && 'receipt' in accepted && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
      const uncertain = await f.owner('hermesMessageSend', { ...f.request, commandKey: 'uncertain', payloadJson: '{"message":"uncertain"}', ...rejectFresh });
      assert.ok('receipt' in uncertain && !uncertain.admitted && uncertain.receipt?.state === 'outcome_unknown');
      const fresh = await f.owner('hermesMessageSend', { ...f.request, commandKey: 'fresh', ...rejectFresh });
      assert.ok('receipt' in fresh && fresh.receipt?.state === 'rejected' && !fresh.admitted); assert.equal(fresh.receipt.result?.status, 409);
      assert.equal(f.store.turns.maintenanceCount(), 1);
    } finally { f.close(); }
  });

for (const body of [{ message: '' }, { message: '/stop' }, { message: '/status' }, { message: '/compact' },
  { message: 'private', deliveryMode: 'mirror' }, { message: 'private', media: [{ name: 'private.txt', dataUrl: 'data:text/plain;base64,cHJpdmF0ZQ==' }] },
  { message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }])
  test(`Hermes refuses unsupported/invalid ordinary payload ${body.message.length > 30 ? 'oversize' : JSON.stringify(body.message)} ${'media' in body ? 'media' : 'deliveryMode' in body ? 'mirror' : ''}`, async () => {
    const f = fixture();
    try {
      const result = await f.owner('hermesMessageSend', { ...f.request, payloadJson: JSON.stringify(body) });
      assert.ok('receipt' in result && !result.admitted && result.receipt?.state === 'rejected');
      assert.equal(f.store.turns.maintenanceCount(), 0);
    } finally { f.close(); }
  });

test('Hermes missing original session rejects before queueing and retains definitive original receipt', async () => {
  const f = fixture();
  try {
    const result = await f.owner('hermesMessageSend', { ...f.request, key: 'hermes:missing' });
    assert.ok('receipt' in result && result.receipt?.state === 'rejected'); assert.equal(result.receipt.result?.status, 404);
    assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { f.close(); }
});

for (const stage of ['claim', 'queue'] as const) test(`Hermes revocation after ${stage} wait is rechecked before original queue commit`, async () => {
  const f = fixture();
  try {
    if (stage === 'claim') {
      const claim = f.store.commands.claimAsync.bind(f.store.commands);
      f.store.commands.claimAsync = async (...args) => { const result = await claim(...args); f.tokens.revoke(f.actor); return result; };
    } else {
      const enqueue = f.store.turns.enqueueAsync.bind(f.store.turns);
      f.store.turns.enqueueAsync = (...args) => { f.tokens.revoke(f.actor); return enqueue(...args); };
    }
    const result = await f.owner('hermesMessageSend', f.request);
    assert.ok('receipt' in result && result.receipt?.state === 'rejected'); assert.equal(result.receipt.result?.status, 403);
    assert.equal(f.store.turns.maintenanceCount(), 0); assert.equal(f.db.isTransaction, false);
    assert.deepEqual(await f.owner('hermesMessageSendReceiptRead', f.read), { error: 401 });
  } finally { f.close(); }
});

test('Hermes receipt write failure rolls back queue and retains unknown without duplicate admission', async () => {
  const f = fixture(), original = f.store.commands.queueCommit.bind(f.store.commands);
  try {
    f.store.commands.queueCommit = (...args) => { const commit = original(...args); return (db, admission) => { commit(db, admission); throw Error('receipt write fault'); }; };
    await assert.rejects(f.owner('hermesMessageSend', f.request), /receipt write fault/);
    assert.equal(f.store.turns.maintenanceCount(), 0); assert.equal(f.db.isTransaction, false);
    assert.equal(f.store.commands.get(f.scope, f.request.commandKey)?.state, 'outcome_unknown');
    const duplicate = await f.owner('hermesMessageSend', f.request);
    assert.ok('receipt' in duplicate && !duplicate.admitted && duplicate.receipt?.state === 'outcome_unknown');
  } finally { f.close(); }
});

test('Hermes lost physical release ACK reads original committed receipt and notifies exactly once', async () => {
  const f = fixture(), enqueue = f.store.turns.enqueueAsync.bind(f.store.turns); let wakes = 0;
  try {
    f.store.turns.enqueueAsync = async (...args) => { await enqueue(...args); throw Error('physical release ACK lost'); };
    const messages = new AsyncHermesMessages({ command: f.owner }, () => { wakes++; });
    const accepted = await messages.send(f.request, wait);
    assert.ok('receipt' in accepted && accepted.admitted && accepted.receipt?.state === 'accepted');
    await messages.send(f.request, wait); assert.equal(wakes, 1); assert.equal(f.store.turns.maintenanceCount(), 1);
  } finally { f.close(); }
});

test('Hermes caller timeout retains original physical promise; late commit notifies and recovery only reads', async () => {
  const f = fixture(); let release!: () => void, sends = 0, wakes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const messages = new AsyncHermesMessages({ command: async (kind, input) => {
    if (kind === 'hermesMessageSend') { sends++; await gate; } return f.owner(kind, input);
  } }, () => { wakes++; });
  try {
    await assert.rejects(messages.send(f.request, { timeoutMs: 5 }), e => e instanceof NativeOperationError && e.outcome === 'unknown');
    assert.equal(f.store.turns.maintenanceCount(), 0); release(); await tick(); await tick();
    const recovered = await messages.readReceipt(f.read, wait);
    assert.ok('receipt' in recovered && recovered.receipt?.state === 'accepted');
    assert.equal(wakes, 1); assert.equal(sends, 1); assert.equal(f.store.turns.maintenanceCount(), 1);
  } finally { release(); f.close(); }
});

test('Hermes send-only ACK recovery and actor isolation do not grant read or delegated prompt authority', async () => {
  const f = fixture();
  try {
    const sender = f.tokens.create({ label: 'sender', scopes: ['messages:send'] });
    const input = { ...f.request, authorization: `Bearer ${sender.token}` }, read = { ...f.read, authorization: input.authorization };
    const accepted = await f.owner('hermesMessageSend', input);
    const ack = await f.owner('hermesMessageSendReceiptRead', read);
    assert.ok('receipt' in accepted && 'receipt' in ack); assert.deepEqual(ack.receipt, accepted.receipt);
    assert.deepEqual(await f.owner('hermesMessageReceiptRead', read), { error: 403 });
    const other = await f.owner('hermesMessageReceiptRead', f.read); assert.ok('receipt' in other && other.receipt === null);
    const delegated = f.tokens.create({ label: 'delegated', scopes: ['messages:send', 'execution:delegate'] });
    assert.deepEqual(await f.owner('hermesMessageSend', { ...f.request, authorization: `Bearer ${delegated.token}` }), { error: 403 });
  } finally { f.close(); }
});

test('Hermes pre-aborted wait invokes no owner, and reentrant caller mutation cannot redirect notification', async () => {
  const f = fixture(); let calls = 0; const seen: string[] = [];
  const messages = new AsyncHermesMessages({ command: async (kind, input) => {
    calls++; const result = f.owner(kind, input); f.request.key = 'hermes:mutated'; return result;
  } }, originalKey => { seen.push(originalKey); });
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(messages.send(f.request, { ...wait, signal: abort.signal })); assert.equal(calls, 0);
    await messages.send(f.request, wait); assert.deepEqual(seen, [key]); assert.equal(calls, 1);
  } finally { f.close(); }
});

class Fake extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(1); }
}
for (const field of ['key', 'commandKey'] as const) test(`Hermes foreign ${field} receipt retires owner without notification or replay`, async () => {
  const f = fixture(), fake = new Fake(), owner = new AsyncConnectorOwner({ file: join(f.directory, 'unused.sqlite') }, silence, () => fake as unknown as Worker);
  let wakes = 0;
  try {
    const accepted = await f.owner('hermesMessageSend', f.request); assert.ok('receipt' in accepted);
    const messages = new AsyncHermesMessages(owner, () => { wakes++; });
    fake.emit('message', { kind: 'ready' });
    const pending = messages.send(f.request, wait), rejected = assert.rejects(pending,
      (error: unknown) => error instanceof NativeOperationError && error.outcome === 'unknown' && error.reason === 'native_error'); await tick();
    const foreign = { ...accepted, [field]: field === 'key' ? 'hermes:foreign' : 'foreign' };
    if (field === 'commandKey') foreign.receipt = { ...accepted.receipt!, key: 'foreign' };
    assert.equal(validConnectorOwnerOutput('hermesMessageSend', foreign), true);
    const request = fake.messages[0]!;
    fake.emit('message', { id: request.id, kind: request.kind, ok: true, body: JSON.stringify(foreign) });
    await rejected; assert.equal(wakes, 0); assert.equal(fake.messages.length, 1);
  } finally {
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped; f.close();
  }
});

test('Hermes real worker accepts maximum original text and reopens original receipt and queue without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-message-real-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  const source = new ConnectorUserStore(config.file);
  source.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] }); source.close();
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    const input = { key, authorization, commandKey: 'max-text', payloadJson: JSON.stringify({ message: '中'.repeat(MAX_MESSAGE_CHARS) }) };
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= connectorOwnerCommandBytes('hermesMessageSend'));
    const accepted = await owner.command('hermesMessageSend', input);
    assert.ok('receipt' in accepted && accepted.admitted && accepted.receipt?.state === 'accepted');
    await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
    const { payloadJson: _, ...read } = input;
    const recovered = await owner.command('hermesMessageReceiptRead', read);
    assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, accepted.receipt); assert.equal(recovered.queue.presence, 'present');
    const duplicate = await owner.command('hermesMessageSend', { ...input, rejectFresh: 'runtime_unavailable' });
    assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
    assert.equal(await owner.command('turnMaintenanceCount', { runtime: 'hermes' }), 1);
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
