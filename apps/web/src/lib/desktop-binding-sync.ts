export type DesktopBindingResourceKind = 'notebook' | 'taskboard';

export type BindingSessionProjectionInput = {
  state?: string | undefined;
  problem?: unknown;
  sessionId?: string | undefined;
  sessionIds?: string[] | undefined;
} | null | undefined;

export function extractBindingSessionIds(binding: BindingSessionProjectionInput): string[] {
  if (!binding || binding.state !== 'active' || binding.problem) return [];
  const set = new Set<string>();
  if (typeof binding.sessionId === 'string' && binding.sessionId) set.add(binding.sessionId);
  if (Array.isArray(binding.sessionIds)) {
    for (const s of binding.sessionIds) {
      if (typeof s === 'string' && s) set.add(s);
    }
  }
  return [...set];
}

export function sameSessionIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const prev = a ?? [];
  if (prev.length !== b.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== b[i]) return false;
  }
  return true;
}

export function updateBindingMap(
  prev: Record<string, string[]>,
  id: string,
  sessionIds: readonly string[],
): Record<string, string[]> {
  if (sessionIds.length === 0) {
    if (!(id in prev)) return prev;
    const next = { ...prev };
    delete next[id];
    return next;
  }
  if (sameSessionIds(prev[id], sessionIds)) return prev;
  return { ...prev, [id]: [...sessionIds] };
}

export function pruneBindingMap(
  prev: Record<string, string[]>,
  allowedIds: ReadonlySet<string>,
): Record<string, string[]> {
  let changed = false;
  for (const key of Object.keys(prev)) {
    if (!allowedIds.has(key)) {
      changed = true;
      break;
    }
  }
  if (!changed) return prev;
  const next: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(prev)) {
    if (allowedIds.has(key)) next[key] = val;
  }
  return next;
}

