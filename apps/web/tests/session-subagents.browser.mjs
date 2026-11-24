// Production UI, intercepted synthetic APIs only. No native model calls or business writes.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN'], [320, 'en']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const key = 'local:codex-subagent-fixture', errors = [], writes = [], start = Date.now() - 12000;
    let scenario = 'waiting';
    await context.addInitScript(locale => {
      localStorage.setItem('agentopsdeck.locale', locale);
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, locale);
    const observation = (status = 'running') => ({ action: 'wait', source: scenario === 'history' ? 'history' : 'live',
      ...(scenario === 'history' ? {} : { observedAt: start }),
      task: '<script>window.BAD = true</script> ' + 'review_long_task_'.repeat(30),
      agents: [{ id: 'child', path: '/root/tests', status, message: 'Checking isolated tests' }] });
    const message = (id, toolPhase, metadata) => ({ id, sessionKey: key, turnId: 'turn', role: 'tool', toolName: 'wait',
      toolPhase, toolCallId: 'wait-1', status: toolPhase === 'call' ? 'sending' : 'sent', text: 'Native wait observation',
      createdAt: start + (toolPhase === 'result' ? 1000 : 0), codexSubagent: metadata });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return json({ items: [] }); // Read-only polling, not a session action.
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: scenario, groups: [{ agentId: 'codex', sessions: [{ sessionKey: key,
        envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Subagent fixture', status: 'running', hasActiveRun: true,
        runtime: { turnId: 'turn', phase: 'running', sync: scenario === 'sync-error' ? 'error' : 'current',
          connection: scenario === 'disconnected' ? 'disconnected' : 'connected', threadActivity: 'active', lastEventAt: start } }] }] });
      if (url.pathname.endsWith('/messages')) {
        const messages = [message('call', 'call', observation())];
        if (['wait-ended', 'completed', 'errored', 'notFound'].includes(scenario)) {
          messages.push(message('result', 'result', { ...observation(scenario === 'wait-ended' ? 'running' : scenario), observedAt: start + 1000 }));
        }
        if (scenario === 'old-turn') messages[0].turnId = 'old';
        return json({ limits: { maxMessageChars: 100000 }, revision: scenario, totalCount: messages.length, hiddenCount: 0, messages });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    const card = page.locator(`[data-session-card="${key}"]`);
    for (scenario of ['waiting', 'wait-ended', 'completed', 'errored', 'notFound', 'history', 'disconnected', 'sync-error', 'old-turn']) {
      await page.goto(origin);
      await card.waitFor();
      if (width < 700 || scenario === 'waiting') await card.click();
      const details = page.locator('.subagent-notice');
      if (scenario === 'old-turn') {
        await page.locator(width > 700 ? '.desktop-composer-textarea' : '.mobile-composer-textarea').waitFor();
        await details.waitFor({ state: 'hidden' });
        continue;
      }
      await details.waitFor();
      const waiting = String(['waiting', 'history'].includes(scenario));
      await page.locator(`.subagent-notice[data-subagent-waiting="${waiting}"]`).waitFor();
      await details.locator('summary').click();
      const text = await details.innerText();
      assert.ok(text.includes('Checking isolated tests')); assert.ok(text.includes('<script>window.BAD = true</script>'));
      assert.equal(await details.locator('script').count(), 0); assert.equal(await page.evaluate(() => window.BAD), undefined);
      const expected = ['completed', 'errored', 'notFound'].includes(scenario) ? scenario : 'running';
      await details.locator(`[data-child-status="${expected}"]`).waitFor();
      assert.equal(await details.locator('[data-child-status]').getAttribute('data-child-status'), expected);
      if (scenario === 'history') assert.ok(text.includes(locale === 'en' ? 'Duration unknown' : '时长未知'));
      if (['disconnected', 'sync-error'].includes(scenario)) {
        assert.ok(text.includes(locale === 'en' ? 'last known observations' : '显示上次观测'));
      }
      const bounds = await details.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `fits ${width}/${scenario}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (scenario === 'waiting') {
        const before = await details.locator('[data-child-status]').innerText();
        await page.waitForFunction(previous => document.querySelector('.subagent-notice [data-child-status]')?.textContent !== previous,
          await details.locator('[data-child-status]').textContent());
        assert.notEqual(await details.locator('[data-child-status]').innerText(), before, 'live receipt span advances');
      }
      const input = page.locator(width > 700 ? '.desktop-composer-textarea' : '.mobile-composer-textarea');
      await input.fill('Draft only; do not send');
      await details.locator('summary').click(); await details.locator('summary').click();
      assert.equal(await input.inputValue(), 'Draft only; do not send');
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`PASS subagents ${width}/${locale}: wait/result, terminal states, history timing, stale evidence, turn isolation, inert content, draft preserved, no writes`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
