import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { Server } from 'node:http';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { ConnectorFileBoards } from './workspace-board-files.js';
import { registerConnectorFileBoards } from './workspace-board-files-http.js';
import { serializeBoardFile } from './workspace-board-file-format.js';

async function fixture(waitForSession?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-panel-http-')), directory = join(root, 'data');
  await mkdir(directory, { mode: 0o700 });
  const db = new DatabaseSync(':memory:'), tokens = new ConnectorTokenStore(join(root, 'tokens'));
  const owner = tokens.createTransient(['boards:files'], 'owner'), other = tokens.createTransient(['boards:files'], 'other');
  const old = tokens.createTransient([...DEFAULT_SCOPES, 'boards:bind', 'files:read'], 'legacy');
  const sessionKey = `codex:${randomUUID()}`; let running = true;
  const boards = new ConnectorFileBoards(db, directory, (actor, key) => tokens.hasScope(actor, 'boards:files') && key === sessionKey);
  const app = new Hono(), service = registerConnectorFileBoards(app, { boards, tokens,
    session: async key => { await waitForSession?.(); return { exists: key === sessionKey, ready: running }; } });
  await service.ready;
  const request = (method: string, path: string, body?: unknown, token = owner.token) => app.request('/api/connector/v1/workspace/board-files/' + path,
    { method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, root, tokens, boards, owner, other, old, request, sessionKey, service,
    offline: () => { running = false; },
    close: async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

test('native Connector HTTP allows empty DELETE but never treats invalid content as absent', async () => {
  const f = await fixture();
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const id = randomUUID();
    assert.equal((await f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: 'Native HTTP', tasks: [] } })).status, 200);
    const url = `http://127.0.0.1:${address.port}/api/connector/v1/workspace/board-files/${id}`;
    const headers = { authorization: `Bearer ${f.owner.token}` };
    for (const body of [' ', '{}', 'null']) {
      const response = await fetch(url, { method: 'DELETE', headers, body });
      assert.equal(response.status, 400); await response.text();
      assert.equal(f.boards.get('owner', id).state, 'installed');
    }
    const response = await fetch(url, { method: 'DELETE', headers });
    assert.equal(response.status, 200); await response.text();
    assert.equal(f.boards.get('owner', id).state, 'revoked');
  } finally {
    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});

test('installation awaits native readiness and rechecks authority after that read', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { entered(); await ready; });
  try {
    const id = randomUUID();
    const installing = f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: 'Empty', tasks: [] } });
    await waiting;
    assert.throws(() => f.boards.get('owner', id));
    release();
    assert.equal((await installing).status, 200);
    assert.equal(f.boards.get('owner', id).state, 'installed');
  } finally { release(); await f.close(); }
});

test('revocation during native readiness cannot install a file', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { entered(); await ready; });
  try {
    const id = randomUUID();
    const installing = f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: 'Empty', tasks: [] } });
    await waiting; f.owner.dispose(); release();
    assert.equal((await installing).status, 401);
    assert.throws(() => f.boards.get('owner', id));
  } finally { release(); await f.close(); }
});
function frames(response: Response) {
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  return { reader, next: async () => {
    const deadline = setTimeout(() => { void reader.cancel(); }, 3000);
    try {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read(); assert.equal(chunk.done, false, 'stream ended before expected event');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n\n'), value = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(value)?.[1], data = JSON.parse(/^data: (.*)$/m.exec(value)![1]!);
      return { event, data };
    } finally { clearTimeout(deadline); }
  } };
}

