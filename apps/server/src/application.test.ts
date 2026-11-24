import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createApplication } from './application.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { loadConfig, type ServerRole } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { HubLifecycleCommands } from './hub/lifecycle-commands.js';
import { HubExecutionIssuers } from './hub/execution-issuers.js';
import { AsyncHubNativeFiles } from './hub/async-native-files.js';
import { encodeHubSessionId } from './hub/session-id.js';
import { registerRequestDrain } from './lifecycle/request-drain.js';
import { createConnectorRuntime } from './connector/runtime.js';
import { randomUUID } from 'node:crypto';
import { HttpWeixinTransport, WEIXIN_ORIGIN } from './hub/weixin-transport.js';
import { PasskeyManager, PersistentDeckSessionSet } from './auth/passkeys.js';
import { keyIdentityHash } from './auth/security.js';
import { PerformanceDiagnostics, performanceDiagnostics } from './diagnostics/performance.js';

function configuration(role: ServerRole) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-roles-'));
  const config = loadConfig({ HOME: dir, AOD_SERVER_ROLE: role,
    AOD_HUB_DATABASE_FILE: join(dir, 'hub.sqlite'),
    AOD_HUB_VAULT_SECRET: 'test-role-vault',
    AOD_SESSION_TITLES_FILE: join(dir, 'titles.json'),
    AOD_PASSKEYS_FILE: join(dir, 'passkeys.json'),
    AOD_AUTH_SESSIONS_FILE: join(dir, 'auth.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(dir, 'connector.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(dir, 'tokens.json'),
  });
  return config;
}

for (const lane of ['authorization', 'auth-route'] as const) for (const outcome of ['resolve', 'reject'] as const)
  test(`application retains aborted ${lane} original until late ${outcome} before database close`, async t => {
    const config = configuration('hub'), application = createApplication(config);
    let release!: (value: any) => void, reject!: (error: unknown) => void;
    const original = new Promise<any>((yes, no) => { release = yes; reject = no; });
    let started = false, storageCloses = 0, closed = false;
    const work = () => { started = true; return original as never; };
    if (lane === 'authorization') {
      const command = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        if (kind === 'memberSnapshot') { started = true; return original.then(value => value ?? null); }
        return command.call(this, kind, input);
      });
    }
    else t.mock.method(PasskeyManager.prototype, 'status', work);
    const storageClose = HubStore.prototype.close;
    t.mock.method(HubStore.prototype, 'close', function(this: HubStore) {
      storageCloses++; return storageClose.call(this);
    });
    const controller = new AbortController();
    const response = application.app.request('/api/auth/status', { signal: controller.signal });
    let closing: Promise<void> | undefined;
    try {
      const deadline = AbortSignal.timeout(3000);
      while (!started) { deadline.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)); }
      controller.abort(); assert.equal((await response).status, 408);
      closing = application.close(); void closing.then(() => { closed = true; });
      assert.equal(application.close(), closing);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false); assert.equal(storageCloses, 0);
      assert.equal((await application.app.request('/api/auth/status')).status, 503);
    } finally {
      if (outcome === 'resolve') release(lane === 'authorization' ? undefined : { available: true, count: 0 });
      else reject(Error('PRIVATE late original failure'));
      await response; await (closing ?? application.close());
      rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true });
    }
    assert.equal(storageCloses, 1); assert.equal(closed, true);
  });

for (const [lane, kind, path, post] of [
  ['board', 'workspaceBoard', '/api/hub/v1/workspace/boards', false],
  ['notebook', 'personalNotebook', '/api/hub/v1/notebooks', false],
  ['layout', 'layoutGet', '/api/hub/v1/workspace/layouts/current', false],
  ['preferences', 'workspaceGet', '/api/hub/v1/workspace/preferences', false],
  ['completion', 'completionSummary', '/api/hub/v1/completions/summary', true],
] as const) for (const outcome of ['resolve', 'reject'] as const)
  test(`application drains aborted Hub ${lane} original before database close on late ${outcome}`, async t => {
    const config = configuration('hub'), application = createApplication(config);
    let release!: (value: unknown) => void, reject!: (error: unknown) => void;
    const original = new Promise<unknown>((yes, no) => { release = yes; reject = no; });
    let started = false, calls = 0, storageCloses = 0, closed = false;
    const command = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, next: never, input: never) {
      if (next === kind) { started = true; calls++; return original; }
      return command.call(this, next, input);
    });
    const storageClose = HubStore.prototype.close;
    t.mock.method(HubStore.prototype, 'close', function(this: HubStore) {
      storageCloses++; return storageClose.call(this);
    });
    const controller = new AbortController();
    const response = application.app.request(path, { signal: controller.signal,
      ...(post ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sessions":[]}' } : {}) });
    let closing: Promise<void> | undefined;
    try {
      const deadline = AbortSignal.timeout(3000);
      while (!started) { deadline.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)); }
      controller.abort(); const cancelled = await response;
      assert.equal(cancelled.status, 499);
      assert.equal((await cancelled.text()).includes('PRIVATE'), false);
      closing = application.close(); void closing.then(() => { closed = true; });
      assert.equal(application.close(), closing);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false); assert.equal(storageCloses, 0); assert.equal(calls, 1);
      assert.equal((await application.app.request(path)).status, 503);
    } finally {
      if (outcome === 'resolve') release([]);
      else reject(Error('PRIVATE late workspace read failure'));
      await response; await (closing ?? application.close());
      rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true });
    }
    assert.equal(storageCloses, 1); assert.equal(closed, true); assert.equal(calls, 1);
  });

