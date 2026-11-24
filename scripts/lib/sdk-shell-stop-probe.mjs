// Disposable fixture only. Verify interruption while a real native Shell tool
// is executing, not merely while the synthetic provider holds a response.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';

export async function verifySdkShellStop({ runtime, workspace, owner, store, journal, key, getWorker, beginTools, inferenceCount }) {
  assert.ok(workspace.startsWith(`${process.env.AOD_SDK_PROBE_WORKER}/`));
  const marker = `shell-stop-${randomUUID()}.pid`;
  const command = `printf '%s' "$$" > ${marker}; exec /bin/sleep 30`;
  beginTools([{ name: runtime === 'claude-code' ? 'Bash' : 'bash', input: {
    command, ...(runtime === 'claude-code' ? { timeout: 60_000 } : { mode: 'sync' }),
  } }]);
  const before = inferenceCount(), commandId = randomUUID(), scope = JSON.stringify(['owner', key]);
  store.commands.claim(scope, commandId, { message: 'Native shell stop fixture' });
  owner.commands.send(key, 'Native shell stop fixture', { actorId: 'owner',
    accept: result => store.commands.queueCommit(scope, commandId, { status: 200, body: result }) });
  await owner.driver.wake(key);
  const worker = getWorker();
  const frames = [];
  const observe = value => {
    frames.push({ kind: value?.kind, type: value?.event?.type,
      success: value?.event?.data?.success, aborted: value?.event?.data?.aborted });
    if (frames.length > 30) frames.shift();
  };
  worker.child.on('message', observe);
  let pid;
  try {
    const deadline = performance.now() + 15_000;
    while (!pid && performance.now() < deadline) {
      try { pid = Number(await readFile(join(workspace, marker), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!pid) await delay(25);
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 1, 'The actual shell must start before Stop');
    const identity = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.equal(await owner.commands.interrupt(key, journal.current(key).id, { actorId: 'owner' }), 'accepted');
    await worker.finished; await setImmediate(); await owner.driver.wake(key);
    assert.equal(await worker.inspectQuiescence(), true, 'Native worker and shell descendants drained');
    assert.equal(journal.current(key).phase, 'interrupted');
    assert.equal(journal.current(key).outcome, 'interrupted');
    assert.equal(journal.canStart(key), true);
    try { assert.notEqual(await readFile(`/proc/${pid}/stat`, 'utf8'), identity, 'Original shell must not survive'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const count = inferenceCount() - before;
    assert.ok(count >= 1 && count <= 2, 'No replay of shell or input');
    console.log(`${runtime} compiled native shell: running command interrupted, descendants drained, no replay`);
    return count;
  } catch (error) {
    console.error('Native shell stop fixture', { runtime, frames, bad: worker.bad, history: !!worker.history,
      scopeEmpty: worker.scope?.cleaned(), scopeSuccessful: worker.scope?.quiescent() });
    throw error;
  } finally { worker.child.off('message', observe); beginTools([]); }
}
