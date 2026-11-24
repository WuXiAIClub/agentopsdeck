// Bounded, namespace-safe front-end cache for stale-while-revalidate hydration.
//
// Goal (COD-055): refreshing a desktop/mobile chat should immediately render the
// previously seen sessions list and messages from local cache, then revalidate
// against the server in the background. Mobile chat detail should land at the
// latest/bottom because cached messages exist on first paint.
//
// Safety rules baked in here:
// - Never store access keys, tokens, or secrets. We only persist non-sensitive
//   session metadata and chat messages that the server already returned.
// - Namespace every entry by origin + the active API base (backend) so a
//   different deployment / LAN backend can never reuse another's cache.
// - Bound everything: cap cached sessions (LRU), cap messages per session, and
//   enforce a total byte budget so localStorage cannot grow unbounded or block.
// - Fail closed and silent: any storage error (quota, private mode, disabled)
//   degrades to "no cache" without breaking the app.

import type { ChatMessage, SessionsState } from '@agentopsdeck/shared';
import { apiBaseUrl, recoveryScope, invalidateNavigationHistory } from '../api';
import { fitMessageCache } from './message-cache-budget';
import { enforceCacheStorageBudget } from './cache-storage-budget';
import { clearSourcePreviewsForNodes, sourcePreviewCache } from './source-preview-cache';
import { sessionPreviewCache } from './session-preview-cache';
import { clearOptimisticMessages } from './optimistic-messages';
import { registerCacheCleaner, runCacheCleaners } from './cache-cleaners';

const CACHE_VERSION = 'v2';
const CACHE_ROOT = 'agentopsdeck.cache';

// Count and byte bounds are independent: tool-heavy conversations can exceed
// the byte budget well before the normal 200-row initial page is full.
const MAX_CACHED_SESSIONS = 40;
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_TOTAL_CACHE_BYTES = 4 * 1024 * 1024; // ~4MB soft budget across keys
const MAX_ENTRY_BYTES = 1.5 * 1024 * 1024; // skip persisting any single oversized entry

const SESSIONS_KIND = 'sessions';
const MESSAGES_KIND = 'messages';

type MessagesCacheEntry = {
  v: typeof CACHE_VERSION;
  sessionKey: string;
  messages: ChatMessage[];
  hiddenCount?: number;
  updatedAt: number;
  cachedAt: number;
};

type SessionsCacheEntry = {
  v: typeof CACHE_VERSION;
  state: SessionsState;
  cachedAt: number;
};

