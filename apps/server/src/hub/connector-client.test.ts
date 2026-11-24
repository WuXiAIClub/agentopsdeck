import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorClient, createConnectorClientResolver, HistoryPreparing } from './connector-client.js';
import { HISTORY_ASYNC_HEADER, historyPendingBody } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { mergeMessageIdentities } from '../messages/identity.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { fileResponse } from '../utils/file-response.js';
import { createConditionalHistoryCache, HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';
import { ConnectorResponseBudgetPool, ConnectorResponseBudgetExceeded } from './response-budget.js';
import { setImmediate as turn } from 'node:timers/promises';

for (const mode of ['json', 'socket', 'terminal'] as const) test(`lifecycle-owned ${mode} retains aborted original dispatch and late cleanup`, async () => {
  let dispatch!: (response: Response) => void, cancel!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const upstream = new Promise<Response>(resolve => { dispatch = resolve; });
  const controller = new AbortController(); let settled = false, calls = 0, cancellations = 0;
  const client = new ConnectorClient('http://connector', 'synthetic', () => { calls++; started(); return upstream; });
  const pending = mode === 'socket' ? client.websiteSocketOutput('access', 'socket', controller.signal)
    : mode === 'terminal' ? client.terminalOutput('term', 0, controller.signal)
    : client.jsonOriginal('/website-access', { method: 'POST', body: '{}', signal: controller.signal });
  const observed = assert.rejects(pending).then(() => { settled = true; });
  await entered; controller.abort(); await turn(); assert.equal(settled, false);
  dispatch(new Response(new ReadableStream({ cancel() { cancellations++; return new Promise<void>(resolve => { cancel = resolve; }); } })));
  await turn(); assert.equal(cancellations, 1); assert.equal(settled, false);
  cancel(); await observed; assert.equal(calls, 1); assert.equal(cancellations, 1);
});

for (const method of ['json', 'jsonResponse'] as const)
  test(`${method} optional collector counts UTF8 transport bytes and preserves original status and JSON`, async () => {
    const body = { users: [{ label: '中😀' }] }, bytes = Buffer.from(JSON.stringify(body));
    const pool = new ConnectorResponseBudgetPool(bytes.length), collector = pool.acquire(bytes.length);
    const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close(); },
    }), { status: 201 }));
    const result = await client[method]('/users', {}, collector);
    assert.deepEqual(result, method === 'json' ? body : { body, status: 201 });
    assert.equal(pool.retainedBytes, bytes.length); assert.equal(collector.snapshot().refused, false);
    collector.close(); assert.equal(pool.retainedBytes, 0);
    assert.deepEqual(await client.json('/users'), body, 'legacy two-argument caller unchanged');
  });

for (const method of ['json', 'jsonResponse'] as const)
  test(`${method} budget refusal waits stream cancel acknowledgement before original rejection`, async () => {
    const pool = new ConnectorResponseBudgetPool(10), collector = pool.acquire(10);
    collector.consume(1);
    let cancel!: () => void, cancellations = 0;
    const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('{"users":["PRIVATE"]}')); },
      cancel() { cancellations++; return new Promise<void>(resolve => { cancel = resolve; }); },
    })));
    const pending = client[method]('/users', {}, collector);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await turn(); assert.equal(cancellations, 1); assert.equal(settled, false);
    assert.equal(pool.retainedBytes, 1, 'no timeout or refusal refunds original reservation');
    assert.throws(() => collector.consume(0), ConnectorResponseBudgetExceeded, 'refusal is sticky');
    cancel(); await assert.rejects(pending, ConnectorResponseBudgetExceeded);
    collector.close(); assert.equal(pool.retainedBytes, 0);
  });

test('JSON collectors share aggregate pool across requests and refused fresh request cannot spend another reservation', async () => {
  const bytes = Buffer.from('{"v":0}'), pool = new ConnectorResponseBudgetPool(bytes.length + 1);
  const first = pool.acquire(bytes.length), second = pool.acquire(bytes.length);
  const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(bytes));
  assert.deepEqual(await client.json('/users', {}, first), { v: 0 });
  await assert.rejects(client.json('/users', {}, second), ConnectorResponseBudgetExceeded);
  assert.equal(pool.retainedBytes, bytes.length); assert.equal(second.snapshot().refused, true);
  first.close(); assert.throws(() => second.consume(0), ConnectorResponseBudgetExceeded);
  second.close(); const fresh = pool.acquire(bytes.length);
  assert.deepEqual(await client.json('/users', {}, fresh), { v: 0 }); fresh.close();
  assert.equal(pool.retainedBytes, 0);
});

