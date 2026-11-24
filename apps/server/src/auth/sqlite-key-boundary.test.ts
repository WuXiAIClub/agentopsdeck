import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { AuthPersistenceError } from './private-store.js';
import { createDeckSession } from './passkeys.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { observedTransaction } from '../storage/observed-transaction.js';

const key = 'a'.repeat(24);
function fixture(currentKey: () => unknown, now: () => unknown = () => 10_000) {
  const raw = new DatabaseSync(':memory:'), logs: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const db = recoverableConnection(raw, diagnostics);
  const store = new SqlitePasskeys(db, currentKey as () => string | undefined, now as () => number, diagnostics);
  return { raw, db, store, logs, diagnostics };
}
function empty(raw: DatabaseSync) {
  assert.equal(raw.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
  assert.equal(raw.prepare('SELECT count(*) n FROM shared_auth_audit').get()!.n, 0);
  assert.equal(raw.isTransaction, false);
}

test('recognized async key reader is refused before dispatch, with rollback and reusable original connection', () => {
  let started = 0;
  const f = fixture(async () => { started++; return key; });
  try {
    assert.throws(() => f.store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
    assert.equal(started, 0); empty(f.raw);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
    assert.ok(f.logs.some(row => row.operation === 'auth-passkey-change' && row.category === 'failed'));
    assert.equal(observedTransaction(f.db, 'auth-passkey-change', () => 42, f.diagnostics), 42);
  } finally { f.db.close(); }
});

test('native Promise key reader rolls back and fences original cached SQL before continuation', async () => {
  let release!: () => void, escaped!: Promise<string>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let insert!: ReturnType<DatabaseSync['prepare']>;
  const f = fixture(() => {
    escaped = gate.then(() => { insert.run('late', 'late', 10_000); return key; });
    return escaped;
  });
  insert = f.db.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)');
  try {
    assert.throws(() => f.store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
    empty(f.raw);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
    assert.throws(() => insert.run('new', 'new', 10_000), StorageConnectionUnavailable);
    release(); await assert.rejects(escaped, StorageConnectionUnavailable); empty(f.raw);
    assert.ok(f.logs.some(row => row.operation === 'auth-passkey-change' && row.unknown === 1));
  } finally { release(); f.db.close(); }
});

test('invalid key results never invoke then, coercion or JSON callbacks and leave no writes', () => {
  let invoked = 0;
  const hostile = { get then() { invoked++; throw Error('PRIVATE then'); },
    toJSON() { invoked++; throw Error('PRIVATE json'); }, toString() { invoked++; throw Error('PRIVATE coercion'); } };
  const proxy = new Proxy({}, { get() { invoked++; throw Error('PRIVATE proxy'); } });
  for (const result of [hostile, proxy, '', 'invalid', 1, null, true]) {
    const f = fixture(() => result);
    try {
      assert.throws(() => f.store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
      empty(f.raw); assert.equal(invoked, 0);
      assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
      assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
    } finally { f.db.close(); }
  }
});

test('identity changes at final check roll back both administrator session and audit', () => {
  let reads = 0;
  const f = fixture(() => ++reads === 1 ? key : 'b'.repeat(24));
  try {
    assert.throws(() => f.store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
    assert.equal(reads, 2); empty(f.raw);
  } finally { f.db.close(); }
});

test('literal identity and legacy undefined identity still issue current administrator sessions', () => {
  for (const value of [key, undefined]) {
    const f = fixture(() => value), token = createDeckSession();
    try {
      f.store.addAdministratorSession(token);
      assert.equal(f.store.sessionAuthorized(token), true);
      assert.equal(f.store.isAccessKeySession(token), true);
      assert.equal(f.raw.prepare('SELECT count(*) n FROM shared_auth_audit').get()!.n, 1);
    } finally { f.db.close(); }
  }
});

test('a Promise during read-only authorization denies and fences the old connection without replay', async () => {
  let reading = false, escaped!: Promise<string>;
  let insert!: ReturnType<DatabaseSync['prepare']>, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => reading ? (escaped = gate.then(() => { insert.run('late', 'late', 10_000); return key; })) : key);
  const token = createDeckSession();
  try {
    f.store.addAdministratorSession(token);
    insert = f.db.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)');
    reading = true;
    assert.equal(f.store.sessionAuthorized(token), false);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
    release(); await assert.rejects(escaped, StorageConnectionUnavailable);
    assert.equal(f.raw.prepare('SELECT count(*) n FROM shared_auth_audit').get()!.n, 1);
    assert.ok(f.logs.some(row => row.operation === 'auth-passkey-read' && row.category === 'failed'));
  } finally { release(); f.db.close(); }
});

test('native Promise clock callback cannot leak writes after original session rollback', async () => {
  let release!: () => void, escaped!: Promise<number>, insert!: ReturnType<DatabaseSync['prepare']>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => key, () => (escaped = gate.then(() => { insert.run('late', 'late', 10_000); return 10_000; })));
  insert = f.db.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)');
  try {
    assert.throws(() => f.store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
    empty(f.raw);
    release(); await assert.rejects(escaped, StorageConnectionUnavailable); empty(f.raw);
  } finally { release(); f.db.close(); }
});

test('recognized async clock is rejected before starting and preserves original connection usability', () => {
  let started = 0;
  const f = fixture(() => key, async () => { started++; return 10_000; });
  try {
    assert.throws(() => f.store.addAdministratorSession(createDeckSession()), AuthPersistenceError);
    assert.equal(started, 0); empty(f.raw);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
  } finally { f.db.close(); }
});

test('a caught read denial cannot authorize the enclosing original transaction after Promise escape', async () => {
  let reading = false;
  const f = fixture(() => reading ? Promise.resolve(key) : key), token = createDeckSession();
  try {
    f.store.addAdministratorSession(token); reading = true;
    assert.throws(() => observedTransaction(f.db, 'auth-passkey-change', () => {
      assert.equal(f.store.sessionAuthorized(token), false);
      f.db.prepare('DELETE FROM shared_auth_sessions').run();
    }, f.diagnostics));
    assert.equal(f.raw.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
    assert.equal(f.raw.isTransaction, false);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.throws(() => f.db.prepare('SELECT 1'), StorageConnectionUnavailable);
  } finally { f.db.close(); }
});
