import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { AsyncMaintenanceJournal } from './async-maintenance-journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
type Row = ReturnType<PerformanceDiagnostics['snapshot']>['events'][number];
type Stop = 'resolved' | 'thrown' | 'rejected';
type Options = { readOnly?: boolean; timeoutMs?: number; sink?: () => void; onFailure?: () => void };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
class Owner extends EventEmitter {
  stopRequests = 0;
  stop: Stop = 'resolved';
  messages: { id: number; kind: string }[] = [];
  exitOnClose = true;
  dispatchFails = false;
  closeRefuses = false;
  postMessage(message: { id: number; kind: string }) {
    if (this.dispatchFails) throw Error('private-dispatch-failure');
    this.messages.push(message);
    if (message.kind === 'close') queueMicrotask(() => {
      this.emit('message', this.closeRefuses
        ? { id: message.id, kind: 'close', ok: false, conflict: false }
        : { id: message.id, kind: 'close', ok: true });
      if (this.exitOnClose) this.emit('exit', 0);
    });
  }
  terminate() {
    this.stopRequests++;
    if (this.stop === 'thrown') throw Error('private-stop-failure');
    return this.stop === 'rejected' ? Promise.reject(Error('private-stop-failure')) : Promise.resolve(1);
  }
}

for (const readOnly of [false, true]) for (const stop of ['thrown', 'rejected'] as const)
test(`maintenance ${readOnly ? 'receipt reader' : 'writer'} ${stop} stop refusal retries only original cleanup`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, stop, { readOnly });
  const rejected = assert.rejects(f.owner.get('request:1')); await turn();
  f.worker.emit('error', Error('private-owner')); await rejected; await turn();
  assert.equal(f.worker.stopRequests, 1);
  t.mock.timers.tick(999); await turn(); assert.equal(f.worker.stopRequests, 1);
  f.worker.stop = 'resolved'; t.mock.timers.tick(1); await turn();
  assert.equal(f.worker.stopRequests, 2);
  let closed = false;
  const original = f.owner.close(); void original.then(() => { closed = true; });
  await turn(); assert.equal(f.worker.stopRequests, 2);
  t.mock.timers.tick(5000); await turn();
  assert.equal(f.worker.stopRequests, 2); assert.equal(closed, false);
  assert.equal(f.worker.messages.length, 1);
  assert.equal(f.owner.snapshot().unavailable, true);
  assert.equal(f.owner.snapshot().ownerExitConfirmed, false);
  assert.equal(f.owner.snapshot().accepted, 0); assert.equal(f.owner.metadataUsage.bytes, 0);
  f.worker.emit('exit', 1); await original; assert.equal(f.owner.close(), original);
  t.mock.timers.tick(10000); await turn(); assert.equal(f.worker.stopRequests, 2);
  const retired = f.rows.filter(row => row.operation === 'maintenance-journal-owner' && row.step === 1);
  assert.equal(retired.length, 1); assert.equal(retired[0]!.ownerFailureCode, 2);
  assert.equal(f.rows.filter(row => row.operation === 'maintenance-journal-owner' && row.step === 3).length, 1);
  assert.equal(f.rows.find(row => row.operation === 'maintenance-journal-owner' && row.step === 2)!.ownerFailureCode, 2);
  assert.doesNotMatch(JSON.stringify(f.rows), /private-/);
});

