/** Opt-in Codex native-file/projection capacity fixture, not a model or HTTP
 * benchmark. Run: node --import tsx benchmarks/rollout-capacity.mts --mib=512 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';
import type { RolloutProjection } from '../src/codex/rollout-projection.js';

const args = process.argv.slice(2), MiB = 1024 ** 2;
assert.ok(args.length <= 1 && args.every(a => /^--mib=\d+$/.test(a)));
const mib = Number(args[0]?.split('=')[1] ?? 512);
assert.ok(Number.isSafeInteger(mib) && mib >= 16 && mib <= 1024);
const free = async () => { const s = await statfs(tmpdir()); return s.bavail * s.bsize; };
assert.ok(await free() > 4096 * MiB + mib * MiB * 2.5, 'Insufficient headroom; no fixture created');
const dir = await mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-capacity-')), file = join(dir, 'synthetic.jsonl');
const reader = new CodexRolloutReader();
const leases: RolloutProjection[] = [];
const rounded = (n: number) => Math.round(n * 1000) / 1000;
async function digest(projection: RolloutProjection) {
  const hash = createHash('sha256'); let lines = 0;
  for await (const line of projection) { hash.update(line).update('\n'); lines++; }
  return { hash: hash.digest('hex'), lines };
}
try {
  const handle = await open(file, 'wx', 0o600);
  let bytes = 0, rows = 0;
  try {
    const text = 'Synthetic 测试 🐟 '.repeat(512);
    while (bytes < mib * MiB) {
      if (rows % 256 === 0) assert.ok(await free() > 4096 * MiB + mib * MiB * 1.1, 'Operational reserve reached');
      const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', id: String(rows++), role: 'assistant', content: [{ text }] } }) + '\n';
      await handle.appendFile(line); bytes += Buffer.byteLength(line);
    }
  } finally { await handle.close(); }
  const start = performance.now(), cold = await reader.readSnapshot(file); leases.push(cold);
  const coldMs = rounded(performance.now() - start), coldDigest = await digest(cold);
  assert.equal(coldDigest.lines, rows);
  assert.ok(cold.memoryBytes <= 8 * MiB);
  if (mib >= 512) assert.ok(cold.bytes > 256 * MiB, 'exercise snapshots beyond the legacy string limit');
  const beforeWarm = reader.cacheStats(), warmStart = performance.now();
  const warm = await Promise.all(Array.from({ length: 16 }, () => reader.readSnapshot(file))); leases.push(...warm);
  const warmMs = rounded(performance.now() - warmStart), afterWarm = reader.cacheStats();
  assert.equal(afterWarm.sourceBytesRead, beforeWarm.sourceBytesRead, 'unchanged viewers must not rescan native bytes');
  assert.ok(warm.every(p => p.bytes === cold.bytes && p.memoryBytes === cold.memoryBytes));
  assert.deepEqual(await digest(warm[0]!), coldDigest);
  await Promise.all(warm.map(p => p.dispose()));
  const writer = await open(file, 'a');
  try { await writer.appendFile(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'synthetic' } }) + '\n'); }
  finally { await writer.close(); }
  const appendStart = performance.now(), appended = await reader.readSnapshot(file); leases.push(appended);
  const appendMs = rounded(performance.now() - appendStart), afterAppend = reader.cacheStats();
  const appendedDigest = await digest(appended);
  assert.equal(appendedDigest.lines, rows + 1); assert.notEqual(appendedDigest.hash, coldDigest.hash);
  assert.deepEqual(await digest(cold), coldDigest, 'appended source must not mutate an older leased snapshot');
  await reader.close();
  assert.equal(reader.cacheStats().entries, 0);
  assert.deepEqual(await digest(appended), appendedDigest, 'live lease survives cache-owner close');
  console.log(JSON.stringify({ passed: true, synthetic: true, sourceBytes: (await stat(file)).size, rows,
    projectionBytes: cold.bytes, projectionMemoryBytes: cold.memoryBytes, coldMs, warm16Ms: warmMs, appendMs,
    unchangedSourceBytesRead: afterWarm.sourceBytesRead - beforeWarm.sourceBytesRead,
    appendSourceBytesRead: afterAppend.sourceBytesRead - afterWarm.sourceBytesRead,
    readTimings: { prefixVerificationBytes: afterAppend.prefixVerificationBytes,
      prefixVerificationMs: rounded(afterAppend.prefixVerificationMs), projectionRecords: afterAppend.projectionRecords,
      projectionMs: rounded(afterAppend.projectionMs), snapshotVerificationMs: rounded(afterAppend.snapshotVerificationMs) },
    scope: 'Linux native snapshot/spill/cache/leases only; not parsing all views, HTTP503, live model, Windows or long soak.' }));
} finally {
  await reader.close();
  await Promise.all(leases.map(p => p.dispose()));
  await rm(dir, { recursive: true, force: true });
}