export type DesktopBindingSyncOptions = {
  notebookIds: readonly string[];
  taskboardIds: readonly string[];
  readNotebook: (id: string, signal: AbortSignal) => Promise<string[]>;
  readTaskboard: (id: string, signal: AbortSignal) => Promise<string[]>;
  onNotebook: (id: string, sessionIds: string[]) => void;
  onTaskboard: (id: string, sessionIds: string[]) => void;
  isHidden?: () => boolean;
  isMessageLoadBusy?: () => boolean;
  getConcurrency?: () => number;
  coalesceMs?: number;
  busyDeferSliceMs?: number;
  maxBusyDeferMs?: number;
  now?: () => number;
  scheduleTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

type Entry = {
  kind: DesktopBindingResourceKind;
  id: string;
  dirty: boolean;
  inFlight: boolean;
  appliedRevision: number;
  targetRevision: number;
  lastFailed: boolean;
};

export function createDesktopBindingSync(options: DesktopBindingSyncOptions) {
  const now = options.now ?? Date.now;
  const coalesceMs = options.coalesceMs ?? 80;
  const busyDeferSliceMs = options.busyDeferSliceMs ?? 120;
  const maxBusyDeferMs = options.maxBusyDeferMs ?? 1500;
  const setTimer = options.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  const controller = new AbortController();
  const entries = new Map<string, Entry>();
  const order: Entry[] = [];

  const register = (kind: DesktopBindingResourceKind, id: string) => {
    const key = `${kind}:${id}`;
    if (entries.has(key)) return;
    const entry: Entry = {
      kind,
      id,
      dirty: true,
      inFlight: false,
      appliedRevision: -1,
      targetRevision: 0,
      lastFailed: false,
    };
    entries.set(key, entry);
    order.push(entry);
  };

  for (const id of options.notebookIds) {
    if (id) register('notebook', id);
  }
  for (const id of options.taskboardIds) {
    if (id) register('taskboard', id);
  }

  let disposed = false;
  let activeCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDueAt = Infinity;
  let deferStartedAt: number | undefined;

  const syncResources = (nextNotebookIds: readonly string[], nextTaskboardIds: readonly string[]) => {
    if (disposed) return;
    const nextKeys = new Set<string>();
    let added = false;
    for (const id of nextNotebookIds) {
      if (!id) continue;
      const key = `notebook:${id}`;
      nextKeys.add(key);
      if (!entries.has(key)) {
        register('notebook', id);
        added = true;
      }
    }
    for (const id of nextTaskboardIds) {
      if (!id) continue;
      const key = `taskboard:${id}`;
      nextKeys.add(key);
      if (!entries.has(key)) {
        register('taskboard', id);
        added = true;
      }
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const entry = order[i]!;
      const key = `${entry.kind}:${entry.id}`;
      if (!nextKeys.has(key)) {
        entries.delete(key);
        order.splice(i, 1);
      }
    }
    if (added) schedule(coalesceMs);
  };

  const resolveConcurrency = (): number => {
    const raw = options.getConcurrency?.() ?? 2;
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(2, Math.floor(raw));
  };

  const hasDirtyPending = (): boolean => {
    for (const entry of order) {
      if (entry.dirty && !entry.inFlight) return true;
    }
    return false;
  };

  const schedule = (delayMs: number) => {
    if (disposed || !hasDirtyPending()) return;
    const due = now() + Math.max(0, delayMs);
    if (timer !== undefined) {
      if (due >= timerDueAt) return;
      cancelTimer(timer);
      timer = undefined;
    }
    timerDueAt = due;
    timer = setTimer(() => {
      timer = undefined;
      timerDueAt = Infinity;
      drain();
    }, Math.max(0, delayMs));
  };

  const launch = (entry: Entry) => {
    entry.inFlight = true;
    entry.dirty = false;
    const attemptRevision = entry.targetRevision;
    activeCount += 1;

    const readPromise = entry.kind === 'notebook'
      ? options.readNotebook(entry.id, controller.signal)
      : options.readTaskboard(entry.id, controller.signal);

    Promise.resolve(readPromise).then(
      (sessionIds) => {
        if (disposed || controller.signal.aborted || !entries.has(`${entry.kind}:${entry.id}`)) return;
        entry.lastFailed = false;
        // Never advance appliedRevision below the revision that triggered or
        // arrived before this completed read; if an initial read started with
        // attemptRevision === 0 and SSE snapshot revision R arrived in-flight
        // without a newer write, we do one follow-up only if targetRevision > 0,
        // or adopt seeded revision if set before launch.
        entry.appliedRevision = Math.max(entry.appliedRevision, attemptRevision);
        if (entry.kind === 'notebook') options.onNotebook(entry.id, sessionIds);
        else options.onTaskboard(entry.id, sessionIds);
        if (entry.targetRevision > entry.appliedRevision) {
          entry.dirty = true;
        }
      },
      () => {
        if (disposed || controller.signal.aborted || !entries.has(`${entry.kind}:${entry.id}`)) return;
        entry.lastFailed = true;
        if (entry.targetRevision > attemptRevision) {
          entry.dirty = true;
        }
      },
    ).finally(() => {
      entry.inFlight = false;
      activeCount = Math.max(0, activeCount - 1);
      if (!disposed) {
        if (entry.dirty && entries.has(`${entry.kind}:${entry.id}`)) schedule(coalesceMs);
        else drain();
      }
    });
  };

  const drain = () => {
    if (disposed || !hasDirtyPending()) {
      deferStartedAt = undefined;
      return;
    }
    if (options.isHidden?.()) return;
    if (options.isMessageLoadBusy?.()) {
      const currentNow = now();
      if (deferStartedAt === undefined) deferStartedAt = currentNow;
      const elapsed = currentNow - deferStartedAt;
      if (elapsed < maxBusyDeferMs) {
        schedule(Math.min(busyDeferSliceMs, maxBusyDeferMs - elapsed));
        return;
      }
    }
    deferStartedAt = undefined;
    const limit = resolveConcurrency();
    for (const entry of order) {
      if (activeCount >= limit) break;
      if (!entry.dirty || entry.inFlight) continue;
      launch(entry);
    }
  };

  return {
    start() {
      schedule(coalesceMs);
    },
    updateResources(nextNotebookIds: readonly string[], nextTaskboardIds: readonly string[]) {
      syncResources(nextNotebookIds, nextTaskboardIds);
    },
    refreshAll() {
      if (disposed) return;
      for (const entry of order) {
        entry.targetRevision = Math.max(entry.targetRevision, entry.appliedRevision) + 1;
        entry.dirty = true;
      }
      schedule(coalesceMs);
    },
    notify(kind: DesktopBindingResourceKind, id: string, revision?: number) {
      if (disposed) return;
      const entry = entries.get(`${kind}:${id}`);
      if (!entry) return;
      // When an initial baseline read (appliedRevision === 0, !lastFailed) has
      // already completed and SSE delivers its first level-triggered revision
      // snapshot right after mount, adopt that baseline revision without firing
      // a duplicate second HTTP GET unless the entry was dirtied or failed.
      if (
        revision !== undefined
        && Number.isSafeInteger(revision)
        && entry.appliedRevision === 0
        && entry.targetRevision === 0
        && !entry.dirty
        && !entry.inFlight
        && !entry.lastFailed
      ) {
        entry.appliedRevision = revision;
        entry.targetRevision = revision;
        return;
      }
      if (
        revision !== undefined
        && Number.isSafeInteger(revision)
        && revision <= entry.appliedRevision
        && !entry.dirty
        && !entry.lastFailed
      ) {
        return;
      }
      if (revision !== undefined && Number.isSafeInteger(revision) && revision > entry.targetRevision) {
        // Also avoid scheduling a redundant second read when the initial baseline
        // read is currently in-flight at attemptRevision === 0 and SSE delivers its
        // initial snapshot: wait; actually if SSE delivers while in-flight, the
        // write might have happened right after the GET hit Hub, so keeping
        // targetRevision = revision when inFlight is safe, OR only if appliedRevision >= 0.
        entry.targetRevision = revision;
      } else if (revision === undefined && (!entry.dirty || entry.inFlight)) {
        entry.targetRevision = Math.max(entry.targetRevision, entry.appliedRevision) + 1;
      }
      entry.dirty = true;
      schedule(coalesceMs);
    },
    resume() {
      if (disposed) return;
      deferStartedAt = undefined;
      schedule(0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        cancelTimer(timer);
        timer = undefined;
      }
      controller.abort();
    },
    inspect() {
      let dirty = 0;
      for (const entry of order) {
        if (entry.dirty) dirty += 1;
      }
      return { active: activeCount, dirty, total: order.length };
    },
  };
}
