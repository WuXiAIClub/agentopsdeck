// Production UI, synthetic read-only session; no live data or Agent calls.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
import { assertOverflowStable } from './caption-overflow-stability.mjs';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
// Validate the frozen release itself when reconciling deployment receipts. Never
// silently fall back to today's source/dist if a requested candidate is missing.
const webDist = process.env.AOD_TEST_WEB_DIST
  ? resolve(process.env.AOD_TEST_WEB_DIST) : fileURLToPath(new URL('../dist', import.meta.url));
await access(join(webDist, 'index.html'));
// Static preview does not transform release assets, inject the dev client, or
// attempt to create an optimizer cache inside an immutable release directory.
const server = await preview({ root: webDist, configFile: false, envFile: false,
  logLevel: 'error', build: { outDir: webDist }, preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, serviceWorkers: 'block' });
  const scope = 'a'.repeat(64), sessionKey = `local:${btoa('codex:caption')}`, errors = [], forbidden = [];
  let usageReads = 0;
  const usageRanges = [];
  const session = { sessionKey, source: 'codex', agentId: 'codex', envConnectionId: 'local', title: 'A long session name should have priority over optional toolbar icons', status: 'idle', inputTokens: 1234567, outputTokens: 23456 };
  const archiveWrites = [];
  await context.addInitScript(({ scope, snapshot }) => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify(snapshot));
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  }, { scope, snapshot: layoutSnapshot(presetWorkspace([{ id: 'caption-pane', sessionKey }], 'single'), new Set()) });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin && req.method() === 'PATCH' && url.pathname.endsWith('/archive')) {
      assert.equal(decodeURIComponent(url.pathname.split('/').at(-2)), sessionKey);
      archiveWrites.push(req.postDataJSON());
      return route.fulfill({ status: 503, json: { error: 'Synthetic archive unavailable' } });
    }
    if (url.origin !== origin || req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (url.pathname.endsWith('/token-usage')) {
      usageReads++;
      const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to')), bucketMs = Number(url.searchParams.get('bucketMs'));
      usageRanges.push({ duration: to - from, bucketMs });
      return json({ version: 1, runtime: 'codex', attribution: 'root-agent', timeBasis: 'observed-at', coverage: 'partial', inputAccounting: 'includes-cache',
        from, to, bucketMs, observedSince: to - 1000, buckets: [{ at: Math.floor((to - 1000) / bucketMs) * bucketMs, samples: 1, inputTokens: 123, outputTokens: 45, cacheReadTokens: 20, cacheWriteTokens: null }] });
    }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: [session] }] });
    if (url.pathname.endsWith('/messages')) return json({ revision: '1', totalCount: 1, hiddenCount: 0, limits: { maxMessageChars: 100000 }, messages: [{ id: 'm', sessionKey, role: 'assistant', text: 'Stable history\n\n```js\nconsole.log("Card context");\n```', createdAt: 1 }] });
    if (url.pathname.endsWith('/queue')) return json({ items: [] });
    if (url.pathname.endsWith('/notebooks')) return json({ items: [] });
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const pane = page.locator('[data-workspace-pane]'), caption = pane.locator('.session-pane-caption');
  await pane.locator('.caption-overflow').waitFor();
  assert.equal(new URL(page.url()).hash, '', 'restoring workspace focus must not rewrite its URL');
  await pane.getByText('Stable history', { exact: true }).click();
  assert.equal(new URL(page.url()).hash, '', 'card activation is not route navigation');
  // The session-list card has its own menu, separate from the workspace caption.
  await page.locator('[data-session-card]').first().click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Session model', exact: true }).click();
  const modelDialog = page.getByRole('dialog', { name: 'Session model', exact: true });
  await modelDialog.waitFor();
  await modelDialog.getByRole('combobox', { name: 'Session model', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await modelDialog.count(), 0);
  await page.addStyleTag({ content: '[data-workspace-pane] { width: var(--test-caption-width, 1200px) !important; }' });
  await page.evaluate(() => { window.originalCaptionTools = document.querySelector('.caption-overflow-content'); window.originalSession = document.querySelector('[data-session-pane]'); });
  const resize = async width => {
    await page.evaluate(width => document.documentElement.style.setProperty('--test-caption-width', `${width}px`), width);
    await page.waitForTimeout(150);
    const geometry = await caption.evaluate(el => {
      const title = el.querySelector('.session-pane-drag-title').getBoundingClientRect(), rect = el.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(el.querySelector('.session-pane-drag-title h2'));
      const toolbar = el.querySelector('.caption-overflow').getBoundingClientRect();
      return { width: rect.width, titleWidth: title.width, nameWidth: el.querySelector('.session-pane-drag-title h2').getBoundingClientRect().width, intrinsic: range.getBoundingClientRect().width,
        leftGap: title.left - el.firstElementChild.getBoundingClientRect().right, gap: toolbar.left - title.right, rightGap: rect.right - toolbar.right,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: rect.height,
        inlineButtons: [...el.querySelectorAll('.caption-overflow-content button')].filter(button => button.checkVisibility({ visibilityProperty: true })).length,
        collapsed: el.querySelector('.caption-overflow').dataset.collapsed,
        priorities: [...el.querySelectorAll('.caption-overflow-content [data-caption-priority], .caption-overflow-content > button')].filter(item => item.getBoundingClientRect().width > 0).map(item => ({
          priority: Number(item.dataset.captionPriority ?? 50), hidden: item.hasAttribute('data-caption-hidden'),
        })) };
    });
    assert.ok(geometry.titleWidth > 0, JSON.stringify(geometry));
    assert.ok(geometry.leftGap >= 0 && geometry.leftGap <= 4.1, 'name immediately follows drag handle');
    assert.ok(geometry.rightGap >= 3 && geometry.rightGap <= 7, `actions right aligned: ${JSON.stringify(geometry)}`);
    if (width >= 640) assert.ok(geometry.nameWidth >= geometry.intrinsic, `full session name outranks actions: ${JSON.stringify(geometry)}`);
    if (width >= 800) assert.ok(geometry.gap >= 65, 'three icon separation when space permits');
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, JSON.stringify(geometry));
    assert.equal(geometry.height, 32, 'caption stays on one line');
    assert.equal(await page.evaluate(() => window.originalCaptionTools === document.querySelector('.caption-overflow-content') && window.originalSession === document.querySelector('[data-session-pane]')), true, 'no controller remount');
    return geometry;
  };
  const wide = await resize(1200);
  assert.equal(wide.collapsed, 'false');
  assert.equal(await caption.getByRole('button', { name: 'Rename chat', exact: true }).count(), 0, 'no duplicate icon beside the name');
  await caption.locator('.session-pane-drag-title h2').dblclick();
  const rename = caption.getByRole('textbox', { name: 'Rename chat', exact: true });
  await rename.fill('A long session title while editing must also fit fully');
  await page.waitForTimeout(150);
  assert.equal(await rename.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'editing name has room for Save/Cancel');
  await caption.getByRole('button', { name: 'Cancel rename', exact: true }).click();
  await caption.getByRole('button', { name: 'Session status', exact: true }).click();
  const exactUsage = page.locator('[data-session-token-metrics]');
  assert.match(await exactUsage.innerText(), /Native cumulative/);
  assert.ok((await exactUsage.innerText()).includes((23456).toLocaleString('en-US')), 'desktop output keeps full native precision');
  await page.keyboard.press('Escape');
  const managementActions = ['Rename session', 'Hide session', 'Archive session', 'Delete session…', 'Toggle card connections', 'Native token usage'];
  for (const name of managementActions) assert.equal(await caption.getByRole('button', { name, exact: true }).isVisible(), true, `${name} is inline when wide`);
  assert.equal(await caption.getByRole('button', { name: 'Toggle card connections', exact: true }).getAttribute('draggable'), 'true');
  const widths = [];
  for (const width of [800, 640, 480, 360, 280, 240]) {
    const geometry = await resize(width); widths.push(geometry);
    if (width === 800) await page.screenshot({ path: '/tmp/agentopsdeck-title-first-session.png' });
    assert.ok(geometry.titleWidth >= 64, JSON.stringify(geometry));
    if (geometry.collapsed === 'true') await assertOverflowStable(caption, caption.getByRole('button', { name: 'Pane tools', exact: true }));
    for (const hidden of geometry.priorities.filter(item => item.hidden)) {
      for (const inline of geometry.priorities.filter(item => !item.hidden)) assert.ok(inline.priority >= hidden.priority, `priority inversion: ${JSON.stringify(geometry)}`);
    }
    if (width === 640 || width === 480) {
      assert.equal(geometry.collapsed, 'true');
      assert.ok(geometry.titleWidth > geometry.width * .7, `long name takes priority: ${JSON.stringify(geometry)}`);
      const hidden = caption.locator('[data-caption-hidden]').first();
      assert.equal(await hidden.evaluate(el => el.inert), true, 'hidden tools are not keyboard-accessible');
      await hidden.evaluate(el => el.focus());
      assert.equal(await hidden.evaluate(el => el.contains(document.activeElement)), false);
    }
  }
  console.log('Progressive caption widths', JSON.stringify(widths));
  const titleNode = await caption.locator('.session-pane-drag-title').evaluateHandle(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim()) return node;
  });
  const longTitle = await titleNode.evaluate(node => node.textContent);
  for (const short of ['Codex tips', '短标题', 'I']) {
    await titleNode.evaluate((node, value) => { node.textContent = value; }, short);
    const geometry = await resize(480);
    assert.ok(geometry.titleWidth < 150, 'short title returns unused space to actions');
    assert.ok(geometry.inlineButtons > widths.find(row => row.width === 480).inlineButtons);
    if (geometry.collapsed === 'true') await assertOverflowStable(caption, caption.getByRole('button', { name: 'Pane tools', exact: true }));
  }
  await titleNode.evaluate(node => { node.textContent = 'Short'; });
  assert.equal((await resize(360)).collapsed, 'true');
  const trigger = caption.getByRole('button', { name: 'Pane tools', exact: true });
  const model = caption.getByRole('button', { name: 'Session model', exact: true });
  const deleteAction = caption.getByRole('button', { name: 'Delete session…', exact: true, includeHidden: true });
  assert.equal(await deleteAction.isVisible(), false, 'low-priority management action goes into More');
  assert.equal(await caption.getByRole('button', { name: 'Search messages', exact: true }).isVisible(), true, 'last DOM action remains inline because search has highest priority');
  const deleteAnchor = deleteAction.locator('..');
  await trigger.click();
  await deleteAnchor.evaluate(el => { el.dataset.captionPriority = '120'; });
  await page.waitForTimeout(150);
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'priority change closes More before remeasuring inline controls');
  assert.equal(await deleteAction.isVisible(), true, 'priority-only mutation rebalances existing controls');
  await deleteAnchor.evaluate(el => { el.dataset.captionPriority = '0'; });
  await page.waitForTimeout(150);
  assert.equal(await deleteAction.isVisible(), false, 'restoring priority returns low-priority action to More');
  await titleNode.evaluate((node, value) => { node.textContent = value; }, longTitle);
  await page.waitForTimeout(150);
  await trigger.click(); await model.waitFor();
  for (const name of managementActions) assert.equal(await caption.getByRole('button', { name, exact: true }).isVisible(), true, `${name} is directly accessible in a single overflow`);
  assert.equal(await caption.getByRole('button', { name: 'More session actions', exact: true }).count(), 0);
  await model.click(); await page.getByRole('region', { name: 'Session model', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await trigger.click();
  const search = caption.locator('.caption-overflow-content').getByRole('button', { name: /Search/ });
  await search.click();
  const input = page.locator('.message-search-panel input'); await input.fill('Stable');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await resize(1200); await resize(360); await trigger.click(); await search.click();
  assert.equal(await input.inputValue(), 'Stable', 'search draft survives overflow and resize');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await trigger.click(); await page.mouse.click(1700, 900);
  assert.equal(await deleteAction.isVisible(), false, 'outside click dismisses');
  await trigger.focus(); await page.keyboard.press('Enter'); await model.waitFor();
  assert.equal((await resize(1200)).collapsed, 'false', 'open menu safely returns inline on expansion');
  assert.equal(await model.isVisible(), true);
  for (let i = 0; i < 8; i++) { await resize(1200); await resize(360); }
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await caption.locator('.session-pane-drag-title').click({ button: 'right' });
  for (const button of await page.locator('.workspace-context-menu .session-workspace-preset-menu > button').all()) {
    assert.equal(await button.locator(':scope > svg').count(), 1, `card menu icon: ${await button.innerText()}`);
  }
  await page.locator('.workspace-context-menu').getByRole('button', { name: 'Session model', exact: true }).click();
  await page.getByRole('region', { name: 'Session model', exact: true }).waitFor();
  const modelRect = await page.getByRole('region', { name: 'Session model', exact: true }).boundingBox();
  assert.ok(modelRect && modelRect.x >= 0 && modelRect.width > 0, 'right-click opens model panel with collapsed toolbar');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator('[data-session-card] strong').first().evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  // Preserve the unrelated selection while dispatching the same bubbling DOM event.
  await pane.getByText('Stable history', { exact: true }).dispatchEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 200 });
  await page.locator('.workspace-context-menu').getByRole('button', { name: 'Session model', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await pane.getByText('Stable history', { exact: true }).evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    if (event.defaultPrevented) throw new Error('Selected message must retain native copy menu');
    window.getSelection().removeAllRanges();
  });
  assert.equal(await page.locator('.workspace-context-menu').count(), 0);
  await pane.locator('pre code').click({ button: 'right' });
  await page.locator('.workspace-context-menu').getByRole('button', { name: 'Session model', exact: true }).click();
  await page.getByRole('region', { name: 'Session model', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  if (!await pane.getByRole('button', { name: 'Maximize pane', exact: true }).isVisible()) await trigger.click();
  await pane.getByRole('button', { name: 'Maximize pane', exact: true }).click();
  await pane.getByText('Stable history', { exact: true }).click({ button: 'right' });
  await page.locator('.workspace-context-menu').getByRole('button', { name: 'Session model', exact: true }).click();
  await page.getByRole('region', { name: 'Session model', exact: true }).waitFor();
  await model.click();
  assert.equal(await pane.getByRole('button', { name: 'Close pane', exact: true }).count(), 0);
  await pane.getByRole('button', { name: 'Restore pane', exact: true }).click();
  assert.equal(await pane.count(), 1);
  await resize(1200);
  await caption.getByRole('button', { name: 'Archive session', exact: true }).click();
  await pane.getByText('Synthetic archive unavailable', { exact: true }).waitFor();
  assert.deepEqual(archiveWrites, [{ archived: true }], 'archive only targets the explicitly selected card, no automatic replay');
  assert.equal(await caption.getByRole('button', { name: 'Archive session', exact: true }).isEnabled(), true);
  assert.equal(await caption.getByRole('button', { name: 'More session actions', exact: true }).count(), 0);
  if (!await caption.getByRole('button', { name: 'Native token usage', exact: true }).isVisible()) await caption.getByRole('button', { name: 'Pane tools', exact: true }).click();
  await page.getByRole('button', { name: 'Native token usage', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Native token usage', exact: true });
  await usage.getByRole('cell', { name: '123', exact: true }).waitFor();
  assert.equal(usageReads, 1);
  await usage.getByRole('combobox', { name: 'Usage period' }).selectOption('7');
  await usage.getByRole('cell', { name: '123', exact: true }).waitFor();
  assert.equal(usageReads, 2);
  await usage.getByRole('combobox', { name: 'Usage period' }).selectOption(String(1 / 24));
  await usage.getByRole('cell', { name: '123', exact: true }).waitFor();
  assert.equal(usageReads, 3);
  assert.deepEqual(usageRanges.at(-1), { duration: 3_600_000, bucketMs: 60_000 });
  await page.keyboard.press('Escape'); await usage.waitFor({ state: 'detached' });
  await page.waitForTimeout(1200); assert.equal(usageReads, 3, 'closed usage panel never polls');
  const workspaceUrl = page.url();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-session-card]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Session model', exact: true }).click();
  await modelDialog.getByRole('combobox', { name: 'Session model', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-session-card]').click();
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).waitFor();
  assert.equal(page.url(), workspaceUrl, 'opening a mobile session must not rewrite the workspace URL');
  await page.getByRole('button', { name: 'Native token usage', exact: true }).first().click();
  await usage.getByRole('cell', { name: '123', exact: true }).waitFor();
  assert.equal(usageReads, 4, 'mobile usage entry uses the same on-demand panel');
  await usage.getByRole('combobox', { name: 'Usage period' }).selectOption(String(1 / 24));
  await usage.getByRole('cell', { name: '123', exact: true }).waitFor();
  assert.deepEqual(usageRanges.at(-1), { duration: 3_600_000, bucketMs: 60_000 });
  await page.keyboard.press('Escape'); await usage.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(page.url(), workspaceUrl, 'returning to the mobile list must not rewrite the workspace URL');
  await page.locator('[data-session-card]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Native token usage', exact: true }).click();
  await usage.getByRole('cell', { name: '123', exact: true }).waitFor();
  assert.equal(usageReads, 6, 'mobile list menu also opens the shared panel');
  await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
  await usage.waitFor({ state: 'detached' });
  await page.waitForTimeout(1200); assert.equal(usageReads, 6, 'mobile auth change closes panel without polling');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  if (process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_SCREENSHOT });
  console.log(JSON.stringify({ verified: true, widths: [1200, 800, 640, 480, 360, 280, 240], titlePriority: true, oneLine: true, noRemount: true, nestedPanels: true, preservedSearch: true, resizeCycles: 8,
    contextModelInCollapsedToolbar: true, listCardModel: true, mobileCardModel: true, focusedBodyModel: true, selectionContextIsolation: true,
    focusMinimizeOnly: true, nativeUsageOnDemand: true, mobileMinuteUsage: true, usageAuthClose: true, mobileUrlStable: true }));
} finally { await browser?.close(); await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
