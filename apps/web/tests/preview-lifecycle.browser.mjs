// Actual components and browser fetch cancellation, isolated synthetic APIs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-preview-lifecycle-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output,
    rollupOptions: { input: join(root, 'tests/fixtures/preview-lifecycle.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const errors = [], denied = [], held = [], failed = [];
  const mediaPath = `/api/hub/v1/sessions/remote%3Alifecycle/messages/source/media/${'e'.repeat(64)}`;
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') { denied.push(url.origin); return route.abort(); }
    if (url.pathname === mediaPath) { held.push(route); return; }
    if (url.pathname.startsWith('/api/')) { denied.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (new URL(request.url()).pathname === mediaPath) failed.push(request); });
  await page.goto(`${origin}/tests/fixtures/preview-lifecycle.html`);
  const toggle = i => page.locator(`#owner-${i}`).click();
  const until = async predicate => {
    const end = Date.now() + 15_000;
    while (!predicate() && Date.now() < end) await page.waitForTimeout(25);
    assert.ok(predicate(), 'bounded network observation');
  };
  await until(() => held.length === 1);
  await page.getByRole('textbox', { name: 'Outside draft' }).fill('draft stays intact');
  await toggle(0); await page.waitForTimeout(150);
  assert.equal(failed.length, 0, 'other mounted owner keeps the shared request');
  await toggle(1); await until(() => failed.length === 1);
  assert.equal(await page.locator('[data-owner]').count(), 0);
  await toggle(0); await until(() => held.length === 2);
  const payload = { path: 'C:\\work\\preview.ts', line: 2, startLine: 1, totalLines: 2, modifiedAt: 1, text: 'fresh\nsource' };
  await held[1].fulfill({ json: payload });
  await page.locator('.source-inline-code').filter({ hasText: 'fresh' }).waitFor();
  // Deliver the old response even though fetch was aborted: it must stay inert.
  await held[0].fulfill({ json: { ...payload, text: 'obsolete\nsource' } });
  await toggle(1);
  await page.waitForFunction(() => document.querySelectorAll('.source-inline-code').length === 2);
  assert.equal(held.length, 2, 'completed source is reused by another owner');
  for (let cycle = 0; cycle < 10; cycle++) {
    await toggle(0); await toggle(1); await toggle(0); await toggle(1);
  }
  assert.equal(held.length, 2, 'completed cache survives ten complete close/reopen cycles');
  assert.ok((await page.locator('.source-inline-code').allTextContents()).every(text => text.includes('fresh') && !text.includes('obsolete')));
  assert.equal(await page.getByRole('textbox', { name: 'Outside draft' }).inputValue(), 'draft stays intact');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log(JSON.stringify({ passed: true, cycles: 10, requests: held.length, aborted: failed.length, errors, denied }));
  await context.close();
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
