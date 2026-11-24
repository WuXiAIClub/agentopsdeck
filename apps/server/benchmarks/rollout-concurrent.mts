import assert from 'node:assert/strict';
import { mkdtemp, open, rm, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';

// Own synthetic fixtures only; no service requests or native Agent invocation.
// pnpm --filter @agentopsdeck/server exec tsx benchmarks/rollout-concurrent.mts [MiB=128] [consumers=8] [rounds=3]
const mib = Number(process.argv[2] ?? 128), consumers = Number(process.argv[3] ?? 8), rounds = Number(process.argv[4] ?? 3);
if (!Number.isSafeInteger(mib) || mib < 1 || mib > 512 || !Number.isSafeInteger(consumers) || consumers < 2
  || consumers > 16 || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) throw Error('Use 1–512 MiB, 2–16 consumers, 1–20 rounds');
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-concurrent-bench-'));
const file = join(directory, 'synthetic.jsonl');
const results: unknown[] = [];
try {
  let sourceBytes = 0;
  const handle = await open(file, 'wx', 0o600);
  try {
    let index = 0;
    while (sourceBytes < mib * 1024 ** 2) {
      const row = JSON.stringify({ type: 'response_item', payload: {
        type: 'function_call_output', call_id: `synthetic-${index++}`, output: 'synthetic tool output '.repeat(3000),
      } }) + '\n';
      await handle.writeFile(row); sourceBytes += Buffer.byteLength(row);
    }
  } finally { await handle.close(); }
  for (const shareConcurrentReads of [false, true]) {
    await truncate(file, sourceBytes);
    const reader = new CodexRolloutReader({ indexToolOutputs: true, shareConcurrentReads });
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    try {
      await reader.validate(file); // Same warm prefix for both policies.
      const phases: unknown[] = [];
      let bytes = sourceBytes;
      for (let round = 0; round < rounds; round++) {
        const tail = JSON.stringify({ type: 'turn_context', payload: { model: `round-${round}` } }) + '\n';
        await appendFile(file, tail); bytes += Buffer.byteLength(tail);
        const before = reader.cacheStats(), started = performance.now();
        const leases = await Promise.all(Array.from({ length: consumers }, () => reader.readSnapshot(file, { consistency: 'live-prefix' })));
        const ms = Math.round(performance.now() - started), after = reader.cacheStats();
        try {
          assert.equal(new Set(leases.map(lease => lease.bytes)).size, 1);
          // Stream the result once, never materialize an entire raw history.
          let last = ''; for await (const line of leases[0]!) last = line;
          assert.match(last, new RegExp(`round-${round}`));
          const nativeBytes = after.sourceBytesRead - before.sourceBytesRead;
          // Small fixtures/loaded schedulers may finish a scan before every
          // caller opens: those callers legitimately hit the completed cache.
          // Measure actual overlap, don't assert scheduling as a correctness API.
          assert.ok(nativeBytes >= bytes && nativeBytes <= bytes * consumers);
          assert.equal(nativeBytes, bytes * (after.misses - before.misses));
          assert.equal(after.coalescedReads - before.coalescedReads + after.hits - before.hits + after.misses - before.misses, consumers);
          if (!shareConcurrentReads) assert.equal(after.coalescedReads - before.coalescedReads, 0);
          phases.push({ round, ms, sourceBytesRead: nativeBytes, coalescedReads: after.coalescedReads - before.coalescedReads,
            misses: after.misses - before.misses });
        } finally { await Promise.all(leases.map(lease => lease.dispose())); }
      }
      results.push({ shareConcurrentReads, phases, cache: reader.cacheStats(), eventLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(1)) });
    } finally { delay.disable(); await reader.close(); }
  }
  console.log(JSON.stringify({ passed: true, synthetic: true, sourceBytes, consumers, rounds, results,
    limits: 'One large file; append between rounds, concurrent readers within each round. Not continuously writing during a scan, HTTP/production throughput or proof of a 503 fix. Every scan still verifies the entire cached prefix.' }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
