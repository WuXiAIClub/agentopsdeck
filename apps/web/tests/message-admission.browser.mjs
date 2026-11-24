// Real desktop/mobile UI with synthetic APIs. No production writes or native turns.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = process.env.AOD_TEST_WEB_ROOT;
const server = root ? await preview({ root, configFile: false, build: { outDir: root }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
    plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
if (!root) await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const sessionKey = 'local:Y29kZXg6YWRtaXNzaW9u';
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const width of [1440, 390, 320]) for (const mode of ['busy', 'idle', 'lost-ack', ...(width === 1440 ? ['stale-read'] : [])]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = [], receipts = new Map(), pendingHistory = [];
    let releaseAdmission, historyBlocked = false, queueState = 'queued', queueReads = 0, receiptReads = 0, active = mode !== 'idle';
    let recoveredHistory = [];
    let submitted;
    const submissionReady = new Promise(resolve => { submitted = resolve; });
    let holdPreSend = false, preSendRoute, sawPreSend;
    const preSendReady = new Promise(resolve => { sawPreSend = resolve; });
    const session = () => ({ sessionKey, envConnectionId: 'local', title: 'Admission fixture', agentId: 'codex', source: 'codex',
      status: active ? 'running' : 'idle', hasActiveRun: active, lastActiveAt: 1 });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { errors.push(`unexpected origin: ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (request.method() === 'POST' && url.pathname.endsWith('/messages')) {
        const body = request.postDataJSON(); writes.push(body);
        assert.equal(request.headers()['x-agentopsdeck-recovery-scope'], 'a'.repeat(64));
        const response = { ok: true, status: 'queued', idempotencyKey: body.idempotencyKey,
          admission: { createdAt: Date.now(), queueVersion: 'opaque:1', disposition: mode === 'idle' ? 'preparing' : 'waiting' } };
        receipts.set(body.idempotencyKey, { id: body.idempotencyKey, key: body.idempotencyKey, state: 'accepted',
          createdAt: 1, updatedAt: 2, result: { status: 200, body: response } });
        historyBlocked = true;
        await new Promise(resolve => { releaseAdmission = resolve; submitted(); });
        active = true;
        return mode === 'lost-ack' ? route.abort('failed') : json(response);
      }
      if (request.method() !== 'GET') { errors.push(`unexpected mutation: ${url.pathname}`); return route.abort(); }
      if (url.pathname.includes('/commands/')) {
        receiptReads++;
        const command = receipts.get(decodeURIComponent(url.pathname.split('/').at(-1)));
        return command ? json({ command }) : route.fulfill({ status: 404, json: { error: 'missing' } });
      }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ updatedAt: Date.now(), revision: `state:${active}`, viewKey: 'fixture',
        sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready', hiddenCount: 0, archivedCount: 0, pinnedCount: 0 }],
        groups: [{ agentId: 'codex', sessions: [session()] }] });
      if (url.pathname.endsWith('/messages')) {
        if (holdPreSend && !preSendRoute) { preSendRoute = route; sawPreSend(); return; }
        if (historyBlocked) { pendingHistory.push(route); return; }
        return json({ updatedAt: recoveredHistory.length ? Date.now() : 1, revision: recoveredHistory.length ? 'recovered' : 'history:1', hiddenCount: 0,
          messages: [{ id: 'assistant', sessionKey, role: 'assistant', text: 'Ready for admission test', status: 'sent', createdAt: 1 }, ...recoveredHistory] });
      }
      if (url.pathname.endsWith('/queue')) {
        queueReads++;
        return json({ items: writes.map(write => ({ id: write.idempotencyKey, createdAt: 1, version: 'opaque:1', state: queueState })), nextCursor: null });
      }
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.admissionEvent = event => { for (const stream of streams) if (stream.readyState === 1)
        stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id })); };
    });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.getByText('Ready for admission test', { exact: true }).waitFor();
    const composer = page.locator('form textarea').last();
    const text = `${mode}: history must not gate delivery`;
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const bubble = page.locator('article').filter({ hasText: text });
    await bubble.waitFor();
    if (mode !== 'idle') await bubble.locator('[data-delivery="submitting"]').waitFor();
    else assert.equal(await bubble.locator('[data-delivery="submitting"], [data-delivery="queued"]').count(), 0);
    await submissionReady;
    if (mode === 'stale-read') {
      // Hold a pre-ACK snapshot after submission begins; newer composer guards
      // can disable a fresh send while an earlier history request is pending.
      holdPreSend = true;
      await page.evaluate(sessionKey => window.admissionEvent({ id: 'before-ack', type: 'message.updated', sessionKey, ts: 1, payload: {} }), sessionKey);
      await preSendReady;
    }
    // The POST is intentionally held until the UI has displayed submitting.
    assert.equal(typeof releaseAdmission, 'function');
    releaseAdmission();
    if (mode !== 'idle') {
      await bubble.locator('[data-delivery="queued"]').waitFor();
      await bubble.getByRole('button', { name: 'Cancel delivery', exact: true }).waitFor();
      assert.equal(await bubble.getByRole('button', { name: 'Edit', exact: true }).isEnabled(), true);
    }
    await composer.fill('Next message without waiting for history');
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Send message"]')?.disabled);
    assert.equal(writes.length, 1, 'no resubmission');
    assert.ok(historyBlocked);
    if (mode === 'stale-read') {
      assert.ok(pendingHistory.length > 0, 'post-admission refresh must not join the held pre-admission GET');
      await preSendRoute.fulfill({ json: { updatedAt: 2, revision: 'old-history', hiddenCount: 0, messages: [
        { id: writes[0].idempotencyKey, sessionKey, role: 'user', text, createdAt: 2, status: 'queued' },
      ] } });
      await bubble.getByRole('button', { name: 'Cancel delivery', exact: true }).waitFor();
      assert.equal(await page.locator('article').filter({ hasText: text }).count(), 1);
    }
    for (const route of pendingHistory.splice(0)) await route.fulfill({ status: 503, json: { error: 'synthetic history unavailable' } });
    assert.equal(await bubble.locator('[data-delivery="queued"]').count(), mode === 'idle' ? 0 : 1);
    assert.equal(await page.getByText('Send failed — message was not delivered.', { exact: true }).count(), 0);
    if (mode === 'lost-ack') assert.ok(receiptReads > 0, 'recover the original receipt');
    if (mode !== 'idle') {
      queueState = 'dispatching';
      await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:commands-changed')));
      await bubble.getByText('Starting…', { exact: true }).waitFor();
      assert.equal(await bubble.getByRole('button', { name: 'Cancel delivery', exact: true }).count(), 0);
    }
    assert.ok(queueReads > 0);
    const delayedNotice = page.locator('[data-admission-history-notice]');
    await delayedNotice.waitFor();
    assert.equal(await delayedNotice.getAttribute('role'), 'status');
    assert.match(await delayedNotice.getAttribute('class'), /text-amber-800/);
    assert.equal(await delayedNotice.textContent(), 'Message accepted · history sync delayed. Do not resend.');
    // Read recovery confirms the original admission without a second POST.
    recoveredHistory = [{ id: writes[0].idempotencyKey, sessionKey, role: 'user', text,
      createdAt: Date.now(), status: 'sent' }];
    historyBlocked = false;
    for (const route of pendingHistory.splice(0)) await route.fulfill({ json: {
      updatedAt: Date.now(), revision: 'recovered', hiddenCount: 0, messages: recoveredHistory,
    } });
    await page.evaluate(sessionKey => window.admissionEvent({ id: 'recovered', type: 'message.updated', sessionKey,
      ts: Date.now(), payload: {} }), sessionKey);
    await delayedNotice.waitFor({ state: 'detached' });
    assert.equal(writes.length, 1, 'history recovery must not resend');
    assert.equal(await composer.inputValue(), 'Next message without waiting for history');
    if (mode === 'stale-read') {
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      const hiddenReads = queueReads;
      await page.waitForTimeout(3400);
      assert.equal(queueReads, hiddenReads, 'hidden chat must not keep polling its queue');
    }
    assert.equal(await page.getByText('sent one at a time', { exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, mode, posts: writes.length, receiptReads, queueReads, historyBlocked, result: 'passed' }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
