// Built UI + deterministic local auth responses. No real credentials or remote API.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://localhost:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN'], [320, 'en']]) for (const mode of ['self', 'other', 'failed']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = []; let revoked = false, lists = 0;
    await context.addInitScript(locale => {
      localStorage.setItem('agentopsdeck.locale', locale);
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, locale);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (req.method() !== 'GET') {
        writes.push([req.method(), url.pathname]);
        if (req.method() === 'DELETE' && url.pathname === '/api/auth/passkeys/fixture') {
          if (mode === 'failed') return route.fulfill({ status: 503, json: { error: 'auth_persistence_failed' } });
          revoked = true; return json({ ok: true, ...(mode === 'self' ? { reauthenticate: true } : {}) });
        }
        errors.push('unexpected mutation'); return route.abort();
      }
      if (url.pathname === '/api/auth/status') return json({ authenticated: !(revoked && mode === 'self'), recoveryScope: 'a'.repeat(64), passkeys: { available: true, count: 1 } });
      if (url.pathname === '/api/auth/passkeys') {
        lists++;
        if (revoked && mode === 'self') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
        return json({ passkeys: revoked ? [] : [{ id: 'fixture', label: 'Test device', createdAt: 1, transports: [] }] });
      }
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: locale === 'en' ? 'Browser and sign-in settings' : '浏览器与登录设置', exact: true }).first().click();
    const settings = page.getByRole('dialog', { name: locale === 'en' ? 'Browser and sign-in settings' : '浏览器与登录设置', exact: true });
    await settings.getByRole('button', { name: locale === 'en' ? 'Remove' : '移除', exact: true }).click();
    const confirm = page.getByRole('button', { name: locale === 'en' ? 'Remove passkey' : '移除通行密钥', exact: true });
    await confirm.waitFor(); assert.equal(writes.length, 0, 'confirmation has not sent a mutation');
    await confirm.click();
    if (mode === 'self') {
      await page.getByText(locale === 'en' ? 'Passkey removed. This sign-in session has ended. Sign in with your access key or another passkey.'
        : '通行密钥已移除，当前登录会话已结束。请使用访问密钥或其他通行密钥重新登录。', { exact: true }).waitFor();
      assert.equal(await settings.count(), 0, 'old modal cannot cover the sign-in prompt');
      assert.equal(await page.locator('input[type="password"]').isVisible(), true);
    } else if (mode === 'other') {
      await settings.getByText(locale === 'en' ? 'Passkey removed.' : '已移除通行密钥。', { exact: true }).waitFor();
      assert.equal(await settings.getByText('Test device', { exact: true }).count(), 0);
      assert.equal(await page.locator('input[type="password"]').count(), 0, 'other credential keeps the current login');
    } else {
      await settings.getByRole('alert').waitFor();
      assert.equal(await settings.getByText('Test device', { exact: true }).count(), 1, 'failed save preserves the credential');
      assert.equal(await settings.getByRole('button', { name: locale === 'en' ? 'Remove' : '移除', exact: true }).isEnabled(), true);
    }
    assert.deepEqual(writes, [['DELETE', '/api/auth/passkeys/fixture']]);
    assert.equal(lists, 1, 'no post-revoke list request or automatic mutation retry');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await context.close(); console.log(`PASS ${width} ${locale} ${mode}: explicit revoke, correct auth transition, no retry`);
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
