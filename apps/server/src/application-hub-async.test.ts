import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from './config.js';
import { createProcessApplication } from './application-process.js';
import { createAsyncHubApplication } from './application-hub-async.js';
import { HubStore } from './hub/hub-store.js';
import { AsyncHubMemberOwner } from './hub/async-member-owner.js';
import { WeixinService } from './hub/weixin-service.js';
import { PasskeyManager } from './auth/passkeys.js';
import { OriginalJsonAuthCommandStore } from './auth/original-json-command-store.js';
import { openSqliteAuth } from './auth/sqlite-store.js';
import { keyIdentityHash, credentialHashForAudit } from './auth/security.js';
import { writePrivateAuthStore } from './auth/private-store.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';

const admin = 'isolated-production-hub-key', vault = 'isolated-production-hub-vault';
const base = '/api/hub/v1';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}
function fixture(t: test.TestContext, mode: 'json' | 'sqlite', withKey = true) {
  const root = mkdtempSync(join(tmpdir(), 'hub-production-async-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub',
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: vault,
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    ...(withKey ? { AOD_ACCESS_KEY: admin } : {}),
    ...(mode === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}),
  });
  const applications: Awaited<ReturnType<typeof createAsyncHubApplication>>[] = [];
  t.mock.method(globalThis, 'fetch', async () => { throw Error('UNEXPECTED_EXTERNAL_EFFECT'); });
  t.mock.method(WeixinService.prototype, 'startWorker', () => {});
  t.after(async () => {
    for (const application of applications) await application.close();
    assert.equal(startupApplicationCleanup.snapshot().pending, 0);
    rmSync(root, { recursive: true, force: true });
  });
  const open = async () => {
    const application = await createProcessApplication(config); applications.push(application); return application;
  };
  const request = (application: Awaited<ReturnType<typeof createAsyncHubApplication>>, path: string,
    headers: HeadersInit = { 'x-agentopsdeck-key': admin }, init?: RequestInit) => application.app.request(path, { ...init, headers });
  return { root, config, open, request };
}

test('production Hub JSON: original bound Passkey authenticates without granting administrator WeChat binding', async t => {
  const f = fixture(t, 'json'), credentialId = Buffer.from('isolated-production-passkey').toString('base64url');
  writePrivateAuthStore(f.config.passkeysFile, { credentials: [{ id: credentialId,
    publicKey: Buffer.from('isolated-unused-cose').toString('base64url'), counter: 0, rpId: 'localhost',
    keyIdentityHash: keyIdentityHash(admin), label: 'isolated credential', createdAt: 1 }] });
  const store = new OriginalJsonAuthCommandStore(f.config.passkeysFile, f.config.authSessionsFile, keyIdentityHash(admin));
  const bound = 'p'.repeat(43), key = 'k'.repeat(43);
  store.sessions.add(bound, { credentialHash: credentialHashForAudit(credentialId), keyIdentityHash: keyIdentityHash(admin) });
  store.sessions.add(key);
  store.close();
  const application = await f.open(), headers = { cookie: `agentopsdeck_session=${bound}` };
  assert.equal((await (await f.request(application, '/api/auth/status', headers)).json()).authenticated, true);
  const status = await f.request(application, '/api/hub/v1/weixin', headers);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).administratorKey, false);
  const denied = await f.request(application, '/api/hub/v1/weixin/bindings', {
    ...headers, 'content-type': 'application/json',
  }, { method: 'POST', body: JSON.stringify({ id: randomUUID() }) });
  assert.equal(denied.status, 403);
  const keyStatus = await f.request(application, '/api/hub/v1/weixin', { cookie: `agentopsdeck_session=${key}` });
  assert.equal(keyStatus.status, 200); assert.equal((await keyStatus.json()).administratorKey, true);
});

