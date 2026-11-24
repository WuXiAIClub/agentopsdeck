import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ?? 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const scopeA = 'a'.repeat(64), scopeB = 'b'.repeat(64), sessionId = 'node:c3ludGhldGlj';
const requests = [], pending = [], streams = new Set();
let status = 200, hold = false, resourceStatus = 200, holdResources = false, server, browser;
const resourcePath = '/api/hub/v1/shared/owner-a/connections/node/grants/broad/sessions';
const pendingResources = [];
const row = (id, policy, extra = {}) => ({ id, policy, ownerUserId: 'owner-a', connectionId: 'node', version: 1, nodeVersion: 1, availability: 'available', sessionId: null, ...extra });
const first = [
  row('exact', { runtime: 'codex', sessionKey: 'codex:synthetic', actions: ['messages:read'] }, { sessionId }),
  row('broad', { actions: ['sessions:read'] }),
  row('agent', { runtime: 'codex', agentId: 'synthetic-agent', actions: ['messages:read'] }),
  row('old', { runtime: 'codex', sessionKey: 'codex:old', actions: ['messages:read'] }, { availability: 'reauthorization_required' }),
  row('unreadable', { runtime: 'codex', sessionKey: 'codex:send-only', actions: ['messages:send'] }),
  row('long', { actions: ['sessions:read'] }, { ownerUserId: 'owner'.repeat(90), connectionId: 'node'.repeat(90), availability: 'disabled' }),
];
server = await createServer({ root, configFile: false, logLevel: 'error', plugins: [react(), tailwindcss(), {
  name: 'shared-directory-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/__shared')) {
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/shared-session-live.fixture.tsx"></script></body></html>')); return;
      }
      if (!req.url?.startsWith('/api/')) return next();
      const url = new URL(req.url, 'http://synthetic.test'), account = req.headers['x-agentopsdeck-recovery-scope'];
      requests.push({ path: url.pathname, query: url.search, method: req.method, account });
      const respond = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (url.pathname === '/api/hub/v1/me') return respond(200, { userId: account === scopeB ? 'member-b' : 'member-a', admin: false });
      if (url.pathname === '/api/hub/v1/notebooks') return respond(200, { items: [], nextCursor: null });
      if (url.pathname === '/api/hub/v1/shared/grants') {
        const body = { grants: account === scopeB ? [row('b', { actions: ['messages:read'] }, { ownerUserId: 'account-b-policy' })]
          : url.searchParams.has('after') ? [row('next', { actions: ['sessions:read'] }, { ownerUserId: 'second-page-owner' })] : first,
        nextCursor: account === scopeA && !url.searchParams.has('after') ? 'next-cursor' : null };
        if (hold) pending.push(() => respond(200, body)); else respond(status, status === 200 ? body : { error: 'denied or unavailable' });
        return;
      }
      if (url.pathname === resourcePath) {
        const body = { sessions: url.searchParams.has('after') ? [] : [
          { sessionKey: 'codex:synthetic', runtime: 'codex', sessionId },
          { sessionKey: 'codex:' + 'long-resource'.repeat(70), runtime: 'codex', sessionId: null },
        ], nextCursor: url.searchParams.has('after') ? null : 'codex:page/空 格', sourceCursor: 'source:1' };
        if (holdResources) pendingResources.push(() => respond(200, body));
        else respond(resourceStatus, resourceStatus === 200 ? body : { error: 'resource unavailable' });
        return;
      }
      if (url.pathname.startsWith(`/api/hub/v1/shared/owner-a/sessions/${encodeURIComponent(sessionId)}`)) {
        if (url.pathname.endsWith('/events/stream')) {
          res.setHeader('content-type', 'text/event-stream'); res.write('event: heartbeat\ndata: \n\n');
          streams.add(res); res.on('close', () => streams.delete(res)); return;
        }
        if (url.pathname.endsWith('/messages')) return respond(200, { messages: [{ id: 'shared', role: 'assistant', sessionKey: sessionId, text: 'Opened exact shared resource', createdAt: 1 }], updatedAt: 1, access: { messagesSend: false, eventsRead: false } });
        if (url.pathname.endsWith('/state')) return respond(200, { sessionKey: sessionId, status: 'idle' });
      }
      respond(404, { error: 'No owner catalog in fixture' });
    });
  },
}], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    status = 200; hold = false; resourceStatus = 200; holdResources = false; requests.length = 0;
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__shared#/shared`);
    await page.getByRole('link', { name: 'Open session', exact: true }).waitFor();
    const grantReads = requests.filter(request => request.path === '/api/hub/v1/shared/grants');
    assert.equal(grantReads.length, 1); assert.equal(grantReads[0].query, '?limit=50');
    assert.equal(await page.getByRole('textbox', { name: 'Your member ID', exact: true }).inputValue(), 'member-a');
    assert.equal(await page.getByRole('listitem').count(), 6);
    assert.equal(await page.getByRole('link', { name: 'Open session', exact: true }).count(), 1);
    await page.getByText('Node credentials changed · owner must reauthorize', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByText(/Owner: second-page-owner/).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 1, 'pages replace rather than accumulate');
    assert.equal(requests.at(-1).query, '?limit=50&after=next-cursor');
    await page.getByRole('button', { name: 'First page', exact: true }).click();
    await page.getByRole('button', { name: 'Browse sessions', exact: true }).click();
    await page.getByText('Message access not available', { exact: true }).waitFor();
    assert.equal(requests.at(-1).path, resourcePath); assert.equal(requests.at(-1).query, '?limit=50');
    assert.equal(await page.getByRole('listitem').count(), 2);
    assert.equal(await page.getByRole('link', { name: 'Open session', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByText('No known resources on this page. This does not confirm node connectivity or task completion.', { exact: true }).waitFor();
    assert.equal(requests.at(-1).query, '?limit=50&after=codex%3Apage%2F%E7%A9%BA%20%E6%A0%BC');
    assert.equal(await page.getByRole('listitem').count(), 0);
    await page.getByRole('button', { name: 'First page', exact: true }).click();
    await page.getByText('Message access not available', { exact: true }).waitFor();
    resourceStatus = 502;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Shared resources unavailable. Refresh to retry.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0);
    resourceStatus = 200;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Message access not available', { exact: true }).waitFor();
    holdResources = true;
    let resourceRequest = page.waitForRequest(request => new URL(request.url()).pathname === resourcePath);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await resourceRequest;
    // Returning mounts the authorization view before its refresh effect clears
    // the previous page. A cached Browse button is not proof that the new GET
    // has completed. Hold that GET so late resource delivery is tested during
    // the cleared/loading state, then wait for the real authorization response.
    hold = true;
    const authorizationRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/hub/v1/shared/grants');
    await page.getByRole('button', { name: '← Authorizations', exact: true }).click();
    await authorizationRequest;
    await page.getByText('Loading shared authorizations…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0, 'authorization refresh clears the old page');
    for (const respond of pendingResources.splice(0)) respond(); holdResources = false;
    assert.equal(await page.getByRole('listitem').count(), 0, 'late resource page cannot populate loading authorizations');
    for (const respond of pending.splice(0)) respond(); hold = false;
    await page.getByRole('link', { name: 'Open session', exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 6, 'late resource page cannot replace authorization page');
    resourceStatus = 403;
    await page.getByRole('button', { name: 'Browse sessions', exact: true }).click();
    await page.getByText('This shared directory is no longer available. Return to authorizations to reload access.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '← Authorizations', exact: true }).click();
    resourceStatus = 200; holdResources = true;
    resourceRequest = page.waitForRequest(request => new URL(request.url()).pathname === resourcePath);
    await page.getByRole('button', { name: 'Browse sessions', exact: true }).click(); await resourceRequest;
    await page.evaluate(scope => window.sharedFixture.account(scope), scopeB);
    await page.getByText(/Owner: account-b-policy/).waitFor();
    for (const respond of pendingResources.splice(0)) respond(); holdResources = false;
    assert.equal(await page.getByRole('listitem').count(), 1, 'old account resource response cannot leak');
    await page.evaluate(scope => window.sharedFixture.account(scope), scopeA);
    await page.getByRole('button', { name: 'Browse sessions', exact: true }).click();
    await page.getByText('Message access not available', { exact: true }).waitFor();
    await page.evaluate(() => window.sharedFixture.pause(true));
    await page.getByText('Sign in to view shared authorizations.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0);
    await page.evaluate(() => window.sharedFixture.pause(false));
    await page.getByRole('button', { name: 'Browse sessions', exact: true }).click();
    await page.getByText('Message access not available', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Open session', exact: true }).click();
    await page.getByText('Opened exact shared resource', { exact: true }).waitFor();
    assert.ok(requests.every(request => request.path.startsWith('/api/hub/v1/shared/')
      || ['/api/hub/v1/me', '/api/hub/v1/notebooks'].includes(request.path)), 'only shared resources and current-account identity/notebooks may be read');
    await page.getByRole('link', { name: '← Shared', exact: true }).click();
    await page.getByRole('link', { name: 'Open session', exact: true }).waitFor();
    status = 502;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Shared directory unavailable. Refresh to retry.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0);
    status = 200;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('link', { name: 'Open session', exact: true }).waitFor();
    hold = true;
    const loadingRequest = page.waitForRequest(request => request.url().includes('/shared/grants'));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await loadingRequest;
    hold = false;
    await page.evaluate(scope => window.sharedFixture.account(scope), scopeB);
    await page.getByText(/Owner: account-b-policy/).waitFor();
    for (const respond of pending.splice(0)) respond();
    assert.equal(await page.getByRole('link', { name: 'Open session', exact: true }).count(), 0);
    assert.equal(await page.getByRole('listitem').count(), 1);
    await page.evaluate(() => window.sharedFixture.pause(true));
    await page.getByText('Sign in to view shared authorizations.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0);
    await page.evaluate(() => window.sharedFixture.pause(false));
    await page.getByText(/Owner: account-b-policy/).waitFor();
    status = 403;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Shared access is unavailable. The directory has been cleared.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
    assert.ok(requests.every(request => request.method === 'GET'));
    assert.ok(requests.filter(request => request.path.includes('/connections/')).every(request => request.path === resourcePath), 'no owner catalog, other grant or node fan-out');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`shared directory browser passed ${viewport.width}x${viewport.height}`);
  }
} finally {
  for (const respond of pending) respond();
  for (const respond of pendingResources) respond();
  for (const stream of streams) stream.end();
  await browser?.close(); await server?.close();
}
