import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stageCandidateRelease, verifyCandidateRelease } from './stage-candidate-release.mjs';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-stage-candidate-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source'), destination = join(directory, 'candidate');
  const put = (file, content) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  const metadata = (file, value) => put(file, JSON.stringify(value));
  metadata('apps/server/package.json', { name: '@agentopsdeck/server', type: 'module', dependencies: { '@agentopsdeck/shared': 'workspace:*', 'runtime-primary': '1.0.0' } });
  put('apps/server/dist/index.js', "export { result } from './application.js';\n");
  put('apps/server/dist/application.js', "import { value } from 'runtime-primary'; import { shared } from '@agentopsdeck/shared'; export const result = value + shared;\n");
  put('apps/server/dist/unused.test.js', "throw new Error('not runtime');\n");
  put('apps/web/dist/index.html', '<!doctype html><title>Synthetic candidate</title>');
  metadata('packages/shared/package.json', { name: '@agentopsdeck/shared', version: '1.0.0', type: 'module', main: 'dist/index.js' });
  put('packages/shared/dist/index.js', 'export const shared = 2;\n');
  put('packages/shared/.env', 'synthetic-not-for-release');
  metadata('node_modules/runtime-primary/package.json', { name: 'runtime-primary', version: '1.0.0', type: 'module', exports: './index.js',
    dependencies: { 'runtime-secondary': '1.0.0' }, devDependencies: { 'missing-development-only': '*' } });
  put('node_modules/runtime-primary/index.js', "import { value } from 'runtime-secondary'; export { value };\n");
  metadata('node_modules/runtime-secondary/package.json', { name: 'runtime-secondary', version: '1.0.0', type: 'module', exports: './index.js' });
  put('node_modules/runtime-secondary/index.js', 'export const value = 40;\n');
  mkdirSync(join(root, 'apps/server/node_modules/@agentopsdeck'), { recursive: true });
  symlinkSync(join(root, 'packages/shared'), join(root, 'apps/server/node_modules/@agentopsdeck/shared'));
  put('.env', 'synthetic-private-configuration');
  put('data/never-copy.txt', 'synthetic-private-state');
  return { directory, root, destination, put, metadata };
}

test('staging copies only built assets and installed runtime closure and runs after the source is removed', async context => {
  const setup = fixture(context);
  const result = await stageCandidateRelease(setup);
  assert.equal(result.packages, 3);
  assert.equal((await verifyCandidateRelease(setup.destination)).manifestSha256, result.manifestSha256);
  const manifest = JSON.parse(readFileSync(join(setup.destination, 'candidate-manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'staged-unverified');
  assert.equal(result.manifestSha256, createHash('sha256').update(readFileSync(join(setup.destination, 'candidate-manifest.json'))).digest('hex'));
  for (const file of manifest.files) {
    const content = readFileSync(join(setup.destination, file.path));
    assert.equal(content.length, file.bytes);
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256);
    assert.equal(lstatSync(join(setup.destination, file.path)).nlink, 1);
    assert.doesNotMatch(file.path, /\.env|unused\.test|never-copy|missing-development-only/);
  }
  const verifyTree = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) verifyTree(join(directory, entry.name));
    }
  };
  verifyTree(setup.destination);
  rmSync(setup.root, { recursive: true });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { result } from './apps/server/dist/index.js'; if (result !== 42) throw new Error('wrong closure');"],
  { cwd: setup.destination, env: { HOME: setup.directory, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
});

test('staging refuses to overwrite an existing destination or stage inside source', async context => {
  const setup = fixture(context);
  mkdirSync(setup.destination);
  const sentinel = join(setup.destination, 'keep'); writeFileSync(sentinel, 'unchanged');
  await assert.rejects(stageCandidateRelease(setup), /EEXIST/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  await assert.rejects(stageCandidateRelease({ ...setup, destination: join(setup.root, 'candidate') }), /outside the source/);
  await assert.rejects(stageCandidateRelease({ ...setup, destination: 'relative' }), /absolute/);
});

for (const boundary of ['dependency', 'built-file', 'built-directory']) {
  test(`staging rejects a redirected ${boundary} without leaving a candidate`, async context => {
    const setup = fixture(context), outside = join(setup.directory, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'runtime-primary', version: '1.0.0' }));
    writeFileSync(join(outside, 'secret'), 'synthetic-do-not-copy');
    const target = boundary === 'dependency' ? join(setup.root, 'node_modules/runtime-primary')
      : boundary === 'built-file' ? join(setup.root, 'apps/server/dist/index.js') : join(setup.root, 'apps/server/dist');
    rmSync(target, { recursive: true });
    symlinkSync(boundary === 'built-file' ? join(outside, 'secret') : outside, target);
    await assert.rejects(stageCandidateRelease(setup), /outside|link|redirected/);
    assert.equal(existsSync(setup.destination), false);
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'synthetic-do-not-copy');
  });
}

