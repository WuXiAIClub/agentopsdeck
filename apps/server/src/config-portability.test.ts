import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentOpsDeckDataDirectory, loadConfig } from './config.js';

test('native model and compaction choices are not tied to one installation', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.codex.defaultModel, '');
  assert.equal(defaults.codex.autoCompactTokenLimit, undefined);
  assert.equal(defaults.codex.disableRemoteCompaction, false);
  const configured = loadConfig({ AOD_CODEX_DEFAULT_MODEL: 'my-provider-model', AOD_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '100000', AOD_CODEX_DISABLE_REMOTE_COMPACTION: 'true' });
  assert.equal(configured.codex.defaultModel, 'my-provider-model');
  assert.equal(configured.codex.autoCompactTokenLimit, 100000);
  assert.equal(configured.codex.disableRemoteCompaction, true);
  assert.throws(() => loadConfig({ AOD_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '-1' }), /positive integer/);
});

test('explicit artifact roots never silently grant native-home direct-child access', () => {
  const env = { HOME: '/synthetic-home', AOD_ARTIFACT_ALLOWED_DIRS: '/srv/artifacts' };
  assert.deepEqual(loadConfig(env).artifactReceiver.allowedDirs, ['/srv/artifacts']);
  assert.deepEqual(loadConfig(env).artifactReceiver.allowedDirectChildDirs, []);
  assert.deepEqual(loadConfig({ ...env, AOD_ARTIFACT_ALLOWED_DIRECT_CHILD_DIRS: '' }).artifactReceiver.allowedDirectChildDirs, []);
  assert.deepEqual(loadConfig({ ...env, AOD_ARTIFACT_ALLOWED_DIRS: '' }).artifactReceiver.allowedDirs, []);
  assert.deepEqual(loadConfig({ ...env, AOD_ARTIFACT_ALLOWED_DIRECT_CHILD_DIRS: '/srv/one, /srv/two' }).artifactReceiver.allowedDirectChildDirs, ['/srv/one', '/srv/two']);
  assert.deepEqual(loadConfig({ HOME: '/synthetic-home' }).artifactReceiver.allowedDirectChildDirs, [join(agentOpsDeckDataDirectory({ HOME: '/synthetic-home' }), 'openclaw-home')]);
});

test('native defaults use portable home/temp directories and a configured native root', context => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-portable-config-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workspace'));
  mkdirSync(join(root, 'workspace-example'));
  const config = loadConfig({ USERPROFILE: join(root, 'profile'), AOD_OPENCLAW_HOME: root });
  assert.deepEqual(config.mediaBridge.allowedDirs, [tmpdir(), join(root, 'media', 'outbound')]);
  assert.deepEqual(config.artifactReceiver.allowedDirectChildDirs, [root]);
  for (const directory of [tmpdir(), join(root, 'media'), join(root, 'workspace'), join(root, 'workspace-example')]) {
    assert.ok(config.artifactReceiver.allowedDirs.includes(directory), directory);
  }
  const profile = loadConfig({ USERPROFILE: join(root, 'profile') });
  assert.deepEqual(profile.artifactReceiver.allowedDirectChildDirs, [join(agentOpsDeckDataDirectory({ USERPROFILE: join(root, 'profile') }), 'openclaw-home')]);
  assert.deepEqual(loadConfig({ HOME: root, USERPROFILE: join(root, 'profile') }).artifactReceiver.allowedDirectChildDirs, [join(agentOpsDeckDataDirectory({ HOME: root }), 'openclaw-home')]);
  assert.deepEqual(loadConfig({}).artifactReceiver.allowedDirectChildDirs, [join(agentOpsDeckDataDirectory({}), 'openclaw-home')]);
});

test('portable defaults never widen explicitly configured artifact or media boundaries', () => {
  const env = { AOD_OPENCLAW_HOME: '/native', USERPROFILE: '/profile',
    AOD_ARTIFACT_ALLOWED_DIRS: '', AOD_MEDIA_BRIDGE_ALLOWED_DIRS: '' };
  assert.deepEqual(loadConfig(env).artifactReceiver.allowedDirs, []);
  assert.deepEqual(loadConfig(env).artifactReceiver.allowedDirectChildDirs, []);
  assert.deepEqual(loadConfig(env).mediaBridge.allowedDirs, []);
  const config = loadConfig({ ...env, AOD_ARTIFACT_ALLOWED_DIRS: '/deliverables', AOD_MEDIA_BRIDGE_ALLOWED_DIRS: '/media' });
  assert.deepEqual(config.artifactReceiver.allowedDirs, ['/deliverables']);
  assert.deepEqual(config.artifactReceiver.allowedDirectChildDirs, []);
  assert.deepEqual(config.mediaBridge.allowedDirs, ['/media']);
});
