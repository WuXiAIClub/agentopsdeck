import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { isHubConnectionFileRequest } from '../routes/hub-connection-files.js';
import { loadConfig } from '../config.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';

const token = '12345678-1234-1234-1234-123456789abc';
const paths = ['agents', 'models/codex', 'files/roots', 'files/git/roots', 'issues/sources',
  'issues/source/items?state=open&kind=issue', 'files/git/repo/tree', `files/git/repo/preview?pathToken=${token}`,
  'files/agents/codex', 'files/agents/codex/preview?path=PRIVATE_FILE.txt', 'files/agents/codex/text',
  'files/agents/codex/download?path=PRIVATE_FILE.txt'] as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gates = new WeakMap<TestContext, Set<() => void>>();
function deferred(t: TestContext) {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  if (!gates.has(t)) gates.set(t, new Set());
  gates.get(t)!.add(resolve); t.signal.addEventListener('abort', resolve, { once: true });
  return { promise, resolve };
}

async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false) {
  const root = mkdtempSync(join(tmpdir(), 'connection-files-production-')), file = join(root, 'hub.sqlite');
  const nodeId = `node_${randomUUID()}`, connectorToken = 'PRIVATE_FILES_CONNECTOR_TOKEN';
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Files owner');
  const key = seed.identities.issueKey(member.id), second = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const foreign = seed.identities.issueKey(seed.createUser('Other owner').id);
  seed.upsertConnection({ id: 'node', ownerUserId: member.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: connectorToken });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, nodeId); await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'metadata');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const port = { command: (kind: HubMemberKind, input: never) => owner.command(kind, input) } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics),
    resolver = createAsyncConnectorClientResolver(port, undefined, diagnostics);
  const behavior: { calls: Request[]; mutations: number; sync: number; resolving?: () => void | Promise<void>;
    transport?: (request: Request, response: Response) => Response | Promise<Response>; media?: () => Response } = { calls: [], mutations: 0, sync: 0 };
  const remote = new Hono();
  remote.use('*', async (c, next) => {
    assert.equal(c.req.header('authorization'), 'Bearer ' + connectorToken);
    if (c.req.method === 'POST') behavior.mutations++;
    await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, nodeId);
  });
  remote.all('/api/connector/v1/*', async c => {
    if (c.req.path.endsWith('/download')) return behavior.media?.() ?? new Response('abc', { headers: {
      'content-type': 'text/plain', 'content-length': '3', 'set-cookie': 'PRIVATE_COOKIE', 'x-private': 'PRIVATE_HEADER',
    } });
    return c.json({ path: c.req.path, query: c.req.query(), ...(c.req.method === 'POST' ? { saved: await c.req.json() } : {}) }, c.req.method === 'POST' ? 202 : 200);
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'connector.invalid', 'isolated dispatch, no real native/network effects');
    behavior.calls.push(request); const response = await remote.fetch(request);
    return behavior.transport ? behavior.transport(request, response) : response;
  });
  let guarded = false;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) throw Error('SYNC_CONNECTION_FILES_STORE_FALLBACK'); return Reflect.get(target, property, receiver);
  } });
  const app = new Hono(), routes = registerHubRoutes(app, {
    config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store, administrative: group,
    principal: () => { behavior.sync++; return undefined; }, connectorClient: () => { throw Error('SYNC_CONNECTION_FILES_RESOLVER_FALLBACK'); },
    ...(!noResolver ? { asyncConnectorClient: async (...args: Parameters<typeof resolver>) => { await behavior.resolving?.(); return resolver(...args); } } : {}),
    normalizeError: () => 'safe',
  });
  assert.ok(routes); guarded = true;
  t.after(async () => {
    for (const release of gates.get(t) ?? []) release();
    guarded = false; delete behavior.resolving;
    try { await routes.close(); } finally { try { await group.close(); } finally { try { await resolver.close(); }
      finally { try { await owner.close(); } finally { await metadata.close(); } } } }
    for (const secret of [key.token, second.token, cookie, connectorToken, 'PRIVATE_FILE', 'PRIVATE_HEADER']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, signal?: AbortSignal) =>
    new Request('http://hub.invalid/api/hub/v1/connections/node/' + path, { method: path.endsWith('/text') ? 'POST' : 'GET', headers,
      ...(signal ? { signal } : {}), ...(path.endsWith('/text') ? { body: JSON.stringify({ path: 'PRIVATE_FILE.txt', text: 'saved', expectedHash: 'original' }) } : {}) });
  const evidence = hubMemberEvidence(request('agents')), snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const proof = { evidence, expectedScope: snapshot.recoveryScope };
  const revoke = async () => {
    const evidence = { accessKey: admin.token }, actor = await owner.command('memberSnapshot', evidence); assert.ok(actor);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: actor.recoveryScope, userId: member.id, keyId: key.id });
  };
  const change = async () => {
    const target = await owner.command('connectionTarget', { ...proof, id: 'node' }); assert.ok(target && 'epoch' in target);
    await owner.command('connectionChange', { ...proof, change: { action: 'patch', id: 'node', expectedEpoch: target.epoch, configuration: { enabled: false } } });
  };
  return { app, behavior, request, key, second, cookie, foreign, revoke, change, close: routes.close };
}

