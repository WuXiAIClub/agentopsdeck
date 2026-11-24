import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VolumeAdmission } from './volume-admission.js';
import { StorageWorkAdmission } from './work-admission.js';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

// Private file and real owners: no production/shared coordinator is locked.
// These faults differ in whether release committed, but NEVER replay business.
for (const fault of ['finish-ack-lost', 'release-commit-before', 'release-commit-after', 'release-rollback-lost'] as const) {
  for (const outcome of ['success', 'error', 'full'] as const) {
    const failedWriter = outcome !== 'success';
    test(`real ${fault} with ${outcome} committed writer reconciles only original charge`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-release-proof-'));
      const file = join(directory, 'ledger.sqlite');
      const db = new DatabaseSync(file), business = new DatabaseSync(join(directory, 'business.sqlite'));
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
      business.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE writes(value INTEGER)');
      new VolumeAdmission(db, directory);
      const volume = String((await stat(directory, { bigint: true })).dev);
      const ledger = new StorageWorkAdmission(db), foreign = `transient-${randomUUID()}`;
      const sample = () => ({ freeBytes: 1024n ** 3n, observedAt: Date.now() });
      ledger.startTransient(volume, foreign, 'recovery', 1, sample);
      ledger.reserve(volume, 'external-command', 'recovery', 1, sample); ledger.claim(volume, 'external-command');
      const baseline = db.prepare('SELECT request,payload FROM storage_work_reservations ORDER BY request').all();
      const launch = (injected = false) => new Worker(`(async () => {
        const {workerData,parentPort}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite');
        const load=workerData.loader ? (await import(workerData.loader)).tsImport : url=>import(url);
        const {VolumeAdmission}=await load(workerData.volume,workerData.volume);
        const {installVolumeAdmissionProtocol}=await load(workerData.protocol,workerData.protocol);
        const db=new DatabaseSync(workerData.file);
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
        const ledger=new VolumeAdmission(db,workerData.root);
        let finishing=false, injected=false;
        const exec=db.exec.bind(db);
        db.exec=sql=>{
          if(workerData.injected && finishing && injected && workerData.fault==='release-rollback-lost' && sql==='ROLLBACK') {
            throw Object.assign(new Error('private rollback fault'),{code:'ERR_SQLITE_ERROR',errcode:10});
          }
          if (workerData.injected && finishing && !injected && sql==='COMMIT'
            && workerData.fault!=='finish-ack-lost') {
            injected=true;
            if(workerData.fault==='release-commit-after') exec(sql);
            throw Object.assign(new Error('private release fault'),{code:'ERR_SQLITE_ERROR',errcode:10});
          }
          return exec(sql);
        };
        const port={on:(event,fn)=>parentPort.on(event,value=>{
          if(value.kind==='finish') finishing=true;
          return fn(value);
        }),close:()=>parentPort.close(),postMessage:message=>{
          if(workerData.injected && workerData.fault==='finish-ack-lost' && message.kind==='finish' && message.ok) return;
          parentPort.postMessage(message);
        }};
        installVolumeAdmissionProtocol(port,()=>ledger);
        if(workerData.injected) parentPort.postMessage('fixture-ready');
      })().catch(()=>process.exit(1));`, { eval: true, execArgv: [], workerData: {
        loader: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined,
        file, root: directory, injected, fault,
        volume: new URL(import.meta.url.endsWith('.ts') ? './volume-admission.ts' : './volume-admission.js', import.meta.url).href,
        protocol: new URL(import.meta.url.endsWith('.ts') ? './volume-admission-protocol.ts' : './volume-admission-protocol.js', import.meta.url).href,
      } });
      let owner: Worker | undefined, replacement: Worker | undefined;
      try {
        owner = launch(true);
        await new Promise<void>((resolve, reject) => {
          const ready = (value: unknown) => {
            if (value !== 'fixture-ready') return;
            owner!.off('message', ready); owner!.off('error', reject); owner!.off('exit', exited); resolve();
          };
          const exited = () => reject(Error('fixture exited before ready'));
          owner!.on('message', ready); owner!.once('error', reject); owner!.once('exit', exited);
        });
        // A fulfilled termination request is NOT actual owner-exit proof.
        owner.terminate = () => Promise.resolve(1);
        let launches = 0, calls = 0;
        const rows: Record<string, unknown>[] = [], original = Object.assign(Error('original committed writer failure'),
          outcome === 'full' ? { code: 'ENOSPC' } : {});
        const admission = new AsyncVolumeAdmission(() => ++launches === 1 ? owner! : (replacement = launch()),
          new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { requestTimeoutMs: 5000, recoveryDelayMs: 1 });
        await assert.rejects(admission.run(directory, 'recovery', 7, async () => {
          calls++; business.exec('BEGIN IMMEDIATE; INSERT INTO writes VALUES(1); COMMIT');
          if (failedWriter) throw original;
          return 1;
        }), error => failedWriter ? error === original : /unavailable/.test(String(error)));
        assert.equal(calls, 1); assert.equal(business.prepare('SELECT count(*) n FROM writes').get()!.n, 1);
        assert.equal(admission.snapshot().blockedBy, 'owner-exit');
        assert.equal(admission.snapshot().recoveryProofs, 1);
        const charged = db.prepare('SELECT request FROM storage_work_reservations WHERE request NOT IN (?,?)').all(foreign, 'external-command');
        assert.equal(charged.length, fault === 'release-commit-before' || fault === 'release-rollback-lost' ? 1 : 0);
        assert.equal(db.prepare('SELECT count(*) n FROM storage_volume_pressure').get()!.n, outcome === 'full' ? 1 : 0);
        await assert.rejects(admission.run(directory, 'recovery', 8, async () => ++calls), /unavailable/);
        assert.equal(launches, 1); assert.equal(calls, 1);
        await Worker.prototype.terminate.call(owner);
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        assert.equal(await admission.run(directory, 'recovery', 9, async () => {
          calls++;
          // Foreign started/external leases survive. Only this NEW lease is added.
          assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 3);
          if (charged[0]) assert.equal(db.prepare('SELECT request FROM storage_work_reservations WHERE request=?').get(String(charged[0].request)), undefined);
          assert.equal(business.prepare('SELECT count(*) n FROM writes').get()!.n, 1);
          return 9;
        }), 9);
        assert.equal(calls, 2); assert.equal(launches, 2);
        assert.equal(admission.snapshot().recoveryProofs, 0);
        assert.equal(db.prepare('SELECT count(*) n FROM storage_volume_pressure').get()!.n, outcome === 'full' ? 1 : 0);
        assert.deepEqual(db.prepare('SELECT request,payload FROM storage_work_reservations ORDER BY request').all(), baseline);
        assert.ok(rows.some(row => row.operation === 'async-storage-admission' && row.unknown === 1));
        assert.doesNotMatch(JSON.stringify(rows), /private release fault|private rollback fault|original committed writer failure|external-command|ledger\.sqlite|business\.sqlite/);
      } finally {
        if (owner) await Worker.prototype.terminate.call(owner);
        await replacement?.terminate(); business.close(); db.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
