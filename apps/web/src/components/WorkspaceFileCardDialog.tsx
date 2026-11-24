import { useEffect, useRef, useState, type RefObject } from 'react';
import { parseWorkspaceFileCardResource, validWorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { api, ApiResponseError, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import type { FileBoardBinding } from '../lib/workspace-file-board';
import type { FileCardDocument, FileCardSettings } from '../lib/workspace-file-card-context';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import WorkspaceFileBoardBinding from './WorkspaceFileBoardBinding';
import './workspace-file-card.css';
import { parseFileCardPending, parseFileCardDocument, type FileCardPending as Pending } from '../lib/workspace-file-card-write';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { validBoardUuid } from '@agentopsdeck/shared';
import WorkspaceBoardSyncDialog from './WorkspaceBoardSyncDialog';
import NotebookFileSync from './NotebookFileSync';

type Props = {
  scope: string; resource: string; settings: RefObject<FileCardSettings | undefined>;
  onDocument(document: FileCardDocument): void; onClose(): void;
  initialSession?: string | undefined;
};
export default function WorkspaceFileCardDialog(props: Props) {
  const parsed = parseWorkspaceFileCardResource(props.resource)!;
  return parsed.kind === 'taskboard' || parsed.kind === 'statuscard'
    ? <WorkspaceBoardSyncDialog scope={props.scope} id={parsed.id} initialSession={props.initialSession} onClose={props.onClose} />
    : <FileCardDialog {...props} />;
}
function FileCardDialog({ scope, resource, settings, onDocument, onClose, initialSession }: Props) {
  const { t } = useI18n(), kind = parseWorkspaceFileCardResource(resource)!.kind;
  const [document, setDocument] = useState<FileCardDocument>(), [binding, setBinding] = useState<FileBoardBinding | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(false), [link, setLink] = useState(!!initialSession), [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<Pending>(), [conflict, setConflict] = useState(false), [writable, setWritable] = useState(false);
  const [invalidDraft, setInvalidDraft] = useState(false), [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<{ text: string; revision: number; bindingId: string | null }>();
  const abort = useRef(new AbortController()), locked = useRef(false), dialog = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(['agentopsdeck.file-card-write', scope, resource]);
  const draftKey = JSON.stringify(['agentopsdeck.file-card-draft', scope, resource]);
  usePageRefreshGuard(() => !busy && !draft && !pending);
  const changeDraft = (value?: typeof draft) => {
    if (value) sessionStorage.setItem(draftKey, JSON.stringify(value)); else sessionStorage.removeItem(draftKey);
    setDraft(value);
    setInvalidDraft(false); setSaved(false);
  };
  useEffect(() => {
    if (!draft && !pending) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [draft, pending]);
  const { notice } = useWorkspaceBoardRevision(scope, resource, 'card-file-binding');
  const inspectedNotice = useRef(0);
  const valid = () => recoveryScope() === scope && !abort.current.signal.aborted;
  const remember = (value?: Pending) => {
    if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
    setPending(value);
  };
  const load = async () => {
    const signal = abort.current.signal;
    const current = () => valid() && !signal.aborted;
    const b = await api.fileCardBinding(resource, signal);
    if (!current()) return;
    setBinding(b.binding);
    let canWrite = !b.binding;
    if (b.binding) { try { canWrite = (await api.fileCardCapabilities(resource, signal)).writable; } catch { /* Reading and revocation remain available offline. */ } }
    if (!current()) return;
    setWritable(canWrite);
    try {
      const value = parseFileCardDocument(await api.fileCard(resource, signal));
      if (!value || value.kind !== kind) throw Error('Invalid document');
      if (current()) { setDocument(value); onDocument(value); }
    } catch (cause) { if (!(cause instanceof ApiResponseError) || cause.status !== 404) throw cause; }
  };
  const run = async (operation: () => Promise<void>) => {
    if (!valid() || locked.current) return;
    locked.current = true; setBusy(true); setError(false);
    try { await operation(); } catch (cause) { if (valid()) { setError(true); if (cause instanceof ApiResponseError && cause.status === 409) setConflict(true); } }
    finally { locked.current = false; if (valid()) setBusy(false); }
  };
  useEffect(() => {
    abort.current = new AbortController();
    const previous = window.document.activeElement;
    dialog.current?.focus();
    const signal = abort.current.signal;
    // StrictMode cleanup must not leave the remounted dialog locked behind an
    // aborted initial load. Start only after this effect survives cleanup.
    queueMicrotask(() => { if (!signal.aborted) void run(async () => {
      const text = sessionStorage.getItem(key);
      if (text) {
        const value = parseFileCardPending(text, kind);
        if (!value) throw Error('Invalid pending write');
        setPending(value);
      }
      const savedDraft = sessionStorage.getItem(draftKey);
      if (savedDraft) {
        const value = JSON.parse(savedDraft);
        if (!value || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 0
          || value.bindingId !== null && !validBoardUuid(value.bindingId)) throw Error('Invalid draft');
        setDraft(value);
      }
      await load();
    }); });
    return () => { abort.current.abort(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [scope, resource]);
  useEffect(() => {
    // Coalesce revisions arriving while another operation holds the lock;
    // dropping that event can leave an open dialog indefinitely stale.
    if (busy || !notice || inspectedNotice.current === notice) return;
    inspectedNotice.current = notice; void run(load);
  }, [notice, busy]);
  const save = () => void run(async () => {
    if (!settings.current?.available() || pending || !writable) return;
    if (draft && draft.bindingId !== (binding?.bindingId ?? null)) { setConflict(true); throw new ApiResponseError('Binding changed', 409); }
    let content;
    try { content = draft === undefined ? settings.current.capture() : { kind, content: JSON.parse(draft.text) }; }
    catch { setInvalidDraft(true); return; }
    const input = { ...content, revision: draft?.revision ?? document?.revision ?? 0, mutationId: crypto.randomUUID() };
    if (!validWorkspaceFileCardWrite(input) || input.kind !== kind) { setInvalidDraft(true); return; }
    setInvalidDraft(false); setSaved(false);
    const intent = { bindingId: binding?.bindingId ?? null, input }; remember(intent); setConflict(false);
    if (intent.bindingId) {
      const result = await api.writeFileCard(resource, intent.bindingId, input, abort.current.signal);
      if (!valid()) return;
      if (result.receipt.state !== 'saved') { setConflict(result.receipt.state === 'conflict'); return; }
    } else await api.saveFileCardConfiguration(resource, input, abort.current.signal);
    if (valid()) { remember(); changeDraft(); await load(); if (valid()) setSaved(true); }
  });
  const inspect = () => void run(async () => {
    if (!pending) return;
    if (pending.bindingId) {
      const result = await api.inspectFileCardWrite(resource, pending.bindingId, pending.input.mutationId, abort.current.signal);
      if (!valid()) return;
      if (result.receipt.state !== 'saved') { setConflict(result.receipt.state === 'conflict'); return; }
    } else await api.saveFileCardConfiguration(resource, pending.input, abort.current.signal); // Local CAS receipt, same UUID.
    if (valid()) { remember(); changeDraft(); setConflict(false); await load(); if (valid()) setSaved(true); }
  });
  const close = () => { if (!busy && draft === undefined) onClose(); };
  return <div className="workspace-file-card-backdrop" onPointerDown={e => e.stopPropagation()} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="workspace-file-card-dialog" role="dialog" aria-modal="true" aria-label={t('Card file sync')} tabIndex={-1} ref={dialog}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Tab') {
          const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? []);
          const first = nodes[0], last = nodes.at(-1);
          if (!first) { e.preventDefault(); return; }
          if (!dialog.current?.contains(window.document.activeElement) || window.document.activeElement === dialog.current) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
          else if (e.shiftKey && window.document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && window.document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <header><strong>{t('Card file sync')}</strong><button type="button" disabled={busy || draft !== undefined} onClick={close} aria-label={t('Close')}>×</button></header>
      <p>{t('Files change content and desired settings only. Service actions still require your explicit approval.')}</p>
      {document && <p>{document.content.title} · {t('Revision')} {document.revision}</p>}
      {busy && <p role="status">{t('Syncing card…')}</p>}
      {!busy && saved && <p role="status" className="workspace-file-card-notice">{t(binding ? 'Card saved. The Agent can read the updated file on its next read.' : 'Card settings saved.')}</p>}
      {!busy && binding && !writable && <p role="status">{t('Read-only for now. Check Connector availability and write support; your content is retained.')}</p>}
      {settings.current && <div className="workspace-file-board-actions">
        <button type="button" disabled={busy || !!pending || !writable || !settings.current.available()} onClick={save}>{t('Save current settings')}</button>
        <button type="button" disabled={busy || !!pending || !!draft || !document || !settings.current.available()} onClick={() => void run(async () => { if (document) settings.current?.apply(document); })}>{t('Use file settings')}</button>
      </div>}
      {settings.current && <details><summary>{t('Edit desired settings')}</summary><textarea name="workspacefilecarddialog-textarea-1" aria-label={t('Card settings JSON')} aria-invalid={invalidDraft} aria-describedby={invalidDraft ? 'file-card-validation' : undefined} spellCheck={false}
        disabled={busy || !!pending} value={draft?.text ?? JSON.stringify(document?.content ?? settings.current.capture().content, null, 2)} onChange={e => { try { changeDraft({ text: e.target.value, revision: draft?.revision ?? document?.revision ?? 0, bindingId: draft ? draft.bindingId : binding?.bindingId ?? null }); } catch { setError(true); } }} />
        {draft !== undefined && <button type="button" disabled={busy || !!pending} onClick={() => { try { changeDraft(); setConflict(false); } catch { setError(true); } }}>{t('Discard changes')}</button>}</details>}
      {invalidDraft && <p role="alert" id="file-card-validation">{t('Invalid card settings. Keep the expected JSON fields and value types. Nothing was sent; your draft is kept.')}</p>}
      {draft && !pending && !invalidDraft && <p role="status">{t('Unsaved card edits. Save or discard before closing.')}</p>}
      {pending && <div role="status"><p>{t(conflict ? 'File changed elsewhere. Your draft is kept.' : 'Save result unconfirmed. Inspect the original write; it will not be replayed.')}</p>
        <button type="button" disabled={busy} onClick={inspect}>{t('Check file save')}</button>
        {conflict && <button type="button" disabled={busy} onClick={() => void run(async () => { remember(); changeDraft(); setConflict(false); await load(); })}>{t('Discard changes')}</button>}
      </div>}
      {error && !conflict && <p role="alert">{t('Card sync could not be confirmed. Your draft is kept; inspect a pending save before retrying.')}</p>}
      {kind === 'notebook' && binding && <NotebookFileSync resource={resource} paused={busy || !!pending || draft !== undefined} apiAccess={false}
        ready={() => !pending && draft === undefined} onChanged={() => { void run(load); }} />}
      {(kind === 'notebook' || kind === 'report') && !binding && <label><input name="workspacefilecarddialog-input-2" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />{t(kind === 'notebook' ? 'Allow the selected Agent to read and edit this private notebook, including its archive.' : 'Allow the selected Agent to read and edit this private note.')}</label>}
      {link && document && (binding || !['notebook', 'report'].includes(kind) || consent) ? <WorkspaceFileBoardBinding card embedded initialSession={initialSession} scope={scope} resourceId={resource} revision={document.revision} dirty={!!pending || draft !== undefined}
        onChanged={value => { setBinding(value); void run(load); }} onClose={() => setLink(false)} /> : <button type="button" disabled={busy || !document || !!pending || !binding && (kind === 'notebook' || kind === 'report') && !consent} onClick={() => setLink(true)}>{t(binding ? 'Manage card link' : 'Link card to session')}</button>}
      {!link && <button type="button" disabled={busy} onClick={() => void run(load)}>{t('Refresh')}</button>}
    </div>
  </div>;
}
