import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AGENTOPSDECK_VERSION } from '@agentopsdeck/shared';
import { ACCESS_COOKIE_NAME } from './auth/access-key.js';
import { agentOpsDeckDataDirectory, loadConfig, nativeHome } from './config.js';

test('native file roots snapshot only centrally configured AOD paths', () => {
  const env = { AOD_DATA_DIR: '/synthetic/aod', AOD_OPENCLAW_CONFIG_FILE: '/synthetic/config/workspaces.json',
    OPENCLAW_CONFIG_FILE: '/synthetic/other/config.json' };
  const roots = loadConfig(env).nativeFileRoots!;
  assert.deepEqual(roots, { home: '/synthetic/aod/openclaw-home', configFile: '/synthetic/config/workspaces.json', configRequired: true });
  assert.equal(Object.isFrozen(roots), true);
  env.AOD_OPENCLAW_CONFIG_FILE = '/synthetic/replaced.json';
  assert.equal(roots.configFile, '/synthetic/config/workspaces.json');
  assert.equal(loadConfig({ AOD_DATA_DIR: '/synthetic/aod', OPENCLAW_CONFIG_FILE: '/other' }).nativeFileRoots!.configRequired, false);
});

test('non-loopback binding requires an AOD key, including empty and inherited keys', () => {
  for (const host of ['0.0.0.0', '192.0.2.1', '::', '2001:db8::1', '::ffff:127.0.0.1']) {
    for (const key of [undefined, '', '   ']) {
      assert.throws(() => loadConfig({ AOD_LISTEN_HOST: host, AOD_ACCESS_KEY: key,
        AGENTOPSDECK_ACCESS_KEY: 'synthetic-inherited' }), /requires AOD_ACCESS_KEY/);
    }
    assert.equal(loadConfig({ AOD_LISTEN_HOST: host, AOD_ACCESS_KEY: 'synthetic-current-key' }).listenHost, host);
  }
});

test('all IPv4 loopback addresses and canonical IPv6 loopback retain local open mode', () => {
  for (const host of ['127.0.0.1', '127.2.3.4', '::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(loadConfig({ AOD_LISTEN_HOST: host }).accessKey, undefined);
  }
});

test('central native home stays in the configured AOD instance without inherited native settings', () => {
  assert.equal(nativeHome({ HOME: '/synthetic-home', AOD_DATA_DIR: '/srv/aod-fixture', OPENCLAW_HOME: '/srv/unrelated' }),
    '/srv/aod-fixture/openclaw-home');
  assert.equal(nativeHome({ AOD_OPENCLAW_HOME: '/srv/aod-explicit' }), '/srv/aod-explicit');
});

test('AOD uses isolated ports, data, native homes and disabled execution by default', () => {
  const config = loadConfig({ HOME: '/synthetic-home', AOD_DATA_DIR: '/srv/aod-fixture' });
  assert.equal(config.inboundMediaDir, '/srv/aod-fixture/media/inbound');
  assert.notEqual(loadConfig({ OPENCLAW_HOME: '/srv/unrelated', INBOUND_MEDIA_DIR: '/srv/unrelated/media' }).inboundMediaDir,
    '/srv/unrelated/media');
  assert.equal(config.port, 8890);
  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.codex.enabled, false);
  assert.equal(config.localOpenClawCli, false);
  assert.equal(config.connector.updateEnabled, false);
  assert.equal(config.codex.homeDirectory, '/srv/aod-fixture/codex-home');
  assert.equal(config.codex.defaultCwd, '/srv/aod-fixture/workspace');
  for (const file of [config.sessionTitlesFile, config.queueFile, config.authSessionsFile, config.hub.databaseFile,
    config.connector.tokenFile, config.connector.usersDatabaseFile, config.codex.queueFile, config.codex.runtimeOverridesFile]) {
    assert.ok(file.startsWith('/srv/aod-fixture/.agentopsdeck-'), file);
  }
  assert.equal(ACCESS_COOKIE_NAME, 'agentopsdeck_access');
  assert.equal(AGENTOPSDECK_VERSION, '1.0.0');
});

