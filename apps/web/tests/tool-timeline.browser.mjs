// Real React + production CSS, synthetic loopback detail API. No live sessions.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'tool-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__tools')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/tool-timeline.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
   for (const attached of [false, true]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [], rejected = [], reads = [], held = [];
    await context.addInitScript(() => {
      window.copiedToolText = null;
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedToolText = text; } } });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET') { rejected.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const match = url.pathname.match(/\/sessions\/([^/]+)\/messages\/([^/]+)$/);
      if (!match) { rejected.push(url.pathname); return route.abort(); }
      const sessionKey = decodeURIComponent(match[1]), id = decodeURIComponent(match[2]);
      reads.push(`${sessionKey}/${id}`);
      if (id === 'delayed') { held.push(route); return; }
      return route.fulfill({ json: { updatedAt: 1, message: { id, sessionKey, role: 'tool', createdAt: 1,
        text: id === 'empty' ? '' : `${sessionKey} exact full detail`, status: 'sent' } } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const aborted = [];
    page.on('requestfailed', request => { if (request.url().includes('/messages/delayed')) aborted.push(request.url()); });
    await page.goto(`${origin}/__tools${attached ? '?attached=1' : ''}`);
    const measure = async stage => {
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.locator('.desktop-tool-timeline').evaluate(root => {
        const base = document.querySelector('main').getBoundingClientRect();
        const box = node => {
          const rect = node.getBoundingClientRect();
          return [rect.x - base.x, rect.y - base.y, rect.width, rect.height];
        };
        return { elements: (root.closest('.desktop-attached-tools') ?? root).querySelectorAll('*').length + 1,
          box: box(root), text: root.innerText,
          parts: [...root.querySelectorAll('.desktop-tool-chip, .desktop-tool-link, .desktop-tool-detail')].map(node => ({
            className: node.className, text: node.textContent, label: node.getAttribute('aria-label'), box: box(node),
          })) };
      });
      console.log(JSON.stringify({ kind: 'tool-dom', viewport: viewport.width, attached, stage, ...metrics }));
    };
    const first = page.locator('.desktop-tool-chip[aria-controls$="-same-id"]');
    await first.waitFor();
    await measure('closed');
    const desktopList = page.getByRole('list', { name: 'Tool execution sequence', exact: true }).and(page.locator('.desktop-tool-track'));
    assert.equal(await desktopList.count(), 1);
    assert.equal(await desktopList.getByRole('listitem').count(), 8);
    assert.equal(await desktopList.evaluate(node => node.matches('.desktop-tool-timeline')), true, 'timeline and accessible list share one element');
    assert.equal(await desktopList.locator('.desktop-tool-track, .desktop-tool-timeline').count(), 0, 'no nested track wrappers');
    assert.equal(await desktopList.evaluate(node => node.classList.contains('desktop-attached-tools')), attached, 'attached presentation needs no outer wrapper');
    assert.equal(await page.locator('.desktop-tool-chip').filter({ hasText: 'Tool:' }).count(), 0, 'tool names have no redundant prefix');
    const compact = page.locator('.desktop-tool-chip--compact').first();
    assert.equal(await compact.innerText(), '1', 'older tools display only their index');
    assert.equal(await compact.locator('.desktop-tool-compact-label').count(), 0);
    assert.equal(await compact.locator('.desktop-tool-step').evaluate(node => getComputedStyle(node).borderWidth), '0px', 'compact index has no circle');
    assert.match(await compact.getAttribute('aria-label'), /Click to inspect/, 'numeric tools retain accessible names and detail access');
    const mobileCompact = page.locator('.mobile-tool-pill--abbreviated').first();
    assert.equal(await mobileCompact.innerText(), '1', 'mobile older tools also show only an index');
    // Existing mobile pills (including abbreviated ones) retain their 1px
    // outline. Desktop-only performance work must not restyle them to fit a
    // stale zero-border expectation.
    assert.equal(await mobileCompact.evaluate(node => getComputedStyle(node).borderWidth), '1px');
    await mobileCompact.click();
    await page.locator('.mobile-tool-strip-detail').getByText('Mobile tool 0', { exact: true }).waitFor();
    await mobileCompact.click();
    const timedLine = page.locator('.desktop-tool-link--timed').first();
    if (attached) {
      // This fixture's sessionpane is capped at 768px: compact cards replace
      // the two timing arms with one bounded line and hide the timing label.
      assert.equal(Math.round((await timedLine.boundingBox()).width), 16);
      assert.deepEqual(await timedLine.evaluate(node => ['::before', '::after'].map(pseudo => getComputedStyle(node, pseudo).content)), ['none', 'none']);
    } else {
      const arms = await timedLine.evaluate(node => ['::before', '::after'].map(pseudo => getComputedStyle(node, pseudo).transform));
      assert.deepEqual(arms, ['matrix(0.95, 0, 0, 1, 0, 0)', 'matrix(0.95, 0, 0, 1, 0, 0)'], 'wide/non-container timing arms retain their geometry');
    }
    assert.deepEqual(reads, [], 'tool details must not be fetched before expansion');
    await first.click();
    const detail = page.locator('.desktop-tool-detail');
    await detail.getByText('local:alpha exact full detail', { exact: true }).waitFor();
    await measure('open');
    await detail.getByRole('button', { name: 'Copy exec_command result', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedToolText), 'local:alpha exact full detail');
    assert.equal(await page.evaluate(() => window.find('local:alpha exact full detail')), true, 'open tool text remains browser-findable');
    await detail.locator('pre').evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (selection.toString() !== 'local:alpha exact full detail') throw Error('tool text selection changed');
      selection.removeAllRanges();
    });
    const panel = await detail.elementHandle();
    await page.getByRole('button', { name: 'Refresh projection' }).click();
    await page.getByRole('button', { name: 'Toggle older tool' }).click();
    assert.equal(await panel.evaluate(node => node === document.querySelector('.desktop-tool-detail')), true, 'projection refresh/prepend preserves open detail DOM');
    await first.click(); await first.click();
    assert.equal(reads.filter(value => value === 'local:alpha/same-id').length, 1, 'opening cached result does not refetch');
    await page.locator('.desktop-tool-chip[aria-controls$="-empty"]').click();
    await page.waitForFunction(() => document.querySelector('.desktop-tool-detail pre')?.textContent === '');
    await detail.getByRole('button', { name: 'Copy exec_command result', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedToolText), '', 'copy preserves a genuinely empty result instead of stale preview');
    await page.locator('.desktop-tool-chip[aria-controls$="-empty"]').click();
    await page.locator('.desktop-tool-chip[aria-controls$="-empty"]').click();
    assert.equal(reads.filter(value => value === 'local:alpha/empty').length, 1, 'empty detail is cached');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.desktop-tool-chip[aria-controls$="-empty"]') === document.activeElement);
    assert.equal(await page.locator('.desktop-tool-chip[aria-controls$="-empty"]').evaluate(node => node === document.activeElement), true);
    assert.equal(await detail.count(), 0, 'Escape closes the detail, not merely focuses its chip');
    // Dispatch a quick close/open pair inside one browser task, then ensure no
    // stale scheduled focus action overrides the last committed panel.
    await first.click();
    await first.evaluate(node => { node.click(); queueMicrotask(() => node.click()); });
    await page.waitForFunction(() => document.activeElement?.classList.contains('desktop-tool-detail'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await detail.evaluate(node => node === document.activeElement), true, 'rapid reopen keeps focus on the latest detail');
    // Idle-cache pressure must never remove the currently open DOM/text/focus.
    const activePanel = await detail.elementHandle();
    await page.evaluate(() => { for (let i = 0; i < 80; i++) window.fixtureIdleCache.put(`closed-${i}`, 'x'.repeat(120)); });
    const idleBudget = await page.evaluate(() => window.fixtureIdleCache.stats());
    assert.ok(idleBudget.entries <= 2 && idleBudget.bytes <= 512);
    assert.equal(await activePanel.evaluate(node => node === document.querySelector('.desktop-tool-detail') && node === document.activeElement), true);
    await detail.getByText('local:alpha exact full detail', { exact: true }).waitFor();
    await first.click();
    for (const id of ['compact-0', 'compact-1']) {
      const chip = page.locator(`.desktop-tool-chip[aria-controls$="-${id}"]`);
      await chip.click(); await detail.getByText('local:alpha exact full detail', { exact: true }).waitFor();
      await chip.click();
    }
    await first.click();
    await detail.getByText('local:alpha exact full detail', { exact: true }).waitFor();
    assert.equal(reads.filter(value => value === 'local:alpha/same-id').length, 2, 'evicted closed detail refetches on explicit reopen');
    assert.equal(await page.locator('.desktop-tool-timeline').getAttribute('data-history-tool-layout'), 'active');
    await first.click();
    assert.equal(await page.locator('.desktop-tool-timeline').getAttribute('data-history-tool-layout'), 'stable');
    await page.locator('.desktop-tool-chip[aria-controls$="-delayed"]').click();
    await page.waitForFunction(() => document.querySelector('.desktop-tool-detail')?.textContent.includes('Loading tool detail'));
    assert.equal(held.length, 1);
    await page.getByRole('button', { name: 'Switch session' }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent.startsWith('beta:'));
    assert.equal(await detail.count(), 0, 'switching session clears prior expansion');
    await first.click();
    await detail.getByText('local:beta exact full detail', { exact: true }).waitFor();
    await held.shift().fulfill({ json: { message: { text: 'STALE SECRET', id: 'delayed' }, updatedAt: 1 } }).catch(() => {});
    assert.equal(aborted.length, 1, 'session switch aborts outstanding detail request');
    assert.equal(await page.getByText('STALE SECRET').count(), 0);
    assert.equal(reads.filter(value => value === 'local:beta/same-id').length, 1, 'same message ID in another session has a separate cache');
    const chipBox = await first.boundingBox();
    assert.ok(chipBox.height <= (viewport.width >= 700 && viewport.width < 1280 ? 29 : 33), `compact tool chip height ${chipBox.height}`);
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await detail.getByRole('button', { name: '关闭工具结果详情' }).waitFor();
    await page.locator('.desktop-tool-chip[aria-controls$="-delayed"]').click();
    await page.waitForFunction(() => document.querySelector('.desktop-tool-detail')?.textContent.includes('加载'));
    await page.getByRole('button', { name: 'Toggle timeline' }).click();
    await held.shift().abort().catch(() => {});
    assert.equal(await detail.count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log(`tool timeline ${viewport.width}px attached=${attached} passed: refresh cache, copy/find/selection, empty result, isolation, abort, density, keyboard, language`);
    await page.goto(`${origin}/__tools?wrap=1${attached ? '&attached=1' : ''}`);
    const longChip = page.locator('.desktop-tool-chip').first();
    await longChip.click();
    const wrapped = page.locator('.desktop-tool-detail pre');
    assert.equal(await wrapped.textContent(), `First line\nSecond line\n${'unbroken'.repeat(100)}`);
    assert.equal(await wrapped.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'long result wraps without horizontal scrolling');
    assert.equal(await page.locator('.desktop-tool-label').first().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'long label is not truncated');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.desktop-tool-detail').getByRole('button', { name: /^Copy / }).click();
    assert.equal(await page.evaluate(() => window.copiedToolText), `First line\nSecond line\n${'unbroken'.repeat(100)}`);
    assert.deepEqual(errors, []);
    console.log(`tool timeline wrapping ${viewport.width}px attached=${attached} passed, exact copy retained`);
    await context.close();
   }
  }
} finally { await browser?.close(); await server.close(); }
