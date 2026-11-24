import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { StorageAdmissionDeferred } from './work-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Request = { id: number; kind: string; lease?: string; root?: string; volume?: string };
class Owner extends EventEmitter {
  readonly messages: Request[] = [];
  postMessage(message: Request) { this.messages.push(message); }
  ref() {} unref() {}
  terminate() { return Promise.resolve().then(() => { this.emit('exit', 1); return 1; }); }
  answer(request: Request, volume?: string) {
    this.emit('message', { id: request.id, kind: request.kind, ok: true,
      ...(request.kind === 'begin' ? { volume: '42' } : volume === undefined ? {} : { volume }) });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const capacity = (error: unknown) => error instanceof StorageAdmissionDeferred && error.message === 'coordinator-capacity';

async function recovering(sink: (line: string) => void = () => {}) {
  const old = new Owner(), fresh = new Owner(), repaired = new Owner();
  const owners = [old, fresh, repaired]; let launches = 0, calls = 0, bindings = 0;
  const diagnostics = new PerformanceDiagnostics(sink);
  const admission = new AsyncVolumeAdmission(() => owners[launches++]! as unknown as Worker, diagnostics,
    { requestTimeoutMs: 5000, recoveryDelayMs: 1 }, () => { bindings++; return '42'; });
  const write = async () => ++calls;
  const first = admission.run('/private-fixture', 'durable', 1, write);
  const rejected = assert.rejects(first, /unavailable/);
  old.emit('error', Error('private-owner-error')); await rejected; await pause();
  assert.equal(admission.snapshot().acceptedRequests, 0);
  assert.equal(admission.snapshot().recoveryProofs, 1);
  return { old, fresh, repaired, admission, diagnostics, write,
    launches: () => launches, calls: () => calls, bindings: () => bindings };
}

test('recovery waiters reserve bounded admission before any await and resume without replay', async () => {
  const f = await recovering(); const requests: Promise<number>[] = [];
  try {
    for (let i = 0; i < 256; i++) requests.push(f.admission.run('/private-fixture', 'durable', 1, f.write));
    const drained = Promise.allSettled(requests);
    const before = f.admission.snapshot();
    assert.equal(before.acceptedRequests, 256); assert.equal(before.activeWriters, 0);
    assert.equal(before.pending, 1); assert.equal(before.recoveryProofs, 1);
    assert.equal(f.fresh.messages.length, 1); assert.equal(f.fresh.messages[0]!.kind, 'reconcile');
    const excess = f.admission.run('/private-fixture', 'durable', 1, f.write);
    const rejected = assert.rejects(excess, capacity);
    assert.equal(await Promise.race([rejected.then(() => 'bounded'), turn().then(() => 'still-waiting')]), 'bounded');
    assert.equal(f.calls(), 0); assert.equal(f.bindings(), 1); assert.equal(f.launches(), 2);
    assert.deepEqual(f.admission.snapshot(), before, 'capacity refusal cannot consume proof, lease or sequence');
    const event = f.diagnostics.snapshot().events.find(row => row.deferred === 1 && row.pending === 256);
    assert.equal(event?.step, 1); assert.equal(event?.category, 'failed');
    f.fresh.answer(f.fresh.messages[0]!); await turn();
    const begins = f.fresh.messages.filter(row => row.kind === 'begin');
    assert.equal(begins.length, 256); assert.equal(begins[0]!.id, 3);
    for (const begin of begins) f.fresh.answer(begin);
    await turn(); assert.equal(f.calls(), 256); assert.equal(f.admission.snapshot().acceptedRequests, 256);
    const finishes = f.fresh.messages.filter(row => row.kind === 'finish'); assert.equal(finishes.length, 256);
    for (const finish of finishes) f.fresh.answer(finish);
    assert.ok((await drained).every(result => result.status === 'fulfilled'));
    assert.equal(f.admission.snapshot().acceptedRequests, 0); assert.equal(f.admission.snapshot().activeWriters, 0);
    assert.equal(f.admission.snapshot().recoveryProofs, 0); assert.equal(f.launches(), 2);
    assert.equal(f.old.messages.length, 1, 'original unacknowledged writer is never replayed');
    assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /private-|transient-|\/private-fixture/);
  } finally {
    f.fresh.emit('error', Error('cleanup')); await Promise.allSettled(requests);
  }
});

for (const failure of ['owner-fault', 'malformed-proof-ack'] as const) {
  test(`failed bounded reconciliation frees waiting slots, not original proof (${failure})`, async () => {
    const f = await recovering(), requests: Promise<number>[] = [];
    for (let i = 0; i < 256; i++) requests.push(f.admission.run('/private-fixture', 'durable', 1, f.write));
    const drained = Promise.allSettled(requests);
    await assert.rejects(f.admission.run('/private-fixture', 'durable', 1, f.write), capacity);
    if (failure === 'owner-fault') f.fresh.emit('error', Error('private-failure'));
    else f.fresh.answer(f.fresh.messages[0]!, '42'); // Reconciliation cannot return a begin volume.
    assert.ok((await drained).every(result => result.status === 'rejected'));
    const snapshot = f.admission.snapshot();
    assert.equal(snapshot.acceptedRequests, 0); assert.equal(snapshot.activeWriters, 0);
    assert.equal(snapshot.recoveryProofs, 1); assert.equal(f.calls(), 0); assert.equal(f.bindings(), 1);
    await pause();
    const next = f.admission.run('/private-fixture', 'durable', 1, f.write);
    const settled = Promise.allSettled([next]);
    try {
      const proof = f.repaired.messages[0]!; assert.equal(proof.kind, 'reconcile'); assert.equal(proof.id, 3);
      assert.equal(proof.lease, f.old.messages[0]!.lease); f.repaired.answer(proof); await turn();
      const begin = f.repaired.messages[1]!; assert.equal(begin.kind, 'begin'); f.repaired.answer(begin); await turn();
      f.repaired.answer(f.repaired.messages[2]!); assert.equal(await next, 1);
      assert.equal(f.admission.snapshot().acceptedRequests, 0); assert.equal(f.admission.snapshot().recoveryProofs, 0);
    } finally { f.repaired.emit('error', Error('cleanup')); await settled; }
  });
}

test('throwing overload log sink cannot drop bounded waiting slots or original proof', async () => {
  const f = await recovering(() => { throw Error('private-log-sink'); }), requests: Promise<number>[] = [];
  try {
    for (let i = 0; i < 256; i++) requests.push(f.admission.run('/private-fixture', 'durable', 1, f.write));
    const drained = Promise.allSettled(requests);
    await assert.rejects(f.admission.run('/private-fixture', 'durable', 1, f.write), capacity);
    const snapshot = f.admission.snapshot(); assert.equal(snapshot.acceptedRequests, 256);
    assert.equal(snapshot.recoveryProofs, 1); assert.equal(snapshot.activeWriters, 0); assert.equal(f.calls(), 0);
    assert.ok(f.diagnostics.snapshot().events.some(row => row.pending === 256 && row.delivery === 'failed'));
    f.fresh.emit('error', Error('cleanup')); await drained;
    assert.equal(f.admission.snapshot().acceptedRequests, 0);
  } finally { f.fresh.emit('error', Error('cleanup')); await Promise.allSettled(requests); }
});

test('an original live writer retains its accepted slot through owner failure and actual settlement', async () => {
  const owner = new Owner(); let release!: () => void, launches = 0;
  const original = new Promise<void>(resolve => { release = resolve; });
  const admission = new AsyncVolumeAdmission(() => { launches++; return owner as unknown as Worker; },
    new PerformanceDiagnostics(() => {}), { recoveryDelayMs: 1 }, () => '42');
  const running = admission.run('/private-fixture', 'durable', 1, async () => { await original; return 'original'; });
  const rejected = assert.rejects(running, /unavailable/);
  owner.answer(owner.messages[0]!); await turn(); owner.emit('error', Error('owner-failed')); await turn();
  assert.equal(admission.snapshot().acceptedRequests, 1); assert.equal(admission.snapshot().activeWriters, 1);
  assert.equal(admission.snapshot().blockedBy, 'active-writers');
  await pause(); await assert.rejects(admission.run('/private-fixture', 'durable', 1, async () => assert.fail('replacement')), /unavailable/);
  assert.equal(admission.snapshot().acceptedRequests, 1); assert.equal(launches, 1);
  release(); await rejected; // Known body result does not substitute for missing finish ACK.
  assert.equal(admission.snapshot().acceptedRequests, 0); assert.equal(admission.snapshot().activeWriters, 0);
  assert.equal(admission.snapshot().recoveryProofs, 1, 'writer settlement alone is not a release ACK');
});
