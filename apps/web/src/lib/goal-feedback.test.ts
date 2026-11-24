import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGoalNotice, type GoalNotice } from './goal-feedback.js';

test('Goal receipt feedback is order-independent and never hides an unknown behind an ACK', () => {
  const notices: GoalNotice[] = ['idle', 'accepted', 'released', 'not-sent', 'rejected', 'unknown'];
  for (const a of notices) for (const b of notices) for (const c of notices) {
    assert.equal(mergeGoalNotice(a, b), mergeGoalNotice(b, a));
    assert.equal(mergeGoalNotice(mergeGoalNotice(a, b), c), mergeGoalNotice(a, mergeGoalNotice(b, c)));
    assert.equal(mergeGoalNotice(a, 'unknown'), 'unknown');
  }
  assert.equal(mergeGoalNotice('accepted', 'rejected'), 'rejected');
  assert.equal(mergeGoalNotice('released', 'accepted'), 'released');
  assert.equal(mergeGoalNotice('idle', 'accepted'), 'accepted');
});
