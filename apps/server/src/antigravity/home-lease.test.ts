import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';

const supported = { skip: process.platform !== 'linux' };

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aod-antigravity-lease-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), storeFile = join(root, 'connector.sqlite'), nodeId = `node_${randomUUID()}`;
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(storeFile, '', { mode: 0o600 });
  return { home, storeFile, nodeId, acquire: () => PrivateAgentHomeLease.acquire('antigravity', home, storeFile, nodeId) };
}

test('Antigravity HOME is exclusive and bound to the exact Connector database and node', supported, async context => {
  const original = fixture(context), lease = original.acquire();
  lease.assertHeld();
  assert.throws(original.acquire);
  await lease.releaseAfter(async () => {});
  assert.deepEqual(JSON.parse(readFileSync(join(original.home, '.agentopsdeck-antigravity-binding'), 'utf8')),
    { format: 1, nodeId: original.nodeId, storeFile: original.storeFile });
  assert.throws(() => PrivateAgentHomeLease.acquire('antigravity', original.home, original.storeFile, `node_${randomUUID()}`));
  await original.acquire().releaseAfter(async () => {});
});

test('Antigravity rejects Claude and Copilot homes in both acquisition orders even after clean shutdown', supported, async context => {
  for (const other of ['claude-code', 'ghcp'] as const) {
    for (const [first, second] of [['antigravity', other], [other, 'antigravity']] as const) {
      const original = fixture(context);
      const lease = PrivateAgentHomeLease.acquire(first, original.home, original.storeFile, original.nodeId);
      assert.throws(() => PrivateAgentHomeLease.acquire(second, original.home, original.storeFile, original.nodeId));
      await lease.releaseAfter(async () => {});
      assert.throws(() => PrivateAgentHomeLease.acquire(second, original.home, original.storeFile, original.nodeId));
    }
  }
});

test('Unproven Antigravity cleanup retains its non-expiring owner fence', supported, async context => {
  const original = fixture(context), lease = original.acquire();
  await assert.rejects(lease.releaseAfter(async () => { throw Error('synthetic private diagnostic'); }), /offline recovery/);
  assert.ok(existsSync(join(original.home, '.agentopsdeck-antigravity-owner')));
  assert.throws(original.acquire);
});
