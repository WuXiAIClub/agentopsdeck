import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAsyncHubApplication, createAsyncLocalHubLayer } from './application-hub-async.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { createAsyncConnectorSurface } from './connector/async-connector-surface.js';
import { AsyncHubMemberOwner } from './hub/async-member-owner.js';
import { HubStore } from './hub/hub-store.js';
import { hubDefaultConnection } from './hub/member-owner-bootstrap.js';
import { WeixinService } from './hub/weixin-service.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';

const admin = 'isolated-local-hub-administrator', vault = 'isolated-local-hub-vault';
const base = '/api/hub/v1', session = 'agent:main:web:direct:original';
const tick = () => new Promise<void>(ok => setImmediate(ok));
function gate() { let release!: () => void; const promise = new Promise<void>(ok => { release = ok; }); return { promise, release }; }
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < end, 'Local application work did not converge'); await tick(); }
}

async function fixture(t: TestContext, mode: 'json' | 'sqlite' = 'sqlite', withKey = true, prepareOnly = false) {
  const root = mkdtempSync(join(tmpdir(), 'local-hub-application-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'all',
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: vault,
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    AOD_HIDDEN_SESSIONS_FILE: join(root, 'hidden.json'),
    AOD_ARCHIVED_SESSIONS_FILE: join(root, 'archived.json'),
    AOD_PINNED_SESSIONS_FILE: join(root, 'pinned.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json'),
    ...(withKey ? { AOD_ACCESS_KEY: admin } : {}),
    ...(mode === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}),
  });
  config.hub.allowLocalExecutionSetup = true;
  t.mock.method(globalThis, 'fetch', async () => { throw Error('UNEXPECTED_EXTERNAL_EFFECT'); });
  t.mock.method(WeixinService.prototype, 'startWorker', () => {});
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: 'isolated-bootstrap', codexBoardTools: false });
  const layers: Awaited<ReturnType<typeof createAsyncLocalHubLayer>>[] = [];
  let surface: Awaited<ReturnType<typeof createAsyncConnectorSurface>> | undefined;
  t.after(async () => {
    try {
      for (const layer of layers) await layer.close();
      await surface?.close(); assert.equal(startupApplicationCleanup.snapshot().pending, 0);
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
  });
  await owner.open();
  let nativeEffects = 0;
  let updateSession = () => {};
  surface = await createAsyncConnectorSurface({ owner, config,
    connector: config.connector,
    sampler: { sample: async () => { throw Error('NO_METRICS_EXPECTED'); }, close: async () => {} },
    bind: ({ deck, snapshot }) => {
      updateSession = () => { deck.upsertSession({ sessionKey: session, agentId: 'main', title: 'Live local update', status: 'idle' }); };
      const refreshSessions = async () => {
        if (!deck.getSession(session)) deck.upsertSession({ sessionKey: session, agentId: 'main', title: 'Original local session', status: 'idle' });
      };
      return { refreshSessions, agents: () => [], close: async () => {}, runtimes: {
        codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: root, defaultModel: 'default', approvalPolicy: 'never' } },
        sdk: {}, hermes: { config: { enabled: false, executable: join(root, 'absent-python'), sourceDirectory: root,
          homeDirectory: root, workspace: root, startupTimeoutMs: 1000 }, executionAvailable: () => false, queueChanged: () => {} },
        openclaw: { history: { snapshot, refresh: async () => {}, historyReady: () => true, invalidate: () => {}, close: async () => {} },
          invalidateDiscovery: () => {},
          dispatch: { gateway: { connectionId: () => 'original-connection', prepareWriteConnection: async () => 'original-connection',
            requestBound: async () => { nativeEffects++; throw Error('NO_NATIVE_EFFECT_EXPECTED'); } },
            native: { available: () => true, epoch: () => 'original-connection' }, allowCliFallback: false, message: text => text },
          recovery: { connectionId: () => 'original-connection', query: async () => ({ status: 'timeout' }) },
          refreshSessions, refreshMessages: async () => {}, nativeSession: () => undefined,
          defaultAgentId: 'main', admissionAvailable: () => true, gatewayStatus: () => 'connected', retryMs: 10_000 },
      } };
    },
  });
  if (prepareOnly) await surface.prepare(); else await surface.start();
  const connector = surface, link = connector.localHubLink({ allowPrepared: true }), connectionId = config.hub.defaultConnectionId;
  const original = new HubStore(config.hub.databaseFile, vault);
  let memberKey = '', memberId = '', version = 0;
  try {
    const defaultConnection = hubDefaultConnection(config);
    assert.ok(defaultConnection?.kind === 'local');
    original.ensureLocalConnection({ id: connectionId, label: config.hub.defaultConnectionLabel,
      environmentId: config.connector.environmentId, environmentLabel: config.connector.environmentLabel,
      connectorUrl: 'local://aod-connector', status: defaultConnection.status });
    original.pinConnectionNode(connectionId, 'default', original.connectionAuthority(connectionId)!, connector.nodeId);
    version = original.connectionAuthority(connectionId)!;
    if (withKey) {
      const member = original.createUser('Original local member'); memberId = member.id;
      memberKey = original.identities.issueKey(member.id).token;
    }
  } finally { await original.close(); }
  const paths: string[] = [];
  const hooks: { dispatch?: (request: Request) => Promise<void> } = {};
  const borrowed = { get ready() { return connector.ready; }, localHubLink: () => ({ ...link,
    local: { ...link.local, dispatch: async (request: Request) => {
      paths.push(new URL(request.url).pathname); await hooks.dispatch?.(request); return link.local.dispatch(request);
    } },
  }) };
  const open = async () => { const layer = await createAsyncLocalHubLayer(config, borrowed); layers.push(layer); return layer; };
  const request = (layer: Awaited<ReturnType<typeof open>>, path: string, key: string | undefined = withKey ? admin : undefined,
    init: RequestInit = {}) => layer.app.request(path, { ...init, headers: {
      ...(key ? { 'x-agentopsdeck-key': key } : {}), ...init.headers,
    } });
  return { root, config, owner, connector, borrowed, open, request, paths, hooks, connectionId, version, memberKey, memberId,
    nativeEffects: () => nativeEffects, updateSession: () => updateSession(),
    issuerPath: `${base}/connections/${encodeURIComponent(connectionId)}/execution-issuer` };
}

