import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const failedSink of [false, true]) {
  for (const [table, step] of [['shared_auth_credentials', 1], ['shared_auth_sessions', 3]] as const) {
    test(`original SQL read failure remains numeric and fail-closed: step=${step}, failed sink=${failedSink}`, () => {
      const db = new DatabaseSync(':memory:'), lines: string[] = [];
      const diagnostics = new PerformanceDiagnostics(line => {
        if (failedSink) throw Error('private-sink');
        lines.push(line);
      });
      try {
        const store = new SqlitePasskeys(db, () => 'a'.repeat(24), () => 100, diagnostics);
        db.exec(`DROP TABLE ${table}`);
        if (step === 1) assert.throws(() => store.status(), AuthPersistenceError);
        else assert.equal(store.sessionAuthorized('a'.repeat(43)), false);
        const row = diagnostics.snapshot().events.find(row => row.operation === 'auth-passkey-read');
        assert.ok(row); assert.equal(row.step, step); assert.equal(row.sqlErrorCode, 1);
        assert.equal(row.category, 'failed'); assert.equal(row.delivery, failedSink ? 'failed' : 'delivered');
        assert.equal(db.isTransaction, false);
        assert.doesNotMatch(JSON.stringify({ lines, snapshot: diagnostics.snapshot() }), /SELECT|shared_auth_|no such table|private-sink|aaaa/);
      } finally { db.close(); }
    });
  }
}

test('unknown read failures never execute own getters or proxy traps and cannot grant authority', () => {
  let touched = 0;
  const getter = Object.defineProperties({}, {
    code: { get() { touched++; throw Error('private-code'); } },
    errcode: { get() { touched++; throw Error('private-number'); } },
  });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { touched++; throw Error('private-proxy'); } });
  for (const failure of [getter, proxy]) {
    const db = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
    try {
      const store = new SqlitePasskeys(db, () => 'a'.repeat(24), () => 100, diagnostics);
      db.prepare = () => { throw failure; };
      assert.throws(() => store.status(), AuthPersistenceError);
      assert.equal(store.sessionAuthorized('a'.repeat(43)), false);
      const rows = diagnostics.snapshot().events;
      assert.deepEqual(rows.map(row => row.step), [1, 3]);
      assert.ok(rows.every(row => row.classificationUnknown === 1 && row.sqlErrorCode === undefined));
      assert.doesNotMatch(JSON.stringify(rows), /private-|aaaa/);
    } finally { db.close(); }
  }
  assert.equal(touched, 0);
});
