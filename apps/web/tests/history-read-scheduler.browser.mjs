// Real built app; synthetic APIs only. No production sessions or credentials.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { preview } from 'vite';
import { historyPendingBody } from '@agentopsdeck/shared';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const builtRoot = process.env.AOD_TEST_WEB_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const control = process.env.AOD_SCHEDULER_CONTROL === '1';
const server = await preview({ root: builtRoot, configFile: false, envFile: false,
  build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
function dock(ids, depth = 0) {
  if (ids.length === 1) return { kind: 'pane', id: ids[0] };
  const half = Math.ceil(ids.length / 2);
  return { kind: 'split', axis: depth % 2 ? 'vertical' : 'horizontal', ratio: half / ids.length,
    first: dock(ids.slice(0, half), depth + 1), second: dock(ids.slice(half), depth + 1) };
}
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const mode of control ? ['steady'] : ['steady', 'interactive', 'preparing']) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, serviceWorkers: 'block' });
    const sessions = Array.from({ length: 12 }, (_, i) => ({ sessionKey: `remote:schedule-${i}`,
      envConnectionId: 'remote', title: `Synthetic startup ${i}`, source: 'codex', agentId: 'codex', status: 'idle', lastActiveAt: 1 }));
    const histories = new Map(sessions.map(session => [session.sessionKey, Array.from({ length: 240 }, (_, i) => [
      ...Array.from({ length: 4 }, (_, tool) => ({ id: `tool-${i}-${tool}`, sessionKey: session.sessionKey,
        role: 'tool', createdAt: i * 10 + tool, status: 'sent', text: `Synthetic tool output ${i}:${tool}` })),
      { id: `chat-${i}`, sessionKey: session.sessionKey, role: 'assistant', createdAt: i * 10 + 9, status: 'sent',
        text: `History ${session.sessionKey} ${i}\n\nRetained **searchable** text.\n\n- First item\n- Second item\n\n\`inline code\`` },
    ]).flat()]));
    const panes = [...sessions.map((session, i) => ({ id: `chat-${i}`, sessionKey: session.sessionKey })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `note-${i}`, kind: 'notebook', target: 'session', resourceId: sessions[i].sessionKey }))];
    const layout = { id: 'current', name: 'Current', collapsedKeys: [], workspace: {
      version: 2, panes, floating: [], active: 'chat-11', dock: dock(panes.map(pane => pane.id)),
    } };
    const errors = [], denied = [], reads = [], held = [], layouts = new Map();
    const preparingKeys = new Set();
    let active = 0, peak = 0, hold = mode === 'interactive';
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { denied.push(`${request.method()} ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (/\/workspace\/layouts\/(current|saved)$/.test(url.pathname)) {
        const previous = layouts.get(url.pathname) ?? { revision: 0, content: null };
        if (request.method() === 'PUT') layouts.set(url.pathname, { revision: previous.revision + 1, content: request.postDataJSON().content });
        else if (request.method() !== 'GET') { denied.push(request.method()); return route.abort(); }
        return json(layouts.get(url.pathname) ?? previous);
      }
      if (request.method() !== 'GET') { denied.push(`${request.method()} ${url.pathname}`); return route.abort(); }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions }], revision: '1', updatedAt: 1 });
      if (url.pathname.endsWith('/messages')) {
        const key = decodeURIComponent(url.pathname.split('/').at(-2)), all = histories.get(key);
        assert.ok(all);
        const limit = Number(url.searchParams.get('limit')), before = url.searchParams.get('before');
        const end = before ? all.findIndex(row => row.id === before) : all.length;
        assert.ok(limit > 0 && limit <= 500 && end >= 0);
        const start = Math.max(0, end - limit);
        const preparing = mode === 'preparing' && !before && ['remote:schedule-11', 'remote:schedule-0'].includes(key) && !preparingKeys.has(key);
        if (preparing) preparingKeys.add(key);
        reads.push({ key, before, count: end - start, ...(preparing ? { preparing: true } : {}) });
        active++; peak = Math.max(peak, active);
        const reply = async () => {
          try {
            if (preparing) await route.fulfill({ status: 202, json: { ...historyPendingBody(), retryAfterMs: 1000 } });
            else await json({ messages: all.slice(start, end), totalCount: all.length, hiddenCount: start, updatedAt: 1, revision: `1:${start}:${end}` });
          }
          finally { active--; }
        };
        if (hold) { held.push(reply); return; }
        await delay(120);
        return reply();
      }
      if (url.pathname.endsWith('/queue') || url.pathname.endsWith('/notebooks')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/notebook')) return json({ resourceId: `fixture:${url.pathname}`, text: '', revision: 0, updatedAt: 1 });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(({ layout }) => {
      // Start away from the minute-aligned live safety refresh, but preserve
      // advancing time for snapshot ordering, retries and refresh throttling.
      const NativeDate = Date;
      const offset = NativeDate.parse('2026-09-30T10:00:01Z') - NativeDate.now();
      window.Date = class extends NativeDate {
        constructor(...args) { if (args.length) super(...args); else super(NativeDate.now() + offset); }
        static now() { return NativeDate.now() + offset; }
      };
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem(`agentopsdeck.current-layout.v2:${'a'.repeat(64)}`, JSON.stringify(layout));
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
    }, { layout });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    if (mode === 'interactive') {
      for (let i = 0; i < 100 && held.length < 2; i++) await delay(50);
      assert.equal(held.length, 2);
      assert.ok(reads.slice(0, 2).some(read => read.key === 'remote:schedule-11'), 'selected pane starts in first batch');
      const pane = index => page.locator(`[data-workspace-pane][data-remote-pane="chat-${index}"]`);
      await pane(7).getByRole('button', { name: 'Close pane', exact: true }).click();
      await pane(5).getByRole('button', { name: 'Force refresh messages', exact: true }).click();
      for (let i = 0; i < 100 && held.length < 3; i++) await delay(20);
      assert.equal(held.length, 3, 'manual refresh bypasses both blocked automatic slots');
      assert.equal(reads[2].key, 'remote:schedule-5');
      await held[2]();
      await page.waitForFunction(() => document.querySelector('[data-session-pane="remote:schedule-5"]')
        ?.querySelectorAll('[data-message-search-id^="chat-"]').length === 40);
      await delay(100);
      await pane(5).locator('.message-selection-surface').evaluate(el => {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); el.scrollTop = 40;
      });
      for (let i = 0; i < 100 && held.length < 4; i++) await delay(20);
      assert.equal(held.length, 4, 'upward intent expedites queued automatic backfill while startup slots are blocked');
      assert.equal(reads[3].key, 'remote:schedule-5');
      assert.ok(reads[3].before);
      hold = false;
      for (const [index, reply] of held.entries()) if (index !== 2) await reply();
    }
    const expectedChats = mode === 'interactive' ? 2200 : 2400;
    try {
      await page.waitForFunction(count => document.querySelectorAll('[data-message-search-id^="chat-"]').length === count, expectedChats);
    } catch (error) {
      console.error(JSON.stringify({ mode, reads, active, peak, errors,
        chats: await page.locator('[data-message-search-id^="chat-"]').count() }));
      throw error;
    }
    await delay(500);
    // Snapshot the measured startup phase before any further browser round trips.
    const startup = { historyReads: reads.length, olderReads: reads.filter(r => r.before).length,
      peakConcurrentHistory: peak, firstReads: reads.slice(0, 3) };
    if (mode === 'interactive') assert.ok(reads.every(read => read.key !== 'remote:schedule-7'), 'closed queued pane never reads history');
    else {
      assert.equal(startup.peakConcurrentHistory, control ? 12 : 2, 'automatic reads use the expected global concurrency');
      assert.equal(startup.historyReads, mode === 'preparing' ? 62 : 60, 'scheduling retains all pages, without duplicate requests');
      if (!control) assert.ok(reads.slice(0, 2).some(read => read.key === 'remote:schedule-11'));
      if (mode === 'preparing') {
        assert.equal(preparingKeys.size, 2);
        assert.ok(reads.findIndex(read => read.key === 'remote:schedule-1')
          < reads.findIndex(read => read.key === 'remote:schedule-11' && !read.preparing), 'another pane loads before preparing session retries');
      }
    }
    const elements = await page.locator('*').count();
    const tools = await page.locator('.desktop-tool-chip').count();
    assert.equal(tools, expectedChats * 4);
    console.log(JSON.stringify({ mode, control, ...startup, chats: expectedChats, tools, elements }));
    // Older history remains explicitly accessible, including all tool records.
    const surface = page.locator('[data-session-pane="remote:schedule-0"] .message-selection-surface');
    await surface.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); el.scrollTop = 40; });
    await page.waitForFunction(() => document.querySelector('[data-session-pane="remote:schedule-0"]')
      ?.querySelectorAll('[data-message-search-id^="chat-"]').length === 240);
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
