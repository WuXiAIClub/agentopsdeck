// Actual React/StrictMode -> Hub routes/private resolver -> Connector HTTP/SSE -> files.
// All stores and credentials are synthetic and isolated; no live service actions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { verifyArchiveSplit } from './notebook-archive-split.browser.mjs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, workspaceFileCardResource } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../../server/src/auth/connector-token.ts';
import { ConnectorWorkspaceFiles } from '../../server/src/connector/workspace-board-files.ts';
import { registerConnectorWorkspaceFiles } from '../../server/src/connector/workspace-board-files-http.ts';
import { cardFileCodec, parseCardFile, serializeCardFile } from '../../server/src/connector/workspace-file-card-format.ts';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { HubFileCardService } from '../../server/src/hub/workspace-card-file-service.ts';
import { createConnectorClientResolver } from '../../server/src/hub/connector-client.ts';
import { registerHubCardFiles } from '../../server/src/routes/hub-workspace-card-files.ts';
import { registerHubSessionNotebookRoutes } from '../../server/src/routes/hub-session-notebooks.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
import { NODE_ID_HEADER } from '../../server/src/connector/node-identity.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url)), { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-card-browser-')), directory = join(root, 'files');
await mkdir(directory, { mode: 0o700 });
const db = new DatabaseSync(':memory:'), store = new HubStore(join(root, 'hub.sqlite'), 'synthetic-test-vault');
store.ensureLocalConnection({ id: 'local', label: 'Local', connectorUrl: 'local://aod-connector', environmentId: 'local', environmentLabel: 'Local', status: 'enabled' });
const nodeId = `node_${randomUUID()}`, scope = 'f'.repeat(64), reportId = randomUUID();
store.pinConnectionNode('local', 'default', store.connectionAuthority('local', 'default'), nodeId);
const tokens = new ConnectorTokenStore(join(root, 'tokens')), token = tokens.createTransient(['boards:files'], 'default');
const sessionKey = `codex:${randomUUID()}`, sessionId = encodeHubSessionId('local', sessionKey);
const remote = new ConnectorWorkspaceFiles(db, directory, owner => owner === 'default', cardFileCodec());
const connector = new Hono();
connector.use('*', async (c, next) => { c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, nodeId); await next(); });
const routes = registerConnectorWorkspaceFiles(connector, { tokens, boards: remote, session: key => ({ exists: key === sessionKey, ready: true }) });
await routes.ready;
let writes = 0, streams = 0, loseWrite = false, failSnapshot = false, actions = 0, pausedRead;
const resolve = createConnectorClientResolver(store, { connectionId: 'local', token: token.token, dispatch: async request => {
  if (failSnapshot && request.url.endsWith('/snapshot')) { failSnapshot = false; throw Error('snapshot temporarily unavailable'); }
  if (request.url.endsWith('/subscribe')) streams++;
  if (request.url.endsWith('/writes')) writes++;
  assert.ok(new URL(request.url).pathname.startsWith('/api/connector/v1/workspace/card-files'), 'only private file transport');
  const response = await connector.fetch(request);
  if (loseWrite && request.url.endsWith('/writes')) { loseWrite = false; await response.body?.cancel(); throw Error('lost response'); }
  return response;
} }, 'card-files');
const service = new HubFileCardService(store.cardFiles, (owner, id) => {
  assert.equal(owner, 'default'); assert.equal(id, sessionId);
  return { connectionId: 'local', sessionKey, authority: store.connectionAuthority('local', owner), client: resolve('local', false, owner), valid() {} };
});
const hub = new Hono(); registerHubCardFiles(hub, { store, service, enabled: true, principal: () => ({ userId: 'default', admin: false }) });
registerHubSessionNotebookRoutes(hub, { hubStore: store, fileCards: service, fileCardsEnabled: true, principal: () => ({ userId: 'default', admin: false }) });
service.start();
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{WorkspaceDashboard}from'/src/components/WorkspaceDashboard.tsx';import Report from'/src/components/WorkspaceReport.tsx';
import{GlobalNotebookProvider,WorkspaceNotebook}from'/src/components/SessionNotebook.tsx';
import Scope from'/src/components/WorkspaceFileCardScope.tsx';import{PaneToolbarScope}from'/src/components/PaneToolbar.tsx';
import{setRecoveryScope}from'/src/api.ts';import{workspaceResourceEvents}from'/src/lib/workspace-resource-events.ts';import'/src/styles.css';
setRecoveryScope(${JSON.stringify(scope)});window.cardEvent=frame=>workspaceResourceEvents.receive(${JSON.stringify(scope)},frame);
const report=location.search.includes('report'),note=location.search.includes('notebook'),pane=note?{id:'note-pane',kind:'notebook',target:'hub',resourceId:'default'}:report?{id:'report-pane',kind:'report',resourceId:${JSON.stringify(reportId)}}:{id:'dashboard-pane',kind:'dashboard',resourceId:'catalog'};
const content=<PaneToolbarScope>{(slot,status,title)=><><header>{title}{status}{slot}</header><Scope pane={pane} scope=${JSON.stringify(scope)}>{note?<WorkspaceNotebook title="Notebook" initial={{resourceId:JSON.stringify(['hub-notebook-layout',1,'default']),revision:0,text:'',updatedAt:null}}/>:report?<Report scope=${JSON.stringify(scope)} resourceId=${JSON.stringify(reportId)}/>:<WorkspaceDashboard sessions={[]} onSelect={()=>{throw Error('No service action')}}/>}</Scope></>}</PaneToolbarScope>;
createRoot(document.getElementById('root')).render(<React.StrictMode>{note?<GlobalNotebookProvider>{content}</GlobalNotebookProvider>:content}</React.StrictMode>);`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
  plugins: [{ name: 'isolated-file-card', resolveId: id => id === '/file-card-fixture.tsx' ? id : undefined,
    load: id => id === '/file-card-fixture.tsx' ? entry : undefined,
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/fixture')) return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/fixture', '<html><body><div id="root" style="height:90vh"></div><script type="module" src="/file-card-fixture.tsx"></script></body></html>'));
    }); } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 } });
const until = async predicate => { const end = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < end, 'file projection deadline'); await new Promise(resolve => setTimeout(resolve, 20)); } };
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  const errors = [], configurationReads = []; let histories = 0, sends = 0;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { actions++; return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.includes('/messages')) histories++;
    if (url.pathname.includes('/send')) sends++;
    if (url.pathname.endsWith('/sessions/state')) return route.fulfill({ json: { revision: '1', groups: [{ sessions: [{ sessionKey: sessionId, title: 'Existing session', sessionRef: { runtimeId: 'codex' } }] }] } });
    const response = await hub.request(url.pathname, { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) });
    const body = await response.text();
    if (request.method() === 'GET' && url.pathname.endsWith('/configuration')) {
      assert.equal(response.status, 200, 'optional card configuration is not a missing-file 404');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      configurationReads.push(JSON.parse(body));
    }
    if (pausedRead && !pausedRead.seen && request.method() === 'GET' && url.pathname === pausedRead.path) {
      pausedRead.seen = true; await pausedRead.wait;
    }
    return route.fulfill({ status: response.status, body, contentType: 'application/json' });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => dialog.accept());
  const dialog = page.getByRole('dialog', { name: 'Card file sync' });
  const open = () => page.getByRole('button', { name: 'Card file sync', exact: true }).click();
  const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const link = async () => {
    await dialog.getByRole('button', { name: 'Link card to session', exact: true }).click();
    const panel = dialog.getByRole('group', { name: 'Link card to session', exact: true });
    await panel.getByRole('combobox', { name: 'Session', exact: true }).selectOption(sessionId);
    await panel.getByRole('button', { name: 'Link card to session', exact: true }).click();
    await panel.getByText('Linked · file-synced card', { exact: true }).waitFor();
  };
  const notify = (type, resources) => page.evaluate(frame => window.cardEvent(frame), { type: 'workspace.revisions', resourceType: type, resources });
  await page.goto(origin + '/fixture');
  await until(() => configurationReads.length > 0);
  assert.deepEqual(configurationReads[0], { document: null }, 'new service card has no saved configuration');
  await open();
  await dialog.getByRole('button', { name: 'Save current settings' }).click().catch(async error => { console.error({ errors, text: await page.locator('body').innerText() }); throw error; });
  await link();
  const binding = store.cardFiles.active().find(b => b.userId === 'default');
  assert.ok(binding); const resource = binding.resourceId, path = remote.get('default', binding.bindingId).path;
  await until(() => !!store.cardFiles.get('default', binding.bindingId)?.sourceHash);
  await close();
  await writeFile(path, serializeCardFile({ kind: 'dashboard', content: { title: 'Agent dashboard', description: 'Only explicit apply', items: [] } }));
  await until(() => store.cardFileProjection.get('default', resource)?.content.title === 'Agent dashboard');
  await notify('card-configuration', [{ resourceId: resource, revision: store.cardFileProjection.get('default', resource).revision }]);
  assert.equal(await page.getByText('Only explicit apply', { exact: true }).count(), 0, 'file update must not apply service settings');
  // Deliver a newer revision while an old GET is in flight. It must be
  // coalesced and reread after the lock releases, not silently dropped.
  let releaseRead;
  pausedRead = { path: '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource), seen: false,
    wait: new Promise(resolve => { releaseRead = resolve; }) };
  await open(); await until(() => pausedRead.seen);
  await writeFile(path, serializeCardFile({ kind: 'dashboard', content: { title: 'Agent during load', description: 'Only explicit apply', items: [{ label: 'Read race', value: 'Latest' }] } }));
  await until(() => store.cardFileProjection.get('default', resource)?.content.title === 'Agent during load');
  await notify('card-file-binding', store.cardFiles.revisions('default'));
  releaseRead();
  await dialog.getByText(/Agent during load · Revision/).waitFor();
  pausedRead = undefined; await close();
  await open(); await dialog.getByRole('button', { name: 'Use file settings' }).click(); await close();
  await page.getByText('Only explicit apply', { exact: true }).waitFor();
  await open(); await dialog.getByText('Edit desired settings', { exact: true }).click();
  const editor = dialog.getByRole('textbox', { name: 'Card settings JSON' });
  const invalidBefore = writes;
  await editor.fill('{broken JSON');
  await dialog.getByRole('button', { name: 'Save current settings' }).click();
  await dialog.getByText('Invalid card settings. Keep the expected JSON fields and value types. Nothing was sent; your draft is kept.', { exact: true }).waitFor();
  assert.equal(await editor.getAttribute('aria-invalid'), 'true');
  assert.equal(await editor.inputValue(), '{broken JSON');
  assert.equal(writes, invalidBefore, 'invalid JSON is rejected before any write');
  await editor.fill(JSON.stringify({ title: 'My draft', description: 'Draft kept', items: [] }));
  // Reload preserves an unsubmitted draft, including its old CAS revision.
  await page.reload(); await open(); await dialog.getByText('Edit desired settings', { exact: true }).click();
  assert.ok((await editor.inputValue()).includes('My draft'));
  await writeFile(path, serializeCardFile({ kind: 'dashboard', content: { title: 'Concurrent agent', description: 'New revision', items: [] } }));
  await until(() => store.cardFileProjection.get('default', resource)?.content.title === 'Concurrent agent');
  await notify('card-file-binding', store.cardFiles.revisions('default'));
  await dialog.getByText(/Concurrent agent · Revision/).waitFor();
  assert.ok((await editor.inputValue()).includes('My draft'), 'incoming metadata never replaces a human draft');
  await dialog.getByRole('button', { name: 'Save current settings' }).click();
  await dialog.getByText('File changed elsewhere. Your draft is kept.', { exact: true }).waitFor();
  assert.equal(parseCardFile(await readFile(path)).content.content.title, 'Concurrent agent');
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).last().click();
  await editor.fill(JSON.stringify({ title: 'Once only', description: 'Saved after lost response', items: [] }));
  const before = writes; loseWrite = true;
  await dialog.getByRole('button', { name: 'Save current settings' }).click();
  failSnapshot = true;
  await dialog.getByRole('button', { name: 'Check file save' }).click();
  await dialog.getByText('Card sync could not be confirmed. Your draft is kept; inspect a pending save before retrying.', { exact: true }).waitFor();
  assert.ok((await editor.inputValue()).includes('Once only'), 'readback outage retains draft even if remote receipt says saved');
  assert.equal(writes, before + 1);
  await dialog.getByRole('button', { name: 'Check file save' }).click();
  await until(() => writes === before + 1);
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Check file save'));
  assert.equal(parseCardFile(await readFile(path)).content.content.title, 'Once only');
  await dialog.getByText('Card saved. The Agent can read the updated file on its next read.', { exact: true }).waitFor();
  const surface = await dialog.evaluate(e => ({ background: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color }));
  assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)', 'sync dialog must be opaque');
  assert.notEqual(surface.background, surface.color, 'text must contrast with the surface');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'mobile dialog fits'); await close();

  // Native rich-text report: title/text are one file, private delegation explicit.
  await page.goto(origin + '/fixture?report');
  const title = page.getByRole('textbox', { name: 'Card title', exact: true });
  await title.fill('Private report');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Card title"]')?.value === 'Private report' && !document.querySelector('input[aria-label="Card title"]')?.disabled);
  await open(); assert.equal(await dialog.getByRole('button', { name: 'Link card to session', exact: true }).isDisabled(), true);
  await dialog.getByRole('checkbox').check(); await link();
  const reportResource = workspaceFileCardResource('report', reportId), reportBinding = store.cardFiles.current('default', reportResource);
  const reportPath = remote.get('default', reportBinding.bindingId).path;
  await notify('card-file-binding', store.cardFiles.revisions('default'));
  await close();
  await writeFile(reportPath, serializeCardFile({ kind: 'report', content: { title: 'Agent report', text: '# Findings\n\n- [ ] Review results' } }));
  await until(() => store.cardFileProjection.get('default', reportResource)?.content.title === 'Agent report');
  await notify('report', store.cardFileProjection.revisions('default'));
  await page.waitForFunction(() => document.querySelector('input[aria-label="Card title"]')?.value === 'Agent report');
  await page.getByText('Findings', { exact: true }).waitFor();
  await title.fill('Owner edit'); await open();
  assert.equal(await dialog.count(), 0, 'dirty native editor prevents binding changes');
  const reportBefore = writes;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await until(() => writes === reportBefore + 1);
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Card title"]').disabled);
  assert.equal(parseCardFile(await readFile(reportPath)).content.content.title, 'Owner edit');
  await page.locator('.workspace-report').getByRole('checkbox', { name: 'To-do list: Review results' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Card title"]').disabled);
  const observedReport = parseCardFile(await readFile(reportPath)).content;
  assert.match(observedReport.content.text, /- \[x\] Review results/i, 'Agent reads a human-toggled TODO, not just a renamed title');
  await writeFile(reportPath, serializeCardFile({ ...observedReport, content: { ...observedReport.content, text: observedReport.content.text + '\n\nAgent read the completed review.' } }));
  await until(() => store.cardFileProjection.get('default', reportResource)?.content.text.includes('Agent read the completed review.'));
  await notify('report', store.cardFileProjection.revisions('default'));
  await page.getByText('Agent read the completed review.', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-report').getByRole('checkbox', { name: 'To-do list: Review results' }).isChecked(), true);

  // The docked notebook is a portal with a separate autosave controller. Test
  // its real ancestry/dirty guard and shared file metadata, not a mock editor.
  await page.setViewportSize({ width: 1100, height: 900 });
  const noteId = JSON.stringify(['hub-notebook', 1]);
  assert.ok(store.notebooks.saveArchive('default', { resourceId: noteId, revision: 0, text: 'Existing private archive' }));
  await page.goto(origin + '/fixture?notebook');
  const note = page.locator('[data-remote-notebook="default"][role="region"]');
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  await note.getByRole('textbox').fill('Private note');
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  await open(); await dialog.getByRole('checkbox').check(); await link(); await close();
  const noteResource = workspaceFileCardResource('notebook', 'hub:default');
  const noteBinding = store.cardFiles.current('default', noteResource);
  const notePath = remote.get('default', noteBinding.bindingId).path;
  assert.equal(parseCardFile(await readFile(notePath)).content.content.archive, 'Existing private archive');
  await open();
  assert.equal(await dialog.getByText(/Hot notes and the real archive share this file binding/).count(), 0, 'normal full binding has no persistent explanation');
  assert.equal(await dialog.getByText('Standalone notebook API access (optional)', { exact: true }).count(), 0);
  await close();
  await notify('card-file-binding', store.cardFiles.revisions('default'));
  await writeFile(notePath, serializeCardFile({ kind: 'notebook', content: { title: 'Shared tips', text: 'Agent note', archive: 'Agent archive' } }));
  await until(() => store.cardFileProjection.get('default', noteResource)?.content.text === 'Agent note');
  await notify('card-file-binding', store.cardFiles.revisions('default'));
  await note.getByText('Agent note', { exact: true }).waitFor();
  await note.getByRole('textbox').fill('Owner note');
  await open(); assert.equal(await dialog.count(), 0, 'portal dirty editor prevents binding changes');
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  assert.equal(parseCardFile(await readFile(notePath)).content.content.text.trim(), 'Owner note');
  assert.equal(parseCardFile(await readFile(notePath)).content.content.archive, 'Agent archive', 'hot save preserves cold archive');
  await page.reload();
  await note.getByText('Owner note', { exact: true }).waitFor();
  await note.getByText('Saved to Hub', { exact: true }).waitFor();
  // Existing hot-only bindings stay private until the owner explicitly expands
  // the SAME association. No notebook Agent-token endpoint is involved.
  await service.revoke('default', noteResource, noteBinding.bindingId);
  const originalClaim = store.cardFileProjection.claim.bind(store.cardFileProjection);
  store.cardFileProjection.claim = (owner, resource, binding) => originalClaim(owner, resource, binding, false);
  const legacy = await service.bind('default', noteResource, { requestId: randomUUID(), sessionId,
    revision: store.cardFileProjection.get('default', noteResource).revision });
  store.cardFileProjection.claim = originalClaim;
  await service.writable('default', noteResource);
  const legacyPath = remote.get('default', legacy.bindingId).path;
  assert.equal(parseCardFile(await readFile(legacyPath)).content.content.archive, undefined);
  await page.reload(); await note.getByText('Saved to Hub', { exact: true }).waitFor();
  await open(); await dialog.getByRole('checkbox', { name: 'Include this private archive in the existing Agent file binding.' }).waitFor();
  await page.screenshot({ path: '/tmp/agentopsdeck-unified-archive-legacy.png' });
  const include = dialog.getByRole('button', { name: 'Include archive in file sync', exact: true });
  assert.equal(await include.isEnabled(), false);
  await dialog.getByRole('checkbox', { name: 'Include this private archive in the existing Agent file binding.' }).check();
  loseWrite = true;
  const beforeUpgrade = writes;
  await include.click();
  await dialog.getByText(/Archive sync outcome pending/).waitFor();
  assert.equal(writes, beforeUpgrade + 1);
  // Remount automatically inspects the persisted UUID, without replaying POST.
  await page.reload(); await note.getByText('Saved to Hub', { exact: true }).waitFor(); await open();
  await until(() => store.cardFileProjection.get('default', noteResource)?.content.archive === 'Agent archive');
  await dialog.locator('.notebook-file-sync').waitFor({ state: 'detached' });
  assert.equal(await dialog.getByText(/Hot notes and the real archive share this file binding/).count(), 0);
  assert.equal(writes, beforeUpgrade + 1);
  assert.equal(store.cardFiles.current('default', noteResource).bindingId, legacy.bindingId);
  assert.equal(parseCardFile(await readFile(legacyPath)).content.content.archive, 'Agent archive');
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = dialog;
  assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'archive sync panel fits mobile');
  await page.screenshot({ path: '/tmp/agentopsdeck-unified-archive-mobile.png' });
  await close(); await page.setViewportSize({ width: 1100, height: 900 });
  await note.locator('.notebook-archive-toggle > summary').click();
  const archive = note.getByRole('textbox', { name: 'Notebook archive', exact: true });
  await archive.waitFor();
  await verifyArchiveSplit(page, note, note.locator('.notebook-rich-editor'));
  await archive.fill('Owner edited archive'); await archive.blur();
  await until(() => store.notebooks.getArchive('default', noteId).text === 'Owner edited archive');
  assert.equal(parseCardFile(await readFile(legacyPath)).content.content.archive, 'Owner edited archive');
  assert.equal(parseCardFile(await readFile(legacyPath)).content.content.text.trim(), 'Owner note');
  assert.equal(await note.getByRole('button', { name: 'Issue notebook grant', exact: true }).count(), 0);
  assert.equal(histories, 0); assert.equal(sends, 0); assert.equal(actions, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, writes, streams, histories, sends, actions, covered: ['StrictMode', 'service explicit apply', 'stable layout identity', 'private consent', 'invalid JSON no write', 'revision during in-flight read', 'durable draft', 'Agent update preserves draft', 'conflict', 'lost reply inspect once', 'save confirmation', 'opaque themed surface', 'native report TODO human-to-file-to-Agent-to-UI', 'notebook portal autosave/reload', 'dirty guard', 'metadata refresh', 'whole notebook including archive', 'legacy scope consent', 'upgrade remount original receipt without resend', 'archive editor writes same file without API token', 'mobile'] }));
} catch (error) { console.error('Browser evidence:', await browser?.contexts()[0]?.pages()[0]?.locator('body').innerText()); throw error; }
finally { await browser?.close(); await server.close(); await service.close(); await routes.close(); store.close(); db.close(); await rm(root, { recursive: true, force: true }); }
