// Real desktop/mobile creation UI, synthetic Connector inventories and commands.
// No production requests and no native Agent execution.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const errors = [], discoveryCalls = [], creates = [];
    let mode = 'hold', release, created = false;
    const scope = 'a'.repeat(64), sessionKey = `remote:${Buffer.from('hermes:new').toString('base64url')}`;
    const connections = [
      { id: 'local', label: 'Workstation', kind: 'local', status: 'enabled', capabilities: [] },
      { id: 'remote', label: 'Laptop', kind: 'remote', status: 'enabled', capabilities: [] },
      { id: 'other', label: 'Server', kind: 'remote', status: 'enabled', capabilities: [] },
    ];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, 'external network forbidden');
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/auth/status') return route.fulfill({ json: { authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } } });
      if (url.pathname === '/api/hub/v1/shared/creation-environments') return route.fulfill({ json: {
        environments: [{ connectionId: 'shared', ownerUserId: 'another-owner', label: 'Shared server', kind: 'remote', status: 'enabled' }], nextCursor: null } });
      if (url.pathname === '/api/hub/v1/sessions/state') return route.fulfill({ json: {
        groups: created ? [{ agentId: 'hermes', sessions: [{ sessionKey, title: 'Remote Hermes', agentId: 'hermes', source: 'hermes', envConnectionId: 'remote', status: 'idle' }] }] : [],
        connections, sourceStates: [], updatedAt: 1, revision: String(created), viewKey: 'fixture',
      } });
      if (url.pathname === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'local-only', label: 'Local only' }] } });
      if (url.pathname === '/api/gateway/status') return route.fulfill({ json: { connected: true } });
      if (/\/connections\/[^/]+\/agents$/.test(url.pathname)) {
        discoveryCalls.push(url.pathname);
        assert.ok(!url.pathname.includes('shared'), 'shared inventory must stay permission scoped');
        const remote = url.pathname.includes('/remote/');
        const requestMode = mode;
        if (remote && requestMode === 'hold') await new Promise(resolve => { release = resolve; });
        return route.fulfill(remote && requestMode === 'fail' ? { status: 503, json: {} } : {
          json: { agents: remote ? [{ id: 'codex', label: 'Codex' }, { id: 'hermes', label: 'Hermes' }] : [{ id: 'codex', label: 'Codex' }] },
        }).catch(() => {});
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/verify')) return route.fulfill({ json: { connection: { id: 'remote', identityStatus: 'verified', nodeId: 'synthetic' } } });
      if (request.method() === 'POST' && url.pathname.endsWith('/sessions')) {
        creates.push(url.pathname);
        assert.equal(url.pathname, '/api/hub/v1/connections/remote/agents/hermes/sessions');
        created = true;
        const { idempotencyKey } = request.postDataJSON();
        return route.fulfill({ status: 201, json: { key: sessionKey, command: { id: idempotencyKey, key: idempotencyKey,
          state: 'accepted', createdAt: 1, updatedAt: 1, result: { status: 201, body: { key: sessionKey } } } } });
      }
      if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: [], historyWindow: { hasMore: false } } });
      if (url.pathname.endsWith('/queue')) return route.fulfill({ json: { items: [], updatedAt: 1 } });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      window.EventSource = class extends EventTarget { readyState = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${origin}/#/tab/sessions`);
    const open = async () => page.getByRole('button', { name: viewport.width < 600 ? 'New chat' : 'New session', exact: true }).first().click();
    await open();
    const dialog = page.getByRole('dialog', { name: 'Create new session' });
    const environment = dialog.getByLabel('Environment', { exact: true });
    const agent = dialog.getByLabel('Agent', { exact: true });
    await environment.selectOption('remote');
    await page.waitForFunction(() => document.querySelector('#new-session-agent')?.textContent.includes('Loading Agents'));
    assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    release(); mode = 'ok';
    await agent.selectOption('hermes');
    assert.deepEqual(await agent.locator('option').evaluateAll(options => options.map(option => option.value)), ['codex', 'hermes']);
    assert.equal(discoveryCalls.length, 1, 'discovery is not a polling loop');
    await dialog.getByLabel('Session name', { exact: true }).fill('Remote Hermes');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForFunction(key => decodeURIComponent(location.hash).includes(key), sessionKey);
    assert.equal(creates.length, 1);

    // Failed discovery must not silently fall back to historical/local agents.
    mode = 'fail'; created = false;
    await page.goto(`${origin}/#/tab/sessions`); await page.reload(); await open();
    await environment.selectOption('remote');
    await dialog.getByText('Could not load Agents from this environment.', { exact: false }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
    mode = 'ok'; await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await agent.selectOption('hermes');

    // An old Laptop response cannot populate Server or a shared environment.
    await environment.selectOption('other'); await agent.selectOption('codex');
    mode = 'hold'; release = undefined;
    await environment.selectOption('remote');
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    await environment.selectOption('other'); release();
    await agent.selectOption('codex');
    assert.deepEqual(await agent.locator('option').evaluateAll(options => options.map(option => option.value)), ['codex']);
    await environment.selectOption(JSON.stringify(['another-owner', 'shared']));
    assert.deepEqual(await agent.locator('option').evaluateAll(options => options.map(option => option.value)), ['codex']);
    await environment.selectOption('local');
    assert.ok(!(await agent.textContent()).includes('Hermes'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport: viewport.width, remoteHermesCreated: true, retry: true, staleResponseFenced: true, sharedRestricted: true, pageErrors: errors }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
