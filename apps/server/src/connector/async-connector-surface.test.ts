import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AOD_MODEL_SET_ID, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createAsyncConnectorSurface, type AsyncConnectorSurfaceOptions } from './async-connector-surface.js';
import { ExecutionProjectionChanged } from './execution-projection-inventory.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from './node-identity.js';
import { ConnectorBoardBindings, type BoardBindingPolicy } from './board-bindings.js';
import { loadWorkerBoardTools } from '../tools/workspace-board-worker.js';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { createHubConnectorReadServices } from '../hub/connector-read-services.js';
import { registerHubExecutionIssuerRoutes } from '../routes/hub-execution-issuers.js';
import { Hono } from 'hono';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const authorization = 'Bearer surface-fixture';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'Surface did not converge'); await tick(); }
}
async function fixture(t: TestContext, configure?: (options: AsyncConnectorSurfaceOptions, root: string) => void, workspaceEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'connector-surface-')), logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const boardFiles = { root: join(root, 'workspace-files'), policies: [{ owner: 'tok_bootstrap', runtime: 'codex' as const }] };
  if (workspaceEnabled) mkdirSync(boardFiles.root, { mode: 0o700 });
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: authorization.slice(7), codexBoardTools: false, ...(workspaceEnabled ? { boardFiles } : {}) }, diagnostics);
  await owner.open();
  let surface: Awaited<ReturnType<typeof createAsyncConnectorSurface>> | undefined;
  t.after(async () => {
    try {
      if (hooks.closeFailureExpected) await assert.rejects(surface!.close());
      else await surface?.close();
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
  });
  const sessionTitlesFile = join(root, 'titles.json');
  writeFileSync(sessionTitlesFile, JSON.stringify({ 'agent:main:web:direct:original': 'Preserved title' }));
  const calls = { discovery: 0, native: 0, history: [] as string[], historyClose: 0, bindingClose: 0, samplerClose: 0 };
  const hooks: { discovery?: () => Promise<void>; historyClose?: () => Promise<void>;
    history?: (key: string) => Promise<void>;
    bindingClose?: () => Promise<void>; closeFailureExpected?: boolean } = {};
  const options: AsyncConnectorSurfaceOptions = {
    owner, config: { ...loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json') }), sessionTitlesFile,
      ...(workspaceEnabled ? { boardFiles } : {}),
      sessionThinkingOverridesFile: join(root, 'thinking.json'), hiddenSessionsFile: join(root, 'hidden.json'),
      archivedSessionsFile: join(root, 'archived.json'), pinnedSessionsFile: join(root, 'pinned.json') },
    connector: { environmentId: 'original-env', environmentLabel: 'Original environment' }, diagnostics,
    sampler: { sample: async () => { throw Error('No sample expected'); }, close: async () => { calls.samplerClose++; } },
    bind: ({ deck, snapshot }) => {
      const refreshSessions = async () => {
        calls.discovery++; await hooks.discovery?.();
        if (!deck.getSession('agent:main:web:direct:original')) {
          deck.upsertSession({ sessionKey: 'agent:main:web:direct:original', agentId: 'main', title: 'Native title', status: 'idle' });
        }
      };
      return {
        refreshSessions, agents: () => [], close: async () => { calls.bindingClose++; await hooks.bindingClose?.(); },
        ...(workspaceEnabled ? { workspaceSession: async () => ({ exists: false, ready: false }) } : {}),
        runtimes: {
          codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: root, defaultModel: 'default', approvalPolicy: 'never' } },
          sdk: {}, hermes: { config: { enabled: false, executable: join(root, 'absent-python'), sourceDirectory: root,
            homeDirectory: root, workspace: root, startupTimeoutMs: 1000 }, executionAvailable: () => false, queueChanged: () => {} },
          openclaw: {
            history: { snapshot, refresh: async key => { calls.history.push(key); await hooks.history?.(key); }, historyReady: () => true, invalidate: () => {},
              close: async () => { calls.historyClose++; await hooks.historyClose?.(); } },
            invalidateDiscovery: () => {},
            dispatch: { gateway: { connectionId: () => 'original-connection', prepareWriteConnection: async () => 'original-connection',
              requestBound: async () => { calls.native++; throw Error('No native effect expected'); } },
              native: { available: () => true, epoch: () => 'original-connection' }, allowCliFallback: false, message: text => text },
            recovery: { connectionId: () => 'original-connection', query: async () => ({ status: 'timeout' }) },
            refreshSessions, refreshMessages: async () => {}, nativeSession: () => undefined,
            defaultAgentId: 'main', admissionAvailable: () => true, gatewayStatus: () => 'connected', retryMs: 10_000,
          },
        },
      };
    },
  };
  configure?.(options, root);
  surface = await createAsyncConnectorSurface(options);
  const current = surface;
  const request = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    current.app.request(`/api/connector/v1${path}`, { ...init, headers: { authorization, ...headers } });
  return { root, owner, surface, calls, hooks, logs, request, options };
}

const legacyKey = 'agent:main:web:direct:original';
const legacyBase = `/api/sessions/${encodeURIComponent(legacyKey)}`;

