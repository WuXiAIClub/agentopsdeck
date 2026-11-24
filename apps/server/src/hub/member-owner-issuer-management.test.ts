import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubIssuerManagement } from './async-issuer-management.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubIssuerManagementCommand, validHubIssuerManagementResult } from './member-issuer-management-domain.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerHubExecutionIssuerRoutes } from '../routes/hub-execution-issuers.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const forbidden = () => { throw Error('synchronous issuer management bypass'); };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Owner = Pick<AsyncHubMemberOwner, 'command'>;
const decorate = (fn: (kind: Parameters<Owner['command']>[0], input: unknown) => Promise<unknown>): Owner => ({ command: fn as Owner['command'] });

async function fixture(t: TestContext, mode: 'original' | 'worker', transport: 'local' | 'http' = 'local') {
  const root = mkdtempSync(join(tmpdir(), 'issuer-management-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-vault'), db = new DatabaseSync(':memory:');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), nodeId = `node_${randomUUID()}`;
  const connector = new Hono(), grants = new ExecutionGrants(db, id => !!tokens.delegationHubId(id));
  connector.use('*', async (c, next) => { c.header(NODE_ID_HEADER, nodeId); await next(); });
  registerExecutionGrantRoutes(connector, { nodeId, tokens, grants });
  const behavior = { after: undefined as (() => Promise<void>) | undefined, failCreation: false,
    cleanup: undefined as (() => void) | undefined,
    wrap: undefined as ((response: Response) => Response) | undefined, calls: [] as Request[], created: 0, revoked: [] as string[] };
  const dispatch = async (request: Request) => {
    behavior.calls.push(request);
    if (request.url.endsWith('/creation') && behavior.failCreation) return Response.json({ error: 'unsupported' }, { status: 404 });
    const response = await connector.fetch(request);
    if (request.url.endsWith('/issuer')) await behavior.after?.();
    return behavior.wrap ? behavior.wrap(response) : response;
  };
  const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(r => server.once('listening', r));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.example.invalid';
  const local = transport === 'local' ? { connectionId: 'node', token: 'unused-ordinary-token', dispatch } : undefined;
  seed.upsertConnection({ id: 'node', kind: local ? 'local' : 'remote', label: 'Fixture', connectorUrl: origin });
  seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node')!, nodeId);
  const hubId = seed.identities.hubId, version = seed.connectionAuthority('node')!;
  const login = seed.identities.issueKey('default'), member = seed.createUser('Member'), memberLogin = seed.identities.issueKey(member.id);
  // A member key is not a bootstrap administrator. Seed the persistent role
  // on the sole original owner before reopening it in either test mode.
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default', 'admin', 1)").run();
  const issue = (createSessions = true, ownerHub = hubId) => tokens.create({ label: 'Synthetic dedicated issuer', delegationHubId: ownerHub,
    scopes: ['execution:delegate', 'messages:send', ...(createSessions ? ['sessions:create' as const] : [])] });
  const credential = issue();
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'synthetic-vault') : undefined;
  const owner = original ? new OriginalHubAdministrativeCommands(original, quiet) : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, quiet);
  const operator = { create: (hub: string, creation = false) => { behavior.created++; return issue(creation, hub); },
    revoke: (id: string) => { behavior.revoked.push(id); return tokens.revoke(id); } };
  const services = createHubConnectorReadServices(owner, local, quiet, undefined, operator);
  const app = new Hono();
  registerHubExecutionIssuerRoutes(app, { mode: 'async', asyncManagement: services.issuerManagement });
  const path = '/api/hub/v1/connections/node/execution-issuer';
  const request = (method = 'GET', body?: unknown, suffix = '', token = login.token, signal?: AbortSignal) => new Request('http://hub.example.invalid' + path + suffix,
    { method, headers: { 'x-agentopsdeck-key': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  const proof = async () => {
    const evidence = hubMemberEvidence(request()), snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    return { evidence, expectedScope: snapshot.recoveryScope };
  };
  const disable = async () => owner.command('issuerManagement', { ...await proof(), command: { action: 'disable', connectionId: 'node' } });
  const patchDisabled = async () => {
    const p = await proof(); const target = await owner.command('connectionTarget', { ...p, id: 'node' });
    assert.ok(target && 'epoch' in target);
    return owner.command('connectionChange', { ...p, change: { action: 'patch', id: 'node', expectedEpoch: target.epoch, configuration: { enabled: false } } });
  };
  t.after(async () => {
    behavior.cleanup?.();
    await services.close(); await owner.close(); await original?.close(); db.close();
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, app, owner, original, services, local, operator, tokens, behavior, request, credential, issue, version, hubId, login, memberLogin,
    proof, disable, patchDisabled, file };
}

for (const mode of ['original', 'worker'] as const) for (const transport of ['local', 'http'] as const) {
  const name = `${mode}/${transport}`;
  test(`${name}: four management routes preserve frontend wire and sole-owner policy`, async t => {
    const f = await fixture(t, mode, transport);
    const initial = await f.app.fetch(f.request()); assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await initial.json(), { hubId: f.hubId, localSetupAllowed: transport === 'local', issuer: null });
    const installed = await f.app.fetch(f.request('PUT', { token: f.credential.token }));
    assert.equal(installed.status, 200, await installed.clone().text());
    const body = await installed.json();
    assert.deepEqual(body, { hubId: f.hubId, issuer: { issuerId: f.credential.record.id, nodeId: (await (await f.app.fetch(f.request())).json()).issuer.nodeId,
      version: f.version + 1, creationAllowed: true } });
    assert.equal(JSON.stringify(body).includes(f.credential.token), false);
    assert.ok(f.behavior.calls.every(r => r.method === 'GET' && !r.headers.has('x-agentopsdeck-maintenance-key')));
    if (transport === 'local') {
      const repeat = await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: body.issuer.version, createSessions: true }, '/local'));
      assert.equal(repeat.status, 200); assert.equal(f.behavior.created, 0);
    } else assert.equal((await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: body.issuer.version }, '/local'))).status, 403);
    assert.equal((await f.app.fetch(f.request('DELETE'))).status, 200);
    assert.equal((await f.app.fetch(f.request('DELETE'))).status, 200);
    assert.equal((await (await f.app.fetch(f.request())).json()).issuer, null);
    assert.equal((await f.app.fetch(f.request('GET', undefined, '', f.memberLogin.token))).status, 404);
    assert.equal((await f.app.fetch(f.request('GET', undefined, '', 'invalid'))).status, 401);
  });
  test(`${name}: capability optional for PUT, mandatory for explicit local creation upgrade`, async t => {
    const f = await fixture(t, mode, transport); f.behavior.failCreation = true;
    const response = await f.app.fetch(f.request('PUT', { token: f.credential.token })); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.issuer.creationAllowed, undefined);
    if (transport === 'local') {
      assert.equal((await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: body.issuer.version, createSessions: true }, '/local'))).status, 409);
      assert.equal(f.behavior.created, 1); assert.equal(f.behavior.revoked.length, 1);
      assert.equal((await (await f.app.fetch(f.request())).json()).issuer.issuerId, f.credential.record.id);
    }
  });
  test(`${name}: authority changes during original verification cannot install`, async t => {
    const f = await fixture(t, mode, transport); f.behavior.after = async () => { await f.patchDisabled(); };
    assert.equal((await f.app.fetch(f.request('PUT', { token: f.credential.token }))).status, 409);
    assert.equal((await (await f.app.fetch(f.request())).json()).issuer, null);
  });
  test(`${name}: invalid frontend input and wrong hub never install or leak credentials`, async t => {
    const f = await fixture(t, mode, transport);
    for (const raw of [null, [], {}, { token: 1 }, { token: 'secret', permission: true }]) {
      assert.equal((await f.app.fetch(f.request('PUT', raw))).status, 400);
    }
    const wrong = f.issue(true, 'another-hub');
    const response = await f.app.fetch(f.request('PUT', { token: wrong.token }));
    assert.equal(response.status, 409); assert.equal((await response.text()).includes(wrong.token), false);
    assert.equal((await (await f.app.fetch(f.request())).json()).issuer, null);
  });
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: local provision pins original target and issues exactly once`, async t => {
    const f = await fixture(t, mode);
    for (const body of [{}, { confirm: true }, { confirm: false, nodeVersion: f.version },
      { confirm: true, nodeVersion: f.version, extra: true }, { confirm: true, nodeVersion: f.version, createSessions: 'yes' }]) {
      assert.ok([400, 409].includes((await f.app.fetch(f.request('POST', body, '/local'))).status));
    }
    const response = await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: f.version, createSessions: true }, '/local'));
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json(); assert.equal(body.issuer.creationAllowed, true);
    assert.equal(f.behavior.created, 1); assert.deepEqual(f.behavior.revoked, []);
    assert.equal((await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: f.version }, '/local'))).status, 409);
    assert.equal((await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: body.issuer.version }, '/local'))).status, 200);
    assert.equal(f.behavior.created, 1);
  });
  test(`${mode}: unknown install ACK after rotation retains historically installed issuer`, async t => {
    const f = await fixture(t, mode); let install = 0;
    const owner = decorate(async (kind, input) => {
      const result = await f.owner.command(kind, input as never);
      if (kind === 'issuerManagement' && (input as { command: { action: string } }).command.action === 'install') {
        install++; await f.disable(); throw Error('lost original install ACK after retirement');
      }
      return result;
    });
    const service = new AsyncHubIssuerManagement(owner, f.local, f.operator, quiet); t.after(() => service.close());
    const request = await service.open(f.request(), 'node');
    await assert.rejects(request.provision(f.version, true));
    assert.equal(install, 1); assert.equal(f.behavior.created, 1); assert.deepEqual(f.behavior.revoked, []);
    assert.equal((await (await f.app.fetch(f.request())).json()).issuer, null);
  });
  test(`${mode}: unknown cleanup ACK retains token and does not repeat creation`, async t => {
    const f = await fixture(t, mode); f.behavior.failCreation = true;
    const owner = decorate(async (kind, input) => {
      const result = await f.owner.command(kind, input as never);
      if (kind === 'issuerManagement' && (input as { command: { action: string } }).command.action === 'cleanup') throw Error('lost cleanup ACK');
      return result;
    });
    const service = new AsyncHubIssuerManagement(owner, f.local, f.operator, quiet); t.after(() => service.close());
    await assert.rejects((await service.open(f.request(), 'node')).provision(f.version, true));
    assert.equal(f.behavior.created, 1); assert.deepEqual(f.behavior.revoked, []);
  });
  test(`${mode}: identity revoked during probe prevents install and cleanup effects`, async t => {
    const f = await fixture(t, mode);
    f.behavior.after = async () => {
      const evidence = hubMemberEvidence(f.request());
      const snapshot = await f.owner.command('memberSnapshot', evidence); assert.ok(snapshot);
      const result = await f.owner.command('memberKeyRevoke', { evidence, userId: snapshot.principal.userId,
        expectedScope: snapshot.recoveryScope, keyId: f.login.id });
      assert.ok(result?.ok);
    };
    assert.equal((await f.app.fetch(f.request('POST', { confirm: true, nodeVersion: f.version }, '/local'))).status, 401);
    assert.equal(f.behavior.created, 1); assert.deepEqual(f.behavior.revoked, []);
  });
  test(`${mode}: pending local workflow retains original create ACK across cancellation and close`, { timeout: 15000 }, async t => {
    const f = await fixture(t, mode), entered = gate(), ack = gate();
    f.behavior.cleanup = ack.resolve;
    const operator = { ...f.operator, create: async (hub: string, creation = false) => {
      entered.resolve(); await ack.promise; return f.operator.create(hub, creation);
    } };
    const service = new AsyncHubIssuerManagement(f.owner, f.local, operator, quiet);
    t.after(async () => { ack.resolve(); await service.close(); });
    const controller = new AbortController(), request = await service.open(f.request('GET', undefined, '', f.login.token, controller.signal), 'node');
    const pending = request.provision(f.version, true); const outcome = assert.rejects(pending);
    await entered.promise; controller.abort();
    await assert.rejects((await service.open(f.request(), 'node')).provision(f.version, true), (e: unknown) =>
      !!e && typeof e === 'object' && 'status' in e && e.status === 409);
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); ack.resolve(); await outcome; await closing;
    assert.equal(f.behavior.created, 1); assert.equal(f.behavior.calls.length, 0);
    assert.deepEqual(f.behavior.revoked, []); // Closed owner cannot confirm safe cleanup.
  });
  if (mode === 'original') test(`${mode}: production middleware uses async proof and refuses board capabilities first`, async t => {
    const f = await fixture(t, mode), config = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
    let guarded = false, principals = 0;
    const store = new Proxy(f.original!, { get(target, key, receiver) { if (guarded) throw Error('production synchronous management bypass'); return Reflect.get(target, key, receiver); } });
    const hub = new Hono(); const routes = registerHubRoutes(hub, { config, hubStore: store, connectorClient: forbidden,
      principal: () => { principals++; return undefined; }, asyncIssuerManagement: f.services.issuerManagement, normalizeError: () => 'safe' });
    try {
      guarded = true;
      assert.equal((await hub.fetch(f.request())).status, 200);
      assert.equal((await hub.fetch(f.request('HEAD'))).status, 200);
      assert.equal((await hub.fetch(f.request('PUT', { token: f.credential.token }))).status, 200);
      assert.equal(principals, 0);
      assert.equal((await hub.fetch(f.request('GET', undefined, '', 'aod_board_synthetic'))).status, 401);
      assert.equal((await hub.fetch(f.request('GET', undefined, '', 'aod_note_synthetic'))).status, 401);
      assert.equal(principals, 0);
      assert.equal((await hub.fetch(f.request('POST'))).status, 401); assert.equal(principals, 1);
    } finally { guarded = false; await routes?.close(); }
  });
  test(`${mode}: broken diagnostic callbacks cannot replace original create or install ACK`, async t => {
    for (const failure of ['start', 'add', 'finish'] as const) {
      const f = await fixture(t, mode), diagnostics = new PerformanceDiagnostics(() => {});
      const original = diagnostics.start.bind(diagnostics);
      diagnostics.start = operation => {
        if (operation !== 'hub-issuer-management-effect') return original(operation);
        if (failure === 'start') throw Error('synthetic diagnostic failure');
        return { add() { if (failure === 'add') throw Error('synthetic metric failure'); },
          reportPending() {}, finish() { if (failure === 'finish') throw Error('synthetic finish failure'); } };
      };
      const service = new AsyncHubIssuerManagement(f.owner, f.local, f.operator, diagnostics);
      t.after(() => service.close());
      const result = await (await service.open(f.request(), 'node')).provision(f.version, true);
      assert.equal(result.status, 201); assert.equal(f.behavior.created, 1);
      assert.deepEqual(f.behavior.revoked, []);
      assert.equal((await (await f.app.fetch(f.request())).json()).issuer.issuerId, result.issuer.issuerId);
      await service.close();
    }
  });
  test(`${mode}: diagnostic reentrant close fences the original create before execution`, { timeout: 15000 }, async t => {
    const f = await fixture(t, mode), diagnostics = new PerformanceDiagnostics(() => {});
    const original = diagnostics.start.bind(diagnostics);
    let closing: Promise<void> | undefined;
    const service = new AsyncHubIssuerManagement(f.owner, f.local, f.operator, diagnostics);
    t.after(() => service.close());
    diagnostics.start = operation => {
      if (operation === 'hub-issuer-management-effect') closing = service.close();
      return original(operation);
    };
    await assert.rejects((await service.open(f.request(), 'node')).provision(f.version, true));
    assert.ok(closing); await closing;
    assert.equal(f.behavior.created, 0); assert.deepEqual(f.behavior.revoked, []);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: abort retains original dispatch and late body cancellation until ACK`, { timeout: 15000 }, async t => {
    const f = await fixture(t, mode), entered = gate(), release = gate(), cancelEntered = gate(), cancelAck = gate();
    f.behavior.cleanup = () => { release.resolve(); cancelAck.resolve(); };
    f.behavior.after = async () => { entered.resolve(); await release.promise; };
    f.behavior.wrap = response => new Response(new ReadableStream({
      async cancel() { cancelEntered.resolve(); await response.body?.cancel(); await cancelAck.promise; },
    }), { status: response.status, headers: response.headers });
    const abort = new AbortController();
    const pending = f.app.fetch(f.request('PUT', { token: f.credential.token }, '', f.login.token, abort.signal));
    await entered.promise; abort.abort(); assert.equal((await pending).status, 499);
    let closed = false; const closing = f.services.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    release.resolve(); await cancelEntered.promise; await tick(); assert.equal(closed, false);
    cancelAck.resolve(); await closing; assert.equal(closed, true);
  });
}

