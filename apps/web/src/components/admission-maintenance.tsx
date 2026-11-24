import { useEffect, useRef, useState } from 'react';
import { api, recoveryEpoch } from '../api';
import { formatMaintenanceResult, readConnectorAdmissionStatus, type ConnectorAdmissionStatus } from '../lib/maintenance-controls';
import type { MaintenanceRecovery } from './maintenance-recovery';
import { Button } from './ui/button';
import { useI18n, translate } from '../lib/i18n';

export function AdmissionMaintenanceControls({ connectionId, recovery }: { connectionId: string; recovery: MaintenanceRecovery }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<ConnectorAdmissionStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false), active = useRef(false), controller = useRef<AbortController | undefined>(undefined);
  const scope = recovery.scope;
  const epoch = recoveryEpoch();
  const identity = JSON.stringify([epoch, connectionId]), latest = useRef(identity);
  latest.current = identity;
  useEffect(() => {
    mounted.current = true;
    setStatus(undefined); setBusy(false); setError(undefined); active.current = false;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [identity]);
  const current = () => mounted.current && latest.current === identity && recoveryEpoch() === epoch;
  const authorize = () => {
    if (!current() || !scope) throw new Error('Authenticated account or page changed; reload before continuing');
  };
  const run = async (operation?: 'pause' | 'resume') => {
    if (active.current) return;
    active.current = true; setBusy(true); setError(undefined);
    try {
      authorize();
      if (operation && recovery.blocked(connectionId)) throw new Error('Query the original maintenance receipt before a new command');
      if (operation === 'pause' && status?.state !== 'released') throw new Error('Refresh the admission state before pausing');
      if (operation === 'resume' && (status?.state !== 'paused' || !status.fenceId)) throw new Error('Refresh the original maintenance fence before resuming');
      controller.current = new AbortController();
      const result = readConnectorAdmissionStatus(operation
        ? await recovery.send({ connectionId, operation }, operation === 'resume' ? { fenceId: status!.fenceId! } : {})
        : await api.hubAdmissionStatus(connectionId, scope!, controller.current.signal));
      authorize();
      if (!result) throw new Error('Connector admission result unavailable');
      setStatus(result);
    } catch (cause) {
      if (current()) {
        setStatus(undefined); setError(cause instanceof Error ? cause.message : 'Maintenance unavailable');
      }
    } finally {
      if (current()) { active.current = false; setBusy(false); }
    }
  };
  const blocked = busy || recovery.blocked(connectionId);
  return <section aria-label={t('Connector admission maintenance')} className="mt-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs">
    <p className="font-semibold">{t('Admission maintenance')}</p>
    <p>{t('Pauses new writes and queued starts only. Running native work may continue. This is not a safe snapshot, native-idle proof, or deployment approval.')}</p>
    <p role="status" className="break-words">{status ? formatMaintenanceResult(status, locale) : t('Admission state not loaded')}</p>
    {error && <p role="alert" className="break-words text-red-700">{translate(error)}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={busy || !scope} onClick={() => void run()}>{t('Refresh admission status')}</Button>
      <Button type="button" size="sm" variant="secondary" disabled={blocked || status?.state !== 'released'} onClick={() => void run('pause')}>{t('Pause new writes')}</Button>
      <Button type="button" size="sm" variant="secondary" disabled={blocked || status?.state !== 'paused' || !status.fenceId} onClick={() => void run('resume')}>{t('Resume original fence')}</Button>
    </div>
  </section>;
}
