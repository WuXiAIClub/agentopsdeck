import { translate, useI18n } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { Code2, Eye, LockKeyhole, Server, ShieldCheck } from 'lucide-react';
import { api, recoveryEpoch, recoveryScope, type AccessConnection, type AccessDirectory, type ConnectorMembership, type ConnectorRole, type HubRoleState, type HubUser } from '../api';
import { Button } from './ui/button';
import { confirmAction } from './ui/confirm';

const selectStyle = 'min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-100';
const labels: Record<ConnectorRole, string> = { none: 'No access', admin: 'Connector admin', developer: 'Developer', observer: 'Observer' };
function useCurrent(identity = '') {
  const active = useRef(false), scope = recoveryScope(), epoch = recoveryEpoch();
  const key = JSON.stringify([scope, epoch, identity]), latest = useRef(key), generation = useRef(0);
  if (latest.current !== key) { latest.current = key; generation.current++; }
  const captured = generation.current;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return () => active.current && scope === recoveryScope() && epoch === recoveryEpoch() && latest.current === key && generation.current === captured;
}

export function AccessRoleMatrix({ user }: { user: Pick<HubUser, 'id' | 'label'> }) {
  const { t } = useI18n();
  const [directory, setDirectory] = useState<AccessDirectory>();
  const [error, setError] = useState(''), [generation, setGeneration] = useState(0);
  const current = useCurrent(user.id);
  useEffect(() => {
    let active = true;
    setDirectory(undefined); setError('');
    void api.accessDirectory().then(value => { if (active && current()) setDirectory(value); })
      .catch(() => { if (active && current()) setError('Permissions unavailable. Refresh roles to retry.'); });
    return () => { active = false; };
  }, [user.id, generation]);
  return <section aria-label={t("Permission matrix")} className="space-y-3">
    <div className="flex items-center justify-between gap-2"><h4 className="font-bold">{t("Roles & environments")}</h4><Button size="sm" variant="ghost" onClick={() => setGeneration(value => value + 1)}>{t("Refresh roles")}</Button></div>
    {error ? <p role="alert" className="text-sm text-red-700">{translate(error)}</p> : !directory ? <p role="status" className="text-sm text-slate-500">{t("Loading permissions…")}</p> : <>
      {directory.administrator ? <HubRole key={`${user.id}:${generation}`} user={user} onSaved={() => setGeneration(value => value + 1)} /> : null}
      <div className="grid gap-3">{directory.connections.map(connection => <ConnectorRow key={`${connection.ownerUserId}:${connection.id}:${connection.nodeVersion}:${user.id}:${generation}`} connection={connection} user={user} reload={() => setGeneration(value => value + 1)} />)}</div>
      {!directory.connections.length ? <p className="text-sm text-slate-500">{t("No Connectors you can manage.")}</p> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-500"><span className="flex items-center gap-1"><ShieldCheck size={14} /> {t("Admin: all sessions, read only")}</span><span className="flex items-center gap-1"><Code2 size={14} /> {t("Developer: own sessions")}</span><span className="flex items-center gap-1"><Eye size={14} /> {t("Observer: shared sessions only")}</span></div>
      <details className="text-xs text-slate-500"><summary className="cursor-pointer">{t("Access boundaries")}</summary><p className="mt-2">{t("Session permissions are set inside each session. Hub admins and Connector owners retain inherited access. Runtime files and credentials are shared, not sandboxed. Each Connector exposes one environment per supported runtime; use separate Connectors for separate environments of the same type.")}</p></details>
    </>}
  </section>;
}

function HubRole({ user, onSaved }: { user: Pick<HubUser, 'id' | 'label'>; onSaved: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<HubRoleState>();
  const [role, setRole] = useState<HubRoleState['role']>('member'), [self, setSelf] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [bootstrap, setBootstrap] = useState(false);
  const current = useCurrent(user.id), pending = useRef(false);
  useEffect(() => { void Promise.all([api.hubRole(user.id), api.hubMe()]).then(([value, principal]) => {
    if (current()) { setSaved(value); setRole(value.role); setSelf(principal.userId === user.id); setBootstrap(principal.userId === user.id && principal.admin && value.role === 'member'); }
  }).catch(() => { if (current()) setError('Hub role unavailable.'); }); }, [user.id]);
  async function save() {
    if (!saved || pending.current || self || !current()) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (!await confirmAction({ title: t('Change Hub role?'), description: t(role === 'admin'
        ? 'Grant global administration and read access to all sessions for {user}?' : 'Remove Hub administrator privileges for {user}?', { user: user.label }), confirmLabel: t('Save Hub role') }) || !current()) return;
      const value = await api.saveHubRole(user.id, { role, version: saved.version }); if (current()) { setSaved(value); onSaved(); }
    }
    catch { if (current()) { setSaved(undefined); setError('Result unconfirmed. Refresh roles before retrying.'); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  return <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3">
    <ShieldCheck size={18} className="text-indigo-600" /><span className="flex-1 text-sm font-semibold">{t("Hub role")}{bootstrap ? <small className="block font-normal">{t("Bootstrap admin login · personal keys remain members")}</small> : null}</span>
    <select name="accessrolematrix-select-1" aria-label={t("Hub role")} className={selectStyle} disabled={!saved || busy || self} value={role} onChange={event => setRole(event.currentTarget.value as typeof role)}><option value="member">{t("Member")}</option><option value="admin">{t("Hub administrator")}</option></select>
    {!self ? <Button size="sm" disabled={!saved || busy || saved.role === role} onClick={() => void save()}>{t("Save Hub role")}</Button> : <span className="text-xs text-slate-500">{t("Self changes locked")}</span>}
    {error ? <p role="alert" className="w-full text-xs text-red-700">{translate(error)}</p> : null}
  </div>;
}

function ConnectorRow({ connection, user, reload }: { connection: AccessConnection; user: Pick<HubUser, 'id' | 'label'>; reload: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<ConnectorMembership>(), [role, setRole] = useState<ConnectorRole>('none');
  const [environments, setEnvironments] = useState<ConnectorMembership['environments']>({ codex: 'disabled', openclaw: 'disabled' });
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const current = useCurrent(JSON.stringify([connection.ownerUserId, connection.id, connection.nodeVersion, user.id])), pending = useRef(false);
  useEffect(() => { setSaved(undefined); setNotice(''); void api.connectorMembership(connection, user.id).then(value => {
    if (current()) { setSaved(value); setRole(value.role); setEnvironments(value.environments); }
  }).catch(() => { if (current()) setNotice('Access unavailable. Refresh roles.'); }); }, [connection.id, connection.ownerUserId, connection.nodeVersion, user.id]);
  const locked = !saved?.editable || !saved.grantSetDigest || !connection.verified || busy;
  // These are form defaults, not authorization rules; the server enforces ceilings.
  function changeRole(next: ConnectorRole) {
    setRole(next); setNotice('');
    setEnvironments(next === 'none' ? { codex: 'disabled', openclaw: 'disabled' } : next === 'admin' ? { codex: 'developer', openclaw: 'observer' }
      : next === 'developer' ? { codex: 'developer', openclaw: 'disabled' } : { codex: 'observer', openclaw: 'disabled' });
  }
  async function save() {
    if (!saved?.grantSetDigest || locked || pending.current || !current()) return;
    // Legacy conversion can remove broad access; keep consent explicit even when
    // simplifying the UI. An unknown save result must be reconciled, not retried blindly.
    const warning = saved.legacyCount ? t('Convert {count} legacy authorization(s) to {role}? Broad access will be removed. Compatible creator access is preserved.', { count: saved.legacyCount, role: translate(labels[role]) })
      : t('Save {role} access for {user}? Disabled or reduced access revokes affected session permissions.', { role: translate(labels[role]), user: user.label });
    pending.current = true; setBusy(true); setNotice('');
    try {
      if (!await confirmAction({ title: t('Change environment access?'), description: warning, confirmLabel: t('Save access') }) || !current()) return;
      const value = await api.saveConnectorMembership(connection, user.id, { role, environments, version: saved.version, nodeVersion: connection.nodeVersion, migrateLegacy: saved.legacyCount > 0, grantSetDigest: saved.grantSetDigest });
      if (current()) { setSaved(value); setRole(value.role); setEnvironments(value.environments); setNotice('Saved'); }
    } catch { if (current()) { setSaved(undefined); setNotice('Result unconfirmed. Refresh roles before retrying.'); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function enableCreation() {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true);
    try {
      if (!await confirmAction({ title: t('Enable member creation'), description: t('Enable member creation on this Connector? Existing authorizations may need review.'), confirmLabel: t('Enable member creation') }) || !current()) return;
      await api.hubSetupLocalExecution(connection.id, connection.nodeVersion, true); if (current()) reload();
    }
    catch { if (current()) { setSaved(undefined); setNotice('Setup unconfirmed. Refresh roles; do not resend.'); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  return <article aria-label={t('{environment} permissions', { environment: connection.label })} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3">
    <div className="flex flex-wrap items-center gap-3"><Server size={18} className="text-slate-500" /><div className="min-w-24 flex-1"><p className="text-sm font-semibold">{connection.label}</p><p className="text-xs text-slate-500">{saved?.inherited === 'owner' ? t('Owner · inherited') : saved?.inherited === 'hub-admin' ? t('Hub admin · global read inherited') : saved?.legacyCount ? saved.legacyBroad ? t('Legacy access · includes all sessions') : t('Legacy access · {count} grants', { count: saved.legacyCount }) : saved?.version ? t('Managed role') : t('Not configured')}</p></div>
      <select name="accessrolematrix-select-2" aria-label={t('{environment} role', { environment: connection.label })} className={selectStyle} disabled={locked} value={role} onChange={event => changeRole(event.currentTarget.value as ConnectorRole)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={value === 'admin' && !connection.appointAdministrators}>{translate(label)}</option>)}</select>
      <Button size="sm" variant="secondary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("Environments")}</Button><Button size="sm" disabled={locked} onClick={() => void save()}>{t("Save access")}</Button>
    </div>
    {expanded ? <div className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-2">
      <label className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-2 text-sm"><span>Codex</span><select name="accessrolematrix-select-3" aria-label={t('{environment} Codex access', { environment: connection.label })} className={selectStyle} disabled={locked || role === 'none'} value={environments.codex} onChange={event => setEnvironments({ ...environments, codex: event.currentTarget.value as typeof environments.codex })}>
        <option value="disabled" disabled={role === 'admin'}>{t("Disabled")}</option><option value="observer">{t(role === 'admin' ? 'All sessions · read' : 'Shared only · read')}</option><option value="developer" disabled={role === 'observer'}>{t(role === 'admin' ? 'All read + own create' : 'Own create & chat')}</option>
      </select></label>
      <label className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-2 text-sm"><span>OpenClaw</span><select name="accessrolematrix-select-4" aria-label={t('{environment} OpenClaw access', { environment: connection.label })} className={selectStyle} disabled={locked || role === 'none' || role === 'admin'} value={environments.openclaw} onChange={event => setEnvironments({ ...environments, openclaw: event.currentTarget.value as 'disabled' | 'observer' })}><option value="disabled">{t("Disabled")}</option><option value="observer">{t(role === 'admin' ? 'All sessions · read' : 'Shared only · read')}</option></select></label>
      {['GHCP', 'ClaudeCode', 'Hermes'].map(provider => <div key={provider} className="flex items-center justify-between rounded-xl bg-slate-50 p-2 text-sm text-slate-400"><span>{provider}</span><span className="flex items-center gap-1 text-xs"><LockKeyhole size={12} /> {t(provider === 'Hermes' ? 'Opt-in · owner only' : 'Not integrated')}</span></div>)}
      <p className="text-xs text-slate-500 sm:col-span-2">{t("Permission does not enable a runtime. OpenClaw execution remains on hold.")}</p>
    </div> : null}
    {environments.codex === 'developer' && !connection.creationReady ? <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-amber-800"><span>{t("Member creation not enabled.")}</span>{connection.owner ? <Button size="sm" variant="secondary" disabled={busy || !saved} onClick={() => void enableCreation()}>{t("Enable member creation")}</Button> : <span>{t("Ask the Connector owner to enable it.")}</span>}</div> : null}
    {!connection.verified ? <p className="mt-2 text-xs text-amber-800">{t("Connector disabled or unverified.")}</p> : null}
    {notice ? <p role="status" className={`mt-2 text-xs ${notice === 'Saved' ? 'text-emerald-700' : 'text-amber-800'}`}>{translate(notice)}</p> : null}
  </article>;
}

export function ConnectorMemberManager() {
  const { t } = useI18n();
  const [directory, setDirectory] = useState<AccessDirectory>(), [selected, setSelected] = useState(''), [memberId, setMemberId] = useState('');
  const [error, setError] = useState(false), [generation, setGeneration] = useState(0);
  const current = useCurrent();
  useEffect(() => { setError(false); void api.accessDirectory().then(value => { if (current()) setDirectory(value); }).catch(() => { if (current()) setError(true); }); }, [generation]);
  if (error) return <section className="p-4 text-sm" role="alert">{t("Connector permissions unavailable.")} <Button size="sm" variant="secondary" onClick={() => setGeneration(value => value + 1)}>{t("Retry permissions")}</Button></section>;
  if (!directory?.connections.length) return null;
  const user = directory.users.find(value => value.id === selected) ?? { id: selected, label: selected };
  return <section aria-label={t("Connector member management")} className="space-y-3 p-4"><h3 className="font-bold">{t("Connector members")}</h3>
    <div className="flex flex-wrap gap-2"><select name="accessrolematrix-select-5" aria-label={t("Manage Connector member")} className={selectStyle} value={selected} onChange={event => setSelected(event.currentTarget.value)}><option value="">{t("Select a member")}</option>{directory.users.map(member => <option key={member.id} value={member.id}>{member.label}</option>)}</select>
      <input name="accessrolematrix-input-6" aria-label={t("Existing Hub member ID")} placeholder={t("Add by Hub member ID")} className={selectStyle} value={memberId} onChange={event => setMemberId(event.currentTarget.value)} /><Button size="sm" disabled={!memberId.trim()} onClick={() => setSelected(memberId.trim())}>{t("Add existing member")}</Button></div>
    {selected ? <AccessRoleMatrix key={selected} user={user} /> : null}
  </section>;
}
