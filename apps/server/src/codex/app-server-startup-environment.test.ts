import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { loadConfig } from '../config.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { windowsWorkerEnvironment } from '../connector/windows-private-worker.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { windowsCommand } from './windows-command.js';

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aod-codex-launch-env-'));
  const home = join(root, 'codex-home'), workspace = join(root, 'workspace'), ambient = join(root, 'ambient');
  for (const directory of [home, workspace, ambient]) mkdirSync(directory, { mode: 0o700 });
  const savedEnvironment = { ...process.env };
  Object.assign(process.env, { HOME: ambient, USERPROFILE: ambient, CODEX_HOME: join(ambient, '.codex'),
    NODE_OPTIONS: 'synthetic-private-preload', PYTHONPATH: 'synthetic-private-python',
    OPENAI_API_KEY: 'synthetic-private-provider', AWS_SECRET_ACCESS_KEY: 'synthetic-private-cloud',
    HTTPS_PROXY: 'synthetic-private-proxy', NO_PROXY: 'synthetic-private-host',
    XDG_CONFIG_HOME: ambient, TMPDIR: ambient, PATH: 'synthetic-private-path' });
  const users = new ConnectorUserStore(':memory:');
  const config = loadConfig({ AOD_DATA_DIR: root, AOD_CODEX_DEFAULT_CWD: workspace,
    AOD_CODEX_COMMAND: join(root, 'must-not-launch'), AOD_CODEX_ENABLED: 'true' });
  const codex = new CodexAppServer({ ...config.codex, store: new DeckStore(), turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  const children: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = [];
  const launches: Array<{ command: string; args: string[]; options: childProcess.SpawnOptions }> = [];
  context.mock.method(childProcess, 'spawn', (command: string, args: string[], options: childProcess.SpawnOptions) => {
    launches.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    children.push(child);
    return child;
  });
  const probes: NodeJS.ProcessEnv[] = [];
  context.mock.method(childProcess, 'execFile', (_command: string, _args: string[], options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string) => void) => {
    assert.equal(options.timeout, 3000);
    assert.equal(options.maxBuffer, 64 * 1024);
    probes.push(options.env!);
    callback(null, 'default_mode_request_user_input stable true');
  });
  syncBuiltinESMExports();
  const requests: string[] = [];
  runtime.request = async (method: string) => { requests.push(method); return {}; };
  runtime.notify = () => {};
  runtime.interactions = { reset() {} };
  context.after(async () => {
    for (const child of children) { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); }
    await runtime.nativeObservations.drain();
    runtime.interactions = undefined;
    await codex.close(); users.close();
    context.mock.restoreAll(); syncBuiltinESMExports();
    for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, workspace, ambient, runtime, launches, probes, requests, children };
}

test('Codex default AOD root supplies an exact isolated launch and feature-probe environment',
  { skip: process.platform === 'win32', timeout: 10000 }, async context => {
    const setup = fixture(context);
    const authentication = join(setup.home, 'auth.json'), configuration = join(setup.home, 'config.toml');
    writeFileSync(authentication, '{"synthetic":"explicit-login-fixture"}', { mode: 0o600 });
    writeFileSync(configuration, 'model_provider = "synthetic-explicit-provider"\n', { mode: 0o600 });
    await setup.runtime.start();
    assert.equal(setup.launches.length, 1);
    const launch = setup.launches[0]!;
    const expected = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
      HOME: setup.home, USERPROFILE: setup.home, CODEX_HOME: setup.home,
      XDG_CONFIG_HOME: join(setup.home, 'config'), XDG_CACHE_HOME: join(setup.home, 'cache'),
      XDG_DATA_HOME: join(setup.home, 'data'), XDG_STATE_HOME: join(setup.home, 'state'),
      TMPDIR: join(setup.home, 'tmp'), TMP: join(setup.home, 'tmp'), TEMP: join(setup.home, 'tmp'),
      NO_PROXY: 'localhost,127.0.0.1,::1' };
    assert.deepEqual(launch.options.env, expected);
    assert.deepEqual(setup.probes, [expected]);
    assert.equal(JSON.stringify(launch.options.env).includes('synthetic-private'), false);
    assert.equal(launch.command, join(setup.root, 'must-not-launch'));
    assert.equal(launch.options.cwd, setup.workspace);
    assert.equal(launch.options.detached, process.platform === 'linux');
    assert.deepEqual(launch.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(launch.args.at(-1), 'app-server');
    assert.ok(launch.args.includes('default_mode_request_user_input'));
    assert.equal(readFileSync(authentication, 'utf8'), '{"synthetic":"explicit-login-fixture"}');
    assert.equal(readFileSync(configuration, 'utf8'), 'model_provider = "synthetic-explicit-provider"\n');
    assert.deepEqual(setup.requests, ['initialize']);
    assert.equal(typeof setup.runtime.connectionId, 'string');
  });

