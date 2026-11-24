import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'lifecycle-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__lifecycle')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/lifecycle-maintenance.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [], unexpected = [], posts = [];
    let key, stage = 'drain', revision = 1, unavailable = false, malformed = false, readFailure = false, externalJob = false;
    const job = { id: 'job-1', nodeId: 'node-1', operation: 'restart', stage: 'prepare', createdAt: 1, deadline: 100000, revision: 0 };
    const status = { configured: true, nodeId: 'node-1', operations: ['restart', 'upgrade'], blocked: false, automaticUpdates: false, workerState: 'running' };
    const response = () => ({ command: { id: 'receipt-1', key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 202, body: { lifecycle: job } } },
      ...(unavailable ? {} : { job: { ...job, stage, revision } }), observationUnavailable: unavailable });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.endsWith('/lifecycle/status')) return route.fulfill({ json: malformed ? { ...status, operations: null }
        : externalJob ? { ...status, blocked: true, job: { ...job, stage: 'attention', revision: 4 } } : status });
      if (request.method() === 'POST' && url.pathname.endsWith('/commands/restart')) {
        key = request.postDataJSON().idempotencyKey; posts.push(key);
        // Node may have accepted; the response is lost. Browser must only GET.
        return route.abort('failed');
      }
      if (request.method() === 'GET' && decodeURIComponent(url.pathname).endsWith(`/commands/restart/${key}`)) {
        return readFailure ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: response() });
      }
      unexpected.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push('native dialog'); void dialog.dismiss(); });
    await page.goto(`${origin}/__lifecycle`);
    const check = () => page.getByRole('button', { name: 'Check lifecycle support', exact: true }).click();
    const restart = () => page.getByRole('button', { name: 'Restart Connector', exact: true }).click();
    const confirm = () => page.getByRole('dialog').getByRole('button', { name: 'Confirm maintenance', exact: true }).click();
    malformed = true; await check();
    await page.getByRole('alert').filter({ hasText: 'Independent Connector maintenance unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Restart Connector', exact: true }).count(), 0);
    malformed = false; externalJob = true; await check();
    await page.getByRole('status').filter({ hasText: 'Operator inspection required' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Restart Connector', exact: true }).isDisabled(), true);
    assert.equal(posts.length, 0, 'new tab can inspect a blocked job without resubmitting it');
    await page.evaluate(() => window.cycleAccount());
    await page.getByRole('status').filter({ hasText: 'Operator inspection required' }).waitFor({ state: 'hidden' });
    externalJob = false; await check(); await restart();
    await page.evaluate(() => window.cycleAccount()); await confirm();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(posts.length, 0, 'stale modal never submits after account A→B→A');
    await page.reload(); await check(); await restart(); await confirm();
    const notice = page.getByRole('region', { name: 'Connector lifecycle' });
    await notice.getByText('Outcome not confirmed. The command will not be resent.', { exact: true }).waitFor();
    assert.equal(posts.length, 1);
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1')));
    assert.equal(saved[0].key, key); assert.equal(saved[0].state, 'outcome_unknown');
    await notice.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await notice.getByRole('status').filter({ hasText: 'Waiting for running work to finish' }).waitFor();
    assert.equal(await notice.getByRole('button', { name: 'Dismiss', exact: true }).count(), 0);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    assert.equal(await page.getByRole('button', { name: 'Refresh status', exact: true }).count(), 0);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    await page.reload();
    await notice.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await notice.getByRole('status').filter({ hasText: 'Waiting for running work to finish' }).waitFor();
    await page.evaluate(() => window.removeConnection());
    assert.equal(await page.getByRole('button', { name: 'Check lifecycle support', exact: true }).count(), 0);
    unavailable = true;
    await notice.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await notice.getByText('Outcome not confirmed. The command will not be resent.', { exact: true }).waitFor();
    await notice.getByRole('status').filter({ hasText: 'Waiting for running work to finish' }).waitFor();
    unavailable = false; stage = 'succeeded'; revision = 10;
    await notice.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await notice.getByRole('status').filter({ hasText: 'Maintenance completed' }).waitFor();
    readFailure = true;
    await notice.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await notice.getByText('Outcome not confirmed. The command will not be resent.', { exact: true }).waitFor();
    assert.equal(await notice.getByRole('button', { name: 'Dismiss', exact: true }).count(), 0, 'failed refresh invalidates terminal evidence');
    readFailure = false;
    await notice.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await notice.waitFor({ state: 'hidden' });
    assert.equal(posts.length, 1, 'lost reply/reload/removal/manual recovery never resends');
    await page.reload(); await check(); await restart();
    await page.evaluate(() => window.replaceAccount()); await confirm();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(posts.length, 1, 'account replacement cannot submit original confirmation');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ viewport, posts: posts.length, errors, outcome: 'passed' }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
