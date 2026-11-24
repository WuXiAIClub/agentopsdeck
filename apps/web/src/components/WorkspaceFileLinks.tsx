import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link2, X } from 'lucide-react';
import { ResourceAction, ResourceToolbar } from './ResourceToolbar';
import { createPortal } from 'react-dom';
import type { FileRequestScope } from '../api';
import { subscribeRecoveryScope } from '../api';
import { isSessionPane, paneKey, type Pane } from '../lib/workspace-layout';
import { coBoundSessionKeys, fileLinkTargets, isCoBindablePane, isFileLinkedPane, linkedFileSession } from '../lib/workspace-file-links';
import { useI18n } from '../lib/i18n';
import './workspace-files.css';

export type FileSelection = { type: 'file'; scope: FileRequestScope; path: string; name: string; mimeType?: string; size?: number }
  | { type: 'library'; root: string; path: string; name: string };
export type SessionDirectory = { sessionKey: string; connectionId: string; agentId: string; sourcePath: string };
type FileLinks = { panes: Pane[]; selections: Record<string, FileSelection>; directories: Record<string, SessionDirectory>;
  publishDirectory: (sessionKey: string, value?: SessionDirectory) => void;
  publish: (source: string, selection: FileSelection) => void; toggle: (a: string, b: string) => void };
