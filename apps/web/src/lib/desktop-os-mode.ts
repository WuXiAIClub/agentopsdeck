import type { SessionSummary } from '@agentopsdeck/shared';

function sessionDisplayTitle(session: SessionSummary): string {
  const raw = session.title?.trim();
  if (raw && raw !== session.sessionKey && !raw.startsWith('agent:')) return raw;
  if (raw && raw.startsWith('agent:')) return raw.slice(6);
  const parts = session.sessionKey.split(':');
  return parts[parts.length - 1]?.slice(0, 24) || session.sessionKey;
}

export type WorkspaceUiMode = 'classic' | 'os-desktop';
export type WorkspaceColorMode = 'dark' | 'light';

export type DesktopWallpaperTheme =
  | 'aurora'
  | 'midnight'
  | 'cybergrid'
  | 'graphite'
  | 'sunset'
  | 'oceanic'
  | 'sakura'
  | 'custom';

export type DesktopWallpaperFit = 'cover' | 'contain' | 'fill';

export type DesktopWallpaperConfig = {
  theme: DesktopWallpaperTheme;
  customImageUrl?: string | undefined;
  customGradient?: string | undefined;
  fit?: DesktopWallpaperFit | undefined;
  dimOpacity?: number | undefined;
  blurPx?: number | undefined;
};

export type DesktopQqDockSize = {
  width: number;
  height: number;
};

export type DesktopIconSize = 'sm' | 'md' | 'lg';

export type DesktopSortBy = 'default' | 'name' | 'status' | 'kind';

export type DesktopSnapZone =
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'maximize';

export type DesktopResizeEdge =
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw';

export type DesktopIconKind =
  | 'session'
  | 'file-browser'
  | 'notebook'
  | 'taskboard'
  | 'terminal'
  | 'dashboard'
  | 'antigravity-quota'
  | 'git-repo-status'
  | 'drawing'
  | 'moderator'
  | 'docker'
  | 'git-tree'
  | 'browser'
  | 'media'
  | 'statuscard'
  | 'subagents'
  | 'desktop-file'
  | 'recycle-bin'
  | 'system-settings'
  | 'wechat-messenger';

export type DesktopFenceId = 'sessions' | 'knowledge' | 'tools-files';

export type DesktopIconVariant =
  | 'default'
  | 'meeting-note'
  | 'session-note'
  | 'kanban-board'
  | 'sprint-board'
  | 'status-card'
  | 'new-action'
  | 'session-explorer'
  | 'recycle-bin'
  | 'system-settings'
  | 'wechat-messenger';

export type DesktopIconItem = {
  id: string;
  kind: DesktopIconKind;
  title: string;
  subtitle?: string | undefined;
  badge?: string | undefined;
  running?: boolean | undefined;
  unread?: boolean | undefined;
  session?: SessionSummary | undefined;
  resourceId?: string | undefined;
  fenceId?: DesktopFenceId | undefined;
  variant?: DesktopIconVariant | undefined;
};

export type DesktopWindowGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized?: boolean | undefined;
  maximized?: boolean | undefined;
  snapped?: DesktopSnapZone | undefined;
  restoreRect?: { x: number; y: number; width: number; height: number } | undefined;
};

export type DesktopIconPosition = {
  x: number;
  y: number;
};

export type DesktopFenceGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number | undefined;
};

export type DesktopFileAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size?: number | undefined;
};

export type DesktopFileEntry = {
  id: string;
  name: string;
  content: string;
  fileType?: 'markdown' | 'text' | 'json' | 'image' | 'mixed' | undefined;
  attachments?: DesktopFileAttachment[] | undefined;
  path?: string | undefined;
  connectionId?: string | undefined;
  agentId?: string | undefined;
  updatedAt: number;
};

export type DesktopRecycleItem = {
  id: string;
  originalIconId?: string | undefined;
  kind: DesktopIconKind;
  title: string;
  subtitle?: string | undefined;
  resourceId?: string | undefined;
  sessionKey?: string | undefined;
  fileEntry?: DesktopFileEntry | undefined;
  fileSnapshot?: DesktopFileEntry | undefined;
  deletedAt: number;
};

export type DesktopBindingLink = {
  id: string;
  fromId: string;
  toId: string;
  sourceId?: string | undefined;
  targetId?: string | undefined;
  label?: string | undefined;
  createdAt: number;
};

export type DesktopPreferences = {
  iconSize: DesktopIconSize;
  sortBy: DesktopSortBy;
  showDesktopIcons: boolean;
  fencesEnabled?: boolean | undefined;
  collapsedFences?: DesktopFenceId[] | undefined;
  taskbarHeight?: number | undefined;
  freeDesktopIconIds?: string[] | undefined;
  showLineageLines?: boolean | undefined;
};

const MODE_STORAGE_PREFIX = 'agentopsdeck:ui-mode:v1:';
const LAST_MODE_STORAGE_KEY = 'agentopsdeck:ui-mode:last';
const RECTS_STORAGE_PREFIX = 'agentopsdeck:os-window-rects:v1:';
const WALLPAPER_STORAGE_PREFIX = 'agentopsdeck:os-wallpaper:v1:';
const ICON_POS_STORAGE_PREFIX = 'agentopsdeck:os-icon-pos:v1:';
const PREFS_STORAGE_PREFIX = 'agentopsdeck:os-prefs:v1:';
const MINIMIZED_STORAGE_PREFIX = 'agentopsdeck:os-minimized:v1:';

export function isMobileViewport(viewportWidth?: number): boolean {
  const width =
    typeof viewportWidth === 'number' && Number.isFinite(viewportWidth)
      ? viewportWidth
      : typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1280;
  return width > 0 && width < 768;
}

export function isDesktopUrlRoute(hash?: string, search?: string): boolean {
  const rawHash = (
    typeof hash === 'string'
      ? hash
      : typeof window !== 'undefined' && window.location
        ? window.location.hash
        : ''
  )
    .replace(/^#\/?/, '')
    .trim()
    .toLowerCase();
  if (rawHash === 'desktop' || rawHash === 'os-desktop' || rawHash === 'tab/desktop') {
    return true;
  }
  const rawSearch =
    typeof search === 'string'
      ? search
      : typeof window !== 'undefined' && window.location
        ? window.location.search
        : '';
  if (rawSearch) {
    try {
      const params = new URLSearchParams(rawSearch);
      const ui = params.get('ui')?.toLowerCase();
      if (ui === 'desktop' || ui === 'os-desktop') return true;
    } catch {
      // Ignore malformed search query
    }
  }
  return false;
}

export function syncDesktopImmersiveDataset(mode: WorkspaceUiMode, viewportWidth?: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (mode === 'os-desktop' && !isMobileViewport(viewportWidth)) {
    document.documentElement.dataset.osDesktopImmersive = 'true';
  } else {
    delete document.documentElement.dataset.osDesktopImmersive;
  }
}

export function syncDesktopUrlHash(mode: WorkspaceUiMode, viewportWidth?: number): void {
  if (typeof window === 'undefined' || !window.history || !window.location) return;
  if (isMobileViewport(viewportWidth)) return;
  const currentHash = window.location.hash || '';
  const normalized = currentHash.replace(/^#\/?/, '');
  if (mode === 'os-desktop') {
    if (!normalized || normalized === 'tab/sessions' || normalized === 'sessions' || normalized === 'desktop' || normalized === 'os-desktop') {
      if (currentHash !== '#/desktop') {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/desktop`);
      }
    }
  } else if (normalized === 'desktop' || normalized === 'os-desktop' || normalized === 'tab/desktop') {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/tab/sessions`);
  }
}

export function readWorkspaceUiMode(
  scope: string | undefined,
  viewportWidth?: number,
  hash?: string,
  search?: string,
): WorkspaceUiMode {
  if (isMobileViewport(viewportWidth)) return 'classic';
  if (isDesktopUrlRoute(hash, search)) return 'os-desktop';
  if (typeof localStorage === 'undefined') return 'classic';
  try {
    if (scope) {
      const scoped = localStorage.getItem(`${MODE_STORAGE_PREFIX}${scope}`);
      if (scoped === 'os-desktop' || scoped === 'classic') {
        return scoped;
      }
    }
    const last = localStorage.getItem(LAST_MODE_STORAGE_KEY);
    if (last === 'os-desktop') return 'os-desktop';
    if (!scope) {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(MODE_STORAGE_PREFIX)) {
          if (localStorage.getItem(key) === 'os-desktop') return 'os-desktop';
        }
      }
    }
    return 'classic';
  } catch {
    return 'classic';
  }
}

export function writeWorkspaceUiMode(scope: string | undefined, mode: WorkspaceUiMode, viewportWidth?: number): void {
  const effectiveMode: WorkspaceUiMode = isMobileViewport(viewportWidth) ? 'classic' : mode;
  syncDesktopImmersiveDataset(effectiveMode, viewportWidth);
  syncDesktopUrlHash(effectiveMode, viewportWidth);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAST_MODE_STORAGE_KEY, effectiveMode);
    if (scope) {
      localStorage.setItem(`${MODE_STORAGE_PREFIX}${scope}`, effectiveMode);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function bootstrapDesktopImmersiveDataset(scope?: string, viewportWidth?: number): WorkspaceUiMode {
  const mode = readWorkspaceUiMode(scope, viewportWidth);
  syncDesktopImmersiveDataset(mode, viewportWidth);
  if (mode === 'os-desktop') {
    syncDesktopUrlHash(mode, viewportWidth);
  }
  return mode;
}


export const COLOR_MODE_STORAGE_KEY = 'agentopsdeck:color-mode:v1';
export const COLOR_MODE_CHANGE_EVENT = 'agentopsdeck:color-mode-change';

export function isValidColorMode(raw: unknown): raw is WorkspaceColorMode {
  return raw === 'dark' || raw === 'light';
}

export function readWorkspaceColorMode(): WorkspaceColorMode {
  if (typeof localStorage === 'undefined') return 'light';
  try {
    const raw = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    if (isValidColorMode(raw)) return raw;
  } catch {
    // Ignore storage access errors
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    const attr = document.documentElement.dataset.colorMode;
    if (isValidColorMode(attr)) return attr;
  }
  return 'light';
}

export function syncWorkspaceColorModeDataset(mode: WorkspaceColorMode): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.colorMode = mode;
  document.documentElement.classList.toggle('theme-dark', mode === 'dark');
  document.documentElement.classList.toggle('theme-light', mode === 'light');
  document.documentElement.style.colorScheme = mode;
}

export function writeWorkspaceColorMode(mode: WorkspaceColorMode): WorkspaceColorMode {
  const safeMode: WorkspaceColorMode = isValidColorMode(mode) ? mode : 'light';
  syncWorkspaceColorModeDataset(safeMode);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(COLOR_MODE_STORAGE_KEY, safeMode);
    } catch {
      // Ignore storage quota errors
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(COLOR_MODE_CHANGE_EVENT, { detail: { mode: safeMode } }));
    } catch {
      // Ignore event dispatch errors
    }
  }
  return safeMode;
}

export function toggleWorkspaceColorMode(current?: WorkspaceColorMode): WorkspaceColorMode {
  const base = isValidColorMode(current) ? current : readWorkspaceColorMode();
  return writeWorkspaceColorMode(base === 'dark' ? 'light' : 'dark');
}

