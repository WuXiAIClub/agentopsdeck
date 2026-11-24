import React, { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { AuthRequiredError, api, apiBaseUrl, forgetStoredAccessKey, setApiBaseUrl } from '../api';
import { authBodyError, passkeyError, passkeyUnavailableReason } from '../lib/passkey-ui';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { useI18n, translate, type Locale } from '../lib/i18n';

export { lockDeck } from '../lib/lock-deck';

export function UnlockScreen({ message, onUnlocked }: { message: string | undefined; onUnlocked: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrlState] = useState(() => apiBaseUrl());
  const [showAdvanced, setShowAdvanced] = useState(() => Boolean(apiBaseUrl()));
  const [submitting, setSubmitting] = useState<'key' | 'passkey' | undefined>();
  const [error, setError] = useState(message);
  const blocked = passkeyUnavailableReason();

  async function unlock(method: 'key' | 'passkey') {
    if (submitting) return;
    if (method === 'key' && !token.trim()) { setError('Access key is required.'); return; }
    setSubmitting(method); setError(undefined);
    setApiBaseUrl(baseUrl.trim() || undefined);
    forgetStoredAccessKey();
    try {
      if (method === 'key') { await api.loginWithAccessKey(token.trim()); setToken(''); }
      else {
        const optionsJSON = await api.passkeyLoginOptions();
        await api.verifyPasskeyLogin(await startAuthentication({ optionsJSON }));
      }
      const principal = await api.hubMe();
      if (!principal.admin && (!window.location.hash || window.location.hash === '#/tab/sessions')) window.location.hash = '#/shared';
      onUnlocked();
    } catch (err) {
      setError(authBodyError(err) ?? (method === 'passkey' ? passkeyError(err) : err instanceof AuthRequiredError ? 'Access key not accepted. Check it and try again.' : err instanceof Error ? err.message : String(err)));
    } finally { setSubmitting(undefined); }
  }

  return <main className="fixed inset-0 grid place-items-center overflow-auto bg-slate-100 p-5 text-slate-950">
    <Card className="w-full max-w-[440px] border-slate-200 bg-white p-6">
      <div className="mb-6"><div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-bold tracking-tight">{t('Welcome to AgentOpsDeck')}</h1><select name="auth-select-1" className="rounded-lg border border-slate-200 px-2 py-1 text-xs" aria-label={t('Language')} value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></div><p className="mt-2 break-all text-sm text-slate-500">{t('Sign in to {host}', { host: window.location.hostname })}</p></div>
      <Button type="button" className="h-11 w-full justify-center rounded-xl" disabled={!!submitting || !!blocked} onClick={() => void unlock('passkey')}>
        {t(submitting === 'passkey' ? 'Waiting for your device…' : 'Sign in with passkey')}
      </Button>
      <p className="mt-2 text-xs leading-5 text-slate-500">{blocked ? translate(blocked) : t('Use a passkey saved for this Hub hostname. New device? Sign in with your access key, then add a passkey in Browser & sign-in settings.')}</p>
      <form className="mt-6 space-y-4 border-t border-slate-200 pt-5" onSubmit={event => { event.preventDefault(); void unlock('key'); }}>
        <label className="block space-y-2"><span className="text-sm font-medium">{t('Access key')}</span><Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={t('Your AgentOpsDeck access key')} autoComplete="current-password" className="h-11 rounded-xl" /></label>
        <Button type="submit" variant="secondary" className="h-11 w-full justify-center rounded-xl" disabled={!!submitting}>{t(submitting === 'key' ? 'Signing in…' : 'Sign in with access key')}</Button>
        <button type="button" className="text-xs text-slate-500 underline underline-offset-4" onClick={() => setShowAdvanced(value => !value)} aria-expanded={showAdvanced}>{t('API settings')}</button>
        {showAdvanced ? <label className="block space-y-2 text-xs text-slate-500">{t('Backend URL')}<Input value={baseUrl} onChange={event => setBaseUrlState(event.target.value)} placeholder={t('Same-origin /api (default)')} /><span className="block">{t('Leave empty unless using a separate backend configured for cookie credentials.')}</span></label> : null}
        {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{translate(error)}</p> : null}
      </form>
    </Card>
  </main>;
}
