import { resourceCaption } from './resource-caption.mjs';
import assert from 'node:assert/strict';

// Called with the real isolated taskboard/Hub fixture; no production requests.
export async function verifyTaskboardDrag({ page, context, board, reads, writes }) {
  // Cross-column targets must actually be visible. Narrow cards stack columns;
  // their offscreen headings can otherwise hit the pane's resize edge.
  const pane = board.locator('xpath=ancestor::*[@data-workspace-pane][1]');
  const originalWidth = await pane.evaluate(el => { const width = el.style.width; el.style.width = '900px'; return width; });
  await page.evaluate(() => {
    window.testDraftWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage && key.startsWith('agentopsdeck.board-draft.v1:')) window.testDraftWrites++;
      return original.call(this, key, value);
    };
  });
  const column = status => board.locator(`[data-board-column="${status}"]`);
  const card = title => board.locator('[data-board-task]').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const titles = status => column(status).locator('.workspace-task-summary').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  const start = async title => {
    const handle = card(title).getByRole('button', { name: 'Drag task to move or reorder' });
    await handle.scrollIntoViewIfNeeded(); const r = await handle.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down();
  };
  const move = async locator => {
    const r = await locator.boundingBox(); assert.ok(r);
    await page.mouse.move(r.x + r.width / 2, r.y + Math.min(5, r.height / 2), { steps: 18 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const save = async () => {
    await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
    await board.locator('xpath=self::*[@data-board-ready="true"]').waitFor();
  };
  for (const title of ['Drag B', 'Drag C']) {
    await column('todo').getByRole('button', { name: 'Add task', exact: true }).click();
    await column('todo').getByRole('button', { name: 'New task', exact: true }).click();
    await column('todo').getByRole('textbox', { name: 'Task title', exact: true }).last().fill(title);
    await page.keyboard.press('Escape');
  }
  await save();
  const traffic = { reads: reads.length, writes: writes.length };
  let localWrites = await page.evaluate(() => window.testDraftWrites);
  await start('Drag C'); await move(card('Drag B'));
  assert.equal(await card('Drag B').getAttribute('data-drop-before'), 'true');
  assert.equal(await page.evaluate(() => window.testDraftWrites), localWrites, 'hover does not persist drafts');
  assert.deepEqual({ reads: reads.length, writes: writes.length }, traffic, 'drag has no Hub requests');
  await page.mouse.up();
  assert.deepEqual(await titles('todo'), ['Drag C', 'Drag B']);
  assert.equal(await page.evaluate(() => window.testDraftWrites), ++localWrites, 'drop persists one draft');
  await start('Drag C'); await move(card('Drag B')); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.testDraftWrites), localWrites, 'no-op does not persist');
  for (const cancel of ['escape', 'outside', 'blur', 'pointercancel']) {
    await start('Drag B'); await move(column('done').locator('h3'));
    assert.equal(await column('done').getAttribute('data-drop-active'), 'true');
    if (cancel === 'escape') await page.keyboard.press('Escape');
    if (cancel === 'outside') await page.mouse.move(2, 2);
    if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    if (cancel === 'pointercancel') await card('Drag B').locator('.workspace-board-task-grip').dispatchEvent('pointercancel', { pointerId: 1 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.testDraftWrites), localWrites, `${cancel} must not commit`);
    assert.equal(await board.locator('[data-drop-active="true"]').count(), 0);
  }
  // Editing changes the draft identity and invalidates a gesture in progress.
  await start('Drag B'); await move(column('done').locator('h3'));
  await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).fill('Changed during drag');
  await page.mouse.up();
  assert.deepEqual(await titles('done'), []);
  await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).fill('Release plan');
  await start('Drag B'); await move(column('done').locator('h3')); await page.mouse.up();
  assert.deepEqual(await titles('done'), ['Drag B']);
  assert.deepEqual({ reads: reads.length, writes: writes.length }, traffic, 'drop stays local until Save');
  // Native Chromium touch dispatch uses the same pointer capture path.
  const touch = await context.newCDPSession(page);
  const grip = await card('Drag B').locator('.workspace-board-task-grip').boundingBox();
  const destination = await column('doing').locator('h3').boundingBox();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grip.x + 7, y: grip.y + 7, id: 0 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: destination.x + 15, y: destination.y + 5, id: 0 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  assert.deepEqual(await titles('doing'), ['Drag B', 'Isolated acceptance']);
  await save(); await page.reload();
  await board.locator('xpath=self::*[@data-board-ready="true"]').waitFor();
  assert.deepEqual(await titles('doing'), ['Drag B', 'Isolated acceptance']);
  assert.deepEqual(await titles('todo'), ['Drag C']);
  await card('Drag B').getByRole('button', { name: 'Drag B', exact: true }).click();
  await card('Drag B').getByRole('button', { name: 'Move task down', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.deepEqual(await titles('doing'), ['Isolated acceptance', 'Drag B']);
  // Edge auto-scroll belongs to this board, never the entire workspace. A
  // stationary pointer stops scheduling scroll work once it leaves the board.
  for (let i = 0; i < 7; i++) {
    await column('todo').getByRole('button', { name: 'Add task', exact: true }).click();
    await column('todo').getByRole('button', { name: 'New task', exact: true }).click();
    await column('todo').getByRole('textbox', { name: 'Task title', exact: true }).last().fill(`Scroll ${i}`);
    await page.keyboard.press('Escape');
  }
  await board.evaluate(el => { el.style.maxHeight = '380px'; el.scrollTop = 0; });
  for (const width of [900, 320]) {
    await pane.evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await board.evaluate(el => { el.scrollTop = 0; el.querySelectorAll('[data-board-column]').forEach(col => { col.scrollTop = 0; }); });
    const scroller = width === 900 ? column('todo') : board;
    await start('Drag C');
    const bounds = await scroller.boundingBox();
    const beforeScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const top = await scroller.evaluate(el => el.scrollTop);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 12, { steps: 6 });
    await page.waitForFunction(({ width, top }) => document.querySelector(width === 900 ? '[data-board-column="todo"]' : '.workspace-taskboard').scrollTop > top + 20, { width, top });
    assert.deepEqual(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })), beforeScroll);
    if (width === 900) {
      assert.equal(await board.evaluate(el => el.scrollTop), 0, 'multi-column scroll leaves board fixed');
      assert.equal(await column('doing').evaluate(el => el.scrollTop), 0, 'other column stays fixed');
    } else assert.equal(await column('todo').evaluate(el => getComputedStyle(el).overflowY), 'visible');
    await page.mouse.move(2, 2); await page.mouse.up();
    const stoppedAt = await scroller.evaluate(el => el.scrollTop);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await scroller.evaluate(el => el.scrollTop), stoppedAt);
  }
  assert.deepEqual(await titles('todo'), ['Drag C', ...Array.from({ length: 7 }, (_, i) => `Scroll ${i}`)]);
  await board.evaluate(el => { el.style.maxHeight = ''; el.scrollTop = 0; });
  await pane.evaluate((el, width) => { el.style.width = width; }, originalWidth);
  for (let i = 0; i < 7; i++) { await card(`Scroll ${i}`).getByRole('button', { name: `Scroll ${i}`, exact: true }).click(); await card(`Scroll ${i}`).getByRole('button', { name: 'Remove task', exact: true }).click(); }
  // Restore the original one-task baseline for all existing conflict/grant tests.
  for (const title of ['Drag B', 'Drag C']) { await card(title).getByRole('button', { name: title, exact: true }).click(); await card(title).getByRole('button', { name: 'Remove task', exact: true }).click(); }
  await save();
  console.log(JSON.stringify({ taskDrag: 'passed', checks: ['reorder', 'cross-column', 'touch', 'target feedback', 'cancel', 'draft race', 'no hover writes or requests', 'no-op', 'save/reload', 'keyboard controls', 'board-only auto-scroll and cleanup'] }));
}
