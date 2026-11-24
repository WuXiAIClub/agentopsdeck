import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as verifier from './verify-full-source-batches.mjs';

test('source-byte partitions bound dense batches without skipping, repeating or extending deadlines', () => {
  const files = ['a', 'b', 'dense', 'c', 'd', 'oversized', 'e'];
  const sizes = new Map([['a', 30], ['b', 30], ['dense', 90], ['c', 50], ['d', 50], ['oversized', 101], ['e', 0]]);
  const batches = verifier.partitionSourceManifest(files, sizes, 32, 100);
  assert.deepEqual(batches, [['a', 'b'], ['dense'], ['c', 'd'], ['oversized'], ['e']]);
  assert.deepEqual(batches.flat(), files);
  verifier.assertFullCoverage(files, batches);
  assert.deepEqual(verifier.partitionSourceManifest(files, sizes, 1, 100), files.map(file => [file]));
  for (const budget of [0, -1, 1.5, Infinity, NaN, '100']) {
    assert.throws(() => verifier.partitionSourceManifest(files, sizes, 32, budget));
  }
  for (const size of [undefined, -1, 1.5, Infinity, NaN, '30']) {
    assert.throws(() => verifier.partitionSourceManifest(files, new Map(sizes).set('a', size), 32, 100));
  }
  assert.throws(() => verifier.partitionSourceManifest(['a', 'a'], sizes));
  assert.throws(() => verifier.partitionSourceManifest([], sizes));
});

test('explicit frozen repository and single-file batches retain complete inventory and exact coverage', async context => {
  const root = await mkdtemp(join(tmpdir(), 'full-suite-frozen-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['apps/server/src', 'packages/shared/src', 'scripts']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', 'packages/shared/src/index.ts',
    'pnpm-lock.yaml', 'scripts/verify-full-source-batches.mjs', 'scripts/source-shadow-guard.mjs',
    'scripts/source-shadow-guard.test.mjs', 'scripts/verify-full-source-batches.test.mjs',
    'tsconfig.base.json', 'apps/server/tsconfig.json', 'packages/shared/tsconfig.json']) await writeFile(join(root, file), 'fixture');
  await writeFile(join(root, 'scripts/run-source-tests.mjs'), `
    import assert from 'node:assert/strict';
    assert.equal(process.argv[2], 'server'); assert.equal(process.argv.length, 4);
    console.log(JSON.stringify({ selected: process.argv[3] }));
    console.log('# tests 1\\n# suites 0\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1');
  `);
  const before = await verifier.sourceInventory(root), evidence = join(root, 'evidence');
  await verifier.verifyFullSourceBatches(evidence, { repositoryRoot: root, batchMaximum: 1 });
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
  assert.equal(result.passed, true); assert.equal(result.concurrency, 1); assert.equal(result.batchMaximum, 1);
  assert.equal(result.repositoryRoot, root); assert.match(result.verifierSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.batchSourceByteMaximum, 128 * 1024); assert.equal(result.batchTimeoutMs, 900_000);
  assert.deepEqual(result.files, ['a.test.ts', 'b.test.ts']);
  assert.deepEqual(result.attempts.map(attempt => attempt.sourceBytes), [7, 7]);
  assert.deepEqual(result.attempts.map(attempt => attempt.files), [['a.test.ts'], ['b.test.ts']]);
  assert.deepEqual(await verifier.sourceInventory(root), before);
  for (const maximum of [0, NaN, 1.5, 129]) await assert.rejects(
    verifier.verifyFullSourceBatches(join(root, 'invalid'), { repositoryRoot: root, batchMaximum: maximum }), /Invalid/);
});

