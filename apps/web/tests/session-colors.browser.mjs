import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const builtRoot = process.env.AOD_TEST_WEB_ROOT;
const server = builtRoot
  ? await preview({ root: builtRoot, configFile: false, build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  if (!builtRoot) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  let desktopColors;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    let revision = 1;
    const sessions = ['local:codex:thread-1', 'local:codex:thread-2', 'local:codex:thread-3', 'remote:codex:thread-1'].map((sessionKey, i) => ({
      sessionKey, envConnectionId: sessionKey.split(':')[0], envConnectionLabel: i === 3 ? 'Remote' : 'Local',
      title: `Project ${i + 1}`, agentId: 'codex', source: 'codex', status: i === 1 ? 'running' : i === 2 ? 'failed' : 'idle', lastActiveAt: i + 1,
    }));
    const errors = [], denied = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') { denied.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ groups: [{ agentId: 'codex', sessions: [...sessions].reverse() }], updatedAt: revision, revision: String(revision) });
      if (url.pathname.endsWith('/messages')) return json({ messages: [], hiddenCount: 0, totalCount: 0, revision: '1' });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const card = key => page.locator(`[data-session-card="${key}"]`);
    const color = async key => card(key).evaluate(el => {
      const avatar = el.querySelector('.mobile-session-avatar');
      const selected = el.getAttribute('aria-current') === 'true';
      return getComputedStyle(avatar ?? el.firstElementChild)[avatar || selected ? 'backgroundColor' : 'borderLeftColor'];
    });
    const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await page.goto(origin);
    await card(sessions[0].sessionKey).waitFor();
    const colors = await Promise.all(sessions.map(s => color(s.sessionKey)));
    assert.equal(new Set(colors).size, sessions.length, 'same agent sessions and same thread on two connectors have different colors');
    if (mobile) assert.deepEqual(colors, desktopColors, 'desktop/mobile use identical session colors');
    else desktopColors = colors;
    await noOverflow();
    if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/sessions-${viewport.width}.png` });
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      await card(s.sessionKey).click();
      const marker = page.locator(`header [data-session-color="${s.sessionKey}"]`);
      await marker.waitFor();
      assert.equal(await marker.evaluate(el => getComputedStyle(el).backgroundColor), colors[i]);
      assert.equal(await marker.evaluate(el => getComputedStyle(el.closest('header')).borderTopColor), colors[i]);
      if (!mobile) {
        assert.equal(await card(s.sessionKey).getAttribute('aria-current'), 'true');
        await page.waitForFunction(({ key, color }) => getComputedStyle(document.querySelector(`[data-session-card="${key}"]`).firstElementChild).backgroundColor === color, { key: s.sessionKey, color: colors[i] });
        assert.equal(await color(s.sessionKey), colors[i]);
        assert.equal(await card(s.sessionKey).locator('strong').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
        assert.ok((await card(s.sessionKey).innerText()).toLowerCase().includes(s.status));
      }
      await noOverflow();
      if (i === 0 && process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/chat-${viewport.width}.png` });
      if (mobile) await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    }
    sessions[0].title = 'Renamed project';
    sessions[0].lastActiveAt = 999;
    sessions[0].pinned = true;
    revision++;
    await page.reload();
    await page.getByText('Renamed project', { exact: false }).first().waitFor();
    assert.deepEqual(await Promise.all(sessions.map(s => color(s.sessionKey))), colors, 'rename, reorder, pin and reload retain colors');
    assert.deepEqual(errors, []);
    assert.deepEqual(denied, []);
    console.log(JSON.stringify({ viewport, colors, sameAgent: true, crossConnector: true, stableAfterRename: true, noOverflow: true, errors }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
