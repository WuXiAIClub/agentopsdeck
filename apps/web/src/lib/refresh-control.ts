export type InFlightCoalescer<K> = {
  run<T>(key: K, task: () => Promise<T>): Promise<T>;
  has(key: K): boolean;
};

// A single scoped entry: never reuse metadata across an account, API origin or
// reset generation. Failed reads are not cached; an older completion cannot
// replace a newer scope's entry.
export function createFreshRead<T>() {
  let entry: { key: string; value: Promise<T>; expires: number } | undefined;
  return (key: string, maxAgeMs: number, read: () => Promise<T>): Promise<T> => {
    if (maxAgeMs > 0 && entry?.key === key && entry.expires > Date.now()) return entry.value;
    const next = { key, value: undefined as unknown as Promise<T>, expires: Infinity };
    next.value = read().then(value => {
      next.expires = Date.now() + maxAgeMs;
      return value;
    }, error => {
      if (entry === next) entry = undefined;
      throw error;
    });
    entry = next;
    return next.value;
  };
}

// Events are invalidations, not data. Keep snapshot gates at the application
// boundary; this only coalesces triggers and controls the fallback cadence.
export function createLiveRefresh(options: {
  refresh: (calibration?: boolean) => Promise<unknown>;
  isVisible: () => boolean;
  isConnected: () => boolean;
  fallbackMs: number | ((unchanged: number) => number);
  eventDelayMs: number;
  safetyMs?: number | (() => number);
  alignSafety?: boolean;
  pollWhileConnected?: boolean;
  // Sample at dispatch time: a pane can become foreground/background without
  // remounting its stream subscription or losing its snapshot fence.
  minIntervalMs?: () => number;
}) {
  let stopped = false;
  let inFlight = false;
  let pending = false;
  let failures = 0;
  let unchanged = 0;
  let retryAt = 0;
  let serverRetryAt = 0;
  let boostedAt: number | undefined;
  let lastStartedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let urgent = false;
  let lastPriorityStartedAt = -Infinity;
  let lastWakeAt = -Infinity;
  let priorityQueued = false;
  let connected = options.isConnected();
  let completionWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  const boostDelay = () => {
    const elapsed = boostedAt === undefined ? Infinity : Date.now() - boostedAt;
    return elapsed < 10_000 ? 1_000 : elapsed < 30_000 ? 2_000 : elapsed < 60_000 ? 5_000 : undefined;
  };
  const safetyInterval = () => typeof options.safetyMs === 'function' ? options.safetyMs() : options.safetyMs ?? 60_000;
  const delay = () => {
    if (retryAt > Date.now()) return retryAt - Date.now();
    if (options.pollWhileConnected === false && options.isConnected()) return failures ? 0 : undefined;
    // Transport connectivity is not proof that Connector history is fresh.
    // A command buys a bounded pursuit window, including on a healthy SSE.
    const pursuit = boostDelay();
    if (pursuit !== undefined) return pursuit;
    if (options.isConnected()) {
      const interval = safetyInterval();
      return options.alignSafety && interval >= 60_000 ? interval - Date.now() % interval : interval;
    }
    return typeof options.fallbackMs === 'function' ? options.fallbackMs(unchanged) : options.fallbackMs;
  };
  const arm = () => {
    clearTimeout(timer);
    if (!stopped && !inFlight && options.isVisible()) {
      const interval = delay();
      if (interval === undefined) return;
      // Capture the timer's purpose: the final pursuit tick must not silently
      // turn into a minute-cached calibration when its window expires.
      const calibration = !!options.alignSafety && options.isConnected() && failures === 0 && boostDelay() === undefined && safetyInterval() >= 60_000;
      timer = setTimeout(() => void run(calibration), interval);
    }
  };
  const run = async (calibration = false) => {
    if (stopped || !options.isVisible()) return;
    if (inFlight) { pending = true; return; }
    const remaining = Math.max(retryAt, urgent
      ? completionWaiters.length ? -Infinity : lastPriorityStartedAt + 250
      : lastStartedAt + (options.minIntervalMs?.() ?? 0)) - Date.now();
    if (remaining > 0) {
      clearTimeout(timer);
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => { eventTimer = undefined; void run(); }, remaining);
      return;
    }
    clearTimeout(timer);
    clearTimeout(eventTimer); eventTimer = undefined;
    inFlight = true;
    if (urgent) lastPriorityStartedAt = Date.now();
    urgent = false;
    const waiters = completionWaiters;
    completionWaiters = [];
    lastStartedAt = Date.now();
    pending = false;
    try {
      const result = await options.refresh(calibration);
      if (result === false) throw new Error('Refresh unavailable');
      unchanged = result && typeof result === 'object' && 'changed' in result && result.changed === false ? Math.min(unchanged + 1, 20) : 0;
      failures = 0;
      retryAt = 0;
      serverRetryAt = 0;
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error);
      // A stream of invalidations must not hammer an unavailable history API.
      // Callers retain existing content and own the visible error message.
      failures += 1;
      const hint = error && typeof error === 'object' && 'retryAfterMs' in error ? error.retryAfterMs : undefined;
      const advice = typeof hint === 'number' && Number.isFinite(hint) && hint > 0 ? Math.min(hint, 60_000) : 0;
      if (advice > 0) serverRetryAt = Math.max(serverRetryAt, Date.now() + advice);
      // Stateful history policies cap active failures at 15s too; unrelated
      // fixed-interval consumers retain their existing 30s failure ceiling.
      // Explicit server advice can exceed that ceiling to protect admission.
      const policy = typeof options.fallbackMs === 'function' ? options.fallbackMs(20) : 30_000;
      const ceiling = Number.isFinite(policy) ? Math.max(1_000, Math.min(60_000, policy)) : 30_000;
      retryAt = Date.now() + Math.max(advice, Math.min(ceiling, 1_000 * 2 ** Math.min(failures - 1, 6)));
    }
    finally {
      inFlight = false;
      if (pending) { if (urgent) void run(); else request(); }
      arm();
    }
  };
  const request = () => {
    unchanged = 0;
    if (stopped || !options.isVisible()) return;
    if (inFlight) { pending = true; return; }
    eventTimer ??= setTimeout(() => { eventTimer = undefined; void run(); }, Math.max(options.eventDelayMs,
      retryAt - Date.now(), lastStartedAt + (options.minIntervalMs?.() ?? 0) - Date.now()));
  };
  // User intent/resume is not a stream of ordinary invalidations. Revalidate
  // immediately, with a small duplicate-focus/event budget and no new polling
  // mode. A pre-resume in-flight read cannot satisfy the trailing fresh read.
  const prioritize = () => {
    if (stopped || !options.isVisible()) return;
    unchanged = 0;
    urgent = true;
    // Focus, visibility and catch-up notifications often arrive together.
    // Dispatch once after the synchronous notification burst; an event arriving
    // after that read starts still requires a genuinely fresh trailing read.
    if (priorityQueued) return;
    priorityQueued = true;
    void Promise.resolve().then(() => { priorityQueued = false; return run(); });
  };
  return {
    start: () => void run(),
    request,
    prioritize,
    boost() { boostedAt = Date.now(); prioritize(); arm(); },
    // Completion is a one-shot priority invalidation, not a new polling mode.
    // Bypass ordinary debounce/minimum spacing, never server failure backoff.
    complete(): Promise<void> {
      if (stopped || !options.isVisible()) return Promise.resolve();
      urgent = true;
      const result = new Promise<void>((resolve, reject) => completionWaiters.push({ resolve, reject }));
      void run();
      return result;
    },
    connectionChanged() {
      const next = options.isConnected();
      const resumed = !connected && next;
      connected = next;
      if (resumed) prioritize();
      else arm();
    },
    wake() {
      if (options.isVisible()) {
        if (Date.now() - lastWakeAt < 250) return;
        lastWakeAt = Date.now();
        // Clear client-side transient failure backoff from backgrounding while
        // strictly honoring explicit server Retry-After admission windows.
        if (retryAt > serverRetryAt) {
          retryAt = serverRetryAt;
          if (retryAt <= Date.now()) failures = 0;
        }
        prioritize();
      } else {
        lastWakeAt = -Infinity;
        clearTimeout(timer); clearTimeout(eventTimer); eventTimer = undefined;
      }
    },
    stop() { stopped = true; pending = false; clearTimeout(timer); clearTimeout(eventTimer);
      for (const waiter of completionWaiters) waiter.reject(new DOMException('Refresh stopped', 'AbortError'));
      completionWaiters = []; },
  };
}

