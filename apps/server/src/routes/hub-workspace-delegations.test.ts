import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorBoardBindings } from '../connector/board-bindings-http.js';
import { projectSessionDirectory, parseSessionDirectoryQuery } from '../projection/session-directory.js';
import { registerHubDelegations } from './hub-workspace-delegations.js';

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'delegation-http-')), directory = join(root, 'private'); await mkdir(directory, { mode: 0o700 });
  const store = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono(), connector = new Hono();
  const owner = store.createUser('Alice').id, other = store.createUser('Bob').id, task = randomUUID(), group = randomUUID();
  const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
  store.boards.save(owner, 'default', { revision: 0, mutationId: randomUUID(), title: 'Board', tasks: [{ id: task, title: 'Task', detail: '', status: 'todo' }] });
  store.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example' });
  store.pinConnectionNode('dev', owner, store.connectionAuthority('dev', owner)!, `node_${randomUUID()}`);
  const sessions = new Map([['codex:a', randomUUID()], ['codex:b', randomUUID()]]);
  store.workspace.save(owner, { revision: 0, groups: [{ id: group, name: 'Test' }], sessions: Object.fromEntries([...sessions.keys()].map(k => [encodeHubSessionId('dev', k), { groupId: group, tags: ['test'] }])) });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), token = tokens.createTransient(['boards:bind'], 'hub-token');
  connector.use('*', async (c, next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); });
  let revision = 'v1', brokenDirectory = false, drop = false, offline = false, ready = true, puts = 0;
  connector.get('/api/connector/v1/sessions/directory', c => brokenDirectory ? c.json({ error: 'offline' }, 503)
    : c.json(projectSessionDirectory(sessions.keys(), parseSessionDirectoryQuery(new URL(c.req.url).searchParams), revision)));
  const bindings = registerConnectorBoardBindings(connector, { tokens, directories: { codex: directory }, policies: [{ owner: 'hub-token', runtime: 'codex', endpoint }],
    resolveSession: key => sessions.has(key) ? { runtime: 'codex', sessionId: sessions.get(key)!, ready } : undefined });
  await bindings.ready;
  const routes = registerHubDelegations(app, { hubStore: store, endpoint, principal: c => {
    const userId = c.req.header('x-user'); if (!userId) throw new HTTPException(401); return { userId, admin: false };
  }, connectorClient: () => new ConnectorClient('https://connector.example', token.token, async request => {
    if (offline) throw Error('synthetic offline');
    if (request.method === 'PUT') puts++;
    const result = await connector.request(request);
    if (drop && request.method === 'PUT') throw Error('synthetic lost response');
    return result;
  }) });
  t.after(async () => { routes.close(); token.dispose(); await bindings.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const input = { batchId: randomUUID(), selection: { groupId: group, tags: ['test'], tagMode: 'all' }, taskIds: [task], fields: ['status'], expiresAt: Date.now() + 60_000 };
  const req = (method: string, suffix = '', body?: unknown, actor = owner) => app.request('/api/hub/v1/workspace/boards/default/delegations' + suffix,
    { method, headers: { 'x-user': actor }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { store, owner, other, input, req, sessions, get puts() { return puts; },
    drop() { drop = true; }, offline() { offline = true; }, notReady() { ready = false; },
    changeDirectory() { sessions.set('codex:c', randomUUID()); revision = 'v2'; }, breakDirectory() { brokenDirectory = true; } };
}

test('preview is read-only; confirmation installs frozen task grants, duplicate confirm and recovery never PUT again', async t => {
  const f = await fixture(t), id = f.input.batchId;
  const preview = await f.req('POST', '', f.input); assert.equal(preview.status, 201);
  const p = await preview.json(); assert.equal(p.batch.members.length, 2); assert.equal(f.puts, 0);
  assert.equal((await f.req('GET', `/${id}`, undefined, f.other)).status, 404);
  const confirmed = await f.req('POST', `/${id}/confirm`, {}); assert.equal(confirmed.status, 200);
  const b = (await confirmed.json()).batch; assert.deepEqual(b.members.map((m: any) => m.state), ['installed', 'installed']); assert.equal(f.puts, 2);
  for (const m of b.members) { const credential = f.store.boardBindings.credential(f.owner, 'default', m.requestId)!; assert.ok(credential); assert.ok(!JSON.stringify(b).includes(credential.token)); }
  assert.equal((await f.req('POST', `/${id}/confirm`, {})).status, 200);
  assert.equal((await f.req('GET', `/${id}`)).status, 200); assert.equal(f.puts, 2);
  const cancel = await f.req('DELETE', `/${id}`); assert.equal(cancel.status, 200);
  assert.ok((await cancel.json()).batch.members.every((m: any) => m.state === 'revoked'));
  for (const m of b.members) assert.equal(f.store.boardBindings.credential(f.owner, 'default', m.requestId), undefined);
});

test('lost remote ACK recovers original IDs by GET; offline cancellation revokes before cleanup', async t => {
  const f = await fixture(t), id = f.input.batchId;
  assert.equal((await f.req('POST', '', f.input)).status, 201); f.drop();
  const response = await f.req('POST', `/${id}/confirm`, {});
  assert.ok((await response.json()).batch.members.every((m: any) => m.state === 'unknown')); assert.equal(f.puts, 2);
  const recovered = (await (await f.req('GET', `/${id}`)).json()).batch;
  assert.ok(recovered.members.every((m: any) => m.state === 'installed')); assert.equal(f.puts, 2);
  f.offline(); const cancelled = (await (await f.req('DELETE', `/${id}`)).json()).batch;
  assert.ok(cancelled.members.every((m: any) => m.state === 'cleanup_pending'));
  for (const m of recovered.members) assert.equal(f.store.boardBindings.credential(f.owner, 'default', m.requestId), undefined);
});

test('changed selected membership invalidates preview instead of expanding it; missing directory is not an empty grant', async t => {
  const f = await fixture(t); assert.equal((await f.req('POST', '', f.input)).status, 201);
  const prefs = f.store.workspace.get(f.owner); prefs.sessions[encodeHubSessionId('dev', 'codex:b')] = { tags: [] }; f.store.workspace.save(f.owner, prefs);
  assert.equal((await f.req('POST', `/${f.input.batchId}/confirm`, {})).status, 409); assert.equal(f.puts, 0);
  f.breakDirectory(); assert.equal((await f.req('POST', '', { ...f.input, batchId: randomUUID() })).status, 502); assert.equal(f.puts, 0);
});

test('not-ready native sessions cannot be preview-confirmed and request-body catalogs cannot authorize', async t => {
  const f = await fixture(t); f.notReady();
  assert.equal((await f.req('POST', '', f.input)).status, 409);
  assert.equal((await f.req('POST', '', { ...f.input, catalog: { members: [] } })).status, 400); assert.equal(f.puts, 0);
});

test('cancelling an absent preview leaves a tombstone against delayed prepare', async t => {
  const f = await fixture(t), id = f.input.batchId;
  assert.equal((await f.req('GET', `/${id}`)).status, 404);
  const cancelled = await f.req('DELETE', `/${id}`); assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { batch: null, cancelled: true, batchId: id });
  assert.equal((await f.req('POST', '', f.input)).status, 409); assert.equal(f.puts, 0);
});
