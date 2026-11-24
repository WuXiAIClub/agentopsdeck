import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexRolloutReader } from './rollout-reader.js';
import type { RolloutProjection } from './rollout-projection.js';

const row = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n';
const source = row('original') + JSON.stringify({ type: 'response_item', payload: {
  type: 'reasoning', encrypted_content: 'x'.repeat(2 * 1024 * 1024),
} }) + '\n';
async function text(projection: RolloutProjection) {
  let result = ''; for await (const line of projection) result += line;
  return result;
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for deterministic read barrier');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
function fixture(t: test.TestContext, options: ConstructorParameters<typeof CodexRolloutReader>[0] = {}, expectedCloseFailure?: RegExp) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-coalesced-history-'));
  const file = join(directory, 'rollout.jsonl');
  writeFileSync(file, source);
  const reader = new CodexRolloutReader(options);
  t.after(async () => {
    if (expectedCloseFailure) await assert.rejects(reader.close(), expectedCloseFailure);
    else await reader.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  });
  return { file, reader };
}
function barrier(t: test.TestContext, file: string | string[], duplicateClose?: () => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = 0, opened = 0, closed = 0;
  const original = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (!(Array.isArray(file) ? file.includes(String(args[0])) : args[0] === file)) return handle;
    opened++;
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    let first = true;
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      if (first) { first = false; blocked++; await gate; }
      return result;
    });
    t.mock.method(handle, 'close', async () => {
      await close(); closed++;
      if (first && duplicateClose) await duplicateClose();
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(release);
  return { release, stats: () => ({ blocked, opened, closed }) };
}

for (const append of [false, true]) {
  test(`${append ? 'appended' : 'cold'} identical snapshots share a scan and keep independent disk leases`, async t => {
    const { file, reader } = fixture(t, { projectionMemoryBytes: 0 });
    if (append) { await reader.validate(file); appendFileSync(file, row('appended')); }
    const initial = reader.cacheStats();
    const gate = barrier(t, file);
    const first = reader.readSnapshot(file);
    await until(() => gate.stats().blocked === 1);
    const peers = Array.from({ length: 7 }, () => reader.readSnapshot(file));
    await until(() => reader.cacheStats().coalescedReads === 7);
    gate.release();
    const leases = await Promise.all([first, ...peers]);
    try {
      const stats = reader.cacheStats();
      assert.equal(stats.sourceBytesRead - initial.sourceBytesRead, Buffer.byteLength(source + (append ? row('appended') : '')));
      assert.equal(stats.misses - initial.misses, 1);
      assert.equal(stats.inFlightReads, 0);
      assert.deepEqual(gate.stats(), { blocked: 1, opened: 8, closed: 8 });
      await leases[0]!.dispose();
      await reader.close();
      for (const lease of leases.slice(1)) assert.match(await text(lease), append ? /appended/ : /original/);
    } finally { await Promise.all(leases.map(lease => lease.dispose())); }
  });
}

test('live-prefix callers never lend their weaker consistency to stable admission', async t => {
  const { file, reader } = fixture(t);
  const gate = barrier(t, file);
  const live = reader.read(file, { consistency: 'live-prefix' });
  await until(() => gate.stats().blocked === 1);
  const stable = reader.read(file);
  const stableFailure = assert.rejects(stable, /changed during read/);
  await until(() => gate.stats().blocked === 2);
  appendFileSync(file, row('later'));
  gate.release();
  assert.doesNotMatch(await live, /later/);
  await stableFailure;
  assert.equal(reader.cacheStats().coalescedReads, 0);
  assert.match(await reader.read(file), /later/);
});

test('newly appended revisions are not merged with an older in-flight live prefix', async t => {
  const { file, reader } = fixture(t);
  const gate = barrier(t, file);
  const older = reader.read(file, { consistency: 'live-prefix' });
  await until(() => gate.stats().blocked === 1);
  appendFileSync(file, row('new-revision'));
  const newer = reader.read(file, { consistency: 'live-prefix' });
  await until(() => gate.stats().blocked === 2);
  gate.release();
  assert.doesNotMatch(await older, /new-revision/);
  assert.match(await newer, /new-revision/);
  assert.equal(reader.cacheStats().coalescedReads, 0);
});

test('path replacement cannot join the previous inode', async t => {
  const { file, reader } = fixture(t);
  const gate = barrier(t, file);
  const older = reader.read(file, { consistency: 'live-prefix' });
  // A rename can change ctime on the old open inode; either reject it or return
  // its original verified snapshot, never pretend it contains the replacement.
  const olderResult = older.then(value => ({ value }), error => ({ error }));
  await until(() => gate.stats().blocked === 1);
  renameSync(file, file + '.old'); writeFileSync(file, source.replace('original', 'replaced'));
  const newer = reader.read(file);
  await until(() => gate.stats().blocked === 2);
  gate.release();
  const result = await olderResult;
  if ('value' in result) assert.doesNotMatch(result.value, /replaced/);
  else assert.match(String(result.error), /changed/);
  assert.match(await newer, /replaced/);
  assert.equal(reader.cacheStats().coalescedReads, 0);
});

test('shared failures reach every waiter, release coordination state, and allow fresh retry', async t => {
  const { file, reader } = fixture(t);
  const gate = barrier(t, file);
  const first = reader.read(file);
  const failed = [assert.rejects(first, /changed during read/)];
  await until(() => gate.stats().blocked === 1);
  failed.push(assert.rejects(reader.read(file), /changed during read/));
  await until(() => reader.cacheStats().coalescedReads === 1);
  appendFileSync(file, row('retry'));
  gate.release(); await Promise.all(failed);
  assert.equal(reader.cacheStats().inFlightReads, 0);
  assert.equal(reader.cacheStats().entries, 0);
  assert.match(await reader.read(file), /retry/);
});

test('close during shared work rejects all waiters without publishing a cache entry', async t => {
  const { file, reader } = fixture(t, { projectionMemoryBytes: 0 });
  const gate = barrier(t, file);
  const failed = [assert.rejects(reader.read(file), /reader closed/)];
  await until(() => gate.stats().blocked === 1);
  failed.push(assert.rejects(reader.read(file), /reader closed/));
  await until(() => reader.cacheStats().coalescedReads === 1);
  const closing = reader.close();
  let closed = false; closing.then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'close waits for the original shared scan');
  gate.release(); await Promise.all(failed); await closing;
  assert.equal(reader.cacheStats().inFlightReads, 0);
  assert.equal(reader.cacheStats().entries, 0);
  assert.equal(gate.stats().opened, gate.stats().closed);
});

