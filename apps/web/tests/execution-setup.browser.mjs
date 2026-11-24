import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'execution-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__execution')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/hub-maintenance.fixture.tsx"></script></body></html>'));
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
    let configured = false;
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') writes.push({ method: request.method(), body: request.postDataJSON() });
      if (url.pathname.endsWith('/execution-issuer') && request.method() === 'GET') return route.fulfill({ json: {
        hubId: 'fixture-hub', localSetupAllowed: true,
        issuer: configured ? { issuerId: 'issuer-fixture', nodeId: 'node-fixture', version: 1, creationAllowed: false } : null,
      } });
      if (url.pathname.endsWith('/execution-issuer/local') && request.method() === 'POST') return route.fulfill({ json: { ok: true } });
      if (url.pathname.endsWith('/execution-issuer') && ['DELETE', 'PUT'].includes(request.method())) return route.fulfill({ json: { ok: true } });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: 'unexpected fixture request' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto(`${origin}/__execution?execution=1`);
    await page.getByRole('button', { name: 'Enable member sessions', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Change environment write access?' });
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 0);
    // Changing authority twice back to the original value still invalidates confirmation.
    await page.getByRole('button', { name: 'Enable member sessions', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.replaceExecutionVersion(2));
    // Observe both committed snapshots. A fixed delay can let React batch
    // A→B→A into A, which never exercises the stale-confirmation guard.
    await page.waitForFunction(() => document.querySelector('main')?.dataset.executionVersion === '2');
    await page.evaluate(() => window.replaceExecutionVersion(1));
    await page.waitForFunction(() => document.querySelector('main')?.dataset.executionVersion === '1');
    await dialog.getByRole('button', { name: 'Enable member sessions', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 0, 'A→B→A cannot reuse an old approval');
    await page.getByRole('button', { name: 'Enable member sessions', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.cycleMaintenanceAccount());
    await dialog.getByRole('button', { name: 'Enable member sessions', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 0, 'account A→B→A without render cannot reuse an old approval');
    await page.reload();
    await page.getByRole('button', { name: 'Enable member sessions', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByRole('heading', { name: '环境写入权限设置' }).waitFor();
    await page.getByRole('button', { name: '启用成员会话', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '更改环境写入权限？' });
    await dialog.getByRole('button', { name: '启用成员会话', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '启用成员会话' && !button.disabled));
    assert.deepEqual(writes, [{ method: 'POST', body: { confirm: true, nodeVersion: 1, createSessions: true } }]);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    await page.getByText('Use an operator-issued credential', { exact: true }).click();
    // Password inputs have no implicit textbox role.
    const password = page.getByLabel('Operator execution issuer token');
    await password.fill('synthetic-fixture-credential');
    await page.getByRole('button', { name: 'Verify and enable execution' }).click();
    dialog = page.getByRole('dialog', { name: 'Change environment write access?' });
    await dialog.waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await dialog.getByRole('button', { name: 'Verify and enable execution' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await password.inputValue(), '');
    assert.equal(writes.length, 1, 'hidden tab clears and invalidates pending credential');
    await page.evaluate(() => { delete document.hidden; });
    await password.fill('synthetic-fixture-credential');
    await page.getByRole('button', { name: 'Verify and enable execution' }).click();
    await dialog.getByRole('button', { name: 'Verify and enable execution' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].method, 'PUT');
    configured = true;
    await page.evaluate(() => window.replaceExecutionVersion(3));
    await page.getByRole('button', { name: 'Disable shared execution', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.replaceMaintenanceAccount());
    await dialog.getByRole('button', { name: 'Disable shared execution', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 2, 'account change invalidates issuer deletion');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []); assert.deepEqual(unexpected, []);
    console.log(`PASS execution setup localization, credential clearing, stale authority, modal ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
