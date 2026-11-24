import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { registerExecutionGrantRoutes } from './execution-grant-http.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { randomUUID } from 'node:crypto';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-grant-http-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  const issuer = tokens.create({ label: 'synthetic issuer', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub-a' });
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id));
  const app = new Hono();
  registerExecutionGrantRoutes(app, { nodeId: store.nodeId, tokens, grants: store.executionGrants, turns: store.turns, mirrorOutbox: store.mirrorOutbox });
  const command = { principalId: 'member-a', grantKey: 'policy', version: 1, runtime: 'codex' as const,
    sessionKey: 'codex:synthetic/会话', actions: ['messages:send'], expiresAt: Date.now() + 30_000 };
  const headers = { authorization: `Bearer ${issuer.token}`, [EXPECTED_NODE_HEADER]: store.nodeId, 'content-type': 'application/json' };
  return { app, tokens, store, issuer, command, headers,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const transport of ['local', 'http'] as const) test(`${transport}: usage batches disclose only exact live pending authority, without renewal or dispatch`, async () => {
  const f = fixture();
  const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.test';
  const client = new ConnectorClient(origin, f.issuer.token, transport === 'local' ? request => f.app.fetch(request) : undefined,
    1000, 8192, { nodeId: f.store.nodeId });
  try {
    const binding = { ...f.command, issuerTokenId: f.issuer.record.id, hubId: 'hub-a' };
    const codex = f.store.executionGrants.issue(binding, ['messages:send'], Date.now() + 30_000);
    const openclawTarget = { ...binding, runtime: 'openclaw' as const, sessionKey: 'agent:synthetic/会话', grantKey: 'policy-openclaw' };
    const openclaw = f.store.executionGrants.issue(openclawTarget, ['messages:send'], Date.now() + 30_000);
    const ids = [codex.id, openclaw.id];
    const usage = () => client.json<{ usage: Array<{ id: string; needed: boolean }> }>('/execution-grants/usage', {
      method: 'POST', body: JSON.stringify({ ids }) });
    assert.deepEqual((await usage()).usage, ids.map(id => ({ id, needed: false })));
    for (const [target, grant] of [[binding, codex], [openclawTarget, openclaw]] as const) {
      f.store.turns.enqueue(target.runtime, { id: grant.id, sessionKey: target.sessionKey, createdAt: 1,
        payload: { actorId: grant.actorId, executionGrant: { ...grant, issuerTokenId: f.issuer.record.id }, text: 'private-body' } });
    }
    const response = await usage();
    assert.deepEqual(response.usage, ids.map(id => ({ id, needed: true })));
    assert.equal(JSON.stringify(response).includes('private-body'), false);
    f.store.turns.start('codex', binding.sessionKey, codex.id);
    assert.equal((await usage()).usage[0]?.needed, true, 'preparing still needs authority');
    f.store.turns.uncertain('codex', codex.id);
    f.store.turns.block('openclaw', openclaw.id);
    assert.deepEqual((await usage()).usage, ids.map(id => ({ id, needed: false })), 'unknown/blocked never revived');
    assert.equal(f.store.turns.head('codex', binding.sessionKey)?.state, 'outcome_unknown');
    f.store.turns.complete('codex', codex.id);
    f.store.turns.complete('openclaw', openclaw.id);
    assert.deepEqual((await usage()).usage, ids.map(id => ({ id, needed: false })));
    f.store.turns.enqueue('codex', { id: 'revoked', sessionKey: binding.sessionKey, createdAt: 1,
      payload: { actorId: codex.actorId, executionGrant: { ...codex, issuerTokenId: f.issuer.record.id } } });
    f.store.executionGrants.revoke(f.issuer.record.id, codex.id);
    assert.equal((await usage()).usage[0]?.needed, false, 'queued work cannot revive a revoked grant');
  } finally {
    if (server && 'closeAllConnections' in server) server.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});

test('usage rejects oversized/malformed/foreign batches and rechecks issuer after body await', async () => {
  const f = fixture();
  const request = (body: unknown, headers = f.headers) => f.app.request('/api/connector/v1/execution-grants/usage', {
    method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const grant = f.store.executionGrants.issue({ ...f.command, issuerTokenId: f.issuer.record.id, hubId: 'hub-a' }, ['messages:send'], Date.now() + 30_000);
    for (const raw of [null, [], {}, { ids: [] }, { ids: [grant.id, grant.id] }, { ids: [1] }, { ids: ['invalid'] },
      { ids: Array.from({ length: 33 }, () => randomUUID()) }, { ids: [grant.id], actorId: 'forged' }]) {
      assert.equal((await request(raw)).status, 400);
    }
    assert.equal((await request({ ids: [randomUUID()] })).status, 403);
    const other = f.tokens.create({ label: 'other issuer', scopes: ['execution:delegate', 'messages:send'], delegationHubId: 'hub-b' });
    assert.equal((await request({ ids: [grant.id] }, { ...f.headers, authorization: `Bearer ${other.token}` })).status, 403);
    assert.equal((await request({ ids: [grant.id] }, { ...f.headers, [EXPECTED_NODE_HEADER]: '' })).status, 409);
    assert.equal((await request({ ids: [grant.id] }, { ...f.headers, authorization: '' })).status, 403);
    assert.equal((await request({ ids: ['x'.repeat(8192)] })).status, 413);
    const reply = await request({ ids: [grant.id] });
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    let controller!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { ready(); } });
    const pending = f.app.fetch(new Request('http://connector.test/api/connector/v1/execution-grants/usage', {
      method: 'POST', headers: f.headers, body: source, duplex: 'half' } as RequestInit));
    await started; f.tokens.revoke(f.issuer.record.id);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ids: [grant.id] }))); controller.close();
    assert.equal((await pending).status, 403);
  } finally { f.close(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: ACK-deleted mirror retains only original live grant usage`, async () => {
  const setup = fixture();
  const server = transport === 'http' ? serve({ fetch: setup.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.test';
  const client = new ConnectorClient(origin, setup.issuer.token, transport === 'local' ? request => setup.app.fetch(request) : undefined,
    1000, 8192, { nodeId: setup.store.nodeId });
  try {
    const binding = { ...setup.command, runtime: 'openclaw' as const, sessionKey: 'synthetic-mirror',
      issuerTokenId: setup.issuer.record.id, hubId: 'hub-a' };
    const grant = setup.store.executionGrants.issue(binding, ['messages:send', 'messages:mirror'], Date.now() + 30_000);
    setup.store.mirrorOutbox.upsert({ actorId: grant.actorId, executionGrant: { ...grant, issuerTokenId: setup.issuer.record.id },
      sessionKey: binding.sessionKey, idempotencyKey: 'original', after: 1, inputText: 'private-body',
      explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'private-target', outboundTarget: 'private-target' } });
    assert.deepEqual(setup.store.turns.list('openclaw'), []);
    const usage = () => client.json<{ usage: Array<{ id: string; needed: boolean }> }>('/execution-grants/usage', {
      method: 'POST', body: JSON.stringify({ ids: [grant.id] }) });
    const response = await usage();
    assert.deepEqual(response.usage, [{ id: grant.id, needed: true }]);
    assert.doesNotMatch(JSON.stringify(response), /private-body|private-target/);
    const job = setup.store.mirrorOutbox.get('original'); assert.ok(job);
    setup.store.mirrorOutbox.saveJob({ ...job, deliveryState: 'blocked', lastError: 'synthetic revoked target' });
    assert.deepEqual((await usage()).usage, [{ id: grant.id, needed: false }]);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    setup.close();
  }
});

for (const transport of ['local', 'http']) test(`${transport} grant issue/revoke uses pinned node and trusted token provenance`, async () => {
  const f = fixture();
  const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.test';
  const dispatch = transport === 'local' ? (request: Request) => f.app.fetch(request) : (request: Request) => fetch(request);
  const client = new ConnectorClient(origin, f.issuer.token, dispatch, 1000, 8192, { nodeId: f.store.nodeId });
  const post = (body: unknown, revoke = false) => client.json<any>(`/execution-grants${revoke ? '/revoke' : ''}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    assert.deepEqual(await client.json('/execution-grants/issuer'), {
      nodeId: f.store.nodeId, hubId: 'hub-a', issuerTokenId: f.issuer.record.id });
    const issued = await post(f.command);
    assert.equal(issued.nodeId, f.store.nodeId);
    assert.equal(f.store.executionGrants.authorize(issued.grant, f.issuer.record.id, f.command, 'messages:send'), true);
    assert.deepEqual(await post(f.command), issued, 'lost ACK retry returns same ref');
    for (const field of ['issuerTokenId', 'hubId', 'actorId', 'nodeId']) await assert.rejects(post({ ...f.command, [field]: 'forged' }), { status: 400 });
    const { actions: _actions, expiresAt: _expires, ...binding } = f.command;
    const revoked = { revokedThroughVersion: 1, nodeId: f.store.nodeId, hubId: 'hub-a', issuerTokenId: f.issuer.record.id };
    assert.deepEqual(await post(binding, true), revoked);
    assert.deepEqual(await post(binding, true), revoked);
    assert.equal(f.store.executionGrants.authorize(issued.grant, f.issuer.record.id, f.command, 'messages:send'), false);
    await assert.rejects(post(f.command), { status: 409 });
    await post({ ...binding, version: 3 }, true);
    await assert.rejects(post({ ...f.command, version: 2 }), { status: 409 });
    const next = await post({ ...f.command, version: 4 });
    assert.equal(f.store.executionGrants.authorize(next.grant, f.issuer.record.id, f.command, 'messages:send'), true);
    await post({ ...binding, version: 3 }, true);
    assert.equal(f.store.executionGrants.authorize(next.grant, f.issuer.record.id, f.command, 'messages:send'), true);
    f.tokens.revoke(f.issuer.record.id);
    await assert.rejects(post({ ...f.command, version: 5 }), { status: 403 });
    assert.equal(f.store.executionGrants.authorize(next.grant, f.issuer.record.id, f.command, 'messages:send'), false);
  } finally {
    if (server && 'closeAllConnections' in server) server.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    f.close();
  }
});

