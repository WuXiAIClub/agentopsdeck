export class HistoryPreparing extends Error {
  constructor(readonly retryAfterMs: number) { super('History is being prepared'); }
}

/** Share one retry loop for duplicate panes, but detach their lifetimes. Only
 * the last departing consumer cancels transport; no resolved data is cached. */
export function createHistoryReadCoalescer() {
  const entries = new Map<string, { controller: AbortController; task: Promise<unknown>; consumers: number; onImmediateJoin?: (() => void) | undefined }>();
  return <T>(key: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
    scheduling?: { immediate: boolean; onImmediateJoin?: (() => void) | undefined }): Promise<T> => {
    signal?.throwIfAborted();
    let entry = entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, task: undefined as unknown as Promise<unknown>, consumers: 0, onImmediateJoin: scheduling?.onImmediateJoin };
      const owned = entry;
      owned.task = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); })
        .finally(() => { if (entries.get(key) === owned) entries.delete(key); });
      entries.set(key, owned);
    }
    // Joining an already queued read must not make an explicit refresh wait
    // behind unrelated history. Promote the existing work; never duplicate it.
    if (scheduling?.immediate) entry.onImmediateJoin?.();
    const owned = entry; owned.consumers++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (publish: () => void) => {
        if (done) return;
        done = true; signal?.removeEventListener('abort', abort);
        if (--owned.consumers === 0) {
          if (entries.get(key) === owned) entries.delete(key);
          owned.controller.abort();
        }
        publish();
      };
      const abort = () => finish(() => reject(signal?.reason));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      owned.task.then(value => finish(() => resolve(value as T)), error => finish(() => reject(error)));
    });
  };
}

/** Only repeat a negotiated read, never a send/creation/stop request. Keep the
 * caller's loading state and last snapshot intact while preparation is running.
 */
export async function readPreparedHistory<T>(read: () => Promise<T>, check: () => void, signal?: AbortSignal,
  options: { maxWaitMs?: number; now?: () => number } = {}): Promise<T> {
  const now = options.now ?? Date.now, started = now();
  for (;;) {
    signal?.throwIfAborted(); check();
    try {
      const result = await read();
      signal?.throwIfAborted(); check();
      return result;
    } catch (error) {
      if (!(error instanceof HistoryPreparing)) throw error;
      signal?.throwIfAborted(); check();
      if (now() - started + error.retryAfterMs > (options.maxWaitMs ?? 120_000))
        throw new Error('History is still synchronizing. Existing messages are preserved; retry shortly.');
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, error.retryAfterMs);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
