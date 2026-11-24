import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadTimings } from './read-timings.js';
import { ProjectionSpaceBudget, StorageSpaceDeferred } from './space-budget.js';
import { configureOwnedWal, checkpointOwnedWal, ownedStorageStats } from './owned-sqlite.js';
import { createHistoryPreparation } from '../refresh/history-preparation.js';

test('JSON timing excludes byte accounting on success and parse failure', t => {
  let now = 0;
  const original = Buffer.byteLength;
  t.mock.method(performance, 'now', () => now++);
  t.mock.method(Buffer, 'byteLength', (value: string) => { now += 100; return original(value); });
  const timings = new ReadTimings();
  assert.deepEqual(timings.parse('{}'), {});
  assert.throws(() => timings.parse('bad'));
  assert.deepEqual(timings.snapshot(), { sqlSteps: 0, sqlMs: 0, sqlMaxMs: 0, jsonCalls: 2, jsonMs: 2, jsonBytes: 5 });
});

test('timed SQLite iterator releases early-break and parse failures remain visible', () => {
  const db = new DatabaseSync(':memory:'), timings = new ReadTimings();
  try {
    db.exec('CREATE TABLE samples(data TEXT); INSERT INTO samples VALUES(\'{}\'),(\'[]\')');
    for (const row of timings.rows(db.prepare('SELECT data FROM samples').iterate())) { timings.parse(String(row.data)); break; }
    db.exec('DROP TABLE samples'); // A leaked active iterator locks this operation.
    assert.throws(() => timings.parse('invalid'));
    const stats = timings.snapshot(); assert.equal(stats.sqlSteps, 1); assert.equal(stats.jsonCalls, 2); assert.equal(stats.jsonBytes, 9);
    assert.ok(stats.sqlMs >= 0 && stats.jsonMs >= 0);
  } finally { db.close(); }
});
test('temporary projection space budget checks periodically and rejects before new writes', async () => {
  let calls = 0, now = 0, free = 1024n ** 3n;
  const budget = new ProjectionSpaceBudget('test', async () => { calls++; return free; }, () => now);
  for (let i = 0; i < 16; i++) await budget.consume(1024 * 1024);
  assert.equal(calls, 1);
  free = 256n * 1024n * 1024n;
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  assert.equal(calls, 2);
  free = 1024n ** 3n;
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  now = 1000; await budget.consume(1);
  await assert.rejects(budget.consume(-1));
  const prepare = createHistoryPreparation();
  assert.equal(await prepare('space', async () => { throw new StorageSpaceDeferred(); }, () => false, new AbortController().signal), 'pending');
});

test('space allowance expires without polling; idle credits cannot survive disk exhaustion', async () => {
  let calls = 0, now = 0, free = 1024n ** 3n;
  const budget = new ProjectionSpaceBudget('test', async () => { calls++; return free; }, () => now);
  await budget.consume(0); assert.equal(calls, 0);
  await budget.consume(1); assert.equal(calls, 1);
  now = 4999; await budget.consume(1); assert.equal(calls, 1);
  now = 5000; free = 256n * 1024n * 1024n;
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  assert.equal(calls, 2);
  now = 20_000; assert.equal(calls, 2, 'no idle timer or statfs polling');
  free = 1024n ** 3n; await budget.consume(1); assert.equal(calls, 3);
  now = 1; await budget.consume(1); assert.equal(calls, 4, 'clock reversal invalidates cached credits');
});

test('concurrent writes coalesce space reads but do not multiply credits; errors recover', async () => {
  let calls = 0, fail = false;
  const budget = new ProjectionSpaceBudget('test', async () => {
    calls++;
    await new Promise<void>(resolve => setImmediate(resolve));
    if (fail) throw Object.assign(Error('fixture'), { code: 'EIO' });
    return 1024n ** 3n;
  }, () => 0);
  await Promise.all(Array.from({ length: 32 }, () => budget.consume(1024 * 1024)));
  assert.equal(calls, 2, '32MiB consumes two 16MiB batches, not 32 statfs or one multiplied allowance');
  fail = true;
  const rejected = await Promise.allSettled([budget.consume(1), budget.consume(1)]);
  assert.equal(calls, 3); assert.ok(rejected.every(r => r.status === 'rejected'));
  fail = false; await budget.consume(1); assert.equal(calls, 4);
});

test('large single writes check exact bigint reserve, including the safe-integer boundary', async () => {
  const reserve = 256n * 1024n * 1024n;
  const bytes = Number.MAX_SAFE_INTEGER;
  let now = 0, free = reserve + BigInt(bytes) - 1n;
  const budget = new ProjectionSpaceBudget('test', async () => free, () => now);
  await assert.rejects(budget.consume(bytes), StorageSpaceDeferred);
  free++;
  // The original entry boundary remains exact; a previously denied budget
  // also requires the recovery margin and an elapsed retry interval.
  await new ProjectionSpaceBudget('fresh', async () => free, () => now).consume(bytes);
  now = 1000;
  await assert.rejects(budget.consume(bytes), StorageSpaceDeferred);
  free += 64n * 1024n * 1024n; now = 2000;
  await budget.consume(bytes);
  for (const bad of [NaN, Infinity, -1, 0.5, bytes + 1]) await assert.rejects(budget.consume(bad));
});

test('PASSIVE checkpoint does not invalidate a pinned reader or pretend all WAL frames were checkpointed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-wal-reader-test-')), file = join(root, 'fixture.sqlite');
  const writer = new DatabaseSync(file); let reader: DatabaseSync | undefined;
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(1)');
    configureOwnedWal(writer); checkpointOwnedWal(writer);
    // Second connection is ONLY this isolated test fixture, never a live owner.
    reader = new DatabaseSync(file); reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM fixture').get()!.n, 1);
    writer.exec('INSERT INTO fixture VALUES(2)');
    const pinned = checkpointOwnedWal(writer); assert.equal(pinned.deferred, false);
    if (!pinned.deferred) assert.ok(pinned.logFrames > pinned.checkpointedFrames);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM fixture').get()!.n, 1);
    reader.exec('COMMIT');
    const released = checkpointOwnedWal(writer);
    if (!released.deferred) assert.equal(released.logFrames, released.checkpointedFrames);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM fixture').get()!.n, 2);
  } finally { reader?.close(); writer.close(); await rm(root, { recursive: true, force: true }); }
});
test('owned WAL configuration preserves FULL durability, explicit checkpoint and numeric disk diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-wal-test-')), file = join(root, 'state.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); configureOwnedWal(db);
    assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    assert.equal(db.prepare('PRAGMA journal_size_limit').get()!.journal_size_limit, 67108864);
    db.exec('CREATE TABLE fixture(id INTEGER); BEGIN; INSERT INTO fixture VALUES(1)');
    assert.deepEqual(checkpointOwnedWal(db), { deferred: true }); db.exec('COMMIT');
    const before = await ownedStorageStats(file); assert.ok(before.databaseBytes > 0 && before.walBytes > 0);
    const result = checkpointOwnedWal(db); assert.equal(result.deferred, false);
    if (!result.deferred) { assert.equal(result.busy, 0); assert.equal(result.logFrames, result.checkpointedFrames); }
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
