import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-desktop-layout-perf-'));
let browser, server;
const baseline = process.env.AOD_PERF_BASELINE === '1';
try {
  // A/B control changes only the two measured boundaries in the temporary test
  // bundle. It never rewrites the working tree or the application build.
  const control = { name: 'desktop-layout-control', enforce: 'pre', transform(code, id) {
    if (!baseline || !id.endsWith('/components/SessionWorkspaceView.tsx')) return;
    const content = '<WorkspaceSessionContent session={pane.session} renderPane={renderPane} />';
    assert.ok(code.includes(content), 'control must find the measured session boundary');
    const handlers = /const placementHandlers = \{ onPointerMove: \(event: PointerEvent<HTMLElement>\) => \{[\s\S]*?\}, onPointerUp: finishPlacement/;
    assert.ok(handlers.test(code), 'control must find the measured frame scheduler');
    return code.replace(content, 'renderPane(pane.session)').replace(handlers, 'const placementHandlers = { onPointerMove: previewPlacement, onPointerUp: finishPlacement');
  } };
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', plugins: [control], build: {
    outDir: output, emptyOutDir: false, rollupOptions: { input: join(root, 'tests/fixtures/desktop-layout-performance.html') },
  } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1100 }, serviceWorkers: 'block' });
  const errors = [], denied = [], docs = new Map();
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (/\/workspace\/layouts\/(current|saved)$/.test(url.pathname)) {
      const previous = docs.get(url.pathname) ?? { revision: 0, content: null };
      if (request.method() === 'PUT') docs.set(url.pathname, { revision: previous.revision + 1, content: request.postDataJSON().content });
      else if (request.method() !== 'GET') { denied.push(request.method()); return route.abort(); }
      return route.fulfill({ json: docs.get(url.pathname) ?? previous });
    }
    if (request.method() !== 'GET') { denied.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    return route.fulfill({ status: 404, json: {} });
  });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    const read = Element.prototype.getBoundingClientRect;
    window.surfaceReads = 0;
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.classList.contains('session-workspace-surface')) window.surfaceReads++;
      return read.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  await page.goto(`${origin}/tests/fixtures/desktop-layout-performance.html`);
  const panes = page.locator('[data-workspace-pane]'), left = panes.first();
  try { await page.waitForFunction(() => document.querySelectorAll('[data-probe-row]').length === 600, null, { timeout: 10000 }); }
  catch (error) { console.error(await page.locator('body').innerText()); throw error; }
  await page.getByLabel('Layout synced to your account', { exact: true }).first().waitFor();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => ({ ...window.layoutStats, reads: window.surfaceReads }));
  const difference = (after, before) => Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));
  const draft = left.getByRole('textbox');
  await draft.fill('keep this unsent draft');
  await page.evaluate(() => { window.originalProbes = [...document.querySelectorAll('[data-probe]')]; });
  const neighbour = await panes.nth(1).boundingBox();
  const before = await snapshot();
  const resize = left.getByRole('button', { name: 'Resize pane', exact: true });
  const box = await resize.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x - 90, box.y - 100, { steps: 30 }); await page.mouse.up(); await settle();
  const resizeCounts = difference(await snapshot(), before);
  assert.deepEqual(await panes.nth(1).boundingBox(), neighbour, 'resize leaves neighbour geometry intact');
  if (!baseline) assert.equal(resizeCounts.entries, 0, 'layout-only resizing never invokes session render callbacks');
  assert.equal(resizeCounts.mounts, 0); assert.equal(resizeCounts.unmounts, 0);

  const grip = left.getByRole('button', { name: 'Move pane', exact: true });
  const gripBox = await grip.boundingBox(), x = gripBox.x + gripBox.width / 2, y = gripBox.y + gripBox.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await settle();
  const burstBefore = await snapshot();
  // Same-frame high-frequency events exercise coalescing deterministically.
  await grip.evaluate((element, { x, y }) => {
    for (let i = 1; i <= 80; i++) element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x + i, clientY: y + 40, buttons: 1 }));
  }, { x, y });
  await settle();
  const burstCounts = difference(await snapshot(), burstBefore);
  if (!baseline) { assert.equal(burstCounts.reads, 1, '80 moves share one surface geometry read'); assert.equal(burstCounts.entries, 0); }
  assert.equal(await page.locator('.session-workspace-drop-preview').count(), 1);
  await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
  assert.equal(await page.locator('.session-workspace-drop-preview').count(), 0);

  // Pointerup before the pending RAF must use its own final coordinates.
  const prior = await left.boundingBox();
  await page.mouse.move(x, y); await page.mouse.down();
  await grip.evaluate((element, { x, y }) => {
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x + 10, clientY: y + 20, buttons: 1 }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: x + 70, clientY: y + 50 }));
  }, { x, y });
  await page.mouse.up(); await settle();
  const moved = await left.boundingBox();
  assert.ok(Math.abs(moved.x - prior.x - 70) < 1 && Math.abs(moved.y - prior.y - 50) < 1, 'release commits latest coordinates');
  assert.equal(await page.locator('.session-workspace-drop-preview').count(), 0, 'pending frame never resurrects preview');
  assert.equal(await draft.inputValue(), 'keep this unsent draft');
  assert.equal(await page.evaluate(() => window.originalProbes.every((node, i) => node === document.querySelectorAll('[data-probe]')[i])), true, 'controllers are not reparented/remounted');
  // Cancellation before RAF, not just after the preview has already appeared.
  for (const action of ['Escape', 'blur', 'pointercancel', 'lostpointercapture']) {
    const beforeCancel = await left.boundingBox();
    const point = await grip.boundingBox(), x = point.x + point.width / 2, y = point.y + point.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await grip.evaluate((element, { action, x, y }) => {
      element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x + 60, clientY: y + 20, buttons: 1 }));
      if (action === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (action === 'blur') window.dispatchEvent(new Event('blur'));
      else element.dispatchEvent(new PointerEvent(action, { bubbles: true, pointerId: 1 }));
    }, { action, x, y });
    await settle(); await page.mouse.up(); await settle();
    assert.equal(await page.locator('.session-workspace-drop-preview').count(), 0, `${action} cancels pending preview`);
    assert.deepEqual(await left.boundingBox(), beforeCancel, `${action} never commits geometry`);
  }
  await left.locator('[data-probe-update]').click();
  await page.waitForFunction(() => document.querySelector('[data-probe-status]').textContent.includes(':1:en'));
  await page.locator('#change-renderer').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-probe-status]')].every(node => node.textContent.includes(':1:')));
  assert.match(await left.locator('[data-probe-status]').textContent(), /^one:1:1:en$/);
  await page.locator('#change-metadata').click();
  await page.waitForFunction(() => document.querySelector('[data-probe-status]').textContent.startsWith('updated:'));
  await page.evaluate(() => { localStorage.setItem('agentopsdeck.locale', 'zh-CN'); window.dispatchEvent(new StorageEvent('storage', { key: 'agentopsdeck.locale' })); });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-probe-status]')].every(node => node.textContent.endsWith(':zh-CN')));
  assert.equal(await page.locator('[data-probe-row]').count(), 600);
  const end = await snapshot();
  // Removal must also cancel the scheduler, including while a pointer is held.
  const endGrip = left.locator('.session-pane-drag'), endBox = await endGrip.boundingBox();
  await page.mouse.move(endBox.x + 5, endBox.y + 5); await page.mouse.down();
  await endGrip.evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 150, clientY: 160, buttons: 1 }));
    document.querySelector('#toggle-workspace').click();
  });
  await settle(); await page.mouse.up();
  assert.equal(await panes.count(), 0);
  assert.equal(await page.locator('.session-workspace-drop-preview').count(), 0);
  assert.equal((await snapshot()).unmounts, 3);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ baseline, resizeCounts, burstCounts, final: end, result: 'PASS' }));
} finally {
  await browser?.close(); await server?.httpServer.close();
  await rm(output, { recursive: true, force: true });
}
