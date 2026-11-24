import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConnectorLifecycleJob, ConnectorLifecycleReceipt, ConnectorLifecycleStatus } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope, subscribeRecoveryScope } from '../api';
import { CommandJournal, newCommandKey, type LifecycleTarget, type PendingCommand } from '../lib/command-recovery';
import { useI18n, translate, type TranslationKey } from '../lib/i18n';
import { Button } from './ui/button';
import { confirmAction } from './ui/confirm';
import { lifecyclePollDelay, mergeLifecycleObservation, readLifecycleReceipt, readLifecycleStatus } from '../lib/lifecycle-observation';

const identity = (row: PendingCommand) => JSON.stringify([row.scope, row.lifecycle?.connectionId, row.lifecycle?.operation, row.key]);
const stages: Record<ConnectorLifecycleJob['stage'], TranslationKey> = {
  prepare: 'Preparing pinned release', drain: 'Waiting for running work to finish', fence: 'Pausing new work',
  recheck: 'Verifying native idle', unfence: 'Allowing queued work to drain', stop: 'Stopping Connector', stopped: 'Verifying service stopped',
  backup: 'Backing up node state', activate: 'Selecting verified release', start: 'Starting Connector', ready: 'Verifying session history',
  release: 'Resuming new work', succeeded: 'Maintenance completed', attention: 'Operator inspection required',
  cancelled: 'Maintenance cancelled before stopping; no deployment performed',
};

// Scoped to the Gateway, not one connection row, so deletion/collapse does not
// discard the only saved command identity. All automatic refreshes are GETs.
export function useLifecycleRecovery() {
  // A→B→A can occur in a single event; observing the epoch rather than just
  // the final account ensures stale state is retired even without a parent render.
  const epoch = useSyncExternalStore(subscribeRecoveryScope, recoveryEpoch, recoveryEpoch);
  const scope = recoveryScope();
  const [rows, setRows] = useState<PendingCommand[]>([]);
  const [results, setResults] = useState<Record<string, ConnectorLifecycleReceipt>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string[]>([]);
  const mounted = useRef(false), flights = useRef(new Map<string, AbortController>());
  const observed = useRef<Record<string, ConnectorLifecycleReceipt>>({});
  const schedule = useRef(new Map<string, { failures: number; after: number }>());
  const refresh = useCallback(() => {
    try { setRows(scope ? new CommandJournal(window.sessionStorage).list(scope, undefined, 'lifecycle') : []); setError(undefined); }
    catch { setError('Recovery storage unavailable'); }
  }, [scope, epoch]);
  useEffect(() => {
    mounted.current = true; observed.current = {}; schedule.current.clear(); setRows([]); setResults({}); setBusy([]); refresh();
    return () => { mounted.current = false; flights.current.forEach(controller => controller.abort()); flights.current.clear(); };
  }, [refresh]);
  const current = () => mounted.current && !!scope && recoveryScope() === scope && recoveryEpoch() === epoch;
  const authorize = () => { if (!current()) throw new Error('Authenticated account or page changed; reload before continuing'); };
  async function run(row: PendingCommand, submit: boolean) {
    const id = identity(row);
    if (!row.lifecycle || flights.current.has(id)) return;
    const controller = new AbortController(); flights.current.set(id, controller); setBusy([...flights.current.keys()]);
    let unavailable = true;
    try {
      authorize(); if (row.scope !== scope) throw new Error('Saved command belongs to a different account');
      const raw = await (submit ? api.hubLifecycleCommand : api.hubLifecycleReceipt)(row.lifecycle, row.key, row.scope, controller.signal);
      controller.signal.throwIfAborted(); authorize();
      const response = readLifecycleReceipt(raw, row.key, row.lifecycle);
      const merged = mergeLifecycleObservation(observed.current[id], response);
      if (response.command.state !== 'outcome_unknown') new CommandJournal(window.sessionStorage).settle(row, response.command.state);
      observed.current = { ...observed.current, [id]: merged }; setResults(observed.current);
      unavailable = response.observationUnavailable;
      refresh();
    } catch { if (current() && !controller.signal.aborted) {
      const previous = observed.current[id];
      if (previous) {
        observed.current = { ...observed.current, [id]: { ...previous, observationUnavailable: true } };
        setResults(observed.current);
      }
      setError('Original receipt unavailable');
    } }
    finally { if (flights.current.get(id) === controller) {
      flights.current.delete(id);
      if (current()) {
        const failures = unavailable ? (schedule.current.get(id)?.failures ?? 0) + 1 : 0;
        schedule.current.set(id, { failures, after: Date.now() + lifecyclePollDelay(failures) });
        setBusy([...flights.current.keys()]);
      }
    } }
  }
  const poll = useRef<() => void>(() => {});
  poll.current = () => {
    if (document.visibilityState !== 'visible') return;
    for (const row of rows) {
      if (row.scope !== scope) continue;
      const id = identity(row), result = results[id], stage = result?.job?.stage;
      if ((schedule.current.get(id)?.after ?? 0) > Date.now()) continue;
      if (result?.observationUnavailable || stage !== 'succeeded' && stage !== 'attention' && stage !== 'cancelled') void run(row, false);
    }
  };
  useEffect(() => { const timer = window.setInterval(() => poll.current(), 5000); return () => clearInterval(timer); }, [scope, epoch]);
  async function send(target: LifecycleTarget) {
    authorize();
    const row = new CommandJournal(window.sessionStorage).beginLifecycle(scope!, target, newCommandKey());
    refresh();
    await run(row, true);
  }
  function dismiss(row: PendingCommand) {
    authorize();
    const result = results[identity(row)];
    if (row.scope !== scope || !['succeeded', 'cancelled'].includes(result?.job?.stage ?? '') || result?.observationUnavailable) return;
    new CommandJournal(window.sessionStorage).forget(row); refresh();
  }
  return { scope, epoch, rows: rows.filter(row => row.scope === scope), results, error, busy, send, query: (row: PendingCommand) => run(row, false), dismiss,
    blocked: (id: string) => !scope || !!error || rows.some(row => row.scope === scope && row.lifecycle?.connectionId === id) };
}
export type LifecycleRecovery = ReturnType<typeof useLifecycleRecovery>;

