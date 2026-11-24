import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
const UsageCredits = lazy(() => import("./UsageCredits").then(m => ({ default: m.UsageCredits })));
import { ChartNoAxesColumn, Download, RefreshCw, X } from 'lucide-react';
import type { NativeTokenUsage, NativeTokenSnapshot } from '@agentopsdeck/shared';
import { api, ApiResponseError, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { CaptionIconButton } from './CaptionIconButton';
import { allowsUsageGranularity, defaultUsageGranularity, summarizeUsage, usageCacheRate, usageFields, usageGranularities, usageLineSegments, usageTimeline, type UsageField } from '../lib/token-usage-view';
import './session-token-usage.css';

const fieldLabels = { inputTokens: 'Input tokens', outputTokens: 'Output tokens', cacheReadTokens: 'Cache read', cacheWriteTokens: 'Cache write' } as const;
const granularityLabels = ['1 minute', '5 minutes', '15 minutes', '1 hour', '1 day'] as const;
const number = (value: number | null) => value === null ? '—' : value.toLocaleString();
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

/** On demand only: opening this panel never adds a polling subscription. */
export function SessionTokenUsage({ sessionKey, onOpen, caption = false, className }: { sessionKey: string; onOpen?: () => void; caption?: boolean; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const show = () => { onOpen?.(); setOpen(true); };
  return <>{caption ? <CaptionIconButton priority={65} label={t('Native token usage')} aria-haspopup="dialog" aria-expanded={open} onClick={show}><ChartNoAxesColumn size={15} aria-hidden="true" /></CaptionIconButton>
    : <button type="button" className={className} onClick={show} aria-haspopup="dialog" aria-expanded={open}><ChartNoAxesColumn size={15} aria-hidden="true" /><span>{t('Native token usage')}</span></button>}
    {open ? <UsagePanel key={sessionKey} sessionKey={sessionKey} close={() => setOpen(false)} /> : null}</>;
}

function UsagePanel({ sessionKey, close }: { sessionKey: string; close: () => void }) {
  const { t } = useI18n(), title = useId();
  const dialog = useRef<HTMLDialogElement>(null), closeRef = useRef(close);
  closeRef.current = close;
  const [days, setDays] = useState(1), [revision, refresh] = useState(0);
  const [granularity, setGranularity] = useState(0);
  const bucketMs = granularity || defaultUsageGranularity(days);
  const [data, setData] = useState<NativeTokenUsage>(), [error, setError] = useState(false);
  const exportRequest = useRef<AbortController | undefined>(undefined), downloadUrl = useRef<string | undefined>(undefined);
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'ready' | 'limit' | 'error'>('idle');
  const [snapshotId, setSnapshotId] = useState(''), [snapshot, setSnapshot] = useState<NativeTokenSnapshot>();
  const [snapshotState, setSnapshotState] = useState<'idle' | 'busy' | 'ready' | 'unknown'>('idle');
  const snapshotRequest = useRef<AbortController | undefined>(undefined);
  const snapshotAction = async (create: boolean) => {
    if (snapshotRequest.current || create && (!data || snapshotId)) return;
    const id = create ? crypto.randomUUID() : snapshotId;
    const controller = new AbortController(); snapshotRequest.current = controller;
    setSnapshotId(id); setSnapshotState('busy'); setSnapshot(undefined);
    try {
      const value = create ? await api.sessionTokenSnapshot(sessionKey, { requestId: id, from: data!.from, to: data!.to, bucketMs: data!.bucketMs }, controller.signal)
        : await api.sessionTokenSnapshotReceipt(sessionKey, id, controller.signal);
      if (!controller.signal.aborted) { setSnapshot(value); setSnapshotState('ready'); }
    } catch { if (!controller.signal.aborted) setSnapshotState('unknown'); }
    finally { if (snapshotRequest.current === controller) snapshotRequest.current = undefined; }
  };
  const cancelExport = () => {
    exportRequest.current?.abort(); exportRequest.current = undefined;
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = undefined;
  };
  const exportUsage = async () => {
    if (!data || exportRequest.current) return;
    cancelExport();
    const controller = new AbortController(); exportRequest.current = controller; setExportState('busy');
    try {
      const result = await api.sessionTokenUsageExport(sessionKey, data.from, data.to, data.bucketMs, controller.signal);
      if (controller.signal.aborted) return;
      const blob = new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob); downloadUrl.current = url;
      const link = document.createElement('a'); link.href = url; link.download = 'agentopsdeck-token-observations.json';
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setExportState('ready');
    } catch (failure) {
      if (!controller.signal.aborted) { cancelExport(); setExportState(failure instanceof ApiResponseError && failure.status === 413 ? 'limit' : 'error'); }
    } finally { if (exportRequest.current === controller) exportRequest.current = undefined; }
  };
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    const finish = () => closeRef.current();
    element?.showModal();
    const unsubscribe = subscribeRecoveryScope(finish);
    window.addEventListener('agentopsdeck:auth-required', finish); window.addEventListener('pagehide', finish);
    return () => {
      unsubscribe(); element?.close(); cancelExport(); snapshotRequest.current?.abort();
      window.removeEventListener('agentopsdeck:auth-required', finish); window.removeEventListener('pagehide', finish);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), to = Date.now();
    cancelExport(); setExportState('idle'); setData(undefined); setError(false);
    void api.sessionTokenUsage(sessionKey, to - days * 86_400_000, to, bucketMs, controller.signal)
      .then(value => { if (!controller.signal.aborted) setData(value); }, () => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); cancelExport(); };
  }, [sessionKey, days, bucketMs, revision]);
  return createPortal(<dialog ref={dialog} className="session-files-dialog session-usage-dialog" data-font-area="chat" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section><header><div><h2 id={title}><ChartNoAxesColumn size={18} aria-hidden="true" />{t('Native token usage')}</h2><p>{t('Root agent · observed time · partial coverage')}</p></div>
      <div className="session-usage-header-actions"><button type="button" title={t('Export observations (JSON)')} aria-label={t('Export observations (JSON)')} disabled={!data || exportState === 'busy'} onClick={() => { void exportUsage(); }}><Download size={16} /></button>
        <button type="button" title={t('Refresh')} aria-label={t('Refresh')} disabled={!data && !error} onClick={() => refresh(value => value + 1)}><RefreshCw size={16} /></button>
        <button type="button" autoFocus onClick={close} aria-label={t('Close')}><X size={18} /></button></div></header>
      <div className="session-usage-controls"><label><span>{t('Usage period')}</span><select name="sessiontokenusage-select-1" value={days} onChange={event => {
        const next = Number(event.target.value); setDays(next);
        if (granularity && !allowsUsageGranularity(next, granularity)) setGranularity(0);
      }}>
        <option value={1 / 24}>{t('Last hour')}</option><option value={1}>{t('Last 24 hours')}</option><option value={7}>{t('Last 7 days')}</option><option value={30}>{t('Last 30 days')}</option>
      </select></label><label><span>{t('Aggregation')}</span><select name="sessiontokenusage-select-2" value={granularity} onChange={event => setGranularity(Number(event.target.value))}>
        <option value={0}>{t('Auto')} · {t(granularityLabels[usageGranularities.indexOf(defaultUsageGranularity(days))] ?? '5 minutes')}</option>
        {usageGranularities.map((value, index) => <option key={value} value={value} disabled={!allowsUsageGranularity(days, value)}>{t(granularityLabels[index] ?? '5 minutes')}</option>)}
      </select></label></div>
      <div className="session-skills-body session-usage-body" aria-busy={!data && !error}>
        <fieldset className="session-usage-snapshot"><legend>{t('Immutable local snapshot')}</legend>
          <p>{t('One explicit creation, no automatic retry. Keep the request ID to query the original result after reopening.')}</p>
          <label>{t('Snapshot request ID')}<input name="sessiontokenusage-input-3" value={snapshotId} readOnly={snapshotState !== 'idle'} onChange={event => setSnapshotId(event.target.value)} maxLength={36} /></label>
          <button type="button" disabled={!data || !!snapshotId || snapshotState === 'busy'} onClick={() => { void snapshotAction(true); }}>{t('Create snapshot')}</button>
          <button type="button" disabled={!snapshotId || snapshotState === 'busy'} onClick={() => { void snapshotAction(false); }}>{t('Query original snapshot')}</button>
          {snapshotState === 'unknown' ? <p role="status">{t('Snapshot outcome unknown or unavailable. Query this request; no new creation was sent.')}</p> : null}
          {snapshotState === 'busy' ? <p role="status">{t('Loading…')}</p> : null}
          {snapshot ? <p role="status">{t('Snapshot saved locally (partial coverage)')} · {snapshot.data.observations.length} · {new Date(snapshot.createdAt).toLocaleString()}</p> : null}
        </fieldset>
        {data ? <p className="session-usage-export-note">{t('Export includes all models in this period, up to 4096 observations. Partial coverage; not a provider bill. No history is deleted.')}</p> : null}
        {exportState !== 'idle' ? <p role="status">{t(exportState === 'busy' ? 'Preparing token export…' : exportState === 'ready' ? 'Token export download requested.' : exportState === 'limit' ? 'Too many observations. Choose a shorter period to export; nothing was truncated.' : 'Export unavailable. Check Connector support or retry explicitly.')}</p> : null}
        {error ? <p role="status">{t('Token usage unavailable. Retry explicitly; no automatic polling.')}</p> : !data ? <p role="status">{t('Loading…')}</p> : <>
          <UsageContent key={`${data.from}:${data.bucketMs}`} data={data} />
        </>}
      </div></section>
  </dialog>, document.body);
}