export function createInFlightCoalescer<K>(): InFlightCoalescer<K> {
  const inFlight = new Map<K, Promise<unknown>>();
  return {
    run<T>(key: K, task: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) return existing as Promise<T>;
      const request = task().finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
      inFlight.set(key, request);
      return request;
    },
    has(key: K) {
      return inFlight.has(key);
    },
  };
}

export type QueuedRefresh<T> = {
  run(calibration?: boolean): Promise<T>;
  isInFlight(): boolean;
};

export function createQueuedRefresh<T>(task: (calibration?: boolean) => Promise<T>): QueuedRefresh<T> {
  let inFlight: Promise<T> | undefined;
  let queued = false;
  let queuedCalibration = false;

  return {
    run(calibration = false): Promise<T> {
      if (inFlight) {
        queuedCalibration = queued ? queuedCalibration && calibration : calibration;
        queued = true;
        return inFlight;
      }

      inFlight = (async () => {
        let latest: T | undefined;
        try {
          do {
            queued = false;
            latest = await task(calibration);
            calibration = queuedCalibration;
          } while (queued);
          return latest as T;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
    isInFlight() {
      return Boolean(inFlight);
    },
  };
}

export type LatestWinsRunner<T> = {
  run(task: () => Promise<T>, apply: (value: T) => void): Promise<{ value: T; applied: boolean }>;
};

// Fence at the write site, not fetch resolution: callers can wait for unrelated
// requests after the snapshot has arrived. One gate per independently rendered
// lane (session list / selected messages), shared by all its refresh paths.
export function createLatestRequestGate(getScope: () => unknown = () => undefined) {
  let latest = 0;
  return {
    begin(): () => boolean {
      const token = ++latest;
      const scope = getScope();
      return () => token === latest && scope === getScope();
    },
    invalidate() { latest += 1; },
  };
}

export function createLatestWinsRunner<T>(): LatestWinsRunner<T> {
  const gate = createLatestRequestGate();
  return {
    async run(task: () => Promise<T>, apply: (value: T) => void): Promise<{ value: T; applied: boolean }> {
      const current = gate.begin();
      const value = await task();
      if (!current()) return { value, applied: false };
      apply(value);
      return { value, applied: true };
    },
  };
}

type ProjectionCursor = { epoch: string; seq: number };
export function projectionCursor(value: unknown): ProjectionCursor | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^ce1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9]\d{0,15})$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { epoch: match[1]!, seq: Number(match[2]) };
}

// One selected conversation, two watermarks, one refresh listener. Events are
// invalidations only: snapshots still own text and run state. Never compare
// sequence numbers across epochs or confuse a Hub delivery ID with this cursor.
export function createMessageSnapshotGate(getScope: () => unknown = () => undefined, getSelection?: () => string | undefined) {
  const gate = createLatestRequestGate(getScope);
  let resource: string | undefined;
  let resourceScope: unknown;
  let applied: ProjectionCursor | undefined;
  let observed: ProjectionCursor | undefined;
  let observation = 0;
  let sessionCoverage = -1;
  let requestedCatchup = -1;
  let refresh: (() => void) | undefined;
  const invalidate = () => {
    gate.invalidate();
    applied = observed = undefined;
    observation = 0;
    sessionCoverage = -1;
    requestedCatchup = -1;
  };
  return {
    invalidate,
    isCaughtUp() {
      return !observed || sessionCoverage === observation || Boolean(applied && applied.epoch === observed.epoch && applied.seq >= observed.seq);
    },
    subscribe(callback: () => void) {
      refresh = callback;
      return () => { if (refresh === callback) refresh = undefined; };
    },
    observe(value: unknown, sessionKey = resource) {
      if (resource !== sessionKey || (getSelection && getSelection() !== sessionKey)) return false;
      const cursor = projectionCursor(value);
      if (!cursor) { observation += 1; sessionCoverage = -1; return true; } // Legacy invalidation, no invented watermark.
      if (applied?.epoch === cursor.epoch && applied.seq >= cursor.seq) return false;
      if (observed?.epoch === cursor.epoch && observed.seq >= cursor.seq) return false;
      observed = cursor;
      observation += 1;
      return true;
    },
    begin(sessionKey: string) {
      // A late callback from an old selection must not replace the active lane
      // or reacquire write permission after selection/revocation cleanup.
      if (getSelection && getSelection() !== sessionKey) return Object.assign(() => false, { accept: (_value: unknown) => false, acceptSession: () => false });
      const scope = getScope();
      if (resource !== sessionKey || resourceScope !== scope) { invalidate(); resource = sessionKey; resourceScope = scope; }
      const request = gate.begin();
      const requestedObservation = observation;
      const current = () => request() && (!getSelection || getSelection() === sessionKey);
      const catchup = () => {
        if (requestedCatchup !== observation) { requestedCatchup = observation; refresh?.(); }
      };
      return Object.assign(current, {
        // Only a freshly authorized, explicitly verified session page may use
        // this path. It covers invalidations known BEFORE request dispatch,
        // never a global watermark or state/admission authority. A newer event
        // requires a bounded trailing read, including legacy cursorless events.
        acceptSession() {
          if (!current()) return false;
          if (requestedObservation !== observation) { catchup(); return false; }
          sessionCoverage = observation;
          return true;
        },
        accept(value: unknown) {
          if (!current()) return false;
          sessionCoverage = -1;
          const cursor = projectionCursor(value);
          const invalid = value !== undefined && !cursor;
          const regressed = applied && (!cursor || (applied.epoch === cursor.epoch && cursor.seq < applied.seq));
          const behind = observed && (!cursor || cursor.epoch !== observed.epoch || cursor.seq < observed.seq);
          // At most one deferred catch-up per newly observed invalidation. A
          // lagging/unavailable server cannot create a tight self-retry loop.
          if (behind) catchup();
          if (invalid || regressed) return false;
          applied = cursor;
          return true;
        },
      });
    },
  };
}
