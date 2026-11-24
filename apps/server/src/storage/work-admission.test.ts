import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { StorageWorkAdmission } from './work-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const MiB = 1024 ** 2;

const corruptions: [string, (receipt: any) => string][] = [
  ['null', () => 'null'], ['array', () => '[]'], ['invalid JSON', () => '{'],
  ['oversized JSON', () => JSON.stringify('x'.repeat(2048))],
  ['oversized byte payload', () => 'x'.repeat(8193)],
  ['NUL after valid JSON', receipt => JSON.stringify(receipt) + '\0tail'],
  ['NUL before oversized tail', receipt => JSON.stringify(receipt) + '\0' + 'x'.repeat(8193)],
  ['negative charge', receipt => JSON.stringify({ ...receipt, bytes: -MiB })],
  ['zero charge', receipt => JSON.stringify({ ...receipt, bytes: 0 })],
  ['fractional charge', receipt => JSON.stringify({ ...receipt, bytes: 0.5 })],
  ['oversized charge', receipt => JSON.stringify({ ...receipt, bytes: 4 * 1024 ** 3 + 1 })],
  ['wrong row identity', receipt => JSON.stringify({ ...receipt, requestId: 'foreign' })],
  ['unknown state', receipt => JSON.stringify({ ...receipt, state: 'done' })],
  ['unknown class', receipt => JSON.stringify({ ...receipt, workClass: 'constructor' })],
  ['coercible array class', receipt => {
    const workClass = ['durable'];
    return JSON.stringify({ ...receipt, workClass,
      fingerprint: createHash('sha256').update(JSON.stringify([workClass, receipt.bytes])).digest('hex') });
  }],
  ['forged fingerprint', receipt => JSON.stringify({ ...receipt, fingerprint: '0'.repeat(64) })],
  ['invalid expiration', receipt => JSON.stringify({ ...receipt, expiresAt: -1 })],
  ['fractional expiration', receipt => JSON.stringify({ ...receipt, expiresAt: 5000.5 })],
  ['extra field', receipt => JSON.stringify({ ...receipt, foreign: true })],
  ['missing field', receipt => { const value = { ...receipt }; delete value.state; return JSON.stringify(value); }],
];
for (const [name, corrupt] of corruptions) test(`corrupt persisted receipt (${name}) cannot be absent, recharged, released or reconciled`, () => fixture((s, db) => {
  const lease = `transient-${randomUUID()}`, sample = () => ({ freeBytes: BigInt(1024 * MiB), observedAt: 1000 });
  const receipt = s.startTransient('v', lease, 'durable', MiB, sample), payload = corrupt(receipt);
  db.prepare('UPDATE storage_work_reservations SET payload=? WHERE request=?').run(payload, lease);
  for (const action of [() => s.read('v', lease), () => s.reserve('v', lease, 'durable', MiB, sample),
    () => s.reserve('v', 'fresh', 'durable', MiB, sample), () => s.startTransient('v', 'transient-fresh', 'durable', MiB, sample),
    () => s.claim('v', lease), () => s.release('v', lease), () => s.finishTransient('v', lease),
    () => s.reconcileTransient('v', lease), () => s.reconcileTransient('v', lease, { workClass: 'durable', bytes: MiB })]) {
    assert.throws(action, /corrupt-receipt/);
    assert.equal(db.isTransaction, false);
    assert.equal(Buffer.from(db.prepare('SELECT CAST(payload AS BLOB) payload FROM storage_work_reservations WHERE request=?').get(lease)!.payload as Uint8Array).toString('utf8'), payload);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
  }
}));

test('SQL row key containing NUL cannot impersonate its valid prefix', () => fixture((s, db) => {
  const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
  s.startTransient('v', 'transient-r', 'durable', MiB, () => sample);
  db.prepare('UPDATE storage_work_reservations SET request=?').run('transient-r\0foreign');
  assert.throws(() => s.reserve('v', 'fresh', 'durable', MiB, sample), /corrupt-receipt/);
  assert.equal(s.read('v', 'fresh'), undefined);
  assert.equal(db.isTransaction, false);
  assert.equal(Buffer.from(db.prepare('SELECT CAST(request AS BLOB) request FROM storage_work_reservations').get()!.request as Uint8Array).toString('utf8'), 'transient-r\0foreign');
  assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
}));

