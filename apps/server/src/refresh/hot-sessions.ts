import type { SessionSummary } from '@agentopsdeck/shared';
import { HistoryReadDeferred, HistoryReadSuperseded } from './history.js';

export type SessionAccessRecord = {
  accessCount: number;
  lastAccessedAt: number;
  lastWarmedAt: number;
  lastWarmedActivityAt: number;
};

export type RankedHotSession = {
  sessionKey: string;
  score: number;
  foregroundPriority: number;
  backgroundPriority: number;
  session: SessionSummary;
};

export class HotSessionTracker {
  private readonly records = new Map<string, SessionAccessRecord>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(16, options.maxEntries ?? 256);
  }

  recordAccess(sessionKey: string, weight = 1, now = Date.now()): SessionAccessRecord {
    const key = sessionKey.trim();
    if (!key) return { accessCount: 0, lastAccessedAt: 0, lastWarmedAt: 0, lastWarmedActivityAt: 0 };
    const existing = this.records.get(key);
    const next: SessionAccessRecord = {
      accessCount: Math.min(1_000, (existing?.accessCount ?? 0) + Math.max(1, weight)),
      lastAccessedAt: Math.max(existing?.lastAccessedAt ?? 0, now),
      lastWarmedAt: existing?.lastWarmedAt ?? 0,
      lastWarmedActivityAt: existing?.lastWarmedActivityAt ?? 0,
    };
    this.records.delete(key);
    this.records.set(key, next);
    this.trim();
    return next;
  }

  recordWarmed(sessionKey: string, lastActiveAt = 0, now = Date.now()): void {
    const key = sessionKey.trim();
    if (!key) return;
    const existing = this.records.get(key);
    const next: SessionAccessRecord = {
      accessCount: existing?.accessCount ?? 0,
      lastAccessedAt: existing?.lastAccessedAt ?? 0,
      lastWarmedAt: now,
      lastWarmedActivityAt: Math.max(existing?.lastWarmedActivityAt ?? 0, lastActiveAt),
    };
    this.records.delete(key);
    this.records.set(key, next);
    this.trim();
  }

  get(sessionKey: string): SessionAccessRecord | undefined {
    return this.records.get(sessionKey);
  }

  foregroundPriorityFor(session: SessionSummary | undefined, sessionKey: string, now = Date.now()): number {
    const access = this.records.get(sessionKey);
    if (session) {
      const score = scoreHotSession(session, access, now);
      if (score >= 300) return -2;
      if (score >= 120) return -1;
      return 0;
    }
    if (access && now - access.lastAccessedAt <= 15 * 60_000) return -1;
    return 0;
  }

  clear(): void {
    this.records.clear();
  }

  private trim(): void {
    while (this.records.size > this.maxEntries) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === undefined) break;
      this.records.delete(oldestKey);
    }
  }
}

export function scoreHotSession(
  session: SessionSummary,
  access: SessionAccessRecord | undefined,
  now = Date.now(),
): number {
  const recentlyAccessed = access !== undefined && now - access.lastAccessedAt <= 10 * 60_000;
  if ((session.hidden || session.archived) && !recentlyAccessed) return -1;

  let score = 0;

  // 1. Active / running session priority
  if (session.status === 'running' || session.hasActiveRun === true) {
    score += 400;
  } else if (session.status === 'failed') {
    score += 80;
  }

  // 2. Access frequency & recency
  if (access && access.accessCount > 0) {
    const ageMs = Math.max(0, now - access.lastAccessedAt);
    const recencyMultiplier = ageMs <= 5 * 60_000
      ? 1
      : ageMs <= 30 * 60_000
        ? 0.75
        : ageMs <= 2 * 60 * 60_000
          ? 0.4
          : 0.15;
    const freqPoints = Math.min(180, Math.round(Math.log2(access.accessCount + 1) * 45));
    const recencyPoints = Math.round(120 * recencyMultiplier);
    score += Math.round(freqPoints * recencyMultiplier) + recencyPoints;
  }

  // 3. Pinned status
  if (session.pinned) {
    score += 120;
  }

  // 4. Recent activity timestamp
  const lastActiveAt = session.lastActiveAt ?? 0;
  if (lastActiveAt > 0) {
    const inactiveMs = Math.max(0, now - lastActiveAt);
    if (inactiveMs <= 5 * 60_000) score += 250;
    else if (inactiveMs <= 15 * 60_000) score += 200;
    else if (inactiveMs <= 60 * 60_000) score += 140;
    else if (inactiveMs <= 6 * 60 * 60_000) score += 80;
    else if (inactiveMs <= 24 * 60 * 60_000) score += 40;
    else if (inactiveMs <= 7 * 24 * 60 * 60_000) score += 15;
  }

  // 5. Usage volume (messageCount)
  const messageCount = Math.max(0, session.messageCount ?? 0);
  if (messageCount > 0) {
    score += Math.min(80, Math.round(Math.log2(messageCount + 1) * 12));
  }

  return score;
}

