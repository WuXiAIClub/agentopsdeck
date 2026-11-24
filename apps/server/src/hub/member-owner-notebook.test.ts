import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, hubMemberCommandSteps, hubMemberFailureSteps, validHubMemberInput,
  HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { validHubNotebookCommand, validHubNotebookResult, validHubNotebookReply, hubNotebookReplyExpectation,
  type HubNotebookCommand } from './member-notebook-domain.js';
import { notebookHash, type NotebookMove } from './notebook-operations.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const resourceId = 'hub:default';
const input = (text = 'Original rich text', revision = 0) => ({ resourceId, text, revision });
const moving = (text: string, hotRevision = 1, coldRevision = 0): NotebookMove => ({ requestId: randomUUID(), direction: 'archive',
  hotRevision, coldRevision, ranges: [{ start: 0, end: text.length, sha256: notebookHash(text) }] });
async function fixture(work: (f: ReturnType<typeof seed>) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-notebook-r256-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'notebook-fixture');
  try { await work(seed(store, file)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Member'), other = store.createUser('Other');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  const execute = (command: HubNotebookCommand) => executeHubMemberCommand(store, 'personalNotebook', { ...proof, command });
  return { file, store, member, other, key, token, proof, db, execute };
}
test('notebook telemetry appends stable operation/failure IDs and refuses caller principal or file bypass', () => {
  assert.equal(hubMemberCommandSteps.personalNotebook, 49); assert.equal(hubMemberFailureSteps.personalNotebook, 69);
  assert.equal(hubMemberCommandSteps.boardMachine, 48); assert.equal(hubMemberFailureSteps.boardMachine, 68);
  assert.equal(new Set(Object.values(hubMemberCommandSteps)).size, Object.keys(hubMemberCommandSteps).length);
  for (const c of [{ action: 'get', resourceId, userId: 'other' }, { action: 'save', document: { ...input(), bindingId: randomUUID() } },
    { action: 'search', resourceId, query: ' ', area: 'both' }, { action: 'saveArchive', document: input('x'.repeat(NOTEBOOK_ARCHIVE_MAX_CHARS + 1)) },
    { action: 'save', document: input('x'.repeat(NOTEBOOK_MAX_CHARS + 1)) }, { action: 'get', resourceId: 'x'.repeat(8193) },
    { action: 'receipt', resourceId, requestId: 'not-uuid' }, { action: 'plannedMove', resourceId },
    { action: 'move', resourceId, input: { ...moving('text'), prepare: true } }]) assert.equal(validHubNotebookCommand(c), false);
});
test('notebook original identity/scope fences CAS and denies before receipt lookup', () => fixture(f => {
  assert.ok(f.execute({ action: 'save', document: input() }));
  assert.equal(validHubMemberInput('personalNotebook', { ...f.proof, userId: f.other.id, command: { action: 'get', resourceId } }), false);
  assert.equal(executeHubMemberCommand(f.store, 'personalNotebook', { ...f.proof, expectedScope: 'f'.repeat(64), command: { action: 'save', document: input('changed', 1) } }), null);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(f.execute({ action: 'receipt', resourceId, requestId: randomUUID() }), null);
  assert.equal(f.store.notebooks.get(f.member.id, resourceId).text, input().text);
  assert.equal(f.store.notebooks.get(f.other.id, resourceId).revision, 0);
}));
test('one worker preserves old cookies, hot/cold text, CAS and exact move receipt across reopen', () => fixture(async f => {
  const text = '**Rich text**\n<!-- cp-font:v2 -->\nkeep', doc = input(text), move = moving(text);
  f.store.notebooks.save(f.member.id, doc);
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'notebook-fixture' }, quiet);
  const command = (c: HubNotebookCommand) => owner.command('personalNotebook', { ...f.proof, command: c });
  let saved;
  try {
    await owner.open();
    const before = await command({ action: 'get', resourceId }); assert.ok(before?.action === 'get'); assert.equal(before.document.text, text);
    saved = await command({ action: 'move', resourceId, input: move }); assert.ok(saved?.action === 'move' && saved.result);
    assert.deepEqual(saved.result, { hotRevision: 2, coldRevision: 1, moved: text.length });
    assert.deepEqual(await command({ action: 'move', resourceId, input: move }), saved, 'explicit recovery returns old immutable receipt');
    const receipt = await command({ action: 'receipt', resourceId, requestId: move.requestId });
    assert.ok(receipt?.action === 'receipt'); assert.deepEqual(receipt.result, saved.result);
    assert.deepEqual(await command({ action: 'save', document: doc }), { action: 'save', document: null }, 'plain save CAS has no automatic replay');
    const archive = await command({ action: 'archive', resourceId }); assert.ok(archive?.action === 'archive'); assert.equal(archive.document.text, text);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'notebook-fixture');
  try {
    assert.equal(reopened.notebooks.get(f.member.id, resourceId).text, ''); assert.equal(reopened.notebooks.getArchive(f.member.id, resourceId).text, text);
    assert.deepEqual(reopened.notebooks.moveReceipt(f.member.id, resourceId, move.requestId), saved?.action === 'move' ? saved.result : undefined);
    assert.ok(reopened.identities.requestPrincipal(new Request('http://fixture/', { headers: { cookie: 'agentopsdeck_session=' + f.token } }), () => false));
    assert.equal(reopened.notebooks.getArchive(f.other.id, resourceId).revision, 0);
    const db = (reopened as unknown as { db: DatabaseSync }).db; assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally { await reopened.close(); }
}));
test('move failure rolls hot/cold/receipt back together and explicit retry commits once', () => fixture(f => {
  const text = 'atomic selection', move = moving(text); f.store.notebooks.save(f.member.id, input(text));
  f.db.exec("CREATE TRIGGER deny_notebook_receipt BEFORE INSERT ON hub_notebook_move_receipts BEGIN SELECT RAISE(ABORT,'deny'); END");
  assert.throws(() => f.execute({ action: 'move', resourceId, input: move }));
  assert.equal(f.store.notebooks.get(f.member.id, resourceId).revision, 1);
  assert.equal(f.store.notebooks.get(f.member.id, resourceId).text, text);
  assert.equal(f.store.notebooks.getArchive(f.member.id, resourceId).revision, 0);
  assert.equal(f.store.notebooks.moveReceipt(f.member.id, resourceId, move.requestId), undefined);
  f.db.exec('DROP TRIGGER deny_notebook_receipt');
  const saved = f.execute({ action: 'move', resourceId, input: move }); assert.ok(saved?.action === 'move' && saved.result);
  assert.deepEqual(f.execute({ action: 'move', resourceId, input: move }), saved);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM hub_notebook_move_receipts').get() as { n: number }).n, 1);
  assert.deepEqual(f.execute({ action: 'move', resourceId, input: { ...move, direction: 'restore' } }), { action: 'move', resourceId, requestId: move.requestId, result: null });
}));
test('native-file managed notes refuse uncoordinated hot/cold saves and moves', () => fixture(f => {
  const text = 'managed text'; f.store.notebooks.save(f.member.id, input(text));
  // Use the original binding schema; no file RPC is admitted by this domain.
  f.db.prepare('INSERT INTO hub_workspace_native_file_locks VALUES (?,?,?,?,?)').run(f.member.id, 'notebook', resourceId, randomUUID(), 'all');
  f.db.prepare('INSERT INTO hub_workspace_native_file_locks VALUES (?,?,?,?,?)').run(f.member.id, 'notebook-archive', resourceId, randomUUID(), 'all');
  assert.deepEqual(f.execute({ action: 'save', document: input('bypass', 1) }), { action: 'save', document: null });
  assert.deepEqual(f.execute({ action: 'saveArchive', document: input('bypass cold') }), { action: 'saveArchive', document: null });
  const move = moving(text); assert.deepEqual(f.execute({ action: 'move', resourceId, input: move }), { action: 'move', resourceId, requestId: move.requestId, result: null });
  assert.equal(f.store.notebooks.get(f.member.id, resourceId).text, text);
  assert.equal(f.store.notebooks.getArchive(f.member.id, resourceId).revision, 0);
}));
test('nested notebook move releases only its savepoint and parent rollback removes both texts and receipt', () => fixture(f => {
  const text = 'parent transaction', move = moving(text);
  f.store.notebooks.save(f.member.id, input(text));
  f.db.exec('BEGIN IMMEDIATE');
  try {
    const result = f.execute({ action: 'move', resourceId, input: move });
    assert.ok(result?.action === 'move' && result.result);
    assert.equal(f.db.isTransaction, true);
    assert.equal(f.store.notebooks.getArchive(f.member.id, resourceId).text, text);
  } finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.store.notebooks.get(f.member.id, resourceId).text, text);
  assert.equal(f.store.notebooks.getArchive(f.member.id, resourceId).revision, 0);
  assert.equal(f.store.notebooks.moveReceipt(f.member.id, resourceId, move.requestId), undefined);
}));
test('maximum escaped cold document passes actual worker without truncation or a 16KiB limit', () => fixture(async f => {
  await f.store.close(); const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'notebook-fixture' }, quiet);
  const text = '\u0001'.repeat(NOTEBOOK_ARCHIVE_MAX_CHARS);
  try { await owner.open();
    const result = await owner.command('personalNotebook', { ...f.proof, command: { action: 'saveArchive', document: input(text) } });
    assert.ok(result?.action === 'saveArchive' && result.document); assert.equal(result.document.text, text); assert.equal(result.document.revision, 1);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}));
