import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkDispatch, type SdkDispatchAdapter, type SdkTextInput } from './sdk-dispatch.js';
import { SdkExecutionJournal, type SdkAgentId } from './sdk-execution-journal.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(runtime: SdkAgentId = 'claude-code', deadlineMs = 1000, turnContext?: (key: string, input: SdkTextInput) => string) {
  const db = new DatabaseSync(':memory:');
  let startAvailable = true;
  const turns = new TurnQueue(db, undefined, undefined, undefined, () => startAvailable);
  const journal = new SdkExecutionJournal(db, runtime);
  const key = `${runtime}:session`;
  journal.create({ key, nativeSessionId: 'native-session', title: 'Test', createdAt: 0 });
  const calls: string[] = [];
  const adapter: SdkDispatchAdapter = { epoch: 'epoch', ready: true,
    send: async (execution, text) => {
      assert.equal(journal.current(key)?.id, execution.id, 'intent committed before side effect');
      assert.equal(turns.head(runtime, key)?.state, 'dispatching');
      calls.push(text); return { nativeRequestId: 'native-request' };
    },
    interrupt: async () => { calls.push('interrupt'); },
    inspectSettlement: async execution => ({ ...execution, historyPersisted: true, nativeQuiescent: true }),
  };
  const denied = new Set<string>();
  const dispatch = new SdkDispatch({ journal, turns, adapter, deadlineMs, ...(turnContext ? { turnContext } : {}), authorize: (_key, input) => !denied.has(input.actorId) });
  const input = (text: string, actorId = 'owner'): SdkTextInput => ({ text, actorId, images: [] });
  const enqueue = (id: string, actorId = 'owner') => turns.enqueue(runtime, { id, sessionKey: key, createdAt: 0, payload: input(id, actorId) });
  return { db, turns, journal, key, adapter, dispatch, calls, denied, input, enqueue,
    fence: () => { startAvailable = false; } };
}

