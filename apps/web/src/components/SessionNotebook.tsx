import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction, type ReactNode, type PointerEvent } from 'react';
import { NotebookPopover } from './NotebookPopover';
import { RenderRecoveryBoundary } from './RenderRecoveryBoundary';
import NotebookArchiveToggle from './NotebookArchiveToggle';
import { createPortal, flushSync } from 'react-dom';
import { Check, GripHorizontal, Maximize2, Minimize2, Minus, Palette, Pencil, Plus, StickyNote, X } from 'lucide-react';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, validHubNotebookLayout, type HubNotebookLayout, type SessionNotebookDocument } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import type { NotebookReadingTransfer } from '../lib/remote-draft';
import type { NotebookArchiveSelection } from '../lib/notebook-selection';
import { boundNotebookPosition, NotebookRegistry, NOTEBOOK_MAX_CHARS, readCachedNotebookDocument, writeCachedNotebookDocument, type NotebookDependencies } from '../lib/session-notebook';
import { NOTEBOOK_COLORS, resizeNotebook, type NotebookResizeEdge } from '../lib/notebook-presentation';
import { usePaneHoverFocus } from '../lib/use-pane-hover-focus';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { useFileCardGuard } from '../lib/workspace-file-card-context';
import { CaptionIconButton } from './CaptionIconButton';
import { usePaneToolbarTarget } from './PaneToolbar';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
const NotebookEditor = lazy(() => import('./NotebookEditor'));
const NotebookArchive = lazy(() => import('./NotebookArchive'));

const GlobalNotebookContext = createContext<ReactNode>(null);
const NotebookPausedContext = createContext(false);
const NotebookRegistryContext = createContext<NotebookRegistry | null>(null);
const NotebookCatalogContext = createContext<SessionNotebookDocument[]>([]);
const NotebookCatalogUpdateContext = createContext<Dispatch<SetStateAction<SessionNotebookDocument[]>>>(() => {});
export function useNotebookCatalogUpdate() {
  return useContext(NotebookCatalogUpdateContext);
}
type NotebookPlacement = (id: string, x: number, y: number, action: 'preview' | 'commit' | 'cancel') => boolean;
type NotebookWorkspace = { hosts: ReadonlyMap<string, HTMLElement>; host: (id: string, element: HTMLElement | null) => void;
  placement: { current: NotebookPlacement | undefined } };
const NotebookWorkspaceContext = createContext<NotebookWorkspace | null>(null);
export function useNotebookWorkspace() { return useContext(NotebookWorkspaceContext); }
export function useNotebookCatalog() {
  const items = useContext(NotebookCatalogContext);
  return useMemo(() => items.flatMap(document => {
    try {
      const identity: unknown = JSON.parse(document.resourceId), layout: unknown = JSON.parse(document.text);
      if (!Array.isArray(identity) || identity[0] !== 'hub-notebook-layout' || typeof identity[2] !== 'string') return [];
      return [{ id: identity[2], title: validHubNotebookLayout(layout) ? layout.title : '', hidden: validHubNotebookLayout(layout) ? layout.hidden : true, document }];
    } catch { return []; }
  }), [items]);
}

export function useNotebookController(key: string, dependencies: Omit<NotebookDependencies, 'current'>) {
  const registry = useContext(NotebookRegistryContext);
  if (!registry) throw new Error('Notebook requires its authenticated provider');
  const controller = useMemo(() => registry.get(key, dependencies), [registry, key]);
  useEffect(() => registry.retain(key, controller), [registry, key, controller]);
  return controller;
}

