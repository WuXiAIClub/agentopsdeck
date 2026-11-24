import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { verifyCandidateHistoryAdmission } from './verify-candidate-history-admission.mjs';
import { parseCandidateStartupArguments } from './candidate-startup-options.mjs';

const { candidateRoot, applicationBrowserRecovery } = parseCandidateStartupArguments(process.argv.slice(2));
const browserProbe = applicationBrowserRecovery
  ? (await import('../apps/web/tests/candidate-app-recovery.browser.mjs')).verifyApplicationRecovery : undefined;
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-candidate-startup-'));
console.log('EVIDENCE', directory);
const evidence = { candidateRoot, candidate, startedAt: new Date().toISOString(), passed: false, childrenClosed: false,
  nativeEnabled: false, modelRequests: 0, listenBoundary: 'configured-loopback-observed-without-rewriting', checks: [], errors: [] };
const save = () => writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const preload = fileURLToPath(new URL('./ci-install-guard.mjs', import.meta.url));
// Generated credentials live only in a private disposable config, never in
// source fixtures, inherited env, argv, or printed request/response bodies.
const accessKey = randomBytes(32).toString('hex');
const bootstrap = randomBytes(32).toString('hex');
const vault = randomBytes(32).toString('hex');
function environment(role, home) {
  return { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', NODE_ENV: 'test', PORT: '0', AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: role,
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false' };
}

async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 20_000); })]); }
  finally { clearTimeout(timer); }
}

const lifetimes = [];
async function observeStorageRecovery(role, request) {
  const bases = role === 'hub' ? ['hub'] : role === 'connector' ? ['connector'] : ['hub', 'connector'];
  for (const base of bases) {
    const path = `/api/${base}/v1/maintenance/storage/recovery`;
    const denied = await request(path, undefined, 'GET', false);
    assert.ok([401, 403].includes(denied.status), `Recovery observations must remain protected (${base}: HTTP ${denied.status})`);
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const observation = await response.json();
    assert.deepEqual(observation.connection, { state: 'ready', attempts: 0 });
    assert.equal(observation.performance.scope, 'process');
    assert.equal(observation.performance.retention, 'volatile');
    assert.ok(Array.isArray(observation.performance.events));
  }
}
async function start(role, home, maintenanceToken, operation) {
  const child = spawn(process.execPath, ['--import', preload, join(candidateRoot, candidate.entrypoint)], {
    cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment(role, home),
  });
  const lifetime = { child, exited: false };
  const closed = new Promise(resolve => child.once('close', (code, signal) => { lifetime.exited = true; resolve({ code, signal }); }));
  lifetimes.push(lifetime);
  let output = '', errors = '', resolveReady, rejectReady, origin;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.on('error', rejectReady);
  void closed.then(result => rejectReady(new Error(`Candidate exited before readiness: ${JSON.stringify(result)}`)));
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = output.match(/AOD_TEST_LISTENER (\{[^\n]+\})/);
    if (match) {
      try { resolveReady(JSON.parse(match[1])); } catch (error) { rejectReady(error); }
    }
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const listener = await within(ready, `${role} entrypoint`);
    assert.equal(listener.address, '127.0.0.1');
    origin = `http://127.0.0.1:${listener.port}`;
    const request = (path, body, method, authenticated = true) => {
      assert.equal(new URL(path, origin).origin, origin, 'Only this owned listener may receive probe traffic');
      return fetch(origin + path, { method: method ?? (body ? 'POST' : 'GET'), signal: AbortSignal.timeout(10_000), redirect: 'error',
      headers: { ...(authenticated ? { authorization: `Bearer ${path.startsWith('/api/connector/v1/maintenance/') ? maintenanceToken : path.startsWith('/api/connector/') ? bootstrap : accessKey}` } : {}),
        'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    };
    const health = await request('/api/health'); assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const protectedPath = role === 'hub' ? '/api/hub/v1/me' : '/api/connector/v1/identity';
    assert.equal((await request(protectedPath, undefined, 'GET', false)).status, 401);
    const web = await request('/'); assert.equal(web.status, 200);
    const html = await web.text();
    assert.equal(html, await readFile(join(candidateRoot, 'apps/web/dist/index.html'), 'utf8'));
    const asset = html.match(/src="([^\"]+\.js)"/); assert.ok(asset);
    const bundle = await request(asset[1]); assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type'), /javascript/);
    assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), await readFile(join(candidateRoot, 'apps/web/dist', asset[1])));
    await observeStorageRecovery(role, request);
    await operation(request);
    if (role === 'hub' && browserProbe) await browserProbe(origin, accessKey, evidence);
    await observeStorageRecovery(role, request);
    evidence.checks.push(`${role}:protected-no-store-original-storage-recovery`);
    evidence.checks.push(`${role}:entrypoint-health-web-assets-and-state`);
  } finally {
    if (!lifetime.exited) child.kill('SIGTERM');
    try {
      const result = await within(closed, `${role} graceful exit`);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.doesNotMatch(errors, /INSTALL_BOUNDARY/);
      if (origin) await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000), redirect: 'error' }), 'Stopped listener must not answer');
    } catch (error) {
      if (!lifetime.exited) child.kill('SIGKILL');
      await closed;
      throw error;
    } finally {
      await writeFile(join(directory, `${role}-${lifetimes.length}.stdout.log`), output);
      await writeFile(join(directory, `${role}-${lifetimes.length}.stderr.log`), errors);
    }
  }
}

