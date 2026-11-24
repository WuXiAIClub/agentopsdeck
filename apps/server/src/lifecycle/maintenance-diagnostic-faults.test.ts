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
import { newMaintenanceJob } from './connector-maintenance.js';
import { MaintenanceConflict } from './maintenance-journal.js';
import { ProcessLifetime } from './process-lifetime.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const faults = ['start', 'clock', 'sink', 'add', 'reportPending', 'finish'] as const;
function faulty(fault: typeof faults[number], reenter: () => void = () => {}) {
  const fail = () => { throw Error('private diagnostic fault'); };
  const diagnostics = new PerformanceDiagnostics(fault === 'sink' ? fail : () => {},
    fault === 'clock' ? fail : () => 1000);
  const start = diagnostics.start.bind(diagnostics);
  diagnostics.start = operation => {
    reenter();
    if (fault === 'start') return fail();
    const trace = start(operation);
    if (fault === 'add' || fault === 'reportPending' || fault === 'finish') trace[fault] = fail;
    return trace;
  };
  return diagnostics;
}
class FakeWorker extends EventEmitter {
  requests: { id: number; kind: string; args: unknown[] }[] = [];
  terminated = 0;
  postMessage(value: typeof this.requests[number]) { this.requests.push(value); }
  async terminate() { this.terminated++; this.emit('exit', 1); return 1; }
}
const job = () => newMaintenanceJob({ id: 'request:1', nodeId: 'node:1', actorId: 'actor:1',
  operation: 'restart', createdAt: 1000, deadline: 60_000 });