test('model-set routes do not disclose native configuration or filesystem error text', async context => {
  const setup = await fixture(context, (options, root) => {
    const file = join(root, 'synthetic-private-config.json');
    writeFileSync(file, JSON.stringify({ agents: { defaults: { models: {} } } }));
    options.config.connector.openclawConfigFile = file;
    options.config.connector.modelAliases = ['synthetic-model'];
  });
  await setup.surface.start();
  const issued = await setup.owner.command('tokenCreate', { label: 'Synthetic model operator', scopes: ['models:read', 'models:write'] });
  const headers = { authorization: `Bearer ${issued.token}` };
  context.mock.method(fsPromises, 'copyFile', async () => { throw Error('SYNTHETIC-PRIVATE-PATH prompt contents arbitrary diagnostic'); });
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const response = await setup.request('/gateway/model-set/reconcile', headers, {
    method: 'POST', body: JSON.stringify({ setId: AOD_MODEL_SET_ID }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Model set reconciliation unavailable' });
  context.mock.method(fsPromises, 'readFile', async () => { throw Error('SYNTHETIC-PRIVATE-PATH arbitrary native diagnostic'); });
  syncBuiltinESMExports();
  const status = await setup.request('/gateway/model-set', headers);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).error, 'Model set status unavailable');
  const result = await setup.request('/gateway/model-set/reconcile', headers, {
    method: 'POST', body: JSON.stringify({ setId: AOD_MODEL_SET_ID }),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status.error, 'Model set status unavailable');
});

test('prepare restores private bindings without activating discovery or publishing transport', async t => {
  const f = await fixture(t, options => { options.config.serverRole = 'all'; });
  const preparation = f.surface.prepare(); assert.equal(f.surface.prepare(), preparation);
  await preparation;
  assert.equal(f.surface.prepared, true); assert.equal(f.surface.ready, false);
  assert.equal(f.surface.state, 'prepared'); assert.equal(f.calls.discovery, 0); assert.equal(f.calls.native, 0);
  assert.throws(() => f.surface.localHubLink());
  const { local } = f.surface.localHubLink({ allowPrepared: true });
  const request = new Request('http://local/api/connector/v1/identity');
  assert.equal((await local.dispatch(request)).status, 503);
  const starting = f.surface.start(); assert.equal(f.surface.start(), starting); await starting;
  assert.equal(f.surface.ready, true); assert.ok(f.calls.discovery > 0);
  assert.equal(f.surface.localHubLink().local, local);
});

test('closing a prepared surface drains original credentials without activating runtime workers', async t => {
  const f = await fixture(t, options => { options.config.serverRole = 'all'; });
  await f.surface.prepare(); const link = f.surface.localHubLink({ allowPrepared: true });
  await f.surface.close();
  assert.equal(f.surface.prepared, false); assert.equal(f.surface.ready, false);
  assert.equal(f.calls.discovery, 0); assert.equal(f.calls.bindingClose, 1);
  await assert.rejects(f.surface.start()); await assert.rejects(f.surface.prepare());
  assert.equal((await link.local.dispatch(new Request('http://local/api/connector/v1/identity'))).status, 503);
  assert.ok(await f.owner.command('nodeIdentity', {}));
});
const adminHeaders = { authorization: 'Bearer original-admin' };
const observeAdmin = async (request: Request) => request.headers.get('authorization') === adminHeaders.authorization
  ? 'original-admin-id' : undefined;

test('private local Hub link is role/ready fenced, cached and never fabricates user identity', async t => {
  const remote = await fixture(t);
  assert.throws(() => remote.surface.localHubLink()); await remote.surface.start();
  assert.throws(() => remote.surface.localHubLink());
  // Mutating config cannot promote a surface constructed for standalone.
  remote.options.config.serverRole = 'all'; assert.throws(() => remote.surface.localHubLink());
  const f = await fixture(t, options => { options.config.serverRole = 'all'; options.legacyReads = { observeActor: observeAdmin }; });
  assert.throws(() => f.surface.localHubLink()); await f.surface.start();
  const link = f.surface.localHubLink(); assert.equal(link, f.surface.localHubLink());
  assert.equal(link.local.token, f.surface.credentials.token('daily'));
  assert.equal(link.local.maintenanceToken, f.surface.credentials.token('maintenance'));
  assert.equal((await link.local.dispatch(new Request('http://connector.example.invalid/api/sessions/state'))).status, 403);
  // Existing allowLocalExecutionSetup remains an independent default-deny gate.
  await assert.rejects(link.operator.create('original-hub'));
  await f.surface.close(); assert.throws(() => f.surface.localHubLink());
  assert.equal((await link.local.dispatch(new Request('http://connector.example.invalid/api/connector/v1/node'))).status, 503);
  await assert.rejects(link.operator.revoke('tok_abcdefghij')); assert.equal(f.calls.native, 0);
});

for (const creation of [false, true]) test(`two original workers: local Hub issuer install/idempotency/revocation, creation=${creation}`, async t => {
  const f = await fixture(t, options => {
    options.config.serverRole = 'all'; options.config.hub.allowLocalExecutionSetup = true;
  });
  await f.surface.start(); const { local, operator } = f.surface.localHubLink();
  const file = join(f.root, 'hub.sqlite'), seed = new HubStore(file, 'synthetic-local-vault');
  const connectionId = local.connectionId;
  seed.upsertConnection({ id: connectionId, kind: 'local', label: 'Original local node', connectorUrl: 'http://connector.example.invalid' });
  seed.pinConnectionNode(connectionId, 'default', seed.connectionAuthority(connectionId)!, f.surface.nodeId);
  const version = seed.connectionAuthority(connectionId)!;
  const login = seed.identities.issueKey('default'), member = seed.createUser('Original member'), memberLogin = seed.identities.issueKey(member.id);
  const hubId = seed.identities.hubId;
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default', 'admin', 1)").run();
  await seed.close();
  const hub = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-local-vault' }, new PerformanceDiagnostics(() => {}));
  const services = createHubConnectorReadServices(hub, local, new PerformanceDiagnostics(() => {}), undefined, operator);
  const app = new Hono(); registerHubExecutionIssuerRoutes(app, { mode: 'async', asyncManagement: services.issuerManagement });
  const path = `/api/hub/v1/connections/${encodeURIComponent(connectionId)}/execution-issuer`;
  const request = (token = login.token, input?: unknown, suffix = '') => new Request('http://hub.example.invalid' + path + suffix,
    { method: input ? 'POST' : 'GET', headers: { 'x-agentopsdeck-key': token, ...(input ? { 'content-type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
  try {
    const initial = await f.owner.command('tokensList', {});
    assert.equal((await app.fetch(request(memberLogin.token, { confirm: true, nodeVersion: version }, '/local'))).status, 403);
    assert.equal((await app.fetch(request('invalid'))).status, 401);
    assert.equal((await f.owner.command('tokensList', {})).length, initial.length);
    const response = await app.fetch(request(login.token, { confirm: true, nodeVersion: version, createSessions: creation }, '/local'));
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json(); const id = result.issuer.issuerId;
    assert.equal(result.issuer.nodeId, f.surface.nodeId);
    assert.equal(result.issuer.creationAllowed === true, creation);
    const minted = (await f.owner.command('tokensList', {})).filter(record => !initial.some(previous => previous.id === record.id));
    assert.equal(minted.length, 1); assert.equal(minted[0]!.id, id);
    assert.equal(minted[0]!.delegationHubId, hubId);
    assert.equal(minted[0]!.scopes.includes('sessions:create'), creation);
    assert.equal((await app.fetch(request(login.token, { confirm: true, nodeVersion: result.issuer.version, createSessions: creation }, '/local'))).status, 200);
    assert.equal((await f.owner.command('tokensList', {})).length, initial.length + 1);
    assert.equal(await operator.revoke(id), true);
    assert.equal(await f.owner.command('tokenHasScope', { tokenId: id, scope: 'execution:delegate' }), false);
    assert.equal(f.calls.native, 0);
    assert.equal(JSON.stringify(result).includes('aod_conn_'), false);
  } finally { await services.close(); await hub.close(); }
});

test('legacy agent catalog failures return redacted unavailable responses and retain delivery authorization', async t => {
  let actor: string | undefined = 'original-admin', calls = 0, fail = true;
  const held = gate();
  t.after(() => held.release());
  const f = await fixture(t, options => {
    options.legacyReads = { observeActor: async request => request.headers.get('x-original-admin') === 'yes' ? actor : undefined };
    const bind = options.bind!;
    options.bind = async context => ({ ...await bind(context), agents: async () => {
      calls++;
      if (fail) throw Error('PRIVATE-catalog-state');
      await held.promise;
      return [{ id: 'codex', status: 'available' }];
    } });
  });
  await f.surface.start();
  assert.equal((await f.surface.app.request('/api/agents')).status, 403);
  assert.equal(calls, 0);
  const headers = { 'x-original-admin': 'yes' };
  const unavailable = await f.surface.app.request('/api/agents', { headers });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unavailable.json(), { error: 'agent_catalog_unavailable' });
  fail = false;
  const reading = f.surface.app.request('/api/agents', { headers });
  await until(() => calls === 2);
  actor = undefined;
  held.release();
  assert.equal((await reading).status, 403);
  actor = 'original-admin';
  const recovered = await f.surface.app.request('/api/agents', { headers });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).agents, [{ id: 'codex', status: 'available' }]);
  assert.equal(f.calls.native, 0);
});

test('legacy frontend reads require explicit original application identity, never the Connector bearer', async t => {
  const absent = await fixture(t); await absent.surface.start();
  assert.equal((await absent.surface.app.request('/api/sessions/state', { headers: adminHeaders })).status, 404);
  const f = await fixture(t, options => { options.legacyReads = { observeActor: observeAdmin }; });
  for (const path of ['/api/sessions/state', '/api/attention', '/api/events/stream']) {
    assert.equal((await f.surface.app.request(path, { headers: adminHeaders })).status, 503);
  }
  await f.surface.start();
  for (const path of ['/api/sessions/state', legacyBase, `${legacyBase}/messages`, `${legacyBase}/activity`, '/api/attention']) {
    assert.equal((await f.surface.app.request(path, { headers: { authorization } })).status, 403, path);
    const response = await f.surface.app.request(path, { headers: adminHeaders });
    assert.equal(response.status, 200, path); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await f.surface.app.request('/api/events/stream', { headers: { authorization } })).status, 401);
  await f.surface.close();
  assert.equal((await f.surface.app.request('/api/attention', { headers: adminHeaders })).status, 503);
  assert.equal(f.calls.native, 0);
});

test('legacy history retains IDs, bounded pages, anchors, revision and tool detail wire through the original worker projection', async t => {
  const f = await fixture(t, options => { options.legacyReads = { observeActor: observeAdmin }; });
  await f.surface.start();
  f.hooks.history = async key => { f.surface.deck.replaceMessages(key, [
    { id: 'old', sessionKey: key, role: 'user', text: 'original prompt', createdAt: 1 },
    { id: 'tool', sessionKey: key, role: 'tool', text: 'original tool output', createdAt: 2 },
    { id: 'final', sessionKey: key, role: 'assistant', text: 'original answer', createdAt: 3 },
  ]); };
  const get = (path: string) => f.surface.app.request(path, { headers: adminHeaders });
  const first = await get(`${legacyBase}/messages?limit=1`); assert.equal(first.status, 200);
  const page = await first.json(); assert.equal(page.totalCount, 3); assert.equal(page.hiddenCount, 2);
  assert.deepEqual(page.messages.map((m: { id: string }) => m.id), ['final']); assert.equal(typeof page.revision, 'string');
  const older = await (await get(`${legacyBase}/messages?limit=1&before=final`)).json();
  assert.deepEqual(older.messages.map((m: { id: string }) => m.id), ['tool']);
  assert.equal((await get(`${legacyBase}/messages?before=missing`)).status, 409);
  assert.equal((await get(`${legacyBase}/messages?before=`)).status, 400);
  const detail = await (await get(`${legacyBase}/messages/tool`)).json();
  assert.equal(detail.message.id, 'tool'); assert.equal(detail.message.text, 'original tool output');
  assert.equal((await get(`${legacyBase}/messages/absent`)).status, 404);
  assert.ok(f.calls.history.every(key => key === legacyKey)); assert.equal(f.calls.native, 0);
});

test('legacy reserved runtime history never falls back to OpenClaw when disabled', async t => {
  const f = await fixture(t, options => { options.legacyReads = { observeActor: observeAdmin }; });
  await f.surface.start();
  for (const key of ['codex:original', 'hermes:original', 'claude-code:original', 'ghcp:original']) {
    const response = await f.surface.app.request(`/api/sessions/${encodeURIComponent(key)}/messages`, { headers: adminHeaders });
    assert.equal(response.status, 200, 'original cached-history compatibility is retained');
  }
  assert.deepEqual(f.calls.history, []); assert.equal(f.calls.native, 0);
});

test('legacy parallel history requests coalesce original work and revoked identity suppresses both deliveries', async t => {
  let actor: string | undefined = 'original-admin-id';
  const f = await fixture(t, options => { options.legacyReads = { observeActor: async () => actor }; });
  await f.surface.start(); const held = gate();
  f.hooks.history = () => held.promise;
  const a = f.surface.app.request(`${legacyBase}/messages`), b = f.surface.app.request(`${legacyBase}/messages`);
  try {
    await until(() => f.calls.history.length === 1); await tick(); await tick();
    assert.equal(f.calls.history.length, 1); actor = undefined;
  } finally { held.release(); }
  assert.equal((await a).status, 403); assert.equal((await b).status, 403);
  assert.equal(f.calls.native, 0);
});

for (const ending of ['abort', 'timeout'] as const) test(`legacy ${ending} suppresses delivery but close retains physical history ownership`, async t => {
  const f = await fixture(t, options => {
    options.legacyReads = { observeActor: observeAdmin }; options.waitMs = ending === 'timeout' ? 60 : 2000;
  });
  await f.surface.start(); const held = gate(), controller = new AbortController();
  f.hooks.history = () => held.promise;
  const reading = f.surface.app.request(`${legacyBase}/messages`, { headers: adminHeaders, signal: controller.signal });
  try {
    await until(() => f.calls.history.length === 1);
    if (ending === 'abort') controller.abort();
    assert.equal((await reading).status, ending === 'abort' ? 408 : 503);
    let settled = false; const closing = f.surface.close().then(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(f.calls.bindingClose, 0);
    assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
    held.release(); await closing;
    assert.equal(f.calls.history.length, 1); assert.equal(f.calls.bindingClose, 1);
  } finally { held.release(); }
});

test('legacy SSE uses worker replay and closes on original admin identity switch without native effects', async t => {
  let actor = 'original-admin-id';
  const f = await fixture(t, options => { options.legacyReads = { observeActor: async () => actor }; });
  await f.surface.start();
  const response = await f.surface.app.request('/api/events/stream'); assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: heartbeat/);
  actor = 'different-admin';
  f.surface.deck.upsertSession({ sessionKey: legacyKey, agentId: 'main', title: 'PRIVATE after switch', status: 'idle' });
  let remaining = '';
  for (;;) { const next = await reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
  assert.doesNotMatch(remaining, /PRIVATE after switch/);
  assert.equal((await f.surface.app.request('/api/attention')).status, 200, 'new admin can make its own observation');
  assert.equal(f.calls.native, 0);
});

test('legacy observation and history are fenced through original maintenance pause and resume', async t => {
  const f = await fixture(t, options => { options.legacyReads = { observeActor: observeAdmin }; });
  await f.surface.start();
  const token = await f.owner.command('tokenCreate', { label: 'legacy-maintenance', scopes: ['connector:lifecycle'] });
  const headers = { authorization: `Bearer ${token.token}`, [EXPECTED_NODE_HEADER]: f.surface.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'content-type': 'application/json' };
  const pause = await f.request('/maintenance/commands/pause', headers, { method: 'POST',
    body: JSON.stringify({ idempotencyKey: 'legacy-pause' }) });
  assert.equal(pause.status, 200); const receipt = await pause.json();
  for (const path of ['/api/sessions/state', `${legacyBase}/messages`, '/api/attention', '/api/events/stream']) {
    assert.equal((await f.surface.app.request(path, { headers: adminHeaders })).status, 503);
  }
  assert.equal(f.calls.history.length, 0);
  assert.equal((await f.request('/maintenance/commands/resume', headers, { method: 'POST',
    body: JSON.stringify({ idempotencyKey: 'legacy-resume', fenceId: receipt.command.id }) })).status, 200);
  assert.equal((await f.surface.app.request(`${legacyBase}/messages`, { headers: adminHeaders })).status, 200);
  assert.deepEqual(f.calls.history, [legacyKey]); assert.equal(f.calls.native, 0);
});

test('original maintenance journal survives full surface and worker reopen, with no execution before authorized resume', async t => {
  const f = await fixture(t); await f.surface.start();
  const token = await f.owner.command('tokenCreate', { label: 'lifecycle', scopes: ['connector:lifecycle'] });
  const headers = { authorization: `Bearer ${token.token}`, [EXPECTED_NODE_HEADER]: f.surface.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'content-type': 'application/json' };
  const pauseBody = JSON.stringify({ idempotencyKey: 'original-pause' });
  const paused = await f.request('/maintenance/commands/pause', headers, { method: 'POST', body: pauseBody });
  assert.equal(paused.status, 200);
  const receipt = await paused.json() as { state: string; command: { id: string } };
  assert.equal(receipt.state, 'paused');
  assert.equal((await f.request('/sessions/state')).status, 503, 'GET refreshes cannot enter during maintenance');
  assert.equal((await f.request('/identity')).status, 200);
  assert.equal((await f.owner.command('maintenanceSnapshot', {})).commandAdmissionOpen, false);
  assert.equal((await f.request('/maintenance/commands/pause', headers, { method: 'POST', body: pauseBody })).status, 200);
  await assert.doesNotReject(f.surface.close(), 'original surface drains before owner retirement');
  await assert.doesNotReject(f.owner.close(), 'original worker exits');
  const reopenedOwner = new AsyncConnectorOwner({ file: join(f.root, 'connector.sqlite'), tokenFile: join(f.root, 'tokens.json'),
    codexBoardTools: false }, new PerformanceDiagnostics(() => {}));
  await assert.doesNotReject(reopenedOwner.open(), 'same database owner reopens');
  let reopened: Awaited<ReturnType<typeof createAsyncConnectorSurface>> | undefined;
  try {
    reopened = await createAsyncConnectorSurface({ ...f.options, owner: reopenedOwner });
    await assert.doesNotReject(reopened.start(), 'original journal restores before execution');
    assert.equal(reopened.nodeId, f.surface.nodeId); assert.equal(reopened.ready, true);
    assert.equal(reopened.runtimes.ready, false, 'control readiness is not execution readiness');
    assert.equal((await reopenedOwner.command('maintenanceSnapshot', {})).commandAdmissionOpen, false);
    const request = (path: string, init: RequestInit = {}) => reopened!.app.request(`/api/connector/v1${path}`, { ...init, headers });
    assert.equal((await request('/sessions/state')).status, 503);
    const status = await request('/maintenance/status'); assert.equal(status.status, 200);
    assert.equal((await status.json() as { state: string }).state, 'paused');
    const old = await request('/maintenance/commands/pause/original-pause'); assert.equal(old.status, 200);
    assert.equal((await old.json() as typeof receipt).command.id, receipt.command.id);
    const resumeBody = JSON.stringify({ idempotencyKey: 'original-resume', fenceId: receipt.command.id });
    const resumed = await request('/maintenance/commands/resume', { method: 'POST', body: resumeBody });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as typeof receipt).state, 'released');
    assert.equal(reopened.runtimes.ready, true);
    // Preservation hashes are only authoritative while the original runtime is
    // paused. A released owner must reject this proof, not manufacture one.
    await assert.rejects(reopenedOwner.command('maintenanceSnapshot', {}));
    assert.equal((await request('/maintenance/commands/resume', { method: 'POST', body: resumeBody })).status, 200);
    assert.equal((await reopened.app.request('/api/connector/v1/sessions/state', { headers: { authorization } })).status, 200);
    assert.equal(f.calls.native, 0);
  } finally { await reopened?.close(); await reopenedOwner.close(); }
});

test('maintenance controls retain protocol/node middleware before terminal handlers', async t => {
  const f = await fixture(t); await f.surface.start();
  const token = await f.owner.command('tokenCreate', { label: 'lifecycle', scopes: ['connector:lifecycle'] });
  const headers = { authorization: `Bearer ${token.token}`, [EXPECTED_NODE_HEADER]: f.surface.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'content-type': 'application/json' };
  for (const [path, init] of [
    ['/maintenance/status', {}],
    ['/maintenance/commands/pause', { method: 'POST', body: JSON.stringify({ idempotencyKey: 'protocol-pause' }) }],
  ] as const) {
    for (const [overrides, status] of [
      [{ [CONNECTOR_PROTOCOL_HEADER]: '999' }, 426],
      [{ [EXPECTED_NODE_HEADER]: 'foreign-node' }, 409],
    ] as const) {
      const response = await f.request(path, { ...headers, ...overrides }, init);
      assert.equal(response.status, status);
      assert.equal(response.headers.get(NODE_ID_HEADER), f.surface.nodeId);
      assert.equal(response.headers.get(CONNECTOR_PROTOCOL_HEADER), '1');
    }
  }
  assert.equal(f.surface.runtimes.ready, true, 'rejected controls have no pause effect');
  assert.equal((await f.request('/maintenance/status', { ...headers, authorization })).status, 403);
  const paused = await f.request('/maintenance/commands/pause', headers, { method: 'POST',
    body: JSON.stringify({ idempotencyKey: 'protocol-pause' }) });
  assert.equal(paused.status, 200);
  assert.equal(paused.headers.get(NODE_ID_HEADER), f.surface.nodeId);
  assert.equal((await f.request('/maintenance/status', headers)).status, 200);
  assert.equal(f.calls.native, 0);
});

test('malformed original maintenance journal prevents native/discovery startup and is never silently replaced', async t => {
  const f = await fixture(t), journal = f.options.config.connector.updateStateFile;
  writeFileSync(journal, '{PRIVATE broken journal');
  await assert.rejects(f.surface.start(), error => error instanceof Error && !error.message.includes('PRIVATE'));
  const failedStart = f.logs.map(line => JSON.parse(line)).find(row => row.operation === 'connector-runtime-assembly' && row.step === 11);
  assert.equal(failedStart?.startupStage, 1, 'Record the original failed maintenance stage, not cleanup');
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE broken journal/);
  assert.equal(f.calls.discovery, 0); assert.equal(f.calls.native, 0); assert.equal(f.surface.ready, false);
  assert.equal(readFileSync(journal, 'utf8'), '{PRIVATE broken journal');
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|Bearer surface-fixture/);
});

