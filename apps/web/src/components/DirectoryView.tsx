import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, File, FileText, FileCode2, Image, Film, Music2, List, LayoutGrid, ListTree } from 'lucide-react';
import { useI18n } from '../lib/i18n';

export type DirectoryMode = 'list' | 'tree' | 'explorer';
export type DirectoryEntry = { name: string; path: string; kind: string; size?: number; mimeType?: string; disabled?: boolean };
export function DirectoryModes({ mode, onChange }: { mode: DirectoryMode; onChange: (mode: DirectoryMode) => void }) {
  const { t } = useI18n();
  return <div className="workspace-files-modes" role="group" aria-label={t('View mode')}>
    {([['tree', ListTree, 'Tree view'], ['list', List, 'List view'], ['explorer', LayoutGrid, 'Explorer view']] as const).map(([value, Icon, label]) =>
      <button key={value} type="button" aria-label={t(label)} title={t(label)} aria-pressed={mode === value} onClick={() => onChange(value)}><Icon size={16}/></button>)}
  </div>;
}

export function DirectoryView({ entries, mode, path, parent, open, onDoubleClickEntry, selected, load, busy = false, ready = true }: {
  entries: DirectoryEntry[]; mode: DirectoryMode; path: string; parent: () => void;
  open: (entry: DirectoryEntry) => void; onDoubleClickEntry?: ((entry: DirectoryEntry) => void) | undefined; selected?: string | undefined;
  load: (path: string, signal: AbortSignal) => Promise<DirectoryEntry[]>; busy?: boolean; ready?: boolean;
}) {
  const { t } = useI18n();
  return <div className={`workspace-files-list workspace-files-${mode}`} aria-busy={busy}>
    {path && <button className="workspace-files-parent" type="button" aria-label={t('Parent folder')} title={t('Parent folder')} onClick={parent}><FolderOpen size={19}/><span>…</span></button>}
    <DirectoryRows key={`${path}:${mode}`} {...{ entries, mode, open, onDoubleClickEntry, selected, load }} depth={0}/>
    {ready && !busy && entries.length === 0 && <p role="status">{t('This folder is empty.')}</p>}
  </div>;
}

function DirectoryRows({ entries, mode, open, onDoubleClickEntry, selected, load, depth }: {
  entries: DirectoryEntry[]; mode: DirectoryMode; open: (entry: DirectoryEntry) => void;
  onDoubleClickEntry?: ((entry: DirectoryEntry) => void) | undefined;
  selected?: string | undefined; load: (path: string, signal: AbortSignal) => Promise<DirectoryEntry[]>; depth: number;
}) {
  const { t } = useI18n(), [limit, setLimit] = useState(200);
  return <>{entries.slice(0, limit).map(entry => <DirectoryRow key={entry.path} {...{ entry, mode, open, onDoubleClickEntry, selected, load, depth }}/>) }
    {entries.length > limit && <button type="button" className="workspace-files-more" onClick={() => setLimit(n => n + 200)}>{t('Show more')} ({entries.length - limit})</button>}</>;
}

function DirectoryRow({ entry, mode, open, onDoubleClickEntry, selected, load, depth }: {
  entry: DirectoryEntry; mode: DirectoryMode; open: (entry: DirectoryEntry) => void;
  onDoubleClickEntry?: ((entry: DirectoryEntry) => void) | undefined;
  selected?: string | undefined; load: (path: string, signal: AbortSignal) => Promise<DirectoryEntry[]>; depth: number;
}) {
  const { t } = useI18n(), [expanded, setExpanded] = useState(false), [children, setChildren] = useState<DirectoryEntry[]>(), [error, setError] = useState('');
  const folder = entry.kind === 'directory';
  const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
  const Icon = folder ? (expanded ? FolderOpen : Folder)
    : entry.mimeType?.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|avif)$/.test(extension) ? Image
    : entry.mimeType?.startsWith('video/') || /^(mp4|webm|mov|mkv)$/.test(extension) ? Film
    : entry.mimeType?.startsWith('audio/') || /^(mp3|wav|ogg|flac|m4a)$/.test(extension) ? Music2
    : /^(tsx?|jsx?|json|css|html|py|rs|go|sh|ya?ml)$/.test(extension) ? FileCode2
    : /^(md|txt|log|csv)$/.test(extension) ? FileText : File;
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController(); setChildren(undefined); setError('');
    void load(entry.path, controller.signal).then(rows => { if (!controller.signal.aborted) setChildren(rows); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [expanded, entry.path, load]);
  return <div className="workspace-files-item" data-folder={folder}>
    <div className="workspace-files-row">
      {mode === 'tree' && folder && depth < 20 && <button type="button" className="workspace-files-expand" aria-label={`${t('Expand folder')}: ${entry.name}`} aria-expanded={expanded} disabled={entry.disabled} onClick={() => setExpanded(v => !v)}><ChevronRight size={14}/></button>}
      <button className="workspace-files-entry" type="button" aria-label={entry.name} title={entry.name} disabled={entry.disabled} aria-current={selected === entry.path ? true : undefined} onClick={() => open(entry)} onDoubleClick={() => onDoubleClickEntry?.(entry)}>
        <Icon size={16} strokeWidth={1.75} aria-hidden="true"/><span>{entry.name}</span>
        {mode === 'list' && !folder && entry.size !== undefined && <small>{entry.size < 1024 ? `${entry.size} B` : entry.size < 1048576 ? `${(entry.size / 1024).toFixed(1)} KB` : `${(entry.size / 1048576).toFixed(1)} MB`}</small>}
      </button>
    </div>
    {mode === 'tree' && expanded && <div className="workspace-files-children">
      {error ? <p role="alert">{error}</p> : !children ? <p role="status">{t('Loading…')}</p> : children.length ? <DirectoryRows {...{ entries: children, mode, open, onDoubleClickEntry, selected, load }} depth={depth + 1}/> : <p role="status">{t('This folder is empty.')}</p>}
    </div>}
  </div>;
}
