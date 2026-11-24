import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { observedTransaction } from './observed-transaction.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function fixture(failingSink = false) {
  const raw = new DatabaseSync(':memory:');
  let sqlError!: Error;
  try { raw.exec('SELECT * FROM PRIVATE_missing_table'); } catch (error) { sqlError = error as Error; }
  const logs: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => {
    if (failingSink) throw Error('PRIVATE sink');
    logs.push(JSON.parse(line));
  });
  let now = 0;
  const db = recoverableConnection(raw, diagnostics, () => now);
  db.exec('CREATE TABLE facts(n)');
  return { raw, db, logs, diagnostics, sqlError, advance: () => { now += 1000; } };
}

test('rollback recovery records numeric SQL failure while retaining the exact original handle and no replay', () => {
  const f = fixture(), exec = f.db.exec.bind(f.db), original = Error('PRIVATE original');
  let writes = 0, broken = true;
  f.db.exec = sql => { if (broken && sql === 'ROLLBACK') throw f.sqlError; exec(sql); };
  try {
    assert.throws(() => observedTransaction(f.db, 'turn-queue-change', () => {
      writes++; f.db.exec('INSERT INTO facts VALUES(1)'); throw original;
    }, f.diagnostics), error => error === original);
    assert.throws(() => f.db.prepare('SELECT n FROM facts'), StorageConnectionUnavailable);
    const row = f.logs.find(row => row.operation === 'storage-connection-recovery')!;
    assert.equal(row.rollbackErrorCode, 1); assert.equal(row.rollbackFailed, 1); assert.equal(row.unknown, 1);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'owner-rollback-required');
    assert.equal(writes, 1);
    broken = false; f.advance();
    // Recovery succeeds but the triggering request still fails; the next fresh read is allowed.
    assert.throws(() => f.db.prepare('SELECT n FROM facts'), StorageConnectionUnavailable);
    assert.deepEqual(f.db.prepare('SELECT n FROM facts').all(), []);
    assert.equal(writes, 1); assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|SELECT|ROLLBACK|INSERT/);
  } finally { f.db.close(); }
});

for (const lostAck of [false, true]) test(`close numeric SQL failure retains original close proof, lost ACK=${lostAck}`, () => {
  const f = fixture(), close = f.raw.close.bind(f.raw); let attempts = 0;
  const statement = f.db.prepare('SELECT n FROM facts');
  f.raw.close = () => {
    if (++attempts === 1) { if (lostAck) close(); throw f.sqlError; }
    close();
  };
  try {
    assert.throws(() => f.db.close(), error => error === f.sqlError);
    const row = f.logs.find(row => row.operation === 'storage-connection-close')!;
    assert.equal(row.sqlErrorCode, 1);
    assert.equal(row[lostAck ? 'recovered' : 'unknown'], 1);
    assert.equal(connectionRecoverySnapshot(f.db).state, lostAck ? 'closed' : 'close-required');
    assert.throws(() => statement.all(), StorageConnectionUnavailable);
    f.db.close(); f.db.close(); assert.equal(attempts, lostAck ? 1 : 2);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'closed');
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|SELECT|ROLLBACK/);
  } finally { if (f.raw.isOpen) close(); }
});

for (const phase of ['rollback', 'close'] as const) for (const kind of ['getter', 'proxy'] as const)
test(`${phase} classification does not execute ${kind} exception properties`, () => {
  const f = fixture(), exec = f.db.exec.bind(f.db), close = f.raw.close.bind(f.raw); let reads = 0;
  const error = kind === 'proxy' ? new Proxy({}, {
    get() { reads++; throw Error('PRIVATE'); }, getOwnPropertyDescriptor() { reads++; throw Error('PRIVATE'); },
  }) : Object.defineProperties({}, {
    code: { get() { reads++; throw Error('PRIVATE'); } }, errcode: { get() { reads++; return 1; } },
  });
  try {
    if (phase === 'rollback') {
      f.db.exec = sql => { if (sql === 'ROLLBACK') throw error; exec(sql); };
      assert.throws(() => observedTransaction(f.db, 'turn-queue-change', () => { throw Error('original'); }, f.diagnostics));
      assert.throws(() => f.db.prepare('SELECT n FROM facts'), StorageConnectionUnavailable);
    } else {
      f.raw.close = () => { throw error; };
      assert.throws(() => f.db.close(), caught => caught === error);
    }
    const row = f.logs.find(row => row.operation === (phase === 'rollback' ? 'storage-connection-recovery' : 'storage-connection-close'))!;
    assert.equal(row.classificationUnknown, 1); assert.equal(reads, 0);
  } finally { f.raw.close = close; f.db.close(); }
});

test('failed diagnostics delivery cannot change close fencing, original error, or retry', () => {
  const f = fixture(true), close = f.raw.close.bind(f.raw); let attempts = 0;
  f.raw.close = () => { if (++attempts === 1) throw f.sqlError; close(); };
  try {
    assert.throws(() => f.db.close(), error => error === f.sqlError);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
    const snapshot = f.diagnostics.snapshot();
    assert.ok(snapshot.events.some(row => row.sqlErrorCode === 1 && row.delivery === 'failed'));
    f.db.close(); assert.equal(attempts, 2); assert.equal(connectionRecoverySnapshot(f.db).state, 'closed');
  } finally { if (f.raw.isOpen) close(); }
});
