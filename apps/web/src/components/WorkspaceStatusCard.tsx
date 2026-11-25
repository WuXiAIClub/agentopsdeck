import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { RefreshCw, LayoutDashboard } from 'lucide-react';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import type { BoardSummary } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { boardSavedEvent, readCachedBoardSummary, writeCachedBoardSummary, type BoardSavedDetail } from '../lib/workspace-board';
import { useI18n } from '../lib/i18n';
import type { OpenBoardResource } from './WorkspaceBoardPicker';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
const SystemMetricsPanel = lazy(() => import('./SystemMetricsPanel'));
const UsageAggregationPanel = lazy(() => import('./UsageAggregationPanel'));
const AntigravityUsagePanel = lazy(() => import('./AntigravityUsagePanel'));

export default function WorkspaceStatusCard({ scope, resourceId, onOpen }: { scope: string; resourceId: string; onOpen: OpenBoardResource }) {
  const { t, locale } = useI18n();
  const [summary, setSummary] = useState<BoardSummary | undefined>(() => scope === recoveryScope() ? readCachedBoardSummary(scope, resourceId) : undefined), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const { revision: remoteRevision, notice: remoteNotice } = useWorkspaceBoardRevision(scope, resourceId);
  const attemptedRemote = useRef('');
  useEffect(() => {
    if (busy || !remoteRevision || (summary && remoteRevision <= summary.revision)) return;
    const attempt = JSON.stringify([scope, resourceId, remoteRevision, remoteNotice]);
    if (attemptedRemote.current === attempt) return;
    attemptedRemote.current = attempt;
    setGeneration(value => value + 1);
  }, [scope, resourceId, remoteRevision, remoteNotice, summary, busy]);
  useEffect(() => {
    const abort = new AbortController(); let live = true;
    const update = (next: BoardSummary) => {
      if (live && scope === recoveryScope()) {
        writeCachedBoardSummary(scope, resourceId, next);
        setSummary(previous => !previous || next.revision >= previous.revision ? next : previous);
        setError(false);
      }
    };
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<BoardSavedDetail>).detail;
      if (detail.scope === scope && detail.summary.resourceId === resourceId) update(detail.summary);
    };
    window.addEventListener(boardSavedEvent, saved); setBusy(true); setError(false);
    void api.workspaceBoardSummary(resourceId, abort.signal).then(update).catch(() => { if (live) setError(true); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; abort.abort(); window.removeEventListener(boardSavedEvent, saved); };
  }, [scope, resourceId, generation]);
  const total = summary ? Object.values(summary.counts).reduce((sum, count) => sum + count, 0) : 0;
  return <section className="workspace-status-card workspace-taskboard" aria-label={t('Task status card')} aria-busy={busy}>
    <ResourceTitle>{summary?.title ?? t('Task status card')}</ResourceTitle>
    <ResourceToolbar>
      <ResourceAction label={t('Refresh task board')} disabled={busy} onClick={() => setGeneration(value => value + 1)}><RefreshCw size={15} /></ResourceAction>
      <ResourceAction label={t('Open task board')} onClick={() => onOpen('taskboard', resourceId)}><LayoutDashboard size={15} /></ResourceAction>
    </ResourceToolbar>
    {error && <p role="alert">{t('Unable to load task board. Retry refresh.')}</p>}
    {busy && !summary && <p role="status">{t('Loading…')}</p>}
    {summary && <>
      <div className="workspace-board-counts">{(['todo', 'doing', 'done'] as const).map((status, index) => <span key={status} data-status={status}><strong>{summary.counts[status]}</strong>{t((['To do', 'In progress', 'Done'] as const)[index]!)}</span>)}</div>
      <progress aria-label={t('Task progress')} max={Math.max(total, 1)} value={summary.counts.done} />
      <p className="workspace-board-status">{summary.updatedAt ? `${t('Saved')} · ${new Date(summary.updatedAt).toLocaleString(locale)}` : t('Save the task board to update this card.')}</p>
      <p className="workspace-board-status">{t('Saved status · updates from connected devices sync automatically')}</p>
    </>}
    <details onToggle={e => setMetricsOpen(e.currentTarget.open)}><summary>{t('Machine metrics')}</summary>
      {metricsOpen && <Suspense fallback={<p>{t('Loading…')}</p>}><SystemMetricsPanel key={scope} scope={scope} /></Suspense>}
    </details>
    <details onToggle={e => setUsageOpen(e.currentTarget.open)}><summary>{t('Usage by group, tag and environment')}</summary>
      {usageOpen && <Suspense fallback={<p>{t('Loading…')}</p>}><UsageAggregationPanel key={scope} scope={scope}/></Suspense>}
    </details>
    <details onToggle={event => setQuotaOpen(event.currentTarget.open)}><summary>{t('Antigravity account quota')}</summary>
      {quotaOpen && <Suspense fallback={<p>{t('Loading…')}</p>}><AntigravityUsagePanel key={scope} scope={scope} /></Suspense>}
    </details>
  </section>;
}
