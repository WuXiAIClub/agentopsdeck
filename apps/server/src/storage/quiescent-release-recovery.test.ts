import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { VolumeAdmission } from './volume-admission.js';
import { StorageWorkAdmission } from './work-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

test('async BEGIN contention yields before sampling and invokes the original writer exactly once', async t => {
  const f = fixture(t), exec = f.db.exec.bind(f.db);
  let begins = 0, samples = 0, writes = 0;
  f.db.exec = sql => { if (sql === 'BEGIN IMMEDIATE') begins++; return exec(sql); };
  const admission = new VolumeAdmission(f.db, f.root, Date.now, () => { samples++; return 1024n ** 3n; }, f.diagnostics);
  f.blocker.exec('BEGIN IMMEDIATE');
  const work = admission.run('durable', 23, async () => ++writes);
  assert.deepEqual({ begins, samples, writes }, { begins: 1, samples: 0, writes: 0 });
  f.blocker.exec('ROLLBACK'); t.mock.timers.tick(10);
  assert.equal(await work, 1);
  assert.deepEqual({ begins, samples, writes }, { begins: 3, samples: 1, writes: 1 });
  assert.equal(f.count(), 1, 'foreign lease is not reclaimed');
  assert.equal(f.db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
});

test('four refused BEGIN attempts return a known denial without writer, lease or retry of future work', async t => {
  const f = fixture(t), exec = f.db.exec.bind(f.db);
  let begins = 0, writes = 0;
  f.db.exec = sql => { if (sql === 'BEGIN IMMEDIATE') begins++; return exec(sql); };
  f.blocker.exec('BEGIN IMMEDIATE');
  const denied = assert.rejects(f.admission.run('durable', 23, async () => ++writes), /coordinator-busy/);
  for (const delay of [10, 20, 30]) { t.mock.timers.tick(delay); await Promise.resolve(); }
  await denied;
  assert.deepEqual({ begins, writes, count: f.count() }, { begins: 4, writes: 0, count: 1 });
  const records = f.diagnostics.snapshot().events.filter(row => row.operation === 'storage-admission' && row.step === 5);
  assert.deepEqual(records.map(row => row.busy), [1, 2, 3, 4]);
  assert.ok(records.every(row => row.deferred === 1));
  const refusals = f.diagnostics.snapshot().events.filter(row => row.operation === 'storage-admission' && row.step === 1);
  assert.equal(refusals.length, 4);
  assert.ok(refusals.every(row => row.deferred === 1 && row.sqlErrorCode === 5
    && row.unknown === undefined && row.bodyMs === undefined));
  t.mock.timers.tick(10000); await Promise.resolve(); assert.equal(begins, 4);
  f.blocker.exec('ROLLBACK');
  assert.equal(await f.admission.run('durable', 23, async () => ++writes), 1);
  assert.equal(writes, 1); assert.equal(f.count(), 1);
  assert.doesNotMatch(JSON.stringify(records), /private-|ledger.sqlite|transient-|INSERT|SELECT|agentopsdeck-release-recover/);
});

test('synchronous BEGIN contention retains the original SQLite error and does not schedule retries', t => {
  const f = fixture(t); f.blocker.exec('BEGIN IMMEDIATE'); let writes = 0;
  assert.throws(() => f.admission.runSync('durable', 23, () => ++writes), (error: any) => error.errcode === 5);
  t.mock.timers.tick(10000); assert.equal(writes, 0); assert.equal(f.count(), 1);
  assert.equal(f.diagnostics.snapshot().events.filter(row => row.step === 5).length, 0);
});

for (const phase of ['started-begin', 'sample', 'before-commit', 'after-commit'] as const) {
  test(`async BUSY in ${phase} never becomes a retryable BEGIN refusal`, async t => {
    const f = fixture(t), exec = f.db.exec.bind(f.db);
    const original = Object.assign(Error('private-unknown-busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    let begins = 0, samples = 0, writes = 0;
    f.db.exec = sql => {
      if (sql === 'BEGIN IMMEDIATE') {
        begins++; exec(sql);
        if (phase === 'started-begin') throw original;
        return;
      }
      if (sql === 'COMMIT' && phase === 'before-commit') throw original;
      exec(sql);
      if (sql === 'COMMIT' && phase === 'after-commit') throw original;
    };
    const admission = new VolumeAdmission(f.db, f.root, Date.now, () => {
      samples++; if (phase === 'sample') throw original; return 1024n ** 3n;
    }, f.diagnostics);
    await assert.rejects(admission.run('durable', 23, async () => ++writes), error => error === original);
    t.mock.timers.tick(10000); await Promise.resolve();
    assert.equal(begins, 1); assert.equal(writes, 0);
    assert.equal(samples, phase === 'started-begin' ? 0 : 1);
    assert.equal(f.count(), phase === 'after-commit' ? 2 : 1);
    assert.equal(f.diagnostics.snapshot().events.filter(row => row.step === 5).length, 0);
  });
}

function fixture(t: any, sink: (line: string) => void = () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-release-recover-'));
  const db = new DatabaseSync(join(root, 'ledger.sqlite')), blocker = new DatabaseSync(join(root, 'ledger.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1');
  const business = new DatabaseSync(':memory:'); business.exec('CREATE TABLE writes(value INTEGER)');
  const diagnostics = new PerformanceDiagnostics(sink);
  const volume = String(statSync(root, {bigint:true}).dev);
  const admission = new VolumeAdmission(db,root,Date.now,()=>1024n ** 3n,diagnostics);
  const count = () => Number(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n);
  const rows = () => diagnostics.snapshot().events.filter(r=>r.operation === 'storage-admission-release-recovery');
  const other = new StorageWorkAdmission(db), otherId = 'transient-' + randomUUID();
  other.startTransient(volume,otherId,'recovery',17,()=>({freeBytes:1024n ** 3n,observedAt:Date.now()}));
  let calls=0, closed=false;
  const businessError=Error('private-original-error');
  const write=(fails=false)=>{calls++;business.exec('INSERT INTO writes VALUES(42)');blocker.exec('BEGIN IMMEDIATE');if(fails)throw businessError;return 42;};
  const close=()=>{if(!closed){db.close();closed=true;}};
  t.after(()=>{if(blocker.isTransaction)blocker.exec('ROLLBACK');blocker.close();close();business.close();rmSync(root,{recursive:true,force:true});});
  return {root,db,blocker,business,diagnostics,volume,admission,count,rows,otherId,write,close,businessError,calls:()=>calls};
}

for(const mode of ['sync','async'] as const) for(const fails of [false,true]) test(mode+' known BEGIN BUSY recovers only original quiescent lease; business failure='+fails,async t=>{
  const f=fixture(t);
  if(mode==='sync') assert.throws(()=>f.admission.runSync('durable',23,()=>f.write(fails)),(e:any)=>fails?e===f.businessError:e.errcode===5);
  else await assert.rejects(f.admission.run('durable',23,async()=>f.write(fails)),(e:any)=>fails?e===f.businessError:e.errcode===5);
  assert.equal(f.count(),2); assert.equal(f.calls(),1);
  t.mock.timers.tick(250);assert.equal(f.count(),2);assert.equal(f.rows().at(-1)?.pending,1);
  f.blocker.exec('ROLLBACK');t.mock.timers.tick(250);
  assert.equal(f.count(),1);assert.equal(f.calls(),1);
  assert.equal(f.business.prepare('SELECT count(*) n FROM writes').get()!.n,1);
  assert.equal(f.db.prepare('SELECT request FROM storage_work_reservations').get()!.request,f.otherId);
  assert.equal(f.rows().at(-1)?.recovered,1);assert.equal(f.rows().at(-1)?.unknown,undefined);
  assert.equal(f.db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
  assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()),/private-|ledger.sqlite|transient-|INSERT|SELECT|agentopsdeck-release-recover/);
});

test('unknown COMMIT acknowledgement never schedules cleanup again',t=>{
  const f=fixture(t),exec=f.db.exec.bind(f.db);let commits=0,releases=0;
  f.db.exec=(sql:string)=>{exec(sql);if(sql==='COMMIT'&&++commits===2)throw Object.assign(Error('private-after-commit'),{code:'ERR_SQLITE_ERROR',errcode:5});};
  assert.throws(()=>f.admission.runSync('durable',23,()=>++releases),/private-after-commit/);
  assert.equal(f.count(),1);t.mock.timers.tick(10000);assert.equal(commits,2);assert.equal(releases,1);assert.equal(f.rows().length,0);
});

test('retry body failure stops retries and preserves exact lease',t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()),(e:any)=>e.errcode===5);f.blocker.exec('ROLLBACK');
  f.db.exec("CREATE TRIGGER stop_cleanup BEFORE DELETE ON storage_work_reservations BEGIN SELECT RAISE(ABORT,'private-stop'); END");
  t.mock.timers.tick(250);assert.equal(f.count(),2);assert.equal(f.rows().at(-1)?.unknown,1);assert.equal(f.rows().at(-1)?.recovered,undefined);
  f.db.exec('DROP TRIGGER stop_cleanup');t.mock.timers.tick(10000);assert.equal(f.count(),2);assert.equal(f.rows().length,1);assert.equal(f.calls(),1);
});

