import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VolumeAdmission } from './volume-admission.js';
import { StorageWorkAdmission } from './work-admission.js';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AsyncVolumeAdmission as RealAsyncVolumeAdmission } from './async-volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

// Deterministic mock owners use an explicit physical-volume fixture. Real
// worker cases below retain production's asynchronous filesystem binding.
class AsyncVolumeAdmission extends RealAsyncVolumeAdmission {
  constructor(...args: ConstructorParameters<typeof RealAsyncVolumeAdmission>) {
    super(args[0], args[1], args[2], args[3] ?? (args[0] ? () => '42' : undefined));
  }
}

class Owner extends EventEmitter {
  messages: any[] = [];
  refs = 0;
  postMessage(message: any) { this.messages.push(message); }
  ref() { this.refs++; }
  unref() { this.refs--; }
  terminate() { return Promise.resolve().then(() => { this.emit('exit', 1); return 1; }); }
  answer(id: number, ok = true, kind = [...this.messages].reverse().find(message => message.id === id)?.kind, volume?: string) {
    const device = volume ?? (ok && kind === 'begin' ? '42' : undefined);
    this.emit('message', { id, kind, ok, ...(device === undefined ? {} : { volume: device }) });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('known busy BEGIN denial preserves the owner and admits only a new request without recovery or replay', async () => {
  class BusyOwner extends Owner {
    override postMessage(message: any) {
      super.postMessage(message);
      queueMicrotask(() => {
        if (message.id === 1) this.emit('message', { id: message.id, kind: 'begin', ok: false, reason: 'coordinator-busy' });
        else this.answer(message.id, true, message.kind);
      });
    }
  }
  const owner = new BusyOwner(); let launches = 0, writes = 0;
  const admission = new AsyncVolumeAdmission(() => { launches++; return owner as unknown as Worker; });
  await assert.rejects(admission.run('/private-deleted-after-denial', 'recovery', 1, async () => ++writes), /coordinator-busy/);
  assert.equal(writes, 0); assert.equal(admission.snapshot().recoveryProofs, 0);
  assert.equal(admission.snapshot().status, 'ready');
  assert.equal(await admission.run('/private-new-root', 'recovery', 1, async () => ++writes), 1);
  assert.equal(launches, 1); assert.equal(writes, 1);
  assert.deepEqual(owner.messages.map(row => row.kind), ['begin', 'begin', 'finish']);
  assert.equal(admission.snapshot().activeWriters, 0); assert.equal(admission.snapshot().recoveryProofs, 0);
});

test('out-of-order asynchronous volume samples preserve monotonic begin admission and original results', async () => {
  class OrderedOwner extends Owner {
    highest = 0;
    override postMessage(message: any) {
      super.postMessage(message);
      const ok = message.kind !== 'begin' || message.id > this.highest;
      if (message.kind === 'begin' && ok) this.highest = message.id;
      queueMicrotask(() => this.answer(message.id, ok, message.kind));
    }
  }
  const owner = new OrderedOwner(), bindings: ((volume: string) => void)[] = [], calls: number[] = [];
  const admission = new RealAsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}), {},
    () => new Promise<string>(resolve => bindings.push(resolve)));
  const works = [1, 2, 3].map(n => admission.run('/fixture', 'recovery', 1, async () => { calls.push(n); return n; }));
  const results = Promise.all(works);
  void results.catch(() => {}); // Observe failures immediately without replacing the original result.
  bindings[2]!('42'); await turn();
  bindings[0]!('42'); await turn();
  bindings[1]!('42');
  assert.deepEqual(await results, [1, 2, 3]);
  assert.deepEqual(calls, [3, 1, 2]);
  assert.deepEqual(owner.messages.filter(message => message.kind === 'begin').map(message => message.id), [1, 2, 3]);
  assert.equal(admission.snapshot().recoveryProofs, 0);
  assert.equal(admission.snapshot().activeWriters, 0);
  assert.equal(admission.snapshot().status, 'ready');
});

test('asynchronous volume binding holds a bounded slot, observes stalls and never sends begin early', async () => {
  const owner = new Owner(), rows: any[] = [];
  let bind!: (volume: string) => void, calls = 0;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { stallWarningMs: 5 },
    () => new Promise<string>(resolve => { bind = resolve; }));
  const work = admission.run('/private-fixture', 'recovery', 1, async () => ++calls);
  await new Promise<void>(resolve => setTimeout(resolve, 15));
  assert.equal(owner.messages.length, 0); assert.equal(calls, 0);
  assert.equal(admission.snapshot().activeWriters, 1);
  assert.ok(rows.some(row => row.phase === 'pending' && row.step === 5));
  bind('42'); await turn();
  assert.equal(owner.messages[0].volume, '42'); owner.answer(1); await turn(); owner.answer(1);
  assert.equal(await work, 1); assert.equal(admission.snapshot().activeWriters, 0);
  assert.doesNotMatch(JSON.stringify(rows), /private-fixture/);
});