for (const stalled of ['route', 'command'] as const) test(`pending original ${stalled} drain cannot suppress independent shutdown signals`, async t => {
  const config = configuration('hub');
  let release!: () => void, commands = 0, issuers = 0, storageCloses = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const boardClose = AsyncHubNativeFiles.prototype.close;
  const commandClose = HubLifecycleCommands.prototype.close;
  const issuerClose = HubExecutionIssuers.prototype.close;
  const storageClose = HubStore.prototype.close;
  t.mock.method(AsyncHubNativeFiles.prototype, 'close', async function(this: AsyncHubNativeFiles) {
    if (stalled === 'route') await gate;
    await boardClose.call(this);
  });
  t.mock.method(HubLifecycleCommands.prototype, 'close', async function(this: HubLifecycleCommands) {
    commands++;
    if (stalled === 'command') await gate;
    await commandClose.call(this);
  });
  t.mock.method(HubExecutionIssuers.prototype, 'close', async function(this: HubExecutionIssuers) {
    issuers++; await issuerClose.call(this);
  });
  t.mock.method(HubStore.prototype, 'close', function(this: HubStore) {
    storageCloses++; return storageClose.call(this);
  });
  const application = createApplication(config), closing = application.close();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(commands, 1); assert.equal(issuers, 1);
    assert.equal(storageCloses, 0, 'pending independent drain cannot authorize original DB close');
    const concurrent = application.close();
    assert.equal(concurrent, closing);
    assert.equal((await application.app.request('/api/auth/status')).status, 503);
    assert.equal(commands, 1); assert.equal(issuers, 1);
  } finally { release(); await closing; rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true }); }
  assert.equal(storageCloses, 1);
});

test('one failed original lane is logged while its independent peer remains pending', async t => {
  const config = configuration('hub'), original = Error('private-drain-error');
  const logs: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  let release!: () => void, commands = 0, storageCloses = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const boardClose = AsyncHubNativeFiles.prototype.close;
  const commandClose = HubLifecycleCommands.prototype.close;
  const storeClose = HubStore.prototype.close;
  let owner: HubStore | undefined;
  const method = HubStore.prototype.storageRecovery;
  t.mock.method(HubStore.prototype, 'storageRecovery', function(this: HubStore) { owner = this; return method.call(this); });
  t.mock.method(AsyncHubNativeFiles.prototype, 'close', async function(this: AsyncHubNativeFiles) { await gate; await boardClose.call(this); });
  t.mock.method(HubLifecycleCommands.prototype, 'close', async function(this: HubLifecycleCommands) {
    commands++; await commandClose.call(this); throw original;
  });
  t.mock.method(HubStore.prototype, 'close', function(this: HubStore) { storageCloses++; return storeClose.call(this); });
  const application = createApplication(config);
  // Capture the isolated DB owner via its authorized recovery observation.
  assert.equal((await application.app.request('/api/hub/v1/maintenance/storage/recovery')).status, 200);
  const closing = application.close(), rejected = assert.rejects(closing, error => error === original);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(commands, 1); assert.equal(storageCloses, 0);
    assert.ok(logs.some(row => row.operation === 'application-drain' && row.step === 8 && row.category === 'failed' && row.unknown === 1));
    assert.doesNotMatch(JSON.stringify(logs), /private-drain-error/);
    assert.equal(application.close(), closing);
  } finally {
    release(); await rejected;
    await assert.rejects(application.close(), error => error === original);
    assert.equal(commands, 1); assert.equal(storageCloses, 0);
    // Fixture-only: all original work has quiesced. Close its exact captured
    // idle owner for test hygiene, never replay the failed application drain.
    assert.ok(owner); await storeClose.call(owner);
    rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true });
  }
});

test('original synchronous admission-stop failure is retained, never replayed as quiescence', async () => {
  const config = configuration('connector'), original = Error('private-drain-failure');
  let stops = 0, closes = 0;
  const application = createApplication(config, () => ({ app: new Hono(),
    stopAdmissions: () => { stops++; throw original; },
    localToken: 'synthetic-local-token', localMaintenanceToken: 'synthetic-maintenance-token',
    mediaLibrary: { isSignedStreamRequest: () => false }, registerLegacyRoutes: () => {},
    close: async () => { closes++; },
  }) as any);
  try {
    await assert.rejects(application.close(), error => error === original);
    await assert.rejects(application.close(), error => error === original);
    assert.equal(stops, 1); assert.equal(closes, 0);
    assert.equal((await application.app.request('/api/auth/status')).status, 503);
  } finally { rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true }); }
});

for (const kind of ['nonvoid', 'thenable', 'native-nonvoid', 'native-void'] as const) {
  test(`application original ${kind} drain requires native void ACK without reading accessors`, async t => {
    const config = configuration('connector'), logs: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
    let stops = 0, closes = 0;
    const result = kind === 'nonvoid' ? 1 : kind === 'thenable'
      ? { get then() { return assert.fail('must not read thenable'); } }
      : Promise.resolve(kind === 'native-void' ? undefined : 1);
    if (kind.startsWith('native')) {
      for (const key of ['then', 'finally']) Object.defineProperty(result, key, {
        get() { assert.fail('must not read promise accessor'); },
      });
    }
    const application = createApplication(config, () => ({ app: new Hono(),
      stopAdmissions: () => { stops++; return result; },
      localToken: 'synthetic-local-token', localMaintenanceToken: 'synthetic-maintenance-token',
      mediaLibrary: { isSignedStreamRequest: () => false }, registerLegacyRoutes: () => {},
      close: async () => { closes++; },
    }) as any);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (kind === 'native-void') await application.close();
        else await assert.rejects(application.close(), /Invalid application drain acknowledgement/);
      }
      assert.equal(stops, 1); assert.equal(closes, kind === 'native-void' ? 1 : 0);
      assert.ok(logs.some(row => row.operation === 'application-drain' && row.step === 2
        && row.category === (kind === 'native-void' ? 'routine' : 'failed')));
    } finally { rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true }); }
  });
}

