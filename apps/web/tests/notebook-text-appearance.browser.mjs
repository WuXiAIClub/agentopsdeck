import assert from 'node:assert/strict';

// Called inside the existing isolated Hub/SQLite/browser notebook acceptance.
export async function verifyNotebookTextAppearance({ page, note, reopen, replaceNote, width }) {
  // Tiptap restores toolbar focus in rAF. Let that finish before starting the
  // next keyboard selection; synthetic key bursts otherwise race DOM selection.
  const settleFocus = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await replaceNote(note, 'Styled plain');
  const selectStyled = async () => {
    const editor = note.getByRole('textbox');
    await settleFocus(); await editor.focus(); await settleFocus();
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await settleFocus();
  };
  await selectStyled();
  await note.getByRole('button', { name: 'Bold', exact: true }).click();
  const initialEditor = await note.getByRole('textbox').boundingBox();
  await note.getByRole('button', { name: 'Text appearance', exact: true }).click();
  assert.deepEqual(await note.getByRole('textbox').boundingBox(), initialEditor, 'opening palette does not displace or shrink editor');
  await note.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('135');
  await note.getByRole('button', { name: 'Text color: #1d4ed8', exact: true }).click();
  await page.waitForTimeout(550); // Isolate the highlight transaction in undo history.
  await note.getByRole('button', { name: 'Highlight: #fef08a', exact: true }).click();
  const styled = () => note.getByRole('textbox').locator('span[data-agentopsdeck-note]');
  assert.equal(await styled().innerText(), 'Styled', 'format controls preserve the selected range');
  assert.equal(await styled().getAttribute('data-agentopsdeck-note'), 'v1;135;#1d4ed8;#fef08a');
  assert.equal(await note.getByRole('textbox').innerText(), 'Styled plain', 'formatting does not duplicate text');
  const colors = await styled().evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
    size: parseFloat(getComputedStyle(element).fontSize), base: parseFloat(getComputedStyle(element.closest('.notebook-rich-content')).fontSize) }));
  assert.equal(colors.color, 'rgb(29, 78, 216)'); assert.equal(colors.background, 'rgb(254, 240, 138)');
  assert.ok(Math.abs(colors.size / colors.base - 1.35) < .01, 'local size applies relative to notebook font');
  const previousScale = await page.evaluate(() => {
    const root = document.documentElement, previous = root.style.getPropertyValue('--agentopsdeck-notebooks-font-scale');
    root.style.setProperty('--agentopsdeck-notebooks-font-scale', '1.2'); return previous;
  });
  const scaledSize = await styled().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert.ok(Math.abs(scaledSize / colors.size - 1.2) < .01, 'global scale applies exactly once to local text sizes');
  await page.evaluate(previous => {
    if (previous) document.documentElement.style.setProperty('--agentopsdeck-notebooks-font-scale', previous);
    else document.documentElement.style.removeProperty('--agentopsdeck-notebooks-font-scale');
  }, previousScale);
  await note.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await styled().getAttribute('data-agentopsdeck-note'), 'v1;135;#1d4ed8;-');
  await note.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal(await styled().getAttribute('data-agentopsdeck-note'), 'v1;135;#1d4ed8;#fef08a');
  // Applying another region's appearance must not flatten the first selection.
  const editor = note.getByRole('textbox');
  await settleFocus(); await editor.focus(); await settleFocus();
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await settleFocus();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'plain', 'second range selected before formatting');
  await note.getByRole('button', { name: 'Text appearance', exact: true }).click();
  await note.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('70');
  await note.getByRole('button', { name: 'Text color: #b91c1c', exact: true }).click();
  assert.equal(await styled().count(), 2);
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  note = await reopen();
  assert.equal(await styled().count(), 2, 'both styles survive actual Hub save and browser reload');
  assert.equal(await note.getByRole('textbox').innerText(), 'Styled plain', 'reload preserves exact text and whitespace');
  assert.equal(await styled().last().innerText(), 'plain');
  assert.equal(await styled().first().getAttribute('data-agentopsdeck-note'), 'v1;135;#1d4ed8;#fef08a');
  assert.equal(await styled().last().getAttribute('data-agentopsdeck-note'), 'v1;70;#b91c1c;-');
  assert.equal(await note.getByRole('textbox').locator('strong').innerText(), 'Styled');
  const appearance = note.getByRole('button', { name: 'Text appearance', exact: true });
  await appearance.click();
  await page.keyboard.press('Escape');
  assert.equal(await note.locator('.notebook-text-appearance').count(), 0, 'Escape dismisses palette');
  assert.ok(await note.getByRole('textbox').isVisible(), 'Escape does not close parent notebook');
  assert.ok(await appearance.evaluate(element => element === document.activeElement), 'Escape restores trigger focus');
  await appearance.click();
  // On narrow screens the floating palette covers the editor's centre. Click
  // the visible bottom edge to exercise a real outside pointer, not the tray.
  const outsideEditor = await note.getByRole('textbox').boundingBox();
  await note.getByRole('textbox').click({ position: { x: 8, y: outsideEditor.height - 8 } });
  assert.equal(await note.locator('.notebook-text-appearance').count(), 0, 'outside pointer dismisses palette');
  await selectStyled(); await note.getByRole('button', { name: 'Text appearance', exact: true }).click();
  assert.ok(await note.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'no notebook horizontal overflow');
  const tray = await note.locator('.notebook-text-appearance').boundingBox(), content = await note.getByRole('textbox').boundingBox();
  assert.ok(tray.x >= 0 && tray.x + tray.width <= width + 1 && tray.y >= 0, 'floating palette remains in viewport');
  assert.ok(content.height > 0, 'editor remains available behind the floating palette');
  await page.screenshot({ path: `/tmp/agentopsdeck-233-c1-notebook-${width}.png` });
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'Styled', 'reset applies to the selected text');
  await note.getByRole('button', { name: 'Reset text appearance', exact: true }).click();
  assert.equal(await styled().count(), 1, 'reset removes only the selected appearance');
  assert.equal(await styled().innerText(), 'plain');
  assert.equal(await note.getByRole('textbox').locator('strong').innerText(), 'Styled', 'reset preserves bold');
  await note.getByRole('button', { name: 'Close text appearance' }).click();
  // Appearance works inside checklists, not just plain paragraphs.
  await replaceNote(note, 'Styled'); await settleFocus();
  await note.getByRole('button', { name: 'To-do list', exact: true }).click();
  await selectStyled();
  await note.getByRole('button', { name: 'Text appearance', exact: true }).click();
  await note.getByRole('button', { name: 'Highlight: #bbf7d0', exact: true }).click();
  await note.getByRole('checkbox').check();
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  note = await reopen();
  assert.equal(await note.getByRole('checkbox').isChecked(), true);
  assert.equal(await styled().innerText(), 'Styled');
  assert.equal(await styled().getAttribute('data-agentopsdeck-note'), 'v1;-;-;#bbf7d0');
  await replaceNote(note, '小 tip: npm test');
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  console.log(`notebook rich appearance ${width}: selection, 70% size, colors, highlight, undo/redo, Hub reload, reset, floating palette geometry and dismissal passed`);
  return note;
}
