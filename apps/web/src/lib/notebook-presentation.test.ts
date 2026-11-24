import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookSize, notebookTask, resizeNotebook, toggleNotebookTask } from './notebook-presentation.js';

test('task offsets distinguish identical, nested and CRLF Markdown tasks without rewriting other text', () => {
  const text = '# Tips\r\n- [ ] repeat\r\n  - [X] repeat\r\n1. [ ] third\r\n';
  const offset = text.indexOf('- [X]');
  assert.equal(notebookTask(text, offset)?.checked, true);
  assert.equal(toggleNotebookTask(text, offset, false), text.replace('- [X]', '- [ ]'));
  assert.equal(toggleNotebookTask(text, text.indexOf('1.'), true), text.replace('1. [ ]', '1. [x]'));
  assert.equal(toggleNotebookTask(text, 0, true), text);
  assert.equal(notebookTask(text, undefined), undefined);
  assert.equal(notebookTask(text, -1), undefined);
});
test('resize respects layout limits and available viewport space', () => {
  assert.deepEqual(notebookSize(9999, 9999, 600, 500), { width: 600, height: 500 });
  assert.deepEqual(notebookSize(10, 10, 600, 500), { width: 208, height: 160 });
  assert.deepEqual(notebookSize(2000, 2000, 3000, 3000), { width: 1600, height: 1600 });
});
test('edge resize only changes its own axis and retains viewport/minimum constraints', () => {
  assert.deepEqual(resizeNotebook(400, 400, 60, 80, 'right', 900, 800), { width: 460, height: 400 });
  assert.deepEqual(resizeNotebook(400, 400, 60, 80, 'bottom', 900, 800), { width: 400, height: 480 });
  assert.deepEqual(resizeNotebook(400, 400, 60, 80, 'corner', 900, 800), { width: 460, height: 480 });
  assert.deepEqual(resizeNotebook(400, 400, 9999, -9999, 'corner', 900, 800), { width: 900, height: 160 });
});
