import { translate, useI18n } from '../lib/i18n';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ChevronDown, ChevronUp, LockKeyhole, RefreshCcw, Share2, UserRoundPlus } from 'lucide-react';
import { api, recoveryEpoch, recoveryScope, type HubNodeGrant } from '../api';
import { SessionRevocationJournal, type RevocationReference, type SessionRevocation } from '../lib/session-revocation';
import { Button } from './ui/button';
import { confirmAction } from './ui/confirm';
import { AnchoredPanel } from './AnchoredPanel';

export function SessionSharing({ sessionKey, placement = 'inline' }: { sessionKey: string; placement?: 'inline' | 'toolbar' }) {
  return <SessionSharingPanel key={JSON.stringify([recoveryScope(), recoveryEpoch(), sessionKey])} sessionKey={sessionKey} placement={placement} />;
}

function SessionSharingPanel({ sessionKey, placement }: { sessionKey: string; placement: 'inline' | 'toolbar' }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<HubNodeGrant[]>();
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string; canChat: boolean }>>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'observer' | 'collaborator'>('observer');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revocations, setRevocations] = useState<Array<{ reference: RevocationReference; status?: SessionRevocation }>>([]);
  const readController = useRef<AbortController | undefined>(undefined);
  const lifetime = useRef(false), pending = useRef(false);
  const [account] = useState(() => ({ scope: recoveryScope(), epoch: recoveryEpoch() }));
  const accountCurrent = () => account.scope === recoveryScope() && account.epoch === recoveryEpoch();
  const current = () => lifetime.current && accountCurrent();
  const journal = () => new SessionRevocationJournal(window.sessionStorage);
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; readController.current?.abort(); }; }, []);
  async function refresh(clearNotice = true) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); if (clearNotice) setNotice(''); setRows(undefined);
    try {
      if (!account.scope) throw new Error('Authenticated account required');
      const references = journal().list(account.scope, sessionKey);
      setRevocations(previous => {
        const matches = (a: RevocationReference, b: RevocationReference) => a.grantId === b.grantId && a.version === b.version;
        const unresolved = references.map(reference => {
          const status = previous.find(row => matches(row.reference, reference))?.status;
          return { reference, ...(status ? { status } : {}) };
        });
        const confirmed = previous.filter(row => row.status?.state === 'confirmed'
          && !references.some(reference => matches(row.reference, reference)));
        const remaining = Math.max(0, 32 - unresolved.length);
        return [...unresolved, ...(remaining ? confirmed.slice(-remaining) : [])];
      });
      const result = await api.sessionCollaborators(sessionKey);
      if (current()) { setRows(result.collaborators); setCandidates(result.candidates ?? []); }
    } catch { if (current()) setNotice('Sharing list unavailable. Refresh before making changes.'); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function mutate(operation: () => Promise<unknown>, description?: string, confirmLabel = t('Save'), successNotice = 'Access saved.') {
    if (pending.current || !rows || !current()) return;
    pending.current = true; setBusy(true);
    let attempted = false;
    try {
      if (description && !await confirmAction({ title: t('Change session access?'), description, confirmLabel })) return;
      if (!current()) return;
      attempted = true; setNotice(''); setRows(undefined);
      await operation();
      if (current()) { setNotice(successNotice); setUserId(''); }
    } catch { if (current()) setNotice('Result not confirmed. Refresh sharing before trying again; nothing was resent.'); }
    finally { pending.current = false; if (current()) { setBusy(false); if (attempted) await refresh(false); } }
  }
  async function revoke(grant: HubNodeGrant) {
    await mutate(async () => {
      if (!account.scope || !current()) throw new Error('Authenticated account required');
      const reference = { scope: account.scope, sessionKey, grantId: grant.id, version: grant.version, userId: grant.userId };
      journal().remember(reference); // If persistence fails, no DELETE is sent.
      setRevocations(previous => [...previous, { reference }]);
      const status = await api.revokeSessionCollaborator(sessionKey, grant);
      if (!current()) return;
      if (status.state === 'confirmed') journal().forget(reference);
      setRevocations(previous => previous.map(row => row.reference.grantId === grant.id && row.reference.version === grant.version ? { reference, status } : row));
    }, t('Remove this session access? Other independent permissions may remain. Running tasks are not automatically stopped.'),
    t('Remove access'), 'This grant is revoked locally. Remote confirmation is shown separately; other access may remain.');
  }
  async function checkRevocation(reference: RevocationReference) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setNotice('');
    const controller = new AbortController(); readController.current = controller;
    try {
      const status = await api.sessionCollaboratorRevocation(sessionKey, { id: reference.grantId, version: reference.version }, controller.signal);
      if (!current()) return;
      if (status.state === 'confirmed') journal().forget(reference);
      setRevocations(previous => previous.map(row => row.reference.grantId === reference.grantId && row.reference.version === reference.version ? { reference, status } : row));
    } catch { if (current()) setNotice('Original revocation could not be confirmed. Its reference is kept; no access change was resent.'); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  const toolbar = placement === 'toolbar';
  if (!accountCurrent()) return null;
  return <section data-caption-priority={35} className={toolbar ? 'relative shrink-0' : open ? 'border-t border-slate-200/80 bg-slate-50/95 px-3 py-3' : 'border-t border-slate-200/70 bg-white/70 px-3 py-1.5'} aria-label={t("Session sharing")}>
    <div className={toolbar ? '' : 'mx-auto max-w-5xl'}>
      <button ref={anchor} type="button" aria-label={t('Share session')} title={t('Share session')} className={toolbar
        ? open
          ? 'desktop-chat-toolbar-control flex h-8 items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-2.5 text-xs font-semibold text-blue-700'
          : 'desktop-chat-toolbar-control flex h-8 items-center gap-1.5 rounded-xl border border-slate-200/80 bg-white/75 px-2.5 text-xs font-semibold text-slate-700 shadow-sm shadow-slate-200/30 transition hover:bg-slate-100'
        : open
          ? 'flex w-full items-center gap-2 rounded-xl px-1 py-1 text-left text-sm font-semibold text-slate-800'
          : 'mx-auto flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800'}
        aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh(); }}>
        <Share2 size={open ? 16 : 13} />
        <span className={toolbar ? '' : 'flex-1'}>{t(toolbar ? 'Share' : 'Share session')}</span>
        {!toolbar ? open ? <ChevronUp size={15} className="text-slate-400" /> : <ChevronDown size={13} /> : null}
      </button>
    <SharingSurface toolbar={toolbar} open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('Session sharing')}>
      <div>
        <p className="font-medium text-slate-700">{t("Invite someone to this session")}</p>
        <p className="mt-0.5 text-slate-500">{t("Their environment role still sets the maximum access.")}</p>
      </div>
      <div className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-slate-500"><LockKeyhole className="mt-0.5 shrink-0" size={14} /><p>{t("Hub and Connector admins inherit read access. Owners and legacy grants may retain additional access.")}</p></div>
      <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        {candidates.length ? <label className="min-w-0 font-medium text-slate-600">{t("Member")}<select name="sessionsharing-select-1" aria-label={t("Share with member")} className="mt-1 block h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" value={userId} onChange={event => { setUserId(event.currentTarget.value); setRole('observer'); }}><option value="">{t("Select a member")}</option>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label> : null}
        <details className="min-w-0 sm:col-span-3"><summary className="w-fit cursor-pointer text-slate-500 hover:text-slate-800">{t("Use member ID instead")}</summary>
        <label className="mt-2 block min-w-0 font-medium text-slate-600">{t("Member ID")}<input name="sessionsharing-input-2" aria-label={t("Share with member ID")} className="mt-1 block h-10 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" value={userId} onChange={event => setUserId(event.currentTarget.value)} placeholder={t("Ask the member for their Hub user ID")} /></label>
        </details>
        <label className="font-medium text-slate-600">{t("Access")}<select name="sessionsharing-select-3" aria-label={t("Session sharing role")} className="mt-1 block h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" value={role} onChange={event => setRole(event.currentTarget.value as typeof role)}><option value="observer">{t("View only")}</option><option value="collaborator" disabled={candidates.some(candidate => candidate.id === userId && !candidate.canChat)}>{t("Can view & chat")}</option></select></label>
        <Button className="h-10 rounded-xl shadow-none" size="sm" disabled={busy || !rows || !userId.trim()} onClick={() => {
          void mutate(() => api.shareSession(sessionKey, userId.trim(), role),
            t('Share only this session with {user} as {role}?', { user: userId.trim(), role: t(role === 'observer' ? 'Observer' : 'Collaborator') }), t('Share'));
        }}><UserRoundPlus size={15} />{t("Share")}</Button>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <p className="font-medium text-slate-600">{t("People with access")}</p>
        <Button className="h-7 rounded-lg px-2 text-xs shadow-none" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}><RefreshCcw className={busy ? 'animate-spin' : ''} size={13} />{t("Refresh")}</Button>
      </div>
      {notice ? <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-slate-600" role="status">{translate(notice)}</p> : null}
      {rows?.length === 0 ? <p className="py-2 text-center text-slate-400">{t("Only inherited access. No one has been invited directly.")}</p> : null}
      <ul className="space-y-2">{rows?.map(grant => <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-2 [overflow-wrap:anywhere]" key={grant.id}>
        <span>{candidates.find(candidate => candidate.id === grant.userId)?.label ?? grant.userId} · {t(grant.policy.actions.includes('messages:send') ? 'Collaborator' : 'Observer')}</span>
        <SessionPermissionEditor key={`${grant.id}:${grant.version}`} grant={grant} disabled={busy || revocations.some(row => row.reference.grantId === grant.id && row.status?.state !== 'confirmed')} canChat={candidates.find(candidate => candidate.id === grant.userId)?.canChat !== false} save={permissions => mutate(() => api.updateSessionCollaborator(sessionKey, grant, permissions))} />
        <Button size="sm" variant="secondary" disabled={busy || revocations.some(row => row.reference.grantId === grant.id && row.status?.state !== 'confirmed')} onClick={() => void revoke(grant)}>{t("Remove access")}</Button>
      </li>)}</ul>
      {revocations.length ? <div className="space-y-2 border-t border-slate-100 pt-3" aria-label={t('Revocation confirmation')}>
        <p className="font-medium text-slate-600">{t('Revocation confirmation')}</p>
        <p className="text-slate-500">{t('Checks read only the original grant version. No operation is resent. Confirmation does not stop already running tools or remove independent grants.')}</p>
        <ul className="space-y-2">{revocations.map(({ reference, status }) => <li key={`${reference.grantId}:${reference.version}`} className="rounded-lg border border-slate-200 p-2">
          <p>{reference.userId}</p>
          <p role="status">{status ? status.state === 'pending'
            ? t('Revoked locally; waiting for {pending} remote leases. Confirmed: {confirmed}.', status)
            : status.confirmed === 0 ? t('Revoked locally; no matching remote execution leases.')
              : t('Remote revocation confirmed for {confirmed} leases.', status)
            : t('Original revocation outcome unknown. Check its result; do not resend.')}</p>
          {status?.state !== 'confirmed' ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void checkRevocation(reference)}>{t('Check original revocation')}</Button> : null}
        </li>)}</ul>
      </div> : null}
    </SharingSurface>
    </div>
  </section>;
}

