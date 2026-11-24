import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorWebsiteAccess } from '../connector/website-access-http.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { WebsiteGateway } from '../hub/website-gateway.js';
import { registerHubWebsiteAccess } from './hub-website-access.js';

test('without an isolated gateway a valid lease cannot open an interactive browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-website-disabled-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const owner = hub.createUser('Owner');
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: owner.id });
  const routes = registerHubWebsiteAccess(app, { hubStore: hub, principal: () => ({ userId: owner.id, admin: false }),
    connectorClient: () => new ConnectorClient('http://connector', 'synthetic', async () => Response.json({
      accessId: 'a'.repeat(43), serviceId: 'app', expiresInMs: 299_000,
    }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } })) });
  const base = '/api/hub/v1/connections/dev/website-access';
  try {
    const opened = await app.request(base, { method: 'POST', body: JSON.stringify({ serviceId: 'app' }) });
    assert.equal(opened.status, 200);
    const { accessId } = await opened.json();
    const browser = await app.request(`${base}/${accessId}/browser`, { method: 'POST', body: '{}' });
    assert.equal(browser.status, 409);
    assert.equal(browser.headers.get('location'), null);
    assert.match(await browser.text(), /not configured/);
  } finally { await routes.close(); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('Hub leases bind user, connection, authority and credential domain; validate all remote responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-website-access-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Admin');
  const connection = hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: alice.id });
  hub.upsertConnection({ ...connection, id: 'other' });
  let actor: { userId: string; admin: boolean } | undefined = { userId: alice.id, admin: false };
  let afterRead = () => {}, calls = 0, remoteStatus = 200, token = 'synthetic';
  let badLease = false, badResource = false, expiresInMs = 299_000;
  const remoteId = 'a'.repeat(43);
  const gateway = new WebsiteGateway({ originTemplate: 'https://{access}.preview.example.net', parentOrigin: 'https://hub.example.org', port: 9898 });
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    websiteGateway: gateway,
    normalizeError: () => 'Synthetic', principal: () => actor,
    connectorClient: (id, maintenance, owner) => {
      assert.ok(['dev', 'other'].includes(id)); assert.equal(maintenance, false); assert.equal(owner, alice.id);
      return new ConnectorClient('http://connector', token, async req => {
        calls++; afterRead();
        const payload = req.method === 'DELETE' ? { closed: true }
          : req.url.endsWith('/resource') ? { status: 200, contentType: 'text/html', bodyBase64: badResource ? 'invalid!' : 'SGk=', private: 'never-forward' }
          : { accessId: remoteId, serviceId: badLease ? 'other-service' : 'app', expiresInMs, expiresAt: Date.now() + 86_400_000, private: 'never-forward' };
        return new Response(JSON.stringify(payload), { status: remoteStatus, headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      });
    } });
  const base = '/api/hub/v1/connections/dev/website-access';
  const request = (suffix = '', body: unknown = { serviceId: 'app' }, method = 'POST', path = base) => app.request(path + suffix,
    { method, headers: { 'content-type': 'application/json' }, ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }) });
  const open = async () => { const res = await request(); assert.equal(res.status, 200); return (await res.json()).accessId as string; };
  try {
    actor = undefined; assert.equal((await request()).status, 401);
    actor = { userId: bob.id, admin: true }; assert.equal((await request()).status, 404);
    actor = { userId: alice.id, admin: false };
    assert.equal((await request('?url=private')).status, 400);
    assert.equal((await request('', { serviceId: 'app', url: 'http://private' })).status, 400); assert.equal(calls, 0);
    const id = await open(); assert.notEqual(id, remoteId);
    const browser = (accessId: string, origin = 'https://hub.example.org') => app.request(`${base}/${accessId}/browser`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await browser(id, 'https://other.example.org')).status, 403);
    const opened = await browser(id); assert.equal(opened.status, 200);
    const visit = await opened.json(); assert.ok(visit.expiresInMs > 0 && visit.expiresInMs <= 299_000);
    const rendered = await gateway.fetch(new Request(visit.url));
    assert.equal(rendered.status, 200); assert.equal(await rendered.text(), 'Hi');
    assert.equal((await request(`/${id}/resource`, { path: '/' }, 'POST', base.replace('/dev/', '/other/'))).status, 404);
    const resource = await request(`/${id}/resource`, { path: '/' });
    assert.equal(resource.status, 200); assert.equal(resource.headers.get('cache-control'), 'no-store');
    assert.equal(resource.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await resource.json(), { status: 200, contentType: 'text/html', bodyBase64: 'SGk=' });
    badResource = true; assert.equal((await request(`/${id}/resource`, { path: '/' })).status, 502); badResource = false;
    badLease = true; assert.equal((await request()).status, 502); badLease = false;
    for (const lifetime of [0, -1, 300_001, 1.5]) { expiresInMs = lifetime; assert.equal((await request()).status, 502); }
    expiresInMs = 299_000;
    remoteStatus = 401; assert.equal((await request()).status, 403); remoteStatus = 200;
    token = 'rotated'; assert.equal((await request(`/${id}/resource`, { path: '/' })).status, 403);
    assert.equal((await gateway.fetch(new Request(visit.url))).status, 404);
    assert.equal((await request(`/${id}/resource`, { path: '/' })).status, 404);
    const next = await open();
    const nextVisit = await (await browser(next)).json();
    afterRead = () => { actor = undefined; };
    assert.equal((await gateway.fetch(new Request(nextVisit.url))).status, 401);
    assert.equal((await request(`/${next}/resource`, { path: '/' })).status, 401);
    actor = { userId: alice.id, admin: false }; afterRead = () => {};
    // An observed credential revocation permanently retires the original
    // proof. Restoring a synthetic actor cannot revive that retained lease.
    assert.equal((await request(`/${next}/resource`, { path: '/' })).status, 401);
    const epochLease = await open();
    const generation = hub.connectionAuthority('dev', alice.id);
    afterRead = () => { hub.upsertConnection({ ...connection, connectorUrl: 'http://127.0.0.1:9998' }); };
    assert.equal((await request(`/${epochLease}/resource`, { path: '/' })).status, 403);
    assert.notEqual(hub.connectionAuthority('dev', alice.id), generation); afterRead = () => {};
    const closed = await open(); remoteStatus = 503;
    assert.equal((await request(`/${closed}`, undefined, 'DELETE')).status, 502); remoteStatus = 200;
    assert.equal((await request(`/${closed}/resource`, { path: '/' })).status, 404);
    await routes?.close(); assert.equal((await request(`/${next}/resource`, { path: '/' })).status, 503);
  } finally { await Promise.all([gateway.close(), routes?.close()]); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('real HTTP: cookie-authenticated Hub → token-authenticated Connector → loopback resources; close and logout fence delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-website-network-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono(), connector = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob');
  const session = hub.identities.createSession(hub.identities.issueKey(alice.id).token)!;
  const otherSession = hub.identities.createSession(hub.identities.issueKey(bob.id).token)!;
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'synthetic-bootstrap');
  const browser = tokens.createTransient(['websites:browse']);
  let reads = 0, release: (() => void) | undefined;
  const observed: { cookie: string | undefined; authorization: string | undefined }[] = [];
  const site = createServer((req, res) => {
    reads++; observed.push({ cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': req.url === '/asset.js' ? 'application/javascript' : 'text/html', 'set-cookie': 'private=secret' });
    if (req.url === '/slow') { res.write('partial'); release = () => res.end('done'); }
    else res.end(req.url === '/asset.js' ? 'window.ready = true' : '<h1>Local app</h1>');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  connector.use('*', async (c, next) => { c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); await next(); });
  const access = registerConnectorWebsiteAccess(connector, tokens, [{ id: 'app', label: 'App', browse: true,
    url: `http://127.0.0.1:${(site.address() as { port: number }).port}/` }]);
  const remote = serve({ fetch: connector.fetch, hostname: '127.0.0.1', port: 0 });
  if (!remote.listening) await new Promise<void>(resolve => remote.once('listening', resolve));
  const remoteUrl = `http://127.0.0.1:${(remote.address() as { port: number }).port}`;
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: remoteUrl, ownerUserId: alice.id });
  const gateway = new WebsiteGateway({ originTemplate: 'http://{access}.preview.localhost', parentOrigin: 'http://127.0.0.1', port: 0 });
  const gatewayServer = serve({ fetch: req => {
    assert.ok(new URL(req.url).hostname.endsWith('.preview.localhost'), 'gateway HTTP fixture preserves the capability host');
    return gateway.fetch(req);
  }, hostname: '127.0.0.1', port: 0 });
  if (!gatewayServer.listening) await new Promise<void>(resolve => gatewayServer.once('listening', resolve));
  const gatewayPort = (gatewayServer.address() as { port: number }).port;
  gateway.config.originTemplate += `:${gatewayPort}`;
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    websiteGateway: gateway,
    normalizeError: () => 'Synthetic', principal: req => hub.identities.requestPrincipal(req, () => false),
    connectorClient: () => new ConnectorClient(remoteUrl, browser.token) });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/hub/v1/connections/dev/website-access`;
  gateway.config.parentOrigin = new URL(base).origin;
  const request = (suffix = '', body: unknown = { serviceId: 'app' }, method = 'POST', cookie = session, signal?: AbortSignal) => fetch(base + suffix,
    { method, headers: { cookie: `agentopsdeck_session=${cookie}`, origin: new URL(base).origin, 'content-type': 'application/json' }, ...(signal ? { signal } : {}), ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }) });
  // Native fetch does not preserve a custom Host in this Node version. Model
  // the reverse proxy with node:http, without weakening gateway host checks.
  const gatewayRead = (url: string, path: string, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: gatewayPort, path, signal,
      headers: { host: new URL(url).host, origin: 'null' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502 })));
    });
    request.on('error', reject); request.end();
  });
  const waitRead = async (count: number) => { for (let i = 0; reads < count && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(reads, count); };
  try {
    assert.equal((await request('', undefined, 'POST', otherSession)).status, 404);
    const opened = await request(); assert.equal(opened.status, 200); const { accessId } = await opened.json();
    const visit = await (await request(`/${accessId}/browser`, {})).json();
    for (const path of ['/', '/asset.js']) {
      const response = await request(`/${accessId}/resource`, { path }); assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      const body = await response.json(); assert.ok(Buffer.from(body.bodyBase64, 'base64').toString().includes(path === '/' ? 'Local app' : 'window.ready'));
    }
    const page = await gatewayRead(visit.url, '/');
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<h1>Local app</h1>');
    const pending = gatewayRead(visit.url, '/slow'); await waitRead(4);
    assert.equal((await request(`/${accessId}`, undefined, 'DELETE')).status, 200);
    assert.notEqual((await pending).status, 200);
    assert.equal((await request(`/${accessId}/resource`, { path: '/' })).status, 404);
    assert.equal((await gatewayRead(visit.url, '/')).status, 404);
    const second = await (await request()).json();
    const secondVisit = await (await request(`/${second.accessId}/browser`, {})).json();
    const controller = new AbortController();
    const disconnected = gatewayRead(secondVisit.url, '/slow', controller.signal);
    void disconnected.catch(() => {});
    await waitRead(5); controller.abort(); await assert.rejects(disconnected);
    for (let i = 0; tokens.changes.waiting && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(tokens.changes.waiting, 0, 'HTTP disconnect releases the Connector watcher/admission without waiting for the resource timeout');
    const logout = gatewayRead(secondVisit.url, '/slow'); await waitRead(6);
    hub.identities.revokeSession(session); release!();
    const rejected = await logout; assert.equal(rejected.status, 401); assert.ok(!(await rejected.text()).includes('partial'));
    assert.ok(observed.every(row => !row.cookie && !row.authorization));
    assert.equal(tokens.changes.waiting, 0);
  } finally {
    await Promise.all([gateway.close(), routes?.close()]); access.close();
    for (const item of [gatewayServer, server, remote, site]) { if ('closeAllConnections' in item) item.closeAllConnections(); await new Promise<void>(resolve => item.close(() => resolve())); }
    hub.close(); await rm(root, { recursive: true, force: true });
  }
});
