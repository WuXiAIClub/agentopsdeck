import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkDispatch } from '../connector/sdk-dispatch.js';
import { SdkExecutionJournal } from '../connector/sdk-execution-journal.js';
import { COPILOT_CLI_VERSION, CopilotDispatchAdapter, type CopilotHistoryIdentity, type CopilotNativeTurn } from './dispatch-adapter.js';

class Events implements AsyncIterable<unknown> {
  private pending: unknown[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(value: unknown) { this.pending.push(value); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.pending.length) {
      if (this.pending.length) yield this.pending.shift();
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
function fixture(t: TestContext, version = COPILOT_CLI_VERSION, terminal?: (commit: () => boolean) => boolean | Promise<boolean>) {
  const db = new DatabaseSync(':memory:'), turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, 'ghcp');
  const nativeSessionId = randomUUID(), key = `ghcp:${nativeSessionId}`, epoch = randomUUID();
  journal.create({ key, nativeSessionId, title: '', createdAt: 1 });
  const events = new Events(), messageId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), answerId = randomUUID();
  let accept!: (value: { messageId: string }) => void, reject!: (error: Error) => void;
  let history: CopilotHistoryIdentity[] = [], quiet = false, stopped = 0, calls = 0, drained = 0;
  const native: CopilotNativeTurn = { verified: Promise.resolve({ sessionId: nativeSessionId, version, protocolVersion: 3 }),
    admitted: new Promise((resolve, fail) => { accept = resolve; reject = fail; }),
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), interrupt: async () => { stopped++; },
    inspectQuiescence: async () => quiet, historyIdentities: async () => ({ sessionId: nativeSessionId, entries: history }),
    close: () => events.end() };
  const adapter: CopilotDispatchAdapter = new CopilotDispatchAdapter({ epoch, start: execution => {
    calls++; assert.equal(journal.current(key)?.id, execution.id); return native;
  }, terminal: (ref, outcome) => terminal ? terminal(() => dispatch.terminal(ref, outcome)) : dispatch.terminal(ref, outcome),
  unknown: ref => { journal.markUnknown(ref, turns); },
  drained: () => { drained++; } });
  const dispatch: SdkDispatch = new SdkDispatch({ adapter, journal, turns, authorize: () => true, deadlineMs: 200 });
  const enqueue = () => turns.enqueue('ghcp', { id: randomUUID(), sessionKey: key, createdAt: 1,
    payload: { text: 'Hi', images: [], actorId: 'owner' } });
  const event = (type: string, data: Record<string, unknown> = {}, extra = {}) => events.push({ id: randomUUID(), type, data, ...extra });
  const user = () => event('user.message', { messageId }, { id: userId });
  const reply = () => event('assistant.message', { messageId: answerId, originatingMessageId: messageId }, { id: assistantId });
  const persist = () => { history = [{ id: userId, type: 'user.message', messageId },
    { id: assistantId, type: 'assistant.message', messageId: answerId, originatingMessageId: messageId }]; };
  t.after(() => { adapter.close(); db.close(); });
  return { turns, journal, key, nativeSessionId, messageId, userId, events, native, adapter, dispatch, enqueue, event, user, reply, persist,
    current: () => journal.current(key)!, ack: (id: string = messageId) => accept({ messageId: id }), reject: () => reject(new Error('PRIVATE ERROR')),
    quiet: () => { quiet = true; }, setHistory: (value: CopilotHistoryIdentity[]) => { history = value; },
    calls: () => calls, stopped: () => stopped, drained: () => drained };
}

test('Copilot native ACK and root user echo bind durable queue; model turn_end/assistant idle never settle', async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack();
  assert.equal(await send, 'accepted'); f.user(); f.reply();
  f.event('assistant.turn_end', { turnId: 'iteration' }); f.event('assistant.idle'); await setImmediate();
  assert.equal(f.current().phase, 'running'); f.enqueue();
  assert.equal(await f.dispatch.dispatch(f.key), 'not_started'); assert.equal(f.calls(), 1);
  f.event('session.idle'); f.events.end(); await setImmediate();
  assert.equal(f.current().phase, 'settling');
  f.persist(); assert.equal(await f.dispatch.settle(f.current()), false, 'durable history alone does not prove cleanup');
  f.quiet(); assert.equal(await f.dispatch.settle(f.current()), true);
  assert.equal(f.current().phase, 'completed'); assert.equal(f.journal.canStart(f.key), true);
});