test('budgeted JSON abort before headers retains original dispatch and late stream cleanup until acknowledgement', async () => {
  const pool = new ConnectorResponseBudgetPool(32), collector = pool.acquire(32), abort = new AbortController();
  let respond!: (response: Response) => void, cancel!: () => void, cancellations = 0, settled = false;
  const client = new ConnectorClient('http://connector', 'synthetic', () => new Promise<Response>(resolve => { respond = resolve; }));
  const pending = client.json('/users', { signal: abort.signal }, collector);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await turn(); abort.abort(); await turn(); assert.equal(settled, false);
  respond(new Response(new ReadableStream({ cancel() {
    cancellations++; return new Promise<void>(resolve => { cancel = resolve; });
  } })));
  await turn(); assert.equal(cancellations, 1); assert.equal(settled, false);
  cancel(); await assert.rejects(pending); collector.close(); assert.equal(pool.retainedBytes, 0);
});

test('negotiated pending history retains conditional base but never becomes a successful empty page', async () => {
  let phase = 'full', revoked = false;
  const etag = `W/"history-${'a'.repeat(64)}"`, page = { messages: [{ id: 'known', text: 'retained' }], updatedAt: 1 };
  const client = new ConnectorClient('http://connector', 'synthetic', request => {
    assert.equal(request.headers.get(HISTORY_ASYNC_HEADER), '1');
    assert.equal(request.headers.get('if-none-match'), phase === 'full' ? null : etag);
    if (phase === 'pending') return Response.json(historyPendingBody(), { status: 202 });
    if (phase === 'invalid') return Response.json({ messages: [] }, { status: 202 });
    if (phase === 'revoke') { revoked = true; return Response.json(historyPendingBody(), { status: 202 }); }
    return Response.json(page, { headers: { etag } });
  }, undefined, undefined, { authorize() { if (revoked) throw Error('revoked'); } });
  await client.messages('codex:test', '200', undefined, undefined, true);
  phase = 'pending'; await assert.rejects(client.messages('codex:test', '200', undefined, undefined, true), HistoryPreparing);
  phase = 'again'; assert.deepEqual((await client.messages('codex:test', '200', undefined, undefined, true)).messages, page.messages);
  phase = 'revoke'; await assert.rejects(client.messages('codex:test', '200', undefined, undefined, true), /revoked/);
  const invalid = new ConnectorClient('http://connector', 'synthetic', () => Response.json({ messages: [] }, { status: 202 }));
  await assert.rejects(invalid.messages('one', undefined, undefined, undefined, true), /Invalid Connector history preparation/);
  const legacy = new ConnectorClient('http://connector', 'synthetic', () => Response.json(historyPendingBody(), { status: 202 }));
  await assert.rejects(legacy.messages('one'), /Invalid Connector history preparation/);
});

