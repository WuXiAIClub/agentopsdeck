// Built UI only, synthetic responses; no credentials, providers or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-ui-closeout-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/ui-closeout.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [320, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = []; let held;
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (route.request().method() !== 'GET') { held = route; return; }
      if (url.pathname.includes('/weixin')) return route.fulfill({ json: { available: false, personalKey: false, binding: null } });
      return route.fulfill({ json: { passkeys: [], keyAccess: true } });
    });
    await page.goto(origin + '/tests/fixtures/ui-closeout.html');
    const opener = page.getByRole('button', { name: 'Browser and sign-in settings', exact: true });
    const dialog = page.locator('dialog.browser-settings');
    await opener.click(); await dialog.waitFor();
    for (const area of ['sessions', 'chat', 'notebooks']) {
      const slider = page.locator(`[data-font-preference="${area}"] input[type=range]`), min = area === 'notebooks' ? 70 : 75;
      assert.equal(await slider.getAttribute('min'), String(min));
      await slider.focus(); await slider.press('Home'); assert.equal(await slider.inputValue(), String(min));
      await slider.press('ArrowRight'); assert.equal(await slider.inputValue(), String(min + 1));
      await slider.press('Home');
    }
    await page.reload(); await opener.click();
    for (const area of ['sessions', 'chat', 'notebooks']) {
      assert.equal(await page.locator(`[data-font-preference="${area}"] input[type=range]`).inputValue(), area === 'notebooks' ? '70' : '75');
      assert.equal(await page.evaluate(area => document.documentElement.style.getPropertyValue(`--agentopsdeck-${area}-font-scale`), area), area === 'notebooks' ? '0.7' : '0.75');
    }
    const rect = await dialog.boundingBox();
    // Interior padding is not the backdrop; a drag starting inside is not a click outside.
    await page.mouse.click(rect.x + 3, rect.y + 3); assert.equal(await dialog.count(), 1);
    await page.mouse.move(rect.x + 3, rect.y + 3); await page.mouse.down(); await page.mouse.move(1, 1); await page.mouse.up(); assert.equal(await dialog.count(), 1);
    await page.mouse.click(1, 1); await dialog.waitFor({ state: 'detached' });
    await opener.click(); await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
    await page.getByRole('button', { name: 'Please wait…' }).waitFor();
    await page.mouse.click(1, 1); assert.equal(await dialog.count(), 1, 'busy operation blocks backdrop dismissal');
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1, 'busy operation blocks Escape');
    assert.ok(held); await held.fulfill({ status: 503, json: { error: 'synthetic_unavailable' } });
    await page.getByRole('button', { name: 'Add passkey', exact: true }).waitFor();
    await page.mouse.click(1, 1); await dialog.waitFor({ state: 'detached' });
    for (const scale of [.75, 1, 1.4]) {
      await page.evaluate(scale => document.documentElement.style.setProperty('--agentopsdeck-chat-font-scale', String(scale)), scale);
      const problems = await page.locator('[data-width]').evaluateAll(cards => cards.flatMap(card => {
        const nodes = [...card.querySelectorAll('.desktop-tool-node')], cardBox = card.getBoundingClientRect(), issues = [];
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i], dot = node.querySelector('.desktop-tool-step').getBoundingClientRect();
          const line = node.querySelector('.desktop-tool-link'); if (!line) continue;
          const box = line.getBoundingClientRect(), owner = node.getBoundingClientRect(), next = nodes[i + 1]?.querySelector('.desktop-tool-step').getBoundingClientRect();
          if (box.left < dot.right || box.right > owner.right + 1 || box.right > cardBox.right + 1 || Math.abs(box.y + box.height / 2 - dot.y - dot.height / 2) > 1) issues.push({ width: card.dataset.width, index: i, reason: 'bounds/center' });
          if (next && Math.abs(next.y - dot.y) < 1 && box.right > next.left) issues.push({ width: card.dataset.width, index: i, reason: 'next circle overlap' });
          if (getComputedStyle(line, '::before').content !== 'none' || getComputedStyle(line, '::after').content !== 'none') issues.push({ width: card.dataset.width, reason: 'old timed segments' });
        }
        return issues;
      }));
      assert.deepEqual(problems, [], `tool line geometry ${width}px scale ${scale}`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: persisted 75/70 minima, settings backdrop/drag/busy, tool lines 240/320/390/780 cards at 75/100/140%`);
    await context.close();
  }
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
