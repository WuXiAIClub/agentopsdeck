// Real message renderers and a locally generated playable WebM. No production API.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-message-video-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output,
    rollupOptions: { input: join(root, 'tests/fixtures/message-video.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const bytes = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 ? '#0284c7' : '#0f172a'; ctx.fillRect(0, 0, 160, 90);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }));
  assert.ok(bytes.length > 100);
  let mediaRequests = 0, invalidMedia = false;
  const denied = [], errors = [];
  const hubPath = `/api/hub/v1/sessions/c%3As/messages/m/media/${'b'.repeat(64)}`;
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== 'GET') { denied.push(url.href); return route.abort(); }
    if (url.pathname === '/api/artifacts/abc123' || url.pathname === hubPath) {
      mediaRequests++; return route.fulfill({ contentType: 'video/webm', body: invalidMedia ? Buffer.from('invalid-video') : bytes });
    }
    if (url.pathname.startsWith('/api/')) { denied.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/tests/fixtures/message-video.html`);
  const pane = page.locator('[data-workspace-pane]');
  const trigger = pane.getByRole('button', { name: 'Video preview 演示 video.webm' }).first();
  const popup = page.locator('.message-video-popup');
  await trigger.waitFor(); await page.waitForTimeout(300);
  assert.equal(mediaRequests, 0, 'collapsed messages make no video requests');
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(await pane.locator('.message-video-trigger').count(), 3, 'inline link and two authorized attachments');
  const initialHeight = (await pane.boundingBox()).height;
  await page.getByRole('textbox', { name: 'Draft' }).fill('draft intact');
  await trigger.hover(); await page.mouse.move(1150, 800); await page.waitForTimeout(300);
  assert.equal(mediaRequests, 0, 'passing over the trigger does not fetch media');
  await trigger.hover(); await popup.waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  assert.equal(await page.locator('video').evaluate(v => v.paused && !v.autoplay && v.videoWidth === 160), true, 'real WebM decodes without autoplay');
  await page.screenshot({ path: '/tmp/agentopsdeck-message-video-narrow.png' });
  assert.equal((await pane.boundingBox()).height, initialHeight, 'top-layer preview does not expand narrow card');
  assert.equal(await page.getByRole('textbox', { name: 'Draft' }).evaluate(el => el === document.activeElement), true, 'hover does not steal draft focus');
  await popup.hover(); await page.waitForTimeout(300); assert.equal(await popup.count(), 1, 'pointer can cross into preview');
  await page.mouse.move(1150, 800); await popup.waitFor({ state: 'detached' });
  assert.equal(await page.locator('video').count(), 0);
  await trigger.click(); await popup.waitFor(); await page.mouse.move(1150, 800); await page.waitForTimeout(300);
  assert.equal(await popup.count(), 1, 'click pins preview');
  await page.locator('video').evaluate(async v => { v.muted = true; v.loop = true; await v.play(); });
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0);
  await page.locator('video').evaluate(v => { window.closedVideo = v; });
  // A streaming message update must not remount the current player.
  await page.locator('#refresh').evaluate(el => el.click());
  assert.equal(await page.locator('video').evaluate(v => v === window.closedVideo), true);
  await popup.getByRole('button', { name: 'Close', exact: true }).click();
  await popup.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.closedVideo.paused && !window.closedVideo.hasAttribute('src')), true, 'close releases the playing decoder');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'close returns focus without reopening');
  await page.keyboard.press('Enter'); await popup.waitFor();
  await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' });
  // A codec/link failure stays actionable and does not trigger retries.
  invalidMedia = true;
  await trigger.click();
  await popup.getByText('This video codec is not supported by the browser, or the playback link expired. Refresh and try again.').waitFor();
  const failedRequests = mediaRequests; await page.waitForTimeout(350); assert.equal(mediaRequests, failedRequests);
  await page.keyboard.press('Escape'); invalidMedia = false;
  await trigger.click(); await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await page.evaluate(() => document.dispatchEvent(new Event('scroll'))); await popup.waitFor({ state: 'detached' });
  // Switching between attachment owners leaves only one video mounted.
  await trigger.click();
  const hubTrigger = pane.getByRole('button', { name: 'Video preview Connector video.webm' });
  await hubTrigger.evaluate(el => el.focus()); await page.waitForTimeout(250);
  assert.equal(await page.locator('video').count(), 1);
  assert.ok((await page.locator('video').getAttribute('src')).includes('/api/hub/v1/sessions/'));
  await page.getByRole('textbox', { name: 'Draft' }).click(); await popup.waitFor({ state: 'detached' });
  await page.locator('#resize').click(); await trigger.click();
  let rect = await popup.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= 1200 && rect.y + rect.height <= 850);
  await page.setViewportSize({ width: 1000, height: 700 }); await popup.waitFor({ state: 'detached' });
  await trigger.click();
  await page.locator('#mount').evaluate(el => el.click()); await popup.waitFor({ state: 'detached' });
  await page.locator('#mount').click();
  await trigger.click(); await page.locator('#scope').evaluate(el => el.click());
  await popup.waitFor({ state: 'detached' }); assert.equal(await trigger.isDisabled(), true, 'account change disables stale metadata');
  assert.equal(await page.getByRole('textbox', { name: 'Draft' }).inputValue(), 'draft intact');
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  // Independent account/page. Route only this isolated fixture and its authorized attachment.
  await touch.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
    if (url.pathname === '/api/artifacts/abc123') return route.fulfill({ contentType: 'video/webm', body: bytes });
    if (url.pathname.startsWith('/api/')) { denied.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  const mobile = await touch.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(`${origin}/tests/fixtures/message-video.html`);
  await mobile.locator('[data-mobile] .message-video-trigger').tap();
  await mobile.locator('video').waitFor(); rect = await mobile.locator('.message-video-popup').boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 844);
  assert.equal(await mobile.locator('video').evaluate(v => v.paused && !v.autoplay && v.playsInline), true);
  await mobile.screenshot({ path: '/tmp/agentopsdeck-message-video-mobile.png' });
  await mobile.locator('.message-video-heading button').tap(); assert.equal(await mobile.locator('video').count(), 0);
  await mobile.locator('[data-mobile] .message-video-trigger').tap();
  await mobile.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required')));
  await mobile.locator('video').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ passed: true, realWebMBytes: bytes.length, mediaRequests, checks: 'desktop/mobile/240px/wide/inline/hover/pin/play/Escape/close/unmount/refresh/account/scroll/resize/error/no-retry/no-eager-requests' }));
  await touch.close(); await context.close();
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
