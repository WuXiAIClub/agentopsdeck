import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncMaintenanceJournal, MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import { snapshotMaintenanceJournalRequest, maintenanceJournalPendingBytes } from './maintenance-journal-protocol.js';
import { newMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { MaintenanceConflict } from './maintenance-journal.js';
import type { UnstartedPreparationProof } from './maintenance-reconciliation.js';

class FakeWorker extends EventEmitter {
  requests: { id: number; kind: string; args: unknown[] }[] = [];
  postMessage(value: { id: number; kind: string; args: unknown[] }) { this.requests.push(value); }
  async terminate() { this.emit('exit', 1); return 1; }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const input = () => newMaintenanceJob({ id: 'request:1', nodeId: 'node:1', actorId: 'actor:1',
  operation: 'restart', createdAt: 1000, deadline: 60_000 });
function fixture() {
  const fake = new FakeWorker(), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, diagnostics,
    () => {}, () => fake as unknown as Worker);
  return { fake, owner, diagnostics, lines };
}
function largeJob(id: string): MaintenanceJob {
  return { ...input(), id, operation: 'recover', stage: 'recheck', revision: 3,
    fenceId: 'fence:1', release: { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) },
    recoveryRuns: Array.from({ length: 64 }, (_, i) => ({ sessionKey: 'codex:' + i + ':' + 's'.repeat(245),
      commandId: 'command:1', connectionId: 'connection:1', runId: 'run:1', revision: 1 })) };
}

const reconciliationKinds = ['cancelUnstartedPreparation', 'cancelSupersededObservation', 'completeRecoveredReadiness'] as const;
for (const kind of reconciliationKinds) for (const state of ['full', 'stopped'] as const)
test(`${kind}: ${state} owner refuses before inspecting reconciliation DTO getters`, async () => {
  const { fake, owner } = fixture();
  const requests = state === 'full' ? Array.from({ length: 256 }, () => owner.enqueue(input())) : [];
  const settled = Promise.allSettled(requests);
  if (state === 'stopped') fake.emit('exit', 1);
  let reads = 0;
  const poison = Object.defineProperty({}, 'nodeId', { enumerable: true, get() { reads++; throw Error('private getter'); } });
  const invoke = owner[kind] as (job: MaintenanceJob, proof: unknown, at: number) => Promise<unknown>;
  try {
    await assert.rejects(invoke.call(owner, poison as MaintenanceJob, poison, 100_000), MaintenanceJournalUnavailable);
    assert.equal(reads, 0); assert.equal(fake.requests.length, 0);
  } finally { fake.emit('exit', 1); await settled; await owner.close(); }
});

function preparation() {
  const at = 100_000;
  const job: MaintenanceJob = { ...newMaintenanceJob({ id: 'job:1', nodeId: 'node:1', actorId: 'actor:1',
    operation: 'upgrade', createdAt: at - 10_000, deadline: at + 60_000 }),
    revision: 2, stage: 'attention', reason: 'operation_failed', failedStage: 'prepare' };
  const proof: UnstartedPreparationProof = { nodeId: job.nodeId, observedAt: at, workerStopped: true,
    serviceRunning: true, serviceStartedAt: job.createdAt - 1000, serviceInvocationId: 'c'.repeat(32),
    originalRelease: { revision: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) }, originalReleaseVerified: true,
    preparationDirectoryAbsent: true, admissionReleased: true, failedInvocationFenceAbsent: true };
  return { at, job, proof };
}

test('reconciliation snapshots getters once, budgets extras and only forwards canonical validated evidence', async () => {
  const { fake, owner } = fixture(), { at, job, proof } = preparation(); let reads = 0;
  Object.defineProperty(proof, 'observedAt', { enumerable: true, get() { reads++; return at; } });
  const extra = Object.assign(proof, { privatePayload: 'secret-not-persisted' });
  const bytes = snapshotMaintenanceJournalRequest('cancelUnstartedPreparation', [job, { ...extra }, at]).bytes;
  reads = 0;
  const request = owner.cancelUnstartedPreparation(job, extra, at), settled = Promise.allSettled([request]);
  try {
    assert.equal(reads, 1); assert.equal(owner.metadataUsage.bytes, bytes);
    extra.privatePayload = 'caller-changed'; fake.emit('message', { kind: 'ready' }); await turn();
    assert.doesNotMatch(JSON.stringify(fake.requests), /privatePayload|secret-not-persisted|caller-changed/);
    fake.emit('message', { id: 1, kind: 'cancelUnstartedPreparation', ok: true }); await request;
    assert.equal(owner.metadataUsage.bytes, 0);
  } finally { fake.emit('exit', 1); await settled; await owner.close(); }
});