test('evidence directory creates missing parents but refuses an existing run without modifying it', async context => {
  const root = await mkdtemp(join(tmpdir(), 'full-suite-evidence-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.ci-evidence', 'server');
  await verifier.createExclusiveEvidenceDirectory(directory);
  const sentinel = join(directory, 'result.json');
  await writeFile(sentinel, 'original');
  await assert.rejects(verifier.createExclusiveEvidenceDirectory(directory), { code: 'EEXIST' });
  assert.equal(await readFile(sentinel, 'utf8'), 'original');
});

test('infrastructure exit retains the original log and withholds all later source batches', async context => {
  const root = await mkdtemp(join(tmpdir(), 'full-suite-infrastructure-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['apps/server/src', 'packages/shared/src', 'scripts']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts', 'packages/shared/src/index.ts',
    'pnpm-lock.yaml', 'scripts/verify-full-source-batches.mjs', 'scripts/source-shadow-guard.mjs',
    'scripts/source-shadow-guard.test.mjs', 'scripts/verify-full-source-batches.test.mjs',
    'tsconfig.base.json', 'apps/server/tsconfig.json', 'packages/shared/tsconfig.json']) await writeFile(join(root, file), 'fixture');
  await writeFile(join(root, 'scripts/run-source-tests.mjs'), `
    console.log('synthetic source command timeout');
    process.exitCode = 2;
  `);
  const before = await verifier.sourceInventory(root), evidence = join(root, 'evidence');
  await assert.rejects(verifier.verifyFullSourceBatches(evidence, { repositoryRoot: root, batchMaximum: 1 }), /infrastructure/);
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
  assert.equal(result.passed, false); assert.match(result.failure, /infrastructure/);
  assert.equal(result.attempts.length, 1); assert.equal(result.batches.length, 0);
  assert.equal(result.attempts[0].code, 2);
  assert.equal(await readFile(join(evidence, 'batch-1.log'), 'utf8'), 'synthetic source command timeout\n');
  await assert.rejects(readFile(join(evidence, 'batch-2.log')), { code: 'ENOENT' });
  assert.deepEqual(await verifier.sourceInventory(root), before);
});
import { FULL_SUITE_BATCH_MAXIMUM, partitionManifest, assertFullCoverage, parseSuccessfulSummary, recordStrictBatch, assertSuccessfulFullCoverage } from './verify-full-source-batches.mjs';

test('partition covers every source exactly once, including small and odd manifests', () => {
  for (const files of [1, 2, 3, 31, 32, 33].map(count => Array.from({length:count}, (_,i) => `file-${i}`))) {
    const batches = partitionManifest(files);
    assertFullCoverage(files, batches);
    assert.ok(batches.every(batch => batch.length));
  }
  assert.throws(() => partitionManifest([]));
  assert.throws(() => partitionManifest(['one', 'one']));
});
test('coverage rejects omitted, extra and repeated files', () => {
  for (const batches of [[['a']], [['a', 'b', 'c']], [['a', 'b'], ['a']]]) {
    assert.throws(() => assertFullCoverage(['a', 'b'], batches));
  }
});
test('large manifests use bounded serial partitions with exact unmodified order', () => {
  const files = Array.from({ length: 731 }, (_, i) => `file-${i}.test.ts`);
  const batches = partitionManifest(files);
  assert.equal(FULL_SUITE_BATCH_MAXIMUM, 32);
  assert.equal(batches.length, 23);
  assert.ok(batches.every(batch => batch.length <= FULL_SUITE_BATCH_MAXIMUM));
  assert.equal(batches.at(-1).length, 27);
  assert.deepEqual(batches.flat(), files);
  assertFullCoverage(files, batches);
  assert.deepEqual(partitionManifest(['a','b','c'], 2), [['a','b'],['c']]);
  for (const maximum of [0,-1,129,1.5,Infinity,NaN,'64']) assert.throws(() => partitionManifest(files, maximum));
});
const log = '# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 123.4\n';
test('only one complete successful summary is accepted, retaining optional skips', () => {
  assert.equal(parseSuccessfulSummary(log).pass, 2);
  assert.equal(parseSuccessfulSummary(log).skipped, 1);
  for (const invalid of ['', log + log, log.replace('# fail 0', '# fail 1'), log.replace('# cancelled 0', '# cancelled 1'),
    log.replace('# todo 0', '# todo 1'), log.replace('# tests 3', '# tests 4'), log.replace('# duration_ms 123.4\n', ''), 'not ok 1 - failure\n' + log]) {
    assert.throws(() => parseSuccessfulSummary(invalid));
  }
});

test('failed exited batches retain evidence and permit later passes, never full success', () => {
  for (const [code, text] of [[1, log], [0, log + log], [0, 'not ok 1 - failed\n' + log],
    [0, 'truncated'], [0, log.replace('# cancelled 0', '# cancelled 1')]]) {
    const result = { attempts: [], batches: [] };
    const attempt = { files: ['a'], code, signal: null, log: '/evidence/first.log', sha256: 'original hash' };
    assert.equal(recordStrictBatch(result, attempt, text), false);
    assert.equal(result.attempts[0], attempt);
    assert.ok(attempt.validationError);
    assert.equal(attempt.sha256, 'original hash');
    assert.equal(recordStrictBatch(result, { files: ['b'], code: 0, signal: null }, log), true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.batches.length, 1);
    assert.throws(() => assertSuccessfulFullCoverage(['a', 'b'], result), /failed batches/);
    assert.throws(() => assertSuccessfulFullCoverage(['a', 'b', 'c'], result), /Incomplete/);
  }
});

test('signal or missing exit stops collection; full successful coverage stays exact', () => {
  for (const status of [{ code: null, signal: 'SIGKILL' }, { code: null, signal: null },
    { code: 2, signal: null }, { code: 124, signal: null }, { code: 137, signal: null }]) {
    const result = { attempts: [], batches: [] };
    assert.throws(() => recordStrictBatch(result, { files: ['a'], ...status }, log));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.batches.length, 0);
    assert.throws(() => assertSuccessfulFullCoverage(['a'], result));
  }
  const result = { attempts: [], batches: [] };
  for (const file of ['a', 'b']) assert.equal(recordStrictBatch(result, { files: [file], code: 0, signal: null }, log), true);
  assertSuccessfulFullCoverage(['a', 'b'], result);
  assert.throws(() => assertSuccessfulFullCoverage(['a'], result));
});

