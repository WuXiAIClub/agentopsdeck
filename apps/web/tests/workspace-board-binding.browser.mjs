// Real React UI -> Hub -> Connector -> private worker, isolated data and tokens.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { ConnectorClient } from '../../server/src/hub/connector-client.ts';
import { ConnectorTokenStore } from '../../server/src/auth/connector-token.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
import { registerConnectorBoardBindings } from '../../server/src/connector/board-bindings-http.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { registerWorkspaceAgentRoutes } from '../../server/src/routes/workspace-agent.ts';
import { loadConfig } from '../../server/src/config.ts';
import { BOARD_READ_TOOL, loadWorkerBoardTools } from '../../server/src/tools/workspace-board-worker.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-board-binding-browser-')), privateDir = join(root, 'private');
await mkdir(privateDir, { mode: 0o700 });
const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic-only'), app = new Hono(), connector = new Hono(), agent = new Hono();
const owner = 'default', principal = { userId: owner, admin: true }, scope = hub.identities.recoveryScope(principal);
const task = randomUUID(), nativeId = randomUUID(), session = encodeHubSessionId('dev', 'ghcp:fixture');
const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
hub.boards.save(owner, 'default', { revision: 0, mutationId: randomUUID(), title: 'Test board', tasks: [{ id: task, title: 'Release acceptance', status: 'todo', detail: '' }] });
hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example' });
hub.pinConnectionNode('dev', owner, hub.connectionAuthority('dev', owner), `node_${randomUUID()}`);
const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), token = tokens.createTransient(['boards:bind'], 'binding-test');
connector.use('*', async (c, next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); });
const bindings = registerConnectorBoardBindings(connector, { tokens, directories: { ghcp: privateDir }, policies: [{ owner: 'binding-test', runtime: 'ghcp', endpoint }],
  resolveSession: key => key === 'ghcp:fixture' ? { runtime: 'ghcp', sessionId: nativeId, ready: true } : undefined });
await bindings.ready;
let installs = 0, offline = false;
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_BOARD_AGENT_ENDPOINT: endpoint }), hubStore: hub,
  connectorClient: () => new ConnectorClient('https://connector.example', token.token, async request => {
    if (offline) throw Error('Synthetic offline');
    if (request.method === 'PUT') installs++;
    return connector.request(request);
  }), normalizeError: () => 'Synthetic', principal: () => principal });
