import { HistoryReadDeferred, HistoryReadSuperseded } from './history.js';

type Outcome = 'ready' | 'failed' | 'superseded';
type Entry = { waiters: Set<(outcome: Outcome) => void>; settledAt?: number; outcome?: Outcome };

/** Detach read-only hydration from an HTTP deadline, not from runtime ownership.
 * Existing runtime refresh joins/fences/shutdown still own the actual work.
 * No transcript or authorization is cached; routes must recheck both on reply.
 */
export function createHistoryPreparation(options: { waitMs?: number; capacity?: number; now?: () => number } = {}) {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  return async (key: string, read: () => Promise<unknown>, ready: () => boolean, signal: AbortSignal): Promise<'ready' | 'failed' | 'pending'> => {
    signal.throwIfAborted();
    // Unclaimed completed tickets expire; active work is never evicted/restarted.
    for (const [id, entry] of entries) if (entry.settledAt !== undefined && now() - entry.settledAt > 30_000) entries.delete(id);
    let entry = entries.get(key);
    if (entry?.outcome === 'ready' && !ready()) { entries.delete(key); entry = undefined; }
    if (!entry) {
      if (entries.size >= (options.capacity ?? 256)) return 'failed';
      entry = { waiters: new Set() };
      const owned = entry;
      void Promise.resolve().then(read).then(() => 'ready' as const,
        error => error instanceof HistoryReadSuperseded || error instanceof HistoryReadDeferred ? 'superseded' as const : 'failed' as const).then(outcome => {
        owned.outcome = outcome; owned.settledAt = now();
        for (const waiter of owned.waiters) waiter(outcome);
        owned.waiters.clear();
      });
      entries.set(key, owned);
    }
    const owned = entry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    let complete: (outcome: Outcome) => void = () => {};
    try {
      const result = owned.outcome ?? await new Promise<Outcome | 'pending'>((resolve, reject) => {
        complete = resolve;
        owned.waiters.add(complete);
        timer = setTimeout(() => resolve('pending'), options.waitMs ?? 500);
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      // Claim the completion once. Other waiters already share this outcome;
      // subsequent polls use the runtime's ordinary freshness window.
      if (result !== 'pending' && entries.get(key) === owned) entries.delete(key);
      signal.throwIfAborted();
      // A joined hydration can finish immediately before the recovery worker
      // starts final reconciliation. Its resolved promise is not permission to
      // serve that now-invalidated projection. Poll the next runtime-owned read;
      // real read failures remain failures even if an older replica is ready.
      return result === 'superseded' || (result === 'ready' && !ready()) ? 'pending' : result;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); owned.waiters.delete(complete); }
  };
}
