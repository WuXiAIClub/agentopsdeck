// Actual connection panel and API client; synthetic loopback responses only.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const posts = [], gets = [], errors = [], external = [], receipts = new Map();
    let mode = 'unknown', scope = 'a'.repeat(64), deleted = false, held;
    const update = { supported: true, currentVersion: 'synthetic-v1', state: 'available', rollbackAvailable: true,
      targetVersion: 'synthetic-v2', manifestSha256: 'a'.repeat(64), updatedAt: 2 };
    const connection = { id: 'remote-a', kind: 'remote', status: 'enabled', label: 'Synthetic node', ownerUserId: 'default', connectorUrl: 'https://synthetic.invalid' };
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname === '/__maintenance') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__maintenance',
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/maintenance-recovery.fixture.tsx"></script></body></html>') });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(req.headers()['x-agentopsdeck-recovery-scope'], scope);
      if (url.pathname.endsWith('/sessions/state')) return route.fulfill({ json: { groups: [], connections: deleted ? [] : [connection], updatedAt: 1 } });
      if (url.pathname.endsWith('/users')) return route.fulfill({ json: { users: [] } });
      if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: { connector: { version: 'synthetic-v1' } } });
      if (url.pathname.endsWith('/gateway/model-set')) return route.fulfill({ json: { converged: true, missing: [] } });
      if (url.pathname.endsWith('/update/status')) return route.fulfill({ json: update });
      if (url.pathname.endsWith('/maintenance-credential')) return route.fulfill({ json: { ok: true } });
      const match = url.pathname.match(/\/update\/commands\/(apply|rollback)(?:\/([^/]+))?$/);
      assert.ok(match, `unexpected/legacy request ${req.method()} ${url.pathname}`);
      if (req.method() === 'POST') {
        assert.equal(match[2], undefined);
        const body = req.postDataJSON(), key = body.idempotencyKey;
        posts.push({ operation: match[1], key });
        const result = { ...update, state: mode === 'failed' ? 'failed' : match[1] === 'apply' ? 'succeeded' : 'rolled_back', restartRequired: true };
        const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: result } };
        receipts.set(key, command);
        return mode === 'direct' || mode === 'failed' ? route.fulfill({ json: { ...result, command } }) : route.fulfill({ status: 202, json: { command: { ...command, state: 'outcome_unknown', result: undefined } } });
      }
      assert.equal(req.method(), 'GET'); const key = decodeURIComponent(match[2]); gets.push(key);
      if (key === 'same-key') return route.fulfill({ json: { command: { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2,
        result: { status: 200, body: { ...update, state: url.pathname.includes('/remote-a/') ? 'succeeded' : 'failed' } } } } });
      if (mode === 'hold') { held = route; return; }
      if (mode === 'unknown') return route.fulfill({ status: 503, json: { error: 'Original receipt unavailable' } });
      assert.ok(receipts.has(key)); return route.fulfill({ json: { command: receipts.get(key) } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
    const openControls = async () => { await page.getByRole('button', { name: 'Expand details' }).click(); await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); };
    const confirmMaintenance = async name => {
      const before = posts.length;
      await page.getByRole('button', { name, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Maintain “Synthetic node”?' });
      await dialog.waitFor();
      assert.equal(posts.length, before, 'opening confirmation must not submit maintenance');
      await dialog.getByRole('button', { name: 'Confirm maintenance', exact: true }).click();
    };
    await page.goto(`${origin}/__maintenance`); await openControls();
    await page.getByLabel('Maintenance credential').fill('synthetic-transient-secret');
    await page.getByRole('button', { name: 'Save credential', exact: true }).click();
    await confirmMaintenance('Apply approved update');
    const notice = page.getByRole('region', { name: 'Connector maintenance recovery' });
    await notice.getByText(/outcome unknown/).waitFor();
    await page.getByText(/Maintenance outcome unknown\./).waitFor();
    assert.equal(posts.length, 1); assert.equal(gets.length, 1);
    assert.equal(await page.getByRole('button', { name: 'Apply approved update' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Rollback Connector' }).isDisabled(), true);
    assert.equal(await notice.getByRole('button', { name: 'Dismiss' }).count(), 0);
    const raw = await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1'));
    assert.equal(/secret|manifestSha256|currentVersion|synthetic-v2/.test(raw), false);
    const original = posts[0].key; assert.equal(JSON.parse(raw)[0].key, original);
    deleted = true; await page.reload(); await notice.getByText(/outcome unknown/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Expand details' }).count(), 0);
    assert.equal(posts.length, 1);
    mode = 'resolved'; await notice.getByRole('button', { name: 'Query original receipt' }).click();
    await notice.getByText(/command completed/).waitFor(); await notice.getByText(/restart required/).waitFor();
    assert.equal(gets.at(-1), original); assert.equal(posts.length, 1);
    await notice.getByRole('button', { name: 'Dismiss' }).click(); await notice.waitFor({ state: 'hidden' });
    deleted = false; mode = 'failed'; await page.reload(); await openControls();
    const beforeGets = gets.length; await confirmMaintenance('Apply approved update');
    await notice.getByText(/failed · restart required/).waitFor(); assert.equal(gets.length, beforeGets, 'valid POST does not need GET');
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    mode = 'direct'; await confirmMaintenance('Rollback Connector');
    await notice.getByText(/rolled_back · restart required/).waitFor(); assert.equal(posts.at(-1).operation, 'rollback');
    // Old account's in-flight result cannot be shown or clear the new account's journal.
    mode = 'hold'; await notice.getByRole('button', { name: 'Query original receipt' }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Connector maintenance recovery"] button:disabled'));
    scope = 'b'.repeat(64); await page.evaluate(() => window.maintenanceFixture.account('b'));
    await notice.waitFor({ state: 'hidden' });
    if (held) await held.fulfill({ json: { command: receipts.get(posts.at(-1).key) } }).catch(() => {});
    assert.equal(await notice.count(), 0);
    scope = 'a'.repeat(64); mode = 'resolved'; await page.evaluate(() => window.maintenanceFixture.account('a'));
    await notice.getByText(/command completed/).waitFor();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    // Identical keys on different nodes must not share result UI or query flights.
    await page.evaluate(() => sessionStorage.setItem('agentopsdeck.command-recovery.v1', JSON.stringify(['remote-a', 'remote-b'].map(connectionId => ({
      scope: 'a'.repeat(64), key: 'same-key', state: 'accepted', createdAt: 1, maintenance: { connectionId, operation: 'apply' },
    })))));
    await page.reload();
    const nodeA = notice.locator('[data-maintenance-target="remote-a"]'), nodeB = notice.locator('[data-maintenance-target="remote-b"]');
    await nodeA.getByRole('button', { name: 'Query original receipt' }).click();
    await nodeB.getByRole('button', { name: 'Query original receipt' }).click();
    await nodeA.getByText(/same-key · succeeded/).waitFor(); await nodeB.getByText(/same-key · failed/).waitFor();
    await nodeB.getByRole('button', { name: 'Dismiss' }).click();
    await nodeA.getByText(/same-key · succeeded/).waitFor(); await nodeA.getByRole('button', { name: 'Dismiss' }).click();
    // Storage refusal must precede every mutation, even if buttons were enabled.
    const beforePosts = posts.length;
    await openControls();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('synthetic quota'); }; });
    await confirmMaintenance('Apply approved update');
    await page.getByText(/synthetic quota/).waitFor(); assert.equal(posts.length, beforePosts);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`maintenance UI ${viewport.width}: loss/refresh/deletion, final failure, direct ACK, rollback, account switch, cross-node same key, quota passed`);
    await context.close();
  }
} finally { if (browser) await browser.close(); await server.close(); }
