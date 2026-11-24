// Production UI fixture: synthetic auth/status only, never native services.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
if (!process.env.AOD_TEST_WEB_DIST) throw new Error('Explicit candidate AOD_TEST_WEB_DIST is required');
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  build: { outDir: process.env.AOD_TEST_WEB_DIST }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390, 320]) for (const authenticated of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = []; let statusReads = 0;
    await context.addCookies([{ name: 'agentopsdeck_session', value: 'synthetic-existing-session', url: origin, httpOnly: true }]);
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem('startup-auth-saved-view', 'retain-existing-layout-and-unsent-draft');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    const denied = await fenceContext(context, { origin, apiWrites: [
      { method: 'POST', path: '/api/hub/v1/completions/summary' },
      { method: 'POST', path: '/api/hub/v1/completions/observe' },
    ], api: async route => {
      const req = route.request(), url = new URL(req.url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { items: [] } });
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/observe') return route.fulfill({ status: 404, json: {} });
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') {
        statusReads++;
        if (statusReads === 1) return route.fulfill({ status: 503, json: { error: 'auth_persistence_failed' } });
        return json({ authenticated, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      }
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: [{
        sessionKey: 'local:startup-auth-existing', envConnectionId: 'local', source: 'codex', agentId: 'codex',
        title: 'Existing session after read-only recovery', status: 'idle', hasActiveRun: false, messageCount: 4, runCompletedAt: 100,
        runtime: { phase: 'completed', threadActivity: 'idle', connection: 'connected', sync: 'current', lastEventAt: 100 },
      }] }] });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    } });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Retry sign-in check', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Welcome to AgentOpsDeck' }).count(), 0);
    assert.equal(statusReads, 1, 'failed status must not auto retry or fabricate sign-out');
    await page.getByRole('button', { name: 'Retry sign-in check', exact: true }).click();
    if (authenticated) await page.locator('[data-session-card="local:startup-auth-existing"]').waitFor();
    else await page.getByRole('heading', { name: 'Welcome to AgentOpsDeck' }).waitFor();
    assert.equal(statusReads, 2, 'manual recovery dispatches one GET only');
    assert.equal((await context.cookies()).find(cookie => cookie.name === 'agentopsdeck_session')?.value, 'synthetic-existing-session');
    assert.equal(await page.evaluate(() => localStorage.getItem('startup-auth-saved-view')), 'retain-existing-layout-and-unsent-draft');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (authenticated) await context.addInitScript(() => {
      const method = sessionStorage.getItem('test-seen-storage-denial');
      window.seenStorageFailures = 0;
      if (!method) return;
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(key, ...values) {
        if (key.startsWith('agentopsdeck.sessionCompletionSeen:') || key.startsWith('agentopsdeck.sessionMessageSeen:')) {
          window.seenStorageFailures++;
          throw new DOMException('Synthetic optional-storage denial', method === 'getItem' ? 'SecurityError' : 'QuotaExceededError');
        }
        return original.call(this, key, ...values);
      };
    });
    if (authenticated) for (const failure of ['getItem', 'setItem']) {
      await page.evaluate(method => sessionStorage.setItem('test-seen-storage-denial', method), failure);
      await page.reload();
      const card = page.locator('[data-session-card="local:startup-auth-existing"]');
      await card.waitFor();
      await card.click();
      await page.waitForFunction(() => window.seenStorageFailures > 0);
      assert.equal(await page.getByText('Reload this view', { exact: true }).count(), 0, 'seen failures do not enter render recovery');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}: existing completed session renders/activates with denied marker ${failure}`);
    }
    assert.deepEqual(writes, []); assert.deepEqual(errors, []); await verifyFence(page, denied);
    console.log(`PASS ${width}: auth unavailable -> readonly retry -> ${authenticated ? 'existing session' : 'confirmed sign-out'}, cookie/view preserved`);
    await context.close();
  }
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      const appendChild = Node.prototype.appendChild;
      Node.prototype.appendChild = function(child) {
        if (this === document.head && child instanceof HTMLLinkElement && child.rel === 'modulepreload'
          && new URL(child.href).origin === location.origin && /\/assets\/StartupAuth-[^/]+\.js$/.test(new URL(child.href).pathname)) return child;
        return appendChild.call(this, child);
      };
    });
    const errors = [];
    let finishAuth;
    const denied = await fenceContext(context, { origin, api: async route => {
      if (new URL(route.request().url()).pathname === '/api/auth/status') {
        await new Promise(resolve => { finishAuth = resolve; });
        return route.fulfill({ json: { authenticated: false, passkeys: { available: false, count: 0 } } });
      }
      return route.fulfill({ status: 404, json: {} });
    } });
    let finishStartup;
    let startupRequests = 0;
    const startupGate = new Promise(resolve => { finishStartup = resolve; });
    await context.route('**/assets/StartupAuth-*.js', async route => {
      assert.equal(new URL(route.request().url()).origin, origin);
      startupRequests++;
      await startupGate;
      return route.fallback();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/#/desktop`, { waitUntil: 'domcontentloaded' });
    const inspectBoot = async phase => {
      const overlay = page.locator(`[data-testid="os-power-overlay"].${phase}`);
      await overlay.getByRole('status').waitFor();
      const snapshot = await overlay.evaluate(node => ({
        status: node.querySelector('[role="status"]').textContent,
        animations: [node, ...node.querySelectorAll('*')].flatMap(element =>
          [null, '::before', '::after'].map(pseudo => getComputedStyle(element, pseudo).animationName)).filter(name => name !== 'none'),
        progress: node.querySelector('.os-power-progress-bar').getBoundingClientRect().width,
        track: node.querySelector('.os-power-progress-track').getBoundingClientRect().width,
      }));
      assert.match(snapshot.status, /Checking AgentOpsDeck auth/);
      if (reducedMotion === 'reduce') assert.deepEqual(snapshot.animations, [], 'all boot decorations and pseudo-elements stay static');
      else assert.ok(snapshot.animations.length >= 8, 'normal boot decoration keeps its existing animations');
      assert.ok(snapshot.progress > 0 && snapshot.progress < snapshot.track, 'static progress is preserved');
      assert.equal(await overlay.isVisible(), true);
      console.log(`PASS boot ${reducedMotion} ${phase}: ${snapshot.animations.length} computed animated element/pseudo-element entries, visible status/progress`);
    };
    await inspectBoot('is-booting');
    assert.ok(startupRequests > 0, 'actual lazy StartupAuth chunk is held for fallback inspection');
    finishStartup();
    await inspectBoot('is-auth-checking');
    for (let attempt = 0; !finishAuth && attempt < 100; attempt++) await page.waitForTimeout(50);
    assert.ok(finishAuth, 'auth read is held during actual fallback rendering');
    finishAuth();
    await page.getByRole('heading', { name: 'Welcome to AgentOpsDeck' }).waitFor();
    await page.getByTestId('os-power-overlay').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []); await verifyFence(page, denied);
    console.log(`PASS boot ${reducedMotion}: fallback -> auth gate -> welcome lifecycle`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
