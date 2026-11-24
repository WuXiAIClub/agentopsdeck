import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
assert.ok(process.env.AOD_TEST_WEB_ROOT, 'Set AOD_TEST_WEB_ROOT to an isolated production build');
const server = await createServer({
  root: process.env.AOD_TEST_WEB_ROOT,
  configFile: false, envFile: false, plugins: [],
  logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM
    ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const mode of ['classic', 'os-desktop']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const scope = 'a'.repeat(64);
    const sessions = ['Saved window', 'Chat-only session'].map((title, index) => ({
      sessionKey: `local:${btoa(`codex:visibility-${index}`)}`, title, agentId: 'codex', source: 'codex',
      envConnectionId: 'local', status: 'idle', messageCount: 2, lastActiveAt: index + 1,
    }));
    const targetKey = sessions[1].sessionKey;
    const requests = [], errors = [], denied = [];
    let revision = 1;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) {
        assert.equal(request.method(), 'GET');
        return route.continue();
      }
      const json = body => route.fulfill({ json: body });
      if (request.method() !== 'GET') return route.fulfill({ status: 404, json: {} });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions }], sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready' }] });
      if (url.pathname.endsWith('/messages')) {
        const key = decodeURIComponent(url.pathname.split('/').at(-2));
        requests.push({ key, revision });
        return json({ messages: [
          { id: 'input', sessionKey: key, role: 'user', text: `INPUT ${key}`, createdAt: 1 },
          { id: 'reply', sessionKey: key, role: 'assistant', text: `REPLY ${revision} ${key}`, createdAt: 2 },
        ], revision: `${key}:${revision}`, totalCount: 2, hiddenCount: 0 });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.hostname !== '127.0.0.1') denied.push(socket.url());
      socket.close();
    });
    await context.addInitScript(({ scope, mode, firstKey }) => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem(`agentopsdeck:ui-mode:v1:${scope}`, mode);
      localStorage.setItem('agentopsdeck:ui-mode:last', mode);
      localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify({
        id: 'current', name: 'Current', workspace: { version: 2,
          panes: [{ id: 'saved-pane', sessionKey: firstKey }], dock: { kind: 'pane', id: 'saved-pane' },
          floating: [], active: 'saved-pane' }, collapsedKeys: [],
      }));
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.visibilityFixtureEvent = event => {
        for (const stream of streams) if (stream.readyState === 1) {
          stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
        }
      };
    }, { scope, mode, firstKey: sessions[0].sessionKey });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/${mode === 'os-desktop' ? '#/desktop' : ''}`);
    await page.waitForFunction(() => document.querySelector('[data-session-pane]')?.textContent.includes('REPLY 1'));
    if (mode === 'os-desktop') {
      await page.getByTestId('os-taskbar-wechat-btn').click();
      await page.getByTestId('os-wechat-session-row').filter({ hasText: 'Chat-only session' }).click();
    } else {
      await page.locator('#desktop-session-list').getByText('Chat-only session', { exact: true }).click();
    }
    const target = page.locator('[data-session-pane]').filter({ has: page.locator(`[data-message-search-id="reply"]`) }).filter({ hasText: targetKey });
    await target.getByText(`REPLY 1 ${targetKey}`, { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
    const before = requests.length;
    revision = 2;
    await page.evaluate(sessionKey => window.visibilityFixtureEvent({ type: 'message.created', sessionKey }), targetKey);
    await target.getByText(`REPLY 2 ${targetKey}`, { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(requests.slice(before).some(request => request.key === targetKey && request.revision === 2));
    if (mode === 'os-desktop') {
      await page.getByTestId('os-taskbar-wechat-btn').click();
      const closedReads = requests.filter(request => request.key === targetKey).length;
      revision = 3;
      await page.evaluate(sessionKey => window.visibilityFixtureEvent({ type: 'message.created', sessionKey }), targetKey);
      await page.waitForTimeout(1000);
      assert.equal(requests.filter(request => request.key === targetKey).length, closedReads);
      await page.getByTestId('os-taskbar-wechat-btn').click();
      await target.getByText(`REPLY 3 ${targetKey}`, { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('.os-wechat-chat-header').getByRole('button', { name: 'Pop out to standalone window', exact: true }).click();
      await page.locator('.os-desktop-window').filter({ hasText: 'Chat-only session' })
        .getByText(`REPLY 3 ${targetKey}`, { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(denied, []);
    console.log(JSON.stringify({ mode, initialAndLiveMessages: 'pass', historyReads: requests.length }));
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
