import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VolumeAdmission } from './volume-admission.js';
import { StorageWorkAdmission } from './work-admission.js';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { checkpointOwnedWal } from './owned-sqlite.js';
const MiB = 1024 ** 2;
const sourceExecution = import.meta.url.endsWith('.ts');
const admissionModule = new URL(sourceExecution ? './volume-admission-worker.ts' : './volume-admission-worker.js', import.meta.url).href;
const admissionClassModule = new URL(sourceExecution ? './volume-admission.ts' : './volume-admission.js', import.meta.url).href;
const loaderArgs = sourceExecution ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))] : [];
// Exercise the production module in an actual worker, including its parent-port
// guard, native connection ownership, fault retention and Windows ACL checks.
function workerProgram(body: string) {
  const loader = sourceExecution ? import.meta.resolve('tsx/esm/api') : undefined;
  const transformed = body.replace(/import\s+(\{[^}]+\}|[A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2\s*;/g,
    (_match, binding: string, _quote: string, url: string) => binding.startsWith('{')
      ? `const ${binding.replace(/\s+as\s+/g, ': ')} = await load(${JSON.stringify(url)});`
      : `const {default: ${binding}} = await load(${JSON.stringify(url)});`);
  const code = `(async () => {
    const {parentPort,workerData} = require('node:worker_threads');
    const api = workerData.loader ? await import(workerData.loader) : undefined;
    // All imports must share one loader namespace so fault injection observes
    // the exact production diagnostics/startup-owner singletons, not copies.
    const scoped = api?.register({namespace: 'volume-admission-fixture'});
    const load = url => scoped && url.endsWith('.ts') ? scoped.import(url, workerData.entry) : import(url);
    ${transformed}
    parentPort.close();
  })().catch(error => { console.error(error); process.exit(1); });`;
  return `import {Worker} from 'node:worker_threads';
    const worker = new Worker(${JSON.stringify(code)}, {eval:true,execArgv:[],workerData:${JSON.stringify({ loader, entry: admissionModule })}});
    worker.on('error',error => {console.error(error);process.exitCode=1;});
    worker.on('exit',code => {if(code)process.exitCode=code;});`;
}
test('destination facades share schema setup without sharing paths or stale space samples', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-volume-schema-'));
  const db = new DatabaseSync(':memory:'); let creates = 0, samples = 0;
  const exec = db.exec.bind(db);
  db.exec = sql => { if (sql.includes('CREATE TABLE')) creates++; return exec(sql); };
  try {
    for (let i = 0; i < 4; i++) {
      const admission = new VolumeAdmission(db, root, Date.now, () => { samples++; return BigInt(1024 * MiB); });
      admission.runSync('durable', MiB, () => {});
    }
    assert.equal(creates, 2);
    assert.equal(samples, 4);
    const removed = join(root, 'removed'); mkdirSync(removed);
    const stale = new VolumeAdmission(db, removed);
    rmSync(removed, { recursive: true });
    assert.throws(() => stale.runSync('durable', MiB, () => assert.fail('must not write')), /ENOENT/);
    assert.equal(creates, 2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('pressure schema created in a rolled-back outer transaction is never memoized', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-volume-rollback-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('BEGIN'); new VolumeAdmission(db, root); db.exec('ROLLBACK');
    new VolumeAdmission(db, root, Date.now, () => BigInt(1024 * MiB)).runSync('durable', MiB, () => {});
    assert.equal(db.prepare('SELECT count(*) n FROM storage_volume_pressure').get()!.n, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('production coordinator admits a bounded write on the current platform', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', workerProgram(`
    import assert from 'node:assert/strict'; import {tmpdir} from 'node:os';
    import {volumeAdmission} from ${JSON.stringify(admissionModule)};
    assert.equal(volumeAdmission(tmpdir()).runSync('durable', 1024, () => 42), 42);
  `)], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.status, 0, child.stderr);
});
test('production coordinator cannot open a database on the main thread', () => {
  const child = spawnSync(process.execPath, [...loaderArgs, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    await assert.rejects(import(${JSON.stringify(admissionModule)}), /requires a parent/);
  `], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.status, 0, child.stderr);
});
test('disk WAL checkpoint without an explicit synchronous admission port defers before SQL', () => {
  const db = new DatabaseSync(':memory:');
  const prepare = db.prepare;
  let calls = 0;
  db.prepare = () => { calls++; throw Error('must not query WAL'); };
  try {
    assert.deepEqual(checkpointOwnedWal(db, '/absent/owned.sqlite'), { deferred: true });
    assert.equal(calls, 0);
  } finally { db.prepare = prepare; db.close(); }
});
for (const fault of ['initialization', 'schema', 'lost-close-ack'] as const) {
  test(`production coordinator startup retains its original owner and outcome (${fault})`, { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-volume-startup-'));
    const diagnosticsModule = new URL(sourceExecution ? '../diagnostics/performance.ts' : '../diagnostics/performance.js', import.meta.url).href;
    const recoveryModule = new URL(sourceExecution ? './connection-recovery.ts' : './connection-recovery.js', import.meta.url).href;
    const code = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { tmpdir } from 'node:os';
      import { setTimeout as pause } from 'node:timers/promises';
      import { volumeAdmission } from ${JSON.stringify(admissionModule)};
      import { performanceDiagnostics } from ${JSON.stringify(diagnosticsModule)};
      import { StorageConnectionUnavailable } from ${JSON.stringify(recoveryModule)};
      const fault = ${JSON.stringify(fault)}, original = Error('private-startup-fault');
      const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
      let first, closes = 0, attempts = 0;
      DatabaseSync.prototype.exec = function(sql) {
        if ((fault === 'schema' && sql.includes('CREATE TABLE IF NOT EXISTS storage_volume_pressure'))
          || (fault !== 'schema' && sql.includes('PRAGMA busy_timeout=1000'))) {
          first ??= this; attempts++; throw original;
        }
        return exec.call(this, sql);
      };
      DatabaseSync.prototype.close = function() {
        assert.equal(this, first); closes++;
        if (fault === 'lost-close-ack') close.call(this);
        throw Error('private-close-fault');
      };
      try {
        assert.throws(() => volumeAdmission(tmpdir()), error => error === original);
        assert.equal(closes, 1); assert.equal(attempts, 1);
        const row = performanceDiagnostics.snapshot().events.find(e => e.operation === 'storage-coordinator-startup');
        assert.equal(row.step, fault === 'schema' ? 3 : 2); assert.equal(row.category, 'failed');
        assert.doesNotMatch(JSON.stringify(row), /private-|PRAGMA|CREATE|sqlite/);
        if (fault !== 'lost-close-ack') {
          assert.equal(first.isOpen, true);
          assert.throws(() => volumeAdmission(tmpdir()), StorageConnectionUnavailable);
          assert.equal(attempts, 1); assert.equal(closes, 1);
          await pause(1050);
          DatabaseSync.prototype.close = function() { assert.equal(this, first); closes++; return close.call(this); };
        } else {
          assert.equal(first.isOpen, false);
          DatabaseSync.prototype.close = close;
        }
        DatabaseSync.prototype.exec = exec;
        assert.equal(volumeAdmission(tmpdir()).runSync('durable', 1024, () => 42), 42);
        assert.equal(first.isOpen, false); assert.equal(attempts, 1);
        assert.equal(closes, fault === 'lost-close-ack' ? 1 : 2);
      } finally {
        DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close;
        if (first?.isOpen) close.call(first);
      }
    `;
    try {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', workerProgram(code)], {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, encoding: 'utf8', timeout: 25_000,
      });
      assert.equal(child.status, 0, child.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('Windows production coordinator refuses an existing broad-access directory', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'unsafe-volume-coordinator-'));
  try {
    const sid = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)'], { encoding: 'utf8' }).trim();
    mkdirSync(join(root, `agentopsdeck-storage-admission-${sid}`));
    const child = spawnSync(process.execPath, [...loaderArgs, '--input-type=module', '-e',
      workerProgram(`import assert from 'node:assert/strict'; import {tmpdir} from 'node:os'; import {volumeAdmission} from ${JSON.stringify(admissionModule)}; assert.throws(()=>volumeAdmission(tmpdir()), /unsafe-coordinator-directory/);`)],
    { encoding: 'utf8', env: { ...process.env, TEMP: root, TMP: root }, timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real bounded SQLite FULL rolls back transaction and shares pressure without filling host disk', () => fixture(async (a, b, ledger, root) => {
  const file = join(root, 'bounded.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence(id INTEGER PRIMARY KEY,value BLOB); INSERT INTO evidence VALUES(1,123)');
    const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count);
    db.exec(`PRAGMA max_page_count=${pages + 1}`);
    let failure: unknown;
    try {
      a.runSync('durable', MiB, () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE evidence SET value=? WHERE id=1').run(Buffer.alloc(256 * 1024));
          db.exec('COMMIT');
        } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      });
    } catch (error) { failure = error; }
    assert.equal((failure as { code: string }).code, 'ERR_SQLITE_ERROR');
    assert.equal((failure as { errcode: number }).errcode, 13);
    assert.equal(db.prepare('SELECT value FROM evidence WHERE id=1').get()!.value, 123);
    assert.equal(db.isTransaction, false);
    assert.throws(() => b.runSync('durable', 1024, () => assert.fail('must not run')), /backoff/);
    assert.equal(b.runSync('recovery', 1024, () => db.prepare('SELECT value FROM evidence').get()!.value), 123);
    assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
    assert.ok(statSync(file).size < MiB);
  } finally { db.close(); }
}));
test('non-FULL SQLite errors do not poison physical volume admission', () => fixture(async (a, b) => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => a.runSync('durable', 1024, () => db.exec('SELECT * FROM missing_table')), /no such table/);
    assert.equal(b.runSync('durable', 1024, () => 42), 42);
  } finally { db.close(); }
}));
test('synchronous owner checkpoint shares recovery budget and defers before touching WAL', () => fixture(async (a, b, ledger, root, set) => {
  const file = join(root, 'owned.sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(value); INSERT INTO fixture VALUES(1)');
    set(0, 1000); const before = statSync(file).size;
    assert.deepEqual(checkpointOwnedWal(db, file, () => a), { deferred: true });
    assert.equal(statSync(file).size, before);
    set(800 * MiB, 1000); const result = checkpointOwnedWal(db, file, () => b);
    assert.equal(result.deferred, false); if (!result.deferred) assert.ok(result.checkpointedFrames > 0);
    assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
    db.exec('BEGIN'); assert.deepEqual(checkpointOwnedWal(db, file, () => { throw Error('must not admit transaction'); }), { deferred: true }); db.exec('ROLLBACK');
  } finally { db.close(); }
}));

test('sync durability admission preserves SQL failure and releases only once quiescent', () => fixture(async (a, b, ledger, root, set) => {
  const failure = Object.assign(Error('synthetic full'), { code: 'SQLITE_FULL' });
  assert.throws(() => a.runSync('durable', MiB, () => { throw failure; }), error => error === failure);
  assert.throws(() => b.runSync('durable', MiB, () => 1), /backoff/);
  assert.equal(b.runSync('recovery', MiB, () => 7), 7);
  assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
}));
async function fixture(fn: (a: VolumeAdmission, b: VolumeAdmission, db: DatabaseSync, root: string, set: (n: number, t: number) => void) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-volume-test-')), file = join(root, 'ledger.sqlite');
  const one = new DatabaseSync(file), two = new DatabaseSync(file); let free = 800 * MiB, now = 1000;
  try { await fn(new VolumeAdmission(one, root, () => now, () => BigInt(free)), new VolumeAdmission(two, root, () => now, () => BigInt(free)), one, root, (f, t) => { free = f; now = t; }); }
  finally { two.close(); one.close(); rmSync(root, { recursive: true, force: true }); }
}
test('two DB connections share physical-volume credits until actual writer quiesces', () => fixture(async (a, b, db, root, set) => {
  let finish!: () => void, calls = 0;
  const writing = a.run('projection', 256 * MiB, () => new Promise<void>(resolve => { calls++; finish = resolve; }));
  await assert.rejects(b.run('projection', 64 * MiB, async () => { calls++; }), /space/);
  assert.equal(calls, 1); finish(); await writing;
  set(800 * MiB, 2100); await b.run('projection', MiB, async () => { calls++; }); assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
}));
test('shared backoff/hysteresis does not block recovery, and ENOSPC propagates original error', () => fixture(async (a, b, db, root, set) => {
  set(510 * MiB, 1000); await assert.rejects(a.run('projection', MiB, async () => {}), /space/);
  set(550 * MiB, 2000); await assert.rejects(b.run('projection', MiB, async () => {}), /space/);
  await b.run('recovery', MiB, async () => {});
  set(900 * MiB, 3100); const full = Object.assign(Error('full'), { code: 'ENOSPC' });
  await assert.rejects(a.run('projection', MiB, async () => { throw full; }), e => e === full);
  await assert.rejects(b.run('projection', MiB, async () => {}), /backoff/);
  assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
}));
test('crashed started leases survive new coordinator; only explicit original-operation reconciliation frees them', () => fixture(async (a, b, db, root, set) => {
  const volume = String(statSync(root, { bigint: true }).dev), ledger = new StorageWorkAdmission(db, () => 1000);
  ledger.reserve(volume, 'crash-operation', 'projection', 256 * MiB, { freeBytes: BigInt(800 * MiB), observedAt: 1000 });
  ledger.claim(volume, 'crash-operation'); set(800 * MiB, 100_000);
  await assert.rejects(b.run('projection', 64 * MiB, async () => {}), /space/);
  assert.throws(() => ledger.retireTransient(volume, 'crash-operation'), /persistent/);
  ledger.release(volume, 'crash-operation'); set(900 * MiB, 102_000);
  await b.run('projection', MiB, async () => {});
}));

test('independent OS process holds shared credits, releases on quiescence and retains charge after crash', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-volume-process-')), file = join(root, 'ledger.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000');
  const admission = new VolumeAdmission(db, root, Date.now, () => BigInt(800 * MiB));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = async () => {
    const child = spawn(process.execPath, [...loaderArgs,
      '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { VolumeAdmission } from ${JSON.stringify(admissionClassModule)};
      const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=2000');
      const a = new VolumeAdmission(db, process.argv[2], Date.now, () => BigInt(800 * 1024 ** 2));
      await a.run('recovery', 256 * 1024 ** 2, () => new Promise(resolve => {
        process.once('message', () => resolve()); process.send('holding');
      }));
      db.close(); process.disconnect();
    `, file, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let errors = ''; child.stderr!.on('data', data => { errors += String(data).slice(0, 4096); });
    const ready = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw Error(`child failed: ${errors}`); })]);
    assert.equal(ready, 'holding'); return child;
  };
  try {
    const child = await launch(); let ran = false;
    await assert.rejects(admission.run('projection', 64 * MiB, async () => { ran = true; }), /space/);
    assert.equal(ran, false);
    const ended = once(child, 'exit'); child.send!('release'); await ended;
    // Recovery bypasses pressure cooldown, while still charging shared credits.
    await admission.run('recovery', MiB, async () => { ran = true; }); assert.equal(ran, true);
    const crashed = await launch(), exited = once(crashed, 'exit'); crashed.kill('SIGKILL'); await exited;
    const lease = db.prepare('SELECT payload FROM storage_work_reservations').all();
    assert.equal(lease.length, 1); assert.equal(JSON.parse(String(lease[0]!.payload)).state, 'started');
    await assert.rejects(admission.run('recovery', 500 * MiB, async () => {}), /space/);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
