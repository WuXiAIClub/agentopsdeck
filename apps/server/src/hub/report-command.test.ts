import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NOTEBOOK_MAX_CHARS, workspaceFileCardResource, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { validHubReportCommand, validHubReportResult, validHubReportReply } from './member-report-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
const write = (revision = 0, text = 'Report text'): Extract<WorkspaceFileCardWrite, { kind: 'report' }> => ({ kind: 'report', content: { title: 'Report', text }, revision, mutationId: randomUUID() });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-report-command-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-report-vault'), key = store.identities.issueKey('default');
  return { root, file, store, key, end: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('original report partial text/title failure rolls back content and mutation receipt together', async t => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const resourceId = workspaceFileCardResource('report', randomUUID()), snapshot = await original.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    const invoke = (document: WorkspaceFileCardWrite) => original.command('workspaceReport', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId, document } });
    const first = await invoke(write()); assert.ok(first && first.status === 'saved');
    const next = { ...write(first.document.revision, 'New text'), content: { title: 'New title', text: 'New text' } } as WorkspaceFileCardWrite;
    const save = f.store.notebooks.save.bind(f.store.notebooks); let saves = 0;
    const mock = t.mock.method(f.store.notebooks, 'save', (...args: Parameters<typeof save>) => {
      if (++saves === 2) throw Error('isolated-title-write-fault'); return save(...args);
    });
    await assert.rejects(invoke(next)); assert.equal(saves, 2);
    assert.deepEqual(f.store.cardFileProjection.get('default', resourceId), first.document);
    mock.mock.restore();
    const retried = await invoke(next); assert.ok(retried && retried.status === 'saved');
    assert.equal(retried.document.kind, 'report'); assert.ok(retried.document.kind === 'report');
    assert.deepEqual(retried.document.content, next.content);
  } finally { await original.close(); await f.end(); }
});
test('report quota remains original 64 resources and rejects the next without creating content', async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const snapshot = await original.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    const invoke = (resourceId: string) => original.command('workspaceReport', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId, document: write() } });
    for (let n = 0; n < 64; n++) { const result = await invoke(workspaceFileCardResource('report', randomUUID())); assert.ok(result && result.status === 'saved'); }
    const resourceId = workspaceFileCardResource('report', randomUUID());
    assert.deepEqual(await invoke(resourceId), { resourceId, status: 'limit' });
    assert.equal(f.store.cardFileProjection.get('default', resourceId)?.revision, 0);
  } finally { await original.close(); await f.end(); }
});
test('report fixed DTO rejects authority, binding, raw SQL, foreign kinds and malformed replies', () => {
  const resourceId = workspaceFileCardResource('report', randomUUID()), document = write(), command = { resourceId, document };
  assert.equal(validHubReportCommand(command), true);
  for (const input of [{ ...command, userId: 'other' }, { ...command, expectedBinding: 'none' }, { ...command, sql: 'select 1' },
    { resourceId: workspaceFileCardResource('notebook', 'hub:default'), document }, { ...command, document: { ...document, revision: -1 } }])
    assert.equal(validHubReportCommand(input), false);
  const reply = { resourceId, status: 'saved', document: { kind: 'report', content: { title: 'Later', text: 'current state' }, revision: 19 } };
  assert.equal(validHubReportReply(resourceId, reply), true, 'old identical receipt returns current projection, not revision+1');
  assert.equal(validHubReportReply(workspaceFileCardResource('report', randomUUID()), reply), false);
  assert.equal(validHubReportResult({ ...reply, document: { ...reply.document, updatedAt: 1 } }), false);
  assert.equal(validHubReportResult({ resourceId, status: 'binding-conflict' }), true);
  assert.equal(validHubReportResult({ resourceId, status: 'binding-conflict', document: reply.document }), false);
});
for (const member of [false, true]) test(`${member ? 'member' : 'admin'}: original report save, later replay and mutation conflict preserve current projection`, async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const userId = member ? f.store.createUser('Member').id : 'default', key = member ? f.store.identities.issueKey(userId) : f.key;
    const snapshot = await original.command('memberSnapshot', { accessKey: key.token }); assert.ok(snapshot);
    const resourceId = workspaceFileCardResource('report', randomUUID()), first = write();
    const save = (document: WorkspaceFileCardWrite, expectedScope = snapshot.recoveryScope) => original.command('workspaceReport', {
      evidence: { accessKey: key.token }, expectedScope, command: { resourceId, document } });
    const a = await save(first); assert.ok(a && a.status === 'saved');
    const b = await save(write(a.document.revision, 'Second')); assert.ok(b && b.status === 'saved');
    assert.deepEqual(await save(first), b, 'identical old mutation returns latest durable projection');
    assert.deepEqual(await save({ ...first, content: { title: 'Changed replay', text: 'different' } }), { resourceId, status: 'conflict' });
    assert.deepEqual(await save(write(0, 'stale')), { resourceId, status: 'conflict' });
    assert.equal(await save(write(b.document.revision), '0'.repeat(64)), null);
    assert.deepEqual(f.store.cardFileProjection.get(userId, resourceId), b.document);
    if (member) assert.notDeepEqual(f.store.cardFileProjection.get('default', resourceId), b.document);
  } finally { await original.close(); await f.end(); }
});
test('binding appearing before original command refuses local mutation, never imports or writes an Agent file', async t => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const resourceId = workspaceFileCardResource('report', randomUUID()), snapshot = await original.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    t.mock.method(f.store.cardFiles, 'current', () => ({ bindingId: randomUUID() }));
    t.mock.method(f.store.cardFileProjection, 'saveReport', () => assert.fail('bound local save must not reach native writer'));
    assert.deepEqual(await original.command('workspaceReport', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope,
      command: { resourceId, document: write() } }), { resourceId, status: 'binding-conflict' });
  } finally { await original.close(); await f.end(); }
});
test('non-UUID canonical report keeps original conflict, rather than changing to input rejection', async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet);
  try {
    const resourceId = workspaceFileCardResource('report', 'not-a-uuid'), snapshot = await original.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    assert.deepEqual(await original.command('workspaceReport', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope,
      command: { resourceId, document: write() } }), { resourceId, status: 'conflict' });
  } finally { await original.close(); await f.end(); }
});
test('actual sole worker saves/reopens maximum escaped report and replays original receipt after later write', async () => {
  const f = fixture(), resourceId = workspaceFileCardResource('report', randomUUID()), first = write(0, '\u0001'.repeat(NOTEBOOK_MAX_CHARS));
  await f.store.close();
  let owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-report-vault' }, quiet);
  try {
    const snapshot = await owner.command('memberSnapshot', { accessKey: f.key.token }); assert.ok(snapshot);
    const save = (document: WorkspaceFileCardWrite) => owner.command('workspaceReport', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId, document } });
    const a = await save(first); assert.ok(a && a.status === 'saved');
    const b = await save(write(a.document.revision, 'Later durable content')); assert.ok(b && b.status === 'saved');
    await owner.close(); owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-report-vault' }, quiet);
    assert.deepEqual(await save(first), b);
    const projection = await owner.command('workspaceProjection', { evidence: { accessKey: f.key.token }, expectedScope: snapshot.recoveryScope, command: { resourceId } });
    assert.deepEqual(projection, { resourceId, document: b.document });
  } finally { await owner.close(); await f.end(); }
});