test('missing mandatory dependency and missing built entry leave no candidate', async context => {
  const setup = fixture(context);
  rmSync(join(setup.root, 'node_modules/runtime-secondary'), { recursive: true });
  await assert.rejects(stageCandidateRelease(setup), /Missing installed runtime dependency/);
  assert.equal(existsSync(setup.destination), false);
  setup.metadata('node_modules/runtime-primary/package.json', { name: 'runtime-primary', version: '1.0.0' });
  rmSync(join(setup.root, 'apps/web/dist/index.html'));
  await assert.rejects(stageCandidateRelease(setup), /ENOENT/);
  assert.equal(existsSync(setup.destination), false);
});

test('optional missing dependencies are not installed and dependency cycles preserve one identity', async context => {
  const setup = fixture(context);
  setup.metadata('node_modules/runtime-secondary/package.json', { name: 'runtime-secondary', version: '1.0.0',
    dependencies: { 'runtime-primary': '1.0.0' }, optionalDependencies: { 'missing-optional-native': '*' },
    peerDependencies: { 'missing-optional-peer': '*' }, peerDependenciesMeta: { 'missing-optional-peer': { optional: true } } });
  assert.equal((await stageCandidateRelease(setup)).packages, 3);
  assert.equal(existsSync(join(setup.destination, 'node_modules/missing-optional-native')), false);
});

test('different installed versions keep their original per-package module resolution', async context => {
  const setup = fixture(context);
  setup.metadata('apps/server/package.json', { name: '@agentopsdeck/server', type: 'module',
    dependencies: { '@agentopsdeck/shared': 'workspace:*', 'runtime-primary': '*', 'runtime-secondary': '*' } });
  setup.metadata('node_modules/runtime-primary/node_modules/runtime-secondary/package.json', {
    name: 'runtime-secondary', version: '2.0.0', type: 'module', exports: './index.js' });
  setup.put('node_modules/runtime-primary/node_modules/runtime-secondary/index.js', 'export const value = 22;\n');
  assert.equal((await stageCandidateRelease(setup)).packages, 4);
  rmSync(setup.root, { recursive: true });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { result } from './apps/server/dist/index.js'; import { value } from './apps/server/node_modules/runtime-secondary/index.js'; if (result !== 24 || value !== 40) throw new Error('wrong dependency identity');"],
  { cwd: setup.destination, env: { HOME: setup.directory, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
});

test('shadowed multi-version dependency cycles fail explicitly instead of producing unbounded nested packages', async context => {
  const setup = fixture(context);
  setup.metadata('node_modules/runtime-primary/node_modules/runtime-secondary/package.json', {
    name: 'runtime-secondary', version: '2.0.0', dependencies: { 'runtime-primary': '*' } });
  setup.metadata('node_modules/runtime-primary/node_modules/runtime-secondary/node_modules/runtime-primary/package.json', {
    name: 'runtime-primary', version: '2.0.0', dependencies: { 'runtime-secondary': '*' } });
  const alternate = join(setup.root, 'node_modules/runtime-primary/node_modules/runtime-secondary/node_modules/runtime-primary/node_modules');
  mkdirSync(alternate);
  symlinkSync(join(setup.root, 'node_modules/runtime-secondary'), join(alternate, 'runtime-secondary'));
  setup.metadata('node_modules/runtime-secondary/package.json', {
    name: 'runtime-secondary', version: '1.0.0', dependencies: { 'runtime-primary': '*' } });
  await assert.rejects(stageCandidateRelease(setup), /shadowed dependency cycle/);
  assert.equal(existsSync(setup.destination), false);
});

for (const mutation of ['changed', 'missing', 'extra', 'link', 'hardlink']) {
  test(`candidate verification rejects ${mutation} contents before loading its modules`, async context => {
    const setup = fixture(context);
    await stageCandidateRelease(setup);
    const target = join(setup.destination, 'apps/server/dist/index.js');
    if (mutation === 'changed') writeFileSync(target, 'changed');
    else if (mutation === 'extra') writeFileSync(join(setup.destination, 'extra'), 'extra');
    else if (mutation === 'hardlink') linkSync(target, join(setup.directory, 'external-link'));
    else {
      rmSync(target);
      if (mutation === 'link') symlinkSync(join(setup.root, '.env'), target);
    }
    await assert.rejects(verifyCandidateRelease(setup.destination), /inventory|link/);
    assert.equal(readFileSync(join(setup.root, '.env'), 'utf8'), 'synthetic-private-configuration');
  });
}
