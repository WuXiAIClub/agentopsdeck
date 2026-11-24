// Actual built UI and virtual authenticator; all network requests stay local.
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
    for (const failure of ['storage', 'network', 'malformed', 'invalid-row', 'null', 'forbidden', 'unauthorized', 'success']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const errors = [], writes = []; let lists = 0, held;
      await context.addInitScript(locale => {
        localStorage.setItem('agentopsdeck.locale', locale);
        window.authEvents = 0; window.addEventListener('agentopsdeck:auth-required', () => window.authEvents++);
        window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
          constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      }, locale);
      const valid = { passkeys: [{ id: 'fixture', label: 'Saved device', createdAt: 1 }] };
      await context.route('**/*', route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
        if (!path.startsWith('/api/')) return route.continue();
        const json = body => route.fulfill({ json: body });
        if (req.method() !== 'GET') writes.push(path);
        if (path === '/api/auth/status') return json({ authenticated: failure !== 'unauthorized' || lists < 2,
          recoveryScope: 'a'.repeat(64), passkeys: { available: true, count: 1 } });
        if (path === '/api/auth/passkeys') {
          lists++;
          if (lists === 1) return json({ passkeys: [] });
          if (lists > 2) { held = route; return; }
          if (failure === 'success') return json(valid);
          if (failure === 'network') return route.abort('failed');
          if (failure === 'malformed') return json({ passkeys: {} });
          if (failure === 'invalid-row') return json({ passkeys: [null] });
          if (failure === 'null') return json(null);
          return route.fulfill({ status: failure === 'forbidden' ? 403 : failure === 'unauthorized' ? 401 : 503,
            json: { error: 'synthetic-sensitive-error-must-not-be-displayed' } });
        }
        if (path.endsWith('/register/options')) return json({ challenge: 'dGVzdC1jaGFsbGVuZ2U', rp: { id: 'localhost', name: 'Fixture' },
          user: { id: 'dGVzdC11c2Vy', name: 'fixture', displayName: 'Fixture' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, attestation: 'none' });
        if (path.endsWith('/register/verify')) return json({ ok: true });
        if (req.method() !== 'GET') { errors.push('unexpected write'); return route.abort(); }
        if (path.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
        if (path === '/api/agents') return json({ agents: [] });
        if (path === '/api/gateway/status') return json({ connected: true });
        return route.fulfill({ status: 404, json: {} });
      });
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      const title = locale === 'en' ? 'Browser and sign-in settings' : '浏览器与登录设置';
      await page.goto(origin);
      await page.getByRole('button', { name: title, exact: true }).first().click();
      const settings = page.getByRole('dialog', { name: title, exact: true });
      const add = settings.getByRole('button', { name: locale === 'en' ? 'Add passkey' : '添加通行密钥', exact: true });
      await add.click();
      const retry = settings.getByRole('button', { name: locale === 'en' ? 'Retry loading passkeys' : '重新加载通行密钥', exact: true });
      if (failure === 'unauthorized') {
        await settings.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.authEvents), 1);
      } else {
        await settings.getByRole('status').filter({ hasText: locale === 'en' ? 'Passkey saved.' : '已保存通行密钥' }).waitFor();
        if (failure === 'success') await settings.getByText('Saved device', { exact: true }).waitFor();
        else if (failure === 'forbidden') {
          await settings.getByText(locale === 'en' ? 'Passkey management requires this Hub’s operator sign-in. Member access is unchanged.'
            : '管理通行密钥需要以此 Hub 的操作员身份登录。成员访问方式不变。', { exact: true }).waitFor();
          assert.equal(await retry.count(), 0); assert.equal(await add.count(), 0);
        } else {
          await settings.getByRole('alert').filter({ hasText: locale === 'en' ? 'do not register again' : '无需再次注册' }).waitFor();
          assert.equal(await add.count(), 0); assert.equal(lists, 2, 'no automatic retry');
          await retry.evaluate(button => { button.click(); button.click(); });
          await waitFor(() => held); assert.equal(lists, 3, 'single read on double click');
          await held.fulfill({ status: 503, json: {} }); held = null;
          await settings.getByRole('alert').filter({ hasText: locale === 'en' ? 'do not register again' : '无需再次注册' }).waitFor();
          await retry.click(); await waitFor(() => held);
          await held.fulfill({ json: valid });
          await settings.getByText('Saved device', { exact: true }).waitFor();
          assert.equal(await add.isEnabled(), true);
          assert.equal(await settings.getByRole('alert').count(), 0);
          // Saved-write provenance is scoped to this dialog, not future initial loads.
          await settings.getByRole('button', { name: locale === 'en' ? 'Close settings' : '关闭设置', exact: true }).click();
          held = null;
          await page.getByRole('button', { name: title, exact: true }).first().click();
          await waitFor(() => held); await held.fulfill({ status: 503, json: {} });
          await settings.getByRole('alert').filter({ hasText: locale === 'en' ? 'No changes were made' : '未进行任何修改' }).waitFor();
        }
      }
      assert.deepEqual(writes, ['/api/auth/passkeys/register/options', '/api/auth/passkeys/register/verify'], 'registration is never replayed');
      assert.equal(await page.getByText('synthetic-sensitive-error-must-not-be-displayed', { exact: false }).count(), 0);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await context.close(); console.log(`PASS ${width} ${locale} ${failure}: registration receipt preserved, read-only recovery`);
    }
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
async function waitFor(predicate) {
  const end = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > end) throw Error('Fixture request not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