test('failed volume binding does not create an unknown lease or replay work', async () => {
  const owner = new Owner(), rows: any[] = []; let calls = 0, bindings = 0;
  const failure = Error('fixture stat failed');
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), {},
    async () => { if (++bindings === 1) throw failure; return '42'; });
  await assert.rejects(admission.run('/fixture', 'recovery', 1, async () => ++calls), error => error === failure);
  assert.equal(owner.messages.length, 0); assert.equal(admission.snapshot().recoveryProofs, 0);
  assert.ok(rows.some(row => row.phase === 'finished' && row.step === 5 && row.deferred === 1));
  assert.doesNotMatch(JSON.stringify(rows), /fixture stat failed|\/fixture/);
  const next = admission.run('/fixture', 'recovery', 1, async () => ++calls);
  await turn();
  assert.equal(owner.messages[0].id, 1, 'failed sampling never consumes a transport sequence');
  owner.answer(1); await turn(); owner.answer(1);
  assert.equal(await next, 1);
});

test('queued physical binding cannot exceed the accepted coordinator capacity', async () => {
  const owner = new Owner(), failure = Error('fixture binding rejected'); let reject!: (error: Error) => void, bindings = 0;
  const wait = new Promise<string>((_resolve, fail) => { reject = fail; });
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}), {},
    () => { bindings++; return wait; });
  const pending = Array.from({ length: 256 }, () => assert.rejects(
    admission.run('/fixture', 'recovery', 1, async () => assert.fail('no writer')), error => error === failure));
  await assert.rejects(admission.run('/fixture', 'recovery', 1, async () => assert.fail('capacity')), /capacity/);
  assert.equal(bindings, 256); assert.equal(admission.snapshot().activeWriters, 256); assert.equal(owner.messages.length, 0);
  reject(failure); await Promise.all(pending);
  assert.equal(admission.snapshot().activeWriters, 0); assert.equal(admission.snapshot().recoveryProofs, 0);
});

for (const volume of [undefined, '43']) test(`unproven begin ACK (${volume ?? 'missing'}) never invokes original writer`, async () => {
  const owner = new Owner(); let calls = 0;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}));
  const work = admission.run('/fixture', 'durable', 7, async () => ++calls);
  owner.emit('message', { id: 1, kind: 'begin', ok: true, ...(volume ? { volume } : {}) });
  await assert.rejects(work, /volume-changed/);
  assert.equal(calls, 0); assert.equal(admission.snapshot().recoveryProofs, 1);
});

test('lost unstarted reconciliation ACK preserves the exact proof across owner replacement', async () => {
  const owners = [new Owner(), new Owner(), new Owner()]; let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => owners[launches++] as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 30, recoveryDelayMs: 1 });
  await assert.rejects(admission.run('/fixture', 'durable', 7, async () => ++calls), /unavailable/);
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  const second = admission.run('/fixture', 'durable', 8, async () => ++calls);
  const proof = owners[1]!.messages[0];
  assert.equal(proof.kind, 'reconcile'); assert.equal(proof.unstarted, true);
  assert.equal(proof.workClass, 'durable'); assert.equal(proof.bytes, 7); assert.equal(proof.volume, '42');
  await assert.rejects(second, /unavailable/);
  assert.equal(calls, 0); assert.equal(admission.snapshot().recoveryProofs, 1);
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  const third = admission.run('/fixture', 'durable', 9, async () => ++calls);
  assert.deepEqual({ ...owners[2]!.messages[0], id: proof.id }, proof);
  owners[2]!.answer(3); await turn(); owners[2]!.answer(4); await turn(); owners[2]!.answer(4);
  assert.equal(await third, 1); assert.equal(admission.snapshot().recoveryProofs, 0);
});
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

for (const reason of [undefined, 'coordinator-unavailable']) test(`uncertain begin rejection (${reason ?? 'missing reason'}) fences the owner and retains exact unstarted proof`, async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0;
  old.terminate = () => Promise.resolve(1); // Return is deliberately NOT exit evidence.
  const rows: any[] = [];
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { recoveryDelayMs: 1 });
  const first = admission.run('/private-fixture', 'durable', 19, async () => ++calls);
  const rejected = assert.rejects(first, /coordinator-unavailable/);
  const lease = old.messages[0].lease;
  old.emit('message', { id: 1, kind: 'begin', ok: false, ...(reason === undefined ? {} : { reason }) });
  await rejected; await pause(5);
  assert.equal(calls, 0); assert.equal(admission.snapshot().recoveryProofs, 1);
  assert.equal(admission.snapshot().blockedBy, 'owner-exit');
  await assert.rejects(admission.run('/private-fixture', 'durable', 19, async () => ++calls));
  assert.equal(launches, 1);
  old.emit('exit', 1);
  const next = admission.run('/private-fixture', 'durable', 19, async () => ++calls);
  assert.deepEqual(fresh.messages[0], { id: 2, kind: 'reconcile', lease,
    root: '/private-fixture', volume: '42', full: false, unstarted: true, workClass: 'durable', bytes: 19 });
  assert.equal(calls, 0); fresh.answer(2); await turn();
  fresh.answer(3); await turn(); fresh.answer(3);
  assert.equal(await next, 1); assert.equal(calls, 1);
  assert.ok(rows.some(row => row.operation === 'async-storage-admission' && row.step === 2 && row.unknown === 1));
  assert.doesNotMatch(JSON.stringify(rows), /private-fixture|transient-/);
});