for (const fault of faults) {
  test(`shutdown observers cannot skip peers, release held owner or create reentrant flight: ${fault}`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let release!: () => void, calls = 0, exits = 0;
    const observations: Promise<boolean>[] = [];
    const lifetime = new ProcessLifetime({ keepAlive: false, warningMs: 1000,
      diagnostics: faulty(fault, () => { observations.push(lifetime.shutdown()); }),
      onClosed: () => { exits++; observations.push(lifetime.shutdown()); } });
    lifetime.own(() => { calls++; });
    lifetime.own(() => { calls++; return new Promise<void>(resolve => { release = resolve; }); });
    const original = lifetime.shutdown();
    await turn(); t.mock.timers.tick(3000); await turn();
    assert.equal(calls, 2); assert.equal(exits, 0); assert.equal(lifetime.snapshot().active, true);
    assert.ok(observations.length > 0); assert.ok(observations.every(value => value === original));
    release(); assert.equal(await original, true);
    assert.equal(exits, 1); assert.equal(lifetime.snapshot().attempts, 1);
    assert.ok(observations.every(value => value === original));
  });

  test(`explicit cleanup retry preserves successful peers despite diagnostic fault: ${fault}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0, peers = 0, exits = 0;
    const lifetime = new ProcessLifetime({ keepAlive: false, retryMs: 1000,
      diagnostics: faulty(fault), onClosed: () => { exits++; } });
    lifetime.own(() => { peers++; });
    lifetime.own(() => { calls++; if (calls === 1) throw undefined; }, () => true);
    assert.equal(await lifetime.shutdown(), false); assert.equal(calls, 1); assert.equal(peers, 1);
    t.mock.timers.tick(1000); await turn();
    assert.equal(calls, 2); assert.equal(peers, 1); assert.equal(exits, 1);
    assert.equal(lifetime.snapshot().closed, true); assert.equal(lifetime.snapshot().exitCode, 1);
  });

  test(`unknown owner failure and process-completion failure never replay through ${fault}`, async () => {
    let ownerCalls = 0, exits = 0;
    const unknown = new ProcessLifetime({ keepAlive: false, diagnostics: faulty(fault), onClosed: () => assert.fail() });
    unknown.own(() => { ownerCalls++; return Promise.reject(undefined); });
    assert.equal(await unknown.shutdown(), false); assert.equal(await unknown.shutdown(), false);
    assert.equal(ownerCalls, 1); assert.equal(unknown.snapshot().pending, 1);
    const completion = new ProcessLifetime({ keepAlive: false, diagnostics: faulty(fault),
      onClosed: () => { exits++; throw undefined; } });
    assert.equal(await completion.shutdown(), false); assert.equal(await completion.shutdown(), false);
    assert.equal(exits, 1); assert.equal(completion.snapshot().closed, false);
  });

  test(`maintenance RPC retains accepted work through close and requires native exit: ${fault}`, async t => {
    const fake = new FakeWorker();
    const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, faulty(fault), () => {},
      () => fake as unknown as Worker);
    t.after(async () => { await fake.terminate(); await owner.close().catch(() => {}); });
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const input = job(), accepted = owner.enqueue(input);
    input.actorId = 'mutated';
    const closing = owner.close(); let closed = false; void closing.then(() => { closed = true; });
    await assert.rejects(owner.enqueue(job()), MaintenanceJournalUnavailable);
    await assert.rejects(owner.inspectStopped('get', 'request:1'), MaintenanceJournalUnavailable);
    await turn(); assert.equal(fake.requests.length, 1); assert.equal(closed, false);
    assert.equal((fake.requests[0]!.args[0] as ReturnType<typeof job>).actorId, 'actor:1');
    fake.emit('message', { id: fake.requests[0]!.id, kind: 'enqueue', ok: true, value: job() });
    assert.deepEqual(await accepted, job()); await turn(); assert.equal(fake.requests.length, 2);
    fake.emit('message', { id: fake.requests[1]!.id, kind: 'close', ok: true });
    await turn(); assert.equal(closed, false); assert.equal(fake.terminated, 0);
    fake.emit('exit', 0); await closing; assert.equal(closed, true);
  });

  test(`maintenance SQL refusal stays settled and transport loss stays unknown without resend: ${fault}`, async t => {
    const fake = new FakeWorker();
    const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, faulty(fault), () => {},
      () => fake as unknown as Worker);
    t.after(async () => { await fake.terminate(); await owner.close().catch(() => {}); });
    fake.emit('message', { kind: 'ready' }); await owner.open();
    const refused = assert.rejects(owner.enqueue(job()), MaintenanceConflict); await turn();
    fake.emit('message', { id: fake.requests[0]!.id, kind: 'enqueue', ok: false, conflict: true });
    await refused; assert.equal(owner.unavailable, false);
    const unknown = assert.rejects(owner.enqueue(job()), MaintenanceJournalUnavailable); await turn();
    fake.emit('error', Error('lost original transport')); await unknown;
    await assert.rejects(owner.enqueue(job()), MaintenanceJournalUnavailable);
    assert.equal(owner.unavailable, true); assert.equal(fake.requests.length, 2);
    await owner.close().catch(() => {}); assert.equal(fake.requests.length, 2);
  });

  test(`real maintenance owner persists original receipt and advanced intent across reopen: ${fault}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-diagnostic-'));
    const file = join(directory, 'private.sqlite'), db = new DatabaseSync(file);
    db.close(); chmodSync(file, 0o600);
    const { dev, ino } = lstatSync(file), owners: AsyncMaintenanceJournal[] = [];
    const open = () => {
      const owner = new AsyncMaintenanceJournal({ file, dev, ino }, faulty(fault)); owners.push(owner); return owner;
    };
    t.after(async () => {
      try { await Promise.all(owners.map(owner => owner.close())); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    });
    const first = open(); assert.deepEqual(await first.enqueue(job()), job());
    const next = { ...job(), revision: 1, executing: true as const };
    assert.equal(await first.compareAndSwap(job(), next), true);
    assert.deepEqual(await first.enqueue(job()), next);
    await first.close(); const second = open();
    assert.deepEqual(await second.get('request:1'), next);
    assert.deepEqual(await second.unresolved('node:1'), next);
    await assert.rejects(second.enqueue({ ...job(), id: 'request:2' }), MaintenanceConflict);
    assert.deepEqual(await second.get('request:1'), next);
  });
}
