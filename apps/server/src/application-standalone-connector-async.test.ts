import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AdminRpcClient } from './gateway/admin-client.js';
import { GatewayWsClient } from './gateway/ws-client.js';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAsyncStandaloneConnectorLayer, type StandaloneConnectorLayerOptions } from './application-standalone-connector-async.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { DeckStore, type DeckStoreOptions } from './projection/deck-store.js';
import { OriginalLocalPreferences, validLocalPreferenceSnapshot } from './auth/local-preference-domain.js';
import { startupDatabaseOwners } from './storage/startup-owner.js';
import { AsyncSqliteAuthOwner } from './auth/async-sqlite-owner.js';
import { ApplicationCommandScopeError, type ApplicationCommandScope } from './auth/application-command-scope.js';
import { NativeOperationError } from './connector/native-operation.js';
import { createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { MediaLibrary } from './routes/media-library.js';
import { ArtifactRegistry } from './messages/artifact-receiver.js';

const key = 'agent:main:web:direct:original', base = `/api/sessions/${encodeURIComponent(key)}`;
const secret = 'private-parent-access', bearer = 'parent-connector-bearer';
const origin = 'http://parent.example';
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const tick = () => new Promise<void>(r => setImmediate(r));

for (const mode of ['json', 'sqlite'] as const) for (const keyed of [true, false])
  test(`standalone ${mode}/${keyed} original system reads precede Connector fallback`, async t => {
    const f = await fixture(t, mode, keyed, undefined, false, true); await f.layer.start();
    for (const route of ['/api/health', '/api/config/debug', '/api/gateway/status']) {
      const response = await f.request(route, { headers: f.headers });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await (await f.request('/api/gateway/status', { headers: f.headers })).json()).enabled, false);
    assert.equal((await f.request('/api/gateway/restart', { method: 'POST', headers: f.headers })).status, 502);
    const files = await f.request('/api/files/agents/invalid.id', { headers: f.headers });
    assert.equal(files.status, 400); assert.match(await files.text(), /invalid_file_request/);
    assert.equal(files.headers.get('cache-control'), 'no-store');
    assert.equal((await f.request('/api/files/roots', { headers: { ...f.headers, 'x-agentopsdeck-execution-grant': 'not-user-authority' } })).status, 403);
    const media = await f.request('/api/media-library?root=0', { headers: f.headers }); assert.equal(media.status, 200);
    const signed = (await media.json()).entries.find((row: { name: string }) => row.name === 'original.mp4').playbackUrl;
    const playback = await f.request(signed); assert.equal(playback.status, 200); assert.equal(await playback.text(), 'original topology video');
    if (keyed) assert.equal((await f.request('/api/media-library')).status, 401);
    assert.equal(f.calls.native, 0);
    await f.layer.close(); assert.equal((await f.request('/api/health', { headers: f.headers })).status, 503);
    assert.equal((await f.request('/api/files/agents/invalid.id', { headers: f.headers })).status, 503);
    assert.equal((await f.request('/api/media-library', { headers: f.headers })).status, 503);
  });
