import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { api, invalidateSnapshotReads, recoveryEpoch, recoveryScope } from '../api';
import { CommandJournal, commandIdentity, creationReceiptState, messageReceiptResponse, recoverSavedCommand, type CreationTarget, type PendingCommand } from '../lib/command-recovery';
import { publishRecoveredMessage } from '../lib/message-submission';
import { createReceiptRecoveryLoop, receiptFailureKind } from '../lib/receipt-recovery-loop';
import { Button } from './ui/button';
import { isActiveSessionCreation } from '../lib/session-creation';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { confirmAction } from './ui/confirm';
const LazyResendMessage = lazy(() => import('./ResendMessage').then(module => ({ default: module.ResendMessage })));
const ResendMessage = (props: React.ComponentProps<typeof LazyResendMessage>) => <Suspense fallback={null}><LazyResendMessage {...props} /></Suspense>;

type RecoveryProps = { sessionKey?: string; onRecovered: () => Promise<void>; onCreated?: (key: string, target: CreationTarget) => void };

export { useRetireOpenedCreation } from '../lib/use-retire-opened-creation';

export function CommandRecoveryNotice(props: RecoveryProps) {
  // Changing sessions cancels the old bounded sweep and discards its UI state.
  return <RecoveryForSession key={`${recoveryScope()}:${props.sessionKey}`} {...props} />;
}

