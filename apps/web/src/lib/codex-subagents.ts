import type { ChatMessage, SessionSummary } from "@agentopsdeck/shared";

type Observation = NonNullable<ChatMessage["codexSubagent"]>;
export type ChildObservation = Omit<Observation["agents"][number], "path"> & {
  action: Observation["action"];
  path?: string | undefined;
  task?: string | undefined;
  firstObservedAt?: number | undefined;
  lastObservedAt?: number | undefined;
  eventCount?: number | undefined;
  history?: ReadonlyArray<{
    action: Observation["action"];
    status: Observation["agents"][number]["status"];
    observedAt?: number | undefined;
    message?: string | undefined;
  }> | undefined;
};

export type SwarmEffortLevel = "idle" | "light" | "moderate" | "high" | "max";

export type SwarmGanttBar = {
  id: string;
  label: string;
  status: ChildObservation["status"];
  offsetPct: number;
  widthPct: number;
  durationSec?: number | undefined;
  eventCount: number;
};

export type ChildEffortMetrics = {
  effortScore: number;
  effortLevel: SwarmEffortLevel;
  spanSeconds: number;
  eventCount: number;
};

export type SwarmCluster = {
  id: string;
  label: string;
  total: number;
  running: number;
  completed: number;
  failed: number;
  effortScore: number;
  effortLevel: SwarmEffortLevel;
  childIds: readonly string[];
};

export type SwarmSummary = {
  total: number;
  running: number;
  pendingInit: number;
  completed: number;
  failed: number;
  interrupted: number;
  completionRatio: number;
  totalObservedSeconds: number;
  maxObservedSeconds: number;
  wallClockSeconds: number;
  parallelismRatio: number;
  totalEvents: number;
  effortLevel: SwarmEffortLevel;
  effortScore: number;
  ganttBars: readonly SwarmGanttBar[];
  clusters: readonly SwarmCluster[];
};

const terminal = new Set(["completed", "errored", "interrupted", "shutdown", "notFound"]);

function extractNativeCodexThreadId(session: SessionSummary): string | undefined {
  const nativeKey = session.sessionRef?.nativeSessionKey;
  if (typeof nativeKey === "string" && nativeKey.startsWith("codex:") && nativeKey.length > 6) {
    return nativeKey.slice(6);
  }
  if (session.sessionKey.startsWith("codex:") && session.sessionKey.length > 6) {
    return session.sessionKey.slice(6);
  }
  return undefined;
}

const activeChildStatuses = new Set<ChildObservation["status"]>(["running", "pendingInit", "unknown"]);

/** Whether any observed child is still active/waiting (or failed/interrupted and needs attention). */
export function hasActiveOrAttentionSubagents(state: {
  readonly children: readonly Pick<ChildObservation, "status">[];
  readonly waiting: boolean;
  readonly active: boolean;
}): boolean {
  if (state.waiting) return true;
  if (!state.children.length) return false;
  if (state.children.some((child) => child.status === "errored" || child.status === "interrupted")) {
    return true;
  }
  return state.active && state.children.some((child) => activeChildStatuses.has(child.status));
}

export function formatSubagentLabel(child: Pick<ChildObservation, "id" | "path">): string {
  const raw = child.path?.trim();
  if (!raw) return child.id;
  const stripped = raw.replace(/^\/root\/+/, "").trim();
  return stripped && stripped !== "/root" ? stripped : child.id;
}

