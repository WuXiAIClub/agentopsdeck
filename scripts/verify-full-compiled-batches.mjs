import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { emitProjectInChild } from './compile-test-project.mjs';
export { freshCompilerOptions } from './compile-test-project.mjs';
import { discoverTests, assertCompiledCoverage, isolatedEnvironment } from './run-source-tests.mjs';
import { FULL_SUITE_BATCH_MAXIMUM, sourceInventory, partitionManifest, assertFullCoverage, recordStrictBatch, assertSuccessfulFullCoverage } from './verify-full-source-batches.mjs';
import { inventoryCompiledServerAssets, installCompiledServerAssets } from './compiled-server-assets.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const runnerInputs = [
  'scripts/verify-full-compiled-batches.mjs', 'scripts/verify-full-compiled-batches.test.mjs',
  'scripts/compiled-server-assets.mjs', 'scripts/audit-async-database-roots.mjs',
  'scripts/compile-test-project.mjs', 'scripts/compile-test-project.test.mjs',
  'packages/shared/package.json', 'apps/server/package.json',
];

async function inventory() {
  const inputs = await sourceInventory();
  for (const path of runnerInputs) inputs.push({ path, sha256: hash(await readFile(join(repository, path))) });
  return inputs.sort((a, b) => a.path.localeCompare(b.path));
}

function patchNewFile(path, text) {
  const patch = '*** Begin Patch\n*** Add File: ' + path + '\n'
    + text.trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n*** End Patch\n';
  const result = spawnSync('apply_patch', [], { input: patch, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Cannot write exclusive acceptance artifact');
}

/** Observe each original child through exit, including its deadline failure.
 * Callers retain nonzero/signal logs and never count them as coverage. */
export async function runCompiledBatch(files, cwd, environment, log) {
  assert.ok(Array.isArray(files) && files.length > 0 && files.every(file => typeof file === 'string'), 'Empty compiled batch');
  assert.equal(new Set(files).size, files.length, 'Duplicate compiled test');
  const output = createWriteStream(log, { flags: 'wx', mode: 0o600 });
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...files], {
      cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000,
    });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    let failed;
    output.once('error', error => { failed = error; });
    child.once('error', error => { failed = error; });
    child.once('close', (code, signal) => output.end(() => {
      if (failed) reject(failed); else resolveRun({ code, signal });
    }));
  });
}

export async function verifyFullCompiledBatches(directory) {
  await mkdir(directory, { mode: 0o700 }); // Refuse an existing receipt directory.
  const before = await inventory();
  const workspace = join(repository, 'apps/server'), source = join(workspace, 'src');
  const files = await discoverTests(source), batches = partitionManifest(files);
  assertFullCoverage(files, batches);
  const assets = inventoryCompiledServerAssets(source);
  const result = { version: 1, target: 'server-fresh-shared-compiled', passed: false,
    wholeDatabaseAsync: false, productionActivation: false, startedAt: new Date().toISOString(),
    files, source: before, assets, concurrency: 4, batchMaximum: FULL_SUITE_BATCH_MAXIMUM, batchTimeoutMs: 900_000, batches: [], attempts: [] };
  let candidate, environmentRoot;
  try {
    const parent = join(workspace, '.tmp-test'); await mkdir(parent, { recursive: true });
    candidate = await mkdtemp(join(parent, 'full-fresh-shared-'));
    const shared = join(candidate, 'node_modules/@agentopsdeck/shared');
    await mkdir(shared, { recursive: true });
    const manifest = JSON.parse(await readFile(join(repository, 'packages/shared/package.json'), 'utf8'));
    assert.equal(manifest.name, '@agentopsdeck/shared');
    assert.equal(manifest.type, 'module'); assert.equal(manifest.main, 'dist/index.js');
    patchNewFile(join(shared, 'package.json'), JSON.stringify(manifest, null, 2));
    emitProjectInChild(join(repository, 'packages/shared'), join(shared, 'dist'));
    result.sharedEntrySha256 = hash(await readFile(join(shared, 'dist/index.js')));
    const output = join(candidate, 'server');
    emitProjectInChild(workspace, output, join(shared, 'dist/index.d.ts'));
    installCompiledServerAssets(source, output, assets);
    assertCompiledCoverage(files, await discoverTests(output, true));
    assert.deepEqual(await inventory(), before, 'Inputs changed during fresh emit');
    // Check Node's actual resolution from inside the emitted tree, including
    // worker entry ancestry. A valid TypeScript paths map alone is insufficient.
    const probe = join(output, '.shared-resolution.mjs');
    patchNewFile(probe, `import assert from 'node:assert/strict';\nimport { pathToFileURL } from 'node:url';\nassert.equal(import.meta.resolve('@agentopsdeck/shared'), pathToFileURL(${JSON.stringify(join(shared, 'dist/index.js'))}).href);\nawait import('@agentopsdeck/shared');\n`);
    environmentRoot = await mkdtemp(join(tmpdir(), 'agentopsdeck-full-compiled-'));
    const environment = isolatedEnvironment(environmentRoot);
    await mkdir(environment.HOME); await mkdir(environment.TMPDIR);
    const probeResult = spawnSync(process.execPath, [probe], { cwd: workspace, env: environment, encoding: 'utf8' });
    assert.equal(probeResult.error, undefined); assert.equal(probeResult.signal, null);
    assert.equal(probeResult.status, 0, probeResult.stderr);
    result.sharedRuntimeResolutionVerified = true;
    console.log(`Fresh shared + server emit: ${files.length} tests, ${batches.length} disjoint batches`);
    for (const [index, selected] of batches.entries()) {
      assert.deepEqual(await inventory(), before, 'Inputs changed before compiled batch');
      const log = join(directory, `batch-${index + 1}.log`);
      const outcome = await runCompiledBatch(selected.map(file => join(output, file.replace(/\.tsx?$/, '.js'))), workspace, environment, log);
      const text = await readFile(log, 'utf8');
      const attempt = { files: selected, log, ...outcome, sha256: hash(text) };
      const passed = recordStrictBatch(result, attempt, text);
      assert.deepEqual(await inventory(), before, 'Inputs changed during compiled batch');
      const summary = result.batches.at(-1);
      console.log(`Compiled batch ${index + 1}/${batches.length}: ${passed
        ? `${summary.pass} pass, ${summary.skipped} skip` : `FAILED; preserved ${log}`}`);
    }
    assertSuccessfulFullCoverage(files, result);
    // The audit loads TypeScript too; defer it until all test children exit.
    const { auditDatabaseRoots } = await import('./audit-async-database-roots.mjs');
    result.databaseRoots = await auditDatabaseRoots(source);
    assert.deepEqual(await inventory(), before, 'Inputs changed before final receipt');
    result.passed = true; result.completedAt = new Date().toISOString();
    for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      console.log(`# ${field} ${result.batches.reduce((sum, batch) => sum + batch[field], 0)}`);
    }
  } catch (error) {
    result.failure = error.message; throw error;
  } finally {
    // Failed attempts are not discarded. Only compiler/test temporary trees
    // created here are removed; evidence and repository dist remain untouched.
    patchNewFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    if (candidate) await rm(candidate, { recursive: true, force: true });
    if (environmentRoot) await rm(environmentRoot, { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-full-compiled-batches.mjs NEW_EVIDENCE_DIRECTORY');
  await verifyFullCompiledBatches(resolve(process.argv[2]));
}
