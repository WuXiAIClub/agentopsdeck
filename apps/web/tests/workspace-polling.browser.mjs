// Full application request budgets, not just transport-unit measurements.
// Synthetic Hub + clock; no production credentials, writes or Agent calls.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: process.env.AOD_TEST_WEB_ROOT ?? fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: process.env.AOD_TEST_WEB_ROOT ? [] : [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const [count, preview] of [[6, false], [6, true], [16, false]]) {
    const context = await browser.newContext({ viewport: { width: 2560, height: 1600 }, serviceWorkers: 'block' });
    const scope = 'a'.repeat(64), sessions = Array.from({ length: count }, (_, i) => ({
      sessionKey: `local:${btoa(`codex:budget-${i}`)}`, title: `Budget ${i}`, agentId: 'codex', source: 'codex',
      envConnectionId: 'local', status: 'idle', messageCount: 900, lastActiveAt: i + 1,
    }));
    const versions = new Map(sessions.map(s => [s.sessionKey, 1]));
    const panes = sessions.map((s, i) => ({ id: `pane-${i}`, sessionKey: s.sessionKey }));
    panes.push({ id: 'note', kind: 'notebook', target: 'session', resourceId: sessions[0].sessionKey });
    const split = (ids, axis) => ids.length === 1 ? { kind: 'pane', id: ids[0] } : { kind: 'split', axis,
      ratio: 1 / ids.length, first: { kind: 'pane', id: ids[0] }, second: split(ids.slice(1), axis) };
    const dockCount = Math.min(12, count), perRow = count === 6 ? 3 : 4;
    const rows = Array.from({ length: dockCount / perRow }, (_, r) => split(panes.slice(r * perRow, (r + 1) * perRow).map(p => p.id), 'horizontal'));
    const dock = { kind: 'split', axis: 'vertical', ratio: 1 / rows.length, first: rows[0], second: rows.length === 2 ? rows[1]
      : { kind: 'split', axis: 'vertical', ratio: .5, first: rows[1], second: rows[2] } };
    const floating = panes.slice(dockCount).map((p, i) => ({ id: p.id, x: .06 + .07 * i, y: .05 + .07 * i, width: .25, height: .3 }));
    const layout = { id: 'current', name: 'Current', workspace: { version: 2, panes, dock, floating, active: 'pane-0' }, collapsedKeys: [] };
    const requests = [], errors = []; let revision = 1;
    const etag = key => `W/"history-${versions.get(key).toString(16).padStart(64, '0')}"`;
    const metadata = key => ({ etag: etag(key), 'x-agentopsdeck-history-meta': JSON.stringify({ updatedAt: versions.get(key), sourceCursor: null }) });
    const history = key => ({ messages: [{ id: key, sessionKey: key, role: 'assistant', text: `Snapshot ${versions.get(key)} ${'content '.repeat(128)}`, createdAt: 1 }],
      revision: `${key}:${versions.get(key)}`, updatedAt: versions.get(key), totalCount: 900, hiddenCount: 0 });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, origin);
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const record = { path: url.pathname, query: url.search, etag: req.headers()['if-none-match'], bytes: 0 }; requests.push(record);
      const json = body => { const text = JSON.stringify(body); record.bytes = Buffer.byteLength(text); return route.fulfill({ body: text, contentType: 'application/json' }); };
      if (url.pathname.endsWith('/workspace/check') || url.pathname.endsWith('/workspace/sync')) {
        assert.equal(req.method(), 'POST'); const { items } = req.postDataJSON(); assert.ok(items.length <= 8);
        record.items = items.map(i => i.sessionKey);
        const check = url.pathname.endsWith('/check');
        const frames = items.map(item => {
          const unchanged = item.etag === etag(item.sessionKey);
          return { sessionKey: item.sessionKey, status: unchanged ? 304 : 200,
            headers: { ...metadata(item.sessionKey), ...(!unchanged && check ? { 'x-agentopsdeck-history-check': 'changed' } : {}) },
            ...(!unchanged ? { body: check ? { changed: true } : history(item.sessionKey) } : {}) };
        });
        const body = frames.map(f => JSON.stringify(f)).join('\n') + '\n'; record.bytes = Buffer.byteLength(body);
        return route.fulfill({ body, headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
      }
      assert.equal(req.method(), 'GET', `Unexpected write: ${url.pathname}`);
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: String(revision), groups: [{ agentId: 'codex', sessions }], sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready' }] });
      if (url.pathname.endsWith('/messages')) {
        const key = decodeURIComponent(url.pathname.split('/').at(-2)); record.items = [key];
        if (req.headers()['if-none-match'] === etag(key)) return route.fulfill({ status: 304, headers: metadata(key) });
        const body = JSON.stringify(history(key)); record.bytes = Buffer.byteLength(body);
        return route.fulfill({ body, contentType: 'application/json', headers: metadata(key) });
      }
      if (url.pathname.endsWith('/notebook')) return json({ resourceId: 'fixture-note', text: 'Independent note', revision: 1, updatedAt: 1 });
      if (url.pathname.endsWith('/notebooks') || url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(({ scope, layout, preview }) => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify(layout));
      localStorage.setItem(`agentopsdeck.workspace-sync-preview.v1:${scope}`, preview ? 'on' : 'off');
      window.fixtureVisible = true;
      Object.defineProperty(document, 'visibilityState', { get: () => window.fixtureVisible ? 'visible' : 'hidden' });
      Object.defineProperty(document, 'hidden', { get: () => !window.fixtureVisible });
      const streams = [];
      window.fixtureTrace = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1;
        constructor() { super(); streams.push(this); window.fixtureTrace.push(['open', Date.now()]); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; window.fixtureTrace.push(['close', Date.now()]); }
      };
      window.fixtureEvent = event => { for (const s of streams) if (s.readyState === 1) s.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })); };
      window.fixtureHeartbeat = () => { for (const s of streams) if (s.readyState === 1) s.dispatchEvent(new Event('heartbeat')); };
    }, { scope, layout, preview });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.clock.install({ time: new Date('2026-09-28T01:00:10Z') });
    const advance = async ms => { for (let n = 0; n < ms; n += 500) { await page.clock.runFor(Math.min(500, ms - n)); await pause(15); } };
    const summary = start => {
      const rows = requests.slice(start);
      return { requests: rows.length, decodedBytes: rows.reduce((n, r) => n + r.bytes, 0),
        historyGets: rows.filter(r => r.path.endsWith('/messages')).length,
        checks: rows.filter(r => r.path.endsWith('/workspace/check')).length,
        syncs: rows.filter(r => r.path.endsWith('/workspace/sync')).length };
    };
    await page.goto(origin);
    await page.waitForFunction(n => [...document.querySelectorAll('[data-session-pane]')].filter(el => el.textContent.includes('Snapshot 1')).length === n, count);
    // Register after navigation: the injected clock can replace timers created
    // by init scripts, otherwise an idle stream spuriously stalls at 45s.
    await page.evaluate(() => { window.fixtureHeartbeat(); setInterval(window.fixtureHeartbeat, 15000); });
    await advance(5000);
    let start = requests.length; await advance(60000); const idle = summary(start);
    assert.equal(idle.historyGets, 0, JSON.stringify({ idle, requests: requests.slice(start), trace: await page.evaluate(() => window.fixtureTrace) }));
    assert.ok(idle.checks >= 1 && idle.checks <= Math.ceil(count / 8), JSON.stringify(idle));
    // Each bounded revision request covers eight sessions; 16 needs two.
    assert.ok(idle.requests <= 7 + Math.ceil(count / 8), `Idle workspace budget: ${JSON.stringify(idle)}`);
    start = requests.length; sessions[0].status = 'running';
    for (let n = 0; n < 60; n++) {
      revision++; versions.set(sessions[0].sessionKey, revision);
      await page.evaluate(sessionKey => window.fixtureEvent({ type: 'message.created', sessionKey }), sessions[0].sessionKey);
      await advance(1000);
    }
    const active = summary(start);
    const idleReads = requests.slice(start).filter(r => r.path.endsWith('/messages') && r.items[0] !== sessions[0].sessionKey);
    assert.equal(idleReads.length, 0, 'Other Done sessions must not get ordinary history polls');
    assert.ok(active.requests <= 65, `One busy session budget: ${JSON.stringify(active)}`);
    await page.evaluate(() => { window.fixtureVisible = false; document.dispatchEvent(new Event('visibilitychange')); });
    await advance(3000); start = requests.length;
    await advance(60000); const hidden = summary(start); assert.equal(hidden.requests, 0, JSON.stringify({ hidden, requests: requests.slice(start) }));
    await page.evaluate(() => { window.fixtureVisible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await advance(5000);
    await page.waitForFunction(rev => document.querySelector('[data-session-pane]').textContent.includes(`Snapshot ${rev} `), revision);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', sessions: count, notebooks: 1, preview, idle60s: idle, active60s: active, hidden60s: hidden }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
