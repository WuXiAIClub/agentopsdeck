import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const invalid = [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER, undefined, null, '1000', {}];
for (const [index, sample] of invalid.entries()) test(`invalid recovery sample ${index} preserves original fence and cooldown`, () => {
  const raw = new DatabaseSync(':memory:');
  let now: unknown = 0, broken = true, rollbacks = 0;
  const rows: unknown[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const db = recoverableConnection(raw, diagnostics, () => now as number), exec = db.exec.bind(db);
  try {
    db.exec('CREATE TABLE facts(value INTEGER); BEGIN; INSERT INTO facts VALUES(1)');
    db.exec = sql => { if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-rollback'); } exec(sql); };
    assert.throws(() => db.exec('ROLLBACK'), /private-rollback/);
    assert.throws(() => db.prepare('SELECT * FROM facts'), StorageConnectionUnavailable);
    assert.deepEqual(connectionRecoverySnapshot(db), { state: 'owner-rollback-required', attempts: 1 });
    now = sample;
    for (let i = 0; i < 2; i++) assert.throws(() => db.prepare('SELECT * FROM facts'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 2, 'invalid samples cannot authorize cleanup');
    assert.deepEqual(connectionRecoverySnapshot(db), { state: 'owner-rollback-required', attempts: 1 });
    assert.equal(raw.isTransaction, true);
    broken = false; now = 999;
    assert.throws(() => db.prepare('SELECT * FROM facts'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 2, 'last original valid deadline must be retained');
    now = 1000;
    assert.throws(() => db.prepare('SELECT * FROM facts'), StorageConnectionUnavailable, 'successful rollback cannot resume a stale request');
    assert.equal(rollbacks, 3); assert.equal(raw.isTransaction, false);
    assert.deepEqual(db.prepare('SELECT * FROM facts').all(), [], 'no abandoned write replay');
    const deferred = diagnostics.snapshot().events.filter(row => row.operation === 'storage-connection-recovery' && row.deferred === 1);
    assert.equal(deferred.length, 2); assert.ok(deferred.every(row => row.classificationUnknown === 1 && row.unknown === 1));
    assert.doesNotMatch(JSON.stringify(rows), /private|facts|SELECT|ROLLBACK/);
  } finally { db.close(); }
});

for (const throwing of [false, true]) test(`unusable recovery clock before first attempt is sanitized; throws=${throwing}`, () => {
  const raw = new DatabaseSync(':memory:'); let calls = 0, rollbacks = 0, valid = false;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const value = { valueOf() { calls++; throw Error('private-value'); }, get then() { calls++; throw Error('private-getter'); } };
  const db = recoverableConnection(raw, diagnostics, () => {
    if (valid) return 0;
    if (throwing) throw Error('private-clock');
    return value as unknown as number;
  }), exec = db.exec.bind(db);
  try {
    db.exec('BEGIN');
    db.exec = sql => { if (sql === 'ROLLBACK') { rollbacks++; throw Error('private-cleanup'); } exec(sql); };
    assert.throws(() => db.exec('ROLLBACK'));
    for (let i = 0; i < 2; i++) assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(calls, 0); assert.equal(rollbacks, 1);
    assert.deepEqual(connectionRecoverySnapshot(db), { state: 'owner-rollback-required', attempts: 0 });
    valid = true; db.exec = exec;
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    assert.equal(db.prepare('SELECT 1 n').get()!.n, 1);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|valueOf|getter/);
  } finally { db.close(); }
});

test('invalid admission clock cannot remove explicit original-owner rollback authority', () => {
  const raw = new DatabaseSync(':memory:');
  const db = recoverableConnection(raw, new PerformanceDiagnostics(() => {}), () => NaN), exec = db.exec.bind(db);
  try {
    db.exec('BEGIN'); db.exec = () => { throw Error('private-cleanup'); };
    assert.throws(() => db.exec('ROLLBACK'));
    db.exec = exec; db.exec('ROLLBACK');
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    assert.equal(db.prepare('SELECT 1 n').get()!.n, 1);
  } finally { db.close(); }
});

for (const failedSink of [false, true]) test(`invalid clock diagnosis cannot reenter original cleanup; failed sink=${failedSink}`, () => {
  const raw = new DatabaseSync(':memory:'); let observe = false, observations = 0, rollbacks = 0;
  const diagnostics = new PerformanceDiagnostics(() => {
    if (!observe) return;
    observations++;
    for (const work of [() => db.exec('ROLLBACK'), () => db.prepare('SELECT 1'), () => db.close()]) {
      assert.throws(work, StorageConnectionUnavailable);
    }
    if (failedSink) throw Error('private-sink');
  });
  const db = recoverableConnection(raw, diagnostics, () => NaN), exec = db.exec.bind(db);
  try {
    db.exec('BEGIN');
    db.exec = sql => { if (sql === 'ROLLBACK') { rollbacks++; throw Error('private-cleanup'); } exec(sql); };
    assert.throws(() => db.exec('ROLLBACK'));
    observe = true;
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(observations, 1); assert.equal(rollbacks, 1); assert.equal(raw.isTransaction, true);
    assert.deepEqual(connectionRecoverySnapshot(db), { state: 'owner-rollback-required', attempts: 0 });
    const row = diagnostics.snapshot().events.at(-1)!;
    assert.equal(row.deferred, 1); assert.equal(row.delivery, failedSink ? 'failed' : 'delivered');
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private/);
  } finally { observe = false; db.close(); }
});
