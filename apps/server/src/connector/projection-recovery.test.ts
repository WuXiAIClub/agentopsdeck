import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConnectorEventLog } from './event-log.js';
import { DeckStore } from '../projection/deck-store.js';

const session = { sessionKey: 'codex:synthetic-recovery', agentId: 'codex', source: 'codex' as const,
  title: 'Before', status: 'running' as const, hasActiveRun: true };
const event = { id: '', type: 'session.updated' as const, ts: 1, payload: session };
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new ConnectorEventLog(db), store = new DeckStore({ eventLog: log });
  store.upsertSession(session);
  const before = log.latestEventId();
  const fail = () => db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  const restore = () => db.exec('DROP TRIGGER reject_projection');
  return { db, log, store, before, fail, restore };
}

for (const reader of ['snapshot', 'resume', 'events'] as const) test(`${reader} read rotates an incomplete projection epoch without replaying old events`, t => {
  const f = fixture(t);
  f.fail();
  f.store.upsertSession({ ...session, title: 'During outage' });
  f.store.addMessage({ id: 'latest', sessionKey: session.sessionKey, role: 'assistant', text: 'Current reply', createdAt: 1 });
  assert.throws(() => f.store.latestEventId(), /unavailable/);
  assert.equal(new ConnectorEventLog(f.db).latestEventId(), f.before);
  f.restore();
  const revision = f.store.changes.revision;
  if (reader === 'resume') assert.equal(f.store.hasEvent(f.before), false);
  else if (reader === 'events') assert.deepEqual(f.store.getEventsSince(f.before), []);
  else assert.notEqual(f.store.latestEventId(), f.before);
  const cursor = f.store.latestEventId()!;
  assert.ok(cursor.endsWith(':0'));
  assert.equal(f.store.changes.revision, revision + 1, 'one committed recovery wake-up');
  assert.equal(f.store.getSession(session.sessionKey)!.title, 'During outage');
  assert.equal(f.store.getSession(session.sessionKey)!.status, 'running');
  assert.equal(f.store.getMessages(session.sessionKey).at(-1)!.text, 'Current reply');
  assert.deepEqual(f.store.getEventsSince(cursor), [], 'lost invalidations are replaced by a new snapshot, not replayed');
  f.store.upsertSession({ ...session, title: 'After recovery' });
  assert.equal(f.store.getEventsSince(cursor).length, 1);
  assert.equal(f.log.recoverProjection(), false, 'healthy reads do not rotate again');
});

for (const stage of ['insert', 'delete', 'epoch'] as const) test(`recovery ${stage} failure rolls back its probe and preserves the previous epoch`, t => {
  const f = fixture(t);
  f.fail(); f.store.upsertSession({ ...session, title: 'Saved view' });
  if (stage !== 'insert') {
    f.restore();
    f.db.exec(stage === 'delete'
      ? "CREATE TRIGGER reject_recovery BEFORE DELETE ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic'); END"
      : "CREATE TRIGGER reject_recovery BEFORE UPDATE OF epoch ON connector_event_head BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(f.log.recoverProjection(), false);
    assert.throws(() => f.log.latestEventId(), /unavailable/);
    assert.equal(f.db.isTransaction, false);
    const reader = new ConnectorEventLog(f.db);
    assert.equal(reader.latestEventId(), f.before);
    assert.equal(reader.getEventsSince(f.before.replace(/:1$/, ':0')).length, 1);
  }
  if (stage === 'insert') f.restore(); else f.db.exec('DROP TRIGGER reject_recovery');
  assert.equal(f.log.recoverProjection(), true);
  assert.equal(f.log.hasEvent(f.before), false);
});

for (const mode of ['transaction', 'nested', 'codex', 'openclaw', 'owner', 'counters'] as const) test(`projection recovery does not unlock ${mode} uncertainty or corruption`, t => {
  const f = fixture(t);
  f.fail();
  if (mode === 'transaction') {
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.log.appendInTransaction(f.db, event));
    f.db.exec('ROLLBACK');
  } else if (mode === 'nested') {
    f.db.exec('BEGIN IMMEDIATE');
    // A repeated catalog observation is intentionally a no-op. Exercise an
    // actual change so this still reaches the nested-transaction guard.
    f.store.upsertSession({ ...session, title: 'Nested change' });
    assert.equal(f.db.isTransaction, true);
    assert.throws(() => f.log.latestEventId(), /unavailable/);
    f.db.exec('ROLLBACK');
  } else f.store.upsertSession({ ...session, title: 'New' });
  f.restore();
  if (mode === 'codex') f.store.invalidateCodexExecutionFacts();
  if (mode === 'openclaw') f.store.invalidateOpenClawExecutionFacts();
  if (mode === 'owner') new ConnectorEventLog(f.db).beginEpoch();
  if (mode === 'counters') f.db.exec('UPDATE connector_event_head SET rows = rows + 1');
  const head = f.db.prepare('SELECT * FROM connector_event_head').get();
  assert.throws(() => f.store.latestEventId());
  assert.deepEqual(f.db.prepare('SELECT * FROM connector_event_head').get(), head);
  assert.equal(f.db.isTransaction, false);
});

test('recovery never commits or rolls back a caller-owned transaction', t => {
  const f = fixture(t);
  f.fail(); f.store.upsertSession({ ...session, title: 'Outage change' });
  assert.throws(() => f.log.latestEventId(), /unavailable/);
  assert.equal(f.store.getSession(session.sessionKey)!.title, 'Outage change');
  f.restore();
  f.db.exec('BEGIN IMMEDIATE');
  assert.equal(f.log.recoverProjection(), false);
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK');
  assert.equal(f.log.recoverProjection(), true);
});

test('unchanged observations inside a caller transaction neither write nor poison the journal', t => {
  const f = fixture(t);
  f.fail();
  const revision = f.store.changes.revision;
  f.db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 3; i++) f.store.upsertSession(structuredClone(session));
  assert.equal(f.db.isTransaction, true, 'the caller still owns its transaction');
  assert.equal(f.log.latestEventId(), f.before, 'no write or nested-transaction failure');
  assert.equal(f.store.changes.revision, revision, 'no false invalidation');
  assert.equal(f.log.recoverProjection(), false, 'a healthy journal needs no recovery');
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK');
  f.restore();
  assert.equal(f.log.latestEventId(), f.before);
  f.store.upsertSession({ ...session, title: 'Real change' });
  assert.notEqual(f.log.latestEventId(), f.before, 'real changes are still persisted');
});

test('a closed journal never throws from optional projection writes or recovery', () => {
  const db = new DatabaseSync(':memory:');
  const log = new ConnectorEventLog(db), store = new DeckStore({ eventLog: log });
  db.close();
  assert.doesNotThrow(() => store.upsertSession(session));
  assert.equal(log.recoverProjection(), false);
  assert.throws(() => store.latestEventId(), /unavailable/);
});
