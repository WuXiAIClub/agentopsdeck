import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, type WorkspaceSyncFrame } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { registerHubRoutes } from '../routes/hub.js';
import { registerHubWorkspaceSync, isAsyncHubWorkspaceSyncRequest } from '../routes/hub-workspace-sync.js';
import { encodeHubSessionId } from './session-id.js';
import { loadConfig } from '../config.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const base = '/api/hub/v1/workspace/';

async function fixture(t: TestContext, mode: 'original' | 'worker', parent: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-sync-production-')), file = join(root, 'hub.sqlite');
  let metadata = new HubStore(file, 'workspace-fixture');
  const node = 'node_' + randomUUID();
  (metadata as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = metadata.identities.issueKey('default'), member = metadata.createUser('Member'), foreign = metadata.createUser('Other');
  const key = metadata.identities.issueKey(member.id), cookie = metadata.identities.createSession(key.token)!;
  const scope = metadata.identities.recoveryScope({ userId: member.id, admin: false });
  for (const [id, ownerUserId] of [['local', member.id], ['foreign', foreign.id]]) {
    metadata.upsertConnection({ id: id!, ownerUserId: ownerUserId!, label: 'Dev', connectorUrl: 'http://workspace-connector.invalid', credentialToken: 'PRIVATE_CONNECTOR_TOKEN' });
    metadata.pinConnectionNode(id!, ownerUserId!, metadata.connectionAuthority(id!, ownerUserId!)!, node);
  }
  const native = 'codex:fixture', sessionKey = encodeHubSessionId('local', native);
  if (mode === 'worker') { await metadata.close(); metadata = new HubStore(join(root, 'metadata.sqlite'), 'workspace-fixture'); }
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'workspace-fixture' }, diagnostics);
  const services = createHubAdministrativeServices(owner, diagnostics), resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  const behavior: { sync: number; reads: number; resolving?: () => Promise<void>; transport?: () => Promise<void>; cancel?: () => Promise<void> } = { sync: 0, reads: 0 };
  t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
    const request = raw instanceof Request ? raw : new Request(raw, init), url = new URL(request.url);
    assert.equal(url.origin, 'http://workspace-connector.invalid'); assert.equal(request.method, 'GET');
    assert.equal(url.pathname, `/api/connector/v1/sessions/${encodeURIComponent(native)}/messages`);
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
    assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_CONNECTOR_TOKEN');
    behavior.reads++; await behavior.transport?.();
    const headers = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node };
    if (behavior.cancel) return new Response(new ReadableStream<Uint8Array>({ cancel: behavior.cancel }), { headers });
    return Response.json({ messages: [{ id: 'm1', sessionKey: native, role: 'assistant', text: 'Existing history', createdAt: 1 }], totalCount: 1, hiddenCount: 0, updatedAt: 1 }, { headers });
  });
  const asyncConnectorClient: typeof resolver = Object.assign(async (...args: Parameters<typeof resolver>) => {
    await behavior.resolving?.(); return resolver(...args);
  }, { close: () => resolver.close() });
  let guarded = false;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) { behavior.sync++; throw Error('SYNCHRONOUS_WORKSPACE_BYPASS'); }
    return Reflect.get(target, property, receiver);
  } });
  const app = new Hono(), routes = parent ? registerHubRoutes(app, {
    config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store, administrative: services, asyncConnectorClient,
    principal: () => { behavior.sync++; throw Error('SYNCHRONOUS_PRINCIPAL_BYPASS'); },
    connectorClient: () => { behavior.sync++; throw Error('SYNCHRONOUS_CONNECTOR_BYPASS'); }, normalizeError: () => 'unavailable',
  }) : registerHubWorkspaceSync(app, { mode: 'async', access: services.createConnectionVerificationAccess().requests,
    asyncConnectorClient, wrap: message => message, diagnostics });
  assert.ok(routes); guarded = true;
  t.after(async () => {
    guarded = false; await routes.close(); await services.close(); await resolver.close(); await owner.close(); await metadata.close();
    assert.equal(behavior.sync, 0);
    for (const secret of [key.token, cookie, 'PRIVATE_CONNECTOR_TOKEN']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const request = (options: { check?: boolean; items?: unknown; headers?: Record<string, string>; pin?: string; signal?: AbortSignal; body?: BodyInit } = {}) => {
    const raw = new Request('http://hub.invalid' + base + (options.check ? 'check' : 'sync'), {
      method: 'POST', headers: options.headers ?? { 'x-agentopsdeck-key': key.token },
      body: options.body ?? JSON.stringify({ version: 1, items: options.items ?? [{ sessionKey, limit: 50 }] }),
      ...(options.signal ? { signal: options.signal } : {}), ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    });
    if (options.pin !== undefined) pinOriginalRequestScope(raw, options.pin);
    return app.fetch(raw);
  };
  return { request, behavior, sessionKey, key, cookie, scope, close: () => routes.close(),
    revoke: async () => {
      const evidence = { accessKey: admin.token }, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
      assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope, userId: member.id, keyId: key.id }), { ok: true });
    },
  };
}
async function frames(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
  const text = await response.text(); assert.doesNotMatch(text, /PRIVATE_|credentialToken/);
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkspaceSyncFrame);
}
for (const mode of ['original', 'worker'] as const) for (const parent of [false, true]) {
  const label = `workspace sync ${mode}/parent=${parent}`;
  test(`${label}: no-store production preserves saved Cookie, NDJSON and conditional calibration`, async t => {
    const f = await fixture(t, mode, parent);
    const [page] = await frames(await f.request({ headers: { cookie: 'agentopsdeck_session=' + f.cookie } }));
    assert.equal(page!.status, 200); assert.equal((page!.body as { messages: { text: string }[] }).messages[0]!.text, 'Existing history');
    const etag = page!.headers!.etag; assert.ok(etag);
    const [check] = await frames(await f.request({ check: true, items: [{ sessionKey: f.sessionKey, limit: 50, etag }] }));
    assert.equal(check!.status, 304); assert.equal(check!.body, undefined);
    const [foreign] = await frames(await f.request({ items: [{ sessionKey: encodeHubSessionId('foreign', 'codex:fixture'), limit: 50 }] }));
    assert.equal(foreign!.status, 404); assert.equal(f.behavior.reads, 2);
  });
  test(`${label}: public/private scope and invalid explicit Key never downgrade to saved Cookie`, async t => {
    const f = await fixture(t, mode, parent);
    assert.equal((await f.request({ headers: { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'old' } })).status, 409);
    assert.equal((await f.request({ pin: '0'.repeat(64) })).status, 401);
    assert.equal((await f.request({ headers: { cookie: 'agentopsdeck_session=' + f.cookie, 'x-agentopsdeck-key': 'hub_key_invalid' } })).status, 401);
    assert.equal(f.behavior.reads, 0);
  });
  for (const boundary of ['resolver', 'transport'] as const) {
    test(`${label}: ${boundary} revoke before delivery cannot expose buffered history`, async t => {
      const f = await fixture(t, mode, parent);
      f.behavior[boundary === 'resolver' ? 'resolving' : 'transport'] = async () => { await f.revoke(); };
      const [frame] = await frames(await f.request()); assert.equal(frame!.status, 401); assert.equal((frame!.body as { messages?: unknown }).messages, undefined);
      assert.equal(f.behavior.reads, boundary === 'resolver' ? 0 : 1);
    });
    test(`${label}: close freezes dispatch and retains ignored-abort ${boundary} original ACK`, async t => {
      const f = await fixture(t, mode, parent), entered = gate(), release = gate(), abort = new AbortController();
      f.behavior[boundary === 'resolver' ? 'resolving' : 'transport'] = async () => { entered.resolve(); await release.promise; };
      const response = await f.request({ signal: abort.signal }), text = response.text(); await entered.promise;
      abort.abort(); let done = false; const closing = f.close().then(() => { done = true; });
      try { await tick(); assert.equal(done, false); assert.equal((await f.request()).status, 503); }
      finally { release.resolve(); await text.catch(() => {}); await closing; }
      assert.equal(f.behavior.reads, boundary === 'resolver' ? 0 : 1);
    });
  }
  test(`${label}: close waits late response cancellation acknowledgement`, async t => {
    const f = await fixture(t, mode, parent), entered = gate(), release = gate(), cancelling = gate(), cancelled = gate();
    f.behavior.transport = async () => { entered.resolve(); await release.promise; };
    f.behavior.cancel = async () => { cancelling.resolve(); await cancelled.promise; };
    const response = await f.request(), text = response.text(); await entered.promise;
    let done = false; const closing = f.close().then(() => { done = true; });
    try { release.resolve(); await cancelling.promise; await tick(); assert.equal(done, false); }
    finally { release.resolve(); cancelled.resolve(); await text.catch(() => {}); await closing; }
  });
  test(`${label}: pending request body is owned through close and never dispatched`, async t => {
    const f = await fixture(t, mode, parent), entered = gate(); let body!: ReadableStreamDefaultController<Uint8Array>;
    const request = f.request({ body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, pull() { entered.resolve(); } }, { highWaterMark: 0 }) });
    await entered.promise; await tick(); let done = false; const closing = f.close().then(() => { done = true; });
    try { await tick(); assert.equal(done, false); }
    finally { body.enqueue(new TextEncoder().encode('{"items":[]}')); body.close(); await request; await closing; }
    assert.equal((await request).status, 503); assert.equal(f.behavior.reads, 0);
  });
}
test('workspace sync async production selector is exact', () => {
  assert.equal(isAsyncHubWorkspaceSyncRequest('POST', base + 'sync'), true);
  assert.equal(isAsyncHubWorkspaceSyncRequest('POST', base + 'check'), true);
  for (const [method, path] of [['GET', base + 'sync'], ['POST', base + 'sync/extra'], ['DELETE', base + 'check']]) assert.equal(isAsyncHubWorkspaceSyncRequest(method!, path!), false);
});
