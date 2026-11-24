import type { CodexSubagentStep, SessionSummary } from '@agentopsdeck/shared';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  Compass,
  GitFork,
  Loader2,
  Pin,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../lib/i18n';
import { formatElapsedDuration } from '../lib/live-session';
import { displayTitle } from '../lib/session-utils';
import {
  resolveSessionSubagentCompanion,
  type CompanionSubagentChild,
  type SessionSubagentCompanionState,
  type SubagentChildStatus,
} from '../lib/subagent-companion';
import {
  getLiveSessionSnapshot,
  getSubagentLiveStoreRevision,
  subscribeSubagentLiveStore,
} from '../lib/subagent-live-store';

export type WorkspaceSubagentCompanionProps = {
  sessions: readonly SessionSummary[];
  openSessionKeys: readonly string[];
  activeParentSessionKey?: string | undefined;
  preferredSessionKey?: string | undefined;
  onSelectParentSession?: ((session: SessionSummary) => void) | undefined;
  onPinnedChange?: ((pinned: boolean) => void) | undefined;
};

type ParentCompanionEntry = {
  session: SessionSummary;
  state: SessionSubagentCompanionState;
  isOpen: boolean;
  runningCount: number;
};

const statusLabels = {
  pendingInit: 'Child initializing',
  running: 'Child running',
  completed: 'Child completed',
  errored: 'Child failed',
  interrupted: 'Child interrupted',
  shutdown: 'Child shut down',
  notFound: 'Child not found',
  unknown: 'Child status unknown',
} as const satisfies Record<SubagentChildStatus, string>;

function isRunningStatus(status: SubagentChildStatus): boolean {
  return status === 'running' || status === 'pendingInit';
}

function isFailedStatus(status: SubagentChildStatus): boolean {
  return (
    status === 'errored' ||
    status === 'interrupted' ||
    status === 'shutdown' ||
    status === 'notFound'
  );
}

function StepKindIcon({ kind, title }: { kind: CodexSubagentStep['kind']; title: string }) {
  if (kind === 'tool' && title.startsWith('$ ')) return <Terminal size={12} aria-hidden="true" />;
  if (kind === 'tool') return <Wrench size={12} aria-hidden="true" />;
  if (kind === 'reasoning') return <Sparkles size={12} aria-hidden="true" />;
  if (kind === 'assistant') return <Bot size={12} aria-hidden="true" />;
  return <Activity size={12} aria-hidden="true" />;
}

function StepStatusGlyph({ status }: { status: CodexSubagentStep['status'] }) {
  if (status === 'running') {
    return <Loader2 size={12} className="subagent-companion-spin" aria-hidden="true" />;
  }
  if (status === 'error') {
    return <AlertCircle size={12} aria-hidden="true" />;
  }
  return <CheckCircle2 size={12} aria-hidden="true" />;
}

function formatChildDuration(
  child: CompanionSubagentChild,
  parentActive: boolean,
  now: number,
): string | undefined {
  if (child.firstObservedAt === undefined) return undefined;
  const end =
    isRunningStatus(child.status) && parentActive
      ? Math.max(now, child.lastObservedAt ?? child.firstObservedAt)
      : (child.lastObservedAt ?? child.firstObservedAt);
  const seconds = Math.max(0, Math.floor((end - child.firstObservedAt) / 1000));
  return formatElapsedDuration(seconds);
}

