import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkDispatch } from '../connector/sdk-dispatch.js';
import { SdkExecutionJournal } from '../connector/sdk-execution-journal.js';
import { ClaudeDispatchAdapter, CLAUDE_CLI_VERSION, type ClaudeNativeTurn } from './dispatch-adapter.js';

class Events implements AsyncIterable<unknown> {
  private pending: unknown[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private error: Error | undefined;
  push(event: unknown) { this.pending.push(event); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  fail() { this.error = new Error('PRIVATE SDK ERROR'); this.end(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.pending.length) {
      if (this.pending.length) yield this.pending.shift();
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
    if (this.error) throw this.error;
  }
}
function fixture(terminal?: (commit: () => boolean) => boolean | Promise<boolean>) {
  const db = new DatabaseSync(':memory:');
  const turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, 'claude-code');
  const key = `claude-code:${randomUUID()}`, nativeSessionId = randomUUID();
  journal.create({ key, nativeSessionId, title: 'Fixture', createdAt: 0 });
  const events = new Events();
  let calls = 0, stopped = 0, quiet = false;
  let history: Awaited<ReturnType<ClaudeNativeTurn['historyIdentities']>> = [];
  const native: ClaudeNativeTurn = { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    interrupt: async () => { stopped++; }, historyIdentities: async () => history,
    inspectQuiescence: async () => quiet, close: () => events.end() };
  const adapter: ClaudeDispatchAdapter = new ClaudeDispatchAdapter({ epoch: randomUUID(),
    start: execution => { calls++; assert.equal(journal.current(key)?.id, execution.id); return native; },
    terminal: (ref, outcome) => terminal ? terminal(() => dispatch.terminal(ref, outcome)) : dispatch.terminal(ref, outcome),
    unknown: ref => { journal.markUnknown(ref, turns); } });
  const dispatch: SdkDispatch = new SdkDispatch({ adapter, journal, turns, authorize: () => true, deadlineMs: 1000 });
  const enqueue = () => turns.enqueue('claude-code', { id: randomUUID(), sessionKey: key, createdAt: 0,
    payload: { text: 'Hi', images: [], actorId: 'owner' } });
  const current = () => journal.current(key)!;
  const push = (event: Record<string, unknown>) => events.push({ session_id: nativeSessionId, ...event });
  const init = () => push({ type: 'system', subtype: 'init', claude_code_version: CLAUDE_CLI_VERSION });
  const assistantId = randomUUID(), resultId = randomUUID();
  const reply = () => push({ type: 'assistant', uuid: assistantId, user_message_uuid: current().id,
    parent_tool_use_id: null, message: { role: 'assistant' } });
  const result = (error = false) => push({ type: 'result', uuid: resultId, is_error: error, user_message_uuid: current().id });
  const persist = () => {
    history = [{ type: 'user', uuid: current().id, session_id: nativeSessionId, parent_tool_use_id: null },
      { type: 'assistant', uuid: assistantId, session_id: nativeSessionId, parent_tool_use_id: null }];
  };
  return { db, turns, journal, key, nativeSessionId, adapter, dispatch, events, native, enqueue, current, push, init, reply, result, persist,
    assistantId, resultId, setQuiet: (value: boolean) => { quiet = value; }, setHistory: (rows: typeof history) => { history = rows; },
    calls: () => calls, stopped: () => stopped,
    close: () => { adapter.close(); db.close(); } };
}

test('Claude correlated admission -> result -> durable root history AND quiescence, not SDK idle', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key);
    f.init(); f.reply(); assert.equal(await sending, 'accepted');
    assert.equal(f.current().phase, 'running'); assert.equal(f.turns.maintenanceCount(), 0);
    f.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    await setImmediate(); assert.equal(f.current().phase, 'running');
    f.result(); f.events.end(); await setImmediate();
    assert.equal(f.current().phase, 'settling');
    assert.equal(await f.dispatch.settle(f.current()), false);
    f.setQuiet(true); assert.equal(await f.dispatch.settle(f.current()), false);
    f.persist(); assert.equal(await f.dispatch.settle(f.current()), true);
    assert.equal(f.current().phase, 'completed'); assert.equal(f.calls(), 1);
  } finally { f.close(); }
});

