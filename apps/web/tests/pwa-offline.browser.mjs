// Real service-worker lifecycle and offline navigation; entirely isolated origin.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const worker = await readFile(new URL('../public/sw.js', import.meta.url));
let mutations = 0;
const server = createServer((req, res) => {
  if (req.method !== 'GET') mutations++;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', req.url === '/sw.js' || req.url === '/asset.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  res.end(req.url === '/sw.js' ? worker : req.url === '/asset.js' ? '/* synthetic asset */' : '<!doctype html><title>Online fixture</title><main>Online</main>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await (await caches.open('unrelated-app')).put('/other.js', new Response('unrelated'));
    await (await caches.open('agentopsdeck-shell-v5')).put('/', new Response('stale authenticated shell'));
    localStorage.setItem('fixture-draft', 'synthetic saved draft');
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  assert.deepEqual(await page.evaluate(() => caches.keys()), ['unrelated-app'], 'activate preserves other applications');
  assert.equal(await page.evaluate(async () => (await fetch('/asset.js')).text()), '/* synthetic asset */');
  await page.waitForFunction(async () => !!await (await caches.open('agentopsdeck-shell-v6')).match('/asset.js'));
  await context.setOffline(true);
  assert.equal(await page.evaluate(async () => (await fetch('/asset.js')).text()), '/* synthetic asset */');
  for (const path of ['/api/private', '/events', '/other.js']) {
    assert.equal(await page.evaluate(async path => { try { await fetch(path); return false; } catch { return true; } }, path), true, `no offline fallback for ${path}`);
  }
  assert.equal(await page.evaluate(async () => { try { await fetch('/api/command', { method: 'POST', body: 'synthetic' }); return false; } catch { return true; } }), true);
  const offline = await page.goto(origin + '/');
  assert.equal(offline.status(), 503); assert.equal(offline.headers()['cache-control'], 'no-store');
  await page.getByRole('heading', { name: 'AgentOpsDeck 暂时离线' }).waitFor();
  assert.equal(await page.locator('script').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-draft')), 'synthetic saved draft');
  await context.setOffline(false);
  await page.waitForTimeout(300); assert.equal(await page.title(), 'AgentOpsDeck · Offline', 'no automatic replay/reload');
  await page.getByRole('link', { name: '重新连接 / Retry' }).click(); await page.waitForFunction(() => document.title === 'Online fixture');
  assert.equal(mutations, 0, 'no queued commands reach server on reconnect');
  await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHES' }));
  await page.waitForFunction(async () => JSON.stringify(await caches.keys()) === JSON.stringify(['unrelated-app']));
  assert.equal(await page.evaluate(async () => (await (await caches.open('unrelated-app')).match('/other.js')).text()), 'unrelated');
  await context.close();
  console.log('PASS real PWA: scoped activate/clear, static fallback, no API/event/foreign-cache fallback, offline 503/mobile/retry, preserved draft, no command replay');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
