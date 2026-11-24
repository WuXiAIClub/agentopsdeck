/** 512MiB tool-heavy synthetic history; writes only its own temporary directory.
 * node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/benchmarks/rollout-indexed.mts
 * Scope: rollout projection + lazy record read, NOT native RPC or production.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';
import { bindToolRecord, readIndexedToolMessage, rolloutToolOutputText } from '../src/codex/indexed-tool-output.js';

const directory = await fs.mkdtemp(join(tmpdir(), 'agentopsdeck-indexed-history-bench-'));
const file = join(directory, 'synthetic.jsonl');
const row = (payload: unknown) => JSON.stringify({ type: 'response_item', payload }) + '\n';
const originalOpen = fs.open;
let readBytes = 0, writer: Worker | undefined;
try {
  await fs.writeFile(file, JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn', model: 'synthetic' } }) + '\n');
  const body = 'x'.repeat(2 * 1024 * 1024);
  for (let index = 0; index < 256; index++) await fs.appendFile(file,
    row({ type: 'function_call', call_id: `tool-${index}`, name: 'synthetic', arguments: '{}' })
    + row({ type: 'function_call_output', call_id: `tool-${index}`, output: body }));
  fs.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const originalRead = handle.read.bind(handle);
      handle.read = (async (...parameters: Parameters<typeof originalRead>) => {
        const result = await originalRead(...parameters); readBytes += result.bytesRead; return result;
      }) as typeof handle.read;
    }
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  let reader = new CodexRolloutReader({ indexToolOutputs: true });
  const samples: unknown[] = [];
  const measure = async (label: string, consistency: 'stable' | 'live-prefix') => {
    const start = performance.now(); readBytes = 0;
    const text = await reader.read(file, { consistency });
    samples.push({ label, ms: Math.round(performance.now() - start), readBytes,
      projectedBytes: Buffer.byteLength(text), heapUsed: process.memoryUsage().heapUsed });
    assert.ok(Buffer.byteLength(text) < 1024 * 1024, 'projection must fit the existing cache budget');
    return text;
  };
  await measure('cold', 'stable');
  await measure('unchanged-cache', 'stable');
  assert.equal(readBytes, 0, 'unchanged cache must avoid a full raw read');
  writer = new Worker(`
    const { appendFileSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    let ready = false;
    const timer = setInterval(() => {
      appendFileSync(workerData.file,
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 200000 } } }) + '\\n');
      if (!ready) { ready = true; parentPort.postMessage('ready'); }
    }, 10);
    parentPort.on('message', () => { clearInterval(timer); parentPort.close(); });
  `, { eval: true, workerData: { file } });
  await once(writer, 'message');
  reader = new CodexRolloutReader({ indexToolOutputs: true });
  let projection = '';
  for (let index = 0; index < 5; index++) {
    await fs.appendFile(file, row({ type: 'function_call_output', call_id: `tail-${index}`, output: 'small append' }));
    projection = await measure(`live-${index}`, 'live-prefix');
    assert.ok(readBytes >= 512 * 1024 * 1024, 'live sample must actually scan a grown file, not an unchanged cache hit');
  }
  const details = [];
  for (const id of ['tool-0', 'tool-255']) {
    const indexed = projection.trim().split('\n').map(line => JSON.parse(line))
      .find(row => row.payload?.call_id === id && row.payload?.agentopsdeckIndexedOutput)?.payload.agentopsdeckIndexedOutput;
    assert.ok(indexed);
    const message = bindToolRecord({ id, sessionKey: 'codex:synthetic', role: 'tool', text: indexed.preview, createdAt: 0 }, file, indexed, '');
    readBytes = 0;
    const start = performance.now();
    const detail = await readIndexedToolMessage(message);
    assert.equal(detail.text, rolloutToolOutputText(body));
    assert.equal(readBytes, indexed.reference.bytes, 'detail must read only its own record');
    details.push({ id, ms: Math.round(performance.now() - start), readBytes });
  }
  const stopped = once(writer, 'exit'); writer.postMessage('stop'); await stopped; writer = undefined;
  await measure('settled-strict', 'stable');
  await measure('settled-cache', 'stable');
  assert.equal(readBytes, 0);
  console.log(JSON.stringify({ sourceBytes: (await fs.stat(file)).size, writerIntervalMs: 10, samples, details,
    maxRssKiB: process.resourceUsage().maxRSS,
    scope: 'Synthetic rollout reader and exact tool details only; full-prefix hashing remains O(file size), native RPC and public HTTP not measured' }, null, 2));
} finally {
  fs.open = originalOpen; syncBuiltinESMExports();
  if (writer) await writer.terminate();
  await fs.rm(directory, { recursive: true, force: true });
}