if (typeof document !== 'undefined') {
  bootstrapDesktopImmersiveDataset();
  syncWorkspaceColorModeDataset(readWorkspaceColorMode());
}

export function readDesktopWindowRects(
  scope: string | undefined,
): Record<string, DesktopWindowGeometry> {
  if (!scope || typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`${RECTS_STORAGE_PREFIX}${scope}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DesktopWindowGeometry>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function writeDesktopWindowRects(
  scope: string | undefined,
  rects: Record<string, DesktopWindowGeometry>,
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${RECTS_STORAGE_PREFIX}${scope}`, JSON.stringify(rects));
  } catch {
    // Ignore storage quota errors
  }
}

const WALLPAPER_CONFIG_STORAGE_PREFIX = 'agentopsdeck:os-wallpaper-cfg:v1:';
const QQ_DOCK_SIZE_STORAGE_PREFIX = 'agentopsdeck:os-qq-size:v1:';

export function isValidWallpaperTheme(raw: unknown): raw is DesktopWallpaperTheme {
  return (
    raw === 'aurora' ||
    raw === 'midnight' ||
    raw === 'cybergrid' ||
    raw === 'graphite' ||
    raw === 'sunset' ||
    raw === 'oceanic' ||
    raw === 'sakura' ||
    raw === 'custom'
  );
}

const memoryWallpaperStore = new Map<string, DesktopWallpaperTheme>();
const memoryWallpaperConfigStore = new Map<string, DesktopWallpaperConfig>();

export function readDesktopWallpaper(scope: string | undefined): DesktopWallpaperTheme {
  const effScope = scope && scope.trim() ? scope : 'default';
  if (typeof localStorage !== 'undefined') {
    try {
      const raw =
        localStorage.getItem(`${WALLPAPER_STORAGE_PREFIX}${effScope}`) ??
        localStorage.getItem(`${WALLPAPER_STORAGE_PREFIX}default`);
      if (isValidWallpaperTheme(raw)) {
        return raw;
      }
    } catch {
      // Fall through to in-memory store for strict private browsing
    }
  }
  return memoryWallpaperStore.get(effScope) ?? memoryWallpaperStore.get('default') ?? 'aurora';
}

export function writeDesktopWallpaper(
  scope: string | undefined,
  theme: DesktopWallpaperTheme,
): void {
  const effScope = scope && scope.trim() ? scope : 'default';
  memoryWallpaperStore.set(effScope, theme);
  memoryWallpaperStore.set('default', theme);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${WALLPAPER_STORAGE_PREFIX}${effScope}`, theme);
    localStorage.setItem(`${WALLPAPER_STORAGE_PREFIX}default`, theme);
  } catch {
    // Ignore storage quota errors in private mode
  }
}

export function readDesktopWallpaperConfig(scope: string | undefined): DesktopWallpaperConfig {
  const effScope = scope && scope.trim() ? scope : 'default';
  const baseTheme = readDesktopWallpaper(effScope);
  const fallback: DesktopWallpaperConfig = {
    theme: baseTheme,
    fit: 'cover',
    dimOpacity: 0.18,
    blurPx: 0,
  };
  if (typeof localStorage !== 'undefined') {
    try {
      const raw =
        localStorage.getItem(`${WALLPAPER_CONFIG_STORAGE_PREFIX}${effScope}`) ??
        localStorage.getItem(`${WALLPAPER_CONFIG_STORAGE_PREFIX}default`);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<DesktopWallpaperConfig>;
        if (parsed && typeof parsed === 'object') {
          const theme = isValidWallpaperTheme(parsed.theme) ? parsed.theme : baseTheme;
          const fit: DesktopWallpaperFit =
            parsed.fit === 'contain' || parsed.fit === 'fill' || parsed.fit === 'cover'
              ? parsed.fit
              : 'cover';
          const dimOpacity =
            typeof parsed.dimOpacity === 'number' && Number.isFinite(parsed.dimOpacity)
              ? Math.max(0, Math.min(0.85, parsed.dimOpacity))
              : 0.18;
          const blurPx =
            typeof parsed.blurPx === 'number' && Number.isFinite(parsed.blurPx)
              ? Math.max(0, Math.min(28, parsed.blurPx))
              : 0;
          return {
            theme,
            customImageUrl: typeof parsed.customImageUrl === 'string' ? parsed.customImageUrl : undefined,
            customGradient: typeof parsed.customGradient === 'string' ? parsed.customGradient : undefined,
            fit,
            dimOpacity,
            blurPx,
          };
        }
      }
    } catch {
      // Fall through to in-memory store
    }
  }
  return memoryWallpaperConfigStore.get(effScope) ?? memoryWallpaperConfigStore.get('default') ?? fallback;
}

export function writeDesktopWallpaperConfig(
  scope: string | undefined,
  config: DesktopWallpaperConfig,
): void {
  const effScope = scope && scope.trim() ? scope : 'default';
  memoryWallpaperStore.set(effScope, config.theme);
  memoryWallpaperStore.set('default', config.theme);
  memoryWallpaperConfigStore.set(effScope, config);
  memoryWallpaperConfigStore.set('default', config);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${WALLPAPER_STORAGE_PREFIX}${effScope}`, config.theme);
    localStorage.setItem(`${WALLPAPER_STORAGE_PREFIX}default`, config.theme);
    localStorage.setItem(`${WALLPAPER_CONFIG_STORAGE_PREFIX}${effScope}`, JSON.stringify(config));
    localStorage.setItem(`${WALLPAPER_CONFIG_STORAGE_PREFIX}default`, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors in private mode
  }
}

export function readDesktopQqDockSize(scope: string | undefined): DesktopQqDockSize {
  const fallback: DesktopQqDockSize = { width: 300, height: 480 };
  if (!scope || typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(`${QQ_DOCK_SIZE_STORAGE_PREFIX}${scope}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DesktopQqDockSize>;
    const width =
      typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? Math.max(230, Math.min(620, Math.round(parsed.width)))
        : fallback.width;
    const height =
      typeof parsed.height === 'number' && Number.isFinite(parsed.height)
        ? Math.max(240, Math.min(920, Math.round(parsed.height)))
        : fallback.height;
    return { width, height };
  } catch {
    return fallback;
  }
}

export function writeDesktopQqDockSize(
  scope: string | undefined,
  size: DesktopQqDockSize,
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${QQ_DOCK_SIZE_STORAGE_PREFIX}${scope}`, JSON.stringify(size));
  } catch {
    // Ignore storage quota errors
  }
}

export function readDesktopIconPositions(
  scope: string | undefined,
): Record<string, DesktopIconPosition> {
  if (!scope || typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`${ICON_POS_STORAGE_PREFIX}${scope}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DesktopIconPosition>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function writeDesktopIconPositions(
  scope: string | undefined,
  positions: Record<string, DesktopIconPosition>,
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${ICON_POS_STORAGE_PREFIX}${scope}`, JSON.stringify(positions));
  } catch {
    // Ignore storage quota errors
  }
}

