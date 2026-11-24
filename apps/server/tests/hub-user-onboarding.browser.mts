import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from '../src/config.js';
import { HubStore } from '../src/hub/hub-store.js';
import { ConnectorTokenStore } from '../src/auth/connector-token.js';
import { ConnectorUserStore } from '../src/connector/connector-user-store.js';
import { DeckStore } from '../src/projection/deck-store.js';
import { registerConnectorRoutes } from '../src/routes/connector.js';
import { encodeHubSessionId } from '../src/hub/session-id.js';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const { createApplication } = await import(process.env.AOD_TEST_CANDIDATE
  ? pathToFileURL(join(process.env.AOD_TEST_CANDIDATE, 'apps/server/dist/application.js')).href : '../src/application.js');
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-onboarding-browser-'));
const adminKey = randomBytes(32).toString('hex');
const config = loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: adminKey,
  AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: randomBytes(32).toString('hex'),
  AOD_SESSION_TITLES_FILE: join(directory, 'titles.json'), AOD_AUTH_SESSIONS_FILE: join(directory, 'auth.json'),
  AOD_PASSKEYS_FILE: join(directory, 'passkeys.json'), AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CODEX_ENABLED: 'false' });
const users = new ConnectorUserStore(join(directory, 'connector.sqlite'));
const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
const token = tokens.create({ label: 'Fixture', scopes: ['sessions:read', 'messages:read', 'events:read', 'users:read'] });
const deck = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile, eventLog: users.events });
for (const suffix of ['shared', 'private']) {
  deck.upsertSession({ sessionKey: `codex:${suffix}`, title: `${suffix} conversation`, agentId: 'codex', status: 'idle', hasActiveRun: false,
    runtime: { phase: 'completed', connection: 'connected', sync: 'current', threadActivity: 'idle', lastEventAt: Date.now() } });
  deck.addMessage({ id: `message-${suffix}`, sessionKey: `codex:${suffix}`, role: 'assistant', text: `${suffix} fixture history`, createdAt: Date.now() });
}
const connectorApp = new Hono();
const connector = registerConnectorRoutes(connectorApp, { config, tokens, connectorUsers: users, store: deck,
  gateway: { request: async () => { throw new Error('Fixture cannot execute agents'); } } as any,
  refreshSessions: async () => {}, refreshMessages: async () => {}, sessionSnapshotReady: () => true,
  historySnapshotReady: () => true, fallbackAgents: () => [], isAuthorizedRequest: () => false, normalizeError: () => 'Fixture error' });
const connectorServer = serve({ fetch: connectorApp.fetch, hostname: '127.0.0.1', port: 0 });
if (!connectorServer.listening) await new Promise(resolve => connectorServer.once('listening', resolve));
const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
seed.upsertConnection({ id: 'fixture', ownerUserId: 'default', kind: 'remote', label: 'Fixture Codex',
  connectorUrl: `http://127.0.0.1:${(connectorServer.address() as any).port}`, credentialToken: token.token,
  capabilities: ['sessions', 'messages', 'events'] });
