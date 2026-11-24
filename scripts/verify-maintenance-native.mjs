// Opt-in integration: real systemd, immutable releases, native Codex, Connector
// HTTP, independent maintenance host and stopped-state archive restoration.
// Touches only its random fixture unit/directories. Never opens existing runtime
// state/credentials. Upgrade uses a fixture descriptor, NOT a remote-main build.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { reconcileLocalMaintenance } from './reconcile-local-maintenance.mjs';
import { runArchiveBootstrap } from './bootstrap-archived-maintenance.mjs';
import { verifyNativeStoppedRecovery } from './verify-maintenance-recovery-native.mjs';
// Allow acceptance against the exact immutable toolkit running the independent
// host, without accidentally testing a dirty worktree's dist instead.
const toolkitRoot = process.env.AOD_TEST_MAINTENANCE_TOOLKIT
  ?? fileURLToPath(new URL('../', import.meta.url));
assert.ok(isAbsolute(toolkitRoot));
if (process.env.AOD_TEST_MAINTENANCE_TOOLKIT) await verifyCandidateRelease(toolkitRoot);
const toolkitModule = relative => import(pathToFileURL(join(toolkitRoot, 'apps/server/dist', relative)).href);
const { ConnectorTokenStore } = await toolkitModule('auth/connector-token.js');
const { NodeMaintenanceAdapter } = await toolkitModule('lifecycle/maintenance-node-adapter.js');
const { SystemdConnectorService } = await toolkitModule('lifecycle/maintenance-systemd.js');
const { MaintenanceConnectorClient } = await toolkitModule('lifecycle/maintenance-connector-client.js');
const { startMaintenanceHost } = await toolkitModule('lifecycle/maintenance-host.js');

const [previousRoot, nextRoot, codexCommand, model, providerOrigin] = process.argv.slice(2);
assert.equal(process.argv.length, 7);
assert.equal(process.platform, 'linux');
assert.ok([previousRoot, nextRoot, codexCommand].every(isAbsolute));
assert.match(model, /^[a-zA-Z0-9._-]+$/);
const provider = new URL(providerOrigin);
assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
  && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