function UsageContent({ data }: { data: NativeTokenUsage }) {
  const { t } = useI18n();
  const { totals, models } = useMemo(() => summarizeUsage(data), [data]);
  const [model, setModel] = useState<string>('all');
  const [visibleModels, setVisibleModels] = useState(30);
  const filtered = useMemo(() => model === 'all' ? data : { ...data, buckets: data.buckets.flatMap(bucket => {
    const row = (bucket.models ?? [{ ...bucket, model: null }]).find(row => `model:${row.model ?? ''}` === model);
    return row ? [{ ...row, at: bucket.at }] : [];
  }) }, [data, model]);
  return <>
    <section className="session-usage-overview" aria-label={t('Overview')}><h3>{t('Overview')}<span>{t('Observed in selected period')}</span></h3>
      <div className="session-usage-metrics">
        {usageFields.map(field => <div className="session-usage-metric" data-metric={field} key={field}><span>{t(fieldLabels[field])}</span><strong>{number(totals[field])}</strong></div>)}
        <div className="session-usage-metric"><span>{t('Cache hit rate')}</span><strong>{percent(usageCacheRate(data.inputAccounting, totals))}</strong></div>
        <div className="session-usage-metric"><span>{t('Native observations')}</span><strong>{number(totals.samples)}</strong></div>
      </div>
    </section>
    {data.runtime === 'codex' ? <CumulativeCoverage data={data} /> : null}
    <Suspense fallback={null}><UsageCredits data={data} models={models} /></Suspense>
    {!data.buckets.length ? <div className="session-usage-empty" role="status"><ChartNoAxesColumn size={28} aria-hidden="true" /><p>{t('No native observations in this period. This does not mean zero usage.')}</p></div> : <>
      <section className="session-usage-trend"><div className="session-usage-section-heading"><h3>{t('Usage trend')}</h3><select name="sessiontokenusage-select-4" aria-label={t('Trend model')} value={model} onChange={event => setModel(event.target.value)}>
        <option value="all">{t('All models')}</option>{models.map(row => <option key={row.model ?? ''} value={`model:${row.model ?? ''}`}>{row.model ?? t('Unknown model')}</option>)}
      </select></div><UsageTrend key={model} data={filtered} /></section>
      <section className="session-usage-models"><h3>{t('Model breakdown')}<span>{models.length}</span></h3>
        <div className="session-usage-table" role="region" aria-label={t('Model breakdown')} tabIndex={0}><table><thead><tr><th scope="col">{t('Model')}</th>{usageFields.map(field => <th scope="col" key={field}>{t(fieldLabels[field])}</th>)}<th scope="col">{t('Cache hit rate')}</th></tr></thead>
          <tbody>{models.slice(0, visibleModels).map(row => <tr key={row.model ?? ''}><th scope="row">{row.model ?? t('Unknown model')}</th>{usageFields.map(field => <td key={field}>{number(row[field])}</td>)}<td>{percent(usageCacheRate(data.inputAccounting, row))}</td></tr>)}</tbody>
        </table></div>{models.length > visibleModels ? <button className="session-usage-more" type="button" onClick={() => setVisibleModels(value => value + 30)}>{t('Show more')}</button> : null}
      </section>
    </>}
    <details className="session-usage-coverage"><summary>{t('Partial coverage · not a billing total')}</summary><p>{t('Native counters only. Missing history and subagents are not included; this is not a billing total.')}</p>
      <p>{data.runtime} · {t(data.inputAccounting === 'includes-cache' ? 'Input includes cache reads; do not add cache again.' : data.inputAccounting === 'excludes-cache' ? 'Cache tokens are separate from input tokens.' : 'Input/cache accounting follows the native provider.')}</p>
      <p>{t('Missing values and unsafe totals are shown as —. Gaps are not zero usage.')}</p>
      {data.observedSince !== null ? <p>{t('Observation started')} · {new Date(data.observedSince).toLocaleString()}</p> : null}
    </details>
  </>;
}

