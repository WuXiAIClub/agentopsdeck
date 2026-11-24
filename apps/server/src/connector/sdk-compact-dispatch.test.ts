import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal, type SdkAgentId, type SdkCompactRef, type SdkCompactResult, type SdkCompactSettlement } from './sdk-execution-journal.js';
import { SdkCompactDispatch, type SdkCompactAdapter } from './sdk-compact-dispatch.js';
import { ClaudeDispatchAdapter } from '../claude/dispatch-adapter.js';
import { CopilotDispatchAdapter } from '../copilot/dispatch-adapter.js';
import { randomUUID } from 'node:crypto';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(runtime: SdkAgentId, deadlineMs = 1000) {
  const db = new DatabaseSync(':memory:'), turns = new TurnQueue(db);
  const journal = new SdkExecutionJournal(db, runtime, undefined, undefined, { available: () => true, beforeBegin: () => {} });
  const key = `${runtime}:session`, first = { key, id: 'first', epoch: 'epoch' };
  journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
  turns.enqueue(runtime, { id: first.id, sessionKey: key, createdAt: 0, payload: {} });
  journal.begin(first, [first.id], turns); journal.observeTerminal(first, 'completed', turns); journal.confirmSettled(first);
  const ref = { key, id: 'compact', epoch: 'epoch', nativeSessionId: 'native' };
  const completion = deferred<SdkCompactRef & SdkCompactResult>();
  const result = { ...ref, nativeRequestId: 'rpc', completionEventId: 'boundary', outcome: 'completed' as const };
  const proof = { ...ref, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true };
  let committed = false, calls = 0, stops = 0, inspections = 0, authorized = true, checks = 0;
  const adapter: SdkCompactAdapter = { runtime, epoch: ref.epoch, ready: true,
    compact: async execution => {
      calls++; assert.ok(committed); assert.equal(db.isTransaction, false);
      assert.deepEqual(journal.current(key), execution);
      assert.deepEqual(execution.members, []);
      return completion.promise;
    },
    interruptCompact: async execution => { stops++; assert.ok(execution.stopRequested); assert.equal(journal.current(key)?.stopRequested, true); },
    inspectSettlement: async () => { inspections++; return proof; } };
  const options = { journal, turns, adapter, deadlineMs,
    authorize: () => { checks++; return authorized; } };
  const dispatch = new SdkCompactDispatch(options);
  return { db, turns, journal, key, ref, result, proof, completion, adapter, dispatch, options,
    begin: (signal?: AbortSignal) => dispatch.dispatch(ref, 'owner', () => { committed = true; }, signal),
    counts: () => ({ calls, stops, inspections, checks }), authorize: (value: boolean) => { authorized = value; } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: compact commits before invocation, does not require message ACK/idle and deduplicates settlement`, async () => {
    const f = fixture(runtime);
    try {
      const running = f.begin();
      assert.equal(f.counts().calls, 1);
      assert.equal(await f.begin(), 'not_started');
      f.completion.resolve(f.result);
      assert.equal(await running, 'accepted');
      assert.equal(f.journal.current(f.key)?.phase, 'settling');
      const pending = deferred<SdkCompactSettlement>();
      let inspections = 0;
      f.adapter.inspectSettlement = async () => { inspections++; return pending.promise; };
      f.dispatch.pause(); // Pause is admission-only, never blocks settling.
      const a = f.dispatch.settle(f.ref), b = f.dispatch.settle(f.ref);
      assert.equal(a, b);
      assert.equal(await f.dispatch.settle({ ...f.ref, nativeSessionId: 'other' }), false);
      pending.resolve(f.proof);
      assert.equal(await a, true); assert.equal(inspections, 1);
      assert.equal(f.journal.current(f.key)?.phase, 'completed');
      assert.equal(f.counts().calls, 1);
      f.dispatch.resume();
      await assert.rejects(f.begin(), /UNIQUE/); // command route must return its existing receipt, not resend.
      assert.equal(f.counts().calls, 1);
    } finally { f.db.close(); }
  });

  test(`${runtime}: pause, pre-abort, owner denial and revocation during receipt commit have no native effect`, async () => {
    const f = fixture(runtime);
    try {
      f.dispatch.pause(); assert.equal(await f.begin(), 'not_started'); f.dispatch.resume();
      assert.equal(await f.begin(AbortSignal.abort()), 'not_started');
      f.authorize(false); assert.equal(await f.begin(), 'blocked'); f.authorize(true);
      let checks = 0;
      const revoked = new SdkCompactDispatch({ ...f.options, authorize: () => ++checks === 1 });
      await assert.rejects(revoked.dispatch(f.ref, 'owner', () => assert.fail('must not commit')), /admission changed/);
      await assert.rejects(f.dispatch.dispatch(f.ref, 'owner', () => { throw new Error('disk failure'); }), /disk failure/);
      assert.equal(f.journal.current(f.key)?.id, 'first');
      assert.equal(f.journal.session(f.key)?.nativeState, 'ready');
      assert.equal(f.counts().calls, 0);
    } finally { f.db.close(); }
  });

  test(`${runtime}: caller mutations cannot rebind an in-flight control or settlement`, async () => {
    const f = fixture(runtime);
    try {
      const ref = { ...f.ref };
      let calls = 0;
      f.adapter.compact = async execution => {
        calls++;
        assert.equal(execution.id, f.ref.id);
        execution.id = 'adapter-mutation';
        return f.completion.promise;
      };
      const pending = f.dispatch.dispatch(ref, 'owner', () => {});
      ref.id = 'caller-mutation'; ref.epoch = 'other';
      f.completion.resolve(f.result);
      assert.equal(await pending, 'accepted');
      const proof = deferred<SdkCompactSettlement>();
      f.adapter.inspectSettlement = async () => proof.promise;
      const settleRef = { ...f.ref }, settled = f.dispatch.settle(settleRef);
      settleRef.key = `${runtime}:other`;
      proof.resolve(f.proof);
      assert.equal(await settled, true);
      assert.equal(f.journal.current(f.key)?.id, f.ref.id);
      assert.equal(calls, 1);
    } finally { f.db.close(); }
  });

  test(`${runtime}: HTTP abort after durable admission does not cancel or repeat native compaction`, async () => {
    const f = fixture(runtime), abort = new AbortController();
    try {
      const pending = f.begin(abort.signal); abort.abort();
      f.completion.resolve(f.result);
      assert.equal(await pending, 'accepted');
      assert.equal(await f.dispatch.settle(f.ref), true);
      assert.equal(f.counts().calls, 1);
    } finally { f.db.close(); }
  });

  for (const mode of ['timeout', 'provider-error', 'wrong-epoch', 'wrong-session', 'wrong-event-session'] as const) {
    test(`${runtime}: ${mode} freezes the original compact; late results cannot settle or replay it`, async () => {
      const f = fixture(runtime, mode === 'timeout' ? 10 : 1000), abort = new AbortController();
      try {
        const pending = f.begin(abort.signal);
        if (mode === 'provider-error') f.completion.reject(new Error('private upstream details'));
        if (mode === 'wrong-epoch') f.completion.resolve({ ...f.result, epoch: 'old' });
        if (mode === 'wrong-session') f.completion.resolve({ ...f.result, key: `${runtime}:other` });
        if (mode === 'wrong-event-session') f.completion.resolve({ ...f.result, nativeSessionId: 'other' });
        assert.equal(await pending, 'unknown');
        f.completion.resolve(f.result); await Promise.resolve();
        assert.equal(f.journal.current(f.key)?.phase, 'unknown');
        assert.equal(await f.begin(), 'not_started');
        assert.equal(await f.dispatch.settle(f.ref), false);
        assert.equal(f.counts().calls, 1);
      } finally { f.db.close(); }
    });
  }

  test(`${runtime}: dedicated stop requires exact identity/authorization; stop ACK alone never releases the session`, async () => {
    const f = fixture(runtime);
    try {
      const pending = f.begin();
      f.authorize(false);
      assert.equal(await f.dispatch.interrupt(f.ref, 'other'), 'blocked'); f.authorize(true);
      assert.equal(await f.dispatch.interrupt({ ...f.ref, id: 'other' }, 'owner'), 'not_started');
      assert.equal(await f.dispatch.interrupt(f.ref, 'owner'), 'accepted');
      assert.equal(await f.dispatch.interrupt(f.ref, 'owner'), 'not_started');
      assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
      f.completion.resolve({ ...f.result, outcome: 'interrupted' });
      assert.equal(await pending, 'accepted');
      assert.equal(await f.dispatch.settle(f.ref), true);
      assert.equal(f.journal.current(f.key)?.phase, 'interrupted');
      assert.equal(f.counts().stops, 1);
    } finally { f.db.close(); }
  });

  test(`${runtime}: unavailable compact stop stays disabled; failed stop does not become a successful cancellation`, async () => {
    const f = fixture(runtime);
    try {
      const pending = f.begin();
      delete f.adapter.interruptCompact;
      assert.equal(await f.dispatch.interrupt(f.ref, 'owner'), 'not_started');
      assert.equal(f.journal.current(f.key)?.stopRequested, false);
      f.adapter.interruptCompact = async () => { throw new Error('lost stop ack'); };
      assert.equal(await f.dispatch.interrupt(f.ref, 'owner'), 'unknown');
      f.completion.resolve(f.result);
      assert.equal(await pending, 'unknown');
      assert.equal(f.journal.current(f.key)?.phase, 'unknown');
    } finally { f.db.close(); }
  });

  test(`${runtime}: missing quiescence waits; wrong history freezes settlement`, async () => {
    const f = fixture(runtime);
    try {
      const pending = f.begin(); f.completion.resolve(f.result); await pending;
      f.adapter.inspectSettlement = async () => ({ ...f.proof, nativeQuiescent: false });
      assert.equal(await f.dispatch.settle(f.ref), false);
      assert.equal(f.journal.current(f.key)?.phase, 'settling');
      f.adapter.inspectSettlement = async () => ({ ...f.proof, completionEventId: 'other' });
      assert.equal(await f.dispatch.settle(f.ref), false);
      assert.equal(f.journal.current(f.key)?.phase, 'unknown');
    } finally { f.db.close(); }
  });

  test(`${runtime}: worker epoch changes during completion or history inspection never release the old execution`, async () => {
    for (const stage of ['completion', 'history'] as const) {
      const f = fixture(runtime);
      // Model a replaced private worker without mutating readonly adapter fields.
      let epoch = 'epoch';
      Object.defineProperty(f.adapter, 'epoch', { get: () => epoch });
      try {
        const pending = f.begin();
        if (stage === 'completion') epoch = 'replacement';
        f.completion.resolve(f.result);
        assert.equal(await pending, stage === 'completion' ? 'unknown' : 'accepted');
        if (stage === 'history') {
          f.adapter.inspectSettlement = async () => { epoch = 'replacement'; return f.proof; };
          assert.equal(await f.dispatch.settle(f.ref), false);
        }
        assert.equal(f.journal.current(f.key)?.phase, 'unknown');
        assert.equal(f.counts().calls, 1);
      } finally { f.db.close(); }
    }
  });

  test(`${runtime}: native message adapter refuses compact records before spawning any worker`, async () => {
    let calls = 0;
    const options = { epoch: randomUUID(), start: (): never => { calls++; throw new Error('must not spawn'); },
      terminal: () => false, unknown: () => {}, drained: () => {} };
    const adapter = runtime === 'ghcp' ? new CopilotDispatchAdapter(options) : new ClaudeDispatchAdapter(options);
    try {
      await assert.rejects(adapter.send({ kind: 'compact', id: randomUUID(), key: `${runtime}:${randomUUID()}`,
        epoch: options.epoch, nativeSessionId: randomUUID(), nativeMode: 'resume', members: [], control: { actorId: 'owner' },
        phase: 'dispatching', stopRequested: false, createdAt: 0, updatedAt: 0 }, '/compact'));
      assert.equal(calls, 0);
    } finally { adapter.close(); }
  });
}

test('compact dispatcher rejects cross-runtime wiring and invalid deadlines', () => {
  const f = fixture('ghcp');
  try {
    for (const deadlineMs of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => new SdkCompactDispatch({ ...f.options, deadlineMs }));
    assert.throws(() => new SdkCompactDispatch({ ...f.options, adapter: { ...f.adapter, runtime: 'claude-code' } }));
  } finally { f.db.close(); }
});
