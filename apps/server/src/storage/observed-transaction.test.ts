import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedTransaction } from './observed-transaction.js';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';

function fixture(intercept: (sql: string, execute: () => void) => void = (_sql, execute) => execute()) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE facts (id INTEGER)');
  const sql: string[] = [], logs: any[] = [];
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'exec') return (statement: string) => {
        sql.push(statement); intercept(statement, () => target.exec(statement));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, proxy, sql, logs, diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))) };
}

for (const phase of ['begin', 'body', 'commit'] as const) {
  test(`numeric SQL failure evidence identifies ${phase} without copying errors or replaying work`, () => {
    const original = Object.assign(Error('/private/subject secret SQL'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    let calls = 0;
    const f = fixture((sql, execute) => {
      if (phase === 'begin' && sql === 'BEGIN IMMEDIATE' || phase === 'commit' && sql === 'COMMIT') throw original;
      execute();
    });
    try {
      assert.throws(() => observedTransaction(f.proxy, 'auth-login-change', () => {
        calls++; if (phase === 'body') throw original;
      }, f.diagnostics), error => error === original);
      assert.equal(calls, phase === 'begin' ? 0 : 1);
      assert.equal(f.logs[0].step, phase === 'begin' ? 1 : phase === 'body' ? 2 : 3);
      assert.equal(f.logs[0].sqlErrorCode, 5);
      assert.doesNotMatch(JSON.stringify(f.logs), /private|subject|secret|SQL/);
    } finally { f.db.close(); }
  });
}

test('rollback numeric error remains separate from the original transaction failure', () => {
  const original = Object.assign(Error('private original'), { code: 'ERR_SQLITE_ERROR', errcode: 19 });
  const rollback = Object.assign(Error('private cleanup'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  const f = fixture((sql, execute) => { if (sql === 'ROLLBACK') throw rollback; execute(); });
  try {
    assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', () => { throw original; }, f.diagnostics),
      error => error === original);
    assert.equal(f.logs[0].step, 2); assert.equal(f.logs[0].sqlErrorCode, 19);
    assert.equal(f.logs[0].rollbackErrorCode, 10); assert.equal(f.logs[0].unknown, 1);
    assert.equal(f.db.isTransaction, true);
    assert.doesNotMatch(JSON.stringify(f.logs), /private|original|cleanup/);
  } finally { f.db.close(); }
});

for (const mode of ['immediate', 'deferred'] as const) for (const executed of [false, true])
  test(`lost BEGIN ACK rolls back only owned work and never runs body (${mode}/${executed})`, () => {
    const original = Error('private-begin'), f = fixture((sql, execute) => {
      if (sql === (mode === 'deferred' ? 'BEGIN' : 'BEGIN IMMEDIATE')) { if (executed) execute(); throw original; }
      execute();
    });
    try {
      assert.throws(() => observedTransaction(f.proxy, 'auth-login-check', () => assert.fail('body ran'), f.diagnostics, false, mode), error => error === original);
      assert.equal(f.db.isTransaction, false);
      assert.deepEqual(f.sql, [mode === 'deferred' ? 'BEGIN' : 'BEGIN IMMEDIATE', ...(executed ? ['ROLLBACK'] : [])]);
      assert.equal(f.logs[0].unknown, 1);
    } finally { f.db.close(); }
  });

for (const nested of [false, true]) test(`automation transaction preserves its own savepoint and original failure (${nested})`, () => {
  const original = Error('original-body');
  const f = fixture((sql, execute) => { execute(); if (sql.startsWith('ROLLBACK')) throw Error('cleanup-report'); });
  try {
    if (nested) f.db.exec('BEGIN; INSERT INTO facts VALUES(1)');
    assert.throws(() => observedTransaction(f.proxy, 'automation-store-change', () => {
      f.db.exec('INSERT INTO facts VALUES(2)'); throw original;
    }, f.diagnostics, true), error => error === original);
    assert.equal(f.logs[0].rollbackFailed, 1); assert.equal(f.logs[0].unknown, 1);
    assert.equal(f.db.isTransaction, nested);
    if (nested) {
      assert.deepEqual(f.sql, ['SAVEPOINT automation_store', 'ROLLBACK TO automation_store; RELEASE automation_store']);
      assert.deepEqual(f.db.prepare('SELECT id FROM facts').all().map(row => row.id), [1]);
      f.db.exec('ROLLBACK');
    }
  } finally { f.db.close(); }
});
test('commit is observed exactly once; callbacks and writes are never replayed', () => {
  const f = fixture(); let calls = 0;
  try {
    const result = observedTransaction(f.proxy, 'turn-queue-change', () => {
      calls++; f.db.exec('INSERT INTO facts VALUES (1)'); return 42;
    }, f.diagnostics);
    assert.equal(result, 42); assert.equal(calls, 1);
    assert.deepEqual(f.sql, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(f.logs.length, 1); assert.equal(f.logs[0].settled, 1);
    for (const metric of ['beginMs', 'bodyMs', 'commitMs']) assert.equal(typeof f.logs[0][metric], 'number');
  } finally { f.db.close(); }
});

test('failed begin never invokes work or rolls back', () => {
  const failure = Error('begin');
  const f = fixture(sql => { if (sql === 'BEGIN IMMEDIATE') throw failure; });
  try {
    assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', () => assert.fail('work'), f.diagnostics), e => e === failure);
    assert.deepEqual(f.sql, ['BEGIN IMMEDIATE']); assert.equal(f.logs[0].category, 'failed');
  } finally { f.db.close(); }
});

test('outer transaction rejection leaves caller-owned writes and lock untouched', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (1)');
    assert.throws(() => observedTransaction(f.proxy, 'command-receipt-claim', () => assert.fail('work'), f.diagnostics), /owning database boundary/);
    assert.deepEqual(f.sql, []); assert.equal(f.db.isTransaction, true);
    f.db.exec('COMMIT'); assert.equal(f.db.prepare('SELECT count(*) AS n FROM facts').get()!.n, 1);
  } finally { f.db.close(); }
});

test('body failure rolls back, and failed rollback preserves original failure with uncertainty logs', () => {
  for (const broken of [false, true]) {
    const original = Error('body contains private data');
    const f = fixture((sql, execute) => { if (broken && sql === 'ROLLBACK') throw Error('cleanup'); execute(); });
    try {
      assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', () => {
        f.db.exec('INSERT INTO facts VALUES (1)'); throw original;
      }, f.diagnostics), e => e === original);
      assert.deepEqual(f.sql, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      assert.equal(f.logs[0].rollbackFailed, broken ? 1 : undefined);
      assert.equal(f.logs[0].unknown, broken ? 1 : undefined);
      assert.doesNotMatch(JSON.stringify(f.logs), /private|cleanup/);
      if (f.db.isTransaction) f.db.exec('ROLLBACK');
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM facts').get()!.n, 0);
    } finally { f.db.close(); }
  }
});

