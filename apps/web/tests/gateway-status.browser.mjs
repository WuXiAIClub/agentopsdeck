import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'gateway-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__gateway')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/hub-maintenance.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block' });
    const writes = [], errors = [], dialogs = [], unexpected = [];
    let rejected = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/gateway/restart' && request.method() === 'POST') {
        writes.push(url.pathname);
        return route.fulfill({ status: rejected ? 503 : 200, json: rejected ? { error: 'synthetic unavailable' } : {
          ok: true, gateway: { enabled: true, ok: true, status: 'online', updatedAt: 2 },
        } });
      }
      unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.goto(`${origin}/__gateway?gateway=1`);
    const restart = page.getByRole('button', { name: 'Restart gateway', exact: true });
    await restart.click();
    let modal = page.getByRole('dialog', { name: 'Restart OpenClaw Gateway?' });
    await modal.waitFor(); await page.keyboard.press('Escape');
    assert.equal(writes.length, 0);
    await restart.click(); await modal.waitFor();
    await page.evaluate(() => window.cycleMaintenanceAccount());
    await modal.getByRole('button', { name: 'Restart gateway', exact: true }).click();
    assert.equal(writes.length, 0, 'account A→B→A cannot revive an old restart confirmation');
    // In the app an identity change remounts the authenticated surface.
    await page.reload();
    await restart.click(); await modal.waitFor();
    await page.evaluate(() => window.replaceGatewayEnabled(false));
    await page.locator('main[data-gateway-enabled="false"]').waitFor();
    await page.evaluate(() => window.replaceGatewayEnabled(true));
    await page.locator('main[data-gateway-enabled="true"]').waitFor();
    await modal.getByRole('button', { name: 'Restart gateway', exact: true }).click();
    assert.equal(writes.length, 0, 'old confirmation cannot revive after target configuration changes');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByText('unchanged/model-id', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重启网关', exact: true }).click();
    modal = page.getByRole('dialog', { name: '重启 OpenClaw 网关？' });
    await modal.getByRole('button', { name: '重启网关', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '不代表已确认服务就绪' }).waitFor();
    assert.equal(writes.length, 1);
    rejected = true;
    await page.getByRole('button', { name: '重启网关', exact: true }).click();
    await modal.getByRole('button', { name: '重启网关', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '未自动重试' }).waitFor();
    assert.equal(writes.length, 2);
    await page.getByRole('button', { name: '重启网关', exact: true }).click();
    await modal.waitFor();
    await page.evaluate(() => window.replaceMaintenanceAccount());
    await modal.getByRole('button', { name: '重启网关', exact: true }).click();
    assert.equal(writes.length, 2, 'old account confirmation cannot restart');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []); assert.deepEqual(unexpected, []);
    console.log(`PASS Gateway page confirmation, target/account isolation, i18n and uncertain-result handling ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