test('Codex replacement launch still awaits physical close and gets a new exact connection identity',
  { skip: process.platform === 'win32', timeout: 10000 }, async context => {
    const setup = fixture(context);
    await setup.runtime.start();
    const firstConnection = setup.runtime.connectionId;
    const replacement = setup.runtime.start();
    await tick();
    assert.equal(setup.launches.length, 1);
    assert.equal(setup.runtime.childLifetimes.size, 1);
    setup.children[0]!.stdout.end(); setup.children[0]!.emit('close', 0, null);
    await replacement;
    assert.equal(setup.launches.length, 2);
    assert.notEqual(setup.runtime.connectionId, firstConnection);
    assert.deepEqual(setup.launches[1]!.options.env, setup.launches[0]!.options.env);
    assert.deepEqual(setup.requests, ['initialize', 'initialize']);
  });

for (const unsafe of ['missing', 'ambient', 'alias', 'permissive', 'workspace-overlap', 'temporary-alias']) {
  test(`Codex ${unsafe} home is refused before any probe or launch`,
    { skip: process.platform === 'win32', timeout: 10000 }, async context => {
      const setup = fixture(context);
      if (unsafe === 'missing') setup.runtime.options.homeDirectory = undefined;
      if (unsafe === 'ambient') setup.runtime.options.homeDirectory = setup.ambient;
      if (unsafe === 'alias') {
        const alias = join(setup.root, 'alias'); symlinkSync(setup.home, alias);
        setup.runtime.options.homeDirectory = alias;
      }
      if (unsafe === 'permissive') chmodSync(setup.home, 0o755);
      if (unsafe === 'workspace-overlap') setup.runtime.options.defaultCwd = setup.home;
      if (unsafe === 'temporary-alias') symlinkSync(setup.ambient, join(setup.home, 'tmp'));
      await assert.rejects(setup.runtime.start(), /Native execution private configuration could not be verified/);
      assert.equal(setup.launches.length, 0);
      assert.equal(setup.probes.length, 0);
      assert.equal(setup.runtime.connectionId, undefined);
      assert.equal(setup.runtime.childLifetimes.size, 0);
    });
}

test('Windows native environment retains explicit system and identity fields without provider or preload inheritance', () => {
  const host = { execPath: 'C:\\tools\\node.exe', env: { SystemRoot: 'C:\\Windows', USERNAME: 'synthetic-user',
    USERDOMAIN: 'synthetic-domain', LOGONSERVER: '\\\\synthetic-logon', HOME: 'C:\\ambient',
    USERPROFILE: 'C:\\ambient', NODE_OPTIONS: 'synthetic-private-preload', OPENAI_API_KEY: 'synthetic-private-provider',
    HTTPS_PROXY: 'synthetic-private-proxy', PATH: 'synthetic-private-path', ComSpec: 'synthetic-private-shell' } };
  const environment = windowsWorkerEnvironment('C:\\aod\\codex-home', host);
  assert.deepEqual(environment, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SYSTEMDRIVE: 'C:',
    USERNAME: 'synthetic-user', USERDOMAIN: 'synthetic-domain', LOGONSERVER: '\\\\synthetic-logon',
    HOMEDRIVE: 'C:', HOMEPATH: '\\aod\\codex-home', PATH: 'C:\\tools;C:\\Windows\\System32',
    HOME: 'C:\\aod\\codex-home', USERPROFILE: 'C:\\aod\\codex-home',
    APPDATA: 'C:\\aod\\codex-home\\config', LOCALAPPDATA: 'C:\\aod\\codex-home\\cache',
    TEMP: 'C:\\aod\\codex-home\\tmp', TMP: 'C:\\aod\\codex-home\\tmp' });
  assert.equal(JSON.stringify(environment).includes('synthetic-private'), false);
  assert.equal(host.env.HOME, 'C:\\ambient');
});