test('Claude initialization and child frames do not acknowledge or complete the root input', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key);
    f.push({ type: 'command_lifecycle', uuid: randomUUID() });
    f.init();
    f.push({ type: 'assistant', parent_tool_use_id: 'child', uuid: randomUUID(), user_message_uuid: randomUUID() });
    f.push({ type: 'result', parent_tool_use_id: 'child', uuid: randomUUID(), is_error: false });
    await setImmediate(); assert.equal(f.current().phase, 'dispatching');
    f.reply(); assert.equal(await sending, 'accepted');
    assert.equal(f.current().phase, 'running');
  } finally { f.close(); }
});

test('Claude terminal-before-ACK proves admission but is not ready for a successor', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.result(true);
    assert.equal(await sending, 'accepted'); assert.equal(f.current().phase, 'settling');
    f.enqueue(); assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
    assert.equal(f.calls(), 1);
  } finally { f.close(); }
});

for (const reason of ['wrong-version', 'foreign-session', 'foreign-send', 'extra-send', 'native-queue', 'uncorrelated-result', 'missing-init', 'lost-result']) {
  test(`Claude ${reason} freezes intent without replay or exposing native error text`, async () => {
    const f = fixture();
    try {
      f.enqueue(); const sending = f.dispatch.dispatch(f.key);
      if (!['wrong-version', 'missing-init'].includes(reason)) f.init();
      if (reason === 'wrong-version') f.push({ type: 'system', subtype: 'init', claude_code_version: 'unverified' });
      else if (reason === 'foreign-session') f.push({ type: 'assistant', session_id: randomUUID() });
      else if (reason === 'foreign-send') f.push({ type: 'assistant', user_message_uuid: randomUUID() });
      else if (reason === 'extra-send') f.push({ type: 'assistant', user_message_uuid: f.current().id, user_message_uuids: [f.current().id, randomUUID()] });
      else if (reason === 'native-queue') f.push({ type: 'result', uuid: randomUUID(), is_error: false, user_message_uuid: f.current().id, queued_turn_count: 1 });
      else if (reason === 'uncorrelated-result') f.push({ type: 'result', uuid: randomUUID(), is_error: true, errors: ['PRIVATE ERROR'] });
      else if (reason === 'missing-init') f.reply();
      f.events.end(); assert.equal(await sending, 'unknown');
      assert.equal(f.current().phase, 'unknown');
      assert.equal(await f.dispatch.dispatch(f.key), 'not_started'); assert.equal(f.calls(), 1);
    } finally { f.close(); }
  });
}

test('Claude task completion, including duplicates, never substitutes for root result/quiescence', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.push({ type: 'system', subtype: 'task_started', task_id: 'child' });
    f.result(); await setImmediate(); f.setQuiet(true); f.persist();
    assert.equal(await f.dispatch.settle(f.current()), false);
    f.push({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed' });
    f.push({ type: 'system', subtype: 'task_started', task_id: 'child' });
    f.result(); f.events.end(); await setImmediate();
    assert.equal(await f.dispatch.settle(f.current()), true);
  } finally { f.close(); }
});

test('Claude root result with an outstanding background task cannot settle even on process exit', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.push({ type: 'system', subtype: 'task_started', task_id: 'background', ambient: true });
    f.result(); f.events.end(); await setImmediate(); f.setQuiet(true); f.persist();
    assert.equal(await f.dispatch.settle(f.current()), false);
  } finally { f.close(); }
});

test('Claude stop uses persisted intent; successful interrupt ACK does not mean completed', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    assert.equal(await f.dispatch.interrupt(f.current(), { text: '', images: [], actorId: 'owner' }), 'accepted');
    assert.equal(f.current().phase, 'running'); assert.equal(f.stopped(), 1);
    f.result(true); f.events.fail(); await setImmediate(); f.persist(); f.setQuiet(true);
    assert.equal(await f.dispatch.settle(f.current()), true); assert.equal(f.current().phase, 'interrupted');
  } finally { f.close(); }
});

