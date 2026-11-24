import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isolatedGateway } from './isolated-gateway.mjs';
const evidence = process.argv[2];
const baseline = process.argv[3];
const importAt = (base, file) => import(pathToFileURL(join(base, file)).href);
const original = await importAt(baseline, 'application.js');
const candidate = await importAt(join(evidence, 'dist'), 'application-process.js');
const originalConfig = await importAt(baseline, 'config.js');
const candidateConfig = await importAt(join(evidence, 'dist'), 'config.js');
const directory = await mkdtemp(join(dirname(evidence), 'agentopsdeck-237-cookie-upgrade-state-'));
const cases = [];
const gateway = await isolatedGateway();
try {
for (const role of ['hub', 'connector', 'all']) for (const backend of ['json', 'sqlite']) {
  const state = join(directory, `${role}-${backend}`); await mkdir(state, { mode: 0o700 }); process.chdir(state);
  const accessKey = createHash('sha256').update(`synthetic-237-upgrade-${role}-${backend}`).digest('hex');
  const settings = { AOD_SERVER_ROLE: role, AOD_ACCESS_KEY: accessKey,
    AOD_OPENCLAW_GATEWAY_WS_URL: gateway.url,
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
    ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(state, 'auth.sqlite') } : {}),
    AOD_HUB_DATABASE_FILE: join(state, 'hub.sqlite'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(state, 'connector.sqlite'),
    AOD_HUB_VAULT_SECRET: 'synthetic-237-upgrade-vault' };
  let cookie, savedStatus;
  for (let attempt = 0; attempt < 3; attempt++) {
    const application = attempt === 0
      ? original.createApplication(originalConfig.loadConfig(settings))
      : await candidate.createProcessApplication(candidateConfig.loadConfig(settings));
    const request = (path, init) => application.app.fetch(new Request(`http://isolated.invalid${path}`, init));
    try {
      if (attempt === 0) {
        const login = await request('/api/auth/login', { method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://isolated.invalid' },
          body: JSON.stringify({ accessKey }) });
        assert.equal(login.status, 200); assert.equal((await login.json()).ok, true);
        cookie = /^agentopsdeck_session=[A-Za-z0-9_-]{43}(?=;)/.exec(login.headers.get('set-cookie') ?? '')?.[0];
        assert.ok(cookie, 'Save a cookie issued by the real 2.3.7 HTTP login');
      }
      const status = await request('/api/auth/status', { headers: { cookie } });
      assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store');
      const body = await status.json(); assert.equal(body.authenticated, attempt < 2);
      if (attempt === 0) savedStatus = body;
      if (attempt === 1) {
        assert.deepEqual(body, savedStatus, 'Existing frontend auth status and recovery scope must survive upgrade');
        if (role !== 'connector') {
          assert.match(body.recoveryScope, /^[a-f0-9]{64}$/);
          assert.equal((await request('/api/hub/v1/me', { headers: { cookie } })).status, 200);
        }
        assert.equal((await request('/api/auth/passkeys', { headers: { cookie } })).status, 200);
        const logout = await request('/api/auth/logout', { method: 'POST',
          headers: { cookie, origin: 'http://isolated.invalid' } });
        assert.equal(logout.status, 200); assert.equal((await logout.json()).ok, true);
      }
      if (attempt === 2) {
        assert.equal(body.recoveryScope, undefined);
        assert.equal((await request('/api/auth/passkeys', { headers: { cookie } })).status, 401);
      }
    } finally { await application.close(); }
  }
  cases.push({ role, backend, originalCookieAccepted: true, savedAuthStatusPreserved: true,
    recoveryScopePreserved: role !== 'connector', logoutPersisted: true });
}
} finally { await gateway.close(); }
console.log(JSON.stringify({ version: 1, passed: true,
  baselineTagObject: 'a3e87af23f7d8c626c8af1921bfe2484b79ab9e7',
  baselineCommit: '1fe624fc889f6be8b55e7ea5889d8aa6d72a92a5',
  cases, evidence, productionFactory: 'createProcessApplication',
  isolatedEnvironment: true, nativeSessionStarted: false, liveDatabaseAccess: false,
  listenersStarted: true, applicationListenersStarted: false, loopbackFixtureOnly: true,
  deployed: false, wholeWriterAsync: false, windowsAcceptance: false }, null, 2));