for (const mode of ['json', 'sqlite'] as const) test(`local Hub layer ${mode}: forwards original Connector events through authenticated Hub SSE`, { timeout: 20_000 }, async t => {
  const f = await fixture(t, mode), layer = await f.open();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const response = await f.request(layer, base + '/events/stream', admin, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  try {
    let content = '';
    while (!content.includes('connector_connected')) {
      const result = await reader.read();
      assert.equal(result.done, false, 'Local Connector feed must attach before the stream ends');
      content += decoder.decode(result.value, { stream: true });
    }
    assert.ok(f.paths.some(path => path.endsWith('/events/stream')), 'Uses the borrowed local transport');
    f.updateSession();
    content = '';
    const hubSessionKey = f.connectionId + ':' + Buffer.from(session).toString('base64url');
    while (!content.includes(hubSessionKey)) {
      const result = await reader.read();
      assert.equal(result.done, false, 'Original local event must reach the Hub stream');
      content += decoder.decode(result.value, { stream: true });
    }
    assert.match(content, /event: session.updated/);
    assert.equal(f.nativeEffects(), 0);
  } finally {
    clearTimeout(timeout); controller.abort(); await reader.cancel();
  }
});

for (const mode of ['json', 'sqlite'] as const) test(`local Hub layer ${mode}: complete HTTP, original identities, local issuer and reopen`, async t => {
  const f = await fixture(t, mode), layer = await f.open();
  assert.equal((await f.request(layer, base + '/me', 'invalid')).status, 401);
  const adminRequest = new Request('http://local.invalid/', { headers: { 'x-agentopsdeck-key': admin } });
  assert.equal(typeof await layer.observeActor(adminRequest), 'string');
  assert.equal(await layer.observeActor(new Request('http://local.invalid/', { headers: { 'x-agentopsdeck-key': f.memberKey } })), undefined);
  const me = await f.request(layer, base + '/me', f.memberKey);
  assert.equal(me.status, 200); assert.equal((await me.json()).userId, f.memberId);
  const state = await f.request(layer, base + '/sessions/state');
  assert.equal(state.status, 200, await state.clone().text()); assert.ok((await state.text()).includes('Original local session'));
  assert.ok(f.paths.some(path => path.endsWith('/sessions/state')));
  const verified = await f.request(layer, `${base}/connections/${encodeURIComponent(f.connectionId)}/verify`, admin, { method: 'POST' });
  assert.equal(verified.status, 200, await verified.clone().text());
  const capabilities = await f.request(layer, `${base}/connections/${encodeURIComponent(f.connectionId)}/capabilities`, admin);
  assert.equal(capabilities.status, 200, await capabilities.clone().text());
  const capBody = await capabilities.json();
  assert.equal(capBody.connector.service, 'aod-connector');
  assert.equal(capBody.features.interactions, true);
  const before = (await f.owner.command('tokensList', {})).length;
  const install = (nodeVersion = f.version) => f.request(layer, f.issuerPath + '/local', admin, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true, nodeVersion, createSessions: true }) });
  assert.equal((await f.request(layer, f.issuerPath + '/local', f.memberKey, { method: 'POST' })).status, 403);
  const installed = await install(); assert.equal(installed.status, 201, await installed.clone().text());
  const issuer = (await installed.json()).issuer;
  assert.equal(issuer.nodeId, f.connector.nodeId); assert.equal(issuer.creationAllowed, true);
  assert.equal((await install()).status, 409, 'Stale pre-install authority must not be accepted');
  const repeated = await install(issuer.version);
  assert.equal(repeated.status, 200, await repeated.clone().text());
  assert.equal((await f.owner.command('tokensList', {})).length, before + 1);
  assert.equal((await f.request(layer, '/api/health')).status, 404, 'Sub-application cannot certify all-role process health');
  await layer.close(); assert.equal(f.connector.ready, true);
  const reopened = await f.open(), read = await f.request(reopened, f.issuerPath);
  assert.equal(read.status, 200); assert.deepEqual((await read.json()).issuer, issuer);
  assert.equal((await f.owner.command('tokensList', {})).length, before + 1);
  assert.equal(f.nativeEffects(), 0);
});

