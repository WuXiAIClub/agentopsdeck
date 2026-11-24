import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { assertPreviewContrast } from './preview-contrast.mjs';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const builtRoot = process.env.AOD_TEST_WEB_ROOT;
const server = builtRoot
  ? await preview({ root: builtRoot, configFile: false, envFile: false, build: { outDir: builtRoot }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  if (!builtRoot) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const errors = [], denied = [], requests = [];
    const sessionKey = 'remote:source-session', path = '/project/connector-token.ts', href = `${path}:118`;
    let url = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}/messages/source-message/media/${'a'.repeat(64)}`;
    let status = 200, revision = 1;
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.origin === origin && request.method() === 'POST' && target.pathname === '/api/hub/v1/completions/summary')
        return route.fulfill({ json: { items: [] } });
      if (target.origin !== origin || request.method() !== 'GET') { denied.push(target.href); return route.abort(); }
      if (!target.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (target.pathname === url) { requests.push(target.pathname); return route.fulfill({ status, json: status === 200
        ? { path, line: 118, startLine: 106, totalLines: 200, modifiedAt: 1,
          text: Array.from({ length: 45 }, (_, i) => i === 12 ? 'const target = "<script>not HTML</script>";' : `const line${i + 106} = ${i};`).join('\n') }
        : { error: 'synthetic denial' } }); }
      if (target.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (target.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions: [{ sessionKey, title: 'Source preview test', agentId: 'codex', source: 'codex', status: 'idle', lastActiveAt: 1 }] }], revision: '1' });
      if (target.pathname.endsWith('/messages')) return json({ messages: [{ id: 'source-message', sessionKey, role: 'assistant', createdAt: 1,
        text: `[Source code](${href}) and [Unavailable](/other/unavailable.py:4) and [Website](https://example.invalid/docs).\n\nMessage revision ${revision}`,
        media: [{ type: 'file', name: 'connector-token.ts', url, sourceReference: { href, path, line: 118 } }] }], totalCount: 1, hiddenCount: 0, revision: String(revision) });
      if (target.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (target.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (target.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await context.addInitScript(() => {
      const streams = [];
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      window.previewEvent = event => { for (const stream of streams) if (stream.readyState === 1)
        stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id })); };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.locator(`[data-session-card="${sessionKey}"]`).click();
    const card = page.getByRole('region', { name: `Source preview ${path}:118`, exact: true });
    await card.waitFor();
    assert.equal(await page.getByRole('link', { name: 'Website' }).getAttribute('href'), 'https://example.invalid/docs');
    const currentUrl = page.url();
    await page.locator('[data-source-target]').waitFor();
    assert.equal(await page.locator('[data-source-target] .source-inline-number').innerText(), '118');
    assert.ok((await card.innerText()).includes('<script>not HTML</script>'));
    assert.equal(await card.locator('script').count(), 0);
    // Hovering the session selector may open the independent session peek.
    // Source rendering must not open a modal or a source-specific dialog.
    assert.equal(await page.locator('[role="dialog"]:not(.session-peek)').count(), 0, 'code appears without a click or modal');
    assert.equal(await card.getByRole('dialog').count(), 0);
    assert.equal(await card.locator('.source-inline-line').count(), 7);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await assertPreviewContrast(card.locator('.source-inline-name, .source-inline-path, .source-inline-readonly, .source-inline-number, .source-inline-line, .source-inline-footer, button'));
    }
    await card.getByRole('button', { name: 'Expand', exact: true }).click();
    assert.equal(await card.locator('.source-inline-line').count(), 45);
    await card.evaluate(el => { window.originalPreviewCard = el; });
    revision++;
    await page.evaluate(({ sessionKey, revision }) => window.previewEvent({ id: `preview-${revision}`,
      type: 'message.updated', sessionKey, ts: revision, payload: {} }), { sessionKey, revision });
    await page.getByText(`Message revision ${revision}`, { exact: true }).waitFor();
    assert.equal(await card.evaluate(el => el === window.originalPreviewCard), true, 'message refresh preserves preview DOM');
    assert.equal(await card.locator('.source-inline-line').count(), 45, 'expanded state survives refreshed media objects');
    assert.equal(requests.length, 1, 'message updates must not reread source');
    const changeLanguage = language => page.evaluate(value => {
      localStorage.setItem('agentopsdeck.locale', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'agentopsdeck.locale', newValue: value }));
    }, language);
    await changeLanguage('zh-CN');
    const chineseCard = page.getByRole('region', { name: `源码预览 ${path}:118`, exact: true });
    await chineseCard.getByRole('button', { name: '刷新源码', exact: true }).waitFor();
    assert.equal(await chineseCard.evaluate(el => el === window.originalPreviewCard), true, 'language switch preserves preview DOM');
    assert.equal(await chineseCard.locator('.source-inline-line').count(), 45, 'language switch preserves expansion');
    await chineseCard.getByRole('button', { name: '收起', exact: true }).waitFor();
    assert.equal(requests.length, 1, 'language switch must not reread source');
    await changeLanguage('en');
    await card.getByRole('button', { name: 'Refresh source', exact: true }).waitFor();
    await card.getByRole('button', { name: 'Collapse', exact: true }).click();
    await card.getByRole('button', { name: 'Hide preview', exact: true }).click();
    assert.equal(await card.locator('.source-inline-line').count(), 0, 'hidden preview occupies only its header');
    await card.getByRole('button', { name: 'Show preview', exact: true }).click();
    await card.locator('[data-source-target]').waitFor();
    assert.equal(requests.length, 1, 'reopening preview reuses cached source');
    await page.reload();
    if (viewport.width < 600) await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await card.locator('[data-source-target]').waitFor();
    assert.equal(requests.length, 1, 'page reload uses the tab cache');
    assert.equal(page.url(), currentUrl); assert.equal(context.pages().length, 1);
    assert.equal(await card.evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/source-preview-${viewport.width}.png` });
    status = 403; await card.getByRole('button', { name: 'Refresh source' }).click();
    const unavailable = page.getByRole('region', { name: `File reference ${path}:118`, exact: true });
    await unavailable.getByRole('status').getByText('Preview unavailable', { exact: true }).waitFor();
    assert.equal(await card.count(), 0, 'failed refresh removes old source card');
    assert.equal(await unavailable.locator('[data-source-target]').count(), 0, 'failed refresh removes old source');
    assert.equal(await unavailable.locator('.source-reference-details').count(), 0, 'error details stay collapsed');
    assert.ok(!(await unavailable.innerText()).includes('cached preview'), 'failed preview is not labelled cached');
    await unavailable.getByRole('button', { name: 'Details', exact: true }).click();
    await unavailable.getByText(/You no longer have permission to preview this source\./).waitFor();
    status = 200; await unavailable.getByRole('button', { name: 'Retry', exact: true }).click(); await card.locator('[data-source-target]').waitFor();
    const missing = page.getByRole('region', { name: 'File reference /other/unavailable.py:4', exact: true });
    await missing.getByRole('button', { name: 'Details', exact: true }).click();
    await missing.getByText(/Preview unavailable · refresh the conversation/).waitFor(); assert.equal(page.url(), currentUrl);
    assert.equal(requests.length, 3); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    if (viewport.width > 600) {
      const pane = page.locator('[data-workspace-pane]').first();
      await pane.evaluate(el => { el.style.width = '420px'; });
      const trigger = pane.getByRole('button', { name: `Source preview ${path}:118`, exact: true });
      await trigger.waitFor();
      await page.mouse.move(2, 2);
      await card.waitFor({ state: 'detached' });
      // A fresh source identity must stay unread until the user asks for it.
      url = url.replace('a'.repeat(64), 'b'.repeat(64)); revision++;
      await page.evaluate(({ sessionKey, revision }) => window.previewEvent({ id: `preview-${revision}`,
        type: 'message.updated', sessionKey, ts: revision, payload: {} }), { sessionKey, revision });
      await page.getByText(`Message revision ${revision}`, { exact: true }).waitFor();
      assert.equal(requests.length, 3, 'narrow cards do not fetch collapsed source');
      const beforeHeight = await pane.locator('.message-selection-surface').evaluate(el => el.scrollHeight);
      await trigger.hover(); await card.locator('[data-source-target]').waitFor();
      assert.equal(requests.length, 4);
      const popup = page.locator('.source-hover-popup');
      assert.equal(await popup.evaluate(el => el.matches(':popover-open')), true);
      assert.equal(await pane.locator('.message-selection-surface').evaluate(el => el.scrollHeight), beforeHeight, 'floating preview must not reflow chat');
      const bounds = await popup.boundingBox();
      assert.ok(bounds.width > 420 && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      if (process.env.AOD_TEST_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_PREVIEW_SCREENSHOT });
      await card.getByRole('button', { name: 'Copy', exact: true }).hover();
      await page.waitForTimeout(300);
      assert.equal(await popup.isVisible(), true, 'moving into the popup keeps it open');
      await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' });
      await trigger.focus(); await card.locator('[data-source-target]').waitFor();
      assert.equal(requests.length, 4, 'keyboard reopening reuses cache');
      await popup.getByRole('button', { name: 'Close', exact: true }).click(); await popup.waitFor({ state: 'detached' });
      await trigger.click();
      const focused = page.getByRole('dialog', { name: `Source preview ${path}:118`, exact: true });
      await focused.waitFor();
      assert.equal(await focused.evaluate(el => el === document.activeElement), true, 'click focuses source reading panel');
      const focusedBounds = await focused.boundingBox();
      assert.ok(focusedBounds.width > 640 && focusedBounds.x >= 0 && focusedBounds.x + focusedBounds.width <= viewport.width);
      await page.mouse.move(2, 2); await page.waitForTimeout(300);
      assert.equal(await focused.isVisible(), true, 'focused reading survives pointer leave');
      assert.equal(requests.length, 4, 'focus reuses source cache');
      await page.keyboard.press('Escape'); await focused.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'escape restores source trigger focus');
      await page.setViewportSize({ width: 720, height: 640 });
      await page.locator('[data-workspace-pane]').first().evaluate(el => { el.style.width = '420px'; });
      await trigger.click(); await focused.waitFor();
      const mobileBounds = await focused.boundingBox();
      assert.ok(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 720, 'focused source fits narrow desktop viewport');
      assert.ok(mobileBounds.y >= 0 && mobileBounds.y + mobileBounds.height <= 640, 'focused source fits viewport height');
      assert.equal(requests.length, 4, 'viewport change retains source cache');
      await focused.getByRole('button', { name: 'Close', exact: true }).click();
      await focused.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'close restores source trigger focus');
      await page.setViewportSize(viewport);
      await page.locator('[data-workspace-pane]').first().evaluate(el => { el.style.width = '420px'; });
      await trigger.hover(); await card.locator('[data-source-target]').waitFor();
      await page.mouse.move(2, 2); await popup.waitFor({ state: 'detached' });
      await trigger.hover(); await card.locator('[data-source-target]').waitFor();
      await pane.getByRole('button', { name: 'Source preview /other/unavailable.py:4', exact: true }).focus();
      await popup.getByRole('status').getByText('Preview unavailable', { exact: true }).waitFor();
      assert.equal(await popup.count(), 1, 'only one source hover popup may stay open');
      await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' });
      await pane.evaluate(el => { el.style.width = '800px'; });
      await card.locator('[data-source-target]').waitFor();
      assert.equal(await trigger.count(), 0, 'wide pane restores inline source');
      assert.equal(requests.length, 4);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ narrowPreview: true, lazyRead: true, hoverAndKeyboard: true, focusedReading: true,
        focusedViewportWidths: [1440, 720], focusRestored: true, noChatReflow: true, cacheReused: true }));
    }
    console.log(JSON.stringify({ viewport, inlinePreview: true, targetLine: 118, noNavigation: true, expandCollapse: true,
      stableDomOnMessageRefresh: true, stableBilingualPreview: true, noRefetchOnReload: true, retry: true, deniedCacheEvicted: true, noOverflow: true }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
