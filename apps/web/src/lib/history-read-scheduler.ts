import { requestGovernor } from './request-governor.js';

export type ScheduledHistoryRead<T> = { promise: Promise<T>; expedite(): void };
export type HistoryReadSchedule = {
  <T>(read: () => Promise<T>, signal: AbortSignal): Promise<T>;
  expedite(): void;
  priority?: () => number;
};

// Automatic desktop history reads (including resume/live-tail) share this queue
// so reconnecting many panes cannot flood the server. Active panes take priority;
// explicit interactive reads can expedite without duplicating queued work.
export function createHistoryReadScheduler(concurrency: number | (() => number) = 2) {
  const resolveConcurrency = (): number => {
    const raw = typeof concurrency === 'function' ? concurrency() : concurrency;
    if (!Number.isInteger(raw) || raw < 1) throw new Error('Invalid history read concurrency');
    return Math.min(4, raw);
  };
  if (typeof concurrency !== 'function') resolveConcurrency();
  type Job = { priority(): number; start(): void; cancel(): void };
  const queue: Job[] = [];
  let active = 0;
  let dispatches = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = (job: Job) => {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) { clearTimeout(timer); timer = undefined; }
    return index >= 0;
  };
  const arm = () => {
    const limit = resolveConcurrency();
    if (timer !== undefined || !queue.length || active >= limit) return;
    // Batch same-commit mounts and yield between completions instead of draining
    // cached responses in an uninterrupted promise/microtask chain.
    timer = setTimeout(() => {
      timer = undefined;
      const currentLimit = resolveConcurrency();
      while (queue.length && active < currentLimit) {
        let next = queue[0]!;
        // Every fifth automatic dispatch takes the oldest waiting job, so a
        // stream of foreground work cannot indefinitely starve background panes.
        if (++dispatches % 5 !== 0) {
          for (const job of queue) if (job.priority() < next.priority()) next = job;
        }
        next.start();
      }
    }, 0);
  };
  return {
    schedule<T>(task: () => Promise<T>, options: { priority: () => number; signal: AbortSignal }): ScheduledHistoryRead<T> {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      let started = false;
      let finished = false;
      const job: Job = {
        priority: options.priority,
        cancel() {
          if (started || finished) return;
          finished = true;
          remove(job);
          options.signal.removeEventListener('abort', job.cancel);
          reject(new DOMException('History read cancelled', 'AbortError'));
          arm();
        },
        start() {
          if (started || finished) return;
          if (options.signal.aborted) { job.cancel(); return; }
          started = true;
          remove(job);
          options.signal.removeEventListener('abort', job.cancel);
          active++;
          // Keep the slot until the real operation settles, including aborts.
          // The caller retains transport cancellation and snapshot authority.
          const complete = () => { finished = true; active--; arm(); };
          try {
            Promise.resolve(task()).then(value => { complete(); resolve(value); }, error => { complete(); reject(error); });
          } catch (error) { complete(); reject(error); }
        },
      };
      queue.push(job);
      options.signal.addEventListener('abort', job.cancel, { once: true });
      if (options.signal.aborted) job.cancel();
      else arm();
      // Explicit upward navigation can start its already-queued page immediately.
      // It may temporarily exceed the automatic budget; it never duplicates work.
      return { promise, expedite: job.start };
    },
    inspect() {
      return { active, queued: queue.length, concurrency: resolveConcurrency() };
    },
  };
}

export const desktopHistoryReads = createHistoryReadScheduler(() => requestGovernor.effectiveConcurrency());

// A prepared-history read can have several HTTP attempts. Waiting between 202s
// is outside the queue; a foreground join promotes this and subsequent attempts.
export function automaticHistoryReadSchedule(priority: () => number): HistoryReadSchedule {
  let current: { expedite(): void } | undefined;
  let expedited = false;
  const schedule: HistoryReadSchedule = (read, signal) => {
    const job = desktopHistoryReads.schedule(read, { signal, priority });
    current = job;
    if (expedited) job.expedite();
    return job.promise.finally(() => { if (current === job) current = undefined; });
  };
  schedule.expedite = () => { expedited = true; current?.expedite(); };
  schedule.priority = priority;
  return schedule;
}
