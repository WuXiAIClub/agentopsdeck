import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalConfig } from './create-local-config.mjs';

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'aod-config-create-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env.example'), 'AOD_PORT=8890\nAOD_ACCESS_KEY=\n');
  return root;
}

test('creates one private access key without changing application defaults', context => {
  const root = fixture(context);
  createLocalConfig(root);
  const file = join(root, '.env');
  assert.match(readFileSync(file, 'utf8'), /^AOD_PORT=8890\nAOD_ACCESS_KEY=[a-f0-9]{64}\n$/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('replaces duplicate empty key declarations and preserves operator settings', context => {
  const root = fixture(context);
  writeFileSync(join(root, '.env'), 'AOD_PORT=8898\nAOD_ACCESS_KEY=\nAOD_ACCESS_KEY=""\n');
  createLocalConfig(root);
  const content = readFileSync(join(root, '.env'), 'utf8');
  assert.equal(content.match(/^AOD_ACCESS_KEY=/gm)?.length, 1);
  assert.match(content, /^AOD_PORT=8898\n/);
});

test('never rotates an existing nonempty access key', context => {
  const root = fixture(context);
  const content = 'AOD_ACCESS_KEY=synthetic-existing-key\n';
  writeFileSync(join(root, '.env'), content);
  assert.throws(() => createLocalConfig(root), /ACCESS_KEY_ALREADY_CONFIGURED/);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), content);
});

test('refuses symlinked configuration without changing its target', context => {
  if (process.platform === 'win32') return context.skip('Symlink privilege is platform-dependent');
  const root = fixture(context);
  const target = join(root, 'target');
  writeFileSync(target, 'AOD_PORT=8898\n');
  symlinkSync(target, join(root, '.env'));
  assert.throws(() => createLocalConfig(root), /CONFIG_MUST_BE_REGULAR_FILE/);
  assert.equal(readFileSync(target, 'utf8'), 'AOD_PORT=8898\n');
});

test('also refuses dangling configuration symlinks', context => {
  if (process.platform === 'win32') return context.skip('Symlink privilege is platform-dependent');
  const root = fixture(context);
  symlinkSync(join(root, 'missing'), join(root, '.env'));
  assert.throws(() => createLocalConfig(root), /CONFIG_MUST_BE_REGULAR_FILE/);
});

test('refuses an existing lock without removing another generator ownership', context => {
  const root = fixture(context);
  const lock = join(root, '.env.aod-config.lock');
  writeFileSync(lock, 'synthetic-owner');
  assert.throws(() => createLocalConfig(root), /CONFIG_CREATION_LOCK_UNAVAILABLE/);
  assert.equal(readFileSync(lock, 'utf8'), 'synthetic-owner');
  assert.equal(existsSync(join(root, '.env')), false);
});

test('releases only its own lock after validation fails', context => {
  const root = fixture(context);
  writeFileSync(join(root, '.env'), 'AOD_ACCESS_KEY=synthetic-existing-key\n');
  assert.throws(() => createLocalConfig(root), /ACCESS_KEY_ALREADY_CONFIGURED/);
  assert.equal(existsSync(join(root, '.env.aod-config.lock')), false);
});

test('another process cannot generate or rotate a key while the first holds its lock', { timeout: 15_000 }, async context => {
  const root = fixture(context);
  const module = new URL('./create-local-config.mjs', import.meta.url).href;
  const ready = join(root, 'ready');
  const release = join(root, 'release');
  const code = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (String(path).endsWith('.env.example')) {
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        while (!fs.existsSync(${JSON.stringify(release)}))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const { createLocalConfig } = await import(${JSON.stringify(module)});
    createLocalConfig(${JSON.stringify(root)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal }));
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      assert.ok(Date.now() < deadline, 'Config generator did not reach the controlled barrier');
      await delay(10);
    }
    assert.throws(() => createLocalConfig(root), /CONFIG_CREATION_LOCK_UNAVAILABLE/);
    assert.equal(existsSync(join(root, '.env')), false);
    writeFileSync(release, 'release');
    assert.deepEqual(await finished, { status: 0, signal: null });
    const retained = readFileSync(join(root, '.env'), 'utf8');
    assert.throws(() => createLocalConfig(root), /ACCESS_KEY_ALREADY_CONFIGURED/);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), retained);
    assert.equal(existsSync(join(root, '.env.aod-config.lock')), false);
  } finally {
    writeFileSync(release, 'release');
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await finished;
  }
});
