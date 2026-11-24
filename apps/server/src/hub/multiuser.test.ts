import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { createApplication } from '../application.js';
import { startupApplicationCleanup } from '../lifecycle/startup-cleanup.js';
import { loadConfig } from '../config.js';
import { encodeHubSessionId } from './session-id.js';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { CommandReceipts } from '../commands/receipts.js';
import { registerDeletionReceipts, registerMessageReceipts } from '../commands/http.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { HubStore } from './hub-store.js';

test('verified SessionRef projections and alias resolution are owner scoped without changing legacy message targets', async () => {
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  const native = 'same/中文?#%', key = `codex:${native}`;
  let calls = 0, wrongSession = false;
  const f = await fixture(async (request) => {
    calls++;
    const path = new URL(request.url).pathname;
    const headers = { [NODE_ID_HEADER]: nodeId };
    if (path.endsWith('/identity')) return Response.json({ nodeId, protocol: 1 }, { headers });
    const forged = { nodeId: 'upstream-forgery', runtimeId: 'openclaw', nativeSessionKey: 'other' };
    if (path.includes('/messages')) return Response.json({ messages: [{ id: 'm1', sessionKey: wrongSession ? 'wrong-upstream-target' : key, role: 'assistant', text: 'synthetic', sessionRef: forged }], totalCount: 1 }, { headers });
    return Response.json({ groups: [{ agentId: 'codex', sessions: [{ sessionKey: key, title: 'Synthetic', status: 'idle', sessionRef: forged }] }], updatedAt: 1 }, { headers });
  });
  try {
    const a = await f.member('A'), b = await f.member('B');
    await f.node('alias', a.key.token, 'synthetic-node');
    const endpoint = `/api/hub/v1/session-reference?${new URLSearchParams({ nodeId, runtimeId: 'codex', nativeSessionKey: native })}`;
    const before = await (await f.request('/api/hub/v1/sessions/state', a.key.token)).json() as any;
    assert.equal(before.groups?.[0]?.sessions?.length, 1,
      `synthetic Connector state unavailable before identity check: ${JSON.stringify(before.sourceStates ?? before.error ?? 'no source diagnostics')}`);
    assert.equal(before.groups[0].sessions[0].sessionRef, undefined, 'unverified upstream cannot claim an identity');
    assert.equal((await f.request(endpoint, a.key.token)).status, 404);
    assert.equal((await f.request('/api/hub/v1/connections/alias/verify', a.key.token, 'POST')).status, 200);
    const alias = encodeHubSessionId('alias', key), expected = { nodeId, runtimeId: 'codex', nativeSessionKey: native };
    const listed = await (await f.request('/api/hub/v1/sessions/state', a.key.token)).json() as any;
    assert.equal(listed.groups?.[0]?.sessions?.length, 1,
      `synthetic Connector state unavailable after identity check: ${JSON.stringify(listed.sourceStates ?? listed.error ?? 'no source diagnostics')}`);
    assert.deepEqual(listed.groups[0].sessions[0].sessionRef, expected);
    assert.equal(listed.groups[0].sessions[0].sessionKey, alias);
    const messages = await (await f.request(`/api/hub/v1/sessions/${encodeURIComponent(alias)}/messages`, a.key.token)).json() as any;
    assert.deepEqual(messages.messages[0].sessionRef, expected);
    wrongSession = true;
    assert.equal((await f.request(`/api/hub/v1/sessions/${encodeURIComponent(alias)}/messages`, a.key.token)).status, 502,
      'wrong-session content must be rejected, not merely relabeled');
    const prior = calls;
    assert.deepEqual(await (await f.request(endpoint, a.key.token)).json(), { sessionKey: alias, sessionRef: expected });
    assert.equal((await f.request(endpoint, b.key.token)).status, 404);
    assert.equal((await f.request('/api/hub/v1/session-reference?runtimeId=unknown', a.key.token)).status, 400);
    assert.equal(calls, prior, 'reference lookup performs no upstream call or execution');
  } finally { await f.close(); }
});