test('bounded semantic proof rejection remains a conflict and never converts a false claim to authority', async () => {
  const { fake, owner, diagnostics } = fixture(), { at, job, proof } = preparation();
  try {
    await assert.rejects(owner.cancelUnstartedPreparation(job, { ...proof, workerStopped: false } as unknown as UnstartedPreparationProof, at), MaintenanceConflict);
    assert.equal(owner.snapshot().accepted, 0); assert.equal(owner.metadataUsage.bytes, 0);
    assert.equal(fake.requests.length, 0); assert.equal(owner.unavailable, false);
    assert.equal(diagnostics.snapshot().events.at(-1)!.deferred, 1);
  } finally { fake.emit('exit', 1); await owner.close(); }
});

for (const fault of ['large-text', 'large-array', 'large-record', 'symbol', 'cycle', 'proxy', 'class', 'unsafe-number', 'unknown-field'] as const)
test(`bounded metadata refuses ${fault} before admission without poisoning the writer`, async () => {
  const { fake, owner, diagnostics, lines } = fixture();
  const value: Record<string | symbol, unknown> = input();
  if (fault === 'large-text') value.padding = 'secret'.repeat(400_000);
  if (fault === 'large-array') value.padding = new Array(1_000_000);
  if (fault === 'large-record') value.padding = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), i]));
  if (fault === 'symbol') value[Symbol('secret')] = true;
  if (fault === 'cycle') value.padding = value;
  if (fault === 'proxy') value.padding = new Proxy({}, {});
  if (fault === 'class') value.padding = new Date();
  if (fault === 'unsafe-number') value.revision = Number.MAX_SAFE_INTEGER + 1;
  if (fault === 'unknown-field') value.padding = 1;
  try {
    await assert.rejects(owner.enqueue(value as MaintenanceJob), MaintenanceJournalUnavailable);
    assert.equal(owner.snapshot().accepted, 0); assert.equal(owner.metadataUsage.bytes, 0);
    assert.equal(fake.requests.length, 0); assert.equal(owner.unavailable, false);
    const event = diagnostics.snapshot().events.at(-1)!;
    assert.equal(event.deferred, 1); assert.equal(event.sourceBytes, 0); assert.equal(event.unknown, undefined);
    assert.doesNotMatch(JSON.stringify({ lines, event }), /secret|padding|request:1|actor:1/);
    fake.emit('message', { kind: 'ready' }); const read = owner.get('request:1'); await turn();
    assert.equal(fake.requests[0]!.id, 1); fake.emit('message', { id: 1, kind: 'get', ok: true }); await read;
  } finally { fake.emit('exit', 1); await owner.close(); }
});

