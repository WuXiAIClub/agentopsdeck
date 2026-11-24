import type { ChatMessage, SessionSummary } from "@agentopsdeck/shared";
import { useMemo, useState } from "react";
import {
  codexSubagents,
  computeChildEffort,
  computeSwarmSummary,
  formatSubagentLabel,
  hasActiveOrAttentionSubagents,
  observedSpan,
  type SwarmEffortLevel,
} from "../lib/codex-subagents";
import { formatElapsedDuration } from "../lib/live-session";
import { requestOpenSubagentCompanion } from "../lib/subagent-companion";
import { useI18n } from "../lib/i18n";

const statuses = {
  pendingInit: "Child initializing",
  running: "Child running",
  interrupted: "Child interrupted",
  completed: "Child completed",
  errored: "Child failed",
  shutdown: "Child shut down",
  notFound: "Child not found",
  unknown: "Child status unknown",
} as const;

const actions = {
  spawnAgent: "Child spawn requested",
  sendInput: "Child input sent",
  resumeAgent: "Child resume requested",
  wait: "Child wait observed",
  closeAgent: "Child close requested",
  started: "Child start observed",
  interacted: "Child interaction observed",
  interrupted: "Child interruption observed",
} as const;

const effortLabels = {
  idle: "Swarm idle",
  light: "Light effort",
  moderate: "Moderate effort",
  high: "High effort",
  max: "Max swarm effort",
} as const satisfies Record<SwarmEffortLevel, string>;

type SwarmViewMode = "cards" | "topology" | "gantt";
type SwarmStatusFilter = "all" | "running" | "completed" | "failed";