const commandIntent = { action: 'message', runtime: 'openclaw', resource: key,
  commandKey: 'parent-original-message', payloadDigest: 'b'.repeat(64) } as const;
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'parent did not converge'); await tick(); }
}

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`standalone HTTP ${format}/${keyed}: original app identity commits once and recovers receipt without sending`, async t => {
    const f = await fixture(t, format, keyed, undefined, true); let files = 0;
    f.hooks.files = async () => { files++; }; await f.layer.start();
    const submit = (headers: HeadersInit = f.headers) => f.request(`${base}/messages`, { method: 'POST',
      headers, body: JSON.stringify({ message: 'original HTTP input', idempotencyKey: 'local-http-message' }) });
    if (keyed) {
      assert.equal((await submit({ 'x-agentopsdeck-key': 'wrong-original-key' })).status, 401);
      assert.equal(files, 0);
    }
    const response = await submit();
    assert.ok(response.status >= 200 && response.status < 300, await response.clone().text());
    const accepted = await response.json(); assert.equal(accepted.command.state, 'accepted');
    assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'local-http-message');
    await until(() => f.calls.native === 1);
    const duplicate = await submit(); assert.deepEqual(await duplicate.json(), accepted);
    assert.equal(files, 1);
    const receipt = await f.request(`${base}/commands/local-http-message`, { headers: f.headers });
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).command.id, accepted.command.id);
    const queue = await f.request(`${base}/commands/local-http-message/queue`, { headers: f.headers });
    assert.equal(queue.status, 200); assert.equal((await queue.json()).queue.presence, 'present');
    assert.equal((await f.request(`${base}/commands/unknown-command`, { headers: f.headers })).status, 404);
    assert.equal(files, 1); assert.equal(f.calls.native, 1, 'receipt reads and dedup never replay the admitted original');
    assert.equal(f.layer.commands.pending, 0);
  });
}

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`parent ${format}/${keyed ? 'Key' : 'no Key'} retains native binding/events and Auth through original physical command`, async t => {
    const f = await fixture(t, format, keyed), entered = gate(), physical = gate();
    const request = new Request(origin, { headers: { 'x-agentopsdeck-key': secret } });
    await assert.rejects(f.layer.commands.run(request, commandIntent, async () => 'must-not-run'));
    assert.equal(f.layer.commands.pending, 0);
    await f.layer.start();
    const observationsBefore = f.diagnostics.snapshot().totals.observations;
    let scope!: ApplicationCommandScope;
    const pending = f.layer.commands.run(request, commandIntent, async current => {
      scope = current; await current.authorize('prepare'); await current.authorize('effect');
      entered.release(); await physical.promise; return 'original-physical-ack';
    });
    await entered.promise;
    // Routine successes are counted, but intentionally not retained in the
    // bounded recovery ring (nor guaranteed delivery after rate limiting).
    assert.ok(f.diagnostics.snapshot().totals.observations >= observationsBefore + 3);
    const closing = f.layer.close();
    try {
      assert.equal(f.layer.ready, false); assert.equal(f.layer.commands.pending, 1);
      assert.throws(scope.local, ApplicationCommandScopeError);
      await assert.rejects(scope.authorize('effect'), ApplicationCommandScopeError);
      await assert.rejects(f.layer.commands.run(request, commandIntent, async () => 'must-not-run'));
      assert.equal(f.calls.bindingClose, 0);
      assert.equal(f.layer.connector.events.status().closing, false);
      assert.throws(() => startupDatabaseOwners.reserveExclusive(format === 'sqlite' ? f.config.authSqliteFile! : f.config.authSessionsFile));
    } finally { physical.release(); assert.equal(await pending, 'original-physical-ack'); await closing; }
    assert.equal(f.calls.bindingClose, 1); assert.equal(f.layer.commands.pending, 0);
    assert.ok((await f.owner.command('tokensList', {})).length > 0, 'borrowed Connector owner remains original');
    assert.doesNotMatch(f.logs.join('\n'), new RegExp(`${secret}|${bearer}|${key}|${f.root}|${commandIntent.commandKey}|${commandIntent.payloadDigest}`));
  });
}
async function fixture(t: TestContext, format: 'json' | 'sqlite' = 'sqlite', keyed = true,
  configure?: (options: StandaloneConnectorLayerOptions, root: string) => void, paired = false, withSystem = false) {
  const root = mkdtempSync(join(tmpdir(), 'standalone-parent-')), logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const config = { ...loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'auth-sessions.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json'),
    ...(withSystem ? { AOD_LOCAL_OPENCLAW_CLI: 'false' } : {}),
    AOD_HIDDEN_SESSIONS_FILE: join(root, 'hidden.json'), AOD_ARCHIVED_SESSIONS_FILE: join(root, 'archived.json'),
    AOD_PINNED_SESSIONS_FILE: join(root, 'pinned.json'), ...(keyed ? { AOD_ACCESS_KEY: secret } : {}),
    ...(format === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) }),
    sessionTitlesFile: join(root, 'titles.json'), sessionThinkingOverridesFile: join(root, 'thinking.json') };
  const files = [config.hiddenSessionsFile, config.archivedSessionsFile, config.pinnedSessionsFile] as const;
  for (const file of files) writeFileSync(file, JSON.stringify({ [key]: true, ' existing ': false }));
  const before = files.map(file => ({ bytes: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs }));
  const link = paired ? createApplicationTransactionLink() : undefined;
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: bearer, codexBoardTools: false }, diagnostics, undefined, 30_000, link?.connector);
  let layer: Awaited<ReturnType<typeof createAsyncStandaloneConnectorLayer>> | undefined;
  const system = withSystem ? { gateway: new GatewayWsClient({ url: undefined, ownerToken: undefined, password: undefined }),
    admin: new AdminRpcClient({ url: undefined, ownerToken: undefined }) } : undefined;
  const media = withSystem ? { inboundDir: root, artifactConfig: config.artifactReceiver,
    artifactRegistry: new ArtifactRegistry(join(root, 'artifacts.json')),
    library: new MediaLibrary({ enabled: true, allowedDirs: [root], linkTtlSeconds: 60, signingSecret: 'isolated-test-signing' }) } : undefined;
  if (media) writeFileSync(join(root, 'original.mp4'), 'original topology video');
  t.after(async () => { try { await layer?.close(); await system?.gateway.closeAndDrain(); } finally { await owner.close(); link?.closeUnused(); rmSync(root, { recursive: true, force: true }); } });
  await owner.open();
  const calls = { discovery: 0, native: 0, bindingClose: 0 };
  const hooks: { discovery?: () => Promise<void>; files?: () => Promise<void> } = {};
  const options: StandaloneConnectorLayerOptions = { owner, diagnostics,
    connector: { environmentId: 'original-env', environmentLabel: 'Original environment' },
    sampler: { sample: async () => { throw Error('no sample'); }, close: async () => {} },
    bind: ({ deck, snapshot }) => {
      // Snapshot must already be installed when the real binding is built.
      assert.equal(deck.isSessionHidden(key), true); assert.equal(deck.isSessionPinned(key), true);
      assert.equal(deck.requiresAsyncEvents, true);
      const refreshSessions = async () => {
        calls.discovery++; await hooks.discovery?.();
        if (!deck.getSession(key)) deck.upsertSession({ sessionKey: key, agentId: 'main', title: 'Native title', status: 'idle' });
      };
      return { ...(system ? { system } : {}), ...(media ? { media } : {}), refreshSessions, agents: () => [], close: async () => { calls.bindingClose++; }, runtimes: {
        codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: root, defaultModel: 'default', approvalPolicy: 'never' } },
        sdk: {}, hermes: { config: { enabled: false, executable: join(root, 'absent-python'), sourceDirectory: root,
          homeDirectory: root, workspace: root, startupTimeoutMs: 1000 }, executionAvailable: () => false, queueChanged: () => {} },
        openclaw: {
          history: { snapshot, refresh: async () => {}, historyReady: () => true, invalidate: () => {}, close: async () => {} },
          invalidateDiscovery: () => {}, dispatch: {
            gateway: { connectionId: () => 'original-connection', prepareWriteConnection: async () => 'original-connection',
              requestBound: async () => { calls.native++; throw Error('no native effect'); } },
            native: { available: () => true, epoch: () => 'original-connection' }, allowCliFallback: false, message: text => text },
          recovery: { connectionId: () => 'original-connection', query: async () => ({ status: 'timeout' }) },
          refreshSessions, refreshMessages: async () => {},
          nativeSession: session => hooks.files && session === key ? { status: 'idle' } : undefined, defaultAgentId: 'main',
          persist: async () => { await hooks.files?.(); return []; },
          admissionAvailable: () => true, gatewayStatus: () => 'connected', retryMs: 10_000,
        },
      } };
    },
  };
  configure?.(options, root);
  layer = await createAsyncStandaloneConnectorLayer(config, options);
  const current = layer;
  const request = (path: string, init?: RequestInit) => current.app.request(origin + path, init);
  const headers = keyed ? { 'x-agentopsdeck-key': secret } : {};
  return { root, config, files, before, owner, layer, calls, hooks, logs, diagnostics, request, headers };
}

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`standalone paired ${format}/${keyed ? 'Key' : 'no-Key'}: actual parent transfers original Auth peer and commits one physical message`, async t => {
    const f = await fixture(t, format, keyed, undefined, true); let files = 0;
    f.hooks.files = async () => { files++; };
    await f.layer.start();
    const request = new Request(origin, { headers: f.headers });
    const input = { key, authorization: `Bearer ${bearer}`, commandKey: 'paired-parent-message', payloadJson: '{"message":"original"}' };
    if (keyed) {
      await assert.rejects(f.layer.messageIngress.openclaw(new Request(origin, { headers: { 'x-agentopsdeck-key': 'wrong' } }), input, { timeoutMs: 10_000 }));
      assert.equal(files, 0);
    }
    const accepted = await f.layer.messageIngress.openclaw(request, input, { timeoutMs: 10_000 });
    assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted' && accepted.admitted);
    const duplicate = await f.layer.messageIngress.openclaw(request, input, { timeoutMs: 10_000 });
    assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, accepted.receipt);
    assert.equal(files, 1);
    assert.doesNotMatch(f.logs.join('\n'), new RegExp(`${secret}|${bearer}|${f.root}`));
  });
}

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`standalone ${format}/${keyed ? 'Key' : 'no Key'}: real message claim retains Auth through file wait and denies rotated authority before commit`, async t => {
    const f = await fixture(t, format, keyed), files = gate(), entered = gate();
    f.hooks.files = async () => { entered.release(); await files.promise; };
    try {
      await f.layer.start();
      const scope = { key, commandKey: 'real-standalone-original-message', authorization: `Bearer ${bearer}` };
      const sending = f.layer.messageIngress.openclaw(new Request(origin, { headers: f.headers }),
        { ...scope, payloadJson: '{"message":"original standalone input"}' }, { timeoutMs: 10_000 });
      const rejected = assert.rejects(sending, error => error instanceof NativeOperationError && error.outcome === 'unknown');
      await Promise.race([entered.promise, sending.then(() => { throw Error('message skipped original file wait'); })]);
      assert.equal(f.layer.commands.pending, 1);
      f.config.accessKey = keyed ? 'replacement-original-key' : 'newly-required-original-key';
      files.release(); await rejected;
      const recovered = await f.owner.command('openClawMessageSendReceiptRead', scope);
      assert.ok('receipt' in recovered && recovered.receipt?.state === 'outcome_unknown');
      assert.ok('queue' in recovered && recovered.queue.presence === 'unknown');
      assert.ok('intent' in recovered && recovered.intent === null && recovered.admitted === false);
      assert.deepEqual(await f.owner.command('turnSessionPage', { runtime: 'openclaw', after: '', limit: 64 }), [],
        'unknown receipt is not queue absence evidence; independently inspect the original queue');
      assert.equal(f.layer.commands.pending, 0); assert.equal(f.calls.native, 0);
      assert.deepEqual(await f.owner.command('openClawMessageSendReceiptRead', scope), recovered);
    } finally { files.release(); }
  });
}

