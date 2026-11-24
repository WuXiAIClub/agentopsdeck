// Actual, operator-supplied upstream webapp over isolated HTTPS. No production
// credentials, public editor, remote service or installed draw.io is used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { createServer as httpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
const root = resolve(process.env.AOD_TEST_DRAWIO_WEBAPP || '/missing-drawio-fixture');
await readFile(join(root, 'js/app.min.js')); // Fail before serving anything if absent.
const require = createRequire(new URL('../../server/package.json', import.meta.url)), { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-real-drawio-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), app = new Hono(), principal = { userId: 'default', admin: true };
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser, editorServer, routes;
const editorRequests = [], violations = [], errors = [], writes = [], external = [];
try {
  await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.xml': 'application/xml', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' };
  editorServer = httpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, async (req, res) => {
    // Per-editor policy, not a relaxation of Hub CSP. No wildcard network origins.
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors ${origin}`);
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    try {
      assert.equal(req.method, 'GET'); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
      const path = new URL(req.url, 'https://fixture').pathname;
      const file = resolve(root, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (!file.startsWith(root + sep)) throw Error('path');
      const body = await readFile(file); editorRequests.push(path);
      res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream'); res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  editorServer.listen(0, '127.0.0.1'); await once(editorServer, 'listening');
  const editorOrigin = `https://127.0.0.1:${editorServer.address().port}`;
  routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_DRAWIO_EDITOR_URL: `${editorOrigin}/` }), hubStore: hub, principal: () => principal,
    connectorClient: () => { throw Error('Must not use Connector'); }, normalizeError: () => 'Synthetic' });
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await context.exposeFunction('recordViolation', value => violations.push(value));
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('agentopsdeck.locale', 'en');
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    addEventListener('securitypolicyviolation', event => window.recordViolation({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === editorOrigin) return route.continue();
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (/^\/api\/hub\/v1\/(workspace\/(native-drawio|layouts)|notebooks)/.test(url.pathname)) {
      if (req.method() === 'PUT') writes.push(req.postDataJSON());
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    assert.equal(req.method(), 'GET');
    if (url.pathname === '/api/auth/status') return route.fulfill({ json: { authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } } });
    if (url.pathname.endsWith('/sessions/state')) return route.fulfill({ json: { revision: '1', groups: [] } });
    if (url.pathname.endsWith('/messages')) throw Error('Must not read chat');
    if (url.pathname === '/api/agents') return route.fulfill({ json: { agents: [] } });
    if (url.pathname === '/api/gateway/status') return route.fulfill({ json: { connected: true } });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const diagram = label => `<diagram id="${label}" name="${label}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node-${label}" parent="1" vertex="1" value="${label}" style="ellipse;html=1;fillColor=#ff0000;"><mxGeometry x="10" y="20" width="120" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram>`;
  const xml = `<mxfile>${diagram('First')}${diagram('Second')}</mxfile>`;
  await page.goto(origin); await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Native draw.io · Preview', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Native draw.io', exact: true });
  const saved = () => page.waitForFunction(() => document.querySelector('.workspace-native-drawio-state')?.textContent === 'Saved');
  await saved();
  await panel.locator('input[type=file]').setInputFiles({ name: 'synthetic.drawio', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
  assert.equal(editorRequests.length, 0, 'no editor requests before consent');
  await panel.getByRole('button', { name: 'Open trusted editor' }).click();
  await panel.getByText('Use File → Save or Ctrl/Cmd+S to save to Hub and close.', { exact: true }).waitFor();
  let frame = page.frames().find(f => f.url().startsWith(editorOrigin)); assert.ok(frame);
  // Exercise the actual editor UI, not a synthetic postMessage emitter.
  await frame.getByText('First', { exact: true }).first().dblclick();
  await frame.locator('[contenteditable="true"]').fill('Actual draw.io edit');
  await frame.locator('[contenteditable="true"]').press('Escape');
  await page.screenshot({ path: join(directory, 'editor.png') });
  console.log(JSON.stringify({ screenshot: join(directory, 'editor.png'), saveControls: await frame.locator('[title*="Save"],button').evaluateAll(nodes => nodes.filter(n => n.textContent === 'Save' || n.title?.startsWith('Save')).map(n => ({ tag: n.tagName, title: n.title, text: n.textContent, visible: n.getBoundingClientRect().height > 0 }))) }));
  // This upstream embed theme hides its legacy bottom Save button; use the
  // editor's real save shortcut, as a user would, not an injected save event.
  await frame.locator('body').press('Control+s');
  await saved(); assert.equal(await panel.locator('iframe').count(), 0);
  const stored = hub.nativeDrawio.get('default', 'default');
  assert.match(stored.xml, /Actual draw.io edit/); assert.match(stored.xml, /name="Second"/); assert.match(stored.xml, /ellipse/);
  assert.equal((stored.xml.match(/<mxGraphModel/g) ?? []).length, 2, 'saved XML must be uncompressed');
  await page.reload(); await saved();
  await panel.getByRole('button', { name: 'Open trusted editor' }).click();
  await panel.getByText('Use File → Save or Ctrl/Cmd+S to save to Hub and close.', { exact: true }).waitFor();
  frame = page.frames().find(f => f.url().startsWith(editorOrigin));
  await frame.getByText('Actual draw.io edit', { exact: true }).first().waitFor();
  // Check the installed CSP, not route interception, blocks external image/fetch.
  await frame.evaluate(() => { const img = new Image(); img.src = 'https://not-allowed.invalid/private-diagram.png'; document.body.append(img); void fetch('https://not-allowed.invalid/private-diagram').catch(() => {}); });
  await page.waitForTimeout(250);
  assert.ok(violations.some(v => v.directive === 'img-src' && v.blocked.startsWith('https://not-allowed.invalid')));
  assert.ok(violations.some(v => v.directive === 'connect-src' && v.blocked.startsWith('https://not-allowed.invalid')));
  await frame.getByText('File', { exact: true }).first().click();
  await frame.locator('td.mxPopupMenuItem').filter({ hasText: /^Save$/ }).click();
  await panel.locator('iframe').waitFor({ state: 'detached' });
  await saved(); assert.equal(await panel.locator('iframe').count(), 0, 'visible File menu can save without a keyboard');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified: true, actualUpstream: true, editorRequests: editorRequests.length, writes: writes.length, multiPage: true, editSaveReload: true, cspBlocksEgress: true, errors, external }));
} finally {
  await browser?.close(); await server.close();
  if (editorServer) { editorServer.closeAllConnections(); await new Promise(r => editorServer.close(r)); }
  routes?.close(); hub.close();
  if (process.env.AOD_TEST_KEEP_FIXTURE !== '1') await rm(directory, { recursive: true, force: true });
}
