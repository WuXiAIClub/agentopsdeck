import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { api, ApiResponseError, recoveryEpoch, subscribeRecoveryScope, type SafePasskey } from '../api';
import { notificationDeliveryMessage, notificationsEnabled, prepareNotificationWorker, requestDesktopNotification } from '../lib/desktop-notifications';
import { confirmAction } from './ui/confirm';
import { Button } from './ui/button';
import { passkeyError, passkeyUnavailableReason } from '../lib/passkey-ui';
import { useI18n, translate, type Locale } from '../lib/i18n';
import { FontPreferenceControls } from './FontPreferences';
import { useCompletionEffect, saveCompletionEffect, type CompletionEffect } from '../lib/completion-preference';
import { WorkspaceSyncSettings } from './WorkspaceSyncSettings';
import { downloadCompletionDiagnostics } from '../lib/completion-diagnostics';
const WeixinSettings = lazy(() => import('./WeixinSettings'));
const BrowserDiagnosticsSettings = lazy(() => import('./BrowserDiagnosticsSettings'));

function validatedPasskeys(result: { passkeys: SafePasskey[] }): SafePasskey[] {
  if (!result || !Array.isArray(result.passkeys) || result.passkeys.some(key => !key || typeof key.id !== 'string'
    || typeof key.label !== 'string' || !Number.isFinite(key.createdAt))) throw new Error('Invalid passkey list');
  return result.passkeys;
}

