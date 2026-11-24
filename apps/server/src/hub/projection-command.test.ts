import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { WORKSPACE_FILE_CARD_KINDS, workspaceFileCardResource, emptyNativeDrawio, NATIVE_DRAWIO_MAX_XML_BYTES,
  NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS, validWorkspaceFileCard, type DrawingContent } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberOwnerUnavailable, validHubMemberInput } from './member-owner-domain.js';
import { validHubProjectionCommand, validHubProjectionReply, validHubProjectionResult } from './member-projection-domain.js';
import { HUB_CONFIGURATION_KINDS } from './member-configuration-domain.js';
import { configurationWrite } from './configuration-test-fixtures.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(yes => setImmediate(yes));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-projection-command-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-projection-vault'), key = store.identities.issueKey('default');
  return { root, file, store, key, end: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function seed(store: HubStore) {
  const id = randomUUID();
  assert.equal(store.cards.save('default', id, { title: 'Metric', value: '42', detail: '', tone: 'green', progress: 100, revision: 0, mutationId: randomUUID() }).status, 'saved');
  for (const kind of HUB_CONFIGURATION_KINDS) assert.equal(store.cardConfigurations.save('default', id, configurationWrite(kind)).status, 'saved');
  return WORKSPACE_FILE_CARD_KINDS.map(kind => workspaceFileCardResource(kind, kind === 'notebook' ? 'hub:default' : id));
}
test('projection DTO is read-only, canonical, and exactly correlated by resource and kind', () => {
  const resourceId = workspaceFileCardResource('browser', randomUUID()), command = { resourceId };
  assert.equal(validHubProjectionCommand(command), true);
  for (const value of [{ ...command, userId: 'other' }, { ...command, action: 'save' }, { resourceId: '[ "browser", "id" ]' }, { resourceId: 'browser:id' }])
    assert.equal(validHubProjectionCommand(value), false);
  assert.equal(validHubMemberInput('workspaceProjection', { evidence: {}, expectedScope: 'a'.repeat(64), command }), true);
  const reply = { resourceId, document: { kind: 'browser', content: { title: 'Browser', url: '' }, revision: 0 } };
  assert.equal(validHubProjectionReply(command, reply), true);
  assert.equal(validHubProjectionReply(command, { ...reply, resourceId: workspaceFileCardResource('browser', randomUUID()) }), false);
  for (const document of [{ ...reply.document, updatedAt: 1 }, { ...reply.document, revision: -1 }, { ...reply.document, kind: 'website' }])
    assert.equal(validHubProjectionResult({ ...reply, document }), false);
  assert.equal(validHubProjectionReply(command, { resourceId, document: null }), true);
  assert.equal(validHubProjectionReply(command, null), true);
});
test('native notebook/report read accepts original NUL content without relaxing file writes or bounds', () => {
  for (const kind of ['notebook', 'report'] as const) {
    const resourceId = workspaceFileCardResource(kind, kind === 'notebook' ? 'hub:default' : randomUUID());
    const content = {title: 'Native', text: '\0'.repeat(NOTEBOOK_MAX_CHARS)};
    const reply = (content: unknown) => ({resourceId, document: {kind, content, revision: 1}});
    assert.equal(validHubProjectionResult(reply(content)), true);
    assert.equal(validWorkspaceFileCard({kind, content}), false);
    for (const bad of [{...content, text: content.text + 'x'}, {...content, title: 'x'.repeat(121)},
      {...content, text: 1}, {...content, injected: true}, {title: 'Missing text'},
      {...content, archive: '\0'.repeat(NOTEBOOK_ARCHIVE_MAX_CHARS + 1)}])
      assert.equal(validHubProjectionResult(reply(bad)), false);
    const archived = {...content, archive: '\0'.repeat(NOTEBOOK_ARCHIVE_MAX_CHARS)};
    assert.equal(validHubProjectionResult(reply(archived)), kind === 'notebook');
    assert.equal(validWorkspaceFileCard({kind, content: archived}), false);
  }
});
for (const kind of WORKSPACE_FILE_CARD_KINDS) test(`${kind}: exact original projection survives command boundary without import or mutation`, async t => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const resources = seed(f.store), resourceId = resources[WORKSPACE_FILE_CARD_KINDS.indexOf(kind)]!;
    const snapshot = await original.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    const proof = { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId } };
    const before = f.store.cardFileProjection.get('default', resourceId) ?? null;
    t.mock.method(f.store.cardFileProjection, 'importFile', () => assert.fail('read cannot import'));
    t.mock.method(f.store.cardFileProjection, 'claim', () => assert.fail('read cannot claim'));
    assert.deepEqual(await original.command('workspaceProjection', proof), { resourceId, document: before });
    assert.deepEqual(f.store.cardFileProjection.get('default', resourceId) ?? null, before);
    assert.equal(await original.command('workspaceProjection', { ...proof, expectedScope: '0'.repeat(64) }), null);
  } finally { await original.close(); await f.end(); }
});
test('original projection retains cross-user and session-notebook ownership fences and distinct missing state', async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const resources = seed(f.store), other = f.store.createUser('Other'), key = f.store.identities.issueKey(other.id);
    const snapshot = await original.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
    const read = (resourceId: string) => original.command('workspaceProjection', { evidence: { accessKey: key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId } });
    const resourceId = resources[WORKSPACE_FILE_CARD_KINDS.indexOf('browser')]!;
    assert.deepEqual(await read(resourceId), { resourceId, document: null });
    const session = workspaceFileCardResource('notebook', 'session:not-owned');
    assert.deepEqual(await read(session), { resourceId: session, document: null });
  } finally { await original.close(); await f.end(); }
});
test('actual sole worker returns every original native projection after close/reopen, including maximum escaped XML', async () => {
  const f = fixture(), resources = seed(f.store), id = randomUUID();
  const noteId = JSON.stringify(['hub-notebook', 1]);
  assert.ok(f.store.notebooks.save('default', { resourceId: noteId, revision: 0, text: '\0'.repeat(NOTEBOOK_MAX_CHARS) }));
  assert.ok(f.store.notebooks.saveArchive('default', { resourceId: noteId, revision: 0, text: '\0'.repeat(NOTEBOOK_ARCHIVE_MAX_CHARS) }));
  assert.equal(f.store.cardFileProjection.claim('default', workspaceFileCardResource('notebook', 'hub:default'), randomUUID(), true), true);
  const drawing: DrawingContent = { format: 'agentopsdeck-drawing', version: 1, title: 'Maximum ink', nodes: [], edges: [],
    strokes: Array.from({ length: 16 }, () => ({ id: randomUUID(), color: '#000000', width: 1,
      points: Array.from({ length: 512 }, (_, n) => [n, n] as [number, number]) })) };
  assert.equal(f.store.drawings.save('default', id, { ...drawing, revision: 0, mutationId: randomUUID() }).status, 'saved');
  resources.push(workspaceFileCardResource('drawing', id));
  const content = emptyNativeDrawio(); content.title = 'x'.repeat(160);
  const shell = '<mxfile></mxfile>'; content.xml = '<mxfile>' + '"'.repeat(NATIVE_DRAWIO_MAX_XML_BYTES - shell.length) + '</mxfile>';
  assert.equal(f.store.nativeDrawio.save('default', id, { ...content, revision: 0, mutationId: randomUUID() }).status, 'saved');
  resources.push(workspaceFileCardResource('native-drawio', id));
  const expected = resources.map(resourceId => ({ resourceId, document: f.store.cardFileProjection.get('default', resourceId) ?? null }));
  await f.store.close();
  let owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-projection-vault' }, quiet);
  try {
    for (let round = 0; round < 2; round++) {
      const snapshot = await owner.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
      for (const value of expected) assert.deepEqual(await owner.command('workspaceProjection', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId: value.resourceId } }), value);
      await owner.close();
      if (round === 0) owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-projection-vault' }, quiet);
    }
  } finally { await owner.close(); rmSync(f.root, { recursive: true, force: true }); }
});
test('cross-resource worker reply is refused without terminating an unknown writer', async () => {
  class FakeWorker extends EventEmitter {
    messages: { id: number; kind: string }[] = [];
    postMessage(value: { id: number; kind: string }) { this.messages.push(value); }
    terminate() { assert.fail('unknown writer cannot be killed'); }
  }
  const root = mkdtempSync(join(tmpdir(), 'hub-projection-protocol-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const pending = assert.rejects(owner.command('workspaceProjection', { evidence: {}, expectedScope: 'a'.repeat(64), command: { resourceId: workspaceFileCardResource('browser', randomUUID()) } }), HubMemberOwnerUnavailable);
    await tick(); fake.emit('message', { ...fake.messages[0]!, ok: true, body: JSON.stringify({ resourceId: workspaceFileCardResource('browser', randomUUID()), document: null }) });
    await pending; assert.equal(owner.snapshot().unavailable, true);
  } finally { const retired = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retired; rmSync(root, { recursive: true, force: true }); }
});