registerWorkspaceAgentRoutes(agent, hub.boardCapabilities);
const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import Access from '/src/components/WorkspaceBoardAccess.tsx';import{setRecoveryScope}from'/src/api.ts';import'/src/styles.css';
setRecoveryScope(${JSON.stringify(scope)});function Test(){const[open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>Open access</button>{open&&<Access scope=${JSON.stringify(scope)} resourceId="default" onClose={()=>setOpen(false)}/>}</>}
createRoot(document.getElementById('root')).render(<React.StrictMode><Test/></React.StrictMode>);`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
  plugins: [{ name: 'isolated-binding-fixture', resolveId: id => id === '/binding-fixture.tsx' ? id : undefined,
    load: id => id === '/binding-fixture.tsx' ? entry : undefined,
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/fixture') return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/fixture', '<html><body><div id="root"></div><script type="module" src="/binding-fixture.tsx"></script></body></html>'));
    }); } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  let loseReply = true, posts = 0, histories = 0, holdAdmission = false, heldBody;
  const errors = [], responses = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'browser never visits Connector or grant endpoint');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.endsWith('/sessions/state')) return route.fulfill({ json: { revision: '1', groups: [{ sessions: [{ sessionKey: session, title: 'Isolated Copilot', sessionRef: { runtimeId: 'ghcp' } }] }] } });
    if (url.pathname.endsWith('/messages')) { histories++; return route.fulfill({ json: { messages: [] } }); }
    if (!url.pathname.startsWith('/api/hub/v1/workspace/')) return route.fulfill({ status: 404, json: {} });
    if (holdAdmission && request.method() === 'POST' && url.pathname.endsWith('/bindings')) {
      heldBody = request.postData(); return route.abort('failed');
    }
    const response = await app.request(url.pathname + url.search, { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) });
    const body = await response.text(); responses.push(body);
    if (request.method() === 'POST' && url.pathname.endsWith('/bindings')) {
      posts++; if (loseReply) { loseReply = false; return route.abort('failed'); }
    }
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const disclosure = () => page.locator('summary').filter({ hasText: 'Bind tasks to a session' });
  await page.goto(origin + '/fixture');
  await disclosure().click();
  const bindButton = page.getByRole('button', { name: 'Bind selected tasks', exact: true });
  await page.getByText('Select at least one saved task above. No manual grant is needed.', { exact: true }).waitFor();
  assert.equal(await bindButton.isDisabled(), true);
  await page.getByRole('button', { name: 'Choose tasks', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Release acceptance', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.getByRole('checkbox', { name: 'Release acceptance', exact: true }).check();
  await page.getByText('Selected tasks: 1', { exact: true }).waitFor();
  await page.getByText('Choose the session that should update these tasks.', { exact: true }).waitFor();
  assert.equal(await bindButton.isDisabled(), true);
  await page.getByRole('combobox', { name: 'Session', exact: true }).selectOption(session);
  await page.getByText('Ready to bind the selected tasks. This does not send a chat message.', { exact: true }).waitFor();
  assert.equal(await bindButton.isEnabled(), true);
  assert.equal(posts, 0); assert.equal(installs, 0, 'Selecting tasks and session never issues a grant');
  await bindButton.click();
  await page.getByRole('alert').filter({ hasText: 'Unable to confirm binding' }).waitFor();
  await page.getByText('Inspect or cancel the unconfirmed binding before creating another.', { exact: true }).waitFor();
  assert.equal(await bindButton.isDisabled(), true);
  const row = hub.boardBindings.list(owner, 'default')[0], credential = hub.boardBindings.credential(owner, 'default', row.requestId);
  assert.equal(installs, 1); assert.equal(posts, 1);
  assert.ok((await page.evaluate(() => JSON.stringify(sessionStorage))).includes(row.requestId));
  const worker = await loadWorkerBoardTools(privateDir, 'ghcp', nativeId, () => true, (url, init) => agent.request(new URL(url).pathname, init));
  assert.ok(worker); const read = await worker.invoke(BOARD_READ_TOOL, {}); assert.equal(read.error, undefined); assert.equal(read.board.tasks[0].id, task);
  await page.reload(); await disclosure().click();
  await page.getByText('Session bound', { exact: true }).waitFor();
  assert.equal(installs, 1); assert.equal(posts, 1, 'reload never repeats admission');
  await page.getByRole('button', { name: 'Inspect binding', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke grant', exact: true }).last().waitFor();
  assert.equal(installs, 1, 'inspect only reads');
  for (const text of [...responses, await page.content(), await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))]) assert.ok(!text.includes(credential.token));
  offline = true;
  const bindingPanel = page.getByRole('region', { name: 'Bind tasks to a session', exact: true });
  await bindingPanel.getByRole('button', { name: 'Revoke grant', exact: true }).click();
  await bindingPanel.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await page.getByText('Grant revoked. Connector cleanup is still pending; retry revocation when it is online.').waitFor();
  assert.ok((await worker.invoke(BOARD_READ_TOOL, {})).error, 'offline Connector does not keep Hub grant alive');
  await worker.close();
  offline = false;
  // A request lost BEFORE reaching Hub is not resolved by a 404. The explicit
  // cancellation must fence a subsequently arriving original admission.
  holdAdmission = true;
  await page.getByRole('checkbox', { name: 'Release acceptance', exact: true }).check();
  await page.getByRole('combobox', { name: 'Session', exact: true }).selectOption(session);
  await page.getByRole('button', { name: 'Bind selected tasks', exact: true }).click();
  await bindingPanel.getByRole('button', { name: 'Cancel this binding request', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'Unable to confirm binding' }).waitFor();
  assert.ok(heldBody);
  const heldId = JSON.parse(heldBody).requestId;
  await page.reload(); await disclosure().click();
  await bindingPanel.getByRole('button', { name: 'Cancel this binding request', exact: true }).click();
  await bindingPanel.getByRole('button', { name: 'Cancel this binding request', exact: true }).waitFor({ state: 'detached' });
  assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes(heldId));
  // Clean up the old revoked file first, so the cancellation fence (rather
  // than an existing-file conflict) is what rejects the delayed grant.
  await app.request(`/api/hub/v1/workspace/boards/default/bindings/${row.requestId}`, { method: 'DELETE' });
  const late = await app.request('/api/hub/v1/workspace/boards/default/bindings', { method: 'POST', body: heldBody });
  assert.equal(late.status, 409); assert.equal(installs, 1);
  assert.equal(hub.boardBindings.credential(owner, 'default', heldId), undefined);
  assert.equal(histories, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, visibleDisabledReasons: true, taskPickerFocus: true, noManualGrantRequired: true, realHubConnectorWorker: true, credentialNeverInBrowser: true, lostResponseReloadNoReplay: true, offlineRevocation: true, cancelledLateAdmission: true, installs, posts, histories }));
} finally {
  await browser?.close(); await server.close(); routes.close(); token.dispose(); await bindings.close(); hub.close(); await rm(root, { recursive: true, force: true });
}
