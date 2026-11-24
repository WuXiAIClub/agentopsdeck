import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserDiagnostics, downloadBrowserDiagnostics, type DiagnosticLevel } from '../lib/browser-diagnostics';
import { requestGovernor, type RefreshPolicyMode } from '../lib/request-governor';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';

export default function BrowserDiagnosticsSettings() {
  const { t } = useI18n();
  const level = useSyncExternalStore(browserDiagnostics.subscribe, browserDiagnostics.level, () => 'errors' as const);
  const policy = useSyncExternalStore(requestGovernor.subscribe, requestGovernor.policy, () => 'auto' as const);
  const [telemetry, setTelemetry] = useState(() => requestGovernor.snapshot());

  useEffect(() => {
    const refresh = () => setTelemetry(requestGovernor.snapshot());
    refresh();
    const unsub = requestGovernor.subscribe(refresh);
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, []);

  return <section className="mt-5 space-y-3">
    <label className="flex items-center justify-between gap-3 text-sm font-semibold">{t('Adaptive refresh rate ceiling')}
      <select name="browserdiagnosticssettings-select-policy" aria-label={t('Adaptive refresh rate ceiling')} value={policy}
        onChange={event => requestGovernor.setPolicy(event.target.value as RefreshPolicyMode)}>
        <option value="auto">{t('Auto · dynamic device & backend sensing')}</option>
        <option value="high">{t('High · faster active session sync')}</option>
        <option value="balanced">{t('Balanced · standard budget')}</option>
        <option value="saver">{t('Resource saver · prioritize essential requests')}</option>
      </select>
    </label>
    <div className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs text-slate-600 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{t('Governor state')}: <strong className="text-slate-800">{telemetry.regime}</strong> ({Math.round(telemetry.intervalMultiplier * 100)}% · {telemetry.effectiveConcurrency})</span>
        <span>{[`${telemetry.requestsPerSecond}/s`, `${telemetry.requestsPerMinute}/m`, `${telemetry.inFlight} ${t('in flight')}`].join(' · ')}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{t('Frontend RTT')}: {`${telemetry.avgLatencyMs}ms / ${telemetry.p95LatencyMs}ms`}</span>
        <span>{t('Backend Hub/Connector')}: {`${telemetry.backendAppMs}ms / ${telemetry.backendConnectorWaitMs}ms`}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{t('Priority mix (60s)')}: {`P0 ${telemetry.counts.p0Critical} · P1 ${telemetry.counts.p1Active} · P2 ${telemetry.counts.p2Visible} · P3 ${telemetry.counts.p3Background}`}</span>
        <span>{`2xx ${telemetry.counts.ok2xx} · 304 ${telemetry.counts.notModified304} · 202 ${telemetry.counts.accepted202} · 5xx ${telemetry.counts.error5xx}`}</span>
      </div>
    </div>
    <label className="flex items-center justify-between gap-3 text-sm font-semibold">{t('Browser transport diagnostics')}
      <select name="browserdiagnosticssettings-select-1" aria-label={t('Browser transport diagnostics')} value={level}
        onChange={event => browserDiagnostics.setLevel(event.target.value as DiagnosticLevel)}>
        <option value="off">{t('Off')}</option><option value="errors">{t('Errors only')}</option>
        <option value="debug">{t('Detailed · this page only')}</option>
      </select>
    </label>
    <p className="text-sm text-slate-600">{t('Up to 160 local transport events. No messages, addresses or credentials. Resets on refresh; cleared when the account changes.')}</p>
    <div className="flex gap-2">
      <Button type="button" variant="secondary" onClick={downloadBrowserDiagnostics}>{t('Download transport diagnostics')}</Button>
      <Button type="button" variant="ghost" onClick={() => { browserDiagnostics.clear(); requestGovernor.clear(); }}>{t('Clear transport diagnostics')}</Button>
    </div>
  </section>;
}
