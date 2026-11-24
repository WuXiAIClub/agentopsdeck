import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircleQuestion, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { readInteractionAnswer, type InteractionAnswer, type InteractionView } from '@agentopsdeck/shared';
import { api, recoveryScope, sessionInteractionReads, subscribeRecoveryScope } from '../api';
import { interactionSubmissionLedger } from '../lib/session-interactions';
import { useI18n } from '../lib/i18n';
import './SessionInteractions.css';

export default function SessionInteractionsPanel({ scope, sessionKey, state, close }: { scope: string; sessionKey: string;
  state: ReturnType<typeof sessionInteractionReads.snapshot>; close(): void }) {
  const { t } = useI18n(), title = useId(), dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false), [modeError, setModeError] = useState(false);
  const request = useRef<AbortController | undefined>(undefined), closeRef = useRef(close); closeRef.current = close;
  const refresh = () => sessionInteractionReads.refresh(scope, sessionKey);
  useEffect(() => {
    const prior = document.activeElement, element = dialog.current;
    const finish = () => closeRef.current();
    element?.showModal();
    const unsubscribe = subscribeRecoveryScope(finish);
    window.addEventListener('agentopsdeck:auth-required', finish);
    return () => {
      request.current?.abort(); unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', finish); element?.close();
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus({ preventScroll: true });
    };
  }, []);
  const setMode = async (mode: 'automatic' | 'interactive') => {
    if (saving || recoveryScope() !== scope) return;
    const controller = new AbortController(); request.current = controller; setSaving(true); setModeError(false);
    try { await api.setInteractionMode(sessionKey, mode, controller.signal); }
    catch { if (!controller.signal.aborted) setModeError(true); }
    finally { if (!controller.signal.aborted) { setSaving(false); refresh(); } }
  };
  return createPortal(<dialog ref={dialog} className="session-files-dialog session-interactions-dialog" data-interaction-session={sessionKey} data-font-area="chat" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section><header><div className="interaction-heading"><MessageCircleQuestion size={20} aria-hidden="true" /><h2 id={title}>{t('Agent interactions')}</h2></div><button type="button" autoFocus onClick={close} aria-label={t('Close')}><X size={18} /></button></header>
      <div className="session-interactions-body">
        <div className="interaction-mode"><div className="interaction-mode-setting"><label>{t('Next turn mode')} <select name="sessioninteractions-select-1" value={state.data?.mode ?? 'automatic'} disabled={saving || !state.data || state.failed}
          onChange={event => void setMode(event.target.value as 'automatic' | 'interactive')}>
          <option value="automatic">{t('Automatic')}</option><option value="interactive" disabled={!state.data?.capabilities.modes.includes('interactive')}>{t('Interactive')}</option>
        </select></label><p className="interaction-mode-description"><Sparkles size={14} aria-hidden="true" />{t(state.data?.mode === 'interactive' ? 'Respond to native questions and review permitted tool actions.' : 'The Agent continues automatically within Connector permissions.')}</p></div><button type="button" className="interaction-refresh" onClick={refresh} disabled={state.loading} aria-label={t('Refresh')}><RefreshCw size={14} aria-hidden="true" /><span>{t('Refresh')}</span></button></div>
        <p className="interaction-safety"><ShieldCheck size={15} aria-hidden="true" /><span>{t('Mode applies to later turns only. Approval cannot expand Connector permissions. Closing this panel does not stop the Agent.')}</span></p>
        {modeError ? <p className="interaction-feedback" role="status">{t('Mode update unconfirmed. Refresh to check; it was not retried.')}</p> : null}
        {state.unavailable ? <p className="interaction-feedback" role="status">{t(state.unavailable === 'unsupported'
          ? 'This Connector has no interaction service enabled. Enable or upgrade it, then refresh.'
          : 'Interaction route or session not found. Automatic retries stopped; check the Connector version and session, then refresh.')}</p>
          : state.failed ? <p className="interaction-feedback" role="status">{t('Interactions unavailable. Check Connector readiness and permissions, then refresh.')}</p> : null}
        {state.loading && !state.data ? <p role="status">{t('Loading interactions…')}</p> : null}
        {state.data?.requests.length === 0 ? <p className="interaction-empty"><MessageCircleQuestion size={22} aria-hidden="true" />{t('No pending questions or approvals.')}</p> : null}
        {state.data?.requests.map(view => <InteractionQuestion key={view.request.requestId} scope={scope} sessionKey={sessionKey} view={view}
          unavailable={state.failed} refresh={refresh} />)}
      </div>
    </section>
  </dialog>, document.body);
}

