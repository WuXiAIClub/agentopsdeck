import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { MaintenanceAdapter, MaintenanceJob } from './connector-maintenance.js';
import { MaintenanceConflict, SqliteMaintenanceJournal } from './maintenance-journal.js';
import { MaintenanceForbidden, MaintenanceInvalidRequest, MaintenanceSupervisor } from './maintenance-supervisor.js';
import { MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const fault of ['start', 'clock', 'sink', 'add', 'reportPending', 'finish'] as const) {
  function faulty(reenter: () => void = () => {}) {
    const fail = () => { throw Error('private diagnostic fault'); };
    const diagnostics = new PerformanceDiagnostics(fault === 'sink' ? fail : () => {}, fault === 'clock' ? fail : () => 1000);
    const start = diagnostics.start.bind(diagnostics);
    diagnostics.start = operation => {
      reenter(); if (fault === 'start') return fail();
      const trace = start(operation);
      if (fault === 'add' || fault === 'reportPending' || fault === 'finish') trace[fault] = fail;
      return trace;
    };
    return diagnostics;
  }
  test(`maintenance diagnostics preserve executing intent and original reentrant step: ${fault}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), observations: Promise<MaintenanceJob | undefined>[] = [];
    const supervisor = new MaintenanceSupervisor(f.journal, f.adapter, f.authority,
      { ...f.options, stallWarningMs: 1000, diagnostics: faulty(() => { observations.push(supervisor.tick()); }) });
    const receipt = await supervisor.submit('actor:1', { commandKey: 'original', operation: 'restart' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const prepare = f.adapter.prepare.bind(f.adapter);
    f.adapter.prepare = async () => { await held; return prepare(); };
    const original = supervisor.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    const executing = f.journal.get(receipt.id)!; assert.equal(executing.executing, true);
    let drained = false; const drain = supervisor.drainWorker().then(() => { drained = true; });
    t.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.deepEqual(f.journal.get(receipt.id), executing);
    assert.equal(supervisor.tick(), original); assert.ok(observations.every(value => value === original));
    release(); const result = await original; await drain;
    assert.equal(result?.stage, 'drain'); assert.equal(result?.executing, undefined);
    assert.deepEqual(f.journal.get(receipt.id), result);
    assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
    assert.ok(observations.every(value => value === original));
  });
  test(`maintenance diagnostic faults preserve original journal error without running effects: ${fault}`, async t => {
    const f = fixture(t), error = Error('original journal failure'); let reads = 0;
    const supervisor = new MaintenanceSupervisor({
      get: f.journal.get.bind(f.journal), enqueue: f.journal.enqueue.bind(f.journal),
      compareAndSwap: f.journal.compareAndSwap.bind(f.journal),
      unresolved: () => { reads++; throw error; },
    }, f.adapter, f.authority, { ...f.options, diagnostics: faulty() });
    const original = supervisor.tick(); assert.equal(supervisor.tick(), original);
    await assert.rejects(original, cause => cause === error);
    assert.equal(reads, 1); assert.deepEqual(f.calls, []);
  });
}

test('revocation after enqueue preserves the original receipt without disclosure or replay', async t => {
  const f = fixture(t);
  const supervisor = new MaintenanceSupervisor({
    get: f.journal.get.bind(f.journal), unresolved: f.journal.unresolved.bind(f.journal),
    compareAndSwap: f.journal.compareAndSwap.bind(f.journal),
    async enqueue(job) { const saved = f.journal.enqueue(job); f.revoke(); return saved; },
  }, f.adapter, f.authority, f.options);
  const request = { commandKey: 'original', operation: 'restart' };
  await assert.rejects(supervisor.submit('actor:1', request), MaintenanceForbidden);
  const original = f.journal.unresolved('node:1')!;
  assert.equal(original.stage, 'prepare'); assert.deepEqual(f.calls, []);
  const authorized = new MaintenanceSupervisor(f.journal, f.adapter, async () => true, f.options);
  assert.deepEqual(await authorized.submit('actor:1', request), original);
});

test('receipt observations survive unavailable writer without allowing submission or effects', async t => {
  const f = fixture(t), key = 'original';
  const saved = await f.supervisor.submit('actor:1', { commandKey: key, operation: 'restart' });
  const denied = () => { throw new MaintenanceJournalUnavailable(); };
  const supervisor = new MaintenanceSupervisor({ get: denied, unresolved: denied, enqueue: denied, compareAndSwap: denied },
    f.adapter, f.authority, { ...f.options, receiptJournal: f.journal });
  assert.deepEqual(await supervisor.command('actor:1', key), saved);
  assert.deepEqual((await supervisor.status('actor:1')).job, saved);
  const other = await supervisor.status('actor:2');
  assert.equal(other.blocked, true); assert.equal(other.job, undefined);
  assert.equal(await supervisor.command('actor:2', key), undefined);
  await assert.rejects(supervisor.submit('actor:1', { commandKey: key, operation: 'restart' }), MaintenanceJournalUnavailable);
  await assert.rejects(supervisor.tick(), MaintenanceJournalUnavailable);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.journal.get(saved.id), saved);
});

for (const query of ['status', 'command'] as const) {
  test(`stopped ${query} observations check authority before and after their async read`, async t => {
    const f = fixture(t), key = 'original';
    await f.supervisor.submit('actor:1', { commandKey: key, operation: 'restart' });
    let reads = 0;
    const supervisor = new MaintenanceSupervisor(f.journal, f.adapter, f.authority, {
      ...f.options, receiptJournal: {
        async get(id) { reads++; const receipt = f.journal.get(id); f.revoke(); return receipt; },
        async unresolved(node) { reads++; const receipt = f.journal.unresolved(node); f.revoke(); return receipt; },
      },
    });
    const read = () => query === 'status' ? supervisor.status('actor:1') : supervisor.command('actor:1', key);
    await assert.rejects(read(), MaintenanceForbidden); assert.equal(reads, 1);
    await assert.rejects(read(), MaintenanceForbidden); assert.equal(reads, 1);
    assert.deepEqual(f.calls, []);
  });
}

test('one stalled-step warning leaves intent fenced, coalesces ticks and waits for the original effect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line), () => 1000);
  const supervisor = new MaintenanceSupervisor(f.journal, f.adapter, f.authority,
    { ...f.options, diagnostics, stallWarningMs: 1000 });
  const original = await supervisor.submit('actor:1', { commandKey: 'original', operation: 'restart' });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const prepare = f.adapter.prepare.bind(f.adapter);
  f.adapter.prepare = async () => { await wait; return prepare(); };
  const step = supervisor.tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  const executing = f.journal.get(original.id);
  assert.equal(executing?.executing, true);
  assert.equal(supervisor.tick(), step);
  let drained = false;
  const drain = supervisor.drainWorker().then(() => { drained = true; });
  t.mock.timers.tick(2000);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).pending, 1);
  assert.equal(JSON.parse(lines[0]!).timedOut, 1);
  assert.deepEqual(f.journal.get(original.id), executing);
  assert.equal(drained, false);
  await assert.rejects(supervisor.submit('actor:1', { commandKey: 'other', operation: 'restart' }), MaintenanceConflict);
  release(); await drain; await step;
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]!).settled, 1);
  t.mock.timers.tick(10_000); assert.equal(lines.length, 2);
});

test('stalled read diagnostics cannot invent receipts; logging failure cannot replace a journal error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), error = new MaintenanceJournalUnavailable();
  let reject!: (error: Error) => void;
  const supervisor = new MaintenanceSupervisor({
    ...f.journal, get: f.journal.get.bind(f.journal), enqueue: f.journal.enqueue.bind(f.journal),
    compareAndSwap: f.journal.compareAndSwap.bind(f.journal),
    unresolved: () => new Promise<undefined>((_, fail) => { reject = fail; }),
  }, f.adapter, f.authority, { ...f.options, stallWarningMs: 1000,
    diagnostics: new PerformanceDiagnostics(() => { throw new Error('sink failed'); }) });
  const step = supervisor.tick();
  const rejected = assert.rejects(step, candidate => candidate === error);
  await Promise.resolve(); t.mock.timers.tick(1000);
  assert.equal(f.journal.unresolved('node:1'), undefined); assert.deepEqual(f.calls, []);
  reject(error); await rejected;
  t.mock.timers.tick(5000);
});

test('idle completion clears its warning and does not report an unknown effect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), lines: string[] = [];
  const supervisor = new MaintenanceSupervisor(f.journal, f.adapter, f.authority,
    { ...f.options, diagnostics: new PerformanceDiagnostics(line => lines.push(line)), stallWarningMs: 1000 });
  assert.equal(await supervisor.tick(), undefined);
  t.mock.timers.tick(5000);
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]!).unknown, undefined);
  assert.equal(JSON.parse(lines[0]!).timedOut, undefined);
});

test('invalid stall thresholds reject before any journal or native effect', async t => {
  const f = fixture(t);
  for (const stallWarningMs of [0, 999, 1000.5, NaN, Infinity, 86_400_001]) {
    assert.throws(() => new MaintenanceSupervisor(f.journal, f.adapter, f.authority,
      { ...f.options, stallWarningMs }), MaintenanceInvalidRequest);
  }
  assert.deepEqual(f.calls, []); assert.equal(f.journal.unresolved('node:1'), undefined);
});

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-supervisor-'));
  const db = new DatabaseSync(join(directory, 'journal.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const journal = new SqliteMaintenanceJournal(db);
  let clock = 1000, authorized = true;
  const calls: string[] = [];
  const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  // Private fields exercise the receiver binding needed by real OS adapters.
  class Adapter implements MaintenanceAdapter {
    #record(name: string) { calls.push(name); }
    async authorize() { this.#record('authorize'); return true; }
    async prepare() { this.#record('prepare'); return release; }
    async inspect(job: MaintenanceJob) { this.#record('inspect'); return { nodeId: job.nodeId, observedAt: clock,
      nativeVerified: true as const, activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0,
      ...(job.fenceId ? { fenceId: job.fenceId } : {}) }; }
    async fence(job: MaintenanceJob) { this.#record('fence'); return { nodeId: job.nodeId, fenceId: 'fence:1' }; }
    async releaseFence(job: MaintenanceJob) { this.#record('releaseFence'); return { nodeId: job.nodeId, fenceId: job.fenceId!, released: true as const }; }
    async stop() { this.#record('stop'); }
    async stopped(job: MaintenanceJob) { this.#record('stopped'); return { nodeId: job.nodeId, serviceStopped: true as const, descendantsStopped: true as const }; }
    async backup(job: MaintenanceJob) { this.#record('backup'); return { nodeId: job.nodeId, backupId: 'backup:1', consistent: true as const, verified: true as const }; }
    async activate() { this.#record('activate'); return release; }
    async start() { this.#record('start'); }
    async ready(job: MaintenanceJob) { this.#record('ready'); return { ...release, nodeId: job.nodeId,
      protocolCompatible: true as const, projectionVerified: true as const, businessReadVerified: true as const }; }
  }
  const adapter = new Adapter();
  const options = { nodeId: 'node:1', operations: ['restart', 'upgrade'] as const, timeoutMs: 30_000, now: () => clock };
  const authority = async () => authorized;
  const create = () => new MaintenanceSupervisor(journal, adapter, authority, options);
  return { db, journal, adapter, calls, options, authority, create, supervisor: create(),
    setClock(value: number) { clock = value; }, revoke() { authorized = false; } };
}

test('admission is durable but effect-free; duplicate delivery keeps original receipt and deadline', async t => {
  const f = fixture(t), request = { commandKey: 'request:1', operation: 'upgrade' };
  const first = await f.supervisor.submit('actor:1', request);
  f.setClock(9000);
  assert.deepEqual(await f.create().submit('actor:1', request), first);
  assert.deepEqual(await f.supervisor.command('actor:1', request.commandKey), first);
  assert.deepEqual((await f.supervisor.status('actor:1')).job, first);
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.supervisor.submit('actor:1', { ...request, operation: 'restart' }), MaintenanceConflict);
});

test('admission snapshots the validated request before asynchronous authorization', async t => {
  const f = fixture(t);
  let release!: (value: boolean) => void;
  let first = true;
  const authority = () => { if (!first) return Promise.resolve(true); first = false; return new Promise<boolean>(resolve => { release = resolve; }); };
  const supervisor = new MaintenanceSupervisor(f.journal, f.adapter, authority, f.options);
  const request = { commandKey: 'original', operation: 'restart' };
  const pending = supervisor.submit('actor:1', request);
  request.commandKey = 'replacement'; request.operation = 'upgrade';
  release(true);
  const job = await pending;
  assert.equal(job.operation, 'restart');
  assert.deepEqual(await f.supervisor.command('actor:1', 'original'), job);
  assert.equal(await f.supervisor.command('actor:1', 'replacement'), undefined);
  assert.deepEqual(f.calls, []);
});

test('receipts are actor-scoped while unresolved jobs block all competing maintenance', async t => {
  const f = fixture(t);
  await f.supervisor.submit('actor:1', { commandKey: 'request:1', operation: 'restart' });
  assert.equal(await f.supervisor.command('actor:2', 'request:1'), undefined);
  const status = await f.supervisor.status('actor:2');
  assert.equal(status.blocked, true);
  assert.equal('job' in status, false);
  assert.equal(status.automaticUpdates, false);
  await assert.rejects(f.supervisor.submit('actor:2', { commandKey: 'request:1', operation: 'restart' }), MaintenanceConflict);
  f.revoke();
  await assert.rejects(f.supervisor.status('actor:1'), MaintenanceForbidden);
  await assert.rejects(f.supervisor.command('actor:1', 'request:1'), MaintenanceForbidden);
  await assert.rejects(f.supervisor.submit('actor:1', { commandKey: 'request:1', operation: 'restart' }), MaintenanceForbidden);
});

test('async journal read revocation prevents admission, disclosure and adapter effects', async t => {
  const f = fixture(t);
  const initial = await f.supervisor.submit('actor:1', { commandKey: 'original', operation: 'restart' });
  const journal = {
    async get(id: string) { const result = f.journal.get(id); f.revoke(); return result; },
    async unresolved(nodeId: string) { const result = f.journal.unresolved(nodeId); f.revoke(); return result; },
    async enqueue() { assert.fail('revoked admission'); },
    compareAndSwap: f.journal.compareAndSwap.bind(f.journal),
  };
  const supervisor = new MaintenanceSupervisor(journal, f.adapter, f.authority, f.options);
  await assert.rejects(supervisor.command('actor:1', 'original'), MaintenanceForbidden);
  assert.deepEqual(f.journal.get(initial.id), initial); assert.deepEqual(f.calls, []);
});

test('revocation while asynchronous lookup waits rejects new admission before enqueue', async t => {
  const f = fixture(t);
  const supervisor = new MaintenanceSupervisor({
    async get() { await Promise.resolve(); f.revoke(); return undefined; },
    unresolved: f.journal.unresolved.bind(f.journal),
    async enqueue() { assert.fail('revoked admission'); },
    compareAndSwap: f.journal.compareAndSwap.bind(f.journal),
  }, f.adapter, f.authority, f.options);
  await assert.rejects(supervisor.submit('actor:1', { commandKey: 'request:1', operation: 'restart' }), MaintenanceForbidden);
  assert.equal(f.journal.unresolved('node:1'), undefined); assert.deepEqual(f.calls, []);
});

test('revocation during asynchronous status read prevents private receipt disclosure', async t => {
  const f = fixture(t);
  await f.supervisor.submit('actor:1', { commandKey: 'original', operation: 'restart' });
  const supervisor = new MaintenanceSupervisor({
    get: f.journal.get.bind(f.journal), enqueue: f.journal.enqueue.bind(f.journal),
    async unresolved(nodeId) { const result = f.journal.unresolved(nodeId); f.revoke(); return result; },
    compareAndSwap: f.journal.compareAndSwap.bind(f.journal),
  }, f.adapter, f.authority, f.options);
  await assert.rejects(supervisor.status('actor:1'), MaintenanceForbidden);
});

for (const fault of ['lost-ack', 'revoked'] as const) test(`durable executing intent ${fault} cannot invoke or replay a native effect`, async t => {
  const f = fixture(t);
  const initial = await f.supervisor.submit('actor:1', { commandKey: 'original', operation: 'restart' });
  let first = true;
  const supervisor = new MaintenanceSupervisor({
    get: f.journal.get.bind(f.journal), enqueue: f.journal.enqueue.bind(f.journal),
    unresolved: f.journal.unresolved.bind(f.journal),
    async compareAndSwap(previous, next) {
      const changed = await f.journal.compareAndSwap(previous, next);
      if (first) {
        first = false;
        if (fault === 'lost-ack') throw new MaintenanceJournalUnavailable();
        f.revoke();
      }
      return changed;
    },
  }, f.adapter, f.authority, f.options);
  if (fault === 'lost-ack') {
    await assert.rejects(supervisor.tick(), MaintenanceJournalUnavailable);
    assert.equal(f.journal.get(initial.id)?.executing, true);
    assert.equal((await f.create().tick())?.executing, true);
  } else assert.equal((await supervisor.tick())?.reason, 'authorization_changed');
  assert.deepEqual(f.calls, []);
});

test('requests cannot supply shell, path, branch or deadline; invalid identities/configuration fail closed', async t => {
  const f = fixture(t), valid = { commandKey: 'request:1', operation: 'restart' };
  for (const request of [null, [], {}, { ...valid, commandKey: '../escape' }, { ...valid, operation: 'delete' },
    ...['command', 'path', 'branch', 'deadline', 'release'].map(key => ({ ...valid, [key]: 'untrusted' }))]) {
    await assert.rejects(f.supervisor.submit('actor:1', request), MaintenanceInvalidRequest);
  }
  await assert.rejects(f.supervisor.submit('../actor', valid), MaintenanceForbidden);
  for (const timeoutMs of [0, 999, NaN, Infinity, 86_400_001]) {
    assert.throws(() => new MaintenanceSupervisor(f.journal, f.adapter, f.authority, { ...f.options, timeoutMs }), MaintenanceInvalidRequest);
  }
  assert.throws(() => new MaintenanceSupervisor(f.journal, f.adapter, f.authority, { ...f.options, operations: [] }), MaintenanceInvalidRequest);
  assert.equal(f.journal.unresolved('node:1'), undefined);
  assert.deepEqual(f.calls, []);
});

test('concurrent ticks coalesce; reconstructed workers never replay persisted unknown effects', async t => {
  const f = fixture(t);
  const job = await f.supervisor.submit('actor:1', { commandKey: 'request:1', operation: 'upgrade' });
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const prepare = f.adapter.prepare.bind(f.adapter);
  f.adapter.prepare = async () => { await wait; return prepare(); };
  const first = f.supervisor.tick();
  assert.equal(f.supervisor.tick(), first);
  // Wait until the durable intent is visible without releasing the effect.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.journal.get(job.id)?.executing, true);
  assert.equal((await f.create().tick())?.executing, true);
  let drained = false;
  const drain = f.supervisor.drainWorker().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish();
  await drain;
  assert.equal((await first)?.stage, 'drain');
  assert.equal(f.calls.filter(name => name === 'prepare').length, 1);
});

test('revocation before worker step persists attention and prevents adapter effects and new jobs', async t => {
  const f = fixture(t);
  await f.supervisor.submit('actor:1', { commandKey: 'request:1', operation: 'upgrade' });
  f.revoke();
  assert.equal((await f.supervisor.tick())?.reason, 'authorization_changed');
  assert.deepEqual(f.calls, []);
  assert.equal(f.journal.unresolved('node:1')?.stage, 'attention');
  assert.equal((await f.create().tick())?.stage, 'attention');
  const replacement = new MaintenanceSupervisor(f.journal, f.adapter, async () => true, f.options);
  assert.equal((await replacement.status('actor:1')).blocked, true);
  await assert.rejects(replacement.submit('actor:1', { commandKey: 'request:2', operation: 'restart' }), MaintenanceConflict);
});

test('deadline expiry and failed durable writes invoke no adapter effects', async t => {
  const f = fixture(t);
  const job = await f.supervisor.submit('actor:1', { commandKey: 'request:1', operation: 'restart' });
  f.db.exec('PRAGMA synchronous = NORMAL');
  await assert.rejects(f.supervisor.tick(), /durable file-backed/);
  assert.deepEqual(f.journal.get(job.id), job);
  assert.deepEqual(f.calls, []);
  f.db.exec('PRAGMA synchronous = FULL');
  f.setClock(job.deadline);
  assert.equal((await f.supervisor.tick())?.reason, 'deadline');
  assert.deepEqual(f.calls, []);
});

for (const operation of ['restart', 'upgrade'] as const) {
  test(`${operation}: private-field adapter completes verified flow; repeated receipt does not restart it`, async t => {
    const f = fixture(t), request = { commandKey: 'request:1', operation };
    await f.supervisor.submit('actor:1', request);
    for (let step = 0; step < 20 && (await f.supervisor.status('actor:1')).blocked; step++) await f.supervisor.tick();
    const receipt = await f.supervisor.command('actor:1', request.commandKey);
    assert.equal(receipt?.stage, 'succeeded');
    assert.deepEqual(f.calls.filter(name => ['stop', 'activate', 'start'].includes(name)),
      ['stop', ...(operation === 'upgrade' ? ['activate'] : []), 'start']);
    f.setClock(10_000);
    assert.deepEqual(await f.create().submit('actor:1', request), receipt);
    assert.equal(await f.supervisor.tick(), undefined);
    assert.equal((await f.supervisor.status('actor:1')).blocked, false);
  });
}
