import { useEffect, useState } from 'react';
import type { SharedGrantSummary, SharedSessionDirectoryPage } from '@agentopsdeck/shared';
import { api, ApiResponseError, AuthRequiredError, recoveryScope } from '../api';
import { sessionAddress } from '../lib/session-address';
import { sessionTone } from '../lib/session-tone';
import { Button } from './ui/button';
import { useI18n, type TranslationKey } from '../lib/i18n';

/** At most one explicitly opened grant/node, one page, no polling or subscription. */
export function SharedResourceDirectory({ grant, back }: { grant: SharedGrantSummary; back: () => void }) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | undefined>();
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SharedSessionDirectoryPage>();
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<TranslationKey | ''>('');
  const scope = recoveryScope();
  useEffect(() => {
    const controller = new AbortController(), current = () => !controller.signal.aborted && scope === recoveryScope();
    setPage(undefined); setError(''); setLoading(true); setDenied(false);
    void api.sharedGrantSessions(grant, cursor, controller.signal).then(next => {
      if (current()) setPage(next);
    }).catch(cause => {
      if (!current()) return;
      const unavailable = cause instanceof AuthRequiredError || cause instanceof ApiResponseError && [401, 403, 404].includes(cause.status);
      setDenied(unavailable);
      setError(unavailable ? 'This shared directory is no longer available. Return to authorizations to reload access.'
        : 'Shared resources unavailable. Refresh to retry.');
    }).finally(() => { if (current()) setLoading(false); });
    return () => controller.abort();
  }, [cursor, revision, scope, grant.id, grant.ownerUserId, grant.connectionId, grant.version, grant.nodeVersion]);
  return <main className="h-dvh overflow-y-auto bg-slate-50 px-3 py-5 text-sm text-slate-800 sm:px-6" aria-label={t('Shared resource directory')}>
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><Button size="sm" variant="ghost" onClick={back}>← {t('Authorizations')}</Button><h1 className="mt-2 text-base font-semibold">{t('Shared sessions')}</h1></div>
        <Button size="sm" variant="secondary" disabled={loading || denied} onClick={() => setRevision(value => value + 1)}>{t('Refresh')}</Button>
      </header>
      <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">{t('Owner: {owner} · Node connection: {connection}', { owner: grant.ownerUserId, connection: grant.connectionId })}</p>
      <p className="text-xs text-slate-500">{t('Last-known resources under this authorization, not live execution status. Listing a session does not grant message access. Pages may change between reads.')}</p>
      {loading ? <p role="status">{t('Loading shared resources…')}</p> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      {page ? <>
        {!page.sessions.length ? <p>{t('No known resources on this page. This does not confirm node connectivity or task completion.')}</p> : null}
        <ul className="space-y-3">
          {page.sessions.map(item => {
            let href: string | undefined;
            try { if (item.sessionId) href = `#/session/${encodeURIComponent(sessionAddress({ ownerUserId: grant.ownerUserId, sessionId: item.sessionId }).key)}`; }
            catch { /* Invalid hints never fall back to the owner's catalog. */ }
            return <li key={item.sessionKey} style={item.sessionId ? { borderLeft: `4px solid ${sessionTone(item.sessionId).accent}` } : undefined} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 [overflow-wrap:anywhere]">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{item.sessionKey}</h2>
                {href ? <a className="text-xs text-blue-700 underline" href={href}>{t('Open session')}</a> : <span className="text-xs text-slate-500">{t('Message access not available')}</span>}
              </div><p className="mt-1 text-xs text-slate-500">{t('Runtime: {runtime}', { runtime: item.runtime })}</p>
            </li>;
          })}
        </ul>
      </> : null}
      <nav className="flex flex-wrap items-center gap-2" aria-label={t('Shared resource pages')}>
        <Button size="sm" variant="secondary" disabled={loading || denied || !cursor} onClick={() => setCursor(undefined)}>{t('First page')}</Button>
        <Button size="sm" variant="secondary" disabled={loading || denied || !page?.nextCursor} onClick={() => setCursor(page?.nextCursor ?? undefined)}>{t('Next page')}</Button>
        <span className="text-xs text-slate-500">{t('Up to 50 resources per page · one node')}</span>
      </nav>
    </div>
  </main>;
}