/** Current-turn, already-authorized transcript only. Never queries child sessions. */
export function codexSubagents(session: SessionSummary, messages: readonly ChatMessage[], stale = false) {
  const runtime = session.runtime;
  const current = !stale && runtime?.sync === "current" && runtime.connection === "connected";
  const active = current && ["starting", "running", "waiting"].includes(runtime?.phase ?? "");
  const selfThreadId = extractNativeCodexThreadId(session);
  const rows = messages
    .filter(
      (m) =>
        m.sessionKey === session.sessionKey &&
        m.role === "tool" &&
        !m.parentToolUseId &&
        !!runtime?.turnId &&
        m.turnId === runtime.turnId &&
        m.codexSubagent,
    )
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.toolPhase === "result" ? 1 : 0) - (b.toolPhase === "result" ? 1 : 0));
  const children = new Map<string, ChildObservation>();
  const finished = new Set(rows.filter((m) => m.toolPhase === "result").map((m) => m.toolCallId));
  const seenCallObservationByKey = new Map<
    string,
    {
      action: Observation["action"];
      source: Observation["source"];
      observedAt?: number | undefined;
      status: Observation["agents"][number]["status"];
      path?: string | undefined;
      message?: string | undefined;
      task?: string | undefined;
    }
  >();
  let waiting = false,
    waitObservedAt: number | undefined;
  for (const m of rows) {
    const observation = m.codexSubagent!;
    const at =
      observation.source === "live" && Number.isFinite(observation.observedAt) && observation.observedAt! >= 0
        ? observation.observedAt
        : undefined;
    if (
      active &&
      observation.action === "wait" &&
      m.toolPhase === "call" &&
      m.status === "sending" &&
      !!m.toolCallId &&
      !finished.has(m.toolCallId)
    ) {
      waiting = true;
      if (at !== undefined) waitObservedAt = waitObservedAt === undefined ? at : Math.min(waitObservedAt, at);
    }
    for (const child of observation.agents.slice(0, 32)) {
      if (child.path?.trim() === "/root" || (selfThreadId && child.id === selfThreadId)) {
        continue;
      }
      if (m.toolCallId) {
        const dedupKey = `${m.toolCallId}::${child.id}`;
        if (m.toolPhase === "call") {
          seenCallObservationByKey.set(dedupKey, {
            action: observation.action,
            source: observation.source,
            observedAt: at,
            status: child.status,
            path: child.path,
            message: child.message,
            task: observation.task,
          });
        } else if (m.toolPhase === "result") {
          const callSeen = seenCallObservationByKey.get(dedupKey);
          if (
            callSeen &&
            callSeen.action === observation.action &&
            callSeen.status === child.status &&
            (callSeen.path ?? "") === (child.path ?? "") &&
            (callSeen.message ?? "") === (child.message ?? "") &&
            (callSeen.task ?? "") === (observation.task ?? "") &&
            ((callSeen.source === "history" && observation.source === "history") ||
              (at !== undefined && callSeen.observedAt === at))
          ) {
            continue;
          }
        }
      }
      const previous = children.get(child.id);
      if (!previous && children.size >= 32) continue;
      // New activity after a terminal report is a new observation span, not a
      // continuation of the old execution. Unknown states must replace old ones.
      const reset = previous && terminal.has(previous.status) && !terminal.has(child.status);
      const nextCount = reset ? 1 : (previous?.eventCount ?? 0) + 1;
      const prevHistory = reset ? [] : (previous?.history ?? []);
      const nextHistory = [
        ...prevHistory.slice(-15),
        {
          action: observation.action,
          status: child.status,
          observedAt: at,
          message: child.message,
        },
      ];
      children.set(child.id, {
        ...child,
        action: observation.action,
        path: child.path ?? previous?.path,
        task: observation.task ?? previous?.task,
        firstObservedAt: at === undefined || reset ? at : (previous?.firstObservedAt ?? at),
        lastObservedAt: at,
        eventCount: nextCount,
        history: nextHistory,
      });
    }
  }
  return { children: [...children.values()], waiting, waitObservedAt, current, active };
}

/** Receipt span, deliberately not labelled actual execution time. */
export function observedSpan(child: ChildObservation, active: boolean, now: number) {
  if (child.firstObservedAt === undefined) return undefined;
  const end = active && child.status === "running" ? now : child.lastObservedAt;
  return end === undefined ? undefined : Math.max(0, Math.floor((end - child.firstObservedAt) / 1000));
}

