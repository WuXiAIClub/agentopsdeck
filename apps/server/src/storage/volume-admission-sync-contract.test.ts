import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VolumeAdmission } from './volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t: TestContext, throwingSink = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sync-contract-'));
  const db = new DatabaseSync(':memory:'); let closed = false;
  const logs: Record<string, unknown>[] = [], releaseLogs: Record<string, unknown>[] = [], admissionLogs: Record<string, unknown>[] = [];
  // Assert every settlement, independently of the production diagnostic rate
  // budget shared by the ledger's BEGIN/COMMIT and release observations.
  let diagnosticClock = 0;
  const admission = new VolumeAdmission(db, root, Date.now, () => 800n * 1024n ** 2n,
    new PerformanceDiagnostics(line => {
      const row = JSON.parse(line);
      if (row.operation === 'storage-admission-release') releaseLogs.push(row);
      else if (row.operation === 'storage-sync-contract') logs.push(row);
      else {
        admissionLogs.push(row);
        if (row.operation === 'storage-admission' && row.admitted === 0) logs.push(row);
      }
      if (throwingSink) throw Error('private sink');
    }, () => diagnosticClock += 60_000));
  const count = () => db.prepare("SELECT name FROM sqlite_master WHERE name='storage_work_reservations'").get()
    ? db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n : 0;
  const close = () => { if (!closed) { closed = true; db.close(); } };
  t.after(() => { close(); rmSync(root, { recursive: true, force: true }); });
  return { db, logs, releaseLogs, admissionLogs, admission, count, close };
}

test('known async writer never starts or acquires', t => {
  const f = fixture(t); let calls = 0;
  const writer = async () => { calls++; };
  assert.throws(() => f.admission.runSync('durable', 1024, writer as any), /must be synchronous/);
  assert.equal(calls, 0); assert.equal(f.count(), 0);
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0]!.admitted, 0); assert.equal(f.logs[0]!.deferred, 1);
});

test('bound async writer is caught by the returned-value fence and retains its original lease', async t => {
  const f = fixture(t), held = gate(); let calls = 0;
  const writer = (async () => { calls++; await held.promise; }).bind(null);
  assert.throws(() => f.admission.runSync('durable', 1024, writer as any), /must be synchronous/);
  assert.equal(calls, 1); assert.equal(f.count(), 1);
  held.resolve(); await flush(); assert.equal(f.count(), 0); assert.equal(f.logs.length, 2);
});

for (const rejected of [false, true]) for (const hiddenThen of [false, true]) for (const throwingSink of [false, true]) {
  test(`original Promise ${rejected ? 'reject' : 'resolve'} retains exact lease; hiddenThen=${hiddenThen}, throwingSink=${throwingSink}`, async t => {
    const f = fixture(t, throwingSink), held = gate();
    if (hiddenThen) Object.defineProperty(held.promise, 'then', { get() { throw Error('must not inspect private then'); } });
    let calls = 0;
    assert.throws(() => f.admission.runSync('durable', 1024, (() => { calls++; return held.promise; }) as any), /must be synchronous/);
    assert.equal(calls, 1); assert.equal(f.count(), 1); assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0]!.phase, 'pending'); assert.equal(f.logs[0]!.unknown, 1);
    await flush(); assert.equal(f.count(), 1); assert.equal(f.logs.length, 1);
    // A distinct normal writer must not be erased by the first writer's cleanup.
    let otherCount = 0;
    f.admission.runSync('durable', 512, () => { otherCount = Number(f.count()); });
    assert.equal(otherCount, 2); assert.equal(f.count(), 1);
    if (rejected) held.reject(Object.assign(Error('private write'), { code: 'ENOSPC' })); else held.resolve();
    await flush(); assert.equal(f.count(), 0); assert.equal(f.logs.length, 2);
    const [pending, final] = f.logs;
    assert.equal(final!.operation, 'storage-sync-contract'); assert.equal(final!.phase, 'finished');
    assert.equal(final!.settled, 1); assert.equal(final!.category, 'failed');
    assert.equal(final!.instance, pending!.instance); assert.equal(final!.sequence, pending!.sequence);
    assert.equal(f.releaseLogs.length, 2);
    assert.ok(f.releaseLogs.every(row => row.settled === 1 && row.unknown === undefined));
    assert.equal(f.releaseLogs[1]!.step, rejected ? 2 : 1);
    assert.doesNotMatch(JSON.stringify([...f.logs, ...f.releaseLogs, ...f.admissionLogs]), /private|ENOSPC|transient-|SELECT|INSERT|sqlite/);
    if (rejected) assert.throws(() => f.admission.runSync('durable', 1, () => assert.fail('pressure must precede writer')), /pressure-backoff/);
    await flush(); assert.equal(f.logs.length, 2); assert.equal(calls, 1);
  });
}

test('arbitrary thenable is never invoked and remains charged UNKNOWN', t => {
  const f = fixture(t); let calls = 0;
  const thenable = { then() { calls++; } };
  assert.throws(() => f.admission.runSync('durable', 1024, (() => thenable) as any), /must be synchronous/);
  assert.equal(calls, 0); assert.equal(f.count(), 1); assert.equal(f.logs.length, 2);
  assert.equal(f.logs[1]!.unknown, 1); assert.equal(f.logs[1]!.settled, undefined);
});

