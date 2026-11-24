import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AuthAuditLog } from './security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot } from '../storage/connection-recovery.js';

const count = (db: DatabaseSync) => (db.prepare('SELECT count(*) AS n FROM hub_auth_audit').get() as { n: number }).n;

test('audit append rolls back its insert when original retention fails', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new AuthAuditLog(1, db);
    log.append({ event: 'api_authz', outcome: 'failure' });
    db.exec("CREATE TRIGGER refuse_audit_retention BEFORE DELETE ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-retention-fault'); END");
    assert.throws(() => log.append({ event: 'access_key_login', outcome: 'success' }));
    assert.equal((db.prepare('SELECT count(*) AS n FROM hub_auth_audit').get() as { n: number }).n, 1);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

for (const method of ['page', 'list'] as const) test(`audit ${method} restores retention on invalid stored record`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new AuthAuditLog(1, db);
    db.prepare('INSERT INTO hub_auth_audit (ts, record) VALUES (?, ?)').run(1, '{}');
    db.prepare('INSERT INTO hub_auth_audit (ts, record) VALUES (?, ?)').run(Date.now(), '{broken');
    assert.throws(() => log[method]());
    assert.equal((db.prepare('SELECT count(*) AS n FROM hub_auth_audit').get() as { n: number }).n, 2);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('audit successful nested append remains owned by original parent commit', () => {
  const db = new DatabaseSync(':memory:'), events: any[] = [];
  try {
    const log = new AuthAuditLog(10, db, new PerformanceDiagnostics(line => events.push(JSON.parse(line))));
    db.exec('BEGIN');
    const record = log.append({ event: 'member_key_issued', outcome: 'success', userId: 'fixture-user' });
    assert.equal(db.isTransaction, true); assert.equal(count(db), 1);
    assert.deepEqual(log.list(), [record]);
    const trace = events.find(row => row.operation === 'auth-audit-append');
    assert.ok(trace); assert.equal(trace.nested, 1); assert.equal(trace.settled, 0);
    db.exec('ROLLBACK'); assert.equal(count(db), 0);
  } finally { db.close(); }
});

test('caught nested retention failure rolls back only original audit savepoint', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new AuthAuditLog(1, db);
    log.append({ event: 'api_authz', outcome: 'failure' });
    db.exec("CREATE TABLE unrelated(value INTEGER); CREATE TRIGGER refuse_retention BEFORE DELETE ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-body'); END");
    db.exec('BEGIN; INSERT INTO unrelated VALUES(42)');
    assert.throws(() => log.append({ event: 'access_key_login', outcome: 'success' }));
    assert.equal(db.isTransaction, true); assert.equal(count(db), 1);
    assert.equal(db.prepare('SELECT value FROM unrelated').get()!.value, 42);
    db.exec('COMMIT'); assert.equal(count(db), 1);
  } finally { db.close(); }
});

for (const committed of [false, true]) test(`audit original RELEASE ACK loss is unknown, no replay (${committed})`, () => {
  const raw = new DatabaseSync(':memory:'), events: any[] = [];
  let writes = 0, enabled = false;
  const original = Error('PRIVATE_RELEASE_PATH_AND_TOKEN');
  const db = new Proxy(raw, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (enabled && sql === 'RELEASE auth_audit_append') {
        writes++; if (committed) target.exec(sql); throw original;
      }
      target.exec(sql);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const log = new AuthAuditLog(10, db, new PerformanceDiagnostics(line => events.push(JSON.parse(line))));
    enabled = true;
    assert.throws(() => log.append({ event: 'api_authz', outcome: 'failure' }), e => e === original);
    assert.equal(writes, 1); assert.equal(count(raw), Number(committed)); assert.equal(raw.isTransaction, false);
    const trace = events.find(row => row.operation === 'auth-audit-append');
    assert.equal(trace.unknown, 1); assert.equal(trace.category, 'failed');
    assert.equal(JSON.stringify(events).includes(original.message), false);
    enabled = false;
    assert.equal(log.list().length, Number(committed), 'read observes original outcome, never recreates append');
    assert.equal(writes, 1);
  } finally { raw.close(); }
});

test('audit initialization restores original metadata when retention fails', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new AuthAuditLog(10, db);
    db.exec("DELETE FROM hub_auth_audit_metadata; INSERT INTO hub_auth_audit(ts, record) VALUES(1, '{}'); CREATE TRIGGER refuse_retention BEFORE DELETE ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-retention'); END");
    assert.throws(() => new AuthAuditLog(10, db));
    assert.equal(db.prepare('SELECT count(*) AS n FROM hub_auth_audit_metadata').get()!.n, 0);
    assert.equal(count(db), 1); assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('audit keeps original retention, ordering, cursors and record schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new AuthAuditLog(3, db), records = [];
    for (let i = 0; i < 4; i++) records.push(log.append({ event: 'access_key_login', outcome: 'success', userId: 'fixture-user', failureCount: i }));
    assert.deepEqual(log.list(), records.slice(1));
    const page = log.page({ limit: 1, userId: 'fixture-user' });
    assert.deepEqual(page.records, [records[3]]); assert.equal(typeof page.nextCursor, 'string');
    const next = log.page({ limit: 1, userId: 'fixture-user', before: Number(page.nextCursor) });
    assert.deepEqual(next.records, [records[2]]); assert.equal(page.retentionDays, 90);
    assert.equal(page.maxRecords, 3); assert.equal(page.persistent, true); assert.equal(typeof page.startedAt, 'number');
    assert.deepEqual(log.list(0), []); assert.equal(count(db), 3);
  } finally { db.close(); }
});

for (const failing of [false, true]) test(`throwing audit diagnostic sink does not change SQL settlement (${failing})`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    const log = new AuthAuditLog(1, db, new PerformanceDiagnostics(() => { throw Error('PRIVATE_SINK_ERROR'); }));
    log.append({ event: 'api_authz', outcome: 'failure' });
    if (failing) db.exec("CREATE TRIGGER refuse_retention BEFORE DELETE ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-retention'); END");
    const append = () => log.append({ event: 'access_key_login', outcome: 'success' });
    if (failing) assert.throws(append); else assert.equal(append().event, 'access_key_login');
    assert.equal(count(db), 1); assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('failed audit rollback fences original owned connection and recovers only its rollback', () => {
  const raw = new DatabaseSync(':memory:'), events: any[] = [];
  const db = recoverableConnection(raw, new PerformanceDiagnostics(line => events.push(JSON.parse(line))), () => 1000);
  try {
    const log = new AuthAuditLog(1, db);
    log.append({ event: 'api_authz', outcome: 'failure' });
    db.exec("CREATE TRIGGER refuse_retention BEFORE DELETE ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-retention'); END");
    const originalExec = db.exec.bind(db);
    let rollbackAttempts = 0;
    db.exec = sql => { if (sql === 'ROLLBACK') { rollbackAttempts++; throw Error('PRIVATE_ROLLBACK'); } originalExec(sql); };
    assert.throws(() => log.append({ event: 'access_key_login', outcome: 'success' }));
    assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
    assert.equal(raw.isTransaction, true); assert.equal(rollbackAttempts, 1);
    db.exec = originalExec;
    assert.throws(() => log.list(), /Storage connection recovery required/,
      'the recovery-triggering request must abort, not continue after its original assumptions changed');
    assert.equal(raw.isTransaction, false); assert.equal(count(db), 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    assert.equal(log.list().length, 1);
    assert.equal(raw.isTransaction, false); assert.equal(count(db), 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
  } finally { db.close(); }
});
