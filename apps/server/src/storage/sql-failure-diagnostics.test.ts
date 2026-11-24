import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from './sql-failure-diagnostics.js';

test('native SQL error exposes only allowlisted numeric evidence, not SQL or error text', () => {
  const db = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  try {
    let failure: unknown;
    try { db.exec('SELECT private_missing_column FROM private_missing_table'); } catch (error) { failure = error; }
    const trace = diagnostics.start('storage-admission'); addSqlFailure(trace, failure); trace.finish(true);
    const row = diagnostics.snapshot().events[0]!;
    assert.equal(row.sqlErrorCode, 1); assert.equal(row.classificationUnknown, undefined);
    assert.doesNotMatch(JSON.stringify(row), /private_|SELECT|sqlite|ERR_/);
  } finally { db.close(); }
});

test('fault classification never invokes getters, inherited fields, proxy traps or numeric coercion', () => {
  let touched = 0;
  const getter = Object.defineProperties({}, {
    code: { get() { touched++; throw Error('private-code'); } },
    errcode: { get() { touched++; throw Error('private-number'); } },
  });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { touched++; throw Error('private-proxy'); } });
  const coercible = { valueOf() { touched++; return 5; } };
  for (const error of [getter, proxy, Object.create({ code: 'ERR_SQLITE_ERROR', errcode: 5 }),
    { code: 'ERR_SQLITE_ERROR', errcode: coercible }, { code: 'ERR_SQLITE_ERROR', errcode: '5' },
    ...[0, -1, 0x10000, NaN, Infinity, 1.5].map(errcode => ({ code: 'ERR_SQLITE_ERROR', errcode })), null, 'private-text']) {
    const diagnostics = new PerformanceDiagnostics(() => {}), trace = diagnostics.start('storage-admission');
    addSqlFailure(trace, error); trace.finish(true);
    const row = diagnostics.snapshot().events[0]!;
    assert.equal(row.sqlErrorCode, undefined); assert.equal(row.classificationUnknown, 1);
    assert.doesNotMatch(JSON.stringify(row), /private-|ERR_/);
  }
  assert.equal(touched, 0);
});

test('rollback result has separate numeric evidence even when log delivery fails', () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); });
  const trace = diagnostics.start('storage-admission');
  addSqlFailure(trace, { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  addSqlFailure(trace, { code: 'ERR_SQLITE_ERROR', errcode: 10 }, 'rollbackErrorCode'); trace.finish(true);
  const row = diagnostics.snapshot().events[0]!;
  assert.equal(row.sqlErrorCode, 5); assert.equal(row.rollbackErrorCode, 10); assert.equal(row.delivery, 'failed');
});
