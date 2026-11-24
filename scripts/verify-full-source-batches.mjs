import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests } from './run-source-tests.mjs';
import { assertNoAdjacentJavaScript } from './source-shadow-guard.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FULL_SUITE_BATCH_MAXIMUM = 32;
export const FULL_SUITE_BATCH_SOURCE_BYTES = 128 * 1024;
export function partitionManifest(files, maximum = FULL_SUITE_BATCH_MAXIMUM) {
  assert.ok(files.length > 0 && new Set(files).size === files.length);
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 128, 'Invalid full-suite batch size');
  // Keep exact disjoint coverage, but do not put half an ever-growing suite
  // behind one 15-minute subprocess deadline. Batches remain serial: fsync
  // pressure is not a reason to retry work or run duplicate acceptance lanes.
  const batches = [];
  for (let offset = 0; offset < files.length; offset += maximum) batches.push(files.slice(offset, offset + maximum));
  return batches;
}
// File count alone does not bound a generated permission matrix's work. Keep
// dense source groups smaller before execution, never retry timed-out batches
// or extend their deadline. An oversized file runs alone, with the same limit.
export function partitionSourceManifest(files, sizes, maximum = FULL_SUITE_BATCH_MAXIMUM,
  byteMaximum = FULL_SUITE_BATCH_SOURCE_BYTES) {
  partitionManifest(files, maximum); // Preserve manifest and count validation.
  assert.ok(Number.isSafeInteger(byteMaximum) && byteMaximum > 0, 'Invalid source-byte batch budget');
  const batches = [];
  let batch = [], bytes = 0;
  for (const file of files) {
    const size = sizes.get(file);
    assert.ok(Number.isSafeInteger(size) && size >= 0, 'Invalid source-byte inventory');
    if (batch.length && (batch.length === maximum || bytes + size > byteMaximum || bytes >= byteMaximum)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(file); bytes += size;
  }
  if (batch.length) batches.push(batch);
  assertFullCoverage(files, batches);
  return batches;
}
export function assertFullCoverage(files, batches) {
  const actual = batches.flat();
  assert.equal(new Set(actual).size, actual.length, 'Duplicate source test');
  assert.deepEqual([...actual].sort(), [...files].sort(), 'Incomplete source test manifest');
}
export function selectShard(files, index = 1, count = 1) {
  assert.ok(Number.isSafeInteger(index) && Number.isSafeInteger(count)
    && count >= 1 && count <= files.length && index >= 1 && index <= count, 'Invalid source-test shard');
  const shards = Array.from({ length: count }, (_, shard) => files.filter((_, offset) => offset % count === shard));
  assertFullCoverage(files, shards);
  return shards[index - 1];
}
export function shardArguments(args) {
  if (args.length === 0) return { index: 1, count: 1 };
  assert.equal(args.length, 2, 'Supply both --shard-index and --shard-count');
  const values = {};
  for (const argument of args) {
    const match = /^--shard-(index|count)=([1-9]\d*)$/.exec(argument);
    assert.ok(match && !Object.hasOwn(values, match[1]), 'Invalid or duplicate source-test shard argument');
    values[match[1]] = Number(match[2]);
  }
  assert.ok(Object.hasOwn(values, 'index') && Object.hasOwn(values, 'count'), 'Incomplete source-test shard arguments');
  return values;
}
export function failedBatchExcerpt(log) {
  const lines = log.split('\n'), selected = new Set();
  for (const [index, line] of lines.entries()) {
    if (/^(?:not ok |# (?:Error|AssertionError)|Error:|AssertionError)/.test(line)) {
      for (let i = Math.max(0, index - 2); i < Math.min(lines.length, index + 18); i++) selected.add(i);
    }
  }
  const excerpt = selected.size
    ? [...selected].sort((a, b) => a - b).map(index => lines[index]).join('\n')
    : lines.slice(-40).join('\n');
  return excerpt.slice(0, 16_384);
}
export function parseSuccessfulSummary(log) {
  const fields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
  const result = {};
  for (const field of fields) {
    const valuePattern = field === 'duration_ms' ? '[0-9]+(?:\\.[0-9]+)?' : '[0-9]+';
    const matches = [...log.matchAll(new RegExp(`^# ${field} (${valuePattern})$`, 'gm'))];
    assert.equal(matches.length, 1, `Missing or ambiguous ${field} summary`);
    result[field] = Number(matches[0][1]);
    assert.ok(Number.isFinite(result[field]) && result[field] >= 0, `Invalid ${field} summary`);
    if (field !== 'duration_ms') assert.ok(Number.isSafeInteger(result[field]), `Invalid ${field} summary`);
  }
  assert.ok(result.tests > 0 && result.pass > 0);
  assert.equal(result.fail, 0); assert.equal(result.cancelled, 0); assert.equal(result.todo, 0);
  assert.equal(result.tests, result.pass + result.skipped);
  assert.ok(!/^not ok /m.test(log), 'Failure in batch output');
  return result;
}
// Collect ordinary test failures without weakening the successful TAP contract.
// Infrastructure failures still stop immediately: no surviving child may be
// allowed to overlap the next serial batch.
export function recordStrictBatch(result, attempt, log) {
  result.attempts.push(attempt);
  assert.equal(attempt.signal, null, 'Batch infrastructure signal');
  assert.ok(Number.isInteger(attempt.code) && attempt.code >= 0, 'Missing batch exit status');
  assert.ok(attempt.code <= 1, 'Batch infrastructure exit; later batches withheld');
  try {
    assert.equal(attempt.code, 0, 'Batch exited nonzero');
    const summary = parseSuccessfulSummary(log);
    result.batches.push({ ...attempt, ...summary });
    return true;
  } catch (error) {
    attempt.validationError = error.message;
    return false;
  }
}
export function assertSuccessfulFullCoverage(files, result) {
  assertFullCoverage(files, result.attempts.map(attempt => attempt.files));
  const failed = result.attempts.filter(attempt => attempt.validationError);
  assert.equal(failed.length, 0, `${failed.length} failed batches; inspect original attempt logs`);
  assertFullCoverage(files, result.batches.map(batch => batch.files));
}
export async function sourceInventory(repositoryRoot = repository) {
  const root = resolve(repositoryRoot);
  await assertNoAdjacentJavaScript(join(root, 'apps/server/src'));
  await assertNoAdjacentJavaScript(join(root, 'packages/shared/src'));
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Source inventory refuses symbolic links');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
    }
  }
  await visit('apps/server/src'); await visit('packages/shared/src');
  for (const path of ['pnpm-lock.yaml', 'scripts/run-source-tests.mjs', 'scripts/verify-full-source-batches.mjs',
    'scripts/source-shadow-guard.mjs', 'scripts/source-shadow-guard.test.mjs',
    'scripts/verify-full-source-batches.test.mjs', 'tsconfig.base.json', 'apps/server/tsconfig.json', 'packages/shared/tsconfig.json']) {
    result.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
  }
  for (const optional of ['scripts/ci-source-shards.mjs', 'scripts/ci-source-shards.test.mjs']) {
    if (existsSync(join(root, optional))) {
      result.push({ path: optional, sha256: createHash('sha256').update(await readFile(join(root, optional))).digest('hex') });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function createExclusiveEvidenceDirectory(directory) {
  await mkdir(dirname(resolve(directory)), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 }); // Leaf remains exclusive; never reuse an earlier run.
}
export async function verifyFullSourceBatches(directory, options = {}) {
  const shard = Number.isSafeInteger(options.index) && Number.isSafeInteger(options.count)
    ? { index: options.index, count: options.count }
    : options.shard ?? { index: 1, count: 1 };
  const root = resolve(options.repositoryRoot ?? repository);
  const batchMaximum = options.batchMaximum ?? FULL_SUITE_BATCH_MAXIMUM;
  assert.ok(Number.isSafeInteger(batchMaximum) && batchMaximum >= 1 && batchMaximum <= 128, 'Invalid full-suite batch size');
  await createExclusiveEvidenceDirectory(directory);
  const fullManifest = await discoverTests(join(root, 'apps/server/src'));
  const files = selectShard(fullManifest, shard.index, shard.count);
  const source = await sourceInventory(root);
  const sizes = new Map(await Promise.all(files.map(async file =>
    [file, (await stat(join(root, 'apps/server/src', file))).size])));
  const batches = partitionSourceManifest(files, sizes, batchMaximum);
  const result = { version: 1, target: 'server', passed: false, startedAt: new Date().toISOString(),
    repositoryRoot: root, verifierSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    concurrency: Math.min(4, batchMaximum), batchTimeoutMs: 900_000, batchMaximum,
    batchSourceByteMaximum: FULL_SUITE_BATCH_SOURCE_BYTES, shard, fullManifest, files, source, batches: [], attempts: [] };
  try {
    for (const [index, selected] of batches.entries()) {
      assert.deepEqual(await sourceInventory(root), source, 'Source changed before batch ' + (index + 1));
      const logPath = join(directory, `batch-${index + 1}.log`);
      const output = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
      const code = await new Promise((resolveCode, reject) => {
        const child = spawn(process.execPath, [join(root, 'scripts/run-source-tests.mjs'), 'server', ...selected],
          { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
        output.once('error', reject); child.once('error', reject);
        child.once('close', (code, signal) => output.end(() => resolveCode({ code, signal })));
      });
      const log = await readFile(logPath, 'utf8');
      // Keep the failed/timeout attempt and original evidence, not only green
      // batches. A truncated TAP log never counts as complete acceptance.
      const attempt = { files: selected, sourceBytes: selected.reduce((sum, file) => sum + sizes.get(file), 0),
        log: logPath, ...code, sha256: createHash('sha256').update(log).digest('hex') };
      let passed;
      try { passed = recordStrictBatch(result, attempt, log); }
      catch (error) {
        console.error('Original batch infrastructure failure (bounded):\n' + failedBatchExcerpt(log));
        throw error;
      }
      assert.deepEqual(await sourceInventory(root), source, 'Source changed during batch ' + (index + 1));
      console.log(`Batch ${index + 1}/${batches.length}: ${selected.length} files, ${passed
        ? `passed ${result.batches.at(-1).pass}` : `FAILED; preserved ${logPath}`}`);
      if (!passed) console.error('Original failed batch output (bounded):\n' + failedBatchExcerpt(log));
    }
    assertSuccessfulFullCoverage(files, result);
    assert.deepEqual(await discoverTests(join(root, 'apps/server/src')), fullManifest);
    assert.deepEqual(await sourceInventory(root), source, 'Source changed during verification');
    result.passed = true;
    result.completedAt = new Date().toISOString();
    console.log(shard.count === 1
      ? `# FULL source manifest verified: ${files.length} files; no omissions or duplicates`
      : `# SHARD ${shard.index}/${shard.count} verified: ${files.length}/${fullManifest.length} source files; exact disjoint selection`);
    for (const field of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
      console.log(`# ${field} ${result.batches.reduce((sum, batch) => sum + batch[field], 0)}`);
    }
  } catch (error) {
    result.failure = error.message;
    throw error;
  } finally {
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Usage: node scripts/verify-full-source-batches.mjs EXCLUSIVE_EVIDENCE_DIRECTORY [--shard-index=N --shard-count=N | FROZEN_REPOSITORY BATCH_SIZE]');
  const rest = process.argv.slice(3);
  const options = rest.length === 2 && !rest[0].startsWith('--')
    ? { repositoryRoot: resolve(rest[0]), batchMaximum: Number(rest[1]) }
    : shardArguments(rest);
  await verifyFullSourceBatches(resolve(process.argv[2]), options);
}
