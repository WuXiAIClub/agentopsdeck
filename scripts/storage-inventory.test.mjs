import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, stat, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryStorage, parseInventoryArgs } from './storage-inventory.mjs';

test('inventory reports only aggregate metadata, skips symlinks and deduplicates hard links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'history.jsonl'), secretText = 'SYNTHETIC_DO_NOT_READ_OR_REPORT';
  await writeFile(source, secretText);
  await writeFile(join(root, 'state.sqlite-wal'), '123');
  await mkdir(join(root, 'nested'));
  await link(source, join(root, 'nested', 'duplicate.jsonl'));
  await symlink(root, join(root, 'nested', 'loop'));
  const before = await stat(source);
  const result = await inventoryStorage([{ label: 'native', directory: root }]);
  assert.equal(result.complete, true); assert.equal(result.roots[0].files, 2);
  assert.equal(result.roots[0].bytes, Buffer.byteLength(secretText) + 3);
  assert.equal(result.roots[0].duplicateFiles, 1); assert.equal(result.roots[0].symlinksSkipped, 1);
  assert.equal(result.roots[0].types['sqlite-wal'].bytes, 3);
  assert.ok(!JSON.stringify(result).includes(root)); assert.ok(!JSON.stringify(result).includes(secretText));
  assert.equal((await stat(source)).mtimeMs, before.mtimeMs); assert.equal(await readFile(source, 'utf8'), secretText);
});
test('inventory budgets and depth report partial results rather than claiming complete', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested', 'one'), '1'); await writeFile(join(root, 'two'), '22');
  const limited = await inventoryStorage([{ label: 'data', directory: root }], { maxEntries: 1 });
  assert.equal(limited.complete, false); assert.equal(limited.inspected, 1);
  assert.equal((await inventoryStorage([{ label: 'data', directory: root }], { maxDepth: 0 })).complete, false);
});
test('inventory rejects broad roots, relative paths, symlink roots and invalid budgets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(root, join(root, 'link'));
  for (const directory of ['/', 'relative', join(root, 'link')]) await assert.rejects(inventoryStorage([{ label: 'bad', directory }]));
  await assert.rejects(inventoryStorage([{ label: 'ok', directory: root }], { maxEntries: Infinity }));
  await assert.rejects(inventoryStorage([]));
});

test('age distribution distinguishes exact boundaries and future time without calling files reclaimable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sampledAtMs = Date.UTC(2026, 8, 28), dayMs = 86_400_000;
  const cases = [
    ['hot.jsonl', 0, 'lt-1d'], ['day.jsonl', 1, '1d-to-7d'], ['week.jsonl', 7, '7d-to-30d'],
    ['month.jsonl', 30, '30d-to-90d'], ['old.jsonl', 90, 'ge-90d'], ['future.jsonl', -1, 'unknown-or-future'],
    ['state.sqlite-wal', 100, 'ge-90d'],
  ];
  for (const [name, age] of cases) {
    const path = join(root, name), time = new Date(sampledAtMs - age * dayMs);
    await writeFile(path, '123'); await utimes(path, time, time);
  }
  await link(join(root, 'old.jsonl'), join(root, 'old-link.jsonl'));
  const result = await inventoryStorage([{ label: 'sample', directory: root }], { sampledAtMs });
  assert.equal(result.version, 2); assert.equal(result.ageBasis, 'mtime');
  assert.equal(result.coldnessProven, false); assert.equal(result.reclaimableBytes, null);
  const sample = result.roots[0];
  assert.equal(sample.files, 7); assert.equal(sample.duplicateFiles, 1);
  for (const key of new Set(cases.map(item => item[2]))) assert.equal(sample.ageBuckets[key].files, key === 'ge-90d' ? 2 : 1);
  assert.equal(sample.ageBuckets['ge-90d'].types['sqlite-wal'].bytes, 3, 'old WAL is counted, not labelled disposable');
  assert.equal(Object.values(sample.ageBuckets).reduce((sum, bucket) => sum + bucket.bytes, 0), sample.bytes);
  assert.ok(!JSON.stringify(result).includes(root)); assert.ok(!JSON.stringify(result).includes('old-link'));
  assert.equal(await readFile(join(root, 'old.jsonl'), 'utf8'), '123');
});

test('custom age thresholds apply and malformed threshold policies fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'history.jsonl'), now = Date.UTC(2026, 8, 28);
  await writeFile(file, '1'); await utimes(file, new Date(now - 14 * 86_400_000), new Date(now - 14 * 86_400_000));
  const roots = [{ label: 'data', directory: root }];
  const result = await inventoryStorage(roots, { sampledAtMs: now, ageThresholdsDays: [14, 60] });
  assert.equal(result.roots[0].ageBuckets['14d-to-60d'].files, 1);
  for (const ageThresholdsDays of [[], [0], [7, 1], [1, 1], [1.5], [NaN], [36501], Array.from({ length: 9 }, (_, i) => i + 1)])
    await assert.rejects(inventoryStorage(roots, { ageThresholdsDays }));
  for (const sampledAtMs of [NaN, Infinity, -1, 1.5, 8_640_000_000_000_001])
    await assert.rejects(inventoryStorage(roots, { sampledAtMs }));
});

test('CLI accepts explicit ages and roots, rejects unknown or duplicate options', () => {
  assert.deepEqual(parseInventoryArgs(['--age-days=14,60', 'native=/srv/agentopsdeck/sessions']), {
    roots: [{ label: 'native', directory: '/srv/agentopsdeck/sessions' }], options: { ageThresholdsDays: [14, 60] },
  });
  for (const args of [['--delete'], ['--age-days='], ['--age-days=-1'], ['--age-days=1', '--age-days=7'], ['missing-label']])
    assert.throws(() => parseInventoryArgs(args));
});

test('partial age inventory stays partial and does not extrapolate total cold storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++) await writeFile(join(root, `${i}.jsonl`), '12');
  const result = await inventoryStorage([{ label: 'data', directory: root }], { maxEntries: 1 });
  assert.equal(result.complete, false); assert.equal(result.roots[0].files, 1);
  assert.equal(Object.values(result.roots[0].ageBuckets).reduce((sum, bucket) => sum + bucket.bytes, 0), 2);
  assert.equal(result.reclaimableBytes, null);
});
