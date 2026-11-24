import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, recoveryScope, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { formatSafeSecretDirective, GUIDANCE_TEMPLATES, guidanceRequestId, validGuidanceResult, validGuidanceSnapshot, type GuidanceReceipt, type GuidanceResult, type GuidanceSnapshot } from '../lib/session-guidance';
import './session-goal-control.css';

export default function SessionGuidancePanel({ sessionKey, close }: { sessionKey: string; close: () => void }) {
  const { t } = useI18n(), titleId = useId(), dialog = useRef<HTMLDialogElement>(null), controller = useRef<AbortController | null>(null), lock = useRef(false);
  const scope = recoveryScope(), storageKey = JSON.stringify(['agentopsdeck.guidance.v1', scope, sessionKey]);
  const [data, setData] = useState<GuidanceSnapshot>(), [text, setText] = useState(''), [enabled, setEnabled] = useState(false);
  const [input, setInput] = useState('');
  const [secretName, setSecretName] = useState(''), [secretValue, setSecretValue] = useState(''), [secretMode, setSecretMode] = useState<'secret' | 'path'>('secret');
  const [pending, setPending] = useState<string>(), [receipt, setReceipt] = useState<GuidanceReceipt>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [storageOk, setStorageOk] = useState(false);
  const current = (c: AbortController) => controller.current === c && !c.signal.aborted && !!scope && recoveryScope() === scope;
  const remember = (id?: string) => {
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); setPending(id); setStorageOk(true); return true; }
    catch { setStorageOk(false); setError(true); return false; }
  };
  const accept = (v: GuidanceResult, id: string) => {
    if (!validGuidanceResult(v, id)) throw Error('Invalid guidance receipt');
    if (v.receipt) { setReceipt(v.receipt); if (v.receipt.state === 'submitted') setInput(''); }
    else if (remember()) setReceipt(undefined);
  };
  const load = async (c: AbortController) => {
    const v = await api.sessionGuidance(sessionKey, c.signal);
    if (!current(c)) return;
    if (!validGuidanceSnapshot(v)) throw Error('Invalid guidance');
    setData(v); setText(v.guidance?.config.text ?? ''); setEnabled(v.guidance?.config.enabled ?? false);
  };
  useEffect(() => {
    const c = new AbortController(); controller.current = c; lock.current = true; setBusy(true);
    const previous = document.activeElement, el = dialog.current; el?.showModal();
    const unsubscribe = subscribeRecoveryScope(close); window.addEventListener('agentopsdeck:auth-required', close);
    void (async () => {
      let saved: string | null;
      try { saved = sessionStorage.getItem(storageKey); if (saved && !guidanceRequestId(saved)) throw Error('Invalid stored request'); setStorageOk(true); setPending(saved ?? undefined); }
      catch { setStorageOk(false); throw Error('Recovery storage unavailable'); }
      await load(c);
      if (saved && current(c)) { const v = await api.guidanceSubmission(sessionKey, saved, 'inspect', c.signal); if (current(c)) accept(v, saved); }
    })().catch(() => { if (current(c)) setError(true); }).finally(() => { if (controller.current === c) { lock.current = false; if (current(c)) setBusy(false); } });
    return () => { c.abort(); unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', close); el?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [scope, sessionKey]);
  const act = async (action: 'reload' | 'save' | 'preview' | 'inspect' | 'submit' | 'cancel') => {
    const c = controller.current; if (!c || !current(c) || lock.current || !storageOk) return;
    if (['save', 'preview'].includes(action) && (pending || !data)) return;
    if (action === 'preview' && (!enabled || !text.trim() || text !== data?.guidance?.config.text || enabled !== data?.guidance?.config.enabled)) return;
    if (action === 'submit' && (receipt?.state !== 'prepared' || receipt.expiresAt <= Date.now() || !data?.guidance || receipt.revision !== data.guidance.config.revision)) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      if (action === 'reload') await load(c);
      else if (action === 'save') {
        // A lost CAS save acknowledgement requires an explicit reload, never an automatic write retry.
        const v = await api.saveSessionGuidance(sessionKey, { revision: data?.guidance?.config.revision ?? 0, text, enabled }, c.signal);
        if (current(c)) { if (!validGuidanceSnapshot(v)) throw Error('Invalid guidance'); setData(v); }
      } else if (action === 'preview') {
        const id = crypto.randomUUID(); if (!remember(id)) return;
        const v = await api.prepareGuidanceSubmission(sessionKey, { requestId: id, revision: data!.guidance!.config.revision, input }, c.signal);
        if (current(c)) accept(v, id);
      } else if (pending) {
        // Hide the send button before I/O: a lost response must only be recovered by GET.
        if (action === 'submit') setReceipt(undefined);
        const v = await api.guidanceSubmission(sessionKey, pending, action, c.signal);
        if (current(c)) accept(v, pending);
      }
    } catch { if (current(c)) { setError(true); if (action === 'save') setData(undefined); } }
    finally { if (controller.current === c) { lock.current = false; if (current(c)) setBusy(false); } }
  };
  const config = data?.guidance?.config, dirty = text !== (config?.text ?? '') || enabled !== (config?.enabled ?? false);
  return createPortal(<dialog className="goal-control-dialog" ref={dialog} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); close(); }}>
    <header><h2 id={titleId}>{t('Fixed session guidance')}</h2><button onClick={close}>{t('Close')}</button></header>
    <p>{t('Saving never sends. Preview and explicitly confirm before sending guidance as one normal message.')}</p>
    <p role="note">{t('This runtime cannot verify the current context. Queue acceptance does not prove guidance survived compaction.')}</p>
    {error && <p role="alert">{t('Guidance outcome unavailable. Reload settings or inspect the original request; do not resend.')}</p>}
    {busy && <p role="status">{t('Working…')}</p>}
    {data?.guidance && <p role="status" className="guidance-context-status">
      <strong>{t('Context status')}:</strong> {t(guidanceStateLabels[data.guidance.state as keyof typeof guidanceStateLabels] ?? 'Context status unknown')}
      {(data.guidance.state === 'confirmed_absent' || data.guidance.state === 'unknown' || data.guidance.state === 'not_submitted') && enabled && !dirty && !pending && (
        <> · <button type="button" disabled={busy} onClick={() => void act('preview')}>{t('Prepare re-injection after compaction')}</button></>
      )}
    </p>}
    <fieldset disabled={busy || !!pending || !data || !storageOk}>
      <div className="guidance-templates" aria-label={t('Quick agent templates')}>
        <span>{t('Quick agent templates')}:</span>
        {GUIDANCE_TEMPLATES.map(tpl => (
          <button key={tpl.id} type="button" onClick={() => { setText(prev => prev.trim() ? `${prev.trim()}\n\n${tpl.text}` : tpl.text); setEnabled(true); }}>
            {t(tpl.label)}
          </button>
        ))}
      </div>
      <label>{t('Guidance text')}<textarea name="sessionguidancepanel-textarea-1" maxLength={8000} value={text} onChange={e => setText(e.target.value)} /></label>
      <label className="goal-control-confirm"><input name="sessionguidancepanel-input-2" type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />{t('Enable manual guidance submission')}</label>
      <button onClick={() => void act('save')} disabled={!dirty}>{t('Save guidance only')}</button>
      <label>{t('Next message with guidance (optional)')}<textarea name="sessionguidancepanel-textarea-3" maxLength={8000} value={input} onChange={e => setInput(e.target.value)} /></label>
      <p>{t('Both texts are frozen in one preview and sent as one message only after confirmation. This does not change the main composer draft.')}</p>
      <details className="guidance-secret-delivery">
        <summary>{t('Safe key / credential file delivery')}</summary>
        <p>{t('Materialize keys to a private 0600 file on the Connector or reference an existing private file path instead of exposing raw secrets in chat instructions.')}</p>
        <label>{t('Variable / key name')}<input name="sessionguidancepanel-secret-name" value={secretName} placeholder={t("OPENAI_API_KEY")} onChange={e => setSecretName(e.target.value)} /></label>
        <label>{t('Delivery mode')}<select name="sessionguidancepanel-secret-mode" value={secretMode} onChange={e => setSecretMode(e.target.value as 'secret' | 'path')}>
          <option value="secret">{t('Materialize secret to private 0600 file')}</option>
          <option value="path">{t('Reference existing private file path')}</option>
        </select></label>
        <label>{secretMode === 'secret' ? t('Secret value (min 8 chars)') : t('Private file path on Connector')}<input name="sessionguidancepanel-secret-value" type={secretMode === 'secret' ? 'password' : 'text'} value={secretValue} placeholder={secretMode === 'secret' ? '••••••••' : t('/run/secrets/api_key')} onChange={e => setSecretValue(e.target.value)} /></label>
        <button type="button" disabled={!secretValue.trim() || (secretMode === 'secret' && secretValue.trim().length < 8)} onClick={() => {
          const directive = formatSafeSecretDirective(secretName, secretValue, secretMode);
          if (!directive) return;
          setInput(prev => prev.trim() ? `${prev.trim()}\n${directive}` : directive);
          setSecretValue('');
          if (!enabled && text.trim()) setEnabled(true);
        }}>{t('Attach safe key directive to next message')}</button>
      </details>
      <button onClick={() => void act('preview')} disabled={dirty || !enabled || !text.trim()}>{t('Preview guidance message')}</button>
    </fieldset>
    <button disabled={busy || !storageOk} onClick={() => void act('reload')}>{t('Reload guidance settings')}</button>
    {pending && <section aria-label={t('Original request')}><p><code>{pending}</code></p>
      <button disabled={busy} onClick={() => void act('inspect')}>{t('Inspect guidance receipt')}</button>
      {(!receipt || receipt.state === 'prepared') && <button disabled={busy} onClick={() => void act('cancel')}>{t('Cancel unsent guidance preview')}</button>}
      {receipt && <><p role="status">{t(states[receipt.state])}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{receipt.text}</pre>
        {receipt.state === 'prepared' && <button disabled={busy || !config?.enabled || receipt.revision !== config.revision || receipt.expiresAt <= Date.now()} onClick={() => void act('submit')}>{t('Confirm sending guidance once')}</button>}
        {['submitted', 'rejected', 'cancelled'].includes(receipt.state) && <button disabled={busy} onClick={() => { if (remember()) setReceipt(undefined); }}>{t('Dismiss resolved guidance receipt')}</button>}
      </>}
    </section>}
  </dialog>, document.body);
}
const states = { prepared: 'Guidance preview, not sent', unknown: 'Guidance delivery unconfirmed', submitted: 'Guidance accepted by queue; context unverified', rejected: 'Guidance submission rejected', cancelled: 'Guidance preview cancelled' } as const;

const guidanceStateLabels = {
  not_submitted: 'Not yet sent to session',
  submitted: 'Submitted (unverified after compaction)',
  unknown: 'Context status unknown (check or re-inject after compaction)',
  confirmed_present: 'Confirmed present in context',
  confirmed_absent: 'Missing after context compaction — re-injection recommended',
} as const;