for (const mode of ['json', 'sqlite'] as const) {
  test(`production Hub ${mode}: actual process root preserves original member Key/Cookie and Auth sessions across reopen`, async t => {
    const f = fixture(t, mode);
    const store = new HubStore(f.config.hub.databaseFile, vault);
    const member = store.createUser('Existing member'), memberKey = store.identities.issueKey(member.id);
    const memberToken = store.identities.createSession(memberKey.token)!;
    const hubId = store.identities.hubId;
    await store.close();
    const ready = AsyncHubMemberOwner.prototype.open, readyIds: string[] = [];
    t.mock.method(AsyncHubMemberOwner.prototype, 'open', async function(this: AsyncHubMemberOwner) {
      await ready.call(this); readyIds.push(this.metadata.hubId);
    });
    const adminToken = 'a'.repeat(43);
    if (mode === 'sqlite') {
      const original = openSqliteAuth(f.config.authSqliteFile!, [], () => keyIdentityHash(admin)); original.sessions.add(adminToken); await original.close();
    } else {
      const original = new OriginalJsonAuthCommandStore(f.config.passkeysFile, f.config.authSessionsFile, keyIdentityHash(admin));
      original.sessions.add(adminToken);
      original.close();
    }
    // Prototype changes apply only on this thread. Worker must be the sole
    // place constructing the original Auth/Hub and running their SQL/files.
    t.mock.method(HubStore.prototype, 'importLegacySessionPreferences', () => { throw Error('MAIN_THREAD_HUB_SQL'); });
    t.mock.method(PasskeyManager.prototype, 'status', () => { throw Error('MAIN_THREAD_AUTH_FILES'); });
    for (let run = 0; run < 2; run++) {
      const application = await f.open();
      for (const headers of [{ 'x-agentopsdeck-key': memberKey.token }, { cookie: `agentopsdeck_session=${memberToken}` }]) {
        const me = await f.request(application, base + '/me', headers);
        assert.equal(me.status, 200); const data = await me.json() as { userId: string };
        assert.equal(data.userId, member.id);
        const status = await f.request(application, '/api/auth/status', headers);
        assert.equal(status.status, 200); assert.equal((await status.json() as { authenticated: boolean }).authenticated, true);
      }
      const status = await f.request(application, '/api/auth/status', { cookie: `agentopsdeck_session=${adminToken}` });
      assert.equal(status.status, 200); assert.equal((await status.json() as { authenticated: boolean }).authenticated, true);
      assert.equal((await f.request(application, base + '/me', {
        cookie: `agentopsdeck_session=${memberToken}`, 'x-agentopsdeck-key': 'hub_key_invalid',
      })).status, 401, 'explicit invalid member Key cannot borrow valid Cookie');
      assert.equal((await f.request(application, base + '/me', {
        cookie: `agentopsdeck_session=${memberToken}`, 'x-agentopsdeck-key': 'unrelated-legacy-key',
      })).status, 200, 'unrelated Key namespace preserves the original member Cookie precedence');
      const info = await f.request(application, base + '/info'); assert.equal(info.status, 200);
      assert.equal((await info.json() as { mode: string }).mode, 'split-hub-http-connector');
      const layoutPath = base + '/workspace/layouts/current', memberHeaders = { 'x-agentopsdeck-key': memberKey.token };
      if (run === 0) {
        const content = JSON.stringify({ id: 'current', name: 'Current', workspace: {
          version: 2, panes: [], floating: [], dock: null, active: null }, collapsedKeys: [] });
        const saved = await f.request(application, layoutPath, memberHeaders, {
          method: 'PUT', body: JSON.stringify({ revision: 0, content }),
        });
        assert.equal(saved.status, 200); assert.equal((await saved.json() as { revision: number }).revision, 1);
        assert.equal((await f.request(application, layoutPath, memberHeaders, {
          method: 'PUT', body: JSON.stringify({ revision: 0, content }),
        })).status, 200, 'old frontend lost-response retry is idempotent');
        assert.equal((await f.request(application, layoutPath, memberHeaders, {
          method: 'PUT', body: JSON.stringify({ revision: 0, content: content.replace('"collapsedKeys":[]', '"collapsedKeys":["changed"]') }),
        })).status, 409, 'old frontend stale CAS with changed content remains a conflict');
      }
      const layout = await f.request(application, layoutPath, memberHeaders);
      assert.equal(layout.status, 200); assert.equal((await layout.json() as { revision: number }).revision, 1);
      const other = await f.request(application, layoutPath);
      assert.equal((await other.json() as { revision: number }).revision, 0, 'administrator cannot borrow member layout');
      if (run === 1) {
        const revoked = await f.request(application, `${base}/users/${member.id}/login-keys/${memberKey.id}`, undefined, { method: 'DELETE' });
        assert.equal(revoked.status, 200);
        for (const headers of [memberHeaders, { cookie: `agentopsdeck_session=${memberToken}` }]) {
          assert.equal((await f.request(application, base + '/me', headers)).status, 401);
        }
      }
      const closing = application.close(); assert.equal(application.close(), closing); await closing;
      assert.equal((await f.request(application, '/api/auth/status')).status, 503);
    }
    assert.deepEqual(readyIds, [hubId, hubId]);
  });

  test(`production Hub ${mode}: no-Key bootstrap, old-client wire and origin policy stay compatible`, async t => {
    const f = fixture(t, mode, false), application = await f.open();
    assert.equal((await f.request(application, base + '/me', {})).status, 200);
    const health = await f.request(application, '/api/health', {});
    assert.equal(health.status, 200); assert.equal((await health.json() as { connector: boolean }).connector, false);
    assert.equal((await application.app.request('/api.ts')).status, 204);
    const cors = await f.request(application, base + '/info', { origin: 'http://localhost', 'access-control-request-method': 'GET' }, { method: 'OPTIONS' });
    assert.equal(cors.headers.get('access-control-allow-origin'), 'http://localhost');
    const rejected = await f.request(application, base + '/connections/dev/update/apply', { origin: 'https://evil.invalid' }, { method: 'POST' });
    assert.equal(rejected.status, 403);
    for (const action of ['apply', 'rollback']) {
      const retired = await f.request(application, base + '/connections/dev/update/' + action, {}, { method: 'POST' });
      assert.equal(retired.status, 410); assert.equal(retired.headers.get('cache-control'), 'no-store');
    }
  });
}

