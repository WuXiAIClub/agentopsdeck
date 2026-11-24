import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandReceipts, CommandConflict } from './receipts.js';
import { registerCreationReceipts } from './http.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncVolumeAdmission } from '../storage/async-volume-admission.js';
import { VolumeAdmission } from '../storage/volume-admission.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';

const gate = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};
const quiet = () => new PerformanceDiagnostics(() => {});
type Admission = NonNullable<ConstructorParameters<typeof CommandReceipts>[6]>;
const create = (db: DatabaseSync, admission: Admission, diagnostics = quiet()) => new CommandReceipts(db,
  undefined, undefined, undefined, () => assert.fail('async claim must not call synchronous ledger admission'), diagnostics, admission);

test('async-only receipt owner rejects synchronous fresh claims but preserves original-only recovery', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let admissions = 0, bindings = 0, mutations = 0;
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, undefined, quiet(),
    async (_bytes, write) => { admissions++; return write(); });
  assert.throws(() => receipts.claim('scope', 'new', {}, false, undefined,
    () => { mutations++; return true; }, () => { bindings++; throw Error('must not bind'); }), /async-admission-required/);
  assert.equal(admissions, 0); assert.equal(mutations, 0); assert.equal(bindings, 0);
  assert.equal(receipts.get('scope', 'new'), undefined);
  const original = await receipts.claimAsync('scope', 'new', {});
  const duplicate = receipts.claim('scope', 'new', {}, false, undefined,
    () => { mutations++; return true; }, () => { bindings++; throw Error('must not rebind'); });
  assert.equal(duplicate.fresh, false); assert.deepEqual(duplicate.receipt, original.receipt);
  assert.equal(admissions, 1); assert.equal(mutations, 0); assert.equal(bindings, 0);
  assert.throws(() => receipts.claim('scope', 'new', { changed: true }), CommandConflict);
  assert.equal(db.isTransaction, false);
});

for (const phase of ['request', 'transaction'] as const) {
  test(`receipt rejects known async ${phase} guards before their body`, async t => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    let calls = 0, admissions = 0;
    const receipts = create(db, async (_bytes, write) => { admissions++; return write(); });
    const guard = async () => { calls++; };
    await assert.rejects(receipts.claimAsync('scope', 'key', {}, false, undefined, undefined, undefined,
      false, phase === 'request' ? guard : () => {}, phase === 'transaction' ? guard : undefined));
    assert.equal(calls, 0); assert.equal(admissions, phase === 'request' ? 0 : 1);
    assert.equal(receipts.get('scope', 'key'), undefined); assert.equal(db.isTransaction, false);
    assert.equal((await receipts.claimAsync('scope', 'healthy', {})).fresh, true);
  });
}

test('receipt refuses nonvoid request guards after physical wait, without then access or new SQL', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const entered = gate(), release = gate(); let waited = false, reads = 0;
  const receipts = create(db, async (_bytes, write) => { entered.release(); await release.promise; waited = true; return write(); });
  const guard = () => waited ? { get then() { reads++; throw Error('must not inspect then'); } } : undefined;
  const flight = receipts.claimAsync('scope', 'key', {}, false, undefined, undefined, undefined, false, guard);
  await entered.promise; release.release(); await assert.rejects(flight, /request authority/);
  assert.equal(reads, 0); assert.equal(receipts.get('scope', 'key'), undefined); assert.equal(db.isTransaction, false);
});

test('transaction authority check fences both fresh and duplicate async claims under BEGIN', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let admissions = 0, checks = 0;
  const receipts = create(db, async (_bytes, write) => { admissions++; return write(); });
  const guard = () => { assert.equal(db.isTransaction, true); checks++; };
  const first = await receipts.claimAsync('scope', 'key', {}, true, 7, undefined, undefined, false, () => {}, guard);
  const duplicate = await receipts.claimAsync('scope', 'key', {}, true, 7, undefined, undefined, false, () => {}, guard);
  assert.equal(first.receipt.id, duplicate.receipt.id); assert.equal(duplicate.fresh, false);
  assert.equal(admissions, 1); assert.equal(checks, 2); assert.equal(db.isTransaction, false);
  const refuse = () => { assert.equal(db.isTransaction, true); throw new Error('synthetic_authority_revoked'); };
  for (const key of ['key', 'new']) await assert.rejects(receipts.claimAsync('scope', key, {}, true, 7,
    undefined, undefined, false, () => {}, refuse), /synthetic_authority_revoked/);
  assert.equal(receipts.get('scope', 'new'), undefined); assert.equal(receipts.get('scope', 'key')?.id, first.receipt.id);
  assert.equal(db.isTransaction, false);
});

