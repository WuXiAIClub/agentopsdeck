import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { StorageWorkAdmission } from './work-admission.js';
import { recoverableConnection, connectionRecoverySnapshot } from './connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const kind of ['sample', 'clock'] as const) {
  test(`ledger ${kind} escape rolls back before retiring and refuses late SQL`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    let release!: () => void, late: Promise<unknown> | undefined, calls = 0, fenced = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    db.exec('CREATE TABLE facts(id INTEGER)');
    const diagnostics = new PerformanceDiagnostics(() => {});
    const escaped = () => {
      calls++;
      late = (async () => {
        db.exec('INSERT INTO facts VALUES(1)'); await waiting;
        try { db.exec('INSERT INTO facts VALUES(2)'); } catch { fenced = true; }
        return kind === 'sample' ? { freeBytes: 1_000_000_000n, observedAt: 1000 } : 1000;
      })(); return late;
    };
    const owner = new StorageWorkAdmission(db, (kind === 'clock' ? escaped : () => 1000) as unknown as () => number, diagnostics);
    try {
      assert.throws(() => owner.reserve('private-volume', 'private-request', 'recovery', 1,
        (kind === 'sample' ? escaped : { freeBytes: 1_000_000_000n, observedAt: 1000 }) as unknown as { freeBytes: bigint; observedAt: number }));
      assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM facts').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => owner.reserve('private-volume', 'next', 'recovery', 1,
        { freeBytes: 1_000_000_000n, observedAt: 1000 }));
      assert.equal(calls, 1);
      const failure = diagnostics.snapshot().events.find(e => e.phase === 'finished')!;
      assert.equal(failure.category, 'failed'); assert.equal(failure.step, 2);
      assert.equal(failure.unknown, 1); assert.equal(failure.settled, undefined);
      assert.equal(typeof failure.rollbackMs, 'number');
      assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-|facts/);
      release(); await late; assert.equal(fenced, true);
      assert.deepEqual(raw.prepare('SELECT * FROM facts').all(), []);
    } finally { release(); await late; db.close(); }
  });

  for (const bad of ['thenable', 'throwing-then'] as const) {
    test(`ledger ${kind} refuses ${bad} without invoking its continuation`, () => {
      const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
      let invoked = 0;
      const value = bad === 'thenable' ? { then() { invoked++; } }
        : Object.defineProperty({}, 'then', { get() { throw Error('private-inspection'); } });
      const owner = new StorageWorkAdmission(db, (kind === 'clock' ? () => value : () => 1000) as unknown as () => number,
        new PerformanceDiagnostics(() => {}));
      try {
        assert.throws(() => owner.reserve('volume', 'request', 'recovery', 1,
          (kind === 'sample' ? () => value : { freeBytes: 1_000_000_000n, observedAt: 1000 }) as unknown as { freeBytes: bigint; observedAt: number }));
        assert.equal(invoked, 0); assert.equal(raw.isTransaction, false);
        assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      } finally { db.close(); }
    });
  }
}