test('known begin admission denial leaves a healthy owner reusable without recovery proof', async () => {
  const owner = new Owner(); let calls = 0, launches = 0;
  const admission = new AsyncVolumeAdmission(() => { launches++; return owner as unknown as Worker; });
  const first = admission.run('/fixture', 'durable', 1, async () => ++calls);
  const rejected = assert.rejects(first, /insufficient-space/);
  owner.emit('message', { id: 1, kind: 'begin', ok: false, reason: 'insufficient-space' });
  await rejected;
  assert.equal(admission.snapshot().status, 'ready'); assert.equal(admission.snapshot().recoveryProofs, 0);
  const next = admission.run('/fixture', 'durable', 1, async () => ++calls);
  assert.equal(owner.messages[1].kind, 'begin'); owner.answer(2); await turn(); owner.answer(2);
  assert.equal(await next, 1); assert.equal(launches, 1);
});

test('pending original writer logs its exact phase without releasing, replacing or replaying it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0, release!: () => void;
  const rows: any[] = [];
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
    { requestTimeoutMs: 5000, recoveryDelayMs: 1, stallWarningMs: 1000 });
  const original = admission.run('/private-original', 'durable', 1, async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return 7; });
  old.answer(1, true, 'begin', '42'); await turn();
  old.emit('error', Error('private-worker-fault')); await turn();
  assert.equal(admission.snapshot().ownerExitConfirmed, true);
  t.mock.timers.tick(1000);
  const pending = rows.find(row => row.phase === 'pending');
  assert.equal(pending.operation, 'async-storage-admission'); assert.equal(pending.step, 3);
  assert.equal(pending.pending, 1); assert.equal(pending.admitted, 1);
  assert.equal(old.messages.length, 1); assert.equal(admission.snapshot().activeWriters, 1);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('active original writer')));
  t.mock.timers.tick(100_000);
  assert.equal(launches, 1); assert.equal(calls, 1);
  assert.equal(rows.filter(row => row.phase === 'pending').length, 1);
  const rejected = assert.rejects(original, /coordinator-unavailable/); release(); await rejected;
  const completed = rows.find(row => row.phase === 'finished' && row.operation === 'async-storage-admission'
    && row.sequence === pending.sequence);
  assert.equal(completed.unknown, 1); assert.equal(completed.step, 4,
    'completion independently records the failed finish ACK, not the pending writer phase');
  assert.equal(admission.snapshot().activeWriters, 0); assert.equal(admission.snapshot().recoveryProofs, 1);
  assert.doesNotMatch(JSON.stringify(rows), /private|original|worker-fault|\/fixture/);
});

for (const stage of ['begin', 'finish'] as const) test(`pending ${stage} observation never counts as an owner ACK`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new Owner(), rows: any[] = []; let calls = 0;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { requestTimeoutMs: 5000, stallWarningMs: 1000 });
  const run = admission.run('/private-root', 'durable', 1, async () => ++calls);
  if (stage === 'finish') { owner.answer(1, true, 'begin', '42'); await turn(); }
  t.mock.timers.tick(1000);
  const pending = rows.find(row => row.phase === 'pending');
  assert.equal(pending.step, stage === 'begin' ? 2 : 4); assert.equal(pending.pending, 1);
  assert.equal(calls, stage === 'begin' ? 0 : 1); assert.equal(admission.snapshot().activeWriters, 1);
  if (stage === 'begin') { owner.answer(1, true, 'begin', '42'); await turn(); }
  owner.answer(1, true, 'finish'); assert.equal(await run, 1);
  const count = rows.length; t.mock.timers.tick(10_000); assert.equal(rows.length, count);
  assert.equal(admission.snapshot().activeWriters, 0); assert.equal(calls, 1);
});

test('settled storage admission cancels its pending warning even when logs throw', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new Owner(); let logCalls = 0;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(() => { logCalls++; throw Error('private-sink'); }), { requestTimeoutMs: 5000, stallWarningMs: 1000 });
  const run = admission.run('/fixture', 'durable', 1, async () => 7);
  owner.answer(1); await turn(); owner.answer(1); assert.equal(await run, 7);
  const count = logCalls; t.mock.timers.tick(10_000); assert.equal(logCalls, count);
  assert.equal(admission.snapshot().activeWriters, 0);
});

for (const fault of ['resolved', 'rejected', 'thrown'] as const) test(`termination ${fault} without exit stays fenced beyond cooldown`, async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0;
  old.terminate = () => {
    if (fault === 'thrown') throw Error('private-termination');
    return fault === 'rejected' ? Promise.reject(Error('private-termination')) : Promise.resolve(1);
  };
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker, new PerformanceDiagnostics(() => {}),
    { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  const rejected = assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('no admission ACK')));
  old.emit('error', Error('owner')); await rejected; await pause(5);
  assert.equal(admission.snapshot().ownerExitConfirmed, false);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('no exit')));
  assert.equal(launches, 1);
  old.emit('exit', 1);
  const next = admission.run('/fixture', 'durable', 1, async () => 8);
  fresh.answer(2); await turn(); fresh.answer(3); await turn(); fresh.answer(3);
  assert.equal(await next, 8);
});

