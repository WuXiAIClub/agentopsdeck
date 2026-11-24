// Isolated browser acceptance: no live Hub, Connector or user messages.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, serviceWorkers: 'block' });
    const sessionKey = 'local:Y29kZXg6Y2xvc2VvdXQ=';
    let session = { sessionKey, envConnectionId: 'local', title: 'Closeout fixture', agentId: 'codex', source: 'codex',
      status: 'idle', hasActiveRun: false, lastActiveAt: 1, messageCount: 1024 };
    let patches = 0, failNext = false, rejectedReceipt;
    const errors = [], external = [], stops = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (req.method() === 'POST' && url.pathname.endsWith('/messages')) {
        const body = req.postDataJSON(); stops.push(body);
        assert.equal(body.message, '/stop');
        return json({ status: 'interrupt_requested', idempotencyKey: body.idempotencyKey });
      }
      if (req.method() === 'PATCH') {
        patches++;
        assert.equal(url.pathname, `/api/sessions/${encodeURIComponent(sessionKey)}`);
        if (failNext) {
          failNext = false;
          const key = req.headers()['idempotency-key'];
          rejectedReceipt = { id: key, key, state: 'rejected', createdAt: 1, updatedAt: 2, result: { status: 400, body: { error: 'Synthetic rename failure' } } };
          return route.fulfill({ status: 400, json: { error: 'Synthetic rename failure', command: rejectedReceipt } });
        }
        session = { ...session, title: req.postDataJSON().title };
        const key = req.headers()['idempotency-key'], result = { sessionKey, settings: { title: session.title } };
        return json({ ...result, command: { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: result } } });
      }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'b'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ updatedAt: 1, groups: [{ agentId: 'codex', sessions: [session] }] });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname.endsWith('/models/codex')) return json({ models: [] });
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'reply', sessionKey, role: 'assistant', text: 'Closeout response', status: 'sent', createdAt: 1000 }], totalCount: 1024, updatedAt: 1 });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (rejectedReceipt && url.pathname.includes(encodeURIComponent(rejectedReceipt.key))) return json({ command: rejectedReceipt });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      window.fixtureClipboard = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.fixtureClipboard.push(text); },
      } });
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.fixtureEvent = event => { for (const stream of streams) if (stream.readyState === 1) stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })); };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.getByText('Closeout response', { exact: true }).waitFor();
    const footer = page.locator('.message-footer').last();
    const copy = footer.getByRole('button', { name: 'Copy message', exact: true });
    const focus = footer.getByRole('button', { name: 'Focus message', exact: true });
    assert.equal(await focus.locator('svg[aria-hidden="true"] > path').count(), 2, 'compact icon retains decorative semantics');
    const copyBox = await copy.boundingBox(), focusBox = await focus.boundingBox(), timeBox = await footer.locator('time').boundingBox();
    assert.ok(copyBox.x < focusBox.x && focusBox.x < timeBox.x, 'copy/focus precede time');
    assert.ok(Math.abs(copyBox.y + copyBox.height / 2 - timeBox.y - timeBox.height / 2) < 3, 'actions/time share one row');
    assert.equal(copyBox.width, width === 390 ? 34 : 22, 'compact desktop, touch sized on coarse pointer');
    if (width > 700) {
      await page.getByRole('button', { name: 'Session status', exact: true }).click();
      await page.getByText('1,024 msgs', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    await copy.click();
    assert.deepEqual(await page.evaluate(() => window.fixtureClipboard), ['Closeout response']);
    await focus.click();
    await page.locator('[data-message-focus]').waitFor();
    assert.equal(await page.locator('.message-focus-content').innerText(), 'Closeout response');
    await page.keyboard.press('Escape');
    await page.locator('[data-message-focus]').waitFor({ state: 'hidden' });
    assert.ok(await focus.evaluate(el => document.activeElement === el), 'closing the reading dialog restores focus');
    const rename = () => page.getByRole('textbox', { name: 'Rename chat', exact: true });
    const openRename = () => page.getByRole('button', { name: 'Rename chat', exact: true }).click();
    await openRename(); await rename().fill('Saved by blur');
    await page.getByText('Closeout response', { exact: true }).click();
    await rename().waitFor({ state: 'hidden' });
    assert.equal(session.title, 'Saved by blur'); assert.equal(patches, 1);
    await openRename(); await rename().fill('Not saved'); await rename().press('Escape');
    await rename().waitFor({ state: 'hidden' }); assert.equal(patches, 1, 'Escape cancels without writing');
    await openRename(); await rename().fill('   '); await page.getByText('Closeout response', { exact: true }).click();
    await rename().waitFor({ state: 'hidden' }); assert.equal(patches, 1, 'blank blur cancels without writing');
    await openRename(); await rename().fill('Saved by enter'); await rename().press('Enter');
    await rename().waitFor({ state: 'hidden' }); assert.equal(patches, 2, 'Enter plus blur writes once');
    failNext = true;
    await openRename(); await rename().fill('Retryable title'); await page.getByText('Closeout response', { exact: true }).click();
    await page.getByText('Settings rejected; review before trying a new change', { exact: true }).waitFor();
    assert.equal(await rename().inputValue(), 'Retryable title', 'failed rename preserves draft');
    await page.getByRole('button', { name: 'Save chat title', exact: true }).click();
    await rename().waitFor({ state: 'hidden' }); assert.equal(session.title, 'Retryable title'); assert.equal(patches, 4);
    if (width > 700) {
      session = { ...session, status: 'running', hasActiveRun: true, runtime: { phase: 'running', turnId: 'run-original', sync: 'ready' } };
      const update = () => page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessionKey);
      await update();
      const power = page.locator('.pane-emergency-stop');
      await page.waitForFunction(() => !document.querySelector('.pane-emergency-stop')?.disabled);
      await power.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(stops.length, 0, 'cancelling confirmation never submits');
      await power.click();
      session = { ...session, title: 'Next run arrived', runtime: { ...session.runtime, turnId: 'run-next' } };
      await update();
      await page.locator('.session-pane-drag-title').getByText('Next run arrived', { exact: true }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop current run', exact: true }).click();
      await page.getByText('The run changed. Refresh before stopping.', { exact: true }).first().waitFor();
      assert.equal(stops.length, 0, 'changed run is rejected before submission');
      await power.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop current run', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.action-dialog'));
      assert.equal(stops.length, 1);
      assert.equal(stops[0].expectedRunId, 'run-next', 'stop command carries exact confirmed run fence');
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`closeout UI ${width}: footer geometry, touch targets, focus, blur/escape/empty/enter/failure rename passed`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
