import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { HermesJournal, type HermesExecution } from './journal.js';
import type { HermesHistoryRow } from './history.js';

const execution = (key = 'hermes:one'): HermesExecution => ({ id: 'run', key, live: 'live', epoch: 'epoch',
  phase: 'starting', members: ['message'], at: 1, updated: 1 });
const rows: HermesHistoryRow[] = [{ row_id: 1, role: 'user', text: 'prompt', timestamp: 1 },
  { row_id: 2, role: 'assistant', text: 'answer', timestamp: 2 }];
function seed(journal: HermesJournal, turns: TurnQueue, e = execution()) {
  journal.save({ key: e.key, title: 'original', stored: 'stored', started: false, messages: [] });
  for (const id of e.members) turns.enqueue('hermes', { id, sessionKey: e.key, createdAt: 1, payload: { text: 'prompt', actorId: 'owner' } });
  assert.equal(journal.begin(e, turns), true); return e;
}
function fixture() {
  const db = new DatabaseSync(':memory:'), journal = new HermesJournal(db), turns = new TurnQueue(db);
  const starting = seed(journal, turns), running: HermesExecution = { ...starting, phase: 'running', row: 1, updated: 2 };
  return { db, journal, turns, starting, running };
}

test('Hermes native ACK atomically completes original queue, and stale freeze retains admitted row', () => {
  const f = fixture(); try {
    assert.equal(f.journal.admitted(f.running, f.turns), true);
    assert.deepEqual(f.turns.list('hermes'), []);
    assert.equal(f.journal.unknown(f.starting, f.turns), true);
    assert.equal(f.journal.current(f.running.key)?.row, 1);
    assert.equal(f.journal.current(f.running.key)?.phase, 'unknown');
    assert.equal(f.journal.admitted(f.running, f.turns), false);
    assert.equal(f.journal.settleTerminal(f.running, 'completed', 'rotated', rows), false);
    assert.equal(f.journal.canStart(f.running.key), false);
  } finally { f.db.close(); }
});

test('Hermes unknown before ACK preserves uncertain original queue, never replays or unlocks', () => {
  const f = fixture(); try {
    assert.equal(f.journal.unknown(f.starting, f.turns), true);
    assert.equal(f.journal.admitted(f.running, f.turns), false);
    assert.equal(f.turns.list('hermes')[0]?.state, 'outcome_unknown');
    assert.equal(f.journal.begin({ ...execution(), id: 'next' }, f.turns), false);
    assert.equal(f.journal.canStart(f.running.key), false);
  } finally { f.db.close(); }
});

test('Hermes terminal commits anchor, original user ID, tool unknown and native history together', () => {
  const f = fixture(); try {
    assert.equal(f.journal.admitted(f.running, f.turns), true);
    const session = f.journal.session(f.running.key)!;
    f.journal.save({ ...session, messages: [{ id: 'hermes-tool:call', sessionKey: session.key, turnId: f.running.id,
      role: 'tool', toolPhase: 'call', toolName: 'shell', toolCallId: 'tool', text: 'call', status: 'sent', createdAt: 1 }] });
    assert.equal(f.journal.settleTerminal(f.running, 'completed', 'rotated', rows), true);
    const committed = f.journal.session(session.key)!;
    assert.equal(committed.stored, 'rotated');
    assert.equal(committed.messages.find(m => m.role === 'user')?.id, 'message');
    assert.equal(committed.messages.find(m => m.role === 'assistant')?.text, 'answer');
    assert.equal(committed.messages.find(m => m.toolPhase === 'result')?.status, 'outcome_unknown');
    assert.equal(f.journal.current(session.key)?.phase, 'completed');
    assert.equal(f.journal.settleTerminal(f.running, 'completed', 'other', rows), false);
    assert.deepEqual(f.journal.session(session.key), committed);
  } finally { f.db.close(); }
});

for (const field of ['id', 'epoch', 'live', 'at', 'members', 'row'] as const) test(`Hermes terminal rejects foreign ${field} without changing original facts`, () => {
  const f = fixture(); try {
    f.journal.admitted(f.running, f.turns);
    const stale = { ...f.running, [field]: field === 'at' || field === 'row' ? 99 : field === 'members' ? ['foreign'] : 'foreign' };
    assert.equal(f.journal.settleTerminal(stale, 'completed', 'foreign', rows), false);
    assert.equal(f.journal.current(f.running.key)?.phase, 'running');
    assert.equal(f.journal.session(f.running.key)?.stored, 'stored');
  } finally { f.db.close(); }
});