for (const format of ['json', 'sqlite'] as const) test(`standalone ${format}: timed-out original agents retain Auth until physical drain`, async t => {
  const entered = gate(), physical = gate();
  const f = await fixture(t, format, true, options => {
    options.waitMs = 500;
    const bind = options.bind!;
    options.bind = async context => ({ ...await bind(context), agents: async () => {
      entered.release(); await physical.promise; return [{ id: 'main' }];
    } });
  });
  await f.layer.start();
  const pending = f.request('/api/agents', { headers: f.headers }); await entered.promise;
  let closing: Promise<void> | undefined, closed = false;
  try {
    assert.equal((await pending).status, 503);
    closing = f.layer.close(); void closing.then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.calls.bindingClose, 0);
    assert.throws(() => startupDatabaseOwners.reserveExclusive(format === 'sqlite' ? f.config.authSqliteFile! : f.config.authSessionsFile));
    assert.equal(f.layer.connector.events.status().closing, false);
  } finally { physical.release(); await closing; }
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.calls.native, 0);
});

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`real standalone parent ${format}/${keyed}: original files, Auth, legacy read/PATCH, Connector authority`, async t => {
    const f = await fixture(t, format, keyed);
    assert.equal(f.layer.ready, false); assert.equal(f.calls.discovery, 0);
    assert.equal((await f.request('/api/auth/status')).status, 503);
    await f.layer.start(); assert.equal(f.layer.ready, true);
    f.files.forEach((file, i) => {
      assert.equal(readFileSync(file, 'utf8'), f.before[i]!.bytes); assert.equal(statSync(file).mtimeMs, f.before[i]!.mtime);
    });
    assert.equal((await f.request(base, { headers: f.headers })).status, 200);
    const status = await f.request('/api/auth/status', { headers: f.headers });
    assert.equal((await status.json()).authenticated, true);
    assert.equal((await f.request('/api/connector/v1/identity', { headers: { authorization: `Bearer ${bearer}` } })).status, 200);
    assert.equal((await f.request('/api/connector/v1/identity', { headers: f.headers })).status, 401);
    if (keyed) {
      assert.equal((await f.request(base, { headers: { authorization: `Bearer ${bearer}` } })).status, 401);
      assert.equal((await f.request(base)).status, 401);
    }
    let cookie: string | undefined;
    if (keyed) {
      const login = await f.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: secret }) });
      assert.equal(login.status, 200); cookie = login.headers.getSetCookie().find(v => v.startsWith('agentopsdeck_session='))?.split(';')[0];
      assert.ok(cookie);
    }
    for (const [route, field, file] of [['visibility', 'hidden', f.files[0]], ['archive', 'archived', f.files[1]], ['pin', 'pinned', f.files[2]]] as const) {
      const response = await f.request(`${base}/${route}`, { method: 'PATCH',
        headers: cookie ? { cookie, 'x-agentopsdeck-key': 'wrong-explicit-key' } : f.headers, body: JSON.stringify({ [field]: false }) });
      assert.equal(response.status, 200); assert.equal((await response.json())[field], false);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['existing']);
    }
    assert.equal(f.layer.deck.isSessionHidden(key), false); assert.equal(f.layer.deck.isSessionArchived(key), false);
    assert.equal(f.layer.deck.isSessionPinned(key), false);
    assert.equal((await f.request(base + '/messages', { method: 'POST', headers: f.headers, body: '{}' })).status, 404);
    assert.equal(f.calls.native, 0);
    if (cookie) {
      assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers: { cookie } })).status, 200);
      assert.equal((await f.request(base, { headers: { cookie } })).status, 401);
    }
    await f.layer.close(); assert.equal(f.layer.ready, false);
    assert.equal((await f.request('/api/auth/status')).status, 503);
    assert.ok((await f.owner.command('tokensList', {})).length > 0, 'parent must not close borrowed Connector DB');
    const reopened = new DeckStore({ hiddenSessionsFile: f.files[0], archivedSessionsFile: f.files[1], pinnedSessionsFile: f.files[2] });
    assert.equal(reopened.isSessionPinned(key), false); assert.equal(reopened.isSessionPinned('existing'), true);
    assert.doesNotMatch(f.logs.join('\n'), new RegExp(`${secret}|${bearer}|${key}|${f.root}`));
  });
}

