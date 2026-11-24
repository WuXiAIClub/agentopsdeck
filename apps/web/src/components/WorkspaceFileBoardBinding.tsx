import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { parseFileBoardIntent, type FileBoardBinding, type FileBoardIntent } from '../lib/workspace-file-board';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';

/** Whole-board association. Opening/selecting never sends or starts a turn.
 * One metadata load; reuse the shared directory, never load chat histories. */
export default function WorkspaceFileBoardBinding({ scope, resourceId, revision, dirty, onChanged, onClose, onAdvanced, card = false, initialSession = '', embedded = false }: {
  scope: string; resourceId: string; revision: number; dirty: boolean;
  initialSession?: string | undefined;
  embedded?: boolean;
  onChanged: (binding: FileBoardBinding | null) => void; onClose: () => void; onAdvanced?: () => void; card?: boolean;
}) {
  const { t } = useI18n();
  const linkLabel = card ? 'Link card to session' : 'Link whole board';
  const unlinkLabel = card ? 'Unlink card' : 'Unlink board';
  const transport = card ? { load: api.fileCardBinding, bind: api.bindFileCard, inspect: api.inspectFileCard, revoke: api.revokeFileCard, cancel: api.cancelFileCard }
    : { load: api.fileBoardBinding, bind: api.bindFileBoard, inspect: api.inspectFileBoard, revoke: api.revokeFileBoard, cancel: api.cancelFileBoard };
  const key = JSON.stringify([card ? 'agentopsdeck.file-card-intent' : 'agentopsdeck.file-board-intent', scope, resourceId]);
  const [binding, setBinding] = useState<FileBoardBinding | null>(null);
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]), [session, setSession] = useState(initialSession);
  const [pending, setPending] = useState<FileBoardIntent>();
  const [confirm, setConfirm] = useState(false), [cleanup, setCleanup] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined), lock = useRef(false);
  const { revision: sourceRevision } = useWorkspaceBoardRevision(scope, resourceId, card ? 'card-file-binding' : 'taskboard-binding');
  const inspected = useRef(0);
  const valid = () => scope === recoveryScope() && !!controller.current && !controller.current.signal.aborted;
  const remember = (intent?: FileBoardIntent) => {
    try { if (intent) sessionStorage.setItem(key, JSON.stringify(intent)); else sessionStorage.removeItem(key); setPending(intent); return true; }
    catch { setError(true); return false; }
  };
  const accept = (value: FileBoardBinding) => {
    const current = value.state === 'revoked' ? null : value;
    setBinding(current); remember(); setConfirm(false); onChanged(current);
  };
  const load = async () => {
    if (!valid() || lock.current) return;
    lock.current = true; setBusy(true); setError(false); const abort = controller.current!;
    try {
      const result = await transport.load(resourceId, abort.signal);
      if (!valid() || controller.current !== abort) return;
      setEnabled(result.enabled); setBinding(result.binding);
      const stored = parseFileBoardIntent(sessionStorage.getItem(key)); setPending(stored);
      if (result.binding && stored?.requestId === result.binding.bindingId) remember();
      if (result.enabled || result.binding) {
        const snapshot = await api.sessionsState();
        if (!valid() || controller.current !== abort) return;
        setSessions(snapshot.groups.flatMap(group => group.sessions).filter(s => s.sessionKey === result.binding?.sessionId || !s.archived
          && ['codex', 'claude-code', 'ghcp'].includes(s.sessionRef?.runtimeId ?? '')));
      }
    } catch { if (valid()) setError(true); }
    finally { if (controller.current === abort) { lock.current = false; if (valid()) setBusy(false); } }
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; void load();
    return () => { abort.abort(); lock.current = false; };
  }, [scope, resourceId]);
  useEffect(() => {
    if (busy || !sourceRevision || inspected.current === sourceRevision) return;
    inspected.current = sourceRevision; void load();
  }, [sourceRevision, busy]);
  const run = async (operation: () => Promise<void>) => {
    if (!valid() || lock.current) return;
    const abort = controller.current; lock.current = true; setBusy(true); setError(false);
    try { await operation(); } catch { if (valid()) setError(true); }
    finally { if (controller.current === abort) { lock.current = false; if (valid()) setBusy(false); } }
  };
  const bind = () => {
    const intent = pending ?? { requestId: crypto.randomUUID(), sessionId: session, revision };
    if (dirty || !enabled || binding || !intent.sessionId || !pending && !sessions.some(s => s.sessionKey === intent.sessionId) || !remember(intent)) return;
    void run(async () => { const result = await transport.bind(resourceId, intent, controller.current!.signal); if (valid()) accept(result.binding); });
  };
  return <div className="workspace-file-board-binding" role="group" aria-label={t(linkLabel)} aria-busy={busy}>
    {!embedded && <header><strong>{t(linkLabel)}</strong><button type="button" aria-label={t('Close')} onClick={onClose}>×</button></header>}
    {busy && <p role="status">{t('Loading…')}</p>}
    <p>{t(card ? 'Delegate this card to a session file. Its content becomes available to that Agent; no message is sent.' : 'Link this panel to a session. All current and future tasks are included; no task selection is needed.')}</p>
    <p>{t('AgentOpsDeck creates and manages the sync file on the selected session’s Connector. You do not need to choose an existing file or enter an ID.')}</p>
    {binding ? <>
      <p role="status">{t(binding.state === 'active' ? card ? 'Linked · file-synced card' : 'Linked · file-driven board' : 'Binding outcome pending · inspect without resending')}</p>
      <dl className="workspace-file-board-metadata">
        <dt>{t('Linked session')}</dt><dd>{sessions.find(item => item.sessionKey === binding.sessionId)?.title || binding.sessionId}</dd>
        <dt>{t('Sync file')}</dt><dd><code>{binding.bindingId}/{card ? 'card.json' : 'tasks.json'}</code></dd>
      </dl>
      <p>{t('This path is relative to the Connector’s managed sync directory, not your project directory. The Agent receives the full path automatically.')}</p>
      <p>{t('The Agent receives the file instructions with your next normal message. This does not start a run. Two-way editing requires Connector support.')}</p>
      {binding.problem && <p role="alert">{t(card ? 'File sync paused. The last valid card is retained.' : 'File sync paused. The last valid board is retained.')}</p>}
      <div className="workspace-file-board-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await transport.inspect(resourceId, binding.bindingId, controller.current!.signal); if (valid()) accept(result.binding);
        })}>{t('Check binding')}</button>
        {onAdvanced && <button type="button" disabled={busy} onClick={onAdvanced}>{t('Bind multiple sessions to tasks')}</button>}
        <button type="button" disabled={busy} onClick={() => setConfirm(true)}>{t(unlinkLabel)}</button>
      </div>
      {confirm && <div role="group" aria-label={t(unlinkLabel)}><p>{t(card ? 'Stop syncing this card? Its content and the Connector file are kept.' : 'Stop importing this file? Existing tasks and the Connector file are kept.')}</p>
        <button type="button" disabled={busy} onClick={() => setConfirm(false)}>{t('Cancel')}</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await transport.revoke(resourceId, binding.bindingId, controller.current!.signal);
          if (valid()) { accept(result.binding); setCleanup(result.cleanup === 'pending'); }
        })}>{t('Confirm unlink')}</button></div>}
    </> : <>
      {!enabled && !busy && !error && <p>{t('File-based boards are not enabled on this Hub. An operator must configure the dedicated Connector directory and permission.')}</p>}
      {enabled && <><label>{t('Session')}<select name="workspacefileboardbinding-select-1" aria-label={t('Session')} value={pending?.sessionId ?? session} disabled={busy || !!pending} onChange={e => setSession(e.target.value)}>
        <option value="">{t('Select session')}</option>{sessions.map(s => <option key={s.sessionKey} value={s.sessionKey}>{s.title || s.sessionKey}</option>)}
      </select></label>
      {dirty && <p>{t('Save or discard your board edits before linking.')}</p>}
      {pending && <p role="status">{t('Binding result unconfirmed. Check first; retry uses the same request and never sends a chat message.')}</p>}
      {!busy && !sessions.length && <p role="status">{t('No eligible sessions. Create a Codex, Claude Code or GitHub Copilot session first.')}</p>}
      <div className="workspace-file-board-actions"><button type="button" disabled={busy || dirty || !pending && !sessions.some(s => s.sessionKey === session)} onClick={bind}>{t(pending ? 'Retry same binding' : linkLabel)}</button>
        {pending && <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await transport.inspect(resourceId, pending.requestId, controller.current!.signal); if (valid()) accept(result.binding);
        })}>{t('Check binding')}</button>}
        {pending && <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await transport.cancel(resourceId, pending.requestId, controller.current!.signal);
          if (valid()) { remember(); setCleanup(result.cleanup === 'pending'); onChanged(null); }
        })}>{t('Cancel pending binding')}</button>}</div></>}
    </>}
    {cleanup && <p role="status">{t('Local import stopped. Remote cleanup is pending; the file was not deleted.')}</p>}
    {error && <p role="alert">{t('Unable to confirm the binding. No message was sent; check the original request before retrying.')}</p>}
    <footer><button type="button" disabled={busy} onClick={() => void load()}>{t('Refresh')}</button>
      {onAdvanced && <button type="button" onClick={onAdvanced}>{t('Advanced task permissions')}</button>}</footer>
  </div>;
}
