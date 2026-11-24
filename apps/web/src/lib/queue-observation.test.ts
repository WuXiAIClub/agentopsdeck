import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { observeQueuedMessage, queueObservationDelay } from './queue-observation.js';
const message: ChatMessage = { id: 'a', sessionKey: 's', role: 'user', text: 'original', createdAt: 1, status: 'queued', queueVersion: '1:1', localAdmission: true };
test('only live queue membership needs fast polling; missing/unknown/blocked rows calibrate without assuming success', () => {
  assert.equal(queueObservationDelay([message], [], true), 60_000);
  assert.equal(queueObservationDelay([message], [], false), 3_000);
  for (const state of ['queued', 'dispatching', 'outcome_unknown', 'blocked'] as const) {
    assert.equal(queueObservationDelay([message], [{ id: 'a', state, createdAt: 1, version: '1:1' }], true),
      state === 'queued' || state === 'dispatching' ? 3_000 : 60_000);
  }
  assert.equal(queueObservationDelay([message], [{ id: 'another', state: 'queued', createdAt: 1, version: '1:1' }], true), 60_000);
});
test('queue observation is independent of history, preserves text/version pairing and never infers execution from absence', () => {
  const dispatching = observeQueuedMessage(message, [{ id: 'a', createdAt: 1, state: 'dispatching', version: '1:2' }], true);
  assert.equal(dispatching.queueObservation, 'dispatching');
  assert.equal(dispatching.queueVersion, undefined);
  assert.equal(dispatching.status, 'queued');
  const edited = observeQueuedMessage(message, [{ id: 'a', createdAt: 1, state: 'queued', version: '1:2' }], true);
  assert.equal(edited.text, 'original');
  assert.equal(edited.queueVersion, undefined);
  assert.equal(observeQueuedMessage(message, [], true).queueObservation, 'absent');
  assert.equal(observeQueuedMessage(message, [], true).status, 'queued');
  assert.equal(observeQueuedMessage(message, [], false), message, 'partial page cannot prove absence');
  const foreign = { ...message, localAdmission: false };
  assert.equal(observeQueuedMessage(foreign, [], true), foreign, 'actor-filtered absence cannot hide someone else’s queue');
});
