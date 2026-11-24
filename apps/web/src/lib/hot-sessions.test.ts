import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import {
  clearHotSessionAccess,
  getSessionAccessScore,
  rankHotSessionsForPreload,
  recordSessionAccess,
  scoreHotSession,
  selectUnreadSessionsToPreload,
} from './hot-sessions.js';

function makeSession(overrides: Partial<SessionSummary> & { sessionKey: string }): SessionSummary {
  return {
    title: overrides.sessionKey,
    agentId: 'codex',
    status: 'idle',
    lastActiveAt: 1_000,
    messageCount: 5,
    ...overrides,
  };
}

test('frontend scoreHotSession and rankHotSessionsForPreload prioritize active, accessed, unread, and pinned sessions', () => {
  clearHotSessionAccess();
  const now = 5_000_000;
  recordSessionAccess('codex:recent-click', 3, now - 10_000);

  const sessions: SessionSummary[] = [
    makeSession({ sessionKey: 'codex:active-open', status: 'running', lastActiveAt: now - 1_000 }),
    makeSession({ sessionKey: 'codex:running-bg', status: 'running', hasActiveRun: true, lastActiveAt: now - 20_000 }),
    makeSession({ sessionKey: 'codex:recent-click', lastActiveAt: now - 600_000, messageCount: 25 }),
    makeSession({ sessionKey: 'codex:pinned', pinned: true, lastActiveAt: now - 1_800_000, messageCount: 12 }),
    makeSession({ sessionKey: 'codex:cached-fresh', lastActiveAt: now - 60_000, messageCount: 10 }),
  ];

  assert.ok(getSessionAccessScore('codex:recent-click', now) > 150);
  assert.ok(scoreHotSession(sessions[1]!, { now }) > scoreHotSession(sessions[3]!, { now }));

  const ranked = rankHotSessionsForPreload(sessions, {
    now,
    activeSessionKey: 'codex:active-open',
    isVisible: () => false,
    hasFreshCache: session => session.sessionKey === 'codex:cached-fresh',
    limit: 3,
  });

  assert.deepEqual(
    ranked.map(item => item.sessionKey),
    ['codex:running-bg', 'codex:recent-click', 'codex:pinned'],
  );
  assert.equal(ranked[0]!.priority, 2);
  clearHotSessionAccess();
});

test('selectUnreadSessionsToPreload orders unread sessions by hotness score before slicing to limit', () => {
  const rows = [
    { sessionKey: 'codex:cold-unread', unread: true, throughSequence: 10 },
    { sessionKey: 'codex:hot-unread', unread: true, throughSequence: 20 },
    { sessionKey: 'codex:warm-unread', unread: true, throughSequence: 30 },
  ];
  const scores: Record<string, number> = {
    'codex:cold-unread': 10,
    'codex:hot-unread': 300,
    'codex:warm-unread': 120,
  };
  const selected = selectUnreadSessionsToPreload(
    rows,
    new Map(),
    () => false,
    2,
    key => scores[key] ?? 0,
  );
  assert.deepEqual(selected, [
    { sessionKey: 'codex:hot-unread', throughSequence: 20 },
    { sessionKey: 'codex:warm-unread', throughSequence: 30 },
  ]);
});