export function readDesktopPreferences(scope: string | undefined): DesktopPreferences {
  const fallback: DesktopPreferences = {
    iconSize: 'md',
    sortBy: 'default',
    showDesktopIcons: true,
    fencesEnabled: true,
    collapsedFences: [],
    showLineageLines: true,
  };
  if (!scope || typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(`${PREFS_STORAGE_PREFIX}${scope}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DesktopPreferences>;
    const validFences = Array.isArray(parsed.collapsedFences)
      ? parsed.collapsedFences.filter(
          (f): f is DesktopFenceId =>
            f === 'sessions' || f === 'knowledge' || f === 'tools-files',
        )
      : [];
    const taskbarHeight =
      typeof parsed.taskbarHeight === 'number' && Number.isFinite(parsed.taskbarHeight)
        ? Math.max(38, Math.min(96, Math.round(parsed.taskbarHeight)))
        : 48;
    const freeDesktopIconIds = Array.isArray(parsed.freeDesktopIconIds)
      ? parsed.freeDesktopIconIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : undefined;
    return {
      iconSize:
        parsed.iconSize === 'sm' || parsed.iconSize === 'md' || parsed.iconSize === 'lg'
          ? parsed.iconSize
          : 'md',
      sortBy:
        parsed.sortBy === 'name' ||
        parsed.sortBy === 'status' ||
        parsed.sortBy === 'kind' ||
        parsed.sortBy === 'default'
          ? parsed.sortBy
          : 'default',
      showDesktopIcons: parsed.showDesktopIcons !== false,
      fencesEnabled: parsed.fencesEnabled !== false,
      collapsedFences: validFences,
      taskbarHeight,
      freeDesktopIconIds,
      showLineageLines: parsed.showLineageLines !== false,
    };
  } catch {
    return fallback;
  }
}

export function writeDesktopPreferences(
  scope: string | undefined,
  prefs: DesktopPreferences,
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${PREFS_STORAGE_PREFIX}${scope}`, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

export function readDesktopMinimizedIds(scope: string | undefined): string[] {
  if (!scope || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${MINIMIZED_STORAGE_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const DESKTOP_FILES_STORAGE_PREFIX = 'agentopsdeck:os-desktop-files:v1:';
const FENCE_RECTS_STORAGE_PREFIX = 'agentopsdeck:os-fence-rects:v1:';

export function computeDefaultFenceGeometries(
  surfaceWidth: number,
  surfaceHeight: number,
): Record<DesktopFenceId, DesktopFenceGeometry> {
  const usableW = Math.max(760, surfaceWidth - 48);
  const topY = 12;
  const usableH = Math.max(360, Math.min(620, surfaceHeight - 132));
  const gap = 14;
  const colW = Math.max(250, Math.min(460, Math.floor((usableW - gap * 2) / 3)));
  return {
    sessions: {
      x: 16,
      y: topY,
      width: colW,
      height: usableH,
      zIndex: 1,
    },
    knowledge: {
      x: 16 + colW + gap,
      y: topY,
      width: colW,
      height: usableH,
      zIndex: 2,
    },
    'tools-files': {
      x: 16 + (colW + gap) * 2,
      y: topY,
      width: colW,
      height: usableH,
      zIndex: 3,
    },
  };
}

export function readDesktopFenceRects(
  scope: string | undefined,
): Partial<Record<DesktopFenceId, DesktopFenceGeometry>> {
  if (!scope || typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`${FENCE_RECTS_STORAGE_PREFIX}${scope}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<DesktopFenceId, DesktopFenceGeometry>>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function writeDesktopFenceRects(
  scope: string | undefined,
  rects: Partial<Record<DesktopFenceId, DesktopFenceGeometry>>,
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${FENCE_RECTS_STORAGE_PREFIX}${scope}`, JSON.stringify(rects));
  } catch {
    // Ignore storage quota errors
  }
}

export function readDesktopFiles(scope: string | undefined): DesktopFileEntry[] {
  if (!scope || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${DESKTOP_FILES_STORAGE_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => {
        const rawAttachments = Array.isArray(item.attachments) ? item.attachments : [];
        const attachments: DesktopFileAttachment[] = rawAttachments
          .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
          .map((a) => ({
            id: String(a.id ?? `att-${Date.now()}`),
            name: String(a.name ?? 'image.png'),
            mimeType: String(a.mimeType ?? 'image/png'),
            dataUrl: String(a.dataUrl ?? ''),
            size: typeof a.size === 'number' ? a.size : undefined,
          }))
          .filter((a) => a.dataUrl.length > 0);
        const ft = item.fileType;
        const fileType: DesktopFileEntry['fileType'] =
          ft === 'markdown' || ft === 'text' || ft === 'json' || ft === 'image' || ft === 'mixed'
            ? ft
            : undefined;
        return {
          id: String(item.id ?? ''),
          name: String(item.name ?? 'Untitled.md'),
          content: String(item.content ?? ''),
          fileType,
          attachments: attachments.length > 0 ? attachments : undefined,
          path: typeof item.path === 'string' ? item.path : undefined,
          connectionId: typeof item.connectionId === 'string' ? item.connectionId : undefined,
          agentId: typeof item.agentId === 'string' ? item.agentId : undefined,
          updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
        };
      })
      .filter((item) => item.id.length > 0);
  } catch {
    return [];
  }
}

export function writeDesktopFiles(
  scope: string | undefined,
  files: readonly DesktopFileEntry[],
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${DESKTOP_FILES_STORAGE_PREFIX}${scope}`, JSON.stringify(files.slice(0, 64)));
  } catch {
    // Ignore storage quota errors
  }
}


const RECYCLE_BIN_STORAGE_PREFIX = 'agentopsdeck:os-recycle-bin:v1:';
const DESKTOP_BINDINGS_STORAGE_PREFIX = 'agentopsdeck:os-bindings:v1:';
const WECHAT_PINNED_SESSIONS_STORAGE_PREFIX = 'agentopsdeck:os-wechat-pinned:v1:';

export function readDesktopPinnedSessions(scope: string | undefined): string[] {
  if (!scope || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${WECHAT_PINNED_SESSIONS_STORAGE_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .slice(0, 64);
  } catch {
    return [];
  }
}

export function writeDesktopPinnedSessions(
  scope: string | undefined,
  keys: readonly string[],
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      `${WECHAT_PINNED_SESSIONS_STORAGE_PREFIX}${scope}`,
      JSON.stringify([...new Set(keys)].slice(0, 64)),
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function readDesktopRecycleBin(scope: string | undefined): DesktopRecycleItem[] {
  if (!scope || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${RECYCLE_BIN_STORAGE_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String(item.id ?? item.originalIconId ?? `rec-${Date.now()}`),
        originalIconId: String(item.originalIconId ?? item.id ?? ''),
        kind: (typeof item.kind === 'string' ? item.kind : 'desktop-file') as DesktopIconKind,
        title: String(item.title ?? 'Deleted Item'),
        subtitle: typeof item.subtitle === 'string' ? item.subtitle : undefined,
        resourceId: typeof item.resourceId === 'string' ? item.resourceId : undefined,
        sessionKey: typeof item.sessionKey === 'string' ? item.sessionKey : undefined,
        fileEntry:
          item.fileEntry && typeof item.fileEntry === 'object'
            ? (item.fileEntry as DesktopFileEntry)
            : item.fileSnapshot && typeof item.fileSnapshot === 'object'
              ? (item.fileSnapshot as DesktopFileEntry)
              : undefined,
        fileSnapshot:
          item.fileSnapshot && typeof item.fileSnapshot === 'object'
            ? (item.fileSnapshot as DesktopFileEntry)
            : item.fileEntry && typeof item.fileEntry === 'object'
              ? (item.fileEntry as DesktopFileEntry)
              : undefined,
        deletedAt: typeof item.deletedAt === 'number' && Number.isFinite(item.deletedAt) ? item.deletedAt : Date.now(),
      }))
      .filter((item) => item.originalIconId.length > 0);
  } catch {
    return [];
  }
}

export function writeDesktopRecycleBin(
  scope: string | undefined,
  items: readonly DesktopRecycleItem[],
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${RECYCLE_BIN_STORAGE_PREFIX}${scope}`, JSON.stringify(items.slice(0, 128)));
  } catch {
    // Ignore storage quota errors
  }
}

export function readDesktopBindings(scope: string | undefined): DesktopBindingLink[] {
  if (!scope || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${DESKTOP_BINDINGS_STORAGE_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String(item.id ?? `link-${Date.now()}`),
        fromId: String(item.fromId ?? item.sourceId ?? ''),
        toId: String(item.toId ?? item.targetId ?? ''),
        sourceId: String(item.sourceId ?? item.fromId ?? ''),
        targetId: String(item.targetId ?? item.toId ?? ''),
        label: typeof item.label === 'string' ? item.label : undefined,
        createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      }))
      .filter((item) => item.fromId.length > 0 && item.toId.length > 0 && item.fromId !== item.toId);
  } catch {
    return [];
  }
}

export function writeDesktopBindings(
  scope: string | undefined,
  links: readonly DesktopBindingLink[],
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${DESKTOP_BINDINGS_STORAGE_PREFIX}${scope}`, JSON.stringify(links.slice(0, 128)));
  } catch {
    // Ignore storage quota errors
  }
}


export type DesktopLineageKind =
  | 'manual'
  | 'notebook-binding'
  | 'taskboard-binding'
  | 'co-bound'
  | 'file-link'
  | 'moderator';

export type DesktopResolvedLineageEdge = {
  id: string;
  fromIconId: string;
  toIconId: string;
  kind: DesktopLineageKind;
  label: string;
  groupKey: string;
  removableManualId?: string | undefined;
};

/**
 * Unify all lineage & binding sources into deduplicated desktop icon/window edges:
 * - Manual desktop links (`desktopBindings`)
 * - Active Hub/Session Notebook file bindings (`notebookBindings`)
 * - Active Taskboard / Statuscard bindings (`taskboardBindings`)
 * - Co-bound panes & File Explorer links (`paneLinks`)
 * - Moderator Mode orchestration links (`moderatorConfig`)
 */
export function resolveDesktopLineageLinks(input: {
  desktopBindings?: readonly DesktopBindingLink[] | undefined;
  notebooks?: ReadonlyArray<{ id: string; title: string; hidden?: boolean }> | undefined;
  taskboards?: ReadonlyArray<{ resourceId: string; title: string }> | undefined;
  notebookBindings?: Readonly<Record<string, readonly string[]>> | undefined;
  taskboardBindings?: Readonly<Record<string, readonly string[]>> | undefined;
  paneLinks?: ReadonlyArray<{
    fromIconId: string;
    toIconId: string;
    label?: string | undefined;
    kind?: DesktopLineageKind | undefined;
  }> | undefined;
  moderatorConfig?: {
    moderatorSessionKey?: string | undefined;
    scoutSessionKey?: string | undefined;
    notebookId?: string | undefined;
    taskboardId?: string | undefined;
  } | undefined;
}): DesktopResolvedLineageEdge[] {
  const visibleNotebooks = [...(input.notebooks ?? [])];
  const firstNbId = visibleNotebooks[0]?.id;

  const resolveNotebookIconId = (nbId: string): string => {
    const clean = nbId.startsWith('hub:') ? nbId.slice(4) : nbId.startsWith('session:') ? nbId.slice(8) : nbId;
    if (!clean || clean === 'default' || (firstNbId && clean === firstNbId)) {
      return 'app:notebook';
    }
    if (visibleNotebooks.some((n) => n.id === clean)) {
      return visibleNotebooks[0]?.id === clean ? 'app:notebook' : `notebook:${clean}`;
    }
    return `notebook:${clean}`;
  };

  const taskboardList =
    input.taskboards && input.taskboards.length > 0
      ? input.taskboards
      : [{ resourceId: 'default', title: 'Task Board' }];

  const resolveTaskboardIconId = (tbId: string): string => {
    const clean = tbId || 'default';
    if (clean === 'default' && taskboardList[0]?.resourceId === 'default') {
      return 'app:taskboard';
    }
    const idx = taskboardList.findIndex((t) => t.resourceId === clean);
    if (idx === 0 && clean === 'default') return 'app:taskboard';
    return clean === 'default' ? 'app:taskboard' : `taskboard:${clean}`;
  };

  const byPair = new Map<string, DesktopResolvedLineageEdge>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

  const addEdge = (edge: DesktopResolvedLineageEdge) => {
    if (!edge.fromIconId || !edge.toIconId || edge.fromIconId === edge.toIconId) return;
    const k = pairKey(edge.fromIconId, edge.toIconId);
    const existing = byPair.get(k);
    if (!existing) {
      byPair.set(k, edge);
      return;
    }
    if (edge.removableManualId && !existing.removableManualId) {
      byPair.set(k, {
        ...existing,
        removableManualId: edge.removableManualId,
      });
    }
  };

  // 1. Notebook backend bindings (Notebook <-> Session)
  if (input.notebookBindings) {
    for (const [nbId, sessionKeys] of Object.entries(input.notebookBindings)) {
      if (!Array.isArray(sessionKeys) || sessionKeys.length === 0) continue;
      const nbIconId = resolveNotebookIconId(nbId);
      for (const sKey of sessionKeys) {
        if (!sKey) continue;
        const sessIconId = sKey.startsWith('session:') ? sKey : `session:${sKey}`;
        addEdge({
          id: `nb-bind:${nbIconId}->${sessIconId}`,
          fromIconId: nbIconId,
          toIconId: sessIconId,
          kind: 'notebook-binding',
          label: 'Notebook Binding',
          groupKey: nbIconId,
        });
      }
    }
  }

  // 2. Taskboard backend bindings (Taskboard <-> Session)
  if (input.taskboardBindings) {
    for (const [tbId, sessionKeys] of Object.entries(input.taskboardBindings)) {
      if (!Array.isArray(sessionKeys) || sessionKeys.length === 0) continue;
      const tbIconId = resolveTaskboardIconId(tbId);
      for (const sKey of sessionKeys) {
        if (!sKey) continue;
        const sessIconId = sKey.startsWith('session:') ? sKey : `session:${sKey}`;
        addEdge({
          id: `tb-bind:${tbIconId}->${sessIconId}`,
          fromIconId: tbIconId,
          toIconId: sessIconId,
          kind: 'taskboard-binding',
          label: 'Taskboard Binding',
          groupKey: tbIconId,
        });
      }
    }
  }

  // 3. Co-bound pane links & File Explorer links
  if (input.paneLinks) {
    for (const link of input.paneLinks) {
      const kind = link.kind ?? 'co-bound';
      addEdge({
        id: `pane-link:${link.fromIconId}->${link.toIconId}`,
        fromIconId: link.fromIconId,
        toIconId: link.toIconId,
        kind,
        label: link.label ?? (kind === 'file-link' ? 'File Link' : 'Co-bound Card'),
        groupKey: link.fromIconId,
      });
    }
  }

  // 4. Moderator Mode orchestration links
  const mod = input.moderatorConfig;
  if (mod && mod.moderatorSessionKey) {
    const modSessionIconId = mod.moderatorSessionKey.startsWith('session:')
      ? mod.moderatorSessionKey
      : `session:${mod.moderatorSessionKey}`;
    addEdge({
      id: `mod-hub:${modSessionIconId}`,
      fromIconId: 'app:moderator',
      toIconId: modSessionIconId,
      kind: 'moderator',
      label: 'Moderator Session',
      groupKey: 'app:moderator',
    });
    if (mod.notebookId) {
      const nbIconId = resolveNotebookIconId(mod.notebookId);
      addEdge({
        id: `mod-nb:${modSessionIconId}->${nbIconId}`,
        fromIconId: modSessionIconId,
        toIconId: nbIconId,
        kind: 'moderator',
        label: 'Moderator Notebook Sync',
        groupKey: 'app:moderator',
      });
    }
    if (mod.taskboardId) {
      const tbIconId = resolveTaskboardIconId(mod.taskboardId);
      addEdge({
        id: `mod-tb:${modSessionIconId}->${tbIconId}`,
        fromIconId: modSessionIconId,
        toIconId: tbIconId,
        kind: 'moderator',
        label: 'Moderator Taskboard Sync',
        groupKey: 'app:moderator',
      });
    }
    if (mod.scoutSessionKey && mod.scoutSessionKey !== mod.moderatorSessionKey) {
      const scoutIconId = mod.scoutSessionKey.startsWith('session:')
        ? mod.scoutSessionKey
        : `session:${mod.scoutSessionKey}`;
      addEdge({
        id: `mod-scout:${modSessionIconId}->${scoutIconId}`,
        fromIconId: modSessionIconId,
        toIconId: scoutIconId,
        kind: 'moderator',
        label: 'Moderator -> Scout Agent',
        groupKey: 'app:moderator',
      });
    }
  }

  // 5. Manual Desktop bindings
  for (const link of input.desktopBindings ?? []) {
    const fromIconId = link.fromId || link.sourceId || '';
    const toIconId = link.toId || link.targetId || '';
    addEdge({
      id: link.id || `manual:${fromIconId}->${toIconId}`,
      fromIconId,
      toIconId,
      kind: 'manual',
      label: link.label || 'Desktop Link',
      groupKey: fromIconId,
      removableManualId: link.id,
    });
  }

  return [...byPair.values()];
}

export function computeMarqueeSelection(
  start: { x: number; y: number },
  current: { x: number; y: number },
  itemRects: ReadonlyArray<{ id: string; x: number; y: number; width: number; height: number }>,
): {
  rect: { left: number; top: number; width: number; height: number };
  selectedIds: string[];
} {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const right = Math.max(start.x, current.x);
  const bottom = Math.max(start.y, current.y);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  const selectedIds: string[] = [];
  if (width >= 4 || height >= 4) {
    for (const item of itemRects) {
      const itemRight = item.x + item.width;
      const itemBottom = item.y + item.height;
      const intersects =
        item.x < right &&
        itemRight > left &&
        item.y < bottom &&
        itemBottom > top;
      if (intersects) {
        selectedIds.push(item.id);
      }
    }
  }
  return {
    rect: { left, top, width, height },
    selectedIds,
  };
}

export function writeDesktopMinimizedIds(
  scope: string | undefined,
  ids: readonly string[],
): void {
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${MINIMIZED_STORAGE_PREFIX}${scope}`, JSON.stringify([...new Set(ids)]));
  } catch {
    // Ignore storage quota errors
  }
}

