import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const builtRoot = process.env.AOD_TEST_WEB_ROOT;
const server = builtRoot
  ? await preview({ root: builtRoot, configFile: false, build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
    plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  if (!builtRoot) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const sessionKey = 'local:cG9sbGluZw';
    const session = { sessionKey, envConnectionId: 'local', title: 'Polling fixture', agentId: 'main', source: 'openclaw', status: 'idle', lastActiveAt: 1 };
    let revision = 1, text = 'Initial message', historyUnavailable = false;
    const counts = { state: 0, agents: 0, status: 0, messages: 0 };
    const errors = [], rejected = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') { rejected.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) { counts.state++; return json({ groups: [{ agentId: 'main', sessions: [session] }], connections: [], revision: String(revision), updatedAt: revision }); }
      if (url.pathname.endsWith('/messages')) {
        counts.messages++;
        if (historyUnavailable) return route.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } });
        return json({ messages: [{ id: 'reply', sessionKey, role: 'assistant', text, createdAt: 1000, status: 'sent' }], hiddenCount: 0, revision: String(revision), updatedAt: revision });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') { counts.agents++; return json({ agents: [{ id: 'main', name: 'Main' }], updatedAt: revision }); }
      if (url.pathname === '/api/gateway/status') { counts.status++; return json({ connected: true }); }
      return route.fulfill({ status: 404, json: { error: 'Not part of fixture' } });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.fixtureVisible = true;
      window.fixtureOnline = true;
      Object.defineProperty(document, 'visibilityState', { get: () => window.fixtureVisible ? 'visible' : 'hidden' });
      window.EventSource = class extends EventTarget {
        readyState = 0;
        static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => { if (window.fixtureOnline) this.open(); }); }
        open() { this.readyState = 1; this.onopen?.(new Event('open')); }
        close() { this.readyState = 2; }
      };
      window.fixtureEvent = event => {
        for (const stream of streams) if (stream.readyState === 1) stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id }));
      };
      window.fixtureConnection = online => {
        window.fixtureOnline = online;
        const current = streams.at(-1);
        if (online) current?.open();
        else current?.onerror?.(new Event('error'));
      };
      setInterval(() => {
        for (const stream of streams) if (stream.readyState === 1 && window.fixtureOnline) stream.dispatchEvent(new Event('heartbeat'));
      }, 15_000);
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(origin);
    await page.getByText(session.title, { exact: true }).first().click();
    await page.getByText(text, { exact: true }).waitFor();
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 100));
    const advance = async ms => {
      for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
        await page.clock.runFor(Math.min(1000, ms - elapsed));
        await pause(15);
      }
    };
    const snapshot = () => ({ ...counts });
    const delta = before => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key]]));
    const emit = async type => page.evaluate(({ type, sessionKey, revision }) => window.fixtureEvent({ id: String(revision), type, sessionKey, ts: revision, payload: {} }), { type, sessionKey, revision });
    await advance(5000);
    const idleStart = snapshot();
    const idleStartedAt = await page.evaluate(() => Date.now());
    await advance(60_000);
    const idle = delta(idleStart);
    console.log(JSON.stringify({ viewport: viewport.width, phase: 'idle-60s', elapsedMs: await page.evaluate(() => Date.now()) - idleStartedAt, counts: idle }));
    if (process.env.AOD_TEST_POLLING_BASELINE) { await context.close(); continue; }
    for (const [key, count] of Object.entries(idle)) assert.ok(count <= 1, `${key} should have at most one safety read/minute: ${count}`);

    const clickStart = snapshot();
    await page.evaluate(() => { for (let i = 0; i < 20; i++) document.dispatchEvent(new Event('selectionchange')); });
    await advance(2000);
    assert.equal(delta(clickStart).messages, 0, 'ordinary caret/click events must not fetch history');

    const burstStart = snapshot();
    revision++; text = 'Fresh streamed message';
    for (let i = 0; i < 20; i++) await emit('session.updated');
    await advance(2000);
    await page.getByText(text, { exact: true }).waitFor();
    assert.deepEqual(delta(burstStart), { state: 1, agents: 0, status: 0, messages: 1 }, 'event burst shares metadata and coalesces snapshots');

    const metadataStart = snapshot();
    revision++; await emit('gateway.status_changed'); await advance(2000);
    assert.equal(delta(metadataStart).agents, 1);
    assert.equal(delta(metadataStart).status, 1, 'status change invalidates metadata immediately');

    await page.evaluate(() => { window.fixtureVisible = false; document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenStart = snapshot();
    revision++; text = 'Caught up after background'; await emit('session.updated');
    await advance(120_000);
    assert.deepEqual(delta(hiddenStart), { state: 0, agents: 0, status: 0, messages: 0 });
    await page.evaluate(() => { window.fixtureVisible = true; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await advance(2000);
    await page.getByText(text, { exact: true }).waitFor();
    assert.deepEqual(delta(hiddenStart), { state: 1, agents: 1, status: 1, messages: 1 });

    await page.evaluate(() => window.fixtureConnection(false));
    const offlineStart = snapshot();
    revision++; text = 'Recovered by fallback';
    await advance(31_000);
    await page.getByText(text, { exact: true }).waitFor();
    const offline = delta(offlineStart);
    assert.ok(offline.messages >= 2 && offline.messages <= 3, JSON.stringify(offline));
    assert.ok(offline.state >= 1 && offline.state <= 2, JSON.stringify(offline));
    assert.equal(offline.agents, 0); assert.equal(offline.status, 0);

    revision++; text = 'Recovered by reconnect';
    await page.evaluate(() => window.fixtureConnection(true)); await advance(2000);
    await page.getByText(text, { exact: true }).waitFor();
    const resetStart = snapshot();
    revision++; text = 'Reset catchup'; await emit('stream.reset'); await advance(2000);
    await page.getByText(text, { exact: true }).waitFor();
    assert.deepEqual(delta(resetStart), { state: 1, agents: 1, status: 1, messages: 1 });
    historyUnavailable = true;
    const failureStart = snapshot();
    for (let second = 0; second < 30; second++) {
      revision++; await emit('session.updated'); await advance(1000);
    }
    const failedReads = delta(failureStart).messages;
    assert.ok(failedReads >= 3 && failedReads <= 6, `503 reads must back off under SSE spam: ${failedReads}`);
    await page.getByText(text, { exact: true }).waitFor();
    historyUnavailable = false;
    revision++; text = 'History recovered after 503';
    await emit('session.updated'); await advance(33_000);
    await page.getByText(text, { exact: true }).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
    console.log(`PASS polling ${viewport.width}: idle, event burst, metadata invalidation, hidden tab, wake, fallback, reconnect, reset, caret, 503 backoff/recovery`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (builtRoot) await new Promise(resolve => server.httpServer.close(resolve));
  else await server.close();
}
