import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncSqliteAuthDisplay } from '../auth/async-sqlite-display.js';
import { AsyncHubDeliveryReader } from '../hub/async-delivery-reader.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
class Observer extends EventEmitter {
  messages: { id: number; kind: string }[] = [];
  terminated = 0;
  autoClose = true;
  termination: 'normal' | 'throw' | 'reject' = 'normal';
  postMessage(message: { id: number; kind: string }) {
    this.messages.push(message);
    if (message.kind === 'close' && this.autoClose) queueMicrotask(() => {
      this.emit('message', { ...message, ok: true }); this.emit('exit', 0);
    });
  }
  terminate(): Promise<number> {
    this.terminated++;
    if (this.termination === 'throw') throw Error('private-termination');
    if (this.termination === 'reject') return Promise.reject(Error('private-termination'));
    // Resolving terminate does not emit exit or provide disposal evidence.
    return Promise.resolve(1);
  }
}

for (const owner of ['auth', 'hub'] as const) {
  const operation = owner === 'auth' ? 'auth-display-read' : 'hub-delivery-read';
  function fixture(diagnostics?: PerformanceDiagnostics, timeout = 30_000, ready = true) {
    const worker = new Observer(), lines: string[] = [];
    diagnostics ??= new PerformanceDiagnostics(line => lines.push(line), () => 0);
    const launch = () => worker as unknown as Worker;
    const reader = owner === 'auth'
      ? new AsyncSqliteAuthDisplay({ file: '/unused', dev: 1, ino: 1 }, diagnostics, launch, timeout)
      : new AsyncHubDeliveryReader({ file: '/unused', dev: 1, ino: 1 }, diagnostics, launch, timeout);
    const read = () => reader instanceof AsyncSqliteAuthDisplay ? reader.read('status')
      : reader.read({ owner: 'default', domains: [['node', 'current']] });
    const events = () => lines.map(line => JSON.parse(line)).filter(row => row.operation === operation);
    if (ready) worker.emit('message', { kind: 'ready' });
    return { worker, reader, read, events };
  }

  for (const fault of ['error', 'protocol', 'exit'] as const)
    test(`${owner} idle ${fault} records retirement and actual exit without exposing payload`, async () => {
      const h = fixture();
      try {
        if (fault === 'error') h.worker.emit('error', Error('private-payload'));
        if (fault === 'protocol') h.worker.emit('message', { secret: 'private-payload' });
        if (fault === 'exit') h.worker.emit('exit', 1);
        await turn();
        const retired = h.events().filter(row => row.step === 6);
        assert.equal(retired.length, 1);
        assert.equal(retired[0].ownerFailureCode, { error: 2, protocol: 4, exit: 3 }[fault]);
        assert.equal(retired[0].pending, 0);
        assert.equal(h.reader.recoveryState.exitConfirmed, fault === 'exit');
        await assert.rejects(h.read());
        h.worker.emit('exit', 1);
        assert.equal(h.events().filter(row => row.step === 7).length, 1);
        await h.reader.close();
        assert.doesNotMatch(JSON.stringify(h.events()), /private-payload/);
      } finally { h.worker.emit('exit', 1); await h.reader.close(); }
    });

  for (const termination of ['normal', 'throw', 'reject'] as const)
    test(`${owner} ${termination} termination never proves exit or loses the original drain`, async () => {
      const h = fixture(); h.worker.termination = termination;
      const read = h.read(), rejected = assert.rejects(read);
      try {
        await turn();
        assert.doesNotThrow(() => h.worker.emit('error', Error('private-payload')));
        await rejected; await turn();
        assert.deepEqual(h.reader.recoveryState, { unavailable: true, exitConfirmed: false });
        const retired = h.events().filter(row => row.step === 6);
        assert.equal(retired.length, 1); assert.equal(retired[0].pending, 1);
        assert.equal(retired[0].unknown, 1);
        if (termination !== 'normal') {
          const refusedStop = h.events().filter(row => row.step === 8);
          assert.equal(refusedStop.length, 1); assert.equal(refusedStop[0].ownerFailureCode, 9);
        }
        let closed = false;
        const closing = h.reader.close(); void closing.then(() => { closed = true; });
        assert.equal(h.reader.close(), closing);
        await turn(); assert.equal(closed, false);
        assert.equal(h.worker.terminated, 1); assert.equal(h.worker.messages.length, 1);
        h.worker.emit('exit', 1); await closing;
        assert.equal(closed, true); assert.equal(h.reader.recoveryState.exitConfirmed, true);
        assert.equal(h.events().filter(row => row.step === 7).length, 1);
        assert.doesNotMatch(JSON.stringify(h.events()), /private-payload|private-termination/);
      } finally { h.worker.emit('exit', 1); await rejected; await h.reader.close(); }
    });

  test(`${owner} sequence exhaustion retires observer rather than permanent unobservable refusal`, async () => {
    const h = fixture(); Reflect.set(h.reader, 'sequence', Number.MAX_SAFE_INTEGER);
    try {
      await assert.rejects(h.read());
      assert.deepEqual(h.reader.recoveryState, { unavailable: true, exitConfirmed: false });
      assert.equal(h.worker.messages.length, 0); assert.equal(h.worker.terminated, 1);
      const retired = h.events().filter(row => row.step === 6);
      assert.equal(retired.length, 1); assert.equal(retired[0].ownerFailureCode, 7);
      h.worker.emit('exit', 1); await h.reader.close();
      } finally { h.worker.emit('exit', 1); await h.reader.close(); }
    });

  for (const termination of ['throw', 'reject'] as const)
    test(`${owner} ${termination} stop refusal recovers the original drain without another close or read replay`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const h = fixture(); h.worker.termination = termination;
      const rejected = assert.rejects(h.read());
      try {
        await turn(); h.worker.emit('error', Error('private-payload'));
        await rejected; await turn();
        const closing = h.reader.close(); let closed = false;
        void closing.then(() => { closed = true; });
        await turn();
        assert.equal(h.worker.terminated, 1); assert.equal(closed, false);
        t.mock.timers.tick(999); await turn(); assert.equal(h.worker.terminated, 1);
        h.worker.termination = 'normal';
        t.mock.timers.tick(1); await turn();
        assert.equal(h.worker.terminated, 2);
        // A successful termination request is still not physical exit. Do
        // not repeat it, replace the reader, or release the original drain.
        t.mock.timers.tick(5000); await turn();
        assert.equal(h.worker.terminated, 2); assert.equal(closed, false);
        assert.equal(h.worker.messages.length, 1);
        assert.deepEqual(h.reader.recoveryState, { unavailable: true, exitConfirmed: false });
        h.worker.emit('exit', 1); await closing;
        assert.equal(closed, true); assert.equal(h.reader.close(), closing);
        assert.equal(h.events().filter(row => row.step === 6).length, 1);
        assert.equal(h.events().filter(row => row.step === 8).length, 1);
        const exited = h.events().filter(row => row.step === 7);
        assert.equal(exited.length, 1); assert.equal(exited[0].ownerFailureCode, 2);
        t.mock.timers.tick(10000); await turn(); assert.equal(h.worker.terminated, 2);
        assert.doesNotMatch(JSON.stringify(h.events()), /private-payload|private-termination/);
      } finally { h.worker.emit('exit', 1); await h.reader.close(); }
    });

  for (const startup of [true, false]) test(`${owner} ${startup ? 'startup' : 'query'} deadline records its fixed reason`, async () => {
    const h = fixture(undefined, 10, !startup);
    const rejected = assert.rejects(h.read());
    try {
      await delay(30); await rejected;
      const retired = h.events().filter(row => row.step === 6);
      assert.equal(retired.length, 1); assert.equal(retired[0].ownerFailureCode, startup ? 1 : 5);
      assert.equal(h.reader.recoveryState.exitConfirmed, false);
      assert.equal(h.worker.messages.length, startup ? 0 : 1);
      h.worker.emit('exit', 1); await h.reader.close();
    } finally { h.worker.emit('exit', 1); await rejected; await h.reader.close(); }
  });

  test(`${owner} dispatch refusal is recorded once and does not replay`, async () => {
    const h = fixture();
    h.worker.postMessage = () => { throw Error('private-dispatch'); };
    try {
      await assert.rejects(h.read());
      const retired = h.events().filter(row => row.step === 6);
      assert.equal(retired.length, 1); assert.equal(retired[0].ownerFailureCode, 6);
      assert.equal(h.worker.terminated, 1); assert.equal(h.reader.recoveryState.exitConfirmed, false);
      h.worker.emit('exit', 1); await h.reader.close();
      assert.doesNotMatch(JSON.stringify(h.events()), /private-dispatch/);
    } finally { h.worker.emit('exit', 1); await h.reader.close(); }
  });

  test(`${owner} close deadline records reason but requires actual late exit`, async () => {
    const h = fixture(undefined, 10); h.worker.autoClose = false;
    let closed = false;
    const closing = h.reader.close(); void closing.then(() => { closed = true; });
    try {
      await delay(30);
      assert.equal(closed, false); assert.equal(h.reader.close(), closing);
      const retired = h.events().filter(row => row.step === 6);
      assert.equal(retired.length, 1); assert.equal(retired[0].ownerFailureCode, 8);
      assert.equal(h.worker.terminated, 1); assert.equal(h.reader.recoveryState.exitConfirmed, false);
      h.worker.emit('exit', 1); await closing; assert.equal(closed, true);
    } finally { h.worker.emit('exit', 1); await closing; }
  });

  test(`${owner} clean close records actual observer exit but not retirement`, async () => {
    const h = fixture(); await h.reader.close();
    assert.equal(h.events().filter(row => row.step === 6).length, 0);
    const exited = h.events().filter(row => row.step === 7);
    assert.equal(exited.length, 1); assert.equal(exited[0].settled, 1);
    assert.equal(exited[0].ownerFailureCode, undefined);
    assert.deepEqual(h.reader.recoveryState, { unavailable: false, exitConfirmed: true });
  });

  test(`${owner} retirement evidence survives saturated ordinary failures and a broken sink`, async () => {
    const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); }, () => 0);
    for (let i = 0; i < 100; i++) diagnostics.start('storage-admission').finish(true);
    const h = fixture(diagnostics);
    try {
      h.worker.emit('error', Error('private-payload'));
      h.worker.emit('exit', 1); await h.reader.close();
      const events = diagnostics.snapshot().events.filter(row => row.operation === operation);
      assert.ok(events.some(row => row.step === 6 && row.delivery === 'failed'));
      assert.ok(events.some(row => row.step === 7 && row.delivery === 'failed'));
      assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-sink|private-payload/);
    } finally { h.worker.emit('exit', 1); await h.reader.close(); }
  });
}
