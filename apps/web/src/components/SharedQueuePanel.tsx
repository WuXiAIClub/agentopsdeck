import { useEffect, useRef, useState } from 'react';
import type { SharedQueuedCommandPage } from '@agentopsdeck/shared';
import { api, ApiResponseError, AuthRequiredError, recoveryScope } from '../api';
import { CommandJournal } from '../lib/command-recovery';
import { mutateQueueWithRecovery } from '../lib/queue-submission';
import { Button } from './ui/button';
import { useI18n, type TranslationKey } from '../lib/i18n';

type Entry = SharedQueuedCommandPage['items'][number];

/** On-demand actor-only metadata, one historical issuer page at a time. This
 * list is never merged with transcript text or used to infer run completion. */
export function SharedQueuePanel({ sessionKey, revision, onChanged, onDenied }: {
  sessionKey: string; revision: number; onChanged: () => Promise<void>; onDenied: () => void;
}) {
  const { t } = useI18n();
  const scope = recoveryScope();
  const [cursor, setCursor] = useState<string>();
  const [refreshId, setRefreshId] = useState(0);
  const [page, setPage] = useState<SharedQueuedCommandPage>();
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | ''>('');
  const [rawError, setRawError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const [unresolved, setUnresolved] = useState(new Set<string>());
  const [storageFailed, setStorageFailed] = useState(false);
  const mounted = useRef(false), mutation = useRef(false);
  const deny = useRef(onDenied); deny.current = onDenied;
  useEffect(() => {
    mounted.current = true;
    const read = () => {
      try {
        const rows = scope ? new CommandJournal(window.sessionStorage).list(scope, sessionKey, 'all') : [];
        setUnresolved(new Set(rows.filter(row => row.queue && row.state === 'outcome_unknown').map(row => row.queue!.messageId)));
        setStorageFailed(!scope);
      } catch { setStorageFailed(true); }
    };
    read(); window.addEventListener('agentopsdeck:commands-changed', read);
    return () => { mounted.current = false; window.removeEventListener('agentopsdeck:commands-changed', read); };
  }, [sessionKey, scope]);
  useEffect(() => {
    setPage(undefined);
    setRawError('');
    if (denied) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && scope === recoveryScope();
    setLoading(true);
    void api.sharedQueuedMessages(sessionKey, cursor, controller.signal).then(next => {
      if (current()) setPage(next);
    }).catch(cause => {
      if (!current()) return;
      const forbidden = cause instanceof AuthRequiredError || cause instanceof ApiResponseError && [401, 403].includes(cause.status);
      if (forbidden) { setDenied(true); deny.current(); }
      setNotice(forbidden ? 'Shared queue access is unavailable.' : 'Queue unavailable. Refresh to retry; no operation was repeated.');
    }).finally(() => { if (current()) setLoading(false); });
    return () => controller.abort();
  }, [sessionKey, scope, cursor, refreshId, revision, denied]);
  const blocked = (entry: Entry) => busy || loading || denied || storageFailed || !scope || page?.availability !== 'available'
    || !entry.commandKey || entry.commandState !== 'accepted' || !['queued', 'blocked'].includes(entry.state)
    || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(entry.version) || unresolved.has(entry.commandKey);
  async function cancel(entry: Entry) {
    if (mutation.current || blocked(entry) || !entry.commandKey) return;
    if (confirmation !== `${entry.commandKey}:${entry.version}`) { setConfirmation(`${entry.commandKey}:${entry.version}`); return; }
    mutation.current = true; setBusy(true); setNotice(''); setRawError(''); setConfirmation(undefined);
    const current = () => mounted.current && scope === recoveryScope();
    try {
      await mutateQueueWithRecovery(scope, sessionKey, 'cancel', entry.commandKey, entry.version);
      if (current()) { setConfirmation(undefined); setNotice('Cancellation accepted.'); setRefreshId(value => value + 1); await onChanged(); }
    } catch (cause) {
      if (current()) {
        setNotice('Cancellation not confirmed. Check the saved receipt.');
        if (cause instanceof Error) setRawError(cause.message);
      }
    } finally { mutation.current = false; if (current()) setBusy(false); }
  }
  return <section className="min-w-0 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950" aria-label={t('My shared queue')}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{t('My queued commands')}</h2>
      <Button size="sm" variant="secondary" disabled={loading || busy || denied} onClick={() => { setNotice(''); setRefreshId(value => value + 1); }}>{t('Refresh queue')}</Button>
    </header>
    <p className="mt-2">{t('Only this account’s commands, across historical node credentials. This is a queue observation, not execution status. Text editing is unavailable without a matching text/version snapshot.')}</p>
    {loading ? <p role="status" className="mt-2">{t('Loading queued commands…')}</p> : null}
    {notice ? <p role="status" className="mt-2 [overflow-wrap:anywhere]">{t(notice)}</p> : null}
    {rawError ? <details className="mt-2 [overflow-wrap:anywhere]"><summary>{t('Technical details')}</summary>{rawError}</details> : null}
    {storageFailed ? <p role="alert" className="mt-2">{t('Recovery records unavailable. Queue modifications are disabled.')}</p> : null}
    {page?.availability === 'unavailable' ? <p role="status" className="mt-2">{t('This historical queue segment is unavailable, not empty. Refresh it or continue to the next segment.')}</p> : null}
    {page?.availability === 'available' && page.items.length === 0 ? <p className="mt-2">{t('No queued commands in this segment. This does not confirm that execution has finished.')}</p> : null}
    <ul className="mt-3 space-y-2">
      {page?.items.map((entry, index) => <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-2" key={`${entry.commandKey ?? 'unmapped'}:${entry.version}:${index}`}>
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <p>{entry.commandKey ?? t('Original command mapping unavailable')}</p>
          <p className="mt-1">{t('Queue')}: {t(entry.state)} · {t('Admission')}: {t(entry.commandState ?? 'unknown')}</p>
          {entry.commandKey && unresolved.has(entry.commandKey) ? <p>{t('Modification outcome unknown · check the saved receipt before another change.')}</p> : null}
        </div>
        <Button size="sm" variant="secondary" disabled={blocked(entry)} onClick={() => void cancel(entry)}>{t(confirmation === `${entry.commandKey}:${entry.version}` ? 'Confirm cancel' : 'Cancel queued command')}</Button>
        {confirmation === `${entry.commandKey}:${entry.version}` ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmation(undefined)}>{t('Keep queued')}</Button> : null}
      </li>)}
    </ul>
    <nav className="mt-3 flex flex-wrap gap-2" aria-label={t('Shared queue pages')}>
      <Button size="sm" variant="secondary" disabled={loading || busy || denied || !cursor} onClick={() => { setNotice(''); setCursor(undefined); }}>{t('First segment')}</Button>
      <Button size="sm" variant="secondary" disabled={loading || busy || denied || !page?.nextCursor} onClick={() => { setNotice(''); setCursor(page?.nextCursor ?? undefined); }}>{t('Next segment')}</Button>
    </nav>
  </section>;
}
