import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeAdmission } from './volume-admission.js';
import { StorageWorkAdmission } from './work-admission.js';

function fixture(t: any, sample?: (db: DatabaseSync, volume: string) => bigint) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-pressure-atomic-'));
  const db = new DatabaseSync(join(root, 'ledger.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  const volume = String(statSync(root, { bigint: true }).dev);
  const admission = new VolumeAdmission(db, root, () => 2000, () => sample ? sample(db, volume) : 1024n ** 3n);
  db.prepare('INSERT INTO storage_volume_pressure VALUES(?,?)').run(volume, 0);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, volume, admission, root };
}

for (const asynchronous of [false, true]) test('pressure cleanup failure cannot orphan a never-invoked lease, async=' + asynchronous, async t => {
  const f = fixture(t), ledger = new StorageWorkAdmission(f.db, () => 2000);
  ledger.startTransient(f.volume, 'transient-original-other', 'recovery', 17, () => ({ freeBytes: 1024n ** 3n, observedAt: 2000 }));
  const before = f.db.prepare('SELECT * FROM storage_work_reservations').all();
  f.db.exec("CREATE TRIGGER refuse_pressure_delete BEFORE DELETE ON storage_volume_pressure BEGIN SELECT RAISE(ABORT,'synthetic-pressure-failure'); END");
  let called = 0;
  if (asynchronous) await assert.rejects(f.admission.run('durable', 23, async () => ++called), /synthetic-pressure-failure/);
  else assert.throws(() => f.admission.runSync('durable', 23, () => ++called), /synthetic-pressure-failure/);
  assert.equal(called, 0);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(f.db.prepare('SELECT * FROM storage_work_reservations').all(), before);
  assert.equal(f.db.prepare('SELECT denied_at FROM storage_volume_pressure WHERE volume=?').get(f.volume)!.denied_at, 0);
  f.db.exec('DROP TRIGGER refuse_pressure_delete');
  assert.equal(f.admission.runSync('durable', 23, () => ++called), 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM storage_work_reservations').all(), before);
  assert.equal(f.db.prepare('SELECT * FROM storage_volume_pressure WHERE volume=?').get(f.volume), undefined);
  assert.equal(f.db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
});

test('pressure compare-and-delete belongs to the exact reservation transaction', t => {
  const f = fixture(t), prepare = f.db.prepare.bind(f.db), observed: boolean[] = [];
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('DELETE FROM storage_volume_pressure')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { observed.push(f.db.isTransaction); return Reflect.apply(run, statement, args); };
    }
    return statement;
  };
  assert.equal(f.admission.runSync('durable', 7, () => {
    assert.equal(f.db.prepare('SELECT * FROM storage_volume_pressure WHERE volume=?').get(f.volume), undefined);
    assert.equal(f.db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
    return 42;
  }), 42);
  assert.deepEqual(observed, [true]);
});

test('newer pressure and a different volume remain unchanged', t => {
  const f = fixture(t, (db, volume) => {
    db.prepare('UPDATE storage_volume_pressure SET denied_at=? WHERE volume=?').run(2001, volume);
    return 1024n ** 3n;
  });
  f.db.prepare('INSERT INTO storage_volume_pressure VALUES(?,?)').run('other-volume', 3000);
  assert.equal(f.admission.runSync('durable', 7, () => 42), 42);
  assert.deepEqual(f.db.prepare('SELECT volume,denied_at FROM storage_volume_pressure ORDER BY volume').all(),
    [{ volume: f.volume, denied_at: 2001 }, { volume: 'other-volume', denied_at: 3000 }].sort((a,b)=>a.volume.localeCompare(b.volume)).map(row=>Object.assign(Object.create(null),row)));
});

test('invalid pressure marker is refused before reservation or cleanup', t => {
  const f = fixture(t), ledger = new StorageWorkAdmission(f.db, () => 2000);
  const before = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  for (const marker of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ledger.startTransient(f.volume, 'transient-invalid-pressure', 'durable', 1,
      () => ({ freeBytes: 1024n ** 3n, observedAt: 2000 }), marker), /pressure-sample/);
  }
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), before);
  assert.equal(f.db.prepare('SELECT denied_at FROM storage_volume_pressure WHERE volume=?').get(f.volume)!.denied_at, 0);
  assert.equal(f.db.isTransaction, false);
});

test('emergency recovery preserves the volume pressure record', t => {
  const f = fixture(t);
  assert.equal(f.admission.runSync('recovery', 7, () => 42), 42);
  assert.equal(f.db.prepare('SELECT denied_at FROM storage_volume_pressure WHERE volume=?').get(f.volume)!.denied_at, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
});
