import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SdkCompactWorker } from './sdk-compact-worker.js';

function worker(scenario: string) {
  return new SdkCompactWorker({ kind: 'compact', config: { scenario }, execution: {
    key: `ghcp:${randomUUID()}`, id: randomUUID(), epoch: randomUUID(), nativeSessionId: randomUUID(),
    kind: 'compact', nativeMode: 'resume', phase: 'dispatching', members: [], stopRequested: false,
    control: { actorId: 'fixture-owner' }, createdAt: 0, updatedAt: 0,
  } }, { runtime: 'ghcp', workspace: process.cwd(), env: {}, timeoutMs: 2000,
    launch: { entry: fileURLToPath(new URL('./sdk-compact-worker-fixture.mjs', import.meta.url)), execArgv: [] } });
}

test('compact transport requires exact proof and successful process-group exit', async () => {
  const child = worker('success');
  try {
    const result = await child.result;
    assert.equal(result.outcome, 'completed');
    assert.equal(result.nativeRequestId, result.id);
    assert.equal(await child.inspectQuiescence(), true);
    assert.equal((await child.inspectSettlement()).historyPersisted, true);
  } finally { child.close(); await child.finished; }
});

for (const scenario of ['wrong-id', 'wrong-epoch', 'wrong-native', 'wrong-request', 'extra-content', 'duplicate', 'failed-exit', 'timeout']) {
  test(`compact transport rejects ${scenario} without exposing native content`, async () => {
    const child = worker(scenario);
    try {
      await assert.rejects(child.result, /^Error: Native compact outcome is unconfirmed$/);
      assert.equal(await child.inspectQuiescence(), true);
    } finally { child.close(); await child.finished; }
  });
}

test('compact stop ACK is not terminal proof; close drains the owned process', async () => {
  const child = worker('ack-only');
  try {
    await child.interrupt();
    assert.equal(await child.inspectQuiescence(), false);
    assert.equal(await Promise.race([child.result.then(() => 'settled', () => 'failed'), delay(30, 'pending')]), 'pending');
    child.close(); await assert.rejects(child.result);
    assert.equal(await child.inspectQuiescence(), true);
  } finally { child.close(); await child.finished; }
});

test('a proof without worker exit cannot settle', async () => {
  const child = worker('proof-without-exit');
  try {
    assert.equal(await Promise.race([child.result.then(() => 'settled', () => 'failed'), delay(150, 'pending')]), 'pending');
    assert.equal(await child.inspectQuiescence(), false);
    child.close(); await assert.rejects(child.result);
  } finally { child.close(); await child.finished; }
});
