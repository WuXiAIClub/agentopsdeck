import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal, type SdkAgentId } from './sdk-execution-journal.js';
import { SdkDispatch } from './sdk-dispatch.js';

function fixture(runtime: SdkAgentId) {
  const db = new DatabaseSync(':memory:');
  let available = true, startAvailable = true, sessionAvailable = true;
  const turns = new TurnQueue(db, undefined, undefined, () => sessionAvailable, () => startAvailable);
  const journal = new SdkExecutionJournal(db, runtime, () => 1000, undefined, {
    available: () => available, beforeBegin: () => {},
  });
  const key = `${runtime}:session`, ref = { key, id: 'compact', epoch: 'epoch', nativeSessionId: 'native' };
  journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
  const enqueue = (id: string) => turns.enqueue(runtime, { id, sessionKey: key, createdAt: 0, payload: { text: id, actorId: 'owner', images: [] } });
  const materialize = () => {
    const first = { ...ref, id: 'message' };
    enqueue(first.id);
    assert.ok(journal.begin(first, [first.id], turns));
    assert.ok(journal.observeTerminal(first, 'completed', turns));
    assert.ok(journal.confirmSettled(first));
  };
  const begin = (commit: (db: DatabaseSync) => void = () => {}) => journal.beginCompact(ref, 'owner', turns, commit);
  const result = { nativeRequestId: 'native-request', completionEventId: 'boundary', outcome: 'completed' as const };
  const proof = { ...ref, completionEventId: result.completionEventId, historyPersisted: true, nativeQuiescent: true };
  return { db, turns, journal, key, ref, enqueue, materialize, begin, result, proof,
    available: (value: boolean) => { available = value; },
    startAvailable: (value: boolean) => { startAvailable = value; },
    sessionAvailable: (value: boolean) => { sessionAvailable = value; } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: compact boundary updates metrics atomically before any settlement wake`, () => {
    const f = fixture(runtime);
    try {
      f.materialize(); f.begin();
      const before = f.journal.session(f.key)!.metrics!.compactionCount!;
      assert.equal(f.journal.observeCompactTerminal(f.ref, f.result), true);
      assert.equal(f.journal.session(f.key)!.metrics!.compactionCount, before + 1);
      assert.deepEqual(f.journal.session(f.key)!.metrics!.context, { used: null, basis: 'post-compaction' });
      assert.equal(f.journal.confirmCompactSettled(f.proof), true);
      assert.equal(f.journal.observeCompactTerminal(f.ref, f.result), false);
      assert.equal(f.journal.session(f.key)!.metrics!.compactionCount, before + 1);
    } finally { f.db.close(); }
  });
  test(`${runtime}: compact is an atomic control, not a message or an allocated-session create`, () => {
    const f = fixture(runtime);
    try {
      assert.equal(f.begin(), undefined);
      f.materialize();
      const prior = f.journal.current(f.key), session = f.journal.session(f.key);
      assert.throws(() => f.begin(db => {
        assert.equal(db.isTransaction, true);
        assert.equal(f.journal.current(f.key)?.kind, 'compact');
        throw new Error('receipt/auth failed');
      }), /receipt\/auth failed/);
      assert.deepEqual(f.journal.current(f.key), prior);
      assert.deepEqual(f.journal.session(f.key), session);
      const control = f.begin();
      assert.equal(control?.kind, 'compact');
      assert.equal(control?.nativeMode, 'resume');
      assert.deepEqual(control?.members, []);
      assert.deepEqual(control?.control, { actorId: 'owner' });
      assert.equal(control?.batch, undefined);
      assert.equal(f.turns.hasPending(runtime, f.key), false);
      assert.equal(f.journal.pendingCount(), 1);
      assert.equal(f.begin(), undefined);
      assert.throws(() => f.journal.begin({ ...f.ref, id: 'empty-message' }, [], f.turns), /Invalid SDK execution intent/);
      // A normal completion/ACK/stop may never impersonate a control outcome.
      assert.equal(f.journal.acknowledge(f.ref, 'user', f.turns), false);
      assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.turns), false);
      assert.equal(f.journal.requestStop(f.ref), false);
      assert.equal(f.journal.confirmSettled(f.ref), false);
    } finally { f.db.close(); }
  });

  test(`${runtime}: compact checks owner availability, maintenance, deletion and every pending queue state`, () => {
    const f = fixture(runtime);
    try {
      f.materialize();
      for (const toggle of [f.available, f.startAvailable, f.sessionAvailable]) {
        toggle(false); assert.equal(f.begin(), undefined); toggle(true);
      }
      f.enqueue('waiting');
      for (const state of ['queued', 'dispatching', 'outcome_unknown', 'blocked']) {
        f.db.prepare('UPDATE connector_turns SET state = ?').run(state);
        assert.equal(f.begin(), undefined, state);
      }
      assert.equal(f.journal.current(f.key)?.id, 'message');
      f.db.exec('DELETE FROM connector_turns');
      f.journal.beginDeletion(f.key, 'delete');
      assert.equal(f.begin(), undefined);
    } finally { f.db.close(); }
  });

  test(`${runtime}: compact and sends/settings/deletion serialize until exact history and quiescence proof`, () => {
    const f = fixture(runtime);
    try {
      f.materialize(); f.begin(); f.enqueue('next');
      const next = { ...f.ref, id: 'next' };
      assert.equal(f.journal.begin(next, ['next'], f.turns), undefined);
      assert.throws(() => f.journal.updateModel(f.key, 'new-model', () => {}), /not idle/);
      assert.throws(() => f.journal.beginDeletion(f.key, 'delete'), /not admissible/);
      for (const changed of [{ id: 'other' }, { epoch: 'other' }, { key: `${runtime}:other` }, { nativeSessionId: 'other' }]) {
        assert.equal(f.journal.observeCompactTerminal({ ...f.ref, ...changed }, f.result), false);
      }
      assert.equal(f.journal.observeCompactTerminal(f.ref, f.result), true);
      assert.equal(f.journal.observeCompactTerminal(f.ref, f.result), false);
      assert.equal(f.journal.confirmSettled(f.ref), false);
      for (const changed of [{ id: 'other' }, { epoch: 'other' }, { nativeSessionId: 'other' },
        { completionEventId: 'other' }, { historyPersisted: false }, { nativeQuiescent: false }]) {
        assert.equal(f.journal.confirmCompactSettled({ ...f.proof, ...changed }), false);
      }
      assert.equal(f.journal.begin(next, ['next'], f.turns), undefined);
      assert.equal(f.journal.pendingCount(), 1);
      assert.equal(f.journal.confirmCompactSettled(f.proof), true);
      assert.equal(f.journal.pendingCount(), 0);
      assert.equal(f.turns.head(runtime, f.key)?.state, 'queued');
      assert.equal(f.journal.begin(next, ['next'], f.turns)?.kind, 'message');
    } finally { f.db.close(); }
  });

  test(`${runtime}: lost compact completion stays unknown without consuming or replaying waiting messages`, () => {
    const f = fixture(runtime);
    try {
      f.materialize(); f.begin(); f.enqueue('next');
      assert.equal(f.journal.observeCompactTerminal(f.ref, f.result), true);
      f.journal.recover(f.turns);
      assert.equal(f.journal.current(f.key)?.kind, 'compact');
      assert.equal(f.journal.current(f.key)?.phase, 'unknown');
      assert.equal(f.journal.current(f.key)?.control?.completionEventId, 'boundary');
      assert.equal(f.journal.confirmCompactSettled(f.proof), false);
      assert.equal(f.journal.observeCompactTerminal(f.ref, f.result), false);
      assert.equal(f.turns.head(runtime, f.key)?.state, 'queued');
      assert.equal(f.begin(), undefined);
      assert.equal(f.journal.pendingCount(), 1);
    } finally { f.db.close(); }
  });

  test(`${runtime}: compact stop records intent only and never permits a stale or unsolicited interrupt`, () => {
    const f = fixture(runtime);
    try {
      f.materialize(); f.begin();
      const stopped = { ...f.result, outcome: 'interrupted' as const };
      assert.equal(f.journal.observeCompactTerminal(f.ref, stopped), false);
      assert.equal(f.journal.requestCompactStop({ ...f.ref, nativeSessionId: 'other' }), false);
      assert.equal(f.journal.requestCompactStop({ ...f.ref, epoch: 'other' }), false);
      assert.equal(f.journal.requestCompactStop(f.ref), true);
      assert.equal(f.journal.requestCompactStop(f.ref), false);
      assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
      assert.equal(f.journal.canStart(f.key), false);
      assert.equal(f.journal.observeCompactTerminal(f.ref, stopped), true);
      assert.equal(f.journal.confirmCompactSettled(f.proof), true);
      assert.equal(f.journal.current(f.key)?.phase, 'interrupted');
    } finally { f.db.close(); }
  });

  test(`${runtime}: invalid completion data is rejected; failed controls require the same settlement evidence`, () => {
    const f = fixture(runtime);
    try {
      f.materialize(); f.begin();
      for (const value of ['', 'x'.repeat(513), 'bad\n']) {
        assert.throws(() => f.journal.observeCompactTerminal(f.ref, { ...f.result, completionEventId: value }));
        assert.throws(() => f.journal.observeCompactTerminal(f.ref, { ...f.result, nativeRequestId: value }));
      }
      assert.ok(f.journal.observeCompactTerminal(f.ref, { ...f.result, outcome: 'failed' }));
      assert.equal(f.journal.canStart(f.key), false);
      assert.ok(f.journal.confirmCompactSettled(f.proof));
      assert.equal(f.journal.current(f.key)?.phase, 'failed');
      assert.throws(() => f.begin(), /UNIQUE/, 'completed identities cannot be reused');
    } finally { f.db.close(); }
  });

  test(`${runtime}: ordinary dispatcher cannot interrupt, settle or send a compact control`, async () => {
    const f = fixture(runtime);
    try {
      f.materialize(); f.begin();
      const unexpected = async (): Promise<never> => { throw new Error('message adapter must not be called'); };
      let calls = 0;
      const dispatch = new SdkDispatch({ journal: f.journal, turns: f.turns, deadlineMs: 50, authorize: () => true,
        adapter: { epoch: 'epoch', ready: true, send: unexpected,
          interrupt: async () => { calls++; }, inspectSettlement: async execution => { calls++; return { ...execution, historyPersisted: true, nativeQuiescent: true }; } } });
      f.enqueue('next');
      assert.equal(await dispatch.dispatch(f.key), 'not_started');
      assert.equal(await dispatch.interrupt(f.ref, { actorId: 'owner', text: '', images: [] }), 'not_started');
      assert.equal(dispatch.terminal(f.ref, 'completed'), false);
      assert.ok(f.journal.observeCompactTerminal(f.ref, f.result));
      assert.equal(await dispatch.settle(f.ref), false);
      assert.equal(calls, 0);
      assert.equal(f.journal.current(f.key)?.phase, 'settling');
    } finally { f.db.close(); }
  });
}

test('control admission is disabled without an owning store policy and rejects a foreign queue database', () => {
  const f = fixture('claude-code'), other = new DatabaseSync(':memory:');
  try {
    f.materialize();
    const plain = new SdkExecutionJournal(f.db, 'claude-code');
    assert.equal(plain.beginCompact(f.ref, 'owner', f.turns, () => {}), undefined);
    assert.throws(() => f.journal.beginCompact(f.ref, 'owner', new TurnQueue(other), () => {}), /owning transaction/);
    assert.equal(f.journal.current(f.key)?.id, 'message');
    // Old persisted executions without kind continue to be ordinary messages.
    f.db.exec("UPDATE sdk_agent_executions SET data = json_remove(data, '$.kind')");
    assert.equal(f.journal.canStart(f.key), true);
    assert.ok(f.begin());
  } finally { f.db.close(); other.close(); }
});
