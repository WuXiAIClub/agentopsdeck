import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAsyncCombinedLayer } from './application-combined-async.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { AsyncHubMemberOwner } from './hub/async-member-owner.js';
import { WeixinService } from './hub/weixin-service.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { startupDatabaseOwners } from './storage/startup-owner.js';
import { HubStore } from './hub/hub-store.js';
import { ApplicationCommandScopeError, type ApplicationCommandScope } from './auth/application-command-scope.js';
import { encodeHubSessionId } from './hub/session-id.js';
import { validHubLocalPreferenceCommand } from './hub/local-preference-domain.js';
import { NativeOperationError } from './connector/native-operation.js';
import { createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { AdminRpcClient } from './gateway/admin-client.js';
import { GatewayWsClient } from './gateway/ws-client.js';
import { MediaLibrary } from './routes/media-library.js';
import { ArtifactRegistry } from './messages/artifact-receiver.js';

const key = 'isolated-combined-original-admin';
const session = 'agent:main:web:direct:combined-original', base = `/api/sessions/${encodeURIComponent(session)}`;
const intent = { action: 'message', runtime: 'openclaw', resource: session,
  commandKey: 'original-combined-message', payloadDigest: 'd'.repeat(64) } as const;
function gate() { let release!: () => void; const promise = new Promise<void>(ok => { release = ok; }); return { promise, release }; }
const tick = () => new Promise<void>(ok => setImmediate(ok));
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'combined parent did not converge'); await tick(); }
}
function heldBody() {
  const entered = gate(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { entered.release(); } });
  return { entered: entered.promise, body, finish() { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } };
}
async function fixture(t: TestContext, mode: 'json' | 'sqlite' = 'sqlite', withKey = true, waitMs?: number, transactions = false, withSystem = false) {
  const root = mkdtempSync(join(tmpdir(), 'combined-async-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'all',
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-combined-vault',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    AOD_HIDDEN_SESSIONS_FILE: join(root, 'hidden.json'),
    AOD_ARCHIVED_SESSIONS_FILE: join(root, 'archived.json'),
    AOD_PINNED_SESSIONS_FILE: join(root, 'pinned.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json'),
    ...(withSystem ? { AOD_LOCAL_OPENCLAW_CLI: 'false' } : {}),
    ...(withKey ? { AOD_ACCESS_KEY: key } : {}),
    ...(mode === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}),
  });
  const transactionLink = transactions ? createApplicationTransactionLink() : undefined;
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'),
    ...(transactions ? { sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } } : {}),
    tokenFile: join(root, 'tokens.json'), codexBoardTools: false }, undefined, undefined, 30_000, transactionLink?.connector);
  await owner.open();
  const calls = { discovery: 0, native: 0, bindingClose: 0, hubActivation: 0 };
  const system = withSystem ? { gateway: new GatewayWsClient({ url: undefined, ownerToken: undefined, password: undefined }),
    admin: new AdminRpcClient({ url: undefined, ownerToken: undefined }) } : undefined;
  const media = withSystem ? { inboundDir: root, artifactConfig: config.artifactReceiver,
    artifactRegistry: new ArtifactRegistry(join(root, 'artifacts.json')),
    library: new MediaLibrary({ enabled: true, allowedDirs: [root], linkTtlSeconds: 60, signingSecret: 'isolated-test-signing' }) } : undefined;
  if (media) writeFileSync(join(root, 'original.mp4'), 'original topology video');
  const hooks: { discovery?: () => Promise<void>; activate?: () => void;
    history?: () => Promise<void>; agents?: () => Promise<void>; files?: () => Promise<void> } = {};
  t.mock.method(globalThis, 'fetch', async () => { throw Error('UNEXPECTED_EXTERNAL_EFFECT'); });
  t.mock.method(WeixinService.prototype, 'startWorker', () => { calls.hubActivation++; hooks.activate?.(); });
  const layer = await createAsyncCombinedLayer(config, { owner, connector: config.connector,
    ...(waitMs === undefined ? {} : { waitMs }),
    sampler: { sample: async () => { throw Error('No sample expected'); }, close: async () => {} },
    bind: ({ snapshot, deck }) => {
      const refreshSessions = async () => {
        calls.discovery++; await hooks.discovery?.();
        // Discovery is a refresh, not a new fact on every snapshot attempt.
        // Like the real gateway's replaceSessions(), publish only a delta;
        // otherwise this fixture prevents the event head from converging.
        if (!deck.getSession(session)) deck.upsertSession({ sessionKey: session, agentId: 'main', title: 'Original combined local session', status: 'idle' });
      };
      return { ...(system ? { system } : {}), ...(media ? { media } : {}), refreshSessions, agents: async () => { await hooks.agents?.(); return [{ id: 'main', label: 'Original agent' }]; },
        close: async () => { calls.bindingClose++; }, runtimes: {
        codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: root, defaultModel: 'default', approvalPolicy: 'never' } },
        sdk: {}, hermes: { config: { enabled: false, executable: join(root, 'absent-python'), sourceDirectory: root,
          homeDirectory: root, workspace: root, startupTimeoutMs: 1000 }, executionAvailable: () => false, queueChanged: () => {} },
        openclaw: { history: { snapshot, refresh: async () => { await hooks.history?.(); }, historyReady: () => true, invalidate: () => {}, close: async () => {} },
          invalidateDiscovery: () => {},
          dispatch: { gateway: { connectionId: () => 'original-connection', prepareWriteConnection: async () => 'original-connection',
            requestBound: async () => { calls.native++; throw Error('NO_NATIVE_EFFECT_EXPECTED'); } },
            native: { available: () => true, epoch: () => 'original-connection' }, allowCliFallback: false, message: text => text },
          recovery: { connectionId: () => 'original-connection', query: async () => ({ status: 'timeout' }) },
          refreshSessions, refreshMessages: async () => {},
          nativeSession: key => hooks.files && key === session ? { status: 'idle' } : undefined,
          persist: async () => { await hooks.files?.(); return []; },
          defaultAgentId: 'main', admissionAvailable: () => true, gatewayStatus: () => 'connected', retryMs: 10_000 },
      } };
    },
  });
  t.after(async () => {
    await layer.close(); await system?.gateway.closeAndDrain(); await owner.close();
    transactionLink?.closeUnused();
    assert.equal(startupApplicationCleanup.snapshot().pending, 0);
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, headers: HeadersInit = withKey ? { 'x-agentopsdeck-key': key } : {}, init: RequestInit = {}) =>
    layer.app.request(path, { ...init, headers });
  return { layer, calls, hooks, request, owner, config };
}

