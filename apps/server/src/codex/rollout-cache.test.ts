import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, readFile, appendFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { CodexRolloutReader } from './rollout-reader.js';
import { RolloutProjection } from './rollout-projection.js';

const row = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
async function fixture(t: test.TestContext, options: ConstructorParameters<typeof CodexRolloutReader>[0] = {}, expectedCloseFailure?: RegExp) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-cache-test-'));
  const reader = new CodexRolloutReader(options);
  t.after(async () => {
    try {
      if (expectedCloseFailure) await assert.rejects(reader.close(), expectedCloseFailure);
      else await reader.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const files = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const file = join(directory, `${i}.jsonl`); await writeFile(file, row(`response ${i}`)); return file;
  }));
  return { reader, files };
}

for (const sharing of [false, true]) test(`display source versions validate exact files without rescanning; sharing=${sharing}`, async t => {
  const { reader, files } = await fixture(t, { shareConcurrentReads: sharing, projectionMemoryBytes: 0 });
  const [first, second] = await Promise.all([reader.readSnapshot(files[0]), reader.readSnapshot(files[0])]);
  const version = reader.sourceVersion(first), other = reader.sourceVersion(second);
  assert.ok(version); assert.ok(other); assert.deepEqual(version, other);
  await first.dispose(); await second.dispose();
  const before = reader.cacheStats();
  assert.equal(await reader.sourceUnchanged(version, 1000), true);
  assert.equal(reader.cacheStats().sourceBytesRead, before.sourceBytesRead);
  await appendFile(files[0]!, row('new content'));
  assert.equal(await reader.sourceUnchanged(version, 1000), false);
  const current = await reader.readSnapshot(files[0]);
  const currentVersion = reader.sourceVersion(current); assert.ok(currentVersion); await current.dispose();
  assert.equal(await reader.sourceUnchanged(currentVersion, 1000), true);
  const text = await readFile(files[0]!, 'utf8');
  await rename(files[0]!, `${files[0]}.old`); await writeFile(files[0]!, text);
  assert.equal(await reader.sourceUnchanged(currentVersion, 1000), false);
  await rm(files[0]!);
  assert.equal(await reader.sourceUnchanged(currentVersion, 1000), false);
  await reader.close();
  await assert.rejects(reader.sourceUnchanged(currentVersion, 1000), /closed/);
});

test('partial final records are never reusable display sources', async t => {
  const { reader, files } = await fixture(t);
  await writeFile(files[0]!, row('partial').trimEnd());
  const snapshot = await reader.readSnapshot(files[0]);
  const version = reader.sourceVersion(snapshot); assert.ok(version); await snapshot.dispose();
  assert.equal(await reader.sourceUnchanged(version, 1000), false);
});
test('eight open sessions stay hot across repeated sequential refreshes', async t => {
  const { reader, files } = await fixture(t);
  for (const file of files) await reader.validate(file);
  const cold = reader.cacheStats();
  for (let i = 0; i < 3; i++) for (const file of files) await reader.validate(file);
  const warm = reader.cacheStats();
  assert.equal(warm.entries, 8); assert.equal(warm.hits, 24); assert.equal(warm.misses, 8);
  assert.equal(warm.sourceBytesRead, cold.sourceBytesRead, 'unchanged warm snapshots do not reread native history');
  assert.equal(warm.evictions, 0);
});
test('four-entry comparison reproduces round-robin cache churn', async t => {
  const { reader, files } = await fixture(t, { cachePolicy: { maxEntries: 4 } });
  for (let i = 0; i < 2; i++) for (const file of files) await reader.validate(file);
  assert.equal(reader.cacheStats().hits, 0);
  assert.equal(reader.cacheStats().misses, 16);
  assert.equal(reader.cacheStats().entries, 4);
});
test('LRU and idle expiry evict ownership without losing leased disk snapshots', async t => {
  let now = 0;
  const { reader, files } = await fixture(t, { projectionMemoryBytes: 0, cachePolicy: { maxEntries: 2, maxIdleMs: 1000 }, now: () => now });
  const lease = await reader.readSnapshot(files[0]);
  try {
    await reader.validate(files[1]); await reader.validate(files[0]); await reader.validate(files[2]);
    const before = reader.cacheStats();
    await reader.validate(files[0]); assert.equal(reader.cacheStats().hits, before.hits + 1);
    now = 1001; await reader.validate(files[3]);
    assert.equal(reader.cacheStats().entries, 1);
    let text = ''; for await (const line of lease) text += line;
    assert.match(text, /response 0/);
    assert.equal(await readFile(files[0]!, 'utf8'), row('response 0'), 'eviction never modifies native files');
  } finally { await lease.dispose(); }
});
test('zero memory/disk cache budgets release retained ownership but not caller results', async t => {
  for (const projectionMemoryBytes of [0, 1024]) {
    const { reader, files } = await fixture(t, { projectionMemoryBytes, cachePolicy: { maxMemoryBytes: 0, maxDiskBytes: 0 } });
    assert.match(await reader.read(files[0]), /response 0/);
    const stats = reader.cacheStats(); assert.equal(stats.entries, 0); assert.equal(stats.memoryBytes, 0); assert.equal(stats.diskBytes, 0);
  }
});
test('changed and appended history is verified, stats are detached and close retires the cache', async t => {
  const { reader, files } = await fixture(t);
  await reader.validate(files[0]); const before = reader.cacheStats();
  await appendFile(files[0]!, row('new response'));
  assert.match(await reader.read(files[0]), /new response/);
  assert.ok(reader.cacheStats().sourceBytesRead > before.sourceBytesRead);
  before.policy.maxEntries = 1; assert.equal(reader.cacheStats().policy.maxEntries, 16);
  await reader.close(); assert.equal(reader.cacheStats().entries, 0);
  await assert.rejects(reader.read(files[0]), /closed/);
});

