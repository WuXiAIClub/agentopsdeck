import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerHubRoutes } from '../routes/hub.js';
import { registerHubTokenUsage } from '../routes/hub-token-usage.js';
import { loadConfig } from '../config.js';

const operations = ['read', 'export', 'create', 'snapshot'] as const;
type Operation = typeof operations[number];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** Real Hub composition and original Connector ledger, no native/provider or
 * production databases. Legacy Hub tests separately exercise Connector HTTP. */
async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false, noStore = false) {
  const root = mkdtempSync(join(tmpdir(), 'token-usage-production-')), file = join(root, 'hub.sqlite');
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Member'), other = seed.createUser('Other');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const otherKey = seed.identities.issueKey(other.id), secondKey = seed.identities.issueKey(member.id);
  seed.upsertConnection({ id: 'node', label: 'Node', ownerUserId: member.id, connectorUrl: 'http://usage-connector.invalid', credentialToken: 'PRIVATE_CONNECTOR_TOKEN' });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, users.nodeId);
  await seed.close();
  const metadata = new HubStore(mode === 'original' ? file : join(root, 'metadata.sqlite'), 'fixture');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const group = createHubAdministrativeServices(owner, diagnostics), resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  const selection = { requestId: 'd2b1634a-016a-4a16-8022-0d5ca3dd4568', from: Date.now() - 3600000, to: Date.now() + 1000, bucketMs: 60000 };
  const behavior: { calls: number; posts: number; sync: number; resolving?: () => Promise<void>;
    transport?: (request: Request, response: Response) => Response | Promise<Response> } = { calls: 0, posts: 0, sync: 0 };
  for (const runtime of ['codex', 'claude-code', 'ghcp'] as const)
    users.tokenUsage.record(runtime, `${runtime}:PRIVATE_SESSION`, 'PRIVATE_EVENT', { inputTokens: 12, outputTokens: 3 }, 'synthetic');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    assert.equal(url.hostname, 'usage-connector.invalid', 'no real network allowed');
    assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_CONNECTOR_TOKEN');
    behavior.calls++; if (request.method === 'POST') behavior.posts++;
    const match = /^\/api\/connector\/v1\/sessions\/([^/]+)\/token-usage(.*)$/.exec(url.pathname); assert.ok(match);
    const session = decodeURIComponent(match[1]!), runtime = session.split(':')[0] as 'codex' | 'claude-code' | 'ghcp';
    const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to')), bucket = Number(url.searchParams.get('bucketMs'));
    const suffix = match[2]!;
    let data;
    if (request.method === 'POST') {
      const body = await request.json() as typeof selection;
      data = users.tokenUsage.snapshot(runtime, session, body.requestId, body.from, body.to, body.bucketMs);
    } else if (suffix.startsWith('/snapshots/')) data = users.tokenUsage.readSnapshot(runtime, session, suffix.slice('/snapshots/'.length));
    else data = suffix === '/export' ? users.tokenUsage.export(runtime, session, from, to, bucket) : users.tokenUsage.range(runtime, session, from, to, bucket);
    const response = Response.json(data ?? { error: 'not found' }, { status: data ? 200 : 404,
      headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: users.nodeId } });
    return behavior.transport ? behavior.transport(request, response) : response;
  });
  let guarded = false;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) { behavior.sync++; throw Error('SYNC_TOKEN_STORE_FALLBACK'); }
    return Reflect.get(target, property, receiver);
  } });
  const app = new Hono();
  const asyncConnectorClient = async (...args: Parameters<typeof resolver>) => {await behavior.resolving?.(); return resolver(...args);};
  const routes = noStore
    ? registerHubTokenUsage(app, {mode: 'async', access: group.createConnectionProxyAccess(), asyncConnectorClient})
    : registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
    administrative: group, principal: () => { behavior.sync++; throw Error('SYNC_TOKEN_PRINCIPAL_FALLBACK'); },
    connectorClient: () => { behavior.sync++; throw Error('SYNC_TOKEN_RESOLVER_FALLBACK'); },
    ...(!noResolver ? { asyncConnectorClient } : {}),
    normalizeError: () => 'safe' });
  guarded = true;
  t.after(async () => {
    guarded = false;
    await routes?.close(); await group.close(); await resolver.close(); await owner.close(); await metadata.close(); users.close();
    for (const secret of [key.token, cookie, otherKey.token, secondKey.token, 'PRIVATE_SESSION', 'PRIVATE_EVENT', 'PRIVATE_CONNECTOR_TOKEN'])
      assert.equal(logs.join('').includes(secret), false, 'diagnostics must not contain private data');
    rmSync(root, { recursive: true, force: true });
  });
  const path = (operation: Operation, runtime = 'codex') => `/api/hub/v1/sessions/${encodeHubSessionId('node', `${runtime}:PRIVATE_SESSION`)}/token-usage`
    + (operation === 'read' ? `?from=${selection.from}&to=${selection.to}&bucketMs=${selection.bucketMs}`
      : operation === 'export' ? `/export?from=${selection.from}&to=${selection.to}&bucketMs=${selection.bucketMs}`
        : '/snapshots' + (operation === 'snapshot' ? `/${selection.requestId}` : ''));
  const request = (operation: Operation, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, runtime = 'codex', signal?: AbortSignal) =>
    new Request('http://hub.invalid' + path(operation, runtime), { method: operation === 'create' ? 'POST' : 'GET', headers,
      ...(signal ? { signal } : {}), ...(operation === 'create' ? { body: JSON.stringify(selection) } : {}) });
  const evidence = hubMemberEvidence(new Request('http://hub.invalid', { headers: { 'x-agentopsdeck-key': admin.token } }));
  const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const proof = { evidence, expectedScope: snapshot.recoveryScope };
  const revoke = () => owner.command('memberKeyRevoke', { ...proof, userId: member.id, keyId: key.id });
  const change = async () => {
    // Connection ownership is not an administrator bypass. Mutate with the
    // member's other key, independently of the key exercised by this request.
    const evidence = hubMemberEvidence(new Request('http://hub.invalid', { headers: { 'x-agentopsdeck-key': secondKey.token } }));
    const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    const proof = { evidence, expectedScope: snapshot.recoveryScope };
    const target = await owner.command('connectionTarget', { ...proof, id: 'node' }); assert.ok(target && 'epoch' in target);
    const result = await owner.command('connectionChange', { ...proof, change: { action: 'patch', id: 'node', expectedEpoch: target.epoch, configuration: { enabled: false } } });
    assert.ok(result && !('error' in result));
  };
  return { app, close: () => routes!.close(), request, path, selection, behavior, key, cookie, otherKey, secondKey, revoke, change, users };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} async-only token ledger four-entry composition preserves credentials and original receipts`, async t => {
    const f = await fixture(t, mode, false, true);
    for (const runtime of ['codex', 'claude-code', 'ghcp']) {
      let receipt: unknown;
      for (const headers of [{'x-agentopsdeck-key': f.key.token}, {cookie: 'agentopsdeck_access=' + f.key.token}, {cookie: 'agentopsdeck_session=' + f.cookie}])
        for (const operation of operations) {
          const response = await f.app.fetch(f.request(operation, headers, runtime));
          assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
          const body = await response.json();
          if (operation === 'create') {if (receipt) assert.deepEqual(body, receipt); else receipt = body;}
          if (operation === 'snapshot') assert.deepEqual(body, receipt);
        }
    }
    const calls = f.behavior.calls; await f.revoke();
    for (const operation of operations) assert.equal((await f.app.fetch(f.request(operation))).status, 401);
    assert.equal(f.behavior.calls, calls); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} token four-entry production chain preserves three credentials, native runtimes and original immutable ledger`, async t => {
    const f = await fixture(t, mode);
    for (const runtime of ['codex', 'claude-code', 'ghcp']) {
      let snapshot: unknown;
      for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
        for (const operation of ['read', 'export', 'create', 'snapshot'] as const) {
          const response = await f.app.fetch(f.request(operation, headers, runtime));
          assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('cache-control'), 'no-store');
          const body = await response.json();
          if (operation === 'read') {
            assert.equal(body.runtime, runtime);
            assert.equal(body.buckets.reduce((sum: number, row: { inputTokens: number }) => sum + row.inputTokens, 0), 12);
          }
          if (operation === 'create') { if (snapshot) assert.deepEqual(body, snapshot); else snapshot = body; }
          if (operation === 'snapshot') assert.deepEqual(body, snapshot);
        }
      }
    }
    assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} token four entries deny capability, foreign owner, stale scope and absent resolver`, async t => {
    const f = await fixture(t, mode);
    for (const operation of operations) {
      for (const [headers, status] of [
        [{ authorization: 'Bearer aod_board_untrusted' }, 401], [{ 'x-agentopsdeck-key': f.otherKey.token }, 404],
        [{ 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'stale' }, 409],
      ] as const) assert.equal((await f.app.fetch(f.request(operation, headers))).status, status);
    }
    assert.equal(f.behavior.calls, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} token async chain fails closed without its resolver`, async t => {
    const f = await fixture(t, mode, true);
    for (const operation of operations) assert.equal((await f.app.fetch(f.request(operation))).status, 503);
    assert.equal(f.behavior.calls, 0); assert.equal(f.behavior.sync, 0);
  });
  for (const operation of operations) test(`${mode} token ${operation} original resolver-time revocation prevents effect`, async t => {
    const f = await fixture(t, mode);
    f.behavior.resolving = async () => { await f.revoke(); };
    assert.equal((await f.app.fetch(f.request(operation))).status, 401);
    assert.equal(f.behavior.calls, 0); assert.equal(f.behavior.sync, 0);
  });
  for (const mutation of ['revoke', 'epoch'] as const) test(`${mode} token ${mutation} after remote failure takes priority over transport status`, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = async (_request, response) => {
      await response.body?.cancel(); await (mutation === 'revoke' ? f.revoke() : f.change());
      return Response.json({ error: 'PRIVATE_REMOTE' }, { status: 503, headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
    };
    const response = await f.app.fetch(f.request('read'));
    assert.equal(response.status, mutation === 'revoke' ? 401 : 403); assert.equal((await response.text()).includes('PRIVATE_REMOTE'), false);
    assert.equal(f.behavior.calls, 1);
  });
  test(`${mode} token snapshot unknown POST uses original requestId query, never resends`, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = async (_request, response) => { await response.body?.cancel(); throw Error('PRIVATE_LOST_ACK'); };
    const response = await f.app.fetch(f.request('create')); assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('PRIVATE_LOST_ACK'), false); assert.equal(f.behavior.posts, 1);
    delete f.behavior.transport;
    const result = await f.app.fetch(f.request('snapshot')); assert.equal(result.status, 200);
    assert.equal((await result.json()).requestId, f.selection.requestId); assert.equal(f.behavior.posts, 1);
  });
  test(`${mode} token four-entry validation keeps canonical IDs, bounded bodies and snapshot integrity`, async t => {
    const f = await fixture(t, mode), headers = { 'x-agentopsdeck-key': f.key.token };
    for (const [path, method, body, status] of [
      [f.path('read').split('?')[0] + '?from=bad', 'GET', undefined, 400],
      [f.path('create'), 'POST', 'x'.repeat(1025), 413], [f.path('create'), 'POST', '{', 400],
      [f.path('create'), 'POST', JSON.stringify({ ...f.selection, owner: 'default' }), 400],
      [f.path('snapshot').replace(f.selection.requestId, 'invalid'), 'GET', undefined, 400],
      [f.path('read').replace(encodeHubSessionId('node', 'codex:PRIVATE_SESSION'), 'invalid'), 'GET', undefined, 404],
    ] as const) assert.equal((await f.app.request(path, { method, headers, ...(body ? { body } : {}) })).status, status);
    assert.equal(f.behavior.calls, 0);
    f.behavior.transport = async (_request, response) => {
      const body = await response.json(); body.memberDigest = '0'.repeat(64);
      return Response.json(body, { headers: response.headers });
    };
    assert.equal((await f.app.fetch(f.request('create'))).status, 502); assert.equal(f.behavior.posts, 1);
  });
  for (const waiting of ['resolver', 'network'] as const) test(`${mode} token close owns original ${waiting} even after HTTP abort, refuses late delivery and new admission`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred(), controller = new AbortController();
    if (waiting === 'resolver') f.behavior.resolving = async () => { entered.resolve(); await release.promise; };
    else f.behavior.transport = async (_request, response) => { entered.resolve(); await release.promise; return response; };
    const pending = f.app.fetch(f.request('create', undefined, undefined, controller.signal));
    try {
      await entered.promise;
      controller.abort();
      let settled = false; const closing = f.close().then(() => { settled = true; });
      assert.equal((await f.app.fetch(f.request('read'))).status, 503);
      await tick(); assert.equal(settled, false, 'original operation still owns shutdown');
      release.resolve(); assert.equal((await pending).status, 503); await closing;
      assert.equal(f.behavior.posts, waiting === 'resolver' ? 0 : 1);
    } finally { release.resolve(); await pending; }
  });
  for (const stopping of ['revoke', 'close'] as const) test(`${mode} token snapshot body-time ${stopping} prevents native dispatch`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      entered.resolve(); await release.promise; stream.enqueue(new TextEncoder().encode(JSON.stringify(f.selection))); stream.close();
    } }, { highWaterMark: 0 });
    const request = new Request('http://hub.invalid' + f.path('create'), { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    const pending = f.app.fetch(request);
    try {
      await entered.promise;
      let settled = false;
      const closing = stopping === 'close' ? f.close().then(() => { settled = true; }) : undefined;
      if (stopping === 'revoke') await f.revoke();
      await tick(); assert.equal(settled, false);
      release.resolve(); assert.equal((await pending).status, stopping === 'close' ? 503 : 401);
      await closing; assert.equal(f.behavior.posts, 0);
    } finally { release.resolve(); await pending; }
  });
}