test('thenable transaction authority is rejected and original SQL rolls back without another admission', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE fixture(value TEXT)'); let admissions = 0, thenCalls = 0;
  const receipts = create(db, async (_bytes, write) => { admissions++; return write(); });
  const guard = () => {
    db.prepare('INSERT INTO fixture VALUES (?)').run('rolled back');
    return { then() { thenCalls++; } };
  };
  await assert.rejects(receipts.claimAsync('scope', 'key', {}, true, 7, undefined, undefined, false, () => {}, guard));
  assert.equal(receipts.get('scope', 'key'), undefined); assert.equal(db.prepare('SELECT count(*) AS n FROM fixture').get()!.n, 0);
  assert.equal(admissions, 1); assert.equal(thenCalls, 0); assert.equal(db.isTransaction, false);
});

test('coordinator recovery admits new commands but a lost release retains the exact original receipt fence', async t => {
  class Owner extends EventEmitter {
    messages: any[] = [];
    constructor(private readonly automatic = false) { super(); }
    postMessage(message: any) { this.messages.push(message); if (this.automatic) this.answer(); }
    ref() {} unref() {}
    terminate() { return Promise.resolve(1); }
    answer() { const message = this.messages.at(-1); this.emit('message', { id: message.id, kind: message.kind, ok: true,
      ...(message.kind === 'begin' ? { volume: '42' } : {}) }); }
  }
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const old = new Owner(), fresh = new Owner(true); let launches = 0, bindings = 0;
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    quiet(), { requestTimeoutMs: 40, recoveryDelayMs: 1 }, () => '42');
  const receipts = create(db, (bytes, write) => admission.run('/fixture', 'durable', bytes, write));
  const bind = () => { bindings++; return { metadata: { synthetic: true } }; };
  const first = receipts.claimAsync('scope', 'original', {}, false, undefined, undefined, bind);
  old.answer();
  await assert.rejects(first, /unavailable/);
  const original = receipts.get('scope', 'original')!;
  assert.equal(original.state, 'outcome_unknown'); assert.equal(bindings, 1);
  assert.equal(admission.snapshot().blockedBy, 'owner-exit');
  await assert.rejects(receipts.claimAsync('scope', 'before-exit', {}, false, undefined, undefined, bind), /unavailable/);
  assert.equal(bindings, 1); assert.equal(launches, 1, 'terminate resolution is not actual owner exit');
  old.emit('exit', 1);
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal((await receipts.claimAsync('scope', 'new-command', {}, false, undefined, undefined, bind)).fresh, true);
  const duplicate = await receipts.claimAsync('scope', 'original', {}, false, undefined, undefined, bind);
  assert.equal(duplicate.fresh, false); assert.equal(duplicate.receipt.id, original.id);
  assert.equal(duplicate.receipt.state, 'outcome_unknown'); assert.equal(bindings, 2);
  assert.equal(launches, 2); assert.equal(fresh.messages.length, 3);
});

