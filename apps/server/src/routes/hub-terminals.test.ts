import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { registerHubTerminals } from './hub-terminals.js';
import { AuthAuditLog } from '../auth/security.js';

for (const phase of ['initial', 'targets', 'output'] as const) {
  for (const failure of ['unauthenticated', 'unavailable', 'unclassified'] as const) {
    test(`Hub terminal ${phase} ${failure} preserves authority error scope without leaking remote output`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'hub-terminal-authority-'));
      const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
      const user = hub.createUser('Owner');
      hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://fixture', ownerUserId: user.id });
      const remote = randomUUID();
      let failing = phase === 'initial', remoteReads = 0, starts = 0, deletes = 0;
      const routes = registerHubTerminals(app, {
        hubStore: hub, audit: new AuthAuditLog(),
        principal: () => {
          if (failing) {
            if (failure === 'unauthenticated') throw new HTTPException(401);
            if (failure === 'unavailable') throw new HTTPException(503);
            throw Error('private-credential-error');
          }
          return { userId: user.id, admin: false };
        },
        connectorClient: () => new ConnectorClient('http://fixture', 'synthetic', async request => {
          let result: unknown;
          if (request.method === 'DELETE') { deletes++; result = { stopped: true }; }
          else if (request.method === 'POST') { starts++; result = { id: remote }; }
          else {
            remoteReads++; failing = true;
            result = request.url.endsWith('/targets')
              ? { targets: [{ id: 'shell', label: 'private-remote-target', kind: 'local' }] }
              : { data: 'private-terminal-output', cursor: 1, more: false, truncated: false, running: true };
          }
          return new Response(JSON.stringify(result), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
        }),
      });
      const base = '/api/hub/v1/connections/dev/terminals';
      try {
        let target = `${base}/targets`;
        if (phase === 'output') {
          const started = await app.request(base, { method: 'POST', body: JSON.stringify({ targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }) });
          assert.equal(started.status, 200);
          target = `${base}/${(await started.json()).id}/output?cursor=0`;
        }
        const response = await app.request(target);
        const status = failure === 'unauthenticated' ? (phase === 'initial' ? 401 : 403) : failure === 'unavailable' ? 503 : 502;
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /private-/);
        assert.equal(remoteReads, phase === 'initial' ? 0 : 1, 'remote reads are not replayed');
        assert.equal(starts, phase === 'output' ? 1 : 0);
        assert.equal(deletes, phase === 'output' ? 1 : 0, 'only the admitted terminal is cleaned exactly once');
        failing = false;
        if (phase === 'output') {
          assert.equal((await app.request(target)).status, 404, 'revoked handle cannot be reused');
          assert.equal(remoteReads, 1);
        }
      } finally {
        await routes.close(); hub.close(); await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('Hub terminal exact ownership, sanitized target listing, live authority and uncertain write cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-terminals-')), hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const alice = hub.createUser('Alice'), bob = hub.createUser('Admin');
  const connection = hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://127.0.0.1:9999', ownerUserId: alice.id });
  let calls = 0, writes = 0, deletes = 0, fail = false, afterRead = () => {};
  const remote = randomUUID();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub, normalizeError: () => 'Synthetic',
    principal: req => req.headers.has('x-test-user') ? { userId: req.headers.get('x-test-user')!, admin: req.headers.get('x-test-user') === bob.id } : undefined,
    connectorClient: (id, maintenance, owner) => {
      assert.equal(id, connection.id); assert.equal(maintenance, false); assert.equal(owner, alice.id);
      return new ConnectorClient('http://connector', 'test', async request => {
        calls++; const path = new URL(request.url).pathname;
        if (request.method === 'DELETE') deletes++;
        if (path.endsWith('/input')) { writes++; if (fail) throw Error('private diagnostic'); }
        afterRead();
        return new Response(JSON.stringify(path.endsWith('/targets') ? { targets: [{ id: 'shell', label: 'Shell', kind: 'local', privatePath: 'never-forward' }] }
          : path.endsWith('/output') ? { data: 'hello', cursor: 5, more: false, running: true, truncated: false } : { id: remote }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      });
    } });
  const base = `/api/hub/v1/connections/${connection.id}/terminals`;
  const req = (path: string, user = alice.id, method = 'GET', body?: unknown) => app.request(base + path, { method, headers: { 'x-test-user': user }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await app.request(base + '/targets')).status, 401);
    assert.equal((await req('/targets', bob.id)).status, 404); assert.equal(calls, 0);
    const catalog = await req('/targets'); assert.equal(catalog.headers.get('cache-control'), 'no-store'); assert.ok(!(await catalog.text()).includes('never-forward'));
    const start = await req('', alice.id, 'POST', { targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }); assert.equal(start.status, 200);
    const { id } = await start.json(); assert.notEqual(id, remote);
    assert.equal((await req(`/${id}/output?cursor=0`, bob.id)).status, 404);
    assert.deepEqual(await (await req(`/${id}/output?cursor=0`)).json(), { data: 'hello', cursor: 5, more: false, truncated: false, running: true });
    fail = true;
    const failed = await req(`/${id}/input`, alice.id, 'POST', { sequence: 1, data: 'input' }); assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes('private diagnostic'));
    assert.equal(writes, 1); assert.equal((await req(`/${id}/input`, alice.id, 'POST', { sequence: 1, data: 'input' })).status, 404); assert.equal(writes, 1);
    fail = false;
    const second = await req('', alice.id, 'POST', { targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }); assert.equal(second.status, 200);
    const secondId = (await second.json()).id;
    afterRead = () => { hub.upsertConnection({ ...connection, status: 'disabled' }); };
    assert.equal((await req(`/${secondId}/output?cursor=0`)).status, 403);
    assert.equal((await req(`/${secondId}/output?cursor=0`)).status, 404);
    assert.ok(deletes >= 1);
  } finally { routes?.close(); await new Promise(resolve => setImmediate(resolve)); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('Hub terminal reservations enforce per-owner cap across simultaneous starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-terminal-admission-')), hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const user = hub.createUser('Owner'); hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://fixture', ownerUserId: user.id });
  let gate: Promise<void> | undefined, release: (() => void) | undefined, reached: (() => void) | undefined;
  const audit = new AuthAuditLog();
  const routes = registerHubTerminals(app, { hubStore: hub, principal: () => ({ userId: user.id, admin: false }), audit,
    connectorClient: () => new ConnectorClient('http://fixture', 'synthetic', async request => {
      if (request.method === 'POST') { reached?.(); await gate; }
      return new Response(JSON.stringify({ id: randomUUID() }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
    }) });
  const start = () => app.request('/api/hub/v1/connections/dev/terminals', { method: 'POST', body: JSON.stringify({ targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await start()).status, 200);
    gate = new Promise(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { reached = resolve; });
    const fourth = start(); await entered;
    assert.equal((await start()).status, 429, 'pending fourth owns its slot');
    release!(); assert.equal((await fourth).status, 200);
    assert.equal((await start()).status, 429);
    assert.equal(audit.page().records.filter(r => r.reason === 'workspace_terminal_started:shell').length, 4);
  } finally { release?.(); routes.close(); await new Promise(resolve => setImmediate(resolve)); hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('Hub terminal idle output and cleanup retain physical dispatch and source cancel ACK across abort and close', async () => {
  const hub = new HubStore(':memory:', 'synthetic'), app = new Hono();
  const user = hub.createUser('Owner');
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://fixture', ownerUserId: user.id });
  const remote = randomUUID();
  let outCalls = 0, deletes = 0, outCancels = 0, deleteCancels = 0;
  let outStarted!: () => void, outDispatch!: (response: Response) => void, releaseOutCancel!: () => void;
  let deleteStarted!: () => void, deleteDispatch!: (response: Response) => void, releaseDeleteCancel!: () => void;
  const outEntered = new Promise<void>(resolve => { outStarted = resolve; });
  const outHeld = new Promise<Response>(resolve => { outDispatch = resolve; });
  const deleteEntered = new Promise<void>(resolve => { deleteStarted = resolve; });
  const deleteHeld = new Promise<Response>(resolve => { deleteDispatch = resolve; });
  const routes = registerHubTerminals(app, {
    hubStore: hub, audit: new AuthAuditLog(), principal: () => ({ userId: user.id, admin: false }),
    connectorClient: () => new ConnectorClient('http://fixture', 'synthetic', async req => {
      const path = new URL(req.url).pathname;
      if (req.method === 'POST' && path.endsWith('/terminals')) {
        return Response.json({ id: remote }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
      }
      if (path.endsWith('/output')) { outCalls++; outStarted(); return outHeld; }
      if (req.method === 'DELETE') { deletes++; deleteStarted(); return deleteHeld; }
      return Response.json({ accepted: true }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
    }),
  });
  const base = '/api/hub/v1/connections/dev/terminals';
  try {
    const started = await app.request(base, { method: 'POST', body: JSON.stringify({ targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }) });
    const { id } = await started.json();
    const controller = new AbortController();
    const pendingOutput = app.request(`${base}/${id}/output?cursor=0`, { signal: controller.signal });
    await outEntered;
    controller.abort();
    let outSettled = false;
    void pendingOutput.then(() => { outSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outSettled, false);
    outDispatch(new Response(new ReadableStream({
      cancel() { outCancels++; return new Promise<void>(resolve => { releaseOutCancel = resolve; }); },
    }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }));
    for (let i = 0; outCancels === 0 && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(outCancels, 1);
    assert.equal(outSettled, false);
    let closed = false;
    const closing = routes.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    await deleteEntered;
    assert.equal(closed, false);
    // Wait for DELETE timeout or abort cleanup stream; simulate an immediate stream whose cancel ACK is held after abort
    deleteDispatch(new Response(new ReadableStream({
      start() { /* hold open until DELETE timeout aborts */ },
      cancel() { deleteCancels++; return new Promise<void>(resolve => { releaseDeleteCancel = resolve; }); },
    }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } }));
    releaseOutCancel();
    assert.ok([499, 503].includes((await pendingOutput).status));
    for (let i = 0; deleteCancels === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(deleteCancels, 1);
    assert.equal(closed, false);
    releaseDeleteCancel();
    await closing;
    assert.equal(outCalls, 1);
    assert.equal(deletes, 1);
  } finally { await hub.close(); }
});
