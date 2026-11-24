import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardFiles, type FileBoardIntent } from './workspace-board-files.js';
import { WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import { parseBoardFile, serializeBoardFile, type BoardFileSnapshot } from '../connector/workspace-board-file-format.js';

const content = () => ({ title: 'Tasks', tasks: [{ id: randomUUID(), title: 'Added by Agent', detail: '', status: 'todo' as const }] });
test('binding-only revisions are owner-isolated, deduplicated and do not fabricate task edits', () => {
  const f = fixture();
  try {
    const revision = () => f.files.revisions('alice')[0]?.revision ?? 0;
    f.files.prepare(f.intent, 0); assert.equal(revision(), 1);
    f.files.prepare(f.intent, 0); assert.equal(revision(), 1);
    f.files.activate('alice', f.intent.bindingId); assert.equal(revision(), 2);
    f.files.activate('alice', f.intent.bindingId); assert.equal(revision(), 2);
    assert.equal(f.boards.get('alice', 'default').revision, 0);
    const first = f.snapshot(); f.files.apply('alice', f.intent.bindingId, first);
    assert.equal(revision(), 2);
    for (let i = 0; i < 10; i++) f.files.apply('alice', f.intent.bindingId, { state: 'invalid' });
    assert.equal(revision(), 3); assert.equal(f.boards.get('alice', 'default').revision, 1);
    f.files.apply('alice', f.intent.bindingId, first); assert.equal(revision(), 4);
    assert.deepEqual(f.files.revisions('bob'), []);
    f.files.revoke('alice', f.intent.bindingId); f.files.revoke('alice', f.intent.bindingId);
    assert.equal(revision(), 5); assert.equal(f.boards.get('alice', 'default').revision, 1);
  } finally { f.db.close(); }
});
test('cancellation before POST arrival is durable and cannot cancel another owner or board', () => {
  const f = fixture();
  try {
    assert.ok(f.files.cancelAbsent('alice', 'default', f.intent.bindingId));
    assert.ok(f.files.cancelAbsent('alice', 'default', f.intent.bindingId));
    assert.equal(f.files.cancelAbsent('bob', 'default', f.intent.bindingId), false);
    assert.equal(f.files.cancelAbsent('alice', randomUUID(), f.intent.bindingId), false);
    const restart = new WorkspaceBoardFiles(f.db, f.boards, f.authorized);
    assert.equal(restart.prepare(f.intent, 0), undefined);
    assert.equal(f.boards.fileManaged('alice', 'default'), false);
    assert.deepEqual(f.files.revisions('alice'), []);
  } finally { f.db.close(); }
});
function fixture() {
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db); let authority = 1;
  const authorized = (input: FileBoardIntent) => input.userId === 'alice' && input.connectionId === 'connector' && input.authority === authority;
  const files = new WorkspaceBoardFiles(db, boards, authorized);
  const intent = { bindingId: randomUUID(), userId: 'alice', resourceId: 'default', sessionId: 'codex:session', connectionId: 'connector', authority: 1 };
  const snapshot = (value = content()): BoardFileSnapshot => ({ state: 'ready', value: parseBoardFile(Buffer.from(serializeBoardFile(value)))! });
  return { db, boards, files, intent, snapshot, authorized, changeAuthority: () => { authority++; } };
}
test('empty board binds without task selection; future tasks are projected and unchanged content emits no revision', () => {
  const f = fixture();
  try {
    assert.equal(f.files.prepare(f.intent, 0)?.state, 'prepared');
    assert.equal(f.boards.fileManaged('alice', 'default'), true);
    assert.equal(f.files.apply('alice', f.intent.bindingId, f.snapshot()), 'denied');
    assert.equal(f.files.activate('alice', f.intent.bindingId), true);
    const first = f.snapshot();
    assert.equal(f.files.apply('alice', f.intent.bindingId, first), 'updated');
    assert.equal(f.boards.get('alice', 'default').tasks.length, 1);
    for (let i = 0; i < 100; i++) assert.equal(f.files.apply('alice', f.intent.bindingId, first), 'unchanged');
    assert.equal(f.boards.get('alice', 'default').revision, 1);
    assert.equal(f.files.apply('alice', f.intent.bindingId, f.snapshot({ title: 'New board title', tasks: [] })), 'updated');
    assert.equal(f.boards.get('alice', 'default').tasks.length, 0);
    assert.equal(f.boards.get('bob', 'default').revision, 0);
  } finally { f.db.close(); }
});
test('owner, authority and revoked generation fence every import including replay', () => {
  const f = fixture();
  try {
    assert.equal(f.files.prepare({ ...f.intent, userId: 'bob' }, 0), undefined);
    assert.ok(f.files.prepare(f.intent, 0)); assert.ok(f.files.activate('alice', f.intent.bindingId));
    const data = f.snapshot(); assert.equal(f.files.apply('alice', f.intent.bindingId, data), 'updated');
    assert.equal(f.files.apply('bob', f.intent.bindingId, data), 'denied');
    f.changeAuthority(); assert.equal(f.files.apply('alice', f.intent.bindingId, data), 'denied');
    assert.equal(f.files.revoke('bob', f.intent.bindingId), false);
    assert.equal(f.files.revoke('alice', f.intent.bindingId), true);
    assert.equal(f.files.activate('alice', f.intent.bindingId), false);
    assert.equal(f.files.apply('alice', f.intent.bindingId, data), 'denied');
    assert.equal(f.boards.get('alice', 'default').revision, 1);
    assert.equal(f.boards.save('alice', 'default', { ...content(), revision: 1, mutationId: randomUUID() }).status, 'saved');
  } finally { f.db.close(); }
});
test('bad/partial files preserve snapshot, recover, and do not import stale data attached to errors', () => {
  const f = fixture();
  try {
    f.files.prepare(f.intent, 0); f.files.activate('alice', f.intent.bindingId);
    const first = f.snapshot(); f.files.apply('alice', f.intent.bindingId, first);
    for (const state of ['missing', 'invalid', 'too-large', 'unsafe', 'unavailable'] as const) {
      assert.equal(f.files.apply('alice', f.intent.bindingId, { state, value: f.snapshot().value! }), 'retained');
      assert.equal(f.boards.get('alice', 'default').revision, 1);
      assert.equal(f.files.current('alice', 'default')?.problem, state);
    }
    assert.equal(f.files.apply('alice', f.intent.bindingId, { state: 'ready', value: { content: content(), hash: 'fake' } }), 'invalid');
    assert.equal(f.files.apply('alice', f.intent.bindingId, first), 'unchanged');
    assert.equal(f.files.current('alice', 'default')?.problem, null);
  } finally { f.db.close(); }
});
test('prepared intent blocks racing manual/legacy tool edits; receipt and tombstone survive store reconstruction', () => {
  const f = fixture();
  try {
    const board = content(); f.boards.save('alice', 'default', { ...board, revision: 0, mutationId: randomUUID() });
    const caps = new WorkspaceBoardCapabilities(f.db, f.boards);
    const cap = caps.issue('alice', 'default', { taskIds: [board.tasks[0]!.id], fields: ['status'], expiresAt: Date.now() + 60_000 })!;
    assert.equal(f.files.prepare(f.intent, 0), undefined, 'stale displayed board cannot be silently exported');
    const prepared = f.files.prepare(f.intent, 1)!;
    assert.deepEqual(f.files.prepare(f.intent, 1), prepared);
    assert.equal(f.files.prepare({ ...f.intent, bindingId: randomUUID() }, 1), undefined);
    assert.equal(f.boards.save('alice', 'default', { ...board, revision: 1, mutationId: randomUUID() }).status, 'file-managed');
    assert.equal(caps.update(cap.token, { revision: 1, mutationId: randomUUID(), tasks: [{ id: board.tasks[0]!.id, status: 'done' }] }).status, 'denied');
    const restarted = new WorkspaceBoardFiles(f.db, new WorkspaceBoards(f.db), f.authorized);
    assert.deepEqual(restarted.get('alice', prepared.bindingId), prepared);
    assert.ok(restarted.revoke('alice', prepared.bindingId));
    assert.equal(restarted.prepare(f.intent, 1)?.state, 'revoked');
    assert.equal(restarted.activate('alice', prepared.bindingId), false);
  } finally { f.db.close(); }
});
test('snapshot content and hash commit together, including database failure rollback', () => {
  const f = fixture();
  try {
    f.files.prepare(f.intent, 0); f.files.activate('alice', f.intent.bindingId);
    f.db.exec("CREATE TRIGGER reject_file_hash BEFORE UPDATE OF source_hash ON hub_workspace_board_file_bindings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const data = f.snapshot(); assert.throws(() => f.files.apply('alice', f.intent.bindingId, data), /fixture failure/);
    assert.equal(f.boards.get('alice', 'default').revision, 0);
    assert.equal(f.files.get('alice', f.intent.bindingId)?.sourceHash, null);
    f.db.exec('DROP TRIGGER reject_file_hash');
    assert.equal(f.files.apply('alice', f.intent.bindingId, data), 'updated');
  } finally { f.db.close(); }
});
