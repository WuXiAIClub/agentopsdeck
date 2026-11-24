import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import type { NodeGrantPolicy } from './node-grants.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { AsyncHubSharedCreation } from './async-shared-creation.js';
import { AsyncHubCreationDiscovery } from './async-creation-discovery.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { validHubSharedCreationCommand, validHubSharedCreationReply, validHubSharedCreationResult } from './member-shared-creation-domain.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { createConnectorOwnerCommands } from '../connector/connector-owner-domain.js';
import { AsyncCodexCreation } from '../connector/async-codex-creation.js';
import { registerCodexCreationHttp } from '../connector/codex-creation-http.js';
import { AsyncHubMemberMemberships } from './async-member-memberships.js';
import { AsyncHubSessionCollaborators } from './async-session-collaborators.js';
import { AsyncHubSessionSharing } from './async-session-sharing.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { registerCreationReceipts } from '../commands/http.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerHubSharedCreationRoutes } from '../routes/hub-shared-creation.js';
import { registerAsyncHubSharedCreation, isAsyncHubSharedCreationRequest } from '../routes/hub-shared-creation-async.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
import { registerHubRoutes } from '../routes/hub.js';
import { decodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { loadConfig } from '../config.js';

const quiet = new PerformanceDiagnostics(() => {});
const forbidden = () => { throw Error('synchronous shared-creation bypass'); };
const forbiddenStore = new Proxy({} as HubStore, { get: forbidden });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Owner = Pick<AsyncHubMemberOwner, 'command'>;
const decorate = (fn: (kind: HubMemberKind, input: unknown) => Promise<unknown>): Owner => ({ command: fn as Owner['command'] });
const policy: NodeGrantPolicy = { runtime: 'codex', actions: ['sessions:create', 'sessions:read', 'messages:read', 'messages:send'] };

async function fixture(t: TestContext, mode: 'original' | 'worker', transport: 'local' | 'http' = 'local', productionCreation = false) {
  const root = mkdtempSync(join(tmpdir(), 'shared-creation-owner-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-vault'), users = new ConnectorUserStore(join(root, 'connector.sqlite'), undefined,
    productionCreation ? { runtimeOwner: true } : undefined);
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), connector = new Hono();
  const member = seed.createUser('Member'), outsider = seed.createUser('Outsider');
  const login = seed.identities.issueKey(member.id), ownerLogin = seed.identities.issueKey('default'), outside = seed.identities.issueKey(outsider.id);
  const second = productionCreation ? seed.createUser('Second member') : undefined;
  const secondLogin = second ? seed.identities.issueKey(second.id) : undefined;
  const target = { ownerUserId: 'default', connectionId: 'node' };
  const behavior = { posts: 0, writes: 0, reads: 0, unavailable: false, lost: false, wrongKey: false, reject: false,
    native: 'codex:created/空 格', after: undefined as (() => Promise<void>) | undefined,
    wrapResponse: undefined as ((response: Response) => Response) | undefined };
  connector.use('*', async (context, next) => { context.header(NODE_ID_HEADER, users.nodeId); await next(); });
  registerExecutionGrantRoutes(connector, { nodeId: users.nodeId, tokens, grants: users.executionGrants });
  const connectorPath = '/api/connector/v1/agents/:agentId/sessions';
  const connectorOwner = productionCreation ? createConnectorOwnerCommands(users, tokens, undefined, undefined, undefined, false) : undefined;
  const connectorCreation = connectorOwner ? new AsyncCodexCreation({ owner: { command: connectorOwner }, deadlineMs: 10_000,
    diagnostics: quiet, native: { available: () => true, async createSessionOwned(_intent, port) {
      // Only the native/model boundary is substituted: admission, journal,
      // ready/identity/accept and the HTTP guard are the production services.
      await port.ready(); behavior.writes++;
      const id = randomUUID(); behavior.native = `codex:${id}`;
      await port.identify(id); await port.nameReady(); await port.accept();
      return { key: behavior.native };
    } } }) : undefined;
  if (connectorCreation) registerCodexCreationHttp(connector, '/api/connector/v1', {
    creation: connectorCreation, ready: () => true, diagnostics: quiet,
  });
  else {
    registerCreationReceipts(connector, connectorPath, { receipts: users.commands, scope: context => {
      const principal = tokens.requireScope(context.req.raw, 'sessions:create');
      if (!principal) throw new HTTPException(403);
      return JSON.stringify([principal.tokenId, context.req.param('agentId')]);
    } });
    connector.post(connectorPath, context => {
      if (behavior.reject) return context.json({ error: 'private upstream error' }, 409);
      behavior.writes++;
      const body = { key: behavior.native, private: 'private Connector payload' };
      context.get('acknowledgeCreation')({ status: 201, body });
      return context.json(body, 201);
    });
  }
  const calls: Request[] = [];
  const dispatch = async (request: Request) => {
    const creation = new URL(request.url).pathname.includes('/agents/');
    if (creation) {
      calls.push(request);
      if (behavior.unavailable) return Response.json({ error: 'offline' }, { status: 503 });
      if (request.method === 'POST') behavior.posts++; else behavior.reads++;
    }
    let response = await connector.fetch(request);
    if (creation && request.method === 'POST') {
      await behavior.after?.();
      if (behavior.lost) return Response.json({ error: 'original ACK lost' }, { status: 503 });
    }
    if (creation && behavior.wrongKey) {
      const body = await response.json() as { command?: { key: string } };
      if (body.command) body.command.key = 'wrong-delivery';
      response = new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }
    return creation && request.method === 'POST' && behavior.wrapResponse ? behavior.wrapResponse(response) : response;
  };
  const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(r => server.once('listening', r));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.example.invalid';
  const local = transport === 'local' ? { connectionId: 'node', token: 'unused-maintenance-token', dispatch } : undefined;
  seed.upsertConnection({ id: 'node', kind: transport === 'local' ? 'local' : 'remote', label: 'Fixture', connectorUrl: origin });
  seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node')!, users.nodeId);
  const issuer = tokens.create({ label: 'Synthetic dedicated issuer', delegationHubId: seed.identities.hubId,
    scopes: ['execution:delegate', 'messages:read', 'messages:send', 'sessions:create'] });
  await seed.executionIssuers.configure('default', 'node', issuer.token, () => {}, local);
  const nodeVersion = seed.connectionAuthority('node')!;
  if (productionCreation) for (const user of [member, second!]) {
    const memberTarget = { ...target, userId: user.id }, actor = { userId: 'default', admin: false };
    seed.roles.save(actor, memberTarget, { role: 'developer', version: 0, nodeVersion,
      environments: { codex: 'developer', openclaw: 'disabled' }, migrateLegacy: true,
      grantSetDigest: seed.roles.snapshot(actor, memberTarget).grantSetDigest });
  }
  const grant = productionCreation ? seed.grants.get(target, seed.grants.authorize({ ...target, userId: member.id },
    'sessions:create', { runtime: 'codex' })!.grantId)! : seed.grants.create({ ...target, userId: member.id }, policy);
  await seed.close();
  let original: HubStore | undefined, owner: AsyncHubMemberOwner | OriginalHubAdministrativeCommands;
  let services: ReturnType<typeof createHubConnectorReadServices>, app: Hono;
  let routes: ReturnType<typeof registerAsyncHubSharedCreation>;
  const base = '/api/hub/v1/shared/default/connections/node/agents/codex/sessions';
  const request = (suffix = '', token = login.token, init: RequestInit = {}) => new Request('http://hub.example.invalid' + base + suffix,
    { ...init, headers: { authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers)) } });
  const open = () => {
    original = mode === 'original' ? new HubStore(file, 'synthetic-vault') : undefined;
    owner = original ? new OriginalHubAdministrativeCommands(original, quiet) : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, quiet);
    services = createHubConnectorReadServices(owner, local, quiet);
    app = new Hono();
    routes = registerAsyncHubSharedCreation(app, { mode: 'async',
      creation: services.sharedCreation, discovery: services.creationDiscovery, diagnostics: quiet });
  };
  open();
  const change = async (action: 'revoke' | 'replace') => {
    const evidence = hubMemberEvidence(request('', ownerLogin.token));
    const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    const common = { target, id: grant.id, version: grant.version, nodeVersion };
    const command = action === 'replace' ? { ...common, action, policy } : { ...common, action };
    const result = await owner.command('grantChange', { evidence, expectedScope: snapshot.recoveryScope, command });
    assert.ok(result && !('error' in result), JSON.stringify(result));
  };
  t.after(async () => {
    await routes.close(); await services.close(); await owner.close(); await original?.close();
    await connectorCreation?.close(); connectorOwner?.dispose(); await users.close();
    if (server) {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, behavior, local, target, grant, calls, request, change, member, login, outside, second, secondLogin, ownerToken: ownerLogin.token,
    closeRoutes: () => routes.close(),
    owner: () => owner, original: () => original, services: () => services, app: () => app,
    post: (key: string, label = 'Shared session', headers: Record<string, string> = {}, token = login.token) => app.fetch(request('', token,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ label, idempotencyKey: key }) })),
    get: (key: string, token = login.token) => app.fetch(request('/creation-commands/' + key, token)),
    restart: async () => { await routes.close(); await services.close(); await owner.close(); await original?.close(); open(); },
    rotate: async () => {
      // Reconfigure with a sole offline owner, then reopen the actual command
      // owner. Never introduce a second writer while the worker is alive.
      await routes.close(); await services.close(); await owner.close(); await original?.close();
      const next = new HubStore(file, 'synthetic-vault');
      try {
        await next.executionIssuers.configure('default', 'node', issuer.token, () => {}, local);
        next.grants.create({ ...target, userId: member.id }, policy);
      } finally { await next.close(); }
      open();
    },
  };
}

