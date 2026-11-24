import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { observedTransaction } from './observed-transaction.js';
import { observedSavepoint } from './observed-savepoint.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function fixture() {
  const raw = new DatabaseSync(':memory:'), logs: any[] = []; let now = 0;
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const db = recoverableConnection(raw, diagnostics, () => now);
  db.exec('CREATE TABLE facts(value INTEGER); INSERT INTO facts VALUES(0)');
  return { raw, db, logs, diagnostics, tick: () => { now += 1001; } };
}

for (const acquired of [false, true]) test(`uncertain nested acquisition never rolls back a same-named parent (${acquired})`, () => {
  const f = fixture(), exec = f.db.exec.bind(f.db), original = Error('private-begin');
  try {
    f.db.exec('BEGIN; SAVEPOINT claude_transcript_append; INSERT INTO facts VALUES(1)');
    f.db.exec = sql => {
      if (sql === 'SAVEPOINT claude_transcript_append') { if (acquired) exec(sql); throw original; }
      exec(sql);
    };
    assert.throws(() => observedSavepoint(f.db, 'claude-transcript-append', () => assert.fail('body ran'), f.diagnostics), error => error === original);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'parent-rollback-required');
    assert.equal(f.raw.prepare('SELECT count(*) n FROM facts').get()!.n, 2, 'parent writes preserved for owner');
    assert.throws(() => f.db.exec('COMMIT'), StorageConnectionUnavailable);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, 1);
    assert.equal(f.logs[0].unknown, 1);
  } finally { f.db.close(); }
});

test('standalone cleanup fault blocks cached SQL and recovers only rollback without replay', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db), original = Error('private-original');
  const insert = f.db.prepare('INSERT INTO facts VALUES(?)'), select = f.db.prepare('SELECT value FROM facts');
  let broken = true, calls = 0, rollbacks = 0;
  f.db.exec = sql => { if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-cleanup'); } exec(sql); };
  try {
    assert.throws(() => observedTransaction(f.db, 'turn-queue-change', () => { calls++; insert.run(1); throw original; }, f.diagnostics), error => error === original);
    assert.equal(f.db.isTransaction, true);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'owner-rollback-required');
    assert.throws(() => insert.run(2), StorageConnectionUnavailable);
    assert.throws(() => select.all(), StorageConnectionUnavailable);
    assert.throws(() => f.db.exec('COMMIT'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 2, 'one cleanup plus one bounded recovery attempt');
    broken = false; f.tick();
    assert.throws(() => insert.run(4), StorageConnectionUnavailable, 'recovery cannot continue a caller with stale ownership assumptions');
    assert.equal(observedTransaction(f.db, 'turn-queue-change', () => { insert.run(3); return 42; }, f.diagnostics), 42);
    assert.equal(calls, 1); assert.deepEqual(select.all().map(row => row.value), [0, 3]);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
    assert.equal(f.logs.filter(row => row.operation === 'storage-connection-recovery').length, 2);
    assert.doesNotMatch(JSON.stringify(f.logs), /private|facts|ROLLBACK/);
  } finally { f.db.close(); }
});

test('nested cleanup fault cannot commit or take over parent; only full parent rollback restores access', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db), insert = f.db.prepare('INSERT INTO facts VALUES(?)');
  f.db.exec = sql => { if (sql.startsWith('ROLLBACK TO')) throw Error('cleanup'); exec(sql); };
  try {
    f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
    assert.throws(() => observedSavepoint(f.db, 'claude-transcript-append', () => { insert.run(2); throw Error('original'); }, f.diagnostics), /original/);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'parent-rollback-required');
    for (const sql of ['COMMIT', 'RELEASE claude_transcript_append', 'BEGIN', 'ROLLBACK; BEGIN']) {
      assert.throws(() => f.db.exec(sql), StorageConnectionUnavailable);
    }
    assert.throws(() => insert.run(3), StorageConnectionUnavailable);
    assert.equal(connectionRecoverySnapshot(f.db).attempts, 0);
    f.db.exec('ROLLBACK');
    assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
    assert.deepEqual(f.db.prepare('SELECT value FROM facts').all().map(row => row.value), [0]);
  } finally { f.db.close(); }
});

