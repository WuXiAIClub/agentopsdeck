// Real desktop/mobile handlers, synthetic HTTP only; no native runtime.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const sessionKey = 'local:c3ludGhldGlj';
    const session = { sessionKey, envConnectionId: 'local', title: 'Synthetic compact chat', agentId: 'main', source: 'openclaw', status: 'idle', lastActiveAt: 1 };
    const writes = [], external = [], errors = [];
    let unknown = true;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (req.method() !== 'GET') {
        writes.push([req.method(), url.pathname]);
        assert.equal(req.method(), 'POST');
        assert.equal(url.pathname, `/api/sessions/${encodeURIComponent(sessionKey)}/compact`);
        return unknown ? route.fulfill({ status: 202, json: { status: 'outcome_unknown', idempotencyKey: 'synthetic' } })
          : json({ status: 'started', message: 'Synthetic compact request acknowledged.' });
      }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') return json({ groups: [{ agentId: 'main', sessions: [session] }], updatedAt: 1, revision: 'synthetic' });
      if (url.pathname.endsWith('/messages')) return json({ messages: [], updatedAt: 1, revision: 'synthetic' });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'main', name: 'Main' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      window.EventSource = class extends EventTarget {
        readyState = 1;
        static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByText(session.title, { exact: true }).first().click();
    await page.getByRole('button', { name: 'Compact session', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Compact outcome unknown.' }).waitFor();
    await page.waitForTimeout(1100);
    assert.equal(writes.length, 1, 'unknown response must not trigger an automatic retry');
    assert.equal(await page.getByText(/Compact requested\./).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Acknowledged branch uses an explicit new user action, not recovery/replay.
    unknown = false;
    await page.getByRole('button', { name: 'Compact session', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Synthetic compact request acknowledged.' }).waitFor();
    assert.equal(writes.length, 2);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Compact browser: desktop/mobile unknown notice, no automatic replay, acknowledged notice and layout passed.');
} finally { await browser?.close(); await server.close(); }
