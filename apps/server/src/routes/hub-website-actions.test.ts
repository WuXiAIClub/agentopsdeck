import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorWebsiteActions } from '../connector/website-actions-http.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { registerHubWebsiteActions } from './hub-website-actions.js';

test('private login rotates at full Hub/Connector quota, concurrent continuation cannot fork and lost opens never replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-website-session-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono(), connector = new Hono();
  const owner = hub.createUser('Owner'), other = hub.createUser('Other');
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: owner.id });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), token = tokens.createTransient(['websites:act']);
  let writes = 0, opens = 0, loseOpen = false;
  const website = registerConnectorWebsiteActions(connector, tokens, [{ id: 'fixture', label: 'Fixture', url: 'http://127.0.0.1:3000/',
    session: { cookieNames: ['sid'] }, actions: [{ id: 'login', label: 'Login', path: '/login', method: 'POST', contentType: 'application/json', maxBytes: 64 }] }], async (_url, init) => {
    writes++; assert.equal(new Headers(init?.headers).get('authorization'), null);
    return new Response('ok', { headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=private-synthetic; Path=/; HttpOnly' } });
  });
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub, normalizeError: () => 'Synthetic',
    principal: req => ({ userId: req.headers.get('x-test-user')!, admin: false }),
    connectorClient: () => new ConnectorClient('http://connector', token.token, async req => {
      const isOpen = req.method === 'POST' && new URL(req.url).pathname.endsWith('/website-actions');
      if (isOpen) opens++;
      const response = await connector.request(req);
      if (isOpen && loseOpen) { loseOpen = false; throw Error('Synthetic lost open response'); }
      response.headers.set(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); return response;
    }) });
  const base = '/api/hub/v1/connections/dev/website-actions';
  const request = (path: string, input?: unknown, user = owner.id) => app.request(base + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { 'x-test-user': user, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const openInput = { serviceId: 'fixture', actionId: 'login' };
  try {
    const handles: { accessId: string; expiresAt: number }[] = [];
    for (let i = 0; i < 4; i++) { const response = await request('', openInput); assert.equal(response.status, 200); handles.push(await response.json()); }
    assert.equal((await request('', openInput)).status, 429);
    const first = handles[0]!;
    assert.equal((await request(`/${first.accessId}/execute`, { body: '{}' })).status, 200);
    assert.equal((await request('', { ...openInput, previousAccessId: first.accessId }, other.id)).status, 404);
    const attempts = await Promise.all([request('', { ...openInput, previousAccessId: first.accessId }), request('', { ...openInput, previousAccessId: first.accessId })]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 404]);
    const next = await attempts.find(r => r.status === 200)!.json();
    assert.ok(next.expiresAt <= first.expiresAt);
    assert.equal(opens, 5); assert.equal(writes, 1);
    assert.equal((await request(`/${first.accessId}`)).status, 404);
    assert.equal((await request(`/${next.accessId}/execute`, { body: '{}' })).status, 200);
    loseOpen = true;
    assert.equal((await request('', { ...openInput, previousAccessId: next.accessId })).status, 502);
    assert.equal((await request('', { ...openInput, previousAccessId: next.accessId })).status, 404);
    assert.equal(opens, 6); assert.equal(writes, 2, 'opening/losing/continuing never executes a write');
    token.dispose();
    assert.equal((await request(`/${handles[1]!.accessId}`)).status, 403);
  } finally { routes?.close(); website.close(); token.dispose(); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('Hub → Connector website actions: exact owner, lost reply recovery without replay and no private headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-website-actions-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono(), connector = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Admin');
  const connection = hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: alice.id });
  hub.upsertConnection({ ...connection, id: 'other' });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), token = tokens.createTransient(['websites:act']);
  let calls = 0, lose = true, unavailable = false;
  const website = registerConnectorWebsiteActions(connector, tokens, [{ id: 'fixture', label: 'Fixture', url: 'http://127.0.0.1:3000/',
    actions: [{ id: 'update', label: 'Update', method: 'POST', path: '/private-path', contentType: 'application/json', maxBytes: 64 }] }], async (_url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get('authorization'), null); assert.equal(new Headers(init?.headers).get('cookie'), null);
    return Response.json({ updated: true });
  });
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub, normalizeError: () => 'Synthetic',
    principal: req => req.headers.has('x-test-user') ? { userId: req.headers.get('x-test-user')!, admin: req.headers.get('x-test-user') === bob.id } : undefined,
    connectorClient: () => new ConnectorClient('http://connector', token.token, async req => {
      if (unavailable) return new Response('{}', { status: 401, headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      const response = await connector.request(req);
      if (lose && req.url.endsWith('/execute')) { lose = false; throw Error('Reply lost after committing'); }
      response.headers.set(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); return response;
    }) });
  const base = '/api/hub/v1/connections/dev/website-actions';
  const request = (path: string, input?: unknown, owner = alice.id, prefix = base) => app.request(prefix + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { 'x-test-user': owner, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  try {
    assert.equal((await app.request(base + '/catalog/fixture')).status, 401);
    assert.equal((await request('/catalog/fixture', undefined, bob.id)).status, 404);
    const catalog = await request('/catalog/fixture'); assert.equal(catalog.status, 200); assert.ok(!(await catalog.text()).includes('/private-path'));
    assert.equal((await request('?url=http://private', { serviceId: 'fixture', actionId: 'update' })).status, 400);
    const opened = await request('', { serviceId: 'fixture', actionId: 'update' }); assert.equal(opened.status, 200);
    const { accessId } = await opened.json();
    assert.equal((await request(`/${accessId}`, undefined, bob.id)).status, 404);
    assert.equal((await request(`/${accessId}`, undefined, alice.id, base.replace('/dev/', '/other/'))).status, 404);
    assert.deepEqual(await (await request(`/${accessId}/execute`, { body: '{}' })).json(), { state: 'unknown' });
    assert.equal(calls, 1);
    assert.deepEqual(await (await request(`/${accessId}`)).json(), { state: 'completed', status: 200, text: '{"updated":true}' });
    assert.equal((await request(`/${accessId}/execute`, { body: '{"change":true}' })).status, 200); assert.equal(calls, 1);
    unavailable = true; assert.equal((await request(`/${accessId}`)).status, 403); unavailable = false;
    hub.upsertConnection({ ...connection, status: 'disabled' });
    assert.equal((await request(`/${accessId}`)).status, 404); assert.equal(calls, 1);
    const audit = hub.identities.audit;
    assert.ok(audit, 'writes use the configured metadata audit log');
  } finally { routes?.close(); website.close(); token.dispose(); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('website action execute and cleanup retain aborted physical dispatch and source cancel ACK with outcome_unknown intact', async () => {
  const hub = new HubStore(':memory:', 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice');
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: alice.id });
  let executes = 0, deletes = 0, execCancels = 0, deleteCancels = 0;
  let execStarted!: () => void, execDispatch!: (response: Response) => void, releaseExecCancel!: () => void;
  let deleteStarted!: () => void, deleteDispatch!: (response: Response) => void, releaseDeleteCancel!: () => void;
  const execEntered = new Promise<void>(resolve => { execStarted = resolve; });
  const execHeld = new Promise<Response>(resolve => { execDispatch = resolve; });
  const deleteEntered = new Promise<void>(resolve => { deleteStarted = resolve; });
  const deleteHeld = new Promise<Response>(resolve => { deleteDispatch = resolve; });
  const routes = registerHubWebsiteActions(app, {
    hubStore: hub,
    principal: () => ({ userId: alice.id, admin: false }),
    connectorClient: () => new ConnectorClient('http://connector', 'synthetic', async req => {
      const path = new URL(req.url).pathname;
      if (req.method === 'POST' && path.endsWith('/website-actions')) {
        return Response.json({ accessId: 'a'.repeat(43), expiresInMs: 30_000 }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      }
      if (req.method === 'POST' && path.endsWith('/execute')) { executes++; execStarted(); return execHeld; }
      if (req.method === 'DELETE') { deletes++; deleteStarted(); return deleteHeld; }
      return Response.json({ state: 'unknown' }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
    }),
  });
  const base = '/api/hub/v1/connections/dev/website-actions';
  try {
    const opened = await app.request(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: 'fixture', actionId: 'update' }) });
    const { accessId } = await opened.json();
    const controller = new AbortController();
    const pendingExec = app.request(`${base}/${accessId}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '{}' }), signal: controller.signal,
    });
    let execDone = false;
    void Promise.resolve(pendingExec).then(() => { execDone = true; });
    await execEntered;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(execDone, false, 'aborted execute keeps active slot until physical dispatch and cancel ACK settle');
    execDispatch(new Response(new ReadableStream({
      cancel() { execCancels++; return new Promise<void>(resolve => { releaseExecCancel = resolve; }); },
    }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }));
    for (let i = 0; execCancels === 0 && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(execCancels, 1);
    assert.equal(execDone, false);
    releaseExecCancel();
    assert.equal((await pendingExec).status, 499);
    assert.equal(executes, 1);
    assert.deepEqual(await (await app.request(`${base}/${accessId}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '{}' }),
    })).json(), { state: 'unknown' });
    assert.equal(executes, 1, 'uncertain execution never replays');

    const deleteCtrl = new AbortController();
    const pendingDelete = app.request(`${base}/${accessId}`, { method: 'DELETE', signal: deleteCtrl.signal });
    await deleteEntered;
    deleteCtrl.abort();
    let closed = false;
    const closing = routes.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    deleteDispatch(new Response(new ReadableStream({
      start() {},
      cancel() { deleteCancels++; return new Promise<void>(resolve => { releaseDeleteCancel = resolve; }); },
    }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }));
    for (let i = 0; deleteCancels === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(deleteCancels, 1);
    assert.equal(closed, false);
    releaseDeleteCancel();
    assert.ok([499, 503].includes((await pendingDelete).status));
    await closing;
    assert.equal(deletes, 1);
  } finally { await hub.close(); }
});