test('Copilot fast completion before ACK waits for exact send identity, then wakes settlement', async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key);
  f.user(); f.reply(); f.event('session.idle'); f.events.end(); await setImmediate();
  assert.equal(f.current().phase, 'dispatching');
  f.ack(); assert.equal(await send, 'accepted'); assert.equal(f.current().phase, 'settling');
  assert.ok(f.drained() >= 2); f.persist(); f.quiet(); assert.equal(await f.dispatch.settle(f.current()), true);
});

test('Copilot startup idle and child terminal never finish this root run', async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack(); await send;
  f.event('session.idle'); f.user(); f.reply(); f.event('session.idle', {}, { agentId: 'child' }); await setImmediate();
  assert.equal(f.current().phase, 'running');
  f.event('session.idle'); f.events.end(); await setImmediate(); assert.equal(f.current().phase, 'settling');
});

test('Copilot exact stop requires native aborted idle, durable input and process quiescence', async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack(); await send; f.user(); await setImmediate();
  const actor = { text: '', images: [] as [], actorId: 'owner' };
  assert.equal(await f.dispatch.interrupt({ ...f.current(), id: randomUUID() }, actor), 'not_started');
  assert.equal(await f.dispatch.interrupt(f.current(), actor), 'accepted'); assert.equal(f.stopped(), 1);
  assert.equal(f.current().phase, 'running');
  f.event('session.idle', { aborted: true }); f.events.end(); await setImmediate();
  f.quiet(); f.setHistory([{ id: f.userId, type: 'user.message', messageId: f.messageId }]);
  assert.equal(await f.dispatch.settle(f.current()), true); assert.equal(f.current().phase, 'interrupted');
});

test('Copilot denied tool is failed, not successful empty reply; late duplicate start does not resurrect work', async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack(); await send;
  f.user(); f.event('tool.execution_start', { toolCallId: 'tool' });
  f.event('tool.execution_complete', { toolCallId: 'tool', success: false });
  f.event('tool.execution_start', { toolCallId: 'tool' }); f.event('session.idle'); f.events.end(); await setImmediate();
  f.quiet(); f.setHistory([{ id: f.userId, type: 'user.message', messageId: f.messageId }]);
  assert.equal(await f.dispatch.settle(f.current()), true); assert.equal(f.current().phase, 'failed');
});

for (const scenario of ['foreign-ack', 'foreign-user', 'foreign-answer', 'lost-ack', 'unfinished-tool', 'missing-idle', 'version']) {
  test(`Copilot ${scenario} remains unknown and never retries the admitted input`, async t => {
    const f = fixture(t, scenario === 'version' ? '0.0.0' : COPILOT_CLI_VERSION); f.enqueue();
    const send = f.dispatch.dispatch(f.key);
    if (scenario === 'lost-ack') f.reject(); else f.ack(scenario === 'foreign-ack' ? 'foreign' : undefined);
    f.user();
    if (scenario === 'foreign-user') f.event('user.message', { messageId: 'foreign' });
    if (scenario === 'foreign-answer') f.event('assistant.message', { messageId: 'answer', originatingMessageId: 'foreign' });
    else f.reply();
    if (scenario === 'unfinished-tool') f.event('tool.execution_start', { toolCallId: 'tool' });
    if (scenario !== 'missing-idle') f.event('session.idle');
    f.events.end(); await send; await setImmediate();
    assert.equal(f.current().phase, 'unknown'); assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
    assert.equal(f.calls(), 1); assert.equal(await f.dispatch.settle(f.current()), false);
  });
}

