import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_STATUSES, type BoardTask, type BoardStatus } from '@agentopsdeck/shared';
import { boardContentEqual, boardDraftKey, parseBoardDraft, reconcileBoardDraft, moveBoardTask, readCachedBoardDocument, writeCachedBoardDocument, readCachedBoardSummary, writeCachedBoardSummary, clearCachedBoardDocuments } from './workspace-board.js';

test('metadata and unfinished tags survive draft recovery and drag while changes remain dirty', () => {
  const task = { id: '12345678-1234-1234-1234-123456789abc', title: 'Task', detail: '', status: 'todo' as const,
    tags: ['frontend', ''], priority: 'high' as const, dueDate: '2028-02-29' };
  const draft = { title: 'Plan', tasks: [task], mutationId: '12345678-1234-1234-1234-123456789abd', revision: 1 };
  assert.deepEqual(parseBoardDraft(JSON.stringify(draft)), draft);
  assert.deepEqual(moveBoardTask(draft.tasks, task.id, { status: 'doing' })[0], { ...task, status: 'doing' });
  assert.equal(boardContentEqual(draft, { ...draft, tasks: [{ ...task, priority: 'low' }] }), false);
});
const mutationId = '00000000-0000-4000-8000-000000000001';
test('task board drafts survive conflict and reconcile a lost save response', () => {
  const remote = { resourceId: 'default', title: 'Board', tasks: [], revision: 1, updatedAt: 1 };
  const local = { title: 'Local draft', tasks: [], revision: 1, mutationId };
  assert.deepEqual(parseBoardDraft(JSON.stringify(local)), local);
  assert.equal(parseBoardDraft(JSON.stringify({ ...local, title: '' }))?.title, '', 'unfinished title is a recoverable draft');
  assert.equal(parseBoardDraft('{broken'), undefined);
  assert.equal(parseBoardDraft(JSON.stringify({ ...local, userId: 'other' })), undefined);
  assert.equal(reconcileBoardDraft(remote, local, mutationId).dirty, true);
  const conflict = reconcileBoardDraft({ ...remote, revision: 2 }, local, mutationId);
  assert.equal(conflict.conflict, true); assert.deepEqual(conflict.draft, local);
  const confirmed = reconcileBoardDraft({ ...remote, title: local.title, revision: 2 }, local, mutationId);
  assert.equal(confirmed.dirty, false); assert.equal(confirmed.draft.revision, 2);
  assert.notEqual(boardDraftKey('alice', 'default'), boardDraftKey('bob', 'default'));
  const escaped = { ...local, tasks: Array.from({ length: 200 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: 'Task', detail: '\u0000'.repeat(310), status: 'todo',
  })) };
  assert.deepEqual(parseBoardDraft(JSON.stringify(escaped)), escaped, 'JSON expansion does not discard a valid draft');
});

