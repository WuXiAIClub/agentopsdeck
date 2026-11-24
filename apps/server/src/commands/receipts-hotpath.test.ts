import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCommandKey } from '@agentopsdeck/shared';
import { CommandConflict, CommandReceipts } from './receipts.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

test('receipt hot path reuses SQL, reads authority once under lock and excludes opaque binding data', () => {
  const db = new DatabaseSync(':memory:'), prepares = new Map<string, number>();
  const reads: Array<{ sql: string; columns: string[] }> = [];
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    prepares.set(sql, (prepares.get(sql) ?? 0) + 1);
    const statement = prepare(sql), get = statement.get.bind(statement);
    statement.get = (...args) => {
      const row = Reflect.apply(get, statement, args) as ReturnType<typeof get>;
      reads.push({ sql, columns: Object.keys(row ?? {}) }); return row;
    };
    return statement;
  };
  let admissions = 0, callbacks = 0;
  const receipts = new CommandReceipts(db, undefined, undefined, undefined,
    (_bytes, write) => { admissions++; return write(); }, new PerformanceDiagnostics(() => {}));
  const scope = 'private-scope', key = createCommandKey(randomUUID(), Date.now());
  const admit = () => { callbacks++; return true; };
  try {
    const first = receipts.claim(scope, key, { b: 2, a: 1 }, true, 7, admit,
      () => ({ metadata: { private: 'x'.repeat(7000) } }));
    const result = { status: 200, body: { private: 'y'.repeat(60_000) } };
    receipts.settle(scope, key, result);
    const before = new Map(prepares);
    reads.length = 0;
    const duplicate = receipts.claim(scope, key, { a: 1, b: 2 }, true, 7, admit);
    assert.equal(duplicate.fresh, false); assert.equal(duplicate.receipt.id, first.receipt.id);
    assert.deepEqual(duplicate.receipt.result, result);
    assert.equal(admissions, 1); assert.equal(callbacks, 1);
    assert.equal(reads.length, 2, 'one lightweight preflight and one locked receipt read');
    assert.match(reads[0]!.sql, /^SELECT 1 FROM command_receipts/);
    assert.deepEqual(reads[0]!.columns, ['1']);
    assert.ok(reads[1]!.columns.includes('authority_id'));
    for (const column of ['binding_json', 'retained_bytes', 'delivery_key', 'native_runtime']) {
      assert.ok(!reads[1]!.columns.includes(column), column);
    }
    assert.throws(() => receipts.claim(scope, key, { a: 1, b: 2 }, true, 8, admit), /authority cannot change/);
    assert.throws(() => receipts.claim(scope, key, { a: 2 }, true, 7, admit), /different content/);
    assert.equal(callbacks, 1);
    for (let i = 0; i < 4; i++) {
      const next = createCommandKey(randomUUID(), Date.now());
      receipts.claim(scope, next, {}); receipts.settle(scope, next, { status: 400, body: { error: 'private error' } });
      assert.equal(receipts.get(scope, next)?.state, 'rejected');
    }
    assert.deepEqual(prepares, before, 'SQL prepare count is fixed after construction on normal admission/settlement');
    const lookup = reads.find(read => read.sql.startsWith('SELECT id, command_key'))!.sql;
    const plan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${lookup}`).all(scope, key));
    assert.match(plan, /SEARCH.*sqlite_autoindex_command_receipts/); assert.doesNotMatch(plan, /SCAN/);
    // SQL reuse must never turn into a cache of facts from a transaction.
    db.exec('BEGIN IMMEDIATE');
    prepare('UPDATE command_receipts SET result = ? WHERE scope = ? AND command_key = ?')
      .run(JSON.stringify({ status: 200, body: { current: true } }), scope, key);
    assert.deepEqual(receipts.get(scope, key)?.result?.body, { current: true });
    db.exec('ROLLBACK'); assert.deepEqual(receipts.get(scope, key)?.result, result);
    const other = new DatabaseSync(':memory:');
    try {
      const isolated = new CommandReceipts(other, undefined, undefined, undefined, undefined, new PerformanceDiagnostics(() => {}));
      assert.equal(isolated.get(scope, key), undefined);
      isolated.claim(scope, key, {}); assert.equal(isolated.get(scope, key)?.state, 'outcome_unknown');
      assert.equal(receipts.get(scope, key)?.state, 'accepted');
    } finally { other.close(); }
  } finally { db.close(); }
});

test('receipt claim and settlement diagnostics preserve failures, rollback freshness and caller ownership', () => {
  const db = new DatabaseSync(':memory:'), logs: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined, diagnostics);
  const scope = 'private-scope', payload = { text: 'private-content' };
  try {
    receipts.claim(scope, 'one', payload);
    assert.equal(logs.at(-1).operation, 'command-receipt-claim'); assert.equal(logs.at(-1).settled, 1);
    db.exec('BEGIN IMMEDIATE');
    receipts.settle(scope, 'one', { status: 200, body: { secret: 'private-result' } });
    const changed = logs.at(-1);
    assert.equal(changed.operation, 'command-receipt-settle'); assert.equal(changed.changed, 1);
    assert.equal(changed.settled, undefined); assert.equal(changed.rollbackMs, undefined);
    assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
    assert.equal(receipts.get(scope, 'one')?.state, 'outcome_unknown');
    receipts.settle(scope, 'one', { status: 503, body: { error: 'private-uncertain' } });
    assert.equal(logs.at(-1).deferred, 1); assert.equal(logs.at(-1).changed, undefined);
    receipts.settle(scope, 'one', { status: 200, body: { tooLarge: 'x'.repeat(65_536) } });
    assert.equal(logs.at(-1).deferred, 1); assert.equal(receipts.get(scope, 'one')?.state, 'outcome_unknown');
    db.exec(`CREATE TRIGGER fail_settlement BEFORE UPDATE OF result ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END; BEGIN IMMEDIATE;`);
    assert.throws(() => receipts.settle(scope, 'one', { status: 200, body: {} }), /private SQL failure/);
    assert.equal(logs.at(-1).category, 'failed'); assert.equal(logs.at(-1).changed, undefined);
    assert.equal(logs.at(-1).settled, undefined); assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK; DROP TRIGGER fail_settlement');
    receipts.settle(scope, 'one', { status: 200, body: { ok: true } });
    receipts.settle(scope, 'one', { status: 400, body: {} }); assert.equal(logs.at(-1).changed, 0);
    assert.equal(receipts.get(scope, 'one')?.state, 'accepted');
    const failure = new Error('private binding failure');
    assert.throws(() => receipts.claim(scope, 'two', payload, false, undefined, undefined,
      () => { throw failure; }), error => error === failure);
    assert.equal(logs.at(-1).operation, 'command-receipt-claim'); assert.equal(logs.at(-1).category, 'failed');
    assert.equal(typeof logs.at(-1).rollbackMs, 'number'); assert.equal(db.isTransaction, false);
    assert.equal(receipts.get(scope, 'two'), undefined);
    receipts.claim(scope, 'two', payload);
    assert.throws(() => receipts.claim(scope, 'two', {}), CommandConflict);
    assert.equal(logs.at(-1).category, 'failed');
    for (const row of logs) assert.equal(typeof row.bodyMs, 'number');
    assert.doesNotMatch(JSON.stringify(logs), /private|SELECT|UPDATE|INSERT|"two"|"one"/);
    // A sink exception is never authority to retry or to roll back a caller.
    const broken = new CommandReceipts(db, undefined, undefined, undefined, undefined,
      new PerformanceDiagnostics(() => { throw Error('private sink failure'); }));
    assert.equal(broken.claim(scope, 'three', {}).fresh, true);
    assert.equal(broken.settle(scope, 'three', { status: 200, body: {} }).state, 'accepted');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});
