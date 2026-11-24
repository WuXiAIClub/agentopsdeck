import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';
import { assertCandidateCodexProcess } from './candidate-codex-process-policy.mjs';

const [candidateRoot, command] = process.argv.slice(2);
assert.ok(process.argv.length === 4 && candidateRoot && isAbsolute(candidateRoot) && command && isAbsolute(command),
  'Usage: node scripts/verify-candidate-codex.mjs /absolute/candidate /absolute/existing/codex');
const candidate = await verifyCandidateRelease(candidateRoot);
await access(command, constants.X_OK);
const executable = await realpath(command);
const launcherHash = async () => createHash('sha256').update(await readFile(executable)).digest('hex');
const launcherSha256 = await launcherHash();
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-candidate-codex-'));
console.log('EVIDENCE', directory);
const evidence = { candidateRoot, candidate, command, executable, launcherSha256, startedAt: new Date().toISOString(),
  passed: false, childrenClosed: false, modelRequests: 0, protocol: [], checks: [], errors: [] };
const ambient = join(directory, 'ambient-native');
for (const name of ['ambient-native', 'home', 'tmp']) await mkdir(join(directory, name));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), CODEX_HOME: ambient,
  PATH: '/usr/bin:/bin', NODE_ENV: 'test' });
process.chdir(directory);

const { loadConfig } = await import(join(candidateRoot, 'apps/server/dist/config.js'));
const { createConnectorRuntime } = await import(join(candidateRoot, 'apps/server/dist/connector/runtime.js'));
const nativeSpawn = childProcess.spawn;
const nativeExecFile = childProcess.execFile;
const originalMethods = new Map();
const children = [];
let expectedHome, runtime;
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  originalMethods.set(method, childProcess[method]);
  childProcess[method] = (...arguments_) => {
    assertCandidateCodexProcess(method, arguments_, {
      command, home: join(directory, 'home'), nativeHome: expectedHome,
    });
    const child = method === 'execFile' ? nativeExecFile(...arguments_) : nativeSpawn(...arguments_);
    const lifetime = { child, exited: false };
    lifetime.closed = new Promise(resolve => child.once('close', () => { lifetime.exited = true; resolve(); }));
    children.push(lifetime);
    return child;
  };
}
syncBuiltinESMExports();

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function closeRuntime() {
  if (!runtime) return;
  const closing = runtime.close();
  try { await within(closing, 'native runtime close'); }
  catch (error) {
    for (const lifetime of children) if (!lifetime.exited) lifetime.child.kill('SIGKILL');
    await within(Promise.all(children.map(lifetime => lifetime.closed)), 'owned native children close');
    await within(closing, 'runtime cleanup after native close');
    throw error;
  } finally { runtime = undefined; }
}

try {
  const identities = new Set();
  for (const label of ['alice', 'bob']) {
    const home = join(directory, label);
    expectedHome = join(home, 'native');
    await mkdir(expectedHome, { recursive: true });
    process.chdir(home);
    const config = loadConfig({ HOME: join(directory, 'home'), AOD_SERVER_ROLE: 'connector',
      AOD_CODEX_ENABLED: 'true', AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: expectedHome,
      AOD_CODEX_DEFAULT_CWD: home, AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
      AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false' });
    let nodeId;
    for (const restart of [false, true]) {
      runtime = createConnectorRuntime(config, () => false);
      const write = runtime.codex.write.bind(runtime.codex);
      runtime.codex.write = message => {
        assert.ok(['initialize', 'initialized', 'thread/list'].includes(message.method), 'Model, turn and tool requests are forbidden');
        evidence.protocol.push({ label, restart, method: message.method });
        return write(message);
      };
      if (restart) assert.equal(runtime.connectorUsers.nodeId, nodeId);
      else { nodeId = runtime.connectorUsers.nodeId; identities.add(nodeId); }
      const response = await within(runtime.app.request('/api/connector/v1/sessions/state', {
        headers: { authorization: `Bearer ${runtime.localToken}` },
      }), 'canonical session snapshot');
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.equal(runtime.codex.isSessionListReady(), true);
      assert.equal(runtime.store.getSessionDirectory().sessions.length, 0);
      await closeRuntime();
      assert.ok(children.every(lifetime => lifetime.exited));
      evidence.checks.push(`${label}:${restart ? 'same-data-restart' : 'first-start'}:installed-codex-empty-list-and-close`);
    }
    assert.ok((await readdir(expectedHome)).length > 0);
  }
  assert.equal(identities.size, 2);
  assert.equal(children.length, 8); // Four bounded feature probes and four app-servers.
  assert.deepEqual(await readdir(ambient), []);
  assert.equal(await realpath(command), executable);
  assert.equal(await launcherHash(), launcherSha256);
  assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  evidence.candidateUnchanged = true;
  evidence.launcherUnchanged = true;
  evidence.passed = true;
} catch (error) {
  evidence.errors.push(error.stack ?? String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await closeRuntime(); }
  catch (error) { evidence.errors.push(error.stack ?? String(error)); evidence.passed = false; process.exitCode = 1; }
  for (const [method, original] of originalMethods) childProcess[method] = original;
  syncBuiltinESMExports();
  evidence.childrenClosed = children.every(lifetime => lifetime.exited);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
}
