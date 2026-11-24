import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { StartupDatabaseOwners } from './startup-owner.js';

test('connection close fences SQL and nested close before diagnostic clock reentry', () => {
  const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
  let observe: (() => void) | undefined, closes = 0;
  let sqlError: unknown, closeError: unknown, observedCloses: number | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    const callback = observe; observe = undefined; callback?.(); return 0;
  });
  const db = recoverableConnection(raw, diagnostics);
  db.exec('CREATE TABLE facts(n)');
  const insert = db.prepare('INSERT INTO facts VALUES(1)');
  raw.close = () => { closes++; nativeClose(); };
  observe = () => {
    try { insert.run(); } catch (error) { sqlError = error; }
    try { db.close(); } catch (error) { closeError = error; }
    observedCloses = closes;
  };
  try {
    db.close();
    assert.ok(sqlError instanceof StorageConnectionUnavailable);
    assert.ok(closeError instanceof StorageConnectionUnavailable);
    assert.equal(observedCloses, 0);
    assert.equal(closes, 1); assert.equal(connectionRecoverySnapshot(db).state, 'closed');
  }
  finally { if (raw.isOpen) nativeClose(); }
});

test('startup abandon publishes cleanup fence before diagnostic clock, retaining one refused attempt per cooldown', () => {
  const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
  let observe: (() => void) | undefined, attempts = 0;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    const callback = observe; observe = undefined; callback?.(); return 0;
  });
  const owners = new StartupDatabaseOwners(diagnostics, () => 0, () => raw);
  const db = owners.open(':memory:');
  raw.close = () => { attempts++; throw Error('private-close-fault'); };
  observe = () => owners.abandon(db);
  try {
    owners.abandon(db); assert.equal(attempts, 1);
    owners.abandon(db); assert.equal(attempts, 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { nativeClose(); }
});

test('original rollback attempt is installed before diagnostic clock reentry and never duplicates cleanup', () => {
  const raw = new DatabaseSync(':memory:'), nativeExec = raw.exec.bind(raw);
  let observe: (() => void) | undefined, rollbacks = 0, broken = true;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    const callback = observe; observe = undefined; callback?.(); return 0;
  });
  const db = recoverableConnection(raw, diagnostics, () => 0);
  db.exec('CREATE TABLE facts(n); BEGIN; INSERT INTO facts VALUES(1)');
  db.exec = sql => {
    if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-rollback-fault'); }
    nativeExec(sql);
  };
  assert.throws(() => db.exec('ROLLBACK'));
  assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
  rollbacks = 0;
  observe = () => { assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable); };
  try {
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 1);
    assert.equal(connectionRecoverySnapshot(db).attempts, 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
  } finally { broken = false; db.exec('ROLLBACK'); db.close(); }
});

for (const phase of ['admission-clock', 'diagnostic-start', 'diagnostic-finish', 'diagnostic-sink'] as const) {
  test(`rollback retains original ownership during ${phase} reentry, including successful cleanup`, () => {
    const raw = new DatabaseSync(':memory:'), nativeExec = raw.exec.bind(raw);
    let armed = false, clockCalls = 0, rollbacks = 0, broken = true;
    const errors: unknown[] = [];
    const reenter = () => {
      armed = false;
      for (const action of [() => db.prepare('SELECT 1'), () => db.exec('ROLLBACK'), () => db.close()]) {
        try { action(); errors.push(undefined); } catch (error) { errors.push(error); }
      }
    };
    const diagnostics = new PerformanceDiagnostics(line => {
      if (armed && phase === 'diagnostic-sink' && JSON.parse(line).operation === 'storage-connection-recovery') reenter();
    }, () => {
      if (armed && ++clockCalls === (phase === 'diagnostic-finish' ? 2 : 1)
        && (phase === 'diagnostic-start' || phase === 'diagnostic-finish')) reenter();
      return 0;
    });
    const db = recoverableConnection(raw, diagnostics, () => {
      if (armed && phase === 'admission-clock') reenter();
      return 0;
    });
    db.exec('BEGIN');
    db.exec = sql => {
      if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-rollback-fault'); }
      nativeExec(sql);
    };
    assert.throws(() => db.exec('ROLLBACK'));
    broken = false; rollbacks = 0; armed = true; clockCalls = 0;
    try {
      assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
      assert.equal(errors.length, 3);
      assert.ok(errors.every(error => error instanceof StorageConnectionUnavailable));
      assert.equal(rollbacks, 1);
      assert.equal(connectionRecoverySnapshot(db).state, 'ready');
      assert.equal(db.prepare('SELECT 1 AS n').get()?.n, 1);
    } finally { armed = false; db.close(); }
  });
}