/** Build the ordered desktop shortcuts (system apps + sessions + notebooks) for OS Desktop Mode. */
export function buildDesktopIcons(input: {
  sessions: readonly SessionSummary[];
  notebooks: ReadonlyArray<{ id: string; title: string; hidden?: boolean }>;
  taskboards?: ReadonlyArray<{ resourceId: string; title: string }> | undefined;
  desktopFiles?: readonly DesktopFileEntry[] | undefined;
  recycleBinCount?: number | undefined;
  recycledIconIds?: ReadonlySet<string> | undefined;
  completedSessionKeys?: ReadonlySet<string> | undefined;
  searchQuery?: string | undefined;
  sortBy?: DesktopSortBy | undefined;
  labels?: {
    fileExplorer?: string;
    sessionExplorer?: string;
    notebook?: string;
    newNotebook?: string;
    taskboard?: string;
    newTaskboard?: string;
    terminal?: string;
    tokenDashboard?: string;
    antigravityQuota?: string;
    gitRepoStatus?: string;
    whiteboard?: string;
    moderator?: string;
    docker?: string;
    subagents?: string;
    gitTree?: string;
    browser?: string;
    media?: string;
    statuscard?: string;
    systemSettings?: string;
    recycleBin?: string;
    wechatMessenger?: string;
  };
}): DesktopIconItem[] {
  const q = (input.searchQuery ?? '').trim().toLowerCase();
  const labels = input.labels ?? {};
  const visibleNotebooks = [...input.notebooks];

  const notebookIcons: DesktopIconItem[] =
    visibleNotebooks.length > 0
      ? visibleNotebooks.slice(0, 64).map((nb, idx) => {
          const cleanTitle = (nb.title || '').trim();
          const lower = cleanTitle.toLowerCase();
          const isMeeting =
            idx === 0 ||
            lower.includes('meet') ||
            lower.includes('会议') ||
            lower.includes('moderator') ||
            lower.includes('纪要');
          const fallbackTitle =
            idx === 0
              ? labels.notebook ?? 'Meeting Notes'
              : `${labels.notebook ?? 'Notebook'} #${idx + 1} (${nb.id.slice(0, 6)})`;
          return {
            id: idx === 0 ? 'app:notebook' : `notebook:${nb.id}`,
            kind: 'notebook' as const,
            title: cleanTitle || fallbackTitle,
            subtitle: isMeeting ? 'Meeting Note' : idx % 2 === 0 ? 'Session Note' : 'Doc Note',
            resourceId: nb.id,
            fenceId: 'knowledge' as const,
            variant: isMeeting ? ('meeting-note' as const) : ('session-note' as const),
          };
        })
      : [
          {
            id: 'app:notebook',
            kind: 'notebook',
            title: labels.notebook ?? 'Meeting Notes',
            subtitle: 'Markdown',
            resourceId: 'default',
            fenceId: 'knowledge',
            variant: 'meeting-note',
          },
        ];

  const newNotebookIcon: DesktopIconItem = {
    id: 'action:new-notebook',
    kind: 'notebook',
    title: labels.newNotebook ?? '+ New Notebook',
    subtitle: 'Create Note',
    fenceId: 'knowledge',
    variant: 'new-action',
  };

  const taskboardList = input.taskboards && input.taskboards.length > 0
    ? input.taskboards
    : [{ resourceId: 'default', title: labels.taskboard ?? 'Task Board' }];

  const taskboardIcons: DesktopIconItem[] = taskboardList.slice(0, 24).map((tb, idx) => ({
    id: idx === 0 && tb.resourceId === 'default' ? 'app:taskboard' : `taskboard:${tb.resourceId}`,
    kind: 'taskboard' as const,
    title: tb.title || (labels.taskboard ?? 'Task Board'),
    subtitle: idx % 2 === 0 ? 'Kanban' : 'Sprint Board',
    resourceId: tb.resourceId,
    fenceId: 'knowledge' as const,
    variant: idx % 2 === 0 ? ('kanban-board' as const) : ('sprint-board' as const),
  }));

  const newTaskboardIcon: DesktopIconItem = {
    id: 'action:new-taskboard',
    kind: 'taskboard',
    title: labels.newTaskboard ?? '+ New Taskboard',
    subtitle: 'Create Board',
    fenceId: 'knowledge',
    variant: 'new-action',
  };

  const systemApps: DesktopIconItem[] = [
    {
      id: 'app:file-browser',
      kind: 'file-browser',
      title: labels.fileExplorer ?? 'File Explorer',
      subtitle: 'Workspace',
      fenceId: 'tools-files',
    },
    {
      id: 'app:wechat-messenger',
      kind: 'wechat-messenger',
      title: labels.wechatMessenger ?? 'Chat Studio',
      subtitle: 'Split Chat Hub',
      fenceId: 'sessions',
      variant: 'wechat-messenger',
    },
    {
      id: 'app:session-explorer',
      kind: 'file-browser',
      title: labels.sessionExplorer ?? 'Session Explorer',
      subtitle: 'Sessions & Cards',
      fenceId: 'tools-files',
      variant: 'session-explorer',
    },
    ...notebookIcons,
    ...taskboardIcons,
    {
      id: 'app:statuscard',
      kind: 'statuscard',
      title: labels.statuscard ?? 'Session Status Board',
      subtitle: 'Live Matrix',
      resourceId: 'default',
      fenceId: 'knowledge',
      variant: 'status-card',
    },
    {
      id: 'app:terminal',
      kind: 'terminal',
      title: labels.terminal ?? 'Terminal',
      subtitle: 'Shell',
      fenceId: 'tools-files',
    },
    {
      id: 'app:docker',
      kind: 'docker',
      title: labels.docker ?? 'Docker & Sandboxes',
      subtitle: 'Containers & Codex',
      fenceId: 'tools-files',
    },
    {
      id: 'app:subagents',
      kind: 'subagents',
      title: labels.subagents ?? 'Sub-agent Companion',
      subtitle: 'Codex & GHCP',
      fenceId: 'tools-files',
    },
    {
      id: 'app:dashboard',
      kind: 'dashboard',
      title: labels.tokenDashboard ?? 'Token Telemetry',
      subtitle: 'Credits',
      fenceId: 'tools-files',
    },
    {
      id: 'app:antigravity-quota',
      kind: 'antigravity-quota',
      title: labels.antigravityQuota ?? 'Antigravity account quota',
      fenceId: 'tools-files',
    },
    {
      id: 'app:git-repo-status',
      kind: 'git-repo-status',
      title: labels.gitRepoStatus ?? 'Git repository status',
      fenceId: 'tools-files',
    },
    {
      id: 'app:drawing',
      kind: 'drawing',
      title: labels.whiteboard ?? 'Whiteboard',
      subtitle: 'Canvas',
      resourceId: 'default',
      fenceId: 'knowledge',
    },
    {
      id: 'app:moderator',
      kind: 'moderator',
      title: labels.moderator ?? 'Moderator Hub',
      subtitle: 'Live STT',
      fenceId: 'tools-files',
    },
    {
      id: 'app:git-tree',
      kind: 'git-tree',
      title: labels.gitTree ?? 'Git Graph',
      subtitle: 'Commits',
      fenceId: 'tools-files',
    },
    {
      id: 'app:browser',
      kind: 'browser',
      title: labels.browser ?? 'Web Preview',
      subtitle: 'Browser',
      fenceId: 'tools-files',
    },
    {
      id: 'app:system-settings',
      kind: 'system-settings',
      title: labels.systemSettings ?? 'System Settings',
      subtitle: 'Control Panel',
      fenceId: 'tools-files',
      variant: 'system-settings',
    },
    ...(typeof input.recycleBinCount === 'number'
      ? [
          {
            id: 'app:recycle-bin',
            kind: 'recycle-bin' as const,
            title: labels.recycleBin ?? 'Recycle Bin',
            subtitle: input.recycleBinCount > 0 ? `${input.recycleBinCount} item(s)` : 'Empty',
            badge: input.recycleBinCount > 0 ? String(input.recycleBinCount) : undefined,
            fenceId: 'tools-files' as const,
            variant: 'recycle-bin' as const,
          },
        ]
      : []),
  ];

  const desktopFileIcons: DesktopIconItem[] = (input.desktopFiles ?? []).slice(0, 32).map((file) => ({
    id: `file:${file.id}`,
    kind: 'desktop-file' as const,
    title: file.name || 'Untitled.txt',
    subtitle: file.attachments && file.attachments.length > 0
      ? `${file.attachments.length} attachment(s)`
      : file.path
        ? file.path
        : 'Desktop File',
    resourceId: file.id,
    fenceId: 'tools-files',
  }));

  const sessionIcons: DesktopIconItem[] = input.sessions.slice(0, 64).map((sess) => {
    const title = sessionDisplayTitle(sess);
    const runtime = sess.sessionRef?.runtimeId ?? sess.agentId ?? sess.source ?? 'agent';
    const running = sess.status === 'running' || Boolean(sess.hasActiveRun);
    const unread = Boolean(input.completedSessionKeys?.has(sess.sessionKey));
    return {
      id: `session:${sess.sessionKey}`,
      kind: 'session',
      title,
      subtitle: String(runtime),
      running,
      unread,
      session: sess,
      fenceId: 'sessions',
    };
  });

  const recycledSet = input.recycledIconIds;
  const visibleItems = [...systemApps, ...desktopFileIcons, ...sessionIcons].filter(
    (item) => item.id === 'app:recycle-bin' || !recycledSet?.has(item.id),
  );
  const all = sortDesktopIcons(visibleItems, input.sortBy ?? 'default');
  if (!q) return all;
  return all.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      (item.subtitle && item.subtitle.toLowerCase().includes(q)),
  );
}

