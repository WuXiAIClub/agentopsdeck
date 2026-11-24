import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '@agentopsdeck/shared';
import { ArrowUpRight, Check, Copy, ExternalLink, Filter, Pin, PinOff, Search, Tag } from 'lucide-react';
import { handleContextMenuKeyDown, useContextMenuPosition } from '../lib/context-menu-position';
import { useI18n } from '../lib/i18n';
import { displayTitle } from '../lib/session-utils';
import { sessionTokenMetrics } from '../lib/session-token-metrics';
import { overviewLabel, overviewSessions, overviewState, summarizeDashboardTokens, type OverviewState, type DashboardTokenDimension } from '../lib/workspace-dashboard';
import { useFileCardSettings } from '../lib/workspace-file-card-context';
import { useWorkspacePreferences } from './WorkspacePreferences';
import { parseSavedLayouts, savedLayoutKey } from '../lib/saved-layouts';
import { recoveryScope } from '../api';
import type { WorkspaceFileCard } from '@agentopsdeck/shared';
import { ResourceTitle, ResourceToolbar } from './ResourceToolbar';

const states: OverviewState[] = ['run', 'completed', 'attention', 'idle'];
const labels = { run: 'Run', completed: 'Done', attention: 'Needs attention', idle: 'Idle' } as const;
const PAGE_SIZE = 30;

/** Deliberately read-only and bounded. Uses the parent's authorized directory;
 * no effects, independent polling, message reads, or agent commands. */
