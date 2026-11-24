import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { historicalMessages, historicalProjection, threadModelFromRollout } from '../src/codex/app-server.js';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';
import { codexRolloutUsage } from '../src/codex/usage.js';
import { historyPage } from '../src/messages/history-page.js';

// Synthetic fixtures only. Phase times are sequential, not HTTP/production latency.
// "separate" exercises the current compatibility entry points (including the
// enriched messages wrapper), not a historical checkout. combined historyMs
// includes model/usage work; their zero standalone times do not mean zero cost.
// pnpm --filter @agentopsdeck/server exec tsx benchmarks/rollout-stages.mts [MiB=64] [combined|separate]
const mib = Number(process.argv[2] ?? 64);
const mode = process.argv[3] ?? 'combined';
assert.ok(process.argv.length <= 4 && Number.isSafeInteger(mib) && mib >= 1 && mib <= 512);
assert.ok(mode === 'combined' || mode === 'separate');
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-stages-'));
const file = join(directory, 'synthetic.jsonl');
const reader = new CodexRolloutReader({ indexToolOutputs: true, projectionMemoryBytes: 0 });
const samples: unknown[] = [];
const row = (type: string, payload: unknown, index = 0) => JSON.stringify({ type, payload,
  timestamp: new Date(1700000000000 + index * 1000).toISOString() }) + '\n';
const round = (ms: number) => Number(ms.toFixed(2));
try {
  const handle = await open(file, 'wx', 0o600);
  let sourceBytes = 0, tools = 0;
  try {
    const header = row('session_meta', { id: 'synthetic' }) + row('turn_context', { turn_id: 'turn', model: 'synthetic-model' });
    await handle.writeFile(header); sourceBytes += Buffer.byteLength(header);
    while (sourceBytes < mib * 1024 ** 2) {
      const text = row('response_item', { type: 'function_call', call_id: `tool-${tools}`, name: 'exec_command', arguments: '{"cmd":"synthetic"}' }, tools * 2)
        + row('response_item', { type: 'function_call_output', call_id: `tool-${tools}`, output: 'synthetic tool output '.repeat(800) }, tools * 2 + 1);
      await handle.writeFile(text); sourceBytes += Buffer.byteLength(text); tools++;
    }
  } finally { await handle.close(); }
  let expectedDigest: string | undefined;
  for (const phase of ['cold', 'warm', 'append', 'warm', 'append', 'warm']) {
    if (phase === 'append') {
      const tail = row('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 1234 }, model_context_window: 32000 } });
      await appendFile(file, tail); sourceBytes += Buffer.byteLength(tail);
    }
    const before = reader.cacheStats(), started = performance.now();
    const projection = await reader.readSnapshot(file);
    const nativeReadAndProjectionMs = round(performance.now() - started);
    try {
      let scans = 0, projectedBytesVisited = 0;
      const iterate = projection[Symbol.asyncIterator].bind(projection);
      projection[Symbol.asyncIterator] = async function* () {
        scans++; for await (const line of iterate()) { projectedBytesVisited += Buffer.byteLength(line) + 1; yield line; }
      };
      let at = performance.now();
      const combined = mode === 'combined' ? await historicalProjection('codex:synthetic', [], undefined, projection, file) : undefined;
      const messages = combined?.messages ?? await historicalMessages('codex:synthetic', [], undefined, projection, file);
      const historyMs = round(performance.now() - at), historyScans = scans, historyBytesVisited = projectedBytesVisited;
      assert.equal(messages.length, tools * 2);
      assert.equal(historyScans, 1);
      assert.equal(historyBytesVisited, projection.bytes);
      // Compare only portable public messages, not private indexed source paths/inodes.
      const digest = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
      expectedDigest ??= digest; assert.equal(digest, expectedDigest);
      at = performance.now(); const model = combined ? combined.model : await threadModelFromRollout(projection);
      const modelMs = combined ? 0 : round(performance.now() - at);
      assert.equal(model, 'synthetic-model');
      at = performance.now(); const usage = combined ? combined.usage : await codexRolloutUsage(projection);
      const usageMs = combined ? 0 : round(performance.now() - at);
      assert.deepEqual(usage, samples.length >= 2 ? { compactionCount: 0, contextUsedTokens: 1234, contextTokens: 32000 } : { compactionCount: 0 });
      assert.equal(scans, mode === 'combined' ? 1 : 3);
      assert.equal(projectedBytesVisited, projection.bytes * scans);
      at = performance.now(); const page = historyPage(messages, 200)!;
      const pagingMs = round(performance.now() - at);
      at = performance.now(); const json = JSON.stringify(page);
      const serializeMs = round(performance.now() - at);
      samples.push({ phase, sourceBytes, projectedBytes: projection.bytes, nativeBytesRead: reader.cacheStats().sourceBytesRead - before.sourceBytesRead,
        nativeReadAndProjectionMs, historyMs, historyScans, historyBytesVisited, modelMs, usageMs, pagingMs, serializeMs,
        enrichmentMs: round(historyMs + modelMs + usageMs), totalProjectionScans: scans, totalProjectedBytesVisited: projectedBytesVisited,
        model, usage, messageCount: messages.length, publicMessagesDigest: digest, pageBytes: Buffer.byteLength(json) });
    } finally { await projection.dispose(); }
  }
  console.log(JSON.stringify({ passed: true, synthetic: true, forcedDiskProjection: true, mode, samples,
    scope: 'Fixed synthetic tool-heavy history, no concurrent native writes. Native phase includes validation and building projection; no native RPC, store apply, auth, HTTP, browser or production 503 acceptance.' }, null, 2));
} finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
