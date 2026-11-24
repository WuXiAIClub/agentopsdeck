import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { copyBoardTask, type BoardWrite } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, HubMemberOwnerUnavailable,
  hubMemberCommandSteps, hubMemberFailureSteps } from './member-owner-domain.js';
import { hubBoardReplyExpectation, validHubBoardReply, validHubBoardCommand } from './member-board-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const write = (revision = 0): BoardWrite => ({ title: 'Existing board', revision, mutationId: randomUUID(), tasks: [
  { id: randomUUID(), title: 'Preserve fields', detail: 'existing content', status: 'doing', tags: ['stable'], priority: 'high', dueDate: '2026-10-14' },
] });
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), 'hub-board-r253-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'board-fixture');
  try { await work(seed(store, file)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Original member'), other = store.createUser('Other member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, file, member, other, key, token, proof, db };
}
test('private-board owner appends distinct command and failure telemetry without changing old IDs', () => {
  assert.equal(hubMemberCommandSteps.workspaceBoard, 46); assert.equal(hubMemberFailureSteps.workspaceBoard, 66);
  assert.equal(hubMemberCommandSteps.executionIssuer, 45); assert.equal(hubMemberFailureSteps.executionIssuer, 65);
});
test('board worker preserves old cookie, optional fields, CAS and exact mutation receipt across reopening', () => fixture(async f => {
  const first = write(), original = f.store.boards.save(f.member.id, 'default', first);
  assert.equal(original.status, 'saved');
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'board-fixture' }, quiet);
  let saved;
  try {
    await owner.open();
    assert.deepEqual(await owner.command('workspaceBoard', { ...f.proof, command: { action: 'get', resourceId: 'default' } }),
      { action: 'get', document: original.status === 'saved' ? original.document : null });
    assert.deepEqual(await owner.command('workspaceBoard', { ...f.proof, command: { action: 'save', resourceId: 'default', document: first } }),
      { action: 'save', result: original }, 'lost reply returns exact persisted receipt');
    const next = { ...first, revision: 1, mutationId: randomUUID(), title: 'New title' };
    saved = await owner.command('workspaceBoard', { ...f.proof, command: { action: 'save', resourceId: 'default', document: next } });
    assert.ok(saved?.action === 'save' && saved.result.status === 'saved'); assert.equal(saved.result.document.revision, 2);
    assert.deepEqual(saved.result.document.tasks, first.tasks.map(copyBoardTask));
    assert.deepEqual(await owner.command('workspaceBoard', { ...f.proof, command: { action: 'save', resourceId: 'default', document: { ...next, mutationId: randomUUID() } } }),
      { action: 'save', result: { status: 'conflict' } });
    assert.deepEqual(await owner.command('workspaceBoard', { ...f.proof, command: { action: 'save', resourceId: 'default', document: { ...next, title: 'reused' } } }),
      { action: 'save', result: { status: 'mutation-reused' } });
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'board-fixture');
  try {
    assert.equal(reopened.boards.get(f.member.id, 'default').revision, 2);
    assert.equal(reopened.boards.get(f.other.id, 'default').revision, 0);
    assert.ok(reopened.identities.requestPrincipal(new Request('http://localhost/', { headers: { cookie: 'agentopsdeck_session=' + f.token } }), () => false));
  } finally { await reopened.close(); }
}));
test('scope, credential and target authority remain in original savepoint, never supplied user ID', () => fixture(f => {
  const command = { action: 'save' as const, resourceId: 'default', document: write() };
  assert.equal(validHubMemberInput('workspaceBoard', { ...f.proof, command, userId: f.other.id }), false);
  assert.equal(executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, expectedScope: '0'.repeat(64), command }), null);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command }), null);
  assert.equal(f.store.boards.get(f.member.id, 'default').revision, 0);
  assert.equal(f.store.boards.get(f.other.id, 'default').revision, 0);
}));
test('receipt insertion failure rolls back board and recovers using same explicit mutationId', () => fixture(f => {
  const document = write(), command = { action: 'save' as const, resourceId: 'default', document };
  f.db.exec(`CREATE TRIGGER reject_board_receipt BEFORE INSERT ON hub_workspace_board_receipts BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`);
  assert.throws(() => executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command }));
  assert.equal(f.store.boards.get(f.member.id, 'default').revision, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_board_receipts').get()?.n, 0);
  f.db.exec('DROP TRIGGER reject_board_receipt');
  const result = executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command });
  assert.ok(result?.action === 'save' && result.result.status === 'saved'); assert.equal(result.result.document.revision, 1);
  assert.deepEqual(executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command }), result);
  assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
}));
test('private-board command cannot bypass active native file binding or expose importFile', () => fixture(f => {
  f.db.prepare(`INSERT INTO hub_workspace_board_file_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), f.member.id, 'default', 'original-session', 'original-connection', 1, 'active', null, null, Date.now());
  const command = { action: 'save' as const, resourceId: 'default', document: write() };
  assert.deepEqual(executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command }), { action: 'save', result: { status: 'file-managed' } });
  assert.equal(validHubMemberInput('workspaceBoard', { ...f.proof, command: { ...command, bindingId: randomUUID() } }), false);
  assert.equal(validHubBoardCommand({ ...command, action: 'importFile' }), false);
  assert.equal(f.store.boards.get(f.member.id, 'default').revision, 0);
}));
test('board list preserves all 64 saved rows plus implicit default, without task contents', () => fixture(f => {
  for (let i = 0; i < 64; i++) assert.equal(f.store.boards.save(f.member.id, randomUUID(), write()).status, 'saved');
  const result = executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command: { action: 'list' } });
  assert.ok(result?.action === 'list'); assert.equal(result.summaries.length, 65);
  assert.equal(validHubMemberOutput('workspaceBoard', result), true);
  assert.ok(result.summaries.every(s => !('tasks' in s)));
  assert.deepEqual(executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command: { action: 'save', resourceId: randomUUID(), document: write() } }),
    { action: 'save', result: { status: 'limit' } });
}));
test('maximum escaped board passes real worker without truncation or ordinary 16KiB limit', () => fixture(async f => {
  const document: BoardWrite = { title: '\ud800'.repeat(120), revision: 0, mutationId: randomUUID(), tasks: Array.from({ length: 16 }, (_, i) => ({
    id: randomUUID(), title: 'Task', detail: '\ud800'.repeat(i === 15 ? 3816 : 4000), status: 'todo',
  })) };
  assert.equal(validHubBoardCommand({ action: 'save', resourceId: 'default', document }), true);
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'board-fixture' }, quiet);
  try {
    await owner.open();
    const result = await owner.command('workspaceBoard', { ...f.proof, command: { action: 'save', resourceId: 'default', document } });
    assert.ok(result?.action === 'save' && result.result.status === 'saved');
    assert.deepEqual(result.result.document.tasks, document.tasks); assert.equal(result.result.document.title, document.title);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}));
test('last safe persisted revision remains readable but never reset or writable again', () => fixture(f => {
  assert.equal(f.store.boards.save(f.member.id, 'default', write()).status, 'saved');
  f.db.prepare('UPDATE hub_workspace_boards SET revision = ?').run(Number.MAX_SAFE_INTEGER);
  const result = executeHubMemberCommand(f.store, 'workspaceBoard', { ...f.proof, command: { action: 'get', resourceId: 'default' } });
  assert.equal(validHubMemberOutput('workspaceBoard', result), true);
  assert.equal(validHubBoardCommand({ action: 'save', resourceId: 'default', document: write(Number.MAX_SAFE_INTEGER) }), false);
}));
test('board protocol rejects extra fields, invalid dates, count totals, duplicates and miscorrelated replies', () => {
  const document = write(), command = { action: 'save' as const, resourceId: 'default', document };
  const stored = { title: document.title, tasks: document.tasks.map(copyBoardTask), resourceId: 'default', revision: 1, updatedAt: 1 };
  const expected = hubBoardReplyExpectation(command);
  const result = { action: 'save', result: { status: 'saved', document: stored } };
  assert.equal(validHubBoardReply(expected, result), true);
  assert.equal(validHubBoardReply(expected, { ...result, result: { status: 'saved', document: { ...stored, resourceId: randomUUID() } } }), false);
  assert.equal(validHubBoardReply(expected, { ...result, result: { status: 'saved', document: { ...stored, title: 'wrong' } } }), false);
  assert.equal(validHubBoardReply(expected, { ...result, result: { status: 'saved', document: { ...stored, revision: 2 } } }), false);
  assert.equal(validHubBoardReply(expected, { action: 'get', document: stored }), false);
  const summary = { title: 'board', resourceId: 'default', revision: 0, updatedAt: null, counts: { todo: 0, doing: 0, done: 0 } };
  for (const value of [{ action: 'list', summaries: [summary, summary] }, { action: 'summary', summary: { ...summary, counts: { todo: 201, doing: 0, done: 0 } } },
    { ...result, granted: true }, { action: 'save', result: { status: 'saved', document: { ...stored, updatedAt: null } } }])
    assert.equal(validHubMemberOutput('workspaceBoard', value), false);
  for (const value of [{ ...command, userId: 'other' }, { ...command, document: { ...document, tasks: [{ ...document.tasks[0], dueDate: '2026-02-30' }] } },
    { action: 'get', resourceId: '../private' }, { action: 'list', evidence: {} }]) assert.equal(validHubBoardCommand(value), false);
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}
test('mismatched worker board action fences the owner, never publishes a success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-board-protocol-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const rejected = assert.rejects(owner.command('workspaceBoard', { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'list' } }), HubMemberOwnerUnavailable);
    await new Promise<void>(resolve => setImmediate(resolve));
    const row = fake.messages[0]!;
    fake.emit('message', { id: row.id, kind: row.kind, ok: true, body: JSON.stringify({ action: 'get', document: { title: 'Task board', tasks: [], resourceId: 'default', revision: 0, updatedAt: null } }) });
    await rejected; assert.equal(owner.snapshot().unavailable, true);
  } finally {
    try { await assert.rejects(owner.close(), /hub_member_storage_unavailable/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});
