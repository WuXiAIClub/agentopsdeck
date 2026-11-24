import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeAdmission } from './volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const mode of ['sync', 'async'] as const) {
  for (const businessFails of [false, true]) {
    test(`${mode} settled writer keeps original outcome and charged lease on release failure (${businessFails})`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-release-evidence-'));
      const db = new DatabaseSync(':memory:');
      const original = Object.assign(Error('private-ledger-error'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
      const businessError = Error('private-business-error');
      const logs: string[] = [];
      const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
      const admission = new VolumeAdmission(db, root, Date.now, () => 1024n ** 3n, diagnostics);
      const exec = db.exec.bind(db); let begins = 0, calls = 0;
      db.exec = sql => { if (sql === 'BEGIN IMMEDIATE' && ++begins === 2) throw original; return exec(sql); };
      const work = () => { calls++; if (businessFails) throw businessError; return 42; };
      try {
        if (mode === 'sync') assert.throws(() => admission.runSync('durable', 1024, work), e => e === (businessFails ? businessError : original));
        else await assert.rejects(admission.run('durable', 1024, async () => work()), e => e === (businessFails ? businessError : original));
        assert.equal(calls, 1);
        const reservations = db.prepare('SELECT payload FROM storage_work_reservations').all();
        assert.equal(reservations.length, 1);
        assert.equal(JSON.parse(String(reservations[0]!.payload)).state, 'started');
        const rows = diagnostics.snapshot().events.filter(row => row.operation === 'storage-admission-release');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.settled, 1); // Original callback settled, NOT ledger release or business commit proof.
        assert.equal(rows[0]!.unknown, 1);
        assert.equal(rows[0]!.sqlErrorCode, 5);
        assert.equal(rows[0]!.step, businessFails ? 2 : 1);
        assert.doesNotMatch(JSON.stringify(rows) + logs.join(''), /private-|agentopsdeck-release-evidence|transient-/);
      } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test('real WAL contention after committed business write is observable without replay or lease reclaim', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-release-wal-'));
  const db = new DatabaseSync(join(root, 'ledger.sqlite'));
  const blocker = new DatabaseSync(join(root, 'ledger.sqlite'));
  const business = new DatabaseSync(':memory:');
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink-error'); });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10');
  business.exec('CREATE TABLE writes(value INTEGER)');
  const admission = new VolumeAdmission(db, root, Date.now, () => 1024n ** 3n, diagnostics);
  let calls = 0;
  try {
    assert.throws(() => admission.runSync('durable', 1024, () => {
      calls++; business.prepare('INSERT INTO writes VALUES(?)').run(42);
      blocker.exec('BEGIN IMMEDIATE'); return 42;
    }), (e: any) => e.errcode === 5);
    assert.equal(calls, 1);
    assert.equal(business.prepare('SELECT count(*) n FROM writes').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
    const row = diagnostics.snapshot().events.find(row => row.operation === 'storage-admission-release');
    assert.equal(row?.unknown, 1); assert.equal(row?.settled, 1); assert.equal(row?.delivery, 'failed');
    assert.doesNotMatch(JSON.stringify(row), /private-|ledger.sqlite|transient-/);
  } finally { if (blocker.isTransaction) blocker.exec('ROLLBACK'); blocker.close(); db.close(); business.close(); rmSync(root, { recursive: true, force: true }); }
});

test('successful release records bounded evidence without changing callback value', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-release-success-'));
  const db = new DatabaseSync(':memory:');
  const rows: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const admission = new VolumeAdmission(db, root, Date.now, () => 1024n ** 3n, diagnostics);
  const value = { unchanged: true };
  try {
    assert.equal(admission.runSync('durable', 1024, () => value), value);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
    const row = rows.find(row => row.operation === 'storage-admission-release');
    assert.equal(row?.settled, 1); assert.equal(row?.unknown, undefined); assert.equal(row?.step, 1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const rejects of [false, true]) {
  test(`escaped native Promise records release only after its original settlement (${rejects})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-release-escaped-'));
    const db = new DatabaseSync(':memory:');
    const rows: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    const admission = new VolumeAdmission(db, root, Date.now, () => 1024n ** 3n, diagnostics);
    let resolve!: () => void, reject!: (e: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    try {
      assert.throws(() => admission.runSync('durable', 1024, (() => promise) as any), /must be synchronous/);
      assert.equal(rows.some(row => row.operation === 'storage-admission-release'), false);
      assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
      if (rejects) reject(Error('private-async-failure')); else resolve();
      await promise.catch(() => {});
      const release = rows.filter(row => row.operation === 'storage-admission-release');
      assert.equal(release.length, 1); assert.equal(release[0].step, rejects ? 2 : 1);
      assert.equal(release[0].settled, 1);
      assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
      assert.doesNotMatch(JSON.stringify(release), /private-|transient-/);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