test('Claude protocol failure after interrupt result cannot be excused as SDK interrupt exception', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    await f.dispatch.interrupt(f.current(), { text: '', images: [], actorId: 'owner' });
    f.result(true); f.push({ type: 'result', session_id: 'other' });
    f.events.end(); await setImmediate(); f.persist(); f.setQuiet(true);
    assert.equal(f.current().phase, 'unknown'); assert.equal(await f.dispatch.settle(f.current()), false);
  } finally { f.close(); }
});

test('Claude disconnect during settlement cannot return a ready proof', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.result(); f.events.end(); await setImmediate(); f.persist(); f.setQuiet(true);
    let inspections = 0;
    f.native.inspectQuiescence = async () => { if (++inspections === 2) f.adapter.close(); return true; };
    assert.equal(await f.dispatch.settle(f.current()), false); assert.equal(f.current().phase, 'unknown');
  } finally { f.close(); }
});

test('Claude durable evidence must contain exactly one matching root input and every root assistant', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.result(); f.events.end(); await setImmediate(); f.setQuiet(true);
    const user = { type: 'user', uuid: f.current().id, session_id: f.nativeSessionId, parent_tool_use_id: null };
    const assistant = { ...user, type: 'assistant', uuid: f.assistantId };
    for (const rows of [[user], [user, user, assistant], [user, { ...assistant, parent_tool_use_id: 'child' }],
      [user, { ...assistant, session_id: 'other' }]]) {
      f.setHistory(rows); assert.equal(await f.dispatch.settle(f.current()), false);
    }
    f.persist(); assert.equal(await f.dispatch.settle(f.current()), true);
  } finally { f.close(); }
});

test('Claude disconnect ignores late terminal and settlement; SDK exception after ACK is unknown', async () => {
  const f = fixture();
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.adapter.close(); f.result(); await setImmediate();
    assert.equal(f.current().phase, 'unknown'); assert.equal(await f.dispatch.settle(f.current()), false);
  } finally { f.close(); }
  const g = fixture();
  try {
    g.enqueue(); const sending = g.dispatch.dispatch(g.key); g.init(); g.reply(); await sending;
    g.events.end(); await setImmediate(); assert.equal(g.current().phase, 'unknown');
  } finally { g.close(); }
});

test('Claude awaits original terminal ACK before EOF, settlement and successor admission', async () => {
  let release!: () => void, terminals = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async commit => { terminals++; await gate; return commit(); });
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.enqueue(); const queued = f.turns.list('claude-code', f.key);
    f.result(); f.result(); f.events.end(); f.persist(); f.setQuiet(true); await setImmediate();
    assert.equal(terminals, 1); assert.equal(f.current().phase, 'running');
    assert.equal(await f.dispatch.settle(f.current()), false);
    assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
    assert.deepEqual(f.turns.list('claude-code', f.key), queued);
    release(); await setImmediate();
    assert.equal(f.current().phase, 'settling'); assert.equal(terminals, 1);
    assert.equal(await f.dispatch.settle(f.current()), true);
    assert.equal(f.current().phase, 'completed'); assert.equal(f.calls(), 1);
    assert.deepEqual(f.turns.list('claude-code', f.key), queued);
  } finally { release(); f.close(); }
});

for (const outcome of ['false', 'reject', 'close'] as const) test(`Claude async terminal ${outcome} stays unknown without replay`, async () => {
  let release!: () => void, terminals = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => {
    terminals++; await gate;
    if (outcome === 'reject') throw Error('private owner reply failure');
    return outcome === 'close';
  });
  try {
    f.enqueue(); const sending = f.dispatch.dispatch(f.key); f.init(); f.reply(); await sending;
    f.enqueue(); const queued = f.turns.list('claude-code', f.key);
    f.result(); f.events.end(); await setImmediate(); assert.equal(terminals, 1);
    if (outcome === 'close') f.adapter.close();
    release(); await setImmediate();
    assert.equal(f.current().phase, 'unknown'); f.persist(); f.setQuiet(true);
    assert.equal(await f.dispatch.settle(f.current()), false);
    assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
    assert.equal(f.calls(), 1); assert.equal(terminals, 1);
    assert.deepEqual(f.turns.list('claude-code', f.key), queued);
  } finally { release(); f.close(); }
});