function SessionNotebookArchive(props: { sessionKey?: string; id?: string; hotController: import('../lib/session-notebook').NotebookController;
  selection?: NotebookArchiveSelection | undefined; onSelectionHandled: () => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useI18n();
  const paused = useContext(NotebookPausedContext);
  return <NotebookArchiveToggle openRequest={props.selection?.requestId}><RenderRecoveryBoundary scope="notebook"><Suspense fallback={<p>{t('Loading notebook…')}</p>}><NotebookArchive {...props} paused={paused} /></Suspense></RenderRecoveryBoundary></NotebookArchiveToggle>;
}

/** Keep the global controller/panel mounted across navigation and layout changes. */
export function GlobalNotebookProvider({ children, paused = false }: { children: ReactNode; paused?: boolean }) {
  const { t } = useI18n();
  const [items, setItems] = useState<SessionNotebookDocument[]>([]), [show, setShow] = useState(false), [error, setError] = useState(false), [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const pendingId = useRef<string | undefined>(undefined);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const scope = recoveryScope();
  const [hosts, setHosts] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const placement = useRef<NotebookPlacement | undefined>(undefined);
  const host = useCallback((id: string, element: HTMLElement | null) => setHosts(previous => {
    if (previous.get(id) === element || (!element && !previous.has(id))) return previous;
    const next = new Map(previous); if (element) next.set(id, element); else next.delete(id); return next;
  }), []);
  const workspace = useMemo(() => ({ hosts, host, placement }), [hosts, host]);
  const registry = useMemo(() => new NotebookRegistry(() => !pausedRef.current && recoveryScope() === scope), [scope]);
  usePageRefreshGuard(() => !creating && !registry.dirty());
  useLayoutEffect(() => {
    if (paused) { registry.suspend(); return; }
    registry.resume();
    const unload = (event: BeforeUnloadEvent) => { if (registry.dirty()) { event.preventDefault(); event.returnValue = ''; } };
    const hide = () => { if (document.visibilityState === 'hidden') registry.flush(); };
    window.addEventListener('beforeunload', unload); window.addEventListener('online', registry.retry); document.addEventListener('visibilitychange', hide);
    return () => { registry.suspend(); window.removeEventListener('beforeunload', unload); window.removeEventListener('online', registry.retry); document.removeEventListener('visibilitychange', hide); };
  }, [registry, paused]);
  useEffect(() => {
    if (paused) { setShow(false); return; }
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        let after: string | undefined; const rows: SessionNotebookDocument[] = [];
        do { const result = await api.hubNotebooks(after); if (!active || scope !== recoveryScope()) return; rows.push(...result.items); after = result.nextCursor ?? undefined; } while (after);
        setItems(rows); setError(false);
      } catch { if (active) { setError(true); timer = setTimeout(() => void load(), 15_000); } }
    };
    void load(); const online = () => { clearTimeout(timer); void load(); }; window.addEventListener('online', online);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('online', online); };
  }, [scope, paused, reload]);
  async function create() {
    if (creating || paused) return;
    setCreating(true);
    const id = pendingId.current ?? crypto.randomUUID(); pendingId.current = id;
    try {
      // Retain the ID if the response is lost. A retry reconciles, never creates
      // a second note for an uncertain first creation.
      const existing = await api.hubNotebookById(id, true);
      const saved = existing.revision ? existing : await api.saveHubNotebookById(id, { resourceId: existing.resourceId, revision: existing.revision, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, hidden: false, x: 80 + items.length % 8 * 24, y: 80 + items.length % 8 * 24 }) }, true);
      if (scope !== recoveryScope() || pausedRef.current) return;
      setItems(current => [...current.filter(item => item.resourceId !== saved.resourceId), saved]); pendingId.current = undefined; setError(false); setShow(false);
    } catch { setError(true); } finally { setCreating(false); }
  }
  const trigger = !paused && <button type="button" className="notebook-trigger notebook-trigger--global" aria-label={t('Global notebook')} aria-expanded={show} onClick={() => setShow(value => !value)}><StickyNote size={15} /><span>{t('Global notes')}</span></button>;
  return <NotebookRegistryContext.Provider value={registry}><NotebookWorkspaceContext.Provider value={workspace}><NotebookCatalogContext.Provider value={paused ? [] : items}><NotebookCatalogUpdateContext.Provider value={setItems}><NotebookPausedContext.Provider value={paused}><GlobalNotebookContext.Provider value={trigger}>{children}</GlobalNotebookContext.Provider>
    {createPortal(<section className={`global-notebook-manager ${show && !paused ? '' : 'is-hidden'}`} aria-label={t('Global notes')}>
      <header><strong>{t('Global notes')}</strong><button type="button" aria-label={t('Close')} onClick={() => setShow(false)}><X size={16} /></button></header>
      <button type="button" className="notebook-new" disabled={creating} onClick={() => void create()}><Plus size={15} />{t(creating ? 'Saving…' : 'New notebook')}</button>
      {error && <button type="button" onClick={() => setReload(value => value + 1)}>{t('Notebook unavailable · retrying automatically')}</button>}
      <div className="global-notebook-list">{items.map(item => <GlobalNotebookItem key={item.resourceId} initial={item} />)}</div>
    </section>, document.body)}
  </NotebookPausedContext.Provider></NotebookCatalogUpdateContext.Provider></NotebookCatalogContext.Provider></NotebookWorkspaceContext.Provider></NotebookRegistryContext.Provider>;
}
export function GlobalNotebookTrigger() { return useContext(GlobalNotebookContext); }

export function SessionNotebook(props: { sessionKey: string; title: string; caption?: boolean }) { return <Notebook {...props} />; }

export function WorkspaceNotebook({ sessionKey, globalId, initial, title, onActivate }: { sessionKey?: string; globalId?: string; initial?: SessionNotebookDocument; title: string; onActivate?: () => void }) {
  return initial ? <GlobalNotebookHost id={JSON.parse(initial.resourceId)[2] as string} onActivate={onActivate} /> : <Notebook {...(sessionKey ? { sessionKey } : {})} {...(globalId ? { globalId } : {})} title={title} embedded />;
}

function GlobalNotebookHost({ id, onActivate }: { id: string; onActivate?: (() => void) | undefined }) {
  const workspace = useNotebookWorkspace();
  const registry = useContext(NotebookRegistryContext);
  useFileCardGuard(() => !!registry?.ready([`layout:${id}`, JSON.stringify(['content', 'hub', id])]));
  const host = useRef<HTMLDivElement | null>(null);
  const register = useCallback((element: HTMLDivElement | null) => { host.current = element; workspace?.host(id, element); }, [workspace?.host, id]);
  // Portals keep their React ancestry. Native focus/press listeners intentionally
  // bridge only activation to the workspace, not editor input or save events.
  useEffect(() => {
    const element = host.current;
    if (!element || !onActivate) return;
    element.addEventListener('focusin', onActivate); element.addEventListener('pointerdown', onActivate);
    return () => { element.removeEventListener('focusin', onActivate); element.removeEventListener('pointerdown', onActivate); };
  }, [onActivate]);
  return <div className="workspace-notebook-host" ref={register} />;
}