test('async receipt claim waits outside SQL, snapshots identity and rechecks concurrent duplicate under the owner transaction', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const wait = gate(), payload = { message: 'original' };
  let calls = 0, callbacks = 0;
  const receipts = create(db, async (bytes, write) => {
    calls++; assert.equal(bytes, 16 * 1024 * 1024 + 65536);
    assert.equal(db.isTransaction, false); await wait.promise; return write();
  });
  const first = receipts.claimAsync('scope', 'key', payload, true, 7, () => { callbacks++; return true; });
  assert.equal(db.isTransaction, false); assert.equal(receipts.get('scope', 'key'), undefined);
  payload.message = 'changed while waiting';
  const other = new CommandReceipts(db);
  const committed = other.claim('scope', 'key', { message: 'original' }, true, 7);
  wait.release();
  const duplicate = await first;
  assert.equal(duplicate.fresh, false); assert.equal(duplicate.receipt.id, committed.receipt.id);
  assert.equal(callbacks, 0); assert.equal(calls, 1);
  assert.equal((await receipts.claimAsync('scope', 'key', { message: 'original' }, true, 7)).fresh, false);
  await assert.rejects(receipts.claimAsync('scope', 'key', payload, true, 7), /different content/);
  await assert.rejects(receipts.claimAsync('scope', 'key', { message: 'original' }, true, 8), /authority cannot change/);
  assert.equal(calls, 1, 'original receipts bypass storage pressure and do not request another lease');
});

test('concurrent async fresh claims commit exactly one binding and never wait inside the receipt transaction', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const wait = gate(); let admissions = 0, bindings = 0;
  const receipts = create(db, async (_bytes, write) => { admissions++; await wait.promise; return write(); });
  const bind = () => { assert.equal(db.isTransaction, true); bindings++; return { metadata: { synthetic: true } }; };
  const first = receipts.claimAsync('scope', 'key', {}, false, undefined, undefined, bind);
  const second = receipts.claimAsync('scope', 'key', {}, false, undefined, undefined, bind);
  assert.equal(db.isTransaction, false); assert.equal(admissions, 2); wait.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.fresh), [true, false]);
  assert.equal(results[0].receipt.id, results[1].receipt.id); assert.equal(bindings, 1);
});

for (const when of ['before-wait', 'during-wait'] as const) test(`async claim preserves caller transaction at ${when}`, async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); });
  const wait = gate(); let calls = 0;
  const receipts = create(db, async (_bytes, write) => { calls++; await wait.promise; return write(); });
  if (when === 'before-wait') db.exec('BEGIN');
  const work = receipts.claimAsync('scope', 'key', {});
  if (when === 'during-wait') { db.exec('BEGIN'); wait.release(); }
  await assert.rejects(work, /owning database boundary/);
  assert.equal(db.isTransaction, true); assert.equal(receipts.get('scope', 'key'), undefined);
  assert.equal(calls, when === 'before-wait' ? 0 : 1);
});

test('async claim validates before charging and rolls back binding SQL on original callback failure', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE fixture(value TEXT)'); let admissions = 0;
  const receipts = create(db, async (_bytes, write) => { admissions++; return write(); });
  await assert.rejects(receipts.claimAsync('scope', 'invalid key', {}), /Invalid command key/);
  await assert.rejects(receipts.claimAsync('scope', 'key', {}, true, 0), /Invalid command authority/);
  assert.equal(admissions, 0);
  const original = Error('private binding failure');
  await assert.rejects(receipts.claimAsync('scope', 'key', {}, false, undefined, undefined, () => {
    db.prepare('INSERT INTO fixture VALUES (?)').run('private'); throw original;
  }), error => error === original);
  assert.equal(receipts.get('scope', 'key'), undefined); assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('SELECT count(*) n FROM fixture').get()!.n, 0);
});

test('lost ledger release acknowledgment logs committed uncertainty and retains the original replay fence', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const rows: any[] = []; let admissions = 0, callbacks = 0;
  const original = Error('private coordinator failure');
  const receipts = create(db, async (_bytes, write) => { admissions++; await write(); throw original; },
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  await assert.rejects(receipts.claimAsync('private-scope', 'private-key', { secret: 'private-content' },
    false, undefined, () => { callbacks++; return true; }), error => error === original);
  const committed = receipts.get('private-scope', 'private-key')!;
  assert.equal(committed.state, 'outcome_unknown'); assert.equal(db.isTransaction, false);
  const failed = rows.find(row => row.operation === 'command-receipt-admission');
  assert.equal(failed.category, 'failed'); assert.equal(failed.unknown, 1); assert.equal(failed.changed, 1);
  assert.ok(failed.queueMs >= 0); assert.ok(failed.bodyMs >= 0);
  assert.ok(failed.releaseMs >= 0);
  assert.doesNotMatch(JSON.stringify(rows), /private|secret|SELECT|INSERT/);
  const duplicate = await receipts.claimAsync('private-scope', 'private-key', { secret: 'private-content' });
  assert.equal(duplicate.fresh, false); assert.equal(duplicate.receipt.id, committed.id);
  assert.equal(admissions, 1); assert.equal(callbacks, 1);
});

