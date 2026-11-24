// Compiled product control worker + durable driver, disposable fixtures only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sdkSourceImport as tsImport } from './sdk-source-import.mjs';

export async function verifyCompactWorker({ runtime, config, launch, store, owner, journal, key, beginInterrupt, inferenceCount }) {
  const { SdkCompactWorker } = await tsImport('../../apps/server/src/connector/sdk-compact-worker.ts', import.meta.url);
  const { claudeWorkerEnvironment } = await tsImport('../../apps/server/src/claude/worker-environment.ts', import.meta.url);
  const { copilotWorkerEnvironment } = await tsImport('../../apps/server/src/copilot/worker-environment.ts', import.meta.url);
  // Starter is installed by fixture before the owner is constructed.
  const start = execution => { const worker = new SdkCompactWorker({ kind: 'compact', config, execution }, {
    runtime, workspace: config.workspace, env: runtime === 'ghcp' ? copilotWorkerEnvironment(config) : claudeWorkerEnvironment(config),
    timeoutMs: 25000, launch,
  }); void worker.result.catch(() => console.log(runtime, 'compact worker failure stage', worker.failureCode ?? 'transport')); return worker; };
  if (!owner) return start;
  const wait = async () => {
    const until = Date.now() + 30000;
    while (owner.driver.inspect().nativeWorkers || owner.driver.inspect().admissionInFlight) {
      assert.ok(Date.now() < until, 'Compact driver must drain within fixture deadline'); await delay(10);
    }
  };
  const submit = () => {
    const scope = JSON.stringify(['compact', JSON.stringify(['owner', key])]), command = randomUUID();
    store.commands.claim(scope, command, {});
    const result = owner.commands.compact(key, { actorId: 'owner',
      accept: result => store.commands.queueCommit(scope, command, { status: 200, body: result }) });
    assert.equal(store.commands.get(scope, command).state, 'accepted');
    assert.equal(journal.current(key).id, result.runId);
    assert.equal(journal.current(key).kind, 'compact');
    assert.equal(journal.canStart(key), false);
    return result;
  };
  const before = inferenceCount(), count = journal.session(key).metrics?.compactionCount;
  submit();
  // Rejected second request must not cancel the original worker.
  assert.throws(submit);
  await wait();
  assert.equal(journal.current(key).phase, 'completed', 'Native persisted boundary AND quiescence settle the control');
  assert.deepEqual(journal.session(key).metrics?.context, { used: null, basis: 'post-compaction' });
  if (count !== undefined) assert.equal(journal.session(key).metrics.compactionCount, count + 1);
  assert.equal(journal.canStart(key), true);
  assert.equal(inferenceCount() - before, 1, 'Exactly one native compact request');
  console.log(runtime, 'compiled compact worker: receipt, duplicate exclusion, persisted boundary, cleanup passed');
  return { wait, submit };
}

// Stop ACK alone cannot establish a persisted native compact boundary. This
// fixture deliberately interrupts inference and verifies unknown/no replay.
export async function verifyCompactWorkerStop({ runtime, store, owner, journal, key, beginInterrupt, inferenceCount }) {
  const hold = beginInterrupt(), before = inferenceCount();
  let timeout;
  try {
    const scope = JSON.stringify(['compact', JSON.stringify(['owner', key])]), command = randomUUID();
    store.commands.claim(scope, command, {});
    const admitted = owner.commands.compact(key, { actorId: 'owner',
      accept: result => store.commands.queueCommit(scope, command, { status: 200, body: result }) });
    await Promise.race([hold.receiving, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Compact stop fixture did not reach inference')), 15000);
    })]);
    clearTimeout(timeout);
    const original = journal.current(key);
    assert.equal(original.id, admitted.runId);
    await owner.commands.interrupt(key, original.id, { actorId: 'owner' });
    const until = Date.now() + 30000;
    while (owner.driver.inspect().nativeWorkers || owner.driver.inspect().admissionInFlight) {
      assert.ok(Date.now() < until, 'Stopped compact must drain'); await delay(10);
    }
    assert.equal(journal.current(key).stopRequested, true);
    assert.equal(journal.current(key).phase, 'unknown');
    assert.equal(journal.canStart(key), false);
    journal.recover(store.turns);
    assert.equal(journal.current(key).id, original.id);
    assert.equal(journal.current(key).nativeSessionId, original.nativeSessionId);
    assert.throws(() => owner.commands.compact(key, { actorId: 'owner', accept: () => () => assert.fail('No replay') }));
    assert.equal(inferenceCount() - before, 1, 'Stop/recovery never replays compact');
    console.log(runtime, 'compiled compact stop: durable exact identity, group drain, unknown preserved, no replay passed');
  } finally { clearTimeout(timeout); hold.reset(); }
}
