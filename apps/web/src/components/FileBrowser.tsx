import { useI18n, translate } from '../lib/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, File as FileIcon, FileText, Folder, FolderOpen, Image as ImageIcon, Lock, Pencil, RefreshCcw, Trash2, Upload } from 'lucide-react';
import type { FileBrowserEntry, FileBrowserListResponse, FileBrowserPreviewResponse } from '@agentopsdeck/shared';
import { api, mediaUrl, recoveryEpoch, type FileRequestScope } from '../api';
import { cn } from '../lib/cn';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { confirmAction } from './ui/confirm';
import { editText } from './ui/edit-text';
import { isMarkdownFile, MarkdownFile } from './MarkdownFile';

export type BrowserScope = FileRequestScope;

export function validPdfPreview(value: unknown, scope: BrowserScope, path: string): value is FileBrowserPreviewResponse {
  if (!value || typeof value !== 'object') return false;
  const preview = value as FileBrowserPreviewResponse;
  if (preview.kind !== 'pdf' || preview.path !== path || typeof preview.name !== 'string'
    || !Number.isSafeInteger(preview.size) || preview.size < 5 || preview.size > 32 * 1024 * 1024
    || preview.mimeType?.toLowerCase() !== 'application/pdf' || typeof preview.downloadUrl !== 'string') return false;
  try {
    const expected = new URL(api.fileDownloadUrl(scope, path, true), window.location.href);
    const actual = new URL(mediaUrl(preview.downloadUrl), window.location.href);
    return ['http:', 'https:'].includes(actual.protocol) && !actual.username && !actual.password
      && actual.origin === expected.origin && actual.pathname === expected.pathname && !actual.hash
      && actual.searchParams.get('path') === path
      && [...actual.searchParams.keys()].every(key => key === 'path' || key === 'inline')
      && actual.searchParams.getAll('path').length === 1 && actual.searchParams.getAll('inline').length <= 1
      && (!actual.searchParams.has('inline') || actual.searchParams.get('inline') === '1');
  } catch { return false; }
}

export async function verifiedPdfBlob(blob: Blob): Promise<boolean> {
  return blob.type === 'application/pdf' && blob.size >= 5 && blob.size <= 32 * 1024 * 1024
    && await blob.slice(0, 5).text() === '%PDF-';
}

