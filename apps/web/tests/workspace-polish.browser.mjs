// Production assets, isolated SQLite and synthetic sessions; no live services.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
import { checkSavedLayoutBar } from './fixtures/saved-layout-bar.mjs';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-workspace-polish-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const principal = { userId: 'default', admin: true }, app = new Hono();
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('No real Connector'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const keys = ['one', 'two', 'three'].map(id => encodeHubSessionId('local', `codex:${id}`));
const initial = presetWorkspace(keys.slice(0, 2).map((sessionKey, i) => ({ id: `p${i}`, sessionKey })), 'columns');
const notes = presetWorkspace([{ id: 'note', kind: 'notebook', target: 'hub', resourceId: 'default' }], 'single');
const saved = [{ id: 'sessions', name: 'Sessions', workspace: initial, collapsedKeys: [] }, { id: 'notes', name: 'Notes', workspace: notes, collapsedKeys: [] }];
hub.layouts.save('default', 'current', { revision: 0, content: JSON.stringify(layoutSnapshot(initial, new Set())) });
hub.layouts.save('default', 'saved', { revision: 0, content: JSON.stringify(saved) });
const text = `# Wrapping\n\nhttps://example.invalid/${'long'.repeat(120)}\n\n\`\`\`text\n${'code'.repeat(150)}\n\`\`\`\n\n| Column | Other |\n| --- | --- |\n| ${'cell'.repeat(100)} | value |\n\n- [ ] Task\n\n${Array.from({ length: 90 }, (_, i) => `Paragraph ${i} — scroll without chrome.`).join('\n\n')}`;
hub.notebooks.save('default', { resourceId: '["hub-notebook",1]', text, revision: 0 });
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  const errors = [], forbidden = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/') || url.pathname.startsWith('/api/hub/v1/notebook')) {
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    const json = body => route.fulfill({ json: body });
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: keys.map((sessionKey, i) => ({ sessionKey, envConnectionId: 'local', source: 'codex', agentId: 'codex', title: `Session ${i + 1}`, status: 'idle' })) }] });
    if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 1, hiddenCount: 0, messages: [{ id: 'message', role: 'assistant', text: 'Stable history', createdAt: 1, status: 'sent' }] });
    if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const strip = page.getByRole('navigation', { name: 'Switch saved layout', exact: true });
  await strip.getByRole('button', { name: 'Notes', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  assert.equal((await strip.boundingBox()).height, 32, '32px layout strip');
  await checkSavedLayoutBar(page, hub, keys);
  const docked = page.locator('[data-workspace-pane][data-floating="false"]');
  const secondPane = docked.nth(1);
  await secondPane.locator('.desktop-composer-textarea').waitFor({ state: 'attached' });
  // Closed caption popovers retain geometry for width measurement. They must
  // not act like an open modal and disable hover across the entire workspace.
  assert.ok(await page.locator('.caption-overflow-content[popover]:not(:popover-open)').count());
  const secondRect = await secondPane.boundingBox();
  await page.mouse.move(secondRect.x + secondRect.width / 2, secondRect.y + secondRect.height / 2);
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]')[1]?.dataset.active === 'true');
  await page.mouse.move(secondRect.x + secondRect.width / 2, secondRect.y + secondRect.height - 45);
  await page.waitForFunction(() => document.activeElement?.matches('[data-workspace-pane][data-active="true"] .desktop-composer-textarea'));
  // Upward reading hides the composer; returning to the bottom must reopen it.
  const transcript = secondPane.locator('.message-selection-surface');
  const transcriptRect = await transcript.boundingBox();
  await page.mouse.move(transcriptRect.x + 30, transcriptRect.y + 80);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(() => document.querySelector('[data-workspace-pane][data-active="true"]')?.dataset.composerReading === 'true');
  await page.mouse.move(secondRect.x + secondRect.width / 2, secondRect.y + secondRect.height - 45);
  await page.waitForFunction(() => document.activeElement?.matches('[data-workspace-pane][data-active="true"]:not([data-composer-reading]) .desktop-composer-textarea'));
  const firstRect = await docked.first().boundingBox();
  const enterFirst = () => page.mouse.move(firstRect.x + 35, firstRect.y + firstRect.height / 2);
  const activeId = await secondPane.getAttribute('data-remote-pane');
  await secondPane.locator('.caption-overflow > button').click();
  await page.waitForFunction(() => !!document.querySelector('.caption-overflow-content:popover-open'));
  await enterFirst(); await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-workspace-pane][data-active="true"]').getAttribute('data-remote-pane'), activeId, 'open popover still blocks hover');
  await page.keyboard.press('Escape');
  await transcript.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); });
  await page.mouse.move(firstRect.x + 40, firstRect.y + firstRect.height / 2); await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-workspace-pane][data-active="true"]').getAttribute('data-remote-pane'), activeId, 'selection is never interrupted');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await secondPane.locator('.desktop-composer-textarea').dispatchEvent('compositionstart');
  await enterFirst(); await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-workspace-pane][data-active="true"]').getAttribute('data-remote-pane'), activeId, 'IME composition is never interrupted');
  await secondPane.locator('.desktop-composer-textarea').dispatchEvent('compositionend');
  await page.mouse.move(firstRect.x + 45, firstRect.y + firstRect.height / 2);
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]')[0]?.dataset.active === 'true');
  assert.equal(await secondPane.locator('.desktop-composer-textarea').evaluate(el => el === document.activeElement), false, 'old composer cannot keep the keyboard after pane activation');
  // Nothing is sent: plain typing after activation reveals only the active pane.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.type('draft');
  assert.equal(await docked.first().locator('.desktop-composer-textarea').inputValue(), 'draft');
  await docked.first().locator('.desktop-composer-textarea').fill('');
  // Leave the typing zone without changing pane geometry or stealing selection.
  await page.mouse.move(5, 5);
  await secondPane.locator('.desktop-composer-textarea').evaluate(el => el.blur());
  const before = await docked.evaluateAll(nodes => nodes.map(node => ({ rect: node.getBoundingClientRect().toJSON(), id: node.dataset.remotePane })));
  await page.evaluate(() => { window.retainedHosts = [...document.querySelectorAll('[data-workspace-pane]')]; });
  for (const name of ['Browser card', 'Connector terminal']) {
    await page.getByLabel('Layout presets', { exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    const added = page.locator('[data-workspace-pane][data-floating="true"]');
    await added.waitFor();
    assert.deepEqual(await docked.evaluateAll(nodes => nodes.map(node => ({ rect: node.getBoundingClientRect().toJSON(), id: node.dataset.remotePane }))), before, `${name} cannot move existing panes`);
    assert.equal(await page.evaluate(() => window.retainedHosts.every(node => node.isConnected)), true);
    await added.getByRole('button', { name: 'Close pane', exact: true }).click();
    await added.waitFor({ state: 'detached' });
  }
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Add session card', exact: true }).selectOption(keys[2]);
  await page.locator('[data-workspace-pane][data-floating="true"]').waitFor();
  assert.deepEqual(await docked.evaluateAll(nodes => nodes.map(node => ({ rect: node.getBoundingClientRect().toJSON(), id: node.dataset.remotePane }))), before, 'new session never changes existing geometry');
  assert.equal(await page.evaluate(() => window.retainedHosts.every(node => node.isConnected)), true, 'existing controllers retained');
  await strip.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  assert.equal(await page.evaluate(() => window.retainedHosts.every(node => node.isConnected)), true, 'layout switching reuses existing session hosts');
  await page.locator(`[data-session-card="${keys[2]}"]`).click();
  await page.locator('[data-workspace-pane][data-floating="true"]').waitFor();
  assert.equal(await docked.count(), 2, 'sidebar navigation also adds a float rather than replacing a docked session');
  assert.equal(await page.evaluate(() => window.retainedHosts.every(node => node.isConnected)), true);
  await strip.getByRole('button', { name: 'Notes', exact: true }).click();
  const editor = page.locator('.notebook-rich-content'); await editor.waitFor();
  await editor.hover();
  await page.waitForFunction(() => document.activeElement?.matches('.notebook-rich-content[contenteditable="true"]'));
  await editor.getByText('Paragraph 89 — scroll without chrome.', { exact: true }).waitFor({ state: 'attached' });
  async function checkNotebook() {
    const measure = await editor.evaluate(el => {
      const parent = el.parentElement;
      parent.scrollTop = 0;
      return { hidden: getComputedStyle(parent).scrollbarWidth, scrollable: parent.scrollHeight > parent.clientHeight,
        overflow: parent.scrollWidth - parent.clientWidth, codeWrap: getComputedStyle(el.querySelector('pre')).whiteSpace,
        codeOverflow: el.querySelector('pre').scrollWidth - el.querySelector('pre').clientWidth };
    });
    assert.equal(measure.hidden, 'none'); assert.equal(measure.scrollable, true);
    assert.ok(measure.overflow <= 1, JSON.stringify(measure)); assert.ok(measure.codeOverflow <= 1, JSON.stringify(measure));
    assert.equal(measure.codeWrap, 'pre-wrap');
    const rect = await editor.locator('..').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.wheel(0, 420);
    await page.waitForFunction(() => document.querySelector('.notebook-rich-content').parentElement.scrollTop > 0);
    await editor.click(); await page.keyboard.press('Control+End');
    await page.waitForFunction(() => { const el = document.querySelector('.notebook-rich-content').parentElement; return el.scrollTop > el.scrollHeight - el.clientHeight - 100; });
  }
  await checkNotebook();
  // A docked notebook is background content during session Focus, not an overlay.
  await page.locator(`[data-session-card="${keys[0]}"]`).click();
  const focusSession = page.locator('[data-workspace-pane][data-notebook="false"]').first();
  const fixedNote = page.locator('[data-workspace-pane][data-notebook="true"]');
  await focusSession.getByRole('button', { name: 'Maximize pane', exact: true }).click();
  assert.equal(await focusSession.getAttribute('data-maximized'), 'true');
  const z = await page.evaluate(() => ({
    note: +getComputedStyle(document.querySelector('[data-workspace-pane][data-notebook="true"]')).zIndex,
    focus: +getComputedStyle(document.querySelector('[data-maximized="true"]')).zIndex,
    scrim: +getComputedStyle(document.querySelector('.pane-maximize-scrim')).zIndex,
  }));
  assert.ok(z.note < z.scrim && z.scrim < z.focus, JSON.stringify(z));
  assert.equal(await focusSession.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), true, 'the enlarged session, not the docked notebook, receives pointer input');
  await focusSession.getByRole('button', { name: 'Restore pane', exact: true }).click();
  await focusSession.getByRole('button', { name: 'Close pane', exact: true }).click();
  assert.equal(await fixedNote.getAttribute('data-floating'), 'false');
  await page.getByRole('button', { name: 'Float pane', exact: true }).click();
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Add session card', exact: true }).selectOption(keys[1]);
  await focusSession.getByRole('button', { name: 'Maximize pane', exact: true }).click();
  assert.equal(await fixedNote.getAttribute('data-floating'), 'true');
  assert.ok(await fixedNote.evaluate(el => +getComputedStyle(el).zIndex) > await focusSession.evaluate(el => +getComputedStyle(el).zIndex), 'explicitly floating notebooks retain their overlay behavior');
  await focusSession.getByRole('button', { name: 'Restore pane', exact: true }).click();
  await focusSession.getByRole('button', { name: 'Close pane', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 800 });
  await checkNotebook();
  assert.equal(hub.notebooks.get('default', '["hub-notebook",1]').text, text, 'wrap and scrolling do not rewrite content');
  await page.reload(); await strip.getByRole('button', { name: 'Sessions', exact: true }).waitFor();
  await page.locator('[data-workspace-pane][data-floating="true"] .notebook-rich-content').waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ verified: true, compactLayoutSwitch: true, floatingPreservesDock: true, notebookWrapAndNativeScrolling: true, accountRestore: true, dockedNotebookBehindFocus: true, floatingNotebookAboveFocus: true }));
} finally { await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true }); }
