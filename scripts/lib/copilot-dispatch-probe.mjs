// The fixed CLI's actual events pass through the product lifecycle adapter.
// This fixture does NOT claim private-worker descendant cleanup. It explicitly
// proves that native idle + persisted history cannot settle without that proof.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { sdkSourceImport as tsImport } from './sdk-source-import.mjs';

export async function verifyCopilotDispatch({ session, status, prompt }) {
  const { CopilotDispatchAdapter } = await tsImport('../../apps/server/src/copilot/dispatch-adapter.ts', import.meta.url);
  const { copilotLifecycleFrame, copilotHistoryIdentities } = await tsImport('../../apps/server/src/copilot/worker-protocol.ts', import.meta.url);
  const { SdkDispatch } = await tsImport('../../apps/server/src/connector/sdk-dispatch.ts', import.meta.url);
  const { SdkExecutionJournal } = await tsImport('../../apps/server/src/connector/sdk-execution-journal.ts', import.meta.url);
  const { TurnQueue } = await tsImport('../../apps/server/src/commands/turn-queue.ts', import.meta.url);
  const db = new DatabaseSync(':memory:'), turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, 'ghcp');
  const key = `ghcp:${session.sessionId}`, epoch = randomUUID();
  journal.create({ key, nativeSessionId: session.sessionId, title: '', createdAt: 1 });
  turns.enqueue('ghcp', { id: randomUUID(), sessionKey: key, createdAt: 1, payload: { text: prompt, images: [], actorId: 'owner' } });
  let wake, ended = false, unsubscribe = () => {}, calls = 0;
  const pending = [];
  const adapter = new CopilotDispatchAdapter({ epoch, start: execution => {
    calls++; assert.equal(journal.current(key)?.id, execution.id);
    unsubscribe = session.on(event => {
      pending.push(copilotLifecycleFrame(event));
      if (event.type === 'session.idle') ended = true;
      wake?.();
    });
    return { verified: Promise.resolve({ ...status, sessionId: session.sessionId }),
      admitted: session.send(prompt).then(messageId => ({ messageId })),
      interrupt: () => session.abort(), inspectQuiescence: async () => false,
      historyIdentities: async () => ({ sessionId: session.sessionId, entries: copilotHistoryIdentities(await session.getEvents()) }),
      close: () => { unsubscribe(); ended = true; wake?.(); },
      async *[Symbol.asyncIterator]() {
        while (!ended || pending.length) {
          if (pending.length) yield pending.shift();
          else await new Promise(resolve => { wake = resolve; });
        }
      } };
  }, terminal: (ref, outcome) => dispatch.terminal(ref, outcome), unknown: ref => journal.markUnknown(ref, turns) });
  const dispatch = new SdkDispatch({ adapter, journal, turns, authorize: () => true, deadlineMs: 10_000 });
  try {
    assert.equal(await dispatch.dispatch(key), 'accepted');
    const deadline = Date.now() + 20_000;
    while (journal.current(key)?.phase === 'running') {
      assert.ok(Date.now() < deadline, 'Native lifecycle did not reach terminal');
      await new Promise(resolve => { const timer = setTimeout(resolve, 20); timer.unref(); });
    }
    await setImmediate();
    assert.equal(journal.current(key)?.phase, 'settling');
    assert.equal(journal.current(key)?.outcome, 'completed');
    assert.equal(await dispatch.settle(journal.current(key)), false, 'Session idle is not descendant cleanup');
    assert.equal(await dispatch.dispatch(key), 'not_started'); assert.equal(calls, 1);
  } finally { unsubscribe(); adapter.close(); db.close(); }
}