export type DesktopFenceGroup = {
  id: DesktopFenceId;
  titleKey: 'AI Agent Sessions' | 'Notebooks & Taskboards' | 'System Tools & Desktop Files';
  items: DesktopIconItem[];
};

/** Group desktop shortcuts into Stardock Fences-style desktop zones. */
export function groupDesktopIconsIntoFences(
  icons: readonly DesktopIconItem[],
): DesktopFenceGroup[] {
  const sessions: DesktopIconItem[] = [];
  const knowledge: DesktopIconItem[] = [];
  const toolsFiles: DesktopIconItem[] = [];

  for (const item of icons) {
    const fence =
      item.fenceId ??
      (item.kind === 'session' || item.kind === 'wechat-messenger'
        ? 'sessions'
        : item.kind === 'notebook' ||
            item.kind === 'taskboard' ||
            item.kind === 'statuscard' ||
            item.kind === 'drawing'
          ? 'knowledge'
          : 'tools-files');
    if (fence === 'sessions') sessions.push(item);
    else if (fence === 'knowledge') knowledge.push(item);
    else toolsFiles.push(item);
  }

  return [
    { id: 'sessions', titleKey: 'AI Agent Sessions', items: sessions },
    { id: 'knowledge', titleKey: 'Notebooks & Taskboards', items: knowledge },
    { id: 'tools-files', titleKey: 'System Tools & Desktop Files', items: toolsFiles },
  ];
}

/** Sort desktop icons by user-selected order. */
export function sortDesktopIcons(
  items: readonly DesktopIconItem[],
  sortBy: DesktopSortBy,
): DesktopIconItem[] {
  const copy = [...items];
  if (sortBy === 'default') return copy;
  if (sortBy === 'name') {
    return copy.sort((a, b) => a.title.localeCompare(b.title));
  }
  if (sortBy === 'status') {
    return copy.sort((a, b) => {
      const rank = (item: DesktopIconItem) => (item.running ? 0 : item.unread ? 1 : item.kind !== 'session' ? 2 : 3);
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.title.localeCompare(b.title);
    });
  }
  if (sortBy === 'kind') {
    return copy.sort((a, b) => {
      const isAppA = a.kind !== 'session' ? 0 : 1;
      const isAppB = b.kind !== 'session' ? 0 : 1;
      if (isAppA !== isAppB) return isAppA - isAppB;
      const kindDiff = a.kind.localeCompare(b.kind);
      return kindDiff !== 0 ? kindDiff : a.title.localeCompare(b.title);
    });
  }
  return copy;
}

/** Promote a window ID to the top of the z-order stack. Preserves array reference when already top-most. */
export function promoteWindowZOrder(stack: readonly string[], id: string): string[] {
  if (stack.length > 0 && stack[stack.length - 1] === id) {
    return stack as string[];
  }
  return [...stack.filter((entry) => entry !== id), id];
}

export type DesktopWindowContentMountDecision = {
  shouldMountContent: boolean;
  isHiddenMinimized: boolean;
  shouldSuspendBackgroundActivity: boolean;
};

/**
 * Determine whether an OS Desktop window should mount its heavy pane content,
 * stay hidden while preserving DOM/scroll state, or suspend background work.
 * - Never-opened minimized windows defer mounting until first restore.
 * - Previously mounted windows that get minimized stay mounted with hidden + content-visibility: hidden
 *   so restoring from taskbar is 0ms and preserves scroll/draft state.
 */
export function evaluateWindowContentMount(input: {
  isMinimized: boolean;
  hasMountedOnce: boolean;
  isActive: boolean;
  running: boolean;
}): DesktopWindowContentMountDecision {
  if (input.isMinimized && !input.hasMountedOnce) {
    return {
      shouldMountContent: false,
      isHiddenMinimized: true,
      shouldSuspendBackgroundActivity: !input.running,
    };
  }
  return {
    shouldMountContent: true,
    isHiddenMinimized: input.isMinimized,
    shouldSuspendBackgroundActivity: input.isMinimized && !input.running && !input.isActive,
  };
}

/** Compute cascaded default window positions so newly opened OS windows stack cleanly. */
export function computeCascadeWindowGeometry(
  index: number,
  surfaceWidth: number,
  surfaceHeight: number,
): DesktopWindowGeometry {
  const safeW = Math.max(640, surfaceWidth);
  const safeH = Math.max(460, surfaceHeight - 48);
  const width = Math.min(Math.round(safeW * 0.62), 880);
  const height = Math.min(Math.round(safeH * 0.78), 660);
  const step = (index % 7) * 30;
  const x = Math.max(24, Math.min(safeW - width - 24, 156 + step));
  const y = Math.max(44, Math.min(safeH - height - 16, 48 + step));
  return { x, y, width, height };
}

/** Compute compact right-side floating companion window geometry on OS Desktop. */
export function computeCompanionWindowGeometry(
  surfaceWidth: number,
  surfaceHeight: number,
): DesktopWindowGeometry {
  const safeW = Math.max(640, surfaceWidth);
  const safeH = Math.max(460, surfaceHeight - 48);
  const width = Math.max(340, Math.min(Math.round(safeW * 0.34), 480));
  const height = Math.max(380, Math.min(Math.round(safeH * 0.78), 680));
  const x = Math.max(24, safeW - width - 24);
  const y = Math.max(44, Math.min(safeH - height - 16, 52));
  return { x, y, width, height };
}

/**
 * Compute a smart non-overlapping tile grid for visible desktop windows.
 * Respects the left-side desktop icon column when `showDesktopIcons` is enabled.
 * - 1 window: comfortable centered/expanded workspace frame
 * - 2 windows: side-by-side 50/50 split
 * - 3 windows: primary left 52% + two stacked right 48%
 * - 4+ windows: balanced multi-column grid
 */
export function computeSmartTileGeometries(
  windowIds: readonly string[],
  surfaceWidth: number,
  surfaceHeight: number,
  showDesktopIcons = true,
): Record<string, DesktopWindowGeometry> {
  const result: Record<string, DesktopWindowGeometry> = {};
  const count = windowIds.length;
  if (count === 0) return result;

  const leftPad = showDesktopIcons ? 112 : 14;
  const rightPad = 14;
  const topOffset = 46;
  const bottomReserved = 52;
  const gap = 8;

  const availW = Math.max(520, surfaceWidth - leftPad - rightPad);
  const availH = Math.max(340, surfaceHeight - topOffset - bottomReserved);

  if (count === 1) {
    const id = windowIds[0]!;
    result[id] = {
      x: leftPad,
      y: topOffset,
      width: availW,
      height: availH,
    };
    return result;
  }

  if (count === 2) {
    const halfW = Math.floor((availW - gap) / 2);
    result[windowIds[0]!] = {
      x: leftPad,
      y: topOffset,
      width: halfW,
      height: availH,
    };
    result[windowIds[1]!] = {
      x: leftPad + halfW + gap,
      y: topOffset,
      width: availW - halfW - gap,
      height: availH,
    };
    return result;
  }

  if (count === 3) {
    const leftW = Math.floor((availW - gap) * 0.52);
    const rightW = availW - leftW - gap;
    const halfH = Math.floor((availH - gap) / 2);
    result[windowIds[0]!] = {
      x: leftPad,
      y: topOffset,
      width: leftW,
      height: availH,
    };
    result[windowIds[1]!] = {
      x: leftPad + leftW + gap,
      y: topOffset,
      width: rightW,
      height: halfH,
    };
    result[windowIds[2]!] = {
      x: leftPad + leftW + gap,
      y: topOffset + halfH + gap,
      width: rightW,
      height: availH - halfH - gap,
    };
    return result;
  }

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = Math.floor((availW - gap * (cols - 1)) / cols);
  const cellH = Math.floor((availH - gap * (rows - 1)) / rows);

  windowIds.forEach((id, index) => {
    const c = index % cols;
    const r = Math.floor(index / cols);
    result[id] = {
      x: leftPad + c * (cellW + gap),
      y: topOffset + r * (cellH + gap),
      width: Math.max(300, cellW),
      height: Math.max(220, cellH),
    };
  });

  return result;
}

/** Detect Aero Snap Zone from pointer coordinates during titlebar drag. */
export function detectWindowSnapZone(
  clientX: number,
  clientY: number,
  surfaceWidth: number,
  surfaceHeight: number,
): DesktopSnapZone | undefined {
  const edgeThreshold = 20;
  const cornerThreshold = 72;
  const topThreshold = 46;
  const bottomThreshold = Math.max(200, surfaceHeight - 62);

  const nearLeft = clientX <= edgeThreshold;
  const nearRight = clientX >= surfaceWidth - edgeThreshold;
  const nearTopCorner = clientY <= topThreshold + cornerThreshold;
  const nearBottomCorner = clientY >= bottomThreshold - cornerThreshold;

  if (nearLeft && nearTopCorner) return 'top-left';
  if (nearRight && nearTopCorner) return 'top-right';
  if (nearLeft && nearBottomCorner) return 'bottom-left';
  if (nearRight && nearBottomCorner) return 'bottom-right';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  if (clientY <= topThreshold) return 'maximize';
  return undefined;
}

