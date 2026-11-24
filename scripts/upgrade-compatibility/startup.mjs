import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isolatedGateway } from './isolated-gateway.mjs';

const evidence = resolve(process.argv[2]);
const inputs = await readFile(join(evidence, 'inputs.json'));
const { createProcessApplication } = await import(pathToFileURL(join(evidence, 'dist/application-process.js')));
const { loadConfig } = await import(pathToFileURL(join(evidence, 'dist/config.js')));
const root = await mkdtemp(join(dirname(evidence), 'agentopsdeck-candidate-reopen-'));
const results = [];
const gateway = await isolatedGateway();
try {
for (const role of ['hub', 'connector', 'all']) {
  const state = join(root, role); await mkdir(state, { mode: 0o700 });
  process.chdir(state);
  const config = loadConfig({ AOD_SERVER_ROLE: role,
    AOD_OPENCLAW_GATEWAY_WS_URL: gateway.url,
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
    AOD_AUTH_SQLITE_FILE: join(state, 'auth.sqlite'),
    AOD_HUB_DATABASE_FILE: join(state, 'hub.sqlite'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(state, 'connector.sqlite'),
    AOD_HUB_VAULT_SECRET: 'synthetic-reopen-vault' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const application = await createProcessApplication(config);
    try {
      for (const path of ['/api/health', '/api/auth/status', ...(role === 'connector' ? []
        : ['/api/hub/v1/me', '/api/hub/v1/connections', '/api/hub/v1/users'])]) {
        const response = await application.app.fetch(new Request(`http://isolated.invalid${path}`));
        assert.equal(response.status, 200, `${role}/${attempt}/${path}`);
        const body = await response.json(); assert.ok(body && typeof body === 'object');
        results.push({ role, attempt, path, status: response.status });
      }
    } finally { await application.close(); await application.close(); }
  }
}
} finally { await gateway.close(); }
console.log(JSON.stringify({ version: 1, passed: true, root, checks: results.length, results,
  inputManifestFile: join(evidence, 'inputs.json'),
  inputManifestFileSha256: createHash('sha256').update(inputs).digest('hex'),
  productionFactory: 'createProcessApplication',
  nativeAgentEnabled: false, realSessionAccess: false, listenersStarted: true,
  loopbackFixtureOnly: true, applicationListenersStarted: false,
  deployed: false, wholeWriterAsync: false, windowsAcceptance: false }, null, 2));