export function LifecycleRecoveryNotice({ recovery }: { recovery: LifecycleRecovery }) {
  const { t } = useI18n();
  if (!recovery.rows.length && !recovery.error) return null;
  return <section className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs" aria-label={t('Connector lifecycle')}>
    <h3 className="font-semibold">{t('Connector lifecycle')}</h3>
    {recovery.error && <p role="alert" className="text-amber-800">{translate(recovery.error)}</p>}
    {recovery.rows.map(row => {
      const result = recovery.results[identity(row)], job = result?.job;
      return <div key={identity(row)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-2">
        <div className="min-w-0"><p className="break-all font-medium">{row.lifecycle!.connectionId} · {t(row.lifecycle!.operation === 'restart' ? 'Restart Connector' : 'Upgrade to main')}</p>
          <p role="status">{job ? t(stages[job.stage]) : t('Checking original maintenance receipt…')}</p>
          {(result?.observationUnavailable || !job) && <p className="text-slate-500">{t('Outcome not confirmed. The command will not be resent.')}</p>}
          {job?.stage === 'attention' && <p className="text-amber-800">{t('Inspect the node and its original maintenance journal. Do not retry or restore old data automatically.')}</p>}
        </div>
        <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={recovery.busy.includes(identity(row))} onClick={() => void recovery.query(row)}>{t('Refresh status')}</Button>
          {(job?.stage === 'succeeded' || job?.stage === 'cancelled') && !result?.observationUnavailable && <Button size="sm" variant="ghost" onClick={() => recovery.dismiss(row)}>{t('Dismiss')}</Button>}</div>
      </div>;
    })}
  </section>;
}

export function LifecycleControls({ connectionId, recovery }: { connectionId: string; recovery: LifecycleRecovery }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ConnectorLifecycleStatus>(), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const lifetime = useRef(0), pending = useRef(false);
  useEffect(() => {
    lifetime.current++; setStatus(undefined); setError(false); setBusy(false);
    return () => { lifetime.current++; };
  }, [connectionId, recovery.scope, recovery.epoch]);
  async function refresh() {
    if (!recovery.scope || pending.current) return;
    const version = lifetime.current;
    const current = () => version === lifetime.current && recoveryScope() === recovery.scope && recoveryEpoch() === recovery.epoch;
    pending.current = true; setBusy(true); setError(false);
    try { const next = readLifecycleStatus(await api.hubLifecycleStatus(connectionId, recovery.scope)); if (current()) setStatus(next); }
    catch { if (current()) { setError(true); setStatus(undefined); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function send(operation: LifecycleTarget['operation']) {
    if (pending.current || recovery.blocked(connectionId) || !status?.configured || status.blocked || status.workerState !== 'running'
      || !status.operations.includes(operation)) return;
    const version = lifetime.current;
    pending.current = true; setBusy(true);
    try {
      if (!await confirmAction({ title: t(operation === 'restart' ? 'Restart Connector' : 'Upgrade to main'),
        description: t('Waits for idle, backs up stopped state, then verifies session history. No active work is cancelled. Acceptance is not completion.'),
        confirmLabel: t('Confirm maintenance') })) return;
      if (version !== lifetime.current || recoveryScope() !== recovery.scope || recoveryEpoch() !== recovery.epoch) return;
      await recovery.send({ connectionId, operation });
      if (version === lifetime.current) setStatus(undefined);
    } catch { if (version === lifetime.current) setError(true); }
    finally { pending.current = false; if (version === lifetime.current) setBusy(false); }
  }
  return <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-xs sm:col-span-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><b>{t('Connector lifecycle')}</b><Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>{t('Check lifecycle support')}</Button></div>
    {error && <p role="alert">{t('Independent Connector maintenance unavailable')}</p>}
    {status?.configured === false && <p>{t('Remote maintenance is not configured. Install an independent node supervisor and opt in on the Hub.')}</p>}
    {status?.configured && <><p>{status.blocked ? t('Existing maintenance needs to finish or be inspected.') : t('Maintenance is available. Automatic updates are off.')}</p>
      {status.job && <div role="status" className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="font-medium">{t(status.job.operation === 'restart' ? 'Restart Connector' : 'Upgrade to main')} · {t(stages[status.job.stage])}</p>
        <p className="break-all font-mono text-[11px] text-slate-500">{status.job.id}</p>
        {status.job.stage === 'attention' && <p className="text-amber-800">{t('Inspect the node and its original maintenance journal. Do not retry or restore old data automatically.')}</p>}
      </div>}
      <div className="flex flex-wrap gap-2">{status.operations.map(operation => <Button key={operation} size="sm" variant="secondary"
        disabled={busy || recovery.blocked(connectionId) || status.blocked || status.workerState !== 'running'} onClick={() => void send(operation)}>
        {t(operation === 'restart' ? 'Restart Connector' : 'Upgrade to main')}</Button>)}</div></>}
  </div>;
}
