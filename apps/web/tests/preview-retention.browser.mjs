// Production-built real source cards, two persistent synthetic history panes.
// No native sessions, authenticated APIs, live DBs or business messages.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-preview-retention-'));
let browser, server;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, emptyOutDir: false,
    rollupOptions: { input: join(root, 'tests/fixtures/preview-retention.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const errors = [], denied = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET') { denied.push(url.href); return route.abort(); }
    return route.continue();
  });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedCode = text; } } });
    const NativeObserver = IntersectionObserver;
    window.previewObservers = { created: 0, live: 0 };
    window.IntersectionObserver = class extends NativeObserver {
      active = true;
      constructor(...args) { super(...args); window.previewObservers.created++; window.previewObservers.live++; }
      disconnect() { if (this.active) { this.active = false; window.previewObservers.live--; } super.disconnect(); }
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/tests/fixtures/preview-retention.html`);
  const pane = page.locator('[data-test-pane="0"] .message-selection-surface');
  const card = pane.locator('.source-inline-card').first();
  const code = card.locator('.source-inline-code');
  const quiet = () => page.waitForTimeout(1500);
  const metrics = () => page.evaluate(() => ({ messages: document.querySelectorAll('[data-retained-message]').length,
    nodes: document.querySelectorAll('*').length, richLines: document.querySelectorAll('.source-inline-line').length,
    compact: document.querySelectorAll('[data-source-rendering="compact"]').length,
    retained: [...document.querySelectorAll('[data-retained-message] .source-inline-code')].filter(el => el.textContent.includes('const retainedLine118 = 12;')).length,
    observers: { ...window.previewObservers } }));
  await page.waitForFunction(() => document.querySelectorAll('[data-source-rendering="compact"]').length > 350);
  const small = await metrics(); assert.equal(small.retained, 400); assert.ok(small.richLines < 150);
  // Keep the same card/controller/textarea nodes while appending 1800 rows each.
  await card.evaluate(el => { window.originalRetainedCard = el; });
  // Scope to form controls: a global accessible-name scan across 4000 cards is
  // unnecessary and can exceed the automation timeout despite intact drafts.
  const draft = index => page.locator(`textarea[aria-label="Draft ${index}"]`);
  await draft(0).fill('draft survives retention');
  await page.locator('#grow').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-source-rendering="compact"]').length > 3900);
  const large = await metrics(); assert.equal(large.retained, 4000); assert.equal(large.messages, 4000);
  assert.ok(large.richLines <= small.richLines + 28, 'rich-node cost stays near viewport as histories grow tenfold');
  assert.ok(large.observers.live <= 3, 'one retention observer per pane plus shared lazy loader');
  assert.equal(await card.evaluate(el => el === window.originalRetainedCard), true);
  assert.equal(await draft(0).inputValue(), 'draft survives retention');
  assert.equal(await page.locator('[data-tabbed-preview] [data-source-rendering="full"]').count(), 2, 'tabbed code retains original tab-stop geometry');
  await card.getByRole('button', { name: 'Expand', exact: true }).click();
  await code.locator('.source-inline-line').nth(44).waitFor({ state: 'attached' });
  const geometry = () => code.evaluate(el => ({ height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight, scrollWidth: el.scrollWidth, left: el.scrollLeft, top: el.scrollTop }));
  await code.evaluate(el => { el.scrollTop = 40; el.scrollLeft = 55; });
  const fullGeometry = await geometry();
  // A focused card and a selection freeze reclamation even after it leaves view.
  await pane.evaluate(el => { el.scrollTop = el.scrollHeight; }); await quiet();
  assert.equal(await code.getAttribute('data-source-rendering'), 'full', 'focused expand control pins presentation');
  await page.locator('#outside').focus(); await quiet();
  assert.equal(await code.getAttribute('data-source-rendering'), 'compact');
  const compactGeometry = await geometry();
  for (const key of ['height', 'scrollHeight', 'scrollWidth', 'left', 'top']) assert.ok(Math.abs(fullGeometry[key] - compactGeometry[key]) <= 1, `${key}: ${JSON.stringify({ fullGeometry, compactGeometry })}`);
  const bottomBefore = await pane.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
  await quiet();
  assert.deepEqual(await pane.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight })), bottomBefore, 'quiet reclamation does not move the bottom anchor');
  // Native find sees compact code text and may select it before IO restoration.
  assert.equal(await page.evaluate(() => { getSelection().removeAllRanges(); return window.find('const retainedLine118 = 12;', false, false, true); }), true);
  await page.evaluate(() => getSelection().removeAllRanges());
  await pane.evaluate(el => { el.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[data-test-pane="0"] .source-inline-code').dataset.sourceRendering === 'full');
  assert.equal(await code.locator('.source-inline-line').count(), 45, 'expanded state survives offscreen reclamation');
  await card.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.match(await page.evaluate(() => window.copiedCode), /const retainedLine150 = 44;|const retainedLine149 = 43;/);
  await page.locator('#outside').evaluate(el => el.focus({ preventScroll: true }));
  await code.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.pinnedSelection = selection.toString(); window.selectedCodeNode = el.firstChild;
  });
  await pane.evaluate(el => { el.scrollTop = el.scrollHeight; }); await quiet();
  assert.equal(await code.getAttribute('data-source-rendering'), 'full', 'offscreen selected code is not rewritten');
  assert.equal(await page.evaluate(() => getSelection().toString() === window.pinnedSelection), true);
  await page.evaluate(() => getSelection().removeAllRanges()); await quiet();
  assert.equal(await code.getAttribute('data-source-rendering'), 'compact');
  // Select compact text, then scroll it into view: do not destroy a live range.
  await code.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el.firstChild);
    getSelection().addRange(range); window.pinnedSelection = getSelection().toString();
  });
  await pane.evaluate(el => { el.scrollTop = 0; }); await quiet();
  assert.equal(await code.getAttribute('data-source-rendering'), 'compact');
  assert.equal(await page.evaluate(() => getSelection().toString() === window.pinnedSelection), true);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelector('[data-test-pane="0"] .source-inline-code').dataset.sourceRendering === 'full');
  // Hidden panes reclaim decoration but preserve source/unsent draft state.
  await page.locator('#hide').click(); await quiet();
  assert.equal(await page.locator('[data-test-pane="1"] [data-retained-message] [data-source-rendering="full"]').count(), 0);
  await page.locator('#hide').click();
  await page.waitForFunction(() => document.querySelector('[data-test-pane="1"] [data-retained-message] [data-source-rendering="full"]'));
  assert.equal(await draft(1).inputValue(), 'unsent draft 1');
  await page.locator('#toggle').click(); await quiet();
  assert.equal(await page.evaluate(() => window.previewObservers.live), 0, 'all observers released on final owner unmount');
  await page.locator('#toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-source-rendering="compact"]').length > 3900);
  assert.ok((await metrics()).observers.live <= 3, 'remount does not leak observers');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ verified: true, small, large, fullGeometry, compactGeometry,
    checks: 'two 200→2000 histories, viewport-bound rich nodes, text/find/selection/focus, expansion/copy, geometry/anchor, hide/show/drafts, cleanup/remount', errors, denied }));
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(output, { recursive: true, force: true });
}
