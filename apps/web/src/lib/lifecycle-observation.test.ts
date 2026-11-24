import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorLifecycleJob, ConnectorLifecycleReceipt } from '@agentopsdeck/shared';
import { CommandJournal, recoverSavedCommand, lifecyclePath } from './command-recovery.js';
import { lifecyclePollDelay, mergeLifecycleObservation, readLifecycleReceipt, readLifecycleStatus } from './lifecycle-observation.js';

const target = { connectionId: 'remote-a', operation: 'restart' as const };
const owner = 'a'.repeat(64);
const job: ConnectorLifecycleJob = { id: 'job-1', nodeId: 'node-1', operation: 'restart', stage: 'prepare', createdAt: 1, deadline: 100, revision: 0 };
const receipt = (stage: ConnectorLifecycleJob['stage'] = 'drain', revision = 1): ConnectorLifecycleReceipt => ({
  command: { id: 'receipt-1', key: 'original', state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 202, body: { lifecycle: job } } },
  job: { ...job, stage, revision }, observationUnavailable: false,
});
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

test('lifecycle status validates optional capabilities and never enables automatic updates', () => {
  const valid = { configured: true, nodeId: 'node-1', operations: ['restart', 'upgrade'], blocked: true, automaticUpdates: false, workerState: 'running', job };
  assert.deepEqual(readLifecycleStatus(valid), valid);
  assert.deepEqual(readLifecycleStatus({ configured: false }), { configured: false });
  for (const bad of [null, [], {}, { ...valid, operations: null }, { ...valid, operations: ['restart', 'restart'] },
    { ...valid, operations: [] }, { ...valid, blocked: false },
    { ...valid, automaticUpdates: true }, { ...valid, workerState: 'ready' }, { ...valid, job: { ...job, nodeId: 'other' } },
    { ...valid, job: { ...job, deadline: 1 } }, { ...valid, job: { ...job, revision: NaN } }]) assert.throws(() => readLifecycleStatus(bad));
});

test('fresh progress is bound to the original admitted job; admission is not current progress', () => {
  const valid = receipt();
  assert.deepEqual(readLifecycleReceipt(valid, 'original', target), valid);
  const unavailable = { command: valid.command, observationUnavailable: true };
  assert.equal(readLifecycleReceipt(unavailable, 'original', target).job, undefined);
  for (const bad of [null, { ...valid, command: undefined }, { ...valid, command: { ...valid.command, key: 'another' } },
    { ...valid, job: { ...job, id: 'another' } }, { ...valid, job: { ...job, operation: 'upgrade' } },
    { ...valid, job: { ...job, stage: 'made-up' } }, { ...valid, job: { ...job, createdAt: 2 } },
    { ...valid, observationUnavailable: true }, { ...valid, job: undefined },
    { ...valid, command: { ...valid.command, result: { status: 200, body: {} } } },
    { ...valid, command: { ...valid.command, updatedAt: -1 } }]) assert.throws(() => readLifecycleReceipt(bad, 'original', target));
});

test('operator cancellation is a distinct observable terminal receipt, not a successful deployment', () => {
  const cancelled = receipt('cancelled', 12);
  assert.deepEqual(readLifecycleReceipt(cancelled, 'original', target), cancelled);
  const result = mergeLifecycleObservation(receipt('drain', 10), cancelled);
  assert.equal(result.job?.stage, 'cancelled'); assert.equal(result.observationUnavailable, false);
  assert.throws(() => mergeLifecycleObservation(result, receipt('drain', 11)));
});

test('lost progress preserves a labelled stale stage and rejects regressions', () => {
  const old = receipt('ready', 10);
  const stale = mergeLifecycleObservation(old, { command: old.command, observationUnavailable: true });
  assert.equal(stale.job?.stage, 'ready'); assert.equal(stale.observationUnavailable, true);
  assert.throws(() => mergeLifecycleObservation(old, receipt('drain', 2)));
  assert.throws(() => mergeLifecycleObservation(old, receipt('succeeded', 10)));
  for (const changed of [{ deadline: 200 }, { createdAt: 2 }, { operation: 'upgrade' as const }, { reason: 'deadline' as const }]) {
    assert.throws(() => mergeLifecycleObservation(old, { ...old, job: { ...old.job!, ...changed } }));
  }
  assert.throws(() => mergeLifecycleObservation(old, { ...old, command: { ...old.command, id: 'different' } }));
  const final = mergeLifecycleObservation(stale, receipt('succeeded', 11));
  assert.equal(final.job?.stage, 'succeeded'); assert.equal(final.observationUnavailable, false);
});

test('lifecycle polling backs off boundedly and resumes normal cadence after success', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 100].map(lifecyclePollDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test('lifecycle journal persists original identity across reload and accepted still blocks new work', async () => {
  const saved = storage(), journal = new CommandJournal(saved);
  const row = journal.beginLifecycle(owner, target, 'original');
  assert.equal(journal.list(owner).length, 0);
  assert.equal(journal.list('other', undefined, 'lifecycle').length, 0);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'key', 'lifecycle', 'scope', 'state']);
  await assert.rejects(recoverSavedCommand(journal, row, async () => assert.fail('must not query session receipt')));
  journal.settle(row, 'accepted');
  const reopened = new CommandJournal(saved);
  assert.equal(reopened.list(owner, undefined, 'lifecycle')[0]?.state, 'accepted');
  assert.throws(() => reopened.beginLifecycle(owner, { ...target, operation: 'upgrade' }, 'second'));
  reopened.forget(row);
  assert.equal(reopened.beginLifecycle(owner, target, 'second').key, 'second');
});

test('invalid lifecycle identities and failed storage cannot admit work', () => {
  const journal = new CommandJournal(storage());
  assert.throws(() => journal.beginLifecycle(owner, { ...target, operation: 'shell' as 'restart' }, 'key'));
  assert.throws(() => lifecyclePath({ ...target, connectionId: '../escape' }));
  const broken = new CommandJournal({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => broken.beginLifecycle(owner, target, 'key'), /quota/);
});
