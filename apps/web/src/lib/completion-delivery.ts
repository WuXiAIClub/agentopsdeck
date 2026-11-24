import { projectionCursor } from './refresh-control.js';

/** Never announce an old/coalesced page as the result of a newer terminal
 * event. Legacy transports have no cursor; a new successful read is required. */
export function completionHistoryCurrent(eventCursor: unknown, pageCursor: unknown) {
  if (eventCursor === undefined) return true;
  const event = projectionCursor(eventCursor), page = projectionCursor(pageCursor);
  return !!event && !!page && event.epoch === page.epoch && page.seq >= event.seq;
}

export function createCompletionDelivery<T>(options: {
  scope(): unknown;
  /** Owner-wide notifications must not hydrate owner history in shared views. */
  enabled?(): boolean;
  read(key: string): Promise<{ sourceCursor?: string }>;
  deliver(value: T): void;
  settle(): Promise<void>;
  ready?(key: string, cursor: unknown): boolean;
}) {
  const pending = new Map<string, { value: T; cursor: unknown; scope: unknown; flight?: Promise<void> | undefined }>();
  return {
    clear(key?: string) { if (key === undefined) pending.clear(); else pending.delete(key); },
    // Successful ordinary snapshot reads can finish deferred delivery without
    // inventing another polling/retry loop when an SSE invalidation was lost.
    flushAll() { for (const key of pending.keys()) void this.flush(key, []); },
    enqueue(key: string, value: T, cursor: unknown) {
      if (options.enabled?.() === false) return;
      pending.set(key, { value, cursor, scope: options.scope() });
      while (pending.size > 500) pending.delete(pending.keys().next().value!);
    },
    flush(key: string, barriers: Promise<unknown>[]) {
      const item = pending.get(key);
      if (!item || item.flight) return item?.flight ?? Promise.resolve();
      const current = () => {
        if (options.enabled?.() === false) {
          if (pending.get(key) === item) pending.delete(key);
          return false;
        }
        return pending.get(key) === item && options.scope() === item.scope;
      };
      item.flight = (async () => {
        // Mounted message AND metadata lanes must finish their priority reads.
        // Rejections preserve pending intent; a later event can retry GET only.
        await Promise.all(barriers);
        if (!current()) return;
        const page = await options.read(key);
        if (!current() || !completionHistoryCurrent(item.cursor, page.sourceCursor)) return;
        await options.settle();
        if (!current() || options.ready?.(key, item.cursor) === false) return;
        pending.delete(key);
        options.deliver(item.value);
      })().catch(() => { /* No successful-read proof: no completion notification. */ })
        .finally(() => { item.flight = undefined; });
      return item.flight;
    },
  };
}