for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false])
  test(`combined ${mode}/${keyed} original system read paths are registered before fallback`, async t => {
    const f = await fixture(t, mode, keyed, undefined, false, true); await f.layer.start();
    for (const route of ['/api/health', '/api/config/debug', '/api/gateway/status']) {
      const response = await f.request(route); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await (await f.request('/api/gateway/status')).json()).enabled, false);
    assert.equal((await f.request('/api/gateway/restart', keyed ? { 'x-agentopsdeck-key': key } : {}, { method: 'POST' })).status, 502);
    const files = await f.request('/api/files/agents/invalid.id');
    assert.equal(files.status, 400); assert.match(await files.text(), /invalid agent id/);
    assert.equal(files.headers.get('cache-control'), 'no-store');
    assert.equal((await f.request('/api/files/roots', { ...(keyed ? { 'x-agentopsdeck-key': key } : {}),
      'x-agentopsdeck-execution-grant': 'not-user-authority' })).status, 403);
    const media = await f.request('/api/media-library?root=0'); assert.equal(media.status, 200);
    const signed = (await media.json()).entries.find((row: { name: string }) => row.name === 'original.mp4').playbackUrl;
    const playback = await f.request(signed, {}); assert.equal(playback.status, 200); assert.equal(await playback.text(), 'original topology video');
    if (keyed) assert.equal((await f.request('/api/media-library', {})).status, 401);
    assert.equal(f.calls.native, 0);
    await f.layer.close(); assert.equal((await f.request('/api/health')).status, 503);
    assert.equal((await f.request('/api/files/agents/invalid.id')).status, 503);
    assert.equal((await f.request('/api/media-library')).status, 503);
  });

for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
  test(`combined local HTTP ${mode}/${withKey}: paired original messages, dedup and read-only recovery`, async t => {
    const f = await fixture(t, mode, withKey, undefined, true); let files = 0;
    f.hooks.files = async () => { files++; }; await f.layer.start();
    const submit = () => f.request(`${base}/messages`, undefined, { method: 'POST',
      body: JSON.stringify({ message: 'original combined HTTP input', idempotencyKey: 'combined-http-message' }) });
    const response = await submit();
    assert.ok(response.status >= 200 && response.status < 300, await response.clone().text());
    const accepted = await response.json(); assert.equal(accepted.command.state, 'accepted');
    await until(() => f.calls.native === 1);
    assert.deepEqual(await (await submit()).json(), accepted); assert.equal(files, 1);
    const receipt = await f.request(`${base}/commands/combined-http-message`);
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).command.id, accepted.command.id);
    assert.equal((await (await f.request(`${base}/commands/combined-http-message/queue`)).json()).queue.presence, 'present');
    assert.equal(files, 1); assert.equal(f.calls.native, 1, 'receipt reads and dedup never replay the admitted original');
    assert.equal(f.layer.commands.pending, 0);
  });
}

