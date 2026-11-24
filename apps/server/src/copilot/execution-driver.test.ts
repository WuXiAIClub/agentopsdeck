import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import { CopilotExecutionDriver } from './execution-driver.js';
import { COPILOT_CLI_VERSION, type CopilotHistoryIdentity } from './dispatch-adapter.js';
import { projectCopilotMessage } from './message-projection.js';

function fixture() {
  const store = new ConnectorUserStore(':memory:');
  const nativeSessionId = randomUUID(), key = `ghcp:${nativeSessionId}`;
  store.copilotJournal.create({ key, nativeSessionId, title: 'Fixture', createdAt: 1 });
  const calls: { execution: SdkExecution; text: string; finish: () => void; fail: () => void }[] = [];
  let authorized = true;
  const driver = new CopilotExecutionDriver({ store, deadlineMs: 1000, authorize: () => authorized,
    changed: () => { throw new Error('subscriber failure'); },
    start(execution, text, projection) {
      let release!: () => void, done!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const finished = new Promise<void>(resolve => { done = resolve; });
      let quiet = false, failed = false, closed = false, interrupted = false;
      const inputId = randomUUID(), inputEventId = randomUUID(), answerId = randomUUID(), answerEventId = randomUUID();
      const history: CopilotHistoryIdentity[] = [];
      calls.push({ execution, text, finish: release, fail: () => { failed = true; release(); } });
      return {
        finished, verified: Promise.resolve({ sessionId: nativeSessionId, version: COPILOT_CLI_VERSION, protocolVersion: 3 }),
        admitted: Promise.resolve({ messageId: inputId }),
        async *[Symbol.asyncIterator]() {
          try {
            const input = { id: inputEventId, type: 'user.message', timestamp: new Date().toISOString(), data: { messageId: inputId, content: text } };
            projection.project?.(projectCopilotMessage(input)!); yield input;
            history.push({ id: inputEventId, type: 'user.message', messageId: inputId });
            projection.stream?.({ messageId: answerId, text: 'Partial', truncated: false });
            await gate;
            if (failed) throw new Error('synthetic disconnected worker');
            if (closed) return;
            if (!interrupted) {
              const output = { id: answerEventId, type: 'assistant.message', timestamp: new Date().toISOString(),
                data: { messageId: answerId, originatingMessageId: inputId, content: 'Fixture reply' } };
              projection.project?.(projectCopilotMessage(output)!); yield output;
              history.push({ id: answerEventId, type: 'assistant.message', messageId: answerId, originatingMessageId: inputId });
            }
            yield { id: randomUUID(), type: 'session.idle', data: { aborted: interrupted } };
          } finally { quiet = true; done(); }
        },
        interrupt: async () => {
          assert.equal(store.copilotJournal.current(key)?.stopRequested, true);
          interrupted = true; release();
        },
        historyIdentities: async () => ({ sessionId: nativeSessionId, entries: history }),
        inspectQuiescence: async () => quiet && !failed,
        close: () => { closed = true; release(); },
      };
    },
  });
  const enqueue = (text: string) => {
    const id = randomUUID();
    store.turns.enqueue('ghcp', { id, sessionKey: key, createdAt: Date.now(), payload: { text, actorId: 'owner', images: [] } });
    return id;
  };
  return { store, key, calls, driver, enqueue, revoke: () => { authorized = false; },
    close: async () => { try { await driver.close(); } finally { store.close(); } } };
}

test('Copilot completion advances one FIFO batch with each admission identity preserved, no browser polling', async () => {
  const f = fixture();
  try {
    const one = f.enqueue('one'); await f.driver.wake(f.key);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.execution.nativeMode, 'create');
    const partialId = f.store.copilotTranscript.liveMessages(f.key)[0]!.id;
    const two = f.enqueue('two'), three = f.enqueue('three');
    await Promise.all([f.driver.wake(f.key), f.driver.wake(f.key)]);
    assert.equal(f.calls.length, 1);
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.execution.nativeMode, 'resume');
    assert.deepEqual(f.calls[1]!.execution.members, [two, three]);
    assert.match(f.calls[1]!.text, /^two\n\n\[Queued message boundary [a-f0-9-]+\]\n\nthree$/);
    f.calls[1]!.finish(); await setImmediate();
    assert.equal(f.store.copilotJournal.current(f.key)?.phase, 'completed');
    const messages = f.store.copilotTranscript.page(f.key)!.messages;
    assert.equal(messages.length, 5); assert.equal(messages[1]!.id, partialId);
    assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.id), [one, two, three]);
    assert.equal(f.store.turns.maintenanceCount(), 0);
    assert.equal(f.store.copilotTranscript.liveMessages(f.key).length, 0);
  } finally { await f.close(); }
});

test('maintenance pause permits settlement but not successor admission; resume is one-use', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two');
    const lease = f.driver.pauseQueueWorker(); assert.equal(lease.resume(), false); await lease.drained;
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.store.copilotJournal.current(f.key)?.phase, 'completed'); assert.equal(f.calls.length, 1);
    assert.equal(lease.resume(), true); assert.equal(lease.resume(), false);
    await setImmediate(); assert.equal(f.calls.length, 2);
    f.calls[1]!.finish(); await setImmediate();
  } finally { await f.close(); }
});

test('stale stop cannot hit successor and fresh authority is checked at successor dispatch', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two'); f.revoke();
    const ref = f.store.copilotJournal.current(f.key)!;
    assert.equal(await f.driver.interrupt(f.key, 'stale', { text: '', images: [], actorId: 'owner' }), 'not_started');
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.store.copilotJournal.current(f.key)?.id, ref.id);
    assert.equal(f.calls.length, 1); assert.equal(f.store.turns.head('ghcp', f.key)?.state, 'blocked');
  } finally { await f.close(); }
});

test('exact-run stop persists interrupted outcome and ends partial preview', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key);
    assert.equal(await f.driver.interrupt(f.key, f.calls[0]!.execution.id, { text: '', images: [], actorId: 'owner' }), 'accepted');
    await setImmediate(); assert.equal(f.store.copilotJournal.current(f.key)?.phase, 'interrupted');
    assert.equal(f.store.copilotTranscript.liveMessages(f.key).length, 0);
  } finally { await f.close(); }
});

test('unconfirmed cleanup fences successors and cannot be cleared by ordinary pause/resume', async () => {
  const f = fixture();
  f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two');
  f.calls[0]!.fail(); await setImmediate();
  assert.equal(f.store.copilotJournal.current(f.key)?.phase, 'unknown');
  assert.equal(f.driver.inspect().cleanupUnconfirmed, true);
  const lease = f.driver.pauseQueueWorker(); await lease.drained;
  assert.equal(lease.resume(), false); await f.driver.wake(f.key); assert.equal(f.calls.length, 1);
  await assert.rejects(f.close(), /cleanup is unconfirmed/);
});
