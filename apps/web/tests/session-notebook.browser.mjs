// Isolated real Hub notebook routes + SQLite, browser UI, synthetic chat catalog.
// Run with Node --import ./apps/server/node_modules/tsx/dist/loader.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fontScaleCss } from '../src/lib/font-scale-css.ts';
import { verifyFontPreferences } from './font-preferences.browser.mjs';
import { verifyNotebookDocking } from './notebook-docking.browser.mjs';
import { verifyNotebookTextAppearance } from './notebook-text-appearance.browser.mjs';
import { verifyArchiveSplit } from './notebook-archive-split.browser.mjs';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
// Use keyboard selection: DOM-based fill bypasses ProseMirror's selection
// transactions when the document contains checkbox/table node views.
async function replaceNote(note, text) {
  const editor = note.getByRole('textbox');
  await editor.focus(); await editor.press('Control+Home'); await editor.press('Control+a');
  await editor.press('Backspace');
  await editor.page().keyboard.insertText(text);
  assert.ok((await editor.innerText()).includes(text), 'typed text reaches the rich document');
}
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-notebook-browser-'));
async function pasteMarkdown(note, text) {
  const editor = note.getByRole('textbox');
  await replaceNote(note, '');
  await editor.evaluate((element, text) => { const data = new DataTransfer(); data.setData('text/plain', text); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, text);
}
// Built assets must be served unchanged, without dev transforms/HMR.
const server = process.env.AOD_TEST_WEB_ROOT
  ? await preview({ root: process.env.AOD_TEST_WEB_ROOT, configFile: false, envFile: false, build: { outDir: process.env.AOD_TEST_WEB_ROOT }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
    plugins: [react(), tailwindcss()], css: { postcss: { plugins: [fontScaleCss()] } }, cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser, hub, routes;
try {
  if ('listen' in server) await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const width of process.env.AOD_TEST_NOTEBOOK_WIDTHS?.split(',').map(Number) ?? [1440, 390]) {
    // Each viewport starts from a fresh Hub, not the preceding viewport's
    // persisted visible global notes. Reloads within this case still share it.
    hub = new HubStore(join(directory, `hub-${width}.sqlite`), 'synthetic-notebook-test');
    hub.upsertConnection({ id: 'local', ownerUserId: 'default', kind: 'local', label: 'Fixture', connectorUrl: 'local://aod-connector', credentialToken: 'synthetic' });
    hub.pinConnectionNode('local', 'default', hub.connectionAuthority('local', 'default'), 'node_11111111-1111-4111-8111-111111111111');
    const app = new Hono(), principal = { userId: 'default', admin: true };
    routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
      connectorClient: () => { throw Error('Notebook must not dispatch to Connector'); }, normalizeError: () => 'Synthetic', principal: () => principal });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const keys = ['codex', 'hermes'].map(runtime => encodeHubSessionId('local', `${runtime}:notebook-${width}`));
    let offline = false, noteReads = 0, writes = 0, layoutWrites = 0, archiveReads = 0, archiveWrites = 0;
    let holdRead, releaseRead;
    const errors = [], forbidden = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname.startsWith('/api/hub/v1/workspace/shared-content/')) return json({ enabled: false, head: null, native: null, bindings: [] });
      if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/')) {
        const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      if (url.pathname.endsWith('/notebook') || url.pathname.endsWith('/notebook/archive') || url.pathname.includes('/notebooks')) {
        if (url.pathname.endsWith('/archive')) { if (req.method() === 'PUT') archiveWrites++; else archiveReads++; }
        if (url.pathname.endsWith('/layout') && req.method() === 'PUT') layoutWrites++;
        if (!url.pathname.endsWith('/notebooks') && !url.pathname.endsWith('/layout')) { if (req.method() === 'PUT') writes++; else noteReads++; }
        if (req.method() === 'GET' && url.pathname.endsWith('/notebook') && holdRead) await holdRead;
        if (offline) return route.fulfill({ status: 503, json: { error: 'Synthetic offline' } });
        const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      if (url.pathname === '/api/hub/v1/completions/summary' && req.method() === 'POST') return json({ items: [] }); // Read-only polling, not a session action.
      if (!['GET', 'HEAD'].includes(req.method())) { forbidden.push(`${req.method()} ${url.pathname}`); return route.fulfill({ status: 404, json: {} }); }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.includes('/workspace/file-cards/')) return json(url.pathname.endsWith('/file-binding')
        ? { enabled: true, binding: null }
        : { version: 1, kind: 'notebook', revision: 1, content: { text: '', archive: '' } });
      if (url.pathname === '/api/hub/v1/shared/grants') return json({ grants: [], nextCursor: null });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: keys.map((key, index) => ({ sessionKey: key,
        envConnectionId: 'local', source: index ? 'hermes' : 'codex', agentId: index ? 'hermes' : 'codex', title: index ? 'Hermes tips' : 'Codex tips', status: 'idle' })) }] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', messages: [{ id: 'font-fixture', sessionKey: decodeURIComponent(url.pathname.split('/').at(-2)), role: 'assistant', text: 'Font fixture · 字号测试\n\n`inline code`\n\n```js\nconst scale = 100;\n```', createdAt: 1, status: 'sent' }], totalCount: 1, hiddenCount: 0 });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      // addInitScript also runs in the new page's opaque about:blank document.
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        if (!localStorage.getItem('agentopsdeck.locale')) localStorage.setItem('agentopsdeck.locale', 'en');
      }
      const streams = [];
      window.fixtureResourceEvent = value => { for (const stream of streams) if (stream.readyState === 1) stream.dispatchEvent(new MessageEvent(value.type, { data: JSON.stringify(value) })); };
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    context.on('page', p => {
      p.on('pageerror', error => errors.push(error.stack ?? error.message));
      // React error boundaries catch failures before pageerror; recovery is
      // not a passing test. Expected synthetic HTTP errors are separate.
      p.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
    });
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    const captionButton = async (p, name, key = keys[0]) => {
      const root = width >= 700 ? p.locator('[data-workspace-pane]').filter({ has: p.locator(`[data-session-pane="${key}"]`) }) : p;
      const button = name === 'Session notebook' ? root.locator('button.notebook-trigger[aria-label="Session notebook"]') : root.getByRole('button', { name, exact: true });
      if (!await button.isVisible()) {
        const tools = root.getByRole('button', { name: 'Pane tools', exact: true });
        if (await tools.isVisible()) await tools.click();
      }
      return button;
    };
    const open = async (p, key = keys[0]) => {
      await p.goto(origin);
      // A restored floating note may cover the card. Navigate by the supported
      // keyboard interaction instead of forcing a click through another editor.
      await p.locator(`[data-session-card="${key}"]`).focus(); await p.locator(`[data-session-card="${key}"]`).press('Enter');
      if (width >= 700) await p.locator('[data-workspace-pane]').filter({ has: p.locator(`[data-session-pane="${key}"]`) }).locator('.caption-overflow').waitFor();
      const trigger = await captionButton(p, 'Session notebook', key);
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      // Desktop preserves other open session notebooks. The first note is
      // renamed below; the second still has its default visible heading.
      let note = p.getByRole('dialog', { name: 'Session notebook', exact: true });
      if (await note.count() > 1) note = note.filter({ has: p.locator('.notebook-title strong').filter({ hasText: key === keys[1] ? /^Session notebook$/ : /^Release tips$/ }) });
      try { await note.getByRole('textbox').waitFor(); }
      catch (error) { console.error('Notebook open failed', { width, errors, text: await p.locator('body').innerText() }); if (process.env.AOD_TEST_SCREENSHOT_DIR) await p.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, `notebook-open-failure-${width}.png`) }); throw error; }
      await note.getByText('Saved to Hub', { exact: true }).waitFor(); return note;
    };
    await page.goto(origin); await page.locator(`[data-session-card="${keys[0]}"]`).waitFor();
    assert.equal(noteReads, 0, 'closed notebook makes no requests');
    let note = await open(page);
    await note.getByRole('textbox').fill('小 tip: npm test\n<script>must stay text</script>');
    await note.getByText('Saved to Hub', { exact: true }).waitFor();
    assert.equal(writes, 1); assert.equal(await note.locator('script').count(), 0);
    const editor = note.locator('.notebook-rich-content');
    await editor.focus(); await editor.press('Control+End');
    const beforeReconcile = noteReads;
    holdRead = new Promise(resolve => { releaseRead = resolve; });
    await page.evaluate(key => window.fixtureResourceEvent({ type: 'workspace.revisions', resourceType: 'card-file-binding', resources: [{ resourceId: JSON.stringify(['notebook', `session:${key}`]), revision: 1 }] }), keys[0]);
    for (let i = 0; i < 100 && noteReads === beforeReconcile; i++) await page.waitForTimeout(20);
    assert.equal(noteReads, beforeReconcile + 1, 'binding revision triggers one background reconcile');
    assert.equal(await editor.getAttribute('contenteditable'), 'true');
    assert.equal(await editor.evaluate(el => el === document.activeElement), true, 'background read preserves typing focus');
    await page.keyboard.type(' continuous typing');
    holdRead = undefined; releaseRead();
    await note.getByText('Saved to Hub', { exact: true }).waitFor();
    assert.ok((await editor.innerText()).includes('continuous typing'));
    assert.equal(await editor.evaluate(el => el === document.activeElement), true, 'save acknowledgement preserves focus');
    if (process.env.AOD_TEST_NOTEBOOK_ARCHIVE_ONLY === '1') {
      assert.equal(archiveReads, 0, 'cold content is never fetched by opening or editing main note');
      const hot = await editor.innerText();
      await note.locator('.notebook-archive-toggle > summary').click();
      const archive = note.getByRole('textbox', { name: 'Notebook archive', exact: true });
      await archive.waitFor();
      const beforeSplitWrites = writes;
      await verifyArchiveSplit(page, note, note.locator('.notebook-rich-editor'));
      assert.equal(writes, beforeSplitWrites); assert.equal(archiveWrites, 0, 'resizing never saves a document');
      const coldText = '文'.repeat(100_000);
      await archive.fill(coldText); await archive.blur();
      await note.locator('.notebook-archive').getByText('Saved', { exact: true }).waitFor();
      assert.equal(archiveWrites, 1); assert.ok(archiveReads >= 1, 'first open loads archive; an earlier binding notice may reconcile it');
      const loadedColdReads = archiveReads;
      assert.equal(await editor.innerText(), hot);
      await note.locator('.notebook-archive-toggle > summary').click();
      // Mobile does not automatically reopen a session drawer after reload.
      note = await open(page);
      await note.getByText('Saved to Hub', { exact: true }).waitFor();
      assert.equal(archiveReads, loadedColdReads, 'reload does not eagerly reload cold content');
      await note.locator('.notebook-archive-toggle > summary').click();
      const restored = note.getByRole('textbox', { name: 'Notebook archive', exact: true });
      try { await page.waitForFunction(() => document.querySelector('.notebook-archive textarea[aria-label="Notebook archive"]')?.value.length === 100000); }
      catch (error) { console.error('Archive restore failed', { archiveReads, archiveWrites, archive: await note.locator('.notebook-archive-toggle').innerText(), errors }); throw error; }
      assert.equal(await restored.inputValue(), coldText); assert.equal(archiveReads, loadedColdReads + 1); assert.equal(archiveWrites, 1);
      assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
      console.log(JSON.stringify({ width, archive100k: true, lazyReads: true, independentHot: true, persistsReload: true, realHub: true }));
      await context.close(); routes.close(); routes = undefined; hub.close(); hub = undefined;
      continue;
    }
    if (process.env.AOD_TEST_NOTEBOOK_TYPING_ONLY === '1') {
      assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
      console.log(JSON.stringify({ width, continuousTyping: true, backgroundReadPreservesFocus: true, savePreservesFocus: true, realHub: true }));
      await context.close(); routes.close(); routes = undefined; hub.close(); hub = undefined;
      continue;
    }
    if (width >= 700) {
      await note.getByRole('button', { name: 'Close notebook' }).click();
      assert.equal(await page.getByRole('button', { name: 'More session actions', exact: true }).count(), 0);
      assert.equal(await (await captionButton(page, 'Toggle card connections')).count(), 1);
      assert.equal(await (await captionButton(page, 'Native token usage')).count(), 1);
      if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, 'session-management.png') });
      await (await captionButton(page, 'Rename session')).click();
      await page.getByRole('dialog', { name: 'Rename session', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
      await (await captionButton(page, 'Delete session…')).click();
      await page.getByRole('dialog', { name: 'Delete session?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
      await (await captionButton(page, 'Session notebook')).click();
    }
    assert.equal(await page.getByRole('combobox', { name: 'Open a second session' }).count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Open floating session' }).count(), 0);
    // Inline rename: Enter saves, Escape discards; preferences survive reload.
    await note.locator('.notebook-title button').dblclick();
    await note.getByRole('textbox', { name: 'Notebook name' }).fill('Release tips');
    await note.getByRole('textbox', { name: 'Notebook name' }).press('Enter');
    await note.locator('.notebook-title button').dblclick();
    await note.getByRole('textbox', { name: 'Notebook name' }).fill('discard this');
    await note.getByRole('textbox', { name: 'Notebook name' }).press('Escape');
    assert.equal(await note.locator('.notebook-title strong').innerText(), 'Release tips');
    const beforePalette = await note.getByRole('textbox', { name: 'Session notes', exact: true }).boundingBox();
    await note.getByRole('button', { name: 'Notebook appearance', exact: true }).click();
    assert.deepEqual(await note.getByRole('textbox', { name: 'Session notes', exact: true }).boundingBox(), beforePalette, 'background palette does not consume editor space');
    const backgroundPalette = await note.locator('.notebook-appearance').boundingBox();
    assert.ok(backgroundPalette.x >= 0 && backgroundPalette.x + backgroundPalette.width <= width + 1, 'background palette stays within viewport');
    await note.getByRole('button', { name: 'Note color 2', exact: true }).click();
    const opacity = note.getByRole('slider', { name: /Opacity/ });
    await opacity.focus(); await opacity.press('Home');
    assert.equal(await note.evaluate(element => getComputedStyle(element).opacity), '0.35');
    assert.equal(await note.getByRole('slider', { name: 'Width', exact: true }).count(), 0);
    await opacity.press('End');
    await note.getByRole('button', { name: 'Done', exact: true }).click();
    const markdown = '# Release tips\n- [ ] repeated\n- [ ] repeated\n  - [x] nested\n\n**bold**\n<script>window.notebookInjected = true</script>\n\n![private reference](https://example.invalid/no-fetch.png)\n\n| task | owner |\n| --- | --- |\n| ship | me |';
    await pasteMarkdown(note, markdown);
    await note.getByRole('heading', { name: 'Release tips' }).waitFor();
    assert.equal(await note.locator('table').count(), 1, 'existing Markdown tables remain editable');
    assert.equal(await note.locator('img').count(), 0, 'image references never fetch remote assets');
    await note.getByRole('checkbox').nth(1).check();
    await note.getByText('Saved to Hub', { exact: true }).waitFor();
    await verifyFontPreferences({ page, context, origin, note, width });
    assert.equal(await note.getByRole('checkbox').nth(1).isChecked(), true);
    assert.equal(await note.getByRole('checkbox').nth(0).isChecked(), false);
    assert.equal(await note.getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.notebookInjected), undefined);
    await replaceNote(note, 'Ship checklist');
    await note.getByRole('button', { name: 'To-do list', exact: true }).click();
    assert.equal(await note.getByRole('checkbox').count(), 1, 'toolbar creates an editable TODO');
    const taskCheckbox = await note.getByRole('checkbox').boundingBox(), taskText = await note.locator('li[data-type="taskItem"] > div > p').boundingBox();
    assert.ok(taskText.x > taskCheckbox.x && Math.abs(taskText.y - taskCheckbox.y) < 15, 'TODO checkbox and text share one row');
    await page.waitForTimeout(600); // Separate check from the preceding typing undo group.
    await note.getByRole('checkbox').check();
    await note.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await note.getByRole('checkbox').isChecked(), false, 'task checks are undoable');
    await note.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.equal(await note.getByRole('checkbox').isChecked(), true);
    await replaceNote(note, '小 tip: npm test');
    await note.getByText('Saved to Hub', { exact: true }).waitFor();
    note = await verifyNotebookTextAppearance({ page, note, reopen: () => open(page), replaceNote, width });
    const beforeOversize = await note.getByRole('textbox').innerText();
    await note.getByRole('textbox').press('Control+End');
    await note.getByRole('textbox').evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', 'x'.repeat(50001)); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
    await note.getByText('Note is too long. Shorten it before adding more.', { exact: true }).waitFor();
    assert.equal(await note.getByRole('textbox').innerText(), beforeOversize, 'oversized paste cannot undo or erase prior edits');
    note = await open(page);
    assert.equal(await note.locator('.notebook-title strong').innerText(), 'Release tips');
    assert.equal(await note.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(219, 234, 254)');
    if (width < 700) {
      assert.equal(await note.evaluate(element => element.classList.contains('is-mobile-dedicated')), true, 'mobile defaults to dedicated full-screen notebook UI');
      const dedicatedBox = await note.boundingBox();
      assert.ok(dedicatedBox.x <= 1 && Math.abs(dedicatedBox.width - width) <= 2, 'mobile dedicated notebook spans full viewport width');
      await note.getByRole('button', { name: 'Rename', exact: true }).click();
      await note.getByRole('textbox', { name: 'Notebook name' }).press('Escape');
      await note.getByRole('button', { name: 'Restore floating notebook', exact: true }).click();
    }
    // Drag, keyboard movement and resize are bounded, including touch-sized UI.
    const handle = note.getByRole('button', { name: 'Move notebook', exact: true });
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down(); await page.mouse.move(20, 250, { steps: 5 }); await page.mouse.up();
    let rect = await note.boundingBox(); assert.ok(rect.x >= 7 && rect.x + rect.width <= width + 1);
    await handle.focus(); await handle.press('ArrowDown');
    const shifted = await note.boundingBox(); assert.ok(shifted.y >= rect.y);
    const resizeHandle = note.getByRole('button', { name: 'Resize notebook', exact: true });
    const resizeBox = await resizeHandle.boundingBox(), beforeResize = await note.boundingBox();
    await page.mouse.move(resizeBox.x + 10, resizeBox.y + 10); await page.mouse.down();
    await page.mouse.move(resizeBox.x - 45, resizeBox.y - 45, { steps: 5 }); await page.mouse.up();
    const afterResize = await note.boundingBox();
    assert.ok(afterResize.width < beforeResize.width && afterResize.height < beforeResize.height);
    await resizeHandle.focus(); await resizeHandle.press('ArrowRight');
    assert.ok((await note.boundingBox()).width > afterResize.width);
    const beforeEdgeResize = await note.boundingBox();
    const rightEdge = note.getByRole('button', { name: 'Resize notebook width', exact: true });
    await rightEdge.focus(); await rightEdge.press('ArrowLeft');
    const afterRightEdge = await note.boundingBox();
    assert.ok(afterRightEdge.width < beforeEdgeResize.width, 'right edge changes width');
    assert.equal(afterRightEdge.height, beforeEdgeResize.height, 'right edge preserves height');
    const bottomEdge = note.getByRole('button', { name: 'Resize notebook height', exact: true });
    await bottomEdge.focus(); await bottomEdge.press('ArrowUp');
    const afterBottomEdge = await note.boundingBox();
    assert.ok(afterBottomEdge.height < afterRightEdge.height, 'bottom edge changes height');
    assert.equal(afterBottomEdge.width, afterRightEdge.width, 'bottom edge preserves width');
    const titleBox = await note.locator('.notebook-title button').boundingBox(), beforeTitleDrag = await note.boundingBox();
    await page.mouse.move(titleBox.x + 12, titleBox.y + 12); await page.mouse.down(); await page.mouse.move(titleBox.x + 12, titleBox.y + 42, { steps: 6 }); await page.mouse.up();
    assert.ok((await note.boundingBox()).y > beforeTitleDrag.y + 15, 'title is a drag handle');
    await note.getByRole('button', { name: 'Notebook appearance', exact: true }).click();
    await note.getByRole('checkbox', { name: 'Auto-collapse when away' }).check();
    await note.getByRole('button', { name: 'Done', exact: true }).click();
    await (await captionButton(page, 'Session notebook')).focus();
    await page.mouse.move(1, 1);
    await note.getByRole('textbox').waitFor({ state: 'hidden' });
    await note.locator('.notebook-title button').hover();
    await note.getByRole('textbox').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Session notebook', exact: true }).evaluate(el => el === document.activeElement), true, 'hover expansion does not steal focus');
    await note.getByRole('textbox').focus(); await page.mouse.move(1, 1);
    assert.equal(await note.getByRole('textbox').isVisible(), true, 'typing focus keeps auto-collapse note expanded');
    await note.getByRole('button', { name: 'Close notebook' }).click();
    await (await captionButton(page, 'Session notebook')).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains('notebook-rich-content'));
    assert.equal(await note.getByRole('textbox').isVisible(), true, 'explicit open focuses an auto-collapse note');
    await note.getByRole('button', { name: 'Notebook appearance', exact: true }).click();
    assert.equal(await note.getByRole('checkbox', { name: 'Auto-collapse when away' }).isChecked(), true, 'auto-collapse survives closing the note');
    await note.getByRole('checkbox', { name: 'Auto-collapse when away' }).uncheck();
    await note.getByRole('button', { name: 'Done', exact: true }).click();
    await note.getByRole('button', { name: 'Minimize notebook' }).click(); assert.equal(await note.getByRole('textbox').count(), 0);
    await note.getByRole('button', { name: 'Expand notebook' }).click();
    await note.getByRole('button', { name: 'Close notebook' }).click();
    await (await captionButton(page, 'Session notebook')).click();
    assert.match(await page.getByRole('dialog').getByRole('textbox').innerText(), /小 tip/);
    note = await open(page); assert.match(await note.getByRole('textbox').innerText(), /小 tip/);
    // Another tab can save, but cannot silently overwrite this tab's draft.
    const other = await context.newPage();
    const beforeOtherOpen = writes;
    const otherNote = await open(other);
    await other.waitForTimeout(800);
    assert.equal(writes, beforeOtherOpen, 'loading rich text never writes normalized Markdown');
    await replaceNote(note, 'new first tab'); await note.getByText('Saved to Hub', { exact: true }).waitFor();
    await replaceNote(otherNote, 'second tab draft');
    await otherNote.getByText('Notebook changed elsewhere', { exact: true }).waitFor();
    assert.equal((await otherNote.getByRole('textbox').innerText()).trim(), 'second tab draft');
    await otherNote.getByRole('button', { name: 'Save my draft instead' }).click(); await otherNote.getByText('Saved to Hub', { exact: true }).waitFor();
    await other.close();
    note = await open(page); assert.equal((await note.getByRole('textbox').innerText()).trim(), 'second tab draft');
    offline = true; await replaceNote(note, 'offline draft'); await note.getByText('Notebook unavailable · draft retained', { exact: true }).waitFor();
    offline = false; await note.getByRole('button', { name: 'Retry', exact: true }).click(); await note.getByText('Saved to Hub', { exact: true }).waitFor();
    note = await open(page, keys[1]); assert.equal((await note.getByRole('textbox').innerText()).trim(), '', 'Hermes session owns a separate notebook');
    await note.getByRole('textbox').fill('Hermes tip'); await note.getByText('Saved to Hub', { exact: true }).waitFor();
    // Global notes exist before a session is selected, and do not borrow its identity.
    await note.getByRole('button', { name: 'Close notebook' }).click();
    await page.goto(origin);
    const globalTrigger = page.locator('.notebook-trigger--global').filter({ hasText: 'Global notes' });
    await globalTrigger.click();
    assert.equal(await page.locator('.global-notebook-list .notebook-trigger--global span').first().isVisible(), true, 'global notebook names are visible in the chooser');
    await page.locator('.global-notebook-list').getByRole('button', { name: 'Global notebook', exact: true }).click();
    await page.locator('.global-notebook-manager').getByRole('button', { name: 'Close', exact: true }).click();
    let globalNote = page.getByRole('dialog', { name: 'Global notebook', exact: true });
    await globalNote.getByText('Saved to Hub', { exact: true }).waitFor();
    await globalNote.getByRole('textbox').fill(`global tips ${width}`);
    await globalNote.getByText('Saved to Hub', { exact: true }).waitFor();
    const readsBeforeNavigation = noteReads;
    await page.evaluate(() => { window.location.hash = '#/shared'; });
    await page.getByRole('main', { name: 'Shared grants directory' }).waitFor();
    assert.equal((await globalNote.getByRole('textbox').innerText()).trim(), `global tips ${width}`);
    assert.equal(await globalTrigger.count(), 1, 'global notebook available to shared-directory users');
    assert.equal(noteReads, readsBeforeNavigation, 'switching workspace does not reload global notes');
    await page.evaluate(() => { window.location.hash = '#/tab/sessions'; });
    await page.locator(`[data-session-card="${keys[0]}"]`).waitFor();
    await globalNote.getByRole('button', { name: 'Minimize notebook' }).click();
    await page.locator(`[data-session-card="${keys[0]}"]`).click();
    await globalNote.getByRole('button', { name: 'Expand notebook' }).click();
    assert.equal((await globalNote.getByRole('textbox').innerText()).trim(), `global tips ${width}`, 'global note survives session navigation');
    await globalNote.getByRole('button', { name: 'Close notebook' }).click();
    const sessionNote = page.getByRole('dialog', { name: 'Session notebook', exact: true });
    await sessionNote.getByText('Saved to Hub', { exact: true }).waitFor();
    assert.equal((await sessionNote.getByRole('textbox').innerText()).trim(), 'offline draft', 'global text does not replace session text');
    await sessionNote.getByRole('button', { name: 'Close notebook' }).click();
    await page.reload();
    await globalTrigger.click();
    await page.locator('.global-notebook-list').getByRole('button', { name: 'Global notebook', exact: true }).click();
    await page.locator('.global-notebook-manager').getByRole('button', { name: 'Close', exact: true }).click();
    globalNote = page.getByRole('dialog', { name: 'Global notebook', exact: true });
    await globalNote.getByText('Saved to Hub', { exact: true }).waitFor();
    assert.equal((await globalNote.getByRole('textbox').innerText()).trim(), `global tips ${width}`, 'global note persists across reload');
    await globalNote.locator('.notebook-title button').dblclick();
    await globalNote.getByRole('textbox', { name: 'Notebook name' }).fill('Hub release checklist');
    await globalNote.getByRole('textbox', { name: 'Notebook name' }).press('Enter');
    globalNote = page.getByRole('dialog', { name: 'Hub release checklist', exact: true });
    if (width < 700) {
      assert.equal(await globalNote.evaluate(element => element.classList.contains('is-mobile-dedicated')), true);
      await globalNote.getByRole('button', { name: 'Restore floating notebook', exact: true }).click();
    }
    await globalNote.getByRole('button', { name: 'Resize notebook', exact: true }).press('ArrowDown');
    const globalSize = await globalNote.boundingBox();
    await pasteMarkdown(globalNote, '- [ ] publish\n- [x] test');
    await globalNote.getByRole('checkbox').first().check();
    await globalNote.getByText('Saved to Hub', { exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('.session-notebook [role="status"]')].some(el => el.textContent === 'Saving…'));
    await page.reload();
    globalNote = page.getByRole('dialog', { name: 'Hub release checklist', exact: true });
    await globalNote.getByText('Saved to Hub', { exact: true }).waitFor();
    await globalNote.getByRole('checkbox').first().waitFor();
    assert.equal(await globalNote.getByRole('checkbox').count(), 2);
    assert.equal(await globalNote.getByRole('checkbox').nth(0).isChecked(), true);
    assert.equal(await globalNote.getByRole('checkbox').nth(1).isChecked(), true);
    assert.equal((await globalNote.boundingBox()).height, globalSize.height, 'global resize persists to Hub');
    await globalNote.locator('.notebook-title button').dblclick();
    await globalNote.getByRole('textbox', { name: 'Notebook name' }).fill('');
    await globalNote.getByRole('textbox', { name: 'Notebook name' }).press('Enter');
    globalNote = page.getByRole('dialog', { name: 'Global notebook', exact: true });
    if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, `global-notebook-${width}.png`) });
    if (width >= 1000) await verifyNotebookDocking(page, () => ({ reads: noteReads, writes, layoutWrites }));
    await globalNote.getByRole('button', { name: 'Close notebook' }).click();
    note = await open(page, keys[1]);
    assert.equal(archiveReads, 0, 'cold archive is not fetched by notebook loads, docking or list reads');
    const hotText = await note.locator('.notebook-rich-content').innerText();
    await note.locator('.notebook-archive-toggle > summary').click();
    const archive = note.getByRole('textbox', { name: 'Notebook archive', exact: true });
    await archive.waitFor();
    await verifyArchiveSplit(page, note, note.locator('.notebook-rich-editor'));
    await archive.fill('cold-only 文'.repeat(100));
    await archive.blur();
    await note.locator('.notebook-archive').getByText('Saved', { exact: true }).waitFor();
    assert.equal(archiveWrites, 1); assert.equal(archiveReads, 1);
    assert.equal(await note.locator('.notebook-rich-content').innerText(), hotText, 'archive edit cannot change main note');
    await note.locator('.notebook-archive-toggle > summary').click();
    await note.locator('.notebook-archive-toggle > summary').click();
    assert.equal(await archive.inputValue(), 'cold-only 文'.repeat(100));
    assert.equal(archiveReads, 1, 'closing and reopening retains the same draft controller');
    await note.locator('.notebook-archive-toggle > summary').click();
    if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, `notebook-${width}.png`) });
    // Shrinking viewport models keyboard/rotation; text does not overflow horizontally.
    await page.setViewportSize({ width: 390, height: 320 });
    await page.waitForFunction(() => !document.querySelector('.desktop-workspace-shell'));
    // The existing mobile shell returns to its list at the desktop breakpoint.
    // Reopening the same session must restore its floating notebook and content.
    if (!await page.getByRole('button', { name: 'Session notebook', exact: true }).count()) await page.locator(`[data-session-card="${keys[1]}"]`).click();
    await page.waitForFunction(() => { const n = document.querySelector('.session-notebook')?.getBoundingClientRect(); return n && n.y >= 0 && n.bottom <= innerHeight + 1; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(() => { localStorage.setItem('agentopsdeck.locale', 'zh-CN'); window.dispatchEvent(new StorageEvent('storage', { key: 'agentopsdeck.locale' })); });
    await page.getByRole('dialog', { name: '会话记事本', exact: true }).getByText('已保存到 Hub', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole('dialog', { name: '会话记事本', exact: true }).getByRole('button', { name: '收起记事本', exact: true }).click();
    // Keyboard activation also works when the floating session note covers the toolbar.
    await page.locator('.notebook-trigger--global').filter({ hasText: '全局笔记' }).focus();
    await page.locator('.notebook-trigger--global').filter({ hasText: '全局笔记' }).press('Enter');
    await page.locator('.global-notebook-list').getByRole('button', { name: '全局记事本', exact: true }).click();
    await page.getByRole('dialog', { name: '全局记事本', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await page.waitForFunction(() => document.querySelectorAll('.session-notebook').length === 0);
    assert.equal(await page.getByRole('button', { name: '全局记事本', exact: true }).count(), 0, 'private notebooks hidden on auth expiry');
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
    console.log(`Notebook browser ${width}px: real Hub rich text/TODO save/reload, title drag/rename, resize, auto-collapse/hover/focus, keyboard, conflict, offline recovery, global/session and Codex/Hermes isolation passed`);
    await context.close();
    routes?.close(); routes = undefined; hub.close(); hub = undefined;
  }
} finally { await browser?.close(); await server.close(); routes?.close(); hub?.close(); await rm(directory, { recursive: true, force: true }); }