test('throwing then inspection preserves exact original error and charged UNKNOWN', t => {
  const f = fixture(t), failure = Error('private getter'); let reads = 0;
  Object.defineProperty(failure, 'code', { get() { throw Error('must not replace original failure'); } });
  const value = { get then() { reads++; throw failure; } };
  assert.throws(() => f.admission.runSync('durable', 1024, () => value), error => error === failure);
  assert.equal(reads, 1); assert.equal(f.count(), 1); assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0]!.unknown, 1); assert.equal(f.logs[0]!.phase, 'finished');
  assert.equal(f.logs[0]!.operation, 'storage-sync-contract');
  const pressure = f.admissionLogs.find(row => row.pressureUnknown === 1);
  assert.ok(pressure);
  assert.equal(pressure.operation, 'storage-admission');
  assert.equal(pressure.unknown, undefined, 'pressure inspection is not writer settlement evidence');
});

test('lost release acknowledgement after COMMIT stays UNKNOWN and never replays cleanup', async t => {
  const f = fixture(t), held = gate(); let commits = 0;
  assert.throws(() => f.admission.runSync('durable', 1024, (() => held.promise) as any), /must be synchronous/);
  const exec = f.db.exec.bind(f.db);
  t.mock.method(f.db, 'exec', (sql: string) => {
    exec(sql);
    if (sql === 'COMMIT') { commits++; throw Error('private lost committed release ACK'); }
  });
  held.resolve(); await flush();
  assert.equal(commits, 1); assert.equal(f.count(), 0); assert.equal(f.db.isTransaction, false);
  assert.equal(f.logs.length, 2); assert.equal(f.logs[1]!.unknown, 1); assert.equal(f.logs[1]!.settled, undefined);
  await flush(); assert.equal(commits, 1);
});

test('reentrant diagnostic sink cannot release the pending original lease', async t => {
  const f = fixture(t), held = gate(); let admission!: VolumeAdmission, observed = 0;
  admission = new VolumeAdmission(f.db, tmpdir(), Date.now, () => 800n * 1024n ** 2n,
    new PerformanceDiagnostics(line => {
      if (JSON.parse(line).operation !== 'storage-sync-contract') return;
      admission.runSync('durable', 512, () => { observed = Number(f.count()); });
    }));
  assert.throws(() => admission.runSync('durable', 1024, (() => held.promise) as any), /must be synchronous/);
  assert.equal(observed, 2); assert.equal(f.count(), 1);
  held.resolve(); await flush(); assert.equal(f.count(), 0); assert.equal(observed, 1);
});

test('native observer attachment failure retains original lease without invoking overridden then', t => {
  const f = fixture(t), promise = Promise.resolve(); let calls = 0;
  Object.defineProperty(promise, 'constructor', { get() { throw Error('private species failure'); } });
  Object.defineProperty(promise, 'then', { value() { calls++; } });
  assert.throws(() => f.admission.runSync('durable', 1024, (() => promise) as any), /must be synchronous/);
  assert.equal(calls, 0); assert.equal(f.count(), 1); assert.equal(f.logs.length, 2);
  assert.equal(f.logs[1]!.unknown, 1); assert.equal(f.logs[1]!.settled, undefined);
});

for (const rejected of [false, true]) test(`cleanup write failure after original ${rejected ? 'rejection' : 'resolution'} remains UNKNOWN; no retry`, async t => {
  const f = fixture(t), held = gate(); let releases = 0;
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', (sql: string) => {
    if (sql.startsWith('DELETE FROM storage_work_reservations')) { releases++; throw Error('private release ACK'); }
    return prepare(sql);
  });
  assert.throws(() => f.admission.runSync('durable', 1024, (() => held.promise) as any), /must be synchronous/);
  if (rejected) held.reject(Error('private original rejection')); else held.resolve();
  await flush(); assert.equal(releases, 1); assert.equal(f.count(), 1);
  assert.equal(f.logs.length, 2); assert.equal(f.logs[1]!.unknown, 1); assert.equal(f.logs[1]!.settled, undefined);
  await flush(); assert.equal(releases, 1);
});

test('closed original ledger never reopens or claims successful cleanup', async t => {
  const f = fixture(t), held = gate();
  assert.throws(() => f.admission.runSync('durable', 1024, (() => held.promise) as any), /must be synchronous/);
  f.close(); held.resolve(); await flush();
  assert.equal(f.logs.length, 2); assert.equal(f.logs[1]!.unknown, 1); assert.equal(f.logs[1]!.settled, undefined);
});

test('ordinary sync values and original write errors retain established behavior', t => {
  const f = fixture(t), failure = Error('private sync failure');
  for (const value of [null, undefined, 42, 'value', { then: 3 }, () => {}]) {
    assert.equal(f.admission.runSync('durable', 1024, () => value), value);
    assert.equal(f.count(), 0);
  }
  assert.throws(() => f.admission.runSync('durable', 1024, () => { throw failure; }), error => error === failure);
  assert.equal(f.count(), 0); assert.equal(f.logs.length, 0);
  assert.ok(f.admissionLogs.some(row => row.operation === 'storage-admission' && row.settled === 1),
    'ordinary admission still uses the original diagnostic sink');
  assert.equal(f.releaseLogs.length, 7);
  assert.ok(f.releaseLogs.every(row => row.settled === 1 && row.unknown === undefined));
  assert.equal(f.releaseLogs.at(-1)!.step, 2);
});
