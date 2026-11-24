// Real React -> owner Hub routes -> Connector HTTP/SSE -> isolated normal files.
// No live services, credentials, model calls or chat history reads.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../../server/src/auth/connector-token.ts';
import { ConnectorFileBoards } from '../../server/src/connector/workspace-board-files.ts';
import { registerConnectorFileBoards } from '../../server/src/connector/workspace-board-files-http.ts';
import { serializeBoardFile } from '../../server/src/connector/workspace-board-file-format.ts';
import { ConnectorClient } from '../../server/src/hub/connector-client.ts';
import { WorkspaceBoards } from '../../server/src/hub/workspace-boards.ts';
import { WorkspaceBoardFiles, publicFileBoardBinding } from '../../server/src/hub/workspace-board-files.ts';
import { HubFileBoardService } from '../../server/src/hub/workspace-board-file-service.ts';
import { registerHubBoardFiles } from '../../server/src/routes/hub-workspace-board-files.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const runtime = process.env.AOD_TEST_BOARD_RUNTIME ?? 'codex';
assert.ok(['codex', 'claude-code', 'ghcp'].includes(runtime), 'explicit supported fixture runtime');
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-board-browser-'));
const directory = join(root, 'files'); await mkdir(directory, { mode: 0o700 });
const cdb = new DatabaseSync(':memory:'), hdb = new DatabaseSync(':memory:');
const tokens = new ConnectorTokenStore(join(root, 'tokens'));
const token = tokens.createTransient(['boards:files'], 'owner');
const sessionKey = `${runtime}:${randomUUID()}`, scope = 'f'.repeat(64);
const remote = new ConnectorFileBoards(cdb, directory, (owner, key) => owner === 'owner' && key === sessionKey);
const connector = new Hono(); connector.use('*', async (c, next) => { c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); await next(); });
const remoteRoutes = registerConnectorFileBoards(connector, { tokens, boards: remote, session: key => ({ exists: key === sessionKey, ready: true }) });
await remoteRoutes.ready;
let installs = 0, streams = 0;
const client = new ConnectorClient('http://connector.test', token.token, async request => {
  if (request.method === 'PUT' && !request.url.includes('/writes')) installs++;
  if (request.url.endsWith('/subscribe')) streams++;
  return connector.fetch(request);
});
const boards = new WorkspaceBoards(hdb), files = new WorkspaceBoardFiles(hdb, boards, b => b.userId === 'owner' && b.authority === 1);
const service = new HubFileBoardService(files, boards, (owner, session) => {
  assert.equal(owner, 'owner'); assert.equal(session, sessionKey);
  return { connectionId: 'connector', sessionKey, authority: 1, client, valid() {} };
});
const app = new Hono();
app.get('/api/hub/v1/workspace/boards', c => c.json({ boards: boards.list('owner') }));
app.get('/api/hub/v1/workspace/boards/:id', c => {
  const fileBinding = files.current('owner', c.req.param('id'));
  return c.json({ ...boards.get('owner', c.req.param('id')), ...(fileBinding ? { fileBinding: publicFileBoardBinding(fileBinding) } : {}) });
});
registerHubBoardFiles(app, { files, service, principal: () => ({ userId: 'owner' }) }); service.start();
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import Board from '/src/components/WorkspaceTaskboard.tsx';import{setRecoveryScope}from'/src/api.ts';
import{workspaceResourceEvents}from'/src/lib/workspace-resource-events.ts';import'/src/styles.css';
setRecoveryScope(${JSON.stringify(scope)});window.boardEvent=(frame)=>workspaceResourceEvents.receive(${JSON.stringify(scope)},frame);
createRoot(document.getElementById('root')).render(<React.StrictMode><Board scope=${JSON.stringify(scope)} onOpen={()=>{}}/></React.StrictMode>);`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
  plugins: [{ name: 'isolated-file-board', resolveId: id => id === '/file-board-fixture.tsx' ? id : undefined,
    load: id => id === '/file-board-fixture.tsx' ? entry : undefined,
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/fixture') return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/fixture', '<html><body><div id="root"></div><script type="module" src="/file-board-fixture.tsx"></script></body></html>'));
    }); } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 } });
let browser;
const until = async predicate => { const end = Date.now() + 5000; while (!await predicate()) { assert.ok(Date.now() < end, 'file projection deadline'); await new Promise(resolve => setTimeout(resolve, 20)); } };
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  let histories = 0, sends = 0, loseResponse = true, dropBeforeBind = false;
  const errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'no browser request goes to Connector');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.endsWith('/sessions/state')) return route.fulfill({ json: { revision: '1', groups: [{ sessions: [{ sessionKey, title: `Existing ${runtime}`, sessionRef: { runtimeId: runtime } }] }] } });
    if (url.pathname.endsWith('/messages')) histories++;
    if (url.pathname.includes('/commands') || url.pathname.includes('/send')) sends++;
    if (dropBeforeBind && request.method() === 'POST' && url.pathname.endsWith('/file-binding')) {
      dropBeforeBind = false; return route.abort('failed');
    }
    const response = await app.request(url.pathname, { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) });
    if (request.method() === 'POST' && url.pathname.endsWith('/file-binding') && loseResponse) { loseResponse = false; await response.body?.cancel(); return route.abort('failed'); }
    return route.fulfill({ status: response.status, body: await response.text(), contentType: 'application/json' });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.goto(origin + '/fixture');
  const title = page.getByRole('textbox', { name: 'Board title', exact: true }); await title.waitFor();
  await page.getByRole('button', { name: 'Link whole board', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Link whole board', exact: true });
  try { await panel.getByRole('combobox', { name: 'Session', exact: true }).selectOption(sessionKey, { timeout: 10000 }); }
  catch (error) { console.error(await page.locator('body').innerText(), errors); throw error; }
  assert.equal(installs, 0, 'selection alone does not mutate');
  await panel.getByRole('button', { name: 'Link whole board', exact: true }).click();
  await panel.getByText('Binding result unconfirmed. Check first; retry uses the same request and never sends a chat message.').waitFor();
  await panel.getByRole('button', { name: 'Check binding', exact: true }).click();
  await panel.getByText('Linked · file-driven board', { exact: true }).waitFor();
  assert.equal(installs, 1);
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Board title"]').disabled);
  const binding = files.current('owner', 'default'), path = remote.get('owner', binding.bindingId).path;
  await title.fill('Owner edited the linked file');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => {
    try { return JSON.parse(await readFile(path, 'utf8')).title === 'Owner edited the linked file'; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  await until(() => boards.get('owner', 'default').title === 'Owner edited the linked file');
  await page.locator('.workspace-taskboard[data-board-ready="true"]').waitFor();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await title.fill('Autosaved through the real Connector file');
  await page.locator('.workspace-taskboard[data-board-ready="true"]').waitFor();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).title, 'Autosaved through the real Connector file');
  assert.equal(boards.get('owner', 'default').title, 'Autosaved through the real Connector file');
  await page.getByRole('button', { name: 'Link whole board', exact: true }).click();
  await panel.getByText('Linked · file-driven board', { exact: true }).waitFor();
  const tasks = [{ id: randomUUID(), title: 'Agent added this after binding', detail: '', status: 'done' }];
  await writeFile(path, serializeBoardFile({ title: 'File-owned board', tasks }));
  await until(() => boards.get('owner', 'default').tasks.length === 1);
  await page.evaluate(frame => window.boardEvent(frame), { type: 'workspace.revisions', resourceType: 'taskboard', resources: boards.revisions('owner') });
  const agentTask = page.getByRole('button', { name: 'Agent added this after binding', exact: true });
  await agentTask.waitFor();
  const completedFile = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Hide completed tasks', exact: true }).click();
  await agentTask.waitFor({ state: 'detached' });
  assert.equal(await readFile(path, 'utf8'), completedFile, 'view setting must not rewrite the Agent file');
  assert.equal(boards.get('owner', 'default').tasks[0].status, 'done');
  await page.getByRole('button', { name: 'Show completed tasks', exact: true }).click();
  await agentTask.waitFor();
  await writeFile(path, '{unfinished'); await until(() => !!files.current('owner', 'default').problem);
  await page.evaluate(frame => window.boardEvent(frame), { type: 'workspace.revisions', resourceType: 'taskboard-binding', resources: files.revisions('owner') });
  await panel.getByText('File sync paused. The last valid board is retained.', { exact: true }).waitFor();
  assert.equal(boards.get('owner', 'default').tasks.length, 1);
  await panel.getByRole('button', { name: 'Unlink board', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm unlink', exact: true }).click();
  await until(() => !files.current('owner', 'default'));
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Board title"]').disabled);
  await panel.getByRole('combobox', { name: 'Session' }).waitFor();
  assert.ok(await panel.getByRole('combobox', { name: 'Session' }).isVisible(), 'unlink permits a new selection without reopening');
  dropBeforeBind = true;
  await panel.getByRole('combobox', { name: 'Session', exact: true }).selectOption(sessionKey);
  await panel.getByRole('button', { name: 'Link whole board', exact: true }).click();
  await panel.getByText('Binding result unconfirmed. Check first; retry uses the same request and never sends a chat message.').waitFor();
  const pending = await page.evaluate(() => Object.keys(sessionStorage).map(key => {
    try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
  }).find(value => value?.requestId && value?.sessionId));
  assert.ok(pending?.requestId);
  await panel.getByRole('button', { name: 'Cancel pending binding', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Session"]').disabled);
  assert.equal(files.current('owner', 'default'), undefined);
  await assert.rejects(service.bind('owner', 'default', pending), /unavailable/i);
  assert.equal(histories, 0); assert.equal(sends, 0); assert.equal(installs, 1); assert.equal(streams, 1); assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await panel.isVisible());
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'binding controls fit mobile width');
  console.log(JSON.stringify({ passed: true, runtime, installs, streams, histories, sends, covered: ['empty board', 'existing session', 'lost reply inspect', 'autosave through real Connector file', 'future task', 'invalid file last-good', 'metadata-only notification', 'unlink', 'cancel pending / late arrival', 'mobile', 'StrictMode'] }));
} finally {
  await browser?.close(); await server.close(); await service.close(); await remoteRoutes.close(); cdb.close(); hdb.close();
  await rm(root, { recursive: true, force: true });
}