function GlobalNotebookItem({ initial }: { initial: SessionNotebookDocument }) {
  const { t } = useI18n();
  const paused = useContext(NotebookPausedContext);
  const updateCatalog = useContext(NotebookCatalogUpdateContext);
  const scope = recoveryScope(), id = JSON.parse(initial.resourceId)[2] as string;
  const layoutCacheKey = JSON.stringify([scope, 'layout', id]);
  if (!readCachedNotebookDocument(layoutCacheKey)) writeCachedNotebookDocument(layoutCacheKey, initial);
  const workspace = useNotebookWorkspace();
  const host = workspace?.hosts.get(id);
  const controller = useNotebookController(`layout:${id}`, {
    read: () => api.hubNotebookById(id, true), write: value => api.saveHubNotebookById(id, value, true),
    storage: () => localStorage, key: `agentopsdeck.notebook-layout-draft:${JSON.stringify([scope, id])}`,
    cacheKey: layoutCacheKey,
  });
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const fileRevision = useWorkspaceBoardRevision(scope ?? '', workspaceFileCardResource('notebook', `hub:${id}`), 'card-file-binding');
  useEffect(() => { if (fileRevision.notice && !paused) void controller.reconcile(); }, [fileRevision.notice, controller, paused]);
  useEffect(() => {
    if (paused || !state.document) return;
    const document = { ...state.document, text: state.text };
    updateCatalog(items => items.some(item => item.resourceId === document.resourceId && (item.text !== document.text || item.revision !== document.revision))
      ? items.map(item => item.resourceId === document.resourceId ? document : item) : items);
  }, [paused, state.document, state.text, updateCatalog]);
  useEffect(() => {
    if (paused) return;
    if (controller.get().phase === 'closed' || controller.get().phase === 'error' || controller.needsRevalidate()) void controller.load();
  }, [controller, paused]);
  const parsed = useMemo(() => { try { const value: unknown = JSON.parse(state.document ? state.text : initial.text); return validHubNotebookLayout(value) ? value : DEFAULT_HUB_NOTEBOOK_LAYOUT; } catch { return DEFAULT_HUB_NOTEBOOK_LAYOUT; } }, [state.document, state.text, initial.text]);
  const update = (change: Partial<HubNotebookLayout>) => {
    const current = controller.get();
    if (!current.document) return;
    // Pointer/resize events can arrive before React renders the last change.
    // Merge with the controller's latest draft, not a stale rendered layout.
    try { const value: unknown = JSON.parse(current.text); if (validHubNotebookLayout(value)) controller.edit(JSON.stringify({ ...value, ...change })); } catch { /* Invalid remote layout must not overwrite its saved document. */ }
  };
  const notice = state.phase === 'conflict' ? <div className="notebook-conflict"><p>{t('Notebook changed elsewhere')}</p><button type="button" onClick={() => controller.resolve(false)}>{t('Use saved version')}</button><button type="button" onClick={() => controller.resolve(true)}>{t('Save my draft instead')}</button></div>
    : state.phase === 'error' ? <p role="status">{t('Notebook unavailable · retrying automatically')}</p>
      : controller.dirty() ? <p role="status">{t('Saving…')}</p> : null;
  return <Notebook globalId={id} title={parsed.title || t('Global notebook')} layout={parsed} onLayout={update} layoutNotice={notice} layoutReady={!!state.document} embedded={!!host} workspaceHost={host} />;
}