test('runtime class coercion cannot persist an unreadable receipt', () => fixture((s, db) => {
  const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
  for (const workClass of [['durable'], { toString: () => 'durable' }, null, 1]) {
    assert.throws(() => s.reserve('v', 'r', workClass as any, MiB, sample), /estimate/);
    assert.equal(s.read('v', 'r'), undefined);
    assert.equal(db.isTransaction, false);
  }
}));

test('noncanonical UTF-8 identity cannot be admitted or normalized into another receipt', () => fixture((s, db) => {
  const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
  assert.throws(() => s.reserve('v', 'invalid-\ud800', 'durable', MiB, sample), /scope/);
  s.startTransient('v', 'transient-r', 'durable', MiB, () => sample);
  const rawKey = Buffer.from([0x72, 0xff]);
  db.prepare('UPDATE storage_work_reservations SET request=CAST(? AS TEXT)').run(rawKey);
  assert.throws(() => s.reserve('v', 'fresh', 'durable', MiB, sample), /corrupt-receipt/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(Buffer.from(db.prepare('SELECT CAST(request AS BLOB) request FROM storage_work_reservations').get()!.request as Uint8Array), rawKey);
  assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
}));

for (const sqlType of ['invalid-text', 'blob']) test(`persisted ${sqlType} payload is rejected without byte replacement`, () => fixture((s, db) => {
  const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
  const receipt = s.startTransient('v', 'transient-r', 'durable', MiB, () => sample);
  const raw = sqlType === 'blob' ? Buffer.from(JSON.stringify(receipt)) : Buffer.from([0x7b, 0xff, 0x7d]);
  db.prepare(sqlType === 'blob' ? 'UPDATE storage_work_reservations SET payload=?'
    : 'UPDATE storage_work_reservations SET payload=CAST(? AS TEXT)').run(raw);
  for (const action of [() => s.read('v', 'transient-r'), () => s.finishTransient('v', 'transient-r'),
    () => s.reserve('v', 'fresh', 'durable', MiB, sample)]) {
    assert.throws(action, /corrupt-receipt/);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(Buffer.from(db.prepare('SELECT CAST(payload AS BLOB) payload FROM storage_work_reservations').get()!.payload as Uint8Array), raw);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
  }
}));

test('oversized persisted ledger materialization is bounded and does not sweep expired rows', () => fixture((s, db, tick) => {
  const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
  const original = s.reserve('v', 'first', 'durable', MiB, sample);
  const insert = db.prepare('INSERT INTO storage_work_reservations VALUES(?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < 4100; i++) {
    const requestId = `r${i}`;
    insert.run('v', requestId, JSON.stringify({ ...original, requestId }));
  }
  db.exec('COMMIT');
  tick(7000);
  let materialized = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('WHERE volume=? LIMIT')) {
      const all = statement.all.bind(statement);
      statement.all = (...args: any[]) => { const rows = all(...args); materialized = rows.length; return rows; };
    }
    return statement;
  };
  assert.throws(() => s.reserve('v', 'fresh', 'durable', MiB, { ...sample, observedAt: 7000 }), /receipt-capacity/);
  assert.equal(materialized, 4096);
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 4101);
  assert.equal(s.read('v', 'first')!.state, 'reserved');
  assert.equal(s.read('v', 'fresh'), undefined);
}));

