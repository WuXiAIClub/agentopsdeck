import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, preview } from "vite";
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL("..", import.meta.url)), output = await mkdtemp(join(tmpdir(), "agentopsdeck-notebook-wrap-"));
let server, browser;
try {
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "error", build: { outDir: output, rollupOptions: { input: join(root, "tests/fixtures/notebook-wrap.html") } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: "error", build: { outDir: output }, preview: { host: "127.0.0.1", port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/tests/fixtures/notebook-wrap.html`);
  await page.locator(".notebook-rich-content").first().waitFor();
  assert.equal(await page.locator(".notebook-rich-content table, .notebook-markdown table").count(), 6);
  assert.equal(await page.locator(".notebook-rich-content pre, .notebook-markdown pre").count(), 6);
  const check = async () => {
    // Tiptap task labels intentionally use clipped 1px screen-reader text.
    // Exclude those labels only, not content hidden by overflow containers.
    const overflows = await page.locator("[data-case]").evaluateAll(cards => cards.flatMap(card => [...card.querySelectorAll("*")].filter(el => getComputedStyle(el).clip !== "rect(0px, 0px, 0px, 0px)" && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2).map(el => ({ card: card.dataset.case, tag: el.tagName, class: el.className, client: el.clientWidth, scroll: el.scrollWidth }))));
    assert.deepEqual(overflows, [], "no horizontal overflow, including code, tables, links and toolbar");
  };
  await check();
  for (const width of [240, 320, 390]) {
    const card = page.locator(`[data-case="${width}edit"]`);
    await card.getByRole("button", { name: "Text appearance", exact: true }).click();
    await check();
    await card.getByRole("button", { name: "Close text appearance" }).click();
    const editor = card.getByRole("textbox");
    await editor.focus(); await page.keyboard.press("Control+End"); await page.keyboard.type(" wrap-edit-ok");
    assert.ok((await editor.innerText()).includes("wrap-edit-ok"));
    const before = await editor.innerText();
    await card.getByRole('button', { name: 'Notebook contents', exact: true }).click();
    await card.getByRole('group', { name: 'Notebook contents' }).getByRole('button', { name: 'Narrow notebook', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains('notebook-rich-content'));
    assert.equal(await editor.innerText(), before, 'heading navigation never edits the note');
    assert.equal(await editor.evaluate(el => el.contains(window.getSelection()?.anchorNode)), true);
  }
  await check();
  // Preview navigation uses rendered headings, not Markdown regex matching or source writes.
  const source = page.locator('[data-case="240source"] textarea');
  const navigationText = '# Duplicate\n\n' + 'Paragraph\n\n'.repeat(40) + '## Duplicate\n\n' + 'More\n\n'.repeat(20)
    + '```md\n# Not a heading\n```\n\nSetext title\n============\n\n## Last heading\n\n' + 'Tail\n\n'.repeat(30);
  await source.fill(navigationText);
  for (const width of [240, 320, 390]) {
    const card = page.locator(`[data-case="${width}preview"]`), content = card.locator('.notebook-markdown');
    await card.getByRole('button', { name: 'Notebook contents', exact: true }).click();
    const outline = card.getByRole('group', { name: 'Notebook contents' });
    assert.equal(await outline.getByRole('button').count(), 4);
    const before = await source.inputValue();
    const pageScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    if (width === 320) {
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      assert.equal(await outline.getByRole('button', { name: 'Duplicate', exact: true }).nth(1).evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Enter');
    } else await outline.getByRole('button', { name: 'Duplicate', exact: true }).nth(1).click();
    assert.ok(await content.evaluate(el => el.scrollTop > 100));
    assert.equal(await card.locator('h2').first().evaluate(el => document.activeElement === el), true);
    assert.equal(await source.inputValue(), before, 'preview jump never saves source');
    assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), pageScroll, 'preview jump does not scroll the page');
    await card.getByRole('button', { name: 'Notebook contents', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await outline.count(), 0);
  }
  await source.fill(Array.from({ length: 205 }, (_, i) => `## Heading ${i}`).join('\n\n'));
  const previewCard = page.locator('[data-case="240preview"]');
  await previewCard.getByRole('button', { name: 'Notebook contents', exact: true }).click();
  assert.equal(await previewCard.getByRole('group', { name: 'Notebook contents' }).getByRole('button').count(), 200);
  // Simulate an external source update without an outside pointer event dismissing the popover.
  await source.evaluate(element => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, 'No headings now');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await previewCard.getByRole('group', { name: 'Notebook contents' }).waitFor({ state: 'detached' });
  await previewCard.getByRole('button', { name: 'Notebook contents', exact: true }).click();
  await previewCard.getByText('Add headings to navigate this notebook.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await check();
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  touch.on('pageerror', error => errors.push(error.message));
  await touch.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await touch.goto(`${origin}/tests/fixtures/notebook-wrap.html`);
  const touchCard = touch.locator('[data-case="240preview"]'), trigger = touchCard.getByRole('button', { name: 'Notebook contents', exact: true });
  assert.equal(await trigger.evaluate(el => getComputedStyle(el).opacity), '1', 'touch entry stays visible');
  await trigger.tap();
  await touchCard.getByRole('group', { name: 'Notebook contents' }).getByRole('button', { name: 'Narrow notebook', exact: true }).tap();
  assert.equal(await touchCard.locator('h1').evaluate(el => document.activeElement === el), true);
  const touchEdit = touch.locator('[data-case="240edit"]');
  await touchEdit.getByRole('button', { name: 'Foldable reading mode', exact: true }).tap();
  const touchFold = touchEdit.locator('.notebook-fold-toggle');
  const hitbox = await touchFold.boundingBox();
  assert.ok(hitbox.width >= 44 && hitbox.height >= 44, 'touch fold target is at least 44px');
  await touchFold.tap();
  assert.equal(await touchEdit.locator('pre').isVisible(), false);
  await touch.close();
  // Exercise folding in the production rich editor, not the preview-only fixture.
  const edit = page.locator('[data-case="240edit"]');
  const foldSource = '# Parent\n\nintro\n\n## Child\n\nchild body\n\n### Grandchild\n\nleaf body\n\n## Child\n\nsecond body\n\n# Next\n\nnext body';
  await source.fill(foldSource);
  await edit.getByRole('button', { name: 'Foldable reading mode', exact: true }).click();
  await edit.locator('h2').first().getByRole('button').click();
  assert.equal(await edit.locator('h3').isVisible(), false);
  assert.equal(await edit.locator('h2').nth(1).isVisible(), true, 'duplicate sibling stays visible');
  await edit.locator('h1').first().getByRole('button').click();
  assert.equal(await edit.locator('h2').first().isVisible(), false);
  assert.equal(await edit.locator('h1').nth(1).isVisible(), true);
  await edit.locator('h1').first().getByRole('button').click();
  assert.equal(await edit.locator('h3').isVisible(), false, 'child fold survives parent reopening');
  await edit.getByRole('button', { name: 'Notebook contents', exact: true }).click();
  await edit.getByRole('group', { name: 'Notebook contents' }).getByRole('button', { name: 'Grandchild', exact: true }).click();
  assert.equal(await edit.locator('h3').isVisible(), true, 'outline expands folded ancestors');
  assert.equal(await source.inputValue(), foldSource, 'folding and navigation never rewrite Markdown');
  await edit.locator('.notebook-rich-content').press('Control+z');
  assert.equal(await source.inputValue(), foldSource, 'reading mode cannot undo hidden content');
  await edit.getByRole('button', { name: 'Foldable reading mode', exact: true }).click();
  assert.equal(await edit.locator('.notebook-fold-toggle').count(), 0);
  assert.equal(await edit.locator('.notebook-rich-content').getAttribute('contenteditable'), 'true');
  await page.reload();
  await edit.getByRole('button', { name: 'Foldable reading mode', exact: true }).click();
  await edit.locator('h1').getByRole('button').click();
  await page.reload();
  await edit.locator('.notebook-fold-toggle').waitFor();
  assert.equal(await edit.getByRole('button', { name: 'Foldable reading mode', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await edit.locator('pre').isVisible(), false, 'fold state survives reload');
  assert.equal(await page.locator('[data-case="320edit"] .notebook-fold-toggle').count(), 0, 'other resource preferences remain isolated');
  await page.goto(`${origin}/tests/fixtures/notebook-wrap.html?other-account`);
  await edit.locator('.notebook-rich-content').waitFor();
  assert.equal(await edit.getByRole('button', { name: 'Foldable reading mode', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await edit.locator('pre').isVisible(), true, 'same resource on another account has independent fold state');
  if (process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, widths: [240, 320, 390], modes: ["edit", "preview", "source"], horizontalOverflow: false, editing: true, previewOutline: true, keyboardJump: true, touchReducedMotion: true, staleOutlineClosed: true, persistedFolding: true, accountIsolation: true, readonlyUndoSafe: true }));
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
