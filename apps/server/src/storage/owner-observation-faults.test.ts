import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { AsyncSqliteAuthDisplay } from '../auth/async-sqlite-display.js';
import { AsyncHubDeliveryReader } from '../hub/async-delivery-reader.js';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { StorageAdmissionDeferred, StorageWorkAdmission } from './work-admission.js';
import { VolumeAdmission } from './volume-admission.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const phases = ['start', 'start-get', 'add', 'add-get', 'pending', 'pending-get', 'finish', 'finish-get'] as const;
type Fault = typeof phases[number];
function broken(phase: Fault) {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const fail = () => { throw Error('observation fixture'); };
  const trace = { add() {}, reportPending() {}, finish() {} };
  const method = phase.startsWith('pending') ? 'reportPending' : phase.startsWith('add') ? 'add' : 'finish';
  if (!phase.startsWith('start')) Object.defineProperty(trace, method,
    phase.endsWith('-get') ? { get: fail } : { value: fail });
  Object.defineProperty(diagnostics, 'start', phase === 'start-get' ? { get: fail }
    : { value: phase === 'start' ? fail : () => trace });
  return diagnostics;
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const MiB = 1024 ** 2;
function ledgerFixture(t: TestContext, phase: Fault) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ledger = new StorageWorkAdmission(db, () => 1000, broken(phase));
  return { db, ledger };
}
function volumeFixture(t: TestContext, phase: Fault) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-observation-'));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const admission = new VolumeAdmission(db, root, () => 1000, () => 1024n * BigInt(MiB), broken(phase));
  const charges = () => db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n;
  return { db, admission, charges };
}
for (const phase of phases) {
  test(`ledger ${phase}: committed admission and original quiescent release survive observation`, t => {
    const { db, ledger } = ledgerFixture(t, phase), id = `transient-${randomUUID()}`;
    ledger.startTransient('v', id, 'durable', MiB, () => ({ freeBytes: 1024n * BigInt(MiB), observedAt: 1000 }));
    assert.equal(db.isTransaction, false); assert.equal(ledger.read('v', id)!.state, 'started');
    assert.equal(ledger.finishQuiescentTransient('v', id, { workClass: 'durable', bytes: MiB }).released, true);
    assert.equal(db.isTransaction, false); assert.equal(ledger.read('v', id), undefined);
  });
  test(`ledger ${phase}: observation cannot replace original body error or suppress rollback`, t => {
    const { db, ledger } = ledgerFixture(t, phase), original = Error('original sample failure');
    assert.throws(() => ledger.startTransient('v', 'transient-original', 'durable', MiB, () => { throw original; }), e => e === original);
    assert.equal(db.isTransaction, false);
    ledger.startTransient('v', 'transient-next', 'durable', MiB, () => ({ freeBytes: 1024n * BigInt(MiB), observedAt: 1000 }));
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
    assert.equal(ledger.read('v', 'transient-original'), undefined);
  });
  for (const async of [false, true]) for (const fail of [false, true]) {
    test(`volume ledger ${phase}: ${async ? 'async' : 'sync'} original ${fail ? 'error' : 'ACK'} is retained and released once`, async t => {
      const { db, admission, charges } = volumeFixture(t, phase), original = Error('original write failure');
      let calls = 0;
      const write = () => { calls++; assert.equal(charges(), 1); if (fail) throw original; return 42; };
      if (async) {
        const work = admission.run('durable', MiB, async () => write());
        if (fail) await assert.rejects(work, e => e === original); else assert.equal(await work, 42);
      } else if (fail) assert.throws(() => admission.runSync('durable', MiB, write), e => e === original);
      else assert.equal(admission.runSync('durable', MiB, write), 42);
      assert.equal(calls, 1); assert.equal(charges(), 0); assert.equal(db.isTransaction, false);
    });
  }
  test(`volume ledger ${phase}: contract observation cannot skip original Promise settlement cleanup`, async t => {
    const { admission, charges } = volumeFixture(t, phase);
    let resolve!: (value: number) => void, calls = 0;
    const pending = new Promise<number>(done => { resolve = done; });
    assert.throws(() => admission.runSync('durable', MiB, (() => { calls++; return pending; }) as unknown as () => number), /must be synchronous/);
    assert.equal(charges(), 1); await turn(); assert.equal(charges(), 1);
    resolve(42); await pending; await turn();
    assert.equal(charges(), 0); assert.equal(calls, 1);
  });
  test(`volume ledger ${phase}: proven BEGIN refusal recovers original release without writer replay`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { db, admission, charges } = volumeFixture(t, phase), exec = db.exec.bind(db);
    let refuse = false, calls = 0;
    const busy = Object.assign(Error('original BEGIN refusal'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    db.exec = sql => { if (refuse && sql === 'BEGIN IMMEDIATE') { refuse = false; throw busy; } return exec(sql); };
    assert.throws(() => admission.runSync('durable', MiB, () => { calls++; refuse = true; return 42; }), e => e === busy);
    assert.equal(charges(), 1); assert.equal(db.isTransaction, false);
    t.mock.timers.tick(250); assert.equal(charges(), 0); assert.equal(calls, 1);
    assert.equal(admission.runSync('durable', MiB, () => { calls++; return 43; }), 43);
    assert.equal(calls, 2); assert.equal(charges(), 0);
  });
}
type Message = { id: number; kind: string; volume?: string };
class Observer extends EventEmitter {
  messages: Message[] = [];
  terminated = 0;
  autoClose = true;
  autoExit = true;
  postMessage(message: Message) {
    this.messages.push(message);
    if (message.kind === 'close' && this.autoClose) queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true }); this.emit('exit', 0);
    });
  }
  terminate() { this.terminated++; if (this.autoExit) queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  ref() {}
  unref() {}
}
function reader(t: TestContext, kind: 'auth' | 'delivery', phase: Fault, ready = true) {
  const worker = new Observer(), diagnostics = broken(phase), config = { file: '/unused', dev: 1, ino: 1 };
  const owner = kind === 'auth'
    ? new AsyncSqliteAuthDisplay(config, diagnostics, () => worker as unknown as Worker, 40)
    : new AsyncHubDeliveryReader(config, diagnostics, () => worker as unknown as Worker, 40);
  const read = () => owner instanceof AsyncSqliteAuthDisplay ? owner.read('status', 'a'.repeat(24))
    : owner.read({ owner: 'default', domains: [['node', 'current']] });
  const value = kind === 'auth' ? { available: true, count: 1 } : { reset: false, cursor: undefined, events: [] };
  if (ready) worker.emit('message', { kind: 'ready' });
  t.after(async () => { worker.emit('exit', 1); await owner.close(); });
  return { owner, worker, read, value };
}
for (const kind of ['auth', 'delivery'] as const) for (const phase of phases) {
  test(`${kind} ${phase}: observation cannot suppress read ACK or original close`, async t => {
    const h = reader(t, kind, phase), work = h.read(); await turn();
    assert.equal(h.worker.messages.length, 1);
    const sent = h.worker.messages[0]!;
    h.worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, value: h.value });
    assert.deepEqual(await work, h.value); assert.equal(h.owner.recoveryState.unavailable, false);
    const close = h.owner.close(); assert.equal(h.owner.close(), close); await close;
    assert.deepEqual(h.worker.messages.map(m => m.kind), [sent.kind, 'close']);
    assert.equal(h.worker.terminated, 0);
    const refused = h.read(); assert.ok(refused instanceof Promise); await assert.rejects(refused);
  });
  for (const startup of [false, true]) test(`${kind} ${phase}: ${startup ? 'startup' : 'read'} deadline fences before observation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = reader(t, kind, phase, !startup), rejected = assert.rejects(h.read());
    await turn(); t.mock.timers.tick(40); await rejected; await turn();
    assert.equal(h.owner.recoveryState.unavailable, true);
    assert.equal(h.worker.terminated, 1);
    assert.equal(h.worker.messages.length, startup ? 0 : 1);
    await assert.rejects(h.read()); assert.equal(h.worker.terminated, 1);
    await h.owner.close(); assert.equal(h.owner.recoveryState.exitConfirmed, true);
  });
  test(`${kind} ${phase}: close warning cannot release before physical exit or require retry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = reader(t, kind, phase); h.worker.autoClose = false; h.worker.autoExit = false;
    const close = h.owner.close(); let settled = false; void close.then(() => { settled = true; });
    await turn(); t.mock.timers.tick(40); await turn();
    assert.equal(h.worker.terminated, 1); assert.equal(h.owner.recoveryState.unavailable, true);
    assert.equal(settled, false); assert.equal(h.owner.close(), close);
    h.worker.emit('exit', 1); await close; assert.equal(settled, true);
    assert.equal(h.worker.messages.filter(m => m.kind === 'close').length, 1);
  });
}
for (const phase of phases) {
  for (const failWriter of [false, true]) test(`volume ${phase}: original ${failWriter ? 'failure' : 'ACK'} owns once-only writer`, async () => {
    const owner = new Observer(); let calls = 0;
    const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, broken(phase), {}, () => '42');
    const original = Error('original writer failure');
    const work = admission.run('/fixture', 'recovery', 1, async () => { calls++; if (failWriter) throw original; return 17; });
    const observed = failWriter ? assert.rejects(work, e => e === original) : work;
    await turn(); const begin = owner.messages[0]!;
    owner.emit('message', { id: begin.id, kind: 'begin', ok: true, volume: '42' }); await turn();
    owner.emit('message', { id: begin.id, kind: 'finish', ok: true });
    if (failWriter) await observed; else assert.equal(await observed, 17);
    assert.equal(calls, 1); assert.deepEqual(owner.messages.map(m => m.kind), ['begin', 'finish']);
    assert.equal(admission.snapshot().activeWriters, 0); assert.equal(admission.snapshot().acceptedRequests, 0);
    assert.equal(admission.snapshot().recoveryProofs, 0); assert.equal(owner.terminated, 0);
  });
  test(`volume ${phase}: lost begin ACK fences and keeps exact unstarted proof without replay`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = new Observer(); let calls = 0;
    const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, broken(phase), { requestTimeoutMs: 40 }, () => '42');
    const rejected = assert.rejects(admission.run('/fixture', 'recovery', 1, async () => ++calls), StorageAdmissionDeferred);
    await turn(); t.mock.timers.tick(40); await rejected; await turn();
    assert.equal(calls, 0); assert.equal(owner.terminated, 1); assert.equal(owner.messages.length, 1);
    assert.equal(admission.snapshot().ownerExitConfirmed, true); assert.equal(admission.snapshot().activeWriters, 0);
    assert.equal(admission.snapshot().acceptedRequests, 0); assert.equal(admission.snapshot().recoveryProofs, 1);
  });
  test(`volume ${phase}: pending observation never releases or replaces original writer`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = new Observer(); let resolve!: (n: number) => void, calls = 0;
    const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, broken(phase), { stallWarningMs: 40 }, () => '42');
    const work = admission.run('/fixture', 'recovery', 1, () => { calls++; return new Promise<number>(yes => { resolve = yes; }); });
    await turn(); const begin = owner.messages[0]!;
    owner.emit('message', { id: begin.id, kind: 'begin', ok: true, volume: '42' }); await turn();
    t.mock.timers.tick(40); await turn();
    assert.equal(admission.snapshot().activeWriters, 1); assert.equal(owner.messages.length, 1); assert.equal(owner.terminated, 0);
    resolve(23); await turn(); owner.emit('message', { id: begin.id, kind: 'finish', ok: true });
    assert.equal(await work, 23); assert.equal(calls, 1); assert.equal(admission.snapshot().activeWriters, 0);
  });
}
