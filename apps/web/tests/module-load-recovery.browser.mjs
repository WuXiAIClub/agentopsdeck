// Production bundle + actual HTTP static handler. No production data or writes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerWebBundle } from '../../server/src/web-bundle.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const app = new Hono(), writes = [], unexpected = [];
app.get('/api/auth/status', c => c.json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } }));
app.get('/api/hub/v1/workspace/remote/devices', c => c.json({ devices: [] }));
registerWebBundle(app, fileURLToPath(new URL('../dist', import.meta.url)));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await once(server, 'listening');
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  for (const failure of ['missing', 'html']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
    let broken = true, chunkAttempts = 0, navigations = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.origin !== origin) { writes.push(request.url()); return route.abort(); }
      if (/\/assets\/WorkspaceRemote-[^/]+\.js$/.test(url.pathname)) {
        chunkAttempts++;
        if (broken) {
          // Model a previous-release chunk removed on the server, including
          // the HTML response that older deployments/CDNs can still return.
          const response = await fetch(origin + (failure === 'missing' ? '/assets/remote-obsolete.js' : '/'));
          return route.fulfill({ status: response.status, contentType: response.headers.get('content-type'), body: await response.text() });
        }
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => unexpected.push(error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await page.goto(origin + '/#/remote');
    await page.getByText('This panel could not load', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reload page', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    await page.waitForTimeout(1200);
    assert.equal(chunkAttempts, 1, 'no repeated failed import');
    assert.equal(navigations, 1, 'no automatic reload');
    assert.equal(await page.getByText('Technical details', { exact: true }).count(), 1);
    broken = false;
    await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    await page.getByLabel('Desktop device', { exact: true }).waitFor();
    assert.equal(navigations, 2);
    assert.equal(await page.getByText('This panel could not load', { exact: true }).count(), 0);
    await context.close();
    console.log(JSON.stringify({ failure, phoneRemoteRecovered: true, explicitReloadOnly: true, chunkAttempts }));
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(unexpected, []);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
