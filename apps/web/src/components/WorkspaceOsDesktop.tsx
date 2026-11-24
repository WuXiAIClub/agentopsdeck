import { AGENTOPSDECK_BUILD, AGENTOPSDECK_VERSION, type SessionSummary } from '@agentopsdeck/shared';
import { AppBuildLabel } from './AppBuildLabel';
import {
  Activity,
  ArrowUpDown,
  Bell,
  BookOpen,
  Bot,
  CheckCheck,
  ClipboardList,
  Gauge,
  Check,
  Columns2,
  Container,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  FolderOpen,
  MessageSquare,
  Pin,
  PinOff,
  Save,
  Trash2,
  GitBranch,
  GitFork,
  Globe,
  Grid2X2,
  Info,
  Kanban,
  Layers,
  LayoutGrid,
  Link2,
  Download,
  ArrowLeft,
  ArrowRight,
  List,
  Maximize2,
  Mic,
  Minimize2,
  Minus,
  Monitor,
  MonitorUp,
  Palette,
  PanelLeft,
  PanelRight,
  PenTool,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Terminal,
  Cpu,
  HardDrive,
  Image as ImageIcon,
  LogOut,
  Power,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Users,
  KeyRound,
  Copy,
  ExternalLink,
  RefreshCw,
  Sun,
  Moon,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useVisibleSessions } from '../lib/visible-sessions';
import {
  buildDesktopIcons,
  computeCascadeWindowGeometry,
  computeCompanionWindowGeometry,
  computeDefaultFenceGeometries,
  groupDesktopIconsIntoFences,
  computeMarqueeSelection,
  readDesktopFenceRects,
  writeDesktopFenceRects,
  readDesktopFiles,
  writeDesktopFiles,
  readDesktopRecycleBin,
  writeDesktopRecycleBin,
  readDesktopBindings,
  writeDesktopBindings,
  resolveDesktopLineageLinks,
  computeSmartTileGeometries,
  computeSnapWindowGeometry,
  detectWindowSnapZone,
  evaluateWindowContentMount,
  promoteWindowZOrder,
  readDesktopIconPositions,
  readDesktopMinimizedIds,
  readDesktopPreferences,
  readDesktopWallpaper,
  COLOR_MODE_CHANGE_EVENT,
  readWorkspaceColorMode,
  toggleWorkspaceColorMode,
  writeWorkspaceColorMode,
  readDesktopWallpaperConfig,
  readDesktopQqDockSize,
  readDesktopWindowRects,
  resizeDesktopWindowGeometry,
  computeTaskbarMetrics,
  computeDesktopPointTextStyle,
  resolveNonOverlappingIconLayout,
  organizeDesktopIconsGrid,
  detectNewlyCompletedSessions,
  type DesktopWallpaperImageGrid,
  readDesktopNotifications,
  writeDesktopNotifications,
  readDesktopPinnedSessions,
  writeDesktopPinnedSessions,
  readDesktopDeletedUsers,
  writeDesktopDeletedUsers,
  formatHudKernelTelemetry,
  type DesktopDeletedUsersState,
  writeDesktopIconPositions,
  writeDesktopMinimizedIds,
  writeDesktopPreferences,
  writeDesktopWallpaper,
  writeDesktopWallpaperConfig,
  writeDesktopQqDockSize,
  writeDesktopWindowRects,
  type DesktopFenceGeometry,
  type DesktopFenceId,
  type DesktopFileAttachment,
  type DesktopFileEntry,
  type DesktopRecycleItem,
  type DesktopBindingLink,
  type DesktopResolvedLineageEdge,
  type DesktopIconItem,
  type DesktopIconKind,
  type DesktopIconVariant,
  type DesktopIconPosition,
  type DesktopPreferences,
  type DesktopQqDockSize,
  type DesktopResizeEdge,
  type DesktopSnapZone,
  type DesktopSortBy,
  type DesktopWallpaperConfig,
  type DesktopWallpaperFit,
  type DesktopWallpaperTheme,
  type DesktopWindowGeometry,
  type DesktopNotificationItem,
  type DesktopNotificationKind,
  type WorkspaceColorMode,
  findMatchingExplorerOpenWindow,
} from '../lib/desktop-os-mode';
import { handleContextMenuKeyDown, useContextMenuPosition } from '../lib/context-menu-position';
import {
  buildProjectionUrl,
  detectSecondaryScreenRect,
  isSecondaryDisplayWindow,
  isWindowPlacementApiSupported,
  moveWindowToScreen,
  MULTI_SCREEN_CHANNEL_NAME,
  openCompanionWindowOnScreen,
  parseProjectionSearch,
  readSecondaryWindowIds,
  requestFullscreenOnScreen,
  subscribeScreenDetailsChanges,
  writeSecondaryWindowIds,
  type MultiScreenSyncMessage,
  type ScreenPlacementRect,
} from '../lib/multi-screen-projection';
import { validSystemMetrics, workspaceFileCardResource, type SystemMetrics } from '@agentopsdeck/shared';
import { isSessionPane, type Pane } from '../lib/workspace-layout';
import { fileLinkEdges } from '../lib/workspace-file-links';
import {
  loadModeratorOrchestrationConfig,
  MODERATOR_CONFIG_EVENT,
  type ModeratorOrchestrationConfig,
} from '../lib/moderator-orchestrator';
import { workspaceResourceEvents } from '../lib/workspace-resource-events';
import { desktopHistoryReads } from '../lib/history-read-scheduler';
import { requestGovernor } from '../lib/request-governor';
import {
  createDesktopBindingSync,
  extractBindingSessionIds,
  pruneBindingMap,
  updateBindingMap,
} from '../lib/desktop-binding-sync';
import {
  api,
  apiUrl,
  recoveryEpoch,
  recoveryScope,
  type AccessConnection,
  type AccessDirectory,
  type ConnectorMembership,
  type ConnectorRole,
  type ConnectorUsersByConnection,
  type HubRoleState,
  type HubUser,
  type FileRequestScope,
} from '../api';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { AccessViewEpoch, copyCurrentAccessKey, revokeReviewedAccess, writeCurrentAccess } from '../lib/reviewed-access';
import { confirmAction } from './ui/confirm';
import { summarizeDashboardTokens } from '../lib/workspace-dashboard';
import { bindingCurve, bindingGroupColor, type BindingRect } from '../lib/workspace-binding-lines';
import {
  buildDockerSandboxBlueprint,
  DOCKER_SANDBOX_PRESETS,
  type DockerSandboxArtifactTab,
  type DockerSandboxNetworkMode,
  type DockerSandboxProfileId,
  type DockerSandboxRuntimeId,
  type HubDockerSandboxInstance,
} from '../lib/connector-architecture';
import { NotebookMarkdown } from './NotebookMarkdown';
import type { SessionSourceState } from '../lib/session-snapshot';

export type DesktopOpenWindowItem = {
  id: string;
  sessionKey: string;
  title: string;
  kind: DesktopIconKind;
  resourceId?: string | undefined;
  running?: boolean | undefined;
  unread?: boolean | undefined;
  subtitle?: string | undefined;
};

const RESIZE_EDGES: readonly DesktopResizeEdge[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
];

const WALLPAPER_THEMES: readonly DesktopWallpaperTheme[] = [
  'aurora',
  'midnight',
  'cybergrid',
  'graphite',
  'sunset',
  'oceanic',
  'sakura',
];

const CUSTOM_GRADIENT_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  {
    label: 'Nebula Violet',
    value: 'radial-gradient(circle at 20% 20%, rgba(124, 58, 237, 0.45), transparent 55%), radial-gradient(circle at 80% 75%, rgba(14, 165, 233, 0.38), transparent 60%), linear-gradient(135deg, #090d16 0%, #111827 52%, #1e1b4b 100%)',
  },
  {
    label: 'Emerald Matrix',
    value: 'radial-gradient(circle at 75% 20%, rgba(16, 185, 129, 0.38), transparent 55%), radial-gradient(circle at 20% 80%, rgba(6, 182, 212, 0.32), transparent 55%), linear-gradient(160deg, #041014 0%, #071c21 55%, #06281e 100%)',
  },
  {
    label: ' Crimson Horizon',
    value: 'radial-gradient(circle at 30% 25%, rgba(244, 63, 94, 0.42), transparent 55%), radial-gradient(circle at 80% 70%, rgba(249, 115, 22, 0.35), transparent 55%), linear-gradient(145deg, #13070c 0%, #1f1018 55%, #2b1216 100%)',
  },
  {
    label: 'Deep Titanium',
    value: 'radial-gradient(circle at 50% 0%, rgba(148, 163, 184, 0.24), transparent 60%), linear-gradient(180deg, #0b0f17 0%, #111827 50%, #090d14 100%)',
  },
];

export function desktopEmbedUrl(value: string, origin: string, apiOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || [origin, apiOrigin].includes(url.origin)) return;
    return url.href;
  } catch { return; }
}

export async function writeDesktopBrowserCommand({ target, body, revision, current, onWriting }: {
  target: FileRequestScope; body: string; revision?: string | undefined; current: () => boolean; onWriting: () => void;
}): Promise<string | undefined> {
  if (!current()) return;
  const previous = revision ?? (await api.filePreview(target, 'browser-stream/cmd.json')).revision;
  if (!current()) return;
  if (!previous) throw new Error('Browser command revision unavailable. No command was sent.');
  onWriting();
  const saved = await api.saveFileText(target, 'browser-stream/cmd.json', body, previous);
  if (current()) return saved.revision;
}