test('combined preference command accepts original request proof only and no executable/path authority', () => {
  const input = { field: 'hidden', key: session, enabled: true, evidence: { accessKey: key } };
  assert.equal(validHubLocalPreferenceCommand({ kind: 'localPreferenceSnapshot', input: {} }), true);
  assert.equal(validHubLocalPreferenceCommand({ kind: 'localPreferenceChange', input }), true);
  for (const invalid of [{ ...input, path: '/private' }, { ...input, actor: 'default' },
    { ...input, evidence: { authorized: true } }, { ...input, evidence: { weixinBinding: {} } },
    { ...input, evidence: { token: 'connector-bearer' } }]) {
    assert.equal(validHubLocalPreferenceCommand({ kind: 'localPreferenceChange', input: invalid }), false);
  }
});

for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: original paired bootstrap commits both SDK message SQL phases from the pinned application request`, async t => {
    const f = await fixture(t, mode, withKey, undefined, true);
    await f.layer.start();
    const token = await f.owner.command('tokenCreate', { label: 'paired-original-sdk', scopes: ['sessions:create', 'messages:send', 'messages:read'] });
    const authorization = `Bearer ${token.token}`;
    for (const runtime of ['claude-code', 'ghcp'] as const) {
      const created = await f.owner.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
      assert.ok('key' in created && created.key);
      const input = { runtime, authorization, key: created.key, commandKey: `message-${runtime}`, payloadJson: '{"message":"original paired input"}' };
      const request = () => new Request('http://application.invalid/', { headers: withKey ? { 'x-agentopsdeck-key': key } : {} });
      await assert.rejects(f.layer.messageIngress.sdk(request(), { ...input, application: {} }, { timeoutMs: 10_000 }));
      const accepted = await f.layer.messageIngress.sdk(request(), input, { timeoutMs: 10_000 });
      assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted' && 'admitted' in accepted && accepted.admitted);
      assert.equal(accepted.queue.presence, 'present');
      const duplicate = await f.layer.messageIngress.sdk(request(), input, { timeoutMs: 10_000 });
      assert.ok('receipt' in duplicate && 'admitted' in duplicate && !duplicate.admitted);
      assert.deepEqual(duplicate.receipt, accepted.receipt);
      assert.deepEqual(await f.owner.command('turnSessionPage', { runtime, after: '', limit: 64 }), [created.key]);
    }
    assert.equal(f.layer.commands.pending, 0); assert.equal(f.calls.native, 0);
    // Hub shutdown can finish without waiting for a borrowed SQL owner; its
    // original file leases remain held until the Connector's actual exit.
    await f.layer.close();
    assert.throws(() => new AsyncHubMemberOwner({ file: f.config.hub.databaseFile }));
  });

  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: real message claim retains original application scope through file wait and denies rotated authority before commit`, async t => {
    const f = await fixture(t, mode, withKey), files = gate(), entered = gate();
    f.hooks.files = async () => { entered.release(); await files.promise; };
    try {
      await f.layer.start();
      const token = await f.owner.command('tokenCreate', { label: 'original message chain', scopes: ['messages:send', 'messages:read'] });
      const scope = { key: session, commandKey: 'real-combined-original-message', authorization: `Bearer ${token.token}` };
      const sending = f.layer.messageIngress.openclaw(new Request('http://application.invalid/', {
        headers: withKey ? { 'x-agentopsdeck-key': key } : {},
      }), { ...scope, payloadJson: '{"message":"original combined input"}' }, { timeoutMs: 10_000 });
      const rejected = assert.rejects(sending, error => error instanceof NativeOperationError && error.outcome === 'unknown');
      await Promise.race([entered.promise, sending.then(() => { throw Error('message skipped original file wait'); })]);
      assert.equal(f.layer.commands.pending, 1);
      f.config.accessKey = withKey ? 'replacement-original-key' : 'newly-required-original-key';
      files.release(); await rejected;
      const recovered = await f.owner.command('openClawMessageSendReceiptRead', scope);
      assert.ok('receipt' in recovered && recovered.receipt?.state === 'outcome_unknown');
      assert.ok('queue' in recovered && recovered.queue.presence === 'unknown');
      assert.ok('intent' in recovered && recovered.intent === null && recovered.admitted === false);
      assert.deepEqual(await f.owner.command('turnSessionPage', { runtime: 'openclaw', after: '', limit: 64 }), [],
        'unknown receipt is not queue absence evidence; independently inspect the original queue');
      assert.equal(f.layer.commands.pending, 0); assert.equal(f.calls.native, 0);
      assert.deepEqual(await f.owner.command('openClawMessageSendReceiptRead', scope), recovered, 'recovery is read only');
    } finally { files.release(); }
  });

  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: original preferences retain file bytes, startup snapshot, canonical isolation and ACK projection`, async t => {
    const f = await fixture(t, mode, withKey);
    const fields = [ ['hidden', 'visibility', f.config.hiddenSessionsFile],
      ['archived', 'archive', f.config.archivedSessionsFile], ['pinned', 'pin', f.config.pinnedSessionsFile] ] as const;
    for (const [, , file] of fields) writeFileSync(file, JSON.stringify([session]));
    await f.layer.start(); const deck = f.layer.connector.deck;
    assert.equal(deck.isSessionHidden(session), true); assert.equal(deck.isSessionArchived(session), true);
    assert.equal(deck.isSessionPinned(session), true);
    assert.throws(() => deck.hideSession(session), /original async owner/);
    for (const [field, route, file] of fields) {
      assert.throws(() => startupDatabaseOwners.reserveExclusive(file), 'Original worker retains the sole file reservation');
      for (const enabled of [false, true]) {
        const response = await f.request(`${base}/${route}`, undefined,
          { method: 'PATCH', body: JSON.stringify({ [field]: enabled }) });
        assert.equal(response.status, 200); const ack = await response.json();
        assert.equal(ack.sessionKey, session); assert.equal(ack[field], enabled); assert.equal(typeof ack.updatedAt, 'number');
        assert.equal(readFileSync(file, 'utf8'), JSON.stringify(enabled ? [session] : [], null, 2));
        assert.equal(field === 'hidden' ? deck.isSessionHidden(session) : field === 'archived'
          ? deck.isSessionArchived(session) : deck.isSessionPinned(session), enabled);
      }
      const canonical = encodeHubSessionId('local', session), bytes = readFileSync(file, 'utf8');
      const response = await f.request(`/api/sessions/${encodeURIComponent(canonical)}/${route}`, undefined,
        { method: 'PATCH', body: JSON.stringify({ [field]: false }) });
      assert.equal(response.status, 200); assert.equal(readFileSync(file, 'utf8'), bytes, 'Canonical preference must not touch the original raw file');
    }
    assert.equal((await f.request(base + '/pin', undefined, { method: 'PATCH', body: '{}' })).status, 200);
    assert.equal((await f.request(base + '/pin', undefined, { method: 'PATCH', body: 'null' })).status, 400);
    assert.equal(f.calls.native, 0);
    await f.layer.close();
    for (const [, , file] of fields) startupDatabaseOwners.reserveExclusive(file)();
    const worker = new AsyncHubMemberOwner({ file: f.config.hub.databaseFile,
      ...(f.config.hub.vaultSecret === undefined ? {} : { encryptionSecret: f.config.hub.vaultSecret }),
      ...(withKey ? { administratorKey: key } : {}), auth: mode === 'sqlite'
        ? { file: f.config.authSqliteFile!, legacyFiles: [f.config.passkeysFile, f.config.authSessionsFile] }
        : { kind: 'json', passkeysFile: f.config.passkeysFile, sessionsFile: f.config.authSessionsFile },
      bootstrap: { ownLocalPreferences: true, legacyPreferences: { hidden: f.config.hiddenSessionsFile,
        archived: f.config.archivedSessionsFile, pinned: f.config.pinnedSessionsFile } } });
    try {
      await worker.open();
      assert.deepEqual(await worker.command('legacyAuth', { kind: 'localPreferenceSnapshot', input: {} }),
        { kind: 'localPreferenceSnapshot', value: { hidden: [session], archived: [session], pinned: [session] } });
    } finally { await worker.closeForShutdown(); }
  });
}

for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: rotation during principal ACK cannot admit an original command`, async t => {
    const f = await fixture(t, mode, withKey); await f.layer.start();
    const entered = gate(), physical = gate(), original = AsyncHubMemberOwner.prototype.command;
    t.mock.method(AsyncHubMemberOwner.prototype, 'command', async function(this: AsyncHubMemberOwner,
      ...args: Parameters<AsyncHubMemberOwner['command']>) {
      const result = await original.apply(this, args);
      if (args[0] === 'memberSnapshot') { entered.release(); await physical.promise; }
      return result;
    });
    let effects = 0;
    const pending = f.layer.commands.run(new Request('http://local.invalid/', {
      headers: withKey ? { 'x-agentopsdeck-key': key } : {},
    }), intent, async () => { effects++; });
    // Attach before releasing the held ACK so expected refusal never becomes
    // an unhandled rejection while the worker is still physically pending.
    const outcome = pending.then(() => false, error => error instanceof ApplicationCommandScopeError);
    await entered.promise;
    try { f.config.accessKey = withKey ? undefined : 'newly-required-original-key'; }
    finally { physical.release(); }
    assert.equal(await outcome, true); assert.equal(effects, 0); assert.equal(f.layer.commands.pending, 0);
  });

  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: synchronous effect fence rejects a rotated owner binding`, async t => {
    const f = await fixture(t, mode, withKey); await f.layer.start();
    await f.layer.commands.run(new Request('http://local.invalid/', {
      headers: withKey ? { 'x-agentopsdeck-key': key } : {},
    }), intent, async scope => {
      await scope.authorize('effect');
      f.config.accessKey = withKey ? 'replacement-original-key' : 'newly-required-original-key';
      assert.throws(scope.local, ApplicationCommandScopeError);
    });
    assert.equal(f.calls.native, 0);
  });

  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: rotation during preference body preserves original bytes and projection`, async t => {
    const f = await fixture(t, mode, withKey); writeFileSync(f.config.pinnedSessionsFile, '[]'); await f.layer.start();
    const body = heldBody(), request = new Request('http://localhost' + base + '/pin', {
      method: 'PATCH', headers: withKey ? { 'x-agentopsdeck-key': key } : {}, body: body.body, duplex: 'half',
    } as RequestInit);
    const pending = f.layer.app.fetch(request);
    try {
      await body.entered;
      for (let attempts = 0; !request.bodyUsed && attempts < 1000; attempts++) await new Promise(ok => setTimeout(ok, 5));
      assert.equal(request.bodyUsed, true);
      f.config.accessKey = withKey ? undefined : 'newly-required-original-key';
    } finally { body.finish(); }
    assert.equal((await pending).status, 503);
    assert.equal(readFileSync(f.config.pinnedSessionsFile, 'utf8'), '[]');
    assert.equal(f.layer.connector.deck.isSessionPinned(session), false); assert.equal(f.calls.native, 0);
  });
}

