import { useEffect, useRef, useState } from 'react';
import type { GatewayHealth } from '@agentopsdeck/shared';
import { api, recoveryEpoch } from '../api';
import { translate, useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { confirmAction } from './ui/confirm';
import { gatewayDisplayState } from '../lib/gateway-display';
export { gatewayDisplayState } from '../lib/gateway-display';

export function GatewayStatus({ gateway }: { gateway: GatewayHealth | undefined }) {
  // Do not include status timestamps: routine polling must not invalidate a confirmation.
  const identity = JSON.stringify([recoveryEpoch(), gateway?.enabled, gateway?.gatewayWs?.url]);
  return <GatewayStatusPanel key={identity} gateway={gateway} />;
}

function GatewayStatusPanel({ gateway }: { gateway: GatewayHealth | undefined }) {
  const { t, locale } = useI18n();
  const [override, setOverride] = useState<GatewayHealth>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'accepted' | 'unknown'>();
  const active = useRef(true), pending = useRef(false);
  const epoch = recoveryEpoch();
  const enabled = useRef(gateway?.enabled);
  enabled.current = gateway?.enabled;
  useEffect(() => {
    active.current = true;
    const expire = () => { active.current = false; };
    window.addEventListener('agentopsdeck:auth-required', expire);
    return () => { active.current = false; window.removeEventListener('agentopsdeck:auth-required', expire); };
  }, []);
  useEffect(() => { setOverride(undefined); }, [gateway]);
  const current = () => active.current && epoch === recoveryEpoch() && enabled.current !== false;
  async function restart() {
    if (pending.current || !gateway || !current()) return;
    pending.current = true; setBusy(true);
    try {
      if (!await confirmAction({ title: t('Restart OpenClaw Gateway?'), description: t('This restarts the configured OpenClaw Gateway, not the Hub or other Connectors. Active OpenClaw runs may reconnect.'), confirmLabel: t('Restart gateway') }) || !current()) return;
      setResult(undefined);
      try {
        const response = await api.restartGateway();
        if (current()) { setOverride(response.gateway); setResult(response.ok ? 'accepted' : 'unknown'); }
      } catch { if (current()) setResult('unknown'); }
    } finally { pending.current = false; if (current()) setBusy(false); }
  }
  const shown = override ?? gateway, display = gatewayDisplayState(shown);
  const value = (text: string | undefined) => text ?? t('unknown');
  const rows = [
    [t('Version'), value(shown?.version)], [t('Default agent'), value(shown?.defaultAgentId)],
    [t('Default model'), value(shown?.defaultModel)],
    [t('Updated'), shown?.updatedAt ? new Date(shown.updatedAt).toLocaleString(locale) : t('unknown')],
    [t('Gateway URL'), shown?.gatewayWs?.configured ? shown.gatewayWs.url ?? t('configured') : t('not configured')],
    [t('Deck WS client'), t(shown?.gatewayWs?.connected ? 'connected' : 'idle')],
  ];
  return <Card className="min-w-0 border-white/70 bg-white/70 p-5" aria-label={t('OpenClaw Gateway status')}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600">OpenClaw Gateway</p>
        <h2 className="mt-1 text-2xl font-black tracking-[-0.04em] text-slate-950">{translate(display.label)}</h2>
        <p className="mt-2 text-sm text-slate-500 [overflow-wrap:anywhere]">{shown?.note ?? translate(display.hint)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <Badge variant={display.variant}>{translate(display.badge)}</Badge>
        <Button type="button" variant="secondary" className="h-9 rounded-xl px-3 text-xs font-bold" disabled={busy || !gateway || gateway.enabled === false} onClick={() => void restart()}>{t(busy ? 'Restarting…' : 'Restart gateway')}</Button>
      </div>
    </div>
    <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">{rows.map(([label, content]) => <div key={label} className="flex min-w-0 items-center justify-between gap-3 rounded-2xl bg-white/60 px-3 py-2"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 text-right font-bold text-slate-800 [overflow-wrap:anywhere]">{content}</dd></div>)}</dl>
    {shown?.error ? <p className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-sm text-amber-700 [overflow-wrap:anywhere]">{shown.error}</p> : null}
    {result ? <p role="status" className={`mt-3 rounded-2xl px-3 py-2 text-sm font-semibold ${result === 'accepted' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-900'}`}>{t(result === 'accepted' ? 'Gateway restart requested. Live status will refresh; this is not a readiness confirmation.' : 'Restart result unconfirmed. Check live Gateway status before trying again; nothing was retried.')}</p> : null}
    {shown?.details ? <details className="mt-3 min-w-0 rounded-2xl border border-slate-200 bg-white/60 px-3 py-2 text-xs text-slate-600"><summary className="cursor-pointer font-bold text-slate-700">{t('Raw gateway details')}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(shown.details, null, 2)}</pre></details> : null}
  </Card>;
}