test('closed original owner is never reopened or retried again',t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');f.close();
  t.mock.timers.tick(250);assert.equal(f.rows().at(-1)?.unknown,1);t.mock.timers.tick(10000);assert.equal(f.rows().length,1);assert.equal(f.calls(),1);
});

test('changed exact receipt refuses recovery rather than deleting another payload',t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');
  const row=f.db.prepare('SELECT request,payload FROM storage_work_reservations WHERE request<>?').get(f.otherId)!;
  const value=JSON.parse(String(row.payload));value.bytes=24;
  // Deliberate persisted corruption: even a plausible altered receipt cannot release.
  f.db.prepare('UPDATE storage_work_reservations SET payload=? WHERE request=?').run(JSON.stringify(value),String(row.request));
  t.mock.timers.tick(250);assert.equal(f.count(),2);assert.equal(f.rows().at(-1)?.unknown,1);t.mock.timers.tick(10000);assert.equal(f.rows().length,1);
});

test('128-entry recovery budget never evicts an unknown lease or retries business',t=>{
  const f=fixture(t),exec=f.db.exec.bind(f.db);let begins=0,calls=0;
  const busy=Object.assign(Error('private-busy'),{code:'ERR_SQLITE_ERROR',errcode:5});
  f.db.exec=(sql:string)=>{if(sql==='BEGIN IMMEDIATE'&&++begins%2===0)throw busy;exec(sql);};
  for(let i=0;i<129;i++)assert.throws(()=>f.admission.runSync('durable',23,()=>++calls),e=>e===busy);
  assert.equal(f.count(),130);assert.equal(calls,129);f.db.exec=exec;
  for(let i=0;i<128;i++)t.mock.timers.tick(250);
  assert.equal(f.count(),2);t.mock.timers.tick(10000);assert.equal(f.count(),2);assert.equal(calls,129);
});

