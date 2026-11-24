import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorControl } from './async-connector-control.js';
import { registerConnectorControlHttp } from './control-http.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';

const silence = new PerformanceDiagnostics(() => {}), base = '/api/connector/v1';
function gate() { let release!: () => void; return { promise: new Promise<void>(ok => { release = ok; }), release: () => release() }; }
async function fixture(t: TestContext, waitMs = 5000) {
  const directory = mkdtempSync(join(tmpdir(), 'connector-public-control-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const actor = tokens.create({ label: 'operator', scopes: ['users:read', 'users:write', 'messages:send', 'execution:delegate',
    'sessions:create', 'connector:lifecycle'], delegationHubId: 'original-hub' });
  const reader = tokens.create({ label: 'reader', scopes: ['users:read'] });
  const updater = tokens.create({ label: 'updater', scopes: ['connector:update'] });
  let owner = new AsyncConnectorOwner(config, silence); await owner.open();
  const nodeId = await owner.command('nodeIdentity', {});
  let command: AsyncConnectorOwner['command'] = (kind, input) => owner.command(kind, input);
  const control = new AsyncConnectorControl({ command: (kind, input) => command(kind, input) }, { waitMs, diagnostics: silence });
  const app = new Hono(), routes = registerConnectorControlHttp(app, nodeId, control);
  app.all(`${base}/*`, () => { assert.fail('selected public route must never fall back'); });
  const headers = { authorization: `Bearer ${actor.token}`, [EXPECTED_NODE_HEADER]: nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' };
  const request = (suffix: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => app.request(base + suffix, {
    method, headers: { ...headers, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  t.after(async () => { await routes.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); });
  return { control, routes, request, headers, nodeId, actor, reader, updater,
    get owner() { return owner; }, port(value: AsyncConnectorOwner['command']) { command = value; },
    raw(signal?: AbortSignal) { return new Request('http://original/control', { headers, ...(signal ? { signal } : {}) }); },
    async restart() { await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open(); },
  };
}

test('public owner chain preserves identity, users CRUD and original durable records on reopen', async t => {
  const f = await fixture(t);
  const identity = await f.request('/identity'); assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { nodeId: f.nodeId, protocol: 1 });
  assert.equal(identity.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/identity', 'GET', undefined, { authorization: 'Bearer missing' })).status, 401);
  const created = await f.request('/users', 'POST', { label: ' Original ' }); assert.equal(created.status, 201);
  const { user } = await created.json(); assert.equal(user.label, 'Original');
  const updated = await f.request(`/users/${user.id}`, 'PATCH', { label: 'Updated' }); assert.equal(updated.status, 200);
  assert.equal((await updated.json()).user.id, user.id);
  await f.restart();
  const users = await f.request('/users'); assert.equal(users.status, 200);
  assert.ok((await users.json()).users.some((row: { id: string; label: string }) => row.id === user.id && row.label === 'Updated'));
  assert.equal((await f.request('/users', 'POST', { label: 'denied' }, { authorization: `Bearer ${f.reader.token}` })).status, 403);
  assert.equal((await f.request('/users', 'POST', { label: '' })).status, 400);
  assert.equal((await f.request('/users/missing', 'PATCH', { label: 'Missing' })).status, 404);
});

test('public grants issue, repeat original binding, observe usage and revoke through original worker', async t => {
  const f = await fixture(t);
  const issuer = await f.request('/execution-grants/issuer'); assert.equal(issuer.status, 200);
  assert.deepEqual(await issuer.json(), { nodeId: f.nodeId, issuerTokenId: f.actor.record.id, hubId: 'original-hub' });
  assert.equal((await (await f.request('/execution-grants/issuer/creation')).json()).creationAllowed, true);
  const binding = { principalId: 'member-original', grantKey: 'grant-original', version: 1, runtime: 'codex', sessionKey: 'codex:original' };
  const issue = () => f.request('/execution-grants', 'POST', { ...binding, actions: ['messages:send'], leaseMs: 30000 });
  const first = await issue(); assert.equal(first.status, 200); const grant = (await first.json()).grant;
  assert.deepEqual((await (await issue()).json()).grant, grant);
  const usage = await f.request('/execution-grants/usage', 'POST', { ids: [grant.id] }); assert.equal(usage.status, 200);
  assert.deepEqual((await usage.json()).usage, [{ id: grant.id, needed: false }]);
  assert.equal((await f.request('/execution-grants/revoke', 'POST', binding)).status, 200);
  assert.equal((await f.request('/execution-grants', 'POST', { ...binding, actor: 'forged' })).status, 400);
  assert.equal((await f.request('/execution-grants/issuer', 'GET', undefined, { [EXPECTED_NODE_HEADER]: 'foreign' })).status, 409);
  assert.equal((await f.request('/execution-grants/issuer', 'GET', undefined, { authorization: `Bearer ${f.reader.token}` })).status, 403);
});

test('storage uses original policy, no-store diagnostics, empty checkpoint body and shared rate limit', async t => {
  const f = await fixture(t), path = '/maintenance/storage';
  assert.equal((await f.request(path + '/recovery')).status, 200);
  const stats = await f.request(path); assert.equal(stats.status, 200);
  assert.equal(stats.headers.get('cache-control'), 'no-store');
  assert.equal(typeof (await stats.json()).databaseBytes, 'number');
  for (const extra of [{ origin: 'https://browser' }, { [EXPECTED_NODE_HEADER]: 'wrong' }, { [CONNECTOR_PROTOCOL_HEADER]: '0' },
    { authorization: `Bearer ${f.reader.token}` }]) assert.equal((await f.request(path, 'GET', undefined, extra)).status, 403);
  // Existing update tokens retain their original policy, not lifecycle's gate.
  assert.equal((await f.request(path, 'GET', undefined, { authorization: `Bearer ${f.updater.token}`, origin: 'https://browser' })).status, 200);
  assert.equal((await f.request(path + '/checkpoint', 'POST', { injected: true })).status, 400);
  assert.equal((await f.request(path + '/checkpoint', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(path + '/checkpoint', 'POST', {})).status, 200);
  const limited = await f.request(path + '/checkpoint', 'POST', {}); assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

for (const operation of ['identity', 'users', 'grants', 'storage'] as const) test(`${operation}: revoked original authority cannot receive buffered result`, async t => {
  const f = await fixture(t); let revoked = false;
  const target = operation === 'identity' ? 'tokenAuthenticate' : operation === 'users' ? 'authorizedUsersList'
    : operation === 'grants' ? 'authorizedGrantCreation' : 'authorizedStorageStats';
  f.port((async (kind, input) => {
    const result = await f.owner.command(kind, input);
    if (kind === target && !revoked) { revoked = true; await f.owner.command('tokenRevoke', { tokenId: f.actor.record.id }); }
    return result;
  }) as AsyncConnectorOwner['command']);
  const path = operation === 'identity' ? '/identity' : operation === 'users' ? '/users'
    : operation === 'grants' ? '/execution-grants/issuer/creation' : '/maintenance/storage';
  const response = await f.request(path); assert.equal(response.status, operation === 'identity' ? 401 : 403);
  assert.equal(revoked, true);
});

test('revocation between HTTP user preflight and original worker command forbids mutation', async t => {
  const f = await fixture(t); let writes = 0;
  f.port((async (kind, input) => {
    if (kind === 'authorizedUserCreate') { writes++; await f.owner.command('tokenRevoke', { tokenId: f.actor.record.id }); }
    return f.owner.command(kind, input);
  }) as AsyncConnectorOwner['command']);
  assert.equal((await f.request('/users', 'POST', { label: 'Must not exist' })).status, 403);
  assert.equal(writes, 1);
  const result = await f.owner.command('authorizedUsersList', { authorization: `Bearer ${f.reader.token}` });
  assert.ok(result.authorized); assert.equal(result.value.some(row => row.label === 'Must not exist'), false);
});

for (const ending of ['timeout', 'abort', 'close'] as const) test(`${ending}: original user commit retained and drained exactly once`, async t => {
  const f = await fixture(t, ending === 'timeout' ? 150 : 5000), entered = gate(), release = gate();
  let writes = 0;
  f.port((async (kind, input) => {
    if (kind === 'authorizedUserCreate') { writes++; entered.release(); await release.promise; }
    return f.owner.command(kind, input);
  }) as AsyncConnectorOwner['command']);
  const abort = new AbortController();
  const result = Promise.resolve(f.control.users.create(f.raw(abort.signal), 'Original late commit'));
  // Attach rejection handlers before terminating delivery.
  const rejected = assert.rejects(result);
  await entered.promise;
  if (ending === 'abort') abort.abort();
  let drained = false;
  const drain = ending === 'timeout' ? undefined : f.control.close().then(() => { drained = true; });
  if (ending !== 'close') await rejected;
  const closing = drain ?? f.control.close().then(() => { drained = true; });
  try {
    await delay(5); assert.equal(drained, false);
    await assert.rejects(f.control.identity(f.raw()), ReadRequestError);
  } finally { release.release(); }
  await rejected; await closing; assert.equal(writes, 1);
  const users = await f.owner.command('authorizedUsersList', { authorization: `Bearer ${f.actor.token}` });
  assert.ok(users.authorized); assert.equal(users.value.filter(row => row.label === 'Original late commit').length, 1);
  await f.restart();
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
});

test('failed original write acknowledgment is not retried and frozen shared port never closes worker', async t => {
  const f = await fixture(t); let writes = 0;
  f.port((async (kind, input) => {
    const result = await f.owner.command(kind, input);
    if (kind === 'authorizedUserCreate') { writes++; throw Error('PRIVATE SQL/path/token'); }
    return result;
  }) as AsyncConnectorOwner['command']);
  const failed = await f.request('/users', 'POST', { label: 'Unknown original commit' });
  assert.equal(failed.status, 503); assert.equal((await failed.text()).includes('PRIVATE'), false);
  await f.routes.close(); assert.equal(writes, 1);
  assert.equal((await f.request('/identity')).status, 503);
  const rows = await f.owner.command('authorizedUsersList', { authorization: `Bearer ${f.actor.token}` });
  assert.ok(rows.authorized); assert.equal(rows.value.filter(row => row.label === 'Unknown original commit').length, 1);
});
