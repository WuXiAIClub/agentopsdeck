// Production UI, local API fixture and virtual authenticator. No real account.
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
    for (const event of ['agentopsdeck:auth-required', 'pagehide']) for (const stage of ['initial-list', 'options', 'credential', 'verify', 'refresh-list', 'confirm', 'revoke']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const errors = [], writes = []; let lists = 0, waiting = false, released = false, completed = false;
      let release; const gate = new Promise(resolve => { release = resolve; });
      await context.addInitScript(({ locale, stage }) => {
        localStorage.setItem('agentopsdeck.locale', locale);
        window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
          constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
        window.authEvents = 0;
        window.addEventListener('agentopsdeck:auth-required', () => window.authEvents++);
        const create = navigator.credentials.create.bind(navigator.credentials);
        navigator.credentials.create = async options => {
          const credential = await create(options);
          if (stage === 'credential') {
            window.credentialWaiting = true;
            await new Promise(resolve => { window.releaseCredential = resolve; });
          }
          window.credentialReturned = true;
          return credential;
        };
      }, { locale, stage });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
        if (!path.startsWith('/api/')) return route.continue();
        const isList = path === '/api/auth/passkeys' && req.method() === 'GET';
        if (isList) lists++;
        const listNumber = lists;
        if (req.method() !== 'GET') writes.push([req.method(), path]);
        const held = !released && ((stage === 'initial-list' && isList && listNumber === 1)
          || (stage === 'refresh-list' && isList && listNumber === 2)
          || (stage === 'options' && path.endsWith('/register/options'))
          || (stage === 'verify' && path.endsWith('/register/verify'))
          || (stage === 'revoke' && req.method() === 'DELETE'));
        if (held) { waiting = true; await gate; }
        const json = async body => { await route.fulfill({ json: body }); if (held) completed = true; };
        if (path === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: true, count: 1 } });
        if (isList) return json({ passkeys: [{ id: 'fixture', label: held ? 'Late device' : 'Current device', createdAt: 1, transports: [] }] });
        if (req.method() === 'DELETE' && path === '/api/auth/passkeys/fixture') return json({ ok: true, reauthenticate: true });
        if (path.endsWith('/register/options')) return json({ challenge: 'dGVzdC1jaGFsbGVuZ2U', rp: { id: 'localhost', name: 'Fixture' },
          user: { id: 'dGVzdC11c2Vy', name: 'fixture', displayName: 'Fixture' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, attestation: 'none' });
        if (path.endsWith('/register/verify')) return json({ ok: true });
        if (req.method() !== 'GET') { errors.push('unexpected mutation'); return route.abort(); }
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
      const settingsName = locale === 'en' ? 'Browser and sign-in settings' : '浏览器与登录设置';
      const settings = page.getByRole('dialog', { name: settingsName, exact: true });
      const add = settings.getByRole('button', { name: locale === 'en' ? 'Add passkey' : '添加通行密钥', exact: true });
      await page.goto(origin);
      await page.getByRole('button', { name: settingsName, exact: true }).first().click();
      if (stage === 'confirm' || stage === 'revoke') {
        await settings.getByRole('button', { name: locale === 'en' ? 'Remove' : '移除', exact: true }).click();
        const confirm = page.getByRole('button', { name: locale === 'en' ? 'Remove passkey' : '移除通行密钥', exact: true });
        await confirm.waitFor();
        if (stage === 'revoke') await confirm.click();
      } else if (stage !== 'initial-list') await add.click();
      if (stage === 'credential') await page.waitForFunction(() => window.credentialWaiting);
      else if (stage !== 'confirm') await waitFor(() => waiting);
      const writesBefore = [...writes], listsBefore = lists;
      await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
      await settings.waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('dialog').count(), 0, 'confirmation and owner are both dismissed');
      if (event === 'pagehide') {
        // Reopen before the old operation completes: its finally/receipt must
        // not overwrite the new dialog, list, notice or busy state.
        await page.getByRole('button', { name: settingsName, exact: true }).first().click();
        await settings.getByText('Current device', { exact: true }).waitFor();
      }
      released = true; release();
      if (stage === 'credential') await page.evaluate(() => window.releaseCredential());
      else if (stage !== 'confirm') await waitFor(() => completed);
      // Drain the late receipt's JS continuation, including React's next frame.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));
      assert.deepEqual(writes, writesBefore, 'no mutation follows an invalidated prompt/response');
      assert.equal(lists, listsBefore + (event === 'pagehide' ? 1 : 0), 'no stale registration follow-up GET');
      assert.equal(await page.evaluate(() => window.authEvents), event === 'pagehide' ? 0 : 1, 'late revoke cannot trigger another logout');
      if (event === 'pagehide') {
        assert.equal(await add.isEnabled(), true, 'new dialog remains usable');
        assert.equal(await settings.getByText('Late device', { exact: true }).count(), 0);
        assert.equal(await settings.getByRole('alert').count(), 0);
        // Cancelled confirmation must also release the global confirmation lock.
        await settings.getByRole('button', { name: locale === 'en' ? 'Remove' : '移除', exact: true }).click();
        const cancel = page.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
        await cancel.click();
        assert.equal(await add.isEnabled(), true);
      } else assert.equal(await settings.count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      await context.close(); console.log(`PASS ${width} ${locale} ${event} ${stage}: no late effects, no retry`);
    }
  }
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
async function waitFor(predicate) {
  const end = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > end) throw Error('Fixture boundary was not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
