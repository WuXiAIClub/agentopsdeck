import { useEffect, useRef, useState } from 'react';
import { Folder, File, RefreshCw, ArrowUp } from 'lucide-react';
import { api, recoveryEpoch, recoveryScope, subscribeRecoveryScope, type HubConnection } from '../api';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';
import { useI18n } from '../lib/i18n';
import { validGitTreePage, validGitFilePreview, type GitTreePage, type GitFilePreview } from '../lib/git-tree';
import { ReadingDraftTransfer, ReadingNotebookTransfer } from './WorkspaceDraftTargets';
import { readSourceSelection, saveSourceSelection } from '../lib/source-selection';
import './workspace-source-card.css';

/** No polling, commands or hidden session creation. Explicit text preview only. Account
 * changes discard data immediately; stale reads cannot repopulate the card. */
export default function WorkspaceGitTree({ scope,cardId='default' }: { scope: string;cardId?:string }) {
  const { t } = useI18n();
  const indexLabel = (s: string) => s === 'unchanged' ? t('Index matches HEAD') : s === 'added' ? t('Added to index') : s === 'modified' ? t('Index differs from HEAD') : s === 'conflicted' ? t('Index conflict') : t('Unknown');
  const workLabel = (s: string) => s === 'matches-index' ? t('Bytes match index') : s === 'differs-from-index' ? t('Bytes differ from index') : s === 'not-in-index' ? t('Not in index') : t('Unknown');
  const [epoch, setEpoch] = useState(recoveryEpoch), [connections, setConnections] = useState<HubConnection[]>([]);
  const [connection, setConnection] = useState(''), [roots, setRoots] = useState<{ repositoryRef: string; label: string }[]>([]), [root, setRoot] = useState('');
  const [path, setPath] = useState<{ name: string; token: string }[]>([]), [page, setPage] = useState<GitTreePage>();
  const [preview,setPreview]=useState<GitFilePreview>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const selectionKey=`git:${cardId}`;
  const remember=(c:string,r:string)=>{if(scope===recoveryScope())saveSourceSelection(scope,selectionKey,{connection:c,source:r});};
  const clear = () => { request.current?.abort(); request.current = undefined; setPage(undefined); setPreview(undefined); setBusy(false); setError(false); setFilter(''); };
  useEffect(() => subscribeRecoveryScope(() => { clear(); setEpoch(recoveryEpoch()); setConnections([]); setConnection(''); setRoots([]); setRoot(''); setPath([]); }), []);
  useEffect(() => {
    let alive = true;
    clear(); setConnections([]); setConnection(''); setRoots([]); setRoot(''); setPath([]);
    void api.hubConnections().then(v => { if (alive && epoch === recoveryEpoch() && scope === recoveryScope()) {setConnections(v.connections);const saved=readSourceSelection(scope,selectionKey);if(saved&&v.connections.some(c=>c.id===saved.connection))setConnection(saved.connection);else if(v.connections.length===1)setConnection(v.connections[0]!.id);} })
      .catch(() => { if (alive && epoch === recoveryEpoch()) setError(true); });
    return () => { alive = false; request.current?.abort(); };
  }, [scope, epoch,selectionKey]);
  useEffect(() => {
    const controller = new AbortController();
    clear(); setRoots([]); setRoot(''); setPath([]);
    if (connection) void api.gitTreeRoots(connection, controller.signal).then(v => {
      if (controller.signal.aborted || epoch !== recoveryEpoch()) return;
      if (v.readOnly !== true || !Array.isArray(v.roots) || v.roots.length > 64 || v.roots.some(r => !r || !/^[\w-]{1,80}$/.test(r.repositoryRef)
        || typeof r.label !== 'string' || r.label.length > 256)) throw Error('Invalid roots');
      setRoots(v.roots);
      const saved=scope===recoveryScope()?readSourceSelection(scope,selectionKey):undefined;if(saved?.connection===connection&&v.roots.some(r=>r.repositoryRef===saved.source))setRoot(saved.source);else if(v.roots.length===1)setRoot(v.roots[0]!.repositoryRef);
    }).catch(() => { if (!controller.signal.aborted && epoch === recoveryEpoch()) setError(true); });
    return () => controller.abort();
  }, [connection, epoch]);
  const read = async (cursor?: string) => {
    if (!root || !connection || request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(false); setPage(undefined); setPreview(undefined);
    try {
      const result = await api.gitTree(connection, root, path.at(-1)?.token, cursor, controller.signal);
      if (controller.signal.aborted || epoch !== recoveryEpoch() || request.current !== controller) return;
      if (!validGitTreePage(result, root)) throw Error('Invalid tree');
      setPage(result);
    } catch { if (!controller.signal.aborted && epoch === recoveryEpoch() && request.current === controller) setError(true); }
    finally { if (request.current === controller) { request.current = undefined; setBusy(false); } }
  };
  useEffect(() => { clear(); void read(); return () => { request.current?.abort(); request.current = undefined; }; }, [root, connection, path, reload, epoch]);
  const showPreview=async(pathToken:string)=>{
    if(request.current)return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError(false);setPreview(undefined);
    try{
      const value=await api.gitFilePreview(connection,root,pathToken,controller.signal);
      if(controller.signal.aborted||epoch!==recoveryEpoch()||request.current!==controller)return;
      if(!validGitFilePreview(value,root,pathToken))throw Error('Invalid preview');setPreview(value);
    }catch{if(!controller.signal.aborted&&epoch===recoveryEpoch()&&request.current===controller)setError(true);}
    finally{if(request.current===controller){request.current=undefined;setBusy(false);}}
  };
  const rootLabel = roots.find(value => value.repositoryRef === root)?.label ?? root;
  const entries = page?.entries.filter(entry => entry.name !== '.git' && entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    .sort((a,b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  return <section className="workspace-source-card" aria-label={t('Repository tree')}>
    <ResourceToolbar local>
      <select name="workspacegittree-select-1" aria-label={t('Environment')} value={connection} onChange={e => { clear();remember(e.target.value,''); setConnection(e.target.value); setRoot(''); setPath([]); }}>
        <option value="">{t('Choose an environment')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <select name="workspacegittree-select-2" aria-label={t('Repository')} disabled={!connection || !roots.length} value={root} onChange={e => { clear();remember(connection,e.target.value); setRoot(e.target.value); setPath([]); }}>
        <option value="">{t('Choose a repository')}</option>{roots.map(r => <option key={r.repositoryRef} value={r.repositoryRef}>{r.label}</option>)}
      </select>
      <ResourceAction label={t('Refresh')} disabled={!root || busy} onClick={() => setReload(v => v + 1)}><RefreshCw size={15}/></ResourceAction>
      <ResourceAction label={t('Parent directory')} disabled={!path.length || busy} onClick={() => setPath(v => v.slice(0, -1))}><ArrowUp size={15}/></ResourceAction>
    </ResourceToolbar>
    {root && <nav className="workspace-source-path" aria-label={t('Repository path')}><button type="button" disabled={busy} onClick={() => setPath([])}>{rootLabel}</button>
      {path.map((part,index) => <span key={part.token}> / <button type="button" disabled={busy} onClick={() => setPath(value => value.slice(0,index+1))}>{part.name}</button></span>)}
    </nav>}
    {page?.branch && <p>{t('Branch')}: <strong>{page.branch}</strong></p>}
    <details><summary>{t('Repository access and preview limits')}</summary>
      <p>{t('Repository aliases are not agents. Add read-only roots in Connector configuration.')}</p>
      {root && <p>{t('Directory alias')}: {root}</p>}
      <p>{t('Read-only UTF-8 preview, up to 128 KiB. Raw-byte comparisons only; filters, ignored files and deleted paths are not evaluated. Unknown does not mean clean.')}</p>
    </details>
    {connection && !roots.length && !error && <p>{t('No authorized repositories are configured on this machine.')}</p>}
    {page?.gitStatus === 'unsupported' && <p role="status">{t('Git metadata unavailable. Browse files; status is unknown, not clean.')}</p>}
    {page && <input name="workspacegittree-input-3" aria-label={t('Filter this page')} placeholder={t('Filter this page')} value={filter} onChange={event => setFilter(event.target.value)} />}
    {busy && <p role="status">{t('Loading…')}</p>}{error && <p role="alert">{t('Repository read failed. Refresh to retry; files unchanged.')}</p>}
    {page && <><ul>{entries?.map(e => <li key={e.pathToken}>
      {e.kind === 'directory' ? <button type="button" onClick={() => setPath(v => [...v, { name: e.name, token: e.pathToken }])}><Folder size={15}/><span>{e.name}</span></button>
        : e.previewCapability ? <button type="button" disabled={busy} onClick={()=>void showPreview(e.pathToken)}><File size={15}/><span>{e.name}</span></button>
        : <span><File size={15}/><span>{e.name}</span><small>{e.kind === 'file' ? '' : t('Unavailable')}</small></span>}
      {e.kind === 'file' && page.gitStatus === 'raw-bytes' && <small>{indexLabel(e.indexStatus)} · {workLabel(e.worktreeStatus)}</small>}
    </li>)}</ul><p>{t('Observed at')}: {new Date(page.observedAt).toLocaleString()}</p>
      {page.truncationReason && <p role="status">{t('Scan budget reached. This directory is incomplete.')}</p>}
      {page.nextCursor && <button type="button" disabled={busy} onClick={() => void read(page.nextCursor!)}>{t('Next page')}</button>}</>}
    {preview&&<article aria-label={t('File preview')}><p>{preview.name} · {preview.bytes} B</p><pre>{preview.text}</pre><p>{t('Observed at')}: {new Date(preview.observedAt).toLocaleString()}</p>
      {preview.comparison && <><p>{indexLabel(preview.comparison.indexStatus)} · {workLabel(preview.comparison.worktreeStatus)}</p>
        {preview.comparison.diff !== null && <details><summary>{t('Raw-byte difference from index')}</summary><pre>{preview.comparison.diff || t('Bytes match index')}</pre></details>}</>}
      <ReadingDraftTransfer key={`draft:${preview.contentHash}`} text={JSON.stringify({ source: 'repository-file', connection, repositoryRef: root, path: [...path.map(p=>p.name),preview.name], observedAt: preview.observedAt, sha256: preview.contentHash, text: preview.text }, null, 2)} />
      <ReadingNotebookTransfer key={`note:${preview.contentHash}`} text={JSON.stringify({ source: 'repository-file', connection, repositoryRef: root, path: [...path.map(p=>p.name),preview.name], observedAt: preview.observedAt, sha256: preview.contentHash, text: preview.text }, null, 2)} />
    </article>}
  </section>;
}
