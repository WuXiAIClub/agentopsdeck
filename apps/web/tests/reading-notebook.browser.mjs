import assert from 'node:assert/strict';
import { resourceCaption } from './resource-caption.mjs';
import { prependNotebookReading } from '../src/lib/session-notebook.ts';

/** Called by the real isolated Hub/SQLite article-reading browser suite. */
export async function verifyReadingNotebook({ page, summary, copied, notebookIds, originalNote, width, index, read, writes, failure }) {
  const writesBefore = writes();
  await summary.getByRole('button', { name: 'Save reading to a notebook', exact: true }).click();
  const transfer = summary.getByRole('region', { name: 'Save reading to a notebook', exact: true });
  const target = transfer.getByRole('combobox', { name: 'Target notebook', exact: true });
  const confirm = transfer.getByRole('button', { name: 'Confirm: add to notebook', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await transfer.getByText('Open a notebook card in this workspace first.', { exact: true }).waitFor();
  for (let n = 0; n < notebookIds.length; n++) {
    await page.getByLabel('Layout presets', { exact: true }).click();
    await page.getByRole('button', { name: 'Open notebook: Reading notebook', exact: true }).nth(n).click();
  }
  const notebookPane = page.locator('[data-workspace-pane]').filter({ has: page.locator(`[data-remote-notebook="${notebookIds[1]}"]`) });
  const notebook = notebookPane.locator('.session-notebook');
  await notebook.getByText('Saved to Hub', { exact: true }).waitFor();
  const options = await target.locator('option').evaluateAll(nodes => nodes.filter(n => n.value).map(n => ({ id: n.value, title: n.textContent })));
  assert.equal(options.length, 2); assert.notEqual(options[0].title, options[1].title);
  const chosen = options.find(n => JSON.parse(n.id)[3] === notebookIds[1]); assert.ok(chosen);
  await target.selectOption(chosen.id);
  const preview = await transfer.getByRole('textbox', { name: 'Notebook reading preview', exact: true }).inputValue();
  assert.deepEqual(JSON.parse(preview), copied);
  assert.equal(writes(), writesBefore, 'target selection and preview do not write');
  if (index === 0) failure(true);
  await confirm.click();
  await transfer.getByText('Added to the notebook draft. Check its save status before closing.', { exact: true }).waitFor();
  assert.equal(await confirm.isDisabled(), true);
  if (index === 0) {
    await notebook.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(read(notebookIds[1]).text, originalNote);
    failure(false); await notebook.getByRole('button', { name: 'Retry', exact: true }).click();
  }
  await notebook.getByText('Saved to Hub', { exact: true }).waitFor();
  assert.equal(read(notebookIds[1]).text, prependNotebookReading(originalNote, preview));
  assert.equal(read(notebookIds[1]).revision, 2);
  assert.equal(read(notebookIds[0]).text, originalNote);
  assert.equal(writes() - writesBefore, index === 0 ? 2 : 1);
  assert.equal(await notebook.locator('img,script,iframe').count(), 0);
  assert.ok(await transfer.evaluate(el => el.scrollWidth <= el.clientWidth));
  // Closed targets disappear; never fall back to the other same-title notebook.
  await (await resourceCaption(notebook)).getByRole('button', { name: 'Close pane', exact: true }).click();
  assert.equal(await target.inputValue(), ''); assert.equal(await confirm.isDisabled(), true);
  await summary.getByRole('button', { name: 'Save reading to a notebook', exact: true }).click();
  const remaining = page.locator(`[data-remote-notebook="${notebookIds[0]}"]`);
  await (await resourceCaption(remaining)).getByRole('button', { name: 'Close pane', exact: true }).click();
  console.log(`Reading → notebook ${width}: consent, exact target, inert prepend, save/recovery and removed target PASS`);
}
