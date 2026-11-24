import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedTransaction } from './observed-transaction.js';
import { observedSavepoint } from './observed-savepoint.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';

for (const explicit of [false, true]) test(`caught inner async participant cannot revive ${explicit ? 'explicit' : 'implicit'} settlement`, async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  db.exec('CREATE TABLE facts(value INTEGER)');
  try {
    assert.throws(() => observedTransaction(db, 'turn-queue-change', (commit, check) => {
      db.exec('INSERT INTO facts VALUES(1)');
      try { check(Promise.reject(Error('private continuation'))); } catch { /* A caller cannot clear the boundary. */ }
      if (explicit) commit();
    }), /must be synchronous/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(raw.isTransaction, false); assert.deepEqual(raw.prepare('SELECT * FROM facts').all(), []);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

test('inner participant inspector expires with its synchronous body and cannot taint a later owner', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  let retained!: (value: unknown) => void, getterCalls = 0;
  try {
    observedTransaction(db, 'turn-queue-change', (_commit, check) => { retained = check; check(undefined); });
    const value = { get then() { getterCalls++; return () => {}; } };
    assert.throws(() => retained(value), /participant callback ended/); assert.equal(getterCalls, 0);
    observedTransaction(db, 'turn-queue-change', () => { assert.throws(() => retained(value), /participant callback ended/); });
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
  } finally { db.close(); }
});

test('caught inner async savepoint participant still rolls back and retires the original owner', async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  db.exec('CREATE TABLE facts(value INTEGER)');
  try {
    assert.throws(() => observedSavepoint(db, 'sdk-execution-change', check => {
      db.exec('INSERT INTO facts VALUES(1)');
      try { check(Promise.reject(Error('private continuation'))); } catch { /* Not settlement authority. */ }
    }), /must be synchronous/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(raw.isTransaction, false); assert.deepEqual(raw.prepare('SELECT * FROM facts').all(), []);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

test('savepoint participant inspector expires before RELEASE and cannot inspect a later owner', () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  let retained!: (value: unknown) => void, getterCalls = 0;
  try {
    observedSavepoint(db, 'sdk-execution-change', check => { retained = check; check(undefined); });
    const value = { get then() { getterCalls++; return () => {}; } };
    assert.throws(() => retained(value), /participant callback ended/); assert.equal(getterCalls, 0);
    observedSavepoint(db, 'sdk-execution-change', () => { assert.throws(() => retained(value), /participant callback ended/); });
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
  } finally { db.close(); }
});

for (const savepoint of [false, true]) for (const nested of [false, true])
  test(`invalid async ${savepoint ? 'savepoint' : 'transaction'} work retires its old SQL owner (${nested})`, async () => {
    const raw = new DatabaseSync(':memory:'), rows: Record<string, unknown>[] = [];
    const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    const db = recoverableConnection(raw, diagnostics);
    db.exec('CREATE TABLE facts(value INTEGER); INSERT INTO facts VALUES(0)');
    const insert = db.prepare('INSERT INTO facts VALUES(?)'), query = db.prepare('SELECT value FROM facts');
    let release!: () => void, lateResult!: Promise<void>, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    if (nested) db.exec('BEGIN; INSERT INTO facts VALUES(1)');
    try {
      const work = () => {
        calls++; insert.run(2);
        lateResult = (async () => { await held; insert.run(3); })();
        return lateResult;
      };
      const run = () => savepoint ? observedSavepoint(db, 'claude-transcript-append', work as any, diagnostics)
        : observedTransaction(db, 'turn-queue-change', work as any, diagnostics, nested);
      assert.throws(run, /must be synchronous/);
      // The raw connection is a test-only probe; production exposes only db.
      assert.deepEqual(raw.prepare('SELECT value FROM facts').all().map(row => row.value), nested ? [0, 1] : [0]);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => query.all(), StorageConnectionUnavailable);
      assert.throws(() => db.exec('BEGIN'), StorageConnectionUnavailable);
      const rejected = assert.rejects(lateResult, StorageConnectionUnavailable);
      release(); await rejected;
      assert.equal(calls, 1); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => insert.run(4), StorageConnectionUnavailable, 'settlement alone cannot reauthorize the retired owner');
      const log = rows.find(row => row.operation === (savepoint ? 'claude-transcript-append' : 'turn-queue-change'));
      assert.equal(log?.unknown, 1); assert.equal(log?.settled, undefined);
      db.close(); assert.equal(connectionRecoverySnapshot(db).state, 'closed');
      assert.throws(() => insert.run(5), StorageConnectionUnavailable);
    } finally { release(); await lateResult?.catch(() => {}); db.close(); }
  });

for (const savepoint of [false, true]) test(`invalid non-native thenable is not invoked during ${savepoint ? 'savepoint' : 'transaction'} rejection`, () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  let thenCalls = 0;
  const work = () => ({ then() { thenCalls++; } });
  try {
    assert.throws(() => savepoint ? observedSavepoint(db, 'claude-transcript-append', work as any)
      : observedTransaction(db, 'turn-queue-change', work as any), /must be synchronous/);
    assert.equal(thenCalls, 0); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

for (const savepoint of [false, true]) test(`rejected native Promise in ${savepoint ? 'savepoint' : 'transaction'} is consumed without reopening its retired owner`, async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  try {
    const work = () => Promise.reject(Error('private async contract failure'));
    assert.throws(() => savepoint ? observedSavepoint(db, 'claude-transcript-append', work as any)
      : observedTransaction(db, 'turn-queue-change', work as any), /must be synchronous/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

test('an explicit committed effect is not undone or replayed when the callback subsequently escapes asynchronously', async () => {
  const raw = new DatabaseSync(':memory:'), rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), db = recoverableConnection(raw, diagnostics);
  db.exec('CREATE TABLE facts(value INTEGER)'); let calls = 0;
  try {
    assert.throws(() => observedTransaction(db, 'command-receipt-claim', ((commit: () => void) => {
      calls++; db.exec('INSERT INTO facts VALUES(1)'); commit(); return Promise.reject(Error('private continuation'));
    }) as any, diagnostics), /must be synchronous/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.deepEqual(raw.prepare('SELECT value FROM facts').all().map(row => row.value), [1]);
    assert.equal(rows[0]!.settled, 1); assert.equal(rows[0]!.unknown, 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

for (const savepoint of [false, true]) for (const hidden of [false, true])
  test(`native Promise with ${hidden ? 'hidden' : 'throwing'} then still retires its ${savepoint ? 'savepoint' : 'transaction'} owner`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE facts(value INTEGER)');
    const insert = db.prepare('INSERT INTO facts VALUES(1)'); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const late = (async () => { await held; insert.run(); })();
    if (hidden) Object.defineProperty(late, 'then', { value: undefined });
    else Object.defineProperty(late, 'then', { get() { assert.fail('native Promise detection must not call its then getter'); } });
    const observed = new Promise<void>((resolve, reject) => { Promise.prototype.then.call(late, resolve, reject); });
    try {
      assert.throws(() => savepoint ? observedSavepoint(db, 'claude-transcript-append', (() => late) as any)
        : observedTransaction(db, 'turn-queue-change', (() => late) as any), /must be synchronous/);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const failure = assert.rejects(observed, StorageConnectionUnavailable); release(); await failure;
      assert.deepEqual(raw.prepare('SELECT value FROM facts').all(), []);
    } finally { release(); await observed.catch(() => {}); db.close(); }
  });

for (const savepoint of [false, true]) test(`throwing thenable inspection retires its ${savepoint ? 'savepoint' : 'transaction'} owner without masking the error`, () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), original = Error('private inspection');
  try {
    const work = () => ({ get then() { throw original; } });
    assert.throws(() => savepoint ? observedSavepoint(db, 'claude-transcript-append', work as any)
      : observedTransaction(db, 'turn-queue-change', work as any), error => error === original);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});
