import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberRequests } from './async-member-request.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubConnectorUserManagement, isHubConnectorUserManagementRequest } from '../routes/hub-connector-user-management.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: TestContext, mode: 'original' | 'worker', parent = false, budget?: number) {
  const root = mkdtempSync(join(tmpdir(), 'connector-users-package-')), file = join(root, 'hub.sqlite');
  const nodeId = `node_${randomUUID()}`, token = 'PRIVATE_CONNECTOR_USER_TOKEN';
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), user = seed.createUser('Owner');
  const key = seed.identities.issueKey(user.id), cookie = seed.identities.createSession(key.token)!;
  const foreign = seed.identities.issueKey(seed.createUser('Foreign').id);
  seed.upsertConnection({ id: 'node', ownerUserId: user.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: token });
  seed.pinConnectionNode('node', user.id, seed.connectionAuthority('node', user.id)!, nodeId);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const requests = new AsyncHubMemberRequests(owner, diagnostics), resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  const behavior: { calls: Request[]; resolve?: () => Promise<void>; transport?: () => Promise<void>;
    present?: () => void; response?: () => Response } = { calls: [] };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'connector.invalid');
    assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), nodeId);
    behavior.calls.push(request); await behavior.transport?.();
    const headers = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: nodeId };
    const response = behavior.response?.() ?? Response.json(request.method === 'GET'
      ? { users: [{ id: 'remote', label: 'Remote' }] }
      : { user: { id: 'remote', label: (await request.json() as { label: string }).label }, updatedAt: 42 },
      { status: request.method === 'POST' ? 201 : 200 });
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  });
  const asyncConnectorClient = async (...args: Parameters<typeof resolver>) => { await behavior.resolve?.(); return resolver(...args); };
  const app = new Hono();
  const metadata = parent ? original ?? new HubStore(join(root, 'composition.sqlite'), 'fixture') : undefined;
  const group = parent ? createHubAdministrativeServices(owner, diagnostics) : undefined;
  let guarded = false;
  const store = metadata && new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) throw Error('SYNC_CONNECTOR_USER_STORE'); return Reflect.get(target, property, receiver);
  } });
  const routes = parent ? registerHubRoutes(app, {
    config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store!, administrative: group!, asyncConnectorClient,
    principal: () => { throw Error('SYNC_CONNECTOR_USER_PRINCIPAL'); }, connectorClient: () => { throw Error('SYNC_CONNECTOR_USER_RESOLVER'); }, normalizeError: () => 'safe',
  })! : registerHubConnectorUserManagement(app, { mode: 'async', access: requests, asyncConnectorClient, diagnostics,
    presentDirectory: (connection, users, supported, remoteUsers, error) => { behavior.present?.(); return { id: connection.id, supported, users: remoteUsers, ...(error ? { error } : {}) }; },
    presentMutation: (connection, users, remoteUser) => { behavior.present?.(); return { id: connection.id, users: [remoteUser] }; },
    readError: c => c.json({ error: 'safe_upstream_failure' }, 502),
    ...(budget ? { responseLimits: { requestBytes: budget, retainedBytes: budget } } : {}),
  });
  guarded = true;
  const request = (method = 'GET', body?: unknown, credential: Record<string, string> = { 'x-agentopsdeck-key': key.token }) => new Request(
    'http://hub.invalid/api/hub/v1/' + (method === 'GET' ? 'connector-users' : 'connections/node/connector-users' + (method === 'PATCH' ? '/remote' : '')),
    { method, headers: credential, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const revoke = async () => {
    const evidence = { accessKey: admin.token }, actor = await owner.command('memberSnapshot', evidence); assert.ok(actor);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: actor.recoveryScope, userId: user.id, keyId: key.id });
  };
  t.after(async () => {
    guarded = false;
    await routes.close(); await requests.close(); await group?.close(); await resolver.close(); await owner.close();
    await metadata?.close(); if (original && original !== metadata) await original.close();
    for (const secret of [key.token, cookie, token]) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  return { app, request, key, cookie, foreign, behavior, revoke, close: routes.close };
}

for (const mode of ['original', 'worker'] as const) {
  for (const parent of [false, true]) test(`${mode}/${parent ? 'parent' : 'direct'}: complete directory/create/rename use current Key and Cookie, no sync ports`, async t => {
    const f = await fixture(t, mode, parent);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: `agentopsdeck_session=${f.cookie}` }]) {
      const display = await f.app.fetch(f.request('GET', undefined, headers)); assert.equal(display.status, 200);
      assert.equal((await display.json() as any).connections[0].users[0].id, 'remote');
      const created = await f.app.fetch(f.request('POST', { label: 'Created' }, headers)); assert.equal(created.status, 201);
      assert.equal((await created.json() as any).user.label, 'Created');
      assert.equal((await f.app.fetch(f.request('PATCH', { label: 'Renamed' }, headers))).status, 200);
    }
    assert.equal(f.behavior.calls.length, 6);
    const denied = await f.app.fetch(f.request('POST', { label: 'Foreign' }, { 'x-agentopsdeck-key': f.foreign.token }));
    assert.equal(denied.status, 404); assert.equal(f.behavior.calls.length, 6);
  });
  test(`${mode}: original scope and public recovery mismatch refuse before body/effect`, async t => {
    const f = await fixture(t, mode);
    const pinned = f.request('POST', { label: 'No' }); pinOriginalRequestScope(pinned, 'other-account');
    assert.equal((await f.app.fetch(pinned)).status, 401);
    const header = f.request('POST', { label: 'No' }, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'other-account' });
    assert.equal((await f.app.fetch(header)).status, 409); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: resolver revocation denies mutation; no original effect or replay`, async t => {
    const f = await fixture(t, mode); f.behavior.resolve = f.revoke;
    assert.equal((await f.app.fetch(f.request('POST', { label: 'No' }))).status, 401);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: malformed body still completes original authority check`, async t => {
    const f = await fixture(t, mode);
    const source = new ReadableStream<Uint8Array>({ async start(controller) {
      await f.revoke(); controller.enqueue(new TextEncoder().encode('{')); controller.close();
    } });
    const request = new Request(f.request('POST').url, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body: source, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401); assert.equal(f.behavior.calls.length, 0);
  });
  for (const method of ['GET', 'POST']) test(`${mode}: ${method} close retains original unresolved resolver and blocks dispatch`, async t => {
    const f = await fixture(t, mode), entered = gate(), release = gate();
    f.behavior.resolve = async () => { entered.resolve(); await release.promise; };
    const pending = f.app.fetch(f.request(method, method === 'POST' ? { label: 'No' } : undefined)); await entered.promise;
    let closed = false; const closing = f.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.behavior.calls.length, 0);
    release.resolve(); assert.equal((await pending).status, 503); await closing;
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: admitted mutation retains ignored-abort original transport, never replayed after close`, async t => {
    const f = await fixture(t, mode), entered = gate(), release = gate();
    f.behavior.transport = async () => { entered.resolve(); await release.promise; };
    const pending = f.app.fetch(f.request('POST', { label: 'Once' })); await entered.promise;
    let closed = false; const closing = f.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    release.resolve(); assert.equal((await pending).status, 503); await closing; assert.equal(f.behavior.calls.length, 1);
    assert.equal((await f.app.fetch(f.request('POST', { label: 'Again' }))).status, 503); assert.equal(f.behavior.calls.length, 1);
  });
  test(`${mode}: shutdown retains original upload cancel ACK, no premature mutation`, async t => {
    const f = await fixture(t, mode), reading = gate(), cancelled = gate(), ack = gate();
    const source = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled.resolve(); return ack.promise; } }, { highWaterMark: 0 });
    const request = new Request(f.request('POST').url, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body: source, duplex: 'half' } as RequestInit);
    const pending = f.app.fetch(request); await reading.promise;
    let closed = false; const closing = f.close().then(() => { closed = true; }); await cancelled.promise; await tick();
    assert.equal(closed, false); assert.equal(f.behavior.calls.length, 0);
    ack.resolve(); assert.equal((await pending).status, 503); await closing;
  });
  test(`${mode}: directory byte budget rejects oversized upstream without leaking output`, async t => {
    const f = await fixture(t, mode, false, 128); f.behavior.response = () => Response.json({ users: [{ id: 'large', label: 'x'.repeat(1024) }] });
    assert.equal((await f.app.fetch(f.request())).status, 503); assert.equal(f.behavior.calls.length, 1);
  });
}

test('connector user composition validates every port before publishing and selectors are exact', () => {
  const app = new Hono();
  assert.throws(() => registerHubConnectorUserManagement(app, { mode: 'async' } as never), /ports_required/);
  assert.equal(app.routes.length, 0);
  assert.equal(isHubConnectorUserManagementRequest('HEAD', '/api/hub/v1/connector-users'), true);
  assert.equal(isHubConnectorUserManagementRequest('DELETE', '/api/hub/v1/connector-users'), false);
  assert.equal(isHubConnectorUserManagementRequest('POST', '/api/hub/v1/connections/node/connector-users/extra'), false);
});
