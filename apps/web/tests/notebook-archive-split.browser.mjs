import assert from 'node:assert/strict';

// Reused by native and shared notebook acceptance tests with real Hub routes.
// Call after opening the archive; resizing must not mutate either document.
export async function verifyArchiveSplit(page, container, hot) {
  const divider = container.getByRole('separator', { name: 'Resize notebook archive' });
  const archive = container.locator('.notebook-archive-toggle');
  await divider.waitFor();
  const before = await archive.boundingBox(), hotBefore = await hot.boundingBox();
  const bounds = await divider.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 70, { steps: 8 });
  await page.mouse.up();
  assert.ok((await archive.boundingBox()).height > before.height + 35, 'upward drag expands archive');
  assert.ok((await hot.boundingBox()).height < hotBefore.height - 35, 'hot area shrinks instead of overflowing');
  const share = Number(await divider.getAttribute('aria-valuenow'));
  await divider.press('ArrowDown');
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), share - 5);
  await divider.press('End'); assert.equal(await divider.getAttribute('aria-valuenow'), '85');
  await divider.press('Home'); assert.equal(await divider.getAttribute('aria-valuenow'), '15');
  await divider.press('Shift+ArrowUp'); assert.equal(await divider.getAttribute('aria-valuenow'), '25');
  await divider.press('ArrowUp'); assert.equal(await divider.getAttribute('aria-valuenow'), '30');
  assert.ok(await archive.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'archive fits narrow width');
  await archive.locator(':scope > summary').click();
  await divider.waitFor({ state: 'detached' });
  assert.equal(await divider.count(), 0, 'closed archive hides its divider');
  await archive.locator(':scope > summary').click();
  try { await divider.waitFor({ timeout: 5000 }); }
  catch (error) {
    console.error('Archive reopen layout', await archive.evaluate(el => ({ open: el.open, rect: el.getBoundingClientRect().toJSON(), parent: el.parentElement.getBoundingClientRect().toJSON() })));
    await page.screenshot({ path: '/tmp/agentopsdeck-archive-reopen-failure.png' });
    throw error;
  }
  assert.equal(await divider.getAttribute('aria-valuenow'), '30', 'close/reopen retains chosen split');
  assert.equal(await container.getByText('Cold storage is loaded only when opened. Edit Markdown here; the main note is unchanged.', { exact: true }).count(), 0);
  assert.equal(await container.getByText('Notebook file sync scope', { exact: true }).count(), 0);
  assert.equal(await container.getByText(/Hot notes and the real archive share this file binding/).count(), 0);
  if (process.env.AOD_TEST_ARCHIVE_SCREENSHOT) await container.screenshot({ path: process.env.AOD_TEST_ARCHIVE_SCREENSHOT });
}