export const WorkspaceDashboard = memo(function WorkspaceDashboard({ sessions, onSelect }: { sessions: SessionSummary[]; onSelect: (session: SessionSummary) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<OverviewState | null>(null);
  const [page, setPage] = useState(0);
  const [dimension, setDimension] = useState<DashboardTokenDimension>('agent');
  const { value: preferences, change: updatePreferences } = useWorkspacePreferences();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; session: SessionSummary; title: string; state: OverviewState } | null>(null);
  const [copiedHint, setCopiedHint] = useState<string | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useContextMenuPosition(Boolean(ctxMenu), ctxMenu, ctxMenuRef, { autoFocus: true });

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);
  const [savedLayoutsRev, setSavedLayoutsRev] = useState(0);
  useEffect(() => {
    const bump = () => setSavedLayoutsRev((r) => r + 1);
    window.addEventListener('agentopsdeck:session-handoff', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('agentopsdeck:session-handoff', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  const savedLayouts = useMemo(() => {
    try {
      const key = savedLayoutKey(recoveryScope());
      return key && typeof localStorage !== 'undefined' ? parseSavedLayouts(localStorage.getItem(key)) : [];
    } catch {
      return [];
    }
  }, [sessions.length, savedLayoutsRev]);
  const [fileContent, setFileContent] = useState<Extract<WorkspaceFileCard, { kind: 'dashboard' }>['content']>({ title: t('Workspace overview'), description: '', items: [] });
  useFileCardSettings('dashboard', fileContent, setFileContent);
  const tokenSummary = useMemo(() => summarizeDashboardTokens(sessions, { dimension, preferences, savedLayouts }), [sessions, dimension, preferences, savedLayouts]);
  const { overview, counts } = useMemo(() => {
    const counts = { run: 0, completed: 0, attention: 0, idle: 0 };
    const overview = overviewSessions(sessions).map(session => {
      const title = displayTitle(session), state = overviewState(session);
      counts[state]++;
      return { session, title, state, metrics: sessionTokenMetrics(session), search: `${title} ${session.agentId ?? ''}`.toLocaleLowerCase() };
    });
    return { overview, counts };
  }, [sessions]);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => overview.filter(item => (!filter || item.state === filter) && (!needle || item.search.includes(needle))), [overview, filter, needle]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  return <section className="workspace-dashboard" aria-label={t('Workspace overview')}>
    <ResourceTitle>{fileContent.title}</ResourceTitle>
    <ResourceToolbar><label className="workspace-dashboard-search"><Search size={15} aria-hidden="true" /><input name="workspacedashboard-input-1" type="search" value={query} placeholder={t('Search sessions')} aria-label={t('Search sessions')} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label></ResourceToolbar>
    {(fileContent.description || fileContent.items.length > 0) && <section className="workspace-dashboard-file-content"><p>{fileContent.description}</p><dl>{fileContent.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>}
    <div className="workspace-dashboard-counts" aria-label={t('Filter sessions by status')}>
      {states.map(state => <button type="button" key={state} data-state={state} aria-pressed={filter === state} onClick={() => { setFilter(value => value === state ? null : state); setPage(0); }}><strong>{counts[state]}</strong><span>{t(labels[state])}</span></button>)}
    </div>
    {tokenSummary.countedSessions > 0 && <div className="workspace-dashboard-tokens" aria-label={t('Token usage summary')}>
      <div className="workspace-dashboard-tokens-head">
        <span className="workspace-dashboard-token-total">
          <strong>{t('Tokens')}</strong> {t('In {input} · Out {output}', { input: tokenSummary.totalInput.toLocaleString(), output: tokenSummary.totalOutput.toLocaleString() })}
          {tokenSummary.totalEstimatedCredits > 0 ? <em className="workspace-dashboard-credit-badge"> · ≈ {tokenSummary.totalEstimatedCredits.toFixed(2)} {t('cr')}{tokenSummary.totalGhcpCredits > 0 ? ` (GHCP ${tokenSummary.totalGhcpCredits.toFixed(2)} ${t('cr')})` : ''}</em> : null}
        </span>
        <div className="workspace-dashboard-dimension-tabs" role="group" aria-label={t('Group tokens by')}>
          {(['agent', 'env', 'tag', 'group', 'layout'] as const).map(dim => (
            <button
              key={dim}
              type="button"
              className={`workspace-dashboard-dim-btn${dimension === dim ? ' is-active' : ''}`}
              aria-pressed={dimension === dim}
              onClick={() => setDimension(dim)}
            >
              {dim === 'agent' ? t('By Agent') : dim === 'env' ? t('By Env') : dim === 'tag' ? t('By Tag') : dim === 'group' ? t('By Group') : t('By Layout')}
            </button>
          ))}
        </div>
      </div>
      <div className="workspace-dashboard-token-chips">
        {tokenSummary.groups.map(group => (
          <span key={group.key} className="workspace-dashboard-token-chip" title={`${group.label} · ${group.sessions} sessions`}>
            <b>{group.label}</b> {group.inputTokens.toLocaleString()} / {group.outputTokens.toLocaleString()}
            {group.estimatedCredits > 0 ? <small> · {group.estimatedCredits.toFixed(2)} {t('cr')}</small> : null}
          </span>
        ))}
      </div>
    </div>}
    <div className="workspace-dashboard-list">
      {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(({ session, state, title, metrics }) => {
        const isFavorite = (preferences.sessions[session.sessionKey]?.tags ?? []).includes('favorite');
        return <button
          type="button"
          key={session.sessionKey}
          className={`workspace-dashboard-session${isFavorite ? ' is-favorite' : ''}`}
          onClick={() => onSelect(session)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCtxMenu({
              x: event.clientX,
              y: event.clientY,
              session,
              title,
              state,
            });
          }}
        >
          <span className="workspace-dashboard-dot" data-state={state} aria-hidden="true" /><span className="workspace-dashboard-name"><strong>{isFavorite ? '★ ' : ''}{title}</strong><small>{session.agentId ?? session.sessionRef?.runtimeId ?? t('Agent')}{(metrics.input !== '—' || metrics.output !== '—') ? ` · ${t('In {input} · Out {output}', { input: metrics.input, output: metrics.output })}` : ''}</small></span><span className="workspace-dashboard-state">{t(overviewLabel(session))}</span><ArrowUpRight size={14} aria-hidden="true" />
        </button>;
      })}
      {!filtered.length && <p className="workspace-dashboard-empty">{t('No sessions match this view.')}</p>}
    </div>
    {ctxMenu && typeof document !== 'undefined' ? createPortal(
      <div
        ref={ctxMenuRef}
        className="workspace-dashboard-context-menu"
        data-testid="workspace-dashboard-context-menu"
        role="menu"
        style={{ left: ctxMenu.x, top: ctxMenu.y }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onKeyDown={(e) => handleContextMenuKeyDown(e, () => setCtxMenu(null))}
      >
        <div className="workspace-dashboard-context-head">
          <div className="workspace-dashboard-context-head-row">
            <span className="workspace-dashboard-dot" data-state={ctxMenu.state} aria-hidden="true" />
            <strong>{ctxMenu.title}</strong>
          </div>
          <small>{ctxMenu.session.agentId ?? ctxMenu.session.sessionRef?.runtimeId ?? t('Session')}</small>
        </div>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const target = ctxMenu.session;
            setCtxMenu(null);
            onSelect(target);
          }}
        >
          <ExternalLink size={13} aria-hidden="true" />
          <span>{t('Open session pane')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const key = ctxMenu.session.sessionKey;
            setCtxMenu(null);
            void updatePreferences((prev) => {
              const cur = prev.sessions[key] ?? {};
              const tags = cur.tags ?? [];
              const nextTags = tags.includes('favorite')
                ? tags.filter((tItem: string) => tItem !== 'favorite')
                : [...tags, 'favorite'].slice(0, 8);
              return {
                ...prev,
                sessions: {
                  ...prev.sessions,
                  [key]: { ...cur, tags: nextTags },
                },
              };
            });
          }}
        >
          {(preferences.sessions[ctxMenu.session.sessionKey]?.tags ?? []).includes('favorite')
            ? <PinOff size={13} aria-hidden="true" />
            : <Pin size={13} aria-hidden="true" />}
          <span>
            {(preferences.sessions[ctxMenu.session.sessionKey]?.tags ?? []).includes('favorite')
              ? t('Remove from favorites')
              : t('Pin to favorites')}
          </span>
        </button>
        <div className="workspace-dashboard-context-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const targetState = ctxMenu.state;
            setCtxMenu(null);
            setFilter((prev) => (prev === targetState ? null : targetState));
            setPage(0);
          }}
        >
          <Filter size={13} aria-hidden="true" />
          <span>{t('Filter by this status')}</span>
        </button>
        {ctxMenu.session.agentId ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const agent = ctxMenu.session.agentId ?? '';
              setCtxMenu(null);
              setQuery(agent);
              setPage(0);
            }}
          >
            <Tag size={13} aria-hidden="true" />
            <span>{t('Filter by this agent')}</span>
          </button>
        ) : null}
        <div className="workspace-dashboard-context-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const titleText = ctxMenu.title;
            setCtxMenu(null);
            void navigator.clipboard?.writeText(titleText);
            setCopiedHint(titleText);
            window.setTimeout(() => setCopiedHint(null), 1800);
          }}
        >
          <Copy size={13} aria-hidden="true" />
          <span>{t('Copy session title')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const key = ctxMenu.session.sessionKey;
            setCtxMenu(null);
            void navigator.clipboard?.writeText(key);
            setCopiedHint(key);
            window.setTimeout(() => setCopiedHint(null), 1800);
          }}
        >
          {copiedHint ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span>{t('Copy session key')}</span>
        </button>
      </div>,
      document.body,
    ) : null}
    <footer><span>{t('{count} sessions', { count: filtered.length })}</span>{filtered.length > PAGE_SIZE && <><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{t('Previous')}</button><span>{currentPage + 1} / {Math.ceil(filtered.length / PAGE_SIZE)}</span><button type="button" disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>{t('Next')}</button></>}</footer>
  </section>;
});
