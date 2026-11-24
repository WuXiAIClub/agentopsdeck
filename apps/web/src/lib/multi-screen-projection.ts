export type ProjectedWindowPayload = {
  paneId: string;
  sessionKey?: string | undefined;
  title: string;
  kind: string;
  resourceId?: string | undefined;
  autoFullscreen?: boolean | undefined;
  targetScreenIndex?: number | undefined;
};

export type MultiScreenSyncMessage =
  | { type: "hello"; windowId: string; timestamp: number; title?: string | undefined; kind?: string | undefined; isSecondaryDisplay?: boolean | undefined }
  | { type: "ping"; windowId: string; timestamp: number; title?: string | undefined; kind?: string | undefined; isSecondaryDisplay?: boolean | undefined }
  | { type: "pong"; windowId: string; timestamp: number; title?: string | undefined; kind?: string | undefined; isSecondaryDisplay?: boolean | undefined }
  | { type: "focus-session"; windowId: string; sessionKey: string }
  | { type: "projection-opened"; windowId: string; payload: ProjectedWindowPayload }
  | { type: "sync-secondary-windows"; windowId: string; secondaryWindowIds: string[]; timestamp: number }
  | { type: "transfer-window"; windowId: string; targetWindowId: string; targetDisplay: "primary" | "secondary"; timestamp: number }
  | { type: "close-companions"; windowId: string }
  | { type: "bye"; windowId: string };

export const MULTI_SCREEN_CHANNEL_NAME = "agentopsdeck:multi-screen:v1";

/**
 * W3C Multi-Screen Window Placement API (`getScreenDetails()`, `ScreenDetailed`, `ScreenDetails`)
 * Supported in Chromium 100+ (`window.getScreenDetails()`).
 */
export interface ScreenDetailed extends Screen {
  readonly availLeft: number;
  readonly availTop: number;
  readonly left: number;
  readonly top: number;
  readonly isPrimary: boolean;
  readonly isInternal: boolean;
  readonly devicePixelRatio: number;
  readonly label: string;
  onchange?: ((this: ScreenDetailed, ev: Event) => unknown) | null;
}

export interface ScreenDetails extends EventTarget {
  readonly screens: ReadonlyArray<ScreenDetailed>;
  readonly currentScreen: ScreenDetailed;
  onscreenschange?: ((this: ScreenDetails, ev: Event) => unknown) | null;
  oncurrentscreenchange?: ((this: ScreenDetails, ev: Event) => unknown) | null;
}

export type ScreenPlacementRect = {
  id?: string | undefined;
  index?: number | undefined;
  left: number;
  top: number;
  width: number;
  height: number;
  availLeft?: number | undefined;
  availTop?: number | undefined;
  availWidth?: number | undefined;
  availHeight?: number | undefined;
  label?: string | undefined;
  isPrimary?: boolean | undefined;
  isInternal?: boolean | undefined;
  isCurrent?: boolean | undefined;
  devicePixelRatio?: number | undefined;
  /** Native W3C ScreenDetailed reference for `element.requestFullscreen({ screen })` */
  nativeScreen?: ScreenDetailed | undefined;
};

export type MultiScreenTopology = {
  supported: boolean;
  permissionState: "granted" | "prompt" | "denied" | "unsupported";
  isExtended: boolean;
  screenCount: number;
  primaryScreen?: ScreenPlacementRect | undefined;
  currentScreen?: ScreenPlacementRect | undefined;
  secondaryRect?: ScreenPlacementRect | undefined;
  displays: ScreenPlacementRect[];
};

let cachedScreenDetails: ScreenDetails | null = null;

export function isWindowPlacementApiSupported(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as Window & { getScreenDetails?: unknown }).getScreenDetails === "function";
}

export function buildProjectionUrl(baseOrigin: string, basePath: string, payload: ProjectedWindowPayload): string {
  const url = new URL(basePath || "/", baseOrigin || "http://localhost");
  url.searchParams.set("projection", "1");
  url.searchParams.set("paneId", payload.paneId);
  url.searchParams.set("kind", payload.kind);
  url.searchParams.set("title", payload.title.slice(0, 100));
  if (payload.sessionKey) url.searchParams.set("sessionKey", payload.sessionKey);
  if (payload.resourceId) url.searchParams.set("resourceId", payload.resourceId);
  if (payload.autoFullscreen) url.searchParams.set("autoFs", "1");
  if (typeof payload.targetScreenIndex === "number") {
    url.searchParams.set("screenIdx", String(payload.targetScreenIndex));
  }
  return url.toString();
}

