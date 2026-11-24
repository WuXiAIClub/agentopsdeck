import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeWorkerPreflight } from './worker-preflight.js';

async function fixture(model: string, timeout = 1500) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-claude-preflight-'));
  const homeDirectory = join(root, 'home'), workspace = join(root, 'workspace'), entry = join(root, 'fixture.mjs');
  await mkdir(homeDirectory, { mode: 0o700 }); await mkdir(workspace);
  await writeFile(entry, `
    process.on('message', request => {
      if (request.kind !== 'preflight' || Object.keys(request).length !== 2
        || process.env.ANTHROPIC_API_KEY || process.env.NODE_OPTIONS) process.exit(1);
      const mode = request.config.model;
      if (mode === 'timeout') return;
      if (mode === 'failed') { process.send({ kind: 'failed', error: 'PRIVATE' }); return; }
      if (mode === 'extra') { process.send({ kind: 'preflight-complete', account: 'PRIVATE' }); return; }
      process.send({ kind: 'preflight-complete' });
      if (mode === 'duplicate') process.send({ kind: 'preflight-complete' });
      setTimeout(() => { if (mode === 'exit-error') process.exitCode = 1; process.disconnect(); }, 120);
    });
  `);
  const probe = new ClaudeWorkerPreflight({ homeDirectory, workspace, sdkDirectory: join(root, 'unused-sdk'),
    apiKeyFile: join(root, 'unused-key'), baseUrl: 'https://fixture.invalid', startupTimeoutMs: timeout, model },
  { entry, execArgv: [] });
  return { probe, cleanup: async () => {
    probe.close(); await probe.finished; assert.equal(probe.inspectQuiescence(), true);
    await rm(root, { recursive: true, force: true });
  } };
}

test('Claude preflight confirms control ACK only after actual worker exit', async () => {
  const f = await fixture('normal');
  try {
    assert.equal(f.probe.inspectQuiescence(), false);
    assert.equal(await f.probe.ready, true);
    assert.equal(f.probe.inspectQuiescence(), true);
  } finally { await f.cleanup(); }
});

for (const mode of ['failed', 'extra', 'duplicate', 'exit-error', 'timeout']) {
  test(`Claude preflight rejects ${mode} without returning diagnostics or retrying`, async () => {
    const f = await fixture(mode, mode === 'timeout' ? 100 : 1500);
    try {
      assert.equal(await f.probe.ready, false);
      assert.equal(f.probe.inspectQuiescence(), true);
    } finally { await f.cleanup(); }
  });
}

test('Claude cancelled preflight cannot become ready from a late ACK', async () => {
  const f = await fixture('normal');
  try {
    f.probe.close(); f.probe.close();
    assert.equal(await f.probe.ready, false);
  } finally { await f.cleanup(); }
});