function InteractionQuestion({ scope, sessionKey, view, refresh, unavailable }: { scope: string; sessionKey: string; view: InteractionView; refresh(): void; unavailable: boolean }) {
  const { t } = useI18n(), q = view.request;
  const [text, setText] = useState(''), [ids, setIds] = useState<string[]>([]), [expired, setExpired] = useState(q.expiresAt <= Date.now());
  const [sent, setSent] = useState(() => { try { return interactionSubmissionLedger(localStorage).has(scope, sessionKey, q.requestId); } catch { return true; } });
  const [sending, setSending] = useState(false), [unknown, setUnknown] = useState(false);
  const outcome = useRef<HTMLParagraphElement>(null);
  const guard = useRef(false), controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const timer = setTimeout(() => setExpired(true), Math.max(0, q.expiresAt - Date.now())); return () => { clearTimeout(timer); controller.current?.abort(); }; }, [q.expiresAt]);
  const editable = view.status === 'pending' && !sent && !expired && !unavailable;
  const answer: InteractionAnswer = q.kind === 'text' ? { kind: 'text', text }
    : q.kind === 'approval' ? { kind: 'approval', decision: 'deny' }
    : { kind: q.kind, optionIds: ids, ...(text.trim() ? { text } : {}) };
  async function send(value: InteractionAnswer) {
    if (!editable || guard.current || !readInteractionAnswer(q, value) || recoveryScope() !== scope) return;
    guard.current = true;
    try {
      const responseId = crypto.randomUUID();
      interactionSubmissionLedger(localStorage).begin(scope, sessionKey, q.requestId, q.expiresAt, responseId);
      // The form unmounts once an answer is claimed. Keep keyboard focus on a
      // stable result node rather than letting it fall outside the modal.
      outcome.current?.focus({ preventScroll: true });
      setSent(true); setSending(true);
      const abort = new AbortController(); controller.current = abort;
      await api.answerInteraction(sessionKey, q.requestId, { runId: q.runId, responseId, expectedRevision: view.revision, answer: value }, abort.signal);
    } catch { if (!controller.current?.signal.aborted) setUnknown(true); }
    finally { if (!controller.current?.signal.aborted) { setSending(false); refresh(); } }
  }
  const status = view.delivery === 'confirmed' ? 'Answer accepted by the Agent. This is not proof of tool completion.'
    : view.delivery === 'unknown' ? 'Answer outcome unknown. Check status; do not resend.'
    : view.status === 'closed' || view.delivery === 'cancelled' || expired ? 'Interaction closed. No new answer can be sent.'
    : unknown ? 'Answer outcome unknown. Check status; do not resend.'
    : sent || view.status === 'answered' ? 'Answer submitted. Waiting for confirmation.' : 'Waiting for your response';
  return <article className="interaction-question" data-status={view.delivery === 'confirmed' ? 'confirmed' : editable ? 'pending' : 'settled'}>
    <div className="interaction-question-status"><strong>{t(q.kind === 'approval' ? 'Tool approval' : 'Agent question')}</strong><time>{new Date(q.createdAt).toLocaleTimeString()}</time></div>
    <p className="interaction-prompt">{q.prompt}</p>
    {view.status === 'pending' ? <fieldset disabled={!editable || sending}>
      {q.kind === 'single-select' || q.kind === 'multi-select' ? q.options?.map(option => <label className="interaction-option" key={option.id}>
        <input type={q.kind === 'single-select' ? 'radio' : 'checkbox'} name={q.requestId} checked={ids.includes(option.id)}
          onChange={event => { setText(''); setIds(q.kind === 'single-select' ? [option.id] : event.target.checked ? [...ids, option.id] : ids.filter(id => id !== option.id)); }} />
        <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span></label>) : null}
      {q.kind === 'text' || q.allowFreeform ? <label className="interaction-text">{t('Your answer')}<textarea name="sessioninteractions-textarea-3" maxLength={8000} rows={3} value={text}
        onChange={event => { setText(event.target.value); setIds([]); }} /></label> : null}
      <div className="interaction-actions">{q.kind === 'approval' ? <>
        <button type="button" className="interaction-allow" onClick={() => void send({ kind: 'approval', decision: 'allow-once' })}>{t('Allow once')}</button>
        <button type="button" className="interaction-deny" onClick={() => void send({ kind: 'approval', decision: 'deny' })}>{t('Deny')}</button>
      </> : <button type="button" className="interaction-allow" disabled={!readInteractionAnswer(q, answer)} onClick={() => void send(answer)}>{t('Send answer')}</button>}</div>
    </fieldset> : null}
    <p ref={outcome} tabIndex={-1} role="status" className="session-files-note">{t(status)}{sending ? ` · ${t('Sending…')}` : ''}</p>
    {sent || unknown ? <button type="button" onClick={refresh}>{t('Check answer status')}</button> : null}
  </article>;
}
