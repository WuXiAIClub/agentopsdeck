import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { HubStore } from '../hub/hub-store.js';
import { WebsiteGateway } from '../hub/website-gateway.js';
import { attachWebsiteSocketUpgrade } from '../hub/website-socket-gateway.js';
import { registerConnectorWebsiteAccess } from '../connector/website-access-http.js';
import { registerHubWebsiteAccess } from './hub-website-access.js';

test('native gateway → authenticated HTTP Connector → loopback HMR, with no credentials forwarded and no replay', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hub-sockets-'));
  const native = createServer(), wss = new WebSocketServer({ server: native });
  let opens = 0, writes = 0, loseWrite = false;
  wss.on('connection', (ws, req) => {
    opens++; assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    ws.on('message', (data, binary) => { writes++; ws.send(data, { binary }); });
  });
  native.listen(0, '127.0.0.1'); await once(native, 'listening');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'synthetic-bootstrap');
  const token = tokens.createTransient(['websites:browse', 'websites:connect']);
  const connector = new Hono();
  connector.use('*', async (c, next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max));
    if (loseWrite && c.req.path.endsWith('/input')) c.res = new Response('lost reply', { status: 502, headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }); });
  const connectorRoutes = registerConnectorWebsiteAccess(connector, tokens, [{ id: 'app', label: 'App', browse: true,
    url: `http://127.0.0.1:${(native.address() as { port: number }).port}/`, sockets: [{ path: '/hmr', protocols: ['vite-hmr'] }] }]);
  const connectorServer = serve({ fetch: connector.fetch, port: 0, hostname: '127.0.0.1' }); await once(connectorServer, 'listening');
  const connectorUrl = `http://127.0.0.1:${(connectorServer.address() as { port: number }).port}`;
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), owner = hub.createUser('Owner');
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl, ownerUserId: owner.id });
  const gatewayServer = createServer(); gatewayServer.listen(0, '127.0.0.1'); await once(gatewayServer, 'listening');
  const port = (gatewayServer.address() as { port: number }).port;
  const gateway = new WebsiteGateway({ originTemplate: `http://{access}.localhost:${port}`, parentOrigin: 'http://hub.localhost', port });
  const upgrade = attachWebsiteSocketUpgrade(gatewayServer, gateway);
  const app = new Hono(), client = new ConnectorClient(connectorUrl, token.token);
  const routes = registerHubWebsiteAccess(app, { hubStore: hub, principal: () => ({ userId: owner.id, admin: false }), connectorClient: () => client, gateway });
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate(); upgrade.close(); gateway.close(); routes.close(); connectorRoutes.close(); token.dispose(); hub.close();
    for (const ws of wss.clients) ws.terminate(); wss.close();
    await Promise.all([native, gatewayServer, connectorServer as Server].map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
    await rm(root, { recursive: true, force: true });
  });
  const base = '/api/hub/v1/connections/dev/website-access';
  const openVisit = async () => {
    const opened = await app.request(base, { method: 'POST', body: JSON.stringify({ serviceId: 'app' }) }); assert.equal(opened.status, 200);
    const { accessId } = await opened.json();
    const browser = await app.request(`${base}/${accessId}/browser`, { method: 'POST', headers: { origin: 'http://hub.localhost' }, body: '{}' });
    assert.equal(browser.status, 200); return { accessId, url: new URL((await browser.json()).url) };
  };
  const connect = (url: URL, origin = 'null', path = '/hmr') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, ['vite-hmr'], { headers: { host: url.host, origin }, handshakeTimeout: 2000 });
    clients.push(ws); ws.on('error', () => {}); return ws;
  };
  const visit = await openVisit();
  await assert.rejects(once(connect(visit.url, 'http://hub.localhost'), 'open')); assert.equal(opens, 0);
  await assert.rejects(once(connect(visit.url, 'null', '/forbidden'), 'open')); assert.equal(opens, 0);
  const ws = connect(visit.url); await once(ws, 'open'); assert.equal(ws.protocol, 'vite-hmr');
  for (const value of ['{"type":"update"}', Buffer.from([0, 255])]) {
    const message = once(ws, 'message'); ws.send(value);
    const [data, binary] = await message; assert.deepEqual(Buffer.from(data), Buffer.from(value)); assert.equal(binary, typeof value !== 'string');
  }
  assert.equal(writes, 2);
  const closed = once(ws, 'close');
  assert.equal((await app.request(`${base}/${visit.accessId}`, { method: 'DELETE' })).status, 200); await closed;
  await assert.rejects(once(connect(visit.url), 'open')); assert.equal(opens, 1);
  const next = await openVisit(), uncertain = connect(next.url); await once(uncertain, 'open');
  loseWrite = true; const failed = once(uncertain, 'close'); uncertain.send('only-once'); await failed;
  assert.equal(writes, 3); assert.equal(opens, 2);
  loseWrite = false;
  const last = connect(next.url); await once(last, 'open');
  const revoked = once(last, 'close'); token.dispose(); await revoked;
  assert.equal(tokens.changes.waiting, 0);
});