function storage(): Storage | null {
  try {
    const ls = window.localStorage;
    // Touch to confirm availability (throws in some privacy modes).
    const probe = '__agentopsdeck_cache_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

// Routing namespace only. Account/Hub isolation uses the full server-issued
// recovery scope in keyPrefix, never a short non-cryptographic hash.
function namespace(): string {
  let backend = '';
  try {
    backend = apiBaseUrl() || 'same-origin';
  } catch {
    backend = 'same-origin';
  }
  let origin = '';
  try {
    origin = window.location.host || 'local';
  } catch {
    origin = 'local';
  }
  return `${origin}|${backend}`;
}

function safeHash(input: string): string {
  // Small, fast, non-cryptographic hash (FNV-1a) just to produce compact,
  // collision-resistant-enough key fragments. Not used for any security purpose.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function keyPrefix(): string {
  return `${CACHE_ROOT}.${CACHE_VERSION}.${recoveryScope() ?? 'unauthenticated'}.${safeHash(namespace())}`;
}

function messagesKey(sessionKey: string): string {
  return `${keyPrefix()}.${MESSAGES_KIND}.${safeHash(sessionKey)}`;
}

function sessionsKey(): string {
  return `${keyPrefix()}.${SESSIONS_KIND}`;
}

function byteLength(value: string): number {
  // Approximate UTF-16 storage footprint used by localStorage.
  return value.length * 2;
}

function readEntry<T>(store: Storage, key: string): T | undefined {
  try {
    const raw = store.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as T & { v?: string };
    if (parsed && typeof parsed === 'object' && parsed.v === CACHE_VERSION) return parsed as T;
    // Unknown/older shape — drop it.
    store.removeItem(key);
    return undefined;
  } catch {
    try { store.removeItem(key); } catch { /* ignore */ }
    return undefined;
  }
}

function allCacheKeys(store: Storage): string[] {
  const prefix = `${CACHE_ROOT}.`;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function enforceBounds(store: Storage): void {
  try {
    enforceCacheStorageBudget(store, { rootPrefix: `${CACHE_ROOT}.`,
      maxSessions: MAX_CACHED_SESSIONS, maxBytes: MAX_TOTAL_CACHE_BYTES });
  } catch { /* preserve best-effort behavior if the active scope becomes unavailable */ }
}

function writeEntry(store: Storage, key: string, payload: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return;
  }
  if (byteLength(serialized) > MAX_ENTRY_BYTES) return; // never persist oversized blobs
  try {
    store.setItem(key, serialized);
  } catch {
    // Likely quota — evict and retry once.
    enforceBounds(store);
    try { store.setItem(key, serialized); } catch { /* give up silently */ }
    return;
  }
  enforceBounds(store);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readCachedSessionsState(): SessionsState | undefined {
  if (!recoveryScope()) return undefined;
  const store = storage();
  if (!store) return undefined;
  const entry = readEntry<SessionsCacheEntry>(store, sessionsKey());
  if (!entry || !entry.state || !Array.isArray(entry.state.groups)) return undefined;
  return entry.state;
}

export function writeCachedSessionsState(state: SessionsState | undefined): void {
  if (!recoveryScope()) return;
  const store = storage();
  if (!store || !state || !Array.isArray(state.groups)) return;
  const entry: SessionsCacheEntry = { v: CACHE_VERSION, state, cachedAt: Date.now() };
  writeEntry(store, sessionsKey(), entry);
}

export type CachedMessages = {
  messages: ChatMessage[];
  hiddenCount?: number | undefined;
  updatedAt: number;
};

export function readCachedMessages(sessionKey: string): CachedMessages | undefined {
  if (!recoveryScope()) return undefined;
  if (!sessionKey) return undefined;
  const store = storage();
  if (!store) return undefined;
  const entry = readEntry<MessagesCacheEntry>(store, messagesKey(sessionKey));
  if (!entry || entry.sessionKey !== sessionKey || !Array.isArray(entry.messages)) return undefined;
  return {
    messages: entry.messages,
    hiddenCount: entry.hiddenCount,
    updatedAt: entry.updatedAt,
  };
}

export function writeCachedMessages(
  sessionKey: string,
  messages: ChatMessage[],
  meta?: { hiddenCount?: number | undefined; updatedAt?: number },
): void {
  if (!recoveryScope()) return;
  if (!sessionKey || !Array.isArray(messages)) return;
  const store = storage();
  if (!store) return;
  const entry: MessagesCacheEntry = {
    v: CACHE_VERSION,
    sessionKey,
    messages,
    ...(meta?.hiddenCount !== undefined ? { hiddenCount: meta.hiddenCount } : {}),
    updatedAt: meta?.updatedAt ?? Date.now(),
    cachedAt: Date.now(),
  };
  const bounded = fitMessageCache(entry, MAX_MESSAGES_PER_SESSION, MAX_ENTRY_BYTES);
  if (bounded) writeEntry(store, messagesKey(sessionKey), bounded);
  else { try { store.removeItem(messagesKey(sessionKey)); } catch { /* no stale fallback */ } }
}

export function appendOptimisticMessageToCache(sessionKey: string, message: ChatMessage): void {
  const existing = readCachedMessages(sessionKey);
  if (!existing) return;
  const index = existing.messages.findIndex(item => item.id === message.id);
  const nextMessages = index >= 0
    ? existing.messages.map((item, idx) => idx === index ? message : item)
    : [...existing.messages, message];
  writeCachedMessages(sessionKey, nextMessages, {
    hiddenCount: existing.hiddenCount,
    updatedAt: Math.max(existing.updatedAt, message.createdAt),
  });
}

export function removeOptimisticMessageFromCache(sessionKey: string, messageId: string): void {
  const existing = readCachedMessages(sessionKey);
  if (!existing) return;
  const nextMessages = existing.messages.filter(item => item.id !== messageId);
  if (nextMessages.length === existing.messages.length) return;
  writeCachedMessages(sessionKey, nextMessages, {
    hiddenCount: existing.hiddenCount,
    updatedAt: existing.updatedAt,
  });
}

// Drop the cached messages for a session (e.g. after delete) without disturbing
// other namespaces/sessions.
export function clearCachedMessages(sessionKey: string): void {
  if (!sessionKey) return;
  invalidateNavigationHistory(key => key === sessionKey);
  clearOptimisticMessages((key, scope) => scope === (recoveryScope() ?? '') && key === sessionKey);
  sessionPreviewCache.clear(key => { try { return JSON.parse(key)[1] === sessionKey; } catch { return true; } });
  const store = storage();
  if (!store) return;
  try { store.removeItem(messagesKey(sessionKey)); } catch { /* ignore */ }
}

// Only the active account/backend namespace. Never delete drafts, command
// recovery receipts, or another node's messages when one node is revoked.
export function clearCachedNodeData(connectionIds: ReadonlySet<string>): void {
  if (!recoveryScope() || connectionIds.size === 0) return;
  invalidateNavigationHistory(key => key.startsWith('[') || connectionIds.has(key.split(':')[0]!));
  clearOptimisticMessages((key, scope) => scope === (recoveryScope() ?? '') && (key.startsWith('[') || connectionIds.has(key.split(':')[0]!)));
  clearSourcePreviewsForNodes(connectionIds);
  sessionPreviewCache.clear(key => {
    try {
      const session = JSON.parse(key)[1] as string;
      // Shared addresses carry owner routing; revalidate those rather than
      // treating the encoded shared key as a Connector ID.
      return session.startsWith('[') || connectionIds.has(session.split(':')[0]!);
    } catch { return true; }
  });
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(sessionsKey()); // A cached aggregate no longer has a valid view.
    const prefix = `${keyPrefix()}.${MESSAGES_KIND}.`;
    for (const key of allCacheKeys(store)) {
      if (!key.startsWith(prefix)) continue;
      const entry = readEntry<MessagesCacheEntry>(store, key);
      const sessionKey = entry?.sessionKey;
      if (typeof sessionKey === 'string' && sessionKey.includes(':') && connectionIds.has(sessionKey.slice(0, sessionKey.indexOf(':')))) store.removeItem(key);
    }
  } catch { /* best effort; request/UI fences do not depend on storage access */ }
}

// Best-effort wipe of every cache entry across all namespaces (used on logout/lock
// so a different access context never inherits stale cached chats).
export { registerCacheCleaner };

export function clearAllCachedData(): void {
  runCacheCleaners();
  invalidateNavigationHistory();
  clearOptimisticMessages();
  sourcePreviewCache.clear();
  sessionPreviewCache.clear();
  const store = storage();
  if (!store) return;
  try {
    for (const key of allCacheKeys(store)) {
      try { store.removeItem(key); } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
}
