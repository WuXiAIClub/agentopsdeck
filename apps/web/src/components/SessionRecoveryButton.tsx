import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { api } from '../api';
import { useI18n } from '../lib/i18n';
import { canRequestSessionRecovery, canStopSessionBackgroundTerminals, createSessionRecoveryRequest } from '../lib/session-recovery';
import { Button } from './ui/button';
import { confirmAction } from './ui/confirm';

type RecoveryNotice = 'Recovery requested · protection remains until execution is verified'
  | 'Recovery requested · session refresh failed; check again'
  | 'Recovery request unconfirmed · no forced unlock or replay performed; refresh state'
  | 'Background terminals stopped · verifying execution protection…'
  | 'Background terminals stopped · session refresh failed; check again'
  | 'Background terminals could not be stopped · keep intended services or refresh state';

export function SessionRecoveryButton({ session, onRechecked }: { session: SessionSummary; onRechecked: () => Promise<void> }) {
  const { t } = useI18n();
  const [owner] = useState(createSessionRecoveryRequest);
  const [pendingAction, setPendingAction] = useState<'recover' | 'stop'>();
  const [notice, setNotice] = useState<RecoveryNotice>();
  const refresh = useRef(onRechecked);
  refresh.current = onRechecked;
  const followUpTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setPendingAction(undefined);
    setNotice(undefined);
    if (followUpTimer.current !== undefined) {
      window.clearTimeout(followUpTimer.current);
      followUpTimer.current = undefined;
    }
    return () => {
      if (followUpTimer.current !== undefined) {
        window.clearTimeout(followUpTimer.current);
        followUpTimer.current = undefined;
      }
      owner.cancel();
    };
  }, [owner, session.sessionKey, session.runtime?.turnId]);

  function scheduleFollowUpRefresh() {
    if (followUpTimer.current !== undefined) window.clearTimeout(followUpTimer.current);
    followUpTimer.current = window.setTimeout(() => {
      followUpTimer.current = undefined;
      void refresh.current().catch(() => {});
    }, 650);
  }

  async function recover() {
    if (!session.runtime?.turnId || !canRequestSessionRecovery(session)) return;
    const controller = owner.begin();
    if (!controller) return;
    setPendingAction('recover');
    setNotice(undefined);
    try {
      const result = await api.requestSessionRecovery(session.sessionKey, session.runtime.turnId, controller.signal);
      if (!owner.current(controller)) return;
      if (result.requested !== true) throw new Error('Invalid recovery response');
      setNotice('Recovery requested · protection remains until execution is verified');
      try { await refresh.current(); }
      catch { if (owner.current(controller)) setNotice('Recovery requested · session refresh failed; check again'); }
      if (owner.current(controller)) scheduleFollowUpRefresh();
    } catch {
      if (owner.current(controller)) setNotice('Recovery request unconfirmed · no forced unlock or replay performed; refresh state');
    } finally {
      if (owner.current(controller)) setPendingAction(undefined);
      owner.finish(controller);
    }
  }

  async function stopTerminals() {
    const expectedRunId = session.runtime?.turnId;
    if (!expectedRunId || !canStopSessionBackgroundTerminals(session)) return;
    const controller = owner.begin();
    if (!controller) return;
    setPendingAction('stop');
    setNotice(undefined);
    try {
      const confirmed = await confirmAction({
        title: t('Stop background terminals?'),
        description: t('Only background terminals attributed to this finished run will be terminated. Foreign or unattributed terminals are refused, and intended long-running services should be kept running.'),
        confirmLabel: t('Stop background terminals'),
        signal: controller.signal,
      });
      if (!confirmed || !owner.current(controller)) return;
      const result = await api.stopSessionBackgroundTerminals(session.sessionKey, expectedRunId, controller.signal);
      if (!owner.current(controller)) return;
      if (result.stopped !== true) throw new Error('Invalid terminal stop response');
      setNotice('Background terminals stopped · verifying execution protection…');
      try { await refresh.current(); }
      catch { if (owner.current(controller)) setNotice('Background terminals stopped · session refresh failed; check again'); }
      if (owner.current(controller)) scheduleFollowUpRefresh();
    } catch {
      if (owner.current(controller)) setNotice('Background terminals could not be stopped · keep intended services or refresh state');
    } finally {
      if (owner.current(controller)) setPendingAction(undefined);
      owner.finish(controller);
    }
  }

  const canRecover = canRequestSessionRecovery(session);
  const canStop = canStopSessionBackgroundTerminals(session);
  if (!canRecover && !canStop) return null;
  const pending = pendingAction !== undefined;
  return <span className="inline-flex flex-wrap items-center gap-2">
    {canRecover ? <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void recover()}
      title={t('Recheck the original execution. Does not stop work, clear unknown outcomes, replay messages or restart services.')}>
      {t(pendingAction === 'recover' ? 'Requesting recovery…' : 'Recover session')}
    </Button> : null}
    {canStop ? <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void stopTerminals()}
      title={t('Terminate background terminals owned by this finished run so queued execution can proceed.')}>
      {t(pendingAction === 'stop' ? 'Stopping terminals…' : 'Stop background terminals')}
    </Button> : null}
    {notice ? <span role="status" aria-live="polite">{t(notice)}</span> : null}
  </span>;
}
