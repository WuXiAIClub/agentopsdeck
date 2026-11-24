import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const launcher = require('../native/windows/control-source/desktop-launcher.cjs');
const config = require('../native/windows/control-source/ui-config.cjs');
const dependencies = require('../native/windows/control-source/ui-dependencies.cjs');
const discovery = require('../native/windows/control-source/codex-discovery.cjs');
const helper = require('../native/windows/launcher/ui-helper.cjs');
import { createHash } from 'node:crypto';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'aod-native-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'program');
  mkdirSync(root);
  return { directory, root, ambient: { LOCALAPPDATA: directory, PATH: '/synthetic/bin', LANG: 'en_US.UTF-8' } };
}

test('desktop plan excludes all ambient app/provider configuration and binds its independent roots', context => {
  const { directory, root, ambient } = fixture(context);
  Object.assign(ambient, { AOD_DATA_DIR: '/unexpected/data', AOD_CONFIG_FILE: '/unexpected/config', AOD_PORT: '1234',
    AOD_CLAUDE_ENABLED: 'true', AOD_COPILOT_ENABLED: 'true', AOD_HERMES_ENABLED: 'true', AOD_CODEX_ENABLED: 'true',
    AOD_CODEX_DEFAULT_CWD: '/unexpected/project', AOD_CODEX_COMMAND: '/unexpected/executable', PROVIDER_API_KEY: 'synthetic',
    ANTHROPIC_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic', HOME: '/unexpected/home', NODE_OPTIONS: '--invalid' });
  const plan = launcher.prepare(root, ambient);
  assert.equal(plan.env.AOD_DATA_DIR, join(directory, 'AgentOpsDeck', 'state'));
  assert.equal(plan.env.AOD_PORT, '8790');
  assert.equal(plan.env.AOD_CONFIG_FILE, join(plan.cwd, 'desktop-server.env'));
  assert.equal(readFileSync(plan.env.AOD_CONFIG_FILE, 'utf8'), '');
  assert.equal(plan.env.HOME, join(plan.data, 'native-home'));
  assert.equal(plan.env.TMPDIR, join(plan.data, 'tmp'));
  for (const name of ['AOD_CODEX_ENABLED', 'AOD_CLAUDE_ENABLED', 'AOD_HERMES_ENABLED', 'AOD_COPILOT_ENABLED']) assert.equal(plan.env[name], 'false');
  for (const name of ['PROVIDER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'AOD_CODEX_COMMAND', 'AOD_CODEX_DEFAULT_CWD']) assert.equal(plan.env[name], undefined);
  assert.equal(plan.env.PATH, ambient.PATH);
});

test('only validated native saved settings override explicit defaults and preserve the Claude key-file path', context => {
  const { directory, root, ambient } = fixture(context);
  const state = join(directory, 'AgentOpsDeck', 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, '.env'), 'PORT=8891\nAOD_CLAUDE_API_KEY_FILE=C:\\Independent\\credentials\\provider.txt\nAOD_DATA_DIR=/unexpected/data\n', { mode: 0o600 });
  const plan = launcher.prepare(root, ambient);
  assert.equal(plan.env.AOD_PORT, '8891');
  assert.equal(plan.env.PORT, '8891');
  assert.equal(plan.env.AOD_CLAUDE_API_KEY_FILE, 'C:\\Independent\\credentials\\provider.txt');
  assert.equal(plan.env.AOD_DATA_DIR, state);
  assert.equal(plan.env.AOD_CLAUDE_ENABLED, 'false');
});

test('native settings reject invalid paths and conflicting port aliases before server launch', context => {
  const { directory } = fixture(context);
  const file = join(directory, 'settings.env');
  writeFileSync(file, 'AOD_CLAUDE_API_KEY_FILE=relative/path\n');
  assert.throws(() => config.load(file), /invalid-field/);
  writeFileSync(file, 'PORT=8890\nAOD_PORT=8891\n');
  assert.throws(() => config.load(file), /conflicting-port-fields/);
});

test('native settings reject conflicting aliases before replacing or backing up the current file', context => {
  const { directory } = fixture(context);
  const file = join(directory, 'settings.env');
  const before = 'PORT=8890\nAOD_PORT=8890\n';
  writeFileSync(file, before);
  const current = config.load(file);
  assert.throws(() => config.save(file, current.revision, { AOD_PORT: '8891' }), /conflicting-port-fields/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(directory).sort(), ['program', 'settings.env']);
});

test('native settings load enforces complete dedicated provider paths without launching a provider', context => {
  const { directory } = fixture(context);
  const file = join(directory, 'settings.env');
  writeFileSync(file, 'AOD_CLAUDE_ENABLED=true\n');
  assert.throws(() => config.load(file), /claude-config-incomplete/);
  writeFileSync(file, 'AOD_CLAUDE_ENABLED=true\nAOD_CLAUDE_DEDICATED=true\nAOD_CLAUDE_SDK_DIR=C:\\AODTools\\sdk\nAOD_CLAUDE_HOME=C:\\AODState\\home\nAOD_CLAUDE_WORKSPACE=C:\\AODWork\\project\nAOD_CLAUDE_API_KEY_FILE=C:\\AODState\\home\\provider.txt\nAOD_CLAUDE_MODEL=synthetic-model\n');
  assert.equal(config.load(file).values.AOD_CLAUDE_ENABLED, 'true');
  assert.throws(() => config.load(file, { userProfile: 'C:\\AODState\\home' }), /claude-personal-home/);
});

test('workspace roots cannot include the application or state through an ancestor or alias', context => {
  const { directory, root, ambient } = fixture(context);
  const data = join(directory, 'AgentOpsDeck');
  const workspace = join(directory, 'workspace');
  mkdirSync(data);
  mkdirSync(workspace);
  assert.throws(() => launcher.validateWorkspace(root, data, directory), /outside program and state/);
  const alias = join(workspace, 'state-alias');
  symlinkSync(data, alias, 'dir');
  assert.throws(() => launcher.validateWorkspace(root, data, alias), /outside program and state/);
  assert.equal(launcher.validateWorkspace(root, data, workspace), workspace);
  assert.equal(ambient.LOCALAPPDATA, directory);
});

test('desktop plan refuses linked runtime directories before reading keys or launching', context => {
  const { directory, root, ambient } = fixture(context);
  const foreign = join(directory, 'other-instance');
  mkdirSync(foreign);
  symlinkSync(foreign, join(directory, 'AgentOpsDeck'), 'dir');
  assert.throws(() => launcher.prepare(root, ambient), /must not be a link/);
});

test('desktop source and staged launcher stay byte-identical', () => {
  for (const name of ['codex-discovery.cjs', 'desktop-launcher.cjs', 'ui-config.cjs', 'ui-dependencies.cjs']) {
    assert.deepEqual(readFileSync(new URL(`../native/windows/control-source/${name}`, import.meta.url)),
      readFileSync(new URL(`../native/windows/launcher/${name}`, import.meta.url)));
  }
});

test('native dependency installation refuses absent or floating plans without spawning installers', async context => {
  const { root, ambient } = fixture(context);
  for (const name of ['sdk', 'codex', 'bash', 'node']) {
    assert.equal((await dependencies.install(name, root, ambient, {})).state, 'reviewed-dependency-plan-required');
  }
  const directory = join(root, 'native-dependency-locks', 'codex');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: { '@openai/codex': 'latest' } }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  assert.equal(dependencies.reviewedPlan('codex', root), null);
});

test('native dependency plan requires exact root version, registry integrity, and audited notices for every transitive input', context => {
  const { root } = fixture(context);
  const directory = join(root, 'native-dependency-locks', 'codex');
  mkdirSync(directory, { recursive: true });
  const manifest = { private: true, dependencies: { '@openai/codex': '0.1.0' } };
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: manifest.dependencies }, 'node_modules/@openai/codex': {
    version: '0.1.0', integrity: 'sha512-' + 'A'.repeat(86) + '==', resolved: 'https://registry.npmjs.org/@openai/codex/-/codex-0.1.0.tgz',
  } } };
  const write = (mutateAudit = a => a) => {
    const rawLock = JSON.stringify(lock);
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'package-lock.json'), rawLock);
    const audit = mutateAudit({
      schemaVersion: 1,
      packageName: '@openai/codex',
      version: '0.1.0',
      lockSha256: createHash('sha256').update(rawLock).digest('hex'),
      productionAudit: { vulnerabilities: 0 },
      developmentAudit: { vulnerabilities: 0 },
      notices: [{ package: '@openai/codex@0.1.0', license: 'Apache-2.0' }],
    });
    writeFileSync(join(directory, 'audit-and-notices.json'), JSON.stringify(audit));
  };
  write();
  assert.equal(dependencies.reviewedPlan('codex', root).version, '0.1.0');
  write(a => ({ ...a, productionAudit: { vulnerabilities: 1 } }));
  assert.equal(dependencies.reviewedPlan('codex', root), null);
  write(a => ({ ...a, notices: [] }));
  assert.equal(dependencies.reviewedPlan('codex', root), null);
  lock.packages['node_modules/@openai/codex'].resolved = 'https://example.invalid/unreviewed.tgz';
  write();
  assert.equal(dependencies.reviewedPlan('codex', root), null);
});