try {
  // A healthy fresh session cannot prove old checkpoint-bearing sessions can
  // dispatch. Fail the normal startup acceptance on fallback-only artifacts.
  evidence.historyAdmission = await verifyCandidateHistoryAdmission(candidateRoot);
  evidence.checks.push('compiled-existing-session-admission-policy');
  for (const role of ['connector', 'hub', 'all']) {
    const home = join(directory, 'isolated', role, 'state', 'cwd');
    await mkdir(home, { recursive: true });
    const configFile = join(home, '.env');
    await writeFile(configFile, `AOD_ACCESS_KEY=${accessKey}\nAGENTOPSDECK_CONNECTOR_BOOTSTRAP_TOKEN=${bootstrap}\nAGENTOPSDECK_HUB_VAULT_SECRET=${vault}\n`, { mode: 0o600, flag: 'wx' });
    const configBefore = await readFile(configFile);
    const { ConnectorTokenStore } = await import(join(candidateRoot, 'apps/server/dist/auth/connector-token.js'));
    const maintenanceToken = new ConnectorTokenStore(join(home, '.agentopsdeck-connector-tokens.json'))
      .create({ label: 'isolated entrypoint maintenance', scopes: ['connector:update'] }).token;
    let nodeId, paused, preferences;
    await start(role, home, maintenanceToken, async request => {
      if (role !== 'connector') {
        const url = '/api/hub/v1/workspace/preferences';
        const original = await request(url); assert.equal(original.status, 200);
        const value = await original.json();
        const changed = await request(url, { ...value, groups: [{ id: 'install-persistence', name: 'Persisted through restart' }], ungroupedCollapsed: true }, 'PUT');
        assert.equal(changed.status, 200); preferences = await changed.json();
        assert.equal(preferences.revision, value.revision + 1);
        assert.equal(preferences.groups[0].name, 'Persisted through restart');
        assert.deepEqual(await (await request(url)).json(), preferences);
      }
      if (role === 'hub') return;
      const identity = await request('/api/connector/v1/identity'); assert.equal(identity.status, 200);
      nodeId = (await identity.json()).nodeId;
      const response = await request('/api/connector/v1/maintenance/commands/pause', { idempotencyKey: 'entry-pause' });
      assert.equal(response.status, 200); paused = await response.json();
      assert.equal(paused.state, 'paused'); assert.equal(paused.nativeQuiescent, false);
    });
    await start(role, home, maintenanceToken, async request => {
      if (role !== 'connector') {
        const restored = await request('/api/hub/v1/workspace/preferences'); assert.equal(restored.status, 200);
        assert.deepEqual(await restored.json(), preferences);
      }
      if (role === 'hub') return;
      assert.equal((await (await request('/api/connector/v1/identity')).json()).nodeId, nodeId);
      assert.equal((await request('/api/connector/v1/sessions/state')).status, 503);
      const recovered = await (await request('/api/connector/v1/maintenance/commands/pause/entry-pause')).json();
      assert.equal(recovered.command.id, paused.command.id);
      await observeStorageRecovery(role, request);
      assert.equal((await request('/api/connector/v1/sessions/state')).status, 503,
        'Read-only recovery must not release the original durable pause fence');
      assert.deepEqual(await (await request('/api/connector/v1/maintenance/commands/pause/entry-pause')).json(), recovered,
        'Recovery observations must preserve the original command receipt');
      evidence.checks.push(`${role}:paused-recovery-preserves-fence-and-original-receipt`);
      const response = await request('/api/connector/v1/maintenance/commands/resume', { idempotencyKey: 'entry-resume', fenceId: paused.fenceId });
      assert.equal(response.status, 200); assert.equal((await response.json()).state, 'released');
      assert.equal((await request('/api/connector/v1/sessions/state')).status, 200);
    });
    assert.ok((await readFile(configFile)).equals(configBefore), 'Installed config must survive restart unchanged');
    evidence.checks.push(`${role}:same-data-process-restart-and-graceful-shutdown`);
  }
  // Load-bearing fault AFTER positives: a dev-tree fallback or a weakened
  // startup check must not turn a missing installed application into success.
  const application = join(candidateRoot, 'apps/server/dist/application-process.js');
  await rename(application, application + '.disabled');
  try {
    const home = join(directory, 'isolated/hub/state/cwd');
    const broken = spawnSync(process.execPath, ['--import', preload, join(candidateRoot, candidate.entrypoint)], {
      cwd: home, env: environment('hub', home), timeout: 20_000, encoding: 'utf8',
    });
    assert.equal(broken.error, undefined, 'Negative control must exit, not time out');
    assert.equal(broken.signal, null);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.ok(broken.stderr.includes(application));
    assert.doesNotMatch(broken.stdout, /AOD_TEST_LISTENER/);
    evidence.checks.push('negative-control:missing-installed-application-exit-1');
  } finally { await rename(application + '.disabled', application); }
  assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  evidence.candidateUnchanged = true;
  evidence.positiveStarts = lifetimes.length;
  evidence.passed = true;
} catch (error) {
  evidence.errors.push(error.stack ?? String(error)); console.error(error); process.exitCode = 1;
} finally {
  evidence.childrenClosed = lifetimes.every(lifetime => lifetime.exited);
  evidence.finishedAt = new Date().toISOString(); await save();
  console.log('CANDIDATE_STARTUP ' + JSON.stringify({ passed: evidence.passed, childrenClosed: evidence.childrenClosed,
    candidateUnchanged: evidence.candidateUnchanged, positiveStarts: evidence.positiveStarts, checks: evidence.checks,
    crossVersionUpgrade: 'unverified', websocket: 'not-exercised-native-and-website-gateway-disabled' }));
}
