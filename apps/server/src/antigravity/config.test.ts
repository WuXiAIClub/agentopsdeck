import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityConfig } from './config.js';
import { antigravityEnvironment } from './environment.js';

const valid = (): NodeJS.ProcessEnv => ({
  AOD_ANTIGRAVITY_ENABLED: 'true', AOD_ANTIGRAVITY_DEDICATED: 'true',
  AOD_ANTIGRAVITY_COMMAND: '/opt/agy/bin/agy', AOD_ANTIGRAVITY_HOME: '/srv/aod/antigravity-home',
  AOD_ANTIGRAVITY_WORKSPACE: '/srv/aod/workspace', HOME: '/home/operator',
});

test('Antigravity is strictly opt-in and requires dedicated paths', () => {
  assert.equal(antigravityConfig({}), undefined);
  assert.equal(antigravityConfig({ AOD_ANTIGRAVITY_ENABLED: 'false' }), undefined);
  for (const enabled of ['1', 'yes', 'TRUE']) assert.throws(() => antigravityConfig({ AOD_ANTIGRAVITY_ENABLED: enabled }));
  assert.throws(() => antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_DEDICATED: 'false' }));
  assert.equal(antigravityConfig(valid())?.startupTimeoutMs, 30000);
});

test('Antigravity rejects overlapping homes, workspace, executable and runtime', () => {
  for (const home of ['/', 'relative', '/srv/aod/../other', '/srv/aod/home\n', '/home/operator', '/srv/aod/workspace/home', '/opt/agy']) {
    assert.throws(() => antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_HOME: home }));
  }
  for (const variable of ['AOD_RUNTIME_DIR', 'AOD_CODEX_HOME', 'AOD_CLAUDE_HOME', 'AOD_COPILOT_HOME', 'AOD_HERMES_HOME']) {
    assert.throws(() => antigravityConfig({ ...valid(), [variable]: '/srv/aod/antigravity-home/nested' }));
  }
  assert.ok(antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_HOME: '/home/operator/aod-antigravity' }));
});

test('Antigravity validates startup bounds without printing supplied values', () => {
  for (const timeout of ['0', '999', '120001', 'Infinity', '1e4', '-1000', 'synthetic-private-value']) {
    assert.throws(() => antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_STARTUP_TIMEOUT_MS: timeout }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'AOD_ANTIGRAVITY_STARTUP_TIMEOUT_MS must be between 1000 and 120000');
      return true;
    });
  }
  assert.equal(antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_STARTUP_TIMEOUT_MS: '120000' })?.startupTimeoutMs, 120000);
  assert.equal(antigravityConfig(valid())?.compactTimeoutMs, 600000);
  assert.equal(antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_COMPACT_TIMEOUT_MS: '180000' })?.compactTimeoutMs, 180000);
  assert.throws(() => antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_COMPACT_TIMEOUT_MS: '500' }),
    /AOD_ANTIGRAVITY_COMPACT_TIMEOUT_MS must be between 1000 and 1800000/);
  assert.equal(antigravityConfig(valid())?.permissionMode, 'allow');
  assert.equal(antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_PERMISSION_MODE: 'deny' })?.permissionMode, 'deny');
  assert.throws(() => antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_PERMISSION_MODE: 'invalid' }),
    /AOD_ANTIGRAVITY_PERMISSION_MODE must be allow or deny/);
  const withDefaultOnly = antigravityConfig({
    ...valid(),
    AOD_ANTIGRAVITY_MODEL: 'gemini-4-neon-high',
  });
  assert.equal(withDefaultOnly?.model, 'gemini-4-neon-high');
  assert.equal(withDefaultOnly?.modelChoices, undefined);
  const withModels = antigravityConfig({
    ...valid(),
    AOD_ANTIGRAVITY_MODEL: 'gemini-4-neon-high',
    AOD_ANTIGRAVITY_MODEL_CHOICES: 'gemini-4-neon-high,gemini-4-neon-xhigh,gemini-4-hydrogen-high',
  });
  assert.equal(withModels?.model, 'gemini-4-neon-high');
  assert.deepEqual(withModels?.modelChoices, ['gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-hydrogen-high']);
  assert.throws(() => antigravityConfig({ ...valid(), AOD_ANTIGRAVITY_MODEL: 'bad model' }),
    /AOD_ANTIGRAVITY_MODEL must be a valid model identifier/);
});

test('Antigravity environment does not inherit host authentication or settings', { skip: process.platform !== 'linux' }, () => {
  const config = antigravityConfig(valid())!;
  const env = antigravityEnvironment(config);
  assert.equal(env.HOME, config.homeDirectory);
  assert.equal(env.XDG_CONFIG_HOME, `${config.homeDirectory}/config`);
  assert.equal(env.TMPDIR, `${config.homeDirectory}/tmp`);
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'NODE_OPTIONS',
    'GEMINI_CLI_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AOD_ACCESS_KEY', 'HTTP_PROXY', 'USERPROFILE']) {
    assert.equal(env[name], undefined);
  }
});
