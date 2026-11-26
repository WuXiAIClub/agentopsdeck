import { useEffect, useState } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';
import type { AntigravityUsage } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import './antigravity-quota-card.css';

const AUTO_REFRESH_INTERVAL_MS = 60_000;

export default function AntigravityUsagePanel({ scope }: { scope: string }) {
  const { t, locale } = useI18n();
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{ generation: number; usage: AntigravityUsage | null | undefined }>();
  useEffect(() => {
    if (!scope || scope !== recoveryScope()) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setGeneration(value => value + 1);
    }, AUTO_REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setGeneration(value => value + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scope]);
  useEffect(() => {
    if (!scope || scope !== recoveryScope()) return;
    const controller = new AbortController();
    const update = (usage?: AntigravityUsage | null) => {
      if (!controller.signal.aborted && scope === recoveryScope()) setResult({ generation, usage });
    };
    void api.antigravityUsage(controller.signal).then(response => update(response.usage), () => update());
    return () => controller.abort();
  }, [scope, generation]);
  if (!scope || scope !== recoveryScope()) return null;
  const busy = result?.generation !== generation;
  const usage = result?.usage;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const sampleGroupIndex = usage?.groups.length
    ? (() => {
        const index = usage.groups.findIndex(group => group.name === 'Gemini Models');
        return index >= 0 ? index : 0;
      })()
    : -1;
  const sampledAt = usage ? <div className="antigravity-quota-sample" role="status"><Clock3 size={13} aria-hidden="true" /><span>{t('Quota checked at')} · <time dateTime={new Date(usage.sampledAt).toISOString()}>{new Date(usage.sampledAt).toLocaleString(locale)}</time></span></div> : null;
  return <section className="antigravity-quota-card" aria-label={t('Antigravity account quota')} aria-busy={busy}>
    <ResourceTitle>{t('Antigravity account quota')}</ResourceTitle>
    <ResourceToolbar>
      <ResourceAction label={t('Refresh')} disabled={busy || usage === null} onClick={() => setGeneration(value => value + 1)}><RefreshCw size={15} className={busy ? 'antigravity-quota-refreshing' : undefined} /></ResourceAction>
    </ResourceToolbar>
    <div className="antigravity-quota-body">
      {busy && usage === undefined && <p role="status">{t('Loading…')}</p>}
      {!busy && usage === undefined && <p role="alert">{t('Antigravity quota unavailable. Try refreshing.')}</p>}
      {usage === null && <p>{t('Antigravity is not configured on this server.')}</p>}
      {usage && <>
        {!usage.groups.length && <>
          <p>{t('Antigravity reported no quota windows.')}</p>
          {sampledAt}
        </>}
        {usage.groups.map((group, index) => {
          const name = group.name === 'Gemini Models' ? t('Gemini Models') : group.name === 'Claude and GPT models' ? t('Claude and GPT models') : group.name;
          return <div className="antigravity-quota-group" key={group.name} role="group" aria-label={name}>
            <div className="antigravity-quota-group-header">
              <h3>{name}</h3>
              {index === sampleGroupIndex && sampledAt}
            </div>
            <ul role="list">{group.windows.map(bucket => {
              const windowLabel = bucket.window === '5h' ? t('5-hour quota') : bucket.window === 'weekly' ? t('Weekly quota') : bucket.window;
              const remaining = percent.format(bucket.remainingFraction);
              const low = bucket.remainingFraction <= 0.2;
              return <li key={bucket.id} data-low={low || undefined}>
                <div className="antigravity-quota-dial" aria-hidden="true">
                  <svg viewBox="0 0 72 72" focusable="false">
                    <circle cx="36" cy="36" r="31" />
                    <circle className="antigravity-quota-arc" cx="36" cy="36" r="31" pathLength="100" strokeDasharray={`${bucket.remainingFraction * 100} 100`} data-empty={bucket.remainingFraction <= 0 || undefined} />
                  </svg>
                  <strong>{remaining}</strong>
                </div>
                <div className="antigravity-quota-reading">
                  <strong>{windowLabel}</strong>
                  <small>{bucket.resetAt === null ? t('Quota reset time unavailable') : <>{t('Resets at')} · <time dateTime={new Date(bucket.resetAt).toISOString()}>{new Date(bucket.resetAt).toLocaleString(locale)}</time></>}</small>
                </div>
                <progress className="antigravity-quota-progress" aria-label={`${name} · ${windowLabel} · ${t('Quota remaining')}`} aria-valuetext={t('Remaining: {percent}', { percent: remaining })} max={1} value={bucket.remainingFraction} data-low={low || undefined} />
              </li>;
            })}</ul>
          </div>;
        })}
      </>}
    </div>
  </section>;
}
