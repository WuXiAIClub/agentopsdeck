import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isolatedGateway } from './isolated-gateway.mjs';

const evidence = process.argv[2];
const { createProcessApplication } = await import(pathToFileURL(join(evidence, 'dist/application-process.js')));
const { loadConfig } = await import(pathToFileURL(join(evidence, 'dist/config.js')));
const directory = await mkdtemp(join(dirname(evidence), 'agentopsdeck-current-cookie-reopen-'));
const cases = [];
const gateway = await isolatedGateway();
try {
for (const role of ['hub', 'connector', 'all']) for (const backend of ['json', 'sqlite']) {
  const state = join(directory, `${role}-${backend}`); await mkdir(state, { mode: 0o700 }); process.chdir(state);
  const accessKey = createHash('sha256').update(`synthetic-key-${role}-${backend}`).digest('hex');
  const config = loadConfig({ AOD_SERVER_ROLE: role, AOD_ACCESS_KEY: accessKey,
    AOD_OPENCLAW_GATEWAY_WS_URL: gateway.url,
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
    ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(state, 'auth.sqlite') } : {}),
    AOD_HUB_DATABASE_FILE: join(state, 'hub.sqlite'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(state, 'connector.sqlite'),
    AOD_HUB_VAULT_SECRET: 'synthetic-only-reopen-vault' });
  let cookie, recoveryScope;
  for (let attempt = 0; attempt < 3; attempt++) {
    const application = await createProcessApplication(config);
    const request = (path, init) => application.app.fetch(new Request(`http://isolated.invalid${path}`, init));
    try {
      const initial = await request('/api/auth/status'); assert.equal(initial.status, 200);
      assert.equal((await initial.json()).authenticated, false);
      if (attempt === 0) {
        const login = await request('/api/auth/login', { method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://isolated.invalid' },
          body: JSON.stringify({ accessKey }) });
        assert.equal(login.status, 200); assert.equal((await login.json()).ok, true);
        cookie = /^agentopsdeck_session=[A-Za-z0-9_-]{43}(?=;)/.exec(login.headers.get('set-cookie') ?? '')?.[0];
        assert.ok(cookie, 'The existing frontend cookie schema must be preserved');
        assert.equal(login.headers.get('cache-control'), 'no-store');
      }
      const authenticated = await request('/api/auth/status', { headers: { cookie } });
      assert.equal(authenticated.status, 200); assert.equal(authenticated.headers.get('cache-control'), 'no-store');
      const body = await authenticated.json(); assert.equal(body.authenticated, attempt < 2);
      assert.deepEqual(body.passkeys, { available: false, count: 0 });
      if (attempt < 2) {
        if (role !== 'connector') {
          assert.match(body.recoveryScope, /^[a-f0-9]{64}$/);
          if (attempt === 0) recoveryScope = body.recoveryScope;
          else assert.equal(body.recoveryScope, recoveryScope, 'A saved frontend recovery scope must survive reopen');
          assert.equal((await request('/api/hub/v1/me', { headers: { cookie } })).status, 200);
        }
        assert.equal((await request('/api/auth/passkeys', { headers: { cookie } })).status, 200);
      } else {
        assert.equal(body.recoveryScope, undefined);
        assert.equal((await request('/api/auth/passkeys', { headers: { cookie } })).status, 401);
      }
      if (attempt === 1) {
        const logout = await request('/api/auth/logout', { method: 'POST',
          headers: { cookie, origin: 'http://isolated.invalid' } });
        assert.equal(logout.status, 200); assert.equal((await logout.json()).ok, true);
        const revoked = await request('/api/auth/status', { headers: { cookie } });
        assert.equal((await revoked.json()).authenticated, false);
      }
    } finally { await application.close(); await application.close(); }
    assert.equal((await request('/api/auth/status', { headers: { cookie } })).status, 503);
  }
  cases.push({ role, backend, reopenAuthenticated: true, recoveryScopePreserved: role !== 'connector',
    logoutPersisted: true, closedApplicationUnavailable: true });
}
} finally { await gateway.close(); }
console.log(JSON.stringify({ version: 1, passed: true, cases, evidence,
  productionFactory: 'createProcessApplication',
  nativeSessionStarted: false, liveDatabaseAccess: false, listenersStarted: true, deployed: false,
  loopbackFixtureOnly: true, applicationListenersStarted: false,
  wholeWriterAsync: false, windowsAcceptance: false }, null, 2));
