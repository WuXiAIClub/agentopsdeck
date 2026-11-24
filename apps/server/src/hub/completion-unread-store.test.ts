import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionUnreadStore, COMPLETION_LIMITS } from './completion-unread-store.js';
const event = (turnId: string, sourceCursor = 11) => ({ owner: 'alice', target: 'session', epoch: 'epoch', turnId, sourceCursor, provenance: 'live-successful-message' as const });
function memory(fn: (s: CompletionUnreadStore, db: DatabaseSync) => void) {
  const db = new DatabaseSync(':memory:'); try { fn(new CompletionUnreadStore(db, () => 1000), db); } finally { db.close(); }
}
test('unread reads do not initialize schema and baseline never replays history', () => memory((s, db) => {
  assert.deepEqual(s.summary('alice', ['session']), []);
  assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get()!.n, 0);
  assert.throws(() => s.record(event('before')), /baseline/);
  s.baseline('alice', 'session', 'epoch', 10);
  assert.equal(s.record(event('old', 10)).sequence, null);
  assert.equal(s.summary('alice', ['session'])[0]!.unread, false);
  assert.throws(() => s.baseline('alice', 'session', 'epoch', 12), /reused/);
}));
test('observation exposes the exact turn at its ACK ceiling, never a later successor', () => memory(s => {
  s.baseline('alice', 'session', 'epoch', 10);
  assert.equal(s.observe('alice', 'session').turnId, undefined, 'baseline is not a completed turn');
  s.record(event('first'));
  const first = s.observe('alice', 'session');
  assert.equal(first.turnId, 'first');
  s.record(event('second', 12));
  const second = s.observe('alice', 'session');
  assert.equal(second.turnId, 'second');
  assert.equal(second.throughSequence, first.throughSequence + 1);
  s.markRead('alice', 'session', 'late-first', first.token, first.throughSequence);
  assert.equal(s.summary('alice', ['session'])[0]!.unread, true);
}));
test('duplicate stable turns and out-of-order live events are distinct from historical replay', () => memory(s => {
  s.baseline('alice', 'session', 'epoch', 10);
  assert.equal(s.record(event('b', 15)).sequence, 1);
  assert.equal(s.record(event('a', 11)).sequence, 2);
  assert.equal(s.record(event('b', 16)).duplicate, true);
  assert.equal(s.summary('alice', ['session'])[0]!.latestSequence, 2);
  assert.throws(() => s.record({ ...event('bad'), provenance: 'history' as never }), /untrusted/);
}));
test('an older acknowledgement cannot clear a newly completed turn', () => memory(s => {
  s.baseline('alice', 'session', 'epoch', 10); s.record(event('a'));
  const first = s.observe('alice', 'session'); s.record(event('b', 12));
  s.markRead('alice', 'session', 'ack1', first.token, 1);
  assert.equal(s.summary('alice', ['session'])[0]!.unread, true);
  assert.throws(() => s.markRead('alice', 'session', 'forged', first.token, 2), /observation/);
  const second = s.observe('alice', 'session'); s.markRead('alice', 'session', 'ack2', second.token, 2);
  s.markRead('alice', 'session', 'older', first.token, 1);
  assert.equal(s.summary('alice', ['session'])[0]!.readThrough, 2);
}));
test('owner, target, generation, expiry and request identity bind observed evidence', () => memory((s, db) => {
  s.baseline('alice', 'session', 'epoch', 10); s.baseline('alice', 'other', 'epoch', 10); s.record(event('a'));
  const proof = s.observe('alice', 'session');
  assert.throws(() => s.markRead('bob', 'session', 'ack', proof.token, 1), /observation/);
  assert.throws(() => s.markRead('alice', 'other', 'ack', proof.token, 1), /observation/);
  const expired = new CompletionUnreadStore(db, () => 301000);
  assert.throws(() => expired.markRead('alice', 'session', 'ack', proof.token, 1), /observation/);
  s.markRead('alice', 'session', 'ack', proof.token, 1);
  assert.equal(expired.markRead('alice', 'session', 'ack', proof.token, 1), 1, 'original receipt survives proof expiry');
  assert.throws(() => s.markRead('alice', 'session', 'ack', proof.token, 0), /reused/);
  db.prepare('UPDATE completion_targets SET generation=?').run('new');
  assert.throws(() => s.markRead('alice', 'session', 'next', proof.token, 1), /observation/);
}));
test('one session in repeated panes counts once and a new baseline retains unread', () => memory(s => {
  s.baseline('alice', 'session', 'epoch', 10); s.record(event('a'));
  s.baseline('alice', 'session', 'next', 99);
  assert.equal(s.summary('alice', ['session', 'session', 'missing']).filter(v => v.unread).length, 1);
  assert.deepEqual(s.summary('bob', ['session']), []);
}));
test('capacity marks a durable gap without deleting unread or deduplication evidence', () => memory((s, db) => {
  s.baseline('alice', 'session', 'epoch', 10);
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO completion_events VALUES(?,?,?,?,?)');
  for (let n = 1; n <= COMPLETION_LIMITS.events; n++) insert.run('alice', 'session', 'epoch', `turn${n}`, n);
  db.prepare('UPDATE completion_targets SET latest=?').run(COMPLETION_LIMITS.events); db.exec('COMMIT');
  assert.equal(s.record(event('overflow')).gap, true);
  assert.equal(s.record(event('turn1')).duplicate, true);
  assert.equal(s.summary('alice', ['session'])[0]!.coverage, 'gap');
  assert.equal(s.summary('alice', ['session'])[0]!.unread, true);
  s.baseline('alice', 'session', 'new', 0);
  assert.equal(s.summary('alice', ['session'])[0]!.coverage, 'gap');
}));
test('physical reopen preserves unread, observation and original acknowledgement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-unread-')), path = join(dir, 'test.sqlite'); let db = new DatabaseSync(path);
  try {
    let s = new CompletionUnreadStore(db, () => 1000); s.baseline('alice', 'session', 'epoch', 10); s.record(event('a'));
    const proof = s.observe('alice', 'session'); db.close(); db = new DatabaseSync(path); s = new CompletionUnreadStore(db, () => 2000);
    assert.equal(s.summary('alice', ['session'])[0]!.unread, true); s.markRead('alice', 'session', 'ack', proof.token, 1);
    db.close(); db = new DatabaseSync(path); s = new CompletionUnreadStore(db, () => 999999);
    assert.equal(s.markRead('alice', 'session', 'ack', proof.token, 1), 1);
    assert.equal(s.summary('alice', ['session'])[0]!.unread, false);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});
test('durable operations reject outer transactions and malformed scope', () => memory((s, db) => {
  assert.throws(() => s.baseline('', 'session', 'epoch', 0), /identity/);
  db.exec('BEGIN'); assert.throws(() => s.baseline('alice', 'session', 'epoch', 0), /outer/); db.exec('ROLLBACK');
}));
