import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'recovery-i18n', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__recovery_i18n')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/recovery-i18n.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const writes = [], unexpected = [], dialogs = [], errors = [];
    await context.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') writes.push(path);
      if (path.endsWith('/me')) return route.fulfill({ json: { userId: 'Member' } });
      if (path.endsWith('/shared/grants')) return route.fulfill({ json: { grants: [{ id: 'fixture', ownerUserId: 'Member', connectionId: 'fixture-node', version: 1, nodeVersion: 1, availability: 'available', sessionId: null, policy: { runtime: 'codex', actions: ['sessions:read'] } }], nextCursor: null } });
      if (path.includes('/grants/') && path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [{ sessionKey: 'Original session 原文', runtime: 'codex', sessionId: 'local:c2Vzc2lvbg' }], nextCursor: null } });
      if (path.endsWith('/queue')) return route.fulfill({ json: { availability: 'available', items: [{ commandKey: 'command 原文', commandState: 'accepted', state: 'queued', version: '1:1', createdAt: 1 }], nextCursor: null } });
      if (path.endsWith('/commands/fixture.unknown')) return route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } });
      if (path.endsWith('/auth/audit')) return route.fulfill({ json: { persistent: true, retentionDays: 30, maxRecords: 1000, startedAt: 1, records: [{ id: 'audit 原文', ts: 1, event: 'passkey_bind', outcome: 'success', userId: 'Member', reason: 'Reason 原文', ipHash: 'hash 原文' }] } });
      unexpected.push(path); return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage();
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    page.on('pageerror', error => { if (error.message !== 'Synthetic render error 原文') errors.push(error.message); });
    await page.goto(`${origin}/__recovery_i18n`);
    await page.getByRole('button', { name: 'View login activity', exact: true }).click();
    await page.getByText('Passkey added · Member', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
    await page.getByText('已添加通行密钥 · Member', { exact: true }).waitFor();
    const fallback = page.getByRole('region', { name: '内容恢复' });
    await fallback.getByText('简化视图', { exact: true }).waitFor();
    assert.equal(await fallback.locator('pre').first().innerText(), 'Original tool output 原文');
    await fallback.getByText('技术详情', { exact: true }).click();
    await fallback.getByText('Synthetic render error 原文', { exact: true }).waitFor();
    const recovery = page.getByRole('region', { name: '命令发送恢复' });
    await recovery.getByRole('button', { name: '仅移除本地记录' }).click();
    let dialog = page.getByRole('dialog', { name: '移除本地恢复记录？' });
    await dialog.waitFor(); await page.keyboard.press('Escape');
    assert.equal(await recovery.count(), 1);
    // Changing away and back cannot let a stale confirmation mutate the journal.
    await recovery.getByRole('button', { name: '仅移除本地记录' }).click();
    await dialog.waitFor(); await page.evaluate(() => window.cycleAccount());
    await dialog.getByRole('button', { name: '仅移除本地记录' }).click();
    assert.equal(await recovery.count(), 1);
    await recovery.getByRole('button', { name: '仅移除本地记录' }).click();
    await dialog.getByRole('button', { name: '仅移除本地记录' }).click();
    await recovery.waitFor({ state: 'detached' });
    const queue = page.getByRole('region', { name: '我的共享队列' });
    await queue.getByText('队列: 排队中 · 受理状态: 已受理', { exact: true }).waitFor();
    await queue.getByRole('button', { name: '取消排队命令' }).click();
    await queue.getByRole('button', { name: '保留排队', exact: true }).click();
    await page.getByRole('button', { name: '浏览会话', exact: true }).click();
    await page.getByRole('main', { name: '共享资源目录' }).getByText('Original session 原文', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
    await page.getByRole('main', { name: 'Shared resource directory' }).waitFor();
    await fallback.waitFor({ state: 'detached' });
    await page.getByRole('region', { name: 'Content recovery' }).getByText('Simplified view', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(writes, []); assert.deepEqual(unexpected, []); assert.deepEqual(dialogs, []); assert.deepEqual(errors, []);
    console.log(`PASS recovery/shared-directory/queue/audit bilingual, original text and scoped modal ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
