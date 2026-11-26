import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertCompiledCoverage, discoverTests, isolatedEnvironment, runSourceTests, selectTests } from './run-source-tests.mjs';
import * as runner from './run-source-tests.mjs';

test('timeouts, launch errors and signals remain infrastructure failures, not ordinary test exits', () => {
  assert.equal(typeof runner.assertTestCommandResult, 'function');
  assert.doesNotThrow(() => runner.assertTestCommandResult({ status: 0, signal: null }));
  const timeout = Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
  const launch = Object.assign(new Error('synthetic launch failure'), { code: 'ENOENT' });
  for (const result of [{ error: timeout, status: null, signal: 'SIGTERM' },
    { error: launch, status: null, signal: null }, { status: null, signal: 'SIGKILL' },
    { status: null, signal: null }, { status: undefined }]) {
    assert.throws(() => runner.assertTestCommandResult(result), error => {
      assert.equal(error.code, 'SOURCE_TEST_INFRASTRUCTURE_FAILURE');
      assert.equal(runner.sourceTestFailureExitCode(error), 2);
      if (result.error) assert.equal(error.cause, result.error);
      return true;
    });
  }
  assert.throws(() => runner.assertTestCommandResult({ status: 1, signal: null }), error => {
    assert.equal(error.code, undefined);
    assert.equal(runner.sourceTestFailureExitCode(error), 1);
    assert.match(error.cause.message, /exit=1/);
    return true;
  });
  assert.equal(runner.sourceTestFailureExitCode(new Error('ordinary assertion failure')), 1);
  assert.equal(runner.sourceTestFailureExitCode(undefined), 1);
});

test('both source lanes use bounded workers and retain every exact manifest path', () => {
  assert.equal(typeof runner.testArguments, 'function', 'test command construction must enforce worker bounds');
  const files = ['/fixture/application.test.ts', '/fixture/nested/server-role.test.ts'];
  assert.deepEqual(runner.testArguments('server', files), ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=4', ...files]);
  const compiled = ['/fresh/lib/a.test.js', '/fresh/nested/b.test.js'];
  assert.deepEqual(runner.testArguments('web', compiled), ['--test', '--test-reporter=tap', '--test-concurrency=2', ...compiled]);
  assert.deepEqual(runner.testArguments('server', files, { AOD_TEST_CONCURRENCY: '2' }), ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=2', ...files]);
  assert.deepEqual(runner.testArguments('web', compiled, { AOD_TEST_CONCURRENCY: '1' }), ['--test', '--test-reporter=tap', '--test-concurrency=1', ...compiled]);
  assert.throws(() => runner.testArguments('server', files, { AOD_TEST_CONCURRENCY: '5' }), /Invalid AOD_TEST_CONCURRENCY/);
  assert.throws(() => runner.testArguments('server', files, { AOD_TEST_CONCURRENCY: '0' }), /Invalid AOD_TEST_CONCURRENCY/);
  assert.throws(() => runner.testArguments('other', files), /Unknown test target/);
  const source = readFileSync(new URL('./run-source-tests.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('run(testArguments(target, selected.map(source => join(sourceRoot, source))), 900_000)'));
  assert.ok(source.includes("run(testArguments(target, selected.map(test => join(output, test.replace(/\\.tsx?$/, '.js')))), 120_000)"));
  assert.ok(source.includes('assertCompiledCoverage(sources, compiled)'));
});

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-test-discovery-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('source discovery includes application, role and arbitrarily nested tests in deterministic order', async context => {
  const directory = await fixture(context);
  await mkdir(join(directory, 'nested', 'deeper'), { recursive: true });
  for (const file of ['application.test.ts', 'server-role.test.ts', 'nested/example.test.ts', 'nested/deeper/view.test.tsx', 'non-test.ts']) {
    await writeFile(join(directory, file), '');
  }
  assert.deepEqual(await discoverTests(directory), ['application.test.ts', 'nested/deeper/view.test.tsx', 'nested/example.test.ts', 'server-role.test.ts']);
});

test('empty discovery is a failed verification rather than a zero-test success', async context => {
  const directory = await fixture(context);
  await writeFile(join(directory, 'example.ts'), '');
  await assert.rejects(discoverTests(directory), /No source-matched tests/);
});

test('discovery refuses a symlink rather than following another source tree or silently losing tests', async context => {
  const directory = await fixture(context);
  await mkdir(join(directory, 'source'));
  await mkdir(join(directory, 'external'));
  await symlink(join(directory, 'external'), join(directory, 'source', 'linked'), 'dir');
  await assert.rejects(discoverTests(join(directory, 'source')), /refuses symbolic links/);
});

test('compiled discovery and coverage reject missing, stale and ambiguous generated tests', async context => {
  const directory = await fixture(context);
  await mkdir(join(directory, 'lib'));
  await writeFile(join(directory, 'lib', 'example.test.js'), '');
  await writeFile(join(directory, 'lib', 'non-test.js'), '');
  const compiled = await discoverTests(directory, true);
  assert.deepEqual(compiled, ['lib/example.test.js']);
  assert.doesNotThrow(() => assertCompiledCoverage(['lib/example.test.ts'], compiled));
  assert.doesNotThrow(() => assertCompiledCoverage(['lib/view.test.tsx', 'lib/example.test.ts'], ['lib/example.test.js', 'lib/view.test.js']));
  assert.throws(() => assertCompiledCoverage(['lib/example.test.ts', 'lib/omitted.test.ts'], compiled), /complete source test manifest/);
  assert.throws(() => assertCompiledCoverage(['lib/example.test.ts'], [...compiled, 'lib/stale.test.js']), /complete source test manifest/);
  assert.throws(() => assertCompiledCoverage(['lib/example.test.ts'], ['other/example.test.js']), /complete source test manifest/);
  assert.throws(() => assertCompiledCoverage(['lib/example.test.ts', 'lib/example.test.tsx'], [...compiled, ...compiled]), /complete source test manifest/);
});

test('test child environment contains only an explicit tool path and disposable homes, never ambient runtime settings', () => {
  const environment = isolatedEnvironment('/synthetic-test-only', { PATH: '/synthetic-tools',
    AOD_TEST_SYNTHETIC_SECRET: 'must-not-reach-child', NODE_OPTIONS: '--synthetic-unsafe-option', HOME: '/not-the-test-home' });
  assert.equal(environment.AOD_TEST_SYNTHETIC_SECRET, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.HOME, '/synthetic-test-only/home');
  assert.equal(environment.TMPDIR, '/synthetic-test-only/tmp');
  assert.equal(environment.PATH, '/synthetic-tools');
  assert.deepEqual(Object.keys(environment).sort(), ['HOME', 'LANG', 'PATH', 'TEMP', 'TMP', 'TMPDIR'].sort());
});

test('unknown targets are refused without starting commands', async () => {
  await assert.rejects(runSourceTests('production'), /Usage:/);
  await assert.rejects(runSourceTests(undefined), /Usage:/);
});

test('targeted selection validates exact source paths and preserves the default full suite', () => {
  const sources = ['a.test.ts', 'lib/view.test.tsx'];
  assert.deepEqual(selectTests(sources), sources);
  assert.deepEqual(selectTests(sources, ['lib/view.test.tsx', 'lib/view.test.tsx']), ['lib/view.test.tsx']);
  for (const path of ['missing.test.ts', '../a.test.ts', '/a.test.ts', '*.test.ts', '--test-only', 'lib/view.test.js']) {
    assert.throws(() => selectTests(sources, [path]), /exact discovered/);
  }
  assert.throws(() => selectTests(sources, null), /exact discovered/);
});