export function BrowserSettings() {
  const completionEffect = useCompletionEffect();
  const { t, locale, setLocale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef<number | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [keys, setKeys] = useState<SafePasskey[]>([]), [keyAccess, setKeyAccess] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyLoadError, setKeyLoadError] = useState(false), [keyLoadAttempt, setKeyLoadAttempt] = useState(0);
  const [keyRegistrationSaved, setKeyRegistrationSaved] = useState(false);
  const [label, setLabel] = useState('');
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef<object | null>(null);
  function invalidate() {
    lifetime.current?.abort(); lifetime.current = null; operation.current = null;
  }
  function closeSettings() {
    invalidate(); dialog.current?.close(); setOpen(false); setBusy(false);
    setKeys([]); setKeyAccess(false); setKeyLoading(false); setKeyLoadError(false); setKeyRegistrationSaved(false); setLabel(''); setError(''); setNotice('');
  }
  function beginOperation() {
    const controller = lifetime.current, epoch = recoveryEpoch();
    if (!controller || controller.signal.aborted || operation.current) return;
    const token = {}; operation.current = token;
    setBusy(true); setError(''); setNotice('');
    return {
      signal: controller.signal,
      current: () => lifetime.current === controller && !controller.signal.aborted && epoch === recoveryEpoch() && operation.current === token,
      finish: () => { if (operation.current === token) { operation.current = null; setBusy(false); } },
    };
  }
  useEffect(() => {
    const clear = () => closeSettings();
    window.addEventListener('agentopsdeck:auth-required', clear);
    window.addEventListener('pagehide', clear);
    const unsubscribe = subscribeRecoveryScope(clear);
    return () => { invalidate(); unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', clear); window.removeEventListener('pagehide', clear); };
  }, []);
  useEffect(() => {
    if (!open) return;
    setKeys([]); setKeyAccess(false); setKeyLoading(true); setKeyLoadError(false);
    dialog.current?.showModal();
    const controller = new AbortController(), epoch = recoveryEpoch(); lifetime.current = controller;
    const current = () => lifetime.current === controller && !controller.signal.aborted && epoch === recoveryEpoch();
    void api.passkeys(controller.signal).then(result => {
      if (!current()) return;
      setKeys(validatedPasskeys(result)); setKeyAccess(true);
    }).catch(err => {
      if (!current()) return;
      setKeyAccess(false);
      // A network/storage failure is not proof that this account lacks access.
      setKeyLoadError(!(err instanceof ApiResponseError && err.status === 403));
    }).finally(() => { if (current()) setKeyLoading(false); });
    return () => { controller.abort(); if (lifetime.current === controller) invalidate(); };
  }, [open, keyLoadAttempt]);
  async function changeNotifications() {
    const task = beginOperation(); if (!task) return;
    try {
      if (!window.isSecureContext) throw new Error(t('Notifications require HTTPS (or localhost).'));
      if (typeof Notification === 'undefined') throw new Error(t('Notifications are not supported in this browser. On iOS, install AgentOpsDeck on the Home Screen and open it there.'));
      const next = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (!task.current()) return;
      setPermission(next);
      if (next !== 'granted') throw new Error(t('Notifications are blocked. Allow notifications in this browser’s site settings, then retry.'));
      if ('serviceWorker' in navigator) {
        await prepareNotificationWorker(navigator.serviceWorker);
      }
      if (!task.current()) return;
      try { localStorage.setItem('agentopsdeck.notifications', 'on'); } catch { /* Notification testing does not require persistent preferences. */ }
      setEnabled(true);
      const result = await requestDesktopNotification(t('AgentOpsDeck notification test'), { body: t('Test notification · run results will appear here.'), tag: `agentopsdeck-test-${crypto.randomUUID()}`, silent: false });
      if (!task.current()) return;
      if (result.accepted) setNotice(notificationDeliveryMessage(result, locale)); else setError(notificationDeliveryMessage(result, locale));
    } catch (err) { if (task.current()) setError(err instanceof Error ? err.message : String(err)); }
    finally { task.finish(); }
  }
  async function addKey() {
    const task = beginOperation(); if (!task) return;
    const deviceLabel = label.trim() || t('My device');
    let saved = false;
    try {
      const optionsJSON = await api.passkeyRegistrationOptions(task.signal);
      if (!task.current()) return;
      const credential = await startRegistration({ optionsJSON });
      // A system prompt can outlive this dialog or login. Never submit its late
      // result with whatever credentials the browser happens to have now.
      if (!task.current()) return;
      await api.verifyPasskeyRegistration(credential, deviceLabel, task.signal);
      if (!task.current()) return;
      saved = true; setKeyRegistrationSaved(true);
      setNotice(t('Passkey saved. You can use it next time you sign in on this site.'));
      setKeys([]); setKeyAccess(false); setKeyLoading(true);
      const result = await api.passkeys(task.signal);
      if (!task.current()) return;
      setKeys(validatedPasskeys(result)); setKeyAccess(true); setKeyLoadError(false);
    } catch (err) {
      if (!task.current()) return;
      if (saved) {
        // The write succeeded: retry only the read, never replay registration.
        setKeys([]); setKeyAccess(false);
        setKeyLoadError(!(err instanceof ApiResponseError && err.status === 403));
      } else setError(passkeyError(err));
    } finally { if (task.current()) setKeyLoading(false); task.finish(); }
  }
  async function revoke(key: SafePasskey) {
    const task = beginOperation(); if (!task) return;
    try {
      if (!await confirmAction({ title: t('Remove “{name}”?', { name: key.label }), description: t('Removing this passkey also ends sessions signed in with it. Keep your access key or another passkey available.'), confirmLabel: t('Remove passkey'), signal: task.signal }) || !task.current()) return;
      const result = await api.revokePasskey(key.id, task.signal);
      if (!task.current()) return;
      setKeys(current => current.filter(item => item.id !== key.id));
      if (result.reauthenticate) {
        setKeyAccess(false); dialog.current?.close(); setOpen(false);
        window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required', { detail: { reason: 'passkey-revoked' } }));
      } else setNotice(t('Passkey removed.'));
    }
    catch (err) { if (task.current()) setError(passkeyError(err)); }
    finally { task.finish(); }
  }
  return <><Button variant="ghost" size="icon" aria-label={t('Browser and sign-in settings')} onClick={() => { setNotice(''); setError(''); setOpen(true); }}><Settings2 size={17} /></Button>
    {open ? <dialog ref={dialog} className="action-dialog browser-settings" aria-label={t('Browser and sign-in settings')}
      onPointerDown={event => {
        const box = event.currentTarget.getBoundingClientRect();
        const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
        backdropPointer.current = !busy && !operation.current && event.target === event.currentTarget && event.button === 0 && outside ? event.pointerId : null;
      }}
      onPointerCancel={() => { backdropPointer.current = null; }}
      onPointerUp={event => {
        const startedOutside = backdropPointer.current === event.pointerId; backdropPointer.current = null;
        const box = event.currentTarget.getBoundingClientRect();
        if (startedOutside && !busy && !operation.current && event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) closeSettings();
      }}
      onCancel={event => { if (busy || operation.current) event.preventDefault(); else closeSettings(); }} onClose={closeSettings}>
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('Browser & sign-in')}</h2><Button variant="ghost" size="icon" disabled={busy} aria-label={t('Close settings')} onClick={() => dialog.current?.close()}><X size={18} /></Button></div>
      <label className="mt-5 flex items-center justify-between gap-3 text-sm font-semibold">{t('Language')}<select name="browsersettings-select-1" aria-label={t('Language')} value={locale} onChange={event => setLocale(event.target.value as Locale)} className="rounded-xl border border-slate-200 bg-white px-3 py-2"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <FontPreferenceControls />
      <label className="completion-effect-setting">{t('Session completion attention')}
        <select name="browsersettings-select-2" value={completionEffect} onChange={event => { try { saveCompletionEffect(event.target.value as CompletionEffect); } catch { setError(t('Browser storage unavailable.')); } }}>
          <option value="flash">{t('Flash · 3 clear highlights')}</option>
          <option value="heartbeat">{t('Heartbeat · 3 visible pulses')}</option>
          <option value="glow">{t('Glow only')}</option>
          <option value="off">{t('Off')}</option>
        </select>
        <small>{t('Focused sessions are quieter. Respects reduced motion. No repeated alerts for past completions.')}</small>
      </label>
      <div className="completion-diagnostic-actions">
        <Button type="button" variant="secondary" onClick={downloadCompletionDiagnostics}>{t('Download animation diagnostics')}</Button>
        <small>{t('Recent state and playback only; no message content. Kept in memory until refresh.')}</small>
      </div>
      <WorkspaceSyncSettings />
      {open ? <Suspense fallback={null}><BrowserDiagnosticsSettings /></Suspense> : null}
      <Suspense fallback={null}><WeixinSettings /></Suspense>
      <section className="mt-5 space-y-3"><h3 className="font-semibold">{t('Notifications')}</h3><p className="text-sm text-slate-600">{t(permission === 'granted' && enabled ? 'Enabled' : permission === 'denied' ? 'Blocked in browser settings' : 'Not enabled')} · {t('This browser only. Keep AgentOpsDeck open in a tab to receive run results.')}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => void changeNotifications()}>{t(permission === 'granted' && enabled ? 'Send test notification' : 'Enable notifications')}</Button>
          {enabled && permission === 'granted' ? <Button variant="ghost" disabled={busy} onClick={() => { try { localStorage.setItem('agentopsdeck.notifications', 'off'); setEnabled(false); } catch { setError(t('Browser storage unavailable.')); } }}>{t('Turn off')}</Button> : null}</div>
      </section>
      <section className="mt-6 space-y-3 border-t border-slate-200 pt-4"><h3 className="font-semibold">{t('Passkeys')}</h3><p className="break-all text-sm text-slate-600">{t('Sign in to this Hub at {host}. Passkeys do not configure or unlock a Connector.', { host: window.location.hostname })}</p>
        {passkeyUnavailableReason() ? <p className="text-sm text-amber-800">{translate(passkeyUnavailableReason()!)}</p> : null}
        {keyLoading ? <p role="status" className="text-sm text-slate-500">{t('Loading passkeys…')}</p> : keyLoadError ? <div className="space-y-2">
          <p role="alert" className="text-sm text-red-700">{t(keyRegistrationSaved
            ? 'Passkey saved, but the list could not be refreshed. Retry loading the list; do not register again.'
            : 'Passkeys could not be loaded. Check your connection and retry. No changes were made.')}</p>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => { setKeyLoading(true); setKeyLoadAttempt(value => value + 1); }}>{t('Retry loading passkeys')}</Button>
        </div> : keyAccess ? <><label className="block text-sm">{t('Device label')}<input name="browsersettings-input-3" className="mt-1 w-full rounded-lg border border-slate-300 p-2" placeholder={t('My device')} maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
          <Button disabled={busy || !!passkeyUnavailableReason()} onClick={() => void addKey()}>{t(busy ? 'Please wait…' : 'Add passkey')}</Button>
          <ul className="space-y-2">{keys.map(key => <li key={key.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{key.label}</p><p className="text-xs text-slate-500">{key.lastUsedAt ? t('Last used {date}', { date: new Date(key.lastUsedAt).toLocaleDateString(locale) }) : t('Not used yet')}</p></div><Button variant="ghost" disabled={busy} onClick={() => void revoke(key)}>{t('Remove')}</Button></li>)}</ul>
          {!keys.length ? <p className="text-sm text-slate-500">{t('No passkeys registered. Your access key remains available.')}</p> : null}</> : <p className="text-sm text-slate-500">{t('Passkey management requires this Hub’s operator sign-in. Member access is unchanged.')}</p>}
      </section>
      {error ? <p role="alert" className="mt-4 text-sm text-red-700">{translate(error)}</p> : null}{notice ? <p role="status" className="mt-4 text-sm text-slate-700">{notice}</p> : null}
    </dialog> : null}</>;
}