for (const phase of ['admission-clock', 'diagnostic-finish', 'diagnostic-sink'] as const) {
  test(`startup cleanup retains its fence through ${phase}, even if observations advance the cooldown`, () => {
    const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
    let armed = false, clockCalls = 0, now = 0, attempts = 0;
    const reenter = () => { armed = false; now += 2000; owners.abandon(db); };
    const diagnostics = new PerformanceDiagnostics(line => {
      if (armed && phase === 'diagnostic-sink' && JSON.parse(line).operation === 'storage-startup-cleanup') reenter();
    }, () => {
      // Startup and native close each have a start/finish observation.
      if (armed && phase === 'diagnostic-finish' && ++clockCalls === 4) reenter();
      return now;
    });
    const owners = new StartupDatabaseOwners(diagnostics, () => {
      if (armed && phase === 'admission-clock') reenter();
      return now;
    }, () => raw);
    const db = owners.open(':memory:');
    raw.close = () => { attempts++; throw Error('private-close-fault'); };
    armed = true;
    try {
      owners.abandon(db);
      assert.equal(armed, false, 'the selected observation must actually run');
      assert.equal(attempts, 1);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    } finally { armed = false; nativeClose(); }
  });
}

test('a throwing admission clock cannot leave rollback recovery permanently in progress', () => {
  const raw = new DatabaseSync(':memory:'), nativeExec = raw.exec.bind(raw);
  let clockFailed = true, broken = true, rollbacks = 0;
  const db = recoverableConnection(raw, new PerformanceDiagnostics(() => {}, () => 0), () => {
    if (clockFailed) throw Error('private-clock-fault');
    return 0;
  });
  db.exec('BEGIN');
  db.exec = sql => {
    if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-rollback-fault'); }
    nativeExec(sql);
  };
  assert.throws(() => db.exec('ROLLBACK')); rollbacks = 0;
  try {
    assert.throws(() => db.prepare('SELECT 1'));
    assert.equal(rollbacks, 0);
    clockFailed = false; broken = false;
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
  } finally { clockFailed = false; broken = false; db.close(); }
});

test('original rollback can forward saved native exec without reopening observation admission', () => {
  const raw = new DatabaseSync(':memory:');
  const db = recoverableConnection(raw, new PerformanceDiagnostics(() => {}, () => 0), () => 0);
  const saved = db.exec;
  let broken = true, rollbacks = 0;
  db.exec('BEGIN');
  db.exec = sql => {
    if (sql === 'ROLLBACK') { rollbacks++; if (broken) throw Error('private-rollback-fault'); }
    saved(sql);
  };
  assert.throws(() => db.exec('ROLLBACK')); broken = false; rollbacks = 0;
  try {
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    assert.equal(db.prepare('SELECT 1 AS n').get()?.n, 1);
  } finally { db.close(); }
});

for (const phase of ['diagnostic-finish', 'diagnostic-sink'] as const) {
  test(`closed proof does not release original close ownership during ${phase}`, () => {
    const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
    let armed = false, clockCalls = 0, closes = 0, nestedError: unknown;
    const reenter = () => { armed = false; try { db.close(); } catch (error) { nestedError = error; } };
    const diagnostics = new PerformanceDiagnostics(() => {
      if (armed && phase === 'diagnostic-sink') reenter();
    }, () => {
      if (armed && phase === 'diagnostic-finish' && ++clockCalls === 2) reenter();
      return 0;
    });
    const db = recoverableConnection(raw, diagnostics);
    raw.close = () => { closes++; nativeClose(); };
    armed = true;
    try {
      db.close();
      assert.equal(armed, false);
      assert.ok(nestedError instanceof StorageConnectionUnavailable);
      assert.equal(closes, 1);
      db.close(); assert.equal(closes, 1);
    } finally { if (raw.isOpen) nativeClose(); }
  });
}
