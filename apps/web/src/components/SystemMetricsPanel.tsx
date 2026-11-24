import { useEffect, useRef, useState } from 'react';
import { validSystemMetrics, type SystemMetrics } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';

/** Mounted only on explicit expansion. Machine permission is never inferred
 * from the containing taskboard's grants. Hidden/offline views do not poll. */
export default function SystemMetricsPanel({ scope }: { scope: string }) {
  const { t, locale } = useI18n(), host = useRef<HTMLElement>(null);
  const attempts = useRef(new Map<string, number>());
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.metricSources>>['sources']>([]);
  const [selected, setSelected] = useState(''), [automatic, setAutomatic] = useState(false), [visible, setVisible] = useState(false);
  const [sample, setSample] = useState<SystemMetrics>(), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0), [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const el = host.current; if (!el) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(v => v.isIntersecting)));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const abort = new AbortController(), epoch = recoveryEpoch(); let live = true;
    setSources([]); setSelected(''); setSample(undefined); setFailed(false);
    void api.metricSources(abort.signal).then(v => {
      if (live && scope === recoveryScope() && epoch === recoveryEpoch()) { setSources(v.sources); setSelected(v.sources[0] ? JSON.stringify([v.sources[0].kind, v.sources[0].key]) : ''); }
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; abort.abort(); };
  }, [scope]);
  useEffect(() => {
    setSample(undefined); setFailed(false); attempts.current.clear();
  }, [scope, selected]);
  useEffect(() => {
    setBusy(false);
    if (!selected) return;
    const source = sources.find(v => JSON.stringify([v.kind, v.key]) === selected); if (!source) return;
    const epoch = recoveryEpoch(), abort = new AbortController(); let live = true, reading = false;
    const attemptKey = JSON.stringify([scope, epoch, selected]);
    const current = () => live && scope === recoveryScope() && epoch === recoveryEpoch();
    const load = async () => {
      if (!current() || reading || document.hidden || !navigator.onLine || !visible || Date.now() - (attempts.current.get(attemptKey) ?? -Infinity) < 5000) return;
      reading = true; attempts.current.set(attemptKey, Date.now()); setBusy(true);
      try {
        const value = await api.systemMetrics(source.kind, source.key, AbortSignal.any([abort.signal, AbortSignal.timeout(5500)]));
        if (!validSystemMetrics(value) || value.source.kind !== source.kind || value.source.id !== source.id) throw Error('Metrics identity');
        if (current()) { setSample(value); setFailed(false); setClock(Date.now()); }
      } catch { if (current()) { setSample(undefined); setFailed(true); } }
      finally { reading = false; if (current()) setBusy(false); }
    };
    void load();
    const wake = () => { setClock(Date.now()); if (automatic) void load(); };
    const timer = setInterval(wake, 5000);
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    return () => { live = false; abort.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [scope, selected, sources, automatic, visible, refresh]);
  const bytes = (v: number | null) => v === null ? t('Unknown') : `${(v / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MiB`;
  return <section ref={host} aria-label={t('Machine metrics')}>
    <label>{t('Metrics source')}<select name="systemmetricspanel-select-1" value={selected} onChange={e => setSelected(e.target.value)}>
      {sources.map(v => <option key={JSON.stringify([v.kind, v.key])} value={JSON.stringify([v.kind, v.key])}>{v.label} · {v.id}</option>)}
    </select></label>
    <label><input name="systemmetricspanel-input-2" type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} />{t('Refresh metrics every 5 seconds while visible')}</label>
    <button disabled={busy || !selected} onClick={() => setRefresh(v => v + 1)}>{t('Refresh')}</button>
    <p>{t('Machine metrics require separate permission; session access does not grant it.')}</p>
    {failed && <p role="alert">{t('Metrics unavailable or not authorized')}</p>}
    {sample && <dl>
      <dt>{t('Metrics scope')}</dt><dd>{sample.scope} · {new Date(sample.sampledAt).toLocaleString(locale)}{clock - sample.sampledAt > 15000 ? ` · ${t('Stale')}` : ''}</dd>
      <dt>CPU</dt><dd>{sample.cpu.percent === null ? t('Unknown') : `${sample.cpu.percent.toFixed(1)}%`} · {sample.cpu.cores ?? '?'} {t('CPU cores')}</dd>
      <dt>{t('Memory used / total / available')}</dt><dd>{bytes(sample.memory.usedBytes)} / {bytes(sample.memory.totalBytes)} / {bytes(sample.memory.availableBytes)}</dd>
      {sample.volumes.map(v => <div key={v.id}><dt>{v.id} · {t('Disk free / total')}</dt><dd>{bytes(v.freeBytes)} / {bytes(v.totalBytes)}</dd></div>)}
      {!sample.volumes.length && <><dt>{t('Disk free / total')}</dt><dd>{t('No metric volumes configured')}</dd></>}
    </dl>}
    <p>{t('Model credit is unavailable without trusted billing evidence.')}</p>
  </section>;
}
