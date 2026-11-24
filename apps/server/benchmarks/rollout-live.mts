/** Synthetic append pressure, plus an optional operator-authorized READ-ONLY
 * rollout sample. Never prints transcript data or changes the sample file.
 * Run from the repository root:
 * node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/benchmarks/rollout-live.mts [--sample /absolute/rollout.jsonl]
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--sample' && isAbsolute(args[1]!));
const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-live-history-bench-'));
const file = join(directory, 'synthetic.jsonl');
let writer: Worker | undefined;
const sample = async (reader: CodexRolloutReader, path: string, consistency: 'stable' | 'live-prefix', iterations: number) => {
  const results = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    try {
      const text = await reader.read(path, { consistency });
      results.push({ ms: Math.round(performance.now() - start), ok: true, projectedBytes: Buffer.byteLength(text) });
    } catch (error) {
      results.push({ ms: Math.round(performance.now() - start), ok: false,
        error: error instanceof Error ? error.message : 'read failed' });
    }
  }
  return results;
};
try {
  await writeFile(file, row('turn_context', { turn_id: 'synthetic', model: 'synthetic' }));
  const reasoning = row('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(1024 * 1024) });
  for (let index = 0; index < 80; index++) {
    await appendFile(file, reasoning + row('response_item', {
      type: 'function_call_output', call_id: `tool-${index}`, output: 'x'.repeat(1024 * 1024),
    }));
  }
  writer = new Worker(`
    const { appendFileSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    let ticks = 0;
    const timer = setInterval(() => {
      appendFileSync(workerData.file, JSON.stringify({ type: 'event_msg', payload: {
        type: 'token_count', info: { last_token_usage: { total_tokens: ++ticks }, model_context_window: 200000 }
      } }) + '\\n');
    }, 10);
    parentPort.on('message', () => { clearInterval(timer); parentPort.close(); });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { file } });
  await once(writer, 'message');
  const stable = await sample(new CodexRolloutReader(), file, 'stable', 4);
  const live = await sample(new CodexRolloutReader(), file, 'live-prefix', 8);
  const stopped = once(writer, 'exit');
  writer.postMessage('stop');
  await stopped;
  writer = undefined;
  const settled = await sample(new CodexRolloutReader(), file, 'stable', 2);
  const realSample = args.length ? { readOnly: true, sourceBytes: (await stat(args[1]!)).size,
    samples: await sample(new CodexRolloutReader(), args[1]!, 'live-prefix', 5) } : undefined;
  console.log(JSON.stringify({ synthetic: { sourceBytes: (await stat(file)).size, writerIntervalMs: 10, stable, live, settled },
    ...(realSample ? { realSample } : {}), scope: 'Rollout reader only; not full native RPC, public HTTP, browser, or production deployment acceptance' }, null, 2));
  assert.ok(stable.some(result => !result.ok), 'pressure must reproduce the strict append race');
  assert.ok(live.every(result => result.ok), 'live prefix failed during append pressure');
  assert.ok(settled.every(result => result.ok), 'strict reads failed after writer stopped');
  assert.ok(!realSample || realSample.samples.every(result => result.ok), 'read-only sample failed');
} finally {
  if (writer) await writer.terminate();
  await rm(directory, { recursive: true, force: true });
}
