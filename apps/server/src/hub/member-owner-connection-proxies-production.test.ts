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
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { registerHubAutomation } from '../routes/hub-automation.js';
import { registerHubWebsiteRoutes } from '../routes/hub-websites.js';
import { registerHubTerminals } from '../routes/hub-terminals.js';
import { registerHubWebsiteActions } from '../routes/hub-website-actions.js';
import { registerHubWebsiteAccess } from '../routes/hub-website-access.js';
import { loadConfig } from '../config.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { ConnectorAutomationHost } from '../connector/automation-host.js';
import { registerConnectorAutomation } from '../connector/automation-http.js';
import { registerConnectorWebsiteActions } from '../connector/website-actions-http.js';
import { registerConnectorWebsiteAccess } from '../connector/website-access-http.js';
import { WebsiteGateway } from './website-gateway.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const operations = ['catalog', 'snapshot', 'automation', 'configure'] as const;
type Operation = typeof operations[number];

async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false, noStore = false) {
  const root = mkdtempSync(join(tmpdir(), 'connection-proxies-production-')), file = join(root, 'hub.sqlite');
  const tokens = new ConnectorTokenStore(join(root, 'connector-tokens.json'));
  const token = tokens.createTransient(['automation:manage', 'messages:send', 'websites:act', 'websites:browse'], 'fixture');
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const codex = new CodexAppServer({ enabled: false, command: 'must-not-launch', defaultCwd: root,
    defaultModel: 'synthetic', approvalPolicy: 'never', store: new DeckStore(), turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const allowed = (id: string) => tokens.hasScope(id, 'automation:manage') && tokens.hasScope(id, 'messages:send');
  const host = new ConnectorAutomationHost(id => users.createCodexAutomation(codex, id, users.nodeId, () => allowed(id)), allowed);
  host.start([], false);
  const remote = new Hono();
  remote.use('*', async (c, next) => {
    c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, users.nodeId); await next();
  });
  registerConnectorAutomation(remote, '/api/connector/v1/automation', { tokens, host, nodeId: users.nodeId });
  const websiteEffects = { writes: 0, reads: 0 };
  const websiteAccess = registerConnectorWebsiteAccess(remote, tokens, [{ id: 'dev', label: 'Dev', url: 'http://website.invalid/', browse: true }],
    async () => { websiteEffects.reads++; return new Response('PRIVATE_SITE_CONTENT', { headers: { 'content-type': 'text/html' } }); });
  const gateway = new WebsiteGateway({ originTemplate: 'https://{access}.preview.example.net', parentOrigin: 'https://hub.example.org', port: 9898 });
  const website = registerConnectorWebsiteActions(remote, tokens, [{ id: 'dev', label: 'Dev', url: 'http://website.invalid/',
    session: { cookieNames: ['sid'] }, actions: [{ id: 'update', label: 'Update', path: '/private-update', method: 'POST', contentType: 'application/json', maxBytes: 64 }] }],
  async () => { websiteEffects.writes++; return Response.json({ updated: true }); });
  remote.get('/api/connector/v1/websites/catalog', c => c.json({ services: [{ id: 'dev', label: 'Dev', secret: 'PRIVATE_EXTENSION' }] }));
  remote.get('/api/connector/v1/websites/dev/snapshot', c => c.json({ serviceId: 'dev', label: 'Dev', format: 'text', content: 'content', fetchedAt: Date.now(), secret: 'PRIVATE_EXTENSION' }));
  // Transport contract fixture only: never create a PTY, SSH or native process.
  const terminalReceipts = new Map<string, string>();
  remote.get('/api/connector/v1/terminals/targets', c => c.json({ targets: [{ id: 'shell', label: 'Shell', kind: 'local', privatePath: 'PRIVATE_EXTENSION' }] }));
  remote.post('/api/connector/v1/terminals', async c => {
    const input = await c.req.json<{ requestId: string }>();
    const id = terminalReceipts.get(input.requestId) ?? randomUUID(); terminalReceipts.set(input.requestId, id);
    return c.json({ id });
  });
  for (const operation of ['input', 'resize']) remote.post(`/api/connector/v1/terminals/:id/${operation}`, c => c.json({ accepted: true }));
  remote.get('/api/connector/v1/terminals/:id/output', c => c.json({ data: 'output', cursor: 6, more: false, running: true, truncated: false, privatePath: 'PRIVATE_EXTENSION' }));
  remote.delete('/api/connector/v1/terminals/:id', c => c.json({ stopped: true }));
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Existing member');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const secondKey = seed.identities.issueKey(member.id);
  const other = seed.createUser('Other member'), otherKey = seed.identities.issueKey(other.id);
  seed.upsertConnection({ id: 'node', ownerUserId: member.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: token.token });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, users.nodeId);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'metadata');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: { before?: (kind: HubMemberKind) => void | Promise<void>; after?: (kind: HubMemberKind) => void | Promise<void>; transport?: (request: Request, response: Response) => Response | Promise<Response>;
    resolving?: () => void | Promise<void>; calls: string[]; posts: number; sync: number; commands: HubMemberKind[] } = { calls: [], posts: 0, sync: 0, commands: [] };
  const port = { command: async (kind: HubMemberKind, input: never) => {
    behavior.commands.push(kind); await behavior.before?.(kind); const result = await owner.command(kind, input); await behavior.after?.(kind); return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics),
    resolver = createAsyncConnectorClientResolver(port, undefined, diagnostics);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'connector.invalid', 'fixture forbids all real network effects');
    behavior.calls.push(new URL(request.url).pathname);
    if (request.method === 'POST') behavior.posts++;
    const response = await remote.fetch(request);
    return behavior.transport ? behavior.transport(request, response) : response;
  });
  let guarded = false, routes: { close: () => Promise<void> } | undefined;
  const store = new Proxy(metadata, { get(target, property, receiver) {
    if (guarded) throw Error('SYNC_PROXY_STORE_FALLBACK'); return Reflect.get(target, property, receiver);
  } });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.all([routes?.close(), gateway.close()]).then(() => {});
  t.after(async () => {
    guarded = false; await close(); await group.close(); await resolver.close(); website.close(); websiteAccess.close(); await host.close(); await codex.close();
    users.close(); token.dispose(); await owner.close(); await metadata.close();
    for (const secret of [key.token, secondKey.token, cookie, token.token, 'PRIVATE_SESSION', 'PRIVATE_EXTENSION', 'PRIVATE_TEMPLATE', 'PRIVATE_SITE_CONTENT'])
      assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const app = new Hono();
  const asyncConnectorClient = async (...args: Parameters<typeof resolver>) => { await behavior.resolving?.(); return resolver(...args); };
  if (noStore) {
    const automation = registerHubAutomation(app, {mode: 'async', access: group.createConnectionProxyAccess(), asyncConnectorClient});
    const websites = registerHubWebsiteRoutes(app, {mode: 'async', access: group.createConnectionProxyAccess(), asyncConnectorClient});
    const terminalAccess = group.createTerminalAccess(), actionAccess = group.createWebsiteActionAccess(), websiteAccess = group.createWebsiteAccess();
    const terminals = registerHubTerminals(app, {mode: 'async', access: terminalAccess.access, asyncConnectorClient,
      audit: terminalAccess.audit, closeAccess: terminalAccess.close});
    const actions = registerHubWebsiteActions(app, {mode: 'async', access: actionAccess.access, asyncConnectorClient,
      audit: actionAccess.audit, closeAccess: actionAccess.close});
    const access = registerHubWebsiteAccess(app, {mode: 'async', access: websiteAccess.access, asyncConnectorClient,
      gateway, closeAccess: websiteAccess.close});
    routes = {close: () => Promise.all([automation.close(), websites.close(), terminals.close(), actions.close(), access.close()]).then(() => {})};
  } else routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
    websiteGateway: gateway,
    administrative: group, principal: () => { behavior.sync++; return undefined; },
    connectorClient: () => { throw Error('SYNC_RESOLVER_FALLBACK'); },
    ...(!noResolver ? { asyncConnectorClient } : {}),
    normalizeError: () => 'safe' });
  guarded = true;
  const sessionId = encodeURIComponent(encodeHubSessionId('node', 'codex:PRIVATE_SESSION'));
  const automationBase = `/api/hub/v1/sessions/${sessionId}/automation`;
  const input = { kind: 'save', template: 'PRIVATE_TEMPLATE', expectedRevision: 0, confirmEnable: false,
    rule: { id: 'rule', revision: 1, authorityEpoch: 1, enabled: false,
      target: { connectionId: users.nodeId, runtime: 'codex', sessionId: 'codex:PRIVATE_SESSION', ownerId: 'fixture' },
      startsAt: 1000, expiresAt: 1000000, maxSends: 1, maxPerHour: 1, minIntervalMs: 60000,
      mode: { kind: 'interval', intervalMs: 60000 } } };
  const path = (operation: Operation) => operation === 'catalog' ? '/api/hub/v1/connections/node/websites/catalog'
    : operation === 'snapshot' ? '/api/hub/v1/connections/node/websites/dev/snapshot'
    : automationBase + (operation === 'configure' ? '/configuration/original' : '');
  const request = (operation: Operation, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, method = operation === 'configure' ? 'POST' : 'GET') =>
    new Request('http://hub.invalid' + path(operation), { method, headers, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
  const evidence = hubMemberEvidence(request('catalog')), snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const proof = { evidence, expectedScope: snapshot.recoveryScope };
  const revoke = async () => {
    const evidence = { accessKey: admin.token }, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope, userId: member.id, keyId: key.id });
  };
  const change = async (disable = false) => {
    const target = await owner.command('connectionTarget', { ...proof, id: 'node' }); assert.ok(target && 'epoch' in target);
    await owner.command('connectionChange', { ...proof, change: { action: 'patch', id: 'node', expectedEpoch: target.epoch, configuration: disable ? { enabled: false } : { label: 'Renamed' } } });
  };
  const terminalRequest = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }) =>
    new Request('http://hub.invalid/api/hub/v1/connections/node/terminals' + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const actionRequest = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }) =>
    new Request('http://hub.invalid/api/hub/v1/connections/node/website-actions' + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const accessRequest = (path: string, method = 'POST', body?: unknown, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }) =>
    new Request('http://hub.invalid/api/hub/v1/connections/node/website-access' + path, {
      method, headers: { origin: gateway.config.parentOrigin, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, behavior, request, terminalRequest, actionRequest, accessRequest, gateway, websiteEffects, close, revoke, change, owner, group, key, secondKey, cookie, otherKey, input, path, automationBase, logs };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} async-only website and automation registration needs no legacy dependencies`, async t => {
    const f = await fixture(t, mode, false, true);
    for (const headers of [{'x-agentopsdeck-key': f.key.token}, {cookie: 'agentopsdeck_access=' + f.key.token}, {cookie: 'agentopsdeck_session=' + f.cookie}])
      for (const operation of ['catalog', 'snapshot', 'automation'] as const) {
        const response = await f.app.fetch(f.request(operation, headers));
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    const saved = await f.app.fetch(f.request('configure')); assert.equal(saved.status, 200);
    assert.deepEqual(await (await f.app.fetch(f.request('configure', undefined, 'GET'))).json(), await saved.json());
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.sync, 0);
    await f.revoke();
    for (const operation of operations) assert.equal((await f.app.fetch(f.request(operation))).status, 401);
    assert.equal(f.behavior.posts, 1);
  });
  for (const operation of ['catalog', 'configure'] as const)
    test(`${mode} async-only ${operation} retains ignored-abort resolver until original settlement`, async t => {
      const f = await fixture(t, mode, false, true), entered = deferred(), release = deferred(), abort = new AbortController();
      t.after(() => release.resolve());
      f.behavior.resolving = async () => {entered.resolve(); await release.promise;};
      const request = f.request(operation), response = f.app.fetch(new Request(request, {signal: abort.signal}));
      await entered.promise; abort.abort();
      let drained = false; const closing = f.close().then(() => {drained = true;});
      await tick(); assert.equal(drained, false); assert.equal(f.behavior.calls.length, 0);
      release.resolve(); assert.equal((await response).status, 503); await closing;
      assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
    });
  test(`${mode} websites and automation use actual async resolver and preserve Key/Cookie/receipt contracts`, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      for (const operation of ['catalog', 'snapshot', 'automation'] as const) {
        const response = await f.app.fetch(f.request(operation, headers));
        assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.text()).includes('PRIVATE_EXTENSION'), false);
      }
    }
    const saved = await f.app.fetch(f.request('configure')); assert.equal(saved.status, 200, await saved.clone().text());
    const receipt = await saved.json();
    assert.deepEqual(await (await f.app.fetch(f.request('configure', undefined, 'GET'))).json(), receipt);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.sync, 0);
    assert.equal(f.behavior.commands.includes('connectionDirectory'), false);
  });
  test(`${mode} proxy routes preserve exact bypass, foreign-owner, scope and missing resolver refusals`, async t => {
    const f = await fixture(t, mode);
    for (const operation of operations) {
      assert.equal((await f.app.fetch(f.request(operation, { 'x-agentopsdeck-key': f.otherKey.token }))).status, 404);
      for (const token of ['invalid', 'aod_board_synthetic', 'aod_note_synthetic'])
        assert.equal((await f.app.fetch(f.request(operation, { 'x-agentopsdeck-key': token }))).status, 401);
      assert.equal((await f.app.fetch(f.request(operation, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'b'.repeat(64) }))).status, 409);
      assert.equal((await f.app.fetch(f.request(operation, undefined, 'DELETE'))).status, 401);
    }
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} async access without resolver fails closed instead of sync fallback`, async t => {
    const f = await fixture(t, mode, true);
    for (const operation of operations) assert.equal((await f.app.fetch(f.request(operation))).status, 503);
    assert.equal(f.behavior.sync, 0); assert.equal(f.behavior.calls.length, 0);
  });
  for (const operation of operations) {
    for (const stage of ['resolver', 'response', 'final-proof'] as const) {
      test(`${mode} ${operation} refuses connection generation change at ${stage}`, async t => {
        const f = await fixture(t, mode); let changed = false;
        const change = async () => { if (!changed) { changed = true; await f.change(); } };
        if (stage === 'resolver') f.behavior.resolving = change;
        if (stage === 'response') f.behavior.transport = async (_request, response) => { await change(); return response; };
        if (stage === 'final-proof') f.behavior.after = async kind => { if (kind === 'connectionDirectoryCheck' && f.behavior.calls.length) await change(); };
        assert.equal((await f.app.fetch(f.request(operation))).status, 403);
        assert.equal(f.behavior.posts, 0,
          'configuration snapshot must fence change before POST');
      });
    }
    test(`${mode} ${operation} close drains original upstream and rejects late delivery`, async t => {
      const f = await fixture(t, mode), entered = deferred(), release = deferred();
      f.behavior.transport = async (_request, response) => { entered.resolve(); await release.promise; return response; };
      const response = f.app.fetch(f.request(operation));
      t.after(() => release.resolve());
      await entered.promise; let drained = false;
      const closing = f.close().then(() => { drained = true; });
      await tick(); assert.equal(drained, false);
      assert.equal((await f.app.fetch(f.request(operation))).status, 503);
      release.resolve(); assert.equal((await response).status, 503); await closing;
      assert.equal(f.behavior.posts, 0);
    });
  }
  test(`${mode} automation body-time revoke prevents POST`, async t => {
    const f = await fixture(t, mode), resolved = deferred();
    f.behavior.resolving = async () => { resolved.resolve(); };
    const body = new ReadableStream<Uint8Array>({ async pull(stream) { await resolved.promise; await f.revoke(); stream.enqueue(new TextEncoder().encode(JSON.stringify(f.input))); stream.close(); } });
    const request = new Request('http://hub.invalid' + f.path('configure'), { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401); assert.equal(f.behavior.posts, 0);
  });
  test(`${mode} automation close retains admitted body and prevents late POST`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    // Request streams may pull eagerly; only signal admission after the resolver
    // has returned and the HTTP lifecycle is registered.
    f.behavior.resolving = async () => { entered.resolve(); };
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      await release.promise; stream.enqueue(new TextEncoder().encode(JSON.stringify(f.input))); stream.close();
    } });
    const request = new Request('http://hub.invalid' + f.path('configure'), { method: 'POST',
      headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    const response = f.app.fetch(request); t.after(() => release.resolve());
    await entered.promise;
    // Wait until the complete scope proof has passed and the route is actually
    // blocked in body reading, rather than merely inside the resolver hook.
    while (!body.locked) await tick();
    let drained = false; const closing = f.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing;
    assert.equal(f.behavior.posts, 0);
  });
  test(`${mode} automation close waits committed original POST ACK without replay`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    f.behavior.transport = async (request, response) => {
      if (request.method === 'POST') { entered.resolve(); await release.promise; } return response;
    };
    const response = f.app.fetch(f.request('configure')); t.after(() => release.resolve());
    await entered.promise; assert.equal(f.behavior.posts, 1);
    let drained = false; const closing = f.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    assert.equal((await f.app.fetch(f.request('configure'))).status, 503);
    release.resolve(); assert.equal((await response).status, 503); await closing;
    assert.equal(f.behavior.posts, 1);
  });
  test(`${mode} automation committed lost ACK recovers exact original receipt without repost`, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = (request, response) => { if (request.method === 'POST') throw Error('lost ACK'); return response; };
    assert.equal((await f.app.fetch(f.request('configure'))).status, 503);
    assert.equal(f.behavior.posts, 1);
    delete f.behavior.transport;
    const response = await f.app.fetch(f.request('configure', undefined, 'GET'));
    assert.equal(response.status, 200); assert.equal((await response.json()).requestId, 'original'); assert.equal(f.behavior.posts, 1);
  });
  test(`${mode} automation post-commit revoke withholds receipt without repeating effect`, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = async (request, response) => { if (request.method === 'POST') await f.revoke(); return response; };
    assert.equal((await f.app.fetch(f.request('configure'))).status, 401); assert.equal(f.behavior.posts, 1);
  });
}

