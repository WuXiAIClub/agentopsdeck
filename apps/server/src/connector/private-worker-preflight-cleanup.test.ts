import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrivateWorkerPreflight } from './private-worker-preflight.js';

async function fixture(mode: string, deletion = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-preflight-cleanup-'));
  const entry = join(root, 'worker.cjs');
  await writeFile(entry, `
    process.on('message', request => {
      const mode = request.config.mode;
      const ack = { kind: 'preflight-failed' };
      if (mode === 'legacy') { process.send({ kind: 'failed', code: 'configuration' }); return; }
      if (mode === 'clean-immediate') {
        process.send(ack, () => { process.exitCode = 1; process.disconnect(); });
        return;
      }
      if (mode === 'extra') ack.nativeQuiescent = true;
      process.send(ack);
      if (mode === 'duplicate') process.send(ack);
      if (mode === 'contradict') process.send({ kind: 'preflight-complete' });
      if (mode === 'wait') return;
      setTimeout(() => {
        process.exitCode = mode === 'zero' ? 0 : mode === 'crash' ? 2 : 1;
        process.disconnect();
      }, 120);
    });
  `);
  const request = deletion
    ? { kind: 'delete-native' as const, id: 'command', nativeSessionId: 'session', config: { mode } }
    : { kind: 'preflight' as const, config: { mode } };
  const probe = new PrivateWorkerPreflight(request, {
    workspace: root, env: {}, timeoutMs: 3_000, launch: { entry, execArgv: [] },
  });
  return { probe, async cleanup() {
    probe.close(); await probe.finished;
    await rm(root, { recursive: true, force: true });
  } };
}

for (const mode of ['clean', 'clean-immediate']) test(`failed preflight cleanup ${mode} ACK plus exit 1 proves cleanup, never readiness`, async () => {
  const f = await fixture(mode);
  try {
    assert.equal(f.probe.inspectQuiescence(), false);
    assert.equal(await f.probe.ready, false);
    assert.equal(f.probe.inspectQuiescence(), true);
    f.probe.close(); f.probe.close();
    assert.equal(f.probe.inspectQuiescence(), true);
  } finally { await f.cleanup(); }
});

for (const mode of ['legacy', 'extra', 'duplicate', 'contradict', 'zero', 'crash']) {
  test(`failed preflight cleanup rejects ${mode} without granting Windows quiescence`, async () => {
    const f = await fixture(mode);
    try {
      assert.equal(await f.probe.ready, false);
      if (process.platform === 'win32') assert.equal(f.probe.inspectQuiescence(), false);
    } finally { await f.cleanup(); }
  });
}

test('cancelled failed preflight cannot acquire cleanup proof from a late ACK', async () => {
  const f = await fixture('wait');
  try {
    f.probe.close(); f.probe.close();
    assert.equal(await f.probe.ready, false);
    if (process.platform === 'win32') assert.equal(f.probe.inspectQuiescence(), false);
  } finally { await f.cleanup(); }
});

test('preflight failure cleanup ACK never authorizes native deletion', async () => {
  const f = await fixture('clean', true);
  try {
    assert.equal(await f.probe.ready, false);
    if (process.platform === 'win32') assert.equal(f.probe.inspectQuiescence(), false);
  } finally { await f.cleanup(); }
});