test('grant endpoint denies missing/ordinary/unbound issuer, wrong node and unbounded/malformed policy', async () => {
  const f = fixture();
  const post = (headers: Record<string, string>, body: unknown = f.command) => f.app.request('/api/connector/v1/execution-grants', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    for (const token of ['', f.tokens.create({ label: 'ordinary' }).token,
      f.tokens.create({ label: 'unbound', scopes: ['messages:send', 'execution:delegate'] }).token]) {
      assert.equal((await post({ ...f.headers, authorization: `Bearer ${token}` })).status, 403);
    }
    for (const node of ['', 'node-other']) assert.equal((await post({ ...f.headers, [EXPECTED_NODE_HEADER]: node })).status, 409);
    for (const body of [null, [], {}, '{', { ...f.command, actions: ['*'] }, { ...f.command, version: 0 },
      { ...f.command, runtime: 'unknown' }, { ...f.command, sessionKey: '' }, { ...f.command, expiresAt: Date.now() + 120_000 }]) {
      assert.equal((await post(f.headers, body)).status, 400);
    }
    assert.equal((await post(f.headers, ' '.repeat(8193))).status, 413);
    const { expiresAt: _expiresAt, ...relative } = f.command;
    for (const leaseMs of [0, -1, 60_001, 0.5, '60000', null]) {
      assert.equal((await post(f.headers, { ...relative, leaseMs })).status, 400);
    }
    assert.equal((await post(f.headers, { ...f.command, leaseMs: 60_000 })).status, 400);
    const reply = await post(f.headers);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
  } finally { f.close(); }
});

test('grant endpoint rechecks issuer after a held request body before committing authority', async () => {
  const f = fixture();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let ready!: () => void;
  const admitted = new Promise<void>(resolve => { ready = resolve; });
  const source = new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, pull() { ready(); } });
  try {
    const pending = f.app.fetch(new Request('http://connector.test/api/connector/v1/execution-grants', {
      method: 'POST', headers: f.headers, body: source, duplex: 'half' } as RequestInit));
    await admitted;
    f.tokens.revoke(f.issuer.record.id);
    body.enqueue(new TextEncoder().encode(JSON.stringify(f.command))); body.close();
    assert.equal((await pending).status, 403);
  } finally { f.close(); }
});
