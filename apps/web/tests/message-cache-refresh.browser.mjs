import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { preview } from 'vite';

// Run against the exact built candidate, with no production API or credentials.
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = process.env.AOD_TEST_WEB_ROOT;
assert.ok(root, 'AOD_TEST_WEB_ROOT is required');
const server = await preview({ root, configFile: false, build: { outDir: root },
  preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const errors = [], denied = [];
    const sessionKey = 'test:long-history';
    const latest = 'Latest final reply survives a page refresh';
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `message-${i}`, sessionKey, role: 'assistant', createdAt: i + 1,
      text: i === 199 ? latest : `History ${i}\n\n` + '工具输出'.repeat(2200),
    }));
    let offline = false, historyReads = 0;
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.origin !== origin || request.method() !== 'GET') { denied.push(target.href); return route.abort(); }
      if (!target.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (target.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'b'.repeat(64), passkeys: { available: false, count: 0 } });
      if (target.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions: [{
        sessionKey, title: 'Long cached history', agentId: 'codex', source: 'codex', status: 'idle', lastActiveAt: 200,
      }] }], revision: '1' });
      if (target.pathname.endsWith('/messages')) {
        historyReads++;
        return offline ? route.fulfill({ status: 503, json: { error: 'Synthetic history unavailable' } })
          : json({ messages, totalCount: 950, hiddenCount: 750, revision: '1' });
      }
      if (target.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (target.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (target.pathname === '/api/gateway/status') return json({ connected: true });
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
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.getByText(latest, { exact: true }).waitFor();
    await page.waitForFunction(text => Object.values(localStorage).some(raw => {
      try { return JSON.parse(raw)?.messages?.at(-1)?.text === text; } catch { return false; }
    }), latest);
    const cache = await page.evaluate(text => {
      const raw = Object.values(localStorage).find(value => {
        try { return JSON.parse(value)?.messages?.at(-1)?.text === text; } catch { return false; }
      });
      const entry = JSON.parse(raw);
      return { bytes: raw.length * 2, count: entry.messages.length, hidden: entry.hiddenCount };
    }, latest);
    assert.ok(cache.bytes <= 1.5 * 1024 * 1024);
    assert.ok(cache.count > 0 && cache.count < 200);
    assert.equal(cache.hidden, 950 - cache.count);
    offline = true;
    const readsBefore = historyReads;
    // Cached paint may precede the effect/scheduler starting revalidation.
    // Observe the failed transport separately from the cached-content assertion.
    const failedRevalidation = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/messages') && response.status() === 503);
    await page.reload();
    // Mobile intentionally returns to the session list on refresh.
    if (width < 700) await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.getByText(latest, { exact: true }).waitFor();
    await failedRevalidation;
    assert.ok(historyReads > readsBefore, 'refresh attempted live history; visible reply came from cache despite 503');
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    console.log(JSON.stringify({ width, refreshWithHistoryUnavailable: true, latestVisible: true, ...cache }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
