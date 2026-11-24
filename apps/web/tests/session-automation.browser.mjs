import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { AutomationConfigurationStore } from '../../server/src/commands/automation-configuration.ts';
import { AutomationStore } from '../../server/src/commands/automation-store.ts';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    const db = new DatabaseSync(':memory:'), store = new AutomationStore(db);
    const config = new AutomationConfigurationStore(db, (owner, target) => owner === 'owner' && target.sessionId === 'codex:fixture');
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
    let posts = 0, drop = true, missing = false, failGet = true;
    try {
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, origin);
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.ok(url.pathname.includes('/automation'), 'configuration only, no session send');
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname.endsWith('/automation')) return failGet ? json({ error: 'forbidden' }, 403) : json({ ownerId: 'owner', connectionId: 'node', sessionId: 'codex:fixture', rules: store.list('owner') });
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        if (req.method() === 'POST') {
          posts++; if (missing) return route.abort();
          const receipt = config.configure('owner', id, req.postDataJSON());
          if (drop) { drop = false; return route.abort(); } return json(receipt);
        }
        assert.equal(req.method(), 'GET'); const receipt = config.original('owner', id);
        return receipt ? json(receipt) : json({ error: 'not_found' }, 404);
      });
      const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
      const open = async () => { await page.goto(`${origin}/tests/fixtures/session-automation.html`); await page.getByRole('button', { name: 'Open automation', exact: true }).click(); await page.getByRole('button', { name: 'Save disabled rule', exact: true }).waitFor(); };
      await open(); const dialog = page.getByRole('dialog');
      await dialog.getByRole('alert').waitFor();
      await dialog.getByLabel('Automation message', { exact: true }).fill('PRIVATE_TEMPLATE');
      assert.equal(await dialog.getByRole('button', { name: 'Save disabled rule', exact: true }).isDisabled(), true, 'submit disabled while view unavailable');
      assert.equal(await dialog.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), true, 'refresh stays interactive when initial GET fails');
      failGet = false;
      await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
      assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
      await dialog.getByRole('button', { name: 'Save disabled rule', exact: true }).click(); await dialog.getByRole('alert').waitFor();
      assert.equal(posts, 1); assert.equal(store.list('owner')[0].rule.enabled, false);
      await open(); await dialog.getByText('PRIVATE_TEMPLATE', { exact: true }).waitFor();
      assert.equal(posts, 1); assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)).includes('PRIVATE_TEMPLATE')), false);
      await dialog.getByLabel('Automation message', { exact: true }).fill('Enabled test');
      await dialog.getByRole('checkbox').check(); await dialog.getByLabel('Maximum sends', { exact: true }).fill('2');
      assert.equal(await dialog.getByRole('checkbox').isChecked(), false, 'editing resets activation consent');
      await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Save and enable automation', exact: true }).click();
      await dialog.getByRole('button', { name: 'Pause automation', exact: true }).filter({ visible: true }).last().waitFor();
      await page.waitForFunction(() => !document.querySelector('fieldset').disabled);
      assert.equal(store.list('owner').filter(s => s.rule.enabled).length, 1);
      // Pick the enabled rule independently of store ordering.
      for (const button of await dialog.getByRole('button', { name: 'Pause automation', exact: true }).all()) if (await button.isEnabled()) { await button.click(); break; }
      await page.waitForFunction(() => !document.querySelector('fieldset').disabled);
      assert.equal(store.list('owner').filter(s => s.rule.enabled).length, 0);
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'narrow dialog fits');
      missing = true; await dialog.getByRole('button', { name: 'Save disabled rule', exact: true }).click(); await dialog.getByRole('alert').waitFor();
      await dialog.getByText('Original configuration pending', { exact: false }).waitFor();
      const total = posts; await open(); await dialog.getByRole('alert').waitFor();
      await dialog.getByText('Original configuration pending', { exact: false }).waitFor();
      assert.equal(posts, total); assert.equal(await dialog.locator('fieldset').evaluate(el => el.disabled), true, '404 is not proof of nonexecution');
      assert.equal(await dialog.getByRole('button', { name: 'Save disabled rule', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required'))); await page.waitForFunction(() => !document.querySelector('dialog'));
      assert.deepEqual(errors, []); console.log(`PASS automation ${width}: SQLite CAS, disabled default, lost ACK recovery, pause, unknown/404 no replay, auth close`);
    } finally { await context.close(); db.close(); }
  }
} finally { await browser?.close(); await server.close(); }
