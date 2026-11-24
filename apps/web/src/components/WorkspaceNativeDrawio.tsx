import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Download, FolderOpen, Play, RefreshCw, Save, Upload, X } from 'lucide-react';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import { NATIVE_DRAWIO_MAX_XML_BYTES, nativeDrawioContent, validNativeDrawioWrite,
  type NativeDrawioDocument, type NativeDrawioWrite, type NativeDrawioSummary } from '@agentopsdeck/shared';
import { api, ApiResponseError, recoveryEpoch, recoveryScope, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import { isolatedDrawioUrl, nativeDrawioDraftKey, nativeDrawioEqual, parseNativeDrawioDraft,
  readNativeDrawioEvent, reconcileNativeDrawio, validateNativeDrawioXml } from '../lib/workspace-native-drawio';

/** The trusted editor receives ONLY XML, never Hub credentials, resource IDs, or APIs. */
export default function WorkspaceNativeDrawio({ scope, resourceId, onOpen }: { scope: string; resourceId: string; onOpen: (kind: 'native-drawio', id: string) => void }) {
  const { t } = useI18n();
  const [remote, setRemote] = useState<NativeDrawioDocument>(), [draft, setDraft] = useState<NativeDrawioWrite>();
  const draftRef = useRef(draft); draftRef.current = draft;
  const [busy, setBusy] = useState(false), lock = useRef(false), alive = useRef(true);
  const [error, setError] = useState<'' | 'load' | 'conflict' | 'uncertain' | 'invalid'>('');
  const [storageError, setStorageError] = useState(false), [reload, setReload] = useState(0);
  const [configuredUrl, setConfiguredUrl] = useState<string | null>(null);
  const editorUrl = useMemo(() => isolatedDrawioUrl(configuredUrl, location.origin), [configuredUrl]);
  const [editorOpen, setEditorOpen] = useState(false), [editorState, setEditorState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [confirm, setConfirm] = useState<'reload' | 'close' | undefined>();
  const [catalog, setCatalog] = useState<NativeDrawioSummary[]>(), [catalogOpen, setCatalogOpen] = useState(false), [catalogError, setCatalogError] = useState(false);
  const catalogDialog = useRef<HTMLDialogElement>(null), confirmDialog = useRef<HTMLDialogElement>(null);
  const confirmTitleId = useId(), catalogTitleId = useId();
  const frame = useRef<HTMLIFrameElement>(null), file = useRef<HTMLInputElement>(null);
  const key = nativeDrawioDraftKey(scope, resourceId);
  const observed = useWorkspaceBoardRevision(scope, resourceId, 'native-drawio');
  const attemptedRemote = useRef('');
  const [epoch, setEpoch] = useState(recoveryEpoch);
  const validIdentity = (expectedEpoch = epoch) => alive.current && Boolean(scope) && scope === recoveryScope() && expectedEpoch === recoveryEpoch();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => subscribeRecoveryScope(() => {
    setConfirm(undefined); setCatalogOpen(false); setEditorOpen(false); setEpoch(recoveryEpoch());
  }), []);
  const persist = (value: NativeDrawioWrite) => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); setStorageError(false); } catch { setStorageError(true); }
  };
  const changeDraft = (value: NativeDrawioWrite) => { draftRef.current = value; setDraft(value); persist(value); };
  useEffect(() => {
    if (!scope || scope !== recoveryScope()) { lock.current = false; setBusy(false); return; }
    const controller = new AbortController(); let live = true; const requestEpoch = recoveryEpoch();
    lock.current = true; setBusy(true); setEditorOpen(false);
    void Promise.all([api.workspaceNativeDrawio(resourceId, controller.signal), api.workspaceNativeDrawioConfig(controller.signal)]).then(([document, config]) => {
      if (!live || !validIdentity(requestEpoch)) return;
      let local: NativeDrawioWrite | undefined;
      try { local = parseNativeDrawioDraft(sessionStorage.getItem(key)); } catch { setStorageError(true); }
      const restored = reconcileNativeDrawio(document, local, crypto.randomUUID());
      setRemote(document); draftRef.current = restored.draft; setDraft(restored.draft); setConfiguredUrl(config.editorUrl);
      setError(restored.conflict ? 'conflict' : '');
    }).catch(() => { if (live && validIdentity(requestEpoch)) setError('load'); })
      .finally(() => { lock.current = false; if (live && validIdentity(requestEpoch)) setBusy(false); });
    return () => { live = false; lock.current = false; controller.abort(); };
  }, [scope, epoch, resourceId, key, reload]);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement;
    confirmDialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [confirm]);
  useEffect(() => {
    if (!catalogOpen) return;
    const previous = document.activeElement;
    catalogDialog.current?.showModal(); const controller = new AbortController(); let live = true; const requestEpoch = recoveryEpoch();
    setCatalog(undefined); setCatalogError(false);
    void api.workspaceNativeDrawioCatalog(controller.signal).then(result => { if (live && validIdentity(requestEpoch)) setCatalog(result.drawings); })
      .catch(() => { if (live && validIdentity(requestEpoch)) setCatalogError(true); });
    return () => { live = false; controller.abort(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [catalogOpen, scope, epoch]);
  const save = async (value = draftRef.current) => {
    const saveEpoch = recoveryEpoch();
    if (!value || !validIdentity(saveEpoch) || lock.current || error === 'conflict' || error === 'load') return;
    if (!validNativeDrawioWrite(value) || !validateNativeDrawioXml(value.xml)) { setError('invalid'); return; }
    lock.current = true; setBusy(true); persist(value);
    try {
      const document = await api.saveWorkspaceNativeDrawio(resourceId, value);
      if (!validIdentity(saveEpoch)) return false;
      setRemote(document); const next = { ...nativeDrawioContent(document), revision: document.revision, mutationId: crypto.randomUUID() };
      draftRef.current = next; setDraft(next); setError('');
      try { sessionStorage.removeItem(key); setStorageError(false); } catch { setStorageError(true); }
      return true;
    } catch (cause) { if (validIdentity(saveEpoch)) setError(cause instanceof ApiResponseError && cause.status === 409 ? 'conflict' : 'uncertain'); return false; }
    finally { lock.current = false; if (validIdentity(saveEpoch)) setBusy(false); }
  };
  // Keep the same listener throughout the iframe's lifetime; handlers read current state.
  const handler = useRef({ save, validIdentity, error }); handler.current = { save, validIdentity, error };
  useEffect(() => {
    if (!editorOpen || !editorUrl) return;
    let initialized = false, loaded = false, live = true, pending: ReturnType<typeof setTimeout> | undefined, bufferedXml: string | undefined;
    const editorEpoch = recoveryEpoch();
    setEditorState('loading');
    const timeout = setTimeout(() => { if (live && !loaded) { setEditorState('failed'); setEditorOpen(false); } }, 20_000);
    const post = (value: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(value), editorUrl.origin);
    const receive = (event: MessageEvent) => {
      if (!live || !handler.current.validIdentity(editorEpoch) || event.source !== frame.current?.contentWindow || event.origin !== editorUrl.origin) return;
      const message = readNativeDrawioEvent(event.data);
      if (!message) return;
      if (message.event === 'init') {
        if (initialized) { setEditorState('failed'); setEditorOpen(false); return; }
        const current = draftRef.current;
        if (!current || !validateNativeDrawioXml(current.xml)) { setError('invalid'); setEditorOpen(false); return; }
        initialized = true; post({ action: 'load', xml: current.xml, autosave: 1, title: current.title }); return;
      }
      if (!initialized) return;
      if (message.event === 'load') { loaded = true; clearTimeout(timeout); setEditorState('ready'); return; }
      if (!loaded || lock.current || ['uncertain', 'conflict', 'load'].includes(handler.current.error)) return;
      const apply = async () => {
        bufferedXml = undefined;
        if (!live || !handler.current.validIdentity(editorEpoch) || lock.current) return;
        if (!validateNativeDrawioXml(message.xml)) { setError('invalid'); setEditorOpen(false); return; }
        const current = draftRef.current;
        if (!current) return;
        const next = current.xml === message.xml ? current : { ...current, xml: message.xml, mutationId: crypto.randomUUID() };
        changeDraft(next);
        if (message.event === 'save') {
          // Freeze/unmount the editor before Hub I/O; no autosave can race and overwrite later edits.
          setEditorOpen(false);
          await handler.current.save(next);
        }
      };
      if (pending) clearTimeout(pending);
      if (message.event === 'save') void apply(); else { bufferedXml = message.xml; pending = setTimeout(() => { void apply(); }, 250); }
    };
    window.addEventListener('message', receive);
    return () => {
      live = false; clearTimeout(timeout); if (pending) clearTimeout(pending); window.removeEventListener('message', receive);
      // Flush the bounded trailing autosave even when the pane closes before debounce fires.
      // Do not use an old identity, modify an uncertain write, or update React after unmount.
      const current = draftRef.current;
      if (bufferedXml && current && !lock.current && Boolean(scope) && scope === recoveryScope() && editorEpoch === recoveryEpoch()
        && !['uncertain', 'conflict', 'load'].includes(handler.current.error) && validateNativeDrawioXml(bufferedXml)) {
        const next = { ...current, xml: bufferedXml, mutationId: current.xml === bufferedXml ? current.mutationId : crypto.randomUUID() };
        draftRef.current = next;
        try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { if (alive.current) setStorageError(true); }
        if (alive.current) setDraft(next);
      }
    };
  }, [editorOpen, editorUrl, scope, epoch, key]);
  const disabled = busy || error === 'load' || error === 'uncertain' || error === 'conflict' || editorOpen;
  const dirty = !!draft && !!remote && !nativeDrawioEqual(draft, remote);
  usePageRefreshGuard(() => !dirty && !busy && !lock.current && !storageError && !editorOpen);
  useEffect(() => {
    // An open editor may contain changes not yet received through autosave.
    // Never reload/unmount it based on a remote notification; CAS still guards Save.
    if (busy || lock.current || editorOpen || !validIdentity(epoch) || !observed.revision
      || (remote && observed.revision <= remote.revision) || error === 'uncertain') return;
    // Closing the editor flushes its trailing autosave in effect cleanup. That
    // updates the ref before React renders the draft, so the render's `dirty`
    // alone can still be false here. Never reload over that just-flushed XML.
    if (dirty || (draftRef.current && remote && !nativeDrawioEqual(draftRef.current, remote))) { setError('conflict'); return; }
    const attempt = JSON.stringify([key, observed.revision, observed.notice]);
    if (attemptedRemote.current === attempt) return;
    attemptedRemote.current = attempt;
    if (remote) try { sessionStorage.removeItem(key); } catch { setStorageError(true); return; }
    setReload(value => value + 1);
  }, [observed.revision, observed.notice, remote, busy, editorOpen, dirty, error, scope, epoch, key]);
  const download = () => {
    if (!draft || !validIdentity()) return;
    const url = URL.createObjectURL(new Blob([draft.xml], { type: 'application/xml' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'agentopsdeck-native.drawio'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="workspace-native-drawio" aria-label={t('Native draw.io')}>
    <ResourceTitle><input name="workspacenativedrawio-input-1" aria-label={t('Drawing title')} value={draft?.title ?? ''} maxLength={160} disabled={disabled || !draft} onChange={e => {
        if (draft && validIdentity() && !lock.current) changeDraft({ ...draft, title: e.target.value, mutationId: crypto.randomUUID() });
      }} /></ResourceTitle>
    <ResourceToolbar>
      <ResourceAction label={t('Save')} disabled={!draft || disabled || !dirty} onClick={() => void save()}><Save size={14} /></ResourceAction>
      <button type="button" disabled={busy || editorOpen} onClick={() => setConfirm('reload')} aria-label={t('Reload drawing')}><RefreshCw size={14} /></button>
      <button type="button" disabled={!draft || busy} onClick={download} aria-label={t('Export draw.io XML')}><Download size={14} /></button>
      <button type="button" disabled={!draft || disabled} onClick={() => file.current?.click()} aria-label={t('Import native draw.io')}><Upload size={14} /></button>
      <button type="button" disabled={busy || editorOpen} onClick={() => setCatalogOpen(true)} aria-label={t('Open drawing')}><FolderOpen size={14} /></button>
      <input name="workspacenativedrawio-input-2" ref={file} hidden type="file" accept=".drawio,.xml" onChange={async e => {
        const selected = e.target.files?.[0]; e.target.value = '';
        const importEpoch = recoveryEpoch();
        if (!selected || !draft || disabled || lock.current || !validIdentity(importEpoch)) return;
        lock.current = true; setBusy(true);
        try {
          if (selected.size > NATIVE_DRAWIO_MAX_XML_BYTES) throw Error('budget');
          const xml = await selected.text();
          if (!validIdentity(importEpoch)) return;
          if (!validateNativeDrawioXml(xml)) throw Error('invalid');
          const current = draftRef.current ?? draft;
          changeDraft({ ...current, xml, mutationId: crypto.randomUUID() }); setError('');
        } catch { if (validIdentity(importEpoch)) setError('invalid'); }
        finally { lock.current = false; if (validIdentity(importEpoch)) setBusy(false); }
      }} />
    </ResourceToolbar>
    <p className="workspace-native-drawio-state" role="status">{busy ? t('Saving or loading…') : error === 'load' ? t('Unable to load drawing. Your local draft is retained.')
      : error === 'uncertain' ? t('Save outcome unconfirmed. Editing is paused; retry the same save.')
      : error === 'conflict' ? t('Drawing changed elsewhere. Export your draft before reloading.')
      : error === 'invalid' ? t('Invalid native draw.io. Use uncompressed XML, up to 1 MiB and 32 pages.') : dirty ? t('Unsaved changes') : t('Saved')}</p>
    {storageError && <p role="alert">{t('Local draft could not be stored. Export before closing.')}</p>}
    {error === 'uncertain' && <button type="button" disabled={busy} onClick={() => void save()}>{t('Retry same save')}</button>}
    {error === 'load' && <button type="button" onClick={() => setReload(v => v + 1)}>{t('Retry')}</button>}
    {editorState === 'failed' && !editorOpen && <p role="alert">{t('Editor did not become ready or reloaded. Your last draft is retained.')}</p>}
    {editorOpen && editorUrl ? <div className="workspace-native-drawio-editor">
      <div><span role="status">{editorState === 'ready' ? t('Use File → Save or Ctrl/Cmd+S to save to Hub and close.') : t('Loading editor…')}</span>
        <button type="button" onClick={() => setConfirm('close')} aria-label={t('Close editor')}><X size={14} /></button></div>
      <iframe ref={frame} title={t('Isolated draw.io editor')} src={editorUrl.href} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
    </div> : <div className="workspace-native-drawio-start">
      <h3>{t('Native draw.io')}</h3>
      <p>{t('Native shapes and pages are preserved separately from whiteboards. No chat history is loaded.')}</p>
      {editorUrl ? <><p>{t('Opening sends this document to the configured editor. Only continue if you trust its operator.')} <strong>{editorUrl.origin}</strong></p>
        <button type="button" disabled={!draft || disabled} onClick={() => {
          if (!draft || !validIdentity() || !validateNativeDrawioXml(draft.xml)) { setError('invalid'); return; }
          setEditorState('loading'); setEditorOpen(true);
        }}><Play size={15} />{t('Open trusted editor')}</button></>
        : <p>{t('Editor is disabled. Configure AOD_DRAWIO_EDITOR_URL on a separate trusted HTTPS origin. Import, export and draft recovery remain available.')}</p>}
    </div>}
    {confirm && <dialog ref={confirmDialog} className="workspace-native-drawio-dialog" aria-labelledby={confirmTitleId} onCancel={() => setConfirm(undefined)}>
      <h3 id={confirmTitleId}>{confirm === 'reload' ? t('Reload drawing?') : t('Close editor?')}</h3>
      <p>{confirm === 'reload' ? t('Reload discards your local draft. Export it first if needed.') : t('Close keeps the last received draft. Use File → Save or Ctrl/Cmd+S to include the latest edits.')}</p>
      <button autoFocus type="button" onClick={() => setConfirm(undefined)}>{t('Cancel')}</button>
      <button type="button" onClick={() => {
        if (!validIdentity()) return;
        if (confirm === 'reload') { try { sessionStorage.removeItem(key); setReload(v => v + 1); } catch { setStorageError(true); } }
        else setEditorOpen(false);
        setConfirm(undefined);
      }}>{t('Confirm')}</button>
    </dialog>}
    {catalogOpen && <dialog ref={catalogDialog} className="workspace-native-drawio-dialog" aria-labelledby={catalogTitleId} onCancel={() => setCatalogOpen(false)}>
      <h3 id={catalogTitleId}>{t('Native draw.io')}</h3>
      {catalogError ? <p role="alert">{t('Unable to load drawings.')}</p> : !catalog ? <p>{t('Loading…')}</p> : <ul>{catalog.map(item => <li key={item.resourceId}><button type="button" onClick={() => { if (!validIdentity()) return; setCatalogOpen(false); onOpen('native-drawio', item.resourceId); }}>{item.title}</button></li>)}</ul>}
      <button type="button" onClick={() => { if (!validIdentity()) return; setCatalogOpen(false); onOpen('native-drawio', crypto.randomUUID()); }}>{t('New drawing')}</button>
      <button autoFocus type="button" onClick={() => setCatalogOpen(false)}>{t('Close')}</button>
    </dialog>}
  </section>;
}
