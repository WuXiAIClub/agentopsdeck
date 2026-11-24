/** Bounded, pane-local search text. Never stores a second history snapshot.
 * Matching is weakly memoized for only the current query, including texts too
 * large to cache. Search semantics/order stay identical to Array.filter.
 */
export function createMessageSearch<T extends object>(text: (message: T) => string, maxBytes = 2 * 1024 * 1024, maxEntries = 4096) {
  const texts = new Map<T, string>();
  let bytes = 0;
  let needle = '';
  let matches = new WeakMap<T, boolean>();
  const remove = (message: T) => {
    const value = texts.get(message);
    if (value !== undefined) { bytes -= value.length * 2; texts.delete(message); }
  };
  return {
    search(messages: T[], query: string) {
      const next = query.trim().toLowerCase();
      if (needle !== next) { needle = next; matches = new WeakMap(); }
      // Drop superseded objects even when search closes. No deleted message,
      // previous session or old streaming revision is strongly retained.
      const current = new Set(messages);
      for (const message of texts.keys()) if (!current.has(message)) remove(message);
      if (!needle) { texts.clear(); bytes = 0; return []; }
      return messages.filter(message => {
        const hit = matches.get(message);
        if (hit !== undefined) return hit;
        let value = texts.get(message);
        if (value === undefined) {
          value = text(message);
          const size = value.length * 2;
          if (size <= maxBytes && maxEntries > 0) {
            while (texts.size && (bytes + size > maxBytes || texts.size >= maxEntries)) remove(texts.keys().next().value!);
            texts.set(message, value); bytes += size;
          }
        }
        const matched = value.includes(needle);
        matches.set(message, matched);
        return matched;
      });
    },
    stats: () => ({ entries: texts.size, bytes }),
  };
}
