import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validBoardWrite, validBoardContent, copyBoardTask, validBoardDueDate, type BoardWrite } from '@agentopsdeck/shared';
import { WorkspaceBoards } from './workspace-boards.js';
const input = (): BoardWrite => ({ title: 'Tasks', tasks: [{ id: randomUUID(), title: '测试', detail: '<script>text only</script>', status: 'todo' }], revision: 0, mutationId: randomUUID() });

test('optional task metadata is validated, bounded, canonical and preserved across receipts/restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-metadata-')), path = join(root, 'db.sqlite');
  let db = new DatabaseSync(path), boards = new WorkspaceBoards(db);
  try {
    const body = input();
    Object.assign(body.tasks[0]!, { tags: ['前端', '<script>text</script>'], priority: 'urgent', dueDate: '2028-02-29' });
    assert.equal(validBoardWrite(body), true);
    const result = boards.save('alice', 'default', body);
    assert.equal(result.status, 'saved');
    assert.deepEqual(boards.get('alice', 'default').tasks, body.tasks);
    assert.equal(boards.save('alice', 'default', { ...body, tasks: [{ ...body.tasks[0]!, priority: 'low' }] }).status, 'mutation-reused');
    db.close(); db = new DatabaseSync(path); boards = new WorkspaceBoards(db);
    assert.deepEqual(boards.save('alice', 'default', body), result);
    assert.deepEqual(boards.get('alice', 'default').tasks, body.tasks);
    const reversed = Object.fromEntries(Object.entries(body.tasks[0]!).reverse()) as typeof body.tasks[number];
    assert.equal(JSON.stringify(copyBoardTask(reversed)), JSON.stringify(copyBoardTask(body.tasks[0]!)));
    const copy = copyBoardTask(body.tasks[0]!); copy.tags!.push('different');
    assert.equal(body.tasks[0]!.tags!.length, 2);
    const { tags, priority, dueDate, ...plain } = body.tasks[0]!;
    assert.equal(boards.save('alice', 'default', { ...body, revision: 1, mutationId: randomUUID(), tasks: [plain] }).status, 'saved');
    assert.deepEqual(boards.get('alice', 'default').tasks, [plain], 'omitting metadata clears it');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('metadata rejects malformed dates, tags, unknown fields and accounts for all text', () => {
  const body = input(), task = body.tasks[0]!;
  for (const metadata of [{ tags: null }, { tags: [''] }, { tags: [' x'] }, { tags: ['x', 'x'] }, { tags: ['x\n'] },
    { tags: ['x'.repeat(33)] }, { tags: Array.from({ length: 9 }, (_, i) => `${i}`) }, { priority: 'critical' },
    { priority: null }, { dueDate: null }, { dueDate: '2026-02-29' }, { dueDate: '2026-04-31' }, { dueDate: '0000-01-01' },
    { dueDate: '2026-10-06T00:00:00Z' }, { dueDate: '2026-1-1' }, { dueDate: '' }, { callback: 'exec' }]) {
    assert.equal(validBoardWrite({ ...body, tasks: [{ ...task, ...metadata }] }), false, JSON.stringify(metadata));
  }
  for (const date of ['0001-01-01', '2000-02-29', '2028-02-29', '9999-12-31']) assert.equal(validBoardDueDate(date), true);
  assert.equal(validBoardWrite({ ...body, tasks: [{ ...task, tags: ['', ' unfinished ', ''] }] }, true), true, 'invalid editable tags survive recovery');
  const full = { title: 'x'.repeat(120), tasks: Array.from({ length: 64 }, () => ({ ...task, id: randomUUID(), title: 'x'.repeat(240), detail: 'x'.repeat(3758) })) };
  assert.equal(validBoardContent(full), true); // 255,992 chars
  assert.equal(validBoardContent({ ...full, tasks: full.tasks.map(t => ({ ...t, tags: ['extra'] })) }), false);
});

test('boards persist, isolate users, CAS, idempotent replay and mutation misuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-boards-')), path = join(root, 'db.sqlite');
  let db = new DatabaseSync(path), boards = new WorkspaceBoards(db);
  try {
    const body = input(), result = boards.save('alice', 'default', body);
    assert.equal(result.status, 'saved');
    assert.deepEqual(boards.save('alice', 'default', body), result);
    assert.equal(boards.get('alice', 'default').revision, 1);
    assert.equal(boards.get('bob', 'default').revision, 0);
    assert.deepEqual(boards.revisions('alice'), [{ resourceId: 'default', revision: 1 }]);
    assert.deepEqual(boards.revisions('bob'), []);
    assert.equal(boards.save('alice', 'default', { ...body, title: 'changed' }).status, 'mutation-reused');
    assert.equal(boards.save('alice', 'default', { ...body, mutationId: randomUUID() }).status, 'conflict');
    db.close(); db = new DatabaseSync(path); boards = new WorkspaceBoards(db);
    assert.deepEqual(boards.save('alice', 'default', body), result, 'retry survives restart');
    assert.equal(boards.get('alice', 'default').tasks[0]?.detail, body.tasks[0]?.detail);
    for (let revision = 1; revision < 12; revision++) assert.equal(boards.save('alice', 'default', { ...body, tasks: [], revision, mutationId: randomUUID() }).status, 'saved');
    assert.equal((db.prepare('SELECT count(*) AS n FROM hub_workspace_board_receipts').get() as { n: number }).n, 8);
    assert.equal(boards.save('alice', 'default', body).status, 'conflict', 'expired replay cannot reapply an old write');
    assert.equal(boards.get('alice', 'default').revision, 12);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('strict task payloads reject injection, duplicates, unknown status and oversized content', () => {
  const body = input(), task = body.tasks[0]!;
  assert.equal(validBoardWrite(body), true);
  for (const value of [null, [], { ...body, userId: 'bob' }, { ...body, revision: -1 }, { ...body, revision: Number.MAX_SAFE_INTEGER },
    { ...body, mutationId: '../escape' }, { ...body, tasks: [task, task] }, { ...body, tasks: [{ ...task, status: 'exec' }] },
    { ...body, tasks: [{ ...task, tool: 'shell' }] }, { ...body, title: '' }, { ...body, tasks: [{ ...task, title: ' ' }] },
    { ...body, tasks: [{ ...task, detail: 'x'.repeat(4001) }] }, { ...body, tasks: Array.from({ length: 201 }, () => ({ ...task, id: randomUUID() })) },
    { ...body, tasks: Array.from({ length: 65 }, () => ({ ...task, id: randomUUID(), detail: 'x'.repeat(4000) })) }]) assert.equal(validBoardWrite(value), false);
});
test('board resource quota and failed receipt write roll back content atomically', () => {
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db);
  try {
    db.exec(`CREATE TRIGGER reject_board_receipt BEFORE INSERT ON hub_workspace_board_receipts BEGIN SELECT RAISE(ABORT, 'test'); END`);
    assert.throws(() => boards.save('alice', 'default', input()), /test/);
    assert.equal(boards.get('alice', 'default').revision, 0);
    assert.deepEqual(boards.revisions('alice'), [], 'rolled-back write has no observable revision');
    db.exec('DROP TRIGGER reject_board_receipt');
    for (let n = 0; n < 64; n++) assert.equal(boards.save('alice', randomUUID(), input()).status, 'saved');
    assert.equal(boards.save('alice', 'default', input()).status, 'limit');
    assert.equal(boards.save('bob', 'default', input()).status, 'saved');
  } finally { db.close(); }
});
