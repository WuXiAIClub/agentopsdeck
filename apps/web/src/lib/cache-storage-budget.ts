type CacheBudget = {
  rootPrefix: string;
  maxSessions: number;
  maxBytes: number;
};

/** Inspect current storage on every write, including other-tab edits. Only
 * decode message payloads when eviction actually needs their cachedAt ordering.
 * No persistent metadata index, new storage keys, or delayed writes. */
export function enforceCacheStorageBudget(store: Storage, budget: CacheBudget): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(budget.rootPrefix)) keys.push(key);
    }
    const messages: Array<{ key: string; raw: string; bytes: number; cachedAt: number }> = [];
    let totalBytes = 0;
    for (const key of keys) {
      const raw = store.getItem(key) ?? '';
      const bytes = (key.length + raw.length) * 2;
      totalBytes += bytes;
      if (/\.messages\.[^.]+$/.test(key)) messages.push({ key, raw, bytes, cachedAt: 0 });
    }
    if (messages.length <= budget.maxSessions && totalBytes <= budget.maxBytes) return;
    for (const entry of messages) {
      try {
        const cachedAt = JSON.parse(entry.raw)?.cachedAt;
        entry.cachedAt = typeof cachedAt === 'number' && Number.isFinite(cachedAt) ? cachedAt : 0;
      } catch { /* corrupt entries sort first */ }
    }
    if (messages.length > budget.maxSessions) {
      const overflow = [...messages].sort((a, b) => a.cachedAt - b.cachedAt)
        .slice(0, messages.length - budget.maxSessions);
      for (const entry of overflow) {
        try { store.removeItem(entry.key); totalBytes -= entry.bytes; } catch { /* best effort */ }
      }
    }
    if (totalBytes > budget.maxBytes) {
      const remaining = messages.filter(entry => store.getItem(entry.key) !== null)
        .sort((a, b) => a.cachedAt - b.cachedAt);
      for (const entry of remaining) {
        if (totalBytes <= budget.maxBytes) break;
        try { store.removeItem(entry.key); totalBytes -= entry.bytes; } catch { /* best effort */ }
      }
    }
  } catch { /* storage can become unavailable between calls */ }
}
