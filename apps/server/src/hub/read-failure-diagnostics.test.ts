import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readDeliveryPage } from './delivery-page.js';
import { readSessionPreferences } from './preference-read.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const read = { owner: 'PRIVATE-owner', domains: [] };
function sqlError(db: DatabaseSync) {
  try { db.exec('SELECT * FROM PRIVATE_missing'); } catch (error) { return error; }
  throw Error('Expected fixture SQL failure');
}
for (const kind of ['page', 'preferences'] as const) test(`${kind} logs original numeric SQL code without changing snapshot ownership`, () => {
  const db = new DatabaseSync(':memory:'), logs = new PerformanceDiagnostics(() => {});
  try {
    assert.throws(() => kind === 'page' ? readDeliveryPage(db, read, logs) : readSessionPreferences(db, read.owner, logs));
    assert.equal(db.isTransaction, false);
    const row = logs.snapshot().events.find(row => row.operation === (kind === 'page' ? 'hub-delivery-read' : 'hub-preference-read'))!;
    assert.equal(row.sqlErrorCode, 1); assert.equal(row.step, 2); assert.equal(row.category, 'failed');
    assert.equal(row.settled, undefined);
    assert.doesNotMatch(JSON.stringify(logs.snapshot()), /PRIVATE|SELECT|hub_events|session_preferences/);
  } finally { db.close(); }
});

test('delivery rollback failure records both original codes while preserving the original facade fence', () => {
  const raw = new DatabaseSync(':memory:'), logs = new PerformanceDiagnostics(() => {});
  const db = recoverableConnection(raw, logs), exec = db.exec.bind(db), original = sqlError(raw);
  let rollbackCalls = 0;
  db.exec = sql => { if (sql === 'ROLLBACK') { rollbackCalls++; throw original; } exec(sql); };
  try {
    assert.throws(() => readDeliveryPage(db, read, logs), /^Error: hub_delivery_read_unavailable$/);
    assert.equal(rollbackCalls, 1);
    const row = logs.snapshot().events.find(row => row.operation === 'hub-delivery-read')!;
    assert.equal(row.sqlErrorCode, 1); assert.equal(row.rollbackErrorCode, 1);
    assert.equal(row.rollbackFailed, 1); assert.equal(row.unknown, 1); assert.equal(row.settled, undefined);
    assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
  } finally { db.close(); }
});

test('delivery nested read failure never rolls back the parent transaction', () => {
  const db = new DatabaseSync(':memory:'), logs = new PerformanceDiagnostics(() => {});
  db.exec('CREATE TABLE parent_fact(n); BEGIN; INSERT INTO parent_fact VALUES(7)');
  try {
    assert.throws(() => readDeliveryPage(db, read, logs), /^Error: hub_delivery_read_unavailable$/);
    assert.equal(db.isTransaction, true);
    assert.equal(db.prepare('SELECT n FROM parent_fact').get()!.n, 7);
    assert.equal(logs.snapshot().events.find(row => row.operation === 'hub-delivery-read')!.rollbackFailed, undefined);
    db.exec('ROLLBACK'); assert.deepEqual(db.prepare('SELECT n FROM parent_fact').all(), []);
  } finally { db.close(); }
});

for (const kind of ['page', 'preferences'] as const) for (const failure of ['getter', 'proxy'] as const)
test(`${kind} diagnostics never execute ${failure} exception properties or replay the read`, () => {
  const db = new DatabaseSync(':memory:'), logs = new PerformanceDiagnostics(() => {}); let inspected = 0, calls = 0;
  const error = failure === 'proxy' ? new Proxy({}, {
    get() { inspected++; throw Error('PRIVATE'); }, getOwnPropertyDescriptor() { inspected++; throw Error('PRIVATE'); },
  }) : Object.defineProperties({}, { code: { get() { inspected++; return 'ERR_SQLITE_ERROR'; } }, errcode: { get() { inspected++; return 1; } } });
  db.prepare = () => { calls++; throw error; };
  try {
    assert.throws(() => kind === 'page' ? readDeliveryPage(db, read, logs) : readSessionPreferences(db, read.owner, logs),
      caught => kind === 'page' ? caught instanceof Error && caught.message === 'hub_delivery_read_unavailable' : caught === error);
    assert.equal(inspected, 0); assert.equal(calls, 1); assert.equal(db.isTransaction, false);
    assert.equal(logs.snapshot().events[0]!.classificationUnknown, 1);
  } finally { db.close(); }
});

for (const kind of ['page', 'preferences'] as const) test(`${kind} diagnostics sink failure cannot replace original outcome or snapshot cleanup`, () => {
  const db = new DatabaseSync(':memory:'), original = sqlError(db);
  const logs = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  db.prepare = () => { throw original; };
  try {
    assert.throws(() => kind === 'page' ? readDeliveryPage(db, read, logs) : readSessionPreferences(db, read.owner, logs),
      caught => kind === 'page' ? caught instanceof Error && caught.message === 'hub_delivery_read_unavailable' : caught === original);
    assert.equal(db.isTransaction, false);
    assert.ok(logs.snapshot().events.some(row => row.sqlErrorCode === 1 && row.delivery === 'failed'));
  } finally { db.close(); }
});