for (const reply of [
  { id: 1, kind: 'begin', ok: true, extra: 'private-payload' },
  { id: 1, kind: 'begin', ok: true, reason: 'private-reason' },
  { id: 1, kind: 'begin', ok: false, volume: '42' },
  { id: 1, kind: 'begin', ok: false, reason: 'private/invalid' },
  { id: 1, kind: 'begin', ok: false, reason: 'private-lowercase-secret' },
  { id: 1, kind: 'begin', ok: true, volume: '-42' },
  Object.assign([], { id: 1, kind: 'begin', ok: true }),
]) test(`malformed begin reply fails closed without writer or payload logging (${JSON.stringify(reply)})`, async () => {
  const owner = new Owner(), logs: string[] = [];
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => logs.push(line)));
  const work = admission.run('/private-root', 'durable', 1, async () => assert.fail('writer must not run'));
  owner.emit('message', reply);
  await assert.rejects(work, /coordinator-unavailable/);
  assert.equal(owner.messages.length, 1); assert.equal(admission.snapshot().status, 'unavailable');
  assert.doesNotMatch(logs.join('\n'), /private|payload|reason|root/);
});

for (const originalFailed of [false, true]) test(`finish reply with volume cannot settle or replay writer (${originalFailed})`, async () => {
  const owner = new Owner(), logs: string[] = [], original = Error('original-writer'); let calls = 0;
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => logs.push(line)));
  const work = admission.run('/private-root', 'durable', 1, async () => {
    calls++; if (originalFailed) throw original; return 7;
  });
  owner.answer(1, true, 'begin', '42'); await turn(); owner.answer(1, true, 'finish', '42');
  await assert.rejects(work, error => originalFailed ? error === original : error instanceof Error && /unavailable/.test(error.message));
  assert.equal(calls, 1); assert.equal(owner.messages.length, 2);
  assert.equal(admission.snapshot().recoveryProofs, 1);
  assert.ok(logs.map(line => JSON.parse(line)).some(row => row.unknown === 1));
  assert.doesNotMatch(logs.join('\n'), /private|original-writer/);
});

test('malformed reconciliation ACK retains exact proof and blocks all waiting new writers', async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  const first = admission.run('/fixture', 'durable', 1, async () => ++calls);
  old.answer(1, true, 'begin', '42'); await turn(); old.emit('exit', 1); await assert.rejects(first); await pause(5);
  const second = admission.run('/fixture', 'durable', 1, async () => ++calls);
  const third = admission.run('/fixture', 'durable', 1, async () => ++calls);
  fresh.answer(2, true, 'reconcile', '42');
  const results = await Promise.allSettled([second, third]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(calls, 1); assert.equal(fresh.messages.length, 1);
  assert.equal(admission.snapshot().recoveryProofs, 1);
});
test('coordinator snapshot observes pending and failed owner without launching, posting or repairing', async () => {
  const old = new Owner(); let launches = 0;
  old.terminate = () => new Promise<number>(() => {});
  const admission = new AsyncVolumeAdmission(() => { launches++; return old as unknown as Worker; }, new PerformanceDiagnostics(() => {}));
  assert.equal(admission.snapshot().status, 'idle'); assert.equal(launches, 0);
  const run = admission.run('/private-root', 'durable', 1, async () => assert.fail('unacknowledged writer'));
  assert.equal(admission.snapshot().pending, 1); const refs = old.refs, messages = old.messages.length;
  for (let i = 0; i < 10; i++) admission.snapshot();
  assert.equal(old.refs, refs); assert.equal(old.messages.length, messages); assert.equal(launches, 1);
  old.emit('error', Error('private-error')); await assert.rejects(run);
  const snapshot = admission.snapshot(); assert.equal(snapshot.status, 'unavailable'); assert.equal(snapshot.blockedBy, 'owner-exit');
  assert.equal(snapshot.pending, 0); assert.doesNotMatch(JSON.stringify(snapshot), /private|lease|root/);
  assert.equal(launches, 1);
});

test('proof-backed recovery serializes concurrent admission and never replays the original writer', async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  const first = admission.run('/fixture', 'durable', 1, async () => ++calls);
  old.answer(1, true, 'begin', '42'); await turn();
  const originalLease = old.messages[0].lease;
  old.emit('error', Error('fixture')); await assert.rejects(first, /unavailable/); await pause(5);
  const second = admission.run('/fixture', 'durable', 1, async () => ++calls);
  const third = admission.run('/fixture', 'durable', 1, async () => ++calls);
  assert.equal(fresh.messages.length, 1);
  assert.deepEqual(fresh.messages[0], { id: 2, kind: 'reconcile', lease: originalLease, root: '/fixture', volume: '42', full: false });
  assert.equal(calls, 1);
  fresh.answer(2); await turn();
  assert.deepEqual(fresh.messages.slice(1).map(row => row.kind), ['begin', 'begin']);
  fresh.answer(3); fresh.answer(4); await turn(); fresh.answer(3); fresh.answer(4);
  assert.deepEqual(await Promise.all([second, third]), [2, 3]);
  assert.equal(fresh.messages.filter(row => row.kind === 'reconcile').length, 1);
});