export function parseProjectionSearch(search: string): ProjectedWindowPayload | null {
  try {
    const params = new URLSearchParams(search);
    if (params.get("projection") !== "1") return null;
    const paneId = params.get("paneId") || "projected";
    const kind = params.get("kind") || "session";
    const title = params.get("title") || "Projected view";
    const sessionKey = params.get("sessionKey") || undefined;
    const resourceId = params.get("resourceId") || undefined;
    const autoFullscreen = params.get("autoFs") === "1" ? true : undefined;
    const screenIdxRaw = params.get("screenIdx");
    const targetScreenIndex =
      screenIdxRaw !== null && Number.isFinite(Number(screenIdxRaw))
        ? Number(screenIdxRaw)
        : undefined;
    return { paneId, kind, title, sessionKey, resourceId, autoFullscreen, targetScreenIndex };
  } catch {
    return null;
  }
}

/** Compute window.open features string for secondary screen or default popout. */
export function computeProjectionWindowFeatures(rect?: ScreenPlacementRect): string {
  const width = Math.max(640, Math.round(rect?.availWidth ?? rect?.width ?? 1180));
  const height = Math.max(480, Math.round(rect?.availHeight ?? rect?.height ?? 820));
  const left = Math.round(rect?.availLeft ?? rect?.left ?? 120);
  const top = Math.round(rect?.availTop ?? rect?.top ?? 80);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`;
}

function mapScreenDetailedToRect(
  s: ScreenDetailed,
  idx: number,
  current?: ScreenDetailed | undefined,
): ScreenPlacementRect {
  const availLeft = typeof s.availLeft === "number" ? s.availLeft : (s.left ?? 0);
  const availTop = typeof s.availTop === "number" ? s.availTop : (s.top ?? 0);
  const availWidth = typeof s.availWidth === "number" ? s.availWidth : (s.width ?? 1920);
  const availHeight = typeof s.availHeight === "number" ? s.availHeight : (s.height ?? 1080);
  const isCurrent = Boolean(
    current &&
      (s === current ||
        (s.availLeft === current.availLeft &&
          s.availTop === current.availTop &&
          s.availWidth === current.availWidth)),
  );
  return {
    id: `screen-${idx}-${availLeft}-${availTop}`,
    index: idx,
    left: typeof s.left === "number" ? s.left : availLeft,
    top: typeof s.top === "number" ? s.top : availTop,
    width: typeof s.width === "number" ? s.width : availWidth,
    height: typeof s.height === "number" ? s.height : availHeight,
    availLeft,
    availTop,
    availWidth,
    availHeight,
    label: s.label || `Display ${idx + 1}`,
    isPrimary: Boolean(s.isPrimary),
    isInternal: Boolean(s.isInternal),
    isCurrent,
    devicePixelRatio: typeof s.devicePixelRatio === "number" ? s.devicePixelRatio : 1,
    nativeScreen: s,
  };
}

/**
 * Acquire the live W3C `ScreenDetails` object via `window.getScreenDetails()`.
 * Caches the instance so `screenschange` / `currentscreenchange` listeners can be shared.
 */
export async function acquireScreenDetails(): Promise<ScreenDetails | null> {
  if (typeof window === "undefined") return null;
  const win = window as Window & {
    getScreenDetails?: () => Promise<ScreenDetails>;
  };
  if (typeof win.getScreenDetails !== "function") return null;
  try {
    const details = await win.getScreenDetails();
    cachedScreenDetails = details;
    return details;
  } catch {
    return cachedScreenDetails;
  }
}

/**
 * Detect all displays and secondary screen geometry via the W3C Multi-Screen Window Placement API
 * (`window.getScreenDetails()`), with graceful fallback when unsupported or before permission grant.
 */
export async function detectSecondaryScreenRect(options?: {
  promptPermission?: boolean | undefined;
}): Promise<MultiScreenTopology> {
  if (typeof window === "undefined") {
    return {
      supported: false,
      permissionState: "unsupported",
      isExtended: false,
      screenCount: 1,
      displays: [],
    };
  }
  const win = window as Window & {
    screen?: Screen & { isExtended?: boolean };
    getScreenDetails?: () => Promise<ScreenDetails>;
  };
  const supported = typeof win.getScreenDetails === "function";
  const isExtended = Boolean(win.screen?.isExtended);

  if (supported && (options?.promptPermission !== false || cachedScreenDetails !== null)) {
    try {
      const details = cachedScreenDetails ?? (await win.getScreenDetails!());
      cachedScreenDetails = details;
      const screens = details.screens ?? [];
      const current = details.currentScreen;
      const displays: ScreenPlacementRect[] = screens.map((s, idx) =>
        mapScreenDetailedToRect(s, idx, current),
      );
      const primaryScreen = displays.find((d) => d.isPrimary) ?? displays[0];
      const currentScreen = displays.find((d) => d.isCurrent) ?? primaryScreen;
      const secondary =
        displays.find((d) => currentScreen && d.id !== currentScreen.id) ??
        displays.find((d) => !d.isPrimary) ??
        displays[1];
      return {
        supported: true,
        permissionState: "granted",
        isExtended: displays.length > 1 || isExtended,
        screenCount: Math.max(1, displays.length),
        primaryScreen,
        currentScreen,
        secondaryRect: secondary ?? primaryScreen,
        displays,
      };
    } catch {
      // Permission denied or user gesture required; fall through to synthetic topology
    }
  }

  const primaryRect: ScreenPlacementRect = {
    id: "screen-0-primary",
    index: 0,
    left: typeof window.screenX === "number" ? window.screenX : 0,
    top: typeof window.screenY === "number" ? window.screenY : 0,
    width: window.screen?.width || window.screen?.availWidth || 1920,
    height: window.screen?.height || window.screen?.availHeight || 1080,
    availLeft: typeof window.screenX === "number" ? window.screenX : 0,
    availTop: typeof window.screenY === "number" ? window.screenY : 0,
    availWidth: window.screen?.availWidth || 1920,
    availHeight: window.screen?.availHeight || 1080,
    label: "Primary Display",
    isPrimary: true,
    isCurrent: true,
    devicePixelRatio: typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1,
  };
  const fallbackRect: ScreenPlacementRect = {
    id: "screen-1-companion",
    index: 1,
    left: primaryRect.left + Math.round(primaryRect.width),
    top: primaryRect.top,
    width: primaryRect.width,
    height: primaryRect.height,
    availLeft: primaryRect.left + Math.round(primaryRect.width),
    availTop: primaryRect.top,
    availWidth: primaryRect.availWidth ?? primaryRect.width,
    availHeight: primaryRect.availHeight ?? primaryRect.height,
    label: "Extended Display 2",
    isPrimary: false,
    isCurrent: false,
    devicePixelRatio: primaryRect.devicePixelRatio,
  };
  return {
    supported,
    permissionState: supported ? "prompt" : "unsupported",
    isExtended,
    screenCount: isExtended ? 2 : 1,
    primaryScreen: primaryRect,
    currentScreen: primaryRect,
    secondaryRect: isExtended ? fallbackRect : primaryRect,
    displays: isExtended ? [primaryRect, fallbackRect] : [primaryRect],
  };
}

/**
 * Subscribe to W3C `screenschange` and `currentscreenchange` events on `ScreenDetails`,
 * plus `window.screen.onchange` when available.
 */
export function subscribeScreenDetailsChanges(
  onUpdate: (topology: MultiScreenTopology) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  let disposed = false;
  const handleChange = () => {
    if (disposed) return;
    void detectSecondaryScreenRect({ promptPermission: false }).then((topo) => {
      if (!disposed) onUpdate(topo);
    });
  };

  const screenObj = window.screen as (Screen & EventTarget) | undefined;
  try {
    screenObj?.addEventListener?.("change", handleChange);
  } catch {
    // Ignore unsupported event target on window.screen
  }

  if (cachedScreenDetails) {
    try {
      cachedScreenDetails.addEventListener("screenschange", handleChange);
      cachedScreenDetails.addEventListener("currentscreenchange", handleChange);
    } catch {
      // Ignore
    }
  }

  return () => {
    disposed = true;
    try {
      screenObj?.removeEventListener?.("change", handleChange);
    } catch {
      // Ignore
    }
    if (cachedScreenDetails) {
      try {
        cachedScreenDetails.removeEventListener("screenschange", handleChange);
        cachedScreenDetails.removeEventListener("currentscreenchange", handleChange);
      } catch {
        // Ignore
      }
    }
  };
}

/**
 * Request native fullscreen on a specific physical screen using the W3C Multi-Screen Window Placement API:
 * `await element.requestFullscreen({ screen: targetScreen.nativeScreen })`.
 * If `targetScreen` is omitted, defaults to primary screen when available.
 */
export async function requestFullscreenOnScreen(
  element?: Element | null,
  targetScreen?: ScreenPlacementRect | undefined,
): Promise<boolean> {
  const el = element ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el || typeof el.requestFullscreen !== "function") return false;

  try {
    let nativeScreen = targetScreen?.nativeScreen;
    if (!nativeScreen && isWindowPlacementApiSupported()) {
      const details = cachedScreenDetails ?? (await acquireScreenDetails());
      if (details && details.screens.length > 0) {
        if (typeof targetScreen?.index === "number" && details.screens[targetScreen.index]) {
          nativeScreen = details.screens[targetScreen.index];
        } else if (targetScreen?.isPrimary) {
          nativeScreen = details.screens.find((s) => s.isPrimary) ?? details.screens[0];
        } else if (targetScreen && !targetScreen.isPrimary) {
          nativeScreen = details.screens.find((s) => !s.isPrimary) ?? details.screens[0];
        } else {
          nativeScreen = details.screens.find((s) => s.isPrimary) ?? details.screens[0];
        }
      }
    }

    if (nativeScreen) {
      await el.requestFullscreen({
        navigationUI: "hide",
        screen: nativeScreen,
      } as FullscreenOptions);
      return true;
    }

    await el.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    try {
      await el.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Move and optionally resize a browser window (`window` or popup `Window`) onto a target display's coordinates
 * via `moveTo(availLeft, availTop)` and `resizeTo(availWidth, availHeight)`.
 */
export function moveWindowToScreen(
  targetWindow: Window | null | undefined,
  screen: ScreenPlacementRect,
  options?: { maximizeToScreen?: boolean | undefined },
): boolean {
  const win = targetWindow ?? (typeof window !== "undefined" ? window : null);
  if (!win) return false;
  const left = Math.round(screen.availLeft ?? screen.left ?? 0);
  const top = Math.round(screen.availTop ?? screen.top ?? 0);
  const width = Math.max(480, Math.round(screen.availWidth ?? screen.width ?? 1280));
  const height = Math.max(360, Math.round(screen.availHeight ?? screen.height ?? 800));
  try {
    if (typeof win.moveTo === "function") {
      win.moveTo(left, top);
    }
    if (options?.maximizeToScreen !== false && typeof win.resizeTo === "function") {
      win.resizeTo(width, height);
    }
    win.focus?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a companion window directly on the target display, using both window features and
 * post-open `moveWindowToScreen` placement.
 */
export const SECONDARY_WINDOWS_STORAGE_PREFIX = "agentopsdeck:os-secondary-windows:v1:";

export function isSecondaryDisplayWindow(search?: string): boolean {
  try {
    const raw = search ?? (typeof window !== "undefined" ? window.location.search : "");
    if (!raw) return false;
    const params = new URLSearchParams(raw);
    return params.get("projection") === "1" || params.get("os_display") === "2";
  } catch {
    return false;
  }
}

export function readSecondaryWindowIds(scope = "default"): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(`${SECONDARY_WINDOWS_STORAGE_PREFIX}${scope}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0)));
  } catch {
    return [];
  }
}

export function writeSecondaryWindowIds(windowIds: string[], scope = "default"): string[] {
  const normalized = Array.from(
    new Set(windowIds.filter((item): item is string => typeof item === "string" && item.length > 0)),
  );
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`${SECONDARY_WINDOWS_STORAGE_PREFIX}${scope}`, JSON.stringify(normalized));
    }
  } catch {
    // Ignore storage quota errors
  }
  return normalized;
}

export function openCompanionWindowOnScreen(
  url: string,
  windowName: string,
  targetScreen?: ScreenPlacementRect | undefined,
): Window | null {
  if (typeof window === "undefined") return null;
  const features = computeProjectionWindowFeatures(targetScreen);
  const opened = window.open(url, windowName, features);
  if (opened && targetScreen) {
    moveWindowToScreen(opened, targetScreen, { maximizeToScreen: true });
    if (typeof window.setTimeout === "function") {
      window.setTimeout(() => {
        moveWindowToScreen(opened, targetScreen, { maximizeToScreen: true });
      }, 120);
      window.setTimeout(() => {
        moveWindowToScreen(opened, targetScreen, { maximizeToScreen: true });
      }, 360);
    }
  }
  return opened;
}
