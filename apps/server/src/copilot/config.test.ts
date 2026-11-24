import assert from 'node:assert/strict';
import test from 'node:test';
import { copilotConfig } from './config.js';
import { loadConfig } from '../config.js';

const env = (): NodeJS.ProcessEnv => ({ AOD_COPILOT_ENABLED: 'true', AOD_COPILOT_DEDICATED: 'true',
  AOD_COPILOT_HOME: '/private/copilot', AOD_COPILOT_SDK_DIR: '/opt/copilot-sdk',
  AOD_COPILOT_WORKSPACE: '/work/projects', AOD_COPILOT_MODEL: 'explicit-model',
  AOD_COPILOT_AUTH_MODE: 'github', AOD_COPILOT_GITHUB_TOKEN_FILE: '/credentials/copilot-key' });
const provider = (): NodeJS.ProcessEnv => ({ ...env(), AOD_COPILOT_AUTH_MODE: 'provider',
  AOD_COPILOT_GITHUB_TOKEN_FILE: undefined, AOD_COPILOT_API_KEY_FILE: '/credentials/provider-key',
  AOD_COPILOT_PROVIDER_TYPE: 'openai', AOD_COPILOT_WIRE_API: 'responses',
  AOD_COPILOT_BASE_URL: 'https://provider.invalid/v1' });

test('Copilot task tools are default-off and cannot overlap native or provider private paths', () => {
  for (const configuration of [env(), provider()]) {
    assert.equal(copilotConfig(configuration)?.boardToolsDirectory, undefined);
    assert.equal(copilotConfig({ ...configuration, AOD_COPILOT_BOARD_TOOLS_DIR: '/private/task-grants' })?.boardToolsDirectory, '/private/task-grants');
    for (const value of ['', '/', 'relative', '/private/../grants', '/work', '/work/projects/grants',
      '/private/copilot/grants', '/opt/copilot-sdk/grants', '/credentials']) {
      assert.throws(() => copilotConfig({ ...configuration, AOD_COPILOT_BOARD_TOOLS_DIR: value }));
    }
  }
});

test('Copilot configurable catalog preserves provider aliases and default without requiring GitHub auth', () => {
  assert.deepEqual(copilotConfig({ ...provider(), AOD_COPILOT_MODEL_CHOICES: 'my-alias, explicit-model' })?.modelChoices,
    ['explicit-model', 'my-alias']);
  assert.throws(() => copilotConfig({ ...provider(), AOD_COPILOT_MODEL_CHOICES: 'has space' }));
});

test('global configuration loads Copilot explicitly without reading credential contents', () => {
  assert.equal(loadConfig({}).copilot, undefined);
  assert.deepEqual(loadConfig(env()).copilot, copilotConfig(env()));
  assert.deepEqual(loadConfig(provider()).copilot, copilotConfig(provider()));
  assert.throws(() => loadConfig({ ...env(), AOD_COPILOT_DEDICATED: 'false' }));
});

test('Copilot configuration is opt-in and never adopts ambient GitHub/provider authentication', () => {
  assert.equal(copilotConfig({}), undefined);
  assert.equal(copilotConfig({ AOD_COPILOT_ENABLED: 'false', GITHUB_TOKEN: 'ambient' }), undefined);
  for (const patch of [{ AOD_COPILOT_ENABLED: 'yes' }, { AOD_COPILOT_DEDICATED: 'false' },
    { AOD_COPILOT_AUTH_MODE: undefined, GITHUB_TOKEN: 'ambient' },
    { AOD_COPILOT_GITHUB_TOKEN_FILE: undefined, GH_TOKEN: 'ambient' }]) {
    assert.throws(() => copilotConfig({ ...env(), ...patch }));
  }
  assert.equal(copilotConfig(env())?.auth.mode, 'github');
});

test('Copilot rejects ambiguous authentication and implicit provider protocol defaults', () => {
  for (const name of ['API_KEY_FILE', 'BASE_URL', 'PROVIDER_TYPE', 'WIRE_API']) {
    assert.throws(() => copilotConfig({ ...env(), [`AOD_COPILOT_${name}`]: 'unexpected' }));
  }
  for (const patch of [{ AOD_COPILOT_GITHUB_TOKEN_FILE: '/credentials/token' },
    { AOD_COPILOT_PROVIDER_TYPE: 'unknown' }, { AOD_COPILOT_WIRE_API: undefined },
    { AOD_COPILOT_WIRE_API: 'websockets' }, { AOD_COPILOT_PROVIDER_TYPE: 'anthropic' }]) {
    assert.throws(() => copilotConfig({ ...provider(), ...patch }));
  }
  assert.deepEqual(copilotConfig(provider())?.auth, { mode: 'provider', credentialFile: '/credentials/provider-key',
    providerType: 'openai', wireApi: 'responses', baseUrl: 'https://provider.invalid/v1' });
  assert.equal(copilotConfig({ ...provider(), AOD_COPILOT_PROVIDER_TYPE: 'anthropic', AOD_COPILOT_WIRE_API: undefined })?.auth.mode, 'provider');
});

test('Copilot rejects unsafe paths and credential-bearing URLs without echoing them', () => {
  for (const value of ['/', '/tmp/..', './relative', '/home/\nunsafe', '/work/projects/private', '/opt/copilot-sdk']) {
    assert.throws(() => copilotConfig({ ...env(), AOD_COPILOT_HOME: value }));
  }
  assert.throws(() => copilotConfig({ ...env(), HOME: '/private/copilot' }));
  for (const value of ['/work/projects', '/work/projects/sdk', '/work']) {
    assert.throws(() => copilotConfig({ ...env(), AOD_COPILOT_SDK_DIR: value }));
  }
  for (const value of ['/work/projects/key', '/opt/copilot-sdk/key']) {
    assert.throws(() => copilotConfig({ ...env(), AOD_COPILOT_GITHUB_TOKEN_FILE: value }));
  }
  for (const value of ['bad', 'file:///tmp/key', 'https://secret@provider.invalid',
    'https://provider.invalid?secret=key', 'https://provider.invalid#secret', 'http://127.0.0.1:4000']) {
    assert.throws(() => copilotConfig({ ...provider(), AOD_COPILOT_BASE_URL: value }), error => !String(error).includes(value));
  }
  assert.equal(copilotConfig({ ...provider(), AOD_COPILOT_BASE_URL: 'http://127.0.0.1:4000',
    AOD_COPILOT_ALLOW_HTTP: 'true' })?.auth.mode, 'provider');
});

test('Copilot model and startup timeout are explicit and bounded', () => {
  for (const model of ['', 'has space', 'x'.repeat(257)]) assert.throws(() => copilotConfig({ ...env(), AOD_COPILOT_MODEL: model }));
  for (const value of ['0', '999', '120001', 'Infinity', '1e4', ' 1000']) {
    assert.throws(() => copilotConfig({ ...env(), AOD_COPILOT_STARTUP_TIMEOUT_MS: value }));
  }
  assert.equal(copilotConfig(env())?.startupTimeoutMs, 30000);
});
