import { HistoryReadDeferred, type HistoryRefreshOptions } from './history.js';

type Job = {
  read: () => Promise<void>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
  priority: number;
};

function normalizePriority(priority: number | undefined): number {
  if (typeof priority !== 'number' || !Number.isFinite(priority)) return 0;
  return Math.max(-10, Math.min(20, Math.trunc(priority)));
}

/** Connector-local display hydration budget, NOT execution admission.
 * Only readOnly/non-fresh work is queued. Terminal/goal/recovery reads bypass
 * the queue and retain the runtime's own freshness/connection fences. Never
 * reuse a display promise as authoritative evidence. No timers, result cache,
 * transcript retention or new SQLite owner. Each dispatch yields to the loop.
 */
export function createHistoryReadScheduler(options: { concurrency?: number; maxPending?: number } = {}) {
  const concurrency = options.concurrency ?? 3, maxPending = options.maxPending ?? 128;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3
    || !Number.isSafeInteger(maxPending) || maxPending < 0 || maxPending > 128) throw new Error('Invalid history read budget');
  const allowUrgentBurst = options.concurrency === undefined && concurrency >= 2;
  const jobs = new Map<string, Job>(), pending: Array<[string, Job]> = [];
  const controls = new Set<Promise<void>>();
  const recentTimestamps: number[] = [];
  let active = 0, activeBackground = 0, dispatches = 0, closing: Promise<void> | undefined;
  let emaReadMs = 0, emaQueueMs = 0;
  const counters = { admitted: 0, coalesced: 0, deferred: 0, completed: 0, failed: 0, bypassed: 0,
    queueMs: 0, readMs: 0, maxQueueMs: 0, maxReadMs: 0, highPriorityAdmitted: 0, lowPriorityShed: 0, urgentBurstDispatched: 0 };
  const recordCompletionSample = (nowMs: number, queueMs: number, readMs: number) => {
    recentTimestamps.push(nowMs);
    const cutoff = nowMs - 10_000;
    while (recentTimestamps.length > 0 && recentTimestamps[0]! < cutoff) recentTimestamps.shift();
    emaQueueMs = emaQueueMs === 0 ? queueMs : emaQueueMs * 0.75 + queueMs * 0.25;
    emaReadMs = emaReadMs === 0 ? readMs : emaReadMs * 0.75 + readMs * 0.25;
  };
  const computeRecentRps = () => {
    const nowMs = performance.now(), cutoff = nowMs - 10_000;
    while (recentTimestamps.length > 0 && recentTimestamps[0]! < cutoff) recentTimestamps.shift();
    return Math.round((recentTimestamps.length / 10) * 100) / 100;
  };
  const dequeueNext = (): [string, Job] => {
    dispatches += 1;
    // Anti-starvation: every 5th dispatch serves the oldest waiting job in FIFO order.
    if (dispatches % 5 === 0 || pending.length === 1) return pending.shift()!;
    let bestIndex = 0;
    let bestPriority = pending[0]![1].priority;
    for (let index = 1; index < pending.length; index += 1) {
      const candidatePriority = pending[index]![1].priority;
      if (candidatePriority < bestPriority) {
        bestPriority = candidatePriority;
        bestIndex = index;
      }
    }
    return pending.splice(bestIndex, 1)[0]!;
  };
  const pump = () => {
    while (pending.length) {
      const canNormal = active < concurrency;
      let urgentIndex = -1;
      if (!canNormal && allowUrgentBurst && active === concurrency && activeBackground > 0 && emaReadMs <= 350) {
        let bestPri = 0;
        for (let i = 0; i < pending.length; i += 1) {
          if (pending[i]![1].priority < bestPri) {
            bestPri = pending[i]![1].priority;
            urgentIndex = i;
          }
        }
      }
      if (!canNormal && urgentIndex < 0) break;
      const [key, job] = canNormal ? dequeueNext() : pending.splice(urgentIndex, 1)[0]!;
      if (!canNormal) counters.urgentBurstDispatched++;
      active++;
      const wasBackground = job.priority >= 4;
      if (wasBackground) activeBackground++;
      setImmediate(async () => {
        const started = performance.now(), queueMs = started - job.enqueuedAt;
        counters.queueMs += queueMs; counters.maxQueueMs = Math.max(counters.maxQueueMs, queueMs);
        let failed = false, error: unknown;
        try { await job.read(); counters.completed++; }
        catch (caught) { failed = true; error = caught; counters.failed++; }
        finally {
          const finished = performance.now(), elapsed = finished - started;
          counters.readMs += elapsed; counters.maxReadMs = Math.max(counters.maxReadMs, elapsed);
          recordCompletionSample(finished, queueMs, elapsed);
          jobs.delete(key); active--; if (wasBackground) activeBackground--; pump();
        }
        if (failed) job.reject(error); else job.resolve();
      });
    }
  };
  return {
    run(key: string, refresh: HistoryRefreshOptions, read: () => Promise<void>): Promise<void> {
      if (closing) return Promise.reject(new Error('History read scheduler is closed'));
      if (!refresh.readOnly || refresh.fresh) {
        counters.bypassed++;
        const task = Promise.resolve().then(read);
        controls.add(task);
        void task.finally(() => controls.delete(task)).catch(() => {});
        return task;
      }
      const incomingPriority = normalizePriority(refresh.priority);
      const existing = jobs.get(key);
      if (existing) {
        if (incomingPriority < existing.priority) existing.priority = incomingPriority;
        counters.coalesced++;
        return existing.promise;
      }
      // Dynamic load shedding for background preloads (priority >= 4):
      // Reserve queue headroom and concurrency responsiveness for foreground requests (priority <= 0)
      // when backend slots are saturated and queue/latency pressure rises.
      const backgroundQueueCap = maxPending > 4 ? Math.max(1, Math.floor(maxPending * 0.5)) : maxPending;
      const highLatencyUnderLoad = active >= concurrency && (emaReadMs > 450 || emaQueueMs > 350);
      if (incomingPriority >= 4 && active >= concurrency && (pending.length >= backgroundQueueCap || highLatencyUnderLoad)) {
        counters.deferred++;
        counters.lowPriorityShed++;
        return Promise.reject(new HistoryReadDeferred('History background read shed under load'));
      }
      if (active >= concurrency && pending.length >= maxPending) {
        counters.deferred++;
        return Promise.reject(new HistoryReadDeferred('History display read budget is busy'));
      }
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const job: Job = { read, promise, resolve, reject, enqueuedAt: performance.now(), priority: incomingPriority };
      jobs.set(key, job); pending.push([key, job]); counters.admitted++;
      if (incomingPriority < 0) counters.highPriorityAdmitted++;
      pump();
      return promise;
    },
    // Aggregate numeric telemetry only: no session IDs, errors or contents.
    inspect: () => ({
      ...counters,
      active,
      pending: pending.length,
      controls: controls.size,
      recentRps: computeRecentRps(),
      avgReadMs: Math.round(emaReadMs * 100) / 100,
      avgQueueMs: Math.round(emaQueueMs * 100) / 100,
      effectiveConcurrency: concurrency,
    }),
    close: () => closing ??= Promise.allSettled([...jobs.values()].map(job => job.promise).concat([...controls])).then(() => {}),
  };
}
