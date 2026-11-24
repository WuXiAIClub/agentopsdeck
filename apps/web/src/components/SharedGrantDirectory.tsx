import { useEffect, useState } from 'react';
import type { SharedGrantPage, SharedGrantSummary } from '@agentopsdeck/shared';
import { api, ApiResponseError, AuthRequiredError, recoveryScope } from '../api';
import { sessionAddress } from '../lib/session-address';
import { Button } from './ui/button';
import { SharedResourceDirectory } from './SharedResourceDirectory';
import { sessionTone } from '../lib/session-tone';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { GlobalNotebookTrigger } from './SessionNotebook';

const availability: Record<SharedGrantSummary['availability'], TranslationKey> = {
  available: 'Current authorization · connectivity not checked',
  reauthorization_required: 'Node credentials changed · owner must reauthorize',
  disabled: 'Node disabled',
  unverified: 'Node identity not verified',
};

function sessionLink(grant: SharedGrantSummary) {
  if (grant.availability !== 'available' || !grant.sessionId) return undefined;
  try { return `#/session/${encodeURIComponent(sessionAddress({ ownerUserId: grant.ownerUserId, sessionId: grant.sessionId }).key)}`; }
  catch { return undefined; }
}

/** A single bounded Hub policy page; discovery happens only on explicit open,
 * for one named grant. No automatic catalog fan-out or polling/cache. */
export function SharedGrantDirectory({ paused }: { paused: boolean }) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | undefined>();
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SharedGrantPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TranslationKey | ''>('');
  const [denied, setDenied] = useState(false);
  const [opened, setOpened] = useState<SharedGrantSummary>();
  const [memberId, setMemberId] = useState('');
  const scope = recoveryScope();
  useEffect(() => {
    setPage(undefined); setError(''); setDenied(false); setLoading(false); setOpened(undefined); setMemberId('');
    if (paused) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && scope === recoveryScope();
    void api.hubMe().then(identity => { if (current()) setMemberId(identity.userId); }).catch(() => {});
    setLoading(true);
    void api.sharedGrants(cursor, controller.signal).then(next => {
      if (current()) setPage(next);
    }).catch(cause => {
      if (!current()) return;
      const forbidden = cause instanceof AuthRequiredError || cause instanceof ApiResponseError && [401, 403].includes(cause.status);
      setDenied(forbidden);
      setError(forbidden ? 'Shared access is unavailable. The directory has been cleared.' : 'Shared directory unavailable. Refresh to retry.');
    }).finally(() => { if (current()) setLoading(false); });
    return () => controller.abort();
  }, [cursor, revision, paused, scope]);
  const refresh = () => setRevision(value => value + 1);
  if (opened && !paused) return <SharedResourceDirectory key={JSON.stringify([scope, opened.ownerUserId, opened.connectionId, opened.id, opened.version, opened.nodeVersion])}
    grant={opened} back={() => { setOpened(undefined); refresh(); }} />;
  return <main className="h-dvh overflow-y-auto bg-slate-50 px-3 py-5 text-sm text-slate-800 sm:px-6" aria-label={t('Shared grants directory')}>
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <GlobalNotebookTrigger />
        <div className="min-w-0"><a className="text-blue-700" href="#/tab/sessions">← {t('My sessions')}</a><h1 className="mt-2 text-base font-semibold">{t('Shared with me')}</h1></div>
        <Button size="sm" variant="secondary" disabled={loading || paused || denied} onClick={refresh}>{t('Refresh')}</Button>
      </header>
      <p className="text-xs text-slate-500">{t('Your created sessions and explicit shared access. Authorization is checked again when opening a session. Environment owners and broad grants retain access; runtime files are not isolated.')}</p>
      {memberId && !paused && !denied ? <label className="block text-xs text-slate-600">{t('Your member ID · give this to a session creator to receive an invitation')}<input name="sharedgrantdirectory-input-1" aria-label={t('Your member ID')} readOnly value={memberId} onFocus={event => event.currentTarget.select()} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white p-2 font-mono" /></label> : null}
      {paused ? <p role="status">{t('Sign in to view shared authorizations.')}</p> : null}
      {loading ? <p role="status">{t('Loading shared authorizations…')}</p> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      {!paused && page ? <>
        {page.grants.length === 0 ? <p>{t('No shared authorizations on this page.')}</p> : null}
        <ul className="space-y-3">
          {page.grants.map(grant => {
            const href = sessionLink(grant), policy = grant.policy;
            return <li key={grant.id} style={grant.sessionId ? { borderLeft: `4px solid ${sessionTone(grant.sessionId).accent}` } : undefined} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 [overflow-wrap:anywhere]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{policy.sessionKey ? t(policy.actions.includes('sessions:share') ? 'My session · {session}' : 'Shared session · {session}', { session: policy.sessionKey }) : policy.agentId ? t('Agent: {agent}', { agent: policy.agentId }) : t(policy.actions.length === 1 && policy.actions.includes('sessions:create') ? 'Developer · create your own sessions' : 'All sessions · broad access')}</h2>
                {href ? <a className="text-xs text-blue-700 underline" href={href}>{t('Open session')}</a> : null}
                {grant.availability === 'available' && !policy.agentId && policy.actions.includes('sessions:read')
                  ? <Button size="sm" variant="secondary" onClick={() => setOpened(grant)}>{t('Browse sessions')}</Button> : null}
              </div>
              <p className="mt-2 text-xs text-slate-500">{t('Owner: {owner} · Node connection: {connection}', { owner: grant.ownerUserId, connection: grant.connectionId })}</p>
              <p className="mt-1 text-xs">{t('Runtime: {runtime}', { runtime: policy.runtime ?? t('All') })} · {policy.actions.join(', ')}</p>
              <p className="mt-2 text-xs">{t(availability[grant.availability])}</p>
              {!href && grant.availability === 'available' ? <p className="mt-1 text-xs text-slate-500">{policy.actions.length === 1 && policy.actions.includes('sessions:create') ? <a className="text-blue-700 underline" href="#/tab/sessions">{t('Open My sessions → New session to start chatting.')}</a> : t(policy.agentId || !policy.sessionKey ? 'Policy scope is not an exact session link.' : 'No readable session link is available for this policy.')}</p> : null}
            </li>;
          })}
        </ul>
      </> : null}
      <nav className="flex flex-wrap items-center gap-2" aria-label={t('Shared directory pages')}>
        <Button size="sm" variant="secondary" disabled={loading || paused || denied || !cursor} onClick={() => setCursor(undefined)}>{t('First page')}</Button>
        <Button size="sm" variant="secondary" disabled={loading || paused || denied || !page?.nextCursor} onClick={() => setCursor(page?.nextCursor ?? undefined)}>{t('Next page')}</Button>
        <span className="text-xs text-slate-500">{t('Up to 50 authorizations per page')}</span>
      </nav>
    </div>
  </main>;
}
