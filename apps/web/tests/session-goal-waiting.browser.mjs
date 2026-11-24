// Built app, synthetic APIs only; never sends a business message.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
if (!process.env.AOD_TEST_WEB_DIST) throw new Error('Explicit candidate AOD_TEST_WEB_DIST is required');
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, build: { outDir: process.env.AOD_TEST_WEB_DIST },
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN'], [320, 'en']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const key = 'local:codex-goal-fixture', errors = [], writes = [];
    let sync = 'current', nativeGoal;
    await context.addInitScript(locale => {
      localStorage.setItem('agentopsdeck.locale', locale);
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, locale);
    const denied = await fenceContext(context, { origin, apiWrites: [
      { method: 'POST', path: '/api/hub/v1/completions/summary' },
      { method: 'POST', path: '/api/hub/v1/completions/observe' },
    ], api: async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      // Explicit synthetic read/observe POSTs only; no input/queue/Goal write.
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { items: [] } });
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/observe') return route.fulfill({ status: 404, json: {} });
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: `${sync}:${nativeGoal?.status ?? 'legacy'}`, groups: [{ agentId: 'codex', sessions: [{ sessionKey: key,
        envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Goal waiting fixture', status: 'idle', hasActiveRun: false,
        codexGoal: nativeGoal,
        runtime: { turnId: 't', phase: 'completed', sync, connection: 'connected', threadActivity: 'idle', lastEventAt: 20,
          executionProtection: { state: 'blocked', nativeTurnId: 't', reason: 'goal-blocked' } } }] }] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 3,
        hiddenCount: 0, messages: [
          { id: 'tool1', sessionKey: key, role: 'tool', toolName: 'exec_command', toolPhase: 'result', toolCallId: 'call1', text: 'First tool result', createdAt: 17 },
          { id: 'tool2', sessionKey: key, role: 'tool', toolName: 'read_file', toolPhase: 'result', toolCallId: 'call2', text: 'Second tool result', createdAt: 18 },
          { id: 'reply', sessionKey: key, role: 'assistant', status: 'sent', phase: 'final_answer', turnId: 't', text: 'Latest reply preserved', createdAt: 19 }] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    } });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    const card = page.locator(`[data-session-card="${key}"]`);
    await card.waitFor(); assert.equal(await card.getAttribute('data-session-state'), 'completed');
    await card.click(); await page.getByText('Latest reply preserved', { exact: true }).waitFor();
    const label = locale === 'en' ? 'Long-term goal paused' : '长期目标暂停';
    await page.getByText(label, { exact: true }).first().waitFor();
    await page.getByText(locale === 'en' ? 'Done · ready for your next message' : '已完成 · 可以发送下一条消息', { exact: true }).waitFor();
    await page.locator('.goal-pause-notice summary').click();
    assert.equal(await page.locator('.goal-pause-notice p').isVisible(), true);
    await page.locator('.goal-pause-notice summary').click();
    assert.equal(await page.getByText(/Native goal blocked|原生目标已阻塞|Agent is working/).count(), 0);
    const input = page.locator(width > 700 ? '.desktop-composer-textarea' : '.mobile-composer-textarea');
    await input.fill('Draft only; do not send');
    const send = page.getByRole('button', { name: locale === 'en' ? 'Send message' : '发送消息', exact: true });
    assert.equal(await send.isEnabled(), true);
    if (width > 700) {
      assert.equal((await send.innerText()).trim(), 'Send'); assert.equal(await input.getAttribute('placeholder'), 'Message this agent…');
      const refresh = page.getByRole('button', { name: 'Refresh and release resources', exact: true });
      await refresh.click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await input.inputValue(), 'Draft only; do not send');
      const saved = await page.evaluate(() => {
        // Sentinels ensure the button never blanket-clears any browser storage.
        localStorage.setItem('agentopsdeck.notebook.refresh-test', 'retained notebook');
        sessionStorage.setItem('agentopsdeck.receipt.refresh-test', 'retained receipt');
        window.refreshDocumentMarker = 'old';
        return Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('layout')));
      });
      await refresh.click();
      await Promise.all([page.waitForNavigation(), page.getByRole('dialog').getByRole('button', { name: 'Refresh', exact: true }).click()]);
      await page.getByText('Latest reply preserved', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Draft only; do not send');
      const retained = await page.evaluate(() => ({ marker: window.refreshDocumentMarker,
        note: localStorage.getItem('agentopsdeck.notebook.refresh-test'), receipt: sessionStorage.getItem('agentopsdeck.receipt.refresh-test'),
        layouts: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('layout'))) }));
      assert.equal(retained.marker, undefined, 'new document discards old JS heap');
      assert.equal(retained.note, 'retained notebook'); assert.equal(retained.receipt, 'retained receipt');
      assert.deepEqual(retained.layouts, saved);
      // A denied draft write must block reload instead of silently losing text.
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (this === sessionStorage) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          return original.call(this, key, value);
        };
      });
      await input.fill('Unsaved local draft');
      await refresh.click();
      await page.locator('.global-refresh-blocked').waitFor();
      assert.equal(await page.locator('.action-dialog[open]').count(), 0);
      assert.equal(await input.inputValue(), 'Unsaved local draft');
    } else {
      assert.ok((await page.locator('.session-state-header').boundingBox()).height < 110, 'phone header must leave room for chat');
      const tools = page.locator('.mobile-tool-pill');
      assert.equal(await tools.count(), 2);
      assert.equal(await tools.locator('strong, em').count(), 0, 'short chains also default to number-only');
      const geometry = await tools.first().evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight, radius: getComputedStyle(node).borderRadius }));
      assert.equal(geometry.width, geometry.height); assert.equal(geometry.radius, '50%');
      await tools.first().click(); await page.locator('.mobile-tool-strip-detail').waitFor();
      assert.match(await page.locator('.mobile-tool-strip-detail').innerText(), /First tool result/);
      await tools.first().click();
      assert.equal(await page.getByRole('button', { name: locale === 'en' ? 'Stop current run' : '停止当前运行', exact: true }).count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
      nativeGoal = { status, objective: '<script>not executable</script> ' + '目标'.repeat(900), objectiveTruncated: true,
        tokenBudget: status === 'active' ? null : 0, tokensUsed: 1234, timeUsedSeconds: 17, createdAt: 1, updatedAt: 2 };
      await page.reload();
      if (width < 700) await card.click();
      const details = page.locator(`[data-goal-status="${status}"]`);
      try { await details.waitFor(); }
      catch (error) { console.error({ width, status, errors, text: await page.locator('body').innerText() }); throw error; }
      await details.locator('summary').click();
      assert.ok((await details.innerText()).includes('1,234'));
      assert.ok((await details.innerText()).includes('<script>not executable</script>'));
      if (status !== 'active') assert.ok((await details.innerText()).includes(locale === 'en' ? 'Goal tokens remaining: 0' : '目标剩余 token: 0'));
      if (status === 'paused') assert.ok((await details.innerText()).includes(locale === 'en'
        ? 'Pausing the goal does not confirm' : '目标暂停不代表'));
      if (status === 'budgetLimited' || status === 'usageLimited') assert.ok((await details.innerText()).includes(locale === 'en'
        ? 'the goal is not marked complete' : '目标尚未标记为完成'));
      assert.equal(await details.locator('script').count(), 0);
      const bounds = await details.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `goal fits ${width}`);
      assert.equal(await page.getByText(label, { exact: true }).count(), 0, 'native status replaces ambiguous paused fallback');
    }
    sync = 'error'; await page.reload();
    if (width < 700) await card.click();
    const errorLabel = locale === 'en' ? 'History sync interrupted' : '消息同步暂时中断';
    if (width < 700) {
      await page.locator(`.history-sync-issue summary[aria-label="${errorLabel}"]`).first().waitFor();
    } else {
      // Desktop status text lives in the compact indicator/popover, not a
      // permanently visible header label. Open the real status control.
      await page.locator(`.pane-status-indicator[title="${errorLabel}"]`).first().click();
      await page.locator(`.history-sync-issue summary[aria-label="${errorLabel}"]`).first().waitFor();
    }
    assert.equal(await page.locator('.session-state-header').first().getAttribute('data-session-state'), 'error');
    assert.equal(await page.getByText(label, { exact: true }).count(), 0);
    assert.equal(await page.locator('[data-goal-status]').count(), 0, 'sync errors do not expose stale goal as current');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); await verifyFence(page, denied);
    console.log(`PASS built app ${width}/${locale}: completed turn + separate paused goal, compact phone tools/header, safe desktop reload, real sync errors, no writes`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
