import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import { CLAUDE_CLI_VERSION } from './dispatch-adapter.js';
import { ClaudeExecutionDriver } from './execution-driver.js';
import { projectClaudeMessage } from './message-projection.js';

function fixture() {
  const store = new ConnectorUserStore(':memory:');
  const key = `claude-code:${randomUUID()}`;
  store.claudeJournal.create({ key, nativeSessionId: randomUUID(), title: 'Fixture', createdAt: 0 });
  let authorized = true;
  const calls: { execution: SdkExecution; text: string; finish: () => void; fail: () => void }[] = [];
  const driver = new ClaudeExecutionDriver({ store, deadlineMs: 1000,
    authorize: () => authorized,
    // Listener failures cannot destroy committed history or block queue progress.
    changed: () => { throw new Error('synthetic observer failure'); },
    start(execution, text, project) {
      let release!: () => void, done!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const finished = new Promise<void>(resolve => { done = resolve; });
      let quiet = false, failed = false, closed = false, interrupted = false, assistant = false;
      const assistantId = randomUUID(), session_id = execution.nativeSessionId;
      calls.push({ execution, text, finish: release, fail: () => { failed = true; release(); } });
      return {
        finished,
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: 'system', subtype: 'init', session_id, claude_code_version: CLAUDE_CLI_VERSION };
            const input = { type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null,
              message: { role: 'user', content: text } };
            project(projectClaudeMessage(input, session_id)); yield input;
            await gate;
            if (failed) throw new Error('synthetic native disconnect');
            if (closed) return;
            if (!interrupted) {
              const output = { type: 'assistant', uuid: assistantId, session_id, parent_tool_use_id: null,
                user_message_uuid: execution.id, message: { role: 'assistant', content: 'Fixture reply' } };
              project(projectClaudeMessage(output, session_id)); assistant = true; yield output;
            }
            yield { type: 'result', uuid: randomUUID(), session_id, user_message_uuid: execution.id,
              subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted };
          } finally { quiet = true; done(); }
        },
        interrupt: async () => {
          assert.equal(store.claudeJournal.current(key)?.stopRequested, true, 'native stop follows durable intent');
          interrupted = true; release();
        },
        historyIdentities: async () => [
          { type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null },
          ...(assistant ? [{ type: 'assistant', uuid: assistantId, session_id, parent_tool_use_id: null }] : []),
        ],
        inspectQuiescence: async () => quiet,
        close: () => { closed = true; release(); },
      };
    },
  });
  const enqueue = (text: string) => store.turns.enqueue('claude-code', { id: randomUUID(), sessionKey: key,
    createdAt: Date.now(), payload: { text, actorId: 'owner', images: [] } });
  return { store, key, driver, calls, enqueue, revoke: () => { authorized = false; },
    close: async () => { await driver.close(); store.close(); } };
}

test('Claude driver advances and batches queued inputs after terminal/history, without history polling', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.execution.nativeMode, 'create');
    f.enqueue('two'); f.enqueue('three');
    await Promise.all([f.driver.wake(f.key), f.driver.wake(f.key)]);
    assert.equal(f.calls.length, 1);
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.calls.length, 2, 'native drain event wakes the next batch');
    assert.equal(f.calls[1]!.execution.nativeMode, 'resume');
    assert.equal(f.calls[1]!.execution.members.length, 2);
    assert.match(f.calls[1]!.text, /^two\n\n\[Queued message boundary [a-f0-9-]+\]\n\nthree$/);
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'running');
    f.calls[1]!.finish(); await setImmediate();
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'completed');
    assert.equal(f.store.claudeJournal.session(f.key)?.nativeState, 'ready');
    assert.equal(f.store.claudeTranscript.page(f.key).messages.length, 4);
    assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { await f.close(); }
});

test('stream cleanup failure fences dispatch without leaking worker counts or replaying inputs', async () => {
  const f = fixture();
  try {
    f.store.claudeTranscript.endStreams = () => { throw new Error('synthetic projection failure'); };
    f.enqueue('first'); await f.driver.wake(f.key);
    f.enqueue('waiting'); f.calls[0]!.finish(); await setImmediate();
    await f.driver.wake(f.key);
    assert.equal(f.driver.inspect().nativeWorkers, 0);
    assert.equal(f.driver.inspect().faulted, true);
    assert.equal(f.driver.inspect().admissionPaused, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.turns.maintenanceCount(), 1);
    const pause = f.driver.pauseQueueWorker(); await pause.drained;
    assert.equal(pause.resume(), false);
  } finally { await f.close(); }
});

