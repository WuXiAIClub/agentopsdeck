import type { SourcePreview } from '@agentopsdeck/shared';
import { isSourceMediaUrl, isSourcePreview, SourcePreviewError } from './source-preview.js';

// Tab-lifetime storage, not a permanent file snapshot. Keys include the full
// account scope and authorized media URL (Hub/session/message identity).
const STORAGE_KEY = 'agentopsdeck.source-previews.v1';
const TTL = 5 * 60_000;
const MAX_ENTRIES = 32;
const MAX_BYTES = 1024 * 1024;
type Entry = { preview?: SourcePreview; error?: string; canApprove?: boolean; loading?: boolean; savedAt: number };
type StoredEntry = { value: Entry; bytes: number; older?: string | undefined; newer?: string | undefined };
export function sourcePreviewCacheKey(origin: string, base: string, scope: string | undefined, url: string | undefined, path: string, line: number) {
  return scope && /^[a-f0-9]{64}$/.test(scope) && url && isSourceMediaUrl(url) ? JSON.stringify([origin, base, scope, url, path, line]) : undefined;
}

export function createSourcePreviewCache(storage: () => Storage | undefined, now = Date.now) {
  const entries = new Map<string, StoredEntry>();
  // Only unowned entries participate in eviction. Mounted cards can exceed the
  // reusable-cache budget, without making every release scan all mounted cards.
  const evictable = new Set<string>();
  let newest: string | undefined;
  let entryBytes = 0;
  const pending = new Map<string, { controller: AbortController; promise: Promise<void>; settled: boolean }>();
  const listeners = new Map<string, Set<() => void>>();
  const mounted = new Map<string, number>();
  let hydrated = false;
  const fresh = (entry: Entry) => !entry.preview?.temporaryApproval && now() >= entry.savedAt && now() - entry.savedAt < TTL;
  const emit = (key: string) => { for (const listener of listeners.get(key) ?? []) listener(); };
  function remove(key: string) {
    const stored = entries.get(key);
    if (!stored) return;
    if (stored.older !== undefined) entries.get(stored.older)!.newer = stored.newer;
    if (stored.newer !== undefined) entries.get(stored.newer)!.older = stored.older;
    else newest = stored.older;
    entryBytes -= stored.bytes;
    entries.delete(key);
    evictable.delete(key);
  }
  function remember(key: string, value: Entry) {
    // Measure only the changed entry; never serialize the complete live cache.
    const bytes = JSON.stringify([key, value]).length * 2;
    remove(key);
    const stored: StoredEntry = { value, bytes, older: newest };
    if (newest !== undefined) entries.get(newest)!.newer = key;
    entries.set(key, stored);
    newest = key;
    entryBytes += bytes;
    if (!mounted.has(key)) evictable.add(key);
  }
  function persist() {
    try {
      const target = storage();
      if (!target) return;
      // Walk newest first, stopping at the reusable budget. If there are fewer
      // eligible entries we may scan old metadata, but never serialize its
      // source. Expired/error/temporary entries remain excluded as before.
      const rows: string[] = [];
      let bytes = 4; // [] in UTF-16, consistent with the existing storage budget.
      for (let key = newest; key !== undefined && rows.length < MAX_ENTRIES;) {
        const stored = entries.get(key)!;
        const entry = stored.value;
        if (entry.preview && fresh(entry)) {
          const row = JSON.stringify([key, { preview: entry.preview, savedAt: entry.savedAt }]);
          const rowBytes = row.length * 2 + (rows.length ? 2 : 0);
          // Keep a contiguous newest suffix: an oversized newest entry must
          // produce [], not fall back to persisting an older preview.
          if (bytes + rowBytes > MAX_BYTES) break;
          bytes += rowBytes;
          rows.push(row);
        }
        key = stored.older;
      }
      target.setItem(STORAGE_KEY, `[${rows.reverse().join(',')}]`);
    } catch { /* Private mode/quota: memory cache still works. */ }
  }
  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
      const raw = storage()?.getItem(STORAGE_KEY);
      if (!raw || raw.length * 2 > MAX_BYTES) return;
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > MAX_ENTRIES) return;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2) continue;
        const [key, entry] = row;
        if (typeof key !== 'string' || !entry || !Number.isFinite(entry.savedAt) || !fresh(entry) || !isSourcePreview(entry.preview)) continue;
        const parts = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 6 || !isSourceMediaUrl(parts[3])
          || parts[4] !== entry.preview.path || parts[5] !== entry.preview.line) continue;
        remember(key, { preview: entry.preview, savedAt: entry.savedAt });
      }
    } catch { /* Corrupt/disabled storage is a cache miss. */ }
  }
  function trim() {
    // Active cards own their displayed content. Eviction only bounds reusable
    // off-screen entries, never blanks an already mounted card mid-conversation.
    for (const key of evictable) {
      if (entries.size <= MAX_ENTRIES && entryBytes + 4 + Math.max(0, entries.size - 1) * 2 <= MAX_BYTES) break;
      remove(key);
    }
  }
  function put(key: string, entry: Entry) {
    remember(key, entry);
    trim();
    persist(); emit(key);
  }
  const cache = {
    subscribe(key: string | undefined, listener: () => void) {
      if (!key) return () => {};
      let subscriptions = listeners.get(key);
      if (!subscriptions) { subscriptions = new Set(); listeners.set(key, subscriptions); }
      // Independent ownership even if the caller reuses a callback.
      const notify = () => listener();
      subscriptions.add(notify);
      mounted.set(key, (mounted.get(key) ?? 0) + 1);
      evictable.delete(key);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscriptions.delete(notify);
        if (!subscriptions.size) listeners.delete(key);
        const count = (mounted.get(key) ?? 1) - 1;
        if (count) mounted.set(key, count);
        else {
          mounted.delete(key);
          // React may resubscribe in the same commit. Give that owner one
          // microtask to reclaim the shared transport; otherwise closing the
          // last card must not leave a preview read running in the background.
          const request = pending.get(key);
          if (request) queueMicrotask(() => {
            if (mounted.has(key) || pending.get(key) !== request || request.settled) return;
            pending.delete(key);
            // A cancelled refresh never confirms permission/freshness. Drop
            // both the loading marker and its persisted previous source.
            remove(key);
            persist();
            request.controller.abort();
          });
          // Reusable entries are evicted in the order they become unowned (or
          // were last written while unowned), never while another card owns one.
          if (entries.has(key)) evictable.add(key);
        }
        trim();
      };
    },
    peek(key: string | undefined) {
      hydrate();
      if (!key) return undefined;
      // Keep mounted content stable after expiry. The next load/remount checks
      // freshness and revalidates without clearing the existing code first.
      return entries.get(key)?.value;
    },
    load(key: string, loader: (signal: AbortSignal) => Promise<SourcePreview>, force = false) {
      const inFlight = pending.get(key);
      if (inFlight) return inFlight.promise;
      const previous = cache.peek(key);
      if (!force && previous && fresh(previous)) return Promise.resolve();
      const controller = new AbortController();
      const request = { controller, promise: Promise.resolve(), settled: false };
      pending.set(key, request);
      request.promise = Promise.resolve().then(() => {
        if (pending.get(key) !== request || controller.signal.aborted) return;
        return loader(controller.signal);
      }).then(preview => {
        if (pending.get(key) !== request) return;
        const parts = JSON.parse(key);
        if (!isSourcePreview(preview) || preview.path !== parts[4] || preview.line !== parts[5]) throw new Error('Source reference did not match the preview.');
        request.settled = true;
        put(key, { preview, savedAt: now() });
      }).catch(error => {
        if (pending.get(key) !== request) return;
        // A failed authorization/read must not leave previously cached code on
        // screen or in storage. Remounts retain the error instead of retry storms.
        request.settled = true;
        put(key, { error: error instanceof Error ? error.message : 'Preview unavailable.', canApprove: error instanceof SourcePreviewError && error.canApprove, savedAt: now() });
      }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
      // Publish only after installing the actual promise: a listener may
      // synchronously request this same preview or revoke its scope.
      put(key, { ...(previous?.preview ? { preview: previous.preview } : {}), loading: true, savedAt: now() });
      return request.promise;
    },
    clear(matches: (key: string) => boolean = () => true) {
      hydrate();
      const changed = new Set<string>();
      for (const [key, request] of pending) if (matches(key)) { pending.delete(key); request.controller.abort(); }
      for (const key of entries.keys()) if (matches(key)) { remove(key); changed.add(key); }
      persist();
      for (const key of changed) emit(key);
    },
  };
  return cache;
}

export const sourcePreviewCache = createSourcePreviewCache(() => window.sessionStorage);
export function clearSourcePreviewsForNodes(ids: ReadonlySet<string>) {
  sourcePreviewCache.clear(key => {
    try {
      const url = JSON.parse(key)[3] as string;
      const session = decodeURIComponent(url.match(/\/sessions\/([^/]+)/)![1]!);
      return ids.has(session.split(':')[0]!);
    } catch { return true; }
  });
}