test('WeChat personal Key routes isolate owners and preserve revocation after async QR', async t => {
  const config = configuration('hub'), directory = dirname(config.sessionTitlesFile);
  config.accessKey = 'synthetic-bootstrap';
  const setup = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  const user = setup.createUser('WeChat fixture'), other = setup.createUser('Other fixture');
  const key = setup.identities.issueKey(user.id), otherKey = setup.identities.issueKey(other.id);
  let qrCalls = 0, qrResolve: ((value: { code: string; url: string }) => void) | undefined;
  t.mock.method(HttpWeixinTransport.prototype, 'qr', async () => {
    qrCalls++;
    if (qrCalls === 2) return new Promise(resolve => { qrResolve = resolve; });
    return { code: 'synthetic-qr', url: 'https://weixin.qq.com/synthetic' };
  });
  t.mock.method(HttpWeixinTransport.prototype, 'pollQr', async () => ({ state: 'confirmed', account: {
    botId: 'synthetic-bot', peerId: 'synthetic-peer', token: 'synthetic-provider-secret', baseUrl: WEIXIN_ORIGIN,
  } }));
  const sent: string[] = [];
  t.mock.method(HttpWeixinTransport.prototype, 'receive', async () => ({ cursor: '', messages: [{
    id: 'synthetic-message', peerId: 'synthetic-peer', at: Date.now(), text: 'sessions', context: 'synthetic-context',
  }] }));
  t.mock.method(HttpWeixinTransport.prototype, 'send', async (_account: unknown, _context: string, text: string) => { sent.push(text); return 'accepted'; });
  const application = createApplication(config), base = '/api/hub/v1/weixin';
  const request = (path = '', method = 'GET', value?: unknown, credential = key.token) => application.app.request(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  try {
    assert.equal((await application.app.request(base, { headers: { 'x-weixin-user': user.id, 'x-internal-user': user.id } })).status, 401);
    const id = randomUUID();
    assert.equal((await request('/bindings', 'POST', { id }, 'invalid-key')).status, 401);
    assert.equal((await request('/bindings', 'POST', { id, extra: true })).status, 400);
    const created = await request('/bindings', 'POST', { id });
    assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal((await created.json()).binding.state, 'qr');
    assert.equal((await request('/bindings', 'POST', { id })).status, 200); assert.equal(qrCalls, 1);
    assert.equal((await (await request('', 'GET', undefined, otherKey.token)).json()).binding, null);
    assert.equal((await request(`/bindings/${id}/poll`, 'POST', {}, otherKey.token)).status, 410);
    await request(`/bindings/${id}`, 'DELETE', undefined, otherKey.token);
    const bound = await (await request(`/bindings/${id}/poll`, 'POST', {})).json();
    assert.equal(bound.status.binding.state, 'bound');
    assert.doesNotMatch(JSON.stringify(bound), /synthetic-provider-secret|synthetic-peer|synthetic-bot/);
    const deadline = Date.now() + 7000;
    while (!sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(sent, ['没有可访问的会话。'], 'worker crosses real application auth and owner-scoped Hub routes');
    await request(`/bindings/${id}`, 'DELETE');
    const next = request('/bindings', 'POST', { id: randomUUID() });
    while (!qrResolve) await new Promise(resolve => setImmediate(resolve));
    setup.identities.revokeKey(user.id, key.id);
    qrResolve({ code: 'late', url: 'https://weixin.qq.com/late' });
    assert.equal((await next).status, 403, 'admitted binding loses authority after original QR returns');
    assert.equal(setup.weixin.get(user.id), undefined);
    assert.equal((await request()).status, 401);
  } finally { await application.close(); setup.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('WeChat administrator Key and Key-login cookies bind, survive restart, and expire on Key rotation', async t => {
  const config = configuration('hub'), directory = dirname(config.sessionTitlesFile);
  config.accessKey = 'synthetic-weixin-administrator';
  let qrCalls = 0;
  t.mock.method(HttpWeixinTransport.prototype, 'qr', async () => {
    qrCalls++; return { code: 'synthetic-qr', url: 'https://weixin.qq.com/synthetic' };
  });
  t.mock.method(HttpWeixinTransport.prototype, 'pollQr', async () => ({ state: 'confirmed', account: {
    botId: 'synthetic-admin-bot', peerId: 'synthetic-admin-peer', token: 'synthetic-provider-secret', baseUrl: WEIXIN_ORIGIN,
  } }));
  const sent: string[] = [];
  t.mock.method(HttpWeixinTransport.prototype, 'receive', async () => ({ cursor: '', messages: [{
    id: 'synthetic-admin-message', peerId: 'synthetic-admin-peer', at: Date.now(), text: 'sessions', context: 'synthetic-context',
  }] }));
  t.mock.method(HttpWeixinTransport.prototype, 'send', async (_account: unknown, _context: string, text: string) => { sent.push(text); return 'accepted'; });
  let application = createApplication(config);
  const request = (headers: Record<string, string>, path = '', method = 'GET', body?: unknown) => application.app.request(`/api/hub/v1/weixin${path}`, {
    method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bearer = { authorization: `Bearer ${config.accessKey}` };
  try {
    const initial = await (await request(bearer)).json();
    assert.equal(initial.personalKey, false); assert.equal(initial.administratorKey, true); assert.equal(initial.binding, null);
    const login = await application.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: config.accessKey }) });
    assert.equal(login.status, 200);
    const cookie = { cookie: login.headers.get('set-cookie')!.split(';')[0]! }, id = randomUUID();
    const created = await request(cookie, '/bindings', 'POST', { id });
    assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store');
    const value = await created.json(); assert.equal(value.personalKey, false); assert.equal(value.administratorKey, true);
    assert.equal(value.binding.state, 'qr'); assert.equal(qrCalls, 1);
    assert.equal((await request(bearer, '/bindings', 'POST', { id })).status, 200); assert.equal(qrCalls, 1);
    const bound = await (await request(cookie, `/bindings/${id}/poll`, 'POST', {})).json();
    assert.equal(bound.status.binding.state, 'bound'); assert.equal(bound.status.personalKey, false);
    assert.doesNotMatch(JSON.stringify(bound), /synthetic-provider-secret|synthetic-admin-peer|synthetic-admin-bot|weixin-admin:|synthetic-weixin-administrator/);
    const deadline = Date.now() + 7000;
    while (!sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(sent, ['没有可访问的会话。'], 'administrator worker crosses real application auth and scoped Hub routes');
    await application.close(); application = createApplication(config);
    assert.equal((await (await request(cookie)).json()).binding.id, id);
    // A personal member of default is not the shared bootstrap administrator.
    const setup = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], config.accessKey);
    const member = setup.identities.issueKey('default');
    try {
      for (const [path, method, body] of [['', 'GET'], [`/bindings/${id}`, 'DELETE'], [`/bindings/${id}/poll`, 'POST', {}], ['/bindings', 'POST', { id }]] as const) {
        assert.equal((await request({ authorization: `Bearer ${member.token}` }, path, method, body)).status, 403);
      }
      assert.equal(setup.identities.listKeys('default').length, 1, 'binding did not mint a hidden personal login Key');
    } finally { setup.close(); }
    await application.close(); config.accessKey = 'synthetic-rotated-administrator'; application = createApplication(config);
    assert.equal((await request(bearer)).status, 401);
    const rotated = { authorization: `Bearer ${config.accessKey}` };
    const after = await (await request(rotated)).json(); assert.equal(after.binding, null); assert.equal(after.administratorKey, true);
    assert.equal((await request(rotated, `/bindings/${id}/poll`, 'POST', {})).status, 410);
    const next = randomUUID(); assert.equal((await request(rotated, '/bindings', 'POST', { id: next })).status, 200);
    assert.equal(qrCalls, 2);
    assert.equal((await request(rotated, `/bindings/${id}`, 'DELETE')).status, 200);
    assert.equal((await (await request(rotated)).json()).binding.id, next, 'stale unlink cannot remove the new binding');
    assert.equal((await request(rotated, `/bindings/${next}`, 'DELETE')).status, 200);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('WeChat does not turn passkey-only or open-mode access into administrator Key binding', async t => {
  for (const configured of [true, false]) {
    const config = configuration('hub'), directory = dirname(config.sessionTitlesFile);
    config.accessKey = configured ? 'synthetic-key-only' : undefined;
    const sessions = new PersistentDeckSessionSet(config.authSessionsFile);
    const token = 'synthetic-passkey-session-token';
    sessions.add(token, { credentialHash: 'a'.repeat(24), ...(config.accessKey ? { keyIdentityHash: keyIdentityHash(config.accessKey) } : {}) });
    t.mock.method(PasskeyManager.prototype, 'isCredentialCurrent', () => true);
    let calls = 0; t.mock.method(HttpWeixinTransport.prototype, 'qr', async () => { calls++; throw Error('must not call'); });
    const application = createApplication(config);
    try {
      const headers = configured ? { cookie: `agentopsdeck_session=${token}` } : {};
      const response = await application.app.request('/api/hub/v1/weixin', { headers });
      assert.equal(response.status, 200);
      const status = await response.json(); assert.equal(status.personalKey, false); assert.equal(status.administratorKey, false);
      const create = await application.app.request('/api/hub/v1/weixin/bindings', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID() }) });
      assert.equal(create.status, 403); assert.equal(calls, 0);
    } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('Hub login failure evidence survives application close and recreation', async () => {
  const config = configuration('hub'), directory = dirname(config.sessionTitlesFile);
  config.accessKey = 'fixture-only-access-key';
  config.authRateLimit.maxFailures = 2;
  let application = createApplication(config);
  const attempt = () => application.app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'wrong' }),
  }, { incoming: { socket: { remoteAddress: '198.51.100.1' } } });
  try {
    assert.equal((await attempt()).status, 401);
    await application.close();
    application = createApplication(config);
    assert.equal((await attempt()).status, 429);
    await application.close();
    application = createApplication(config);
    const response = await attempt();
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
    assert.equal(response.headers.get('set-cookie'), null);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const trusted of [false, true]) test(`application transport source middleware protects login (trusted=${trusted})`, async () => {
  const config = configuration('hub'), directory = dirname(config.sessionTitlesFile);
  config.accessKey = 'fixture-only-access-key';
  config.authTrustedProxies = trusted ? ['127.0.0.1'] : [];
  config.authRateLimit.maxFailures = 2;
  const application = createApplication(config, () => { throw Error('No Connector expected'); });
  const environment = { incoming: { socket: { remoteAddress: '::ffff:127.0.0.1' } } };
  const attempt = (suffix: number, source = '198.51.100.1') => application.app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `different-${suffix}`,
      'x-forwarded-for': `203.0.113.${suffix}, ${source}` }, body: JSON.stringify({ accessKey: 'wrong' }),
  }, environment);
  try {
    assert.equal((await attempt(1)).status, 401);
    assert.equal((await attempt(2)).status, 429);
    assert.equal((await attempt(3)).status, 429);
    assert.equal((await attempt(4, '198.51.100.2')).status, trusted ? 401 : 429);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Hub website gateway is opt-in and shutdown fences visits before closing the store', async () => {
  for (const enabled of [false, true]) {
    const config = configuration('hub'), directory = dirname(config.sessionTitlesFile);
    if (enabled) config.websiteGateway = { originTemplate: 'https://{access}.preview.example.net',
      parentOrigin: 'https://hub.example.org', port: 9898 };
    const application = createApplication(config, () => { throw Error('Hub-only must not start a Connector'); });
    try {
      assert.equal(Boolean(application.websiteGateway), enabled);
      if (!application.websiteGateway) continue;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gateway = application.websiteGateway;
      const visit = await gateway.open({ key: 'synthetic', owner: 'synthetic', expiresAt: Date.now() + 20_000,
        signal: new AbortController().signal, authorize: () => {}, read: async (_path, signal) => {
          entered();
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
          throw Error('Cancelled read must not produce content');
        } });
      const read = gateway.fetch(new Request(visit.url));
      await started;
      await application.close();
      assert.notEqual((await read).status, 200);
      assert.equal((await gateway.fetch(new Request(visit.url))).status, 503);
    } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('all: Hub model catalog uses local daily read capability, never maintenance write privileges', async () => {
  const config = configuration('all'), directory = dirname(config.sessionTitlesFile);
  config.localOpenClawCli = false;
  config.codex.enabled = true;
  config.codex.modelProvider = 'synthetic-provider';
  config.codex.defaultModel = 'synthetic-model';
  config.codex.modelChoices = ['synthetic-choice'];
  config.connector.updateStateFile = join(directory, 'update.json');
  config.queueFile = join(directory, 'queue.json');
  config.mirrorOutboxFile = join(directory, 'mirror.json');
  config.artifactIndexFile = join(directory, 'artifacts.json');
  let runtime!: ReturnType<typeof createConnectorRuntime>;
  const application = createApplication(config, (...args) => runtime = createConnectorRuntime(...args));
  try {
    const response = await application.app.request(`/api/hub/v1/connections/${config.hub.defaultConnectionId}/models/codex`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).models.map((model: { id: string }) => model.id), ['synthetic-choice', 'synthetic-model']);
    const headers = { authorization: `Bearer ${runtime.localToken}` };
    assert.equal((await runtime.app.request('/api/connector/v1/gateway/model-set/reconcile', { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await runtime.app.request('/api/connector/v1/update/check', { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await runtime.app.request('/api/connector/v1/models/codex')).status, 403);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('all: local Connector maintenance does not fence independent Hub mutations', async () => {
  const config = configuration('all'), internal = new Hono();
  const stopAdmissions = registerRequestDrain(internal);
  internal.post('/api/connector/v1/synthetic', context => context.json({ written: true }));
  const application = createApplication(config, () => ({ app: internal, stopAdmissions,
    localToken: 'test-local-token', localMaintenanceToken: 'test-maintenance-token',
    mediaLibrary: { isSignedStreamRequest: () => false }, registerLegacyRoutes: () => {}, close: async () => {},
  }) as any);
  try {
    const pause = stopAdmissions.pauseWrites();
    await pause.drained;
    assert.equal((await application.app.request('/api/connector/v1/synthetic', { method: 'POST' })).status, 503);
    const response = await application.app.request('/api/hub/v1/connections', { method: 'POST',
      body: JSON.stringify({ id: 'independent', connectorUrl: 'http://127.0.0.1:9', enabled: false }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).connection.id, 'independent');
    assert.equal(pause.resume(), true);
    assert.equal((await application.app.request('/api/connector/v1/synthetic', { method: 'POST' })).status, 200);
  } finally { await application.close(); }
});

test('all: original runtime maintenance fences canonical and legacy writes without fencing independent Hub writes', async () => {
  const config = configuration('all'), directory = dirname(config.sessionTitlesFile);
  config.localOpenClawCli = false;
  config.codex.enabled = false;
  config.connector.updateStateFile = join(directory, 'update.json');
  config.queueFile = join(directory, 'queue.json');
  config.mirrorOutboxFile = join(directory, 'mirror.json');
  config.artifactIndexFile = join(directory, 'artifacts.json');
  let runtime!: ReturnType<typeof createConnectorRuntime>;
  const application = createApplication(config, (...args) => runtime = createConnectorRuntime(...args));
  const maintenance = (operation: string, body: unknown) => application.app.request(`/api/connector/v1/maintenance/commands/${operation}`,
    { method: 'POST', headers: { authorization: `Bearer ${runtime.localMaintenanceToken}` }, body: JSON.stringify(body) });
  try {
    const response = await maintenance('pause', { idempotencyKey: 'original' });
    assert.equal(response.status, 200);
    const paused = await response.json();
    assert.equal(paused.nativeQuiescent, false);
    for (const path of ['/api/connector/v1/sessions/synthetic/title', '/api/sessions/synthetic/title']) {
      const blocked = await application.app.request(path, { method: 'PATCH', body: JSON.stringify({ title: 'blocked' }) });
      assert.equal(blocked.status, 503);
      assert.equal((await blocked.json()).error, 'connector_maintenance');
    }
    const independent = await application.app.request('/api/hub/v1/connections', { method: 'POST',
      body: JSON.stringify({ id: 'independent', connectorUrl: 'http://127.0.0.1:9', enabled: false }) });
    assert.equal(independent.status, 201);
    assert.equal((await independent.json()).connection.id, 'independent');
    const resumed = await maintenance('resume', { idempotencyKey: 'resume', fenceId: paused.fenceId });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).state, 'released');
    const connection = await application.app.request('/api/hub/v1/connections');
    assert.equal(connection.status, 200);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const role of ['hub', 'all', 'connector'] as const) {
  test(`${role}: close stops API admission before auth and waits for already entered handlers`, async t => {
    const config = configuration(role);
    let finish!: () => void, entered!: () => void, closed = false, nativeClosed = 0;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const originalClose = HubStore.prototype.close;
    t.mock.method(HubStore.prototype, 'close', function(this: HubStore) { closed = true; originalClose.call(this); });
    const application = createApplication(config, () => ({ app: new Hono(), stopAdmissions: async () => {},
      localToken: 'test-local-token', localMaintenanceToken: 'test-maintenance-token',
      mediaLibrary: { isSignedStreamRequest: () => false }, registerLegacyRoutes: () => {},
      close: async () => { nativeClosed++; closed = true; },
    }) as any);
    // Use an existing auth handler to hold a real request across an await, not
    // a route registered after the production static wildcard.
    const originalImport = HubStore.prototype.listConnections;
    let lateAuthReads = 0;
    t.mock.method(HubStore.prototype, 'listConnections', function(this: HubStore, ...args: Parameters<HubStore['listConnections']>) {
      lateAuthReads++; return originalImport.apply(this, args);
    });
    const request = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({ async pull(controller) {
        entered(); await held;
        assert.equal(closed, false, 'database/runtime must remain open until handler exits');
        controller.enqueue(new TextEncoder().encode('{}')); controller.close();
      } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
    const pending = application.app.fetch(request);
    await started;
    let done = false;
    const shutdown = application.close().then(() => { done = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(done, false, 'close must wait for admitted request');
      assert.equal(closed, false);
      const reads = lateAuthReads;
      for (const endpoint of ['/api/auth/status', '/api/health', '/api/hub/v1/connections', '/api/connector/v1/info']) {
        const response = await application.app.request(endpoint);
        assert.equal(response.status, 503, endpoint);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
      }
      assert.equal(lateAuthReads, reads);
    } finally { finish(); await pending; await shutdown; }
    assert.equal(nativeClosed, role === 'hub' ? 0 : 1);
    assert.equal((await application.app.request('/api/auth/status')).status, 503);
    await application.close();
  });
}

test('shutdown drains lifecycle observations before closing the Hub database', async t => {
  const config = configuration('hub');
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = HubLifecycleCommands.prototype.close;
  t.mock.method(HubLifecycleCommands.prototype, 'close', async function(this: HubLifecycleCommands) {
    entered();
    await held;
    await original.call(this);
  });
  const databaseClose = t.mock.method(HubStore.prototype, 'close');
  const application = createApplication(config);
  let finished = false;
  const closing = application.close().then(() => { finished = true; });
  try {
    await started;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(databaseClose.mock.callCount(), 0, 'pending lifecycle work must retain its receipt database');
    assert.equal((await application.app.request('/api/health')).status, 503);
  } finally { release(); await closing; }
  assert.equal(databaseClose.mock.callCount(), 1);
  await application.close();
  assert.equal(databaseClose.mock.callCount(), 1, 'shutdown is idempotent');
});

test('all closes its Hub store when Connector ownership or assembly fails', async t => {
  const config = configuration('all');
  const close = t.mock.method(HubStore.prototype, 'close');
  const failure = new Error('synthetic Connector owner conflict');
  assert.throws(() => createApplication(config, () => { throw failure; }), error => error === failure);
  // Failed construction now waits for owned command/issuer drain ACK before
  // closing its dependent database. Keep this mock alive until cleanup settles.
  await startupApplicationCleanup.waitForCurrentCleanup();
  assert.equal(close.mock.callCount(), 1);
  rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true });
});

for (const afterEffect of [false, true]) test(`application shutdown retries retained Hub close after lost ${afterEffect ? 'ACK' : 'effect'} without replaying drained lifecycle`, async t => {
  const config = configuration('hub');
  const originalClose = HubStore.prototype.close, originalDrain = HubLifecycleCommands.prototype.close;
  const originalStop = HubLifecycleCommands.prototype.stopAndDrain;
  const original = Error('synthetic-private-hub-close'); let closes = 0, drains = 0, stops = 0;
  t.mock.method(HubLifecycleCommands.prototype, 'close', async function(this: HubLifecycleCommands) {
    drains++; await originalDrain.call(this);
  });
  t.mock.method(HubLifecycleCommands.prototype, 'stopAndDrain', function(this: HubLifecycleCommands) {
    stops++; return originalStop.call(this);
  });
  t.mock.method(HubStore.prototype, 'close', function(this: HubStore) {
    closes++;
    if (closes === 1) { if (afterEffect) originalClose.call(this); throw original; }
    return originalClose.call(this);
  });
  const application = createApplication(config);
  try {
    await assert.rejects(application.close(), error => error === original);
    assert.equal((await application.app.request('/api/auth/status')).status, 503);
    const drained = drains;
    await Promise.all([application.close(), application.close()]);
    assert.equal(closes, 2);
    // The original connection checks its retained stop-and-drain lanes once;
    // neither application drain nor database close retry replays child close.
    assert.equal(drains, drained); assert.equal(stops, 2);
    await application.close(); assert.equal(closes, 2);
  } finally { await application.close(); rmSync(dirname(config.hub.databaseFile), { recursive: true, force: true }); }
});

test('hub without a local URL constructs no Connector or synthetic local connection', async () => {
  const config = configuration('hub');
  const application = createApplication(config, () => { throw new Error('Connector must not be constructed'); });
  try {
    assert.equal((await application.app.request('/api/health')).status, 200);
    const preflight = await application.app.request('/api/hub/v1/sessions/synthetic/queue/queued', {
      method: 'OPTIONS', headers: { origin: 'http://localhost', 'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type,if-match,x-agentopsdeck-recovery-scope' },
    });
    assert.equal(preflight.status, 204);
    assert.ok(preflight.headers.get('access-control-allow-headers')?.split(',').includes('if-match'));
    const historyPreflight = await application.app.request('/api/hub/v1/sessions/synthetic/messages', {
      method: 'OPTIONS', headers: { origin: 'http://localhost', 'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type,if-none-match,x-agentopsdeck-history-delta,x-agentopsdeck-recovery-scope' },
    });
    assert.equal(historyPreflight.status, 204);
    assert.ok(historyPreflight.headers.get('access-control-allow-headers')?.split(',').includes('if-none-match'));
    assert.ok(historyPreflight.headers.get('access-control-allow-headers')?.split(',').includes('x-agentopsdeck-history-delta'));
    assert.ok(historyPreflight.headers.get('access-control-allow-headers')?.split(',').includes('x-agentopsdeck-history-async'));
    assert.ok(historyPreflight.headers.get('access-control-allow-headers')?.split(',').includes('x-agentopsdeck-notebook-format'));
    const exposed = await application.app.request('/api/health', { headers: { origin: 'http://localhost' } });
    assert.ok(exposed.headers.get('access-control-expose-headers')?.split(',').includes('etag'));
    assert.ok(exposed.headers.get('access-control-expose-headers')?.split(',').includes('x-agentopsdeck-history-meta'));
    assert.ok(exposed.headers.get('access-control-expose-headers')?.split(',').includes('x-agentopsdeck-history-delta'));
    const connections = await (await application.app.request('/api/hub/v1/connections')).json() as any;
    assert.deepEqual(connections.connections, []);
    for (const route of ['/api/connector/v1/info', '/api/sessions/state', '/api/config']) {
      assert.equal((await application.app.request(route)).status, 404, route);
    }
    assert.equal(existsSync(config.connector.usersDatabaseFile), false);
    assert.equal(existsSync(config.connector.tokenFile), false);
  } finally { await application.close(); await application.close(); }
});

for (const role of ['all', 'connector'] as const) {
  test(`${role} constructs one Connector and closes it once`, async () => {
    const config = configuration(role);
    let constructed = 0;
    let closed = 0;
    let forwarded = 0;
    const application = createApplication(config, () => {
      constructed++;
      const app = new Hono();
      const stopAdmissions = registerRequestDrain(app);
      app.get('/api/connector/v1/info', (c) => c.json({ service: 'test-connector' }));
      app.get('/api/connector/v1/sessions/state', (c) => {
        assert.equal(c.req.header('authorization'), 'Bearer test-local-token');
        forwarded++;
        return c.json({ groups: [] });
      });
      return { app, stopAdmissions, localToken: 'test-local-token', localMaintenanceToken: 'test-maintenance-token',
        mediaLibrary: { isSignedStreamRequest: () => false },
        registerLegacyRoutes: (target: Hono) => target.get('/api/health', (c) => c.json({ ok: true })),
        close: async () => { closed++; },
      } as any;
    });
    try {
      assert.equal(constructed, 1);
      assert.equal((await application.app.request('/api/connector/v1/info')).status, 200);
      assert.equal((await application.app.request('/api/health')).status, 200);
      assert.equal((await application.app.request('/api/hub/v1/sessions/state')).status, role === 'all' ? 200 : 404);
      assert.equal(forwarded, role === 'all' ? 1 : 0);
      assert.equal(existsSync(config.hub.databaseFile), role === 'all');
    } finally { await Promise.all([application.close(), application.close()]); }
    assert.equal(closed, 1);
  });
}

test('hub restart preserves a disabled split node', async () => {
  const config = configuration('hub');
  config.hub.localConnectorUrl = 'https://test-connector.invalid';
  const store = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  store.upsertConnection({ id: config.hub.defaultConnectionId, label: 'Disabled', kind: 'remote',
    connectorUrl: config.hub.localConnectorUrl, status: 'disabled', capabilities: [] });
  store.close();
  const application = createApplication(config, () => { throw new Error('No local runtime'); });
  try {
    const body = await (await application.app.request('/api/hub/v1/connections')).json() as any;
    assert.equal(body.connections[0].status, 'disabled');
  } finally { await application.close(); }
});

for (const transport of ['local', 'http'] as const) {
  for (const credential of ['key', 'cookie', 'admin'] as const) {
    test(`${transport}/${credential}: session mutations cannot escape into legacy handlers`, async () => {
      const config = configuration('all');
      config.accessKey = 'synthetic-admin-key';
      const setup = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
      const member = setup.createUser('Member');
      const key = setup.identities.issueKey(member.id);
      const cookie = setup.identities.createSession(key.token)!;
      setup.upsertConnection({ id: 'owned', ownerUserId: member.id, label: 'Owned', kind: 'remote',
        connectorUrl: 'http://unused.invalid', capabilities: [] });
      setup.close();
      let legacyMutations = 0;
      const application = createApplication(config, () => ({
        app: new Hono(), stopAdmissions: async () => {}, localToken: 'test-local-token', localMaintenanceToken: 'test-maintenance-token',
        mediaLibrary: { isSignedStreamRequest: () => false },
        registerLegacyRoutes: (target: Hono) => {
          for (const suffix of ['', '/visibility', '/archive', '/pin']) {
            target.on(['PATCH', 'DELETE'], `/api/sessions/:sessionKey${suffix}`, (c) => {
              legacyMutations++;
              return c.json({ legacy: true });
            });
          }
        }, close: async () => {},
      }) as any);
      const server = transport === 'http' ? serve({ fetch: application.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
      if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server?.address();
      const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://localhost';
      const headers = credential === 'cookie' ? { cookie: `agentopsdeck_session=${cookie}` }
        : { authorization: `Bearer ${credential === 'admin' ? config.accessKey : key.token}` };
      const request = (path: string, method = 'PATCH') => {
        const req = new Request(`${origin}${path}`, { method, headers });
        return server ? fetch(req) : application.app.fetch(req);
      };
      try {
        const canonical = encodeHubSessionId('owned', 'agent:main:synthetic');
        // Read-only aggregate endpoints remain accessible; they are not session IDs.
        assert.equal((await request('/api/hub/v1/sessions/state', 'GET')).status, 200);
        if (credential !== 'admin') {
          for (const suffix of ['visibility', 'archive', 'pin']) {
            for (const id of [canonical, encodeURIComponent(canonical)]) {
              const response = await request(`/api/sessions/${id}/${suffix}`);
              assert.equal(response.status, 200);
              assert.equal((await response.json() as any).sessionKey, canonical);
            }
          }
          for (const method of ['PATCH', 'DELETE']) {
            for (const connection of ['missing', config.hub.defaultConnectionId]) {
              const id = encodeURIComponent(encodeHubSessionId(connection, 'agent:main:synthetic'));
              assert.equal((await request(`/api/sessions/${id}`, method)).status, 404);
            }
          }
        }
        const invalid = ['state', '%73tate', 'agent%3Amain%3Asynthetic', 'plain', 'broken%ZZ',
          encodeURIComponent(`${canonical}=`), encodeURIComponent(encodeURIComponent(canonical)), 'raw%2Fkey'];
        for (const id of invalid) {
          for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['PATCH', '/visibility'],
            ['PATCH', '/archive'], ['PATCH', '/pin']]) {
            const before = legacyMutations;
            const response = await request(`/api/sessions/${id}${suffix}`, method);
            await response.arrayBuffer();
            if (credential === 'admin' && id !== 'broken%ZZ') {
              assert.equal(response.status, 200, `${method} ${id}${suffix}: admin compatibility`);
              assert.equal(legacyMutations, before + 1);
            } else {
              assert.ok([400, 403, 404].includes(response.status), `${method} ${id}${suffix}: ${response.status}`);
              assert.equal(legacyMutations, before, `${method} ${id}${suffix}: legacy side effect`);
            }
          }
        }
        if (credential !== 'admin') assert.equal(legacyMutations, 0);
      } finally {
        if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await application.close();
      }
      const stored = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
      try {
        assert.equal(stored.sessionPreferences('default').size, 0);
        if (credential !== 'admin') assert.deepEqual(stored.sessionPreferences(member.id).get(encodeHubSessionId('owned', 'agent:main:synthetic')),
          { hidden: true, archived: true, pinned: true });
      } finally { stored.close(); }
    });
  }
}

for (const role of ['all', 'connector'] as const) test(`${role}: direct Connector dispatch drains independently of public HTTP`, async () => {
  const config = configuration(role), internal = new Hono();
  const stopAdmissions = registerRequestDrain(internal);
  let finish!: () => void, entered!: () => void, closed = false;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  internal.post('/api/connector/v1/synthetic', async c => {
    entered(); await held; assert.equal(closed, false); return c.json({ done: true });
  });
  const application = createApplication(config, () => ({ app: internal, stopAdmissions,
    localToken: 'test-local-token', localMaintenanceToken: 'test-maintenance-token',
    mediaLibrary: { isSignedStreamRequest: () => false }, registerLegacyRoutes: () => {},
    close: async () => { closed = true; },
  }) as any);
  const pending = internal.request('/api/connector/v1/synthetic', { method: 'POST' });
  await started;
  const shutdown = application.close();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal((await internal.request('/api/connector/v1/synthetic', { method: 'POST' })).status, 503);
    assert.equal((await application.app.request('/api/connector/v1/synthetic', { method: 'POST' })).status, 503);
  } finally { finish(); assert.equal((await pending).status, 200); await shutdown; }
  assert.equal(closed, true);
});