test('actual Windows IPC entry passes only the supplied native environment to its probe and native launch',
  { timeout: 10000 }, async () => {
    const home = 'C:\\aod\\codex-home';
    const environment = { ...windowsWorkerEnvironment(home, { execPath: 'C:\\tools\\node.exe',
      env: { SystemRoot: 'C:\\Windows' } }), CODEX_HOME: home, NO_PROXY: 'localhost,127.0.0.1,::1' };
    const sent: unknown[] = [], probes: NodeJS.ProcessEnv[] = [];
    const launches: Array<{ command: string; args: string[]; options: childProcess.SpawnOptions }> = [];
    const host = Object.assign(new EventEmitter(), { platform: 'win32', connected: true,
      env: { NODE_OPTIONS: 'synthetic-private-preload', OPENAI_API_KEY: 'synthetic-private-provider' },
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      send(value: unknown) { sent.push(value); }, exit() { assert.fail('Synthetic IPC launch must not exit'); } });
    const source = readFileSync(new URL('./windows-app-server-entry.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(compiled, { exports: {}, process: host, require(name: string) {
      if (name === 'node:child_process') return { spawn(command: string, args: string[], options: childProcess.SpawnOptions) {
        launches.push({ command, args, options });
        return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      } };
      if (name === './windows-command.js') return { windowsCommand };
      if (name === './interaction-capability.js') return { defaultModeQuestionFeature: 'default_mode_request_user_input',
        async probeDefaultModeQuestions(command: string, cwd: string, configuredHome: string, env: NodeJS.ProcessEnv) {
          assert.equal(command, 'C:\\tools\\codex.exe'); assert.equal(cwd, 'C:\\aod\\workspace');
          assert.equal(configuredHome, home); probes.push(env); return true;
        } };
      assert.fail(`Unexpected synthetic module: ${name}`);
    } }, { timeout: 1000 });
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ kind: 'bootstrap-ready' }]);
    assert.equal(launches.length, 0);
    host.emit('message', { kind: 'launch', command: 'C:\\tools\\codex.exe', args: ['app-server'],
      cwd: 'C:\\aod\\workspace', env: environment, questions: true });
    await tick();
    assert.deepEqual(probes, [environment]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.options.env, environment);
    assert.deepEqual(Array.from(launches[0]!.args), ['--enable', 'default_mode_request_user_input', 'app-server']);
    assert.equal(launches[0]!.options.stdio, 'pipe');
    assert.equal(JSON.stringify(launches[0]!.options.env).includes('synthetic-private'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ kind: 'bootstrap-ready' }, { kind: 'features', supported: true }]);
  });

test('Codex launch and model discovery honor private .env in AOD_CODEX_HOME and AOD_CODEX_ENV_PASSTHROUGH while refusing unsafe .env',
  { skip: process.platform === 'win32', timeout: 10000 }, async context => {
    const setup = fixture(context);
    writeFileSync(join(setup.home, '.env'), 'CUSTOM_PROVIDER_KEY="from-home-dotenv"\nOVERRIDDEN_KEY=from-home\n', { mode: 0o600 });
    setup.runtime.modelProviderEnvironment = Object.freeze({ OVERRIDDEN_KEY: 'from-passthrough', PASSTHROUGH_ONLY: 'from-env' });
    await setup.runtime.start();
    assert.equal(setup.launches.length, 1);
    const env = setup.launches[0]!.options.env!;
    assert.equal(env.CUSTOM_PROVIDER_KEY, 'from-home-dotenv');
    assert.equal(env.OVERRIDDEN_KEY, 'from-passthrough');
    assert.equal(env.PASSTHROUGH_ONLY, 'from-env');
    assert.equal(env.HOME, setup.home);
    assert.equal(env.CODEX_HOME, setup.home);

    // Permissive .env mode is refused
    chmodSync(join(setup.home, '.env'), 0o644);
    setup.children[0]!.stdout.end(); setup.children[0]!.emit('close', 0, null);
    await assert.rejects(setup.runtime.start(), /Native execution private configuration could not be verified/);

    // Forbidden variable in .env is refused
    writeFileSync(join(setup.home, '.env'), 'NODE_OPTIONS=--inspect\n', { mode: 0o600 });
    chmodSync(join(setup.home, '.env'), 0o600);
    await assert.rejects(setup.runtime.start(), /Native execution private configuration could not be verified/);
  });
