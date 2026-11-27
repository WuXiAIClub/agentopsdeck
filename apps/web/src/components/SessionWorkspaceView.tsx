import type { RemoteTarget } from '@agentopsdeck/shared';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref, type PointerEvent, type KeyboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { flushSync } from 'react-dom';
import type { BoardSummary, SessionSummary } from '@agentopsdeck/shared';
import { ArrowUpRight, Bot, Link2, Lock, LockOpen, Columns2, Rows2, Grid2X2, PanelsTopLeft, PictureInPicture2, PanelBottom, GripHorizontal, ChevronDown, ChevronUp, X, StickyNote, Maximize2, Minimize2, Monitor, Sun, Moon } from 'lucide-react';
import { PaneToolbarScope } from './PaneToolbar';
import { RunningPaneBorder } from './RunningPaneBorder';
import WorkspaceFileCardScope from './WorkspaceFileCardScope';
import { CoBoundSessionsBar, FileLinkButton, WorkspaceFileLinksProvider, fileCardLabel } from './WorkspaceFileLinks';
import { toggleFileLink } from '../lib/workspace-file-links';
import { CardKindIcon } from './CardKindIcon';
import { CardConnectionsButton } from './CardConnectionsButton';
import { fileEditorsReady } from '../lib/file-editor-guard';
const WorkspaceFiles = lazy(() => import('./WorkspaceFiles'));
const WorkspaceBindingLines = lazy(() => import('./WorkspaceBindingLines'));
const AntigravityQuotaFlowOverlay = lazy(() => import('./AntigravityQuotaFlowOverlay'));
import { focusedPaneRect } from '../lib/pane-focus-geometry';
import { setDockFrame, projectWorkspace, resizePaneEdge, findWorkspaceDrop, paneMinimum, dockFitsWorkspace, type PaneResizeEdge } from '../lib/workspace-layout';
import { alignWorkspaceRect, type AlignmentGuide, type SnapEdge } from '../lib/workspace-snap';
import { useI18n } from '../lib/i18n';
import { displayTitle } from '../lib/session-utils';
import { arrangeDock, emptyWorkspace, equalizeDock, closeWorkspacePane, dockPaneIds, dockSubagentCompanionPane, insertWorkspacePane, fitFloating, floatWorkspacePane, findDockDrop, placeWorkspacePane,
  resizeDock, previewSessionCardDrop, previewResourceDrop, isSessionPane, paneKey, pruneWorkspaceSessions, closePreviewPanes, openDashboardPane, openResourcePane, selectWorkspaceSession, canPlaceWorkspacePane, MAX_RESOURCE_PANES, type DockDrop, type PaneRect, type FloatingPane, type WorkspacePreset, type NotebookPane } from '../lib/workspace-layout';
import { currentSessionCardDrag, endSessionCardDrag, sessionCardDragType } from '../lib/session-card-drag';
import { useVisibleSessions } from '../lib/visible-sessions';
const SavedLayouts = lazy(() => import('./SavedLayouts').then(m => ({ default: m.SavedLayouts })));
import { CaptionOverflow } from './CaptionOverflow';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import { LayoutSyncStatus, useLayoutSync } from './LayoutSyncStatus';
import { usePaneCompletion } from '../lib/use-pane-completion';
import { monitorCompletionAnimation } from '../lib/completion-animation';
import { hasQueueBlockingRun } from '../lib/live-session';
import { useCompletionEffect } from '../lib/completion-preference';
import { restoreSavedLayout, type SavedLayout } from '../lib/saved-layouts';
import { SESSION_HANDOFF_EVENT, applyHandoffToCollapsedKeys, applyHandoffToWorkspaceLayout, type SessionHandoffEventDetail } from '../lib/session-handoff';
import { api, recoveryScope, subscribeRecoveryScope } from '../api';
import { currentLayoutKey, legacyCurrentLayoutKey, layoutSnapshot, parseCurrentLayout, osDesktopLayoutKey, readOsDesktopLayout, writeOsDesktopLayout, areCurrentLayoutsEquivalent, reconcileCurrentLayoutConflict } from '../lib/current-layout';
import { usePaneHoverFocus } from '../lib/use-pane-hover-focus';
const WorkspaceDashboard = lazy(() => import('./WorkspaceDashboard').then(m => ({ default: m.WorkspaceDashboard })));
const WorkspaceModeratorControl = lazy(() => import('./WorkspaceModeratorControl').then(m => ({ default: m.WorkspaceModeratorControl })));
import type { WorkspaceTemplateId } from '../lib/layout-templates';
import { WorkspaceBoardPicker } from './WorkspaceBoardPicker';
import { WorkspaceNotebook, useNotebookCatalog, useNotebookCatalogUpdate, useNotebookWorkspace } from './SessionNotebook';
import { boardSavedEvent, publishBoardSaved, writeCachedBoardDocument, type BoardSavedDetail } from '../lib/workspace-board';
import { useViewportPopover } from '../lib/layout-popover';
import { invalidatedSessionNodes, type SessionSourceState } from '../lib/session-snapshot';
import { placeRemoteDraft, placeSessionDraft, sendRemoteMessage, sessionDraftTargetLabel, type SessionDraftOutcome } from '../lib/remote-draft';
import { WorkspaceDraftTargets, WorkspaceNotebookTargets } from './WorkspaceDraftTargets';
import { SourceTaskTargets } from './SourceTaskTransfer';
import { placeSourceTask } from '../lib/source-task';
import { placeNotebookReading } from '../lib/remote-draft';
import type { NotebookTransferOutcome } from '../lib/session-notebook';
const WorkspaceRemoteHost = lazy(() => import('./WorkspaceRemoteHost'));
const WorkspaceTaskboard = lazy(() => import('./WorkspaceTaskboard'));
const WorkspaceStatusCard = lazy(() => import('./WorkspaceStatusCard'));
const AntigravityUsagePanel = lazy(() => import('./AntigravityUsagePanel'));
const GitRepoStatusPanel = lazy(() => import('./GitRepoStatusPanel'));
const WorkspaceSessionHub = lazy(() => import('./WorkspaceSessionHub'));
const WorkspaceDrawing = lazy(() => import('./WorkspaceDrawing'));
const WorkspaceNativeDrawio = lazy(() => import('./WorkspaceNativeDrawio'));
const WorkspaceWebsite = lazy(() => import('./WorkspaceWebsite'));
const WorkspaceResearch = lazy(() => import('./WorkspaceResearch'));
const QuickChatPanel = lazy(() => import('./QuickChatPanel'));
const WorkspaceGitTree = lazy(() => import('./WorkspaceGitTree'));
const WorkspaceIssues = lazy(() => import('./WorkspaceIssues'));
const WorkspaceTerminal = lazy(() => import('./WorkspaceTerminal'));
const WorkspaceDocker = lazy(() => import('./WorkspaceDocker'));
const WorkspaceBrowser = lazy(() => import('./WorkspaceBrowser').then(module => ({ default: module.WorkspaceBrowser })));
const WorkspaceMetricCard = lazy(() => import('./WorkspaceMetricCard'));
const WorkspaceReport = lazy(() => import('./WorkspaceReport'));
const MediaLibrary = lazy(() => import('./MediaLibrary').then(module => ({ default: module.MediaLibrary })));
const MultiScreenToolbar = lazy(() => import('./MultiScreenToolbar'));
const PaneProjectionButton = lazy(() => import('./MultiScreenToolbar').then(m => ({ default: m.PaneProjectionButton })));
const WorkspaceOsDesktop = lazy(() => import('./WorkspaceOsDesktop'));
const WorkspaceSubagentCompanion = lazy(() => import('./WorkspaceSubagentCompanion'));
import { COLOR_MODE_CHANGE_EVENT, isDesktopUrlRoute, isMobileViewport, readWorkspaceColorMode, readWorkspaceUiMode, syncDesktopImmersiveDataset, syncDesktopUrlHash, toggleWorkspaceColorMode, writeWorkspaceUiMode, type WorkspaceColorMode, type WorkspaceUiMode, type DesktopIconItem, type DesktopIconKind } from '../lib/desktop-os-mode';
import { parseProjectionSearch } from '../lib/multi-screen-projection';
import { OPEN_SUBAGENT_COMPANION_EVENT, resolveSessionSubagentCompanion, type OpenSubagentCompanionDetail } from '../lib/subagent-companion';
import { getLiveSessionSnapshot, getSubagentLiveStoreRevision, subscribeSubagentLiveStore } from '../lib/subagent-live-store';

/** Layout only moves stable sibling hosts. Floating/docking never reparents a
 * controller, duplicates an editor, or sends a business command. */