test('original: vault/SQL failure and capacity preserve installed credential and authority atomically', async t => {
  const f = await fixture(t, 'original'), db = (f.original! as unknown as { db: DatabaseSync }).db;
  assert.equal((await f.app.fetch(f.request('PUT', { token: f.credential.token }))).status, 200);
  const before = await (await f.app.fetch(f.request())).json();
  const credentialCount = () => db.prepare('SELECT count(*) AS n FROM env_credentials').get()!.n;
  const initialCredentials = credentialCount();
  for (const table of ['env_credentials', 'hub_execution_issuers']) {
    db.exec(`CREATE TEMP TRIGGER issuer_management_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    try {
      const replacement = f.issue(); assert.equal((await f.app.fetch(f.request('PUT', { token: replacement.token }))).status, 503);
      assert.deepEqual(await (await f.app.fetch(f.request())).json(), before);
      assert.equal(credentialCount(), initialCredentials);
      assert.equal(db.prepare('SELECT count(*) AS n FROM hub_execution_issuers').get()!.n, 1);
    } finally { db.exec('DROP TRIGGER issuer_management_failure'); }
  }
  (f.original!.executionIssuers as unknown as { maxRows: number }).maxRows = 1;
  assert.equal((await f.app.fetch(f.request('PUT', { token: f.issue().token }))).status, 503);
  assert.deepEqual(await (await f.app.fetch(f.request())).json(), before);
});

test('issuer management private protocol rejects arbitrary proof, targets, tokens and reply fields', () => {
  assert.equal(validHubIssuerManagementCommand({ action: 'read', connectionId: 'node', admin: true }), false);
  assert.equal(validHubIssuerManagementCommand({ action: 'install', connectionId: 'node', local: false, pin: 'a'.repeat(64),
    token: 'has spaces', issuerId: 'id', creationAllowed: true }), false);
  assert.equal(validHubIssuerManagementCommand({ action: 'cleanup', connectionId: 'node', issuerId: 'id' }), true);
  assert.equal(validHubIssuerManagementResult({ connectionId: 'node', data: { action: 'install', issuer: null } }), false);
  assert.equal(validHubIssuerManagementResult({ connectionId: 'node', data: { action: 'disable', token: 'secret' } }), false);
});
