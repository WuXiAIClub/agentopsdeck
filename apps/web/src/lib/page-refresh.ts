/** A reload releases the old document's caches, sockets, timers and DOM. Never
 * clear origin storage: it contains drafts, recovery receipts and layouts. */
export function createPageRefreshGate() {
  const guards = new Set<() => boolean>();
  return {
    register(ready: () => boolean) {
      guards.add(ready);
      return () => { guards.delete(ready); };
    },
    ready() {
      try { return [...guards].every(ready => ready()); }
      catch { return false; }
    },
  };
}
export const pageRefreshGate = createPageRefreshGate();
