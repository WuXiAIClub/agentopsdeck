import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutProjectionBuilder, type RolloutProjection } from './rollout-projection.js';
import { CodexRolloutReader } from './rollout-reader.js';
import { codexRolloutUsage } from './usage.js';
import { requireInterruptedDispatchSettled } from './interrupted-dispatch.js';
import { ProjectionSpaceBudget, StorageSpaceDeferred, temporaryProjectionSpaceBudget } from '../storage/space-budget.js';

const collect = async (source: AsyncIterable<string>) => { const lines: string[] = []; for await (const line of source) lines.push(line); return lines; };

test('two memory history readers let native IO run before either finishes', async () => {
  const builders = [new RolloutProjectionBuilder(), new RolloutProjectionBuilder()];
  const rows = Array.from({ length: 8192 }, (_, index) => JSON.stringify({ index, text: '历史🙂' }));
  const projections: RolloutProjection[] = [];
  try {
    for (const builder of builders) {
      for (const row of rows) await builder.add(row + '\n');
      projections.push(await builder.finish());
    }
    let completed = 0, completedAtNativeIO = -1;
    const nativeIO = new Promise<void>(resolve => setImmediate(() => { completedAtNativeIO = completed; resolve(); }));
    const reads = projections.map(async projection => { const result = await collect(projection); completed++; return result; });
    const results = await Promise.all(reads);
    await nativeIO;
    assert.equal(completedAtNativeIO, 0, 'async iteration must not monopolize microtasks until both histories finish');
    assert.deepEqual(results, [rows, rows], 'cooperative scheduling must not lose/reorder history');
  } finally {
    await Promise.all(projections.map(projection => projection.dispose()));
    await Promise.all(builders.map(builder => builder.abort()));
  }
});

