// Built production workspace entry points; real isolated Hub, no native/model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url)), { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const dir = await mkdtemp(join(tmpdir(), 'quick-workspace-')), hub = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
const principal = { userId: 'default', admin: true }, app = new Hono();
hub.layouts.save('default', 'saved', { revision: 0, content: JSON.stringify([{ id: 'unread-fixture', name: 'History', collapsedKeys: [], workspace: presetWorkspace([{ id: 'old', sessionKey: 'old-session' }], 'single') }]) });
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: dir, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('No native calls allowed'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = await preview({ root: process.env.AOD_TEST_WEB_ROOT, configFile: false, envFile: false,
  build: { outDir: process.env.AOD_TEST_WEB_ROOT }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1' });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.fixtureDeckStreams = [];
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); window.fixtureDeckStreams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    const errors = [], forbidden = []; let quickReads = 0, unreadMode = 'missing', unreadReads = 0;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = data => route.fulfill({ json: data });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname === '/api/hub/v1/completions/summary') {
        unreadReads++;
        if (unreadMode === 'failure') return route.fulfill({ status: 503, json: { error: 'Synthetic outage' } });
        return json({ items: unreadMode === 'missing' ? [] : [{ sessionKey: 'old-session', displayTarget: 'old', generation: 'one', latestSequence: 1, readThrough: unreadMode === 'read' ? 1 : 0, unread: unreadMode !== 'read', coverage: unreadMode === 'read' ? 'observed' : unreadMode }] });
      }
      if (url.pathname.startsWith('/api/hub/v1/quick-chat')) { quickReads++; assert.equal(req.method(), 'GET'); }
      else if (!url.pathname.startsWith('/api/hub/v1/workspace/') && !url.pathname.startsWith('/api/hub/v1/notebooks') && req.method() !== 'GET') {
        forbidden.push(req.method() + ' ' + url.pathname); return route.abort();
      }
      const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
    await page.goto(origin);
    const buildLabel = page.locator('.app-build-label');
    await buildLabel.waitFor();
    assert.match(await buildLabel.innerText(), /v2\.3\.6/);
    assert.match(await buildLabel.innerText(), /26\.1009\d{1,2}/);
    assert.match(await buildLabel.getAttribute('aria-label'), /Version 2\.3\.6 · Build number/);
    const labelBox = await buildLabel.boundingBox();
    const stripBox = await page.locator('.saved-layouts-strip').boundingBox();
    assert.ok(labelBox && stripBox && labelBox.x >= stripBox.x && labelBox.x + labelBox.width <= width + 1, 'Build label remains visible at desktop and narrow widths');
    assert.ok(stripBox.height <= 34, 'Build label preserves compact layout bar');
    const trigger = page.getByRole('button', { name: 'Quick question', exact: true }); await trigger.waitFor();
    const unreadStatus = page.getByRole('button', { name: 'Unread status', exact: true });
    await page.getByTitle('Unread history is partial', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark active session read', exact: true }).isDisabled(), true);
    assert.equal(await unreadStatus.innerText(), '', 'no misleading question mark');
    await unreadStatus.click(); await page.getByText(/not a service failure/).waitFor();
    unreadMode = 'gap'; let before = unreadReads; await unreadStatus.click();
    await page.waitForFunction(() => document.querySelector('.saved-layout-unread')?.textContent === '1');
    assert.ok(unreadReads > before); assert.equal(await unreadStatus.getAttribute('title'), 'Unread history is partial');
    unreadMode = 'failure'; await unreadStatus.click(); await page.getByTitle('Unread status unavailable', { exact: true }).waitFor();
    unreadMode = 'observed'; await unreadStatus.click(); await page.getByText(/Retrying; existing counts/).waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Unread status"]')?.title === 'Observed unread completions');
    await page.locator('.saved-layout-feedback').getByRole('button', { name: 'Dismiss' }).click();
    // Real application/shared SSE wiring and saved-layout badge: the current
    // layout is empty, so no session pane can retain the feed for us.
    unreadMode = 'read'; await unreadStatus.click();
    await page.waitForFunction(() => !document.querySelector('.saved-layout-unread'));
    assert.equal(await page.locator('[data-workspace-pane]').count(), 0);
    await page.waitForFunction(() => window.fixtureDeckStreams?.some(stream => stream.readyState === 1));
    before = unreadReads; unreadMode = 'observed';
    await page.evaluate(() => {
      const event = { id: 'fixture-completed', type: 'run.completed', ts: Date.now(), hubSessionId: 'old-session', payload: {} };
      for (const stream of window.fixtureDeckStreams.filter(stream => stream.readyState === 1)) stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    });
    await page.waitForFunction(() => document.querySelector('.saved-layout-unread')?.textContent === '1', null, { timeout: 2500 });
    assert.ok(unreadReads > before, 'inactive saved layout completion refreshes before the 15-second poll');
    assert.equal(await page.getByRole('button', { name: 'Mark active session read', exact: true }).isDisabled(), true);
    await page.locator('.saved-layout-feedback').getByRole('button', { name: 'Dismiss' }).click();
    assert.match(await trigger.innerText(), /Ask/, 'toolbar exposes a compact named entry');
    const quickBox = await trigger.boundingBox(), boardBox = await page.getByRole('button', { name: 'Task boards', exact: true }).boundingBox();
    assert.ok(quickBox.y + quickBox.height <= boardBox.y || quickBox.x + quickBox.width <= boardBox.x, 'named toolbar entries do not overlap');
    assert.ok(await trigger.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1), 'label stays inside its hit target');
    const inset = await page.locator('.session-workspace-surface').evaluate(el => ({ left: getComputedStyle(el).marginLeft, right: getComputedStyle(el).marginRight }));
    assert.deepEqual(inset, { left: '8px', right: '8px' });
    assert.equal(quickReads, 0, 'closed feature performs no model/profile reads');
    await trigger.click(); const dialog = page.getByRole('dialog', { name: 'Temporary chat', exact: true });
    await dialog.getByText('No standalone model configured for this account.').waitFor();
    await dialog.getByRole('button', { name: 'Model and profiles', exact: true }).click();
    await dialog.getByRole('region', { name: 'Model and profiles' }).waitFor();
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: `/tmp/agentopsdeck-quick-question-${width}.png` });
    assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const extra of [{ repeat: true }, { isComposing: true }, { altKey: true }]) {
      await page.evaluate(extra => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, shiftKey: true, ...extra })), extra);
      assert.equal(await dialog.count(), 0);
    }
    await page.keyboard.press('Control+Shift+K'); await dialog.waitFor();
    await page.keyboard.press('Control+Shift+K'); assert.equal(await dialog.count(), 1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.session-workspace-surface').click({ button: 'right', position: { x: 8, y: 8 } });
    assert.equal(await page.locator('.workspace-context-menu').getByRole('button', { name: 'Quick question', exact: true }).evaluate(el => getComputedStyle(el).display), 'flex');
    await page.locator('.workspace-context-menu').getByRole('button', { name: 'Quick question', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
    console.log(JSON.stringify({ width, buildLabel: true, quickReads, inactiveLayoutRealtimeUnread: true, emptyLayoutRetainsFeed: true, toolbar: true, contextMenu: true, shortcut: true, compositionGuards: true, noNativeCalls: true, authCloses: true }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); await routes.close(); hub.close(); await rm(dir, { recursive: true, force: true }); }
