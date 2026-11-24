import { useEffect, useState, useSyncExternalStore } from 'react';
import { workspaceSyncMetrics } from '../api';
import { useI18n } from '../lib/i18n';
import { workspaceSyncPreference, subscribeWorkspaceSyncPreference, setWorkspaceSyncEnabled } from '../lib/workspace-sync-preference';

export function WorkspaceSyncSettings() {
  const { t } = useI18n();
  const preference = useSyncExternalStore(subscribeWorkspaceSyncPreference, workspaceSyncPreference);
  const [metrics, setMetrics] = useState(workspaceSyncMetrics);
  useEffect(() => { const timer = setInterval(() => setMetrics(workspaceSyncMetrics()), 2000); return () => clearInterval(timer); }, []);
  return <section className="mt-5 space-y-3 rounded-xl border border-slate-200 p-3" aria-label={t('Workspace sync · Preview')}>
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
      <span>{t('Workspace sync · Preview')}</span>
      <input name="workspacesyncsettings-input-1" type="checkbox" role="switch" className="h-4 w-4 accent-sky-600" checked={preference.enabled}
        onChange={event => setWorkspaceSyncEnabled(event.target.checked)} aria-label={t('Workspace sync · Preview')} />
    </label>
    <p className="text-xs leading-relaxed text-slate-600">{t('Combine latest-message reads across open sessions. Off by default; switch back without reloading. Saved for this user in this browser.')}</p>
    <p className="text-xs text-slate-600" role="status">{t(!preference.enabled ? 'Standard sync' : preference.unavailable ? 'This Hub does not support Preview; using standard sync.' : 'Preview active · shared sessions and older history use standard sync.')}</p>
    {preference.enabled && <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums text-slate-600">
      <dt>{t('Observation window')}</dt><dd>{t('{value} seconds', { value: Math.max(0, Math.floor((Date.now() - metrics.startedAt) / 1000)) })}</dd>
      <dt>{t('Batch requests')}</dt><dd>{metrics.batches}</dd>
      <dt>{t('Session reads')}</dt><dd>{metrics.items}</dd>
      <dt>{t('Failed session reads')}</dt><dd>{metrics.errors}</dd>
      <dt>{t('HTTP 503 reads')}</dt><dd>{metrics.unavailable}</dd>
      <dt>{t('Other HTTP errors')}</dt><dd>{metrics.httpErrors - metrics.unavailable}</dd>
      <dt>{t('Timed-out reads')}</dt><dd>{metrics.timeouts}</dd>
      <dt>{t('Stream or network errors')}</dt><dd>{metrics.transportErrors}</dd>
      <dt>{t('Cancelled reads (not failures)')}</dt><dd>{metrics.cancelled}</dd>
      <dt>{t('Decoded sync payload')}</dt><dd>{t('{value} KiB', { value: (metrics.bytes / 1024).toFixed(1) })}</dd>
    </dl>}
    {preference.enabled && <p className="text-xs text-slate-500">{t('Counters persist until reload or account change, including time with Preview off. Standard reads are not included.')}</p>}
    {!preference.persistent && <p className="text-xs text-amber-700">{t('Preference applies to this page only; browser storage is unavailable.')}</p>}
  </section>;
}
