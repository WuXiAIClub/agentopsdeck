// Synthetic large-history benchmark. Never contacts a real Hub or submits messages.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { preview } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = process.env.AOD_TEST_WEB_ROOT;
assert.ok(root, 'Use a production build for comparable measurements');
const server = await preview({ root, configFile: false, envFile: false, build: { outDir: root }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], denied = [];
    const sessionKey = 'remote:performance', path = '/project/performance.ts', href = `${path}:118`;
    const mediaUrl = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}/messages/chat-199/media/${'a'.repeat(64)}`;
    const messages = Array.from({ length: 200 }, (_, i) => ({ id: `chat-${i}`, sessionKey, role: 'assistant', createdAt: i + 1, status: 'sent',
      text: `Conversation ${i}\n\n${Array.from({ length: 6 }, (_, j) => `[Reference ${j}](${href})`).join('\n\n')}`,
      media: [{ type: 'file', name: 'performance.ts', url: mediaUrl, sourceReference: { path, href, line: 118 } }] }));
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET') { denied.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions: [{ sessionKey, title: 'Performance fixture', agentId: 'codex', source: 'codex', status: 'idle', lastActiveAt: 1 }] }], revision: '1' });
      if (url.pathname.endsWith('/messages')) return json({ messages, totalCount: 200, hiddenCount: 0, revision: '1' });
      if (url.pathname === mediaUrl) return json({ path, line: 118, startLine: 106, totalLines: 200, modifiedAt: 1,
        text: Array.from({ length: 45 }, (_, i) => `const line${106 + i} = ${i};`).join('\n') });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      const NativeObserver = window.IntersectionObserver;
      window.observerStats = { created: 0, live: 0 };
      window.IntersectionObserver = class extends NativeObserver {
        stopped = false;
        constructor(...args) { super(...args); window.observerStats.created++; window.observerStats.live++; }
        disconnect() { if (!this.stopped) { window.observerStats.live--; this.stopped = true; } super.disconnect(); }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const start = Date.now();
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('.source-inline-code').length === 1200);
    await page.waitForTimeout(1600); // Let desktop offscreen presentation retention expire.
    const readyMs = Date.now() - start;
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    // Same ten layout changes, with no forced geometry read in the driver.
    for (let i = 0; i < 10; i++) {
      await page.setViewportSize({ width: width - (i % 2 ? 0 : 20), height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const measurement = await page.evaluate(() => ({ dom: document.querySelectorAll('*').length,
      chats: document.querySelectorAll('[data-message-search-id]').length,
      codeLines: document.querySelectorAll('.source-inline-line').length,
      compactPreviews: document.querySelectorAll('[data-source-rendering="compact"]').length,
      retainedSourceCodes: [...document.querySelectorAll('.source-inline-code')].filter(el => el.textContent.includes('const line118 = 12;')).length,
      observers: window.observerStats }));
    assert.equal(measurement.chats, 200);
    assert.equal(measurement.retainedSourceCodes, 1200, 'all code text remains searchable, including compact previews');
    if (width >= 768 && process.env.AOD_PERF_BASELINE !== '1') {
      assert.ok(measurement.compactPreviews > 1100, 'offscreen desktop line decoration is reclaimed');
      assert.ok(measurement.codeLines < 700, 'rich code-line nodes stay near the viewport');
      assert.ok(measurement.dom < 28_000, 'desktop offscreen presentation has a bounded rich-node budget');
    } else assert.equal(measurement.codeLines, 8400, 'mobile rendering is unchanged');
    if (process.env.AOD_PERF_BASELINE !== '1') {
      assert.ok(measurement.dom < 43_000, 'do not restore a wrapper per source line');
      assert.ok(measurement.observers.created <= 10, 'observers must be shared, not allocated per card');
    }
    // Content remains discoverable and selectable, including the oldest row.
    await page.locator('.message-selection-surface:visible').evaluate(el => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })));
    const oldest = page.locator('[data-message-search-id="chat-0"]');
    await oldest.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300); // Let the existing one-shot visibility/load effect settle.
    assert.match(await oldest.textContent(), /Conversation 0/);
    const firstCard = page.locator('[data-message-search-id="chat-199"] .source-inline-card').last();
    await firstCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await firstCard.getByRole('button', { name: 'Expand', exact: true }).click();
    await firstCard.locator('.source-inline-line').nth(44).waitFor({ state: 'attached' });
    assert.equal(await firstCard.locator('.source-inline-line').count(), 45);
    const selected = await firstCard.locator('.source-inline-code').evaluate(el => {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
      const text = selection.toString(); selection.removeAllRanges(); return text;
    });
    assert.match(selected, /const line118 = 12;/);
    await firstCard.getByRole('button', { name: 'Collapse', exact: true }).click();
    assert.equal(await firstCard.locator('.source-inline-line').count(), 7);
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    console.log(JSON.stringify({ width, readyMs, ...measurement,
      resizeLayoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      resizeStyleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
      functionalChecks: 'all 200 messages, full expansion, selection and collapse', errors, denied }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
