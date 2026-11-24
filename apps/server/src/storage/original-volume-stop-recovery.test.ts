import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

class Owner extends EventEmitter {
  messages: any[] = [];
  stops = 0;
  stop: () => Promise<number> = () => Promise.resolve(1);
  postMessage(message: any) { this.messages.push(message); }
  ref() {} unref() {}
  terminate() { this.stops++; return this.stop(); }
  answer(message: any) { this.emit('message', { id: message.id, kind: message.kind, ok: true,
    ...(message.kind === 'begin' ? { volume: '42' } : {}) }); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const fault of ['thrown', 'rejected'] as const) {
  test(`refused ${fault} stop retries only original worker; SQL proof and writer are not replayed`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0;
    old.stop = () => {
      if (old.stops === 1) { if (fault === 'thrown') throw Error('private-stop'); return Promise.reject(Error('private-stop')); }
      return Promise.resolve(1);
    };
    const diagnostics = new PerformanceDiagnostics(() => {});
    const admission = new AsyncVolumeAdmission(() => (launches++ ? fresh : old) as unknown as Worker,
      diagnostics, { requestTimeoutMs: 10000, recoveryDelayMs: 1 }, () => '42');
    const original = admission.run('/private-volume', 'durable', 1, async () => ++calls);
    const rejected = assert.rejects(original); old.emit('error', Error('private-owner')); await rejected;
    await turn(); assert.equal(old.stops, 1); assert.equal(calls, 0);
    const proof = old.messages[0]!.lease;
    t.mock.timers.tick(999); assert.equal(old.stops, 1);
    t.mock.timers.tick(1); await turn(); assert.equal(old.stops, 2);
    assert.equal(admission.snapshot().blockedBy, 'owner-exit');
    assert.equal(admission.snapshot().recoveryProofs, 1);
    await assert.rejects(admission.run('/private-volume', 'durable', 1, async () => ++calls));
    t.mock.timers.tick(5000); assert.equal(old.stops, 2, 'successful stop request is never retried');
    assert.equal(launches, 1); assert.equal(old.messages.length, 1);
    old.emit('exit', 1); await turn();
    // Cooldown uses a monotonic clock, not the mock wall timer.
    await delay(5);
    const next = admission.run('/private-volume', 'durable', 1, async () => ++calls);
    void next.catch(() => {});
    await turn();
    assert.equal(fresh.messages[0]?.kind, 'reconcile');
    assert.equal(fresh.messages[0]?.lease, proof);
    fresh.answer(fresh.messages[0]); await turn();
    assert.equal(fresh.messages[1]?.kind, 'begin'); fresh.answer(fresh.messages[1]); await turn();
    assert.equal(calls, 1); fresh.answer(fresh.messages[2]); assert.equal(await next, 1);
    assert.equal(admission.snapshot().recoveryProofs, 0);
    const logs = diagnostics.snapshot().events.filter(row => row.operation === 'storage-coordinator-recovery');
    assert.ok(logs.some(row => row.step === 5 && row.unknown === 1 && row.category === 'failed'));
    assert.doesNotMatch(JSON.stringify(logs), /private|stop|volume/);
    fresh.emit('exit', 1);
  });
}

for (const fault of ['pending', 'resolved'] as const) {
  test(`${fault} stop has no second stop or replacement before actual exit`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const old = new Owner(); let launches = 0;
    old.stop = () => fault === 'pending' ? new Promise(() => {}) : Promise.resolve(1);
    const admission = new AsyncVolumeAdmission(() => { launches++; return old as unknown as Worker; },
      new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 10000, recoveryDelayMs: 1 }, () => '42');
    const original = admission.run('/private-volume', 'durable', 1, async () => assert.fail('no writer'));
    const rejected = assert.rejects(original); old.emit('error', Error('private-owner')); await rejected; await turn();
    t.mock.timers.tick(10000); await turn();
    assert.equal(old.stops, 1); assert.equal(launches, 1);
    assert.equal(admission.snapshot().blockedBy, 'owner-exit');
    old.emit('exit', 1); assert.equal(admission.snapshot().ownerExitConfirmed, true);
  });
}

test('actual exit cancels refused-stop cooldown without a second stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = new Owner(); old.stop = () => Promise.reject(Error('private-stop'));
  const admission = new AsyncVolumeAdmission(() => old as unknown as Worker, new PerformanceDiagnostics(() => {}),
    { requestTimeoutMs: 10000 }, () => '42');
  const original = admission.run('/private-volume', 'durable', 1, async () => assert.fail('no writer'));
  const rejected = assert.rejects(original); old.emit('error', Error('private-owner')); await rejected; await turn();
  old.emit('exit', 1); t.mock.timers.tick(10000); await turn(); assert.equal(old.stops, 1);
});

test('spontaneous actual exit is not followed by a termination request', async () => {
  const old = new Owner();
  const admission = new AsyncVolumeAdmission(() => old as unknown as Worker, new PerformanceDiagnostics(() => {}),
    { requestTimeoutMs: 10000 }, () => '42');
  const original = admission.run('/private-volume', 'durable', 1, async () => assert.fail('no writer'));
  const rejected = assert.rejects(original); old.emit('exit', 1); await rejected;
  assert.equal(old.stops, 0); assert.equal(admission.snapshot().ownerExitConfirmed, true);
});

