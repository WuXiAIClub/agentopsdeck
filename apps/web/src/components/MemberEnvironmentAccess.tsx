import { translate, useI18n } from '../lib/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, recoveryScope, type HubNodeGrantPage, type HubUser } from '../api';
import { environmentRoles, loadEnvironmentAccess, memberAccess, saveEnvironmentRole, type EnvironmentRole } from '../lib/member-environment-access';
import { Button } from './ui/button';
import { confirmAction } from './ui/confirm';

export function MemberEnvironmentAccess({ user, connectionId, isOwner, customEditor }: { user: HubUser; connectionId: string; isOwner: boolean; customEditor: ReactNode }) {
  return <MemberEnvironmentAccessPanel key={JSON.stringify([recoveryScope(), user.id, connectionId])} user={user} connectionId={connectionId} isOwner={isOwner} customEditor={customEditor} />;
}

function MemberEnvironmentAccessPanel({ user, connectionId, isOwner, customEditor }: { user: HubUser; connectionId: string; isOwner: boolean; customEditor: ReactNode }) {
  const { t } = useI18n();
  const scope = recoveryScope(), active = useRef(false), pending = useRef(false);
  const current = () => active.current && scope === recoveryScope();
  const [page, setPage] = useState<HubNodeGrantPage>();
  const [editing, setEditing] = useState(false), [custom, setCustom] = useState(false);
  const [role, setRole] = useState<EnvironmentRole>('developer');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setPage(undefined); setError(''); setEditing(false);
    try {
      const next = await loadEnvironmentAccess(api, connectionId, current);
      if (current()) setPage(next);
    } catch { if (current()) setError('Access could not be checked. Retry before changing permissions.'); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, []);
  async function save(nextRole: EnvironmentRole | null) {
    if (!page || isOwner || pending.current || !current()) return;
    const access = memberAccess(page, user.id);
    const change = nextRole ? t('Set {user} to {role}? {description}', { user: user.label, role: translate(environmentRoles[nextRole].label), description: translate(environmentRoles[nextRole].description) }) : t('Remove the environment role for {user}?', { user: user.label });
    pending.current = true; setBusy(true); setError(''); setNotice('');
    let attempted = false;
    try {
      if (!await confirmAction({ title: t('Change environment access?'), description: [change,
        ...(access.grant ? [t('This replaces or removes the existing authorization and revokes session access and shares derived from it; they are not automatically restored.')] : []),
        t('Independent session shares may still allow access. Running tasks are not stopped.')].join('\n\n'), confirmLabel: t(nextRole ? 'Save role' : 'Remove access') }) || !current()) return;
      attempted = true;
      await saveEnvironmentRole(api, connectionId, user.id, page, nextRole, current);
      if (current()) { setEditing(false); setNotice(nextRole ? 'Role saved. Current access is shown below.' : 'Environment role removed. Independent session access may remain.'); }
    } catch {
      if (current()) setError('Save not confirmed. Nothing was retried. Check current access before saving again.');
    } finally {
      if (attempted && current()) {
        setPage(undefined);
        try { const latest = await loadEnvironmentAccess(api, connectionId, current); if (current()) setPage(latest); }
        catch { if (current()) setError('Result or refreshed access unavailable. Retry the access check; do not repeat the save blindly.'); }
      }
      pending.current = false; if (current()) setBusy(false);
    }
  }
  if (custom) return <div className="space-y-3">
    <Button size="sm" variant="secondary" onClick={() => { setCustom(false); void refresh(); }}>{t("Back to role overview")}</Button>
    <p className="text-xs text-slate-600">{t("Custom authorizations add together. For ordinary member access, use an environment role. Share individual sessions from the session’s Share session menu.")}</p>
    {customEditor}
  </div>;
  const access = page && memberAccess(page, user.id);
  return <div className="space-y-3" aria-label={t("Environment role")}>
    {error ? <p role="alert" className="text-sm text-red-700">{translate(error)}</p> : null}
    {notice ? <p role="status" className="text-sm text-emerald-800">{translate(notice)}</p> : null}
    {!page || !access ? <>{busy ? <p role="status" className="text-sm">{t("Checking current access…")}</p> : <Button size="sm" onClick={() => void refresh()}>{t("Retry access check")}</Button>}</> : <>
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-slate-50 p-3">
        <div className="min-w-0 flex-1"><p className="text-xs text-slate-500">{t("Current access")}</p><h5 className="mt-1 font-bold">{isOwner ? t('Environment owner') : translate(access.label)}</h5>
          {isOwner ? <p className="mt-1 text-sm text-slate-600">{t("Owns this environment. Member roles cannot remove ownership or the owner’s access.")}</p> : access.role && !access.stale && page.verified ? <p className="mt-1 text-sm text-slate-600">{translate(environmentRoles[access.role].description)}</p> : null}
          {access.stale ? <p className="mt-1 text-sm text-amber-800">{t("Environment permissions changed. Review saved authorizations before restoring access.")}</p> : null}
          {access.broad ? <p className="mt-1 text-xs font-semibold text-amber-800">{t("Includes other members’ conversations.")}</p> : null}
          {access.derived.length ? <p className="mt-1 text-xs text-slate-600">{t('Also has {count} created or shared session authorization(s).', { count: access.derived.length })}</p> : null}
          {!access.editable ? <p className="mt-1 text-sm text-slate-600">{t("Multiple or scoped authorizations. Review individually; selecting a role cannot safely replace them all.")}</p> : null}
          {!page.verified ? <p className="mt-1 text-sm text-amber-800">{t("Check this connection in Environments before changing access.")}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {!isOwner && access.editable ? <Button size="sm" variant="secondary" disabled={busy || !page.verified} onClick={() => { setRole(access.role ?? 'developer'); setEditing(true); setNotice(''); }}>{t(access.direct.length ? 'Change role' : 'Add access')}</Button> : null}
          {!isOwner && access.grant && access.editable ? <Button size="sm" variant="secondary" disabled={busy || !page.verified} onClick={() => void save(null)}>{t("Remove access")}</Button> : null}
        </div>
      </div>
      {editing ? <form className="space-y-3 rounded-xl border border-blue-200 p-3" onSubmit={event => { event.preventDefault(); void save(role); }}>
        <label className="block text-sm font-semibold">{t("Role")} <select name="memberenvironmentaccess-select-1" aria-label={t("Environment role")} className="mt-1 w-full rounded-xl border bg-white p-2" disabled={busy} value={role} onChange={event => setRole(event.target.value as EnvironmentRole)}>
            {(Object.keys(environmentRoles) as EnvironmentRole[]).map(value => <option key={value} value={value}>{translate(environmentRoles[value].label)}</option>)}
          </select>
        </label>
        <p className="text-sm text-slate-600">{translate(environmentRoles[role].description)}</p>
        {access.grant && (access.role !== role || access.stale) ? <p className="text-xs text-amber-800">{t("Replaces the saved authorization. Existing sessions and shares derived from it lose access; they are not restored by changing back.")}</p> : null}
        {role !== 'observer' && (!page.creationConfigured || !page.executionConfigured) ? <p className="text-sm text-amber-800">{t("Enable member session creation in Environments → Member execution first.")} <a href="#/tab/gateway" className="underline">{t("Environments → Member execution")}</a></p> : null}
        <div className="flex gap-2"><Button size="sm" disabled={busy || (role !== 'observer' && (!page.creationConfigured || !page.executionConfigured))}>{t(busy ? 'Saving…' : 'Save role')}</Button><Button size="sm" type="button" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>{t("Cancel")}</Button></div>
      </form> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <button type="button" disabled={busy} className="py-2 text-slate-500 underline" onClick={() => { setCustom(true); setNotice(''); }}>{t("Custom authorizations")}</button>
        <details><summary className="cursor-pointer py-2 text-slate-500">{t("Access boundaries")}</summary><p className="mt-1 max-w-md text-slate-600">{t("The environment owner retains access. Codex files and credentials are shared; roles do not provide filesystem isolation. Independent authorizations add together.")}</p></details>
      </div>
      {error ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>{t("Retry access check")}</Button> : null}
    </>}
  </div>;
}
