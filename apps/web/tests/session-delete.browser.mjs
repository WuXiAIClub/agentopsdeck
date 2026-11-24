// Actual deletion workflow and recovery component, synthetic loopback only.
// No native runtime, production proxy, credentials or screenshots.
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
    const calls = [], rejected = [], errors = [], receipts = new Map();
    let mode = 'unknown', scope = 'a'.repeat(64);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { rejected.push(url.origin); return route.abort(); }
      if (url.pathname === '/__delete') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__delete',
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/command-recovery.fixture.tsx"></script></body></html>') });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      calls.push([req.method(), url.pathname]);
      assert.equal(req.headers()['x-agentopsdeck-recovery-scope'], scope);
      const key = req.method() === 'DELETE' ? req.headers()['idempotency-key'] : decodeURIComponent(url.pathname.split('/').at(-1));
      assert.match(key, /^delete\./);
      if (req.method() === 'DELETE') {
        assert.equal(url.pathname, '/api/sessions/local%3Ac3ludGhldGlj');
        const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
          result: { status: 200, body: { ok: true, status: 'delete_accepted' } } };
        receipts.set(key, command);
        return mode === 'accepted' ? route.fulfill({ json: { ...command.result.body, command } })
          : route.fulfill({ status: 202, json: { ok: false, status: 'outcome_unknown' } });
      }
      assert.equal(req.method(), 'GET');
      assert.ok(url.pathname.includes('/deletion-commands/'));
      const command = receipts.get(key);
      assert.ok(command);
      return mode === 'unknown' ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { command } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__delete`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    const invoke = () => page.evaluate(() => window.recoveryFixture.deleteSession());
    const notice = page.getByRole('region', { name: 'Command delivery recovery' });
    const unknown = await invoke();
    assert.equal(unknown.removed, false); assert.match(unknown.error, /outcome is unknown/);
    await notice.getByText(/Session deletion — outcome unknown/).waitFor();
    assert.equal(calls.filter(([method]) => method === 'DELETE').length, 1);
    assert.equal(calls.filter(([method]) => method === 'GET').length, 1);
    assert.equal(await notice.getByRole('button', { name: 'Forget locally' }).count(), 0);
    assert.match((await invoke()).error, /unresolved deletion/);
    assert.equal(calls.length, 2, 'a second click cannot dispatch or query a new command');

    await page.reload();
    await notice.getByText(/Session deletion — outcome unknown/).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Command delivery recovery"]')?.textContent.includes('checking receipts'));
    assert.equal(calls.length, 3, 'refresh performs only one receipt GET');
    assert.match((await invoke()).error, /unresolved deletion/);
    assert.equal(calls.length, 3);
    mode = 'accepted';
    await notice.getByRole('button', { name: 'Check receipt' }).click();
    await notice.getByText(/Session deletion — accepted; view cleanup may still be pending/).waitFor();
    assert.equal(calls.length, 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('delete_accepted')), false, 'journal contains no receipt body');

    scope = 'b'.repeat(64);
    await page.goto(`${origin}/__delete?scope=${scope}`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0); assert.equal(calls.length, 4, 'another account must not query the original receipt');
    assert.deepEqual(await invoke(), { removed: true });
    assert.equal(calls.length, 5); assert.equal(calls[4][0], 'DELETE');

    const before = calls.length;
    await page.evaluate(() => sessionStorage.setItem('agentopsdeck.command-recovery.v1', '{broken'));
    assert.equal((await invoke()).removed, false); assert.equal(calls.length, before, 'broken journal must prevent dispatch');
    assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
    await context.close();
  }
  console.log('Browser deletion recovery: durable identity, GET-only refresh, duplicate barrier, account isolation and 1440/390px notice layout passed.');
} finally { await browser?.close(); await server.close(); }