seed.pinConnectionNode('fixture', 'default', seed.connectionAuthority('fixture', 'default')!, users.nodeId);
seed.close();
const application = createApplication(config);
const server = serve({ fetch: application.app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  for (const width of [1440, 390]) {
    const admin = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const member = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const outsider = await browser.newContext({ serviceWorkers: 'block' });
    const page = await admin.newPage();
    const memberPage = await member.newPage();
    for (const activePage of [page, memberPage]) {
      activePage.on('pageerror', () => errors.push('Browser page error'));
      activePage.on('response', response => { if (response.status() >= 500) errors.push('Unexpected server failure'); });
    }
    const login = await admin.request.post(`${origin}/api/auth/login`, { data: { accessKey: adminKey } });
    assert.equal(login.status(), 200);
    assert.deepEqual(await (await admin.request.get(`${origin}/api/hub/v1/me`)).json(), { userId: 'default', admin: true });
    assert.equal((await outsider.request.get(`${origin}/api/hub/v1/me`)).status(), 401);
    await page.goto(`${origin}/#/tab/users`);
    const label = `Member ${width}`;
    await page.getByRole('textbox', { name: 'New Hub user label' }).fill(label);
    await page.getByRole('button', { name: 'Create Hub record', exact: true }).click();
    await page.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) }).getByRole('button', { name: 'Manage access' }).click();
    const panel = page.getByRole('region', { name: `Access for ${label}`, exact: true });
    await panel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    const secretInput = panel.getByRole('textbox', { name: 'One-time member login key' });
    await secretInput.waitFor();
    const memberKey = await secretInput.inputValue();
    assert.ok(memberKey.startsWith('hub_key_'), 'A member credential was issued');
    assert.equal(await page.evaluate(secret => JSON.stringify(localStorage).includes(secret) || JSON.stringify(sessionStorage).includes(secret), memberKey), false);
    await panel.getByRole('button', { name: 'Hide key', exact: true }).click();
    await panel.getByRole('button', { name: 'Refresh keys', exact: true }).click();
    const userId = (await (await admin.request.get(`${origin}/api/hub/v1/users`)).json()).users.find((user: any) => user.label === label).id;
    const listed = await admin.request.get(`${origin}/api/hub/v1/users/${userId}/login-keys`);
    assert.equal(listed.headers()['cache-control'], 'no-store');
    const keys = (await listed.json()).keys;
    assert.equal(keys.length, 1);
    assert.equal('token' in keys[0], false);

    await memberPage.goto(origin);
    await memberPage.getByRole('textbox', { name: 'Access key', exact: true }).fill(memberKey);
    await memberPage.getByRole('button', { name: 'Unlock with access key' }).click();
    await memberPage.getByRole('heading', { name: 'Shared with me' }).waitFor();
    assert.equal(await memberPage.getByRole('button', { name: 'Bind passkey', exact: true }).count(), 0);
    assert.deepEqual(await (await member.request.get(`${origin}/api/hub/v1/me`)).json(), { userId, admin: false });
    assert.equal((await member.request.post(`${origin}/api/hub/v1/users`, { data: { label: 'Forbidden' } })).status(), 403);
    assert.equal((await member.request.get(`${origin}/api/hub/v1/users/${userId}/login-keys`)).status(), 403);
    assert.equal((await member.request.get(`${origin}/api/auth/passkeys`)).status(), 403);
    assert.equal((await (await member.request.get(`${origin}/api/hub/v1/connections`)).json()).connections.length, 0);
    const sharedId = encodeHubSessionId('fixture', 'codex:shared');
    const privateId = encodeHubSessionId('fixture', 'codex:private');
    const sharedPath = `/api/hub/v1/shared/default/sessions/${encodeURIComponent(sharedId)}`;
    assert.equal((await member.request.get(origin + sharedPath + '/messages')).status(), 404);
    await memberPage.goto(`${origin}/#/tab/users`);
    await memberPage.getByText(/Member — user and login-key administration is unavailable/).waitFor();
    assert.equal(await memberPage.getByRole('button', { name: 'Create Hub record', exact: true }).count(), 0);
    assert.equal(await memberPage.getByRole('button', { name: 'Manage access', exact: true }).count(), 0);
    await memberPage.getByRole('link', { name: 'Shared with me', exact: true }).click();

    await panel.getByRole('combobox', { name: 'Grant session', exact: true }).selectOption('codex:shared');
    assert.equal(await panel.getByRole('checkbox', { name: /Allow sending/ }).isDisabled(), true);
    await panel.getByRole('checkbox', { name: 'Confirm grant scope' }).check();
    await panel.getByRole('button', { name: 'Grant access', exact: true }).click();
    await panel.getByText(/Authorization saved/).waitFor();
    await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
    await memberPage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await memberPage.getByRole('link', { name: 'Open session', exact: true }).click();
    await memberPage.getByText('shared fixture history', { exact: true }).waitFor();
    assert.equal((await member.request.get(origin + `/api/hub/v1/sessions/${encodeURIComponent(sharedId)}/messages`)).status(), 404);
    assert.equal((await member.request.get(origin + `/api/hub/v1/shared/default/sessions/${encodeURIComponent(privateId)}/messages`)).status(), 404);
    const prohibitedSend = await member.request.post(origin + sharedPath + '/messages', { data: { message: 'must not run', idempotencyKey: 'onboard-denied', deliveryMode: 'web-only' } });
    assert.ok([403, 404].includes(prohibitedSend.status()));
    assert.equal(await memberPage.getByText('private fixture history', { exact: true }).count(), 0);
    for (const activePage of [page, memberPage]) assert.equal(await activePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'No horizontal page overflow');

    const grantPath = `${origin}/api/hub/v1/connections/fixture/grants`;
    const grantPage = await (await admin.request.get(grantPath)).json();
    const savedGrant = grantPage.grants.find((grant: any) => grant.userId === userId && !grant.revoked);
    assert.ok(savedGrant);
    assert.equal((await admin.request.put(`${grantPath}/${savedGrant.id}`, { data: {
      version: savedGrant.version, nodeVersion: grantPage.nodeVersion, policy: savedGrant.policy,
    } })).status(), 200);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Revoke authorization', exact: true }).click();
    await panel.getByText(/Revocation was not confirmed or the version changed/).waitFor();
    assert.equal((await member.request.get(origin + sharedPath + '/messages')).status(), 200);
    await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Revoke authorization', exact: true }).click();
    await panel.getByText(/Authorization revoked/).waitFor();
    assert.equal((await member.request.get(origin + sharedPath + '/messages')).status(), 404);
    await memberPage.reload();
    await memberPage.getByText(/access.*(changed|unavailable|revoked)|not authorized|permission/i).first().waitFor();
    assert.equal(await memberPage.getByText('shared fixture history', { exact: true }).count(), 0);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await panel.getByText(/Login key revoked/).waitFor();
    assert.equal((await member.request.get(`${origin}/api/hub/v1/me`)).status(), 401);
    const invalidLogin = await outsider.request.post(`${origin}/api/auth/login`, { data: { accessKey: memberKey } });
    assert.equal(invalidLogin.status(), 401);
    assert.equal((await (await admin.request.get(`${origin}/api/hub/v1/me`)).json()).admin, true);
    assert.equal((await (await admin.request.get(origin + `/api/hub/v1/sessions/${encodeURIComponent(sharedId)}/messages`)).json()).messages.length, 1);
    await memberPage.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required')));
    await memberPage.getByRole('textbox', { name: 'Access key', exact: true }).fill(adminKey);
    await memberPage.getByRole('button', { name: 'Unlock with access key' }).click();
    await memberPage.getByText(/Access key accepted\. Bind passkeys/).waitFor();
    await memberPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await memberPage.goto(`${origin}/#/tab/users`);
    await memberPage.getByRole('button', { name: 'Create Hub record', exact: true }).waitFor();

    let lostIssues = 0;
    const keyPath = `${origin}/api/hub/v1/users/${userId}/login-keys`;
    await page.route(keyPath, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      lostIssues++;
      const committed = await route.fetch();
      assert.equal(committed.status(), 201);
      await route.abort('failed');
    });
    await panel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    await panel.getByText(/Issuance was not confirmed/).waitFor();
    assert.equal(lostIssues, 1);
    assert.equal(await panel.getByRole('button', { name: 'Issue member login key', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('textbox', { name: 'One-time member login key' }).count(), 0);
    await page.unroute(keyPath);
    await panel.getByRole('button', { name: 'Refresh keys', exact: true }).click();
    assert.equal((await (await admin.request.get(keyPath)).json()).keys.length, 1);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await panel.getByText(/Login key revoked/).waitFor();
    await admin.close(); await member.close(); await outsider.close();
    console.log(`PASS ${width}px: UI create/key/login/share/read/revoke; stale versions, lost issuance, account switch; real HTTP auth and Connector; no agent execution`);
  }
  assert.equal(errors.length, 0, 'No browser runtime errors');
} finally {
  await browser.close();
  await application.close(); connector.close();
  for (const activeServer of [server, connectorServer]) {
    activeServer.closeAllConnections?.();
    await new Promise(resolve => activeServer.close(resolve));
  }
  users.close();
  await rm(directory, { recursive: true, force: true });
}