for (const mode of ['original', 'worker'] as const) for (const transport of ['local', 'http'] as const) {
  const name = `${mode}/${transport}`;
  test(`${name}: production Connector creation composes with managed members, isolated receipts and explicit sharing`, async t => {
    const f = await fixture(t, mode, transport, true), secondToken = f.secondLogin!.token;
    let sharing = new AsyncHubSessionSharing(f.owner(), quiet), collaborators = new AsyncHubSessionCollaborators(f.owner(), quiet);
    t.after(async () => { await sharing.close(); await collaborators.close(); });
    for (const token of [f.login.token, secondToken]) {
      assert.equal((await f.services().creationDiscovery.environments(f.request('', token), '')).environments.length, 1);
    }
    const response = await f.post('two-members'); assert.equal(response.status, 201, await response.clone().text());
    const first = await response.json(), firstTarget = { ownerUserId: 'default', sessionId: first.key };
    const own = await f.services().sharedReads.open(f.request(), firstTarget);
    assert.equal((await own.hints()).messagesSend, true); assert.equal((await own.hints()).sessionsShare, true);
    await assert.rejects(f.services().sharedReads.open(f.request('', secondToken), firstTarget),
      e => e instanceof HubMemberRequestError && e.status === 404);
    assert.equal((await f.get('two-members', secondToken)).status, 404);
    const secondResponse = await f.post('two-members', 'Second private', {}, secondToken);
    assert.equal(secondResponse.status, 201, await secondResponse.clone().text());
    const second = await secondResponse.json(); assert.notEqual(second.key, first.key);
    assert.equal(f.behavior.writes, 2);
    await assert.rejects(f.services().sharedReads.open(f.request(), { ownerUserId: 'default', sessionId: second.key }),
      e => e instanceof HubMemberRequestError && e.status === 404);
    const share = await sharing.begin(f.request(), 'default', first.key);
    const observer = (await share.create(f.second!.id, 'observer', {})).grant;
    const observed = await f.services().sharedReads.open(f.request('', secondToken), firstTarget);
    assert.equal((await observed.hints()).messagesSend, false); assert.notEqual((await observed.hints()).sessionsShare, true);
    await assert.rejects(sharing.begin(f.request('', secondToken), 'default', first.key),
      e => e instanceof HubMemberRequestError && e.status === 403);
    const upgraded = (await share.update(observer.id, observer.version, 'collaborator', {})).grant;
    await assert.rejects(observed.read(), e => e instanceof HubMemberRequestError && e.status === 403);
    assert.equal((await (await f.services().sharedReads.open(f.request('', secondToken), firstTarget)).hints()).messagesSend, true);
    assert.equal((await share.remove(upgraded.id, upgraded.version)).ok, true);
    await assert.rejects(f.services().sharedReads.open(f.request('', secondToken), firstTarget),
      e => e instanceof HubMemberRequestError && e.status === 404);
    assert.equal((await collaborators.collaborators(f.request(), 'default', first.key)).collaborators.length, 0);
    await sharing.close(); await collaborators.close(); await f.restart();
    sharing = new AsyncHubSessionSharing(f.owner(), quiet); collaborators = new AsyncHubSessionCollaborators(f.owner(), quiet);
    assert.equal((await f.post('two-members')).status, 201);
    assert.equal((await f.post('two-members', 'Second private', {}, secondToken)).status, 201);
    assert.equal((await f.get('two-members')).status, 200); assert.equal(f.behavior.writes, 2);
    assert.equal((await (await f.services().sharedReads.open(f.request(), firstTarget)).hints()).messagesSend, true);
    await assert.rejects(f.services().sharedReads.open(f.request('', secondToken), firstTarget),
      e => e instanceof HubMemberRequestError && e.status === 404);
  });

  test(`${name}: production lost creation ACK recovers original receipt; membership revocation fences pinned read and share`, async t => {
    const f = await fixture(t, mode, transport, true);
    f.behavior.lost = true; f.behavior.after = async () => { f.behavior.unavailable = true; };
    assert.equal((await f.post('lost-production')).status, 202); assert.equal(f.behavior.writes, 1);
    await f.restart(); assert.equal((await f.post('lost-production')).status, 202); assert.equal(f.behavior.posts, 1);
    f.behavior.unavailable = false;
    const recovered = await (await f.get('lost-production')).json(); assert.equal(recovered.command.state, 'accepted');
    const sessionId = recovered.command.result.body.key, target = { ownerUserId: 'default', sessionId };
    const read = await f.services().sharedReads.open(f.request(), target);
    const sharing = new AsyncHubSessionSharing(f.owner(), quiet), memberships = new AsyncHubMemberMemberships(f.owner(), quiet);
    t.after(async () => { await sharing.close(); await memberships.close(); });
    const share = await sharing.begin(f.request(), 'default', sessionId);
    await share.create(f.second!.id, 'collaborator', {});
    const secondRead = await f.services().sharedReads.open(f.request('', f.secondLogin!.token), target);
    const memberTarget = { ...f.target, userId: f.member.id }, manager = f.request('', f.ownerToken);
    const current = await memberships.read(manager, memberTarget);
    await memberships.set(manager, memberTarget, { role: 'none', version: current.version, nodeVersion: current.nodeVersion,
      environments: current.environments, grantSetDigest: current.grantSetDigest, migrateLegacy: true });
    for (const work of [() => read.read(), () => secondRead.read(), () => share.check()]) {
      await assert.rejects(work(), e => e instanceof HubMemberRequestError && e.status === 403);
    }
    assert.equal((await f.get('lost-production')).status, 403);
    const revoked = await memberships.read(manager, memberTarget);
    await memberships.set(manager, memberTarget, { role: 'developer', version: revoked.version, nodeVersion: revoked.nodeVersion,
      environments: { codex: 'developer', openclaw: 'disabled' }, grantSetDigest: revoked.grantSetDigest, migrateLegacy: true });
    await assert.rejects(f.services().sharedReads.open(f.request('', f.secondLogin!.token), target),
      e => e instanceof HubMemberRequestError && e.status === 404);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
  });

  test(`${name}: real creation/discovery and original GET preserve wire format without synchronous bypass`, async t => {
    const f = await fixture(t, mode, transport);
    const environments = await f.services().creationDiscovery.environments(f.request(), '');
    assert.equal(environments.environments.length, 1);
    const response = await f.post('original'); assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'original'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.ownerUserId, 'default');
    assert.equal(decodeHubSessionId(body.key)?.remoteSessionKey, f.behavior.native);
    assert.equal(body.command.state, 'accepted'); assert.equal(body.private, undefined);
    const read = await (await f.get('original')).json();
    const { result, ...metadata } = read.command;
    assert.deepEqual(metadata, body.command);
    assert.deepEqual(result, { status: 201, body: { key: body.key, ownerUserId: body.ownerUserId } });
    assert.equal((await f.get('missing')).status, 404);
    assert.equal((await f.app().fetch(f.request('', f.outside.token, { method: 'POST' }))).status, 403);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
    assert.ok(f.calls.every(r => !r.headers.has('x-agentopsdeck-maintenance-key')), 'dedicated issuer, not maintenance credential');
  });

  test(`${name}: same payload/key is idempotent across reopen and changed payload conflicts`, async t => {
    const f = await fixture(t, mode, transport);
    assert.equal((await f.post('same')).status, 201); await f.restart();
    assert.equal((await f.post('same')).status, 201); assert.equal((await f.post('same', 'different')).status, 409);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
  });

  test(`${name}: lost native ACK retains intent; reopen recovers only original GET`, async t => {
    const f = await fixture(t, mode, transport);
    f.behavior.lost = true; f.behavior.after = async () => { f.behavior.unavailable = true; };
    assert.equal((await f.post('lost')).status, 202); assert.equal(f.behavior.writes, 1);
    await f.restart(); assert.equal((await f.post('lost')).status, 202); assert.equal(f.behavior.posts, 1);
    f.behavior.unavailable = false;
    const body = await (await f.get('lost')).json(); assert.equal(body.command.state, 'accepted');
    assert.equal(decodeHubSessionId(body.command.result.body.key)?.remoteSessionKey, f.behavior.native);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
  });

  test(`${name}: changed grant after native acceptance fences delivery; new request may recover original result`, async t => {
    const f = await fixture(t, mode, transport);
    f.behavior.after = () => f.change('replace');
    assert.equal((await f.post('replace')).status, 403); assert.equal(f.behavior.writes, 1);
    f.behavior.after = undefined;
    const recovered = await (await f.get('replace')).json(); assert.equal(recovered.command.state, 'accepted');
    assert.equal(f.behavior.posts, 1);
  });

  test(`${name}: revoked grant during native call cannot settle or recover with expired proof`, async t => {
    const f = await fixture(t, mode, transport);
    f.behavior.after = () => f.change('revoke');
    assert.equal((await f.post('revoked')).status, 403); assert.equal((await f.get('revoked')).status, 403);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
  });

  test(`${name}: wrong delivery receipt or non-Codex native identity cannot create ownership`, async t => {
    const f = await fixture(t, mode, transport); f.behavior.wrongKey = true;
    assert.equal((await f.post('wrong')).status, 202);
    f.behavior.wrongKey = false; assert.equal((await (await f.get('wrong')).json()).command.state, 'accepted');
    f.behavior.native = 'claude:not-codex';
    assert.equal((await f.post('runtime')).status, 202); assert.equal((await (await f.get('runtime')).json()).command.state, 'outcome_unknown');
    assert.equal(f.behavior.posts, 2);
  });

  test(`${name}: explicit upstream rejection is safely projected and never repeated`, async t => {
    const f = await fixture(t, mode, transport); f.behavior.reject = true;
    const response = await f.post('rejected'); assert.equal(response.status, 409);
    const text = await response.text(); assert.ok(!text.includes('private upstream')); assert.equal(JSON.parse(text).error, 'Command rejected');
    assert.equal((await f.post('rejected')).status, 409); assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 0);
  });

  for (const status of [400, 401, 403, 409]) test(`${name}: HTTP ${status} after native commit cannot fabricate rejection`, async t => {
    const f = await fixture(t, mode, transport);
    f.behavior.after = async () => { f.behavior.unavailable = true; };
    f.behavior.wrapResponse = () => Response.json({ error: 'proxy refused after effect' }, { status });
    const response = await f.post('committed-unknown');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).command.state, 'outcome_unknown');
    assert.equal((await f.post('committed-unknown')).status, 202);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
    f.behavior.unavailable = false;
    assert.equal((await (await f.get('committed-unknown')).json()).command.state, 'accepted');
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
  });

  test(`${name}: issuer rotation cannot adopt an earlier unknown creation receipt`, async t => {
    const f = await fixture(t, mode, transport);
    f.behavior.lost = true; f.behavior.after = async () => { f.behavior.unavailable = true; };
    assert.equal((await f.post('old-authority')).status, 202);
    f.behavior.unavailable = false; f.behavior.after = undefined;
    await f.rotate();
    assert.equal((await f.get('old-authority')).status, 409);
    assert.equal((await f.post('old-authority')).status, 409);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
  });

  test(`${name}: existing frontend payload/header validation never admits malformed creation`, async t => {
    const f = await fixture(t, mode, transport);
    for (const body of [null, [], {}, { label: '', idempotencyKey: 'bad' }, { label: 'x'.repeat(257), idempotencyKey: 'bad' },
      { label: 'Original', idempotencyKey: 'bad', authority: true }, { label: 'Original', idempotencyKey: 'has spaces' }]) {
      assert.equal((await f.app().fetch(f.request('', f.login.token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).status, 400);
    }
    assert.equal((await f.post('body-key', 'Original', { 'idempotency-key': 'header-key' })).status, 400);
    assert.equal((await f.post('valid-payload', 'Original', { 'content-type': 'application/json' })).status, 201);
    assert.equal(f.behavior.posts, 1);
  });

  test(`${name}: original private scope survives creation and discovery without public-header downgrade`, async t => {
    const f = await fixture(t, mode, transport);
    const request = f.request('', f.login.token, { method: 'POST', body: JSON.stringify({ label: 'Original', idempotencyKey: 'private-pin' }) });
    pinOriginalRequestScope(request, '0'.repeat(64));
    assert.equal((await f.app().fetch(request)).status, 401);
    const discovery = new Request('http://hub.example.invalid/api/hub/v1/shared/creation-environments', { headers: { authorization: `Bearer ${f.login.token}` } });
    pinOriginalRequestScope(discovery, '0'.repeat(64));
    assert.equal((await f.app().fetch(discovery)).status, 401);
    assert.equal((await f.post('public-pin', 'Original', { 'x-agentopsdeck-recovery-scope': 'old' })).status, 409);
    assert.equal(f.behavior.posts, 0);
  });

  test(`${name}: full HTTP body ownership drains before route shutdown without creating a session`, async t => {
    const f = await fixture(t, mode, transport), reading = gate();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const raw = f.request('', f.login.token, { method: 'POST', duplex: 'half',
      body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, pull() { reading.resolve(); } }, { highWaterMark: 0 }),
    } as RequestInit);
    const pending = f.app().fetch(raw); await reading.promise;
    let done = false; const closing = f.closeRoutes().then(() => { done = true; });
    try { await tick(); assert.equal(done, false); }
    finally {
      body.enqueue(new TextEncoder().encode('{"label":"Original","idempotencyKey":"body-close"}')); body.close();
      assert.equal((await pending).status, 503); await closing;
    }
    assert.equal(f.behavior.posts, 0);
  });
}

