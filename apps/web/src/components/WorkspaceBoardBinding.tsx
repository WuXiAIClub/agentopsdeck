import { useEffect, useId, useRef, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { Link2, RefreshCw } from 'lucide-react';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { bindingStateLabel, type BoardSessionBinding } from '../lib/workspace-board-binding';
import { bindingReceiptKey, parseBindingReceipt } from '../lib/workspace-binding-receipt';

/** Small metadata reads only while this disclosure is open. Credentials never
 * enter browser state, storage, DOM or clipboard. No background polling. */
export default function WorkspaceBoardBinding({ scope, resourceId, taskIds, detail, minutes, selectionReady, onChooseTasks, onChanged }: {
  scope: string; resourceId: string; taskIds: string[]; detail: boolean; minutes: number;
  selectionReady: boolean; onChooseTasks: () => void; onChanged: () => void;
}) {
  const { t } = useI18n();
  const statusId = useId();
  const receiptKey = bindingReceiptKey(scope, resourceId);
  const controller = useRef<AbortController | undefined>(undefined), lock = useRef(false);
  const [bindings, setBindings] = useState<BoardSessionBinding[]>([]), [enabled, setEnabled] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]), [session, setSession] = useState('');
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(false);
  const [pending, setPending] = useState<string | undefined>(() => {
    try { return parseBindingReceipt(sessionStorage.getItem(receiptKey)); } catch { return undefined; }
  }), [confirm, setConfirm] = useState<string>(), [cleanup, setCleanup] = useState(false);
  const valid = () => scope === recoveryScope() && !!controller.current && !controller.current.signal.aborted;
  const remember = (id?: string) => {
    try {
      if (id) sessionStorage.setItem(receiptKey, id); else sessionStorage.removeItem(receiptKey);
      setPending(id); return true;
    } catch { setError(true); return false; }
  };
  const load = async () => {
    if (lock.current || !valid()) return;
    const abort = controller.current!;
    const current = () => valid() && controller.current === abort;
    lock.current = true; setBusy(true); setError(false);
    try {
      const result = await api.boardBindings(resourceId, abort.signal);
      if (!current()) return;
      setEnabled(result.enabled); setBindings(result.bindings); setLoaded(true);
      if (pending && result.bindings.some(binding => binding.requestId === pending)) remember();
      if (result.enabled) {
        // Reuse the application's conditional session-directory request, never
        // fetch message histories or start an independent session watcher.
        const snapshot = await api.sessionsState();
        if (!current()) return;
        const available = snapshot.groups.flatMap(group => group.sessions).filter(s => ['claude-code', 'ghcp', 'codex'].includes(s.sessionRef?.runtimeId ?? '') && !s.archived);
        setSessions(available);
        setSession(current => available.some(s => s.sessionKey === current) ? current : '');
      }
    } catch { if (current()) setError(true); }
    finally { if (controller.current === abort) { lock.current = false; if (current()) setBusy(false); } }
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; void load();
    return () => { abort.abort(); lock.current = false; };
  }, [scope, resourceId]);
  const accept = (binding: BoardSessionBinding) => {
    setBindings(previous => [binding, ...previous.filter(row => row.requestId !== binding.requestId)]);
    remember(); setConfirm(undefined); onChanged();
  };
  const blockedReason = busy || !loaded ? t('Checking binding readiness…')
    : pending ? t('Inspect or cancel the unconfirmed binding before creating another.')
    : error ? t('Refresh binding information before trying again.')
    : !enabled ? t('Automatic binding is not configured. A fixed Hub endpoint and private Connector permission are required.')
    : !selectionReady ? t('Refresh grants above to confirm the saved tasks and permissions.')
    : !taskIds.length ? t('Select at least one saved task above. No manual grant is needed.')
    : !sessions.length ? t('No supported sessions found. This binding supports Codex, Claude Code and GitHub Copilot.')
    : !sessions.some(s => s.sessionKey === session) ? t('Choose the session that should update these tasks.') : '';
  const bind = async () => {
    if (!valid() || lock.current || blockedReason) return;
    const requestId = crypto.randomUUID();
    // Do not admit a mutation if its recovery identity cannot survive reload.
    if (!remember(requestId)) return;
    lock.current = true; setBusy(true); setError(false); setCleanup(false);
    try {
      const result = await api.bindBoardSession(resourceId, { requestId, sessionId: session,
        grant: { taskIds: [...taskIds], fields: detail ? ['status', 'detail'] : ['status'], expiresAt: Date.now() + minutes * 60_000 } }, controller.current!.signal);
      if (valid()) accept(result.binding);
    } catch { if (valid()) setError(true); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const action = async (requestId: string, revoke: boolean) => {
    if (!valid() || lock.current) return;
    lock.current = true; setBusy(true); setError(false); setCleanup(false);
    try {
      if (revoke) {
        const result = await api.revokeBoardBinding(resourceId, requestId, controller.current!.signal);
        if (valid()) { accept(result.binding); setCleanup(result.cleanup !== 'confirmed'); }
      } else {
        const result = await api.inspectBoardBinding(resourceId, requestId, controller.current!.signal);
        if (valid()) accept(result.binding);
      }
    } catch { if (valid()) setError(true); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  const cancelPending = async () => {
    if (!pending || !valid() || lock.current) return;
    const requestId = pending;
    lock.current = true; setBusy(true); setError(false);
    try {
      const result = await api.cancelBoardBindingIntent(resourceId, requestId, controller.current!.signal);
      if (!valid()) return;
      if (result.cancelled !== true || result.requestId !== requestId) throw Error('Invalid cancellation receipt');
      if (result.binding) { accept(result.binding); setCleanup(true); }
      else { remember(); onChanged(); }
    } catch { if (valid()) setError(true); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  };
  return <section className="workspace-session-bindings" aria-label={t('Bind tasks to a session')}>
    <div className="workspace-access-toolbar"><h3>{t('Bind tasks to a session')}</h3><button type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={13} />{t('Refresh')}</button></div>
    <p>{t('Select saved tasks above, choose a session, then bind. You do not need to issue or copy a grant first.')}</p>
    {busy && <p role="status">{t('Working…')}</p>}
    {error && <p role="alert">{t('Unable to confirm binding. Inspect the original request before creating another grant.')}</p>}
    {cleanup && <p role="status">{t('Grant revoked. Connector cleanup is still pending; retry revocation when it is online.')}</p>}
    {pending && <div role="status"><p>{t('Binding outcome unconfirmed')} <code>{pending}</code></p>
      <button type="button" disabled={busy} onClick={() => void action(pending, false)}>{t('Inspect binding')}</button>
      <button type="button" disabled={busy} onClick={() => void cancelPending()}>{t('Cancel this binding request')}</button>
      <small>{t('Cancellation blocks a delayed grant too. It does not cancel the Agent run or resend a message.')}</small></div>}
    {loaded && !enabled && <p>{t('Automatic binding is not configured. A fixed Hub endpoint and private Connector permission are required.')}</p>}
    {enabled && <><div className="workspace-access-toolbar"><strong>{t('Selected tasks: {count}', { count: taskIds.length })}</strong><button type="button" disabled={busy || !selectionReady} onClick={onChooseTasks}>{t('Choose tasks')}</button></div>
    <div className="workspace-access-toolbar"><label>{t('Session')}<select name="workspaceboardbinding-select-1" value={session} disabled={busy} onChange={e => setSession(e.target.value)}>
      <option value="">{t('Choose a session')}</option>{sessions.map(s => <option key={s.sessionKey} value={s.sessionKey}>{s.title} · {s.sessionRef?.runtimeId}</option>)}
    </select></label><button type="button" className="workspace-access-primary" disabled={!!blockedReason} aria-describedby={statusId} onClick={() => void bind()}><Link2 size={14} />{t('Bind selected tasks')}</button></div>
    <p id={statusId} role="status">{blockedReason || t('Ready to bind the selected tasks. This does not send a chat message.')}</p></>}
    {enabled && <small>{t('Codex task tools are registered when a session is created after enablement. You may chat before binding; the session need not be empty. Older sessions cannot gain tools through binding.')}</small>}
    {bindings.map(binding => <article className="workspace-access-grant" key={binding.requestId}>
      <header><strong>{sessions.find(s => s.sessionKey === binding.sessionId)?.title ?? binding.sessionId}</strong><span>{t(bindingStateLabel[binding.state])}</span></header>
      <small>{t('Expires at')} <time>{new Date(binding.expiresAt).toLocaleString()}</time></small>
      <div className="workspace-access-toolbar">
        {!['revoked', 'expired', 'unavailable'].includes(binding.state) && <button type="button" disabled={busy} onClick={() => void action(binding.requestId, false)}>{t('Inspect binding')}</button>}
        {confirm === binding.requestId ? <><button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{t('Cancel')}</button><button type="button" disabled={busy} onClick={() => void action(binding.requestId, true)}>{t('Confirm revoke')}</button></>
          : <button type="button" disabled={busy} onClick={() => setConfirm(binding.requestId)}>{t('Revoke grant')}</button>}
      </div>
    </article>)}
  </section>;
}