export function SessionSubagents({
  session,
  messages,
  stale,
  now,
}: {
  session: SessionSummary;
  messages: readonly ChatMessage[];
  stale: boolean;
  now: number;
}) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<SwarmViewMode>("cards");
  const [statusFilter, setStatusFilter] = useState<SwarmStatusFilter>("all");
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | undefined>(undefined);

  const nowBucket = Math.floor(now / 1000) * 1000;
  const state = useMemo(() => codexSubagents(session, messages, stale), [session, messages, stale]);
  const summary = useMemo(
    () => computeSwarmSummary(state.children, state.active, state.waiting, nowBucket),
    [state.children, state.active, state.waiting, nowBucket],
  );
  const activeCluster = useMemo(
    () => summary.clusters.find((cl) => cl.id === selectedClusterId) ?? null,
    [summary.clusters, selectedClusterId],
  );

  const filteredChildren = useMemo(() => {
    const clusterSet = activeCluster ? new Set(activeCluster.childIds) : null;
    const baseList = clusterSet ? state.children.filter((c) => clusterSet.has(c.id)) : state.children;
    if (statusFilter === "all") return baseList;
    if (statusFilter === "running") {
      return baseList.filter((c) => c.status === "running" || c.status === "pendingInit");
    }
    if (statusFilter === "completed") {
      return baseList.filter((c) => c.status === "completed");
    }
    return baseList.filter(
      (c) => c.status === "errored" || c.status === "interrupted" || c.status === "shutdown" || c.status === "notFound",
    );
  }, [state.children, statusFilter, activeCluster]);

  const selectedChild = useMemo(
    () => state.children.find((c) => c.id === selectedChildId) ?? state.children[0],
    [state.children, selectedChildId],
  );

  if (!hasActiveOrAttentionSubagents(state)) return null;
  const waitingSeconds =
    state.waitObservedAt === undefined ? undefined : Math.max(0, Math.floor((now - state.waitObservedAt) / 1000));
  const completionPct = Math.round(summary.completionRatio * 100);

  return (
    <details
      className="goal-pause-notice subagent-notice"
      data-subagent-waiting={state.waiting}
      data-swarm-effort={summary.effortLevel}
    >
      <summary>
        <span>
          {t(state.waiting ? "Waiting for sub-agents" : "Sub-agent observations")}
          {state.children.length ? ` · ${state.children.length}` : ""}
          {state.waiting
            ? ` · ${waitingSeconds === undefined ? t("Duration unknown") : formatElapsedDuration(waitingSeconds)}`
            : ""}
        </span>
        {summary.total > 0 ? (
          <span className={`subagent-effort-pill effort-${summary.effortLevel}`}>
            {t(effortLabels[summary.effortLevel])} · {summary.running}/{summary.total}
            {summary.parallelismRatio > 1 ? ` · ${summary.parallelismRatio}x` : ""}
          </span>
        ) : null}
        <button
          type="button"
          className="subagent-inline-open-btn"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            requestOpenSubagentCompanion(session.sessionKey);
          }}
        >
          {t("Open companion")}
        </button>
      </summary>
      {!state.current ? <p>{t("Sub-agent updates unavailable · last known observations")}</p> : null}
      {summary.total > 0 ? (
        <div className="subagent-swarm-telemetry" data-testid="subagent-swarm-telemetry">
          <div className="subagent-swarm-telemetry-row">
            <span className="subagent-swarm-stat">
              {t("Swarm effort")}: <strong>{summary.effortScore}%</strong> ({t(effortLabels[summary.effortLevel])})
            </span>
            <span className="subagent-swarm-stat">
              {t("Progress")}: <strong>{completionPct}%</strong> ({summary.completed}/{summary.total})
            </span>
            {summary.parallelismRatio > 1 ? (
              <span className="subagent-swarm-stat">
                {t("Parallel speedup")}: <strong>{`${summary.parallelismRatio}x`}</strong>
              </span>
            ) : null}
            {summary.totalObservedSeconds > 0 ? (
              <span className="subagent-swarm-stat">
                {t("Cumulative span")}: <strong>{formatElapsedDuration(summary.totalObservedSeconds)}</strong>
              </span>
            ) : null}
          </div>
          <div
            className="subagent-effort-meter"
            role="progressbar"
            aria-valuenow={summary.effortScore}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`subagent-effort-meter-fill effort-${summary.effortLevel}`}
              style={{ width: `${Math.max(6, summary.effortScore)}%` }}
            />
          </div>

          <div className="subagent-swarm-controls">
            <div className="subagent-lane-matrix">
              {state.children.map((child, idx) => {
                const isSelected = selectedChild?.id === child.id;
                const label = formatSubagentLabel(child);
                return (
                  <button
                    key={child.id}
                    type="button"
                    className={`subagent-lane-node status-${child.status}${isSelected ? " is-selected" : ""}`}
                    title={`${label} · ${t(statuses[child.status])}`}
                    onClick={() => setSelectedChildId(child.id)}
                  >
                    #{idx + 1}
                  </button>
                );
              })}
            </div>

            <div className="subagent-view-switcher" role="group" aria-label={t("Swarm visualization mode")}>
              <button
                type="button"
                className={viewMode === "cards" ? "is-active" : undefined}
                onClick={() => setViewMode("cards")}
              >
                {t("Agent cards")}
              </button>
              <button
                type="button"
                className={viewMode === "topology" ? "is-active" : undefined}
                onClick={() => setViewMode("topology")}
              >
                {t("Swarm topology")}
              </button>
              <button
                type="button"
                className={viewMode === "gantt" ? "is-active" : undefined}
                onClick={() => setViewMode("gantt")}
              >
                {t("Gantt timeline")}
              </button>
            </div>
          </div>

          <div className="subagent-filter-pills" role="group" aria-label={t("Filter sub-agents")}>
            <button
              type="button"
              className={statusFilter === "all" ? "is-active" : undefined}
              onClick={() => setStatusFilter("all")}
            >
              {t("All items")} ({summary.total})
            </button>
            <button
              type="button"
              className={statusFilter === "running" ? "is-active" : undefined}
              onClick={() => setStatusFilter("running")}
            >
              {t("Running")} ({summary.running + summary.pendingInit})
            </button>
            <button
              type="button"
              className={statusFilter === "completed" ? "is-active" : undefined}
              onClick={() => setStatusFilter("completed")}
            >
              {t("Completed")} ({summary.completed})
            </button>
            {summary.failed + summary.interrupted > 0 ? (
              <button
                type="button"
                className={statusFilter === "failed" ? "is-active" : undefined}
                onClick={() => setStatusFilter("failed")}
              >
                {t("Failed")} ({summary.failed + summary.interrupted})
              </button>
            ) : null}
          </div>

          {summary.clusters.length > 1 ? (
            <div className="subagent-cluster-bar" role="group" aria-label={t("Sub-agent groups")} data-testid="subagent-cluster-bar">
              <button
                type="button"
                className={`subagent-cluster-chip${selectedClusterId === null ? " is-active" : ""}`}
                onClick={() => setSelectedClusterId(null)}
              >
                <span>{t("All groups")}</span>
                <small>{summary.total}</small>
              </button>
              {summary.clusters.map((cluster) => (
                <button
                  key={cluster.id}
                  type="button"
                  className={`subagent-cluster-chip effort-${cluster.effortLevel}${selectedClusterId === cluster.id ? " is-active" : ""}`}
                  onClick={() => setSelectedClusterId((prev) => (prev === cluster.id ? null : cluster.id))}
                >
                  <span>{cluster.label}</span>
                  <small>
                    {cluster.running > 0 ? `${cluster.running}⚡/` : ""}{cluster.total} · {cluster.effortScore}%
                  </small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {viewMode === "topology" && state.children.length > 0 ? (
        <div className="subagent-topology-panel" data-testid="subagent-topology-panel">
          <svg
            className="subagent-topology-svg"
            viewBox={`0 0 600 ${Math.max(120, state.children.length * 42 + 24)}`}
            role="img"
            aria-label={t("Swarm topology")}
          >
            <g className="subagent-topology-root">
              <rect x="16" y={Math.max(36, (state.children.length * 42) / 2 - 14)} width="128" height="34" rx="8" />
              <text x="80" y={Math.max(36, (state.children.length * 42) / 2 - 14) + 21} textAnchor="middle">
                {t("Parent coordinator")}
              </text>
            </g>
            {state.children.map((child, idx) => {
              const cy = 28 + idx * 42;
              const rootY = Math.max(36, (state.children.length * 42) / 2 - 14) + 17;
              const isSelected = selectedChild?.id === child.id;
              const label = formatSubagentLabel(child);
              return (
                <g
                  key={child.id}
                  className={`subagent-topology-child status-${child.status}${isSelected ? " is-selected" : ""}`}
                  onClick={() => setSelectedChildId(child.id)}
                  style={{ cursor: "pointer" }}
                >
                  <path
                    className={`subagent-topology-edge status-${child.status}`}
                    d={`M 144 ${rootY} C 210 ${rootY}, 210 ${cy}, 276 ${cy}`}
                    fill="none"
                  />
                  <rect x="276" y={cy - 15} width="304" height="30" rx="7" />
                  <circle cx="292" cy={cy} r="5" className={`subagent-topology-dot status-${child.status}`} />
                  <text x="306" y={cy + 4} className="subagent-topology-label">
                    #{`${idx + 1} ${label.slice(0, 28)}`}
                  </text>
                  <text x="568" y={cy + 4} textAnchor="end" className="subagent-topology-meta">
                    {t(statuses[child.status])}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : null}

      {viewMode === "gantt" && summary.ganttBars.length > 0 ? (
        <div className="subagent-gantt-panel" data-testid="subagent-gantt-panel">
          {summary.ganttBars.map((bar, idx) => {
            const isSelected = selectedChild?.id === bar.id;
            return (
              <div
                key={bar.id}
                className={`subagent-gantt-row${isSelected ? " is-selected" : ""}`}
                onClick={() => setSelectedChildId(bar.id)}
              >
                <div className="subagent-gantt-label" title={bar.label}>
                  <strong>#{idx + 1}</strong> <span>{bar.label}</span>
                </div>
                <div className="subagent-gantt-track">
                  <div
                    className={`subagent-gantt-bar status-${bar.status}`}
                    style={{ left: `${bar.offsetPct}%`, width: `${bar.widthPct}%` }}
                  />
                </div>
                <div className="subagent-gantt-span">
                  {bar.durationSec !== undefined ? formatElapsedDuration(bar.durationSec) : "—"} · ×{bar.eventCount}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="subagent-observations">
        {filteredChildren.map((child) => {
          const seconds = observedSpan(child, state.active, now);
          const childEffort = computeChildEffort(child, state.active, now);
          const label = formatSubagentLabel(child);
          const childProgress =
            child.status === "completed"
              ? 100
              : child.status === "running"
                ? Math.max(childEffort.effortScore, Math.min(92, 25 + Math.min(65, (seconds ?? 1) * 4)))
                : child.status === "pendingInit"
                  ? Math.max(18, childEffort.effortScore)
                  : 100;
          const isSelected = selectedChild?.id === child.id;
          return (
            <section
              key={child.id}
              data-child-status={child.status}
              data-child-effort={childEffort.effortLevel}
              className={`subagent-child-card status-${child.status}${isSelected ? " is-selected" : ""}`}
              onClick={() => setSelectedChildId(child.id)}
            >
              <div className="subagent-child-header">
                <strong className="subagent-child-title" title={child.path ?? child.id}>{label}</strong>
                <span className="subagent-child-badges">
                  <span className={`subagent-child-effort-badge effort-${childEffort.effortLevel}`} title={t(effortLabels[childEffort.effortLevel])}>
                    {t("Effort")} {childEffort.effortScore}%
                  </span>
                  {child.eventCount && child.eventCount > 1 ? (
                    <span className="subagent-child-events">×{child.eventCount}</span>
                  ) : null}
                </span>
              </div>
              <div className="subagent-child-progress-track">
                <div className={`subagent-child-progress-fill status-${child.status} effort-${childEffort.effortLevel}`} style={{ width: `${childProgress}%` }} />
              </div>
              <div>
                {t("Last reported state")}: {t(statuses[child.status])}
              </div>
              <div>{t(actions[child.action])}</div>
              <div>
                {seconds === undefined ? t("Duration unknown") : `${t("Observed activity span")}: ${formatElapsedDuration(seconds)}`}
              </div>
              {child.task ? (
                <div>
                  {t("Delegated task")}: {child.task}
                </div>
              ) : null}
              {child.message ? (
                <div>
                  {t("Last agent report")}: {child.message}
                </div>
              ) : null}
              {isSelected && child.history && child.history.length > 1 ? (
                <div className="subagent-child-history">
                  <small>{t("Observation history")} ({child.history.length})</small>
                  <ul>
                    {child.history.slice(-5).map((item, hIdx) => (
                      <li key={hIdx}>
                        <span>{t(actions[item.action])}</span> · <span>{t(statuses[item.status])}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <p>
        {t(
          "Loaded observations only, not a complete child inventory. Timing starts when activity is observed, not when execution actually starts. A finished wait does not mean children stopped.",
        )}
      </p>
    </details>
  );
}