for (const format of ['json', 'sqlite'] as const) for (const [route, field] of [
  ['visibility', 'hidden'], ['archive', 'archived'], ['pin', 'pinned'],
] as const) test(`committed ${format}/${field} ACK projects even when parent close reenters before projection`, async t => {
  const f = await fixture(t, format); await f.layer.start();
  const project = f.layer.deck.projectLocalPreference.bind(f.layer.deck);
  let closing: Promise<void> | undefined, projected = 0;
  f.layer.deck.projectLocalPreference = result => {
    // Exact durable ACK boundary; do not substitute an async projector or
    // authorise another request from this already committed fact.
    closing = f.layer.close();
    assert.equal(f.layer.ready, false);
    assert.equal(f.calls.bindingClose, 0);
    assert.equal(f.layer.connector.events.status().closing, false);
    project(result); projected++;
  };
  const response = await f.request(`${base}/${route}`, { method: 'PATCH', headers: f.headers,
    body: JSON.stringify({ [field]: false }) });
  assert.equal(response.status, 200); assert.equal(projected, 1); assert.ok(closing);
  await closing;
  assert.equal(f.calls.bindingClose, 1); assert.equal(f.layer.connector.events.status().closing, true);
  const index = field === 'hidden' ? 0 : field === 'archived' ? 1 : 2;
  assert.deepEqual(JSON.parse(readFileSync(f.files[index], 'utf8')), ['existing']);
  const reopened = new DeckStore({ hiddenSessionsFile: f.files[0], archivedSessionsFile: f.files[1], pinnedSessionsFile: f.files[2] });
  assert.equal(field === 'hidden' ? reopened.isSessionHidden(key) : field === 'archived'
    ? reopened.isSessionArchived(key) : reopened.isSessionPinned(key), false);
  assert.equal((await f.request(base, { headers: f.headers })).status, 503);
  assert.ok((await f.owner.command('tokensList', {})).length > 0);
});

