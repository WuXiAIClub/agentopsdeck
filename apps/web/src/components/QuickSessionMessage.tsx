import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { LEGACY_MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { Send } from 'lucide-react';
import { recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { defaultDeliveryMode, displayTitle } from '../lib/session-utils';
import { sendMessageWithRecovery } from '../lib/message-submission';
import { CommandNotSubmittedError, CommandRejectedError, newCommandKey } from '../lib/command-recovery';
import { Button } from './ui/button';

/** No history/settings reads. Admission and uncertainty use the normal command journal. */
export function QuickSessionMessage({ session, onClose, onAccepted, inline = false, onBusyChange }: { session: SessionSummary; onClose: () => void; onAccepted: () => void; inline?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const scope = useRef(recoveryScope()).current;
  const pending = useRef(false);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'editing' | 'sending' | 'accepted' | 'queued' | 'unknown'>('editing');
  const [error, setError] = useState('');
  usePageRefreshGuard(() => !pending.current && !(phase === 'editing' && text.length > 0));
  const mode = defaultDeliveryMode(session);
  useEffect(() => {
    const previous = document.activeElement;
    if (!inline) dialog.current?.showModal();
    window.addEventListener('agentopsdeck:auth-required', onClose);
    return () => { window.removeEventListener('agentopsdeck:auth-required', onClose); if (!inline && previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onClose, inline]);
  useEffect(() => { onBusyChange?.(phase === 'sending' || phase === 'unknown' || phase === 'editing' && !!text); }, [text, phase, onBusyChange]);
  async function submit() {
    if (pending.current || phase !== 'editing' || !text.trim() || text.length > LEGACY_MAX_MESSAGE_CHARS) return;
    if (!scope || recoveryScope() !== scope) { onClose(); return; }
    pending.current = true; setPhase('sending'); setError('');
    try {
      const response = await sendMessageWithRecovery(session.sessionKey, text.trim(), mode, [], newCommandKey(), text.trim() === '/stop' ? session.runtime?.turnId : undefined);
      if (recoveryScope() !== scope) return;
      setPhase(response.status === 'outcome_unknown' ? 'unknown' : response.admission?.disposition === 'waiting' || response.status === 'queued' && !response.admission ? 'queued' : 'accepted');
      // Metadata refresh failure must never turn an accepted send into a retry.
      try { onAccepted(); } catch { /* Polling will reconcile the list. */ }
    } catch (e) {
      if (recoveryScope() !== scope) return;
      const retryable = e instanceof CommandNotSubmittedError || e instanceof CommandRejectedError;
      setPhase(retryable ? 'editing' : 'unknown');
      if (retryable) setError(e instanceof Error ? e.message : String(e));
    } finally { pending.current = false; }
  }
  const form = <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {!inline && <><h2 id="quick-message-title">{t('Quick message')}</h2>
      <p className="quick-message-target">{displayTitle(session)}</p></>}
      <p className="quick-message-hint">{t(mode === 'mirror' ? 'Replies will also be delivered to the linked channel.' : 'Send without opening the conversation. Busy sessions use the normal queue.')}</p>
      <textarea name="quicksessionmessage-textarea-1" autoFocus={!inline} aria-label={t('Quick message text')} placeholder={t('Write a quick message…')} value={text} readOnly={phase !== 'editing'} maxLength={LEGACY_MAX_MESSAGE_CHARS} onChange={event => setText(event.target.value)} />
      <small>{text.length.toLocaleString()} / {LEGACY_MAX_MESSAGE_CHARS.toLocaleString()}</small>
      {phase !== 'editing' ? <p role="status" className={`quick-message-status is-${phase}`}>{t(phase === 'sending' ? 'Sending…' : phase === 'queued' ? 'Queued · waiting for the current run' : phase === 'unknown' ? 'Delivery not confirmed. Check Delivery recovery; do not resend.' : 'Message accepted · no need to open the conversation')}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <div className="quick-message-actions">{!inline && <Button type="button" variant="secondary" disabled={phase === 'sending'} onClick={onClose}>{t(phase === 'editing' ? 'Cancel' : 'Close')}</Button>}
        {inline && (phase === 'accepted' || phase === 'queued') && <Button type="button" variant="secondary" onClick={() => { setText(''); setPhase('editing'); }}>{t('New message')}</Button>}
        {phase === 'editing' || phase === 'sending' ? <Button type="submit" disabled={phase === 'sending' || !text.trim()}><Send size={15} />{t(phase === 'sending' ? 'Sending…' : 'Send')}</Button> : null}</div>
    </form>;
  return inline ? <div className="quick-session-message quick-session-message--inline">{form}</div> : <dialog ref={dialog} className="action-dialog quick-session-message" aria-labelledby="quick-message-title"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}>{form}</dialog>;
}
