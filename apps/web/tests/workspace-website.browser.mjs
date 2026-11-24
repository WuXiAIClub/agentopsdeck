import { resourceCaption } from './resource-caption.mjs';
// Isolated Hub SQLite + Connector HTTP routes + real loopback website. No Agent,
// live service data, credentials or remote installation are used.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { ConnectorClient } from '../../server/src/hub/connector-client.ts';
import { ConnectorTokenStore } from '../../server/src/auth/connector-token.ts';
import { registerConnectorWebsiteRoutes } from '../../server/src/connector/websites-http.ts';
import { registerConnectorWebsiteAccess } from '../../server/src/connector/website-access-http.ts';
import { registerConnectorWebsiteActions } from '../../server/src/connector/website-actions-http.ts';
import { WebsiteGateway } from '../../server/src/hub/website-gateway.ts';
import { attachWebsiteSocketUpgrade } from '../../server/src/hub/website-socket-gateway.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-websites-browser-'));
const siteRequests = [], forbidden = [], errors = [], websiteReads = [], chunks = [];
let interactiveSite = false, shortExpiry = false, leaseCloses = 0;
let operations = 0, loseOperationReply = false;
let uploads = 0, downloads = 0, logins = 0, protectedWrites = 0;
const transferBytes = Buffer.alloc(100_000, 255);
const actionRequests = [];
let content = `<h1>Local development app</h1><p>Readable website</p><table><tr><td>Table cell</td></tr></table>
  <script>parent.document.body.innerHTML='OWNED';fetch('https://forbidden.test/script')</script>
  <style>@import url(https://forbidden.test/css);</style><link rel="stylesheet" href="https://forbidden.test/link">
  <meta http-equiv="refresh" content="0;url=https://forbidden.test/refresh"><base href="https://forbidden.test/">
  <a href="/api/hub/v1/connections" target="_top" onclick="alert(1)">Safe inert link</a>
  <img src="https://forbidden.test/image" onerror="alert(1)"><iframe src="https://forbidden.test/frame"></iframe>
  <svg><foreignObject><img src="https://forbidden.test/svg"></foreignObject></svg>
  <form action="/api/private"><button>Unsafe submit</button></form><div style="background:url(https://forbidden.test/bg)" onpointerover="alert(1)">No copied attributes</div>`;
const site = createHttpServer((req, res) => {
  siteRequests.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
  if (req.url === '/api/login' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { password: 'synthetic-login-password' });
      assert.equal(req.headers.cookie, undefined); logins++;
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=synthetic-site-cookie; Path=/; HttpOnly', 'csrf=synthetic-csrf; Path=/'] }); res.end('{"loggedIn":true}');
    }); return;
  }
  if (req.url === '/api/protected' && req.method === 'POST') {
    assert.equal(req.headers.cookie, 'sid=synthetic-site-cookie; csrf=synthetic-csrf');
    assert.equal(req.headers['x-csrf-token'], 'synthetic-csrf'); assert.equal(req.headers.authorization, undefined);
    protectedWrites++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"saved":true}'); return;
  }
  if (req.url === '/api/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      uploads++; assert.deepEqual(Buffer.concat(chunks), transferBytes);
      assert.equal(req.headers['content-type'], 'application/octet-stream');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ uploaded: transferBytes.length }));
    }); return;
  }
  if (req.url === '/api/download' && req.method === 'GET') {
    downloads++; res.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="../../wrong.html"' }); res.end(transferBytes); return;
  }
  if (req.url === '/api/controlled' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      operations++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ operations, body, literal: '<img src=x onerror=alert(1)>' }));
    });
    return;
  }
  if (interactiveSite) {
    const resource = req.url === '/style.css' ? ['text/css', 'body{background:rgb(230,240,250)}']
      : req.url === '/app.js' ? ['text/javascript', `
        try { parent.document.body.dataset.owned='yes'; } catch { document.querySelector('#isolation').textContent='Parent isolated'; }
        document.querySelector('#read').onclick=async()=>{ const response=await fetch('/api/demo'); document.querySelector('#result').textContent=String(response.status)+':'+await response.text(); };
        document.querySelector('#write').onclick=async()=>{ const response=await fetch('/api/demo',{method:'POST',body:'denied'}); document.querySelector('#result').textContent='write:'+response.status; };
        document.querySelector('#socket').onclick=()=>{ const socket=new WebSocket(location.href.replace(/^http/,'ws').replace(/\\/$/,'')+'/hmr','vite-hmr'); socket.onopen=()=>socket.send('hmr-update'); socket.onmessage=event=>{ document.querySelector('#socket-result').textContent=event.data; socket.close(); }; };
        document.querySelector('#ready').textContent='Module ready';`]
      : req.url === '/api/demo' ? ['application/json', '{"value":"Resource reply"}']
      : ['text/html', `<h1>${req.url === '/next' ? 'Next page' : 'Interactive app'}</h1><link rel="stylesheet" href="/style.css">
        <p id="ready"></p><p id="isolation"></p><button id="read">Read API</button><button id="write">Try write</button><p id="result"></p><button id="socket">Test HMR</button><p id="socket-result"></p>
        <a href="/next">Next page</a><script type="module" src="/app.js"></script><img src="https://forbidden.test/image">`];
    res.writeHead(200, { 'content-type': resource[0], 'set-cookie': 'never-forward=private' }); res.end(resource[1]); return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'site-secret=private' }); res.end(content);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