test('diagnostic sink failure cannot change async receipt admission or its duplicate result', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const receipts = create(db, async (_bytes, write) => write(), new PerformanceDiagnostics(() => { throw Error('sink'); }));
  assert.equal((await receipts.claimAsync('scope', 'key', {})).fresh, true);
  assert.equal((await receipts.claimAsync('scope', 'key', {})).fresh, false);
});

test('legacy async entry retains synchronous admission and canonicalizes caller payload exactly once', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let admissions = 0, reads = 0;
  const receipts = new CommandReceipts(db, undefined, undefined, undefined,
    (_bytes, write) => { admissions++; return write(); }, quiet());
  const payload = { get fixture() { reads++; return 'value'; } };
  assert.equal((await receipts.claimAsync('scope', 'key', payload)).fresh, true);
  assert.equal(admissions, 1); assert.equal(reads, 1);
  assert.equal((await receipts.claimAsync('scope', 'key', { fixture: 'value' })).fresh, false);
  assert.equal(admissions, 1);
});

const path = '/sessions', scope = 'actor-scope';
const request = (app: Hono, signal?: AbortSignal) => app.request(path, { method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': 'key' }, body: '{"title":"fixture"}', ...(signal ? { signal } : {}) });

test('HTTP admission denial returns sanitized 503, logs deferred queue time and never claims or dispatches', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const rows: any[] = [];
  const receipts = create(db, async () => { throw new StorageAdmissionDeferred('private-denial'); },
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const app = new Hono(); registerCreationReceipts(app, path, { receipts, scope: () => scope });
  app.post(path, () => assert.fail('denied admission cannot dispatch'));
  const response = await request(app); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Command storage admission unavailable' });
  assert.equal(receipts.get(JSON.stringify(['create', scope]), 'key'), undefined);
  const trace = rows.find(row => row.operation === 'command-receipt-admission');
  assert.equal(trace.deferred, 1); assert.equal(trace.unknown, undefined); assert.equal(trace.category, 'failed');
  assert.ok(trace.queueMs >= 0); assert.doesNotMatch(JSON.stringify(rows), /private-denial/);
});

for (const change of ['revoke', 'replace', 'abort'] as const) test(`HTTP ${change} during async admission never commits a receipt or dispatches`, async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const wait = gate(), entered = gate(), controller = new AbortController();
  let authorized = true, currentScope = scope, writes = 0;
  const receipts = create(db, async (_bytes, write) => { entered.release(); await wait.promise; return write(); });
  const app = new Hono(); app.onError(error => new Response('rejected', { status: error instanceof HTTPException ? error.status : 499 }));
  registerCreationReceipts(app, path, { receipts, scope: () => {
    if (!authorized) throw new HTTPException(403); return currentScope;
  } });
  app.post(path, c => { writes++; return c.json({ ok: true }); });
  const work = request(app, controller.signal); await entered.promise;
  assert.equal(db.isTransaction, false);
  if (change === 'revoke') authorized = false;
  else if (change === 'replace') currentScope = 'replacement';
  else controller.abort();
  wait.release(); assert.equal((await work).status, change === 'abort' ? 499 : 403);
  assert.equal(writes, 0); assert.equal(receipts.get(JSON.stringify(['create', scope]), 'key'), undefined);
});

for (const change of ['revoke', 'lost-release'] as const) test(`HTTP ${change} after receipt commit preserves unknown receipt without dispatch/replay`, async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let authorized = true, writes = 0, admissions = 0;
  const receipts = create(db, async (_bytes, write) => {
    admissions++; const result = await write();
    if (change === 'lost-release') throw Error('lost release');
    authorized = false; return result;
  });
  const app = new Hono(); app.onError(error => new Response('rejected', { status: error instanceof HTTPException ? error.status : 503 }));
  registerCreationReceipts(app, path, { receipts, scope: () => { if (!authorized) throw new HTTPException(403); return scope; } });
  app.post(path, c => { writes++; return c.json({ ok: true }); });
  assert.equal((await request(app)).status, change === 'revoke' ? 403 : 503);
  const committed = receipts.get(JSON.stringify(['create', scope]), 'key')!;
  assert.equal(committed.state, 'outcome_unknown'); authorized = true;
  assert.equal((await request(app)).status, 202); assert.equal(writes, 0); assert.equal(admissions, 1);
});

