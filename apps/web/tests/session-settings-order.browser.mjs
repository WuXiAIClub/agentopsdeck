// Real desktop/mobile controls; synthetic HTTP/SSE, no native Agent or Hub.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
const sessionKey = 'local:Y29kZXg6c3ludGhldGlj';
const cursor = seq => `ce1_11111111-1111-4111-8111-111111111111:${seq}`;
function latch() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not reach expected request')), 10_000); })]); }
  finally { clearTimeout(timer); }
}
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) for (const action of ['title', 'reset']) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const errors = [], external = [], heldReads = [];
    const patchReady = latch(), firstReadReady = latch(), secondReadReady = latch();
    let patchRoute, patches = 0, blockReads = false, listReads = 0;
    let session = { sessionKey, envConnectionId: 'local', title: 'Initial settings', agentId: 'codex', source: 'codex',
      status: 'running', hasActiveRun: true, lastActiveAt: 1, model: 'synthetic-initial-model', thinkingLevel: 'low' };
    let seq = 10;
    const snapshot = () => ({ updatedAt: seq, revision: `list:${seq}`, viewKey: 'synthetic-view',
      sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready', cursor: cursor(seq), hiddenCount: 0, archivedCount: 0, pinnedCount: 0 }],
      groups: [{ agentId: 'codex', sessions: [session] }] });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (req.method() === 'PATCH') {
        assert.equal(url.pathname, `/api/sessions/${encodeURIComponent(sessionKey)}`);
        assert.equal(req.headers()['x-agentopsdeck-recovery-scope'], 'a'.repeat(64));
        assert.match(req.headers()['idempotency-key'], /^settings\./);
        if (patches === 1) {
          assert.deepEqual(req.postDataJSON(), { model: 'my-litellm-deployment/model-42', thinking: 'medium' }, 'native model ID must not gain a provider prefix');
          patches++;
          session = { ...session, model: req.postDataJSON().model }; seq++;
          const key = req.headers()['idempotency-key'];
          const result = { sessionKey, settings: { model: session.model, thinkingLevel: 'medium' } };
          return json({ ...result, command: { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: result } } });
        }
        assert.deepEqual(req.postDataJSON(), action === 'title' ? { title: 'Delayed obsolete title' } : { model: null, thinking: null });
        patches++; patchRoute = route; patchReady.release(); return;
      }
      assert.equal(req.method(), 'GET');
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname === '/api/hub/v1/sessions/state') {
        listReads++;
        if (blockReads) {
          heldReads.push(route);
          (heldReads.length === 1 ? firstReadReady : secondReadReady).release(); return;
        }
        return json(snapshot());
      }
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/hub/v1/connections/local/models/codex') return json({ models: [{ id: 'catalog-model', label: 'Environment model' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'reply', sessionKey, role: 'assistant',
        text: 'Current synthetic response', status: 'sent', createdAt: 1 }], updatedAt: seq, sourceCursor: cursor(seq) });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.settingsEvent = event => {
        for (const stream of streams) if (stream.readyState === 1) {
          stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id }));
        }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${sessionKey}"]`).click();
    await page.getByText('Current synthetic response', { exact: true }).waitFor();
    if (action === 'title') {
      await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Rename chat', exact: true }).fill('Delayed obsolete title');
      await page.getByRole('button', { name: 'Save chat title', exact: true }).click();
    } else await page.getByRole('button', { name: 'Reset model and thinking defaults', exact: true }).click();
    // The HTTP acknowledgement is withheld while another writer's newer
    // snapshot reaches the actual app and its hydration cache.
    await deadline(patchReady.promise);
    assert.ok(patchRoute);
    session = { ...session, title: 'Newer settings', model: 'synthetic-newer-model', thinkingLevel: 'high' }; seq = 20;
    await page.evaluate(({ key, watermark }) => window.settingsEvent({ id: 'newer-settings', type: 'session.updated',
      sessionKey: key, envConnectionId: 'local', remoteEventId: watermark, ts: 2, payload: {} }), { key: sessionKey, watermark: cursor(seq) });
    await page.waitForFunction(() => JSON.stringify(localStorage).includes('Newer settings'));
    await page.waitForFunction(() => document.querySelector('[aria-label="Session model"]')?.value === 'synthetic-newer-model');
    blockReads = true;
    // Start a same-URL GET before confirmation and leave it in flight. The
    // post-ACK refresh must create another read, not join this old one.
    await page.evaluate(async () => {
      const { api } = await import('/src/api.ts');
      window.beforeSettingsAck = api.sessionsState();
    });
    await deadline(firstReadReady.promise);
    const beforeAckReads = listReads;
    const key = patchRoute.request().headers()['idempotency-key'];
    const settings = action === 'title' ? { title: 'Delayed obsolete title' } : { model: null, modelProvider: null, thinkingLevel: null };
    const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { sessionKey, settings } } };
    const response = page.waitForResponse(res => res.request() === patchRoute.request());
    await patchRoute.fulfill({ json: { ...command.result.body, command } });
    await (await response).finished();
    if (action === 'reset') await page.getByText(/Settings reset accepted/).waitFor();
    await page.getByRole('heading', { name: 'Newer settings', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Session model', exact: true }).inputValue(), 'synthetic-newer-model');
    assert.equal(await page.getByRole('combobox', { name: 'Session thinking level', exact: true }).inputValue(), 'high');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('Delayed obsolete title')), false);
    await deadline(secondReadReady.promise);
    assert.ok(listReads > beforeAckReads, 'post-ACK refresh must bypass the pre-ACK coalesced read');
    // A later authoritative projection still updates every control normally.
    blockReads = false; session = { ...session, title: 'Latest projection', model: 'synthetic-latest-model', thinkingLevel: 'medium' }; seq = 30;
    for (const route of heldReads.splice(0)) await route.fulfill({ json: snapshot() });
    await page.getByRole('heading', { name: 'Latest projection', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Session model"]')?.value === 'synthetic-latest-model');
    assert.equal(patches, 1);
    const modelSelect = page.getByRole('combobox', { name: 'Session model', exact: true });
    assert.equal(await modelSelect.locator('option', { hasText: 'Environment model' }).count(), 1);
    await modelSelect.selectOption({ label: 'Custom model…' });
    const modelInput = page.getByRole('textbox', { name: 'Custom model ID', exact: true });
    await modelInput.fill('my-litellm-deployment/model-42');
    session = { ...session, title: 'Background projection', model: 'background-model' }; seq = 40;
    await page.evaluate(({ key, watermark }) => window.settingsEvent({ id: 'background-settings', type: 'session.updated',
      sessionKey: key, envConnectionId: 'local', remoteEventId: watermark, ts: 3, payload: {} }), { key: sessionKey, watermark: cursor(seq) });
    await page.getByRole('heading', { name: 'Background projection', exact: true }).waitFor();
    assert.equal(await modelInput.inputValue(), 'my-litellm-deployment/model-42', 'polling preserves the unsaved custom model draft');
    assert.equal(patches, 1, 'editing or polling must not silently apply a model');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(() => JSON.stringify(localStorage).includes('my-litellm-deployment/model-42'));
    assert.equal(patches, 2);
    assert.equal(await modelInput.inputValue(), 'my-litellm-deployment/model-42');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
  }
  console.log('Settings order: late title/reset ACK preserves newer UI/cache; fresh snapshot bypasses old GET; polling preserves custom model draft; exact native/LiteLLM ID applies once, desktop/mobile passed.');
} finally { await browser?.close(); await server.close(); }
