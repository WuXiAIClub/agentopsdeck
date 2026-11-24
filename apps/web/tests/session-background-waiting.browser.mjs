// Built app with synthetic APIs. No native runtime, process cleanup or message send.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN'], [320, 'en']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const key = 'local:codex-background-fixture', errors = [], writes = [];
    let mode = 'blocked';
    await context.addInitScript(locale => {
      localStorage.setItem('agentopsdeck.locale', locale);
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
    }, locale);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return json({ items: [] }); // Read-only polling, not a session action.
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: mode, groups: [{ agentId: 'codex', sessions: [{ sessionKey: key,
        envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Background waiting fixture', status: 'idle', hasActiveRun: false,
        runStartedAt: 10, runCompletedAt: 20,
        runtime: { turnId: 't', phase: 'completed', sync: mode === 'settled' ? 'current' : 'error',
          connection: mode === 'disconnected' ? 'disconnected' : 'connected', threadActivity: 'idle', lastEventAt: 20,
          ...(mode !== 'settled' ? { reason: 'Codex completed, but AgentOpsDeck could not load the final response: Codex background terminals are still running' } : {}) } }] }] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 1, hiddenCount: 0,
        messages: [{ id: 'reply', sessionKey: key, role: 'assistant', status: 'sent', phase: 'final_answer', turnId: 't', text: 'Reply preserved', createdAt: 19 }] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    const openSession = async () => {
      await page.goto(origin);
      await page.locator(`[data-session-card="${key}"]`).click();
      await page.getByText('Reply preserved', { exact: true }).waitFor();
    };
    await openSession();
    const label = locale === 'en' ? 'Run finished · background terminals still active' : '回合已结束 · 后台终端仍在运行';
    const detail = page.locator('.goal-pause-notice');
    await page.getByText(label, { exact: true }).waitFor();
    await detail.locator('summary').click();
    assert.equal(await detail.locator('p').isVisible(), true);
    assert.match(await detail.innerText(), locale === 'en' ? /Do not resend them/ : /无需重新发送/);
    const geometry = await detail.evaluate(el => {
      const status = el.closest('[role="status"]');
      return { scroll: status.scrollWidth, width: status.clientWidth, right: status.getBoundingClientRect().right, viewport: innerWidth };
    });
    assert.ok(geometry.scroll <= geometry.width + 1 && geometry.right <= geometry.viewport, JSON.stringify(geometry));
    assert.equal(await page.locator('[data-run-outcome="completed"]').count(), 0, 'not verified Done');
    assert.equal(await page.locator('[role="status"] .animate-pulse').count(), 0, 'cleanup wait is not an executing turn');
    mode = 'disconnected'; await openSession();
    await page.getByText(label, { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(label, { exact: true }).count(), 0, 'stale disconnected evidence is not a live cleanup diagnosis');
    assert.equal(await detail.count(), 0);
    mode = 'settled'; await openSession();
    await page.getByText(locale === 'en' ? 'Done · ready for your next message' : '已完成 · 可以发送下一条消息', { exact: true }).waitFor();
    assert.equal(await detail.count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`PASS ${width}px/${locale}: cleanup notice, narrow layout, disconnected fallback, settled notice, zero writes`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
