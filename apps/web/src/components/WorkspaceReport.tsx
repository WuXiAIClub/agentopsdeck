import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { workspaceFileCardResource, validWorkspaceFileCardWrite, validBoardUuid, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { api, recoveryScope, ApiResponseError } from '../api';
import { useI18n } from '../lib/i18n';
import { parseFileCardDocument, readCachedReportState, writeCachedReportState } from '../lib/workspace-file-card-write';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { Save } from 'lucide-react';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import './workspace-file-card.css';
const Editor = lazy(() => import('./NotebookEditor'));
type Report = WorkspaceFileCardWrite & { kind: 'report'; content: { title: string; text: string } };

/** Native Markdown editor. File-bound saves use the same original mutation on
 * receipt inspection; SSE updates never replace an unsaved local draft. */
export default function WorkspaceReport({ scope, resourceId }: { scope: string; resourceId: string }) {
  const { t } = useI18n(), resource = workspaceFileCardResource('report', resourceId);
  const key = JSON.stringify(['agentopsdeck.report-draft', scope, resourceId]);
  const [initialSeed] = useState(() => {
    if (scope !== recoveryScope()) return undefined;
    const cached = readCachedReportState(scope, resourceId);
    let local: { input: Report; bindingId: string | null; pending: boolean } | undefined;
    try {
      const text = sessionStorage.getItem(key);
      const parsed = text ? JSON.parse(text) : undefined;
      if (parsed && validWorkspaceFileCardWrite(parsed.input) && parsed.input.kind === 'report' && typeof parsed.pending === 'boolean'
        && (parsed.bindingId === null || validBoardUuid(parsed.bindingId))) {
        local = parsed;
      }
    } catch { /* ignore invalid or inaccessible storage on initial seed */ }
    if (local) {
      return {
        draft: local.input,
        dirty: true,
        pending: local.pending,
        bindingId: local.bindingId,
        error: (cached && local.bindingId !== cached.bindingId ? 'conflict' : local.pending ? 'uncertain' : cached && local.input.revision !== cached.document.revision ? 'conflict' : undefined) as 'conflict' | 'uncertain' | undefined,
      };
    }
    if (!cached) return undefined;
    return {
      draft: { ...cached.document, kind: 'report' as const, mutationId: crypto.randomUUID() },
      dirty: false,
      pending: false,
      bindingId: cached.bindingId,
      error: undefined,
    };
  });
  const [draft, setDraft] = useState<Report | undefined>(() => initialSeed?.draft), [pending, setPending] = useState(() => initialSeed?.pending ?? false), [dirty, setDirty] = useState(() => initialSeed?.dirty ?? false);
  const [busy, setBusy] = useState(true), [error, setError] = useState<'read' | 'conflict' | 'uncertain' | undefined>(() => initialSeed?.error);
  const [reload, setReload] = useState(0), active = useRef<AbortController | undefined>(undefined);
  const bindingId = useRef<string | null>(initialSeed?.bindingId ?? null);
  const saving = useRef(false);
  const revision = useWorkspaceBoardRevision(scope, resourceId, 'report');
  const bindingRevision = useWorkspaceBoardRevision(scope, resource, 'card-file-binding');
  usePageRefreshGuard(() => !dirty && !busy);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (dirty || pending) return;
    const abort = new AbortController(); active.current = abort; setBusy(true);
    void (async () => {
      try {
        const [value, binding] = await Promise.all([api.fileCard(resource, abort.signal), api.fileCardBinding(resource, abort.signal)]);
        const doc = parseFileCardDocument(value);
        if (abort.signal.aborted || recoveryScope() !== scope) return;
        if (doc?.kind !== 'report') throw Error('Invalid report');
        writeCachedReportState(scope, resourceId, { document: doc, bindingId: binding.binding?.bindingId ?? null });
        const text = sessionStorage.getItem(key), local = text ? JSON.parse(text) : undefined;
        if (local && (!validWorkspaceFileCardWrite(local.input) || local.input.kind !== 'report' || typeof local.pending !== 'boolean'
          || local.bindingId !== null && !validBoardUuid(local.bindingId))) throw Error('Invalid draft');
        bindingId.current = local ? local.bindingId : binding.binding?.bindingId ?? null;
        if (local) {
          setDraft(local.input); setDirty(true); setPending(local.pending);
          setError(bindingId.current !== (binding.binding?.bindingId ?? null) ? 'conflict' : local.pending ? 'uncertain' : local.input.revision !== doc.revision ? 'conflict' : undefined);
        } else { setDraft({ ...doc, kind: 'report', mutationId: crypto.randomUUID() }); setError(undefined); }
      } catch { if (!abort.signal.aborted && recoveryScope() === scope) setError('read'); }
      finally { if (!abort.signal.aborted && recoveryScope() === scope) setBusy(false); }
    })();
    return () => abort.abort();
  }, [scope, resourceId, reload, revision.notice, bindingRevision.notice, dirty, pending]);
  useEffect(() => () => active.current?.abort(), []);
  const edit = (content: Report['content']) => {
    if (!draft || pending || busy) return;
    const input = { ...draft, content };
    try { sessionStorage.setItem(key, JSON.stringify({ input, bindingId: bindingId.current, pending: false })); setDraft(input); setDirty(true); }
    catch { setError('read'); }
  };
  const save = async () => {
    // Blur and a caption/keyboard save can arrive in the same render. Also
    // avoid turning focus changes in an unchanged report into writes.
    if (!draft || busy || saving.current || (!dirty && !pending) || recoveryScope() !== scope) return;
    saving.current = true;
    const abort = new AbortController(); active.current = abort; setBusy(true);
    try {
      // Persist before crossing the write boundary, including the UUID.
      sessionStorage.setItem(key, JSON.stringify({ input: draft, bindingId: bindingId.current, pending: true })); setPending(true);
      await api.saveFileCardDocument(resource, draft, bindingId.current, abort.signal);
      if (abort.signal.aborted || recoveryScope() !== scope) return;
      sessionStorage.removeItem(key); setDirty(false); setPending(false); setError(undefined); setReload(v => v + 1);
    } catch (cause) { if (!abort.signal.aborted && recoveryScope() === scope) setError(cause instanceof ApiResponseError && cause.status === 409 ? 'conflict' : 'uncertain'); }
    finally { saving.current = false; if (!abort.signal.aborted && recoveryScope() === scope) setBusy(false); }
  };
  const discard = () => {
    try { sessionStorage.removeItem(key); setPending(false); setDirty(false); setReload(v => v + 1); }
    catch { setError('read'); }
  };
  return <section className="workspace-report" aria-label={t('Report')}>
    <ResourceTitle><input name="workspacereport-input-1" aria-label={t('Card title')} maxLength={120} value={draft?.content.title ?? ''} disabled={busy || pending || !draft} onChange={e => draft && edit({ ...draft.content, title: e.target.value })} /></ResourceTitle>
    <ResourceToolbar><ResourceAction label={t(pending ? 'Check file save' : 'Save')} disabled={busy || !dirty} onClick={() => void save()}><Save size={15} /></ResourceAction></ResourceToolbar>
    {busy && (!draft || saving.current) && <p role="status">{t('Loading…')}</p>}
    {error && <div role="alert"><p>{t(error === 'conflict' ? 'File changed elsewhere. Your draft is kept.' : error === 'uncertain' ? 'Save result unconfirmed. Inspect the original write; it will not be replayed.' : 'Card unavailable. Retry refresh.')}</p>
      {error === 'conflict' ? <button type="button" disabled={busy} onClick={discard}>{t('Discard changes')}</button>
        : <button type="button" disabled={busy} onClick={() => pending ? void save() : setReload(v => v + 1)}>{t(pending ? 'Check file save' : 'Retry')}</button>}</div>}
    {draft && <Suspense fallback={null}><Editor text={draft.content.text} disabled={busy || pending} label={t('Report')} onChange={text => edit({ ...draft.content, text })} onSave={() => void save()} onReady={() => {}} /></Suspense>}
  </section>;
}