test('shared creation async production selector is exact', () => {
  assert.equal(isAsyncHubSharedCreationRequest('HEAD', '/api/hub/v1/shared/creation-environments'), true);
  assert.equal(isAsyncHubSharedCreationRequest('POST', '/api/hub/v1/shared/owner/connections/dev/agents/codex/sessions'), true);
  assert.equal(isAsyncHubSharedCreationRequest('GET', '/api/hub/v1/shared/owner/connections/dev/agents/codex/sessions/creation-commands/original'), true);
  assert.equal(isAsyncHubSharedCreationRequest('DELETE', '/api/hub/v1/shared/owner/connections/dev/agents/codex/sessions'), false);
  assert.equal(isAsyncHubSharedCreationRequest('GET', '/api/hub/v1/shared/creation-environments/extra'), false);
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: unknown claim or settlement owner ACK fences request without replay`, async t => {
    const f = await fixture(t, mode);
    for (const action of ['claim', 'observe'] as const) {
      let lost = false, count = 0;
      const owner = decorate(async (kind, input) => {
        const result = await f.owner().command(kind, input as never);
        if (kind === 'sharedCreation') { count++; if ((input as { command: { action: string } }).command.action === action && !lost) { lost = true; throw Error('lost owner ACK'); } }
        return result;
      });
      const creation = new AsyncHubSharedCreation(owner, f.local, quiet); t.after(() => creation.close());
      const auth = await creation.open(f.request(), f.target), before = f.behavior.posts;
      await assert.rejects(auth.send(action, { label: 'Original' }), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
      assert.equal(f.behavior.posts - before, action === 'claim' ? 0 : 1);
      const completed = count; await assert.rejects(auth.recover(action)); await assert.rejects(auth.send(action, { label: 'Original' })); assert.equal(count, completed);
      const recovered = await (await f.get(action)).json(); assert.equal(recovered.command.state, action === 'claim' ? 'outcome_unknown' : 'accepted');
      assert.equal(f.behavior.posts - before, action === 'claim' ? 0 : 1);
    }
  });

  test(`${mode}: malformed action/binding ACK fences retained request`, async t => {
    const f = await fixture(t, mode); let corrupt = false, calls = 0;
    const owner = decorate(async (kind, input) => {
      const result = await f.owner().command(kind, input as never);
      if (kind === 'sharedCreation') { calls++; if (corrupt && result) return { ...result, binding: '0'.repeat(64) }; }
      return result;
    });
    const creation = new AsyncHubSharedCreation(owner, f.local, quiet); t.after(() => creation.close());
    const auth = await creation.open(f.request(), f.target); corrupt = true;
    await assert.rejects(auth.send('bad', { label: 'Original' })); const before = calls;
    await assert.rejects(auth.send('bad', { label: 'Original' })); assert.equal(calls, before); assert.equal(f.behavior.posts, 0);
  });

  test(`${mode}: stale frontend recoveryScope is rejected by creation AND discovery`, async t => {
    const f = await fixture(t, mode), request = new Request(f.request(), { headers: { authorization: `Bearer ${f.login.token}`, 'x-agentopsdeck-recovery-scope': '0'.repeat(64) } });
    await assert.rejects(f.services().sharedCreation.open(request, f.target), (e: unknown) => e instanceof HubMemberRequestError && e.status === 409);
    await assert.rejects(f.services().creationDiscovery.environments(request, ''), (e: unknown) => e instanceof HubMemberRequestError && e.status === 409);
    assert.equal(f.behavior.posts, 0);
  });

  test(`${mode}: close freezes new effects while retaining original network until it settles`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate();
    const creation = new AsyncHubSharedCreation(f.owner(), f.local, quiet);
    f.behavior.after = async () => { entered.resolve(); await finish.promise; };
    const auth = await creation.open(f.request(), f.target);
    const pending = assert.rejects(auth.send('drain', { label: 'Original' })); await entered.promise;
    let drained = false; const close = creation.close().then(() => { drained = true; });
    try { for (let i = 0; i < 5; i++) await tick(); assert.equal(drained, false); await assert.rejects(auth.send('new', { label: 'New' })); }
    finally { finish.resolve(); await pending; await close; }
    f.behavior.after = undefined;
    assert.equal((await (await f.get('drain')).json()).command.state, 'accepted'); assert.equal(f.behavior.posts, 1);
  });

  test(`${mode}: HTTP abort releases only its wait; close retains original SQL ACK`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate(); let hold = false;
    const owner = decorate(async (kind, input) => {
      const result = await f.owner().command(kind, input as never);
      if (kind === 'sharedCreation' && hold) { entered.resolve(); await finish.promise; }
      return result;
    });
    const creation = new AsyncHubSharedCreation(owner, f.local, quiet), abort = new AbortController();
    const auth = await creation.open(new Request(f.request(), { signal: abort.signal }), f.target); hold = true;
    const pending = assert.rejects(auth.recover('missing'), (e: unknown) => e instanceof HubMemberRequestError && e.status === 499);
    await entered.promise; abort.abort(); await pending;
    let drained = false; const close = creation.close().then(() => { drained = true; });
    try { for (let i = 0; i < 5; i++) await tick(); assert.equal(drained, false); }
    finally { finish.resolve(); await close; }
  });

  test(`${mode}: aborted HTTP retains late original dispatch and body cancellation; recovery is GET only`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate(), cancelling = gate(), cancelled = gate();
    const creation = new AsyncHubSharedCreation(f.owner(), f.local, quiet), abort = new AbortController();
    f.behavior.after = async () => { entered.resolve(); await finish.promise; };
    f.behavior.wrapResponse = response => new Response(new ReadableStream<Uint8Array>({
      async cancel() { cancelling.resolve(); await cancelled.promise; await response.body?.cancel(); },
    }), { status: response.status, headers: response.headers });
    const app = new Hono();
    registerHubSharedCreationRoutes(app, { hubStore: forbiddenStore, principal: forbidden, asyncCreation: creation });
    const pending = app.fetch(f.request('', f.login.token, { method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Original', idempotencyKey: 'late-native' }) }));
    await entered.promise; abort.abort();
    let drained = false;
    const close = async () => { await creation.close(); drained = true; };
    let closing: Promise<void> | undefined;
    try {
      assert.equal((await pending).status, 499);
      assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
      closing = close();
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(drained, false, 'native handler has not acknowledged dispatch');
      await assert.rejects(creation.open(f.request(), f.target), { status: 503 });
      finish.resolve(); await cancelling.promise;
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(drained, false, 'late response cancellation is still owned');
    } finally {
      finish.resolve(); cancelled.resolve();
      await pending; await (closing ?? close());
      f.behavior.after = undefined; f.behavior.wrapResponse = undefined;
    }
    assert.equal(drained, true);
    assert.equal((await (await f.get('late-native')).json()).command.state, 'accepted');
    assert.equal((await f.post('late-native', 'Original')).status, 201);
    assert.equal(f.behavior.posts, 1); assert.equal(f.behavior.writes, 1);
    assert.ok(f.behavior.reads >= 1);
  });
}

test('original: session ownership, derived grant and receipt settlement roll back together', async t => {
  const f = await fixture(t, 'original'), db = (f.original()! as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TEMP TRIGGER reject_creation_settle BEFORE UPDATE OF state ON command_receipts BEGIN SELECT RAISE(ABORT, 'synthetic settlement failure'); END");
  assert.equal((await f.post('rollback')).status, 503);
  assert.equal(db.prepare('SELECT count(*) AS n FROM hub_session_owners').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM node_grant_dependencies').get()!.n, 0);
  db.exec('DROP TRIGGER reject_creation_settle');
  assert.equal((await (await f.get('rollback')).json()).command.state, 'accepted');
  assert.equal(db.prepare('SELECT count(*) AS n FROM hub_session_owners').get()!.n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM node_grant_dependencies').get()!.n, 1);
  assert.equal(f.behavior.posts, 1);
});

test('production middleware selects only exact async creation/discovery paths and preserves board credential refusal', async t => {
  const f = await fixture(t, 'original'); let guarded = false, principals = 0;
  const store = new Proxy(f.original()!, { get(target, key, receiver) { if (guarded) throw Error('production synchronous creation bypass'); return Reflect.get(target, key, receiver); } });
  const app = new Hono(), config = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
  const routes = registerHubRoutes(app, { config, hubStore: store, connectorClient: forbidden,
    asyncSharedCreation: f.services().sharedCreation, asyncCreationDiscovery: f.services().creationDiscovery,
    principal: () => { principals++; return undefined; }, normalizeError: () => 'Synthetic' });
  try {
    guarded = true;
    const created = await app.fetch(f.request('', f.login.token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Original', idempotencyKey: 'production' }) }));
    assert.equal(created.status, 201, await created.clone().text());
    assert.equal((await app.fetch(f.request('/creation-commands/production'))).status, 200);
    const discovery = new Request('http://hub.example.invalid/api/hub/v1/shared/creation-environments', { headers: { authorization: `Bearer ${f.login.token}` } });
    assert.equal((await app.fetch(discovery)).status, 200);
    assert.equal((await app.fetch(new Request(discovery, { method: 'HEAD' }))).status, 200);
    assert.equal(principals, 0);
    for (const token of ['aod_board_synthetic', 'aod_note_synthetic']) {
      const board = f.request('/creation-commands/production', token);
      assert.equal((await app.fetch(board)).status, 401); assert.equal(principals, 0);
      assert.equal((await app.fetch(new Request(discovery, { headers: { 'x-agentopsdeck-key': token } }))).status, 401);
    }
    assert.equal((await app.fetch(f.request('/creation-commands/production', 'invalid'))).status, 401); assert.equal(principals, 0);
    assert.equal((await app.fetch(f.request('', f.login.token, { method: 'DELETE' }))).status, 401); assert.equal(principals, 1);
    assert.equal((await app.fetch(f.request('/not-selected'))).status, 401); assert.equal(principals, 2);
  } finally { guarded = false; await routes?.close(); }
});

test('fixed creation protocol denies caller-added authority, mismatched action/binding and malformed snapshots', () => {
  const c = { action: 'prepare' as const, target: { ownerUserId: 'default', connectionId: 'node' } };
  assert.equal(validHubSharedCreationCommand(c), true);
  assert.equal(validHubSharedCreationCommand({ ...c, admin: true }), false);
  assert.equal(validHubSharedCreationCommand({ ...c, target: { ...c.target, userId: 'default' } }), false);
  assert.equal(validHubSharedCreationResult({ binding: '0'.repeat(64), data: { action: 'prepare', pin: '1'.repeat(64) } }), true);
  assert.equal(validHubSharedCreationReply(c, { binding: '0'.repeat(64), data: { action: 'prepare', pin: '1'.repeat(64) } }), false);
  assert.equal(validHubSharedCreationResult({ binding: '0'.repeat(64), data: { action: 'effect', effect: { origin: 'http://connector', credential: 'secret' } } }), false);
});
