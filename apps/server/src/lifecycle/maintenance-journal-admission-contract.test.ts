import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncMaintenanceJournal, MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import { newMaintenanceJob } from './connector-maintenance.js';

class FakeWorker extends EventEmitter {
  requests: { id: number; kind: string; args: unknown[] }[] = [];
  terminated = 0;
  postMessage(value: { id: number; kind: string; args: unknown[] }) { this.requests.push(value); }
  async terminate() { this.terminated++; this.emit('exit', 1); return 1; }
}
const input = () => newMaintenanceJob({ id: 'request:1', nodeId: 'node:1', actorId: 'actor:1',
  operation: 'restart', createdAt: 1000, deadline: 60_000 });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(sink: (line: string) => void = () => {}) {
  const fake = new FakeWorker(), diagnostics = new PerformanceDiagnostics(sink);
  let failures = 0;
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, diagnostics,
    () => { failures++; }, () => fake as unknown as Worker);
  return { fake, diagnostics, owner, failures: () => failures };
}

for (const kind of ['get', 'unresolved'] as const)
test(`${kind} database RPC capacity refusal precedes caller snapshot and preserves accepted work`, async () => {
  const { fake, diagnostics, owner, failures } = fixture();
  const pending = Promise.allSettled(Array.from({ length: 256 }, (_, index) => owner[kind](`request:${index}`)));
  let inspected = 0;
  const value = input();
  Object.defineProperty(value, 'actorId', { enumerable: true, get() { inspected++; return 'private:actor'; } });
  try {
    await assert.rejects(owner.enqueue(value), MaintenanceJournalUnavailable);
    assert.equal(inspected, 0); assert.equal(owner.snapshot().accepted, 256);
    assert.equal(fake.requests.length, 0); assert.equal(fake.terminated, 0); assert.equal(failures(), 0);
    const event = diagnostics.snapshot().events.find(e => e.operation === 'maintenance-journal-rpc' && e.deferred === 1)!;
    assert.equal(event.category, 'failed'); assert.equal(event.pending, 256); assert.equal(event.unknown, undefined);
  } finally { fake.emit('exit', 1); await pending; await owner.close(); }
});

for (const fault of ['getter', 'non-cloneable', 'revoked-proxy'] as const)
  test(`pre-dispatch ${fault} failure is sanitized and does not halt the database owner`, async () => {
    const lines: string[] = [];
    const { fake, diagnostics, owner, failures } = fixture(line => lines.push(line));
    let value = input();
    if (fault === 'getter') Object.defineProperty(value, 'actorId', { enumerable: true, get() { throw Error('private-secret-fixture'); } });
    if (fault === 'non-cloneable') Object.defineProperty(value, 'privateField', { enumerable: true, value: () => {} });
    if (fault === 'revoked-proxy') { const proxy = Proxy.revocable(value, {}); proxy.revoke(); value = proxy.proxy; }
    try {
      await assert.rejects(owner.enqueue(value), MaintenanceJournalUnavailable);
      assert.equal(owner.snapshot().accepted, 0); assert.equal(owner.unavailable, false);
      assert.equal(fake.requests.length, 0); assert.equal(fake.terminated, 0); assert.equal(failures(), 0);
      const events = diagnostics.snapshot().events;
      assert.equal(events.length, 1); assert.equal(events[0]!.deferred, 1); assert.equal(events[0]!.unknown, undefined);
      assert.doesNotMatch(JSON.stringify({ lines, events }), /private-secret|privateField|actor:1|request:1|unused/);
      // A known refusal did not consume a request sequence or poison the
      // original owner. The next legal lookup still executes exactly once.
      fake.emit('message', { kind: 'ready' });
      const query = owner.get('request:1'); await turn();
      assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0]!.id, 1);
      fake.emit('message', { id: 1, kind: 'get', ok: true }); assert.equal(await query, undefined);
    } finally { fake.emit('exit', 1); await owner.close(); }
  });

for (const kind of ['get', 'unresolved'] as const)
test(`${kind} snapshot reentrancy cannot overfill the accepted database RPC queue`, async () => {
  const { fake, diagnostics, owner, failures } = fixture();
  const pending = Array.from({ length: 255 }, (_, index) => owner[kind](`request:${index}`));
  let extra: Promise<unknown> | undefined;
  const value = input();
  Object.defineProperty(value, 'actorId', { enumerable: true, get() { extra = owner[kind]('request:255'); return 'actor:1'; } });
  const settled = Promise.allSettled(pending);
  try {
    await assert.rejects(owner.enqueue(value), MaintenanceJournalUnavailable);
    assert.equal(owner.snapshot().accepted, 256); assert.equal(fake.requests.length, 0); assert.equal(failures(), 0);
    assert.equal(diagnostics.snapshot().events.at(-1)!.deferred, 1);
  } finally { const additional = Promise.allSettled([extra]); fake.emit('exit', 1); await settled; await additional; await owner.close(); }
});

test('snapshot reentrancy cannot admit new SQL after close has begun', async () => {
  const { fake, diagnostics, owner } = fixture();
  let closing: Promise<void> | undefined;
  const value = input();
  Object.defineProperty(value, 'actorId', { enumerable: true, get() { closing = owner.close(); return 'actor:1'; } });
  await assert.rejects(owner.enqueue(value), MaintenanceJournalUnavailable);
  // The original close itself is accepted while startup is still pending.
  assert.equal(owner.snapshot().accepted, 1); assert.equal(owner.snapshot().closing, true);
  assert.equal(diagnostics.snapshot().events.at(-1)!.deferred, 1);
  // The original close alone may cross the protocol. No new enqueue does.
  fake.emit('message', { kind: 'ready' }); await turn();
  assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0]!.kind, 'close'); assert.equal(fake.requests[0]!.id, 1);
  fake.emit('message', { id: 1, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
  assert.equal(owner.snapshot().ownerExitConfirmed, true);
});

for (const state of ['closed', 'failed'] as const)
  test(`${state} database owner refuses without invoking caller getters, even if the log sink fails`, async () => {
    const { fake, diagnostics, owner } = fixture(() => { throw Error('private-sink-fixture'); });
    if (state === 'closed') {
      fake.emit('message', { kind: 'ready' }); const close = owner.close(); await turn();
      fake.emit('message', { id: 1, kind: 'close', ok: true }); fake.emit('exit', 0); await close;
    } else { fake.emit('exit', 1); }
    const before = fake.requests.length;
    let inspected = 0; const value = input();
    Object.defineProperty(value, 'actorId', { enumerable: true, get() { inspected++; throw Error('private-input-fixture'); } });
    await assert.rejects(owner.enqueue(value), MaintenanceJournalUnavailable);
    assert.equal(inspected, 0); assert.equal(fake.requests.length, before); assert.equal(owner.snapshot().accepted, 0);
    const event = diagnostics.snapshot().events.find(e => e.deferred === 1)!;
    assert.equal(event.delivery, 'failed'); assert.equal(event.unknown, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-sink|private-input|actor:1|unused/);
    await owner.close();
  });