test('concurrent disk-backed consumers survive bounded eviction and reader shutdown', async t => {
  const { reader, files } = await fixture(t, { projectionMemoryBytes: 0, cachePolicy: { maxEntries: 2 } });
  const leases = await Promise.all(files.map(file => reader.readSnapshot(file)));
  try {
    assert.ok(reader.cacheStats().entries <= 2);
    await reader.close();
    assert.equal(reader.cacheStats().entries, 0);
    await Promise.all(leases.map(async (lease, i) => {
      let text = ''; for await (const line of lease) text += line;
      assert.match(text, new RegExp(`response ${i}`));
    }));
  } finally { await Promise.all(leases.map(lease => lease.dispose())); }
});

test('byte budgets still evict with a large entry allowance', async t => {
  for (const projectionMemoryBytes of [0, 1024]) {
    const baseline = await fixture(t, { projectionMemoryBytes });
    await baseline.reader.validate(baseline.files[0]);
    const size = baseline.reader.cacheStats();
    const { reader, files } = await fixture(t, { projectionMemoryBytes,
      cachePolicy: { maxEntries: 128, maxMemoryBytes: size.memoryBytes, maxDiskBytes: size.diskBytes } });
    for (const file of files) await reader.validate(file);
    const stats = reader.cacheStats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.evictions, 7);
    assert.ok(stats.memoryBytes <= size.memoryBytes);
    assert.ok(stats.diskBytes <= size.diskBytes);
  }
});

test('idle deadline releases cache without another read and preserves active disk leases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const { reader, files } = await fixture(t, { projectionMemoryBytes: 0, cachePolicy: { maxIdleMs: 1000 }, now: () => now });
  assert.equal(reader.cacheStats().idleExpiryScheduled, false);
  const lease = await reader.readSnapshot(files[0]);
  try {
    const before = reader.cacheStats();
    assert.ok(before.diskBytes > 0); assert.equal(before.idleExpiryScheduled, true);
    now = 1000; t.mock.timers.tick(1000); await nextTurn();
    const after = reader.cacheStats();
    assert.equal(after.entries, 0); assert.equal(after.diskBytes, 0);
    assert.equal(after.evictions, 1); assert.equal(after.idleExpiryScheduled, false);
    assert.equal(after.sourceBytesRead, before.sourceBytesRead, 'expiry does not read native history');
    let text = ''; for await (const line of lease) text += line;
    assert.match(text, /response 0/);
    assert.equal(await readFile(files[0]!, 'utf8'), row('response 0'));
    assert.match(await reader.read(files[0]), /response 0/, 'expired projection is rebuildable');
    assert.equal(reader.cacheStats().misses, 2);
  } finally { await lease.dispose(); }
});