test('connection files exact middleware boundary excludes shared, control, mutation and arbitrary descendants', () => {
  for (const path of paths) assert.equal(isHubConnectionFileRequest(path.endsWith('/text') ? 'POST' : 'GET', '/api/hub/v1/connections/node/' + path.split('?')[0]), true);
  for (const suffix of ['capabilities', 'verify', 'files/git/repo/tree/extra', 'files/agents/x/text/extra', 'files/agents/x/delete'])
    assert.equal(isHubConnectionFileRequest('GET', '/api/hub/v1/connections/node/' + suffix), false);
  assert.equal(isHubConnectionFileRequest('DELETE', '/api/hub/v1/connections/node/files/roots'), false);
  assert.equal(isHubConnectionFileRequest('GET', '/api/hub/v1/shared/grant/connections/node/agents'), false);
});
for (const mode of ['original', 'worker'] as const) {
  test(`${mode} source-directory hint crosses only the authenticated listing route`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), source = '/workspace/src/changed file.ts';
    const response = await f.app.fetch(f.request(`files/agents/codex?sourcePath=${encodeURIComponent(source)}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).query, { path: '', sourcePath: source });
    const preview = await f.app.fetch(f.request(`files/agents/codex/preview?path=README.md&sourcePath=${encodeURIComponent(source)}`));
    assert.equal(preview.status, 200);
    assert.deepEqual((await preview.json()).query, { path: 'README.md' });
    assert.equal(f.behavior.mutations, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} connection files twelve entries preserve Key/Cookie, query, text status and bounded download wire`, { timeout: 30000 }, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { 'x-agentopsdeck-key': f.second.token },
      { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      for (const path of paths) {
        const response = await f.app.fetch(f.request(path, headers)); assert.equal(response.status, path.endsWith('/text') ? 202 : 200, await response.clone().text());
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (path.includes('/download')) { assert.equal(await response.text(), 'abc'); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-private'), null); }
        else {
          const body = await response.json(); assert.equal(body.path, '/api/connector/v1/' + path.split('?')[0]);
          assert.deepEqual(body.query, path === 'files/agents/codex' ? { path: '' } : Object.fromEntries(new URLSearchParams(path.split('?')[1])));
          if (path.endsWith('/text')) assert.equal(body.saved.expectedHash, 'original');
        }
      }
    }
    assert.equal(f.behavior.sync, 0); assert.equal(f.behavior.mutations, 4);
    const head = new Request(f.request('agents'), { method: 'HEAD' });
    assert.equal((await f.app.fetch(head)).status, 200); assert.equal(f.behavior.calls.at(-1)!.method, 'GET');
  });
  test(`${mode} connection files rejects foreign owner, scope and original pin without dispatch`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const path of paths) {
      assert.equal((await f.app.fetch(f.request(path, { 'x-agentopsdeck-key': f.foreign.token }))).status, 404);
      assert.equal((await f.app.fetch(f.request(path, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'foreign' }))).status, 409);
      const request = f.request(path); pinOriginalRequestScope(request, 'foreign'); assert.equal((await f.app.fetch(request)).status, 401);
    }
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} connection files missing async resolver fails closed for twelve entries`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode, true);
    for (const path of paths) assert.equal((await f.app.fetch(f.request(path))).status, 503);
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} text upload authenticates original streamed Request before consuming its body`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const kind of ['key', 'scope', 'pin'] as const) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({ pull() { pulled++; throw Error('UNAUTHORIZED_BODY_READ'); } }, { highWaterMark: 0 });
      const headers = { 'x-agentopsdeck-key': kind === 'key' ? 'invalid' : f.key.token,
        ...(kind === 'scope' ? { 'x-agentopsdeck-recovery-scope': 'foreign' } : {}) };
      const request = new Request(f.request('files/agents/codex/text').url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
      if (kind === 'pin') pinOriginalRequestScope(request, 'foreign');
      assert.equal((await f.app.fetch(request)).status, kind === 'scope' ? 409 : 401);
      assert.equal(pulled, 0); await body.cancel();
    }
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} text upload bounds UTF8 bytes independent of Content-Length and preserves 413 wire`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), limit = 2 * 1024 * 1024;
    for (const length of [undefined, '1', String(limit + 1)]) {
      let pulled = 0, cancelled = 0;
      const bytes = new TextEncoder().encode(JSON.stringify({ text: '界'.repeat(Math.floor(limit / 3)) }));
      const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(bytes); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
      const headers = { 'x-agentopsdeck-key': f.key.token, ...(length ? { 'content-length': length } : {}) };
      const request = new Request(f.request('files/agents/codex/text').url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
      const response = await f.app.fetch(request); assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: 'Text write too large' });
      assert.equal(cancelled, 1); assert.equal(pulled, length === String(limit + 1) ? 0 : 1);
    }
    // Exactly the byte limit is not rejected as oversized (invalid JSON is 400).
    const base = f.request('files/agents/codex/text');
    assert.equal((await f.app.fetch(new Request(base.url, { method: 'POST', headers: base.headers, body: ' '.repeat(limit) }))).status, 400);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} text upload decodes multibyte chunks and forwards the original save once`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), bytes = new TextEncoder().encode(JSON.stringify({ text: '界🙂' }));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }, { highWaterMark: 0 });
    const base = f.request('files/agents/codex/text');
    const response = await f.app.fetch(new Request(base.url, { method: 'POST', headers: base.headers, body, duplex: 'half' } as RequestInit));
    assert.equal(response.status, 202); assert.deepEqual((await response.json()).saved, { text: '界🙂' });
    assert.equal(f.behavior.calls.length, 1);
  });
  for (const reason of ['abort', 'close', 'oversize'] as const) {
    test(`${mode} text upload ${reason} retains original reader cancellation ACK without dispatch`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode), reading = deferred(t), cancelling = deferred(t), ack = deferred(t);
      const abort = new AbortController(); let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) { reading.resolve(); if (reason === 'oversize') c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
        async cancel() { cancelled++; cancelling.resolve(); await ack.promise; },
      }, { highWaterMark: 0 });
      const base = f.request('files/agents/codex/text');
      let delivered = false, closed = false;
      const response = Promise.resolve(f.app.fetch(new Request(base.url, { method: 'POST', headers: base.headers, body,
        signal: abort.signal, duplex: 'half' } as RequestInit))).then(r => { delivered = true; return r; });
      let closing: Promise<void> | undefined;
      try {
        await reading.promise;
        if (reason === 'abort') abort.abort();
        if (reason === 'close') closing = f.close().then(() => { closed = true; });
        await cancelling.promise; await tick(); assert.equal(delivered, false);
        if (!closing) closing = f.close().then(() => { closed = true; });
        await tick(); assert.equal(closed, false); ack.resolve();
        // Closing freezes delivery even when the initial cause was 413/abort.
        assert.equal((await response).status, 503); await closing;
        assert.equal(cancelled, 1); assert.equal(f.behavior.calls.length, 0);
      } finally { ack.resolve(); }
    });
  }
  for (const path of paths) {
    test(`${mode} connection files ${path} resolver revocation blocks dispatch`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); f.behavior.resolving = f.revoke;
      assert.equal((await f.app.fetch(f.request(path))).status, 401); assert.equal(f.behavior.calls.length, 0);
    });
    test(`${mode} connection files ${path} original response epoch change blocks delivery`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); f.behavior.transport = async (_request, response) => { await f.change(); return response; };
      assert.equal((await f.app.fetch(f.request(path))).status, 403); assert.equal(f.behavior.calls.length, 1);
    });
  }
  test(`${mode} connection files validates query, IDs and JSON before dispatch`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const path of ['models/hermes', 'issues/invalid!/items', 'issues/source/items?state=bad', 'issues/source/items?kind=other',
      'issues/source/items?cursor=bad', 'issues/source/items?state=open&state=closed', 'files/git/repo/preview',
      'files/git/repo/tree?cursor=bad', 'files/git/repo/tree?extra=x', 'files/agents/invalid!/preview']) assert.equal((await f.app.fetch(f.request(path))).status, 400);
    const request = f.request('files/agents/codex/text');
    assert.equal((await f.app.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: 'bad' }))).status, 400);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} connection text lost ACK does not replay or claim success`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode); f.behavior.transport = () => { throw Error('PRIVATE_UNKNOWN_SAVE_RESULT'); };
    assert.notEqual((await f.app.fetch(f.request('files/agents/codex/text'))).status, 202);
    assert.equal(f.behavior.calls.length, 1); assert.equal(f.behavior.mutations, 1);
  });
  for (const path of ['agents', 'files/agents/codex/text', 'files/agents/codex/download'] as const) {
    test(`${mode} connection files ${path} close drains late dispatch and source cancel ACK`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode), entered = deferred(t), release = deferred(t), cancelling = deferred(t), ack = deferred(t);
      const abort = new AbortController(); let cancelled = 0;
      f.behavior.transport = async (_request, response) => {
        await response.body?.cancel(); entered.resolve(); await release.promise;
        return new Response(new ReadableStream({ async cancel() { cancelled++; cancelling.resolve(); await ack.promise; } }, { highWaterMark: 0 }), { headers: response.headers });
      };
      try {
        const response = f.app.fetch(f.request(path, undefined, abort.signal)); await entered.promise; abort.abort();
        let closed = false; const closing = f.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
        release.resolve(); await cancelling.promise; await tick(); assert.equal(closed, false); ack.resolve();
        assert.equal((await response).status, 503); await closing; assert.equal(cancelled, 1); assert.equal(f.behavior.calls.length, 1);
      } finally { release.resolve(); ack.resolve(); }
    });
  }
  test(`${mode} connection files close retains original resolver ACK and never dispatches after shutdown`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), entered = deferred(t), release = deferred(t);
    f.behavior.resolving = async () => { entered.resolve(); await release.promise; };
    const running = f.app.fetch(f.request('agents'));
    try {
      await entered.promise;
      let drained = false;
      const closing = f.close().then(() => { drained = true; });
      await tick(); assert.equal(drained, false);
      release.resolve();
      assert.equal((await running).status, 503);
      await closing;
      assert.equal(drained, true);
      assert.equal(f.behavior.calls.length, 0);
    } finally { release.resolve(); }
  });
  test(`${mode} connection download close retains unconsumed source cancellation ACK`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), cancelling = deferred(t), ack = deferred(t);
    f.behavior.media = () => new Response(new ReadableStream({ async cancel() { cancelling.resolve(); await ack.promise; } }, { highWaterMark: 0 }));
    const response = await f.app.fetch(f.request('files/agents/codex/download')); assert.equal(response.status, 200);
    try {
      let closed = false; const closing = f.close().then(() => { closed = true; }); await cancelling.promise; await tick(); assert.equal(closed, false);
      ack.resolve(); await closing; await assert.rejects(response.text());
    } finally { ack.resolve(); }
  });
}