test('AOD ignores inherited AgentOpsDeck and native gateway app credentials', () => {
  const config = loadConfig({ AGENTOPSDECK_ACCESS_KEY: 'synthetic-other-instance', AGENTOPSDECK_HUB_DATABASE_FILE: '/srv/other/db.sqlite',
    AGENTOPSDECK_CODEX_HOME: '/srv/other/native', OPENCLAW_GATEWAY_OWNER_TOKEN: 'synthetic-native-token',
    OPENCLAW_GATEWAY_WS_URL: 'ws://other.invalid', CODEX_HOME: '/srv/other/native' });
  assert.equal(config.accessKey, undefined);
  assert.equal(config.gatewayWsUrl, undefined);
  assert.equal(config.ownerToken, undefined);
  assert.notEqual(config.hub.databaseFile, '/srv/other/db.sqlite');
  assert.notEqual(config.codex.homeDirectory, '/srv/other/native');
});

test('explicit AOD values win without enabling unrequested adapters', () => {
  const config = loadConfig({ AOD_PORT: '8898', PORT: '8790', AOD_LISTEN_HOST: '::1', AOD_DATA_DIR: '/srv/aod',
    AOD_CODEX_ENABLED: 'true', AOD_CODEX_HOME: '/srv/aod/codex-private', AOD_CODEX_DEFAULT_CWD: '/srv/aod/project',
    AOD_ACCESS_KEY: 'synthetic-aod-key', AOD_HUB_DATABASE_FILE: '/srv/aod/private/hub.sqlite' });
  assert.equal(config.port, 8898);
  assert.equal(config.listenHost, '::1');
  assert.equal(config.codex.enabled, true);
  assert.equal(config.codex.homeDirectory, '/srv/aod/codex-private');
  assert.equal(config.accessKey, 'synthetic-aod-key');
  assert.equal(config.hub.databaseFile, '/srv/aod/private/hub.sqlite');
  assert.equal(config.localOpenClawCli, false);
});

test('data directory honors platform-independent XDG and rejects unsafe overrides', () => {
  assert.equal(agentOpsDeckDataDirectory({ XDG_DATA_HOME: '/srv/xdg' }), '/srv/xdg/agentopsdeck');
  for (const value of ['relative/path', '/', '/srv/unsafe\0value']) {
    assert.throws(() => loadConfig({ AOD_DATA_DIR: value }), /AOD_DATA_DIR/);
  }
});

function configChild(directory: string, extra: NodeJS.ProcessEnv, assertion: string) {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const config = new URL('./config.ts', import.meta.url).href;
  return spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import {loadConfig} from ${JSON.stringify(config)}; ${assertion}`], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, ...extra }, encoding: 'utf8', timeout: 30_000,
  });
}

test('automatic dotenv lookup never imports an unrelated parent configuration', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-config-boundary-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const child = join(root, 'child');
  mkdirSync(child);
  writeFileSync(join(root, '.env'), 'AOD_ACCESS_KEY=synthetic-parent-key\nAOD_CODEX_ENABLED=true\n');
  const result = configChild(child, {}, 'const config = loadConfig(); assert.equal(config.accessKey, undefined); assert.equal(config.codex.enabled, false);');
  assert.equal(result.status, 0, 'isolated dotenv child assertions must pass');
});

test('explicit external config is honored and missing explicit config fails closed', context => {
  const root = mkdtempSync(join(tmpdir(), 'aod-external-config-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'private.env');
  writeFileSync(file, 'AOD_PORT=8898\nAOD_CODEX_ENABLED=false\n');
  assert.equal(configChild(root, { AOD_CONFIG_FILE: file }, 'assert.equal(loadConfig().port, 8898);').status, 0);
  assert.equal(configChild(root, { AOD_CONFIG_FILE: file, AOD_PORT: '8899' }, 'assert.equal(loadConfig().port, 8899);').status, 0);
  assert.equal(configChild(root, { AOD_CONFIG_FILE: join(root, 'missing.env') }, 'assert.throws(() => loadConfig(), /does not exist/);').status, 0);
});
