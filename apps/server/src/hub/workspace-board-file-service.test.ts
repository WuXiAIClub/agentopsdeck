import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { Server } from 'node:http';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorFileBoards } from '../connector/workspace-board-files.js';
import { registerConnectorFileBoards } from '../connector/workspace-board-files-http.js';
import { serializeBoardFile } from '../connector/workspace-board-file-format.js';
import { ConnectorClient } from './connector-client.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardFiles } from './workspace-board-files.js';
import { HubFileBoardService } from './workspace-board-file-service.js';
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_PROTOCOL } from '@agentopsdeck/shared';
import { registerHubBoardFiles } from '../routes/hub-workspace-board-files.js';
import { FILE_BOARD_RUNTIMES } from '../connector/workspace-board-file-policy.js';

async function until(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'condition did not converge');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(runtime = 'codex', declaration?: object) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-board-service-')), directory = join(root, 'files');
  await mkdir(directory, { mode: 0o700 });
  const connectorDb = new DatabaseSync(':memory:'), hubDb = new DatabaseSync(':memory:');
  const tokens = new ConnectorTokenStore(join(root, 'tokens'));
  const token = tokens.createTransient(['boards:files'], 'owner'), sessionKey = `${runtime}:${randomUUID()}`;
  const remote = new ConnectorFileBoards(connectorDb, directory, (owner, key) => owner === 'owner' && key === sessionKey);
  const app = new Hono();
  app.use('*', async (c, next) => { c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); await next(); });
  const http = registerConnectorFileBoards(app, { tokens, boards: remote, session: key => ({ exists: key === sessionKey, ready: true }) });
  await http.ready;
  let puts = 0, streams = 0, lost = false, offline = false, authority = 1;
  const streamStatuses: number[] = [];
  const client = new ConnectorClient('http://connector.test', token.token, async request => {
    if (offline) throw new Error('offline');
    if (declaration && request.url.endsWith('/workspace/board-files')) return Response.json({ protocol: 1, writeProtocol: 1, mode: 'whole-board-file', ...declaration },
      { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
    if (request.method === 'PUT') puts++;
    if (request.url.endsWith('/subscribe')) streams++;
    const response = await app.fetch(request);
    if (request.url.endsWith('/subscribe')) streamStatuses.push(response.status);
    if (request.method === 'PUT' && lost) { lost = false; await response.body?.cancel(); throw new Error('response lost'); }
    return response;
  });
  const boards = new WorkspaceBoards(hubDb);
  const files = new WorkspaceBoardFiles(hubDb, boards, b => b.userId === 'owner' && b.authority === authority);
  const makeService = () => new HubFileBoardService(files, boards, (owner, sessionId) => {
    assert.equal(owner, 'owner'); assert.equal(sessionId, sessionKey);
    return { connectionId: 'connector', sessionKey, authority, client, valid: () => {} };
  });
  let service = makeService();
  return { boards, files, remote, sessionKey, client, get service() { return service; },
    puts: () => puts, streams: () => streams, streamStatuses, lose: () => { lost = true; }, offline: () => { offline = true; },
    changeAuthority: () => { authority++; },
    restart: async () => { await service.close(); service = makeService(); service.start(); },
    bind: (resourceId = 'default') => service.bind('owner', resourceId, { requestId: randomUUID(), sessionId: sessionKey, revision: 0 }),
    close: async () => { await service.close(); await http.close(); hubDb.close(); connectorDb.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const runtime of FILE_BOARD_RUNTIMES) for (const modern of [false, true])
test(`${runtime}/${modern ? 'declared' : 'legacy'}: HTTP two-way board write, stale revision and mutation replay`, async () => {
  const f = await fixture(runtime, modern ? { runtimeProtocol: 1, runtimes: [...FILE_BOARD_RUNTIMES] } : undefined);
  try {
    const binding = await f.bind(); f.service.start();
    await until(() => !!f.files.get('owner', binding.bindingId)?.sourceHash);
    assert.equal(await f.service.writable('owner', 'default'), true);
    const before = f.boards.get('owner', 'default');
    const input = { title: 'User updated', tasks: [], revision: before.revision, mutationId: randomUUID() };
    const result = await f.service.write('owner', 'default', binding.bindingId, input);
    assert.equal(result.state, 'saved');
    await until(() => f.boards.get('owner', 'default').title === 'User updated');
    await writeFile(f.remote.get('owner', binding.bindingId).path, serializeBoardFile({ title: 'Agent next', tasks: [] }));
    await until(() => f.boards.get('owner', 'default').title === 'Agent next');
    assert.equal((await f.service.write('owner', 'default', binding.bindingId, input)).state, 'saved');
    assert.equal(f.boards.get('owner', 'default').title, 'Agent next');
    await assert.rejects(f.service.write('owner', 'default', binding.bindingId, { ...input, mutationId: randomUUID() }));
    await f.restart();
    assert.equal((await f.service.inspectWrite('owner', 'default', binding.bindingId, input.mutationId)).state, 'saved');
  } finally { await f.close(); }
});

for (const declaration of [
  { runtimeProtocol: 1, runtimes: [] }, { runtimeProtocol: 1, runtimes: ['ghcp'] },
  { runtimeProtocol: 2, runtimes: ['codex'] }, { runtimeProtocol: 1 }, { runtimes: ['codex'] },
  { runtimeProtocol: 1, runtimes: 'codex' }, { runtimeProtocol: 1, runtimes: ['codex', 'codex'] },
  { runtimeProtocol: 1, runtimes: ['codex', 'hermes'] }, { runtimeProtocol: 1, runtimes: [null] },
]) test(`negative/malformed runtime declaration leaves board editable: ${JSON.stringify(declaration)}`, async () => {
  const f = await fixture('codex', declaration);
  try {
    const before = f.boards.get('owner', 'default');
    await assert.rejects(f.bind(), { status: 409 });
    assert.equal(f.puts(), 0);
    assert.equal(f.files.current('owner', 'default'), undefined);
    assert.deepEqual(f.boards.get('owner', 'default'), before);
  } finally { await f.close(); }
});

for (const runtime of ['hermes', 'unknown']) test(`${runtime} cannot bind even through a legacy Connector`, async () => {
  const f = await fixture(runtime);
  try {
    await assert.rejects(f.bind(), { status: 409 });
    assert.equal(f.puts(), 0);
    assert.equal(f.files.current('owner', 'default'), undefined);
  } finally { await f.close(); }
});

test('corrected runtime policy can reuse a preflight-denied request without an orphan or automatic retry', async () => {
  const declaration = { runtimeProtocol: 1, runtimes: [] as string[] }, f = await fixture('codex', declaration);
  try {
    const input = { requestId: randomUUID(), sessionId: f.sessionKey, revision: 0 };
    await assert.rejects(f.service.bind('owner', 'default', input), { status: 409 });
    assert.equal(f.files.get('owner', input.requestId), undefined); assert.equal(f.puts(), 0);
    declaration.runtimes.push('codex');
    assert.equal((await f.service.bind('owner', 'default', input)).state, 'active');
    assert.equal(f.puts(), 1);
    declaration.runtimes.length = 0;
    assert.equal((await f.service.bind('owner', 'default', input)).state, 'active');
    assert.equal(f.puts(), 1, 'an existing receipt is not a fresh capability grant or another PUT');
  } finally { await f.close(); }
});

test('real Connector HTTP/SSE projects whole empty boards, pools subscription and rebuilds after restart', async () => {
  const f = await fixture();
  try {
    const secondId = randomUUID(), first = await f.bind(), second = await f.bind(secondId);
    assert.equal(first.state, 'active'); assert.equal(second.state, 'active');
    f.service.start();
    await until(() => f.streams() === 1);
    await writeFile(f.remote.get('owner', first.bindingId).path, serializeBoardFile({ title: 'Agent tasks', tasks: [
      { id: randomUUID(), title: 'Added after binding', detail: '', status: 'done' },
    ] }));
    await until(() => f.boards.get('owner', 'default').tasks.length === 1);
    assert.equal(f.boards.get('owner', secondId).tasks.length, 0);
    await f.restart(); await until(() => f.streams() >= 2);
    assert.equal(f.puts(), 2, 'restart must not reinstall or overwrite');
    await writeFile(f.remote.get('owner', second.bindingId).path, serializeBoardFile({ title: 'Second board', tasks: [] }));
    await until(() => f.boards.get('owner', secondId).title === 'Second board');
    assert.deepEqual(f.streamStatuses, [200, 200]);
  } finally { await f.close(); }
});

test('lost install response stays prepared; duplicate is read-only and inspection recovers Agent edits', async () => {
  const f = await fixture();
  try {
    f.lose(); const result = await f.bind(); assert.equal(result.state, 'prepared');
    await writeFile(f.remote.get('owner', result.bindingId).path, serializeBoardFile({ title: 'Do not overwrite', tasks: [] }));
    const duplicate = await f.service.bind('owner', 'default', { requestId: result.bindingId, sessionId: f.sessionKey, revision: 0 });
    assert.equal(duplicate.state, 'prepared'); assert.equal(f.puts(), 1);
    assert.equal((await f.service.inspect('owner', 'default', result.bindingId)).state, 'active');
    f.service.start(); await until(() => f.boards.get('owner', 'default').title === 'Do not overwrite');
    assert.equal(f.puts(), 1);
  } finally { await f.close(); }
});

test('offline revocation fences imports immediately and authority change blocks activation', async () => {
  const f = await fixture();
  try {
    f.lose(); const result = await f.bind(); f.changeAuthority();
    await assert.rejects(f.service.inspect('owner', 'default', result.bindingId));
    f.offline(); const revoked = await f.service.revoke('owner', 'default', result.bindingId);
    assert.equal(revoked.binding.state, 'revoked'); assert.equal(revoked.cleanup, 'pending');
    assert.equal(f.boards.fileManaged('owner', 'default'), false);
  } finally { await f.close(); }
});

test('Hub HTTP binds the whole board without selected tasks; rejects arbitrary authority and fences cross-owner inspection', async () => {
  const f = await fixture(), app = new Hono();
  let owner = 'owner';
  registerHubBoardFiles(app, { files: f.files, service: f.service, principal: () => ({ userId: owner, admin: false }) });
  const path = '/api/hub/v1/workspace/boards/default/file-binding';
  const send = (body: unknown) => app.request(path, { method: 'POST', body: JSON.stringify(body) });
  try {
    const input = { requestId: randomUUID(), sessionId: f.sessionKey, revision: 0 };
    for (const field of ['owner', 'path', 'authority', 'url', 'taskIds']) {
      assert.equal((await send({ ...input, [field]: 'untrusted' })).status, 400);
    }
    assert.equal(f.puts(), 0);
    f.lose(); const response = await send(input);
    assert.equal(response.status, 202); assert.equal((await response.json()).binding.state, 'prepared');
    assert.equal((await send(input)).status, 202); assert.equal(f.puts(), 1);
    owner = 'other';
    assert.equal((await (await app.request(path)).json()).binding, null);
    assert.equal((await app.request(path + '/' + input.requestId)).status, 404);
    assert.equal((await app.request(path + '/' + input.requestId, { method: 'DELETE' })).status, 404);
    owner = 'owner';
    assert.equal((await (await app.request(path + '/' + input.requestId)).json()).binding.state, 'active');
    const revoked = await app.request(path + '/' + input.requestId, { method: 'DELETE' });
    assert.equal(revoked.status, 200); assert.equal((await revoked.json()).cleanup, 'confirmed');
    assert.equal((await (await app.request(path)).json()).binding, null);
    assert.equal(f.puts(), 1);
  } finally { await f.close(); }
});

test('real HTTP empty DELETE unlinks and empty POST cancels; body bytes cannot mutate a binding', async () => {
  const f = await fixture(), app = new Hono();
  registerHubBoardFiles(app, { files: f.files, service: f.service, principal: () => ({ userId: 'owner', admin: false }) });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const binding = await f.bind();
    const url = `http://127.0.0.1:${address.port}/api/hub/v1/workspace/boards/default/file-binding/${binding.bindingId}`;
    const headers = { 'content-type': 'application/json' };
    assert.equal((await fetch(url, { method: 'DELETE', headers, body: ' ' })).status, 400);
    assert.equal(f.files.current('owner', 'default')?.state, 'active');
    const response = await fetch(url, { method: 'DELETE', headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cleanup, 'confirmed');
    assert.equal(f.files.current('owner', 'default'), undefined);
    const pending = { requestId: randomUUID(), sessionId: f.sessionKey, revision: f.boards.get('owner', 'default').revision };
    const cancelUrl = url.replace(binding.bindingId, pending.requestId) + '/cancel';
    assert.equal((await fetch(cancelUrl, { method: 'POST', headers, body: '{}' })).status, 400);
    const cancel = await fetch(cancelUrl, { method: 'POST', headers });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).cancelled, true);
    await assert.rejects(f.service.bind('owner', 'default', pending), /unavailable/i);
  } finally {
    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.close();
  }
});

test('cancellation fences an in-flight capability preflight and delayed retry without installing', async () => {
  const f = await fixture();
  const original = f.client.json.bind(f.client);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.client.json = async (...args: Parameters<typeof original>) => {
    if (args[0] === '/workspace/board-files') { started(); await gate; }
    return original(...args);
  };
  try {
    const input = { requestId: randomUUID(), sessionId: f.sessionKey, revision: 0 };
    const binding = f.service.bind('owner', 'default', input);
    await entered;
    assert.deepEqual(await f.service.cancel('owner', 'default', input.requestId), { cancelled: true, cleanup: 'confirmed' });
    release();
    await assert.rejects(binding, { status: 409 });
    await f.restart();
    await assert.rejects(f.service.bind('owner', 'default', input), { status: 409 });
    assert.equal(f.puts(), 0); assert.equal(f.files.current('owner', 'default'), undefined);
  } finally { release(); await f.close(); }
});

test('disabled Hub feature retains metadata and allows cancellation without activating a pending install', async () => {
  const f = await fixture(), app = new Hono();
  registerHubBoardFiles(app, { files: f.files, service: f.service, enabled: false, principal: () => ({ userId: 'owner', admin: false }) });
  try {
    f.lose(); const binding = await f.bind();
    const path = '/api/hub/v1/workspace/boards/default/file-binding';
    assert.equal((await app.request(path, { method: 'POST', body: '{}' })).status, 503);
    assert.equal((await (await app.request(path)).json()).binding.state, 'prepared');
    assert.equal((await (await app.request(path + '/' + binding.bindingId)).json()).binding.state, 'prepared');
    assert.equal((await app.request(path + '/' + binding.bindingId + '/cancel', { method: 'POST' })).status, 200);
    assert.equal(f.files.get('owner', binding.bindingId)?.state, 'revoked');
    assert.equal(f.puts(), 1);
  } finally { await f.close(); }
});
