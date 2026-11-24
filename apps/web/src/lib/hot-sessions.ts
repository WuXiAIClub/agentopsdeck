import type { SessionSummary } from '@agentopsdeck/shared';
import { registerCacheCleaner } from './cache-cleaners.js';

const STORAGE_PREFIX = 'agentopsdeck.hotSessions.v1:';
const MAX_TRACKED = 64;

export type HotSessionAccessEntry = { accessCount: number; lastAccessedAt: number };
export type HotSessionRankingContext = {
  activeSessionKey?: string | undefined;
  openSessionKeys?: ReadonlySet<string>;
  unreadSessionKeys?: ReadonlySet<string>;
  accessMap?: ReadonlyMap<string, HotSessionAccessEntry>;
  now?: number;
};
export type RankedHotSessionCandidate = {
  sessionKey: string;
  score: number;
  priority: number;
  session: SessionSummary;
};

const memoryByScope = new Map<string, Map<string, HotSessionAccessEntry>>();
let resolveScope = () => 'default';

export function configureHotSessionScopeResolver(fn: () => string): void {
  resolveScope = fn;
}

const currentScope = () => {
  try { return resolveScope() || 'default'; } catch { return 'default'; }
};

function getScopeMap(scope = currentScope()): Map<string, HotSessionAccessEntry> {
  let map = memoryByScope.get(scope);
  if (map) return map;
  map = new Map();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_PREFIX + scope) : null;
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, HotSessionAccessEntry>)) {
        if (k && v && Number.isFinite(v.accessCount) && Number.isFinite(v.lastAccessedAt)) {
          map.set(k, { accessCount: Math.max(1, Math.trunc(v.accessCount)), lastAccessedAt: Math.max(0, Math.trunc(v.lastAccessedAt)) });
        }
      }
    }
  } catch {}
  memoryByScope.set(scope, map);
  return map;
}

export function clearHotSessionAccess(): void {
  memoryByScope.clear();
  try {
    if (typeof localStorage === 'undefined') return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {}
}
registerCacheCleaner(clearHotSessionAccess);

export function recordSessionAccess(sessionKey: string | undefined, weight = 1, now = Date.now()): void {
  const key = sessionKey?.trim();
  if (!key) return;
  const scope = currentScope(), map = getScopeMap(scope), prev = map.get(key);
  map.delete(key);
  map.set(key, {
    accessCount: Math.min(1_000, (prev?.accessCount ?? 0) + Math.max(1, weight)),
    lastAccessedAt: Math.max(prev?.lastAccessedAt ?? 0, now),
  });
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(Object.fromEntries(map)));
  } catch {}
}

export function readSessionAccessMap(): ReadonlyMap<string, HotSessionAccessEntry> {
  return getScopeMap();
}

export function getSessionAccessScore(sessionKey: string, now = Date.now(), accessMap = readSessionAccessMap()): number {
  const access = accessMap.get(sessionKey);
  if (!access || access.accessCount <= 0) return 0;
  const age = Math.max(0, now - access.lastAccessedAt);
  const mult = age <= 300_000 ? 1 : age <= 1_800_000 ? 0.75 : age <= 7_200_000 ? 0.45 : age <= 86_400_000 ? 0.2 : 0.08;
  return Math.round(Math.min(180, Math.round(Math.log2(access.accessCount + 1) * 45)) * mult) + Math.round(120 * mult);
}

export function scoreHotSession(session: SessionSummary, ctx: HotSessionRankingContext = {}): number {
  const now = ctx.now ?? Date.now();
  const accessScore = getSessionAccessScore(session.sessionKey, now, ctx.accessMap ?? readSessionAccessMap());
  if ((session.hidden || session.archived) && accessScore < 120) return -1;
  let score = accessScore;
  if (session.status === 'running' || session.hasActiveRun === true) score += 400;
  else if (session.status === 'failed') score += 90;
  if (ctx.unreadSessionKeys?.has(session.sessionKey)) score += 220;
  if (session.pinned) score += 120;
  const last = session.lastActiveAt ?? 0;
  if (last > 0) {
    const age = Math.max(0, now - last);
    score += age <= 300_000 ? 240 : age <= 900_000 ? 190 : age <= 3_600_000 ? 130 : age <= 21_600_000 ? 75 : age <= 86_400_000 ? 35 : age <= 604_800_000 ? 15 : 0;
  }
  const msgs = Math.max(0, session.messageCount ?? 0);
  if (msgs > 0) score += Math.min(80, Math.round(Math.log2(msgs + 1) * 12));
  return score;
}

export function rankHotSessionsForPreload(
  sessions: readonly SessionSummary[],
  ctx: HotSessionRankingContext & {
    limit?: number;
    minScore?: number;
    isVisible?: (sessionKey: string) => boolean;
    hasFreshCache?: (session: SessionSummary) => boolean;
  } = {},
): RankedHotSessionCandidate[] {
  const now = ctx.now ?? Date.now(), minScore = ctx.minScore ?? 25, accessMap = ctx.accessMap ?? readSessionAccessMap();
  const out: RankedHotSessionCandidate[] = [];
  for (const session of sessions) {
    const key = session?.sessionKey;
    if (!key || key === ctx.activeSessionKey || ctx.openSessionKeys?.has(key) || ctx.isVisible?.(key) || ctx.hasFreshCache?.(session)) continue;
    const score = scoreHotSession(session, { ...ctx, accessMap, now });
    if (score >= minScore) out.push({ sessionKey: key, score, priority: score >= 350 ? 2 : score >= 180 ? 3 : 4, session });
  }
  out.sort((a, b) => b.score - a.score || (b.session.lastActiveAt ?? 0) - (a.session.lastActiveAt ?? 0));
  return typeof ctx.limit === 'number' && ctx.limit >= 0 ? out.slice(0, ctx.limit) : out;
}

export function selectUnreadSessionsToPreload(
  rows: ReadonlyArray<{ sessionKey: string; unread: boolean; latestSequence?: number; throughSequence?: number }>,
  preloadedThrough: ReadonlyMap<string, number>,
  isVisible: (sessionKey: string) => boolean,
  limit = 3,
  scoreSession: (sessionKey: string) => number = getSessionAccessScore,
): Array<{ sessionKey: string; throughSequence: number }> {
  return rows
    .map((r, i) => ({ sessionKey: r.sessionKey, throughSequence: r.throughSequence ?? r.latestSequence ?? 0, unread: r.unread, score: r.unread && r.sessionKey ? scoreSession(r.sessionKey) : -1, i }))
    .filter(r => r.unread && r.sessionKey && !isVisible(r.sessionKey) && preloadedThrough.get(r.sessionKey) !== r.throughSequence)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, limit))
    .map(({ sessionKey, throughSequence }) => ({ sessionKey, throughSequence }));
}