test('production Hub ready initializes the configured remote connection without contacting Connector', async t => {
  const f = fixture(t, 'sqlite');
  f.config.hub.localConnectorUrl = 'https://connector.invalid';
  f.config.hub.localConnectorToken = 'isolated-original-connector-token';
  const application = await f.open();
  const response = await f.request(application, base + '/connections');
  assert.equal(response.status, 200);
  const body = await response.text(); assert.ok(body.includes('https://connector.invalid'));
  assert.equal(body.includes(f.config.hub.localConnectorToken), false);
  await application.close();
  const original = new HubStore(f.config.hub.databaseFile, vault);
  try { assert.equal(original.getConnection(f.config.hub.defaultConnectionId)?.connectorUrl, 'https://connector.invalid'); }
  finally { await original.close(); }
});

test('production Hub ready refuses existing member logins without the required administrator Key', async t => {
  const f = fixture(t, 'json', false), original = new HubStore(f.config.hub.databaseFile, vault);
  const member = original.createUser('Existing account'); original.identities.issueKey(member.id); await original.close();
  await assert.rejects(async () => createProcessApplication(f.config), /hub_member_storage_unavailable/);
  assert.equal(startupApplicationCleanup.snapshot().pending, 0);
});

test('production Hub root freezes admission and awaits an aborted original Auth observation before physical database close', async t => {
  const f = fixture(t, 'sqlite'), application = await f.open(), entered = deferred(), release = deferred();
  const original = AsyncHubMemberOwner.prototype.command, originalClose = AsyncHubMemberOwner.prototype.closeForShutdown;
  let hold = true, storageCloses = 0, settled = false;
  t.mock.method(AsyncHubMemberOwner.prototype, 'command', function(this: AsyncHubMemberOwner, kind: never, input: never) {
    const work = original.call(this, kind, input);
    return kind === 'memberSnapshot' && hold ? work.then(async value => { entered.resolve(); await release.promise; return value; }) as never : work;
  });
  t.mock.method(AsyncHubMemberOwner.prototype, 'closeForShutdown', function(this: AsyncHubMemberOwner) {
    storageCloses++; return originalClose.call(this);
  });
  const controller = new AbortController();
  const response = f.request(application, '/api/auth/status', { 'x-agentopsdeck-key': admin }, { signal: controller.signal });
  await entered.promise; controller.abort(); assert.equal((await response).status, 408);
  const close = application.close(); void close.then(() => { settled = true; });
  try {
    await new Promise<void>(ok => setImmediate(ok));
    assert.equal(settled, false); assert.equal(storageCloses, 0);
    assert.equal((await f.request(application, base + '/me')).status, 503);
  } finally { hold = false; release.resolve(); await close; }
  assert.equal(storageCloses, 1); assert.equal(application.close.snapshot().state, 'closed');
});

