// Synthetic API only; validates the real panel, clocks and visibility gates.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const calls = [], errors = []; let wrong = false, pending;
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    window.fixtureVisible = true; window.fixtureOnline = true;
    Object.defineProperty(document, 'hidden', { get: () => !window.fixtureVisible });
    Object.defineProperty(navigator, 'onLine', { get: () => window.fixtureOnline });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); assert.equal(url.origin, origin);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(route.request().method(), 'GET'); calls.push(url.pathname);
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/sources')) return json({ sources: [
      { kind: 'hub', key: 'hub', id: 'hub_one', label: 'Hub' },
      { kind: 'connector', key: 'remote', id: 'node_one', label: 'Connector' },
    ] });
    const connector = url.pathname.endsWith('/connectors/remote');
    const sample = { version: 1, source: { kind: connector ? 'connector' : 'hub', id: wrong ? 'wrong' : connector ? 'node_one' : 'hub_one' },
      sampledAt: Date.now(), scope: 'process', cpu: { percent: null, cores: 1 },
      memory: { usedBytes: connector ? 2097152 : 1048576, totalBytes: null, availableBytes: null }, volumes: [] };
    if (connector && pending) { const p = pending; pending = undefined; await p; }
    return json(sample).catch(() => {});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date() });
  const advance = async ms => { for (let n = 0; n < ms; n += 500) { await page.clock.runFor(Math.min(500, ms - n)); await pause(10); } };
  const wait = async fn => { for (let i = 0; i < 120 && !await fn(); i++) await pause(50); assert.ok(await fn()); };
  const samples = () => calls.filter(p => !p.endsWith('/sources')).length;
  await page.goto(`${origin}/tests/fixtures/system-metrics.html`);
  await advance(10000); assert.equal(calls.length, 0, 'collapsed panel must not subscribe');
  await page.getByRole('button', { name: 'Toggle metrics' }).click();
  await wait(async () => (await page.locator('dl').textContent().catch(() => ''))?.includes('1 MiB'));
  assert.equal(samples(), 1); await advance(10000); assert.equal(samples(), 1, 'manual default');
  await page.getByRole('checkbox').check(); await advance(5000); assert.ok(samples() >= 2);
  const hiddenStart = samples();
  await page.evaluate(() => { window.fixtureVisible = false; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(20000); assert.equal(samples(), hiddenStart, 'hidden must not poll');
  await page.evaluate(() => { window.fixtureVisible = true; window.fixtureOnline = false; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(10000); assert.equal(samples(), hiddenStart, 'offline must not poll');
  await page.evaluate(() => { window.fixtureOnline = true; window.dispatchEvent(new Event('online')); });
  await wait(() => samples() > hiddenStart);
  await page.getByRole('checkbox').uncheck();
  let finish; pending = new Promise(r => { finish = r; });
  await page.getByRole('combobox').selectOption(JSON.stringify(['connector', 'remote']));
  await wait(() => calls.at(-1)?.endsWith('/connectors/remote'));
  await page.getByRole('combobox').selectOption(JSON.stringify(['hub', 'hub'])); finish();
  await wait(async () => (await page.locator('dl').textContent().catch(() => ''))?.includes('1 MiB'));
  assert.ok(!(await page.locator('dl').innerText()).includes('2 MiB'), 'late old source cannot replace current');
  wrong = true;
  await page.getByRole('combobox').selectOption(JSON.stringify(['connector', 'remote']));
  await wait(() => page.getByRole('alert').isVisible()); assert.equal(await page.locator('dl').count(), 0, 'mismatched identity must not display');
  await page.getByRole('button', { name: 'Toggle metrics' }).click(); const finalCount = calls.length;
  await advance(20000); assert.equal(calls.length, finalCount); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified: true, samples: samples(), hidden: true, offline: true, sourceFence: true, collapsed: true }));
  await context.close();
} finally { await browser?.close(); await server.close(); }