test('iterator is self-iterable and fenced after nested fault; SQLite methods retain native receiver', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db);
  try {
    f.db.function('synthetic', () => 7);
    assert.equal(f.db.prepare('SELECT synthetic() n').get()!.n, 7);
    const iterator = f.db.prepare('SELECT value FROM facts').iterate();
    assert.equal(iterator[Symbol.iterator](), iterator);
    f.db.exec('BEGIN');
    f.db.exec = sql => { if (sql.startsWith('ROLLBACK TO')) throw Error('cleanup'); exec(sql); };
    assert.throws(() => observedSavepoint(f.db, 'copilot-transcript-append', () => { throw Error('original'); }, f.diagnostics), /original/);
    assert.throws(() => iterator.next(), StorageConnectionUnavailable);
    f.db.exec('ROLLBACK');
    assert.throws(() => iterator.next(), StorageConnectionUnavailable, 'a stale iterator cannot publish after recovery');
    iterator.return?.();
  } finally { f.db.close(); }
});

test('lost cleanup ACK after effect does not poison a clean owner or alter original error', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db), original = Error('original');
  f.db.exec = sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('lost ACK'); };
  try {
    assert.throws(() => observedTransaction(f.db, 'turn-queue-change', () => { f.db.exec('INSERT INTO facts VALUES(1)'); throw original; }, f.diagnostics), error => error === original);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
    assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, 1);
    assert.equal(f.logs[0].unknown, 1);
  } finally { f.db.close(); }
});

test('saved native exec can be restored; recovery never repeats a lost COMMIT', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db); let commits = 0;
  try {
    f.db.exec = sql => { if (sql === 'COMMIT') { commits++; throw Error('commit'); } if (sql === 'ROLLBACK') throw Error('rollback'); exec(sql); };
    assert.throws(() => observedTransaction(f.db, 'turn-queue-change', () => f.db.exec('INSERT INTO facts VALUES(1)'), f.diagnostics), /commit/);
    f.db.exec = exec;
    assert.throws(() => f.db.prepare('SELECT count(*) n FROM facts'), StorageConnectionUnavailable);
    assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, 1);
    assert.equal(commits, 1); assert.equal(f.db.isTransaction, false);
  } finally { f.db.close(); }
});

test('failed outer rollback promotes nested fault to recoverable owner; no partial writes survive', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db); let broken = true;
  f.db.exec = sql => { if (sql.startsWith('ROLLBACK') && broken) throw Error('cleanup'); exec(sql); };
  try {
    assert.throws(() => observedTransaction(f.db, 'turn-queue-change', () => {
      f.db.exec('INSERT INTO facts VALUES(1)');
      observedSavepoint(f.db, 'claude-transcript-append', () => { f.db.exec('INSERT INTO facts VALUES(2)'); throw Error('original'); }, f.diagnostics);
    }, f.diagnostics), /original/);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'owner-rollback-required');
    broken = false;
    assert.throws(() => f.db.prepare('SELECT count(*) n FROM facts'), StorageConnectionUnavailable);
    assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, 1);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
  } finally { f.db.close(); }
});

test('legacy rollback paths are fenced even without an observed helper', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db);
  try {
    f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
    f.db.exec = sql => { if (sql === 'ROLLBACK') throw Error('cleanup'); exec(sql); };
    assert.throws(() => f.db.exec('ROLLBACK'), /cleanup/);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'owner-rollback-required');
    assert.throws(() => f.db.prepare('SELECT value FROM facts'), StorageConnectionUnavailable);
    f.db.exec = exec; f.tick();
    assert.throws(() => f.db.prepare('SELECT count(*) n FROM facts'), StorageConnectionUnavailable);
    assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get()!.n, 1);
  } finally { f.db.close(); }
});
