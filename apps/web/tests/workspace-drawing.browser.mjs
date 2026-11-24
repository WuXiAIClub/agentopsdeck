import { resourceCaption } from './resource-caption.mjs';
// Real Hub drawing routes + isolated SQLite; no Agent or production data.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-drawing-browser-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const principal = { userId: 'default', admin: true }, app = new Hono();
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('Drawing must not call Connector'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
  const errors = [], reads = [], writes = [], forbidden = [], chunks = [];
  let loseReply = false, offline = false;
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('agentopsdeck.locale', 'en');
    window.testEventSources = [];
    window.inkDraftWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('agentopsdeck.drawing-draft.')) window.inkDraftWrites++; return setItem.call(this, key, value); };
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
      constructor() { super(); window.testEventSources.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
    if (url.pathname.includes('/assets/')) chunks.push(url.pathname);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/')) {
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.pathname.startsWith('/api/hub/v1/workspace/drawings')) {
      (req.method() === 'GET' ? reads : writes).push(req.postDataJSON?.() ?? url.pathname);
      if (offline) return route.abort('failed');
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
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.getByLabel('Layout presets', { exact: true }).waitFor();
  assert.equal(chunks.some(chunk => chunk.includes('WorkspaceDrawing')), false, 'drawing bundle not loaded with chat shell');
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Whiteboard · Preview', exact: true }).click();
  const board = page.locator('[data-workspace-pane]').filter({ has: page.getByRole('region', { name: 'Whiteboard', exact: true }) }).first();
  await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }));
  await board.locator('.session-pane-caption').getByRole('button', { name: 'Open drawing', exact: true }).waitFor();
  assert.equal(await board.locator('.workspace-drawing-toolbar').count(), 0, 'no duplicate whiteboard heading/toolbar');
  for (const name of ['Open drawing', 'Refresh drawing', 'Save']) assert.equal(await board.locator('.session-pane-caption').getByRole('button', { name, exact: true }).count(), 1);
  const title = board.getByRole('textbox', { name: 'Drawing title', exact: true });
  await title.fill('Design sketch');
  const saved = () => page.waitForFunction(() => document.querySelector('.workspace-drawing-state')?.textContent === 'Saved');
  await board.getByRole('button', { name: 'Add card', exact: true }).click();
  await board.getByRole('textbox', { name: 'Card text', exact: true }).fill('<script>not executed</script>');
  await board.getByRole('button', { name: 'Add card', exact: true }).click();
  await board.getByRole('textbox', { name: 'Card text', exact: true }).fill('Second card');
  await board.getByRole('combobox', { name: 'Connect to card', exact: true }).selectOption({ label: '<script>not executed</script>' });
  await board.getByRole('button', { name: 'Connect', exact: true }).click();
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click(); await saved();
  assert.equal(hub.drawings.get('default', 'default').nodes.length, 2); assert.equal(hub.drawings.get('default', 'default').edges.length, 1);
  assert.equal(hub.drawings.get('other-user', 'default').revision, 0);
  assert.equal(await board.locator('script, foreignObject, image').count(), 0);
  // Real pointer drag, scaled canvas coordinates; one final mutation, no write per move.
  const card = board.locator('svg g').last(); const rect = await card.boundingBox(); assert.ok(rect);
  const old = hub.drawings.get('default', 'default').nodes[1];
  await page.mouse.move(rect.x + 20, rect.y + 20); await page.mouse.down(); await page.mouse.move(rect.x + 100, rect.y + 65, { steps: 5 }); await page.mouse.up();
  const beforeSave = writes.length;
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click(); await saved();
  assert.equal(writes.length, beforeSave + 1); assert.ok(hub.drawings.get('default', 'default').nodes[1].x > old.x);
  const counts = { reads: reads.length, writes: writes.length };
  const pane = board;
  if (await pane.getByRole('button', { name: 'Dock pane', exact: true }).isVisible()) await pane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await pane.getByRole('button', { name: 'Float pane', exact: true }).click();
  await pane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await page.waitForTimeout(500); assert.deepEqual({ reads: reads.length, writes: writes.length }, counts);
  await page.reload(); await saved(); assert.equal(await title.inputValue(), 'Design sketch');
  assert.equal(reads.length, counts.reads + 1);
  await board.locator('svg g').last().click();
  await board.getByRole('button', { name: 'Remove card', exact: true }).click();
  assert.equal(await board.locator('svg g').count(), 1); assert.equal(await board.locator('svg line').count(), 0);
  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await board.locator('svg g').count(), 2); assert.equal(await board.locator('svg line').count(), 1);
  const downloadPromise = page.waitForEvent('download'); await board.getByRole('button', { name: 'Export drawing', exact: true }).click();
  const download = await downloadPromise, exported = await readFile(await download.path(), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(exported)).sort(), ['edges', 'format', 'nodes', 'title', 'version']);
  const file = board.locator('input[type=file]');
  await file.setInputFiles({ name: 'malformed.json', mimeType: 'application/json', buffer: Buffer.from('<svg onload="alert(1)"/>') });
  await board.getByRole('alert').filter({ hasText: 'Invalid drawing' }).waitFor();
  const imported = { ...JSON.parse(exported), title: 'Imported sketch' }, beforeImport = writes.length;
  await file.setInputFiles({ name: 'sketch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await page.waitForFunction(() => document.querySelector('[aria-label="Drawing title"]')?.value === 'Imported sketch');
  assert.equal(writes.length, beforeImport, 'import is draft-only');
  await page.reload(); await page.waitForFunction(() => document.querySelector('[aria-label="Drawing title"]')?.value === 'Imported sketch');
  loseReply = true; await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor();
  assert.equal(await title.isDisabled(), true);
  const committed = hub.drawings.get('default', 'default').revision;
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Retry same save', exact: true }).click(); await saved();
  assert.equal(hub.drawings.get('default', 'default').revision, committed); assert.equal(writes.at(-1).mutationId, writes.at(-2).mutationId);
  await title.fill('Local conflict draft');
  const remote = hub.drawings.get('default', 'default');
  const { resourceId, updatedAt, ...remoteWrite } = remote;
  hub.drawings.save('default', 'default', { ...remoteWrite, title: 'Other tab', mutationId: crypto.randomUUID() });
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await board.getByRole('alert').filter({ hasText: 'Drawing changed elsewhere' }).waitFor();
  await page.reload(); await board.getByRole('alert').filter({ hasText: 'Drawing changed elsewhere' }).waitFor();
  assert.equal(await title.inputValue(), 'Local conflict draft');
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Refresh drawing', exact: true }).click();
  await board.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await title.inputValue(), 'Local conflict draft');
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Refresh drawing', exact: true }).click();
  await board.getByRole('button', { name: 'Discard and reload', exact: true }).click(); await saved();
  assert.equal(await title.inputValue(), 'Other tab');
  await title.fill('Offline draft'); offline = true;
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor(); offline = false;
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Retry same save', exact: true }).click(); await saved();
  await (await resourceCaption(board.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Open drawing', exact: true }).click();
  await page.getByRole('dialog', { name: 'Open drawing' }).getByRole('button', { name: 'New drawing', exact: true }).click();
  const second = page.locator('[data-workspace-pane]').filter({ has: page.getByRole('region', { name: 'Whiteboard', exact: true }) }).last();
  await second.getByRole('textbox', { name: 'Drawing title', exact: true }).fill('Second drawing');
  await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  assert.equal(hub.drawings.list('default').length, 2);
  // C2b: real mind map edits and XML import/export on the same independent resource.
  const mapStartWrites = writes.length;
  await second.getByRole('button', { name: 'Start mind map', exact: true }).click();
  await second.getByRole('textbox', { name: 'Card text', exact: true }).fill('Root & 中文😀');
  await second.getByRole('button', { name: 'Add child topic', exact: true }).click();
  await second.getByRole('textbox', { name: 'Card text', exact: true }).fill('Child <script>literal</script>');
  await second.getByRole('button', { name: 'Add sibling topic', exact: true }).click();
  await second.getByRole('textbox', { name: 'Card text', exact: true }).fill('Sibling');
  assert.equal(await second.locator('svg g').count(), 3);
  assert.equal(await second.locator('svg line').count(), 2);
  assert.equal(writes.length, mapStartWrites, 'mind map edits do not autosave Hub');
  const positions = await second.locator('svg g').evaluateAll(nodes => nodes.map(n => n.getAttribute('transform')));
  await second.getByRole('button', { name: 'Arrange mind map', exact: true }).click();
  assert.deepEqual(await second.locator('svg g').evaluateAll(nodes => nodes.map(n => n.getAttribute('transform'))), positions, 'arrange is stable');
  const xmlDownload = page.waitForEvent('download'); await second.getByRole('button', { name: 'Export draw.io file', exact: true }).click();
  const xml = await readFile(await (await xmlDownload).path(), 'utf8');
  assert.match(xml, /<mxGraphModel>/); assert.ok(!xml.includes('resourceId'));
  const xmlFile = second.locator('input[type=file]');
  const beforeXML = await second.getByRole('textbox', { name: 'Drawing title', exact: true }).inputValue();
  const malicious = [
    xml.replace('<mxfile>', '<!DOCTYPE mxfile [<!ENTITY exfil SYSTEM "http://127.0.0.1/private">]><mxfile>'),
    xml.replace('html=0', 'html=1'), xml.replace('rounded=1', 'shape=image;image=http://private'),
    xml.replace('</mxfile>', '<diagram name="Other"/></mxfile>'),
    xml.replace('<mxGraphModel>', 'compressed-content<mxGraphModel>'),
    xml.replace('width="160"', 'width="Infinity"'), xml.replace('parent="1"', 'parent="missing"'),
    xml.replace('endArrow=none', 'endArrow=classic'),
    xml.replace('relative="1"', 'relative="1" other="field"'),
    xml.replace('<mxGraphModel>', '<mxGraphModel shadow="1">'),
    xml.replace('<mxGraphModel>', '<mxGraphModel math="1">'),
    xml.replace('<root>', '<root><script>alert(1)</script>'),
    xml.replace('Root &amp;', 'Root &unknown;'), xml.replace('</root>', ''),
  ];
  for (const text of malicious) {
    await xmlFile.setInputFiles({ name: 'unsupported.drawio', mimeType: 'application/xml', buffer: Buffer.from(text) });
    await second.getByRole('alert').filter({ hasText: 'Unsupported draw.io' }).waitFor();
    assert.equal(await second.getByRole('textbox', { name: 'Drawing title', exact: true }).inputValue(), beforeXML);
    assert.equal(await second.locator('svg g').count(), 3, 'rejected import preserves all draft cards');
    assert.equal(writes.length, mapStartWrites, 'rejected XML cannot write');
  }
  await xmlFile.setInputFiles({ name: 'mindmap.drawio', mimeType: 'application/xml', buffer: Buffer.from(xml.replace('name="Second drawing"', 'name="XML restored"')) });
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Drawing title"]')].some(e => e.value === 'XML restored'));
  assert.equal(await second.locator('svg g').count(), 3); assert.equal(await second.locator('svg line').count(), 2);
  assert.equal(writes.length, mapStartWrites, 'XML import is draft-only');
  await second.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await second.getByRole('textbox', { name: 'Drawing title', exact: true }).inputValue(), 'Second drawing');
  // Captured from the real public editor's autosave protocol using synthetic content only,
  // 2026-09-29 (workspace-drawio-upstream.browser.mjs); no public service needed in this regression.
  const nativeXML = await readFile(new URL('./workspace-drawio-upstream.fixture.xml', import.meta.url));
  await xmlFile.setInputFiles({ name: 'native.drawio', mimeType: 'application/xml', buffer: nativeXML });
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Drawing title"]')].some(e => e.value === 'Synthetic interoperability check'));
  assert.equal(await second.locator('svg g').count(), 2); assert.equal(await second.locator('svg line').count(), 1);
  assert.equal(await second.locator('svg g').first().getAttribute('aria-label'), 'Edited synthetic root');
  assert.equal(await second.locator('svg g').last().getAttribute('aria-label'), 'Synthetic child');
  assert.equal(await second.locator('svg g').last().getAttribute('transform'), 'translate(300,64)');
  const backDownload = page.waitForEvent('download');
  await second.getByRole('button', { name: 'Export drawing', exact: true }).click();
  const back = JSON.parse(await readFile(await (await backDownload).path(), 'utf8'));
  assert.deepEqual(back.nodes.map(({ id, ...value }) => value), [
    { text: 'Edited synthetic root', color: '#dbeafe', x: 32, y: 32, width: 200, height: 100 },
    { text: 'Synthetic child', color: '#123456', x: 300, y: 64, width: 160, height: 64 },
  ]);
  assert.equal(back.edges[0].from, back.nodes[0].id); assert.equal(back.edges[0].to, back.nodes[1].id);
  assert.equal(writes.length, mapStartWrites, 'native XML import stays a draft');
  await second.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await second.locator('svg g').count(), 3);
  await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  const mapDocument = hub.drawings.list('default').find(d => d.title === 'Second drawing');
  const actualMap = hub.drawings.get('default', mapDocument.resourceId);
  assert.equal(actualMap.nodes.length, 3); assert.equal(actualMap.edges.length, 2);
  assert.equal(actualMap.nodes[1].text, 'Child <script>literal</script>');
  // A non-tree is left untouched, not flattened; undo removes only the connection.
  await second.locator('svg g').first().click();
  await second.getByRole('combobox', { name: 'Connect to card', exact: true }).selectOption({ label: 'Sibling' });
  // Parent->sibling already exists. Instead make the sibling point back to the root.
  await second.locator('svg g').last().click();
  await second.getByRole('combobox', { name: 'Connect to card', exact: true }).selectOption({ label: 'Root & 中文😀' });
  await second.getByRole('button', { name: 'Connect', exact: true }).click();
  await second.getByRole('button', { name: 'Arrange mind map', exact: true }).click();
  await second.getByRole('alert').filter({ hasText: 'Mind maps need a tree' }).waitFor();
  assert.equal(await second.locator('svg line').count(), 3);
  await second.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await second.locator('svg line').count(), 2);
  assert.equal(await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'undo back to saved content needs no redundant write');
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.workspace-drawing').length === 2 && [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  assert.equal(await second.locator('svg g').count(), 3); assert.equal(await second.locator('svg line').count(), 2);
  assert.equal(await second.locator('script, foreignObject, image, iframe').count(), 0);
  await page.screenshot({ path: '/tmp/agentopsdeck-233-c2b-mindmap-1440.png' });
  // Freehand: one draft mutation per completed stroke, no per-move React persistence or network.
  await second.getByRole('button', { name: 'Fit drawing', exact: true }).click();
  await second.getByRole('button', { name: 'Freehand pen', exact: true }).click();
  await second.getByLabel('Ink color', { exact: true }).fill('#f59e0b');
  await second.getByLabel('Ink width', { exact: true }).selectOption('8');
  const inkCanvas = second.getByLabel('Drawing canvas', { exact: true });
  const beginInk = async () => {
    const rect = await second.locator('svg g').first().boundingBox();
    await page.mouse.move(rect.x + 15, rect.y + 15); await page.mouse.down();
    return { x: rect.x + 15, y: rect.y + 15 };
  };
  const geometry = await second.locator('svg g').first().getAttribute('transform');
  const draftCount = await page.evaluate(() => window.inkDraftWrites), networkCount = reads.length + writes.length;
  const startInk = await beginInk();
  await page.mouse.move(startInk.x + 90, startInk.y + 35, { steps: 40 });
  assert.equal(await page.evaluate(() => window.inkDraftWrites), draftCount, 'no draft persistence during pointermove');
  assert.equal(reads.length + writes.length, networkCount, 'no requests during ink gesture');
  await inkCanvas.evaluate(svg => svg.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 999 })));
  assert.ok(await second.locator('.workspace-drawing-ink-preview').getAttribute('d'), 'unrelated pointer cannot cancel drawing');
  assert.equal(await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  await page.mouse.up();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 1);
  assert.equal(await page.evaluate(() => window.inkDraftWrites), draftCount + 1);
  assert.equal(await second.locator('svg g').first().getAttribute('transform'), geometry, 'pen on card cannot drag it');
  assert.equal(await second.locator('.workspace-drawing-ink').getAttribute('stroke'), '#f59e0b');
  assert.equal(await second.locator('.workspace-drawing-ink').getAttribute('stroke-width'), '8');
  await second.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 0);
  await beginInk(); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 0, 'escape discards unfinished ink');
  await beginInk(); await page.mouse.up();
  assert.match(await second.locator('.workspace-drawing-ink').getAttribute('d'), /l0,0$/);
  await second.getByRole('button', { name: 'Select shapes', exact: true }).click();
  await second.locator('.workspace-drawing-ink').focus();
  await second.getByRole('button', { name: 'Remove stroke', exact: true }).click();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 0);
  await second.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 1);
  await second.getByRole('button', { name: 'Export draw.io file', exact: true }).click();
  await second.getByRole('alert').filter({ hasText: 'Freehand ink needs JSON export' }).waitFor();
  await second.getByRole('alert').filter({ hasText: 'Freehand ink needs JSON export' }).getByRole('button').click();
  const inkDownloadPromise = page.waitForEvent('download');
  await second.getByRole('button', { name: 'Export drawing', exact: true }).click();
  const inkDownload = await inkDownloadPromise, inkJson = await readFile(await inkDownload.path(), 'utf8');
  assert.equal(JSON.parse(inkJson).strokes.length, 1);
  await second.getByRole('button', { name: 'Undo', exact: true }).click();
  await second.locator('input[type=file]').setInputFiles({ name: 'ink.json', mimeType: 'application/json', buffer: Buffer.from(inkJson) });
  await second.locator('.workspace-drawing-ink').waitFor({ state: 'attached' });
  await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  assert.deepEqual(hub.drawings.get('default', mapDocument.resourceId).strokes, JSON.parse(inkJson).strokes);
  await page.reload();
  await second.locator('.workspace-drawing-ink').waitFor({ state: 'attached' });
  const maximumInk = { ...JSON.parse(inkJson), strokes: Array.from({ length: 128 }, (_, row) => ({ id: crypto.randomUUID(), color: '#60a5fa', width: 4,
    points: Array.from({ length: 64 }, (_, col) => [col * 24, row * 7]) })) };
  const maxStart = performance.now();
  await second.locator('input[type=file]').setInputFiles({ name: 'max-ink.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(maximumInk)) });
  await page.waitForFunction(() => document.querySelectorAll('.workspace-drawing-ink').length === 128);
  await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  assert.equal(hub.drawings.get('default', mapDocument.resourceId).strokes.reduce((total, s) => total + s.points.length, 0), 8192);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.workspace-drawing-ink').length === 128);
  const maxImportSaveReloadMs = Math.round(performance.now() - maxStart);
  await second.getByRole('button', { name: 'Freehand pen', exact: true }).click();
  await beginInk(); await page.mouse.up();
  await second.getByText('Stroke limit reached.', { exact: false }).waitFor();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 128, 'full document budget cannot append hidden points');
  await second.getByRole('button', { name: 'Select shapes', exact: true }).click();
  await page.screenshot({ path: '/tmp/agentopsdeck-233-c2c2-ink-max.png' });
  await second.locator('input[type=file]').setInputFiles({ name: 'restore-ink.json', mimeType: 'application/json', buffer: Buffer.from(inkJson) });
  await (await resourceCaption(second.getByRole('region', { name: 'Whiteboard', exact: true }))).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-drawing-state')].every(e => e.textContent === 'Saved'));
  console.log(JSON.stringify({ maximumInk: { strokes: 128, points: 8192, importSaveReloadMs: maxImportSaveReloadMs }, pointermoveRequests: 0, pointermoveDraftWrites: 0 }));
  const countAfter = reads.length; await page.waitForTimeout(1800); assert.equal(reads.length, countAfter, 'no drawing polling');
  const snapshot = async (resourceType = 'drawing') => page.evaluate(({ resources, resourceType }) => {
    const live = window.testEventSources.filter(source => source.readyState === 1);
    if (live.length !== 1) throw Error(`expected one shared stream, got ${live.length}`);
    live[0].dispatchEvent(new MessageEvent('workspace.revisions', { data: JSON.stringify({ type: 'workspace.revisions', resourceType, resources }) }));
  }, { resources: hub.drawings.revisions('default'), resourceType });
  const remoteSave = name => {
    const d = hub.drawings.get('default', mapDocument.resourceId);
    hub.drawings.save('default', mapDocument.resourceId, { format: d.format, version: d.version, title: name, nodes: d.nodes, edges: d.edges, ...(d.strokes ? { strokes: d.strokes } : {}), revision: d.revision, mutationId: crypto.randomUUID() });
  };
  remoteSave('Synced whiteboard');
  await snapshot('native-drawio'); await page.waitForTimeout(200);
  assert.equal(reads.length, countAfter, 'same ID of another resource kind cannot reload whiteboard');
  await snapshot();
  const secondTitle = second.getByRole('textbox', { name: 'Drawing title', exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Drawing title"]')].some(input => input.value === 'Synced whiteboard'));
  const syncedReads = reads.length;
  await snapshot(); await page.waitForTimeout(200); assert.equal(reads.length, syncedReads, 'duplicate revision does not reload');
  // A pointer held before the first movement is already a local gesture.
  const cardBounds = await second.locator('svg g').first().boundingBox();
  await page.mouse.move(cardBounds.x + 10, cardBounds.y + 10); await page.mouse.down();
  remoteSave('During drag'); await snapshot(); await page.waitForTimeout(200);
  assert.equal(reads.length, syncedReads, 'remote revision cannot interrupt pointer-down');
  await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Drawing title"]')].some(input => input.value === 'During drag'));
  await second.getByRole('button', { name: 'Freehand pen', exact: true }).click();
  const beforeInkSync = reads.length;
  await beginInk(); remoteSave('During ink'); await snapshot(); await page.waitForTimeout(200);
  assert.equal(reads.length, beforeInkSync, 'remote revision cannot interrupt unfinished ink');
  await page.mouse.up();
  await second.getByText('Drawing changed elsewhere.', { exact: false }).waitFor();
  assert.equal(await second.locator('.workspace-drawing-ink').count(), 2, 'local ink retained during remote conflict');
  await second.getByRole('button', { name: 'Select shapes', exact: true }).click();
  await secondTitle.fill('Keep local drawing draft'); remoteSave('Another writer'); await snapshot();
  await second.getByText('Drawing changed elsewhere.', { exact: false }).waitFor();
  assert.equal(await secondTitle.inputValue(), 'Keep local drawing draft');
  await page.screenshot({ path: '/tmp/agentopsdeck-233-c2-whiteboard-1440.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/agentopsdeck-233-c2-whiteboard-390.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no document overflow');
  // Logout/identity change cannot display the previous user's drawing or draft.
  await page.setViewportSize({ width: 1440, height: 1000 });
  principal.userId = hub.createUser('Other').id;
  await page.reload(); await page.getByLabel('Layout presets', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Whiteboard', exact: true }).count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ status: 'PASS', reads: reads.length, writes: writes.length, errors, forbidden, productionBundle: true }));
} finally { await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true }); }