type WorkspaceProps = {
  selected: SessionSummary | undefined; selectedKey: string | undefined; sessions: SessionSummary[]; dismissed: ReadonlySet<string>; emptyState: ReactNode;
  onSelect: (session: SessionSummary) => void; onOpenKeys: (keys: string[]) => void; renderPane: (session: SessionSummary) => ReactNode;
  onActivate?: (session: SessionSummary) => void;
  sourceStates?: SessionSourceState[] | undefined;
  onCreateSession?: () => void;
  onCreateTemplateSession?: ((title: string) => Promise<string | undefined>) | undefined;
};
// Geometry updates belong to the host, not the session controller. Compare both
// inputs normally: fresh metadata or render closures must still propagate.
// State, subscriptions and toolbar context inside a pane remain independent.
const WorkspaceSessionContent = memo(function WorkspaceSessionContent({ session, renderPane }: Pick<WorkspaceProps, 'renderPane'> & { session: SessionSummary }) {
  return renderPane(session);
});
export function SessionWorkspaceView(props: WorkspaceProps) {
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  return <SessionWorkspace key={scope ?? 'anonymous'} {...props} scope={scope} />;
}
function SessionWorkspace({ selected, selectedKey, sessions, dismissed, sourceStates, onSelect, onActivate = onSelect, onOpenKeys, onCreateSession, onCreateTemplateSession, renderPane, emptyState, scope }: WorkspaceProps & { scope: string | undefined }) {
  const { t } = useI18n();
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number; pane?: HTMLElement | undefined }>();
  const [quickSwitchHost, setQuickSwitchHost] = useState<HTMLDivElement | null>(null);
  const closeContextMenu = useCallback(() => setContextPoint(undefined), []);
  const [quickChatOpen, setQuickChatOpen] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const presetSummaryRef = useRef<HTMLElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  useViewportPopover(presetMenuOpen, presetSummaryRef, presetMenuRef);
  const [uiMode, setUiMode] = useState<WorkspaceUiMode>(() => readWorkspaceUiMode(scope));
  const [colorMode, setColorMode] = useState<WorkspaceColorMode>(() => readWorkspaceColorMode());
  const [preferredSubagentParentKey, setPreferredSubagentParentKey] = useState<string | undefined>(undefined);
  const dismissedSubagentWavesRef = useRef(new Map<string, string>());
  const subagentManualHoldRef = useRef(false);
  const subagentHadLiveRef = useRef(false);
  const [subagentPinned, setSubagentPinned] = useState(false);
  const subagentLiveRevision = useSyncExternalStore(subscribeSubagentLiveStore, getSubagentLiveStoreRevision, getSubagentLiveStoreRevision);
  useEffect(() => {
    const onColorChange = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: WorkspaceColorMode }>).detail?.mode;
      if (mode === 'dark' || mode === 'light') setColorMode(mode);
      else setColorMode(readWorkspaceColorMode());
    };
    window.addEventListener(COLOR_MODE_CHANGE_EVENT, onColorChange);
    return () => window.removeEventListener(COLOR_MODE_CHANGE_EVENT, onColorChange);
  }, []);
  const closeQuickChat = useCallback(() => setQuickChatOpen(false), []);
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (!scope || event.defaultPrevented || event.repeat || event.isComposing || document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyK') {
        event.preventDefault(); setQuickChatOpen(true); closeContextMenu();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [scope, closeContextMenu]);
  const completionEffect = useCompletionEffect();
  const notebooks = useNotebookCatalog();
  const [taskboards, setTaskboards] = useState<BoardSummary[]>([]);
  useEffect(() => {
    if (!scope || uiMode !== 'os-desktop') return;
    const abort = new AbortController();
    let live = true;
    void api.workspaceBoards(abort.signal).then(res => {
      if (live && scope === recoveryScope()) setTaskboards(res.boards ?? []);
    }).catch(() => {});
    const onBoardSaved = (event: Event) => {
      const detail = (event as CustomEvent<BoardSavedDetail>).detail;
      if (!detail || detail.scope !== scope) return;
      setTaskboards(prev => {
        const idx = prev.findIndex(b => b.resourceId === detail.summary.resourceId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = detail.summary;
          return next;
        }
        return [...prev, detail.summary];
      });
    };
    window.addEventListener(boardSavedEvent, onBoardSaved);
    return () => {
      live = false;
      abort.abort();
      window.removeEventListener(boardSavedEvent, onBoardSaved);
    };
  }, [scope, uiMode]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    if (uiMode === 'os-desktop') {
      if (isMobileViewport()) {
        setUiMode('classic');
        syncDesktopImmersiveDataset('classic');
        return;
      }
      syncDesktopImmersiveDataset('os-desktop');
      syncDesktopUrlHash('os-desktop');
      if (scope) writeWorkspaceUiMode(scope, 'os-desktop');
    } else {
      syncDesktopImmersiveDataset('classic');
    }
    const onResize = () => {
      if (uiMode === 'os-desktop' && isMobileViewport()) {
        setUiMode('classic');
      }
    };
    const onRouteCheck = () => {
      if (!isMobileViewport() && isDesktopUrlRoute()) {
        setUiMode(prev => {
          if (prev === 'os-desktop') return prev;
          writeWorkspaceUiMode(scope, 'os-desktop');
          return 'os-desktop';
        });
      }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('hashchange', onRouteCheck);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hashchange', onRouteCheck);
      delete document.documentElement.dataset.osDesktopImmersive;
    };
  }, [uiMode, scope]);
  const updateNotebookCatalog = useNotebookCatalogUpdate();
  const notebookWorkspace = useNotebookWorkspace();
  const hoverFocus = usePaneHoverFocus();
  const classicStorageKey = currentLayoutKey(scope);
  const storageKey = uiMode === 'os-desktop' ? osDesktopLayoutKey(scope) : classicStorageKey;
  const lockKey = classicStorageKey ? `${classicStorageKey}:locked` : undefined;
  const [locked, setLocked] = useState(() => {
    try { return !!lockKey && localStorage.getItem(lockKey) === 'true'; } catch { return false; }
  });
  const [restored] = useState(() => {
    try {
      if (uiMode === 'os-desktop') {
        const osSaved = readOsDesktopLayout(scope);
        if (osSaved) return osSaved;
      }
      return parseCurrentLayout(classicStorageKey ? localStorage.getItem(classicStorageKey) ?? localStorage.getItem(legacyCurrentLayoutKey(scope)!) : null);
    } catch { return undefined; }
  });
  const [layout, setLayout] = useState(() => restored?.workspace ?? (selected ? selectWorkspaceSession(emptyWorkspace(), selected.sessionKey, undefined, 'initial', 0, 0) : emptyWorkspace()));
  const [previousSelection, setPreviousSelection] = useState(restored && !restored.workspace.panes.some(pane => pane.sessionKey === selected?.sessionKey) ? undefined : selected?.sessionKey);
  const [preset, setPreset] = useState<Exclude<WorkspacePreset, 'single'>>('columns');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null);
  // Resolve the sidebar portal before first paint. Moving the inline toolbar
  // in a passive effect changes the surface height after cached panes render.
  useLayoutEffect(() => { setToolsHost(document.getElementById('workspace-layout-tools')); }, []);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set(restored?.collapsedKeys));
  const toggleUiMode = useCallback((next?: WorkspaceUiMode) => {
    setUiMode(prev => {
      const requested = next ?? (prev === 'os-desktop' ? 'classic' : 'os-desktop');
      const mode = requested === 'os-desktop' && isMobileViewport() ? 'classic' : requested;
      if (mode === prev) return prev;
      try {
        if (prev === 'os-desktop') {
          writeOsDesktopLayout(scope, layout, collapsedKeys);
          const classicRaw = classicStorageKey ? localStorage.getItem(classicStorageKey) ?? localStorage.getItem(legacyCurrentLayoutKey(scope)!) : null;
          const classicSaved = parseCurrentLayout(classicRaw);
          if (classicSaved) {
            setLayout(classicSaved.workspace);
            setCollapsedKeys(new Set(classicSaved.collapsedKeys));
          }
        } else {
          if (classicStorageKey) {
            localStorage.setItem(classicStorageKey, JSON.stringify(layoutSnapshot(layout, collapsedKeys)));
          }
          const osSaved = readOsDesktopLayout(scope);
          if (osSaved) {
            setLayout(osSaved.workspace);
            setCollapsedKeys(new Set(osSaved.collapsedKeys));
          }
        }
      } catch {
        // Ignore storage errors
      }
      writeWorkspaceUiMode(scope, mode);
      return mode;
    });
  }, [scope, classicStorageKey, layout, collapsedKeys]);
  const [layoutNotice, setNotice] = useState<{ message: string; transient: boolean }>();
  const setLayoutNotice = useCallback((message: string, transient = true) => setNotice(message ? { message, transient } : undefined), []);
  useEffect(() => {
    if (!layoutNotice) return;
    const timer = setTimeout(() => setNotice(current => current === layoutNotice ? undefined : current), 3800);
    return () => clearTimeout(timer);
  }, [layoutNotice]);
  const [maximizedId, setMaximizedId] = useState<string>();
  type Placement = { id: string; sessionKey: string; rect: PaneRect; free?: boolean; drop?: DockDrop | undefined; floating?: FloatingPane | undefined; blocked: boolean };
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const placementRef = useRef<Placement | null>(null);
  const drag = useRef<{ id: string; sessionKey: string; pointer: number; x: number; y: number; rect: PaneRect; moved: boolean } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (uiMode === 'os-desktop') {
      setContextPoint(undefined);
      return;
    }
    const node = surface.current;
    // Caption tools/title are portals. React bubbling follows their logical
    // parent, so use the physical workspace boundary for its context menu.
    const context = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || event.defaultPrevented || target.closest('.os-desktop-shell, input, textarea, select, [contenteditable]:not([contenteditable="false"]), a, .workspace-task-card')) return;
      // A selection elsewhere must not disable the entire workspace's menu.
      // Keep the browser's copy menu only when right-clicking selected content.
      const selection = window.getSelection();
      if (selection?.toString() && selection.containsNode(target, true)) return;
      event.preventDefault();
      setContextPoint({ x: event.clientX, y: event.clientY, pane: target.closest<HTMLElement>('[data-workspace-pane]') ?? undefined });
    };
    node?.addEventListener('contextmenu', context);
    return () => node?.removeEventListener('contextmenu', context);
  }, [uiMode]);
  const snapshots = useRef(new Map<string, SessionSummary>());
  const layoutSyncRef = useRef<{ edit: (v: string) => void; retry: () => void } | null>(null);
  useEffect(() => {
    const onSessionHandoff = (event: Event) => {
      const detail = (event as CustomEvent<SessionHandoffEventDetail>).detail;
      if (!detail?.fromSessionKey || !detail?.toSessionKey || !detail.session) return;
      snapshots.current.set(detail.toSessionKey, detail.session);
      setPreviousSelection(detail.toSessionKey);
      setLayout((prev) => {
        const nextWs = applyHandoffToWorkspaceLayout(
          prev,
          detail.fromSessionKey,
          detail.toSessionKey,
          detail.replaceSourcePane ?? true,
        );
        setCollapsedKeys((prevCollapsed) => {
          const nextCollapsed = applyHandoffToCollapsedKeys(
            prevCollapsed,
            detail.fromSessionKey,
            detail.toSessionKey,
            nextWs,
          );
          if (storageKey && scope === recoveryScope()) {
            const snap = JSON.stringify(layoutSnapshot(nextWs, nextCollapsed));
            try {
              localStorage.setItem(storageKey, snap);
              lastWritten.current = snap;
            } catch {
              // Ignore storage quota errors
            }
            if (uiMode !== 'os-desktop' && layoutSyncRef.current) {
              classicSerializedRef.current = snap;
              layoutSyncRef.current.edit(snap);
              layoutSyncRef.current.retry();
              detail.claimedCurrentSync = true;
            }
          }
          if (uiMode === 'os-desktop' && classicStorageKey && scope === recoveryScope()) {
            try {
              const classicRaw = localStorage.getItem(classicStorageKey);
              if (classicRaw) classicSerializedRef.current = classicRaw;
            } catch {
              // Ignore storage errors
            }
          }
          return nextCollapsed;
        });
        return nextWs;
      });
    };
    window.addEventListener(SESSION_HANDOFF_EVENT, onSessionHandoff);
    return () => window.removeEventListener(SESSION_HANDOFF_EVENT, onSessionHandoff);
  }, [storageKey, classicStorageKey, uiMode, scope]);
  const previousSources = useRef(sourceStates);
  const invalidNodes = invalidatedSessionNodes(previousSources.current, sourceStates, selectedKey);
  previousSources.current = sourceStates;
  const available = new Map(sessions.map(session => [session.sessionKey, session]));
  // Keep overview inputs stable during pointer/layout updates. Filtering inline
  // would invalidate every dashboard memo on every drag frame.
  const overviewSessions = useMemo(() => sessions.filter(session => !dismissed.has(session.sessionKey)), [sessions, dismissed]);
  if (selected) available.set(selected.sessionKey, selected);
  for (const pane of layout.panes) if (isSessionPane(pane) && available.has(pane.sessionKey)) snapshots.current.set(pane.sessionKey, available.get(pane.sessionKey)!);
  for (const key of snapshots.current.keys()) if (!layout.panes.some(pane => pane.sessionKey === key) || dismissed.has(key)) snapshots.current.delete(key);
  if (previousSelection !== selected?.sessionKey) {
    setPreviousSelection(selected?.sessionKey);
    if (!selected && !selectedKey) {
      let next = layout;
      for (const pane of layout.panes) if (isSessionPane(pane)) next = closeWorkspacePane(next, pane.id);
      setLayout(next);
    }
    else if (!selected) { /* Metadata loading must not erase saved geometry. */ }
    else {
      const next = selectWorkspaceSession(layout, selected.sessionKey, previousSelection, `pane:${crypto.randomUUID()}`, size.width, size.height);
      setLayout(next);
      if (next === layout) setLayoutNotice(t('Workspace session limit reached. Close a session card before opening another.'));
      else { setLayoutNotice(''); setMaximizedId(undefined); setCollapsedKeys(keys => { const next = new Set(keys); next.delete(selected.sessionKey); return next; }); }
    }
  }
  // Revocation removes the host and geometry together, including floating hosts.
  const current = pruneWorkspaceSessions(layout, dismissed, invalidNodes);
  if (current !== layout) setLayout(current);
  const openBoardResource = (kind: 'taskboard' | 'statuscard' | 'drawing' | 'native-drawio' | 'website' | 'metric-card' | 'report', resourceId: string) => {
    const next = openResourcePane(current, { id: `pane:${crypto.randomUUID()}`, kind, resourceId }, size.width, size.height);
    if (next === current && !current.panes.some(pane => pane.kind === kind && pane.resourceId === resourceId)) setLayoutNotice(t('Workspace resource limit reached. Close a panel before opening another.'));
    else setLayout(next);
  };
  const visible = current.panes.flatMap<{ id: string; sessionKey: string; files?: 'file-browser' | 'file-editor' | 'image-viewer'; session?: SessionSummary; browser?: boolean; report?: { resourceId: string }; media?: boolean; moderator?: boolean; docker?: boolean; subagents?: boolean; research?: boolean; terminal?: boolean; antigravityQuota?: boolean; gitRepoStatus?: { resourceId: string }; sessionHub?: { resourceId: string }; metricCard?: { resourceId: string }; website?: { resourceId: string }; notebook?: NotebookPane; drawing?: { resourceId: string }; nativeDrawio?: { resourceId: string }; board?: { kind: 'taskboard' | 'statuscard'; resourceId: string }; title: string }>(pane => {
    if (pane.kind === 'file-browser' || pane.kind === 'file-editor' || pane.kind === 'image-viewer') return [{ id: pane.id, sessionKey: paneKey(pane), files: pane.kind, title: t(fileCardLabel(pane.kind)) }];
    if (pane.kind === 'report') return [{ id: pane.id, sessionKey: paneKey(pane), report: pane, title: t('Report') }];
    if (pane.kind === 'git-tree') return [{ id: pane.id, sessionKey: paneKey(pane), title: t('Repository tree') }];
    if (pane.kind === 'issue-source') return [{ id: pane.id, sessionKey: paneKey(pane), title: t('Issue sources') }];
    if (pane.kind === 'browser') return [{ id: pane.id, sessionKey: paneKey(pane), browser: true, title: t('Browser card') }];
    if (pane.kind === 'metric-card') return [{ id: pane.id, sessionKey: paneKey(pane), metricCard: pane, title: t('Custom status card') }];
    if (pane.kind === 'antigravity-quota') return [{ id: pane.id, sessionKey: paneKey(pane), antigravityQuota: true, title: t('Antigravity account quota') }];
    if (pane.kind === 'git-repo-status') return [{ id: pane.id, sessionKey: paneKey(pane), gitRepoStatus: pane, title: t('Git repository status') }];
    if (pane.kind === 'session-hub') return [{ id: pane.id, sessionKey: paneKey(pane), sessionHub: pane, title: t('Multi-session switcher') }];
    if (pane.kind === 'terminal') return [{ id: pane.id, sessionKey: paneKey(pane), terminal: true, title: t('Connector terminal') }];
    if (pane.kind === 'research') return [{ id: pane.id, sessionKey: paneKey(pane), research: true, title: t('Search and sources · Preview') }];
    if (pane.kind === 'website') return [{ id: pane.id, sessionKey: paneKey(pane), website: pane, title: t('Connector website · Preview') }];
    if (pane.kind === 'moderator') return [{ id: pane.id, sessionKey: paneKey(pane), moderator: true, title: t('Moderator Control Center') }];
    if (pane.kind === 'docker') return [{ id: pane.id, sessionKey: paneKey(pane), docker: true, title: t('Docker & Sandboxes') }];
    if (pane.kind === 'subagents') return [{ id: pane.id, sessionKey: paneKey(pane), subagents: true, title: t('Sub-agent Companion') }];
    if (pane.kind === 'media') return [{ id: pane.id, sessionKey: paneKey(pane), media: true, title: t('Media library') }];
    if (pane.kind === 'native-drawio') return [{ id: pane.id, sessionKey: paneKey(pane), nativeDrawio: pane, title: t('Native draw.io') }];
    if (pane.kind === 'drawing') return [{ id: pane.id, sessionKey: paneKey(pane), drawing: pane, title: t('Whiteboard') }];
    if (pane.kind === 'taskboard' || pane.kind === 'statuscard') return [{ id: pane.id, sessionKey: paneKey(pane), board: pane, title: t(pane.kind === 'taskboard' ? 'Task board' : 'Task status card') }];
    if (pane.kind === 'notebook') return [{ id: pane.id, sessionKey: paneKey(pane), notebook: pane, title: pane.target === 'hub'
      ? notebooks.find(note => note.id === pane.resourceId)?.title || t('Global notebook')
      : `${t('Session notes')} · ${available.has(pane.resourceId) ? displayTitle(available.get(pane.resourceId)!) : t('Loading…')}` }];
    if (!isSessionPane(pane)) return [{ id: pane.id, sessionKey: paneKey(pane), title: t('Workspace overview') }];
    const session = available.get(pane.sessionKey) ?? snapshots.current.get(pane.sessionKey);
    return session ? [{ id: pane.id, sessionKey: pane.sessionKey, session, title: displayTitle(session) }] : [];
  });
  const visibleKeys = JSON.stringify(visible.flatMap(pane => pane.session ? [pane.session.sessionKey] : []));
  const completed = usePaneCompletion(visible.flatMap(pane => pane.session ? [pane.session] : []));
  const animatedSequences = useRef(new WeakMap<Element, string>());
  const animationMonitors = useRef(new Map<HTMLElement, () => void>());
  useEffect(() => () => { for (const dispose of animationMonitors.current.values()) dispose(); animationMonitors.current.clear(); }, []);
  useLayoutEffect(() => {
    for (const [host, dispose] of animationMonitors.current) {
      if (!host.isConnected || host.dataset.completed !== 'true') { dispose(); animationMonitors.current.delete(host); }
    }
    // Restart a second fast completion without remounting the chat controller,
    // losing editor focus, or restarting another pane's concurrent animation.
    for (const host of surface.current?.querySelectorAll<HTMLElement>('[data-completed="true"]') ?? []) {
      const sequence = host.dataset.completionSequence!;
      const signature = `${sequence}:${completionEffect}`;
      if (animatedSequences.current.get(host) === signature) continue;
      animatedSequences.current.set(host, signature);
      // A finished CSS animation disappears from getAnimations() even while
      // data-completed remains true. Reset the style on this host once per new
      // completion so a second turn can restart that animation too. Restoring
      // the cascade keeps off/glow/reduced-motion preferences authoritative.
      const previousName = host.style.animationName;
      host.style.animationName = 'none';
      void getComputedStyle(host).animationName;
      host.style.animationName = previousName;
      animationMonitors.current.get(host)?.();
      const key = visible.find(pane => pane.id === host.dataset.remotePane)?.sessionKey ?? 'unknown-pane';
      animationMonitors.current.set(host, monitorCompletionAnimation(host, key, sequence));
    }
  }, [completed, completionEffect]);
  const openSessionKeysList = useMemo<string[]>(() => JSON.parse(visibleKeys), [visibleKeys]);
  useEffect(() => { onOpenKeys(JSON.parse(visibleKeys)); }, [visibleKeys, onOpenKeys]);
  useEffect(() => {
    if (!scope) return;
    const onOpenCompanion = (event: Event) => {
      subagentManualHoldRef.current = true;
      const targetSessionKey = (event as CustomEvent<OpenSubagentCompanionDetail>).detail?.sessionKey;
      if (targetSessionKey) {
        dismissedSubagentWavesRef.current.delete(targetSessionKey);
        setPreferredSubagentParentKey(targetSessionKey);
      }
      const companionKey = paneKey({ id: 'subagents', kind: 'subagents', resourceId: 'follow' });
      setCollapsedKeys(prev => {
        if (!prev.has(companionKey)) return prev;
        const next = new Set(prev);
        next.delete(companionKey);
        return next;
      });
      setLayout(value => {
        const parentKey = targetSessionKey ?? selected?.sessionKey ?? '';
        return dockSubagentCompanionPane(value, parentKey, `pane:${crypto.randomUUID()}`, size.width, size.height);
      });
    };
    window.addEventListener(OPEN_SUBAGENT_COMPANION_EVENT, onOpenCompanion);
    return () => window.removeEventListener(OPEN_SUBAGENT_COMPANION_EVENT, onOpenCompanion);
  }, [scope, selected?.sessionKey, size.width, size.height]);
  useEffect(() => {
    if (!scope) return;
    void subagentLiveRevision;
    let liveParentKey: string | undefined;
    let liveActivityAt = -1;
    for (const sKey of openSessionKeysList) {
      const sess = available.get(sKey) ?? snapshots.current.get(sKey);
      if (!sess) continue;
      const snap = getLiveSessionSnapshot(sKey, sess);
      if (!snap || !snap.messages.length) continue;
      const companion = resolveSessionSubagentCompanion(snap.session ?? sess, snap.messages, snap.stale);
      if (!companion?.hasLiveDispatch) continue;
      if (dismissedSubagentWavesRef.current.get(sKey) === companion.waveId) continue;
      if (companion.latestActivityAt > liveActivityAt) {
        liveActivityAt = companion.latestActivityAt;
        liveParentKey = sKey;
      }
    }
    const existingCompanion = current.panes.find(p => p.kind === 'subagents');
    if (!liveParentKey) {
      if (!existingCompanion) {
        subagentHadLiveRef.current = false;
        return;
      }
      if (subagentPinned || subagentManualHoldRef.current) return;
      const settleDelayMs = subagentHadLiveRef.current ? 1500 : 0;
      const timer = window.setTimeout(() => {
        subagentHadLiveRef.current = false;
        setLayout(value => {
          const target = value.panes.find(p => p.kind === 'subagents');
          return target ? closeWorkspacePane(value, target.id) : value;
        });
      }, settleDelayMs);
      return () => window.clearTimeout(timer);
    }
    subagentHadLiveRef.current = true;
    subagentManualHoldRef.current = false;
    setPreferredSubagentParentKey(prev => (prev === liveParentKey ? prev : liveParentKey));
    const companionKey = paneKey({ id: 'subagents', kind: 'subagents', resourceId: 'follow' });
    setCollapsedKeys(prev => {
      if (!prev.has(companionKey)) return prev;
      const next = new Set(prev);
      next.delete(companionKey);
      return next;
    });
    const isFloatingCompanion = existingCompanion && current.floating.some(item => item.id === existingCompanion.id);
    if (!existingCompanion || !isFloatingCompanion) {
      const targetParent = liveParentKey;
      setLayout(value => dockSubagentCompanionPane(value, targetParent, `pane:${crypto.randomUUID()}`, size.width, size.height));
    }
    return undefined;
  }, [scope, subagentLiveRevision, openSessionKeysList, current.panes, current.floating, size.width, size.height, subagentPinned]);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    // Project the restored layout before its first paint, not from a 0x0
    // surface until the first asynchronous ResizeObserver delivery. The
    // surface has no padding/border; retain fractional CSS pixels here too.
    const { width, height } = element.getBoundingClientRect();
    setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, [toolsHost, uiMode]);
  const dockIds = dockPaneIds(current.dock);
  const geometry = useMemo(() => projectWorkspace(current, size.width, size.height), [current, size.width, size.height]);
  // This workspace belongs to the desktop shell; App owns mobile selection.
  // Sidebar/card sizes must never hide sibling panes or change their visibility
  // subscriptions. Narrow cards adapt via their existing container queries.
  const active = visible.find(pane => pane.id === current.active) ?? visible.find(pane => pane.sessionKey === selected?.sessionKey) ?? visible[0];
  const maximized = visible.some(pane => pane.id === maximizedId) ? maximizedId : undefined;
  useEffect(() => {
    if (!maximized) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) setMaximizedId(undefined); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [maximized]);
  // A bare workspace URL restores focus too. Explicit deep links take priority.
  const initialFocus = useRef(!!restored);
  useEffect(() => {
    if (!initialFocus.current) return;
    if (selectedKey) { initialFocus.current = false; return; }
    const pane = current.panes.find(item => item.id === current.active) ?? current.panes[0];
    if (pane && !isSessionPane(pane)) { initialFocus.current = false; return; }
    const session = pane && available.get(pane.sessionKey);
    if (session) { initialFocus.current = false; onActivate(session); }
  });
  const serialized = useMemo(() => JSON.stringify(layoutSnapshot(current, collapsedKeys)), [current, collapsedKeys]);
  const classicSerializedRef = useRef<string | undefined>(undefined);
  if (uiMode !== 'os-desktop') {
    classicSerializedRef.current = serialized;
  } else if (classicSerializedRef.current === undefined) {
    try {
      const classicRaw = classicStorageKey ? localStorage.getItem(classicStorageKey) ?? localStorage.getItem(legacyCurrentLayoutKey(scope)!) : null;
      const classicParsed = parseCurrentLayout(classicRaw);
      classicSerializedRef.current = JSON.stringify(classicParsed ?? layoutSnapshot(emptyWorkspace(), new Set()));
    } catch {
      classicSerializedRef.current = JSON.stringify(layoutSnapshot(emptyWorkspace(), new Set()));
    }
  }
  const classicSyncValue = uiMode === 'os-desktop' ? classicSerializedRef.current! : serialized;
  const layoutSync = useLayoutSync('current', scope, classicSyncValue, value => {
    const restored = parseCurrentLayout(value);
    if (!restored) return false;
    const normalized = JSON.stringify(restored);
    classicSerializedRef.current = normalized;
    if (uiMode === 'os-desktop') {
      if (classicStorageKey && scope === recoveryScope()) {
        try { localStorage.setItem(classicStorageKey, normalized); } catch { /* ignore */ }
      }
      return true;
    }
    setLayout(restored.workspace); setCollapsedKeys(new Set(restored.collapsedKeys));
    // An explicit route wins over the account's last active session.
    if (selectedKey && selected && !restored.workspace.panes.some(pane => pane.sessionKey === selectedKey)) setPreviousSelection(undefined);
    else if (!selectedKey) initialFocus.current = true;
    return true;
  }, {
    enabled: uiMode !== 'os-desktop',
    paused: placement !== null,
    debounceMs: 2400,
    equivalent: areCurrentLayoutsEquivalent,
    merge: reconcileCurrentLayoutConflict,
  });
  layoutSyncRef.current = layoutSync;
  const latestSnapshot = useRef(serialized);
  const lastWritten = useRef<string | undefined>(undefined);
  useEffect(() => {
    latestSnapshot.current = serialized;
    const timer = window.setTimeout(flush, 180);
    function flush() {
      if (!storageKey || scope !== recoveryScope() || lastWritten.current === serialized) return;
      try { localStorage.setItem(storageKey, serialized); lastWritten.current = serialized; } catch { /* Storage may be disabled; in-memory layout remains usable. */ }
    }
    return () => window.clearTimeout(timer);
  }, [serialized, storageKey, scope]);
  useEffect(() => {
    const flush = () => {
      if (!storageKey || scope !== recoveryScope() || lastWritten.current === latestSnapshot.current) return;
      try { localStorage.setItem(storageKey, latestSnapshot.current); lastWritten.current = latestSnapshot.current; } catch { /* Best effort on navigation. */ }
    };
    window.addEventListener('pagehide', flush);
    return () => { flush(); window.removeEventListener('pagehide', flush); };
  }, [storageKey, scope]);
  const floatingKeys = JSON.stringify(current.panes.filter(pane => current.floating.some(item => item.id === pane.id)).map(paneKey));
  useEffect(() => {
    const keys: string[] = JSON.parse(floatingKeys);
    setCollapsedKeys(previous => [...previous].some(key => !keys.includes(key)) ? new Set([...previous].filter(key => keys.includes(key))) : previous);
  }, [floatingKeys]);
  useVisibleSessions(uiMode === 'os-desktop' ? [] : visible.filter(pane => (!maximized || pane.id === maximized)
      && (!current.floating.some(item => item.id === pane.id) || !collapsedKeys.has(pane.sessionKey))).flatMap(pane => pane.session ? [pane.session.sessionKey] : []));
  const split = visible.length > 1 || layout.dock?.kind === 'split';
  type PlacementPoint = Pick<PointerEvent<HTMLElement>, 'pointerId' | 'clientX' | 'clientY' | 'shiftKey'>;
  const placementFrame = useRef<number | undefined>(undefined);
  const placementPoint = useRef<PlacementPoint | null>(null);
  function cancelPlacementFrame() {
    if (placementFrame.current !== undefined) cancelAnimationFrame(placementFrame.current);
    placementFrame.current = undefined; placementPoint.current = null;
  }
  useEffect(() => cancelPlacementFrame, []);
  function cancelPlacement() { cancelPlacementFrame(); drag.current = null; placementRef.current = null; setPlacement(null); cancelResize(); }
  function alignPane(id: string, rect: PaneRect, edge: SnapEdge = 'move', floating = false) {
    const neighbours = [...geometry.panes].filter(([other]) => other !== id).map(([, rect]) => rect);
    for (const other of current.floating) {
      const pane = current.panes.find(pane => pane.id === other.id);
      if (other.id === id || !pane) continue;
      const fitted = fitFloating(other, size.width, size.height, pane);
      neighbours.push({ x: fitted.x * size.width, y: fitted.y * size.height, width: fitted.width * size.width,
        height: collapsedKeys.has(paneKey(pane)) ? 34 : fitted.height * size.height });
    }
    const minimum = paneMinimum(current.panes.find(pane => pane.id === id), floating);
    const result = alignWorkspaceRect(rect, neighbours, size.width, size.height, edge,
      minimum);
    if (gesture.current || drag.current) setAlignmentGuides(result.guides);
    return result.rect;
  }
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { if (drag.current) event.preventDefault(); endSessionCardDrag(); cancelPlacement(); } };
    window.addEventListener('keydown', cancel); window.addEventListener('blur', cancelPlacement);
    window.addEventListener('dragend', cancelPlacement); window.addEventListener('drop', cancelPlacement);
    return () => { window.removeEventListener('keydown', cancel); window.removeEventListener('blur', cancelPlacement);
      window.removeEventListener('dragend', cancelPlacement); window.removeEventListener('drop', cancelPlacement); };
  }, []);
  useEffect(() => { cancelPlacement(); }, [size.width, size.height, visibleKeys]);
  function beginPlacement(event: PointerEvent<HTMLElement>, id: string, sessionKey: string, rect: PaneRect) {
    if (locked || event.button !== 0 || maximized || event.detail >= 2) return;
    event.preventDefault();
    event.currentTarget.closest('.session-pane-caption')?.querySelector<HTMLButtonElement>('.session-pane-drag')?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, sessionKey, pointer: event.pointerId, x: event.clientX, y: event.clientY, rect, moved: false };
  }
  function previewPlacement(event: PlacementPoint) {
    if (locked) return;
    const action = drag.current;
    if (!action || action.pointer !== event.pointerId) return;
    const dx = event.clientX - action.x, dy = event.clientY - action.y;
    if (!action.moved && Math.hypot(dx, dy) < 7) return;
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds) return;
    action.moved = true;
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const isDocked = dockIds.includes(action.id);
    const hasFreeFrames = current.panes.some(pane => pane.dockFrame);
    // Dragging snaps to dock/split/swap targets by default; Shift moves freely.
    if (event.shiftKey && isDocked) {
      const rect = alignPane(action.id, { ...action.rect, x: action.rect.x + dx, y: action.rect.y + dy });
      const next = { id: action.id, sessionKey: action.sessionKey, rect, free: true, blocked: x < 0 || y < 0 || x > size.width || y > size.height };
      placementRef.current = next; setPlacement(next); return;
    }
    const drop = findWorkspaceDrop(current, action.id, x, y, size.width, size.height);
    setAlignmentGuides([]);
    let next: Placement;
    if (drop) {
      const proposed = placeWorkspacePane(current, action.id, drop);
      const projected = projectWorkspace(proposed, size.width, size.height);
      next = { id: action.id, sessionKey: action.sessionKey, drop, rect: projected.panes.get(action.id) ?? action.rect,
        blocked: proposed === current || !dockFitsWorkspace(proposed, size.width, size.height) };
    } else if (isDocked) {
      if (hasFreeFrames) {
        const rect = alignPane(action.id, { ...action.rect, x: action.rect.x + dx, y: action.rect.y + dy });
        next = { id: action.id, sessionKey: action.sessionKey, rect, free: true, blocked: x < 0 || y < 0 || x > size.width || y > size.height };
      } else {
        setAlignmentGuides([]); placementRef.current = null; setPlacement(null); return;
      }
    } else {
      const existing = current.floating.find(item => item.id === action.id);
      const width = existing?.width ?? Math.min(.55, Math.max(340, action.rect.width) / Math.max(1, size.width));
      const height = existing?.height ?? .7;
      const floating = fitFloating({ id: action.id, width, height,
        x: (x - Math.min(action.x - bounds.left - action.rect.x, width * size.width - 24)) / Math.max(1, size.width),
        y: (action.rect.y + dy) / Math.max(1, size.height) }, size.width, size.height, current.panes.find(pane => pane.id === action.id));
      const aligned = alignPane(action.id, { x: floating.x * size.width, y: floating.y * size.height, width: floating.width * size.width,
        height: collapsedKeys.has(action.sessionKey) ? 34 : floating.height * size.height });
      floating.x = aligned.x / Math.max(1, size.width); floating.y = aligned.y / Math.max(1, size.height);
      next = { id: action.id, sessionKey: action.sessionKey, floating,
        rect: { x: floating.x * size.width, y: floating.y * size.height, width: floating.width * size.width, height: collapsedKeys.has(action.sessionKey) ? 34 : floating.height * size.height },
        blocked: x < 0 || y < 0 || x > size.width || y > size.height || !canPlaceWorkspacePane(current, action.id, true) };
    }
    placementRef.current = next; setPlacement(next);
  }
  function finishPlacement(event: PointerEvent<HTMLElement>) {
    if (locked) { cancelPlacement(); return; }
    if (drag.current?.pointer !== event.pointerId) return;
    cancelPlacementFrame();
    previewPlacement(event); // Release coordinates are authoritative, including outside the surface.
    const next = placementRef.current;
    if (next && !next.blocked && current.panes.some(pane => pane.id === next.id && paneKey(pane) === next.sessionKey) && !dismissed.has(next.sessionKey)) {
      setLayout(value => next.free ? setDockFrame(value, next.id, next.rect, size.width, size.height) : next.drop ? placeWorkspacePane(value, next.id, next.drop)
        : next.floating ? floatWorkspacePane(value, next.id, next.floating) : value);
    }
    cancelPlacement();
  }
  const latestPlacementPreview = useRef(previewPlacement);
  useLayoutEffect(() => { latestPlacementPreview.current = previewPlacement; });
  const placementHandlers = { onPointerMove: (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    // Keep only coordinates, never retain a synthetic event or read layout for
    // idle hover. Pointerup is handled synchronously with release coordinates.
    placementPoint.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey };
    if (placementFrame.current === undefined) placementFrame.current = requestAnimationFrame(() => {
      placementFrame.current = undefined;
      const point = placementPoint.current; placementPoint.current = null;
      if (point) latestPlacementPreview.current(point);
    });
  }, onPointerUp: finishPlacement, onPointerCancel: cancelPlacement, onLostPointerCapture: cancelPlacement };
  // The source owns pointer capture, the workspace owns geometry. No document
  // drag listeners, synthetic session, or network read is needed for a note.
  useLayoutEffect(() => {
    if (!notebookWorkspace) return;
    const handler: NonNullable<typeof notebookWorkspace.placement.current> = (resourceId, x, y, action) => {
      if (action === 'cancel') { cancelPlacement(); return false; }
      const bounds = surface.current?.getBoundingClientRect();
      if (locked || !scope || scope !== recoveryScope() || !bounds || !notebooks.some(note => note.id === resourceId)) { cancelPlacement(); return false; }
      const next = previewResourceDrop(current, { id: `notebook:${resourceId}`, kind: 'notebook', target: 'hub', resourceId }, x - bounds.left, y - bounds.top, size.width, size.height);
      // Outside a docking zone, keep the familiar unconstrained global float.
      // A note enters the workspace only on an explicit highlighted edge.
      if (!next.drop && !next.free) { cancelPlacement(); return false; }
      if (action === 'preview') { placementRef.current = next; setPlacement(next); return false; }
      if (!next.blocked) setLayout(next.layout);
      cancelPlacement(); return !next.blocked;
    };
    notebookWorkspace.placement.current = handler;
    return () => { if (notebookWorkspace.placement.current === handler) notebookWorkspace.placement.current = undefined; };
  });
  function cardPlacement(event: DragEvent<HTMLDivElement>, commit = false) {
    const card = currentSessionCardDrag(), bounds = surface.current?.getBoundingClientRect();
    if (!card || !bounds || !event.dataTransfer.types.includes(sessionCardDragType)) return;
    // Capture prevents card drops leaking into an editor's file-attachment handler.
    event.preventDefault(); event.stopPropagation();
    if (locked) { event.dataTransfer.dropEffect = 'none'; cancelPlacement(); if (commit) endSessionCardDrag(); return; }
    const session = available.get(card.key);
    if (!session || dismissed.has(card.key) || (commit && event.dataTransfer.getData(sessionCardDragType) !== card.key)) {
      event.dataTransfer.dropEffect = 'none'; cancelPlacement(); if (commit) endSessionCardDrag(); return;
    }
    const next = previewSessionCardDrop(current, card.key, card.paneId,
      event.clientX - bounds.left, event.clientY - bounds.top, size.width, size.height);
    event.dataTransfer.dropEffect = next.blocked ? 'none' : 'move';
    if (!commit) { placementRef.current = next; setPlacement(next); return; }
    if (!next.blocked) { setLayout(next.layout); setPreviousSelection(session.sessionKey); onSelect(session); }
    endSessionCardDrag(); cancelPlacement();
  }
  function choosePreset(next: typeof preset) {
    setMaximizedId(undefined);
    setPreset(next);
    setLayout(value => ({ ...value, panes: value.panes.map(({ dockFrame, dockSize, ...pane }) => pane), dock: arrangeDock(dockPaneIds(value.dock), next) }));
  }
  function restore(saved: SavedLayout) {
    if (!fileEditorsReady()) { setLayoutNotice(t('Unsaved draft kept. Save or discard before opening the linked file.')); return false; }
    const allowed = new Set([...available.keys()].filter(key => !dismissed.has(key)));
    const result = restoreSavedLayout(saved, allowed, current);
    if (!result.workspace) { setLayoutNotice(t('No sessions in this layout are currently available.')); return false; }
    if (uiMode === 'os-desktop') {
      writeOsDesktopLayout(scope, current, collapsedKeys);
      writeWorkspaceUiMode(scope, 'classic');
      setUiMode('classic');
    }
    setMaximizedId(undefined);
    setLayout(result.workspace);
    const restoredKeys = new Set(result.workspace.panes.map(paneKey));
    setCollapsedKeys(new Set(saved.collapsedKeys.filter(key => restoredKeys.has(key))));
    const focused = result.workspace.panes.find(pane => pane.id === result.workspace!.active) ?? result.workspace.panes[0]!;
    if (focused && isSessionPane(focused)) { setPreviousSelection(focused.sessionKey); onSelect(available.get(focused.sessionKey)!); }
    setLayoutNotice(result.missing ? t('Layout restored · {count} unavailable sessions skipped', { count: result.missing }) : t('Layout restored'), true);
    return true;
  }
  function close(id: string) {
    if (!fileEditorsReady(id)) { setLayoutNotice(t('Unsaved draft kept. Save or discard before opening the linked file.')); return; }
    if (visible.length < 2 && visible[0]?.session) return;
    const removed = visible.find(pane => pane.id === id);
    if (removed?.subagents) {
      subagentManualHoldRef.current = false;
      subagentHadLiveRef.current = false;
      setSubagentPinned(false);
      for (const sKey of openSessionKeysList) {
        const sess = available.get(sKey) ?? snapshots.current.get(sKey);
        const snap = sess ? getLiveSessionSnapshot(sKey, sess) : undefined;
        const companion = snap ? resolveSessionSubagentCompanion(snap.session ?? sess, snap.messages, snap.stale) : undefined;
        if (companion?.hasLiveDispatch) dismissedSubagentWavesRef.current.set(sKey, companion.waveId);
      }
    }
    setLayout(value => closeWorkspacePane(value, id));
    const next = visible.find(pane => pane.id !== id && pane.session)?.session;
    if (removed?.sessionKey === selected?.sessionKey && next) onSelect(next);
  }
  function activate(pane: typeof visible[number]) {
    const isTopFloating =
      !current.floating.some(item => item.id === pane.id) ||
      current.floating[current.floating.length - 1]?.id === pane.id;
    if (current.active !== pane.id || !isTopFloating) {
      setLayout(value => {
        const floatingIdx = value.floating.findIndex(item => item.id === pane.id);
        const nextFloating =
          floatingIdx >= 0 && floatingIdx < value.floating.length - 1
            ? [...value.floating.filter(item => item.id !== pane.id), value.floating[floatingIdx]!]
            : value.floating;
        if (value.active === pane.id && nextFloating === value.floating) return value;
        return { ...value, active: pane.id, floating: nextFloating };
      });
    }
    if (pane.session && selected?.sessionKey !== pane.sessionKey) onActivate(pane.session);
  }
  // Only current, open session cards qualify; cached snapshots are not authority.
  const draftTargetId = (pane: typeof visible[number]) => JSON.stringify([scope, pane.id, pane.sessionKey]);
  const readingDraftTargets = visible.flatMap((pane, index) => pane.session && available.has(pane.sessionKey)
    ? [{ id: draftTargetId(pane), title: sessionDraftTargetLabel(pane.title, pane.session.sessionRef?.runtimeId ?? pane.session.agentId ?? pane.session.source ?? t('Session'), pane.session.sessionRef?.nodeId, index) }] : []);
  const notebookTargetId = (pane: typeof visible[number]) => JSON.stringify([scope, pane.id, pane.notebook?.target, pane.notebook?.resourceId]);
  const readingNotebookTargets = visible.flatMap((pane, index) => pane.notebook && (pane.notebook.target === 'hub' || available.has(pane.notebook.resourceId))
    ? [{ id: notebookTargetId(pane), title: sessionDraftTargetLabel(pane.title, t('Notebook'), undefined, index) }] : []);
  const sourceTaskTargets=visible.flatMap((pane,index)=>pane.board?.kind==='taskboard'?[{id:JSON.stringify([scope,pane.id,pane.board.resourceId]),title:sessionDraftTargetLabel(pane.title,t('Task board'),undefined,index)}]:[]);
  const placeIssueTask=(targetId:string,task:import('@agentopsdeck/shared').BoardTask)=>{
    const pane=visible.find(p=>p.board?.kind==='taskboard'&&JSON.stringify([scope,p.id,p.board.resourceId])===targetId);
    if(!pane||!scope||recoveryScope()!==scope)return 'unavailable' as const;
    const host=Array.from(surface.current?.querySelectorAll<HTMLElement>('[data-remote-pane]')??[]).find(node=>node.dataset.remotePane===pane.id);
    return host?.isConnected?placeSourceTask(host,task):'unavailable' as const;
  };
  function placeReadingNotebook(targetId: string, text: string): NotebookTransferOutcome {
    const pane = visible.find(item => item.notebook && notebookTargetId(item) === targetId
      && (item.notebook.target === 'hub' || available.has(item.notebook.resourceId)));
    if (!pane || !scope || recoveryScope() !== scope) return 'unavailable';
    const host = Array.from(surface.current?.querySelectorAll<HTMLElement>('[data-remote-pane]') ?? [])
      .find(node => node.dataset.remotePane === pane.id);
    if (!host?.isConnected) return 'unavailable';
    // Do not activate/focus first: blur could save pending edits before admission.
    const outcome = placeNotebookReading(host, text);
    if (outcome === 'applied') flushSync(() => {
      activate(pane); setMaximizedId(undefined);
      setCollapsedKeys(value => { const next = new Set(value); next.delete(pane.sessionKey); return next; });
    });
    return outcome;
  }
  function placeReadingDraft(targetId: string, text: string): SessionDraftOutcome {
    const pane = visible.find(item => item.session && available.has(item.sessionKey) && draftTargetId(item) === targetId);
    if (!pane || !scope || recoveryScope() !== scope) return 'unavailable';
    const host = Array.from(surface.current?.querySelectorAll<HTMLElement>('[data-remote-pane]') ?? [])
      .find(node => node.dataset.remotePane === pane.id);
    if (!host) return 'unavailable';
    flushSync(() => {
      activate(pane); setMaximizedId(undefined);
      setCollapsedKeys(value => { const next = new Set(value); next.delete(pane.sessionKey); return next; });
    });
    if (!host.isConnected) return 'unavailable';
    delete host.dataset.composerReading; delete host.dataset.composerCollapsed; host.dataset.hoverComposer = 'true';
    return placeSessionDraft(host, text);
  }
  const sessionTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of overviewSessions) map.set(s.sessionKey, displayTitle(s));
    for (const p of visible) if (p.session) map.set(p.sessionKey, p.title);
    return map;
  }, [overviewSessions, visible]);
  const handleSelectCoBoundSession = useCallback((sKey: string) => {
    const targetPane = visible.find(p => p.session && p.sessionKey === sKey);
    if (targetPane) {
      activate(targetPane);
      return;
    }
    const s = available.get(sKey) ?? overviewSessions.find(item => item.sessionKey === sKey);
    if (s) onSelect(s);
  }, [visible, overviewSessions, onSelect]);
  const openSession = useCallback((session: SessionSummary) => {
    onSelect(session);
  }, [onSelect]);
  function updateFloating(id: string, rect: FloatingPane) {
    setLayout(value => ({ ...value, floating: value.floating.map(pane => pane.id === id ? fitFloating(rect, size.width, size.height, value.panes.find(item => item.id === id)) : pane) }));
  }
  // Pointer capture is released by the browser on cancel/unmount; no document listeners.
  const gesture = useRef<{ pointer: number; x: number; y: number; move: (dx: number, dy: number) => void } | null>(null);
  const gestureFrame = useRef<number | undefined>(undefined);
  const gestureDelta = useRef<[number, number]>([0, 0]);
  function cancelResize() {
    if (gestureFrame.current !== undefined) cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = undefined; gesture.current = null; setAlignmentGuides([]);
  }
  useEffect(() => () => { if (gestureFrame.current !== undefined) cancelAnimationFrame(gestureFrame.current); gesture.current = null; }, []);
  useEffect(() => { if (locked) { cancelPlacement(); cancelResize(); } }, [locked]);
  const flushGesture = () => { if (gestureFrame.current !== undefined) cancelAnimationFrame(gestureFrame.current); gestureFrame.current = undefined; gesture.current?.move(...gestureDelta.current); };
  function start(event: PointerEvent<HTMLElement>, move: (dx: number, dy: number) => void) {
    if (locked || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, move };
    gestureDelta.current = [0, 0];
  }
  const pointerHandlers = {
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const action = gesture.current;
      if (action?.pointer === event.pointerId) { gestureDelta.current = [event.clientX - action.x, event.clientY - action.y]; if (gestureFrame.current === undefined) gestureFrame.current = requestAnimationFrame(flushGesture); }
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => { if (gesture.current?.pointer === event.pointerId) { gestureDelta.current = [event.clientX - gesture.current.x, event.clientY - gesture.current.y]; flushGesture(); gesture.current = null; setAlignmentGuides([]); } },
    onPointerCancel: cancelResize,
    onLostPointerCapture: cancelResize,
  };
  function keyboardDelta(event: KeyboardEvent<HTMLElement>, move: (dx: number, dy: number) => void) {
    if (locked) return;
    const step = event.shiftKey ? 40 : 10;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (delta[event.key]) { event.preventDefault(); move(...delta[event.key]!); }
  }
  function keyboardPlacement(event: KeyboardEvent<HTMLElement>, id: string, move: (dx: number, dy: number) => void) {
    if (locked || drag.current || maximized) return; // Keep saved geometry unchanged during previews/maximization.
    const sides = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' } as const;
    if (event.altKey && event.key in sides) {
      event.preventDefault();
      const proposed = placeWorkspacePane(current, id, { target: null, side: sides[event.key as keyof typeof sides] });
      if (dockFitsWorkspace(proposed, size.width, size.height)) setLayout(proposed);
    } else keyboardDelta(event, move);
  }
  const remoteNotes = notebooks.filter(note => !note.hidden && !current.panes.some(pane => pane.kind === 'notebook' && pane.resourceId === note.id));
  const resourceCapacityFull = current.panes.filter(pane => !isSessionPane(pane)).length >= MAX_RESOURCE_PANES;
  const applyWorkspaceTemplate = useCallback((tplId: WorkspaceTemplateId, autoSave = true) => {
    void import('../lib/layout-templates').then(async ({ prepareTemplateOptions, buildWorkspaceFromTemplate, autoBindTemplateResources, createHubNotebookLayoutPayload }) => {
      const suffix = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const tplOptions = prepareTemplateOptions(tplId, sessions, dismissed, selected?.sessionKey, notebooks[0]?.id);
      if (tplId === 'moderator-mode' && onCreateTemplateSession) {
        const [modKey, scoutKey] = await Promise.all([
          onCreateTemplateSession(`Moderator · ${suffix}`).catch(() => undefined),
          onCreateTemplateSession(`Scout · ${suffix}`).catch(() => undefined),
        ]);
        if (modKey) tplOptions.primarySessionKey = modKey;
        if (scoutKey) tplOptions.secondarySessionKey = scoutKey;
      }
      if (scope && tplId === 'moderator-mode') {
        const { loadModeratorOrchestrationConfig, saveModeratorOrchestrationConfig } = await import('../lib/moderator-orchestrator');
        const currentCfg = loadModeratorOrchestrationConfig(scope);
        saveModeratorOrchestrationConfig(scope, {
          ...currentCfg,
          moderatorSessionKey: tplOptions.primarySessionKey ?? currentCfg.moderatorSessionKey,
          scoutSessionKey: tplOptions.secondarySessionKey ?? currentCfg.scoutSessionKey,
          notebookTarget: tplOptions.notebookTarget ?? 'hub',
          notebookId: tplOptions.notebookResourceId ?? 'default',
          taskboardId: tplOptions.taskboardResourceId ?? 'default',
        });
      }
      const nextWorkspace = buildWorkspaceFromTemplate(tplId, tplOptions);
      setLayout(nextWorkspace);
      setMaximizedId(undefined);
      if (autoSave && typeof window !== 'undefined') {
        const tplName = tplId === 'moderator-mode'
          ? t('Apply template: Moderator Mode')
          : tplId === 'collab-pair'
            ? t('Apply template: Dual Session + Notes & Taskboard')
            : t('Apply template: Research & Triage Deck');
        const cleanLabel = tplName.replace(/^(Apply template:\s*|应用布局模板：\s*)/i, '');
        window.dispatchEvent(new CustomEvent('agentopsdeck:auto-save-template-layout', {
          detail: { name: `${cleanLabel} · ${suffix}`.slice(0, 80), workspace: nextWorkspace },
        }));
      }
      if (scope) {
        void autoBindTemplateResources(scope, tplId, { ...tplOptions, resourceTitleSuffix: suffix }, {
          fileCardBinding: api.fileCardBinding,
          bindFileCard: api.bindFileCard,
          fileBoardBinding: api.fileBoardBinding,
          bindFileBoard: api.bindFileBoard,
          ensureHubNotebook: async (id, title) => {
            const r = await api.hubNotebookById(id, true);
            const savedLayout = r.revision
              ? r
              : await api.saveHubNotebookById(id, {
                  resourceId: r.resourceId || JSON.stringify(['hub-notebook-layout', 1, id]),
                  revision: 0,
                  text: createHubNotebookLayoutPayload(title),
                }, true);
            updateNotebookCatalog(items => [...items.filter(item => item.resourceId !== savedLayout.resourceId), savedLayout]);
            const contentDoc = await api.hubNotebookById(id, false).catch(() => undefined);
            if (contentDoc && !contentDoc.revision) {
              await api.saveHubNotebookById(id, {
                resourceId: contentDoc.resourceId || JSON.stringify(['hub-notebook', 1, id]),
                revision: 0,
                text: `# ${title}\n`,
              }, false).catch(() => undefined);
            }
          },
          ensureWorkspaceBoard: async (id, title) => {
            const r = await api.workspaceBoard(id);
            const savedBoard = r.revision
              ? r
              : await api.saveWorkspaceBoard(id, { title, revision: 0, mutationId: crypto.randomUUID(), tasks: [] });
            writeCachedBoardDocument(scope, id, savedBoard);
            publishBoardSaved(scope, savedBoard);
          },
          sendGuidancePrimer: (k, text) => import('../lib/message-submission').then(m => m.sendMessageWithRecovery(k, text, 'web-only', [], crypto.randomUUID())),
        });
      }
    });
  }, [sessions, dismissed, selected?.sessionKey, notebooks, onCreateTemplateSession, scope, t, updateNotebookCatalog]);
    useEffect(() => {
    const projected = typeof window !== "undefined" ? parseProjectionSearch(window.location.search) : null;
    if (!projected) return;
    if (projected.sessionKey) {
      const sess = available.get(projected.sessionKey);
      if (sess) openSession(sess);
    } else if (projected.kind === "taskboard" || projected.kind === "drawing" || projected.kind === "statuscard") {
      openBoardResource(projected.kind, projected.resourceId ?? "default");
    } else if (projected.kind === "notebook") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "notebook", target: "hub", resourceId: projected.resourceId ?? (notebooks[0]?.id ?? "default") }, size.width, size.height));
    }
  }, []);
  const osDesktopCompletedSet = useMemo(() => new Set(completed.keys()), [completed]);
  const rawPaneById = useMemo(() => new Map(current.panes.map(p => [p.id, p])), [current.panes]);
  const osDesktopOpenWindows = useMemo(() => {
    if (uiMode !== "os-desktop") return [];
    return visible.map(pane => {
      const rawDef = rawPaneById.get(pane.id);
      const kind: DesktopIconKind = pane.session ? "session"
        : pane.notebook ? "notebook"
        : pane.board?.kind === "taskboard" ? "taskboard"
        : pane.drawing ? "drawing"
        : pane.terminal ? "terminal"
        : pane.moderator ? "moderator"
        : pane.docker ? "docker"
        : pane.subagents ? "subagents"
        : pane.antigravityQuota ? "antigravity-quota"
        : pane.gitRepoStatus ? "git-repo-status"
        : pane.files ? "file-browser"
        : rawDef && !isSessionPane(rawDef) && rawDef.kind === "git-tree" ? "git-tree"
        : rawDef && !isSessionPane(rawDef) && rawDef.kind === "browser" ? "browser"
        : rawDef && !isSessionPane(rawDef) && rawDef.kind === "dashboard" ? "dashboard"
        : "session";
      const running = !!pane.session && hasQueueBlockingRun(pane.session) && pane.session.runtime?.operation !== "compact";
      const resourceId = pane.notebook?.resourceId
        ?? pane.board?.resourceId
        ?? (rawDef && !isSessionPane(rawDef) && 'resourceId' in rawDef ? rawDef.resourceId : undefined);
      return {
        id: pane.id,
        sessionKey: pane.sessionKey,
        title: pane.title,
        kind,
        resourceId,
        running,
        unread: completed.has(pane.sessionKey),
      };
    });
  }, [uiMode, visible, rawPaneById, completed]);

  const openAntigravityQuota = useCallback(() => {
    if (!scope) return;
    const pane = { id: `pane:${crypto.randomUUID()}`, kind: 'antigravity-quota', resourceId: 'account' } as const;
    setLayout(value => openResourcePane(value, pane, size.width, size.height));
    setCollapsedKeys(previous => {
      const key = paneKey(pane);
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, [scope, size.width, size.height]);

  const openGitRepoStatus = useCallback(() => {
    if (!scope) return;
    const pane = { id: `pane:${crypto.randomUUID()}`, kind: 'git-repo-status', resourceId: crypto.randomUUID() } as const;
    setLayout(value => openResourcePane(value, pane, size.width, size.height));
  }, [scope, size.width, size.height]);

  const openSessionHub = useCallback(() => {
    if (!scope) return;
    const pane = { id: `pane:${crypto.randomUUID()}`, kind: 'session-hub', resourceId: crypto.randomUUID() } as const;
    setLayout(value => openResourcePane(value, pane, size.width, size.height));
  }, [scope, size.width, size.height]);

  const handleOpenDesktopIcon = useCallback((item: DesktopIconItem) => {
    if (item.kind === "antigravity-quota") {
      openAntigravityQuota();
      return;
    }
    if (item.kind === "git-repo-status") {
      openGitRepoStatus();
      return;
    }
    if (item.kind === "session" && item.session) {
      const sessKey = item.session.sessionKey;
      setLayout(value => {
        const next = selectWorkspaceSession(value, sessKey, selected?.sessionKey, `pane:${crypto.randomUUID()}`, size.width, size.height);
        if (next !== value) return next;
        const alreadyOpen = value.panes.some(p => isSessionPane(p) && p.sessionKey === sessKey);
        if (!alreadyOpen) {
          const newId = `pane:${crypto.randomUUID()}`;
          const withPane = { ...value, panes: [...value.panes, { id: newId, sessionKey: sessKey }] };
          return insertWorkspacePane(withPane, newId, size.width, size.height, preset);
        }
        return value;
      });
      setCollapsedKeys(prev => { const s = new Set(prev); s.delete(sessKey); return s; });
      openSession(item.session);
      return;
    }
    if (item.id === "action:new-notebook" || (item.kind === "notebook" && item.variant === "new-action")) {
      const newId = crypto.randomUUID();
      const suffix = new Date().toISOString().slice(11, 16);
      const title = `${t("Global notebook")} · ${suffix}`;
      void import("../lib/layout-templates").then(async ({ createHubNotebookLayoutPayload }) => {
        try {
          const existing = await api.hubNotebookById(newId, true);
          const savedLayout = existing.revision
            ? existing
            : await api.saveHubNotebookById(newId, {
                resourceId: existing.resourceId || JSON.stringify(["hub-notebook-layout", 1, newId]),
                revision: 0,
                text: createHubNotebookLayoutPayload(title),
              }, true);
          updateNotebookCatalog(items => [...items.filter(entry => entry.resourceId !== savedLayout.resourceId), savedLayout]);
          await api.saveHubNotebookById(newId, {
            resourceId: JSON.stringify(["hub-notebook", 1, newId]),
            revision: 0,
            text: `# ${title}\n`,
          }, false).catch(() => undefined);
        } catch {
          // Ignore network errors; pane will still open and reconcile
        }
        setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "notebook", target: "hub", resourceId: newId }, size.width, size.height));
      });
      return;
    }
    if (item.id === "action:new-taskboard" || (item.kind === "taskboard" && item.variant === "new-action")) {
      const newBoardId = crypto.randomUUID();
      const suffix = new Date().toISOString().slice(11, 16);
      const title = `${t("Task board")} · ${suffix}`;
      void (async () => {
        try {
          const savedBoard = await api.saveWorkspaceBoard(newBoardId, {
            title,
            revision: 0,
            mutationId: crypto.randomUUID(),
            tasks: [],
          });
          if (scope) {
            writeCachedBoardDocument(scope, newBoardId, savedBoard);
            publishBoardSaved(scope, savedBoard);
          }
        } catch {
          // Ignore network errors; pane will still open
        }
        openBoardResource("taskboard", newBoardId);
      })();
      return;
    }
    if (item.kind === "notebook") {
      const noteId = item.resourceId ?? notebooks[0]?.id ?? "default";
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "notebook", target: "hub", resourceId: noteId }, size.width, size.height));
      return;
    }
    if (item.kind === "taskboard" || item.kind === "statuscard" || item.kind === "drawing") {
      openBoardResource(item.kind, item.resourceId ?? "default");
      return;
    }
    if (item.kind === "dashboard") {
      setLayout(value => openDashboardPane(value, `pane:${crypto.randomUUID()}`, size.width, size.height));
      return;
    }
    if (item.kind === "terminal") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "terminal", resourceId: "catalog" }, size.width, size.height));
      return;
    }
    if (item.kind === "moderator") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "moderator", resourceId: "control" }, size.width, size.height));
      return;
    }
    if (item.kind === "docker") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "docker", resourceId: "manager" }, size.width, size.height));
      return;
    }
    if (item.kind === "subagents") {
      subagentManualHoldRef.current = true;
      setLayout(value =>
        dockSubagentCompanionPane(value, selected?.sessionKey ?? "", `pane:${crypto.randomUUID()}`, size.width, size.height),
      );
      return;
    }
    if (item.kind === "file-browser") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "file-browser", resourceId: crypto.randomUUID() }, size.width, size.height));
      return;
    }
    if (item.kind === "git-tree") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "git-tree", resourceId: crypto.randomUUID() }, size.width, size.height));
      return;
    }
    if (item.kind === "browser") {
      setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: "browser", resourceId: crypto.randomUUID() }, size.width, size.height));
    }
  }, [selected?.sessionKey, size.width, size.height, preset, openSession, openAntigravityQuota, openGitRepoStatus, notebooks, scope, t, updateNotebookCatalog]);
  const renderPaneBody = (pane: typeof visible[number], collapsed: boolean) => (
    pane.antigravityQuota ? <Suspense fallback={<p role="status">{t('Loading…')}</p>}><AntigravityUsagePanel key={scope} scope={scope ?? ''} /></Suspense> :
    pane.gitRepoStatus ? <Suspense fallback={<p role="status">{t('Loading…')}</p>}><GitRepoStatusPanel key={`${scope}:${pane.gitRepoStatus.resourceId}`} scope={scope ?? ''} cardId={pane.gitRepoStatus.resourceId} /></Suspense> :
    pane.sessionHub ? <Suspense fallback={<p role="status">{t('Loading…')}</p>}><WorkspaceSessionHub key={`${scope}:${pane.sessionHub.resourceId}`} scope={scope ?? ''} cardId={pane.sessionHub.resourceId} sessions={overviewSessions} completedSessionKeys={osDesktopCompletedSet} initialSessionKey={selected?.sessionKey} renderPane={renderPane} onOpenStandalone={openSession} onCreateSession={onCreateSession} /></Suspense> :
    pane.session ? <WorkspaceSessionContent session={pane.session} renderPane={renderPane} /> : pane.website ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceWebsite key={`${scope}:${pane.website.resourceId}`} scope={scope ?? ""} resourceId={pane.website.resourceId} onOpen={openBoardResource} /></Suspense> : pane.nativeDrawio ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceNativeDrawio key={`${scope}:${pane.nativeDrawio.resourceId}`} scope={scope ?? ""} resourceId={pane.nativeDrawio.resourceId} onOpen={openBoardResource} /></Suspense> : pane.drawing ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceDrawing key={`${scope}:${pane.drawing.resourceId}`} scope={scope ?? ""} resourceId={pane.drawing.resourceId} onOpen={openBoardResource} /></Suspense> : pane.board ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}>{pane.board.kind === "taskboard"
      ? <WorkspaceTaskboard key={`${scope}:${pane.board.resourceId}`} scope={scope ?? ""} resourceId={pane.board.resourceId} onOpen={openBoardResource} />
      : <WorkspaceStatusCard key={`${scope}:${pane.board.resourceId}`} scope={scope ?? ""} resourceId={pane.board.resourceId} onOpen={openBoardResource} />}</Suspense> : pane.notebook ? (
      pane.notebook.target === "session" ? (available.has(pane.notebook.resourceId) ? <WorkspaceNotebook sessionKey={pane.notebook.resourceId} title={pane.title} /> : <p role="status">{t("Notebook unavailable")}</p>)
        : notebooks.some(note => note.id === pane.notebook!.resourceId) ? <WorkspaceNotebook initial={notebooks.find(note => note.id === pane.notebook!.resourceId)!.document} title={pane.title} onActivate={() => activate(pane)} /> : <WorkspaceNotebook globalId={pane.notebook.resourceId} title={pane.title} onActivate={() => activate(pane)} />
    ) : current.panes.find(value => value.id === pane.id)?.kind === "git-tree" ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceDraftTargets.Provider value={{ targets: readingDraftTargets, place: placeReadingDraft }}><WorkspaceNotebookTargets.Provider value={{ targets: readingNotebookTargets, place: placeReadingNotebook }}><WorkspaceGitTree key={`${scope}:${pane.id}`} scope={scope ?? ""} cardId={pane.id} /></WorkspaceNotebookTargets.Provider></WorkspaceDraftTargets.Provider></Suspense> : current.panes.find(value => value.id === pane.id)?.kind === "issue-source" ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceDraftTargets.Provider value={{ targets: readingDraftTargets, place: placeReadingDraft }}><WorkspaceNotebookTargets.Provider value={{ targets: readingNotebookTargets, place: placeReadingNotebook }}><SourceTaskTargets.Provider value={{targets:sourceTaskTargets,place:placeIssueTask}}><WorkspaceIssues key={`${scope}:${pane.id}`} scope={scope ?? ""} cardId={pane.id} /></SourceTaskTargets.Provider></WorkspaceNotebookTargets.Provider></WorkspaceDraftTargets.Provider></Suspense> : pane.files ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceFiles id={pane.id} kind={pane.files} /></Suspense> : pane.report ? <Suspense fallback={null}><WorkspaceReport key={`${scope}:${pane.report.resourceId}`} scope={scope ?? ""} resourceId={pane.report.resourceId} /></Suspense> : pane.browser ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceBrowser key={scope} scope={scope ?? ""} active={!collapsed && active?.id === pane.id} /></Suspense> : pane.metricCard ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceMetricCard key={`${scope}:${pane.metricCard.resourceId}`} scope={scope ?? ""} resourceId={pane.metricCard.resourceId} onOpen={openBoardResource} /></Suspense> : pane.terminal ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceTerminal key={`${scope}:${pane.id}`} scope={scope ?? ""} cardId={pane.id} /></Suspense> : pane.docker ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceDocker key={`${scope}:${pane.id}`} scope={scope ?? ""} /></Suspense> : pane.subagents ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceSubagentCompanion sessions={overviewSessions} openSessionKeys={openSessionKeysList} activeParentSessionKey={active?.session?.sessionKey ?? selected?.sessionKey} preferredSessionKey={preferredSubagentParentKey} onSelectParentSession={sess => handleSelectCoBoundSession(sess.sessionKey)} onPinnedChange={setSubagentPinned} /></Suspense> : pane.research ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceDraftTargets.Provider value={{ targets: readingDraftTargets, place: placeReadingDraft }}><WorkspaceNotebookTargets.Provider value={{ targets: readingNotebookTargets, place: placeReadingNotebook }}><WorkspaceResearch key={scope} scope={scope ?? ""} /></WorkspaceNotebookTargets.Provider></WorkspaceDraftTargets.Provider></Suspense> : pane.moderator ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceModeratorControl scope={scope ?? ""} sessions={overviewSessions} notebooks={notebooks} onSelectSession={openSession} onRetarget={(prevCfg, nextCfg) => { void import("../lib/layout-templates").then(({ retargetModeratorWorkspace }) => setLayout(val => retargetModeratorWorkspace(val, prevCfg, nextCfg))); }} /></Suspense> : pane.media ? <Suspense fallback={<p role="status">{t("Loading…")}</p>}><div className="workspace-media-card"><MediaLibrary paneId={pane.id} /></div></Suspense> : <Suspense fallback={<p role="status">{t("Loading…")}</p>}><WorkspaceDashboard sessions={overviewSessions} onSelect={openSession} /></Suspense>
  );
  const settings = <>
      {scope && <Suspense fallback={null}><WorkspaceRemoteHost snapshot={{ targets: [...visible.flatMap((pane): RemoteTarget[] => {
        if (!pane.session && !pane.notebook) return [];
        const cleanTitle = pane.title.slice(0, 160).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ') || t('Untitled');
        if (pane.notebook) return [{ id: pane.id, title: cleanTitle, kind: 'notebook' as const }];
        const sess = pane.session!;
        const rawStatus = sess.structuredStatus?.runState ?? sess.status;
        const status: 'idle' | 'running' | 'waiting' | 'error' = rawStatus === 'running' || sess.hasActiveRun ? 'running' : rawStatus === 'waiting' ? 'waiting' : rawStatus === 'failed' ? 'error' : 'idle';
        const elapsedSec = status === 'running' && sess.runStartedAt ? Math.max(0, Math.min(864000, Math.floor((Date.now() - sess.runStartedAt) / 1000))) : undefined;
        const snippet = sess.recent ? sess.recent.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 160) : undefined;
        const tokens = typeof sess.totalTokens === 'number' && Number.isSafeInteger(sess.totalTokens) && sess.totalTokens >= 0 ? Math.min(1_000_000_000, sess.totalTokens) : undefined;
        const unread = completed.has(sess.sessionKey);
        return [{ id: pane.id, title: cleanTitle, kind: 'session' as const, status, ...(unread ? { unread: true } : {}), ...(elapsedSec !== undefined ? { elapsedSec } : {}), ...(snippet ? { snippet } : {}), ...(tokens !== undefined ? { tokens } : {}) }];
      }), ...remoteNotes.map(note => ({ id: `note:${note.id}`, title: note.title.slice(0, 160).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ') || t('Notebook'), kind: 'notebook' as const }))].slice(0, 64), active: visible.some(pane => pane.id === active?.id && (pane.session || pane.notebook)) ? active!.id : null }} execute={command => {
        const note = remoteNotes.find(item => `note:${item.id}` === command.target);
        if (note) {
          if (command.action === 'send') return 'unavailable';
          const element = Array.from(document.querySelectorAll<HTMLElement>('[data-remote-notebook]')).find(node => node.dataset.remoteNotebook === note.id);
          if (!element) return 'unavailable';
          element.dispatchEvent(new Event('agentopsdeck:remote-focus'));
          if (command.action === 'draft') return placeRemoteDraft(element, command.text!);
          return element.contains(document.activeElement) ? 'applied' : 'unavailable';
        }
        const pane = visible.find(item => item.id === command.target && (item.session || item.notebook));
        const host = Array.from(surface.current?.querySelectorAll<HTMLElement>('[data-remote-pane]') ?? []).find(node => node.dataset.remotePane === command.target);
        if (!pane || !host) return 'unavailable';
        if (command.action === 'send' && !pane.session) return 'unavailable';
        flushSync(() => { activate(pane); setMaximizedId(undefined); setCollapsedKeys(value => { const next = new Set(value); next.delete(pane.sessionKey); return next; }); });
        delete host.dataset.composerReading; delete host.dataset.composerCollapsed; host.dataset.hoverComposer = 'true';
        if (command.action === 'draft') return placeRemoteDraft(host, command.text!);
        if (command.action === 'send') return sendRemoteMessage(host, command.text!, `remote:${command.id}`);
        host.querySelector<HTMLElement>('.desktop-composer-textarea, .tiptap[contenteditable="true"]')?.focus({ preventScroll: true });
        return host.contains(document.activeElement) ? 'applied' : 'unavailable';
      }} /></Suspense>}
      <LayoutSyncStatus sync={layoutSync} />
      <button type="button" disabled={!scope} aria-pressed={locked} aria-label={t(locked ? 'Unlock layout' : 'Lock layout')} title={t(locked ? 'Unlock layout' : 'Lock layout')} onClick={() => {
        cancelPlacement(); cancelResize();
        setLocked(!locked);
        try { if (lockKey && recoveryScope() === scope) localStorage.setItem(lockKey, String(!locked)); }
        catch { setLayoutNotice(t('Layout could not be saved in this browser.')); }
      }}>{locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
      <button type="button" data-testid="workspace-theme-toggle" aria-pressed={colorMode === 'dark'} aria-label={t(colorMode === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode')} title={t(colorMode === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode')} onClick={() => setColorMode(toggleWorkspaceColorMode(colorMode))}>{colorMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>
      <button type="button" disabled={!scope} aria-pressed={uiMode === 'os-desktop'} aria-label={t(uiMode === 'os-desktop' ? 'Switch to classic tiling view' : 'Switch to OS desktop mode')} title={t(uiMode === 'os-desktop' ? 'Switch to classic tiling view' : 'Switch to OS desktop mode')} onClick={() => toggleUiMode()}><Monitor size={14} /></button>
      <Suspense fallback={null}><MultiScreenToolbar activeTarget={active ? { paneId: active.id, kind: active.session ? 'session' : (current.panes.find(p => p.id === active.id)?.kind ?? 'workspace'), title: active.title, sessionKey: active.session?.sessionKey, resourceId: current.panes.find(p => p.id === active.id && !isSessionPane(p)) && 'resourceId' in (current.panes.find(p => p.id === active.id) as object) ? (current.panes.find(p => p.id === active.id) as { resourceId?: string }).resourceId : undefined } : undefined} onSelectSessionKey={key => { const sess = available.get(key); if (sess) openSession(sess); }} /></Suspense>
      <Suspense fallback={null}><SavedLayouts workspace={{ ...current, active: active?.id ?? null }} collapsedKeys={collapsedKeys} onRestore={restore} onApplyTemplate={applyWorkspaceTemplate} quickSwitchHost={quickSwitchHost} uiMode={uiMode} onSelectOsDesktop={() => toggleUiMode('os-desktop')} /></Suspense>
    </>;
  const renderResourceMenu = (menuRef?: Ref<HTMLDivElement>) => <div ref={menuRef} className="session-workspace-preset-menu">
      <div className="workspace-menu-group workspace-menu-grid" role="group" aria-label={t('Status cards')}>
        <div className="workspace-menu-group-title" aria-hidden="true">{t('Status cards')}</div>
        <button type="button" className="workspace-menu-feature" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'antigravity-quota'))} onClick={event => {
          openAntigravityQuota();
          const menu = event.currentTarget.closest('details');
          if (menu) { menu.open = false; presetSummaryRef.current?.focus(); }
          closeContextMenu();
        }}><span className="workspace-glass-emblem"><CardKindIcon kind="antigravity-quota" /></span><span>{t('Antigravity account quota')}</span><ArrowUpRight className="workspace-menu-feature-arrow" size={16} aria-hidden="true" /></button>
        <button type="button" className="workspace-menu-feature" disabled={!scope || resourceCapacityFull} onClick={event => {
          openGitRepoStatus();
          const menu = event.currentTarget.closest('details');
          if (menu) { menu.open = false; presetSummaryRef.current?.focus(); }
          closeContextMenu();
        }}><span className="workspace-glass-emblem"><CardKindIcon kind="git-repo-status" /></span><span>{t('Git repository status')}</span><ArrowUpRight className="workspace-menu-feature-arrow" size={16} aria-hidden="true" /></button>
        <button type="button" disabled={!scope || resourceCapacityFull} onClick={event => { openBoardResource('metric-card', 'catalog'); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="metric-card" />{t('Custom status cards')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'dashboard'))} onClick={event => { setLayout(value => openDashboardPane(value, `pane:${crypto.randomUUID()}`, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="dashboard" />{t('Workspace overview · Preview')}</button>
        <button type="button" disabled={!scope || resourceCapacityFull} onClick={event => { openBoardResource('report', crypto.randomUUID()); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="report" />{t('Report')}</button>
      </div>
      <div className="workspace-menu-group" role="group" aria-label={t('Sessions')}>
        <div className="workspace-menu-group-title" aria-hidden="true">{t('Sessions')}</div>
        <button type="button" className="workspace-menu-feature" disabled={!scope || resourceCapacityFull} onClick={event => {
          openSessionHub();
          const menu = event.currentTarget.closest('details');
          if (menu) { menu.open = false; presetSummaryRef.current?.focus(); }
          closeContextMenu();
        }}><span className="workspace-glass-emblem"><CardKindIcon kind="session-hub" /></span><span>{t('Multi-session switcher')}</span><ArrowUpRight className="workspace-menu-feature-arrow" size={16} aria-hidden="true" /></button>
        {onCreateSession && <button type="button" onClick={event => { onCreateSession(); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="session" />{t('New session')}</button>}
        <label className="workspace-add-session">{t('Add session card')}<select name="sessionworkspaceview-select-1" aria-label={t('Add session card')} value="" onChange={event => {
          const key = event.target.value;
          if (!key) return;
          const next = selectWorkspaceSession(current, key, selected?.sessionKey, `pane:${crypto.randomUUID()}`, size.width, size.height);
          if (next === current) setLayoutNotice(t('Workspace session limit reached. Close a session card before opening another.'));
          else {
            setLayout(next); setMaximizedId(undefined); setLayoutNotice('');
            const session = available.get(key);
            if (session) { setPreviousSelection(key); onSelect(session); }
          }
          event.currentTarget.closest('details')?.removeAttribute('open'); closeContextMenu();
        }}><option value="">{t('Choose a session')}</option>{sessions.filter(session => !dismissed.has(session.sessionKey) && !current.panes.some(pane => isSessionPane(pane) && pane.sessionKey === session.sessionKey)).map(session => <option key={session.sessionKey} value={session.sessionKey}>{displayTitle(session)}</option>)}</select></label>
        {selected && !dismissed.has(selected.sessionKey) && <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'notebook' && pane.target === 'session' && pane.resourceId === selected.sessionKey))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'notebook', target: 'session', resourceId: selected.sessionKey }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><StickyNote size={15} />{t('Session notebook · Preview')}</button>}
        {notebooks.length > 0 && <div className="workspace-notebook-choices" role="group" aria-label={t('Open global notebook')}>{notebooks.map(note => <button key={note.id} type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'notebook' && pane.target === 'hub' && pane.resourceId === note.id))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'notebook', target: 'hub', resourceId: note.id }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><StickyNote size={15} /><span>{t('Open notebook: {name}', { name: note.title || t('Global notebook') })}</span></button>)}</div>}
      </div>
      <div className="workspace-menu-group workspace-menu-grid" role="group" aria-label={t('Files and tools')}>
        <div className="workspace-menu-group-title" aria-hidden="true">{t('Files and tools')}</div>
        {(['file-browser', 'file-editor', 'image-viewer'] as const).map(kind => <button key={kind} type="button" disabled={!scope || resourceCapacityFull} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind, resourceId: crypto.randomUUID() }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind={kind} />{t(fileCardLabel(kind))}</button>)}
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'research'))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'research', resourceId: 'search' }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="research" />{t('Search and sources · Preview')}</button>
        <button type="button" disabled={!scope || resourceCapacityFull} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'git-tree', resourceId: crypto.randomUUID() }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="git-tree" />{t('Repository tree')}</button>
        <button type="button" disabled={!scope || resourceCapacityFull} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'issue-source', resourceId: crypto.randomUUID() }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="issue-source" />{t('Issue sources')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'terminal'))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'terminal', resourceId: 'catalog' }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="terminal" />{t('Connector terminal')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'docker'))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'docker', resourceId: 'manager' }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="docker" />{t('Docker & Sandboxes')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'subagents'))} onClick={event => { subagentManualHoldRef.current = true; setLayout(value => dockSubagentCompanionPane(value, selected?.sessionKey ?? '', `pane:${crypto.randomUUID()}`, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="subagents" />{t('Sub-agent Companion')}</button>
        <button type="button" disabled={!scope || resourceCapacityFull} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'browser', resourceId: crypto.randomUUID() }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="browser" />{t('Browser card')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'website' && pane.resourceId === 'catalog'))} onClick={event => { openBoardResource('website', 'catalog'); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="website" />{t('Connector website · Preview')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'media'))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'media', resourceId: 'library' }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="media" />{t('Media library')}</button>
      </div>
      <div className="workspace-menu-group workspace-menu-grid" role="group" aria-label={t('Collaboration')}>
        <div className="workspace-menu-group-title" aria-hidden="true">{t('Collaboration')}</div>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'taskboard'))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'taskboard', resourceId: 'default' }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="taskboard" />{t('Task board · Preview')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'drawing'))} onClick={event => { openBoardResource('drawing', 'default'); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="drawing" />{t('Whiteboard · Preview')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'native-drawio'))} onClick={event => { openBoardResource('native-drawio', 'default'); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="native-drawio" />{t('Native draw.io · Preview')}</button>
        <button type="button" disabled={!scope || (resourceCapacityFull && !current.panes.some(pane => pane.kind === 'moderator'))} onClick={event => { setLayout(value => openResourcePane(value, { id: `pane:${crypto.randomUUID()}`, kind: 'moderator', resourceId: 'control' }, size.width, size.height)); event.currentTarget.closest('details')?.removeAttribute('open'); }}><CardKindIcon kind="moderator" />{t('Moderator Control Center')}</button>
      </div>
      <div className="workspace-menu-group" role="group" aria-label={t('Layout templates')}>
        <div className="workspace-menu-group-title" aria-hidden="true">{t('Layout templates')}</div>
        {([['moderator-mode', 'Apply template: Moderator Mode', 'moderator'], ['collab-pair', 'Apply template: Dual Session + Notes & Taskboard', 'taskboard'], ['research-triage', 'Apply template: Research & Triage Deck', 'research']] as const).map(([tplId, tplLabel, tplKind]) => (
          <button key={tplId} type="button" disabled={!scope} onClick={event => {
            event.currentTarget.closest('details')?.removeAttribute('open');
            applyWorkspaceTemplate(tplId as WorkspaceTemplateId, true);
          }}><CardKindIcon kind={tplKind} />{t(tplLabel)}</button>
        ))}
      </div>
      <div className="workspace-menu-group workspace-menu-grid" role="group" aria-label={t('Arrange workspace')}>
        <div className="workspace-menu-group-title" aria-hidden="true">{t('Arrange workspace')}</div>
        {current.panes.some(pane => !isSessionPane(pane)) && <button type="button" onClick={event => { setLayout(closePreviewPanes); event.currentTarget.closest('details')?.removeAttribute('open'); }} title={t('Notes and saved layouts are kept.')}><X size={15} />{t('Close Preview panels')}</button>}
        <button type="button" onClick={event => { setLayout({ ...current, panes: current.panes.map(({ dockSize, dockFrame, ...pane }) => pane), dock: equalizeDock(current.dock) }); event.currentTarget.closest('details')?.removeAttribute('open'); }}><PanelsTopLeft size={15} />{t('Equalize panes')}</button>
        {([['columns', 'Side by side', Columns2], ['rows', 'Top and bottom', Rows2], ['grid', 'Grid layout', Grid2X2], ['left-stack', 'Left and stacked right', PanelsTopLeft]] as const).map(([name, label, Icon]) =>
          <button key={name} type="button" aria-label={t(label)} title={t(label)} onClick={event => { choosePreset(name); const menu = event.currentTarget.closest('details'); if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); } }}><Icon size={15} />{t(label)}</button>)}
      </div>
      </div>;
  const controls = <div className="session-workspace-controls" role="toolbar" aria-label={t('Chat layout')}>{settings}
    <button type="button" className="workspace-labeled-tool" disabled={!scope} aria-label={t('Quick question')} title={`${t('Quick question')} · Ctrl/⌘+Shift+K`} onClick={() => setQuickChatOpen(true)}><Bot size={15} /><span>{t('Ask')}</span></button>
    <WorkspaceBoardPicker scope={scope ?? ''} onOpen={openBoardResource} labeled disabled={!scope} />
    <details className="session-workspace-presets" onToggle={event => setPresetMenuOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; setPresetMenuOpen(false); event.currentTarget.querySelector('summary')?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { event.currentTarget.open = false; setPresetMenuOpen(false); } }}>
      <summary ref={presetSummaryRef} aria-label={t('Layout presets')} title={t('Layout presets')}><PanelsTopLeft size={15} /></summary>{presetMenuOpen ? renderResourceMenu(presetMenuRef) : null}
    </details></div>;
  return <WorkspaceFileLinksProvider panes={current.panes} toggle={(a, b) => setLayout(value => ({ ...value, panes: toggleFileLink(value.panes, a, b) }))}><div className="session-workspace" data-session-workspace data-ui-mode={uiMode}>
    {uiMode !== 'os-desktop' && <div className="saved-layouts-strip-host" ref={setQuickSwitchHost} />}
    {scope && quickChatOpen && <Suspense fallback={null}><QuickChatPanel close={closeQuickChat} /></Suspense>}
    {layoutNotice && <div className="workspace-layout-notice" role="status">{layoutNotice.message}<button type="button" aria-label={t('Close')} onClick={() => setLayoutNotice('')}><X size={12} /></button></div>}
    {uiMode !== 'os-desktop' && contextPoint && <WorkspaceContextMenu point={contextPoint} close={closeContextMenu}>
      <button type="button" disabled={!scope} onClick={() => { setQuickChatOpen(true); closeContextMenu(); }}><Bot size={15} />{t('Quick question')}</button>
      {contextPoint.pane && (() => {
        const contextPaneId = contextPoint.pane.dataset.remotePane;
        const contextPane = contextPaneId ? current.panes.find(p => p.id === contextPaneId) : undefined;
        const contextFloating = contextPane ? current.floating.some(f => f.id === contextPane.id) : false;
        return <div className="session-action-menu">
        {contextPoint.pane.querySelector('.desktop-session-frame') && <button type="button" onClick={() => {
          const pane = contextPoint.pane; queueMicrotask(() => pane?.dispatchEvent(new Event('agentopsdeck:session-model')));
        }}><Bot size={15} />{t('Session model')}</button>}
        {contextPane && (contextFloating || contextPane.dockFrame) && <button type="button" disabled={locked || (!contextFloating && !contextPane.dockFrame) || (contextFloating && !canPlaceWorkspacePane(current, contextPane.id, false))} onClick={() => {
          setLayout(value => contextFloating
            ? insertWorkspacePane(value, contextPane.id, size.width, size.height, preset)
            : { ...value, panes: value.panes.map(item => { if (item.id !== contextPane.id || !item.dockFrame) return item; const { dockFrame: _, ...rest } = item; return rest; }), dock: equalizeDock(value.dock) });
          closeContextMenu();
        }}><PanelBottom size={15} />{t('Dock pane')}</button>}
        {contextPane && !contextFloating && <button type="button" disabled={locked || !canPlaceWorkspacePane(current, contextPane.id, true)} onClick={() => {
          setLayout(value => floatWorkspacePane(value, contextPane.id));
          closeContextMenu();
        }}><PictureInPicture2 size={15} />{t('Float pane')}</button>}
        <button type="button" onClick={() => contextPoint.pane?.dispatchEvent(new Event('agentopsdeck:binding-lines', { bubbles: true }))}><Link2 size={15} />{t('Toggle card connections')}</button>
      </div>;
      })()}{renderResourceMenu()}</WorkspaceContextMenu>}
    {uiMode !== 'os-desktop' ? (toolsHost ? createPortal(controls, toolsHost) : controls) : null}
    <div ref={surface} className="session-workspace-surface" data-layout={preset} data-layout-locked={locked} data-split={uiMode === 'os-desktop' ? false : split} data-ui-mode={uiMode} data-has-maximized={!!maximized}
      onDragOverCapture={event => cardPlacement(event)} onDropCapture={event => cardPlacement(event, true)}
      onDragLeave={event => { if (currentSessionCardDrag() && !event.currentTarget.contains(event.relatedTarget as Node | null)) cancelPlacement(); }}>
      {uiMode === 'os-desktop' ? (
        <Suspense fallback={
          <div className="os-power-overlay is-booting" data-testid="os-power-overlay" data-power-phase="booting" role="status">
            <div className="os-power-bg-grid" aria-hidden="true" />
            <div className="os-power-scanline" aria-hidden="true" />
            <div className="os-power-ambient-orb orb-cyan" aria-hidden="true" />
            <div className="os-power-ambient-orb orb-indigo" aria-hidden="true" />
            <div className="os-power-card">
              <span className="os-power-corner corner-tl" aria-hidden="true" />
              <span className="os-power-corner corner-tr" aria-hidden="true" />
              <span className="os-power-corner corner-bl" aria-hidden="true" />
              <span className="os-power-corner corner-br" aria-hidden="true" />
              <div className="os-power-hud-header" aria-hidden="true">
                <span className="os-power-hud-tag">{t('AGENTOPSDECK // QUANTUM KERNEL v2.4')}</span>
                <span className="os-power-hud-led"><i />{t('SYSTEM ONLINE')}</span>
              </div>
              <div className="os-power-reactor" aria-hidden="true">
                <span className="os-power-orbit orbit-outer" />
                <span className="os-power-orbit orbit-middle" />
                <span className="os-power-orbit orbit-inner" />
                <span className="os-power-radar-sweep" />
                <div className="os-power-emblem"><span className="os-power-ring" /></div>
              </div>
              <strong className="os-power-title">{t('Starting AgentOpsDeck OS Desktop…')}</strong>
              <span className="os-power-subtitle">{t('Initializing multi-agent kernel & workspace surface…')}</span>
              <div className="os-power-modules-grid" aria-hidden="true">
                <div className="os-power-module-pill is-done"><span className="module-dot" /><span>{t('IDENTITY VAULT')}</span><b>{t('OK')}</b></div>
                <div className="os-power-module-pill is-active"><span className="module-dot" /><span>{t('AGENT MESH')}</span><b>{t('INIT')}</b></div>
                <div className="os-power-module-pill"><span className="module-dot" /><span>{t('FENCES COMPOSITOR')}</span><b>{t('MOUNT')}</b></div>
              </div>
              <div className="os-power-progress-wrap" aria-hidden="true">
                <div className="os-power-progress-meta"><span>{`${t('BOOT_SEQUENCE // STAGE')} 02`}</span><span>50%</span></div>
                <div className="os-power-progress-track"><div className="os-power-progress-bar" style={{ width: '50%' }} /></div>
              </div>
            </div>
          </div>
        }>
          <WorkspaceOsDesktop
            storageScope={scope ?? 'default'}
            sessions={overviewSessions}
            notebooks={notebooks}
            taskboards={taskboards}
            panes={current.panes}
            sourceStates={sourceStates}
            completedSessionKeys={osDesktopCompletedSet}
            openWindows={osDesktopOpenWindows}
            activeWindowId={active?.id}
            minimizedKeys={collapsedKeys}
            maximizedWindowId={maximized}
            surfaceWidth={size.width || 1280}
            surfaceHeight={size.height || 800}
            onOpenIcon={handleOpenDesktopIcon}
            onActivateWindow={id => {
              const p = visible.find(item => item.id === id);
              if (p) activate(p);
            }}
            onToggleMinimize={sKey => {
              setCollapsedKeys(prev => {
                const next = new Set(prev);
                if (next.has(sKey)) next.delete(sKey);
                else next.add(sKey);
                return next;
              });
            }}
            onToggleMaximize={id => {
              setMaximizedId(prev => prev === id ? undefined : id);
            }}
            onCloseWindow={id => close(id)}
            onCreateSession={onCreateSession}
            onSwitchToClassic={() => toggleUiMode('classic')}
            renderWindowContent={id => {
              const pane = visible.find(item => item.id === id);
              if (!pane) return null;
              const rawPane = rawPaneById.get(pane.id) ?? current.panes.find(value => value.id === pane.id)!;
              return (
                <PaneToolbarScope key={pane.id}>
                  {(slot, statusSlot) => (
                    <WorkspaceFileCardScope pane={rawPane} scope={scope ?? ''}>
                      <div className="session-pane-caption os-window-subtoolbar" data-unified-window-bar="true">
                        <span className="session-pane-drag-title os-window-subtoolbar-title">
                          <FileLinkButton id={pane.id} />
                          {!pane.session && <CardConnectionsButton />}
                        </span>
                        <CaptionOverflow>
                          {statusSlot}
                          {slot}
                          <Suspense fallback={null}>
                            <PaneProjectionButton payload={{ paneId: pane.id, kind: pane.session ? 'session' : (rawPane.kind ?? 'workspace'), title: pane.title, sessionKey: pane.session?.sessionKey }} />
                          </Suspense>
                        </CaptionOverflow>
                      </div>
                      <CoBoundSessionsBar id={pane.id} activeSessionKey={selected?.sessionKey} sessionTitles={sessionTitleMap} onSelectSession={handleSelectCoBoundSession} />
                      <div className="session-pane-content os-desktop-pane-content" data-remote-pane={pane.id}>
                        {renderPaneBody(pane, false)}
                      </div>
                    </WorkspaceFileCardScope>
                  )}
                </PaneToolbarScope>
              );
            }}
            renderSessionContent={sess => {
              const existingPane = visible.find(item => item.sessionKey === sess.sessionKey);
              const paneId = existingPane?.id ?? `wechat-stage:${sess.sessionKey}`;
              const rawPane: (typeof current.panes)[number] = existingPane
                ? (rawPaneById.get(existingPane.id) ?? current.panes.find(value => value.id === existingPane.id) ?? { id: paneId, sessionKey: sess.sessionKey })
                : { id: paneId, sessionKey: sess.sessionKey };
              return (
                <PaneToolbarScope key={paneId}>
                  {(slot, statusSlot) => (
                    <WorkspaceFileCardScope pane={rawPane} scope={scope ?? ""}>
                      <div className="session-pane-caption os-window-subtoolbar" data-unified-window-bar="true">
                        <span className="session-pane-drag-title os-window-subtoolbar-title">
                          <FileLinkButton id={paneId} />
                        </span>
                        <CaptionOverflow>
                          {statusSlot}
                          {slot}
                          <Suspense fallback={null}>
                            <PaneProjectionButton payload={{ paneId, kind: "session", title: displayTitle(sess), sessionKey: sess.sessionKey }} />
                          </Suspense>
                        </CaptionOverflow>
                      </div>
                      <CoBoundSessionsBar id={paneId} activeSessionKey={sess.sessionKey} sessionTitles={sessionTitleMap} onSelectSession={handleSelectCoBoundSession} />
                      <div className="session-pane-content os-desktop-pane-content" data-remote-pane={paneId}>
                        <WorkspaceSessionContent session={sess} renderPane={renderPane} />
                      </div>
                    </WorkspaceFileCardScope>
                  )}
                </PaneToolbarScope>
              );
            }}
          />
        </Suspense>
      ) : (<>
      {!visible.length && emptyState}
      {scope && <Suspense fallback={null}><WorkspaceBindingLines key={scope} surface={surface} panes={current.panes.filter(pane => visible.some(item => item.id === pane.id))} scope={scope} /></Suspense>}
      {scope && <Suspense fallback={null}><AntigravityQuotaFlowOverlay surface={surface} /></Suspense>}
      {maximized ? <button type="button" className="pane-maximize-scrim" aria-label={t('Restore pane')} onClick={() => setMaximizedId(undefined)} /> : null}
      {[...geometry.empty].map(([id, rect]) => <div key={id} className="session-workspace-vacancy" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}><span>{t('Drop a session here')}</span></div>)}
      {visible.map(pane => {
        const floating = current.floating.find(item => item.id === pane.id);
        const enlarged = maximized === pane.id;
        const collapsed = !enlarged && !!floating && collapsedKeys.has(pane.sessionKey);
        const definition = current.panes.find(item => item.id === pane.id), minimum = paneMinimum(definition, !!floating);
        const fitted = floating ? fitFloating(floating, size.width, size.height, definition) : undefined;
        const cell = geometry.panes.get(pane.id);
        const rect = enlarged ? focusedPaneRect(size.width, size.height) : fitted ? { x: fitted.x * size.width, y: fitted.y * size.height, width: fitted.width * size.width, height: fitted.height * size.height } : cell;
        const move = (dx: number, dy: number) => { if (fitted) updateFloating(pane.id, { ...fitted, x: fitted.x + dx / Math.max(1, size.width), y: fitted.y + dy / Math.max(1, size.height) }); else if (rect) setLayout(value => setDockFrame(value, pane.id, { ...rect, x: rect.x + dx, y: rect.y + dy }, size.width, size.height)); };
        const resizeFloating = (edge: PaneResizeEdge, dx: number, dy: number) => { if (fitted && rect) {
          const raw = resizePaneEdge(rect, edge, dx, dy, size.width, size.height,
            minimum);
          const next = gesture.current ? alignPane(pane.id, raw, edge, true) : raw;
          updateFloating(pane.id, { ...fitted, x: next.x / Math.max(1, size.width), y: next.y / Math.max(1, size.height),
            width: next.width / Math.max(1, size.width), height: next.height / Math.max(1, size.height) });
        } };
        const resizeDocked = (edge: PaneResizeEdge, dx: number, dy: number) => { if (rect) {
          const raw = resizePaneEdge(rect, edge, dx, dy, size.width, size.height, minimum);
          const next = gesture.current ? alignPane(pane.id, raw, edge) : raw;
          setLayout(value => setDockFrame(value, pane.id, next, size.width, size.height));
        } };
        const resizeEdge = floating ? resizeFloating : resizeDocked;
        const resizeCorner = (dx: number, dy: number) => resizeEdge('bottom-right', dx, dy);
        const running = !!pane.session && hasQueueBlockingRun(pane.session) && pane.session.runtime?.operation !== 'compact';
        return <PaneToolbarScope key={pane.id}>{(slot, statusSlot, titleSlot) => <div className="session-workspace-pane" data-workspace-pane data-pane-kind={pane.subagents ? 'subagents' : pane.session ? 'session' : (current.panes.find(p => p.id === pane.id)?.kind ?? 'workspace')} data-session-key={pane.session?.sessionKey} data-running={running} data-resource-card={!pane.session || undefined} data-completion-effect={completionEffect} data-maximized={enlarged} data-notebook={!!pane.notebook} data-completed={completed.has(pane.sessionKey)} data-completion-sequence={completed.get(pane.sessionKey)} data-active={active?.id === pane.id} data-dragging={placement?.id === pane.id} data-floating={!!floating} data-collapsed={collapsed} data-dimmed={!enlarged && !!floating && !pane.subagents && dockIds.includes(active?.id ?? '')} data-dense={!!rect && rect.height < 600}
          data-remote-pane={pane.id} style={{ '--pane-composer-max-height': `${Math.min(400, (rect?.height ?? 600) * .4)}px`, left: rect?.x, top: rect?.y, width: rect?.width, height: collapsed ? 34 : rect?.height, zIndex: enlarged ? 40 : maximized && (pane.notebook || pane.subagents) && floating ? 45 : pane.subagents && floating ? 30 : completed.has(pane.sessionKey) && completionEffect !== 'off' ? 25 : floating ? 10 + (active?.id === pane.id ? current.floating.length : current.floating.indexOf(floating)) : active?.id === pane.id ? 2 : 1 } as CSSProperties}
          onPointerMoveCapture={event => { if (pane.session) hoverFocus.move(event, !!drag.current || !!gesture.current, () => activate(pane)); }}
          onWheelCapture={event => hoverFocus.wheel(event, () => activate(pane))} onKeyDownCapture={hoverFocus.key}
          onTouchStartCapture={hoverFocus.touchStart} onTouchMoveCapture={event => hoverFocus.touchMove(event, () => activate(pane))}
          onPointerLeave={hoverFocus.leave}
          onPointerDownCapture={() => { hoverFocus.cancel(); activate(pane); }} onFocusCapture={event => { if (event.target.matches('.desktop-composer-textarea') && event.currentTarget.matches(':hover')) event.currentTarget.dataset.hoverComposer = 'true'; activate(pane); }}>
          {running && <RunningPaneBorder />}
          <div className="session-pane-caption" onPointerDown={event => { if (rect && event.target === event.currentTarget) beginPlacement(event, pane.id, pane.sessionKey, rect); }} {...placementHandlers}>
            {rect ? <button type="button" className="session-pane-drag" aria-disabled={locked} aria-label={t(floating ? 'Move floating pane' : 'Move pane')} title={t('Drag to dock, split or swap · Shift to move freely · Alt + arrow keys to dock')} onPointerDown={event => beginPlacement(event, pane.id, pane.sessionKey, rect)} onKeyDown={event => keyboardPlacement(event, pane.id, move)} {...placementHandlers}><GripHorizontal size={14} /></button> : null}
            {pane.session ? <span className="session-pane-drag-title" onPointerDown={rect ? event => {
              if (!(event.target instanceof Element) || !event.target.closest('h2')) return;
              beginPlacement(event, pane.id, pane.sessionKey, rect);
            } : undefined} {...placementHandlers}>{titleSlot}</span> : <span className="session-pane-drag-title" onPointerDown={rect ? event => {
              if (event.target instanceof Element && event.target.closest('input, button')) return;
              beginPlacement(event, pane.id, pane.sessionKey, rect);
            } : undefined} {...placementHandlers}>{pane.drawing ? titleSlot : <>{pane.subagents ? <CardKindIcon kind="subagents" /> : null}<span className="resource-caption-fallback">{pane.title}</span>{titleSlot}</>}</span>}
            <CaptionOverflow>
            {statusSlot}
            {slot}
            <Suspense fallback={null}><PaneProjectionButton payload={{ paneId: pane.id, kind: pane.session ? 'session' : (current.panes.find(p => p.id === pane.id)?.kind ?? 'workspace'), title: pane.title, sessionKey: pane.session?.sessionKey }} /></Suspense>
            {!enlarged && <button type="button" aria-label={t('Maximize pane')} title={t('Maximize pane')} onClick={() => { activate(pane); setMaximizedId(pane.id); }}><Maximize2 size={13} /></button>}
            {floating && !enlarged ? <button type="button" aria-expanded={!collapsed} aria-label={t(collapsed ? 'Expand floating pane' : 'Collapse floating pane')} title={t(collapsed ? 'Expand floating pane' : 'Collapse floating pane')} onClick={() => setCollapsedKeys(previous => { const next = new Set(previous); if (collapsed) next.delete(pane.sessionKey); else next.add(pane.sessionKey); return next; })}>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button> : null}
            {!floating && definition?.dockFrame ? <button type="button" disabled={enlarged || locked} aria-label={t('Dock pane')} title={t('Dock pane')} onClick={() => setLayout(value => ({ ...value, panes: value.panes.map(item => { if (item.id !== pane.id || !item.dockFrame) return item; const { dockFrame: _, ...rest } = item; return rest; }), dock: equalizeDock(value.dock) }))}><PanelBottom size={13} /></button> : null}
            {floating ? <button type="button" disabled={enlarged || !canPlaceWorkspacePane(current, pane.id, false)} aria-label={t('Dock pane')} title={t('Dock pane')} onClick={() => setLayout(value => insertWorkspacePane(value, pane.id, size.width, size.height, preset))}><PanelBottom size={13} /></button> : <button type="button" disabled={enlarged || !canPlaceWorkspacePane(current, pane.id, true)} aria-label={t('Float pane')} title={t('Float pane')} onClick={() => setLayout(value => floatWorkspacePane(value, pane.id))}><PictureInPicture2 size={13} /></button>}
            {enlarged ? <button type="button" aria-label={t('Restore pane')} title={t('Restore pane')} onClick={() => setMaximizedId(undefined)}><Minimize2 size={13} /></button> : visible.length > 1 || !pane.session ? <button type="button" aria-label={t('Close pane')} title={t('Close pane')} onClick={() => close(pane.id)}><X size={13} /></button> : null}
            </CaptionOverflow>
          </div>
          <WorkspaceFileCardScope pane={current.panes.find(value => value.id === pane.id)!} scope={scope ?? ''}>
          <FileLinkButton id={pane.id} />
          <CoBoundSessionsBar id={pane.id} activeSessionKey={selected?.sessionKey} sessionTitles={sessionTitleMap} onSelectSession={handleSelectCoBoundSession} />
          {!pane.session && <CardConnectionsButton />}
          <div className="session-pane-content" hidden={collapsed}>{renderPaneBody(pane, collapsed)}</div>
          </WorkspaceFileCardScope>
          {!locked && !floating && !enlarged && rect ? (['left', 'right', 'top', 'bottom'] as const).map(edge => <div key={edge} className="session-pane-resize-edge" data-edge={edge} role="separator" tabIndex={0} aria-orientation={edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal'} aria-label={t(edge === 'left' || edge === 'right' ? 'Resize pane width' : 'Resize pane height')} aria-valuenow={Math.round(edge === 'left' || edge === 'right' ? rect.width : rect.height)}
            onPointerDown={event => start(event, (dx, dy) => resizeDocked(edge, dx, dy))} onKeyDown={event => keyboardDelta(event, (dx, dy) => resizeDocked(edge, dx, dy))} {...pointerHandlers} />) : null}
          {!locked && floating && !collapsed && !enlarged && rect ? <>
            {(['left', 'right', 'top', 'bottom'] as const).map(edge => <div key={edge} className="session-pane-resize-edge" data-edge={edge} role="separator" tabIndex={0} aria-orientation={edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal'} aria-label={t(edge === 'left' || edge === 'right' ? 'Resize pane width' : 'Resize pane height')} aria-valuenow={Math.round(edge === 'left' || edge === 'right' ? rect.width : rect.height)}
              onPointerDown={event => start(event, (dx, dy) => resizeFloating(edge, dx, dy))} onKeyDown={event => keyboardDelta(event, (dx, dy) => resizeFloating(edge, dx, dy))} {...pointerHandlers} />)}
            <button type="button" className="session-pane-resize-corner" data-edge="bottom-left" aria-label={t('Resize pane')} onPointerDown={event => start(event, (dx, dy) => resizeFloating('bottom-left', dx, dy))} onKeyDown={event => keyboardDelta(event, (dx, dy) => resizeFloating('bottom-left', dx, dy))} {...pointerHandlers} />
          </> : null}
          {!locked && !collapsed && !enlarged && rect ? (['top-left', 'top-right'] as const).map(edge => <button key={edge} type="button" className="session-pane-resize-corner" data-edge={edge}
            aria-label={t(edge === 'top-left' ? 'Resize pane from top left' : 'Resize pane from top right')}
            onPointerDown={event => start(event, (dx, dy) => resizeEdge(edge, dx, dy))}
            onKeyDown={event => keyboardDelta(event, (dx, dy) => resizeEdge(edge, dx, dy))} {...pointerHandlers} />) : null}
          {!locked && !collapsed && !enlarged && rect ? <button type="button" className="session-pane-resize" aria-label={t(floating ? 'Resize floating pane' : 'Resize pane')} title={t(floating ? 'Resize floating pane' : 'Resize pane')} onPointerDown={event => start(event, resizeCorner)} onKeyDown={event => keyboardDelta(event, resizeCorner)} {...pointerHandlers}><span aria-hidden="true">◢</span></button> : null}
        </div>}</PaneToolbarScope>;
      })}
      {!locked && geometry.dividers.map(divider => <div key={divider.path} className="session-workspace-divider" role="separator" tabIndex={0} aria-label={t('Resize panes')}
        data-axis={divider.axis} aria-orientation={divider.axis === 'horizontal' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(divider.ratio * 100)} aria-valuemin={Math.round(divider.minRatio * 100)} aria-valuemax={Math.round(divider.maxRatio * 100)}
        style={{ left: divider.x, top: divider.y, width: divider.width, height: divider.height }}
        onKeyDown={event => keyboardDelta(event, (dx, dy) => setLayout(value => ({ ...value, dock: resizeDock(value.dock, divider.path, Math.max(divider.minRatio, Math.min(divider.maxRatio, divider.ratio + (divider.axis === 'horizontal' ? dx : dy) / 200))) })))}
        onPointerDown={event => start(event, (dx, dy) => setLayout(value => ({ ...value, dock: resizeDock(value.dock, divider.path, Math.max(divider.minRatio, Math.min(divider.maxRatio, divider.ratio + (divider.axis === 'horizontal' ? dx / Math.max(1, divider.parent.width - 10) : dy / Math.max(1, divider.parent.height - 10))))) })))} {...pointerHandlers} />)}
      {alignmentGuides.map(guide => <div key={guide.axis} className="workspace-alignment-guide" data-axis={guide.axis} aria-hidden="true" style={guide.axis === 'x'
        ? { left: guide.position, top: guide.start, height: guide.end - guide.start }
        : { top: guide.position, left: guide.start, width: guide.end - guide.start }} />)}
      {placement ? <div className="session-workspace-drop-preview" role="status" aria-live="polite" aria-atomic="true" data-drop-kind={placement.blocked ? 'blocked' : placement.free ? 'free' : placement.drop?.side ?? 'float'} style={{ left: placement.rect.x, top: placement.rect.y, width: placement.rect.width, height: placement.rect.height }}>
        <span>{t(placement.blocked ? 'Cannot place here' : placement.free ? 'Release to place' : placement.drop?.side === 'center' ? 'Release to swap' : placement.drop ? 'Release to dock' : 'Release to float')}</span>
        <small>{t('Esc to cancel')}</small>
      </div> : null}
      </>)}
    </div>
  </div></WorkspaceFileLinksProvider>;
}
