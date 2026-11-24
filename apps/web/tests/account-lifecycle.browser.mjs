import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'account-lifecycle-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__access')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/access-sharing.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 } });

let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const writes = [], errors = [], dialogs = [], unexpected = [];
    const accounts = new Map(), credentials = new Map();
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push('non-fixture traffic'); return route.abort();
    });
    let nextAck = 'normal', nextReadFailure, releaseAck, ackStarted, disableDuringIssue = false;
    const accessFor = id => accounts.get(id) ?? { userId: id, status: 'enabled', version: 0 };
    const keysFor = id => credentials.get(id) ?? [{ id: 'fixture-key', createdAt: 1, loginCount: 0 }];
    await context.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
      if (method !== 'GET') writes.push({ method, path, body: req.postDataJSON() });
      const match = path.match(/\/users\/([^/]+)\/(access|login-keys)$/);
      if (match) {
        const id = decodeURIComponent(match[1]), resource = match[2];
        if (method === 'GET' && nextReadFailure === resource) {
          nextReadFailure = undefined;
          return route.fulfill({ status: 503, json: { error: 'read unavailable' } });
        }
        if (resource === 'access') {
          if (method === 'GET') return route.fulfill({ json: { access: accessFor(id) } });
          const body = req.postDataJSON(), reviewed = accessFor(id);
          assert.equal(body.expectedVersion, reviewed.version, 'PATCH uses exactly the reviewed version');
          const ack = nextAck; nextAck = 'normal';
          if (ack === '409') return route.fulfill({ status: 409, json: { error: 'conflict' } });
          const access = { userId: id, status: body.status, version: reviewed.version + 1 };
          accounts.set(id, access);
          if (access.status === 'disabled') credentials.set(id, []);
          if (ack === 'hold') await new Promise(resolve => { releaseAck = resolve; ackStarted(); });
          if (ack === '503') return route.fulfill({ status: 503, json: { error: 'unknown after commit' } });
          if (ack === 'malformed') return route.fulfill({ json: { access: { ...access, userId: 'wrong-target' } } });
          return route.fulfill({ json: { access } });
        }
        if (method === 'GET') return route.fulfill({ json: { keys: keysFor(id) } });
        credentials.set(id, [...keysFor(id), { id: 'issued-key', createdAt: 2, loginCount: 0 }]);
        if (disableDuringIssue) {
          disableDuringIssue = false;
          accounts.set(id, { userId: id, status: 'disabled', version: accessFor(id).version + 1 });
          credentials.set(id, []);
        }
        return route.fulfill({ json: { id: 'issued-key', token: 'synthetic-lifecycle-secret' } });
      }
      if (path.endsWith('/access/directory')) return route.fulfill({ json: { administrator: false, connections: [], users: [] } });
      if (path.endsWith('/grants')) return route.fulfill({ json: { nodeVersion: 1, verified: true, executionConfigured: true, creationConfigured: true, grants: [], nextCursor: null } });
      if (path.endsWith('/state')) return route.fulfill({ json: { groups: [] } });
      unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 404, json: { error: 'unexpected fixture request' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    const lifecycle = () => page.getByRole('region', { name: 'Account lifecycle', exact: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const fresh = async () => {
      accounts.clear(); credentials.clear();
      await page.goto(`${origin}/__access?keys=1`);
      await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
      await page.getByText('Account enabled · version 0', { exact: true }).waitFor();
    };
    const selectUser = async id => {
      await page.evaluate(id => window.replaceAccessUser(id), id);
      await page.locator(`main[data-fixture-user="${id}"]`).waitFor();
    };
    const confirm = async name => {
      await button(name).click();
      const dialog = page.getByRole('dialog', { name, exact: true });
      await dialog.getByRole('button', { name, exact: true }).click();
    };
    const refresh = async () => { await button('Refresh account & keys').click(); };
    const openKeys = async () => {
      const details = page.getByLabel('Member login keys', { exact: true });
      if (!await details.evaluate(node => node.open)) await page.getByText('Login & keys', { exact: true }).click();
    };

    await fresh();
    const initialWrites = writes.length;
    await button('Disable account').click();
    await page.getByRole('dialog', { name: 'Disable account', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(writes.length, initialWrites, 'cancel performs no PATCH');
    for (const id of ['default', 'fixture-owner']) {
      await selectUser(id);
      await page.getByText('Default and your own account cannot be disabled here.', { exact: true }).waitFor();
      assert.equal(await button('Disable account').isDisabled(), true);
    }
    await selectUser('fixture-member');
    await page.getByText('Account enabled · version 0', { exact: true }).waitFor();
    await openKeys();
    await button('Issue member login key').click();
    await page.getByRole('textbox', { name: 'One-time member login key' }).waitFor();
    await confirm('Disable account');
    await page.getByText('Account disabled · version 1', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'One-time member login key' }).count(), 0);
    assert.equal(await button('Issue member login key').isDisabled(), true);
    assert.equal(await button('Restore account').isDisabled(), true, 'ACK alone does not authorize another write');
    await refresh();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Restore account' && !node.disabled));
    await confirm('Restore account');
    await page.getByText('Account enabled · version 2', { exact: true }).waitFor();
    assert.equal(await button('Issue member login key').isDisabled(), true);
    assert.deepEqual(credentials.get('fixture-member'), [], 'restore never resurrects credentials');
    await refresh();
    await page.getByText('Login key needed', { exact: true }).waitFor();
    assert.equal(await button('Issue member login key').isEnabled(), true);
    assert.deepEqual(writes.slice(initialWrites).map(row => row.body), [null, { status: 'disabled', expectedVersion: 0 }, { status: 'enabled', expectedVersion: 1 }]);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByText('账号已启用 · 版本 2', { exact: true }).waitFor();
    await confirm('停用账号');
    await page.getByText('账号已停用 · 版本 3', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width && rect.right > innerWidth + 1;
    }).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 60) }))), []);

    for (const resource of ['access', 'login-keys']) {
      await fresh(); await openKeys(); const before = writes.length; nextReadFailure = resource;
      await refresh(); await lifecycle().getByRole('alert').waitFor();
      assert.equal(await button('Disable account').isDisabled(), true);
      assert.equal(await button('Issue member login key').isDisabled(), true);
      assert.equal(writes.length, before);
      await refresh(); await page.getByText('Account enabled · version 0', { exact: true }).waitFor();
    }

    for (const ack of ['409', '503', 'malformed']) {
      await fresh(); const before = writes.length; nextAck = ack;
      await confirm('Disable account');
      await lifecycle().getByRole('alert').waitFor();
      assert.equal(await button('Disable account').isDisabled(), true);
      assert.equal(writes.length, before + 1, 'unknown ACK is never retried');
      await refresh();
      await page.getByText(ack === '409' ? 'Account enabled · version 0' : 'Account disabled · version 1', { exact: true }).waitFor();
      assert.equal(writes.length, before + 1, 'recovery reads without replay');
    }

    for (const identity of ['user', 'account']) {
      await fresh(); const before = writes.length;
      await button('Disable account').click();
      const dialog = page.getByRole('dialog', { name: 'Disable account', exact: true }); await dialog.waitFor();
      if (identity === 'user') { await selectUser('other-member'); await selectUser('fixture-member'); }
      else await page.evaluate(() => window.cycleAccessAccount());
      await dialog.getByRole('button', { name: 'Disable account', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(writes.length, before, `${identity} ABA during confirmation cannot dispatch`);
    }

    for (const identity of ['user', 'account']) {
      await fresh(); const before = writes.length; nextAck = 'hold';
      const started = new Promise(resolve => { ackStarted = resolve; });
      await confirm('Disable account'); await started;
      if (identity === 'user') { await selectUser('other-member'); await selectUser('fixture-member'); }
      else await page.evaluate(() => window.cycleAccessAccount());
      const response = page.waitForResponse(response => response.request().method() === 'PATCH');
      releaseAck(); await response;
      assert.equal(writes.length, before + 1);
      assert.equal(await page.getByText('Account disabled. Refresh to check its current state. Already dispatched tools are not stopped.', { exact: true }).count(), 0, `${identity} ABA cannot publish old success`);
    }

    await fresh(); await openKeys(); disableDuringIssue = true;
    await button('Issue member login key').click();
    await page.getByText('Account state changed during key issuance. Its secret was discarded. Review the current account and key list before proceeding.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'One-time member login key' }).count(), 0);
    assert.equal(await button('Issue member login key').isDisabled(), true);
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []); assert.deepEqual(unexpected, []);
    console.log(`PASS account lifecycle disable/restore, no-replay, protection, bilingual, identity ABA and issuance fence ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
