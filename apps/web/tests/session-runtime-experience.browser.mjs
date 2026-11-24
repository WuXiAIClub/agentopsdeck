// Real app, synthetic APIs only: loading capabilities, active refresh, long Markdown.
import assert from 'node:assert/strict';
import { assertPreviewContrast } from './preview-contrast.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const key = 'local:hermes-fixture', path = '/project/report.md';
    const mediaUrl = `/api/hub/v1/sessions/${encodeURIComponent(key)}/messages/report/media/${'a'.repeat(64)}`;
    const markdown = ['# Long report', ...Array.from({ length: 193 }, (_, i) => `段落 ${i} **validated**`)].join('\n');
    let release, reads = 0, maxMessageChars = 100000;
    const gate = new Promise(resolve => { release = resolve; });
    const errors = [], external = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'hermes', sessions: [{ sessionKey: key,
        envConnectionId: 'local', source: 'hermes', agentId: 'hermes', title: 'Hermes runtime', status: 'running', hasActiveRun: true,
        runtime: { phase: 'running', sync: 'current', connection: 'connected' } }] }] });
      if (url.pathname.endsWith('/messages')) {
        reads++; await gate;
        return json({ limits: { maxMessageChars }, revision: String(reads), totalCount: 1, hiddenCount: 0, messages: [{ id: 'report', sessionKey: key,
          role: 'assistant', text: `[Progress report](${path}:1)`, createdAt: 1, media: [{ type: 'file', name: 'report.md', url: mediaUrl,
            sourceReference: { href: `${path}:1`, path, line: 1 } }] }] });
      }
      if (url.pathname === mediaUrl) return json({ path, line: 1, startLine: 1, totalLines: 194, modifiedAt: 1, text: markdown });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'hermes', name: 'Hermes' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const card = page.locator(`[data-session-card="${key}"]`);
    await card.waitFor();
    assert.equal(await card.locator('[data-runtime="hermes"]').getAttribute('data-runtime'), 'hermes');
    await card.click();
    await page.getByText(/Agent is working/).waitFor();
    assert.ok(reads > 0);
    assert.equal(await page.getByText(/This Connector currently allows/).count(), 0, 'unknown capability is not an old version');
    assert.equal(await page.locator('[data-latest-messages-loading]').count(), 0, 'background history loading never replaces run status');
    release();
    const preview = page.getByRole('region', { name: `Source preview ${path}:1`, exact: true });
    await preview.getByRole('heading', { name: 'Long report', exact: true }).waitFor();
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await assertPreviewContrast(preview.locator('.md-heading, .md-paragraph, .preview-mode-switch button'));
    }
    await preview.getByRole('button', { name: 'Raw', exact: true }).click();
    await assertPreviewContrast(preview.locator('.markdown-file-raw'));
    assert.match(await preview.innerText(), /段落 192/);
    await preview.getByRole('button', { name: 'Preview', exact: true }).click();
    assert.equal(await page.getByText(/This Connector currently allows/).count(), 0);
    // A confirmed legacy response still gives the real conservative limit.
    maxMessageChars = 20000;
    await page.reload();
    if (width < 700) await page.locator(`[data-session-card="${key}"]`).click();
    await page.getByText(/This Connector currently allows 20,000 characters/).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`PASS runtime/loading/194-line Markdown/legacy limits ${width}`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
