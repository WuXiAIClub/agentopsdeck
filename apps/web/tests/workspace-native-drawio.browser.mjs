import { resourceCaption } from './resource-caption.mjs';
// Production UI + real Hub routes/SQLite + synthetic cross-origin editor protocol fixture.
// This is NOT acceptance of a deployed self-hosted editor or its network isolation.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-native-drawio-browser-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), app = new Hono();
const principal = { userId: 'default', admin: true }, editorOrigin = 'https://editor.synthetic.test';
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_DRAWIO_EDITOR_URL: `${editorOrigin}/` }), hubStore: hub,
  connectorClient: () => { throw Error('Native drawing must not call Connector'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
const base = '/api/hub/v1/workspace/native-drawio';
const pageXml = label => `<diagram id="${label}" name="${label}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" parent="1" vertex="1" value="${label}" style="ellipse;html=1;fillColor=#ff0000;"><mxGeometry x="10" y="20" width="120" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram>`;
const nativeXml = `<mxfile host="synthetic">${pageXml('First')}${pageXml('Second')}</mxfile>`;
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const errors = [], forbidden = [], reads = [], writes = [], editorRequests = [], chunks = [];
  let editorEnabled = false, loseReply = false, offline = false;
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('agentopsdeck.locale', 'en');
    window.testEventSources = [];
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
      constructor() { super(); window.testEventSources.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === editorOrigin) {
      editorRequests.push(url.href);
      assert.equal(req.headers().referer, undefined);
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
        <h2>Synthetic isolated editor</h2><textarea aria-label="XML"></textarea><button id="save">Save fixture</button>
        <script>
        const hubOrigin = ${JSON.stringify(origin)}; window.received = [];
        window.emit = (event, xml) => parent.postMessage(JSON.stringify({ event, ...(xml ? { xml } : {}) }), hubOrigin);
        addEventListener('message', e => { if(e.source !== parent || e.origin !== hubOrigin) return; const m = JSON.parse(e.data); window.received.push(m);
          if(m.action === 'load') { document.querySelector('textarea').value = m.xml; emit('load'); } });
        document.querySelector('#save').onclick = () => emit('save', document.querySelector('textarea').value);
        emit('init');
        </script></body></html>` });
    }
    if (url.origin !== origin) { forbidden.push(url.href); return route.abort(); }
    if (url.pathname.includes('/assets/')) chunks.push(url.pathname);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/')) {
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.pathname.startsWith(base)) {
      (req.method() === 'GET' ? reads : writes).push(req.method() === 'GET' ? url.pathname : req.postDataJSON());
      if (offline) return route.abort('failed');
      if (url.pathname === `${base}/config` && !editorEnabled) return json({ editorUrl: null });
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      if (loseReply && req.method() === 'PUT') { loseReply = false; return route.abort('failed'); }
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.pathname.startsWith('/api/hub/v1/notebooks')) {
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers() });
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
  await page.goto(origin); await page.getByLabel('Layout presets', { exact: true }).waitFor();
  assert.equal(chunks.some(chunk => chunk.includes('WorkspaceNativeDrawio')), false);
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Native draw.io · Preview', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Native draw.io', exact: true });
  const title = (await resourceCaption(panel)).getByRole('textbox', { name: 'Drawing title' });
  await title.fill('Native shapes and pages');
  await panel.getByText('Editor is disabled.', { exact: false }).waitFor(); assert.equal(editorRequests.length, 0);
  const upload = async xml => (await resourceCaption(panel)).locator('input[type=file]').setInputFiles({ name: 'native.drawio', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await upload(nativeXml);
  await (await resourceCaption(panel)).getByRole('button', { name: 'Save', exact: true }).click();
  const saved = () => page.waitForFunction(() => document.querySelector('.workspace-native-drawio-state')?.textContent === 'Saved');
  await saved(); assert.equal(hub.nativeDrawio.get('default', 'default').xml, nativeXml);
  assert.equal(hub.drawings.get('default', 'default').revision, 0);
  assert.equal(hub.nativeDrawio.get('other', 'default').revision, 0);
  // Native XML must never become DOM/SVG in the host.
  assert.equal(await panel.locator('mxfile, mxCell, svg ellipse, script').count(), 0);
  for (const invalid of ['<mxfile><diagram/></mxfile>', '<mxfile><diagram>compressed-data</diagram></mxfile>', '<mxfile><!ENTITY x "bad"></mxfile>', '<mxfile><diagram><mxGraphModel></diagram></mxfile>', `<mxfile>${pageXml('page').repeat(33)}</mxfile>`, `<mxfile><diagram><mxGraphModel>${'<x>'.repeat(65)}${'</x>'.repeat(65)}</mxGraphModel></diagram></mxfile>`]) {
    await upload(invalid); await panel.getByText('Invalid native draw.io.', { exact: false }).waitFor();
    assert.equal(hub.nativeDrawio.get('default', 'default').xml, nativeXml);
  }
  editorEnabled = true; await page.reload(); await title.waitFor(); await saved();
  const open = async () => {
    await panel.getByRole('button', { name: 'Open trusted editor' }).click();
    await page.frameLocator('iframe').getByText('Synthetic isolated editor', { exact: true }).waitFor();
    await panel.getByText('Use File → Save or Ctrl/Cmd+S to save to Hub and close.', { exact: true }).waitFor();
    return page.frames().find(frame => frame.url().startsWith(editorOrigin));
  };
  assert.equal(editorRequests.length, 0, 'configured editor still needs explicit per-open consent');
  let editor = await open(); assert.ok(editor);
  assert.equal(await panel.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  const received = await editor.evaluate(() => window.received);
  assert.deepEqual(Object.keys(received[0]).sort(), ['action', 'autosave', 'title', 'xml']);
  assert.equal(received[0].xml, nativeXml);
  const writesBefore = writes.length;
  // Both window identity and origin must match. No simulated-origin shortcut.
  await page.evaluate(({ editorOrigin, xml }) => {
    const data = JSON.stringify({ event: 'save', xml });
    window.dispatchEvent(new MessageEvent('message', { origin: editorOrigin, source: window, data }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source: document.querySelector('iframe').contentWindow, data }));
  }, { editorOrigin, xml: nativeXml.replace('First', 'Spoofed') });
  const changedXml = nativeXml.replaceAll('First', 'Edited');
  await editor.evaluate(xml => { document.querySelector('textarea').value = xml; window.emit('autosave', xml); }, changedXml);
  await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('agentopsdeck.native-drawio-draft') && sessionStorage.getItem(key).includes('Edited')));
  assert.equal(writes.length, writesBefore, 'autosave only writes local draft, never Hub polling');
  await page.screenshot({ path: '/tmp/agentopsdeck-233-c2b2-native-editor.png' });
  await editor.getByRole('button', { name: 'Save fixture' }).click(); await saved();
  assert.equal(await panel.locator('iframe').count(), 0); assert.equal(hub.nativeDrawio.get('default', 'default').xml, changedXml);
  // Response lost AFTER commit: editing stays locked and retry has identical mutation ID/content.
  editor = await open(); await editor.getByRole('textbox', { name: 'XML' }).fill(changedXml.replaceAll('Second', 'ReplyLost'));
  loseReply = true; await editor.getByRole('button', { name: 'Save fixture' }).click();
  await panel.getByRole('button', { name: 'Retry same save' }).waitFor(); assert.equal(await title.isDisabled(), true);
  const lost = writes.at(-1), revision = hub.nativeDrawio.get('default', 'default').revision;
  await panel.getByRole('button', { name: 'Retry same save' }).click(); await saved();
  assert.deepEqual(writes.at(-1), lost); assert.equal(hub.nativeDrawio.get('default', 'default').revision, revision);
  // Unsubmitted autosave survives refresh; repeated init never reloads over the draft.
  editor = await open(); const localXml = changedXml.replaceAll('Second', 'LocalRecovered');
  await editor.evaluate(xml => window.emit('autosave', xml), localXml);
  await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('agentopsdeck.native-drawio-draft') && sessionStorage.getItem(key).includes('LocalRecovered')));
  await editor.evaluate(() => window.emit('init')); await panel.getByText('Editor did not become ready', { exact: false }).waitFor();
  await page.reload(); await panel.getByText('Unsaved changes', { exact: true }).waitFor();
  editor = await open(); assert.equal((await editor.evaluate(() => window.received[0])).xml, localXml);
  // Close within the debounce window must preserve the last received autosave.
  await panel.getByRole('button', { name: 'Close editor' }).click();
  const trailingXml = localXml.replaceAll('LocalRecovered', 'TrailingRecovered');
  await page.evaluate(({ xml, editorOrigin }) => {
    window.oldEditorWindow = document.querySelector('iframe').contentWindow;
    window.dispatchEvent(new MessageEvent('message', { origin: editorOrigin, source: window.oldEditorWindow, data: JSON.stringify({ event: 'autosave', xml }) }));
    [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Confirm').click();
  }, { xml: trailingXml, editorOrigin });
  await panel.getByRole('button', { name: 'Open trusted editor' }).waitFor();
  await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('agentopsdeck.native-drawio-draft') && sessionStorage.getItem(key).includes('TrailingRecovered')));
  editor = await open(); assert.equal((await editor.evaluate(() => window.received[0])).xml, trailingXml);
  // Same origin is insufficient: a previous iframe must never update a new editor.
  await page.evaluate(({ xml, editorOrigin }) => {
    window.dispatchEvent(new MessageEvent('message', { origin: editorOrigin, source: window.oldEditorWindow, data: JSON.stringify({ event: 'save', xml }) }));
  }, { xml: nativeXml.replace('First', 'StaleFrame'), editorOrigin });
  await panel.getByRole('button', { name: 'Close editor' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  assert.equal(await panel.locator('iframe').count(), 0);
  const current = hub.nativeDrawio.get('default', 'default');
  hub.nativeDrawio.save('default', 'default', { format: current.format, version: current.version, title: 'Other writer', xml: current.xml, revision: current.revision, mutationId: crypto.randomUUID() });
  await (await resourceCaption(panel)).getByRole('button', { name: 'Save', exact: true }).click(); await panel.getByText('Drawing changed elsewhere.', { exact: false }).waitFor();
  assert.equal(hub.nativeDrawio.get('default', 'default').title, 'Other writer');
  assert.equal(await panel.getByRole('button', { name: 'Open trusted editor' }).isDisabled(), true);
  assert.equal(await (await resourceCaption(panel)).getByRole('button', { name: 'Import native draw.io' }).isDisabled(), true);
  assert.equal(await title.isDisabled(), true, 'unresolved conflict cannot be hidden by further edits');
  // Explicit reload discards only this resource's draft.
  await (await resourceCaption(panel)).getByRole('button', { name: 'Reload drawing' }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await saved();
  assert.equal(await title.inputValue(), 'Other writer');
  await title.fill('Offline draft'); offline = true;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Save', exact: true }).click(); await panel.getByRole('button', { name: 'Retry same save' }).waitFor();
  offline = false; await panel.getByRole('button', { name: 'Retry same save' }).click(); await saved();
  assert.equal(hub.nativeDrawio.get('default', 'default').title, 'Offline draft');
  const snapshot = async (resourceType = 'native-drawio') => page.evaluate(({ resources, resourceType }) => {
    const live = window.testEventSources.filter(source => source.readyState === 1);
    if (live.length !== 1) throw Error(`expected one shared stream, got ${live.length}`);
    live[0].dispatchEvent(new MessageEvent('workspace.revisions', { data: JSON.stringify({ type: 'workspace.revisions', resourceType, resources }) }));
  }, { resources: hub.nativeDrawio.revisions('default'), resourceType });
  const remoteSave = name => {
    const d = hub.nativeDrawio.get('default', 'default');
    hub.nativeDrawio.save('default', 'default', { format: d.format, version: d.version, title: name, xml: d.xml, revision: d.revision, mutationId: crypto.randomUUID() });
  };
  remoteSave('Synced native diagram'); const beforeNotice = reads.length;
  await snapshot('drawing'); await page.waitForTimeout(200);
  assert.equal(reads.length, beforeNotice, 'wrong resource kind cannot reload native diagram');
  await snapshot(); await page.waitForFunction(() => document.querySelector('[aria-label="Drawing title"]')?.value === 'Synced native diagram');
  assert.equal(await panel.locator('iframe').count(), 0, 'revision notification cannot open external editor');
  const afterNotice = reads.length; await snapshot(); await page.waitForTimeout(200);
  assert.equal(reads.length, afterNotice, 'duplicate native revision does not reload');
  editor = await open(); remoteSave('Native peer edit'); await snapshot(); await page.waitForTimeout(200);
  assert.equal(await panel.locator('iframe').count(), 1); assert.equal(reads.length, afterNotice, 'open editor cannot be interrupted by revision notice');
  const protectedXml = changedXml.replaceAll('Second', 'ProtectedDraft');
  await editor.evaluate(xml => window.emit('autosave', xml), protectedXml);
  await panel.getByRole('button', { name: 'Close editor' }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await panel.getByText('Drawing changed elsewhere.', { exact: false }).waitFor();
  assert.equal(await title.inputValue(), 'Synced native diagram');
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('agentopsdeck.native-drawio-draft') && sessionStorage.getItem(key).includes('ProtectedDraft'))), true, 'unsaved XML preserved after remote conflict');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ status: 'PASS', actualHubRoutesAndSQLite: true, syntheticEditor: true, reads: reads.length, writes: writes.length, editorLoads: editorRequests.length, errors, forbidden }));
} finally { await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true }); }
