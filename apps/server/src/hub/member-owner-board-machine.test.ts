import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, hubMemberCommandSteps, hubMemberFailureSteps } from './member-owner-domain.js';
import { hubBoardMachineReplyExpectation, validHubBoardMachineReply, validHubBoardMachineResult,
  type HubBoardMachineCommand } from './member-board-machine-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => void | Promise<void>, escaped = false) {
  const root = mkdtempSync(join(tmpdir(), 'hub-machine-r255-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'machine-fixture');
  try { await work(seed(store, file, escaped)); }
  finally { try { await store.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
}
function seed(store: HubStore, file: string, escaped: boolean) {
  const member = store.createUser('Original member'), other = store.createUser('Other member');
  const tasks = Array.from({ length: escaped ? 16 : 2 }, () => ({ id: randomUUID(), title: 'Task', status: 'todo' as const,
    detail: escaped ? '\u0000'.repeat(3950) : 'private text', tags: ['keep'], priority: 'high' as const, dueDate: '2026-10-14' }));
  assert.equal(store.boards.save(member.id, 'default', { title: 'Board', tasks, revision: 0, mutationId: randomUUID() }).status, 'saved');
  const grant = store.boardCapabilities.issue(member.id, 'default', { taskIds: tasks.map(t => t.id), fields: ['status', 'detail'], expiresAt: Date.now() + 600_000 })!;
  const document = { revision: 1, mutationId: randomUUID(), tasks: [{ id: tasks[0]!.id, status: 'doing' as const }] };
  const db = (store as unknown as { db: DatabaseSync }).db;
  const command = (input: HubBoardMachineCommand) => executeHubMemberCommand(store, 'boardMachine', input);
  return { store, file, member, other, tasks, grant, document, db, command };
}
test('machine IDs are append-only and human authority fields are refused', () => fixture(f => {
  assert.equal(hubMemberCommandSteps.boardMachine, 48); assert.equal(hubMemberFailureSteps.boardMachine, 68);
  assert.equal(hubMemberCommandSteps.boardCapability, 47); assert.equal(hubMemberFailureSteps.boardCapability, 67);
  const command = { action: 'read' as const, token: f.grant.token, query: {} };
  for (const v of [{ ...command, userId: f.other.id }, { ...command, evidence: {} }, { ...command, token: 'aod_note_' + 'a'.repeat(43) }, { ...command, query: { offset: 1 } }])
    assert.equal(validHubMemberInput('boardMachine', v), false);
}));
test('machine update, durable receipt and old bearer survive actual worker close/reopen', () => fixture(async f => {
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'machine-fixture' }, quiet);
  const command = { action: 'update' as const, token: f.grant.token, document: f.document };
  const expected = { action: 'update', result: { status: 'saved', revision: 2, mutationId: f.document.mutationId } };
  try {
    await owner.open(); assert.deepEqual(await owner.command('boardMachine', command), expected);
    assert.deepEqual(await owner.command('boardMachine', command), expected);
  } finally { await owner.close(); }
  const next = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'machine-fixture' }, quiet);
  try {
    await next.open(); assert.deepEqual(await next.command('boardMachine', command), expected);
    const read = await next.command('boardMachine', { action: 'read', token: f.grant.token, query: { taskIds: [f.tasks[0]!.id], includeDetail: true } });
    assert.ok(read.action === 'read' && read.snapshot && !('error' in read.snapshot));
    assert.equal(read.snapshot.tasks[0]!.status, 'doing'); assert.equal(read.snapshot.tasks.length, 1);
    assert.equal('tags' in read.snapshot.tasks[0]!, false);
  } finally { await next.close(); }
  const reopened = new HubStore(f.file, 'machine-fixture');
  try {
    const tasks = reopened.boards.get(f.member.id, 'default').tasks;
    assert.deepEqual(tasks[0], { ...f.tasks[0], status: 'doing' }); assert.deepEqual(tasks[1], f.tasks[1]);
    assert.equal((reopened as unknown as { db: DatabaseSync }).db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally { await reopened.close(); }
}));
test('audit failure rolls back board revision, both receipts and event before explicit retry', () => fixture(f => {
  f.db.exec("CREATE TRIGGER refuse_machine_audit BEFORE INSERT ON hub_board_agent_audit BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const command = { action: 'update' as const, token: f.grant.token, document: f.document };
  assert.throws(() => f.command(command));
  assert.equal(f.store.boards.get(f.member.id, 'default').revision, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_board_agent_receipts').get()?.n, 0);
  f.db.exec('DROP TRIGGER refuse_machine_audit');
  assert.deepEqual(f.command(command), { action: 'update', result: { status: 'saved', revision: 2, mutationId: f.document.mutationId } });
  assert.equal(f.store.boardCapabilities.events(f.member.id, 'default').filter(e => e.event === 'updated').length, 1);
}));
test('revocation precedes successful receipt lookup and selectors never grant scope', () => fixture(f => {
  const command = { action: 'update' as const, token: f.grant.token, document: f.document };
  assert.equal(f.command(command).action, 'update');
  f.store.boardCapabilities.revoke(f.member.id, 'default', f.grant.capability.id);
  assert.deepEqual(f.command(command), { action: 'update', result: { status: 'denied' } });
  assert.deepEqual(f.command({ action: 'read', token: f.grant.token, query: {} }), { action: 'read', snapshot: null });
  assert.deepEqual(f.command({ action: 'authorized', token: f.grant.token }), { action: 'authorized', authorized: false });
}));
test('escaped full legacy projection fits actual worker and contains no human metadata', () => fixture(async f => {
  await f.store.close(); const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'machine-fixture' }, quiet);
  try {
    await owner.open(); const command = { action: 'read' as const, token: f.grant.token, query: {} };
    const value = await owner.command('boardMachine', command);
    assert.ok(value.action === 'read' && value.snapshot && !('error' in value.snapshot));
    assert.equal(value.snapshot.tasks.length, 16); assert.ok(Buffer.byteLength(JSON.stringify(value)) > 16_384);
    const first = value.snapshot.tasks[0]!; assert.ok('detail' in first);
    assert.equal(first.detail, f.tasks[0]!.detail);
    assert.equal(validHubBoardMachineReply(hubBoardMachineReplyExpectation(command), value), true);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}, true));
test('reply correlation refuses changed mutation, revision, selectors, metadata, pages and actions', () => fixture(f => {
  const command = { action: 'read' as const, token: f.grant.token, query: { taskIds: [f.tasks[0]!.id], revision: 1 } };
  const value = f.command(command); assert.ok(value.action === 'read' && value.snapshot && !('error' in value.snapshot));
  const expected = hubBoardMachineReplyExpectation(command), snapshot = value.snapshot;
  assert.equal(validHubBoardMachineReply(expected, value), true);
  for (const changed of [{ ...snapshot, revision: 2 }, { ...snapshot, tasks: [{ ...snapshot.tasks[0], id: randomUUID() }] },
    { ...snapshot, tasks: [{ ...snapshot.tasks[0], detail: 'not requested' }] }, { ...snapshot, page: { offset: 1, limit: 20, total: 1, nextOffset: null } }])
    assert.equal(validHubBoardMachineReply(expected, { action: 'read', snapshot: changed }), false);
  assert.equal(validHubBoardMachineResult({ action: 'read', snapshot: { ...snapshot, token: f.grant.token } }), false);
  assert.equal(validHubBoardMachineReply({ action: 'update', mutationId: f.document.mutationId }, { action: 'update', result: { status: 'saved', revision: 2, mutationId: randomUUID() } }), false);
  const write = hubBoardMachineReplyExpectation({ action: 'update', token: f.grant.token, document: f.document });
  assert.equal(validHubBoardMachineReply(write, { action: 'update', result: { status: 'saved', revision: 3, mutationId: f.document.mutationId } }), false);
  assert.equal(validHubBoardMachineReply(write, { action: 'update', result: { status: 'saved', revision: 2, mutationId: f.document.mutationId } }), true);
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(v: { id: number; kind: string; body: string }) { this.messages.push(v); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}
test('malformed machine ACK fences original owner, never publishes invented success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-machine-protocol-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const pending = assert.rejects(owner.command('boardMachine', { action: 'authorized', token: 'aod_board_' + 'a'.repeat(43) }));
    await new Promise<void>(resolve => setImmediate(resolve)); const row = fake.messages[0]!;
    fake.emit('message', { id: row.id, kind: row.kind, ok: true, body: JSON.stringify({ action: 'update', result: { status: 'denied' } }) });
    await pending; assert.equal(owner.snapshot().unavailable, true);
  } finally { try { await assert.rejects(owner.close()); } finally { rmSync(root, { recursive: true, force: true }); } }
});
