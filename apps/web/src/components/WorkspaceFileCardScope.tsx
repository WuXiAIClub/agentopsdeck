import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FileSymlink } from 'lucide-react';
import { api, ApiResponseError, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { fileCardPaneResource, fileConfigurationKinds, readCachedFileCardConfiguration, syncFileCardPaneResource, writeCachedFileCardConfiguration } from '../lib/workspace-file-card-pane';
import type { Pane } from '../lib/workspace-layout';
import { isSessionPane } from '../lib/workspace-layout';
import { WorkspaceFileCardContext, type FileCardDocument, type FileCardSettings } from '../lib/workspace-file-card-context';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import { parseFileCardDocument } from '../lib/workspace-file-card-write';
import { createPageRefreshGate } from '../lib/page-refresh';
import { RenderRecoveryBoundary } from './RenderRecoveryBoundary';
const FileCardDialog = lazy(() => import('./WorkspaceFileCardDialog'));
const SharedContent = lazy(() => import('./WorkspaceSharedContent'));
const SharedArchive = lazy(() => import('./SharedNotebookArchive'));

/** A cheap stable boundary. Native editors keep their instance and save routes.
 * Only configuration cards load one metadata document; no chat/history reads. */
export default function WorkspaceFileCardScope(props: { pane: Pane; scope: string; children: ReactNode }) {
  if (props.pane.kind === 'notebook') return <RenderRecoveryBoundary scope="notebook" key={JSON.stringify([props.scope, props.pane.id, props.pane.target, props.pane.resourceId])}><ResourceFileCardScope {...props} /></RenderRecoveryBoundary>;
  return isSessionPane(props.pane) ? props.children : <ResourceFileCardScope {...props} />;
}
function ResourceFileCardScope({ pane, scope, children }: { pane: Pane; scope: string; children: ReactNode }) {
  const { t } = useI18n();
  const key = JSON.stringify([scope, pane.kind, pane.id, 'resourceId' in pane ? pane.resourceId : null, 'target' in pane ? pane.target : null]);
  const syncIdentity = syncFileCardPaneResource(pane);
  const [asyncIdentity, setAsyncIdentity] = useState<{ key: string; resource: string | undefined }>();
  const identity = syncIdentity.resolved ? { key, resource: syncIdentity.resource } : asyncIdentity;
  const resource = identity?.key === key ? identity.resource : undefined;
  const [open, setOpen] = useState(false), [document, setDocument] = useState<FileCardDocument | undefined>(() => readCachedFileCardConfiguration(scope, resource));
  const [initialSession, setInitialSession] = useState<string>();
  const settings = useRef<FileCardSettings | undefined>(undefined);
  const [guard] = useState(createPageRefreshGate), [blocked, setBlocked] = useState(false);
  const register = useCallback((value: FileCardSettings) => { settings.current = value; return () => { if (settings.current === value) settings.current = undefined; }; }, []);
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      // A second drop must not retarget an open confirmation or pending intent.
      if (open || !detail || detail.scope !== scope || detail.paneId !== pane.id || typeof detail.sessionKey !== 'string' || recoveryScope() !== scope || !resource) return;
      const ready = guard.ready(); setBlocked(!ready);
      if (ready) { setInitialSession(detail.sessionKey); setOpen(true); }
    };
    window.document.addEventListener('agentopsdeck:binding-drop', drop);
    return () => window.document.removeEventListener('agentopsdeck:binding-drop', drop);
  }, [scope, pane.id, resource, guard, open]);
  const { notice } = useWorkspaceBoardRevision(scope, resource ?? '', 'card-configuration');
  useEffect(() => {
    setOpen(false);
    const sync = syncFileCardPaneResource(pane);
    if (sync.resolved) {
      setDocument(readCachedFileCardConfiguration(scope, sync.resource));
      return;
    }
    let alive = true; setDocument(undefined);
    void fileCardPaneResource(pane).then(value => {
      if (alive) {
        setAsyncIdentity({ key, resource: value });
        setDocument(readCachedFileCardConfiguration(scope, value));
      }
    }).catch(() => { if (alive) setAsyncIdentity({ key, resource: undefined }); });
    return () => { alive = false; };
  }, [key]);
  useEffect(() => {
    if (!resource || !pane.kind || !fileConfigurationKinds.has(pane.kind as Parameters<typeof fileConfigurationKinds.has>[0]) || recoveryScope() !== scope) return;
    const abort = new AbortController();
    void api.fileCardConfiguration(resource, abort.signal).then(value => {
      const document = parseFileCardDocument(value.document);
      if (!abort.signal.aborted && recoveryScope() === scope) {
        if (value.document === null) {
          writeCachedFileCardConfiguration(scope, resource, null);
          setDocument(undefined);
        } else if (document && document.kind === pane.kind) {
          writeCachedFileCardConfiguration(scope, resource, document);
          setDocument(document);
        }
      }
    })
      .catch(error => {
        if (!abort.signal.aborted && error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) {
          writeCachedFileCardConfiguration(scope, resource, null);
          setDocument(undefined);
        }
      });
    return () => abort.abort();
  }, [resource, scope, notice]);
  const context = useMemo(() => ({ ...(document ? { document } : {}), register, registerGuard: guard.register }), [document, register, guard]);
  const native=<>
    {resource && <ResourceToolbar><ResourceAction draggable data-binding-drag label={t('Card file sync')} onClick={() => { const ready = guard.ready(); setBlocked(!ready); if (ready) { setInitialSession(undefined); setOpen(true); } }}><FileSymlink size={15} /></ResourceAction></ResourceToolbar>}
    {blocked && <p role="status" onClick={() => setBlocked(false)}>{t('Unsaved changes')}</p>}
    {children}
    {open && resource && createPortal(<Suspense fallback={null}><FileCardDialog key={`${scope}:${resource}`} scope={scope} resource={resource}
      settings={settings} initialSession={initialSession} onDocument={doc => { writeCachedFileCardConfiguration(scope, resource, doc ?? null); setDocument(doc); }} onClose={() => setOpen(false)} /></Suspense>, window.document.body)}
  </>;
  return <WorkspaceFileCardContext.Provider value={context}>
    {identity?.key!==key?null:resource?<Suspense fallback={null}><SharedContent key={`${scope}:${resource}`} scope={scope} resource={resource} ready={guard.ready}
      sharedView={(card,revision,enabled)=>pane.kind==='notebook'?<SharedArchive id={pane.target==='hub'?pane.resourceId:'default'} {...(pane.target==='session'?{sessionKey:pane.resourceId}:{})} paused={!enabled}/>:
        fileConfigurationKinds.has(card.kind)?<WorkspaceFileCardContext.Provider value={{...context,document:{...card,revision}}}>
          <button disabled={!enabled} onClick={()=>{if(recoveryScope()===scope&&guard.ready()&&settings.current?.available())settings.current.apply(card);}}>{t('Use file settings')}</button>
          {children}
        </WorkspaceFileCardContext.Provider>:null}
      >{native}</SharedContent></Suspense>:native}
  </WorkspaceFileCardContext.Provider>;
}
