const externalCacheCleaners = new Set<() => void>();

export function registerCacheCleaner(cleaner: () => void): () => void {
  externalCacheCleaners.add(cleaner);
  return () => {
    externalCacheCleaners.delete(cleaner);
  };
}

export function runCacheCleaners(): void {
  for (const cleaner of externalCacheCleaners) {
    try {
      cleaner();
    } catch {
      /* ignore */
    }
  }
}
