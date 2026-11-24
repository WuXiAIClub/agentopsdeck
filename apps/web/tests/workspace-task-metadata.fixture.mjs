import assert from 'node:assert/strict';
import { resourceCaption } from './resource-caption.mjs';

export async function verifyTaskMetadata({ page, board, hub }) {
  const open = async () => {
    await page.keyboard.press('Escape'); // Dismiss caption overflow after Save.
    await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).click();
    return board.getByRole('dialog', { name: 'Task details', exact: true });
  };
  // The full app switches to its separate mobile shell below 768px. Exercise
  // this desktop workspace at its supported minimum; component tests cover320.
  for (const width of [800, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const editor = await open();
    assert.equal(await editor.getByLabel('Task priority', { exact: true }).inputValue(), 'urgent');
    assert.equal(await editor.getByLabel('Due date', { exact: true }).inputValue(), '2028-02-29');
    await editor.getByLabel('Task tag 1', { exact: true }).fill('前端');
    const layout = await editor.evaluate(node => ({ overflow: node.scrollWidth > node.clientWidth,
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
    assert.equal(layout.overflow, false);
    assert.ok(layout.left >= 0 && layout.right <= width);
    await page.keyboard.press('Escape');
  }
  let editor = await open();
  await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
  await editor.getByLabel('Task tag 2', { exact: true }).waitFor();
  const before = hub.boards.get('default', 'default').revision;
  await page.reload();
  editor = await open();
  assert.equal(await editor.getByLabel('Task tag 2', { exact: true }).inputValue(), '', 'incomplete tag survives reload');
  await page.waitForTimeout(1400);
  assert.equal(hub.boards.get('default', 'default').revision, before, 'recovered invalid draft is not auto-replayed');
  await editor.getByRole('button', { name: 'Remove tag 2', exact: true }).click();
  // Removing the focused input/button must not lose subsequent edit access.
  assert.equal(await editor.isVisible(), true, 'removing a tag keeps the editor open');
  assert.equal(await editor.getByLabel('Task tag 1', { exact: true }).evaluate(node => node === document.activeElement), true);
  await editor.getByRole('button', { name: 'Remove tag 1', exact: true }).click();
  assert.equal(await editor.isVisible(), true, 'removing the last tag keeps the editor open');
  assert.equal(await editor.getByRole('button', { name: 'Add tag', exact: true }).evaluate(node => node === document.activeElement), true);
  await editor.getByLabel('Task priority', { exact: true }).selectOption('');
  await editor.getByLabel('Due date', { exact: true }).fill('');
  await page.keyboard.press('Escape');
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-taskboard[data-board-ready="true"]'));
  const cleared = hub.boards.get('default', 'default').tasks[0];
  for (const field of ['tags', 'priority', 'dueDate']) assert.equal(Object.hasOwn(cleared, field), false);
  editor = await open();
  await editor.getByLabel('Task priority', { exact: true }).selectOption('urgent');
  await editor.getByLabel('Due date', { exact: true }).fill('2028-02-29');
  await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
  await editor.getByLabel('Task tag 1', { exact: true }).fill('前端');
  await page.keyboard.press('Escape');
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-taskboard[data-board-ready="true"]'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS task metadata: 800/900px workspace, date/priority/tags, incomplete draft recovery, no replay, clearing and resaving');
}
