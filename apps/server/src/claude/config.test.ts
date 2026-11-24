import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeConfig, pathsOverlap } from './config.js';
import { loadConfig } from '../config.js';

const env = () => ({ AOD_CLAUDE_ENABLED: 'true', AOD_CLAUDE_DEDICATED: 'true',
  AOD_CLAUDE_HOME: '/private/claude', AOD_CLAUDE_SDK_DIR: '/opt/pinned-sdk',
  AOD_CLAUDE_WORKSPACE: '/work/projects', AOD_CLAUDE_API_KEY_FILE: '/credentials/claude-key',
  AOD_CLAUDE_MODEL: 'explicit-model' });

test('global configuration preserves opt-in Claude config without reading credential contents', () => {
  assert.equal(loadConfig({}).claude, undefined);
  assert.deepEqual(loadConfig(env()).claude, claudeConfig(env()));
  assert.throws(() => loadConfig({ ...env(), AOD_CLAUDE_DEDICATED: 'false' }));
});

test('Claude opt-in configuration has no effects when disabled and rejects mistyped enablement', () => {
  assert.equal(claudeConfig({}), undefined);
  assert.equal(claudeConfig({ AOD_CLAUDE_ENABLED: 'false' }), undefined);
  assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_ENABLED: 'yes' }));
  assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_DEDICATED: 'false' }));
  assert.equal(claudeConfig(env())?.model, 'explicit-model');
});

test('Claude rejects root/relative paths, overlapping roots and inherited home', () => {
  for (const value of ['/', '/tmp/..', './data', '/private/\nsecret']) {
    assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_HOME: value }));
  }
  assert.equal(pathsOverlap('/work', '/workspace'), false);
  assert.equal(pathsOverlap('/work', '/work/nested'), true);
  for (const patch of [
    { AOD_CLAUDE_HOME: '/work/projects/private' },
    { AOD_CLAUDE_SDK_DIR: '/private/claude/sdk' },
    { AOD_CLAUDE_SDK_DIR: '/work/projects' },
    { AOD_CLAUDE_SDK_DIR: '/work/projects/sdk' },
    { AOD_CLAUDE_SDK_DIR: '/work' },
    { AOD_CLAUDE_API_KEY_FILE: '/work/projects/key' },
    { AOD_CLAUDE_API_KEY_FILE: '/opt/pinned-sdk/key' },
    { HOME: '/private/claude' },
  ]) assert.throws(() => claudeConfig({ ...env(), ...patch }));
});

test('Claude provider URL cannot embed credentials and HTTP requires explicit local consent', () => {
  for (const value of ['invalid', 'file:///tmp/provider', 'https://user:private@example.test',
    'https://example.test?key=private', 'https://example.test#private', 'http://127.0.0.1:4000']) {
    assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_BASE_URL: value }), error => !String(error).includes('private@example'));
  }
  assert.equal(claudeConfig({ ...env(), AOD_CLAUDE_BASE_URL: 'http://127.0.0.1:4000', AOD_CLAUDE_ALLOW_HTTP: 'true' })?.baseUrl,
    'http://127.0.0.1:4000');
});

test('Claude requires an explicit model and bounded startup deadline', () => {
  for (const model of ['', 'has space', 'x'.repeat(257)]) assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_MODEL: model }));
  for (const deadline of ['0', '999', '120001', 'Infinity', '1e4', ' 1000']) {
    assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_STARTUP_TIMEOUT_MS: deadline }));
  }
  assert.equal(claudeConfig({ ...env(), AOD_CLAUDE_STARTUP_TIMEOUT_MS: '1000' })?.startupTimeoutMs, 1000);
});

test('Claude configurable catalog includes default and rejects malformed operator choices', () => {
  assert.deepEqual(claudeConfig({ ...env(), AOD_CLAUDE_MODEL_CHOICES: 'alternate, explicit-model, alternate' })?.modelChoices,
    ['explicit-model', 'alternate']);
  assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_MODEL_CHOICES: 'alternate,,other' }));
});

test('Claude file tools require explicit local policy and reject permission bypass modes', () => {
  assert.equal(claudeConfig(env())?.toolPolicy, 'none');
  for (const value of ['workspace-read', 'workspace-edit']) {
    assert.equal(claudeConfig({ ...env(), AOD_CLAUDE_TOOL_POLICY: value })?.toolPolicy, value);
  }
  for (const value of ['all', 'bypassPermissions', '', 'Bash']) {
    assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_TOOL_POLICY: value }));
  }
});

test('Claude task tools are default-off and require a private non-overlapping directory', () => {
  assert.equal(claudeConfig(env())?.boardToolsDirectory, undefined);
  assert.equal(claudeConfig({ ...env(), AOD_CLAUDE_BOARD_TOOLS_DIR: '/private/task-grants' })?.boardToolsDirectory, '/private/task-grants');
  for (const value of ['', '/', 'relative', '/private/../grants', '/work', '/work/projects/grants',
    '/private/claude/grants', '/opt/pinned-sdk/grants', '/credentials', '/credentials/claude-key']) {
    assert.throws(() => claudeConfig({ ...env(), AOD_CLAUDE_BOARD_TOOLS_DIR: value }));
  }
});

test('Claude rejects the personal USERPROFILE and invalid explicit Git Bash locations', () => {
  const config = env();
  assert.throws(() => claudeConfig({ ...config, USERPROFILE: config.AOD_CLAUDE_HOME }));
  assert.equal(claudeConfig({ ...config, USERPROFILE: '/private', AOD_CLAUDE_GIT_BASH_PATH: '/opt/git/bash.exe' })?.gitBashPath, '/opt/git/bash.exe');
  for (const value of ['', '/', 'relative', '/opt/git/bash.exe\n']) {
    assert.throws(() => claudeConfig({ ...config, AOD_CLAUDE_GIT_BASH_PATH: value }));
  }
});
