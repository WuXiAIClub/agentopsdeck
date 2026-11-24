import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ?? 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const scope = 'a'.repeat(64), otherScope = 'b'.repeat(64), fenceId = '11111111-1111-4111-8111-111111111111';
const admission = (state, extra = {}) => ({ state, boundary: 'admission_only', nativeQuiescent: false, ...extra });
const requests = [], receipts = new Map();
let current, loseReply, unavailableReceipt, interrupted, invalidStatus, heldStatus, statusWaiter, browser, server;
const posts = () => requests.filter(request => request.method === 'POST');
server = await createServer({ root, configFile: false, logLevel: 'error', plugins: [react(), tailwindcss(), {
  name: 'admission-maintenance-fixture', configureServer(instance) {
    instance.middlewares.use(async (request, response, next) => {
      if (request.url?.startsWith('/__admission')) {
        response.setHeader('content-type', 'text/html');
        response.end(await server.transformIndexHtml(request.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/admission-maintenance.fixture.tsx"></script></body></html>')); return;
      }
      if (!request.url?.startsWith('/api/')) return next();
      const path = new URL(request.url, 'http://synthetic.test').pathname;
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path, method: request.method, scope: request.headers['x-agentopsdeck-recovery-scope'], body });
      const respond = (code, value) => { response.statusCode = code; response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store'); response.end(JSON.stringify(value)); };
      if (request.headers['x-agentopsdeck-recovery-scope'] !== scope) return respond(403, { error: 'Synthetic account cannot maintain this node' });
      if (path === '/api/hub/v1/connections/original-node/maintenance/status' && request.method === 'GET') {
        if (heldStatus) { const snapshot = current; heldStatus = () => respond(200, snapshot); statusWaiter?.(); return; }
        return respond(200, invalidStatus ? { ...current, nativeQuiescent: true } : current);
      }
      const match = /^\/api\/hub\/v1\/connections\/original-node\/maintenance\/commands\/(pause|resume)(?:\/([^/]+))?$/.exec(path);
      if (!match) return respond(404, { error: 'No alternative target or command route' });
      const operation = match[1], key = match[2] ? decodeURIComponent(match[2]) : body?.idempotencyKey;
      if (request.method === 'GET' && match[2]) {
        if (unavailableReceipt) return respond(502, { error: 'Original receipt temporarily unavailable' });
        const command = receipts.get(JSON.stringify([operation, key]));
        return command ? respond(200, { command }) : respond(404, { error: 'Original receipt absent' });
      }
      if (request.method !== 'POST' || match[2] || !key) return respond(400, { error: 'Invalid fixture command' });
      if (operation === 'resume' && body.fenceId !== fenceId) return respond(409, { error: 'Original fence required' });
      current = admission(operation === 'pause' || interrupted ? 'paused' : 'released', { fenceId, ...(operation === 'resume' && interrupted ? { resumeInterrupted: true } : {}) });
      const command = { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: current } };
      receipts.set(JSON.stringify([operation, key]), command);
      if (loseReply) return respond(502, { error: 'Reply lost after original command completed' });
      respond(200, { ...current, command });
    });
  },
}], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    requests.length = 0; receipts.clear(); current = admission('released');
    loseReply = false; unavailableReceipt = false; interrupted = false; invalidStatus = false; heldStatus = undefined;
    const context = await browser.newContext({ viewport }), errors = [];
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    const controls = page.getByRole('region', { name: 'Connector admission maintenance', exact: true });
    const recovery = page.getByRole('region', { name: 'Connector maintenance recovery', exact: true });
    const refresh = controls.getByRole('button', { name: 'Refresh admission status', exact: true });
    const pause = controls.getByRole('button', { name: 'Pause new writes', exact: true });
    const resume = controls.getByRole('button', { name: 'Resume original fence', exact: true });
    await page.goto(`${origin}/__admission`);
    await controls.getByText('Admission state not loaded', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await pause.isDisabled(), true);
    await controls.getByText(/Running native work may continue/).waitFor();
    await refresh.click(); await controls.getByRole('status').filter({ hasText: /^released/ }).waitFor();
    await pause.click(); await controls.getByRole('status').filter({ hasText: /^paused/ }).waitFor();
    assert.deepEqual(Object.keys(posts()[0].body), ['idempotencyKey']);
    await resume.click(); await controls.getByRole('status').filter({ hasText: /^released/ }).waitFor();
    assert.equal(posts()[1].body.fenceId, fenceId);
    assert.notEqual(posts()[1].body.idempotencyKey, posts()[0].body.idempotencyKey);
    while (await recovery.getByRole('button', { name: 'Dismiss', exact: true }).count()) await recovery.getByRole('button', { name: 'Dismiss', exact: true }).first().click();

    loseReply = true; unavailableReceipt = true;
    await pause.click(); await controls.getByRole('alert').filter({ hasText: /Maintenance outcome unknown/ }).waitFor();
    const lost = posts().at(-1), postCount = posts().length;
    assert.equal(await recovery.getByRole('button', { name: 'Dismiss', exact: true }).count(), 0);
    const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
    assert.ok(storage.includes(lost.body.idempotencyKey)); assert.ok(!storage.includes(fenceId));
    assert.ok(!storage.includes('nativeQuiescent'));
    await page.reload(); await controls.getByText('Admission state not loaded', { exact: true }).waitFor();
    await recovery.getByText(/outcome unknown/).waitFor();
    assert.equal(posts().length, postCount);
    await refresh.click(); await controls.getByRole('status').filter({ hasText: /^paused/ }).waitFor();
    assert.equal(await resume.isDisabled(), true);
    assert.equal(posts().length, postCount);
    unavailableReceipt = false; loseReply = false;
    await recovery.getByRole('button', { name: 'Query original receipt', exact: true }).click();
    await recovery.getByText(/command completed/).waitFor();
    assert.equal(requests.at(-1).path, `${lost.path}/${encodeURIComponent(lost.body.idempotencyKey)}`);
    assert.equal(requests.at(-1).method, 'GET');
    interrupted = true;
    await resume.click(); await controls.getByRole('status').filter({ hasText: /resume interrupted; still paused/ }).waitFor();
    assert.equal(posts().length, postCount + 1);
    const interruptedKey = posts().at(-1).body.idempotencyKey;
    interrupted = false;
    await resume.click(); await controls.getByRole('status').filter({ hasText: /^released/ }).waitFor();
    assert.notEqual(posts().at(-1).body.idempotencyKey, interruptedKey);
    assert.equal(posts().at(-1).body.fenceId, fenceId);

    invalidStatus = true;
    await refresh.click(); await controls.getByRole('alert').filter({ hasText: /status unavailable/ }).waitFor();
    assert.equal(await pause.isDisabled(), true); assert.equal(await resume.isDisabled(), true);
    invalidStatus = false;
    const statusStarted = new Promise(resolve => { statusWaiter = resolve; });
    heldStatus = true; await refresh.click(); await statusStarted;
    await page.evaluate(value => window.admissionFixture.account(value), otherScope);
    await recovery.waitFor({ state: 'hidden' });
    await controls.getByText('Admission state not loaded', { exact: true }).waitFor();
    heldStatus(); heldStatus = undefined;
    assert.equal(await recovery.count(), 0);
    assert.equal(await pause.isDisabled(), true);
    await refresh.click(); await controls.getByRole('alert').filter({ hasText: /Synthetic account cannot maintain/ }).waitFor();
    await page.evaluate(value => window.admissionFixture.account(value), scope);
    await recovery.getByText('Saved Connector maintenance', { exact: true }).waitFor();
    assert.equal(await controls.getByRole('status').textContent(), 'Admission state not loaded');
    const beforeDeletedQuery = posts().length;
    await page.evaluate(() => window.admissionFixture.connection(false));
    await recovery.getByRole('button', { name: 'Query original receipt', exact: true }).first().click();
    await recovery.getByText(/native idle not verified/).first().waitFor();
    assert.equal(posts().length, beforeDeletedQuery);
    assert.equal(requests.at(-1).path, `${lost.path}/${encodeURIComponent(lost.body.idempotencyKey)}`);
    assert.equal(requests.filter(request => request.method === 'POST').every(request => request.scope === scope), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`admission actual controls/original receipts/unknown/reload/interrupted resume/account isolation/deleted target passed ${viewport.width}px`);
  }
} finally {
  if (typeof heldStatus === 'function') heldStatus();
  await browser?.close(); await server.close();
}