test('history reuse never masks errors, revoked authority, identity mismatches or invalid/oversized deltas', async () => {
  const etag = `W/"history-${'a'.repeat(64)}"`;
  const page = { messages: [{ id: 'm', text: 'x'.repeat(700) }], updatedAt: 1 };
  for (const failure of ['unavailable', 'forbidden', 'identity', 'revoked', 'watermark', 'base', 'expansion'] as const) {
    let calls = 0, revoked = false;
    const client = new ConnectorClient('http://connector', 'synthetic', request => {
      calls++;
      assert.equal(request.headers.get(HISTORY_DELTA_HEADER), '1');
      assert.equal(request.headers.get('if-none-match'), calls === 2 ? etag : null);
      const headers = { etag, [NODE_ID_HEADER]: 'node-test', 'x-agentopsdeck-history-meta': JSON.stringify({ updatedAt: 2, sourceCursor: null }) };
      if (calls !== 2) return Response.json(page, { headers });
      switch (failure) {
        case 'unavailable': return Response.json({}, { status: 503, headers });
        case 'forbidden': return Response.json({}, { status: 403, headers });
        case 'identity': return new Response(null, { status: 304, headers: { ...headers, [NODE_ID_HEADER]: 'wrong-node' } });
        case 'revoked': revoked = true; return new Response(null, { status: 304, headers });
        case 'watermark': return new Response(null, { status: 304, headers: { ...headers, 'x-agentopsdeck-history-meta': '{}' } });
        case 'base': return Response.json({ historyDelta: 1, base: 'wrong', slots: [0], metadata: { updatedAt: 2 } }, { headers: { ...headers, [HISTORY_DELTA_HEADER]: '1' } });
        case 'expansion': return Response.json({ historyDelta: 1, base: etag, slots: [0, 0, 0], metadata: { updatedAt: 2 } }, { headers: { ...headers, [HISTORY_DELTA_HEADER]: '1' } });
      }
    }, undefined, 1024, { nodeId: 'node-test', authorize() { if (revoked) throw new Error('revoked authority'); } });
    await client.messages('codex:test');
    await assert.rejects(client.messages('codex:test'), failure === 'unavailable' ? { status: 503 } : failure === 'forbidden' ? { status: 403 } : failure === 'identity' ? /identity mismatch/ : failure === 'revoked' ? /revoked authority/ : failure === 'watermark' ? /watermark/ : failure === 'base' ? /Invalid history delta/ : /size limit/);
    revoked = false;
    assert.equal((await client.messages('codex:test')).messages[0]!.id, 'm', 'failure evicts the base; next authorized read is full');
  }
});

test('history cache partitions credentials, authority generation, node and origin; legacy responses remain full', async () => {
  const cache = createConditionalHistoryCache();
  const etag = `W/"history-${'b'.repeat(64)}"`;
  let expectValidator = false, legacy = false;
  const dispatch = (request: Request) => {
    assert.equal(request.headers.get('if-none-match'), expectValidator ? etag : null);
    const headers: Record<string, string> = { [NODE_ID_HEADER]: request.headers.get(EXPECTED_NODE_HEADER)! };
    if (!legacy) headers.etag = etag;
    return Response.json({ messages: [{ id: 'm' }], updatedAt: 1 }, { headers });
  };
  const client = (origin = 'http://connector', token = 'synthetic', domain = 'authority:1', nodeId = 'node-test') =>
    new ConnectorClient(origin, token, dispatch, undefined, undefined, { domain, nodeId }, cache);
  await client().messages('codex:test');
  expectValidator = true; await client().messages('codex:test');
  expectValidator = false;
  await client('http://other').messages('codex:test');
  await client(undefined, 'different').messages('codex:test');
  await client(undefined, undefined, 'authority:2').messages('codex:test');
  await client(undefined, undefined, undefined, 'node-other').messages('codex:test');
  await client().messages('codex:other');
  await client().messages('codex:test', '10');
  await client().messages('codex:test', undefined, undefined, 'older');
  legacy = true;
  await client('http://legacy').messages('codex:test');
  await client('http://legacy').messages('codex:test');
});

test('workspace failures give actionable sanitized guidance, never upstream secrets', async () => {
  for (const [status, expected] of [[403, /files:read/], [404, /AOD_FILE_ROOTS_JSON/], [409, /not configured/]] as const) {
    const client = new ConnectorClient('http://connector', 'synthetic', () => Response.json({ error: 'private-upstream-secret' }, { status }));
    await assert.rejects(client.json('/files/roots'), (error: any) => {
      assert.equal(error.status, status); assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-upstream-secret/); return true;
    });
  }
});

