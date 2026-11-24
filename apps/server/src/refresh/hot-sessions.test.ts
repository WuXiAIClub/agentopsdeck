import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import {
  createHotSessionWarmer,
  HotSessionTracker,
  rankHotSessions,
  scoreHotSession,
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

test('scoreHotSession and rankHotSessions prioritize running, recently accessed, pinned, and active sessions', () => {
  const now = 10 * 24 * 3600_000;
  const tracker = new HotSessionTracker();
  tracker.recordAccess('codex:frequent', 5, now - 30_000);

  const sessions: SessionSummary[] = [
    makeSession({ sessionKey: 'codex:cold', lastActiveAt: now - 5 * 24 * 3600_000, messageCount: 2 }),
    makeSession({ sessionKey: 'codex:pinned', pinned: true, lastActiveAt: now - 3600_000, messageCount: 30 }),
    makeSession({ sessionKey: 'codex:frequent', lastActiveAt: now - 2 * 3600_000, messageCount: 20 }),
    makeSession({ sessionKey: 'codex:running', status: 'running', hasActiveRun: true, lastActiveAt: now - 10_000, messageCount: 50 }),
    makeSession({ sessionKey: 'codex:hidden', hidden: true, status: 'running', lastActiveAt: now }),
  ];

  assert.equal(scoreHotSession(sessions[4]!, tracker.get('codex:hidden'), now), -1);

  const ranked = rankHotSessions(sessions, tracker, { now, minScore: 10 });
  assert.deepEqual(
    ranked.map(item => item.sessionKey),
    ['codex:running', 'codex:frequent', 'codex:pinned', 'codex:cold'],
  );
  assert.equal(ranked[0]!.foregroundPriority, -2);
  assert.equal(ranked[0]!.backgroundPriority, 4);
  assert.equal(tracker.foregroundPriorityFor(sessions[3]!, 'codex:running', now), -2);
  assert.equal(tracker.foregroundPriorityFor(sessions[0]!, 'codex:cold', now), 0);
});

test('createHotSessionWarmer dynamically warms top unready hot sessions and respects cooldown until new activity', async () => {
  let now = 2_000_000;
  const tracker = new HotSessionTracker();
  const readySet = new Set<string>(['codex:already-ready']);
  const warmedCalls: Array<{ key: string; priority: number }> = [];

  const sessions: SessionSummary[] = [
    makeSession({ sessionKey: 'codex:already-ready', status: 'running', lastActiveAt: now - 1_000 }),
    makeSession({ sessionKey: 'codex:hot-1', status: 'running', lastActiveAt: now - 5_000, messageCount: 40 }),
    makeSession({ sessionKey: 'codex:hot-2', pinned: true, lastActiveAt: now - 60_000, messageCount: 15 }),
    makeSession({ sessionKey: 'codex:hot-3', lastActiveAt: now - 120_000, messageCount: 10 }),
  ];

  const warmer = createHotSessionWarmer({
    tracker,
    warmLimit: 2,
    cooldownMs: 30_000,
    now: () => now,
    getSessions: () => sessions,
    isHistoryReady: key => readySet.has(key),
    refreshSession: async (key, options) => {
      warmedCalls.push({ key, priority: options.priority });
    },
  });

  const firstCount = await warmer.warmNow();
  assert.equal(firstCount, 2);
  assert.deepEqual(warmedCalls.map(c => c.key), ['codex:hot-1', 'codex:hot-2']);

  // Second pass within cooldown only warms remaining unready candidate (codex:hot-3)
  const secondCount = await warmer.warmNow();
  assert.equal(secondCount, 1);
  assert.deepEqual(warmedCalls.map(c => c.key), ['codex:hot-1', 'codex:hot-2', 'codex:hot-3']);

  // New activity on codex:hot-1 bypasses cooldown even before 30s
  sessions[1] = { ...sessions[1]!, lastActiveAt: now + 5_000 };
  now += 5_000;
  const thirdCount = await warmer.warmNow();
  assert.equal(thirdCount, 1);
  assert.equal(warmedCalls.at(-1)?.key, 'codex:hot-1');

  await warmer.close();
});
