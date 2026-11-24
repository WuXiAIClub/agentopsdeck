import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';

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
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const key = 'local:c3ludGhldGlj', cursor = n => `ce1_11111111-1111-4111-8111-111111111111:${n}`;
    let seq = 1, held = false, reads = 0, release;
    let session = { sessionKey: key, envConnectionId: 'local', title: 'Completion timing', agentId: 'codex', source: 'codex', status: 'running', lastActiveAt: 1,
      runtime: { phase: 'running', sync: 'current', turnId: 'turn-1' } };
    let text = 'Initial assistant message';
    const denied = await fenceContext(context, { origin, api: async route => {
      const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
      if (url.pathname === '/api/auth/status') return json({ setupRequired: false, authenticated: true, user: { id: 'default', username: 'fixture', role: 'owner' } });
      if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions: [session] }], updatedAt: seq, revision: String(seq), sourceCursors: { local: cursor(seq) } });
      if (url.pathname.endsWith('/messages')) {
        reads++;
        const page = { messages: [{ id: `reply-${seq}`, sessionKey: key, role: 'assistant', text, status: 'sent', createdAt: seq }], updatedAt: seq, revision: String(seq), sourceCursor: cursor(seq) };
        if (held) await new Promise(resolve => { release = resolve; });
        return json(page);
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside synthetic fixture' } });
    } });
    await context.addInitScript(() => {
      window.notified = [];
      window.Notification = class {
        static permission = 'granted';
        constructor(title, options) {
          window.notified.push({ title, tag: options?.tag, body: document.body.innerText });
          queueMicrotask(() => this.onshow?.());
        }
        close() {}
      };
      Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => undefined, register: async () => undefined } });
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.emitCompletionEvent = event => streams.forEach(stream => stream.readyState === 1 && stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })));
    });
    const page = await context.newPage(), errors = [];
    const waitForHeldRead = async () => {
      const deadline = Date.now() + 8000;
      while (!release && Date.now() < deadline) await page.waitForTimeout(20);
      assert.ok(release, 'priority final message read dispatched within 8s');
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${key}"]`).click();
    await page.getByText('Initial assistant message', { exact: true }).first().waitFor();
    const emit = type => page.evaluate(event => window.emitCompletionEvent(event), { id: `event-${seq}`, type, sessionKey: key, envConnectionId: 'local', remoteEventId: cursor(seq), ts: seq, payload: session });
    seq++; session = { ...session, status: 'idle', runCompletedAt: seq, runtime: { phase: 'completed', sync: 'syncing', turnId: 'turn-1' } };
    const before = reads, start = Date.now();
    await emit('run.completed');
    while (reads === before && Date.now() - start < 1500) await page.waitForTimeout(20);
    assert.ok(reads > before && Date.now() - start < 1500, 'terminal evidence immediately invalidates history, bypassing ordinary 5–10s spacing');
    assert.equal(await page.evaluate(() => window.notified.length), 0, 'syncing terminal state cannot notify');
    seq++; text = 'Final response is now rendered'; held = true;
    session = { ...session, runtime: { ...session.runtime, sync: 'current' } };
    await emit('session.updated');
    await waitForHeldRead();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.notified.length), 0, 'notification waits for in-flight final read');
    held = false; release(); release = undefined;
    await page.waitForFunction(() => window.notified.length === 1);
    const notice = await page.evaluate(() => window.notified[0]);
    assert.ok(notice.body.includes(text), 'rendered final reply precedes notification');
    assert.ok(!notice.body.includes('Run finished · syncing history'), 'rendered session metadata is current before notification');
    await emit('run.completed'); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.notified.length), 1, 'duplicate terminal event cannot notify twice');
    seq++; session = { ...session, status: 'running', runtime: { phase: 'running', sync: 'current', turnId: 'turn-2' } };
    await emit('session.updated'); await page.waitForTimeout(100);
    seq++; session = { ...session, status: 'idle', runtime: { phase: 'completed', sync: 'current', turnId: 'turn-2' } }; held = true;
    await emit('run.completed');
    await waitForHeldRead();
    seq++; session = { ...session, status: 'running', runtime: { phase: 'running', sync: 'current', turnId: 'turn-3' } };
    await emit('session.updated'); held = false; release(); release = undefined;
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.notified.length), 1, 'successor run cancels pending old notification');
    assert.deepEqual(errors, []);
    await verifyFence(page, denied);
    console.log(JSON.stringify({ width: viewport.width, immediateTerminalRead: true, readBeforeNotification: true, renderBeforeNotification: true, duplicateSuppressed: true, successorCancelled: true, modelCalls: 0 }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
