import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverTests } from './run-source-tests.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const helperFile = new URL('./ci-validation.mjs', import.meta.url);
async function helper() {
  assert.ok(existsSync(helperFile), 'validation helper must discover complete script test manifests');
  return import(helperFile.href);
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentopsdeck-ci-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('script discovery includes nested release/unit fixtures but excludes operational entrypoints', async t => {
  const { discoverScriptTests } = await helper();
  const dir = await fixture(t);
  await mkdir(join(dir, 'lib/deep'), { recursive: true });
  for (const file of ['release.test.mjs', 'lib/deep/fixture.test.mjs', 'deploy.mjs', 'README.md']) {
    await writeFile(join(dir, file), '');
  }
  assert.deepEqual(await discoverScriptTests(dir), ['lib/deep/fixture.test.mjs', 'release.test.mjs']);
  await mkdir(join(dir, 'empty'));
  await assert.rejects(discoverScriptTests(join(dir, 'empty')), /No script tests/);
  await symlink(join(dir, 'empty'), join(dir, 'link'), 'dir');
  await assert.rejects(discoverScriptTests(dir), /symbolic links/);
});

test('real source manifests and configured source runners preserve application/role, web and POC coverage', async () => {
  const { discoverScriptTests } = await helper();
  const entries = (await Promise.all(['apps/server/src', 'apps/web/src', 'scripts'].map(directory =>
    readdir(join(root, directory), { recursive: true, withFileTypes: true })))).flat();
  const files = entries.filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  for (const lane of ['server', 'web']) {
    const prefix = `apps/${lane}/src/`;
    const expected = files.filter(file => file.startsWith(prefix) && /\.test\.tsx?$/.test(file)).sort();
    const discovered = (await discoverTests(join(root, prefix))).map(file => prefix + file.replaceAll('\\', '/'));
    assert.deepEqual(discovered, expected);
    if (lane === 'server') {
      assert.ok(discovered.includes('apps/server/src/application.test.ts'));
      assert.ok(discovered.includes('apps/server/src/server-role.test.ts'));
    }
  }
  const scriptManifest = (await discoverScriptTests(join(root, 'scripts'))).map(file => `scripts/${file.replaceAll('\\', '/')}`);
  assert.deepEqual(scriptManifest, files.filter(file => file.startsWith('scripts/') && file.endsWith('.test.mjs')).sort());
  for (const required of ['scripts/check-web-i18n.test.mjs', 'scripts/run-source-tests.test.mjs',
    'scripts/stage-candidate-release.test.mjs', 'scripts/verify-candidate-history-admission.test.mjs',
    'scripts/lib/deployment-linkage-closure.test.mjs']) assert.ok(scriptManifest.includes(required));
  assert.deepEqual(await discoverTests(join(root, 'apps/server/poc')), ['communication/communication.test.ts']);
  const server = JSON.parse(readFileSync(join(root, 'apps/server/package.json'))).scripts;
  const web = JSON.parse(readFileSync(join(root, 'apps/web/package.json'))).scripts;
  assert.equal(server.test, 'node ../../scripts/run-source-tests.mjs server');
  assert.equal(web.test, 'node ../../scripts/run-source-tests.mjs web');
});

test('isolated validation child executes, rejects failure/timeout and cannot inherit runtime credentials', async t => {
  const { runNode } = await helper();
  assert.equal(typeof runNode, 'function', 'validation subprocess must fail closed');
  const dir = await fixture(t);
  const output = join(dir, 'environment.json');
  const previous = process.env.AOD_CI_SYNTHETIC_SECRET;
  process.env.AOD_CI_SYNTHETIC_SECRET = 'not-a-real-credential';
  try {
    await runNode(['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`], dir, 5000);
    const env = JSON.parse(readFileSync(output));
    assert.equal(env.AOD_CI_SYNTHETIC_SECRET, undefined);
    assert.equal(env.HOME.startsWith(tmpdir()), true);
    assert.equal(existsSync(env.HOME), false, 'temporary child home is removed');
    await assert.rejects(runNode(['-e', 'process.exit(7)'], dir, 5000), /Validation command failed/);
    await assert.rejects(runNode(['-e', 'setInterval(() => {}, 1000)'], dir, 100), /Validation command failed/);
  } finally {
    if (previous === undefined) delete process.env.AOD_CI_SYNTHETIC_SECRET;
    else process.env.AOD_CI_SYNTHETIC_SECRET = previous;
  }
});

test('CLI script lane executes all discovered files, including nested fixtures, and propagates failures', async t => {
  const { runValidation } = await helper();
  assert.equal(typeof runValidation, 'function', 'validation lanes must be executable');
  const dir = await fixture(t);
  await mkdir(join(dir, 'scripts/lib'), { recursive: true });
  const tsx = join(dir, 'apps/server/node_modules/tsx');
  await mkdir(tsx, { recursive: true });
  await writeFile(join(tsx, 'package.json'), JSON.stringify({ name: 'tsx', type: 'module', exports: './index.mjs' }));
  await writeFile(join(tsx, 'index.mjs'), '// Synthetic no-op loader: these fixtures are plain JS.');
  for (const file of ['one.test.mjs', 'lib/two.test.mjs']) {
    const marker = join(dir, file.replaceAll('/', '-'));
    await writeFile(join(dir, 'scripts', file), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  }
  await writeFile(join(dir, 'scripts/deploy.mjs'), "throw new Error('Operational CLI must not run');");
  await runValidation('scripts', dir);
  assert.equal(readFileSync(join(dir, 'one.test.mjs'), 'utf8'), 'ran');
  assert.equal(readFileSync(join(dir, 'lib-two.test.mjs'), 'utf8'), 'ran');
  await writeFile(join(dir, 'scripts/lib/two.test.mjs'), 'process.exit(7);');
  await assert.rejects(runValidation('scripts', dir), /Validation command failed/);
  await assert.rejects(runValidation('deploy', dir), /Unknown validation target/);
});

test('POC lane compiles its separate project and executes its full discovered manifest', async t => {
  const { runValidation } = await helper();
  const dir = await fixture(t);
  const loader = join(dir, 'apps/server/node_modules/tsx');
  await mkdir(loader, { recursive: true });
  await writeFile(join(loader, 'package.json'), JSON.stringify({ name: 'tsx', type: 'module', exports: './index.mjs' }));
  await writeFile(join(loader, 'index.mjs'), '// No-op loader for this plain JavaScript fixture.');
  await mkdir(join(dir, 'node_modules/typescript/bin'), { recursive: true });
  await mkdir(join(dir, 'apps/server/poc/communication'), { recursive: true });
  await writeFile(join(dir, 'node_modules/typescript/bin/tsc'), `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'compiled'))}, process.argv.slice(2).join(' '));`);
  await writeFile(join(dir, 'apps/server/poc/communication/communication.test.ts'), `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'tested'))}, 'ran');`);
  await runValidation('poc', dir);
  assert.equal(readFileSync(join(dir, 'compiled'), 'utf8'), '-p poc/communication/tsconfig.json');
  assert.equal(readFileSync(join(dir, 'tested'), 'utf8'), 'ran');
});

test('package lane rejects a hash-valid bundle missing compiled admission policy and cleans it up', async t => {
  const { runValidation } = await helper();
  const dir = await fixture(t), source = join(dir, 'source'), temp = join(dir, 'temp');
  await mkdir(temp);
  for (const path of ['apps/server/dist', 'apps/web/dist', 'packages/shared/dist', 'node_modules']) {
    await mkdir(join(source, path), { recursive: true });
  }
  for (const [path, value] of Object.entries({
    'apps/server/package.json': '{"name":"@agentopsdeck/server","version":"1.0.0","type":"module","dependencies":{}}',
    'packages/shared/package.json': '{"name":"@agentopsdeck/shared","version":"1.0.0","type":"module"}',
    'apps/server/dist/index.js': "throw new Error('Server entrypoint must never execute');",
    'apps/server/dist/application.js': 'export function createApplication() {}',
    'apps/web/dist/index.html': '<!doctype html><title>Synthetic package</title>',
  })) await writeFile(join(source, path), value);
  const old = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  try {
    await assert.rejects(runValidation('package', source), /Validation command failed/);
    assert.deepEqual(await readdir(temp), [], 'failed package validation must remove staged output');
    assert.match(readFileSync(join(source, 'apps/server/dist/index.js'), 'utf8'), /must never execute/);
  } finally {
    if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old;
  }
});