const credential = tokens.createTransient(['websites:read', 'websites:browse', 'websites:act', 'websites:connect']);
hub.upsertConnection({ id: 'dev', label: 'Test environment', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: 'default' });
const connector = new Hono();
connector.use('*', async (c, next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); });
registerConnectorWebsiteRoutes(connector, tokens, [{ id: 'app', label: 'Test website', url: `http://127.0.0.1:${site.address().port}/` }]);
const access = registerConnectorWebsiteAccess(connector, tokens, [{ id: 'app', label: 'Test website', url: `http://127.0.0.1:${site.address().port}/`, browse: true, sockets: [{ path: '/hmr', protocols: ['vite-hmr'] }] }]);
const actions = registerConnectorWebsiteActions(connector, tokens, [{ id: 'app', label: 'Test website', url: `http://127.0.0.1:${site.address().port}/`, actions: [
  { id: 'update', label: 'Update demo', method: 'POST', path: '/api/controlled', contentType: 'application/json', maxBytes: 16384 },
  { id: 'upload', label: 'Upload demo', method: 'POST', path: '/api/upload', contentType: 'application/octet-stream', maxBytes: 1024 * 1024 },
  { id: 'download', label: 'Download demo', method: 'GET', path: '/api/download', contentType: 'text/plain', maxBytes: 0, download: { filename: 'safe-report.bin', maxBytes: 1024 * 1024 } },
  { id: 'login', label: 'Login demo', method: 'POST', path: '/api/login', contentType: 'application/json', maxBytes: 512 },
  { id: 'protected', label: 'Protected demo', method: 'POST', path: '/api/protected', contentType: 'application/json', maxBytes: 512, csrf: true },
], session: { cookieNames: ['sid', 'csrf'], csrf: { cookie: 'csrf', header: 'x-csrf-token' } } }]);
const gateway = new WebsiteGateway({ originTemplate: 'http://{access}.preview.localhost', parentOrigin: 'http://127.0.0.1', port: 0 });
const gatewayServer = serve({ fetch: gateway.fetch, hostname: '127.0.0.1', port: 0 });
const upgrades = attachWebsiteSocketUpgrade(gatewayServer, gateway);
const { WebSocketServer } = createRequire(new URL('../../server/package.json', import.meta.url))('ws');
const websiteSockets = new WebSocketServer({ server: site });
let socketMessages = 0;
websiteSockets.on('connection', (socket, request) => {
  assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined);
  socket.on('message', data => { socketMessages++; socket.send(data.toString()); });
});
if (!gatewayServer.listening) await new Promise(resolve => gatewayServer.once('listening', resolve));
gateway.config.originTemplate = `http://{access}.preview.localhost:${gatewayServer.address().port}`;
const principal = { userId: 'default', admin: true }, app = new Hono();
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  websiteGateway: gateway,
  connectorClient: (id, maintenance, owner) => { assert.equal(id, 'dev'); assert.equal(maintenance, false); assert.equal(owner, 'default'); return new ConnectorClient('http://connector', credential.token, request => connector.fetch(request)); },
  normalizeError: () => 'Synthetic', principal: () => principal });
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  gateway.config.parentOrigin = origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  // Playwright's serviceWorkers:block init script reads navigator.serviceWorker
  // in opaque sandbox frames and throws. Block registration only in the app.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    if (location.protocol === 'http:' && !location.hostname.endsWith('.preview.localhost')) {
      localStorage.setItem('agentopsdeck.locale', 'en');
      navigator.serviceWorker.register = async () => { throw Error('Disabled by isolated test'); };
    }
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (/^[a-f0-9]{48}\.preview\.localhost$/.test(url.hostname) && url.port === String(gatewayServer.address().port)) return route.continue();
    if (url.origin !== origin) { forbidden.push(req.url()); return route.abort(); }
    if (url.pathname.includes('/assets/')) chunks.push(url.pathname);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/') || url.pathname.startsWith('/api/hub/v1/notebooks') || url.pathname.startsWith('/api/hub/v1/connections')) {
      if (url.pathname.includes('/websites/')) websiteReads.push(url.pathname);
      const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      if (url.pathname.includes('/website-actions')) {
        actionRequests.push(`${req.method()} ${url.pathname}`);
        if (loseOperationReply && url.pathname.endsWith('/execute')) { loseOperationReply = false; return route.abort('failed'); }
      }
      if (url.pathname.includes('/website-access/') && req.method() === 'DELETE') leaseCloses++;
      if (shortExpiry && url.pathname.endsWith('/browser') && response.ok) return route.fulfill({ json: { ...await response.json(), expiresInMs: 750 } });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
    if (url.pathname.endsWith('/messages')) { forbidden.push('message read'); return json({ messages: [] }); }
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { forbidden.push('unexpected dialog'); void dialog.dismiss(); });
  await page.goto(origin); await page.getByLabel('Layout presets', { exact: true }).waitFor();
  assert.equal(chunks.some(chunk => chunk.includes('WorkspaceWebsite')), false);
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Connector website · Preview', exact: true }).click();
  const catalog = page.getByRole('region', { name: 'Connector website · Preview', exact: true }).first();
  await (await resourceCaption(catalog)).getByRole('combobox', { name: 'Choose a Connector', exact: true }).selectOption('dev');
  assert.equal(siteRequests.length, 0, 'catalog does not fetch website content');
  await catalog.getByRole('button', { name: 'Test website', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Connector website · Preview', exact: true }).nth(1);
  const frame = panel.frameLocator('iframe');
  await frame.getByRole('heading', { name: 'Local development app', exact: true }).waitFor();
  assert.equal(await frame.getByText('Table cell', { exact: true }).count(), 1);
  assert.equal(await frame.locator('script,img,svg,form,iframe,link,base,body [style],body [href],body [src],body [onclick],body meta').count(), 0);
  assert.equal(await panel.locator('iframe').getAttribute('sandbox'), '');
  assert.deepEqual(await frame.locator('html').evaluate(element => {
    const style = getComputedStyle(element); return [style.color, style.backgroundColor];
  }), ['rgb(23, 35, 52)', 'rgb(255, 254, 250)'], 'snapshot text stays readable independently of the host/browser color scheme');
  if (process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_SCREENSHOT });
  await frame.getByText('Safe inert link', { exact: true }).click();
  assert.equal(siteRequests.length, 1); assert.equal(siteRequests[0].authorization, undefined); assert.equal(siteRequests[0].cookie, undefined);
  assert.equal(websiteReads.length, 2, 'one catalog + one snapshot');
  const pane = panel.locator('xpath=ancestor::*[@data-workspace-pane][1]');
  // New cards float by default so adding one does not rearrange the workspace.
  // Exercise both transitions without reverting that product behavior.
  await pane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await pane.getByRole('button', { name: 'Float pane', exact: true }).click();
  await page.waitForTimeout(1200); assert.equal(websiteReads.length, 2, 'no drag/remount or idle polling');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Refresh website snapshot', exact: true }).click();
  await frame.getByRole('heading', { name: 'Local development app' }).waitFor(); assert.equal(siteRequests.length, 2);
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('Readable website'))), false);
  await page.reload(); await frame.getByRole('heading', { name: 'Local development app' }).waitFor(); assert.equal(siteRequests.length, 3, 'saved layout stores reference, reauthorizes once on restore');
  // Reading/citation is a local projection of the existing sanitized snapshot.
  // A synthetic clipboard records the user gesture without changing OS clipboard.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedExcerpt = text; } } }));
  const readsBeforeReader = siteRequests.length;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Reading view', exact: true }).click();
  const reader = panel.getByRole('region', { name: 'Website reading view', exact: true });
  await reader.getByText('Readable website', { exact: true }).waitFor();
  assert.equal(await panel.locator('iframe').count(), 0);
  assert.ok(!(await reader.innerText()).includes('OWNED'));
  assert.equal(await reader.locator('.website-reader-body').locator('a,img,script,iframe,svg').count(), 0, 'reading text has no active upstream markup');
  const readableLine = reader.locator('.website-reader-line').filter({ hasText: 'Readable website' });
  await readableLine.getByRole('button').click();
  await reader.getByRole('button', { name: 'Copy excerpt with source', exact: true }).click();
  await reader.getByText('Copied', { exact: true }).waitFor();
  const excerpt = JSON.parse(await page.evaluate(() => window.__copiedExcerpt));
  assert.equal(excerpt.excerpt, 'Readable website');
  assert.equal(excerpt.source.connectionId, 'dev'); assert.equal(excerpt.source.serviceId, 'app');
  assert.equal(excerpt.source.sha256, createHash('sha256').update(JSON.stringify(['html', content])).digest('hex'));
  assert.ok(!JSON.stringify(excerpt).includes('preview.localhost'));
  await reader.getByRole('searchbox').fill('Table cell');
  await reader.locator('.is-match').filter({ hasText: 'Table cell' }).waitFor();
  assert.ok((await reader.locator('.is-match').innerText()).endsWith('Table cell'));
  assert.equal(siteRequests.length, readsBeforeReader, 'reading, search and copy issue no website requests');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Snapshot view', exact: true }).click();
  await frame.getByRole('heading', { name: 'Local development app' }).waitFor();

  // Large text is fully available but renders at most forty bounded lines.
  content = `<pre>${Array.from({ length: 700 }, (_, index) => `Line ${index}: ${'text '.repeat(120)}`).join('\n')}</pre>`;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Refresh website snapshot', exact: true }).click();
  await frame.locator('pre').waitFor();
  await (await resourceCaption(panel)).getByRole('button', { name: 'Reading view', exact: true }).click();
  await reader.getByRole('searchbox').waitFor();
  assert.equal(await reader.locator('.website-reader-line').count(), 40);
  const largeReads = siteRequests.length;
  await reader.getByRole('searchbox').fill('Line 699:');
  await reader.locator('.is-match').filter({ hasText: 'Line 699:' }).waitFor();
  assert.ok(await reader.locator('.website-reader-line').count() <= 40);
  await reader.locator('.is-match').getByRole('button').click();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('Synthetic clipboard denied'); }; });
  await reader.getByRole('button', { name: 'Copy excerpt with source', exact: true }).click();
  await reader.getByText('Clipboard unavailable. Select and copy the source excerpt below.', { exact: true }).waitFor();
  assert.equal(JSON.parse(await reader.getByRole('textbox', { name: 'Source excerpt', exact: true }).inputValue()).firstLine, 700);
  assert.equal(siteRequests.length, largeReads);
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('Line 699:'))), false);
  if (process.env.AOD_TEST_READER_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_READER_SCREENSHOT });
  const fontBefore = await reader.locator('.website-reader-line > span').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await reader.evaluate(element => element.style.setProperty('--agentopsdeck-chat-font-scale', '1.2'));
  const fontAfter = await reader.locator('.website-reader-line > span').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert.ok(Math.abs(fontAfter / fontBefore - 1.2) < .01, 'reading content honors the chat font setting');
  await reader.evaluate(element => element.style.removeProperty('--agentopsdeck-chat-font-scale'));
  // This panel belongs to the desktop workspace. A phone viewport switches to
  // the separate chat shell, so exercise an actual narrow workspace pane here.
  const paneWidth = await pane.evaluate(element => element.style.width);
  await pane.evaluate(element => { element.style.width = '390px'; });
  assert.ok(await reader.evaluate(element => element.clientWidth > 0 && element.scrollWidth <= element.clientWidth + 1), '390px pane reader has no horizontal content overflow');
  if (process.env.AOD_TEST_READER_SCREENSHOT) await pane.screenshot({ path: process.env.AOD_TEST_READER_SCREENSHOT.replace('.png', '-narrow.png') });
  await pane.evaluate((element, width) => { element.style.width = width; }, paneWidth);
  content = '<p>New reading revision</p>';
  await (await resourceCaption(panel)).getByRole('button', { name: 'Refresh website snapshot', exact: true }).click();
  await reader.getByText('New reading revision', { exact: true }).waitFor();
  assert.equal(await reader.getByRole('textbox', { name: 'Source excerpt', exact: true }).count(), 0, 'refresh drops old excerpt state');
  assert.equal(await reader.getByRole('searchbox').inputValue(), '');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Snapshot view', exact: true }).click();
  // Hostile deep markup fails closed without taking down the workspace.
  content = '<div>'.repeat(100) + 'deep' + '</div>'.repeat(100);
  await (await resourceCaption(panel)).getByRole('button', { name: 'Refresh website snapshot', exact: true }).click();
  await panel.getByRole('alert').waitFor(); assert.equal(await panel.locator('iframe').count(), 0);
  content = '<p>x</p>'.repeat(13000);
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await panel.getByRole('alert').waitFor(); assert.equal(await panel.locator('iframe').count(), 0);
  content = '<h1>Recovered snapshot</h1>';
  await panel.getByRole('button', { name: 'Retry', exact: true }).click(); await frame.getByRole('heading', { name: 'Recovered snapshot' }).waitFor();

  // Real dedicated gateway HTTP listener -> authorized Connector -> website.
  interactiveSite = true;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  await frame.getByText('Module ready', { exact: true }).waitFor();
  await frame.getByText('Parent isolated', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Test HMR', exact: true }).click();
  await frame.getByText('hmr-update', { exact: true }).waitFor();
  assert.equal(socketMessages, 1);
  console.log(JSON.stringify({ websiteWebSocket: true, hmrFrames: socketMessages, opaqueIframe: true }));
  assert.equal(await panel.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(230, 240, 250)');
  await frame.getByRole('button', { name: 'Read API', exact: true }).click();
  await frame.getByText('200:{"value":"Resource reply"}', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Try write', exact: true }).click();
  await frame.getByText('write:405', { exact: true }).waitFor();
  await frame.getByRole('link', { name: 'Next page', exact: true }).click();
  await frame.getByRole('heading', { name: 'Next page', exact: true }).waitFor();
  await frame.getByText('Module ready', { exact: true }).waitFor();
  const interactiveAddress = await panel.locator('iframe').getAttribute('src');
  assert.equal(await page.evaluate(address => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(address)), interactiveAddress), false);
  assert.ok(siteRequests.every(request => !request.cookie && !request.authorization));
  const stableReads = siteRequests.length;
  await page.waitForTimeout(1200); assert.equal(siteRequests.length, stableReads, 'no background website polling');
  if (process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_SCREENSHOT });
  await (await resourceCaption(panel)).getByRole('button', { name: 'Return to snapshot', exact: true }).click();
  await frame.getByRole('heading', { name: 'Interactive app', exact: true }).waitFor();
  assert.equal(leaseCloses, 1); assert.equal((await gateway.fetch(new Request(interactiveAddress))).status, 404);
  shortExpiry = true;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  await panel.getByText('Website access expired. Return to the snapshot and reopen to continue.', { exact: true }).waitFor();
  assert.equal(await panel.locator('iframe').count(), 0); assert.equal(leaseCloses, 2);
  await (await resourceCaption(panel)).getByRole('button', { name: 'Return to snapshot', exact: true }).click();
  await frame.getByRole('heading', { name: 'Interactive app', exact: true }).waitFor();
  shortExpiry = false;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  await frame.getByText('Module ready', { exact: true }).waitFor();
  const closingAddress = await panel.locator('iframe').getAttribute('src');
  await pane.getByRole('button', { name: 'Close pane', exact: true }).click();
  for (let i = 0; leaseCloses < 3 && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(leaseCloses, 3, 'unmount explicitly closes its lease');
  assert.equal((await gateway.fetch(new Request(closingAddress))).status, 404);
  await (await resourceCaption(catalog)).getByRole('combobox', { name: 'Choose a Connector', exact: true }).selectOption('dev');
  await catalog.getByRole('button', { name: 'Test website', exact: true }).click();
  await frame.getByRole('heading', { name: 'Interactive app', exact: true }).waitFor();
  assert.equal(await panel.locator('iframe').getAttribute('sandbox'), '', 'reopening never silently restores interactive access');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Reading view', exact: true }).click();
  await reader.getByText('Interactive app', { exact: true }).waitFor();
  assert.equal(actionRequests.length, 0, 'operations never load before explicit opening');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Controlled website actions', exact: true }).click();
  const operation = panel.getByRole('region', { name: 'Controlled website actions', exact: true });
  await operation.getByRole('combobox').selectOption('update');
  await operation.getByRole('textbox', { name: 'Operation body', exact: true }).fill('{"demo":"private-operation-body"}');
  assert.equal(await operation.getByRole('button', { name: 'Execute once', exact: true }).isEnabled(), false);
  await operation.getByRole('checkbox').check();
  loseOperationReply = true;
  await operation.getByRole('button', { name: 'Execute once', exact: true }).evaluate(button => { button.click(); button.click(); });
  await operation.getByRole('status').filter({ hasText: 'Operation result unknown.' }).waitFor();
  assert.equal(operations, 1, 'double click and lost reply do not repeat the operation');
  await operation.getByRole('button', { name: 'Check operation receipt', exact: true }).click();
  await operation.getByRole('status').filter({ hasText: 'HTTP 200' }).waitFor();
  assert.equal(JSON.parse(await operation.locator('pre').innerText()).operations, 1);
  assert.equal(await operation.locator('img').count(), 0, 'operation response is inert text');
  assert.equal(operations, 1, 'receipt recovery is read only');
  assert.ok(siteRequests.every(request => !request.cookie && !request.authorization));
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('private-operation-body'))), false);
  const quietActionCount = actionRequests.length;
  await page.waitForTimeout(1200);
  assert.equal(actionRequests.length, quietActionCount, 'no action/receipt idle polling');
  await operation.getByRole('button', { name: 'Prepare another operation', exact: true }).click();
  await operation.getByRole('combobox').selectOption('upload');
  await operation.getByLabel('Upload file', { exact: true }).setInputFiles({ name: 'local.bin', mimeType: 'application/octet-stream', buffer: transferBytes });
  await operation.getByRole('checkbox').check();
  await operation.getByRole('button', { name: 'Execute once', exact: true }).click();
  await operation.getByRole('status').filter({ hasText: 'HTTP 200' }).waitFor();
  assert.equal(JSON.parse(await operation.locator('pre').innerText()).uploaded, transferBytes.length); assert.equal(uploads, 1);
  await operation.getByRole('button', { name: 'Prepare another operation', exact: true }).click();
  await operation.getByRole('combobox').selectOption('download');
  assert.equal(await operation.getByRole('textbox').count(), 0);
  await operation.getByRole('checkbox').check();
  await operation.getByRole('button', { name: 'Execute once', exact: true }).click();
  await operation.getByRole('status').filter({ hasText: 'HTTP 200' }).waitFor();
  const downloadEvent = page.waitForEvent('download');
  await operation.getByRole('button', { name: 'Download attachment · safe-report.bin', exact: true }).click();
  const attachment = await downloadEvent;
  assert.equal(attachment.suggestedFilename(), 'safe-report.bin');
  assert.deepEqual(await readFile(await attachment.path()), transferBytes);
  assert.equal(downloads, 1, 'saving the received attachment does not refetch');
  assert.equal(await operation.locator('iframe,img').count(), 0, 'download MIME is not rendered');
  await operation.getByRole('button', { name: 'Prepare another operation', exact: true }).click();
  await operation.getByRole('combobox').selectOption('login');
  await operation.getByRole('textbox', { name: 'Operation body', exact: true }).fill('{"password":"synthetic-login-password"}');
  await operation.getByRole('checkbox').check();
  await operation.getByRole('button', { name: 'Execute once', exact: true }).click();
  await operation.getByRole('status').filter({ hasText: 'HTTP 200' }).waitFor();
  assert.equal(logins, 1);
  await operation.getByRole('button', { name: 'Prepare another operation', exact: true }).click();
  await operation.getByRole('combobox').selectOption('protected');
  await operation.getByRole('textbox', { name: 'Operation body', exact: true }).fill('{}');
  await operation.getByRole('checkbox').check();
  await operation.getByRole('button', { name: 'Execute once', exact: true }).click();
  await operation.getByRole('status').filter({ hasText: 'HTTP 200' }).waitFor();
  assert.equal(protectedWrites, 1);
  assert.equal((await page.locator('body').innerText()).includes('synthetic-site-cookie'), false);
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage), document.cookie].some(v => /synthetic-(site-cookie|csrf|login-password)/.test(v))), false);
  assert.equal((await context.cookies()).some(c => c.name === 'sid' || c.name === 'csrf'), false);
  await operation.getByRole('button', { name: 'End website session', exact: true }).click();
  await operation.getByRole('combobox').selectOption('login');
  await operation.getByRole('textbox', { name: 'Operation body', exact: true }).fill('{"password":"synthetic-login-password"}');
  await operation.getByRole('checkbox').check();
  await operation.getByRole('button', { name: 'Execute once', exact: true }).click();
  await operation.getByRole('status').filter({ hasText: 'HTTP 200' }).waitFor();
  assert.equal(logins, 2, 'explicitly ending the session clears website cookies for a fresh login');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Controlled website actions', exact: true }).click();
  credential.dispose();
  await (await resourceCaption(panel)).getByRole('button', { name: 'Controlled website actions', exact: true }).click();
  await operation.getByRole('alert').waitFor();
  assert.equal(await operation.getByRole('button', { name: 'Execute once', exact: true }).count(), 0, 'revoked action scope cannot execute');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Controlled website actions', exact: true }).click();
  await (await resourceCaption(panel)).getByRole('button', { name: 'Refresh website snapshot', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.locator('iframe,.website-reader').count(), 0, 'denied refresh clears both raw snapshot and derived reader');
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, websiteReads: websiteReads.length, actualSiteReads: siteRequests.length, leaseCloses, operations, uploads, downloads, logins, protectedWrites, privateCookies: true, attachmentVerified: true, actionRequests: actionRequests.length, lostReplyRecovered: true, forbiddenRequests: forbidden.length, browserErrors: errors.length }));
} finally {
  await browser?.close(); await server.close(); upgrades.close(); for (const socket of websiteSockets.clients) socket.terminate(); websiteSockets.close(); gateway.close(); routes?.close(); access.close(); actions.close(); hub.close();
  gatewayServer.closeAllConnections(); await new Promise(resolve => gatewayServer.close(resolve));
  site.closeAllConnections(); await new Promise(resolve => site.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