test('maintenance pause drains an accepted physical catalog read and revoked resume leaves execution fenced', async t => {
  const f = await fixture(t); await f.surface.start();
  const token = await f.owner.command('tokenCreate', { label: 'lifecycle', scopes: ['connector:lifecycle'] });
  const headers = { authorization: `Bearer ${token.token}`, [EXPECTED_NODE_HEADER]: f.surface.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'content-type': 'application/json' };
  const held = gate(); let entered = false;
  f.hooks.discovery = async () => { entered = true; await held.promise; };
  const reading = f.request('/sessions/state'); await until(() => entered);
  let settled = false;
  const pausing = Promise.resolve(f.request('/maintenance/commands/pause', headers,
    { method: 'POST', body: JSON.stringify({ idempotencyKey: 'drain-pause' }) }));
  void pausing.then(() => { settled = true; });
  try {
    await until(() => f.surface.runtimes.ready === false); await tick();
    assert.equal(settled, false);
    assert.equal((await f.request('/sessions/state')).status, 503);
  } finally { held.release(); }
  await reading;
  const paused = await pausing; assert.equal(paused.status, 200);
  const receipt = await paused.json() as { command: { id: string } };
  await f.owner.command('tokenRevoke', { tokenId: token.record.id });
  assert.equal((await f.request('/maintenance/commands/resume', headers, { method: 'POST',
    body: JSON.stringify({ idempotencyKey: 'revoked-resume', fenceId: receipt.command.id }) })).status, 403);
  assert.equal(f.surface.runtimes.ready, false);
  assert.equal((await f.owner.command('maintenanceSnapshot', {})).commandAdmissionOpen, false);
  assert.equal(f.calls.native, 0);
});

