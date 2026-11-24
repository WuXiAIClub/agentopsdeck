import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { api } from '../api';
import { useI18n } from '../lib/i18n';
import { canRequestSessionRecovery, createSessionRecoveryRequest } from '../lib/session-recovery';
import { Button } from './ui/button';

type RecoveryNotice = 'Recovery requested · protection remains until execution is verified'
  | 'Recovery requested · session refresh failed; check again'
  | 'Recovery request unconfirmed · no forced unlock or replay performed; refresh state';

export function SessionRecoveryButton({ session, onRechecked }: { session: SessionSummary; onRechecked: () => Promise<void> }) {
  const { t } = useI18n();
  const [owner] = useState(createSessionRecoveryRequest);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<RecoveryNotice>();
  const refresh = useRef(onRechecked);
  refresh.current = onRechecked;
  useEffect(() => {
    setPending(false);
    setNotice(undefined);
    return () => owner.cancel();
  }, [owner, session.sessionKey, session.runtime?.turnId]);

  async function recover() {
    if (!session.runtime?.turnId || !canRequestSessionRecovery(session)) return;
    const controller = owner.begin();
    if (!controller) return;
    setPending(true);
    setNotice(undefined);
    try {
      const result = await api.requestSessionRecovery(session.sessionKey, session.runtime.turnId, controller.signal);
      if (!owner.current(controller)) return;
      if (result.requested !== true) throw new Error('Invalid recovery response');
      setNotice('Recovery requested · protection remains until execution is verified');
      try { await refresh.current(); }
      catch { if (owner.current(controller)) setNotice('Recovery requested · session refresh failed; check again'); }
    } catch {
      if (owner.current(controller)) setNotice('Recovery request unconfirmed · no forced unlock or replay performed; refresh state');
    } finally {
      if (owner.current(controller)) setPending(false);
      owner.finish(controller);
    }
  }

  if (!canRequestSessionRecovery(session)) return null;
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void recover()}
      title={t('Recheck the original execution. Does not stop work, clear unknown outcomes, replay messages or restart services.')}>
      {t(pending ? 'Requesting recovery…' : 'Recover session')}
    </Button>
    {notice ? <span role="status" aria-live="polite">{t(notice)}</span> : null}
  </span>;
}
