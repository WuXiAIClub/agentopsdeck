import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskboardContextStatus } from './taskboard-context-menu.js';

// Structural DOM doubles keep the classifier test independent of a browser.
function hit({ status, blocked = false, physical = true, nested = false }: { status?: string; blocked?: boolean; physical?: boolean; nested?: boolean } = {}) {
  const board = { contains: () => physical } as unknown as Element;
  const target = { closest: (selector: string) => {
    if (selector === '.workspace-taskboard') return nested ? {} : board;
    if (selector === '[data-board-column]') return status === undefined ? null : { getAttribute: () => status };
    return blocked ? {} : null;
  } } as unknown as Element;
  return taskboardContextStatus(target, board);
}
test('blank column space creates tasks with the clicked column status', () => {
  for (const status of ['todo', 'doing', 'done'] as const) assert.equal(hit({ status }), status);
});
test('board padding and column gaps default to a to-do task', () => {
  assert.equal(hit(), 'todo');
  assert.equal(hit({ status: 'invalid' }), 'todo');
});
test('existing tasks and interactive targets retain their own context actions', () => {
  assert.equal(hit({ blocked: true, status: 'doing' }), undefined);
  const source = readFileSync('src/lib/taskboard-context-menu.ts', 'utf8');
  for (const selector of ['[data-board-task]', '.workspace-task-card', 'input', 'textarea', 'select', 'button', 'a,', '[contenteditable]', '[role="dialog"]', '[role="menu"]']) {
    assert.ok(source.includes(selector), `native/interactive exclusion missing: ${selector}`);
  }
});
test('caption portals and nested boards cannot open the wrong board menu', () => {
  assert.equal(hit({ physical: false }), undefined);
  assert.equal(hit({ nested: true }), undefined);
});
test('board captures blank-space context before the native canvas bubble listener', () => {
  const source = readFileSync('src/components/WorkspaceTaskboard.tsx', 'utf8');
  const handler = source.slice(source.indexOf('onContextMenuCapture='), source.indexOf('onCompositionStart='));
  assert.match(handler, /taskboardContextStatus\(event.target, event.currentTarget\)/);
  assert.ok(handler.indexOf('event.stopPropagation()') < handler.indexOf('event.preventDefault()'));
  assert.match(handler, /selection.containsNode/);
  assert.match(handler, /key: draftKey/);
  assert.match(source, /label="Task actions"/);
  assert.match(source, /creationMenu\?\.key === draftKey/);
});
test('plus and context action share creation guards and open the new task editor', () => {
  const source = readFileSync('src/components/WorkspaceTaskboard.tsx', 'utf8');
  assert.match(source, /onClick=\{\(\) => addTask\(status\)\}/);
  assert.match(source, /addTask\(creationMenu.status\)/);
  assert.match(source, /if \(creationDisabled \|\| !draft \|\| lock.current \|\| !validIdentity\(\)\) return/);
  assert.match(source, /draft.tasks.length >= BOARD_MAX_TASKS/);
  assert.match(source, /if \(!validBoardContent\(next, true\)\)/);
  assert.match(source, /setNewTaskId\(id\)/);
});
