import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Request = { id: number; kind: string; lease?: string };
class Owner extends EventEmitter {
  readonly messages: Request[] = [];
  hook: ((message: Request) => void) | undefined;
  postMessage(message: Request) { this.messages.push(message); this.hook?.(message); }
  ref() {} unref() {}
  terminate() { return Promise.resolve().then(() => { this.emit('exit', 1); return 1; }); }
  answer(message: Request) {
    this.emit('message', { id: message.id, kind: message.kind, ok: true,
      ...(message.kind === 'begin' ? { volume: '42' } : {}) });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const failure of [false, true]) {
  test(`publish exact-proof recovery barrier before synchronous transport reentry (${failure ? 'failure' : 'success'})`, async () => {
    const old = new Owner(), fresh = new Owner(); let launches = 0, calls = 0;
    let nested: Promise<number> | undefined;
    const diagnostics = new PerformanceDiagnostics(() => {});
    const admission = new AsyncVolumeAdmission(() => (launches++ ? fresh : old) as unknown as Worker,
      diagnostics, { recoveryDelayMs: 1, requestTimeoutMs: 5000 }, () => '42');
    const first = admission.run('/private-fixture', 'durable', 1, async () => ++calls);
    const rejected = assert.rejects(first, /unavailable/);
    old.emit('error', Error('private-owner-error')); await rejected;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    fresh.hook = message => {
      if (message.kind !== 'reconcile') return;
      fresh.hook = undefined;
      nested = admission.run('/private-fixture', 'durable', 1, async () => ++calls);
      void nested.catch(() => {});
    };
    const outer = admission.run('/private-fixture', 'durable', 1, async () => ++calls);
    void outer.catch(() => {});
    try {
      const proofs = fresh.messages.filter(m => m.kind === 'reconcile');
      assert.equal(proofs.length, 1); assert.ok(nested);
      assert.equal(admission.snapshot().acceptedRequests, 2);
      assert.equal(admission.snapshot().pending, 1); assert.equal(calls, 0);
      assert.equal(proofs[0]!.lease, old.messages[0]!.lease);
      if (failure) {
        fresh.emit('error', Error('private-proof-error'));
        const outcomes = await Promise.allSettled([outer, nested]);
        assert.ok(outcomes.every(row => row.status === 'rejected'));
        assert.equal(admission.snapshot().recoveryProofs, 1);
        assert.equal(calls, 0);
      } else {
        fresh.answer(proofs[0]!); await turn();
        const begins = fresh.messages.filter(m => m.kind === 'begin');
        assert.equal(begins.length, 2);
        for (const begin of begins) fresh.answer(begin);
        await turn(); assert.equal(calls, 2);
        const finishes = fresh.messages.filter(m => m.kind === 'finish');
        assert.equal(finishes.length, 2);
        for (const finish of finishes) fresh.answer(finish);
        const outcomes = await Promise.allSettled([outer, nested]);
        assert.ok(outcomes.every(row => row.status === 'fulfilled'));
        assert.equal(admission.snapshot().recoveryProofs, 0);
      }
      assert.equal(old.messages.length, 1, 'the original unacknowledged write is never replayed');
      assert.equal(admission.snapshot().acceptedRequests, 0);
      assert.equal(admission.snapshot().pending, 0);
      assert.equal(admission.snapshot().activeWriters, 0);
      assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-|\/private-fixture/);
    } finally { fresh.emit('error', Error('cleanup')); await Promise.allSettled([outer, nested]); }
  });
}
