import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { registerConnectorTokenRoutes } from './token-http.js';
import { registerExecutionGrantRoutes } from './execution-grant-http.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-http-')), file = join(directory, 'tokens.json');
  const tokens = new ConnectorTokenStore(file), store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id));
  const app = new Hono();
  let authorized = true;
  registerConnectorTokenRoutes(app, { tokens, isAuthorizedRequest: request => authorized && request.headers.get('authorization') === 'Bearer synthetic-operator' });
  registerExecutionGrantRoutes(app, { nodeId: store.nodeId, tokens, grants: store.executionGrants });
  const headers = { authorization: 'Bearer synthetic-operator', 'content-type': 'application/json' };
  const create = (body: unknown) => app.request('/api/connector/v1/tokens', { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, file, tokens, store, headers, create, revokeOperator: () => { authorized = false; },
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('operator recovers ambiguous historical identities through normal token management without deleting or replaying history', async () => {
  const f = fixture();
  try {
    const first = f.tokens.create({ label: 'old', scopes: ['events:read'] });
    const second = f.tokens.create({ label: 'reused', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub-test' });
    const unrelated = f.tokens.create({ label: 'unrelated', scopes: ['messages:read'] });
    const document = JSON.parse(readFileSync(f.file, 'utf8'));
    document.records[0].revokedAt = 0; document.records[1].id = first.record.id;
    writeFileSync(f.file, JSON.stringify(document));
    const tokens = new ConnectorTokenStore(f.file), app = new Hono();
    registerConnectorTokenRoutes(app, { tokens, isAuthorizedRequest: request => request.headers.get('authorization') === f.headers.authorization });
    const list = await app.request('/api/connector/v1/tokens', { headers: f.headers });
    assert.equal(list.status, 200);
    const rows = (await list.json()).tokens;
    assert.deepEqual(rows.map((row: { identityAmbiguous?: boolean }) => row.identityAmbiguous), [true, true, undefined]);
    assert.equal(tokens.hasScope(first.record.id, 'messages:send'), false);
    const createdResponse = await app.request('/api/connector/v1/tokens', {
      method: 'POST', headers: f.headers, body: JSON.stringify({ label: 'replacement', scopes: ['messages:send'] }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.notEqual(created.record.id, first.record.id);
    assert.equal(tokens.hasScope(created.record.id, 'messages:send'), true);
    const revoked = await app.request(`/api/connector/v1/tokens/${first.record.id}`, { method: 'DELETE', headers: f.headers });
    assert.equal(revoked.status, 200);
    const after = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(after.records.length, 4); assert.equal(after.records[0].revokedAt, 0);
    assert.equal(typeof after.records[1].revokedAt, 'number');
    assert.deepEqual(after.records[2], document.records[2]);
    const reopened = new ConnectorTokenStore(f.file);
    const request = (token: string) => new Request('http://test.invalid', { headers: { authorization: `Bearer ${token}` } });
    for (const token of [first.token, second.token]) assert.equal(reopened.authenticate(request(token)), undefined);
    assert.ok(reopened.authenticate(request(created.token))); assert.ok(reopened.authenticate(request(unrelated.token)));
    assert.equal(reopened.hasScope(first.record.id, 'messages:send'), false);
  } finally { f.close(); }
});

for (const [method, operation, step] of [['GET', 'list', 1], ['POST', 'create', 2], ['DELETE', 'revoke', 3]] as const)
test(`operator token ${operation} failures are sanitized and logged once without automatic replay`, async () => {
  const f = fixture(), lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const app = new Hono(); let calls = 0, frameworkErrors = 0;
  f.tokens[operation] = () => { calls++; throw Error('private-token-storage-path-and-secret'); };
  app.onError(() => { frameworkErrors++; return new Response('Unsafe framework error', { status: 500 }); });
  registerConnectorTokenRoutes(app, { tokens: f.tokens, isAuthorizedRequest: () => true, diagnostics });
  try {
    const response = await app.request('/api/connector/v1/tokens' + (method === 'DELETE' ? '/private-token-id' : ''), {
      method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Token storage unavailable' });
    assert.equal(calls, 1); assert.equal(frameworkErrors, 0);
    const events = lines.map(line => JSON.parse(line)).filter(event => event.operation === 'connector-token-storage');
    assert.equal(events.length, 1); assert.equal(events[0].step, step);
    assert.equal(events[0].category, 'failed'); assert.equal(events[0].unknown, 1);
    assert.ok(lines.every(line => !/private-token|storage-path|secret/.test(line)));
  } finally { f.close(); }
});

test('operator explicitly provisions persistent Hub-bound issuer; inspection is pinned, read-only and secret-free', async () => {
  const f = fixture();
  try {
    const response = await f.create({ label: 'Issuer', scopes: ['execution:delegate', 'messages:send'], delegationHubId: 'hub-a' });
    assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
    const created = await response.json();
    assert.equal(readFileSync(f.file, 'utf8').includes(created.token), false);
    const reopened = new ConnectorTokenStore(f.file);
    assert.equal(reopened.delegationHubId(created.record.id), 'hub-a');
    const inspect = () => f.app.request('/api/connector/v1/execution-grants/issuer', {
      headers: { authorization: `Bearer ${created.token}`, [EXPECTED_NODE_HEADER]: f.store.nodeId } });
    for (let i = 0; i < 2; i++) {
      const reply = await inspect();
      assert.equal(reply.status, 200); assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await reply.json(), { nodeId: f.store.nodeId, hubId: 'hub-a', issuerTokenId: created.record.id });
    }
    const list = await f.app.request('/api/connector/v1/tokens', { headers: f.headers });
    assert.equal((await list.text()).includes(created.token), false);
    const forbidden = await f.app.request('/api/connector/v1/tokens', {
      method: 'POST', headers: { authorization: `Bearer ${created.token}` }, body: '{}' });
    assert.equal(forbidden.status, 401, 'delegation is not operator provisioning authority');
    f.tokens.revoke(created.record.id);
    assert.equal((await inspect()).status, 403);
  } finally { f.close(); }
});

test('token setup rejects malformed/oversized body and never implicitly promotes default, unbound or transient tokens', async () => {
  const f = fixture();
  try {
    for (const body of [null, [], { label: 2 }, { label: 'x'.repeat(257) }, { scopes: [] }, { scopes: 'messages:send' },
      { scopes: ['unknown'] }, { delegationHubId: 'hub-a' }, { scopes: ['execution:delegate'], delegationHubId: 'hub-a' },
      { scopes: ['messages:send', 'execution:delegate'], delegationHubId: '' }, { ownerUserId: 'forged' }]) {
      assert.equal((await f.create(body)).status, 400);
    }
    assert.equal(f.tokens.list().length, 0);
    assert.equal((await f.create({ label: 'x'.repeat(8193) })).status, 413);
    const ordinary = await (await f.create({})).json();
    const unbound = await (await f.create({ scopes: ['execution:delegate', 'messages:send'] })).json();
    const transient = f.tokens.createTransient(['execution:delegate', 'messages:send']);
    for (const token of [ordinary.token, unbound.token, transient.token, '']) {
      assert.equal((await f.app.request('/api/connector/v1/execution-grants/issuer', {
        headers: { authorization: `Bearer ${token}`, [EXPECTED_NODE_HEADER]: f.store.nodeId } })).status, 403);
    }
    transient.dispose();
    const bound = await (await f.create({ scopes: ['execution:delegate', 'messages:send'], delegationHubId: 'hub-a' })).json();
    for (const node of ['', 'node-other']) assert.equal((await f.app.request('/api/connector/v1/execution-grants/issuer', {
      headers: { authorization: `Bearer ${bound.token}`, [EXPECTED_NODE_HEADER]: node } })).status, 409);
  } finally { f.close(); }
});

test('operator authority is rechecked after held provisioning body', async () => {
  const f = fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void;
  const reading = new Promise<void>(resolve => { ready = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { ready(); } });
  try {
    const reply = f.app.fetch(new Request('http://connector.test/api/connector/v1/tokens', {
      method: 'POST', headers: f.headers, body, duplex: 'half' } as RequestInit));
    await reading; f.revokeOperator();
    controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    assert.equal((await reply).status, 401); assert.equal(f.tokens.list().length, 0);
  } finally { f.close(); }
});

test('Promise-valued operator cannot inspect, provision or revoke tokens', async () => {
  const f = fixture();
  const app = new Hono();
  const held = Promise.resolve(true);
  registerConnectorTokenRoutes(app, { tokens: f.tokens, isAuthorizedRequest: () => held as unknown as boolean });
  const token = f.tokens.create({ label: 'Must remain' });
  try {
    for (const [path, init] of [
      ['/api/connector/v1/tokens', {}],
      ['/api/connector/v1/tokens', { method: 'POST', headers: f.headers, body: '{}' }],
      [`/api/connector/v1/tokens/${token.record.id}`, { method: 'DELETE' }],
    ] as const) assert.equal((await app.request(path, init)).status, 401);
    assert.equal(f.tokens.list().length, 1);
  } finally { f.close(); }
});

test('native async operator is not started and thrown guards return sanitized unavailable', async () => {
  const f = fixture();
  let calls = 0;
  try {
    for (const check of [async () => { calls++; return true; }, () => { throw Error('private-operator-secret'); }]) {
      const app = new Hono();
      registerConnectorTokenRoutes(app, { tokens: f.tokens, isAuthorizedRequest: check as unknown as () => boolean });
      const reply = await app.request('/api/connector/v1/tokens');
      assert.equal(reply.status, check.constructor.name === 'AsyncFunction' ? 401 : 503);
      assert.equal((await reply.text()).includes('private-operator-secret'), false);
    }
    assert.equal(calls, 0);
  } finally { f.close(); }
});
