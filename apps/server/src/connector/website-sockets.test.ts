import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { WebsiteSocket, parseWebsiteSockets, validWebsiteSocketFrame } from './website-sockets.js';
import { registerConnectorWebsiteAccess } from './website-access-http.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { parseWebsiteServices } from './websites.js';

test('socket policy is exact, explicit and bounded; frames are canonical and valid UTF8', () => {
  assert.equal(parseWebsiteSockets(undefined), undefined);
  assert.deepEqual(parseWebsiteSockets([{ path: '/hmr', protocols: ['vite-hmr'] }]), [{ path: '/hmr', protocols: ['vite-hmr'] }]);
  for (const value of [null, {}, [{ path: '//host', protocols: [] }], [{ path: '/x?y', protocols: [] }],
    [{ path: '/x', protocols: ['bad protocol'] }], [{ path: '/x', protocols: ['a', 'a'] }],
    [{ path: '/x', protocols: [], cookie: true }], Array(5).fill({ path: '/x', protocols: [] })]) assert.throws(() => parseWebsiteSockets(value));
  assert.throws(() => parseWebsiteServices(JSON.stringify([{ id: 'app', label: 'App', url: 'http://127.0.0.1:3000/', sockets: [{ path: '/', protocols: [] }] }])));
  assert.ok(validWebsiteSocketFrame({ bodyBase64: '', binary: false }));
  assert.ok(validWebsiteSocketFrame({ bodyBase64: Buffer.alloc(65_536).toString('base64'), binary: true }));
  for (const value of [{ bodyBase64: '/w==', binary: false }, { bodyBase64: 'YR==', binary: false },
    { bodyBase64: '', binary: true, extra: true }, { bodyBase64: Buffer.alloc(65_537).toString('base64'), binary: true }]) assert.equal(validWebsiteSocketFrame(value), false);
});

test('real loopback channel preserves text/binary ordering; read cancellation and parent close release sockets', { timeout: 5000 }, async t => {
  const server = createServer(), wss = new WebSocketServer({ server });
  const headers: unknown[] = [];
  wss.on('connection', (ws, req) => { headers.push([req.headers.cookie, req.headers.authorization]); ws.on('message', (data, binary) => ws.send(data, { binary })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(); });
  const service = { id: 'app', label: 'App', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, browse: true, sockets: [{ path: '/hmr', protocols: ['vite-hmr'] }] };
  for (const [path, protocols] of [['/other', ['vite-hmr']], ['/hmr', ['other']], ['/hmr', []]] as [string, string[]][]) {
    assert.throws(() => new WebsiteSocket(service, path, protocols, new AbortController().signal, Date.now() + 5000), { status: 403 });
  }
  const parent = new AbortController(), channel = new WebsiteSocket(service, '/hmr', ['vite-hmr'], parent.signal, Date.now() + 5000);
  t.after(() => channel.close()); assert.equal(await channel.ready, 'vite-hmr');
  for (const frame of [{ bodyBase64: Buffer.from('update').toString('base64'), binary: false }, { bodyBase64: '/wA=', binary: true }]) {
    await channel.send(frame, parent.signal); assert.deepEqual(await channel.read(parent.signal), { frames: [frame] });
  }
  assert.deepEqual(headers, [[undefined, undefined]]);
  const pending = channel.read(parent.signal);
  await assert.rejects(channel.read(parent.signal), { status: 409 });
  parent.abort(); await assert.rejects(pending); assert.equal(channel.closed, true);
});

test('Connector sockets require both scopes and parent ownership; revoked tokens close waiting reads', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'website-socket-test-'));
  const server = createServer(), wss = new WebSocketServer({ server }); let nativeOpens = 0;
  wss.on('connection', ws => { nativeOpens++; ws.on('message', (data, binary) => ws.send(data, { binary })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'synthetic-bootstrap');
  const allowed = tokens.createTransient(['websites:browse', 'websites:connect']);
  const browse = tokens.createTransient(['websites:browse']), other = tokens.createTransient(['websites:browse', 'websites:connect']);
  const app = new Hono(), base = '/api/connector/v1/website-access';
  const routes = registerConnectorWebsiteAccess(app, tokens, [{ id: 'app', label: 'App', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, browse: true, sockets: [{ path: '/hmr', protocols: [] }] }]);
  t.after(async () => { routes.close(); allowed.dispose(); browse.dispose(); other.dispose(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); await rm(root, { recursive: true, force: true }); });
  const request = (path: string, body?: unknown, token = allowed.token, method = 'POST') => app.request(base + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const { accessId } = await (await request('', { serviceId: 'app' })).json();
  const path = `/${accessId}/sockets`;
  assert.equal((await request(path, { path: '/hmr', protocols: [] }, browse.token)).status, 403);
  assert.equal((await request(path, { path: '/hmr', protocols: [] }, other.token)).status, 404);
  assert.equal((await request(path, { path: '/other', protocols: [] })).status, 403); assert.equal(nativeOpens, 0);
  const open = await request(path, { path: '/hmr', protocols: [] }); assert.equal(open.status, 200);
  const { socketId } = await open.json(), channel = `${path}/${socketId}`;
  const frame = { bodyBase64: Buffer.from('hi').toString('base64'), binary: false };
  assert.equal((await request(`${channel}/input`, frame)).status, 200);
  assert.deepEqual(await (await request(`${channel}/output`, undefined, allowed.token, 'GET')).json(), { frames: [frame] });
  const waiting = request(`${channel}/output`, undefined, allowed.token, 'GET');
  await new Promise(resolve => setTimeout(resolve, 10)); allowed.dispose();
  assert.notEqual((await waiting).status, 200); assert.equal(tokens.changes.waiting, 0);
  assert.equal((await request(`${channel}/input`, frame)).status, 401);
});