for (const mode of ['json', 'sqlite'] as const) test(`local Hub layer ${mode}: no-Key original bootstrap remains available`, async t => {
  const f = await fixture(t, mode, false), layer = await f.open();
  assert.equal((await f.request(layer, base + '/me')).status, 200);
  assert.equal(typeof await layer.observeActor(new Request('http://local.invalid/')), 'string');
  assert.equal((await f.request(layer, base + '/sessions/state')).status, 200);
  await layer.close(); assert.equal(f.connector.ready, true);
});

test('local Hub startup failure retires only its original owner and retains borrowed Connector', async t => {
  const f = await fixture(t); let exits = 0;
  const close = AsyncHubMemberOwner.prototype.closeForShutdown;
  t.mock.method(AsyncHubMemberOwner.prototype, 'closeForShutdown', async function(this: AsyncHubMemberOwner) {
    await close.call(this); assert.equal(this.snapshot().ownerExitConfirmed, true); exits++;
  });
  writeFileSync(f.config.hiddenSessionsFile, '{invalid-original-preferences');
  await assert.rejects(f.open(), /hub_member_storage_unavailable/);
  assert.equal(exits, 1); assert.equal(startupApplicationCleanup.snapshot().pending, 0);
  assert.equal(f.connector.ready, true); assert.ok((await f.owner.command('tokensList', {})).length > 0);
  writeFileSync(f.config.hiddenSessionsFile, '[]');
  const layer = await f.open(); assert.equal((await f.request(layer, base + '/me')).status, 200);
});

test('deferred local Hub assembles against a prepared Connector and publishes only after activation', async t => {
  const f = await fixture(t, 'sqlite', true, true);
  await assert.rejects(createAsyncLocalHubLayer(f.config, f.connector), /ready Connector/);
  const layer = await createAsyncLocalHubLayer(f.config, f.connector, { deferActivation: true });
  t.after(() => layer.close());
  assert.equal(layer.ready, false); assert.equal(f.connector.ready, false);
  assert.equal((await f.request(layer, base + '/me')).status, 503);
  await f.connector.start();
  const activation = layer.activate(); assert.equal(layer.activate(), activation); await activation;
  assert.equal(layer.ready, true); assert.equal((await f.request(layer, base + '/me')).status, 200);
  await layer.close(); assert.equal(layer.ready, false); await assert.rejects(layer.activate());
  assert.equal(f.connector.ready, true);
});

