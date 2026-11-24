import assert from 'node:assert/strict';

/** Runs inside the real Hub/SQLite notebook suite; no production data/requests. */
export async function verifyNotebookDocking(page, counts) {
  let note = page.getByRole('dialog', { name: 'Global notebook', exact: true });
  const initialText = await note.getByRole('textbox').innerText();
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(element => element.textContent === 'Saving…'));
  const before = counts();
  await note.getByRole('textbox').evaluate(element => { window.dockingEditor = element; });
  const surface = await page.locator('.session-workspace-surface').boundingBox();
  assert.ok(surface && surface.width > 640);
  const point = { x: surface.x + surface.width - 12, y: surface.y + surface.height / 2 };
  async function dragTitle(release = true) {
    const title = await note.locator('.notebook-title button').boundingBox();
    await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
    await page.mouse.down(); await page.mouse.move(point.x, point.y, { steps: 15 });
    await page.locator('.session-workspace-drop-preview[data-drop-kind="right"]').waitFor();
    if (release) await page.mouse.up();
  }
  await dragTitle(false);
  assert.deepEqual(counts(), before, 'pointer frames do not read/save notebook or layout');
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('.workspace-notebook-host').count(), 0, 'Escape does not dock');
  assert.deepEqual(counts(), before, 'cancel does not persist coordinates');
  await dragTitle();
  note = page.getByRole('region', { name: 'Global notebook', exact: true });
  await note.waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Global notebook', exact: true }).count(), 0, 'no duplicate floating editor');
  assert.equal(await note.getByRole('textbox').evaluate(element => element === window.dockingEditor), true, 'dock preserves the editor DOM instance');
  assert.equal(await note.getByRole('textbox').innerText(), initialText);
  assert.deepEqual(counts(), before, 'docking only saves browser geometry, not a new Hub resource');
  const pane = page.locator('[data-workspace-pane]').filter({ has: note });
  assert.equal(await note.locator('.notebook-header').count(), 0, 'no duplicate title row when docked');
  await pane.locator('.session-pane-caption').getByRole('button', { name: 'Notebook appearance', exact: true }).click();
  await note.getByRole('button', { name: 'Rename', exact: true }).waitFor();
  await pane.locator('.session-pane-caption').getByRole('button', { name: 'Notebook appearance', exact: true }).click();
  await note.getByRole('textbox').focus();
  await page.waitForFunction(() => document.querySelector('.workspace-notebook-host')?.closest('[data-workspace-pane]')?.dataset.active === 'true');
  await note.getByRole('textbox').press('Control+End'); await page.keyboard.insertText(' undo-survives-docking');
  await pane.getByRole('button', { name: 'Float pane', exact: true }).click();
  assert.equal(await pane.getAttribute('data-floating'), 'true');
  assert.equal(await note.getByRole('textbox').evaluate(element => element === window.dockingEditor), true);
  await note.getByRole('textbox').focus(); await note.getByRole('textbox').press('Control+z');
  assert.equal(await note.getByRole('textbox').innerText(), initialText, 'undo stack survives float transition');
  await pane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  await page.waitForTimeout(250); // Layout debounce is 180ms; no business request.
  const afterEdit = counts();
  await page.reload();
  note = page.getByRole('region', { name: 'Global notebook', exact: true });
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Global notebook', exact: true }).count(), 0);
  assert.equal(await note.getByRole('textbox').innerText(), initialText, 'reload restores the same resource');
  assert.equal(counts().reads - afterEdit.reads, 1, 'restore reads notebook content once');
  await note.getByRole('textbox').evaluate(element => { window.dockingEditor = element; });
  await page.locator('[data-workspace-pane]').filter({ has: note }).getByRole('button', { name: 'Close pane', exact: true }).click();
  note = page.getByRole('dialog', { name: 'Global notebook', exact: true });
  await note.waitFor();
  assert.equal(await note.getByRole('textbox').evaluate(element => element === window.dockingEditor), true, 'return to original float preserves the editor');
  assert.equal(await note.getByRole('textbox').innerText(), initialText);
  console.log('Notebook docking: pointer cancel, one editor/writer, zero drag requests, undo, activation, float, reload and return passed');
}
