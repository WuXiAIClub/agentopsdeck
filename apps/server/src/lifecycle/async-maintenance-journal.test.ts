import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncMaintenanceJournal, MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import { newMaintenanceJob, validMaintenanceJob } from './connector-maintenance.js';
import { MaintenanceConflict, SqliteMaintenanceJournal } from './maintenance-journal.js';

const job = () => newMaintenanceJob({ id: 'request:1', nodeId: 'node:1', actorId: 'actor:1', operation: 'restart', createdAt: 1000, deadline: 60_000 });
const silent = new PerformanceDiagnostics(() => {});
function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-async-journal-'));
  const file = join(directory, 'private.sqlite');
  const db = new DatabaseSync(file); db.close(); chmodSync(file, 0o600);
  const { dev, ino } = lstatSync(file);
  const owners: AsyncMaintenanceJournal[] = [];
  const open = () => { const owner = new AsyncMaintenanceJournal({ file, dev, ino }, silent); owners.push(owner); return owner; };
  t.after(async () => { try { await Promise.all(owners.map(owner => owner.close())); } finally { rmSync(directory, { recursive: true, force: true }); } });
  return { file, open };
}

test('real worker owns durable SQL, snapshots input and preserves original receipt after reopen', async t => {
  const f = fixture(t), first = f.open(), input = job();
  const pending = first.enqueue(input); input.actorId = 'replacement';
  assert.deepEqual(await pending, job());
  assert.deepEqual(await first.get('request:1'), job());
  await assert.rejects(first.enqueue({ ...job(), id: 'request:2' }), MaintenanceConflict);
  assert.equal(await first.compareAndSwap(job(), { ...job(), revision: 1, executing: true }), true);
  assert.equal(await first.compareAndSwap(job(), { ...job(), revision: 1, executing: true }), false);
  assert.deepEqual(await first.enqueue(job()), { ...job(), revision: 1, executing: true }, 'duplicate returns the original advanced receipt');
  await first.close();
  const second = f.open();
  assert.deepEqual(await second.unresolved('node:1'), { ...job(), revision: 1, executing: true });
  const db = new DatabaseSync(f.file);
  try { assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal'); }
  finally { db.close(); }
});

test('close drains already accepted requests during startup and rejects later admissions', async t => {
  const f = fixture(t), owner = f.open();
  const pending = owner.enqueue(job()), closing = owner.close();
  assert.deepEqual(await pending, job()); await closing;
  await assert.rejects(owner.enqueue({ ...job(), id: 'request:2' }), MaintenanceJournalUnavailable);
  assert.deepEqual(await f.open().get('request:1'), job());
});

test('real worker waiting for a SQLite writer lock leaves host responsive and commits the original request once', async t => {
  const f = fixture(t), owner = f.open(); await owner.open();
  // Independent fixture contention only, never a second production owner.
  const blocker = new DatabaseSync(f.file);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    let settled = false;
    const pending = owner.enqueue(job());
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await turn(); assert.equal(owner.snapshot().pending, 1);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false, 'host timer runs before the blocked worker SQL can settle');
    blocker.exec('ROLLBACK');
    assert.deepEqual(await pending, job());
    assert.deepEqual(await owner.get('request:1'), job());
    const count = blocker.prepare('SELECT count(*) AS n FROM connector_maintenance_jobs').get()!;
    assert.equal(count.n, 1, 'lock contention does not replay the original enqueue');
  } finally { blocker.close(); }
});

test('private file identity/mode changes before worker open fail closed', async t => {
  const f = fixture(t); chmodSync(f.file, 0o644);
  await assert.rejects(f.open().open(), MaintenanceJournalUnavailable);
});

test('settled journal errors do not reconnect or replay and receipts remain queryable after explicit repair', async t => {
  const f = fixture(t), owner = f.open(); await owner.enqueue(job());
  const db = new DatabaseSync(f.file);
  try {
    db.exec('DROP TABLE connector_maintenance_jobs');
    await assert.rejects(owner.unresolved('node:1'), MaintenanceJournalUnavailable);
    assert.equal(owner.unavailable, false, 'settled SQL failure is not transport ambiguity');
    new SqliteMaintenanceJournal(db, silent);
    assert.equal(await owner.get('request:1'), undefined);
  } finally { db.close(); }
});

