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
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) for (const withTools of [true, false]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const sessionKey = 'local:c3ludGhldGlj';
    const session = { sessionKey, envConnectionId: 'local', title: 'History pagination', agentId: 'main', source: 'openclaw', status: 'idle', lastActiveAt: 1 };
    let revision = 1, reads = [], errors = [], denied = [], failNext = false;
    let messages = Array.from({ length: 1100 }, (_, n) => [
      ...(withTools ? [{ id: `tool-${n}`, sessionKey, role: 'tool', text: 'Synthetic tool output', createdAt: n * 2, status: 'sent' }] : []),
      { id: `chat-${n}`, sessionKey, role: 'assistant', text: `Conversation ${n}\n\n${'Readable history. '.repeat(5)}`, createdAt: n * 2 + 1, status: 'sent' },
    ]).flat();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') { denied.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ groups: [{ agentId: 'main', sessions: [session] }], updatedAt: revision, revision: String(revision) });
      if (url.pathname.endsWith('/messages')) {
        const limit = Number(url.searchParams.get('limit')), before = url.searchParams.get('before');
        reads.push({ limit, before });
        assert.ok(limit <= 500);
        if (before && failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: 'Temporary history failure' } }); }
        const end = before ? messages.findIndex(item => item.id === before) : messages.length;
        assert.ok(end >= 0);
        const start = Math.max(0, end - limit);
        return json({ messages: messages.slice(start, end), hiddenCount: start, totalCount: messages.length, revision: `${revision}:${start}:${end}`, updatedAt: revision });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'main', name: 'Main' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.historyEvent = event => streams.forEach(stream => stream.readyState === 1 && stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })));
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    const pane = page.locator('.message-selection-surface:visible');
    const chats = pane.locator('[data-message-search-id^="chat-"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.message-selection-surface')].some(el => el.clientHeight && el.querySelectorAll('[data-message-search-id^="chat-"]').length === 200));
    assert.equal(await chats.count(), 200, 'tools do not consume the initial chat budget');
    assert.equal(await page.getByText(/Showing latest|older hidden/).count(), 0);
    await page.waitForTimeout(400);
    assert.ok(await pane.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2));
    const climb = async () => {
      await pane.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); el.scrollTop = 40; });
    };
    const wheelAtTop = async () => {
      await pane.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); });
    };
    if (withTools) {
      failNext = true;
      await climb();
      await page.waitForTimeout(600);
      assert.equal(await chats.count(), 200, 'failed older read preserves rendered history');
      const readsAfterFailure = reads.length;
      await page.waitForTimeout(600);
      assert.equal(reads.length, readsAfterFailure, 'no failed-page retry loop');
      await wheelAtTop();
      await page.waitForFunction(() => [...document.querySelectorAll('.message-selection-surface')].some(el => el.clientHeight && el.querySelectorAll('[data-message-search-id^="chat-"]').length > 200));
    } else {
      await climb();
      await page.waitForFunction(() => [...document.querySelectorAll('.message-selection-surface')].some(el => el.clientHeight && el.querySelectorAll('[data-message-search-id^="chat-"]').length > 200));
    }
    assert.ok(await pane.evaluate(el => el.scrollTop > 100), 'prepend preserves reading position rather than remaining at top');
    const countBefore = await chats.count();
    const oldestBefore = await chats.first().getAttribute('data-message-search-id');
    messages.push({ ...messages.at(-1), id: 'chat-new', text: 'New live reply', createdAt: 3000 });
    revision++;
    await page.evaluate(({ sessionKey, revision }) => window.historyEvent({ id: `history-${revision}`, type: 'message.updated', sessionKey, ts: revision, payload: {} }), { sessionKey, revision });
    await pane.locator('[data-message-search-id="chat-new"]').waitFor();
    assert.equal(await chats.count(), countBefore + 1, 'latest snapshot retains every older row');
    assert.equal(await chats.first().getAttribute('data-message-search-id'), oldestBefore, 'live append cannot evict the expanded window start');
    assert.ok(await pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop > 100), 'new reply does not steal reading position');
    for (let i = 0; i < 15 && !await pane.locator('[data-message-search-id="chat-0"]').count(); i++) {
      await climb();
      await page.waitForTimeout(250);
    }
    await pane.locator('[data-message-search-id="chat-0"]').waitFor();
    assert.equal(await chats.count(), 1101, 'all history is reachable beyond 500');
    assert.equal(new Set(await chats.evaluateAll(nodes => nodes.map(node => node.dataset.messageSearchId))).size, 1101);
    assert.ok(reads.filter(read => read.before).length >= (withTools ? 10 : 5));
    assert.deepEqual(errors, []);
    assert.deepEqual(denied, []);
    console.log(JSON.stringify({ viewport, withTools, initialChats: 200, reachableChats: 1101, requests: reads.length, anchorPagination: true, errors }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