test('parent close retains projection and reservation through held PATCH body, with no post-freeze submission', async t => {
  const f = await fixture(t); await f.layer.start();
  const body = gate(); let reading = false;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    reading = true; await body.promise; controller.enqueue(new TextEncoder().encode('{"pinned":false}')); controller.close();
  } }, { highWaterMark: 0 });
  const response = f.request(base + '/pin', { method: 'PATCH', headers: f.headers, body: stream, duplex: 'half' } as RequestInit);
  await until(() => reading);
  // Let the body pass request admission before freeze.
  await tick(); await tick();
  let closed = false; const close = f.layer.close().then(() => { closed = true; });
  assert.equal((await f.request(base, { headers: f.headers })).status, 503);
  assert.throws(() => startupDatabaseOwners.reserveExclusive(f.config.pinnedSessionsFile));
  await tick(); assert.equal(closed, false); body.release();
  assert.equal((await response).status, 503); await close;
  assert.equal(f.layer.deck.isSessionPinned(key), true);
  assert.equal(readFileSync(f.files[2], 'utf8'), f.before[2]!.bytes);
  const release = startupDatabaseOwners.reserveExclusive(f.config.pinnedSessionsFile); release();
  assert.equal(f.calls.bindingClose, 1);
});

test('parent close during native discovery cannot publish ready or replace the borrowed owner', async t => {
  const f = await fixture(t), discovery = gate();
  f.hooks.discovery = () => discovery.promise;
  const start = f.layer.start(); const rejected = assert.rejects(start);
  await until(() => f.calls.discovery > 0);
  const close = f.layer.close(); assert.equal(f.layer.ready, false);
  discovery.release(); await rejected; await close;
  await assert.rejects(f.layer.start()); assert.equal(f.calls.native, 0);
  assert.ok((await f.owner.command('tokensList', {})).length > 0);
});

