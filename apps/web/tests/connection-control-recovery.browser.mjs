// Actual panel + API client. Every API and external request is fenced below;
// never dispatch to a real Connector, maintenance endpoint or native session.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const {chromium} = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
const journalKey = 'agentopsdeck.connection-control-recovery.v1';
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless: true, ...(process.env.AOD_TEST_CHROMIUM ? {executablePath: process.env.AOD_TEST_CHROMIUM} : {})});
  for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
    const context = await browser.newContext({viewport, serviceWorkers: 'block'});
    const posts = [], gets = [], external = [], errors = [];
    let scope = 'a'.repeat(64), receiptState = 'outcome_unknown', hold, deleted = false;
    const update = {supported: true, currentVersion: 'synthetic-v1', state: 'available', rollbackAvailable: false, updatedAt: 1};
    const connection = {id: 'remote-a', kind: 'remote', status: 'enabled', label: 'Synthetic node', ownerUserId: 'default', connectorUrl: 'https://synthetic.invalid'};
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) {external.push(url.origin); return route.abort();}
      if (url.pathname === '/__control') return route.fulfill({contentType: 'text/html', body: await server.transformIndexHtml('/__control',
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/maintenance-recovery.fixture.tsx"></script></body></html>')});
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(req.headers()['x-agentopsdeck-recovery-scope'], scope);
      if (url.pathname.endsWith('/sessions/state')) return route.fulfill({json: {groups: [], connections: deleted ? [] : [connection], updatedAt: 1}});
      if (url.pathname.endsWith('/users')) return route.fulfill({json: {users: []}});
      if (url.pathname.endsWith('/capabilities')) return route.fulfill({json: {connector: {version: 'synthetic-v1'}}});
      if (url.pathname.endsWith('/gateway/model-set')) return route.fulfill({json: {converged: true, missing: []}});
      if (url.pathname.endsWith('/update/status')) return route.fulfill({json: update});
      const receipt = url.pathname.match(/\/control\/receipts\/([^/]+)$/);
      if (receipt) {
        assert.equal(req.method(), 'GET'); const key = decodeURIComponent(receipt[1]); gets.push(key);
        assert.equal(url.searchParams.get('operation'), posts.find(row => row.key === key)?.operation);
        if (receiptState === 'hold') {hold = route; return;}
        if (receiptState === 'missing') return route.fulfill({status: 404, json: {error: 'Original receipt unavailable'}});
        return route.fulfill({json: {command: {key, operation: posts.find(row => row.key === key).operation, state: receiptState,
          ...(receiptState === 'accepted' ? {status: 200} : receiptState === 'rejected' ? {status: 422} : {})}}});
      }
      assert.equal(req.method(), 'POST');
      assert.ok(url.pathname.endsWith('/update/check') || url.pathname.endsWith('/gateway/model-set/reconcile'), `unexpected effect ${url.pathname}`);
      const body = req.postDataJSON(), operation = url.pathname.endsWith('/update/check') ? 'updateCheck' : 'reconcile';
      const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), journalKey);
      assert.ok(saved.some(row => row.key === body.idempotencyKey && row.operation === operation && row.state === 'outcome_unknown'), 'durable intent must precede original POST');
      posts.push({key: body.idempotencyKey, operation});
      return route.fulfill({status: 503, json: {error: 'Synthetic lost original ACK'}});
    });
    const notice = page.getByRole('region', {name: 'Saved Connector controls'});
    const openControls = async () => {await page.getByRole('button', {name: 'Expand details'}).click(); await page.getByRole('button', {name: 'Refresh status', exact: true}).click();};
    await page.goto(`${origin}/__control`); await openControls();
    await page.getByRole('button', {name: 'Check update', exact: true}).click();
    await notice.getByText(/outcome unknown/).waitFor(); assert.equal(posts.length, 1); assert.equal(gets.length, 0);
    const original = posts[0].key;
    assert.equal(await page.getByRole('button', {name: 'Check update', exact: true}).isDisabled(), true);
    assert.equal(await page.getByRole('button', {name: 'Reconcile model set', exact: true}).isDisabled(), true);
    assert.equal(await notice.getByRole('button', {name: 'Dismiss', exact: true}).count(), 0);
    // The recovery notice outlives the connection row, and reload never re-POSTs.
    deleted = true; await page.reload(); await notice.getByText(original).waitFor(); assert.equal(posts.length, 1);
    receiptState = 'missing'; await notice.getByRole('button', {name: 'Query original receipt'}).click();
    await notice.getByRole('alert').waitFor(); assert.equal(posts.length, 1);
    assert.equal(await notice.getByRole('button', {name: 'Dismiss', exact: true}).count(), 0);
    // A query from the previous account cannot mutate the new account UI/journal.
    receiptState = 'hold'; await notice.getByRole('button', {name: 'Query original receipt'}).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Saved Connector controls"] button:disabled'));
    scope = 'b'.repeat(64); await page.evaluate(() => window.maintenanceFixture.account('b'));
    await notice.waitFor({state: 'hidden'});
    if (hold) await hold.fulfill({json: {command: {key: original, operation: 'updateCheck', state: 'accepted', status: 200}}}).catch(() => {});
    scope = 'a'.repeat(64); receiptState = 'accepted'; await page.evaluate(() => window.maintenanceFixture.account('a'));
    await notice.getByText(/outcome unknown/).waitFor();
    await notice.getByRole('button', {name: 'Query original receipt'}).click(); await notice.getByText(/command completed/).waitFor();
    assert.equal(gets.at(-1), original); assert.equal(posts.length, 1);
    await notice.getByRole('button', {name: 'Dismiss', exact: true}).click(); await notice.waitFor({state: 'hidden'});
    deleted = false; await page.reload(); await openControls();
    await page.getByRole('button', {name: 'Reconcile model set', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Maintain “Synthetic node”?'}); await dialog.waitFor(); assert.equal(posts.length, 1);
    await dialog.getByRole('button', {name: 'Confirm maintenance', exact: true}).click();
    await notice.getByText(/outcome unknown/).waitFor(); assert.equal(posts.length, 2); assert.notEqual(posts[1].key, original);
    receiptState = 'rejected'; await notice.getByRole('button', {name: 'Query original receipt'}).click(); await notice.getByText(/rejected/).waitFor();
    await notice.getByRole('button', {name: 'Dismiss', exact: true}).click();
    // Corrupt or unwritable journal blocks effects, not just status queries.
    await page.evaluate(key => sessionStorage.setItem(key, '{broken'), journalKey); await page.reload(); await openControls();
    await notice.getByRole('alert').waitFor(); assert.equal(await page.getByRole('button', {name: 'Check update', exact: true}).isDisabled(), true);
    await page.evaluate(key => sessionStorage.removeItem(key), journalKey); await page.reload(); await openControls();
    await page.evaluate(key => {const set = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) {if (k === key) throw Error('Synthetic storage failure'); return set.call(this, k, v);};}, journalKey);
    await page.getByRole('button', {name: 'Check update', exact: true}).click();
    await page.getByText('Synthetic storage failure', {exact: true}).waitFor(); assert.equal(posts.length, 2);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
    console.log(`PASS: original control recovery ${viewport.width}: persisted before POST, reload/scope/404/query-only/terminal/storage fences`);
  }
} finally {await browser?.close(); await server.close();}