test('production Hub startup failure waits for original worker exit and does not fall back to a synchronous owner', async t => {
  const f = fixture(t, 'sqlite');
  writeFileSync(f.config.hiddenSessionsFile, '{invalid-startup-source');
  const original = AsyncHubMemberOwner.prototype.closeForShutdown;
  let exits = 0;
  t.mock.method(AsyncHubMemberOwner.prototype, 'closeForShutdown', async function(this: AsyncHubMemberOwner) {
    await original.call(this); assert.equal(this.snapshot().ownerExitConfirmed, true); exits++;
  });
  t.mock.method(HubStore.prototype, 'importLegacySessionPreferences', () => { throw Error('SYNC_FALLBACK_FORBIDDEN'); });
  await assert.rejects(async () => createProcessApplication(f.config), /hub_member_storage_unavailable/);
  assert.equal(exits, 1); assert.equal(startupApplicationCleanup.snapshot().pending, 0);
  writeFileSync(f.config.hiddenSessionsFile, '[]');
  const recovered = await f.open(); assert.equal((await f.request(recovered, base + '/me')).status, 200);
});

test('production Hub partial activation failure retires the same original owner before startup rejects', async t => {
  const f = fixture(t, 'json'); let closed = 0;
  const original = AsyncHubMemberOwner.prototype.closeForShutdown;
  t.mock.method(AsyncHubMemberOwner.prototype, 'closeForShutdown', async function(this: AsyncHubMemberOwner) {
    await original.call(this); assert.equal(this.snapshot().ownerExitConfirmed, true); closed++;
  });
  t.mock.method(WeixinService.prototype, 'startWorker', () => { throw Error('ACTIVATION_REFUSED'); });
  await assert.rejects(async () => createProcessApplication(f.config), /ACTIVATION_REFUSED/);
  assert.equal(closed, 1); assert.equal(startupApplicationCleanup.snapshot().pending, 0);
});

test('production Hub mutable current Key cannot retain constructor authority', async t => {
  const f = fixture(t, 'json'), application = await f.open();
  assert.equal((await f.request(application, base + '/me')).status, 200);
  f.config.accessKey = 'new-current-key';
  for (const path of [base + '/me', '/api/auth/status']) {
    assert.equal((await f.request(application, path)).status, 503);
    assert.equal((await f.request(application, path, { 'x-agentopsdeck-key': 'new-current-key' })).status, 503);
  }
});

test('async Hub application rejects incompatible roles before acquiring an owner', async t => {
  const f = fixture(t, 'sqlite');
  for (const role of ['all', 'connector'] as const) {
    f.config.serverRole = role;
    await assert.rejects(createAsyncHubApplication(f.config), /Hub-only server role/);
    assert.equal(startupApplicationCleanup.snapshot().pending, 0);
  }
});
