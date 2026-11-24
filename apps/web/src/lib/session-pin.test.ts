import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { sortPinnedSessions, updatePinnedSessionList } from './session-pin.js';

test('sortPinnedSessions keeps pinned sessions first while preserving activity order inside each group', () => {
  const sessions = [
    { sessionKey: 'new-unpinned', title: 'New unpinned', status: 'idle' as const, lastActiveAt: 400 },
    { sessionKey: 'old-pinned', title: 'Old pinned', status: 'idle' as const, lastActiveAt: 100, pinned: true },
    { sessionKey: 'new-pinned', title: 'New pinned', status: 'idle' as const, lastActiveAt: 300, pinned: true },
    { sessionKey: 'old-unpinned', title: 'Old unpinned', status: 'idle' as const, lastActiveAt: 200 },
  ];

  assert.deepEqual(sortPinnedSessions(sessions).map((session) => session.sessionKey), [
    'new-pinned',
    'old-pinned',
    'new-unpinned',
    'old-unpinned',
  ]);
});

test('updatePinnedSessionList toggles pin state and reports count delta for optimistic UI updates', () => {
  const result = updatePinnedSessionList<SessionSummary>([
    { sessionKey: 'new-unpinned', title: 'New unpinned', status: 'idle' as const, lastActiveAt: 400 },
    { sessionKey: 'old-target', title: 'Old target', status: 'idle' as const, lastActiveAt: 100 },
  ], 'old-target', true);

  assert.equal(result.changed, true);
  assert.equal(result.pinnedDelta, 1);
  assert.deepEqual(result.sessions.map((session) => [session.sessionKey, Boolean(session.pinned)]), [
    ['old-target', true],
    ['new-unpinned', false],
  ]);

  const unchanged = updatePinnedSessionList(result.sessions, 'old-target', true);
  assert.equal(unchanged.pinnedDelta, 0);
});