function RecoveryForSession({ sessionKey, onRecovered, onCreated }: RecoveryProps) {
  const { t } = useI18n();
  const scope = recoveryScope();
  const [rows, setRows] = useState<PendingCommand[]>([]);
  const [error, setError] = useState<{ key: TranslationKey; raw?: string }>();
  const [failures, setFailures] = useState<Record<string, TranslationKey>>({});
  // Presentation only: a failed local save cannot undo a validated receipt.
  // The journal still owns fences, available actions, and automatic recovery.
  const [observedOutcomes, setObservedOutcomes] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [createdPage, setCreatedPage] = useState(0);
  const run = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const onRecoveredRef = useRef(onRecovered);
  onRecoveredRef.current = onRecovered;

  function read() {
    try {
      const records = scope ? new CommandJournal(window.sessionStorage).list(scope, sessionKey, sessionKey === undefined ? 'creation' : 'all').filter(row => !isActiveSessionCreation(row)) : [];
      if (mounted.current) {
        setRows(records);
        const identities = new Set(records.map(commandIdentity));
        setFailures(previous => Object.keys(previous).some(id => !identities.has(id))
          ? Object.fromEntries(Object.entries(previous).filter(([id]) => identities.has(id))) : previous);
        setObservedOutcomes(previous => Object.keys(previous).some(id => !identities.has(id))
          ? Object.fromEntries(Object.entries(previous).filter(([id]) => identities.has(id))) : previous);
        if (!records.length) setError(undefined);
      }
      return records;
    } catch (failure) {
      if (mounted.current) setError({ key: 'Recovery storage unavailable', ...(failure instanceof Error ? { raw: failure.message } : {}) });
      return [];
    }
  }

  async function check(records: PendingCommand[], openCreated = false) {
    if (run.current || !scope || !records.length) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true); setError(undefined);
    let resolved = false;
    let created: { key: string; target: CreationTarget; row: PendingCommand } | undefined;
    try {
      for (const row of records.slice(0, 4)) {
        if (controller.signal.aborted || recoveryScope() !== scope) break;
        if (row.maintenance || row.lifecycle) continue; // Node maintenance has a separate UI, not a session endpoint.
        try {
          let persistenceFailed = false;
          let releaseChanged = false;
          let recoveredResponse: ReturnType<typeof messageReceiptResponse>;
          const state = await recoverSavedCommand(new CommandJournal(window.sessionStorage), row, async () => {
            const result = row.creation ? await api.creationCommand(row.creation, row.key, scope, controller.signal)
              : row.queue ? await api.queueMutationCommand(row.sessionKey, row.queue.messageId, row.key, scope, controller.signal)
              : row.deletion ? await api.deletionCommand(row.sessionKey, row.key, scope, controller.signal)
              : row.settings ? await api.settingsCommand(row.sessionKey, row.key, scope, controller.signal)
              : row.compact ? await api.compactCommand(row.sessionKey, row.key, scope, controller.signal)
              : await api.messageCommand(row.sessionKey, row.key, scope, controller.signal);
            if (controller.signal.aborted || recoveryScope() !== scope) throw new Error('Recovery cancelled');
            recoveredResponse = messageReceiptResponse(row, result.command);
            releaseChanged = !!row.settings && !row.settingsStartReleased && result.command.settingsStartReleased === true;
            if (openCreated && row.creation && creationReceiptState(result.command, row.key, row.creation) === 'accepted') {
              created = { key: result.command.result!.body.key as string, target: row.creation, row };
            }
            return result.command;
          }, () => { persistenceFailed = true; });
          if (recoveredResponse && row.sessionKey) publishRecoveredMessage(scope, row.sessionKey, row.key, recoveredResponse);
          if (openCreated && row.creation && state !== 'accepted') throw new Error('Session link not confirmed');
          if ((row.settings || row.compact) && state === 'accepted') invalidateSnapshotReads();
          const changed = row.state !== state && (state === 'accepted' || state === 'rejected');
          resolved ||= changed || !!recoveredResponse;
          setObservedOutcomes(previous => {
            const next = { ...previous };
            if (persistenceFailed && state !== 'outcome_unknown') next[commandIdentity(row)] = state;
            else delete next[commandIdentity(row)];
            return next;
          });
          setFailures(previous => {
            const next = { ...previous };
            if (persistenceFailed) next[commandIdentity(row)] = state === 'accepted'
              ? 'Server confirmed acceptance, but browser recovery storage could not be updated. Nothing was resent.'
              : state === 'rejected' ? 'Server confirmed rejection, but browser recovery storage could not be updated. Nothing was resent.'
                : 'Receipt checked, but browser recovery storage could not be updated. Nothing was resent; check again before refreshing.';
            else delete next[commandIdentity(row)];
            return next;
          });
          if (!persistenceFailed && (changed || releaseChanged || recoveredResponse)) window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
        } catch (failure) {
          if (!controller.signal.aborted && mounted.current && recoveryScope() === scope) {
            const kind = receiptFailureKind(failure);
            const key: TranslationKey = row.state !== 'outcome_unknown'
              ? row.state === 'accepted' ? 'Receipt unavailable. The saved accepted outcome is unchanged; nothing was resent.'
                : 'Receipt unavailable. The saved rejected outcome is unchanged; nothing was resent.'
              : kind === 'missing' ? 'Receipt not found. Delivery remains unknown; do not resend. Automatic checks will continue.'
                : kind === 'denied' ? 'Receipt access denied. Check session permissions; nothing was resent.'
                  : kind === 'auth' ? 'Sign in to the same account to check this receipt; nothing was resent.'
                    : 'Receipt unavailable. Retrying automatically; nothing was resent.';
            if (row.creation && row.state === 'accepted') setError({ key });
            else setFailures(previous => ({ ...previous, [commandIdentity(row)]: key }));
          }
        }
        if (!controller.signal.aborted) read();
      }
      if (resolved && !controller.signal.aborted) await onRecoveredRef.current().catch(() => undefined);
      if (created && !controller.signal.aborted && recoveryScope() === scope && onCreated) {
        // Explicitly opening the recovered session acknowledges this local
        // shortcut. A background receipt check must never dismiss or navigate.
        try {
          onCreated(created.key, created.target);
          new CommandJournal(window.sessionStorage).forget(created.row);
          window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
          read();
        } catch { if (mounted.current) setError({ key: 'Could not finish opening the session. Your saved shortcut is still available.' }); }
      }
    } finally {
      if (run.current === controller) {
        run.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const recovery = createReceiptRecoveryLoop({
      read: () => read().filter(row => !row.settingsStartReleased && !row.maintenance && !row.lifecycle
        && (row.state === 'outcome_unknown' || (row.state === 'accepted' && row.sessionKey
          && !row.queue && !row.deletion && !row.settings && !row.compact && !row.creation))),
      identity: commandIdentity,
      check,
      enabled: () => document.visibilityState !== 'hidden' && navigator.onLine !== false && recoveryScope() === scope,
      busy: () => run.current !== null,
    });
    recovery.request(true);
    const changed = () => recovery.request();
    const connectivity = () => recovery.request(document.visibilityState !== 'hidden' && navigator.onLine !== false);
    window.addEventListener('agentopsdeck:commands-changed', changed);
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    document.addEventListener('visibilitychange', connectivity);
    return () => {
      mounted.current = false;
      recovery.stop();
      run.current?.abort();
      window.removeEventListener('agentopsdeck:commands-changed', changed);
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
      document.removeEventListener('visibilitychange', connectivity);
    };
  }, []);

  async function forget(row: PendingCommand) {
    const epoch = recoveryEpoch();
    if ((row.queue || row.deletion || row.settings || row.compact) && row.state === 'outcome_unknown') return;
    if (row.state === 'outcome_unknown' && !await confirmAction({ title: t('Forget local recovery record?'),
      description: t('The command may already be running. This only removes the local record; it does not cancel the command or make resending safe.'),
      confirmLabel: t('Forget locally') })) return;
    if (!mounted.current || recoveryScope() !== scope || recoveryEpoch() !== epoch) return;
    try {
      new CommandJournal(window.sessionStorage).forget(row);
      setError(undefined);
      read();
      window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
    }
    catch { setError({ key: 'Could not update local recovery records' }); }
  }

  if (!rows.length && !error) return null;
  const creations = rows.filter(row => row.creation && row.state === 'accepted');
  const recovery = rows.filter(row => !row.creation || row.state !== 'accepted');
  const currentPage = Math.min(page, Math.max(0, Math.ceil(recovery.length / 4) - 1));
  const currentCreatedPage = Math.min(createdPage, Math.max(0, Math.ceil(creations.length / 4) - 1));
  return <>
    {creations.length ? <section className="mb-2 min-w-0 space-y-1 text-xs text-slate-600" aria-label={t('Created sessions')}>
      {creations.slice(currentCreatedPage * 4, currentCreatedPage * 4 + 4).map(row => <div key={JSON.stringify([row.creation, row.key])}
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200/70 bg-slate-50/60 px-3 py-1.5">
        <CheckCircle2 size={14} className="shrink-0 text-emerald-600" aria-hidden="true" />
        <span className="font-medium text-slate-700">{t('Session created')}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500" title={`${row.creation!.connectionId} / ${row.creation!.agentId}`}>{row.creation!.connectionId}</span>
        {onCreated ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2" disabled={busy} onClick={() => void check([row], true)}>{t('Open session')}</Button> : null}
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={busy} aria-label={t('Dismiss created session notice')} title={t('Dismiss')} onClick={() => void forget(row)}><X size={14} /></Button>
      </div>)}
      {creations.length > 4 ? <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={currentCreatedPage === 0 || busy} onClick={() => setCreatedPage(currentCreatedPage - 1)}>{t('Previous')}</Button>
        <span>{currentCreatedPage + 1} / {Math.ceil(creations.length / 4)}</span>
        <Button type="button" size="sm" variant="ghost" disabled={(currentCreatedPage + 1) * 4 >= creations.length || busy} onClick={() => setCreatedPage(currentCreatedPage + 1)}>{t('Next')}</Button>
      </div> : null}
    </section> : null}
    {error ? <div className="mb-2 text-xs text-slate-600"><p role="status">{t(error.key)}</p>{error.raw ? <details><summary>{t('Technical details')}</summary>{error.raw}</details> : null}</div> : null}
    {recovery.length ? <section className="mb-2 min-w-0 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950" aria-label={t('Command delivery recovery')}>
    <p role="status">{t('Delivery recovery · {count} saved', { count: recovery.length })}{busy ? ` · ${t('checking receipts…')}` : ''}</p>
    {recovery.slice(currentPage * 4, currentPage * 4 + 4).map((row) => <div key={JSON.stringify([row.creation, row.sessionKey, row.key])} className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 break-words" title={row.key}>
        {observedOutcomes[commandIdentity(row)] ? t(observedOutcomes[commandIdentity(row)] === 'accepted'
          ? 'Accepted — execution may still be queued or running.' : 'Rejected — this command was not admitted.')
          : row.creation ? t('Session creation ({connection} / {agent}) — {outcome}', { connection: row.creation.connectionId, agent: row.creation.agentId,
            outcome: t(row.state === 'rejected' ? 'rejected; review before trying again.' : 'outcome unknown; check receipt, do not create again.') })
          : row.queue ? t('{operation} — {outcome}', { operation: t(row.queue.action === 'edit' ? 'Queue edit' : 'Queue cancellation'), outcome: t(row.state === 'accepted' ? 'applied.' : row.state === 'rejected' ? 'rejected; refresh before a new change.' : 'outcome unknown; check receipt, do not repeat.') })
          : row.deletion ? t('{operation} — {outcome}', { operation: t('Session deletion'), outcome: t(row.state === 'accepted' ? 'accepted; view cleanup may still be pending.' : row.state === 'rejected' ? 'rejected; review before trying again.' : 'outcome unknown; check receipt, do not delete again.') })
          : row.settings ? t('{operation} — {outcome}', { operation: t('Session settings'), outcome: t(row.settingsStartReleased ? 'Original outcome remains unknown; starts were released by an audited recovery. Reload before a new change.' : row.state === 'accepted' ? 'applied; the view may still be catching up.' : row.state === 'rejected' ? 'rejected; review before trying again.' : 'outcome unknown; check receipt, do not repeat.') })
          : row.compact ? t('{operation} — {outcome}', { operation: t('Compact'), outcome: t(row.state === 'accepted' ? 'Compaction accepted; waiting for native completion.' : row.state === 'rejected' ? 'rejected; review before trying again.' : 'outcome unknown; check receipt, do not repeat.') })
          : t(row.state === 'accepted' ? 'Accepted — execution may still be queued or running.' : row.state === 'rejected' ? 'Rejected — this command was not admitted.' : 'Delivery unknown — may already be running; not resent.')}
        <span className="ml-1 opacity-70">{row.key.slice(-8)}</span>
        {failures[commandIdentity(row)] ? <span className="mt-1 block text-xs font-normal" role="status">{t(failures[commandIdentity(row)]!)}</span> : null}
      </span>
      {row.state === 'outcome_unknown' ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void check([row])}>{t('Check receipt')}</Button> : null}
      {row.state === 'outcome_unknown' && row.sessionKey && !row.queue && !row.deletion && !row.settings && !row.compact && !row.lifecycle && !row.maintenance && <ResendMessage sessionKey={row.sessionKey} commandKey={row.key} />}
      {!((row.queue || row.deletion || row.settings || row.compact) && row.state === 'outcome_unknown') ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void forget(row)}>{t(row.state === 'outcome_unknown' ? 'Forget locally' : 'Dismiss')}</Button> : null}
    </div>)}
    {recovery.length > 4 ? <div className="mt-2 flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={currentPage === 0 || busy} onClick={() => setPage(currentPage - 1)}>{t('Previous')}</Button>
      <span>{currentPage + 1} / {Math.ceil(recovery.length / 4)}</span>
      <Button type="button" size="sm" variant="ghost" disabled={(currentPage + 1) * 4 >= recovery.length || busy} onClick={() => setPage(currentPage + 1)}>{t('Next')}</Button>
    </div> : null}
  </section> : null}</>;
}