/** Compute Windows 11 / Aero style snap geometry (halves, quadrants, or full desktop). */
export function computeSnapWindowGeometry(
  zone: DesktopSnapZone,
  surfaceWidth: number,
  surfaceHeight: number,
  restoreRect?: { x: number; y: number; width: number; height: number },
): DesktopWindowGeometry {
  const safeW = Math.max(640, surfaceWidth);
  const safeH = Math.max(420, surfaceHeight - 54);
  const topOffset = 44;
  const availH = Math.max(300, safeH - topOffset);
  const halfW = Math.floor((safeW - 30) / 2);
  const halfH = Math.floor((availH - 8) / 2);

  switch (zone) {
    case 'left':
      return {
        x: 12,
        y: topOffset,
        width: halfW,
        height: availH,
        snapped: 'left',
        restoreRect,
      };
    case 'right':
      return {
        x: 18 + halfW,
        y: topOffset,
        width: halfW,
        height: availH,
        snapped: 'right',
        restoreRect,
      };
    case 'top-left':
      return {
        x: 12,
        y: topOffset,
        width: halfW,
        height: halfH,
        snapped: 'top-left',
        restoreRect,
      };
    case 'top-right':
      return {
        x: 18 + halfW,
        y: topOffset,
        width: halfW,
        height: halfH,
        snapped: 'top-right',
        restoreRect,
      };
    case 'bottom-left':
      return {
        x: 12,
        y: topOffset + halfH + 8,
        width: halfW,
        height: halfH,
        snapped: 'bottom-left',
        restoreRect,
      };
    case 'bottom-right':
      return {
        x: 18 + halfW,
        y: topOffset + halfH + 8,
        width: halfW,
        height: halfH,
        snapped: 'bottom-right',
        restoreRect,
      };
    case 'maximize':
    default:
      return {
        x: 12,
        y: topOffset,
        width: safeW - 24,
        height: availH,
        maximized: true,
        snapped: 'maximize',
        restoreRect,
      };
  }
}

