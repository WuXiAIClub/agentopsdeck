import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'access-keys-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__access')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/access-sharing.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const writes = [], errors = [], nativeDialogs = [], unexpected = [];
    let releaseIssue;
    let issueStarted;
    const pendingIssue = new Promise(resolve => { issueStarted = resolve; });
    let keys = [{ id: 'fixture-key', createdAt: 1, loginCount: 2 }];
    let grant = { id: 'fixture-grant', userId: 'fixture-member', version: 1, nodeVersion: 1, revoked: false,
      policy: { runtime: 'codex', actions: ['sessions:read', 'messages:read', 'events:read'] } };
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (method !== 'GET') writes.push({ method, path: url.pathname, body: request.postData() ? request.postDataJSON() : undefined });
      if (url.pathname.endsWith('/access/directory')) return route.fulfill({ json: { administrator: false, connections: [], users: [] } });
      if (/\/users\/[^/]+\/access$/.test(url.pathname) && method === 'GET') return route.fulfill({ json: { access: { userId: decodeURIComponent(url.pathname.split('/').at(-2)), status: 'enabled', version: 0 } } });
      if (url.pathname.endsWith('/login-keys') && method === 'POST') {
        await new Promise(resolve => { releaseIssue = resolve; issueStarted(); });
        keys = [...keys, { id: 'hidden-key', createdAt: 2, loginCount: 0 }];
        return route.fulfill({ json: { id: 'hidden-key', token: 'synthetic-secret-never-reveal' } });
      }
      if (url.pathname.endsWith('/login-keys')) return route.fulfill({ json: { keys } });
      if (url.pathname.endsWith('/login-keys/fixture-key') && method === 'DELETE') { keys = []; return route.fulfill({ json: { ok: true } }); }
      if (url.pathname.endsWith('/grants')) return route.fulfill({ json: { nodeVersion: 1, verified: true, executionConfigured: true, creationConfigured: true, grants: grant.revoked ? [] : [grant], nextCursor: null } });
      if (url.pathname.endsWith('/grants/fixture-grant') && method === 'DELETE') { grant = { ...grant, revoked: true }; return route.fulfill({ json: { grant } }); }
      if (url.pathname.endsWith('/state')) return route.fulfill({ json: { groups: [] } });
      unexpected.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: 'unexpected fixture request' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.goto(`${origin}/__access?keys=1`);
    await page.getByText('Login & keys', { exact: true }).click();
    await page.getByText('Manage existing login keys (1)', { exact: true }).click();
    await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Revoke key', exact: true });
    await dialog.waitFor(); await page.keyboard.press('Escape');
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.replaceAccessUser('other-member'));
    await page.locator('main[data-fixture-user="other-member"]').waitFor();
    await page.evaluate(() => window.replaceAccessUser('fixture-member'));
    await page.locator('main[data-fixture-user="fixture-member"]').waitFor();
    await dialog.getByRole('button', { name: 'Revoke key', exact: true }).click();
    assert.equal(writes.length, 0, 'returning user cannot revive an old key revocation');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByText('登录与密钥', { exact: true }).click();
    await page.getByText('管理已有登录密钥（1）', { exact: true }).click();
    await page.getByRole('button', { name: '撤销密钥', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '撤销密钥', exact: true });
    await dialog.getByRole('button', { name: '撤销密钥', exact: true }).click();
    await page.getByText('登录密钥已撤销。关联的登录会话不能再授权请求。', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'DELETE');
    await page.getByText('旧授权 · 高级', { exact: true }).click();
    await page.getByRole('button', { name: '撤销权限', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '更改环境权限？' });
    await dialog.waitFor(); await page.keyboard.press('Escape');
    assert.equal(writes.length, 1, 'cancel legacy-role removal performs no write');
    await page.getByRole('button', { name: '自定义授权', exact: true }).click();
    await page.getByRole('button', { name: '撤销授权', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '撤销授权', exact: true });
    await dialog.getByRole('button', { name: '撤销授权', exact: true }).click();
    await page.getByText('此页没有已保存的权限。请返回角色概览添加环境角色。', { exact: true }).waitFor();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].body, { version: 1 });
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    await page.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    await pendingIssue;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    releaseIssue();
    await page.getByText('Key issued while this page was hidden. Its secret was discarded. Revoke the unclaimed key in the refreshed list before issuing another.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'One-time member login key' }).count(), 0);
    assert.equal(await page.locator('body').innerText().then(text => text.includes('synthetic-secret-never-reveal')), false);
    assert.equal(writes.length, 3, 'late issuance is neither repeated nor silently revoked');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width && rect.right > innerWidth + 1;
    }).map(node => ({ tag: node.tagName, className: node.className, text: node.textContent?.slice(0, 80) }))), []);
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []); assert.deepEqual(unexpected, []);
    console.log(`PASS member-key and legacy-access bilingual confirmation, cancellation and stale-user isolation ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
