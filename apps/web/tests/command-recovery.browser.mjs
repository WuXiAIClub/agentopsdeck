// Isolated component/HTTP/browser regression. No real Hub, Connector, tokens,
// sessions or agent calls. Supply an already installed Playwright module path.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
let server;
let mode = 'offline', posts = 0, queries = 0, scope = 'a'.repeat(64), cancelled = 0;
let stallClosed;
let submittedBody;
async function fixtureMiddleware(req, res, next) {
  if (req.url?.startsWith('/__recovery')) {
    res.setHeader('content-type', 'text/html');
    res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/command-recovery.fixture.tsx"></script></body></html>'));
    return;
  }
  if (!req.url?.startsWith('/api/')) return next();
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-agentopsdeck-recovery-scope'] !== scope) {
    res.statusCode = 409; res.end(JSON.stringify({ error: 'Authenticated account or Hub changed; reload before continuing' })); return;
  }
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    submittedBody = JSON.parse(body);
    posts++; res.statusCode = 502; res.end('{}'); return;
  }
  queries++;
  if (req.url.endsWith('/stall')) {
    res.write('{"command":');
    stallClosed = new Promise((resolve) => res.on('close', () => { cancelled++; resolve(); }));
    return;
  }
  if (mode === 'offline') { res.statusCode = 503; res.end('{}'); return; }
  if (mode === 'missing' || mode === 'denied') { res.statusCode = mode === 'missing' ? 404 : 403; res.end('{}'); return; }
  if (mode === 'malformed') { res.end('{}'); return; }
  res.end(JSON.stringify({ command: { id: 'receipt', key: decodeURIComponent(req.url.split('/').pop()), state: mode,
    createdAt: 1, updatedAt: 2, ...(mode === 'accepted' ? { result: { status: 202, body: { ok: true, status: 'queued' } } } : {}) } }));
}
server = await createServer({ root, configFile: false,
  plugins: [react(), tailwindcss(), { name: 'isolated-recovery-fixture', configureServer(instance) { instance.middlewares.use(fixtureMiddleware); } }],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    mode = 'offline'; posts = 0; queries = 0; scope = 'a'.repeat(64);
    const context = await browser.newContext({ viewport });
    // Hard network boundary: a regression cannot contact localhost:8790 or any
    // configured production service from this fixture.
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(() => {
      const fetch = window.fetch;
      window.receiptCacheModes = [];
      window.fetch = (input, init) => {
        if (String(input).includes('/commands/')) window.receiptCacheModes.push(init?.cache);
        return fetch(input, init);
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const notice = page.getByRole('region', { name: 'Command delivery recovery' });
    await page.goto(`${origin}/__recovery`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    await page.evaluate(() => window.recoveryFixture.writeCache());
    assert.equal(await page.evaluate(() => window.recoveryFixture.readCache().messages[0].id), 'synthetic-message');
    await page.evaluate(() => window.recoveryFixture.submit());
    await notice.getByText(/Delivery unknown/).waitFor();
    assert.equal(posts, 1); assert.equal(queries, 1);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('synthetic body')), false);
    await notice.getByText(/Receipt unavailable. Retrying automatically/).waitFor();
    assert.equal(queries, 2, 'new unknown records must start recovery without a reload');
    mode = 'accepted';
    await page.waitForFunction(() => window.recoveryFixture.recovered().some(row => row.key === 'synthetic-command' && row.status === 'queued'));
    assert.deepEqual(await page.evaluate(() => window.recoveryFixture.rows()), []);
    assert.equal(await notice.count(), 0, 'confirmed receipt retires unknown delivery, not execution');
    assert.equal(await notice.getByText(/Receipt unavailable/).count(), 0, 'successful recovery clears its failure');
    assert.equal(posts, 1, 'automatic recovery must not POST again');
    assert.equal(queries, 3);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0);
    assert.equal(queries, 3, 'accepted records do not poll after refresh');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile/desktop must not overflow');
    // A different account on the same origin must not display or query A's row.
    scope = 'b'.repeat(64);
    await page.goto(`${origin}/__recovery?scope=${scope}`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0); assert.equal(queries, 3);
    assert.equal(await page.evaluate(() => window.recoveryFixture.readCache()), undefined, 'no cross-account cached message hydration');
    scope = 'a'.repeat(64);
    await page.goto(`${origin}/__recovery`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0);
    assert.equal(await page.evaluate(() => window.recoveryFixture.readCache().messages[0].id), 'synthetic-message');
    assert.deepEqual(await page.evaluate(() => window.recoveryFixture.rows()), []);
    assert.equal(await notice.count(), 0);
    mode = 'outcome_unknown';
    await page.evaluate(() => window.recoveryFixture.submit(true));
    await notice.getByText(/Delivery unknown/).waitFor();
    assert.equal(submittedBody.message, '/stop');
    assert.equal(submittedBody.expectedRunId, 'synthetic-turn');
    await page.reload();
    await notice.getByText(/Delivery unknown/).waitFor();
    await page.waitForFunction(() => !document.body.textContent.includes('checking receipts'));
    assert.equal(posts, 2);
    assert.equal(await page.evaluate(() => window.recoveryFixture.rows()[0].state), 'outcome_unknown');
    const previousCancelled = cancelled;
    assert.equal(await page.evaluate(() => window.recoveryFixture.cancelRead()), true, 'abort must cover partial response bodies');
    let deadline;
    try {
      await Promise.race([stallClosed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Partial response was not cancelled')), 2000); })]);
    } finally { clearTimeout(deadline); }
    assert.equal(cancelled, previousCancelled + 1);
    assert.ok((await page.evaluate(() => window.receiptCacheModes)).every(mode => mode === 'no-store'), 'receipt reads bypass cached errors and pending results');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${viewport.width}px: one POST, automatic recovery and retry, refresh, account isolation, bound stop unknown retained without redispatch, no overflow, partial body abort`);
  }
  // Distinguish errors, retain unknown identities, resume after offline, and
  // recover beyond the visible four-row page. No send endpoint is called.
  for (const failure of ['missing', 'denied', 'malformed']) {
    mode = failure; posts = 0; queries = 0; scope = 'a'.repeat(64);
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${origin}/__recovery`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    await page.evaluate(() => window.recoveryFixture.seedRecovery(['recovery-a']));
    const diagnostic = failure === 'missing' ? /Receipt not found/ : failure === 'denied' ? /Receipt access denied/ : /Receipt unavailable. Retrying automatically/;
    await page.getByText(diagnostic).waitFor();
    assert.equal(await page.evaluate(() => window.recoveryFixture.rows()[0].state), 'outcome_unknown');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
      window.recoveryFixture.seedRecovery(['recovery-b', 'recovery-c', 'recovery-d', 'recovery-e', 'recovery-f']);
    });
    const before = queries;
    await page.clock.install(); await page.clock.fastForward(65_000);
    assert.equal(queries, before, 'offline timer must not query');
    mode = 'accepted';
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });
    await page.clock.runFor(1);
    await page.waitForFunction(() => window.recoveryFixture.recovered().length === 4);
    await page.clock.runFor(1_100);
    await page.waitForFunction(() => window.recoveryFixture.recovered().length === 6);
    assert.deepEqual(await page.evaluate(() => window.recoveryFixture.rows()), []);
    assert.deepEqual(await page.evaluate(() => window.recoveryFixture.recovered().map(row => row.key).sort()),
      ['recovery-a', 'recovery-b', 'recovery-c', 'recovery-d', 'recovery-e', 'recovery-f']);
    assert.equal(await page.getByText(diagnostic).count(), 0);
    const completed = queries; await page.clock.fastForward(120_000);
    assert.equal(queries, completed); assert.equal(posts, 0);
    await context.close();
    console.log(`PASS ${failure}: diagnostic, unknown retained, offline pause, online recovery of six records, no redispatch`);
  }
} finally { await browser?.close(); await server.close(); }
