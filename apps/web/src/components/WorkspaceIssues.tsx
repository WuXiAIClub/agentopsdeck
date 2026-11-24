import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, recoveryEpoch, recoveryScope, subscribeRecoveryScope, type HubConnection } from '../api';
import { useI18n } from '../lib/i18n';
import { validIssueSources, validIssuePage, type IssueSourceView, type IssuePageView } from '../lib/issue-card';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';
import { ReadingDraftTransfer, ReadingNotebookTransfer } from './WorkspaceDraftTargets';
import { SourceTaskTransfer } from './SourceTaskTransfer';
import { issueTask } from '../lib/source-task';
import { readSourceSelection, saveSourceSelection } from '../lib/source-selection';
import './workspace-source-card.css';

export default function WorkspaceIssues({ scope,cardId='default' }: { scope: string;cardId?:string }) {
  const { t } = useI18n();
  const [epoch, setEpoch] = useState(recoveryEpoch), [connections, setConnections] = useState<HubConnection[]>([]);
  const [connection, setConnection] = useState(''), [sources, setSources] = useState<IssueSourceView[]>([]), [sourceId, setSourceId] = useState('');
  const [state, setState] = useState('all'), [page, setPage] = useState<IssuePageView>(), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>(), [reload, setReload] = useState(0);
  const [kind, setKind] = useState<'issue' | 'work_item'>('issue');
  const request = useRef<AbortController | undefined>(undefined);
  const selectionKey=`issue:${cardId}`;
  const remember=(c=connection,s=sourceId,k=kind,f=state)=>{if(scope===recoveryScope())saveSourceSelection(scope,selectionKey,{connection:c,source:s,kind:k,state:f as 'all'|'open'|'closed'});};
  const clear = () => { request.current?.abort(); request.current = undefined; setPage(undefined); setSelected(undefined); setBusy(false); setError(false); };
  useEffect(() => subscribeRecoveryScope(() => { clear(); setEpoch(recoveryEpoch()); setConnections([]); setConnection(''); setSources([]); setSourceId(''); }), []);
  useEffect(() => {
    let alive = true; clear(); setConnection(''); setConnections([]); setSources([]); setSourceId('');
    setKind('issue');setState('all');
    void api.hubConnections().then(v => { if (alive && epoch === recoveryEpoch()) {setConnections(v.connections);const saved=scope===recoveryScope()?readSourceSelection(scope,selectionKey):undefined;if(saved&&v.connections.some(c=>c.id===saved.connection))setConnection(saved.connection);} }).catch(() => { if (alive && epoch === recoveryEpoch()) setError(true); });
    return () => { alive = false; request.current?.abort(); };
  }, [scope, epoch,selectionKey]);
  useEffect(() => {
    const controller = new AbortController(); clear(); setSources([]); setSourceId('');
    if (connection) void api.issueSources(connection, controller.signal).then(v => {
      if (controller.signal.aborted || epoch !== recoveryEpoch()) return;
      if (!validIssueSources(v)) throw Error('Invalid sources'); setSources(v.sources);
      const saved=scope===recoveryScope()?readSourceSelection(scope,selectionKey):undefined;const source=v.sources.find(s=>s.id===saved?.source);
      if(saved?.connection===connection&&source){setSourceId(source.id);setKind(saved.kind&&source.kinds.includes(saved.kind)?saved.kind:'issue');setState(saved.state??'all');}
    }).catch(() => { if (!controller.signal.aborted && epoch === recoveryEpoch()) setError(true); });
    return () => controller.abort();
  }, [connection, epoch]);
  const read = async (cursor?: string) => {
    const source = sources.find(s => s.id === sourceId); if (!source || !connection || request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(false); setPage(undefined); setSelected(undefined);
    try {
      const value = await api.issueItems(connection, source.id, state, cursor, controller.signal, kind);
      if (controller.signal.aborted || epoch !== recoveryEpoch() || request.current !== controller) return;
      if (!validIssuePage(value, source, kind)) throw Error('Invalid issues'); setPage(value);
    } catch { if (!controller.signal.aborted && epoch === recoveryEpoch() && request.current === controller) setError(true); }
    finally { if (request.current === controller) { request.current = undefined; setBusy(false); } }
  };
  useEffect(() => { clear(); void read(); return () => { request.current?.abort(); request.current = undefined; }; }, [sourceId, connection, state, kind, reload, epoch]);
  const detail = page?.items.find(item => item.sourceKey === selected);
  return <section className="workspace-source-card" aria-label={t('Issue sources')}>
    <ResourceToolbar local>
      <select name="workspaceissues-select-1" aria-label={t('Environment')} value={connection} onChange={e => { clear();remember(e.target.value,'','issue');setKind('issue'); setConnection(e.target.value); setSourceId(''); }}>
        <option value="">{t('Choose an environment')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <select name="workspaceissues-select-2" aria-label={t('Issue source')} value={sourceId} onChange={e => { clear();remember(connection,e.target.value,'issue'); setKind('issue'); setSourceId(e.target.value); }}>
        <option value="">{t('Choose an issue source')}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <select name="workspaceissues-select-3" aria-label={t('Item type')} value={kind} onChange={e => { clear();remember(connection,sourceId,e.target.value as 'issue'|'work_item'); setKind(e.target.value as 'issue' | 'work_item'); }}>
        <option value="issue">{t('Issue')}</option>{sources.find(s => s.id === sourceId)?.kinds.includes('work_item') && <option value="work_item">{t('Work item')}</option>}
      </select>
      <select name="workspaceissues-select-4" aria-label={t('Issue state')} value={state} onChange={e => {remember(connection,sourceId,kind,e.target.value);setState(e.target.value);}}><option value="all">{t('All')}</option><option value="open">{t('Open issues')}</option><option value="closed">{t('Closed issues')}</option></select>
      <ResourceAction label={t('Refresh')} disabled={!sourceId || busy} onClick={() => setReload(v => v + 1)}><RefreshCw size={15}/></ResourceAction>
    </ResourceToolbar>
    <p>{t('Read-only source. Work items require explicit source support; remote edits are disabled.')}</p>
    {busy && <p role="status">{t('Loading…')}</p>}{error && <p role="alert">{t('Issue source unavailable. Check permission or refresh explicitly.')}</p>}
    {page && <><p>{t('Observed at')}: {new Date(page.observedAt).toLocaleString()} · {page.completeness === 'partial' ? t('Partial results') : t('Loaded page')}</p>
      {page.retryAfter !== null && <p role="status">{t('Source rate limited. Retry later.')}</p>}
      <ul>{page.items.map(item => <li key={item.sourceKey}><button type="button" aria-expanded={selected === item.sourceKey} onClick={() => setSelected(v => v === item.sourceKey ? undefined : item.sourceKey)}><span>{item.title} · {item.state}</span></button></li>)}</ul>
      {page.nextCursor && <button type="button" disabled={busy || page.retryAfter !== null} onClick={() => void read(page.nextCursor!)}>{t('Next page')}</button>}
      {detail && <article aria-label={t('Issue detail')}><h3>{detail.number ? `#${detail.number} ` : ''}{detail.title}</h3>
        <p>{detail.typeName ?? detail.identity.kind}</p><p>{t('Labels')}: {detail.labels?.join(', ') || '—'}</p><p>{t('Assignees')}: {detail.assignees?.join(', ') || '—'}</p>
        {detail.metadataPartial && <p>{t('Partial results')}</p>}<a href={detail.url} target="_blank" rel="noopener noreferrer">{t('Open source')}</a><pre>{detail.body ?? t('No description')}</pre>
        <ReadingDraftTransfer key={`draft:${detail.sourceKey}:${page.observedAt}`} text={JSON.stringify({ source: 'issue', connection, observedAt: page.observedAt, ...detail }, null, 2)} />
        <ReadingNotebookTransfer key={`note:${detail.sourceKey}:${page.observedAt}`} text={JSON.stringify({ source: 'issue', connection, observedAt: page.observedAt, ...detail }, null, 2)} />
        <SourceTaskTransfer key={`task:${detail.sourceKey}:${page.observedAt}`} task={issueTask(detail)} />
      </article>}
    </>}
  </section>;
}