test('Claude driver pause settles the current turn but holds successor admission until one-use resume', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two');
    const lease = f.driver.pauseQueueWorker();
    assert.equal(lease.resume(), false); await lease.drained;
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'completed');
    assert.equal(f.calls.length, 1);
    assert.equal(lease.resume(), true); assert.equal(lease.resume(), false);
    await setImmediate(); assert.equal(f.calls.length, 2);
    f.calls[1]!.finish(); await setImmediate();
  } finally { await f.close(); }
});

test('Claude driver rechecks authorization at successor dispatch and keeps revoked input blocked', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two'); f.revoke();
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'blocked');
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'completed');
  } finally { await f.close(); }
});

test('Claude driver freezes disconnects without replay or dispatching a queued successor', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two');
    f.calls[0]!.fail(); await setImmediate();
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'unknown');
    assert.equal(f.store.claudeJournal.session(f.key)?.nativeState, 'unknown');
    await f.driver.wake(f.key); await f.driver.wake(f.key);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
    assert.equal(f.store.claudeTranscript.page(f.key).messages.length, 1, 'visible input is not completion proof');
  } finally { await f.close(); }
});

test('Claude driver stop uses persisted intent and native proof before progressing the queue', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key);
    assert.equal(await f.driver.interrupt(f.key, f.store.claudeJournal.current(f.key)!.id,
      { actorId: 'owner', text: '', images: [] }), 'accepted');
    await setImmediate();
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'interrupted');
    assert.equal(f.store.claudeJournal.session(f.key)?.nativeState, 'ready');
    f.enqueue('two'); await f.driver.wake(f.key);
    assert.equal(f.calls[1]!.execution.nativeMode, 'resume');
    f.calls[1]!.finish(); await setImmediate();
  } finally { await f.close(); }
});

test('Claude driver close waits for workers, is idempotent, and does not send queued input', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.driver.wake(f.key); f.enqueue('two');
    const closing = f.driver.close(); assert.equal(f.driver.close(), closing); await closing;
    await f.driver.wake(f.key); assert.equal(f.calls.length, 1);
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'unknown');
    assert.equal(f.store.turns.maintenanceCount(), 1);
    assert.throws(() => f.driver.pauseQueueWorker(), /closed/);
  } finally { await f.close(); }
});

test('Claude driver internal persistence fault cannot be cleared by a maintenance resume', async () => {
  const f = fixture();
  try {
    const current = f.store.claudeJournal.current.bind(f.store.claudeJournal);
    f.store.claudeJournal.current = () => { throw new Error('synthetic persistence failure'); };
    await f.driver.wake(f.key);
    f.store.claudeJournal.current = current;
    const lease = f.driver.pauseQueueWorker(); await lease.drained;
    assert.equal(lease.resume(), false);
    f.enqueue('must not start'); await f.driver.wake(f.key);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Claude unconfirmed worker cleanup fences other sessions and cannot be cleared by resume', async () => {
  const store = new ConnectorUserStore(':memory:'); let starts = 0;
  const first = `claude-code:${randomUUID()}`, second = `claude-code:${randomUUID()}`;
  for (const key of [first, second]) store.claudeJournal.create({ key, nativeSessionId: randomUUID(), title: 'Fixture', createdAt: 0 });
  const driver = new ClaudeExecutionDriver({ store, deadlineMs: 1000, authorize: () => true,
    start: () => {
      starts++;
      return { finished: Promise.resolve(), async *[Symbol.asyncIterator]() { throw new Error('fixture lost worker'); },
        interrupt: async () => {}, historyIdentities: async () => [], inspectQuiescence: async () => false, close: () => {} };
    },
  });
  const enqueue = (sessionKey: string) => store.turns.enqueue('claude-code', { id: randomUUID(), sessionKey,
    createdAt: 0, payload: { text: 'Fixture', actorId: 'owner', images: [] } });
  try {
    enqueue(first); await driver.wake(first); await setImmediate();
    assert.equal(driver.inspect().cleanupUnconfirmed, true);
    enqueue(second); await driver.wake(second);
    assert.equal(starts, 1); assert.equal(store.claudeJournal.current(second), undefined);
    assert.equal(store.turns.head('claude-code', second)?.state, 'queued');
    const pause = driver.pauseQueueWorker(); await pause.drained; assert.equal(pause.resume(), false);
    await assert.rejects(driver.close(), /cleanup is unconfirmed/);
  } finally { await driver.close().catch(() => {}); store.close(); }
});
