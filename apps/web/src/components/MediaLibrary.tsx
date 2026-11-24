import { translate, useI18n } from '../lib/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MediaLibraryEntry, MediaLibraryListResponse } from '@agentopsdeck/shared';
import { ChevronRight, Film, Folder, Play, RefreshCcw, WifiOff, X } from 'lucide-react';
import { api, recoveryEpoch, recoveryScope, subscribeRecoveryScope } from '../api';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { VideoPlayer } from './VideoPlayer';
import { useFileCardSettings } from '../lib/workspace-file-card-context';
import { useLinkedFile, type FileSelection } from './WorkspaceFileLinks';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';

function LinkedWorkspaceMedia({ file, onClose }: { file: Extract<FileSelection, { type: 'file' }>; onClose: () => void }) {
  const { t } = useI18n(), [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const epoch = recoveryEpoch(), controller = new AbortController(); let active = true, objectUrl = '';
    if (file.size !== undefined && file.size > 24 * 1024 * 1024) { setError(t('Workspace media is limited to 24 MiB. Use the media library for larger files.')); return; }
    void api.downloadFile(file.scope, file.path, controller.signal).then(blob => {
      if (!active || epoch !== recoveryEpoch()) return;
      objectUrl = URL.createObjectURL(new Blob([blob], { type: file.mimeType ?? 'application/octet-stream' })); setUrl(objectUrl);
    }).catch(e => { if (active && epoch === recoveryEpoch()) setError(String(e.message ?? e)); });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file]);
  return <section className="media-library-player" aria-label={file.name}><ResourceTitle>{file.name}</ResourceTitle><ResourceToolbar><ResourceAction label={t('Close player')} onClick={onClose}><X size={15}/></ResourceAction></ResourceToolbar>{url ? <VideoPlayer src={url} title={file.name} fill /> : <p role={error ? 'alert' : 'status'}>{error || t('Loading…')}</p>}</section>;
}

export function MediaLibrary({ paneId }: { paneId?: string } = {}) {
  const epoch = useSyncExternalStore(subscribeRecoveryScope, recoveryEpoch, recoveryEpoch);
  // Remount on *every* identity transition, including A → B → A. A late
  // response guard alone leaves the old listing and signed player visible.
  return <MediaLibraryView key={epoch} epoch={epoch} scope={recoveryScope()} paneId={paneId} />;
}

