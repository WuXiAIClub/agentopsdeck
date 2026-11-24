// Real React sync dialog, isolated transport. No sessions started or production writes.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const scope = 'a'.repeat(64);
const resources = ['default', '["taskboard","default"]', '["statuscard","default"]'];
const bindingId = '12345678-1234-1234-1234-123456789abc';
const pendingKey = i => JSON.stringify([i ? 'agentopsdeck.file-card-intent' : 'agentopsdeck.file-board-intent', scope, resources[i]]);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'sync-fixture', configureServer(instance) { instance.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__sync') return next();
    res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/board-sync-dialog.fixture.tsx"></script></body></html>'));
  }); } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [320, 1440]) for (const mode of ['new', 'board', 'card', 'status', 'pending', 'multiple', 'failed-read', 'corrupt', 'empty-corrupt', 'card-only', 'unlink', 'cancel']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = [], bindings = new Map();
    if (['board','card','status'].includes(mode)) {
      const i = ['board','card','status'].indexOf(mode);
      bindings.set(resources[i], { bindingId, resourceId: resources[i], sessionId: 'local:session', state: 'active', problem: null });
    }
    if (mode === 'unlink') bindings.set(resources[0], { bindingId, resourceId: resources[0], sessionId: 'local:session', state: 'active', problem: null });
    const pending = { requestId: bindingId, sessionId: 'local:session', revision: 7 };
    await context.addInitScript(({ mode, keys, pending }) => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      if (mode === 'pending' || mode === 'multiple' || mode === 'cancel') sessionStorage.setItem(keys[1], JSON.stringify(pending));
      if (mode === 'multiple') sessionStorage.setItem(keys[0], JSON.stringify({ ...pending, requestId: '12345678-1234-1234-1234-123456789abd' }));
      if (mode === 'corrupt') sessionStorage.setItem(keys[0], '{invalid');
      if (mode === 'empty-corrupt') sessionStorage.setItem(keys[0], '');
    }, { mode, keys: resources.map((_, i) => pendingKey(i)), pending });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = decodeURIComponent(url.pathname);
      if (path.endsWith('/sessions/state')) return route.fulfill({ json: { revision: '1', groups: [{ sessions: [{ sessionKey: 'local:session', title: 'Session title', sessionRef: { runtimeId: 'codex' } }] }] } });
      if (path.endsWith('/boards/default')) return route.fulfill({ json: { resourceId: 'default', title: 'Plan', revision: 7, tasks: [], updatedAt: 1 } });
      if (request.method() === 'DELETE' || path.endsWith('/cancel')) {
        writes.push({ action: request.method() });
        bindings.clear();
        return route.fulfill({ json: { binding: { bindingId, resourceId: resources[0], sessionId: 'local:session', state: 'revoked', problem: null }, cancelled: true, cleanup: 'pending' } });
      }
      const match = path.match(/\/(boards|file-cards)\/(.+)\/file-binding$/);
      if (!match) { errors.push(`unexpected ${request.method()} ${path}`); return route.fulfill({ status: 404, json: {} }); }
      const resource = match[2];
      if (request.method() === 'GET') {
        if (mode === 'failed-read' && resource === resources[2]) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { enabled: mode !== 'card-only' || match[1] === 'file-cards', binding: bindings.get(resource) ?? null } });
      }
      writes.push({ resource, body: request.postDataJSON() });
      const body = request.postDataJSON();
      bindings.set(resource, { bindingId: body.requestId, resourceId: resource, sessionId: body.sessionId, state: 'active', problem: null });
      // Lose the response: reopening must inspect and reuse the persisted identity.
      return route.abort('failed');
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__sync`);
    await page.getByRole('button', { name: 'Open sync' }).click();
    const dialog = page.getByRole('dialog', { name: 'Card file sync', exact: true });
    await dialog.waitFor();
    if (mode === 'failed-read' || mode === 'corrupt' || mode === 'empty-corrupt') {
      await dialog.getByRole('alert').waitFor();
      assert.equal(await dialog.getByRole('combobox').count(), 0, 'unknown link state fails closed');
    } else if (mode === 'multiple') {
      await dialog.getByRole('group', { name: 'Existing sync requests' }).waitFor();
      assert.equal(await dialog.getByRole('combobox').count(), 0, 'ambiguous pending intents need explicit choice');
      await dialog.getByRole('button', { name: /2 · card.json/ }).click();
      await dialog.getByRole('button', { name: 'Retry same binding', exact: true }).waitFor();
    } else if (mode === 'unlink' || mode === 'cancel') {
      if (mode === 'unlink') {
        await dialog.getByRole('button', { name: 'Unlink board', exact: true }).click();
        await dialog.getByRole('button', { name: 'Confirm unlink', exact: true }).click();
      } else await dialog.getByRole('button', { name: 'Cancel pending binding', exact: true }).click();
      await dialog.getByText('Local import stopped. Remote cleanup is pending; the file was not deleted.', { exact: true }).waitFor();
      assert.equal(writes.length, 1, 'only the explicit unlink/cancel is sent');
    } else if (['board', 'card', 'status'].includes(mode)) {
      await dialog.getByText('Session title', { exact: true }).waitFor();
      assert.match(await dialog.locator('code').innerText(), new RegExp(mode === 'board' ? '/tasks.json$' : '/card.json$'));
    } else {
      const select = dialog.getByRole('combobox', { name: 'Session', exact: true });
      await select.waitFor();
      assert.equal(await select.isDisabled(), mode === 'pending');
      if (mode === 'pending') assert.equal(await select.inputValue(), pending.sessionId);
      else await select.selectOption('local:session');
      const button = dialog.getByRole('button', { name: mode === 'pending' ? 'Retry same binding' : mode === 'card-only' ? 'Link card to session' : 'Link whole board', exact: true });
      await button.click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(writes.length, 1);
      assert.equal(writes[0].resource, mode === 'new' ? resources[0] : resources[1]);
      if (mode === 'pending') assert.deepEqual(writes[0].body, pending, 'retry retains the original request and revision');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Open sync' }).click();
      await dialog.getByText('Session title', { exact: true }).waitFor();
      assert.equal(writes.length, 1, 'reopening only inspects the original successful binding');
    }
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).count(), 1, 'single header and close control');
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth), false);
    if (!['new', 'pending', 'card-only', 'unlink', 'cancel'].includes(mode)) assert.deepEqual(writes, [], 'inspection never mutates');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Open sync' }).evaluate(node => node === document.activeElement), true);
    assert.deepEqual(errors, []);
    console.log(`board sync ${width}px ${mode}: passed`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
