// Local synthetic responses only: no real WeChat account, QR fetch or messages.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import WeixinSettings from '/src/components/WeixinSettings.tsx';
import { BrowserSettings } from '/src/components/BrowserSettings.tsx';
import '/src/styles.css';
import '/src/desktop-shell.css';
import { setRecoveryScope } from '/src/api.ts';
import { setLocale } from '/src/lib/i18n.ts';
setLocale('en');setRecoveryScope('a'.repeat(64));
window.rotate=()=>setRecoveryScope('b'.repeat(64));
const root=createRoot(document.getElementById('root'));
window.unmount=()=>root.unmount();
root.render(React.createElement(React.StrictMode,null,React.createElement(location.search ? BrowserSettings : WeixinSettings)));`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [react(), tailwindcss(), {
    name: 'weixin-test', resolveId(id) { if (id === '/weixin-test.js') return '\0weixin-test.js'; },
    load(id) { if (id === '\0weixin-test.js') return fixture; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (!req.url || new URL(req.url, 'http://fixture').pathname !== '/weixin-test') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;padding:12px}button{white-space:normal;max-width:100%}input{width:100%}dialog{max-width:calc(100vw - 24px)}</style></head><body><div id="root"></div><script type="module" src="/weixin-test.js"></script></body></html>'));
    }); },
  }] });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const identity of ['personal', 'administrator']) for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' }), page = await context.newPage();
    const errors = []; let binding = null, creates = 0, polls = 0, deletes = 0, unknown = false;
    page.on('pageerror', e => errors.push(e.message));
    const status = () => ({ available: true, personalKey: identity === 'personal',
      ...(identity === 'administrator' ? { administratorKey: true } : {}), binding });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.ok(url.pathname.startsWith('/api/hub/v1/weixin'));
      if (req.method() === 'GET') return route.fulfill({ json: status() });
      if (req.method() === 'DELETE') { deletes++; binding = null; return route.fulfill({ json: { removed: true } }); }
      if (url.pathname.endsWith('/bindings')) {
        creates++; binding = { id: req.postDataJSON().id, state: 'qr', expiresAt: Date.now() + 300_000,
          contextReady: false, subscriptions: 0, qrUrl: 'https://weixin.qq.com/synthetic-qr-only' };
        return route.fulfill(unknown ? { status: 503, json: { error: 'weixin_unknown' } } : { json: status() });
      }
      polls++;
      if (polls === 1) return route.fulfill({ json: { state: 'verify', status: status() } });
      assert.equal(req.postDataJSON().verify, '123456');
      binding = { ...binding, state: 'bound', qrUrl: undefined };
      return route.fulfill({ json: { state: 'confirmed', status: status() } });
    });
    await page.goto(origin + '/weixin-test');
    await page.getByRole('button', { name: 'Create binding QR code' }).click();
    if (identity === 'administrator') await page.getByText('This binding belongs to the shared administrator account. Changing the administrator Key disables it.').waitFor();
    await page.locator('.weixin-settings svg').waitFor();
    assert.equal(creates, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.weixin-settings img').count(), 0, 'QR never uses external images');
    await page.getByRole('button', { name: 'Check scan result' }).click();
    const code = page.getByLabel('WeChat verification code'); await code.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Check scan result' }).isDisabled(), true);
    await code.fill('123456'); await page.getByRole('button', { name: 'Check scan result' }).click();
    await page.getByText(/WeChat bound/).waitFor();
    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click(); assert.equal(deletes, 0);
    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Unlink', exact: true }).click();
    await page.getByRole('button', { name: 'Create binding QR code' }).waitFor(); assert.equal(deletes, 1);
    unknown = true; await page.getByRole('button', { name: 'Create binding QR code' }).click();
    await page.getByRole('alert').waitFor(); assert.equal(creates, 2);
    assert.equal(await page.getByRole('button', { name: 'Create binding QR code' }).count(), 0);
    await page.getByRole('button', { name: 'Refresh WeChat status' }).click(); await page.locator('.weixin-settings svg').waitFor();
    assert.equal(creates, 2, 'recovery reads do not replay QR creation');
    await page.evaluate(() => window.rotate());
    await page.locator('.weixin-settings svg').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []); await context.close(); console.log(`PASS WeChat ${identity} QR/verify/bind/unlink/unknown/scope at ${width}px`);
  }
  for (const status of [{ available: true, personalKey: false, administratorKey: false, binding: null },
    { available: true, personalKey: false, binding: null }]) {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(req.method(), 'GET', 'ineligible identity must not create a binding');
      return route.fulfill({ json: status });
    });
    await page.goto(origin + '/weixin-test');
    await page.getByText('Sign in with a personal Hub Key or the administrator Key to bind. Passkey-only sessions cannot create a binding.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create binding QR code' }).count(), 0);
    await context.close(); console.log('PASS ineligible/old-Hub identity keeps binding disabled');
  }
  for (const boundary of ['rotate', 'unmount']) {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage(); let held, writes = 0;
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (req.method() === 'GET') return route.fulfill({ json: { available: true, personalKey: true, binding: null } });
      writes++; held = route;
    });
    await page.goto(origin + '/weixin-test'); await page.getByRole('button', { name: 'Create binding QR code' }).click();
    while (!held) await new Promise(resolve => setTimeout(resolve, 10));
    await page.evaluate(boundary => window[boundary](), boundary);
    await held.fulfill({ json: { available: true, personalKey: true, binding: { id: 'late', state: 'qr', expiresAt: Date.now() + 10000, qrUrl: 'late-qr' } } }).catch(() => {});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.weixin-settings svg').count(), 0); assert.equal(writes, 1);
    await context.close(); console.log(`PASS late QR suppressed after ${boundary}`);
  }
  for (const width of [320, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' }), page = await context.newPage();
    let reads = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(route.request().method(), 'GET');
      if (url.pathname.endsWith('/weixin')) { reads++; return route.fulfill({ json: { available: true, personalKey: true, binding: null } }); }
      return route.fulfill({ json: { passkeys: [], keyAccess: true } });
    });
    await page.goto(origin + '/weixin-test?settings');
    await page.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).waitFor();
    assert.equal(reads, 0, 'closed settings make no WeChat request');
    await page.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).click();
    await page.getByRole('button', { name: 'Create binding QR code' }).waitFor();
    const geometry = await page.locator('.weixin-settings').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(geometry.width > 0 && geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.locator('.weixin-settings').waitFor({ state: 'detached' });
    await context.close(); console.log(`PASS real BrowserSettings lazy entry/close at ${width}px`);
  }
} finally { await browser?.close(); await server.close(); }
