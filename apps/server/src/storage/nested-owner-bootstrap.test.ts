import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('source/compiled nested owner launches the real volume worker with isolated state', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-nested-owner-'));
  const source = new URL(import.meta.url).pathname.endsWith('.ts');
  const entry = new URL(source ? './async-volume-admission.ts' : './async-volume-admission.js', import.meta.url).href;
  const worker = new Worker(`(async () => {
    const { parentPort, workerData } = require('node:worker_threads');
    const module = workerData.loader
      ? await (await import(workerData.loader)).tsImport(workerData.entry, workerData.entry)
      : await import(workerData.entry);
    const owner = new module.AsyncVolumeAdmission();
    let calls = 0;
    const value = await owner.run(workerData.root, 'durable', 65536, async () => { calls++; return 'committed'; });
    parentPort.postMessage({ value, calls, snapshot: owner.snapshot() });
  })().catch(() => process.exit(1));`, { eval: true, execArgv: [],
    workerData: { entry, root, loader: source ? import.meta.resolve('tsx/esm/api') : undefined },
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  try {
    const result = await new Promise<any>((resolve, reject) => {
      let received = false;
      worker.once('message', value => { received = true; resolve(value); });
      worker.once('error', reject);
      worker.once('exit', code => { if (!received) reject(Error(`Nested owner exited before ACK (${code})`)); });
    });
    assert.equal(result.value, 'committed'); assert.equal(result.calls, 1);
    assert.equal(result.snapshot.activeWriters, 0);
    assert.equal(result.snapshot.pending, 0);
    assert.equal(result.snapshot.recoveryProofs, 0);
  } finally {
    // Await the actual original worker exit before deleting only this fixture.
    await worker.terminate(); rmSync(root, { recursive: true, force: true });
  }
});
