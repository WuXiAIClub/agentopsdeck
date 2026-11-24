/** Exceeds the old 256MiB projection limit under a 192MiB JS heap.
 * Synthetic temporary files only; does not certify native thread/read latency. */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';
import { codexRolloutUsage } from '../src/codex/usage.js';

const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-large-projection-bench-'));
const file = join(directory, 'history.jsonl'), reader = new CodexRolloutReader({ indexToolOutputs: true });
const snapshots = [];
try {
  await writeFile(file, '{"type":"session_meta"}\n');
  const row = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'x'.repeat(1024 * 1024) }] } }) + '\n';
  for (let i = 0; i < 512; i++) await appendFile(file, row);
  const started = performance.now(), snapshot = await reader.readSnapshot(file); snapshots.push(snapshot);
  const coldMs = performance.now() - started;
  assert.ok(snapshot.bytes > 512 * 1024 * 1024);
  assert.equal(snapshot.memoryBytes, 0);
  let count = 0; for await (const line of snapshot) { JSON.parse(line); count++; }
  assert.equal(count, 513);
  assert.deepEqual(await codexRolloutUsage(snapshot), { compactionCount: 0 });
  const warmStart = performance.now(), warm = await reader.readSnapshot(file); snapshots.push(warm);
  const warmMs = performance.now() - warmStart;
  await appendFile(file, '{"type":"compacted"}\n');
  const appendStart = performance.now(), next = await reader.readSnapshot(file); snapshots.push(next);
  const appendMs = performance.now() - appendStart;
  assert.equal(next.segments, 2);
  assert.deepEqual(await codexRolloutUsage(next), { compactionCount: 1, contextUsedTokens: null });
  console.log(JSON.stringify({ rawBytes: (await stat(file)).size, projectedBytes: snapshot.bytes, memoryProjectionBytes: snapshot.memoryBytes,
    coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), appendMs: Math.round(appendMs), maxRssKiB: process.resourceUsage().maxRSS,
    scope: 'rollout only; not native RPC, materialized message store or production latency' }));
} finally {
  await Promise.all(snapshots.map(snapshot => snapshot.dispose())); await reader.close();
  await rm(directory, { recursive: true, force: true });
}
