import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HermesJournal } from './journal.js';
import { TurnQueue } from '../commands/turn-queue.js';
import type { HermesExecution } from './journal.js';

function recoveryFixture() {
  const db = new DatabaseSync(':memory:'), journal = new HermesJournal(db), turns = new TurnQueue(db);
  const execution: HermesExecution = { key: 'hermes:recovery', id: 'original', live: 'live', epoch: 'epoch',
    phase: 'running', row: 17, members: ['message'],
    batch: { members: [{ id: 'message', createdAt: 1, imageCount: 0 }], separator: '\n' }, at: 1, updated: 2 };
  journal.save({ key: execution.key, title: 'Original', stored: 'stored', started: false, messages: [] });
  turns.enqueue('hermes', { id: 'message', sessionKey: execution.key, createdAt: 1, payload: { text: 'private', actorId: 'owner' } });
  assert.equal(journal.begin({ ...execution, phase: 'starting' }, turns), true);
  journal.update(execution);
  journal.observeTool(execution, { toolId: 'lost', phase: 'call', name: 'private-tool', at: 3 });
  journal.observeTool(execution, { toolId: 'confirmed', phase: 'call', at: 4 });
  journal.observeTool(execution, { toolId: 'confirmed', phase: 'result', at: 5 });
  return { db, journal, turns, execution };
}

for (const failure of ['queue', 'tools'] as const) test(`unknown ${failure} failure rolls back execution, queue and tool results together`, () => {
  const f = recoveryFixture(), original = Error('original-save-failure');
  try {
    const before = f.journal.session(f.execution.key), digest = f.journal.historySnapshot(f.execution.key)?.digest;
    if (failure === 'tools') f.journal.save = () => { throw original; };
    else {
      const uncertain = f.turns.uncertain.bind(f.turns);
      f.turns.uncertain = (runtime, id) => { uncertain(runtime, id); throw original; };
    }
    assert.throws(() => f.journal.unknown(f.execution, f.turns), error => error === original);
    assert.deepEqual(f.journal.current(f.execution.key), f.execution);
    assert.equal(f.turns.list('hermes', f.execution.key)[0]?.state, 'dispatching');
    assert.deepEqual(f.journal.session(f.execution.key), before);
    assert.equal(f.journal.historySnapshot(f.execution.key)?.digest, digest);
  } finally { f.db.close(); }
});

for (const recovery of ['unknown', 'page', 'startup'] as const) test(`${recovery} atomically retains original lineage and settles only unconfirmed tools, idempotently`, () => {
  const f = recoveryFixture();
  try {
    const { row: _row, ...preAck } = f.execution;
    const recover = () => recovery === 'unknown' ? f.journal.unknown(preAck, f.turns)
      : recovery === 'page' ? f.journal.recoverPage('', 64, f.turns) : f.journal.recover(f.turns);
    recover();
    const session = f.journal.session(f.execution.key), execution = f.journal.current(f.execution.key)!;
    assert.equal(execution.phase, 'unknown'); assert.equal(execution.row, 17); assert.deepEqual(execution.batch, f.execution.batch);
    assert.equal(f.turns.list('hermes', f.execution.key)[0]?.state, 'outcome_unknown');
    assert.deepEqual(session?.messages.filter(m => m.toolPhase === 'result').map(m => [m.toolCallId, m.status]),
      [['original:confirmed', 'sent'], ['original:lost', 'outcome_unknown']]);
    recover(); assert.deepEqual(f.journal.session(f.execution.key), session);
    assert.deepEqual(f.journal.current(f.execution.key), execution);
    assert.equal(f.journal.observeTool(f.execution, { toolId: 'late', phase: 'result', at: 6 }), null);
    assert.equal(f.journal.canStart(f.execution.key), false);
    const unknownSession = f.journal.session(f.execution.key);
    assert.equal(f.journal.unknown({ ...f.execution, id: 'foreign' }, f.turns), false);
    assert.deepEqual(f.journal.session(f.execution.key), unknownSession);
  } finally { f.db.close(); }
});

test('terminal executions are never rewritten by unknown recovery', () => {
  const f = recoveryFixture();
  try {
    f.journal.update({ ...f.execution, phase: 'completed' });
    const before = f.journal.session(f.execution.key);
    assert.equal(f.journal.unknown(f.execution, f.turns), false);
    f.journal.recover(f.turns);
    assert.deepEqual(f.journal.session(f.execution.key), before);
    assert.equal(f.journal.current(f.execution.key)?.phase, 'completed');
  } finally { f.db.close(); }
});

test('history binding queries are chunked, session scoped and exclude unrelated executions', () => {
  const db = new DatabaseSync(':memory:'), journal = new HermesJournal(db);
  try {
    for (let row = 1; row <= 405; row++) journal.update({ id: `e-${row}`, key: 'hermes:one', live: 'live', epoch: 'epoch',
      phase: 'completed', members: [`m-${row}`], row, at: 1, updated: 2 });
    journal.update({ id: 'foreign', key: 'hermes:other', live: 'live', epoch: 'epoch', phase: 'completed', members: [], row: 1, at: 1, updated: 2 });
    assert.equal(journal.bindings('hermes:one', []).size, 0);
    assert.equal(journal.bindings('hermes:one', Array.from({ length: 410 }, (_, i) => i + 1)).size, 405);
    const subset = journal.bindings('hermes:one', [1, 1, 405, 999]);
    assert.equal(subset.size, 2); assert.equal(subset.get(1)?.id, 'e-1'); assert.equal(subset.get(405)?.id, 'e-405');
  } finally { db.close(); }
});

test('Hermes deletion keeps original failure and enclosing transaction after failed cleanup', () => {
  const db = new DatabaseSync(':memory:'), original = Error('synthetic-delete');
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (sql.startsWith('ROLLBACK TO hermes_journal')) { target.exec(sql); throw Error('synthetic-cleanup'); }
      return target.exec(sql);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const journal = new HermesJournal(proxy);
    journal.save({ key: 'hermes:one', stored: 'one', title: 'one', started: false, messages: [] });
    journal.beginDeletion('hermes:one');
    db.exec('BEGIN');
    // Fail after the deletion intent transition, not before entering the boundary.
    const prepare = db.prepare.bind(db);
    Object.defineProperty(proxy, 'prepare', { configurable: true, value: (sql: string) => {
      if (sql.startsWith('DELETE FROM hermes_executions')) throw original;
      return prepare(sql);
    } });
    assert.throws(() => journal.finishDeletion('hermes:one'), error => error === original);
    assert.equal(db.isTransaction, true);
    assert.equal(journal.deletion('hermes:one'), 'pending');
    assert.ok(journal.session('hermes:one'));
    db.exec('ROLLBACK');
  } finally { db.close(); }
});