await verifyCandidateRelease(previousRoot); await verifyCandidateRelease(nextRoot);
const execute = promisify(execFile), directory = await mkdtemp('/tmp/agentopsdeck-native-maintenance-');
console.log('EVIDENCE', directory);
const unit = `agentopsdeck-native-check-${randomBytes(8).toString('hex')}.service`;
const busDirectory = `/run/user/${process.getuid()}`;
assert.equal((await stat(busDirectory)).uid, process.getuid());
process.env.XDG_RUNTIME_DIR = busDirectory;
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busDirectory}/bus`;
const systemctl = async (...args) => (await execute('/usr/bin/systemctl', ['--user', ...args], {
  timeout: 60_000, maxBuffer: 64 * 1024, env: process.env,
})).stdout.trim();
const unitFile = join(busDirectory, 'systemd/user', unit);
const reconciliationCheck = process.env.AOD_TEST_MAINTENANCE_RECONCILIATION === '1';
const cancellationCheck = process.env.AOD_TEST_MAINTENANCE_CANCELLATION === '1';
assert.ok(!cancellationCheck || reconciliationCheck, 'Cancellation acceptance requires reconciliation fixture');
const archivedCheck = process.env.AOD_TEST_MAINTENANCE_ARCHIVED === '1';
const bootstrapCheck = process.env.AOD_TEST_MAINTENANCE_ARCHIVE_BOOTSTRAP === '1';
const recoveryCheck = process.env.AOD_TEST_MAINTENANCE_RECOVERY === '1';
assert.ok(!recoveryCheck || !(reconciliationCheck || cancellationCheck || archivedCheck || bootstrapCheck),
  'Stopped recovery is a separate fixture, not an archive exception');
assert.ok(!bootstrapCheck || (archivedCheck && cancellationCheck), 'bootstrap acceptance requires archive and cancellation fixtures');
const workerUnit = `agentopsdeck-reconcile-check-${randomBytes(8).toString('hex')}.service`;
const workerUnitFile = join(busDirectory, 'systemd/user', workerUnit);
const state = join(directory, 'node'), settings = join(directory, 'settings'), releases = join(directory, 'releases');
const jobs = join(directory, 'jobs'), journal = join(directory, 'supervisor');
const pointer = join(settings, 'active.json');
const evidence = { directory, unit, toolkitRoot, passed: false, productionUnitsTouched: false,
  upgradeSource: 'fixture-pinned-descriptor-not-remote-main', checks: [], cleanup: false };
let created = false, workerCreated = false, host, controller;
async function wait(label, check, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(300); }
  throw new Error(`Timed out: ${label}`);
}
const write = (file, text) => writeFile(file, text, { flag: 'wx', mode: 0o600 });
async function paths(root, suffix) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = join(root, item.name);
    if (item.isDirectory()) result.push(...await paths(file, suffix));
    else if (item.isFile() && item.name.endsWith(suffix)) result.push(file);
  }
  return result;
}
try {
  for (const path of [state, settings, releases, jobs, journal, ...['home', 'native', 'workspace', 'tmp'].map(name => join(state, name))])
    await mkdir(path, { mode: 0o700 });
  const pins = [];
  for (const [index, source] of [previousRoot, nextRoot].entries()) {
    const target = join(releases, `generation-${index}`);
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    const verified = await verifyCandidateRelease(target);
    // Synthetic revision identity is explicit; content integrity is the actual
    // immutable manifest. This test does not certify main provenance.
    pins.push({ format: 1, directory: target, revision: String(index + 1).repeat(40), manifestSha256: verified.manifestSha256 });
  }
  if (!recoveryCheck) assert.notEqual(pins[0].manifestSha256, pins[1].manifestSha256, 'use distinct candidates');
  await write(pointer, JSON.stringify(pins[0]));
  await write(join(state, 'native/config.toml'), `model = ${JSON.stringify(model)}\nmodel_provider = "fixture_bridge"\n[model_providers.fixture_bridge]\nname = "fixture_bridge"\nbase_url = ${JSON.stringify(provider.origin)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  await write(join(state, 'workspace/保留.md'), '# Preserved fixture workspace\n');
  const tokenFile = join(state, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const owner = tokens.create({ label: 'fixture only', scopes: ['sessions:read', 'sessions:create', 'messages:read', 'messages:send', 'connector:lifecycle'] });
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const connectorUrl = `http://127.0.0.1:${port}`, base = `${connectorUrl}/api/connector/v1`;
  const environment = { PATH: '/usr/bin:/bin', HOME: join(state, 'home'), TMPDIR: join(state, 'tmp'),
    CODEX_HOME: join(state, 'native'), AOD_CODEX_HOME: join(state, 'native'),
    AOD_CODEX_ENABLED: 'true', AOD_CODEX_COMMAND: codexCommand, AOD_CODEX_DEFAULT_MODEL: model,
    AOD_CODEX_MODEL_PROVIDER: 'fixture_bridge', AOD_CODEX_DEFAULT_CWD: join(state, 'workspace'),
    AOD_CODEX_APPROVAL_POLICY: 'on-request', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_TOKENS_FILE: tokenFile, AOD_LISTEN_HOST: '127.0.0.1', PORT: String(port),
    AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
    AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false' };
  const quote = value => JSON.stringify(value).replaceAll('%', '%%').replaceAll('$', '$$');
  const launcher = join(nextRoot, 'apps/server/dist/lifecycle/maintenance-launcher.js');
  const diagnosticArgs = [];
  if (process.env.AOD_TEST_MAINTENANCE_TRACE === '1') {
    evidence.instrumented = true;
    const trace = join(settings, 'trace.mjs');
    await write(trace, `import {appendFileSync} from 'node:fs';
const emit = entry => appendFileSync(${JSON.stringify(join(directory, 'diagnostics.jsonl'))},JSON.stringify({pid:process.pid,...entry})+'\\n',{mode:0o600});
for (const directory of ${JSON.stringify(pins.map(pin => pin.directory))}) {
  for (const [file, name, methods] of [
    ['codex/app-server.js','CodexAppServer',['inspectMaintenance','refreshSessions','refreshSession']],
    ['connector/update-service.js','ConnectorUpdateService',['withMaintenanceProbe']]
  ]) {
    const Class = (await import(directory+'/apps/server/dist/'+file))[name];
    for (const method of methods) {
      const original = Class.prototype[method];
      Class.prototype[method] = async function(...args) {
        emit({method,phase:'enter'});
        try { const result = await original.apply(this,args); emit({method,phase:'exit',...(method==='inspectMaintenance'?{activeRuns:result.activeRuns,backgroundTerminals:result.backgroundTerminals,inFlightWrites:result.inFlightWrites}:{})}); return result; }
        catch(error) { emit({method,error:String(error?.message).slice(0,300)}); throw error; }
      };
    }
  }
}
`);
    diagnosticArgs.push('--import', trace);
  }
  const startArgs = ['-i', ...Object.entries(environment).map(([name, value]) => `${name}=${value}`), '/usr/bin/node', ...diagnosticArgs, launcher, pointer, releases];
  await write(unitFile, `[Unit]\nDescription=AgentOpsDeck isolated native maintenance acceptance\n[Service]\nType=simple\nWorkingDirectory=${state}\nExecStart=/usr/bin/env ${startArgs.map(quote).join(' ')}\nKillMode=control-group\nDelegate=no\nTimeoutStopSec=20\nRestart=no\nUMask=0077\nStandardOutput=null\nStandardError=null\n`);
  created = true;
  await systemctl('daemon-reload'); await systemctl('start', unit);
  const controlGroup = await systemctl('show', '--property=ControlGroup', '--value', unit);
  controller = new SystemdConnectorService({ unit, controlGroup, systemctl: '/usr/bin/systemctl' });
  await controller.verifyRunning();
  const headers = { authorization: `Bearer ${owner.token}`, 'x-agentopsdeck-protocol': '1' };
  async function request(suffix, body, commandKey = randomUUID()) {
    const response = await fetch(`${base}${suffix}`, { headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'idempotency-key': commandKey } : {}) },
      signal: AbortSignal.timeout(60_000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `Connector ${suffix.split('?')[0]} returned ${response.status}`);
    return response.json();
  }
  const identity = await wait('Connector identity', async () => {
    try { return await request('/identity'); } catch { return false; }
  }, 60_000);
  const nodeId = identity.nodeId;
  headers['x-agentopsdeck-expected-node-id'] = nodeId;
  const { key: sessionKey } = await request('/agents/codex/sessions', { title: 'Isolated maintenance acceptance', model });
  assert.match(sessionKey, /^codex:/);
  const sessionPath = `/sessions/${encodeURIComponent(sessionKey)}`;
  async function turn(marker, path = sessionPath) {
    await request(`${path}/messages`, { message: `Reply with exactly ${marker}. Do not use tools.` });
    return wait('completed native reply', async () => {
      const session = await request(`${path}/state`);
      if (session.runtime?.phase === 'failed') throw new Error('Fixture native turn failed');
      if (session.runtime?.phase !== 'completed' || session.runtime?.sync !== 'current' || session.hasActiveRun) return false;
      const history = await request(`${path}/messages?limit=200`);
      return history.messages.some(row => row.role === 'assistant' && row.text?.includes(marker)) ? history : false;
    });
  }
  await turn('MAINTENANCE_BEFORE');
  // Every persisted terminal is invalidated on restart. Readiness must recover
  // all of them, not only the configured business-probe session.
  const secondary = await request('/agents/codex/sessions', { title: 'Secondary maintenance history', model });
  const secondaryPath = `/sessions/${encodeURIComponent(secondary.key)}`;
  const secondaryHistory = await turn('SECONDARY_PRESERVED', secondaryPath);
  if (recoveryCheck) {
    await verifyNativeStoppedRecovery({ directory, state, settings, releases, jobs, journal, pointer,
      tokenFile, owner, nodeId, controller, sessionKey, sessionPath, secondaryKey: secondary.key, secondaryPath, secondaryHistory,
      connectorUrl, request, systemctl, unit, evidence, wait, turn,
      ConnectorTokenStore, MaintenanceConnectorClient, NodeMaintenanceAdapter, startMaintenanceHost });
  } else {
  let archivedProof;
  if (archivedCheck) {
    const archived = await request('/agents/codex/sessions', { title: 'Archived maintenance fixture', model });
    const archivedPath = `/sessions/${encodeURIComponent(archived.key)}`;
    await turn('ARCHIVED_PRESERVED', archivedPath);
    const deletionKey = randomUUID();
    const response = await fetch(`${base}${archivedPath}`, { method: 'DELETE', headers: { ...headers, 'idempotency-key': deletionKey },
      signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const files = (await paths(join(state, 'native/archived_sessions'), '.jsonl'))
      .filter(file => file.endsWith(`-${archived.key.slice('codex:'.length)}.jsonl`));
    assert.equal(files.length, 1, 'native archive was durably materialized');
    archivedProof = { file: files[0], digest: createHash('sha256').update(await readFile(files[0])).digest('hex'),
      path: archivedPath, deletionKey };
    evidence.archivedSession = { sessionKey: archived.key, deletionAccepted: true };
  }
  console.log('PASS native pre-maintenance turn');
  if (bootstrapCheck) {
    // Reproduce the ACTUAL legacy bug: restart the old code after archiving,
    // then hydrate the non-archived histories. No synthetic pending response.
    const observation = await request('/maintenance/inspection');
    assert.ok(['activeRuns','backgroundTerminals','pendingExecutions','queuedMessages','inFlightWrites'].every(key => observation[key] === 0));
    await controller.stop(); await controller.start();
    await wait('old generation ready', async () => { try { return await request('/identity'); } catch { return false; } });
    await wait('non-archived histories recovered', async () => {
      try {
        await request(`${sessionPath}/messages?limit=200`); await request(`${secondaryPath}/messages?limit=200`);
        const observed = await request('/maintenance/inspection');
        if (observed.pendingExecutions !== 1) return false;
        assert.ok(['activeRuns','backgroundTerminals','queuedMessages','inFlightWrites'].every(key => observed[key] === 0));
        evidence.legacyArchiveObservation = observed; return true;
      } catch { return false; }
    });
  }
  const nativeFiles = (await paths(join(state, 'native/sessions'), '.jsonl'))
    .filter(file => file.endsWith(`-${sessionKey.slice('codex:'.length)}.jsonl`));
  assert.equal(nativeFiles.length, 1, 'exactly one rollout for the fixture native session');
  const nativePrefix = await readFile(nativeFiles[0]);
  const authorized = job => job.nodeId === nodeId && new ConnectorTokenStore(tokenFile).hasScope(job.actorId, 'connector:lifecycle');
  // Faults are injected only into the isolated observer transport. Real native
  // inspection, fences, stop/backup/start and business readiness remain intact.
  const faults = reconciliationCheck ? [503, 503, 500] : [];
  const connector = new MaintenanceConnectorClient({ connectorUrl, nodeId, credential: () => owner.token,
    fetch: async (url, options) => {
      if (String(url).endsWith('/inspection') && faults.length) return new Response('{}', {
        status: faults.shift(), headers: { 'x-agentopsdeck-node-id': nodeId, 'x-agentopsdeck-protocol': '1' },
      });
      const response = await fetch(url, options);
      if (String(url).endsWith('/readiness')) {
        const body = await response.clone().json().catch(() => ({}));
        evidence.readiness = { status: response.status, revision: body.revision,
          messageCount: body.messageCount, projectionVerified: body.projectionVerified,
          businessReadVerified: body.businessReadVerified };
      }
      return response;
    },
    authorize: job => { if (!authorized(job)) throw new Error('Fixture authorization changed'); } });
  const builder = join(settings, 'fixture-builder.mjs');
  await write(builder, `import {writeFileSync} from 'node:fs';\nwriteFileSync(process.argv.at(-1),${JSON.stringify(JSON.stringify(pins[1]))},{flag:'wx',mode:0o600});\n`);
  const adapter = new NodeMaintenanceAdapter({ nodeId, sessionKey, releasesDirectory: releases, activeReleaseFile: pointer,
    workDirectory: jobs, backupRoots: [state, settings], tar: '/usr/bin/tar', service: controller, connector,
    authorize: async job => authorized(job), prepare: { executable: '/usr/bin/node', args: [builder], systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' } });
  const hostOptions = { nodeId, journalFile: join(journal, 'journal.sqlite'), tokenFile,
    protectedRoots: [state, settings, releases, jobs], adapter, operations: ['restart', 'upgrade'], port: 0, tickMs: 100 };
  host = await startMaintenanceHost(hostOptions);
  async function maintenance(path, body) {
    const response = await fetch(`http://127.0.0.1:${host.port}/api/maintenance/v1${path}`, {
      headers: { authorization: `Bearer ${owner.token}`, 'x-agentopsdeck-maintenance-protocol': '1', 'x-agentopsdeck-expected-node-id': nodeId, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, body ? 202 : 200);
    return response.json();
  }
  // First upgrade the old generation, then exercise restart on the new code.
  // An old generation may contain precisely the recovery bug under test.
  for (const operation of ['upgrade', 'restart']) {
    const beforePin = JSON.parse(await readFile(pointer, 'utf8'));
    let key = `fixture:${operation}`;
    const stages = new Set();
    const beforePid = await systemctl('show', '--property=MainPID', '--value', unit);
    await maintenance('/commands', { commandKey: key, operation });
    if (reconciliationCheck && operation === 'upgrade') {
      const retries = new Set();
      const failed = await wait('bounded observation retries then attention', async () => {
        const { command } = await maintenance(`/commands/${encodeURIComponent(key)}`);
        if (command.observationRetry) retries.add(command.observationRetry.attempts);
        return command.stage === 'attention' ? command : false;
      });
      assert.deepEqual([...retries], [1, 2]);
      assert.equal(failed.reason, 'operation_failed'); assert.equal(failed.failedStage, 'drain');
      assert.equal(await systemctl('show', '--property=MainPID', '--value', unit), beforePid);
      await host.close(); host = undefined;
      // A real loaded inactive worker gives the CLI actual OS/cgroup evidence;
      // the in-process test host was closed before its journal is reopened.
      await write(workerUnitFile, '[Unit]\nDescription=Isolated reconciliation boundary\n[Service]\nType=simple\nExecStart=/bin/sleep 60\nKillMode=control-group\nDelegate=no\n');
      workerCreated = true; await systemctl('daemon-reload');
      const credentialFile = join(settings, 'maintenance-token');
      await write(credentialFile, owner.token);
      const configFile = join(settings, 'maintenance.json');
      await write(configFile, JSON.stringify({ format: 1, nodeId, sessionKey, connectorUrl,
        releasesDirectory: releases, activeReleaseFile: pointer, workDirectory: jobs,
        backupRoots: [state, settings], tar: '/usr/bin/tar', credentialFile, tokenFile,
        journalFile: hostOptions.journalFile, listener: { hostname: '127.0.0.1', port: 8793 },
        service: { unit, controlGroup, systemctl: '/usr/bin/systemctl' } }));
      const options = { toolkit: toolkitRoot, toolkitSha256: (await verifyCandidateRelease(toolkitRoot)).manifestSha256,
        configFile, jobId: failed.id, expectedRevision: failed.revision, workerUnit };
      await systemctl('start', workerUnit);
      await assert.rejects(reconcileLocalMaintenance(options), 'live worker must forbid reconciliation');
      await systemctl('stop', workerUnit);
      const resumed = await reconcileLocalMaintenance(options);
      assert.equal(resumed.id, failed.id); assert.equal(resumed.stage, 'drain');
      assert.equal(resumed.revision, failed.revision + 1);
      await assert.rejects(reconcileLocalMaintenance(options), 'stale original revision must not rearm twice');
      evidence.reconciliation = { retries: [...retries], sameIdentity: true, liveWorkerRejected: true, repeatedRearmRejected: true };
      if (cancellationCheck) {
        const cancelOptions = { ...options, expectedRevision: resumed.revision, action: 'cancel' };
        await systemctl('start', workerUnit);
        await assert.rejects(reconcileLocalMaintenance(cancelOptions), 'live worker must forbid cancellation');
        await systemctl('stop', workerUnit);
        const cancelled = await reconcileLocalMaintenance(cancelOptions);
        assert.equal(cancelled.stage, 'cancelled'); assert.equal(cancelled.id, failed.id);
        assert.equal(cancelled.revision, resumed.revision + 1);
        await assert.rejects(reconcileLocalMaintenance(cancelOptions), 'stale cancellation must not be replayed');
        assert.equal(await systemctl('show', '--property=MainPID', '--value', unit), beforePid);
        assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), beforePin);
        evidence.cancellation = { liveWorkerRejected: true, repeatedCancelRejected: true,
          originalServiceUnchanged: true, originalReleaseUnchanged: true, originalReceiptPreserved: true };
        if (bootstrapCheck) {
          const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
          const scriptPins = [];
          for (const name of ['bootstrap-archived-maintenance.mjs', 'archive-bootstrap-evidence.mjs', 'stage-candidate-release.mjs',
            'reconcile-local-maintenance.mjs', 'observe-local-maintenance.mjs', 'prepare-fixed-maintenance-release.mjs']) {
            const file = join(scriptDirectory, name);
            scriptPins.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
          }
          key = `${key}:bootstrap`;
          const proof = pin => ({ revision: pin.revision, manifestSha256: pin.manifestSha256 });
          const specFile = join(settings, 'bootstrap.json');
          await write(specFile, JSON.stringify({ format: 1, authorization: 'one-controlled-archived-pending-window',
            expiresAt: Date.now() + 10 * 60_000, scriptPins, maintenanceConfig: configFile, nodeId,
            commandKey: key, workerUnit, oldJobId: cancelled.id, oldJobRevision: cancelled.revision,
            databaseFile: join(state, '.agentopsdeck-connector-users.sqlite'), nativeRoot: join(state, 'native'),
            resultDirectory: join(directory, 'bootstrap-evidence'), fixedPreparationScript: join(scriptDirectory, 'prepare-fixed-maintenance-release.mjs'),
            previous: pins[0], candidate: pins[1], origins: [connectorUrl],
            archiveBootstrap: { authorizationId: 'fixture-one-window',
              serviceInvocationId: await systemctl('show', '--property=InvocationID', '--value', unit),
              previous: proof(pins[0]), candidate: proof(pins[1]), sessions: [evidence.archivedSession.sessionKey] } }));
          const runOptions = { toolkit: toolkitRoot, toolkitSha256: options.toolkitSha256, specFile };
          await runArchiveBootstrap(runOptions);
          evidence.bootstrap = JSON.parse(await readFile(join(directory, 'bootstrap-evidence/result.json'), 'utf8'));
          assert.equal(evidence.bootstrap.status, 'verified');
          await assert.rejects(runArchiveBootstrap(runOptions), 'same window never executes twice');
          evidence.bootstrapRepeatRejected = true;
        }
      }
      host = await startMaintenanceHost(hostOptions);
      if (cancellationCheck && !bootstrapCheck) {
        assert.equal((await maintenance(`/commands/${encodeURIComponent(key)}`)).command.stage, 'cancelled');
        assert.equal((await maintenance('/commands', { commandKey: key, operation })).command.stage, 'cancelled');
        key = `${key}:replacement`;
        await maintenance('/commands', { commandKey: key, operation });
      }
    }
    const job = await wait(`${operation} lifecycle`, async () => {
      const { command } = await maintenance(`/commands/${encodeURIComponent(key)}`);
      stages.add(command.stage);
      if (command.stage === 'attention') {
        evidence.failedReceipt = { id: command.id, stage: command.stage, failedStage: command.failedStage,
          reason: command.reason, failureCode: command.failureCode };
        throw new Error(`${operation} needs attention: ${command.reason}; observed ${[...stages].join(',')}`);
      }
      return command.stage === 'succeeded' ? command : false;
    });
    assert.notEqual(await systemctl('show', '--property=MainPID', '--value', unit), beforePid);
    assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), pins[1]);
    await controller.verifyRunning();
    assert.equal((await request('/identity')).nodeId, nodeId);
    const archiveDirectory = join(jobs, createHash('sha256').update(job.id).digest('hex'), 'backup');
    const manifest = JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8'));
    const restored = join(directory, `restored-${operation}`);
    await mkdir(restored, { mode: 0o700 });
    for (const record of manifest.records) await execute('/usr/bin/tar', ['-xf', join(archiveDirectory, record.archive), '-C', restored], { timeout: 30_000 });
    assert.equal(await readFile(join(restored, 'node/workspace/保留.md'), 'utf8'), '# Preserved fixture workspace\n');
    assert.equal((await stat(join(restored, 'node/workspace/保留.md'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(restored, 'settings/active.json'), 'utf8')), beforePin);
    assert.ok(new ConnectorTokenStore(join(restored, 'node/tokens.json')).hasScope(owner.record.id, 'connector:lifecycle'));
    assert.ok((await readFile(nativeFiles[0])).subarray(0, nativePrefix.length).equals(nativePrefix));
    await host.close(); host = await startMaintenanceHost(hostOptions);
    assert.equal((await maintenance(`/commands/${encodeURIComponent(key)}`)).command.id, job.id);
    const secondaryState = await request(`${secondaryPath}/state`);
    assert.equal(secondaryState.runtime?.sync, 'current');
    assert.equal(secondaryState.hasActiveRun, false);
    assert.deepEqual((await request(`${secondaryPath}/messages?limit=200`)).messages, secondaryHistory.messages);
    const history = await turn(`MAINTENANCE_AFTER_${operation.toUpperCase()}`);
    if (archivedProof) {
      const state = await request('/sessions/state?includeHidden=1&includeArchived=1');
      assert.ok(!state.groups.flatMap(group => group.sessions).some(session => session.sessionKey === evidence.archivedSession.sessionKey),
        'archived session must not reappear after history recovery or the queue worker');
      assert.equal(createHash('sha256').update(await readFile(archivedProof.file)).digest('hex'), archivedProof.digest,
        'archived native transcript must remain untouched');
      const receipt = await request(`${archivedProof.path}/deletion-commands/${encodeURIComponent(archivedProof.deletionKey)}`);
      assert.equal(receipt.command?.state, 'accepted', 'original deletion ACK remains durable');
    }
    evidence.checks.push({ operation, stages: [...stages], restoredToSeparateDirectory: true, nativePrefixPreserved: true,
      receiptSurvivedSupervisorRestart: true, secondaryTerminalPreserved: true,
      ...(archivedProof ? { archivedTranscriptPreserved: true, archivedSessionNotReprojected: true, deletionReceiptPreserved: true } : {}),
      postRestartMessageCount: history.messages.length });
    console.log(`PASS ${operation}, restored backup and native follow-up`);
  }
  }
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Native maintenance check failed';
  process.exitCode = 1;
} finally {
  await host?.close().catch(() => { evidence.passed = false; process.exitCode = 1; });
  if (workerCreated) {
    try { await systemctl('stop', workerUnit); await unlink(workerUnitFile); await systemctl('daemon-reload'); }
    catch { evidence.passed = false; process.exitCode = 1; evidence.workerCleanupFailed = true; }
  }
  if (created) {
    try {
      await systemctl('stop', unit);
      // Fixture failure may deliberately interrupt a native run. Reset only
      // this random test unit's failed status, then still prove its cgroup empty.
      if (await systemctl('show', '--property=ActiveState', '--value', unit) === 'failed')
        await systemctl('reset-failed', unit);
      await controller?.verifyStopped();
      await unlink(unitFile); await systemctl('daemon-reload');
      evidence.cleanup = true;
    } catch (error) {
      evidence.cleanup = false; evidence.passed = false; process.exitCode = 1;
      evidence.cleanupError = error instanceof Error ? error.message : 'Fixture cleanup failed';
    }
  }
  await write(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
