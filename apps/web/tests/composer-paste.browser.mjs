// Real app with isolated API/clipboard fixtures; never sends a live message.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const builtRoot = process.env.AOD_TEST_WEB_ROOT;
const server = builtRoot
  ? await preview({ root: builtRoot, configFile: false, build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  if (!builtRoot) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const sessions = ['one', 'two'].map(id => ({ sessionKey: `remote:${id}`, title: `Paste ${id}`, source: 'codex', agentId: 'codex', status: 'idle', lastActiveAt: 1 }));
    const errors = [], mutations = [], sent = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') {
        mutations.push(url.pathname);
        if (url.pathname.endsWith('/messages')) sent.push({ path: url.pathname, body: request.postDataJSON() });
        return route.fulfill({ status: 403, json: { error: 'No fixture writes' } });
      }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions }], revision: '1' });
      if (url.pathname.endsWith('/messages')) return json({ messages: [], totalCount: 0, hiddenCount: 0 });
      if (url.pathname.endsWith('/queue')) return json({ items: [] });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; close() { this.readyState = 2; } };
      // Hold reads to verify immediate default cancellation and send fencing.
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) { setTimeout(() => read.call(this, file), 500); };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('[data-session-card="remote:one"]').click();
    if (width > 600) await page.locator('[data-session-card="remote:two"]').click();
    const first = width > 600 ? page.locator('[data-session-pane="remote:one"]') : page.locator('.mobile-chat-composer');
    const input = width > 600 ? first.locator('.desktop-composer-textarea') : page.locator('.mobile-composer-textarea');
    await input.evaluate(el => { const pane = el.closest('[data-workspace-pane]'); if (pane) pane.dataset.hoverComposer = 'true'; el.focus(); });
    const paste = (locator, count = 1, image = true) => locator.evaluate((el, { count, image }) => {
      const data = new DataTransfer(); data.setData('text/plain', 'clipboard companion text');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
      if (image) for (let i = 0; i < count; i++) data.items.add(new File([bytes], `shot-${i}.png`, { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      el.dispatchEvent(event); return event.defaultPrevented;
    }, { count, image });
    await input.fill('text must wait for image');
    assert.equal(await paste(input), true, 'image paste must cancel default synchronously, before FileReader completes');
    assert.equal(await first.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true, 'send is fenced during conversion');
    await input.press('Enter');
    assert.ok(!mutations.some(path => path.endsWith('/messages') || path.endsWith('/commands')), 'Enter cannot outrun image conversion');
    await page.waitForFunction(selector => document.querySelector(selector)?.querySelectorAll('[aria-label="Pending attachments"] img').length === 1,
      width > 600 ? '[data-session-pane="remote:one"]' : '.mobile-chat-composer');
    assert.equal(await input.inputValue(), 'text must wait for image');
    await input.fill('');
    if (width > 600) {
      const second = page.locator('[data-session-pane="remote:two"]');
      assert.equal(await second.getByLabel('Pending attachments').count(), 0, 'no cross-session attachment');
      await second.locator('.desktop-composer-textarea').evaluate(el => { el.closest('[data-workspace-pane]').dataset.hoverComposer = 'true'; el.focus(); });
      await paste(second.locator('.desktop-composer-textarea'));
      await second.getByLabel('Pending attachments').locator('img').waitFor({ state: 'attached' });
      assert.equal(await first.getByLabel('Pending attachments').locator('img').count(), 1, 'second composer preserves first draft');
    }
    await input.evaluate(el => { const pane = el.closest('[data-workspace-pane]'); if (pane) pane.dataset.hoverComposer = 'true'; el.focus(); });
    assert.equal(await paste(input, 0, false), false, 'ordinary text paste remains native');
    await paste(input, 8);
    await page.getByText('Max 8 attachments per message.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Pending attachments').locator('img').count(), width > 600 ? 2 : 1, 'limit failure keeps existing drafts');
    if (width > 600) {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      });
      await page.locator('[data-session-card="remote:one"]').click();
      await input.evaluate(el => {
        document.activeElement?.blur();
        const pane = el.closest('[data-workspace-pane]'); delete pane.dataset.hoverComposer; pane.dataset.composerReading = 'true';
      });
      await page.keyboard.press('Control+v');
      assert.equal(await input.evaluate(el => document.activeElement === el), true, 'native Ctrl+V reveals and focuses active composer');
      await page.waitForFunction(() => document.querySelector('[data-session-pane="remote:one"]')?.querySelectorAll('[aria-label="Pending attachments"] img').length === 2);
      for (const kind of ['search', 'notebook', 'dialog']) {
        await page.evaluate(kind => {
          document.activeElement?.blur();
          const el = document.createElement(kind === 'search' ? 'input' : 'div'); el.id = 'paste-focus-guard';
          if (kind === 'search') el.type = 'search';
          if (kind === 'notebook') { el.contentEditable = 'true'; el.className = 'notebook-rich-content'; }
          if (kind === 'dialog') { el.setAttribute('aria-modal', 'true'); el.style.cssText = 'position:fixed;inset:20px;background:white'; }
          document.body.append(el); if (kind !== 'dialog') el.focus();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
        }, kind);
        assert.equal(await input.evaluate(el => document.activeElement === el), false, `${kind} must not lose focus to composer`);
        await page.locator('#paste-focus-guard').evaluate(el => el.remove());
      }
    }
    assert.deepEqual(errors, []);
    await input.evaluate(el => { const pane = el.closest('[data-workspace-pane]'); if (pane) pane.dataset.hoverComposer = 'true'; el.focus(); });
    const beforeRapid = await first.getByLabel('Pending attachments').locator('img').count();
    await paste(input); await paste(input);
    await page.waitForFunction(({ selector, count }) => document.querySelector(selector)?.querySelectorAll('[aria-label="Pending attachments"] img').length === count,
      { selector: width > 600 ? '[data-session-pane="remote:one"]' : '.mobile-chat-composer', count: beforeRapid + 2 });
    assert.equal(await first.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true, 'send enabled after all images ready');
    assert.ok(!mutations.some(path => path.endsWith('/messages') || path.endsWith('/commands')), 'paste never sends');
    await input.fill('with screenshot');
    await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/messages')),
      input.press('Enter'),
    ]);
    assert.equal(sent.length, 1); assert.equal(sent[0].body.message, 'with screenshot');
    assert.equal(decodeURIComponent(sent[0].path).includes('/sessions/remote:one/messages'), true);
    assert.equal(sent[0].body.media.length, beforeRapid + 2, 'every ready image is included in the outgoing request');
    assert.ok(sent[0].body.media.every(image => image.type === 'image' && image.dataUrl.startsWith('data:image/png;base64,')));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, synchronousCancellation: true, independentDrafts: true, limitSafe: true, preparationFence: true, sendPayload: true, nativeClipboardAndFocusGuards: width > 600 }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