test('a recently used entry survives the earlier deadline while cold entries expire', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const { reader, files } = await fixture(t, { cachePolicy: { maxIdleMs: 1000 }, now: () => now });
  await reader.validate(files[0]); await reader.validate(files[1]);
  now = 600; t.mock.timers.tick(600); await reader.validate(files[0]);
  const bytes = reader.cacheStats().sourceBytesRead;
  now = 1000; t.mock.timers.tick(400); await nextTurn();
  assert.equal(reader.cacheStats().entries, 1); assert.equal(reader.cacheStats().idleExpiryScheduled, true);
  assert.equal(reader.cacheStats().sourceBytesRead, bytes);
  now = 1599; t.mock.timers.tick(599); await nextTurn();
  assert.equal(reader.cacheStats().entries, 1);
  now = 1600; t.mock.timers.tick(1); await nextTurn();
  assert.equal(reader.cacheStats().entries, 0); assert.equal(reader.cacheStats().idleExpiryScheduled, false);
});

test('close cancels deadline and a timer already fired cannot rearm after shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const { reader, files } = await fixture(t, { cachePolicy: { maxIdleMs: 1000 }, now: () => now });
  await reader.validate(files[0]);
  now = 1000; t.mock.timers.tick(1000);
  await reader.close(); await nextTurn();
  assert.equal(reader.cacheStats().entries, 0); assert.equal(reader.cacheStats().idleExpiryScheduled, false);
  t.mock.timers.tick(100_000); await nextTurn();
  assert.equal(reader.cacheStats().idleExpiryScheduled, false);
  await assert.rejects(reader.read(files[0]), /closed/);
});

test('cache expiry uses one unref timer, not one per session or refresh', async t => {
  const timers = t.mock.method(globalThis, 'setTimeout');
  const { reader, files } = await fixture(t);
  for (const file of files) await reader.validate(file);
  for (const file of files) await reader.validate(file);
  assert.equal(timers.mock.callCount(), 1);
  const timer = timers.mock.calls[0]!.result;
  assert.ok(timer);
  assert.equal(timer.hasRef(), false);
  await reader.close();
  assert.equal(reader.cacheStats().idleExpiryScheduled, false);
});

test('zero-budget cache never leaves an idle timer behind', async t => {
  const { reader, files } = await fixture(t, { cachePolicy: { maxMemoryBytes: 0, maxDiskBytes: 0 } });
  await reader.validate(files[0]);
  assert.equal(reader.cacheStats().entries, 0);
  assert.equal(reader.cacheStats().idleExpiryScheduled, false);
});

test('real idle deadline releases memory and disk-backed ownership without further traffic', async t => {
  const readers = await Promise.all([0, 1024].map(projectionMemoryBytes => fixture(t, {
    projectionMemoryBytes, cachePolicy: { maxIdleMs: 1000 },
  })));
  for (const { reader, files } of readers) await reader.validate(files[0]);
  await delay(1200);
  for (const { reader } of readers) {
    assert.equal(reader.cacheStats().entries, 0);
    assert.equal(reader.cacheStats().memoryBytes, 0); assert.equal(reader.cacheStats().diskBytes, 0);
    assert.equal(reader.cacheStats().idleExpiryScheduled, false); assert.equal(reader.cacheStats().idleCleanupFailures, 0);
  }
});

test('background disposal errors are contained and counted without an unhandled rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const { reader, files } = await fixture(t, { cachePolicy: { maxIdleMs: 1000 }, now: () => now }, /synthetic cleanup failure/);
  await reader.validate(files[0]);
  const dispose = RolloutProjection.prototype.dispose;
  t.mock.method(RolloutProjection.prototype, 'dispose', async function (this: RolloutProjection) {
    await dispose.call(this); // Release the synthetic fixture before injecting failure.
    throw Error('synthetic cleanup failure');
  });
  now = 1000; t.mock.timers.tick(1000); await nextTurn();
  assert.equal(reader.cacheStats().idleCleanupFailures, 1);
  assert.equal(reader.cacheStats().idleExpiryScheduled, false);
  assert.equal(reader.cacheStats().cleanupFailed, true);
  const closing = reader.close();
  await assert.rejects(closing, /synthetic cleanup failure/);
  assert.equal(reader.close(), closing, 'background cleanup failure cannot become successful on close retry');
});