function MediaLibraryView({ epoch, scope, paneId }: { epoch: number; scope: string | undefined; paneId: string | undefined }) {
  const { t: tr, locale } = useI18n();
  const [state, setState] = useState<MediaLibraryListResponse>();
  const [root, setRoot] = useState<string>();
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<MediaLibraryEntry>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const active = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const linked = useLinkedFile(paneId), [linkedFile, setLinkedFile] = useState<Extract<FileSelection, { type: 'file' }>>();
  useEffect(() => {
    const file = linked.selection;
    if (!file || file.type !== 'file' || !/^(video|audio)\//.test(file.mimeType ?? '')) return;
    setLinkedFile(file); setSelected(undefined);
  }, [linked.selection]);

  const load = useCallback(async (nextRoot?: string, nextPath = '', selectedPath?: string) => {
    if (!active.current || epoch !== recoveryEpoch()) return;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    const request = ++generation.current;
    const current = () => active.current && !pending.signal.aborted && request === generation.current && epoch === recoveryEpoch();
    setLoading(true);
    setError(undefined);
    setSelected(undefined);
    try {
      let result = await api.mediaLibrary(nextRoot, nextPath, pending.signal);
      if (!current()) return;
      const validate = (value: MediaLibraryListResponse) => {
        if (!value || typeof value.enabled !== 'boolean' || typeof value.path !== 'string' || !Array.isArray(value.roots) || !Array.isArray(value.entries)
          || value.roots.some(item => !item || typeof item.id !== 'string' || typeof item.label !== 'string')
          || value.entries.some(item => !item || typeof item.name !== 'string' || typeof item.path !== 'string' || !['directory', 'video'].includes(item.kind))) throw Error('Invalid media library response');
      };
      validate(result);
      const resolvedRoot = nextRoot ?? result.roots[0]?.id;
      if (result.enabled && resolvedRoot !== undefined && nextRoot === undefined) result = await api.mediaLibrary(resolvedRoot, nextPath, pending.signal);
      if (!current()) return;
      validate(result);
      setState(result);
      setRoot(resolvedRoot);
      setPath(result.path);
      setSelected(selectedPath ? result.entries.find(entry => entry.path === selectedPath && entry.playable) : undefined);
    } catch (err) {
      if (current()) { setState(undefined); setError(err instanceof Error ? err.message : String(err)); }
    } finally {
      if (current()) setLoading(false);
    }
  }, [epoch]);

  useEffect(() => {
    active.current = true;
    const expire = () => { active.current = false; generation.current++; controller.current?.abort(); setLinkedFile(undefined); setSelected(undefined); setState(undefined); setRoot(undefined); setPath(''); setError(undefined); setLoading(false); };
    window.addEventListener('agentopsdeck:auth-required', expire);
    void load();
    return () => { active.current = false; generation.current++; controller.current?.abort(); window.removeEventListener('agentopsdeck:auth-required', expire); };
  }, [load]);

  useEffect(() => {
    const file = linked.selection;
    if (file?.type !== 'library') return;
    setLinkedFile(undefined);
    // Resolve fresh authorized playback metadata; signed URLs are never shared.
    void load(file.root, file.path.split('/').slice(0, -1).join('/'), file.path);
  }, [linked.selection, load]);

  useFileCardSettings('media', { title: selected?.name || tr('Private media library'), mediaId: encodeURIComponent(JSON.stringify([root ?? '', path])) }, value => {
    // This is a library reference, never a signed playback URL. Resolving it
    // goes through the existing authorized listing API and never starts playback.
    const ref: unknown = JSON.parse(decodeURIComponent(value.mediaId));
    if (!Array.isArray(ref) || ref.length !== 2 || ref.some(part => typeof part !== 'string')
      || !state?.roots.some(item => item.id === ref[0]) || /(^|\/)\.\.(\/|$)/.test(ref[1])) throw Error('Invalid media reference');
    void load(ref[0], ref[1]);
  }, !loading && !selected);

  const breadcrumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    return [
      { label: state?.roots.find((item) => item.id === root)?.label ?? tr('Media'), path: '' },
      ...parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') })),
    ];
  }, [path, root, state?.roots, locale]);

  if (linkedFile) return <LinkedWorkspaceMedia key={JSON.stringify(linkedFile)} file={linkedFile} onClose={() => setLinkedFile(undefined)} />;
  if (!loading && state && !state.enabled) return <Card className="mx-auto max-w-2xl p-6 text-center">
    <Film className="mx-auto text-blue-600" size={38} />
    <h2 className="mt-3 text-xl font-black text-slate-950">{tr("Private media library")}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">{tr("Choose a folder to enable your private video library. Chat attachments and Connector workspaces remain available independently.")}</p>
    <details className="mt-4 rounded-xl bg-slate-50 p-4 text-left text-sm"><summary className="cursor-pointer font-semibold">{tr("Administrator setup")}</summary>
      <p className="mt-3 text-slate-600">{tr("Set an existing directory on the Hub host in its service environment, then deploy and restart safely. This does not grant access to remote Connector files.")}</p>
      <p className="mt-3 text-slate-600">{tr('Examples only: replace these paths with existing folders readable by the Hub service account.')}</p>
      <pre className="my-3 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{'AOD_MEDIA_LIBRARY_DIRS=/srv/agentopsdeck/videos'}</pre>
      <p className="text-slate-600">{tr('For multiple folders, use comma-separated absolute paths.')}</p>
      <p className="mt-3 font-semibold">Windows</p>
      <pre className="my-3 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{'AOD_MEDIA_LIBRARY_DIRS=D:\\AgentOpsDeck\\Videos'}</pre>
      <p className="text-slate-600">{tr('Also check that AOD_MEDIA_LIBRARY_ENABLED is not set to false. Recheck configuration reads the current server state; it does not change settings or restart services.')}</p>
      <p className="text-slate-600">{tr("Use dedicated media folders, not a home directory or filesystem root. An empty setting leaves the library disabled.")}</p>
    </details>
    <Button variant="secondary" className="mt-4" onClick={() => void load()}><RefreshCcw size={15} />{tr('Recheck configuration')}</Button>
  </Card>;

  // Playback replaces the catalogue; its size is constrained by the pane, not
  // the video's natural aspect ratio. Closing keeps the current folder intact.
  if (selected?.playbackUrl) return <section className="media-library-player" aria-label={selected.name}>
    <ResourceTitle>{selected.name}</ResourceTitle>
    <ResourceToolbar><ResourceAction label={tr('Close player')} onClick={() => setSelected(undefined)}><X size={15}/></ResourceAction></ResourceToolbar>
    <VideoPlayer
      src={api.mediaPlaybackUrl(selected.playbackUrl)}
      title={selected.name}
      resumeKey={resumeKey(scope, root, selected.path)}
      fill
    />
  </section>;

  return <div className="workspace-media mx-auto grid w-full max-w-6xl gap-4">
    <ResourceTitle>{tr('Private media')}</ResourceTitle>
    <ResourceToolbar>
        {(state?.roots.length ?? 0) > 1 ? <select name="medialibrary-select-1"
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700"
          value={root}
          onChange={(event) => void load(event.currentTarget.value, '')}
          aria-label={tr("Media directory")}
        >{state?.roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : null}
        <ResourceAction label={tr('Refresh media')} disabled={loading} onClick={() => void load(root, path)}><RefreshCcw size={16} /></ResourceAction>
    </ResourceToolbar>

    {error ? <div className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700"><WifiOff className="mt-0.5 shrink-0" size={16} />{error}</div> : null}

    <Card className="overflow-hidden p-0">
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-slate-200 px-3 py-2 text-sm">
        {breadcrumbs.map((crumb, index) => <span className="flex min-w-0 items-center gap-1" key={`${crumb.path}:${index}`}>
          {index ? <ChevronRight className="shrink-0 text-slate-300" size={15} /> : null}
          <button type="button" className="max-w-48 truncate rounded-lg px-2 py-1 font-bold text-blue-700 hover:bg-blue-50" onClick={() => root !== undefined && void load(root, crumb.path)}>{crumb.label}</button>
        </span>)}
      </div>
      <div className="divide-y divide-slate-100">
        {loading ? <div className="p-8 text-center text-sm font-semibold text-slate-500">{tr('Loading media…')}</div> : null}
        {!loading && state?.entries.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">{tr('No supported videos in this folder.')}</div> : null}
        {!loading && state?.entries.map((entry) => <button
          type="button"
          key={entry.path}
          className={cn('flex w-full items-center gap-3 px-3 py-3 text-left transition hover:bg-slate-50 active:bg-slate-100', entry.kind === 'video' && !entry.playable && 'cursor-default opacity-65')}
          onClick={() => { if (entry.kind === 'directory') { if (root !== undefined) void load(root, entry.path); } else if (entry.playable) { setSelected(entry); if (root) linked.publish({ type: 'library', root, path: entry.path, name: entry.name }); } }}
        >
          <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', entry.kind === 'directory' ? 'bg-amber-50 text-amber-600' : entry.playable ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500')}>
            {entry.kind === 'directory' ? <Folder size={20} /> : <Play size={19} fill="currentColor" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-black text-slate-900">{entry.name}</span>
            <span className="mt-0.5 block truncate text-xs font-semibold text-slate-500">{entry.kind === 'directory' ? tr('folder') : `${formatBytes(entry.size)} · ${tr(entry.playable ? 'Tap to play' : 'Transcoding required')}`}</span>
          </span>
          {entry.kind === 'directory' ? <ChevronRight className="shrink-0 text-slate-300" size={18} /> : null}
        </button>)}
      </div>
      {state?.truncated ? <div className="border-t border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{tr('Only the first 500 items are shown.')}</div> : null}
    </Card>
  </div>;
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value)) return translate('Unknown size');
  const bytes = value ?? 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index]!;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function resumeKey(scope: string | undefined, root: string | undefined, path: string) {
  // The opaque account scope, not a resettable page counter, separates resume
  // positions even after a reload signs in as a different account in this tab.
  return `agentopsdeck.media.resume.${scope ?? 'anonymous'}.${root ?? 'unknown'}.${path}`;
}
