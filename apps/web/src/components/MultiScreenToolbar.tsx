import {
  Maximize,
  Minimize,
  Monitor,
  MonitorUp,
  Move,
  RefreshCw,
  ScreenShare,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useViewportPopover } from '../lib/layout-popover';
import {
  buildProjectionUrl,
  detectSecondaryScreenRect,
  moveWindowToScreen,
  MULTI_SCREEN_CHANNEL_NAME,
  openCompanionWindowOnScreen,
  parseProjectionSearch,
  readSecondaryWindowIds,
  requestFullscreenOnScreen,
  subscribeScreenDetailsChanges,
  writeSecondaryWindowIds,
  type MultiScreenSyncMessage,
  type ProjectedWindowPayload,
  type ScreenPlacementRect,
} from '../lib/multi-screen-projection';

type CompanionPeerInfo = {
  windowId: string;
  ts: number;
  title?: string | undefined;
  kind?: string | undefined;
};

export default function MultiScreenToolbar({
  activeTarget,
  onSelectSessionKey,
}: {
  activeTarget?: ProjectedWindowPayload | undefined;
  onSelectSessionKey?: ((sessionKey: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  );
  const [companionPeers, setCompanionPeers] = useState<CompanionPeerInfo[]>([]);
  const [isExtended, setIsExtended] = useState(false);
  const [permissionState, setPermissionState] = useState<'granted' | 'prompt' | 'denied' | 'unsupported'>('prompt');
  const [displays, setDisplays] = useState<ScreenPlacementRect[]>([]);
  const [controlOpen, setControlOpen] = useState(false);
  const [autoFullscreenOnProject, setAutoFullscreenOnProject] = useState(true);
  const [projectionPayload] = useState<ProjectedWindowPayload | null>(() =>
    typeof window !== 'undefined' ? parseProjectionSearch(window.location.search) : null,
  );
  const [dismissProjectionBanner, setDismissProjectionBanner] = useState(false);
  const controlBtnRef = useRef<HTMLButtonElement | null>(null);
  const controlPopoverRef = useRef<HTMLDivElement | null>(null);
  useViewportPopover(controlOpen, controlBtnRef, controlPopoverRef, { defaultPlacement: 'bottom-end' });
  const windowIdRef = useRef(`win_${Math.random().toString(36).slice(2, 9)}`);
  const peersRef = useRef(new Map<string, CompanionPeerInfo>());
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!controlOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (controlPopoverRef.current?.contains(target) || controlBtnRef.current?.contains(target)) return;
      setControlOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setControlOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [controlOpen]);

  const refreshDisplays = useCallback(async (promptPermission = false) => {
    const info = await detectSecondaryScreenRect({ promptPermission });
    setIsExtended(info.isExtended);
    setPermissionState(info.permissionState);
    setDisplays(info.displays);
    return info;
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    void refreshDisplays(false);
    const unsub = subscribeScreenDetailsChanges((topo) => {
      setIsExtended(topo.isExtended);
      setPermissionState(topo.permissionState);
      setDisplays(topo.displays);
    });
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      unsub();
    };
  }, [refreshDisplays]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(MULTI_SCREEN_CHANNEL_NAME);
    channelRef.current = channel;
    const myId = windowIdRef.current;
    const myTitle = projectionPayload?.title ?? activeTarget?.title ?? 'Main Workspace';
    const myKind = projectionPayload?.kind ?? activeTarget?.kind ?? 'workspace';

    const syncPeersState = () => {
      const next = Array.from(peersRef.current.values());
      setCompanionPeers((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (item, idx) =>
              item.windowId === next[idx]?.windowId &&
              item.title === next[idx]?.title &&
              item.kind === next[idx]?.kind,
          )
        ) {
          return prev;
        }
        return next;
      });
    };

    const prunePeers = () => {
      const cutoff = Date.now() - 25_000;
      for (const [peerId, info] of peersRef.current.entries()) {
        if (info.ts < cutoff) peersRef.current.delete(peerId);
      }
      syncPeersState();
    };

    channel.onmessage = (event: MessageEvent<MultiScreenSyncMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.windowId === myId) return;
      if (msg.type === 'bye') {
        peersRef.current.delete(msg.windowId);
        syncPeersState();
        return;
      }
      if (msg.type === 'close-companions' && projectionPayload) {
        try {
          window.close();
        } catch {
          // Ignore window close restrictions
        }
        return;
      }
      const existing = peersRef.current.get(msg.windowId);
      const nextTitle =
        ('title' in msg && msg.title) ||
        (msg.type === 'projection-opened' ? msg.payload.title : existing?.title);
      const nextKind =
        ('kind' in msg && msg.kind) ||
        (msg.type === 'projection-opened' ? msg.payload.kind : existing?.kind);
      peersRef.current.set(msg.windowId, {
        windowId: msg.windowId,
        ts: Date.now(),
        title: nextTitle,
        kind: nextKind,
      });
      syncPeersState();

      if (msg.type === 'hello' || msg.type === 'ping') {
        channel.postMessage({
          type: 'pong',
          windowId: myId,
          timestamp: Date.now(),
          title: myTitle,
          kind: myKind,
        } satisfies MultiScreenSyncMessage);
      } else if (msg.type === 'focus-session' && msg.sessionKey && onSelectSessionKey) {
        onSelectSessionKey(msg.sessionKey);
      }
    };

    channel.postMessage({
      type: 'hello',
      windowId: myId,
      timestamp: Date.now(),
      title: myTitle,
      kind: myKind,
    } satisfies MultiScreenSyncMessage);
    const heartbeat = window.setInterval(() => {
      prunePeers();
      channel.postMessage({
        type: 'ping',
        windowId: myId,
        timestamp: Date.now(),
        title: myTitle,
        kind: myKind,
      } satisfies MultiScreenSyncMessage);
    }, 10_000);

    return () => {
      window.clearInterval(heartbeat);
      try {
        channel.postMessage({ type: 'bye', windowId: myId } satisfies MultiScreenSyncMessage);
        channel.close();
      } catch {
        // Ignore close errors
      }
      channelRef.current = null;
    };
  }, [activeTarget?.kind, activeTarget?.title, onSelectSessionKey, projectionPayload]);

  const toggleFullscreen = useCallback(async (targetScreen?: ScreenPlacementRect) => {
    try {
      if (document.fullscreenElement && !targetScreen) {
        await document.exitFullscreen();
      } else {
        await requestFullscreenOnScreen(document.documentElement, targetScreen);
      }
    } catch {
      // Ignore fullscreen permission errors
    }
  }, []);

  const projectToRect = useCallback(
    async (customRect?: ScreenPlacementRect) => {
      // Directly invoke W3C Window Management API getScreenDetails() inside user gesture
      // so Chrome/Edge prompts natively ("Use multiple displays") like Microsoft DevBox / Web RDP
      // without opening a separate popup window via window.open().
      const screenInfo = await refreshDisplays(true);
      const targetRect = customRect ?? screenInfo.secondaryRect ?? screenInfo.primaryScreen;
      const entered = await requestFullscreenOnScreen(document.documentElement, targetRect);
      if (!entered || screenInfo.displays.length <= 1) {
        setControlOpen(true);
      }
    },
    [refreshDisplays],
  );

  const openCompanionOnRect = useCallback(
    async (customRect?: ScreenPlacementRect) => {
      const basePayload: ProjectedWindowPayload = activeTarget ?? {
        paneId: 'workspace',
        kind: 'workspace',
        title: 'AgentOpsDeck Secondary Screen',
      };
      const screenInfo = await refreshDisplays(true);
      const targetRect = customRect ?? screenInfo.secondaryRect;
      const payload: ProjectedWindowPayload = {
        ...basePayload,
        autoFullscreen: autoFullscreenOnProject,
        targetScreenIndex: targetRect?.index,
      };
      if (payload.paneId && payload.paneId !== 'workspace') {
        const currentIds = readSecondaryWindowIds();
        const nextIds = writeSecondaryWindowIds([...currentIds, payload.paneId]);
        try {
          channelRef.current?.postMessage({
            type: 'sync-secondary-windows',
            windowId: windowIdRef.current,
            secondaryWindowIds: nextIds,
            timestamp: Date.now(),
          } satisfies MultiScreenSyncMessage);
        } catch {
          // Ignore
        }
      }
      const baseUrl = buildProjectionUrl(window.location.origin, window.location.pathname, payload);
      const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}os_display=2`;
      openCompanionWindowOnScreen(url, 'agentopsdeck_os_display_2', targetRect);
      try {
        channelRef.current?.postMessage({
          type: 'projection-opened',
          windowId: windowIdRef.current,
          payload,
        } satisfies MultiScreenSyncMessage);
      } catch {
        // Ignore broadcast errors
      }
    },
    [activeTarget, autoFullscreenOnProject, refreshDisplays],
  );

  const closeAllCompanions = useCallback(() => {
    try {
      channelRef.current?.postMessage({
        type: 'close-companions',
        windowId: windowIdRef.current,
      } satisfies MultiScreenSyncMessage);
      peersRef.current.clear();
      setCompanionPeers([]);
    } catch {
      // Ignore broadcast errors
    }
  }, []);

  const companionCount = companionPeers.length;

  return (
    <div className="multi-screen-toolbar-cluster" data-testid="multi-screen-toolbar">
      <button
        type="button"
        className={`workspace-icon-tool${isFullscreen ? ' is-active' : ''}`}
        aria-label={isFullscreen ? t('Exit fullscreen') : t('Enter fullscreen')}
        title={isFullscreen ? t('Exit fullscreen') : t('Enter fullscreen (getScreenDetails primary)')}
        onClick={() => void toggleFullscreen()}
      >
        {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
      </button>

      <button
        type="button"
        className={`workspace-icon-tool multi-screen-popout-btn${companionCount > 0 ? ' has-companions' : ''}`}
        aria-label={t('Project to secondary screen')}
        title={
          isExtended
            ? t('Extended display detected — click to project window to secondary monitor')
            : t('Open companion window for multi-monitor setup')
        }
        onClick={() => void projectToRect()}
      >
        <ScreenShare size={14} />
        {companionCount > 0 ? (
          <span className="multi-screen-peer-badge" title={`${companionCount} ${t('companion screens connected')}`}>
            {companionCount}
          </span>
        ) : isExtended ? (
          <span className="multi-screen-extended-dot" title={t('Multi-display detected')} />
        ) : null}
      </button>

      <button
        ref={controlBtnRef}
        type="button"
        className={`workspace-icon-tool${controlOpen ? ' is-active' : ''}`}
        aria-label={t('Multi-screen display control center')}
        title={t('Multi-screen display control center')}
        onClick={() => {
          setControlOpen((v) => !v);
          void refreshDisplays(true);
        }}
      >
        <SlidersHorizontal size={13} />
      </button>

      {/* Projected Screen Auto-Fullscreen Banner */}
      {projectionPayload?.autoFullscreen && !isFullscreen && !dismissProjectionBanner ? (
        <div className="multi-screen-projection-banner" role="status">
          <Monitor size={14} />
          <span>
            {t('Projected Screen')}: <strong>{projectionPayload.title}</strong>
          </span>
          <button
            type="button"
            className="multi-screen-banner-btn"
            onClick={() => {
              const targetDisp =
                typeof projectionPayload.targetScreenIndex === 'number'
                  ? displays[projectionPayload.targetScreenIndex]
                  : undefined;
              void toggleFullscreen(targetDisp);
            }}
          >
            <Maximize size={12} />
            <span>{t('Fullscreen on this display')}</span>
          </button>
          <button
            type="button"
            className="multi-screen-banner-close"
            aria-label={t('Close')}
            onClick={() => setDismissProjectionBanner(true)}
          >
            <X size={12} />
          </button>
        </div>
      ) : null}

      {/* Multi-Screen Control Center Popover */}
      {controlOpen ? (
        <div
          ref={controlPopoverRef}
          className="multi-screen-control-popover"
          role="dialog"
          aria-label={t('Multi-screen display control center')}
        >
          <div className="multi-screen-popover-head">
            <div>
              <strong>{t('Multi-Screen Window Placement')}</strong>
              <span>
                {displays.length} {t('displays detected')} · {companionCount} {t('connected')}
              </span>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className="workspace-icon-tool"
                title={t('Detect displays via getScreenDetails()')}
                onClick={() => void refreshDisplays(true)}
              >
                <RefreshCw size={12} />
              </button>
              <button
                type="button"
                className="workspace-icon-tool"
                aria-label={t('Close')}
                onClick={() => setControlOpen(false)}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {permissionState !== 'granted' ? (
            <button
              type="button"
              className="multi-screen-banner-btn"
              style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              onClick={() => void refreshDisplays(true)}
            >
              <Monitor size={13} />
              <span>{t('Authorize Multi-Screen Window Placement (getScreenDetails)')}</span>
            </button>
          ) : null}

          {/* Visual Display Map with Native W3C Actions */}
          <div className="multi-screen-display-map">
            {displays.map((disp, idx) => (
              <div
                key={`${disp.left}-${disp.top}-${idx}`}
                className={`multi-screen-display-tile${disp.isPrimary ? ' is-primary' : ' is-secondary'}`}
              >
                <Monitor size={16} />
                <strong>{disp.label || `${t('Display')} ${idx + 1}`}</strong>
                <small>
                  {disp.width}×{disp.height} · ({disp.left},{disp.top}){' '}
                  {disp.isPrimary ? `(${t('Primary')})` : `(${t('Extended')})`}
                </small>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="multi-screen-banner-btn"
                    title={t("Fullscreen Here")}
                    onClick={() => void toggleFullscreen(disp)}
                  >
                    <Maximize size={11} />
                    <span>{t('Fullscreen Here')}</span>
                  </button>
                  <button
                    type="button"
                    className="multi-screen-banner-btn"
                    title={t("Move Here")}
                    onClick={() => moveWindowToScreen(window, disp)}
                  >
                    <Move size={11} />
                    <span>{t('Move Here')}</span>
                  </button>
                  <button
                    type="button"
                    className="multi-screen-banner-btn"
                    title={t('Open companion window on this display')}
                    onClick={() => void openCompanionOnRect(disp)}
                  >
                    <ScreenShare size={11} />
                    <span>{t('Project')}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>

          <label className="multi-screen-option-row">
            <input
              name="multi-screen-auto-fs"
              type="checkbox"
              checked={autoFullscreenOnProject}
              onChange={(e) => setAutoFullscreenOnProject(e.target.checked)}
            />
            <span>{t('Prompt fullscreen banner on projected screen')}</span>
          </label>

          {/* Active Companion Windows List */}
          <div className="multi-screen-peers-section">
            <div className="multi-screen-peers-head">
              <span>{t('Connected companion windows')}</span>
              {companionCount > 0 ? (
                <button type="button" className="multi-screen-close-all-btn" onClick={closeAllCompanions}>
                  <Trash2 size={11} />
                  <span>{t('Close all companions')}</span>
                </button>
              ) : null}
            </div>
            {companionPeers.length === 0 ? (
              <p className="multi-screen-peers-empty">{t('No companion windows currently open.')}</p>
            ) : (
              <ul className="multi-screen-peers-list">
                {companionPeers.map((peer) => (
                  <li key={peer.windowId} className="multi-screen-peer-item">
                    <span className="multi-screen-peer-dot" />
                    <div className="multi-screen-peer-meta">
                      <strong>{peer.title || peer.windowId}</strong>
                      <small>{peer.kind ? t(peer.kind as any) : t('companion')}</small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Per-card caption button to pop out a specific pane onto a secondary display. */
export function PaneProjectionButton({ payload }: { payload: ProjectedWindowPayload }) {
  const { t } = useI18n();
  const handleProject = useCallback(
    async (triggerEl?: HTMLElement | null) => {
      const screenInfo = await detectSecondaryScreenRect({ promptPermission: true });
      const targetRect = screenInfo.secondaryRect ?? screenInfo.primaryScreen;
      if (payload.paneId && payload.paneId !== 'workspace') {
        const currentIds = readSecondaryWindowIds();
        const nextIds = writeSecondaryWindowIds([...currentIds, payload.paneId]);
        try {
          if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel(MULTI_SCREEN_CHANNEL_NAME);
            ch.postMessage({
              type: 'sync-secondary-windows',
              windowId: `pane_btn_${Date.now()}`,
              secondaryWindowIds: nextIds,
              timestamp: Date.now(),
            } satisfies MultiScreenSyncMessage);
            ch.close();
          }
        } catch {
          // Ignore
        }
        const baseUrl = buildProjectionUrl(window.location.origin, window.location.pathname, {
          ...payload,
          autoFullscreen: true,
          targetScreenIndex: targetRect?.index,
        });
        const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}os_display=2`;
        const opened = openCompanionWindowOnScreen(url, 'agentopsdeck_os_display_2', targetRect);
        if (opened) return;
      }
      const paneContainer =
        (triggerEl?.closest(
          '[data-os-window], [data-workspace-pane], [data-remote-pane]',
        ) as HTMLElement | null) ?? document.documentElement;
      await requestFullscreenOnScreen(paneContainer, targetRect);
    },
    [payload],
  );

  return (
    <button
      type="button"
      aria-label={t('Pop out to secondary screen')}
      title={t('Pop out to secondary screen')}
      onClick={(e) => void handleProject(e.currentTarget)}
    >
      <MonitorUp size={13} />
    </button>
  );
}
