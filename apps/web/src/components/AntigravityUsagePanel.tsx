import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AntigravityUsage } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';

export default function AntigravityUsagePanel({ scope }: { scope: string }) {
  const { t, locale } = useI18n();
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{ generation: number; usage: AntigravityUsage | null | undefined }>();
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
  const usage = busy ? undefined : result?.usage;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return <section className="workspace-metric-card" aria-label={t('Antigravity account quota')} aria-busy={busy}>
    <ResourceTitle>{t('Antigravity account quota')}</ResourceTitle>
    <ResourceToolbar>
      <ResourceAction label={t('Refresh')} disabled={busy || usage === null} onClick={() => setGeneration(value => value + 1)}><RefreshCw size={15} /></ResourceAction>
    </ResourceToolbar>
    {busy && <p role="status">{t('Loading…')}</p>}
    {!busy && usage === undefined && <p role="alert">{t('Antigravity quota unavailable. Try refreshing.')}</p>}
    {usage === null && <p>{t('Antigravity is not configured on this server.')}</p>}
    {usage && <>
      <p role="status">{t('Quota checked at')} · <time dateTime={new Date(usage.sampledAt).toISOString()}>{new Date(usage.sampledAt).toLocaleString(locale)}</time></p>
      {!usage.groups.length && <p>{t('Antigravity reported no quota windows.')}</p>}
      {usage.groups.map(group => <div key={group.name}>
        <strong>{group.name === 'Gemini Models' ? t('Gemini Models') : group.name === 'Claude and GPT models' ? t('Claude and GPT models') : group.name}</strong>
        <ul>{group.windows.map(bucket => {
          const windowLabel = bucket.window === '5h' ? t('5-hour quota') : bucket.window === 'weekly' ? t('Weekly quota') : bucket.window;
          return <li key={bucket.id}>
            <div>{windowLabel} · {t('Remaining: {percent}', { percent: percent.format(bucket.remainingFraction) })}</div>
            <progress aria-label={`${group.name} · ${windowLabel} · ${t('Quota remaining')}`} max={1} value={bucket.remainingFraction} />
            <div>{bucket.resetAt === null ? t('Quota reset time unavailable') : <>{t('Resets at')} · <time dateTime={new Date(bucket.resetAt).toISOString()}>{new Date(bucket.resetAt).toLocaleString(locale)}</time></>}</div>
          </li>;
        })}</ul>
      </div>)}
    </>}
  </section>;
}
