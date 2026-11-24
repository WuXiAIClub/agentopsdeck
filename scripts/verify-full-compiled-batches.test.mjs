import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshCompilerOptions, runCompiledBatch } from './verify-full-compiled-batches.mjs';
import { isolatedEnvironment } from './run-source-tests.mjs';
import { parseSuccessfulSummary, recordStrictBatch, assertSuccessfulFullCoverage } from './verify-full-source-batches.mjs';

test('real compiled child produces a strict TAP receipt with actual pass and skip counts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-compiled-tap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = isolatedEnvironment(root);
  await mkdir(environment.HOME); await mkdir(environment.TMPDIR);
  const file = join(root, 'receipt.test.mjs'), log = join(root, 'receipt.log');
  await writeFile(file, "import test from 'node:test';\ntest('actual pass', () => {});\ntest.skip('explicit skip', () => {});\n");
  assert.deepEqual(await runCompiledBatch([file], root, environment, log), { code: 0, signal: null });
  const summary = parseSuccessfulSummary(await readFile(log, 'utf8'));
  assert.equal(summary.tests, 2); assert.equal(summary.pass, 1); assert.equal(summary.skipped, 1);
  assert.equal(summary.fail, 0); assert.equal(summary.cancelled, 0);
});

test('fresh compilation disables adjacent build artifacts and overrides only the shared declaration path', () => {
  const parsed = { options: { composite: true, incremental: true, noEmit: true,
    tsBuildInfoFile: '/original/build.tsbuildinfo', paths: { '@agentopsdeck/shared': ['stale'], other: ['kept'] } } };
  const original = structuredClone(parsed);
  const options = freshCompilerOptions(parsed, '/candidate/server', '/candidate/shared/dist/index.d.ts');
  assert.deepEqual(parsed, original);
  assert.equal(options.outDir, '/candidate/server');
  assert.equal(options.composite, false); assert.equal(options.incremental, false);
  assert.equal(options.noEmit, false); assert.equal(options.noEmitOnError, true);
  assert.equal(Object.hasOwn(options, 'tsBuildInfoFile'), false);
  assert.deepEqual(options.paths, { '@agentopsdeck/shared': ['/candidate/shared/dist/index.d.ts'], other: ['kept'] });
});

test('real failed child is retained, next child runs once and aggregate still fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-compiled-collection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = isolatedEnvironment(root);
  await mkdir(environment.HOME); await mkdir(environment.TMPDIR);
  const result = { attempts: [], batches: [] };
  const files = ['failed.test.mjs', 'passed.test.mjs'];
  for (const [index, name] of files.entries()) {
    const file = join(root, name), log = join(root, name + '.log');
    await writeFile(file, `import test from 'node:test';\ntest('actual child', () => { ${index === 0 ? "throw Error('expected failure')" : ''} });\n`);
    const outcome = await runCompiledBatch([file], root, environment, log);
    assert.equal(outcome.code, index === 0 ? 1 : 0);
    assert.equal(recordStrictBatch(result, { files: [name], log, ...outcome }, await readFile(log, 'utf8')), index !== 0);
  }
  assert.equal(result.attempts.length, 2); assert.equal(result.batches.length, 1);
  assert.ok(result.attempts[0].validationError);
  assert.throws(() => assertSuccessfulFullCoverage(files, result), /failed batches/);
});

test('shared fresh emit leaves original source path mappings unchanged', () => {
  const parsed = { options: { paths: { '@agentopsdeck/shared': ['packages/shared/src/index.ts'] } } };
  assert.deepEqual(freshCompilerOptions(parsed, '/candidate/shared').paths, parsed.options.paths);
});

test('empty or duplicate batches fail before test discovery or child dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-compiled-runner-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = isolatedEnvironment(root);
  await mkdir(environment.HOME); await mkdir(environment.TMPDIR);
  const log = join(root, 'empty.log');
  await assert.rejects(runCompiledBatch([], root, environment, log), /Empty compiled batch/);
  await assert.rejects(runCompiledBatch(['a', 'a'], root, environment, log), /Duplicate compiled test/);
  await assert.rejects(runCompiledBatch([null], root, environment, log), /Empty compiled batch/);
});