test('unactivated local Hub closes without activating its peers or disposing borrowed Connector', async t => {
  const f = await fixture(t, 'json', true, true);
  const layer = await createAsyncLocalHubLayer(f.config, f.connector, { deferActivation: true });
  await layer.close(); await assert.rejects(layer.activate());
  assert.equal(layer.ready, false); assert.equal(f.connector.state, 'prepared');
  assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('local Hub close fences HTTP and retains original local dispatch before SQL exit, without closing borrowed surface', async t => {
  const f = await fixture(t), layer = await f.open(), entered = gate(), release = gate();
  let exits = 0, settled = false;
  const close = AsyncHubMemberOwner.prototype.closeForShutdown;
  t.mock.method(AsyncHubMemberOwner.prototype, 'closeForShutdown', async function(this: AsyncHubMemberOwner) { exits++; await close.call(this); });
  f.hooks.dispatch = async request => {
    if (new URL(request.url).pathname.endsWith('/identity')) { entered.release(); await release.promise; }
  };
  const response = f.request(layer, `${base}/connections/${encodeURIComponent(f.connectionId)}/verify`, admin, { method: 'POST' });
  await Promise.race([entered.promise, Promise.resolve(response).then(async result => {
    assert.fail(`Identity dispatch was not reached: ${result.status} ${await result.text()}`);
  })]);
  const closing = layer.close(); void closing.then(() => { settled = true; });
  assert.equal(layer.close(), closing);
  try {
    await tick(); assert.equal(settled, false); assert.equal(exits, 0);
    assert.equal((await f.request(layer, base + '/me')).status, 503);
    assert.equal(f.connector.ready, true);
  } finally { release.release(); await response; await closing; }
  assert.equal(exits, 1); assert.equal(f.connector.ready, true);
  assert.ok((await f.owner.command('tokensList', {})).length > 0); assert.equal(f.nativeEffects(), 0);
});

test('local Hub background worker reconciles durable revocation through the same real Connector after reopen', async t => {
  const f = await fixture(t), layer = await f.open();
  const installed = await f.request(layer, f.issuerPath + '/local', admin, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true, nodeVersion: f.version }) });
  assert.equal(installed.status, 201, await installed.clone().text());
  const issuer = (await installed.json()).issuer; await layer.close();
  const original = new HubStore(f.config.hub.databaseFile, vault); let leaseId = 0;
  try {
    const target = { ownerUserId: 'default', connectionId: f.connectionId, userId: f.memberId };
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:original-local-session' };
    const grant = original.grants.create(target, { ...resource, actions: ['messages:send'] });
    const proof = original.grants.authorize(target, 'messages:send', resource, grant.id)!;
    const lease = original.executionLeases.reserve(proof, f.connector.nodeId, issuer.issuerId, ['messages:send']);
    leaseId = lease.id; original.executionLeases.revoke(leaseId);
  } finally { await original.close(); }
  let reconciled = false;
  const command = AsyncHubMemberOwner.prototype.command;
  t.mock.method(AsyncHubMemberOwner.prototype, 'command', function(this: AsyncHubMemberOwner, kind: never, input: never) {
    const work = command.call(this, kind, input);
    if (kind === 'executionLease' && (input as { action: string }).action === 'acknowledgeRevoke') {
      return work.then(value => { if ((value as { value?: boolean }).value === true) reconciled = true; return value; }) as never;
    }
    return work;
  });
  const reopened = await f.open(); await until(() => reconciled);
  assert.ok(f.paths.includes('/api/connector/v1/execution-grants/revoke'));
  await reopened.close();
  const checked = new HubStore(f.config.hub.databaseFile, vault);
  try { assert.equal(checked.executionLeases.get(leaseId)?.state, 'revoked'); }
  finally { await checked.close(); }
  assert.equal(f.connector.ready, true); assert.equal(f.nativeEffects(), 0);
});

test('local Hub dependency/role checks precede database acquisition and never relax the Hub-only process guard', async t => {
  const f = await fixture(t); let opens = 0;
  const open = AsyncHubMemberOwner.prototype.open;
  t.mock.method(AsyncHubMemberOwner.prototype, 'open', function(this: AsyncHubMemberOwner) { opens++; return open.call(this); });
  await assert.rejects(createAsyncHubApplication(f.config), /Hub-only server role/);
  await assert.rejects(createAsyncLocalHubLayer(f.config, { ...f.borrowed, ready: false }), /all-role ready Connector/);
  await assert.rejects(createAsyncLocalHubLayer(f.config, { ready: true, localHubLink: () => {
    const link = f.borrowed.localHubLink(); return { ...link, local: { ...link.local, connectionId: 'other-connection' } };
  } }), /binding mismatch/);
  f.config.hub.enabled = false; await assert.rejects(createAsyncLocalHubLayer(f.config, f.borrowed), /all-role ready Connector/);
  assert.equal(opens, 0); assert.equal(f.connector.ready, true);
});