test('recovery refusal retains proof and fences all new writers until another confirmed replacement', async () => {
  const owners = [new Owner(), new Owner(), new Owner()]; let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => owners[launches++]! as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  const first = admission.run('/fixture', 'durable', 1, async () => ++calls);
  owners[0]!.answer(1, true, 'begin', '42'); await turn(); owners[0]!.emit('exit', 1);
  await assert.rejects(first, /unavailable/); await pause(5);
  const refused = admission.run('/fixture', 'durable', 1, async () => ++calls);
  owners[1]!.answer(2, false); await assert.rejects(refused); assert.equal(calls, 1);
  await pause(5);
  const next = admission.run('/fixture', 'durable', 1, async () => ++calls);
  assert.equal(owners[2]!.messages[0].lease, owners[1]!.messages[0].lease);
  owners[2]!.answer(3); await turn(); owners[2]!.answer(4); await turn(); owners[2]!.answer(4);
  assert.equal(await next, 2);
});

test('acknowledged lease cannot be reconciled while its original writer or owner remains unconfirmed', async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0, settle!: () => void, stop!: (code: number) => void;
  old.terminate = () => new Promise<number>(resolve => { stop = resolve; });
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  const original = Error('original');
  const first = admission.run('/fixture', 'durable', 1, async () => {
    await new Promise<void>(resolve => { settle = resolve; }); throw original;
  });
  old.answer(1, true, 'begin', '42'); await turn(); old.emit('error', Error('owner')); await pause(5);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('writer active')));
  settle(); await assert.rejects(first, error => error === original);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('owner unconfirmed')));
  assert.equal(launches, 1);
  stop(1); await turn();
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('termination return is not exit')));
  assert.equal(launches, 1);
  old.emit('exit', 1);
  const next = admission.run('/fixture', 'durable', 1, async () => 8);
  assert.equal(fresh.messages[0].kind, 'reconcile'); fresh.answer(2); await turn();
  fresh.answer(3); await turn(); fresh.answer(3); assert.equal(await next, 8);
});

test('lost reconciliation ACK retries only exact idempotent cleanup, not the original write', async () => {
  const owners = [new Owner(), new Owner(), new Owner()]; let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => owners[launches++]! as unknown as Worker,
    new PerformanceDiagnostics(() => { throw Error('sink'); }), { requestTimeoutMs: 40, recoveryDelayMs: 1 });
  const first = admission.run('/fixture', 'durable', 1, async () => ++calls);
  owners[0]!.answer(1, true, 'begin', '42'); await turn(); owners[0]!.emit('exit', 1);
  await assert.rejects(first); await pause(5);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => ++calls));
  assert.equal(calls, 1); await pause(5);
  const next = admission.run('/fixture', 'durable', 1, async () => ++calls);
  assert.equal(owners[2]!.messages[0].lease, owners[1]!.messages[0].lease);
  owners[2]!.answer(3); await turn(); owners[2]!.answer(4); await turn(); owners[2]!.answer(4);
  assert.equal(await next, 2);
});

test('silent begin times out, future work recovers without replay and ignores obsolete owner events', async () => {
  const old = new Owner(), fresh = new Owner(), rows: any[] = [];
  let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { requestTimeoutMs: 40, recoveryDelayMs: 1 });
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => ++calls), /unavailable/);
  assert.equal(calls, 0);
  await pause(5);
  const recovered = admission.run('/fixture', 'durable', 1, async () => ++calls);
  assert.equal(launches, 2);
  old.answer(1); old.emit('error', Error('obsolete')); old.emit('exit', 1);
  fresh.answer(2); await turn(); fresh.answer(3); await turn(); fresh.answer(3);
  assert.equal(await recovered, 1);
  assert.equal(old.messages.length, 1); assert.equal(calls, 1);
  assert.equal(rows.filter(row => row.timedOut === 1).length, 1);
  assert.equal(rows.filter(row => row.recovered === 1).length, 1);
});

test('lost finish ACK rejects a committed result but does not replay it on recovery', async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0;
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 40, recoveryDelayMs: 1 });
  const first = admission.run('/fixture', 'durable', 1, async () => ++calls);
  old.answer(1);
  await assert.rejects(first, /unavailable/);
  await pause(5);
  const second = admission.run('/fixture', 'durable', 1, async () => ++calls);
  fresh.answer(2); await turn(); fresh.answer(3); await turn(); fresh.answer(3);
  assert.equal(await second, 2); assert.equal(calls, 2);
});