test('public sub-root preserves original identity/preferences/journal and becomes ready only after complete discovery', async t => {
  const f = await fixture(t), held = gate();
  assert.equal(f.surface.state, 'created'); assert.equal(f.calls.native, 0); assert.equal(f.calls.discovery, 0);
  assert.equal((await f.request('/identity')).status, 503);
  assert.equal((await f.request('/identity', { [EXPECTED_NODE_HEADER]: 'wrong' })).status, 409);
  assert.equal((await f.request('/identity', { [CONNECTOR_PROTOCOL_HEADER]: '999' })).status, 426);
  f.hooks.discovery = () => held.promise;
  const start = f.surface.start(); assert.equal(f.surface.start(), start);
  await until(() => f.calls.discovery > 0);
  assert.equal(f.surface.ready, false); assert.equal((await f.request('/sessions/directory')).status, 503);
  held.release(); await start;
  assert.equal(f.surface.ready, true);
  const identity = await f.request('/identity'); assert.equal(identity.status, 200);
  assert.equal(identity.headers.get(NODE_ID_HEADER), f.surface.nodeId);
  assert.equal((await identity.json()).nodeId, await f.owner.command('nodeIdentity', {}));
  const directory = await f.request('/sessions/directory'); assert.equal(directory.status, 200);
  const body = await directory.json();
  assert.equal(body.sessions[0].sessionKey, 'agent:main:web:direct:original');
  assert.equal(body.sourceCursor, (await f.owner.command('eventProjectionHead', {})).cursor);
  const state = await f.request('/sessions/state'); assert.equal(state.status, 200);
  assert.match(JSON.stringify(await state.json()), /Preserved title/);
  assert.equal((await f.request('/agents')).status, 200);
  assert.ok(f.surface.credentials.token('daily')); assert.ok(f.surface.credentials.token('maintenance'));
  assert.equal(f.calls.native, 0);
  await f.surface.close();
  assert.equal(f.surface.state, 'closed'); assert.equal(f.calls.historyClose, 1);
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.samplerClose, 1);
  assert.equal((await f.request('/identity')).status, 503);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
  assert.doesNotMatch(f.logs.join('\n'), /surface-fixture|Bearer|Preserved title/);
});

