// Real React hook, synthetic loaders; no account, API or production writes.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), { name: 'fixture', configureServer(server) {
    server.middlewares.use('/backfill-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<div id="root"></div><script type="module" src="/tests/history-backfill.fixture.tsx"></script>');
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const denied = [], errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) { denied.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/backfill-test`);
  await page.waitForFunction(() => window.__backfill);
  for (const mode of ['recover', 'storm', 'error', 'throw', 'loading', 'dispose']) {
    await page.evaluate(mode => window.__backfill.start(mode), mode);
    await page.waitForFunction(() => window.__backfill.stats().calls >= 1);
    if (mode === 'dispose') await page.evaluate(() => window.__backfill.close());
    await page.waitForTimeout(800);
    const result = await page.evaluate(() => {
      const s = window.__backfill.stats(); return { calls: s.calls, rendered: s.rendered, times: s.times };
    });
    assert.equal(result.calls, ['recover', 'storm'].includes(mode) ? 3 : 1, mode);
    if (mode === 'recover') {
      assert.equal(result.rendered, 200);
      assert.ok(result.times[1] - result.times[0] >= 140 && result.times[2] - result.times[1] >= 290);
    }
    if (mode === 'loading') {
      await page.evaluate(() => window.__backfill.resume());
      await page.waitForFunction(() => window.__backfill.stats().rendered === 200);
      assert.equal(await page.evaluate(() => window.__backfill.stats().calls), 2);
    }
    if (mode === 'storm') {
      await page.evaluate(() => window.__backfill.manual());
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => window.__backfill.stats().calls), 4, 'manual reading remains available after automatic retry exhaustion');
    }
    console.log(JSON.stringify({ mode, ...result, passed: true }));
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
} finally { await browser?.close(); await server.close(); }