/** Compute 8-direction window resize geometry with minimum & viewport bounds. */
export function resizeDesktopWindowGeometry(
  orig: DesktopWindowGeometry,
  edge: DesktopResizeEdge,
  dx: number,
  dy: number,
  surfaceWidth: number,
  surfaceHeight: number,
  minSize?: { minW?: number | undefined; minH?: number | undefined },
): DesktopWindowGeometry {
  const minW = minSize?.minW ?? 340;
  const minH = minSize?.minH ?? 240;
  const minY = 6;
  const maxBottom = Math.max(320, surfaceHeight - 50);

  let { x, y, width, height } = orig;

  if (edge.includes('e')) {
    width = Math.max(minW, Math.min(surfaceWidth - x - 8, orig.width + dx));
  }
  if (edge.includes('s')) {
    height = Math.max(minH, Math.min(maxBottom - y, orig.height + dy));
  }
  if (edge.includes('w')) {
    const maxLeftDelta = orig.width - minW;
    const clampedDx = Math.max(-(orig.x - 8), Math.min(maxLeftDelta, dx));
    x = orig.x + clampedDx;
    width = orig.width - clampedDx;
  }
  if (edge.includes('n')) {
    const maxTopDelta = orig.height - minH;
    const clampedDy = Math.max(-(orig.y - minY), Math.min(maxTopDelta, dy));
    y = orig.y + clampedDy;
    height = orig.height - clampedDy;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export type DesktopTaskbarMetrics = {
  taskbarHeight: number;
  scale: number;
  iconSize: number;
  startIconSize: number;
  closeIconSize: number;
  buttonHeight: number;
  fontSizePx: number;
  badgeFontSizePx: number;
  pillMaxWidthPx: number;
};

/**
 * Compute proportional taskbar button, icon, font, and pill dimensions
 * when the user drags the taskbar height between 38px and 96px.
 */
export function computeTaskbarMetrics(rawHeight?: number | undefined): DesktopTaskbarMetrics {
  const clamped =
    typeof rawHeight === 'number' && Number.isFinite(rawHeight)
      ? Math.max(38, Math.min(96, Math.round(rawHeight)))
      : 48;
  const scale = Number(Math.max(0.82, Math.min(1.85, clamped / 48)).toFixed(3));
  const iconSize = Math.max(12, Math.min(28, Math.round(14 * scale)));
  const startIconSize = Math.max(13, Math.min(30, Math.round(15 * scale)));
  const closeIconSize = Math.max(10, Math.min(20, Math.round(11 * scale)));
  const buttonHeight = Math.max(26, Math.min(76, Math.round(clamped - 14)));
  const fontSizePx = Number(Math.max(11, Math.min(16.5, 11.5 * Math.pow(scale, 0.65))).toFixed(1));
  const badgeFontSizePx = Number(Math.max(9.5, Math.min(14, 10 * Math.pow(scale, 0.6))).toFixed(1));
  const pillMaxWidthPx = Math.round(196 * Math.max(1, Math.min(1.45, Math.pow(scale, 0.55))));

  return {
    taskbarHeight: clamped,
    scale,
    iconSize,
    startIconSize,
    closeIconSize,
    buttonHeight,
    fontSizePx,
    badgeFontSizePx,
    pillMaxWidthPx,
  };
}

export type DesktopNotificationKind =
  | 'session-completed'
  | 'desktop-refreshed'
  | 'system-info';

export type DesktopNotificationItem = {
  id: string;
  kind: DesktopNotificationKind;
  title: string;
  body: string;
  sessionKey?: string | undefined;
  createdAt: number;
  read?: boolean | undefined;
};

const DESKTOP_NOTIFICATIONS_KEY_PREFIX = 'agentopsdeck.desktop.notifications.v1:';

export function readDesktopNotifications(scope = 'default'): DesktopNotificationItem[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(`${DESKTOP_NOTIFICATIONS_KEY_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is DesktopNotificationItem =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.title === 'string' &&
          typeof item.body === 'string' &&
          typeof item.createdAt === 'number',
      )
      .slice(0, 50);
  } catch {
    return [];
  }
}

export function writeDesktopNotifications(
  scope = 'default',
  items: readonly DesktopNotificationItem[],
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      `${DESKTOP_NOTIFICATIONS_KEY_PREFIX}${scope}`,
      JSON.stringify(items.slice(0, 50)),
    );
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Detect newly completed sessions between two snapshots of running/completed session state.
 */
export function detectNewlyCompletedSessions(params: {
  sessions: readonly SessionSummary[];
  prevRunningKeys: ReadonlySet<string>;
  prevCompletedKeys: ReadonlySet<string>;
  nextCompletedKeys: ReadonlySet<string>;
}): SessionSummary[] {
  const { sessions, prevRunningKeys, prevCompletedKeys, nextCompletedKeys } = params;
  const byKey = new Map(sessions.map((s) => [s.sessionKey, s]));
  const completedList: SessionSummary[] = [];
  const seen = new Set<string>();

  // 1. Any session added to completedSessionKeys that wasn't there before
  for (const key of nextCompletedKeys) {
    if (!prevCompletedKeys.has(key)) {
      const found = byKey.get(key);
      if (found && !seen.has(key)) {
        seen.add(key);
        completedList.push(found);
      }
    }
  }

  // 2. Any session that was actively running in prevRunningKeys and is now idle/completed
  for (const key of prevRunningKeys) {
    if (seen.has(key)) continue;
    const found = byKey.get(key);
    if (!found) continue;
    const stillRunning = found.status === 'running' || Boolean(found.hasActiveRun);
    const isError =
      found.runtime?.sync === 'error' || found.runtime?.connection === 'disconnected';
    if (!stillRunning && !isError && !prevCompletedKeys.has(key)) {
      seen.add(key);
      completedList.push(found);
    }
  }

  return completedList;
}


export type DesktopRgbColor = {
  r: number;
  g: number;
  b: number;
};

export type DesktopWallpaperImageGrid = {
  width: number;
  height: number;
  /** Flat RGB array of length width * height * 3 */
  data: readonly number[];
};

export type DesktopPointTextStyle = {
  tone: 'light-bg' | 'dark-bg';
  luminance: number;
  contrastRatio: number;
  sampledBg: DesktopRgbColor;
  textColor: string;
  subColor: string;
  textShadow: string;
  pillBg: string;
};

function clampChannel(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function lerpRgb(a: DesktopRgbColor, b: DesktopRgbColor, t: number): DesktopRgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    r: clampChannel(a.r + (b.r - a.r) * clamped),
    g: clampChannel(a.g + (b.g - a.g) * clamped),
    b: clampChannel(a.b + (b.b - a.b) * clamped),
  };
}

function blendRgbaOver(
  base: DesktopRgbColor,
  overlay: DesktopRgbColor,
  alpha: number,
): DesktopRgbColor {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    r: clampChannel(base.r * (1 - a) + overlay.r * a),
    g: clampChannel(base.g * (1 - a) + overlay.g * a),
    b: clampChannel(base.b * (1 - a) + overlay.b * a),
  };
}

function parseHexOrRgbToken(token: string): DesktopRgbColor | null {
  const clean = token.trim().toLowerCase();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(clean);
  if (hexMatch) {
    const h = hexMatch[1]!;
    if (h.length === 3) {
      return {
        r: parseInt(h[0]! + h[0]!, 16),
        g: parseInt(h[1]! + h[1]!, 16),
        b: parseInt(h[2]! + h[2]!, 16),
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(clean);
  if (rgbMatch) {
    return {
      r: clampChannel(Number(rgbMatch[1])),
      g: clampChannel(Number(rgbMatch[2])),
      b: clampChannel(Number(rgbMatch[3])),
    };
  }
  return null;
}

function extractGradientColorStops(cssGradient: string): DesktopRgbColor[] {
  const matches = cssGradient.match(/#[0-9a-fA-F]{3,6}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[0-9.]+)?\s*\)/g);
  if (!matches || matches.length === 0) return [];
  const stops: DesktopRgbColor[] = [];
  for (const m of matches) {
    const parsed = parseHexOrRgbToken(m);
    if (parsed) stops.push(parsed);
  }
  return stops;
}

export function computeRelativeLuminance(rgb: DesktopRgbColor): number {
  const toLinear = (c: number): number => {
    const s = Math.max(0, Math.min(255, c)) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const R = toLinear(rgb.r);
  const G = toLinear(rgb.g);
  const B = toLinear(rgb.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function computeWcagContrastRatio(lumA: number, lumB: number): number {
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Sample the effective desktop background RGB color at a given (x, y) coordinate.
 * Accounts for theme gradients, radial glow hotspots, custom CSS gradients, sampled custom wallpaper pixels,
 * dimming overlays, and Fence container translucency.
 */
export function sampleDesktopBackgroundRgbAtPoint(params: {
  x: number;
  y: number;
  surfaceWidth: number;
  surfaceHeight: number;
  wallpaper: DesktopWallpaperTheme;
  wallpaperConfig?: DesktopWallpaperConfig | undefined;
  colorMode: WorkspaceColorMode;
  surfaceContext?: 'desktop' | 'fence' | 'fence-header' | undefined;
  imageGrid?: DesktopWallpaperImageGrid | null | undefined;
}): DesktopRgbColor {
  const w = Math.max(1, params.surfaceWidth || 1280);
  const h = Math.max(1, params.surfaceHeight || 800);
  const u = Math.max(0, Math.min(1, params.x / w));
  const v = Math.max(0, Math.min(1, params.y / h));
  const diag = Math.max(0, Math.min(1, (u * 0.58 + v * 0.42)));

  let base: DesktopRgbColor;

  if (params.colorMode === 'light' && params.wallpaper === 'aurora') {
    // Light mode desktop gradient: #e2e8f0 -> #f1f5f9 -> #dbeafe with sky/indigo radial glows
    const c0 = { r: 226, g: 232, b: 240 };
    const c1 = { r: 241, g: 245, b: 249 };
    const c2 = { r: 219, g: 234, b: 254 };
    base = diag < 0.52 ? lerpRgb(c0, c1, diag / 0.52) : lerpRgb(c1, c2, (diag - 0.52) / 0.48);
    const d1 = Math.hypot(u - 0.18, v - 0.2);
    if (d1 < 0.46) {
      base = blendRgbaOver(base, { r: 56, g: 189, b: 248 }, (1 - d1 / 0.46) * 0.22);
    }
    const d2 = Math.hypot(u - 0.82, v - 0.76);
    if (d2 < 0.48) {
      base = blendRgbaOver(base, { r: 99, g: 102, b: 241 }, (1 - d2 / 0.48) * 0.16);
    }
  } else if (params.wallpaper === 'custom' && params.wallpaperConfig) {
    const cfg = params.wallpaperConfig;
    if (cfg.customImageUrl && params.imageGrid && params.imageGrid.width > 0 && params.imageGrid.height > 0) {
      const gx = Math.min(
        params.imageGrid.width - 1,
        Math.max(0, Math.floor(u * params.imageGrid.width)),
      );
      const gy = Math.min(
        params.imageGrid.height - 1,
        Math.max(0, Math.floor(v * params.imageGrid.height)),
      );
      const idx = (gy * params.imageGrid.width + gx) * 3;
      base = {
        r: clampChannel(params.imageGrid.data[idx] ?? 15),
        g: clampChannel(params.imageGrid.data[idx + 1] ?? 23),
        b: clampChannel(params.imageGrid.data[idx + 2] ?? 42),
      };
    } else if (cfg.customGradient) {
      const stops = extractGradientColorStops(cfg.customGradient);
      if (stops.length === 1) {
        base = stops[0]!;
      } else if (stops.length >= 2) {
        const scaled = diag * (stops.length - 1);
        const seg = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
        const localT = scaled - seg;
        base = lerpRgb(stops[seg]!, stops[seg + 1]!, localT);
      } else {
        base = params.colorMode === 'light' ? { r: 235, g: 241, b: 248 } : { r: 18, g: 28, b: 48 };
      }
    } else {
      base = params.colorMode === 'light' ? { r: 235, g: 241, b: 248 } : { r: 18, g: 28, b: 48 };
    }
    const dim = Math.max(0, Math.min(0.85, cfg.dimOpacity ?? 0.22));
    if (dim > 0) {
      base = blendRgbaOver(base, { r: 2, g: 6, b: 23 }, dim);
    }
  } else {
    switch (params.wallpaper) {
      case 'midnight': {
        const d = Math.min(1, Math.hypot(u - 0.2, v - 0.2) / 0.95);
        base = lerpRgb({ r: 15, g: 23, b: 42 }, { r: 2, g: 6, b: 23 }, d);
        break;
      }
      case 'cybergrid': {
        const d = Math.min(1, Math.hypot(u - 0.5, v - 0.1) / 0.95);
        base = lerpRgb({ r: 30, g: 27, b: 75 }, { r: 9, g: 13, b: 22 }, d);
        base = blendRgbaOver(base, { r: 14, g: 165, b: 233 }, 0.06);
        break;
      }
      case 'graphite': {
        const d = Math.min(1, Math.hypot(u - 0.3, v - 0.25) / 0.95);
        base =
          d < 0.55
            ? lerpRgb({ r: 51, g: 65, b: 85 }, { r: 30, g: 41, b: 59 }, d / 0.55)
            : lerpRgb({ r: 30, g: 41, b: 59 }, { r: 15, g: 23, b: 42 }, (d - 0.55) / 0.45);
        break;
      }
      case 'sunset': {
        const c0 = { r: 30, g: 27, b: 75 };
        const c1 = { r: 49, g: 16, b: 47 };
        const c2 = { r: 15, g: 23, b: 42 };
        base = diag < 0.48 ? lerpRgb(c0, c1, diag / 0.48) : lerpRgb(c1, c2, (diag - 0.48) / 0.52);
        const d1 = Math.hypot(u - 0.18, v - 0.18);
        if (d1 < 0.5) {
          base = blendRgbaOver(base, { r: 244, g: 63, b: 94 }, (1 - d1 / 0.5) * 0.26);
        }
        const d2 = Math.hypot(u - 0.82, v - 0.28);
        if (d2 < 0.52) {
          base = blendRgbaOver(base, { r: 245, g: 158, b: 11 }, (1 - d2 / 0.52) * 0.22);
        }
        break;
      }
      case 'oceanic': {
        const c0 = { r: 4, g: 19, b: 34 };
        const c1 = { r: 8, g: 32, b: 56 };
        const c2 = { r: 9, g: 21, b: 38 };
        base = diag < 0.52 ? lerpRgb(c0, c1, diag / 0.52) : lerpRgb(c1, c2, (diag - 0.52) / 0.48);
        const d1 = Math.hypot(u - 0.2, v - 0.22);
        if (d1 < 0.52) {
          base = blendRgbaOver(base, { r: 6, g: 182, b: 212 }, (1 - d1 / 0.52) * 0.28);
        }
        const d2 = Math.hypot(u - 0.78, v - 0.72);
        if (d2 < 0.55) {
          base = blendRgbaOver(base, { r: 59, g: 130, b: 246 }, (1 - d2 / 0.55) * 0.24);
        }
        break;
      }
      case 'sakura': {
        const c0 = { r: 27, g: 13, b: 36 };
        const c1 = { r: 42, g: 18, b: 48 };
        const c2 = { r: 18, g: 19, b: 36 };
        base = diag < 0.5 ? lerpRgb(c0, c1, diag / 0.5) : lerpRgb(c1, c2, (diag - 0.5) / 0.5);
        const d1 = Math.hypot(u - 0.24, v - 0.2);
        if (d1 < 0.52) {
          base = blendRgbaOver(base, { r: 244, g: 114, b: 182 }, (1 - d1 / 0.52) * 0.28);
        }
        const d2 = Math.hypot(u - 0.8, v - 0.7);
        if (d2 < 0.54) {
          base = blendRgbaOver(base, { r: 168, g: 85, b: 247 }, (1 - d2 / 0.54) * 0.25);
        }
        break;
      }
      case 'aurora':
      default: {
        const c0 = { r: 15, g: 23, b: 42 };
        const c1 = { r: 30, g: 41, b: 59 };
        const c2 = { r: 15, g: 23, b: 42 };
        base = diag < 0.52 ? lerpRgb(c0, c1, diag / 0.52) : lerpRgb(c1, c2, (diag - 0.52) / 0.48);
        const d1 = Math.hypot(u - 0.18, v - 0.22);
        if (d1 < 0.46) {
          base = blendRgbaOver(base, { r: 56, g: 189, b: 248 }, (1 - d1 / 0.46) * 0.18);
        }
        const d2 = Math.hypot(u - 0.82, v - 0.76);
        if (d2 < 0.48) {
          base = blendRgbaOver(base, { r: 99, g: 102, b: 241 }, (1 - d2 / 0.48) * 0.16);
        }
        break;
      }
    }
  }

  // Blend Fence surface translucency if the text sits inside a Fence or Fence header
  if (params.surfaceContext === 'fence') {
    base =
      params.colorMode === 'light'
        ? blendRgbaOver(base, { r: 255, g: 255, b: 255 }, 0.74)
        : blendRgbaOver(base, { r: 15, g: 23, b: 42 }, 0.46);
  } else if (params.surfaceContext === 'fence-header') {
    base =
      params.colorMode === 'light'
        ? blendRgbaOver(base, { r: 241, g: 245, b: 249 }, 0.9)
        : blendRgbaOver(base, { r: 15, g: 23, b: 42 }, 0.62);
  }

  return base;
}

/**
 * Compute the optimal contrasting foreground text color, secondary subtitle color, and text-shadow
 * for a given (x, y) coordinate on the desktop based on the background color underneath that point.
 */
export function computeDesktopPointTextStyle(params: {
  x: number;
  y: number;
  surfaceWidth: number;
  surfaceHeight: number;
  wallpaper: DesktopWallpaperTheme;
  wallpaperConfig?: DesktopWallpaperConfig | undefined;
  colorMode: WorkspaceColorMode;
  surfaceContext?: 'desktop' | 'fence' | 'fence-header' | undefined;
  imageGrid?: DesktopWallpaperImageGrid | null | undefined;
}): DesktopPointTextStyle {
  const sampledBg = sampleDesktopBackgroundRgbAtPoint(params);
  const luminance = computeRelativeLuminance(sampledBg);

  const darkAnchor: DesktopRgbColor = { r: 11, g: 18, b: 32 }; // #0b1220
  const lightAnchor: DesktopRgbColor = { r: 248, g: 250, b: 252 }; // #f8fafc

  const darkLum = computeRelativeLuminance(darkAnchor);
  const lightLum = computeRelativeLuminance(lightAnchor);

  const contrastWithDark = computeWcagContrastRatio(luminance, darkLum);
  const contrastWithLight = computeWcagContrastRatio(luminance, lightLum);

  // Pick dark text only on genuinely bright backgrounds (>= 0.52 luminance);
  // any dark or darkish background uses crisp white text with zero text-shadow.
  const useDarkText = luminance >= 0.52;
  const tone: 'light-bg' | 'dark-bg' = useDarkText ? 'light-bg' : 'dark-bg';
  const contrastRatio = useDarkText ? contrastWithDark : contrastWithLight;

  const textColor = useDarkText ? '#0f172a' : '#ffffff';
  const subColor = useDarkText ? '#334155' : '#e2e8f0';
  const textShadow = 'none';
  const pillBg = 'transparent';

  return {
    tone,
    luminance,
    contrastRatio,
    sampledBg,
    textColor,
    subColor,
    textShadow,
    pillBg,
  };
}


export interface ResolvedDesktopIconSlot {
  id: string;
  x: number;
  y: number;
  col: number;
  row: number;
  isCustom: boolean;
}

/**
 * Deterministic non-overlapping desktop icon layout resolver.
 * Ensures that static icons and custom dragged icons never collide or stack on top of each other
 * in either non-Fences mode or Fences coexisting mode.
 */
export function resolveNonOverlappingIconLayout(params: {
  icons: ReadonlyArray<{ id: string }>;
  iconPositions: Readonly<Record<string, { x: number; y: number }>>;
  surfaceWidth: number;
  surfaceHeight: number;
  taskbarHeight?: number | undefined;
  cellWidth?: number | undefined;
  cellHeight?: number | undefined;
  marginLeft?: number | undefined;
  marginTop?: number | undefined;
}): Record<string, ResolvedDesktopIconSlot> {
  const cellWidth = Math.max(76, params.cellWidth ?? 98);
  const cellHeight = Math.max(78, params.cellHeight ?? 102);
  const marginLeft = params.marginLeft ?? 12;
  const marginTop = params.marginTop ?? 10;
  const taskbarHeight = params.taskbarHeight ?? 48;
  const usableWidth = Math.max(cellWidth * 2, params.surfaceWidth - marginLeft * 2);
  const usableHeight = Math.max(cellHeight * 2, params.surfaceHeight - taskbarHeight - marginTop - 16);
  const rowsPerCol = Math.max(1, Math.floor(usableHeight / cellHeight));
  const maxCols = Math.max(2, Math.floor(usableWidth / cellWidth));

  const result: Record<string, ResolvedDesktopIconSlot> = {};
  const occupiedBoxes: Array<{ id: string; x: number; y: number }> = [];
  const minDx = Math.round(cellWidth * 0.78);
  const minDy = Math.round(cellHeight * 0.78);

  const collides = (x: number, y: number): boolean =>
    occupiedBoxes.some((box) => Math.abs(box.x - x) < minDx && Math.abs(box.y - y) < minDy);

  // Pass 1: Place icons that have user-dragged custom positions, resolving any direct overlap
  for (const item of params.icons) {
    const raw = params.iconPositions[item.id];
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) continue;
    let x = Math.max(6, Math.min(Math.max(6, params.surfaceWidth - cellWidth), Math.round(raw.x)));
    let y = Math.max(6, Math.min(Math.max(6, params.surfaceHeight - taskbarHeight - cellHeight + 8), Math.round(raw.y)));
    if (collides(x, y)) {
      // Spiral search for the nearest non-overlapping slot
      let found = false;
      for (let radius = 1; radius <= maxCols + rowsPerCol && !found; radius += 1) {
        for (let dc = -radius; dc <= radius && !found; dc += 1) {
          for (let dr = -radius; dr <= radius && !found; dr += 1) {
            if (Math.abs(dc) !== radius && Math.abs(dr) !== radius) continue;
            const candX = Math.max(6, Math.min(Math.max(6, params.surfaceWidth - cellWidth), x + dc * cellWidth));
            const candY = Math.max(6, Math.min(Math.max(6, params.surfaceHeight - taskbarHeight - cellHeight + 8), y + dr * cellHeight));
            if (!collides(candX, candY)) {
              x = candX;
              y = candY;
              found = true;
            }
          }
        }
      }
    }
    const col = Math.max(0, Math.round((x - marginLeft) / cellWidth));
    const row = Math.max(0, Math.round((y - marginTop) / cellHeight));
    occupiedBoxes.push({ id: item.id, x, y });
    result[item.id] = { id: item.id, x, y, col, row, isCustom: true };
  }

  // Pass 2: Place remaining auto-positioned icons into the first available grid cell (column-first)
  let nextSlotIndex = 0;
  for (const item of params.icons) {
    if (result[item.id]) continue;
    let placed = false;
    while (!placed && nextSlotIndex < 2000) {
      const col = Math.floor(nextSlotIndex / rowsPerCol);
      const row = nextSlotIndex % rowsPerCol;
      nextSlotIndex += 1;
      const x = marginLeft + col * cellWidth;
      const y = marginTop + row * cellHeight;
      if (!collides(x, y)) {
        occupiedBoxes.push({ id: item.id, x, y });
        result[item.id] = { id: item.id, x, y, col, row, isCustom: false };
        placed = true;
      }
    }
  }

  return result;
}


/**
 * Compute neat, column-first aligned grid coordinates for desktop icons ("Organize Desktop Icons" / "整理桌面图标").
 * Respects the active icon ordering and guarantees zero overlap across columns and rows.
 */
export function organizeDesktopIconsGrid(params: {
  icons: ReadonlyArray<{ id: string }>;
  surfaceWidth: number;
  surfaceHeight: number;
  taskbarHeight?: number | undefined;
  cellWidth?: number | undefined;
  cellHeight?: number | undefined;
  marginLeft?: number | undefined;
  marginTop?: number | undefined;
}): Record<string, DesktopIconPosition> {
  const slots = resolveNonOverlappingIconLayout({
    icons: params.icons,
    iconPositions: {},
    surfaceWidth: params.surfaceWidth,
    surfaceHeight: params.surfaceHeight,
    taskbarHeight: params.taskbarHeight,
    cellWidth: params.cellWidth,
    cellHeight: params.cellHeight,
    marginLeft: params.marginLeft,
    marginTop: params.marginTop,
  });
  const organized: Record<string, DesktopIconPosition> = {};
  for (const item of params.icons) {
    const slot = slots[item.id];
    if (slot) {
      organized[item.id] = { x: slot.x, y: slot.y };
    }
  }
  return organized;
}

const DESKTOP_DELETED_USERS_PREFIX = 'agentopsdeck.desktop.deletedUsers.v1:';

export interface DesktopDeletedUsersState {
  hubUserIds: string[];
  connectorUserKeys: string[];
}

export function readDesktopDeletedUsers(scope = 'default'): DesktopDeletedUsersState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { hubUserIds: [], connectorUserKeys: [] };
  }
  try {
    const raw = window.localStorage.getItem(`${DESKTOP_DELETED_USERS_PREFIX}${scope}`);
    if (!raw) return { hubUserIds: [], connectorUserKeys: [] };
    const parsed = JSON.parse(raw) as Partial<DesktopDeletedUsersState>;
    return {
      hubUserIds: Array.isArray(parsed.hubUserIds)
        ? parsed.hubUserIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [],
      connectorUserKeys: Array.isArray(parsed.connectorUserKeys)
        ? parsed.connectorUserKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        : [],
    };
  } catch {
    return { hubUserIds: [], connectorUserKeys: [] };
  }
}

export function writeDesktopDeletedUsers(
  scope: string,
  state: DesktopDeletedUsersState,
): DesktopDeletedUsersState {
  const normalized: DesktopDeletedUsersState = {
    hubUserIds: [...new Set(state.hubUserIds.filter((id) => typeof id === 'string' && id.trim().length > 0))],
    connectorUserKeys: [
      ...new Set(state.connectorUserKeys.filter((k) => typeof k === 'string' && k.trim().length > 0)),
    ],
  };
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(`${DESKTOP_DELETED_USERS_PREFIX}${scope}`, JSON.stringify(normalized));
    } catch {
      // Ignore quota errors
    }
  }
  return normalized;
}

export interface FormattedHudKernelTelemetry {
  scopeLabel: string;
  cpuPct: number | null;
  cpuBarWidth: number;
  cpuText: string;
  memPct: number | null;
  memBarWidth: number;
  memText: string;
  diskPct: number | null;
  diskBarWidth: number;
  diskText: string;
  hasRealSample: boolean;
}

export function formatHudKernelTelemetry(
  sample: {
    scope?: 'host' | 'cgroup' | 'process' | null;
    cpu: { percent: number | null; cores: number | null };
    memory: { usedBytes: number | null; totalBytes: number | null; availableBytes?: number | null };
    volumes?: ReadonlyArray<{ id?: string; label?: string; totalBytes: number | null; freeBytes: number | null }>;
  } | null | undefined,
  labels?: {
    sampling?: string;
    cgroupUnlimited?: string;
    noVolume?: string;
    coresUnit?: string;
  },
): FormattedHudKernelTelemetry {
  const samplingText = labels?.sampling ?? 'Sampling...';
  const cgroupUnlimitedText = labels?.cgroupUnlimited ?? 'Cgroup RSS';
  const noVolumeText = labels?.noVolume ?? 'Unconfigured';
  const coresUnit = labels?.coresUnit ?? 'C';

  const formatBytesGb = (bytes?: number | null): string | null => {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb === 0) return '0.0G';
    if (gb < 0.1) {
      const mb = Math.max(1, Math.round(bytes / (1024 * 1024)));
      return `${mb}M`;
    }
    return gb >= 100 ? `${Math.round(gb)}G` : `${gb.toFixed(1)}G`;
  };

  if (!sample) {
    return {
      scopeLabel: 'kernel',
      cpuPct: null,
      cpuBarWidth: 0,
      cpuText: samplingText,
      memPct: null,
      memBarWidth: 0,
      memText: samplingText,
      diskPct: null,
      diskBarWidth: 0,
      diskText: samplingText,
      hasRealSample: false,
    };
  }

  const scopeLabel = sample.scope ?? 'host';
  const cpuCores = sample.cpu.cores != null && sample.cpu.cores > 0 ? `${sample.cpu.cores}${coresUnit}` : '';
  const cpuPct =
    sample.cpu.percent != null && Number.isFinite(sample.cpu.percent)
      ? Math.max(0, Math.min(100, Math.round(sample.cpu.percent * 10) / 10))
      : null;
  const cpuBarWidth = cpuPct != null ? Math.max(2, Math.round(cpuPct)) : 0;
  const cpuText =
    cpuPct != null
      ? `${cpuPct % 1 === 0 ? cpuPct.toFixed(0) : cpuPct.toFixed(1)}%${cpuCores ? ` (${cpuCores})` : ''}`
      : `${samplingText}${cpuCores ? ` (${cpuCores})` : ''}`;

  const memUsedGb = formatBytesGb(sample.memory.usedBytes);
  const memTotalGb = formatBytesGb(sample.memory.totalBytes);
  const memPct =
    sample.memory.usedBytes != null &&
    sample.memory.totalBytes != null &&
    sample.memory.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((sample.memory.usedBytes / sample.memory.totalBytes) * 100)))
      : null;
  // When running in a systemd cgroup v2 slice with memory.max = "max", totalBytes is null while usedBytes is real kernel memory.current
  const cgroupHeuristicBar =
    memPct != null
      ? memPct
      : sample.memory.usedBytes != null && sample.memory.usedBytes > 0
        ? Math.max(4, Math.min(95, Math.round((sample.memory.usedBytes / (16 * 1024 * 1024 * 1024)) * 100)))
        : 0;
  const memText =
    memUsedGb && memTotalGb
      ? `${memUsedGb} / ${memTotalGb} (${memPct ?? 0}%)`
      : memUsedGb
        ? `${memUsedGb} (${cgroupUnlimitedText})`
        : samplingText;

  const firstVol = sample.volumes?.[0];
  const diskUsedBytes =
    firstVol && firstVol.totalBytes != null && firstVol.freeBytes != null
      ? Math.max(0, firstVol.totalBytes - firstVol.freeBytes)
      : null;
  const diskUsedGb = formatBytesGb(diskUsedBytes);
  const diskTotalGb = formatBytesGb(firstVol?.totalBytes);
  const diskPct =
    firstVol &&
    firstVol.totalBytes != null &&
    firstVol.freeBytes != null &&
    firstVol.totalBytes > 0
      ? Math.max(
          0,
          Math.min(100, Math.round(((firstVol.totalBytes - firstVol.freeBytes) / firstVol.totalBytes) * 100)),
        )
      : null;
  const diskBarWidth = diskPct != null ? Math.max(2, diskPct) : 0;
  const diskText =
    diskUsedGb && diskTotalGb
      ? `${diskUsedGb} / ${diskTotalGb} (${diskPct ?? 0}%)`
      : noVolumeText;

  return {
    scopeLabel,
    cpuPct,
    cpuBarWidth,
    cpuText,
    memPct,
    memBarWidth: cgroupHeuristicBar,
    memText,
    diskPct,
    diskBarWidth,
    diskText,
    hasRealSample: true,
  };
}

export function findMatchingExplorerOpenWindow<
  T extends { sessionKey: string; title: string; kind: DesktopIconKind; resourceId?: string | undefined },
>(
  openWindows: readonly T[],
  item: Pick<DesktopIconItem, 'kind' | 'title' | 'session' | 'resourceId'>,
): T | undefined {
  if (item.kind === 'session' || item.session) {
    const targetSessionKey = item.session?.sessionKey;
    if (!targetSessionKey) return undefined;
    return openWindows.find((w) => w.kind === 'session' && w.sessionKey === targetSessionKey);
  }
  return openWindows.find((w) => {
    if (w.kind === 'session' || w.kind !== item.kind) return false;
    if (item.resourceId) {
      if (w.resourceId) return w.resourceId === item.resourceId;
      return item.resourceId === 'default';
    }
    return !w.resourceId || w.resourceId === 'default' || w.title === item.title;
  });
}
