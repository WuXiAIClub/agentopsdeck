import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const method of ['start', 'add', 'finish'] as const) {
  for (const outcome of ['success', 'failure', 'lost-ack'] as const) {
    test(`diagnostic ${method} failure preserves native close ${outcome} and exact retry fence`, t => {
      const diagnostics = new PerformanceDiagnostics(() => {}), start = diagnostics.start.bind(diagnostics);
      t.mock.method(diagnostics, 'start', (...args: Parameters<typeof start>) => {
        if (method === 'start') throw Error('observer-start');
        const trace = start(...args);
        t.mock.method(trace, method, () => { throw Error('observer-' + method); });
        return trace;
      });
      const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
      const db = recoverableConnection(raw, diagnostics), statement = db.prepare('SELECT 1');
      const original = Error('original-close'); let closes = 0;
      raw.close = () => {
        closes++;
        if (outcome === 'failure' && closes === 1) throw original;
        nativeClose();
        if (outcome === 'lost-ack') throw original;
      };
      try {
        if (outcome === 'success') db.close();
        else assert.throws(() => db.close(), error => error === original);
        assert.equal(connectionRecoverySnapshot(db).state, outcome === 'failure' ? 'close-required' : 'closed');
        assert.throws(() => statement.get(), StorageConnectionUnavailable);
        assert.throws(() => db.open(), StorageConnectionUnavailable);
        db.close(); db.close();
        assert.equal(closes, outcome === 'failure' ? 2 : 1);
        assert.equal(raw.isOpen, false); assert.equal(connectionRecoverySnapshot(db).state, 'closed');
      } finally { if (raw.isOpen) nativeClose(); }
    });
  }
}

test('failed owner close fences cached SQL until exact close retry, without callback replay', () => {
  const raw = new DatabaseSync(':memory:'), logs: unknown[] = [];
  const db = recoverableConnection(raw, new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  const original = Error('private-close-fault'), nativeClose = raw.close.bind(raw);
  const statement = db.prepare('SELECT 1 AS n');
  let closes = 0;
  raw.close = () => { closes++; if (closes === 1) throw original; nativeClose(); };
  try {
    assert.throws(() => db.close(), error => error === original);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => statement.get(), StorageConnectionUnavailable);
    assert.throws(() => db.exec('ROLLBACK'), StorageConnectionUnavailable);
    db.close(); db.close();
    assert.equal(closes, 2);
    assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    assert.throws(() => statement.get(), StorageConnectionUnavailable);
    assert.doesNotMatch(JSON.stringify(logs), /private-close-fault|SELECT|ROLLBACK/);
  } finally { if (raw.isOpen) nativeClose(); }
});

test('lost close ACK preserves original error, remembers exact closed proof and never reopens', () => {
  const raw = new DatabaseSync(':memory:'), logs: any[] = [];
  const db = recoverableConnection(raw, new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  const original = Error('private-lost-close-ack'), nativeClose = raw.close.bind(raw);
  let closes = 0;
  raw.close = () => { closes++; nativeClose(); throw original; };
  try {
    assert.throws(() => db.close(), error => error === original);
    assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    db.close();
    assert.equal(closes, 1);
    assert.throws(() => db.open(), StorageConnectionUnavailable);
    assert.equal(logs.at(-1).recovered, 1);
    assert.equal(logs.at(-1).category, 'failed');
  } finally { if (raw.isOpen) nativeClose(); }
});

test('cached iterator cannot publish rows after close starts; disposal remains permitted for cleanup', () => {
  const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
  const db = recoverableConnection(raw, new PerformanceDiagnostics(() => {}));
  const rows = db.prepare('SELECT 1 AS n UNION ALL SELECT 2 AS n').iterate();
  assert.equal(rows.next().value?.n, 1);
  raw.close = () => { throw Error('private-close-fault'); };
  try {
    assert.throws(() => db.close());
    assert.throws(() => rows.next(), StorageConnectionUnavailable);
    rows.return?.();
    raw.close = nativeClose; db.close();
    assert.throws(() => rows.next(), StorageConnectionUnavailable);
  } finally { if (raw.isOpen) { rows.return?.(); nativeClose(); } }
});

for (const probe of ['missing', 'throwing'] as const) test(`close failure with ${probe} state proof remains fenced until successful original retry`, () => {
  let closes = 0;
  const original = Error('private-owner-close');
  const raw = { exec: () => {}, close: () => { closes++; if (closes < 3) throw original; } };
  if (probe === 'throwing') Object.defineProperty(raw, 'isOpen', { get() { throw Error('private-state-probe'); } });
  const logs: any[] = [];
  const db = recoverableConnection(raw as unknown as DatabaseSync, new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  for (let i = 0; i < 2; i++) {
    assert.throws(() => db.close(), error => error === original);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => db.exec('ROLLBACK'), StorageConnectionUnavailable);
  }
  db.close(); db.close();
  assert.equal(closes, 3);
  assert.equal(connectionRecoverySnapshot(db).state, 'closed');
  assert.equal(logs.filter(row => row.unknown === 1).length, 2);
  assert.equal(logs.at(-1).recovered, 1);
  assert.doesNotMatch(JSON.stringify(logs), /private|ROLLBACK/);
});

test('diagnostic sink failure cannot skip native owner close or replace close error', () => {
  const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
  const db = recoverableConnection(raw, new PerformanceDiagnostics(() => { throw Error('private-log-failure'); }));
  const original = Error('private-close-fault'); let closes = 0;
  raw.close = () => { closes++; if (closes === 1) throw original; nativeClose(); };
  try {
    assert.throws(() => db.close(), error => error === original);
    db.close(); db.close();
    assert.equal(raw.isOpen, false);
    assert.equal(closes, 2);
  } finally { if (raw.isOpen) nativeClose(); }
});

test('closing supersedes rollback recovery: no old SQL or automatic recovery may run afterwards', () => {
  const raw = new DatabaseSync(':memory:'), nativeClose = raw.close.bind(raw);
  const db = recoverableConnection(raw, new PerformanceDiagnostics(() => {}));
  db.exec('CREATE TABLE facts(n); BEGIN; INSERT INTO facts VALUES(1)');
  let rollbacks = 0, closes = 0;
  db.exec = sql => { if (sql === 'ROLLBACK') rollbacks++; throw Error('private-rollback-fault'); };
  assert.throws(() => db.exec('ROLLBACK'));
  assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
  raw.close = () => { closes++; if (closes === 1) throw Error('private-close-fault'); nativeClose(); };
  try {
    assert.throws(() => db.close());
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => db.exec('ROLLBACK'), StorageConnectionUnavailable);
    assert.throws(() => db.prepare('SELECT n FROM facts'), StorageConnectionUnavailable);
    assert.equal(rollbacks, 1, 'close retry is the sole remaining action, not rollback takeover');
    db.close();
    assert.equal(connectionRecoverySnapshot(db).state, 'closed');
  } finally { if (raw.isOpen) nativeClose(); }
});