test('legacy context preparation cannot preserve stale authorization or adapter epoch at atomic claim', async () => {
  for (const change of ['authorization', 'epoch', 'pause'] as const) {
    let f: ReturnType<typeof fixture>;
    f = fixture('claude-code', 1000, () => {
      if (change === 'authorization') f.denied.add('owner');
      if (change === 'epoch') (f.adapter as { epoch: string }).epoch = 'replacement';
      if (change === 'pause') f.dispatch.pause();
      return 'context';
    });
    try {
      f.enqueue('one'); assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      assert.equal(f.journal.current(f.key), undefined); assert.equal(f.turns.head('claude-code', f.key)?.state, 'queued');
      assert.equal(f.calls.length, 0);
    } finally { f.db.close(); }
  }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: file context uses only a normally authorized turn without changing user payload or IDs`, async () => {
  let reads = 0;
  const f = fixture(runtime, 1000, (key, input) => { reads++; assert.equal(key, `${runtime}:session`); assert.equal(input.actorId, 'owner'); return 'Task progress file: /private/tasks.json'; });
  try {
    assert.equal(await f.dispatch.dispatch(f.key), 'not_started'); assert.equal(reads, 0);
    const text = 'x'.repeat(MAX_MESSAGE_CHARS);
    f.turns.enqueue(runtime, { id: 'original-id', sessionKey: f.key, createdAt: 0, payload: f.input(text) });
    f.adapter.send = async (execution, actual, context) => {
      assert.deepEqual(execution.members, ['original-id']); assert.equal(actual, text);
      assert.equal(context, 'Task progress file: /private/tasks.json');
      return { nativeRequestId: 'normal-request' };
    };
    assert.equal(await f.dispatch.dispatch(f.key), 'accepted'); assert.equal(reads, 1);
    assert.equal(await f.dispatch.dispatch(f.key), 'not_started'); assert.equal(reads, 1);
  } finally { f.db.close(); }
});

test('SDK FIFO batching respects native text limits including boundary separators', async () => {
  const f = fixture();
  try {
    for (const id of ['one', 'two', 'three']) f.turns.enqueue('claude-code', {
      id, sessionKey: f.key, createdAt: 0, payload: f.input('x'.repeat(MAX_MESSAGE_CHARS / 2)) });
    assert.equal(await f.dispatch.dispatch(f.key), 'accepted');
    assert.deepEqual(f.journal.current(f.key)?.members, ['one']);
    assert.equal(f.calls[0]!.length, MAX_MESSAGE_CHARS / 2);
    assert.deepEqual(f.turns.list('claude-code', f.key).map(row => row.id), ['two', 'three']);
  } finally { f.db.close(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: persisted FIFO batch is sent once, history and native quiescence gate successor`, async () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one'); f.enqueue('two');
      assert.equal(await f.dispatch.dispatch(f.key), 'accepted');
      const execution = f.journal.current(f.key)!;
      assert.deepEqual(execution.members, ['one', 'two']);
      assert.deepEqual(f.calls, [`one${execution.batch!.separator}two`]);
      assert.equal(JSON.stringify(execution).includes('"text"'), false);
      f.enqueue('three');
      assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      assert.equal(f.dispatch.terminal(execution, 'completed'), true);
      f.adapter.inspectSettlement = async execution => ({ ...execution, historyPersisted: true, nativeQuiescent: false });
      assert.equal(await f.dispatch.settle(execution), false);
      assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      f.adapter.inspectSettlement = async execution => ({ ...execution, historyPersisted: false, nativeQuiescent: true });
      assert.equal(await f.dispatch.settle(execution), false);
      f.adapter.inspectSettlement = async execution => ({ ...execution, historyPersisted: true, nativeQuiescent: true });
      assert.equal(await f.dispatch.settle(execution), true);
      assert.equal(await f.dispatch.dispatch(f.key), 'accepted');
      assert.equal(f.calls.length, 2);
      assert.equal(f.dispatch.terminal(execution, 'failed'), false);
    } finally { f.db.close(); }
  });

  test(`${runtime}: lost ACK freezes without replay; late ACK/terminal cannot unfreeze`, async () => {
    const f = fixture(runtime, 20), ack = deferred<{ nativeRequestId: string }>();
    try {
      f.adapter.send = () => { f.calls.push('send'); return ack.promise; };
      f.enqueue('one'); f.enqueue('two');
      const sending = f.dispatch.dispatch(f.key);
      const execution = f.journal.current(f.key)!;
      assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      assert.equal(await sending, 'unknown');
      assert.equal(f.turns.head(runtime, f.key)?.state, 'outcome_unknown');
      ack.resolve({ nativeRequestId: 'late' }); await Promise.resolve();
      assert.equal(f.dispatch.terminal(execution, 'completed'), false);
      assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
      assert.deepEqual(f.calls, ['send']);
    } finally { f.db.close(); }
  });
}

test('SDK batch never crosses principal boundary and revoked oldest input is not skipped', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); f.enqueue('two', 'other'); f.enqueue('three');
    await f.dispatch.dispatch(f.key);
    assert.deepEqual(f.journal.current(f.key)?.members, ['one']);
    const ref = f.journal.current(f.key)!;
    f.dispatch.terminal(ref, 'completed'); await f.dispatch.settle(ref);
    f.denied.add('other');
    assert.equal(await f.dispatch.dispatch(f.key), 'blocked');
    assert.equal(f.turns.head('claude-code', f.key)?.state, 'blocked');
    assert.equal(await f.dispatch.dispatch(f.key), 'not_started');
    assert.deepEqual(f.calls, ['one']);
  } finally { f.db.close(); }
});