test('file HTTP uses independent opt-in authority; rejects paths, invalid sessions and cross-owner IDs', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), body = { sessionKey: f.sessionKey, content: { title: 'Empty is fine', tasks: [] } };
    assert.equal((await f.request('PUT', id, body, 'invalid')).status, 401);
    assert.equal((await f.request('PUT', id, body, f.old.token)).status, 403);
    assert.equal((await f.request('PUT', id, { ...body, path: '/tmp/arbitrary' })).status, 400);
    assert.equal((await f.request('PUT', id, { ...body, sessionKey: 'codex:other' })).status, 404);
    assert.equal((await f.request('PUT', id, body)).status, 200);
    assert.equal((await f.request('GET', id, undefined, f.other.token)).status, 404);
    assert.equal((await f.request('DELETE', id, undefined, f.other.token)).status, 404);
    const binding = (await (await f.request('GET', id)).json()).binding;
    assert.ok(binding.context.includes(binding.path));
    await writeFile(binding.path, serializeBoardFile({ title: 'Agent changed it', tasks: [] }));
    f.offline();
    assert.equal((await f.request('PUT', randomUUID(), body)).status, 503);
    assert.equal((await f.request('PUT', id, body)).status, 200);
    assert.ok((await readFile(binding.path, 'utf8')).includes('Agent changed it'));
    assert.equal((await f.request('GET', id + '?path=other')).status, 400);
    assert.equal((await f.request('DELETE', id)).status, 200);
    assert.equal((await (await f.request('PUT', id, body)).json()).binding.state, 'revoked');
  } finally { await f.close(); }
});

test('one shared stream delivers multiple boards; one revoked binding closes without blocking other boards', async () => {
  const f = await fixture(); let stream: ReturnType<typeof frames> | undefined;
  try {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) assert.equal((await f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: id, tasks: [] } })).status, 200);
    assert.equal((await f.request('POST', 'subscribe', { ids: [ids[0], ids[0]] })).status, 400);
    const foreign = frames(await f.request('POST', 'subscribe', { ids }, f.other.token));
    try {
      for (const id of ids) assert.deepEqual(await foreign.next(), { event: 'board-file.closed', data: { id } });
      assert.equal((await foreign.reader.read()).done, true);
    } finally { await foreign.reader.cancel(); }
    const response = await f.request('POST', 'subscribe', { ids });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    stream = frames(response);
    assert.equal((await stream.next()).data.id, ids[0]); assert.equal((await stream.next()).data.id, ids[1]);
    assert.equal((await stream.next()).event, 'heartbeat');
    await f.request('DELETE', ids[0]!);
    assert.deepEqual(await stream.next(), { event: 'board-file.closed', data: { id: ids[0] } });
    await writeFile(f.boards.get('owner', ids[1]!).path, serializeBoardFile({ title: 'Live second board', tasks: [] }));
    const event = await stream.next(); assert.equal(event.event, 'board-file.snapshot');
    assert.equal(event.data.snapshot.value.content.title, 'Live second board');
    assert.equal(event.data.id, ids[1]);
  } finally { await stream?.reader.cancel(); await f.close(); }
});

test('scope revocation promptly closes live stream and reconciles durable delegation', async () => {
  const f = await fixture(); let stream: ReturnType<typeof frames> | undefined;
  try {
    const id = randomUUID(); await f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: 'Test', tasks: [] } });
    stream = frames(await f.request('POST', 'subscribe', { ids: [id] }));
    await stream.next(); await stream.next();
    f.owner.dispose();
    const deadline = setTimeout(() => { void stream!.reader.cancel(); assert.fail('revocation did not close stream'); }, 3000);
    try { assert.equal((await stream.reader.read()).done, true); } finally { clearTimeout(deadline); }
    await f.service.close();
    assert.equal(f.tokens.changes.waiting, 0); assert.equal(f.boards.changes.waiting, 0);
  } finally { await stream?.reader.cancel(); await f.close(); }
});

test('cancel arriving before installation fences late PUT without creating a file', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    assert.equal((await f.request('DELETE', id, { sessionKey: f.sessionKey })).status, 200);
    const late = await f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: 'Late', tasks: [] } });
    assert.equal(late.status, 200);
    assert.equal((await late.json()).binding.state, 'revoked');
    await assert.rejects(readFile(join(f.root, 'data', id, 'tasks.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('reconnect reports a revoked binding but still initializes the other board', async () => {
  const f = await fixture(); let stream: ReturnType<typeof frames> | undefined;
  try {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await f.request('PUT', id, { sessionKey: f.sessionKey, content: { title: id, tasks: [] } });
    await f.request('DELETE', ids[0]!);
    stream = frames(await f.request('POST', 'subscribe', { ids }));
    const events = [await stream.next(), await stream.next()];
    assert.ok(events.some(e => e.event === 'board-file.closed' && e.data.id === ids[0]));
    assert.ok(events.some(e => e.event === 'board-file.snapshot' && e.data.id === ids[1]));
  } finally { await stream?.reader.cancel(); await f.close(); }
});
