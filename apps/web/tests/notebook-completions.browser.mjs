// Real isolated Hub database/routes and production components; no live writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build, preview } from 'vite';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { registerHubSessionNotebookRoutes } from '../../server/src/routes/hub-session-notebooks.ts';
import { registerHubCompletions } from '../../server/src/routes/hub-completions.ts';
import { cardFileFixture } from '../../server/src/hub/workspace-card-file-fixture.ts';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../server/package.json', import.meta.url)), { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-notebook-completions-')), root = fileURLToPath(new URL('..', import.meta.url));
const bound = process.env.AOD_TEST_BOUND_NOTEBOOK === '1' ? await cardFileFixture() : undefined;
const store = bound?.store ?? new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), app = new Hono();
const principal = () => ({ userId: 'default', admin: true });
const routes = bound ? undefined : registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
  connectorClient: () => { throw Error('No real Connector'); }, normalizeError: () => 'Synthetic', principal });
if (bound) {
  registerHubSessionNotebookRoutes(app, { hubStore: store, fileCards: bound.service, principal });
  registerHubCompletions(app, store, principal);
}
store.upsertConnection({ id: 'node', label: 'Synthetic', connectorUrl: 'http://node', capabilities: ['events'], credentialToken: 'synthetic' });
store.pinConnectionNode('node', 'default', store.connectionAuthority('node'), 'node_00000000-0000-4000-8000-000000000001');
const document = await (await app.request('/api/hub/v1/notebooks/default')).json();
store.notebooks.save('default', { ...document, text: 'Keep here. Archive this old paragraph.' });
if (bound) {
  const resource = workspaceFileCardResource('notebook', 'hub:default');
  await bound.service.bind('default', resource, { requestId: randomUUID(), sessionId: bound.sessionId, revision: 1 });
  await bound.service.writable('default', resource);
}
let serial = 0;
const complete = turn => { for (const phase of ['running', 'completed']) store.appendDelivery({ envConnectionId: 'node', type: 'session.updated', remoteSessionKey: 'codex:one', ts: 110,
  payload: { runtime: { phase, turnId: turn, operation: 'message', connection: 'connected', sync: 'current', lastEventAt: 110 } } }, 'domain', String(++serial), 'default', 100); };