test('consumer coordination is bounded and overflow reads still succeed', async t => {
  const { file, reader } = fixture(t);
  const gate = barrier(t, file);
  const first = reader.read(file);
  await until(() => gate.stats().blocked === 1);
  const others = Array.from({ length: 64 }, () => reader.read(file));
  await until(() => gate.stats().blocked === 2 && reader.cacheStats().coalescedReads === 63);
  gate.release();
  for (const result of await Promise.all([first, ...others])) assert.match(result, /original/);
  assert.equal(reader.cacheStats().inFlightReads, 0);
  assert.equal(gate.stats().opened, gate.stats().closed);
});

test('snapshot coordination map is bounded without denying overflow reads', async t => {
  const { file, reader } = fixture(t);
  writeFileSync(file, row('original'));
  // Equivalent paths intentionally do not share a key: no canonical-path or
  // inode-only cache aliasing is introduced by the reader.
  const aliases = Array.from({ length: 129 }, (_, i) => file.replace('rollout.jsonl', './'.repeat(i) + 'rollout.jsonl'));
  const gate = barrier(t, aliases);
  const reads = aliases.map(alias => reader.read(alias));
  await until(() => gate.stats().blocked === 129);
  assert.equal(reader.cacheStats().inFlightReads, 128);
  gate.release();
  for (const result of await Promise.all(reads)) assert.match(result, /original/);
  assert.equal(reader.cacheStats().inFlightReads, 0);
  assert.equal(gate.stats().opened, gate.stats().closed);
});

test('coalescing does not accept rewritten cached prefixes as appends', async t => {
  const { file, reader } = fixture(t);
  await reader.validate(file);
  writeFileSync(file, source.replace('original', 'modified') + row('appended'));
  const gate = barrier(t, file);
  const failed = [assert.rejects(reader.read(file), /prefix changed/)];
  await until(() => gate.stats().blocked === 1);
  failed.push(assert.rejects(reader.read(file), /prefix changed/));
  await until(() => reader.cacheStats().coalescedReads === 1);
  gate.release(); await Promise.all(failed);
  assert.equal(reader.cacheStats().entries, 0);
  assert.match(await reader.read(file), /modified/);
});