const task = (id: string, status: BoardStatus = 'todo'): BoardTask => ({ id, title: id, detail: `Detail ${id}`, status });
test('task drop moves across empty/populated columns without changing content or other tasks', () => {
  const tasks = [task('a'), task('b', 'doing'), task('c'), task('d', 'done')];
  const moved = moveBoardTask(tasks, 'c', { status: 'doing', beforeId: 'b' });
  assert.deepEqual(moved.map(item => item.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moved[1], { ...tasks[2], status: 'doing' });
  assert.equal(moved[0], tasks[0]); assert.equal(moved[2], tasks[1]); assert.equal(moved[3], tasks[3]);
  assert.equal(tasks[2]!.status, 'todo', 'input remains unchanged');
  const empty = moveBoardTask([tasks[0]!, tasks[2]!], 'a', { status: 'done' });
  assert.deepEqual(empty.map(item => [item.id, item.status]), [['c', 'todo'], ['a', 'done']]);
});
test('task reorder recognizes visible no-ops even with interleaved columns', () => {
  const tasks = [task('a'), task('b', 'doing'), task('c'), task('d', 'done')];
  assert.equal(moveBoardTask(tasks, 'a', { status: 'todo', beforeId: 'c' }), tasks);
  assert.equal(moveBoardTask(tasks, 'c', { status: 'todo' }), tasks);
  assert.equal(moveBoardTask(tasks, 'b', { status: 'doing' }), tasks);
  assert.deepEqual(moveBoardTask(tasks, 'a', { status: 'todo' }).filter(item => item.status === 'todo').map(item => item.id), ['c', 'a']);
  assert.deepEqual(moveBoardTask(tasks, 'c', { status: 'todo', beforeId: 'a' }).filter(item => item.status === 'todo').map(item => item.id), ['c', 'a']);
  for (const target of [{ status: 'todo', beforeId: 'a' }, { status: 'todo', beforeId: 'b' }, { status: 'done', beforeId: 'missing' }, { status: 'invalid' as BoardStatus }] as const) {
    assert.equal(moveBoardTask(tasks, 'a', target), tasks);
  }
  assert.equal(moveBoardTask(tasks, 'missing', { status: 'done' }), tasks);
});
test('all source/target positions preserve task identities and unrelated column order at capacity', () => {
  const tasks = Array.from({ length: 200 }, (_, i) => task(String(i), BOARD_STATUSES[i % 3]));
  for (const source of tasks) for (const status of BOARD_STATUSES) {
    const peers = tasks.filter(item => item.status === status && item.id !== source.id);
    for (const beforeId of [peers[0]?.id, peers.at(-1)?.id, undefined]) {
      const moved = moveBoardTask(tasks, source.id, { status, ...(beforeId !== undefined ? { beforeId } : {}) });
      assert.equal(moved.length, tasks.length);
      assert.equal(new Set(moved.map(item => item.id)).size, tasks.length);
      assert.deepEqual(moved.filter(item => item.id !== source.id), tasks.filter(item => item.id !== source.id));
      const changed = moved.find(item => item.id === source.id)!;
      assert.deepEqual(changed, { ...source, status });
      const column = moved.filter(item => item.status === status), index = column.indexOf(changed);
      assert.equal(column[index + 1]?.id, beforeId);
    }
  }
});

test('board document and summary cache isolate scopes and enforce monotonic summary revisions', () => {
  clearCachedBoardDocuments();
  const doc = {
    resourceId: 'default',
    title: 'Sprint Board',
    tasks: [
      { id: '00000000-0000-4000-8000-000000000010', title: 'Task A', detail: '', status: 'todo' as const },
      { id: '00000000-0000-4000-8000-000000000011', title: 'Task B', detail: '', status: 'done' as const },
    ],
    revision: 3,
    updatedAt: 1700000000000,
  };
  writeCachedBoardDocument('scope-a', 'default', doc);
  assert.deepEqual(readCachedBoardDocument('scope-a', 'default'), doc);
  assert.equal(readCachedBoardDocument('scope-b', 'default'), undefined);
  assert.deepEqual(readCachedBoardSummary('scope-a', 'default'), {
    resourceId: 'default',
    title: 'Sprint Board',
    counts: { todo: 1, doing: 0, done: 1 },
    revision: 3,
    updatedAt: 1700000000000,
  });

  // Older summary revision must not overwrite newer cached summary
  writeCachedBoardSummary('scope-a', 'default', {
    resourceId: 'default',
    title: 'Stale',
    counts: { todo: 0, doing: 0, done: 0 },
    revision: 2,
    updatedAt: 1600000000000,
  });
  assert.equal(readCachedBoardSummary('scope-a', 'default')?.revision, 3);
  assert.equal(readCachedBoardSummary('scope-a', 'default')?.title, 'Sprint Board');

  clearCachedBoardDocuments();
  assert.equal(readCachedBoardDocument('scope-a', 'default'), undefined);
  assert.equal(readCachedBoardSummary('scope-a', 'default'), undefined);
});