/** Compute per-child dynamic effort intensity (0-100) and level from observed activity span, status, and event transitions. */
export function computeChildEffort(child: ChildObservation, active: boolean, now: number): ChildEffortMetrics {
  const spanSeconds = observedSpan(child, active, now) ?? 0;
  const eventCount = Math.max(1, child.eventCount ?? 1);
  const statusBase =
    child.status === "running"
      ? 45
      : child.status === "pendingInit"
        ? 25
        : child.status === "completed"
          ? 35
          : child.status === "errored" || child.status === "interrupted"
            ? 30
            : 15;
  const spanBonus = Math.min(40, Math.floor(spanSeconds * 2.5));
  const eventBonus = Math.min(20, (eventCount - 1) * 5);
  const effortScore = Math.min(100, Math.max(10, statusBase + spanBonus + eventBonus));
  let effortLevel: SwarmEffortLevel = "light";
  if (effortScore >= 82 || (child.status === "running" && spanSeconds >= 12)) effortLevel = "max";
  else if (effortScore >= 60 || child.status === "running") effortLevel = "high";
  else if (effortScore >= 38 || child.status === "pendingInit") effortLevel = "moderate";
  return { effortScore, effortLevel, spanSeconds, eventCount };
}

function resolveChildClusterKey(child: ChildObservation): { id: string; label: string } {
  const raw = (child.path ? formatSubagentLabel(child) : (child.task ?? child.id)).trim();
  const prefixMatch = /^([a-zA-Z0-9_]+)[-_:/\s]/.exec(raw);
  if (prefixMatch && prefixMatch[1] && prefixMatch[1].length >= 2 && prefixMatch[1].length <= 18) {
    const token = prefixMatch[1].toLocaleLowerCase();
    if (token !== "child" && token !== "agent") {
      return { id: `role:${token}`, label: prefixMatch[1] };
    }
  }
  if (child.status === "running" || child.status === "pendingInit") {
    return { id: "wave:active", label: "Active wave" };
  }
  if (child.status === "completed") {
    return { id: "wave:completed", label: "Completed wave" };
  }
  return { id: "wave:other", label: "Other wave" };
}