test('truncation rejects all shared live-prefix waiters', async t => {
  const { file, reader } = fixture(t);
  const gate = barrier(t, file);
  const failed = [assert.rejects(reader.read(file, { consistency: 'live-prefix' }), /truncated/ )];
  await until(() => gate.stats().blocked === 1);
  failed.push(assert.rejects(reader.read(file, { consistency: 'live-prefix' }), /truncated/));
  await until(() => reader.cacheStats().coalescedReads === 1);
  truncateSync(file, 0);
  gate.release(); await Promise.all(failed);
  assert.equal(reader.cacheStats().inFlightReads, 0);
  assert.equal(await reader.read(file), '');
});

test('shared disk leases survive zero retention budgets and one early consumer release', async t => {
  const { file, reader } = fixture(t, { projectionMemoryBytes: 0, cachePolicy: { maxMemoryBytes: 0, maxDiskBytes: 0 } });
  const gate = barrier(t, file);
  const first = reader.readSnapshot(file);
  await until(() => gate.stats().blocked === 1);
  const second = reader.readSnapshot(file);
  await until(() => reader.cacheStats().coalescedReads === 1);
  gate.release();
  const leases = await Promise.all([first, second]);
  try {
    assert.equal(reader.cacheStats().entries, 0);
    await leases[0].dispose(); await reader.close();
    assert.match(await text(leases[1]), /original/);
  } finally { await Promise.all(leases.map(lease => lease.dispose())); }
});

test('reference switch disables sharing without changing snapshot content', async t => {
  const { file, reader } = fixture(t, { shareConcurrentReads: false });
  const gate = barrier(t, file);
  const reads = [reader.read(file), reader.read(file)];
  await until(() => gate.stats().blocked === 2);
  gate.release();
  const results = await Promise.all(reads);
  assert.equal(results[0], results[1]);
  assert.equal(reader.cacheStats().sourceBytesRead, Buffer.byteLength(source) * 2);
  assert.equal(reader.cacheStats().coalescedReads, 0);
});

test('slow duplicate close retains its producer lease even after the first caller releases', async t => {
  const { file, reader } = fixture(t, { projectionMemoryBytes: 0, cachePolicy: { maxMemoryBytes: 0, maxDiskBytes: 0 } });
  let finishClose!: () => void;
  const delayed = new Promise<void>(resolve => { finishClose = resolve; });
  t.after(() => finishClose());
  const gate = barrier(t, file, () => delayed);
  const first = reader.readSnapshot(file);
  await until(() => gate.stats().blocked === 1);
  const second = reader.readSnapshot(file);
  await until(() => reader.cacheStats().coalescedReads === 1);
  gate.release();
  await (await first).dispose();
  assert.equal(reader.cacheStats().entries, 0);
  assert.equal(reader.cacheStats().inFlightReads, 0, 'settled work must not accept new joiners');
  finishClose();
  const lease = await second;
  try { assert.match(await text(lease), /original/); }
  finally { await lease.dispose(); }
});

test('duplicate descriptor close failure is isolated from successful shared consumers', async t => {
  const { file, reader } = fixture(t, { projectionMemoryBytes: 0, cachePolicy: { maxMemoryBytes: 0, maxDiskBytes: 0 } }, /synthetic duplicate close failure/);
  const gate = barrier(t, file, async () => { throw Error('synthetic duplicate close failure'); });
  const first = reader.read(file);
  await until(() => gate.stats().blocked === 1);
  const failed = assert.rejects(reader.read(file), /synthetic duplicate close failure/);
  await until(() => reader.cacheStats().coalescedReads === 1);
  gate.release();
  assert.match(await first, /original/); await failed;
  assert.equal(reader.cacheStats().entries, 0);
  assert.equal(reader.cacheStats().inFlightReads, 0);
  assert.equal(gate.stats().opened, gate.stats().closed);
  await assert.rejects(reader.close(), /synthetic duplicate close failure/);
  assert.equal(reader.cacheStats().cleanupFailed, true);
});
