import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AOD_CODEX_DEFAULT_MODEL, AOD_CODEX_MODEL_SET_V1, AOD_MODEL_SET_V1, canonicalModelAliases } from '@agentopsdeck/shared';
import { loadConfig } from '../config.js';
import { MAX_OPENCLAW_CONFIG_BYTES, readOpenClawModels } from './openclaw-config.js';
import { openClawConfigFile, readGatewayModelSetStatus, reconcileGatewayModelSet } from './model-set.js';

const configuredAliases = ['example-provider/model-one', 'example-provider/model-two'];
const configuredModelMap = () => Object.fromEntries(configuredAliases.map(alias => [alias, {}]));

test('published model catalogs do not embed an operator-specific model policy', () => {
  assert.deepEqual(AOD_MODEL_SET_V1, []);
  assert.deepEqual(AOD_CODEX_MODEL_SET_V1, []);
  assert.deepEqual(canonicalModelAliases(), []);
  assert.equal(AOD_CODEX_DEFAULT_MODEL, '');
});

test('unconfigured model defaults remain native and the empty catalogs are immutable', () => {
  assert.equal(loadConfig({}).codex.defaultModel, '');
  assert.deepEqual(loadConfig({}).connector.modelAliases, []);
  assert.equal(Object.isFrozen(AOD_MODEL_SET_V1), true);
  assert.equal(Object.isFrozen(AOD_CODEX_MODEL_SET_V1), true);
});

test('model configuration uses captured AOD roots and preserves explicit configuration overrides', async context => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-model-roots-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'private-home'), ambient = path.join(directory, 'ambient');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(ambient, { mode: 0o700 })]);
  const file = path.join(home, 'openclaw.json'), ambientFile = path.join(ambient, 'openclaw.json');
  await writeFile(file, JSON.stringify({ agents: { defaults: { models: { 'private/model': {} } } } }));
  const original = JSON.stringify({ agents: { defaults: { models: { 'ambient/model': {} } } } });
  await writeFile(ambientFile, original);
  const config = loadConfig({ AOD_OPENCLAW_HOME: home, AOD_OPENCLAW_MODEL_ALIASES: 'private/model' });
  const previous = process.env.AOD_OPENCLAW_HOME;
  process.env.AOD_OPENCLAW_HOME = ambient;
  try {
    assert.equal(openClawConfigFile(config), file);
    assert.deepEqual((await readGatewayModelSetStatus(config)).observed, [{ alias: 'private/model' }]);
    assert.equal((await reconcileGatewayModelSet(config)).changed, false);
    assert.equal(await readFile(ambientFile, 'utf8'), original);
    assert.equal(openClawConfigFile(loadConfig({ AOD_OPENCLAW_HOME: home, AOD_OPENCLAW_CONFIG_FILE: ambientFile })), ambientFile);
    assert.equal(openClawConfigFile(loadConfig({ AOD_OPENCLAW_HOME: home, OPENCLAW_CONFIG_FILE: ambientFile })), ambientFile);
    assert.equal(openClawConfigFile(loadConfig({ AOD_DATA_DIR: directory })), path.join(directory, 'openclaw-home', 'openclaw.json'));
  } finally {
    if (previous === undefined) delete process.env.AOD_OPENCLAW_HOME; else process.env.AOD_OPENCLAW_HOME = previous;
  }
});

test('reads real OpenClaw object-map models', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-models-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'openclaw.json');
  await writeFile(configFile, JSON.stringify({ agents: { defaults: { models: { 'github-copilot/gpt-5.5': {}, 'custom/model': { provider: 'x' } } } } }));
  assert.deepEqual(await readOpenClawModels(configFile), [{ alias: 'github-copilot/gpt-5.5' }, { alias: 'custom/model' }]);
});

test('explicit reconcile adds configured models, preserves existing models/options, and creates backup', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-models-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'openclaw.json');
  await writeFile(configFile, JSON.stringify({ ownerToken: 'secret', agents: { defaults: { temperature: 1, models: { old: { provider: 'legacy' } } } }, other: true }, null, 2), { mode: 0o600 });
  await chmod(configFile, 0o600);
  const config = loadConfig({ OPENCLAW_CONFIG_FILE: configFile, AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_OPENCLAW_MODEL_ALIASES: configuredAliases.join(',') });
  const result = await reconcileGatewayModelSet(config);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.backupCreated, true);
  const parsed = JSON.parse(await readFile(configFile, 'utf8'));
  assert.deepEqual(parsed.agents.defaults.models, { ...configuredModelMap(), old: { provider: 'legacy' } });
  assert.equal(parsed.agents.defaults.temperature, 1);
  assert.equal(parsed.ownerToken, 'secret');
  assert.equal(parsed.other, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal((await stat(configFile)).mode & 0o777, 0o600);
  const backups = (await readdir(dir)).filter((name) => name.includes('.agentopsdeck-backup-'));
  assert.equal(backups.length, 1);
  assert.equal((await stat(path.join(dir, backups[0]!))).mode & 0o777, 0o600);
});

