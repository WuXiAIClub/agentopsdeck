// Real component, synthetic loopback responses; no Agent, production or writes.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const key = 'local:Y29kZXg6Zml4dHVyZQ';
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionInteractions } from '/src/components/SessionInteractions.tsx';
import { setRecoveryScope, sessionInteractionReads } from '/src/api.ts';
import '/src/styles.css';
setRecoveryScope('b'.repeat(64));
sessionInteractionReads.configure(() => undefined);
window.reconnect = () => sessionInteractionReads.connected('b'.repeat(64));
window.rotate = () => setRecoveryScope('c'.repeat(64));
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(SessionInteractions,{sessionKey:'${key}'})));`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'interaction-compatibility-fixture',
    resolveId(id) { if (id === '/compatibility-fixture.js') return '\0compatibility-fixture.js'; },
    load(id) { if (id === '\0compatibility-fixture.js') return fixture; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/compatibility-fixture') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/compatibility-fixture.js"></script></body></html>'));
    }); },
  }], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const external = [], writes = [], errors = [];
    let checks = 0, reads = 0, advertisement = false, missing = false, denied = false;
    await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ status: 403, json: {} }); }
      if (url.pathname.endsWith('/capabilities')) {
        checks++; return route.fulfill({ status: denied ? 403 : 200, json: { features: { interactions: advertisement } } });
      }
      assert.equal(url.pathname, `/api/hub/v1/sessions/${encodeURIComponent(key)}/interactions`);
      reads++; return route.fulfill({ status: missing ? 404 : 200, json: missing ? {} : {
        version: 1, mode: 'automatic', capabilities: { version: 1, modes: ['automatic'], kinds: [] }, requests: [],
      } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/compatibility-fixture');
    await page.getByRole('button', { name: 'Agent interactions', exact: true }).click();
    const dialog = page.getByRole('dialog'), refresh = dialog.getByRole('button', { name: 'Refresh', exact: true });
    await dialog.getByText('This Connector has no interaction service enabled. Enable or upgrade it, then refresh.', { exact: true }).waitFor();
    assert.equal(reads, 0); assert.equal(checks, 1);
    await page.evaluate(() => { for (let i = 0; i < 25; i++) window.reconnect(); });
    await page.waitForTimeout(250); assert.equal(checks, 1);
    advertisement = true; await refresh.click();
    await dialog.getByText('No pending questions or approvals.', { exact: true }).waitFor();
    assert.equal(checks, 2); assert.equal(reads, 1);
    // Old advertisements are unknown, not false. One missing-route probe then
    // the mounted panel stops retries without pretending the session is empty.
    advertisement = undefined; missing = true; await refresh.click();
    await dialog.getByText('Interaction route or session not found. Automatic retries stopped; check the Connector version and session, then refresh.', { exact: true }).waitFor();
    assert.equal(reads, 2); assert.equal(await dialog.getByText('No pending questions or approvals.', { exact: true }).count(), 0);
    await page.evaluate(() => { for (let i = 0; i < 25; i++) window.reconnect(); });
    await page.waitForTimeout(250); assert.equal(reads, 2); assert.equal(checks, 3);
    missing = false; await refresh.click();
    await dialog.getByText('No pending questions or approvals.', { exact: true }).waitFor();
    assert.equal(reads, 3); assert.equal(checks, 4);
    denied = true; await refresh.click();
    await dialog.getByText('Interactions unavailable. Check Connector readiness and permissions, then refresh.', { exact: true }).waitFor();
    assert.equal(reads, 3); assert.equal(checks, 5);
    assert.equal(await dialog.getByRole('combobox').isDisabled(), true);
    const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.evaluate(() => window.rotate()); await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, checks, reads, unsupported: true, legacy404: true, manualRecovery: true, denied: true, writes: 0 }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