test('public controls use the current original credential, not a cached principal', async t => {
  const f = await fixture(t); await f.surface.start();
  const reader = await f.owner.command('tokenCreate', { label: 'limited', scopes: ['sessions:read'] });
  const headers = { authorization: `Bearer ${reader.token}` };
  assert.equal((await f.request('/sessions/directory', headers)).status, 200);
  assert.equal((await f.request('/users', headers)).status, 403);
  await f.owner.command('tokenRevoke', { tokenId: reader.record.id });
  assert.equal((await f.request('/sessions/directory', headers)).status, 403);
  assert.equal((await f.request('/identity', headers)).status, 401);
  const daily = f.surface.credentials.token('daily')!;
  await f.surface.close();
  assert.equal(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }), null);
});

test('discovery failure cleans the original resources and lease, without restarting or replaying native work', async t => {
  const f = await fixture(t);
  f.hooks.discovery = async () => { throw Error('PRIVATE discovery error'); };
  await assert.rejects(f.surface.start(), error => error instanceof Error && !error.message.includes('PRIVATE'));
  const failedStart = f.logs.map(line => JSON.parse(line)).find(row => row.operation === 'connector-runtime-assembly' && row.step === 11);
  assert.equal(failedStart?.startupStage, 8, 'Record the original failed refresh stage, not cleanup');
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE discovery error/);
  assert.equal(f.surface.ready, false); assert.equal(f.calls.native, 0);
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.samplerClose, 1);
  assert.equal(f.calls.historyClose, 1);
  await assert.rejects(f.surface.start());
  assert.equal((await f.request('/identity')).status, 503);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
});

test('close during startup freezes immediately and retains physical discovery before releasing its credential', async t => {
  const f = await fixture(t), held = gate(); f.hooks.discovery = () => held.promise;
  const starting = f.surface.start(), failed = assert.rejects(starting);
  await until(() => f.calls.discovery > 0);
  const daily = f.surface.credentials.token('daily')!;
  let closed = false; const closing = f.surface.close();
  assert.equal(f.surface.close(), closing); void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.calls.bindingClose, 0);
  assert.ok(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }));
  assert.equal((await f.request('/identity')).status, 503);
  held.release(); await failed; await closing;
  assert.equal(f.calls.native, 0); assert.equal(f.calls.bindingClose, 1);
  assert.equal(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }), null);
});

