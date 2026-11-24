import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutomationConfiguration } from '@agentopsdeck/shared';
import { api, recoveryScope, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { automationDraft, pauseAutomation, scopedAutomationReceipt, validAutomationView, type AutomationView, type AutomationDraft } from '../lib/session-automation';
import './session-goal-control.css';

const requestId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
export default function SessionAutomationPanel({ sessionKey, close }: { sessionKey: string; close: () => void }) {
  const { t } = useI18n(), title = useId(), dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null), locked = useRef(false);
  const scope = recoveryScope(), storageKey = JSON.stringify(['agentopsdeck.automation.v1', scope, sessionKey]);
  const [view, setView] = useState<AutomationView>(), [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const [pending, setPending] = useState<string>(), [storageOk, setStorageOk] = useState(false);
  const [draft, setDraft] = useState<AutomationDraft>({ template: '', enabled: false, kind: 'once', minutes: 5, hours: 1, maxSends: 1, maxPerHour: 1 });
  const current = (c: AbortController) => controller.current === c && !c.signal.aborted && !!scope && recoveryScope() === scope;
  const remember = (id?: string) => {
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); setPending(id); setStorageOk(true); return true; }
    catch { setStorageOk(false); setError(true); return false; }
  };
  const load = async (c: AbortController) => {
    const value = await api.sessionAutomation(sessionKey, c.signal);
    if (!current(c)) return;
    if (!validAutomationView(value)) throw Error('Invalid automation scope');
    setView(value); return value;
  };
  const inspect = async (id: string, v: AutomationView, c: AbortController) => {
    const value = await api.automationConfiguration(sessionKey, id, c.signal);
    if (!current(c)) return;
    if (!scopedAutomationReceipt(value, id, v)) throw Error('Invalid original receipt');
    // Even 404 is unresolved: the original request may still commit later.
    if (!remember()) throw Error('Recovery storage unavailable');
    setDraft(d => ({ ...d, enabled: false }));
    await load(c);
  };
  useEffect(() => {
    const c = new AbortController(); controller.current = c; locked.current = true;
    const previous = document.activeElement, el = dialog.current; el?.showModal();
    const unsubscribe = subscribeRecoveryScope(close); window.addEventListener('agentopsdeck:auth-required', close);
    void (async () => {
      const saved = sessionStorage.getItem(storageKey);
      if (saved && !requestId(saved)) throw Error('Invalid recovery ID');
      setStorageOk(true); setPending(saved ?? undefined);
      const value = await load(c); if (saved && value && current(c)) await inspect(saved, value, c);
    })().catch(() => { if (current(c)) setError(true); }).finally(() => { if (current(c)) { locked.current = false; setBusy(false); } });
    return () => { c.abort(); unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', close); el?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [scope, sessionKey]);
  const act = async (input?: AutomationConfiguration) => {
    const c = controller.current; if (!c || !current(c) || locked.current || !storageOk || (input ? (!view || !!pending) : (!!pending && !view))) return;
    locked.current = true; setBusy(true); setError(false);
    try {
      if (!input) { if (pending && view) await inspect(pending, view, c); else { const v = await load(c); if (pending && v && current(c)) await inspect(pending, v, c); } }
      else if (view) {
        const id = crypto.randomUUID(); if (!remember(id)) return;
        const result = await api.automationConfiguration(sessionKey, id, c.signal, input);
        if (!current(c)) return;
        if (!scopedAutomationReceipt(result, id, view)) throw Error('Invalid original receipt');
        if (!remember()) return;
        setDraft(d => ({ ...d, enabled: false })); await load(c);
      }
    } catch { if (current(c)) setError(true); }
    finally { if (current(c)) { locked.current = false; setBusy(false); } }
  };
  const change = (patch: Partial<AutomationDraft>) => setDraft(d => ({ ...d, enabled: false, ...patch }));
  return createPortal(<dialog ref={dialog} className="goal-control-dialog" aria-labelledby={title} onCancel={close} onClose={close}>
    <header><h2 id={title}>{t('Bounded automation')}</h2><button type="button" onClick={close}>{t('Close')}</button></header>
    <p>{t('Disabled by default. Only verified idle Codex sessions can run. Expiry and send limits are mandatory. Closing this panel does not stop a saved rule.')}</p>
    <p>{t('Completion rules require a live successful turn, never history recovery. Their own automatic turns do not trigger another send.')}</p>
    {error && <p role="alert">{t('Automation unavailable or outcome unknown. Check the original request; never resend. Operator automation permission may be required.')}</p>}
    {pending && <p role="status">{t('Original configuration pending')}: <code>{pending}</code></p>}
    <button type="button" disabled={busy || !storageOk} onClick={() => void act()}>{t(pending ? 'Inspect original configuration' : 'Refresh')}</button>
    {view?.rules.map(s => <section key={s.rule.id} aria-label={s.rule.id}>
      <p><code>{s.rule.id}</code> · {t(s.revoked ? 'Revoked' : s.rule.enabled ? 'Enabled' : 'Disabled')} · {new Date(s.rule.expiresAt).toLocaleString()}</p>
      <p>{s.template}</p><div className="goal-control-actions">
        <button type="button" disabled={busy || !!pending || !storageOk || s.revoked || !s.rule.enabled} onClick={() => void act(pauseAutomation(s))}>{t('Pause automation')}</button>
        <button type="button" disabled={busy || !!pending || !storageOk || s.revoked} onClick={() => void act({ kind: 'revoke', ruleId: s.rule.id, expectedRevision: s.rule.revision })}>{t('Revoke automation')}</button>
      </div>
    </section>)}
    <form onSubmit={e => { e.preventDefault(); if (!view) return; const input = automationDraft(view, draft, crypto.randomUUID(), Date.now()); if (input) void act(input); else setError(true); }}>
      <fieldset disabled={busy || !!pending || !storageOk}>
        <legend>{t('New bounded rule')}</legend>
        <label>{t('Automation message')}<textarea name="sessionautomationpanel-textarea-1" required maxLength={8192} value={draft.template} onChange={e => change({ template: e.target.value })} /></label>
        <label>{t('Trigger')}<select name="sessionautomationpanel-select-2" value={draft.kind} onChange={e => change({ kind: e.target.value as AutomationDraft['kind'] })}><option value="once">{t('Once after delay')}</option><option value="interval">{t('At fixed intervals')}</option><option value="completion">{t('After verified completion')}</option></select></label>
        <label>{t('Minimum interval / delay (minutes)')}<input name="sessionautomationpanel-input-3" type="number" required min={1} max={10080} value={draft.minutes} onChange={e => change({ minutes: e.target.valueAsNumber })} /></label>
        <label>{t('Expires in (hours)')}<input name="sessionautomationpanel-input-4" type="number" required min={1} max={168} value={draft.hours} onChange={e => change({ hours: e.target.valueAsNumber })} /></label>
        <label>{t('Maximum sends')}<input name="sessionautomationpanel-input-5" type="number" required min={1} max={1000} value={draft.maxSends} onChange={e => change({ maxSends: e.target.valueAsNumber })} /></label>
        <label>{t('Maximum sends per hour')}<input name="sessionautomationpanel-input-6" type="number" required min={1} max={60} value={draft.maxPerHour} onChange={e => change({ maxPerHour: e.target.valueAsNumber })} /></label>
        <label className="goal-control-confirm"><input name="sessionautomationpanel-input-7" type="checkbox" checked={draft.enabled} onChange={e => change({ enabled: e.target.checked })} />{t('I authorize automatic messages within these limits')}</label>
        <button type="submit" disabled={busy || !!pending || !view || !storageOk}>{t(draft.enabled ? 'Save and enable automation' : 'Save disabled rule')}</button>
      </fieldset>
    </form>
  </dialog>, document.body);
}