class FakeWorker extends EventEmitter {
  requests: { id: number; kind: string; args: unknown[] }[] = [];
  terminated = 0;
  postMessage(value: { id: number; kind: string; args: unknown[] }) { this.requests.push(value); }
  async terminate() { this.terminated++; this.emit('exit', 1); return 1; }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('unresolved owner reads coalesce only in flight, detach receipts and refresh negative ACKs', async t => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  t.after(async () => { await fake.terminate(); await owner.close().catch(() => {}); });
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = Promise.allSettled(Array.from({ length: 300 }, () => owner.unresolved('node:1')));
  await turn(); assert.equal(fake.requests.length, 1); assert.equal(owner.snapshot().accepted, 1);
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'unresolved', ok: true,
    value: { ...job(), stage: 'drain', revision: 1, release: { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) } } });
  const results = await pending;
  assert.ok(results.every(result => result.status === 'fulfilled'));
  const values = results.map(result => (result as PromiseFulfilledResult<ReturnType<typeof job>>).value);
  values[0]!.release!.revision = 'changed'; assert.equal(values[1]!.release!.revision, 'a'.repeat(40));
  const negative = assert.rejects(owner.unresolved('node:1'), MaintenanceJournalUnavailable); await turn();
  assert.equal(fake.requests.length, 2);
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'unresolved', ok: false, conflict: false }); await negative;
  assert.equal(owner.unavailable, false);
  const missing = owner.unresolved('node:1'); await turn();
  fake.emit('message', { id: fake.requests[2]!.id, kind: 'unresolved', ok: true }); assert.equal(await missing, undefined);
  const fresh = owner.unresolved('node:1'); await turn(); assert.equal(fake.requests.length, 4);
  fake.emit('message', { id: fake.requests[3]!.id, kind: 'unresolved', ok: true, value: job() }); await fresh;
  const closing = owner.close(); await turn();
  await assert.rejects(owner.unresolved('node:1'), MaintenanceJournalUnavailable);
  fake.emit('message', { id: fake.requests[4]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('a mutation fences unresolved-owner reads and old cleanup cannot remove the newer flight', async t => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  t.after(async () => { await fake.terminate(); await owner.close().catch(() => {}); });
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const old = owner.unresolved('node:1'), next = { ...job(), revision: 1, executing: true as const };
  const write = owner.compareAndSwap(job(), next), fresh = owner.unresolved('node:1'); await turn();
  assert.deepEqual(fake.requests.map(r => r.kind), ['unresolved', 'compareAndSwap', 'unresolved']);
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'unresolved', ok: true, value: job() }); await old;
  const joined = owner.unresolved('node:1'); await turn(); assert.equal(fake.requests.length, 3);
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'compareAndSwap', ok: true, value: true });
  fake.emit('message', { id: fake.requests[2]!.id, kind: 'unresolved', ok: true, value: next });
  assert.equal(await write, true); assert.deepEqual(await fresh, next); assert.deepEqual(await joined, next);
  const closing = owner.close(); await turn();
  fake.emit('message', { id: fake.requests[3]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

for (const kind of ['enqueue', 'compareAndSwap', 'get'] as const)
  test(`accepted ${kind} fences earlier connection observations and retains the newer original flight`, async t => {
    const fake = new FakeWorker();
    const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
    t.after(async () => { await fake.terminate(); await owner.close().catch(() => {}); });
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const before = { state: kind === 'get' ? 'owner-rollback-required' : 'ready', attempts: 0 };
    const after = { state: kind === 'get' ? 'ready' : 'owner-rollback-required', attempts: 1 };
    const old = owner.observe(); void old.catch(() => {});
    const command = kind === 'enqueue' ? owner.enqueue(job()) : kind === 'get' ? owner.get(job().id)
      : owner.compareAndSwap(job(), { ...job(), revision: 1, executing: true });
    const handled = command.then(() => {}, () => {});
    const fresh = owner.observe(); void fresh.catch(() => {}); await turn();
    assert.deepEqual(fake.requests.map(r => r.kind), ['observe', kind, 'observe']);
    fake.emit('message', { id: fake.requests[0]!.id, kind: 'observe', ok: true, value: before });
    assert.deepEqual(await old, before);
    // Cleanup of the pre-command flight must not erase its replacement.
    const joined = owner.observe(); await turn(); assert.equal(fake.requests.length, 3);
    fake.emit('message', { id: fake.requests[1]!.id, kind, ok: kind === 'get',
      ...(kind === 'get' ? {} : { conflict: false }) });
    await handled;
    fake.emit('message', { id: fake.requests[2]!.id, kind: 'observe', ok: true, value: after });
    assert.deepEqual(await fresh, after); assert.deepEqual(await joined, after);
    const closing = owner.close(); await turn();
    fake.emit('message', { id: fake.requests[3]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
  });

test('a metadata-refused command does not invalidate the original connection observation', async t => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  t.after(async () => { await fake.terminate(); await owner.close().catch(() => {}); });
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const original = owner.observe(); void original.catch(() => {});
  await assert.rejects(owner.enqueue({ ...job(), id: '' }), MaintenanceJournalUnavailable);
  const joined = owner.observe(); void joined.catch(() => {}); await turn();
  assert.deepEqual(fake.requests.map(r => r.kind), ['observe']);
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'observe', ok: true, value: { state: 'ready', attempts: 0 } });
  assert.deepEqual(await original, { state: 'ready', attempts: 0 }); assert.deepEqual(await joined, await original);
  const closing = owner.close(); await turn();
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('300 concurrent original receipt reads share in-flight SQL and detach every result, then refresh', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const outcomes = Promise.allSettled(Array.from({ length: 300 }, () => owner.get('request:1')));
  await turn();
  assert.equal(fake.requests.length, 1); assert.equal(owner.snapshot().accepted, 1);
  const original = fake.requests[0]!;
  fake.emit('message', { id: original.id, kind: 'get', ok: true,
    value: { ...job(), stage: 'drain', revision: 1, release: { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) } } });
  const results = await outcomes;
  assert.ok(results.every(result => result.status === 'fulfilled'));
  const values = results.map(result => (result as PromiseFulfilledResult<ReturnType<typeof job>>).value);
  values[0]!.actorId = 'caller-change'; assert.equal(values[1]!.actorId, 'actor:1');
  values[0]!.release!.revision = 'c'.repeat(40); assert.equal(values[1]!.release!.revision, 'a'.repeat(40));
  const fresh = owner.get('request:1'); await turn();
  assert.equal(fake.requests.length, 2, 'settled receipts must not become a readiness cache');
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'get', ok: true, value: { ...job(), revision: 1, executing: true } });
  assert.equal((await fresh)!.revision, 1);
  const closing = owner.close(); await turn();
  fake.emit('message', { id: fake.requests[2]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('accepted mutation prevents a later receipt read from joining the earlier SQL snapshot', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const old = owner.get('request:1'), next = { ...job(), revision: 1, executing: true as const };
  const changed = owner.compareAndSwap(job(), next), fresh = owner.get('request:1');
  await turn();
  assert.deepEqual(fake.requests.map(request => request.kind), ['get', 'compareAndSwap', 'get']);
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'get', ok: true, value: job() });
  assert.equal((await old)!.revision, 0);
  const joined = owner.get('request:1'); await turn();
  assert.equal(fake.requests.length, 3, 'old flight cleanup cannot erase a newer flight');
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'compareAndSwap', ok: true, value: true });
  fake.emit('message', { id: fake.requests[2]!.id, kind: 'get', ok: true, value: next });
  assert.equal(await changed, true); assert.deepEqual(await fresh, next); assert.deepEqual(await joined, next);
  const closing = owner.close(); await turn();
  fake.emit('message', { id: fake.requests[3]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('receipt coalescing is published before diagnostic reentrancy and close cannot serve the old flight', async () => {
  const fake = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, diagnostics, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const start = diagnostics.start.bind(diagnostics); let nested: ReturnType<typeof owner.get> | undefined;
  let entered = false;
  diagnostics.start = operation => {
    if (operation === 'maintenance-journal-rpc' && !entered) { entered = true; nested = owner.get('request:1'); }
    return start(operation);
  };
  const pending = owner.get('request:1'); await turn();
  assert.equal(fake.requests.length, 1); assert.equal(owner.snapshot().accepted, 1);
  const closing = owner.close();
  await assert.rejects(owner.get('request:1'), MaintenanceJournalUnavailable);
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'get', ok: true, value: job() });
  assert.deepEqual(await pending, job()); assert.deepEqual(await nested, job()); await turn();
  assert.deepEqual(fake.requests.map(request => request.kind), ['get', 'close']);
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('failed shared receipt read clears the flight without replay and a later read queues fresh SQL', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = owner.get('request:1'), joined = owner.get('request:1');
  const failures = Promise.all([assert.rejects(pending, MaintenanceJournalUnavailable), assert.rejects(joined, MaintenanceJournalUnavailable)]);
  await turn(); assert.equal(fake.requests.length, 1);
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'get', ok: false, conflict: false }); await failures;
  assert.equal(owner.unavailable, false, 'settled SQL rejection is not a transport replacement signal');
  assert.equal(fake.requests.length, 1);
  const fresh = owner.get('request:1'); await turn();
  fake.emit('message', { id: fake.requests[1]!.id, kind: 'get', ok: true });
  assert.equal(await fresh, undefined);
  const again = owner.get('request:1'); await turn();
  assert.equal(fake.requests.length, 3, 'not-found is not cached either');
  fake.emit('message', { id: fake.requests[2]!.id, kind: 'get', ok: true, value: job() }); assert.deepEqual(await again, job());
  const closing = owner.close(); await turn();
  fake.emit('message', { id: fake.requests[3]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

for (const outcome of ['success', 'sql-rejected', 'sql-conflict', 'transport-lost', 'malformed-ack', 'success-then-exit'] as const) test(`RPC diagnostics distinguish acknowledged ${outcome} from unknown transport`, async () => {
  const fake = new FakeWorker(), logs: string[] = [];
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, new PerformanceDiagnostics(line => logs.push(line)),
    () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = owner.get('request:1');
  const success = outcome === 'success' || outcome === 'success-then-exit';
  const unknown = outcome === 'transport-lost' || outcome === 'malformed-ack';
  const checked = success ? pending : assert.rejects(pending, outcome === 'sql-conflict' ? MaintenanceConflict : MaintenanceJournalUnavailable);
  await turn();
  if (outcome === 'transport-lost') fake.emit('exit', 1);
  else fake.emit('message', { id: fake.requests[0]!.id, kind: 'get', ok: success || outcome === 'malformed-ack',
    ...(outcome === 'sql-rejected' || outcome === 'sql-conflict' ? { conflict: outcome === 'sql-conflict' } : {}),
    ...(outcome === 'malformed-ack' ? { extra: 'invalid' } : {}) });
  if (outcome === 'success-then-exit') fake.emit('exit', 1);
  await checked;
  const event = logs.map(line => JSON.parse(line)).find(event => event.operation === 'maintenance-journal-rpc');
  assert.equal(event.step, 1);
  assert.equal(event.settled, unknown ? undefined : 1);
  assert.equal(event.unknown, unknown ? 1 : undefined);
  assert.equal(event.category, success ? 'routine' : 'failed');
  assert.doesNotMatch(logs.join('\n'), /unused|request:1/);
  if (unknown || outcome === 'success-then-exit') await owner.close();
  else {
    const closing = owner.close(); await turn();
    fake.emit('message', { id: fake.requests[1]!.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
  }
});

test('300 concurrent read-only observations share one accepted RPC, then refresh and isolate results', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = Array.from({ length: 300 }, () => owner.observe());
  const outcomes = Promise.allSettled(pending);
  await turn();
  assert.equal(fake.requests.length, 1); assert.equal(owner.snapshot().accepted, 1);
  const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'observe', ok: true, value: { state: 'ready', attempts: 0 } });
  const results = await outcomes;
  assert.ok(results.every(result => result.status === 'fulfilled'));
  const values = results.map(result => (result as PromiseFulfilledResult<{ state: string; attempts: number }>).value);
  values[0]!.attempts = 99; assert.equal(values[1]!.attempts, 0);
  assert.equal(owner.snapshot().accepted, 0);
  const refreshed = owner.observe(); await turn();
  assert.equal(fake.requests.length, 2);
  const fresh = fake.requests[1]!;
  fake.emit('message', { id: fresh.id, kind: 'observe', ok: true, value: { state: 'close-required', attempts: 1 } });
  assert.deepEqual(await refreshed, { state: 'close-required', attempts: 1 });
  const closing = owner.close(); await turn(); const close = fake.requests[2]!;
  fake.emit('message', { id: close.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('shared observation is published before diagnostic reentrancy can admit a duplicate RPC', async () => {
  const fake = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, diagnostics, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const start = diagnostics.start.bind(diagnostics); let nested: ReturnType<typeof owner.observe> | undefined;
  let entered = false;
  diagnostics.start = operation => {
    if (operation === 'maintenance-journal-rpc' && !entered) { entered = true; nested = owner.observe(); }
    return start(operation);
  };
  const original = owner.observe(); await turn();
  assert.equal(fake.requests.length, 1); assert.ok(nested);
  const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'observe', ok: true, value: { state: 'ready', attempts: 0 } });
  assert.deepEqual(await original, await nested);
  const closing = owner.close(); await turn(); const close = fake.requests[1]!;
  fake.emit('message', { id: close.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('shared observation drains its original ACK; closing refuses new observers without cancelling old ones', async () => {
  const fake = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, diagnostics, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const first = owner.observe(), second = owner.observe(); await turn();
  const closing = owner.close();
  await assert.rejects(owner.observe(), MaintenanceJournalUnavailable);
  assert.deepEqual((await owner.recovery()).connection, { state: 'unavailable' });
  assert.equal(fake.requests.length, 1);
  assert.ok(diagnostics.snapshot().events.some(event => event.step === 8 && event.deferred === 1));
  const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'observe', ok: true, value: { state: 'ready', attempts: 0 } });
  assert.deepEqual(await first, await second); await turn();
  const close = fake.requests[1]!;
  fake.emit('message', { id: close.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('diagnostic reentrant close captures the original accepted request before dispatch starts', async () => {
  const fake = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, diagnostics, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const start = diagnostics.start.bind(diagnostics); let closing: Promise<void> | undefined;
  diagnostics.start = operation => {
    if (operation === 'maintenance-journal-rpc' && !closing) closing = owner.close();
    return start(operation);
  };
  const pending = owner.get('request:1'); await turn();
  assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0]!.kind, 'get');
  const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'get', ok: true, value: job() });
  assert.deepEqual(await pending, job()); await turn();
  const close = fake.requests[1]!;
  fake.emit('message', { id: close.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('settled refusal permits a fresh shared observation, not cached readiness or a write replay', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = [owner.recovery(), owner.recovery()]; await turn();
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'observe', ok: false, conflict: false });
  for (const result of await Promise.all(pending)) assert.deepEqual(result.connection, { state: 'unobserved' });
  const refreshed = owner.recovery(); await turn(); const fresh = fake.requests[1]!;
  fake.emit('message', { id: fresh.id, kind: 'observe', ok: true, value: { state: 'ready', attempts: 0 } });
  assert.deepEqual((await refreshed).connection, { state: 'ready', attempts: 0 });
  const closing = owner.close(); await turn(); const close = fake.requests[2]!;
  assert.deepEqual(fake.requests.map(request => request.kind), ['observe', 'observe', 'close']);
  fake.emit('message', { id: close.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('a malformed shared observation fences every waiter without replacement or observation replay', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = Array.from({ length: 300 }, () => owner.recovery()); await turn();
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'observe', ok: true, value: { state: 'ready', attempts: 0, sql: 'private' } });
  for (const result of await Promise.all(pending)) {
    assert.deepEqual(result.connection, { state: 'unavailable' }); assert.equal(result.transport.unavailable, true);
  }
  assert.equal(owner.snapshot().accepted, 0); assert.equal(fake.terminated, 1);
  assert.deepEqual((await owner.recovery()).connection, { state: 'unavailable' });
  await assert.rejects(owner.observe(), MaintenanceJournalUnavailable);
  assert.equal(fake.requests.length, 1); await owner.close();
});

test('original SQL owner recovery observation is read-only and cannot mutate or replay receipts', async t => {
  const f = fixture(t), owner = f.open(); await owner.enqueue(job());
  const reader = new DatabaseSync(f.file, { readOnly: true });
  try {
    const version = reader.prepare('PRAGMA data_version').get();
    const observation = await owner.recovery();
    assert.deepEqual(observation, { scope: 'maintenance-journal', transport: { scope: 'process', pending: 0, accepted: 0,
      unavailable: false, closing: false, ownerExitConfirmed: false }, connection: { state: 'ready', attempts: 0 } });
    assert.deepEqual(reader.prepare('PRAGMA data_version').get(), version);
    assert.deepEqual(await owner.get('request:1'), job());
    await owner.close();
    assert.deepEqual((await owner.recovery()).connection, { state: 'unavailable' });
    assert.equal((await owner.recovery()).transport.ownerExitConfirmed, true);
  } finally { reader.close(); }
});

test('malformed worker recovery observation fences transport; local recovery stays queryable without redispatch', async () => {
  for (const value of [undefined, { state: 'ready' }, { state: 'ready', attempts: -1 }, { state: 'unavailable' },
    { state: 'ready', attempts: 0, sql: 'private' }]) {
    const fake = new FakeWorker();
    const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const pending = owner.recovery(); await turn();
    const request = fake.requests[0]!; assert.equal(request.kind, 'observe'); assert.deepEqual(request.args, []);
    fake.emit('message', { id: request.id, kind: 'observe', ok: true, value });
    const result = await pending;
    assert.deepEqual(result.connection, { state: 'unavailable' }); assert.equal(result.transport.unavailable, true);
    const count = fake.requests.length;
    assert.deepEqual((await owner.recovery()).connection, { state: 'unavailable' });
    assert.equal(fake.requests.length, count); assert.equal(fake.terminated, 1);
    await owner.close();
    assert.deepEqual((await owner.recovery()).connection, { state: 'unavailable' });
  }
});

test('original recovery RPC is numeric logged; settled SQL refusal stays unobserved not ready', async () => {
  const lines: string[] = [], fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, new PerformanceDiagnostics(line => lines.push(line)),
    () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const pending = owner.recovery(); await turn(); const request = fake.requests[0]!;
  fake.emit('message', { id: request.id, kind: 'observe', ok: false, conflict: false });
  const result = await pending;
  assert.deepEqual(result.connection, { state: 'unobserved' }); assert.equal(result.transport.unavailable, false);
  assert.ok(lines.map(line => JSON.parse(line)).some(event => event.operation === 'maintenance-journal-rpc' && event.step === 8 && event.category === 'failed'));
  assert.doesNotMatch(lines.join(''), /unused|private|SELECT/);
  const closing = owner.close(); await turn(); const close = fake.requests[1]!;
  const before = fake.requests.length;
  assert.deepEqual((await owner.recovery()).connection, { state: 'unavailable' }); assert.equal(fake.requests.length, before);
  fake.emit('message', { id: close.id, kind: 'close', ok: true }); fake.emit('exit', 0); await closing;
});

test('close ACK waits for actual clean exit and rejects new work while closing', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await turn();
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'close', ok: true });
  await turn();
  assert.equal(closed, false); assert.equal(fake.terminated, 0);
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  await assert.rejects(owner.get('request:1'), MaintenanceJournalUnavailable);
  fake.emit('exit', 0); await closing;
  assert.equal(owner.snapshot().ownerExitConfirmed, true);
});

for (const fault of ['resolved', 'rejected', 'thrown'] as const) test(`failed termination ${fault} waits for actual exit with immediate sanitized logs`, async () => {
  const fake = new FakeWorker(), logs: string[] = [];
  fake.terminate = () => {
    if (fault === 'thrown') throw Error('private-termination');
    return fault === 'rejected' ? Promise.reject(Error('private-termination')) : Promise.resolve(1);
  };
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, new PerformanceDiagnostics(line => logs.push(line)),
    () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  assert.doesNotThrow(() => fake.emit('error', Error('private-owner')));
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await turn();
  assert.equal(closed, false); assert.equal(owner.snapshot().ownerExitConfirmed, false);
  assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
  assert.doesNotMatch(logs.join('\n'), /private-|unused/);
  fake.emit('exit', 1); await closing;
});

test('close ACK without timely exit logs unknown but never pretends ownership release', async () => {
  const fake = new FakeWorker(), logs: string[] = [];
  fake.terminate = () => Promise.resolve(1);
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, new PerformanceDiagnostics(line => logs.push(line)),
    () => {}, () => fake as unknown as Worker, 50);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  let settled = false;
  const rejection = assert.rejects(owner.close(), MaintenanceJournalUnavailable).then(() => { settled = true; });
  await turn(); fake.emit('message', { id: fake.requests[0]!.id, kind: 'close', ok: true });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(settled, false); assert.equal(owner.snapshot().ownerExitConfirmed, false);
  assert.ok(logs.some(line => JSON.parse(line).timedOut === 1));
  fake.emit('exit', 1); await rejection;
});

test('close ACK followed by nonzero exit cannot report clean close', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const rejection = assert.rejects(owner.close(), MaintenanceJournalUnavailable);
  await turn(); fake.emit('message', { id: fake.requests[0]!.id, kind: 'close', ok: true });
  fake.emit('exit', 1); await rejection;
});

test('close ACK followed by transport error and zero exit cannot mask close failure', async () => {
  const fake = new FakeWorker();
  fake.terminate = () => Promise.resolve(1);
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' }); await owner.open();
  const rejection = assert.rejects(owner.close(), MaintenanceJournalUnavailable);
  await turn(); fake.emit('message', { id: fake.requests[0]!.id, kind: 'close', ok: true });
  fake.emit('error', Error('transport')); fake.emit('exit', 0); await rejection;
});

for (const stage of ['succeeded', 'cancelled', 'attention'] as const) test(`unresolved reply ${stage} preserves unresolved receipt semantics`, async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const result = owner.unresolved('node:1');
  const rejected = stage === 'attention' ? undefined : assert.rejects(result, MaintenanceJournalUnavailable);
  await turn();
  const value = { ...job(), stage, release: { revision: 'b'.repeat(40), manifestSha256: 'a'.repeat(64) },
    ...(stage === 'succeeded' ? { fenceId: 'fence:1', backupId: 'backup:1' } : {}),
    ...(stage === 'attention' ? { reason: 'interrupted' as const } : {}) };
  assert.equal(validMaintenanceJob(value), true, 'fixture must exercise semantic validation, not invalid shape');
  fake.emit('message', { id: fake.requests[0]!.id, kind: 'unresolved', ok: true, value });
  if (rejected) await rejected;
  else { assert.deepEqual(await result, value); fake.emit('exit', 1); }
  await owner.close();
});

test('array shaped RPC replies cannot settle a maintenance request', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const rejected = assert.rejects(owner.get('request:1'), MaintenanceJournalUnavailable);
  await turn();
  fake.emit('message', Object.assign([], { id: fake.requests[0]!.id, kind: 'get', ok: true }));
  await rejected; await owner.close();
});
for (const fault of ['exit', 'malformed', 'timeout'] as const) test(`transport ${fault} fences all writes, logs unknown and never replaces owner`, async () => {
  const fake = new FakeWorker(), logs: string[] = []; let launches = 0, halted = 0;
  const owner = new AsyncMaintenanceJournal({ file: 'not-used', dev: 0, ino: 0 }, new PerformanceDiagnostics(line => logs.push(line)),
    () => halted++, () => { launches++; return fake as unknown as Worker; }, 100);
  fake.emit('message', { kind: 'ready' });
  const pending = owner.enqueue(job());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(fake.requests.length, 1);
  const assertion = assert.rejects(pending, MaintenanceJournalUnavailable);
  if (fault === 'exit') fake.emit('exit', 1);
  if (fault === 'malformed') fake.emit('message', { id: fake.requests[0]!.id, kind: 'enqueue', ok: true, value: 'private-secret-SQL' });
  await assertion;
  await assert.rejects(owner.enqueue(job()), MaintenanceJournalUnavailable);
  assert.equal(launches, 1); assert.equal(halted, 1); assert.equal(fake.requests.length, 1);
  assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
  assert.doesNotMatch(logs.join('\n'), /private-secret|not-used|request:1|actor:1/);
  await owner.close();
});

test('capacity is bounded even while worker ready is pending', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'not-used', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker);
  const pending = Array.from({ length: 256 }, (_, index) => owner.get(`request:${index}`));
  const settled = Promise.allSettled(pending);
  await assert.rejects(owner.get('request:overflow'), MaintenanceJournalUnavailable);
  fake.emit('exit', 1); await settled; await owner.close();
});

for (const fault of ['identity', 'extra-field', 'send', 'startup-timeout'] as const) test(`RPC ${fault} is unavailable without replay`, async () => {
  const fake = new FakeWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, silent, () => {}, () => fake as unknown as Worker, 100);
  if (fault !== 'startup-timeout') fake.emit('message', { kind: 'ready' });
  if (fault === 'send') fake.postMessage = () => { throw Error('transport'); };
  const pending = owner.get('request:1');
  const rejected = assert.rejects(pending, MaintenanceJournalUnavailable);
  await Promise.resolve(); await Promise.resolve();
  if (fault === 'identity' || fault === 'extra-field') fake.emit('message', {
    id: fake.requests[0]!.id, kind: 'get', ok: true,
    value: fault === 'identity' ? { ...job(), id: 'other:request' } : job(),
    ...(fault === 'extra-field' ? { sql: 'forbidden' } : {}),
  });
  await rejected; assert.equal(owner.unavailable, true); await owner.close();
});