export default function WorkspaceOsDesktop({
  sessions,
  notebooks,
  taskboards,
  panes,
  sourceStates,
  completedSessionKeys,
  openWindows,
  activeWindowId,
  minimizedKeys,
  maximizedWindowId,
  surfaceWidth,
  surfaceHeight,
  storageScope = 'default',
  onOpenIcon,
  onActivateWindow,
  onToggleMinimize,
  onToggleMaximize,
  onCloseWindow,
  onCreateSession,
  onSwitchToClassic,
  renderWindowContent,
  renderSessionContent,
}: {
  sessions: readonly SessionSummary[];
  notebooks: ReadonlyArray<{ id: string; title: string; hidden?: boolean }>;
  taskboards?: ReadonlyArray<{ resourceId: string; title: string }> | undefined;
  panes?: readonly Pane[] | undefined;
  sourceStates?: ReadonlyArray<SessionSourceState> | ReadonlyMap<string, string> | undefined;
  completedSessionKeys: ReadonlySet<string>;
  openWindows: readonly DesktopOpenWindowItem[];
  activeWindowId: string | undefined;
  minimizedKeys: ReadonlySet<string>;
  maximizedWindowId: string | undefined;
  surfaceWidth: number;
  surfaceHeight: number;
  storageScope?: string | undefined;
  onOpenIcon: (item: DesktopIconItem) => void;
  onActivateWindow: (id: string) => void;
  onToggleMinimize: (sessionKey: string) => void;
  onToggleMaximize: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onCreateSession?: (() => void) | undefined;
  onSwitchToClassic: () => void;
  renderWindowContent: (id: string) => ReactNode;
  renderSessionContent?: ((session: SessionSummary) => ReactNode) | undefined;
}) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIconId, setSelectedIconId] = useState<string | undefined>(undefined);
  const [selectedIconIds, setSelectedIconIds] = useState<Set<string>>(() => new Set());
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [desktopFiles, setDesktopFiles] = useState<DesktopFileEntry[]>(() => readDesktopFiles(storageScope));
  const [recycleItems, setRecycleItems] = useState<DesktopRecycleItem[]>(() => readDesktopRecycleBin(storageScope));
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [desktopBindings, setDesktopBindings] = useState<DesktopBindingLink[]>(() => readDesktopBindings(storageScope));
  const [linkConnectMode, setLinkConnectMode] = useState(false);
  const [pendingLinkSourceId, setPendingLinkSourceId] = useState<string | null>(null);
  const [lineageInspectorOpen, setLineageInspectorOpen] = useState(false);
  const [highlightedLineageNodeId, setHighlightedLineageNodeId] = useState<string | null>(null);
  const [notebookBindingsMap, setNotebookBindingsMap] = useState<Record<string, string[]>>({});
  const [taskboardBindingsMap, setTaskboardBindingsMap] = useState<Record<string, string[]>>({});
  const [moderatorConfig, setModeratorConfig] = useState<ModeratorOrchestrationConfig>(() =>
    loadModeratorOrchestrationConfig(storageScope),
  );
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserEngineMode, setBrowserEngineMode] = useState<"stream" | "iframe">("stream");
  const [browserViewportMode, setBrowserViewportMode] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [browserTabs, setBrowserTabs] = useState<Array<{ id: string; title: string; url: string }>>([
    { id: "tab-home", title: "Cloud Browser", url: "about:home" },
    { id: "tab-hn", title: "Hacker News", url: "https://news.ycombinator.com" },
  ]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState("tab-home");
  const [browserUrlInput, setBrowserUrlInput] = useState("about:home");
  const [browserReloadTick, setBrowserReloadTick] = useState(0);
  const [browserStreamFrame, setBrowserStreamFrame] = useState<{
    status: string;
    url: string;
    title: string;
    frameDataUrl?: string | undefined;
    width: number;
    height: number;
    canGoBack?: boolean | undefined;
    canGoForward?: boolean | undefined;
    error?: string | null | undefined;
    updatedAt?: number | undefined;
  } | null>(null);
  const [browserRemoteText, setBrowserRemoteText] = useState("");
  const browserCmdRevRef = useRef<string | undefined>(undefined);
  const [browserConnections, setBrowserConnections] = useState<Array<{ id: string; label: string }>>([]);
  const [browserConnectionId, setBrowserConnectionId] = useState('');
  const [browserRoots, setBrowserRoots] = useState<Array<{ agentId: string; label: string; readOnly: boolean }>>([]);
  const [browserAgentId, setBrowserAgentId] = useState('');
  const [browserNotice, setBrowserNotice] = useState<TranslationKey | ''>('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const browserUnknown = useRef<{ id: string; target: FileRequestScope; scope: string | undefined; epoch: number } | undefined>(undefined);
  const browserScope = recoveryScope(), browserEpoch = recoveryEpoch();
  const browserTarget = useMemo<FileRequestScope | undefined>(() => browserConnectionId && browserAgentId
    && browserConnections.some(item => item.id === browserConnectionId)
    && browserRoots.some(item => item.agentId === browserAgentId && !item.readOnly)
    ? { type: 'agent', connectionId: browserConnectionId, agentId: browserAgentId } : undefined,
  [browserConnectionId, browserAgentId, browserConnections, browserRoots]);
  const browserIdentity = JSON.stringify([storageScope, browserScope, browserEpoch, browserOpen, browserEngineMode, browserTarget]);
  const browserLifetime = useRef({ identity: browserIdentity, active: false, busy: false });
  browserLifetime.current.identity = browserIdentity;
  const initialTaskbarReserve =
    computeTaskbarMetrics(readDesktopPreferences(storageScope).taskbarHeight ?? 48).taskbarHeight + 12;
  const clampInitialDesktopRect = (
    preferredW: number,
    minW: number,
    preferredH: number,
    minH: number,
    preferredX: number,
    preferredY: number,
  ) => {
    const maxW = Math.max(240, surfaceWidth - 24);
    const maxH = Math.max(200, surfaceHeight - initialTaskbarReserve - 12);
    const width = Math.round(Math.min(maxW, Math.max(Math.min(minW, maxW), preferredW)));
    const height = Math.round(Math.min(maxH, Math.max(Math.min(minH, maxH), preferredH)));
    const x = Math.round(Math.max(12, Math.min(preferredX, surfaceWidth - width - 12)));
    const compactTopY = surfaceHeight <= 980 ? Math.min(preferredY, 28) : preferredY;
    const y = Math.round(Math.max(12, Math.min(compactTopY, surfaceHeight - initialTaskbarReserve - height)));
    return { x, y, width, height };
  };
  const [browserRect, setBrowserRect] = useState<{ x: number; y: number; width: number; height: number; maximized: boolean }>(() => {
    const clamped = clampInitialDesktopRect(
      Math.min(860, surfaceWidth - 96),
      520,
      Math.min(580, surfaceHeight - 100),
      380,
      Math.max(48, Math.round((surfaceWidth - 860) / 2)),
      36,
    );
    return { ...clamped, maximized: false };
  });
  const browserDragRef = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const browserResizeRef = useRef<{ pointerId: number; startX: number; startY: number; origW: number; origH: number } | null>(null);
  const taskbarResizeRef = useRef<{ pointerId: number; startY: number; origH: number } | null>(null);
  const [editingDesktopFile, setEditingDesktopFile] = useState<DesktopFileEntry | null>(null);
  const [fileViewMode, setFileViewMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [fileWindowRect, setFileWindowRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
  }>(() => {
    const clamped = clampInitialDesktopRect(
      680,
      420,
      520,
      320,
      Math.max(60, Math.round((surfaceWidth - 680) / 2)),
      surfaceHeight <= 980 ? 24 : 56,
    );
    return { ...clamped, maximized: false };
  });
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const fileWinDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const fileWinResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const [fenceRects, setFenceRects] = useState<Record<DesktopFenceId, DesktopFenceGeometry>>(() => {
    const defaults = computeDefaultFenceGeometries(surfaceWidth, surfaceHeight);
    const saved = readDesktopFenceRects(storageScope);
    const normalizeLegacyTop = (geo: DesktopFenceGeometry | undefined, def: DesktopFenceGeometry): DesktopFenceGeometry => {
      if (!geo) return def;
      if (geo.y >= 40 && geo.y <= 56) {
        return { ...geo, y: def.y };
      }
      return geo;
    };
    return {
      sessions: normalizeLegacyTop(saved.sessions, defaults.sessions),
      knowledge: normalizeLegacyTop(saved.knowledge, defaults.knowledge),
      'tools-files': normalizeLegacyTop(saved['tools-files'], defaults['tools-files']),
    };
  });
  const fenceDragRef = useRef<{
    fenceId: DesktopFenceId;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const [hudOpen, setHudOpen] = useState(true);
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [hudRect, setHudRect] = useState<{ x: number; y: number; width: number; height: number }>(() =>
    clampInitialDesktopRect(
      326,
      280,
      312,
      240,
      Math.max(24, surfaceWidth - 348),
      Math.max(36, surfaceHeight - initialTaskbarReserve - 324),
    ),
  );
  const hudDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [recycleRect, setRecycleRect] = useState<{ x: number; y: number; width: number; height: number }>(() =>
    clampInitialDesktopRect(
      Math.min(520, surfaceWidth - 60),
      360,
      Math.min(400, surfaceHeight - 140),
      260,
      Math.min(240, Math.max(32, Math.round((surfaceWidth - 520) / 2))),
      surfaceHeight <= 980 ? 28 : 72,
    ),
  );
  const [lineageRect, setLineageRect] = useState<{ x: number; y: number; width: number; height: number }>(() =>
    clampInitialDesktopRect(
      Math.min(440, surfaceWidth - 32),
      320,
      Math.min(430, surfaceHeight - 120),
      260,
      Math.max(16, surfaceWidth - 456),
      Math.max(24, surfaceHeight - initialTaskbarReserve - 442),
    ),
  );
  const sysResizeRef = useRef<{
    key: string;
    edge: DesktopResizeEdge;
    pointerId: number;
    startX: number;
    startY: number;
    orig: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const sysDragRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [metricSources, setMetricSources] = useState<
    Array<{ key: string; kind: 'hub' | 'connector'; id: string; label: string }>
  >([]);
  const [selectedMetricSource, setSelectedMetricSource] = useState('');
  const [metricSample, setMetricSample] = useState<SystemMetrics | undefined>(undefined);
  const [qqDocked, setQqDocked] = useState(true);
  const [qqPinned, setQqPinned] = useState(false);
  const [qqHovered, setQqHovered] = useState(false);
  const [qqSearch, setQqSearch] = useState('');
  const [qqPos, setQqPos] = useState<{ x: number; y: number }>(() => ({ x: Math.max(240, surfaceWidth - 310), y: 46 }));
  const [qqSize, setQqSize] = useState<DesktopQqDockSize>(() => readDesktopQqDockSize(storageScope));
  const qqResizeRef = useRef<{
    edge: DesktopResizeEdge;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const [qqOpenGroups, setQqOpenGroups] = useState<{ running: boolean; unread: boolean; all: boolean }>({
    running: true,
    unread: true,
    all: true,
  });
  const [startMenuOpen, setStartMenuOpen] = useState(false);
  const [trayFlyoutOpen, setTrayFlyoutOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [notifications, setNotifications] = useState<DesktopNotificationItem[]>(() =>
    readDesktopNotifications(storageScope),
  );
  const [activeToasts, setActiveToasts] = useState<
    Array<DesktopNotificationItem & { fadingOut?: boolean }>
  >([]);
  const [isRefreshingDesktop, setIsRefreshingDesktop] = useState(false);
  const [desktopRefreshNonce, setDesktopRefreshNonce] = useState(0);
  const [powerPhase, setPowerPhase] = useState<'booting' | 'boot-fading' | 'ready' | 'shutting-down'>('booting');
  const [bootStepIndex, setBootStepIndex] = useState(0);
  const prevRunningKeysRef = useRef<Set<string> | null>(null);
  const prevCompletedKeysRef = useRef<Set<string> | null>(null);
  const recentCompletionToastAtRef = useRef<Map<string, number>>(new Map());
  const shutdownTimerRef = useRef<number | null>(null);
  const bootFadeTimerRef = useRef<number | null>(null);
  const [taskViewOpen, setTaskViewOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerTab, setExplorerTab] = useState<'all' | 'running' | 'notebooks' | 'apps'>('all');
  const [explorerViewMode, setExplorerViewMode] = useState<'table' | 'grid'>('table');
  const [explorerSearch, setExplorerSearch] = useState('');
  const [explorerSelectedId, setExplorerSelectedId] = useState<string | undefined>(undefined);
  const [explorerPos, setExplorerPos] = useState<{ x: number; y: number; width: number; height: number }>(() =>
    clampInitialDesktopRect(
      Math.min(820, surfaceWidth - 160),
      480,
      Math.min(520, surfaceHeight - 130),
      320,
      Math.min(160, Math.max(32, Math.round((surfaceWidth - 820) / 2))),
      surfaceHeight <= 980 ? 24 : 52,
    ),
  );
  const [snapLayoutMenuFor, setSnapLayoutMenuFor] = useState<string | undefined>(undefined);
  const [snapPreviewZone, setSnapPreviewZone] = useState<DesktopSnapZone | undefined>(undefined);
  const [showDesktopAllMinimized, setShowDesktopAllMinimized] = useState(false);

  const [wallpaper, setWallpaper] = useState<DesktopWallpaperTheme>(() =>
    readDesktopWallpaper(storageScope),
  );
  const [wallpaperConfig, setWallpaperConfig] = useState<DesktopWallpaperConfig>(() =>
    readDesktopWallpaperConfig(storageScope),
  );
  const [colorMode, setColorMode] = useState<WorkspaceColorMode>(() => readWorkspaceColorMode());
  useEffect(() => {
    const syncMode = () => setColorMode(readWorkspaceColorMode());
    window.addEventListener(COLOR_MODE_CHANGE_EVENT, syncMode);
    return () => window.removeEventListener(COLOR_MODE_CHANGE_EVENT, syncMode);
  }, []);
  const [wechatOpen, setWechatOpen] = useState(false);
  const [wechatSelectedSessionKey, setWechatSelectedSessionKey] = useState<string>("");
  const [wechatFilter, setWechatFilter] = useState<"all" | "running" | "unread">("all");
  const [wechatSearch, setWechatSearch] = useState("");
  const [wechatPinnedKeys, setWechatPinnedKeys] = useState<string[]>(() =>
    readDesktopPinnedSessions(storageScope),
  );
  const [wechatContextMenu, setWechatContextMenu] = useState<{
    x: number;
    y: number;
    session: SessionSummary;
  } | null>(null);
  useEffect(() => {
    writeDesktopPinnedSessions(storageScope, wechatPinnedKeys);
  }, [storageScope, wechatPinnedKeys]);
  const toggleWechatPinSession = useCallback((sessionKey: string) => {
    setWechatPinnedKeys((prev) =>
      prev.includes(sessionKey)
        ? prev.filter((k) => k !== sessionKey)
        : [sessionKey, ...prev],
    );
  }, []);
  const [wechatRect, setWechatRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
  }>(() => {
    const clamped = clampInitialDesktopRect(
      Math.min(980, surfaceWidth - 88),
      620,
      Math.min(640, surfaceHeight - 92),
      400,
      Math.max(36, Math.round((surfaceWidth - 980) / 2)),
      surfaceHeight <= 980 ? 16 : 28,
    );
    return { ...clamped, maximized: false };
  });
  const wechatDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const wechatResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'wallpaper' | 'desktop' | 'displays' | 'dock' | 'access' | 'sandbox'>('wallpaper');
  const [accessDir, setAccessDir] = useState<AccessDirectory | null>(null);
  const [accessHubUsers, setAccessHubUsers] = useState<HubUser[]>([]);
  const [accessConnectorUsers, setAccessConnectorUsers] = useState<ConnectorUsersByConnection[]>([]);
  const [accessSelectedUserId, setAccessSelectedUserId] = useState<string>('');
  const [accessPrincipalUserId, setAccessPrincipalUserId] = useState<string>('default');
  const [accessDeletedUsers, setAccessDeletedUsers] = useState<DesktopDeletedUsersState>(() =>
    readDesktopDeletedUsers(storageScope),
  );
  const [accessUserHubRole, setAccessUserHubRole] = useState<HubRoleState | null>(null);
  const [accessMemberships, setAccessMemberships] = useState<Record<string, ConnectorMembership>>({});
  const [accessNewUserName, setAccessNewUserName] = useState('');
  const [accessNewConnUserName, setAccessNewConnUserName] = useState<Record<string, string>>({});
  const [accessIssuedKey, setAccessIssuedKey] = useState<{ userId: string; token: string; identity: string } | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessStatus, setAccessStatus] = useState<{ text: string; identity: string } | null>(null);
  const [accessReloadNonce, setAccessReloadNonce] = useState(0);
  const accessEpochRef = useRef(new AccessViewEpoch());
  const accessScope = recoveryScope(), accessAccountEpoch = recoveryEpoch();
  const accessCredentialIdentity = JSON.stringify([accessScope, accessAccountEpoch, storageScope]);
  const accessStatusMsg = accessStatus?.identity === accessCredentialIdentity ? accessStatus.text : '';
  const setAccessStatusMsg = (text: string) => setAccessStatus({ text, identity: accessCredentialIdentity });
  const accessView = accessEpochRef.current.enter(JSON.stringify([
    accessScope, accessAccountEpoch, storageScope, accessSelectedUserId, settingsOpen, settingsTab, accessReloadNonce,
  ]));
  const accessMounted = useRef(false), accessPending = useRef(false);
  const [accessSnapshotGeneration, setAccessSnapshotGeneration] = useState(-1);
  const [accessHubRoleGeneration, setAccessHubRoleGeneration] = useState(-1);
  const accessDirectoryIdentity = JSON.stringify([accessScope, accessAccountEpoch, storageScope, accessReloadNonce]);
  const [accessLoadedDirectoryIdentity, setAccessLoadedDirectoryIdentity] = useState('');
  const accessDirectoryReady = accessLoadedDirectoryIdentity === accessDirectoryIdentity;
  const accessCurrent = () => accessMounted.current && accessView.current()
    && accessScope === recoveryScope() && accessAccountEpoch === recoveryEpoch();
  useEffect(() => {
    accessMounted.current = true;
    return () => { accessMounted.current = false; };
  }, []);
  useEffect(() => {
    setAccessIssuedKey(null);
    setAccessStatusMsg('');
  }, [accessCredentialIdentity]);
  const [sbxPreset, setSbxPreset] = useState<DockerSandboxProfileId>('isolated-test');
  const [sbxEnvId, setSbxEnvId] = useState('sandbox-env');
  const [sbxNodeLabel, setSbxNodeLabel] = useState('codex-sbx-1');
  const [sbxReadOnly, setSbxReadOnly] = useState(false);
  const [sbxCpu, setSbxCpu] = useState<number>(2);
  const [sbxMemMb, setSbxMemMb] = useState<number>(4096);
  const [sbxTmpfsMb, setSbxTmpfsMb] = useState<number>(1024);
  const [sbxTtlMin, setSbxTtlMin] = useState<number>(90);
  const [sbxNetwork, setSbxNetwork] = useState<DockerSandboxNetworkMode>('bridge');
  const [sbxRuntimes, setSbxRuntimes] = useState<DockerSandboxRuntimeId[]>(['codex']);
  const [sbxArtifactTab, setSbxArtifactTab] = useState<DockerSandboxArtifactTab>('run');
  const [sbxCopiedField, setSbxCopiedField] = useState<string | null>(null);
  const [sbxInstances, setSbxInstances] = useState<HubDockerSandboxInstance[]>([]);
  const [sbxBusy, setSbxBusy] = useState(false);
  const [sbxStatusMsg, setSbxStatusMsg] = useState('');

  useEffect(() => {
    setAccessDeletedUsers(readDesktopDeletedUsers(storageScope));
  }, [storageScope]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'access') return;
    let cancelled = false;
    setAccessBusy(true);
    const deletedState = readDesktopDeletedUsers(storageScope);
    const deletedHubSet = new Set(deletedState.hubUserIds);
    const deletedConnSet = new Set(deletedState.connectorUserKeys);
    void Promise.all([
      api.accessDirectory().catch(() => null),
      api.hubUsers().catch(() => ({ users: [] as HubUser[], updatedAt: 0 })),
      api.hubConnectorUsers().catch(() => ({ connections: [] as ConnectorUsersByConnection[], updatedAt: 0 })),
      api.hubMe().catch(() => null),
    ]).then(([dir, usersRes, connUsersRes, meRes]) => {
      if (cancelled || accessScope !== recoveryScope() || accessAccountEpoch !== recoveryEpoch()) return;
      if (meRes?.userId) setAccessPrincipalUserId(meRes.userId);
      if (dir) { setAccessDir(dir); setAccessLoadedDirectoryIdentity(accessDirectoryIdentity); }
      const byId = new Map<string, HubUser>();
      for (const u of usersRes.users) {
        if (!deletedHubSet.has(u.id)) byId.set(u.id, u);
      }
      for (const du of dir?.users ?? []) {
        if (!deletedHubSet.has(du.id) && !byId.has(du.id)) {
          byId.set(du.id, { id: du.id, label: du.label, createdAt: 0, updatedAt: 0 });
        }
      }
      const mergedUsers = [...byId.values()];
      setAccessHubUsers(mergedUsers);
      setAccessConnectorUsers(
        connUsersRes.connections.map((group) => ({
          ...group,
          users: group.users.filter((cu) => !deletedConnSet.has(`${group.id}:${cu.id}`)),
        })),
      );
      if (mergedUsers.length > 0) {
        const nonOwnerUser = mergedUsers.find((u) => u.id !== 'default' && u.id !== meRes?.userId);
        setAccessSelectedUserId((prev) =>
          prev && mergedUsers.some((u) => u.id === prev)
            ? prev
            : (nonOwnerUser?.id ?? mergedUsers[0]!.id),
        );
      }
      setAccessBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, settingsTab, accessReloadNonce, storageScope, accessScope, accessAccountEpoch]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'access' || !accessSelectedUserId) return;
    let cancelled = false;
    setAccessUserHubRole(null); setAccessMemberships({}); setAccessSnapshotGeneration(-1);
    void api
      .hubRole(accessSelectedUserId)
      .then((r) => {
        if (!cancelled && accessCurrent()) { setAccessUserHubRole(r); setAccessHubRoleGeneration(accessView.generation); }
      })
      .catch(() => {
        if (!cancelled && accessCurrent()) setAccessUserHubRole(null);
      });
    const conns = accessDir?.connections ?? [];
    if (conns.length > 0) {
      void Promise.all(
        conns.map(async (c) => {
          const m = await api.connectorMembership(c, accessSelectedUserId).catch(() => null);
          return [`${c.ownerUserId}:${c.id}`, m] as const;
        }),
      ).then((entries) => {
        if (cancelled || !accessCurrent()) return;
        const map: Record<string, ConnectorMembership> = {};
        for (const [k, v] of entries) {
          if (v) map[k] = v;
        }
        setAccessMemberships(map);
        setAccessSnapshotGeneration(accessView.generation);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, settingsTab, accessSelectedUserId, accessDir, accessReloadNonce, accessScope, accessAccountEpoch, storageScope]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'sandbox') return;
    let cancelled = false;
    void api.hubDockerSandboxes().then((res) => {
      if (cancelled) return;
      setSbxInstances(res.sandboxes ?? []);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, settingsTab]);
  const [settingsPos, setSettingsPos] = useState<{ x: number; y: number; width: number; height: number }>(() =>
    clampInitialDesktopRect(
      Math.min(760, surfaceWidth - 110),
      500,
      Math.min(560, surfaceHeight - 110),
      380,
      Math.max(40, Math.round((surfaceWidth - 760) / 2)),
      surfaceHeight <= 980 ? 22 : 50,
    ),
  );
  const settingsDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [detectedScreens, setDetectedScreens] = useState<ScreenPlacementRect[]>([]);
  const [screenApiSupported, setScreenApiSupported] = useState<boolean>(() =>
    isWindowPlacementApiSupported(),
  );
  const [screenStatusMsg, setScreenStatusMsg] = useState<string>('');
  const [isSecondaryDisplay] = useState<boolean>(() =>
    typeof window !== 'undefined' ? isSecondaryDisplayWindow(window.location.search) : false,
  );
  const [secondaryWindowIds, setSecondaryWindowIds] = useState<string[]>(() =>
    readSecondaryWindowIds(storageScope),
  );
  const [edgePortalSide, setEdgePortalSide] = useState<'left' | 'right' | null>(null);
  const [isFullscreenDisplay, setIsFullscreenDisplay] = useState<boolean>(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  );
  const multiScreenChannelRef = useRef<BroadcastChannel | null>(null);
  const multiScreenWindowIdRef = useRef<string>(`os_win_${Math.random().toString(36).slice(2, 9)}`);
  const companionPopupRef = useRef<Window | null>(null);
  const wallpaperFileInputRef = useRef<HTMLInputElement | null>(null);
  const [prefs, setPrefs] = useState<DesktopPreferences>(() =>
    readDesktopPreferences(storageScope),
  );
  const [iconPositions, setIconPositions] = useState<Record<string, DesktopIconPosition>>(() =>
    readDesktopIconPositions(storageScope),
  );
  const [localMinimizedIds, setLocalMinimizedIds] = useState<Set<string>>(
    () => new Set(readDesktopMinimizedIds(storageScope)),
  );
  const [zOrder, setZOrder] = useState<string[]>(() => openWindows.map((w) => w.id));
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetIcon?: DesktopIconItem | undefined; taskbarTarget?: { kind: "window" | "quick" | "bar"; win?: DesktopOpenWindowItem | undefined; quickId?: string | undefined; title?: string | undefined } | undefined } | null>(null);
  const osDesktopMenuRef = useRef<HTMLDivElement>(null);
  const osWechatMenuRef = useRef<HTMLDivElement>(null);
  const [clockText, setClockText] = useState(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  );
  const [dateText, setDateText] = useState(() =>
    new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }),
  );
  const [windowRects, setWindowRects] = useState<Record<string, DesktopWindowGeometry>>(() =>
    readDesktopWindowRects(storageScope),
  );

  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    winEl?: HTMLElement | undefined;
  } | null>(null);

  const resizeRef = useRef<{
    id: string;
    edge: DesktopResizeEdge;
    pointerId: number;
    startX: number;
    startY: number;
    orig: DesktopWindowGeometry;
    lastGeo: DesktopWindowGeometry;
    moved: boolean;
    winEl?: HTMLElement | undefined;
  } | null>(null);

  const iconDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    el?: HTMLElement | undefined;
  } | null>(null);

  const explorerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const mountedOnceIdsRef = useRef<Set<string>>(new Set());
  const shellRef = useRef<HTMLDivElement | null>(null);
  const marqueeDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    additive: boolean;
    baseSelected: Set<string>;
    itemRects: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  } | null>(null);
  const qqDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setStartMenuOpen(false);
        setTrayFlyoutOpen(false);
        setNotificationCenterOpen(false);
        setSnapLayoutMenuFor(undefined);
        setContextMenu(null);
        setTaskViewOpen(false);
        setBootStepIndex(2);
        setPowerPhase((prev) => {
          if (prev === 'booting') {
            if (bootFadeTimerRef.current !== null) {
              window.clearTimeout(bootFadeTimerRef.current);
            }
            bootFadeTimerRef.current = window.setTimeout(() => {
              bootFadeTimerRef.current = null;
              setPowerPhase((cur) => (cur === 'boot-fading' ? 'ready' : cur));
            }, 420);
            return 'boot-fading';
          }
          return prev;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const skipBootToSmoothFade = useCallback(() => {
    setBootStepIndex(2);
    setPowerPhase((prev) => {
      if (prev !== 'booting') return prev;
      if (bootFadeTimerRef.current !== null) {
        window.clearTimeout(bootFadeTimerRef.current);
      }
      bootFadeTimerRef.current = window.setTimeout(() => {
        bootFadeTimerRef.current = null;
        setPowerPhase((cur) => (cur === 'boot-fading' ? 'ready' : cur));
      }, 420);
      return 'boot-fading';
    });
  }, []);

  // OS Boot-up animation sequence on Desktop UI entry / page refresh
  useEffect(() => {
    setPowerPhase('booting');
    setBootStepIndex(0);
    const t1 = window.setTimeout(() => setBootStepIndex(1), 240);
    const t2 = window.setTimeout(() => setBootStepIndex(2), 500);
    const t3 = window.setTimeout(() => {
      setPowerPhase((prev) => (prev === 'booting' ? 'boot-fading' : prev));
    }, 760);
    const t4 = window.setTimeout(() => {
      setPowerPhase((prev) => (prev === 'boot-fading' || prev === 'booting' ? 'ready' : prev));
    }, 1280);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
      if (bootFadeTimerRef.current !== null) {
        window.clearTimeout(bootFadeTimerRef.current);
        bootFadeTimerRef.current = null;
      }
      if (shutdownTimerRef.current !== null) {
        window.clearTimeout(shutdownTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    writeDesktopNotifications(storageScope, notifications);
  }, [storageScope, notifications]);

  const pushDesktopNotification = (params: {
    kind: DesktopNotificationKind;
    title: string;
    body: string;
    sessionKey?: string | undefined;
    showToast?: boolean | undefined;
  }) => {
    const now = Date.now();
    if (params.kind === 'session-completed' && params.sessionKey) {
      const lastAt = recentCompletionToastAtRef.current.get(params.sessionKey) ?? 0;
      if (now - lastAt < 8000) {
        return;
      }
      recentCompletionToastAtRef.current.set(params.sessionKey, now);
    }
    const item: DesktopNotificationItem = {
      id: `notif-${now}-${Math.random().toString(36).slice(2, 7)}`,
      kind: params.kind,
      title: params.title,
      body: params.body,
      sessionKey: params.sessionKey,
      createdAt: now,
      read: notificationCenterOpen,
    };
    setNotifications((prev) => {
      if (
        params.kind === 'session-completed' &&
        params.sessionKey &&
        prev.some(
          (n) =>
            n.kind === 'session-completed' &&
            n.sessionKey === params.sessionKey &&
            now - n.createdAt < 8000,
        )
      ) {
        return prev;
      }
      return [item, ...prev].slice(0, 50);
    });
    if (params.showToast !== false) {
      setActiveToasts((prev) => {
        const filtered =
          params.kind === 'session-completed' && params.sessionKey
            ? prev.filter(
                (toast) =>
                  !(toast.kind === 'session-completed' && toast.sessionKey === params.sessionKey),
              )
            : prev;
        return [item, ...filtered].slice(0, 4);
      });
      window.setTimeout(() => {
        setActiveToasts((prev) =>
          prev.map((toast) => (toast.id === item.id ? { ...toast, fadingOut: true } : toast)),
        );
      }, 4200);
      window.setTimeout(() => {
        setActiveToasts((prev) => prev.filter((toast) => toast.id !== item.id));
      }, 4650);
    }
  };

  // Detect newly completed sessions & pop up bottom-right fade-out toast + Notification Center entry
  useEffect(() => {
    const currentRunningKeys = new Set(
      sessions
        .filter((s) => s.status === 'running' || s.hasActiveRun)
        .map((s) => s.sessionKey),
    );
    for (const rKey of currentRunningKeys) {
      recentCompletionToastAtRef.current.delete(rKey);
    }
    const currentCompletedKeys = new Set(completedSessionKeys);

    if (prevRunningKeysRef.current === null || prevCompletedKeysRef.current === null) {
      prevRunningKeysRef.current = currentRunningKeys;
      prevCompletedKeysRef.current = currentCompletedKeys;
      return;
    }

    const newlyCompleted = detectNewlyCompletedSessions({
      sessions,
      prevRunningKeys: prevRunningKeysRef.current,
      prevCompletedKeys: prevCompletedKeysRef.current,
      nextCompletedKeys: currentCompletedKeys,
    });

    prevRunningKeysRef.current = currentRunningKeys;
    const mergedCompletedKeys = new Set(currentCompletedKeys);
    for (const s of newlyCompleted) {
      mergedCompletedKeys.add(s.sessionKey);
    }
    prevCompletedKeysRef.current = mergedCompletedKeys;

    if (newlyCompleted.length > 0) {
      for (const s of newlyCompleted) {
        const rawTitle = s.title?.trim();
        const displayTitle =
          rawTitle && rawTitle !== s.sessionKey && !rawTitle.startsWith('agent:')
            ? rawTitle
            : s.sessionKey.split(':').pop()?.slice(0, 24) || s.sessionKey;
        pushDesktopNotification({
          kind: 'session-completed',
          title: t('Session task completed'),
          body: `${displayTitle} — ${t('Reply ready to view')}`,
          sessionKey: s.sessionKey,
          showToast: true,
        });
      }
    }
  }, [sessions, completedSessionKeys, t]);

  const triggerExitDesktopWithAnimation = () => {
    if (powerPhase === 'shutting-down') return;
    setContextMenu(null);
    setStartMenuOpen(false);
    setTrayFlyoutOpen(false);
    setNotificationCenterOpen(false);
    setPowerPhase('shutting-down');
    shutdownTimerRef.current = window.setTimeout(() => {
      shutdownTimerRef.current = null;
      onSwitchToClassic();
    }, 640);
  };

  const handleRefreshDesktop = () => {
    setContextMenu(null);
    setIsRefreshingDesktop(true);
    setDesktopRefreshNonce((n) => n + 1);
    setDesktopFiles(readDesktopFiles(storageScope));
    setRecycleItems(readDesktopRecycleBin(storageScope));
    setDesktopBindings(readDesktopBindings(storageScope));
    setModeratorConfig(loadModeratorOrchestrationConfig(storageScope));
    void refreshDetectedScreens(false);
    window.setTimeout(() => {
      setIsRefreshingDesktop(false);
    }, 520);
    pushDesktopNotification({
      kind: 'desktop-refreshed',
      title: t('Desktop refreshed'),
      body: t('Icons, Fences, bindings, and live telemetry synchronized.'),
      showToast: true,
    });
  };

  const handleOrganizeDesktopIcons = () => {
    setContextMenu(null);
    setIsRefreshingDesktop(true);
    setDesktopRefreshNonce((n) => n + 1);
    resetFencePositions();
    if (prefs.fencesEnabled === false) {
      const organized = organizeDesktopIconsGrid({
        icons,
        surfaceWidth,
        surfaceHeight,
        taskbarHeight: taskbarMetrics.taskbarHeight,
      });
      setIconPositions(organized);
    } else {
      const pinnedSet = new Set(prefs.freeDesktopIconIds ?? []);
      const freeOnly = icons.filter(
        (item) =>
          pinnedSet.has(item.id) ||
          item.kind === 'desktop-file' ||
          item.kind === 'recycle-bin' ||
          item.id === 'app:wechat-messenger' ||
          item.id === 'app:session-explorer' ||
          item.id === 'app:browser',
      );
      const organized = organizeDesktopIconsGrid({
        icons: freeOnly,
        surfaceWidth,
        surfaceHeight,
        taskbarHeight: taskbarMetrics.taskbarHeight,
      });
      // Clear scattered positions so Fence items return cleanly to Fences while free desktop icons snap to grid
      setIconPositions(
        Object.fromEntries(
          Object.entries(organized).filter(([id]) => pinnedSet.has(id)),
        ),
      );
    }
    window.setTimeout(() => {
      setIsRefreshingDesktop(false);
    }, 460);
    pushDesktopNotification({
      kind: 'system-info',
      title: t('Desktop icons organized'),
      body: t('All desktop icons and Fences have been aligned to the grid.'),
      showToast: true,
    });
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = new Date();
      const nextClock = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const nextDate = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
      setClockText((prev) => (prev === nextClock ? prev : nextClock));
      setDateText((prev) => (prev === nextDate ? prev : nextDate));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      writeDesktopWindowRects(storageScope, windowRects);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [storageScope, windowRects]);

  useEffect(() => {
    writeDesktopWallpaper(storageScope, wallpaper);
  }, [storageScope, wallpaper]);

  useEffect(() => {
    writeDesktopWallpaperConfig(storageScope, wallpaperConfig);
  }, [storageScope, wallpaperConfig]);

  useEffect(() => {
    writeDesktopQqDockSize(storageScope, qqSize);
  }, [storageScope, qqSize]);

  const refreshDetectedScreens = async (promptPermission = false): Promise<ScreenPlacementRect[]> => {
    setScreenApiSupported(isWindowPlacementApiSupported());
    const topo = await detectSecondaryScreenRect({ promptPermission });
    setDetectedScreens(topo.displays);
    return topo.displays;
  };

  useEffect(() => {
    void refreshDetectedScreens(false);
    const unsub = subscribeScreenDetailsChanges((topo) => {
      setDetectedScreens(topo.displays);
    });
    const onFs = () => setIsFullscreenDisplay(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      unsub();
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  useEffect(() => {
    setSecondaryWindowIds(readSecondaryWindowIds(storageScope));
  }, [storageScope]);

  // If this window was opened as Secondary Display (Display 2), auto-place on secondary monitor & assign initial paneId
  useEffect(() => {
    if (!isSecondaryDisplay || typeof window === 'undefined') return;
    const proj = parseProjectionSearch(window.location.search);
    if (proj?.paneId && proj.paneId !== 'workspace' && !proj.paneId.startsWith('screen-')) {
      setSecondaryWindowIds((prev) => {
        if (prev.includes(proj.paneId)) return prev;
        return writeSecondaryWindowIds([...prev, proj.paneId], storageScope);
      });
    }
    let disposed = false;
    void detectSecondaryScreenRect({ promptPermission: true }).then(async (topo) => {
      if (disposed) return;
      const targetScreen =
        typeof proj?.targetScreenIndex === 'number' && topo.displays[proj.targetScreenIndex]
          ? topo.displays[proj.targetScreenIndex]
          : topo.secondaryRect ?? topo.displays.find((d) => !d.isPrimary) ?? topo.displays[0];
      if (targetScreen) {
        moveWindowToScreen(window, targetScreen, { maximizeToScreen: true });
        if (proj?.autoFullscreen !== false) {
          await requestFullscreenOnScreen(document.documentElement, targetScreen);
        }
      }
    });
    // One-time gesture fallback in case browser required an in-window click to enter fullscreen on Display 2
    const onFirstPointerDown = () => {
      if (proj?.autoFullscreen === false || document.fullscreenElement) return;
      void detectSecondaryScreenRect({ promptPermission: false }).then((topo) => {
        const targetScreen = topo.secondaryRect ?? topo.displays.find((d) => !d.isPrimary) ?? topo.displays[0];
        void requestFullscreenOnScreen(document.documentElement, targetScreen);
      });
    };
    window.addEventListener('pointerdown', onFirstPointerDown, { once: true });
    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', onFirstPointerDown);
    };
  }, [isSecondaryDisplay, storageScope]);

  // Cross-window BroadcastChannel + storage event sync for secondaryWindowIds
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (ev: StorageEvent) => {
      if (ev.key && ev.key.includes('agentopsdeck:os-secondary-windows:v1:')) {
        setSecondaryWindowIds(readSecondaryWindowIds(storageScope));
      }
    };
    window.addEventListener('storage', onStorage);
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(MULTI_SCREEN_CHANNEL_NAME);
      multiScreenChannelRef.current = channel;
      channel.onmessage = (event: MessageEvent<MultiScreenSyncMessage>) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.windowId === multiScreenWindowIdRef.current) return;
        if (msg.type === 'sync-secondary-windows' && Array.isArray(msg.secondaryWindowIds)) {
          const next = writeSecondaryWindowIds(msg.secondaryWindowIds, storageScope);
          setSecondaryWindowIds(next);
        } else if (msg.type === 'transfer-window') {
          setSecondaryWindowIds((prev) => {
            const nextSet = new Set(prev);
            if (msg.targetDisplay === 'secondary') {
              nextSet.add(msg.targetWindowId);
            } else {
              nextSet.delete(msg.targetWindowId);
            }
            return writeSecondaryWindowIds([...nextSet], storageScope);
          });
        }
      };
    }
    return () => {
      window.removeEventListener('storage', onStorage);
      try {
        channel?.close();
      } catch {
        // Ignore
      }
      multiScreenChannelRef.current = null;
    };
  }, [storageScope]);

  const openExtendedSecondaryDesktop = useCallback(
    async (initialWindowId?: string, initialTitle?: string, initialKind?: string) => {
      const screens = await refreshDetectedScreens(true);
      const secondary = screens.find((s) => !s.isPrimary) ?? screens[1] ?? screens[0];
      const url = buildProjectionUrl(window.location.origin, window.location.pathname, {
        paneId: initialWindowId || 'workspace',
        kind: initialKind || 'workspace',
        title: initialTitle || 'Display 2 · Extended Desktop',
        autoFullscreen: true,
        targetScreenIndex: secondary?.index,
      });
      const fullUrl = `${url}${url.includes('?') ? '&' : '?'}os_display=2`;
      const opened = openCompanionWindowOnScreen(fullUrl, 'agentopsdeck_os_display_2', secondary);
      if (opened) {
        companionPopupRef.current = opened;
      }
      return opened;
    },
    [],
  );

  const transferWindowToDisplay = useCallback(
    (winId: string, targetDisplay: 'primary' | 'secondary', winMeta?: { title?: string; kind?: string }) => {
      setSecondaryWindowIds((prev) => {
        const nextSet = new Set(prev);
        if (targetDisplay === 'secondary') {
          nextSet.add(winId);
        } else {
          nextSet.delete(winId);
        }
        const nextList = writeSecondaryWindowIds([...nextSet], storageScope);
        try {
          multiScreenChannelRef.current?.postMessage({
            type: 'sync-secondary-windows',
            windowId: multiScreenWindowIdRef.current,
            secondaryWindowIds: nextList,
            timestamp: Date.now(),
          } satisfies MultiScreenSyncMessage);
        } catch {
          // Ignore broadcast errors
        }
        return nextList;
      });
      if (targetDisplay === 'secondary' && !isSecondaryDisplay) {
        const popupAlive = companionPopupRef.current && !companionPopupRef.current.closed;
        if (!popupAlive) {
          void openExtendedSecondaryDesktop(winId, winMeta?.title, winMeta?.kind);
        }
      }
    },
    [isSecondaryDisplay, openExtendedSecondaryDesktop, storageScope],
  );

  useEffect(() => {
    writeDesktopPreferences(storageScope, prefs);
  }, [storageScope, prefs]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      writeDesktopIconPositions(storageScope, iconPositions);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [storageScope, iconPositions]);

  useEffect(() => {
    writeDesktopMinimizedIds(storageScope, [...localMinimizedIds]);
  }, [storageScope, localMinimizedIds]);

  useEffect(() => {
    writeDesktopFiles(storageScope, desktopFiles);
  }, [storageScope, desktopFiles]);

  useEffect(() => {
    writeDesktopRecycleBin(storageScope, recycleItems);
  }, [storageScope, recycleItems]);

  useEffect(() => {
    writeDesktopBindings(storageScope, desktopBindings);
  }, [storageScope, desktopBindings]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      writeDesktopFenceRects(storageScope, fenceRects);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [storageScope, fenceRects]);


  // Sync Moderator Mode orchestration links
  useEffect(() => {
    setModeratorConfig(loadModeratorOrchestrationConfig(storageScope));
    const onModUpdate = () => {
      setModeratorConfig(loadModeratorOrchestrationConfig(storageScope));
    };
    window.addEventListener(MODERATOR_CONFIG_EVENT, onModUpdate);
    return () => window.removeEventListener(MODERATOR_CONFIG_EVENT, onModUpdate);
  }, [storageScope]);

  // Listen for CardConnectionsButton ('agentopsdeck:binding-lines') inside OS Desktop windows
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const onBindingLinesToggle = (event: Event) => {
      const targetEl = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-os-window]');
      const winId = targetEl?.dataset.osWindow;
      const win = winId ? openWindows.find((w) => w.id === winId) : undefined;
      let targetIconId: string | null = null;
      if (win) {
        if (win.kind === 'session') targetIconId = `session:${win.sessionKey}`;
        else if (win.kind === 'notebook') {
          const visibleNbs = notebooks;
          const rId = win.resourceId ?? visibleNbs[0]?.id ?? 'default';
          targetIconId = !rId || rId === 'default' || visibleNbs[0]?.id === rId ? 'app:notebook' : `notebook:${rId}`;
        } else if (win.kind === 'taskboard') {
          const rId = win.resourceId ?? 'default';
          targetIconId = rId === 'default' ? 'app:taskboard' : `taskboard:${rId}`;
        } else if (win.kind === 'moderator') targetIconId = 'app:moderator';
        else if (win.kind === 'docker') targetIconId = 'app:docker';
        else if (win.kind === 'subagents') targetIconId = 'app:subagents';
      }
      if (targetIconId) {
        setHighlightedLineageNodeId((prev) => {
          const isTurningOff = prev === targetIconId && prefs.showLineageLines !== false;
          if (isTurningOff) {
            setPrefs((pState) => ({ ...pState, showLineageLines: false }));
            return null;
          }
          setPrefs((pState) => ({ ...pState, showLineageLines: true }));
          setLineageInspectorOpen(true);
          return targetIconId;
        });
      } else {
        setPrefs((prev) => ({ ...prev, showLineageLines: prev.showLineageLines === false }));
      }
    };
    shell.addEventListener('agentopsdeck:binding-lines', onBindingLinesToggle);
    return () => shell.removeEventListener('agentopsdeck:binding-lines', onBindingLinesToggle);
  }, [openWindows, notebooks, prefs.showLineageLines]);

  // Fetch active backend Notebook & Taskboard bindings so OS Desktop Mode displays all session <-> card lineage lines
  const notebookIdsKey = useMemo(
    () => notebooks.slice(0, 32).map((n) => n.id).join(','),
    [notebooks],
  );
  const taskboardIdsKey = useMemo(
    () => (taskboards && taskboards.length > 0 ? taskboards.slice(0, 16).map((t) => t.resourceId).join(',') : 'default'),
    [taskboards],
  );
  const desktopBindingSyncRef = useRef<ReturnType<typeof createDesktopBindingSync> | null>(null);
  const desktopBindingSubsRef = useRef<Map<string, () => void>>(new Map());
  const lastDesktopBindingRefreshNonceRef = useRef(desktopRefreshNonce);

  useEffect(() => {
    const epoch = recoveryEpoch();
    let live = true;
    const sync = createDesktopBindingSync({
      notebookIds: [],
      taskboardIds: [],
      readNotebook: async (nbId, signal) => {
        const res = await api.fileCardBinding(workspaceFileCardResource('notebook', `hub:${nbId}`), signal);
        return res.enabled ? extractBindingSessionIds(res.binding) : [];
      },
      readTaskboard: async (tbId, signal) => {
        const res = await api.fileBoardBinding(tbId, signal);
        return res.enabled ? extractBindingSessionIds(res.binding) : [];
      },
      onNotebook: (nbId, sessionIds) => {
        if (!live || epoch !== recoveryEpoch()) return;
        setNotebookBindingsMap((prev) => updateBindingMap(prev, nbId, sessionIds));
      },
      onTaskboard: (tbId, sessionIds) => {
        if (!live || epoch !== recoveryEpoch()) return;
        setTaskboardBindingsMap((prev) => updateBindingMap(prev, tbId, sessionIds));
      },
      isHidden: () => document.hidden,
      isMessageLoadBusy: () => {
        const state = desktopHistoryReads.inspect();
        return state.active > 0 || state.queued > 0;
      },
      getConcurrency: () => Math.min(2, requestGovernor.effectiveConcurrency()),
    });
    desktopBindingSyncRef.current = sync;
    const subs = desktopBindingSubsRef.current;

    const onVisibilityChange = () => {
      if (!document.hidden) sync.resume();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      desktopBindingSyncRef.current = null;
      sync.dispose();
      for (const unsub of subs.values()) unsub();
      subs.clear();
    };
  }, [storageScope]);

  useEffect(() => {
    const sync = desktopBindingSyncRef.current;
    if (!sync) return;
    const nbIds = notebookIdsKey ? notebookIdsKey.split(',').filter(Boolean) : ['default'];
    const tbIds = taskboardIdsKey ? taskboardIdsKey.split(',').filter(Boolean) : ['default'];
    setNotebookBindingsMap((prev) => pruneBindingMap(prev, new Set(nbIds)));
    setTaskboardBindingsMap((prev) => pruneBindingMap(prev, new Set(tbIds)));

    const subs = desktopBindingSubsRef.current;
    const activeKeys = new Set<string>();
    sync.updateResources(nbIds, tbIds);

    for (const nbId of nbIds) {
      const key = `notebook:${nbId}`;
      activeKeys.add(key);
      if (!subs.has(key)) {
        const resource = workspaceFileCardResource('notebook', `hub:${nbId}`);
        subs.set(
          key,
          workspaceResourceEvents.subscribe(storageScope, resource, (revision) => {
            sync.notify('notebook', nbId, revision);
          }, 'card-file-binding'),
        );
      }
    }
    for (const tbId of tbIds) {
      const key = `taskboard:${tbId}`;
      activeKeys.add(key);
      if (!subs.has(key)) {
        subs.set(
          key,
          workspaceResourceEvents.subscribe(storageScope, tbId, (revision) => {
            sync.notify('taskboard', tbId, revision);
          }, 'taskboard-binding'),
        );
      }
    }
    for (const [key, unsub] of subs.entries()) {
      if (!activeKeys.has(key)) {
        unsub();
        subs.delete(key);
      }
    }
    sync.start();
  }, [notebookIdsKey, taskboardIdsKey, storageScope]);

  useEffect(() => {
    if (lastDesktopBindingRefreshNonceRef.current === desktopRefreshNonce) return;
    lastDesktopBindingRefreshNonceRef.current = desktopRefreshNonce;
    desktopBindingSyncRef.current?.refreshAll();
  }, [desktopRefreshNonce]);

  const paneLineageLinks = useMemo(() => {
    if (!panes || panes.length === 0) return [];
    const visibleNbs = notebooks;
    const firstNbId = visibleNbs[0]?.id;
    const paneToIconId = (p: Pane): string | null => {
      if (isSessionPane(p)) return `session:${p.sessionKey}`;
      if (p.kind === 'notebook') {
        const rId = p.resourceId || 'default';
        return rId === 'default' || (firstNbId && rId === firstNbId) ? 'app:notebook' : `notebook:${rId}`;
      }
      if (p.kind === 'taskboard') {
        const rId = p.resourceId || 'default';
        return rId === 'default' ? 'app:taskboard' : `taskboard:${rId}`;
      }
      if (p.kind === 'statuscard') return 'app:statuscard';
      if (p.kind === 'drawing') return 'app:drawing';
      if (p.kind === 'file-browser') return 'app:file-browser';
      if (p.kind === 'moderator') return 'app:moderator';
      if (p.kind === 'terminal') return 'app:terminal';
      if (p.kind === 'docker') return 'app:docker';
      if (p.kind === 'subagents') return 'app:subagents';
      if (p.kind === 'dashboard') return 'app:dashboard';
      if (p.kind === 'git-tree') return 'app:git-tree';
      if (p.kind === 'browser') return 'app:browser';
      return null;
    };
    const paneById = new Map(panes.map((p) => [p.id, p]));
    const rawEdges = fileLinkEdges([...panes]);
    const mapped: Array<{ fromIconId: string; toIconId: string; label: string; kind: 'co-bound' | 'file-link' }> = [];
    for (const edge of rawEdges) {
      const pA = paneById.get(edge.card);
      const pB = paneById.get(edge.session);
      if (!pA || !pB) continue;
      const idA = paneToIconId(pA);
      const idB = paneToIconId(pB);
      if (!idA || !idB || idA === idB) continue;
      const isFileLink = pA.kind === 'file-browser' || pB.kind === 'file-browser';
      mapped.push({
        fromIconId: idA,
        toIconId: idB,
        label: isFileLink ? t('File Explorer Link') : t('Co-bound Card'),
        kind: isFileLink ? 'file-link' : 'co-bound',
      });
    }
    return mapped;
  }, [panes, notebooks, t]);

  const resolvedLineageEdges = useMemo<DesktopResolvedLineageEdge[]>(
    () =>
      resolveDesktopLineageLinks({
        desktopBindings,
        notebooks,
        taskboards,
        notebookBindings: notebookBindingsMap,
        taskboardBindings: taskboardBindingsMap,
        paneLinks: paneLineageLinks,
        moderatorConfig,
      }),
    [desktopBindings, notebooks, taskboards, notebookBindingsMap, taskboardBindingsMap, paneLineageLinks, moderatorConfig],
  );

  // Auto-save editingDesktopFile into desktopFiles immediately on change
  useEffect(() => {
    if (!editingDesktopFile) return;
    setDesktopFiles((prev) =>
      prev.some((f) => f.id === editingDesktopFile.id)
        ? prev.map((f) => (f.id === editingDesktopFile.id ? editingDesktopFile : f))
        : [editingDesktopFile, ...prev],
    );
  }, [editingDesktopFile]);

  // Load metric sources & poll live CPU / RAM / Disk for Desktop HUD Widget
  useEffect(() => {
    if (!hudOpen) return;
    const abort = new AbortController();
    const epoch = recoveryEpoch();
    let live = true;
    void api
      .metricSources(abort.signal)
      .then((res) => {
        if (!live || epoch !== recoveryEpoch()) return;
        setMetricSources(res.sources);
        if (res.sources[0]) {
          const firstKey = JSON.stringify([res.sources[0].kind, res.sources[0].key]);
          setSelectedMetricSource((prev) => {
            if (prev && res.sources.some((s) => JSON.stringify([s.kind, s.key]) === prev)) {
              return prev;
            }
            return firstKey;
          });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      abort.abort();
    };
  }, [hudOpen, storageScope, desktopRefreshNonce]);

  useEffect(() => {
    if (!hudOpen || hudCollapsed || !selectedMetricSource) return;
    const source = metricSources.find(
      (s) => JSON.stringify([s.kind, s.key]) === selectedMetricSource,
    );
    if (!source) return;
    const abort = new AbortController();
    let live = true;
    let timer: number | undefined;
    const scheduleNext = (delayMs: number) => {
      if (!live) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadMetrics(), delayMs);
    };
    const loadMetrics = async () => {
      if (!live) return;
      if (document.hidden || !navigator.onLine) {
        scheduleNext(5000);
        return;
      }
      try {
        const val = await api.systemMetrics(
          source.kind,
          source.key,
          AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        );
        if (live && validSystemMetrics(val)) {
          setMetricSample(val);
        }
      } catch {
        // Ignore transient metric poll failures
      } finally {
        scheduleNext(5000);
      }
    };
    void loadMetrics();
    return () => {
      live = false;
      abort.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hudOpen, hudCollapsed, selectedMetricSource, metricSources, desktopRefreshNonce]);

  useEffect(() => {
    let live = true;
    setBrowserConnections([]); setBrowserConnectionId(''); setBrowserRoots([]); setBrowserAgentId('');
    if (browserOpen && browserEngineMode === 'stream') void api.hubConnections().then(result => {
      if (live && browserScope === recoveryScope() && browserEpoch === recoveryEpoch()) setBrowserConnections(result.connections);
    }).catch(() => { if (live) setBrowserNotice('Browser targets unavailable. No command was sent.'); });
    return () => { live = false; };
  }, [browserOpen, browserEngineMode, browserScope, browserEpoch, storageScope]);

  useEffect(() => {
    let live = true;
    setBrowserRoots([]); setBrowserAgentId('');
    if (browserConnectionId) void api.connectorFileRoots(browserConnectionId).then(result => {
      if (live && browserScope === recoveryScope() && browserEpoch === recoveryEpoch()) setBrowserRoots(result.roots);
    }).catch(() => { if (live) setBrowserNotice('Browser targets unavailable. No command was sent.'); });
    return () => { live = false; };
  }, [browserConnectionId, browserScope, browserEpoch, storageScope]);

  useEffect(() => {
    const lifetime = { identity: browserIdentity, active: true, busy: false };
    browserLifetime.current = lifetime;
    browserCmdRevRef.current = undefined;
    setBrowserStreamFrame(null); setBrowserRemoteText(''); setBrowserBusy(false); setBrowserNotice('');
    const expire = () => {
      lifetime.active = false; browserCmdRevRef.current = undefined;
      setBrowserStreamFrame(null); setBrowserRemoteText(''); setBrowserBusy(false);
    };
    window.addEventListener('agentopsdeck:auth-required', expire);
    return () => { expire(); window.removeEventListener('agentopsdeck:auth-required', expire); };
  }, [browserIdentity]);

  const sendBrowserStreamCommand = useCallback(
    async (cmdPayload: Record<string, unknown>) => {
      const lifetime = browserLifetime.current;
      const current = () => lifetime.active && browserLifetime.current === lifetime && lifetime.identity === browserIdentity
        && browserScope === recoveryScope() && browserEpoch === recoveryEpoch();
      if (browserEngineMode !== 'stream' || !browserOpen || !browserTarget || !current()
        || lifetime.busy || browserUnknown.current) return;
      lifetime.busy = true; setBrowserBusy(true); setBrowserNotice('');
      const now = Date.now();
      const id = `cmd-${now}-${crypto.randomUUID()}`;
      const body = JSON.stringify({
        ...cmdPayload,
        id,
        seq: now,
        kind: (cmdPayload.kind ?? cmdPayload.action ?? "navigate") as string,
      });
      let writing = false;
      try {
        const revision = await writeDesktopBrowserCommand({ target: browserTarget, body, revision: browserCmdRevRef.current, current,
          onWriting: () => { writing = true; browserUnknown.current = { id, target: browserTarget, scope: browserScope, epoch: browserEpoch }; } });
        if (current() && revision) {
          browserCmdRevRef.current = revision; browserUnknown.current = undefined;
        }
      } catch {
        if (current()) setBrowserNotice(writing ? 'Browser command outcome unknown. Input is paused; no command was resent.'
          : 'Browser command revision unavailable. No command was sent.');
      } finally {
        lifetime.busy = false;
        if (current()) setBrowserBusy(false);
      }
    },
    [browserIdentity, browserScope, browserEpoch, browserEngineMode, browserOpen, browserTarget],
  );

  useEffect(() => {
    if (!browserOpen || browserEngineMode !== "stream" || !browserTarget) return;
    const lifetime = browserLifetime.current;
    let live = true;
    const current = () => live && lifetime.active && browserLifetime.current === lifetime && lifetime.identity === browserIdentity
      && browserScope === recoveryScope() && browserEpoch === recoveryEpoch();
    let timer: number | undefined;
    const scheduleNext = (delayMs: number) => {
      if (!current()) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void pollStream(), delayMs);
    };
    const pollStream = async () => {
      if (!current()) return;
      if (document.hidden || !navigator.onLine) {
        scheduleNext(1000);
        return;
      }
      try {
        const preview = await api.filePreview(browserTarget, 'browser-stream/state.json');
        if (!current() || preview.kind !== 'text' || !preview.text) return;
        const data = JSON.parse(preview.text) as NonNullable<typeof browserStreamFrame>;
        if (!data || typeof data.status !== 'string' || typeof data.url !== 'string' || typeof data.title !== 'string'
          || !Number.isFinite(data.width) || data.width <= 0 || !Number.isFinite(data.height) || data.height <= 0
          || (data.error != null && typeof data.error !== 'string')
          || (data.canGoBack !== undefined && typeof data.canGoBack !== 'boolean')
          || (data.canGoForward !== undefined && typeof data.canGoForward !== 'boolean')
          || (data.frameDataUrl !== undefined && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data.frameDataUrl))) return;
        setBrowserStreamFrame(data);
      } catch {
        // Ignore transient stream fetch errors
      } finally {
        scheduleNext(350);
      }
    };
    void pollStream();
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [browserOpen, browserEngineMode, browserTarget, browserIdentity, browserScope, browserEpoch, browserReloadTick]);

  const checkOriginalBrowserCommand = async () => {
    const original = browserUnknown.current;
    const lifetime = browserLifetime.current;
    const current = () => original && browserUnknown.current === original && lifetime.active && browserLifetime.current === lifetime
      && lifetime.identity === browserIdentity && original.scope === recoveryScope() && original.epoch === recoveryEpoch();
    if (!current() || !original || lifetime.busy) return;
    lifetime.busy = true; setBrowserBusy(true);
    try {
      await api.filePreview(original.target, 'browser-stream/cmd.json');
      if (current()) setBrowserNotice('Command file checked. Execution is still unconfirmed; input remains paused.');
    } catch {
      if (current()) setBrowserNotice('Original browser command could not be checked. Input remains paused.');
    } finally { lifetime.busy = false; if (current()) setBrowserBusy(false); }
  };

  const bringSurfaceToFront = (surfaceId: string) => {
    setZOrder((prev) => promoteWindowZOrder(prev, surfaceId));
  };

  const render8WayResizeHandles = (
    key: string,
    currentRect: { x: number; y: number; width: number; height: number },
    onUpdate: (next: { x: number; y: number; width: number; height: number }) => void,
    minSize?: { minW?: number | undefined; minH?: number | undefined },
    testIdPrefix?: string,
  ) =>
    RESIZE_EDGES.map((edge) => (
      <div
        key={edge}
        data-resize-edge={edge}
        data-testid={testIdPrefix ? `${testIdPrefix}-${edge}` : undefined}
        className={`os-window-resize-edge edge-${edge}${edge === "se" ? " os-window-resize-handle" : ""}`}
        title={edge === "se" ? t("Resize window") : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          sysResizeRef.current = {
            key,
            edge,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            orig: {
              x: currentRect.x,
              y: currentRect.y,
              width: currentRect.width,
              height: currentRect.height,
            },
          };
        }}
        onPointerMove={(e) => {
          const r = sysResizeRef.current;
          if (!r || r.key !== key || r.pointerId !== e.pointerId) return;
          const next = resizeDesktopWindowGeometry(
            { ...r.orig, maximized: false },
            r.edge,
            e.clientX - r.startX,
            e.clientY - r.startY,
            surfaceWidth,
            surfaceHeight,
            minSize,
          );
          onUpdate({
            x: Math.round(next.x),
            y: Math.round(next.y),
            width: Math.round(next.width),
            height: Math.round(next.height),
          });
        }}
        onPointerUp={(e) => {
          if (sysResizeRef.current?.pointerId === e.pointerId) {
            sysResizeRef.current = null;
          }
        }}
      />
    ));

  // Keep zOrder synchronized with open workspace windows and active system surfaces
  useEffect(() => {
    setZOrder((prev) => {
      const validIds = new Set(openWindows.map((w) => w.id));
      validIds.add("sys:qq-dock");
      if (hudOpen) validIds.add("sys:hud");
      if (explorerOpen) validIds.add("sys:explorer");
      if (settingsOpen) validIds.add("sys:settings");
      if (browserOpen) validIds.add("sys:browser");
      if (wechatOpen) validIds.add("sys:wechat");
      if (recycleBinOpen) validIds.add("sys:recycle");
      if (editingDesktopFile) validIds.add("sys:file-studio");
      let next = prev.filter((id) => validIds.has(id));
      for (const id of validIds) {
        if (!next.includes(id)) next.push(id);
      }
      if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) {
        return prev;
      }
      return next;
    });
  }, [
    openWindows,
    hudOpen,
    explorerOpen,
    settingsOpen,
    browserOpen,
    wechatOpen,
    recycleBinOpen,
    editingDesktopFile,
  ]);

  // Promote newly activated workspace window to top of unified zOrder
  useEffect(() => {
    if (activeWindowId) {
      setZOrder((prev) => promoteWindowZOrder(prev, activeWindowId));
    }
  }, [activeWindowId]);

  const recycledIconIdSet = useMemo(
    () => new Set(recycleItems.map((item) => item.id)),
    [recycleItems],
  );
  const freeDesktopIconIdSet = useMemo(
    () => new Set(prefs.freeDesktopIconIds ?? []),
    [prefs.freeDesktopIconIds],
  );

  const icons = useMemo(
    () =>
      buildDesktopIcons({
        sessions,
        notebooks,
        taskboards,
        desktopFiles,
        recycledIconIds: recycledIconIdSet,
        recycleBinCount: recycleItems.length,
        completedSessionKeys,
        searchQuery,
        sortBy: prefs.sortBy,
        labels: {
          recycleBin: t('Recycle Bin'),
          fileExplorer: t('File browser'),
          wechatMessenger: t('Chat Studio'),
          sessionExplorer: t('Session Explorer'),
          notebook: t('Notebook'),
          newNotebook: `+ ${t('New notebook')}`,
          taskboard: t('Task board'),
          newTaskboard: `+ ${t('New taskboard')}`,
          terminal: t('Terminal'),
          docker: t('Docker & Sandboxes'),
          subagents: t('Sub-agent Companion'),
          tokenDashboard: t('Token Telemetry'),
          whiteboard: t('Whiteboard'),
          moderator: t('Moderator Hub'),
          gitTree: t('Git Graph'),
          browser: t('Web Preview'),
          statuscard: t('Session Status Board'),
          systemSettings: t('System Settings'),
        },
      }),
    [sessions, notebooks, taskboards, desktopFiles, recycledIconIdSet, recycleItems.length, completedSessionKeys, searchQuery, prefs.sortBy, t],
  );

  const effectiveHudSessions = sessions;

  const hudTokenSummary = useMemo(
    () => summarizeDashboardTokens(effectiveHudSessions),
    [effectiveHudSessions],
  );

  const hudConnectors = useMemo(() => {
    const map = new Map<string, { id: string; label: string; state: string; count: number }>();
    if (sourceStates) {
      if (Array.isArray(sourceStates)) {
        for (const src of sourceStates) {
          const id = src.connectionId || "local-hub";
          map.set(id, { id, label: id, state: src.status || "ready", count: 0 });
        }
      } else {
        const mapStates = sourceStates as ReadonlyMap<string, string>;
        for (const [id, st] of mapStates.entries()) {
          map.set(id, { id, label: id, state: st || "ready", count: 0 });
        }
      }
    }
    for (const s of effectiveHudSessions) {
      const idx = s.sessionKey.indexOf(':');
      const prefix = idx > 0 ? s.sessionKey.slice(0, idx) : '';
      const connId =
        prefix && prefix !== 'agent' && prefix !== 'codex' && prefix !== 'claude-code' && prefix !== 'ghcp'
          ? prefix
          : s.sessionRef?.nodeId ?? 'local-hub';
      const existing = map.get(connId);
      const isErr = s.runtime?.connection === 'disconnected' || s.runtime?.sync === 'error';
      if (existing) {
        existing.count += 1;
        if (isErr && existing.state === 'ready') existing.state = 'degraded';
      } else {
        map.set(connId, {
          id: connId,
          label: connId,
          state: isErr ? 'degraded' : 'ready',
          count: 1,
        });
      }
    }
    if (map.size === 0) {
      map.set('local-hub', { id: 'local-hub', label: 'Local Hub', state: 'ready', count: 0 });
    }
    return [...map.values()];
  }, [effectiveHudSessions, sourceStates]);

  const resetFencePositions = () => {
    setFenceRects(computeDefaultFenceGeometries(surfaceWidth, surfaceHeight));
  };

  const fenceGroups = useMemo(
    () => groupDesktopIconsIntoFences(icons),
    [icons],
  );

  const collapsedFenceSet = useMemo(
    () => new Set(prefs.collapsedFences ?? []),
    [prefs.collapsedFences],
  );

  const toggleFenceCollapsed = (fenceId: DesktopFenceId) => {
    setPrefs((prev) => {
      const current = new Set(prev.collapsedFences ?? []);
      if (current.has(fenceId)) current.delete(fenceId);
      else current.add(fenceId);
      return { ...prev, collapsedFences: [...current] };
    });
  };

  // Assign default cascaded geometry for newly opened windows
  useEffect(() => {
    setWindowRects((prev) => {
      let mutated = false;
      const next = { ...prev };
      openWindows.forEach((win, index) => {
        if (!next[win.id]) {
          next[win.id] =
            win.kind === 'subagents'
              ? computeCompanionWindowGeometry(surfaceWidth, surfaceHeight)
              : computeCascadeWindowGeometry(index, surfaceWidth, surfaceHeight);
          mutated = true;
        }
      });
      return mutated ? next : prev;
    });
  }, [openWindows, surfaceWidth, surfaceHeight]);

  const isWindowMinimized = (win: DesktopOpenWindowItem) =>
    showDesktopAllMinimized ||
    localMinimizedIds.has(win.id) ||
    minimizedKeys.has(win.sessionKey);

  const toggleWindowMinimized = (win: DesktopOpenWindowItem) => {
    setShowDesktopAllMinimized(false);
    setLocalMinimizedIds((prev) => {
      const next = new Set(prev);
      if (next.has(win.id) || minimizedKeys.has(win.sessionKey)) {
        next.delete(win.id);
        if (minimizedKeys.has(win.sessionKey)) {
          onToggleMinimize(win.sessionKey);
        }
      } else {
        next.add(win.id);
      }
      return next;
    });
  };

  const restoreAndFocusWindow = (win: DesktopOpenWindowItem) => {
    setShowDesktopAllMinimized(false);
    setLocalMinimizedIds((prev) => {
      if (!prev.has(win.id)) return prev;
      const next = new Set(prev);
      next.delete(win.id);
      return next;
    });
    if (minimizedKeys.has(win.sessionKey)) {
      onToggleMinimize(win.sessionKey);
    }
    setZOrder((prev) => promoteWindowZOrder(prev, win.id));
    onActivateWindow(win.id);
  };

  const renderIconGlyph = (
    kind: DesktopIconKind,
    running?: boolean,
    size = 22,
    variant?: DesktopIconVariant,
  ) => {
    if (variant === 'new-action') {
      return <Plus size={size} />;
    }
    if (variant === 'wechat-messenger' || kind === 'wechat-messenger') {
      return <MessageSquare size={size} />;
    }
    if (variant === 'session-explorer') {
      return <Columns2 size={size} />;
    }
    switch (kind) {
      case 'file-browser':
        return <FolderOpen size={size} />;
      case 'desktop-file':
        return <FileText size={size} />;
      case 'notebook':
        return variant === 'session-note' ? <BookOpen size={size} /> : <StickyNote size={size} />;
      case 'taskboard':
        return variant === 'sprint-board' ? <ClipboardList size={size} /> : <Kanban size={size} />;
      case 'statuscard':
        return <Gauge size={size} />;
      case 'terminal':
        return <Terminal size={size} />;
      case 'docker':
        return <Container size={size} />;
      case 'subagents':
        return <GitFork size={size} />;
      case 'dashboard':
        return <Activity size={size} />;
      case 'drawing':
        return <PenTool size={size} />;
      case 'moderator':
        return <Mic size={size} />;
      case 'git-tree':
        return <GitBranch size={size} />;
      case 'browser':
        return <Globe size={size} />;
      case 'system-settings':
        return <Settings size={size} />;
      case 'recycle-bin':
        return <Trash2 size={size} />;
      default:
        return <Bot size={size} className={running ? 'os-icon-pulse' : undefined} />;
    }
  };

  const cascadeWindows = () => {
    setShowDesktopAllMinimized(false);
    setLocalMinimizedIds(new Set());
    const next: Record<string, DesktopWindowGeometry> = {};
    openWindows.forEach((win, index) => {
      next[win.id] = computeCascadeWindowGeometry(index, surfaceWidth, surfaceHeight);
    });
    setWindowRects(next);
  };

  const openTaskbarContextMenu = (
    e: React.MouseEvent,
    taskbarTarget: { kind: "window" | "quick" | "bar"; win?: DesktopOpenWindowItem | undefined; quickId?: string | undefined; title?: string | undefined },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (wechatContextMenu) setWechatContextMenu(null);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      taskbarTarget,
    });
  };

  const tileWindows = () => {
    setShowDesktopAllMinimized(false);
    const visibleWins = openWindows.filter((w) => !localMinimizedIds.has(w.id) && !minimizedKeys.has(w.sessionKey));
    if (!visibleWins.length) return;
    const smartRects = computeSmartTileGeometries(
      visibleWins.map((w) => w.id),
      surfaceWidth,
      surfaceHeight,
      prefs.showDesktopIcons,
    );
    setWindowRects((prev) => ({
      ...prev,
      ...smartRects,
    }));
  };

  const snapWindow = (id: string, zone: DesktopSnapZone) => {
    if (zone === 'maximize') {
      onToggleMaximize(id);
      setSnapLayoutMenuFor(undefined);
      return;
    }
    if (maximizedWindowId === id) {
      onToggleMaximize(id);
    }
    setWindowRects((prev) => {
      const existing = prev[id];
      const restoreRect =
        existing?.restoreRect ??
        (existing
          ? { x: existing.x, y: existing.y, width: existing.width, height: existing.height }
          : undefined);
      return {
        ...prev,
        [id]: computeSnapWindowGeometry(zone, surfaceWidth, surfaceHeight, restoreRect),
      };
    });
    setSnapLayoutMenuFor(undefined);
    setZOrder((prev) => promoteWindowZOrder(prev, id));
    onActivateWindow(id);
  };

  const createNewDesktopFile = (
    nameHint?: string,
    initialContent?: string,
    initialAttachments?: DesktopFileAttachment[],
  ) => {
    const idx = desktopFiles.length + 1;
    const entry: DesktopFileEntry = {
      id: `df-${Date.now()}-${idx}`,
      name: nameHint || `Note-${idx}.md`,
      content:
        initialContent ??
        `# Desktop Note ${idx}\n\nWrite Markdown notes, paste screenshots, or attach images & files here.\n`,
      fileType: initialAttachments && initialAttachments.length > 0 ? 'mixed' : 'markdown',
      attachments: initialAttachments ?? [],
      updatedAt: Date.now(),
    };
    setDesktopFiles((prev) => [entry, ...prev]);
    setEditingDesktopFile(entry);
    bringSurfaceToFront("sys:file-studio");
  };

  const attachFilesToDesktopFile = (files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      const isImage = file.type.startsWith('image/');
      const reader = new FileReader();
      reader.onload = () => {
        const resultStr = typeof reader.result === 'string' ? reader.result : '';
        if (isImage) {
          const att: DesktopFileAttachment = {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name || 'image.png',
            mimeType: file.type || 'image/png',
            dataUrl: resultStr,
            size: file.size,
          };
          setEditingDesktopFile((prev) => {
            if (!prev) {
              const idx = desktopFiles.length + 1;
              const entry: DesktopFileEntry = {
                id: `df-${Date.now()}-${idx}`,
                name: file.name || `Image-${idx}.md`,
                content: `# ${file.name || 'Image'}\n\n![${att.name}](${att.dataUrl})\n`,
                fileType: 'image',
                attachments: [att],
                updatedAt: Date.now(),
              };
              setDesktopFiles((list) => [entry, ...list]);
              return entry;
            }
            const nextAtts = [...(prev.attachments ?? []), att];
            return {
              ...prev,
              fileType: 'mixed',
              attachments: nextAtts,
              updatedAt: Date.now(),
            };
          });
        } else {
          const snippet = resultStr.slice(0, 64_000);
          setEditingDesktopFile((prev) => {
            if (!prev) {
              createNewDesktopFile(file.name, snippet);
              return null;
            }
            return {
              ...prev,
              content: `${prev.content}\n\n### ${file.name}\n\`\`\`\n${snippet}\n\`\`\`\n`,
              updatedAt: Date.now(),
            };
          });
        }
      };
      if (isImage) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  };

  const moveIconToRecycleBin = (item: DesktopIconItem) => {
    if (item.id === "app:recycle-bin" || item.kind === "recycle-bin") return;
    const fileSnapshot =
      item.kind === "desktop-file" && item.resourceId
        ? desktopFiles.find((f) => f.id === item.resourceId)
        : undefined;
    const entry: DesktopRecycleItem = {
      id: item.id,
      originalIconId: item.id,
      title: item.title,
      subtitle: item.subtitle,
      kind: item.kind,
      resourceId: item.resourceId,
      sessionKey: item.session?.sessionKey,
      deletedAt: Date.now(),
      fileEntry: fileSnapshot,
      fileSnapshot,
    };
    setRecycleItems((prev) => [entry, ...prev.filter((r) => r.id !== item.id)]);
    if (editingDesktopFile && item.resourceId === editingDesktopFile.id) {
      setEditingDesktopFile(null);
    }
  };

  const restoreRecycledItem = (id: string) => {
    const target = recycleItems.find((r) => r.id === id);
    const snap = target?.fileSnapshot ?? target?.fileEntry;
    if (snap) {
      setDesktopFiles((prev) =>
        prev.some((f) => f.id === snap.id)
          ? prev
          : [snap, ...prev],
      );
    }
    setRecycleItems((prev) => prev.filter((r) => r.id !== id));
  };

  const permanentlyDeleteRecycledItem = (id: string) => {
    const target = recycleItems.find((r) => r.id === id);
    if (target?.kind === "desktop-file" && target.resourceId) {
      setDesktopFiles((prev) => prev.filter((f) => f.id !== target.resourceId));
    }
    setRecycleItems((prev) => prev.filter((r) => r.id !== id));
  };

  const emptyRecycleBin = () => {
    const fileIds = new Set(
      recycleItems
        .filter((r) => r.kind === "desktop-file" && r.resourceId)
        .map((r) => r.resourceId!),
    );
    if (fileIds.size > 0) {
      setDesktopFiles((prev) => prev.filter((f) => !fileIds.has(f.id)));
    }
    setRecycleItems([]);
  };

  const toggleFreeDesktopPlacement = (iconId: string) => {
    setPrefs((prev) => {
      const current = new Set(prev.freeDesktopIconIds ?? []);
      if (current.has(iconId)) current.delete(iconId);
      else current.add(iconId);
      return { ...prev, freeDesktopIconIds: [...current] };
    });
  };

  const toggleDesktopBindingLink = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setDesktopBindings((prev) => {
      const exists = prev.some(
        (b) =>
          ((b.fromId || b.sourceId) === sourceId && (b.toId || b.targetId) === targetId) ||
          ((b.fromId || b.sourceId) === targetId && (b.toId || b.targetId) === sourceId),
      );
      if (exists) {
        return prev.filter(
          (b) =>
            !(
              ((b.fromId || b.sourceId) === sourceId && (b.toId || b.targetId) === targetId) ||
              ((b.fromId || b.sourceId) === targetId && (b.toId || b.targetId) === sourceId)
            ),
        );
      }
      return [
        ...prev,
        {
          id: `dbind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          fromId: sourceId,
          toId: targetId,
          sourceId,
          targetId,
          createdAt: Date.now(),
        },
      ];
    });
  };

  const effectiveWechatSessionKey = useMemo(() => {
    if (wechatSelectedSessionKey && sessions.some((s) => s.sessionKey === wechatSelectedSessionKey)) {
      return wechatSelectedSessionKey;
    }
    const activeSessionWin = openWindows.find((w) => w.kind === "session" && w.id === activeWindowId);
    if (activeSessionWin?.sessionKey) return activeSessionWin.sessionKey;
    const firstOpenSessionWin = openWindows.find((w) => w.kind === "session");
    if (firstOpenSessionWin?.sessionKey) return firstOpenSessionWin.sessionKey;
    return sessions[0]?.sessionKey ?? "";
  }, [wechatSelectedSessionKey, sessions, openWindows, activeWindowId]);

  useVisibleSessions([
    ...openWindows.filter(win => win.kind === 'session' && !isWindowMinimized(win)
      && (isSecondaryDisplay === secondaryWindowIds.includes(win.id))
      && !(wechatOpen && win.sessionKey === effectiveWechatSessionKey)).map(win => win.sessionKey),
    ...(wechatOpen && effectiveWechatSessionKey
      && sessions.some(session => session.sessionKey === effectiveWechatSessionKey)
      ? [effectiveWechatSessionKey] : []),
  ]);

  const selectWechatSession = useCallback(
    (session: SessionSummary) => {
      setWechatSelectedSessionKey(session.sessionKey);
      bringSurfaceToFront("sys:wechat");
    },
    [bringSurfaceToFront],
  );

  useEffect(() => {
    const onSessionHandoff = (event: Event) => {
      const detail = (event as CustomEvent<{ fromSessionKey: string; toSessionKey: string }>).detail;
      if (!detail?.fromSessionKey || !detail?.toSessionKey || detail.fromSessionKey === detail.toSessionKey) return;
      setWechatSelectedSessionKey((prev) =>
        prev === detail.fromSessionKey || (!prev && effectiveWechatSessionKey === detail.fromSessionKey)
          ? detail.toSessionKey
          : prev,
      );
      setWechatPinnedKeys((prev) =>
        prev.includes(detail.fromSessionKey) && !prev.includes(detail.toSessionKey)
          ? [detail.toSessionKey, ...prev]
          : prev,
      );
      const oldIconId = `session:${detail.fromSessionKey}`;
      const newIconId = `session:${detail.toSessionKey}`;
      setIconPositions((prev) => {
        const pos = prev[oldIconId];
        if (!pos || prev[newIconId]) return prev;
        const { [oldIconId]: _removed, ...rest } = prev;
        return { ...rest, [newIconId]: pos };
      });
      setPrefs((prev) => {
        const ids = prev.freeDesktopIconIds;
        if (!ids || !ids.includes(oldIconId)) return prev;
        const nextIds = [...new Set(ids.map((id) => (id === oldIconId ? newIconId : id)))];
        return { ...prev, freeDesktopIconIds: nextIds };
      });
    };
    window.addEventListener("agentopsdeck:session-handoff", onSessionHandoff);
    return () => window.removeEventListener("agentopsdeck:session-handoff", onSessionHandoff);
  }, [effectiveWechatSessionKey]);

  const popOutWechatSessionToWindow = useCallback(
    (session: SessionSummary | undefined) => {
      if (!session) return;
      const existingWin = openWindows.find(
        (w) => w.kind === "session" && w.sessionKey === session.sessionKey,
      );
      setWechatOpen(false);
      if (existingWin) {
        restoreAndFocusWindow(existingWin);
      } else {
        onOpenIcon({
          id: `session:${session.sessionKey}`,
          kind: "session",
          title: session.title || session.sessionKey,
          session,
        });
      }
    },
    [openWindows, restoreAndFocusWindow, onOpenIcon],
  );

  const openWechatMessenger = useCallback(
    (targetSessionKey?: string) => {
      setWechatOpen(true);
      bringSurfaceToFront("sys:wechat");
      const key = targetSessionKey || effectiveWechatSessionKey || sessions[0]?.sessionKey || "";
      if (key) {
        setWechatSelectedSessionKey(key);
      }
    },
    [effectiveWechatSessionKey, sessions, bringSurfaceToFront],
  );

  const handleOpenDesktopIcon = (item: DesktopIconItem) => {
    if (item.id === "app:wechat-messenger" || item.kind === "wechat-messenger") {
      openWechatMessenger();
      return;
    }
    if (item.id === "app:recycle-bin" || item.kind === "recycle-bin") {
      setRecycleBinOpen(true);
      bringSurfaceToFront("sys:recycle");
      return;
    }
    if (item.id === "app:browser" || item.kind === "browser") {
      setBrowserOpen(true);
      bringSurfaceToFront("sys:browser");
      return;
    }
    if (item.id === 'app:session-explorer') {
      setExplorerOpen(true);
      bringSurfaceToFront("sys:explorer");
      return;
    }
    if (item.id === 'app:system-settings' || item.kind === 'system-settings') {
      setSettingsOpen(true);
      bringSurfaceToFront("sys:settings");
      return;
    }
    if (item.kind === 'desktop-file' && item.resourceId) {
      const found = desktopFiles.find((f) => f.id === item.resourceId);
      if (found) {
        setEditingDesktopFile(found);
        bringSurfaceToFront("sys:file-studio");
        return;
      }
    }
    if (item.kind === "session" && item.session) {
      const existingWin = openWindows.find(
        (w) => w.kind === "session" && w.sessionKey === item.session!.sessionKey,
      );
      if (existingWin) {
        restoreAndFocusWindow(existingWin);
        return;
      }
    }
    onOpenIcon(item);
    bringSurfaceToFront(item.id);
  };

  const selectBuiltInWallpaper = (theme: DesktopWallpaperTheme) => {
    setWallpaper(theme);
    setWallpaperConfig((prev) => ({
      ...prev,
      theme,
    }));
  };

  const cycleWallpaper = () => {
    setWallpaper((prev) => {
      const idx = WALLPAPER_THEMES.indexOf(prev);
      const next = WALLPAPER_THEMES[(idx + 1) % WALLPAPER_THEMES.length] ?? 'aurora';
      setWallpaperConfig((cfg) => ({ ...cfg, theme: next }));
      return next;
    });
  };

  const setSortBy = (sortBy: DesktopSortBy) => {
    setPrefs((prev) => ({ ...prev, sortBy }));
    // Clear manual positions when user explicitly sorts icons
    setIconPositions({});
  };

  const runningCount = useMemo(
    () => sessions.filter((s) => s.status === 'running' || s.hasActiveRun).length,
    [sessions],
  );

  const explorerItems = useMemo(() => {
    const q = explorerSearch.trim().toLowerCase();
    return icons.filter((item) => {
      if (explorerTab === 'running' && !item.running) return false;
      if (explorerTab === 'notebooks' && item.kind !== 'notebook') return false;
      if (explorerTab === 'apps' && item.kind === 'session') return false;
      if (
        q &&
        !item.title.toLowerCase().includes(q) &&
        !(item.subtitle ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [icons, explorerTab, explorerSearch]);

  const selectedExplorerItem = useMemo(
    () =>
      explorerItems.find((item) => item.id === explorerSelectedId) ??
      explorerItems[0],
    [explorerItems, explorerSelectedId],
  );

  const openSessionKeySet = useMemo(
    () => new Set(openWindows.map((w) => w.sessionKey)),
    [openWindows],
  );
  const openKindSet = useMemo(
    () => new Set(openWindows.map((w) => w.kind)),
    [openWindows],
  );
  const zIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    zOrder.forEach((id, idx) => map.set(id, idx));
    return map;
  }, [zOrder]);

  const topSurfaceId = zOrder.length > 0 ? zOrder[zOrder.length - 1] : activeWindowId;
  const getSurfaceZIndex = (surfaceId: string, isMaximized = false, fallbackIdx = 0) => {
    const isTop = topSurfaceId === surfaceId;
    if (isMaximized) return isTop ? 220 : 205;
    if (isTop) return 212;
    const zIdx = zIndexMap.get(surfaceId);
    return 140 + (zIdx !== undefined ? zIdx : fallbackIdx);
  };

  const snapPreviewGeo = useMemo(
    () =>
      snapPreviewZone
        ? computeSnapWindowGeometry(snapPreviewZone, surfaceWidth, surfaceHeight)
        : undefined,
    [snapPreviewZone, surfaceWidth, surfaceHeight],
  );

  const taskbarMetrics = useMemo(
    () => computeTaskbarMetrics(prefs.taskbarHeight ?? 48),
    [prefs.taskbarHeight],
  );

  useContextMenuPosition(Boolean(contextMenu), contextMenu, osDesktopMenuRef, {
    bottomInset: taskbarMetrics.taskbarHeight + 6,
    autoFocus: true,
  });
  useContextMenuPosition(Boolean(wechatContextMenu && wechatOpen), wechatContextMenu, osWechatMenuRef, {
    bottomInset: taskbarMetrics.taskbarHeight + 6,
    autoFocus: true,
  });

  useEffect(() => {
    if (!wechatOpen && wechatContextMenu) {
      setWechatContextMenu(null);
    }
  }, [wechatOpen, wechatContextMenu]);

  useEffect(() => {
    if (!contextMenu && !wechatContextMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (osDesktopMenuRef.current?.contains(target) || osWechatMenuRef.current?.contains(target))) {
        return;
      }
      setContextMenu(null);
      setWechatContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setWechatContextMenu(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu, wechatContextMenu]);

  // Sample custom image wallpaper into a 32x32 RGB grid so desktop icons & Fences compute real local contrast
  const [customWallpaperGrid, setCustomWallpaperGrid] = useState<DesktopWallpaperImageGrid | null>(null);
  useEffect(() => {
    const imgUrl = wallpaper === 'custom' ? wallpaperConfig.customImageUrl : undefined;
    if (!imgUrl || typeof document === 'undefined' || typeof Image === 'undefined') {
      setCustomWallpaperGrid(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const gridW = 32;
        const gridH = 32;
        const canvas = document.createElement('canvas');
        canvas.width = gridW;
        canvas.height = gridH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, gridW, gridH);
        const imageData = ctx.getImageData(0, 0, gridW, gridH).data;
        const rgb: number[] = new Array(gridW * gridH * 3);
        for (let i = 0, j = 0; i < imageData.length; i += 4, j += 3) {
          rgb[j] = imageData[i] ?? 15;
          rgb[j + 1] = imageData[i + 1] ?? 23;
          rgb[j + 2] = imageData[i + 2] ?? 42;
        }
        setCustomWallpaperGrid({ width: gridW, height: gridH, data: rgb });
      } catch {
        setCustomWallpaperGrid(null);
      }
    };
    img.onerror = () => {
      if (!cancelled) setCustomWallpaperGrid(null);
    };
    img.src = imgUrl;
    return () => {
      cancelled = true;
    };
  }, [wallpaper, wallpaperConfig.customImageUrl]);

  const getPointTextStyle = useCallback(
    (x: number, y: number, surfaceContext: 'desktop' | 'fence' | 'fence-header' = 'desktop') =>
      computeDesktopPointTextStyle({
        x,
        y,
        surfaceWidth,
        surfaceHeight,
        wallpaper,
        wallpaperConfig,
        colorMode,
        surfaceContext,
        imageGrid: customWallpaperGrid,
      }),
    [surfaceWidth, surfaceHeight, wallpaper, wallpaperConfig, colorMode, customWallpaperGrid],
  );

  const buildPointTextVars = useCallback(
    (x: number, y: number, surfaceContext: 'desktop' | 'fence' | 'fence-header' = 'desktop') => {
      const pt = getPointTextStyle(x, y, surfaceContext);
      return {
        tone: pt.tone,
        vars: {
          '--os-local-text-color': pt.textColor,
          '--os-local-sub-color': pt.subColor,
          '--os-local-text-shadow': pt.textShadow,
          '--os-local-pill-bg': pt.pillBg,
        } as CSSProperties,
      };
    },
    [getPointTextStyle],
  );

  const unreadNotificationCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const openSessionFromNotification = (sessionKey?: string) => {
    if (!sessionKey) return;
    const existingWin = openWindows.find(
      (w) => w.kind === "session" && w.sessionKey === sessionKey,
    );
    if (existingWin) {
      restoreAndFocusWindow(existingWin);
      return;
    }
    const matchingIcon = icons.find((ic) => ic.kind === "session" && ic.session?.sessionKey === sessionKey);
    if (matchingIcon) {
      handleOpenDesktopIcon(matchingIcon);
      return;
    }
    const matchingSession = sessions.find((s) => s.sessionKey === sessionKey);
    onOpenIcon({
      id: `session:${sessionKey}`,
      kind: "session",
      title: matchingSession?.title || sessionKey,
      ...(matchingSession ? { session: matchingSession } : {}),
    });
  };

  return (
    <div
      ref={shellRef}
      className={`os-desktop-shell wallpaper-${wallpaper} color-mode-${colorMode} icon-size-${prefs.iconSize} power-stage-${powerPhase}${isRefreshingDesktop ? " is-refreshing-desktop" : ""}`}
      data-testid="workspace-os-desktop"
      data-color-mode={colorMode}
      data-power-stage={powerPhase}
      style={
        {
          "--os-taskbar-height": `${taskbarMetrics.taskbarHeight}px`,
          "--os-taskbar-scale": String(taskbarMetrics.scale),
          "--os-taskbar-btn-height": `${taskbarMetrics.buttonHeight}px`,
          "--os-taskbar-icon-size": `${taskbarMetrics.iconSize}px`,
          "--os-taskbar-start-icon-size": `${taskbarMetrics.startIconSize}px`,
          "--os-taskbar-font-size": `${taskbarMetrics.fontSizePx}px`,
          "--os-taskbar-badge-font-size": `${taskbarMetrics.badgeFontSizePx}px`,
          "--os-taskbar-pill-max-width": `${taskbarMetrics.pillMaxWidthPx}px`,
        } as CSSProperties
      }
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          attachFilesToDesktopFile(e.dataTransfer.files);
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        const isInteractiveWindowOrChrome = Boolean(
          target.closest(
            '[data-desktop-icon], [data-os-window], .os-desktop-fence-header, .os-desktop-fence-resize-handle, .os-desktop-taskbar, .os-desktop-start-menu, .os-desktop-tray-flyout, .os-desktop-notification-center, .os-desktop-toast-stack, .os-power-overlay, .os-desktop-task-view-overlay, .os-desktop-context-menu, .os-desktop-link-mode-banner, button, input, textarea, select, a',
          ),
        );
        if (isInteractiveWindowOrChrome) return;
        const shellEl = shellRef.current;
        if (!shellEl) return;
        const shellBounds = shellEl.getBoundingClientRect();
        const startX = e.clientX - shellBounds.left;
        const startY = e.clientY - shellBounds.top;
        const iconEls = Array.from(shellEl.querySelectorAll<HTMLElement>('[data-desktop-icon]'));
        const itemRects = iconEls.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.getAttribute('data-desktop-icon') || '',
            x: r.left - shellBounds.left,
            y: r.top - shellBounds.top,
            width: r.width,
            height: r.height,
          };
        }).filter((r) => r.id.length > 0);
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;
        if (!additive) {
          setSelectedIconId(undefined);
          setSelectedIconIds(new Set());
        }
        setStartMenuOpen(false);
        setTrayFlyoutOpen(false);
        setNotificationCenterOpen(false);
        setSnapLayoutMenuFor(undefined);
        if (contextMenu) setContextMenu(null);
        if (wechatContextMenu) setWechatContextMenu(null);
        marqueeDragRef.current = {
          pointerId: e.pointerId,
          startX,
          startY,
          additive,
          baseSelected: additive ? new Set(selectedIconIds) : new Set(),
          itemRects,
        };
        try {
          shellEl.setPointerCapture(e.pointerId);
        } catch {
          // Ignore synthetic pointer capture error
        }
      }}
      onPointerMove={(e) => {
        const m = marqueeDragRef.current;
        if (!m || m.pointerId !== e.pointerId) return;
        const shellEl = shellRef.current;
        if (!shellEl) return;
        const shellBounds = shellEl.getBoundingClientRect();
        const curX = e.clientX - shellBounds.left;
        const curY = e.clientY - shellBounds.top;
        const res = computeMarqueeSelection(
          { x: m.startX, y: m.startY },
          { x: curX, y: curY },
          m.itemRects,
        );
        if (res.rect.width >= 4 || res.rect.height >= 4) {
          setMarquee(res.rect);
          const nextSet = new Set(m.baseSelected);
          for (const id of res.selectedIds) nextSet.add(id);
          setSelectedIconIds(nextSet);
          setSelectedIconId(res.selectedIds[0]);
        }
      }}
      onPointerUp={(e) => {
        if (marqueeDragRef.current?.pointerId === e.pointerId) {
          marqueeDragRef.current = null;
          setMarquee(null);
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setStartMenuOpen(false);
          setTrayFlyoutOpen(false);
          setNotificationCenterOpen(false);
          setSnapLayoutMenuFor(undefined);
        }
        if (contextMenu) setContextMenu(null);
        if (wechatContextMenu) setWechatContextMenu(null);
      }}
      onContextMenu={(e) => {
        const target = e.target as HTMLElement;
        // Let right-clicks inside open windows, modals, taskbar, start menu, or editable inputs pass through
        if (
          target.closest(
            '[data-os-window], .os-desktop-taskbar, .os-desktop-start-menu, .os-desktop-tray-flyout, .os-desktop-notification-center, .os-desktop-toast-stack, .os-power-overlay, .os-desktop-task-view-overlay, .os-desktop-context-menu, input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )
        ) {
          return;
        }
        const iconBtn = target.closest<HTMLElement>('[data-desktop-icon]');
        const iconId = iconBtn?.getAttribute('data-desktop-icon');
        const foundIcon = iconId ? icons.find((ic) => ic.id === iconId) : undefined;
        e.preventDefault();
        e.stopPropagation();
        if (foundIcon) {
          setSelectedIconId(foundIcon.id);
          setSelectedIconIds((prev) => (prev.has(foundIcon.id) ? prev : new Set([foundIcon.id])));
        }
        if (wechatContextMenu) setWechatContextMenu(null);
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          targetIcon: foundIcon,
        });
      }}
    >
      {/* Custom Wallpaper Background Layer */}
      {wallpaper === 'custom' && (wallpaperConfig.customImageUrl || wallpaperConfig.customGradient) ? (
        <div
          className="os-desktop-custom-wallpaper"
          data-testid="os-desktop-custom-wallpaper"
          style={{
            backgroundImage: wallpaperConfig.customImageUrl
              ? `url("${wallpaperConfig.customImageUrl}")`
              : wallpaperConfig.customGradient,
            backgroundSize:
              wallpaperConfig.fit === 'contain'
                ? 'contain'
                : wallpaperConfig.fit === 'fill'
                  ? '100% 100%'
                  : 'cover',
            backgroundPosition: 'center center',
            backgroundRepeat: 'no-repeat',
            filter: wallpaperConfig.blurPx ? `blur(${wallpaperConfig.blurPx}px)` : undefined,
          }}
        >
          <div
            className="os-desktop-custom-wallpaper-dim"
            style={{
              background: `rgba(4, 9, 18, ${(wallpaperConfig.dimOpacity ?? 24) / 100})`,
            }}
          />
        </div>
      ) : null}

      {/* Interactive Link-Connect Mode Hint Banner */}
      {linkConnectMode ? (
        <div className="os-desktop-link-mode-banner" data-testid="os-desktop-link-banner">
          <Link2 size={14} />
          <span>
            {pendingLinkSourceId
              ? `${t('Select target item to link with')} ${icons.find((i) => i.id === pendingLinkSourceId)?.title ?? pendingLinkSourceId}`
              : t('Link Mode active: Click any desktop icon or card to start a connection line')}
          </span>
          {pendingLinkSourceId ? (
            <button type="button" onClick={() => setPendingLinkSourceId(null)}>
              {t('Reset source')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setLinkConnectMode(false);
              setPendingLinkSourceId(null);
            }}
          >
            {t('Done')}
          </button>
        </div>
      ) : null}

      {/* Desktop Shortcut Grid & Stardock Fences Zones */}
      {prefs.showDesktopIcons && prefs.fencesEnabled !== false ? (
          <div
            className="os-desktop-fences-board"
            data-testid="os-desktop-fences-board"
            role="region"
            aria-label={t('Desktop Fences')}
          >
            {fenceGroups.map((fence) => {
              const isCollapsed = collapsedFenceSet.has(fence.id);
              const visibleFenceItems = fence.items.filter(
                (item) => !freeDesktopIconIdSet.has(item.id) && !iconPositions[item.id],
              );
              const unreadInFence = visibleFenceItems.filter((i) => i.unread).length;
              const runningInFence = visibleFenceItems.filter((i) => i.running).length;
              const defaults = computeDefaultFenceGeometries(surfaceWidth, surfaceHeight);
              const rect = fenceRects[fence.id] ?? defaults[fence.id];
              const headerPoint = buildPointTextVars(
                rect.x + rect.width * 0.35,
                rect.y + 18,
                'fence-header',
              );
              const fenceCols = Math.max(1, Math.floor((rect.width - 20) / 94));
              return (
                <section
                  key={fence.id}
                  data-fence-id={fence.id}
                  className={`os-desktop-fence is-freeform fence-${fence.id}${isCollapsed ? ' is-collapsed' : ''}`}
                  style={{
                    left: rect.x,
                    top: rect.y,
                    width: rect.width,
                    height: isCollapsed ? 'auto' : rect.height,
                    zIndex: Math.min(9, Math.max(1, rect.zIndex ?? 2)),
                  }}
                  onPointerDownCapture={() => {
                    setFenceRects((prev) => {
                      const ordered: Array<keyof typeof prev> = ['sessions', 'knowledge', 'tools-files'];
                      const others = ordered.filter((id) => id !== fence.id);
                      const cur = prev[fence.id] ?? rect;
                      if ((cur.zIndex ?? 1) === 3) return prev;
                      const next = { ...prev };
                      others.forEach((id, idx) => {
                        const r = prev[id] ?? defaults[id];
                        if (r) next[id] = { ...r, zIndex: idx + 1 };
                      });
                      next[fence.id] = { ...cur, zIndex: 3 };
                      return next;
                    });
                  }}
                >
                  <header
                    className="os-desktop-fence-header"
                    data-local-tone={headerPoint.tone}
                    style={headerPoint.vars}
                    onDoubleClick={() => toggleFenceCollapsed(fence.id)}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      if ((e.target as HTMLElement).closest('button')) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      fenceDragRef.current = {
                        fenceId: fence.id,
                        pointerId: e.pointerId,
                        startX: e.clientX,
                        startY: e.clientY,
                        origX: rect.x,
                        origY: rect.y,
                        moved: false,
                      };
                    }}
                    onPointerMove={(e) => {
                      const d = fenceDragRef.current;
                      if (!d || d.fenceId !== fence.id || d.pointerId !== e.pointerId) return;
                      const dx = e.clientX - d.startX;
                      const dy = e.clientY - d.startY;
                      if (!d.moved && Math.hypot(dx, dy) < 4) return;
                      d.moved = true;
                      const nx = Math.max(4, Math.min(surfaceWidth - 160, d.origX + dx));
                      const ny = Math.max(0, Math.min(surfaceHeight - 96, d.origY + dy));
                      setFenceRects((prev) => ({
                        ...prev,
                        [fence.id]: {
                          ...(prev[fence.id] ?? rect),
                          x: Math.round(nx),
                          y: Math.round(ny),
                        },
                      }));
                    }}
                    onPointerUp={(e) => {
                      if (fenceDragRef.current?.pointerId === e.pointerId) {
                        fenceDragRef.current = null;
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="os-desktop-fence-title-btn"
                      onClick={() => toggleFenceCollapsed(fence.id)}
                      title={t('Click or double-click header to roll up Fence')}
                    >
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <strong>{t(fence.titleKey)}</strong>
                      <span className="os-desktop-fence-count">{visibleFenceItems.length}</span>
                    </button>
                    <div className="os-desktop-fence-badges">
                      {runningInFence > 0 ? (
                        <span className="os-fence-pill is-running">
                          {runningInFence} {t('running')}
                        </span>
                      ) : null}
                      {unreadInFence > 0 ? (
                        <span className="os-fence-pill is-unread">
                          {unreadInFence} {t('Updated')}
                        </span>
                      ) : null}
                    </div>
                  </header>
                  {!isCollapsed ? (
                    <div className="os-desktop-fence-grid" role="list">
                      {visibleFenceItems.map((item, itemIdx) => {
                        const isSelected =
                          selectedIconId === item.id || selectedIconIds.has(item.id);
                        const isOpen = item.session
                          ? openSessionKeySet.has(item.session.sessionKey)
                          : openKindSet.has(item.kind);
                        const col = itemIdx % fenceCols;
                        const row = Math.floor(itemIdx / fenceCols);
                        const itemPoint = buildPointTextVars(
                          rect.x + 14 + col * 94 + 42,
                          rect.y + 42 + row * 92 + 56,
                          'fence',
                        );
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="listitem"
                            data-desktop-icon={item.id}
                            data-kind={item.kind}
                            data-variant={item.variant ?? 'default'}
                            data-unread={item.unread ? 'true' : undefined}
                            data-local-tone={itemPoint.tone}
                            style={itemPoint.vars}
                            className={`os-desktop-shortcut variant-${item.variant ?? 'default'}${isSelected ? ' is-selected' : ''}${item.running ? ' is-running' : ''}${item.unread ? ' is-unread' : ''}`}
                            onClick={(e) => {
                              if (linkConnectMode) {
                                e.stopPropagation();
                                if (!pendingLinkSourceId) {
                                  setPendingLinkSourceId(item.id);
                                } else if (pendingLinkSourceId === item.id) {
                                  setPendingLinkSourceId(null);
                                } else {
                                  toggleDesktopBindingLink(pendingLinkSourceId, item.id);
                                  setPendingLinkSourceId(null);
                                }
                                return;
                              }
                              if (e.ctrlKey || e.metaKey || e.shiftKey) {
                                setSelectedIconIds((prev) => {
                                  const next = new Set(prev);
                                  if (selectedIconId) next.add(selectedIconId);
                                  if (next.has(item.id)) next.delete(item.id);
                                  else next.add(item.id);
                                  return next;
                                });
                                setSelectedIconId(item.id);
                              } else {
                                setSelectedIconId(item.id);
                                setSelectedIconIds(new Set([item.id]));
                              }
                            }}
                            onDoubleClick={() => {
                              setSelectedIconId(item.id);
                              setSelectedIconIds(new Set([item.id]));
                              handleOpenDesktopIcon(item);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedIconId(item.id);
                              setSelectedIconIds((prev) => (prev.has(item.id) ? prev : new Set([item.id])));
                              if (wechatContextMenu) setWechatContextMenu(null);
                              setContextMenu({
                                x: e.clientX,
                                y: e.clientY,
                                targetIcon: item,
                              });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (selectedIconIds.size > 1 && selectedIconIds.has(item.id)) {
                                  icons
                                    .filter((ic) => selectedIconIds.has(ic.id))
                                    .forEach((ic) => handleOpenDesktopIcon(ic));
                                } else {
                                  setSelectedIconId(item.id);
                                  handleOpenDesktopIcon(item);
                                }
                              }
                            }}
                          >
                            <div
                              className={`os-desktop-shortcut-icon kind-${item.kind} variant-${item.variant ?? 'default'}${item.unread ? ' is-unread' : ''}${item.running ? ' is-running' : ''}`}
                            >
                              {renderIconGlyph(
                                item.kind,
                                item.running,
                                prefs.iconSize === 'sm' ? 18 : prefs.iconSize === 'lg' ? 26 : 22,
                                item.variant,
                              )}
                              {item.running ? (
                                <span className="os-shortcut-status-dot is-running" />
                              ) : null}
                              {!item.running && item.unread ? (
                                <span className="os-shortcut-status-dot is-unread" />
                              ) : null}
                            </div>
                            <span className="os-desktop-shortcut-title">{item.title}</span>
                            {item.subtitle ? (
                              <small className="os-desktop-shortcut-sub">{item.subtitle}</small>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {!isCollapsed
                    ? render8WayResizeHandles(
                        `fence:${fence.id}`,
                        rect,
                        (next) =>
                          setFenceRects((prev) => ({
                            ...prev,
                            [fence.id]: {
                              ...(prev[fence.id] ?? rect),
                              x: next.x,
                              y: next.y,
                              width: next.width,
                              height: next.height,
                            },
                          })),
                        { minW: 220, minH: 150 },
                        `os-fence-resize-${fence.id}`,
                      )
                    : null}
                </section>
              );
            })}
          </div>
        ) : null}
      {prefs.showDesktopIcons ? (
        <div
          className={`os-desktop-icon-grid${prefs.fencesEnabled !== false ? ' is-coexisting' : ''}`}
          data-testid="os-desktop-free-icon-grid"
          role="list"
          aria-label={t('Desktop shortcuts')}
        >
          {(() => {
            const freeIcons =
              prefs.fencesEnabled === false
                ? icons
                : icons.filter(
                    (item) =>
                      freeDesktopIconIdSet.has(item.id) ||
                      Boolean(iconPositions[item.id]) ||
                      item.kind === 'desktop-file' ||
                      item.kind === 'recycle-bin' ||
                      item.id === 'app:wechat-messenger' ||
                      item.id === 'app:session-explorer' ||
                      item.id === 'app:browser',
                  );
            const resolvedSlots = resolveNonOverlappingIconLayout({
              icons: freeIcons,
              iconPositions,
              surfaceWidth,
              surfaceHeight,
              taskbarHeight: taskbarMetrics.taskbarHeight,
            });
            return freeIcons.map((item, freeIdx) => {
              const isSelected = selectedIconId === item.id || selectedIconIds.has(item.id);
              const slot = resolvedSlots[item.id];
              const resolvedX = slot ? slot.x : 12 + Math.floor(freeIdx / 6) * 98;
              const resolvedY = slot ? slot.y : 10 + (freeIdx % 6) * 102;
              const isOpen = item.session
                ? openSessionKeySet.has(item.session.sessionKey)
                : openKindSet.has(item.kind);
              const sampleX = resolvedX + 46;
              const sampleY = resolvedY + 58;
              const freePoint = buildPointTextVars(sampleX, sampleY, 'desktop');
              return (
                <button
                  key={item.id}
                  type="button"
                  role="listitem"
                  data-desktop-icon={item.id}
                  data-kind={item.kind}
                  data-variant={item.variant ?? 'default'}
                  data-unread={item.unread ? 'true' : undefined}
                  data-local-tone={freePoint.tone}
                  style={{
                    ...freePoint.vars,
                    position: 'absolute',
                    left: resolvedX,
                    top: resolvedY,
                    zIndex: isSelected ? 6 : 3,
                  }}
                  className={`os-desktop-shortcut variant-${item.variant ?? 'default'}${isSelected ? ' is-selected' : ''}${item.running ? ' is-running' : ''}${item.unread ? ' is-unread' : ''}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const parentRect = e.currentTarget.offsetParent?.getBoundingClientRect();
                    const origX = slot?.x ?? (parentRect ? rect.left - parentRect.left : 12);
                    const origY = slot?.y ?? (parentRect ? rect.top - parentRect.top : 10);
                    iconDragRef.current = {
                      id: item.id,
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      startY: e.clientY,
                      origX,
                      origY,
                      lastX: origX,
                      lastY: origY,
                      moved: false,
                      el: e.currentTarget,
                    };
                  }}
                  onPointerMove={(e) => {
                    const d = iconDragRef.current;
                    if (!d || d.id !== item.id || d.pointerId !== e.pointerId) return;
                    const dx = e.clientX - d.startX;
                    const dy = e.clientY - d.startY;
                    if (!d.moved && Math.hypot(dx, dy) < 8) return;
                    if (!d.moved) {
                      d.moved = true;
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }
                    const nx =
                      Math.round(Math.max(4, Math.min(surfaceWidth - 92, d.origX + dx)) / 8) * 8;
                    const ny =
                      Math.round(Math.max(0, Math.min(surfaceHeight - 104, d.origY + dy)) / 8) * 8;
                    d.lastX = nx;
                    d.lastY = ny;
                    if (d.el) {
                      const livePt = getPointTextStyle(nx + 46, ny + 58, 'desktop');
                      d.el.style.position = "absolute";
                      d.el.style.left = `${nx}px`;
                      d.el.style.top = `${ny}px`;
                      d.el.style.zIndex = "8";
                      d.el.style.setProperty('--os-local-text-color', livePt.textColor);
                      d.el.style.setProperty('--os-local-sub-color', livePt.subColor);
                      d.el.style.setProperty('--os-local-text-shadow', livePt.textShadow);
                      d.el.style.setProperty('--os-local-pill-bg', livePt.pillBg);
                      d.el.setAttribute('data-local-tone', livePt.tone);
                    }
                  }}
                  onPointerUp={(e) => {
                    const d = iconDragRef.current;
                    if (d && d.pointerId === e.pointerId) {
                      const wasMoved = d.moved;
                      const finalX = d.lastX;
                      const finalY = d.lastY;
                      iconDragRef.current = null;
                      if (wasMoved) {
                        setIconPositions((prev) => ({
                          ...prev,
                          [item.id]: { x: finalX, y: finalY },
                        }));
                        return;
                      }
                    }
                  }}
                  onClick={(e) => {
                    if (iconDragRef.current?.moved) return;
                    if (linkConnectMode) {
                      e.stopPropagation();
                      if (!pendingLinkSourceId) {
                        setPendingLinkSourceId(item.id);
                      } else if (pendingLinkSourceId === item.id) {
                        setPendingLinkSourceId(null);
                      } else {
                        toggleDesktopBindingLink(pendingLinkSourceId, item.id);
                        setPendingLinkSourceId(null);
                      }
                      return;
                    }
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                      setSelectedIconIds((prev) => {
                        const next = new Set(prev);
                        if (selectedIconId) next.add(selectedIconId);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      });
                      setSelectedIconId(item.id);
                    } else {
                      setSelectedIconId(item.id);
                      setSelectedIconIds(new Set([item.id]));
                    }
                  }}
                  onDoubleClick={() => {
                    setSelectedIconId(item.id);
                    setSelectedIconIds(new Set([item.id]));
                    handleOpenDesktopIcon(item);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedIconId(item.id);
                    setSelectedIconIds((prev) => (prev.has(item.id) ? prev : new Set([item.id])));
                    if (wechatContextMenu) setWechatContextMenu(null);
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      targetIcon: item,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (selectedIconIds.size > 1 && selectedIconIds.has(item.id)) {
                        icons
                          .filter((ic) => selectedIconIds.has(ic.id))
                          .forEach((ic) => handleOpenDesktopIcon(ic));
                      } else {
                        setSelectedIconId(item.id);
                        handleOpenDesktopIcon(item);
                      }
                    }
                  }}
                >
                  <div
                    className={`os-desktop-shortcut-icon kind-${item.kind} variant-${item.variant ?? 'default'}${item.unread ? ' is-unread' : ''}${item.running ? ' is-running' : ''}`}
                  >
                    {renderIconGlyph(
                      item.kind,
                      item.running,
                      prefs.iconSize === 'sm' ? 18 : prefs.iconSize === 'lg' ? 26 : 22,
                      item.variant,
                    )}
                    {item.running ? <span className="os-shortcut-status-dot is-running" /> : null}
                    {!item.running && item.unread ? (
                      <span className="os-shortcut-status-dot is-unread" />
                    ) : null}
                  </div>
                  <span className="os-desktop-shortcut-title">{item.title}</span>
                  {item.subtitle ? (
                    <small className="os-desktop-shortcut-sub">{item.subtitle}</small>
                  ) : null}
                </button>
              );
            });
          })()}
        </div>
      ) : null}

      {/* Aero Snap Preview Ghost Overlay during Window Drag */}
      {snapPreviewGeo ? (
        <div
          className="os-window-snap-preview"
          data-snap-zone={snapPreviewZone}
          style={{
            left: snapPreviewGeo.x,
            top: snapPreviewGeo.y,
            width: snapPreviewGeo.width,
            height: snapPreviewGeo.height,
          }}
        >
          <span>{t('Release to snap window')}</span>
        </div>
      ) : null}

      {/* Rubber-band Marquee Selection Box */}
      {marquee ? (
        <div
          className="os-desktop-marquee-box"
          data-testid="os-desktop-marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      ) : null}

      {/* Built-in Draggable, Resizable, Multi-Format Desktop File Studio Window */}
      {editingDesktopFile ? (
        <div
          className={`os-desktop-file-modal os-desktop-file-window${fileWindowRect.maximized ? ' is-maximized' : ''}${topSurfaceId === 'sys:file-studio' ? ' is-active' : ''}`}
          data-os-window="sys:file-studio"
          data-testid="os-desktop-file-window"
          role="dialog"
          aria-label={editingDesktopFile.name}
          style={
            fileWindowRect.maximized
              ? {
                  left: 0,
                  top: 0,
                  width: surfaceWidth,
                  height: Math.max(320, surfaceHeight - taskbarMetrics.taskbarHeight),
                  zIndex: getSurfaceZIndex("sys:file-studio", true),
                }
              : {
                  left: fileWindowRect.x,
                  top: fileWindowRect.y,
                  width: fileWindowRect.width,
                  height: fileWindowRect.height,
                  zIndex: getSurfaceZIndex("sys:file-studio", false),
                }
          }
          onPointerDownCapture={() => bringSurfaceToFront("sys:file-studio")}
          onFocusCapture={() => bringSurfaceToFront("sys:file-studio")}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              attachFilesToDesktopFile(e.dataTransfer.files);
            }
          }}
        >
          <header
            className="os-window-titlebar"
            onDoubleClick={() =>
              setFileWindowRect((prev) => ({ ...prev, maximized: !prev.maximized }))
            }
            onPointerDown={(e) => {
              if (fileWindowRect.maximized) return;
              if ((e.target as HTMLElement).closest('button, input')) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              fileWinDragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: fileWindowRect.x,
                origY: fileWindowRect.y,
              };
            }}
            onPointerMove={(e) => {
              const d = fileWinDragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const nx = Math.max(8, Math.min(surfaceWidth - 220, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(4, Math.min(surfaceHeight - 110, d.origY + (e.clientY - d.startY)));
              setFileWindowRect((prev) => ({ ...prev, x: nx, y: ny }));
            }}
            onPointerUp={(e) => {
              if (fileWinDragRef.current?.pointerId === e.pointerId) {
                fileWinDragRef.current = null;
              }
            }}
          >
            <div className="os-window-title">
              <FileText size={14} />
              <span className="os-file-type-badge">{(editingDesktopFile.fileType ?? 'markdown').toUpperCase()}</span>
              <input
                name="os-desktop-file-name"
                type="text"
                className="os-desktop-file-title-input"
                value={editingDesktopFile.name}
                aria-label={t('File name')}
                onChange={(e) =>
                  setEditingDesktopFile((prev) =>
                    prev ? { ...prev, name: e.target.value, updatedAt: Date.now() } : null,
                  )
                }
              />
            </div>
            <div className="os-desktop-file-toolbar">
              {(['edit', 'split', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`os-file-mode-btn${fileViewMode === m ? ' is-active' : ''}`}
                  onClick={() => setFileViewMode(m)}
                >
                  {m === 'edit' ? t('Edit') : m === 'split' ? t('Split') : t('Preview')}
                </button>
              ))}
              <button
                type="button"
                className="os-file-mode-btn"
                title={t('Attach image or file')}
                onClick={() => fileUploadInputRef.current?.click()}
              >
                <ImageIcon size={12} />
                <span>{t('Add Image / File')}</span>
              </button>
              <input
                ref={fileUploadInputRef}
                name="os-desktop-file-upload"
                type="file"
                multiple
                accept="image/*,text/*,.md,.json,.csv,.svg,.log"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    attachFilesToDesktopFile(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
            </div>
            <div className="os-window-controls">
              <button
                type="button"
                title={t('Download')}
                onClick={() => {
                  if (!editingDesktopFile) return;
                  const blob = new Blob([editingDesktopFile.content], { type: 'text/markdown;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = editingDesktopFile.name || 'DesktopFile.md';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <Download size={13} />
              </button>
              <button
                type="button"
                title={t(fileWindowRect.maximized ? 'Restore pane' : 'Maximize pane')}
                onClick={() =>
                  setFileWindowRect((prev) => ({ ...prev, maximized: !prev.maximized }))
                }
              >
                {fileWindowRect.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                title={t('Move to Recycle Bin')}
                onClick={() => {
                  if (!editingDesktopFile) return;
                  const targetIcon = icons.find((ic) => ic.resourceId === editingDesktopFile.id);
                  if (targetIcon) {
                    moveIconToRecycleBin(targetIcon);
                  } else {
                    setRecycleItems((prev) => [
                      {
                        id: `desktop-file:${editingDesktopFile.id}`,
                        title: editingDesktopFile.name,
                        subtitle: editingDesktopFile.fileType,
                        kind: 'desktop-file',
                        resourceId: editingDesktopFile.id,
                        deletedAt: Date.now(),
                        fileSnapshot: editingDesktopFile,
                      },
                      ...prev,
                    ]);
                    setEditingDesktopFile(null);
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                className="os-win-close-btn"
                aria-label={t('Close')}
                title={t('Close')}
                onClick={() => setEditingDesktopFile(null)}
              >
                <X size={13} />
              </button>
            </div>
          </header>

          <div className={`os-desktop-file-body mode-${fileViewMode}`}>
            {fileViewMode !== 'preview' ? (
              <textarea
                name="os-desktop-file-content"
                className="os-desktop-file-textarea"
                value={editingDesktopFile.content}
                placeholder={t('Write Markdown, text, or paste images directly (Ctrl+V)…')}
                onChange={(e) =>
                  setEditingDesktopFile((prev) =>
                    prev ? { ...prev, content: e.target.value, updatedAt: Date.now() } : null,
                  )
                }
                onPaste={(e) => {
                  const files = e.clipboardData?.files;
                  if (files && files.length > 0) {
                    e.preventDefault();
                    attachFilesToDesktopFile(files);
                  }
                }}
              />
            ) : null}
            {fileViewMode !== 'edit' ? (
              <div className="os-desktop-file-preview">
                <NotebookMarkdown text={editingDesktopFile.content || '*Empty file*'} disabled={false} onChange={(nextText) => setEditingDesktopFile((prev) => prev ? { ...prev, content: nextText, updatedAt: Date.now() } : null)} />
                {editingDesktopFile.attachments && editingDesktopFile.attachments.length > 0 ? (
                  <div className="os-desktop-file-attachments">
                    <div className="os-desktop-file-attachments-header">
                      <ImageIcon size={13} />
                      <strong>
                        {t('Attachments & Images')} ({editingDesktopFile.attachments.length})
                      </strong>
                    </div>
                    <div className="os-desktop-file-attachment-grid">
                      {editingDesktopFile.attachments.map((att) => (
                        <figure key={att.id} className="os-desktop-attachment-card">
                          {att.mimeType.startsWith('image/') ? (
                            <img src={att.dataUrl} alt={att.name} loading="lazy" />
                          ) : (
                            <div className="os-desktop-attachment-placeholder">
                              <FileText size={24} />
                            </div>
                          )}
                          <figcaption>
                            <span title={att.name}>{att.name}</span>
                            <div className="os-desktop-attachment-actions">
                              <a href={att.dataUrl} download={att.name} title={t('Download')}>
                                <Upload size={11} />
                              </a>
                              <button
                                type="button"
                                title={t('Remove')}
                                onClick={() =>
                                  setEditingDesktopFile((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          attachments: (prev.attachments ?? []).filter(
                                            (a) => a.id !== att.id,
                                          ),
                                          updatedAt: Date.now(),
                                        }
                                      : null,
                                  )
                                }
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <footer className="os-desktop-file-footer">
            <small>
              {`${t('Auto-saved to OS Desktop')} · ${editingDesktopFile.content.length} ${t('chars')}`}
              {editingDesktopFile.attachments?.length
                ? ` · ${editingDesktopFile.attachments.length} ${t('attachments')}`
                : ''}
            </small>
            <div className="os-desktop-file-footer-actions">
              <button
                type="button"
                className="os-desktop-pill-btn"
                onClick={() => fileUploadInputRef.current?.click()}
              >
                <ImageIcon size={12} />
                <span>{t('Add Image / File')}</span>
              </button>
              <button
                type="button"
                className="os-desktop-pill-btn is-accent"
                onClick={() => setEditingDesktopFile(null)}
              >
                <Check size={12} />
                <span>{t('Done')}</span>
              </button>
            </div>
          </footer>

          {!fileWindowRect.maximized
            ? render8WayResizeHandles(
                "sys:file-studio",
                fileWindowRect,
                (next) => setFileWindowRect((prev) => ({ ...prev, ...next })),
                { minW: 400, minH: 280 },
                "os-file-studio-resize",
              )
            : null}
        </div>
      ) : null}

      {/* Floating System, Connector & Token Telemetry HUD Widget */}
      {hudOpen ? (
        <aside
          className={`os-desktop-hud-widget${hudCollapsed ? ' is-collapsed' : ''}${topSurfaceId === 'sys:hud' ? ' is-active' : ''}`}
          data-os-window="sys:hud"
          data-testid="os-desktop-hud-widget"
          style={{
            left: Math.max(12, Math.min(surfaceWidth - 250, hudRect.x)),
            top: Math.max(8, Math.min(surfaceHeight - 100, hudRect.y)),
            width: hudRect.width,
            height: hudCollapsed ? undefined : hudRect.height,
            zIndex: getSurfaceZIndex("sys:hud", false),
          }}
          onPointerDownCapture={() => bringSurfaceToFront("sys:hud")}
          onFocusCapture={() => bringSurfaceToFront("sys:hud")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header
            className="os-hud-header"
            onDoubleClick={() => setHudCollapsed((v) => !v)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest('button, select')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              hudDragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: hudRect.x,
                origY: hudRect.y,
              };
            }}
            onPointerMove={(e) => {
              const d = hudDragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const nx = Math.max(12, Math.min(surfaceWidth - 250, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(4, Math.min(surfaceHeight - 96, d.origY + (e.clientY - d.startY)));
              setHudRect((prev) => ({ ...prev, x: nx, y: ny }));
            }}
            onPointerUp={(e) => {
              if (hudDragRef.current?.pointerId === e.pointerId) {
                hudDragRef.current = null;
              }
            }}
          >
            <div className="os-hud-title">
              <Gauge size={13} />
              <strong>{t('System & Telemetry HUD')}</strong>
              <AppBuildLabel versionLabel={t('Version')} buildLabel={t('Build number')} />
              <span className="os-hud-live-badge" title={t('5s live telemetry (pauses when hidden or offline)')}>{t('5s Live')}</span>
              <span className="os-hud-live-dot" />
            </div>
            <div className="os-hud-controls">
              <button
                type="button"
                title={hudCollapsed ? t('Expand') : t('Collapse')}
                onClick={() => setHudCollapsed((v) => !v)}
              >
                {hudCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
              <button
                type="button"
                title={t('Close')}
                onClick={() => setHudOpen(false)}
              >
                <X size={12} />
              </button>
            </div>
          </header>

          {!hudCollapsed ? (
            <div className="os-hud-body">
              {/* Connectors Status Section */}
              <div className="os-hud-section">
                <div className="os-hud-section-head">
                  <Server size={12} />
                  <span>{t('Connectors & Environments')}</span>
                  <strong>{hudConnectors.length}</strong>
                </div>
                <div className="os-hud-connector-pills">
                  {hudConnectors.map((conn) => (
                    <span
                      key={conn.id}
                      className={`os-hud-conn-pill state-${conn.state}`}
                      title={`${conn.label} · ${conn.state} (${conn.count} sessions)`}
                    >
                      <i className={`os-hud-conn-dot state-${conn.state}`} />
                      <b>{conn.label}</b>
                      <small>{conn.count}</small>
                    </span>
                  ))}
                </div>
              </div>

              {/* CPU / Memory / Disk Section (Real Linux Kernel /proc & cgroup v2 Telemetry) */}
              <div className="os-hud-section">
                {(() => {
                  const telemetry = formatHudKernelTelemetry(metricSample, {
                    sampling: t('Sampling...'),
                    cgroupUnlimited: t('Cgroup RSS'),
                    noVolume: t('Unconfigured'),
                    coresUnit: t('C'),
                  });
                  return (
                    <>
                      <div className="os-hud-section-head">
                        <Cpu size={12} />
                        <span>{t('Host Resources (CPU / RAM / Disk)')}</span>
                        <span className="os-hud-kernel-badge" title={t('Linux kernel telemetry scope')}>
                          {telemetry.scopeLabel}
                        </span>
                        {metricSources.length > 0 ? (
                          <select
                            name="os-hud-metric-source"
                            className="os-hud-source-select"
                            value={selectedMetricSource}
                            onChange={(e) => setSelectedMetricSource(e.target.value)}
                          >
                            {metricSources.map((src) => (
                              <option
                                key={JSON.stringify([src.kind, src.key])}
                                value={JSON.stringify([src.kind, src.key])}
                              >
                                {src.label}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                      <div className="os-hud-bars">
                        <div className="os-hud-bar-row">
                          <span className="os-hud-bar-label">{t('CPU')}</span>
                          <div className="os-hud-bar-track">
                            <div
                              className="os-hud-bar-fill is-cpu"
                              style={{ width: `${telemetry.cpuBarWidth}%` }}
                            />
                          </div>
                          <strong className="os-hud-bar-val" data-testid="os-hud-cpu-val">
                            {telemetry.cpuText}
                          </strong>
                        </div>
                        <div className="os-hud-bar-row">
                          <span className="os-hud-bar-label">{t('RAM')}</span>
                          <div className="os-hud-bar-track">
                            <div
                              className="os-hud-bar-fill is-ram"
                              style={{ width: `${telemetry.memBarWidth}%` }}
                            />
                          </div>
                          <strong className="os-hud-bar-val" data-testid="os-hud-ram-val">
                            {telemetry.memText}
                          </strong>
                        </div>
                        <div className="os-hud-bar-row">
                          <span className="os-hud-bar-label">
                            <HardDrive size={10} /> {t('Disk')}
                          </span>
                          <div className="os-hud-bar-track">
                            <div
                              className="os-hud-bar-fill is-disk"
                              style={{ width: `${telemetry.diskBarWidth}%` }}
                            />
                          </div>
                          <strong className="os-hud-bar-val" data-testid="os-hud-disk-val">
                            {telemetry.diskText}
                          </strong>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Token & Credits Telemetry Section */}
              <div className="os-hud-section">
                <div className="os-hud-section-head">
                  <Activity size={12} />
                  <span>{t('Token & Credit Telemetry')}</span>
                  <button
                    type="button"
                    className="os-hud-open-card-btn"
                    onClick={() => {
                      const dashIcon = icons.find((i) => i.id === 'app:dashboard');
                      if (dashIcon) handleOpenDesktopIcon(dashIcon);
                    }}
                  >
                    {t('Details')}
                  </button>
                </div>
                <div className="os-hud-token-grid">
                  <div className="os-hud-token-stat">
                    <small>{t('Input Tokens')}</small>
                    <strong>{hudTokenSummary.totalInput.toLocaleString()}</strong>
                  </div>
                  <div className="os-hud-token-stat">
                    <small>{t('Output Tokens')}</small>
                    <strong>{hudTokenSummary.totalOutput.toLocaleString()}</strong>
                  </div>
                  <div className="os-hud-token-stat">
                    <small>{t('Est. Credits')}</small>
                    <strong>
                      {hudTokenSummary.totalEstimatedCredits > 0
                        ? hudTokenSummary.totalEstimatedCredits.toFixed(1)
                        : hudTokenSummary.totalGhcpCredits > 0
                          ? `${hudTokenSummary.totalGhcpCredits.toFixed(1)} GHCP`
                          : '0.0'}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {!hudCollapsed
            ? render8WayResizeHandles(
                "sys:hud",
                hudRect,
                (next) => setHudRect(next),
                { minW: 250, minH: 170 },
                "os-hud-resize",
              )
            : null}
        </aside>
      ) : null}

      {/* QQ-Style Auto-Hide / Draggable Session Messenger Dock */}
      <aside
        className={`os-qq-session-dock${qqDocked ? ' is-docked-right' : ' is-floating'}${qqDocked && !qqPinned && !qqHovered ? ' is-collapsed-edge' : ' is-expanded'}${topSurfaceId === 'sys:qq-dock' ? ' is-active' : ''}`}
        data-os-window="sys:qq-dock"
        data-testid="os-qq-session-dock"
        style={
          qqDocked
            ? { zIndex: getSurfaceZIndex("sys:qq-dock", false) }
            : {
                left: qqPos.x,
                top: qqPos.y,
                width: qqSize.width,
                height: qqSize.height,
                zIndex: getSurfaceZIndex("sys:qq-dock", false),
              }
        }
        onPointerDownCapture={() => bringSurfaceToFront("sys:qq-dock")}
        onFocusCapture={() => bringSurfaceToFront("sys:qq-dock")}
        onMouseEnter={() => setQqHovered(true)}
        onMouseLeave={() => setQqHovered(false)}
      >
        {/* Right-edge hover handle when collapsed */}
        <button
          type="button"
          className="os-qq-edge-tab"
          title={t('Session Messenger (Hover or click to expand)')}
          onClick={() => {
            setQqHovered(true);
            setQqPinned((v) => !v);
          }}
        >
          <MessageSquare size={14} />
          <span className="os-qq-edge-label">{t('Sessions')}</span>
          {runningCount > 0 ? <em className="os-qq-edge-badge">{runningCount}</em> : null}
        </button>

        <div className="os-qq-panel">
          <header
            className="os-qq-header"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button, input')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const startLeft = qqDocked ? Math.max(200, surfaceWidth - 286) : qqPos.x;
              const startTop = qqDocked ? 48 : qqPos.y;
              qqDragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: startLeft,
                origY: startTop,
                moved: false,
              };
            }}
            onPointerMove={(e) => {
              const d = qqDragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const dx = e.clientX - d.startX;
              const dy = e.clientY - d.startY;
              if (!d.moved && Math.hypot(dx, dy) < 6) return;
              d.moved = true;
              const nx = Math.max(6, Math.min(surfaceWidth - 180, d.origX + dx));
              const ny = Math.max(4, Math.min(surfaceHeight - 100, d.origY + dy));
              setQqDocked(false);
              setQqPos({ x: nx, y: ny });
            }}
            onPointerUp={(e) => {
              const d = qqDragRef.current;
              if (d && d.pointerId === e.pointerId) {
                qqDragRef.current = null;
                if (d.moved && surfaceWidth - e.clientX <= 36) {
                  // Snap back to right edge like QQ when dragged near right border
                  setQqDocked(true);
                }
              }
            }}
          >
            <div className="os-qq-header-title">
              <MessageSquare size={14} />
              <strong>{t('Session Hub')}</strong>
              <span className="os-qq-online-pill">{sessions.length}</span>
            </div>
            <div className="os-qq-header-actions">
              <button
                type="button"
                data-testid="os-open-wechat-btn"
                title={t("Open Split Chat Studio")}
                onClick={() => openWechatMessenger()}
              >
                <Columns2 size={13} />
              </button>
              {!qqDocked ? (
                <button
                  type="button"
                  title={t('Dock to right edge (Auto-hide)')}
                  onClick={() => setQqDocked(true)}
                >
                  <PanelRight size={13} />
                </button>
              ) : null}
              <button
                type="button"
                className={qqPinned ? 'is-active' : ''}
                title={qqPinned ? t('Unpin (Auto-hide to right edge)') : t('Pin panel open')}
                onClick={() => setQqPinned((v) => !v)}
              >
                {qqPinned ? <Pin size={13} /> : <PinOff size={13} />}
              </button>
            </div>
          </header>

          <div className="os-qq-search">
            <Search size={12} />
            <input
              name="os-qq-search-input"
              type="search"
              value={qqSearch}
              placeholder={t('Filter sessions…')}
              aria-label={t('Filter sessions…')}
              onChange={(e) => setQqSearch(e.target.value)}
            />
          </div>

          <div className="os-qq-groups">
            {(() => {
              const sessionItems = icons.filter(
                (ic) =>
                  ic.kind === 'session' &&
                  (!qqSearch.trim() ||
                    ic.title.toLowerCase().includes(qqSearch.trim().toLowerCase()) ||
                    (ic.subtitle ?? '').toLowerCase().includes(qqSearch.trim().toLowerCase())),
              );
              const runningItems = sessionItems.filter((ic) => ic.running);
              const unreadItems = sessionItems.filter((ic) => !ic.running && ic.unread);
              const groups: Array<{
                key: 'running' | 'unread' | 'all';
                label: string;
                items: DesktopIconItem[];
              }> = [
                { key: 'running', label: `⚡ ${t('Running')} (${runningItems.length})`, items: runningItems },
                { key: 'unread', label: `🔔 ${t('Updated')} (${unreadItems.length})`, items: unreadItems },
                { key: 'all', label: `💬 ${t('All sessions')} (${sessionItems.length})`, items: sessionItems },
              ];
              return groups.map((grp) => {
                const isOpen = qqOpenGroups[grp.key];
                return (
                  <div key={grp.key} className="os-qq-group">
                    <button
                      type="button"
                      className="os-qq-group-header"
                      onClick={() =>
                        setQqOpenGroups((prev) => ({ ...prev, [grp.key]: !prev[grp.key] }))
                      }
                    >
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <span>{grp.label}</span>
                    </button>
                    {isOpen ? (
                      <div className="os-qq-group-list">
                        {grp.items.map((ic) => {
                          const isOpened = ic.session
                            ? openSessionKeySet.has(ic.session.sessionKey)
                            : false;
                          return (
                            <button
                              key={`${grp.key}:${ic.id}`}
                              type="button"
                              className={`os-qq-buddy-row${ic.running ? ' is-running' : ''}${ic.unread ? ' is-unread' : ''}${isOpened ? ' is-open' : ''}`}
                              onClick={() => handleOpenDesktopIcon(ic)}
                            >
                              <span className="os-qq-buddy-avatar">
                                <Bot size={14} />
                                {ic.running ? <i className="os-qq-dot is-running" /> : null}
                                {!ic.running && ic.unread ? <i className="os-qq-dot is-unread" /> : null}
                              </span>
                              <span className="os-qq-buddy-info">
                                <strong>{ic.title}</strong>
                                <small>{ic.subtitle}</small>
                              </span>
                              <span className="os-qq-buddy-state">
                                {ic.running ? t('Running') : ic.unread ? t('Updated') : ''}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              });
            })()}
          </div>
        </div>
        {!qqDocked ? (
          <>
            {RESIZE_EDGES.map((edge) => (
              <div
                key={edge}
                data-resize-edge={edge}
                data-testid={`os-qq-resize-${edge}`}
                className={`os-window-resize-edge os-qq-resize-handle edge-${edge}`}
                title={t('Drag to resize Session Hub')}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  qqResizeRef.current = {
                    edge,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: qqPos.x,
                    origY: qqPos.y,
                    origW: qqSize.width,
                    origH: qqSize.height,
                  };
                }}
                onPointerMove={(e) => {
                  const r = qqResizeRef.current;
                  if (!r || r.pointerId !== e.pointerId) return;
                  const next = resizeDesktopWindowGeometry(
                    { x: r.origX, y: r.origY, width: r.origW, height: r.origH, maximized: false },
                    r.edge,
                    e.clientX - r.startX,
                    e.clientY - r.startY,
                    surfaceWidth,
                    surfaceHeight,
                    { minW: 230, minH: 240 },
                  );
                  setQqPos({ x: Math.round(next.x), y: Math.round(next.y) });
                  setQqSize({ width: Math.round( Math.min(620, next.width) ), height: Math.round(next.height) });
                }}
                onPointerUp={(e) => {
                  if (qqResizeRef.current?.pointerId === e.pointerId) {
                    qqResizeRef.current = null;
                  }
                }}
              />
            ))}
          </>
        ) : null}
      </aside>

      {/* Built-in Dual-Pane Session & Resource Explorer Window */}
      {explorerOpen ? (
        <div
          className={`os-desktop-explorer-window${topSurfaceId === 'sys:explorer' ? ' is-active' : ''}`}
          data-os-window="sys:explorer"
          role="dialog"
          aria-label={t('Session Explorer')}
          style={{
            left: explorerPos.x,
            top: explorerPos.y,
            width: explorerPos.width,
            height: explorerPos.height,
            zIndex: getSurfaceZIndex("sys:explorer", false),
          }}
          onPointerDownCapture={() => bringSurfaceToFront("sys:explorer")}
          onFocusCapture={() => bringSurfaceToFront("sys:explorer")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header
            className="os-window-titlebar"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              explorerDragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: explorerPos.x,
                origY: explorerPos.y,
              };
            }}
            onPointerMove={(e) => {
              const d = explorerDragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const nx = Math.max(8, Math.min(surfaceWidth - 260, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(4, Math.min(surfaceHeight - 120, d.origY + (e.clientY - d.startY)));
              setExplorerPos((prev) => ({ ...prev, x: nx, y: ny }));
            }}
            onPointerUp={(e) => {
              if (explorerDragRef.current?.pointerId === e.pointerId) {
                explorerDragRef.current = null;
              }
            }}
          >
            <div className="os-window-title">
              <FolderOpen size={14} />
              <strong>{t('Session Explorer')}</strong>
              <span className="os-window-running-pill">{explorerItems.length}</span>
            </div>
            <div className="os-explorer-breadcrumbs" aria-label={t('Explorer path')}>
              <span>{t('Desktop')}</span>
              <span>/</span>
              <strong>
                {explorerTab === 'all'
                  ? t('All items')
                  : explorerTab === 'running'
                    ? t('Running')
                    : explorerTab === 'notebooks'
                      ? t('Notebooks')
                      : t('System tools')}
              </strong>
            </div>
            <div className="os-window-controls">
              <button
                type="button"
                className={explorerViewMode === 'table' ? 'is-active' : ''}
                title={t('Details view')}
                onClick={() => setExplorerViewMode('table')}
              >
                <List size={13} />
              </button>
              <button
                type="button"
                className={explorerViewMode === 'grid' ? 'is-active' : ''}
                title={t('Grid view')}
                onClick={() => setExplorerViewMode('grid')}
              >
                <LayoutGrid size={13} />
              </button>
              <button type="button" aria-label={t('Close')} onClick={() => setExplorerOpen(false)}>
                <X size={13} />
              </button>
            </div>
          </header>
          <div className="os-explorer-body">
            <aside className="os-explorer-sidebar">
              <button
                type="button"
                className={explorerTab === 'all' ? 'is-active' : ''}
                onClick={() => setExplorerTab('all')}
              >
                <FolderOpen size={13} />
                <span>{t('All items')}</span>
              </button>
              <button
                type="button"
                className={explorerTab === 'running' ? 'is-active' : ''}
                onClick={() => setExplorerTab('running')}
              >
                <Activity size={13} />
                <span>
                  {t('Running')} ({runningCount})
                </span>
              </button>
              <button
                type="button"
                className={explorerTab === 'notebooks' ? 'is-active' : ''}
                onClick={() => setExplorerTab('notebooks')}
              >
                <StickyNote size={13} />
                <span>
                  {t('Notebooks')} ({notebooks.length})
                </span>
              </button>
              <button
                type="button"
                className={explorerTab === 'apps' ? 'is-active' : ''}
                onClick={() => setExplorerTab('apps')}
              >
                <LayoutGrid size={13} />
                <span>{t('System tools')}</span>
              </button>
            </aside>
            <div className="os-explorer-main">
              <div className="os-explorer-toolbar">
                <input
                  name="os-explorer-filter"
                  type="search"
                  value={explorerSearch}
                  placeholder={t('Filter items in explorer…')}
                  aria-label={t('Filter items in explorer…')}
                  onChange={(e) => setExplorerSearch(e.target.value)}
                />
                <div className="os-explorer-sort-pills">
                  {(['default', 'name', 'status', 'kind'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`os-explorer-sort-btn${prefs.sortBy === mode ? ' is-active' : ''}`}
                      onClick={() => setSortBy(mode)}
                    >
                      <ArrowUpDown size={11} />
                      <span>
                        {mode === 'default'
                          ? t('Default')
                          : mode === 'name'
                            ? t('Name')
                            : mode === 'status'
                              ? t('Status')
                              : t('Kind')}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className={`os-explorer-list view-${explorerViewMode}`}>
                {explorerItems.map((item) => {
                  const openWin = findMatchingExplorerOpenWindow(openWindows, item);
                  const isSel = selectedExplorerItem?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`os-explorer-row${isSel ? ' is-selected' : ''}`}
                      onClick={() => setExplorerSelectedId(item.id)}
                      onDoubleClick={() => handleOpenDesktopIcon(item)}
                    >
                      <button
                        type="button"
                        className="os-explorer-row-main"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExplorerSelectedId(item.id);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setExplorerSelectedId(item.id);
                          handleOpenDesktopIcon(item);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            setExplorerSelectedId(item.id);
                            handleOpenDesktopIcon(item);
                          }
                        }}
                      >
                        <span className={`os-explorer-row-icon kind-${item.kind}`}>
                          {renderIconGlyph(item.kind, item.running, 16)}
                        </span>
                        <span className="os-explorer-row-title">{item.title}</span>
                        <span className="os-explorer-row-kind">{item.subtitle || item.kind}</span>
                        <span className={`os-explorer-row-state${item.running ? ' is-running' : ''}`}>
                          {item.running ? t('Running') : item.unread ? t('Updated') : t('Ready')}
                        </span>
                      </button>
                      {openWin ? (
                        <div className="os-explorer-row-actions">
                          <button
                            type="button"
                            title={t('Snap window left')}
                            onClick={() => snapWindow(openWin.id, 'left')}
                          >
                            <PanelLeft size={12} />
                          </button>
                          <button
                            type="button"
                            title={t('Snap window right')}
                            onClick={() => snapWindow(openWin.id, 'right')}
                          >
                            <PanelRight size={12} />
                          </button>
                          <button
                            type="button"
                            title={t('Minimize window')}
                            onClick={() => toggleWindowMinimized(openWin)}
                          >
                            <Minus size={12} />
                          </button>
                          <button
                            type="button"
                            title={t('Close pane')}
                            onClick={() => onCloseWindow(openWin.id)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Right-Hand Inspector Preview Pane */}
            {selectedExplorerItem ? (
              <aside className="os-explorer-inspector" aria-label={t('Item inspector')}>
                <div className="os-explorer-inspector-head">
                  <div className={`os-desktop-shortcut-icon kind-${selectedExplorerItem.kind}`}>
                    {renderIconGlyph(selectedExplorerItem.kind, selectedExplorerItem.running, 24)}
                  </div>
                  <strong>{selectedExplorerItem.title}</strong>
                  <span>{selectedExplorerItem.subtitle || selectedExplorerItem.kind}</span>
                </div>
                <dl className="os-explorer-inspector-meta">
                  <div>
                    <dt>{t('Type')}</dt>
                    <dd>{selectedExplorerItem.kind}</dd>
                  </div>
                  <div>
                    <dt>{t('Status')}</dt>
                    <dd>
                      {selectedExplorerItem.running
                        ? t('Running')
                        : selectedExplorerItem.unread
                          ? t('Updated')
                          : t('Ready')}
                    </dd>
                  </div>
                  {selectedExplorerItem.session?.sessionRef?.nodeId ? (
                    <div>
                      <dt>{t('Node')}</dt>
                      <dd>{selectedExplorerItem.session.sessionRef.nodeId}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="os-explorer-inspector-actions">
                  <button
                    type="button"
                    className="os-desktop-pill-btn is-accent"
                    onClick={() => handleOpenDesktopIcon(selectedExplorerItem)}
                  >
                    <Sparkles size={13} />
                    <span>{t('Open window')}</span>
                  </button>
                </div>
              </aside>
            ) : null}
          </div>
          {render8WayResizeHandles(
            "sys:explorer",
            explorerPos,
            (next) => setExplorerPos(next),
            { minW: 480, minH: 300 },
            "os-explorer-resize",
          )}
        </div>
      ) : null}

      {/* Task View / Mission Control Exposé Overlay */}
      {taskViewOpen ? (
        <div
          className="os-desktop-task-view-overlay"
          role="dialog"
          aria-label={t('Task View')}
          onClick={(e) => {
            if (e.target === e.currentTarget) setTaskViewOpen(false);
          }}
        >
          <div className="os-task-view-header">
            <div>
              <strong>{t('Task View · Active Windows')}</strong>
              <span>
                {openWindows.length} {t('open')} · {runningCount} {t('running')}
              </span>
            </div>
            <button
              type="button"
              className="os-desktop-pill-btn"
              onClick={() => setTaskViewOpen(false)}
            >
              <X size={13} />
              <span>{t('Close')}</span>
            </button>
          </div>
          <div className="os-task-view-grid">
            {openWindows.map((win) => {
              const isMin = isWindowMinimized(win);
              return (
                <div
                  key={win.id}
                  className={`os-task-view-card${activeWindowId === win.id ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="os-task-view-card-main"
                    onClick={() => {
                      setTaskViewOpen(false);
                      restoreAndFocusWindow(win);
                    }}
                  >
                    <div className="os-task-view-card-icon">
                      {renderIconGlyph(win.kind, win.running, 24)}
                    </div>
                    <div className="os-task-view-card-info">
                      <strong>{win.title}</strong>
                      <span>
                        {win.running
                          ? t('Running')
                          : isMin
                            ? t('Minimized')
                            : t('Active window')}
                      </span>
                    </div>
                  </button>
                  <div className="os-task-view-card-actions">
                    <button
                      type="button"
                      title={t('Snap window left')}
                      onClick={() => {
                        setTaskViewOpen(false);
                        restoreAndFocusWindow(win);
                        snapWindow(win.id, 'left');
                      }}
                    >
                      <PanelLeft size={13} />
                    </button>
                    <button
                      type="button"
                      title={t('Snap window right')}
                      onClick={() => {
                        setTaskViewOpen(false);
                        restoreAndFocusWindow(win);
                        snapWindow(win.id, 'right');
                      }}
                    >
                      <PanelRight size={13} />
                    </button>
                    <button
                      type="button"
                      title={t('Close pane')}
                      onClick={() => onCloseWindow(win.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* WeChat PC Style Split Conversation Window */}
      {wechatOpen ? (
        <section
          className={`os-wechat-window${wechatRect.maximized ? " is-maximized" : ""}${topSurfaceId === "sys:wechat" ? " is-active" : ""}`}
          data-os-window="sys:wechat"
          data-testid="os-desktop-wechat-window"
          role="dialog"
          aria-label={t("Chat Studio")}
          style={
            wechatRect.maximized
              ? {
                  left: 0,
                  top: 0,
                  width: surfaceWidth,
                  height: Math.max(320, surfaceHeight - taskbarMetrics.taskbarHeight),
                  zIndex: getSurfaceZIndex("sys:wechat", true),
                }
              : {
                  left: Math.max(8, Math.min(surfaceWidth - 360, wechatRect.x)),
                  top: Math.max(4, Math.min(surfaceHeight - 120, wechatRect.y)),
                  width: Math.min(surfaceWidth - 16, wechatRect.width),
                  height: Math.min(surfaceHeight - taskbarMetrics.taskbarHeight - 16, wechatRect.height),
                  zIndex: getSurfaceZIndex("sys:wechat", false),
                }
          }
          onPointerDownCapture={() => bringSurfaceToFront("sys:wechat")}
          onFocusCapture={() => bringSurfaceToFront("sys:wechat")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Leftmost WeChat Icon Navigation Rail */}
          <aside className="os-wechat-rail">
            <div className="os-wechat-rail-top">
              <div className="os-wechat-avatar-badge" title={t("Chat Studio")}>
                <Bot size={18} />
                <span className="os-wechat-online-dot" />
              </div>
              <button
                type="button"
                className={`os-wechat-rail-btn${wechatFilter === "all" ? " is-active" : ""}`}
                title={t("All sessions")}
                aria-label={t("All sessions")}
                onClick={() => setWechatFilter("all")}
              >
                <MessageSquare size={17} />
                {sessions.length > 0 ? (
                  <span className="os-wechat-rail-count">{sessions.length}</span>
                ) : null}
              </button>
              <button
                type="button"
                className={`os-wechat-rail-btn${wechatFilter === "running" ? " is-active" : ""}`}
                title={t("Running")}
                aria-label={t("Running")}
                onClick={() => setWechatFilter("running")}
              >
                <Activity size={17} />
                {runningCount > 0 ? (
                  <span className="os-wechat-rail-count is-running">{runningCount}</span>
                ) : null}
              </button>
              <button
                type="button"
                className={`os-wechat-rail-btn${wechatFilter === "unread" ? " is-active" : ""}`}
                title={t("Updated")}
                aria-label={t("Updated")}
                onClick={() => setWechatFilter("unread")}
              >
                <Bell size={17} />
                {completedSessionKeys.size > 0 ? (
                  <span className="os-wechat-rail-count is-unread">{completedSessionKeys.size}</span>
                ) : null}
              </button>
              {onCreateSession ? (
                <button
                  type="button"
                  className="os-wechat-rail-btn"
                  title={t("New session")}
                  aria-label={t("New session")}
                  onClick={() => onCreateSession()}
                >
                  <Plus size={17} />
                </button>
              ) : null}
            </div>
            <div className="os-wechat-rail-bottom">
              <button
                type="button"
                className="os-wechat-rail-btn"
                data-testid="os-wechat-theme-toggle"
                title={colorMode === "dark" ? t("Switch to Light Mode") : t("Switch to Dark Mode")}
                aria-label={colorMode === "dark" ? t("Switch to Light Mode") : t("Switch to Dark Mode")}
                onClick={() => setColorMode(toggleWorkspaceColorMode())}
              >
                {colorMode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <button
                type="button"
                className="os-wechat-rail-btn"
                title={t("Pop out to standalone window")}
                aria-label={t("Pop out to standalone window")}
                onClick={() => {
                  const matched = sessions.find((s) => s.sessionKey === effectiveWechatSessionKey);
                  popOutWechatSessionToWindow(matched);
                }}
              >
                <ExternalLink size={16} />
              </button>
            </div>
          </aside>

          {/* Middle WeChat Session List Column */}
          <div className="os-wechat-list-col">
            <header
              className="os-wechat-list-header"
              onPointerDown={(e) => {
                if (wechatRect.maximized) return;
                if ((e.target as HTMLElement).closest("input, button")) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                wechatDragRef.current = {
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: wechatRect.x,
                  origY: wechatRect.y,
                };
              }}
              onPointerMove={(e) => {
                const d = wechatDragRef.current;
                if (!d || d.pointerId !== e.pointerId) return;
                const nx = Math.max(8, Math.min(surfaceWidth - 320, d.origX + (e.clientX - d.startX)));
                const ny = Math.max(4, Math.min(surfaceHeight - 100, d.origY + (e.clientY - d.startY)));
                setWechatRect((prev) => ({ ...prev, x: Math.round(nx), y: Math.round(ny) }));
              }}
              onPointerUp={(e) => {
                if (wechatDragRef.current?.pointerId === e.pointerId) {
                  wechatDragRef.current = null;
                }
              }}
            >
              <div className="os-wechat-search-wrap">
                <Search size={13} />
                <input
                  name="os-wechat-search"
                  type="search"
                  value={wechatSearch}
                  placeholder={t("Search sessions…")}
                  aria-label={t("Search sessions…")}
                  onChange={(e) => setWechatSearch(e.target.value)}
                />
                {wechatSearch ? (
                  <button
                    type="button"
                    className="os-wechat-search-clear"
                    aria-label={t("Clear")}
                    onClick={() => setWechatSearch("")}
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>
              {onCreateSession ? (
                <button
                  type="button"
                  className="os-wechat-plus-btn"
                  title={t("New session")}
                  aria-label={t("New session")}
                  onClick={() => onCreateSession()}
                >
                  <Plus size={14} />
                </button>
              ) : null}
            </header>

            <div className="os-wechat-session-list" role="listbox" aria-label={t("Sessions")}>
              {(() => {
                const q = wechatSearch.trim().toLowerCase();
                const pinnedSet = new Set(wechatPinnedKeys);
                const recycledSessionKeys = new Set(
                  recycleItems
                    .filter((r) => r.kind === "session" && r.sessionKey)
                    .map((r) => r.sessionKey!),
                );
                const filtered = sessions
                  .filter((s) => {
                    if (recycledSessionKeys.has(s.sessionKey) || recycledIconIdSet.has(`session:${s.sessionKey}`)) {
                      return false;
                    }
                    const isRunning = s.status === "running" || Boolean(s.hasActiveRun);
                    const isUnread = completedSessionKeys.has(s.sessionKey);
                    if (wechatFilter === "running" && !isRunning) return false;
                    if (wechatFilter === "unread" && !isUnread) return false;
                    if (q) {
                      const hay = `${s.title || ""} ${s.sessionKey} ${s.agentId || ""} ${s.sessionRef?.runtimeId || ""}`.toLowerCase();
                      if (!hay.includes(q)) return false;
                    }
                    return true;
                  })
                  .sort((a, b) => {
                    const aPin = pinnedSet.has(a.sessionKey) ? 0 : 1;
                    const bPin = pinnedSet.has(b.sessionKey) ? 0 : 1;
                    if (aPin !== bPin) return aPin - bPin;
                    if (aPin === 0) {
                      return wechatPinnedKeys.indexOf(a.sessionKey) - wechatPinnedKeys.indexOf(b.sessionKey);
                    }
                    return 0;
                  });

                if (filtered.length === 0) {
                  return (
                    <div className="os-wechat-list-empty">
                      <MessageSquare size={22} />
                      <span>{t("No matching sessions")}</span>
                    </div>
                  );
                }

                return filtered.map((s) => {
                  const isSelected = s.sessionKey === effectiveWechatSessionKey;
                  const isPinned = pinnedSet.has(s.sessionKey);
                  const isRunning = s.status === "running" || Boolean(s.hasActiveRun);
                  const isUnread = completedSessionKeys.has(s.sessionKey);
                  const runtimeLabel = s.sessionRef?.runtimeId || s.agentId || "codex";
                  const ts = s.lastActiveAt ?? s.runCompletedAt ?? s.runStartedAt;
                  const timeStr = ts
                    ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : "";
                  return (
                    <button
                      key={s.sessionKey}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid="os-wechat-session-row"
                      data-session-key={s.sessionKey}
                      data-pinned={isPinned ? "true" : undefined}
                      className={`os-wechat-session-item${isSelected ? " is-selected" : ""}${isPinned ? " is-pinned" : ""}${isRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
                      onClick={() => {
                        setWechatContextMenu(null);
                        selectWechatSession(s);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu(null);
                        setWechatContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          session: s,
                        });
                      }}
                    >
                      <div className="os-wechat-item-avatar">
                        <Bot size={17} />
                        {isRunning ? <span className="os-wechat-item-dot is-running" /> : null}
                        {!isRunning && isUnread ? <span className="os-wechat-item-dot is-unread" /> : null}
                      </div>
                      <div className="os-wechat-item-body">
                        <div className="os-wechat-item-top">
                          <strong>
                            {isPinned ? (
                              <span className="os-wechat-pin-badge" title={t("Pinned session")}>
                                <Pin size={10} />
                              </span>
                            ) : null}
                            {s.title || s.sessionKey}
                          </strong>
                          <time>{timeStr}</time>
                        </div>
                        <div className="os-wechat-item-sub">
                          <span className="os-wechat-runtime-tag">{runtimeLabel}</span>
                          {isPinned ? (
                            <span className="os-wechat-pinned-tag">{t("Pinned")}</span>
                          ) : null}
                          <span className="os-wechat-status-text">
                            {isRunning ? t("Running") : isUnread ? t("Updated") : s.status || t("Ready")}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                });
              })()}
            </div>
          </div>

          {/* Right Conversation & Message Stage */}
          <div className="os-wechat-chat-col">
            {(() => {
              const activeSession = sessions.find((s) => s.sessionKey === effectiveWechatSessionKey);
              const activeSessionWin = openWindows.find(
                (w) => w.kind === "session" && w.sessionKey === effectiveWechatSessionKey,
              );
              const isRunning =
                activeSession?.status === "running" ||
                Boolean(activeSession?.hasActiveRun) ||
                Boolean(activeSessionWin?.running);
              const runtimeLabel =
                activeSession?.sessionRef?.runtimeId || activeSession?.agentId || "codex";

              return (
                <>
                  <header
                    className="os-wechat-chat-header"
                    onDoubleClick={() =>
                      setWechatRect((prev) => ({ ...prev, maximized: !prev.maximized }))
                    }
                    onPointerDown={(e) => {
                      if (wechatRect.maximized) return;
                      if ((e.target as HTMLElement).closest("button")) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      wechatDragRef.current = {
                        pointerId: e.pointerId,
                        startX: e.clientX,
                        startY: e.clientY,
                        origX: wechatRect.x,
                        origY: wechatRect.y,
                      };
                    }}
                    onPointerMove={(e) => {
                      const d = wechatDragRef.current;
                      if (!d || d.pointerId !== e.pointerId) return;
                      const nx = Math.max(8, Math.min(surfaceWidth - 320, d.origX + (e.clientX - d.startX)));
                      const ny = Math.max(4, Math.min(surfaceHeight - 100, d.origY + (e.clientY - d.startY)));
                      setWechatRect((prev) => ({ ...prev, x: Math.round(nx), y: Math.round(ny) }));
                    }}
                    onPointerUp={(e) => {
                      if (wechatDragRef.current?.pointerId === e.pointerId) {
                        wechatDragRef.current = null;
                      }
                    }}
                  >
                    <div className="os-wechat-chat-title">
                      <strong>
                        {activeSession?.title ||
                          activeSessionWin?.title ||
                          t("Chat Studio")}
                      </strong>
                      {activeSession ? (
                        <span className="os-wechat-chat-badge">{runtimeLabel}</span>
                      ) : null}
                      {isRunning ? (
                        <span className="os-window-running-pill">{t("Running")}</span>
                      ) : null}
                    </div>
                    <div className="os-window-controls">
                      {activeSession ? (
                        <button
                          type="button"
                          title={t("Pop out to standalone window")}
                          aria-label={t("Pop out to standalone window")}
                          onClick={() => popOutWechatSessionToWindow(activeSession)}
                        >
                          <ExternalLink size={13} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={t(wechatRect.maximized ? "Restore pane" : "Maximize pane")}
                        onClick={() =>
                          setWechatRect((prev) => ({ ...prev, maximized: !prev.maximized }))
                        }
                      >
                        {wechatRect.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      </button>
                      <button
                        type="button"
                        className="os-window-close"
                        aria-label={t("Close")}
                        onClick={() => setWechatOpen(false)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </header>

                  <div
                    className="os-wechat-chat-stage"
                    data-testid="os-wechat-chat-stage"
                    data-workspace-pane=""
                    data-remote-pane={activeSessionWin?.id ?? (activeSession ? `wechat:${activeSession.sessionKey}` : undefined)}
                  >
                    {activeSession && renderSessionContent ? (
                      <div key={activeSession.sessionKey} className="os-window-content os-wechat-window-content">
                        {renderSessionContent(activeSession)}
                      </div>
                    ) : activeSessionWin ? (
                      <div key={activeSessionWin.id} className="os-window-content os-wechat-window-content">
                        {renderWindowContent(activeSessionWin.id)}
                      </div>
                    ) : activeSession ? (
                      <div className="os-wechat-stage-empty">
                        <Bot size={32} />
                        <strong>{activeSession.title || activeSession.sessionKey}</strong>
                        <p>{t("Click below to load this conversation in split view.")}</p>
                        <button
                          type="button"
                          className="os-desktop-pill-btn is-accent"
                          onClick={() => popOutWechatSessionToWindow(activeSession)}
                        >
                          <MessageSquare size={13} />
                          <span>{t("Open Conversation")}</span>
                        </button>
                      </div>
                    ) : (
                      <div className="os-wechat-stage-empty">
                        <MessageSquare size={32} />
                        <strong>{t("No session selected")}</strong>
                        <p>{t("Select a session on the left list to chat.")}</p>
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </div>

          {!wechatRect.maximized
            ? render8WayResizeHandles(
                "sys:wechat",
                wechatRect,
                (next) => setWechatRect((prev) => ({ ...prev, ...next })),
                { minW: 560, minH: 360 },
                "os-wechat-resize",
              )
            : null}
        </section>
      ) : null}

      {/* Cross-Display Edge Drag Portal Indicator */}
      {edgePortalSide ? (
        <div
          className={`os-desktop-edge-portal-indicator is-${edgePortalSide}`}
          data-testid="os-desktop-edge-portal-indicator"
        >
          <MonitorUp size={16} />
          <span>
            {edgePortalSide === 'right'
              ? t('Release to move window to Secondary Display (Display 2) →')
              : t('← Release to move window back to Primary Display (Display 1)')}
          </span>
        </div>
      ) : null}

      {/* Secondary Display (Display 2) Floating Status Bar & Empty State */}
      {isSecondaryDisplay ? (
        <>
          <div className="os-secondary-display-floating-bar" data-testid="os-secondary-display-bar">
            <Monitor size={14} />
            <strong>{t('Display 2 · Extended Desktop')}</strong>
            {!isFullscreenDisplay ? (
              <button
                type="button"
                data-testid="os-secondary-fullscreen-btn"
                onClick={() => {
                  void detectSecondaryScreenRect({ promptPermission: true }).then((topo) => {
                    const target = topo.secondaryRect ?? topo.displays.find((d) => !d.isPrimary) ?? topo.displays[0];
                    if (target) moveWindowToScreen(window, target, { maximizeToScreen: true });
                    void requestFullscreenOnScreen(document.documentElement, target);
                  });
                }}
              >
                {t('Fullscreen Display 2')}
              </button>
            ) : null}
          </div>
          {openWindows.filter((w) => secondaryWindowIds.includes(w.id)).length === 0 ? (
            <div className="os-secondary-display-empty-hint" data-testid="os-secondary-display-empty">
              <MonitorUp size={28} style={{ margin: '0 auto 8px', display: 'block', opacity: 0.85 }} />
              <strong>{t('Extended Secondary Display Ready')}</strong>
              <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.82 }}>
                {t('Drag any window to the right edge of Display 1 or click its top-right "Move to Secondary Display" button to place it here.')}
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Floating OS Windows Layer */}
      <div className="os-desktop-window-layer">
        {openWindows.map((win, index) => {
          const isAssignedToSecondary = secondaryWindowIds.includes(win.id);
          if (isSecondaryDisplay ? !isAssignedToSecondary : isAssignedToSecondary) {
            return null;
          }
          if (
            wechatOpen &&
            win.kind === "session" &&
            win.sessionKey === effectiveWechatSessionKey
          ) {
            return null;
          }
          const isMin = isWindowMinimized(win);
          if (!isMin) {
            mountedOnceIdsRef.current.add(win.id);
          }
          const mountDecision = evaluateWindowContentMount({
            isMinimized: isMin,
            hasMountedOnce: mountedOnceIdsRef.current.has(win.id),
            isActive: activeWindowId === win.id,
            running: Boolean(win.running),
          });
          if (!mountDecision.shouldMountContent) return null;
          const isMaximized = maximizedWindowId === win.id;
          const isTopWindow = topSurfaceId === win.id;
          const isActive = activeWindowId === win.id || isTopWindow;
          const geo =
            windowRects[win.id] ??
            (win.kind === 'subagents'
              ? computeCompanionWindowGeometry(surfaceWidth, surfaceHeight)
              : computeCascadeWindowGeometry(index, surfaceWidth, surfaceHeight));
          const computedZ = getSurfaceZIndex(win.id, isMaximized, index);
          const style = isMaximized
            ? {
                left: 0,
                top: 0,
                width: surfaceWidth,
                height: Math.max(320, surfaceHeight - taskbarMetrics.taskbarHeight),
                zIndex: computedZ,
              }
            : {
                left: geo.x,
                top: geo.y,
                width: geo.width,
                height: geo.height,
                zIndex: computedZ,
              };

          return (
            <section
              key={win.id}
              data-os-window={win.id}
              data-workspace-pane=""
              data-remote-pane={win.id}
              data-window-kind={win.kind}
              data-minimized={mountDecision.isHiddenMinimized ? "true" : undefined}
              hidden={mountDecision.isHiddenMinimized || undefined}
              aria-hidden={mountDecision.isHiddenMinimized || undefined}
              className={`os-desktop-window${isActive ? ' is-active' : ''}${isMaximized ? ' is-maximized' : ''}${geo.snapped ? ` is-snapped-${geo.snapped}` : ''}${mountDecision.isHiddenMinimized ? ' is-minimized-hidden' : ''}`}
              style={style}
              onPointerDownCapture={() => {
                bringSurfaceToFront(win.id);
                if (activeWindowId !== win.id) onActivateWindow(win.id);
              }}
              onFocusCapture={() => {
                bringSurfaceToFront(win.id);
                if (activeWindowId !== win.id) onActivateWindow(win.id);
              }}
            >
              <header
                className="os-window-titlebar"
                onDoubleClick={() => {
                  if (geo.snapped && geo.restoreRect && !isMaximized) {
                    setWindowRects((prev) => ({
                      ...prev,
                      [win.id]: { ...geo.restoreRect! },
                    }));
                  } else {
                    onToggleMaximize(win.id);
                  }
                }}
                onPointerDown={(e) => {
                  if (isMaximized) return;
                  if ((e.target as HTMLElement).closest('button')) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const winEl = e.currentTarget.closest('.os-desktop-window') as HTMLElement | null;
                  if (winEl) winEl.setAttribute('data-gesture-active', 'drag');
                  dragRef.current = {
                    id: win.id,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: geo.x,
                    origY: geo.y,
                    origW: geo.width,
                    origH: geo.height,
                    lastX: geo.x,
                    lastY: geo.y,
                    moved: false,
                    winEl: winEl ?? undefined,
                  };
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current;
                  if (!d || d.id !== win.id || d.pointerId !== e.pointerId) return;
                  const nx = Math.max(4, Math.min(surfaceWidth - 180, d.origX + (e.clientX - d.startX)));
                  const ny = Math.max(4, Math.min(surfaceHeight - 96, d.origY + (e.clientY - d.startY)));
                  d.lastX = nx;
                  d.lastY = ny;
                  d.moved = true;
                  if (d.winEl) {
                    d.winEl.style.left = `${nx}px`;
                    d.winEl.style.top = `${ny}px`;
                  }
                  const nearRightPortal = !isSecondaryDisplay && e.clientX >= surfaceWidth - 10;
                  const nearLeftPortal = isSecondaryDisplay && e.clientX <= 10;
                  setEdgePortalSide(nearRightPortal ? 'right' : nearLeftPortal ? 'left' : null);
                  const zone =
                    nearRightPortal || nearLeftPortal
                      ? undefined
                      : detectWindowSnapZone(e.clientX, e.clientY, surfaceWidth, surfaceHeight);
                  setSnapPreviewZone((prev) => (prev === zone ? prev : zone));
                }}
                onPointerUp={(e) => {
                  const d = dragRef.current;
                  if (d && d.pointerId === e.pointerId) {
                    if (d.winEl) d.winEl.removeAttribute('data-gesture-active');
                    const nearRightPortal = !isSecondaryDisplay && d.moved && e.clientX >= surfaceWidth - 10;
                    const nearLeftPortal = isSecondaryDisplay && d.moved && e.clientX <= 10;
                    setEdgePortalSide(null);
                    const zone = detectWindowSnapZone(e.clientX, e.clientY, surfaceWidth, surfaceHeight);
                    setSnapPreviewZone(undefined);
                    if (nearRightPortal) {
                      transferWindowToDisplay(win.id, 'secondary', { title: win.title, kind: win.kind });
                    } else if (nearLeftPortal) {
                      transferWindowToDisplay(win.id, 'primary', { title: win.title, kind: win.kind });
                    } else if (zone) {
                      snapWindow(win.id, zone);
                    } else if (d.moved) {
                      const finalX = d.lastX;
                      const finalY = d.lastY;
                      setWindowRects((prev) => ({
                        ...prev,
                        [win.id]: {
                          ...geo,
                          x: finalX,
                          y: finalY,
                          snapped: undefined,
                        },
                      }));
                    }
                    dragRef.current = null;
                  }
                }}
              >
                <div className="os-window-title">
                  {renderIconGlyph(win.kind, win.running, 15)}
                  <strong>{win.title}</strong>
                  {win.running ? <span className="os-window-running-pill">{t('Running')}</span> : null}
                  {!win.running && win.unread ? (
                    <span className="os-window-unread-pill">{t('Updated')}</span>
                  ) : null}
                </div>
                <div className="os-window-controls">
                  <button
                    type="button"
                    className="os-window-screen-transfer-btn"
                    data-testid={`os-window-move-screen-${win.id}`}
                    aria-label={
                      isSecondaryDisplay
                        ? t('Move window to Primary Display')
                        : t('Move window to Secondary Display')
                    }
                    title={
                      isSecondaryDisplay
                        ? t('Move window back to Primary Display (Display 1)')
                        : t('Move window to Secondary Display (Display 2)')
                    }
                    onClick={() =>
                      transferWindowToDisplay(
                        win.id,
                        isSecondaryDisplay ? 'primary' : 'secondary',
                        { title: win.title, kind: win.kind },
                      )
                    }
                  >
                    {isSecondaryDisplay ? <Monitor size={12} /> : <MonitorUp size={12} />}
                  </button>
                  <button
                    type="button"
                    className={`os-window-lineage-btn${
                      highlightedLineageNodeId &&
                      (win.kind === 'session'
                        ? highlightedLineageNodeId === `session:${win.sessionKey}`
                        : win.kind === 'notebook'
                          ? highlightedLineageNodeId === 'app:notebook' || highlightedLineageNodeId === `notebook:${win.resourceId}`
                          : win.kind === 'taskboard'
                            ? highlightedLineageNodeId === 'app:taskboard' || highlightedLineageNodeId === `taskboard:${win.resourceId}`
                            : highlightedLineageNodeId === `app:${win.kind}`)
                        ? ' is-active'
                        : ''
                    }`}
                    aria-label={t('Lineage / Links')}
                    title={t('View Lineage & Binding Lines')}
                    onClick={() => {
                      const visibleNbs = notebooks;
                      const winIconId =
                        win.kind === 'session'
                          ? `session:${win.sessionKey}`
                          : win.kind === 'notebook'
                            ? !win.resourceId || win.resourceId === 'default' || visibleNbs[0]?.id === win.resourceId
                              ? 'app:notebook'
                              : `notebook:${win.resourceId}`
                            : win.kind === 'taskboard'
                              ? !win.resourceId || win.resourceId === 'default'
                                ? 'app:taskboard'
                                : `taskboard:${win.resourceId}`
                              : `app:${win.kind}`;
                      setHighlightedLineageNodeId((prev) => {
                        const isTurningOff = prev === winIconId && prefs.showLineageLines !== false;
                        if (isTurningOff) {
                          setPrefs((pState) => ({ ...pState, showLineageLines: false }));
                          return null;
                        }
                        setPrefs((pState) => ({ ...pState, showLineageLines: true }));
                        setLineageInspectorOpen(true);
                        return winIconId;
                      });
                    }}
                  >
                    <GitBranch size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('Snap window left')}
                    title={t('Snap window left')}
                    onClick={() => snapWindow(win.id, 'left')}
                  >
                    <PanelLeft size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('Snap window right')}
                    title={t('Snap window right')}
                    onClick={() => snapWindow(win.id, 'right')}
                  >
                    <PanelRight size={12} />
                  </button>
                  <div
                    className="os-window-snap-menu-wrap"
                    onMouseEnter={() => setSnapLayoutMenuFor(win.id)}
                    onMouseLeave={() =>
                      setSnapLayoutMenuFor((curr) => (curr === win.id ? undefined : curr))
                    }
                  >
                    <button
                      type="button"
                      aria-label={t(isMaximized ? 'Restore pane' : 'Maximize pane')}
                      title={t('Maximize or choose snap layout')}
                      onClick={() => onToggleMaximize(win.id)}
                    >
                      {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>
                    {snapLayoutMenuFor === win.id ? (
                      <div className="os-window-snap-flyout" role="menu" aria-label={t('Snap layouts')}>
                        <button
                          type="button"
                          title={t('Snap window left')}
                          onClick={() => snapWindow(win.id, 'left')}
                        >
                          {t('Left half')}
                        </button>
                        <button
                          type="button"
                          title={t('Snap window right')}
                          onClick={() => snapWindow(win.id, 'right')}
                        >
                          {t('Right half')}
                        </button>
                        <button
                          type="button"
                          title={t('Top-left quadrant')}
                          onClick={() => snapWindow(win.id, 'top-left')}
                        >
                          {t('Top-Left')}
                        </button>
                        <button
                          type="button"
                          title={t('Top-right quadrant')}
                          onClick={() => snapWindow(win.id, 'top-right')}
                        >
                          {t('Top-Right')}
                        </button>
                        <button
                          type="button"
                          title={t('Bottom-left quadrant')}
                          onClick={() => snapWindow(win.id, 'bottom-left')}
                        >
                          {t('Bottom-Left')}
                        </button>
                        <button
                          type="button"
                          title={t('Bottom-right quadrant')}
                          onClick={() => snapWindow(win.id, 'bottom-right')}
                        >
                          {t('Bottom-Right')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={t('Minimize window')}
                    title={t('Minimize window')}
                    onClick={() => toggleWindowMinimized(win)}
                  >
                    <Minus size={13} />
                  </button>
                  <button
                    type="button"
                    className="os-window-close"
                    aria-label={t('Close pane')}
                    title={t('Close pane')}
                    onClick={() => onCloseWindow(win.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              </header>
              <div className="os-window-content">{renderWindowContent(win.id)}</div>
              {/* 8-Way Window Resize Handles */}
              {!isMaximized
                ? RESIZE_EDGES.map((edge) => (
                    <div
                      key={edge}
                      data-resize-edge={edge}
                      className={`os-window-resize-edge edge-${edge}${edge === 'se' ? ' os-window-resize-handle' : ''}`}
                      title={edge === 'se' ? t('Resize window') : undefined}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const winEl = e.currentTarget.closest('.os-desktop-window') as HTMLElement | null;
                        if (winEl) winEl.setAttribute('data-gesture-active', 'resize');
                        resizeRef.current = {
                          id: win.id,
                          edge,
                          pointerId: e.pointerId,
                          startX: e.clientX,
                          startY: e.clientY,
                          orig: geo,
                          lastGeo: geo,
                          moved: false,
                          winEl: winEl ?? undefined,
                        };
                      }}
                      onPointerMove={(e) => {
                        const r = resizeRef.current;
                        if (!r || r.id !== win.id || r.pointerId !== e.pointerId) return;
                        const nextGeo = resizeDesktopWindowGeometry(
                          r.orig,
                          r.edge,
                          e.clientX - r.startX,
                          e.clientY - r.startY,
                          surfaceWidth,
                          surfaceHeight,
                        );
                        r.lastGeo = nextGeo;
                        r.moved = true;
                        if (r.winEl) {
                          r.winEl.style.left = `${nextGeo.x}px`;
                          r.winEl.style.top = `${nextGeo.y}px`;
                          r.winEl.style.width = `${nextGeo.width}px`;
                          r.winEl.style.height = `${nextGeo.height}px`;
                        }
                      }}
                      onPointerUp={(e) => {
                        const r = resizeRef.current;
                        if (r && r.pointerId === e.pointerId) {
                          if (r.winEl) r.winEl.removeAttribute('data-gesture-active');
                          if (r.moved) {
                            const committed = r.lastGeo;
                            setWindowRects((prev) => ({
                              ...prev,
                              [win.id]: committed,
                            }));
                          }
                          resizeRef.current = null;
                        }
                      }}
                    />
                  ))
                : null}
            </section>
          );
        })}
      </div>

      {/* Redesigned Desktop & Icon Right-Click Context Menu */}
      {contextMenu ? (
        <div
          ref={osDesktopMenuRef}
          className="os-desktop-context-menu is-redesigned"
          data-testid="os-desktop-context-menu"
          role="menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e) => handleContextMenuKeyDown(e, () => setContextMenu(null))}
        >
          {contextMenu.taskbarTarget ? (
            <>
              <div className="os-context-menu-header">
                <span className="os-context-menu-header-icon">
                  {contextMenu.taskbarTarget.win
                    ? renderIconGlyph(contextMenu.taskbarTarget.win.kind, contextMenu.taskbarTarget.win.running, 14)
                    : <LayoutGrid size={14} />}
                </span>
                <div className="os-context-menu-header-text">
                  <strong>
                    {contextMenu.taskbarTarget.win?.title ??
                      contextMenu.taskbarTarget.title ??
                      t('Desktop taskbar')}
                  </strong>
                  <small>
                    {contextMenu.taskbarTarget.kind === 'window'
                      ? (contextMenu.taskbarTarget.win?.running ? t('Running') : t('Window Actions'))
                      : contextMenu.taskbarTarget.kind === 'quick'
                        ? t('Taskbar App Shortcut')
                        : t('Taskbar Controls')}
                  </small>
                </div>
              </div>
              {contextMenu.taskbarTarget.kind === 'window' && contextMenu.taskbarTarget.win ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const w = contextMenu.taskbarTarget?.win;
                      setContextMenu(null);
                      if (w) restoreAndFocusWindow(w);
                    }}
                  >
                    <ExternalLink size={13} />
                    <span>{t('Restore / Bring to Front')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const w = contextMenu.taskbarTarget?.win;
                      setContextMenu(null);
                      if (w) toggleWindowMinimized(w);
                    }}
                  >
                    <Minus size={13} />
                    <span>
                      {isWindowMinimized(contextMenu.taskbarTarget.win)
                        ? t('Unminimize Window')
                        : t('Minimize Window')}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const w = contextMenu.taskbarTarget?.win;
                      setContextMenu(null);
                      if (w) {
                        restoreAndFocusWindow(w);
                        snapWindow(w.id, 'maximize');
                      }
                    }}
                  >
                    <Maximize2 size={13} />
                    <span>{t('Maximize Window')}</span>
                  </button>
                  <div className="os-context-menu-split-row">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const w = contextMenu.taskbarTarget?.win;
                        setContextMenu(null);
                        if (w) {
                          restoreAndFocusWindow(w);
                          snapWindow(w.id, 'left');
                        }
                      }}
                    >
                      <PanelLeft size={13} />
                      <span>{t('Snap window left')}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const w = contextMenu.taskbarTarget?.win;
                        setContextMenu(null);
                        if (w) {
                          restoreAndFocusWindow(w);
                          snapWindow(w.id, 'right');
                        }
                      }}
                    >
                      <PanelRight size={13} />
                      <span>{t('Snap window right')}</span>
                    </button>
                  </div>
                  <div className="os-context-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    onClick={() => {
                      const w = contextMenu.taskbarTarget?.win;
                      setContextMenu(null);
                      if (w) onCloseWindow(w.id);
                    }}
                  >
                    <X size={13} />
                    <span>{t('Close pane')}</span>
                  </button>
                </>
              ) : null}

              {contextMenu.taskbarTarget.kind === 'quick' ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const qid = contextMenu.taskbarTarget?.quickId;
                      setContextMenu(null);
                      if (qid === 'start') setStartMenuOpen((v) => !v);
                      else if (qid === 'taskview') setTaskViewOpen((v) => !v);
                      else if (qid === 'wechat') openWechatMessenger();
                      else if (qid === 'explorer') { setExplorerOpen(true); bringSurfaceToFront('sys:explorer'); }
                      else if (qid === 'browser') { setBrowserOpen(true); bringSurfaceToFront('sys:browser'); }
                      else if (qid === 'new-file') createNewDesktopFile();
                      else if (qid === 'fences') setPrefs((prev) => ({ ...prev, fencesEnabled: prev.fencesEnabled === false }));
                      else if (qid === 'lineage') {
                        const isCurrentlyActive = lineageInspectorOpen || prefs.showLineageLines !== false || linkConnectMode;
                        if (isCurrentlyActive) {
                          setLineageInspectorOpen(false);
                          setLinkConnectMode(false);
                          setPendingLinkSourceId(null);
                          setHighlightedLineageNodeId(null);
                          setPrefs((prev) => ({ ...prev, showLineageLines: false }));
                        } else {
                          setPrefs((prev) => ({ ...prev, showLineageLines: true }));
                          setLineageInspectorOpen(true);
                        }
                      } else if (qid === 'link') {
                        if (linkConnectMode) {
                          setLinkConnectMode(false);
                          setPendingLinkSourceId(null);
                          if (!lineageInspectorOpen) {
                            setPrefs((prev) => ({ ...prev, showLineageLines: false }));
                          }
                        } else {
                          setPrefs((prev) => ({ ...prev, showLineageLines: true }));
                          setLinkConnectMode(true);
                          setPendingLinkSourceId(null);
                        }
                      }
                      else if (qid === 'hud') setHudOpen((v) => !v);
                      else if (qid === 'recycle') { setRecycleBinOpen(true); bringSurfaceToFront('sys:recycle'); }
                      else if (qid === 'settings') { setSettingsOpen(true); bringSurfaceToFront('sys:settings'); }
                      else if (qid === 'access') { setSettingsOpen(true); setSettingsTab('access'); bringSurfaceToFront('sys:settings'); }
                      else if (qid === 'theme') setColorMode(toggleWorkspaceColorMode());
                      else if (qid === 'notifications') setNotificationCenterOpen((v) => !v);
                      else if (qid === 'tray') setTrayFlyoutOpen((v) => !v);
                    }}
                  >
                    <ExternalLink size={13} />
                    <span>{t('Open / Toggle Tool')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setContextMenu(null);
                      setSettingsTab('access');
                      setSettingsOpen(true);
                      bringSurfaceToFront('sys:settings');
                    }}
                  >
                    <ShieldCheck size={13} />
                    <span>{t('Access & Users Center…')}</span>
                  </button>
                  <div className="os-context-menu-divider" />
                </>
              ) : null}

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setShowDesktopAllMinimized((v) => !v);
                }}
              >
                <Monitor size={13} />
                <span>{t('Show desktop')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setTaskViewOpen(true);
                }}
              >
                <Columns2 size={13} />
                <span>{t('Task View')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  tileWindows();
                }}
              >
                <Grid2X2 size={13} />
                <span>{t('Tile windows 2x2')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setSettingsOpen(true);
                  bringSurfaceToFront('sys:settings');
                }}
              >
                <Settings size={13} />
                <span>{t('Taskbar & System Settings…')}</span>
              </button>
            </>
          ) : contextMenu.targetIcon ? (
            <>
              <div className="os-context-menu-header">
                <span className="os-context-menu-header-icon">
                  {renderIconGlyph(contextMenu.targetIcon.kind, contextMenu.targetIcon.running, 14, contextMenu.targetIcon.variant)}
                </span>
                <div className="os-context-menu-header-text">
                  <strong>{contextMenu.targetIcon.title}</strong>
                  <small>{contextMenu.targetIcon.subtitle || contextMenu.targetIcon.kind}</small>
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = contextMenu.targetIcon;
                  setContextMenu(null);
                  if (target) handleOpenDesktopIcon(target);
                }}
              >
                <ExternalLink size={13} />
                <span>{t('Open Window')}</span>
              </button>
              {selectedIconIds.size > 1 ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setContextMenu(null);
                    icons
                      .filter((ic) => selectedIconIds.has(ic.id))
                      .forEach((ic) => handleOpenDesktopIcon(ic));
                  }}
                >
                  <Sparkles size={13} />
                  <span>
                    {t('Open selected items')} ({selectedIconIds.size})
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = contextMenu.targetIcon;
                  setContextMenu(null);
                  if (!target) return;
                  handleOpenDesktopIcon(target);
                  transferWindowToDisplay(target.id, 'secondary', {
                    title: target.title,
                    kind: target.kind,
                  });
                }}
              >
                <Monitor size={13} />
                <span>{t('Project to Secondary Display')}</span>
              </button>
              {/* Pin to Free Desktop / Return to Fence (#10) */}
              {contextMenu.targetIcon.kind !== 'recycle-bin' ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const target = contextMenu.targetIcon;
                    setContextMenu(null);
                    if (target) toggleFreeDesktopPlacement(target.id);
                  }}
                >
                  {freeDesktopIconIdSet.has(contextMenu.targetIcon.id) ? (
                    <>
                      <PinOff size={13} />
                      <span>{t('Return to Fence Zone')}</span>
                    </>
                  ) : (
                    <>
                      <Pin size={13} />
                      <span>{t('Pin to Free Desktop')}</span>
                    </>
                  )}
                </button>
              ) : null}

              {/* Link / Connect Desktop Item (#14) */}
              {contextMenu.targetIcon.kind !== 'recycle-bin' ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const target = contextMenu.targetIcon;
                    setContextMenu(null);
                    if (!target) return;
                    if (pendingLinkSourceId && pendingLinkSourceId !== target.id) {
                      toggleDesktopBindingLink(pendingLinkSourceId, target.id);
                      setPendingLinkSourceId(null);
                      setLinkConnectMode(false);
                    } else {
                      setLinkConnectMode(true);
                      setPendingLinkSourceId(target.id);
                    }
                  }}
                >
                  <Link2 size={13} />
                  <span>
                    {pendingLinkSourceId && pendingLinkSourceId !== contextMenu.targetIcon.id
                      ? t('Complete Link Connection Here')
                      : t('Start Binding Line from Here')}
                  </span>
                </button>
              ) : null}

              {resolvedLineageEdges.some(
                (e) => e.fromIconId === contextMenu.targetIcon?.id || e.toIconId === contextMenu.targetIcon?.id,
              ) ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const targetId = contextMenu.targetIcon?.id ?? null;
                    setContextMenu(null);
                    setPrefs((prev) => ({ ...prev, showLineageLines: true }));
                    setHighlightedLineageNodeId(targetId);
                    setLineageInspectorOpen(true);
                  }}
                >
                  <GitBranch size={13} />
                  <span>{t('Inspect Lineage & Binding Lines')}</span>
                </button>
              ) : null}

              {desktopBindings.some(
                (b) => (b.fromId || b.sourceId) === contextMenu.targetIcon?.id || (b.toId || b.targetId) === contextMenu.targetIcon?.id,
              ) ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const targetId = contextMenu.targetIcon?.id;
                    setContextMenu(null);
                    if (targetId) {
                      setDesktopBindings((prev) =>
                        prev.filter((b) => (b.fromId || b.sourceId) !== targetId && (b.toId || b.targetId) !== targetId),
                      );
                    }
                  }}
                >
                  <X size={13} />
                  <span>{t('Clear Binding Connections')}</span>
                </button>
              ) : null}

              {contextMenu.targetIcon.kind === 'desktop-file' && contextMenu.targetIcon.resourceId ? (
                <>
                  <div className="os-context-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const resId = contextMenu.targetIcon?.resourceId;
                      setContextMenu(null);
                      const found = desktopFiles.find((f) => f.id === resId);
                      if (found) {
                        createNewDesktopFile(`Copy-${found.name}`, found.content, found.attachments);
                      }
                    }}
                  >
                    <Copy size={13} />
                    <span>{t('Duplicate desktop file')}</span>
                  </button>
                </>
              ) : null}

              {/* Recycle Bin Specific Actions (#12, #13) */}
              {contextMenu.targetIcon.kind === 'recycle-bin' ? (
                <>
                  <div className="os-context-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={recycleItems.length === 0}
                    onClick={() => {
                      setContextMenu(null);
                      emptyRecycleBin();
                    }}
                  >
                    <Trash2 size={13} />
                    <span>
                      {t('Empty Recycle Bin')} ({recycleItems.length})
                    </span>
                  </button>
                </>
              ) : contextMenu.targetIcon.variant !== 'new-action' ? (
                <>
                  <div className="os-context-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    onClick={() => {
                      const target = contextMenu.targetIcon;
                      setContextMenu(null);
                      if (target) moveIconToRecycleBin(target);
                    }}
                  >
                    <Trash2 size={13} />
                    <span>{t('Move to Recycle Bin')}</span>
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="os-context-menu-header">
                <span className="os-context-menu-header-icon">
                  <Sparkles size={14} />
                </span>
                <div className="os-context-menu-header-text">
                  <strong>{t('AgentOpsDeck OS Desktop')}</strong>
                  <small>
                    {openWindows.length} {t('windows')} · {runningCount} {t('active')}
                  </small>
                </div>
              </div>

              <div className="os-context-top-actions-row">
                <button
                  type="button"
                  role="menuitem"
                  className="os-context-refresh-btn"
                  data-testid="os-context-refresh-desktop"
                  onClick={() => handleRefreshDesktop()}
                >
                  <RefreshCw size={13} className={isRefreshingDesktop ? 'is-spinning' : ''} />
                  <span>{t('Refresh desktop')}</span>
                  <kbd>{t('F5')}</kbd>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="os-context-organize-btn"
                  data-testid="os-context-organize-icons"
                  onClick={() => handleOrganizeDesktopIcons()}
                >
                  <LayoutGrid size={13} />
                  <span>{t('Organize desktop icons')}</span>
                </button>
              </div>

              {/* Quick Create 2x2 Grid */}
              <div className="os-context-quick-grid">
                {onCreateSession ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setContextMenu(null);
                      onCreateSession();
                    }}
                  >
                    <Plus size={13} />
                    <span>{t('New session')}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setContextMenu(null);
                    createNewDesktopFile();
                  }}
                >
                  <FilePlus2 size={13} />
                  <span>{t('New desktop file')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="os-context-new-notebook"
                  onClick={() => {
                    setContextMenu(null);
                    handleOpenDesktopIcon({
                      id: 'action:new-notebook',
                      kind: 'notebook',
                      title: t('New notebook'),
                      variant: 'new-action',
                    });
                  }}
                >
                  <StickyNote size={13} />
                  <span>{t('New notebook')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="os-context-new-taskboard"
                  onClick={() => {
                    setContextMenu(null);
                    handleOpenDesktopIcon({
                      id: 'action:new-taskboard',
                      kind: 'taskboard',
                      title: t('New taskboard'),
                      variant: 'new-action',
                    });
                  }}
                >
                  <Kanban size={13} />
                  <span>{t('New taskboard')}</span>
                </button>
              </div>

              {selectedIconIds.size > 1 ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setContextMenu(null);
                    icons
                      .filter((ic) => selectedIconIds.has(ic.id))
                      .forEach((ic) => handleOpenDesktopIcon(ic));
                  }}
                >
                  <Sparkles size={13} />
                  <span>
                    {t('Open selected items')} ({selectedIconIds.size})
                  </span>
                </button>
              ) : null}

              <div className="os-context-menu-divider" />

              {/* View & Icon Size Segmented Row */}
              <div className="os-context-segmented-group">
                <span className="os-context-group-label">{t('View & Icon Size')}</span>
                <div className="os-context-pill-bar">
                  {(['sm', 'md', 'lg'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      className={`os-context-pill${prefs.iconSize === sz ? ' is-active' : ''}`}
                      onClick={() => setPrefs((prev) => ({ ...prev, iconSize: sz }))}
                    >
                      {sz.toUpperCase()}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`os-context-pill${prefs.fencesEnabled !== false ? ' is-active' : ''}`}
                    onClick={() =>
                      setPrefs((prev) => ({ ...prev, fencesEnabled: prev.fencesEnabled === false }))
                    }
                    title={t('Toggle Stardock Fences vs Free Icon Grid')}
                  >
                    {prefs.fencesEnabled !== false ? t('Fences') : t('Free Grid')}
                  </button>
                </div>
              </div>

              {/* Sort By Segmented Row */}
              <div className="os-context-segmented-group">
                <span className="os-context-group-label">{t('Sort By')}</span>
                <div className="os-context-pill-bar">
                  {(['default', 'name', 'status', 'kind'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`os-context-pill${prefs.sortBy === s ? ' is-active' : ''}`}
                      onClick={() => setSortBy(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="os-context-menu-divider" />

              {/* Lineage & Binding Lines Controls */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const nextVisible = prefs.showLineageLines === false;
                  setContextMenu(null);
                  setPrefs((prev) => ({
                    ...prev,
                    showLineageLines: nextVisible,
                  }));
                  if (!nextVisible) {
                    setLinkConnectMode(false);
                    setPendingLinkSourceId(null);
                  }
                }}
              >
                <GitBranch size={13} />
                <span>
                  {prefs.showLineageLines !== false
                    ? t('Hide Lineage & Binding Lines')
                    : t('Show Lineage & Binding Lines')}
                  {resolvedLineageEdges.length > 0 ? ` (${resolvedLineageEdges.length})` : ''}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setLineageInspectorOpen(true);
                }}
              >
                <Link2 size={13} />
                <span>
                  {t('Lineage & Connections Inspector…')}
                  {resolvedLineageEdges.length > 0 ? ` (${resolvedLineageEdges.length})` : ''}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setPrefs((prev) => ({ ...prev, showLineageLines: true }));
                  setLinkConnectMode((v) => !v);
                  setPendingLinkSourceId(null);
                }}
              >
                <Sparkles size={13} />
                <span>{t('Connect / Link Desktop Items')}</span>
              </button>

              <div className="os-context-menu-divider" />

              {/* Window & Fence Organization */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  tileWindows();
                }}
              >
                <Grid2X2 size={13} />
                <span>{t('Tile windows')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  cascadeWindows();
                }}
              >
                <Layers size={13} />
                <span>{t('Cascade windows')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleOrganizeDesktopIcons()}
              >
                <RotateCcw size={13} />
                <span>{t('Reset Fences & Icon Positions')}</span>
              </button>

              <div className="os-context-menu-divider" />

              {/* Multi-Screen Window Placement Quick Actions */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  void refreshDetectedScreens(true).then(async (screens) => {
                    const target = screens.find((s) => !s.isPrimary) ?? screens[0];
                    await requestFullscreenOnScreen(document.documentElement, target);
                  });
                }}
              >
                <Maximize2 size={13} />
                <span>{t('Multi-Screen Fullscreen (requestFullscreen)')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setSettingsTab('displays');
                  setSettingsOpen(true);
                  void refreshDetectedScreens(true);
                }}
              >
                <Monitor size={13} />
                <span>{t('Multi-Screen Window Placement Settings…')}</span>
              </button>

              <div className="os-context-menu-divider" />

              {/* Personalization & System Settings */}
              <button
                type="button"
                role="menuitem"
                data-testid="os-context-wechat-messenger"
                onClick={() => {
                  setContextMenu(null);
                  openWechatMessenger();
                }}
              >
                <MessageSquare size={13} />
                <span>{t("Chat Studio")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="os-context-theme-toggle"
                onClick={() => {
                  setContextMenu(null);
                  setColorMode(toggleWorkspaceColorMode());
                }}
              >
                {colorMode === "dark" ? <Sun size={13} /> : <Moon size={13} />}
                <span>
                  {colorMode === "dark" ? t("Switch to Light Mode") : t("Switch to Dark Mode")}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setSettingsTab('wallpaper');
                  setSettingsOpen(true);
                }}
              >
                <Palette size={13} />
                <span>{t('Personalize & Custom Wallpaper…')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setSettingsOpen(true);
                }}
              >
                <Settings size={13} />
                <span>{t('System Settings Center…')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  triggerExitDesktopWithAnimation();
                }}
              >
                <Power size={13} />
                <span>{t('Exit to Classic Tiling View')}</span>
              </button>
            </>
          )}
        </div>
      ) : null}

      {wechatContextMenu && wechatOpen ? (
        <div
          ref={osWechatMenuRef}
          className="os-desktop-context-menu is-redesigned os-wechat-context-menu"
          data-testid="os-wechat-context-menu"
          role="menu"
          style={{
            position: "fixed",
            left: wechatContextMenu.x,
            top: wechatContextMenu.y,
            zIndex: 12000,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e) => handleContextMenuKeyDown(e, () => setWechatContextMenu(null))}
        >
          <div className="os-context-menu-header">
            <span className="os-context-menu-header-icon">
              <Bot size={14} />
            </span>
            <div className="os-context-menu-header-text">
              <strong>{wechatContextMenu.session.title || wechatContextMenu.session.sessionKey}</strong>
              <small>
                {wechatPinnedKeys.includes(wechatContextMenu.session.sessionKey)
                  ? t("Pinned Session")
                  : t("Session Actions")}
              </small>
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="os-wechat-ctx-pin"
            onClick={() => {
              toggleWechatPinSession(wechatContextMenu.session.sessionKey);
              setWechatContextMenu(null);
            }}
          >
            {wechatPinnedKeys.includes(wechatContextMenu.session.sessionKey) ? (
              <>
                <PinOff size={13} />
                <span>{t("Unpin session")}</span>
              </>
            ) : (
              <>
                <Pin size={13} />
                <span>{t("Pin session to top")}</span>
              </>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="os-wechat-ctx-select"
            onClick={() => {
              selectWechatSession(wechatContextMenu.session);
              setWechatContextMenu(null);
            }}
          >
            <MessageSquare size={13} />
            <span>{t("Open in Chat Studio")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="os-wechat-ctx-popout"
            onClick={() => {
              popOutWechatSessionToWindow(wechatContextMenu.session);
              setWechatContextMenu(null);
            }}
          >
            <ExternalLink size={13} />
            <span>{t("Pop out to standalone window")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="os-wechat-ctx-lineage"
            onClick={() => {
              const sKey = wechatContextMenu.session.sessionKey;
              setWechatContextMenu(null);
              setPrefs((prev) => ({ ...prev, showLineageLines: true }));
              setHighlightedLineageNodeId(`session:${sKey}`);
              setLineageInspectorOpen(true);
            }}
          >
            <GitBranch size={13} />
            <span>{t("View Lineage / Links")}</span>
          </button>
          <div className="os-context-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            data-testid="os-wechat-ctx-delete"
            onClick={() => {
              const s = wechatContextMenu.session;
              setWechatContextMenu(null);
              setWechatPinnedKeys((prev) => prev.filter((k) => k !== s.sessionKey));
              moveIconToRecycleBin({
                id: `session:${s.sessionKey}`,
                kind: "session",
                title: s.title || s.sessionKey,
                subtitle: s.sessionRef?.runtimeId || s.agentId || "codex",
                session: s,
              });
            }}
          >
            <Trash2 size={13} />
            <span>{t("Move to Recycle Bin")}</span>
          </button>
        </div>
      ) : null}

      {/* OS System Settings & Personalization Center Window */}
      {settingsOpen ? (
        <div
          className={`os-desktop-settings-window${topSurfaceId === 'sys:settings' ? ' is-active' : ''}`}
          data-os-window="sys:settings"
          data-testid="os-system-settings-window"
          role="dialog"
          aria-label={t('System Settings')}
          style={{
            left: settingsPos.x,
            top: settingsPos.y,
            width: settingsPos.width,
            height: settingsPos.height,
            zIndex: getSurfaceZIndex("sys:settings", false),
          }}
          onPointerDownCapture={() => bringSurfaceToFront("sys:settings")}
          onFocusCapture={() => bringSurfaceToFront("sys:settings")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header
            className="os-window-titlebar"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              settingsDragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: settingsPos.x,
                origY: settingsPos.y,
              };
            }}
            onPointerMove={(e) => {
              const d = settingsDragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const nx = Math.max(8, Math.min(surfaceWidth - 260, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(4, Math.min(surfaceHeight - 100, d.origY + (e.clientY - d.startY)));
              setSettingsPos((prev) => ({ ...prev, x: Math.round(nx), y: Math.round(ny) }));
            }}
            onPointerUp={(e) => {
              if (settingsDragRef.current?.pointerId === e.pointerId) {
                settingsDragRef.current = null;
              }
            }}
          >
            <div className="os-window-title">
              <Settings size={14} />
              <strong>{t('System Settings & Control Center')}</strong>
              <span className="os-window-running-pill">{`OS v${AGENTOPSDECK_VERSION} · ${AGENTOPSDECK_BUILD.buildNumber}`}</span>
            </div>
            <div className="os-window-controls">
              <button
                type="button"
                aria-label={t('Close')}
                onClick={() => setSettingsOpen(false)}
              >
                <X size={13} />
              </button>
            </div>
          </header>

          <div className="os-settings-body">
            <aside className="os-settings-sidebar" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'wallpaper'}
                className={`os-settings-nav-btn${settingsTab === 'wallpaper' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('wallpaper')}
              >
                <Palette size={14} />
                <span>{t('Wallpaper & Theme')}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'desktop'}
                className={`os-settings-nav-btn${settingsTab === 'desktop' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('desktop')}
              >
                <LayoutGrid size={14} />
                <span>{t('Desktop & Fences')}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'displays'}
                className={`os-settings-nav-btn${settingsTab === 'displays' ? ' is-active' : ''}`}
                onClick={() => {
                  setSettingsTab('displays');
                  void refreshDetectedScreens(false);
                }}
              >
                <Monitor size={14} />
                <span>{t('Multi-Screen Displays')}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'dock'}
                className={`os-settings-nav-btn${settingsTab === 'dock' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('dock')}
              >
                <SlidersHorizontal size={14} />
                <span>{t('Dock & Telemetry')}</span>
              </button>
              <button
                type="button"
                role="tab"
                data-testid="os-settings-tab-access"
                aria-selected={settingsTab === 'access'}
                className={`os-settings-nav-btn${settingsTab === 'access' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('access')}
              >
                <ShieldCheck size={14} />
                <span>{t('Access & Users')}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'sandbox'}
                className={`os-settings-nav-btn${settingsTab === 'sandbox' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('sandbox')}
              >
                <Server size={14} />
                <span>{t('Docker + Codex Sandbox')}</span>
              </button>
            </aside>

            <div className="os-settings-content">
              {settingsTab === 'wallpaper' ? (
                <div className="os-settings-pane" data-testid="os-settings-pane-wallpaper">
                  <div className="os-settings-section">
                    <h4>{t("Appearance Mode (Dark / Light)")}</h4>
                    <div className="os-settings-preset-row">
                      <button
                        type="button"
                        data-testid="os-settings-color-mode-dark"
                        className={`os-settings-action-btn${colorMode === "dark" ? " is-active" : ""}`}
                        onClick={() => setColorMode(writeWorkspaceColorMode("dark"))}
                      >
                        <Moon size={13} />
                        <span>{t("Dark Mode")}</span>
                        {colorMode === "dark" ? <Check size={12} /> : null}
                      </button>
                      <button
                        type="button"
                        data-testid="os-settings-color-mode-light"
                        className={`os-settings-action-btn${colorMode === "light" ? " is-active" : ""}`}
                        onClick={() => setColorMode(writeWorkspaceColorMode("light"))}
                      >
                        <Sun size={13} />
                        <span>{t("Light Mode")}</span>
                        {colorMode === "light" ? <Check size={12} /> : null}
                      </button>
                    </div>
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('Built-in Desktop Themes')}</h4>
                    <div className="os-settings-theme-grid">
                      {WALLPAPER_THEMES.map((theme) => (
                        <button
                          key={theme}
                          type="button"
                          className={`os-settings-theme-card theme-preview-${theme}${wallpaper === theme ? ' is-active' : ''}`}
                          onClick={() => selectBuiltInWallpaper(theme)}
                        >
                          <span className="os-settings-theme-swatch" />
                          <span className="os-settings-theme-name">{theme}</span>
                          {wallpaper === theme ? <Check size={12} /> : null}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('Custom Wallpaper Image or Local Upload')}</h4>
                    <div className="os-settings-input-row">
                      <input
                        name="os-custom-wallpaper-url"
                        type="url"
                        className="os-settings-text-input"
                        placeholder={t('https://example.com/wallpaper.jpg or data:image/...')}
                        value={wallpaperConfig.customImageUrl ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setWallpaper('custom');
                          setWallpaperConfig((prev) => ({
                            ...prev,
                            theme: 'custom',
                            customImageUrl: val,
                          }));
                        }}
                      />
                      <input
                        ref={wallpaperFileInputRef}
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            if (typeof reader.result === 'string') {
                              setWallpaper('custom');
                              setWallpaperConfig((prev) => ({
                                ...prev,
                                theme: 'custom',
                                customImageUrl: reader.result as string,
                              }));
                            }
                          };
                          reader.readAsDataURL(file);
                        }}
                      />
                      <button
                        type="button"
                        className="os-settings-action-btn"
                        onClick={() => wallpaperFileInputRef.current?.click()}
                      >
                        <Upload size={13} />
                        <span>{t('Upload Image')}</span>
                      </button>
                    </div>
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('Custom Atmosphere Gradients')}</h4>
                    <div className="os-settings-preset-row">
                      {CUSTOM_GRADIENT_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          className="os-settings-action-btn"
                          onClick={() => {
                            setWallpaper('custom');
                            setWallpaperConfig((prev) => ({
                              ...prev,
                              theme: 'custom',
                              customImageUrl: '',
                              customGradient: preset.value,
                            }));
                          }}
                        >
                          <Sparkles size={12} />
                          <span>{preset.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="os-settings-section os-settings-controls-grid">
                    <label className="os-settings-field">
                      <span>{t('Image Fit')}</span>
                      <div className="os-context-pill-bar">
                        {(['cover', 'contain', 'fill'] as const).map((fitMode: DesktopWallpaperFit) => (
                          <button
                            key={fitMode}
                            type="button"
                            className={`os-context-pill${(wallpaperConfig.fit ?? 'cover') === fitMode ? ' is-active' : ''}`}
                            onClick={() =>
                              setWallpaperConfig((prev) => ({ ...prev, fit: fitMode }))
                            }
                          >
                            {fitMode}
                          </button>
                        ))}
                      </div>
                    </label>
                    <label className="os-settings-field">
                      <span>
                        {t('Dim Overlay')}: {wallpaperConfig.dimOpacity ?? 24}%
                      </span>
                      <input
                        name="os-wallpaper-dim"
                        type="range"
                        min={0}
                        max={85}
                        value={wallpaperConfig.dimOpacity ?? 24}
                        onChange={(e) =>
                          setWallpaperConfig((prev) => ({
                            ...prev,
                            dimOpacity: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                    <label className="os-settings-field">
                      <span>
                        {`${t('Backdrop Blur')}: ${wallpaperConfig.blurPx ?? 0}px`}
                      </span>
                      <input
                        name="os-wallpaper-blur"
                        type="range"
                        min={0}
                        max={24}
                        value={wallpaperConfig.blurPx ?? 0}
                        onChange={(e) =>
                          setWallpaperConfig((prev) => ({
                            ...prev,
                            blurPx: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              {settingsTab === 'desktop' ? (
                <div className="os-settings-pane" data-testid="os-settings-pane-desktop">
                  <div className="os-settings-section">
                    <h4>{t('Desktop Layout Mode')}</h4>
                    <div className="os-settings-preset-row">
                      <button
                        type="button"
                        className={`os-settings-action-btn${prefs.fencesEnabled !== false ? ' is-active' : ''}`}
                        onClick={() => setPrefs((prev) => ({ ...prev, fencesEnabled: true }))}
                      >
                        <Columns2 size={13} />
                        <span>{t('Stardock Fences Mode (Grouped Zones)')}</span>
                      </button>
                      <button
                        type="button"
                        className={`os-settings-action-btn${prefs.fencesEnabled === false ? ' is-active' : ''}`}
                        onClick={() => setPrefs((prev) => ({ ...prev, fencesEnabled: false }))}
                      >
                        <LayoutGrid size={13} />
                        <span>{t('Free Icon Grid (Drag anywhere up to top edge)')}</span>
                      </button>
                    </div>
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('Icon Scale & Visibility')}</h4>
                    <div className="os-settings-preset-row">
                      {(['sm', 'md', 'lg'] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          className={`os-settings-action-btn${prefs.iconSize === sz ? ' is-active' : ''}`}
                          onClick={() => setPrefs((prev) => ({ ...prev, iconSize: sz }))}
                        >
                          <span>{sz.toUpperCase()}</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="os-settings-action-btn"
                        onClick={() =>
                          setPrefs((prev) => ({ ...prev, showDesktopIcons: !prev.showDesktopIcons }))
                        }
                      >
                        {prefs.showDesktopIcons ? <EyeOff size={13} /> : <Eye size={13} />}
                        <span>
                          {prefs.showDesktopIcons ? t('Hide Desktop Icons') : t('Show Desktop Icons')}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`os-settings-action-btn${prefs.showLineageLines !== false ? ' is-active' : ''}`}
                        onClick={() =>
                          setPrefs((prev) => ({
                            ...prev,
                            showLineageLines: prev.showLineageLines === false,
                          }))
                        }
                      >
                        <GitBranch size={13} />
                        <span>
                          {prefs.showLineageLines !== false
                            ? t('Hide Lineage & Binding Lines')
                            : t('Show Lineage & Binding Lines')}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('Reset Desktop Geometry')}</h4>
                    <div className="os-settings-preset-row">
                      <button
                        type="button"
                        className="os-settings-action-btn"
                        onClick={() => {
                          resetFencePositions();
                          setIconPositions({});
                        }}
                      >
                        <RotateCcw size={13} />
                        <span>{t('Reset Fences & Icon Positions to Top')}</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === 'displays' ? (
                <div className="os-settings-pane" data-testid="os-settings-pane-displays">
                  <div className="os-settings-section">
                    <div className="os-settings-section-head">
                      <div>
                        <h4>{t('Multi-Screen Window Placement API')}</h4>
                        <p className="os-settings-hint">
                          {screenApiSupported
                            ? t('Browser supports native getScreenDetails(), screenschange, moveTo(), and requestFullscreen({ screen }).')
                            : t('Fallback single-screen mode active (window.getScreenDetails available on Chromium 100+).')}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="os-settings-action-btn is-primary"
                        data-testid="os-settings-detect-screens-btn"
                        onClick={() => {
                          void refreshDetectedScreens(true).then((screens) => {
                            setScreenStatusMsg(
                              `${t('Detected')} ${screens.length} ${t('display(s)')}`,
                            );
                          });
                        }}
                      >
                        <RefreshCw size={13} />
                        <span>{t('Authorize & Detect Displays (getScreenDetails)')}</span>
                      </button>
                    </div>
                    {screenStatusMsg ? (
                      <div className="os-settings-status-banner">{screenStatusMsg}</div>
                    ) : null}
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('Detected Monitors')} ({detectedScreens.length})</h4>
                    <div className="os-settings-displays-list">
                      {detectedScreens.map((scr, idx) => (
                        <div key={scr.id ?? idx} className="os-settings-display-card">
                          <div className="os-settings-display-info">
                            <Monitor size={18} />
                            <div>
                              <strong>
                                {scr.label || t('Display {index}', { index: idx + 1 })}
                                {scr.isPrimary ? ` (${t('Primary')})` : ` (${t('Extended')})`}
                              </strong>
                              <small>
                                {scr.width}×{scr.height} @ ({scr.left}, {scr.top})
                                {scr.devicePixelRatio ? ` · ${scr.devicePixelRatio}x DPI` : ''}
                              </small>
                            </div>
                          </div>
                          <div className="os-settings-display-actions">
                            <button
                              type="button"
                              className="os-settings-action-btn"
                              title={t('Fullscreen Here')}
                              onClick={() => {
                                void requestFullscreenOnScreen(document.documentElement, scr).then(
                                  (ok) => {
                                    setScreenStatusMsg(
                                      ok
                                        ? `${t('Fullscreen active on')} ${scr.label || scr.id || idx + 1}`
                                        : 'Fullscreen request declined',
                                    );
                                  },
                                );
                              }}
                            >
                              <Maximize2 size={12} />
                              <span>{t('Fullscreen Here')}</span>
                            </button>
                            <button
                              type="button"
                              className="os-settings-action-btn"
                              title={t('Move Window Here')}
                              onClick={() => {
                                const moved = moveWindowToScreen(window, scr);
                                setScreenStatusMsg(
                                  moved
                                    ? `${t('Moved window to')} ${scr.label || scr.id}`
                                    : t('Popup/standalone window required for window.moveTo()'),
                                );
                              }}
                            >
                              <ExternalLink size={12} />
                              <span>{t('Move Window Here')}</span>
                            </button>
                            <button
                              type="button"
                              className="os-settings-action-btn"
                              onClick={() => {
                                const url = buildProjectionUrl(window.location.origin, window.location.pathname, {
                                  paneId: `screen-${idx + 1}`,
                                  kind: 'session',
                                  title: scr.label || `Display ${idx + 1}`,
                                  targetScreenIndex: idx,
                                });
                                openCompanionWindowOnScreen(url, `agentopsdeck_screen_${idx + 1}`, scr);
                              }}
                            >
                              <Columns2 size={12} />
                              <span>{t('Open Companion Window')}</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === 'dock' ? (
                <div className="os-settings-pane" data-testid="os-settings-pane-dock">
                  <div className="os-settings-section">
                    <h4>{t('Quick Session Dock')}</h4>
                    <p className="os-settings-hint">
                      {t('When detached into floating mode, drag any edge or bottom corner of the Quick Session Dock to resize freely.')}
                    </p>
                    <div className="os-settings-preset-row">
                      <button
                        type="button"
                        className={`os-settings-action-btn${qqDocked ? ' is-active' : ''}`}
                        onClick={() => setQqDocked(true)}
                      >
                        <PanelRight size={13} />
                        <span>{t('Dock to Right Edge (Auto-Hide)')}</span>
                      </button>
                      <button
                        type="button"
                        className={`os-settings-action-btn${!qqDocked ? ' is-active' : ''}`}
                        onClick={() => setQqDocked(false)}
                      >
                        <MessageSquare size={13} />
                        <span>{t('Detach as Resizable Floating Window')}</span>
                      </button>
                      <button
                        type="button"
                        className="os-settings-action-btn"
                        onClick={() => setQqSize({ width: 292, height: 480 })}
                      >
                        <RotateCcw size={13} />
                        <span>
                          {t('Reset Dock Size')} ({qqSize.width}×{qqSize.height})
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="os-settings-section">
                    <h4>{t('System Telemetry HUD')}</h4>
                    <div className="os-settings-preset-row">
                      <button
                        type="button"
                        className={`os-settings-action-btn${hudOpen ? ' is-active' : ''}`}
                        onClick={() => setHudOpen((v) => { const next = !v; if (next) bringSurfaceToFront("sys:hud"); return next; })}
                      >
                        <Gauge size={13} />
                        <span>{hudOpen ? t('Telemetry HUD Enabled') : t('Telemetry HUD Hidden')}</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === 'access' ? (
                <div className="os-settings-pane" data-testid="os-settings-pane-access">
                  <div className="os-settings-section">
                    <div className="os-settings-section-head">
                      <div>
                        <h4>{t('Unified Hub & Connector Access Center')}</h4>
                        <p className="os-settings-hint">
                          {t('Manage Hub users, Connector node users, login keys, and 1-click role permissions with versioned safety.')}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="os-settings-action-btn"
                        disabled={accessBusy}
                        onClick={() => setAccessReloadNonce((v) => v + 1)}
                      >
                        <RefreshCw size={13} />
                        <span>{t('Refresh Access')}</span>
                      </button>
                    </div>
                    {accessStatusMsg ? (
                      <div className="os-settings-status-banner">{accessStatusMsg}</div>
                    ) : null}
                  </div>

                  {/* Section 1: Hub Users & Login Keys */}
                  <div className="os-settings-section">
                    <h4>
                      <Users size={14} style={{ display: 'inline', marginRight: 6 }} />
                      {t('1. Hub Users & Login Keys')} ({accessHubUsers.length})
                    </h4>
                    <form
                      className="os-settings-input-row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const label = accessNewUserName.trim();
                        if (!label || accessBusy || accessPending.current || !accessDirectoryReady || !accessCurrent()) return;
                        accessPending.current = true;
                        setAccessBusy(true);
                        void writeCurrentAccess(accessCurrent, () => api.hubCreateUser({ label }))
                          .then((res) => {
                            if (!res || !accessCurrent()) return;
                            setAccessNewUserName('');
                            // If a previously deleted user ID is re-created, ensure it is un-deleted
                            if (accessDeletedUsers.hubUserIds.includes(res.user.id)) {
                              const nextDel = writeDesktopDeletedUsers(storageScope, {
                                ...accessDeletedUsers,
                                hubUserIds: accessDeletedUsers.hubUserIds.filter((id) => id !== res.user.id),
                              });
                              setAccessDeletedUsers(nextDel);
                            }
                            setAccessSelectedUserId(res.user.id);
                            setAccessStatusMsg(`${t('Created Hub user')}: ${res.user.label}`);
                            setAccessReloadNonce((v) => v + 1);
                          })
                          .catch((err: unknown) => {
                            if (accessCurrent()) setAccessStatusMsg(err instanceof Error ? err.message : t('Failed to create Hub user'));
                          })
                          .finally(() => { accessPending.current = false; if (accessMounted.current) setAccessBusy(false); });
                      }}
                    >
                      <input
                        name="os-access-new-hub-user"
                        type="text"
                        className="os-settings-text-input"
                        placeholder={t('New Hub user name (e.g. alice, bob-dev)...')}
                        value={accessNewUserName}
                        onChange={(e) => setAccessNewUserName(e.target.value)}
                      />
                      <button type="submit" className="os-settings-action-btn is-primary" disabled={!accessNewUserName.trim() || accessBusy || !accessDirectoryReady}>
                        <Plus size={13} />
                        <span>{t('Create Hub User')}</span>
                      </button>
                    </form>

                    <div className="os-access-user-pills">
                      {accessHubUsers.map((u) => {
                        const isSel = u.id === accessSelectedUserId;
                        const isProtectedOwner = u.id === 'default' || u.id === accessPrincipalUserId;
                        return (
                          <div
                            key={u.id}
                            data-testid={`os-access-user-card-${u.id}`}
                            className={`os-access-user-card${isSel ? ' is-active' : ''}`}
                            onClick={() => setAccessSelectedUserId(u.id)}
                          >
                            <div className="os-access-user-info">
                              <strong>
                                {u.label}
                                {isProtectedOwner ? (
                                  <span className="os-access-owner-tag">{t('Current / Owner')}</span>
                                ) : null}
                              </strong>
                              <small>{u.id}</small>
                            </div>
                            <div className="os-access-user-actions">
                              <button
                                type="button"
                                className={`os-settings-action-btn${isSel ? ' is-active' : ''}`}
                                title={t('Configure Permissions')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAccessSelectedUserId(u.id);
                                }}
                              >
                                <ShieldCheck size={12} />
                                <span>{isSel ? t('Configuring') : t('Configure Permissions')}</span>
                              </button>
                              <button
                                type="button"
                                className="os-settings-action-btn"
                                title={t('Issue Login Key')}
                                disabled={accessBusy || !accessDirectoryReady}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (accessBusy || accessPending.current || !accessDirectoryReady || !accessCurrent()) return;
                                  accessPending.current = true; setAccessBusy(true);
                                  setAccessIssuedKey(null);
                                  void writeCurrentAccess(accessCurrent, () => api.hubIssueLoginKey(u.id))
                                    .then((res) => {
                                      if (!res || !accessCurrent()) return;
                                      setAccessIssuedKey({ userId: u.id, token: res.token, identity: accessCredentialIdentity });
                                      setAccessStatusMsg(`${t('Issued login key for')} ${u.label}`);
                                    })
                                    .catch((err: unknown) => {
                                      if (accessCurrent()) setAccessStatusMsg(err instanceof Error ? err.message : t('Failed to issue login key'));
                                    })
                                    .finally(() => { accessPending.current = false; if (accessMounted.current) setAccessBusy(false); });
                                }}
                              >
                                <KeyRound size={12} />
                                <span>{t('Issue Key')}</span>
                              </button>
                              {!isProtectedOwner ? (
                                <button
                                  type="button"
                                  data-testid={`os-access-delete-user-${u.id}`}
                                  className="os-settings-action-btn is-danger"
                                  title={t('Revoke reviewed access')}
                                  disabled={accessBusy || !accessDir || !accessDirectoryReady}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (accessPending.current || !accessDir || !accessDirectoryReady || !accessCurrent()) return;
                                    accessPending.current = true;
                                    setAccessBusy(true);
                                    void (async () => {
                                      try {
                                        const result = await revokeReviewedAccess(api, u.id, accessDir.connections, accessCurrent,
                                          summary => confirmAction({ title: `${t('Revoke reviewed access')}: ${u.label}`,
                                            description: `${t('Revoke listed login keys and Connector memberships? This is not user deletion or global suspension. Partial failures retain the user; no changes are automatically retried.')}\n${t('Login keys')}: ${summary.keys}\n${t('Connectors')}: ${summary.memberships}\n${t('Legacy authorizations')}: ${summary.legacy}\n${t('Downgrade Hub admin')}: ${summary.demote ? t('Yes') : t('No')}`,
                                            confirmLabel: t('Revoke reviewed access') }));
                                        if (result && accessCurrent()) {
                                          setAccessIssuedKey(prev => prev?.userId === u.id ? null : prev);
                                          setAccessStatusMsg(`${t('Reviewed access changes confirmed; user retained')}: ${u.label} (${result.confirmed}/${result.total})`);
                                          setAccessReloadNonce(v => v + 1);
                                        }
                                      } catch (err: unknown) {
                                        if (accessCurrent()) setAccessStatusMsg(err instanceof Error ? err.message : t('Access changes stopped; refresh and review'));
                                      } finally {
                                        accessPending.current = false;
                                        if (accessMounted.current) setAccessBusy(false);
                                      }
                                    })();
                                  }}
                                >
                                  <Trash2 size={12} />
                                  <span>{t('Revoke reviewed access')}</span>
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {accessIssuedKey && accessIssuedKey.identity === accessCredentialIdentity ? (
                      <div className="os-access-key-banner" data-testid="os-access-issued-key">
                        <div>
                          <strong>{t('One-Time Login Key')} ({accessIssuedKey.userId}):</strong>
                          <code>{accessIssuedKey.token}</code>
                        </div>
                        <button
                          type="button"
                          className="os-settings-action-btn"
                          onClick={() => {
                            if (accessIssuedKey.identity !== accessCredentialIdentity) return;
                            void copyCurrentAccessKey(accessCurrent, accessIssuedKey.token, navigator.clipboard)
                              .then(copied => { if (copied && accessCurrent()) setAccessStatusMsg(t('Copied login key to clipboard')); })
                              .catch(() => { if (accessCurrent()) setAccessStatusMsg(t('Failed to copy login key')); });
                          }}
                        >
                          <Copy size={12} />
                          <span>{t('Copy')}</span>
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {/* Section 2: Selected User Role Matrix (Hub Role + Per-Connector 1-Click Role) */}
                  <div className="os-settings-section">
                    <div className="os-settings-section-head">
                      <div>
                        <h4>
                          <ShieldCheck size={14} style={{ display: 'inline', marginRight: 6 }} />
                          {t('2. Quick Permission Matrix')}
                        </h4>
                        <p className="os-settings-hint">
                          {t('Select a target user below, then click any role button to immediately grant or revoke Connector & Runtime permissions.')}
                        </p>
                      </div>
                      {accessUserHubRole && accessSelectedUserId && accessHubRoleGeneration === accessView.generation ? (
                        <div className="os-settings-preset-row" role="group" aria-label={t('Hub Role')}>
                          {(['member', 'admin'] as const).map((hRole) => (
                            <button
                              key={hRole}
                              type="button"
                              disabled={accessBusy}
                              className={`os-access-role-btn${accessUserHubRole.role === hRole ? ' is-active' : ''}`}
                              onClick={() => {
                                if (accessUserHubRole.role === hRole || accessPending.current || !accessCurrent()) return;
                                accessPending.current = true; setAccessBusy(true);
                                void api
                                  .saveHubRole(accessSelectedUserId, {
                                    role: hRole,
                                    version: accessUserHubRole.version,
                                  })
                                  .then((saved) => {
                                    if (!accessCurrent()) return;
                                    setAccessUserHubRole(saved);
                                    setAccessStatusMsg(`${t('Updated Hub role to')} ${hRole}`);
                                    setAccessReloadNonce((v) => v + 1);
                                  })
                                  .catch((err: unknown) => {
                                    if (accessCurrent()) {
                                      setAccessUserHubRole(null);
                                      setAccessStatusMsg(err instanceof Error ? err.message : t('Cannot change own or protected Hub role'));
                                    }
                                  })
                                  .finally(() => {
                                    accessPending.current = false;
                                    if (accessMounted.current) setAccessBusy(false);
                                  });
                              }}
                            >
                              {accessUserHubRole.role === hRole ? <Check size={12} /> : null}
                              <span>{hRole === 'admin' ? t('Hub Admin') : t('Hub Member')}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {/* Explicit Target User Selector Bar inside Section 2 */}
                    <div className="os-access-target-selector-bar" data-testid="os-access-target-selector-bar">
                      <label className="os-access-target-label" htmlFor="os-access-target-user-select">
                        {t('Configure permissions for user')}:
                      </label>
                      <select
                        id="os-access-target-user-select"
                        name="os-access-target-user-select"
                        data-testid="os-access-target-user-select"
                        className="os-access-target-select"
                        value={accessSelectedUserId}
                        onChange={(e) => setAccessSelectedUserId(e.target.value)}
                      >
                        {accessHubUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.label} ({u.id})
                          </option>
                        ))}
                      </select>
                      <div className="os-access-target-quick-tabs">
                        {accessHubUsers.map((u) => {
                          const active = u.id === accessSelectedUserId;
                          return (
                            <button
                              key={u.id}
                              type="button"
                              data-testid={`os-access-matrix-user-tab-${u.id}`}
                              className={`os-access-role-btn${active ? ' is-active' : ''}`}
                              onClick={() => setAccessSelectedUserId(u.id)}
                            >
                              {active ? <Check size={11} /> : <Users size={11} />}
                              <span>{u.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {accessSelectedUserId ? (
                      <div className="os-access-matrix-list">
                        {(accessDir?.connections ?? []).map((conn: AccessConnection) => {
                          const key = `${conn.ownerUserId}:${conn.id}`;
                          const mem = accessSnapshotGeneration === accessView.generation ? accessMemberships[key] : undefined;
                          const isOwnerOrInherited =
                            conn.ownerUserId === accessSelectedUserId ||
                            mem?.inherited === 'owner' ||
                            mem?.inherited === 'hub-admin';
                          const currentRole: ConnectorRole =
                            mem?.role ?? (isOwnerOrInherited ? 'admin' : 'none');
                          const codexMode =
                            mem?.environments.codex ?? (isOwnerOrInherited ? 'developer' : 'disabled');
                          const openclawMode =
                            mem?.environments.openclaw ?? (isOwnerOrInherited ? 'observer' : 'disabled');
                          const canEditRole = Boolean(accessDirectoryReady && mem?.editable && mem.grantSetDigest);
                          const applyQuickRole = (nextRole: ConnectorRole) => {
                            if (!canEditRole || !mem?.grantSetDigest || !accessCurrent() || accessPending.current) {
                              setAccessStatusMsg(
                                t('This user is the Connector Owner or Hub Admin and inherently holds full permissions. Select or create a member user above to configure granular roles.'),
                              );
                              return;
                            }
                            accessPending.current = true; setAccessBusy(true);
                            const reviewedDigest = mem.grantSetDigest;
                            const nextCodex =
                              nextRole === 'admin' || nextRole === 'developer'
                                ? 'developer'
                                : nextRole === 'observer'
                                  ? 'observer'
                                  : 'disabled';
                            const nextOpenclaw =
                              nextRole === 'admin' || nextRole === 'observer' ? 'observer' : 'disabled';
                            void (async () => {
                              if (mem.legacyCount > 0 && !await confirmAction({ title: t('Review legacy authorization conversion'),
                                description: `${conn.label}: ${mem.legacyCount} ${t('Legacy authorizations')}\n${t('Replace reviewed grants with the selected role? Dependent shares may be revoked.')}`,
                                confirmLabel: t('Apply') })) return null;
                              if (!accessCurrent()) return null;
                              return api.saveConnectorMembership(conn, accessSelectedUserId, {
                                role: nextRole,
                                environments: { codex: nextCodex, openclaw: nextOpenclaw },
                                version: mem.version,
                                nodeVersion: conn.nodeVersion,
                                migrateLegacy: mem.legacyCount > 0,
                                grantSetDigest: reviewedDigest,
                              });
                            })()
                              .then((updated) => {
                                if (!updated || !accessCurrent()) return;
                                setAccessMemberships((prev) => ({ ...prev, [key]: updated }));
                                setAccessStatusMsg(`${conn.label}: ${t('Applied role')} ${nextRole}`);
                              })
                              .catch((err: unknown) => {
                                if (accessCurrent()) {
                                  setAccessMemberships(prev => { const next = { ...prev }; delete next[key]; return next; });
                                  setAccessStatusMsg(err instanceof Error ? err.message : t('Failed to update Connector role'));
                                }
                              })
                              .finally(() => {
                                accessPending.current = false;
                                if (accessMounted.current) setAccessBusy(false);
                              });
                          };
                          return (
                            <div key={key} className="os-access-matrix-row" data-testid={`os-access-matrix-row-${conn.id}`}>
                              <div className="os-access-conn-meta">
                                <strong>{conn.label || conn.id}</strong>
                                <small>
                                  {`${conn.id} · v${conn.nodeVersion}`}{' '}
                                  {isOwnerOrInherited
                                    ? `· ${t('Owner / Admin (Full Access Inherited)')}`
                                    : mem?.inherited
                                      ? `· ${t('Inherited')}: ${mem.inherited}`
                                      : `· ${t('Configurable Member Role')}`}
                                </small>
                              </div>
                              <div className="os-access-role-pills" role="group" aria-label={`${conn.label} ${t('Role')}`}>
                                {(
                                  [
                                    { id: 'admin', label: t('Admin (Full)') },
                                    { id: 'developer', label: t('Developer (Own Sessions)') },
                                    { id: 'observer', label: t('Observer (Read-Only)') },
                                    { id: 'none', label: t('No Access') },
                                  ] as const
                                ).map((rItem) => {
                                  const isSelectedRole = currentRole === rItem.id;
                                  return (
                                    <button
                                      key={rItem.id}
                                      type="button"
                                      data-testid={`os-access-role-btn-${conn.id}-${rItem.id}`}
                                      aria-pressed={isSelectedRole}
                                      disabled={!canEditRole || accessBusy}
                                      className={`os-access-role-btn${isSelectedRole ? ' is-active' : ''}${!canEditRole ? ' is-inherited' : ''}`}
                                      onClick={() => applyQuickRole(rItem.id)}
                                    >
                                      <span className="os-access-role-btn-indicator">
                                        {isSelectedRole ? <Check size={12} /> : null}
                                      </span>
                                      <span>{rItem.label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                              <div className="os-access-runtime-badges">
                                <span className={`os-access-rt-badge${codexMode !== 'disabled' ? ' is-on' : ''}`}>
                                  {`Codex: ${codexMode}`}
                                </span>
                                <span className={`os-access-rt-badge${openclawMode !== 'disabled' ? ' is-on' : ''}`}>
                                  {`OpenClaw: ${openclawMode}`}
                                </span>
                                {!conn.creationReady && conn.owner ? (
                                  <button
                                    type="button"
                                    className="os-settings-action-btn"
                                    onClick={() => {
                                      void api
                                        .hubSetupLocalExecution(conn.id, conn.nodeVersion, true)
                                        .then(() => {
                                          setAccessStatusMsg(`${conn.label}: ${t('Enabled member session creation')}`);
                                          setAccessReloadNonce((v) => v + 1);
                                        })
                                        .catch((err: unknown) => {
                                          setAccessStatusMsg(err instanceof Error ? err.message : t('Failed to enable creation'));
                                        });
                                    }}
                                  >
                                    <span>{t('Enable Member Creation')}</span>
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                        {(accessDir?.connections ?? []).length === 0 ? (
                          <p className="os-settings-hint">{t('No Connectors registered in directory.')}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {/* Section 3: Connector Users per Node */}
                  <div className="os-settings-section">
                    <h4>
                      <Server size={14} style={{ display: 'inline', marginRight: 6 }} />
                      {t('3. Connector Node Users (Local Runtime Accounts)')}
                    </h4>
                    <div className="os-access-conn-users-grid">
                      {accessConnectorUsers.map((group) => {
                        const draftName = accessNewConnUserName[group.id] ?? '';
                        return (
                          <div key={group.id} className="os-access-conn-user-card">
                            <div className="os-access-conn-user-head">
                              <strong>{group.label || group.id}</strong>
                              <small>{group.users.length} {t('connector users')}</small>
                            </div>
                            <div className="os-access-conn-user-tags">
                              {group.users.map((cu) => (
                                <span key={cu.id} className="os-access-conn-user-tag">
                                  <span>{cu.label}</span>
                                  <small>({cu.id})</small>
                                  <button
                                    type="button"
                                    className="os-access-conn-user-del"
                                    title={t('Hide from local list (does not remove runtime account)')}
                                    aria-label={t('Hide from local list (does not remove runtime account)')}
                                    data-testid={`os-access-delete-conn-user-${group.id}-${cu.id}`}
                                    onClick={() => {
                                      const delKey = `${group.id}:${cu.id}`;
                                      const nextDeleted = writeDesktopDeletedUsers(storageScope, {
                                        ...accessDeletedUsers,
                                        connectorUserKeys: [...accessDeletedUsers.connectorUserKeys, delKey],
                                      });
                                      setAccessDeletedUsers(nextDeleted);
                                      setAccessConnectorUsers((prev) =>
                                        prev.map((g) =>
                                          g.id === group.id
                                            ? { ...g, users: g.users.filter((item) => item.id !== cu.id) }
                                            : g,
                                        ),
                                      );
                                      setAccessStatusMsg(`${group.id}: ${t('Hidden Connector user locally (runtime account unchanged):')} ${cu.label}`);
                                    }}
                                  >
                                    <X size={11} />
                                  </button>
                                </span>
                              ))}
                              {group.users.length === 0 ? (
                                <small className="os-settings-hint">{t('Default runtime account')}</small>
                              ) : null}
                            </div>
                            <form
                              className="os-settings-input-row"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const label = draftName.trim();
                                if (!label) return;
                                void api
                                  .hubCreateConnectorUser(group.id, { label })
                                  .then((res) => {
                                    const delKey = `${group.id}:${res.user.id}`;
                                    if (accessDeletedUsers.connectorUserKeys.includes(delKey)) {
                                      const nextDel = writeDesktopDeletedUsers(storageScope, {
                                        ...accessDeletedUsers,
                                        connectorUserKeys: accessDeletedUsers.connectorUserKeys.filter((k) => k !== delKey),
                                      });
                                      setAccessDeletedUsers(nextDel);
                                    }
                                    setAccessNewConnUserName((prev) => ({ ...prev, [group.id]: '' }));
                                    setAccessStatusMsg(`${group.id}: ${t('Created Connector user')} ${res.user.label}`);
                                    setAccessReloadNonce((v) => v + 1);
                                  })
                                  .catch((err: unknown) => {
                                    setAccessStatusMsg(err instanceof Error ? err.message : t('Failed to create Connector user'));
                                  });
                              }}
                            >
                              <input
                                name={`os-conn-user-${group.id}`}
                                type="text"
                                className="os-settings-text-input"
                                placeholder={t('Add Connector user label...')}
                                value={draftName}
                                onChange={(e) =>
                                  setAccessNewConnUserName((prev) => ({
                                    ...prev,
                                    [group.id]: e.target.value,
                                  }))
                                }
                              />
                              <button type="submit" className="os-settings-action-btn" disabled={!draftName.trim()}>
                                <Plus size={12} />
                                <span>{t('Add')}</span>
                              </button>
                            </form>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === 'sandbox' ? (() => {
                const blueprint = buildDockerSandboxBlueprint({
                  hubUrl: typeof window !== 'undefined' ? window.location.origin : 'https://hub.example.com',
                  environmentId: sbxEnvId,
                  nodeLabel: sbxNodeLabel,
                  profileId: sbxPreset,
                  cpuLimit: sbxCpu,
                  memoryLimitMb: sbxMemMb,
                  workspaceTmpfsMb: sbxTmpfsMb,
                  ttlMinutes: sbxTtlMin,
                  networkMode: sbxNetwork,
                  runtimes: sbxRuntimes,
                  readOnlyRootfs: sbxReadOnly,
                });
                const activeArtifactText =
                  sbxArtifactTab === 'run'
                    ? blueprint.dockerRunCommand
                    : sbxArtifactTab === 'compose'
                      ? blueprint.dockerComposeYaml
                      : blueprint.dockerfileSnippet;
                return (
                  <div className="os-settings-pane" data-testid="os-settings-pane-sandbox">
                    <div className="os-settings-section">
                      <h4>{t('Isolated Docker Connector + Codex Sandbox')}</h4>
                      <p className="os-settings-hint">
                        {t('Deploy an ephemeral container with Connector + Codex runtime, isolated workspace tmpfs, and outbound reverse tunnel.')}
                      </p>
                      <div className="os-settings-preset-row">
                        {DOCKER_SANDBOX_PRESETS.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              className={`os-settings-action-btn${sbxPreset === p.id ? ' is-active' : ''}`}
                              onClick={() => {
                                setSbxPreset(p.id);
                                setSbxCpu(p.cpuLimit);
                                setSbxMemMb(p.memoryLimitMb);
                                setSbxTmpfsMb(p.workspaceTmpfsMb);
                                setSbxTtlMin(p.ttlMinutes);
                                setSbxNetwork(p.networkMode);
                                setSbxReadOnly(p.readOnlyRootfs);
                              }}
                            >
                              <span>{t(p.label as any)}</span>
                            </button>
                          ))}
                      </div>
                    </div>

                    <div className="os-settings-section">
                      <h4>{t('Sandbox Target & Resource Limits')}</h4>
                      <div className="os-settings-input-row">
                        <input
                          name="os-sandbox-env-id"
                          type="text"
                          className="os-settings-text-input"
                          value={sbxEnvId}
                          onChange={(e) => setSbxEnvId(e.target.value)}
                          placeholder={t('sandbox-env')}
                        />
                        <input
                          name="os-sandbox-node-label"
                          type="text"
                          className="os-settings-text-input"
                          value={sbxNodeLabel}
                          onChange={(e) => setSbxNodeLabel(e.target.value)}
                          placeholder={t('codex-sbx-1')}
                        />
                        <button
                          type="button"
                          className={`os-settings-action-btn${sbxReadOnly ? ' is-active' : ''}`}
                          onClick={() => setSbxReadOnly((v) => !v)}
                        >
                          <span>{t('Read-only RootFS')}</span>
                        </button>
                      </div>
                      <div className="os-settings-preset-row" style={{ marginTop: 8 }}>
                        <select
                          aria-label={t('vCPU Limit')}
                          className="os-settings-text-input"
                          value={sbxCpu}
                          onChange={(e) => setSbxCpu(Number(e.target.value))}
                        >
                          <option value={1}>{t("1 vCPU")}</option>
                          <option value={2}>{t("2 vCPU")}</option>
                          <option value={4}>{t("4 vCPU")}</option>
                          <option value={8}>{t("8 vCPU")}</option>
                        </select>
                        <select
                          aria-label={t('Memory Limit')}
                          className="os-settings-text-input"
                          value={sbxMemMb}
                          onChange={(e) => setSbxMemMb(Number(e.target.value))}
                        >
                          <option value={1024}>{t("1 GB RAM")}</option>
                          <option value={2048}>{t("2 GB RAM")}</option>
                          <option value={4096}>{t("4 GB RAM")}</option>
                          <option value={8192}>{t("8 GB RAM")}</option>
                        </select>
                        <select
                          aria-label={t('Network Isolation')}
                          className="os-settings-text-input"
                          value={sbxNetwork}
                          onChange={(e) => setSbxNetwork(e.target.value as DockerSandboxNetworkMode)}
                        >
                          <option value="bridge">{t('Bridge (Outbound NAT)')}</option>
                          <option value="none">{t('Air-Gapped (none)')}</option>
                          <option value="host-gateway">{t('Host Gateway')}</option>
                        </select>
                        {(['codex', 'claude', 'copilot'] as const).map((rt) => {
                          const on = sbxRuntimes.includes(rt);
                          return (
                            <button
                              key={rt}
                              type="button"
                              className={`os-settings-action-btn${on ? ' is-active' : ''}`}
                              onClick={() =>
                                setSbxRuntimes((prev) =>
                                  prev.includes(rt)
                                    ? prev.length > 1
                                      ? prev.filter((item) => item !== rt)
                                      : prev
                                    : [...prev, rt],
                                )
                              }
                            >
                              <span>{rt}</span>
                            </button>
                          );
                        })}
                      </div>
                      <p className="os-settings-hint" style={{ marginTop: 6 }}>
                        <code>{`${blueprint.connectorUri} · ${blueprint.cpuLimit} vCPU · ${blueprint.memoryLimitMb} MB · tmpfs ${blueprint.workspaceTmpfsMb} MB · TTL ${blueprint.ttlMinutes}m`}</code>
                      </p>
                    </div>

                    <div className="os-settings-section">
                      <h4>{t('Ephemeral Container Command')}</h4>
                      <div className="os-settings-preset-row" style={{ marginBottom: 6 }}>
                        {(['run', 'compose', 'dockerfile'] as const).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            className={`os-settings-action-btn${sbxArtifactTab === tab ? ' is-active' : ''}`}
                            onClick={() => setSbxArtifactTab(tab)}
                          >
                            <span>
                              {tab === 'run'
                                ? 'docker run'
                                : tab === 'compose'
                                  ? 'docker-compose.yml'
                                  : 'Dockerfile'}
                            </span>
                          </button>
                        ))}
                      </div>
                      <pre
                        style={{
                          margin: '6px 0',
                          padding: '8px 10px',
                          borderRadius: 8,
                          background: 'rgba(0,0,0,0.32)',
                          fontSize: 11,
                          overflowX: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        }}
                      >
                        {activeArtifactText}
                      </pre>
                      <div className="os-settings-preset-row">
                        <button
                          type="button"
                          className="os-settings-action-btn is-primary"
                          disabled={sbxBusy}
                          onClick={() => {
                            setSbxBusy(true);
                            setSbxStatusMsg('');
                            void api
                              .hubCreateDockerSandbox({
                                hubUrl: typeof window !== 'undefined' ? window.location.origin : 'https://hub.example.com',
                                environmentId: sbxEnvId,
                                name: sbxNodeLabel,
                                profileId: sbxPreset,
                                cpuLimit: sbxCpu,
                                memoryLimitMb: sbxMemMb,
                                workspaceTmpfsMb: sbxTmpfsMb,
                                ttlMinutes: sbxTtlMin,
                                networkMode: sbxNetwork,
                                readOnlyRootfs: sbxReadOnly,
                                runtimes: sbxRuntimes,
                              })
                              .then((res) => {
                                setSbxInstances((prev) => [
                                  res.sandbox,
                                  ...prev.filter((item) => item.id !== res.sandbox.id),
                                ]);
                                setSbxStatusMsg(`${res.sandbox.containerName} (${res.sandbox.status})`);
                              })
                              .catch((err) => {
                                setSbxStatusMsg(err instanceof Error ? err.message : t('Sandbox orchestration failed'));
                              })
                              .finally(() => setSbxBusy(false));
                          }}
                        >
                          <Sparkles size={12} />
                          <span>{sbxBusy ? t('Provisioning Sandbox...') : t('Launch Ephemeral Sandbox Now')}</span>
                        </button>
                        <button
                          type="button"
                          className="os-settings-action-btn"
                          onClick={() => {
                            void navigator.clipboard?.writeText(activeArtifactText);
                            setSbxCopiedField(sbxArtifactTab);
                            setTimeout(() => setSbxCopiedField(null), 2000);
                          }}
                        >
                          <Copy size={12} />
                          <span>{sbxCopiedField === sbxArtifactTab ? t('Copied') : t('Copy')}</span>
                        </button>
                      </div>
                      {sbxStatusMsg ? (
                        <p className="os-settings-hint" style={{ marginTop: 6 }}>
                          {sbxStatusMsg}
                        </p>
                      ) : null}
                    </div>

                    {sbxInstances.length > 0 ? (
                      <div className="os-settings-section">
                        <h4>{`${t('Ephemeral Docker + Codex Sandboxes')} (${sbxInstances.length})`}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {sbxInstances.slice(0, 6).map((inst) => (
                            <div
                              key={inst.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                                padding: '6px 10px',
                                borderRadius: 8,
                                background: 'rgba(255,255,255,0.04)',
                                fontSize: 12,
                              }}
                            >
                              <div>
                                <strong>{inst.containerName}</strong>
                                <span style={{ marginLeft: 8, opacity: 0.75 }}>
                                  {`${inst.status} · ${inst.cpuLimit} vCPU · ${inst.memoryLimitMb} MB`}
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  className="os-settings-action-btn"
                                  onClick={() => {
                                    void api.hubRenewDockerSandbox(inst.id, 60).then((res) => {
                                      setSbxInstances((prev) =>
                                        prev.map((item) => (item.id === inst.id ? res.sandbox : item)),
                                      );
                                    });
                                  }}
                                >
                                  <span>{t('+60m TTL')}</span>
                                </button>
                                <button
                                  type="button"
                                  className="os-settings-action-btn"
                                  onClick={() => {
                                    void api.hubStopDockerSandbox(inst.id, true).then(() => {
                                      setSbxInstances((prev) => prev.filter((item) => item.id !== inst.id));
                                    });
                                  }}
                                >
                                  <span>{t('Remove')}</span>
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })() : null}
            </div>
          </div>
          {render8WayResizeHandles(
            "sys:settings",
            settingsPos,
            (next) => setSettingsPos(next),
            { minW: 500, minH: 360 },
            "os-settings-resize",
          )}
        </div>
      ) : null}

      {/* Start Menu Popover */}
      {startMenuOpen ? (
        <div className="os-desktop-start-menu" role="menu" aria-label={t('Start menu')}>
          <div className="os-start-menu-header">
            <strong>{t('AgentOpsDeck OS Desktop')}</strong>
            <span>{`v${AGENTOPSDECK_VERSION} · ${AGENTOPSDECK_BUILD.buildNumber}`}</span>
          </div>
          <div className="os-start-menu-grid">
            {onCreateSession ? (
              <button
                type="button"
                onClick={() => {
                  setStartMenuOpen(false);
                  onCreateSession();
                }}
              >
                <Plus size={15} />
                <span>{t('New session')}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setStartMenuOpen(false);
                setExplorerOpen(true);
              }}
            >
              <FolderOpen size={15} />
              <span>{t('Session Explorer')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setStartMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              <Settings size={15} />
              <span>{t('System Settings')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setStartMenuOpen(false);
                setTaskViewOpen(true);
              }}
            >
              <Columns2 size={15} />
              <span>{t('Task View')}</span>
            </button>
            {icons.slice(0, 9).map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => {
                  setStartMenuOpen(false);
                  handleOpenDesktopIcon(app);
                }}
              >
                {renderIconGlyph(app.kind, app.running, 16)}
                <span>{app.title}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setStartMenuOpen(false);
                setHudOpen((v) => !v);
              }}
            >
              <Gauge size={15} />
              <span>{t('Telemetry HUD')}</span>
            </button>
          </div>
          <div className="os-start-menu-footer">
            <button
              type="button"
              className="os-start-exit-desktop-btn"
              data-testid="os-start-exit-desktop"
              onClick={() => {
                triggerExitDesktopWithAnimation();
              }}
            >
              <Power size={15} />
              <span>{t('Exit Desktop Mode')}</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* System Tray Quick Control Center Flyout */}
      {trayFlyoutOpen ? (
        <div
          className="os-desktop-tray-flyout"
          role="dialog"
          aria-label={t('Desktop Control Center')}
        >
          <div className="os-tray-flyout-header">
            <strong>{t('Desktop Control Center')}</strong>
            <span>
              {openWindows.length} {t('windows')} · {runningCount} {t('running')}
            </span>
          </div>
          <div className="os-tray-section">
            <span className="os-tray-label">{t("Appearance Mode (Dark / Light)")}</span>
            <div className="os-tray-pill-row">
              <button
                type="button"
                className={`os-tray-choice${colorMode === "dark" ? " is-active" : ""}`}
                onClick={() => setColorMode(writeWorkspaceColorMode("dark"))}
              >
                <Moon size={11} />
                <span>{t("Dark Mode")}</span>
              </button>
              <button
                type="button"
                className={`os-tray-choice${colorMode === "light" ? " is-active" : ""}`}
                onClick={() => setColorMode(writeWorkspaceColorMode("light"))}
              >
                <Sun size={11} />
                <span>{t("Light Mode")}</span>
              </button>
            </div>
          </div>
          <div className="os-tray-section">
            <span className="os-tray-label">{t('Wallpaper')}</span>
            <div className="os-tray-pill-row">
              {WALLPAPER_THEMES.map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={`os-tray-choice${wallpaper === theme ? ' is-active' : ''}`}
                  onClick={() => selectBuiltInWallpaper(theme)}
                >
                  {wallpaper === theme ? <Check size={11} /> : null}
                  <span>{theme}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="os-tray-section">
            <span className="os-tray-label">{t('Desktop icon size')}</span>
            <div className="os-tray-pill-row">
              {(['sm', 'md', 'lg'] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className={`os-tray-choice${prefs.iconSize === sz ? ' is-active' : ''}`}
                  onClick={() => setPrefs((prev) => ({ ...prev, iconSize: sz }))}
                >
                  <span>{sz.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="os-tray-section">
            <span className="os-tray-label">{t('Sort desktop icons')}</span>
            <div className="os-tray-pill-row">
              {(['default', 'name', 'status', 'kind'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`os-tray-choice${prefs.sortBy === s ? ' is-active' : ''}`}
                  onClick={() => setSortBy(s)}
                >
                  <span>{s}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* Unified Desktop Lineage & Binding Lines Overlay (#14 & #15) */}
      {(prefs.showLineageLines !== false || linkConnectMode) &&
      resolvedLineageEdges.length > 0 ? (
        <svg
          className={`os-desktop-binding-lines is-top-overlay${linkConnectMode ? ' is-connect-mode' : ''}`}
          data-testid="os-desktop-binding-lines"
          data-top-layer="true"
          viewBox={`0 0 ${Math.max(320, surfaceWidth)} ${Math.max(240, surfaceHeight)}`}
          preserveAspectRatio="none"
        >
          <defs>
            {resolvedLineageEdges.map((edge, idx) => {
              const palette = bindingGroupColor(`${edge.groupKey}:${idx}`);
              const safeGradId = `os-bind-grad-${idx}`;
              return (
                <linearGradient key={edge.id} id={safeGradId} x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor={palette.stroke} stopOpacity="0.95" />
                  <stop offset="100%" stopColor={palette.secondary} stopOpacity="0.85" />
                </linearGradient>
              );
            })}
          </defs>
          {resolvedLineageEdges.map((edge, idx) => {
            if (
              highlightedLineageNodeId &&
              edge.fromIconId !== highlightedLineageNodeId &&
              edge.toIconId !== highlightedLineageNodeId
            ) {
              return null;
            }
            const srcId = edge.fromIconId;
            const dstId = edge.toIconId;
            const shellEl = shellRef.current;
            const visibleNbs = notebooks;

            const findMatchingOpenWindow = (iconId: string): DesktopOpenWindowItem | undefined => {
              for (const win of openWindows) {
                if (isWindowMinimized(win)) continue;
                if (iconId.startsWith('session:') && win.kind === 'session' && `session:${win.sessionKey}` === iconId) {
                  return win;
                }
                if (iconId === 'app:notebook' && win.kind === 'notebook') {
                  const firstId = visibleNbs[0]?.id;
                  if (!win.resourceId || win.resourceId === 'default' || win.resourceId === firstId) return win;
                }
                if (iconId.startsWith('notebook:') && win.kind === 'notebook' && `notebook:${win.resourceId}` === iconId) {
                  return win;
                }
                if (iconId === 'app:taskboard' && win.kind === 'taskboard' && (!win.resourceId || win.resourceId === 'default')) {
                  return win;
                }
                if (iconId.startsWith('taskboard:') && win.kind === 'taskboard' && `taskboard:${win.resourceId}` === iconId) {
                  return win;
                }
                if (iconId === `app:${win.kind}`) {
                  return win;
                }
              }
              return undefined;
            };

            const resolveNodeRect = (iconId: string, fallbackIndex: number): { rect: BindingRect; winId?: string } => {
              const matchedWin = findMatchingOpenWindow(iconId);
              if (shellEl) {
                const sb = shellEl.getBoundingClientRect();
                if (matchedWin) {
                  const winEl = shellEl.querySelector<HTMLElement>(`[data-os-window="${CSS.escape(matchedWin.id)}"]`);
                  if (winEl) {
                    const r = winEl.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                      return {
                        rect: { x: r.left - sb.left, y: r.top - sb.top, width: r.width, height: r.height },
                        winId: matchedWin.id,
                      };
                    }
                  }
                  const wr = windowRects[matchedWin.id];
                  if (wr) {
                    return {
                      rect: { x: wr.x, y: wr.y, width: wr.width, height: wr.height },
                      winId: matchedWin.id,
                    };
                  }
                }
                const iconEl = shellEl.querySelector<HTMLElement>(`[data-desktop-icon="${CSS.escape(iconId)}"]`);
                if (iconEl) {
                  const r = iconEl.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) {
                    return {
                      rect: { x: r.left - sb.left, y: r.top - sb.top, width: r.width, height: r.height },
                    };
                  }
                }
              }
              const pos = iconPositions[iconId];
              return {
                rect: {
                  x: pos?.x ?? 72 + (fallbackIndex * 116) % 440,
                  y: pos?.y ?? 92 + (fallbackIndex * 76) % 280,
                  width: 88,
                  height: 84,
                },
              };
            };

            const resolvedA = resolveNodeRect(srcId, idx * 2);
            const resolvedB = resolveNodeRect(dstId, idx * 2 + 1);
            const rectA = resolvedA.rect;
            const rectB = resolvedB.rect;

            const obstacles: BindingRect[] = openWindows
              .filter((w) => !isWindowMinimized(w) && w.id !== resolvedA.winId && w.id !== resolvedB.winId)
              .map((w) => windowRects[w.id])
              .filter((wr): wr is DesktopWindowGeometry => Boolean(wr))
              .map((wr) => ({
                x: wr.x,
                y: wr.y,
                width: wr.width,
                height: wr.height,
              }));

            const d = bindingCurve(rectA, rectB, {
              parallelIndex: idx % 3,
              parallelCount: Math.min(3, resolvedLineageEdges.length),
              obstacles,
            });
            const palette = bindingGroupColor(`${edge.groupKey}:${idx}`);
            const safeGradId = `os-bind-grad-${idx}`;
            const midX = Math.round((rectA.x + rectA.width / 2 + rectB.x + rectB.width / 2) / 2);
            const midY = Math.round((rectA.y + rectA.height / 2 + rectB.y + rectB.height / 2) / 2) - 10;

            return (
              <g key={edge.id} className="os-desktop-binding-edge" data-lineage-kind={edge.kind}>
                <path d={d} className="os-desktop-binding-glow" style={{ stroke: palette.glow }} />
                <path d={d} className="os-desktop-binding-path" style={{ stroke: `url(#${safeGradId})` }} />
                <circle cx={rectA.x + rectA.width / 2} cy={rectA.y + rectA.height / 2} r={4.5} fill={palette.stroke} />
                <circle cx={rectB.x + rectB.width / 2} cy={rectB.y + rectB.height / 2} r={4.5} fill={palette.secondary} />
                {(lineageInspectorOpen || highlightedLineageNodeId !== null || linkConnectMode) ? (
                  <g transform={`translate(${midX}, ${midY})`}>
                    <rect
                      x={-48}
                      y={-10}
                      width={96}
                      height={18}
                      rx={9}
                      fill="rgba(15, 23, 42, 0.88)"
                      stroke={palette.stroke}
                      strokeWidth={1}
                    />
                    <text
                      x={0}
                      y={2}
                      textAnchor="middle"
                      fill="#f8fafc"
                      fontSize="10"
                      fontWeight="600"
                    >
                      {edge.label.slice(0, 16)}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}

      {/* Lineage & Connections Inspector Panel */}
      {lineageInspectorOpen ? (
        <aside
          className="os-desktop-lineage-panel"
          data-testid="os-desktop-lineage-inspector"
          role="dialog"
          aria-label={t('Lineage & Connections Inspector')}
          style={{
            left: lineageRect.x,
            top: lineageRect.y,
            width: lineageRect.width,
            height: lineageRect.height,
            right: "auto",
            bottom: "auto",
            maxHeight: "none",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <header
            className="os-lineage-panel-header"
            style={{ cursor: "grab" }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest("button")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              sysDragRef.current = {
                key: "sys:lineage",
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: lineageRect.x,
                origY: lineageRect.y,
              };
            }}
            onPointerMove={(e) => {
              const d = sysDragRef.current;
              if (!d || d.key !== "sys:lineage" || d.pointerId !== e.pointerId) return;
              const nx = Math.max(8, Math.min(surfaceWidth - 260, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(6, Math.min(surfaceHeight - 100, d.origY + (e.clientY - d.startY)));
              setLineageRect((prev) => ({ ...prev, x: Math.round(nx), y: Math.round(ny) }));
            }}
            onPointerUp={(e) => {
              if (sysDragRef.current?.pointerId === e.pointerId) {
                sysDragRef.current = null;
              }
            }}
          >
            <div className="os-lineage-panel-title">
              <GitBranch size={14} />
              <strong>{t('Lineage & Connections')}</strong>
              <span className="os-window-running-pill">{resolvedLineageEdges.length}</span>
            </div>
            <div className="os-lineage-panel-actions">
              <button
                type="button"
                className={`os-lineage-toggle-pill${prefs.showLineageLines !== false ? ' is-on is-active' : ''}`}
                data-testid="os-lineage-visibility-toggle"
                onClick={() => {
                  const nextVisible = prefs.showLineageLines === false;
                  setPrefs((prev) => ({
                    ...prev,
                    showLineageLines: nextVisible,
                  }));
                  if (!nextVisible) {
                    setLinkConnectMode(false);
                    setPendingLinkSourceId(null);
                  }
                }}
                title={t('Toggle lineage lines on desktop')}
              >
                {prefs.showLineageLines !== false ? <Eye size={12} /> : <EyeOff size={12} />}
                <span>{prefs.showLineageLines !== false ? t('Lines Visible') : t('Lines Hidden')}</span>
              </button>
              <button
                type="button"
                className={`os-lineage-toggle-pill${linkConnectMode ? ' is-active' : ''}`}
                onClick={() => {
                  setPrefs((prev) => ({ ...prev, showLineageLines: true }));
                  setLinkConnectMode((v) => !v);
                  setPendingLinkSourceId(null);
                }}
                title={t('Click two desktop icons to link or unlink them')}
              >
                <Link2 size={12} />
                <span>{linkConnectMode ? t('Cancel Link') : t('+ Link Items')}</span>
              </button>
              <button
                type="button"
                className="os-lineage-close-btn"
                aria-label={t('Close')}
                onClick={() => {
                  setLineageInspectorOpen(false);
                  setHighlightedLineageNodeId(null);
                }}
              >
                <X size={13} />
              </button>
            </div>
          </header>

          {highlightedLineageNodeId ? (
            <div className="os-lineage-filter-bar">
              <span>
                {t('Filtered by')}: <strong>{icons.find((ic) => ic.id === highlightedLineageNodeId)?.title ?? highlightedLineageNodeId}</strong>
              </span>
              <button type="button" onClick={() => setHighlightedLineageNodeId(null)}>
                {t('Show All')}
              </button>
            </div>
          ) : null}

          <div className="os-lineage-panel-body">
            {resolvedLineageEdges.length === 0 ? (
              <div className="os-lineage-empty">
                <GitBranch size={22} />
                <p>{t('No active lineage or binding links yet.')}</p>
                <small>
                  {t('Bind a Session to a Notebook/Taskboard, or click "+ Link Items" and select two desktop icons to connect them.')}
                </small>
              </div>
            ) : (
              <div className="os-lineage-edge-list">
                {resolvedLineageEdges.map((edge, idx) => {
                  const iconA = icons.find((ic) => ic.id === edge.fromIconId);
                  const iconB = icons.find((ic) => ic.id === edge.toIconId);
                  const titleA = iconA?.title ?? edge.fromIconId.replace(/^(session|notebook|taskboard|app):/, '');
                  const titleB = iconB?.title ?? edge.toIconId.replace(/^(session|notebook|taskboard|app):/, '');
                  const palette = bindingGroupColor(`${edge.groupKey}:${idx}`);
                  const isHighlighted =
                    highlightedLineageNodeId === edge.fromIconId ||
                    highlightedLineageNodeId === edge.toIconId;
                  return (
                    <div
                      key={edge.id}
                      className={`os-lineage-edge-row${isHighlighted ? ' is-highlighted' : ''}`}
                      onClick={() => {
                        setPrefs((prev) => ({ ...prev, showLineageLines: true }));
                        setHighlightedLineageNodeId((prev) =>
                          prev === edge.fromIconId ? null : edge.fromIconId,
                        );
                      }}
                    >
                      <span
                        className="os-lineage-edge-dot"
                        style={{ background: palette.stroke, boxShadow: `0 0 8px ${palette.glow}` }}
                      />
                      <div className="os-lineage-edge-info">
                        <div className="os-lineage-edge-endpoints">
                          <button
                            type="button"
                            className="os-lineage-endpoint-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (iconA) handleOpenDesktopIcon(iconA);
                            }}
                          >
                            {titleA}
                          </button>
                          <span className="os-lineage-edge-arrow">↔</span>
                          <button
                            type="button"
                            className="os-lineage-endpoint-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (iconB) handleOpenDesktopIcon(iconB);
                            }}
                          >
                            {titleB}
                          </button>
                        </div>
                        <small className="os-lineage-edge-kind">{edge.label}</small>
                      </div>
                      {edge.removableManualId ? (
                        <button
                          type="button"
                          className="os-lineage-edge-remove"
                          title={t('Remove manual link')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDesktopBindings((prev) =>
                              prev.filter((b) => b.id !== edge.removableManualId),
                            );
                          }}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {render8WayResizeHandles(
            "sys:lineage",
            lineageRect,
            (next) => setLineageRect(next),
            { minW: 320, minH: 220 },
            "os-lineage-resize",
          )}
        </aside>
      ) : null}

      {/* Built-in Desktop Browser Studio Window (#1) */}
      {browserOpen ? (
        <div
          className={`os-desktop-browser-window${browserRect.maximized ? ' is-maximized' : ''}${topSurfaceId === 'sys:browser' ? ' is-active' : ''}`}
          data-os-window="sys:browser"
          data-testid="os-desktop-browser-window"
          role="dialog"
          aria-label={t('Web Preview')}
          style={
            browserRect.maximized
              ? {
                  left: 0,
                  top: 0,
                  width: surfaceWidth,
                  height: Math.max(320, surfaceHeight - taskbarMetrics.taskbarHeight),
                  zIndex: getSurfaceZIndex("sys:browser", true),
                }
              : {
                  left: browserRect.x,
                  top: browserRect.y,
                  width: browserRect.width,
                  height: browserRect.height,
                  zIndex: getSurfaceZIndex("sys:browser", false),
                }
          }
          onPointerDownCapture={() => bringSurfaceToFront("sys:browser")}
          onFocusCapture={() => bringSurfaceToFront("sys:browser")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header
            className="os-window-titlebar os-browser-titlebar"
            onDoubleClick={() => setBrowserRect((prev) => ({ ...prev, maximized: !prev.maximized }))}
            onPointerDown={(e) => {
              if (browserRect.maximized) return;
              if ((e.target as HTMLElement).closest('button, input')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              browserDragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: browserRect.x,
                origY: browserRect.y,
              };
            }}
            onPointerMove={(e) => {
              const d = browserDragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              const nx = Math.max(6, Math.min(surfaceWidth - 240, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(4, Math.min(surfaceHeight - 100, d.origY + (e.clientY - d.startY)));
              setBrowserRect((prev) => ({ ...prev, x: Math.round(nx), y: Math.round(ny) }));
            }}
            onPointerUp={(e) => {
              if (browserDragRef.current?.pointerId === e.pointerId) {
                browserDragRef.current = null;
              }
            }}
          >
            <div className="os-browser-tabs">
              {browserTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`os-browser-tab${activeBrowserTabId === tab.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setActiveBrowserTabId(tab.id);
                    setBrowserUrlInput(tab.url);
                  }}
                >
                  <Globe size={12} />
                  <span>{tab.title}</span>
                  {browserTabs.length > 1 ? (
                    <i
                      role="button"
                      tabIndex={-1}
                      className="os-browser-tab-close"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setBrowserTabs((prev) => {
                          const next = prev.filter((tItem) => tItem.id !== tab.id);
                          if (activeBrowserTabId === tab.id && next[0]) {
                            setActiveBrowserTabId(next[0].id);
                            setBrowserUrlInput(next[0].url);
                          }
                          return next;
                        });
                      }}
                    >
                      ×
                    </i>
                  ) : null}
                </button>
              ))}
              <button
                type="button"
                className="os-browser-tab-add"
                title={t('New Tab')}
                onClick={() => {
                  const id = `tab-${Date.now()}`;
                  const nextTab = { id, title: t('Cloud Browser'), url: 'about:home' };
                  setBrowserTabs((prev) => [...prev, nextTab]);
                  setActiveBrowserTabId(id);
                  setBrowserUrlInput(nextTab.url);
                }}
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="os-window-controls">
              <button
                type="button"
                title={t(browserRect.maximized ? 'Restore pane' : 'Maximize pane')}
                onClick={() => setBrowserRect((prev) => ({ ...prev, maximized: !prev.maximized }))}
              >
                {browserRect.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                className="os-win-close-btn"
                aria-label={t('Close')}
                title={t('Close')}
                onClick={() => setBrowserOpen(false)}
              >
                <X size={13} />
              </button>
            </div>
          </header>

          <div className="os-browser-navbar">
            <button
              type="button"
              className="os-browser-nav-btn"
              title={t('Back')}
              onClick={() => {
                if (browserEngineMode === 'stream') {
                  void sendBrowserStreamCommand({ action: 'back' });
                }
              }}
            >
              <ArrowLeft size={13} />
            </button>
            <button
              type="button"
              className="os-browser-nav-btn"
              title={t('Forward')}
              onClick={() => {
                if (browserEngineMode === 'stream') {
                  void sendBrowserStreamCommand({ action: 'forward' });
                }
              }}
            >
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              className="os-browser-nav-btn"
              title={t('Reload')}
              onClick={() => {
                setBrowserReloadTick((v) => v + 1);
                if (browserEngineMode === 'stream') {
                  void sendBrowserStreamCommand({ action: 'reload' });
                }
              }}
            >
              <RefreshCw size={13} />
            </button>
            <form
              className="os-browser-url-form"
              onSubmit={(e) => {
                e.preventDefault();
                const raw = browserUrlInput.trim() || 'about:home';
                const normalized =
                  raw === 'about:home' || raw.startsWith('http://') || raw.startsWith('https://')
                    ? raw
                    : `https://${raw}`;
                if (normalized !== 'about:home' && !desktopEmbedUrl(normalized, window.location.origin, new URL(apiUrl('/api'), window.location.origin).origin)) {
                  setBrowserNotice('Use an external HTTP or HTTPS website. Deck and API origins cannot be embedded.');
                  return;
                }
                setBrowserUrlInput(normalized);
                setBrowserTabs((prev) =>
                  prev.map((tab) =>
                    tab.id === activeBrowserTabId
                      ? {
                          ...tab,
                          url: normalized,
                          title:
                            normalized === 'about:home'
                              ? t('Cloud Browser')
                              : normalized.replace(/^https?:\/\//, '').slice(0, 24) || 'Web',
                        }
                      : tab,
                  ),
                );
                if (browserEngineMode === 'stream' && browserTarget) void sendBrowserStreamCommand({ action: 'navigate', url: normalized });
              }}
            >
              <Globe size={12} />
              <input
                name="os-browser-url"
                aria-label={t('Website address')}
                type="text"
                value={browserUrlInput}
                placeholder={t('Enter URL (e.g. https://news.ycombinator.com or https://www.bing.com)')}
                onChange={(e) => setBrowserUrlInput(e.target.value)}
              />
              <button type="submit">{t('Go')}</button>
            </form>
            <div className="os-browser-viewport-pills" role="group" aria-label={t('Browser Engine Mode')}>
              <button
                type="button"
                className={`os-browser-vp-btn${browserEngineMode === 'stream' ? ' is-active' : ''}`}
                title={t('Playwright Chromium Cloud Stream (Bypasses X-Frame-Options/CSP)')}
                onClick={() => setBrowserEngineMode('stream')}
              >
                {t('Cloud Stream')}
              </button>
              <button
                type="button"
                className={`os-browser-vp-btn${browserEngineMode === 'iframe' ? ' is-active' : ''}`}
                title={t('Direct Iframe Embed')}
                onClick={() => setBrowserEngineMode('iframe')}
              >
                {t('Direct Embed')}
              </button>
            </div>
            <button
              type="button"
              className="os-browser-nav-btn"
              title={t('Open in new tab')}
              onClick={() => {
                const activeTab = browserTabs.find((tItem) => tItem.id === activeBrowserTabId) ?? browserTabs[0];
                const targetUrl =
                  browserEngineMode === 'stream' && browserStreamFrame?.url
                    ? browserStreamFrame.url
                    : activeTab?.url;
                if (targetUrl && targetUrl !== 'about:home') {
                  window.open(targetUrl, '_blank', 'noopener,noreferrer');
                }
              }}
            >
              <ExternalLink size={13} />
            </button>
          </div>

          {browserEngineMode === 'stream' && <div className="os-browser-bookmarks-bar">
            <select aria-label={t('Connector')} value={browserConnectionId} disabled={browserBusy || !!browserUnknown.current}
              onChange={event => { setBrowserConnectionId(event.target.value); setBrowserRoots([]); setBrowserAgentId(''); }}>
              <option value="">{t('Select Connector')}</option>
              {browserConnections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <select aria-label={t('Workspace folder')} value={browserAgentId} disabled={!browserConnectionId || browserBusy || !!browserUnknown.current}
              onChange={event => setBrowserAgentId(event.target.value)}>
              <option value="">{t('Workspace folder')}</option>
              {browserRoots.filter(item => !item.readOnly).map(item => <option key={item.agentId} value={item.agentId}>{item.label}</option>)}
            </select>
            {!browserTarget && <span role="status">{t('Select a Connector and writable workspace before sending browser commands.')}</span>}
          </div>}
          {(browserNotice || browserUnknown.current) && <div className="os-browser-bookmarks-bar" role="status">
            <span>{browserNotice ? t(browserNotice) : t('Browser command outcome unknown. Input is paused; no command was resent.')}</span>
            {browserUnknown.current && <>
              <span>{browserUnknown.current.id}</span>
              <button type="button" disabled={browserBusy || browserUnknown.current.scope !== browserScope || browserUnknown.current.epoch !== browserEpoch}
                onClick={() => void checkOriginalBrowserCommand()}>{t('Check original command file')}</button>
            </>}
          </div>}
          <div className="os-browser-bookmarks-bar">
            {[
              { label: 'Bing', url: 'https://www.bing.com' },
              { label: 'Wikipedia', url: 'https://www.wikipedia.org' },
              { label: 'Hacker News', url: 'https://news.ycombinator.com' },
              { label: 'GitHub', url: 'https://github.com' },
              { label: 'MDN Docs', url: 'https://developer.mozilla.org' },
              { label: 'V2EX', url: 'https://www.v2ex.com' },
              { label: 'Example', url: 'https://example.com' },
            ].map((bm) => (
              <button
                key={bm.url}
                type="button"
                className="os-browser-bookmark-chip"
                onClick={() => {
                  setBrowserUrlInput(bm.url);
                  setBrowserTabs((prev) =>
                    prev.map((tab) =>
                      tab.id === activeBrowserTabId ? { ...tab, title: bm.label, url: bm.url } : tab,
                    ),
                  );
                  if (browserEngineMode === 'stream' && browserTarget) void sendBrowserStreamCommand({ action: 'navigate', url: bm.url });
                }}
              >
                <Globe size={11} />
                <span>{bm.label}</span>
              </button>
            ))}
            {browserEngineMode === 'stream' ? (
              <form
                className="os-browser-remote-input-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!browserRemoteText) return;
                  void sendBrowserStreamCommand({ action: 'type', text: browserRemoteText, submit: true });
                  setBrowserRemoteText('');
                }}
              >
                <input
                  name="os-browser-remote-type"
                  aria-label={t('Type into remote page + Enter...')}
                  disabled={!browserTarget || browserBusy || !!browserUnknown.current}
                  type="text"
                  value={browserRemoteText}
                  placeholder={t('Type into remote page + Enter...')}
                  onChange={(e) => setBrowserRemoteText(e.target.value)}
                />
                <button type="submit">{t('Send Text')}</button>
                <button
                  type="button"
                  onClick={() => void sendBrowserStreamCommand({ action: 'press', key: 'Enter' })}
                >
                  ↵
                </button>
              </form>
            ) : null}
          </div>

          <div className={`os-browser-stage viewport-${browserViewportMode}`}>
            {(() => {
              const activeTab = browserTabs.find((tItem) => tItem.id === activeBrowserTabId) ?? browserTabs[0];
              if (browserEngineMode === 'stream') {
                if (browserStreamFrame?.frameDataUrl) {
                  return (
                    <div className="os-browser-stream-viewport">
                      <img
                        src={browserStreamFrame.frameDataUrl}
                        alt={browserStreamFrame.title || t('Cloud Browser Stream')}
                        className="os-browser-stream-canvas"
                        data-testid="os-browser-stream-canvas"
                        draggable={false}
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          if (rect.width <= 0 || rect.height <= 0) return;
                          const scaleX = (browserStreamFrame.width || 1280) / rect.width;
                          const scaleY = (browserStreamFrame.height || 800) / rect.height;
                          const x = Math.round((e.clientX - rect.left) * scaleX);
                          const y = Math.round((e.clientY - rect.top) * scaleY);
                          void sendBrowserStreamCommand({ action: 'click', x, y });
                        }}
                        onWheel={(e) => {
                          void sendBrowserStreamCommand({
                            action: 'scroll',
                            deltaX: Math.round(e.deltaX),
                            deltaY: Math.round(e.deltaY),
                          });
                        }}
                      />
                      <div className="os-browser-stream-status-bar">
                        <span className="os-browser-stream-badge">{t('Playwright Chromium Stream')}</span>
                        <span className="os-browser-stream-url">{browserStreamFrame.url}</span>
                        {browserStreamFrame.error ? (
                          <span className="os-browser-stream-err">{browserStreamFrame.error}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="os-browser-home-launchpad" data-testid="os-browser-home-launchpad">
                    <h4>{t('Playwright Cloud Browser Engine')}</h4>
                    <p>
                      {t('Streams real Chromium frames to bypass X-Frame-Options and CSP restrictions. Pick a site above or enter any URL.')}
                    </p>
                  </div>
                );
              }
              if (!activeTab || activeTab.url === 'about:home') {
                return (
                  <div className="os-browser-home-launchpad" data-testid="os-browser-home-launchpad">
                    <h4>{t('Cloud Browser Launchpad')}</h4>
                    <p>{t('Select a bookmark chip above or enter an external URL to browse.')}</p>
                  </div>
                );
              }
              return (
                desktopEmbedUrl(activeTab.url, window.location.origin, new URL(apiUrl('/api'), window.location.origin).origin) ? <iframe
                  key={`${activeTab.id}-${browserReloadTick}`}
                  title={activeTab.title ?? t('Desktop Browser')}
                  src={desktopEmbedUrl(activeTab.url, window.location.origin, new URL(apiUrl('/api'), window.location.origin).origin)}
                  className="os-browser-iframe"
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                /> : <p role="alert">{t('Use an external HTTP or HTTPS website. Deck and API origins cannot be embedded.')}</p>
              );
            })()}
          </div>
          {!browserRect.maximized
            ? render8WayResizeHandles(
                "sys:browser",
                browserRect,
                (next) => setBrowserRect((prev) => ({ ...prev, ...next })),
                { minW: 440, minH: 300 },
                "os-browser-resize",
              )
            : null}
        </div>
      ) : null}

      {/* Recycle Bin Window (#13) */}
      {recycleBinOpen ? (
        <div
          className={`os-desktop-recycle-window${topSurfaceId === 'sys:recycle' ? ' is-active' : ''}`}
          data-os-window="sys:recycle"
          data-testid="os-desktop-recycle-window"
          role="dialog"
          aria-label={t('Recycle Bin')}
          style={{
            left: recycleRect.x,
            top: recycleRect.y,
            width: recycleRect.width,
            height: recycleRect.height,
            zIndex: getSurfaceZIndex("sys:recycle", false),
          }}
          onPointerDownCapture={() => bringSurfaceToFront("sys:recycle")}
          onFocusCapture={() => bringSurfaceToFront("sys:recycle")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header
            className="os-window-titlebar"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest("button")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              sysDragRef.current = {
                key: "sys:recycle",
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origX: recycleRect.x,
                origY: recycleRect.y,
              };
            }}
            onPointerMove={(e) => {
              const d = sysDragRef.current;
              if (!d || d.key !== "sys:recycle" || d.pointerId !== e.pointerId) return;
              const nx = Math.max(8, Math.min(surfaceWidth - 240, d.origX + (e.clientX - d.startX)));
              const ny = Math.max(6, Math.min(surfaceHeight - 100, d.origY + (e.clientY - d.startY)));
              setRecycleRect((prev) => ({ ...prev, x: Math.round(nx), y: Math.round(ny) }));
            }}
            onPointerUp={(e) => {
              if (sysDragRef.current?.pointerId === e.pointerId) {
                sysDragRef.current = null;
              }
            }}
          >
            <div className="os-window-title">
              <Trash2 size={14} />
              <strong>{t('Recycle Bin')}</strong>
              <span className="os-window-running-pill">{recycleItems.length}</span>
            </div>
            <div className="os-window-controls">
              {recycleItems.length > 0 ? (
                <button
                  type="button"
                  className="os-recycle-empty-btn"
                  onClick={emptyRecycleBin}
                >
                  {t('Empty Recycle Bin')}
                </button>
              ) : null}
              <button
                type="button"
                className="os-win-close-btn"
                aria-label={t('Close')}
                onClick={() => setRecycleBinOpen(false)}
              >
                <X size={13} />
              </button>
            </div>
          </header>
          <div className="os-recycle-body">
            {recycleItems.length === 0 ? (
              <div className="os-recycle-empty-state">
                <Trash2 size={28} />
                <p>{t('Recycle Bin is empty')}</p>
                <small>{t('Right-click any desktop icon and choose Move to Recycle Bin to archive it here.')}</small>
              </div>
            ) : (
              <div className="os-recycle-list">
                {recycleItems.map((item) => (
                  <div key={item.id} className="os-recycle-row">
                    <div className="os-recycle-row-info">
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind} · {new Date(item.deletedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </small>
                    </div>
                    <div className="os-recycle-row-actions">
                      <button
                        type="button"
                        onClick={() => restoreRecycledItem(item.id)}
                      >
                        <RotateCcw size={12} />
                        <span>{t('Restore')}</span>
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => permanentlyDeleteRecycledItem(item.id)}
                      >
                        <Trash2 size={12} />
                        <span>{t('Delete')}</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {render8WayResizeHandles(
            "sys:recycle",
            recycleRect,
            (next) => setRecycleRect(next),
            { minW: 340, minH: 220 },
            "os-recycle-resize",
          )}
        </div>
      ) : null}

      {/* Bottom-Right Notification Center Flyout */}
      {notificationCenterOpen ? (
        <aside
          className="os-desktop-notification-center"
          data-testid="os-desktop-notification-center"
          role="dialog"
          aria-label={t('Notification Center')}
          style={{ bottom: taskbarMetrics.taskbarHeight + 10 }}
        >
          <header className="os-notification-center-header">
            <div className="os-notification-center-title">
              <Bell size={14} />
              <strong>{t('Notification Center')}</strong>
              {unreadNotificationCount > 0 ? (
                <span className="os-notification-unread-badge">{unreadNotificationCount}</span>
              ) : null}
            </div>
            <div className="os-notification-center-actions">
              {unreadNotificationCount > 0 ? (
                <button
                  type="button"
                  title={t('Mark all read')}
                  onClick={() =>
                    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
                  }
                >
                  <CheckCheck size={12} />
                  <span>{t('Mark all read')}</span>
                </button>
              ) : null}
              {notifications.length > 0 ? (
                <button
                  type="button"
                  title={t('Clear all')}
                  onClick={() => setNotifications([])}
                >
                  <Trash2 size={12} />
                  <span>{t('Clear all')}</span>
                </button>
              ) : null}
              <button
                type="button"
                aria-label={t('Close')}
                onClick={() => setNotificationCenterOpen(false)}
              >
                <X size={13} />
              </button>
            </div>
          </header>
          <div className="os-notification-center-body">
            {notifications.length === 0 ? (
              <div className="os-notification-empty">
                <Bell size={24} />
                <p>{t('No notifications yet')}</p>
                <small>{t('Completed agent runs and desktop events will appear here.')}</small>
              </div>
            ) : (
              <div className="os-notification-list">
                {notifications.map((item) => (
                  <div
                    key={item.id}
                    className={`os-notification-item kind-${item.kind}${item.read ? '' : ' is-unread'}`}
                    onClick={() => {
                      setNotifications((prev) =>
                        prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)),
                      );
                      if (item.sessionKey) {
                        setNotificationCenterOpen(false);
                        openSessionFromNotification(item.sessionKey);
                      }
                    }}
                  >
                    <div className="os-notification-item-icon">
                      {item.kind === 'session-completed' ? (
                        <Check size={14} />
                      ) : item.kind === 'desktop-refreshed' ? (
                        <RefreshCw size={14} />
                      ) : (
                        <Sparkles size={14} />
                      )}
                    </div>
                    <div className="os-notification-item-content">
                      <div className="os-notification-item-top">
                        <strong>{item.title}</strong>
                        <small>
                          {new Date(item.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </small>
                      </div>
                      <p>{item.body}</p>
                    </div>
                    <button
                      type="button"
                      className="os-notification-item-dismiss"
                      aria-label={t('Dismiss')}
                      onClick={(e) => {
                        e.stopPropagation();
                        setNotifications((prev) => prev.filter((n) => n.id !== item.id));
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      ) : null}

      {/* Bottom-Right Fade-Out Toast Stack (Session Completed & Desktop Events) */}
      {activeToasts.length > 0 ? (
        <div
          className="os-desktop-toast-stack"
          data-testid="os-desktop-toast-stack"
          role="status"
          aria-live="polite"
          style={{ bottom: taskbarMetrics.taskbarHeight + 12 }}
        >
          {activeToasts.map((toast) => (
            <div
              key={toast.id}
              className={`os-desktop-toast kind-${toast.kind}${toast.fadingOut ? ' is-fading-out' : ''}`}
              data-testid="os-desktop-toast"
              onClick={() => {
                setActiveToasts((prev) => prev.filter((item) => item.id !== toast.id));
                setNotifications((prev) =>
                  prev.map((n) => (n.id === toast.id ? { ...n, read: true } : n)),
                );
                if (toast.sessionKey) {
                  openSessionFromNotification(toast.sessionKey);
                }
              }}
            >
              <div className="os-desktop-toast-icon">
                {toast.kind === 'session-completed' ? (
                  <Bot size={15} />
                ) : toast.kind === 'desktop-refreshed' ? (
                  <RefreshCw size={15} />
                ) : (
                  <Bell size={15} />
                )}
              </div>
              <div className="os-desktop-toast-text">
                <strong>{toast.title}</strong>
                <span>{toast.body}</span>
              </div>
              <button
                type="button"
                className="os-desktop-toast-close"
                aria-label={t('Dismiss')}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveToasts((prev) => prev.filter((item) => item.id !== toast.id));
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* OS Boot-up & Shutdown Power Animation Overlay */}
      {powerPhase !== 'ready' ? (
        <div
          className={`os-power-overlay is-${powerPhase === 'boot-fading' ? 'booting is-fading-out' : powerPhase}`}
          data-testid="os-power-overlay"
          data-power-phase={powerPhase === 'boot-fading' ? 'booting' : powerPhase}
          data-power-transition={powerPhase}
          role="status"
          aria-live="polite"
          onClick={() => {
            if (powerPhase === 'booting') {
              skipBootToSmoothFade();
            }
          }}
        >
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
              <span className={`os-power-hud-led ${powerPhase === 'shutting-down' ? 'is-amber' : ''}`}>
                <i />
                {powerPhase !== 'shutting-down' ? t('SYSTEM ONLINE') : t('POWER DOWN')}
              </span>
            </div>

            <div className="os-power-reactor" aria-hidden="true">
              <span className="os-power-orbit orbit-outer" />
              <span className="os-power-orbit orbit-middle" />
              <span className="os-power-orbit orbit-inner" />
              <span className="os-power-radar-sweep" />
              <div className="os-power-emblem">
                <Sparkles size={28} />
                <span className="os-power-ring" />
              </div>
            </div>

            <strong className="os-power-title">
              {powerPhase !== 'shutting-down'
                ? t('Starting AgentOpsDeck OS Desktop…')
                : t('Shutting down AgentOpsDeck OS Desktop…')}
            </strong>
            <span className="os-power-subtitle">
              {powerPhase !== 'shutting-down'
                ? bootStepIndex === 0
                  ? t('Initializing multi-agent kernel & workspace surface…')
                  : bootStepIndex === 1
                    ? t('Mounting Stardock Fences, Lineage graph & Telemetry HUD…')
                    : t('Desktop workspace ready')
                : t('Saving window geometry, Fences state & returning to Classic view…')}
            </span>

            <div className="os-power-modules-grid" aria-hidden="true">
              <div className="os-power-module-pill is-done">
                <span className="module-dot" />
                <span>{t('IDENTITY VAULT')}</span>
                <b>{t('OK')}</b>
              </div>
              <div
                className={`os-power-module-pill ${
                  powerPhase === 'shutting-down'
                    ? 'is-active'
                    : bootStepIndex >= 1
                      ? 'is-done'
                      : 'is-active'
                }`}
              >
                <span className="module-dot" />
                <span>{t('AGENT MESH')}</span>
                <b>{powerPhase === 'shutting-down' ? t('FLUSH') : bootStepIndex >= 1 ? t('ONLINE') : t('INIT')}</b>
              </div>
              <div
                className={`os-power-module-pill ${
                  powerPhase === 'shutting-down'
                    ? 'is-active'
                    : bootStepIndex >= 2
                      ? 'is-done'
                      : bootStepIndex === 1
                        ? 'is-active'
                        : ''
                }`}
              >
                <span className="module-dot" />
                <span>{t('FENCES COMPOSITOR')}</span>
                <b>{powerPhase === 'shutting-down' ? t('SYNC') : bootStepIndex >= 2 ? t('LOCKED') : t('MOUNT')}</b>
              </div>
            </div>

            <div className="os-power-progress-wrap">
              <div className="os-power-progress-meta" aria-hidden="true">
                <span>
                  {powerPhase !== 'shutting-down'
                    ? `${t('BOOT_SEQUENCE // STAGE')} 0${bootStepIndex + 2}`
                    : t('SHUTDOWN_SEQUENCE // STATE FLUSH')}
                </span>
                <span>
                  {powerPhase !== 'shutting-down'
                    ? bootStepIndex === 0
                      ? '58%'
                      : bootStepIndex === 1
                        ? '86%'
                        : '100%'
                    : '100%'}
                </span>
              </div>
              <div className="os-power-progress-track">
                <div
                  className="os-power-progress-bar"
                  style={{
                    width:
                      powerPhase !== 'shutting-down'
                        ? bootStepIndex === 0
                          ? '58%'
                          : bootStepIndex === 1
                            ? '86%'
                            : '100%'
                        : '100%',
                  }}
                />
              </div>
            </div>

            {powerPhase === 'booting' ? (
              <span className="os-power-skip-hint">{t('Click anywhere or press Esc to enter immediately')}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Bottom OS Taskbar (#6 Resizable Height & #7 Integrated Spotlight Search + Quick Actions) */}
      <footer
        className="os-desktop-taskbar"
        role="toolbar"
        aria-label={t('Desktop taskbar')}
        style={{ height: taskbarMetrics.taskbarHeight }}
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('input')) return;
          openTaskbarContextMenu(e, { kind: 'bar', title: t('Desktop taskbar') });
        }}
      >
        <div
          className="os-taskbar-resize-handle"
          data-testid="os-taskbar-resize-handle"
          title={t('Drag to resize taskbar height')}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            taskbarResizeRef.current = {
              pointerId: e.pointerId,
              startY: e.clientY,
              origH: prefs.taskbarHeight ?? 48,
            };
          }}
          onPointerMove={(e) => {
            const r = taskbarResizeRef.current;
            if (!r || r.pointerId !== e.pointerId) return;
            const nextH = Math.max(38, Math.min(96, Math.round(r.origH + (r.startY - e.clientY))));
            setPrefs((prev) => (prev.taskbarHeight === nextH ? prev : { ...prev, taskbarHeight: nextH }));
          }}
          onPointerUp={(e) => {
            if (taskbarResizeRef.current?.pointerId === e.pointerId) {
              taskbarResizeRef.current = null;
            }
          }}
        />
        <button
          type="button"
          className={`os-taskbar-start-btn${startMenuOpen ? ' is-open' : ''}`}
          aria-expanded={startMenuOpen}
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'start', title: t('Start') })}
          onClick={() => {
            setTrayFlyoutOpen(false);
            setNotificationCenterOpen(false);
            setStartMenuOpen((v) => !v);
          }}
        >
          <LayoutGrid size={taskbarMetrics.startIconSize} />
          <span>{t('Start')}</span>
        </button>

        <div className="os-desktop-search-box os-taskbar-search-box">
          <Search size={Math.max(12, taskbarMetrics.iconSize - 1)} />
          <input
            name="os-desktop-search"
            type="search"
            value={searchQuery}
            placeholder={t('Search desktop sessions & apps…')}
            aria-label={t('Search desktop sessions & apps…')}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              className="os-search-clear-btn"
              aria-label={t('Clear')}
              onClick={() => setSearchQuery('')}
            >
              <X size={taskbarMetrics.closeIconSize} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className={`os-taskbar-quick-btn${taskViewOpen ? ' is-active' : ''}`}
          title={t('Task View')}
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'taskview', title: t('Task View') })}
          aria-label={t('Task View')}
          onClick={() => setTaskViewOpen((v) => !v)}
        >
          <Columns2 size={taskbarMetrics.iconSize} />
          {openWindows.length > 0 ? (
            <span className="os-taskbar-count-badge">{openWindows.length}</span>
          ) : null}
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${wechatOpen ? " is-active" : ""}`}
          title={t("Chat Studio")}
          aria-label={t("Chat Studio")}
          data-testid="os-taskbar-wechat-btn"
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'wechat', title: t('Chat Studio') })}
          onClick={() => {
            if (wechatOpen) {
              setWechatOpen(false);
            } else {
              openWechatMessenger();
            }
          }}
        >
          <MessageSquare size={taskbarMetrics.iconSize} />
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${explorerOpen ? ' is-active' : ''}`}
          title={t('Session Explorer')}
          aria-label={t('Session Explorer')}
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'explorer', title: t('Session Explorer') })}
          onClick={() => setExplorerOpen((v) => { const next = !v; if (next) bringSurfaceToFront("sys:explorer"); return next; })}
        >
          <FolderOpen size={taskbarMetrics.iconSize} />
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${browserOpen ? ' is-active' : ''}`}
          title={t('Web Preview')}
          aria-label={t('Web Preview')}
          data-testid="os-taskbar-browser-btn"
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'browser', title: t('Web Preview') })}
          onClick={() => setBrowserOpen((v) => { const next = !v; if (next) bringSurfaceToFront("sys:browser"); return next; })}
        >
          <Globe size={taskbarMetrics.iconSize} />
        </button>

        <button
          type="button"
          className="os-taskbar-quick-btn"
          title={t('New desktop file')}
          aria-label={t('New desktop file')}
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'new-file', title: t('New desktop file') })}
          onClick={() => createNewDesktopFile()}
        >
          <FilePlus2 size={taskbarMetrics.iconSize} />
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${prefs.fencesEnabled !== false ? ' is-active' : ''}`}
          title={t('Toggle Desktop Fences zones')}
          aria-label={t('Desktop Fences')}
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'fences', title: t('Desktop Fences') })}
          onClick={() =>
            setPrefs((prev) => ({
              ...prev,
              fencesEnabled: prev.fencesEnabled === false,
            }))
          }
        >
          <Layers size={taskbarMetrics.iconSize} />
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn os-taskbar-lineage-pill${lineageInspectorOpen || prefs.showLineageLines !== false ? ' is-active' : ''}`}
          title={t('View Lineage & Binding Lines (Session / Notebook / Taskboard)')}
          aria-label={t('Lineage / Links')}
          data-testid="os-taskbar-lineage-btn"
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'lineage', title: t('Lineage / Links') })}
          onClick={() => {
            const isCurrentlyActive = lineageInspectorOpen || prefs.showLineageLines !== false || linkConnectMode;
            if (isCurrentlyActive) {
              setLineageInspectorOpen(false);
              setLinkConnectMode(false);
              setPendingLinkSourceId(null);
              setHighlightedLineageNodeId(null);
              setPrefs((prev) => ({ ...prev, showLineageLines: false }));
            } else {
              setPrefs((prev) => ({ ...prev, showLineageLines: true }));
              setLineageInspectorOpen(true);
            }
          }}
        >
          <GitBranch size={taskbarMetrics.iconSize} />
          <span className="os-taskbar-lineage-label">{t('Lineage / Links')}</span>
          {resolvedLineageEdges.length > 0 ? (
            <span className="os-taskbar-count-badge">{resolvedLineageEdges.length}</span>
          ) : null}
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${linkConnectMode ? ' is-active' : ''}`}
          title={t('Connect / Link Desktop Items')}
          aria-label={t('Connect / Link Desktop Items')}
          data-testid="os-taskbar-link-btn"
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'link', title: t('Connect / Link Desktop Items') })}
          onClick={() => {
            if (linkConnectMode) {
              setLinkConnectMode(false);
              setPendingLinkSourceId(null);
              if (!lineageInspectorOpen) {
                setPrefs((prev) => ({ ...prev, showLineageLines: false }));
              }
            } else {
              setPrefs((prev) => ({ ...prev, showLineageLines: true }));
              setLinkConnectMode(true);
              setPendingLinkSourceId(null);
            }
          }}
        >
          <Link2 size={taskbarMetrics.iconSize} />
          {desktopBindings.length > 0 ? (
            <span className="os-taskbar-count-badge">{desktopBindings.length}</span>
          ) : null}
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${hudOpen ? ' is-active' : ''}`}
          title={t('System & Telemetry HUD')}
          aria-label={t('Telemetry HUD')}
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'hud', title: t('Telemetry HUD') })}
          onClick={() => setHudOpen((v) => !v)}
        >
          <Gauge size={taskbarMetrics.iconSize} />
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${recycleBinOpen ? ' is-active' : ''}`}
          title={t('Recycle Bin')}
          aria-label={t('Recycle Bin')}
          data-testid="os-taskbar-recycle-btn"
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'recycle', title: t('Recycle Bin') })}
          onClick={() => setRecycleBinOpen((v) => { const next = !v; if (next) bringSurfaceToFront("sys:recycle"); return next; })}
        >
          <Trash2 size={taskbarMetrics.iconSize} />
          {recycleItems.length > 0 ? (
            <span className="os-taskbar-count-badge">{recycleItems.length}</span>
          ) : null}
        </button>

        <button
          type="button"
          className={`os-taskbar-quick-btn${settingsOpen ? ' is-active' : ''}`}
          title={t('System Settings & Personalization')}
          aria-label={t('Settings')}
          data-testid="os-top-settings-btn"
          onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'quick', quickId: 'settings', title: t('Settings') })}
          onClick={() => setSettingsOpen((v) => { const next = !v; if (next) bringSurfaceToFront("sys:settings"); return next; })}
        >
          <Settings size={taskbarMetrics.iconSize} />
        </button>

        <div className="os-taskbar-window-strip">
          {openWindows.map((win) => {
            const isMin = isWindowMinimized(win);
            const isAct = !isMin && activeWindowId === win.id;
            return (
              <div
                key={win.id}
                className={`os-taskbar-window-pill${isAct ? ' is-active' : ''}${isMin ? ' is-minimized' : ''}${win.running ? ' is-running' : ''}`}
                onContextMenu={(e) => openTaskbarContextMenu(e, { kind: 'window', win, title: win.title })}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseWindow(win.id);
                  }
                }}
              >
                <button
                  type="button"
                  className="os-taskbar-window-pill-main"
                  onClick={() => {
                    if (isMin) {
                      restoreAndFocusWindow(win);
                    } else if (isAct) {
                      toggleWindowMinimized(win);
                    } else {
                      restoreAndFocusWindow(win);
                    }
                  }}
                >
                  {renderIconGlyph(win.kind, win.running, taskbarMetrics.iconSize)}
                  <span className="os-taskbar-pill-title">{win.title}</span>
                  {secondaryWindowIds.includes(win.id) ? (
                    <span
                      className="os-taskbar-window-pill-screen-badge"
                      title={t('Showing on Secondary Display (Display 2) — click to recall')}
                      onClick={(ev) => {
                        if (!isSecondaryDisplay) {
                          ev.stopPropagation();
                          transferWindowToDisplay(win.id, 'primary', { title: win.title, kind: win.kind });
                        }
                      }}
                    >
                      2
                    </span>
                  ) : null}
                  {win.running ? <span className="os-taskbar-running-dot" /> : null}
                </button>
                <button
                  type="button"
                  className="os-taskbar-pill-close"
                  aria-label={t('Close pane')}
                  title={t('Close pane')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseWindow(win.id);
                  }}
                >
                  <X size={taskbarMetrics.closeIconSize} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="os-taskbar-tray">
          <AppBuildLabel versionLabel={t('Version')} buildLabel={t('Build number')} />
          <button
            type="button"
            className="os-taskbar-tray-btn"
            data-testid="os-taskbar-theme-toggle"
            title={colorMode === "dark" ? t("Switch to Light Mode") : t("Switch to Dark Mode")}
            aria-label={colorMode === "dark" ? t("Switch to Light Mode") : t("Switch to Dark Mode")}
            onClick={() => setColorMode(toggleWorkspaceColorMode())}
          >
            {colorMode === "dark" ? (
              <Sun size={Math.max(13, taskbarMetrics.iconSize - 1)} />
            ) : (
              <Moon size={Math.max(13, taskbarMetrics.iconSize - 1)} />
            )}
          </button>
          <button
            type="button"
            className={`os-taskbar-tray-btn os-taskbar-notif-btn${notificationCenterOpen ? ' is-open' : ''}${unreadNotificationCount > 0 ? ' has-unread' : ''}`}
            data-testid="os-taskbar-notifications-btn"
            title={t('Notification Center')}
            aria-label={t('Notification Center')}
            onClick={() => {
              setStartMenuOpen(false);
              setTrayFlyoutOpen(false);
              setNotificationCenterOpen((v) => {
                const next = !v;
                if (next) {
                  setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                }
                return next;
              });
            }}
          >
            <Bell size={Math.max(13, taskbarMetrics.iconSize - 1)} />
            {unreadNotificationCount > 0 ? (
              <span className="os-taskbar-notif-badge" data-testid="os-taskbar-notif-badge">
                {unreadNotificationCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={`os-taskbar-tray-btn${trayFlyoutOpen ? ' is-open' : ''}`}
            title={t('Desktop Control Center')}
            onClick={() => {
              setStartMenuOpen(false);
              setNotificationCenterOpen(false);
              setTrayFlyoutOpen((v) => !v);
            }}
          >
            <SlidersHorizontal size={Math.max(13, taskbarMetrics.iconSize - 1)} />
            <span className="os-taskbar-tray-stat">
              <Bot size={Math.max(13, taskbarMetrics.iconSize - 1)} />
              <strong>{runningCount}</strong>
            </span>
          </button>
          <div className="os-taskbar-clock-group">
            <span className="os-taskbar-clock">{clockText}</span>
            <small className="os-taskbar-date">{dateText}</small>
          </div>
          <button
            type="button"
            className="os-taskbar-show-desktop-sliver"
            title={t('Show desktop')}
            aria-label={t('Show desktop')}
            onClick={() => setShowDesktopAllMinimized((v) => !v)}
          />
        </div>
      </footer>
    </div>
  );
}
