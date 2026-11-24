import assert from 'node:assert/strict';
import { mkdtemp, open, rm, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';

// Synthetic native-shaped files only. No service, credentials, Agent or network.
// Usage: pnpm --filter @agentopsdeck/server exec tsx benchmarks/rollout-cache.mts [sessions=8] [MiB/session=16]
const sessions = Number(process.argv[2] ?? 8), mib = Number(process.argv[3] ?? 16);
if (!Number.isSafeInteger(sessions) || sessions < 5 || sessions > 32 || !Number.isSafeInteger(mib)
  || mib < 1 || mib > 512 || sessions * mib > 1024) throw Error('Use 5–32 sessions, 1–512 MiB each, total <=1024 MiB');
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-cache-bench-'));
const results: unknown[] = [];
try {
  const files: string[] = [];
  const originalSizes: number[] = [];
  let sourceBytes = 0;
  for (let i = 0; i < sessions; i++) {
    const file = join(directory, `${i}.jsonl`), handle = await open(file, 'wx', 0o600);
    files.push(file);
    try {
      let bytes = 0, record = 0;
      while (bytes < mib * 1024 ** 2) {
        const row = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: `${i}-${record++}`, output: 'synthetic tool output '.repeat(3000) } }) + '\n';
        await handle.writeFile(row); bytes += Buffer.byteLength(row);
      }
      sourceBytes += bytes;
      originalSizes.push(bytes);
    } finally { await handle.close(); }
  }
  for (const maxEntries of [4, 16]) {
    // Reset only our synthetic fixtures, so both policies read identical inputs.
    for (let i = 0; i < files.length; i++) await truncate(files[i]!, originalSizes[i]!);
    const reader = new CodexRolloutReader({ indexToolOutputs: true, cachePolicy: { maxEntries } });
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    try {
      const phases: unknown[] = [];
      for (const phase of ['cold', 'warm', 'warm-again', 'append'] as const) {
        if (phase === 'append') for (const file of files) await appendFile(file,
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new reply' }] } }) + '\n');
        const before = reader.cacheStats(), started = performance.now();
        for (const file of files) await reader.validate(file);
        const after = reader.cacheStats();
        phases.push({ phase, ms: Math.round(performance.now() - started), hits: after.hits - before.hits,
          misses: after.misses - before.misses, sourceBytesRead: after.sourceBytesRead - before.sourceBytesRead });
        if (maxEntries >= sessions && phase.startsWith('warm')) {
          assert.equal(after.hits - before.hits, sessions);
          assert.equal(after.sourceBytesRead - before.sourceBytesRead, 0);
        }
      }
      results.push({ maxEntries, phases, cache: reader.cacheStats(), eventLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(1)) });
    } finally { delay.disable(); await reader.close(); }
  }
  console.log(JSON.stringify({ passed: true, synthetic: true, sessions, sourceBytes, results,
    limits: 'Reader-only; warm unchanged history, append verification still reads the full prefix. Not HTTP/native thread latency or production throughput.' }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
