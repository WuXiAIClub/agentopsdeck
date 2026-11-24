import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, HISTORY_ASYNC_HEADER, historyPendingBody } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gates = new WeakMap<TestContext, Set<() => void>>();
function deferred(t: TestContext) {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  // A failed assertion must not strand route teardown behind a fixture gate.
  if (!gates.has(t)) gates.set(t, new Set());
  gates.get(t)!.add(resolve); t.signal.addEventListener('abort', resolve, { once: true });
  return { promise, resolve };
}
const resource = 'a'.repeat(64), remoteSession = 'hermes:PRIVATE_HISTORY';
type Operation = 'list' | 'detail' | 'media' | 'inbound' | 'approve' | 'unapprove';
const operations: Operation[] = ['list', 'detail', 'media', 'inbound', 'approve', 'unapprove'];

async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false) {
  const root = mkdtempSync(join(tmpdir(), 'history-media-production-')), file = join(root, 'hub.sqlite');
  const nodeId = `node_${randomUUID()}`, connectorToken = 'PRIVATE_CONNECTOR_TOKEN';
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('History owner');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const secondKey = seed.identities.issueKey(member.id), foreign = seed.createUser('Other owner');
  const foreignKey = seed.identities.issueKey(foreign.id);
  seed.upsertConnection({ id: 'node', ownerUserId: member.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: connectorToken });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, nodeId);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'metadata');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: {
    after?: (kind: HubMemberKind) => void | Promise<void>;
    resolving?: () => void | Promise<void>;
    transport?: (request: Request, response: Response) => Response | Promise<Response>;
    media?: () => Response;
    calls: Request[]; mutations: number; sync: number; commands: HubMemberKind[];
  } = { calls: [], mutations: 0, sync: 0, commands: [] };
  const port = { command: async (kind: HubMemberKind, input: never) => {
    behavior.commands.push(kind); const result = await owner.command(kind, input); await behavior.after?.(kind); return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics),
    resolver = createAsyncConnectorClientResolver(port, undefined, diagnostics);
  const message = { id: 'm1', sessionKey: remoteSession, role: 'assistant', text: 'PRIVATE_HISTORY_TEXT', timestamp: 123,
    sessionRef: { nodeId: 'untrusted', sessionKey: 'untrusted' },
    media: [{ type: 'image', url: '/api/media/inbound/fixture.png', name: 'fixture.png', mimeType: 'image/png' }] };
  const remote = new Hono();
  remote.use('*', async (c, next) => {
    assert.equal(c.req.header('authorization'), 'Bearer ' + connectorToken);
    await next();
    // Raw media Responses do not inherit Hono's prepared headers. Model the
    // real Connector response middleware, including streams and range errors.
    c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, nodeId);
  });
  remote.get('/api/connector/v1/sessions/:session/messages', c => {
    assert.equal(c.req.param('session'), remoteSession);
    return c.json({ messages: [message], totalCount: 1, hiddenCount: 0, updatedAt: 123, revision: 'original-revision' });
  });
  remote.get('/api/connector/v1/sessions/:session/messages/:message', c => c.json({ message, updatedAt: 123 }));
  for (const path of ['/sessions/:session/messages/:message/media/:resource', '/media/inbound/:name'])
    remote.get('/api/connector/v1' + path, c => {
      if (behavior.media) return behavior.media();
      const range = c.req.header('range');
      if (range === 'bytes=99-') return new Response(null, { status: 416, headers: { 'content-range': 'bytes */3' } });
      return new Response(range ? 'b' : 'abc', { status: range ? 206 : 200, headers: {
        'content-type': 'image/png', 'content-length': range ? '1' : '3', 'accept-ranges': 'bytes',
        ...(range ? { 'content-range': 'bytes 1-1/3' } : {}),
        'set-cookie': 'PRIVATE_COOKIE', 'x-private': 'PRIVATE_EXTENSION',
      } });
    });
  for (const method of ['POST', 'DELETE'] as const) remote.on(method,
    '/api/connector/v1/sessions/:session/messages/:message/media/:resource/approval', c => {
      behavior.mutations++; return c.json({ ok: true });
    });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'connector.invalid', 'no real network/native effects');
    behavior.calls.push(request);
    const response = await remote.fetch(request);
    return behavior.transport ? behavior.transport(request, response) : response;
  });
  let guarded = false;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) throw Error('SYNC_HISTORY_STORE_FALLBACK'); return Reflect.get(target, property, receiver);
  } });
  const app = new Hono();
  const routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
    administrative: group, principal: () => { behavior.sync++; return undefined; },
    connectorClient: () => { throw Error('SYNC_HISTORY_RESOLVER_FALLBACK'); },
    ...(!noResolver ? { asyncConnectorClient: async (...args: Parameters<typeof resolver>) => { await behavior.resolving?.(); return resolver(...args); } } : {}),
    normalizeError: () => 'safe',
  });
  assert.ok(routes);
  guarded = true;
  t.after(async () => {
    for (const release of gates.get(t) ?? []) release();
    guarded = false; delete behavior.after; delete behavior.resolving;
    // A close assertion failure must not leak fixture workers into the runner.
    try { await routes.close(); }
    finally { try { await group.close(); } finally { try { await resolver.close(); }
      finally { try { await owner.close(); } finally { await metadata.close(); } } } }
    for (const secret of [key.token, secondKey.token, cookie, connectorToken, 'PRIVATE_HISTORY_TEXT', 'PRIVATE_HISTORY', 'PRIVATE_COOKIE', 'PRIVATE_EXTENSION'])
      assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const id = encodeHubSessionId('node', remoteSession), base = `/api/hub/v1/sessions/${encodeURIComponent(id)}/messages`;
  const paths: Record<Operation, string> = { list: base, detail: base + '/m1', media: base + '/m1/media/' + resource,
    inbound: '/api/hub/v1/connections/node/media/inbound/fixture.png', approve: base + '/m1/media/' + resource + '/approval',
    unapprove: base + '/m1/media/' + resource + '/approval' };
  const request = (op: Operation, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, signal?: AbortSignal) =>
    new Request('http://hub.invalid' + paths[op], { method: op === 'approve' ? 'POST' : op === 'unapprove' ? 'DELETE' : 'GET', headers, ...(signal ? { signal } : {}) });
  const evidence = hubMemberEvidence(request('list')), snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const proof = { evidence, expectedScope: snapshot.recoveryScope };
  const revoke = async () => {
    const evidence = { accessKey: admin.token }, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope, userId: member.id, keyId: key.id });
  };
  const change = async (disable = false) => {
    const target = await owner.command('connectionTarget', { ...proof, id: 'node' }); assert.ok(target && 'epoch' in target);
    await owner.command('connectionChange', { ...proof, change: { action: 'patch', id: 'node', expectedEpoch: target.epoch,
      configuration: disable ? { enabled: false } : { label: 'Renamed' } } });
  };
  return { app, behavior, request, paths, id, nodeId, key, secondKey, cookie, foreignKey, revoke, change, close: routes.close };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} owner history/media/approval preserve Key/Cookie, wrapping, range and conditional history`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { 'x-agentopsdeck-key': f.secondKey.token },
      { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      for (const op of operations) {
        const response = await f.app.fetch(f.request(op, headers));
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (op === 'list' || op === 'detail') {
          const body = await response.json(), message = op === 'list' ? body.messages[0] : body.message;
          assert.equal(message.hubSessionId, f.id); assert.equal(message.sessionKey, f.id);
          assert.equal(JSON.stringify(message.sessionRef).includes('untrusted'), false);
          assert.equal(JSON.stringify(message.sessionRef).includes(f.nodeId), true);
          assert.match(message.media[0].url, /^\/api\/hub\/v1\/sessions\//);
        } else if (op === 'media' || op === 'inbound') {
          assert.equal(await response.text(), 'abc'); assert.equal(response.headers.get('set-cookie'), null);
          assert.equal(response.headers.get('x-private'), null);
        } else assert.deepEqual(await response.json(), { ok: true });
      }
    }
    const first = await f.app.fetch(f.request('list')), etag = first.headers.get('etag')!;
    const cached = await f.app.fetch(f.request('list', { 'x-agentopsdeck-key': f.key.token, 'if-none-match': etag }));
    assert.equal(cached.status, 304);
    for (const op of ['media', 'inbound'] as const) {
      const partial = await f.app.fetch(f.request(op, { 'x-agentopsdeck-key': f.key.token, range: 'bytes=1-1', 'if-range': 'original-validator' }));
      assert.equal(partial.status, 206); assert.equal(await partial.text(), 'b');
      assert.equal(f.behavior.calls.at(-1)!.headers.get('if-range'), 'original-validator');
      const missing = await f.app.fetch(f.request(op, { 'x-agentopsdeck-key': f.key.token, range: 'bytes=99-' }));
      assert.equal(missing.status, 416); assert.equal(missing.headers.get('content-range'), 'bytes */3');
    }
    assert.equal(f.behavior.sync, 0); assert.equal(f.behavior.commands.includes('connectionDirectory'), false);
  });
  test(`${mode} owner proxies reject foreign identity and bad scope without transport`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const op of operations) {
      assert.equal((await f.app.fetch(f.request(op, { 'x-agentopsdeck-key': f.foreignKey.token }))).status, 404);
      assert.equal((await f.app.fetch(f.request(op, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'stale' }))).status, 409);
    }
    const request = f.request('list'); pinOriginalRequestScope(request, 'stale-process-pin');
    assert.equal((await f.app.fetch(request)).status, 401);
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} missing async resolver fails closed for every owner proxy`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode, true);
    for (const op of operations) assert.equal((await f.app.fetch(f.request(op))).status, 503);
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  for (const op of operations) {
    test(`${mode} ${op} resolver epoch change cannot dispatch with freshly selected authority`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); f.behavior.resolving = async () => { delete f.behavior.resolving; await f.change(); };
      assert.equal((await f.app.fetch(f.request(op))).status, 403);
      assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.mutations, 0);
    });
  }
  for (const op of ['list', 'detail', 'approve', 'unapprove'] as const) {
    test(`${mode} ${op} network completion cannot deliver after original key revocation`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode);
      f.behavior.transport = async (_request, response) => { delete f.behavior.transport; await f.revoke(); return response; };
      assert.equal((await f.app.fetch(f.request(op))).status, 401);
      assert.equal(f.behavior.calls.length, 1); assert.equal(f.behavior.mutations, op === 'list' || op === 'detail' ? 0 : 1);
    });
  }
  test(`${mode} owner proxies preserve history preparation and source error headers`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = (_request, response) => Response.json(historyPendingBody(), { status: 202, headers: response.headers });
    const pending = await f.app.fetch(f.request('list', { 'x-agentopsdeck-key': f.key.token, [HISTORY_ASYNC_HEADER]: '1' }));
    assert.equal(pending.status, 202); assert.equal(pending.headers.get('retry-after'), '1');
    f.behavior.transport = (_request, response) => {
      const headers = new Headers(response.headers); headers.set('x-agentopsdeck-source-error', 'outside-roots'); headers.set('x-agentopsdeck-source-approval', 'available');
      return Response.json({ error: 'Source needs approval' }, { status: 404, headers });
    };
    const denied = await f.app.fetch(f.request('media'));
    assert.equal(denied.status, 404); assert.equal(denied.headers.get('x-agentopsdeck-source-error'), 'outside-roots');
    assert.equal(denied.headers.get('x-agentopsdeck-source-approval'), 'available');
    assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} mismatched detail and Connector node do not publish original history`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = (_request, response) => Response.json({ message: { id: 'other' }, updatedAt: 123 }, { headers: response.headers });
    assert.equal((await f.app.fetch(f.request('detail'))).status, 502);
    f.behavior.transport = (_request, response) => {
      const headers = new Headers(response.headers); headers.set(NODE_ID_HEADER, `node_${randomUUID()}`);
      return new Response(response.body, { status: response.status, headers });
    };
    assert.equal((await f.app.fetch(f.request('list'))).status, 502);
  });
  test(`${mode} lost approval ACK is not replayed or reported as confirmed`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = (request, response) => { if (request.method === 'POST') throw Error('lost original ACK'); return response; };
    const response = await f.app.fetch(f.request('approve'));
    assert.equal(response.status, 502); assert.equal(f.behavior.mutations, 1); assert.equal(f.behavior.calls.length, 1);
  });
  test(`${mode} original approval dispatch ACK is drained on route close`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), entered = deferred(t), release = deferred(t);
    f.behavior.transport = async (_request, response) => { entered.resolve(); await release.promise; return response; };
    const response = f.app.fetch(f.request('approve')); await entered.promise;
    let closed = false; const closing = f.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); release.resolve();
    assert.equal((await response).status, 503); await closing;
    assert.equal(f.behavior.mutations, 1); assert.equal((await f.app.fetch(f.request('list'))).status, 503);
  });
  for (const op of ['list', 'detail', 'media', 'inbound'] as const) {
    test(`${mode} cancelled ${op} returns promptly but close retains late dispatch and source cancellation`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode), entered = deferred(t), releaseDispatch = deferred(t), cancelling = deferred(t), releaseCancel = deferred(t);
      const abort = new AbortController(); let cancelled = 0;
      f.behavior.transport = async (_request, response) => {
        await response.body?.cancel();
        entered.resolve(); await releaseDispatch.promise;
        return new Response(new ReadableStream({ async cancel() { cancelled++; cancelling.resolve(); await releaseCancel.promise; } },
          { highWaterMark: 0 }), { headers: response.headers });
      };
      try {
        const response = f.app.fetch(f.request(op, undefined, abort.signal)); await entered.promise;
        abort.abort(); assert.equal((await response).status, 499);
        let closed = false; const closing = f.close().then(() => { closed = true; });
        await tick(); assert.equal(closed, false);
        releaseDispatch.resolve(); await cancelling.promise; await tick(); assert.equal(closed, false);
        releaseCancel.resolve(); await closing; assert.equal(cancelled, 1); assert.equal(f.behavior.calls.length, 1);
      } finally { releaseDispatch.resolve(); releaseCancel.resolve(); }
    });
  }
  for (const op of ['media', 'inbound'] as const) {
    test(`${mode} ${op} cannot publish a second chunk after epoch change`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); let count = 0, cancelled = 0;
      f.behavior.media = () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new TextEncoder().encode(String(++count))); }, cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } });
      const response = await f.app.fetch(f.request(op)); assert.equal(response.status, 200);
      const reader = response.body!.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), '1');
      await f.change(); await assert.rejects(reader.read()); assert.equal(cancelled, 1);
    });
    test(`${mode} unconsumed ${op} holds original cancellation ACK during close`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode), entered = deferred(t), release = deferred(t); let pulls = 0;
      f.behavior.media = () => new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array([1])); },
        async cancel() { entered.resolve(); await release.promise; },
      }, { highWaterMark: 0 }));
      const response = await f.app.fetch(f.request(op)); assert.equal(response.status, 200); assert.equal(pulls, 0);
      let closed = false; const closing = f.close().then(() => { closed = true; });
      await entered.promise; await tick(); assert.equal(closed, false); release.resolve(); await closing;
      await assert.rejects(response.text()); assert.equal(pulls, 0);
    });
    test(`${mode} browser cancellation of ${op} drains its original source once`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode), entered = deferred(t), release = deferred(t), abort = new AbortController(); let cancelled = 0;
      f.behavior.media = () => new Response(new ReadableStream({
        async cancel() { cancelled++; entered.resolve(); await release.promise; },
      }, { highWaterMark: 0 }));
      const response = await f.app.fetch(f.request(op, undefined, abort.signal)); assert.equal(response.status, 200);
      abort.abort(); await entered.promise;
      let closed = false; const closing = f.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
      release.resolve(); await closing; assert.equal(cancelled, 1); await assert.rejects(response.text());
    });
  }
}
