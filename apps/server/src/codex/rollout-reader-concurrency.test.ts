import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexRolloutReader } from './rollout-reader.js';

function record(type: string, payload: unknown) {
  return JSON.stringify({ type, payload }) + '\n';
}

test('maxConcurrentScans caps concurrent physical scans across distinct files while coalescing shared reads', async context => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-rollout-concurrency-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));

  const files = [1, 2, 3, 4, 5].map(i => {
    const file = join(dir, `rollout-${i}.jsonl`);
    writeFileSync(file, record('turn_context', { turn_id: `t-${i}`, model: `model-${i}` }));
    return file;
  });

  let inPhysicalRead = 0;
  let peakPhysicalReads = 0;
  const gateResolvers: Array<() => void> = [];

  const originalOpen = fsPromises.open;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (!target.startsWith(dir)) return handle;
    const originalRead = handle.read.bind(handle);
    let gatedOnce = false;
    handle.read = (async (...readArgs: Parameters<typeof originalRead>) => {
      if (!gatedOnce) {
        gatedOnce = true;
        inPhysicalRead++;
        peakPhysicalReads = Math.max(peakPhysicalReads, inPhysicalRead);
        await new Promise<void>(resolve => { gateResolvers.push(resolve); });
        try {
          return await originalRead(...readArgs);
        } finally {
          inPhysicalRead--;
        }
      }
      return originalRead(...readArgs);
    }) as typeof handle.read;
    return handle;
  });
  syncBuiltinESMExports();
  context.after(() => syncBuiltinESMExports());

  const reader = new CodexRolloutReader({ maxConcurrentScans: 2 });
  context.after(() => reader.close());

  // Start 5 distinct file reads + 2 coalesced reads of file[0].
  const pending = [
    reader.read(files[0]!),
    reader.read(files[0]!),
    reader.read(files[0]!),
    ...files.slice(1).map(file => reader.read(file)),
  ];

  while (gateResolvers.length < 2) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 15));

  const midStats = reader.cacheStats();
  assert.equal(midStats.activeScans, 2);
  assert.equal(midStats.queuedScans, 3);
  assert.equal(peakPhysicalReads, 2);

  while (gateResolvers.length) {
    gateResolvers.shift()!();
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const outputs = await Promise.all(pending);
  assert.equal(outputs.length, 7);
  assert.equal(peakPhysicalReads, 2, 'physical scan concurrency never exceeds maxConcurrentScans');
  assert.equal(reader.cacheStats().activeScans, 0);
  assert.equal(reader.cacheStats().queuedScans, 0);
  assert.ok(reader.cacheStats().coalescedReads >= 2);
});