test('authenticated node verification is owner scoped, pins only the handshake identity and refuses changed targets', async () => {
  const original = 'node_00000000-0000-4000-8000-000000000001';
  let current = original, admissions = 0;
  const f = await fixture(async (request) => {
    const headers = { [NODE_ID_HEADER]: current };
    if (request.headers.has(EXPECTED_NODE_HEADER) && request.headers.get(EXPECTED_NODE_HEADER) !== current) return Response.json({}, { status: 409, headers });
    if (new URL(request.url).pathname.endsWith('/identity')) return Response.json({ nodeId: current, protocol: 1 }, { headers });
    if (request.method === 'POST') admissions++;
    return Response.json({ ok: true }, { headers });
  });
  const store = new HubStore(f.config.hub.databaseFile, f.config.hub.vaultSecret);
  try {
    const a = await f.member('A'), b = await f.member('B');
    await f.node('a', a.key.token, 'synthetic-node');
    const verify = '/api/hub/v1/connections/a/verify';
    assert.equal((await f.request(verify, b.key.token, 'POST')).status, 404);
    const response = await f.request(verify, a.key.token, 'POST', { nodeId: 'browser-forgery' });
    assert.equal(response.status, 200);
    const connection = (await response.json() as any).connection;
    assert.equal(connection.nodeId, original);
    assert.equal(connection.identityStatus, 'verified');
    const version = store.connectionAuthority('a', a.user.id);
    assert.equal((await f.request(verify, a.key.token, 'POST')).status, 200);
    assert.equal(store.connectionAuthority('a', a.user.id), version);
    current = 'node_00000000-0000-4000-8000-000000000002';
    assert.equal((await f.request(verify, a.key.token, 'POST')).status, 502);
    assert.equal(store.getConnection('a', a.user.id)?.nodeId, original);
    const post = await f.request(`/api/hub/v1/sessions/${encodeHubSessionId('a', 's')}/messages`, a.key.token, 'POST', { message: 'do not send', idempotencyKey: 'misroute' });
    assert.equal(post.status, 202);
    assert.equal((await post.json() as any).command.state, 'outcome_unknown');
    assert.equal(admissions, 0);
  } finally { store.close(); await f.close(); }
});

test('node verification cannot pin an identity returned after connection authority changes', async () => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async () => {
    started(); await held;
    const nodeId = 'node_00000000-0000-4000-8000-000000000001';
    return Response.json({ nodeId, protocol: 1 }, { headers: { [NODE_ID_HEADER]: nodeId } });
  });
  try {
    const a = await f.member('A');
    await f.node('a', a.key.token, 'synthetic-node');
    const pending = f.request('/api/hub/v1/connections/a/verify', a.key.token, 'POST');
    await waiting;
    const store = new HubStore(f.config.hub.databaseFile, f.config.hub.vaultSecret);
    try {
      const existing = store.getConnection('a', a.user.id)!;
      store.upsertConnection({ ...existing, status: 'disabled' });
      assert.equal(store.getConnection('a', a.user.id)?.nodeId, undefined);
    } finally { store.close(); }
    release();
    assert.equal((await pending).status, 403);
    const listing = await (await f.request('/api/hub/v1/connections', a.key.token)).json() as any;
    assert.equal(listing.connections[0].identityStatus, 'unverified');
  } finally { release(); await f.close(); }
});

test('two authenticated users sharing a Connector credential keep identical caller keys and lost-ACK recovery separate', async () => {
  const db = new DatabaseSync(':memory:');
  const connector = new Hono();
  let admissions = 0;
  const upstreamKeys: string[] = [];
  registerMessageReceipts(connector, '/api/connector/v1/sessions/:sessionKey', {
    receipts: new CommandReceipts(db), scope: (c) => JSON.stringify([c.req.header('authorization'), c.req.param('sessionKey')]),
  });
  connector.post('/api/connector/v1/sessions/:sessionKey/messages', (c) => {
    admissions++; upstreamKeys.push(c.get('commandKey'));
    return c.json({ ok: true, status: 'queued', idempotencyKey: `queue-${admissions}` });
  });
  const f = await fixture(async (request) => {
    const response = await connector.fetch(request);
    // Connector committed its receipt, but neither caller receives its ACK.
    return request.method === 'POST' ? Response.json({ error: 'lost acknowledgement' }, { status: 502 }) : response;
  });
  try {
    const a = await f.member('A'), b = await f.member('B');
    for (const member of [a, b]) assert.equal((await f.node('shared', member.key.token, 'synthetic-shared-credential')).status, 201);
    const session = `/api/hub/v1/sessions/${encodeHubSessionId('shared', 'same-session')}`;
    const post = (token: string, message = 'same task') => f.request(`${session}/messages`, token, 'POST', { message, idempotencyKey: 'same-caller-key' });
    for (const member of [a, b]) {
      const response = await post(member.key.token);
      assert.equal(response.status, 202);
      assert.equal((await response.json() as any).command.key, 'same-caller-key');
    }
    assert.equal(admissions, 2);
    assert.equal(new Set(upstreamKeys).size, 2);
    assert.equal(upstreamKeys.includes('same-caller-key'), false);
    for (const [member, expected] of [[a, 'queue-1'], [b, 'queue-2']] as const) {
      const receipt = await (await f.request(`${session}/commands/same-caller-key`, member.key.token)).json() as any;
      assert.equal(receipt.command.state, 'accepted');
      assert.equal(receipt.command.key, 'same-caller-key');
      assert.equal(receipt.command.result.body.idempotencyKey, expected);
      assert.equal((await (await post(member.key.token)).json() as any).idempotencyKey, expected);
      assert.equal((await post(member.key.token, 'different')).status, 409);
    }
    assert.equal(admissions, 2, 'recovery/replay never reposts');
  } finally { await f.close(); db.close(); }
});

