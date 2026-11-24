import { useEffect, useState } from 'react';
import type { ConnectorCapabilities, SessionSummary } from '@agentopsdeck/shared';
import { api, type HubSessionsState } from '../api';
import { useI18n } from '../lib/i18n';
import { sessionChannelRoute } from '../lib/channel-routes';
import { Button } from './ui/button';

/** Route inventory, not a fabricated probe of third-party delivery health. */
export function ChannelsPage({ sessions, onOpenSession }: { sessions: HubSessionsState; onOpenSession?: (session: SessionSummary) => void }) {
  const { t } = useI18n();
  const [generation, setGeneration] = useState(0);
  const [inventory, setInventory] = useState<Record<string, { caps?: ConnectorCapabilities; unavailable?: boolean }>>({});
  const [loading, setLoading] = useState(true);
  const connections = sessions.connections ?? [];
  const identity = JSON.stringify(connections.map(connection => [connection.id, connection.ownerUserId, connection.connectorUrl, connection.updatedAt, connection.status]));
  useEffect(() => {
    let active = true;
    setInventory({}); setLoading(true);
    void Promise.all(connections.map(async connection => {
      if (connection.status === 'disabled') return [connection.id, { unavailable: true }] as const;
      try { return [connection.id, { caps: await api.hubConnectionCapabilities(connection.id) }] as const; }
      catch { return [connection.id, { unavailable: true }] as const; }
    })).then(rows => { if (active) { setInventory(Object.fromEntries(rows)); setLoading(false); } });
    return () => { active = false; };
  }, [identity, generation]);
  return <section className="space-y-4 p-4 sm:p-6">
    <header className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">{t('Channels')}</h1><p className="mt-1 text-sm text-slate-500">{t('Delivery routes by environment. Connector access does not prove an external channel is online.')}</p></div><Button variant="secondary" disabled={loading} onClick={() => setGeneration(value => value + 1)}>{t(loading ? 'Loading…' : 'Refresh')}</Button></header>
    {!connections.length ? <p role="status" className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">{t('No environments available. Add or enable a Connector in Gateway.')}</p> : null}
    {connections.map(connection => {
      const row = inventory[connection.id];
      const routes = sessions.groups.flatMap(group => group.sessions).filter(session => (session as SessionSummary & { envConnectionId?: string }).envConnectionId === connection.id)
        .flatMap(session => { const route = sessionChannelRoute(session); return route ? [{ session, ...route }] : []; });
      const scopes = row?.caps?.scopes ?? [];
      return <article key={connection.id} className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{connection.environmentLabel || connection.label}</h2><span className="text-xs text-slate-500">{t(connection.status)}</span></div>
        {loading ? <p role="status" className="mt-3 text-sm text-slate-500">{t('Loading delivery capabilities…')}</p> : row?.unavailable ? <p role="status" className="mt-3 text-sm text-amber-700">{t('Capabilities unavailable. Check connection, read permission and Connector version.')}</p> : <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-lg bg-slate-100 px-3 py-2">{t('Web chat')} · {t(scopes.includes('messages:send') ? 'Send permitted' : 'Read only')}</span>
          <span className="rounded-lg bg-slate-100 px-3 py-2">{t('Live events')} · {t(scopes.includes('events:read') && row?.caps?.features.events ? 'Available' : 'Unavailable')}</span>
          <span className="rounded-lg bg-slate-100 px-3 py-2">{t('Channel mirror')} · {t(scopes.includes('messages:mirror') ? 'Permission configured' : 'Not permitted')}</span>
        </div>}
        <div className="mt-4 border-t border-slate-100 pt-3"><h3 className="text-xs font-semibold text-slate-600">{t('Known external routes')}</h3>
          {routes.length ? <ul className="mt-2 space-y-2">{routes.map(route => <li key={route.session.sessionKey}><button type="button" disabled={!onOpenSession} onClick={() => onOpenSession?.(route.session)} className="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-left hover:bg-blue-50"><span className="min-w-0 truncate text-sm">{route.session.title}</span><span className="shrink-0 text-xs text-slate-500">{route.channel} · {t(route.shape)}</span></button></li>)}</ul> : <p className="mt-2 text-sm text-slate-500">{t('No external routes in the visible session list. Codex and Hermes use web chat; this is not a connection error.')}</p>}
          <p className="mt-2 text-xs text-slate-400">{t('Routes come from visible OpenClaw sessions, not a complete account inventory. Sending still checks runtime and session permissions.')}</p>
        </div>
      </article>;
    })}
  </section>;
}