test('reconcile dry-run reports restart requirement without writing or backing up', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-models-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'openclaw.json');
  const original = JSON.stringify({ agents: { defaults: { models: { old: {} } } } }, null, 2);
  await writeFile(configFile, original);
  const result = await reconcileGatewayModelSet(loadConfig({ OPENCLAW_CONFIG_FILE: configFile, AOD_OPENCLAW_MODEL_ALIASES: 'custom/new-model' }), true);
  assert.equal(result.changed, false);
  assert.equal(result.restartRequired, true);
  assert.equal(result.backupCreated, false);
  assert.equal(await readFile(configFile, 'utf8'), original);
  const backups = (await readdir(dir)).filter((name) => name.includes('.agentopsdeck-backup-'));
  assert.equal(backups.length, 0);
});

test('unconfigured model policy observes native models without rewriting them', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-native-models-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'openclaw.json');
  const original = JSON.stringify({ agents: { defaults: { models: { 'other/vendor': { context: 8192 } } } } });
  await writeFile(file, original);
  const result = await reconcileGatewayModelSet(loadConfig({ OPENCLAW_CONFIG_FILE: file }));
  assert.equal(result.changed, false);
  assert.deepEqual(result.status.desired, []);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('reconcile is idempotent when configured object-map model set is already present', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-models-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'openclaw.json');
  await writeFile(configFile, JSON.stringify({ agents: { defaults: { models: configuredModelMap() } } }));
  const result = await reconcileGatewayModelSet(loadConfig({ OPENCLAW_CONFIG_FILE: configFile, AOD_OPENCLAW_MODEL_ALIASES: configuredAliases.join(',') }));
  assert.equal(result.changed, false);
  assert.equal(result.status.converged, true);
});

test('legacy array model shape is rejected and not rewritten', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-models-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'openclaw.json');
  const original = JSON.stringify({ agents: { defaults: { models: [{ alias: 'old' }] } } }, null, 2);
  await writeFile(configFile, original);
  const result = await reconcileGatewayModelSet(loadConfig({ OPENCLAW_CONFIG_FILE: configFile } as any));
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.status.compatible, false);
  assert.match(result.status.error ?? '', /object map/);
  assert.equal(await readFile(configFile, 'utf8'), original);
});

test('symlinked or oversized OpenClaw config paths fail closed without replacing target', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cod146-models-confinement-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const realConfig = path.join(dir, 'real.json');
  const linkConfig = path.join(dir, 'link.json');
  const original = JSON.stringify({ agents: { defaults: { models: {} } } });
  await writeFile(realConfig, original, { mode: 0o600 });
  await symlink(realConfig, linkConfig);
  const symlinkStatus = await reconcileGatewayModelSet(loadConfig({ OPENCLAW_CONFIG_FILE: linkConfig, AOD_OPENCLAW_MODEL_ALIASES: 'custom/new' }));
  assert.equal(symlinkStatus.changed, false);
  assert.equal(symlinkStatus.status.compatible, false);
  assert.match(symlinkStatus.status.error ?? '', /invalid openclaw config path/);
  assert.equal(await readFile(realConfig, 'utf8'), original);

  const largeFile = path.join(dir, 'oversized.json');
  await writeFile(largeFile, `{"pad":"${'x'.repeat(MAX_OPENCLAW_CONFIG_BYTES + 64)}","agents":{"defaults":{"models":{}}}}`);
  const largeStatus = await reconcileGatewayModelSet(loadConfig({ OPENCLAW_CONFIG_FILE: largeFile, AOD_OPENCLAW_MODEL_ALIASES: 'custom/new' }));
  assert.equal(largeStatus.changed, false);
  assert.equal(largeStatus.status.compatible, false);
  assert.match(largeStatus.status.error ?? '', /size budget/);
});