for (const mode of ['json', 'sqlite'] as const) {
  test(`combined ${mode}: logout during preference body rejects original Cookie despite header substitution`, async t => {
    const f = await fixture(t, mode); writeFileSync(f.config.pinnedSessionsFile, '[]'); await f.layer.start();
    const login = await f.request('/api/auth/login', { 'content-type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ accessKey: key }) });
    const cookie = login.headers.getSetCookie().find(v => v.startsWith('agentopsdeck_session='))?.split(';')[0]; assert.ok(cookie);
    const body = heldBody(), request = new Request('http://localhost' + base + '/pin', {
      method: 'PATCH', headers: { cookie }, body: body.body, duplex: 'half',
    } as RequestInit);
    const pending = f.layer.app.fetch(request); await body.entered;
    // Bound the actual route-entry wait, and always release the request body
    // even when an assertion fails so fixture shutdown cannot hang.
    try {
      for (let attempts = 0; !request.bodyUsed && attempts < 1000; attempts++) await new Promise(ok => setTimeout(ok, 5));
      assert.equal(request.bodyUsed, true);
      request.headers.delete('cookie'); request.headers.set('x-agentopsdeck-key', key);
      assert.equal((await f.request('/api/auth/logout', { cookie }, { method: 'POST' })).status, 200);
    }
    finally { body.finish(); }
    assert.equal((await pending).status, 403);
    assert.equal(readFileSync(f.config.pinnedSessionsFile, 'utf8'), '[]'); assert.equal(f.layer.connector.deck.isSessionPinned(session), false);
  });

  test(`combined ${mode}: preference physical ACK projects during close before releasing original file and event owners`, async t => {
    const f = await fixture(t, mode); writeFileSync(f.config.pinnedSessionsFile, '[]'); await f.layer.start();
    const entered = gate(), physical = gate(), original = AsyncHubMemberOwner.prototype.command;
    t.mock.method(AsyncHubMemberOwner.prototype, 'command', async function(this: AsyncHubMemberOwner,
      ...args: Parameters<AsyncHubMemberOwner['command']>) {
      const result = await original.apply(this, args);
      if (args[0] === 'legacyAuth' && (args[1] as { kind?: string }).kind === 'localPreferenceChange') {
        entered.release(); await physical.promise;
      }
      return result;
    });
    const pending = f.request(base + '/pin', undefined, { method: 'PATCH', body: '{}' }); await entered.promise;
    assert.equal(readFileSync(f.config.pinnedSessionsFile, 'utf8'), JSON.stringify([session], null, 2));
    assert.equal(f.layer.connector.deck.isSessionPinned(session), false, 'Projection waits the physical success ACK');
    let closed = false; const closing = f.layer.close().then(() => { closed = true; });
    try {
      await tick(); assert.equal(closed, false); assert.equal(f.calls.bindingClose, 0);
      assert.throws(() => startupDatabaseOwners.reserveExclusive(f.config.pinnedSessionsFile));
      assert.equal(f.layer.connector.events.status().closing, false);
    } finally { physical.release(); }
    assert.equal((await pending).status, 200); await closing;
    assert.equal(f.layer.connector.deck.isSessionPinned(session), true); assert.equal(f.calls.bindingClose, 1);
    startupDatabaseOwners.reserveExclusive(f.config.pinnedSessionsFile)();
  });

  test(`combined ${mode}: lost preference ACK is unknown, never resubmitted or projected as success`, async t => {
    const f = await fixture(t, mode); writeFileSync(f.config.pinnedSessionsFile, '[]'); await f.layer.start();
    const original = AsyncHubMemberOwner.prototype.command; let changes = 0;
    t.mock.method(AsyncHubMemberOwner.prototype, 'command', async function(this: AsyncHubMemberOwner,
      ...args: Parameters<AsyncHubMemberOwner['command']>) {
      const result = await original.apply(this, args);
      if (args[0] === 'legacyAuth' && (args[1] as { kind?: string }).kind === 'localPreferenceChange') {
        changes++; throw Error('Original physical result lost after commit');
      }
      return result;
    });
    const response = await f.request(base + '/pin', undefined, { method: 'PATCH', body: '{}' });
    assert.equal(response.status, 503); assert.equal(changes, 1);
    assert.equal(readFileSync(f.config.pinnedSessionsFile, 'utf8'), JSON.stringify([session], null, 2));
    assert.equal(f.layer.connector.deck.isSessionPinned(session), false, 'Unknown outcome is not an accepted projection');
    await f.layer.close(); assert.equal(changes, 1); assert.equal(f.calls.native, 0);
  });
}

for (const mode of ['json', 'sqlite'] as const) {
  for (const withKey of [true, false]) {
    test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: prepare/assemble/activate preserves original Hub HTTP`, async t => {
      const f = await fixture(t, mode, withKey);
      assert.equal(f.layer.ready, false); assert.equal(f.calls.discovery, 0); assert.equal(f.calls.hubActivation, 0);
      // A pre-start probe must not freeze Hono's matcher before route assembly.
      assert.equal((await f.request('/api/hub/v1/me')).status, 503);
      const starting = f.layer.start(); assert.equal(f.layer.start(), starting); await starting;
      assert.equal(f.layer.ready, true); assert.ok(f.calls.discovery > 0); assert.equal(f.calls.hubActivation, 1);
      assert.equal((await f.request('/api/hub/v1/me')).status, 200);
      assert.equal((await f.request('/api/auth/status')).status, 200);
      if (withKey) assert.equal((await f.request('/api/hub/v1/me', { 'x-agentopsdeck-key': 'wrong' })).status, 401);
      // Browser command origin protection still wraps the machine route.
      assert.equal((await f.request('/api/connector/v1/sessions', { origin: 'https://untrusted.invalid' }, { method: 'POST' })).status, 403);
      assert.equal(f.calls.native, 0);
      const closing = f.layer.close(); assert.equal(f.layer.close(), closing);
      assert.equal(f.layer.ready, false); assert.equal((await f.request('/api/hub/v1/me')).status, 503);
      await closing; await assert.rejects(f.layer.start());
      assert.equal(f.calls.bindingClose, 1); assert.ok(await f.owner.command('nodeIdentity', {}));
    });
  }
}

test('combined close before start never activates peers and retains borrowed SQL', async t => {
  const f = await fixture(t); await f.layer.close(); await assert.rejects(f.layer.start());
  assert.equal(f.calls.discovery, 0); assert.equal(f.calls.hubActivation, 0); assert.equal(f.calls.bindingClose, 1);
  assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('combined close during original discovery retains its physical work and never activates Hub', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  f.hooks.discovery = async () => { entered.release(); await release.promise; };
  const starting = f.layer.start(), rejected = assert.rejects(starting); await entered.promise;
  let closed = false;
  const closing = f.layer.close(); void closing.then(() => { closed = true; });
  try {
    await tick(); assert.equal(closed, false); assert.equal(f.layer.ready, false);
    assert.equal(f.calls.bindingClose, 0); assert.equal(f.calls.hubActivation, 0);
    assert.equal((await f.request('/api/hub/v1/me')).status, 503);
  } finally { release.release(); await rejected; await closing; }
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.native, 0);
});

test('combined close racing Hub worker assembly waits its exact owner before Connector disposal', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  const original = AsyncHubMemberOwner.prototype.open;
  t.mock.method(AsyncHubMemberOwner.prototype, 'open', async function(this: AsyncHubMemberOwner) {
    entered.release(); await release.promise; return original.call(this);
  });
  const starting = f.layer.start(), rejected = assert.rejects(starting); await entered.promise;
  let closed = false; const closing = f.layer.close(); void closing.then(() => { closed = true; });
  try { await tick(); assert.equal(closed, false); assert.equal(f.calls.bindingClose, 0); }
  finally { release.release(); await rejected; await closing; }
  assert.equal(f.calls.discovery, 0); assert.equal(f.calls.hubActivation, 0); assert.equal(f.calls.bindingClose, 1);
});

test('combined malformed original Hub recovery prevents runtime activation without replacing data', async t => {
  const f = await fixture(t); writeFileSync(f.config.hiddenSessionsFile, '{invalid-original-preferences');
  await assert.rejects(f.layer.start()); assert.equal(f.layer.ready, false);
  assert.equal(f.calls.discovery, 0); assert.equal(f.calls.hubActivation, 0); assert.equal(f.calls.bindingClose, 1);
  assert.ok(await f.owner.command('nodeIdentity', {}));
});

test('combined original discovery failure closes acquired Hub and never publishes readiness', async t => {
  const f = await fixture(t); f.hooks.discovery = async () => { throw Error('ORIGINAL_DISCOVERY_FAILED'); };
  await assert.rejects(f.layer.start()); assert.equal(f.layer.ready, false);
  assert.equal(f.calls.hubActivation, 0); assert.equal(f.calls.bindingClose, 1);
  assert.equal((await f.request('/api/hub/v1/me')).status, 503);
});

test('combined Hub activation failure drains already-started Connector without fallback or replay', async t => {
  const f = await fixture(t); f.hooks.activate = () => { throw Error('ORIGINAL_HUB_ACTIVATION_FAILED'); };
  await assert.rejects(f.layer.start()); assert.equal(f.layer.ready, false);
  assert.equal(f.calls.hubActivation, 1); assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.native, 0);
  await assert.rejects(f.layer.start()); assert.equal(f.calls.hubActivation, 1);
});

for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: original frontend read wire is reached through Hub authority`, async t => {
    const f = await fixture(t, mode, withKey); await f.layer.start();
    const agents = await f.request('/api/agents');
    assert.equal(agents.status, 200); assert.equal(agents.headers.get('cache-control'), 'no-store');
    const agentBody = await agents.json(); assert.deepEqual(agentBody.agents, [{ id: 'main', label: 'Original agent' }]);
    assert.equal(typeof agentBody.updatedAt, 'number');
    const state = await f.request('/api/sessions/state'); assert.equal(state.status, 200);
    assert.match(await state.text(), /Original combined local session/);
    const detail = await f.request(base); assert.equal(detail.status, 200);
    assert.equal((await detail.json()).sessionKey, session);
    const messages = await f.request(base + '/messages'); assert.equal(messages.status, 200);
    const body = await messages.json(); assert.deepEqual(body.messages, []); assert.equal(body.totalCount, 0);
    assert.equal((await f.request(base + '/messages?before=missing')).status, 409);
    assert.equal((await f.request(base + '/activity')).status, 200);
    assert.equal((await f.request('/api/attention')).status, 200);
    assert.equal((await f.request(base + '/messages', undefined, { method: 'POST', body: '{}' })).status, 404);
    assert.equal(f.calls.native, 0, 'Read compatibility must not manufacture native write authority');
    if (withKey) {
      assert.equal((await f.request(base, {})).status, 401);
      assert.equal((await f.request('/api/agents', { authorization: 'Bearer unrelated-connector-token' })).status, 401);
    }
  });

  test(`combined ${mode}/${withKey ? 'Key' : 'no Key'}: command close retains original Hub owner, binding and projection until physical ACK`, async t => {
    const f = await fixture(t, mode, withKey), entered = gate(), physical = gate();
    const request = new Request('http://local.invalid/', { headers: withKey ? { 'x-agentopsdeck-key': key } : {} });
    await assert.rejects(f.layer.commands.run(request, intent, async () => 'must-not-run'));
    await f.layer.start(); let scope!: ApplicationCommandScope;
    const pending = f.layer.commands.run(request, intent, async current => {
      scope = current; await current.authorize('prepare'); await current.authorize('effect');
      entered.release(); await physical.promise; return 'original-physical-ack';
    });
    await entered.promise;
    const closing = f.layer.close(); let closed = false; void closing.then(() => { closed = true; });
    try {
      await tick(); assert.equal(closed, false); assert.equal(f.layer.commands.pending, 1);
      assert.throws(scope.local, ApplicationCommandScopeError);
      await assert.rejects(scope.authorize('effect'), ApplicationCommandScopeError);
      await assert.rejects(f.layer.commands.run(request, intent, async () => 'must-not-run'));
      assert.equal(f.calls.bindingClose, 0); assert.equal(f.layer.connector.events.status().closing, false);
      assert.throws(() => startupDatabaseOwners.reserveExclusive(f.config.hub.databaseFile));
    } finally { physical.release(); assert.equal(await pending, 'original-physical-ack'); await closing; }
    assert.equal(f.layer.commands.pending, 0); assert.equal(f.calls.bindingClose, 1);
    assert.ok(await f.owner.command('nodeIdentity', {}));
  });
}

for (const mode of ['json', 'sqlite'] as const) {
  test(`combined ${mode}: original member Key/Cookie cannot read raw sessions, save raw preferences or enter native command scope`, async t => {
    const f = await fixture(t, mode);
    // Original fixture writes happen before the sole production worker opens.
    const original = new HubStore(f.config.hub.databaseFile, f.config.hub.vaultSecret);
    const member = original.createUser('Existing original member'), memberKey = original.identities.issueKey(member.id);
    const memberCookie = original.identities.createSession(memberKey.token)!; await original.close();
    for (const file of [f.config.hiddenSessionsFile, f.config.archivedSessionsFile, f.config.pinnedSessionsFile]) writeFileSync(file, '[]');
    await f.layer.start(); let effects = 0;
    for (const headers of [{ 'x-agentopsdeck-key': memberKey.token }, { cookie: `agentopsdeck_session=${memberCookie}` }]) {
      assert.equal((await f.request('/api/hub/v1/me', headers)).status, 200);
      for (const path of [base, base + '/messages', '/api/sessions/state', '/api/agents', '/api/attention', '/api/events/stream']) {
        assert.equal((await f.request(path, headers)).status, 403);
      }
      for (const route of ['visibility', 'archive', 'pin']) {
        assert.equal((await f.request(`${base}/${route}`, headers, { method: 'PATCH', body: '{}' })).status, 403);
      }
      await assert.rejects(f.layer.commands.run(new Request('http://local.invalid/', { headers }), intent,
        async () => { effects++; }));
    }
    for (const file of [f.config.hiddenSessionsFile, f.config.archivedSessionsFile, f.config.pinnedSessionsFile]) assert.equal(readFileSync(file, 'utf8'), '[]');
    assert.equal(f.layer.connector.deck.isSessionHidden(session), false);
    assert.equal(f.layer.connector.deck.isSessionArchived(session), false);
    assert.equal(f.layer.connector.deck.isSessionPinned(session), false);
    assert.equal(effects, 0); assert.equal(f.calls.native, 0);
  });

  test(`combined ${mode}: logout during original history suppresses buffered delivery without native resend`, async t => {
    const f = await fixture(t, mode); await f.layer.start();
    const login = await f.request('/api/auth/login', { 'content-type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ accessKey: key }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(v => v.startsWith('agentopsdeck_session='))?.split(';')[0]; assert.ok(cookie);
    const entered = gate(), physical = gate();
    f.hooks.history = async () => { entered.release(); await physical.promise; };
    const pending = f.request(base + '/messages', { cookie }); await entered.promise;
    try {
      assert.equal((await f.request('/api/auth/logout', { cookie }, { method: 'POST' })).status, 200);
    } finally { physical.release(); }
    const response = await pending; assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /Original combined local session/);
    assert.equal((await f.request(base, { cookie })).status, 401); assert.equal(f.calls.native, 0);
  });

  test(`combined ${mode}: command retains original credential copy and rechecks logout before effect`, async t => {
    const f = await fixture(t, mode); await f.layer.start();
    const login = await f.request('/api/auth/login', { 'content-type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ accessKey: key }) });
    const cookie = login.headers.getSetCookie().find(v => v.startsWith('agentopsdeck_session='))?.split(';')[0]; assert.ok(cookie);
    const entered = gate(), physical = gate(), request = new Request('http://local.invalid/', { headers: { cookie } });
    let effects = 0;
    const pending = f.layer.commands.run(request, intent, async scope => {
      entered.release(); await physical.promise; await scope.authorize('effect'); effects++;
    });
    const rejected = assert.rejects(pending, ApplicationCommandScopeError); await entered.promise;
    try {
      request.headers.set('x-agentopsdeck-key', key); request.headers.delete('cookie');
      assert.equal((await f.request('/api/auth/logout', { cookie }, { method: 'POST' })).status, 200);
    } finally { physical.release(); }
    await rejected; assert.equal(effects, 0); assert.equal(f.layer.commands.pending, 0);
  });

  test(`combined ${mode}: Key rotation while original agent read is pending fails closed`, async t => {
    const f = await fixture(t, mode); await f.layer.start();
    const entered = gate(), physical = gate();
    f.hooks.agents = async () => { entered.release(); await physical.promise; };
    const pending = f.request('/api/agents'); await entered.promise;
    try { f.config.accessKey = 'rotated-original-configuration'; }
    finally { physical.release(); }
    const response = await pending; assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Original agent/);
    // Neither old nor new key may silently replace the pinned original owner.
    for (const value of [key, f.config.accessKey]) {
      await assert.rejects(f.layer.commands.run(new Request('http://local.invalid/', { headers: { 'x-agentopsdeck-key': value } }),
        intent, async () => 'must-not-run'), ApplicationCommandScopeError);
    }
    assert.equal(f.calls.native, 0);
  });

  test(`combined ${mode}: timed-out original agents read retains Auth/Hub until its physical outcome`, async t => {
    const f = await fixture(t, mode, true, 500); await f.layer.start();
    const entered = gate(), physical = gate();
    f.hooks.agents = async () => { entered.release(); await physical.promise; };
    const pending = f.request('/api/agents'); await entered.promise;
    let closing: Promise<void> | undefined, closed = false;
    try {
      assert.equal((await pending).status, 503);
      closing = f.layer.close(); void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false); assert.equal(f.calls.bindingClose, 0);
      assert.throws(() => startupDatabaseOwners.reserveExclusive(f.config.hub.databaseFile));
      assert.equal(f.layer.connector.events.status().closing, false);
    } finally { physical.release(); await closing; }
    assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.native, 0);
  });
}