test('valid large CAS commands exhaust the byte budget before the count budget and release only on original settlement', async () => {
  const { fake, owner, diagnostics } = fixture();
  const previous = largeJob('request:large'), next = { ...previous, revision: 4 };
  const bytes = snapshotMaintenanceJournalRequest('compareAndSwap', [previous, next]).bytes;
  const count = Math.floor(maintenanceJournalPendingBytes / bytes);
  assert.ok(count > 1 && count < 256);
  const requests = Array.from({ length: count }, () => owner.compareAndSwap(previous, next));
  const settlements = Promise.allSettled(requests);
  try {
    assert.equal(owner.snapshot().accepted, count); assert.equal(owner.metadataUsage.bytes, count * bytes);
    await assert.rejects(owner.compareAndSwap(previous, next), MaintenanceJournalUnavailable);
    assert.equal(owner.metadataUsage.bytes, count * bytes); assert.equal(owner.unavailable, false);
    assert.equal(diagnostics.snapshot().events.at(-1)!.sourceBytes, count * bytes);
    fake.emit('message', { kind: 'ready' }); await turn();
    assert.equal(fake.requests.length, count);
    assert.equal(owner.metadataUsage.bytes, count * bytes, 'dispatch itself cannot release admitted metadata');
    fake.emit('message', { id: 1, kind: 'compareAndSwap', ok: true, value: true }); await requests[0];
    assert.equal(owner.metadataUsage.bytes, (count - 1) * bytes);
    const replacement = owner.compareAndSwap(previous, next); const replacementSettlement = Promise.allSettled([replacement]);
    await turn(); assert.equal(owner.metadataUsage.bytes, count * bytes);
    fake.emit('exit', 1); await settlements; await replacementSettlement;
    assert.equal(owner.metadataUsage.bytes, 0);
  } finally { fake.emit('exit', 1); await settlements; await owner.close(); }
});

test('bounded snapshot reads getters once and isolates caller mutation while waiting for readiness', async () => {
  const { fake, owner } = fixture(); const value = input(); let reads = 0;
  Object.defineProperty(value, 'actorId', { enumerable: true, get() { reads++; return 'actor:1'; } });
  const request = owner.enqueue(value); const settled = Promise.allSettled([request]);
  value.id = 'changed:later';
  try {
    assert.equal(reads, 1); fake.emit('message', { kind: 'ready' }); await turn();
    assert.equal((fake.requests[0]!.args[0] as MaintenanceJob).id, 'request:1');
    fake.emit('message', { id: 1, kind: 'enqueue', ok: true, value: input() }); await request;
    assert.equal(owner.metadataUsage.bytes, 0);
  } finally { fake.emit('exit', 1); await settled; await owner.close(); }
});

test('byte budget is rechecked after a getter admits the remaining large command', async () => {
  const { fake, owner } = fixture();
  const previous = largeJob('request:large'), next = { ...previous, revision: 4 };
  const bytes = snapshotMaintenanceJournalRequest('compareAndSwap', [previous, next]).bytes;
  const count = Math.floor(maintenanceJournalPendingBytes / bytes);
  const requests = Array.from({ length: count - 1 }, () => owner.compareAndSwap(previous, next));
  const settled = Promise.allSettled(requests);
  let extra: Promise<boolean> | undefined;
  // The outer large command would fit before its caller getter reenters.
  Object.defineProperty(previous, 'actorId', { enumerable: true, get() {
    extra = owner.compareAndSwap(largeJob('request:other'), { ...next, id: 'request:other' });
    return 'actor:1';
  } });
  try {
    await assert.rejects(owner.compareAndSwap(previous, next), MaintenanceJournalUnavailable);
    assert.equal(owner.snapshot().accepted, count);
    assert.ok(owner.metadataUsage.bytes <= maintenanceJournalPendingBytes);
    assert.equal(fake.requests.length, 0); assert.equal(owner.unavailable, false);
  } finally {
    const extraSettled = Promise.allSettled([extra]); fake.emit('exit', 1);
    await settled; await extraSettled; await owner.close();
    assert.equal(owner.metadataUsage.bytes, 0);
  }
});

test('writer failure frees settled metadata but never reopens admission or dispatches a replacement', async () => {
  const { fake, owner } = fixture(); const previous = largeJob('request:large');
  fake.terminate = async () => 1; // A terminate request is not actual exit evidence.
  const request = owner.compareAndSwap(previous, { ...previous, revision: 4 });
  const settled = Promise.allSettled([request]);
  assert.ok(owner.metadataUsage.bytes > 0);
  fake.emit('message', { kind: 'ready' }); await turn();
  assert.equal(fake.requests.length, 1);
  fake.emit('error', Error('private transport detail')); await settled;
  assert.equal(owner.metadataUsage.bytes, 0); assert.equal(owner.unavailable, true);
  await assert.rejects(owner.compareAndSwap(previous, { ...previous, revision: 4 }), MaintenanceJournalUnavailable);
  assert.equal(fake.requests.length, 1);
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  fake.emit('exit', 1); await owner.close();
});