test('authenticated members recover private deletion receipts through Hub and HTTP Connector after ACK loss', async () => {
  const db = new DatabaseSync(':memory:'), connector = new Hono();
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  const deliveries: string[] = [];
  let lose = true;
  connector.use('*', async (c, next) => { c.header(NODE_ID_HEADER, nodeId); await next(); });
  connector.get('/api/connector/v1/identity', c => c.json({ nodeId, protocol: 1 }));
  registerDeletionReceipts(connector, '/api/connector/v1/sessions/:sessionKey', {
    receipts: new CommandReceipts(db), scope: c => JSON.stringify([c.req.header('authorization'), c.req.param('sessionKey')]),
  });
  connector.delete('/api/connector/v1/sessions/:sessionKey', c => {
    deliveries.push(c.get('commandKey')); return c.json({ ok: true, status: 'delete_accepted' });
  });
  const f = await fixture(async request => {
    const response = await connector.fetch(request);
    return lose && !new URL(request.url).pathname.endsWith('/identity')
      ? Response.json({}, { status: 502, headers: { [NODE_ID_HEADER]: nodeId } }) : response;
  });
  try {
    const a = await f.member('A'), b = await f.member('B');
    for (const member of [a, b]) {
      await f.node('shared', member.key.token, 'synthetic-shared-credential');
      assert.equal((await f.request('/api/hub/v1/connections/shared/verify', member.key.token, 'POST')).status, 200);
    }
    const id = encodeHubSessionId('shared', 'same-session');
    const path = `/api/hub/v1/sessions/${id}/deletion-commands/private`;
    const remove = (token: string) => f.application.app.request(`/api/sessions/${id}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'private' },
    });
    assert.equal((await remove(a.key.token)).status, 202);
    assert.equal((await f.request(path, b.key.token)).status, 404);
    assert.equal((await remove(b.key.token)).status, 202);
    lose = false;
    for (const [member, state, status] of [[a, 'accepted', 200], [b, 'rejected', 409]] as const) {
      assert.equal((await (await f.request(path, member.key.token)).json() as any).command.state, state);
      assert.equal((await remove(member.key.token)).status, status);
    }
    assert.equal(deliveries.length, 1, 'a different Hub owner cannot bypass Connector session exclusion');
    assert.equal(deliveries.includes('private'), false);
    assert.equal((await f.request(path, 'invalid-login')).status, 401);
  } finally { await f.close(); db.close(); }
});

async function fixture(intercept?: (request: Request) => Promise<Response | undefined>, accessKey = 'test-admin') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-multiuser-'));
  const config = loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: accessKey,
    AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'test-vault',
    AOD_SESSION_TITLES_FILE: join(directory, 'titles.json'), AOD_PASSKEYS_FILE: join(directory, 'passkeys.json'),
    AOD_AUTH_SESSIONS_FILE: join(directory, 'auth.json'),
  });
  const application = createApplication(config, () => { throw new Error('Hub must not create a runtime'); });
  const calls: Array<{ actor: string; path: string; method: string }> = [];
  const streams = new Map<string, number>();
  const feeds = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    const actor = request.headers.get('authorization') ?? '';
    const path = new URL(request.url).pathname;
    calls.push({ actor, path, method: request.method });
    const intercepted = await intercept?.(request);
    if (intercepted) return intercepted;
    if (path.endsWith('/events/stream')) {
      streams.set(actor, (streams.get(actor) ?? 0) + 1);
      return new Response(new ReadableStream({ start(controller) {
        feeds.set(actor, controller);
        controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/sessions/state')) return Response.json({ groups: [{ agentId: 'fake', sessions: [{ sessionKey: 's', agentId: 'fake', title: actor, status: 'idle', lastActiveAt: 1 }] }] });
    if (path.endsWith('/messages')) return Response.json({ messages: [{ id: 'm', sessionKey: 's', role: 'assistant', text: actor, createdAt: 1 }] });
    return Response.json({ ok: true });
  } });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, token = 'test-admin', method = 'GET', body?: unknown, signal?: AbortSignal) => application.app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}),
  });
  async function member(label: string) {
    const created = await request('/api/hub/v1/users', undefined, 'POST', { label });
    assert.equal(created.status, 201);
    const { user } = await created.json() as any;
    const response = await request(`/api/hub/v1/users/${user.id}/login-keys`, undefined, 'POST');
    assert.equal(response.status, 201);
    const key = await response.json() as { id: string; token: string };
    return { user, key };
  }
  return { application, config, calls, streams, request, member,
    emit: (actor: string) => feeds.get(`Bearer ${actor}`)!.enqueue(new TextEncoder().encode(`event: session.updated\ndata: ${JSON.stringify({ sessionKey: 's', payload: { title: actor } })}\n\n`)),
    node: (id: string, key: string, nodeToken: string) => request('/api/hub/v1/connections', key, 'POST', {
      id, label: id, connectorUrl: origin, token: nodeToken, ownerUserId: 'default',
    }),
    close: async () => { await application.close(); if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test('browser recovery scope rejects changed accounts before reads or command admission', async () => {
  const f = await fixture();
  try {
    const a = await f.member('A'), b = await f.member('B');
    for (const member of [a, b]) await f.node('same', member.key.token, 'synthetic-node');
    const status = await f.request('/api/auth/status', a.key.token);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const { recoveryScope } = await status.json() as { recoveryScope: string };
    assert.match(recoveryScope, /^[a-f0-9]{64}$/);
    assert.equal((await (await f.request('/api/auth/status', 'invalid')).json() as any).recoveryScope, undefined);
    const path = `/api/hub/v1/sessions/${encodeHubSessionId('same', 's')}`;
    const before = f.calls.length;
    for (const [suffix, method] of [['/commands/key', 'GET'], ['/messages', 'POST']] as const) {
      const response = await f.application.app.request(path + suffix, { method,
        headers: { authorization: `Bearer ${b.key.token}`, 'x-agentopsdeck-recovery-scope': recoveryScope, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ message: 'must not execute', idempotencyKey: 'key' }) } : {}),
      });
      assert.equal(response.status, 409);
    }
    assert.equal(f.calls.length, before);
    assert.equal((await f.application.app.request(`/api/hub/v1/events/stream?recoveryScope=${recoveryScope}`, {
      headers: { authorization: `Bearer ${b.key.token}` },
    })).status, 409);
    assert.equal(f.calls.length, before);
    const own = await f.application.app.request('/api/hub/v1/connections', {
      headers: { authorization: `Bearer ${a.key.token}`, 'x-agentopsdeck-recovery-scope': recoveryScope },
    });
    assert.equal(own.status, 200);
    assert.equal((await f.application.app.request('/api/hub/v1/connections', {
      headers: { 'x-agentopsdeck-recovery-scope': recoveryScope },
    })).status, 401);
  } finally { await f.close(); }
});

test('two authenticated users with identical node/session IDs never share directory, credentials or preferences', async () => {
  const f = await fixture();
  try {
    const a = await f.member('A'), b = await f.member('B');
    for (const [member, secret] of [[a, 'node-a'], [b, 'node-b']] as const) {
      const response = await f.node('same', member.key.token, secret);
      assert.equal(response.status, 201);
      assert.equal((await response.json() as any).connection.ownerUserId, member.user.id);
    }
    await f.node('only-b', b.key.token, 'node-b');
    for (const [member, secret] of [[a, 'node-a'], [b, 'node-b']] as const) {
      const response = await f.request(`/api/hub/v1/sessions/${encodeHubSessionId('same', 's')}/messages`, member.key.token);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).messages[0].text, `Bearer ${secret}`);
      const users = await (await f.request('/api/hub/v1/users', member.key.token)).json() as any;
      assert.deepEqual(users.users.map((user: any) => user.id), [member.user.id]);
    }
    const visible = await (await f.request('/api/hub/v1/connections', a.key.token)).json() as any;
    assert.deepEqual(visible.connections.map((node: any) => node.id), ['same']);
    const before = f.calls.length;
    const otherSession = encodeHubSessionId('only-b', 's');
    assert.equal((await f.request(`/api/hub/v1/sessions/${otherSession}/messages`, a.key.token)).status, 404);
    assert.equal((await f.request(`/api/hub/v1/sessions/${otherSession}/messages`, a.key.token, 'POST', { message: 'forged', userId: b.user.id })).status, 404);
    assert.equal((await f.request(`/api/sessions/${otherSession}/pin`, a.key.token, 'PATCH', { pinned: true })).status, 404);
    assert.equal(f.calls.length, before);
    const id = encodeHubSessionId('same', 's');
    assert.equal((await f.request(`/api/sessions/${id}/pin`, a.key.token, 'PATCH', { pinned: true })).status, 200);
    const aState = await (await f.request('/api/hub/v1/sessions/state', a.key.token)).json() as any;
    const bState = await (await f.request('/api/hub/v1/sessions/state', b.key.token)).json() as any;
    assert.equal(aState.groups[0].sessions[0].pinned, true);
    assert.notEqual(bState.groups[0].sessions[0].pinned, true);
    for (const path of ['/api/config', '/api/sessions/state', '/api/auth/passkeys', '/api/auth/audit']) {
      assert.equal((await f.request(path, a.key.token)).status, 403, path);
    }
    assert.equal((await f.request(`/api/hub/v1/users/${b.user.id}/login-keys`, a.key.token, 'POST')).status, 403);
    for (const origin of ['https://attacker.invalid', 'http://10.attacker.invalid', 'null']) {
      const forged = await f.application.app.request('/api/hub/v1/users', { method: 'POST', headers: {
        authorization: 'Bearer test-admin', origin, 'content-type': 'application/json',
      }, body: JSON.stringify({ label: 'CSRF' }) });
      assert.equal(forged.status, 403);
    }
  } finally { await f.close(); }
});

test('revoking login during a slow body prevents dispatch and local mutations', async () => {
  const f = await fixture();
  try {
    for (const target of ['messages', 'pin', 'connection']) {
      const member = await f.member(target);
      await f.node('same', member.key.token, 'node-member');
      let body!: ReadableStreamDefaultController<Uint8Array>;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => { reading = resolve; });
      const stream = new ReadableStream<Uint8Array>({ start(c) { body = c; }, pull() { reading(); } }, { highWaterMark: 0 });
      const id = encodeHubSessionId('same', 's');
      const path = target === 'messages' ? `/api/hub/v1/sessions/${id}/messages`
        : target === 'pin' ? `/api/sessions/${id}/pin` : '/api/hub/v1/connections/same';
      const before = f.calls.length;
      const pending = f.application.app.fetch(new Request(`http://localhost${path}`, {
        method: target === 'messages' ? 'POST' : 'PATCH',
        headers: { authorization: `Bearer ${member.key.token}`, 'content-type': 'application/json' },
        body: stream, duplex: 'half',
      } as RequestInit));
      await started;
      await f.request(`/api/hub/v1/users/${member.user.id}/login-keys/${member.key.id}`, undefined, 'DELETE');
      body.enqueue(new TextEncoder().encode(JSON.stringify({ message: 'must not send', pinned: true, label: 'must not change' })));
      body.close();
      assert.equal((await pending).status, 401, target);
      assert.equal(f.calls.length, before, 'revoked request must not reach Connector');
      const replacement = await (await f.request(`/api/hub/v1/users/${member.user.id}/login-keys`, undefined, 'POST')).json() as { token: string };
      const nodes = await (await f.request('/api/hub/v1/connections', replacement.token)).json() as any;
      assert.equal(nodes.connections[0].label, 'same');
      const state = await (await f.request('/api/hub/v1/sessions/state', replacement.token)).json() as any;
      assert.notEqual(state.groups[0].sessions[0].pinned, true);
    }
  } finally { await f.close(); }
});

