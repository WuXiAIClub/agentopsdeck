// Real Hub-private note/layout routes and SQLite; synthetic chat/command transport.
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
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-peek-workspace-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const app = new Hono(), principal = { userId: 'default', admin: true };
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('No Connector calls'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = await createServer({ root: process.env.AOD_TEST_WEB_ROOT ?? fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: process.env.AOD_TEST_WEB_ROOT ? [] : [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    // Separate authenticated users keep viewport fixtures independent while
    // exercising the same Hub database and principal-scoped storage.
    principal.userId = `peek-${width}`;
    let offline = false, delivery = 'accepted', slowPreview = true; const errors = [], posts = [], reads = [], previewKeys = [];
    const keys = ['one', 'two'].map(name => encodeHubSessionId('local', `codex:${name}-${width}`));
    const sessions = keys.map((sessionKey, index) => ({ sessionKey, agentId: 'codex', source: 'codex', title: index ? 'Other session' : 'Preview target', recent: 'Last known session summary', status: 'idle', envConnectionId: 'local' }));
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      const streams = [];
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      window.peekFixtureEvent = event => streams.filter(stream => stream.readyState === 1).forEach(stream => stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })));
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname.includes('/notebooks') || url.pathname.endsWith('/workspace/preferences')) {
        if (offline) return route.fulfill({ status: 503, json: { error: 'Offline fixture' } });
        const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      if (url.pathname.endsWith('/messages') && req.method() === 'POST') {
        posts.push(req.postDataJSON()); return json({ status: 'queued', admission: { createdAt: Date.now(), queueVersion: '1', disposition: delivery === 'queued' ? 'waiting' : 'preparing' } });
      }
      if (req.method() !== 'GET') throw Error(`Unexpected write ${url.pathname}`);
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions }] });
      if (url.pathname.endsWith('/messages')) { reads.push(url.search);
        if (url.searchParams.get('limit') === '8') {
          previewKeys.push(decodeURIComponent(url.pathname.split('/').at(-2)));
          if (slowPreview) await new Promise(resolve => setTimeout(resolve, 3000));
        }
        return json({ revision: '1', limits: { maxMessageChars: 100000 }, messages: [
        { id: 'user', role: 'user', text: 'A short question', timestamp: 1 }, { id: 'tool', role: 'tool', text: 'Tool body must not render', timestamp: 2 },
        { id: 'assistant', role: 'assistant', text: 'Finished result preview', timestamp: 3 }], totalCount: 3, hiddenCount: 0 }); }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto(origin); const card = page.locator(`[data-session-card="${keys[0]}"]`); await card.waitFor();
    if (width === 1440) {
      // Visible cards warm before hover; a slow Connector never leaves the panel
      // blank while its existing session summary is available.
      await page.waitForTimeout(1600);
      assert.ok(previewKeys.includes(keys[1]), 'visible remote card prefetched before hover');
      const otherCard = page.locator(`[data-session-card="${keys[1]}"]`);
      await otherCard.hover();
      const initialPeek = page.getByRole('dialog', { name: 'Session preview', exact: true });
      await initialPeek.getByText('Last known session summary', { exact: true }).waitFor();
      assert.equal(await initialPeek.getByText('Reading latest messages…', { exact: true }).count(), 0);
      await initialPeek.getByText('Finished result preview', { exact: true }).waitFor();
      assert.equal(previewKeys.filter(key => key === keys[1]).length, 1, 'hover joins prefetch instead of rereading');
      slowPreview = false;
      const hoverPreview = page.getByRole('dialog', { name: 'Session preview', exact: true });
      await card.hover();
      await card.click({ button: 'right' });
      await page.getByRole('menu').waitFor();
      await page.waitForTimeout(750);
      assert.equal(await hoverPreview.count(), 0, 'right-click cancels pending hover');
      // The menu overlaps the card centre; use its still-exposed left edge.
      await otherCard.hover({ position: { x: 8, y: 8 } });
      await page.waitForTimeout(750);
      assert.equal(await hoverPreview.count(), 0, 'menu blocks preview on other cards');
      await page.mouse.click(1000, 30);
      await card.focus(); await card.hover();
      const peek = page.getByRole('dialog', { name: 'Session preview', exact: true });
      await peek.getByText('Finished result preview', { exact: true }).waitFor();
      if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, 'peek-hover.png') });
      assert.equal(await card.evaluate(element => element === document.activeElement), true, 'hover never steals focus');
      assert.equal(await peek.getByText('Tool body must not render').count(), 0); assert.ok(reads.includes('?limit=8'));
      await otherCard.hover();
      await peek.locator('header strong').filter({ hasText: 'Other session' }).waitFor();
      assert.equal(await peek.count(), 1, 'only one hover preview is visible');
      assert.equal(previewKeys.filter(key => key === keys[1]).length, 1, 'reopening a fresh preview does not fetch');
      await card.hover();
      await peek.locator('header strong').filter({ hasText: 'Preview target' }).waitFor();
      await card.click({ button: 'right' });
      await page.getByRole('menu').waitFor();
      assert.equal(await peek.count(), 0, 'right-click immediately closes an open preview');
      await page.mouse.click(1000, 30);
      await card.hover();
      await peek.locator('header strong').filter({ hasText: 'Preview target' }).waitFor();
      await peek.hover(); await peek.getByRole('textbox').fill('quick hover message'); await page.mouse.move(1000, 50);
      await page.waitForTimeout(650); assert.equal(await peek.isVisible(), true, 'draft survives pointer leave');
      for (const target of [card, otherCard]) {
        await target.click({ button: 'right' });
        await page.getByRole('menu').waitFor();
        await page.waitForTimeout(750);
        assert.equal(await peek.count(), 0, 'right-click hides even another card’s retained draft');
        await page.mouse.click(1000, 30);
        await card.hover();
        await peek.locator('header strong').filter({ hasText: 'Preview target' }).waitFor();
        assert.equal(await peek.getByRole('textbox').inputValue(), 'quick hover message', 'menu dismissal preserves the draft');
      }
      await otherCard.hover();
      await peek.locator('header strong').filter({ hasText: 'Other session' }).waitFor();
      assert.equal(await peek.count(), 1, 'a retained draft never overlaps the next preview');
      await card.hover();
      await peek.locator('header strong').filter({ hasText: 'Preview target' }).waitFor();
      assert.equal(await peek.getByRole('textbox').inputValue(), 'quick hover message', 'switching previews preserves draft');
      await peek.getByRole('button', { name: 'Send', exact: true }).click();
      await peek.getByText('Message accepted · no need to open the conversation').waitFor(); assert.equal(posts.length, 1);
      await peek.getByRole('button', { name: 'New message', exact: true }).click();
      delivery = 'queued'; await peek.getByRole('textbox').fill('wait for busy run'); await peek.getByRole('button', { name: 'Send', exact: true }).click();
      await peek.getByText('Queued · waiting for the current run').waitFor(); assert.equal(posts.length, 2);
      await peek.getByRole('button', { name: 'Close preview', exact: true }).click();
      await card.click({ button: 'right' });
      const menu = page.getByRole('menu'); await menu.waitFor();
      const positions = await menu.locator('.session-color-swatches > *').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().y));
      assert.equal(positions.length, 8); assert.equal(new Set(positions).size, 1);
      assert.equal(await menu.getByRole('menuitem', { name: 'Rename session', exact: true }).count(), 1);
      if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, 'peek-menu-1440.png') });
      await page.mouse.click(1000, 30);
    } else {
      assert.equal(previewKeys.length, 0, 'touch list does not prefetch hover-only content');
      slowPreview = false;
      await page.getByLabel('Session actions', { exact: true }).first().click();
      const menu = page.locator('.mobile-session-actions[open]');
      const bounds = await menu.locator('.session-color-swatches').evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, items: [...node.children].map(child => ({ x: child.getBoundingClientRect().x, y: child.getBoundingClientRect().y, right: child.getBoundingClientRect().right })) }));
      assert.equal(bounds.items.length, 8); assert.equal(new Set(bounds.items.map(item => item.y)).size, 1);
      assert.ok(bounds.items.every(item => item.x >= bounds.left && item.right <= bounds.right + 1), 'all colors fit on one mobile row');
      await menu.locator('summary').click();
    }
    // Completion from another session is an in-page popup, with no focus or route change.
    await card.focus();
    const emit = tag => page.evaluate(({ session, tag }) => window.peekFixtureEvent({ id: tag, type: 'run.completed', sessionKey: session.sessionKey, envConnectionId: 'local', ts: Date.now(), payload: { session: { ...session, runtime: { phase: 'completed', turnId: tag } } } }), { session: sessions[1], tag });
    await emit('finish-1'); const toast = page.getByRole('dialog', { name: 'Session finished', exact: true });
    await toast.getByText('Finished result preview', { exact: true }).waitFor();
    if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, `peek-completion-${width}.png`) });
    assert.equal(await card.evaluate(element => element === document.activeElement), true);
    await emit('finish-1'); assert.equal(await toast.count(), 1);
    await page.mouse.move(width - 1, 1); await page.waitForTimeout(12_500); assert.equal(await toast.count(), 0, 'untouched completion expires');
    await emit('finish-2');
    await toast.getByRole('textbox').fill('keep completion draft').catch(async error => { throw new Error(JSON.stringify({ width, errors, body: (await page.locator('body').innerText()).slice(-5000) }), { cause: error }); });
    await page.mouse.move(1, 1); await page.waitForTimeout(12_500); assert.equal(await toast.count(), 1, 'draft pauses expiry');
    await toast.getByRole('button', { name: 'Close preview', exact: true }).click();
    // Multiple user/Hub notes persist content and layout, and retry without a click.
    await page.locator('.notebook-trigger--global').filter({ hasText: 'Global notes' }).click();
    const manager = page.locator('.global-notebook-manager');
    await manager.getByRole('button', { name: 'New notebook', exact: true }).click();
    let note = page.locator('.session-notebook').last(); await note.getByText('Saved to Hub', { exact: true }).waitFor();
    await note.getByRole('textbox').fill(`multi-note-${width}`); await note.getByText('Saved to Hub', { exact: true }).waitFor();
    await note.click({ button: 'right', position: { x: 12, y: 12 } });
    await note.getByRole('textbox', { name: 'Name', exact: true }).fill(`Project tips ${width}`);
    await note.getByRole('slider', { name: 'Opacity', exact: true }).fill('0.75');
    await note.getByRole('slider', { name: 'Width', exact: true }).fill('440');
    await note.getByRole('button', { name: 'Done', exact: true }).click();
    const title = `Project tips ${width}`; note = page.getByRole('dialog', { name: title, exact: true });
    await note.getByRole('button', { name: 'Move notebook', exact: true }).focus(); await note.getByRole('button', { name: 'Move notebook', exact: true }).press('ArrowDown');
    offline = true; await note.getByRole('textbox').fill(`offline automatic ${width}`); await note.getByText('Notebook unavailable · draft retained', { exact: true }).waitFor();
    offline = false; await note.getByText('Saved to Hub', { exact: true }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500); await page.reload();
    note = page.getByRole('dialog', { name: title, exact: true }); await note.getByText('Saved to Hub', { exact: true }).waitFor();
    assert.equal(await note.getByRole('textbox').inputValue(), `offline automatic ${width}`);
    assert.equal(await note.evaluate(element => Math.round(element.getBoundingClientRect().width)), Math.min(440, width - 16));
    assert.ok(await note.evaluate(element => getComputedStyle(element).backgroundColor.includes('0.75')));
    if (process.env.AOD_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.AOD_TEST_SCREENSHOT_DIR, `peek-notebooks-${width}.png`) });
    await note.click({ button: 'right', position: { x: 12, y: 12 } }); await note.getByRole('button', { name: 'Hide notebook', exact: true }).click();
    await page.waitForTimeout(800); await page.reload(); assert.equal(await page.getByRole('dialog', { name: title, exact: true }).count(), 0);
    await page.locator('.notebook-trigger--global').filter({ hasText: 'Global notes' }).click();
    await manager.getByRole('button', { name: title, exact: true }).click(); await page.getByRole('dialog', { name: title, exact: true }).waitFor();
    await manager.getByRole('button', { name: 'New notebook', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.session-notebook').length >= 2);
    // Opening the completed session dismisses its toast; further completions
    // while reading that chat must not interrupt with another preview.
    await page.evaluate(() => document.querySelectorAll('.session-notebook').forEach(node => { node.style.pointerEvents = 'none'; }));
    await emit('finish-open'); await toast.waitFor();
    await page.locator(`[data-session-card="${keys[1]}"]`).click({ force: true });
    await page.locator(width === 1440 ? '[data-session-pane]' : '.mobile-session-detail-shell').waitFor();
    await toast.waitFor({ state: 'detached' });
    await emit('finish-current'); await page.waitForTimeout(300);
    assert.equal(await toast.count(), 0, 'currently displayed session does not toast');
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await page.waitForFunction(() => document.querySelectorAll('.session-notebook, .session-peek').length === 0);
    assert.deepEqual(errors, []); await context.close();
    console.log(`Peek/workspace ${width}px: hover/quick admission, focus, expiry, multi-note persistence, offline retry, layout and auth passed`);
  }
} finally { await browser?.close(); await server.close(); routes.close(); hub.close(); await rm(directory, { recursive: true, force: true }); }