test('discovery failure drains original Auth and never exposes partial readiness', async t => {
  const f = await fixture(t); f.hooks.discovery = async () => { throw Error('sensitive-native-error'); };
  await assert.rejects(f.layer.start()); assert.equal(f.layer.ready, false);
  assert.equal((await f.request(base)).status, 503);
  const release = startupDatabaseOwners.reserveExclusive(f.config.pinnedSessionsFile); release();
  assert.doesNotMatch(f.logs.join('\n'), /sensitive-native-error/);
});

test('corrupt initial preference file refuses parent construction and releases only its own reservations', async t => {
  let file = '';
  await assert.rejects(fixture(t, 'sqlite', true, (_options, root) => {
    file = join(root, 'hidden.json'); writeFileSync(file, '{corrupt');
  }));
  assert.equal(readFileSync(file, 'utf8'), '{corrupt');
  const release = startupDatabaseOwners.reserveExclusive(file); release();
});

for (const enabled of [false, true]) test(`sole worker snapshot explicit opt-in=${enabled} and stable fixed-file ownership`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'worker-snapshot-'));
  const files = { hidden: join(root, 'hidden.json'), archived: join(root, 'archived.json'), pinned: join(root, 'pinned.json') };
  const config = { file: join(root, 'auth.sqlite'), legacyFiles: [], ...(enabled ? { legacyPreferences: files } : {}) };
  const owner = new AsyncSqliteAuthOwner(config, new PerformanceDiagnostics(() => {}));
  t.after(async () => { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); });
  await owner.open();
  if (!enabled) { await assert.rejects(owner.localPreferenceSnapshot()); return; }
  writeFileSync(files.hidden, '["original"]');
  assert.deepEqual(await owner.localPreferenceSnapshot(), { hidden: ['original'], archived: [], pinned: [] });
  files.hidden = join(root, 'changed-path');
  assert.deepEqual(await owner.localPreferenceSnapshot(), { hidden: ['original'], archived: [], pinned: [] });
  assert.throws(() => startupDatabaseOwners.reserveExclusive(join(root, 'hidden.json')));
});