for (const requested of [true, false]) test(`Copilot aborted unfinished tool requires exact stop (${requested}) and cleanup`, async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack(); await send;
  f.user(); f.reply(); f.event('tool.execution_start', { toolCallId: 'shell' }); await setImmediate();
  if (requested) assert.equal(await f.dispatch.interrupt(f.current(), { text: '', images: [], actorId: 'owner' }), 'accepted');
  f.event('session.idle', { aborted: true }); f.events.end(); await setImmediate();
  assert.equal(f.current().phase, requested ? 'settling' : 'unknown');
  assert.equal(await f.dispatch.settle(f.current()), false);
  f.persist(); assert.equal(await f.dispatch.settle(f.current()), false);
  f.quiet(); assert.equal(await f.dispatch.settle(f.current()), requested);
  assert.equal(f.current().phase, requested ? 'interrupted' : 'unknown');
  assert.equal(f.journal.canStart(f.key), requested);
  assert.equal(f.calls(), 1);
});

test('Copilot missing or cross-session persisted history cannot release the next queued turn', async t => {
  const f = fixture(t); f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack(); await send;
  f.user(); f.reply(); f.event('session.idle'); f.events.end(); await setImmediate(); f.quiet();
  assert.equal(await f.dispatch.settle(f.current()), false); f.persist();
  const history = f.native.historyIdentities;
  f.native.historyIdentities = async () => ({ ...await history(), sessionId: 'foreign' });
  assert.equal(await f.dispatch.settle(f.current()), false);
  f.native.historyIdentities = history; assert.equal(await f.dispatch.settle(f.current()), true);
});

for (const ackFirst of [true, false]) test(`Copilot original async terminal ACK gates settlement (native ACK first: ${ackFirst})`, async t => {
  let release!: () => void, terminals = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, COPILOT_CLI_VERSION, async commit => { terminals++; await gate; return commit(); });
  f.enqueue(); const send = f.dispatch.dispatch(f.key);
  let sendSettled = false; void send.then(() => { sendSettled = true; });
  if (ackFirst) { f.ack(); assert.equal(await send, 'accepted'); }
  f.user(); f.reply(); f.event('session.idle'); f.event('session.idle'); f.events.end();
  await setImmediate();
  if (!ackFirst) { assert.equal(terminals, 0); f.ack(); await setImmediate(); }
  assert.equal(sendSettled, ackFirst, 'native send acknowledgement cannot treat a pending terminal Promise as true');
  assert.equal(terminals, 1); assert.equal(f.current().phase, ackFirst ? 'running' : 'dispatching');
  f.enqueue(); const queued = f.turns.list('ghcp', f.key);
  f.persist(); f.quiet(); assert.equal(await f.dispatch.settle(f.current()), false);
  assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
  assert.deepEqual(f.turns.list('ghcp', f.key), queued);
  release(); assert.equal(await send, 'accepted'); await setImmediate();
  assert.equal(terminals, 1); assert.equal(f.current().phase, 'settling');
  assert.equal(await f.dispatch.settle(f.current()), true);
  assert.equal(f.current().phase, 'completed'); assert.equal(f.calls(), 1);
  assert.deepEqual(f.turns.list('ghcp', f.key), queued.filter(entry => entry.state === 'queued'));
});

for (const outcome of ['false', 'reject', 'close'] as const) test(`Copilot async terminal ${outcome} stays unknown without replay`, async t => {
  let release!: () => void, terminals = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, COPILOT_CLI_VERSION, async () => {
    terminals++; await gate;
    if (outcome === 'reject') throw Error('private owner reply failure');
    return outcome === 'close';
  });
  f.enqueue(); const send = f.dispatch.dispatch(f.key); f.ack(); await send;
  f.enqueue(); const queued = f.turns.list('ghcp', f.key);
  f.user(); f.reply(); f.event('session.idle'); f.events.end(); await setImmediate();
  assert.equal(terminals, 1); if (outcome === 'close') f.adapter.close();
  release(); await setImmediate(); f.persist(); f.quiet();
  assert.equal(f.current().phase, 'unknown'); assert.equal(await f.dispatch.settle(f.current()), false);
  assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
  assert.equal(f.calls(), 1); assert.equal(terminals, 1);
  assert.deepEqual(f.turns.list('ghcp', f.key), queued);
});