export function rankHotSessions(
  sessions: readonly SessionSummary[],
  tracker?: HotSessionTracker,
  options: { limit?: number; minScore?: number; now?: number } = {},
): RankedHotSession[] {
  const now = options.now ?? Date.now();
  const minScore = options.minScore ?? 20;
  const ranked: RankedHotSession[] = [];

  for (const session of sessions) {
    if (!session?.sessionKey) continue;
    const access = tracker?.get(session.sessionKey);
    const score = scoreHotSession(session, access, now);
    if (score < minScore) continue;
    const foregroundPriority = score >= 300 ? -2 : score >= 120 ? -1 : 0;
    const backgroundPriority = score >= 400 ? 4 : score >= 250 ? 5 : score >= 120 ? 6 : 7;
    ranked.push({
      sessionKey: session.sessionKey,
      score,
      foregroundPriority,
      backgroundPriority,
      session,
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return (right.session.lastActiveAt ?? 0) - (left.session.lastActiveAt ?? 0);
  });

  if (typeof options.limit === 'number' && options.limit >= 0) {
    return ranked.slice(0, options.limit);
  }
  return ranked;
}

export type HotSessionLoadSnapshot = {
  active: number;
  pending: number;
  avgReadMs?: number;
  avgQueueMs?: number;
};

export type HotSessionWarmerOptions = {
  getSessions: () => readonly SessionSummary[];
  isHistoryReady: (sessionKey: string) => boolean;
  refreshSession: (sessionKey: string, options: { maxAgeMs: number; readOnly: true; priority: number }) => Promise<void>;
  getLoadSnapshot?: () => HotSessionLoadSnapshot;
  tracker?: HotSessionTracker;
  warmLimit?: number;
  cooldownMs?: number;
  now?: () => number;
};

export function createHotSessionWarmer(options: HotSessionWarmerOptions) {
  const tracker = options.tracker ?? new HotSessionTracker();
  const warmLimit = Math.max(1, options.warmLimit ?? 3);
  const cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000);
  const nowFn = options.now ?? Date.now;
  const inflight = new Set<Promise<void>>();
  const warmingKeys = new Set<string>();
  let scheduled = false;
  let closed = false;

  const computeEffectiveWarmLimit = (): number => {
    const load = options.getLoadSnapshot?.();
    if (!load) return warmLimit;
    if (load.pending > 0 || load.active >= 2 || (load.avgReadMs ?? 0) > 450 || (load.avgQueueMs ?? 0) > 300) {
      return 0;
    }
    if (load.active === 1 || (load.avgReadMs ?? 0) > 250) {
      return Math.min(1, warmLimit);
    }
    return warmLimit;
  };

  const runWarmPass = async (): Promise<number> => {
    if (closed) return 0;
    const effectiveLimit = computeEffectiveWarmLimit();
    if (effectiveLimit <= 0) return 0;
    const now = nowFn();
    const ranked = rankHotSessions(options.getSessions(), tracker, { now });
    const candidates: RankedHotSession[] = [];

    for (const item of ranked) {
      if (candidates.length >= effectiveLimit) break;
      if (warmingKeys.has(item.sessionKey)) continue;
      // Only warm sessions whose history is not yet marked ready in the runtime projection.
      if (options.isHistoryReady(item.sessionKey)) continue;
      const record = tracker.get(item.sessionKey);
      const lastActiveAt = item.session.lastActiveAt ?? 0;
      const recentlyWarmed = record !== undefined
        && now - record.lastWarmedAt < cooldownMs
        && lastActiveAt <= record.lastWarmedActivityAt;
      if (recentlyWarmed) continue;
      candidates.push(item);
    }

    let warmedCount = 0;
    for (const candidate of candidates) {
      if (closed || computeEffectiveWarmLimit() <= 0) break;
      warmingKeys.add(candidate.sessionKey);
      try {
        await options.refreshSession(candidate.sessionKey, {
          maxAgeMs: 15_000,
          readOnly: true,
          priority: candidate.backgroundPriority,
        });
        tracker.recordWarmed(candidate.sessionKey, candidate.session.lastActiveAt ?? 0, nowFn());
        warmedCount += 1;
      } catch (error) {
        if (!(error instanceof HistoryReadDeferred) && !(error instanceof HistoryReadSuperseded)) {
          // Best-effort background warm: ignore transient runtime errors so warm pass never crashes caller.
          tracker.recordWarmed(candidate.sessionKey, candidate.session.lastActiveAt ?? 0, nowFn());
        }
      } finally {
        warmingKeys.delete(candidate.sessionKey);
      }
    }
    return warmedCount;
  };

  const scheduleWarm = (): void => {
    if (closed || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closed) return;
      const task = runWarmPass().then(() => {}).finally(() => {
        inflight.delete(task);
      });
      inflight.add(task);
    });
  };

  return {
    tracker,
    warmNow: runWarmPass,
    scheduleWarm,
    close: async () => {
      closed = true;
      await Promise.allSettled([...inflight]);
    },
  };
}
