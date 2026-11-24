import { useCallback, useEffect, useRef, useState } from 'react';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { CommandJournal, maintenanceWithJournal, newCommandKey, recoverSavedCommand, type MaintenanceTarget, type PendingCommand } from '../lib/command-recovery';
import { formatMaintenanceResult, type ConnectorMaintenanceResult, type ConnectorUpdateApplyPayload } from '../lib/maintenance-controls';
import { Button } from './ui/button';
import { useI18n, translate } from '../lib/i18n';

const identity = (scope: string, target: MaintenanceTarget, key: string) => JSON.stringify([scope, target.connectionId, target.operation, key]);

// One owner for the existing tab journal, independent of connection rows. Deleted
// connections still have a queryable original receipt; no retry timer or second ledger.
export function useMaintenanceRecovery() {
  const scope = recoveryScope();
  const epoch = recoveryEpoch();
  const [saved, setSaved] = useState<{ scope?: string | undefined; rows: PendingCommand[]; readable: boolean; error?: string | undefined }>({ rows: [], readable: false });
  const [results, setResults] = useState<Record<string, { scope: string; status: ConnectorMaintenanceResult }>>({});
  const [checking, setChecking] = useState<string[]>([]);
  const flights = useRef(new Map<string, AbortController>());
  const mounted = useRef(false);
  const refresh = useCallback(() => {
    try { setSaved({ scope, rows: scope ? new CommandJournal(window.sessionStorage).list(scope, undefined, 'maintenance') : [], readable: true }); }
    catch (error) { setSaved({ scope, rows: [], readable: false, error: error instanceof Error ? error.message : 'Recovery storage unavailable' }); }
  }, [scope, epoch]);
  useEffect(() => {
    mounted.current = true;
    setResults({}); setChecking([]); refresh();
    return () => { mounted.current = false; for (const controller of flights.current.values()) controller.abort(); flights.current.clear(); };
  }, [refresh]);
  const authorize = () => { if (!mounted.current || !scope || recoveryEpoch() !== epoch) throw new Error('Authenticated account or page changed; reload before continuing'); };
  const rows = scope && saved.scope === scope ? saved.rows : [];
  const error = saved.scope === scope ? saved.error : undefined;

  async function send(target: MaintenanceTarget, payload: ConnectorUpdateApplyPayload | { fenceId: string } | Record<string, never>) {
    authorize();
    const original = { ...target }, key = newCommandKey(), journal = new CommandJournal(window.sessionStorage);
    const pending = maintenanceWithJournal(journal, scope!, original, key,
      () => { authorize(); return api.hubMaintenanceCommand(original, key, scope!, payload); },
      async () => { authorize(); return (await api.hubMaintenanceReceipt(original, key, scope!)).command; });
    refresh(); // begin() saved unknown synchronously, blocking both apply and rollback.
    try {
      const status = await pending; authorize();
      setResults(previous => ({ ...previous, [identity(scope!, original, key)]: { scope: scope!, status } }));
      return status;
    } finally { if (mounted.current && recoveryEpoch() === epoch) refresh(); }
  }

  async function query(row: PendingCommand) {
    if (!row.maintenance) return;
    const id = identity(row.scope, row.maintenance, row.key);
    if (flights.current.has(id)) return;
    const controller = new AbortController(); flights.current.set(id, controller); setChecking([...flights.current.keys()]);
    try {
      authorize(); if (row.scope !== scope) throw new Error('Saved command belongs to a different account');
      const { command } = await api.hubMaintenanceReceipt(row.maintenance, row.key, row.scope, controller.signal);
      controller.signal.throwIfAborted(); authorize();
      await recoverSavedCommand(new CommandJournal(window.sessionStorage), row, async () => command);
      authorize();
      if (command.state === 'accepted') setResults(previous => ({ ...previous, [id]: { scope: row.scope, status: command.result!.body as ConnectorMaintenanceResult } }));
      refresh();
    } catch (cause) {
      if (!controller.signal.aborted && recoveryEpoch() === epoch) setSaved(previous => ({ ...previous, error: cause instanceof Error ? cause.message : 'Original receipt unavailable' }));
    } finally {
      if (flights.current.get(id) === controller) { flights.current.delete(id); setChecking([...flights.current.keys()]); }
    }
  }

  function dismiss(row: PendingCommand) {
    try {
      authorize(); if (row.scope !== scope) throw new Error('Saved command belongs to a different account');
      const journal = new CommandJournal(window.sessionStorage);
      const current = journal.list(scope!, undefined, 'maintenance').find(item => item.key === row.key
        && item.maintenance?.connectionId === row.maintenance?.connectionId && item.maintenance?.operation === row.maintenance?.operation);
      if (current?.state === 'outcome_unknown') throw new Error('Resolve the original receipt before dismissing');
      if (current) journal.forget(current);
      setResults(previous => { const next = { ...previous }; delete next[identity(row.scope, row.maintenance!, row.key)]; return next; }); refresh();
    } catch (cause) { setSaved(previous => ({ ...previous, error: cause instanceof Error ? cause.message : 'Recovery storage unavailable' })); }
  }

  return { rows, error, checking, send, query, dismiss, results, scope, epoch, refresh,
    blocked: (connectionId: string) => !scope || saved.scope !== scope || !saved.readable
      || rows.some(row => row.maintenance?.connectionId === connectionId && row.state === 'outcome_unknown') };
}

export type MaintenanceRecovery = ReturnType<typeof useMaintenanceRecovery>;

export function MaintenanceRecoveryNotice({ recovery }: { recovery: MaintenanceRecovery }) {
  const { t, locale } = useI18n();
  if (!recovery.rows.length && !recovery.error) return null;
  return <section aria-label={t('Connector maintenance recovery')} className="mt-3 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
    <p className="font-semibold">{t('Saved Connector maintenance')}</p>
    <p>{t('Query the original request only. Completion does not confirm a healthy version, native idle, or permission to deploy.')}</p>
    {recovery.error && <div><p role="alert" className="break-words text-red-700">{translate(recovery.error)}</p><Button size="sm" variant="secondary" className="mt-1 h-8 rounded-xl text-xs" onClick={recovery.refresh}>{t('Reload saved records')}</Button></div>}
    {recovery.rows.map(row => {
      const id = identity(row.scope, row.maintenance!, row.key), result = recovery.results[id];
      return <div key={id} data-maintenance-target={row.maintenance!.connectionId} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 p-2">
        <span className="min-w-0 flex-1 break-all">{row.maintenance!.connectionId} · {row.maintenance!.operation} · {t(row.state === 'outcome_unknown' ? 'outcome unknown' : row.state === 'rejected' ? 'rejected' : 'command completed')}
          <span className="block text-slate-500">{row.key}{result && result.scope === recovery.scope ? ` · ${formatMaintenanceResult(result.status, locale)}` : ''}</span>
        </span>
        <Button size="sm" variant="secondary" className="h-8 rounded-xl text-xs" disabled={recovery.checking.includes(id)} onClick={() => void recovery.query(row)}>{t('Query original receipt')}</Button>
        {row.state !== 'outcome_unknown' && <Button size="sm" variant="secondary" className="h-8 rounded-xl text-xs" onClick={() => recovery.dismiss(row)}>{t('Dismiss')}</Button>}
      </div>;
    })}
  </section>;
}
