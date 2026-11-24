// Real caption components with controlled resource titles; no backend or writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { assertOverflowStable } from './caption-overflow-stability.mjs';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-caption-names-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/caption-names.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/tests/fixtures/caption-names.html`);
  for (const kind of ['taskboard', 'notebook']) {
    const card = page.locator(`[data-case=${kind}]`), caption = card.locator('.session-pane-caption');
    await caption.waitFor();
    const check = async width => {
      await card.evaluate((el, width) => el.style.setProperty('--card-width', `${width}px`), width);
      await page.waitForTimeout(150);
      const result = await caption.evaluate(el => {
        const title = el.querySelector('.session-pane-drag-title'), grip = el.firstElementChild.getBoundingClientRect();
        const rect = title.getBoundingClientRect(), toolbar = el.querySelector('.caption-overflow').getBoundingClientRect();
        const text = title.querySelector('input,h2'), range = document.createRange();
        const style = getComputedStyle(text), canvas = document.createElement('canvas').getContext('2d');
        canvas.font = style.font;
        range.selectNodeContents(text);
        const intrinsic = text.tagName === 'INPUT' ? canvas.measureText(text.value).width : range.getBoundingClientRect().width;
        return { width: rect.width, intrinsic, leftGap: rect.left - grip.right, gap: toolbar.left - rect.right,
          right: el.getBoundingClientRect().right - toolbar.right, overflow: el.scrollWidth - el.clientWidth };
      });
      assert.ok(result.leftGap >= 0 && result.leftGap <= 4.1, JSON.stringify(result));
      assert.ok(result.right >= 3 && result.right <= 7, JSON.stringify(result));
      assert.ok(result.overflow <= 1, JSON.stringify(result));
      const controls = await caption.evaluate(el => [...el.querySelectorAll('button')].filter(button =>
        button.getBoundingClientRect().width && !button.closest('[data-caption-hidden]')).map(button => {
        const rect = button.getBoundingClientRect(), icon = button.querySelector('svg')?.getBoundingClientRect(), style = getComputedStyle(button);
        return { width: rect.width, height: rect.height, padding: style.padding, iconWidth: icon?.width, iconHeight: icon?.height };
      }));
      for (const control of controls) {
        assert.equal(control.width, controls[0].width, `uniform caption button width: ${JSON.stringify(controls)}`);
        assert.equal(control.height, controls[0].height, 'uniform caption button height');
        assert.equal(control.padding, '0px');
        assert.equal(control.iconWidth, 15);
        assert.equal(control.iconHeight, 15);
      }
      assert.equal(await caption.locator('.caption-overflow-content').evaluate(el => getComputedStyle(el).gap), '3px');
      if (width >= 640) {
        assert.ok(result.width >= result.intrinsic, `full ${kind} title: ${JSON.stringify(result)}`);
        assert.ok(result.gap >= 65, `three icon separation: ${JSON.stringify(result)}`);
      } else assert.ok(result.width > width * .7, JSON.stringify(result));
      if (await caption.locator('.caption-overflow').getAttribute('data-collapsed') === 'true') {
        await assertOverflowStable(caption, caption.getByRole('button', { name: 'Pane tools', exact: true }));
      }
    };
    for (const width of [1000, 800, 640, 360, 240]) await check(width);
    await card.getByRole('button', { name: 'External rename' }).click();
    await check(800);
    if (kind === 'taskboard') {
      await card.getByRole('textbox', { name: 'Board name' }).fill('输入时动态增长的新标题 New typed title');
      await check(800);
      await card.getByRole('textbox', { name: 'Board name' }).fill('短标题');
      await page.waitForTimeout(150);
      assert.ok(await caption.locator('.session-pane-drag-title').evaluate(el => el.clientWidth < 70));
    }
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/agentopsdeck-title-first-resources.png' });
  const touch = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  await touch.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await touch.goto(`${origin}/tests/fixtures/caption-names.html`);
  for (const kind of ['taskboard', 'notebook']) {
    const card = touch.locator(`[data-case=${kind}]`), caption = card.locator('.session-pane-caption');
    await card.evaluate(el => el.style.setProperty('--card-width', '360px'));
    await touch.waitForTimeout(150);
    const more = caption.getByRole('button', { name: 'Pane tools', exact: true });
    await assertOverflowStable(caption, more);
    await more.click();
    const sizes = await caption.locator('button[data-caption-hidden]').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
      return { width: rect.width, height: rect.height, icon: icon.width };
    }));
    assert.ok(sizes.length > 0);
    for (const size of sizes) assert.ok(size.width >= 44 && size.height >= 44 && size.icon === 15, JSON.stringify(size));
    await more.click();
  }
  await touch.close();
  console.log('PASS resource title alignment/full width/input and external renames/priority/More geometry and session-standard icon/button sizes at 240–1000px');
} finally {
  await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true });
}