test('replacement waits for every original writer to settle, not merely worker termination', async () => {
  const old = new Owner(), fresh = new Owner(); let launches = 0, settle!: () => void;
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  const writing = admission.run('/fixture', 'durable', 1, () => new Promise<void>(resolve => { settle = resolve; }));
  const rejected = assert.rejects(writing, /unavailable/);
  old.answer(1); await turn(); old.emit('error', Error('fixture'));
  await pause(5);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('still fenced')), /unavailable/);
  assert.equal(launches, 1); settle(); await rejected;
  const next = admission.run('/fixture', 'durable', 1, async () => 9);
  fresh.answer(2); await turn(); fresh.answer(3); await turn(); fresh.answer(3);
  assert.equal(await next, 9);
});

test('missing termination proof stays fenced beyond cooldown and never launches another owner', async () => {
  const old = new Owner(); old.terminate = () => new Promise<number>(() => {});
  let launches = 0;
  const admission = new AsyncVolumeAdmission(() => { launches++; return old as unknown as Worker; },
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 20, recoveryDelayMs: 1 });
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('no ACK')), /unavailable/);
  await pause(5);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('no stop proof')), /unavailable/);
  assert.equal(launches, 1);
});

test('failed launch can recover after cooldown; policy validation and bad logs cannot change authority', async () => {
  const fresh = new Owner(); let launches = 0;
  const admission = new AsyncVolumeAdmission(() => {
    if (++launches === 1) throw Error('private launch details');
    return fresh as unknown as Worker;
  }, new PerformanceDiagnostics(() => { throw Error('log failure'); }), { requestTimeoutMs: 100, recoveryDelayMs: 1 });
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('no owner')), /unavailable/);
  await pause(5);
  const work = admission.run('/fixture', 'durable', 1, async () => 7);
  fresh.answer(1); await turn(); fresh.answer(1);
  assert.equal(await work, 7);
  for (const requestTimeoutMs of [0, -1, Infinity, NaN, 0.5]) {
    assert.throws(() => new AsyncVolumeAdmission(undefined, undefined, { requestTimeoutMs }), RangeError);
  }
});
test('async owner diagnostics distinguish lost release from a settled writer, without payloads', async () => {
  const owner = new Owner(), rows: any[] = [];
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  let calls = 0;
  const work = admission.run('/private/credential-path', 'durable', 1, async () => { calls++; return 'private content'; });
  owner.answer(1); await turn(); owner.emit('error', Error('secret raw worker error'));
  await assert.rejects(work, /unavailable/);
  assert.equal(calls, 1); assert.equal(rows.length, 2);
  const row = rows.find(row => row.operation === 'async-storage-admission');
  assert.equal(row.admitted, 1); assert.equal(row.unknown, 1);
  assert.equal(row.settled, undefined); assert.equal(row.category, 'failed');
  for (const key of ['queueMs', 'bodyMs', 'releaseMs', 'pending']) assert.ok(row[key] >= 0);
  assert.doesNotMatch(JSON.stringify(rows), /private|secret|credential|content/);
});
test('writer begins only after committed admission and releases only after quiescence', async () => {
  const owner = new Owner(), admission = new AsyncVolumeAdmission(() => owner as unknown as Worker);
  let calls = 0, finish!: () => void;
  const work = admission.run('/fixture', 'durable', 1, () => {
    calls++; return new Promise<void>(resolve => { finish = resolve; });
  });
  assert.equal(calls, 0); owner.answer(1); await turn();
  assert.equal(calls, 1); assert.equal(owner.messages.length, 1);
  finish(); await turn(); assert.equal(owner.messages[1].kind, 'finish');
  owner.answer(1); await work;
});
test('owner death after admission retains charge, original failure and no replacement/replay', async () => {
  const owner = new Owner(); let launches = 0, calls = 0, finish!: () => void;
  const admission = new AsyncVolumeAdmission(() => { launches++; return owner as unknown as Worker; });
  const original = Object.assign(Error('private writer failure'), { code: 'ENOSPC' });
  const work = admission.run('/fixture', 'durable', 1, async () => {
    calls++; await new Promise<void>(resolve => { finish = resolve; }); throw original;
  });
  owner.answer(1); await turn(); owner.emit('exit', 1); finish();
  await assert.rejects(work, error => error === original);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => { calls++; }), /unavailable/);
  assert.equal(launches, 1); assert.equal(calls, 1); assert.equal(owner.messages.length, 1);
});
test('lost begin acknowledgment never invokes writer or attempts release', async () => {
  const owner = new Owner(), admission = new AsyncVolumeAdmission(() => owner as unknown as Worker);
  const work = admission.run('/fixture', 'durable', 1, async () => assert.fail('must not write'));
  owner.emit('error', Error('private worker details'));
  await assert.rejects(work, /coordinator-unavailable/);
  assert.equal(owner.messages.length, 1);
});
test('release failure after successful write is not success and never repeats writer', async () => {
  const owner = new Owner(), rows: any[] = [];
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  let calls = 0;
  const work = admission.run('/fixture', 'durable', 1, async () => ++calls);
  owner.answer(1); await turn(); owner.answer(1, false);
  await assert.rejects(work); assert.equal(calls, 1); assert.equal(owner.messages.length, 2);
  assert.equal(rows[0].unknown, 1); assert.equal(rows[0].settled, undefined);
});
test('synchronous launch failure is sanitized and permanently fences the owner', async () => {
  let launches = 0;
  const admission = new AsyncVolumeAdmission(() => { launches++; throw Error('private launch details'); });
  for (let n = 0; n < 2; n++) {
    await assert.rejects(admission.run('/fixture', 'durable', 1, async () => assert.fail('must not write')),
      error => error instanceof Error && error.message === 'coordinator-unavailable');
  }
  assert.equal(launches, 1);
});
test('a release reply cannot authorize a queued writer', async () => {
  const owner = new Owner(), admission = new AsyncVolumeAdmission(() => owner as unknown as Worker);
  const work = admission.run('/fixture', 'durable', 1, async () => assert.fail('must not write'));
  owner.answer(1, true, 'finish');
  await assert.rejects(work, /unavailable/);
  assert.equal(owner.messages.length, 1);
});
test('a delayed duplicate begin reply cannot confirm release or replay the writer', async () => {
  const owner = new Owner(), admission = new AsyncVolumeAdmission(() => owner as unknown as Worker);
  let calls = 0;
  const work = admission.run('/fixture', 'durable', 1, async () => ++calls);
  owner.answer(1); await turn(); owner.answer(1, true, 'begin');
  await assert.rejects(work, /unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(admission.run('/fixture', 'durable', 1, async () => ++calls), /unavailable/);
  assert.equal(calls, 1);
});
test('actual background owner imports source, admits concurrent windows and returns settled values', async () => {
  const admission = new AsyncVolumeAdmission();
  assert.deepEqual(await Promise.all([1, 2, 3].map(n => admission.run(tmpdir(), 'recovery', 1024, async () => n))), [1, 2, 3]);
  const original = Error('writer fixture');
  await assert.rejects(admission.run(tmpdir(), 'recovery', 1024, async () => { throw original; }), error => error === original);
  assert.equal(await admission.run(tmpdir(), 'recovery', 1024, async () => 4), 4);
});

test('real background ledger accepts deliberately reversed physical samples without unknown recovery', async () => {
  const volume = String((await stat(tmpdir(), { bigint: true })).dev), bindings: ((volume: string) => void)[] = [];
  let calls = 0;
  const admission = new RealAsyncVolumeAdmission(undefined, new PerformanceDiagnostics(() => {}), {},
    () => new Promise<string>(resolve => bindings.push(resolve)));
  const result = Promise.all([1, 2, 3].map(n => admission.run(tmpdir(), 'recovery', 1024, async () => { calls++; return n; })));
  void result.catch(() => {});
  bindings[2]!(volume); await turn(); bindings[0]!(volume); await turn(); bindings[1]!(volume);
  assert.deepEqual(await result, [1, 2, 3]); assert.equal(calls, 3);
  assert.equal(admission.snapshot().status, 'ready'); assert.equal(admission.snapshot().recoveryProofs, 0);
  assert.equal(admission.snapshot().activeWriters, 0);
});

test('real committed begin with lost ACK recovers only its original unstarted charge after actual exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-unstarted-real-')), file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file), volume = String((await stat(directory, { bigint: true })).dev);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
  new VolumeAdmission(db, directory);
  const ledger = new StorageWorkAdmission(db), foreign = `transient-${randomUUID()}`;
  const sample = () => ({ freeBytes: 1024n ** 3n, observedAt: Date.now() });
  ledger.startTransient(volume, foreign, 'recovery', 1, sample);
  ledger.reserve(volume, 'external-command', 'recovery', 1, sample); ledger.claim(volume, 'external-command');
  const launch = (drop = false) => new Worker(`(async () => {
    const {workerData,parentPort}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const load=workerData.loader ? (await import(workerData.loader)).tsImport : url=>import(url);
    const {VolumeAdmission}=await load(workerData.volume,workerData.volume);
    const {installVolumeAdmissionProtocol}=await load(workerData.protocol,workerData.protocol);
    const db=new DatabaseSync(workerData.file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    const ledger=new VolumeAdmission(db,workerData.root);
    const port={on:(...args)=>parentPort.on(...args), close:()=>parentPort.close(),
      postMessage:message=>{if (!(workerData.drop && message.kind==='begin' && message.ok)) parentPort.postMessage(message)}};
    installVolumeAdmissionProtocol(port,()=>ledger);
    if (workerData.drop) parentPort.postMessage('fixture-ready');
  })().catch(()=>process.exit(1));`, { eval: true, execArgv: [], workerData: {
    loader: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined, file, root: directory, drop,
    volume: new URL(import.meta.url.endsWith('.ts') ? './volume-admission.ts' : './volume-admission.js', import.meta.url).href,
    protocol: new URL(import.meta.url.endsWith('.ts') ? './volume-admission-protocol.ts' : './volume-admission-protocol.js', import.meta.url).href,
  } });
  const owner = launch(true); let replacement: Worker | undefined, launches = 0, calls = 0;
  try {
    await new Promise<void>((resolve, reject) => { owner.once('message', () => resolve()); owner.once('error', reject);
      owner.once('exit', () => reject(Error('fixture exited before ready'))); });
    // A termination completion is intentionally not actual exit. Hold the old
    // worker alive to prove an ambiguous begin cannot authorize early release.
    owner.terminate = () => Promise.resolve(1);
    const admission = new RealAsyncVolumeAdmission(() => ++launches === 1 ? owner : (replacement = launch()),
      new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 5000, recoveryDelayMs: 1 });
    await assert.rejects(admission.run(directory, 'recovery', 7, async () => ++calls), /unavailable/);
    assert.equal(calls, 0); assert.equal(admission.snapshot().blockedBy, 'owner-exit');
    const charged = db.prepare('SELECT request FROM storage_work_reservations WHERE request NOT IN (?,?)').get(foreign, 'external-command');
    assert.ok(charged, 'begin really committed before ACK was lost');
    await assert.rejects(admission.run(directory, 'recovery', 8, async () => ++calls), /unavailable/);
    assert.equal(launches, 1); assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 3);
    await Worker.prototype.terminate.call(owner); await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(await admission.run(directory, 'recovery', 9, async () => {
      calls++;
      assert.equal(db.prepare('SELECT request FROM storage_work_reservations WHERE request=?').get(String(charged.request)), undefined);
      assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 3);
      return 9;
    }), 9);
    assert.equal(calls, 1); assert.equal(launches, 2);
    assert.deepEqual(db.prepare('SELECT request FROM storage_work_reservations ORDER BY request').all().map(row => row.request),
      ['external-command', foreign]);
  } finally {
    await Worker.prototype.terminate.call(owner); await replacement?.terminate(); db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real SQLite contention keeps the event loop responsive; settled original charges recover without expiry or replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-admission-thread-test-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
  new VolumeAdmission(db, directory);
  const launch = (notify = false) => new Worker(`(async () => {
    const {workerData,parentPort}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const load=workerData.loader ? (await import(workerData.loader)).tsImport : url=>import(url);
    const {VolumeAdmission}=await load(workerData.volume,workerData.volume);
    const {installVolumeAdmissionProtocol}=await load(workerData.protocol,workerData.protocol);
    const db=new DatabaseSync(workerData.file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    const ledger=new VolumeAdmission(db,workerData.root);
    installVolumeAdmissionProtocol(parentPort,()=>ledger);
    if (workerData.notify) parentPort.postMessage('fixture-ready');
  })().catch(()=>process.exit(1));`, { eval: true, execArgv: [], workerData: {
    loader: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined, file, root: directory, notify,
    volume: new URL(import.meta.url.endsWith('.ts') ? './volume-admission.ts' : './volume-admission.js', import.meta.url).href,
    protocol: new URL(import.meta.url.endsWith('.ts') ? './volume-admission-protocol.ts' : './volume-admission-protocol.js', import.meta.url).href,
  } });
  const owner = launch(true);
  let replacement: Worker | undefined, launches = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(Error('fixture worker exited before ready'));
      owner.once('exit', failed); owner.once('error', reject);
      owner.once('message', () => { owner.off('exit', failed); owner.off('error', reject); resolve(); });
    });
    const admission = new RealAsyncVolumeAdmission(() => ++launches === 1 ? owner : (replacement = launch()),
      new PerformanceDiagnostics(() => {}), { recoveryDelayMs: 1 });
    db.exec('BEGIN IMMEDIATE');
    let called = false;
    const work = admission.run(directory, 'recovery', 1024, async () => { called = true; return 7; });
    // The parent itself holds the lock. If admission ran synchronously here,
    // neither this timer nor the lock release could run until busy_timeout.
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    assert.equal(called, false);
    db.exec('COMMIT');
    assert.equal(await work, 7);
    let settle!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const unfinished = admission.run(directory, 'recovery', 1024, () => {
      entered(); return new Promise<void>(resolve => { settle = resolve; });
    });
    await enteredPromise;
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_work_reservations WHERE json_extract(payload,'$.state')='started'").get()!.n, 1);
    await owner.terminate(); settle();
    await assert.rejects(unfinished, /unavailable/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_work_reservations WHERE json_extract(payload,'$.state')='started'").get()!.n, 1);
    await pause(5);
    assert.equal(await admission.run(directory, 'recovery', 1024, async () => {
      // Original writer settled and old owner exited: only its exact charge
      // was recovered before admitting new work, without replaying its writer.
      assert.equal(db.prepare("SELECT count(*) AS n FROM storage_work_reservations WHERE json_extract(payload,'$.state')='started'").get()!.n, 1);
      return 8;
    }), 8);
    assert.equal(launches, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_work_reservations WHERE json_extract(payload,'$.state')='started'").get()!.n, 0);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    await owner.terminate(); await replacement?.terminate(); db.close(); await rm(directory, { recursive: true, force: true });
  }
});