test('close drains an accepted public snapshot before external resource/credential release', async t => {
  const f = await fixture(t); await f.surface.start();
  const held = gate(); let entered = false;
  f.hooks.discovery = async () => { entered = true; await held.promise; };
  const reading = f.request('/sessions/state'); await until(() => entered);
  const daily = f.surface.credentials.token('daily')!;
  let closed = false; const closing = f.surface.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.calls.bindingClose, 0);
  assert.ok(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }));
  held.release(); assert.equal((await reading).status, 503); await closing;
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.surface.events.status().closing, true);
});

test('retained parent drain freezes admission immediately and retains projection and credentials until original ACK', async t => {
  const held = gate(); let entered = 0, replacement = 0;
  const f = await fixture(t, options => { options.projectionConsumersDrain = () => { entered++; return held.promise; }; });
  await f.surface.start(); const daily = f.surface.credentials.token('daily')!;
  f.options.projectionConsumersDrain = async () => { replacement++; };
  let settled = false;
  const closing = f.surface.close().then(() => { settled = true; });
  try {
    assert.equal(entered, 1); assert.equal(replacement, 0);
    assert.equal(f.surface.ready, false);
    assert.equal((await f.request('/identity')).status, 503);
    await tick(); assert.equal(settled, false);
    // Public reads own the sampler and may drain it immediately. Only the
    // parent ACK projection, native binding and credentials are retained.
    assert.equal(f.calls.bindingClose, 0); assert.equal(f.calls.samplerClose, 1);
    assert.equal(f.surface.events.status().closing, false);
    assert.ok(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }));
  } finally {
    held.release(); await closing;
  }
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.samplerClose, 1);
  assert.equal(f.surface.events.status().closing, true);
  assert.equal(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }), null);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
});

for (const synchronous of [true, false]) test(`failed retained parent drain never certifies disposal; synchronous=${synchronous}`, async t => {
  let entered = 0;
  const fail = () => { entered++; throw Error('PRIVATE parent drain failure'); };
  const f = await fixture(t, options => { options.projectionConsumersDrain = synchronous ? fail : async () => fail(); });
  f.hooks.closeFailureExpected = true;
  await f.surface.start(); const daily = f.surface.credentials.token('daily')!;
  delete f.options.projectionConsumersDrain;
  const closing = f.surface.close();
  await assert.rejects(closing, error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(f.surface.close(), closing); assert.equal(entered, 1);
  assert.equal(f.surface.state, 'failed'); assert.equal(f.surface.ready, false);
  assert.equal((await f.request('/identity')).status, 503);
  assert.equal(f.calls.bindingClose, 0); assert.equal(f.calls.samplerClose, 1);
  assert.equal(f.surface.events.status().closing, false);
  assert.ok(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }));
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE parent drain failure/);
});

test('a parent drain cannot be attached retroactively to an already acquired surface', async t => {
  const f = await fixture(t); await f.surface.start();
  f.options.projectionConsumersDrain = () => { throw Error('PRIVATE retroactive drain'); };
  await f.surface.close();
  assert.equal(f.surface.state, 'closed'); assert.equal(f.calls.bindingClose, 1);
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE retroactive drain/);
});

test('an original SSE stream is aborted and drained before the shared owner is released', async t => {
  const f = await fixture(t); await f.surface.start();
  const response = await f.request('/events/stream'); assert.equal(response.status, 200);
  const reader = response.body!.getReader(); const first = await reader.read(); assert.equal(first.done, false);
  await f.surface.close();
  while (!(await reader.read()).done) { /* Only the original already-admitted frames may drain. */ }
  assert.equal(f.calls.samplerClose, 1);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
});

test('construction failure releases the returned original binding but never closes the shared SQL owner', async t => {
  let cleanup = 0;
  const f = await fixture(t);
  // Existing live surface is independent. Failed candidate borrows the same
  // worker and must not take ownership of it or acquire another token writer.
  await assert.rejects(createAsyncConnectorSurface({ owner: f.owner, config: loadConfig({ SERVER_ROLE: 'connector' }),
    connector: { environmentId: 'test', environmentLabel: 'test' }, diagnostics: new PerformanceDiagnostics(() => {}),
    bind: () => ({ runtimes: { codex: null } as never, refreshSessions: async () => {}, agents: () => [], close: async () => { cleanup++; } }),
  }));
  assert.equal(cleanup, 1);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
});

test('failed inert attachment drains assembly and binding without activation or closing the SQL owner', async t => {
  let attached = 0, released = 0, nativeHistoryClosed = 0;
  let failingBind: AsyncConnectorSurfaceOptions['bind'] | undefined;
  const f = await fixture(t, options => {
    const original = options.bind!;
    options.bind = async context => {
      const binding = await original(context), close = binding.runtimes.openclaw.history.close;
      binding.attach = async assembly => {
        assert.equal(assembly.state, 'new'); attached++;
        throw Error('PRIVATE attach failure');
      };
      binding.runtimes.openclaw.history.close = async () => { nativeHistoryClosed++; await close(); };
      const release = binding.close;
      binding.close = async () => { released++; await release(); };
      // Exercise failed candidate construction with the same real inert graph.
      return binding;
    };
    const failing = options.bind;
    options.bind = original;
    options.sampler = { sample: async () => { throw Error('No sample expected'); }, close: async () => {} };
    // Save the failed candidate factory for the explicit construction below.
    failingBind = failing;
  });
  assert.ok(failingBind);
  await assert.rejects(createAsyncConnectorSurface({ owner: f.owner,
    config: { ...loadConfig({ SERVER_ROLE: 'connector' }), sessionTitlesFile: join(f.root, 'titles.json') },
    connector: { environmentId: 'failed-attach', environmentLabel: 'failed attach' }, bind: failingBind,
    diagnostics: new PerformanceDiagnostics(() => {}) }),
  error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(attached, 1); assert.equal(nativeHistoryClosed, 1); assert.equal(released, 1);
  assert.equal(f.calls.native, 0); assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
  // The failed candidate must not disturb the original still-inert surface.
  await f.surface.start(); assert.equal(f.surface.ready, true);
});

test('native offline and maintenance pauses preserve public catalog and original identity reads', async t => {
  const f = await fixture(t, options => {
    const original = options.bind!;
    options.bind = async context => {
      const binding = await original(context);
      binding.runtimes.openclaw.dispatch.native = { available: () => false, epoch: () => 'offline' };
      binding.runtimes.openclaw.gatewayStatus = () => 'disconnected';
      return binding;
    };
  });
  await f.surface.start();
  assert.equal(f.surface.runtimes.ready, false);
  assert.equal(f.surface.ready, true);
  const pause = f.surface.runtimes.pauseQueueWorkers(); await pause.drained;
  assert.equal(f.surface.ready, true);
  assert.equal((await f.request('/identity')).status, 200);
  assert.equal((await f.request('/sessions/directory')).status, 200);
  assert.equal((await f.request('/sessions/state')).status, 200);
  assert.equal(f.calls.native, 0);
  assert.equal(pause.resume(), true);
});

test('closing an unstarted surface never acquires local credentials or activates discovery', async t => {
  const f = await fixture(t);
  await f.surface.close();
  assert.throws(() => f.surface.credentials.token('daily'));
  assert.equal(f.calls.discovery, 0); assert.equal(f.calls.native, 0);
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.historyClose, 1);
  assert.equal(f.calls.samplerClose, 1);
  await assert.rejects(f.surface.start());
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
});