const actionOpen = { serviceId: 'dev', actionId: 'update' };
async function openAction(f: Awaited<ReturnType<typeof fixture>>, headers?: Record<string, string>) {
  const response = await f.app.fetch(f.actionRequest('', 'POST', actionOpen, headers));
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { accessId: string; expiresAt: number };
}
for (const mode of ['original', 'worker'] as const) {
  test(`${mode} website actions use worker authority, all evidence forms and original Connector receipts`, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      const catalog = await f.app.fetch(f.actionRequest('/catalog/dev', 'GET', undefined, headers));
      assert.equal(catalog.status, 200, await catalog.clone().text()); assert.equal(catalog.headers.get('cache-control'), 'no-store');
      assert.equal((await catalog.text()).includes('private-update'), false);
      const controller = new AbortController();
      const response = await f.app.fetch(new Request(f.actionRequest('', 'POST', actionOpen, headers), { signal: controller.signal }));
      assert.equal(response.status, 200); const opened = await response.json(); controller.abort();
      await f.change();
      const executed = await f.app.fetch(f.actionRequest(`/${opened.accessId}/execute`, 'POST', { body: '{}' }, headers));
      assert.equal(executed.status, 200, await executed.clone().text()); const receipt = await executed.json(); assert.equal(receipt.state, 'completed');
      assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${opened.accessId}`, 'GET', undefined, headers))).json(), receipt);
      const continuation = await f.app.fetch(f.actionRequest('', 'POST', { ...actionOpen, previousAccessId: opened.accessId }, headers));
      assert.equal(continuation.status, 200, await continuation.clone().text()); const next = await continuation.json(); assert.ok(next.expiresAt <= opened.expiresAt);
      assert.equal((await f.app.fetch(f.actionRequest(`/${opened.accessId}`, 'GET', undefined, headers))).status, 404);
      assert.equal((await f.app.fetch(f.actionRequest(`/${next.accessId}`, 'DELETE', undefined, headers))).status, 200);
    }
    assert.equal(f.websiteEffects.writes, 3); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} website action handles reject key replacement, foreign owner, scope and capability without losing original`, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f);
    for (const headers of [{ 'x-agentopsdeck-key': f.secondKey.token }, { 'x-agentopsdeck-key': f.otherKey.token }])
      assert.equal((await f.app.fetch(f.actionRequest(`/${accessId}`, 'GET', undefined, headers))).status, 404);
    const calls = f.behavior.calls.length;
    assert.equal((await f.app.fetch(f.actionRequest(`/${accessId}`, 'GET', undefined, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'stale' }))).status, 409);
    assert.equal((await f.app.fetch(f.actionRequest('/catalog/dev', 'GET', undefined, { 'x-agentopsdeck-key': f.key.token, authorization: 'Bearer aod_board_untrusted' }))).status, 401);
    assert.equal((await f.app.fetch(f.actionRequest('/catalog/dev?url=unsafe'))).status, 400);
    for (const request of [f.actionRequest('/catalog/dev', 'PUT'), f.actionRequest('/catalog/dev/extra')])
      assert.equal((await f.app.fetch(request)).status, 401);
    assert.equal(f.behavior.calls.length, calls);
    assert.equal((await f.app.fetch(f.actionRequest(`/${accessId}`))).status, 200);
  });
  test(`${mode} website actions fail closed without async resolver or during resolver revocation`, async t => {
    const absent = await fixture(t, mode, true);
    assert.equal((await absent.app.fetch(absent.actionRequest('/catalog/dev'))).status, 503);
    assert.equal(absent.behavior.calls.length, 0); assert.equal(absent.behavior.sync, 0);
    const f = await fixture(t, mode); f.behavior.resolving = () => f.revoke();
    assert.equal((await f.app.fetch(f.actionRequest('/catalog/dev'))).status, 401); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} website actions recheck body authority before open and close retains original body`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      entered.resolve();
      await release.promise; stream.enqueue(new TextEncoder().encode(JSON.stringify(actionOpen))); stream.close();
    } }, { highWaterMark: 0 });
    const request = new Request(f.actionRequest('').url, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    const response = f.app.fetch(request); await entered.promise;
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing; assert.equal(f.behavior.posts, 0);
  });
  test(`${mode} website action body revocation prevents dispatch`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), resolved = deferred();
    f.behavior.resolving = () => { resolved.resolve(); };
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      await resolved.promise; await f.revoke(); stream.enqueue(new TextEncoder().encode(JSON.stringify(actionOpen))); stream.close();
    } });
    const request = new Request(f.actionRequest('').url, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401); assert.equal(f.behavior.posts, 0);
  });
  test(`${mode} website actions never replay lost opens or unknown execution even if remote says ready`, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = (request, response) => { if (request.method === 'POST') throw Error('PRIVATE_EXTENSION'); return response; };
    const failed = await f.app.fetch(f.actionRequest('', 'POST', actionOpen)); assert.equal(failed.status, 502); assert.equal((await failed.text()).includes('PRIVATE_EXTENSION'), false);
    assert.equal(f.behavior.posts, 1); assert.equal(f.websiteEffects.writes, 0);
    delete f.behavior.transport; const { accessId } = await openAction(f);
    f.behavior.transport = (request, response) => {
      if (request.method === 'POST' && request.url.endsWith('/execute')) throw Error('PRIVATE_EXTENSION');
      if (request.method === 'GET') return Response.json({ state: 'ready' }, { headers: response.headers });
      return response;
    };
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' }))).json(), { state: 'unknown' });
    const posts = f.behavior.posts;
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}`))).json(), { state: 'unknown' });
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' }))).json(), { state: 'unknown' });
    assert.equal(f.behavior.posts, posts); assert.equal(f.websiteEffects.writes, 1);
    assert.equal((await f.app.fetch(f.actionRequest('', 'POST', { ...actionOpen, previousAccessId: accessId }))).status, 409);
  });
  test(`${mode} website action concurrent execution and continuation each consume exactly one original`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), opened = await openAction(f), entered = deferred(), release = deferred(); t.after(() => release.resolve());
    f.behavior.transport = async (request, response) => { if (request.url.endsWith('/execute')) { entered.resolve(); await release.promise; } return response; };
    const first = f.app.fetch(f.actionRequest(`/${opened.accessId}/execute`, 'POST', { body: '{}' })); await entered.promise;
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${opened.accessId}/execute`, 'POST', { body: '{}' }))).json(), { state: 'pending' });
    assert.equal(f.websiteEffects.writes, 1); release.resolve(); assert.equal((await first).status, 200);
    const attempts = await Promise.all([1, 2].map(() => f.app.fetch(f.actionRequest('', 'POST', { ...actionOpen, previousAccessId: opened.accessId }))));
    assert.deepEqual(attempts.map(response => response.status).sort(), [200, 404]);
    assert.equal(f.behavior.posts, 3); assert.equal(f.websiteEffects.writes, 1);
  });
  test(`${mode} website action submitted audit failure cannot dispatch and remains non-replayable`, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f); let audits = 0;
    f.behavior.before = kind => { if (kind === 'auditAppend' && ++audits === 1) throw Error('PRIVATE_EXTENSION'); };
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' }))).json(), { state: 'unknown' });
    assert.equal(f.behavior.posts, 1); assert.equal(f.websiteEffects.writes, 0);
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}`))).json(), { state: 'unknown' });
    await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' })); assert.equal(f.websiteEffects.writes, 0);
  });
  test(`${mode} website action rechecks revocation after submitted audit ACK`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f); let audits = 0;
    f.behavior.after = async kind => { if (kind === 'auditAppend' && ++audits === 1) await f.revoke(); };
    assert.equal((await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' }))).status, 401);
    assert.equal(f.websiteEffects.writes, 0); assert.equal(f.behavior.posts, 1);
  });
  for (const change of ['revoke', 'epoch'] as const) {
    test(`${mode} website action execution waiting on ACK cannot disclose after ${change}`, async t => {
      const f = await fixture(t, mode), { accessId } = await openAction(f);
      f.behavior.transport = async (request, response) => { if (request.url.endsWith('/execute')) { if (change === 'revoke') await f.revoke(); else await f.change(true); } return response; };
      const response = await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' }));
      assert.ok([401, 403, 404].includes(response.status), await response.clone().text()); assert.equal((await response.text()).includes('updated'), false);
      assert.equal(f.websiteEffects.writes, 1); assert.equal(f.behavior.posts, 2);
    });
  }
  test(`${mode} website action receipt checks revocation after remote read`, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f);
    f.behavior.transport = async (request, response) => { if (request.method === 'GET') await f.revoke(); return response; };
    assert.equal((await f.app.fetch(f.actionRequest(`/${accessId}`))).status, 401);
  });
  test(`${mode} website action close waits late open and original cleanup DELETE`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), opened = deferred(), deleted = deferred(), releaseOpen = deferred(), releaseDelete = deferred();
    t.after(() => { releaseOpen.resolve(); releaseDelete.resolve(); });
    f.behavior.transport = async (request, response) => {
      if (request.method === 'POST') { opened.resolve(); await releaseOpen.promise; }
      if (request.method === 'DELETE') { deleted.resolve(); await releaseDelete.promise; }
      return response;
    };
    const response = f.app.fetch(f.actionRequest('', 'POST', actionOpen)); await opened.promise;
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    releaseOpen.resolve(); await deleted.promise; await tick(); assert.equal(drained, false);
    releaseDelete.resolve(); assert.equal((await response).status, 503); await closing;
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.calls.filter(path => /\/website-actions\/[^/]+$/.test(path)).length, 1);
  });
  test(`${mode} website action close waits settled audit and never replays execution`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f), entered = deferred(), release = deferred(); let audits = 0;
    t.after(() => release.resolve());
    f.behavior.after = async kind => { if (kind === 'auditAppend' && ++audits === 2) { entered.resolve(); await release.promise; } };
    const response = f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' })); await entered.promise;
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing;
    assert.equal(f.websiteEffects.writes, 1); assert.equal(f.behavior.posts, 2);
  });
  test(`${mode} website action stop owns original DELETE and audit through close`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f), deleted = deferred(), audited = deferred(), release = deferred(); t.after(() => release.resolve());
    f.behavior.transport = async (request, response) => { if (request.method === 'DELETE') { deleted.resolve(); await release.promise; } return response; };
    f.behavior.after = async kind => { if (kind === 'auditAppend') { audited.resolve(); await release.promise; } };
    const response = f.app.fetch(f.actionRequest(`/${accessId}`, 'DELETE')); await Promise.all([deleted.promise, audited.promise]);
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing;
  });
  test(`${mode} website action active authority timer is single-flight and drains original command`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), { accessId } = await openAction(f), executed = deferred(), entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    f.behavior.transport = async (request, response) => { if (request.url.endsWith('/execute')) { executed.resolve(); await release.promise; } return response; };
    const response = f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', { body: '{}' })); await executed.promise;
    f.behavior.after = async kind => { if (kind === 'connectorAccess') { entered.resolve(); await release.promise; } };
    await entered.promise; const count = f.behavior.commands.length;
    await new Promise(resolve => setTimeout(resolve, 550)); assert.equal(f.behavior.commands.length, count);
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing; assert.equal(f.websiteEffects.writes, 1);
  });
}

