import assert from 'node:assert/strict';
import test from 'node:test';
import { shareSessionSummaries } from './session-summary-sharing.js';
import type { SessionListSnapshot } from './session-snapshot.js';

function fixture(): SessionListSnapshot {
  return { updatedAt: 1, revision: '1', viewKey: 'account/default', groups: [{ agentId: 'codex', sessions: ['a', 'b'].map(id => ({
    sessionKey: `${id}:one`, title: id, status: 'idle', source: 'codex', controlCapabilities: { compact: true, attachments: true },
  })) }], sourceStates: ['a', 'b'].map(connectionId => ({ connectionId, authority: 1, state: 'ready',
    cursor: 'ce1_00000000-0000-4000-8000-000000000001:1', hiddenCount: 0, archivedCount: 0, pinnedCount: 0 })) };
}
const row = (value: SessionListSnapshot, index = 0) => value.groups[0]!.sessions[index]!;

test('no-op fresh snapshot shares groups but always delivers current envelope', () => {
  const before = fixture(), next = structuredClone(before);
  next.updatedAt++; next.revision = '2'; next.hiddenCount = 3;
  next.sourceStates![0]!.cursor = 'ce1_00000000-0000-4000-8000-000000000001:2';
  const result = shareSessionSummaries(before, next);
  assert.equal(result.groups, before.groups);
  assert.equal(result.sourceStates, next.sourceStates);
  assert.equal(result.updatedAt, 2); assert.equal(result.hiddenCount, 3); assert.equal(result.revision, '2');
  assert.notEqual(next.groups, before.groups, 'inputs are not mutated');
});

test('one changed row preserves unrelated row identity', () => {
  const before = fixture(), next = structuredClone(before); row(next).title = 'new';
  const result = shareSessionSummaries(before, next);
  assert.equal(row(result), row(next)); assert.equal(row(result, 1), row(before, 1));
});

test('goal status, budget, counters and removal update only the affected session', () => {
  let previous = fixture();
  const goal = { status: 'active' as const, objective: 'Scoped task', objectiveTruncated: false,
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  const observations = [goal, { ...goal, tokenBudget: 0 }, { ...goal, tokensUsed: 5 },
    { ...goal, status: 'paused' as const }, null, undefined];
  for (const observation of observations) {
    const next = structuredClone(previous);
    if (observation === undefined) delete row(next).codexGoal;
    else row(next).codexGoal = observation;
    const shared = shareSessionSummaries(previous, next);
    assert.equal(row(shared), row(next));
    assert.equal(row(shared, 1), row(previous, 1));
    assert.deepEqual(row(shared).codexGoal, observation);
    previous = shared;
  }
});

test('capability removal, null, absent and newly introduced fields are never ignored', () => {
  const before = fixture();
  const changes = [
    (value: SessionListSnapshot) => { delete row(value).controlCapabilities; },
    (value: SessionListSnapshot) => { row(value).controlCapabilities!.attachments = false; },
    (value: SessionListSnapshot) => { row(value).contextUsedTokens = null; },
    (value: SessionListSnapshot) => { Object.assign(row(value), { futurePermission: { allowed: false } }); },
    (value: SessionListSnapshot) => { Object.assign(row(value), { optional: undefined }); },
    (value: SessionListSnapshot) => { Object.assign(row(value), { runtime: { phase: 'running', stopRequested: true, turnId: 'turn-2' } }); },
  ];
  for (const change of changes) {
    const next = structuredClone(before); change(next);
    assert.equal(row(shareSessionSummaries(before, next)), row(next));
  }
});

test('nested arrays and field removal compare completely, object key order does not matter', () => {
  const before = fixture(); Object.assign(row(before), { future: { nested: [1, { x: true }], other: null } });
  const next = structuredClone(before); Object.assign(row(next), { future: { other: null, nested: [1, { x: true }] } });
  assert.equal(row(shareSessionSummaries(before, next)), row(before));
  Object.assign(row(next), { future: { nested: [{ x: true }, 1] } });
  assert.equal(row(shareSessionSummaries(before, next)), row(next));
});

test('reorder follows incoming order; removal and reappearance cannot recover discarded rows', () => {
  const before = fixture(), next = structuredClone(before); next.groups[0]!.sessions.reverse();
  const result = shareSessionSummaries(before, next);
  assert.equal(row(result), row(before, 1)); assert.equal(row(result, 1), row(before));
  next.groups[0]!.sessions.pop();
  const removed = shareSessionSummaries(result, next);
  const restored = shareSessionSummaries(removed, fixture());
  assert.notEqual(row(restored), row(before));
});

test('group metadata changes are propagated without invalidating unchanged rows', () => {
  const before = fixture(), next = structuredClone(before); next.groups[0]!.agentId = 'other';
  const result = shareSessionSummaries(before, next);
  assert.equal(result.groups[0]!.agentId, 'other'); assert.equal(row(result), row(before));
});

test('duplicate keys in either snapshot are never shared', () => {
  for (const duplicatePrevious of [true, false]) {
    const before = fixture(), next = structuredClone(before);
    const target = duplicatePrevious ? before : next;
    target.groups.push({ agentId: 'duplicate', sessions: [structuredClone(row(target))] });
    assert.equal(row(shareSessionSummaries(before, next)), row(next));
  }
});

test('view or directory proof transitions do not reuse previous groups', () => {
  const before = fixture();
  for (const change of [
    (next: SessionListSnapshot) => { next.viewKey = 'other-view'; },
    (next: SessionListSnapshot) => { delete next.sourceStates; },
  ]) {
    const next = structuredClone(before); change(next);
    assert.equal(shareSessionSummaries(before, next), next);
  }
});

test('authority, epoch, denial and source removal invalidate only the affected source', () => {
  for (const change of [
    (next: SessionListSnapshot) => { next.sourceStates![0]!.authority++; },
    (next: SessionListSnapshot) => { next.sourceStates![0]!.cursor = 'ce1_00000000-0000-4000-8000-000000000002:1'; },
    (next: SessionListSnapshot) => { next.sourceStates![0]!.cursor = 'unknown'; },
    (next: SessionListSnapshot) => { next.sourceStates![0]!.state = 'denied'; },
    (next: SessionListSnapshot) => { next.sourceStates![0]!.state = 'unavailable'; },
    (next: SessionListSnapshot) => { next.sourceStates!.shift(); },
  ]) {
    const before = fixture(), next = structuredClone(before); change(next);
    const result = shareSessionSummaries(before, next);
    assert.equal(row(result), row(next)); assert.equal(row(result, 1), row(before, 1));
    assert.equal(result.sourceStates, next.sourceStates);
  }
});

test('legacy snapshots share equal rows without retaining removed fields', () => {
  const before = fixture(); delete before.sourceStates; delete before.viewKey;
  const next = structuredClone(before);
  assert.equal(shareSessionSummaries(before, next).groups, before.groups);
  delete row(next).controlCapabilities;
  assert.equal(row(shareSessionSummaries(before, next)), row(next));
});
