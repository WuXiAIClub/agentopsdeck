import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, DEFAULT_HUB_NOTEBOOK_LAYOUT } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { registerHubRoutes } from '../routes/hub.js';
import { registerAsyncHubRoutes } from '../routes/hub-async.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { WeixinService } from './weixin-service.js';
import { registerAsyncHubDiscovery, isAsyncHubDiscoveryRequest } from '../routes/hub-discovery-async.js';
import { encodeHubSessionId } from './session-id.js';
import { loadConfig } from '../config.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const base = '/api/hub/v1';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

/** Both real authority implementations, real Connector transport, exact parent
 * delegation and isolated original files. Never opens application/live state. */
async function fixture(t: TestContext, mode: 'original' | 'worker', parent: boolean | 'async' = false, requestBytes?: number, connectionCount = 1, largeLayout = false) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-production-')), file = join(root, 'hub.sqlite');
  const node = 'node_' + randomUUID(), foreignNode = 'node_' + randomUUID(), native = randomUUID(), remoteKey = 'codex:' + native;
  const sessionKey = encodeHubSessionId('dev', remoteKey);
  const seed = new HubStore(file, 'discovery-fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Member'), other = seed.createUser('PRIVATE_OTHER');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const scope = seed.identities.recoveryScope({ userId: member.id, admin: false });
  const hubId = seed.identities.hubId;
  if (largeLayout) {
    seed.workspace.save(member.id, { revision: 0, groups: [{ id: 'large', name: 'Large layout', collapsed: false }],
      sessions: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`session-${index}`, { groupId: 'large', order: index }])) });
    for (let index = 0; index < 100; index++) seed.notebooks.save(member.id, {
      resourceId: JSON.stringify(['hub-notebook-layout', 1, 'note-' + index]), revision: 0,
      text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Note ' + index }),
    });
    seed.notebooks.save(member.id, { resourceId: JSON.stringify(['hub-notebook', 1]), revision: 0, text: 'N'.repeat(50_000) });
    seed.notebooks.saveArchive(member.id, { resourceId: JSON.stringify(['hub-notebook', 1]), revision: 0, text: 'A'.repeat(100_000) });
  }
  seed.upsertConnection({ id: 'dev', ownerUserId: member.id, label: 'Dev', connectorUrl: 'http://discovery-connector.invalid', credentialToken: 'PRIVATE_CONNECTOR_TOKEN' });
  // Deliberately collide connection/native session IDs across owners. Filtering
  // by a friendly ID alone must not select the other Connector or preferences.
  seed.upsertConnection({ id: 'dev', ownerUserId: other.id, label: 'PRIVATE_FOREIGN', connectorUrl: 'http://discovery-connector.invalid', credentialToken: 'PRIVATE_OTHER_TOKEN' });
  seed.pinConnectionNode('dev', other.id, seed.connectionAuthority('dev', other.id)!, foreignNode);
  for (const field of ['hidden','archived','pinned'] as const) seed.setSessionPreference(sessionKey,field,true,other.id);
  seed.pinConnectionNode('dev', member.id, seed.connectionAuthority('dev', member.id)!, node);
  for (let index = 1; index < connectionCount; index++) {
    const id = `dev-${index}`;
    seed.upsertConnection({ id, ownerUserId: member.id, label: id, connectorUrl: 'http://discovery-connector.invalid', credentialToken: 'PRIVATE_CONNECTOR_TOKEN' });
    seed.pinConnectionNode(id, member.id, seed.connectionAuthority(id, member.id)!, node);
  }
  await seed.close();
  const behavior: { reads: number; sync: number; resolving?: () => Promise<void>; transport?: () => Promise<void> } = { reads: 0, sync: 0 };
  t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
    const request = raw instanceof Request ? raw : new Request(raw, init), url = new URL(request.url);
    assert.equal(url.origin, 'http://discovery-connector.invalid');
    assert.equal(url.pathname, '/api/connector/v1/sessions/state'); assert.equal(request.method, 'GET');
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
    assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_CONNECTOR_TOKEN');
    behavior.reads++; await behavior.transport?.();
    return Response.json({ groups: [{ agentId: 'codex', sessions: [
      { sessionKey: remoteKey, agentId: 'codex', title: 'Existing session', status: 'idle', lastActiveAt: 7 },
    ] }] }, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node } });
  });
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  t.mock.method(WeixinService.prototype, 'startWorker', () => {});
  const mount = async () => {
    const metadata = new HubStore(mode === 'original' ? file : join(root, 'metadata.sqlite'), 'discovery-fixture');
    const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata, diagnostics)
      : new AsyncHubMemberOwner({ file, encryptionSecret: 'discovery-fixture' }, diagnostics);
    const services = createHubAdministrativeServices(owner, diagnostics), reads = createHubConnectorReadServices(owner, undefined, diagnostics), resolver = reads.connector;
    const asyncConnectorClient: typeof resolver = Object.assign(async (...args: Parameters<typeof resolver>) => {
      await behavior.resolving?.(); return resolver(...args);
    }, { ...resolver, close: () => resolver.close() });
    let guarded = false;
    const store = new Proxy(metadata, { get(target, property, receiver) {
      if (guarded) { behavior.sync++; throw Error('SYNCHRONOUS_DISCOVERY_BYPASS'); }
      return Reflect.get(target, property, receiver);
    } });
    const app = new Hono(), routes = parent === 'async' ? await registerAsyncHubRoutes(app, {
      config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubId, administrative: services,
      reads: { ...reads, connector: asyncConnectorClient }, eventFeed: () => { throw Error('NO_EVENT_SUBSCRIPTION'); }, normalizeError: () => 'unavailable',
      ...(requestBytes === undefined ? {} : { sessionStateResponseLimits: { requestBytes, retainedBytes: 128 * 1024 * 1024 } }),
    }) : parent ? registerHubRoutes(app, {
      config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
      administrative: services, asyncConnectorClient,
      principal: () => { behavior.sync++; throw Error('SYNCHRONOUS_PRINCIPAL_BYPASS'); },
      connectorClient: () => { behavior.sync++; throw Error('SYNCHRONOUS_CONNECTOR_BYPASS'); }, normalizeError: () => 'unavailable',
      ...(requestBytes === undefined ? {} : { sessionStateResponseLimits: { requestBytes, retainedBytes: 128 * 1024 * 1024 } }),
    }) : registerAsyncHubDiscovery(app, { mode: 'async', access: services.createDiscoveryAccess(), asyncConnectorClient,
      info: { service: 'agentopsdeck-hub' }, ...(requestBytes === undefined ? {} : { responseLimits: { requestBytes } }) });
    assert.ok(routes); if ('activate' in routes && typeof routes.activate === 'function') await routes.activate(); guarded = true;
    return { app, owner, close: () => routes.close(), dispose: async () => {
      guarded = false; await routes.close(); await services.close(); await reads.close(); await owner.close(); await metadata.close();
    } };
  };
  let current = await mount();
  t.after(async () => {
    await current.dispose(); assert.equal(behavior.sync, 0);
    for (const secret of [key.token, cookie, 'PRIVATE_CONNECTOR_TOKEN', 'PRIVATE_OTHER']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const proof = async (token = admin.token) => {
    const evidence = { accessKey: token }, snapshot = await current.owner.command('memberSnapshot', evidence);
    assert.ok(snapshot); return { evidence, expectedScope: snapshot.recoveryScope };
  };
  const request = (path: string, options: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal; pin?: string } = {}) => {
    const raw = new Request('http://hub.invalid' + path, {
      method: options.method ?? 'GET', headers: options.headers ?? { 'x-agentopsdeck-key': key.token },
      ...(options.body === undefined ? {} : { body: options.body }), ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.pin !== undefined) pinOriginalRequestScope(raw, options.pin);
    return current.app.fetch(raw);
  };
  const preference = async (field: 'hidden' | 'archived' | 'pinned', value: boolean) => current.owner.command('sessionPreferenceSet', {
    ...await proof(key.token), change: { sessionKey, field, value },
  });
  return { behavior, request, sessionKey, remoteKey, native, node, foreignNode, scope, key, cookie, member, preference,
    revoke: async () => { assert.deepEqual(await current.owner.command('memberKeyRevoke', { ...await proof(), userId: member.id, keyId: key.id }), { ok: true }); },
    close: () => current.close(), reopen: async () => { await current.dispose(); current = await mount(); },
  };
}

async function json(response: Response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
  assert.doesNotMatch(text, /PRIVATE_|credentialToken|authority_version/);
  return JSON.parse(text);
}

test('large layout: real async HTTP routes serve concurrent sessions, 100 notebooks and full archive across restart', async t => {
  const f = await fixture(t, 'worker', 'async', undefined, 1, true);
  for (let round = 0; round < 3; round++) {
    const paths = [
      ...Array<string>(6).fill('/sessions/state'), ...Array<string>(8).fill('/notebooks'),
      ...Array<string>(8).fill('/notebooks/default'), ...Array<string>(8).fill('/notebooks/default/archive'),
      ...Array<string>(4).fill('/workspace/preferences'),
    ];
    const responses = await Promise.all(paths.map(async path => ({ path, body: await json(await f.request(base + path)) })));
    for (const { path, body } of responses) {
      if (path === '/sessions/state') assert.equal(body.sourceStates[0].state, 'ready');
      if (path === '/notebooks') assert.equal(body.items.length, 101);
      if (path === '/notebooks/default') assert.equal(body.text, 'N'.repeat(50_000));
      if (path === '/notebooks/default/archive') assert.equal(body.text, 'A'.repeat(100_000));
      if (path === '/workspace/preferences') assert.equal(Object.keys(body.sessions).length, 2000);
    }
    if (round === 1) await f.reopen();
  }
});

for (const mode of ['original', 'worker'] as const) for (const count of [2, 4, 5, 9]) {
  test(`discovery ${mode}: async parent drains ${count} connections exactly once across authority waits`, async t => {
    const f = await fixture(t, mode, 'async', undefined, count);
    f.behavior.resolving = tick;
    f.behavior.transport = tick;
    for (let round = 0; round < 2; round++) {
      const state = await json(await f.request(base + '/sessions/state'));
      assert.equal(state.sourceStates.length, count);
      assert.deepEqual(state.sourceStates.map((source: { connectionId: string }) => source.connectionId).sort(),
        Array.from({ length: count }, (_, index) => index === 0 ? 'dev' : `dev-${index}`).sort());
      assert.ok(state.sourceStates.every((source: { state: string }) => source.state === 'ready'));
      assert.equal(f.behavior.reads, count * (round + 1));
      assert.equal(state.groups.flatMap((group: { sessions: unknown[] }) => group.sessions).length, count);
      if (round === 0) await f.reopen();
    }
  });
}

for (const mode of ['original', 'worker'] as const) for (const parent of [false, true, 'async'] as const) {
  test(`discovery ${mode}/parent=${parent}: complete reads, original credentials and preference saves survive reopen`, async t => {
    const f = await fixture(t, mode, parent);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }, { authorization: 'Bearer ' + f.key.token }]) {
      assert.deepEqual(await json(await f.request(base + '/me', { headers })), { userId: f.member.id, admin: false });
      assert.equal((await json(await f.request(base + '/info', { headers }))).service, 'agentopsdeck-hub');
      assert.deepEqual((await json(await f.request(base + '/users', { headers }))).users.map((u: { id: string }) => u.id), [f.member.id]);
      assert.deepEqual((await json(await f.request(base + '/connections', { headers }))).connections.map((c: { id: string }) => c.id), ['dev']);
    }
    const ref = base + '/session-reference?nodeId=' + f.node + '&runtimeId=codex&nativeSessionKey=' + f.native;
    assert.equal((await json(await f.request(ref))).sessionKey, f.sessionKey);
    await json(await f.request(ref.replace(f.node,f.foreignNode)),404);
    await json(await f.request(ref.replace('runtimeId=codex', 'runtimeId=invalid')), 400);
    await json(await f.request(ref.replace(f.node, 'node_' + randomUUID())), 404);
    const initial = await json(await f.request(base + '/sessions/state'));
    assert.equal(initial.groups[0].sessions[0].hubSessionId, f.sessionKey); assert.equal(initial.hiddenCount, 0);
    assert.equal(initial.archivedCount,0);assert.equal(initial.pinnedCount,0,'same-ID foreign preferences must not bleed');
    assert.equal((await json(await f.request(base + '/sessions/state'))).revision, initial.revision, 'same original view revision');
    for (const [suffix, field, body] of [['visibility', 'hidden', '{'], ['archive', 'archived', 'null'], ['pin', 'pinned', '{}']] as const) {
      const saved = await json(await f.request('/api/sessions/' + f.sessionKey + '/' + suffix, { method: 'PATCH', body }));
      assert.equal(saved[field], true); assert.equal(saved.sessionKey, f.sessionKey);
    }
    let state = await json(await f.request(base + '/sessions/state'));
    assert.deepEqual(state.groups, []); assert.equal(state.hiddenCount, 1); assert.equal(state.archivedCount, 1); assert.equal(state.pinnedCount, 1);
    state = await json(await f.request(base + '/sessions/state?includeHidden=true&includeArchived=1'));
    assert.equal(state.groups[0].sessions[0].pinned, true); assert.notEqual(state.revision, initial.revision);
    await f.reopen(); state = await json(await f.request(base + '/sessions/state?includeHidden=1&includeArchived=1'));
    assert.equal(state.groups[0].sessions[0].hidden, true); assert.equal(state.groups[0].sessions[0].archived, true);
    await json(await f.request('/api/sessions/' + f.sessionKey + '/visibility', { method: 'PATCH', body: '{"hidden":false}' }));
    state = await json(await f.request(base + '/sessions/state?includeArchived=1'));
    assert.equal(state.groups[0].sessions[0].hidden, false); assert.equal(state.hiddenCount, 0);
  });

  test(`discovery ${mode}/parent=${parent}: header scope conflict and private original pin never produce effects`, async t => {
    const f = await fixture(t, mode, parent);
    for (const path of [base + '/me', base + '/sessions/state', '/api/sessions/' + f.sessionKey + '/visibility']) {
      const method = path.endsWith('/visibility') ? 'PATCH' : 'GET';
      await json(await f.request(path, { method, headers: { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'old-scope' } }), 409);
      await json(await f.request(path, { method, pin: '0'.repeat(64) }), 401);
    }
    assert.equal(f.behavior.reads, 0);
    const state = await json(await f.request(base + '/sessions/state', { headers: { cookie: 'agentopsdeck_session=' + f.cookie, 'x-agentopsdeck-recovery-scope': f.scope } }));
    assert.equal(state.hiddenCount, 0);
    await json(await f.request(base + '/users', { headers: { cookie: 'agentopsdeck_session=' + f.cookie, 'x-agentopsdeck-key': 'hub_key_explicit-invalid-key' } }), 401);
  });

  for (const boundary of ['resolver', 'transport'] as const) test(`discovery ${mode}/parent=${parent}: ${boundary} revoke/error is denied without fallback or replay`, async t => {
    const f = await fixture(t, mode, parent);
    f.behavior[boundary === 'resolver' ? 'resolving' : 'transport'] = async () => { await f.revoke(); throw Error('PRIVATE_FAILURE'); };
    await json(await f.request(base + '/sessions/state'), 401);
    assert.equal(f.behavior.reads, boundary === 'resolver' ? 0 : 1);
    await json(await f.request(base + '/connections'), 401);
  });

  for (const boundary of ['resolver', 'transport'] as const) test(`discovery ${mode}/parent=${parent}: close drains original ${boundary} ignoring abort`, async t => {
    const f = await fixture(t, mode, parent), entered = deferred(), release = deferred(), abort = new AbortController();
    f.behavior[boundary === 'resolver' ? 'resolving' : 'transport'] = async () => { entered.resolve(); await release.promise; };
    const pending = f.request(base + '/sessions/state', { signal: abort.signal }); await entered.promise; abort.abort();
    let closed = false; const closing = f.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false, 'original network work still owns the request');
    release.resolve(); await json(await pending, 503); await closing; assert.equal(closed, true);
    assert.equal(f.behavior.reads, boundary === 'resolver' ? 0 : 1);
    await json(await f.request(base + '/users'), 503);
  });

  test(`discovery ${mode}/parent=${parent}: preferences changing during original network wait are never exposed`, async t => {
    const f = await fixture(t, mode, parent);
    f.behavior.transport = async () => { assert.deepEqual(await f.preference('hidden', true), { ok: true }); };
    const state = await json(await f.request(base + '/sessions/state'));
    assert.deepEqual(state.groups, []); assert.equal(state.hiddenCount, 1); assert.equal(f.behavior.reads, 1);
  });
}