test('external preference snapshot has no bootstrap events, copies values and rejects all six old sync writers', () => {
  const committedPreferences = { hidden: [key], archived: [key], pinned: [key] };
  const options: DeckStoreOptions = { committedPreferences }, deck = new DeckStore(options);
  committedPreferences.hidden.length = 0; delete options.committedPreferences;
  assert.equal(deck.isSessionHidden(key), true); assert.equal(deck.getEventsSince().length, 0);
  for (const method of ['hideSession', 'unhideSession', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'] as const) {
    assert.throws(() => deck[method](key));
  }
  assert.equal(deck.getEventsSince().length, 0); assert.equal(deck.isSessionPinned(key), true);
  for (const field of ['hiddenSessionsFile', 'archivedSessionsFile', 'pinnedSessionsFile']) {
    assert.throws(() => new DeckStore({ committedPreferences: { hidden: [], archived: [], pinned: [] }, [field]: '/must-not-read' }));
  }
});

test('snapshot schema and original file normalization are fixed, read-only and fail closed', t => {
  for (const bad of [null, {}, { hidden: [], archived: [] }, { hidden: ['x', 'x'], archived: [], pinned: [] },
    { hidden: [''], archived: [], pinned: [] }, { hidden: [], archived: [], pinned: [], path: '/arbitrary' }]) {
    assert.equal(validLocalPreferenceSnapshot(bad), false);
  }
  const root = mkdtempSync(join(tmpdir(), 'original-snapshot-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { hidden: join(root, 'hidden'), archived: join(root, 'archived'), pinned: join(root, 'pinned') };
  writeFileSync(files.hidden, '[" x ","x",null,""]'); writeFileSync(files.archived, '{" z ":false}');
  const preferences = new OriginalLocalPreferences(files);
  assert.deepEqual(preferences.snapshot(), { hidden: ['x'], archived: ['z'], pinned: [] });
  assert.equal(readFileSync(files.hidden, 'utf8'), '[" x ","x",null,""]');
  writeFileSync(files.hidden, '{broken'); assert.throws(() => preferences.snapshot());
  assert.equal(readFileSync(files.hidden, 'utf8'), '{broken');
  const oversized = JSON.stringify(['x'.repeat(2 * 1024 * 1024)]); writeFileSync(files.hidden, oversized);
  assert.throws(() => preferences.snapshot()); assert.equal(readFileSync(files.hidden, 'utf8'), oversized);
});