test('corrupt negative charge never offsets headroom and diagnostics do not expose persisted payload', () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [];
  try {
    const admission = new StorageWorkAdmission(db, () => 1000, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
    const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
    const receipt = admission.startTransient('private-volume', 'transient-private-original', 'durable', 1, () => sample);
    const payload = JSON.stringify({ ...receipt, bytes: -1024 * MiB });
    db.prepare('UPDATE storage_work_reservations SET payload=?').run(payload);
    assert.throws(() => admission.reserve('private-volume', 'private-next', 'durable', 400 * MiB,
      { ...sample, freeBytes: BigInt(512 * MiB) }), /corrupt-receipt/);
    assert.equal(admission.read('private-volume', 'private-next'), undefined);
    assert.ok(rows.some(row => row.category === 'failed'));
    assert.doesNotMatch(JSON.stringify(rows), /private-|fingerprint|corrupt-receipt/);
    assert.equal(db.prepare('SELECT payload FROM storage_work_reservations').get()!.payload, payload);
  } finally { db.close(); }
});
for (const executed of [false, true]) test(`lost admission BEGIN ACK never starts a writer (${executed})`, () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [], original = Error('private-begin');
  const admission = new StorageWorkAdmission(db, () => 1000, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const exec = db.exec.bind(db); let samples = 0;
  db.exec = sql => { if (sql === 'BEGIN IMMEDIATE') { if (executed) exec(sql); throw original; } exec(sql); };
  try {
    assert.throws(() => admission.startTransient('v', 'transient-r', 'durable', MiB, () => {
      samples++; return { freeBytes: 4n * 1024n ** 3n, observedAt: 1000 };
    }), error => error === original);
    assert.equal(samples, 0); assert.equal(db.isTransaction, false);
    assert.equal(admission.read('v', 'transient-r'), undefined);
    assert.equal(rows[0].unknown, 1); assert.doesNotMatch(JSON.stringify(rows), /private-begin/);
  } finally { db.close(); }
});
test('lost commit acknowledgment logs failure without replaying or releasing the started charge', () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [], original = Error('private-commit-error');
  const s = new StorageWorkAdmission(db, () => 1000, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const exec = db.exec.bind(db); let commits = 0, samples = 0;
  db.exec = sql => { exec(sql); if (sql === 'COMMIT') { commits++; throw original; } };
  try {
    assert.throws(() => s.startTransient('v', 'transient-r', 'durable', MiB, () => {
      samples++; return { freeBytes: 4n * 1024n ** 3n, observedAt: 1000 };
    }), error => error === original);
    assert.equal(commits, 1); assert.equal(samples, 1); assert.equal(db.isTransaction, false);
    assert.equal(s.read('v', 'transient-r')?.state, 'started');
    assert.equal(rows[0].category, 'failed'); assert.equal(typeof rows[0].commitMs, 'number');
    assert.equal(rows[0].unknown, 1); assert.equal(rows[0].settled, undefined);
    assert.equal(rows[0].step, 3); assert.equal(rows[0].classificationUnknown, 1);
    assert.equal(rows[0].rollbackMs, undefined); assert.doesNotMatch(JSON.stringify(rows), /private-commit-error/);
  } finally { db.close(); }
});
test('real busy BEGIN is measured separately, never runs sample or replays admission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-admission-timing-'));
  const db = new DatabaseSync(join(dir, 'ledger.sqlite')), other = new DatabaseSync(join(dir, 'ledger.sqlite'));
  const rows: any[] = [];
  const s = new StorageWorkAdmission(db, () => 1000, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  let samples = 0;
  try {
    db.exec('PRAGMA busy_timeout=30; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    other.exec('BEGIN IMMEDIATE');
    assert.throws(() => s.startTransient('private-volume', 'transient-secret', 'durable', MiB,
      () => { samples++; return { freeBytes: 4n * 1024n ** 3n, observedAt: 1000 }; }));
    assert.equal(samples, 0); assert.equal(db.isTransaction, false); assert.equal(other.isTransaction, true);
    assert.equal(rows.length, 1); assert.equal(rows[0].category, 'failed'); assert.ok(rows[0].beginMs >= 15);
    assert.equal(rows[0].bodyMs, undefined); assert.equal(rows[0].commitMs, undefined);
    assert.equal(rows[0].step, 1); assert.equal(rows[0].sqlErrorCode, 5);
    assert.doesNotMatch(JSON.stringify(rows), /private-volume|transient-secret|sqlite|busy/i);
    other.exec('ROLLBACK'); assert.equal(s.read('private-volume', 'transient-secret'), undefined);
  } finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('native SQL body failure is logged at step two and never replays its sampler', () => {
  const db = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  const admission = new StorageWorkAdmission(db, () => 1000, diagnostics);
  let original: unknown, calls = 0;
  try {
    assert.throws(() => admission.startTransient('private-volume', 'transient-private', 'durable', MiB, () => {
      calls++;
      try { db.exec('SELECT * FROM private_missing_table'); } catch (error) { original = error; throw error; }
      assert.fail('native SQL must fail');
    }), error => error === original);
    assert.equal(calls, 1); assert.equal(db.isTransaction, false);
    assert.equal(admission.read('private-volume', 'transient-private'), undefined);
    const row = diagnostics.snapshot().events[0]!;
    assert.equal(row.step, 2); assert.equal(row.sqlErrorCode, 1); assert.equal(typeof row.rollbackMs, 'number');
    assert.equal(row.unknown, undefined); assert.equal(row.commitMs, undefined);
    assert.doesNotMatch(JSON.stringify(row), /private|SELECT|sqlite|ERR_/);
  } finally { db.close(); }
});

test('sample failure rolls back and original error survives even when rollback reporting fails', () => {
  const db = new DatabaseSync(':memory:'), original = Error('private/path key');
  const rows: any[] = [];
  const s = new StorageWorkAdmission(db, () => 1000, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const exec = db.exec.bind(db);
  db.exec = sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('rollback-error'); };
  try {
    assert.throws(() => s.startTransient('v', 'transient-r', 'durable', MiB, () => { throw original; }), error => error === original);
    assert.equal(db.isTransaction, false); assert.equal(s.read('v', 'transient-r'), undefined);
    assert.equal(rows[0].category, 'failed');
    for (const key of ['beginMs', 'bodyMs', 'sampleMs', 'rollbackMs']) assert.equal(typeof rows[0][key], 'number');
    assert.equal(rows[0].unknown, 1); assert.equal(rows[0].rollbackFailed, 1);
    assert.equal(rows[0].commitMs, undefined); assert.doesNotMatch(JSON.stringify(rows), /private|path|key|rollback-error/);
  } finally { db.close(); }
});
test('schema initialization is shared only after commit and failed first admission retries safely', () => fixture((s, db) => {
  let creates = 0;
  const exec = db.exec.bind(db);
  db.exec = sql => { if (sql.includes('CREATE TABLE')) creates++; return exec(sql); };
  const sample = () => ({ freeBytes: BigInt(1024 * MiB), observedAt: 1000 });
  assert.throws(() => s.startTransient('v', 'transient-failed', 'durable', MiB, () => { throw Error('sample-failed'); }), /sample-failed/);
  assert.equal(s.read('v', 'transient-failed'), undefined);
  assert.equal(creates, 1);
  s.startTransient('v', 'transient-ok', 'durable', MiB, sample);
  s.finishTransient('v', 'transient-ok');
  const second = new StorageWorkAdmission(db, () => 1000);
  second.startTransient('v', 'transient-second', 'durable', MiB, sample);
  second.finishTransient('v', 'transient-second');
  assert.equal(creates, 2);
  db.exec('DROP TABLE storage_work_reservations');
  assert.throws(() => second.startTransient('v', 'transient-missing-schema', 'durable', MiB, sample), /no such table/);
  assert.equal(db.isTransaction, false);
}));
test('atomic transient IO is charged before writes, survives crashes and cannot replay', () => fixture((s, db, tick) => {
  const sample = () => ({ freeBytes: BigInt(800 * MiB), observedAt: 1000 });
  assert.throws(() => s.startTransient('v', 'external', 'projection', MiB, sample), /persistent/);
  s.startTransient('v', 'transient-one', 'projection', 256 * MiB, sample);
  assert.equal(s.read('v', 'transient-one')?.state, 'started');
  assert.throws(() => s.startTransient('v', 'transient-one', 'projection', 256 * MiB, sample), /reused/);
  assert.throws(() => s.startTransient('v', 'transient-two', 'projection', 64 * MiB, sample), /space/);
  tick(100000);
  const reopened = new StorageWorkAdmission(db, () => 100000);
  const later = () => ({ freeBytes: BigInt(800 * MiB), observedAt: 100000 });
  assert.throws(() => reopened.startTransient('v', 'transient-two', 'projection', 64 * MiB, later), /space/);
  assert.throws(() => reopened.finishTransient('v', 'external'), /persistent/);
  reopened.finishTransient('v', 'transient-one');
  assert.throws(() => reopened.finishTransient('v', 'transient-one'), /not-started/);
  reopened.startTransient('v', 'transient-two', 'projection', MiB, later);
  reopened.finishTransient('v', 'transient-two');
  assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
}));
function fixture(fn: (s: StorageWorkAdmission, db: DatabaseSync, tick: (n: number) => void) => void) {
  const db = new DatabaseSync(':memory:'); let now = 1000;
  try { fn(new StorageWorkAdmission(db, () => now), db, n => { now = n; }); } finally { db.close(); }
}
test('work classes preserve headroom and concurrent reservations cannot reuse the same free bytes', () => fixture(s => {
  const sample = { freeBytes: BigInt(800 * MiB), observedAt: 1000 };
  assert.throws(() => s.reserve('volume', 'export', 'export', 64 * MiB, sample), /insufficient/);
  s.reserve('volume', 'projection', 'projection', 256 * MiB, sample);
  assert.throws(() => s.reserve('volume', 'projection2', 'projection', 64 * MiB, sample), /insufficient/);
  s.reserve('volume', 'durable', 'durable', 256 * MiB, sample);
  s.reserve('volume', 'recovery', 'recovery', 128 * MiB, sample);
}));
test('same request is immutable and claim is committed once, release never permits ID reuse', () => fixture((s, db) => {
  const sample = { freeBytes: BigInt(1024 * MiB), observedAt: 1000 };
  const original = s.reserve('v', 'r', 'projection', MiB, sample);
  assert.deepEqual(s.reserve('v', 'r', 'projection', MiB, sample), original);
  assert.throws(() => s.reserve('v', 'r', 'durable', MiB, sample), /reused/);
  db.exec('BEGIN'); assert.throws(() => s.claim('v', 'r'), /outer/); db.exec('ROLLBACK');
  assert.equal(s.claim('v', 'r').claimed, true); assert.equal(s.claim('v', 'r').claimed, false);
  assert.equal(s.release('v', 'r').state, 'released'); assert.equal(s.claim('v', 'r').claimed, false);
}));
test('unused reservation expires; started unknown operations remain charged across expiry and reopen of coordinator', () => fixture((s, db, tick) => {
  const sample = { freeBytes: BigInt(800 * MiB), observedAt: 1000 };
  s.reserve('v', 'unused', 'projection', 32 * MiB, sample); s.reserve('v', 'started', 'projection', 200 * MiB, sample); s.claim('v', 'started');
  tick(7000); assert.equal(s.claim('v', 'unused').claimed, false);
  const reopened = new StorageWorkAdmission(db, () => 7000);
  assert.throws(() => reopened.reserve('v', 'too-large', 'projection', 100 * MiB, { ...sample, observedAt: 7000 }), /insufficient/);
  assert.equal(reopened.claim('v', 'started').claimed, false);
  reopened.release('v', 'started'); reopened.reserve('v', 'new', 'projection', 100 * MiB, { ...sample, observedAt: 7000 });
}));
test('stale/future samples and invalid estimates fail closed without creating reservations', () => fixture(s => {
  for (const observedAt of [-1, 1001, NaN]) assert.throws(() => s.reserve('v', 'r', 'projection', MiB, { freeBytes: BigInt(1024 * MiB), observedAt }), /sample/);
  assert.throws(() => s.reserve('v', 'r', 'projection', -1, { freeBytes: 0n, observedAt: 1000 }), /estimate/);
  assert.equal(s.read('v', 'r'), undefined);
}));