test('parallel CI shards cover every source exactly once with balanced, ordered selection', () => {
  const files = Array.from({ length: 1147 }, (_, i) => `source-${i}.test.ts`);
  const shards = Array.from({ length: 4 }, (_, i) => verifier.selectShard(files, i + 1, 4));
  assertFullCoverage(files, shards);
  assert.deepEqual(shards[0], files.filter((_, index) => index % 4 === 0));
  assert.ok(Math.max(...shards.map(shard => shard.length)) - Math.min(...shards.map(shard => shard.length)) <= 1);
  assert.deepEqual(verifier.selectShard(files), files);
  for (const [index, count] of [[0,4],[5,4],[1,0],[1,1148],[1.5,4],[1,Infinity]]) {
    assert.throws(() => verifier.selectShard(files, index, count));
  }
});

test('shard CLI requires an exact complete pair and rejects duplicate or unknown selectors', () => {
  assert.deepEqual(verifier.shardArguments([]), { index: 1, count: 1 });
  assert.deepEqual(verifier.shardArguments(['--shard-index=2', '--shard-count=4']), { index: 2, count: 4 });
  for (const args of [['--shard-index=2'], ['--shard-index=2','--shard-index=2'],
    ['--shard-index=0','--shard-count=4'], ['--shard-index=2','--unknown=4'],
    ['--shard-index=2','--shard-count=4','--extra']]) assert.throws(() => verifier.shardArguments(args));
});

test('failed batch excerpts expose original failures with bounds and retain timeout tails', () => {
  const output = 'passed\nnot ok 2 - original assertion\n  error: original failure\n' + 'x'.repeat(20_000);
  const excerpt = verifier.failedBatchExcerpt(output);
  assert.match(excerpt, /original assertion/);
  assert.match(excerpt, /original failure/);
  assert.ok(excerpt.length <= 16_384);
  assert.match(verifier.failedBatchExcerpt('last running test\nError: timeout'), /timeout/);
});
