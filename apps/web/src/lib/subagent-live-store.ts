import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { registerCacheCleaner } from './cache-cleaners.js';
import { readCachedMessages } from './session-cache.js';

export type LiveSessionSnapshot = {
  sessionKey: string;
  session?: SessionSummary | undefined;
  messages: readonly ChatMessage[];
  stale: boolean;
  updatedAt: number;
};

const MAX_TRACKED_SESSIONS = 48;
const snapshots = new Map<string, LiveSessionSnapshot>();
const listeners = new Set<() => void>();
let revision = 0;

function notify() {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore listener errors */
    }
  }
}

export function publishLiveSessionMessages(
  sessionKey: string,
  session: SessionSummary,
  messages: readonly ChatMessage[],
  stale: boolean,
): void {
  if (!sessionKey) return;
  const prev = snapshots.get(sessionKey);
  if (
    prev &&
    prev.session === session &&
    prev.messages === messages &&
    prev.stale === stale
  ) {
    return;
  }
  if (prev) snapshots.delete(sessionKey);
  snapshots.set(sessionKey, {
    sessionKey,
    session,
    messages,
    stale,
    updatedAt: Date.now(),
  });
  while (snapshots.size > MAX_TRACKED_SESSIONS) {
    const oldestKey = snapshots.keys().next().value as string | undefined;
    if (!oldestKey) break;
    snapshots.delete(oldestKey);
  }
  notify();
}

export function clearLiveSessionMessages(sessionKey?: string): void {
  if (sessionKey) {
    if (snapshots.delete(sessionKey)) notify();
    return;
  }
  if (snapshots.size > 0) {
    snapshots.clear();
    notify();
  }
}

export function getLiveSessionSnapshot(
  sessionKey: string,
  fallbackSession?: SessionSummary,
): LiveSessionSnapshot | undefined {
  const live = snapshots.get(sessionKey);
  if (live) {
    return fallbackSession && !live.session ? { ...live, session: fallbackSession } : live;
  }
  const cached = readCachedMessages(sessionKey);
  if (!cached) return undefined;
  return {
    sessionKey,
    session: fallbackSession,
    messages: cached.messages,
    stale: false,
    updatedAt: cached.updatedAt,
  };
}

export function subscribeSubagentLiveStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSubagentLiveStoreRevision(): number {
  return revision;
}

registerCacheCleaner(() => {
  clearLiveSessionMessages();
});