function CumulativeCoverage({ data }: { data: NativeTokenUsage }) {
  const { t } = useI18n();
  const coverage = data.cumulativeCoverage, baseline = coverage?.initialBaseline;
  return <section className="session-usage-gaps" aria-label={t('Collection gaps')}>
    <h3>{t('Collection gaps')}</h3>
    <p className="session-usage-gap-scope">{t('Session lifetime · not limited to the selected period')}</p>
    {!coverage ? <p>{t('Detailed collection evidence is unavailable. No observations or an older Connector may be the cause; this does not mean complete coverage.')}</p> : <>
      {baseline ? <div className="session-usage-baseline">
        <p>{t('Initial cumulative baseline · excluded from trends and credits')}</p>
        <dl><div><dt>{t('Input tokens')}</dt><dd>{number(baseline.inputTokens)}</dd></div><div><dt>{t('Output tokens')}</dt><dd>{number(baseline.outputTokens)}</dd></div></dl>
        <p>{t('Baseline observed')} · <time>{new Date(baseline.observedAt).toLocaleString()}</time></p>
        <p>{t('These native counts predate delta collection. Their original time and model are unknown, so they are not added to this period or priced.')}</p>
      </div> : <p>{t('The original baseline was not preserved by the older collector. It cannot be reconstructed from the current counter.')}</p>}
      <p>{t('Coverage tracking started')} · <time>{new Date(coverage.trackedSince).toLocaleString()}</time></p>
      {coverage.lastRegressionAt !== null ? <p className="session-usage-gap-warning">{t('Counter moved backwards; delayed events or a native reset are possible. Lower samples were excluded without guessing a reset. Usage may be missing.')} <time>{new Date(coverage.lastRegressionAt).toLocaleString()}</time></p> : null}
      {coverage.lastCacheGapAt !== null ? <p className="session-usage-gap-warning">{t('Cache telemetry lost continuity. Unknown cache deltas remain unknown and may prevent credit estimates.')} <time>{new Date(coverage.lastCacheGapAt).toLocaleString()}</time></p> : null}
    </>}
  </section>;
}

