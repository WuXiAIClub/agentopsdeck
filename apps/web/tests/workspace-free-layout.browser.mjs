// Production assets + isolated real Hub SQLite; no live sessions or mutations.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-free-layout-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const principal = { userId: 'default', admin: true }, app = new Hono();
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('No real Connector'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const keys = ['one', 'two', 'three'].map(id => encodeHubSessionId('local', `codex:${id}`));
const initial = presetWorkspace(keys.slice(0, 2).map((sessionKey, i) => ({ id: `pane-${i}`, sessionKey })), 'columns');
hub.layouts.save('default', 'current', { revision: 0, content: JSON.stringify(layoutSnapshot(initial, new Set())) });
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const errors = [], forbidden = [], chunks = [], mutations = [];
  async function device() {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1100 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      if (location.protocol === 'http:') localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (url.pathname.includes('/assets/')) chunks.push(url.pathname);
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/') || url.pathname.startsWith('/api/hub/v1/notebooks')) {
        if (req.method() !== 'GET') mutations.push(url.pathname);
        const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      if (req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { items: [] } });
      if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: keys.map((sessionKey, i) => ({ sessionKey, envConnectionId: 'local', source: 'codex', agentId: 'codex', title: `Session ${i + 1}`, status: 'idle' })) }] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 1, hiddenCount: 0, messages: [{ id: 'message', role: 'assistant', text: 'Synthetic stable history', createdAt: 1, status: 'sent' }] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/media-library') return json({ enabled: false, path: '', roots: [], entries: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
    await page.goto(origin); await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
    return { page, context };
  }
  const { page } = await device();
  assert.equal(chunks.some(path => /notebook-(engine|extensions)|NotebookEditor/.test(path)), false, 'editor engine stays lazy without a notebook');
  const panes = page.locator('[data-workspace-pane]'), left = panes.nth(0), right = panes.nth(1);
  await page.getByLabel('Layout synced to your account', { exact: true }).first().waitFor();
  const initialLeft = await left.boundingBox(), initialRight = await right.boundingBox();
  // Lock is scoped/persistent and blocks pointer/keyboard geometry, not input.
  await page.getByRole('button', { name: 'Lock layout', exact: true }).click();
  assert.equal(await page.locator('.session-workspace-surface').getAttribute('data-layout-locked'), 'true');
  assert.equal(await page.locator('.session-pane-resize-edge,.session-pane-resize-corner,.session-pane-resize,.session-workspace-divider').count(), 0);
  const lockedGrip = left.getByRole('button', { name: 'Move pane', exact: true });
  await lockedGrip.focus(); await page.keyboard.press('Alt+ArrowRight');
  const lockedBox = await lockedGrip.boundingBox();
  await page.mouse.move(lockedBox.x + 5, lockedBox.y + 5); await page.mouse.down();
  await page.mouse.move(lockedBox.x + 100, lockedBox.y + 60, { steps: 5 }); await page.mouse.up();
  assert.deepEqual(await left.boundingBox(), initialLeft);
  assert.deepEqual(await right.boundingBox(), initialRight);
  await page.reload(); await page.getByRole('button', { name: 'Unlock layout', exact: true }).waitFor();
  assert.equal(await page.locator('.session-workspace-surface').getAttribute('data-layout-locked'), 'true');
  await page.getByRole('button', { name: 'Unlock layout', exact: true }).click();
  const mainBox = await page.locator('.desktop-session-main').boundingBox();
  assert.ok(Math.abs(initialLeft.x - mainBox.x - 8) < 1, 'left card reaches the 8px canvas inset');
  const handle = await left.locator('[data-edge="left"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + 90, handle.y + handle.height / 2, { steps: 12 }); await page.mouse.up();
  const resized = await left.boundingBox();
  assert.ok(resized.x > initialLeft.x + 60 && resized.width < initialLeft.width - 60);
  assert.deepEqual(await right.boundingBox(), initialRight, 'left edge never moves neighbour');
  const grip = await left.getByRole('button', { name: 'Move pane', exact: true }).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 50, grip.y + grip.height / 2, { steps: 10 }); await page.mouse.up();
  const moved = await left.boundingBox(); assert.ok(moved.x < resized.x - 30); assert.deepEqual(await right.boundingBox(), initialRight);
  const corner = left.getByRole('button', { name: 'Resize pane', exact: true });
  const cornerBox = await corner.boundingBox();
  await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2); await page.mouse.down();
  await page.mouse.move(cornerBox.x + cornerBox.width / 2 - 65, cornerBox.y + cornerBox.height / 2 - 100, { steps: 10 }); await page.mouse.up();
  const cornerResized = await left.boundingBox();
  assert.equal(cornerResized.x, moved.x); assert.equal(cornerResized.y, moved.y);
  assert.ok(cornerResized.width < moved.width - 50 && cornerResized.height < moved.height - 90, 'corner resizes both axes');
  assert.deepEqual(await right.boundingBox(), initialRight, 'corner resize never changes neighbour');
  await corner.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  assert.ok(cornerBox.width <= 20 && cornerBox.height <= 20, 'bottom corner no longer occupies a 32px block');
  async function checkTopCorners(pane, page, floating = false) {
    for (const edge of ['top-left', 'top-right']) {
      const before = await pane.boundingBox(), control = pane.locator(`.session-pane-resize-corner[data-edge="${edge}"]`);
      assert.equal(await control.textContent(), '', 'top corner has no arrow');
      assert.equal(await control.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
      const box = await control.boundingBox(), px = box.x + box.width / 2, py = box.y + box.height / 2;
      const dx = edge === 'top-left' ? 35 : -35;
      await page.mouse.move(px, py); await page.mouse.down();
      await page.mouse.move(px + dx, py + 40, { steps: 10 }); await page.mouse.up();
      const after = await pane.boundingBox();
      assert.ok(Math.abs(after.width - before.width + 35) < 1 && Math.abs(after.height - before.height + 40) < 1, `${edge} changes both axes (floating=${floating})`);
      assert.ok(Math.abs(after.y + after.height - before.y - before.height) < 1, 'bottom stays anchored');
      assert.ok(Math.abs(edge === 'top-left' ? after.x + after.width - before.x - before.width : after.x - before.x) < 1, 'opposite horizontal edge stays anchored');
      if (!floating) assert.deepEqual(await right.boundingBox(), initialRight, 'top corners leave neighbour unchanged');
      // Keyboard restores original frame without introducing snap rounding.
      await control.focus();
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
      // 35px drag intentionally exercises non-keyboard increments. Restore by pointer.
      const restore = await control.boundingBox();
      await page.mouse.move(restore.x + restore.width / 2, restore.y + restore.height / 2); await page.mouse.down();
      await page.mouse.move(restore.x + restore.width / 2 - dx, restore.y + restore.height / 2, { steps: 8 }); await page.mouse.up();
      const restored = await pane.boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored[key] - before[key]) < 1, `${edge} restores ${key}`);
    }
  }
  await checkTopCorners(left, page);
  const finalFrame = await left.boundingBox();
  assert.ok(Math.abs(finalFrame.width - cornerResized.width - 10) < 1 && Math.abs(finalFrame.height - cornerResized.height - 10) < 1, 'corner supports keyboard');
  // Magnetic edge feedback holds briefly, releases using raw pointer travel,
  // then disappears without touching the neighbouring card or saved geometry.
  for (const edge of ['right', 'bottom']) {
    const box = await left.locator(`[data-edge="${edge}"]`).boundingBox();
    const horizontal = edge === 'right', px = box.x + box.width / 2, py = box.y + box.height / 2;
    const target = horizontal ? initialRight.x - 4 : initialRight.y + initialRight.height;
    const originalEdge = horizontal ? finalFrame.x + finalFrame.width : finalFrame.y + finalFrame.height;
    const delta = target - originalEdge;
    await page.mouse.move(px, py); await page.mouse.down();
    await page.mouse.move(px + (horizontal ? delta + 2 : 0), py + (horizontal ? 0 : delta - 5), { steps: 8 });
    await page.locator(`.workspace-alignment-guide[data-axis="${horizontal ? 'x' : 'y'}"]`).waitFor();
    const aligned = await left.boundingBox();
    assert.ok(Math.abs((horizontal ? aligned.x + aligned.width : aligned.y + aligned.height) - target) < 1, 'edge snaps to peer/gutter');
    await page.mouse.move(px + (horizontal ? delta - 25 : 0), py + (horizontal ? 0 : delta - 25));
    await page.waitForFunction(axis => !document.querySelector(`.workspace-alignment-guide[data-axis="${axis}"]`), horizontal ? 'x' : 'y');
    const released = await left.boundingBox();
    assert.ok(Math.abs((horizontal ? released.x + released.width : released.y + released.height) - target + 25) < 1, 'drag escapes magnet');
    await page.mouse.move(px, py); await page.mouse.up();
    assert.equal(await page.locator('.workspace-alignment-guide').count(), 0);
    assert.deepEqual(await left.boundingBox(), finalFrame);
    assert.deepEqual(await right.boundingBox(), initialRight);
  }
  await page.waitForTimeout(1800);
  const savedFrame = JSON.parse(hub.layouts.get('default', 'current').content).workspace.panes[0].dockFrame;
  assert.ok(savedFrame?.x > 0);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  assert.deepEqual(await left.boundingBox(), finalFrame, 'reload restores corner-resized geometry');
  const other = await device(); assert.deepEqual(await other.page.locator('[data-workspace-pane]').first().boundingBox(), finalFrame, 'fresh browser restores account geometry');
  await other.context.close();
  // Sidebar expansion and small cells must not turn the desktop into one tab.
  // Keep host identity too: no controller remount or layout rewrite.
  const savedLayout = JSON.parse(hub.layouts.get('default', 'current').content).workspace;
  await page.evaluate(() => { window.paneHosts = [...document.querySelectorAll('[data-workspace-pane]')]; });
  const assertMultiPane = async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2
      && [...document.querySelectorAll('[data-workspace-pane]')].every(el => !el.hidden && el.getBoundingClientRect().width > 0));
    assert.equal(await page.locator('.session-workspace-tabs').count(), 0);
    assert.equal(await page.evaluate(() => window.paneHosts.every((host, i) => host === document.querySelectorAll('[data-workspace-pane]')[i])), true, 'sidebar resize retains mounted controllers');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow');
  };
  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByRole('button', { name: 'Collapse session list', exact: true }).click();
  await assertMultiPane();
  await page.getByRole('button', { name: 'Expand session list', exact: true }).click();
  await assertMultiPane();
  assert.ok((await page.locator('.session-workspace-surface').boundingBox()).width < 640, 'exercise old workspace-width fallback');
  await page.getByRole('button', { name: 'Minimize navigation', exact: true }).click();
  await assertMultiPane();
  await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
  await assertMultiPane();
  await page.setViewportSize({ width: 1000, height: 800 });
  await assertMultiPane();
  assert.ok((await page.locator('.session-workspace-surface').boundingBox()).width > 640);
  assert.ok((await left.boundingBox()).width < 299.5, 'exercise old single-small-card fallback');
  await page.setViewportSize({ width: 1800, height: 500 });
  await assertMultiPane();
  assert.ok((await page.locator('.session-workspace-surface').boundingBox()).height < 540, 'exercise old workspace-height fallback');
  await page.setViewportSize({ width: 1800, height: 1100 });
  await assertMultiPane();
  await page.waitForTimeout(1800);
  assert.deepEqual(await left.boundingBox(), finalFrame, 'sidebar/viewport roundtrip preserves geometry');
  assert.deepEqual(JSON.parse(hub.layouts.get('default', 'current').content).workspace, savedLayout, 'responsive changes do not overwrite saved layout');
  // Actual phone shell still owns the list/chat flow; returning restores desktop.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !document.querySelector('[data-session-workspace]'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  assert.deepEqual(await left.boundingBox(), finalFrame, 'phone/desktop roundtrip restores saved layout');
  // Repeated modal/resource lifecycle, warm then collect post-GC diagnostics.
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const sample = async () => { await cdp.send('HeapProfiler.collectGarbage'); return { ...(await cdp.send('Memory.getDOMCounters')), metrics: (await cdp.send('Performance.getMetrics')).metrics.filter(x => ['JSHeapUsedSize', 'Documents', 'Nodes', 'JSEventListeners'].includes(x.name)) }; };
  async function cycle(index) {
    await page.getByLabel('Saved layouts', { exact: true }).click();
    await page.getByRole('button', { name: 'Save current layout', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Layout name', exact: true });
    await modal.getByRole('textbox').fill(`Layout ${index}`);
    await modal.getByRole('button', { name: index === 0 ? 'Save changes' : 'Cancel', exact: true }).click();
    await page.getByLabel('Layout presets', { exact: true }).click();
    await page.getByRole('button', { name: 'Media library', exact: true }).click();
    const media = page.locator('[data-workspace-pane]').filter({ has: page.locator('.workspace-media-card') });
    await media.locator('.workspace-media-card').waitFor();
    try { await media.getByRole('button', { name: 'Close pane', exact: true }).click(); }
    catch (error) { console.error({ errors, body: await page.locator('body').innerText(), html: await media.count() ? await media.innerHTML() : 'media removed' }); throw error; }
  }
  await cycle(0); await page.waitForTimeout(1600);
  const baseline = await sample();
  for (let i = 1; i <= 25; i++) await cycle(i);
  await page.waitForTimeout(1600); const final = await sample();
  assert.equal(await page.locator('dialog').count(), 0); assert.equal(await panes.count(), 2);
  assert.ok(final.nodes < baseline.nodes + 250, 'closed cards/dialogs do not accumulate DOM');
  assert.ok(final.jsEventListeners < baseline.jsEventListeners + 100, 'closed cards/dialogs do not accumulate listeners');
  // New minimums are reachable by real drag and survive account restoration.
  const smallCorner = await left.getByRole('button', { name: 'Resize pane', exact: true }).boundingBox();
  await page.mouse.move(smallCorner.x + smallCorner.width / 2, smallCorner.y + smallCorner.height / 2); await page.mouse.down();
  await page.mouse.move(smallCorner.x - 1600, smallCorner.y - 1600, { steps: 10 }); await page.mouse.up();
  const minimum = await left.boundingBox();
  assert.ok(minimum.width <= 4 && Math.abs(minimum.height - 288) < 1, 'session width has no artificial floor; height remains usable');
  await page.waitForTimeout(1800); await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 2);
  assert.deepEqual(await left.boundingBox(), minimum, 'smaller frame restores');
  // Recovery lives outside the tiny caption, so even a one-pixel pane is recoverable.
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Equalize panes', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-workspace-pane]').getBoundingClientRect().width > 400);
  await page.waitForTimeout(1800);
  // Floating corners share the same anchor/minimum rules; caption actions remain clickable.
  const floatingDevice = await device(), floatingPane = floatingDevice.page.locator('[data-workspace-pane]').first();
  const captionAction = async name => {
    const action = floatingPane.getByRole('button', { name, exact: true });
    if (!await action.isVisible()) await floatingPane.getByRole('button', { name: 'Pane tools', exact: true }).click();
    await action.click();
  };
  await captionAction('Float pane');
  await floatingDevice.page.waitForFunction(() => document.querySelector('[data-workspace-pane][data-floating=true]'));
  await checkTopCorners(floatingPane, floatingDevice.page, true);
  await floatingDevice.page.screenshot({ path: '/tmp/agentopsdeck-corner-handles.png' });
  await captionAction('Collapse floating pane');
  assert.equal(await floatingPane.locator('.session-pane-resize-corner').count(), 0, 'collapsed panes have no resize hotzones');
  await captionAction('Expand floating pane');
  await captionAction('Maximize pane');
  assert.equal(await floatingPane.locator('.session-pane-resize-corner').count(), 0, 'maximized panes have no resize hotzones');
  await floatingDevice.context.close();
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Workspace overview · Preview', exact: true }).click();
  const overview = page.getByRole('region', { name: 'Workspace overview', exact: true });
  await overview.waitFor();
  assert.equal(await overview.locator('header, h2').count(), 0, 'overview uses only the enclosing card caption');
  assert.equal(JSON.parse(hub.layouts.get('default', 'saved').content).length, 1);
  // Workspace menu uses the top layer; form/text selection keeps the native menu.
  async function openContext() {
    const surface = page.locator('.session-workspace-surface'), box = await surface.boundingBox();
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4, { button: 'right' });
    await page.locator('.workspace-context-menu:popover-open').waitFor();
  }
  await openContext();
  const contextMenu = page.locator('.workspace-context-menu'), contextBox = await contextMenu.boundingBox();
  assert.ok(contextBox.x >= 0 && contextBox.y >= 0 && contextBox.x + contextBox.width <= 1800 && contextBox.y + contextBox.height <= 1100);
  assert.ok(contextBox.height <= 560, 'long action lists scroll within a bounded menu');
  assert.ok(contextBox.x > 1000 && contextBox.y > 200, 'menu follows the real right-click near the bottom-right corner');
  await page.screenshot({ path: '/tmp/agentopsdeck-workspace-context-menu.png' });
  await page.keyboard.press('Escape'); await contextMenu.waitFor({ state: 'detached' });
  const nativeInput = await left.locator('textarea').first().evaluate(el => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(event); return !event.defaultPrevented;
  });
  assert.equal(nativeInput, true);
  await openContext();
  await contextMenu.getByRole('button', { name: 'New session', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create new session', exact: true });
  await createDialog.waitFor(); await contextMenu.waitFor({ state: 'detached' });
  await createDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await openContext();
  await contextMenu.getByRole('combobox', { name: 'Add session card', exact: true }).selectOption(keys[2]);
  await contextMenu.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-pane]').length === 4);
  await openContext();
  await contextMenu.getByRole('button', { name: 'Media library', exact: true }).click();
  await page.locator('.workspace-media-card').waitFor(); await contextMenu.waitFor({ state: 'detached' });
  // Persisted tab ordering must not restore a layout or mutate any Session.
  const saved = hub.layouts.get('default', 'saved');
  const original = JSON.parse(saved.content)[0];
  hub.layouts.save('default', 'saved', { revision: saved.revision, content: JSON.stringify([
    { ...original, id: 'order-a', name: 'Order Alpha' },
    { ...original, id: 'order-b', name: 'Order Beta' },
    { ...original, id: 'order-c', name: 'Order Gamma' },
  ]) });
  await page.reload();
  const shortcuts = page.locator('.saved-layouts-shortcuts');
  await shortcuts.getByRole('button', { name: 'Order Gamma', exact: true }).waitFor();
  const order = () => shortcuts.locator('.saved-layout-name').allTextContents();
  await shortcuts.getByRole('button', { name: 'Order Gamma', exact: true }).dragTo(shortcuts.getByRole('button', { name: 'Order Alpha', exact: true }));
  await page.waitForFunction(() => document.querySelector('.saved-layout-name')?.textContent === 'Order Gamma');
  assert.deepEqual(await order(), ['Order Gamma', 'Order Alpha', 'Order Beta']);
  await shortcuts.getByRole('button', { name: 'Order Gamma', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual(await order(), ['Order Alpha', 'Order Gamma', 'Order Beta']);
  await page.waitForFunction(() => !document.querySelector('.layout-sync-status[data-pending="true"]'));
  await page.reload();
  await shortcuts.getByRole('button', { name: 'Order Gamma', exact: true }).waitFor();
  assert.deepEqual(await order(), ['Order Alpha', 'Order Gamma', 'Order Beta'], 'reorder survives reload');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ verified: true, savedTabDragKeyboardReload: true, workspaceContextMenu: true, createDialogNoMutation: true, addSessionCard: true, nativeInputContext: true, freeResize: true, accountRestore: true, sidebarMultiPane: true, mobileRoundtrip: true, cycles: 26, baseline, final, mutations: mutations.length }));
} finally { await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true }); }
