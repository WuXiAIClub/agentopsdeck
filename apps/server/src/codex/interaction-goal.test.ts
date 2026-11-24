import assert from 'node:assert/strict';
import test from 'node:test';
import { interactionGoalEvidence } from './interaction-goal.js';
import { continuationFingerprint } from '../commands/interaction-continuation.js';

const goal = { threadId: 'thread', objective: 'Finish the requested implementation', createdAt: 1, updatedAt: 2,
  status: 'active', tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: 1000 };
const proof = (patch: object = {}) => ({ connectionId: 'native-child', goal: interactionGoalEvidence({ goal: { ...goal, ...patch } }, 'thread') });
test('interaction goal pins objective/creation/budget but not normal progress accounting', () => {
  const initial = continuationFingerprint(proof());
  assert.equal(continuationFingerprint(proof({ status: 'blocked', updatedAt: 9, tokensUsed: 150, timeUsedSeconds: 20 })), initial);
  for (const patch of [{ createdAt: 5, updatedAt: 5 }, { objective: 'Different work' }, { tokenBudget: 2000 }]) assert.notEqual(continuationFingerprint(proof(patch)), initial);
  assert.equal(JSON.stringify(proof()).includes(goal.objective), false, 'durable identity is a hash, not goal text');
});
test('paused, limited, malformed and foreign goals cannot authorize answers', () => {
  for (const patch of [{ status: 'paused' }, { status: 'budgetLimited' }, { status: 'usageLimited' }, { threadId: 'foreign' },
    { objective: null }, { tokenBudget: -1 }, { createdAt: null }]) assert.throws(() => continuationFingerprint(proof(patch)));
  assert.deepEqual(interactionGoalEvidence({ goal: null }, 'thread'), { status: 'absent', version: 'absent' });
});
