import { useEffect, useRef, useState } from 'react';
import { api, recoveryScope, type AuthAuditPage, type HubUser } from '../api';
import { Button } from './ui/button';
import { useI18n, type TranslationKey } from '../lib/i18n';

const eventLabels: Partial<Record<string, TranslationKey>> = {
  access_key_login: 'Key login', access_key_logout: 'Sign out', member_key_issued: 'Key issued',
  member_key_revoked: 'Key revoked', role_changed: 'Role changed', api_authz: 'Request denied', passkey_bind: 'Passkey added',
  passkey_revoke: 'Passkey removed', passkey_assertion: 'Passkey login',
};

export function HubLoginActivity({ users }: { users: HubUser[] }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState<AuthAuditPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | ''>('');
  const generation = useRef(0);
  const scope = recoveryScope();

  useEffect(() => {
    const clear = () => { generation.current++; setPage(undefined); setError(''); setOpen(false); };
    window.addEventListener('agentopsdeck:auth-required', clear);
    return () => { generation.current++; window.removeEventListener('agentopsdeck:auth-required', clear); };
  }, []);

  async function load(before = '') {
    const request = ++generation.current;
    setBusy(true); setError('');
    if (!before) setPage(undefined);
    try {
      const next = await api.authActivity(userId, before);
      if (request === generation.current && scope === recoveryScope()) setPage(previous => ({ ...next,
        records: before && previous ? [...previous.records, ...next.records] : next.records }));
    } catch {
      if (request === generation.current && scope === recoveryScope()) setError('Activity unavailable. Refresh to try again.');
    } finally { if (request === generation.current) setBusy(false); }
  }

  useEffect(() => {
    if (open) void load();
    else { generation.current++; setPage(undefined); setBusy(false); }
  }, [open, userId]);

  const label = (id: string | undefined) => users.find(user => user.id === id)?.label ?? id ?? t('Unattributed');

  return <section className="border-t border-slate-200 p-4 sm:p-5" aria-label={t('Login activity')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-bold">{t('Login & security activity')}</h3><p className="text-xs text-slate-500">{t('Administrator-only history, separate from access settings.')}</p></div>
      <Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t(open ? 'Close activity' : 'View login activity')}</Button>
    </div>
    {open ? <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs font-semibold">{t('User')}
          <select name="hubloginactivity-select-1" aria-label={t('Activity user')} className="mt-1 w-full rounded-xl border bg-white p-2" value={userId} onChange={event => { generation.current++; setPage(undefined); setUserId(event.currentTarget.value); }}>
            <option value="">{t('All users & unknown attempts')}</option>
            {users.map(user => <option key={user.id} value={user.id}>{user.label}</option>)}
          </select>
        </label>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>{t('Refresh activity')}</Button>
      </div>
      <p className="text-xs text-slate-500">{t('Invalid keys cannot reliably identify a user; failed attempts appear under All users. Activity does not mean someone is online.')}</p>
      {page ? <p className="text-xs text-slate-500">{page.persistent ? t('Saved in this Hub · up to {days} days or {count} events, whichever is reached first.', { days: page.retentionDays ?? t('unknown'), count: page.maxRecords.toLocaleString(locale) }) : t('Temporary history only; lost when this server restarts.')} {page.startedAt ? t('Tracking began {date}. Earlier activity is unavailable.', { date: new Date(page.startedAt).toLocaleString(locale) }) : ''}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{t(error)}</p> : null}
      {busy ? <p role="status" className="text-xs">{t('Loading activity…')}</p> : null}
      {page && !page.records.length ? <p className="rounded-xl bg-slate-50 p-4 text-sm">{t('No recorded events in the retained history for this selection.')}</p> : null}
      <ul className="space-y-2">{page?.records.map(record => <li key={record.id} className="min-w-0 rounded-xl border border-slate-200 p-3 text-xs [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{eventLabels[record.event] ? t(eventLabels[record.event]!) : record.event} · {label(record.userId)}</span><span className={record.outcome === 'success' ? 'text-emerald-700' : 'text-amber-800'}>{t(record.outcome === 'throttled' ? 'Rate limited' : record.outcome === 'success' ? 'Succeeded' : 'Failed')}</span></div>
        <p className="mt-1 text-slate-500">{new Date(record.ts).toLocaleString(locale)}{record.authMethod ? ` · ${t(record.authMethod === 'member' ? 'Member' : 'Administrator')}` : ''}{record.actorUserId ? ` · ${t('By {name}', { name: label(record.actorUserId) })}` : ''}</p>
        {record.keyId ? <p className="mt-1">{t('Key ID')} · <span className="font-mono">{record.keyId}</span></p> : null}
        <details className="mt-2 text-slate-500"><summary className="cursor-pointer">{t('Technical details')}</summary>
          <p>{t('Event ID')}: {record.id}</p>{record.reason ? <p>{t('Reason')}: {record.reason}</p> : null}
          {record.ipHash ? <p>{t('Network fingerprint')}: {record.ipHash}</p> : null}{record.userAgentHash ? <p>{t('Browser fingerprint')}: {record.userAgentHash}</p> : null}
          <p>{t('Fingerprints are hashed request metadata, not verified device or location identities. No key secrets are stored here.')}</p>
        </details>
      </li>)}</ul>
      {page?.nextCursor ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load(page.nextCursor)}>{t('Load older activity')}</Button> : null}
    </div> : null}
  </section>;
}