test('search projections retain original area/revision/order/snippets and bounded wire', () => fixture(f => {
  f.store.notebooks.save(f.member.id, input('needle '.repeat(100))); f.store.notebooks.saveArchive(f.member.id, input('cold needle '.repeat(100)));
  for (const area of ['hot', 'cold', 'both'] as const) {
    const c: HubNotebookCommand = { action: 'search', resourceId, query: 'needle', area }, result = f.execute(c);
    assert.ok(result?.action === 'search'); assert.deepEqual(result.result, f.store.notebooks.searchAreas(f.member.id, resourceId, 'needle', area));
    assert.equal(validHubNotebookReply(hubNotebookReplyExpectation(c), result), true); assert.equal(result.result.results.length, 20);
  }
}));
test('protocol correlates resource, revision, original SQLite text, original move ID and selector', () => {
  const c: HubNotebookCommand = { action: 'saveArchive', document: input('\ud800') }, expected = hubNotebookReplyExpectation(c);
  const reply = { action: 'saveArchive', document: { ...input('\ufffd', 1), updatedAt: 1 } };
  assert.equal(validHubNotebookReply(expected, reply), true);
  for (const change of [{ text: '\ud801' }, { revision: 2 }, { resourceId: 'other' }, { updatedAt: null }])
    assert.equal(validHubNotebookReply(expected, { ...reply, document: { ...reply.document, ...change } }), false);
  assert.equal(validHubNotebookResult({ action: 'get', document: { ...input('not empty'), updatedAt: null } }), false);
  assert.equal(validHubNotebookCommand({ action: 'save', document: input('text', Number.MAX_SAFE_INTEGER) }), false);
  const move = moving('text'), m = hubNotebookReplyExpectation({ action: 'move', resourceId, input: move });
  const ack = { action: 'move', resourceId, requestId: move.requestId, result: { hotRevision: 2, coldRevision: 1, moved: 4 } };
  assert.equal(validHubNotebookReply(m, ack), true);
  for (const change of [{ requestId: randomUUID() }, { resourceId: 'other' }, { result: { ...ack.result, hotRevision: 3 } }, { result: { ...ack.result, moved: 3 } }])
    assert.equal(validHubNotebookReply(m, { ...ack, ...change }), false);
  const s = hubNotebookReplyExpectation({ action: 'search', resourceId, query: 'needle', area: 'hot' });
  const search = { action: 'search', resourceId, result: { hotRevision: 1, coldRevision: null, results: [{ area: 'hot', revision: 1, start: 0, end: 6, text: 'needle' }] } };
  assert.equal(validHubNotebookReply(s, search), true);
  assert.equal(validHubNotebookReply(s, { ...search, result: { ...search.result, results: [{ ...search.result.results[0], text: 'wrong!' }] } }), false);
  assert.equal(JSON.stringify(m).includes(move.ranges[0]!.sha256), false); assert.equal(JSON.stringify(expected).includes('\ud800'), false);
});
test('worker save keeps original SQLite normalization for legacy unpaired UTF-16 input', () => fixture(async f => {
  const text = 'old \ud800\ud801 text';
  const original = f.store.notebooks.saveArchive(f.other.id, input(text));
  assert.ok(original); assert.notEqual(original.text, text);
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'notebook-fixture' }, quiet);
  try {
    await owner.open();
    const result = await owner.command('personalNotebook', { ...f.proof, command: { action: 'saveArchive', document: input(text) } });
    assert.ok(result?.action === 'saveArchive' && result.document);
    assert.equal(result.document.text, original.text);
    assert.equal(result.document.revision, original.revision);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(v: { id: number; kind: string; body: string }) { this.messages.push(v); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}
test('mis-correlated notebook worker response fences owner instead of inventing save success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-notebook-protocol-')), worker = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => worker as unknown as Worker);
  try {
    worker.emit('message', { kind: 'ready' }); await owner.open();
    const pending = owner.command('personalNotebook', { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'save', document: input() } });
    await new Promise<void>(resolve => setImmediate(resolve)); const sent = worker.messages.at(-1)!;
    const rejected = assert.rejects(pending, HubMemberOwnerUnavailable);
    worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify({ action: 'save', document: { ...input('wrong text', 1), updatedAt: 1 } }) });
    await rejected; assert.equal(owner.snapshot().unavailable, true);
  } finally { try { await assert.rejects(owner.close(), /hub_member_storage_unavailable/); } finally { rmSync(root, { recursive: true, force: true }); } }
});