test('unsettled Promise has no recovery permission even when time advances',async t=>{
  const f=fixture(t);let resolve!:()=>void;const p=new Promise<void>(r=>resolve=r);
  assert.throws(()=>f.admission.runSync('durable',23,(()=>p) as any),/must be synchronous/);
  t.mock.timers.tick(10000);assert.equal(f.count(),2);assert.equal(f.rows().length,0);
  f.blocker.exec('BEGIN IMMEDIATE');resolve();await Promise.resolve();await Promise.resolve();assert.equal(f.count(),2);
  f.blocker.exec('ROLLBACK');t.mock.timers.tick(250);assert.equal(f.count(),1);assert.equal(f.rows().at(-1)?.recovered,1);
});

test('removed original volume path stops retries even after path is restored',t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');
  const moved=f.root+'-moved';renameSync(f.root,moved);
  try { t.mock.timers.tick(250);assert.equal(f.rows().at(-1)?.unknown,1); }
  finally { renameSync(moved,f.root); }
  assert.equal(f.count(),2);const observed=f.rows().length;t.mock.timers.tick(10000);
  assert.equal(f.count(),2);assert.equal(f.rows().length,observed);assert.equal(f.calls(),1);
});

for(const committed of [false,true]) test('retry COMMIT uncertainty never replays cleanup; committed='+committed,t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');
  const exec=f.db.exec.bind(f.db);let commitCalls=0;
  f.db.exec=(sql:string)=>{if(sql==='COMMIT'){commitCalls++;if(committed)exec(sql);throw Object.assign(Error('private-retry-commit'),{code:'ERR_SQLITE_ERROR',errcode:5});}exec(sql);};
  t.mock.timers.tick(250);assert.equal(f.rows().at(-1)?.unknown,1);assert.equal(commitCalls,1);
  assert.equal(f.count(),committed?1:2);assert.equal(f.db.isTransaction,false);f.db.exec=exec;
  const observed=f.rows().length;t.mock.timers.tick(10000);assert.equal(f.rows().length,observed);assert.equal(f.calls(),1);
});

