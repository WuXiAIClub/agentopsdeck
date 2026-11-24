/** Shared by all Preview batches, not one limiter per HTTP request. No history
 * cache: each delivery must still pass its caller's post-await authority gate. */
export function createWorkspaceReadScheduler(globalLimit?: number, connectorLimit?: number, queueLimit = 64) {
  const baseGlobalLimit = globalLimit ?? 4;
  const baseConnectorLimit = connectorLimit ?? 2;
  const adaptive = globalLimit === undefined && connectorLimit === undefined;
  type Job = {
    connector: string;
    signal: AbortSignal;
    priority: number;
    enqueuedAt: number;
    start: () => Promise<unknown>;
    reject: (error: Error) => void;
    cancel: () => void;
  };
  const queue: Job[] = [], active = new Map<string, number>();
  const recentTimestamps: number[] = [];
  let running = 0, dispatches = 0, admitted = 0, completed = 0, cancelled = 0, rejectedCapacity = 0;
  let emaQueueMs = 0, emaReadMs = 0;
  function recordSample(nowMs: number, queueMs: number, readMs: number) {
    recentTimestamps.push(nowMs);
    const cutoff = nowMs - 10_000;
    while (recentTimestamps.length > 0 && recentTimestamps[0]! < cutoff) recentTimestamps.shift();
    emaQueueMs = emaQueueMs === 0 ? queueMs : emaQueueMs * 0.75 + queueMs * 0.25;
    emaReadMs = emaReadMs === 0 ? readMs : emaReadMs * 0.75 + readMs * 0.25;
  }
  function selectNextIndex(): number {
    dispatches += 1;
    let firstEligible = -1;
    let bestIndex = -1;
    let bestPriority = Infinity;
    const fast = adaptive && completed >= 2 && emaReadMs <= 180 && emaQueueMs <= 60;
    for (let i = 0; i < queue.length; i += 1) {
      const job = queue[i]!;
      const isUrgent = job.priority < 0;
      const effGlobal = adaptive && isUrgent && (fast || running === baseGlobalLimit) ? baseGlobalLimit + 2 : baseGlobalLimit;
      const effConnector = adaptive && isUrgent && (fast || (active.get(job.connector) ?? 0) === baseConnectorLimit) ? baseConnectorLimit + 1 : baseConnectorLimit;
      if (running >= effGlobal || (active.get(job.connector) ?? 0) >= effConnector) continue;
      if (firstEligible < 0) firstEligible = i;
      if (job.priority < bestPriority) {
        bestPriority = job.priority;
        bestIndex = i;
      }
    }
    if (firstEligible < 0) return -1;
    if (dispatches % 5 === 0) return firstEligible;
    return bestIndex >= 0 ? bestIndex : firstEligible;
  }
  function pump() {
    while (queue.length > 0 && running < (adaptive ? baseGlobalLimit + 2 : baseGlobalLimit)) {
      const index = selectNextIndex();
      if (index < 0) break;
      const job = queue.splice(index, 1)[0]!;
      job.signal.removeEventListener('abort', job.cancel);
      if (job.signal.aborted) { cancelled++; job.reject(new Error('Workspace read cancelled')); continue; }
      running++; active.set(job.connector, (active.get(job.connector) ?? 0) + 1);
      const started = performance.now(), queueMs = started - job.enqueuedAt;
      void job.start().finally(() => {
        const finished = performance.now();
        completed++;
        recordSample(finished, queueMs, finished - started);
        running--;
        const left = (active.get(job.connector) ?? 1) - 1;
        if (left) active.set(job.connector, left); else active.delete(job.connector);
        pump();
      });
    }
  }
  return {
    read<T>(connector: string, signal: AbortSignal, task: () => Promise<T>, priority = 0): Promise<T> {
      if (signal.aborted) { cancelled++; return Promise.reject(new Error('Workspace read cancelled')); }
      if (queue.length >= queueLimit) { rejectedCapacity++; return Promise.reject(new Error('Workspace read capacity exceeded')); }
      const normalizedPriority = typeof priority === 'number' && Number.isFinite(priority) ? Math.max(-10, Math.min(20, Math.trunc(priority))) : 0;
      admitted++;
      return new Promise<T>((resolve, reject) => {
        const job: Job = {
          connector,
          signal,
          priority: normalizedPriority,
          enqueuedAt: performance.now(),
          reject,
          start: async () => { try { resolve(await task()); } catch (error) { reject(error); } },
          cancel: () => {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            cancelled++;
            reject(new Error('Workspace read cancelled'));
            pump();
          },
        };
        queue.push(job); signal.addEventListener('abort', job.cancel, { once: true }); pump();
      });
    },
    inspect() {
      const nowMs = performance.now(), cutoff = nowMs - 10_000;
      while (recentTimestamps.length > 0 && recentTimestamps[0]! < cutoff) recentTimestamps.shift();
      return {
        running,
        queued: queue.length,
        admitted,
        completed,
        cancelled,
        rejectedCapacity,
        recentRps: Math.round((recentTimestamps.length / 10) * 100) / 100,
        avgQueueMs: Math.round(emaQueueMs * 100) / 100,
        avgReadMs: Math.round(emaReadMs * 100) / 100,
      };
    },
  };
}