test('stop-refusal observation reentry confirming exit cannot arm a stale retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = new Owner(); old.stop = () => Promise.reject(Error('private-stop'));
  const diagnostics = new PerformanceDiagnostics(line => {
    const row = JSON.parse(line);
    if (row.operation === 'storage-coordinator-recovery' && row.step === 5) old.emit('exit', 1);
  });
  const admission = new AsyncVolumeAdmission(() => old as unknown as Worker, diagnostics,
    { requestTimeoutMs: 10000 }, () => '42');
  const original = admission.run('/private-volume', 'durable', 1, async () => assert.fail('no writer'));
  const rejected = assert.rejects(original); old.emit('error', Error('private-owner')); await rejected; await turn();
  assert.equal(admission.snapshot().ownerExitConfirmed, true);
  t.mock.timers.tick(10000); await turn(); assert.equal(old.stops, 1);
});

test('refused-stop cleanup never releases an original active writer or its charge', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = new Owner(); let launches = 0, calls = 0, settle!: () => void;
  old.stop = () => old.stops === 1 ? Promise.reject(Error('private-stop')) : Promise.resolve(1);
  const admission = new AsyncVolumeAdmission(() => { launches++; return old as unknown as Worker; },
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 10000, recoveryDelayMs: 1 }, () => '42');
  const original = admission.run('/private-volume', 'durable', 1, () => {
    calls++; return new Promise<void>(resolve => { settle = resolve; });
  });
  const rejected = assert.rejects(original); old.answer(old.messages[0]); await turn();
  old.emit('error', Error('private-owner')); await turn();
  t.mock.timers.tick(1000); await turn(); assert.equal(old.stops, 2);
  old.emit('exit', 1); await turn();
  assert.equal(admission.snapshot().activeWriters, 1);
  assert.equal(admission.snapshot().recoveryProofs, 0);
  await assert.rejects(admission.run('/private-volume', 'durable', 1, async () => { calls++; }));
  assert.equal(launches, 1); assert.equal(calls, 1);
  settle(); await rejected;
  assert.equal(admission.snapshot().activeWriters, 0);
  assert.equal(admission.snapshot().recoveryProofs, 1);
  assert.equal(old.messages.length, 1, 'no finish or writer replay against the failed worker');
});

for (const fault of ['exit', 'error'] as const) {
test(`idle original ${fault} observation cannot retire a replacement or reject its pending begin`, async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0, first = true;
  let admission: AsyncVolumeAdmission, next: Promise<number> | undefined, observe = true;
  const diagnostics = new PerformanceDiagnostics(line => {
    const row = JSON.parse(line);
    if (observe && row.operation === 'storage-coordinator-recovery' && row.category === 'failed' && row.step === 1) {
      observe = false;
      if (fault === 'error') old.emit('exit', 1);
      now = 10;
      next = admission.run('/private-volume', 'durable', 1, async () => ++calls);
      void next.catch(() => {});
    }
  });
  admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    diagnostics, { requestTimeoutMs: 10000, recoveryDelayMs: 1 }, () => {
      if (first) { first = false; throw Error('private-sample'); }
      return '42';
    });
  await assert.rejects(admission.run('/private-volume', 'durable', 1, async () => assert.fail('no writer')));
  assert.equal(admission.snapshot().activeWriters, 0);
  old.emit(fault, fault === 'exit' ? 1 : Error('private-owner')); await turn();
  assert.equal(launches, 2); assert.equal(old.stops, fault === 'exit' ? 0 : 1);
  assert.equal(fresh.stops, 0, 'old retirement must not stop the replacement');
  assert.equal(admission.snapshot().pending, 1, 'old cleanup must not reject new begin');
  fresh.answer(fresh.messages[0]); await turn();
  assert.equal(calls, 1); fresh.answer(fresh.messages[1]); assert.equal(await next, 1);
  fresh.emit('exit', 1);
});
}

test('retirement clock reentry cannot replace an owner before original cleanup is published', async t => {
  let now = 0, reenter = false, launches = 0, first = true, calls = 0;
  const old = new Owner(), fresh = new Owner();
  let admission: AsyncVolumeAdmission, duringClock: Promise<number> | undefined;
  t.mock.method(performance, 'now', () => {
    if (reenter) {
      reenter = false; now = 10;
      duringClock = admission.run('/private-volume', 'durable', 1, async () => ++calls);
      void duringClock.catch(() => {});
    }
    return now;
  });
  admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => {}), { requestTimeoutMs: 10000, recoveryDelayMs: 1 }, () => {
      if (first) { first = false; throw Error('private-sample'); }
      return '42';
    });
  await assert.rejects(admission.run('/private-volume', 'durable', 1, async () => assert.fail('no writer')));
  reenter = true; old.emit('exit', 1);
  assert.ok(duringClock); await assert.rejects(duringClock);
  assert.equal(launches, 1); assert.equal(calls, 0); assert.equal(admission.snapshot().activeWriters, 0);
  now = 20;
  const next = admission.run('/private-volume', 'durable', 1, async () => ++calls);
  fresh.answer(fresh.messages[0]); await turn();
  fresh.answer(fresh.messages[1]); assert.equal(await next, 1);
  assert.equal(launches, 2); assert.equal(fresh.stops, 0);
  fresh.emit('exit', 1);
});