test('reentrant cleanup shares close promise and a failed binding release cannot strand credentials or events', async t => {
  const f = await fixture(t); await f.surface.start();
  const daily = f.surface.credentials.token('daily')!;
  f.hooks.closeFailureExpected = true;
  let reentered: Promise<void> | undefined;
  f.hooks.bindingClose = async () => {
    reentered = f.surface.close();
    throw Error('PRIVATE binding cleanup');
  };
  const closing = f.surface.close();
  await assert.rejects(closing, error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(reentered, closing); assert.equal(f.surface.close(), closing);
  assert.equal(f.surface.state, 'failed'); assert.equal(f.surface.events.status().closing, true);
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.samplerClose, 1);
  assert.equal(await f.owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }), null);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.surface.nodeId);
});

test('machine files share the original owner but never inherit session authority or bypass root fences', async t => {
  const f = await fixture(t, (options, root) => {
    options.config.fileBrowserRoots = { codex: root };
    writeFileSync(join(root, 'original.txt'), 'Original file contents');
  });
  assert.equal((await f.request('/files/roots')).status, 503);
  assert.equal((await f.request('/files/roots', { [EXPECTED_NODE_HEADER]: 'wrong' })).status, 409);
  await f.surface.start();
  const session = await f.owner.command('tokenCreate', { label: 'session only', scopes: ['sessions:read'] });
  assert.equal((await f.request('/files/roots', { authorization: `Bearer ${session.token}` })).status, 403);
  const reader = await f.owner.command('tokenCreate', { label: 'machine reader', scopes: ['files:read'] });
  const headers = { authorization: `Bearer ${reader.token}` };
  assert.equal((await f.request('/files/roots', headers)).status, 200);
  const content = await f.request('/files/agents/codex/preview?path=original.txt', headers);
  assert.equal(content.status, 200); assert.equal((await content.json()).text, 'Original file contents');
  await f.owner.command('tokenRevoke', { tokenId: reader.record.id });
  assert.equal((await f.request('/files/roots', headers)).status, 401);
  await f.surface.close();
  for (const path of ['/files/roots', '/issues/sources', '/websites/catalog', '/website-access', '/website-actions', '/terminals/targets']) {
    assert.equal((await f.request(path)).status, 503, path);
  }
  assert.equal(f.calls.native, 0);
});

