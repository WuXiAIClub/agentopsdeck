import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw, X } from 'lucide-react';
import type { BoardDocument } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { boardGrantState, type BoardGrant, type BoardAuditEvent } from '../lib/workspace-board-access';
import WorkspaceBoardBinding from './WorkspaceBoardBinding';
const WorkspaceBoardDelegation = lazy(() => import('./WorkspaceBoardDelegation'));
const WorkspaceTaskSession = lazy(() => import('./WorkspaceTaskSession'));

/** Mounted only while open. Tokens stay here, not in drafts, receipts or layouts. */
export default function WorkspaceBoardAccess({ scope, resourceId, initialSelectedTaskIds, initialSection, onClose }: {
  scope: string; resourceId: string; initialSelectedTaskIds?: string[] | undefined; initialSection?: 'create' | 'bind' | undefined; onClose: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(true), lock = useRef(false), loadSequence = useRef(0);
  const taskPicker = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<BoardDocument>(), [grants, setGrants] = useState<BoardGrant[]>();
  const [selected, setSelected] = useState<string[]>(() => initialSelectedTaskIds ?? []), [detail, setDetail] = useState(false), [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false), [error, setError] = useState<'load' | 'audit' | ''>('');
  const [unverified, setUnverified] = useState<'issue' | 'revoke' | ''>(''), [confirm, setConfirm] = useState<string>();
  const [secret, setSecret] = useState<{ id: string; token: string }>(), [copy, setCopy] = useState<'ok' | 'error' | ''>('');
  const [audit, setAudit] = useState<BoardAuditEvent[]>(), [more, setMore] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [bindingOpen, setBindingOpen] = useState(() => initialSection === 'bind');
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [creationOpen, setCreationOpen] = useState(() => initialSection === 'create');
  const valid = () => alive.current && scope === recoveryScope();
  const reload = async (signal?: AbortSignal, preserveInitial = false) => {
    if (lock.current || !valid()) return;
    const sequence = ++loadSequence.current;
    lock.current = true; setBusy(true);
    try {
      const [saved, result] = await Promise.all([api.workspaceBoard(resourceId, signal), api.boardGrants(resourceId, signal)]);
      if (!valid() || sequence !== loadSequence.current) return;
      const validIds = new Set(saved.tasks.map(task => task.id));
      setBoard(saved); setGrants(result.capabilities);
      setSelected(current => preserveInitial ? current.filter(id => validIds.has(id)) : []);
      setUnverified(''); setError(''); setConfirm(undefined); setNow(Date.now());
      setSecret(current => current && result.capabilities.some(grant => grant.id === current.id && boardGrantState(grant) === 'active') ? current : undefined);
    } catch { if (valid() && sequence === loadSequence.current && !signal?.aborted) setError('load'); }
    finally { if (sequence === loadSequence.current) { lock.current = false; if (valid()) setBusy(false); } }
  };
  useEffect(() => {
    alive.current = true; dialog.current?.showModal();
    const abort = new AbortController(); void reload(abort.signal, true);
    const closeForAuth = () => { setSecret(undefined); onClose(); };
    window.addEventListener('agentopsdeck:auth-required', closeForAuth);
    return () => { alive.current = false; loadSequence.current++; lock.current = false; abort.abort(); window.removeEventListener('agentopsdeck:auth-required', closeForAuth); };
  }, []);
  // One local expiry wake-up, not a network poll. Browser throttling is also
  // accounted for by recomputing against Date.now() on every action/render.
  useEffect(() => {
    const next = grants?.filter(grant => grant.revokedAt === null && grant.expiresAt > now).reduce((at, grant) => Math.min(at, grant.expiresAt), Infinity);
    if (!next || !Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [grants, now]);
  const issue = async () => {
    if (lock.current || !valid() || !selected.length || unverified || !board) return;
    lock.current = true; setBusy(true); setError(''); setSecret(undefined); setCopy('');
    try {
      const result = await api.issueBoardGrant(resourceId, { taskIds: selected, fields: detail ? ['status', 'detail'] : ['status'], expiresAt: Date.now() + minutes * 60_000 });
      if (!valid()) return;
      setGrants(current => [result.capability, ...(current ?? [])]); setSecret({ id: result.capability.id, token: result.token }); setSelected([]);
    } catch { if (valid()) setUnverified('issue'); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (lock.current || !valid()) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await api.revokeBoardGrant(resourceId, id);
      if (!result.revoked) throw new Error('Unconfirmed');
      // Verify authoritative metadata before displaying revoked.
      const latest = await api.boardGrants(resourceId);
      if (!valid()) return;
      setGrants(latest.capabilities); setConfirm(undefined);
      if (secret?.id === id) setSecret(undefined);
    } catch { if (valid()) setUnverified('revoke'); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const readAudit = async (older = false) => {
    if (lock.current || !valid()) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await api.boardAudit(resourceId, older ? audit?.at(-1)?.sequence : undefined);
      if (!valid()) return;
      setAudit(current => older ? [...(current ?? []), ...result.events] : result.events); setMore(result.events.length === 100);
    } catch { if (valid()) setError('audit'); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const copyToken = async () => {
    if (!secret || !valid() || unverified || !grants?.some(grant => grant.id === secret.id && boardGrantState(grant) === 'active')) return;
    try { await navigator.clipboard.writeText(secret.token); if (valid()) setCopy('ok'); }
    catch { if (valid()) setCopy('error'); }
  };
  const stateLabel = { active: t('Active grant'), expired: t('Expired grant'), revoked: t('Revoked grant') };
  const eventLabel: Record<string, string> = { issued: t('Grant issued'), revoked: t('Grant revoked'), updated: t('Task updated'), denied: t('Update denied'), conflict: t('Revision conflict'), 'mutation-reused': t('Mutation reused'), limit: t('Grant limit reached') };
  return <dialog ref={dialog} className="workspace-board-access" aria-label={t('Agent authorization')} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><h2>{t('Agent authorization')}</h2><button type="button" aria-label={t('Close')} onClick={onClose}><X size={17} /></button></header>
    <p className="workspace-access-note">{t('Only selected saved tasks are accessible. Titles are readable; selected fields are readable and writable. No task creation, deletion, renaming or access to other resources.')}</p>
    <p className="workspace-access-warning">{t('Revoking a login Key does not revoke these grants. Revoke each grant or wait for expiry. Revocation does not stop the Agent itself.')}</p>
    <div className="workspace-access-toolbar"><strong>{board?.title}</strong><button type="button" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />{t('Refresh grants')}</button></div>
    {unverified && <p role="alert">{t(unverified === 'issue' ? 'Grant outcome unconfirmed. Do not issue again yet. Refresh grants and revoke any unwanted grant; the token cannot be recovered.' : 'Revocation unconfirmed. Refresh grants to verify before taking further action.')}</p>}
    {error && <p role="alert">{t(error === 'audit' ? 'Unable to load audit. Retry when ready.' : 'Unable to load grants. Refresh to verify the current state.')}</p>}
    {busy && <p role="status">{t('Working…')}</p>}
    {secret && <section className="workspace-access-secret" aria-label={t('Once-only credential')}>
      <strong>{t('Once-only credential')}</strong><code>{secret.id}</code>
      <p>{t('Copy only to a trusted private credential store. Closing this panel clears this token. Never place it in chat, Git, URLs or logs. Anyone holding it can use this grant.')}</p>
      <button type="button" disabled={!!unverified || !grants?.some(grant => grant.id === secret.id && boardGrantState(grant, Math.max(now, Date.now())) === 'active')} onClick={() => void copyToken()}><Copy size={14} />{t('Copy grant token')}</button>
      <span role="status">{copy === 'ok' ? t('Copied') : copy === 'error' ? t('Clipboard unavailable. Keep this panel open and allow clipboard access, or revoke this grant.') : ''}</span>
      <p><code>GET / POST /api/workspace-agent/v1/board</code><br /><code>Authorization: Bearer &lt;token&gt;</code></p>
    </section>}
    <fieldset disabled={busy || !board || !grants || !!unverified}>
      <legend>{t('New task grant')}</legend>
      <p>{t('Unsaved tasks are not listed. Default: status only.')}</p>
      <div ref={taskPicker} tabIndex={-1} className="workspace-access-tasks" role="group" aria-label={t('Choose tasks')}>{board?.tasks.map(task => <label key={task.id}><input name="workspaceboardaccess-input-1" type="checkbox" checked={selected.includes(task.id)} onChange={event => setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))} /><span>{task.title}</span></label>)}</div>
      {board && !board.tasks.length && <p>{t('Save a task before granting access.')}</p>}
      <label className="workspace-access-check"><input name="workspaceboardaccess-input-2" type="checkbox" checked={detail} onChange={event => setDetail(event.target.checked)} />{t('Also allow reading and updating task details')}</label>
      <label className="workspace-access-expiry">{t('Grant duration')}<select name="workspaceboardaccess-select-3" value={minutes} onChange={event => setMinutes(Number(event.target.value))}><option value={15}>{t('15 minutes')}</option><option value={60}>{t('1 hour')}</option><option value={480}>{t('8 hours')}</option><option value={1440}>{t('24 hours')}</option></select></label>
      <button className="workspace-access-primary" type="button" disabled={!selected.length || !!secret} onClick={() => void issue()}>{t('Issue selected task grant')}</button>
    </fieldset>
    <details open={bindingOpen} onToggle={event => setBindingOpen(event.currentTarget.open)}><summary>{t('Bind tasks to a session')}</summary>
      {bindingOpen && <WorkspaceBoardBinding key={JSON.stringify([scope, resourceId])} scope={scope} resourceId={resourceId} taskIds={selected} detail={detail} minutes={minutes}
        selectionReady={!busy && !!board && !!grants && !unverified && error !== 'load'} onChooseTasks={() => {
          const picker = taskPicker.current;
          picker?.scrollIntoView({ block: 'center' });
          (picker?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? picker)?.focus({ preventScroll: true });
        }} onChanged={() => {
        setSecret(undefined);
        void api.boardGrants(resourceId).then(result => { if (valid()) setGrants(result.capabilities); }).catch(() => { if (valid()) setError('load'); });
      }} />}
    </details>
    <details onToggle={event => setDelegationOpen(event.currentTarget.open)}><summary>{t('Bind tasks by group or tags')}</summary>
      {delegationOpen && <Suspense fallback={<p>{t('Loading…')}</p>}><WorkspaceBoardDelegation key={JSON.stringify([scope, resourceId])}
        scope={scope} resourceId={resourceId} taskIds={selected} detail={detail} minutes={minutes}
        selectionReady={!busy && !!board && !!grants && !unverified && error !== 'load'} /></Suspense>}
    </details>
    <details open={creationOpen} onToggle={event => setCreationOpen(event.currentTarget.open)}><summary>{t('Create session for selected tasks')}</summary>
      {creationOpen && <Suspense fallback={<p>{t('Loading…')}</p>}><WorkspaceTaskSession key={JSON.stringify([scope,resourceId])}
        scope={scope} resourceId={resourceId} taskIds={selected} detail={detail} minutes={minutes}
        selectionReady={!busy && !!board && !!grants && !unverified && error !== 'load'} /></Suspense>}
    </details>
    <section aria-label={t('Existing grants')}><h3>{t('Existing grants')}</h3>{grants?.length === 0 && <p>{t('No grants yet')}</p>}
      {grants?.map(grant => { const state = boardGrantState(grant, Math.max(now, Date.now())); return <article className="workspace-access-grant" key={grant.id} data-grant-state={state}>
        <header><code>{grant.id}</code><strong>{stateLabel[state]}</strong></header>
        <p>{grant.taskIds.map(id => board?.tasks.find(task => task.id === id)?.title ?? id).join(' · ')}</p>
        <small>{grant.fields.map(field => field === 'status' ? t('Task status') : t('Task details')).join(' + ')} · {t('Expires at')} <time dateTime={new Date(grant.expiresAt).toISOString()}>{new Date(grant.expiresAt).toLocaleString()}</time></small>
        {state === 'active' && (confirm === grant.id ? <div className="workspace-access-toolbar"><span>{t('Revoke this grant?')}</span><button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{t('Cancel')}</button><button type="button" disabled={busy || !!unverified} onClick={() => void revoke(grant.id)}>{t('Confirm revoke')}</button></div> : <button type="button" disabled={busy || !!unverified} onClick={() => setConfirm(grant.id)}>{t('Revoke grant')}</button>)}
      </article>; })}
    </section>
    <section aria-label={t('Grant audit')}><div className="workspace-access-toolbar"><h3>{t('Grant audit')}</h3><button type="button" disabled={busy} onClick={() => void readAudit()}>{t(audit ? 'Refresh audit' : 'Load audit')}</button></div>
      {audit?.length === 0 && <p>{t('No audit events')}</p>}
      {audit?.map(event => <article className="workspace-access-audit" key={event.sequence}><strong>{eventLabel[event.event] ?? t('Audit event')}</strong><code>{event.capabilityId}</code><small>#{event.sequence} · {t('Revision')} {event.revision ?? '—'} · <time>{new Date(event.createdAt).toLocaleString()}</time></small></article>)}
      {more && <button type="button" disabled={busy} onClick={() => void readAudit(true)}>{t('Older audit events')}</button>}
    </section>
  </dialog>;
}