const Context = createContext<FileLinks | null>(null);
function LinkDialog({ children, close, label }: { children: ReactNode; close: () => void; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; ref.current?.showModal(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return createPortal(<dialog ref={ref} className="workspace-files-dialog" aria-label={label} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) { const rect = e.currentTarget.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close(); } }}>{children}</dialog>, document.body);
}
export function WorkspaceFileLinksProvider({ panes, toggle, children }: { panes: Pane[]; toggle: FileLinks['toggle']; children: ReactNode }) {
  const [selections, setSelections] = useState<Record<string, FileSelection>>({});
  const [directories, setDirectories] = useState<Record<string, SessionDirectory>>({});
  useEffect(() => subscribeRecoveryScope(() => { setSelections({}); setDirectories({}); }), []);
  const sessions = JSON.stringify(panes.filter(isSessionPane).map(paneKey));
  useEffect(() => { const keys = new Set<string>(JSON.parse(sessions)); setDirectories(old => Object.keys(old).every(key => keys.has(key)) ? old : Object.fromEntries(Object.entries(old).filter(([key]) => keys.has(key)))); }, [sessions]);
  const publishDirectory = useCallback((key: string, value?: SessionDirectory) => {
    setDirectories(old => {
      if (JSON.stringify(old[key]) === JSON.stringify(value)) return old;
      const next = { ...old }; if (value) next[key] = value; else delete next[key]; return next;
    });
  }, []);
  const membership = JSON.stringify(panes.filter(isFileLinkedPane).map(paneKey));
  useEffect(() => { const keys = new Set<string>(JSON.parse(membership)); setSelections(old => Object.keys(old).every(key => keys.has(key)) ? old : Object.fromEntries(Object.entries(old).filter(([key]) => keys.has(key)))); }, [membership]);
  const publish = useCallback((source: string, selection: FileSelection) => {
    const targets = fileLinkTargets(panes, source);
    setSelections(old => targets.every(key => old[key] === selection) ? old : { ...old, ...Object.fromEntries(targets.map(key => [key, selection])) });
  }, [panes]);
  const value = useMemo(() => ({ panes, selections, directories, publishDirectory, toggle, publish }), [panes, selections, directories, publishDirectory, toggle, publish]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const fileCardLabel = (kind: Pane['kind']) => kind === 'file-browser' ? 'File browser' : kind === 'file-editor' ? 'File viewer / editor' : kind === 'image-viewer' ? 'Image viewer' : 'Media library';
export function useLinkedFile(id?: string) {
  const context = useContext(Context), pane = context?.panes.find(p => p.id === id), key = pane ? paneKey(pane) : '';
  const session = context ? linkedFileSession(context.panes, key) : undefined;
  return { selection: context?.selections[key], sessionKey: session, directory: session ? context?.directories[session] : undefined,
    publish: (value: FileSelection) => { if (key) context?.publish(key, value); } };
}
export function usePublishSessionDirectory() { return useContext(Context)?.publishDirectory; }
export function FileLinkButton({ id }: { id: string }) {
  const context = useContext(Context), { t } = useI18n(), [open, setOpen] = useState(false);
  useEffect(() => subscribeRecoveryScope(() => setOpen(false)), []);
  if (!context) return null;
  const pane = context.panes.find(p => p.id === id);
  if (!pane || !isFileLinkedPane(pane)) return null;
  const key = paneKey(pane), peers = context.panes.filter(p => p.id !== id && (isFileLinkedPane(p) || pane.kind === 'file-browser' && isSessionPane(p)));
  return <><ResourceToolbar><ResourceAction label={t('Link file cards')} aria-haspopup="dialog" onClick={() => setOpen(v => !v)}><Link2 size={15} /></ResourceAction></ResourceToolbar>
    {open && <LinkDialog label={t('Link file cards')} close={() => setOpen(false)}>
        <header>{t('Link file cards')}<button autoFocus type="button" aria-label={t('Close')} onClick={() => setOpen(false)}><X size={16} /></button></header>
        <p>{t('Linked cards open the selected file by type. Unsaved drafts are kept.')}</p>
        {pane.kind === 'file-browser' ? <p>{t('Link a session to open its last changed directory once. Manual browsing is never overridden.')}</p> : null}
        {peers.map((other, i) => <label key={other.id}><input name="workspacefilelinks-input-1" type="checkbox" checked={!!(pane.fileLinks?.includes(paneKey(other)) || other.fileLinks?.includes(key))} onChange={() => context.toggle(key, paneKey(other))} />{isSessionPane(other) ? `${t('Session')} · ${other.sessionKey}` : `${t(fileCardLabel(other.kind))} · ${i + 1}`}</label>)}
        {!peers.length && <p>{t('Add another file or media card to link.')}</p>}
      </LinkDialog>}</>;
}

export function CoBoundSessionsBar({
  id,
  activeSessionKey,
  sessionTitles,
  onSelectSession,
}: {
  id: string;
  activeSessionKey?: string | undefined;
  sessionTitles?: ReadonlyMap<string, string> | undefined;
  onSelectSession?: ((sessionKey: string) => void) | undefined;
}) {
  const context = useContext(Context);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeRecoveryScope(() => setOpen(false)), []);
  if (!context) return null;
  const pane = context.panes.find(p => p.id === id);
  if (!pane || !isCoBindablePane(pane)) return null;
  const key = paneKey(pane);
  const sessionPanes = context.panes.filter(isSessionPane);
  const boundKeys = coBoundSessionKeys(context.panes, pane.id);
  if (sessionPanes.length === 0) return null;

  const shortLabel = (sKey: string) => {
    const title = sessionTitles?.get(sKey);
    if (title) return title.length > 18 ? `${title.slice(0, 17)}…` : title;
    const tail = sKey.split(':').pop() ?? sKey;
    return tail.length > 14 ? `${tail.slice(0, 12)}…` : tail;
  };

  return (
    <div className="workspace-cobound-bar" data-cobound-bar data-bound-count={boundKeys.length}>
      <div className="workspace-cobound-pills" role="group" aria-label={t('Co-bound sessions')}>
        {boundKeys.map(sKey => {
          const isCurrent = activeSessionKey === sKey;
          return (
            <button
              key={sKey}
              type="button"
              className="workspace-cobound-pill"
              data-active={isCurrent || undefined}
              title={`${t('Switch to session')}: ${sessionTitles?.get(sKey) ?? sKey}`}
              onClick={() => onSelectSession?.(sKey)}
            >
              <span className="workspace-cobound-dot" aria-hidden="true" />
              <span>{shortLabel(sKey)}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="workspace-cobound-manage-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={t('Share card across multiple sessions')}
          onClick={() => setOpen(v => !v)}
        >
          <Link2 size={12} />
          <span>{boundKeys.length > 0 ? `${t('Shared')} (${boundKeys.length})` : t('+ Co-bind session')}</span>
        </button>
      </div>
      {open && (
        <LinkDialog label={t('Multi-session shared binding')} close={() => setOpen(false)}>
          <header>
            {t('Multi-session shared binding')}
            <button autoFocus type="button" aria-label={t('Close')} onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </header>
          <p>{t('Bind this notebook or taskboard to multiple sessions so you can switch context with one click.')}</p>
          {sessionPanes.map(other => {
            const sKey = paneKey(other);
            const checked = boundKeys.includes(sKey);
            return (
              <label key={other.id}>
                <input
                  name={`cobind-${pane.id}-${other.id}`}
                  type="checkbox"
                  checked={checked}
                  onChange={() => context.toggle(key, sKey)}
                />
                <span>{sessionTitles?.get(sKey) ?? sKey}</span>
              </label>
            );
          })}
        </LinkDialog>
      )}
    </div>
  );
}