test('a single source chunk yields while parsing records, not only at its next disk read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rollout-fair-scan-'));
  const reader = new CodexRolloutReader();
  const file = join(directory, 'history.jsonl');
  const records = 8192;
  const row = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'synthetic', model: 'fixture' } }) + '\n';
  assert.ok(Buffer.byteLength(row) * records < 1024 * 1024, 'one source read');
  await writeFile(file, row.repeat(records));
  let parsed = 0, parsedAtNativeIO = -1;
  let nativeIO: Promise<void> | undefined;
  const add = RolloutProjectionBuilder.prototype.add;
  t.mock.method(RolloutProjectionBuilder.prototype, 'add', async function(this: RolloutProjectionBuilder, line: string) {
    parsed++;
    if (!nativeIO) nativeIO = new Promise<void>(resolve => setImmediate(() => { parsedAtNativeIO = parsed; resolve(); }));
    return add.call(this, line);
  });
  try {
    const projection = await reader.readSnapshot(file);
    try {
      await nativeIO;
      assert.ok(parsedAtNativeIO > 0 && parsedAtNativeIO < records, 'source parsing must service native IO within the chunk');
      assert.equal((await collect(projection)).length, records);
    } finally { await projection.dispose(); }
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test('default builders share the process budget; memory projections do not consume disk credits', async t => {
  const writes: number[] = [];
  t.mock.method(temporaryProjectionSpaceBudget, 'consume', async (bytes: number) => { writes.push(bytes); });
  for (const limit of [0, 0, 1024]) {
    const builder = new RolloutProjectionBuilder(limit);
    try {
      await builder.add('{}\n');
      const projection = await builder.finish();
      try { assert.deepEqual(await collect(projection), ['{}']); }
      finally { await projection.dispose(); }
    } finally { await builder.abort(); }
  }
  assert.deepEqual(writes, [3, 3]);
});

test('concurrent builders consume one allowance, not a separate 16MiB per builder', async () => {
  let calls = 0;
  const space = new ProjectionSpaceBudget('fixture', async () => { calls++; return 1024n ** 3n; }, () => 0);
  const line = 'x'.repeat(1024 * 1024 - 1) + '\n';
  const builders = Array.from({ length: 3 }, () => new RolloutProjectionBuilder(0, space));
  try {
    await Promise.all(builders.map(async builder => {
      await builder.add(line);
      const projection = await builder.finish();
      try { assert.equal(projection.bytes, 1024 * 1024); assert.deepEqual(await collect(projection), [line.slice(0, -1)]); }
      finally { await projection.dispose(); }
    }));
    assert.equal(calls, 1);
    await space.consume(13 * 1024 * 1024);
    assert.equal(calls, 1);
    await space.consume(1);
    assert.equal(calls, 2, 'all three builders debited the same allowance');
  } finally { await Promise.all(builders.map(builder => builder.abort())); }
});

test('a new builder cannot bypass low-space backoff and can recover without changing old projections', async () => {
  let now = 0, free = 1024n ** 3n, calls = 0;
  const space = new ProjectionSpaceBudget('fixture', async () => { calls++; return free; }, () => now);
  const original = new RolloutProjectionBuilder(0, space);
  await original.add('{"kept":true}\n');
  const retained = await original.finish();
  try {
    free = 0n; now = 5000;
    for (let i = 0; i < 2; i++) {
      const builder = new RolloutProjectionBuilder(0, space);
      try {
        await builder.add('{}\n');
        await assert.rejects(builder.finish(), StorageSpaceDeferred);
      } finally { await builder.abort(); await builder.abort(); }
      await assert.rejects(builder.finish(), /closed/);
      assert.deepEqual(await collect(retained), ['{"kept":true}']);
    }
    assert.equal(calls, 2);
    now = 6000; free = 1024n ** 3n;
    const recovered = new RolloutProjectionBuilder(0, space);
    try {
      await recovered.add('{}\n');
      const projection = await recovered.finish();
      try { assert.deepEqual(await collect(projection), ['{}']); }
      finally { await projection.dispose(); }
    } finally { await recovered.abort(); }
    assert.equal(calls, 3);
  } finally { await retained.dispose(); await original.abort(); }
});

test('memory and disk projections preserve UTF-8 records and independent reader leases', async () => {
  for (const limit of [0, 8 * 1024 * 1024]) {
    const builder = new RolloutProjectionBuilder(limit);
    const rows = ['{"text":"你好🙂"}', JSON.stringify({ text: '🙂'.repeat(400_000) }), '{}'];
    for (const row of rows) await builder.add(row + '\n');
    const projection = await builder.finish(), lease = projection.fork();
    try {
      assert.equal(projection.memoryBytes, limit ? projection.bytes : 0);
      assert.deepEqual(await collect(projection), rows);
      assert.deepEqual(await Promise.all([collect(projection), collect(lease)]), [rows, rows]);
      await projection.dispose();
      assert.deepEqual(await collect(lease), rows, 'cache eviction cannot close a consumer snapshot');
      await assert.rejects(collect(projection), /released/);
    } finally { await projection.dispose(); await lease.dispose(); await builder.abort(); }
  }
});

test('append segments compact, partial tails rebuild, eviction and close retain active readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollout-snapshot-test-'));
  const file = join(directory, 'history.jsonl'), reader = new CodexRolloutReader({ projectionMemoryBytes: 0 });
  const row = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n';
  await writeFile(file, row('first'));
  const initial = await reader.readSnapshot(file);
  try {
    for (let i = 0; i < 68; i++) {
      await appendFile(file, row(`model-${i}`));
      const next = await reader.readSnapshot(file);
      try { assert.ok(next.segments <= 64); assert.equal((await collect(next)).length, i + 2); }
      finally { await next.dispose(); }
    }
    await appendFile(file, '{"type":"turn_context","payload":');
    const partial = await reader.readSnapshot(file); await partial.dispose();
    await appendFile(file, '{"model":"tail"}}\n');
    const complete = await reader.readSnapshot(file);
    try {
      assert.equal((await collect(complete)).length, 70);
      await reader.close();
      assert.match((await collect(complete)).at(-1)!, /tail/);
      assert.equal((await collect(initial)).length, 1);
      await assert.rejects(reader.readSnapshot(file), /closed/);
    } finally { await complete.dispose(); }
  } finally { await initial.dispose(); await reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test('disk-backed reductions preserve usage and interrupted executor fences', async () => {
  const builder = new RolloutProjectionBuilder(0);
  for (const row of [
    { type: 'session_meta' }, { type: 'compacted' },
    { type: 'turn_context', payload: { turn_id: 'turn' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'aborted by user' } },
  ]) await builder.add(JSON.stringify(row) + '\n');
  const projection = await builder.finish();
  try {
    assert.deepEqual(await codexRolloutUsage(projection), { contextUsedTokens: null, compactionCount: 1 });
    await assert.rejects(async () => requireInterruptedDispatchSettled(projection, { id: 'turn', status: 'interrupted' }), /cleanup is unconfirmed/);
  } finally { await projection.dispose(); }
});