for (const mode of ['original', 'worker'] as const) test(`discovery ${mode}: aggregate byte refusal retains original work and returns original busy payload`, async t => {
  const f = await fixture(t, mode, false, 32);
  assert.deepEqual(await json(await f.request(base + '/sessions/state'), 503), { error: 'hub_session_response_busy' });
  assert.equal(f.behavior.reads, 1);
});

test('discovery exact route selection never delegates unknown methods, aliases or noncanonical session keys', () => {
  const key = encodeHubSessionId('dev', 'codex:existing');
  assert.equal(isAsyncHubDiscoveryRequest('GET', base + '/sessions/state'), true);
  assert.equal(isAsyncHubDiscoveryRequest('HEAD', base + '/users'), true);
  assert.equal(isAsyncHubDiscoveryRequest('PATCH', '/api/sessions/' + key + '/pin'), true);
  for (const [method, path] of [['POST', base + '/sessions/state'], ['GET', base + '/users/'], ['GET', base + '/users/anything'],
    ['PATCH', '/api/sessions/not-canonical/pin'], ['PATCH', '/api/sessions/' + key + '/pin/extra']]) {
    assert.equal(isAsyncHubDiscoveryRequest(method!, path!), false);
  }
  const app = new Hono(); assert.throws(() => registerAsyncHubDiscovery(app, { mode: 'async' } as never), /ports_required/);
  assert.equal(app.routes.length, 0);
});