function UsageTrend({ data }: { data: NativeTokenUsage }) {
  const { t } = useI18n();
  const chart = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(790);
  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(260, Math.min(790, element.getBoundingClientRect().width))));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const timeline = useMemo(() => usageTimeline(data), [data]);
  const [selected, select] = useState(() => timeline.reduce((last, point, index) => point.bucket ? index : last, 0));
  const [enabled, setEnabled] = useState<UsageField[]>(['inputTokens', 'outputTokens']);
  const series = useMemo(() => enabled.map(field => ({ field, segments: usageLineSegments(timeline.map(point => point.bucket?.[field] ?? null)) })), [timeline, enabled]);
  const max = Math.max(1, ...series.flatMap(row => row.segments.flatMap(segment => segment.map(point => point.value))));
  const x = (index: number) => 55 + index * (width - 80) / Math.max(1, timeline.length - 1), y = (value: number) => 190 - value * 166 / max;
  const point = timeline[selected];
  const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const at = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const axisAt = (value: number) => data.bucketMs >= 86_400_000 || width <= 450 && data.to - data.from > 86_400_000 ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : width > 450 ? at(value) : new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return <>
    <div className="session-usage-legend">{usageFields.map(field => <button key={field} data-series={field} type="button" aria-pressed={enabled.includes(field)} onClick={() => setEnabled(previous => previous.includes(field) ? previous.filter(item => item !== field) : [...previous, field])}><i />{t(fieldLabels[field])}</button>)}</div>
    <p className="session-usage-chart-note">{t('Observed time · gaps mean no data')}</p>
    <svg ref={chart} className="session-usage-chart" viewBox={`0 0 ${width} 224`} role="img" aria-label={t('Token usage trend chart')} onPointerMove={event => {
      const box = event.currentTarget.getBoundingClientRect(); const position = ((event.clientX - box.left) / box.width * width - 55) / (width - 80);
      select(Math.max(0, Math.min(timeline.length - 1, Math.round(position * (timeline.length - 1)))));
    }}>
      <title>{t('Token usage trend chart')}</title>
      {[0, .5, 1].map(ratio => <g key={ratio}><line className="session-usage-grid" x1={55} x2={width - 25} y1={y(max * ratio)} y2={y(max * ratio)} /><text x={46} y={y(max * ratio) + 4} textAnchor="end">{compact(max * ratio)}</text></g>)}
      {series.map(row => <g key={row.field} data-series={row.field}>{row.segments.map((segment, index) => <g key={index}>
        <polyline points={segment.map(p => `${x(p.index)},${y(p.value)}`).join(' ')} />
        {segment.map(p => <circle key={p.index} cx={x(p.index)} cy={y(p.value)} r={segment.length === 1 ? 3 : 1.8} />)}
      </g>)}</g>)}
      <line className="session-usage-cursor" x1={x(selected)} x2={x(selected)} y1={18} y2={190} />
      <text x={55} y={216}>{axisAt(data.from)}</text><text x={width - 25} y={216} textAnchor="end">{axisAt(data.to)}</text>
    </svg>
    <input name="sessiontokenusage-input-5" className="session-usage-scrubber" type="range" min={0} max={Math.max(0, timeline.length - 1)} value={selected} onChange={event => select(Number(event.target.value))} aria-label={t('Inspect time bucket')} aria-valuetext={point ? at(point.at) : ''} />
    <div className="session-usage-inspection"><time>{point ? at(Math.max(data.from, point.at)) : '—'} – {point ? at(Math.min(data.to, point.at + data.bucketMs)) : '—'}</time>
      {!point?.bucket ? <span>{t('No observations in this interval')}</span> : <div>{usageFields.map(field => <span key={field} data-series={field}>{t(fieldLabels[field])}<b>{number(point.bucket?.[field] ?? null)}</b></span>)}<span>{t('Cache hit rate')}<b>{percent(usageCacheRate(data.inputAccounting, point.bucket))}</b></span></div>}
    </div>
  </>;
}
