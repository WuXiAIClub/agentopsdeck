import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatBuildNumber } from './write-build-info.mjs';

test('build numbers use the Beijing date and floor the hour into two-hour buckets', () => {
  for (const [time, expected] of [
    ['2026-10-09T13:21:00+08:00', '26.10096'],
    ['2026-10-09T12:00:00+08:00', '26.10096'],
    ['2026-10-09T13:59:59+08:00', '26.10096'],
    ['2026-10-09T14:00:00+08:00', '26.10097'],
    ['2026-01-02T00:00:00+08:00', '26.01020'],
    ['2026-01-02T01:59:59+08:00', '26.01020'],
    ['2026-01-02T20:00:00+08:00', '26.010210'],
    ['2026-12-31T23:59:59+08:00', '26.123111'],
    ['2026-12-31T16:00:00Z', '27.01010'],
    ['2026-10-31T16:00:00Z', '26.11010'],
  ]) assert.equal(formatBuildNumber(new Date(time)), expected, time);
  assert.throws(() => formatBuildNumber(new Date(NaN)), RangeError);
});

test('build provenance identifies clean/dirty Git trees and never borrows an archive parent revision', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'agentopsdeck-build-info-'));
  try {
    const prepare = async root => {
      await mkdir(join(root, 'scripts'), { recursive: true });
      await mkdir(join(root, 'packages/shared/src'), { recursive: true });
      await copyFile(new URL('./write-build-info.mjs', import.meta.url), join(root, 'scripts/write-build-info.mjs'));
    };
    const build = async root => {
      const started = Date.now();
      execFileSync(process.execPath, ['scripts/write-build-info.mjs'], { cwd: root, env: { ...process.env, TZ: 'America/Los_Angeles' } });
      const text = await readFile(join(root, 'packages/shared/src/build-info.generated.ts'), 'utf8');
      const { buildNumber, builtAt, ...provenance } = JSON.parse(text.match(/= (.*) as const/)[1]);
      assert.ok(Date.parse(builtAt) >= started && Date.parse(builtAt) <= Date.now());
      assert.equal(buildNumber, formatBuildNumber(new Date(builtAt)));
      return provenance;
    };
    await prepare(temp);
    assert.deepEqual(await build(temp), { revision: 'unknown', dirty: false });
    const git = (...args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init');
    await writeFile(join(temp, '.gitignore'), 'packages/shared/src/build-info.generated.ts\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    assert.deepEqual(await build(temp), { revision: git('rev-parse', 'HEAD'), dirty: false });
    await writeFile(join(temp, 'untracked'), 'fixture');
    assert.equal((await build(temp)).dirty, true);
    const archive = join(temp, 'archive'); await prepare(archive);
    assert.deepEqual(await build(archive), { revision: 'unknown', dirty: false });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('syncWorkspaceVersion automatically aligns protocol.ts and workspace package.json versions to the latest semver', async () => {
  const { syncWorkspaceVersion } = await import('./write-build-info.mjs');
  const temp = await mkdtemp(join(tmpdir(), 'agentopsdeck-version-sync-'));
  try {
    await mkdir(join(temp, 'apps/server'), { recursive: true });
    await mkdir(join(temp, 'apps/web'), { recursive: true });
    await mkdir(join(temp, 'packages/shared/src'), { recursive: true });
    await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'agentopsdeck', version: '2.4.7' }, null, 2) + '\n');
    await writeFile(join(temp, 'apps/server/package.json'), JSON.stringify({ name: '@agentopsdeck/server', version: '2.4.3' }, null, 2) + '\n');
    await writeFile(join(temp, 'apps/web/package.json'), JSON.stringify({ name: '@agentopsdeck/web', version: '2.4.6' }, null, 2) + '\n');
    await writeFile(join(temp, 'packages/shared/package.json'), JSON.stringify({ name: '@agentopsdeck/shared', version: '2.4.6' }, null, 2) + '\n');
    await writeFile(join(temp, 'packages/shared/src/protocol.ts'), "export const AGENTOPSDECK_VERSION = '2.3.8';\n");

    const resolved = syncWorkspaceVersion(temp);
    assert.equal(resolved, '2.4.7');
    assert.equal(JSON.parse(await readFile(join(temp, 'apps/server/package.json'), 'utf8')).version, '2.4.7');
    assert.equal(JSON.parse(await readFile(join(temp, 'apps/web/package.json'), 'utf8')).version, '2.4.7');
    assert.equal(JSON.parse(await readFile(join(temp, 'packages/shared/package.json'), 'utf8')).version, '2.4.7');
    assert.match(await readFile(join(temp, 'packages/shared/src/protocol.ts'), 'utf8'), /AGENTOPSDECK_VERSION = '2\.4\.7'/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('normal builds never rewrite product versions from higher Git tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aod-build-version-boundary-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(new URL('./write-build-info.mjs', import.meta.url), join(root, 'scripts/write-build-info.mjs'));
    const manifests = ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json'];
    await mkdir(join(root, 'packages/shared/src'), { recursive: true });
    for (const path of manifests) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), JSON.stringify({ version: '1.0.0' }) + '\n');
    }
    const protocol = 'packages/shared/src/protocol.ts';
    await writeFile(join(root, protocol), "export const AGENTOPSDECK_VERSION = '1.0.0';\n");
    const paths = [...manifests, protocol];
    const originals = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    git('tag', 'v9.9.9');
    execFileSync(process.execPath, ['scripts/write-build-info.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8'))), originals);
    assert.ok((await readFile(join(root, 'packages/shared/src/build-info.generated.ts'), 'utf8')).includes('AGENTOPSDECK_BUILD'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
