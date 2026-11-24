import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maintenanceHostConfiguration, readPrivateMaintenanceFile } from './maintenance-entry.js';

const config = { format: 1, nodeId: 'node:1', sessionKey: 'codex:history', connectorUrl: 'http://127.0.0.1:8792',
  releasesDirectory: '/synthetic/releases', activeReleaseFile: '/synthetic/settings/active.json', workDirectory: '/synthetic/work',
  backupRoots: ['/synthetic/runtime', '/synthetic/settings'], tar: '/usr/bin/tar', credentialFile: '/synthetic/settings/credential',
  tokenFile: '/synthetic/runtime/tokens.json', journalFile: '/synthetic/supervisor/journal.sqlite',
  listener: { hostname: '127.0.0.1', port: 8793 },
  service: { unit: 'synthetic.service', controlGroup: '/user.slice/synthetic.service', systemctl: '/usr/bin/systemctl' } };

test('node-local configuration is strict, private references only, and cloned before installation', () => {
  assert.deepEqual(maintenanceHostConfiguration(config), config);
  assert.equal(maintenanceHostConfiguration({ ...config, service: { ...config.service, allowDelegated: true } }).service.allowDelegated, true);
  assert.throws(() => maintenanceHostConfiguration({ ...config, service: { ...config.service, allowDelegated: 'yes' } }));
  const parsed = maintenanceHostConfiguration(config);
  parsed.backupRoots = ['/changed'];
  assert.equal(config.backupRoots[0], '/synthetic/runtime');
  const prepare = { executable: '/usr/bin/node', args: ['/synthetic/builder.mjs'],
    systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' };
  assert.deepEqual(maintenanceHostConfiguration({ ...config, prepare }).prepare, prepare);
  assert.throws(() => maintenanceHostConfiguration({ ...config, prepare: { ...prepare, systemdRun: 'systemd-run' } }));
  assert.throws(() => maintenanceHostConfiguration({ ...config, prepare, runPreparation: 'override' }));
  for (const patch of [{ shell: 'restart' }, { token: 'synthetic-secret' }, { tokenFile: '/synthetic/releases/token' },
    { stoppedRecovery: { databaseFile: '/synthetic/runtime/connector.sqlite' } },
    { tokenFile: '/not-backed-up/token' }, { journalFile: 'relative' }, { listener: { ...config.listener, port: 0 } },
    { service: { ...config.service, restart: 'shell' } }, { prepare: { executable: 'node', args: [] } },
    { prepare: { executable: '/usr/bin/node', args: ['arg\nsecret'] } }]) {
    assert.throws(() => maintenanceHostConfiguration({ ...config, ...patch }), /unavailable/);
  }
});

test('private configuration rejects symlink, public mode, oversize and redirected ancestor without disclosure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.json');
  writeFileSync(file, '{"synthetic":true}', { mode: 0o600 });
  assert.equal(await readPrivateMaintenanceFile(file), '{"synthetic":true}');
  symlinkSync(file, join(root, 'link'));
  await assert.rejects(readPrivateMaintenanceFile(join(root, 'link')));
  chmodSync(file, 0o644);
  await assert.rejects(readPrivateMaintenanceFile(file), /unavailable/);
  chmodSync(file, 0o600); writeFileSync(file, 'x'.repeat(65537));
  await assert.rejects(readPrivateMaintenanceFile(file), /unavailable/);
  mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'redirected'));
  writeFileSync(join(root, 'real/config'), 'private', { mode: 0o600 });
  await assert.rejects(readPrivateMaintenanceFile(join(root, 'redirected/config')), /unavailable/);
});
