import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from './observed-transaction.js';
import { recoverableConnection } from './connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const silent = new PerformanceDiagnostics(() => {});
// Keep later owners on the same handle: merely checking that a stale callback
// throws after close would hide accidental COMMIT/RELEASE of unrelated work.
for (const nested of [false, true]) for (const owned of [false, true]) {
  test(`failed transaction revokes retained commit before another owner (${nested}/${owned})`, () => {
    const raw = new DatabaseSync(':memory:'), db = owned ? recoverableConnection(raw, silent) : raw;
    let late!: () => void;
    const original = Error('original body');
    try {
      db.exec('CREATE TABLE effects(value INTEGER)');
      if (nested) db.exec('BEGIN; INSERT INTO effects VALUES(1)');
      assert.throws(() => observedTransaction(db, 'turn-queue-change', commit => {
        late = commit; db.exec('INSERT INTO effects VALUES(2)'); throw original;
      }, silent, nested), error => error === original);
      if (nested) db.exec('SAVEPOINT turn_batch_claim; INSERT INTO effects VALUES(3)');
      else db.exec('BEGIN; INSERT INTO effects VALUES(3)');
      assert.throws(late, /callback ended/);
      assert.equal(db.isTransaction, true);
      if (nested) {
        db.exec('ROLLBACK TO turn_batch_claim; RELEASE turn_batch_claim');
        assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), [1]);
      }
      db.exec('ROLLBACK');
      assert.equal(db.prepare('SELECT count(*) n FROM effects').get()!.n, 0);
    } finally { db.close(); }
  });
}

for (const nested of [false, true]) {
  for (const explicit of [false, true]) {
    test(`successful settlement revokes a queued callback (${nested}/${explicit})`, async () => {
      const db = new DatabaseSync(':memory:');
      let late!: () => void;
      try {
        db.exec('CREATE TABLE effects(value INTEGER)');
        if (nested) db.exec('BEGIN');
        const value = observedTransaction(db, 'turn-queue-change', commit => {
          late = commit;
          db.exec('INSERT INTO effects VALUES(2)');
          if (explicit) {
            commit();
            assert.throws(commit, /already attempted/);
          }
          return 42;
        }, silent, nested);
        assert.equal(value, 42);
        if (nested) db.exec('SAVEPOINT turn_batch_claim; INSERT INTO effects VALUES(3)');
        else db.exec('BEGIN; INSERT INTO effects VALUES(3)');
        await Promise.resolve();
        assert.throws(late, /callback ended/);
        assert.equal(db.isTransaction, true);
        if (nested) {
          db.exec('ROLLBACK TO turn_batch_claim; RELEASE turn_batch_claim');
          assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), [2]);
        }
        db.exec('ROLLBACK');
        assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), nested ? [] : [2]);
      } finally { db.close(); }
    });
  }
  test(`automatic settlement uses only its internal capability (${nested})`, () => {
    const db = new DatabaseSync(':memory:');
    let late!: () => void, inspections = 0;
    try {
      db.exec('CREATE TABLE effects(value INTEGER)');
      if (nested) db.exec('BEGIN');
      const value = { get then() { inspections++; assert.throws(late, /callback ended/); return undefined; } };
      assert.equal(observedTransaction(db, 'turn-queue-change', commit => {
        late = commit; db.exec('INSERT INTO effects VALUES(2)'); return value;
      }, silent, nested), value);
      assert.equal(inspections, 1);
      assert.equal(db.isTransaction, nested);
      assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), [2]);
      if (nested) db.exec('ROLLBACK');
    } finally { db.close(); }
  });
  test(`retained commit has no authority during rollback or diagnostic delivery (${nested})`, () => {
    const raw = new DatabaseSync(':memory:');
    let late!: () => void, attempted = 0;
    const assertRevoked = () => { attempted++; assert.throws(late, /callback ended/); };
    const db = new Proxy(raw, { get(target, key) {
      if (key === 'exec') return (sql: string) => { if (sql.startsWith('ROLLBACK')) assertRevoked(); target.exec(sql); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const original = Error('original body'), logs: unknown[] = [];
    let deliveredError: unknown;
    const diagnostics = new PerformanceDiagnostics(line => {
      logs.push(JSON.parse(line));
      try { assertRevoked(); } catch (error) { deliveredError = error; }
    });
    try {
      db.exec('CREATE TABLE effects(value INTEGER)');
      if (nested) db.exec('BEGIN; INSERT INTO effects VALUES(1)');
      assert.throws(() => observedTransaction(db, 'turn-queue-change', commit => {
        late = commit; db.exec('INSERT INTO effects VALUES(2)'); throw original;
      }, diagnostics, nested), error => error === original);
      assert.equal(attempted, 3); assert.equal(deliveredError, undefined); assert.equal(logs.length, 2);
      assert.equal(raw.isTransaction, nested);
      assert.deepEqual(raw.prepare('SELECT value FROM effects').all().map(row => row.value), nested ? [1] : []);
      if (nested) raw.exec('ROLLBACK');
    } finally { raw.close(); }
  });
  test(`returned value inspection cannot invoke the body's commit callback (${nested})`, () => {
    const db = new DatabaseSync(':memory:');
    let late!: () => void, inspections = 0;
    const original = Error('result inspection');
    try {
      db.exec('CREATE TABLE effects(value INTEGER)');
      if (nested) db.exec('BEGIN; INSERT INTO effects VALUES(1)');
      assert.throws(() => observedTransaction(db, 'turn-queue-change', commit => {
        late = commit; db.exec('INSERT INTO effects VALUES(2)');
        return { get then() { inspections++; assert.throws(late, /callback ended/); throw original; } };
      }, silent, nested), error => error === original);
      assert.equal(inspections, 1); assert.equal(db.isTransaction, nested);
      assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), nested ? [1] : []);
      if (nested) db.exec('ROLLBACK');
    } finally { db.close(); }
  });
  test(`explicit synchronous commit remains durable before policy rejection (${nested})`, () => {
    const db = new DatabaseSync(':memory:');
    let late!: () => void;
    const rejection = Error('policy rejection');
    try {
      db.exec('CREATE TABLE effects(value INTEGER)');
      if (nested) db.exec('BEGIN');
      assert.throws(() => observedTransaction(db, 'command-receipt-claim', commit => {
        late = commit; db.exec('INSERT INTO effects VALUES(2)'); commit(); throw rejection;
      }, silent, nested), error => error === rejection);
      assert.throws(late, /callback ended/);
      assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), [2]);
      assert.equal(db.isTransaction, nested);
      if (nested) db.exec('ROLLBACK');
    } finally { db.close(); }
  });
}