function Notebook({ sessionKey, globalId, title, renderTrigger, layout, onLayout, layoutNotice, layoutReady = true, embedded = false, workspaceHost, caption = false }: { sessionKey?: string; globalId?: string; title: string; renderTrigger?: (trigger: ReactNode) => ReactNode; layout?: HubNotebookLayout; onLayout?: (change: Partial<HubNotebookLayout>) => void; layoutNotice?: ReactNode; layoutReady?: boolean; embedded?: boolean; workspaceHost?: HTMLElement | undefined; caption?: boolean }) {
  const inheritedToolbar = usePaneToolbarTarget();
  // Global notes keep their original React root when docked, so their caption
  // slot is resolved from the stable host, not from a different context tree.
  const toolbar = workspaceHost?.closest('.session-workspace-pane')?.querySelector('.session-pane-custom-actions') ?? inheritedToolbar;
  const { t } = useI18n();
  const hoverFocus = usePaneHoverFocus(true);
  const paused = useContext(NotebookPausedContext);
  const workspace = useNotebookWorkspace();
  // A constant portal container keeps ProseMirror, undo/selection and the writer
  // alive. Only this empty host moves; React never reparents the editor tree.
  const [portal] = useState(() => globalId && (!embedded || workspaceHost) ? document.createElement('div') : undefined);
  const previousFocus = useRef<HTMLElement | undefined>(undefined);
  useLayoutEffect(() => {
    if (!portal || (embedded && !workspaceHost)) return;
    portal.className = workspaceHost ? 'notebook-portal notebook-portal--docked' : 'notebook-portal';
    const focused = portal.contains(document.activeElement) ? document.activeElement as HTMLElement : previousFocus.current;
    (workspaceHost ?? document.body).appendChild(portal);
    if (focused && portal.contains(focused)) focused.focus({ preventScroll: true });
    previousFocus.current = undefined;
    return () => { previousFocus.current = portal.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined; };
  }, [portal, workspaceHost]);
  useLayoutEffect(() => () => { portal?.remove(); }, [portal]);
  const global = sessionKey === undefined;
  const label = t(global ? 'Global notebook' : 'Session notebook');
  const scope = recoveryScope();
  const viewKey = `agentopsdeck.notebook-view:${JSON.stringify([scope, globalId ? `notebook:${globalId}` : sessionKey])}`;
  const initialView = useMemo(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(viewKey) ?? 'null');
      if (value && typeof value.open === 'boolean' && typeof value.collapsed === 'boolean'
        && Number.isFinite(value.x) && Number.isFinite(value.y)) return value as { open: boolean; collapsed: boolean; x: number; y: number };
    } catch { /* Position is optional; draft storage failures are shown separately. */ }
    return { open: false, collapsed: false, x: Math.max(8, window.innerWidth - (global ? 432 : 400)), y: global ? 64 : 100 };
  }, [viewKey]);
  const [localLayout, setLocalLayout] = useState<HubNotebookLayout>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem(`${viewKey}:appearance`) ?? 'null'); if (validHubNotebookLayout(value)) return value; } catch { /* Optional view preferences. */ }
    return DEFAULT_HUB_NOTEBOOK_LAYOUT;
  });
  const appearance = layout ?? localLayout;
  const updateAppearance = (change: Partial<HubNotebookLayout>) => {
    if (onLayout) onLayout(change);
    else setLocalLayout(previous => { const next = { ...previous, ...change }; try { localStorage.setItem(`${viewKey}:appearance`, JSON.stringify(next)); } catch { /* Content uses the separate durable controller. */ } return next; });
  };
  const [renaming, setRenaming] = useState(false), [nameDraft, setNameDraft] = useState('');
  const [autoCollapse, setAutoCollapse] = useState(() => { try { return localStorage.getItem(`${viewKey}:auto-collapse`) === 'true'; } catch { return false; } });
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [opening, setOpening] = useState(false);
  const noteTitle = appearance.title || (globalId ? title : label);
  const rename = () => { setNameDraft(appearance.title || noteTitle); setRenaming(true); };
  const saveName = () => { updateAppearance({ title: nameDraft.trim().slice(0, 120) }); setRenaming(false); };
  const controller = useNotebookController(JSON.stringify(['content', global ? 'hub' : 'session', globalId ?? sessionKey ?? 'default']), {
    read: () => globalId ? api.hubNotebookById(globalId) : sessionKey === undefined ? api.hubNotebook() : api.sessionNotebook(sessionKey),
    write: value => globalId ? api.saveHubNotebookById(globalId, value) : sessionKey === undefined ? api.saveHubNotebook(value) : api.saveSessionNotebook(sessionKey, value),
    storage: () => sessionStorage,
    key: `agentopsdeck.notebook-draft:${JSON.stringify([scope, globalId && globalId !== 'default' ? `notebook:${globalId}` : sessionKey])}`,
    cacheKey: JSON.stringify([scope, 'content', global ? 'hub' : 'session', globalId ?? sessionKey ?? 'default']),
  });
  const fileRevision = useWorkspaceBoardRevision(scope ?? '', workspaceFileCardResource('notebook', global ? `hub:${globalId ?? 'default'}` : `session:${sessionKey}`), 'card-file-binding');
  useEffect(() => { if (fileRevision.notice && !paused) void controller.reconcile(); }, [fileRevision.notice, controller, paused]);
  useEffect(() => {
    if (paused) return;
    const onExternalSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: 'session' | 'hub'; id?: string }>).detail;
      const expectedTarget = global ? 'hub' : 'session';
      const expectedId = globalId ?? sessionKey ?? 'default';
      if (!detail || detail.target === expectedTarget && (detail.id || 'default') === expectedId) {
        void controller.reconcile();
      }
    };
    window.addEventListener('agentopsdeck:notebook-updated', onExternalSaved);
    return () => window.removeEventListener('agentopsdeck:notebook-updated', onExternalSaved);
  }, [controller, paused, global, globalId, sessionKey]);
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const [localOpen, setLocalOpen] = useState(initialView.open), [localCollapsed, setLocalCollapsed] = useState(initialView.collapsed);
  const [localPosition, setLocalPosition] = useState({ x: initialView.x, y: initialView.y });
  const open = embedded || (layout ? !layout.hidden : localOpen), explicitlyCollapsed = !embedded && (layout?.collapsed ?? localCollapsed);
  const collapsed = !embedded && (explicitlyCollapsed || (autoCollapse && !hovered && !focused && !renaming && !opening && state.phase !== 'conflict'));
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const position = dragPosition ?? (layout ? { x: layout.x, y: layout.y } : localPosition);
  const positionRef = useRef(position); positionRef.current = position;
  const layoutUpdateRef = useRef(onLayout); layoutUpdateRef.current = onLayout;
  const setOpen = (value: boolean) => onLayout ? onLayout({ hidden: !value }) : setLocalOpen(value);
  const setCollapsed = (value: boolean) => onLayout ? onLayout({ collapsed: value }) : setLocalCollapsed(value);
  const setPosition = (value: { x: number; y: number }) => onLayout ? onLayout(value) : setLocalPosition(value);
  const [menu, setMenu] = useState(false);
  const [archiveSelection, setArchiveSelection] = useState<NotebookArchiveSelection>();
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => typeof window !== 'undefined' && window.innerWidth < 700);
  const [mobileSheet, setMobileSheet] = useState(() => typeof window !== 'undefined' && window.innerWidth < 700);
  const lastMobileViewport = useRef(isMobileViewport);
  const appearanceTrigger = useRef<HTMLButtonElement>(null);
  const manualFocus = useRef(false);
  const [height, setHeight] = useState(window.innerHeight - 16);
  const panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), editorFocus = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const element = panel.current;
    if (!element || !open || paused) return;
    const receive = (event: Event) => {
      if (recoveryScope() !== scope || !element.isConnected) return;
      const detail = (event as CustomEvent<NotebookReadingTransfer>).detail;
      detail.result = controller.prependReading(detail.text);
    };
    element.addEventListener('agentopsdeck:notebook-reading', receive);
    return () => element.removeEventListener('agentopsdeck:notebook-reading', receive);
  }, [controller, open, paused, scope, embedded]);
  useEffect(() => {
    const element = panel.current;
    if (!element || !open || paused) return;
    const focus = () => {
      flushSync(() => { setCollapsed(false); setFocused(true); });
      // Remote acknowledgements are synchronous; Tiptap's normal focus command
      // schedules the DOM focus for a later frame and cannot confirm delivery.
      element.querySelector<HTMLElement>('.tiptap[contenteditable="true"]')?.focus({ preventScroll: true });
    };
    element.addEventListener('agentopsdeck:remote-focus', focus);
    return () => element.removeEventListener('agentopsdeck:remote-focus', focus);
  }, [open, paused, onLayout]);
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | undefined>(undefined);
  const resizing = useRef<{ id: number; x: number; y: number; width: number; height: number } | undefined>(undefined);
  const viewport = () => ({ left: window.visualViewport?.offsetLeft ?? 0, top: window.visualViewport?.offsetTop ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight });
  const move = (x: number, y: number) => {
    const bounds = panel.current?.getBoundingClientRect();
    setPosition(boundNotebookPosition(x, y, bounds?.width ?? 360, bounds?.height ?? 360, viewport()));
  };
  const cancelDrag = useCallback(() => {
    if (!drag.current) return;
    if (globalId) workspace?.placement.current?.(globalId, 0, 0, 'cancel');
    drag.current = undefined; setDragPosition(undefined);
  }, [globalId, workspace?.placement]);
  useEffect(() => {
    if (!open || embedded) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancelDrag(); } };
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', cancelDrag);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', cancelDrag); };
  }, [cancelDrag, open, embedded]);
  const titleDrag = {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: position.x, startY: position.y, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const start = drag.current;
      if (start?.id !== event.pointerId || (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 5)) return;
      start.moved = true;
      const bounds = panel.current?.getBoundingClientRect();
      setDragPosition(boundNotebookPosition(start.startX + event.clientX - start.x, start.startY + event.clientY - start.y, bounds?.width ?? 360, bounds?.height ?? 360, viewport()));
      if (globalId) workspace?.placement.current?.(globalId, event.clientX, event.clientY, 'preview');
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const start = drag.current;
      if (start?.id !== event.pointerId) return;
      if (start.moved && !(globalId && workspace?.placement.current?.(globalId, event.clientX, event.clientY, 'commit'))) {
        move(start.startX + event.clientX - start.x, start.startY + event.clientY - start.y);
      }
      cancelDrag();
    }, onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag,
  };
  useEffect(() => {
    if (embedded || drag.current) return;
    try { sessionStorage.setItem(viewKey, JSON.stringify({ open, collapsed: explicitlyCollapsed, ...position })); } catch { /* Nonessential layout only. */ }
  }, [viewKey, open, explicitlyCollapsed, position, embedded]);
  useEffect(() => { if (open && !paused && (controller.get().phase === 'closed' || controller.needsRevalidate())) void controller.load(); }, [open, controller, paused]);
  const loaded = Boolean(state.document);
  useFileCardGuard(() => !controller.dirty() && state.phase === 'ready');
  const canFocusEditor = loaded && state.phase !== 'loading' && state.phase !== 'conflict';
  useEffect(() => { if (open && !explicitlyCollapsed && canFocusEditor && manualFocus.current && editorFocus.current) { editorFocus.current(); manualFocus.current = false; } }, [open, explicitlyCollapsed, canFocusEditor]);
  useEffect(() => {
    if (!open || embedded) return;
    const fit = () => {
      const mobileNow = window.innerWidth < 700;
      setIsMobileViewport(mobileNow);
      if (mobileNow !== lastMobileViewport.current) {
        lastMobileViewport.current = mobileNow;
        setMobileSheet(mobileNow);
      }
      setHeight(viewport().height - 16);
      if (mobileNow && mobileSheet) return;
      const current = positionRef.current, rect = panel.current?.getBoundingClientRect();
      const next = boundNotebookPosition(current.x, current.y, rect?.width ?? 360, Math.min(rect?.height ?? 360, viewport().height - 16), viewport());
      if (next.x !== current.x || next.y !== current.y) {
        if (layoutUpdateRef.current) layoutUpdateRef.current(next); else setLocalPosition(next);
      }
    };
    fit(); window.addEventListener('resize', fit); window.visualViewport?.addEventListener('resize', fit); window.visualViewport?.addEventListener('scroll', fit);
    return () => { window.removeEventListener('resize', fit); window.visualViewport?.removeEventListener('resize', fit); window.visualViewport?.removeEventListener('scroll', fit); };
  }, [open, collapsed, layoutReady, appearance.width, appearance.height, embedded, mobileSheet]);
  const close = () => { manualFocus.current = false; setOpening(false); setHovered(false); setFocused(false); setOpen(false); void controller.flush(); trigger.current?.focus(); };
  useEffect(() => {
    if (!opening) return;
    // An explicit open keeps the editor visible until its lazy load can focus
    // it. If the user moves on while loading, don't steal focus afterwards.
    const departed = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) { manualFocus.current = false; setOpening(false); }
    };
    document.addEventListener('pointerdown', departed); document.addEventListener('focusin', departed);
    return () => { document.removeEventListener('pointerdown', departed); document.removeEventListener('focusin', departed); };
  }, [opening]);
  // Removing the focused appearance/rename control does not reliably emit a
  // blur event. Reconcile against the actual focus so auto-collapse can't stick.
  useEffect(() => { setFocused(Boolean(panel.current?.contains(document.activeElement))); }, [menu, renaming, open, explicitlyCollapsed]);
  useEffect(() => {
    if (!open || !autoCollapse) return;
    // Menus/drag pointer capture can remove a hovered descendant before React
    // emits pointerleave. Actual pointer coordinates are authoritative.
    const trackPointer = (event: globalThis.PointerEvent) => {
      const rect = panel.current?.getBoundingClientRect();
      setHovered(event.pointerType !== 'touch' && Boolean(rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
    };
    document.addEventListener('pointermove', trackPointer, { passive: true });
    return () => document.removeEventListener('pointermove', trackPointer);
  }, [open, autoCollapse]);
  const status = state.phase === 'closed' || state.phase === 'loading' ? t('Loading notebook…') : state.phase === 'saving' ? t('Saving…')
    : state.phase === 'conflict' ? t('Notebook changed elsewhere') : state.phase === 'error' ? t(state.document ? 'Notebook unavailable · draft retained' : 'Notebook unavailable')
      : controller.dirty() ? t('Unsaved changes') : t('Saved to Hub');
  const toggleNotebook = () => {
        if (embedded) { editorFocus.current?.(); return; }
        if (open) close(); else { manualFocus.current = true; setOpening(true); setCollapsed(false); setOpen(true); void controller.load(); }
      };
  const triggerButton = caption ? <CaptionIconButton priority={90} ref={trigger} disabled={!layoutReady} className={`notebook-trigger ${open ? 'is-open' : ''}`} label={label} aria-haspopup="dialog" aria-expanded={open} onClick={toggleNotebook}><StickyNote size={14} aria-hidden="true" /></CaptionIconButton>
    : <button ref={trigger} type="button" disabled={!layoutReady} className={`notebook-trigger ${global ? 'notebook-trigger--global' : ''} ${open ? 'is-open' : ''}`} title={label}
      aria-label={globalId ? title : label} aria-expanded={open} onClick={toggleNotebook}><StickyNote size={15} style={layout ? { color: layout.color, fill: layout.color, stroke: '#64748b' } : undefined} /><span>{globalId ? title : t(global ? 'Global notes' : 'Notes')}</span></button>;
  const mountPanel = (content: ReactNode) => portal ? createPortal(content, portal) : embedded ? content : createPortal(content, document.body);
  const dedicatedMobile = !embedded && isMobileViewport && mobileSheet;
  const currentViewport = viewport();
  return <>
    {(!embedded || globalId) && (renderTrigger ? renderTrigger(paused ? null : triggerButton) : !paused && triggerButton)}
    {open && !paused && mountPanel(<section ref={panel} className={`session-notebook ${embedded ? 'session-notebook--embedded' : ''} ${!embedded && mobileSheet ? 'is-mobile-sheet' : ''} ${dedicatedMobile ? 'is-mobile-dedicated' : ''} ${collapsed ? 'is-collapsed' : ''} ${(parseInt(appearance.color.slice(1, 3), 16) * .299 + parseInt(appearance.color.slice(3, 5), 16) * .587 + parseInt(appearance.color.slice(5, 7), 16) * .114 < 140) ? 'notebook-dark' : ''}`}
      data-remote-notebook={globalId} role={embedded ? 'region' : 'dialog'} aria-label={globalId ? title : label} style={embedded ? { background: appearance.color, opacity: appearance.opacity } : dedicatedMobile ? (collapsed ? { left: 8, right: 8, top: 'auto', bottom: 8, width: Math.max(220, currentViewport.width - 16), maxWidth: Math.max(220, currentViewport.width - 16), height: 'auto', maxHeight: height, background: appearance.color, opacity: appearance.opacity } : { left: Math.max(0, Math.round(currentViewport.left)), top: Math.max(0, Math.round(currentViewport.top)), width: Math.round(currentViewport.width), maxWidth: Math.round(currentViewport.width), height: Math.max(180, Math.round(currentViewport.height)), maxHeight: Math.max(180, Math.round(currentViewport.height)), background: appearance.color, opacity: appearance.opacity }) : mobileSheet ? { left: 8, top: Math.max(8, Math.round(window.innerHeight * 0.14)), maxHeight: height,
        width: Math.max(240, window.innerWidth - 16), height: collapsed ? 'auto' : Math.max(220, Math.round(window.innerHeight * 0.82)), background: appearance.color, opacity: appearance.opacity } : { left: Math.max(8, Math.min(position.x, window.innerWidth - Math.min(appearance.width, window.innerWidth - 16) - 8)), top: Math.max(8, Math.min(position.y, window.innerHeight - 100)), maxHeight: height,
        width: appearance.width, height: collapsed ? 'auto' : appearance.height, background: appearance.color, opacity: appearance.opacity }}
      onPointerMoveCapture={event => hoverFocus.move(event, !!drag.current || !!resizing.current)}
      onPointerDownCapture={hoverFocus.cancel}
      onPointerEnter={() => setHovered(true)} onPointerLeave={event => { hoverFocus.leave(event); setHovered(false); setFocused(Boolean(panel.current?.contains(document.activeElement))); }}
      onFocusCapture={() => { setFocused(true); setOpening(false); }} onBlurCapture={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        // ProseMirror and toolbar updates can temporarily report a null blur
        // target. Decide after the focus transaction, not in its middle.
        queueMicrotask(() => {
          const inside = Boolean(panel.current?.contains(document.activeElement));
          setFocused(inside);
          if (!inside) { setMenu(false); void controller.flush(); }
        });
      }}
      onContextMenu={event => { if (!(event.target instanceof HTMLElement && event.target.closest('textarea,input,a,[contenteditable]'))) { event.preventDefault(); setMenu(value => !value); } }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (renaming) setRenaming(false); else if (menu) setMenu(false); else if (!embedded) close(); } }}>
      {embedded && toolbar && createPortal(<button ref={appearanceTrigger} type="button" aria-label={t('Notebook appearance')} title={t('Notebook appearance')} aria-expanded={menu} onClick={() => setMenu(value => !value)}><Palette size={14} /></button>, toolbar)}
      {(!embedded || renaming) && <header className="notebook-header">
        {!embedded && !dedicatedMobile && <button type="button" className="notebook-drag" aria-label={t('Move notebook')} title={t('Drag to move · arrow keys also work')} {...titleDrag}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); const step = event.shiftKey ? 40 : 12;
            move(position.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
              position.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
          }}><GripHorizontal size={16} /></button>}
        {dedicatedMobile && <span className="notebook-mobile-kind-badge">{t(global ? 'Global notes' : 'Session notes')}</span>}
        <div className="notebook-title">{renaming ? <input name="sessionnotebook-input-1" autoFocus aria-label={t('Notebook name')} maxLength={120} value={nameDraft}
          onChange={event => setNameDraft(event.target.value)} onBlur={saveName}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false); } }} />
          : <button type="button" {...(embedded || dedicatedMobile ? {} : titleDrag)} onDoubleClick={rename} onKeyDown={event => { if (event.key === 'F2' || event.key === 'Enter') { event.preventDefault(); rename(); } }} title={t('Double-click to rename')}><strong>{noteTitle}</strong></button>}</div>
        {dedicatedMobile && !renaming && <button type="button" className="notebook-mobile-rename" aria-label={t('Rename')} title={t('Rename')} onClick={rename}><Pencil size={13} /></button>}
        <button ref={appearanceTrigger} type="button" aria-label={t('Notebook appearance')} title={t('Notebook appearance')} aria-expanded={menu} onClick={() => setMenu(value => !value)}><Palette size={14} /></button>
        {!embedded && <><button type="button" className="notebook-sheet-toggle" aria-label={t(mobileSheet ? 'Restore floating notebook' : 'Full-width notebook sheet')} title={t(mobileSheet ? 'Restore floating notebook' : 'Full-width notebook sheet')} aria-pressed={mobileSheet} onClick={() => setMobileSheet(value => !value)}>{mobileSheet ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        <button type="button" aria-label={t(explicitlyCollapsed ? 'Expand notebook' : 'Minimize notebook')} onClick={() => setCollapsed(!explicitlyCollapsed)}><Minus size={15} /></button>
        <button type="button" aria-label={t('Close notebook')} onClick={close}><X size={15} /></button></>}
      </header>}
      {menu && <NotebookPopover anchor={appearanceTrigger.current ? appearanceTrigger : panel} onClose={() => setMenu(false)} className="notebook-appearance" label={t('Notebook appearance')}>
        {!embedded && <label className="notebook-auto-collapse"><input name="sessionnotebook-input-2" type="checkbox" checked={autoCollapse} onChange={event => { const next = event.target.checked; setAutoCollapse(next); try { localStorage.setItem(`${viewKey}:auto-collapse`, String(next)); } catch { /* Optional presentation setting. */ } }} />{t('Auto-collapse when away')}</label>}
        <div className="notebook-swatches" aria-label={t('Color')}>{NOTEBOOK_COLORS.map((color, index) => <button key={color} type="button" style={{ background: color }} aria-label={t('Note color {number}', { number: index + 1 })} aria-pressed={appearance.color === color} onClick={() => updateAppearance({ color })}>{appearance.color === color && <Check size={14} />}</button>)}<label title={t('Custom color')}><input name="sessionnotebook-input-3" aria-label={t('Custom color')} type="color" value={appearance.color} onChange={event => updateAppearance({ color: event.target.value })} /></label></div>
        <label className="notebook-opacity"><span>{t('Opacity')}<output>{Math.round(appearance.opacity * 100)}%</output></span><input name="sessionnotebook-input-4" aria-label={t('Opacity')} type="range" min=".35" max="1" step=".05" value={appearance.opacity} onChange={event => updateAppearance({ opacity: Number(event.target.value) })} /></label>
        <button type="button" onClick={() => { setMenu(false); rename(); }}>{t('Rename')}</button>
        {!embedded && <button type="button" onClick={() => { setMenu(false); close(); }}>{t('Hide notebook')}</button>}
        <button type="button" onClick={() => setMenu(false)}>{t('Done')}</button>
      </NotebookPopover>}
      {layoutNotice}
      <div className="notebook-body" style={collapsed ? { display: 'none' } : undefined}>
        <RenderRecoveryBoundary scope="notebook" fallback={<>
          <p>{t('Plain-text mode · formatting is preserved as Markdown. Changes use the normal notebook save flow.')}</p>
          <textarea aria-label={t(global ? 'Global notes' : 'Session notes')} value={state.text} maxLength={NOTEBOOK_MAX_CHARS}
            disabled={paused || archiveBusy || !state.document || state.phase === 'loading' || state.phase === 'conflict'}
            onChange={event => controller.edit(event.target.value)}
            onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void controller.flush(); } }} />
        </>}>
        <Suspense fallback={<p role="status">{t('Loading notebook…')}</p>}><NotebookEditor key={JSON.stringify([scope, state.document?.resourceId])} foldKey={state.document?.resourceId} text={state.text} disabled={paused || archiveBusy || !state.document || state.phase === 'loading' || state.phase === 'conflict'} label={t(global ? 'Global notes' : 'Session notes')} onArchive={setArchiveSelection} onChange={text => controller.edit(text)} onSave={() => void controller.flush()} onReady={focus => { editorFocus.current = focus; if (focus && manualFocus.current && canFocusEditor) { focus(); manualFocus.current = false; } }} /></Suspense>
        </RenderRecoveryBoundary>
        {state.phase === 'conflict' && state.remote && <div className="notebook-conflict" role="alert">
          <p>{t(state.remote.resourceId !== state.document?.resourceId ? 'This session now points to a different Connector. Copy your old draft before loading its notebook.' : 'Another tab saved this note. Compare before choosing which version to keep.')}</p>
          <details><summary>{t('View saved version')}</summary><pre>{state.remote.text || t('Empty note')}</pre></details>
          <div><button type="button" onClick={() => controller.resolve(false)}>{t('Use saved version')}</button>
            {state.remote.resourceId === state.document?.resourceId && <button type="button" onClick={() => controller.resolve(true)}>{t('Save my draft instead')}</button>}</div>
        </div>}
        {state.localUnavailable && <p role="alert">{t('Local draft backup unavailable. Keep this page open until saved.')}</p>}
        <SessionNotebookArchive hotController={controller} selection={archiveSelection} onSelectionHandled={() => setArchiveSelection(undefined)} onBusyChange={setArchiveBusy}
          {...(sessionKey === undefined ? {} : { sessionKey })} {...(globalId ? { id: globalId } : {})} />
      </div>
      <footer className="notebook-footer"><span role="status">{state.phase === 'ready' && !controller.dirty() && <Check size={12} />}{status}</span>
        {state.phase === 'error' ? <button type="button" onClick={() => void controller.load()}>{t('Retry')}</button> : <span>{t('{count} / {limit} characters', { count: state.text.length.toLocaleString(), limit: NOTEBOOK_MAX_CHARS.toLocaleString() })}</span>}
      </footer>
      {!embedded && !collapsed && !dedicatedMobile && (['right', 'bottom', 'corner'] satisfies NotebookResizeEdge[]).map(edge => <button key={edge} type="button" className={`notebook-resize notebook-resize-${edge}`} aria-label={t(edge === 'right' ? 'Resize notebook width' : edge === 'bottom' ? 'Resize notebook height' : 'Resize notebook')} title={t('Drag to resize · arrow keys also work')}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); const rect = panel.current!.getBoundingClientRect(); resizing.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { const start = resizing.current, rect = panel.current?.getBoundingClientRect(); if (start?.id === event.pointerId && rect) updateAppearance(resizeNotebook(start.width, start.height, event.clientX - start.x, event.clientY - start.y, edge, window.innerWidth - rect.left - 8, window.innerHeight - rect.top - 8)); }}
        onPointerUp={() => { resizing.current = undefined; }} onPointerCancel={() => { resizing.current = undefined; }} onLostPointerCapture={() => { resizing.current = undefined; }}
        onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const rect = panel.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 12; updateAppearance(resizeNotebook(rect.width, rect.height, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, edge, window.innerWidth - rect.left - 8, window.innerHeight - rect.top - 8)); }}>{edge === 'corner' ? '◢' : null}</button>)}
    </section>)}
  </>;
}
