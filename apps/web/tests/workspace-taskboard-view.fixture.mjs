import assert from 'node:assert/strict';
import { resourceCaption } from './resource-caption.mjs';

export async function verifyTaskboardView({ page, board, hub, reads, writes }) {
  const button = async name => (await resourceCaption(board)).getByRole('button', { name, exact: true });
  const saved = () => page.waitForFunction(() => Boolean(document.querySelector('.workspace-taskboard[data-board-ready="true"]')));
  const before = hub.boards.get('default', 'default');
  const traffic = { reads: reads.length, writes: writes.length };
  await (await button('Hide completed tasks')).click();
  assert.equal(await board.locator('[data-board-column="done"]').count(), 0);
  assert.equal(await (await button('Show completed tasks')).getAttribute('aria-pressed'), 'true');
  assert.equal(await board.locator('[data-board-column]').count(), 2);
  assert.equal(await (await button('Save')).isDisabled(), true);
  assert.deepEqual(hub.boards.get('default', 'default'), before);
  assert.deepEqual({ reads: reads.length, writes: writes.length }, traffic, 'view toggle sends no request');
  await page.keyboard.press('Escape'); // Dismiss the real narrow-caption overflow.
  const pane = board.locator('xpath=ancestor::*[@data-workspace-pane][1]');
  const oldWidth = await pane.evaluate(el => el.style.width);
  for (const [width, columns] of [[900, 2], [400, 2], [320, 1]]) {
    await pane.evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await board.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await board.locator('.workspace-board-columns').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), columns);
    assert.equal(await board.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'hidden Done layout does not overflow');
  }
  await pane.evaluate((el, width) => { el.style.width = width; }, oldWidth);
  // Completing a task while filtered still saves the entire document, including Done.
  await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).click({ button: 'right' });
  await board.getByRole('menuitem', { name: 'Mark task complete', exact: true }).click();
  assert.equal(await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).count(), 0);
  await (await button('Save')).click(); await saved();
  assert.equal(hub.boards.get('default', 'default').tasks[0].status, 'done');
  const reloadReads = reads.length;
  await page.reload(); await saved();
  assert.equal(reads.length, reloadReads + 1, 'preference restoration adds no resource reads');
  assert.equal(await board.locator('[data-board-column="done"]').count(), 0);
  const otherPage = await page.context().newPage();
  try {
    await otherPage.goto(page.url());
    const otherBoard = otherPage.getByRole('region', { name: 'Task board', exact: true });
    await otherBoard.locator('xpath=self::*[@data-board-ready="true"]').waitFor();
    assert.equal(await otherBoard.locator('[data-board-column="done"]').count(), 0);
    const sharedTraffic = { reads: reads.length, writes: writes.length };
    await (await resourceCaption(otherBoard)).getByRole('button', { name: 'Show completed tasks', exact: true }).click();
    await board.locator('[data-board-column="done"]').waitFor();
    await (await resourceCaption(otherBoard)).getByRole('button', { name: 'Hide completed tasks', exact: true }).click();
    await board.locator('[data-board-column="done"]').waitFor({ state: 'detached' });
    assert.deepEqual({ reads: reads.length, writes: writes.length }, sharedTraffic, 'cross-tab view sync sends no resource requests');
  } finally { await otherPage.close(); }
  await (await button('Show completed tasks')).click();
  await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).waitFor();
  assert.equal(await (await button('Save')).isDisabled(), true);
  await page.keyboard.press('Escape');
  // Restore the existing fixture, retaining title/details/ID and normal drag checks.
  await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).click();
  await board.getByRole('combobox', { name: 'Task status', exact: true }).selectOption('doing');
  await page.keyboard.press('Escape');
  await (await button('Save')).click(); await saved();
  assert.deepEqual(hub.boards.get('default', 'default').tasks, before.tasks);
  console.log(JSON.stringify({ taskboardView: 'passed', checks: ['no requests or dirty draft', 'complete while hidden', 'full saved document', 'refresh persistence', 'cross-tab sync without requests', 'restore Done', '900px two columns', '320px one column'] }));
}
