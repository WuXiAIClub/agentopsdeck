import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionListPrimaryStatusLabel } from './session-list-status.js';

test('session list primary label prefers Done for unseen completions over idle', () => {
  assert.equal(sessionListPrimaryStatusLabel({ status: 'idle', completionUnseen: true }), 'Done · unread');
});

test('mobile/compact session list label uses Done unread for unseen completions', () => {
  assert.equal(sessionListPrimaryStatusLabel({ status: 'idle', completionUnseen: true, compact: true }), 'Done · unread');
});

test('running label remains stronger when there is no unseen completion', () => {
  assert.equal(sessionListPrimaryStatusLabel({ status: 'running', runningLabel: 'running 3m' }), 'running 3m');
});

test('read completion remains Done and unsuccessful outcomes are not labeled Done', () => {
  assert.equal(sessionListPrimaryStatusLabel({ status: 'idle', outcome: 'completed' }), 'Done');
  assert.equal(sessionListPrimaryStatusLabel({ status: 'failed', outcome: 'failed', completionUnseen: true }), 'Failed');
  assert.equal(sessionListPrimaryStatusLabel({ status: 'idle', outcome: 'interrupted', completionUnseen: true }), 'Interrupted');
  assert.equal(sessionListPrimaryStatusLabel({ status: 'idle' }), 'idle');
});

test('running is a display label only, not a protocol state migration', () => {
  assert.equal(sessionListPrimaryStatusLabel({ status: 'running' }), 'run');
});
