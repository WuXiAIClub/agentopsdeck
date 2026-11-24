// Production UI. Every API request ends at this deterministic local fixture.
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
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN'], [320, 'en']]) {
    for (const failure of ['storage', 'network', 'malformed', 'invalid-row', 'forbidden', 'unauthorized']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const errors = [], writes = []; let lists = 0, held;
      await context.addInitScript(locale => {
        localStorage.setItem('agentopsdeck.locale', locale);
        window.authEvents = 0; window.addEventListener('agentopsdeck:auth-required', () => window.authEvents++);
        window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
          constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      }, locale);
      await context.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (req.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
        const json = body => route.fulfill({ json: body });
        if (url.pathname === '/api/auth/status') return json({ authenticated: failure !== 'unauthorized' || lists === 0,
          recoveryScope: 'a'.repeat(64), passkeys: { available: true, count: 1 } });
        if (url.pathname === '/api/auth/passkeys') {
          lists++;
          if (lists > 1) { held = route; return; }
          if (failure === 'network') return route.abort('failed');
          if (failure === 'malformed') return json({ passkeys: {} });
          if (failure === 'invalid-row') return json({ passkeys: [null] });
          return route.fulfill({ status: failure === 'forbidden' ? 403 : failure === 'unauthorized' ? 401 : 503,
            json: { error: 'synthetic-sensitive-error-must-not-be-displayed' } });
        }
        if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
        if (url.pathname === '/api/agents') return json({ agents: [] });
        if (url.pathname === '/api/gateway/status') return json({ connected: true });
        return route.fulfill({ status: 404, json: {} });
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      const title = locale === 'en' ? 'Browser and sign-in settings' : '浏览器与登录设置';
      await page.getByRole('button', { name: title, exact: true }).first().click();
      const settings = page.getByRole('dialog', { name: title, exact: true });
      const retry = settings.getByRole('button', { name: locale === 'en' ? 'Retry loading passkeys' : '重新加载通行密钥', exact: true });
      const forbidden = locale === 'en' ? 'Passkey management requires this Hub’s operator sign-in. Member access is unchanged.'
        : '管理通行密钥需要以此 Hub 的操作员身份登录。成员访问方式不变。';
      if (failure === 'unauthorized') {
        await settings.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.authEvents), 1);
      } else if (failure === 'forbidden') {
        await settings.getByText(forbidden, { exact: true }).waitFor();
        assert.equal(await retry.count(), 0);
      } else {
        await settings.getByRole('alert').filter({ hasText: locale === 'en' ? 'Passkeys could not be loaded.' : '无法加载通行密钥' }).waitFor();
        assert.equal(await settings.getByText(forbidden, { exact: true }).count(), 0);
        assert.equal(await settings.getByRole('button', { name: locale === 'en' ? 'Add passkey' : '添加通行密钥', exact: true }).count(), 0);
        assert.equal(lists, 1, 'no automatic retry');
        await retry.evaluate(button => { button.click(); button.click(); });
        await settings.getByRole('status').filter({ hasText: locale === 'en' ? 'Loading passkeys' : '正在加载通行密钥' }).waitFor();
        await waitFor(() => held);
        assert.equal(lists, 2, 'double click creates only one read');
        await held.fulfill({ json: { passkeys: [{ id: 'fixture', label: 'Recovered device', createdAt: 1 }] } });
        await settings.getByText('Recovered device', { exact: true }).waitFor();
        assert.equal(await settings.getByRole('alert').count(), 0);
        assert.equal(await settings.getByRole('button', { name: locale === 'en' ? 'Add passkey' : '添加通行密钥', exact: true }).isEnabled(), true);
      }
      assert.equal(await page.getByText('synthetic-sensitive-error-must-not-be-displayed', { exact: false }).count(), 0);
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await context.close(); console.log(`PASS ${width} ${locale} ${failure}: truthful state, bounded read-only recovery`);
    }
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
async function waitFor(predicate) {
  const end = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > end) throw Error('Fixture request not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
