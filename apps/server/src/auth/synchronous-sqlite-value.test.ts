import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { synchronousSqliteValue } from './synchronous-sqlite-value.js';
import { recoverableConnection, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const transactional of [false, true]) test(`passkey permission read fences Promise observation (transaction=${transactional})`, () => {
  const raw = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  const db = recoverableConnection(raw, diagnostics), promise = Promise.resolve(undefined);
  const passkeys = new SqlitePasskeys(db, () => promise as unknown as undefined, () => 1000, diagnostics);
  const token = 'a'.repeat(43);
  db.prepare('INSERT INTO shared_auth_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), '{}', 2000);
  db.exec('CREATE TABLE facts(value INTEGER)');
  const insert = db.prepare('INSERT INTO facts VALUES(1)');
  let commit: (() => void) | undefined, committed = false, denied = false;
  Object.defineProperty(promise, 'constructor', { get() {
    if (commit) { try { commit(); committed = true; } catch { /* Denied after original latch. */ } }
    else { try { insert.run(); } catch (error) { denied = error instanceof StorageConnectionUnavailable; } }
    return Promise;
  } });
  try {
    if (transactional) {
      assert.throws(() => observedTransaction(db, 'auth-passkey-change', originalCommit => {
        commit = originalCommit; insert.run(); assert.equal(passkeys.sessionAuthorized(token), false);
      }, diagnostics));
      assert.equal(committed, false);
    } else {
      assert.equal(passkeys.sessionAuthorized(token), false); assert.equal(denied, true);
    }
    assert.equal(raw.prepare('SELECT count(*) n FROM facts').get()!.n, 0);
  } finally { db.close(); }
});

test('native Promise constructor observation cannot write through cached SQL before retirement', () => {
  const raw = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  const db = recoverableConnection(raw, diagnostics);
  db.exec('CREATE TABLE facts(value INTEGER)');
  const insert = db.prepare('INSERT INTO facts VALUES(1)'), promise = Promise.resolve('key');
  let denied = false;
  Object.defineProperty(promise, 'constructor', { get() {
    try { insert.run(); } catch (error) { denied = error instanceof StorageConnectionUnavailable; }
    return Promise;
  } });
  try {
    assert.throws(() => synchronousSqliteValue(db, () => promise));
    assert.equal(denied, true);
    assert.equal(raw.prepare('SELECT count(*) n FROM facts').get()!.n, 0);
  } finally { db.close(); }
});

test('native Promise constructor observation cannot use original commit before participant latching', () => {
  const raw = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  const db = recoverableConnection(raw, diagnostics);
  db.exec('CREATE TABLE facts(value INTEGER)');
  let committed = false;
  try {
    assert.throws(() => observedTransaction(db, 'auth-passkey-change', commit => {
      db.prepare('INSERT INTO facts VALUES(1)').run();
      const promise = Promise.resolve('key');
      Object.defineProperty(promise, 'constructor', { get() {
        try { commit(); committed = true; } catch { /* Original settlement is denied. */ }
        return Promise;
      } });
      synchronousSqliteValue(db, () => promise);
    }, diagnostics));
    assert.equal(committed, false);
    assert.equal(raw.prepare('SELECT count(*) n FROM facts').get()!.n, 0);
  } finally { db.close(); }
});