test('surface starts the original workspace journals before readiness and exposes borrowed turn-context ports', async t => {
  let workspace: Parameters<NonNullable<AsyncConnectorSurfaceOptions['bind']>>[0]['workspace'] | undefined;
  const f = await fixture(t, options => {
    const bind = options.bind!;
    options.bind = async context => { workspace = context.workspace; return bind(context); };
  }, true);
  assert.equal(f.surface.workspace?.state, 'created');
  assert.equal(workspace?.()?.cards, f.surface.workspace?.cards);
  assert.equal((await f.request('/workspace/card-files')).status, 503);
  assert.equal((await f.request('/workspace/card-files', { [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409);
  await f.surface.start();
  assert.equal(f.surface.workspace?.state, 'ready');
  const token = await f.owner.command('tokenCreate', { label: 'workspace reader', scopes: ['boards:files'] });
  const headers = { authorization: `Bearer ${token.token}` };
  for (const path of ['board-files', 'card-files', 'content-replicas']) {
    assert.equal((await f.request(`/workspace/${path}`, headers)).status, 200);
  }
  await f.surface.close();
  assert.equal(f.surface.workspace?.state, 'closed');
  assert.equal((await f.request('/workspace/card-files', headers)).status, 503);
  assert.equal(f.owner.authorityChanges.waiting, 0);
  assert.ok(await f.owner.command('nodeIdentity', {}));
  assert.equal(f.calls.native, 0);
});

test('configured workspace defaults to sole-worker native session lookup without injected legacy resolver', async t => {
  const f = await fixture(t, options => {
    const bind = options.bind!;
    options.bind = async context => {
      const result = await bind(context); delete result.workspaceSession; return result;
    };
  }, true);
  await f.surface.start();
  assert.equal(f.surface.ready, true);
  assert.ok(f.surface.workspace);
  assert.equal(f.calls.native, 0);
});

test('configured private bindings default to original worker enrollment rather than a directory or Deck entry', async t => {
  const f = await fixture(t, (options, root) => {
    options.config.codex.boardToolsDirectory = join(root, 'private');
    mkdirSync(options.config.codex.boardToolsDirectory, { mode: 0o700 });
  });
  await f.surface.start();
  const token = await f.owner.command('tokenCreate', { label: 'binding lookup', scopes: ['boards:bind'] });
  f.surface.deck.upsertSession({ sessionKey: 'codex:not-enrolled', agentId: 'codex', title: 'Display only', status: 'idle' });
  assert.equal((await f.request('/sessions/codex%3Anot-enrolled/board-binding', { authorization: `Bearer ${token.token}` })).status, 404);
  assert.equal(f.calls.native, 0);
});

test('surface recovers private grants before native activation and retains original scope, native ID and protocol fences', async t => {
  const sessionId = randomUUID(), endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
  const policies: BoardBindingPolicy[] = [];
  let directory = '', exists = true;
  const f = await fixture(t, (options, root) => {
    directory = join(root, 'private'); mkdirSync(directory, { mode: 0o700 });
    options.config.codex.boardToolsDirectory = directory; options.config.boardBindingPolicies = policies;
    const bind = options.bind!;
    options.bind = async context => ({ ...await bind(context), boardBindingSession: async key =>
      exists && key === 'codex:public-key' ? { runtime: 'codex', sessionId, ready: true } : undefined });
  });
  const token = await f.owner.command('tokenCreate', { label: 'private binding', scopes: ['boards:bind'] });
  policies.push({ owner: token.record.id, runtime: 'codex', endpoint });
  const files = new ConnectorBoardBindings({ codex: directory }, policies, () => true);
  // Original stale grant survives construction; startup must remove it before
  // the first executor can observe private tool files.
  await files.install(token.record.id, { id: randomUUID(), runtime: 'codex', sessionId,
    credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } });
  await f.owner.command('tokenRevoke', { tokenId: token.record.id });
  assert.ok(await loadWorkerBoardTools(directory, 'codex', sessionId, () => true));
  const startNative = f.surface.runtimes.start;
  let activations = 0;
  f.surface.runtimes.start = async () => {
    assert.equal(await loadWorkerBoardTools(directory, 'codex', sessionId, () => true), undefined);
    activations++; await startNative();
  };
  const path = '/sessions/codex%3Apublic-key/board-binding';
  assert.equal((await f.request(path)).status, 503);
  assert.equal((await f.request(path, { [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409);
  assert.equal((await f.request(path, { [CONNECTOR_PROTOCOL_HEADER]: '999' })).status, 426);
  await f.surface.start(); assert.equal(activations, 1);
  assert.equal((await f.request(path)).status, 403, 'bootstrap must not gain boards:bind');
  const explicit = await f.owner.command('tokenCreate', { label: 'reader', scopes: ['boards:bind'] });
  policies.push({ owner: explicit.record.id, runtime: 'codex', endpoint });
  const headers = { authorization: `Bearer ${explicit.token}` };
  const response = await f.request(path, headers); assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, sessionId);
  exists = false; assert.equal((await f.request(path, headers)).status, 404);
  await f.surface.close(); assert.equal((await f.request(path, headers)).status, 503);
  assert.equal(f.owner.authorityChanges.waiting, 0); assert.equal(f.calls.native, 0);
});

test('surface serves connector info, health, capabilities, model-set status/reconcile, and runtime models with scope enforcement', async t => {
  const f = await fixture(t, (options, root) => {
    const openclawFile = join(root, 'openclaw.json');
    writeFileSync(openclawFile, JSON.stringify({ agents: { defaults: { models: { 'gpt-test': {} } } } }));
    options.config.connector.openclawConfigFile = openclawFile;
    options.config.connector.modelAliases = ['gpt-test', 'gpt-missing'];
  });
  await f.surface.start();
  const infoRes = await f.request('/info');
  assert.equal(infoRes.status, 200);
  const info = await infoRes.json();
  assert.equal(info.service, 'aod-connector');
  assert.equal(info.environment.idHint, 'original-env');

  const healthRes = await f.request('/health');
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.ok(health.status === 'online' || health.status === 'degraded');

  const capRes = await f.request('/capabilities');
  assert.equal(capRes.status, 200);
  const cap = await capRes.json();
  assert.equal(cap.connector.service, 'aod-connector');
  assert.equal(cap.environment.idHint, 'original-env');
  assert.equal(cap.features.interactions, true);
  assert.equal(cap.gateway.statusVisible, false);
  assert.equal(cap.gateway.opsAllowed, false);
  assert.ok(cap.update);

  const eventsOnly = await f.owner.command('tokenCreate', { label: 'events only', scopes: ['events:read'] });
  assert.equal((await f.request('/capabilities', { authorization: `Bearer ${eventsOnly.token}` })).status, 403);

  assert.equal((await f.request('/models/unknown-runtime')).status, 403);
  assert.equal((await f.request('/gateway/model-set')).status, 403);
  assert.equal((await f.request('/gateway/model-set/reconcile', {}, { method: 'POST', body: '{}' })).status, 403);

  const modelsToken = await f.owner.command('tokenCreate', { label: 'models reader', scopes: ['models:read'] });
  const readAuth = { authorization: `Bearer ${modelsToken.token}` };
  const unknownModels = await f.request('/models/unknown-runtime', readAuth);
  assert.equal(unknownModels.status, 404);
  const openclawModels = await f.request('/models/openclaw', readAuth);
  assert.equal(openclawModels.status, 200);
  assert.deepEqual(await openclawModels.json(), { models: [{ id: 'gpt-test', label: 'gpt-test' }] });

  const modelSetRes = await f.request('/gateway/model-set', readAuth);
  assert.equal(modelSetRes.status, 200);
  const modelSet = await modelSetRes.json();
  assert.equal(modelSet.setId, AOD_MODEL_SET_ID);
  assert.equal(modelSet.converged, false);
  assert.deepEqual(modelSet.missing, ['gpt-missing']);

  assert.equal((await f.request('/gateway/model-set/reconcile', readAuth, { method: 'POST', body: '{}' })).status, 403);

  const writeToken = await f.owner.command('tokenCreate', { label: 'models writer', scopes: ['sessions:read', 'models:read', 'models:write'] });
  const writeAuth = { authorization: `Bearer ${writeToken.token}`, 'content-type': 'application/json' };
  const writerCap = await (await f.request('/capabilities', writeAuth)).json();
  assert.equal(writerCap.gateway.statusVisible, true);
  assert.equal(writerCap.gateway.opsAllowed, true);

  assert.equal((await f.request('/gateway/model-set/reconcile', writeAuth, {
    method: 'POST', body: JSON.stringify({ setId: 'wrong-set' }),
  })).status, 400);
  assert.equal((await f.request('/gateway/model-set/reconcile', writeAuth, {
    method: 'POST', body: JSON.stringify({ setId: AOD_MODEL_SET_ID, models: ['custom'] }),
  })).status, 400);

  const dryRunRes = await f.request('/gateway/model-set/reconcile', writeAuth, {
    method: 'POST', body: JSON.stringify({ setId: AOD_MODEL_SET_ID, dryRun: true }),
  });
  assert.equal(dryRunRes.status, 200);
  const dryRun = await dryRunRes.json();
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.changed, false);
  assert.equal(dryRun.restartRequired, true);

  const applyRes = await f.request('/gateway/model-set/reconcile', writeAuth, {
    method: 'POST', body: JSON.stringify({ setId: AOD_MODEL_SET_ID, dryRun: false }),
  });
  assert.equal(applyRes.status, 200);
  const applied = await applyRes.json();
  assert.equal(applied.ok, true);
  assert.equal(applied.changed, true);
  assert.equal(applied.status.converged, true);
});

test('events snapshot retries when refreshProjection reports ExecutionProjectionChanged', async t => {
  let projectionAttempts = 0;
  const f = await fixture(t, options => {
    const original = options.bind!;
    options.bind = async context => {
      const binding = await original(context);
      binding.attach = async assembly => {
        const refreshProjection = assembly.refreshProjection.bind(assembly);
        assembly.refreshProjection = async settings => {
          projectionAttempts++;
          if (projectionAttempts === 2) throw new ExecutionProjectionChanged();
          return refreshProjection(settings);
        };
      };
      return binding;
    };
  });
  await f.surface.start();
  const res = await f.request('/events/stream');
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel();
  assert.ok(projectionAttempts >= 3);
});
