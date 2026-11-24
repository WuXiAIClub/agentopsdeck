import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MaintenanceReceiptReader } from './maintenance-receipt-reader.js';
import { newMaintenanceJob } from './connector-maintenance.js';

const job = () => newMaintenanceJob({ id: 'request:1', nodeId: 'node:1', actorId: 'actor:1',
  operation: 'restart', createdAt: 1000, deadline: 60_000 });
function fixture(t: { after(fn: () => void): void }, realRevision = false) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE connector_maintenance_jobs(id TEXT,node_id TEXT,stage TEXT,revision ${realRevision ? 'REAL' : 'INTEGER'},record TEXT)`);
  const value = job();
  db.prepare('INSERT INTO connector_maintenance_jobs VALUES(?,?,?,?,?)')
    .run(value.id, value.nodeId, value.stage, value.revision, JSON.stringify(value));
  return { db, reader: new MaintenanceReceiptReader(db), value };
}
const reads = ['get', 'active', 'unresolved'] as const;
for (const kind of reads) {
  test(`${kind} reads the exact original receipt without changing schema or data`, t => {
    const f = fixture(t), changes = f.db.prepare('SELECT total_changes() n').get()!.n;
    assert.deepEqual(f.reader[kind](kind === 'get' ? f.value.id : f.value.nodeId), f.value);
    assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, changes);
  });
  for (const corruption of ['nul-suffix', 'invalid-utf8', 'over-size', 'blob', 'real-revision'] as const) {
    test(`${kind} rejects ${corruption} without repairing the original receipt`, t => {
      const f = fixture(t, corruption === 'real-revision'), record = JSON.stringify(f.value);
      if (corruption === 'nul-suffix') f.db.prepare('UPDATE connector_maintenance_jobs SET record=?').run(record + '\0foreign');
      if (corruption === 'invalid-utf8') f.db.prepare('UPDATE connector_maintenance_jobs SET record=CAST(? AS TEXT)')
        .run(Buffer.concat([Buffer.from(record), Buffer.from([0, 0xff])]));
      if (corruption === 'over-size') f.db.prepare('UPDATE connector_maintenance_jobs SET record=?').run(record.padEnd(65537, ' '));
      if (corruption === 'blob') f.db.prepare('UPDATE connector_maintenance_jobs SET record=?').run(Buffer.from(record));
      if (corruption === 'real-revision') f.db.exec('UPDATE connector_maintenance_jobs SET revision=0.0');
      const before = f.db.prepare('SELECT typeof(record) type,hex(record) bytes,typeof(revision) revision FROM connector_maintenance_jobs').get();
      assert.throws(() => f.reader[kind](kind === 'get' ? f.value.id : f.value.nodeId), /Invalid maintenance journal record/);
      assert.deepEqual(f.db.prepare('SELECT typeof(record) type,hex(record) bytes,typeof(revision) revision FROM connector_maintenance_jobs').get(), before);
    });
  }
}
for (const column of ['id', 'stage'] as const) {
  test(`unresolved rejects NUL-truncated ${column} identity`, t => {
    const f = fixture(t);
    f.db.prepare(`UPDATE connector_maintenance_jobs SET ${column}=?`).run(f.value[column] + '\0foreign');
    assert.throws(() => f.reader.unresolved(f.value.nodeId), /Invalid maintenance journal record/);
  });
}
test('bounded TEXT preserves valid whitespace and missing receipt semantics', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE connector_maintenance_jobs SET record=?').run(JSON.stringify(f.value).padEnd(65536, ' '));
  assert.deepEqual(f.reader.get(f.value.id), f.value);
  assert.equal(f.reader.get('missing'), undefined);
  assert.equal(f.reader.active('missing'), undefined);
  assert.equal(f.reader.unresolved('missing'), undefined);
});
test('constructing the reader does not create missing schema', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const reader = new MaintenanceReceiptReader(db);
  assert.throws(() => reader.get('request:1'), /no such table/);
  assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get()!.n, 0);
});
