import { useCallback, useEffect, useRef, useState } from 'react';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { ConnectionControlJournal, type ConnectionControlTarget, type PendingConnectionControl } from '../lib/connection-control-recovery';
import { Button } from './ui/button';
import { useI18n, translate } from '../lib/i18n';

export function useConnectionControlRecovery() {
  const scope = recoveryScope(), epoch = recoveryEpoch(), mounted = useRef(false);
  const [saved, setSaved] = useState<{scope?: string; rows: PendingConnectionControl[]; readable: boolean; error?: string}>({rows: [], readable: false});
  const [checking, setChecking] = useState<string[]>([]);
  const flights = useRef(new Map<string, AbortController>());
  const journal = () => new ConnectionControlJournal(window.sessionStorage);
  const refresh = useCallback(() => {
    try { setSaved({...(scope ? {scope} : {}), rows: scope ? journal().list(scope) : [], readable: true}); }
    catch (error) {setSaved({...(scope ? {scope} : {}), rows: [], readable: false, error: error instanceof Error ? error.message : 'Recovery storage unavailable'});}
  }, [scope, epoch]);
  useEffect(() => {
    mounted.current = true; setChecking([]); refresh();
    return () => {mounted.current = false; for (const controller of flights.current.values()) controller.abort(); flights.current.clear();};
  }, [refresh]);
  const authorize = () => {
    if (!mounted.current || !scope || epoch !== recoveryEpoch() || scope !== recoveryScope()) throw new Error('Authenticated account or page changed; reload before continuing');
  };
  async function send(target: ConnectionControlTarget) {
    authorize();
    const row = journal().begin(scope!, target); // Synchronous durable intent BEFORE any dispatch.
    refresh();
    try {
      authorize();
      const result = row.operation === 'reconcile' ? await api.hubReconcileModelSet(row.connectionId, row.key, row.scope)
        : await api.hubCheckUpdate(row.connectionId, row.key, row.scope);
      authorize();
      journal().settle(row, {key: row.key, operation: row.operation, state: 'accepted', status: 200});
      return result;
    } finally {if (mounted.current && epoch === recoveryEpoch() && scope === recoveryScope()) refresh();}
  }
  async function query(row: PendingConnectionControl) {
    if (flights.current.has(row.key)) return;
    const controller = new AbortController(); flights.current.set(row.key, controller); setChecking([...flights.current.keys()]);
    try {
      authorize(); if (row.scope !== scope) throw new Error('Saved control belongs to a different account');
      const {command} = await api.hubControlReceipt(row, row.key, row.scope, controller.signal);
      controller.signal.throwIfAborted(); authorize(); journal().settle(row, command); refresh();
    } catch (error) {
      if (!controller.signal.aborted && mounted.current && epoch === recoveryEpoch() && scope === recoveryScope()) {
        setSaved(previous => ({...previous, error: error instanceof Error ? error.message : 'Original control receipt unavailable'}));
      }
    } finally {if (flights.current.get(row.key) === controller) {flights.current.delete(row.key); setChecking([...flights.current.keys()]);}}
  }
  function dismiss(row: PendingConnectionControl) {
    try {authorize(); if (row.scope !== scope) throw new Error('Saved control belongs to a different account'); journal().dismiss(row); refresh();}
    catch (error) {setSaved(previous => ({...previous, error: error instanceof Error ? error.message : 'Recovery storage unavailable'}));}
  }
  const rows = scope && saved.scope === scope ? saved.rows : [];
  return {rows, error: saved.scope === scope ? saved.error : undefined, checking, send, query, dismiss, refresh,
    blocked: (id: string) => !scope || saved.scope !== scope || !saved.readable || rows.some(row => row.connectionId === id && row.state === 'outcome_unknown')};
}
export type ConnectionControlRecovery = ReturnType<typeof useConnectionControlRecovery>;
export function ConnectionControlRecoveryNotice({recovery}: {recovery: ConnectionControlRecovery}) {
  const {t} = useI18n();
  if (!recovery.rows.length && !recovery.error) return null;
  return <section aria-label={t('Saved Connector controls')} className="mt-3 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
    <p className="font-semibold">{t('Saved Connector controls')}</p>
    <p>{t('Query the original request only. After confirmation, refresh current status; the control is never resent.')}</p>
    {recovery.error && <div><p role="alert" className="break-words text-red-700">{translate(recovery.error)}</p><Button size="sm" variant="secondary" onClick={recovery.refresh}>{t('Reload saved records')}</Button></div>}
    {recovery.rows.map(row => <div key={row.key} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 p-2">
      <span className="min-w-0 flex-1 break-all">{row.connectionId} · {row.operation} · {t(row.state === 'outcome_unknown' ? 'outcome unknown' : row.state === 'accepted' ? 'command completed' : 'rejected')}<span className="block text-slate-500">{row.key}</span></span>
      <Button size="sm" variant="secondary" disabled={recovery.checking.includes(row.key)} onClick={() => void recovery.query(row)}>{t('Query original receipt')}</Button>
      {row.state !== 'outcome_unknown' && <Button size="sm" variant="secondary" onClick={() => recovery.dismiss(row)}>{t('Dismiss')}</Button>}
    </div>)}
  </section>;
}