test('commit failure before or after SQL effect remains unknown without replay or spurious rollback', () => {
  for (const executed of [false, true]) {
    const original = Error('commit'); let calls = 0;
    const f = fixture((sql, execute) => {
      if (sql === 'COMMIT') { if (executed) execute(); throw original; } execute();
    });
    try {
      assert.throws(() => observedTransaction(f.proxy, 'command-receipt-claim', () => {
        calls++; f.db.exec('INSERT INTO facts VALUES (1)');
      }, f.diagnostics), e => e === original);
      assert.equal(calls, 1); assert.equal(f.logs[0].unknown, 1);
      assert.deepEqual(f.sql, executed ? ['BEGIN IMMEDIATE', 'COMMIT'] : ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM facts').get()!.n, Number(executed));
    } finally { f.db.close(); }
  }
});

test('explicit policy commit survives subsequent rejection and cannot be settled twice', () => {
  const f = fixture(), rejection = Error('expired');
  try {
    assert.throws(() => observedTransaction(f.proxy, 'command-receipt-claim', commit => {
      f.db.exec('INSERT INTO facts VALUES (1)'); commit(); throw rejection;
    }, f.diagnostics), e => e === rejection);
    assert.deepEqual(f.sql, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(f.logs[0].settled, 1); assert.equal(f.logs[0].unknown, undefined);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM facts').get()!.n, 1);
    assert.throws(() => observedTransaction(f.proxy, 'command-receipt-claim', commit => { commit(); commit(); }, f.diagnostics), /already attempted/);
  } finally { f.db.close(); }
});

test('nested success releases savepoint but does not claim durable settlement', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (1)');
    observedTransaction(f.proxy, 'turn-queue-change', () => f.db.exec('INSERT INTO facts VALUES (2)'), f.diagnostics, true);
    assert.deepEqual(f.sql, ['SAVEPOINT turn_batch_claim', 'RELEASE turn_batch_claim']);
    assert.equal(f.logs[0].nested, 1); assert.equal(f.logs[0].settled, 0); assert.equal(f.db.isTransaction, true);
    f.db.exec('ROLLBACK'); assert.equal(f.db.prepare('SELECT count(*) AS n FROM facts').get()!.n, 0);
  } finally { f.db.close(); }
});