for (const nested of [false, true]) for (const throws of [false, true]) {
  test(`late settlement diagnostic is single-entry and never authority (${nested}/${throws})`, () => {
    const db = new DatabaseSync(':memory:');
    let late!: () => void, delivered = 0;
    const rows: Array<Record<string, unknown>> = [];
    const diagnostics = new PerformanceDiagnostics(line => {
      const row = JSON.parse(line) as Record<string, unknown>;
      rows.push(row);
      if (row.operation === 'storage-settlement-rejected') {
        delivered++;
        assert.throws(late, /callback ended/);
        if (throws) throw Error('private sink detail');
      }
    });
    try {
      db.exec('CREATE TABLE effects(value INTEGER)');
      if (nested) db.exec('BEGIN');
      observedTransaction(db, 'turn-queue-change', commit => {
        late = commit; db.exec('INSERT INTO effects VALUES(2)');
      }, diagnostics, nested);
      if (nested) db.exec('SAVEPOINT turn_batch_claim; INSERT INTO effects VALUES(3)');
      else db.exec('BEGIN; INSERT INTO effects VALUES(3)');
      assert.throws(late, /callback ended/);
      assert.throws(late, /callback ended/);
      assert.equal(delivered, 1);
      const rejection = rows.find(row => row.operation === 'storage-settlement-rejected');
      assert.ok(rejection);
      assert.equal(rejection.phase, 'finished');
      assert.equal(rejection.category, 'failed');
      assert.equal(rejection.nested, Number(nested));
      assert.equal(rejection.settled, undefined);
      assert.equal(JSON.stringify(rows).includes('private'), false);
      assert.equal(db.isTransaction, true);
      if (nested) db.exec('ROLLBACK TO turn_batch_claim; RELEASE turn_batch_claim');
      db.exec('ROLLBACK');
      assert.deepEqual(db.prepare('SELECT value FROM effects').all().map(row => row.value), nested ? [] : [2]);
    } finally { db.close(); }
  });
}
