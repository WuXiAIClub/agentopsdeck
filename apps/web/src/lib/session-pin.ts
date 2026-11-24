import type { SessionSummary } from '@agentopsdeck/shared';

export function comparePinnedSessions(a: SessionSummary, b: SessionSummary) {
  const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDelta !== 0) return pinnedDelta;
  return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
}

export function sortPinnedSessions<T extends SessionSummary>(sessions: T[]): T[] {
  return [...sessions].sort(comparePinnedSessions);
}

export function updatePinnedSessionList<T extends SessionSummary>(sessions: T[], sessionKey: string, pinned: boolean) {
  let changed = false;
  let pinnedDelta = 0;
  const next = sessions.map((session) => {
    if (session.sessionKey !== sessionKey) return session;
    changed = true;
    if (pinned !== Boolean(session.pinned)) pinnedDelta += pinned ? 1 : -1;
    return { ...session, pinned } as T;
  });
  return {
    changed,
    pinnedDelta,
    sessions: changed ? sortPinnedSessions(next) : sessions,
  };
}
