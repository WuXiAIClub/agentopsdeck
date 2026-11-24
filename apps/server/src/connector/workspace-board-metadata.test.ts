import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { workspaceFileCardContent, type BoardContent } from '@agentopsdeck/shared';
import { parseBoardFile, serializeBoardFile, boardFileContext } from './workspace-board-file-format.js';

test('task metadata round-trips via ordinary tasks.json and both board card projections', () => {
  const content: BoardContent = { title: 'Plan', tasks: [{ id: randomUUID(), title: 'Ship', detail: '', status: 'todo',
    tags: ['frontend', '测试'], priority: 'high', dueDate: '2026-12-31' }] };
  const parsed = parseBoardFile(Buffer.from(serializeBoardFile(content)))!;
  assert.deepEqual(parsed.content, content);
  assert.notEqual(parsed.hash, parseBoardFile(Buffer.from(serializeBoardFile({ ...content, tasks: [{ ...content.tasks[0]!, priority: 'low' }] })))!.hash);
  for (const kind of ['taskboard', 'statuscard'] as const) assert.deepEqual(workspaceFileCardContent({ kind, content }), { kind, content });
  assert.match(boardFileContext('/managed/tasks.json'), /Optional task fields: tags/);
  assert.equal(parseBoardFile(Buffer.from(JSON.stringify({ version: 1, ...content, tasks: [{ ...content.tasks[0], tags: [''] }] }))), undefined);
});