test('HTTP rechecks authority at Promise delivery before dispatch, not only inside claimAsync', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let authorized = true, checks = 0, writes = 0;
  const receipts = create(db, async (_bytes, write) => write());
  const app = new Hono();
  registerCreationReceipts(app, path, { receipts, scope: () => {
    if (!authorized) throw new HTTPException(403);
    // initial/body checks, before admission, inside writer, after release;
    // revoke in the microtask before the awaiting handler resumes.
    if (++checks === 5) queueMicrotask(() => { authorized = false; });
    return scope;
  } });
  app.post(path, c => { writes++; return c.json({ ok: true }); });
  assert.equal((await request(app)).status, 403); assert.equal(writes, 0);
  assert.equal(receipts.get(JSON.stringify(['create', scope]), 'key')!.state, 'outcome_unknown');
});

test('real background SQLite admission contention leaves receipt owner and main event loop responsive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-receipt-async-')), file = join(directory, 'ledger.sqlite');
  const ledger = new DatabaseSync(file), db = new DatabaseSync(':memory:');
  ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
  new VolumeAdmission(ledger, directory);
  const source = import.meta.url.endsWith('.ts');
  const owner = new Worker(`(async () => {
    const {workerData,parentPort}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const load=workerData.loader ? (await import(workerData.loader)).tsImport : url=>import(url);
    const {VolumeAdmission}=await load(workerData.volume,workerData.volume);
    const {installVolumeAdmissionProtocol}=await load(workerData.protocol,workerData.protocol);
    const db=new DatabaseSync(workerData.file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    const ledger=new VolumeAdmission(db,workerData.root);
    installVolumeAdmissionProtocol(parentPort,()=>ledger); parentPort.postMessage('ready');
  })().catch(()=>process.exit(1));`, { eval: true, execArgv: [], workerData: {
    file, root: directory, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    volume: new URL(source ? '../storage/volume-admission.ts' : '../storage/volume-admission.js', import.meta.url).href,
    protocol: new URL(source ? '../storage/volume-admission-protocol.ts' : '../storage/volume-admission-protocol.js', import.meta.url).href,
  } });
  t.after(async () => { if (ledger.isTransaction) ledger.exec('ROLLBACK'); await owner.terminate(); ledger.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(Error('worker exited before readiness'));
    owner.once('exit', failed); owner.once('error', reject);
    owner.once('message', () => { owner.off('exit', failed); owner.off('error', reject); resolve(); });
  });
  const admission = new AsyncVolumeAdmission(() => owner, quiet());
  const receipts = create(db, (bytes, write) => admission.run(directory, 'durable', bytes, write));
  ledger.exec('BEGIN IMMEDIATE'); let writes = 0;
  const work = receipts.claimAsync('scope', 'key', {}, false, undefined, () => { writes++; return true; });
  await new Promise<void>(resolve => setTimeout(resolve, 120));
  assert.equal(writes, 0); assert.equal(db.isTransaction, false); assert.equal(receipts.get('scope', 'key'), undefined);
  ledger.exec('COMMIT'); assert.equal((await work).fresh, true); assert.equal(writes, 1);
  assert.equal(ledger.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 0);
});
