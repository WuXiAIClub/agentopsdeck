import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedSavepoint } from './observed-savepoint.js';
import { observedTransaction } from './observed-transaction.js';
import { StorageAdmissionDeferred, StorageWorkAdmission } from './work-admission.js';
import { recoverableConnection, retireConnectionForAsyncWork } from './connection-recovery.js';

for (const kind of ['savepoint', 'transaction', 'admission'] as const) {
  test(`${kind}: diagnostic reentry cannot roll back another owner's parent`, () => {
    const db = recoverableConnection(new DatabaseSync(':memory:')); let armed = true, calls = 0;
    db.exec('CREATE TABLE facts(id INTEGER)');
    const diagnostics = new PerformanceDiagnostics(() => {}, () => {
      if (armed) { armed = false; db.exec('BEGIN; INSERT INTO facts VALUES(1)'); }
      return performance.now();
    });
    try {
      if (kind === 'savepoint') assert.throws(() => observedSavepoint(db, 'hub-identity-change', () => {
        calls++; throw Error('private-body');
      }, diagnostics));
      else if (kind === 'transaction') assert.throws(() => observedTransaction(db, 'turn-queue-change', () => {
        calls++; throw Error('private-body');
      }, diagnostics, true));
      else {
        const owner = new StorageWorkAdmission(db, Date.now, diagnostics);
        assert.throws(() => owner.reserve('volume', 'request', 'recovery', 1, () => {
          calls++; return { freeBytes: 1_000_000_000n, observedAt: Date.now() };
        }), error => error instanceof StorageAdmissionDeferred && error.message === 'outer-transaction');
      }
      assert.equal(armed, false); assert.equal(calls, 0);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(db.prepare('SELECT id FROM facts').all().map(r => r.id), [1]);
      const failure = diagnostics.snapshot().events.find(e => e.phase === 'finished')!;
      assert.equal(failure.category, 'failed'); assert.equal(failure.step, 1);
      assert.equal(failure.rollbackMs, undefined); assert.equal(failure.unknown, undefined);
      assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-body|volume|request|facts/);
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  });

  test(`${kind}: observation cannot revive a connection fenced before acquisition`, () => {
    const db = recoverableConnection(new DatabaseSync(':memory:')); let armed = true, calls = 0;
    const diagnostics = new PerformanceDiagnostics(() => {}, () => {
      if (armed) { armed = false; retireConnectionForAsyncWork(db); }
      return performance.now();
    });
    try {
      if (kind === 'savepoint') assert.throws(() => observedSavepoint(db, 'hub-identity-change', () => { calls++; }, diagnostics));
      else if (kind === 'transaction') assert.throws(() => observedTransaction(db, 'turn-queue-change', () => { calls++; }, diagnostics, true));
      else {
        const owner = new StorageWorkAdmission(db, Date.now, diagnostics);
        assert.throws(() => owner.reserve('volume', 'request', 'recovery', 1, () => {
          calls++; return { freeBytes: 1_000_000_000n, observedAt: Date.now() };
        }));
      }
      assert.equal(armed, false); assert.equal(calls, 0); assert.equal(db.isTransaction, false);
      const failure = diagnostics.snapshot().events.find(e => e.phase === 'finished')!;
      assert.equal(failure.category, 'failed'); assert.equal(failure.step, 1);
      assert.equal(failure.rollbackMs, undefined); assert.equal(failure.settled, undefined);
    } finally { db.close(); }
  });
}

for (const kind of ['savepoint', 'transaction'] as const) test(`${kind}: refuse execution if observation ended the original parent`, () => {
  const db = new DatabaseSync(':memory:'); let armed = true, calls = 0;
  db.exec('CREATE TABLE facts(id INTEGER); BEGIN; INSERT INTO facts VALUES(1)');
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    if (armed) { armed = false; db.exec('ROLLBACK'); }
    return performance.now();
  });
  try {
    const body = () => { calls++; db.exec('INSERT INTO facts VALUES(2)'); };
    if (kind === 'savepoint') assert.throws(() => observedSavepoint(db, 'hub-identity-change', body, diagnostics));
    else assert.throws(() => observedTransaction(db, 'turn-queue-change', body, diagnostics, true));
    assert.equal(armed, false); assert.equal(calls, 0); assert.equal(db.isTransaction, false);
    assert.deepEqual(db.prepare('SELECT id FROM facts').all(), []);
    const failure = diagnostics.snapshot().events.find(e => e.phase === 'finished')!;
    assert.equal(failure.step, 1); assert.equal(failure.settled, undefined);
    assert.equal(failure.rollbackMs, undefined);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});

for (const kind of ['savepoint', 'transaction'] as const) test(`${kind}: refuse if inner observation invalidated the original outer participant`, () => {
  const db = new DatabaseSync(':memory:'); let calls = 0, armed = true;
  const quiet = new PerformanceDiagnostics(() => {});
  db.exec('CREATE TABLE facts(id INTEGER)');
  try {
    assert.throws(() => observedTransaction(db, 'turn-queue-change', (_commit, inspect) => {
      db.exec('INSERT INTO facts VALUES(1)');
      const diagnostics = new PerformanceDiagnostics(() => {}, () => {
        if (armed) { armed = false; assert.throws(() => inspect(Promise.resolve())); }
        return performance.now();
      });
      const body = () => { calls++; db.exec('INSERT INTO facts VALUES(2)'); };
      if (kind === 'savepoint') assert.throws(() => observedSavepoint(db, 'hub-identity-change', body, diagnostics));
      else assert.throws(() => observedTransaction(db, 'turn-queue-change', body, diagnostics, true));
      const failure = diagnostics.snapshot().events.find(e => e.phase === 'finished')!;
      assert.equal(failure.step, 1); assert.equal(failure.nested, 1);
      assert.equal(failure.rollbackMs, undefined); assert.equal(failure.settled, undefined);
    }, quiet));
    assert.equal(armed, false); assert.equal(calls, 0); assert.equal(db.isTransaction, false);
    assert.deepEqual(db.prepare('SELECT id FROM facts').all(), []);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});