test('revoking login while Connector responds withholds data without redispatch', async () => {
  let finish!: () => void;
  let received!: () => void;
  const dispatched = new Promise<void>((resolve) => { received = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const f = await fixture(async (request) => {
    if (!request.url.endsWith('/messages')) return;
    received();
    await held;
    return Response.json({ messages: [{ text: 'private result' }] });
  });
  try {
    const member = await f.member('Member');
    await f.node('same', member.key.token, 'node-member');
    const pending = f.request(`/api/hub/v1/sessions/${encodeHubSessionId('same', 's')}/messages`, member.key.token);
    await dispatched;
    await f.request(`/api/hub/v1/users/${member.user.id}/login-keys/${member.key.id}`, undefined, 'DELETE');
    finish();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes('private result'), false);
    assert.equal(f.calls.length, 1);
  } finally { finish(); await f.close(); }
});

test('member cookie login binds its user and revocation closes already-open SSE', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const member = await f.member('Member');
    await f.node('same', member.key.token, 'node-member');
    const login = await f.application.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: member.key.token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const nodes = await f.application.app.request('/api/hub/v1/connections', { headers: { cookie } });
    assert.equal((await nodes.json() as any).connections[0].ownerUserId, member.user.id);
    const response = await f.application.app.request('/api/hub/v1/events/stream', { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let initial = '';
    while (!initial.includes('connector_connected')) {
      const frame = await reader.read();
      assert.equal(frame.done, false);
      initial += new TextDecoder().decode(frame.value);
    }
    assert.equal(f.streams.get('Bearer node-member'), 1);
    assert.equal((await f.request(`/api/hub/v1/users/${member.user.id}/login-keys/${member.key.id}`, undefined, 'DELETE')).status, 200);
    while (!(await reader.read()).done) { /* drain bounded pre-revocation frames */ }
    assert.equal(controller.signal.aborted, false, 'revocation must close the stream before the test deadline');
    reader.releaseLock();
    assert.equal((await f.application.app.request('/api/hub/v1/connections', { headers: { cookie } })).status, 401);
    assert.equal((await f.request('/api/hub/v1/connections', member.key.token)).status, 401);
  } finally { clearTimeout(timeout); controller.abort(); await f.close(); }
});

test('member login provisioning and restart require an administrator access key', async () => {
  const unguarded = await fixture(undefined, '');
  try {
    const { user } = await (await unguarded.request('/api/hub/v1/users', undefined, 'POST', { label: 'Member' })).json() as any;
    assert.equal((await unguarded.request(`/api/hub/v1/users/${user.id}/login-keys`, undefined, 'POST')).status, 409);
  } finally { await unguarded.close(); }
  const guarded = await fixture();
  await guarded.member('Member');
  await guarded.close();
  assert.throws(() => createApplication({ ...guarded.config, accessKey: '' }), /administrator access key is required/);
  // A rejected constructor can still own asynchronous original cleanup. Do
  // not let the next fixture race that cleanup or bypass its startup fence.
  await startupApplicationCleanup.waitForCurrentCleanup();
  assert.deepEqual(startupApplicationCleanup.snapshot(), { pending: 0, retryable: 0 });
});

test('simultaneous owners have isolated streams and tabs share only their own upstream', async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8_000);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const a = await f.member('A'), b = await f.member('B');
    await f.node('same', a.key.token, 'node-a');
    await f.node('same', b.key.token, 'node-b');
    for (const member of [a, b, a, b]) {
      const response = await f.request('/api/hub/v1/events/stream', member.key.token, 'GET', undefined, abort.signal);
      const reader = response.body!.getReader();
      readers.push(reader);
      let text = '';
      while (!text.includes(readers.length <= 2 ? 'connector_connected' : 'heartbeat')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      assert.equal(text.includes(member === a ? 'node-b' : 'node-a'), false);
    }
    assert.equal(f.streams.get('Bearer node-a'), 1);
    assert.equal(f.streams.get('Bearer node-b'), 1);
    f.emit('node-a'); f.emit('node-b');
    for (const [index, reader] of readers.entries()) {
      const expected = index % 2 ? 'node-b' : 'node-a';
      let text = '';
      while (!text.includes(expected)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      assert.equal(text.includes(index % 2 ? 'node-a' : 'node-b'), false);
    }
    assert.equal(abort.signal.aborted, false);
  } finally {
    clearTimeout(timeout); abort.abort();
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    await f.close();
  }
});
