import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'access-fixture', configureServer(instance) {
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
    const writes = [], errors = [], nativeDialogs = [], unexpected = [], revocationReads = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push('non-fixture traffic'); return route.abort();
    });
    let role = 'member', grants = [], revocationStatus = 404, grantVersion = 0;
    let revocation = { state: 'pending', pending: 1, confirmed: 0 };
    const connection = { id: 'fixture-node', ownerUserId: 'fixture-owner', label: 'Fixture environment', nodeVersion: 1,
      verified: true, creationReady: true, appointAdministrators: true, owner: true };
    let membership = { role: 'observer', version: 1, nodeVersion: 1, editable: true,
      environments: { codex: 'observer', openclaw: 'disabled' }, legacyCount: 0, legacyBroad: 0, inherited: null, grantSetDigest: 'd'.repeat(64) };
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const body = method === 'GET' ? undefined : request.postDataJSON();
      if (method !== 'GET') writes.push({ method, path: url.pathname, body });
      if (url.pathname.endsWith('/access/directory')) return route.fulfill({ json: { administrator: true, connections: [connection], users: [] } });
      if (url.pathname.endsWith('/me')) return route.fulfill({ json: { userId: 'fixture-operator', admin: true } });
      if (url.pathname.endsWith('/hub-role')) {
        if (method === 'PUT') role = body.role;
        return route.fulfill({ json: { role, version: 1 } });
      }
      if (url.pathname.includes('/members/')) {
        if (method === 'PUT') membership = { ...membership, role: body.role, environments: body.environments, version: 2 };
        return route.fulfill({ json: membership });
      }
      if (url.pathname.endsWith('/collaborators')) {
        if (method === 'POST') grants = [{ id: 'fixture-grant', userId: body.userId, version: ++grantVersion, nodeVersion: 1, revoked: false, policy: { actions: ['sessions:read'] } }];
        return route.fulfill({ json: method === 'GET' ? { collaborators: grants, candidates: [{ id: 'fixture-member', label: 'Fixture member', canChat: true }] } : { grant: grants[0] } });
      }
      if (url.pathname.endsWith('/collaborators/fixture-grant') && method === 'DELETE') {
        grants = []; return route.fulfill({ json: { ok: true, revocation } });
      }
      if (url.pathname.endsWith('/collaborators/fixture-grant/revocation') && method === 'GET') {
        revocationReads.push(url.search);
        return route.fulfill({ status: revocationStatus, json: revocationStatus === 200 ? { revocation } : { error: 'Original outcome unavailable' } });
      }
      unexpected.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: 'unexpected fixture request' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.goto(`${origin}/__access`);
    const hubRole = () => page.getByRole('combobox', { name: 'Hub role', exact: true });
    await hubRole().selectOption('admin');
    await page.getByRole('button', { name: 'Save Hub role', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Change Hub role?' });
    await dialog.waitFor(); await page.keyboard.press('Escape');
    assert.equal(writes.length, 0);
    // The same visible user returning does not resurrect an old authorization.
    await page.getByRole('button', { name: 'Save Hub role', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.replaceAccessUser('other-member'));
    await page.locator('main[data-fixture-user="other-member"]').waitFor();
    await page.evaluate(() => window.replaceAccessUser('fixture-member'));
    await page.locator('main[data-fixture-user="fixture-member"]').waitFor();
    await dialog.getByRole('button', { name: 'Save Hub role', exact: true }).click();
    assert.equal(writes.length, 0);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByRole('combobox', { name: 'Hub 角色', exact: true }).selectOption('admin');
    await page.getByRole('button', { name: '保存 Hub 角色', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '更改 Hub 角色？' });
    const membershipReload = page.waitForResponse(response => response.url().includes('/members/') && response.request().method() === 'GET');
    await dialog.getByRole('button', { name: '保存 Hub 角色', exact: true }).click();
    await membershipReload;
    await page.waitForFunction(() => {
      const select = document.querySelector('select[aria-label="Fixture environment 角色"]');
      return select && !select.disabled && select.value === 'observer';
    });
    await page.getByRole('combobox', { name: 'Fixture environment 角色' }).selectOption('developer');
    await page.getByRole('button', { name: '保存权限', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '更改环境权限？' });
    await dialog.getByRole('button', { name: '保存权限', exact: true }).click();
    await page.getByText('已保存', { exact: true }).waitFor();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.role, 'admin');
    assert.deepEqual(writes[1].body, { role: 'developer', environments: { codex: 'developer', openclaw: 'disabled' }, version: 1, nodeVersion: 1, migrateLegacy: false, grantSetDigest: 'd'.repeat(64) });
    await page.getByRole('button', { name: '分享会话', exact: true }).click();
    await page.getByRole('combobox', { name: '分享给成员' }).selectOption('fixture-member');
    await page.getByRole('button', { name: '分享', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '更改会话权限？' });
    await dialog.waitFor();
    await page.evaluate(() => window.replaceAccessSession('other-session'));
    await page.locator('main[data-fixture-session="other-session"]').waitFor();
    await page.getByRole('button', { name: '分享会话', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '分享', exact: true }).click();
    assert.equal(writes.length, 2, 'session switch invalidates pending share');
    await page.getByRole('button', { name: '分享会话', exact: true }).click();
    await page.getByRole('combobox', { name: '分享给成员' }).selectOption('fixture-member');
    await page.getByRole('button', { name: '分享', exact: true }).click();
    await dialog.getByRole('button', { name: '分享', exact: true }).click();
    await page.getByRole('button', { name: '撤销权限', exact: true }).waitFor();
    assert.equal(writes.length, 3);
    assert.deepEqual(writes[2].body, { userId: 'fixture-member', role: 'observer' });
    await page.getByRole('button', { name: '撤销权限', exact: true }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.replaceAccessAccount());
    await page.locator('main[data-fixture-scope="1"]').waitFor();
    await dialog.getByRole('button', { name: '撤销权限', exact: true }).click();
    assert.equal(writes.length, 3, 'account switch invalidates pending revocation');

    // A new page incarnation recovers only its exact account/session references.
    await page.reload(); await page.getByRole('combobox').first().selectOption('en');
    await page.getByRole('button', { name: 'Share session', exact: true }).click();
    await page.getByRole('button', { name: 'Remove access', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Change session access?' });
    await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
    await page.getByText('Revoked locally; waiting for 1 remote leases. Confirmed: 0.', { exact: true }).waitFor();
    assert.deepEqual(writes.at(-1).body, { version: 1 });
    const deletionCount = writes.filter(write => write.method === 'DELETE').length;
    await page.getByRole('button', { name: 'Check original revocation', exact: true }).click();
    await page.getByText('Original revocation could not be confirmed. Its reference is kept; no access change was resent.', { exact: true }).waitFor();
    assert.equal(writes.filter(write => write.method === 'DELETE').length, deletionCount);
    await page.reload();
    await page.getByRole('button', { name: 'Share session', exact: true }).click();
    await page.getByText('Original revocation outcome unknown. Check its result; do not resend.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Remove access', exact: true }).count(), 0);
    revocationStatus = 200; revocation = { state: 'confirmed', pending: 0, confirmed: 1 };
    await page.getByRole('button', { name: 'Check original revocation', exact: true }).click();
    await page.getByText('Remote revocation confirmed for 1 leases.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).last().click();
    await page.getByText('Remote revocation confirmed for 1 leases.', { exact: true }).waitFor();
    assert.deepEqual(revocationReads, ['?version=1', '?version=1']);
    assert.equal(writes.filter(write => write.method === 'DELETE').length, deletionCount);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('agentopsdeck.session-revocation.v1')).items), []);

    // No matching lease is not presented as a remote execution ACK.
    await page.getByRole('combobox', { name: 'Share with member' }).selectOption('fixture-member');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    revocation = { state: 'confirmed', pending: 0, confirmed: 0 };
    await page.getByRole('button', { name: 'Remove access', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
    await page.getByText('Revoked locally; no matching remote execution leases.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []); assert.deepEqual(unexpected, []);
    console.log(`PASS access/share bilingual modal, stale authority, exact revocation recovery/no replay and no-lease distinction ${viewport.width}x${viewport.height}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