test('maintenance close cannot duplicate an outstanding successful physical stop request', async t => {
  const f = await fixture(t);
  f.worker.emit('error', Error('private-owner')); await turn();
  assert.equal(f.worker.stopRequests, 1);
  const original = f.owner.close(); await turn();
  assert.equal(f.worker.stopRequests, 1);
  assert.equal(f.owner.snapshot().ownerExitConfirmed, false);
  f.worker.emit('exit', 1); await original;
});
async function fixture(t: TestContext, stop: Stop = 'resolved', options: Options = {}) {
  const worker = new Owner(); worker.stop = stop;
  const rows: Row[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { rows.push(JSON.parse(line)); options.sink?.(); });
  const owner = new AsyncMaintenanceJournal({ file: 'private-fixture', dev: 1, ino: 2,
    ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}) }, diagnostics,
    options.onFailure ?? (() => {}), () => worker as unknown as Worker, options.timeoutMs ?? 30_000);
  t.after(async () => { worker.emit('exit', 1); await owner.close().catch(() => {}); });
  worker.emit('message', { kind: 'ready' }); await owner.open();
  return { worker, owner, rows, diagnostics };
}
test('idle maintenance error has a fixed retirement cause', async t => {
  const f = await fixture(t);
  f.worker.emit('error', Error('private-owner-failure'));
  assert.equal(f.owner.snapshot().unavailable, true);
  assert.ok(f.rows.some(row => row.operation === 'maintenance-journal-owner' && row.step === 1 && row.ownerFailureCode === 2));
  assert.doesNotMatch(JSON.stringify(f.rows), /private-/);
});
for (const stop of ['thrown', 'rejected'] as const) test(`maintenance termination ${stop} has separate refusal evidence`, async t => {
  const f = await fixture(t, stop);
  assert.doesNotThrow(() => f.worker.emit('error', Error('private-owner-failure')));
  await turn();
  assert.equal(f.owner.snapshot().ownerExitConfirmed, false);
  assert.ok(f.rows.some(row => row.operation === 'maintenance-journal-owner' && row.step === 3 && row.ownerFailureCode === 9 && row.unknown === 1));
});
test('actual maintenance exit retains first failure cause without a SQL commit assertion', async t => {
  const f = await fixture(t, 'rejected');
  f.worker.emit('error', Error('private-owner-failure')); await turn();
  f.worker.emit('exit', 1);
  assert.equal(f.owner.snapshot().ownerExitConfirmed, true);
  const event = f.rows.find(row => row.operation === 'maintenance-journal-owner' && row.step === 2);
  assert.ok(event); assert.equal(event.ownerFailureCode, 2);
  assert.equal(event.commitMs, undefined);
});
test('idle unexpected exit records retirement before actual exit', async t => {
  const f = await fixture(t); f.worker.emit('exit', 1);
  const lifecycle = f.rows.filter(row => row.operation === 'maintenance-journal-owner');
  assert.deepEqual(lifecycle.map(row => row.step), [1, 2]);
  assert.ok(lifecycle.every(row => row.ownerFailureCode === 3));
});
test('clean maintenance close records actual exit without an invented failure', async t => {
  const f = await fixture(t); await f.owner.close();
  const lifecycle = f.rows.filter(row => row.operation === 'maintenance-journal-owner');
  assert.equal(lifecycle.length, 1); assert.equal(lifecycle[0]!.step, 2);
  assert.equal(lifecycle[0]!.ownerFailureCode, undefined);
});
test('startup deadline has a distinct first cause and cannot assert owner exit', async t => {
  const worker = new Owner(), rows: Row[] = [];
  const owner = new AsyncMaintenanceJournal({ file: 'private-fixture', dev: 1, ino: 2 }, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), () => {}, () => worker as unknown as Worker, 10);
  t.after(async () => { worker.emit('exit', 1); await owner.close().catch(() => {}); });
  await assert.rejects(owner.open());
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  assert.ok(rows.some(row => row.operation === 'maintenance-journal-owner' && row.step === 1 && row.ownerFailureCode === 1 && row.timedOut === 1));
});
for (const [cause, name] of [[4, 'protocol'], [5, 'request-deadline'], [6, 'dispatch'], [7, 'sequence']] as const) test(`maintenance retirement classifies ${name} without replay`, async t => {
  const f = await fixture(t, 'resolved', { timeoutMs: 10 });
  if (cause === 4) f.worker.emit('message', { kind: 'private-invalid' });
  else {
    if (cause === 6) f.worker.dispatchFails = true;
    if (cause === 7) (f.owner as unknown as { sequence: number }).sequence = Number.MAX_SAFE_INTEGER;
    await assert.rejects(f.owner.get('request:1'));
  }
  assert.ok(f.rows.some(row => row.operation === 'maintenance-journal-owner' && row.step === 1 && row.ownerFailureCode === cause));
  const count = f.worker.messages.length;
  await assert.rejects(f.owner.get('request:1'));
  assert.equal(f.worker.messages.length, count);
});
test('close deadline logs cause 8 and preserves the original close promise until real exit', async t => {
  const f = await fixture(t, 'resolved', { timeoutMs: 10 }); f.worker.exitOnClose = false;
  const closing = f.owner.close(); assert.ok(f.owner.close() === closing);
  let settled = false; const rejection = assert.rejects(closing).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false); assert.equal(f.owner.snapshot().ownerExitConfirmed, false);
  assert.ok(f.rows.some(row => row.operation === 'maintenance-journal-owner' && row.step === 1 && row.ownerFailureCode === 8));
  f.worker.emit('exit', 1); await rejection;
  assert.equal(f.rows.find(row => row.operation === 'maintenance-journal-owner' && row.step === 2)!.ownerFailureCode, 8);
});
test('settled stopped-reader SQL refusal is distinct from malformed protocol and does not replace the owner', async t => {
  const f = await fixture(t, 'resolved', { readOnly: true });
  const rejected = assert.rejects(f.owner.get('request:1')); await turn();
  f.worker.emit('message', { id: f.worker.messages[0]!.id, kind: 'get', ok: false, conflict: false }); await rejected;
  assert.ok(f.rows.some(row => row.operation === 'maintenance-journal-owner' && row.step === 1 && row.ownerFailureCode === 10));
  assert.ok(f.rows.some(row => row.operation === 'maintenance-journal-rpc' && row.settled === 1 && row.unknown === undefined));
});
test('acknowledged close SQL refusal is not mislabeled as malformed protocol', async t => {
  const f = await fixture(t); f.worker.closeRefuses = true;
  await assert.rejects(f.owner.close());
  const retirement = f.rows.find(row => row.operation === 'maintenance-journal-owner' && row.step === 1);
  assert.equal(retirement?.ownerFailureCode, 10);
  const rpc = f.rows.find(row => row.operation === 'maintenance-journal-rpc' && row.step === 9);
  assert.equal(rpc?.settled, 1);
  assert.equal(rpc?.unknown, undefined);
});
test('physical cleanup waits for actual exit after SQL close refusal, retaining its rejected original ACK', async t => {
  const f = await fixture(t); f.worker.closeRefuses = true; f.worker.exitOnClose = false;
  const closing = f.owner.close(); const rejection = assert.rejects(closing);
  const cleanup = f.owner.closeForShutdown(); assert.equal(f.owner.closeForShutdown(), cleanup);
  let cleaned = false; void cleanup.then(() => { cleaned = true; });
  await turn(); assert.equal(cleaned, false); assert.equal(f.owner.snapshot().ownerExitConfirmed, false);
  f.worker.emit('exit', 1); await rejection; await cleanup;
  assert.equal(cleaned, true); assert.equal(f.owner.close(), closing);
  await assert.rejects(f.owner.enqueue({} as never));
  assert.ok(f.rows.some(row => row.step === 2 && row.ownerFailureCode === 10));
});
test('physical cleanup cannot bypass a retained reader whose actual exit is still unknown', async t => {
  const f = await fixture(t), reader = await fixture(t, 'rejected', { readOnly: true });
  f.worker.emit('error', Error('private-owner')); f.worker.emit('exit', 1);
  reader.worker.emit('error', Error('private-reader'));
  (f.owner as unknown as { stoppedReader: AsyncMaintenanceJournal }).stoppedReader = reader.owner;
  const cleanup = f.owner.closeForShutdown();
  let cleaned = false; void cleanup.then(() => { cleaned = true; });
  await turn(); assert.equal(cleaned, false); assert.equal(f.owner.snapshot().ownerExitConfirmed, true);
  reader.worker.emit('exit', 1); await cleanup;
  assert.equal(cleaned, true);
});
test('diagnostic reentry observes latched first cause and rejected original pending requests', async t => {
  let reenter = () => {};
  const f = await fixture(t, 'resolved', { sink: () => reenter() });
  const rejected = assert.rejects(f.owner.get('request:1')); await turn();
  reenter = () => {
    reenter = () => {};
    assert.equal(f.owner.snapshot().unavailable, true);
    assert.equal(f.owner.snapshot().pending, 0);
    f.worker.emit('message', { kind: 'private-invalid' });
  };
  f.worker.emit('error', Error('private-owner-failure')); await rejected;
  f.worker.emit('exit', 1);
  assert.equal(f.rows.find(row => row.operation === 'maintenance-journal-owner' && row.step === 2)!.ownerFailureCode, 2);
});
test('maintenance and readonly owner logs share one bounded reserve without consuming process closure evidence', () => {
  const rows: Row[] = [], d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 100; i++) d.start('storage-admission').finish(true);
  for (let i = 0; i < 200; i++) {
    const trace = d.start(i % 2 ? 'maintenance-journal-owner' : 'auth-display-read');
    trace.add('step', i % 2 ? 1 : 6); trace.add('ownerFailureCode', 2); trace.finish(true);
  }
  assert.equal(rows.filter(row => row.operation === 'maintenance-journal-owner' || row.operation === 'auth-display-read').length, 60);
  assert.equal(d.snapshot().events.length, d.snapshot().capacity);
  assert.ok(d.snapshot().events.every(row => row.delivery === 'rate-limited'));
  d.start('process-shutdown').finish(true); assert.equal(rows.at(-1)!.operation, 'process-shutdown');
});

test('throwing diagnostic sink and failure callback cannot prevent waiter rejection or original exit recovery', async t => {
  const f = await fixture(t, 'rejected', {
    sink() { throw Error('private-sink'); },
    onFailure() { throw Error('private-callback'); },
  });
  const rejected = assert.rejects(f.owner.get('request:1')); await turn();
  assert.doesNotThrow(() => f.worker.emit('error', Error('private-owner')));
  await rejected; await turn();
  assert.equal(f.owner.snapshot().pending, 0);
  assert.equal(f.owner.snapshot().ownerExitConfirmed, false);
  assert.ok(f.rows.some(row => row.step === 3 && row.ownerFailureCode === 9));
  const original = f.owner.close();
  assert.equal(f.owner.close(), original);
  f.worker.emit('exit', 1); await original;
  assert.equal(f.rows.find(row => row.operation === 'maintenance-journal-owner' && row.step === 2)!.ownerFailureCode, 2);
  assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /private-/);
});
