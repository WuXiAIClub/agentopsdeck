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
  if (!gates.has(t)) gates.set(t, new Set());
  gates.get(t)!.add(resolve); t.signal.addEventListener('abort', resolve, { once: true });
  return { promise, resolve };
}
const remoteSession = 'hermes:PRIVATE_AUXILIARY', jobId = '12345678-1234-1234-1234-123456789abc';
const operations = ['interactions', 'mode', 'answer', 'skills', 'files', 'start', 'step', 'cancel'] as const;
type Operation = typeof operations[number];
const mutations: Operation[] = ['mode', 'answer', 'start', 'step', 'cancel'];

async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false) {
  const root = mkdtempSync(join(tmpdir(), 'session-auxiliary-production-')), file = join(root, 'hub.sqlite');
  const nodeId = `node_${randomUUID()}`, connectorToken = 'PRIVATE_AUXILIARY_CONNECTOR_TOKEN';
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Auxiliary owner');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const secondKey = seed.identities.issueKey(member.id), foreignKey = seed.identities.issueKey(seed.createUser('Other owner').id);
  seed.upsertConnection({ id: 'node', ownerUserId: member.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: connectorToken });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, nodeId);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'metadata');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: {
    resolving?: () => void | Promise<void>;
    transport?: (request: Request, response: Response) => Response | Promise<Response>;
    calls: Request[]; mutations: number; sync: number;
  } = { calls: [], mutations: 0, sync: 0 };
  const port = { command: (kind: HubMemberKind, input: never) => owner.command(kind, input) } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics),
    resolver = createAsyncConnectorClientResolver(port, undefined, diagnostics);
  const view = { request: { version: 1, ownerId: member.id, nodeId, sessionKey: remoteSession, runId: 'run1', requestId: 'req1', kind: 'approval',
    prompt: 'PRIVATE_AUXILIARY_PROMPT', createdAt: 1, expiresAt: 2 }, revision: 1, status: 'pending', delivery: 'none' };
  const snapshot = { version: 1, mode: 'interactive', capabilities: { version: 1, kinds: ['approval'], modes: ['automatic', 'interactive'] }, requests: [view] };
  const page = { entries: [{ path: '/workspace/PRIVATE_FILE.txt', kind: 'modified', messageId: 'm1', createdAt: 1,
    media: { url: 'https://evil.invalid' } }], generation: 'generation1', revision: 1, coverage: 'partial', source: 'durable-events', limited: false, rebuildAvailable: true };
  const progress = { id: jobId, step: 1, state: 'scanning', scanned: 1, bytes: 1, found: 1, limited: false };
  const remote = new Hono();
  remote.use('*', async (c, next) => {
    assert.equal(c.req.header('authorization'), 'Bearer ' + connectorToken);
    if (!['GET', 'HEAD'].includes(c.req.method)) behavior.mutations++;
    await next();
    c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, nodeId);
  });
  const base = '/api/connector/v1/sessions/:session';
  remote.get(base + '/interactions', c => c.json(snapshot));
  remote.patch(base + '/interaction-mode', async c => c.json(await c.req.json()));
  remote.post(base + '/interactions/:request/answer', c => c.json({ ...view, status: 'answered', delivery: 'confirmed' }));
  remote.get(base + '/skills', c => c.json({ skills: [{ name: 'fixture', description: 'safe', scope: 'user', enabled: true }],
    observedAt: 1, limited: false, discoveryErrors: 0, usage: 'unknown' }));
  remote.get(base + '/files', c => c.json(page));
  remote.post(base + '/files/rebuild', c => c.json(progress));
  remote.post(base + '/files/rebuild/:jobId', c => c.json(progress));
  remote.delete(base + '/files/rebuild/:jobId', c => c.json({ ...progress, state: 'cancelled' }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'connector.invalid', 'no real network/native effects');
    behavior.calls.push(request); const response = await remote.fetch(request);
    return behavior.transport ? behavior.transport(request, response) : response;
  });
  let guarded = false;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) throw Error('SYNC_AUXILIARY_STORE_FALLBACK'); return Reflect.get(target, property, receiver);
  } });
  const app = new Hono(), routes = registerHubRoutes(app, {
    config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store, administrative: group,
    principal: () => { behavior.sync++; return undefined; }, connectorClient: () => { throw Error('SYNC_AUXILIARY_RESOLVER_FALLBACK'); },
    ...(!noResolver ? { asyncConnectorClient: async (...args: Parameters<typeof resolver>) => { await behavior.resolving?.(); return resolver(...args); } } : {}),
    normalizeError: () => 'safe',
  });
  assert.ok(routes); guarded = true;
  t.after(async () => {
    for (const release of gates.get(t) ?? []) release();
    guarded = false; delete behavior.resolving;
    try { await routes.close(); }
    finally { try { await group.close(); } finally { try { await resolver.close(); }
      finally { try { await owner.close(); } finally { await metadata.close(); } } } }
    for (const secret of [key.token, secondKey.token, cookie, connectorToken, 'PRIVATE_AUXILIARY_PROMPT', 'PRIVATE_AUXILIARY', 'PRIVATE_FILE'])
      assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const id = encodeHubSessionId('node', remoteSession), url = '/api/hub/v1/sessions/' + encodeURIComponent(id);
  const suffix: Record<Operation, string> = { interactions: '/interactions', mode: '/interaction-mode', answer: '/interactions/req1/answer',
    skills: '/skills', files: '/files', start: '/files/rebuild', step: '/files/rebuild/' + jobId, cancel: '/files/rebuild/' + jobId };
  const request = (op: Operation, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, signal?: AbortSignal) =>
    new Request('http://hub.invalid' + url + suffix[op], { method: op === 'mode' ? 'PATCH' : op === 'cancel' ? 'DELETE' : mutations.includes(op) ? 'POST' : 'GET',
      headers, ...(signal ? { signal } : {}), ...(op === 'mode' ? { body: JSON.stringify({ mode: 'interactive' }) }
        : op === 'answer' ? { body: JSON.stringify({ runId: 'run1', responseId: 'response1', expectedRevision: 1, answer: { kind: 'approval', decision: 'allow-once' } }) }
        : op === 'step' ? { body: JSON.stringify({ step: 0 }) } : {}) });
  const evidence = hubMemberEvidence(request('files')), snapshotProof = await owner.command('memberSnapshot', evidence); assert.ok(snapshotProof);
  const proof = { evidence, expectedScope: snapshotProof.recoveryScope };
  const revoke = async () => {
    const evidence = { accessKey: admin.token }, actor = await owner.command('memberSnapshot', evidence); assert.ok(actor);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: actor.recoveryScope, userId: member.id, keyId: key.id });
  };
  const change = async () => {
    const target = await owner.command('connectionTarget', { ...proof, id: 'node' }); assert.ok(target && 'epoch' in target);
    await owner.command('connectionChange', { ...proof, change: { action: 'patch', id: 'node', expectedEpoch: target.epoch, configuration: { enabled: false } } });
  };
  return { app, request, behavior, key, secondKey, cookie, foreignKey, revoke, change, view, page, url, close: routes.close };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} auxiliary eight-entry production chain preserves Key/Cookie and sanitized wire`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { 'x-agentopsdeck-key': f.secondKey.token },
      { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      for (const op of operations) {
        const response = await f.app.fetch(f.request(op, headers)); assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get('cache-control'), 'no-store'); const body = await response.json();
        if (op === 'files') { assert.equal(body.entries[0].media.url.includes('evil.invalid'), false); assert.match(body.entries[0].media.url, /^\/api\/hub\/v1\/sessions\//); }
        if (op === 'answer') assert.equal(body.delivery, 'confirmed');
        if (op === 'mode') assert.deepEqual(body, { mode: 'interactive' });
      }
    }
    assert.equal(f.behavior.sync, 0); assert.equal(f.behavior.mutations, mutations.length * 4);
  });
  test(`${mode} auxiliary rejects foreign owner, scope and private original pin without dispatch`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const op of operations) {
      assert.equal((await f.app.fetch(f.request(op, { 'x-agentopsdeck-key': f.foreignKey.token }))).status, 404);
      assert.equal((await f.app.fetch(f.request(op, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'foreign' }))).status, 409);
      const request = f.request(op); pinOriginalRequestScope(request, 'foreign');
      assert.equal((await f.app.fetch(request)).status, 401);
    }
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} auxiliary missing resolver fails closed for all eight entries`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode, true);
    for (const op of operations) assert.equal((await f.app.fetch(f.request(op))).status, 503);
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  for (const op of operations) {
    test(`${mode} auxiliary ${op} rejects resolver-time revocation without effect`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); f.behavior.resolving = f.revoke;
      assert.equal((await f.app.fetch(f.request(op))).status, 401); assert.equal(f.behavior.calls.length, 0);
    });
    test(`${mode} auxiliary ${op} rejects response-time epoch change`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); f.behavior.transport = async (_request, response) => { await f.change(); return response; };
      assert.equal((await f.app.fetch(f.request(op))).status, 403); assert.equal(f.behavior.calls.length, 1);
    });
  }
  test(`${mode} auxiliary validates upstream schemas and binds interaction identities`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    for (const op of operations) {
      f.behavior.transport = async (_request, response) => { await response.body?.cancel(); return Response.json({}, { headers: response.headers }); };
      assert.equal((await f.app.fetch(f.request(op))).status, 502);
    }
    for (const field of ['sessionKey', 'nodeId', 'requestId', 'runId'] as const) {
      f.behavior.transport = async (_request, response) => { await response.body?.cancel(); return Response.json({ ...f.view,
        request: { ...f.view.request, [field]: 'foreign' }, status: 'answered', delivery: 'confirmed' }, { headers: response.headers }); };
      assert.equal((await f.app.fetch(f.request('answer'))).status, 502);
    }
  });
  test(`${mode} auxiliary input limits do not dispatch remote work`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode);
    const cases: Array<[string, string, unknown]> = [['/interaction-mode', 'PATCH', { mode: 'invalid' }],
      ['/interactions/req1/answer', 'POST', { runId: 'run1' }], ['/files?cursor=', 'GET', undefined],
      ['/files/rebuild/invalid', 'DELETE', undefined], ['/files/rebuild/' + jobId, 'POST', { step: 10001 }]];
    for (const [suffix, method, body] of cases) {
      const response = await f.app.fetch(new Request('http://hub.invalid' + f.url + suffix, { method, headers: { 'x-agentopsdeck-key': f.key.token },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
      assert.equal(response.status, 400);
    }
    assert.equal(f.behavior.calls.length, 0);
  });
  for (const op of mutations) {
    test(`${mode} auxiliary ${op} lost ACK is not replayed or confirmed`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); f.behavior.transport = () => { throw Error('PRIVATE_UNKNOWN_REMOTE_RESULT'); };
      assert.notEqual((await f.app.fetch(f.request(op))).status, 200);
      assert.equal(f.behavior.mutations, 1); assert.equal(f.behavior.calls.length, 1);
    });
  }
  for (const op of ['interactions', 'answer', 'start', 'step', 'cancel'] as const) {
    test(`${mode} auxiliary ${op} close drains late dispatch and cancel ACK without delivery`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode), entered = deferred(t), release = deferred(t), cancelling = deferred(t), cancelAck = deferred(t);
      const abort = new AbortController(); let cancelled = 0;
      f.behavior.transport = async (_request, response) => {
        await response.body?.cancel(); entered.resolve(); await release.promise;
        return new Response(new ReadableStream({ async cancel() { cancelled++; cancelling.resolve(); await cancelAck.promise; } }, { highWaterMark: 0 }), { headers: response.headers });
      };
      try {
        const response = f.app.fetch(f.request(op, undefined, abort.signal)); await entered.promise; abort.abort();
        let closed = false; const closing = f.close().then(() => { closed = true; });
        await tick(); assert.equal(closed, false); release.resolve(); await cancelling.promise;
        await tick(); assert.equal(closed, false); cancelAck.resolve();
        assert.equal((await response).status, 503); await closing;
        assert.equal(cancelled, 1); assert.equal(f.behavior.calls.length, 1);
        assert.equal((await f.app.fetch(f.request('files'))).status, 503);
      } finally { release.resolve(); cancelAck.resolve(); }
    });
  }
}