async function openWebsite(f: Awaited<ReturnType<typeof fixture>>, headers?: Record<string, string>) {
  const response = await f.app.fetch(f.accessRequest('', 'POST', { serviceId: 'dev' }, headers));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { accessId: string }).accessId;
}
for (const mode of ['original', 'worker'] as const) {
  test(`${mode} website access complete chain keeps original evidence after HTTP abort and label changes`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      const controller = new AbortController();
      const response = await f.app.fetch(new Request(f.accessRequest('', 'POST', { serviceId: 'dev' }, headers), { signal: controller.signal }));
      assert.equal(response.status, 200); const { accessId } = await response.json() as { accessId: string }; controller.abort();
      await f.change();
      const resource = await f.app.fetch(f.accessRequest(`/${accessId}/resource`, 'POST', { path: '/' }, headers));
      assert.equal(resource.status, 200); assert.equal(resource.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await resource.json(), { status: 200, contentType: 'text/html', bodyBase64: Buffer.from('PRIVATE_SITE_CONTENT').toString('base64') });
      const visit = await f.app.fetch(f.accessRequest(`/${accessId}/browser`, 'POST', {}, headers)); assert.equal(visit.status, 200);
      const { url } = await visit.json() as { url: string };
      const rendered = await f.gateway.fetch(new Request(url)); assert.equal(rendered.status, 200);
      assert.equal(await rendered.text(), 'PRIVATE_SITE_CONTENT');
      assert.match(rendered.headers.get('content-security-policy')!, /sandbox allow-scripts$/);
      assert.equal(rendered.headers.get('set-cookie'), null);
      assert.equal((await f.app.fetch(f.accessRequest(`/${accessId}`, 'DELETE', undefined, headers))).status, 200);
      assert.equal((await f.gateway.fetch(new Request(url))).status, 404);
    }
    assert.equal(f.behavior.sync, 0); assert.equal(f.websiteEffects.reads, 6);
    assert.equal(f.behavior.commands.includes('connectionDirectory'), false);
  });
  test(`${mode} website access rejects replacement credentials, scope, capability and adjacent bypass`, async t => {
    const f = await fixture(t, mode), accessId = await openWebsite(f);
    for (const headers of [{ 'x-agentopsdeck-key': f.secondKey.token }, { 'x-agentopsdeck-key': f.otherKey.token }])
      assert.equal((await f.app.fetch(f.accessRequest(`/${accessId}/resource`, 'POST', { path: '/' }, headers))).status, 404);
    assert.equal((await f.app.fetch(f.accessRequest(`/${accessId}/resource`, 'POST', { path: '/' }, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'stale' }))).status, 409);
    assert.equal((await f.app.fetch(f.accessRequest('', 'POST', { serviceId: 'dev' }, { authorization: 'Bearer aod_note_untrusted', 'x-agentopsdeck-key': f.key.token }))).status, 401);
    assert.equal((await f.app.fetch(f.accessRequest('?url=private', 'POST', { serviceId: 'dev' }))).status, 400);
    for (const [path, method] of [['', 'PUT'], [`/${accessId}/resource`, 'GET'], [`/${accessId}/resource/extra`, 'POST']] as const)
      assert.equal((await f.app.fetch(f.accessRequest(path, method))).status, 401);
    assert.equal(f.websiteEffects.reads, 0);
    assert.equal((await f.app.fetch(f.accessRequest(`/${accessId}/resource`, 'POST', { path: '/' }))).status, 200);
  });
  test(`${mode} website access missing resolver and resolver revocation never dispatch`, async t => {
    const absent = await fixture(t, mode, true);
    assert.equal((await absent.app.fetch(absent.accessRequest('', 'POST', { serviceId: 'dev' }))).status, 503);
    assert.equal(absent.behavior.calls.length, 0);
    const f = await fixture(t, mode); f.behavior.resolving = () => f.revoke();
    assert.equal((await f.app.fetch(f.accessRequest('', 'POST', { serviceId: 'dev' }))).status, 401);
    assert.equal(f.behavior.calls.length, 0);
  });
  for (const shutdown of [false, true]) {
    test(`${mode} website access body wait ${shutdown ? 'drains on close' : 'rechecks revoked proof'}`, { timeout: 20_000 }, async t => {
      const f = await fixture(t, mode), entered = deferred(), release = deferred(); t.after(() => release.resolve());
      const body = new ReadableStream<Uint8Array>({ async pull(stream) {
        entered.resolve();
        await release.promise; stream.enqueue(new TextEncoder().encode('{"serviceId":"dev"}')); stream.close();
      } }, { highWaterMark: 0 });
      const request = new Request(f.accessRequest('').url, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
      const response = f.app.fetch(request); await entered.promise;
      let drained = false; const closing = shutdown ? f.close().then(() => { drained = true; }) : undefined;
      if (!shutdown) await f.revoke();
      await tick(); assert.equal(drained, false); release.resolve();
      assert.equal((await response).status, shutdown ? 503 : 401); await closing; assert.equal(f.behavior.posts, 0);
    });
  }
  for (const disabled of [false, true]) {
    test(`${mode} website resource rejects ${disabled ? 'epoch disable' : 'revocation'} after original network ACK`, async t => {
      const f = await fixture(t, mode), accessId = await openWebsite(f);
      f.behavior.transport = async (request, response) => {
        if (request.url.endsWith('/resource')) { if (disabled) await f.change(true); else await f.revoke(); }
        return response;
      };
      const response = await f.app.fetch(f.accessRequest(`/${accessId}/resource`, 'POST', { path: '/' }));
      assert.equal(response.status, disabled ? 403 : 401); assert.equal((await response.text()).includes('PRIVATE_SITE_CONTENT'), false);
    });
  }
  test(`${mode} isolated gateway callback retains original worker proof rather than accepting new owner key`, async t => {
    const f = await fixture(t, mode), accessId = await openWebsite(f);
    const visit = await f.app.fetch(f.accessRequest(`/${accessId}/browser`, 'POST', {})); assert.equal(visit.status, 200);
    const { url } = await visit.json() as { url: string };
    await f.revoke(); assert.equal((await f.gateway.fetch(new Request(url))).status, 401);
    assert.equal(f.websiteEffects.reads, 0);
    assert.equal((await f.app.fetch(f.accessRequest(`/${accessId}/browser`, 'POST', {}, { 'x-agentopsdeck-key': f.secondKey.token }))).status, 404);
    assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} close owns late website open ACK and exactly one remote DELETE`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), opened = deferred(), releaseOpen = deferred(), deleted = deferred(), releaseDelete = deferred();
    t.after(() => { releaseOpen.resolve(); releaseDelete.resolve(); }); let deletes = 0;
    f.behavior.transport = async (request, response) => {
      if (request.method === 'POST' && request.url.endsWith('/website-access')) { opened.resolve(); await releaseOpen.promise; }
      if (request.method === 'DELETE') { deletes++; deleted.resolve(); await releaseDelete.promise; }
      return response;
    };
    const response = f.app.fetch(f.accessRequest('', 'POST', { serviceId: 'dev' })); await opened.promise;
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    releaseOpen.resolve(); await deleted.promise; await tick(); assert.equal(drained, false); releaseDelete.resolve();
    assert.equal((await response).status, 503); await closing; assert.equal(deletes, 1);
  });
  test(`${mode} gateway close retains original resource ACK and never delivers late content`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), accessId = await openWebsite(f), entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const visit = await f.app.fetch(f.accessRequest(`/${accessId}/browser`, 'POST', {})); assert.equal(visit.status, 200);
    const { url } = await visit.json() as { url: string };
    f.behavior.transport = async (request, response) => { if (request.url.endsWith('/resource')) { entered.resolve(); await release.promise; } return response; };
    const read = f.gateway.fetch(new Request(url)); await entered.promise;
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await read).status, 503); await closing;
  });
}

const terminalStart = () => ({ targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 });
async function startTerminal(f: Awaited<ReturnType<typeof fixture>>, headers?: Record<string, string>) {
  const response = await f.app.fetch(f.terminalRequest('', 'POST', terminalStart(), headers));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { id: string }).id;
}
for (const mode of ['original', 'worker'] as const) {
  test(`${mode} no-store long-lived proxies complete all three evidence chains`, {timeout: 30_000}, async t => {
    const f = await fixture(t, mode, false, true);
    for (const headers of [{'x-agentopsdeck-key': f.key.token}, {cookie: 'agentopsdeck_access=' + f.key.token}, {cookie: 'agentopsdeck_session=' + f.cookie}]) {
      assert.equal((await f.app.fetch(f.terminalRequest('/targets', 'GET', undefined, headers))).status, 200);
      const id = await startTerminal(f, headers);
      await f.change();
      for (const [operation, body] of [['input', {sequence: 1, data: 'private input'}], ['resize', {cols: 100, rows: 30}]] as const)
        assert.deepEqual(await (await f.app.fetch(f.terminalRequest(`/${id}/${operation}`, 'POST', body, headers))).json(), {accepted: true});
      const output = await f.app.fetch(f.terminalRequest(`/${id}/output?cursor=0`, 'GET', undefined, headers));
      assert.equal(output.status, 200); assert.equal((await output.text()).includes('PRIVATE_EXTENSION'), false);
      assert.equal((await f.app.fetch(f.terminalRequest(`/${id}`, 'DELETE', undefined, headers))).status, 200);

      assert.equal((await f.app.fetch(f.actionRequest('/catalog/dev', 'GET', undefined, headers))).status, 200);
      const opened = await openAction(f, headers);
      const executed = await f.app.fetch(f.actionRequest(`/${opened.accessId}/execute`, 'POST', {body: '{}'}, headers));
      assert.equal(executed.status, 200); const receipt = await executed.json(); assert.equal(receipt.state, 'completed');
      assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${opened.accessId}`, 'GET', undefined, headers))).json(), receipt);
      const continued = await f.app.fetch(f.actionRequest('', 'POST', {...actionOpen, previousAccessId: opened.accessId}, headers));
      assert.equal(continued.status, 200); const next = await continued.json(); assert.ok(next.expiresAt <= opened.expiresAt);
      assert.equal((await f.app.fetch(f.actionRequest(`/${next.accessId}`, 'DELETE', undefined, headers))).status, 200);

      const accessId = await openWebsite(f, headers);
      const resource = await f.app.fetch(f.accessRequest(`/${accessId}/resource`, 'POST', {path: '/'}, headers));
      assert.equal(resource.status, 200); assert.equal((await resource.json()).bodyBase64, Buffer.from('PRIVATE_SITE_CONTENT').toString('base64'));
      const visit = await f.app.fetch(f.accessRequest(`/${accessId}/browser`, 'POST', {}, headers));
      assert.equal(visit.status, 200); const {url} = await visit.json();
      assert.equal(await (await f.gateway.fetch(new Request(url))).text(), 'PRIVATE_SITE_CONTENT');
      assert.equal((await f.app.fetch(f.accessRequest(`/${accessId}`, 'DELETE', undefined, headers))).status, 200);
      assert.equal((await f.gateway.fetch(new Request(url))).status, 404);
    }
    assert.equal(f.websiteEffects.writes, 3); assert.equal(f.behavior.sync, 0);
    assert.equal(f.behavior.commands.includes('connectionDirectory'), false);
  });
  for (const lane of ['terminal', 'action', 'access'] as const) {
    const request = (f: Awaited<ReturnType<typeof fixture>>) => lane === 'terminal' ? f.terminalRequest('/targets')
      : lane === 'action' ? f.actionRequest('/catalog/dev') : f.accessRequest('', 'POST', {serviceId: 'dev'});
    test(`${mode} no-store ${lane} holds ignored-abort resolver through close`, {timeout: 20_000}, async t => {
      const f = await fixture(t, mode, false, true), entered = deferred(), release = deferred();
      t.after(() => release.resolve());
      f.behavior.resolving = async () => {entered.resolve(); await release.promise;};
      const controller = new AbortController(), response = f.app.fetch(new Request(request(f), {signal: controller.signal}));
      await entered.promise; controller.abort();
      let drained = false; const closing = f.close().then(() => {drained = true;});
      await tick(); assert.equal(drained, false); assert.equal(f.behavior.calls.length, 0);
      release.resolve(); assert.equal((await response).status, 503); await closing;
      assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
    });
    test(`${mode} no-store ${lane} resolver revocation prevents all network effects`, async t => {
      const f = await fixture(t, mode, false, true); f.behavior.resolving = () => f.revoke();
      assert.equal((await f.app.fetch(request(f))).status, 401);
      assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
    });
  }
  for (const lane of ['terminal', 'action', 'execute', 'access', 'resource', 'browser', 'automation'] as const) {
    test(`${mode} no-store ${lane} malformed body still rechecks original proof`, {timeout: 20_000}, async t => {
      const f = await fixture(t, mode, false, true);
      const id = lane === 'execute' ? (await openAction(f)).accessId
        : lane === 'resource' || lane === 'browser' ? await openWebsite(f) : '';
      const template = lane === 'terminal' ? f.terminalRequest('', 'POST', terminalStart())
        : lane === 'action' ? f.actionRequest('', 'POST', actionOpen)
        : lane === 'execute' ? f.actionRequest(`/${id}/execute`, 'POST', {body: '{}'})
        : lane === 'automation' ? f.request('configure')
        : f.accessRequest(lane === 'access' ? '' : `/${id}/${lane}`, 'POST', {});
      const count = f.behavior.posts;
      const body = new ReadableStream<Uint8Array>({async pull(stream) {
        await f.revoke(); stream.enqueue(new TextEncoder().encode('{')); stream.close();
      }}, {highWaterMark: 0});
      const response = await f.app.fetch(new Request(template.url, {method: 'POST', headers: template.headers, body, duplex: 'half'} as RequestInit));
      assert.equal(response.status, 401, await response.clone().text());
      assert.equal(f.behavior.posts, count); assert.equal(f.websiteEffects.writes, 0);
    });
  }
  test(`${mode} no-store website action lost ACK remains GET-only`, async t => {
    const f = await fixture(t, mode, false, true), {accessId} = await openAction(f);
    f.behavior.transport = async (request, response) => {
      if (request.url.endsWith('/execute')) throw Error('lost ACK');
      return response;
    };
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', {body: '{}'}))).json(), {state: 'unknown'});
    const count = f.behavior.posts; delete f.behavior.transport;
    assert.deepEqual(await (await f.app.fetch(f.actionRequest(`/${accessId}/execute`, 'POST', {body: '{}'}))).json(), {state: 'unknown'});
    assert.equal((await (await f.app.fetch(f.actionRequest(`/${accessId}`))).json()).state, 'completed');
    assert.equal(f.behavior.posts, count); assert.equal(f.websiteEffects.writes, 1);
  });
}
for (const mode of ['original', 'worker'] as const) {
  test(`${mode} terminal complete chain retains Key/Cookie, original signal and presentation-independent authority`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      const catalog = await f.app.fetch(f.terminalRequest('/targets', 'GET', undefined, headers));
      assert.equal(catalog.status, 200); assert.equal(catalog.headers.get('cache-control'), 'no-store');
      assert.equal((await catalog.text()).includes('PRIVATE_EXTENSION'), false);
      const controller = new AbortController();
      const request = new Request(f.terminalRequest('', 'POST', terminalStart(), headers), { signal: controller.signal });
      const response = await f.app.fetch(request); assert.equal(response.status, 200, await response.clone().text());
      const { id } = await response.json() as { id: string }; controller.abort();
      await f.change();
      for (const [operation, body] of [['input', { sequence: 1, data: 'private input' }], ['resize', { cols: 100, rows: 30 }]] as const)
        assert.deepEqual(await (await f.app.fetch(f.terminalRequest(`/${id}/${operation}`, 'POST', body, headers))).json(), { accepted: true });
      const output = await f.app.fetch(f.terminalRequest(`/${id}/output?cursor=0`, 'GET', undefined, headers));
      assert.equal(output.status, 200, await output.clone().text());
      assert.deepEqual(await output.json(), { data: 'output', cursor: 6, more: false, running: true, truncated: false });
      assert.equal((await f.app.fetch(f.terminalRequest(`/${id}`, 'DELETE', undefined, headers))).status, 200);
    }
    assert.equal(f.behavior.sync, 0); assert.equal(f.behavior.commands.includes('connectionDirectory'), false);
  });
  test(`${mode} terminals reject credential takeover, foreign owners, scope, capability and noncanonical operations`, async t => {
    const f = await fixture(t, mode), id = await startTerminal(f);
    for (const key of [f.secondKey.token, f.otherKey.token])
      assert.equal((await f.app.fetch(f.terminalRequest(`/${id}/output?cursor=0`, 'GET', undefined, { 'x-agentopsdeck-key': key }))).status, 404);
    const count = f.behavior.calls.length;
    for (const key of ['invalid', 'aod_board_synthetic', 'aod_note_synthetic'])
      assert.equal((await f.app.fetch(f.terminalRequest('/targets', 'GET', undefined, { 'x-agentopsdeck-key': key }))).status, 401);
    assert.equal((await f.app.fetch(f.terminalRequest('/targets', 'GET', undefined, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'b'.repeat(64) }))).status, 409);
    assert.equal((await f.app.fetch(f.terminalRequest('/targets', 'PUT'))).status, 401);
    assert.equal((await f.app.fetch(f.terminalRequest('/targets/adjacent'))).status, 401);
    assert.equal(f.behavior.calls.length, count);
    assert.equal((await f.app.fetch(f.terminalRequest(`/${id}/output?cursor=0`))).status, 200, 'rejected takeover does not destroy original handle');
  });
  test(`${mode} terminal async access never falls back when resolver is absent`, async t => {
    const f = await fixture(t, mode, true);
    for (const request of [f.terminalRequest('/targets'), f.terminalRequest('', 'POST', terminalStart()), f.terminalRequest('/missing', 'DELETE')])
      assert.equal((await f.app.fetch(request)).status, 503);
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} terminal resolver-time revoke prevents dispatch`, async t => {
    const f = await fixture(t, mode); f.behavior.resolving = f.revoke;
    assert.equal((await f.app.fetch(f.terminalRequest('', 'POST', terminalStart()))).status, 401);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} terminal body-time revoke prevents start`, async t => {
    const f = await fixture(t, mode), entered = deferred();
    f.behavior.resolving = async () => { entered.resolve(); };
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      await entered.promise; await f.revoke(); stream.enqueue(new TextEncoder().encode(JSON.stringify(terminalStart()))); stream.close();
    } });
    const request = new Request(f.terminalRequest('', 'POST'), { body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401); assert.equal(f.behavior.posts, 0);
  });
  test(`${mode} terminal unknown start is not resent`, async t => {
    const f = await fixture(t, mode);
    f.behavior.transport = async request => { assert.equal(request.method, 'POST'); throw Error('PRIVATE_EXTENSION'); };
    const result = await f.app.fetch(f.terminalRequest('', 'POST', terminalStart()));
    assert.equal(result.status, 502); assert.equal((await result.text()).includes('PRIVATE_EXTENSION'), false); assert.equal(f.behavior.posts, 1);
  });
  test(`${mode} terminal unknown input invalidates handle without replay`, async t => {
    const f = await fixture(t, mode), id = await startTerminal(f);
    f.behavior.transport = async (request, response) => { if (new URL(request.url).pathname.endsWith('/input')) throw Error('PRIVATE_EXTENSION'); return response; };
    const input = () => f.app.fetch(f.terminalRequest(`/${id}/input`, 'POST', { sequence: 1, data: 'private input' }));
    assert.equal((await input()).status, 502); assert.equal((await input()).status, 404); assert.equal(f.behavior.posts, 2);
  });
  for (const mutation of ['revoke', 'epoch'] as const) test(`${mode} terminal output ${mutation} withholds late data`, async t => {
    const f = await fixture(t, mode), id = await startTerminal(f);
    f.behavior.transport = async (request, response) => {
      if (new URL(request.url).pathname.endsWith('/output')) { if (mutation === 'revoke') await f.revoke(); else await f.change(true); }
      return response;
    };
    const response = await f.app.fetch(f.terminalRequest(`/${id}/output?cursor=0`));
    assert.equal(response.status, mutation === 'revoke' ? 401 : 403); assert.equal((await response.text()).includes('output'), false);
    assert.equal(f.behavior.posts, 1);
  });
  test(`${mode} terminal close retains body admission without late start`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    t.after(() => release.resolve()); f.behavior.resolving = async () => { entered.resolve(); };
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      await release.promise; stream.enqueue(new TextEncoder().encode(JSON.stringify(terminalStart()))); stream.close();
    } });
    const response = f.app.fetch(new Request(f.terminalRequest('', 'POST'), { body, duplex: 'half' } as RequestInit));
    await entered.promise;
    for (let i = 0; !body.locked && i < 10_000; i++) await tick();
    assert.equal(body.locked, true);
    let drained = false; const closing = f.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing; assert.equal(f.behavior.posts, 0);
  });
  test(`${mode} terminal close waits late start ACK then cleanup DELETE and audit ACK`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), started = deferred(), releaseStart = deferred(), deleted = deferred(), releaseDelete = deferred(), audited = deferred(), releaseAudit = deferred();
    t.after(() => { releaseStart.resolve(); releaseDelete.resolve(); releaseAudit.resolve(); });
    f.behavior.transport = async (request, response) => {
      if (request.method === 'POST') { started.resolve(); await releaseStart.promise; }
      if (request.method === 'DELETE') { deleted.resolve(); await releaseDelete.promise; }
      return response;
    };
    f.behavior.after = async kind => { if (kind === 'auditAppend') { audited.resolve(); await releaseAudit.promise; } };
    const response = f.app.fetch(f.terminalRequest('', 'POST', terminalStart())); await started.promise;
    let drained = false; const closing = f.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false); releaseStart.resolve();
    await Promise.all([deleted.promise, audited.promise]); await tick(); assert.equal(drained, false);
    releaseDelete.resolve(); await tick(); assert.equal(drained, false); releaseAudit.resolve();
    assert.equal((await response).status, 503); await closing;
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.calls.filter(path => /\/terminals\/[^/]+$/.test(path)).length, 1);
    assert.equal((await f.app.fetch(f.terminalRequest('/targets'))).status, 503);
  });
  test(`${mode} terminal stop owns simultaneous DELETE and audit until shutdown drains`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), id = await startTerminal(f), deleted = deferred(), audited = deferred(), release = deferred();
    t.after(() => release.resolve());
    f.behavior.transport = async (request, response) => { if (request.method === 'DELETE') { deleted.resolve(); await release.promise; } return response; };
    f.behavior.after = async kind => { if (kind === 'auditAppend') { audited.resolve(); await release.promise; } };
    const response = f.app.fetch(f.terminalRequest(`/${id}`, 'DELETE')); await Promise.all([deleted.promise, audited.promise]);
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); assert.equal((await response).status, 503); await closing;
  });
  test(`${mode} terminal timer is single-flight and retains original command through shutdown`, { timeout: 20_000 }, async t => {
    // The production interval and node:test timeout are both unref'ed.
    const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
    const f = await fixture(t, mode); await startTerminal(f);
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    f.behavior.after = async kind => { if (kind === 'connectorAccess') { entered.resolve(); await release.promise; } };
    // Production intervals are intentionally unref'ed. Keep this assertion
    // alive until the original scan enters, without changing its ownership.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered.promise, new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Original terminal scan did not enter')), 15_000);
    })]); } finally { clearTimeout(watchdog); }
    const count = f.behavior.commands.length;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(f.behavior.commands.length, count, 'another interval cannot overlap the pending scan');
    let drained = false; const closing = f.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    release.resolve(); await closing;
  });
}
