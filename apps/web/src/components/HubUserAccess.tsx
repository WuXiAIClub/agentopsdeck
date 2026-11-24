import { translate, useI18n } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import type { NodeAction, SessionSummary } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope, subscribeRecoveryScope, type HubConnection, type HubLoginKey, type HubNodeGrant, type HubNodeGrantPage, type HubUser } from '../api';
import { MemberEnvironmentAccess } from './MemberEnvironmentAccess';
import { AccessRoleMatrix } from './AccessRoleMatrix';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { confirmAction } from './ui/confirm';
import type { HubAccountAccess } from '../lib/hub-user-access';

function useAccessLifetime() {
  const active = useRef(true);
  const epoch = useRef(recoveryEpoch()).current;
  const scope = recoveryScope();
  useEffect(() => {
    active.current = true;
    const expired = () => { active.current = false; };
    window.addEventListener('agentopsdeck:auth-required', expired);
    return () => { active.current = false; window.removeEventListener('agentopsdeck:auth-required', expired); };
  }, []);
  return () => active.current && scope === recoveryScope() && epoch === recoveryEpoch();
}

export function HubUserAccess({ user, connections, actorUserId }: { user: HubUser; connections: HubConnection[]; actorUserId: string }) {
  return <HubUserAccessPanel key={JSON.stringify([recoveryScope(), user.id])} user={user} connections={connections} actorUserId={actorUserId} />;
}