function SharingSurface({ toolbar, ...props }: ComponentProps<typeof AnchoredPanel> & { toolbar: boolean }) {
  return toolbar ? <AnchoredPanel {...props}><div className="space-y-3">{props.children}</div></AnchoredPanel>
    : props.open ? <div className="mt-2 space-y-3 rounded-2xl border border-slate-200 bg-white p-3 text-xs shadow-sm sm:p-4">{props.children}</div> : null;
}

function SessionPermissionEditor({ grant, disabled, canChat, save }: { grant: HubNodeGrant; disabled: boolean; canChat: boolean; save: (permissions: { role: 'observer' | 'collaborator'; live: boolean; queue: boolean; media: boolean }) => Promise<void> }) {
  const { t } = useI18n();
  const [chat, setChat] = useState(grant.policy.actions.includes('messages:send'));
  const [live, setLive] = useState(grant.policy.actions.includes('events:read'));
  const [queue, setQueue] = useState(grant.policy.actions.includes('queue:manage'));
  const [media, setMedia] = useState(grant.policy.actions.includes('media:read'));
  return <details className="rounded-lg border p-2"><summary className="cursor-pointer">{t("Session permissions")}</summary><div className="mt-2 flex flex-wrap gap-3">
    <span>{t("✓ Read")}</span><label><input name="sessionsharing-input-4" type="checkbox" checked={chat} disabled={disabled || !canChat} onChange={event => { setChat(event.currentTarget.checked); if (!event.currentTarget.checked) setQueue(false); }} /> {t("Chat")}</label>
    <label><input name="sessionsharing-input-5" type="checkbox" checked={live} disabled={disabled} onChange={event => setLive(event.currentTarget.checked)} /> {t("Live replies")}</label>
    <label><input name="sessionsharing-input-6" type="checkbox" checked={media} disabled={disabled} onChange={event => setMedia(event.currentTarget.checked)} /> {t("Attachments")}</label>
    <label><input name="sessionsharing-input-7" type="checkbox" checked={queue} disabled={disabled || !chat} onChange={event => setQueue(event.currentTarget.checked)} /> {t("Own queue")}</label>
    <Button size="sm" disabled={disabled} onClick={() => void save({ role: chat ? 'collaborator' : 'observer', live, media, queue: chat && queue })}>{t("Save session permissions")}</Button>
  </div></details>;
}
