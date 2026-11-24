import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

// Diagnostic methods are observations, never authority to replay SQL, change
// admission deadlines, replace the native handle or resume the stale caller.
for (const method of ['start', 'add', 'finish'] as const) {
  for (const outcome of ['recovered', 'rollback-failed', 'invalid-clock'] as const) {
    test(`recovery ${outcome} survives diagnostic ${method} failure`, () => {
      const raw = new DatabaseSync(':memory:'), logs: unknown[] = [];
      const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
      let now = 0, broken = true, observe = false, observations = 0, rollbacks = 0;
      const reentryErrors: unknown[] = [];
      const db = recoverableConnection(raw, diagnostics, () => now), exec = db.exec.bind(db);
      const start = diagnostics.start.bind(diagnostics);
      diagnostics.start = operation => {
        if (operation !== 'storage-connection-recovery' || !observe) return start(operation);
        const fail = () => {
          observations++;
          for (const work of [() => db.exec('ROLLBACK'), () => db.prepare('INSERT INTO facts VALUES(2)'), () => db.close()]) {
            try { work(); reentryErrors.push(undefined); } catch (error) { reentryErrors.push(error); }
          }
          throw Error('private-observer-failure');
        };
        if (method === 'start') return fail();
        const trace = start(operation);
        if (method === 'add') trace.add = fail;
        else trace.finish = fail;
        return trace;
      };
      try {
        db.exec('CREATE TABLE facts(value INTEGER); BEGIN; INSERT INTO facts VALUES(1)');
        const cached = db.prepare('SELECT value FROM facts');
        db.exec = sql => { if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-rollback'); } exec(sql); };
        assert.throws(() => db.exec('ROLLBACK'), /private-rollback/);
        observe = true;
        broken = outcome !== 'recovered';
        if (outcome === 'invalid-clock') now = NaN;
        assert.throws(() => cached.all(), StorageConnectionUnavailable);
        assert.ok(observations > 0, 'fault must actually run');
        assert.equal(rollbacks, outcome === 'invalid-clock' ? 1 : 2);
        assert.deepEqual(connectionRecoverySnapshot(db), {
          state: outcome === 'recovered' ? 'ready' : 'owner-rollback-required',
          attempts: outcome === 'invalid-clock' ? 0 : 1,
        });
        assert.equal(raw.isTransaction, outcome !== 'recovered');
        if (outcome !== 'recovered') {
          // Leave the observer broken while checking the original cooldown and
          // later recovery. Teardown restoration must not hide a stuck guard.
          now = outcome === 'invalid-clock' ? 0 : 999;
          if (outcome === 'rollback-failed') {
            assert.throws(() => cached.all(), StorageConnectionUnavailable);
            assert.equal(rollbacks, 2, 'diagnostics cannot erase cooldown');
            now = 1000;
          }
          broken = false;
          assert.throws(() => cached.all(), StorageConnectionUnavailable);
          assert.equal(connectionRecoverySnapshot(db).state, 'ready');
        }
        assert.deepEqual(cached.all(), []);
        db.exec('INSERT INTO facts VALUES(3)');
        assert.deepEqual(cached.all().map(row => row.value), [3]);
        assert.equal(reentryErrors.length, observations * 3);
        assert.ok(reentryErrors.every(error => error instanceof StorageConnectionUnavailable), 'observer cannot reopen SQL or cleanup admission');
        assert.doesNotMatch(JSON.stringify(logs), /private|facts|INSERT|SELECT|ROLLBACK/);
      } finally { db.close(); }
    });
  }
}
