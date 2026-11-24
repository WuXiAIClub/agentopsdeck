// Real settings workflow/recovery UI, synthetic loopback transport only.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const calls = [], errors = [], external = [], receipts = new Map();
    let heldSnapshot, snapshotReads = 0;
    let mode = 'unknown', scope = 'a'.repeat(64);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname === '/__settings') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__settings',
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/command-recovery.fixture.tsx"></script></body></html>') });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/hub/v1/sessions/state') {
        snapshotReads++;
        if (snapshotReads === 1) { heldSnapshot = route; return; }
        return route.fulfill({ json: { groups: [], revision: 'after-recovery', updatedAt: 2 } });
      }
      calls.push([req.method(), url.pathname]);
      assert.equal(req.headers()['x-agentopsdeck-recovery-scope'], scope);
      const key = req.method() === 'PATCH' ? req.headers()['idempotency-key'] : decodeURIComponent(url.pathname.split('/').at(-1));
      assert.match(key, /^settings\./);
      if (req.method() === 'PATCH') {
        assert.equal(url.pathname, '/api/sessions/local%3Ac3ludGhldGlj');
        assert.equal(req.postDataJSON().title, 'Synthetic private settings title');
        const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
          result: { status: 200, body: { sessionKey: 'local:c3ludGhldGlj', settings: { title: 'Synthetic private settings title' } } } };
        receipts.set(key, command);
        return mode === 'accepted' ? route.fulfill({ json: { ...command.result.body, command } })
          : route.fulfill({ status: 202, json: { ok: false, status: 'outcome_unknown' } });
      }
      assert.equal(req.method(), 'GET');
      assert.ok(url.pathname.includes('/settings-commands/'));
      const command = receipts.get(key); assert.ok(command);
      return mode === 'unknown' ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { command } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__settings`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    const invoke = () => page.evaluate(() => window.recoveryFixture.settings());
    const notice = page.getByRole('region', { name: 'Command delivery recovery' });
    assert.match((await invoke()).error, /outcome is unknown/);
    await notice.getByText(/Session settings — outcome unknown/).waitFor();
    assert.deepEqual(calls.map(([method]) => method), ['PATCH', 'GET']);
    assert.equal(await notice.getByRole('button', { name: /Forget locally|Dismiss/ }).count(), 0);
    assert.match((await invoke()).error, /unresolved settings/);
    assert.equal(calls.length, 2);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('Synthetic private settings title')), false);
    await page.reload();
    await notice.getByText(/Session settings — outcome unknown/).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Command delivery recovery"]')?.textContent.includes('checking receipts'));
    assert.deepEqual(calls.map(([method]) => method), ['PATCH', 'GET', 'GET']);
    assert.match((await invoke()).error, /unresolved settings/);
    const oldRead = page.waitForRequest(req => new URL(req.url()).pathname === '/api/hub/v1/sessions/state');
    await page.evaluate(async () => {
      const { api } = await import('/src/api.ts');
      window.beforeSettingsRecovery = api.sessionsState();
    });
    await oldRead;
    mode = 'accepted';
    await notice.getByRole('button', { name: 'Check receipt' }).click();
    await notice.getByText(/Session settings — applied/).waitFor();
    await page.evaluate(async () => {
      const { api } = await import('/src/api.ts');
      void api.sessionsState().then(result => { window.afterSettingsRecovery = result; });
    });
    await page.waitForFunction(() => window.afterSettingsRecovery?.revision === 'after-recovery');
    assert.equal(snapshotReads, 2, 'receipt recovery cannot join the old in-flight snapshot');
    await heldSnapshot.fulfill({ json: { groups: [], revision: 'before-recovery', updatedAt: 1 } });
    assert.equal(calls.length, 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('Synthetic private settings title')), false);
    scope = 'b'.repeat(64);
    await page.goto(`${origin}/__settings?scope=${scope}`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0); assert.equal(calls.length, 4);
    assert.deepEqual(await invoke(), { sessionKey: 'local:c3ludGhldGlj', settings: { title: 'Synthetic private settings title' } });
    assert.equal(calls.length, 5);
    await page.evaluate(() => sessionStorage.setItem('agentopsdeck.command-recovery.v1', '{broken'));
    assert.ok((await invoke()).error); assert.equal(calls.length, 5, 'broken journal forbids PATCH');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
  }
  console.log('Browser settings recovery: one PATCH, GET-only refresh, duplicate barrier, account/storage isolation and 1440/390px passed.');
} finally { await browser?.close(); await server.close(); }
