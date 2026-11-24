/** Short-lived, bounded first-page reuse for navigation only. Background polls
 * still revalidate; a failure/reset/revocation cannot become a cached success. */
export function createNavigationHistory<T>(now = Date.now, maxBytes = 8 * 1024 * 1024, capacity = 16) {
  const entries = new Map<string, { session: string; value: T; at: number; bytes: number }>();
  let bytes = 0, epoch = 0;
  const remove = (key: string) => { bytes -= entries.get(key)?.bytes ?? 0; entries.delete(key); };
  return {
    epoch: () => epoch,
    get(key: string) {
      const entry = entries.get(key);
      if (!entry) return;
      if (now() - entry.at >= 30_000) { remove(key); return; }
      entries.delete(key); entries.set(key, entry); return entry.value;
    },
    put(key: string, session: string, value: T, startedEpoch: number) {
      if (startedEpoch !== epoch) return;
      remove(key);
      let size: number;
      try { size = JSON.stringify(value).length * 2; } catch { return; }
      if (size > maxBytes) return;
      entries.set(key, { session, value, bytes: size, at: now() }); bytes += size;
      while (bytes > maxBytes || entries.size > capacity) remove(entries.keys().next().value!);
    },
    clear(matches: (session: string) => boolean = () => true) {
      epoch++; // Fences reads started before this invalidation, including evicted keys.
      for (const [key, entry] of entries) if (matches(entry.session)) remove(key);
    },
  };
}
