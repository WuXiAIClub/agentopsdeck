// Real built mobile UI, synthetic APIs only; never sends an Agent message.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false,
  envFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [320, 390, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true,
      hasTouch: true, serviceWorkers: 'block' });
    const sessionKey = 'local:bW9iaWxlLXVp', errors = [], forbidden = [];
    const session = { sessionKey, source: 'codex', agentId: 'codex', envConnectionId: 'local',
      title: 'Mobile long title 手机会话标题与更多内容 '.repeat(4), status: 'idle', lastActiveAt: 1 };
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
    });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin || req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: [session] }] });
      if (url.pathname.endsWith('/messages')) return json({ revision: '1', totalCount: 1, hiddenCount: 0, messages: [{
        id: 'm', sessionKey, role: 'assistant', createdAt: 1,
        text: 'Long message\n\n```text\n' + 'long_line_'.repeat(100) + '\n```\n\n' + '手机长消息 '.repeat(80),
      }] });
      if (url.pathname.endsWith('/queue')) return json({ items: [] });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: horizontal overflow`);
    const touchSize = async locator => {
      const box = await locator.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${width}: small touch target ${JSON.stringify(box)}`);
    };
    await page.goto(origin);
    const card = page.locator(`[data-session-card="${sessionKey}"]`);
    await card.waitFor();
    const search = page.getByRole('textbox', { name: 'Search chats', exact: true });
    await touchSize(search);
    assert.ok(await search.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    await search.fill('no match');
    await card.waitFor({ state: 'hidden' });
    await touchSize(page.getByRole('button', { name: 'Clear chat search', exact: true }));
    await page.getByRole('button', { name: 'Clear chat search', exact: true }).tap();
    await card.waitFor();
    await touchSize(page.getByRole('button', { name: 'New chat', exact: true }));
    const actions = page.locator('.mobile-session-actions summary');
    await touchSize(actions); await actions.tap();
    await page.getByRole('menuitem', { name: 'Session model', exact: true }).waitFor();
    await noOverflow(); await actions.tap();
    await card.tap();
    const input = page.locator('.mobile-composer-textarea'); await input.waitFor();
    await touchSize(page.getByRole('button', { name: 'Back to sessions', exact: true }));
    for (const label of ['Session model', 'Attach image', 'Attach file', 'Send message']) {
      await touchSize(page.getByRole('button', { name: label, exact: true }));
    }
    const controls = page.getByRole('group', { name: 'Session controls', exact: true });
    await controls.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    assert.ok(await controls.evaluate(el => el.scrollLeft > 0), 'narrow tools remain scrollable');
    await page.getByRole('button', { name: 'Session model', exact: true }).tap();
    await page.getByRole('region', { name: 'Session model', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const draft = '中文草稿 draft\n'.repeat(18);
    await input.fill(draft);
    // Exercise the existing visualViewport keyboard contract without claiming
    // this synthetic overlap is a physical iOS/Android keyboard test.
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 480 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(250);
    const keyboardSend = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
    assert.ok(keyboardSend.y + keyboardSend.height <= 480, 'keyboard overlap obscures send');
    assert.equal(await input.inputValue(), draft);
    assert.equal(await input.evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => {
      delete visualViewport.height;
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.setViewportSize({ width, height: 480 });
    await input.focus();
    await page.waitForTimeout(250);
    assert.equal(await input.inputValue(), draft);
    assert.equal(await input.evaluate(el => el === document.activeElement), true);
    const history = await page.locator('.mobile-session-detail-shell .message-selection-surface').boundingBox();
    assert.ok(history.height >= 100, `short viewport history collapsed: ${history.height}`);
    const send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
    assert.ok(send.y + send.height <= 480, 'send button outside viewport');
    await noOverflow();
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).tap();
    await card.tap(); await input.waitFor();
    assert.equal(await input.inputValue(), draft, 'back/reopen preserves draft');
    assert.equal(await page.locator('.mobile-session-detail-shell').count(), 1);
    assert.equal(await page.locator('.desktop-workspace-shell').count(), 0);
    await page.screenshot({ path: `/tmp/agentopsdeck-mobile-ui-${width}.png` });
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/tmp/agentopsdeck-mobile-ui-${width}-full.png` });
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
    await context.close();
  }
  console.log('Mobile UI: 320/390/430px touch targets, search, menus, single chat, short viewport, draft preservation and no writes passed.');
} finally { await browser?.close(); await server.close(); }
