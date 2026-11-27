import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import {
  Bot,
  ExternalLink,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Search,
} from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { displayTitle, effectiveSessionStatus, formatAgo, matchesSessionSearch, sessionStatusLabel } from '../lib/session-utils';
import { hasQueueBlockingRun } from '../lib/live-session';
import { PaneToolbarScope } from './PaneToolbar';
import { CaptionOverflow } from './CaptionOverflow';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import './workspace-session-hub.css';

type FilterTab = 'all' | 'running' | 'pinned';

function storageKeyFor(scope: string, cardId: string, suffix: string) {
  return `agentopsdeck.session-hub:${JSON.stringify([scope || 'default', cardId, suffix])}`;
}

function readStoredString(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStoredString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Ignore storage quota errors */
  }
}

const HubSessionStage = memo(function HubSessionStage({
  session,
  renderPane,
}: {
  session: SessionSummary;
  renderPane: (session: SessionSummary) => ReactNode;
}) {
  return <>{renderPane(session)}</>;
});

export function filterAndSortHubSessions(
  sessions: readonly SessionSummary[],
  query: string,
  filter: FilterTab,
): SessionSummary[] {
  const filtered = sessions.filter(session => {
    if (session.hidden || session.archived) return false;
    if (filter === 'pinned' && !session.pinned) return false;
    if (filter === 'running') {
      const running = effectiveSessionStatus(session) === 'running' || hasQueueBlockingRun(session);
      if (!running) return false;
    }
    return query.trim() ? matchesSessionSearch(session, query) : true;
  });
  return filtered.sort((left, right) => {
    const pinDiff = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    if (pinDiff !== 0) return pinDiff;
    const leftRunning = effectiveSessionStatus(left) === 'running' || hasQueueBlockingRun(left);
    const rightRunning = effectiveSessionStatus(right) === 'running' || hasQueueBlockingRun(right);
    if (leftRunning !== rightRunning) return Number(rightRunning) - Number(leftRunning);
    return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0);
  });
}