/** Compute dynamic swarm effort telemetry, parallelism speedup, and Gantt waterfall bars for a sub-agent group. */
export function computeSwarmSummary(
  children: readonly ChildObservation[],
  active: boolean,
  waiting: boolean,
  now: number,
): SwarmSummary {
  let running = 0;
  let pendingInit = 0;
  let completed = 0;
  let failed = 0;
  let interrupted = 0;
  let totalObservedSeconds = 0;
  let maxObservedSeconds = 0;
  let totalEvents = 0;
  let earliestMs: number | undefined;
  let latestMs: number | undefined;

  for (const child of children) {
    if (child.status === "running") running += 1;
    else if (child.status === "pendingInit") pendingInit += 1;
    else if (child.status === "completed") completed += 1;
    else if (child.status === "errored" || child.status === "notFound") failed += 1;
    else if (child.status === "interrupted" || child.status === "shutdown") interrupted += 1;

    const span = observedSpan(child, active, now);
    if (span !== undefined && span > 0) {
      totalObservedSeconds += span;
      if (span > maxObservedSeconds) maxObservedSeconds = span;
    }
    if (child.firstObservedAt !== undefined) {
      const endMs = active && child.status === "running" ? Math.max(now, child.firstObservedAt) : (child.lastObservedAt ?? child.firstObservedAt);
      earliestMs = earliestMs === undefined ? child.firstObservedAt : Math.min(earliestMs, child.firstObservedAt);
      latestMs = latestMs === undefined ? endMs : Math.max(latestMs, endMs);
    }
    totalEvents += child.eventCount ?? 1;
  }

  const total = children.length;
  const finishedCount = completed + failed + interrupted;
  const completionRatio = total > 0 ? Math.min(1, Math.max(0, finishedCount / total)) : 0;

  const wallClockMs = earliestMs !== undefined && latestMs !== undefined ? Math.max(1000, latestMs - earliestMs) : 0;
  const wallClockSeconds = wallClockMs > 0 ? Math.max(1, Math.floor(wallClockMs / 1000)) : maxObservedSeconds;
  const parallelismRatio =
    wallClockSeconds > 0 && totalObservedSeconds > 0
      ? Math.max(1, Math.round((totalObservedSeconds / wallClockSeconds) * 10) / 10)
      : total > 1 && running > 1
        ? running
        : 1;

  const ganttBars: SwarmGanttBar[] = children.map((child, idx) => {
    const spanSec = observedSpan(child, active, now);
    let offsetPct = 0;
    let widthPct = 100;
    if (earliestMs !== undefined && wallClockMs > 0 && child.firstObservedAt !== undefined) {
      const startMs = Math.max(earliestMs, child.firstObservedAt);
      const endMs = active && child.status === "running" ? Math.max(now, startMs + 500) : Math.max(startMs + 500, child.lastObservedAt ?? startMs + 500);
      offsetPct = Math.min(92, Math.max(0, Math.round(((startMs - earliestMs) / wallClockMs) * 100)));
      widthPct = Math.min(100 - offsetPct, Math.max(8, Math.round(((endMs - startMs) / wallClockMs) * 100)));
    } else if (total > 1) {
      offsetPct = Math.min(75, idx * Math.floor(60 / total));
      widthPct = Math.max(20, 100 - offsetPct);
    }
    return {
      id: child.id,
      label: formatSubagentLabel(child),
      status: child.status,
      offsetPct,
      widthPct,
      durationSec: spanSec,
      eventCount: child.eventCount ?? 1,
    };
  });

  // Dynamic effort score (0 - 100) combining parallelism, active execution, and cumulative observed work
  const activeWorkers = running + pendingInit + (waiting ? 1 : 0);
  const rawScore =
    activeWorkers * 18 +
    total * 8 +
    Math.min(35, Math.floor(totalObservedSeconds / 3)) +
    Math.min(15, totalEvents * 2);
  const effortScore = total === 0 && !waiting ? 0 : Math.min(100, Math.max(10, rawScore));

  let effortLevel: SwarmEffortLevel = "idle";
  if (effortScore >= 80 || running >= 4) effortLevel = "max";
  else if (effortScore >= 55 || running >= 2) effortLevel = "high";
  else if (effortScore >= 30 || running >= 1 || waiting) effortLevel = "moderate";
  else if (total > 0) effortLevel = "light";

  const clusterMap = new Map<string, { label: string; children: ChildObservation[] }>();
  for (const child of children) {
    const key = resolveChildClusterKey(child);
    const entry = clusterMap.get(key.id) ?? { label: key.label, children: [] };
    entry.children.push(child);
    clusterMap.set(key.id, entry);
  }
  const clusters: SwarmCluster[] = [...clusterMap.entries()].map(([id, group]) => {
    let cRunning = 0;
    let cCompleted = 0;
    let cFailed = 0;
    let sumEffort = 0;
    for (const c of group.children) {
      if (c.status === "running" || c.status === "pendingInit") cRunning += 1;
      else if (c.status === "completed") cCompleted += 1;
      else if (c.status === "errored" || c.status === "interrupted" || c.status === "shutdown" || c.status === "notFound") cFailed += 1;
      sumEffort += computeChildEffort(c, active, now).effortScore;
    }
    const avgEffort = group.children.length > 0 ? Math.min(100, Math.round(sumEffort / group.children.length)) : 0;
    let cLevel: SwarmEffortLevel = "light";
    if (avgEffort >= 80 || cRunning >= 2) cLevel = "max";
    else if (avgEffort >= 55 || cRunning >= 1) cLevel = "high";
    else if (avgEffort >= 35) cLevel = "moderate";
    return {
      id,
      label: group.label,
      total: group.children.length,
      running: cRunning,
      completed: cCompleted,
      failed: cFailed,
      effortScore: avgEffort,
      effortLevel: cLevel,
      childIds: group.children.map(c => c.id),
    };
  });

  return {
    total,
    running,
    pendingInit,
    completed,
    failed,
    interrupted,
    completionRatio,
    totalObservedSeconds,
    maxObservedSeconds,
    wallClockSeconds,
    parallelismRatio,
    totalEvents,
    effortLevel,
    effortScore,
    ganttBars,
    clusters,
  };
}