test('retry body plus rollback failure retains charged lease and original owner',t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');
  f.db.exec("CREATE TRIGGER deny_recovery BEFORE DELETE ON storage_work_reservations BEGIN SELECT RAISE(ABORT,'private-retry-body'); END");
  const exec=f.db.exec.bind(f.db);let rollbackCalls=0;
  f.db.exec=(sql:string)=>{if(sql==='ROLLBACK'){rollbackCalls++;throw Object.assign(Error('private-retry-rollback'),{code:'ERR_SQLITE_ERROR',errcode:5});}exec(sql);};
  t.mock.timers.tick(250);assert.equal(f.rows().at(-1)?.unknown,1);assert.equal(rollbackCalls,1);assert.equal(f.db.isTransaction,true);
  f.db.exec=exec;exec('ROLLBACK');assert.equal(f.count(),2);const observed=f.rows().length;t.mock.timers.tick(10000);
  assert.equal(f.rows().length,observed);assert.equal(f.calls(),1);
});

test('BEGIN that actually started before BUSY acknowledgement is not a refusal receipt',t=>{
  const f=fixture(t),exec=f.db.exec.bind(f.db);let begins=0;
  f.db.exec=(sql:string)=>{exec(sql);if(sql==='BEGIN IMMEDIATE'&&++begins===2)throw Object.assign(Error('private-started-begin'),{code:'ERR_SQLITE_ERROR',errcode:5});};
  let writes=0;assert.throws(()=>f.admission.runSync('durable',23,()=>++writes));f.db.exec=exec;
  assert.equal(f.db.isTransaction,false);assert.equal(f.count(),2);t.mock.timers.tick(10000);assert.equal(f.count(),2);assert.equal(f.rows().length,0);assert.equal(writes,1);
});

test('valid altered exact receipt cannot authorize cleanup under original expected payload',t=>{
  const f=fixture(t);assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');
  const row=f.db.prepare('SELECT request,payload FROM storage_work_reservations WHERE request<>?').get(f.otherId)!;
  const value=JSON.parse(String(row.payload));value.bytes=24;value.fingerprint=createHash('sha256').update(JSON.stringify([value.workClass,value.bytes])).digest('hex');
  f.db.prepare('UPDATE storage_work_reservations SET payload=? WHERE request=?').run(JSON.stringify(value),String(row.request));
  t.mock.timers.tick(250);assert.equal(f.count(),2);assert.equal(f.rows().at(-1)?.unknown,1);t.mock.timers.tick(10000);assert.equal(f.rows().length,1);
});

test('successful recovery is retained despite saturated routine logs and throwing sink',t=>{
  const f=fixture(t,()=>{throw Error('private-log-sink');});
  for(let i=0;i<100;i++) f.diagnostics.start('storage-admission').finish();
  assert.throws(()=>f.admission.runSync('durable',23,()=>f.write()));f.blocker.exec('ROLLBACK');t.mock.timers.tick(250);
  assert.equal(f.count(),1);assert.equal(f.rows().at(-1)?.recovered,1);assert.equal(f.rows().at(-1)?.delivery,'failed');assert.equal(f.calls(),1);
});

test('reentrant recovery logging cannot exceed budget or evict original requests',t=>{
  let nested: (()=>void)|undefined;
  const f=fixture(t,line=>{if(JSON.parse(line).operation==='storage-admission-release-recovery') {const invoke=nested;nested=undefined;invoke?.();}});
  const exec=f.db.exec.bind(f.db),busy=Object.assign(Error('private-budget'),{code:'ERR_SQLITE_ERROR',errcode:5});let begins=0,writes=0;
  const rejectEveryRelease=(sql:string)=>{if(sql==='BEGIN IMMEDIATE'&&++begins%2===0)throw busy;exec(sql);};
  f.db.exec=rejectEveryRelease;for(let i=0;i<128;i++)assert.throws(()=>f.admission.runSync('durable',23,()=>++writes),e=>e===busy);
  f.db.exec=exec;nested=()=>{begins=0;f.db.exec=rejectEveryRelease;try {assert.throws(()=>f.admission.runSync('durable',23,()=>++writes),e=>e===busy);}finally{f.db.exec=exec;}};
  t.mock.timers.tick(250);for(let i=0;i<127;i++)t.mock.timers.tick(250);
  assert.equal(writes,129);assert.equal(f.count(),2);t.mock.timers.tick(10000);assert.equal(f.count(),2);
});