export default function WorkspaceSessionHub({
  scope,
  cardId,
  sessions,
  completedSessionKeys,
  initialSessionKey,
  renderPane,
  onOpenStandalone,
  onCreateSession,
}: {
  scope: string;
  cardId: string;
  sessions: readonly SessionSummary[];
  completedSessionKeys?: ReadonlySet<string> | undefined;
  initialSessionKey?: string | undefined;
  renderPane: (session: SessionSummary) => ReactNode;
  onOpenStandalone?: ((session: SessionSummary) => void) | undefined;
  onCreateSession?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const selectedKeyStorage = storageKeyFor(scope, cardId, 'selected');
  const collapsedStorage = storageKeyFor(scope, cardId, 'sidebar-collapsed');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStoredString(collapsedStorage) === 'true');
  const [selectedKey, setSelectedKey] = useState<string | undefined>(
    () => readStoredString(selectedKeyStorage) ?? initialSessionKey,
  );

  const visibleSessions = useMemo(
    () => filterAndSortHubSessions(sessions, search, filter),
    [sessions, search, filter],
  );

  const allActiveSessions = useMemo(
    () => filterAndSortHubSessions(sessions, '', 'all'),
    [sessions],
  );

  const activeSession = useMemo(() => {
    if (selectedKey) {
      const found = sessions.find(item => item.sessionKey === selectedKey);
      if (found) return found;
    }
    return visibleSessions[0] ?? allActiveSessions[0];
  }, [selectedKey, sessions, visibleSessions, allActiveSessions]);

  const selectSession = useCallback((key: string) => {
    setSelectedKey(key);
    writeStoredString(selectedKeyStorage, key);
  }, [selectedKeyStorage]);

  useEffect(() => {
    if (!selectedKey && activeSession) {
      setSelectedKey(activeSession.sessionKey);
    }
  }, [selectedKey, activeSession]);

  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      writeStoredString(collapsedStorage, String(next));
      return next;
    });
  };

  const runningCount = useMemo(
    () => allActiveSessions.filter(s => effectiveSessionStatus(s) === 'running' || hasQueueBlockingRun(s)).length,
    [allActiveSessions],
  );

  const cardTitle = activeSession
    ? `${t('Multi-session switcher')} · ${displayTitle(activeSession)}`
    : t('Multi-session switcher');

  return (
    <section
      className="workspace-session-hub"
      data-session-hub-card
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      aria-label={t('Multi-session switcher')}
    >
      <ResourceTitle>{cardTitle}</ResourceTitle>
      <ResourceToolbar>
        <ResourceAction
          label={t(sidebarCollapsed ? 'Show session list' : 'Hide session list')}
          aria-pressed={!sidebarCollapsed}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </ResourceAction>
        {onCreateSession && (
          <ResourceAction label={t('New session')} onClick={onCreateSession}>
            <Plus size={15} />
          </ResourceAction>
        )}
        {activeSession && onOpenStandalone && (
          <ResourceAction
            label={t('Pop out to standalone card')}
            onClick={() => onOpenStandalone(activeSession)}
          >
            <ExternalLink size={14} />
          </ResourceAction>
        )}
      </ResourceToolbar>

      <div className="workspace-session-hub-body">
        {!sidebarCollapsed && (
          <aside className="workspace-session-hub-list" aria-label={t('Sessions')}>
            <div className="workspace-session-hub-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                name={`session-hub-search-${cardId}`}
                aria-label={t('Search sessions')}
                placeholder={t('Search sessions')}
                value={search}
                onChange={event => setSearch(event.target.value)}
              />
            </div>

            <div className="workspace-session-hub-filters" role="group" aria-label={t('Filter sessions')}>
              <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                <span>{t('All')}</span>
                <span className="workspace-session-hub-count">{allActiveSessions.length}</span>
              </button>
              <button type="button" aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>
                <span>{t('Running')}</span>
                {runningCount > 0 && <span className="workspace-session-hub-count is-running">{runningCount}</span>}
              </button>
              <button type="button" aria-pressed={filter === 'pinned'} onClick={() => setFilter('pinned')}>
                <span>{t('Pinned')}</span>
              </button>
            </div>

            <div className="workspace-session-hub-items" role="listbox" aria-label={t('Sessions')}>
              {visibleSessions.length === 0 ? (
                <p className="workspace-session-hub-empty-list">{t('No matching sessions')}</p>
              ) : (
                visibleSessions.map(session => {
                  const status = effectiveSessionStatus(session);
                  const isRunning = status === 'running' || hasQueueBlockingRun(session);
                  const isWaiting = status === 'waiting';
                  const isFailed = status === 'failed';
                  const isUnread = Boolean(completedSessionKeys?.has(session.sessionKey));
                  const isActive = activeSession?.sessionKey === session.sessionKey;
                  const runtimeLabel = session.sessionRef?.runtimeId || session.agentId || session.source || t('Session');
                  return (
                    <button
                      key={session.sessionKey}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`workspace-session-hub-item${isActive ? ' is-active' : ''}`}
                      onClick={() => selectSession(session.sessionKey)}
                    >
                      <span className="workspace-session-hub-avatar" aria-hidden="true">
                        <Bot size={14} />
                        {isRunning ? <span className="workspace-session-hub-dot is-running" />
                          : isWaiting ? <span className="workspace-session-hub-dot is-waiting" />
                            : isFailed ? <span className="workspace-session-hub-dot is-failed" />
                              : isUnread ? <span className="workspace-session-hub-dot is-unread" /> : null}
                      </span>
                      <span className="workspace-session-hub-item-body">
                        <span className="workspace-session-hub-item-top">
                          <strong className="workspace-session-hub-item-title">
                            {session.pinned && <Pin size={10} className="workspace-session-hub-pin" aria-hidden="true" />}
                            <span>{displayTitle(session)}</span>
                          </strong>
                          <time>{formatAgo(session.lastActiveAt)}</time>
                        </span>
                        <span className="workspace-session-hub-item-sub">
                          <span className="workspace-session-hub-runtime">{runtimeLabel}</span>
                          <span className="workspace-session-hub-status" data-status={status}>
                            {isRunning ? t('Running') : isWaiting ? t('Waiting') : isUnread ? t('Updated') : sessionStatusLabel(status)}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        )}

        <div className="workspace-session-hub-stage" data-session-key={activeSession?.sessionKey}>
          {activeSession ? (
            <PaneToolbarScope key={activeSession.sessionKey}>
              {(slot, statusSlot, titleSlot) => (
                <>
                  <div className="workspace-session-hub-stage-bar">
                    <div className="workspace-session-hub-stage-title">
                      {titleSlot}
                      <span className="workspace-session-hub-stage-runtime">
                        {activeSession.sessionRef?.runtimeId || activeSession.agentId || activeSession.source || t('Session')}
                      </span>
                    </div>
                    <CaptionOverflow>
                      {statusSlot}
                      {slot}
                    </CaptionOverflow>
                  </div>
                  <div className="workspace-session-hub-stage-body">
                    <HubSessionStage session={activeSession} renderPane={renderPane} />
                  </div>
                </>
              )}
            </PaneToolbarScope>
          ) : (
            <div className="workspace-session-hub-empty-stage">
              <MessageSquare size={28} aria-hidden="true" />
              <strong>{t('No session selected')}</strong>
              <p>{t('Select a session on the left list to chat.')}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
