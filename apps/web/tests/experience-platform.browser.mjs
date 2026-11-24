// Real components, isolated loopback fixture. No credentials, production data or remote calls.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'experience-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__experience')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/experience-platform.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [], external = [];
    let preferences = { revision: 0, groups: [], sessions: {} }, rejectSave = false;
    await context.route('**/*', route => {
      if (new URL(route.request().url()).pathname === '/api/hub/v1/workspace/preferences') {
        if (route.request().method() === 'PUT') {
          const next = route.request().postDataJSON();
          if (rejectSave || next.revision !== preferences.revision) return route.fulfill({ status: 409, json: { error: 'Synthetic revision conflict' } });
          preferences = { ...next, revision: preferences.revision + 1 };
        }
        return route.fulfill({ json: preferences });
      }
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__experience`);
    await page.getByRole('heading', { name: 'Safe report' }).waitFor();
    assert.equal(await page.getByRole('table').count(), 1);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
    await page.getByRole('button', { name: 'Raw', exact: true }).click();
    assert.match(await page.locator('.markdown-file-raw').innerText(), /\*\*Rich text\*\*/);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();

    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    const identity = await input.elementHandle();
    await input.fill('x'.repeat(3999));
    await input.press('End');
    await input.pressSequentially('1234');
    assert.equal(await identity.evaluate(node => node === document.activeElement), true, 'crossing threshold retains focused textarea');
    assert.equal((await input.inputValue()).length, 4003);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    assert.equal(await identity.evaluate(node => node === document.querySelector('textarea')), true, 'language switch retains textarea identity');
    assert.equal((await input.inputValue()).length, 4003);
    await page.getByRole('button', { name: '源码', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');

    await page.getByRole('button', { name: 'Load 100k', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea').value.length === 100000);
    const composer = page.getByRole('region', { name: 'Composer', exact: true });
    await composer.getByRole('button', { name: /Collapse/ }).click();
    await composer.getByRole('button', { name: /View \/ edit/ }).click();
    assert.equal((await input.inputValue()).length, 100000);
    assert.equal(await identity.evaluate(node => node === document.activeElement), true);
    await composer.getByRole('button', { name: /Collapse/ }).click();
    assert.equal(await input.isVisible(), false, 'collapse works despite textarea blur');
    await composer.getByRole('button', { name: /View \/ edit/ }).click();
    assert.equal((await input.inputValue()).length, 100000, 'reference is not a truncated payload');
    const readonly = page.getByRole('region', { name: 'Read-only reference' });
    assert.equal(await readonly.locator('pre').count(), 0, 'collapsed output avoids mounting huge markup');
    await readonly.getByRole('button').click();
    assert.equal((await readonly.locator('pre').innerText()).length, 7000);
    await readonly.getByRole('button').click();

    const rename = page.getByRole('button', { name: 'Rename session', exact: true });
    await rename.click();
    const dialog = page.getByRole('dialog', { name: 'Rename session' });
    await dialog.getByRole('textbox').fill('fail');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByRole('textbox').inputValue(), 'fail', 'failed save retains draft');
    await dialog.getByRole('textbox').fill('My new session');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('Session name').innerText(), 'My new session');
    await rename.click();
    await dialog.getByRole('textbox').fill('Discard me');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('Session name').innerText(), 'My new session');
    assert.equal(await rename.evaluate(node => node === document.activeElement), true, 'dialog returns focus');
    assert.equal(await page.locator('[data-latest-messages-loading]').count(), 1);
    await page.getByRole('button', { name: 'Toggle loading' }).click();
    assert.equal(await page.locator('[data-latest-messages-loading]').count(), 0);
    const organization = page.getByRole('region', { name: 'Organization', exact: true });
    const snapshot = async () => JSON.parse(await organization.getByLabel('Preferences snapshot').innerText());
    const group = name => organization.getByRole('region', { name, exact: true });
    await organization.getByRole('button', { name: 'New group', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: 'New group', exact: true });
    await groupDialog.getByRole('textbox').fill('Work');
    await groupDialog.getByRole('button', { name: 'Save changes' }).click();
    await groupDialog.waitFor({ state: 'hidden' });
    const workId = (await snapshot()).groups[0].id;
    await organization.getByLabel('Move to group').selectOption(workId);
    await group('Work').getByRole('button', { name: 'alpha', exact: true }).waitFor();
    await organization.getByLabel('Session tags', { exact: true }).fill('frontend, 发布');
    await organization.getByRole('button', { name: 'Save tags', exact: true }).click();
    await organization.getByLabel('Filter by tag', { exact: true }).selectOption('发布');
    assert.equal(await organization.locator('[data-session="alpha"]').count(), 1);
    assert.equal(await organization.locator('[data-session="beta"]').count(), 0);
    await organization.getByLabel('Filter by tag', { exact: true }).selectOption('');
    await organization.getByLabel('Session tags', { exact: true }).fill('duplicate, duplicate');
    assert.equal(await organization.getByRole('button', { name: 'Save tags', exact: true }).isDisabled(), true);
    await organization.getByLabel('Session tags', { exact: true }).fill('frontend, 发布');
    const drag = await page.evaluateHandle(() => new DataTransfer());
    await organization.locator('[data-session="beta"]').locator('..').dispatchEvent('dragstart', { dataTransfer: drag });
    await group('Work').dispatchEvent('dragover', { dataTransfer: drag });
    assert.match(await group('Work').getAttribute('class'), /session-workspace-group--drop/);
    await group('Work').dispatchEvent('drop', { dataTransfer: drag });
    await group('Work').getByRole('button', { name: 'beta', exact: true }).waitFor();
    assert.equal((await snapshot()).sessions.beta.groupId, workId);
    assert.doesNotMatch(await group('Work').getAttribute('class'), /session-workspace-group--drop/);
    await group('Work').locator('[data-session="beta"]').locator('..').dispatchEvent('dragstart', { dataTransfer: drag });
    const alphaRow = group('Work').locator('[data-session="alpha"]').locator('..');
    await alphaRow.dispatchEvent('dragover', { dataTransfer: drag });
    await alphaRow.dispatchEvent('drop', { dataTransfer: drag });
    await page.waitForFunction(() => {
      const section = document.querySelector('[aria-label="Work"]');
      return section?.querySelector('[data-session]')?.getAttribute('data-session') === 'beta';
    });
    await page.reload();
    await group('Work').getByRole('button', { name: 'beta', exact: true }).waitFor();
    assert.deepEqual(await group('Work').locator('[data-session]').evaluateAll(nodes => nodes.map(node => node.dataset.session)), ['beta', 'alpha']);
    await organization.getByRole('button', { name: 'Session color #dc2626', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-session="alpha"]').style.color === 'rgb(220, 38, 38)');
    await organization.getByLabel('Custom color', { exact: true }).fill('#112233');
    await page.waitForFunction(() => document.querySelector('[data-session="alpha"]').style.color === 'rgb(17, 34, 51)');
    await organization.getByRole('button', { name: 'Flat view' }).click();
    assert.equal(await organization.locator('[data-session]').count(), 3, 'flat view contains every environment');
    await organization.getByRole('button', { name: 'Show groups' }).click();
    rejectSave = true;
    await organization.getByRole('button', { name: 'Session color #2563eb', exact: true }).click();
    await organization.getByRole('alert').first().waitFor();
    assert.equal((await snapshot()).sessions.alpha.color, '#112233', 'failed preference save never presents optimistic success');
    rejectSave = false;
    await organization.getByRole('button', { name: 'Reload preferences' }).first().click();
    await organization.getByRole('alert').first().waitFor({ state: 'hidden' });
    await group('Work').getByLabel('Group actions').click();
    await page.getByRole('menuitem', { name: 'Remove group', exact: true }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remove group?', exact: true });
    await removeDialog.getByRole('button', { name: 'Remove group', exact: true }).click();
    await group('Work').waitFor({ state: 'hidden' });
    assert.equal(await organization.locator('[data-session]').count(), 3, 'removing group preserves sessions');
    assert.equal((await snapshot()).sessions.alpha.color, '#112233', 'removing group preserves color');
    assert.deepEqual((await snapshot()).sessions.alpha.tags, ['frontend', '发布'], 'removing group preserves tags without granting access');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no viewport overflow');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.reload();
    await page.getByRole('button', { name: '源码', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN', 'language persists');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'preview must not silently fetch remote content');
    console.log(`PASS experience components ${viewport.width}x${viewport.height}`);
    await context.close();
  }
  // Use the production worker and settings component. Browser registration and
  // stored notifications are observable; an OS banner is not a headless claim.
  const context = await browser.newContext({ locale: 'en-US', permissions: ['notifications'], serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ json: pathname.endsWith('/workspace/preferences') ? { revision: 0, groups: [], sessions: {} } : { passkeys: [] } });
  });
  await page.goto(`${origin}/__experience`);
  await page.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Browser and sign-in settings' });
  await settings.getByRole('button', { name: /Send test notification|Enable notifications/ }).click();
  await settings.getByRole('status').filter({ hasText: 'Browser accepted the notification.' }).waitFor();
  const delivered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications();
    const result = notifications.map(notification => ({ title: notification.title, body: notification.body }));
    notifications.forEach(notification => notification.close());
    return result;
  });
  assert.deepEqual(delivered, [{ title: 'AgentOpsDeck notification test', body: 'Test notification · run results will appear here.' }]);
  assert.deepEqual(errors, []);
  console.log('PASS settings notification delivery through production service worker (OS banner not asserted)');
  await context.close();
} finally { await browser?.close(); await server.close(); }
