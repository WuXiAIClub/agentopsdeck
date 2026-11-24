import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { registerConnectorBoardBindings } from './board-bindings-http.js';
import { ConnectorBoardBindings } from './board-bindings.js';
import { BOARD_READ_TOOL, loadWorkerBoardTools } from '../tools/workspace-board-worker.js';

test('default-off board bindings allocate no token-change listener', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-binding-disabled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const service = registerConnectorBoardBindings(new Hono(), {
    tokens, directories: {}, policies: [], resolveSession: () => undefined,
  });
  t.after(() => service.close());
  await service.ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tokens.changes.waiting, 0);
  const actor = tokens.createTransient(['boards:bind'], 'owner');
  actor.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tokens.changes.waiting, 0);
  await service.close();
  assert.equal(tokens.changes.waiting, 0);
});

test('removed policies still reconcile configured directories and close releases the watcher', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-binding-removed-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const actor = tokens.createTransient(['boards:bind'], 'owner');
  t.after(() => actor.dispose());
  const sessionId = randomUUID(), endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
  const bindings = new ConnectorBoardBindings({ ghcp: directory }, [{ owner: 'owner', runtime: 'ghcp', endpoint }], () => true);
  await bindings.install('owner', { id: randomUUID(), runtime: 'ghcp', sessionId,
    credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } });
  const service = registerConnectorBoardBindings(new Hono(), {
    tokens, directories: { ghcp: directory }, policies: [], resolveSession: () => undefined,
  });
  t.after(() => service.close());
  await service.ready;
  assert.equal(await loadWorkerBoardTools(directory, 'ghcp', sessionId, () => true), undefined);
  // Reconciliation performs filesystem I/O; wait boundedly for its listener.
  for (let attempt = 0; tokens.changes.waiting === 0 && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(tokens.changes.waiting, 1);
  await service.close();
  assert.equal(tokens.changes.waiting, 0);
});

test('Connector private binding HTTP: independent scope, authoritative native ID, metadata-only replay, maintenance and revocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-binding-http-')), directory = join(root, 'private');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(directory, { mode: 0o700 });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const a = tokens.createTransient(['boards:bind'], 'owner'), b = tokens.createTransient(['boards:bind'], 'other'), low = tokens.createTransient(DEFAULT_SCOPES, 'low');
  t.after(() => { a.dispose(); b.dispose(); low.dispose(); });
  const sessionId = randomUUID(), endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
  const app = new Hono(); let ready = true, exists = true;
  const service = registerConnectorBoardBindings(app, { tokens, directories: { ghcp: directory }, policies: [{ owner: 'owner', runtime: 'ghcp', endpoint }],
    resolveSession: key => exists && key === 'ghcp:visible' ? { runtime: 'ghcp', sessionId, ready } : undefined });
  t.after(() => service.close()); await service.ready;
  const path = '/api/connector/v1/sessions/ghcp%3Avisible/board-binding';
  const req = (token: string, method = 'GET', body?: unknown, suffix = '') => app.request(path + suffix, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const grant = { id: randomUUID(), credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } };
  assert.equal((await req('invalid')).status, 401); assert.equal((await req(low.token)).status, 403);
  assert.equal((await req(b.token, 'PUT', grant)).status, 403);
  assert.equal((await req(a.token, 'PUT', { ...grant, sessionId: randomUUID() })).status, 400);
  ready = false; assert.equal((await req(a.token, 'PUT', grant)).status, 503); ready = true;
  const response = await req(a.token, 'PUT', grant); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.equal(JSON.stringify(body).includes(grant.credential.token), false); assert.equal(body.binding.sessionId, sessionId);
  assert.deepEqual(await (await req(a.token, 'PUT', grant)).json(), body);
  assert.equal((await req(a.token, 'GET')).status, 200);
  let calls = 0;
  const worker = await loadWorkerBoardTools(directory, 'ghcp', sessionId, () => true, (async () => { calls++; throw Error('unused'); }) as typeof fetch);
  assert.ok(worker);
  assert.equal((await req(a.token, 'DELETE', undefined, `/${randomUUID()}`)).status, 409);
  assert.equal((await req(a.token, 'DELETE', undefined, `/${grant.id}`)).status, 200);
  assert.equal((await req(a.token, 'PUT', grant)).status, 409);
  assert.match(String((await worker.invoke(BOARD_READ_TOOL, {})).error), /unavailable/); assert.equal(calls, 0);
  const next = { ...grant, id: randomUUID() }; assert.equal((await req(a.token, 'PUT', next)).status, 200);
  a.dispose();
  // The watcher is change-driven. Its close awaits queued reconciliation without
  // manufacturing a second mutation or starting another native worker.
  await service.close();
  assert.equal(await loadWorkerBoardTools(directory, 'ghcp', sessionId, () => true), undefined);
  // Closed admission is unavailable regardless of the previous actor's state.
  assert.equal((await req(a.token)).status, 503);
  exists = false;
});
