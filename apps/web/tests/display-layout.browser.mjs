// Built real SavedLayouts + hook, isolated APIs and simulated display capabilities.
// No OS display permission, production layouts, Agent messages or remote calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-display-layout-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/display-layout.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  const errors = [], forbidden = [];
  async function device(mode = 'detailed') {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(mode => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      let current = { width: 1440, height: 900, label: 'Laptop', left: 0, top: 0, isInternal: true };
      if (sessionStorage.getItem('test-start-display') === 'b') current = { width: 2560, height: 1440, label: 'External', left: 1440, top: 0, isInternal: false };
      for (const name of ['width', 'height']) Object.defineProperty(screen, name, { configurable: true, get: () => current[name] });
      const details = new EventTarget(); Object.defineProperty(details, 'currentScreen', { get: () => current });
      const permission = new EventTarget(); permission.state = 'prompt';
      window.__permissionCalls = 0;
      let deferred;
      window.__finishPermission = () => deferred?.();
      navigator.permissions.query = async () => permission;
      window.getScreenDetails = mode === 'unsupported' ? undefined : async () => {
        window.__permissionCalls++; if (mode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
        if (mode === 'deferred') await new Promise(resolve => { deferred = resolve; });
        if (permission.state === 'denied') return details; // Deliberately stale successful response.
        permission.state = 'granted'; return details;
      };
      window.__move = (name, event = true) => {
        current = name === 'a' ? { width: 1440, height: 900, label: 'Laptop', left: 0, top: 0, isInternal: true }
          : name === 'b' ? { width: 2560, height: 1440, label: 'External', left: 1440, top: 0, isInternal: false }
          : { width: 1920, height: 1080, label: 'Unbound', left: -1920, top: 0, isInternal: false };
        if (event) details.dispatchEvent(new Event('currentscreenchange'));
      };
      window.__revoke = () => { permission.state = 'denied'; permission.dispatchEvent(new Event('change')); };
    }, mode);
    let reads = 0;
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.endsWith('/workspace/layouts/saved')) {
        if (req.method() === 'GET') { reads++; return route.fulfill({ json: { revision: 0, content: null } }); }
        const body = req.postDataJSON(); assert.ok(!body.content.includes('display'), 'display details never synced');
        return route.fulfill({ json: { revision: 1, content: body.content } });
      }
      forbidden.push(url.pathname); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/tests/fixtures/display-layout.html');
    await page.getByLabel('Layout synced to your account', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => window.__permissionCalls), 0, 'no startup permission prompt');
    const current = () => page.getByTestId('restored').textContent();
    const move = async (name, event = true) => { await page.evaluate(([n, e]) => window.__move(n, e), [name, event]); await page.waitForTimeout(event && mode === 'detailed' ? 600 : 2600); };
    const manual = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    const bind = async name => { await page.getByLabel('Saved layouts', { exact: true }).click(); await page.getByRole('button', { name: `Bind to current display · ${name}`, exact: true }).click(); await page.getByRole('button', { name: `Remove display binding · ${name}`, exact: true }).waitFor(); await page.getByLabel('Saved layouts', { exact: true }).click(); };
    return { page, context, current, move, manual, bind, reads: () => reads };
  }
  const d = await device(); const { page } = d;
  await d.bind('Laptop'); await d.move('b'); await d.bind('External');
  assert.equal(await d.current(), 'a', 'binding itself does not restore');
  await d.move('a'); await d.move('b'); assert.equal(await d.current(), 'b');
  await d.manual('Laptop'); await page.setViewportSize({ width: 1000, height: 700 }); await page.waitForTimeout(700);
  assert.equal(await d.current(), 'a', 'manual override survives resize and probes');
  await d.move('a'); await page.getByRole('textbox').focus(); await d.move('b');
  assert.equal(await d.current(), 'a', 'typing is not interrupted'); assert.equal(await page.getByRole('textbox').inputValue(), 'Keep this draft');
  await page.getByRole('textbox').blur(); await d.move('a'); await page.getByRole('button', { name: 'Dirty layout', exact: true }).click(); await d.move('b');
  assert.equal(await d.current(), 'a', 'unsaved layout is not replaced');
  await d.manual('Laptop'); await d.move('a'); await page.getByRole('button', { name: 'File draft guard', exact: true }).click(); await d.move('b');
  assert.equal(await d.current(), 'a', 'restore rejection does not update association');
  await page.getByRole('button', { name: 'File draft guard', exact: true }).click(); await d.move('a'); await d.move('b'); assert.equal(await d.current(), 'b');
  await page.getByLabel('Saved layouts', { exact: true }).click(); await page.getByLabel('Switch layout with display', { exact: true }).uncheck(); await page.getByLabel('Saved layouts', { exact: true }).click(); await d.move('a'); assert.equal(await d.current(), 'b');
  await page.getByLabel('Saved layouts', { exact: true }).click(); await page.getByLabel('Switch layout with display', { exact: true }).check(); await page.getByLabel('Saved layouts', { exact: true }).click(); await page.waitForTimeout(700); assert.equal(await d.current(), 'a');
  await page.evaluate(() => window.__revoke()); await d.move('b'); assert.equal(await d.current(), 'a', 'lost permission never weakens precise identity');
  assert.equal(d.reads(), 1, 'screen movement never polls Hub');
  await page.getByRole('button', { name: 'Change account', exact: true }).click(); await page.waitForTimeout(500); assert.equal(await page.getByLabel('Display-bound layout', { exact: true }).count(), 0, 'binding UI fenced by account');
  await d.context.close();
  for (const abandon of ['revoke', 'account']) {
    const late = await device('deferred'), p = late.page;
    await p.getByLabel('Saved layouts', { exact: true }).click();
    await p.getByRole('button', { name: 'Bind to current display · Laptop', exact: true }).click();
    await p.getByRole('button', { name: 'Bind to current display · Laptop', exact: true }).click();
    assert.equal(await p.evaluate(() => window.__permissionCalls), 1, 'concurrent explicit requests share one permission prompt');
    if (abandon === 'revoke') await p.evaluate(() => window.__revoke());
    else { await p.getByLabel('Saved layouts', { exact: true }).click(); await p.getByRole('button', { name: 'Change account', exact: true }).click(); }
    await p.evaluate(() => window.__finishPermission()); await p.waitForTimeout(700);
    assert.equal(await p.getByLabel('Display-bound layout', { exact: true }).count(), 0, `${abandon} fences a late permission result`);
    assert.equal(await p.getByText('Display bindings stay in this browser and account.', { exact: true }).count(), 0);
    await late.context.close();
  }
  for (const mode of ['unsupported', 'denied']) {
    const fallback = await device(mode); await fallback.bind('Laptop'); await fallback.move('b', false); await fallback.bind('External');
    await fallback.move('a', false); await fallback.move('b', false); assert.equal(await fallback.current(), 'b', `${mode} local dimension probe`);
    await fallback.page.evaluate(() => sessionStorage.setItem('test-start-display', 'b'));
    await fallback.page.reload(); await fallback.page.getByRole('navigation').waitFor();
    await fallback.page.waitForFunction(() => document.querySelector('[data-testid="restored"]')?.textContent === 'b');
    assert.equal(await fallback.page.getByLabel('Display-bound layout', { exact: true }).count(), 2, 'bindings survive refresh');
    await fallback.page.setViewportSize({ width: 390, height: 844 });
    await fallback.page.getByLabel('Saved layouts', { exact: true }).click();
    const menuBounds = await fallback.page.locator('.saved-layouts-menu').boundingBox();
    assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390, 'display settings fit mobile width');
    await fallback.context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log('PASS display layouts: explicit permission, two screens, manual override, resize stability, edit/restore guards, disable, revoke, fallback, reload, account fencing and no Hub polling');
} finally { await browser?.close(); await new Promise(resolve => server?.httpServer ? server.httpServer.close(resolve) : resolve()); await rm(output, { recursive: true, force: true }); }