test('SDK paused, pre-aborted and maintenance-fenced sends leave queue editable with no intent', async () => {
  for (const mode of ['pause', 'abort', 'fence']) {
    const f = fixture();
    try {
      f.enqueue('one');
      if (mode === 'pause') f.dispatch.pause();
      if (mode === 'fence') f.fence();
      assert.equal(await f.dispatch.dispatch(f.key, mode === 'abort' ? AbortSignal.abort() : undefined), 'not_started');
      assert.equal(f.journal.current(f.key), undefined);
      assert.equal(f.turns.head('claude-code', f.key)?.state, 'queued');
      assert.equal(f.calls.length, 0);
    } finally { f.db.close(); }
  }
});

test('correlated terminal before ACK proves admission but still requires settlement', async () => {
  const f = fixture(undefined, 20);
  try {
    f.adapter.send = execution => {
      f.calls.push('send');
      assert.equal(f.dispatch.terminal(execution, 'completed'), true);
      return new Promise(() => {});
    };
    f.enqueue('one');
    assert.equal(await f.dispatch.dispatch(f.key), 'accepted');
    assert.equal(f.journal.current(f.key)?.phase, 'settling');
    assert.equal(f.turns.hasPending('claude-code', f.key), false);
    assert.equal(await f.dispatch.settle(f.journal.current(f.key)!), true);
  } finally { f.db.close(); }
});

test('SDK stop persists intent and validates exact run/current authorization; ACK is not idle', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.dispatch.dispatch(f.key);
    const ref = f.journal.current(f.key)!;
    assert.equal(await f.dispatch.interrupt({ ...ref, id: 'stale' }, f.input('')), 'not_started');
    f.denied.add('other');
    assert.equal(await f.dispatch.interrupt(ref, f.input('', 'other')), 'blocked');
    f.adapter.interrupt = async execution => {
      assert.equal(f.journal.current(f.key)?.stopRequested, true);
      assert.equal(execution.stopRequested, true, 'native adapter receives the durable stop intent');
    };
    assert.equal(await f.dispatch.interrupt(ref, f.input('')), 'accepted');
    assert.equal(f.journal.current(f.key)?.phase, 'running');
    assert.equal(await f.dispatch.interrupt(ref, f.input('')), 'not_started');
    assert.equal(f.dispatch.terminal(ref, 'interrupted'), true);
    assert.equal(await f.dispatch.settle(ref), true);
  } finally { f.db.close(); }
});

test('SDK disconnect during send and stale settlement proof freeze exact execution', async () => {
  const f = fixture();
  try {
    const ack = deferred<{ nativeRequestId: string }>();
    f.adapter.send = () => ack.promise;
    f.enqueue('one'); const sending = f.dispatch.dispatch(f.key);
    f.dispatch.disconnected(); ack.resolve({ nativeRequestId: 'native' });
    assert.equal(await sending, 'unknown');
    assert.equal(f.journal.current(f.key)?.phase, 'unknown');
  } finally { f.db.close(); }
  const g = fixture();
  try {
    g.enqueue('one'); await g.dispatch.dispatch(g.key);
    const ref = g.journal.current(g.key)!; g.dispatch.terminal(ref, 'completed');
    g.adapter.inspectSettlement = async execution => ({ ...execution, epoch: 'stale', historyPersisted: true, nativeQuiescent: true });
    assert.equal(await g.dispatch.settle(ref), false);
    assert.equal(g.journal.current(g.key)?.phase, 'unknown');
  } finally { g.db.close(); }
});

test('SDK settlement coalesces only the same execution and rejects stale references', async () => {
  const f = fixture();
  try {
    f.enqueue('one'); await f.dispatch.dispatch(f.key);
    const ref = f.journal.current(f.key)!; f.dispatch.terminal(ref, 'completed');
    const proof = deferred<Awaited<ReturnType<SdkDispatchAdapter['inspectSettlement']>>>();
    f.adapter.inspectSettlement = () => proof.promise;
    const first = f.dispatch.settle(ref);
    assert.equal(f.dispatch.settle(ref), first);
    assert.equal(await f.dispatch.settle({ ...ref, epoch: 'old' }), false);
    proof.resolve({ ...ref, historyPersisted: true, nativeQuiescent: true });
    assert.equal(await first, true);
  } finally { f.db.close(); }
});
