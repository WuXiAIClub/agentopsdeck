// Built assets, read-only synthetic API. Never uses live accounts or services.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390]) for (const initialPage of ['Gateway', 'Users']) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
    const scripts = [], errors = [], forbidden = [];
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) { if (url.pathname.endsWith('.js')) scripts.push(url.pathname); return route.continue(); }
      if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
      const json = value => route.fulfill({ json: value });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'test-scope', passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [], connections: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname === '/api/hub/v1/me') return json({ userId: 'default', admin: true });
      if (url.pathname === '/api/hub/v1/connector-users') return json({ connections: [] });
      if (url.pathname.endsWith('/users')) return json({ users: [] });
      if (url.pathname.endsWith('/connections')) return json({ connections: [] });
      if (url.pathname.endsWith('/notebook')) return json({ items: [] });
      return route.fulfill({ status: 404, json: { error: 'fixture unavailable' } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Gateway', exact: true }).waitFor();
    assert.equal(scripts.some(path => /hub-connections-/.test(path)), false, 'management not requested on initial workspace');
    const before = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: initialPage, exact: true }).click();
    await page.getByText(initialPage === 'Gateway' ? 'Hub Connections' : 'Create Hub record', { exact: true }).waitFor();
    assert.equal(scripts.filter(path => /hub-connections-/.test(path)).length, 1);
    const firstOpenMs = await page.evaluate(start => performance.now() - start, before);
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByText('Create Hub record', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Gateway', exact: true }).click();
    await page.getByText('Hub Connections', { exact: true }).waitFor();
    assert.equal(scripts.filter(path => /hub-connections-/.test(path)).length, 1, 'same chunk reused on subsequent page entry');
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
    console.log(JSON.stringify({ width, initialPage, firstOpenMs, managementRequests: 1 }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