test('nested body failure removes only inner writes, keeping caller transaction active', () => {
  const f = fixture(), original = Error('body');
  try {
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (1)');
    assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', () => {
      f.db.exec('INSERT INTO facts VALUES (2)'); throw original;
    }, f.diagnostics, true), e => e === original);
    assert.deepEqual(f.sql, ['SAVEPOINT turn_batch_claim', 'ROLLBACK TO turn_batch_claim; RELEASE turn_batch_claim']);
    assert.equal(f.db.isTransaction, true); f.db.exec('COMMIT');
    assert.deepEqual(f.db.prepare('SELECT id FROM facts').all().map(r => r.id), [1]);
  } finally { f.db.close(); }
});

test('failed savepoint acquisition never rolls back caller transaction', () => {
  const original = Error('savepoint');
  const f = fixture((sql, execute) => { if (sql.startsWith('SAVEPOINT')) throw original; execute(); });
  try {
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (1)');
    assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', () => assert.fail('work'), f.diagnostics, true), e => e === original);
    assert.deepEqual(f.sql, ['SAVEPOINT turn_batch_claim']); assert.equal(f.db.isTransaction, true);
    f.db.exec('COMMIT');
  } finally { f.db.close(); }
});

test('lost release confirmation preserves original failure and caller ownership', () => {
  const original = Error('release');
  const f = fixture((sql, execute) => { execute(); if (sql === 'RELEASE turn_batch_claim') throw original; });
  try {
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO facts VALUES (1)');
    assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', () => {
      f.db.exec('INSERT INTO facts VALUES (2)');
    }, f.diagnostics, true), e => e === original);
    assert.equal(f.logs[0].unknown, 1); assert.equal(f.logs[0].rollbackFailed, 1);
    assert.equal(f.db.isTransaction, true); f.db.exec('ROLLBACK');
  } finally { f.db.close(); }
});

test('receipt claim preserves binding failure when rollback also fails, with no binding replay', () => {
  const original = Error('binding'), f = fixture((sql, execute) => {
    if (sql === 'ROLLBACK') throw Error('rollback'); execute();
  });
  let bindings = 0;
  try {
    const receipts = new CommandReceipts(f.proxy);
    assert.throws(() => receipts.claim('scope', 'key', {}, false, undefined, undefined, () => {
      bindings++; throw original;
    }), e => e === original);
    assert.equal(bindings, 1); assert.equal(f.db.isTransaction, true);
    f.db.exec('ROLLBACK'); assert.equal(receipts.get('scope', 'key'), undefined);
  } finally { f.db.close(); }
});

test('queue enqueue preserves receipt failure and never notifies on failed transaction', () => {
  const original = Error('receipt'), f = fixture((sql, execute) => {
    if (sql === 'ROLLBACK') throw Error('rollback'); execute();
  });
  let receipts = 0, notifications = 0;
  try {
    const queue = new TurnQueue(f.proxy); queue.onAdmission(() => notifications++);
    assert.throws(() => queue.enqueue('codex', { id: 'id', sessionKey: 'session', createdAt: 1, payload: {} }, () => {
      receipts++; throw original;
    }), e => e === original);
    assert.equal(receipts, 1); assert.equal(notifications, 0);
    assert.equal(f.db.isTransaction, true); f.db.exec('ROLLBACK');
    assert.equal(queue.hasPending('codex', 'session'), false);
  } finally { f.db.close(); }
});

test('untyped thenable cannot authorize commit outside the synchronous owner boundary', () => {
  const f = fixture();
  try {
    assert.throws(() => observedTransaction(f.proxy, 'turn-queue-change', (() => {
      f.db.exec('INSERT INTO facts VALUES (1)'); return { then() {} };
    }) as any, f.diagnostics), /must be synchronous/);
    assert.deepEqual(f.sql, ['BEGIN IMMEDIATE', 'ROLLBACK']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM facts').get()!.n, 0);
  } finally { f.db.close(); }
});
