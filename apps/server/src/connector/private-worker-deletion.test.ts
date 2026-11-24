import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrivateWorkerPreflight } from './private-worker-preflight.js';

for (const mode of ['normal', 'wrong-id', 'wrong-native', 'extra', 'duplicate', 'preflight', 'exit-error', 'timeout', 'cancel']) {
  test(`Deletion control worker ${mode}: exact identity ACK plus clean exit required`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-delete-worker-')), entry = join(root, 'worker.mjs');
    await writeFile(entry, `
      process.on('message', request => {
        const mode = request.config.mode;
        if (mode === 'timeout' || mode === 'cancel') return;
        const ack = { kind: 'delete-complete', id: request.id, nativeSessionId: request.nativeSessionId };
        if (mode === 'wrong-id') ack.id = 'other-command';
        if (mode === 'wrong-native') ack.nativeSessionId = 'other-session';
        if (mode === 'extra') ack.extra = 'unexpected';
        process.send(mode === 'preflight' ? { kind: 'preflight-complete' } : ack);
        if (mode === 'duplicate') process.send(ack);
        setTimeout(() => { if (mode === 'exit-error') process.exitCode = 1; process.disconnect(); }, 50);
      });
    `);
    const worker = new PrivateWorkerPreflight({ kind: 'delete-native', id: 'command', nativeSessionId: 'session', config: { mode } },
      { workspace: root, env: {}, timeoutMs: mode === 'timeout' ? 100 : 3000, launch: { entry, execArgv: [] } });
    try {
      assert.equal(worker.inspectQuiescence(), false);
      if (mode === 'cancel') { worker.close(); worker.close(); }
      assert.equal(await worker.ready, mode === 'normal');
      assert.equal(worker.inspectQuiescence(), true);
    } finally { worker.close(); await worker.finished; await rm(root, { recursive: true, force: true }); }
  });
}
