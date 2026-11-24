import assert from 'node:assert/strict';
import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { executionEnvironment, prepareExecutionHome, verifyExecutionBinary } from './private-environment.js';

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aod-execution-env-'));
  const home = join(root, 'native'), ambient = join(root, 'ambient');
  for (const directory of [home, ambient]) mkdirSync(directory, { mode: 0o700 });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, ambient, host: { execPath: process.execPath,
    env: { HOME: ambient, USERPROFILE: ambient, PATH: '/poisoned-path', NODE_OPTIONS: 'synthetic-private-preload',
      PYTHONPATH: 'synthetic-private-python', HTTPS_PROXY: 'synthetic-private-proxy', OPENAI_API_KEY: 'synthetic-private-key' } } };
}

test('native execution environment uses an exact whitelist and independent HOME/XDG/TMP', context => {
  const setup = fixture(context);
  const env = prepareExecutionHome(setup.home, [], setup.host);
  assert.deepEqual(env, executionEnvironment(setup.home, setup.host));
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].sort());
  assert.equal(JSON.stringify(env).includes('synthetic-private'), false);
  for (const name of ['config', 'cache', 'data', 'state', 'tmp']) {
    assert.equal(fs.statSync(join(setup.home, name)).mode & 0o077, 0);
  }
});

test('native homes reject symlink roots, ancestor aliases, permissive modes and directory overlap', context => {
  const setup = fixture(context), alias = join(setup.root, 'alias');
  symlinkSync(setup.home, alias);
  assert.throws(() => prepareExecutionHome(alias, [], setup.host), /could not be verified/);
  const rootAlias = join(setup.root, 'root-alias');
  symlinkSync(setup.root, rootAlias);
  assert.throws(() => prepareExecutionHome(join(rootAlias, 'native'), [], setup.host), /could not be verified/);
  chmodSync(setup.home, 0o755);
  assert.throws(() => prepareExecutionHome(setup.home, [], setup.host), /could not be verified/);
  chmodSync(setup.home, 0o700);
  for (const excluded of [setup.home, setup.root, join(setup.home, 'workspace')]) {
    assert.throws(() => prepareExecutionHome(setup.home, [excluded], setup.host), /could not be verified/);
  }
  assert.throws(() => prepareExecutionHome(setup.ambient, [], setup.host), /could not be verified/);
  const ambientNative = join(setup.ambient, '.openclaw');
  mkdirSync(ambientNative, { mode: 0o700 });
  assert.throws(() => prepareExecutionHome(ambientNative, [], setup.host), /could not be verified/);
});

test('native homes never repair or follow a pre-existing unsafe XDG/TMP directory', context => {
  const setup = fixture(context);
  symlinkSync(setup.ambient, join(setup.home, 'tmp'));
  assert.throws(() => prepareExecutionHome(setup.home, [], setup.host), /could not be verified/);
  assert.equal(fs.lstatSync(join(setup.home, 'tmp')).isSymbolicLink(), true);
});

test('native home cannot overlap explicit ambient native directories or config files', context => {
  const setup = fixture(context);
  for (const name of ['CODEX_HOME', 'HERMES_HOME', 'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR']) {
    for (const directory of [setup.root, setup.home, join(setup.home, 'not-created')]) {
      assert.throws(() => prepareExecutionHome(setup.home, [], { ...setup.host,
        env: { ...setup.host.env, [name]: directory } }), /could not be verified/);
    }
  }
  const alias = join(setup.root, 'ambient-native-alias');
  symlinkSync(setup.home, alias);
  assert.throws(() => prepareExecutionHome(setup.home, [], { ...setup.host,
    env: { ...setup.host.env, OPENCLAW_STATE_DIR: alias } }), /could not be verified/);
  assert.throws(() => prepareExecutionHome(setup.home, [], { ...setup.host,
    env: { ...setup.host.env, OPENCLAW_CONFIG_PATH: join(setup.home, 'openclaw.json') } }), /could not be verified/);
});

test('native binary selection requires an explicit trusted executable instead of ambient resolution', context => {
  const setup = fixture(context), binary = join(setup.root, 'synthetic-binary');
  writeFileSync(binary, 'synthetic inert executable', { mode: 0o700 });
  assert.equal(verifyExecutionBinary(binary), binary);
  for (const invalid of ['synthetic-binary', `${binary}\n`, setup.home]) {
    assert.throws(() => verifyExecutionBinary(invalid), /could not be verified/);
  }
  chmodSync(binary, 0o600);
  assert.throws(() => verifyExecutionBinary(binary), /could not be verified/);
  chmodSync(binary, 0o722);
  assert.throws(() => verifyExecutionBinary(binary), /could not be verified/);
});

test('native homes reject another owner without reading native configuration', context => {
  const setup = fixture(context), original = fs.lstatSync;
  context.mock.method(fs, 'lstatSync', (directory: fs.PathLike) => {
    const info = original(directory);
    if (directory === setup.home) Object.defineProperty(info, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
    return info;
  });
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => prepareExecutionHome(setup.home, [], setup.host), /could not be verified/);
});