function HubUserAccessPanel({ user, connections, actorUserId }: { user: HubUser; connections: HubConnection[]; actorUserId: string }) {
  const { t, locale } = useI18n();
  const current = useAccessLifetime();
  const pending = useRef(false);
  const disclosureEpoch = useRef(0);
  const [loginOpen, setLoginOpen] = useState(false);
  const [keys, setKeys] = useState<HubLoginKey[]>([]);
  const [secret, setSecret] = useState<{ id: string; token: string }>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<HubAccountAccess>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  useEffect(() => {
    setConnectionId(previous => connections.some(connection => connection.id === previous) ? previous : connections[0]?.id ?? '');
  }, [connections]);

  async function refresh() {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setReady(false); setAccess(undefined); setError('');
    try {
      const [result, state] = await Promise.all([api.hubLoginKeys(user.id), api.hubUserAccess(user.id)]);
      if (current()) {
        if (state.status === 'disabled' || access && state.version !== access.version) {
          disclosureEpoch.current += 1; setSecret(undefined);
        }
        setKeys(result.keys); setAccess(state); setReady(true);
      }
    } catch { if (current()) { setKeys([]); setError('Account state or login key list unavailable. Refresh before making changes.'); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const hide = () => { disclosureEpoch.current += 1; setSecret(undefined); };
    const hidden = () => { if (document.visibilityState === 'hidden') hide(); };
    window.addEventListener('agentopsdeck:auth-required', hide);
    const unsubscribe = subscribeRecoveryScope(hide);
    document.addEventListener('visibilitychange', hidden);
    return () => { unsubscribe(); window.removeEventListener('agentopsdeck:auth-required', hide); document.removeEventListener('visibilitychange', hidden); };
  }, []);

  async function issue() {
    if (pending.current || !ready || access?.status !== 'enabled' || secret || !current() || document.visibilityState !== 'visible') return;
    const issuedInEpoch = disclosureEpoch.current;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.hubIssueLoginKey(user.id);
      if (!current()) return;
      const canReveal = issuedInEpoch === disclosureEpoch.current && document.visibilityState === 'visible';
      if (canReveal) setSecret(result);
      setNotice(canReveal ? 'Key issued. Save it now; its value cannot be retrieved again.'
        : 'Key issued while this page was hidden. Its secret was discarded. Revoke the unclaimed key in the refreshed list before issuing another.');
      setReady(false);
      try {
        const [latest, state] = await Promise.all([api.hubLoginKeys(user.id), api.hubUserAccess(user.id)]);
        if (current()) {
          if (state.status === 'disabled' || state.version !== access.version) {
            disclosureEpoch.current += 1; setSecret(undefined);
            setNotice('Account state changed during key issuance. Its secret was discarded. Review the current account and key list before proceeding.');
          }
          setKeys(latest.keys); setAccess(state); setReady(true);
        }
      } catch {
        if (current()) {
          setAccess(undefined); setKeys([]);
          setError(canReveal ? 'Key issued, but the list could not refresh. Keep this key and refresh the list; do not issue another.'
            : 'Key issued while this page was hidden. Its secret was discarded. Revoke the unclaimed key in the refreshed list before issuing another.');
        }
      }
    } catch {
      if (current()) { setReady(false); setError('Issuance was not confirmed. Nothing was retried. Refresh keys and revoke any unclaimed new key before issuing another.'); }
    } finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function revoke(id: string) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (!await confirmAction({ title: t('Revoke key'), description: t('Revoke this login key and all browser logins created with it? Already running tasks are not stopped.'), confirmLabel: t('Revoke key') }) || !current()) return;
      await api.hubRevokeLoginKey(user.id, id);
      if (current()) {
        setKeys(rows => rows.filter(key => key.id !== id));
        if (secret?.id === id) setSecret(undefined);
        setNotice('Login key revoked. Associated logins can no longer authorize requests.');
      }
    } catch { if (current()) { setReady(false); setError('Revocation was not confirmed. Refresh to check; nothing was retried.'); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function changeAccess() {
    if (pending.current || !ready || !access || !current() || user.id === 'default' || user.id === actorUserId
      || access.version === Number.MAX_SAFE_INTEGER) return;
    const reviewed = access;
    const status = reviewed.status === 'enabled' ? 'disabled' : 'enabled';
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (!await confirmAction({ title: t(status === 'disabled' ? 'Disable account' : 'Restore account'),
        description: t(status === 'disabled'
          ? 'Disable {user}? All login keys, browser logins and received grants will be revoked atomically. Roles and owned Connectors are retained. Already dispatched tools are not stopped.'
          : 'Restore {user}? Old keys, browser logins and revoked grants will not return. Issue a new personal key and review access afterwards.', { user: user.label }),
        confirmLabel: t(status === 'disabled' ? 'Disable account' : 'Restore account') }) || !current()) return;
      disclosureEpoch.current += 1; setSecret(undefined); setKeys([]); setReady(false); setAccess(undefined);
      const result = await api.hubChangeUserAccess(user.id, { status, expectedVersion: reviewed.version });
      if (!current()) return;
      setAccess(result);
      setNotice(status === 'disabled' ? 'Account disabled. Refresh to check its current state. Already dispatched tools are not stopped.'
        : 'Account restored without old credentials or grants. Refresh, then issue a new key and review access.');
    } catch {
      if (current()) { setAccess(undefined); setReady(false); setError('Account change was not confirmed or was refused. Nothing was retried. Refresh its current state before another change. Default, your own account and the last human administrator are protected.'); }
    } finally { pending.current = false; if (current()) setBusy(false); }
  }

  const date = (value?: number | null) => value ? new Date(value).toLocaleString(locale) : t('Not recorded');
  return <section aria-label={t('Access for {user}', { user: user.label })} className="min-w-0 space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-3 [overflow-wrap:anywhere]">
    <div>
      <h3 className="text-lg font-bold">{t('Access for {user}', { user: user.label })}</h3>
    </div>
    <section aria-label={t('Account lifecycle')} className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold">{t('Account lifecycle')}</h4>
        <span role="status" className="text-xs">{access ? t(access.status === 'disabled' ? 'Account disabled · version {version}' : 'Account enabled · version {version}', { version: access.version }) : t('Account state needs refresh')}</span>
      </div>
      <p className="text-xs text-slate-600">{t('Account state is a global gate, separate from saved roles. Restoring an account never restores old credentials or revoked grants.')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || !ready || !access || user.id === 'default' || user.id === actorUserId || access.version === Number.MAX_SAFE_INTEGER} onClick={changeAccess}>{t(access?.status === 'disabled' ? 'Restore account' : 'Disable account')}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={refresh}>{t('Refresh account & keys')}</Button>
      </div>
      {user.id === 'default' || user.id === actorUserId ? <p className="text-xs text-slate-600">{t('Default and your own account cannot be disabled here.')}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{translate(error)}</p> : null}
      {notice ? <p role="status" className="text-xs text-blue-800">{translate(notice)}</p> : null}
    </section>
    <fieldset disabled={busy || !ready || access?.status !== 'enabled'} className="min-w-0"><AccessRoleMatrix user={user} /></fieldset>
    <details open={loginOpen || Boolean(secret) || Boolean(error) || ready && !keys.length} onToggle={event => setLoginOpen(event.currentTarget.open)} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" aria-label={t("Member login keys")}>
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold">{t("Login & keys")}</span>
        <span role="status" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{access?.status === 'disabled' ? t('Account disabled') : secret ? t('Key issued · save it now') : !ready ? t(busy ? 'Checking keys…' : 'Needs refresh') : keys.length ? t('Login enabled · keys: {count}', { count: keys.length }) : t('Login key needed')}</span>
      </summary>
      <p className="text-xs text-slate-600">{t("Issue a personal key. Its privileges follow the saved Hub and Connector roles; never share your own administrator key.")}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !ready || access?.status !== 'enabled' || Boolean(secret)} onClick={() => void issue()}>{t("Issue member login key")}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>{t("Refresh keys")}</Button>
      </div>
      {secret ? <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
        <p className="text-xs font-bold">{t("One-time secret — share privately, not in a URL or screenshot. Hidden when this tab is backgrounded.")}</p>
        <Input aria-label={t("One-time member login key")} readOnly value={secret.token} autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} />
        <p className="text-xs">{t('Key ID: {id}', { id: secret.id })}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => {
            void navigator.clipboard?.writeText(secret.token).then(() => { if (current()) setNotice('Copied. Deliver privately and clear your clipboard afterwards.'); })
              .catch(() => { if (current()) setNotice('Clipboard unavailable. Select the key and copy manually.'); });
            if (!navigator.clipboard) setNotice('Clipboard unavailable. Select the key and copy manually.');
          }}>{t("Copy key")}</Button>
          <Button size="sm" variant="secondary" onClick={() => { setSecret(undefined); setNotice('Secret hidden. Continue with environment access below.'); }}>{t("Hide key")}</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void revoke(secret.id)}>{t("Revoke this key")}</Button>
        </div>
      </div> : null}
      <p className="text-xs text-slate-600">{t("Sign in with the member key in a separate browser profile or private window. Keys are not stored in browser storage by this panel.")}</p>
      {!ready && !busy ? <p className="text-xs">{t("Refresh keys to check the saved list before issuing another key.")}</p> : null}
      <details className="rounded-xl border border-slate-200 p-3">
      <summary className="cursor-pointer text-xs font-semibold">{t(ready ? 'Manage existing login keys ({count})' : 'Manage existing login keys ({count} · not current)', { count: keys.length })}</summary>
      <p className="mt-2 text-xs text-slate-500">{t("Counts start when tracking is enabled. Key use means a login or direct API authentication; browser activity uses its session cookie and is sampled at most once per minute. Neither indicates someone is online.")}</p>
      <ul className="mt-3 space-y-2">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="min-w-0 space-y-1"><p><span className="font-mono">{key.id}</span> <span className="text-emerald-700">{t("· Active key")}</span></p>
          <p className="text-slate-500">{t('Created {date}', { date: date(key.createdAt) })}</p>
          <p>{t('{count} recorded logins · Last login: {date}', { count: key.loginCount ?? 0, date: date(key.lastLoginAt) })}</p>
          <p>{t('Key last used: {date}', { date: date(key.lastUsedAt) })}</p>
          <p>{t('Last activity: {date}', { date: date(key.lastActiveAt) })}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={busy || !ready} onClick={() => void revoke(key.id)}>{t("Revoke key")}</Button>
      </li>)}</ul>
      </details>
    </details>
    <fieldset disabled={busy || !ready || access?.status !== 'enabled'} className="min-w-0">
    <details className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" aria-label={t("Legacy environment authorization")}>
      <summary className="cursor-pointer text-xs font-semibold">{t("Legacy authorizations · advanced")}</summary>
      <h4 className="text-sm font-bold">{t("Environment access")}</h4>
      <label className="block text-xs font-semibold">{t("Environment")}
        <select name="hubuseraccess-select-1" aria-label={t("Grant environment")} className="mt-1 w-full rounded-xl border bg-white p-2" value={connectionId} onChange={event => setConnectionId(event.currentTarget.value)}>
          <option value="">{t("Select an environment")}</option>
          {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
        </select>
      </label>
      {!connections.length ? <p className="text-xs">{t("You have no owned environments to share.")}</p> : null}
      {connectionId && connections.some(connection => connection.id === connectionId) ? <MemberEnvironmentAccess key={connectionId} user={user} connectionId={connectionId} isOwner={(connections.find(connection => connection.id === connectionId)?.ownerUserId ?? 'default') === user.id} customEditor={<NodeGrantEditor user={user} connectionId={connectionId} />} /> : null}
    </details>
    </fieldset>
    <p className="text-xs text-slate-600">{t('After saving access, open Shared with me or create a new chat. If already signed in, refresh the environment list.')} <a className="font-semibold text-blue-700 underline" href="#/shared">{t("Shared with me")}</a></p>
  </section>;
}

