import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import { observedTransaction } from './observed-transaction.js';
import { observedSavepoint } from './observed-savepoint.js';
import { recoverableConnection, connectionRecoverySnapshot } from './connection-recovery.js';

type Fault = 'start' | 'finish' | Parameters<PerformanceTrace['add']>[0];
function diagnosticsWithFault(fault: Fault) {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const start = diagnostics.start.bind(diagnostics);
  let faults = 0;
  diagnostics.start = operation => {
    if (fault === 'start') { faults++; throw Error('private-observer-start'); }
    const trace = start(operation);
    return {
      add(metric, value) {
        if (fault === metric) { faults++; throw Error('private-observer-add'); }
        trace.add(metric, value);
      },
      reportPending: snapshot => trace.reportPending(snapshot),
      finish(failed) {
        if (fault === 'finish') { faults++; throw Error('private-observer-finish'); }
        trace.finish(failed);
      },
    };
  };
  return { diagnostics, faults: () => faults };
}

for (const boundary of ['transaction', 'savepoint'] as const) {
  const run = <T>(db: DatabaseSync, work: () => T, diagnostics: PerformanceDiagnostics) =>
    boundary === 'transaction'
      ? observedTransaction(db, 'turn-queue-change', work as () => T extends PromiseLike<unknown> ? never : T, diagnostics, true)
      : observedSavepoint(db, 'hub-identity-change', work as () => T extends PromiseLike<unknown> ? never : T, diagnostics);

  for (const nested of [false, true]) for (const fault of ['start', 'nested', 'beginMs', 'bodyMs', 'commitMs', 'settled', 'finish'] as const) {
    test(`${boundary} preserves successful settlement with ${fault} failure (nested=${nested})`, () => {
      const db = new DatabaseSync(':memory:');
      const observer = diagnosticsWithFault(fault);
      let calls = 0;
      db.exec('CREATE TABLE facts(n);');
      if (nested) db.exec('BEGIN; INSERT INTO facts VALUES(1)');
      try {
        assert.equal(run(db, () => { calls++; db.exec('INSERT INTO facts VALUES(2)'); return 42; }, observer.diagnostics), 42);
        assert.equal(calls, 1);
        assert.ok(observer.faults() > 0, 'requested diagnostic fault reached');
        assert.equal(db.isTransaction, nested);
        assert.deepEqual(db.prepare('SELECT n FROM facts ORDER BY n').all().map(row => row.n), nested ? [1, 2] : [2]);
        if (nested) {
          db.exec('ROLLBACK');
          assert.deepEqual(db.prepare('SELECT n FROM facts').all(), []);
        }
      } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
    });
  }

  for (const nested of [false, true]) for (const fault of ['step', 'sqlErrorCode', 'classificationUnknown', 'rollbackMs', 'finish'] as const) {
    test(`${boundary} preserves original failure and rollback with ${fault} failure (nested=${nested})`, () => {
      const db = new DatabaseSync(':memory:');
      const observer = diagnosticsWithFault(fault);
      const original = fault === 'classificationUnknown' ? Error('private-body')
        : Object.assign(Error('private-body'), { code: 'ERR_SQLITE_ERROR', errcode: 19 });
      let calls = 0;
      db.exec('CREATE TABLE facts(n)');
      if (nested) db.exec('BEGIN; INSERT INTO facts VALUES(1)');
      try {
        assert.throws(() => run(db, () => { calls++; db.exec('INSERT INTO facts VALUES(2)'); throw original; }, observer.diagnostics), error => error === original);
        assert.equal(calls, 1);
        assert.ok(observer.faults() > 0, 'requested diagnostic fault reached');
        assert.equal(db.isTransaction, nested);
        assert.deepEqual(db.prepare('SELECT n FROM facts').all().map(row => row.n), nested ? [1] : []);
        const event = observer.diagnostics.snapshot().events.find(item => item.phase === 'finished');
        if (event) {
          assert.equal(event.unknown, undefined);
          assert.equal(event.rollbackFailed, undefined);
        }
      } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
    });
  }

  for (const nested of [false, true]) for (const fault of ['rollbackErrorCode', 'rollbackFailed', 'unknown', 'finish'] as const) {
    test(`${boundary} retains original cleanup fence with ${fault} failure (nested=${nested})`, () => {
      const raw = new DatabaseSync(':memory:');
      const db = recoverableConnection(raw);
      const observer = diagnosticsWithFault(fault);
      const original = Error('private-body');
      const nativeExec = db.exec.bind(db);
      let rollbacks = 0, calls = 0;
      db.exec('CREATE TABLE facts(n)');
      if (nested) db.exec('BEGIN; INSERT INTO facts VALUES(1)');
      db.exec = sql => {
        if (sql.startsWith('ROLLBACK')) {
          rollbacks++;
          throw Object.assign(Error('private-cleanup'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
        }
        nativeExec(sql);
      };
      try {
        assert.throws(() => run(db, () => { calls++; db.exec('INSERT INTO facts VALUES(2)'); throw original; }, observer.diagnostics), error => error === original);
        assert.equal(calls, 1); assert.equal(rollbacks, 1);
        assert.ok(observer.faults() > 0, 'requested diagnostic fault reached');
        assert.equal(raw.isTransaction, true);
        assert.equal(connectionRecoverySnapshot(db).state, nested ? 'parent-rollback-required' : 'owner-rollback-required');
        assert.equal(connectionRecoverySnapshot(db).attempts, 0);
      } finally { raw.exec('ROLLBACK'); raw.close(); }
    });
  }
}