test('Hermes terminal rejects deleted session and absent original user lineage', () => {
  const f = fixture(); try {
    f.journal.admitted(f.running, f.turns);
    assert.equal(f.journal.settleTerminal(f.running, 'completed', 'rotated', rows.slice(1)), false);
    f.journal.beginDeletion(f.running.key);
    assert.equal(f.journal.settleTerminal(f.running, 'completed', 'rotated', rows), false);
    assert.equal(f.journal.current(f.running.key)?.phase, 'running');
  } finally { f.db.close(); }
});

test('Hermes terminal failure after history save rolls all changes back and preserves outer transaction', () => {
  const f = fixture(); try {
    f.journal.admitted(f.running, f.turns);
    const before = f.journal.session(f.running.key);
    f.db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON hermes_executions WHEN NEW.phase = 'completed' BEGIN SELECT RAISE(ABORT, 'terminal-fault'); END");
    f.db.exec('BEGIN');
    assert.throws(() => f.journal.settleTerminal(f.running, 'completed', 'rotated', rows), /terminal-fault/);
    assert.equal(f.db.isTransaction, true);
    assert.deepEqual(f.journal.session(f.running.key), before);
    assert.deepEqual(f.journal.current(f.running.key), f.running);
    f.db.exec('ROLLBACK');
  } finally { f.db.close(); }
});

test('Hermes recovery uses bounded original pages and never changes terminal or admits new work', () => {
  const f = fixture(); try {
    for (let i = 0; i < 70; i++) {
      const e = execution(`hermes:page-${String(i).padStart(2, '0')}`); e.id = `run-${i}`; e.members = [`m-${i}`];
      seed(f.journal, f.turns, e);
      if (i === 0) f.journal.update({ ...e, phase: 'completed' });
    }
    const first = f.journal.recoverPage('', 64, f.turns);
    assert.equal(first.length, 64);
    assert.equal(f.journal.current('hermes:page-69')?.phase, 'starting');
    const last = f.journal.recoverPage(first.at(-1)!, 64, f.turns);
    assert.equal(last.length, 7); assert.equal(f.journal.current('hermes:page-69')?.phase, 'unknown');
    assert.equal(f.journal.current('hermes:page-00')?.phase, 'completed');
    assert.equal(f.turns.list('hermes', 'hermes:page-69')[0]?.state, 'outcome_unknown');
    f.journal.recover(f.turns); assert.equal(f.journal.current('hermes:one')?.phase, 'unknown');
  } finally { f.db.close(); }
});

test('Hermes batched terminal retains member IDs and refuses a changed original batch', () => {
  const db = new DatabaseSync(':memory:'), journal = new HermesJournal(db), turns = new TurnQueue(db);
  try {
    const e: HermesExecution = { ...execution(), members: ['a', 'b'], batch: { separator: '\n---\n',
      members: [{ id: 'a', createdAt: 1, imageCount: 0 }, { id: 'b', createdAt: 2, imageCount: 0 }] } };
    seed(journal, turns, e);
    const admitted: HermesExecution = { ...e, phase: 'running', row: 1 };
    assert.equal(journal.admitted(admitted, turns), true);
    assert.equal(journal.settleTerminal({ ...admitted, batch: { ...e.batch!, separator: 'foreign' } }, 'completed', 'rotated', rows), false);
    assert.equal(journal.settleTerminal(admitted, 'completed', 'rotated', [{ ...rows[0]!, text: 'first\n---\nsecond' }, rows[1]!]), true);
    assert.deepEqual(journal.session(e.key)!.messages.filter(m => m.role === 'user').map(m => [m.id, m.text]), [['a', 'first'], ['b', 'second']]);
  } finally { db.close(); }
});

test('Hermes admitted queue failure rolls execution and all original members back together', () => {
  const f = fixture(); try {
    f.db.exec("CREATE TRIGGER fail_queue BEFORE DELETE ON connector_turns BEGIN SELECT RAISE(ABORT, 'queue-fault'); END");
    assert.throws(() => f.journal.admitted(f.running, f.turns), /queue-fault/);
    assert.deepEqual(f.journal.current(f.running.key), f.starting);
    assert.equal(f.turns.list('hermes')[0]?.state, 'dispatching');
  } finally { f.db.close(); }
});
