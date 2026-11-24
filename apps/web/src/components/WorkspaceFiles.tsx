import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Save, FolderOpen, Film, Scan, ScanLine, FileInput, FileCode2, LockKeyhole, Check, LoaderCircle, FileWarning, ArrowLeft, ArrowRight, ArrowUp, Plus, Upload, Eye, Download, Pencil, Trash2, X, HardDrive } from 'lucide-react';
import { editText } from './ui/edit-text';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';
import { FileTextEditor } from './FileTextEditor';
import type { FileBrowserListResponse, FileBrowserPreviewResponse, MediaLibraryListResponse } from '@agentopsdeck/shared';
import { api, recoveryEpoch, subscribeRecoveryScope, type HubConnection } from '../api';
import { registerFileEditorGuard } from '../lib/file-editor-guard';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { useLinkedFile, type FileSelection, type SessionDirectory } from './WorkspaceFileLinks';
import { confirmAction } from './ui/confirm';
import { DirectoryCache, parentDirectory } from '../lib/directory-cache';
import { DirectoryModes, DirectoryView, type DirectoryEntry, type DirectoryMode } from './DirectoryView';

function useDirectory<T extends { entries: unknown[] }>(loader: (path: string, signal: AbortSignal) => Promise<T>, path: string, enabled: boolean, reload: number) {
  const cache = useMemo(() => new DirectoryCache<T>(), [loader, reload]);
  const [result, setResult] = useState<{ cache: typeof cache; path: string; data?: T; error?: string }>();
  const read = useCallback(async (at: string, signal: AbortSignal) => {
    const cached = cache.get(at);
    if (cached) return cached;
    const data = await loader(at, signal);
    if (!signal.aborted) cache.set(at, data);
    return data;
  }, [cache, loader]);
  const current = result?.cache === cache && result.path === path ? result : undefined;
  const data = enabled ? current?.data ?? cache.get(path) : undefined;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void read(path, controller.signal).then(value => { if (!controller.signal.aborted) setResult({ cache, path, data: value }); })
      .catch(e => { if (!controller.signal.aborted) setResult({ cache, path, error: String(e.message ?? e) }); });
    return () => controller.abort();
  }, [read, path, enabled, cache]);
  return { data, error: current?.error ?? '', busy: enabled && !data && !current?.error, read };
}