test('file save conflicts are not misreported as missing browsing configuration', async () => {
  for (const [status, expected] of [[409, /save conflicted/], [403, /files:write/]] as const) {
    let calls = 0;
    const client = new ConnectorClient('http://connector', 'synthetic', () => {
      calls++;
      return Response.json({ error: 'private-upstream-secret' }, { status });
    });
    await assert.rejects(client.json('/files/agents/codex/text', { method: 'POST', body: '{}' }), (error: any) => {
      assert.equal(error.status, status); assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-upstream-secret|browsing is not configured/); return true;
    });
    assert.equal(calls, 1, 'writes are never replayed');
  }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: media preserves Range bytes, If-Range fallback and sanitized 416`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'client-range-'));
  const filePath = join(dir, 'test');
  writeFileSync(filePath, '0123456789');
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  const handler = (request: Request) => {
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), nodeId);
    const response = fileResponse({ filePath, name: 'test', mimeType: 'text/plain', size: 10, request });
    response.headers.set(NODE_ID_HEADER, nodeId);
    response.headers.set('x-private', 'secret');
    return response;
  };
  const server = mode === 'http' ? serve({ fetch: handler, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
    const client = new ConnectorClient(origin, 'synthetic', mode === 'local' ? handler : undefined, undefined, undefined, { nodeId });
    const partial = await client.media('test', undefined, undefined, 'bytes=2-4');
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(partial.headers.get('content-length'), '3');
    assert.equal(partial.headers.get('x-private'), null);
    assert.equal(await partial.text(), '234');
    const full = await client.media('test', undefined, undefined, 'bytes=2-4', 'old');
    assert.equal(full.status, 200);
    assert.equal(await full.text(), '0123456789');
    const invalid = await client.media('test', undefined, undefined, 'bytes=99-');
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */10');
    assert.equal(invalid.headers.get('x-private'), null);
    assert.equal(await invalid.text(), '');
  } finally {
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('media rejects malformed upstream metadata before exposing bytes and cancels error bodies', async () => {
  for (const [status, headers, valid] of [
    [416, { 'content-range': 'bytes */10', 'x-private': 'secret' }, true],
    [416, { 'content-range': 'bytes */9007199254740992' }, false],
    [416, { 'content-range': 'secret' }, false],
    [206, { 'content-range': 'bytes 4-2/10' }, false],
    [206, { 'content-range': 'bytes 2-10/10' }, false],
    [206, { 'content-range': 'bytes 2-4/10', 'content-length': '2' }, false],
    [206, {}, false], [200, { 'content-range': 'bytes 2-4/10' }, false],
    [200, { 'content-length': '67108865' }, false], [200, { 'content-length': 'bad' }, false],
    [201, {}, false],
  ] as [number, Record<string, string>, boolean][]) {
    let cancelled = 0;
    const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status, headers }));
    if (valid) {
      const response = await client.media('test', undefined, undefined, 'bytes=2-4');
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('x-private'), null);
      assert.equal(await response.text(), '');
    } else await assert.rejects(client.media('test', undefined, undefined, 'bytes=2-4'), { status: 502 });
    assert.equal(cancelled, 1);
  }
});

test('media detects truncated range bodies even without content-length and rechecks pull authorization', async () => {
  const client = new ConnectorClient('http://connector', 'synthetic', () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 2-4/10' } }));
  await assert.rejects((await client.media('test', undefined, undefined, 'bytes=2-4')).text(), /declared length/);
  let active = true;
  const response = await client.media('test', undefined, () => { if (!active) throw new Error('revoked'); }, 'bytes=2-4');
  active = false;
  await assert.rejects(response.text(), /revoked/);
});

for (const mode of ['local', 'http'] as const) test(`${mode}: pinned identity covers JSON, media and SSE without extra handshake per request`, async () => {
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  let activeNode = nodeId, requests = 0, writes = 0;
  const handler = (request: Request) => {
    requests++;
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic');
    const headers = { [NODE_ID_HEADER]: activeNode };
    if (request.headers.has(EXPECTED_NODE_HEADER) && request.headers.get(EXPECTED_NODE_HEADER) !== activeNode) return Response.json({}, { status: 409, headers });
    const path = new URL(request.url).pathname;
    if (path.endsWith('/identity')) return Response.json({ nodeId: activeNode, protocol: 1 }, { headers });
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), nodeId);
    if (path.endsWith('/events/stream')) return new Response('id: e1\ndata: {}\n\n', { headers: { ...headers, 'content-type': 'text/event-stream' } });
    if (path.includes('/media/')) return new Response('synthetic-media', { headers: { ...headers, 'content-type': 'image/png', 'x-private': 'secret', 'cache-control': 'public' } });
    if (request.method === 'POST') writes++;
    return Response.json({ ok: true }, { headers });
  };
  const server = mode === 'http' ? serve({ fetch: handler, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
  const dispatch = mode === 'local' ? handler : undefined;
  try {
    assert.equal(await new ConnectorClient(origin, 'synthetic', dispatch).identity(), nodeId);
    const client = new ConnectorClient(origin, 'synthetic', dispatch, undefined, undefined, { nodeId });
    assert.deepEqual(await client.json('/health'), { ok: true });
    const media = await client.media('file.png');
    assert.equal(media.headers.get('x-private'), null);
    assert.equal(media.headers.get('cache-control'), 'no-store');
    assert.equal(await media.text(), 'synthetic-media');
    const stream = client.events(new AbortController().signal);
    assert.equal((await stream.next()).value?.id, 'e1');
    await stream.return();
    assert.equal(requests, 4);
    activeNode = 'node_00000000-0000-4000-8000-000000000002';
    await assert.rejects(client.json('/mutation', { method: 'POST' }), { status: 502 });
    await assert.rejects(client.media('file.png'), { status: 502 });
    await assert.rejects(client.events(new AbortController().signal).next(), { status: 502 });
    assert.equal(writes, 0);
    assert.equal(requests, 7);
  } finally {
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test('pinned client refuses legacy/misrouted response before reading body, without claiming mutation rejection', async () => {
  let canceled = 0;
  const client = new ConnectorClient('http://node', 'synthetic', () => new Response(new ReadableStream({ cancel() { canceled++; } })),
    1000, 1024, { nodeId: 'node_00000000-0000-4000-8000-000000000001' });
  await assert.rejects(client.json('/mutation', { method: 'POST' }), { status: 502 });
  assert.equal(canceled, 1);
});

for (const target of ['node', 'login', 'size'] as const) test(`media delivery checks ${target} per chunk and cancels its upstream`, async () => {
  let allowed = true, canceled = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const check = () => { if (!allowed) throw new Error('revoked'); };
  const client = new ConnectorClient('http://node', 'synthetic', () => new Response(new ReadableStream({
    start(c) { source = c; }, cancel() { canceled++; },
  })), 1000, 1024, target === 'node' ? { authorize: check } : {});
  const response = await client.media('file.png', undefined, target === 'login' ? check : undefined);
  const reader = response.body!.getReader();
  try {
    source.enqueue(new Uint8Array([1]));
    assert.equal((await reader.read()).value?.[0], 1);
    if (target === 'size') {
      // Reuse one chunk to avoid a synthetic test allocating an entire file.
      const chunk = new Uint8Array(1024 * 1024);
      for (let i = 0; i < 63; i++) { source.enqueue(chunk); await reader.read(); }
      source.enqueue(chunk);
      await assert.rejects(reader.read(), /exceeds size limit/);
    } else {
      allowed = false;
      source.enqueue(new Uint8Array([2]));
      await assert.rejects(reader.read(), /revoked/);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(canceled, 1);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
});

test('resolved clients cannot survive node disable/re-enable, replacement or credential rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-client-authority-'));
  const file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic-vault');
  try {
    const local = { id: 'local', kind: 'local' as const, label: 'local', connectorUrl: 'local://aod-connector' };
    store.upsertConnection(local);
    let requests = 0;
    const resolve = createConnectorClientResolver(store, { connectionId: 'local', token: 'synthetic', dispatch: () => { requests++; return Response.json({ ok: true }); } });
    const stale = resolve('local');
    const before = store.connectionAuthority('local')!;
    store.upsertConnection({ ...local, status: 'disabled' });
    store.upsertConnection({ ...local, status: 'enabled' });
    assert.ok(store.connectionAuthority('local')! > before);
    await assert.rejects(stale.json('/health'), { status: 403 });
    assert.equal(requests, 0);
    assert.notEqual(stale.eventDomain, resolve('local').eventDomain);
    await resolve('local').json('/health');
    assert.equal(requests, 1);

    const remote = { id: 'remote', kind: 'remote' as const, label: 'node', connectorUrl: 'http://unused.invalid', credentialToken: 'synthetic-a' };
    store.upsertConnection(remote);
    const oldCredential = resolve('remote');
    store.upsertConnection({ ...remote, credentialToken: 'synthetic-b' });
    store.upsertConnection(remote); // same token again must not resurrect old authority
    await assert.rejects(oldCredential.json('/health'), { status: 403 });
    const oldNode = resolve('remote');
    store.deleteConnection('remote');
    store.upsertConnection(remote);
    await assert.rejects(oldNode.json('/health'), { status: 403 });
    store.updateMaintenanceCredential('remote', 'synthetic-maintenance');
    const oldMaintenance = resolve('remote', true);
    store.updateMaintenanceCredential('remote', 'synthetic-maintenance');
    await assert.rejects(oldMaintenance.json('/health'), { status: 403 });
    const version = store.connectionAuthority('remote');
    store.close();
    store = new HubStore(file, 'synthetic-vault');
    assert.equal(store.connectionAuthority('remote'), version);
    assert.equal(store.connectionAuthority('remote', 'another-user'), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const phase of ['headers', 'body', 'event'] as const) test(`client authorization is rechecked after asynchronous ${phase}`, async () => {
  let allowed = true, canceled = 0, dispatched = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel() { canceled++; } });
  const authorize = () => { if (!allowed) throw Object.assign(new Error('revoked'), { status: 403 }); };
  const client = new ConnectorClient('http://node', 'synthetic', () => {
    dispatched++;
    if (phase === 'headers') allowed = false;
    return new Response(stream, { headers: { 'content-type': phase === 'event' ? 'text/event-stream' : 'application/json' } });
  }, 1000, 1024, { authorize });
  if (phase === 'event') {
    const controller = new AbortController();
    const events = client.events(controller.signal);
    const first = events.next();
    source.enqueue(new TextEncoder().encode('id: one\ndata: {}\n\n'));
    assert.equal((await first).value?.id, 'one');
    allowed = false;
    source.enqueue(new TextEncoder().encode('id: two\ndata: {"private":true}\n\n'));
    await assert.rejects(events.next(), { status: 403 });
    assert.equal(canceled, 1);
  } else {
    const response = client.json('/health');
    if (phase === 'body') {
      // Wait for the headers gate, then revoke while the body is incomplete.
      await new Promise<void>((resolve) => setImmediate(resolve));
      allowed = false;
      source.enqueue(new TextEncoder().encode('{"private":true}'));
      source.close();
    }
    await assert.rejects(response, { status: 403 });
    if (phase === 'headers') assert.equal(canceled, 1);
  }
  assert.equal(dispatched, 1);
  await assert.rejects(client.json('/health'), { status: 403 });
  assert.equal(dispatched, 1);
});

for (const transport of ['local', 'http']) {
  test(`${transport}: same client, encoding and scoped authentication; cancel has one owner`, async () => {
    const app = new Hono();
    const key = 'codex:/a b/%?#测试';
    const id = 'message:/%?测试';
    app.use('*', async (c, next) => c.req.header('authorization') === 'Bearer synthetic' ? next() : c.json({ error: 'no' }, 403));
    app.get('/api/connector/v1/sessions/:key/messages/:id', (c) => {
      assert.equal(c.req.param('key'), key);
      assert.equal(c.req.param('id'), id);
      return c.json({ message: { id, sessionKey: key, text: 'same' }, updatedAt: 1 });
    });
    const server = transport === 'http' ? serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    const dispatch = transport === 'local' ? (request: Request) => app.fetch(request) : (request: Request) => fetch(request);
    try {
      const client = new ConnectorClient(origin, 'synthetic', dispatch);
      assert.equal((await client.message(key, id)).message.id, id);
      await assert.rejects(new ConnectorClient(origin, 'bad', dispatch).message(key, id), { status: 403 });
      const controller = new AbortController(); controller.abort(new Error('cancelled'));
      await assert.rejects(client.message(key, id, controller.signal), /cancelled/);
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

test('read RPC deadlines cover headers and stalled bodies, including non-cooperative local dispatch', async () => {
  await assert.rejects(new ConnectorClient('http://node', 'synthetic', () => new Promise<Response>(() => {}), 15).sessions(), /Deadline/);
  let cancelled = 0;
  await assert.rejects(new ConnectorClient('http://node', 'synthetic', () => new Response(new ReadableStream({ cancel() { cancelled++; } })), 15).sessions(), /Deadline/);
  assert.equal(cancelled, 1);
});

test('bounded reader cancels oversized JSON and redacts upstream error bodies', async () => {
  let cancelled = 0;
  const dispatch = () => new Response(new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(200)); }, cancel() { cancelled++; },
  }));
  await assert.rejects(new ConnectorClient('http://node', 'synthetic', dispatch, 1000, 64).sessions(), /size limit/);
  assert.equal(cancelled, 1);
  await assert.rejects(new ConnectorClient('http://node', 'synthetic', () => Response.json({ error: 'SECRET' }, { status: 403 })).sessions(), (error: any) => error.status === 403 && !error.message.includes('SECRET'));
  await assert.rejects(new ConnectorClient('http://node', 'synthetic', () => Response.json({ groups: 'bad' })).sessions(), /Invalid Connector sessions/);
});

test('node resolver never falls back to local for unknown, disabled or unconfigured nodes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-resolver-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic-vault');
  try {
    store.ensureLocalConnection({ id: 'local', label: 'local', connectorUrl: 'local://aod-connector', environmentId: 'a', environmentLabel: 'a', status: 'enabled' });
    store.upsertConnection({ id: 'other-local', kind: 'local', label: 'other', connectorUrl: 'local://aod-connector' });
    let reads = 0;
    const resolve = createConnectorClientResolver(store, { connectionId: 'local', token: 'synthetic', dispatch: () => { reads++; return Response.json({ groups: [] }); } });
    assert.throws(() => resolve('missing'), { status: 404 });
    assert.throws(() => resolve('other-local'), { status: 503 });
    assert.throws(() => createConnectorClientResolver(store)('local'), { status: 503 });
    await resolve('local').sessions(); assert.equal(reads, 1);
    store.upsertConnection({ id: 'local', kind: 'local', label: 'local', connectorUrl: 'local://aod-connector', status: 'disabled' });
    assert.throws(() => resolve('local'), { status: 404 });
    assert.equal(reads, 1);
  } finally { (store as any).db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('in-process credential is authenticated but never listed or persisted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-local-credential-'));
  const file = join(dir, 'tokens.json');
  try {
    const store = new ConnectorTokenStore(file);
    const credential = store.createTransient(['messages:read']);
    const request = new Request('http://node', { headers: { authorization: `Bearer ${credential.token}` } });
    assert.equal(store.requireScope(request, 'messages:read')?.label, 'In-process Hub');
    assert.equal(store.requireScope(request, 'messages:send'), undefined);
    assert.equal(existsSync(file), false);
    store.create({ label: 'persistent' });
    assert.equal(store.list().length, 1);
    assert.equal(readFileSync(file, 'utf8').includes('In-process Hub'), false);
    assert.equal(new ConnectorTokenStore(file).authenticate(request), undefined);
    credential.dispose(); assert.equal(store.authenticate(request), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identity merge keeps distinct same-text turns and selects latest version per ID', () => {
  const first = { id: 'a', sessionKey: 's', role: 'assistant' as const, text: 'same', createdAt: 1, updatedAt: 1 };
  const second = { ...first, id: 'b', createdAt: 900, updatedAt: 900 };
  assert.deepEqual(mergeMessageIdentities([first, second, { ...first, text: 'corrected', updatedAt: 2 }, first]).map((row) => [row.id, row.text]), [['a', 'corrected'], ['b', 'same']]);
});

test('maintenance credentials never fall back to daily credentials in either transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic-vault');
  try {
    store.ensureLocalConnection({ id: 'local', label: 'local', connectorUrl: 'local://aod-connector', environmentId: 'a', environmentLabel: 'a', status: 'enabled' });
    store.upsertConnection({ id: 'remote', kind: 'remote', label: 'remote', connectorUrl: 'http://remote', credentialToken: 'daily' });
    const dispatch = (request: Request) => Response.json({ authorization: request.headers.get('authorization') }, { status: 202 });
    const resolve = createConnectorClientResolver(store, { connectionId: 'local', token: 'daily', dispatch });
    assert.throws(() => resolve('local', true), { status: 401 });
    assert.throws(() => resolve('remote', true), { status: 401 });
    const withMaintenance = createConnectorClientResolver(store, { connectionId: 'local', token: 'daily', maintenanceToken: 'maintenance', dispatch });
    assert.deepEqual(await withMaintenance('local', true).jsonResponse('/update/apply'), { body: { authorization: 'Bearer maintenance' }, status: 202 });
    assert.deepEqual(await withMaintenance('local').json('/users'), { authorization: 'Bearer daily' });
  } finally { (store as any).db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('private board transport is owner-only, route-restricted and never falls back to daily/maintenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-board-transport-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic-vault');
  try {
    store.ensureLocalConnection({ id: 'local', label: 'local', connectorUrl: 'local://aod-connector', environmentId: 'a', environmentLabel: 'a', status: 'enabled' });
    let calls = 0;
    const resolve = createConnectorClientResolver(store, { connectionId: 'local', token: 'board-only', dispatch: request => {
      calls++; assert.equal(request.headers.get('authorization'), 'Bearer board-only'); return Response.json({ ok: true });
    } }, true);
    const path = '/sessions/codex%3Afixture/board-binding';
    assert.deepEqual(await resolve('local').json(path), { ok: true });
    await resolve('local').json(path, { method: 'PUT', body: '{}' });
    await resolve('local').json(path + '/11111111-1111-4111-8111-111111111111', { method: 'DELETE' });
    assert.equal(calls, 3);
    for (const denied of ['/users', '/sessions/codex%3Afixture/messages', path + '?anything=1', '/sessions/hermes%3Ax/board-binding', '/sessions/codex%3A..%2Fx/board-binding']) {
      await assert.rejects(resolve('local').json(denied), { status: 403 });
    }
    await assert.rejects(resolve('local').json(path, { method: 'POST' }), { status: 403 });
    assert.throws(() => resolve('local', true), { status: 403 });
    assert.throws(() => resolve('local', false, 'other'), { status: 404 });
    assert.throws(() => createConnectorClientResolver(store, undefined, true)('local'), { status: 503 });
    const previous = resolve('local');
    store.upsertConnection({ id: 'local', kind: 'local', label: 'local', connectorUrl: 'local://aod-connector', status: 'disabled' });
    await assert.rejects(previous.json(path), { status: 403 });
    assert.equal(calls, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ['file-boards', 'card-files'] as const) test(`${mode} transport permits exact file operations only; no history, maintenance or delegated access`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-file-transport-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic-vault');
  try {
    store.ensureLocalConnection({ id: 'local', label: 'local', connectorUrl: 'local://aod-connector', environmentId: 'a', environmentLabel: 'a', status: 'enabled' });
    let calls = 0;
    const resolve = createConnectorClientResolver(store, { connectionId: 'local', token: 'file-only', dispatch: request => {
      calls++; assert.equal(request.headers.get('authorization'), 'Bearer file-only'); return Response.json({ ok: true });
    } }, mode);
    const base = mode === 'file-boards' ? '/workspace/board-files' : '/workspace/card-files';
    const path = base + '/11111111-1111-4111-8111-111111111111';
    const receipt = path + '/writes/22222222-2222-4222-8222-222222222222';
    await resolve('local').json(base);
    for (const method of ['GET', 'PUT', 'DELETE']) await resolve('local').json(path, { method });
    await resolve('local').json(base + '/subscribe', { method: 'POST' });
    await resolve('local').json(path + '/writes', { method: 'POST' });
    await resolve('local').json(receipt);
    for (const denied of ['/users', '/sessions/codex%3Afixture/messages', '/sessions/codex%3Afixture/board-binding', path + '?q=1', base + '/subscribe/extra',
      receipt + '?q=1', receipt + '/extra', path + '/writes/not-a-uuid', path + '/writes',
      mode === 'file-boards' ? '/workspace/card-files' : '/workspace/board-files']) {
      await assert.rejects(resolve('local').json(denied), { status: 403 });
    }
    for (const method of ['POST', 'PUT', 'DELETE']) await assert.rejects(resolve('local').json(receipt, { method }), { status: 403 });
    await assert.rejects(resolve('local').json(path + '/writes?extra=1', { method: 'POST' }), { status: 403 });
    await assert.rejects(resolve('local').json(path, { method: 'POST' }), { status: 403 });
    assert.throws(() => resolve('local', true), { status: 403 });
    assert.throws(() => resolve('local', false, 'default', {} as any), { status: 403 });
    assert.throws(() => resolve('local', false, 'other'), { status: 404 });
    assert.throws(() => createConnectorClientResolver(store, undefined, mode)('local'), { status: 503 });
    const previous = resolve('local');
    store.upsertConnection({ id: 'local', kind: 'local', label: 'local', connectorUrl: 'local://aod-connector', status: 'disabled' });
    await assert.rejects(previous.json(path), { status: 403 });
    assert.equal(calls, 7);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('RPC accepts dots within opaque IDs but rejects escaping the Connector route prefix', async () => {
  const client = new ConnectorClient('http://node', 'synthetic', () => Response.json({ ok: true }));
  assert.deepEqual(await client.json('/users/a..b'), { ok: true });
  for (const path of ['/../../tokens', '/%2e%2e/tokens', '//other', '/\\..\\..\\tokens']) {
    await assert.rejects(client.json(path), /Invalid Connector path/);
  }
});
