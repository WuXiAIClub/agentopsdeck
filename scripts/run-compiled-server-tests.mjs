import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emitProjectInChild } from './compile-test-project.mjs';
import { discoverTests, assertCompiledCoverage, isolatedEnvironment, selectTests } from './run-source-tests.mjs';
import { sourceInventory } from './verify-full-source-batches.mjs';
import { inventoryCompiledServerAssets, installCompiledServerAssets } from './compiled-server-assets.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function runtimeInputs() {
  const rows = [];
  const record = async path => rows.push({ path, sha256: createHash('sha256').update(await readFile(join(repository, path))).digest('hex') });
  for (const path of ['scripts/run-compiled-server-tests.mjs', 'scripts/compile-test-project.mjs', 'scripts/compiled-server-assets.mjs', 'packages/shared/package.json']) await record(path);
  async function visit(directory) {
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'Runtime inventory refuses symlinked inputs');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else { assert.ok(entry.isFile(), 'Runtime input must be regular'); await record(path); }
    }
  }
  // These are pinned existing shared outputs, not a claim of fresh shared emit.
  await visit('packages/shared/dist');
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
/** Source-matched fresh emit, including runtime/fixture assets. This is a test
 * runner, not production activation or whole-database migration certification.
 * It never uses old adjacent .js files as the acceptance candidate. */
export async function runCompiledServerTests(requested = []) {
  const workspace = join(repository, 'apps/server'), sourceRoot = join(workspace, 'src');
  const before = await sourceInventory(), runtime = await runtimeInputs(), assets = inventoryCompiledServerAssets(sourceRoot);
  const sources = await discoverTests(sourceRoot), selected = selectTests(sources, requested);
  const environmentRoot = await mkdtemp(join(tmpdir(), 'agentopsdeck-compiled-tests-'));
  const environment = isolatedEnvironment(environmentRoot);
  let output;
  try {
    await mkdir(environment.HOME); await mkdir(environment.TMPDIR);
    const parent = join(workspace, '.tmp-test'); await mkdir(parent, { recursive: true });
    output = await mkdtemp(join(parent, 'fresh-server-'));
    // Release the compiler process (and its Program graph) before tests start.
    emitProjectInChild(workspace, output, undefined, true);
    assert.deepEqual(await sourceInventory(), before, 'Inputs changed during fresh emit');
    assert.deepEqual(await runtimeInputs(), runtime, 'Shared runtime or runner changed during fresh emit');
    installCompiledServerAssets(sourceRoot, output, assets);
    assertCompiledCoverage(sources, await discoverTests(output, true));
    console.log(`server compiled: ${requested.length ? 'TARGETED (not full-suite)' : 'FULL'}, ${selected.length}/${sources.length} source-matched files; ${assets.length} pinned assets`);
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4',
      ...selected.map(file => join(output, file.replace(/\.tsx?$/, '.js')))],
    { cwd: workspace, env: environment, stdio: 'inherit', timeout: 900_000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
    assert.deepEqual(await sourceInventory(), before, 'Inputs changed during compiled test acceptance');
    assert.deepEqual(await runtimeInputs(), runtime, 'Shared runtime or runner changed during compiled acceptance');
    assert.deepEqual(inventoryCompiledServerAssets(sourceRoot), assets, 'Assets changed during compiled test acceptance');
  } finally {
    if (output) await rm(output, { recursive: true, force: true });
    await rm(environmentRoot, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCompiledServerTests(process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
