// Synthetic production UI acceptance. No native/Hub/Connector service access.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
if (!process.env.AOD_TEST_WEB_DIST) throw new Error('Explicit candidate AOD_TEST_WEB_DIST is required');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await preview({ root, configFile: false, envFile: false,
  build: { outDir: process.env.AOD_TEST_WEB_DIST },
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const key = 'local:codex-continuous-fixture', errors = [], writes = [];
    let sync = 'error', connection = 'connected', threadActivity = 'running', revision = 1;
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
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
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/auth/passkeys') return route.fulfill({ status: 503,
        json: { error: 'synthetic-private-backend-error' }, headers: { 'retry-after': '3' } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: String(revision), groups: [{ agentId: 'codex', sessions: [{
        sessionKey: key, envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Continuous goal fixture',
        status: 'idle', hasActiveRun: false,
        codexGoal: { status: threadActivity === 'idle' ? 'complete' : 'active', objective: 'Synthetic continuous goal',
          tokenBudget: null, tokensUsed: 1234, timeUsedSeconds: 17, createdAt: 1, updatedAt: 2 },
        runtime: { turnId: 'predecessor', phase: 'completed', sync, connection, threadActivity, lastEventAt: 20,
          reason: sync === 'error' ? 'Codex completed, but AgentOpsDeck could not load the final response: Final turn snapshot is incomplete' : undefined,
          executionProtection: { state: 'blocked', nativeTurnId: 'predecessor', reason: 'background-work' } },
      }] }] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: String(revision), totalCount: 2,
        hiddenCount: 0, messages: [
          { id: 'old', sessionKey: key, role: 'assistant', status: 'sent', phase: 'final_answer', turnId: 'predecessor', text: 'Old final reply retained', createdAt: 19 },
          { id: 'new', sessionKey: key, role: 'assistant', status: 'sent', phase: 'commentary', turnId: 'successor', text: 'Successor is still progressing', createdAt: 21 },
        ] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    } });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    const open = async () => {
      await page.goto(origin);
      const card = page.locator(`[data-session-card="${key}"]`);
      await card.waitFor(); await card.click();
      await page.getByText('Old final reply retained', { exact: true }).waitFor();
      await page.getByText('Successor is still progressing', { exact: true }).waitFor();
    };
    await open();
    assert.equal(await page.locator('.session-state-header').first().getAttribute('data-session-state'), 'running');
    await page.locator('[data-chat-activity]').getByText('Previous run finished · thread still active', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-goal-status]').count(), 0, 'history errors must not promote stale Goal metadata');
    const input = page.locator(width > 700 ? '.desktop-composer-textarea' : '.mobile-composer-textarea');
    await input.fill('Retain me across recovery; never send');
    const draft = await input.inputValue();
    for (const state of [
      { threadActivity: 'waiting', sync: 'error', connection: 'connected', label: 'Previous run finished · thread waiting for approval or input' },
      { threadActivity: 'running', sync: 'current', connection: 'connected', label: 'Previous run finished · thread still active' },
      { threadActivity: 'unknown', sync: 'error', connection: 'disconnected', label: undefined },
      { threadActivity: 'idle', sync: 'current', connection: 'connected', label: undefined },
    ]) {
      ({ threadActivity, sync, connection } = state); revision++;
      await open(); assert.equal(await input.inputValue(), draft, 'recovery must retain the unsent draft');
      if (state.label) await page.locator('[data-chat-activity]').getByText(state.label, { exact: true }).waitFor();
      // Reload first renders persisted presentation; wait for the new read
      // before asserting that an old activity label has disappeared.
      if (threadActivity === 'unknown') await page.locator('[data-chat-activity]').getByText('Run finished · history sync incomplete', { exact: true }).waitFor();
      if (threadActivity === 'idle') await page.locator('[data-goal-status="complete"]').waitFor();
      if (threadActivity === 'unknown' || threadActivity === 'idle') {
        assert.equal(await page.locator('[data-chat-activity]').getByText('Previous run finished · thread still active', { exact: true }).count(), 0);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    if (width === 1440) {
      // One production settings smoke; the state/privacy matrix stays in fast unit tests.
      await page.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Browser and sign-in settings', exact: true });
      const level = settings.getByRole('combobox', { name: 'Browser transport diagnostics', exact: true });
      await level.selectOption('debug');
      assert.equal(await page.evaluate(() => window.__agentopsdeckBrowserDiagnostics.level()), 'debug');
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
      await page.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).click();
      await settings.getByText('Passkeys could not be loaded. Check your connection and retry. No changes were made.', { exact: true }).waitFor();
      assert.ok(await page.evaluate(() => window.__agentopsdeckBrowserDiagnostics.read().some(row => row.event === 'request-http' && row.facts.status === 503)));
      const downloaded = page.waitForEvent('download');
      await settings.getByRole('button', { name: 'Download transport diagnostics', exact: true }).click();
      const download = await downloaded;
      assert.equal(download.suggestedFilename(), 'agentopsdeck-browser-diagnostics.json');
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8'), exported = JSON.parse(text);
      assert.equal(exported.version, 1); assert.equal(exported.level, 'debug');
      assert.ok(exported.entries.length > 0 && exported.entries.length <= 160);
      assert.doesNotMatch(text, /synthetic-private|Continuous goal|127\.0\.0\.1|private-message|recoveryScope/);
      await settings.getByRole('button', { name: 'Clear transport diagnostics', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__agentopsdeckBrowserDiagnostics.read()), []);
      await level.selectOption('off');
      assert.equal(await page.evaluate(() => window.__agentopsdeckBrowserDiagnostics.level()), 'off');
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
      await open();
      assert.equal(await page.evaluate(() => window.__agentopsdeckBrowserDiagnostics.level()), 'errors', 'debug must not persist across reload');
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); await verifyFence(page, denied);
    console.log(`PASS ${width}: continuous Goal, old final history error, running/waiting/disconnected/complete, retained draft, no business writes`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
