import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';

assert.ok(process.env.AOD_TEST_WEB_DIST, 'Explicit candidate web dist is required');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  build: { outDir: process.env.AOD_TEST_WEB_DIST }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const cases = [
    { name: 'running', phase: 'running', threadActivity: 'running', sync: 'current', recovery: false, compact: true },
    { name: 'waiting', phase: 'waiting', threadActivity: 'waiting', sync: 'current', recovery: false, compact: true },
    { name: 'finalizing', phase: 'finalizing', threadActivity: 'idle', sync: 'current', recovery: false, compact: true },
    { name: 'live-syncing', phase: 'running', threadActivity: 'running', sync: 'syncing', recovery: false, compact: true },
    { name: 'successor', phase: 'failed', threadActivity: 'running', sync: 'error', recovery: false },
    { name: 'failed-ready', phase: 'failed', threadActivity: 'idle', sync: 'current', recovery: false },
    { name: 'failed-history', phase: 'failed', threadActivity: 'idle', sync: 'error', recovery: true },
    { name: 'unknown', phase: 'unknown', threadActivity: 'unknown', sync: 'current', recovery: true },
    { name: 'reported-error', phase: 'running', threadActivity: 'running', sync: 'current', recovery: true,
      reason: 'Codex reported an error · waiting for final run status' },
  ];
  let verified = 0;
  for (const width of [1440, 390]) {
    for (const fixture of cases) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, serviceWorkers: 'block' });
      try {
        const key = 'local:codex-recovery-fixture', errors = [];
        await context.addInitScript(() => {
          localStorage.setItem('agentopsdeck.locale', 'en');
          window.EventSource = class extends EventTarget {
            readyState = 1;
            static OPEN = 1;
            constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
            close() { this.readyState = 2; }
          };
        });
        const denied = await fenceContext(context, { origin, apiWrites: [
          { method: 'POST', path: '/api/hub/v1/completions/summary' },
          { method: 'POST', path: '/api/hub/v1/completions/observe' },
        ], api: async route => {
          const request = route.request(), url = new URL(request.url());
          const json = body => route.fulfill({ json: body });
          if (request.method() === 'POST' && url.pathname.endsWith('/completions/summary')) return json({ items: [] });
          if (request.method() === 'POST' && url.pathname.endsWith('/completions/observe')) return route.fulfill({ status: 404, json: {} });
          if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
          if (url.pathname.endsWith('/sessions/state')) return json({ revision: fixture.name, groups: [{ agentId: 'codex', sessions: [{
            sessionKey: key, envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Recovery fixture',
            status: fixture.phase === 'failed' ? 'failed' : 'running', hasActiveRun: fixture.phase !== 'failed',
            sessionRef: { nodeId: 'synthetic-node', runtimeId: 'codex', nativeSessionKey: 'codex:synthetic' },
            runStartedAt: Date.now() - 180_000,
            runtime: { turnId: 'synthetic-turn', phase: fixture.phase, threadActivity: fixture.threadActivity,
              sync: fixture.sync, connection: 'connected', reason: fixture.reason, lastEventAt: Date.now() },
          }] }] });
          if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 1,
            hiddenCount: 0, messages: [{ id: 'reply', sessionKey: key, role: 'assistant', status: 'sent',
              phase: 'commentary', turnId: 'synthetic-turn', text: 'Synthetic progress', createdAt: 19 }] });
          if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
          if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
          if (url.pathname === '/api/gateway/status') return json({ connected: true });
          return route.fulfill({ status: 404, json: {} });
        } });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin);
        await page.locator(`[data-session-card="${key}"]`).click();
        await page.getByText('Synthetic progress', { exact: true }).waitFor();
        const notice = page.locator('[data-chat-activity] > [role="status"]');
        await notice.waitFor();
        const recovery = notice.getByRole('button', { name: 'Recover session', exact: true });
        assert.equal(await recovery.count(), fixture.recovery ? 1 : 0, `${width}/${fixture.name}: recovery visibility`);
        if (fixture.compact) {
          const box = await notice.boundingBox();
          assert.ok(box.height <= 32, `${width}/${fixture.name}: normal notice height ${box.height}`);
          assert.ok((await notice.getAttribute('class')).includes('text-blue-700'));
        }
        if (fixture.recovery) assert.ok((await notice.getAttribute('class')).includes('text-amber-800'));
        assert.deepEqual(errors, []);
        await verifyFence(page, denied);
        verified += 1;
        console.log(`PASS ${width}/${fixture.name}`);
      } finally { await context.close(); }
    }
  }
  console.log(JSON.stringify({ passed: true, verified, businessRequests: 0, recoveryRequests: 0, desktopAndTouchViewport: true }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