test('codex shim resolver distinguishes local node_modules/.bin/codex.cmd from global npm codex.cmd layout', context => {
  const { directory } = fixture(context);
  const localPrefix = join(directory, 'AgentOpsDeck', 'tools', 'codex');
  const localShim = join(localPrefix, 'node_modules', '.bin', 'codex.cmd');
  const localCli = join(localPrefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(join(localPrefix, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(localPrefix, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  writeFileSync(localShim, '@ECHO off\r\n');
  writeFileSync(localCli, 'console.log("codex-cli 0.1.0");\n');
  assert.deepEqual(discovery.resolveCli(localShim), { executable: process.execPath, prefixArgs: [localCli] });
  assert.equal(discovery.probe(localShim, process.env), true);
  assert.equal(dependencies.codexVersion(localShim, process.env).version, '0.1.0');

  const globalDir = join(directory, 'npm-global');
  const globalShim = join(globalDir, 'codex.cmd');
  const globalCli = join(globalDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(join(globalDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  writeFileSync(globalShim, '@ECHO off\r\n');
  writeFileSync(globalCli, 'console.log("codex-cli 0.2.0");\n');
  assert.deepEqual(discovery.resolveCli(globalShim), { executable: process.execPath, prefixArgs: [globalCli] });
  assert.equal(dependencies.codexVersion(globalShim, process.env).version, '0.2.0');
});

test('installer execute bounded timeout and ui-helper retain operation lease until job drain is confirmed', async context => {
  const { directory, root, ambient } = fixture(context);
  const stateDir = join(directory, 'AgentOpsDeck', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, '.env'), 'PORT=8790\n', { mode: 0o600 });

  const timedResult = await dependencies.execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: process.env,
    cwd: directory,
    timeout: 40,
    killGraceMs: 40,
    verify: () => true,
  });
  assert.ok(['install-timeout', 'install-timeout-drain-required'].includes(timedResult.state));

  let released = 0;
  const fakeLifecycle = {
    acquire: async () => ({
      duplicate: false,
      server: { close() {} },
      release() { released += 1; },
    }),
  };
  const unconfirmed = await helper.dispatch('install-codex', 'INSTALL-JOB\tconfirmed\n', ambient, root, {
    platform: 'win32',
    lifecycle: fakeLifecycle,
    dependencies: {
      install: async () => ({ state: 'install-timeout-drain-required', exit: null, closed: false }),
      drainInstall: () => false,
    },
  });
  assert.deepEqual(unconfirmed, { code: 11, state: 'install-job-drain-unconfirmed-lease-retained' });
  assert.equal(released, 0);

  const drained = await helper.dispatch('install-codex', 'INSTALL-JOB\tconfirmed\n', ambient, root, {
    platform: 'win32',
    lifecycle: fakeLifecycle,
    dependencies: {
      install: async () => ({ state: 'install-timeout-drain-required', exit: null, closed: false }),
      drainInstall: () => true,
    },
  });
  assert.deepEqual(drained, { code: 12, state: 'install-timeout-drain-required' });
  assert.equal(released, 1);

  assert.match(helper.resultText({ state: 'applied' }, 'en'), /HTTP readiness confirmed/);
  assert.match(helper.resultText({ state: 'applied' }, 'zh-CN'), /HTTP 就绪已确认/);
});
