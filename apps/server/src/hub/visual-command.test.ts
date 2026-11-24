import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { emptyDrawing, emptyNativeDrawio, type NativeDrawioWrite, type DrawingWrite, type CardWrite } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner, encodeHubMemberJson } from './async-member-owner.js';
import { HubMemberOwnerUnavailable, hubMemberCommandBytes, hubMemberCommandNodes, validHubMemberInput } from './member-owner-domain.js';
import { validHubVisualCommand, validHubVisualResult, validHubVisualReply, hubVisualExpectation, type HubVisualCommand } from './member-visual-domain.js';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const card = (revision = 0): CardWrite => ({ title: 'Metric', value: '42', detail: 'Private', tone: 'blue', progress: 25, revision, mutationId: randomUUID() });
const drawing = (revision = 0): DrawingWrite => ({ ...emptyDrawing(), revision, mutationId: randomUUID() });
const native = (revision = 0): NativeDrawioWrite => ({ ...emptyNativeDrawio(), revision, mutationId: randomUUID() });
const tick = () => new Promise<void>(yes => setImmediate(yes));
async function fixture(work: (store: HubStore, original: OriginalHubAdministrativeCommands, proof: { evidence: { accessKey: string }; expectedScope: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-visual-command-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-visual-vault');
  const original = new OriginalHubAdministrativeCommands(store, quiet), key = store.identities.issueKey('default');
  try {
    const snapshot = await original.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
    await work(store, original, { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope });
  } finally { await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('fixed visual DTO refuses caller authority, bindings, extra methods and invalid documents', () => {
  for (const kind of ['card', 'drawing', 'native-drawio'] as const) {
    const command: HubVisualCommand = { kind, action: 'save', resourceId: randomUUID(), document: kind === 'card' ? card() : kind === 'drawing' ? drawing() : native() } as HubVisualCommand;
    if (command.action !== 'save') assert.fail('save fixture');
    assert.equal(validHubVisualCommand(command), true);
    for (const value of [{ ...command, userId: 'other' }, { ...command, bindingId: randomUUID() }, { ...command, bypass: true },
      { ...command, action: 'import' }, { ...command, resourceId: '../other' }, { ...command, document: { ...command.document, revision: Number.MAX_SAFE_INTEGER } }])
      assert.equal(validHubVisualCommand(value), false);
    assert.equal(validHubMemberInput('workspaceVisual', { evidence: {}, expectedScope: 'a'.repeat(64), command }), true);
    assert.equal(validHubMemberInput('workspaceVisual', { evidence: {}, expectedScope: 'a'.repeat(64), command, userId: 'other' }), false);
  }
});
for (const kind of ['card', 'drawing', 'native-drawio'] as const) test(`${kind}: exact receipt correlation includes kind/action/resource/revision/content`, () => {
  const command = { kind, action: 'save', resourceId: randomUUID(), document: kind === 'card' ? card() : kind === 'drawing' ? drawing() : native() } as HubVisualCommand;
  assert.equal(command.action, 'save'); if (command.action !== 'save') return;
  const { mutationId: _mutation, ...content } = command.document;
  const document = { ...content, resourceId: command.resourceId, revision: 1, updatedAt: 1 };
  const reply = { kind, action: 'save', result: { status: 'saved', document } }, expected = hubVisualExpectation(command);
  assert.equal(validHubVisualReply(expected, reply), true);
  for (const patch of [{ resourceId: randomUUID() }, { revision: 2 }, { title: 'Wrong content' }, { userId: 'other' }])
    assert.equal(validHubVisualReply(expected, { ...reply, result: { status: 'saved', document: { ...document, ...patch } } }), false);
  assert.equal(validHubVisualReply(expected, { ...reply, kind: kind === 'card' ? 'drawing' : 'card' }), false);
  assert.equal(validHubVisualReply(expected, { kind, action: 'list', summaries: [] }), false);
  assert.equal(validHubVisualReply(expected, { kind, action: 'save', result: { status: 'conflict' } }), true);
  assert.equal(validHubVisualResult({ ...reply, result: { status: 'saved', document: { ...document, revision: Number.MAX_SAFE_INTEGER } } }), true);
});

for (const kind of ['card', 'drawing', 'native-drawio'] as const) test(`${kind}: original CAS, exact receipts, user isolation, native lock and authority`, () => fixture(async (store, original, proof) => {
  const resourceId = randomUUID(), document = kind === 'card' ? card() : kind === 'drawing' ? drawing() : native();
  const command = (value: HubVisualCommand) => original.command('workspaceVisual', { ...proof, command: value });
  const write = { kind, action: 'save', resourceId, document } as HubVisualCommand;
  const saved = await command(write); assert.ok(saved && saved.action === 'save' && saved.result.status === 'saved');
  assert.deepEqual(await command(write), saved);
  assert.deepEqual(await command({ ...write, document: { ...document, title: 'Changed same mutation' } } as HubVisualCommand), { kind, action: 'save', result: { status: 'mutation-reused' } });
  assert.deepEqual(await command({ ...write, document: { ...document, mutationId: randomUUID() } } as HubVisualCommand), { kind, action: 'save', result: { status: 'conflict' } });
  const other = store.createUser('Isolated'), key = store.identities.issueKey(other.id);
  const snapshot = await original.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
  const isolated = await original.command('workspaceVisual', { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope, command: { kind, action: 'get', resourceId } });
  assert.ok(isolated && isolated.action === 'get'); assert.equal(isolated.document?.revision ?? 0, 0);
  const locks = new WorkspaceNativeFileLocks((store as unknown as { db: DatabaseSync }).db);
  assert.equal(locks.claim('default', randomUUID(), [{ kind: kind === 'card' ? 'metric-card' : kind, id: resourceId }]), true);
  assert.deepEqual(await command(write), { kind, action: 'save', result: { status: 'file-managed' } });
  assert.equal(await original.command('workspaceVisual', { ...proof, expectedScope: 'b'.repeat(64), command: write }), null);
  assert.equal(await original.command('workspaceVisual', { ...proof, evidence: { accessKey: 'revoked-key' }, command: write }), null);
}));

test('full 8192-point drawing passes RPC budget, original save and receipt without adding strokes to legacy content', () => fixture(async (_store, original, proof) => {
  const document: DrawingWrite = { ...drawing(), strokes: Array.from({ length: 16 }, () => ({ id: randomUUID(), color: '#123456', width: 2,
    points: Array.from({ length: 512 }, (_, index): [number, number] => [index, index]) })) };
  const command: HubVisualCommand = { kind: 'drawing', action: 'save', resourceId: 'default', document };
  assert.equal(validHubVisualCommand(command), true);
  assert.doesNotThrow(() => encodeHubMemberJson({ ...proof, command }, hubMemberCommandBytes('workspaceVisual'), hubMemberCommandNodes('workspaceVisual')));
  const reply = await original.command('workspaceVisual', { ...proof, command }); assert.ok(reply && reply.action === 'save' && reply.result.status === 'saved');
  assert.equal(validHubVisualReply(hubVisualExpectation(command), reply), true);
  assert.deepEqual(await original.command('workspaceVisual', { ...proof, command }), reply);
  const legacy = await original.command('workspaceVisual', { ...proof, command: { kind: 'drawing', action: 'get', resourceId: randomUUID() } });
  assert.ok(legacy && legacy.action === 'get' && legacy.document); assert.equal(Object.hasOwn(legacy.document, 'strokes'), false);
  assert.equal(validHubVisualCommand({ ...command, document: { ...document, strokes: [...document.strokes!, document.strokes![0]] } }), false);
}));

test('native XML max byte limit, exact old receipt and untrusted envelope survive the bounded original command', () => fixture(async (store, original, proof) => {
  const xml = '<mxfile>' + '"'.repeat(1024 * 1024 - 17) + '</mxfile>';
  const command: HubVisualCommand = { kind: 'native-drawio', action: 'save', resourceId: randomUUID(), document: { ...native(), xml } };
  assert.equal(validHubVisualCommand(command), true);
  assert.doesNotThrow(() => encodeHubMemberJson({ ...proof, command }, hubMemberCommandBytes('workspaceVisual'), hubMemberCommandNodes('workspaceVisual')));
  const saved = await original.command('workspaceVisual', { ...proof, command });
  assert.ok(saved && saved.action === 'save' && saved.result.status === 'saved');
  assert.equal(validHubVisualReply(hubVisualExpectation(command), saved), true);
  assert.deepEqual(await original.command('workspaceVisual', { ...proof, command }), saved);
  assert.equal(store.nativeDrawio.get('default', command.resourceId).xml, xml);
  for (const bad of [xml + ' ', '<!DOCTYPE mxfile><mxfile></mxfile>', '<mxfile><?fetch private?></mxfile>', '<mxfile>\u0000</mxfile>', '<svg/>'])
    assert.equal(validHubVisualCommand({ ...command, document: { ...command.document, xml: bad } }), false);
  assert.equal(validHubVisualReply(hubVisualExpectation(command), { ...saved, result: { status: 'saved', document: { ...saved.result.document, xml: emptyNativeDrawio().xml } } }), false);
  assert.equal(validHubVisualResult({ ...saved, result: { status: 'saved', document: { ...saved.result.document, xml: '<svg/>' } } }), false);
  assert.equal(validHubVisualResult({ kind: 'native-drawio', action: 'list', summaries: Array.from({ length: 33 }, () => ({ resourceId: randomUUID(), title: 'Native', revision: 1, updatedAt: 1 })) }), false);
  const missingId = randomUUID();
  assert.deepEqual(await original.command('workspaceVisual', { ...proof, command: { kind: 'native-drawio', action: 'get', resourceId: missingId } }),
    { kind: 'native-drawio', action: 'get', document: { ...emptyNativeDrawio(), resourceId: missingId, revision: 0, updatedAt: null } });
}));

test('actual sole worker persists all three visual documents and exact receipts across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-visual-worker-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'isolated-visual-vault'), key = seed.identities.issueKey('default'); await seed.close();
  let owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-visual-vault' }, quiet);
  const cases = ['card', 'drawing', 'native-drawio'].map(kind => ({ kind, action: 'save', resourceId: randomUUID(), document: kind === 'card' ? card() : kind === 'drawing' ? drawing()
    : { ...native(), xml: '<mxfile>' + '"'.repeat(1024 * 1024 - 17) + '</mxfile>' } }) as HubVisualCommand);
  try {
    const snapshot = await owner.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
    const proof = { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope }, saved = [];
    for (const command of cases) saved.push(await owner.command('workspaceVisual', { ...proof, command }));
    await owner.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-visual-vault' }, quiet);
    for (const [index, command] of cases.entries()) {
      assert.deepEqual(await owner.command('workspaceVisual', { ...proof, command }), saved[index]);
      if (command.action !== 'save') assert.fail('save fixture');
      const read = await owner.command('workspaceVisual', { ...proof, command: { kind: command.kind, action: 'get', resourceId: command.resourceId } });
      assert.ok(read && read.action === 'get' && read.document?.revision === 1);
    }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('worker protocol fails closed on a well-shaped cross-resource visual reply without terminating the writer', async () => {
  class FakeWorker extends EventEmitter {
    messages: { id: number; kind: string }[] = [];
    postMessage(value: { id: number; kind: string }) { this.messages.push(value); }
    terminate() { assert.fail('unknown writer must not be killed'); }
  }
  const root = mkdtempSync(join(tmpdir(), 'hub-visual-protocol-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const pending = assert.rejects(owner.command('workspaceVisual', { evidence: {}, expectedScope: 'a'.repeat(64),
      command: { kind: 'drawing', action: 'get', resourceId: 'default' } }), HubMemberOwnerUnavailable);
    await tick(); const sent = fake.messages[0]!;
    fake.emit('message', { ...sent, ok: true, body: JSON.stringify({ kind: 'drawing', action: 'get', document: { ...emptyDrawing(), resourceId: randomUUID(), revision: 0, updatedAt: null } }) });
    await pending; assert.equal(owner.snapshot().unavailable, true);
  } finally { const retired = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retired; rmSync(root, { recursive: true, force: true }); }
});