/** One-shot authorized reads only. No filesystem polling or hidden viewer loads. */
export function FilePicker({ onSelect, selection, sessionKey, directory, mode: suppliedMode, localToolbar = true }: { onSelect: (file: FileSelection) => void; selection?: FileSelection | undefined; sessionKey?: string | undefined; directory?: SessionDirectory | undefined; mode?: DirectoryMode; localToolbar?: boolean }) {
  const { t } = useI18n(), [connections, setConnections] = useState<HubConnection[]>([]), [connection, setConnection] = useState('');
  const [roots, setRoots] = useState<{ agentId: string; label: string }[]>([]), [agent, setAgent] = useState('');
  const [allRootsMap, setAllRootsMap] = useState<Record<string, { agentId: string; label: string }[]>>({});
  const [path, setPath] = useState(''), [error, setError] = useState(''), [reload, setReload] = useState(0), [metadataRetry, setMetadataRetry] = useState(0);
  const [ownMode, setMode] = useState<DirectoryMode>('list'), mode = suppliedMode ?? ownMode;
  const [epoch, setEpoch] = useState(recoveryEpoch);
  const followed = useRef<string | undefined>(undefined), following = useRef<AbortController | undefined>(undefined);
  const latestDirectory = useRef(directory); latestDirectory.current = directory;
  const [followRetry, setFollowRetry] = useState(0);
  const association = sessionKey ? `${epoch}:${sessionKey}` : undefined;
  const hasDirectory = !!directory;
  function manualNavigation() { followed.current = association; following.current?.abort(); }
  useEffect(() => {
    if (!association) { followed.current = undefined; return; }
    const target = latestDirectory.current;
    if (followed.current === association || !target) return;
    followed.current = association;
    const controller = new AbortController(); following.current = controller;
    void api.fileSourceDirectory({ type: 'agent', connectionId: target.connectionId, agentId: target.agentId }, target.sourcePath, controller.signal)
      .then(result => {
        if (controller.signal.aborted || epoch !== recoveryEpoch()) return;
        setConnection(target.connectionId); setAgent(target.agentId); setPath(result.path); setError('');
      }).catch(error => { if (!controller.signal.aborted && epoch === recoveryEpoch()) setError(String(error.message ?? error)); });
    return () => { controller.abort(); if (following.current === controller) following.current = undefined; };
  }, [association, hasDirectory, followRetry, epoch]);
  useEffect(() => subscribeRecoveryScope(() => { setEpoch(recoveryEpoch()); setConnections([]); setConnection(''); setRoots([]); setAgent(''); setPath(''); }), []);
  useEffect(() => {
    let alive = true;
    void api.hubConnections().then(result => {
      if (alive && epoch === recoveryEpoch()) {
        setConnections(result.connections);
        setConnection(old => old || result.connections[0]?.id || '');
        for (const conn of result.connections) {
          void api.connectorFileRoots(conn.id).then(r => {
            if (alive && epoch === recoveryEpoch()) {
              setAllRootsMap(prev => ({ ...prev, [conn.id]: r.roots }));
            }
          }).catch(() => { /* ignore offline connector root error */ });
        }
      }
    }).catch(e => { if (alive && epoch === recoveryEpoch()) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [epoch, metadataRetry]);
  useEffect(() => {
    if (selection?.type !== 'file' || selection.scope.type !== 'agent' || !selection.scope.connectionId) return;
    setConnection(selection.scope.connectionId); setAgent(selection.scope.agentId);
    setPath(parentDirectory(selection.path));
  }, [selection]);
  useEffect(() => {
    let alive = true; setRoots([]); setError('');
    if (connection) void api.connectorFileRoots(connection).then(result => { if (alive && epoch === recoveryEpoch()) { setRoots(result.roots); setAgent(old => result.roots.some(r => r.agentId === old) ? old : result.roots[0]?.agentId ?? ''); } })
      .catch(e => { if (alive && epoch === recoveryEpoch()) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [connection, epoch, metadataRetry]);
  const [filterText, setFilterText] = useState('');
  const [sortBy, setSortBy] = useState<'default' | 'name' | 'size' | 'kind'>('default');
  const [navHistory, setNavHistory] = useState<{ stack: string[]; index: number }>({ stack: [''], index: 0 });
  const [selectedEntryPath, setSelectedEntryPath] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorPreview, setInspectorPreview] = useState<FileBrowserPreviewResponse>();
  const [inspectorDraft, setInspectorDraft] = useState('');
  const [inspectorBusy, setInspectorBusy] = useState(false);
  const [inspectorSaving, setInspectorSaving] = useState(false);
  const [inspectorSaved, setInspectorSaved] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const navigateTo = useCallback((nextPath: string) => {
    manualNavigation();
    setPath(nextPath);
    setSelectedEntryPath(undefined);
    setNavHistory(prev => {
      const current = prev.stack[prev.index] ?? '';
      if (current === nextPath) return prev;
      const nextStack = [...prev.stack.slice(0, prev.index + 1), nextPath];
      return { stack: nextStack, index: nextStack.length - 1 };
    });
  }, [association]);

  const goBack = () => {
    if (navHistory.index <= 0) return;
    manualNavigation();
    const nextIndex = navHistory.index - 1;
    setNavHistory(prev => ({ ...prev, index: nextIndex }));
    setPath(navHistory.stack[nextIndex] ?? '');
  };

  const goForward = () => {
    if (navHistory.index >= navHistory.stack.length - 1) return;
    manualNavigation();
    const nextIndex = navHistory.index + 1;
    setNavHistory(prev => ({ ...prev, index: nextIndex }));
    setPath(navHistory.stack[nextIndex] ?? '');
  };

  const scope = useMemo(() => (connection && agent ? ({ type: 'agent' as const, connectionId: connection, agentId: agent }) : undefined), [connection, agent]);
  const loader = useCallback((at: string, signal: AbortSignal) => api.fileList({ type: 'agent', connectionId: connection, agentId: agent }, at, signal), [connection, agent, epoch]);
  const { data: listing, error: readError, busy, read } = useDirectory<FileBrowserListResponse>(loader, path, !!connection && roots.some(r => r.agentId === agent), reload);
  const convert = (value: FileBrowserListResponse) => value.entries.map(entry => ({ ...entry, disabled: entry.protected || (entry.kind === 'file' && !entry.canPreview) }));
  const load = useCallback(async (at: string, signal: AbortSignal) => convert(await read(at, signal)), [read]);

  const rawEntries = useMemo(() => (listing ? convert(listing) : []), [listing]);
  const filteredEntries = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const base = q ? rawEntries.filter(e => e.name.toLowerCase().includes(q)) : rawEntries;
    if (sortBy === 'default') return base;
    return [...base].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'size') return (b.size ?? 0) - (a.size ?? 0);
      const extA = a.name.split('.').pop() ?? '';
      const extB = b.name.split('.').pop() ?? '';
      return extA.localeCompare(extB) || a.name.localeCompare(b.name);
    });
  }, [rawEntries, filterText, sortBy]);

  const activeSelectedPath = selectedEntryPath ?? (selection?.type === 'file' && selection.scope.type === 'agent' && selection.scope.connectionId === connection && selection.scope.agentId === agent ? selection.path : undefined);
  const selectedEntry = useMemo(() => listing?.entries.find(e => e.path === activeSelectedPath), [listing, activeSelectedPath]);

  const loadInspectorPreview = useCallback(async (targetPath: string) => {
    if (!scope) return;
    setInspectorBusy(true);
    setInspectorPreview(undefined);
    setInspectorDraft('');
    setInspectorSaved(false);
    try {
      const res = await api.filePreview(scope, targetPath);
      setInspectorPreview(res);
      setInspectorDraft(res.text ?? '');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setInspectorBusy(false);
    }
  }, [scope]);

  const handleCreateNewFile = () => {
    if (!scope || actionBusy) return;
    editText({
      title: t('New file name'),
      initial: 'untitled.md',
      maxLength: 180,
      onSave: async (name) => {
        const clean = name.trim().replace(/^\/+/, '');
        if (!clean) return;
        const targetPath = path ? `${path}/${clean}` : clean;
        setActionBusy(true);
        setError('');
        try {
          await api.saveFileText(scope, targetPath, '', '');
          setReload(v => v + 1);
          setSelectedEntryPath(targetPath);
        } finally {
          setActionBusy(false);
        }
      },
    });
  };

  const handleUploadFiles = async (files: FileList | null) => {
    if (!scope || !files || files.length === 0 || actionBusy) return;
    setActionBusy(true);
    setError('');
    try {
      for (const file of Array.from(files)) {
        await api.uploadFile(scope, path, file);
      }
      setReload(v => v + 1);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setActionBusy(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const handleRenameSelected = () => {
    if (!scope || !selectedEntry || actionBusy) return;
    editText({
      title: t('Rename file or folder'),
      initial: selectedEntry.name,
      maxLength: 255,
      onSave: async (newName) => {
        if (!newName.trim() || newName.trim() === selectedEntry.name) return;
        setActionBusy(true);
        setError('');
        try {
          await api.renameFile(scope, selectedEntry.path, newName.trim());
          setReload(v => v + 1);
        } finally {
          setActionBusy(false);
        }
      },
    });
  };

  const handleDeleteSelected = async () => {
    if (!scope || !selectedEntry || actionBusy) return;
    if (!await confirmAction({
      title: t(selectedEntry.kind === 'directory' ? 'Delete folder?' : 'Delete file?'),
      confirmLabel: t('Delete'),
      description: t('“{name}” will be deleted. Only files and empty folders are allowed. This cannot be undone.', { name: selectedEntry.name }),
    })) return;
    setActionBusy(true);
    setError('');
    try {
      await api.deleteFile(scope, selectedEntry.path);
      if (inspectorPreview?.path === selectedEntry.path) setInspectorPreview(undefined);
      setSelectedEntryPath(undefined);
      setReload(v => v + 1);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadSelected = async () => {
    if (!scope || !selectedEntry || selectedEntry.kind === 'directory' || actionBusy) return;
    setActionBusy(true);
    setError('');
    try {
      const blob = await api.downloadFile(scope, selectedEntry.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedEntry.name || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveInspectorText = async () => {
    if (!scope || !inspectorPreview || inspectorPreview.kind !== 'text' || !inspectorPreview.canEdit || inspectorSaving) return;
    setInspectorSaving(true);
    setError('');
    try {
      const receipt = await api.saveFileText(scope, inspectorPreview.path, inspectorDraft, inspectorPreview.revision ?? '');
      setInspectorPreview({ ...inspectorPreview, revision: receipt.revision, text: inspectorDraft });
      setInspectorSaved(true);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setInspectorSaving(false);
    }
  };

  const folderCount = filteredEntries.filter(e => e.kind === 'directory').length;
  const fileCount = filteredEntries.length - folderCount;
  const inspectorDirty = inspectorPreview?.kind === 'text' && inspectorDraft !== inspectorPreview.text;

  return <><ResourceToolbar local={localToolbar}>
    <select name="workspacefiles-select-1" aria-label={t('Select Connector')} value={connection} onChange={e => { manualNavigation(); setConnection(e.target.value); setAgent(''); setPath(''); setNavHistory({ stack: [''], index: 0 }); }}><option value="">{t('Select Connector')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
    <select name="workspacefiles-select-2" aria-label={t('Workspace folder')} value={agent} onChange={e => { manualNavigation(); setAgent(e.target.value); setPath(''); setNavHistory({ stack: [''], index: 0 }); }}><option value="">{t('Workspace folder')}</option>{roots.map(r => <option key={r.agentId} value={r.agentId}>{r.label}</option>)}</select>
    {sessionKey ? <ResourceAction label={t('Open session’s latest changed directory')} disabled={!directory} onClick={() => { following.current?.abort(); followed.current = undefined; setFollowRetry(value => value + 1); }}><FolderOpen size={16}/></ResourceAction> : null}
    <button type="button" aria-label={t('Refresh')} title={t('Refresh')} disabled={busy} onClick={() => { setReload(v => v + 1); if (!connection || !roots.length || error) setMetadataRetry(v => v + 1); }}><RefreshCw size={16} /></button>
    {!suppliedMode && <DirectoryModes mode={mode} onChange={setMode}/>}
  </ResourceToolbar>
  {connections.length > 0 ? (
    <div className="workspace-files-drives-bar" role="region" aria-label={t('Connector drives')}>
      <span className="workspace-files-drives-label">
        <HardDrive size={13} />
        <span>{t('This PC · Drives')}</span>
      </span>
      <div className="workspace-files-drives-list">
        {connections.map((conn, idx) => {
          const driveLetter = `${String.fromCharCode(67 + (idx % 20))}:`;
          const isCurrentConn = connection === conn.id;
          const connRoots = isCurrentConn && roots.length ? roots : (allRootsMap[conn.id] ?? []);
          const activeRootLabel = isCurrentConn
            ? (roots.find(r => r.agentId === agent)?.label ?? connRoots[0]?.label ?? 'workspace')
            : (connRoots[0]?.label ?? 'workspace');
          const isOnline = conn.status === 'enabled' || !conn.status;
          return (
            <button
              key={conn.id}
              type="button"
              data-drive={driveLetter}
              data-active={isCurrentConn}
              className={`workspace-files-drive-card${isCurrentConn ? ' is-active' : ''}`}
              title={`${driveLetter} ${conn.label || conn.id} (${activeRootLabel})`}
              onClick={() => {
                manualNavigation();
                setConnection(conn.id);
                if (!isCurrentConn) {
                  const defaultAgent = connRoots[0]?.agentId ?? '';
                  setAgent(defaultAgent);
                }
                setPath('');
                setNavHistory({ stack: [''], index: 0 });
              }}
            >
              <span className="workspace-files-drive-icon">
                <HardDrive size={15} />
                <i className={`workspace-files-drive-dot${isOnline ? ' is-online' : ''}`} />
              </span>
              <span className="workspace-files-drive-meta">
                <strong>{driveLetter} {conn.label || conn.id}</strong>
                <small>{activeRootLabel}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  ) : null}
  <div className="workspace-files-location">
    <div className="workspace-files-nav-btns">
      <button type="button" className="workspace-files-nav-btn" title={t('Back')} aria-label={t('Back')} disabled={navHistory.index <= 0} onClick={goBack}><ArrowLeft size={13}/></button>
      <button type="button" className="workspace-files-nav-btn" title={t('Forward')} aria-label={t('Forward')} disabled={navHistory.index >= navHistory.stack.length - 1} onClick={goForward}><ArrowRight size={13}/></button>
      <button type="button" className="workspace-files-nav-btn" title={t('Up one level')} aria-label={t('Up one level')} disabled={!path} onClick={() => navigateTo(parentDirectory(path))}><ArrowUp size={13}/></button>
    </div>
    <div className="workspace-files-path" title={path || '/'}><FolderOpen size={14}/>{path || '/'}</div>
    <div className="workspace-files-win-tools">
      <input
        name="workspacefiles-filter-input"
        type="search"
        className="workspace-files-filter-input"
        placeholder={t('Search folder…')}
        aria-label={t('Search folder…')}
        value={filterText}
        onChange={e => setFilterText(e.target.value)}
      />
      <select
        name="workspacefiles-sort-select"
        aria-label={t('Sort files')}
        className="workspace-files-sort-select"
        value={sortBy}
        onChange={e => setSortBy(e.target.value as 'default' | 'name' | 'size' | 'kind')}
      >
        <option value="default">{t('Default sort')}</option>
        <option value="name">{t('Sort: Name')}</option>
        <option value="size">{t('Sort: Size')}</option>
        <option value="kind">{t('Sort: Type')}</option>
      </select>
      <input
        name="workspacefiles-upload-input"
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => void handleUploadFiles(e.currentTarget.files)}
      />
      <button type="button" className="workspace-files-cmd-btn" title={t('New file')} onClick={handleCreateNewFile} disabled={!scope || actionBusy}><Plus size={13}/><span>{t('New')}</span></button>
      <button type="button" className="workspace-files-cmd-btn" title={t('Upload file')} onClick={() => uploadInputRef.current?.click()} disabled={!scope || actionBusy}><Upload size={13}/><span>{t('Upload')}</span></button>
      {selectedEntry && selectedEntry.kind === 'file' ? (
        <button
          type="button"
          className={`workspace-files-cmd-btn${inspectorOpen ? ' is-active' : ''}`}
          title={t('Preview / Edit file')}
          onClick={() => {
            const next = !inspectorOpen;
            setInspectorOpen(next);
            if (next) void loadInspectorPreview(selectedEntry.path);
          }}
        >
          <Eye size={13}/><span>{t('Preview')}</span>
        </button>
      ) : null}
      {selectedEntry && selectedEntry.kind === 'file' ? (
        <button type="button" className="workspace-files-cmd-btn" title={t('Download')} onClick={() => void handleDownloadSelected()} disabled={actionBusy}><Download size={13}/></button>
      ) : null}
      {selectedEntry ? (
        <button type="button" className="workspace-files-cmd-btn" title={t('Rename')} onClick={handleRenameSelected} disabled={actionBusy}><Pencil size={13}/></button>
      ) : null}
      {selectedEntry ? (
        <button type="button" className="workspace-files-cmd-btn is-danger" title={t('Delete')} onClick={() => void handleDeleteSelected()} disabled={actionBusy}><Trash2 size={13}/></button>
      ) : null}
    </div>
  </div>
    {(error || readError) && <p role="alert">{error || readError}</p>}{busy && <p role="status">{t('Loading…')}</p>}
    <div className={`workspace-files-split-body${inspectorOpen ? ' has-inspector' : ''}`}>
      <DirectoryView key={`${connection}:${agent}:${epoch}:${reload}`} entries={filteredEntries} mode={mode} path={path} busy={busy} ready={!!listing} parent={() => navigateTo(parentDirectory(path))} load={load}
        selected={activeSelectedPath}
        open={entry => {
          manualNavigation();
          setSelectedEntryPath(entry.path);
          if (entry.kind === 'directory') navigateTo(entry.path);
          else {
            onSelect({ type: 'file', scope: { type: 'agent', connectionId: connection, agentId: agent }, path: entry.path, name: entry.name, ...(entry.mimeType ? { mimeType: entry.mimeType } : {}), ...(entry.size === undefined ? {} : { size: entry.size }) });
            if (inspectorOpen) void loadInspectorPreview(entry.path);
          }
        }}
        onDoubleClickEntry={entry => {
          if (entry.kind === 'file') {
            setSelectedEntryPath(entry.path);
            setInspectorOpen(true);
            void loadInspectorPreview(entry.path);
          }
        }}/>
      {inspectorOpen ? (
        <aside className="workspace-files-inspector-pane" aria-label={t('File preview and editor')}>
          <div className="workspace-files-inspector-head">
            <FileCode2 size={15}/>
            <div className="workspace-files-inspector-title">
              <strong>{inspectorPreview?.name ?? selectedEntry?.name ?? t('Select a file')}</strong>
              <small>{inspectorPreview?.path ?? selectedEntry?.path ?? ''}</small>
            </div>
            {inspectorPreview?.kind === 'text' && inspectorPreview.canEdit ? (
              <button
                type="button"
                className="workspace-files-cmd-btn is-primary"
                disabled={!inspectorDirty || inspectorSaving}
                onClick={() => void handleSaveInspectorText()}
              >
                <Save size={13}/><span>{inspectorSaving ? t('Saving…') : inspectorSaved && !inspectorDirty ? t('Saved') : t('Save')}</span>
              </button>
            ) : null}
            <button type="button" className="workspace-files-nav-btn" title={t('Close preview')} onClick={() => setInspectorOpen(false)}><X size={13}/></button>
          </div>
          <div className="workspace-files-inspector-body">
            {inspectorBusy ? <p role="status">{t('Loading…')}</p> : null}
            {!inspectorBusy && inspectorPreview?.kind === 'text' ? (
              <FileTextEditor
                value={inspectorDraft}
                readOnly={!inspectorPreview.canEdit || inspectorSaving}
                onChange={val => { setInspectorDraft(val); setInspectorSaved(false); }}
              />
            ) : null}
            {!inspectorBusy && inspectorPreview?.kind === 'image' && inspectorPreview.dataUrl ? (
              <div className="workspace-files-image"><img src={inspectorPreview.dataUrl} alt={inspectorPreview.name} /></div>
            ) : null}
            {!inspectorBusy && inspectorPreview && inspectorPreview.kind !== 'text' && inspectorPreview.kind !== 'image' ? (
              <div className="file-editor-empty" role="status">
                <FileWarning size={28}/>
                <p>{t(inspectorPreview.kind === 'too_large' ? 'File exceeds the preview size limit.' : 'This file type cannot be displayed in this viewer.')}</p>
              </div>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
    <footer className="workspace-files-statusbar">
      <span>{folderCount} {t('folders')} · {fileCount} {t('files')}</span>
      {selectedEntry ? (
        <span>
          {selectedEntry.name}
          {selectedEntry.size !== undefined ? ` (${selectedEntry.size < 1024 ? `${selectedEntry.size} B` : `${(selectedEntry.size / 1024).toFixed(1)} KB`})` : ''}
        </span>
      ) : (
        <span>{t('Double-click a file to preview & edit inline')}</span>
      )}
    </footer>
  </>;
}

function LibraryPicker({ onSelect, selection, mode }: { onSelect: (file: FileSelection) => void; selection?: FileSelection | undefined; mode: DirectoryMode }) {
  const { t } = useI18n(), [root, setRoot] = useState<string>(), [path, setPath] = useState('');
  const [reload, setReload] = useState(0), [roots, setRoots] = useState<MediaLibraryListResponse['roots']>([]);
  useEffect(() => { if (selection?.type === 'library') { setRoot(selection.root); setPath(parentDirectory(selection.path)); } }, [selection]);
  const loader = useCallback((at: string, signal: AbortSignal) => api.mediaLibrary(root, at, signal), [root]);
  const { data, error, busy, read } = useDirectory<MediaLibraryListResponse>(loader, path, true, reload);
  useEffect(() => { if (data) { setRoots(data.roots); if (!root && data.roots[0]) setRoot(data.roots[0].id); } }, [data, root]);
  const convert = (value: MediaLibraryListResponse): DirectoryEntry[] => value.entries.map(entry => ({ ...entry, disabled: entry.kind !== 'directory' && !entry.playable }));
  const load = useCallback(async (at: string, signal: AbortSignal) => convert(await read(at, signal)), [read]);
  return <><ResourceToolbar><select name="workspacefiles-select-3" aria-label={t('Media library')} value={root ?? ''} onChange={e => { setRoot(e.target.value); setPath(''); }}>{roots.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
    <ResourceAction label={t('Refresh')} disabled={busy} onClick={() => setReload(v => v + 1)}><RefreshCw size={16}/></ResourceAction></ResourceToolbar>
    <div className="workspace-files-path"><FolderOpen size={14}/>{path || '/'}</div>{error && <p role="alert">{error}</p>}{busy && <p role="status">{t('Loading…')}</p>}
    {data && !data.enabled && <p role="status">{t('Choose a folder to enable your private video library. Chat attachments and Connector workspaces remain available independently.')}</p>}
    <DirectoryView key={`${root}:${reload}`} entries={data ? convert(data) : []} {...{ mode, path, busy, load }} ready={!!data?.enabled} parent={() => setPath(parentDirectory(path))} selected={selection?.type === 'library' && selection.root === root ? selection.path : undefined} open={entry => {
      if (entry.kind === 'directory') setPath(entry.path); else if (root) onSelect({ type: 'library', root, path: entry.path, name: entry.name });
    }}/></>;
}

export default function WorkspaceFiles({ id, kind }: { id: string; kind: 'file-browser' | 'file-editor' | 'image-viewer' }) {
  const { t } = useI18n(), linked = useLinkedFile(id);
  const [selected, setSelected] = useState<Extract<FileSelection, { type: 'file' }>>(), [preview, setPreview] = useState<FileBrowserPreviewResponse>();
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const [picker, setPicker] = useState(false), [actual, setActual] = useState(false), [reload, setReload] = useState(0);
  const [epoch, setEpoch] = useState(recoveryEpoch), generation = useRef(0), pending = useRef(false);
  const [waiting, setWaiting] = useState<Extract<FileSelection, { type: 'file' }>>(), [source, setSource] = useState('workspace');
  const [mode, setMode] = useState<DirectoryMode>('list');
  const dirty = preview?.kind === 'text' && draft !== preview.text;
  const held = useRef({ dirty, saving, selected }); held.current = { dirty, saving, selected };
  function openSelection(file: Extract<FileSelection, { type: 'file' }>) {
    // Never render the previous document under a new path while its read is pending.
    ++generation.current; setPreview(undefined); setDraft(''); setBusy(true); setSaved(false);
    setSelected(file); setReload(v => v + 1); setPicker(false); setWaiting(undefined);
  }
  usePageRefreshGuard(() => !held.current.dirty && !pending.current);
  useEffect(() => registerFileEditorGuard(id, () => !held.current.dirty && !pending.current), [id]);
  useEffect(() => { if (linked.selection) setSource(linked.selection.type === 'library' ? 'library' : 'workspace'); }, [linked.selection]);
  useEffect(() => subscribeRecoveryScope(() => { ++generation.current; setEpoch(recoveryEpoch()); setSelected(undefined); setWaiting(undefined); setPreview(undefined); setDraft(''); setError(''); setPicker(false); setBusy(false); setSource('workspace'); }), []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (held.current.dirty || pending.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  useEffect(() => {
    const file = linked.selection;
    if (kind === 'file-browser' || !file || file.type !== 'file' || file === held.current.selected) return;
    if (kind === 'image-viewer' && !file.mimeType?.startsWith('image/')) return;
    if (kind === 'file-editor' && (file.mimeType?.startsWith('image/') || file.mimeType?.startsWith('video/') || file.mimeType?.startsWith('audio/'))) return;
    if (held.current.dirty || pending.current) { setWaiting(file); setError(t('Unsaved draft kept. Save or discard before opening the linked file.')); return; }
    openSelection(file);
  }, [linked.selection, kind]);
  useEffect(() => {
    if (!selected) return;
    const request = ++generation.current, account = recoveryEpoch();
    const current = () => request === generation.current && account === recoveryEpoch();
    setBusy(true); setError(''); setPreview(undefined); setDraft(''); setSaved(false); setActual(false);
    void api.filePreview(selected.scope, selected.path).then(value => { if (current()) { setPreview(value); setDraft(value.text ?? ''); } })
      .catch(e => { if (current()) setError(String(e.message ?? e)); }).finally(() => { if (current()) setBusy(false); });
    return () => { ++generation.current; };
  }, [selected, reload, epoch]);
  async function discardAnd(action: () => void) {
    if (pending.current) return;
    const account = recoveryEpoch();
    if (held.current.dirty && !await confirmAction({ title: t('Discard unsaved file changes?'), description: t('Discard changes'), confirmLabel: t('Discard changes') })) return;
    if (account !== recoveryEpoch() || pending.current) return;
    action();
  }
  async function save() {
    if (pending.current || !selected || !preview?.revision || !preview.canEdit || !dirty) return;
    pending.current = true; setSaving(true); setError('');
    const request = generation.current, account = recoveryEpoch(), text = draft;
    try {
      const receipt = await api.saveFileText(selected.scope, selected.path, text, preview.revision);
      if (request === generation.current && account === recoveryEpoch()) { setPreview({ ...preview, revision: receipt.revision, text }); setSaved(true); }
    } catch (e) { if (request === generation.current && account === recoveryEpoch()) setError(`${String((e as Error).message ?? e)} · ${t('Draft kept. A failed or uncertain save is never resent automatically.')}`); }
    finally { pending.current = false; setSaving(false); }
  }
  if (kind === 'file-browser') return <section className="workspace-files workspace-file-browser" aria-label={t('File browser')} key={epoch}>
    <ResourceToolbar><div className="workspace-files-sources" role="group" aria-label={t('File source')}><ResourceAction label={t('Workspace folder')} onClick={() => setSource('workspace')} aria-pressed={source === 'workspace'}><FolderOpen size={16}/></ResourceAction><ResourceAction label={t('Media library')} onClick={() => setSource('library')} aria-pressed={source === 'library'}><Film size={16}/></ResourceAction></div><DirectoryModes mode={mode} onChange={setMode}/></ResourceToolbar>
    {source === 'library' ? <LibraryPicker onSelect={linked.publish} selection={linked.selection} mode={mode}/> : <FilePicker localToolbar={false} onSelect={linked.publish} selection={linked.selection} sessionKey={linked.sessionKey} directory={linked.directory} mode={mode}/>}</section>;
  return <section className={`workspace-files ${kind === 'file-editor' ? 'workspace-file-editor' : ''}`} aria-label={t(kind === 'file-editor' ? 'File viewer / editor' : 'Image viewer')}>
    <ResourceToolbar>
      <ResourceAction label={t('Open file')} disabled={saving} onClick={() => void discardAnd(() => { setDraft(preview?.text ?? ''); setPicker(v => !v); })}><FolderOpen size={15} /></ResourceAction>
      <ResourceAction label={t('Refresh')} disabled={!selected || busy || saving} onClick={() => void discardAnd(() => setReload(v => v + 1))}><RefreshCw size={15} /></ResourceAction>
      {kind === 'file-editor' && <ResourceAction label={t('Save')} disabled={!dirty || !preview?.canEdit || saving || busy} onClick={() => void save()}><Save size={15} /></ResourceAction>}
      {kind === 'image-viewer' && <ResourceAction label={actual ? t('Fit image') : '1:1'} onClick={() => setActual(v => !v)}>{actual ? <Scan size={15}/> : <ScanLine size={15}/>}</ResourceAction>}
      {waiting && <ResourceAction label={t('Open pending file')} disabled={saving} onClick={() => void discardAnd(() => openSelection(waiting))}><FileInput size={15}/></ResourceAction>}
      {kind === 'file-editor' && preview?.kind === 'text' && !preview.canEdit && <span className="file-editor-readonly" tabIndex={0} role="img" aria-label={t('Read only. Editing requires files:write on this Connector.')} title={t('Read only. Editing requires files:write on this Connector.')}><LockKeyhole size={15}/></span>}
    </ResourceToolbar>
    {selected && <div className="file-editor-location" title={selected.path}><FileCode2 size={16}/><span><strong>{selected.path.split('/').pop()}</strong><small>{selected.path.includes('/') ? selected.path.slice(0, selected.path.lastIndexOf('/')) : '/'}</small></span>{dirty && <i aria-label={t('Unsaved changes')} title={t('Unsaved changes')}/>}<span className="file-editor-state" role="status">{busy || saving ? <LoaderCircle size={14} aria-label={t('Loading…')}/> : saved && !dirty ? <Check size={14} aria-label={t('Saved')}/> : null}</span></div>}
    {error && <p role="alert">{error}</p>}
    {picker ? <FilePicker onSelect={file => { if (file.type === 'file') { openSelection(file); linked.publish(file); } }} /> : null}
    {!picker && !selected && <div className="file-editor-empty" role="status"><FileCode2 size={32}/><p>{t('Open a file or select it in a linked browser card.')}</p></div>}
    {!picker && kind === 'file-editor' && preview?.kind === 'text' && <FileTextEditor value={draft} readOnly={!preview.canEdit || saving} onChange={value => { setDraft(value); setSaved(false); }} />}
    {!picker && kind === 'image-viewer' && preview?.kind === 'image' && preview.dataUrl && <div className="workspace-files-image" data-actual={actual}><img src={preview.dataUrl} alt={preview.name} /></div>}
    {!picker && preview && ((kind === 'file-editor' && preview.kind !== 'text') || (kind === 'image-viewer' && preview.kind !== 'image')) && <div className="file-editor-empty" role="status"><FileWarning size={32}/><p>{t(preview.kind === 'too_large' ? 'File exceeds the preview size limit.' : 'This file type cannot be displayed in this viewer.')}</p>{preview.kind === 'too_large' && preview.maxPreviewBytes && <small>{t('{value} KiB', { value: `${Math.round(preview.size / 1024)} / ${Math.round(preview.maxPreviewBytes / 1024)}` })}</small>}</div>}
  </section>;
}