function NodeGrantEditor({ user, connectionId }: { user: HubUser; connectionId: string }) {
  const { t } = useI18n();
  const current = useAccessLifetime();
  const pending = useRef(false);
  const [page, setPage] = useState<HubNodeGrantPage>();
  const [cursor, setCursor] = useState<string>();
  const [sessions, setSessions] = useState<Array<{ key: string; label: string }>>([]);
  const [sessionError, setSessionError] = useState('');
  const [advanced, setAdvanced] = useState(true);
  const [sessionKey, setSessionKey] = useState('');
  const [allSessions, setAllSessions] = useState(false);
  const [send, setSend] = useState(false);
  const [queue, setQueue] = useState(false);
  const [createSessions, setCreateSessions] = useState(false);
  const [discovery, setDiscovery] = useState(true);
  const [events, setEvents] = useState(true);
  const [editing, setEditing] = useState<HubNodeGrant>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [savedGrantId, setSavedGrantId] = useState('');

  async function refresh(after?: string, preserveError = false) {
    if (pending.current) return;
    setCreateSessions(false);
    pending.current = true; setBusy(true); setPage(undefined); if (!preserveError) setError(''); setConfirmed(false); setSend(false); setQueue(false); setEditing(undefined); setDiscovery(true); setEvents(true);
    try {
      const next = await api.hubNodeGrants(connectionId, after);
      if (current()) { setPage(next); setCursor(after); }
    } catch { if (current()) setError('Authorization list unavailable. Refresh before changing access.'); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function loadSessions() {
    setSessionError(''); setSessions([]); setSessionKey('');
    try {
      const snapshot = await api.sessionsState();
      if (!current()) return;
      const rows = snapshot.groups.flatMap(group => group.sessions) as Array<SessionSummary & { envConnectionId?: string; remoteSessionKey?: string }>;
      setSessions(rows.filter(session => session.envConnectionId === connectionId && session.remoteSessionKey?.startsWith('codex:'))
        .map(session => ({ key: session.remoteSessionKey!, label: session.title || session.remoteSessionKey! })));
    } catch { if (current()) setSessionError('Session snapshot unavailable; refresh sessions. No session was selected.'); }
  }
  useEffect(() => { void refresh(); void loadSessions(); }, []);
  async function create() {
    if (pending.current || !current() || !page?.verified || !confirmed || (!allSessions && !sessionKey) || (send && !page.executionConfigured)) return;
    if (createSessions && !(allSessions && send && discovery && page.creationConfigured)) {
      setError('Creation requires an enabled creation issuer and environment-wide discovery, reading and sending. Review the scope before saving.');
      return;
    }
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const actions: NodeAction[] = ['messages:read'];
    if (discovery) actions.push('sessions:read');
    if (events) actions.push('events:read');
    if (send) actions.push('messages:send');
    if (queue && send) actions.push('queue:manage');
    if (createSessions && allSessions && send && discovery && page.creationConfigured) actions.push('sessions:create');
    try {
      const policy = { runtime: 'codex' as const, ...(!allSessions ? { sessionKey } : {}), actions };
      const { grant } = editing ? await api.hubUpdateNodeGrant(connectionId, editing, page.nodeVersion, policy)
        : await api.hubCreateNodeGrant(connectionId, { userId: user.id, nodeVersion: page.nodeVersion, policy });
      if (current()) { setSavedGrantId(grant.id); setNotice('Authorization saved. Refresh Shared with me; the saved list is rechecked automatically.'); setPage(undefined); setConfirmed(false); }
    } catch { if (current()) { setPage(undefined); setError('Authorization was not confirmed. Nothing was retried. Refresh to check the saved list before granting again.'); } }
    finally { pending.current = false; if (current()) { setBusy(false); await refresh(undefined, true); } }
  }
  async function revokeGrant(grant: HubNodeGrant) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true);
    let attempted = false;
    try {
      if (!await confirmAction({ title: t('Revoke authorization'), description: t('Revoke this authorization and all session access/shares derived from it? Other independent grants may still allow access. Already running tasks are not stopped.'), confirmLabel: t('Revoke authorization') }) || !current()) return;
      attempted = true; setError(''); setNotice('');
      await api.hubRevokeNodeGrant(connectionId, grant);
      if (current()) { setPage(undefined); setNotice('Authorization and dependent session access revoked. The saved list is rechecked automatically. Independent grants and already-running tasks may remain.'); }
    } catch { if (current()) { setPage(undefined); setError('Revocation was not confirmed or the version changed. Refresh and check; nothing was retried.'); } }
    finally { pending.current = false; if (current()) { setBusy(false); if (attempted) await refresh(undefined, true); } }
  }
  return <div className="space-y-3 text-xs">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>{t("Refresh authorizations")}</Button>
    </div>
    {error ? <p role="alert" className="text-red-700">{translate(error)}</p> : null}
    {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{translate(notice)}{notice.startsWith('Authorization saved.') ? <span className="block font-mono">{savedGrantId}</span> : null}</p> : null}
    {sessionError ? <p role="alert">{translate(sessionError)}</p> : null}
    {!page && !error && !notice ? <p role="status">{t(busy ? 'Loading authorizations…' : 'Refresh authorizations to configure access.')}</p> : null}
    {page ? <>
      <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <summary className="cursor-pointer py-1 font-semibold text-slate-700">{t("Custom capability editor")}</summary>
      <div className="mt-3 space-y-3">
      <p>{t("Use this for read-only access, a single session, queue controls or custom permissions.")}</p>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void loadSessions()}>{t("Refresh sessions")}</Button>
      <p>{t("Environment execution is managed in Environments → Member execution, not in member permissions.")}</p>
      <fieldset disabled={busy || !page.verified} className="min-w-0 space-y-3">
        {editing ? <p className="font-bold">{t('Editing authorization {id} · version {version}. This replaces only this grant; other grants are additive.', { id: editing.id, version: editing.version })}</p> : null}
        <label className="block">{t("Permission preset")} <select name="hubuseraccess-select-2" aria-label={t("Permission preset")} className="mt-1 w-full rounded-xl border bg-white p-2" value={createSessions || !discovery || !events ? 'custom' : queue ? 'queue' : send ? 'chat' : 'read'} onChange={event => {
            const value = event.currentTarget.value;
            if (value === 'custom') return;
            setSend(value !== 'read'); setQueue(value === 'queue'); setCreateSessions(false); setDiscovery(true); setEvents(true); setConfirmed(false);
          }}>
            <option value="read">{t("Read-only")}</option><option value="chat" disabled={!page.executionConfigured}>{t("Read and send")}</option>
            <option value="queue" disabled={!page.executionConfigured}>{t("Read, send and manage own queue")}</option><option value="custom">{t("Custom capabilities")}</option>
          </select>
        </label>
        <label className="block">{t("Codex scope")} <select name="hubuseraccess-select-3" aria-label={t("Grant scope")} className="mt-1 w-full min-w-0 rounded-xl border bg-white p-2" value={allSessions ? 'all' : 'session'} onChange={event => { setAllSessions(event.currentTarget.value === 'all'); setCreateSessions(false); setConfirmed(false); }}>
            <option value="session">{t("One existing Codex session (recommended)")}</option>
            <option value="all">{t("All current and future Codex sessions on this node")}</option>
          </select>
        </label>
        {!allSessions ? <label className="block">{t("Session")} <select name="hubuseraccess-select-4" aria-label={t("Grant session")} className="mt-1 w-full min-w-0 rounded-xl border bg-white p-2" value={sessionKey} onChange={event => { setSessionKey(event.currentTarget.value); setConfirmed(false); }}>
            <option value="">{t("Select a session")}</option>
            {sessionKey && !sessions.some(session => session.key === sessionKey) ? <option value={sessionKey}>{t('Previously authorized session ({session})', { session: sessionKey })}</option> : null}
            {sessions.map(session => <option key={session.key} value={session.key}>{session.label}</option>)}
          </select>
          {sessionKey ? <span className="mt-1 block font-mono">{sessionKey}</span> : null}
          {!sessions.length ? <span>{t("No visible Codex sessions. Create one as the owner, then refresh sessions.")}</span> : null}
        </label> : <p className="font-semibold text-amber-800">{t("This includes other people's conversations and future Codex sessions on this environment.")}</p>}
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-5" type="checkbox" checked disabled />{t("Read message history (required for this shared-session UI)")}</label>
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-6" type="checkbox" checked={discovery} onChange={event => { setDiscovery(event.currentTarget.checked); if (!event.currentTarget.checked) setCreateSessions(false); setConfirmed(false); }} />{t("Discover sessions in the selected scope")}</label>
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-7" type="checkbox" checked={events} onChange={event => { setEvents(event.currentTarget.checked); setConfirmed(false); }} />{t("Receive live events")}</label>
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-8" type="checkbox" checked={send} disabled={!page.executionConfigured} onChange={event => { setSend(event.currentTarget.checked); if (!event.currentTarget.checked) { setQueue(false); setCreateSessions(false); } setConfirmed(false); }} />{t("Allow sending messages (requires a configured execution issuer)")}</label>
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-9" type="checkbox" checked={createSessions} disabled={!page.creationConfigured || !allSessions || !send || !discovery} onChange={event => { setCreateSessions(event.currentTarget.checked); setConfirmed(false); }} />{t("Create Codex sessions in this environment")}</label>
        {!page.creationConfigured || !allSessions || !send || !discovery ? <p className="font-semibold text-amber-800">{t('Creation is disabled: {reasons}. Use the Developer role in the role overview for access to own new sessions.', { reasons: [!page.creationConfigured && t('Environment creation is not enabled'), !allSessions && t('Scope is one existing session'), !send && t('Sending is off'), !discovery && t('Session discovery is off')].filter(Boolean).join(' · ') })}</p> : null}
        <p>{t("This advanced form combines creation with broad shared access. For own-session access without reading other members’ sessions, return to the role overview and select Developer instead. Environment owners and existing broad grants retain access. A single-session grant never allows creation.")}</p>
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-10" type="checkbox" checked={queue} disabled={!page.executionConfigured || !send} onChange={event => { setQueue(event.currentTarget.checked); setConfirmed(false); }} />{t("Manage own queued messages (edit and cancel, not other users' queues)")}</label>
        <p>{t("Sending may invoke Codex tools using the shared runtime's filesystem and credentials; this is not a sandbox. Multiple grants add permissions; editing one does not remove access granted elsewhere.")}</p>
        <details><summary>{t("Capabilities not yet available to shared members")}</summary><p>{t("Deleting sessions, settings, interrupt/compact, media, mirror and node administration are not supported by this flow. They are not implicitly granted by read/write access. OpenClaw sharing remains on hold.")}</p></details>
        {!allSessions && !discovery ? <p>{t("Session discovery is off; the member can still open this exact session from the grant.")}</p> : allSessions && !discovery ? <p className="text-amber-800">{t("Discovery is off: this broad grant will not list sessions. Share exact session links separately.")}</p> : null}
        <label className="flex items-start gap-2"><input name="hubuseraccess-input-11" aria-label={t("Confirm grant scope")} type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />{t('I approve access for {user}: {permissions} · {scope}', { user: user.label, permissions: t(send ? 'Read and send' : 'Read-only'), scope: t(allSessions ? 'All current and future Codex sessions on this node' : 'The selected session') })}{createSessions ? ` · ${t('Create Codex sessions in this environment')}` : ''}</label>
        <Button size="sm" disabled={!confirmed || (!allSessions && !sessionKey)} onClick={() => void create()}>{t(editing ? 'Save authorization changes' : 'Grant access')}</Button>
        {editing ? <Button size="sm" variant="secondary" onClick={() => void refresh()}>{t("Cancel editing")}</Button> : null}
      </fieldset>
      </div>
      </details>
      <h5 className="font-bold">{t('Saved authorizations for {user} on this page', { user: user.label })}</h5>
      {!page.grants.some(grant => grant.userId === user.id) ? <p className="rounded-xl bg-slate-50 p-3 text-slate-600">{t("No saved access on this page. Return to the role overview to add an environment role.")}{page.nextCursor || cursor ? ` ${t('Check other pages for existing access.')}` : ''}</p> : null}
      <ul className="space-y-3">{page.grants.filter(grant => grant.userId === user.id).map(grant => <li key={grant.id} className="space-y-1 rounded-xl border bg-white p-3">
        <p className="text-sm font-semibold">{grant.policy.runtime ?? t('All runtimes')} · {t(grant.derived ? grant.policy.actions.includes('sessions:share') ? 'Created session · owner' : 'Shared session · participant' : grant.policy.sessionKey ? 'One session' : grant.policy.agentId ? 'One agent' : grant.policy.actions.length === 1 && grant.policy.actions.includes('sessions:create') ? 'Developer · own new sessions' : 'All sessions · broad access')}</p>
        {!grant.policy.sessionKey && grant.policy.actions.some(action => ['sessions:read', 'messages:read', 'messages:send'].includes(action)) ? <p className="rounded-lg bg-amber-50 p-2 text-amber-900">{t("Broad access: includes other members’ current and future sessions. Adding a developer role does not remove this authorization.")}</p> : null}
        <p className={grant.revoked || grant.nodeVersion !== page.nodeVersion ? 'font-semibold text-amber-800' : 'font-semibold text-slate-700'}>{t(grant.revoked ? 'Revoked' : grant.nodeVersion !== page.nodeVersion ? 'Needs reauthorization · environment permissions changed' : !page.verified ? 'Saved · environment unavailable or unverified' : 'Saved · current environment version')}</p>
        <div className="flex flex-wrap gap-1">{grant.policy.actions.map(action => <span key={action} className="rounded-full bg-slate-100 px-2 py-1">{translate(({ 'sessions:create': 'Create sessions', 'sessions:read': 'Find sessions', 'messages:read': 'Read messages', 'messages:send': 'Send messages', 'events:read': 'Live replies', 'queue:manage': 'Manage own queue' } as Partial<Record<NodeAction, string>>)[action] ?? action)}</span>)}</div>
        <details><summary className="cursor-pointer py-2 text-slate-500">{t("Technical details")}</summary><p className="font-mono">{t('{id} · version {version}', { id: grant.id, version: grant.version })}</p><p>{grant.policy.sessionKey ?? grant.policy.agentId ?? t('All sessions')} · {grant.policy.actions.join(', ')}</p></details>
        <Button size="sm" variant="secondary" disabled={busy || grant.revoked || grant.derived || grant.policy.actions.length === 1 && grant.policy.actions.includes('sessions:create') || grant.policy.runtime !== 'codex' || Boolean(grant.policy.agentId)
          || grant.policy.actions.some(action => !['sessions:create', 'sessions:read', 'messages:read', 'events:read', 'messages:send', 'queue:manage'].includes(action))} onClick={() => {
          setAdvanced(true); setEditing(grant); setSessionKey(grant.policy.sessionKey ?? ''); setAllSessions(!grant.policy.sessionKey);
          setSend(grant.policy.actions.includes('messages:send')); setQueue(grant.policy.actions.includes('queue:manage'));
          setCreateSessions(grant.policy.actions.includes('sessions:create'));
          setDiscovery(grant.policy.actions.includes('sessions:read')); setEvents(grant.policy.actions.includes('events:read')); setConfirmed(false); setNotice('');
        }}>{t("Edit authorization")}</Button>
        <Button size="sm" variant="secondary" disabled={busy || grant.revoked} onClick={() => void revokeGrant(grant)}>{t("Revoke authorization")}</Button>
      </li>)}</ul>
      {cursor || page.nextCursor ? <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || !cursor} onClick={() => void refresh()}>{t("First authorization page")}</Button>
        <Button size="sm" variant="secondary" disabled={busy || !page.nextCursor} onClick={() => void refresh(page.nextCursor ?? undefined)}>{t("Next authorization page")}</Button>
        <span>{t("Up to 50 grants for all recipients per page; revoked grants are retained.")}</span>
      </div> : null}
    </> : null}
  </div>;
}