export function FileBrowser({
  title,
  description,
  mode,
  agentIds = [],
  initialAgentId,
  hideAgentSelector = false,
  connectionId,
}: {
  title: string;
  description: string;
  mode: 'gateway' | 'agent';
  agentIds?: string[];
  initialAgentId?: string | undefined;
  hideAgentSelector?: boolean;
  connectionId?: string | undefined;
}) {
  const { t: tr, locale } = useI18n();
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId || agentIds[0] || '');
  const scope = useMemo<BrowserScope | undefined>(() => {
    if (mode === 'gateway') return { type: 'gateway' };
    return selectedAgentId ? { type: 'agent', agentId: selectedAgentId, ...(connectionId ? { connectionId } : {}) } : undefined;
  }, [mode, selectedAgentId, connectionId]);
  const [path, setPath] = useState('');
  const [list, setList] = useState<FileBrowserListResponse>();
  const [preview, setPreview] = useState<FileBrowserPreviewResponse>();
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string>();
  const [error, setError] = useState<string>();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const previewVersion = useRef(0);
  const downloadVersion = useRef(0);
  const active = useRef(true);
  const writePending = useRef(false);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  useEffect(() => {
    if (initialAgentId) setSelectedAgentId(initialAgentId);
  }, [initialAgentId]);
  useEffect(() => {
    if (!agentIds.includes(selectedAgentId)) setSelectedAgentId(agentIds[0] ?? '');
  }, [agentIds, selectedAgentId]);
  useEffect(() => {
    active.current = true;
    const expire = () => {
      active.current = false;
      ++readVersion.current; ++previewVersion.current; ++downloadVersion.current;
      setList(undefined); setPreview(undefined); setBusyPath(undefined); setLoading(false);
    };
    window.addEventListener('agentopsdeck:auth-required', expire);
    return () => { active.current = false; window.removeEventListener('agentopsdeck:auth-required', expire); };
  }, []);

  const snapshot = () => ({ scope, version: readVersion.current, account: recoveryEpoch() });
  const isCurrent = (view: ReturnType<typeof snapshot>) => active.current && view.scope === currentScope.current
    && view.version === readVersion.current && view.account === recoveryEpoch();

  const load = useCallback(async (nextPath: string, nextScope = scope) => {
    if (!active.current || !nextScope || nextScope !== currentScope.current) return;
    const version = ++readVersion.current;
    const account = recoveryEpoch();
    const current = () => active.current && version === readVersion.current && nextScope === currentScope.current && account === recoveryEpoch();
    ++previewVersion.current;
    ++downloadVersion.current;
    setLoading(true);
    setPreview(undefined); setBusyPath(undefined);
    setError(undefined);
    try {
      const data = await api.fileList(nextScope, nextPath);
      if (!current()) return;
      setList(data);
      setPath(data.path);
      setPreview(undefined);
    } catch (loadError) {
      if (!current()) return;
      setList(undefined);
      setPreview(undefined);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (current()) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setPath('');
    setList(undefined); setPreview(undefined); setBusyPath(undefined);
    void load('', scope);
    return () => { ++readVersion.current; ++previewVersion.current; ++downloadVersion.current; };
  }, [scope, load]);

  const currentScopeLabel = scope?.type === 'agent' ? scope.agentId : 'gateway';
  const eyebrowLabel = mode === 'agent' && hideAgentSelector ? tr('Files') : `${tr('Files')} · ${currentScopeLabel}`;
  const canShowAgentSelector = mode === 'agent' && !hideAgentSelector && agentIds.length > 1;
  const canUploadHere = Boolean(!connectionId && scope && (list?.path === path) && !loading);

  async function openEntry(entry: FileBrowserEntry) {
    if (entry.kind === 'directory') {
      await load(entry.path);
      return;
    }
    if (!scope || !entry.canPreview || !active.current) return;
    const view = snapshot();
    const version = ++previewVersion.current;
    setBusyPath(entry.path);
    setError(undefined);
    try {
      const result = await api.filePreview(scope, entry.path);
      if (result?.kind === 'pdf' && !validPdfPreview(result, scope, entry.path)) throw new Error(tr('PDF preview unavailable. Use download to inspect this file.'));
      if (version === previewVersion.current && isCurrent(view)) setPreview(result);
    } catch (previewError) {
      if (version !== previewVersion.current || !isCurrent(view)) return;
      setPreview(undefined);
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      if (version === previewVersion.current && isCurrent(view)) setBusyPath(undefined);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!scope || connectionId || !files || files.length === 0 || writePending.current || !active.current) return;
    const view = snapshot();
    writePending.current = true;
    setBusyPath('__upload__');
    setError(undefined);
    try {
      for (const file of Array.from(files)) {
        if (!isCurrent(view)) return;
        await api.uploadFile(scope, path, file);
      }
      if (isCurrent(view)) await load(path);
    } catch (uploadError) {
      if (isCurrent(view)) setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      writePending.current = false;
      if (isCurrent(view)) setBusyPath(undefined);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  }

  async function renameEntry(entry: FileBrowserEntry) {
    if (!scope || connectionId || !entry.canRename || writePending.current || !active.current) return;
    const view = snapshot();
    editText({ title: tr('Rename file or folder'), initial: entry.name, maxLength: 255, onSave: async name => {
      if (!isCurrent(view)) throw new Error(tr('The workspace changed. Close this dialog and try again.'));
      if (writePending.current) throw new Error(tr('Another file operation is in progress.'));
      if (name === entry.name) return;
      writePending.current = true; setBusyPath(entry.path); setError(undefined);
      try {
        await api.renameFile(scope, entry.path, name);
        if (isCurrent(view)) await load(path);
      } finally {
        writePending.current = false;
        if (isCurrent(view)) setBusyPath(undefined);
      }
    } });
  }

  async function deleteEntry(entry: FileBrowserEntry) {
    if (!scope || connectionId || !entry.canDelete || writePending.current || !active.current) return;
    const view = snapshot();
    writePending.current = true;
    try {
      if (!await confirmAction({ title: tr(entry.kind === 'directory' ? 'Delete folder?' : 'Delete file?'), confirmLabel: tr('Delete'),
        description: tr('“{name}” will be deleted. Only files and empty folders are allowed. This cannot be undone.', { name: entry.name }) }) || !isCurrent(view)) return;
      setBusyPath(entry.path); setError(undefined);
      await api.deleteFile(scope, entry.path);
      if (!isCurrent(view)) return;
      if (preview?.path === entry.path) setPreview(undefined);
      await load(path);
    } catch (deleteError) {
      if (isCurrent(view)) setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      writePending.current = false;
      if (isCurrent(view)) setBusyPath(undefined);
    }
  }

  async function downloadPath(filePath: string, filename: string) {
    if (!scope || !active.current) return;
    const view = snapshot(), version = ++downloadVersion.current;
    setBusyPath(filePath);
    setError(undefined);
    try {
      const blob = await api.downloadFile(scope, filePath);
      if (!isCurrent(view) || version !== downloadVersion.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || 'download';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (downloadError) {
      if (isCurrent(view) && version === downloadVersion.current) setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      if (isCurrent(view) && version === downloadVersion.current) setBusyPath(undefined);
    }
  }

  function downloadEntry(entry: FileBrowserEntry) {
    if (!scope || !entry.canDownload) return;
    void downloadPath(entry.path, entry.name);
  }

  if (mode === 'agent' && agentIds.length === 0) {
    return <Card className="border-white/70 bg-white/70 p-5">
      <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600">{tr("Files")}</p>
      <h3 className="mt-1 text-lg font-black tracking-[-0.03em] text-slate-950">{title}</h3>
      <p className="mt-2 text-sm text-slate-500">{tr("No agent workspaces are available yet.")}</p>
    </Card>;
  }

  return <Card className="overflow-hidden border-white/70 bg-white/72 p-0 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/70 p-4">
      <div className="min-w-0">
        <p className="text-[0.68rem] font-black uppercase tracking-[0.18em] text-blue-600">{eyebrowLabel}</p>
        <h3 className="mt-1 text-lg font-black tracking-[-0.03em] text-slate-950">{title}</h3>
        <p className="mt-1 text-xs font-semibold text-slate-500">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canShowAgentSelector ? <select name="filebrowser-select-1"
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700"
          value={selectedAgentId}
          onChange={(event) => setSelectedAgentId(event.currentTarget.value)}
          aria-label={tr("Select agent workspace")}
        >
          {agentIds.map((agentId) => <option key={agentId} value={agentId}>{agentId}</option>)}
        </select> : null}
        <input name="filebrowser-input-2" ref={uploadInputRef} className="hidden" type="file" multiple onChange={(event) => void uploadFiles(event.currentTarget.files)} />
        {!connectionId && <Button type="button" variant="secondary" className="h-9 rounded-xl px-3 text-xs font-bold" disabled={!canUploadHere || busyPath === '__upload__'} onClick={() => uploadInputRef.current?.click()}><Upload size={14} /> {tr(busyPath === '__upload__' ? 'Uploading…' : 'Upload')}</Button>}
        <Button type="button" variant="secondary" className="h-9 rounded-xl px-3 text-xs font-bold" disabled={!scope || loading} onClick={() => void load(path)}><RefreshCcw size={14} /> {tr("Refresh")}</Button>
      </div>
    </div>

    <div className="grid gap-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
      <section className="min-w-0 border-b border-slate-200/70 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-bold text-slate-500">
          <button type="button" className="rounded-lg bg-slate-100 px-2 py-1 text-slate-700" onClick={() => void load('')}>{tr("root")}</button>
          {pathSegments(path).map((segment) => <button key={segment.path} type="button" className="rounded-lg bg-slate-100 px-2 py-1 text-slate-700" onClick={() => void load(segment.path)}>{segment.name}</button>)}
        </div>
        {error ? <p className="mb-3 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{translate(error)}</p> : null}
        {list?.hiddenCount ? <p className="mb-3 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{tr(list.hiddenCount === 1 ? '{count} sensitive item hidden.' : '{count} sensitive items hidden.', { count: list.hiddenCount })}</p> : null}
        {loading ? <div className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">{tr("Loading files…")}</div> : null}
        {!loading && list?.entries.length === 0 ? <div className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">{tr("This folder is empty.")}</div> : null}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white/70">
          {path ? <button type="button" className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left text-sm font-bold text-slate-600 hover:bg-slate-50" onClick={() => void load(parentPath(path))}><FolderOpen size={17} /> ..</button> : null}
          {list?.entries.map((entry) => <div key={entry.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-slate-100 px-3 py-2.5 last:border-b-0 hover:bg-slate-50/80">
            <button type="button" className="min-w-0 text-left" onClick={() => void openEntry(entry)} disabled={entry.protected || busyPath === entry.path}>
              <span className="flex min-w-0 items-center gap-2">
                {entry.protected ? <Lock className="shrink-0 text-amber-500" size={16} /> : entry.kind === 'directory' ? <Folder className="shrink-0 text-blue-500" size={16} /> : iconForEntry(entry)}
                <span className="truncate text-sm font-black text-slate-800">{entry.name}</span>
                {entry.protected ? <Badge variant="accent" className="px-1.5 py-0 text-[0.58rem]">{tr("locked")}</Badge> : null}
              </span>
              <span className="mt-0.5 block truncate pl-6 text-[0.68rem] font-semibold text-slate-500">{entry.kind === 'directory' ? tr('folder') : `${formatBytes(entry.size ?? 0)} · ${entry.mimeType ?? tr('file')}`} · {formatDate(entry.modifiedAt, locale)}</span>
            </button>
            <div className="flex items-center gap-1">
              {entry.kind === 'file' ? <IconButton label={tr('Download')} disabled={!entry.canDownload || busyPath === entry.path} onClick={() => downloadEntry(entry)}><Download size={14} /></IconButton> : null}
              {!connectionId && <IconButton label={tr('Rename')} disabled={!entry.canRename || busyPath === entry.path} onClick={() => void renameEntry(entry)}><Pencil size={14} /></IconButton>}
              {!connectionId && <IconButton label={tr('Delete')} disabled={!entry.canDelete || busyPath === entry.path} destructive onClick={() => void deleteEntry(entry)}><Trash2 size={14} /></IconButton>}
            </div>
          </div>)}
        </div>
      </section>

      <section className="min-w-0 p-4">
        <p className="mb-2 text-[0.68rem] font-black uppercase tracking-[0.16em] text-slate-400">{tr("Preview")}</p>
        {preview ? <PreviewPanel preview={preview} scope={scope} onDownload={(filePath, filename) => void downloadPath(filePath, filename)} downloading={busyPath === preview.path} /> : <div className="grid min-h-52 place-items-center rounded-3xl border border-dashed border-slate-200 bg-slate-50/70 p-6 text-center text-sm font-semibold text-slate-500">
          {tr("Select a file to preview text, Markdown, JSON, logs, images, or PDFs. Large/binary files stay as metadata + download.")}</div>}
      </section>
    </div>
  </Card>;
}

function PreviewPanel({ preview, scope, onDownload, downloading }: { preview: FileBrowserPreviewResponse; scope: BrowserScope | undefined; onDownload?: (path: string, filename: string) => void; downloading?: boolean }) {
  const { t: tr } = useI18n();
  const [pdf, setPdf] = useState<{ preview: FileBrowserPreviewResponse; scope: BrowserScope; epoch: number; url: string }>();
  const [pdfError, setPdfError] = useState(false);
  const epoch = recoveryEpoch();
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    setPdf(undefined); setPdfError(false);
    const clear = () => { controller.abort(); if (url) { URL.revokeObjectURL(url); url = ''; } setPdf(undefined); };
    if (preview.kind === 'pdf') {
      if (!scope || !validPdfPreview(preview, scope, preview.path)) setPdfError(true);
      else void api.downloadFile(scope, preview.path, controller.signal).then(async blob => {
        if (controller.signal.aborted || recoveryEpoch() !== epoch) return;
        if (!await verifiedPdfBlob(blob)) throw new Error('Invalid PDF');
        if (controller.signal.aborted || recoveryEpoch() !== epoch) return;
        url = URL.createObjectURL(blob); setPdf({ preview, scope, epoch, url });
      }).catch(() => { if (!controller.signal.aborted && recoveryEpoch() === epoch) setPdfError(true); });
    }
    window.addEventListener('agentopsdeck:auth-required', clear);
    return () => { clear(); window.removeEventListener('agentopsdeck:auth-required', clear); };
  }, [preview, scope, epoch]);
  const download = scope ? api.fileDownloadUrl(scope, preview.path) : preview.downloadUrl ? mediaUrl(preview.downloadUrl) : undefined;
  return <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white/80">
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <strong className="block truncate text-sm font-black text-slate-900">{preview.name}</strong>
        <span className="text-xs font-semibold text-slate-500">{formatBytes(preview.size)} · {preview.mimeType ?? tr('file')}</span>
      </div>
      {scope && onDownload ? <button type="button" className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-700 disabled:opacity-50" disabled={downloading} onClick={() => onDownload(preview.path, preview.name)}>{tr(downloading ? 'Downloading…' : 'Download')}</button> : download ? <a className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-700" href={download} target="_blank" rel="noreferrer">{tr("Download")}</a> : null}
    </div>
    {preview.kind === 'text' ? isMarkdownFile(preview.name) ? <MarkdownFile key={preview.path} text={preview.text ?? ''} /> : <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap p-4 text-xs leading-5 text-slate-800">{preview.text}</pre> : null}
    {preview.kind === 'image' && preview.dataUrl ? <img className="max-h-[34rem] w-full object-contain bg-slate-950/5" src={preview.dataUrl} alt={preview.name} /> : null}
    {preview.kind === 'pdf' ? pdf && pdf.preview === preview && pdf.scope === scope && pdf.epoch === epoch
      ? <iframe className="h-[34rem] w-full bg-slate-50" title={preview.name} src={pdf.url} sandbox="" referrerPolicy="no-referrer" />
      : <p role="status" className="p-5 text-sm text-slate-600">{tr(pdfError ? 'PDF preview unavailable. Use download to inspect this file.' : 'Verifying PDF preview…')}</p> : null}
    {preview.kind === 'binary' || preview.kind === 'too_large' ? <div className="p-5 text-sm font-semibold text-slate-600">
      {preview.kind === 'too_large' ? tr('Preview capped at {size}. Use download to inspect this file.', { size: formatBytes(preview.maxPreviewBytes ?? 0) }) : tr('Binary preview is not available. Use download to inspect this file.')}
    </div> : null}
  </div>;
}

function IconButton({ label, disabled, destructive, onClick, children }: { label: string; disabled?: boolean; destructive?: boolean; onClick: () => void; children: ReactNode }) {
  return <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    className={cn('grid h-8 w-8 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-35', destructive && 'hover:bg-red-50 hover:text-red-600')}
    onClick={onClick}
  >{children}</button>;
}

function iconForEntry(entry: FileBrowserEntry) {
  if (entry.mimeType?.startsWith('image/')) return <ImageIcon className="shrink-0 text-emerald-500" size={16} />;
  if (entry.mimeType?.startsWith('text/') || entry.mimeType === 'application/json') return <FileText className="shrink-0 text-slate-500" size={16} />;
  return <FileIcon className="shrink-0 text-slate-500" size={16} />;
}

function pathSegments(value: string) {
  const parts = value.split('/').filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

function parentPath(value: string) {
  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDate(value: number, locale: string) {
  return new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
