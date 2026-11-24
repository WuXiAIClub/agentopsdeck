import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ClaudeHomeLease } from '../claude/home-lease.js';
import { CopilotHomeLease } from './home-lease.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-copilot-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), db = join(root, 'connector.sqlite'), node = `node_${randomUUID()}`;
  mkdirSync(home, { mode: 0o700 }); writeFileSync(db, '', { mode: 0o600 });
  return { home, db, node, args: [home, db, node] as const };
}
test('Copilot HOME has exclusive ownership and durable exact database binding', async t => {
  const f = fixture(t), lease = CopilotHomeLease.acquire(...f.args);
  lease.assertHeld();
  assert.throws(() => CopilotHomeLease.acquire(...f.args));
  await lease.releaseAfter(async () => {});
  const binding = join(f.home, '.agentopsdeck-copilot-binding');
  assert.deepEqual(JSON.parse(readFileSync(binding, 'utf8')), { format: 1, nodeId: f.node, storeFile: f.db });
  assert.throws(() => CopilotHomeLease.acquire(f.home, f.db, `node_${randomUUID()}`));
  const again = CopilotHomeLease.acquire(...f.args); await again.releaseAfter(async () => {});
});
test('Claude and Copilot cannot share a HOME during ownership or after a clean shutdown', async t => {
  for (const [first, second] of [[ClaudeHomeLease, CopilotHomeLease], [CopilotHomeLease, ClaudeHomeLease]]) {
    const f = fixture(t), lease = first!.acquire(...f.args);
    assert.throws(() => second!.acquire(...f.args));
    await lease.releaseAfter(async () => {});
    assert.throws(() => second!.acquire(...f.args));
    const again = first!.acquire(...f.args); await again.releaseAfter(async () => {});
  }
});
test('Unproven Copilot process cleanup retains a non-expiring owner marker', async t => {
  const f = fixture(t), lease = CopilotHomeLease.acquire(...f.args);
  await assert.rejects(lease.releaseAfter(async () => { throw new Error('private diagnostic'); }), /offline recovery/);
  assert.ok(existsSync(join(f.home, '.agentopsdeck-copilot-owner')));
  assert.throws(() => CopilotHomeLease.acquire(...f.args));
  assert.throws(() => ClaudeHomeLease.acquire(...f.args));
});
