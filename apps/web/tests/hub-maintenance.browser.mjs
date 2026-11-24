import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'maintenance-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__maintenance')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/hub-maintenance.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block' });
    const writes = [], errors = [], nativeDialogs = [], unexpected = [];
    let protocol = { min: 1, max: 1 };
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') writes.push({ path: url.pathname, method: request.method() });
      if (url.pathname === '/api/hub/v1/users') return route.fulfill({ json: { users: [] } });
      if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: { connector: { version: '2.0.0', revision: 'fixture' }, ...(protocol ? { protocol } : {}), features: {} } });
      if (url.pathname.endsWith('/gateway/model-set/reconcile')) return route.fulfill({ json: { converged: true, missing: [] } });
      if (url.pathname.endsWith('/gateway/model-set')) return route.fulfill({ json: { converged: true, missing: [] } });
      if (url.pathname.endsWith('/update/status')) return route.fulfill({ json: { state: 'available', targetVersion: '2.0.1', manifestSha256: 'a'.repeat(64), rollbackAvailable: false, restartRequired: true } });
      if (url.pathname.endsWith('/maintenance/status')) return route.fulfill({ json: { state: 'released', boundary: 'admission_only', nativeQuiescent: false } });
      if (request.method() === 'DELETE') return route.fulfill({ json: { ok: true } });
      unexpected.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, json: { error: 'unexpected fixture request' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto(`${origin}/__maintenance`);
    await page.getByRole('button', { name: 'Expand details', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('Compatible · protocol 1', { exact: false }).waitFor();
    await page.getByText('Release installed; restart and business readiness are not verified. A node supervisor must finish maintenance.', { exact: true }).waitFor();
    const admission = page.getByRole('region', { name: 'Connector admission maintenance' });
    await admission.getByRole('button', { name: 'Refresh admission status' }).click();
    await admission.getByRole('status').filter({ hasText: 'native idle not verified' }).waitFor();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByText('兼容 · 协议 1', { exact: false }).waitFor();
    await page.getByRole('region', { name: 'Connector 接单维护' }).getByRole('status').filter({ hasText: '尚未验证原生任务空闲' }).waitFor();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    protocol = undefined;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('Legacy v1 compatibility', { exact: false }).waitFor();
    protocol = { min: 2, max: 2 };
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('Incompatible protocol · update required', { exact: false }).waitFor();
    protocol = { min: 1, max: 1 };
    await page.getByRole('button', { name: 'Reconcile model set', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Maintain “Fixture node”?' });
    await dialog.waitFor();
    await page.evaluate(() => window.replaceMaintenanceConnection());
    await dialog.getByRole('button', { name: 'Confirm maintenance' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 0, 'stale connection confirmation never sends a mutation');
    await page.getByRole('button', { name: 'Reconcile model set', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm maintenance' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Reconcile model set' && !node.disabled));
    assert.deepEqual(writes.map(write => write.method), ['POST'], 'one current confirmation produces one request');
    await page.getByRole('button', { name: 'Delete connection Fixture node', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Remove “Fixture node”?' });
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1, 'canceling removal is non-mutating');
    await page.getByRole('button', { name: 'Delete connection Fixture node', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.cycleMaintenanceAccount());
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1, 'account A→B→A without render cannot delete a connection');
    await page.reload();
    await page.getByRole('button', { name: 'Expand details', exact: true }).click();
    await page.getByRole('button', { name: 'Reconcile model set', exact: true }).click();
    const maintenanceDialog = page.getByRole('dialog', { name: 'Maintain “Fixture node”?' });
    await maintenanceDialog.waitFor();
    await page.evaluate(() => window.cycleMaintenanceAccount());
    await maintenanceDialog.getByRole('button', { name: 'Confirm maintenance' }).click();
    await maintenanceDialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1, 'account A→B→A without render cannot reconcile models');
    await page.reload();
    await page.getByRole('button', { name: 'Delete connection Fixture node', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.replaceMaintenanceAccount());
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1, 'stale account confirmation never deletes a connection');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []); assert.deepEqual(unexpected, []);
    console.log(`PASS maintenance version, i18n, modal authority ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