export default function WorkspaceSubagentCompanion({
  sessions,
  openSessionKeys,
  activeParentSessionKey,
  preferredSessionKey,
  onSelectParentSession,
  onPinnedChange,
}: WorkspaceSubagentCompanionProps) {
  const { t } = useI18n();
  const revision = useSyncExternalStore(
    subscribeSubagentLiveStore,
    getSubagentLiveStoreRevision,
    getSubagentLiveStoreRevision,
  );
  const [pinnedSessionKey, setPinnedSessionKey] = useState<string | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const entries = useMemo<ParentCompanionEntry[]>(() => {
    void revision;
    const openSet = new Set(openSessionKeys);
    const sessionByKey = new Map(sessions.map((s) => [s.sessionKey, s]));
    const orderedKeys: string[] = [];
    const seen = new Set<string>();

    for (const key of openSessionKeys) {
      if (sessionByKey.has(key) && !seen.has(key)) {
        seen.add(key);
        orderedKeys.push(key);
      }
    }
    for (const s of sessions) {
      if (!seen.has(s.sessionKey)) {
        seen.add(s.sessionKey);
        orderedKeys.push(s.sessionKey);
      }
    }

    const resolved: ParentCompanionEntry[] = [];
    for (const key of orderedKeys) {
      const baseSession = sessionByKey.get(key);
      if (!baseSession) continue;
      const snap = getLiveSessionSnapshot(key, baseSession);
      if (!snap || !snap.messages.length) continue;
      const effectiveSession = snap.session ?? baseSession;
      const companion = resolveSessionSubagentCompanion(effectiveSession, snap.messages, snap.stale);
      if (!companion || (!companion.children.length && !companion.waiting)) continue;
      const runningCount = companion.children.filter((c) => isRunningStatus(c.status)).length;
      resolved.push({
        session: effectiveSession,
        state: companion,
        isOpen: openSet.has(key),
        runningCount,
      });
    }

    resolved.sort((a, b) => {
      if (a.state.hasLiveDispatch !== b.state.hasLiveDispatch) {
        return a.state.hasLiveDispatch ? -1 : 1;
      }
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      return b.state.latestActivityAt - a.state.latestActivityAt;
    });

    return resolved;
  }, [sessions, openSessionKeys, revision]);

  const targetEntry = useMemo<ParentCompanionEntry | undefined>(() => {
    if (!entries.length) return undefined;
    if (pinnedSessionKey) {
      const pinned = entries.find((e) => e.session.sessionKey === pinnedSessionKey);
      if (pinned) return pinned;
    }
    if (activeParentSessionKey) {
      const focused = entries.find((e) => e.session.sessionKey === activeParentSessionKey);
      if (focused && (focused.state.hasLiveDispatch || !entries.some((e) => e.state.hasLiveDispatch))) {
        return focused;
      }
      if (focused && preferredSessionKey === activeParentSessionKey) {
        return focused;
      }
    }
    if (preferredSessionKey) {
      const preferred = entries.find((e) => e.session.sessionKey === preferredSessionKey);
      if (preferred && preferred.state.hasLiveDispatch) return preferred;
    }
    const liveOpen = entries.find((e) => e.isOpen && e.state.hasLiveDispatch);
    if (liveOpen) return liveOpen;
    if (activeParentSessionKey) {
      const focused = entries.find((e) => e.session.sessionKey === activeParentSessionKey);
      if (focused) return focused;
    }
    if (preferredSessionKey) {
      const preferred = entries.find((e) => e.session.sessionKey === preferredSessionKey);
      if (preferred) return preferred;
    }
    return entries[0];
  }, [entries, pinnedSessionKey, activeParentSessionKey, preferredSessionKey]);

  const anyActive = useMemo(
    () => entries.some((e) => e.state.active || e.runningCount > 0 || e.state.waiting),
    [entries],
  );

  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyActive]);

  const isPinned = !!pinnedSessionKey && targetEntry?.session.sessionKey === pinnedSessionKey;

  useEffect(() => {
    onPinnedChange?.(isPinned);
  }, [isPinned, onPinnedChange]);

  if (!targetEntry) {
    return (
      <div className="subagent-companion-root is-empty" data-testid="subagent-companion-empty">
        <div className="subagent-companion-empty-card">
          <div className="subagent-companion-empty-icon">
            <GitFork size={20} aria-hidden="true" />
          </div>
          <h4>{t('Waiting for sub-agent dispatch')}</h4>
          <p>
            {t(
              'Automatically follows Codex and GitHub Copilot parent sessions and displays delegated sub-agent tasks and live execution steps.',
            )}
          </p>
          <div className="subagent-companion-runtime-pills">
            <span className="subagent-runtime-badge is-codex">Codex</span>
            <span className="subagent-runtime-badge is-ghcp">GHCP</span>
          </div>
        </div>
      </div>
    );
  }

  const { session, state, runningCount } = targetEntry;
  const totalCount = state.children.length;
  const completedCount = state.children.filter((c) => c.status === 'completed').length;
  const failedCount = state.children.filter((c) => isFailedStatus(c.status)).length;
  const runtimeBadgeLabel = state.runtimeKind === 'codex' ? 'Codex' : 'GHCP';

  const activeChildFilter =
    selectedChildId && state.children.some((c) => c.id === selectedChildId) ? selectedChildId : null;
  const displayedChildren = activeChildFilter
    ? state.children.filter((c) => c.id === activeChildFilter)
    : state.children;

  return (
    <div
      className="subagent-companion-root"
      data-testid="subagent-companion"
      data-runtime={state.runtimeKind}
      data-live={state.hasLiveDispatch ? 'true' : 'false'}
    >
      <header className="subagent-companion-header">
        <div className="subagent-companion-title-row">
          <div className="subagent-companion-parent-meta">
            <span className={`subagent-runtime-badge is-${state.runtimeKind}`}>
              {runtimeBadgeLabel}
            </span>
            <strong className="subagent-companion-parent-title" title={displayTitle(session)}>
              {displayTitle(session)}
            </strong>
            {state.hasLiveDispatch ? (
              <span className="subagent-companion-live-pill">
                <span className="subagent-companion-live-dot" aria-hidden="true" />
                {t('Running {running}/{total}', { running: runningCount, total: Math.max(totalCount, 1) })}
              </span>
            ) : (
              <span className="subagent-companion-summary-pill">
                {t('Completed {completed}/{total}', { completed: completedCount, total: totalCount })}
                {failedCount > 0 ? ` · ${failedCount} ${t('Child failed')}` : ''}
              </span>
            )}
          </div>
          <div className="subagent-companion-actions">
            <button
              type="button"
              className={`subagent-companion-mode-btn${isPinned ? ' is-pinned' : ' is-following'}`}
              onClick={() =>
                setPinnedSessionKey((prev) =>
                  prev === session.sessionKey ? null : session.sessionKey,
                )
              }
              title={
                isPinned
                  ? t('Click to resume dynamic follow')
                  : t('Click to pin current parent session')
              }
            >
              {isPinned ? <Pin size={12} aria-hidden="true" /> : <Compass size={12} aria-hidden="true" />}
              <span>{isPinned ? t('Pinned to session') : t('Dynamic follow')}</span>
            </button>
            {onSelectParentSession ? (
              <button
                type="button"
                className="subagent-companion-jump-btn"
                onClick={() => onSelectParentSession(session)}
                title={t('Focus parent session')}
              >
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {entries.length > 1 ? (
          <div className="subagent-companion-parent-strip" role="tablist" aria-label={t('Parent sessions')}>
            {entries.map((entry) => {
              const selected = entry.session.sessionKey === session.sessionKey;
              return (
                <button
                  key={entry.session.sessionKey}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`subagent-companion-parent-pill${selected ? ' is-selected' : ''}${
                    entry.state.hasLiveDispatch ? ' is-live' : ''
                  }`}
                  onClick={() => {
                    setPinnedSessionKey(entry.session.sessionKey);
                    setSelectedChildId(null);
                  }}
                >
                  <span className={`subagent-runtime-dot is-${entry.state.runtimeKind}`} />
                  <span className="subagent-companion-parent-pill-label">
                    {displayTitle(entry.session)}
                  </span>
                  <span className="subagent-companion-parent-pill-count">
                    {entry.runningCount > 0
                      ? `${entry.runningCount}/${entry.state.children.length}`
                      : entry.state.children.length}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {totalCount > 1 ? (
          <div className="subagent-companion-child-tabs">
            <button
              type="button"
              className={`subagent-companion-child-chip${activeChildFilter === null ? ' is-active' : ''}`}
              onClick={() => setSelectedChildId(null)}
            >
              {t('All sub-agents')} ({totalCount})
            </button>
            {state.children.map((child) => (
              <button
                key={child.id}
                type="button"
                className={`subagent-companion-child-chip status-${child.status}${
                  activeChildFilter === child.id ? ' is-active' : ''
                }`}
                onClick={() =>
                  setSelectedChildId((prev) => (prev === child.id ? null : child.id))
                }
              >
                <span className={`subagent-status-dot status-${child.status}`} />
                <span>{child.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="subagent-companion-body">
        {!state.current ? (
          <div className="subagent-companion-stale-banner">
            <Clock3 size={12} aria-hidden="true" />
            <span>{t('Sub-agent updates unavailable · last known observations')}</span>
          </div>
        ) : null}

        {displayedChildren.map((child) => {
          const running = isRunningStatus(child.status);
          const failed = isFailedStatus(child.status);
          const duration = formatChildDuration(child, state.active, now);
          const previewText = child.latestText || child.message;
          return (
            <article
              key={child.id}
              className={`subagent-companion-card status-${child.status}${running ? ' is-running' : ''}${
                failed ? ' is-failed' : ''
              }`}
              data-testid="subagent-companion-child"
            >
              <div className="subagent-companion-card-head">
                <div className="subagent-companion-card-ident">
                  <span className={`subagent-status-dot status-${child.status}`} />
                  <strong className="subagent-companion-child-name">{child.label}</strong>
                  <span className={`subagent-companion-status-badge status-${child.status}`}>
                    {t(statusLabels[child.status])}
                  </span>
                </div>
                {duration ? (
                  <span className="subagent-companion-duration">
                    <Clock3 size={11} aria-hidden="true" />
                    {duration}
                  </span>
                ) : null}
              </div>

              {child.task ? (
                <div className="subagent-companion-section">
                  <span className="subagent-companion-section-label">{t('Delegated task')}</span>
                  <p className="subagent-companion-task-text">{child.task}</p>
                </div>
              ) : null}

              {child.currentStep ? (
                <div className="subagent-companion-current-step">
                  <Loader2 size={13} className="subagent-companion-spin" aria-hidden="true" />
                  <div className="subagent-companion-current-step-copy">
                    <span className="subagent-companion-section-label">{t('Current step')}</span>
                    <strong>{child.currentStep}</strong>
                  </div>
                </div>
              ) : null}

              {child.steps.length > 0 ? (
                <div className="subagent-companion-section">
                  <span className="subagent-companion-section-label">
                    {t('Execution steps')} ({child.steps.length})
                  </span>
                  <ol className="subagent-companion-steps">
                    {child.steps.map((step) => (
                      <li
                        key={step.id}
                        className={`subagent-companion-step status-${step.status}`}
                      >
                        <span className="subagent-companion-step-status">
                          <StepStatusGlyph status={step.status} />
                        </span>
                        <span className="subagent-companion-step-kind">
                          <StepKindIcon kind={step.kind} title={step.title} />
                        </span>
                        <div className="subagent-companion-step-main">
                          <span className="subagent-companion-step-title">{step.title}</span>
                          {step.detail ? (
                            <span className="subagent-companion-step-detail">{step.detail}</span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {previewText ? (
                <div className="subagent-companion-section">
                  <span className="subagent-companion-section-label">{t('Live output')}</span>
                  <pre className="subagent-companion-output">{previewText}</pre>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
