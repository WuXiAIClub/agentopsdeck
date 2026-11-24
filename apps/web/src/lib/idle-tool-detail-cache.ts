/** Completed, CLOSED tool details only. Active text belongs to its component
 * and is never evicted while reading/copying. Eviction changes only whether a
 * subsequent explicit reopen needs another authorized detail read.
 */
export function createIdleToolDetailCache(maxBytes = 1024 * 1024, maxEntries = 64) {
  const values = new Map<string, string>();
  let bytes = 0;
  const size = (key: string, text: string) => (key.length + text.length) * 2;
  const remove = (key: string) => {
    const value = values.get(key);
    if (value !== undefined) { values.delete(key); bytes -= size(key, value); }
    return value;
  };
  return {
    take: remove,
    put(key: string, text: string) {
      remove(key);
      const count = size(key, text);
      if (count > maxBytes || maxEntries <= 0) return;
      while (values.size && (bytes + count > maxBytes || values.size >= maxEntries)) remove(values.keys().next().value!);
      values.set(key, text); bytes += count;
    },
    clear() { values.clear(); bytes = 0; },
    stats: () => ({ entries: values.size, bytes }),
  };
}
