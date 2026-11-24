import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { applyMessageAdmission, createAdmissionHistoryTracker, refreshAfterAdmission } from './message-admission.js';
import { hasQueuedMessageControls, showsQueuedMessage } from './live-session.js';

const outgoing: ChatMessage = { id: 'local', sessionKey: 'test', role: 'user', text: 'hi', createdAt: 1, status: 'sending', queueDisposition: 'waiting' };
test('busy admission is immediately visible and actionable without any history or session refresh', () => {
  const message = applyMessageAdmission(outgoing, { idempotencyKey: 'native', status: 'queued',
    admission: { createdAt: 2, queueVersion: '1:1', disposition: 'waiting' } });
  assert.equal(message.id, 'native');
  assert.equal(showsQueuedMessage(message, false), true, 'stale session metadata cannot hide an authoritative admission');
  assert.equal(hasQueuedMessageControls(message, false), true);
});
test('idle admission does not flash queue even if metadata already reflects the new run', () => {
  const message = applyMessageAdmission(outgoing, { status: 'queued', admission: { createdAt: 2, queueVersion: '1:1', disposition: 'preparing' } });
  assert.equal(showsQueuedMessage(message, true), false);
});
test('legacy busy ACK displays waiting but never fabricates mutation version', () => {
  const message = applyMessageAdmission(outgoing, { status: 'queued' });
  assert.equal(showsQueuedMessage(message, true), true);
  assert.equal(hasQueuedMessageControls(message, true), false);
});
test('history failure is separate from successful submission and never requests resubmission', async () => {
  let failed = false;
  const message = applyMessageAdmission(outgoing, { status: 'queued' });
  assert.equal(refreshAfterAdmission(async () => { throw new Error('503'); }, () => { failed = true; }), undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(failed, true);
  assert.equal(message.status, 'queued');
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ack = { idempotencyKey: 'native', status: 'queued' as const,
  admission: { createdAt: 2, queueVersion: '1:1', disposition: 'waiting' as const } };
const confirmed: ChatMessage = { ...outgoing, id: 'native', status: 'queued', queueVersion: '1:1' };
const failRead = async () => { throw new Error('history unavailable'); };

test('delayed read notice clears on the authoritative queued message, without waiting for execution', async () => {
  let updates = 0, reads = 0;
  const tracker = createAdmissionHistoryTracker('test', () => updates++);
  tracker.accepted(outgoing, ack, async () => { reads++; await failRead(); });
  await tick();
  assert.equal(tracker.delayed, true);
  tracker.observe([confirmed]);
  assert.equal(tracker.delayed, false);
  assert.equal(updates, 2);
  assert.equal(reads, 1, 'no automatic send or read retries');
});

test('history arriving before an old failed refresh prevents a sticky notice', async () => {
  let reject!: (error: Error) => void;
  const read = new Promise<void>((_, fail) => { reject = fail; });
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, ack, () => read);
  tracker.observe([confirmed]);
  reject(new Error('late 503'));
  await tick();
  assert.equal(tracker.delayed, false);
});

test('history may arrive even before the send ACK', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.observe([confirmed]);
  tracker.accepted(outgoing, ack, failRead);
  await tick();
  assert.equal(tracker.delayed, false);
});

test('unrelated history, optimistic echoes, failed rows and unversioned queue snapshots cannot clear the notice', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, ack, failRead);
  await tick();
  for (const message of [
    { ...confirmed, id: 'other' }, { ...confirmed, sessionKey: 'other' },
    { ...confirmed, localAdmission: true }, { ...confirmed, status: 'failed' as const },
    { ...confirmed, role: 'assistant' as const }, { ...confirmed, queueVersion: undefined },
  ]) { tracker.observe([message]); assert.equal(tracker.delayed, true); }
  tracker.observe([{ ...confirmed, status: 'sent' }]);
  assert.equal(tracker.delayed, false);
});

test('authoritative sent ACKs require exact identity even for same-text messages', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, { ...ack, status: 'ok' }, failRead);
  await tick();
  tracker.observe([{ ...confirmed, id: 'different', status: 'sent' }]);
  assert.equal(tracker.delayed, true);
});

test('concurrent admissions settle independently; a new success cannot hide an earlier delay', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, ack, failRead);
  tracker.accepted({ ...outgoing, id: 'local2' }, { ...ack, idempotencyKey: 'native2' }, failRead);
  await tick();
  tracker.observe([confirmed]);
  assert.equal(tracker.delayed, true);
  tracker.observe([{ ...confirmed, id: 'native2' }]);
  assert.equal(tracker.delayed, false);
});

test('dispose/session departure prevents old callbacks and late ACKs changing a new panel', async () => {
  let updates = 0, reads = 0;
  const tracker = createAdmissionHistoryTracker('test', () => updates++);
  tracker.accepted(outgoing, ack, failRead);
  tracker.dispose();
  tracker.accepted(outgoing, ack, async () => { reads++; });
  await tick();
  assert.equal(tracker.delayed, false);
  assert.equal(updates, 0);
  assert.equal(reads, 0);
});

test('unknown delivery is never described as accepted', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, { status: 'outcome_unknown' }, failRead);
  await tick();
  assert.equal(tracker.delayed, false);
});

test('legacy sent ACK without canonical identity retains the existing echo matcher', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, { status: 'ok' }, failRead);
  await tick();
  assert.equal(tracker.delayed, true);
  tracker.observe([{ ...confirmed, status: 'sent' }]);
  assert.equal(tracker.delayed, false);
});

test('a successful read alone does not clear a different unresolved admission', async () => {
  const tracker = createAdmissionHistoryTracker('test', () => {});
  tracker.accepted(outgoing, ack, failRead);
  await tick();
  tracker.accepted(outgoing, { ...ack, idempotencyKey: 'another' }, async () => {});
  await tick();
  assert.equal(tracker.delayed, true);
});
