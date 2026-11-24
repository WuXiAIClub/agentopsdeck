import { lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import { Plus, Save, RefreshCw, Trash2, ArrowUp, ArrowDown, ChartNoAxesCombined, Link2, GripVertical, Eye, EyeOff, Shield, Clock3 } from 'lucide-react';
import { recordCardVersionSnapshot } from '../lib/card-version-history';
import { BOARD_MAX_TASKS, BOARD_STATUSES, validBoardContent, type BoardDocument, type BoardWrite, type BoardStatus } from '@agentopsdeck/shared';
import { api, ApiResponseError, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { boardContentEqual, boardDraftKey, parseBoardDraft, reconcileBoardDraft, publishBoardSaved, moveBoardTask, readCachedBoardDocument, writeCachedBoardDocument } from '../lib/workspace-board';
import { useBoardTaskDrag } from '../lib/use-board-task-drag';
import { WorkspaceBoardPicker, type OpenBoardResource } from './WorkspaceBoardPicker';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import type { FileBoardBinding } from '../lib/workspace-file-board';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import { TaskCard } from './TaskCard';
import { TaskMetadataEditor, TaskMetadataSummary } from './TaskMetadata';
import { useBoardHideDone } from '../lib/board-view-preference';
import { WorkspaceFileCardContext } from '../lib/workspace-file-card-context';
import { importSourceTask, type SourceTaskRequest } from '../lib/source-task';
import { taskboardContextStatus } from '../lib/taskboard-context-menu';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';

const labels: Record<BoardStatus, 'To do' | 'In progress' | 'Done'> = { todo: 'To do', doing: 'In progress', done: 'Done' };
const WorkspaceBoardAccess = lazy(() => import('./WorkspaceBoardAccess'));
const WorkspaceFileBoardBinding = lazy(() => import('./WorkspaceFileBoardBinding'));
const CardVersionHistoryModal = lazy(() => import('./CardVersionHistoryModal'));
/** Reads on open, explicit refresh, or a newer owner resource revision. */
export default function WorkspaceTaskboard({ scope, resourceId = 'default', onOpen }: { scope: string; resourceId?: string; onOpen: OpenBoardResource }) {
  const { t } = useI18n();
  const sourceHost=useRef<HTMLElement>(null);
  const sourceImportRevision=useRef<string|undefined>(undefined);
  const sharedFileSync = useContext(WorkspaceFileCardContext) !== null;
  const [hideDone, setHideDone] = useBoardHideDone(scope, resourceId);
  const draftKey = boardDraftKey(scope, resourceId);
  const [initialSeed] = useState(() => {
    if (scope !== recoveryScope()) return undefined;
    const cached = readCachedBoardDocument(scope, resourceId);
    if (!cached) return undefined;
    let local: BoardWrite | undefined;
    let storageFailed = false;
    try { local = parseBoardDraft(sessionStorage.getItem(draftKey)); } catch { storageFailed = true; }
    const reconciled = reconcileBoardDraft(cached, local, crypto.randomUUID());
    return { document: cached, draft: reconciled.draft, conflict: reconciled.conflict, storageFailed };
  });
  const [document, setDocument] = useState<BoardDocument | undefined>(() => initialSeed?.document);
  const [draft, setDraft] = useState<BoardWrite | undefined>(() => initialSeed?.draft);
  const [busy, setBusy] = useState(false), lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'load' | 'conflict' | 'uncertain' | ''>(() => initialSeed?.conflict ? 'conflict' : '');
  const [storageError, setStorageError] = useState(() => initialSeed?.storageFailed ?? false);
  const [limited, setLimited] = useState(false);
  const [newTaskId, setNewTaskId] = useState<string>();
  const [creationMenu, setCreationMenu] = useState<{ key: string; x: number; y: number; status: BoardStatus }>();
  // Only edits made in this mounted board can arm autosave. Recovered drafts
  // may be unconfirmed requests and must never be replayed just by opening.
  const [editedMutationId, setEditedMutationId] = useState<string>();
  const [composing, setComposing] = useState(false);
  const latestAutosave = useRef<(() => Promise<void>) | undefined>(undefined);
  const authEpoch = useRef(0);
  // UnlockScreen reloads the page after authentication, including same-scope
  // unlock. No old panel event may change/persist a draft underneath the lock.
  const authLocked = useRef(false);
  const [discard, setDiscard] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [accessFor, setAccessFor] = useState<string>();
  const [accessSection, setAccessSection] = useState<'create' | 'bind'>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [fileFor, setFileFor] = useState<string>();
  const [fileBinding, setFileBinding] = useState<FileBoardBinding | null>(() => initialSeed?.document.fileBinding ?? null);
  const [fileWritable, setFileWritable] = useState(false);
  useEffect(() => {
    if (!document) return;
    const savedIds = new Set(document.tasks.map(task => task.id));
    setSelectedTaskIds(current => current.filter(id => savedIds.has(id)));
  }, [document]);
  useEffect(() => {
    setFileWritable(false);
    if (fileBinding?.state !== 'active' || scope !== recoveryScope()) return;
    const abort = new AbortController();
    void api.fileBoardCapabilities(resourceId, abort.signal).then(value => {
      if (!abort.signal.aborted && scope === recoveryScope()) setFileWritable(value.writable);
    }).catch(() => { /* Legacy/offline Connector remains read-only. */ });
    return () => abort.abort();
  }, [scope, resourceId, fileBinding?.bindingId, fileBinding?.state, generation]);
  const alive = useRef(true);
  const { revision: remoteRevision, notice: remoteNotice } = useWorkspaceBoardRevision(scope, resourceId);
  const { revision: bindingRevision } = useWorkspaceBoardRevision(scope, resourceId, 'taskboard-binding');
  useEffect(() => {
    if (!bindingRevision || scope !== recoveryScope()) return;
    const abort = new AbortController();
    void api.fileBoardBinding(resourceId, abort.signal).then(result => {
      if (!abort.signal.aborted && scope === recoveryScope()) setFileBinding(result.binding);
    }).catch(() => { /* Retain the last known binding; never unlock edits on a failed read. */ });
    return () => abort.abort();
  }, [scope, resourceId, bindingRevision]);
  const attemptedRemote = useRef('');
  useEffect(() => { setAccessFor(undefined); }, [draftKey]);
  const validIdentity = () => alive.current && !authLocked.current && scope === recoveryScope();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    // The unlock overlay preserves this mounted view and its recovery scope.
    // Cancel synchronously, without relying on a scope change or unmount.
    const cancel = () => { authLocked.current = true; authEpoch.current++; latestAutosave.current = undefined; setEditedMutationId(undefined); setError('uncertain'); setBusy(false); setSaving(false); };
    window.addEventListener('agentopsdeck:auth-required', cancel);
    return () => window.removeEventListener('agentopsdeck:auth-required', cancel);
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let current = true;
    setEditedMutationId(undefined);
    setBusy(true); lock.current = true;
    void api.workspaceBoard(resourceId, abort.signal).then(remote => {
      if (!current || !validIdentity()) return;
      let local: BoardWrite | undefined;
      // Tab-local drafts survive reload without another tab overwriting them.
      try { local = parseBoardDraft(sessionStorage.getItem(draftKey)); } catch { setStorageError(true); }
      writeCachedBoardDocument(scope, resourceId, remote);
      recordCardVersionSnapshot({ scope, kind: 'taskboard', resourceId, revision: remote.revision, payload: JSON.stringify({ title: remote.title, tasks: remote.tasks }), summary: `${remote.title || 'Task board'} (${remote.tasks.length} tasks)` });
      const state = reconcileBoardDraft(remote, local, crypto.randomUUID());
      setDocument(remote); setDraft(state.draft); setFileBinding(remote.fileBinding ?? null); setError(state.conflict ? 'conflict' : '');
    }).catch(() => { if (current) setError('load'); }).finally(() => { if (current) { setBusy(false); lock.current = false; } });
    return () => { current = false; abort.abort(); };
  }, [scope, resourceId, draftKey, generation]);
  const persist = (value: BoardWrite) => {
    try { sessionStorage.setItem(draftKey, JSON.stringify(value)); setStorageError(false); } catch { setStorageError(true); }
  };
  const edit = (next: BoardWrite) => {
    if (lock.current || error === 'uncertain' || error === 'load' || (fileBinding && !fileWritable) || !validIdentity()) return;
    if (!validBoardContent(next, true)) { setLimited(true); return; }
    setLimited(false);
    const value = { ...next, mutationId: crypto.randomUUID() }; setDraft(value); persist(value); setEditedMutationId(value.mutationId);
  };
  const save = async () => {
    if (!draft || lock.current || (fileBinding && !fileWritable) || !validIdentity() || !validBoardContent(draft) || error === 'conflict') return;
    const epoch = authEpoch.current;
    const acceptReply = () => {
      if (!validIdentity()) return false;
      if (authEpoch.current !== epoch) { setError('uncertain'); return false; }
      return true;
    };
    lock.current = true; setBusy(true); setSaving(true); persist(draft);
    try {
      let saved: BoardDocument;
      if (fileBinding) {
        const { receipt } = await api.writeFileBoard(resourceId, fileBinding.bindingId, draft);
        if (!acceptReply()) return;
        if (receipt.state !== 'saved') { setError(receipt.state === 'conflict' ? 'conflict' : 'uncertain'); return; }
        saved = await api.workspaceBoard(resourceId);
        if (!boardContentEqual(saved, draft)) { setError('conflict'); return; }
      } else saved = await api.saveWorkspaceBoard(resourceId, draft);
      if (!acceptReply()) return;
      setDocument(saved); const next = { title: saved.title, tasks: saved.tasks, revision: saved.revision, mutationId: crypto.randomUUID() };
      setDraft(next);
      // Only unsaved/unconfirmed edits belong in draft storage. A clean saved
      // snapshot would look like a divergent draft after an offline update.
      try { sessionStorage.removeItem(draftKey); setStorageError(false); } catch { setStorageError(true); }
      setError(''); publishBoardSaved(scope, saved);
      recordCardVersionSnapshot({ scope, kind: 'taskboard', resourceId, revision: saved.revision, payload: JSON.stringify({ title: saved.title, tasks: saved.tasks }), summary: `${saved.title || 'Task board'} (${saved.tasks.length} tasks)` });
    } catch (cause) {
      if (validIdentity()) setError(cause instanceof ApiResponseError && cause.status === 409 ? 'conflict' : 'uncertain');
    } finally { lock.current = false; if (validIdentity()) { setBusy(false); setSaving(false); } }
  };
  const dirty = !!draft && !!document && !boardContentEqual(draft, document);
  usePageRefreshGuard(() => !dirty && !busy && !storageError);
  useEffect(() => {
    if (busy || lock.current || scope !== recoveryScope() || !remoteRevision || (document && remoteRevision <= document.revision)) return;
    // In-flight or unconfirmed saves retain their original mutation identity.
    if (error === 'uncertain') return;
    if (dirty) { setError('conflict'); return; }
    const attempt = JSON.stringify([draftKey, remoteRevision, remoteNotice]);
    if (attemptedRemote.current === attempt) return;
    attemptedRemote.current = attempt;
    // This is a confirmed clean draft. Do not misclassify the old saved snapshot
    // as unsaved edits when the newer version arrives.
    if (document) try { sessionStorage.removeItem(draftKey); } catch { setStorageError(true); return; }
    setGeneration(value => value + 1);
  }, [remoteRevision, remoteNotice, document, busy, dirty, error, scope, draftKey]);
  const reload = () => {
    if (busy) return;
    if (dirty || error === 'uncertain') { setDiscard(true); return; }
    setGeneration(value => value + 1);
  };
  const disabled = busy || (!!fileBinding && !fileWritable) || error === 'uncertain' || error === 'load';
  // Saving serializes edits, but readOnly (unlike disabled) retains the text
  // cursor/focus so a background save does not eject the user from the editor.
  const textDisabled = (!!fileBinding && !fileWritable) || error === 'uncertain' || error === 'load';
  const taskDrag = useBoardTaskDrag(draftKey, draft, disabled || error === 'conflict' || discard || !!accessFor || !!fileFor, (id, target) => {
    if (!draft) return;
    const tasks = moveBoardTask(draft.tasks, id, target);
    if (tasks !== draft.tasks) edit({ ...draft, tasks });
  });
  // Also cancels stale drop targets after a preference change from another pane/tab.
  useEffect(() => { taskDrag.cancel(); }, [hideDone, taskDrag.cancel]);
  useEffect(() => { setCreationMenu(undefined); }, [draftKey, hideDone, disabled, error, discard, accessFor, fileFor, taskDrag.feedback]);
  const creationDisabled = disabled || !draft || draft.tasks.length >= BOARD_MAX_TASKS
    || error === 'conflict' || discard || !!accessFor || !!fileFor || !!taskDrag.feedback;
  const addTask = (status: BoardStatus) => {
    if (creationDisabled || !draft || lock.current || !validIdentity()) return;
    const id = crypto.randomUUID();
    const next = { ...draft, tasks: [...draft.tasks, { id, title: t('New task'), detail: '', status }] };
    if (!validBoardContent(next, true)) { setLimited(true); return; }
    edit(next);
    setNewTaskId(id);
  };
  const autosaveReady = dirty && draft?.mutationId === editedMutationId && validBoardContent(draft)
    && !busy && !error && !discard && !composing && !taskDrag.feedback && !accessFor && !fileFor
    && (!fileBinding || fileWritable) && scope === recoveryScope();
  latestAutosave.current = autosaveReady ? save : undefined;
  useEffect(() => {
    if (!autosaveReady) return;
    const timer = window.setTimeout(() => { void latestAutosave.current?.(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [autosaveReady, draft, draftKey, fileBinding, fileWritable]);
  useEffect(()=>{
    const element=sourceHost.current;if(!element)return;
    const receive=(event:Event)=>{
      const detail=(event as CustomEvent<SourceTaskRequest>).detail;if(!detail)return;
      if(!validIdentity()||!draft){detail.outcome='unavailable';return;}
      if(disabled||lock.current||dirty||error||storageError||discard||composing||accessFor||fileFor||sourceImportRevision.current===draft.mutationId){detail.outcome='busy';return;}
      const result=importSourceTask(draft,detail.task);detail.outcome=result.outcome;
      if(result.outcome==='applied'){sourceImportRevision.current=draft.mutationId;edit({...draft,...result.board});}
    };
    element.addEventListener('agentopsdeck:source-task',receive);return()=>element.removeEventListener('agentopsdeck:source-task',receive);
  });
  return <section ref={sourceHost} className="workspace-taskboard" aria-label={t('Task board')} aria-busy={busy} data-board-ready={!!document && !busy && !dirty && !error}
    onContextMenuCapture={event => {
      if (!(event.target instanceof Element)) return;
      const status = taskboardContextStatus(event.target, event.currentTarget);
      if (!status) return;
      // The canvas has a native bubbling listener: capture before it, not in
      // React's root-level bubble phase. Selected text keeps browser copy.
      event.stopPropagation();
      const selection = window.getSelection();
      if (selection?.toString() && selection.containsNode(event.target, true)) { setCreationMenu(undefined); return; }
      event.preventDefault();
      setCreationMenu({ key: draftKey, x: event.clientX, y: event.clientY, status });
    }}
    onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onBlur={() => setComposing(false)}>
    <ResourceTitle><input name="workspacetaskboard-input-1" aria-label={t('Board title')} value={draft?.title ?? ''} maxLength={120} disabled={!draft || textDisabled} readOnly={busy} onChange={event => edit({ ...draft!, title: event.target.value })} /></ResourceTitle>
    <ResourceToolbar>
      <WorkspaceBoardPicker scope={scope} onOpen={onOpen} />
      <ResourceAction priority={70} label={t(hideDone ? 'Show completed tasks' : 'Hide completed tasks')} aria-pressed={hideDone} onClick={() => { taskDrag.cancel(); setHideDone(!hideDone); }}>
        {hideDone ? <EyeOff size={15} /> : <Eye size={15} />}
      </ResourceAction>
      <button type="button" data-caption-priority={30} title={t('Open status card')} aria-label={t('Open status card')} onClick={() => onOpen('statuscard', resourceId)}><ChartNoAxesCombined size={15} /></button>
      {!sharedFileSync && <button type="button" data-caption-priority={20} title={t('Link whole board')} aria-label={t('Link whole board')} onClick={() => setFileFor(current => current === draftKey ? undefined : draftKey)}><Link2 size={15} /></button>}
      {sharedFileSync && <ResourceAction priority={10} label={t('Advanced task permissions')} onClick={() => { setAccessSection(undefined); setAccessFor(current => current === draftKey ? undefined : draftKey); }}><Shield size={15} /></ResourceAction>}
      <button type="button" aria-label={t('Version history')} title={t('Version history')} disabled={!draft} onClick={() => setHistoryOpen(true)}><Clock3 size={15} /></button>
      <button type="button" aria-label={t('Refresh task board')} title={t('Refresh task board')} disabled={busy} onClick={reload}><RefreshCw size={15} /></button>
      <ResourceAction priority={100} label={t(error === 'uncertain' ? (fileBinding ? 'Check file save' : 'Retry same save') : 'Save')} disabled={busy || (!!fileBinding && !fileWritable) || error === 'load' || !dirty || !validBoardContent(draft) || error === 'conflict'} onClick={() => void save()}><Save size={15} /></ResourceAction>
    </ResourceToolbar>
    {fileFor === draftKey && scope === recoveryScope() && <Suspense fallback={<p role="status">{t('Loading…')}</p>}><WorkspaceFileBoardBinding key={draftKey} scope={scope} resourceId={resourceId}
      revision={document?.revision ?? 0} dirty={dirty || busy || !!error} onClose={() => setFileFor(undefined)}
      onChanged={binding => { setFileBinding(binding); if (!dirty) setGeneration(value => value + 1); }}
      onAdvanced={() => { setFileFor(undefined); setAccessSection('bind'); setAccessFor(draftKey); }} /></Suspense>}
    {fileBinding && (fileBinding.state !== 'active' || fileBinding.problem) && <p role="status">
      {t(fileBinding.problem ? 'File sync paused. The last valid board is retained.' : 'Binding outcome pending · inspect without resending')}</p>}
    {accessFor === draftKey && scope === recoveryScope() && <Suspense fallback={<p role="status">{t('Loading…')}</p>}><WorkspaceBoardAccess key={JSON.stringify([draftKey, accessSection ?? '', selectedTaskIds])} scope={scope} resourceId={resourceId} initialSelectedTaskIds={selectedTaskIds} initialSection={accessSection} onClose={() => { setAccessFor(undefined); setAccessSection(undefined); }} /></Suspense>}
    {((busy && (saving || !document)) || dirty) && <p className="workspace-board-status" role="status">{t(busy && (saving || !document) ? (saving ? 'Saving…' : 'Working…') : autosaveReady ? 'Changes save automatically after editing stops.' : 'Unsaved changes')}</p>}
    {storageError && <p role="alert">{t('Local draft storage unavailable. Keep this panel open until saved.')}</p>}
    {error && <p role="alert">{t(error === 'conflict' ? 'Board changed elsewhere. Your draft is preserved; copy it before discarding and reloading.' : error === 'uncertain' ? 'Save outcome unconfirmed. Retry the same save safely, or check by reloading.' : 'Unable to load task board. Retry refresh.')}</p>}
    {discard && <div className="workspace-board-confirm" role="group" aria-label={t('Discard local changes?')}><span>{t('Discard local changes?')}</span><button type="button" onClick={() => setDiscard(false)}>{t('Cancel')}</button><button type="button" onClick={() => {
      if (!validIdentity()) return;
      try { sessionStorage.removeItem(draftKey); } catch { setStorageError(true); return; }
      setDiscard(false); setGeneration(value => value + 1);
    }}>{t('Discard and reload')}</button></div>}
    {draft && <>
      {selectedTaskIds.length > 0 && <div className="workspace-board-selection-bar" role="region" aria-label={t('Selected tasks actions')}>
        <span>{t('Selected tasks: {count}', { count: selectedTaskIds.length })}</span>
        <button type="button" disabled={busy || dirty} onClick={() => { setAccessSection('create'); setAccessFor(draftKey); }}>{t('Create session for selected tasks')}</button>
        <button type="button" disabled={busy || dirty} onClick={() => { setAccessSection('bind'); setAccessFor(draftKey); }}>{t('Bind tasks to a session')}</button>
        <button type="button" onClick={() => setSelectedTaskIds([])}>{t('Clear selection')}</button>
      </div>}
      <div className="workspace-board-columns" style={{ '--board-column-count': hideDone ? 2 : 3 } as import('react').CSSProperties} data-task-dragging={taskDrag.feedback ? 'true' : undefined}>{BOARD_STATUSES.filter(status => !hideDone || status !== 'done').map(status => <section key={status} aria-label={t(labels[status])}
        data-board-column={status} data-drop-active={taskDrag.feedback?.target?.status === status ? 'true' : undefined}>
        <div className="workspace-board-column-heading" data-status={status}><h3>{t(labels[status])}<span>{draft.tasks.filter(task => task.status === status).length}</span></h3>
          <button className="workspace-board-add" type="button" aria-label={t('Add task')} title={t('Add task')} disabled={creationDisabled} onClick={() => addTask(status)}><Plus size={14} /></button>
        </div>
        {draft.tasks.filter(task => task.status === status).map(task => <article key={task.id} data-status={status} data-board-task={task.id}
          data-drag-source={taskDrag.feedback?.taskId === task.id ? 'true' : undefined}
          data-drop-before={taskDrag.feedback?.target?.beforeId === task.id ? 'true' : undefined}>
          <TaskCard title={task.title} detail={task.detail} metadata={<TaskMetadataSummary task={task} />} dragging={!!taskDrag.feedback} autoEdit={newTaskId === task.id} onAutoEdit={() => setNewTaskId(undefined)}
            actionsDisabled={disabled} {...(status === 'done' ? {} : { onComplete: () => { if (!disabled) edit({ ...draft, tasks: draft.tasks.map(item => item.id === task.id ? { ...item, status: 'done' as const } : item) }); } })} grip={
            <button className="workspace-board-task-grip" type="button" aria-label={t('Drag task to move or reorder')} title={t('Drag task to move or reorder')}
              disabled={disabled || error === 'conflict'} onPointerDown={event => taskDrag.start(event, task.id)} onPointerMove={taskDrag.move}
              onPointerUp={taskDrag.end} onPointerCancel={taskDrag.cancel} onLostPointerCapture={taskDrag.cancel} onDragStart={event => event.preventDefault()}><GripVertical size={15} /></button>}>
            <input name="workspacetaskboard-input-2" aria-label={t('Task title')} maxLength={240} value={task.title} disabled={textDisabled} readOnly={busy} onChange={event => edit({ ...draft, tasks: draft.tasks.map(item => item.id === task.id ? { ...item, title: event.target.value } : item) })} />
          <textarea name="workspacetaskboard-textarea-3" aria-label={t('Task details')} maxLength={4000} value={task.detail} rows={2} disabled={textDisabled} readOnly={busy} onChange={event => edit({ ...draft, tasks: draft.tasks.map(item => item.id === task.id ? { ...item, detail: event.target.value } : item) })} />
          <TaskMetadataEditor task={task} disabled={textDisabled} readOnly={busy} onChange={next => edit({ ...draft, tasks: draft.tasks.map(item => item.id === task.id ? next : item) })} />
          <footer>
            {document?.tasks.some(saved => saved.id === task.id) && <label className="workspace-board-task-select" title={t('Select task for session')}>
              <input type="checkbox" name={`workspacetaskboard-select-${task.id}`} aria-label={t('Select task for session')} checked={selectedTaskIds.includes(task.id)}
                onChange={event => setSelectedTaskIds(current => event.target.checked ? [...new Set([...current, task.id])] : current.filter(id => id !== task.id))} />
            </label>}
            <select name="workspacetaskboard-select-4" aria-label={t('Task status')} value={status} disabled={disabled} onChange={event => edit({ ...draft, tasks: draft.tasks.map(item => item.id === task.id ? { ...item, status: event.target.value as BoardStatus } : item) })}>{BOARD_STATUSES.map(value => <option key={value} value={value}>{t(labels[value])}</option>)}</select>
            {([-1, 1] as const).map(direction => { const peers = draft.tasks.filter(item => item.status === status), peer = peers[peers.indexOf(task) + direction]; return <button key={direction} type="button" aria-label={t(direction < 0 ? 'Move task up' : 'Move task down')} disabled={disabled || !peer} onClick={() => {
              const tasks = [...draft.tasks], a = tasks.indexOf(task), b = tasks.indexOf(peer!); [tasks[a], tasks[b]] = [tasks[b]!, tasks[a]!]; edit({ ...draft, tasks });
            }}>{direction < 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button>; })}
            <button type="button" aria-label={t('Remove task')} disabled={disabled} onClick={() => edit({ ...draft, tasks: draft.tasks.filter(item => item.id !== task.id) })}><Trash2 size={13} /></button>
          </footer>
          </TaskCard>
        </article>)}
        <div className="workspace-board-drop-end" data-drop-active={taskDrag.feedback?.target?.status === status && !taskDrag.feedback.target.beforeId ? 'true' : undefined} />
      </section>)}</div>
      {(limited || !validBoardContent(draft)) && <p role="alert">{t('Titles must not be empty. Board content is limited to 64,000 characters.')} {t('Tags must be unique, nonblank and trimmed (up to 8, 32 characters each). Use a valid due date.')}</p>}
    </>}
    {creationMenu?.key === draftKey && <WorkspaceContextMenu point={creationMenu} label="Task actions" close={() => setCreationMenu(undefined)}>
      <button type="button" role="menuitem" disabled={creationDisabled} onClick={() => { addTask(creationMenu.status); setCreationMenu(undefined); }}><Plus size={14} />{t('Add task')}</button>
    </WorkspaceContextMenu>}
    {historyOpen && draft ? (
      <Suspense fallback={null}>
        <CardVersionHistoryModal
          scope={scope}
          kind="taskboard"
          resourceId={resourceId}
          currentPayload={JSON.stringify({ title: draft.title, tasks: draft.tasks })}
          disabled={disabled}
          onRestore={(payload) => {
            try {
              const parsed = JSON.parse(payload) as { title?: string; tasks?: BoardWrite['tasks'] };
              if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.tasks)) {
                edit({ ...draft, title: parsed.title, tasks: parsed.tasks });
              }
            } catch {
              // Ignore malformed payload
            }
          }}
          onClose={() => setHistoryOpen(false)}
        />
      </Suspense>
    ) : null}
  </section>;
}
