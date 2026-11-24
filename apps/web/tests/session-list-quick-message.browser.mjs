// Real Hub preferences + SQLite, synthetic delivery ACKs. Never contacts a native Agent.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-quick-message-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const app = new Hono(), principal = { userId: 'default', admin: true };
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw new Error('No Connector calls allowed'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = await createServer({ root: process.env.AOD_TEST_WEB_ROOT ?? fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: process.env.AOD_TEST_WEB_ROOT ? [] : [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390]) {
    const keys = ['idle', 'busy', 'loose'].map(name => encodeHubSessionId('local', `codex:${name}-${width}`));
    const preferences = hub.workspace;
    assert.ok(preferences, 'workspace store available');
    preferences.save('default', { revision: preferences.get('default').revision, groups: [{ id: 'work', name: 'Work' }], sessions: { [keys[0]]: { groupId: 'work' }, [keys[1]]: { groupId: 'work' } } });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    let delivery = 'accepted', historyReads = 0, releaseSend;
    const pins = new Set();
    const posts = [], errors = [];
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname.endsWith('/pin') && req.method() === 'PATCH') {
        const key = decodeURIComponent(url.pathname.split('/').at(-2));
        if (req.postDataJSON().pinned) pins.add(key); else pins.delete(key);
        return json({ ok: true, sessionKey: key, pinned: pins.has(key) });
      }
      if (url.pathname.endsWith('/workspace/preferences')) {
        const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      if (url.pathname.endsWith('/messages') && req.method() === 'POST') {
        const body = req.postDataJSON(); posts.push({ path: url.pathname, body });
        if (delivery === 'delayed') await new Promise(resolve => { releaseSend = resolve; });
        if (delivery === 'unknown' || delivery === 'rejected') return route.fulfill({ status: 503, json: { error: 'Synthetic failed response' } });
        return json({ status: 'queued', idempotencyKey: body.idempotencyKey, admission: { createdAt: Date.now(), queueVersion: '1', disposition: delivery === 'queued' ? 'waiting' : 'preparing' } });
      }
      if (url.pathname.includes('/commands/')) return delivery === 'rejected'
        ? json({ command: { key: decodeURIComponent(url.pathname.split('/').at(-1)), state: 'rejected' } })
        : route.fulfill({ status: 503, json: { error: 'Synthetic unknown' } });
      if (req.method() !== 'GET') throw new Error(`Unexpected mutation ${req.method()} ${url.pathname}`);
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: `1:${[...pins].join(',')}`, groups: [{ agentId: 'codex', sessions: keys.map((sessionKey, index) => ({ sessionKey, pinned: pins.has(sessionKey), envConnectionId: 'local', source: 'codex', agentId: 'codex', title: ['Idle target', 'Busy target', 'Loose target'][index], status: index === 1 ? 'running' : 'idle' })) }] });
      if (url.pathname.endsWith('/messages')) {
        // Visible cards warm the bounded eight-message hover cache. Opening a
        // chat would request full history; quick send must still never do that.
        if (url.searchParams.get('limit') !== '8' || url.searchParams.has('before')) historyReads++;
        return json({ messages: [], totalCount: 0, hiddenCount: 0 });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const card = key => page.locator(`[data-session-card="${key}"]`);
    await page.goto(origin); await card(keys[0]).waitFor();
    const work = page.getByRole('region', { name: 'Work', exact: true });
    const ungrouped = page.getByRole('region', { name: 'Ungrouped', exact: true });
    await work.getByRole('button', { name: 'Work 2', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Work"] [data-session-card]'));
    await page.reload(); await work.getByRole('button', { name: 'Work 2', exact: true }).waitFor();
    assert.equal(await work.locator('[data-session-card]').count(), 0);
    await ungrouped.getByRole('button', { name: 'Ungrouped 1', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Ungrouped"] [data-session-card]'));
    await page.reload(); await work.getByRole('button', { name: 'Work 2', exact: true }).waitFor();
    assert.equal(await ungrouped.locator('[data-session-card]').count(), 0);
    await work.getByRole('button', { name: 'Work 2', exact: true }).click(); await card(keys[0]).waitFor();
    await page.getByRole('button', { name: 'Flat view', exact: true }).click(); await card(keys[2]).waitFor();
    await page.getByRole('button', { name: 'Show groups', exact: true }).click(); assert.equal(await card(keys[2]).count(), 0);
    // Right-click opens only a lightweight composer; the route and history remain untouched.
    const originalUrl = page.url();
    async function openQuick(key) {
      await card(key).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Quick message', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Quick message', exact: true });
      await dialog.getByRole('textbox').waitFor(); return dialog;
    }
    let dialog = await openQuick(keys[0]);
    await dialog.getByRole('textbox').fill('hello idle');
    delivery = 'delayed'; await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.quick-message-status')?.textContent === 'Sending…');
    await dialog.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    while (!releaseSend) await new Promise(resolve => setTimeout(resolve, 10));
    releaseSend(); await dialog.getByText('Message accepted · no need to open the conversation', { exact: true }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].body.message, 'hello idle'); assert.ok(posts[0].path.includes(encodeURIComponent(keys[0])));
    assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    delivery = 'queued'; dialog = await openQuick(keys[1]); await dialog.getByRole('textbox').fill('hello busy'); await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByText('Queued · waiting for the current run', { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    delivery = 'rejected'; dialog = await openQuick(keys[0]); await dialog.getByRole('textbox').fill('keep rejected draft'); await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByRole('alert').waitFor(); assert.equal(await dialog.getByRole('textbox').inputValue(), 'keep rejected draft'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    delivery = 'unknown'; dialog = await openQuick(keys[0]); await dialog.getByRole('textbox').fill('uncertain only once'); await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByText('Delivery not confirmed. Check Delivery recovery; do not resend.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).count(), 0);
    if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, `quick-message-${width}.png`) });
    assert.equal(historyReads, 0); assert.equal(page.url(), originalUrl); assert.equal(posts.length, 4); assert.equal(new Set(posts.map(p => p.body.idempotencyKey)).size, 4);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    // Collapsed groups remain drop targets; dropping must not unexpectedly expand them.
    await work.getByRole('button', { name: 'Work 2', exact: true }).click();
    await ungrouped.getByRole('button', { name: 'Ungrouped 1', exact: true }).click(); await card(keys[2]).waitFor();
    const drag = await page.evaluateHandle(() => new DataTransfer());
    await card(keys[2]).locator('xpath=ancestor::*[@draggable="true"][1]').dispatchEvent('dragstart', { dataTransfer: drag });
    await work.dispatchEvent('dragover', { dataTransfer: drag }); assert.match(await work.getAttribute('class'), /session-workspace-group--drop/);
    await work.dispatchEvent('drop', { dataTransfer: drag });
    await work.getByRole('button', { name: 'Work 3', exact: true }).waitFor(); assert.equal(await work.locator('[data-session-card]').count(), 0);
    await work.getByRole('button', { name: 'Work 3', exact: true }).click(); await card(keys[2]).waitFor();
    // A grouped pin and an ungrouped pin both escape collapsed groups, without duplication.
    pins.add(keys[0]); pins.add(keys[1]);
    const beforePin = preferences.get('default');
    beforePin.groups[0].collapsed = true; beforePin.ungroupedCollapsed = true;
    delete beforePin.sessions[keys[1]].groupId;
    preferences.save('default', beforePin);
    await page.reload();
    const pinned = page.getByRole('region', { name: 'Pinned sessions', exact: true });
    await pinned.locator(`[data-session-card="${keys[0]}"]`).waitFor();
    assert.equal(await pinned.locator('[data-session-card]').count(), 2);
    assert.equal(await card(keys[0]).count(), 1);
    assert.equal(await work.locator('[data-session-card]').count(), 0);
    assert.equal(await page.locator('.session-workspace-group').first().getAttribute('aria-label'), 'Pinned sessions');
    await page.getByRole('button', { name: 'Flat view', exact: true }).click();
    assert.equal(await page.locator('.session-workspace-group').first().getAttribute('aria-label'), 'Pinned sessions');
    assert.equal(await card(keys[0]).count(), 1);
    await page.getByRole('button', { name: 'Show groups', exact: true }).click();
    const pinDrag = await page.evaluateHandle(() => new DataTransfer());
    await card(keys[0]).locator('xpath=ancestor::*[@draggable="true"][1]').dispatchEvent('dragstart', { dataTransfer: pinDrag });
    await pinned.dispatchEvent('dragover', { dataTransfer: pinDrag });
    assert.match(await pinned.getAttribute('class'), /session-workspace-group--drop/);
    await pinned.dispatchEvent('drop', { dataTransfer: pinDrag });
    await page.waitForFunction(key => document.querySelector('.session-pinned-group [data-session-card]')?.getAttribute('data-session-card') === key, keys[1]);
    await page.reload();
    await pinned.locator(`[data-session-card="${keys[1]}"]`).waitFor();
    await page.waitForFunction(() => document.querySelector('.session-organization-toolbar button')?.disabled === false);
    assert.equal(await pinned.locator('[data-session-card]').first().getAttribute('data-session-card'), keys[1], 'pin order persists');
    assert.equal(preferences.get('default').sessions[keys[0]].groupId, 'work', 'reorder retains membership');
    if (width >= 1000) {
      await card(keys[0]).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Unpin session/ }).click();
    } else {
      // Mobile pin controls live in chat detail. Model another view unpinning
      // without opening history in this list-only regression.
      pins.delete(keys[0]); await page.reload();
    }
    await work.getByRole('button', { name: 'Work 2', exact: true }).waitFor();
    assert.equal(await card(keys[0]).count(), 0, 'unpin restores its collapsed original group');
    assert.equal(preferences.get('default').sessions[keys[0]].groupId, 'work');
    await work.getByRole('button', { name: 'Work 2', exact: true }).click();
    await card(keys[0]).waitFor();
    await page.evaluate(() => { localStorage.setItem('agentopsdeck.locale', 'zh-CN'); window.dispatchEvent(new StorageEvent('storage', { key: 'agentopsdeck.locale', newValue: 'zh-CN' })); });
    await card(keys[0]).click({ button: 'right' }); await page.getByRole('menuitem', { name: '快速消息', exact: true }).click();
    await page.getByRole('dialog', { name: '快速消息', exact: true }).getByRole('textbox', { name: '快速消息内容' }).waitFor();
    assert.equal(historyReads, 0);
    assert.deepEqual(errors, []);
    await context.close(); console.log(`Session list ${width}px: persisted collapse, flat view, quick admission/queue/rejection/unknown, duplicate guard, no full-history reads (bounded preview prefetch allowed) passed`);
  }
} finally { await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true }); }