complete('one');
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(directory, 'dist'), rollupOptions: { input: join(root, 'tests/fixtures/notebook-completions.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: join(directory, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 960, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { localStorage.setItem('agentopsdeck.locale', 'en'); Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.testClipboard = text; } } }); });
  const page = await context.newPage(), errors = [], forbidden = [], moves = [];
  let dropAck = true, freshDuringAck = true, readCount = 0, grantPosts = 0, dropGrant = false, holdGrant;
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (!/^\/api\/hub\/v1\/(notebooks(?:$|\/default(?:$|\/))|completions\/|workspace\/file-cards\/)/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort(); }
    if (!bound && url.pathname.startsWith('/api/hub/v1/workspace/file-cards/')) {
      assert.equal(req.method(), 'GET');
      return route.fulfill({ json: url.pathname.endsWith('/file-binding') ? { enabled: true, binding: null }
        : { version: 1, kind: 'notebook', revision: 1, content: { text: '', archive: '' } } });
    }
    if (url.pathname.endsWith('/read')) { readCount++; if (freshDuringAck) { complete('two'); freshDuringAck = false; } }
    const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
    if (url.pathname.endsWith('/capabilities') && req.method() === 'POST') {
      grantPosts++; assert.equal(response.status, 201);
      if (dropGrant) { dropGrant = false; return route.abort('connectionfailed'); }
      if (holdGrant) await holdGrant;
    }
    if (url.pathname.endsWith('/moves') && req.method() === 'POST') { moves.push(req.postDataJSON().requestId); assert.equal(response.status, 200); if (dropAck) { dropAck = false; return route.abort('connectionfailed'); } }
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  const goto = () => page.goto(`${origin}/tests/fixtures/notebook-completions.html?scope=${store.identities.recoveryScope({ userId: 'default', admin: true })}`);
  await goto();
  await page.waitForFunction(() => document.querySelector('[aria-label="Unread"]')?.textContent === '1').catch(async error => {
    throw new Error(JSON.stringify({ message: error.message, errors, forbidden, text: await page.locator('body').innerText() }));
  });
  await page.getByRole('button', { name: 'Toggle active pane' }).click(); await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  assert.equal(readCount, 0, 'inactive panes cannot mark read');
  await page.getByRole('button', { name: 'Toggle active pane' }).click(); await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Unread"]')?.textContent === '1');
  await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Unread"]')?.textContent === '0');
  await page.getByText('Move or search notebook text', { exact: true }).click();
  const selection = page.getByRole('textbox', { name: 'Select text to move', exact: true });
  assert.equal(await selection.inputValue(), 'Keep here. Archive this old paragraph.');
  await selection.focus();
  await selection.evaluate(el => { el.setSelectionRange(11, el.value.length); document.dispatchEvent(new Event('selectionchange')); });
  assert.deepEqual(await selection.evaluate(el => [el.selectionStart, el.selectionEnd]), [11, 38]);
  await page.getByRole('button', { name: 'Archive selected text', exact: true }).click().catch(async error => {
    throw new Error(JSON.stringify({ message: error.message, errors, forbidden, text: await page.locator('main').innerText(), range: await selection.evaluate(el => [el.selectionStart, el.selectionEnd]) }));
  });
  await page.getByRole('button', { name: 'Check original receipt', exact: true }).waitFor();
  // The receipt button appears as soon as the UUID is stored, before a bound
  // Connector write finishes. Wait for the deliberately lost ACK before reload
  // so this tests receipt recovery, not navigation aborting an in-flight request.
  await page.getByText('Move not confirmed. Check the original receipt; do not repeat the move.', { exact: true }).waitFor();
  await page.reload(); await page.getByText('Move or search notebook text', { exact: true }).click();
  assert.equal(moves.length, 1, 'reload never replays uncertain move');
  await page.getByRole('button', { name: 'Check original receipt', exact: true }).click();
  await page.getByText('Move completed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Notebook archive', exact: true }).inputValue(), 'Archive this old paragraph.');
  assert.equal(await page.locator('[aria-label="Hot text"]').textContent(), 'Keep here. ');
  const search = page.getByRole('textbox', { name: 'Search notebook text', exact: true }); await search.fill('old paragraph');
  await page.getByRole('button', { name: 'Search notebook text', exact: true }).click();
  assert.equal(await page.locator('.notebook-archive li').count(), 0, 'cold content excluded by default');
  await page.getByLabel('Include cold archive').check(); await page.getByRole('button', { name: 'Search notebook text', exact: true }).click();
  await page.locator('.notebook-archive li button').click();
  await page.getByRole('button', { name: 'Restore selected text', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Hot text"]')?.textContent === 'Keep here. \n\nold paragraph');
  assert.equal(moves.length, 2); assert.notEqual(moves[0], moves[1]);
  if (bound) assert.equal(bound.writes(), 2, 'lost browser ACK does not duplicate a Connector write');
  if (bound) {
    assert.equal(await page.getByText('Standalone notebook API access (optional)', { exact: true }).count(), 0, 'full file binding needs no second authorization');
    assert.equal(grantPosts, 0);
  } else {
  const openGrants = () => page.getByText('Standalone notebook API access (optional)', { exact: true }).click();
  await openGrants();
  const access = page.getByRole('region', { name: 'Notebook Agent authorization', exact: true });
  await access.getByRole('button', { name: 'Refresh grants' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
  assert.equal(await access.locator('input:checked').count(), 0, 'no permissions selected implicitly');
  assert.equal(await access.getByLabel('Move text between hot and cold').isDisabled(), true);
  await access.getByLabel('Read cold archive text').check();
  await access.getByLabel('Confirm selected notebook permissions').check();
  await access.getByRole('button', { name: 'Issue notebook grant' }).click();
  await access.getByRole('button', { name: 'Copy grant token' }).click();
  const token = await page.evaluate(() => window.testClipboard);
  assert.match(token, /^aod_note_/);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.request('/api/workspace-agent/v1/notebook?area=cold', { headers })).status, 200);
  assert.equal((await app.request('/api/workspace-agent/v1/notebook', { headers })).status, 403);
  assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('aod_note_')), false);
  assert.equal((await page.locator('body').innerText()).includes(token), false);
  await access.getByRole('button', { name: 'Revoke grant' }).click();
  await access.getByText('Revoked grant', { exact: false }).waitFor();
  assert.equal((await app.request('/api/workspace-agent/v1/notebook?area=cold', { headers })).status, 401);
  dropGrant = true;
  await access.getByLabel('Confirm selected notebook permissions').check();
  await access.getByRole('button', { name: 'Issue notebook grant' }).click();
  await access.getByText(/Grant outcome unconfirmed/).waitFor();
  assert.equal(grantPosts, 2); assert.equal(await access.getByRole('button', { name: 'Issue notebook grant' }).isDisabled(), true);
  await access.getByRole('button', { name: 'Refresh grants' }).click();
  await access.getByText('Active grant', { exact: false }).waitFor();
  assert.equal(grantPosts, 2, 'refresh never reissues');
  assert.equal(await access.getByRole('button', { name: 'Copy grant token' }).count(), 0, 'lost token is not recoverable');
  await access.getByRole('button', { name: 'Revoke grant' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Notebook Agent authorization"] li button')].every(b => b.disabled));
  let release; holdGrant = new Promise(resolve => { release = resolve; });
  await access.getByLabel('Confirm selected notebook permissions').check();
  await access.getByRole('button', { name: 'Issue notebook grant' }).click();
  const end = Date.now() + 10000;
  while (grantPosts < 3) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 25)); }
  await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
  release(); holdGrant = undefined;
  await access.getByText('Reopen authorization after unlocking.').waitFor();
  assert.equal(await access.getByRole('button', { name: 'Copy grant token' }).count(), 0, 'late grant is not exposed after lock');
  assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('aod_note_')), false);
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ verified: true, realDatabase: true, bound: !!bound, connectorWrites: bound?.writes(), moveRequests: moves.length, readRequests: readCount, lostAckReload: true, coldOptIn: true, grantPosts, explicitFacets: true, grantLostAckNoReplay: true, grantLockFence: true }));
} finally { await browser?.close(); await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve()); await routes?.close(); if (bound) await bound.close(); else store.close(); await rm(directory, { recursive: true, force: true }); }
