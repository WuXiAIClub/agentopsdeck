import './lib/crypto-compat';
import { useI18n, translate } from './lib/i18n';

export function sessionDeletionConfirmation(title: string, delegated: boolean) {
  return { title: translate('Delete session?'), description: delegated
    ? translate('“{title}” and its delegated child sessions will be permanently deleted from Hermes. Workspace files are not deleted.', undefined, { title })
    : translate('“{title}” will be deleted. This cannot be undone. Other sessions are not affected.', undefined, { title }),
    confirmLabel: translate('Delete') };
}
import { SessionRecoveryButton } from './components/SessionRecoveryButton';
import { workspaceResourceEvents } from './lib/workspace-resource-events';
import React, { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { MAX_MESSAGE_CHARS, LEGACY_MAX_MESSAGE_CHARS, resolveMessageLimits } from '@agentopsdeck/shared';
import { LongTextReference } from './components/LongTextReference';
const LazySessionGoal = lazy(() => import('./components/SessionGoal').then(module => ({ default: module.SessionGoal })));
const SessionGoal = (props: React.ComponentProps<typeof LazySessionGoal>) => <Suspense fallback={null}><LazySessionGoal {...props} /></Suspense>;
const LazySessionGoalControl = lazy(() => import('./components/SessionGoalControl').then(module => ({ default: module.SessionGoalControl })));
const SessionGoalControl = (props: React.ComponentProps<typeof LazySessionGoalControl>) => <Suspense fallback={null}><LazySessionGoalControl {...props} /></Suspense>;
const LazySessionGuidanceControl = lazy(() => import('./components/SessionGuidanceControl').then(module => ({ default: module.SessionGuidanceControl })));
const SessionGuidanceControl = (props: React.ComponentProps<typeof LazySessionGuidanceControl>) => <Suspense fallback={null}><LazySessionGuidanceControl {...props} /></Suspense>;
const LazySessionAutomationControl = lazy(() => import('./components/SessionAutomationControl').then(module => ({ default: module.SessionAutomationControl })));
const SessionAutomationControl = (props: React.ComponentProps<typeof LazySessionAutomationControl>) => <Suspense fallback={null}><LazySessionAutomationControl {...props} /></Suspense>;
const LazySessionSubagents = lazy(() => import('./components/SessionSubagents').then(module => ({ default: module.SessionSubagents })));
const SessionSubagents = (props: React.ComponentProps<typeof LazySessionSubagents>) => <Suspense fallback={null}><LazySessionSubagents {...props} /></Suspense>;
import { codexSubagents, hasActiveOrAttentionSubagents } from './lib/codex-subagents';
import { requestOpenSubagentCompanion, resolveSessionSubagentCompanion } from './lib/subagent-companion';
import { publishLiveSessionMessages } from './lib/subagent-live-store';
const LazyChannelsPage = lazy(() => import('./components/ChannelsPage').then(module => ({ default: module.ChannelsPage })));
const ChannelsPage = (props: React.ComponentProps<typeof LazyChannelsPage>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyChannelsPage {...props} /></Suspense>;
import { gatewayDisplayState } from './lib/gateway-display';
const LazyGatewayStatus = lazy(() => import('./components/GatewayStatus').then(module => ({ default: module.GatewayStatus })));
const GatewayStatus = (props: React.ComponentProps<typeof LazyGatewayStatus>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyGatewayStatus {...props} /></Suspense>;
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Archive, ArchiveRestore, ArrowLeft, BarChart3, Bot, Check, ChevronDown, Clock3, Eye, EyeOff, Film, Home, LogOut, Mic, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Pin, PinOff, Plus, RefreshCcw, RotateCcw, Search, Send, ServerCog, Sparkles, Square, Trash2, UserCog, Wifi, X } from 'lucide-react';
import { handleContextMenuKeyDown, useContextMenuPosition } from './lib/context-menu-position';
import type { AgentSummary, ChatMessage, GatewayHealth, SessionHistoryStatus, SendDeliveryMode, SendMessageUpload, SessionSummary } from '@agentopsdeck/shared';
import { api, eventStreamUrl, invalidateMetadataReads, invalidateSnapshotReads, invalidateStreamSnapshotReads, invalidateNavigationHistory, recoveryScope, recoveryEpoch, setRecoveryScope, subscribeRecoveryScope, type ConnectorUsersByConnection, type HubConnection, type HubDeckEvent as DeckEvent, type HubSessionsState, type HubUser } from './api';
import { lockDeck } from './lib/lock-deck';
import type { StartupAuthStatus } from './lib/startup-auth';
const StartupAuth = lazy(() => import('./components/StartupAuth'));
const LazyUnlockScreen = lazy(() => import('./components/auth').then(module => ({ default: module.UnlockScreen })));
const UnlockScreen = (props: React.ComponentProps<typeof LazyUnlockScreen>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyUnlockScreen {...props} /></Suspense>;
import { confirmAction } from './components/ui/confirm';
import { editText } from './components/ui/edit-text';
import { WorkspacePreferencesProvider, useWorkspacePreferences, useSessionTone } from './components/WorkspacePreferences';
import { OrganizedSessions, SessionOrganizationActions } from './components/SessionOrganization';
const SESSION_COMPLETED_EVENT = 'agentopsdeck:session-completed-preview';
const LazySessionCompletionPreviews = lazy(() => import('./components/SessionPeek').then(module => ({ default: module.SessionCompletionPreviews })));
const SessionCompletionPreviews = (props: React.ComponentProps<typeof LazySessionCompletionPreviews>) => <Suspense fallback={null}><LazySessionCompletionPreviews {...props} /></Suspense>;
import { useVisibleSessions, visibleSessionCount, isSessionVisible, subscribeVisibleSessions } from './lib/visible-sessions';
import { adaptiveActiveSessionSafetyInterval, adaptiveHistoryRefreshInterval, historyFallbackInterval } from './lib/history-refresh-budget';
import { requestGovernor } from './lib/request-governor';
import type { HistoryReadSchedule } from './lib/history-read-scheduler';
import type { HistoryBackfillOutcome } from './lib/history-backfill-attempts';
function detectInitialOsDesktopBoot(scope?: string): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.innerWidth > 0 && window.innerWidth < 768) {
    delete document.documentElement.dataset.osDesktopImmersive;
    return false;
  }
  const hash = (window.location.hash || '').replace(/^#\/?/, '');
  const isRoute = hash === 'desktop' || hash === 'os-desktop' || hash === 'tab/desktop' || new URLSearchParams(window.location.search).get('ui') === 'desktop';
  let isStored = false;
  try {
    if (scope) {
      const scoped = localStorage.getItem(`agentopsdeck:ui-mode:v1:${scope}`);
      if (scoped === 'os-desktop') isStored = true;
      else if (scoped === 'classic') isStored = false;
    }
    if (!isStored && (!scope || !localStorage.getItem(`agentopsdeck:ui-mode:v1:${scope}`))) {
      if (localStorage.getItem('agentopsdeck:ui-mode:last') === 'os-desktop') {
        isStored = true;
      } else if (!scope) {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.startsWith('agentopsdeck:ui-mode:v1:') && localStorage.getItem(k) === 'os-desktop') {
            isStored = true;
            break;
          }
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }
  const active = isRoute || isStored;
  if (active) {
    document.documentElement.dataset.osDesktopImmersive = 'true';
    if (!hash || hash === 'tab/sessions' || hash === 'sessions' || hash === 'desktop' || hash === 'os-desktop') {
      if (window.location.hash !== '#/desktop') {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/desktop`);
      }
    }
  } else {
    delete document.documentElement.dataset.osDesktopImmersive;
  }
  return active;
}
let osDesktopBootPreload: Promise<unknown> | undefined;
function preloadOsDesktopChunks(scope?: string): Promise<unknown> | undefined {
  if (!detectInitialOsDesktopBoot(scope)) return undefined;
  if (!osDesktopBootPreload) {
    osDesktopBootPreload = Promise.all([
      import('./components/SessionWorkspaceView'),
      import('./components/WorkspaceOsDesktop'),
    ]).catch(() => undefined);
  }
  return osDesktopBootPreload;
}
if (typeof document !== 'undefined') {
  void preloadOsDesktopChunks();
}
const LazySessionWorkspaceView = lazy(() => import('./components/SessionWorkspaceView').then(module => ({ default: module.SessionWorkspaceView })));
function OsPowerBootFallback({ progress = '38%', stage = '01', subtitleKey = 'Checking AgentOpsDeck auth…' }: { progress?: string; stage?: string; subtitleKey?: string }) {
  return (
    <main className="os-power-overlay is-booting fixed inset-0 grid place-items-center p-5 text-sm font-semibold text-white" data-testid="os-power-overlay" data-power-phase="booting">
      <div className="os-power-bg-grid" aria-hidden="true" />
      <div className="os-power-scanline" aria-hidden="true" />
      <div className="os-power-ambient-orb orb-cyan" aria-hidden="true" />
      <div className="os-power-ambient-orb orb-indigo" aria-hidden="true" />
      <div className="os-power-card max-w-lg text-center" data-startup-auth="checking">
        <span className="os-power-corner corner-tl" aria-hidden="true" />
        <span className="os-power-corner corner-tr" aria-hidden="true" />
        <span className="os-power-corner corner-bl" aria-hidden="true" />
        <span className="os-power-corner corner-br" aria-hidden="true" />
        <div className="os-power-hud-header" aria-hidden="true">
          <span className="os-power-hud-tag">{translate('AGENTOPSDECK // QUANTUM KERNEL v2.4')}</span>
          <span className="os-power-hud-led"><i />{translate('SYSTEM ONLINE')}</span>
        </div>
        <div className="os-power-reactor" aria-hidden="true">
          <span className="os-power-orbit orbit-outer" />
          <span className="os-power-orbit orbit-middle" />
          <span className="os-power-orbit orbit-inner" />
          <span className="os-power-radar-sweep" />
          <div className="os-power-emblem"><Sparkles size={28} /><span className="os-power-ring" /></div>
        </div>
        <strong className="os-power-title">{translate('Starting AgentOpsDeck OS Desktop…')}</strong>
        <p role="status" className="os-power-subtitle">{translate(subtitleKey as never)}</p>
        <div className="os-power-modules-grid" aria-hidden="true">
          <div className="os-power-module-pill is-done"><span className="module-dot" /><span>{translate('IDENTITY VAULT')}</span><b>{translate('OK')}</b></div>
          <div className="os-power-module-pill is-active"><span className="module-dot" /><span>{translate('AGENT MESH')}</span><b>{translate('INIT')}</b></div>
          <div className="os-power-module-pill"><span className="module-dot" /><span>{translate('FENCES COMPOSITOR')}</span><b>{translate('STANDBY')}</b></div>
        </div>
        <div className="os-power-progress-wrap" aria-hidden="true">
          <div className="os-power-progress-meta"><span>{`${translate('BOOT_SEQUENCE // STAGE')} ${stage}`}</span><span>{progress}</span></div>
          <div className="os-power-progress-track"><div className="os-power-progress-bar" style={{ width: progress }} /></div>
        </div>
      </div>
    </main>
  );
}
const SessionWorkspaceView = (props: React.ComponentProps<typeof LazySessionWorkspaceView>) => <Suspense fallback={typeof document !== 'undefined' && document.documentElement.dataset.osDesktopImmersive === 'true' ? <OsPowerBootFallback progress="44%" stage="02" subtitleKey="Initializing multi-agent kernel & workspace surface…" /> : null}><LazySessionWorkspaceView {...props} /></Suspense>;
import { draftAdmission, type RemoteDraft, type RemoteSend } from './lib/remote-draft';
const WorkspaceRemote = lazy(() => import('./components/WorkspaceRemote'));
import { PaneToolbar, PaneStatusControls, PaneTitle } from './components/PaneToolbar';
import { AnchoredPanel } from './components/AnchoredPanel';
import { PaneStatus } from './components/PaneStatus';
import { failedRead, healthyRead, isCancelledRead } from './lib/history-read-health';
import { Power } from 'lucide-react';
import { CaptionIconButton, InstantToolbarTooltips } from './components/CaptionIconButton';
import { sessionTokenMetrics } from './lib/session-token-metrics';
import { GlobalRefreshButton } from './components/GlobalRefreshButton';
import { usePageRefreshGuard } from './lib/use-page-refresh-guard';
import { SessionRailDivider, useSessionRail } from './components/SessionRail';
import { navigationRailWidth } from './lib/session-rail';
import { useHoverReveal } from './lib/use-hover-reveal';
const LazyQuickSessionMessage = lazy(() => import('./components/QuickSessionMessage').then(module => ({ default: module.QuickSessionMessage })));
const QuickSessionMessage = (props: React.ComponentProps<typeof LazyQuickSessionMessage>) => <Suspense fallback={null}><LazyQuickSessionMessage {...props} /></Suspense>;
import { AutoScrollControl } from './components/AutoScrollControl';
import { SessionIdentityRow } from './components/ConnectorMark';
const LazyBrowserSettings = lazy(() => import('./components/BrowserSettings').then(module => ({ default: module.BrowserSettings })));
const BrowserSettings = () => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyBrowserSettings /></Suspense>;
import { FontPreferencesProvider } from './components/FontPreferences';
import { createCompletionTracker, isCompletionRefreshEvent, showDesktopNotification } from './lib/desktop-notifications';
import { layoutUnreadEvents } from './lib/layout-unread-events';
import { useCompletionAutoRead } from './lib/use-completion-auto-read';
import { finalReplyMatchesTurn } from './lib/completion-auto-read';
import { completionHistoryCurrent, createCompletionDelivery } from './lib/completion-delivery';
const LazyFileBrowser = lazy(() => import('./components/FileBrowser').then(module => ({ default: module.FileBrowser })));
const FileBrowser = (props: React.ComponentProps<typeof LazyFileBrowser>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyFileBrowser {...props} /></Suspense>;
const LazyMediaLibrary = lazy(() => import('./components/MediaLibrary').then(module => ({ default: module.MediaLibrary })));
const MediaLibrary = () => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyMediaLibrary /></Suspense>;
import { DesktopMessageWithTools, DesktopToolTimeline, MobileMessageBubble, MobileToolStrip, desktopMessageItems, createDesktopMessageProjector, ToolDetailCacheContext, readableText } from './components/messages';
import { createMessageSearch } from './lib/message-search';
import { createIdleToolDetailCache } from './lib/idle-tool-detail-cache';
import { EnvBadge, ConnectionHealthPill, connectionHealthSummary } from './components/ConnectionHealth';
const LazyAccessControlPage = lazy(() => import('./components/hub-connections').then(module => ({ default: module.AccessControlPage })));
const AccessControlPage = (props: React.ComponentProps<typeof LazyAccessControlPage>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyAccessControlPage {...props} /></Suspense>;
const LazyHubConnectionsPanel = lazy(() => import('./components/hub-connections').then(module => ({ default: module.HubConnectionsPanel })));
const HubConnectionsPanel = (props: React.ComponentProps<typeof LazyHubConnectionsPanel>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazyHubConnectionsPanel {...props} /></Suspense>;
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { cn } from './lib/cn';
import { sessionTone } from './lib/session-tone';
import { SessionColorMark } from './components/SessionColorMark';
import { RenderRecoveryBoundary } from './components/RenderRecoveryBoundary';
import { useChatAutoScroll } from './lib/use-chat-auto-scroll';
import { mayRestoreComposerFocus } from './lib/composer-focus';
import { useComposerMedia } from './lib/use-composer-media';
import { useComposerUploads } from './lib/use-composer-uploads';
import { useMessageHistory } from './lib/use-message-history';
import { useProgressiveTailRenderItems } from './lib/progressive-tail-render';
import { observeDesktopHistoryLayout } from './lib/desktop-history-layout';
import { useLatestMessages } from './lib/use-latest-messages';
import { LatestMessagesNotice } from './components/LatestMessagesNotice';
import { prependHistory, refreshHistory } from './lib/message-history';
import { compactResponseNotice } from './lib/maintenance-controls';
import { activeToolProgressSummary, compactProgressLabel, hasMessageSnapshotRevision, hasOptimisticActiveSend, hasQueueBlockingRun, hasQueuedMessageControls, isSessionBusy, isStreamCatchup, runSyncNotice, sessionRunOutcome, withOptimisticRunningState } from './lib/live-session';
import { completedReplyId, hasInvalidCompletedReply, sessionPresentation, sessionSyncIssueLabel } from './lib/session-presentation';
import { INVALID_ASSISTANT_OUTPUT_LABEL } from './lib/assistant-output';
import { HistorySyncIssue } from './components/HistorySyncIssue';
import { mergeSelectionSafeMessages } from './lib/message-selection';
const LazySharedSessionBoundary = lazy(() => import('./components/SharedSessionView').then(module => ({ default: module.SharedSessionBoundary })));
function SharedSessionBoundary({ children, paused = false }: { children: React.ReactNode; paused?: boolean }) {
  const [route, setRoute] = useState(() => sharedSessionRoute(window.location.hash));
  useEffect(() => {
    const changed = () => setRoute(sharedSessionRoute(window.location.hash));
    window.addEventListener('hashchange', changed);
    window.addEventListener('agentopsdeck:route-changed', changed);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('agentopsdeck:route-changed', changed); };
  }, []);
  if (route.kind === 'owner') return children;
  return <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazySharedSessionBoundary paused={paused}>{children}</LazySharedSessionBoundary></Suspense>;
}
import { createReconnectingEventStream, type StreamConnection } from './lib/event-stream';
import { createLiveRefresh, createMessageSnapshotGate, createQueuedRefresh } from './lib/refresh-control';
import { createSessionSnapshotGate, invalidatedSessionNodes } from './lib/session-snapshot';
import { shareSessionSummaries } from './lib/session-summary-sharing';
import { CommandJournal, CommandNotSubmittedError, CommandOutcomeUnknownError, newCommandKey } from './lib/command-recovery';
import { mutateQueueWithRecovery } from './lib/queue-submission';
import { QueueMessageControls } from './components/MessageDelivery';
import { useRetireOpenedCreation } from './lib/use-retire-opened-creation';
const LazyCommandRecoveryNotice = lazy(() => import('./components/CommandRecoveryNotice').then(module => ({ default: module.CommandRecoveryNotice })));
const CommandRecoveryNotice = (props: React.ComponentProps<typeof LazyCommandRecoveryNotice>) => <Suspense fallback={null}><LazyCommandRecoveryNotice {...props} /></Suspense>;
import { deleteSessionWithRecovery } from './lib/session-deletion';
import { newSessionSource, sessionRuntimeUi, sdkAttachmentsSupported, sdkAttachmentHint, sdkAttachmentAccept } from './lib/session-runtime-ui';
import { createSessionWithRecovery } from './lib/session-creation';
import { sessionAddress, sharedSessionRoute } from './lib/session-address';
const LazySessionSharing = lazy(() => import('./components/SessionSharing').then(module => ({ default: module.SessionSharing })));
const SessionSharing = (props: React.ComponentProps<typeof LazySessionSharing>) => <Suspense fallback={null}><LazySessionSharing {...props} /></Suspense>;
const LazySessionFiles = lazy(() => import('./components/SessionFiles').then(module => ({ default: module.SessionFiles })));
const SessionFiles = (props: React.ComponentProps<typeof LazySessionFiles>) => <Suspense fallback={null}><LazySessionFiles {...props} /></Suspense>;
const LazySessionSkills = lazy(() => import('./components/SessionSkills').then(module => ({ default: module.SessionSkills })));
const SessionSkills = (props: React.ComponentProps<typeof LazySessionSkills>) => <Suspense fallback={null}><LazySessionSkills {...props} /></Suspense>;
const LazySessionTokenUsage = lazy(() => import('./components/SessionTokenUsage').then(module => ({ default: module.SessionTokenUsage })));
const SessionTokenUsage = (props: React.ComponentProps<typeof LazySessionTokenUsage>) => <Suspense fallback={null}><LazySessionTokenUsage {...props} /></Suspense>;
const LazySessionInteractions = lazy(() => import('./components/SessionInteractions').then(module => ({ default: module.SessionInteractions })));
const SessionInteractions = (props: React.ComponentProps<typeof LazySessionInteractions>) => <Suspense fallback={null}><LazySessionInteractions {...props} /></Suspense>;
const LazySessionVolumeWatermarkBanner = lazy(() => import('./components/SessionVolumeWatermarkBanner').then(module => ({ default: module.SessionVolumeWatermarkBanner })));
const SessionVolumeWatermarkBanner = (props: React.ComponentProps<typeof LazySessionVolumeWatermarkBanner>) => <Suspense fallback={null}><LazySessionVolumeWatermarkBanner {...props} /></Suspense>;
function shouldMountSessionWatermark(session: SessionSummary, loadedMessagesCount: number) {
  const rolloutBytes = Math.max(0, session.rolloutBytes ?? 0);
  const messageCount = Math.max(0, session.messageCount ?? 0, loadedMessagesCount);
  const turnCompactions = Math.max(0, session.lastTurnCompactions ?? 0, session.maxTurnCompactions ?? 0);
  return (
    rolloutBytes >= 350 * 1024 * 1024 ||
    messageCount >= 35_000 ||
    turnCompactions >= 55 ||
    (turnCompactions >= 32 && (rolloutBytes >= 64 * 1024 * 1024 || messageCount >= 6_000))
  );
}
import { sessionInteractionReads } from './api';
import { GlobalNotebookProvider, GlobalNotebookTrigger, SessionNotebook } from './components/SessionNotebook';
import { defaultCreationAgent, isLocalCreationConnection } from './lib/creation-target';
import { updateSettingsWithRecovery } from './lib/session-settings';
import { compactSessionWithRecovery } from './lib/session-compact';
import { sendMessageWithRecovery } from './lib/message-submission';
import { useMessageRetryUpdates } from './lib/use-message-retry';
import { applyMessageAdmission } from './lib/message-admission';
import { useAdmissionHistory } from './lib/use-admission-history';
import { AdmissionHistoryNotice } from './components/AdmissionHistoryNotice';
import { useQueueObservation } from './lib/use-queue-observation';
import { appendOptimisticMessageToCache, clearCachedMessages, clearCachedNodeData, readCachedMessages, readCachedSessionsState, removeOptimisticMessageFromCache, writeCachedMessages, writeCachedSessionsState } from './lib/session-cache';
import { recordSessionAccess } from './lib/hot-sessions';
import { useHotSessionPreload } from './lib/use-hot-session-preload';
import { readOptimisticMessages, writeOptimisticMessages } from './lib/optimistic-messages';
import { agentCreationNotice, shouldRefreshAgentReadiness, closedNewSessionDraft, closeNewSessionDraft, editNewSessionGroup, editNewSessionTitle, openNewSessionDraft, refreshNewSessionDefaults, resolveNewSessionSelection } from './lib/new-session-draft';
import { shouldUseMobileShell } from './lib/device-layout';
import { sessionListPrimaryStatusLabel } from './lib/session-list-status';
import { sortPinnedSessions, updatePinnedSessionList } from './lib/session-pin';
import { sessionRuntimeDraft, reconcileRuntimeDraft, applySessionEdit, type SessionEdit } from './lib/session-runtime-overrides';
import { agentRank, compactKey, contextUsageValues, dashboardMetrics, defaultDeliveryMode, displayModelName, displayTitle, effectiveSessionStatus, formatAgo, formatCompactNumber, formatCompactionCount, formatContextUsage, formatNumber, formatTokenValue, getSpeechRecognitionConstructor, getVoiceUnavailableReason, hasMatchingRealMessage, matchesSessionSearch, mergeMessages, navLabel, readDeliveryMode, readHashRoute, readStructuredSessionStatus, sessionMetrics, sessionStatusLabel, shortAgent, titleCase, writeHashRoute, type SpeechRecognitionLike, type Tab } from './lib/session-utils';
import { contextUsageDescription, contextUsageLabel } from './lib/context-usage';
import { computeViewportKeyboardMetrics, isTextEntryElement } from './lib/viewport-keyboard';
import './styles.css';
import './desktop-shell.css';

type VoiceState = 'idle' | 'listening' | 'unsupported';
function voiceRecognitionError(error: string | undefined) {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'Microphone or speech recognition permission denied. Check this site’s browser permissions.';
  if (error === 'audio-capture') return 'No microphone available. Check the selected input device.';
  if (error === 'network') return 'The browser’s speech recognition service is unreachable. Check your connection or type your message instead.';
  return 'Voice input failed. You can still type and send normally.';
}
type MessageState = { sessionKey?: string; maxMessageChars?: number; items: ChatMessage[]; revision?: string | undefined; loading?: boolean; historyLoading?: boolean; historyExpanded?: boolean; hiddenCount?: number | undefined; loadedLimit?: number | undefined };
type SessionListContextMenuState = { session: SessionSummary; x: number; y: number };

const COMPOSER_MAX_MEDIA_ITEMS = 8;
const COMPOSER_MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const COMPOSER_MAX_TOTAL_MEDIA_BYTES = 24 * 1024 * 1024;
const COMPOSER_ACCEPTED_ATTACHMENTS = 'image/*,video/mp4,audio/mpeg,audio/mp4,audio/wav,.m4v,.m4a,.pdf,.txt,.log,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.gz,.tar';
const COMPOSER_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/yaml',
  'application/xml',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-tar',
]);
const REALTIME_SESSION_REFRESH_DEBOUNCE_MS = 1_000;
const REALTIME_MESSAGE_REFRESH_DEBOUNCE_MS = 750;
const SESSION_REFRESH_NORMAL_POLL_MS = 15_000;
const MESSAGE_MOBILE_INITIAL_LOAD_LIMIT = 200;
const MESSAGE_DESKTOP_INITIAL_LOAD_LIMIT = 200;
const MESSAGE_HISTORY_PAGE_SIZE = 200;
const MESSAGE_HISTORY_TOP_THRESHOLD_PX = 96;
const METADATA_MAX_AGE_MS = 60_000;

const COMPOSER_DRAFT_PREFIX = 'agentopsdeck.composerDraft:';
const SESSION_COMPLETION_SEEN_PREFIX = 'agentopsdeck.sessionCompletionSeen:';
const SESSION_MESSAGE_SEEN_PREFIX = 'agentopsdeck.sessionMessageSeen:';

// Build the initial message state for a freshly selected session. If we have a
// local cache for it, render those messages immediately (stale-while-revalidate)
// instead of an empty/loading view; we still mark loading so the background fetch
// can swap in server truth. Mobile detail relies on cached items existing so its
// scroll-to-bottom lands at the latest message on reload.
function messageStateForSession(sessionKey: string | undefined, initialLimit = MESSAGE_MOBILE_INITIAL_LOAD_LIMIT): MessageState {
  if (!sessionKey) return { items: [], loading: false };
  const fresh = api.cachedSessionMessages(sessionKey, initialLimit);
  if (fresh) return { sessionKey, items: fresh.messages, loading: false, hiddenCount: fresh.hiddenCount, revision: fresh.revision, loadedLimit: initialLimit, maxMessageChars: resolveMessageLimits(fresh.limits).maxMessageChars };
  const cached = readCachedMessages(sessionKey);
  if (cached && cached.messages.length > 0) {
    const messages = cached.messages.slice(-initialLimit);
    const trimmedCount = Math.max(0, cached.messages.length - messages.length);
    return { sessionKey, items: messages, loading: true, hiddenCount: (cached.hiddenCount ?? 0) + trimmedCount, loadedLimit: initialLimit };
  }
  return { sessionKey, items: [], loading: true, loadedLimit: initialLimit };
}

// Read the cached sessions list (if any) so a page refresh shows the previous
// list instantly rather than a "Loading sessions" placeholder.
function initialSessionsState(): HubSessionsState {
  return readCachedSessionsState() ?? { groups: [], updatedAt: 0 };
}

// Persist a fresh server message payload into the bounded local cache so the next
// refresh can hydrate instantly. Stays best-effort and never throws.
const lastServerCacheFingerprints = new Map<string, string>();
function cacheServerMessages(sessionKey: string, data: { messages: ChatMessage[]; hiddenCount?: number | undefined; updatedAt?: number; revision?: string | undefined }) {
  const scope = recoveryScope() ?? "";
  const lastMsg = data.messages.at(-1);
  const firstMsg = data.messages[0];
  const fingerprint = `${scope}:${data.revision ?? ""}:${data.messages.length}:${data.hiddenCount ?? -1}:${data.updatedAt ?? -1}:${firstMsg?.id ?? ""}:${lastMsg?.id ?? ""}:${lastMsg?.updatedAt ?? lastMsg?.createdAt ?? 0}:${typeof lastMsg?.text === "string" ? lastMsg.text.length : 0}:${lastMsg?.status ?? ""}`;
  if ((data.revision || data.updatedAt !== undefined) && lastServerCacheFingerprints.get(sessionKey) === fingerprint) return;
  lastServerCacheFingerprints.set(sessionKey, fingerprint);
  if (lastServerCacheFingerprints.size > 80) {
    const oldest = lastServerCacheFingerprints.keys().next().value;
    if (oldest !== undefined) lastServerCacheFingerprints.delete(oldest);
  }
  writeCachedMessages(sessionKey, data.messages, { hiddenCount: data.hiddenCount, updatedAt: data.updatedAt ?? Date.now() });
}

function useSnapshotRequestGate() {
  const [gate] = useState(() => createSessionSnapshotGate(recoveryScope));
  useEffect(() => () => gate.invalidate(), [gate]);
  return gate;
}

function useMessageSnapshotRequestGate(selection: { current: string | undefined }) {
  const [gate] = useState(() => createMessageSnapshotGate(recoveryScope, () => selection.current));
  useEffect(() => () => gate.invalidate(), [gate]);
  return gate;
}

// Session-scoped native history proof (captureSessionPage), 304 of that proof,
// and unverified recent projections intentionally omit a Deck-wide sourceCursor.
// This private timeline gate accepts display results, not shared-session send
// authority. Shared-session readiness separately validates session-scoped proof.
function acceptMessagePage(request: ReturnType<ReturnType<typeof createMessageSnapshotGate>["begin"]>, page: { sourceCursor?: string | undefined; revision?: string | undefined; historyStatus?: SessionHistoryStatus | undefined }) {
  if (page.sourceCursor !== undefined) return request.accept(page.sourceCursor);
  if (page.revision !== undefined || page.historyStatus === "cached") return request();
  return request.accept(undefined);
}

function useSessionTextDraft(sessionKey: string) {
  const [text, setTextState] = useState(() => readSessionTextDraft(sessionKey));
  usePageRefreshGuard(() => !text || readSessionTextDraft(sessionKey) === text);

  useEffect(() => {
    setTextState(readSessionTextDraft(sessionKey));
  }, [sessionKey]);

  const setText = useCallback((value: string | ((current: string) => string)) => {
    setTextState((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      writeSessionTextDraft(sessionKey, next);
      return next;
    });
  }, [sessionKey]);

  return [text, setText] as const;
}

function readSessionTextDraft(sessionKey: string) {
  const scope = recoveryScope();
  if (!scope) return '';
  try { return window.sessionStorage.getItem(`${COMPOSER_DRAFT_PREFIX}${scope}:${sessionKey}`) ?? ''; }
  catch { return ''; }
}

function writeSessionTextDraft(sessionKey: string, value: string) {
  const scope = recoveryScope();
  if (!scope) return;
  const key = `${COMPOSER_DRAFT_PREFIX}${scope}:${sessionKey}`;
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch { /* The in-memory draft remains usable; submission storage fails closed separately. */ }
}

const sessionSeenFallback = new Map<string, string>();

function sessionSeenKey(prefix: string, sessionKey: string) {
  const scope = recoveryScope();
  return scope && sessionKey ? `${prefix}${JSON.stringify([scope, sessionKey])}` : undefined;
}

function readSessionSeen(key: string | undefined): string | null {
  if (!key) return null;
  if (sessionSeenFallback.has(key)) return sessionSeenFallback.get(key)!;
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}

function writeSessionSeen(key: string | undefined, value: number) {
  if (!key || !Number.isFinite(value) || value < 0) return;
  const marker = String(value);
  try {
    window.localStorage.setItem(key, marker);
    window.localStorage.getItem(key);
    sessionSeenFallback.delete(key);
  } catch {
    sessionSeenFallback.delete(key);
    sessionSeenFallback.set(key, marker);
    if (sessionSeenFallback.size > 2_048) sessionSeenFallback.delete(sessionSeenFallback.keys().next().value!);
  }
}

function markSessionCompletionSeen(session: SessionSummary | undefined) {
  markSessionMessagesSeen(session);
  if (!session?.runCompletedAt) return;
  writeSessionSeen(sessionSeenKey(SESSION_COMPLETION_SEEN_PREFIX, session.sessionKey), session.runCompletedAt);
}

function markSessionMessagesSeen(session: SessionSummary | undefined) {
  if (!session?.sessionKey || typeof session.messageCount !== 'number') return;
  writeSessionSeen(sessionSeenKey(SESSION_MESSAGE_SEEN_PREFIX, session.sessionKey), Math.max(0, session.messageCount));
}

function seedSessionMessagesSeen(session: SessionSummary) {
  if (typeof session.messageCount !== 'number') return;
  const key = sessionSeenKey(SESSION_MESSAGE_SEEN_PREFIX, session.sessionKey);
  if (readSessionSeen(key) === null) writeSessionSeen(key, Math.max(0, session.messageCount));
}

function sessionUnreadMessageCount(session: SessionSummary, isOpen = false) {
  if (isOpen || typeof session.messageCount !== 'number') return 0;
  const seenRaw = readSessionSeen(sessionSeenKey(SESSION_MESSAGE_SEEN_PREFIX, session.sessionKey));
  if (seenRaw === null) return 0;
  const seen = Number(seenRaw);
  return Math.max(0, session.messageCount - (Number.isFinite(seen) ? seen : 0));
}

function isSessionCompletionUnseen(session: SessionSummary, isOpen = false) {
  if (isOpen || sessionRunOutcome(session) !== 'completed' || !session.runCompletedAt) return false;
  const seenAt = Number(readSessionSeen(sessionSeenKey(SESSION_COMPLETION_SEEN_PREFIX, session.sessionKey)) ?? 0);
  return session.runCompletedAt > (Number.isFinite(seenAt) && seenAt >= 0 ? seenAt : 0);
}

function useTicker(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function runningDurationLabel(session: SessionSummary, now = Date.now()) {
  if (effectiveSessionStatus(session) !== 'running') return undefined;
  // lastActiveAt is session activity, not a trustworthy current-run start.
  // Without runStartedAt, show status only instead of inventing a long duration.
  if (!session.runStartedAt) return 'run';
  return `run ${formatElapsedCompact(Math.max(0, now - session.runStartedAt))}`;
}

function formatElapsedCompact(ms: number) {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

type AgentTone = { accent: string; soft: string; text: string; shadow: string; gradient: string };

const AGENT_TONES: AgentTone[] = [
  { accent: '#2563eb', soft: 'rgba(37, 99, 235, 0.12)', text: '#1d4ed8', shadow: 'rgba(37, 99, 235, 0.22)', gradient: 'linear-gradient(135deg, #2563eb 0%, #06b6d4 100%)' },
  { accent: '#7c3aed', soft: 'rgba(124, 58, 237, 0.12)', text: '#6d28d9', shadow: 'rgba(124, 58, 237, 0.22)', gradient: 'linear-gradient(135deg, #7c3aed 0%, #ec4899 100%)' },
  { accent: '#059669', soft: 'rgba(5, 150, 105, 0.12)', text: '#047857', shadow: 'rgba(5, 150, 105, 0.22)', gradient: 'linear-gradient(135deg, #059669 0%, #14b8a6 100%)' },
  { accent: '#ea580c', soft: 'rgba(234, 88, 12, 0.13)', text: '#c2410c', shadow: 'rgba(234, 88, 12, 0.22)', gradient: 'linear-gradient(135deg, #ea580c 0%, #f59e0b 100%)' },
  { accent: '#dc2626', soft: 'rgba(220, 38, 38, 0.11)', text: '#b91c1c', shadow: 'rgba(220, 38, 38, 0.2)', gradient: 'linear-gradient(135deg, #dc2626 0%, #fb7185 100%)' },
  { accent: '#0891b2', soft: 'rgba(8, 145, 178, 0.12)', text: '#0e7490', shadow: 'rgba(8, 145, 178, 0.22)', gradient: 'linear-gradient(135deg, #0891b2 0%, #38bdf8 100%)' },
  { accent: '#4f46e5', soft: 'rgba(79, 70, 229, 0.12)', text: '#4338ca', shadow: 'rgba(79, 70, 229, 0.22)', gradient: 'linear-gradient(135deg, #4f46e5 0%, #8b5cf6 100%)' },
];

function agentTone(agentId: string | undefined): AgentTone {
  const key = agentId || 'unknown';
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AGENT_TONES[hash % AGENT_TONES.length] ?? AGENT_TONES[0]!;
}

function agentInitial(agentId: string | undefined) {
  const label = shortAgent(agentId ?? 'agent');
  return label.slice(0, 1).toUpperCase();
}

function sessionCssVars(sessionKey: string, color?: string): CSSProperties {
  const tone = sessionTone(sessionKey, color);
  return {
    '--session-accent': tone.accent,
    '--session-soft': tone.soft,
    '--session-shadow': tone.shadow,
  } as CSSProperties;
}

function hasTextSelectionInside(container: HTMLElement | null) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(container && anchor && focus && container.contains(anchor) && container.contains(focus));
}

function hasActiveMessageTextSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus) return false;
  return [...document.querySelectorAll<HTMLElement>('.message-selection-surface')]
    .some((surface) => surface.contains(anchor) && surface.contains(focus));
}

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

function detectStandaloneDisplayMode() {
  const standaloneNavigator = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneNavigator
    || window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches;
}

function usePwaViewportMode() {
  const [standalone, setStandalone] = useState(detectStandaloneDisplayMode);

  useEffect(() => {
    const displayQueries = [
      window.matchMedia('(display-mode: standalone)'),
      window.matchMedia('(display-mode: fullscreen)'),
      window.matchMedia('(display-mode: minimal-ui)'),
    ];

    const syncMode = () => {
      const nextStandalone = detectStandaloneDisplayMode();
      setStandalone(nextStandalone);
      document.documentElement.classList.toggle('pwa-standalone', nextStandalone);
      document.documentElement.dataset.displayMode = nextStandalone ? 'standalone' : 'browser';
    };

    const syncViewport = () => {
      const viewport = window.visualViewport;
      const layoutHeight = Math.max(
        Math.round(window.innerHeight || 0),
        Math.round(document.documentElement.clientHeight || 0),
        Math.round(viewport?.height || 0),
        320,
      );
      document.documentElement.style.setProperty('--aod-app-vh', `${layoutHeight}px`);
    };

    const syncAll = () => {
      syncMode();
      syncViewport();
    };

    syncAll();
    displayQueries.forEach((query) => query.addEventListener('change', syncMode));
    window.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('scroll', syncViewport);
    document.addEventListener('visibilitychange', syncAll);
    return () => {
      displayQueries.forEach((query) => query.removeEventListener('change', syncMode));
      window.removeEventListener('resize', syncViewport);
      window.visualViewport?.removeEventListener('resize', syncViewport);
      window.visualViewport?.removeEventListener('scroll', syncViewport);
      document.removeEventListener('visibilitychange', syncAll);
      document.documentElement.classList.remove('pwa-standalone');
      document.documentElement.dataset.displayMode = 'browser';
    };
  }, []);

  return { standalone };
}

function useAdaptiveSessionRefresh(refreshSessions: () => Promise<HubSessionsState | undefined>) {
  const refreshRef = useRef(refreshSessions);
  const controllerRef = useRef<ReturnType<typeof startLiveRefresh> | undefined>(undefined);

  useEffect(() => {
    refreshRef.current = refreshSessions;
  });

  useEffect(() => {
    const controller = startLiveRefresh(async () => {
      const result = await refreshRef.current();
      completionDelivery.flushAll();
      return result;
    }, SESSION_REFRESH_NORMAL_POLL_MS, REALTIME_SESSION_REFRESH_DEBOUNCE_MS,
      () => adaptiveHistoryRefreshInterval(visibleSessionCount(), true), false, undefined, undefined, false);
    controllerRef.current = controller;
    return () => { controller.stop(); controllerRef.current = undefined; };
  }, []);

  return {
    boost: useCallback(() => controllerRef.current?.boost(), []),
    schedule: useCallback(() => controllerRef.current?.request(), []),
    prioritize: useCallback(() => controllerRef.current?.prioritize(), []),
    complete: useCallback(() => controllerRef.current?.complete() ?? Promise.resolve(), []),
  };
}

function startLiveRefresh(refresh: (calibration?: boolean) => Promise<unknown>, fallbackMs: number | ((unchanged: number) => number), eventDelayMs: number, minIntervalMs?: () => number, alignSafety = false, sessionKey?: string, safetyMs?: () => number, pollWhileConnected = true) {
  const surfaceVisible = () => !sessionKey || isSessionVisible(sessionKey);
  const controller = createLiveRefresh({ refresh, fallbackMs, eventDelayMs, alignSafety, pollWhileConnected, ...(safetyMs ? { safetyMs } : {}),
    ...(minIntervalMs ? { minIntervalMs } : {}),
    isVisible: () => document.visibilityState !== 'hidden' && surfaceVisible(),
    isConnected: () => deckStreamConnection === 'connected' });
  let visible = surfaceVisible();
  // A geometry/notes update is not a history invalidation. Wake only a surface
  // that actually becomes visible; restoring it revalidates missed events.
  const unsubscribeVisibility = sessionKey ? subscribeVisibleSessions(() => {
    const next = surfaceVisible();
    if (next !== visible) { visible = next; controller.wake(); }
  }) : undefined;
  window.addEventListener('focus', controller.wake);
  window.addEventListener('pageshow', controller.wake);
  window.addEventListener('online', controller.wake);
  document.addEventListener('visibilitychange', controller.wake);
  streamConnectionListeners.add(controller.connectionChanged);
  controller.start();
  return { ...controller, stop() {
    controller.stop();
    window.removeEventListener('focus', controller.wake);
    window.removeEventListener('pageshow', controller.wake);
    window.removeEventListener('online', controller.wake);
    document.removeEventListener('visibilitychange', controller.wake);
    streamConnectionListeners.delete(controller.connectionChanged);
    unsubscribeVisibility?.();
  } };
}

function isMobileLikeDevice(width: number, standalone = false) {
  return shouldUseMobileShell({ width, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints || 0, standalone });
}

function useMessageMetadataCatchup(session: SessionSummary | undefined, controller: { current: ReturnType<typeof startLiveRefresh> | undefined }) {
  const previous = useRef(session);
  useEffect(() => {
    const before = previous.current;
    previous.current = session;
    // Initial mount/session switch already owns an immediate history read.
    if (!before || !session || before === session || before.sessionKey !== session.sessionKey) return;
    if (sessionRunOutcome(session) && (before.runtime?.phase !== session.runtime?.phase
      || before.runtime?.turnId !== session.runtime?.turnId || before.runCompletedAt !== session.runCompletedAt)) controller.current?.boost();
    else controller.current?.request();
  }, [session?.sessionKey, session?.runtime?.phase, session?.runtime?.turnId, session?.runtime?.sync, session?.runCompletedAt]);
}

// Normal shallow comparison: metadata, active state and new callbacks must all
// propagate. Never omit execution/permission fields with a custom comparator.
const DesktopSessionPane = memo(function DesktopSessionPane({ session, active, refreshToken, onChanged, onRenamed, onDeleted, onVisibilityChanged }: { session: SessionSummary; active: boolean; refreshToken: number; onChanged: () => void; onRenamed: (session: SessionEdit) => Promise<void> | void; onDeleted: (key: string) => void; onVisibilityChanged: (key: string, hidden: boolean) => void }) {
  const { t } = useI18n();
  const latestSession = useRef(session);
  const messageLiveRefresh = useRef<ReturnType<typeof startLiveRefresh> | undefined>(undefined);
  latestSession.current = session;
  const stoppingRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [controlError, setControlError] = useState<string>();
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const selected = session;
  const selectedKey = session.sessionKey;
  const selectedKeyRef = useRef<string | undefined>(selectedKey);
  const paneRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [messageState, setMessageState] = useState<MessageState>(() => messageStateForSession(selectedKey, MESSAGE_DESKTOP_INITIAL_LOAD_LIMIT));
  const [readHealth, setReadHealth] = useState(healthyRead);
  const hasVisibleMessages = useRef(false);
  hasVisibleMessages.current = messageState.items.length > 0;
  const [olderError, setOlderError] = useState<string>();
  const error = readHealth.severity === 'error' ? readHealth.detail : undefined;
  const messageLimitRef = useRef(MESSAGE_DESKTOP_INITIAL_LOAD_LIMIT);
  const messageRevisionRef = useRef<Record<string, string | undefined>>({});
  const messageRequests = useMessageSnapshotRequestGate(selectedKeyRef);
  const { readLatestMessages, isHistoryCached, cachedHistory, refreshing: messagesRefreshing } = useLatestMessages(selectedKey, messageState.items.length > 0,
    () => activeRef.current ? 0 : isSessionVisible(selectedKey) ? 1 : 2);
  async function refreshSelectedMessagesNow(sessionKey = selectedKey, options: { force?: boolean } = {}) {
    if (!mounted.current || !sessionKey) return;
    const currentRequest = messageRequests.begin(sessionKey);
    if (!currentRequest()) return;
    const limit = messageLimitRef.current;
    setMessageState((current) => current.sessionKey === sessionKey
      ? { ...current, loading: current.items.length === 0 }
      : current.sessionKey === undefined
        ? { sessionKey, items: [], loading: true }
        : current);
    try {
      const data = await readLatestMessages(sessionKey, limit, options.force === true);
      if (!mounted.current || !acceptMessagePage(currentRequest, data)) return;
      setReadHealth(data.historyStatus === 'cached' ? { failures: 0, severity: 'warning', detail: t('Showing saved messages while history is verified.') } : healthyRead);
      const revisionKey = `${sessionKey}:${limit}`;
      const unchanged = !options.force && data.revision && messageRevisionRef.current[revisionKey] === data.revision;
      if (!unchanged && data.historyStatus !== 'cached') cacheServerMessages(sessionKey, data);
      if (data.revision) messageRevisionRef.current[revisionKey] = data.revision;
      setMessageState((current) => {
        if (current.sessionKey !== sessionKey && current.sessionKey !== undefined) return current;
        if (!options.force && hasMessageSnapshotRevision(current, sessionKey, limit, data.revision)) return { ...current, loading: false, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
        return { ...current, sessionKey, ...refreshHistory(current, data), revision: data.revision, loading: false, loadedLimit: limit, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
      });
    } catch (cause) {
      if (mounted.current && currentRequest()) {
        setReadHealth(previous => failedRead(previous, cause, messageState.items.length > 0, options.force));
        setMessageState(current => ({ ...current, loading: false }));
      }
      throw cause;
    }
  }

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const sessionKey = selected.sessionKey;
    let appliedCursor: string | undefined;
    const unregisterCompletionView = registerCompletionView(sessionKey, cursor =>
      !isSessionVisible(sessionKey) || messageRequests.isCaughtUp() && completionHistoryCurrent(cursor, appliedCursor) && completionMetadataCurrent(latestSession.current));
    const messageRefresh = createQueuedRefresh(async (calibration) => {
      if (cancelled) return;
      const currentRequest = messageRequests.begin(sessionKey);
      if (!currentRequest()) return;
      setMessageState((current) => current.sessionKey === sessionKey
        ? { ...current, loading: current.items.length === 0 }
        : current.sessionKey === undefined
          ? { sessionKey, items: [], loading: true }
          : current);
      try {
        const limit = messageLimitRef.current;
        const data = await readLatestMessages(sessionKey, limit, false, calibration);
        if (cancelled || !acceptMessagePage(currentRequest, data)) return;
        appliedCursor = data.historyStatus === 'cached' ? undefined : data.sourceCursor;
        setReadHealth(data.historyStatus === 'cached' ? { failures: 0, severity: 'warning', detail: t('Showing saved messages while history is verified.') } : healthyRead);
        const revisionKey = `${sessionKey}:${limit}`;
        const unchanged = data.revision && messageRevisionRef.current[revisionKey] === data.revision;
        const preserveSelection = hasTextSelectionInside(paneRef.current);
        if (!unchanged && !preserveSelection && data.historyStatus !== 'cached') cacheServerMessages(sessionKey, data);
        if (data.revision && !preserveSelection) messageRevisionRef.current[revisionKey] = data.revision;
        if (!cancelled) setMessageState((current) => {
          if (current.sessionKey !== sessionKey && current.sessionKey !== undefined) return current;
          if (hasMessageSnapshotRevision(current, sessionKey, limit, data.revision)) return { ...current, loading: false, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
          const history = refreshHistory(current, data);
          return { ...current, sessionKey, ...history, items: preserveSelection ? mergeSelectionSafeMessages(current.items, history.items) : history.items,
            revision: preserveSelection ? undefined : data.revision, loading: false, loadedLimit: limit, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
        });
        if (data.historyStatus !== 'cached') void completionDelivery.flush(sessionKey, []);
        return { changed: !unchanged };
      } catch (err) {
        if (!cancelled && currentRequest()) {
        setReadHealth(previous => failedRead(previous, err, hasVisibleMessages.current));
          setMessageState((current) => current.sessionKey === sessionKey ? { ...current, loading: false } : current);
        }
        throw err;
      }
    });
    const refreshMessages = (calibration?: boolean) => messageRefresh.run(calibration);
    const liveRefresh = startLiveRefresh(refreshMessages, unchanged => historyFallbackInterval(latestSession.current, unchanged, requestGovernor.intervalMultiplier()), REALTIME_MESSAGE_REFRESH_DEBOUNCE_MS,
      () => adaptiveHistoryRefreshInterval(visibleSessionCount(), activeRef.current), true, sessionKey,
      () => adaptiveActiveSessionSafetyInterval(visibleSessionCount(), activeRef.current, isHistoryCached() || hasQueueBlockingRun(latestSession.current) || hasOptimisticActiveSend(latestSession.current, false, readOptimisticMessages<ChatMessage>(recoveryScope(), sessionKey))));
    messageLiveRefresh.current = liveRefresh;
    const scheduleRefreshMessages = liveRefresh.request;
    const unsubscribeCatchup = messageRequests.subscribe(scheduleRefreshMessages);
    const events = openDeckEventStream((event) => {
      if (!shouldRefreshMessagesForEvent(event, sessionKey)) return;
      if (event.type === 'stream.reset') messageRequests.invalidate();
      const changed = messageRequests.observe(event.remoteEventId, sessionKey);
      if (changed && isCompletionRefreshEvent(event)) return liveRefresh.complete();
      if (changed && isStreamCatchup(event)) return liveRefresh.prioritize();
      if (changed) scheduleRefreshMessages();
    });
    let hadSelection = hasTextSelectionInside(paneRef.current);
    const onSelectionChange = () => {
      const hasSelection = hasTextSelectionInside(paneRef.current);
      if (hadSelection && !hasSelection) scheduleRefreshMessages();
      hadSelection = hasSelection;
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      cancelled = true;
      unregisterCompletionView();
      messageRequests.invalidate();
      unsubscribeCatchup();
      document.removeEventListener('selectionchange', onSelectionChange);
      liveRefresh.stop();
      if (messageLiveRefresh.current === liveRefresh) messageLiveRefresh.current = undefined;
      events?.close();
    };
  }, [selected?.sessionKey]);

  // Metadata/completion can arrive even when the message invalidation was lost.
  // Do not wait for the next minute calibration to reveal the final response.
  useMessageMetadataCatchup(session, messageLiveRefresh);

  const previouslyActive = useRef(active);
  useEffect(() => {
    if (active && !previouslyActive.current) messageLiveRefresh.current?.wake();
    previouslyActive.current = active;
  }, [active]);

  async function loadMoreHistory(schedule?: HistoryReadSchedule, signal?: AbortSignal): Promise<HistoryBackfillOutcome> {
    if (!selected) return;
    const sessionKey = selected.sessionKey;
    const currentState = messageState.sessionKey === sessionKey ? messageState : undefined;
    if (!currentState || currentState.historyLoading || (currentState.hiddenCount ?? 0) <= 0) return;
    const before = currentState.items[0]?.id;
    if (!before) return;
    if (!mounted.current || selectedKeyRef.current !== sessionKey) return 'superseded';
    setMessageState((current) => current.sessionKey === sessionKey ? { ...current, historyLoading: true } : current);
    try {
      const data = await api.sessionMessages(sessionKey, MESSAGE_HISTORY_PAGE_SIZE, signal, before, false, schedule);
      if (!mounted.current || selectedKeyRef.current !== sessionKey) return 'superseded';
      setOlderError(undefined);
      setMessageState((current) => current.sessionKey === sessionKey ? { ...current, ...prependHistory(current.items, data, before), historyLoading: false } : current);
    } catch (err) {
      if (signal?.aborted || !mounted.current) return;
      // Stream-open may invalidate queued transport before it reaches the wire.
      // The caller can retry a superseded read, but never accept its old data.
      if (signal?.aborted) return;
      if (selectedKeyRef.current !== sessionKey || isCancelledRead(err)) return 'superseded';
      setOlderError(err instanceof Error ? err.message : String(err));
      setMessageState((current) => current.sessionKey === sessionKey ? { ...current, historyLoading: false } : current);
      return 'retryable-error';
    } finally {
      setMessageState((current) => current.sessionKey === sessionKey ? { ...current, historyLoading: false } : current);
    }
  }

  const previousRefresh = useRef(refreshToken);
  useEffect(() => {
    if (previousRefresh.current === refreshToken) return;
    previousRefresh.current = refreshToken;
    void refreshSelectedMessagesNow(selectedKey, { force: true }).catch(() => { /* Current request owns its health result. */ });
  }, [refreshToken]);
  async function stopConfirmedRun() {
    const target = latestSession.current;
    const turnId = target.runtime?.turnId;
    if (stoppingRef.current || sessionAddress(target.sessionKey).shared || !turnId || !isSessionBusy(target) || target.runtime?.stopRequested) return;
    stoppingRef.current = true;
    setStopping(true);
    setControlError(undefined);
    try {
      if (!await confirmAction({ title: t('Stop this run?'), description: t('Only this run will be stopped. Queued messages and other sessions are kept.'), confirmLabel: t('Stop current run') })) return;
      if (!mounted.current || latestSession.current.sessionKey !== target.sessionKey) return;
      if (latestSession.current.runtime?.turnId !== turnId || !isSessionBusy(latestSession.current)) throw new Error(t('The run changed. Refresh before stopping.'));
      // The server also receives the exact run fence. A race after confirmation
      // must reject, never stop a newer run. Existing durable receipt recovery
      // handles an unknown response without resubmitting the stop command.
      await sendMessageWithRecovery(target.sessionKey, '/stop', 'web-only', [], newCommandKey(), turnId);
      onChanged();
      await refreshSelectedMessagesNow(target.sessionKey);
    } catch (cause) { if (mounted.current) setControlError(cause instanceof CommandOutcomeUnknownError ? undefined : cause instanceof Error ? cause.message : String(cause)); }
    finally { stoppingRef.current = false; if (mounted.current) setStopping(false); }
  }
  return <div ref={paneRef} className="session-pane-controller" data-session-pane={selectedKey}>
    <PaneToolbar>
      <button type="button" aria-label={t('Force refresh messages')} title={t('Force refresh messages')} disabled={manualRefreshing} onClick={() => {
        setManualRefreshing(true);
        void refreshSelectedMessagesNow(selectedKey, { force: true }).catch(() => { /* Current request owns its health result. */ }).finally(() => { if (mounted.current) setManualRefreshing(false); });
      }}><RefreshCcw size={13} className={manualRefreshing ? 'animate-spin' : undefined} /></button>
      <button type="button" className="pane-emergency-stop" aria-label={t('Stop current run')} title={t(session.runtime?.turnId ? 'Stop current run' : 'Stop unavailable until the current run is confirmed')}
        disabled={stopping || sessionAddress(session.sessionKey).shared || !isSessionBusy(session) || !session.runtime?.turnId || session.runtime?.stopRequested} onClick={() => void stopConfirmedRun()}><Power size={13} /></button>
    </PaneToolbar>
    {readHealth.severity === 'warning' || olderError ? <PaneStatusControls><PaneStatus label={olderError ? 'Older messages unavailable' : 'Latest messages temporarily unavailable'} state="warning">
      {readHealth.severity === 'warning' ? <HistorySyncIssue label="Latest messages temporarily unavailable" detail={readHealth.detail} onRetry={() => refreshSelectedMessagesNow(selectedKey, { force: true })} /> : null}
      {olderError ? <HistorySyncIssue label="Older messages unavailable" detail={olderError} onRetry={async () => { await loadMoreHistory(); }} /> : null}
    </PaneStatus></PaneStatusControls> : null}
    {controlError ? <div className="pane-control-error" role="alert"><span>{controlError}</span><button type="button" aria-label={t('Dismiss')} onClick={() => setControlError(undefined)}><X size={13} /></button></div> : null}
    <DesktopChatPanel session={session} active={active} syncError={error} onRetrySync={() => refreshSelectedMessagesNow(selectedKey, { force: true })} messages={messageState.items} maxMessageChars={messageState.maxMessageChars}
      serverHiddenCount={messageState.hiddenCount} messagesLoading={Boolean(messageState.loading)} messagesRefreshing={messagesRefreshing || cachedHistory}
      historyLoading={Boolean(messageState.historyLoading)} onLoadMoreHistory={loadMoreHistory} onRenamed={onRenamed}
      onSent={async () => { onChanged(); messageLiveRefresh.current?.boost(); await refreshSelectedMessagesNow(selectedKey, { force: true }); }}
      onDeleted={() => onDeleted(selectedKey)} onVisibilityChanged={hidden => onVisibilityChanged(selectedKey, hidden)} />
  </div>;
});

function DesktopWorkspace({ viewportWidth }: { viewportWidth: number }) {
  const { t: tr } = useI18n();
  const workspace = useWorkspacePreferences();
  const [tab, setTabState] = useState<Tab>(() => readHashRoute().tab ?? 'sessions');
  const [sessionsState, setSessionsState] = useState<HubSessionsState>(initialSessionsState);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [gateway, setGateway] = useState<GatewayHealth>();
  const [selectedKey, setSelectedKeyState] = useState<string | undefined>(() => readHashRoute().sessionKey);
  const selectedKeyRef = useRef(selectedKey);
  const openPaneKeys = useRef<string[]>([]);
  const rememberOpenPanes = useCallback((keys: string[]) => { openPaneKeys.current = keys; }, []);
  const setSelectedKey = useCallback((key: string | undefined) => { selectedKeyRef.current = key; setSelectedKeyState(key); }, []);
  const [refreshToken, setRefreshToken] = useState(0);
  const [dismissedPanes, setDismissedPanes] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionGroupId, setNewSessionGroupId] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [envFilter, setEnvFilter] = useState<string>('all'); // 'all' | 'local' | 'remote' | connectionId
  const [showHiddenSessions, setShowHiddenSessions] = useState(false);
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [sessionListContextMenu, setSessionListContextMenu] = useState<SessionListContextMenuState>();
  const [modelSessionKey, setModelSessionKey] = useState<string>();
  const closeModelSession = useCallback(() => setModelSessionKey(undefined), []);
  const [quickMessageSession, setQuickMessageSession] = useState<SessionSummary>();
  const closeQuickMessage = useCallback(() => setQuickMessageSession(undefined), []);
  const [sessionActionSavingKey, setSessionActionSavingKey] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const sessionRail = useSessionRail(viewportWidth);
  const railReveal = useHoverReveal(tab === 'sessions' && sessionRail.collapsed);
  const deferredSessionSearch = useDeferredValue(sessionSearch);
  const sessionsRevisionRef = useRef<string | undefined>(sessionsState.revision);
  const sessionRequests = useSnapshotRequestGate();
  const sessionSourcesRef = useRef(sessionsState.sourceStates);
  const selectedSessionSnapshotsRef = useRef<Record<string, SessionSummary>>({});
  const committedSessionsRef = useRef<readonly SessionSummary[]>([]);

  const allSessions = useMemo(
    () => sortPinnedSessions(sessionsState.groups.flatMap((group) => group.sessions)),
    [sessionsState.groups],
  );
  /** Sessions after env filter is applied. */
  const envFilteredSessions = useMemo(() => {
    if (envFilter === 'all') return allSessions;
    if (envFilter === 'local') return allSessions.filter((s) => {
      const id = (s as SessionSummary & { envConnectionId?: string }).envConnectionId;
      return !id || id === 'local';
    });
    if (envFilter === 'remote') return allSessions.filter((s) => {
      const id = (s as SessionSummary & { envConnectionId?: string }).envConnectionId;
      return id && id !== 'local';
    });
    return allSessions.filter((s) => {
      const id = (s as SessionSummary & { envConnectionId?: string }).envConnectionId;
      return id === envFilter;
    });
  }, [allSessions, envFilter]);
  const filteredSessions = useMemo(() => envFilteredSessions.filter((session) => matchesSessionSearch(session, deferredSessionSearch)), [envFilteredSessions, deferredSessionSearch]);
  /** Distinct concrete environment connection IDs shown as filter chips. */
  const envOptions = useMemo((): Array<{ id: string; label: string; kind: 'local' | 'remote' }> => {
    const seen = new Map<string, { label: string; kind: 'local' | 'remote' }>();
    for (const s of allSessions) {
      const connId = (s as SessionSummary & { envConnectionId?: string }).envConnectionId;
      const connLabel = (s as SessionSummary & { envConnectionLabel?: string }).envConnectionLabel;
      if (!connId || seen.has(connId)) continue;
      const isLocal = connId === 'local' || !connId;
      seen.set(connId, { label: connLabel ?? connId, kind: isLocal ? 'local' : 'remote' });
    }
    for (const connection of sessionsState.connections ?? []) {
      if (seen.has(connection.id) || connection.status === 'disabled') continue;
      const isLocal = connection.id === 'local' || connection.kind === 'local';
      seen.set(connection.id, { label: connection.label ?? connection.environmentLabel ?? connection.id, kind: isLocal ? 'local' : 'remote' });
    }
    return [...seen.entries()].map(([id, meta]) => ({ id, ...meta }));
  }, [allSessions, sessionsState.connections]);
  useLayoutEffect(() => {
    // Event-time lookup contains the latest committed summaries, not speculative
    // render data. Closing a pane need not change every sibling's callback when
    // one summary changes. O(1) here; snapshot indexing stays in a passive effect.
    committedSessionsRef.current = allSessions;
  }, [allSessions]);
  useEffect(() => {
    const snapshots = selectedSessionSnapshotsRef.current;
    for (const session of allSessions) snapshots[session.sessionKey] = session;
  }, [allSessions]);
  const hasMultipleEnvs = envOptions.length > 1;
  const selected = useMemo(() => {
    if (!selectedKey) return undefined;
    return allSessions.find((session) => session.sessionKey === selectedKey) ?? selectedSessionSnapshotsRef.current[selectedKey];
  }, [allSessions, selectedKey]);
  const now = useTicker(60_000);
  useHotSessionPreload({ sessions: allSessions, activeSessionKey: selectedKey, openSessionKeys: openPaneKeys.current, mobile: false, initialMessageLimit: MESSAGE_DESKTOP_INITIAL_LOAD_LIMIT });

  function setTab(nextTab: Tab) {
    setTabState(nextTab);
    if (nextTab !== 'sessions') {
      setSelectedKey(undefined);
      writeHashRoute({ tab: nextTab });
    } else {
      writeHashRoute({ tab: nextTab });
    }
  }

  const activateSession = useCallback((session: SessionSummary | undefined) => {
    if (session) selectedSessionSnapshotsRef.current[session.sessionKey] = session;
    recordSessionAccess(session?.sessionKey);
    markSessionMessagesSeen(session);
    if (session) setDismissedPanes(current => { if (!current.has(session.sessionKey)) return current; const next = new Set(current); next.delete(session.sessionKey); return next; });
    setSelectedKey(session?.sessionKey);
    setTabState('sessions');
  }, [setSelectedKey]);

  const selectSession = useCallback((session: SessionSummary | undefined) => {
    activateSession(session);
    writeHashRoute({ tab: 'sessions' });
  }, [activateSession]);

  const dismissSessionView = useCallback((key: string) => {
    setDismissedPanes(current => new Set(current).add(key));
    delete selectedSessionSnapshotsRef.current[key];
    if (selectedKeyRef.current !== key) return;
    const nextKey = openPaneKeys.current.find(candidate => candidate !== key && !dismissedPanes.has(candidate));
    const next = nextKey ? committedSessionsRef.current.find(session => session.sessionKey === nextKey) ?? selectedSessionSnapshotsRef.current[nextKey] : undefined;
    selectSession(next);
  }, [dismissedPanes, selectSession]);

  const refresh = useCallback(async () => {
    const currentRequest = sessionRequests.begin();
    setError(undefined);
    try {
      const [snapshot, agentData, gatewayData] = await Promise.all([
        api.sessionsState({ includeHidden: showHiddenSessions, includeArchived: showArchivedSessions }),
        api.agents(METADATA_MAX_AGE_MS).catch(() => undefined),
        api.gatewayStatus(METADATA_MAX_AGE_MS).catch(() => undefined),
      ]);
      const sessionData = currentRequest.accept(snapshot);
      if (!sessionData) return undefined;
      completionNotification.seed(sessionData.groups.flatMap(group => group.sessions));
      const activeSessionKey = selectedKeyRef.current;
      const invalidNodes = invalidatedSessionNodes(sessionSourcesRef.current, sessionData.sourceStates, activeSessionKey);
      sessionSourcesRef.current = sessionData.sourceStates;
      clearCachedNodeData(invalidNodes);
      if (invalidNodes.size) setDismissedPanes(current => new Set([...current, ...Object.keys(selectedSessionSnapshotsRef.current).filter(key => invalidNodes.has(key.split(':')[0]!))]));
      for (const key of Object.keys(selectedSessionSnapshotsRef.current)) {
        if (invalidNodes.has(key.split(':')[0]!)) delete selectedSessionSnapshotsRef.current[key];
      }
      if (activeSessionKey && invalidNodes.has(activeSessionKey.split(':')[0]!)) {
        setSelectedKey(undefined);
        writeHashRoute({ tab: 'sessions' });
        setError('Node access changed. Reopen the session after access is restored.');
      }
      if (!sessionData.revision || sessionData.revision !== sessionsRevisionRef.current) {
        sessionsRevisionRef.current = sessionData.revision;
        setSessionsState(current => {
          let next = shareSessionSummaries(current, sessionData);
          const activeSnapshot = activeSessionKey ? selectedSessionSnapshotsRef.current[activeSessionKey] : undefined;
          if (activeSnapshot && !findSessionByKey(next, activeSnapshot.sessionKey)) next = ensureSessionInState(next, activeSnapshot);
          return next;
        });
        if (!showHiddenSessions && !showArchivedSessions) writeCachedSessionsState(sessionData);
      }
      if (agentData) setAgents(agentData.agents);
      if (gatewayData) setGateway(gatewayData);
      setNewSessionGroupId((current) => current || defaultCreateGroupId(sessionData, agentData?.agents ?? agents, gatewayData ?? gateway));
      // Connector-backed session lists can be temporarily incomplete while the Hub
      // refreshes fan-in state. Do not clear the active detail pane just because
      // one sessions/state response omitted the selected row: the messages endpoint
      // can still be healthy, and explicit hide/delete handlers clear selection
      // themselves. Keeping a snapshot prevents the right pane from flashing back
      // to the empty "Select or create a session" state during transient polls.
      return sessionData;
    } catch (err) {
      if (currentRequest()) setError(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }, [sessionRequests, showHiddenSessions, showArchivedSessions, setSelectedKey]);

  const { boost: boostSessionRefresh, schedule: scheduleSessionRefresh, prioritize: prioritizeSessionRefresh, complete: completeSessionRefresh } = useAdaptiveSessionRefresh(refresh);

  useEffect(() => {
    const onSessionHandoff = (event: Event) => {
      const detail = (event as CustomEvent<{ fromSessionKey: string; toSessionKey: string; session: SessionSummary; replaceSourcePane?: boolean }>).detail;
      if (!detail?.toSessionKey || !detail.session) return;
      selectedSessionSnapshotsRef.current[detail.toSessionKey] = detail.session;
      setDismissedPanes((current) => {
        if (!current.has(detail.toSessionKey)) return current;
        const next = new Set(current);
        next.delete(detail.toSessionKey);
        return next;
      });
      setSessionsState((current) => ensureSessionInState(current, detail.session));
      selectSession(detail.session);
      prioritizeSessionRefresh();
    };
    window.addEventListener('agentopsdeck:session-handoff', onSessionHandoff);
    return () => window.removeEventListener('agentopsdeck:session-handoff', onSessionHandoff);
  }, [selectSession, prioritizeSessionRefresh]);

  async function setSessionHiddenFromList(session: SessionSummary, hidden: boolean) {
    if (sessionActionSavingKey) return;
    setSessionActionSavingKey(session.sessionKey);
    setSessionListContextMenu(undefined);
    setError(undefined);
    try {
      await api.hideSession(session.sessionKey, hidden);
      setSessionsState((current) => {
        const next = updateSessionHiddenInState(current, session.sessionKey, hidden, showHiddenSessions);
        if (!showHiddenSessions && !showArchivedSessions) writeCachedSessionsState(next);
        return next;
      });
      if (hidden && !showHiddenSessions) dismissSessionView(session.sessionKey);
      boostSessionRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionActionSavingKey(undefined);
    }
  }

  async function setSessionArchivedFromList(session: SessionSummary, archived: boolean) {
    if (sessionActionSavingKey) return;
    setSessionActionSavingKey(session.sessionKey);
    setSessionListContextMenu(undefined);
    setError(undefined);
    try {
      await api.archiveSession(session.sessionKey, archived);
      setSessionsState((current) => {
        const next = updateSessionArchivedInState(current, session.sessionKey, archived, showArchivedSessions);
        if (!showHiddenSessions && !showArchivedSessions) writeCachedSessionsState(next);
        return next;
      });
      if (archived && !showArchivedSessions) dismissSessionView(session.sessionKey);
      boostSessionRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionActionSavingKey(undefined);
    }
  }

  async function setSessionPinnedFromList(session: SessionSummary, pinned: boolean) {
    if (sessionActionSavingKey) return;
    setSessionActionSavingKey(session.sessionKey);
    setSessionListContextMenu(undefined);
    setError(undefined);
    try {
      await api.pinSession(session.sessionKey, pinned);
      setSessionsState((current) => {
        const next = updateSessionPinnedInState(current, session.sessionKey, pinned);
        if (!showHiddenSessions && !showArchivedSessions) writeCachedSessionsState(next);
        return next;
      });
      boostSessionRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionActionSavingKey(undefined);
    }
  }

  async function deleteSessionFromList(session: SessionSummary) {
    if (sessionActionSavingKey || !sessionRuntimeUi(session).deleteSession) return;
    if (!await confirmAction(sessionDeletionConfirmation(displayTitle(session), session.source === 'hermes'))) return;
    setSessionActionSavingKey(session.sessionKey);
    setSessionListContextMenu(undefined);
    setError(undefined);
    try {
      await deleteSessionWithRecovery(session.sessionKey);
      clearCachedMessages(session.sessionKey);
      dismissSessionView(session.sessionKey);
      setSessionsState((current) => removeSessionFromState(current, session.sessionKey));
      boostSessionRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionActionSavingKey(undefined);
    }
  }

  const applyRenamedSession = useCallback((renamedSession: SessionEdit) => {
    if ('settings' in renamedSession) { boostSessionRefresh(); return; }
    setSessionsState((current) => {
      const next = applySessionEditInState(current, renamedSession);
      if (!showHiddenSessions && !showArchivedSessions) writeCachedSessionsState(next);
      return next;
    });
    boostSessionRefresh();
  }, [showHiddenSessions, showArchivedSessions, boostSessionRefresh]);

  const onPaneVisibilityChanged = useCallback((key: string, hidden: boolean) => {
    if (hidden && !showHiddenSessions) dismissSessionView(key);
    void refresh();
  }, [showHiddenSessions, dismissSessionView, refresh]);
  const onPaneDeleted = useCallback((key: string) => {
    clearCachedMessages(key);
    dismissSessionView(key);
    void refresh();
  }, [dismissSessionView, refresh]);
  const activePaneKey = selected?.sessionKey;
  const renderSessionPane = useCallback((session: SessionSummary) => <DesktopSessionPane
    key={session.sessionKey} session={session} active={activePaneKey === session.sessionKey}
    refreshToken={refreshToken} onChanged={boostSessionRefresh} onRenamed={applyRenamedSession}
    onVisibilityChanged={onPaneVisibilityChanged} onDeleted={onPaneDeleted} />,
  [activePaneKey, refreshToken, boostSessionRefresh, applyRenamedSession, onPaneVisibilityChanged, onPaneDeleted]);

  useEffect(() => {
    void refresh();
  }, [showHiddenSessions, showArchivedSessions]);

  useEffect(() => {
    if (!sessionListContextMenu) return;
    const close = () => setSessionListContextMenu(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sessionListContextMenu]);

  useEffect(() => {
    if (sessionListContextMenu && !allSessions.some((session) => session.sessionKey === sessionListContextMenu.session.sessionKey)) setSessionListContextMenu(undefined);
    if (modelSessionKey && !allSessions.some(session => session.sessionKey === modelSessionKey)) closeModelSession();
  }, [allSessions, sessionListContextMenu, modelSessionKey, closeModelSession]);

  useEffect(() => {
    if (selected) markSessionMessagesSeen(selected);
  }, [selected?.sessionKey, selected?.runCompletedAt]);

  async function createSession(target: NewSessionTarget, label = 'New web session') {
    const agentId = target.ownerUserId ? 'codex' : target.agentId;
    await createSessionForAgent(agentId, label, target.connectionId, target.ownerUserId);
  }

  useRetireOpenedCreation(selected?.sessionKey);

  async function createSessionForAgent(agentId: string, label = `New ${shortAgent(agentId)} session`, connectionId = 'local', ownerUserId?: string) {
    if (creatingSession) return;
    setError(undefined);
    setCreatingSession(true);
    const scope = recoveryScope();
    try {
      const title = label.trim() || `New ${shortAgent(agentId)} session`;
      await createSessionWithRecovery({ agentId, connectionId, ...(ownerUserId ? { ownerUserId } : {}) }, title, async (created) => {
        if (ownerUserId) {
          if (recoveryScope() === scope) window.location.hash = `#/session/${encodeURIComponent(sessionAddress({ ownerUserId, sessionId: created.key }).key)}`;
          return;
        }
        // Admission is already confirmed. A failed projection read must not
        // turn it into a creation failure or authorize another native create.
        const sessionData = await refresh().catch(() => sessionsState);
        if (recoveryScope() !== scope) return;
        const session = findSessionByKey(sessionData, created.key) ?? newSessionSummary(created.key, agentId, title, connectionForId(sessionsState, connectionId));
        setSessionsState((current) => ensureSessionInState(current, session));
        selectSession(session);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSession(false);
    }
  }

  useEffect(() => {
    const scheduleRefresh = scheduleSessionRefresh;
    const unsubscribeCatchup = sessionRequests.subscribe(scheduleRefresh);
    scheduleRefresh();
    const events = openDeckEventStream((event) => {
      if (event.type === 'stream.reset') sessionRequests.invalidate(event.envConnectionId);
      if (shouldRefreshSessionsForEvent(event) && sessionRequests.observe(event.envConnectionId, event.remoteEventId)) {
        if (isCompletionRefreshEvent(event)) return completeSessionRefresh();
        if (isStreamCatchup(event) || event.type === 'queued_message.sent') return prioritizeSessionRefresh();
        scheduleRefresh();
      }
    });
    const onHashChange = () => {
      const route = readHashRoute();
      if (route.sessionKey) {
        setSelectedKey(route.sessionKey);
        setTabState('sessions');
        writeHashRoute({ tab: 'sessions' });
      } else if (route.tab) {
        setTabState(route.tab);
        setSelectedKey(undefined);
      } else {
        setTabState('sessions');
        setSelectedKey(undefined);
      }
      void refresh();
    };
    window.addEventListener('hashchange', onHashChange);
    const initialRoute = readHashRoute();
    if (initialRoute.sessionKey) {
      writeHashRoute({ tab: 'sessions' });
    }
    return () => {
      sessionRequests.invalidate();
      unsubscribeCatchup();
      events?.close();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [showHiddenSessions, showArchivedSessions]);


  const navItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={20} /> },
    { id: 'sessions', label: 'Sessions', icon: <NavIcon name="messages" /> },
    { id: 'agents', label: 'Agents', icon: <NavIcon name="agents" /> },
    { id: 'media', label: 'Media', icon: <Film size={20} /> },
    { id: 'channels', label: 'Channels', icon: <NavIcon name="ops" /> },
    { id: 'gateway', label: 'Gateway', icon: <NavIcon name="gateway" /> },
    { id: 'users', label: 'Users', icon: <UserCog size={20} /> },
  ];

  const hideRailForFocusedPage = tab === 'media' || tab === 'gateway' || tab === 'users' || tab === 'channels';
  const railCollapsedForLayout = tab === 'sessions' && sessionRail.collapsed || hideRailForFocusedPage;
  const railHidden = railCollapsedForLayout && !railReveal.open;
  const navWidth = sessionRail.navigationCollapsed ? 28 : navigationRailWidth(viewportWidth);

  return <div className={cn(
    'desktop-workspace-shell fixed inset-0 grid min-w-0 overflow-hidden bg-slate-950 text-slate-950 xl:grid-cols-[80px_minmax(270px,330px)_minmax(0,1fr)]',
    railCollapsedForLayout ? 'grid-cols-[56px_0px_minmax(0,1fr)] md:grid-cols-[60px_0px_minmax(0,1fr)] xl:grid-cols-[80px_0px_minmax(0,1fr)]' : tab === 'sessions' ? 'grid-cols-[56px_minmax(151px,190px)_minmax(0,1fr)] md:grid-cols-[60px_minmax(167px,201px)_minmax(0,1fr)] xl:grid-cols-[80px_minmax(238px,290px)_minmax(0,1fr)]' : 'grid-cols-[56px_minmax(172px,216px)_minmax(0,1fr)] md:grid-cols-[60px_minmax(190px,228px)_minmax(0,1fr)] xl:grid-cols-[80px_minmax(270px,330px)_minmax(0,1fr)]',
  )} style={{ gridTemplateColumns: `${navWidth}px ${railCollapsedForLayout ? '0px' : tab === 'sessions' ? `${sessionRail.width}px` : 'minmax(172px,290px)'} minmax(0,1fr)` }}>
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_13%_11%,rgba(37,99,235,0.32),transparent_30rem),radial-gradient(circle_at_78%_18%,rgba(34,211,238,0.20),transparent_28rem),linear-gradient(135deg,#eff6ff_0%,#f8fafc_42%,#e0f2fe_100%)]" aria-hidden="true" />
    <div className="aod-ambient-orb aod-ambient-orb-top" aria-hidden="true" />
    <div className="aod-ambient-orb aod-ambient-orb-bottom" aria-hidden="true" />
    {error ? <div className="absolute left-1/2 top-4 z-50 max-w-xl -translate-x-1/2 rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm font-medium text-red-700   ">{error}</div> : null}

    <aside data-minimized={sessionRail.navigationCollapsed} className="primary-navigation relative z-10 flex min-h-0 flex-col items-center gap-3 border-r border-white/55 bg-white/35 px-1.5 py-4 md:gap-3 md:px-1.5 md:py-4 xl:gap-5 xl:px-3 xl:py-5" aria-label={tr("Primary navigation")}>
      <button type="button" className="primary-navigation-toggle" onClick={() => sessionRail.setNavigationCollapsed(!sessionRail.navigationCollapsed)} aria-expanded={!sessionRail.navigationCollapsed} aria-label={tr(sessionRail.navigationCollapsed ? 'Expand navigation' : 'Minimize navigation')} title={tr(sessionRail.navigationCollapsed ? 'Expand navigation' : 'Minimize navigation')}>{sessionRail.navigationCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
      <GlobalRefreshButton />
      <div className="primary-navigation-content">
      <button className="aod-blue-gradient grid h-10 w-10 place-items-center rounded-[1.15rem] text-base font-black text-white ring-1 ring-white/40 transition hover:scale-[1.03] active:scale-[0.98] xl:h-12 xl:w-12 xl:rounded-[1.35rem] xl:text-lg" onClick={() => setTab('dashboard')} aria-label={tr("Home dashboard")}>C</button>
      <nav className="grid w-full gap-2.5 xl:gap-3" aria-label={tr("Sections")}>
        {navItems.map((item) => <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-10 w-10 rounded-[1.05rem] text-slate-500 hover:bg-white/70 hover:text-blue-700 hover:shadow-lg hover: xl:h-12 xl:w-12 xl:rounded-[1.15rem]',
            tab === item.id && 'aod-blue-gradient text-white shadow-xl hover:text-white',
          )}
          onClick={() => setTab(item.id)}
          aria-label={tr(navLabel(item.id))}
          key={item.id}
        >{item.icon}</Button>)}
      </nav>
      {tab === 'sessions' && sessionRail.collapsed ? <Button data-rail-reveal variant="secondary" size="icon" className="h-10 w-10 xl:h-12 xl:w-12" onPointerEnter={railReveal.show} onPointerLeave={railReveal.hide} onFocus={railReveal.show} onBlur={railReveal.hide} onClick={() => sessionRail.setCollapsed(false)} aria-controls="desktop-session-list" aria-expanded={railReveal.open} aria-label={tr("Expand session list")} title={tr("Expand session list")}><PanelLeftOpen size={17} /></Button> : null}
      <div id="workspace-layout-tools" />
      <div className="mt-auto" />
      <BrowserSettings />
      <GlobalNotebookTrigger />
      <Button variant="ghost" size="icon" className="h-10 w-10 rounded-[1.05rem] text-slate-500 hover:bg-white/70 hover:text-red-700 xl:h-12 xl:w-12 xl:rounded-[1.15rem]" onClick={() => void confirmSignOut()} aria-label={tr("Sign out")} title={tr("Sign out")}><LogOut size={17} /></Button>
      </div>
    </aside>

    {tab === 'sessions' && !sessionRail.collapsed ? <SessionRailDivider rail={sessionRail} viewport={viewportWidth} /> : null}
    <aside ref={railReveal.panel} id="desktop-session-list" inert={railHidden} aria-hidden={railHidden} onPointerEnter={railReveal.show} onPointerLeave={railReveal.hide} onFocusCapture={railReveal.show} onBlurCapture={railReveal.hide} data-hover-revealed={railReveal.open} style={railReveal.open ? { position: 'fixed', left: navWidth, top: 0, bottom: 0, width: sessionRail.width, zIndex: 70 } : undefined} className={cn('relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-white/60 bg-white/48 transition-[opacity] duration-200', tab === 'sessions' && 'desktop-session-rail', railHidden && 'pointer-events-none opacity-0')} aria-label={tr(navLabel(tab))}>
      <div className="desktop-session-rail-header border-b border-white/60 px-3 pb-2.5 pt-3 xl:px-5 xl:pb-4 xl:pt-5">
        <div className="flex items-start justify-between gap-2 xl:gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-black leading-none tracking-[-0.05em] text-slate-950 xl:text-xl">{tr(navLabel(tab))}</h1>
            <p className="mt-1.5 text-[0.68rem] text-slate-500 xl:text-xs">{tab === 'sessions' ? tr('{filtered}/{total} sessions · {ago}', { filtered: filteredSessions.length, total: allSessions.length, ago: formatAgo(sessionsState.updatedAt) }) : tr('Control surface')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {tab === 'sessions' ? <Button
              size="sm"
              className="h-7 shrink-0 rounded-2xl px-2 text-[0.68rem] xl:h-8 xl:px-3 xl:text-xs"
              disabled={creatingSession}
              onClick={() => setCreateDialogOpen(true)}
              aria-label={tr("New session")}
            ><Plus size={15} /> {tr(creatingSession ? 'Creating…' : 'New')}</Button> : null}
            {tab === 'sessions' ? <Button type="button" variant="secondary" size="icon" className="h-7 w-7 rounded-2xl" onClick={() => sessionRail.setCollapsed(true)} aria-controls="desktop-session-list" aria-expanded={true} aria-label={tr("Collapse session list")} title={tr("Collapse session list")}><PanelLeftClose size={16} /></Button> : null}
          </div>
        </div>
        {tab === 'sessions' ? <div className="desktop-session-rail-search relative mt-3 xl:mt-4">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 xl:left-3" size={15} />
          <Input aria-label={tr("Search sessions")} className="h-9 rounded-2xl border-white/80 bg-white/60 pl-8 pr-8 text-xs shadow-none xl:h-10 xl:pl-10 xl:pr-9 xl:text-sm" placeholder={tr("Search sessions, agent, status…")} value={sessionSearch} onChange={(event) => setSessionSearch(event.currentTarget.value)} />
          {sessionSearch ? <button type="button" className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-xs xl:h-6 xl:w-6 xl:text-sm font-bold text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" onClick={() => setSessionSearch('')} aria-label={tr("Clear session search")}>×</button> : null}
        </div> : null}
        {tab === 'sessions' ? <div className="desktop-session-rail-visibility mt-2 grid gap-1.5 rounded-2xl bg-white/45 px-2.5 py-1.5 text-[0.68rem] font-bold text-slate-500 xl:text-xs">
          <div className="flex items-center justify-between gap-2">
            <span>{sessionsState.hiddenCount ? tr('{count} hidden', { count: sessionsState.hiddenCount }) : tr('No hidden sessions')}</span>
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-2xl px-2 text-[0.68rem] xl:text-xs" onClick={() => setShowHiddenSessions((value) => !value)} aria-pressed={showHiddenSessions}>{tr(showHiddenSessions ? 'Hide hidden' : 'Show hidden')}</Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>{sessionsState.archivedCount ? tr('{count} archived', { count: sessionsState.archivedCount }) : tr('No archived sessions')}</span>
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-2xl px-2 text-[0.68rem] xl:text-xs" onClick={() => setShowArchivedSessions((value) => !value)} aria-pressed={showArchivedSessions}>{tr(showArchivedSessions ? 'Hide archived' : 'Show archived')}</Button>
          </div>
        </div> : null}
        {tab === 'sessions' && hasMultipleEnvs ? <EnvFilterChips
          envOptions={envOptions}
          selected={envFilter}
          {...(sessionsState.connections ? { connections: sessionsState.connections } : {})}
          onChange={setEnvFilter}
        /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 xl:p-4">
        {tab === 'dashboard' ? <DashboardSummary sessions={sessionsState} agents={agents} gateway={gateway} compact /> : null}
        {tab === 'sessions' ? <div className="grid gap-2">
          {sessionsState.updatedAt === 0 ? <LoadingCard text="Loading sessions…" /> : null}
          {sessionsState.updatedAt !== 0 && allSessions.length === 0 ? <Card className="p-5 text-sm text-slate-500">{tr("No sessions yet. Create a new web session to begin.")}</Card> : null}
          {allSessions.length > 0 && filteredSessions.length === 0 ? <Card className="p-5 text-sm text-slate-500">{deferredSessionSearch.trim() ? tr(envFilter !== 'all' ? 'No sessions match “{query}” in this environment.' : 'No sessions match “{query}”.', { query: deferredSessionSearch.trim() }) : tr('No sessions in this environment.')}</Card> : null}
          <OrganizedSessions sessions={filteredSessions}>{(session) => {
            const isSelected = session.sessionKey === selectedKey;
            const isHidden = Boolean(session.hidden);
            const isArchived = Boolean(session.archived);
            const isPinned = Boolean(session.pinned);
            const cardStatus = effectiveSessionStatus(session);
            const statusVariant = sessionStatusBadgeVariant(cardStatus);
            const completionUnseen = isSessionCompletionUnseen(session, isSelected);
            const runningLabel = runningDurationLabel(session, now);
            const tone = sessionTone(session.sessionKey, workspace.value.sessions[session.sessionKey]?.color);
            return <button
              data-session-card={session.sessionKey}
              data-session-state={sessionPresentation(session, completionUnseen).state}
              aria-current={isSelected ? 'true' : undefined}
              className={cn('group w-full rounded-[1.45rem] text-left transition duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50', isSelected && 'translate-x-1', (isHidden || isArchived) && 'opacity-65')}
              onClick={() => selectSession(session)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSessionListContextMenu({ session, x: event.clientX, y: event.clientY });
              }}
              key={session.sessionKey}
            >
              <Card
                style={{ borderLeftColor: isSelected ? 'rgba(255,255,255,0.72)' : tone.accent, backgroundColor: isSelected ? tone.accent : undefined, boxShadow: isSelected ? `0 18px 42px ${tone.shadow}` : `0 10px 24px ${tone.shadow}` }}
                className={cn(
                  'grid gap-1.5 overflow-hidden border-l-[5px] border-white/70 bg-white/64 p-2.5 transition duration-200 group-hover:bg-white/86 group-hover:shadow-lg xl:gap-2 xl:p-3',
                  isSelected && 'border-white/40 text-white shadow-xl ring-1 ring-white/40 group-hover:text-white',
                )}
              >
                <div className="session-card-heading flex min-w-0 items-start justify-between gap-2">
                  <strong onDoubleClick={event => { event.stopPropagation(); renameSessionDialog(session, applyRenamedSession); }} className={cn('min-w-0 flex-1 truncate text-[0.82rem] font-semibold leading-4 tracking-[-0.01em] xl:text-sm xl:leading-5', isSelected ? 'text-white' : 'text-slate-950')}>{isPinned ? '📌 ' : ''}{displayTitle(session)}</strong>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.04em]', completionUnseen && 'session-completion-unread', sessionRunOutcome(session) === 'completed' && !isSelected ? 'bg-emerald-50 text-emerald-700' : sessionStatusToneClass(cardStatus, isSelected))}>{sessionListPrimaryStatusLabel({ status: cardStatus, completionUnseen, outcome: sessionRunOutcome(session) })}{statusAgeLabel(session, cardStatus, now) ? '@' + statusAgeLabel(session, cardStatus, now) : ''}</span>
                </div>
                <SessionIdentityRow session={session} />
                {isHidden || isArchived ? <div className="flex min-w-0 items-center gap-1.5">
                  {isHidden ? <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[0.56rem] font-medium uppercase', isSelected ? 'bg-white/15 text-white' : 'bg-amber-50 text-amber-700')}>{tr("hidden")}</span> : null}
                  {isArchived ? <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[0.56rem] font-medium uppercase', isSelected ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-500')}>{tr("archived")}</span> : null}
                </div> : null}
                <div className={cn('mt-1.5 flex min-w-0 items-center justify-between gap-2 text-[0.68rem] font-normal', isSelected ? 'text-white/90' : 'text-slate-500')}>
                  <time className="min-w-0 flex-1 truncate" title={session.lastActiveAt ? new Date(session.lastActiveAt).toLocaleString() : undefined}>{formatAgo(session.lastActiveAt)}</time>
                  <span className={cn('shrink-0 font-medium', isSelected ? 'text-white/82' : 'text-slate-400')}>{displayModelName(session)}@{sessionContextPercent(session)}</span>
                </div>
              </Card>
            </button>;
          }}</OrganizedSessions>
        </div> : null}
        {tab === 'agents' ? <AgentsPage agents={agents} sessions={sessionsState} compact mode="rail" selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} /> : null}
        {tab === 'media' ? <Card className="p-4 text-sm text-slate-500">{tr("Media library is shown in the main panel.")}</Card> : null}
        {tab === 'gateway' ? <Card className="p-4 text-sm text-slate-500">{tr("Gateway controls are shown in the main panel.")}</Card> : null}
        {tab === 'users' ? <Card className="p-4 text-sm text-slate-500">{tr("Users / Access controls are shown in the main panel.")}</Card> : null}
      </div>
    </aside>

    {sessionListContextMenu ? <SessionListContextMenu
      state={sessionListContextMenu}
      saving={sessionActionSavingKey === sessionListContextMenu.session.sessionKey}
      onPinChange={(pinned) => void setSessionPinnedFromList(sessionListContextMenu.session, pinned)}
      onHideChange={(hidden) => void setSessionHiddenFromList(sessionListContextMenu.session, hidden)}
      onArchiveChange={(archived) => void setSessionArchivedFromList(sessionListContextMenu.session, archived)}
      onDelete={() => void deleteSessionFromList(sessionListContextMenu.session)}
      onQuickMessage={() => { setQuickMessageSession(sessionListContextMenu.session); setSessionListContextMenu(undefined); }}
      onModel={() => { setModelSessionKey(sessionListContextMenu.session.sessionKey); setSessionListContextMenu(undefined); }}
      onRename={() => { const session = sessionListContextMenu.session; setSessionListContextMenu(undefined); renameSessionDialog(session, applyRenamedSession); }}
      onClose={() => setSessionListContextMenu(undefined)}
    /> : null}

    {quickMessageSession ? <QuickSessionMessage key={`${recoveryScope()}:${quickMessageSession.sessionKey}`} session={quickMessageSession} onClose={closeQuickMessage} onAccepted={() => { void refresh().catch(() => {}); }} /> : null}
    {allSessions.filter(session => session.sessionKey === modelSessionKey).map(session => <SessionModelDialog key={`${recoveryScope()}:${session.sessionKey}`} session={session} onClose={closeModelSession} onUpdated={applyRenamedSession} />)}

    <main style={{ gridColumn: 3, gridRow: 1 }} className={`relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden ${tab === 'sessions' ? 'desktop-session-main' : 'p-2 md:p-3 xl:p-5'}`}>
      <div className="max-h-[35%] shrink-0 overflow-auto">
        <CommandRecoveryNotice onRecovered={async () => { await refresh(); }} onCreated={(key, target) => {
          if (target.ownerUserId) {
            window.location.hash = `#/session/${encodeURIComponent(sessionAddress({ ownerUserId: target.ownerUserId, sessionId: key }).key)}`;
            return;
          }
          const session = findSessionByKey(sessionsState, key) ?? newSessionSummary(key, target.agentId, 'New session', connectionForId(sessionsState, target.connectionId));
          setSessionsState(current => ensureSessionInState(current, session));
          selectSession(session);
        }} />
      </div>
      <div className="relative min-h-0 min-w-0 flex-1">
      {tab === 'sessions' ? <SessionWorkspaceView onCreateSession={() => setCreateDialogOpen(true)} onCreateTemplateSession={async (title) => {
        const scope = recoveryScope();
        const ownedConns = sessionsState.connections ?? [];
        let connectionId = (selected ? sessionConnectionId(selected) : undefined) ?? (allSessions[0] ? sessionConnectionId(allSessions[0]) : undefined) ?? (envFilter !== 'all' && envFilter !== 'remote' ? envFilter : (ownedConns[0]?.id ?? 'local'));
        let agentId = selected?.agentId ?? 'codex';
        let ownerUserId: string | undefined;
        if (!ownedConns.some((c) => c.id === connectionId)) {
          const sharedPage = await api.sharedCreationEnvironments().catch(() => ({ environments: [] }));
          const sharedEnv = sharedPage.environments[0];
          if (sharedEnv) {
            connectionId = sharedEnv.connectionId;
            ownerUserId = sharedEnv.ownerUserId;
            agentId = 'codex';
          }
        }
        let createdKey: string | undefined;
        await createSessionWithRecovery({ agentId, connectionId, ...(ownerUserId ? { ownerUserId } : {}) }, title, async (created) => {
          createdKey = created.key;
          if (recoveryScope() !== scope) return;
          const session = findSessionByKey(sessionsState, created.key) ?? { ...newSessionSummary(created.key, agentId, title, connectionForId(sessionsState, connectionId)), ...(ownerUserId ? { ownerUserId, accessMode: 'collaborator' as const } : {}) };
          setSessionsState((current) => ensureSessionInState(current, session));
        });
        return createdKey;
      }} selected={selected} selectedKey={selectedKey} sessions={allSessions} sourceStates={sessionsState.sourceStates} dismissed={dismissedPanes} onSelect={selectSession} onActivate={activateSession} onOpenKeys={rememberOpenPanes} emptyState={<DesktopEmptyState creating={creatingSession} onCreate={() => setCreateDialogOpen(true)} />}
        renderPane={renderSessionPane} /> : null}
      {createDialogOpen ? <NewSessionDialog
        open={createDialogOpen}
        creating={creatingSession}
        environments={environmentOptions(sessionsState)}
        optionsForEnvironment={(connectionId) => agentGroupOptions(sessionsState, agents, gateway, connectionId)}
        initialConnectionId={envFilter !== 'all' && envFilter !== 'remote' ? envFilter : 'local'}
        initialGroupId={newSessionGroupId || defaultCreateGroupId(sessionsState, agents, gateway, envFilter !== 'all' && envFilter !== 'remote' ? envFilter : 'local')}
        onClose={() => setCreateDialogOpen(false)}
        onCreate={async (target, title) => {
          setNewSessionGroupId(target.groupId);
          await createSession(target, title);
          setCreateDialogOpen(false);
        }}
      /> : null}
      {tab !== 'sessions' ? <div className="h-full overflow-auto rounded-[2rem] border border-white/70 bg-white/62 p-5">
        {tab === 'dashboard' ? <DashboardPage sessions={sessionsState} agents={agents} gateway={gateway} /> : null}
        {tab === 'agents' ? <AgentsPage agents={agents} sessions={sessionsState} mode="browser" selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} /> : null}
        {tab === 'media' ? <MediaLibrary /> : null}
        {tab === 'channels' ? <ChannelsPage sessions={sessionsState} onOpenSession={selectSession} /> : null}
        {tab === 'gateway' ? <GatewayPage gateway={gateway} {...(sessionsState.connections ? { hubConnections: sessionsState.connections } : {})} /> : null}
        {tab === 'users' ? <UsersAccessPage connections={sessionsState.connections ?? []} /> : null}
      </div> : null}
      </div>
    </main>
  </div>;
}


type AgentGroupOption = {
  id: string;
  label: string;
  defaultAgentId: string;
  agentIds: string[];
  connectionId: string;
  readiness?: AgentSummary['readiness'];
};

type EnvironmentOption = {
  id: string;
  ownerUserId?: string;
  connectionId?: string;
  label: string;
  kind: 'local' | 'remote';
  status: HubConnection['status'];
};

type NewSessionTarget = {
  connectionId: string;
  groupId: string;
  agentId: string;
  ownerUserId?: string;
};

function environmentOptions(state: HubSessionsState): EnvironmentOption[] {
  const connections = state.connections ?? [];
  return connections
    .filter((connection) => connection.status !== 'disabled')
    .map((connection) => ({
      id: connection.id,
      label: connection.environmentLabel ?? connection.label,
      kind: connection.kind,
      status: connection.status,
    }));
}

function agentGroupOptions(state: HubSessionsState, agents: AgentSummary[], gateway?: GatewayHealth, connectionId = 'local'): AgentGroupOption[] {
  const byGroup = new Map<string, Set<string>>();
  const isLocal = isLocalCreationConnection(state, connectionId);
  const add = (agentId: string | undefined) => {
    if (!agentId) return;
    const groupId = groupIdForAgent(agentId);
    const set = byGroup.get(groupId) ?? new Set<string>();
    set.add(agentId);
    byGroup.set(groupId, set);
  };
  if (isLocal && gateway?.enabled !== false && gateway?.defaultAgentId) add(gateway.defaultAgentId);
  if (isLocal) for (const agent of agents) add(agent.id);
  for (const group of state.groups) {
    const sessionsForConnection = group.sessions.filter((session) => sessionConnectionId(session) === connectionId);
    if (sessionsForConnection.length > 0) add(group.agentId);
    for (const session of sessionsForConnection) add(session.agentId);
  }
  const fallbackAgent = defaultCreateAgentId(state, agents, gateway, connectionId);
  if (byGroup.size === 0) add(fallbackAgent);
  return [...byGroup.entries()]
    .map(([id, agentIds]) => {
      const ids = [...agentIds].sort((a, b) => agentRoleRank(a) - agentRoleRank(b) || a.localeCompare(b));
      const defaultAgentId = defaultPublicAgentForGroup(id, ids, isLocal ? gateway : undefined);
      return { id, label: groupLabel(id), defaultAgentId, agentIds: ids, connectionId,
        readiness: isLocal ? agents.find(agent => agent.id === defaultAgentId)?.readiness : undefined };
    })
    .sort((a, b) => groupRank(a.id) - groupRank(b.id) || a.label.localeCompare(b.label));
}

function defaultCreateGroupId(state: HubSessionsState, agents: AgentSummary[], gateway?: GatewayHealth, connectionId = 'local') {
  const preferredAgent = defaultCreateAgentId(state, agents, gateway, connectionId);
  return groupIdForAgent(preferredAgent)
    || agentGroupOptions(state, agents, gateway, connectionId)[0]?.id
    || 'default';
}

function defaultCreateAgentId(state: HubSessionsState, agents: AgentSummary[], gateway?: GatewayHealth, connectionId = 'local') {
  return defaultCreationAgent(state, agents, gateway, connectionId);
}

function groupIdForAgent(agentId: string | undefined) {
  if (!agentId || agentId === 'main') return 'main';
  const knownRoles = ['backend-dev', 'web-dev', 'devops', 'narrative', 'product', 'design', 'art', 'dev', 'pm', 'ui'];
  const role = knownRoles.find((suffix) => agentId.endsWith(`-${suffix}`));
  if (role) return agentId.slice(0, -role.length - 1);
  const dash = agentId.indexOf('-');
  return dash > 0 ? agentId.slice(0, dash) : agentId;
}

function defaultPublicAgentForGroup(groupId: string, agentIds: string[], gateway?: GatewayHealth) {
  const availableAgentIds = agentIds.filter(Boolean);
  if (gateway?.defaultAgentId && groupIdForAgent(gateway.defaultAgentId) === groupId) return gateway.defaultAgentId;
  if (groupId === 'main') return availableAgentIds.includes('main') ? 'main' : (availableAgentIds[0] ?? gateway?.defaultAgentId ?? 'main');
  const candidates = [`${groupId}-pm`, `${groupId}-product`, `${groupId}-dev`, `${groupId}-devops`, `${groupId}-design`, `${groupId}-ui`];
  return candidates.find((candidate) => availableAgentIds.includes(candidate)) ?? availableAgentIds[0] ?? `${groupId}-pm`;
}

function groupLabel(groupId: string) {
  if (groupId === 'main') return 'Default';
  return titleCase(groupId.replace(/[-_]+/g, ' '));
}

function groupRank(groupId: string) {
  if (groupId === 'main') return 0;
  return 50;
}

function agentRoleRank(agentId: string) {
  if (agentId.endsWith('-pm')) return 0;
  if (agentId.endsWith('-product')) return 1;
  if (agentId.endsWith('-dev')) return 2;
  if (agentId.endsWith('-backend-dev')) return 2;
  if (agentId.endsWith('-web-dev')) return 2;
  if (agentId.endsWith('-devops')) return 3;
  if (agentId.endsWith('-design')) return 4;
  if (agentId.endsWith('-ui')) return 4;
  return 10;
}

function sessionConnectionId(session: SessionSummary) {
  return (session as SessionSummary & { envConnectionId?: string }).envConnectionId ?? 'local';
}

function connectionForId(state: HubSessionsState, connectionId: string) {
  return state.connections?.find((connection) => connection.id === connectionId);
}

function findSessionByKey(state: HubSessionsState | undefined, sessionKey: string) {
  return state?.groups.flatMap((group) => group.sessions).find((session) => session.sessionKey === sessionKey);
}

function newSessionSummary(sessionKey: string, agentId: string, title: string, connection?: HubConnection | undefined): SessionSummary {
  return {
    sessionKey,
    agentId,
    title,
    status: 'idle',
    source: newSessionSource(agentId),
    lastActiveAt: Date.now(),
    messageCount: 0,
    ...(connection ? { envConnectionId: connection.id, envConnectionLabel: connection.environmentLabel ?? connection.label } : {}),
  } as SessionSummary;
}

function updateSessionHiddenInState(state: HubSessionsState, sessionKey: string, hidden: boolean, includeHidden: boolean): HubSessionsState {
  let hiddenDelta = 0;
  const groups = state.groups.map((group) => {
    let changed = false;
    const sessions = group.sessions.flatMap((session) => {
      if (session.sessionKey !== sessionKey) return [session];
      changed = true;
      if (hidden && !includeHidden) {
        hiddenDelta += session.hidden ? 0 : 1;
        return [];
      }
      const next = { ...session, hidden };
      if (hidden !== Boolean(session.hidden)) hiddenDelta += hidden ? 1 : -1;
      return [next];
    });
    return changed ? { ...group, sessions } : group;
  });
  return {
    ...state,
    groups,
    hiddenCount: Math.max(0, (state.hiddenCount ?? 0) + hiddenDelta),
    updatedAt: Date.now(),
  };
}

function updateSessionArchivedInState(state: HubSessionsState, sessionKey: string, archived: boolean, includeArchived: boolean): HubSessionsState {
  let archivedDelta = 0;
  const groups = state.groups.map((group) => {
    let changed = false;
    const sessions = group.sessions.flatMap((session) => {
      if (session.sessionKey !== sessionKey) return [session];
      changed = true;
      if (archived && !includeArchived) {
        archivedDelta += session.archived ? 0 : 1;
        return [];
      }
      const next = { ...session, archived };
      if (archived !== Boolean(session.archived)) archivedDelta += archived ? 1 : -1;
      return [next];
    });
    return changed ? { ...group, sessions } : group;
  });
  return {
    ...state,
    groups,
    archivedCount: Math.max(0, (state.archivedCount ?? 0) + archivedDelta),
    updatedAt: Date.now(),
  };
}

function updateSessionPinnedInState(state: HubSessionsState, sessionKey: string, pinned: boolean): HubSessionsState {
  let pinnedDelta = 0;
  const groups = state.groups.map((group) => {
    const updated = updatePinnedSessionList(group.sessions, sessionKey, pinned);
    pinnedDelta += updated.pinnedDelta;
    return updated.changed ? { ...group, sessions: updated.sessions } : group;
  });
  return {
    ...state,
    groups,
    pinnedCount: Math.max(0, (state.pinnedCount ?? 0) + pinnedDelta),
    updatedAt: Date.now(),
  };
}

function removeSessionFromState(state: HubSessionsState, sessionKey: string): HubSessionsState {
  let hiddenDelta = 0;
  let archivedDelta = 0;
  const groups = state.groups.map((group) => {
    const removed = group.sessions.find((session) => session.sessionKey === sessionKey);
    if (!removed) return group;
    if (removed.hidden) hiddenDelta -= 1;
    if (removed.archived) archivedDelta -= 1;
    return { ...group, sessions: group.sessions.filter((session) => session.sessionKey !== sessionKey) };
  }).filter((group) => group.sessions.length > 0);
  return {
    ...state,
    groups,
    hiddenCount: Math.max(0, (state.hiddenCount ?? 0) + hiddenDelta),
    archivedCount: Math.max(0, (state.archivedCount ?? 0) + archivedDelta),
    updatedAt: Date.now(),
  };
}

function mergeSessionInState(state: HubSessionsState, session: SessionSummary): HubSessionsState {
  const targetAgentId = session.agentId ?? 'main';
  let inserted = false;
  const groups = state.groups.map((group) => {
    const existingSession = group.sessions.find((existing) => existing.sessionKey === session.sessionKey);
    const sessionsWithoutRenamed = group.sessions.filter((existing) => existing.sessionKey !== session.sessionKey);
    if (group.agentId !== targetAgentId) return { ...group, sessions: sessionsWithoutRenamed };
    inserted = true;
    return {
      ...group,
      sessions: sortPinnedSessions(existingSession
        ? group.sessions.map((existing) => existing.sessionKey === session.sessionKey ? { ...existing, ...session } : existing)
        : [session, ...sessionsWithoutRenamed]),
    };
  });
  if (!inserted) groups.push({ agentId: targetAgentId, sessions: [session] });
  return { ...state, groups, updatedAt: Date.now() };
}

function ensureSessionInState(state: HubSessionsState, session: SessionSummary): HubSessionsState {
  if (findSessionByKey(state, session.sessionKey)) return state;
  return mergeSessionInState(state, session);
}

function applySessionEditInState(state: HubSessionsState, result: SessionEdit): HubSessionsState {
  // Legacy pin edits only; unversioned settings ACKs cannot mutate snapshots.
  return { ...state, groups: state.groups.map(group => ({ ...group,
    sessions: group.sessions.map(session => applySessionEdit(session, result)),
  })) };
}

function LoadingCard({ text, className }: { text: string; className?: string }) {
  return <Card className={cn('border-dashed border-blue-200 bg-blue-50/55 p-5 text-center text-sm font-semibold leading-6 text-blue-800', className)}>{text}</Card>;
}

function RunProgressNotice({ session, messages, syncError, refreshing = false, onRechecked }: { session: SessionSummary; messages: readonly ChatMessage[]; syncError?: string | undefined; refreshing?: boolean; onRechecked: () => Promise<void> }) {
  const { locale } = useI18n();
  const [now, setNow] = useState(Date.now);
  const [streamConnection, setStreamConnection] = useState(deckStreamConnection);
  const children = useMemo(() => codexSubagents(session, messages, !!syncError || streamConnection === 'reconnecting' || streamConnection === 'disconnected'), [session, messages, syncError, streamConnection]);
  const showCodexSubagentBar = useMemo(() => hasActiveOrAttentionSubagents(children), [children]);
  const ghcpCompanion = useMemo(() => {
    if (children.children.length || children.waiting) return undefined;
    const resolved = resolveSessionSubagentCompanion(
      session,
      messages,
      !!syncError || streamConnection === 'reconnecting' || streamConnection === 'disconnected',
    );
    if (!resolved) return undefined;
    const hasAttention = resolved.children.some((c) => c.status === 'errored' || c.status === 'interrupted');
    return resolved.hasLiveDispatch || hasAttention ? resolved : undefined;
  }, [children.children.length, children.waiting, session, messages, syncError, streamConnection]);
  useEffect(() => {
    const update = () => setStreamConnection(deckStreamConnection);
    streamConnectionListeners.add(update);
    update();
    return () => { streamConnectionListeners.delete(update); };
  }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const runtime = session.runtime;
  const busy = isSessionBusy(session);
  const notice = runSyncNotice(session, now, !!syncError);
  const outcome = sessionRunOutcome(session);
  const compactLabel = compactProgressLabel(session);
  const streamRecovering = streamConnection === 'reconnecting' || streamConnection === 'disconnected';
  const invalidOutput = !syncError && !streamRecovering && hasInvalidCompletedReply(session, messages);
  const visibleGoal = !syncError && !streamRecovering && runtime?.connection === 'connected' && runtime?.sync === 'current' ? session.codexGoal : undefined;
  const label = streamConnection === 'disconnected' ? 'Live connection lost · showing last known state'
    : streamConnection === 'reconnecting' ? 'Reconnecting live updates…'
    : compactLabel
    || notice.executionLabel || notice.backgroundWorkLabel
    // Separate known successor activity from the predecessor's history error.
    || (runtime?.connection === 'connected' && runtime.threadActivity !== 'unknown' && notice.threadLabel)
    || notice.errorLabel || notice.syncLabel || notice.connectionLabel || (children.waiting && 'Waiting for sub-agents')
    || (invalidOutput ? INVALID_ASSISTANT_OUTPUT_LABEL : undefined)
    || notice.threadLabel || (outcome === 'completed' ? 'Done · ready for your next message'
    : outcome === 'failed' ? 'Run failed · review the response above'
    : outcome === 'interrupted' ? 'Run interrupted'
    : notice.progressLabel || (runtime?.phase === 'finalizing' ? 'Run finished · syncing final response…'
        : runtime?.phase === 'unknown' || runtime?.threadActivity === 'unknown' ? 'Checking run state…'
          : runtime?.phase === 'waiting' || runtime?.threadActivity === 'waiting' ? 'Waiting for approval or input'
            : runtime?.phase === 'starting' ? 'Starting…' : busy ? 'Agent is working…' : runtime?.reason));
  const activeTool = useMemo(
    () => (label === 'Agent is working…' && !streamRecovering && !syncError ? activeToolProgressSummary(session, messages) : undefined),
    [label, streamRecovering, syncError, session, messages],
  );
  if (refreshing && messages.length === 0 && !syncError && !visibleGoal && !showCodexSubagentBar && !ghcpCompanion && !busy && !streamRecovering && runtime?.sync !== 'error' && runtime?.connection !== 'disconnected') return <LatestMessagesNotice active />;
  if (!syncError && !visibleGoal && !showCodexSubagentBar && !ghcpCompanion && !compactLabel && !streamRecovering && !outcome && !busy && !runtime?.reason && !notice.executionLabel && !notice.backgroundWorkLabel && !notice.syncLabel && runtime?.sync !== 'error' && runtime?.connection !== 'disconnected') return null;
  const displayLabel = activeTool
    ? `${translate(activeTool.kind === 'command' ? 'Running command' : 'Running tool', locale)}: ${activeTool.detail}`
    : label ? translate(label, locale) : '';
  const detailLabels = !streamRecovering && !compactLabel
    ? notice.detailLabels.filter(detail => detail !== label)
    : [];
  return <div data-run-outcome={!streamRecovering ? outcome : undefined} data-output-integrity={invalidOutput ? 'invalid' : undefined} className={cn('mx-auto flex max-w-full w-fit items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium shadow-sm', invalidOutput || notice.incomplete || sessionPresentation(session).state === 'error' ? 'border-amber-200/80 bg-amber-50/90 text-amber-800' : outcome === 'interrupted' && !streamRecovering ? 'border-slate-200 bg-slate-50 text-slate-600' : outcome === 'completed' && !streamRecovering ? 'border-emerald-200/80 bg-emerald-50/90 text-emerald-700' : 'border-blue-200/80 bg-blue-50/90 text-blue-700')} role="status" title={runtime?.reason}>
    {outcome === 'completed' && !streamRecovering && !invalidOutput ? <Check size={13} aria-hidden="true" /> : <Sparkles size={13} className={!streamRecovering && notice.animate ? 'animate-pulse' : undefined} aria-hidden="true" />}
    <span>{displayLabel}{!streamRecovering && notice.elapsed ? ` · ${notice.elapsed}` : ''}</span>
    {detailLabels.map(detail => <span key={detail}>{' · '}{translate(detail, locale)}</span>)}
    {notice.backgroundLabel && !streamRecovering ? <details className="goal-pause-notice">
      <summary><Clock3 size={12} aria-hidden="true" />{translate(notice.backgroundLabel, locale)}</summary>
      <p>{translate('The turn has ended, but background terminals are still active. Queued messages remain protected. Confirm terminal ownership and cleanup permission before stopping temporary work; keep intended long-running services. Messages continue through the existing queue after terminal exit and runtime verification. Do not resend them.', locale)}</p>
    </details> : null}
    {visibleGoal ? <SessionGoal goal={visibleGoal} /> : null}
    {showCodexSubagentBar ? <SessionSubagents session={session} messages={messages} stale={streamRecovering || !!syncError} now={now} /> : null}
    {ghcpCompanion ? (
      <button
        type="button"
        className="subagent-inline-open-btn"
        onClick={() => requestOpenSubagentCompanion(session.sessionKey)}
      >
        {translate('Sub-agent Companion', locale)} ·{' '}
        {ghcpCompanion.children.filter((c) => c.status === 'running' || c.status === 'pendingInit').length}/
        {ghcpCompanion.children.length}
      </button>
    ) : null}
    <SessionRecoveryButton session={session} onRechecked={onRechecked} />
    {!session.codexGoal && notice.goalLabel && !streamRecovering ? <details className="goal-pause-notice">
      <summary><Clock3 size={12} aria-hidden="true" />{translate(notice.goalLabel, locale)}</summary>
      <p>{translate('This turn is complete. The long-term goal is paused; its specific blocking reason is unavailable. You can send a new instruction. This is not a delivery error.', locale)}</p>
    </details> : null}
  </div>;
}

function DesktopEmptyState({ creating, onCreate }: { creating: boolean; onCreate: () => void }) {
  const { t: tr } = useI18n();
  return <section className="grid h-full place-items-center rounded-[2rem] border border-white/65 bg-white/46 p-8   ">
    <Card className="max-w-md overflow-hidden border-white/80 bg-white/75 p-7 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-[1.35rem] bg-gradient-to-br from-blue-600 to-cyan-400 text-white shadow-xl "><NavIcon name="messages" /></div>
      <h2 className="mt-5 text-2xl font-black tracking-[-0.04em] text-slate-950">{tr("Select or create a session")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">{tr("Choose an existing conversation from the left, or start a fresh web chat for the default agent.")}</p>
      <Button className="mt-5" disabled={creating} onClick={onCreate}><Plus size={17} /> {creating ? tr('Creating…') : tr("New session")}</Button>
    </Card>
  </section>;
}

function NewSessionDialog({ open, creating, environments, optionsForEnvironment, initialConnectionId, initialGroupId, onClose, onCreate }: { open: boolean; creating: boolean; environments: EnvironmentOption[]; optionsForEnvironment: (connectionId: string) => ReturnType<typeof agentGroupOptions>; initialConnectionId: string; initialGroupId: string; onClose: () => void; onCreate: (target: NewSessionTarget, title: string) => Promise<void> }) {
  const { t: tr } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeDialog = useRef(onClose);
  useLayoutEffect(() => { closeDialog.current = onClose; });
  useLayoutEffect(() => {
    if (!open) return;
    const modal = dialog.current;
    const previous = document.activeElement;
    modal?.showModal();
    modal?.querySelector<HTMLInputElement>('#new-session-title')?.focus({ preventScroll: true });
    const close = () => closeDialog.current();
    window.addEventListener('agentopsdeck:auth-required', close);
    return () => {
      window.removeEventListener('agentopsdeck:auth-required', close);
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  const [draft, setDraft] = useState(closedNewSessionDraft);
  const [connectionId, setConnectionId] = useState(initialConnectionId || 'local');
  const [shared, setShared] = useState<EnvironmentOption[]>([]);
  const [loadingEnvironments, setLoadingEnvironments] = useState(false);
  const [environmentError, setEnvironmentError] = useState('');
  const [after, setAfter] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [environmentRevision, setEnvironmentRevision] = useState(0);
  const [agentRevision, setAgentRevision] = useState(0);
  const [discovery, setDiscovery] = useState<{ key: string; options: AgentGroupOption[]; error?: string }>();
  const scope = recoveryScope();
  useEffect(() => {
    if (!open) { setShared([]); setAfter(undefined); setNextCursor(null); return; }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && scope === recoveryScope();
    setLoadingEnvironments(true); setEnvironmentError('');
    void api.sharedCreationEnvironments(after, controller.signal).then(page => {
      if (!current()) return;
      const rows = page.environments.map(environment => ({ ...environment,
        id: JSON.stringify([environment.ownerUserId, environment.connectionId]) }));
      setShared(previous => [...new Map([...(after ? previous : []), ...rows].map(environment => [environment.id, environment])).values()]);
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (current()) { setShared([]); setNextCursor(null); setEnvironmentError('Shared creation environments unavailable. Refresh to retry.'); }
    }).finally(() => { if (current()) setLoadingEnvironments(false); });
    return () => controller.abort();
  }, [open, scope, after, environmentRevision]);
  const availableEnvironments = [...environments, ...shared];
  const selectedEnvironment = availableEnvironments.find((environment) => environment.id === connectionId) ?? availableEnvironments[0];
  const effectiveConnectionId = selectedEnvironment?.connectionId ?? selectedEnvironment?.id ?? '';
  const discoverRemote = selectedEnvironment?.kind === 'remote' && !selectedEnvironment.ownerUserId;
  const discoveryKey = JSON.stringify([scope, effectiveConnectionId]);
  useEffect(() => {
    if (!open || !discoverRemote || !effectiveConnectionId) { setDiscovery(undefined); return; }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && scope === recoveryScope();
    void api.hubConnectionAgents(effectiveConnectionId, controller.signal).then(({ agents }) => {
      if (!Array.isArray(agents) || agents.some(agent => !agent || typeof agent.id !== 'string' || !agent.id.trim()
        || (agent.label !== undefined && typeof agent.label !== 'string'))) throw new Error('Invalid agent inventory');
      if (current()) setDiscovery({ key: discoveryKey, options: [...new Map(agents.map(agent => [agent.id, {
        id: agent.id, label: agent.id === 'codex' ? 'Codex' : agent.id === 'hermes' ? 'Hermes' : agent.label || agent.id, defaultAgentId: agent.id,
        agentIds: [agent.id], connectionId: effectiveConnectionId, readiness: agent.readiness,
      }])).values()] });
    }).catch(() => {
      if (current()) setDiscovery({ key: discoveryKey, options: [], error: 'Could not load Agents from this environment.' });
    });
    return () => controller.abort();
  }, [open, discoverRemote, discoveryKey, effectiveConnectionId, scope, environmentRevision, agentRevision]);
  const remoteDiscovery = discovery?.key === discoveryKey ? discovery : undefined;
  useEffect(() => {
    if (!open || !discoverRemote || !remoteDiscovery?.options.some(option => shouldRefreshAgentReadiness(option.readiness))) return;
    // Only the open creation dialog polls transitional runtimes. Never retry a mutation.
    const timer = window.setTimeout(() => setAgentRevision(value => value + 1), 3_000);
    return () => window.clearTimeout(timer);
  }, [open, discoverRemote, remoteDiscovery]);
  const loadingAgents = discoverRemote && !remoteDiscovery;
  const options: AgentGroupOption[] = selectedEnvironment?.ownerUserId ? [{ id: 'codex', label: 'Codex', defaultAgentId: 'codex', agentIds: ['codex'], connectionId: effectiveConnectionId }]
    : discoverRemote ? remoteDiscovery?.options ?? [] : selectedEnvironment ? optionsForEnvironment(effectiveConnectionId) : [];
  const target = (groupId: string): NewSessionTarget => ({ connectionId: effectiveConnectionId, groupId,
    agentId: options.find(option => option.id === groupId)!.defaultAgentId,
    ...(selectedEnvironment?.ownerUserId ? { ownerUserId: selectedEnvironment.ownerUserId } : {}) });

  useEffect(() => {
    setConnectionId((current) => {
      const all = [...environments, ...shared];
      if (all.some((environment) => environment.id === current)) return current;
      if (initialConnectionId && all.some((environment) => environment.id === initialConnectionId)) return initialConnectionId;
      return all[0]?.id || initialConnectionId || 'local';
    });
  }, [environments, shared, initialConnectionId]);

  useEffect(() => {
    setDraft((current) => {
      if (open && !current.open) return openNewSessionDraft(initialGroupId, options);
      if (!open && current.open) return closeNewSessionDraft(current);
      if (open) return refreshNewSessionDefaults(current, initialGroupId, options);
      return current;
    });
  }, [open, initialGroupId, options]);

  if (!open) return null;
  const { title } = draft;
  const selection = resolveNewSessionSelection(draft, initialGroupId, options);
  const selected = selection.selectedOption;
  const readinessNotice = agentCreationNotice(selected?.readiness);
  const canCreate = !creating && !loadingAgents && !!selectedEnvironment && !!selected && !selection.missingSelectedOption && !readinessNotice;
  return <dialog ref={dialog} className="os-new-session-modal-backdrop" aria-label={tr("Create new session")} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
      .filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }}>
    <Card className="os-new-session-modal-window w-full max-w-lg border-slate-300/60 p-0 shadow-2xl">
      <div className="os-new-session-titlebar">
        <div className="os-new-session-titlebar-left">
          <div className="os-new-session-title-badge"><Plus size={17} /></div>
          <div className="os-new-session-titlebar-text">
            <p>{tr("New session")}</p>
            <h2>{tr("Choose agent and name it")}</h2>
          </div>
        </div>
        <button type="button" className="os-new-session-close-btn" onClick={onClose} aria-label={tr("Close")}><X size={17} /></button>
      </div>
      <div className="os-new-session-body">
        <div>
          <div className="os-new-session-field-head">
            <label className="os-new-session-label" htmlFor="new-session-env">{tr("Environment")}</label>
            <div className="os-new-session-inline-actions">
              <button type="button" className="os-new-session-mini-btn" disabled={loadingEnvironments || creating} onClick={() => { setShared([]); setAfter(undefined); setEnvironmentRevision(value => value + 1); }}>{tr("Refresh environments")}</button>
              {nextCursor ? <button type="button" className="os-new-session-mini-btn" disabled={loadingEnvironments || creating} onClick={() => setAfter(nextCursor)}>{tr("More environments")}</button> : null}
            </div>
          </div>
          <select id="new-session-env" disabled={creating || !availableEnvironments.length} className="os-new-session-select mt-2" value={selectedEnvironment?.id ?? ''} onChange={(event) => {
            const nextConnectionId = event.currentTarget.value;
            setConnectionId(nextConnectionId);
            const nextEnv = availableEnvironments.find((environment) => environment.id === nextConnectionId);
            const nextOptions = nextEnv?.ownerUserId
              ? [{ id: 'codex', label: 'Codex', defaultAgentId: 'codex', agentIds: ['codex'], connectionId: nextEnv.connectionId ?? nextEnv.id }]
              : optionsForEnvironment(nextEnv?.connectionId ?? nextConnectionId);
            setDraft((current) => ({ ...current, groupId: nextOptions[0]?.id ?? 'main', groupDirty: false }));
          }}>
            {!availableEnvironments.length ? <option value="">{loadingEnvironments ? tr("Loading environments…") : tr("No available environments")}</option> : null}
            {availableEnvironments.map((environment) => <option value={environment.id} key={environment.id}>{environment.label}{environment.ownerUserId ? ` · ${tr('shared')}` : environment.kind === 'remote' ? ` · ${tr('remote')}` : ` · ${tr('local')}`}{environment.status === 'degraded' ? ` · ${tr('degraded')}` : ''}</option>)}
          </select>
          {environmentError ? <p role="alert" className="mt-2 text-xs text-red-500">{environmentError}</p> : null}
          {!loadingEnvironments && !availableEnvironments.length && !environmentError ? <div role="status" className="mt-3 rounded-2xl border border-blue-200 bg-blue-50/90 p-4 text-sm text-slate-800">
            <p className="font-bold text-slate-900">{tr("Environment access needed")}</p>
            <p className="mt-1 text-slate-600">{tr("Your login is ready, but no environment is available for creating sessions.")}</p>
            <p className="mt-2 text-xs text-slate-600">{tr("Ask your administrator: Users → your name → Manage access →")}<strong>{tr("Allow creating and chatting")}</strong>.</p>
            <p className="mt-2 text-xs font-semibold text-blue-800">{tr("Already granted access? Refresh environments below.")}</p>
          </div> : null}
          {selectedEnvironment?.ownerUserId ? <p className="mt-2 text-xs opacity-80">{tr("Shared environment: the owner and members with applicable grants can access this new session. This is not an isolated workspace.")}</p> : null}
        </div>
        {selectedEnvironment ? <>
        <div>
          <label className="os-new-session-label block" htmlFor="new-session-agent">{tr("Agent")}</label>
          {options.length > 0 ? <div className="os-new-session-agent-pills" role="group" aria-label={tr("Agent")}>
            {options.map((option) => {
              const isSelected = selection.groupId === option.id;
              return <button
                key={option.id}
                type="button"
                disabled={creating || loadingAgents}
                className={`os-new-session-agent-pill${isSelected ? ' is-selected' : ''}`}
                onClick={() => setDraft((current) => editNewSessionGroup(current, option.id))}
              >
                <span>{option.label}</span>
              </button>;
            })}
          </div> : null}
          <select id="new-session-agent" disabled={creating || loadingAgents || !options.length} className="os-new-session-select mt-2" value={selection.groupId} onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft((current) => editNewSessionGroup(current, value));
          }}>
            {!options.length ? <option value={selection.groupId}>{tr(loadingAgents ? 'Loading Agents…' : 'No available Agents')}</option> : selection.missingSelectedOption ? <option value={selection.groupId}>{groupLabel(selection.groupId)} {tr("→ unavailable")}</option> : null}
            {options.map((option) => <option value={option.id} key={option.id}>{option.label.toLowerCase() === option.defaultAgentId.toLowerCase() ? option.label : `${option.label} → ${option.defaultAgentId}`}</option>)}
          </select>
          {discoverRemote && remoteDiscovery?.error ? <div role="alert" className="mt-2 text-xs text-red-500">{remoteDiscovery.error} <button type="button" className="font-bold underline" onClick={() => setEnvironmentRevision(value => value + 1)}>{tr("Retry")}</button></div> : null}
          {discoverRemote && remoteDiscovery && !remoteDiscovery.error && !options.length ? <p role="status" className="mt-2 text-xs opacity-75">{tr("No Agents are enabled on this Connector. Check its runtime configuration, then refresh environments.")}</p> : null}
          {readinessNotice ? <p role="status" aria-live="polite" className="mt-3 rounded-xl border border-slate-300/40 bg-slate-500/10 px-3 py-2 text-sm">{tr(readinessNotice)}</p> : null}
        </div>
        <div>
          <label className="os-new-session-label block" htmlFor="new-session-title">{tr("Session name")}</label>
          <Input id="new-session-title" disabled={creating} className="os-new-session-input mt-2" placeholder={selected ? tr('{agent} chat', { agent: selected.defaultAgentId }) : tr('New web session')} value={title} onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft((current) => editNewSessionTitle(current, value));
          }} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && canCreate) {
              event.preventDefault();
              void onCreate(target(selection.groupId), title || selected?.label || groupLabel(selection.groupId) || 'New web session');
            }
          }} />
        </div>
        </> : null}
      </div>
      <div className="os-new-session-footer">
        <Button type="button" variant="secondary" onClick={onClose} disabled={creating}>{tr("Cancel")}</Button>
        <Button type="button" disabled={!canCreate} onClick={() => void onCreate(target(selection.groupId), title || selected?.label || groupLabel(selection.groupId) || 'New web session')}><Plus size={16} /> {tr(creating ? 'Creating…' : 'Create')}</Button>
      </div>
    </Card>
  </dialog>;
}

function CaptionPanel({ label, icon, children, openEvent, priority = 50 }: { label: string; icon: React.ReactNode; children: (close: () => void, open: boolean) => React.ReactNode; openEvent?: string; priority?: number }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const pane = anchor.current?.closest('[data-workspace-pane]');
    if (!pane || !openEvent) return;
    const show = () => {
      // A context-menu action can target a model button hidden in overflow.
      // Reveal its physical anchor first so the nested panel is positioned
      // beside this session, not at the viewport origin.
      const overflow = anchor.current?.closest<HTMLElement>('.caption-overflow-content[popover]');
      if (overflow && !overflow.matches(':popover-open')) overflow.showPopover();
      setOpen(true);
    };
    pane.addEventListener(openEvent, show);
    return () => pane.removeEventListener(openEvent, show);
  }, [openEvent]);
  return <><CaptionIconButton priority={priority} ref={anchor} label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>{icon}</CaptionIconButton>
    <AnchoredPanel open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} keepMounted>
      {children(() => { setOpen(false); anchor.current?.focus({ preventScroll: true }); }, open)}
    </AnchoredPanel></>;
}

function MessageSearchBar({ value, onChange, total, activeIndex, onPrevious, onNext, className, caption = false }: { value: string; onChange: (value: string) => void; total: number; activeIndex: number; onPrevious: () => void; onNext: () => void; className?: string; caption?: boolean }) {
  const { t: tr } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const trimmed = value.trim();
  const expanded = focused || Boolean(trimmed);
  return <>{caption ? <CaptionIconButton priority={100} ref={anchor} label={tr('Search messages')} aria-expanded={open} data-has-query={Boolean(trimmed)} onClick={() => setOpen(!open)}><Search size={13} /></CaptionIconButton>
    : <button ref={anchor} type="button" className="desktop-chat-toolbar-control message-search-trigger" aria-label={tr('Search messages')} title={tr('Search messages')} aria-expanded={open} onClick={() => setOpen(!open)}><Search size={15} />{trimmed ? <span>{total}</span> : null}</button>}
    <AnchoredPanel open={open} onClose={() => setOpen(false)} anchor={anchor} label={tr('Search messages')}>
    <div className="message-search-panel">
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
      <Input
        aria-label={tr("Search messages")}
        className="desktop-chat-toolbar-control h-8 rounded-xl border-slate-200/80 bg-white/75 pl-9 pr-8 tracking-normal shadow-sm shadow-slate-200/30"
        placeholder={tr(expanded ? 'Search messages in this chat…' : 'Search…')}
        value={value}
        autoFocus
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {value ? <button type="button" className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-xs font-bold text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" onClick={() => onChange('')} aria-label={tr("Clear message search")}>×</button> : null}
    </div>
    <span className="shrink-0 text-xs tabular-nums">{trimmed ? (total ? `${activeIndex + 1}/${total}` : '0/0') : ''}</span>
    {expanded ? <Button type="button" variant="secondary" size="icon" className="h-8 w-8 shrink-0 rounded-xl border-slate-200/80 bg-white/75 text-[0.68rem] font-bold tracking-normal shadow-sm shadow-slate-200/30" disabled={!trimmed || total === 0} onMouseDown={(event) => event.preventDefault()} onClick={onPrevious} aria-label={tr("Previous search result")}>↑</Button> : null}
    {expanded ? <Button type="button" variant="secondary" size="icon" className="h-8 w-8 shrink-0 rounded-xl border-slate-200/80 bg-white/75 text-[0.68rem] font-bold tracking-normal shadow-sm shadow-slate-200/30" disabled={!trimmed || total === 0} onMouseDown={(event) => event.preventDefault()} onClick={onNext} aria-label={tr("Next search result")}>↓</Button> : null}
    <button type="button" aria-label={tr('Close')} onClick={() => setOpen(false)}><X size={15} /></button>
  </div></AnchoredPanel></>;
}

function messageSearchMatches(messages: ChatMessage[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return messages.filter((message) => messageSearchText(message).includes(needle));
}

function messageSearchText(message: ChatMessage) {
  return [
    readableText(message.text),
    message.role,
    message.status,
    ...(message.media ?? []).flatMap((item) => [item.name, item.mimeType, item.type]),
  ].filter(Boolean).join('\n').toLowerCase();
}

function messageSearchFrameClass(isMatch: boolean, isActive: boolean) {
  return cn(
    'scroll-mt-28 rounded-[1.65rem] transition-colors',
    isMatch && 'bg-amber-100/45 ring-1 ring-amber-300/70',
    isActive && 'bg-amber-100/75 ring-2 ring-amber-400 shadow-lg ',
  );
}

function cssEscape(value: string) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function messageScrollKey(messages: ChatMessage[]) {
  const last = messages.at(-1);
  if (!last) return 'empty';
  return `${messages.length}:${last.id}:${readableText(last.text).length}:${last.status ?? ''}:${last.media?.length ?? 0}`;
}

function SessionListContextMenu({ state, saving, onPinChange, onHideChange, onArchiveChange, onDelete, onRename, onQuickMessage, onModel, onClose }: { state: SessionListContextMenuState; saving: boolean; onPinChange: (pinned: boolean) => void; onHideChange: (hidden: boolean) => void; onArchiveChange: (archived: boolean) => void; onDelete: () => void; onRename: () => void; onQuickMessage: () => void; onModel: () => void; onClose: () => void }) {
  const { t: tr } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const isHidden = Boolean(state.session.hidden);
  const isArchived = Boolean(state.session.archived);
  const isPinned = Boolean(state.session.pinned);
  useContextMenuPosition(true, state, menuRef, { autoFocus: true });
  return createPortal(<div
    ref={menuRef}
    data-font-area="sessions"
    className="cp-context-menu session-list-context-menu"
    style={{ left: state.x, top: state.y }}
    role="menu"
    aria-label={`Actions for ${displayTitle(state.session)}`}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => handleContextMenuKeyDown(event, onClose)}
  >
    <div className="session-list-context-head">
      <span className="session-list-context-head-icon" aria-hidden="true"><Bot size={14} /></span>
      <div className="session-list-context-head-text">
        <strong>{displayTitle(state.session)}</strong>
        <small>{state.session.agentId ?? state.session.sessionRef?.runtimeId ?? state.session.model ?? tr('Session')}</small>
      </div>
    </div>
    <button type="button" role="menuitem" disabled={saving || isArchived} onClick={onQuickMessage} className="session-list-context-item is-primary">
      <span className="session-list-context-item-main"><Send size={14} aria-hidden="true" /><span>{tr('Quick message')}</span></span>
    </button>
    <button type="button" role="menuitem" disabled={saving} onClick={onModel} className="session-list-context-item">
      <span className="session-list-context-item-main"><Bot size={14} aria-hidden="true" /><span>{tr('Session model')}</span></span>
    </button>
    <SessionOrganizationActions sessionKey={state.session.sessionKey} />
    <div className="session-list-context-divider" role="separator" />
    <button type="button" role="menuitem" disabled={saving} onClick={onRename} className="session-list-context-item">
      <span className="session-list-context-item-main"><Pencil size={14} aria-hidden="true" /><span>{tr('Rename session')}</span></span>
    </button>
    <button
      type="button"
      className="session-list-context-item"
      disabled={saving}
      role="menuitem"
      onClick={() => onPinChange(!isPinned)}
    >
      <span className="session-list-context-item-main">
        {isPinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
        <span>{tr(isPinned ? 'Unpin session' : 'Pin session')}</span>
      </span>
      {saving && <span className="session-list-context-meta">{tr('Saving…')}</span>}
    </button>
    <button
      type="button"
      className="session-list-context-item"
      disabled={saving}
      role="menuitem"
      onClick={() => onHideChange(!isHidden)}
    >
      <span className="session-list-context-item-main">
        {isHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
        <span>{isHidden ? tr("Restore session") : tr("Hide session")}</span>
      </span>
      {saving && <span className="session-list-context-meta">{tr('Saving…')}</span>}
    </button>
    <button
      type="button"
      className="session-list-context-item is-warn"
      disabled={saving}
      role="menuitem"
      onClick={() => onArchiveChange(!isArchived)}
    >
      <span className="session-list-context-item-main">
        {isArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
        <span>{tr(isArchived ? 'Unarchive session' : 'Archive session')}</span>
      </span>
      {saving && <span className="session-list-context-meta">{tr('Saving…')}</span>}
    </button>
    <div className="session-list-context-divider" role="separator" />
    <button
      type="button"
      className="session-list-context-item is-danger"
      disabled={saving || !sessionRuntimeUi(state.session).deleteSession}
      title={!sessionRuntimeUi(state.session).deleteSession ? tr('Native session deletion is not supported by this Agent') : undefined}
      role="menuitem"
      onClick={onDelete}
    >
      <span className="session-list-context-item-main">
        <Trash2 size={14} aria-hidden="true" />
        <span>{tr("Delete session…")}</span>
      </span>
      <span className="session-list-context-meta">{tr("Permanent")}</span>
    </button>
  </div>, document.body);
}

function renameSessionDialog(session: SessionSummary, onRenamed: (renamedSession: SessionEdit) => Promise<void> | void) {
  editText({ title: 'Rename session', initial: displayTitle(session), maxLength: 120, onSave: async title => {
    if (title !== displayTitle(session)) await onRenamed(await updateSettingsWithRecovery(session.sessionKey, { title }));
  } });
}

function SessionTitleEditor({ session, titleClassName, hideTrigger = false, onRenamed }: { session: SessionSummary; titleClassName: string; hideTrigger?: boolean; onRenamed: (renamedSession: SessionEdit) => Promise<void> | void }) {
  const { t: tr } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayTitle(session));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(displayTitle(session));
  }, [editing, session.sessionKey, session.title]);

  async function save() {
    if (saveInFlight.current) return;
    const title = draft.trim();
    setError(undefined);
    if (!title) {
      setError('Title is required');
      return;
    }
    if (title === displayTitle(session)) {
      setEditing(false);
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const renamedSession = await updateSettingsWithRecovery(session.sessionKey, { title });
      setEditing(false);
      await onRenamed(renamedSession);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  if (editing) {
    return <form className="flex min-w-0 flex-1 items-center gap-2" onBlur={event => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null) || saveInFlight.current) return;
      if (!draft.trim()) { setEditing(false); setError(undefined); return; }
      void save();
    }} onSubmit={(event) => {
      event.preventDefault();
      void save();
    }}>
      <Input
        aria-label={tr("Rename chat")}
        className="h-9 min-w-0 rounded-xl border-white/80 bg-white/85 text-sm font-bold shadow-none"
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setEditing(false);
            setError(undefined);
          }
        }}
        autoFocus
        maxLength={120}
      />
      <Button type="submit" size="icon" className="h-8 w-8 shrink-0" disabled={saving} aria-label={tr("Save chat title")}><Check size={15} /></Button>
      <Button type="button" variant="secondary" size="icon" className="h-8 w-8 shrink-0" disabled={saving} onClick={() => {
        setEditing(false);
        setError(undefined);
      }} aria-label={tr("Cancel rename")}><X size={15} /></Button>
      {error ? <span className="shrink-0 text-xs font-semibold text-red-600">{error}</span> : null}
    </form>;
  }

  return <div className="flex min-w-0 flex-1 items-center gap-1.5">
    <h2 className={titleClassName} onClick={hideTrigger ? () => setEditing(true) : undefined} onDoubleClick={() => setEditing(true)}>{displayTitle(session)}</h2>
    {hideTrigger ? null : <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 rounded-lg text-slate-400 hover:bg-white/70 hover:text-blue-700" onClick={() => setEditing(true)} aria-label={tr("Rename chat")}><Pencil size={14} /></Button>}
  </div>;
}


function DesktopChatPanel({ active, syncError, onRetrySync, maxMessageChars, session, messages, serverHiddenCount = 0, messagesLoading, messagesRefreshing, historyLoading, onLoadMoreHistory, onSent, onRenamed, onDeleted, onVisibilityChanged }: { active: boolean; syncError?: string | undefined; onRetrySync: () => Promise<void>; maxMessageChars?: number | undefined; session: SessionSummary; messages: ChatMessage[]; serverHiddenCount?: number | undefined; messagesLoading?: boolean; messagesRefreshing?: boolean; historyLoading?: boolean; onLoadMoreHistory?: (schedule?: HistoryReadSchedule, signal?: AbortSignal) => Promise<HistoryBackfillOutcome>; onSent: () => Promise<void>; onRenamed: (renamedSession: SessionEdit) => Promise<void> | void; onDeleted?: () => void; onVisibilityChanged?: (hidden: boolean) => void }) {
  const COMPOSER_MAX_MESSAGE_CHARS = maxMessageChars ?? LEGACY_MAX_MESSAGE_CHARS;
  const { t: tr } = useI18n();
  const [text, setText] = useSessionTextDraft(session.sessionKey);
  const [sending, setSending] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string>();
  const [pendingMedia, setPendingMedia] = useComposerMedia(session.sessionKey);
  const [sendError, setSendError] = useState<string>();
  const uploads = useComposerUploads(session.sessionKey, sessionRuntimeUi(session).attachments, sending, setPendingMedia, setSendError, filesToUploads, mergePendingUploads);
  const { historyDelayed, refreshAccepted } = useAdmissionHistory(session.sessionKey, messages);
  const [messageSearch, setMessageSearch] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [optimisticMessages, setOptimisticMessages] = useOptimisticSessionMessages(session.sessionKey, messages);
  useMessageRetryUpdates(session.sessionKey, setOptimisticMessages, onSent);
  const [hasMessagesBelow, setHasMessagesBelow] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [deliveryMode, setDeliveryModeState] = useState<SendDeliveryMode>(() => defaultDeliveryMode(session));
  const [voiceState, setVoiceState] = useState<VoiceState>(() => getVoiceUnavailableReason() ? 'unsupported' : 'idle');
  usePageRefreshGuard(() => !sending && !uploads.isPreparing() && !pendingMedia.length && voiceState !== 'listening');
  const [voiceError, setVoiceError] = useState<string>();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const remoteSendBusy = useRef(false);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<RemoteDraft>).detail;
      // Recognition may report an error before its final end event. Its live
      // callback still owns this draft until onend clears the instance.
      const admission = draftAdmission(detail.text, { disabled: sending || remoteSendBusy.current || uploads.isPreparing() || !!recognitionRef.current || voiceState === 'listening' || input.disabled,
        occupied: !!(text || input.value || pendingMedia.length), maxChars: COMPOSER_MAX_MESSAGE_CHARS });
      if (admission === 'too-large') { detail.reason = admission; return; }
      if (admission !== 'applied') { detail.result = admission; return; }
      // Reserve the live input synchronously, before React commits, so a second
      // targeted event in the same turn cannot replace this accepted draft.
      input.value = detail.text;
      setText(detail.text); input.focus({ preventScroll: true }); detail.result = 'applied';
    };
    input.addEventListener('agentopsdeck:remote-draft', receive);
    const send = (event: Event) => {
      const detail = (event as CustomEvent<RemoteSend>).detail;
      if (sending || remoteSendBusy.current || input.disabled || detail.text.length > COMPOSER_MAX_MESSAGE_CHARS) { detail.resolve('unavailable'); return; }
      if (text || input.value || pendingMedia.length) { detail.resolve('occupied'); return; }
      remoteSendBusy.current = true;
      void submitMessage({ text: detail.text, key: detail.key }).then(result => detail.resolve(result ?? 'unavailable'), () => detail.resolve('unknown')).finally(() => { remoteSendBusy.current = false; });
    };
    input.addEventListener('agentopsdeck:remote-send', send);
    return () => { input.removeEventListener('agentopsdeck:remote-draft', receive); input.removeEventListener('agentopsdeck:remote-send', send); };
  });
  const mergedMessages = useMemo(() => mergeMessages(messages, optimisticMessages), [messages, optimisticMessages]);
  const renderedMessages = useQueueObservation(session.sessionKey, mergedMessages);
  const queueActive = hasQueueBlockingRun(session);
  const [queueDraft, setQueueDraft] = useQueueDraft(session.sessionKey);
  const conversationMessages = renderedMessages;

  const isTextSelectionActive = () => hasTextSelectionInside(scrollContainerRef.current);
  const { contentRef, scrollToBottom, handleScroll, pauseFollowing } = useChatAutoScroll({
    containerRef: scrollContainerRef,
    followingRef: stickToBottomRef,
    enabled: autoScrollEnabled,
    selectionActive: isTextSelectionActive,
    onMessagesBelowChange: setHasMessagesBelow,
  });
  const rememberScrollIntent = () => {
    const container = scrollContainerRef.current;
    if (isTextSelectionActive()) {
      return;
    }
    handleScroll();
    if (!container || stickToBottomRef.current || container.scrollTop > MESSAGE_HISTORY_TOP_THRESHOLD_PX) return;
    void loadOlderMessages();
  };
  const toggleAutoScroll = () => {
    const nextEnabled = !autoScrollEnabled;
    setAutoScrollEnabled(nextEnabled);
    if (nextEnabled) {
      stickToBottomRef.current = true;
      scrollToBottom('smooth', true);
    } else {
      pauseFollowing();
    }
  };
  const { visible: desktopVisibleMessages, loadOlder: loadOlderMessages } = useMessageHistory({ messages: conversationMessages,
    hiddenCount: serverHiddenCount, loading: historyLoading || messagesLoading, loadMore: onLoadMoreHistory,
    containerRef: scrollContainerRef, followingRef: stickToBottomRef, autoScrollEnabled,
    automaticReadPriority: () => active ? 3 : isSessionVisible(session.sessionKey) ? 4 : 5 });
  useEffect(() => observeDesktopHistoryLayout(scrollContainerRef.current), []);
  const desktopProjector = useMemo(() => createDesktopMessageProjector(), [session.sessionKey]);
  const desktopSearch = useMemo(() => createMessageSearch(messageSearchText), [session.sessionKey]);
  const desktopDetailCache = useMemo(() => createIdleToolDetailCache(), [session.sessionKey]);
  const deferredMessageSearch = useDeferredValue(messageSearch);
  const searchMatches = useMemo(() => desktopSearch.search(desktopVisibleMessages, deferredMessageSearch), [desktopSearch, desktopVisibleMessages, deferredMessageSearch]);
  const searchMatchIds = useMemo(() => new Set(searchMatches.map((match) => match.id)), [searchMatches]);
  const activeSearchMessageId = searchMatches[activeSearchIndex]?.id;
  const allDesktopRenderItems = useMemo(() => desktopProjector(desktopVisibleMessages), [desktopProjector, desktopVisibleMessages]);
  const desktopRenderItems = useProgressiveTailRenderItems({
    sessionKey: session.sessionKey,
    items: allDesktopRenderItems,
    bypass: Boolean(deferredMessageSearch) || !stickToBottomRef.current,
    containerRef: scrollContainerRef,
    followingRef: stickToBottomRef,
    autoScrollEnabled,
  });
  const finalReply = useMemo(() => completedReplyId(session, desktopRenderItems.flatMap(item => item.kind === 'message' ? [item.message] : [])), [session, desktopRenderItems]);
  useCompletionAutoRead(scrollContainerRef, session, finalReply, active && !messagesLoading && !messagesRefreshing && !syncError
    && finalReplyMatchesTurn(session, messages.find(message => message.id === finalReply)), markSessionCompletionSeen);
  const activeSend = hasOptimisticActiveSend(session, sending, optimisticMessages);
  const displaySession = useMemo(
    () => withOptimisticRunningState(session, activeSend, optimisticMessages[optimisticMessages.length - 1]?.createdAt),
    [session, activeSend, optimisticMessages],
  );
  useEffect(() => {
    publishLiveSessionMessages(session.sessionKey, displaySession, conversationMessages, Boolean(syncError));
  }, [session.sessionKey, displaySession, conversationMessages, syncError]);
  const presentation = sessionPresentation(displaySession, isSessionCompletionUnseen(session, active), syncError);
  const syncIssueLabel = sessionSyncIssueLabel(session, syncError);
  const renderedScrollKey = useMemo(() => messageScrollKey(conversationMessages), [conversationMessages]);

  // All rows use the same queue controls. Keep the value stable for unrelated
  // composer/search renders, without freezing queue edits or runtime changes.
  const desktopQueueControls = useMemo<React.ContextType<typeof QueueMessageControls>>(() => ({
    active: queueActive,
    editingId: queueDraft?.id,
    render: (message, onCancelled) => <QueuedMessageActions maxMessageChars={COMPOSER_MAX_MESSAGE_CHARS} messages={[message]} sessionKey={session.sessionKey} onSent={onSent} onCancelled={onCancelled} draft={queueDraft?.id === message.id ? queueDraft : null} setDraft={setQueueDraft} editingElsewhere={!!queueDraft && queueDraft.id !== message.id} />,
  }), [queueActive, queueDraft, COMPOSER_MAX_MESSAGE_CHARS, session.sessionKey, onSent, setQueueDraft]);
  const handleDesktopMediaLoad = useCallback(() => {
    if (autoScrollEnabled && stickToBottomRef.current && !hasTextSelectionInside(scrollContainerRef.current)) scrollToBottom('auto');
  }, [autoScrollEnabled, scrollToBottom]);

  useEffect(() => {
    setSendError(undefined);
    setCompactNotice(undefined);
    setDeliveryModeState(readDeliveryMode(session));
    setAutoScrollEnabled(true);
    stickToBottomRef.current = true;
    setHasMessagesBelow(false);
    scrollToBottom('auto');
  }, [session.sessionKey]);

  useEffect(() => {
    scrollToBottom();
  }, [autoScrollEnabled, renderedScrollKey]);

  useEffect(() => {
    if (autoScrollEnabled && !messagesLoading && messages.length > 0 && !isTextSelectionActive()) {
      scrollToBottom('auto');
      const timers = [80, 240].map((delay) => window.setTimeout(() => scrollToBottom('auto'), delay));
      return () => timers.forEach(window.clearTimeout);
    }
    return undefined;
  }, [autoScrollEnabled, messagesLoading, session.sessionKey]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [deferredMessageSearch, session.sessionKey]);

  useEffect(() => {
    if (!activeSearchMessageId) return;
    pauseFollowing();
    scrollContainerRef.current?.querySelector(`[data-message-search-id="${cssEscape(activeSearchMessageId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [activeSearchMessageId]);

  function discardVoiceInput() {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
    setVoiceState(getVoiceUnavailableReason() ? 'unsupported' : 'idle');
  }
  useEffect(() => {
    setVoiceError(undefined);
    setVoiceState(getVoiceUnavailableReason() ? 'unsupported' : 'idle');
    const expire = () => discardVoiceInput();
    window.addEventListener('agentopsdeck:auth-required', expire);
    window.addEventListener('pagehide', expire);
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.abort();
      window.removeEventListener('agentopsdeck:auth-required', expire);
      window.removeEventListener('pagehide', expire);
    };
  }, [session.sessionKey, recoveryScope(), recoveryEpoch()]);

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const computed = window.getComputedStyle(textarea);
    const parsedMin = Number.parseFloat(computed.minHeight);
    const parsedMax = Number.parseFloat(computed.maxHeight);
    const isOsWindow = Boolean(textarea.closest('.os-desktop-window'));
    const isSplitPane = Boolean(textarea.closest('.session-workspace-pane'));
    const fallbackMin = isOsWindow ? 64 : isSplitPane ? 60 : 76;
    const fallbackMax = isOsWindow ? 140 : isSplitPane ? 96 : 160;
    const minH = Number.isFinite(parsedMin) && parsedMin > 0 ? Math.round(parsedMin) : fallbackMin;
    const maxH = Math.max(minH, Number.isFinite(parsedMax) && parsedMax > 0 ? Math.round(parsedMax) : fallbackMax);
    const minHeightPx = `${minH}px`;
    if (!text && pendingMedia.length === 0) {
      if (textarea.style.height !== minHeightPx) textarea.style.height = minHeightPx;
      if (textarea.style.overflowY !== 'hidden') textarea.style.overflowY = 'hidden';
      return;
    }
    if (!text.includes('\n') && textarea.style.height === minHeightPx && textarea.scrollHeight <= minH + 1) {
      if (textarea.style.overflowY !== 'hidden') textarea.style.overflowY = 'hidden';
      return;
    }
    const prevHeight = textarea.style.height;
    textarea.style.overflowY = 'hidden';
    textarea.style.height = minHeightPx;
    const measured = Math.ceil(textarea.scrollHeight);
    const targetHeight = Math.min(Math.max(measured, minH), maxH);
    const nextHeightPx = `${targetHeight}px`;
    if (prevHeight !== nextHeightPx) {
      textarea.style.height = nextHeightPx;
    } else {
      textarea.style.height = prevHeight;
    }
    const nextOverflow = measured > maxH + 1 ? 'auto' : 'hidden';
    if (textarea.style.overflowY !== nextOverflow) textarea.style.overflowY = nextOverflow;
  }, [text, pendingMedia.length, session.sessionKey]);

  async function deleteSession() {
    if (deleting || !sessionRuntimeUi(session).deleteSession) return;
    if (!await confirmAction(sessionDeletionConfirmation(displayTitle(session), session.source === 'hermes'))) return;
    setDeleting(true);
    setSendError(undefined);
    try {
      await deleteSessionWithRecovery(session.sessionKey);
      onDeleted?.();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  async function toggleSessionHidden() {
    if (hiding) return;
    const nextHidden = !session.hidden;
    setHiding(true);
    setSendError(undefined);
    try {
      await api.hideSession(session.sessionKey, nextHidden);
      onVisibilityChanged?.(nextHidden);
      await onSent();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setHiding(false);
    }
  }

  async function toggleSessionArchived() {
    if (archiving) return;
    setArchiving(true);
    setSendError(undefined);
    try {
      await api.archiveSession(session.sessionKey, !session.archived);
      await onSent();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiving(false);
    }
  }

  async function compactSession() {
    if (compacting || isSessionBusy(session) || !sessionRuntimeUi(session).compact) return;
    setSendError(undefined);
    setCompactNotice(undefined);
    setCompacting(true);
    try {
      const result = await compactSessionWithRecovery(session.sessionKey, sessionRuntimeUi(session).sdk);
      setCompactNotice(compactResponseNotice(result, compactRequestMessage(session)));
      await onSent();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompacting(false);
    }
  }

  async function toggleSessionPinned() {
    if (pinning) return;
    const nextPinned = !session.pinned;
    setPinning(true);
    setVoiceError(undefined);
    try {
      await api.pinSession(session.sessionKey, nextPinned);
      await onRenamed({ sessionKey: session.sessionKey, pinned: nextPinned });
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : String(error));
    } finally {
      setPinning(false);
    }
  }

  function toggleVoiceInput() {
    if (voiceState === 'listening') {
      recognitionRef.current?.stop();
      return;
    }
    const unavailableReason = getVoiceUnavailableReason();
    if (unavailableReason) {
      setVoiceState('unsupported');
      setVoiceError(unavailableReason);
      return;
    }
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setVoiceState('unsupported');
      setVoiceError('This browser does not support speech recognition. You can still type and send normally.');
      return;
    }
    const recognition = new Recognition();
    const baseText = text.trimEnd();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      if (recognitionRef.current !== recognition) return;
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) transcript += event.results[i]?.[0]?.transcript ?? '';
      const nextText = [baseText, transcript.trim()].filter(Boolean).join(baseText ? '\n' : '');
      setText(nextText);
      window.setTimeout(() => {
        if (mayRestoreComposerFocus(inputRef.current, document.activeElement, document.body)) inputRef.current?.focus({ preventScroll: true });
      }, 0);
    };
    recognition.onerror = (event: any) => {
      if (recognitionRef.current !== recognition) return;
      if (event?.error === 'no-speech' || event?.error === 'aborted') {
        setVoiceError(undefined);
        setVoiceState('idle');
        return;
      }
      setVoiceError(voiceRecognitionError(event?.error));
      setVoiceState('idle');
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setVoiceState((current) => current === 'unsupported' ? current : 'idle');
    };
    setVoiceError(undefined);
    recognitionRef.current = recognition;
    setVoiceState('listening');
    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setVoiceState('idle');
      setVoiceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitMessage(remote?: { text: string; key: string }) {
    if (uploads.isPreparing()) return;
    discardVoiceInput();
    const payload = (remote?.text ?? text).trim();
    const mediaPayload = pendingMedia;
    setSendError(undefined);
    if (!sdkAttachmentsSupported(session, mediaPayload)) { setSendError(translate(sdkAttachmentHint)); return; }
    if (!sessionRuntimeUi(session).attachments && mediaPayload.length) {
      setSendError(tr('This Agent accepts text only. Remove attachments before sending.')); return;
    }
    if (payload.length > COMPOSER_MAX_MESSAGE_CHARS) {
      setSendError(tr("Message is too long. Max {limit} characters.", { limit: formatNumber(COMPOSER_MAX_MESSAGE_CHARS) }));
      return;
    }
    if ((!payload && mediaPayload.length === 0) || sending) return;
    const optimisticId = remote?.key ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      sessionKey: session.sessionKey,
      role: 'user',
      text: payload,
      media: mediaPayload.map((item) => ({ type: item.type, url: item.dataUrl, name: item.name, ...(item.mimeType ? { mimeType: item.mimeType } : {}), ...(typeof item.size === 'number' ? { size: item.size } : {}) })),
      status: 'sending',
      queueDisposition: hasQueueBlockingRun(session) && payload !== '/stop' ? 'waiting' : 'preparing',
      createdAt: Date.now(),
    };
    setOptimisticMessages((items) => [...items, optimistic]);
    appendOptimisticMessageToCache(session.sessionKey, optimistic);
    // The message is now visible in the chat as an optimistic outgoing bubble.
    // Clear the composer immediately; if the network later returns 5xx, keep the
    // failure state on that bubble instead of leaving duplicate text in input.
    setText('');
    setPendingMedia([]);
    setSending(true);
    if (autoScrollEnabled) {
      stickToBottomRef.current = true;
      scrollToBottom('smooth', true);
    }
    try {
      const response = await sendMessageWithRecovery(session.sessionKey, payload, deliveryMode, mediaPayload, optimisticId, payload === '/stop' ? session.runtime?.turnId : undefined);
      const admitted = applyMessageAdmission(optimistic, response);
      appendOptimisticMessageToCache(session.sessionKey, admitted);
      setOptimisticMessages((items) => items.map((item) => item.id === optimisticId ? applyMessageAdmission(item, response) : item));
      refreshAccepted(optimistic, response, onSent);
      return 'applied' as const;
    } catch (error) {
      setOptimisticMessages((items) => items.map((item) => item.id === optimisticId ? { ...item, status: error instanceof CommandOutcomeUnknownError ? 'outcome_unknown' : 'failed' } : item));
      if (error instanceof CommandNotSubmittedError) {
        setText((current) => current || payload);
        setPendingMedia((current) => current.length ? current : mediaPayload, true);
        removeOptimisticMessageFromCache(session.sessionKey, optimisticId);
        setOptimisticMessages((items) => items.filter((item) => item.id !== optimisticId));
      }
      setSendError(error instanceof CommandOutcomeUnknownError ? undefined : error instanceof Error ? error.message : String(error));
      return error instanceof CommandOutcomeUnknownError ? 'unknown' as const : 'unavailable' as const;
    } finally {
      setSending(false);
      window.setTimeout(() => {
        if (mayRestoreComposerFocus(inputRef.current, document.activeElement, document.body)) inputRef.current?.focus({ preventScroll: true });
      }, 0);
    }
  }

  const messageTooLong = text.length > COMPOSER_MAX_MESSAGE_CHARS;
  const sendDisabled = sending || uploads.preparing || messageTooLong || (!text.trim() && pendingMedia.length === 0);
  const desktopMessagePane = useMemo(() => <ToolDetailCacheContext.Provider value={desktopDetailCache}><div className="relative flex min-h-0 flex-1 flex-col">
    <section ref={scrollContainerRef} onScroll={rememberScrollIntent} className="message-selection-surface min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.08),transparent_26rem)] px-5 py-2 md:px-6 md:py-3 xl:px-5" aria-live="polite">
    <div ref={contentRef} className="flow-root space-y-1.5">
    {messagesLoading && conversationMessages.length === 0 ? <LoadingCard text="Loading messages…" className="mx-auto mt-10 max-w-sm" /> : null}
    {!messagesLoading && conversationMessages.length === 0 ? <Card className="mx-auto mt-10 max-w-sm border-dashed border-blue-200 bg-blue-50/55 p-5 text-center text-sm leading-6 text-blue-800">{tr("No messages yet. Send a message to start this web session.")}</Card> : null}
    {historyLoading ? <div className="mx-auto w-fit rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[0.68rem] font-bold text-blue-700">{tr("Loading older history…")}</div> : null}
    {desktopRenderItems.map((item) => item.kind === 'toolGroup'
      ? <DesktopToolTimeline messages={item.messages} key={`tool-group-${item.messages[0]?.toolCallId ?? item.messages[0]?.id ?? item.startIndex}`} />
      : <div
        data-message-search-id={item.message.id}
        data-final-reply={item.message.id === finalReply || undefined}
        className={messageSearchFrameClass(searchMatchIds.has(item.message.id), activeSearchMessageId === item.message.id)}
        key={`${item.message.sessionKey}:${item.message.id}`}
      ><QueueMessageControls.Provider value={desktopQueueControls}><DesktopMessageWithTools message={item.message} attachedTools={item.attachedTools} isRecent={item.index >= desktopVisibleMessages.length - 5} onMediaLoad={handleDesktopMediaLoad} /></QueueMessageControls.Provider>
      </div>)}
    <div ref={bottomRef} className="h-px" aria-hidden="true" />
    </div>
    </section>
    <div data-chat-activity className="flex min-h-10 shrink-0 items-center justify-center px-3 py-1"><RunProgressNotice session={displaySession} messages={messages} syncError={syncError} refreshing={Boolean(messagesRefreshing)} onRechecked={onSent} /></div>
    {hasMessagesBelow ? <button type="button" className="newer-messages-pill" onClick={() => scrollToBottom('auto', true)} aria-label={tr("Jump to latest messages")}>{tr('New messages below')} ↓</button> : null}
  </div></ToolDetailCacheContext.Provider>, [desktopDetailCache, finalReply, COMPOSER_MAX_MESSAGE_CHARS, tr, activeSearchMessageId, autoScrollEnabled, conversationMessages.length, desktopRenderItems, desktopVisibleMessages.length, hasMessagesBelow, historyLoading, messages, syncError, messagesLoading, messagesRefreshing, onLoadMoreHistory, onSent, renderedScrollKey, searchMatchIds, displaySession, queueActive, queueDraft, setQueueDraft, desktopQueueControls, handleDesktopMediaLoad]);

  return <section data-font-area="chat" className="desktop-session-frame flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/70 bg-white/64 md:rounded-[1.6rem] xl:rounded-[2rem]">
    <PaneStatusControls>
      <PaneStatus label={presentation.label} state={presentation.state}>
        <dl className="pane-context-identity">
          <div><dt>{tr('Environment')}</dt><dd>{readableEnvLabel((session as SessionSummary & { envConnectionLabel?: string }).envConnectionLabel) ?? tr('local')}</dd></div>
          <div><dt>{tr('Agent')}</dt><dd>{shortAgent(session.agentId ?? 'unknown')}</dd></div>
        </dl>
        <DesktopHeaderStatusStrip session={displaySession} messages={renderedMessages} deliveryMode={deliveryMode} />
        {syncIssueLabel ? <HistorySyncIssue label={syncIssueLabel} detail={syncError ?? session.runtime?.reason} onRetry={onRetrySync} /> : null}
      </PaneStatus>
      {session.source === 'codex' ? <SessionGoalControl key={`goal:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
      {session.source === 'codex' ? <SessionAutomationControl key={`automation:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
      {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionGuidanceControl key={`guidance:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
      {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionInteractions key={`interactions:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
      <SessionFiles caption key={`files:${recoveryScope()}:${session.sessionKey}`} session={session} sessionKey={session.sessionKey} messages={renderedMessages} />
      <SessionNotebook caption key={`notebook:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} title={session.title || session.sessionKey} />
      {session.source === 'codex' ? <SessionSkills caption key={`skills:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
      {session.source === 'codex' ? <SessionSharing key={`${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} placement="toolbar" /> : null}
      <AutoScrollControl enabled={autoScrollEnabled} onChange={toggleAutoScroll} />
      <button type="button" data-caption-priority={30} className="pane-compact-control" disabled={compacting || isSessionBusy(session) || !sessionRuntimeUi(session).compact}
        onClick={() => void compactSession()} aria-label={tr('Compact session')}
        title={tr(!sessionRuntimeUi(session).compact ? 'This Agent does not support manual compaction' : 'Compact session')}><Sparkles size={13} /></button>
      <CaptionPanel priority={80} label={tr('Session model')} icon={<Bot size={13} />} openEvent="agentopsdeck:session-model">
        {(_close, open) => <>
          <h3 className="mb-2 font-semibold">{tr('Session model')}</h3>
          <div data-cod145="desktop-session-model-selector" className="min-w-0 max-w-full shrink">
            <SessionModelOverrideControl session={session} onUpdated={onRenamed} active={open} />
          </div>
        </>}
      </CaptionPanel>
      {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionTokenUsage caption sessionKey={session.sessionKey} /> : null}
      <CaptionIconButton priority={45} label={tr('Toggle card connections')} draggable data-binding-drag title={tr('Drag to link a card')}
        onClick={event => event.currentTarget.closest('[data-workspace-pane]')?.dispatchEvent(new Event('agentopsdeck:binding-lines', { bubbles: true }))}><Eye size={15} /></CaptionIconButton>
      <CaptionIconButton priority={20} label={tr('Rename session')} onClick={() => renameSessionDialog(session, onRenamed)}><Pencil size={15} /></CaptionIconButton>
      <CaptionIconButton priority={15} label={tr(session.hidden ? 'Restore session' : 'Hide session')} disabled={hiding} onClick={() => void toggleSessionHidden()}>{session.hidden ? <Eye size={15} /> : <EyeOff size={15} />}</CaptionIconButton>
      <CaptionIconButton priority={10} label={tr(session.archived ? 'Unarchive session' : 'Archive session')} disabled={archiving} onClick={() => void toggleSessionArchived()}>{session.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</CaptionIconButton>
      <CaptionIconButton priority={0} label={tr(deleting ? 'Deleting…' : 'Delete session…')} className="is-destructive" disabled={deleting || !sessionRuntimeUi(session).deleteSession}
        title={!sessionRuntimeUi(session).deleteSession ? tr('Native session deletion is not supported by this Agent') : undefined} onClick={() => void deleteSession()}><Trash2 size={15} /></CaptionIconButton>
          <MessageSearchBar
            caption
            value={messageSearch}
            onChange={setMessageSearch}
            total={searchMatches.length}
            activeIndex={activeSearchIndex}
            onPrevious={() => setActiveSearchIndex((index) => searchMatches.length ? (index - 1 + searchMatches.length) % searchMatches.length : 0)}
            onNext={() => setActiveSearchIndex((index) => searchMatches.length ? (index + 1) % searchMatches.length : 0)}
          />
    </PaneStatusControls>
    <PaneTitle><SessionTitleEditor session={session} titleClassName="truncate text-sm font-bold leading-snug" onRenamed={onRenamed} /></PaneTitle>
    <div data-session-state={presentation.state} className="session-state-header contents" />
    {shouldMountSessionWatermark(session, conversationMessages.length) ? (
      <SessionVolumeWatermarkBanner
        session={session}
        messages={conversationMessages}
        deliveryMode={deliveryMode}
        maxMessageChars={COMPOSER_MAX_MESSAGE_CHARS}
      />
    ) : null}
    {compactNotice ? <p className="shrink-0 rounded-xl border border-blue-100 bg-blue-50/80 px-2 py-1 text-xs font-semibold text-blue-800" role="status">{translate(compactProgressLabel(session) ?? compactNotice)}</p> : null}
    {desktopMessagePane}
    {maxMessageChars !== undefined && COMPOSER_MAX_MESSAGE_CHARS < MAX_MESSAGE_CHARS ? <p className="shrink-0 px-4 py-1 text-xs text-slate-500" role="status">{tr('This Connector currently allows {limit} characters. Upgrade it to support longer messages.', { limit: formatNumber(COMPOSER_MAX_MESSAGE_CHARS) })}</p> : null}
    <div className="desktop-composer-dock" data-busy={sending || uploads.preparing || voiceState === 'listening' || !!sendError || !!voiceError}>
    <button type="button" className="composer-reveal" onClick={() => {
      const pane = inputRef.current?.closest<HTMLElement>('[data-workspace-pane],[data-os-window]');
      if (pane) { delete pane.dataset.composerReading; delete pane.dataset.composerCollapsed; pane.dataset.hoverComposer = 'true'; }
      inputRef.current?.focus({ preventScroll: true });
    }}><Pencil size={13} /><span>{tr(text || pendingMedia.length ? 'Continue draft' : 'Write a message')}</span></button>
    <form className="desktop-message-form shrink-0 flex flex-col gap-2 border-t border-white/60 bg-white/82 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] xl:gap-2.5 xl:px-4 xl:py-3" onSubmit={async (event) => {
      event.preventDefault();
      await submitMessage();
    }}>
      {queueDraft && !renderedMessages.some(message => message.id === queueDraft.id && hasQueuedMessageControls(message, queueActive)) ? <QueuedMessageActions maxMessageChars={COMPOSER_MAX_MESSAGE_CHARS} messages={[]} sessionKey={session.sessionKey} onSent={onSent} draft={queueDraft} setDraft={setQueueDraft} /> : null}
      <input name="main-input-3" ref={fileInputRef} className="hidden" type="file" accept={sessionRuntimeUi(session).sdk ? sdkAttachmentAccept : COMPOSER_ACCEPTED_ATTACHMENTS} multiple onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = '';
        void uploads.add(files);
      }} />
      <div className="relative min-w-0 rounded-[1.25rem] border border-slate-200/90 bg-white/92 p-1.5 transition focus-within:border-slate-300">
        <CommandRecoveryNotice sessionKey={session.sessionKey} onRecovered={onSent} />
        {sendError ? <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{sendError}</div> : null}
        {historyDelayed ? <AdmissionHistoryNotice /> : null}
        {uploads.preparing ? <div className="px-3 py-1 text-xs text-slate-600" role="status">{tr('Preparing attachments…')}</div> : null}
        {voiceError ? <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{translate(voiceError)}</div> : null}
        {pendingMedia.length ? <div className="mb-2 flex flex-wrap gap-2 px-1" aria-label={tr("Pending attachments")}>{pendingMedia.map((item, index) => <PendingAttachmentPreview item={item} size="desktop" onRemove={() => setPendingMedia((items) => items.filter((_, itemIndex) => itemIndex !== index))} key={`${item.name}:${index}`} />)}</div> : null}
        <LongTextReference text={text} editable>
        <textarea name="main-textarea-4" className="desktop-composer-textarea block max-h-[160px] min-h-[76px] w-full resize-none overflow-y-hidden border-0 bg-white/95 px-3 py-2.5 !text-[12px] font-medium !leading-[1.25] text-slate-950 caret-blue-600 outline-none placeholder:font-medium placeholder:text-slate-500 transition-colors hover:bg-white focus:bg-white focus:text-slate-950 focus:caret-blue-600 focus:ring-0 disabled:bg-slate-50 disabled:text-slate-500 xl:max-h-[220px] xl:min-h-[104px] xl:py-3" ref={inputRef} value={text} rows={3} onPaste={uploads.paste} onChange={(event) => {
          if (recognitionRef.current) discardVoiceInput();
          setText(event.target.value);
          if (sendError) setSendError(undefined);
        }} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            void submitMessage();
          }
        }} placeholder={tr(queueActive ? 'Previous run is active; your message will be queued…' : 'Message this agent…')} />
        </LongTextReference>
        <div className="desktop-composer-toolbar flex items-center gap-2 border-t border-slate-100 px-2 pt-1.5 pb-0.5" aria-label={tr("Composer tools")}>
          <div className="min-w-0 flex-1 text-[0.66rem] font-semibold text-slate-400">
            <span className="block truncate">{pendingMedia.length ? tr('{count}/{max} attachments · {size}', { count: pendingMedia.length, max: COMPOSER_MAX_MEDIA_ITEMS, size: formatBytes(pendingMedia.reduce((sum, item) => sum + (item.size ?? estimateDataUrlBytes(item.dataUrl)), 0)) }) : tr('Enter to send · Shift+Enter newline')}</span>
            <span className={cn('tabular-nums', messageTooLong && 'text-red-600')}>{formatNumber(text.length)}/{formatNumber(COMPOSER_MAX_MESSAGE_CHARS)}</span>
          </div>
          <Button variant="ghost" size="icon" className="composer-action" data-listening={voiceState === 'listening'} type="button" disabled={sending} onClick={toggleVoiceInput} aria-pressed={voiceState === 'listening'} aria-label={tr(voiceState === 'listening' ? 'Stop voice input' : 'Start voice input')} title={translate(voiceState === 'unsupported' ? (getVoiceUnavailableReason() ?? 'Voice input unavailable') : 'Dictate editable text')}><Mic size={18} /></Button>
          <Button variant="ghost" size="icon" className="composer-action" type="button" disabled={sending || !sessionRuntimeUi(session).attachments} onClick={() => fileInputRef.current?.click()} aria-label={tr("Attach file")} title={tr(!sessionRuntimeUi(session).attachments ? 'This Agent accepts text only' : sessionRuntimeUi(session).sdk ? sdkAttachmentHint : 'Attach file (max 12MB)')}><Paperclip size={18} /></Button>
          <Button variant="ghost" size="icon" className="composer-action composer-collapse-btn" type="button" onClick={() => {
            const pane = inputRef.current?.closest<HTMLElement>('[data-workspace-pane],[data-os-window]');
            if (pane) {
              pane.dataset.composerCollapsed = 'true';
              delete pane.dataset.hoverComposer;
            }
            inputRef.current?.blur();
          }} aria-label={tr("Collapse message box")} title={tr("Collapse message box")}><ChevronDown size={17} /></Button>
          <Button className="composer-send" disabled={sendDisabled} aria-label={tr("Send message")}>{sending ? '...' : <><Send size={17} /> {tr(queueActive ? 'Queue' : 'Send')}</>}</Button>
        </div>
      </div>
    </form>
    </div>
  </section>;
}

function mobileSavedSessionStorageKey() {
  return `agentopsdeck.mobileActiveSessionKey:${recoveryScope() || 'default'}`;
}
function readSavedMobileSessionKey(): string | undefined {
  try {
    return window.localStorage.getItem(mobileSavedSessionStorageKey())?.trim() || undefined;
  } catch {
    return undefined;
  }
}
function writeSavedMobileSessionKey(sessionKey: string | undefined) {
  try {
    const key = mobileSavedSessionStorageKey();
    if (sessionKey) window.localStorage.setItem(key, sessionKey);
    else window.localStorage.removeItem(key);
  } catch {}
}

function MobileApp() {
  const { t: tr } = useI18n();
  const [historyIssue, setHistoryIssue] = useState<{ key: string; detail: string }>();
  const [olderHistoryIssue, setOlderHistoryIssue] = useState<{ key: string; detail: string }>();
  const [tab, setTabState] = useState<Tab>(() => readHashRoute().tab ?? 'sessions');
  const [sessionsState, setSessionsState] = useState<HubSessionsState>(initialSessionsState);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [gateway, setGateway] = useState<GatewayHealth>();
  const initialRoute = readHashRoute();
  const initialMobileSessionKey = initialRoute.sessionKey || (!initialRoute.tab ? readSavedMobileSessionKey() : undefined);
  const initialMobileSession = initialMobileSessionKey
    ? initialSessionsState().groups.flatMap((g) => g.sessions).find((s) => s.sessionKey === initialMobileSessionKey)
    : undefined;
  const [selected, setSelectedState] = useState<SessionSummary | undefined>(initialMobileSession);
  const latestSelectedSession = useRef(selected);
  const messageLiveRefresh = useRef<ReturnType<typeof startLiveRefresh> | undefined>(undefined);
  latestSelectedSession.current = selected;
  const selectedKeyRef = useRef<string | undefined>(initialMobileSession?.sessionKey);
  const [messageState, setMessageState] = useState<MessageState>(() =>
    initialMobileSession ? messageStateForSession(initialMobileSession.sessionKey, MESSAGE_MOBILE_INITIAL_LOAD_LIMIT) : { items: [], loading: true }
  );
  const [error, setError] = useState<string>();
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionGroupId, setNewSessionGroupId] = useState('');
  const messageLimitRef = useRef(MESSAGE_MOBILE_INITIAL_LOAD_LIMIT);
  const sessionsRevisionRef = useRef<string | undefined>(sessionsState.revision);
  // Cache-write dedup only; rendered revision belongs to messageState.items.
  const messageRevisionRef = useRef<Record<string, string | undefined>>({});
  const sessionRequests = useSnapshotRequestGate();
  const messageRequests = useMessageSnapshotRequestGate(selectedKeyRef);
  const { readLatestMessages, isHistoryCached, cachedHistory, refreshing: messagesRefreshing } = useLatestMessages(selected?.sessionKey, messageState.items.length > 0);
  const sessionSourcesRef = useRef(sessionsState.sourceStates);
  const homeSessions = useMemo(
    () => sessionsState.groups.flatMap((group) => group.sessions).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)),
    [sessionsState],
  );
  useHotSessionPreload({ sessions: homeSessions, activeSessionKey: selected?.sessionKey, mobile: true, initialMessageLimit: MESSAGE_MOBILE_INITIAL_LOAD_LIMIT });

  function setTab(nextTab: Tab) {
    setTabState(nextTab);
    if (!selected) writeHashRoute({ tab: nextTab });
  }

  function setSelected(nextSession: SessionSummary | undefined) {
    selectedKeyRef.current = nextSession?.sessionKey;
    writeSavedMobileSessionKey(nextSession?.sessionKey);
    recordSessionAccess(nextSession?.sessionKey);
    markSessionMessagesSeen(nextSession);
    setSelectedState(nextSession);
    if (nextSession) writeHashRoute({ sessionKey: nextSession.sessionKey });
    else writeHashRoute({ tab });
    messageLimitRef.current = MESSAGE_MOBILE_INITIAL_LOAD_LIMIT;
    setMessageState(nextSession ? messageStateForSession(nextSession.sessionKey, MESSAGE_MOBILE_INITIAL_LOAD_LIMIT) : { items: [], loading: false });
  }

  async function refresh() {
    const currentRequest = sessionRequests.begin();
    setError(undefined);
    try {
      const skipMeta = Boolean(selectedKeyRef.current && latestSelectedSession.current && agents.length > 0 && gateway !== undefined);
      const [snapshot, agentData, gatewayData] = await Promise.all([
        api.sessionsState(),
        skipMeta ? Promise.resolve(undefined) : api.agents(METADATA_MAX_AGE_MS).catch(() => undefined),
        skipMeta ? Promise.resolve(undefined) : api.gatewayStatus(METADATA_MAX_AGE_MS).catch(() => undefined),
      ]);
      const sessionData = currentRequest.accept(snapshot);
      if (!sessionData) return undefined;
      completionNotification.seed(sessionData.groups.flatMap(group => group.sessions));
      const activeSessionKey = selectedKeyRef.current;
      const invalidNodes = invalidatedSessionNodes(sessionSourcesRef.current, sessionData.sourceStates, activeSessionKey);
      sessionSourcesRef.current = sessionData.sourceStates;
      clearCachedNodeData(invalidNodes);
      const selectionInvalidated = activeSessionKey && invalidNodes.has(activeSessionKey.split(':')[0]!);
      if (selectionInvalidated) {
        messageRequests.invalidate();
        messageRevisionRef.current = {};
        setSelected(undefined);
        setError('Node access changed. Reopen the session after access is restored.');
      }
      if (!sessionData.revision || sessionData.revision !== sessionsRevisionRef.current) {
        sessionsRevisionRef.current = sessionData.revision;
        setSessionsState(sessionData);
        writeCachedSessionsState(sessionData);
      }
      if (agentData) setAgents(agentData.agents);
      if (gatewayData) setGateway(gatewayData);
      setNewSessionGroupId((current) => current || defaultCreateGroupId(sessionData, agentData?.agents ?? agents, gatewayData ?? gateway));
      const route = readHashRoute();
      const routeSessionKey = selectionInvalidated ? undefined : (activeSessionKey || route.sessionKey || (!route.tab ? readSavedMobileSessionKey() : undefined));
      if (routeSessionKey) {
        const found = sessionData.groups.flatMap((g) => g.sessions).find((s) => s.sessionKey === routeSessionKey);
        if (found) {
          const switched = selectedKeyRef.current !== found.sessionKey || latestSelectedSession.current?.sessionKey !== found.sessionKey;
          selectedKeyRef.current = found.sessionKey;
          setSelectedState(found);
          if (switched) {
            messageLimitRef.current = MESSAGE_MOBILE_INITIAL_LOAD_LIMIT;
            setMessageState(messageStateForSession(found.sessionKey, MESSAGE_MOBILE_INITIAL_LOAD_LIMIT));
          }
          return sessionData;
        }
        if (selected?.sessionKey === routeSessionKey) return sessionData;
      }
      return sessionData;
    } catch (err) {
      if (currentRequest()) setError(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async function refreshSelectedMessagesNow(sessionKey = selected?.sessionKey, options: { force?: boolean } = {}) {
    if (!sessionKey) return;
    const currentRequest = messageRequests.begin(sessionKey);
    if (!currentRequest()) return;
    const limit = messageLimitRef.current;
    setMessageState((current) => current.sessionKey === sessionKey
      ? { ...current, loading: current.items.length === 0 }
      : current.sessionKey === undefined
        ? { sessionKey, items: [], loading: true }
        : current);
    try {
      const data = await readLatestMessages(sessionKey, limit, options.force === true);
      if (!acceptMessagePage(currentRequest, data)) return;
      setHistoryIssue(data.historyStatus === 'cached' ? { key: sessionKey, detail: translate('Showing saved messages while history is verified.') } : undefined);
      const revisionKey = `${sessionKey}:${limit}`;
      const unchanged = !options.force && data.revision && messageRevisionRef.current[revisionKey] === data.revision;
      if (!unchanged && data.historyStatus !== 'cached') cacheServerMessages(sessionKey, data);
      if (data.revision) messageRevisionRef.current[revisionKey] = data.revision;
      setMessageState((current) => {
        if (current.sessionKey !== sessionKey && current.sessionKey !== undefined) return current;
        if (!options.force && hasMessageSnapshotRevision(current, sessionKey, limit, data.revision)) return { ...current, loading: false, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
        return { ...current, sessionKey, ...refreshHistory(current, data), revision: data.revision, loading: false, loadedLimit: limit, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
      });
    } catch (cause) {
      if (currentRequest()) {
        if (!isCancelledRead(cause)) setHistoryIssue({ key: sessionKey, detail: cause instanceof Error ? cause.message : String(cause) });
        setMessageState(current => current.sessionKey === sessionKey ? { ...current, loading: false } : current);
      }
      throw cause;
    }
  }

  async function refreshCurrentView() {
    invalidateSnapshotReads();
    await refresh();
    const sessionKey = selected?.sessionKey;
    if (sessionKey) await refreshSelectedMessagesNow(sessionKey, { force: true });
  }

  const { boost: boostSessionRefresh, schedule: scheduleSessionRefresh, prioritize: prioritizeSessionRefresh, complete: completeSessionRefresh } = useAdaptiveSessionRefresh(refresh);

  useEffect(() => {
    const onSessionHandoff = (event: Event) => {
      const detail = (event as CustomEvent<{ fromSessionKey: string; toSessionKey: string; session: SessionSummary }>).detail;
      if (!detail?.toSessionKey || !detail.session) return;
      setSessionsState((current) => ensureSessionInState(current, detail.session));
      setSelected(detail.session);
      prioritizeSessionRefresh();
    };
    window.addEventListener('agentopsdeck:session-handoff', onSessionHandoff);
    return () => window.removeEventListener('agentopsdeck:session-handoff', onSessionHandoff);
  });

  function applyRenamedSession(renamedSession: SessionEdit) {
    if ('settings' in renamedSession) { boostSessionRefresh(); return; }
    setSessionsState((current) => {
      const next = applySessionEditInState(current, renamedSession);
      writeCachedSessionsState(next);
      return next;
    });
    setSelectedState((current) => current ? applySessionEdit(current, renamedSession) : current);
    boostSessionRefresh();
  }

  useEffect(() => {
    if (selected) markSessionMessagesSeen(selected);
  }, [selected?.sessionKey, selected?.runCompletedAt]);

  async function createSession(target: NewSessionTarget, label = 'New web session') {
    const agentId = target.ownerUserId ? 'codex' : target.agentId;
    await createSessionForAgent(agentId, label, target.connectionId, target.ownerUserId);
  }

  useRetireOpenedCreation(selected?.sessionKey);

  async function createSessionForAgent(agentId: string, label = `New ${shortAgent(agentId)} session`, connectionId = 'local', ownerUserId?: string) {
    if (creatingSession) return;
    setError(undefined);
    setCreatingSession(true);
    const scope = recoveryScope();
    try {
      const title = label.trim() || `New ${shortAgent(agentId)} session`;
      await createSessionWithRecovery({ agentId, connectionId, ...(ownerUserId ? { ownerUserId } : {}) }, title, async (created) => {
        if (ownerUserId) {
          if (recoveryScope() === scope) window.location.hash = `#/session/${encodeURIComponent(sessionAddress({ ownerUserId, sessionId: created.key }).key)}`;
          return;
        }
        const sessionData = await refresh().catch(() => sessionsState);
        if (recoveryScope() !== scope) return;
        const session = findSessionByKey(sessionData, created.key) ?? newSessionSummary(created.key, agentId, title, connectionForId(sessionsState, connectionId));
        setSessionsState((current) => ensureSessionInState(current, session));
        setSelected(session);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSession(false);
    }
  }

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const sessionKey = selected.sessionKey;

    let appliedCursor: string | undefined;
    const unregisterCompletionView = registerCompletionView(sessionKey, cursor =>
      messageRequests.isCaughtUp() && completionHistoryCurrent(cursor, appliedCursor) && completionMetadataCurrent(latestSelectedSession.current));
    const messageRefresh = createQueuedRefresh(async (calibration) => {
      if (cancelled) return;
      const currentRequest = messageRequests.begin(sessionKey);
      if (!currentRequest()) return;
      setMessageState((current) => current.sessionKey === sessionKey
        ? { ...current, loading: current.items.length === 0 }
        : current.sessionKey === undefined
          ? { sessionKey, items: [], loading: true }
          : current);
      try {
        const limit = messageLimitRef.current;
        const data = await readLatestMessages(sessionKey, limit, false, calibration);
        if (cancelled || !acceptMessagePage(currentRequest, data)) return;
        const revisionKey = `${sessionKey}:${limit}`;
        appliedCursor = data.historyStatus === 'cached' ? undefined : data.sourceCursor;
        const unchanged = data.revision && messageRevisionRef.current[revisionKey] === data.revision;
        const preserveSelection = hasActiveMessageTextSelection();
        setHistoryIssue(data.historyStatus === 'cached' ? { key: sessionKey, detail: translate('Showing saved messages while history is verified.') } : undefined);
        if (!unchanged && !preserveSelection && data.historyStatus !== 'cached') cacheServerMessages(sessionKey, data);
        if (data.revision && !preserveSelection) messageRevisionRef.current[revisionKey] = data.revision;
        if (!cancelled) setMessageState((current) => {
          if (current.sessionKey !== sessionKey && current.sessionKey !== undefined) return current;
          if (hasMessageSnapshotRevision(current, sessionKey, limit, data.revision)) return { ...current, loading: false, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
          const history = refreshHistory(current, data);
          return { ...current, sessionKey, ...history, items: preserveSelection ? mergeSelectionSafeMessages(current.items, history.items) : history.items,
            revision: preserveSelection ? undefined : data.revision, loading: false, loadedLimit: limit, maxMessageChars: resolveMessageLimits(data.limits).maxMessageChars };
        });
        if (data.historyStatus !== 'cached') void completionDelivery.flush(sessionKey, []);
      } catch (err) {
        if (!cancelled && currentRequest()) {
          if (!isCancelledRead(err)) setHistoryIssue({ key: sessionKey, detail: err instanceof Error ? err.message : String(err) });
          setMessageState((current) => current.sessionKey === sessionKey ? { ...current, loading: false } : current);
        }
        throw err;
      }
    });
    const refreshSelectedMessages = (calibration?: boolean) => messageRefresh.run(calibration);

    const liveRefresh = startLiveRefresh(refreshSelectedMessages, unchanged => historyFallbackInterval(latestSelectedSession.current ?? { status: 'unknown' }, unchanged, requestGovernor.intervalMultiplier()), REALTIME_MESSAGE_REFRESH_DEBOUNCE_MS,
      () => adaptiveHistoryRefreshInterval(visibleSessionCount(), true), true, undefined,
      () => adaptiveActiveSessionSafetyInterval(visibleSessionCount(), true, isHistoryCached() || Boolean(latestSelectedSession.current && (hasQueueBlockingRun(latestSelectedSession.current) || hasOptimisticActiveSend(latestSelectedSession.current, false, readOptimisticMessages<ChatMessage>(recoveryScope(), sessionKey))))));
    messageLiveRefresh.current = liveRefresh;
    const scheduleRefreshSelectedMessages = liveRefresh.request;
    const unsubscribeCatchup = messageRequests.subscribe(scheduleRefreshSelectedMessages);
    const events = openDeckEventStream((event) => {
      if (!shouldRefreshMessagesForEvent(event, sessionKey)) return;
      if (event.type === 'stream.reset') messageRequests.invalidate();
      const changed = messageRequests.observe(event.remoteEventId, sessionKey);
      if (changed && isCompletionRefreshEvent(event)) return liveRefresh.complete();
      if (changed && isStreamCatchup(event)) return liveRefresh.prioritize();
      if (changed) scheduleRefreshSelectedMessages();
    });
    let hadSelection = hasActiveMessageTextSelection();
    const onSelectionChange = () => {
      const hasSelection = hasActiveMessageTextSelection();
      if (hadSelection && !hasSelection) scheduleRefreshSelectedMessages();
      hadSelection = hasSelection;
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      cancelled = true;
      messageRequests.invalidate();
      unregisterCompletionView();
      unsubscribeCatchup();
      liveRefresh.stop();
      if (messageLiveRefresh.current === liveRefresh) messageLiveRefresh.current = undefined;
      document.removeEventListener('selectionchange', onSelectionChange);
      events?.close();
    };
  }, [selected?.sessionKey]);

  useEffect(() => {
    const scheduleRefresh = scheduleSessionRefresh;
    const unsubscribeCatchup = sessionRequests.subscribe(scheduleRefresh);
    scheduleRefresh();
    const events = openDeckEventStream((event) => {
      if (event.type === 'stream.reset') sessionRequests.invalidate(event.envConnectionId);
      if (shouldRefreshSessionsForEvent(event) && sessionRequests.observe(event.envConnectionId, event.remoteEventId)) {
        if (isCompletionRefreshEvent(event)) return completeSessionRefresh();
        if (isStreamCatchup(event) || event.type === 'queued_message.sent') return prioritizeSessionRefresh();
        scheduleRefresh();
      }
    });
    const onHashChange = () => {
      const route = readHashRoute();
      if (route.tab) setTabState(route.tab);
      if (route.sessionKey) {
        selectedKeyRef.current = route.sessionKey;
        writeSavedMobileSessionKey(route.sessionKey);
        messageLimitRef.current = MESSAGE_MOBILE_INITIAL_LOAD_LIMIT;
        setMessageState(messageStateForSession(route.sessionKey, MESSAGE_MOBILE_INITIAL_LOAD_LIMIT));
      }
      if (!route.sessionKey) {
        selectedKeyRef.current = undefined;
        writeSavedMobileSessionKey(undefined);
        setSelectedState(undefined);
        setMessageState({ items: [] });
      }
      void refresh();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      sessionRequests.invalidate();
      unsubscribeCatchup();
      events?.close();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  useMessageMetadataCatchup(selected, messageLiveRefresh);

  async function loadMoreHistory(schedule?: HistoryReadSchedule, signal?: AbortSignal): Promise<HistoryBackfillOutcome> {
    if (!selected) return;
    const sessionKey = selected.sessionKey;
    const currentState = messageState.sessionKey === sessionKey ? messageState : undefined;
    if (!currentState || currentState.historyLoading || (currentState.hiddenCount ?? 0) <= 0) return;
    const before = currentState.items[0]?.id;
    if (!before) return;
    if (selectedKeyRef.current !== sessionKey) return 'superseded';
    setMessageState((current) => current.sessionKey === sessionKey ? { ...current, historyLoading: true } : current);
    try {
      const data = await api.sessionMessages(sessionKey, MESSAGE_HISTORY_PAGE_SIZE, signal, before, false, schedule);
      if (selectedKeyRef.current !== sessionKey) return 'superseded';
      setOlderHistoryIssue(undefined);
      setMessageState((current) => current.sessionKey === sessionKey ? { ...current, ...prependHistory(current.items, data, before), historyLoading: false } : current);
    } catch (err) {
      if (selectedKeyRef.current !== sessionKey || isCancelledRead(err)) return 'superseded';
      if (!isCancelledRead(err)) setOlderHistoryIssue({ key: sessionKey, detail: err instanceof Error ? err.message : String(err) });
      setMessageState((current) => current.sessionKey === sessionKey ? { ...current, historyLoading: false } : current);
      return 'retryable-error';
    } finally {
      setMessageState((current) => current.sessionKey === sessionKey ? { ...current, historyLoading: false } : current);
    }
  }

  if (selected) {
    return (
      <SessionDetail
        key={selected.sessionKey}
        session={selected}
        sessionsState={sessionsState}
        syncError={historyIssue?.key === selected.sessionKey ? historyIssue.detail : undefined}
        olderHistoryError={olderHistoryIssue?.key === selected.sessionKey ? olderHistoryIssue.detail : undefined}
        maxMessageChars={messageState.sessionKey === selected.sessionKey ? messageState.maxMessageChars : undefined}
        messages={messageState.sessionKey === selected.sessionKey ? messageState.items : []}
        messagesVerified={messageState.sessionKey === selected.sessionKey && (messageState.revision !== undefined || (!messageState.loading && !cachedHistory))}
        serverHiddenCount={messageState.sessionKey === selected.sessionKey ? messageState.hiddenCount : 0}
        messagesLoading={messageState.sessionKey === selected.sessionKey && Boolean(messageState.loading)}
        messagesRefreshing={messagesRefreshing || cachedHistory}
        historyLoading={messageState.sessionKey === selected.sessionKey && Boolean(messageState.historyLoading)}
        onLoadMoreHistory={loadMoreHistory}
        onBack={() => setSelected(undefined)}
        onOpen={setSelected}
        onRenamed={applyRenamedSession}
        onSent={async () => {
          const sessionKey = selected.sessionKey;
          boostSessionRefresh();
          messageLiveRefresh.current?.boost();
          await refreshSelectedMessagesNow(sessionKey, { force: true });
        }}
      />
    );
  }

  return (
    <>
      <main className="mobile-list-shell bg-slate-100 px-2.5 pb-[calc(54px+env(safe-area-inset-bottom))] pt-[max(4px,env(safe-area-inset-top))] text-slate-950">
        <header className="sticky top-0 z-20 -mx-2.5 mb-1.5 border-b border-white/70 bg-slate-100/92 px-2.5 pb-1.5 pt-[max(4px,env(safe-area-inset-top))] backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <h1 className="shrink-0 text-base font-black leading-tight tracking-[-0.03em] text-slate-950">{tr(navLabel(tab))}</h1>
                <p className="truncate text-[0.68rem] font-semibold text-slate-500">{tab === 'sessions' ? tr('{chats} chats · {agents} agents · {ago}', { chats: homeSessions.length, agents: sessionsState.groups.length, ago: formatAgo(sessionsState.updatedAt) }) : tr('Control surface')}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="secondary" size="icon" className="h-7 w-7 rounded-lg" onClick={() => void refreshCurrentView()} aria-label={tr("Refresh")}>
                <RefreshCcw size={14} />
              </Button>
              <BrowserSettings />
              <a href="#/remote" className="text-[0.68rem] font-semibold text-slate-600">{tr('Phone remote')}</a>
              <GlobalNotebookTrigger />
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg" onClick={() => void confirmSignOut()} aria-label={tr("Sign out")} title={tr("Sign out")}>
                <LogOut size={14} />
              </Button>
            </div>
          </div>
        </header>

        {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

        <CommandRecoveryNotice onRecovered={async () => { await refresh(); }} onCreated={(key, target) => {
          if (target.ownerUserId) {
            window.location.hash = `#/session/${encodeURIComponent(sessionAddress({ ownerUserId: target.ownerUserId, sessionId: key }).key)}`;
            return;
          }
          const session = findSessionByKey(sessionsState, key) ?? newSessionSummary(key, target.agentId, 'New session', connectionForId(sessionsState, target.connectionId));
          setSessionsState(current => ensureSessionInState(current, session));
          setSelected(session);
        }} />

        <section className="space-y-4">
          {tab === 'dashboard' ? <DashboardPage sessions={sessionsState} agents={agents} gateway={gateway} /> : null}
          {tab === 'sessions' ? <SessionsPage state={sessionsState} agents={agents} {...(gateway ? { gateway } : {})} creating={creatingSession} newGroupId={newSessionGroupId} onOpen={setSelected} onRenamed={applyRenamedSession} onCreate={(target, title) => {
            setNewSessionGroupId(target.groupId);
            return createSession(target, title);
          }} /> : null}
          {tab === 'agents' ? <AgentsPage agents={agents} sessions={sessionsState} creating={creatingSession} onOpenSession={setSelected} onCreateSession={(agentId, title) => void createSessionForAgent(agentId, title)} /> : null}
          {tab === 'media' ? <MediaLibrary /> : null}
          {tab === 'channels' ? <ChannelsPage sessions={sessionsState} onOpenSession={setSelected} /> : null}
          {tab === 'gateway' ? <GatewayPage gateway={gateway} {...(sessionsState.connections ? { hubConnections: sessionsState.connections } : {})} /> : null}
          {tab === 'users' ? <UsersAccessPage connections={sessionsState.connections ?? []} /> : null}
        </section>
      </main>
      <BottomNav tab={tab} setTab={setTab} />
    </>
  );
}

function SessionsPage({ state, agents, gateway, creating, newGroupId, onOpen, onCreate, onRenamed }: { state: HubSessionsState; agents: AgentSummary[]; gateway?: GatewayHealth; creating: boolean; newGroupId: string; onOpen: (session: SessionSummary) => void; onCreate: (target: NewSessionTarget, title: string) => Promise<void>; onRenamed: (session: SessionEdit) => Promise<void> | void }) {
  const { t: tr } = useI18n();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const orderedGroups = useMemo(() => [...state.groups].sort((a, b) => agentRank(a.agentId) - agentRank(b.agentId)), [state.groups]);
  const allSessions = useMemo(
    () => sortPinnedSessions(orderedGroups.flatMap((group) => group.sessions)),
    [orderedGroups],
  );
  const defaultGroupId = newGroupId || defaultCreateGroupId(state, agents, gateway, 'local');
  const [sessionSearch, setSessionSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'unread' | 'pinned'>('all');
  const deferredSessionSearch = useDeferredValue(sessionSearch);
  const runningCount = useMemo(() => allSessions.filter((session) => effectiveSessionStatus(session) === 'running').length, [allSessions]);
  const unreadCount = useMemo(() => allSessions.filter((session) => isSessionCompletionUnseen(session)).length, [allSessions]);
  const pinnedCount = useMemo(() => allSessions.filter((session) => Boolean(session.pinned)).length, [allSessions]);
  const filteredSessions = useMemo(() => allSessions.filter((session) => {
    if (!matchesSessionSearch(session, deferredSessionSearch)) return false;
    if (statusFilter === 'running') return effectiveSessionStatus(session) === 'running';
    if (statusFilter === 'unread') return isSessionCompletionUnseen(session);
    if (statusFilter === 'pinned') return Boolean(session.pinned);
    return true;
  }), [allSessions, deferredSessionSearch, statusFilter]);
  const now = useTicker(60_000);

  return (
    <div className="mobile-chats-panel space-y-1.5">
      <div className="mobile-chat-search flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
          <Input aria-label={tr("Search chats")} className="h-8 rounded-lg pl-8 pr-7 text-xs" placeholder={tr("Search chats or agents…")} value={sessionSearch} onChange={(event) => setSessionSearch(event.currentTarget.value)} />
          {sessionSearch ? <button type="button" className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-xs font-bold text-slate-400 transition active:scale-95 hover:bg-slate-100 hover:text-slate-700" onClick={() => setSessionSearch('')} aria-label={tr("Clear chat search")}>×</button> : null}
        </div>
        <Button size="sm" className="h-8 shrink-0 rounded-lg px-2.5 text-xs" disabled={creating} onClick={() => setCreateDialogOpen(true)} aria-label={tr("New chat")}>
          <Plus size={13} /> {creating ? '...' : tr('New chat')}
        </Button>
      </div>
      {allSessions.length > 0 && <div className="mobile-tactical-filter-bar" role="group" aria-label={tr("Filter chats")}>
        <button type="button" className={cn("mobile-tactical-chip", statusFilter === 'all' && "is-active")} aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}><span>{tr("All")}</span><strong>{allSessions.length}</strong></button>
        <button type="button" className={cn("mobile-tactical-chip is-running", statusFilter === 'running' && "is-active")} aria-pressed={statusFilter === 'running'} onClick={() => setStatusFilter(statusFilter === 'running' ? 'all' : 'running')}><span>{tr("Running")}</span><strong>{runningCount}</strong></button>
        <button type="button" className={cn("mobile-tactical-chip is-unread", statusFilter === 'unread' && "is-active")} aria-pressed={statusFilter === 'unread'} onClick={() => setStatusFilter(statusFilter === 'unread' ? 'all' : 'unread')}><span>{tr("Unread")}</span><strong>{unreadCount}</strong></button>
        <button type="button" className={cn("mobile-tactical-chip is-pinned", statusFilter === 'pinned' && "is-active")} aria-pressed={statusFilter === 'pinned'} onClick={() => setStatusFilter(statusFilter === 'pinned' ? 'all' : 'pinned')}><span>{tr("Pinned")}</span><strong>{pinnedCount}</strong></button>
      </div>}

      <section className="mobile-session-list" aria-label={tr("All chats")}>
        {allSessions.length === 0 ? <div className="mobile-session-empty"><p>{tr("No chats yet.")}</p><Button size="sm" disabled={creating} onClick={() => setCreateDialogOpen(true)}><Plus size={16} /> {creating ? tr("Creating…") : tr("New chat")}</Button></div> : null}
        {allSessions.length > 0 && filteredSessions.length === 0 ? <div className="mobile-session-empty">{tr('No chats match “{query}”.', { query: deferredSessionSearch.trim() })}</div> : null}
        <OrganizedSessions sessions={filteredSessions}>{session => <SessionCard key={session.sessionKey} session={session} now={now} onClick={() => onOpen(session)} onRenamed={onRenamed} />}</OrganizedSessions>
      </section>
      {createDialogOpen ? <NewSessionDialog
        open={createDialogOpen}
        creating={creating}
        environments={environmentOptions(state)}
        optionsForEnvironment={(connectionId) => agentGroupOptions(state, agents, gateway, connectionId)}
        initialConnectionId="local"
        initialGroupId={defaultGroupId}
        onClose={() => setCreateDialogOpen(false)}
        onCreate={async (target, title) => {
          await onCreate(target, title);
          setCreateDialogOpen(false);
        }}
      /> : null}
    </div>
  );
}

function SessionCard({ session, now, onClick, onRenamed }: { session: SessionSummary; now: number; onClick: () => void; onRenamed: (session: SessionEdit) => Promise<void> | void }) {
  const { t: tr } = useI18n();
  const [modelOpen, setModelOpen] = useState(false);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const [quickMessage, setQuickMessage] = useState(false);
  const closeQuickMessage = useCallback(() => setQuickMessage(false), []);
  const workspace = useWorkspacePreferences();
  const menu = useRef<HTMLDetailsElement>(null);
  const cardStatus = effectiveSessionStatus(session);
  const recent = session.recent?.trim() || displayModelName(session);
  const completionUnseen = isSessionCompletionUnseen(session);
  const runningLabel = runningDurationLabel(session, now);
  const isPinned = Boolean(session.pinned);
  return <div className="relative"><button data-session-card={session.sessionKey} data-session-state={sessionPresentation(session, completionUnseen).state} className="mobile-session-row group pr-9" style={sessionCssVars(session.sessionKey, workspace.value.sessions[session.sessionKey]?.color)} onClick={onClick} onContextMenu={event => { event.preventDefault(); if (menu.current) menu.current.open = true; }}>
    <span className="mobile-session-avatar" aria-hidden="true">
      {agentInitial(session.agentId)}
    </span>
    <span className="mobile-session-row-main">
      <span className="mobile-session-row-top mobile-session-title-row">
        <strong onDoubleClick={event => { event.stopPropagation(); renameSessionDialog(session, onRenamed); }}>{isPinned ? '📌 ' : ''}{displayTitle(session)}</strong>
        <time>{formatAgo(session.lastActiveAt)}</time>
      </span>
      <SessionIdentityRow session={session} />
      <span className="mobile-session-row-bottom">
        <small>{recent}</small>
        <span className={cn('mobile-session-status', `mobile-session-status--${cardStatus}`, completionUnseen && 'session-completion-unread', sessionRunOutcome(session) === 'completed' && 'mobile-session-status--done')}>{sessionListPrimaryStatusLabel({ status: cardStatus, runningLabel, completionUnseen, compact: true, outcome: sessionRunOutcome(session) })}</span>
      </span>
    </span>
    <span className="sr-only">{translate(sessionStatusLabel(cardStatus))}</span>
  </button><details ref={menu} className="mobile-session-actions"><summary aria-label={tr("Session actions")}>…</summary><div>
    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left" onClick={() => { if (menu.current) menu.current.open = false; setModelOpen(true); }}><Bot size={15} />{tr('Session model')}</button>
    {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionTokenUsage sessionKey={session.sessionKey} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left" onOpen={() => { if (menu.current) menu.current.open = false; }} /> : null}
    <button type="button" role="menuitem" disabled={session.archived} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-blue-700" onClick={() => { if (menu.current) menu.current.open = false; setQuickMessage(true); }}><Send size={15} />{tr('Quick message')}</button>
    <SessionOrganizationActions sessionKey={session.sessionKey} /><button type="button" role="menuitem" className="w-full rounded-xl px-3 py-2 text-left" onClick={() => { if (menu.current) menu.current.open = false; renameSessionDialog(session, onRenamed); }}>{tr('Rename session')}</button></div></details>
    {quickMessage ? <QuickSessionMessage session={session} onClose={closeQuickMessage} onAccepted={() => {}} /> : null}
    {modelOpen ? <SessionModelDialog session={session} onClose={closeModel} onUpdated={onRenamed} /> : null}
  </div>;
}

function SessionDetail({ syncError, olderHistoryError, maxMessageChars, session, sessionsState, messages, messagesVerified = true, serverHiddenCount = 0, messagesLoading, messagesRefreshing, historyLoading, onLoadMoreHistory, onBack, onOpen, onSent, onRenamed }: { syncError?: string | undefined; olderHistoryError?: string | undefined; maxMessageChars?: number | undefined; session: SessionSummary; sessionsState: HubSessionsState; messages: ChatMessage[]; messagesVerified?: boolean; serverHiddenCount?: number | undefined; messagesLoading?: boolean; messagesRefreshing?: boolean; historyLoading?: boolean; onLoadMoreHistory?: (schedule?: HistoryReadSchedule, signal?: AbortSignal) => Promise<HistoryBackfillOutcome>; onBack: () => void; onOpen: (session: SessionSummary) => void; onSent: () => Promise<void>; onRenamed: (renamedSession: SessionEdit) => Promise<void> | void }) {
  const { historyDelayed, refreshAccepted } = useAdmissionHistory(session.sessionKey, messages);
  useVisibleSessions([session.sessionKey]);
  const COMPOSER_MAX_MESSAGE_CHARS = maxMessageChars ?? LEGACY_MAX_MESSAGE_CHARS;
  const { t: tr } = useI18n();
  const tone = useSessionTone(session.sessionKey);
  const [text, setText] = useSessionTextDraft(session.sessionKey);
  const [sending, setSending] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string>();
  const [pendingMedia, setPendingMedia] = useComposerMedia(session.sessionKey);
  const [optimisticMessages, setOptimisticMessages] = useOptimisticSessionMessages(session.sessionKey, messages);
  useMessageRetryUpdates(session.sessionKey, setOptimisticMessages, onSent);
  const [hasMessagesBelow, setHasMessagesBelow] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [deliveryMode, setDeliveryModeState] = useState<SendDeliveryMode>(() => defaultDeliveryMode(session));
  const [messageSearch, setMessageSearch] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceState>(() => getVoiceUnavailableReason() ? 'unsupported' : 'idle');
  const [voiceError, setVoiceError] = useState<string>();
  const uploads = useComposerUploads(session.sessionKey, sessionRuntimeUi(session).attachments, sending, setPendingMedia, setVoiceError, filesToUploads, mergePendingUploads);
  usePageRefreshGuard(() => !sending && !uploads.isPreparing() && !pendingMedia.length && voiceState !== 'listening');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mergedMessages = useMemo(() => mergeMessages(messages, optimisticMessages), [messages, optimisticMessages]);
  const renderedMessages = useQueueObservation(session.sessionKey, mergedMessages);
  const queueActive = hasQueueBlockingRun(session) && messagesVerified;
  const [queueDraft, setQueueDraft] = useQueueDraft(session.sessionKey);
  const conversationMessages = renderedMessages;
  useEffect(() => {
    publishLiveSessionMessages(session.sessionKey, session, conversationMessages, Boolean(syncError));
  }, [session.sessionKey, session, conversationMessages, syncError]);
  const { visible: visibleMobileMessages, loadOlder: loadOlderMessages } = useMessageHistory({ messages: conversationMessages,
    hiddenCount: serverHiddenCount, loading: historyLoading || messagesLoading, loadMore: onLoadMoreHistory,
    containerRef: scrollContainerRef, followingRef: stickToBottomRef, autoScrollEnabled });
  const mobileProjector = useMemo(() => createDesktopMessageProjector(), [session.sessionKey]);
  const deferredMessageSearch = useDeferredValue(messageSearch);
  const searchMatches = useMemo(() => messageSearchMatches(visibleMobileMessages, deferredMessageSearch), [visibleMobileMessages, deferredMessageSearch]);
  const searchMatchIds = useMemo(() => new Set(searchMatches.map((match) => match.id)), [searchMatches]);
  const activeSearchMessageId = searchMatches[activeSearchIndex]?.id;
  const allMobileRenderItems = useMemo(() => mobileProjector(visibleMobileMessages), [mobileProjector, visibleMobileMessages]);
  const mobileRenderItems = useProgressiveTailRenderItems({
    sessionKey: session.sessionKey,
    items: allMobileRenderItems,
    bypass: Boolean(deferredMessageSearch) || !stickToBottomRef.current,
    containerRef: scrollContainerRef,
    followingRef: stickToBottomRef,
    autoScrollEnabled,
  });
  const finalReply = useMemo(() => completedReplyId(session, mobileRenderItems.flatMap(item => item.kind === 'message' ? [item.message] : [])), [session, mobileRenderItems]);
  useCompletionAutoRead(scrollContainerRef, session, finalReply, !messagesLoading && !messagesRefreshing && !syncError
    && finalReplyMatchesTurn(session, messages.find(message => message.id === finalReply)), markSessionCompletionSeen);
  const renderedScrollKey = useMemo(() => messageScrollKey(conversationMessages), [conversationMessages]);

  const { contentRef, scrollToBottom, handleScroll, pauseFollowing } = useChatAutoScroll({
    containerRef: scrollContainerRef,
    followingRef: stickToBottomRef,
    enabled: autoScrollEnabled,
    selectionActive: () => hasTextSelectionInside(scrollContainerRef.current),
    onMessagesBelowChange: setHasMessagesBelow,
  });

  const rememberScrollIntent = () => {
    const container = scrollContainerRef.current;
    handleScroll();
    if (!container || stickToBottomRef.current || container.scrollTop > MESSAGE_HISTORY_TOP_THRESHOLD_PX) return;
    void loadOlderMessages();
  };

  const toggleAutoScroll = () => {
    const nextEnabled = !autoScrollEnabled;
    setAutoScrollEnabled(nextEnabled);
    if (nextEnabled) {
      stickToBottomRef.current = true;
      settleScrollToBottom('smooth', true);
    } else {
      pauseFollowing();
    }
  };

  const settleScrollToBottom = (behavior: ScrollBehavior = 'auto', manual = false) => {
    scrollToBottom(behavior, manual);
    const timers = [50, 160, 360].map((delay) => window.setTimeout(() => scrollToBottom(behavior, manual), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  };
  const mobileQueueControls = useMemo<React.ContextType<typeof QueueMessageControls>>(() => ({
    active: queueActive,
    editingId: queueDraft?.id,
    render: (message, onCancelled) => <QueuedMessageActions maxMessageChars={COMPOSER_MAX_MESSAGE_CHARS} messages={[message]} sessionKey={session.sessionKey} onSent={onSent} onCancelled={onCancelled} draft={queueDraft?.id === message.id ? queueDraft : null} setDraft={setQueueDraft} editingElsewhere={!!queueDraft && queueDraft.id !== message.id} />,
  }), [queueActive, queueDraft, COMPOSER_MAX_MESSAGE_CHARS, session.sessionKey, onSent, setQueueDraft]);
  const handleMobileMediaLoad = useCallback(() => {
    if (autoScrollEnabled && stickToBottomRef.current) settleScrollToBottom('auto');
  }, [autoScrollEnabled, scrollToBottom]);

  useEffect(() => {
    setCompactNotice(undefined);
    setDeliveryModeState(readDeliveryMode(session));
    setAutoScrollEnabled(true);
    stickToBottomRef.current = true;
    setHasMessagesBelow(false);
    return settleScrollToBottom('auto');
  }, [session.sessionKey]);

  useEffect(() => {
    scrollToBottom();
  }, [autoScrollEnabled, renderedScrollKey]);

  useEffect(() => {
    if (autoScrollEnabled && !messagesLoading && messages.length > 0) {
      return settleScrollToBottom('auto');
    }
    return undefined;
  }, [autoScrollEnabled, messagesLoading, session.sessionKey]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [deferredMessageSearch, session.sessionKey]);

  useEffect(() => {
    if (!activeSearchMessageId) return;
    pauseFollowing();
    scrollContainerRef.current?.querySelector(`[data-message-search-id="${cssEscape(activeSearchMessageId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [activeSearchMessageId]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    if (!text) {
      if (textarea.style.height !== '34px') textarea.style.height = '34px';
      return;
    }
    const prevHeight = textarea.style.height;
    textarea.style.height = 'auto';
    const nextHeight = `${Math.max(34, Math.min(textarea.scrollHeight, 112))}px`;
    textarea.style.height = prevHeight;
    if (prevHeight !== nextHeight) textarea.style.height = nextHeight;
  }, [text, pendingMedia.length]);

  const viewportMetricsRef = useRef<{ layoutHeight: number; keyboardOffset: number }>({ layoutHeight: 0, keyboardOffset: 0 });
  const syncMobileViewport = () => {
    const viewport = window.visualViewport;
    if (!isTextEntryElement(document.activeElement) && (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0)) {
      window.scrollTo(0, 0);
    }
    // Keep the shell height stable, but expose the system-keyboard overlap as a
    // CSS variable so the web composer can sit just above the native keyboard.
    // iPadOS/Safari can keep reporting a shrunken visualViewport after focus is
    // gone (idle/blur/visibility transitions). Treat that as stale state unless
    // a text-entry element still owns focus; otherwise the padding becomes a
    // grey bottom spacer that pushes the composer upward.
    const { layoutHeight, keyboardOffset } = computeViewportKeyboardMetrics({
      windowInnerHeight: window.innerHeight,
      documentClientHeight: document.documentElement.clientHeight,
      visualViewportHeight: viewport?.height,
      visualViewportOffsetTop: viewport?.offsetTop,
      editableFocused: isTextEntryElement(document.activeElement),
    });
    const prevMetrics = viewportMetricsRef.current;
    const significantChange = prevMetrics.layoutHeight === 0
      || Math.abs(layoutHeight - prevMetrics.layoutHeight) >= 4
      || Math.abs(keyboardOffset - prevMetrics.keyboardOffset) >= 4;
    if (!significantChange) return false;
    viewportMetricsRef.current = { layoutHeight, keyboardOffset };
    const nextVh = `${layoutHeight}px`;
    const nextOffset = `${keyboardOffset}px`;
    const changed = document.documentElement.style.getPropertyValue('--aod-mobile-vh') !== nextVh
      || document.documentElement.style.getPropertyValue('--aod-keyboard-offset') !== nextOffset;
    document.documentElement.style.setProperty('--aod-mobile-vh', nextVh);
    document.documentElement.style.setProperty('--aod-keyboard-offset', nextOffset);
    return changed;
  };

  const resetMobileKeyboardOffset = () => {
    document.documentElement.style.setProperty('--aod-keyboard-offset', '0px');
  };

  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  autoScrollEnabledRef.current = autoScrollEnabled;
  const mobileViewportTimersRef = useRef(new Set<number>());
  const mobileViewportCleanupsRef = useRef(new Set<() => void>());
  const clearMobileViewportTimers = () => {
    mobileViewportTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    mobileViewportTimersRef.current.clear();
    mobileViewportCleanupsRef.current.forEach((cleanup) => cleanup());
    mobileViewportCleanupsRef.current.clear();
  };
  const scheduleMobileViewportTimer = (callback: () => void, delay: number) => {
    const timerId = window.setTimeout(() => {
      mobileViewportTimersRef.current.delete(timerId);
      callback();
    }, delay);
    mobileViewportTimersRef.current.add(timerId);
  };
  const runTrackedMobileSettleScroll = () => {
    const cleanup = settleScrollToBottom('auto');
    mobileViewportCleanupsRef.current.add(cleanup);
  };

  const settleMobileViewport = () => {
    [0, 80, 220, 420].forEach((delay) => scheduleMobileViewportTimer(() => {
      const changed = syncMobileViewport();
      if (changed && autoScrollEnabledRef.current && stickToBottomRef.current && !hasTextSelectionInside(scrollContainerRef.current)) {
        runTrackedMobileSettleScroll();
      }
    }, delay));
  };

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    syncMobileViewport();
  }, [session.sessionKey]);

  useEffect(() => {
    const updateViewportHeight = () => {
      const changed = syncMobileViewport();
      if (changed && autoScrollEnabledRef.current && stickToBottomRef.current && !hasTextSelectionInside(scrollContainerRef.current)) {
        scheduleMobileViewportTimer(() => {
          if (autoScrollEnabledRef.current && stickToBottomRef.current && !hasTextSelectionInside(scrollContainerRef.current)) {
            runTrackedMobileSettleScroll();
          }
        }, 40);
      }
    };
    const settleAfterFocusTransition = () => settleMobileViewport();
    const resetHiddenViewport = () => {
      resetMobileKeyboardOffset();
      if (!document.hidden) settleMobileViewport();
    };
    updateViewportHeight();
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateViewportHeight);
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('focusin', settleAfterFocusTransition);
    window.addEventListener('focusout', settleAfterFocusTransition);
    window.addEventListener('blur', resetMobileKeyboardOffset);
    window.addEventListener('pagehide', resetMobileKeyboardOffset);
    document.addEventListener('visibilitychange', resetHiddenViewport);
    return () => {
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateViewportHeight);
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('focusin', settleAfterFocusTransition);
      window.removeEventListener('focusout', settleAfterFocusTransition);
      window.removeEventListener('blur', resetMobileKeyboardOffset);
      window.removeEventListener('pagehide', resetMobileKeyboardOffset);
      document.removeEventListener('visibilitychange', resetHiddenViewport);
      clearMobileViewportTimers();
      resetMobileKeyboardOffset();
    };
  }, [session.sessionKey]);

  function discardVoiceInput() {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
    setVoiceState(getVoiceUnavailableReason() ? 'unsupported' : 'idle');
  }
  useEffect(() => {
    setVoiceError(undefined);
    setVoiceState(getVoiceUnavailableReason() ? 'unsupported' : 'idle');
    const expire = () => discardVoiceInput();
    window.addEventListener('agentopsdeck:auth-required', expire);
    window.addEventListener('pagehide', expire);
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.abort();
      window.removeEventListener('agentopsdeck:auth-required', expire);
      window.removeEventListener('pagehide', expire);
    };
  }, [session.sessionKey, recoveryScope(), recoveryEpoch()]);

  async function stopRun() {
    if (session.runtime?.stopRequested) return;
    setVoiceError(undefined);
    try {
      await sendMessageWithRecovery(session.sessionKey, '/stop', 'web-only', [], newCommandKey(), session.runtime?.turnId);
      await onSent();
    } catch (error) {
      setVoiceError(error instanceof CommandOutcomeUnknownError ? undefined : error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleSessionPinned() {
    if (pinning) return;
    const nextPinned = !session.pinned;
    setPinning(true);
    setVoiceError(undefined);
    try {
      await api.pinSession(session.sessionKey, nextPinned);
      await onRenamed({ sessionKey: session.sessionKey, pinned: nextPinned });
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : String(error));
    } finally {
      setPinning(false);
    }
  }

  async function compactSession() {
    if (compacting || isSessionBusy(session) || !sessionRuntimeUi(session).compact) return;
    setCompacting(true);
    setVoiceError(undefined);
    setCompactNotice(undefined);
    try {
      const result = await compactSessionWithRecovery(session.sessionKey, sessionRuntimeUi(session).sdk);
      setCompactNotice(compactResponseNotice(result, compactRequestMessage(session)));
      await onSent();
      if (autoScrollEnabled) settleScrollToBottom('smooth');
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompacting(false);
    }
  }

  function toggleVoiceInput() {
    if (voiceState === 'listening') {
      recognitionRef.current?.stop();
      return;
    }

    const unavailableReason = getVoiceUnavailableReason();
    if (unavailableReason) {
      setVoiceState('unsupported');
      setVoiceError(unavailableReason);
      return;
    }

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setVoiceState('unsupported');
      setVoiceError('This browser does not support speech recognition. You can still type and send normally.');
      return;
    }

    const recognition = new Recognition();
    const baseText = text.trimEnd();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      if (recognitionRef.current !== recognition) return;
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i]?.[0]?.transcript ?? '';
      }
      const nextText = [baseText, transcript.trim()].filter(Boolean).join(baseText ? '\n' : '');
      setText(nextText);
      window.setTimeout(() => { if (mayRestoreComposerFocus(inputRef.current, document.activeElement, document.body)) inputRef.current?.focus({ preventScroll: true }); }, 0);
    };
    recognition.onerror = (event: any) => {
      if (recognitionRef.current !== recognition) return;
      if (event?.error === 'no-speech' || event?.error === 'aborted') {
        setVoiceError(undefined);
        setVoiceState('idle');
        return;
      }
      setVoiceError(voiceRecognitionError(event?.error));
      setVoiceState('idle');
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setVoiceState((current) => current === 'unsupported' ? current : 'idle');
    };

    setVoiceError(undefined);
    recognitionRef.current = recognition;
    setVoiceState('listening');
    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setVoiceState('idle');
      setVoiceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitMessage() {
    if (uploads.isPreparing()) return;
    discardVoiceInput();
    const payload = text.trim();
    const mediaPayload = pendingMedia;
    setVoiceError(undefined);
    if (!sdkAttachmentsSupported(session, mediaPayload)) { setVoiceError(translate(sdkAttachmentHint)); return; }
    if (!sessionRuntimeUi(session).attachments && mediaPayload.length) {
      setVoiceError(tr('This Agent accepts text only. Remove attachments before sending.')); return;
    }
    if (payload.length > COMPOSER_MAX_MESSAGE_CHARS) {
      setVoiceError(tr("Message is too long. Max {limit} characters.", { limit: formatNumber(COMPOSER_MAX_MESSAGE_CHARS) }));
      return;
    }
    if ((!payload && mediaPayload.length === 0) || sending) return;
    const optimisticId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      sessionKey: session.sessionKey,
      role: 'user',
      text: payload,
      media: mediaPayload.map((item) => ({ type: item.type, url: item.dataUrl, name: item.name, ...(item.mimeType ? { mimeType: item.mimeType } : {}), ...(typeof item.size === 'number' ? { size: item.size } : {}) })),
      status: 'sending',
      queueDisposition: hasQueueBlockingRun(session) && payload !== '/stop' ? 'waiting' : 'preparing',
      createdAt: Date.now(),
    };
    setOptimisticMessages((items) => [...items, optimistic]);
    appendOptimisticMessageToCache(session.sessionKey, optimistic);
    // The message is now visible in the chat as an optimistic outgoing bubble.
    // Clear the composer immediately; if the network later returns 5xx, keep the
    // failure state on that bubble instead of leaving duplicate text in input.
    setText('');
    setPendingMedia([]);
    setSending(true);
    if (autoScrollEnabled) {
      stickToBottomRef.current = true;
      settleScrollToBottom('smooth', true);
    }
    try {
      const response = await sendMessageWithRecovery(session.sessionKey, payload, deliveryMode, mediaPayload, optimisticId, payload === '/stop' ? session.runtime?.turnId : undefined);
      const admitted = applyMessageAdmission(optimistic, response);
      appendOptimisticMessageToCache(session.sessionKey, admitted);
      setOptimisticMessages((items) => items.map((item) => item.id === optimisticId ? applyMessageAdmission(item, response) : item));
      refreshAccepted(optimistic, response, onSent);
      if (autoScrollEnabled) {
        stickToBottomRef.current = true;
        settleScrollToBottom('smooth', true);
      }
    } catch (error) {
      setOptimisticMessages((items) => items.map((item) => item.id === optimisticId ? { ...item, status: error instanceof CommandOutcomeUnknownError ? 'outcome_unknown' : 'failed' } : item));
      if (error instanceof CommandNotSubmittedError) {
        setText((current) => current || payload);
        setPendingMedia((current) => current.length ? current : mediaPayload, true);
        removeOptimisticMessageFromCache(session.sessionKey, optimisticId);
        setOptimisticMessages((items) => items.filter((item) => item.id !== optimisticId));
      }
      setVoiceError(error instanceof CommandOutcomeUnknownError ? undefined : error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
      // Avoid programmatic refocus after sending on mobile. iOS/PWA can reopen
      // the keyboard and leave the visual viewport in a zoomed intermediate state
      // after the optimistic send clears and shrinks the composer.
      inputRef.current?.blur();
      settleMobileViewport();
    }
  }

  const mobileMessageTooLong = text.length > COMPOSER_MAX_MESSAGE_CHARS;
  const mobileSendDisabled = sending || uploads.preparing || mobileMessageTooLong || (!text.trim() && pendingMedia.length === 0);
  const activeSend = hasOptimisticActiveSend(session, sending, optimisticMessages);
  const displaySession = useMemo(
    () => withOptimisticRunningState(session, activeSend, optimisticMessages[optimisticMessages.length - 1]?.createdAt),
    [session, activeSend, optimisticMessages],
  );
  const mobileSessionBusy = hasQueueBlockingRun(session);
  const [mobileToolsExpanded, setMobileToolsExpanded] = useState(false);
  const [mobileQueueExpanded, setMobileQueueExpanded] = useState(false);
  const queuedMessageIds = useMemo(
    () => mobileRenderItems.flatMap((item) => item.kind === 'message' && hasQueuedMessageControls(item.message, queueActive) ? [item.message.id] : []),
    [mobileRenderItems, queueActive],
  );
  useEffect(() => {
    if (queuedMessageIds.length <= 1 && mobileQueueExpanded) setMobileQueueExpanded(false);
  }, [queuedMessageIds.length, mobileQueueExpanded]);
  const foldedQueuedIds = useMemo(() => {
    if (mobileQueueExpanded || queuedMessageIds.length <= 1 || queueDraft) return new Set<string>();
    return new Set(queuedMessageIds.slice(0, -1));
  }, [mobileQueueExpanded, queuedMessageIds, queueDraft]);
  const presentation = sessionPresentation(displaySession, false, syncError);
  const syncIssueLabel = sessionSyncIssueLabel(session, syncError);
  const isTransientMobileSyncIssue = syncIssueLabel === 'Latest messages unavailable';

  return <main className="mobile-session-detail-shell flex flex-col bg-slate-100 text-slate-950 sm:mx-auto sm:max-w-[540px]">
    <header data-session-state={presentation.state} title={isTransientMobileSyncIssue ? tr(syncIssueLabel) : undefined} style={{ borderTop: `3px solid ${isTransientMobileSyncIssue ? '#f59e0b' : tone.accent}` }} className={cn("session-state-header sticky top-0 z-20 border-b px-2.5 pb-1 pt-[max(4px,env(safe-area-inset-top))] backdrop-blur transition-colors", isTransientMobileSyncIssue ? "border-amber-200/80 bg-amber-50/90" : "border-white/70 bg-white/95")}>
      {syncIssueLabel && !isTransientMobileSyncIssue ? <HistorySyncIssue label={syncIssueLabel} detail={syncError ?? session.runtime?.reason} onRetry={onSent} /> : null}
      {olderHistoryError && onLoadMoreHistory ? <HistorySyncIssue label="Older messages unavailable" detail={olderHistoryError} onRetry={async () => { await onLoadMoreHistory(); }} /> : null}
      <div className="mobile-session-heading flex flex-wrap items-center gap-1">
        <Button variant="secondary" size="icon" className="h-6 w-6 shrink-0 rounded-lg" onClick={onBack} aria-label={tr("Back to sessions")}><ArrowLeft size={14} /></Button>
        <div data-session-card={session.sessionKey} className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1"><SessionColorMark sessionKey={session.sessionKey} /><SessionTitleEditor session={session} hideTrigger titleClassName="truncate text-[0.76rem] font-extrabold tracking-[-0.02em] text-slate-950" onRenamed={onRenamed} /></div>
        </div>
        <div className={cn("mobile-session-controls items-center gap-1 overflow-x-auto", mobileToolsExpanded ? "flex is-expanded-grid order-last w-full" : "hidden")} role="group" tabIndex={0} aria-label={tr("Session controls")}>
        {session.source === 'codex' ? <SessionGoalControl key={`goal:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
        {session.source === 'codex' ? <SessionAutomationControl key={`automation:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
        {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionGuidanceControl key={`guidance:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
        {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionTokenUsage sessionKey={session.sessionKey} caption /> : null}
        <AutoScrollControl enabled={autoScrollEnabled} onChange={toggleAutoScroll} />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 shrink-0 rounded-xl px-2 text-[0.64rem] font-black"
          disabled={pinning}
          onClick={() => void toggleSessionPinned()}
          aria-pressed={Boolean(session.pinned)}
          aria-label={tr(session.pinned ? 'Unpin session' : 'Pin session')}
        >{pinning ? '...' : tr(session.pinned ? 'Unpin' : 'Pin')}</Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 shrink-0 rounded-xl px-2 text-[0.64rem] font-black"
          disabled={compacting || isSessionBusy(session) || !sessionRuntimeUi(session).compact}
          onClick={() => void compactSession()}
          aria-label={tr("Compact session")}
          title={tr(!sessionRuntimeUi(session).compact ? 'This Agent does not support manual compaction' : 'Compact session')}
        >{tr(compacting || session.runtime?.operation === 'compact' && hasQueueBlockingRun(session) ? 'Compacting…' : 'Compact')}</Button>
        <GlobalNotebookTrigger />
        {['codex', 'claude-code', 'ghcp'].includes(session.agentId ?? '') ? <SessionInteractions key={`interactions:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
        <SessionFiles key={`files:${recoveryScope()}:${session.sessionKey}`} session={session} sessionKey={session.sessionKey} messages={renderedMessages} />
        {session.source === 'codex' ? <SessionSkills key={`skills:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} /> : null}
        <SessionNotebook key={`notebook:${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} title={session.title || session.sessionKey} />
        {session.source === 'codex' ? <SessionSharing key={`${recoveryScope()}:${session.sessionKey}`} sessionKey={session.sessionKey} placement="toolbar" /> : null}
        <Button type="button" variant="secondary" size="sm" className="h-7 shrink-0 rounded-xl px-2 text-[0.64rem] font-black" onClick={() => renameSessionDialog(session, onRenamed)} aria-label={tr("Rename chat")}><Pencil size={12} /></Button>
        </div>
        <Button type="button" variant="secondary" size="icon" className={cn("mobile-tools-drawer-toggle h-6 w-6 shrink-0 rounded-lg", mobileToolsExpanded && "bg-slate-900 text-white hover:bg-slate-800")} aria-pressed={mobileToolsExpanded} aria-label={tr(mobileToolsExpanded ? "Collapse session tools" : "Expand session tools")} title={tr(mobileToolsExpanded ? "Collapse session tools" : "Expand session tools")} onClick={() => setMobileToolsExpanded((value) => !value)}><MoreHorizontal size={14} /></Button>
        <CaptionPanel label={tr('Session model')} icon={<Bot size={14} />}>{(_close, open) => <>
          <p className="text-xs text-slate-500">{shortAgent(session.agentId ?? 'agent')} · {readableEnvLabel((session as SessionSummary & { envConnectionLabel?: string }).envConnectionLabel) ?? tr('local')}</p>
          <SessionModelOverrideControl session={session} onUpdated={onRenamed} active={open} />
        </>}</CaptionPanel>
        {mobileSessionBusy ? <Button type="button" variant="secondary" size="icon" className="h-6 w-6 shrink-0 rounded-lg border-red-200 bg-red-50 text-red-700 hover:bg-red-100" disabled={session.runtime?.stopRequested} onClick={() => void stopRun()} title={tr(session.runtime?.stopRequested ? 'Stop requested…' : 'Stop current run')} aria-label={tr("Stop current run")}><Square size={12} /></Button> : null}
      </div>
      {mobileToolsExpanded && ['claude-code', 'ghcp'].includes(session.source ?? '') ? <div className="mt-1 overflow-x-auto">
        <DesktopHeaderStatusStrip session={displaySession} messages={renderedMessages} deliveryMode={deliveryMode} />
      </div> : null}
    </header>
    {shouldMountSessionWatermark(session, conversationMessages.length) ? (
      <SessionVolumeWatermarkBanner
        session={session}
        messages={conversationMessages}
        deliveryMode={deliveryMode}
        maxMessageChars={COMPOSER_MAX_MESSAGE_CHARS}
        compact
      />
    ) : null}
    {compactNotice ? <div className="border-b border-white/70 bg-blue-50/85 px-3 py-1.5 text-xs font-semibold text-blue-800 " role="status">{translate(compactProgressLabel(session) ?? compactNotice)}</div> : null}

    <div className="relative flex min-h-0 flex-1 flex-col">
    <section ref={scrollContainerRef} onScroll={rememberScrollIntent} className="message-selection-surface min-h-0 flex-1 overflow-y-auto px-2.5 py-2" aria-live="polite">
      <div ref={contentRef} className="flow-root space-y-1.5">
      {messagesLoading && conversationMessages.length === 0 ? <LoadingCard text="Loading messages…" className="mx-auto mt-10 max-w-[18rem]" /> : null}
      {!messagesLoading && conversationMessages.length === 0 ? <Card className="mx-auto mt-10 max-w-[18rem] p-6 text-center text-sm text-slate-500">
        <Bot className="mx-auto mb-3 text-blue-500" size={28} />
        <strong className="block text-base text-slate-800">{tr("No messages yet")}</strong>
        <span className="mt-1 block">{tr("Send a message to start this web session.")}</span>
      </Card> : null}
      {historyLoading ? <div className="mx-auto w-fit rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[0.68rem] font-bold text-blue-700">{tr("Loading older history…")}</div> : null}
      {queuedMessageIds.length > 1 ? <div className="flex justify-end">
        <button
          type="button"
          className="mobile-queue-fold-toggle"
          onClick={() => setMobileQueueExpanded((value) => !value)}
          aria-expanded={mobileQueueExpanded}
        >
          <Clock3 size={12} aria-hidden="true" />
          <span>{mobileQueueExpanded ? tr('Collapse earlier queued ({count})', { count: queuedMessageIds.length - 1 }) : tr('{count} earlier queued folded · tap to expand', { count: queuedMessageIds.length - 1 })}</span>
        </button>
      </div> : null}
      {mobileRenderItems.map((item) => item.kind === 'toolGroup'
        ? <MobileToolStrip messages={item.messages} key={`mobile-tool-group-${item.messages[0]?.id ?? item.startIndex}`} />
        : <div
          data-message-search-id={item.message.id}
          data-final-reply={item.message.id === finalReply || undefined}
          className={cn('desktop-message-with-tools', foldedQueuedIds.has(item.message.id) && 'mobile-queued-item-folded', messageSearchFrameClass(searchMatchIds.has(item.message.id), activeSearchMessageId === item.message.id))}
          onClick={foldedQueuedIds.has(item.message.id) ? () => setMobileQueueExpanded(true) : undefined}
          key={`${item.message.sessionKey}:${item.message.id}`}
        >
          {item.attachedTools?.length ? <MobileToolStrip messages={item.attachedTools} compact /> : null}
          <QueueMessageControls.Provider value={mobileQueueControls}><MobileMessageBubble message={item.message} isRecent={item.index >= visibleMobileMessages.length - 5} onMediaLoad={handleMobileMediaLoad} /></QueueMessageControls.Provider>
        </div>)}
      <div ref={bottomRef} className="h-1" aria-hidden="true" />
      </div>
    </section>
    <div data-chat-activity className="flex min-h-6 shrink-0 items-center justify-center px-2.5 py-0.5"><RunProgressNotice session={displaySession} messages={messages} syncError={syncError} refreshing={Boolean(messagesRefreshing)} onRechecked={onSent} /></div>
    {hasMessagesBelow ? <button type="button" className="newer-messages-pill newer-messages-pill--mobile" onClick={() => scrollToBottom('auto', true)} aria-label={tr("Jump to latest messages")}>{tr('New messages below')} ↓</button> : null}
    </div>

    {historyDelayed ? <AdmissionHistoryNotice /> : null}
    {voiceError ? <div className="border-t border-white/70 bg-white/75 px-4 py-2 text-xs text-amber-700 " role="status">{translate(voiceError)}</div> : null}

    <form className="mobile-chat-composer" onSubmit={async (event) => {
      event.preventDefault();
      await submitMessage();
    }}>
      {queueDraft && !renderedMessages.some(message => message.id === queueDraft.id && hasQueuedMessageControls(message, queueActive)) ? <QueuedMessageActions maxMessageChars={COMPOSER_MAX_MESSAGE_CHARS} messages={[]} sessionKey={session.sessionKey} onSent={onSent} draft={queueDraft} setDraft={setQueueDraft} /> : null}
      <CommandRecoveryNotice sessionKey={session.sessionKey} onRecovered={onSent} />
      <input name="main-input-5" ref={imageInputRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = '';
        void uploads.add(files);
      }} />
      <input name="main-input-6" ref={fileInputRef} className="hidden" type="file" accept={sessionRuntimeUi(session).sdk ? sdkAttachmentAccept : COMPOSER_ACCEPTED_ATTACHMENTS} multiple onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = '';
        void uploads.add(files);
      }} />
      {uploads.preparing ? <div className="px-3 py-1 text-xs text-slate-600" role="status">{tr('Preparing attachments…')}</div> : null}
      {pendingMedia.length ? <div className="mobile-composer-attachments" aria-label={tr("Pending attachments")}>
        {pendingMedia.map((item, index) => <PendingAttachmentPreview item={item} size="mobile" onRemove={() => setPendingMedia((items) => items.filter((_, itemIndex) => itemIndex !== index))} key={`${item.name}:${index}`} />)}
      </div> : null}
      <div className="mobile-composer-card">
        <div className="mobile-composer-input-row">
          <LongTextReference text={text} editable>
          <textarea name="main-textarea-7"
            ref={inputRef}
            value={text}
            rows={1}
            className="mobile-composer-textarea"
            aria-label={tr('Message this agent…')}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onPaste={uploads.paste}
            onChange={(event) => {
              if (recognitionRef.current) discardVoiceInput();
              setText(event.target.value);
              if (voiceError) setVoiceError(undefined);
            }}
            onFocus={() => { if (autoScrollEnabled) settleScrollToBottom('smooth'); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                void submitMessage();
              }
            }}
            placeholder={tr(effectiveSessionStatus(session) === 'running' ? 'Previous run is active; your message will be queued…' : (voiceState === 'listening' ? 'Listening… speech will become text' : 'Message this agent…'))}
          />
          </LongTextReference>
        </div>
        <div className="mobile-composer-toolbar" aria-label={tr("Composer tools")}>
          <span className="mr-auto text-xs text-slate-400" role="status">{tr(voiceState === 'listening' ? 'Listening · tap mic to finish' : 'Text & attachments')}</span>
          <button type="button" className="mobile-composer-tool composer-action" data-listening={voiceState === 'listening'} onClick={toggleVoiceInput} disabled={sending} aria-pressed={voiceState === 'listening'} aria-label={tr(voiceState === 'listening' ? 'Stop voice input' : 'Start voice input')} title={translate(voiceState === 'unsupported' ? (getVoiceUnavailableReason() ?? 'Voice input unavailable') : 'Dictate editable text')}><Mic size={15} /></button>
          <button type="button" className="mobile-composer-tool" onClick={() => imageInputRef.current?.click()} disabled={sending || !sessionRuntimeUi(session).attachments} aria-label={tr("Attach image")} title={tr(!sessionRuntimeUi(session).attachments ? 'This Agent accepts text only' : 'Choose from photos')}><NavIcon name="image" /></button>
          <button type="button" className="mobile-composer-tool composer-action" onClick={() => fileInputRef.current?.click()} disabled={sending || !sessionRuntimeUi(session).attachments} aria-label={tr("Attach file")} title={tr(!sessionRuntimeUi(session).attachments ? 'This Agent accepts text only' : sessionRuntimeUi(session).sdk ? sdkAttachmentHint : 'Choose a file (max 12MB)')}><Paperclip size={15} /></button>
          <Button className="mobile-composer-send" size="sm" disabled={mobileSendDisabled} aria-label={tr("Send message")}>{sending ? '...' : <Send size={15} />}</Button>
        </div>
      </div>
      {maxMessageChars !== undefined && COMPOSER_MAX_MESSAGE_CHARS < MAX_MESSAGE_CHARS ? <p className="text-xs text-slate-500" role="status">{tr('This Connector currently allows {limit} characters. Upgrade it to support longer messages.', { limit: formatNumber(COMPOSER_MAX_MESSAGE_CHARS) })}</p> : null}
      {mobileMessageTooLong ? <div className="px-1 text-[0.66rem] font-semibold text-red-600" role="status">{tr("Message is too long:")}{formatNumber(text.length)}/{formatNumber(COMPOSER_MAX_MESSAGE_CHARS)}</div> : null}
    </form>
  </main>;
}


function useOptimisticSessionMessages(sessionKey: string, messages: ChatMessage[]) {
  const identity = useSyncExternalStore(subscribeRecoveryScope, () => `${recoveryScope() ?? ''}:${recoveryEpoch()}`);
  const currentScope = recoveryScope();
  const currentEpoch = recoveryEpoch();
  const validOptimisticIdentity = () => Boolean(currentScope) && recoveryScope() === currentScope && recoveryEpoch() === currentEpoch;
  const [optimisticMessages, setOptimisticMessagesState] = useState<ChatMessage[]>(() =>
    readOptimisticMessages<ChatMessage>(currentScope, sessionKey).filter((item) => !hasMatchingRealMessage(messages, item))
  );
  const setOptimisticMessages = useCallback<React.Dispatch<React.SetStateAction<ChatMessage[]>>>((update) => {
    setOptimisticMessagesState((prev) => {
      if (!currentScope || recoveryScope() !== currentScope || recoveryEpoch() !== currentEpoch) return prev;
      const next = typeof update === 'function' ? update(prev) : update;
      writeOptimisticMessages(currentScope, sessionKey, next);
      return next;
    });
  }, [sessionKey, currentScope, currentEpoch]);
  useEffect(() => {
    const cached = readOptimisticMessages<ChatMessage>(currentScope, sessionKey).filter((item) => !hasMatchingRealMessage(messages, item));
    if (validOptimisticIdentity()) writeOptimisticMessages(currentScope, sessionKey, cached);
    setOptimisticMessagesState(cached);
  }, [sessionKey, identity]);
  useEffect(() => {
    setOptimisticMessagesState((items) => {
      if (!currentScope || recoveryScope() !== currentScope || recoveryEpoch() !== currentEpoch) return items;
      const filtered = items.filter((item) => !hasMatchingRealMessage(messages, item));
      if (filtered.length !== items.length) {
        writeOptimisticMessages(currentScope, sessionKey, filtered);
        return filtered;
      }
      return items;
    });
  }, [messages, sessionKey, identity]);
  return [optimisticMessages, setOptimisticMessages] as const;
}

type QueueMessageDraft = { id: string; text: string; version: string };

function useQueueDraft(sessionKey: string) {
  // Keep an unsaved edit when the message leaves the queue, without restoring
  // the old queue dock. Draft text stays in memory and never crosses sessions.
  const [stored, setStored] = useState<{ sessionKey: string; value: QueueMessageDraft | null }>();
  const setDraft = useCallback((value: QueueMessageDraft | null) => setStored({ sessionKey, value }), [sessionKey]);
  return [stored?.sessionKey === sessionKey ? stored.value : null, setDraft] as const;
}

function QueuedMessageActions({ maxMessageChars: COMPOSER_MAX_MESSAGE_CHARS = LEGACY_MAX_MESSAGE_CHARS, messages: originalMessages, sessionKey, onSent, onCancelled, draft, setDraft, editingElsewhere = false }: { maxMessageChars?: number | undefined; messages: ChatMessage[]; sessionKey: string; onSent: () => Promise<void>; onCancelled?: () => void; draft: QueueMessageDraft | null; setDraft: (draft: QueueMessageDraft | null) => void; editingElsewhere?: boolean }) {
  const { t: tr } = useI18n();
  const editId = useId();
  const scope = recoveryScope();
  const mutation = useRef(false);
  const [confirmation, setConfirmation] = useState<{ id: string; version: string }>();
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const messages = originalMessages.filter(message => !cancelled.has(`${message.id}:${message.queueVersion}`));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<Set<string>>(new Set());
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        const rows = scope ? new CommandJournal(window.sessionStorage).list(scope, sessionKey, 'all') : [];
        setUnresolved(new Set(rows.filter(row => row.queue && row.state === 'outcome_unknown').map(row => row.queue!.messageId)));
        setStorageFailed(!scope);
      } catch { setStorageFailed(true); setError('Recovery records unavailable. Queue modifications are disabled.'); }
    };
    read(); window.addEventListener('agentopsdeck:commands-changed', read);
    return () => window.removeEventListener('agentopsdeck:commands-changed', read);
  }, [scope, sessionKey]);
  const blocked = (id: string) => !!busyId || storageFailed || !scope || unresolved.has(id);
  const currentDraftMessage = draft ? messages.find((message) => message.id === draft.id) : undefined;
  if (!messages.length && !draft && !error) return cancelled.size ? <p role="status" className="text-xs">{tr("Cancellation accepted.")}</p> : null;

  async function editMessage() {
    if (!draft || !draft.text.trim() || draft.text.length > COMPOSER_MAX_MESSAGE_CHARS || !currentDraftMessage || currentDraftMessage.queueVersion !== draft.version || blocked(draft.id) || mutation.current) return;
    mutation.current = true;
    setBusyId(draft.id);
    setError(null);
    try {
      await mutate('edit', draft.id, draft.version, draft.text.trim());
      setDraft(null);
      await onSent().catch(() => setError('Edit accepted; refresh failed. Do not resend.'));
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Queue edit could not be confirmed'}. Draft kept. Check any saved receipt before a new change.`);
    } finally {
      mutation.current = false;
      setBusyId(null);
    }
  }

  async function cancelMessage(message: ChatMessage) {
    if (!message.queueVersion || blocked(message.id) || mutation.current) return;
    if (confirmation?.id !== message.id || confirmation.version !== message.queueVersion) {
      setConfirmation({ id: message.id, version: message.queueVersion }); return;
    }
    mutation.current = true;
    setBusyId(message.id);
    setError(null);
    try {
      await mutate('cancel', message.id, message.queueVersion);
      setCancelled(items => new Set([...items, `${message.id}:${message.queueVersion}`]));
      onCancelled?.();
      setConfirmation(undefined);
      if (draft?.id === message.id) setDraft(null);
      await onSent().catch(() => setError('Cancellation accepted; refresh failed. Do not resend.'));
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Queue cancellation could not be confirmed'}. Check any saved receipt before a new change.`);
    } finally {
      mutation.current = false;
      setBusyId(null);
    }
  }

  async function mutate(action: 'edit' | 'cancel', messageId: string, version: string, text = '') {
    return mutateQueueWithRecovery(scope, sessionKey, action, messageId, version, text);
  }

  const queueRows = <div className="queue-card-list">
    {messages.map((message) => <div data-queued-message-id={message.id} className="queue-card" key={`${message.sessionKey}:${message.id}`}>
      <div className="queue-card-header">
        <span className="queue-card-label" role="status" title={tr("Waiting for the current run to finish")}><Clock3 size={12} aria-hidden="true" /><span className="queue-card-label-text">{tr("Queued")}</span></span>
        <div className="queue-card-actions">
          {confirmation?.id !== message.id ? <button type="button" aria-label={tr("Edit")} title={tr("Edit")} disabled={blocked(message.id) || !message.queueVersion || !!draft || editingElsewhere}
            onClick={() => { if (message.queueVersion) { setDraft({ id: message.id, text: message.text, version: message.queueVersion }); setError(null); } }}><Pencil size={12} aria-hidden="true" /><span className="queue-action-text">{tr("Edit")}</span></button> : null}
          {!draft ? <button type="button" className="queue-card-cancel" aria-label={busyId === message.id ? tr("Saving…") : confirmation?.id === message.id && confirmation.version === message.queueVersion ? tr("Confirm cancel") : tr("Cancel delivery")} title={busyId === message.id ? tr("Saving…") : confirmation?.id === message.id && confirmation.version === message.queueVersion ? tr("Confirm cancel") : tr("Cancel delivery")} disabled={blocked(message.id) || !message.queueVersion} onClick={() => void cancelMessage(message)}><X size={13} aria-hidden="true" /><span className={cn("queue-action-text", confirmation?.id === message.id && "is-confirm")}>{busyId === message.id ? tr("Saving…") : confirmation?.id === message.id && confirmation.version === message.queueVersion ? tr("Confirm cancel") : tr("Cancel delivery")}</span></button> : null}
          {confirmation?.id === message.id ? <button type="button" aria-label={tr("Keep queued")} disabled={!!busyId} onClick={() => setConfirmation(undefined)}>{tr("Keep")}</button> : null}
        </div>
      </div>
    </div>)}
  </div>;
  return <div className={messages.length ? 'inline-queue-controls' : 'queue-draft-recovery'} aria-label={tr(messages.length ? 'Queued message actions' : 'Unsaved queue edit')}>
    {queueRows}
    {storageFailed ? <p role="status" className="mb-1 text-xs">{tr("Recovery unavailable · reload before modifying the queue.")}</p> : null}
    {error ? <p role="alert" className="mb-2 break-words text-xs text-red-700">{error}</p> : null}
    {error ? <button type="button" className="mb-2 text-xs underline" disabled={!!busyId}
      onClick={() => { void onSent().catch(() => setError('Queue refresh failed.')); }}>{tr("Refresh status")}</button> : null}
    {draft ? <div className="queue-edit-panel">
      <label className="sr-only" htmlFor={editId}>{tr("Editing queued message")}</label>
      <textarea id={editId} autoFocus aria-label={tr("Edit queued message")} className="queue-edit-text" value={draft.text}
        disabled={!!busyId} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
      <div className="queue-edit-footer">
        <Button type="button" variant="secondary" size="sm" disabled={!!busyId} onClick={() => setDraft(null)}>{tr("Keep original")}</Button>
        <Button type="button" size="sm" disabled={blocked(draft.id) || !draft.text.trim() || draft.text.length > COMPOSER_MAX_MESSAGE_CHARS || !currentDraftMessage || currentDraftMessage.queueVersion !== draft.version} onClick={() => void editMessage()}><Check size={14} />{tr("Save changes")}</Button>
      </div>
      {currentDraftMessage?.queueVersion && currentDraftMessage.queueVersion !== draft.version ? <button type="button" className="text-xs underline" disabled={!!busyId}
        onClick={() => { setDraft({ ...draft, version: currentDraftMessage.queueVersion! }); setError(null); }}>{tr("Use displayed version; keep my draft")}</button> : null}
      {!currentDraftMessage ? <p className="text-xs">{tr("Message is no longer queued. Your draft is kept for copying.")}</p> : null}
    </div> : null}
  </div>;
}

function DashboardSummary({ sessions, agents, compact = false }: { sessions: HubSessionsState; agents: AgentSummary[]; gateway: GatewayHealth | undefined; compact?: boolean }) {
  const { t: tr } = useI18n();
  const metrics = dashboardMetrics(sessions, agents);
  const sources = sessions.sourceStates ?? [];
  const ready = sources.filter(source => source.state === 'ready').length;
  const cards = [
    ['Sessions', metrics.sessions.toString(), tr('{running} run · {failed} failed', { running: metrics.running, failed: metrics.failed })],
    ['Agents', metrics.agents.toString(), tr('Listed agents and visible sessions')],
    ['Messages', metrics.messages.toString(), tr('Visible session projection')],
    ['Environments', (sessions.connections?.length ?? sources.length).toString(), sources.length ? tr('{ready} ready · {attention} need attention', { ready, attention: sources.length - ready }) : tr('Health not yet reported')],
  ] as const;
  return <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-2 xl:grid-cols-4')}>
    {cards.map(([label, value, hint]) => <Card className="border-white/70 bg-white/68 p-4" key={label}>
      <p className="text-[0.68rem] font-black uppercase tracking-[0.16em] text-blue-600">{tr(label)}</p>
      <strong className="mt-1 block truncate text-2xl font-black tracking-[-0.04em] text-slate-950">{value}</strong>
      <span className="mt-1 block text-xs text-slate-500">{hint}</span>
    </Card>)}
  </div>;
}

function DashboardPage({ sessions, agents, gateway }: { sessions: HubSessionsState; agents: AgentSummary[]; gateway: GatewayHealth | undefined }) {
  const { t: tr, locale } = useI18n();
  const metrics = dashboardMetrics(sessions, agents);
  const gatewayDisplay = gatewayDisplayState(gateway);
  const coverage = (count: number) => tr('{count}/{total} sessions reporting', { count, total: metrics.sessions });
  const usage = (value: number, count: number) => count ? formatNumber(value) : tr('Not reported');
  const recent = sessions.groups.flatMap((group) => group.sessions).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)).slice(0, 8);
  return <div className="min-w-0 space-y-5" aria-label={tr("Workspace dashboard")}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600">{tr("AgentOpsDeck dashboard")}</p>
      <h2 className="mt-1 text-3xl font-black tracking-[-0.055em] text-slate-950">{tr("Workspace overview")}</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-500">{tr("Visible sessions and environment snapshots for this login. Missing usage is not zero; projected tokens are not billing data.")}</p></div>
      <Button variant="secondary" onClick={() => writeHashRoute({ tab: 'sessions' })}>{tr("Browse sessions")}</Button>
    </div>
    <DashboardSummary sessions={sessions} agents={agents} gateway={gateway} />
    <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <Card className="border-white/70 bg-white/68 p-4">
        <h3 className="text-sm font-black uppercase tracking-[0.14em] text-slate-500">{tr("Agent activity")}</h3>
        <div className="mt-3 grid gap-2">
          {[...new Set([...agents.map(agent => agent.id), ...sessions.groups.map(group => group.agentId)])].map((agentId) => {
            const group = { agentId, sessions: sessions.groups.filter(group => group.agentId === agentId).flatMap(group => group.sessions) };
            const running = group.sessions.filter((session) => effectiveSessionStatus(session) === 'running').length;
            const failed = group.sessions.filter((session) => effectiveSessionStatus(session) === 'failed').length;
            return <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200/70 bg-white/70 px-3 py-2" key={group.agentId}>
              <span className="break-all font-bold text-slate-800">{agents.find(agent => agent.id === agentId)?.label ?? group.agentId}</span>
              <span className="text-xs text-slate-500">{group.sessions.length} {tr("sessions ·")}{running} {tr("run ·")}{failed} {tr("failed")}</span>
            </div>;
          })}
          {!metrics.agents ? <p className="text-sm text-slate-500">{tr("No agents reported yet. Check environment availability before creating a session.")}</p> : null}
        </div>
      </Card>
      <Card className="border-white/70 bg-white/68 p-4">
        <h3 className="text-sm font-black uppercase tracking-[0.14em] text-slate-500">{tr("Usage & coverage")}</h3>
        <dl className="mt-3 grid gap-2 text-sm">
          <MetricRow label="Reported input tokens" value={usage(metrics.inputTokens, metrics.inputReported)} />
          <MetricRow label="Input coverage" value={coverage(metrics.inputReported)} />
          <MetricRow label="Reported output tokens" value={usage(metrics.outputTokens, metrics.outputReported)} />
          <MetricRow label="Output coverage" value={coverage(metrics.outputReported)} />
          <MetricRow label="Projected token total" value={usage(metrics.contextTokens, metrics.projectedReported)} />
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{tr("Reported values are summed only where supplied. The projection may include estimates and is neither exact context occupancy nor provider-billed usage. Codex usage is not currently populated in this summary.")}</p>
      </Card>
    </div>
    <Card className="border-white/70 bg-white/68 p-4">
      <h3 className="text-sm font-black uppercase tracking-[0.14em] text-slate-500">{tr("Environment health")}</h3>
      <p className="mt-1 text-xs text-slate-500">{tr("Last snapshot:")} {sessions.updatedAt ? new Date(sessions.updatedAt).toLocaleString(locale) : tr('Waiting for data')}{tr(". Snapshot readiness is not proof of a live event connection.")}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(sessions.connections ?? []).map(connection => {
          const source = sessions.sourceStates?.find(source => source.connectionId === connection.id);
          return <div key={connection.id} className="min-w-0 rounded-2xl border border-slate-200/70 bg-white/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-words text-sm">{connection.environmentLabel ?? connection.label}</strong><Badge variant={source?.state === 'ready' ? 'running' : 'muted'}>{translate(source?.state ?? 'Not reported')}</Badge></div>
            <p className="mt-1 break-all text-xs text-slate-500">{connection.kind} · {connection.id}</p>
          </div>;
        })}
        {!sessions.connections?.length ? <p className="text-sm text-slate-500">{tr("No environments in this view.")}</p> : null}
      </div>
      <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600"><strong>OpenClaw Gateway: {translate(gatewayDisplay.label)}.</strong> {gateway?.error ?? gateway?.note ?? translate(gatewayDisplay.hint)}</div>
    </Card>
    <Card className="border-white/70 bg-white/68 p-4">
      <h3 className="text-sm font-black uppercase tracking-[0.14em] text-slate-500">{tr("Recent sessions")}</h3>
      <div className="mt-3 grid gap-2">
        {recent.map((session) => <button type="button" onClick={() => writeHashRoute({ sessionKey: session.sessionKey })} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-2xl border border-slate-200/70 bg-white/70 px-3 py-2 text-left transition hover:border-blue-300 hover:bg-blue-50" key={session.sessionKey}>
          <span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><SessionColorMark sessionKey={session.sessionKey} /><strong className="block truncate text-sm text-slate-900">{displayTitle(session)}</strong></span><small className="block truncate text-xs text-slate-500">{compactKey(session.sessionKey)}</small></span>
          <Badge variant={effectiveSessionStatus(session) === 'running' ? 'running' : 'muted'}>{translate(sessionStatusLabel(effectiveSessionStatus(session)))}</Badge>
        </button>)}
        {!recent.length ? <p className="py-4 text-sm text-slate-500">{tr("No visible sessions yet. Open Sessions to create your first conversation.")}</p> : null}
      </div>
    </Card>
  </div>;
}

function DesktopHeaderStatusStrip({ session, messages, deliveryMode }: { session: SessionSummary; messages: ChatMessage[]; deliveryMode: SendDeliveryMode }) {
  const { t: tr } = useI18n();
  const tokenUsage = sessionTokenMetrics(session);
  const metrics = sessionMetrics(session, messages);
  const status = effectiveSessionStatus(session);
  const ratio = contextUsageRatio(session);
  const contextKnown = contextUsageValues(session).used !== undefined;
  return <><div data-session-metrics className="inline-flex h-8 max-w-full min-w-0 shrink items-center gap-x-1.5 overflow-hidden whitespace-nowrap rounded-xl border border-slate-200/80 bg-white/75 px-2 text-xs font-semibold shadow-sm shadow-slate-200/30">
    <span className={cn('h-2 w-2 shrink-0 rounded-full', sessionStatusDotClass(status))} aria-hidden="true" />
    <Badge variant={sessionStatusBadgeVariant(status)} className={cn('px-1.5 py-0.5 text-xs font-semibold normal-case tracking-normal', sessionStatusBadgeClass(status))}>{translate(sessionStatusLabel(status))}</Badge>
    <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
    <span className="text-slate-500">{tr(contextUsageLabel(session, true))}</span>
    <strong className="font-semibold text-slate-800" title={tr(contextUsageDescription(session))}>{formatContextUsage(session)}</strong>
    {contextKnown && contextUsageValues(session).limit !== undefined ? <span className="hidden h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-slate-200/80 2xl:block" aria-label={tr('Context usage {percent}%', { percent: Math.round(ratio * 100) })}>
      <span className={cn('block h-full rounded-full', contextUsageBarClass(ratio))} style={{ width: `${Math.round(ratio * 100)}%` }} />
    </span> : null}
    <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
    <span className="text-slate-500" title={tr(formatCompactionCount(session) === '—' ? 'Compaction count not reported by this runtime.' : 'Compactions')}>{tr('compact')} {formatCompactionCount(session)}</span>
    <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
    <span className="text-slate-500">{metrics.messageCount === undefined ? '—' : formatNumber(metrics.messageCount)} {tr('msgs')}</span>
    {session.nativeUsage ? <span className="text-slate-500" data-native-usage title={tr(session.nativeUsage.scope === 'last-turn'
      ? 'Native usage · last agent turn, not session totals.' : 'Native usage · last root-agent API call, not session totals.') + ` ${tr('Input')}: ${tokenUsage.input} · ${tr('Output')}: ${tokenUsage.output}`}>
      {tr(session.nativeUsage.scope === 'last-turn' ? 'Last turn' : 'Last call')} {formatTokenValue(session.nativeUsage.inputTokens)} / {formatTokenValue(session.nativeUsage.outputTokens)}
    </span> : null}
    <span className="hidden text-slate-500 2xl:inline">{tr(deliveryMode === 'mirror' ? 'mirror' : 'web')}</span>
  </div><dl className="pane-context-identity mt-2" data-session-token-metrics>
    <div><dt>{tr(tokenUsage.scope)}</dt><dd>{tr('Input')}: {tokenUsage.input} · {tr('Output')}: {tokenUsage.output}</dd></div>
  </dl></>;
}

function sessionStatusBadgeVariant(status: ReturnType<typeof effectiveSessionStatus>) {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'accent';
  if (status === 'idle') return 'muted';
  if (status === 'pending_subagent') return 'accent';
  return 'default';
}

function sessionStatusBadgeClass(status: ReturnType<typeof effectiveSessionStatus>) {
  if (status === 'running') return 'border-blue-300 bg-blue-500 text-white shadow-md ring-2 ring-blue-300/35';
  if (status === 'waiting') return 'border-cyan-300 bg-cyan-500 text-white shadow-sm ';
  if (status === 'pending_subagent') return 'border-violet-300 bg-violet-500 text-white shadow-sm ring-2 ring-violet-200/40';
  if (status === 'failed') return 'border-red-300 bg-red-50 text-red-700';
  return 'border-slate-200 bg-slate-100 text-slate-500';
}

function sessionStatusDotClass(status: ReturnType<typeof effectiveSessionStatus>) {
  if (status === 'running') return 'bg-blue-400 ring-4 ring-blue-300/35 animate-pulse';
  if (status === 'waiting') return 'bg-cyan-500 ';
  if (status === 'pending_subagent') return 'bg-violet-500 ring-4 ring-violet-300/25';
  if (status === 'failed') return 'bg-red-500 ';
  return 'bg-slate-400 ';
}

function contextUsageRatio(session: SessionSummary) {
  return contextUsageValues(session).ratio;
}

function contextUsageBarClass(ratio: number) {
  if (ratio >= 0.85) return 'bg-gradient-to-r from-red-500 to-amber-500';
  if (ratio >= 0.65) return 'bg-gradient-to-r from-amber-400 to-orange-500';
  return 'bg-gradient-to-r from-blue-500 to-cyan-400';
}

function compactRequestMessage(session: SessionSummary) {
  const ratio = contextUsageRatio(session);
  if (ratio > 0 && ratio < 0.5) {
    return `Compact requested. This session is likely below threshold (${Math.max(1, Math.round(ratio * 100))}% context used), so Gateway may skip it and report the reason in the transcript.`;
  }
  return 'Compact requested. Gateway will write the final result into the transcript.';
}

function SessionContextPanel({ session, messages, deliveryMode, compact = false, onModelUpdated }: { session: SessionSummary; messages: ChatMessage[]; deliveryMode: SendDeliveryMode; compact?: boolean; onModelUpdated?: () => Promise<void> }) {
  const { t: tr } = useI18n();
  const headingId = useId();
  const metrics = sessionMetrics(session, messages);
  const statusState = readStructuredSessionStatus(session);
  const status = statusState.displayStatus;
  const contextRatio = contextUsageRatio(session);
  const context = contextUsageValues(session);
  const contextKnown = context.used !== undefined && context.limit !== undefined;
  const source = titleCase(session.source ?? 'unknown');
  const model = session.modelProvider && session.model ? `${session.modelProvider}/${session.model}` : (session.model ?? 'n/a');
  const tokenUsage = sessionTokenMetrics(session);
  const tokenItems = [
    [tr('Messages'), metrics.messageCount === undefined ? '—' : formatNumber(metrics.messageCount)],
    [`${tr(tokenUsage.scope)} · ${tr('Input')}`, tokenUsage.input],
    [`${tr(tokenUsage.scope)} · ${tr('Output')}`, tokenUsage.output],
    [tr(contextUsageLabel(session)), formatContextUsage(session)],
    [tr('Compact'), formatCompactionCount(session)],
  ] as const;

  return <details className={cn('border-t border-white/65 bg-white/46 text-xs text-slate-500 ', compact ? 'px-4 py-2' : 'px-5 py-3')} open={!compact}>
    <summary className="cursor-pointer select-none text-[0.68rem] font-black uppercase tracking-[0.16em] text-slate-400">
      {tr('Status')} · {translate(sessionStatusLabel(status))} · {tr(contextUsageLabel(session, true))} {formatContextUsage(session)} · {tr('compact')} {formatCompactionCount(session)}
    </summary>
    <div className="mt-2.5 grid gap-2 xl:grid-cols-[minmax(250px,0.9fr)_minmax(0,1.7fr)]">
      <section aria-labelledby={`${headingId}-status`} className="flex min-w-0 items-center gap-2.5 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 shadow-sm ">
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full ', sessionStatusDotClass(status))} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p id={`${headingId}-status`} className="mb-1 text-[0.58rem] font-black uppercase tracking-[0.13em] text-slate-400">{tr("Status")}</p>
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm font-black tracking-[-0.02em] text-slate-900">{session.agentId ?? tr('unknown')}</strong>
            <Badge variant={sessionStatusBadgeVariant(status)} className={cn('shrink-0 px-2 py-0.5 text-[0.64rem] font-black uppercase tracking-[0.08em]', sessionStatusBadgeClass(status))}>{translate(sessionStatusLabel(status))}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.68rem] font-semibold text-slate-500">
            <span>{tr('Run state')}: {translate(statusState.runState)}</span>
            <span className="text-slate-300">•</span>
            <span>{tr('Child tasks')}: {translate(statusState.childState)}{statusState.pendingSubagentCount ? ` (${statusState.pendingSubagentCount})` : ''}</span>
            <span className="text-slate-300">•</span>
            <span>{formatAgo(session.lastActiveAt)}</span>
          </div>
        </div>
      </section>

      <section aria-labelledby={`${headingId}-context`} className="min-w-0 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 shadow-sm ">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p id={`${headingId}-context`} className="truncate text-[0.68rem] font-black uppercase tracking-[0.14em] text-slate-400">{tr(contextUsageLabel(session))}</p>
            <p className="mt-0.5 truncate font-mono text-[0.7rem] font-semibold text-slate-500">{model}</p>
          </div>
          <strong className="shrink-0 font-mono text-sm font-black text-slate-900" title={tr(contextUsageDescription(session))}>{formatContextUsage(session)}</strong>
        </div>
        {contextKnown ? <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200/80" aria-label={tr('Context usage {percent}%', { percent: Math.round(contextRatio * 100) })}>
          <div className={cn('h-full rounded-full transition-all', contextUsageBarClass(contextRatio))} style={{ width: `${Math.round(contextRatio * 100)}%` }} />
        </div> : <p className="mt-2 text-[0.68rem] text-slate-500">{tr(contextUsageDescription(session))}</p>}
        {session.nativeUsage ? <p className="mt-2 text-[0.68rem] text-slate-500">{tr(session.nativeUsage.scope === 'last-turn'
          ? 'Native usage · last agent turn, not session totals.' : 'Native usage · last root-agent API call, not session totals.')}</p> : null}
        <div className="mt-2 grid grid-cols-5 gap-1.5">
          {tokenItems.map(([label, value]) => <span className="min-w-0 rounded-xl bg-slate-50/90 px-2 py-1" key={label}>
            <span title={label} className="block truncate text-[0.58rem] font-black uppercase tracking-[0.11em] text-slate-400">{label}</span>
            <strong title={value} className="mt-0.5 block truncate text-[0.76rem] font-black text-slate-800">{value}</strong>
          </span>)}
        </div>
      </section>
    </div>
    <section aria-labelledby={`${headingId}-runtime`} className="mt-2 flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-white/45 px-2 py-1 text-[0.68rem] font-semibold text-slate-500">
      <span id={`${headingId}-runtime`} className="font-black uppercase tracking-[0.13em] text-slate-400">{tr("Runtime")}</span>
      <span>{source}</span>
      <span>{tr(deliveryMode === 'mirror' ? 'Mirror replies' : 'Web only')}</span>
      {!compact ? <SessionModelOverrideControl session={session} onUpdated={onModelUpdated} /> : null}
      <span className="min-w-0 flex-1 truncate font-mono text-[0.62rem] text-slate-400">{session.sessionKey}</span>
    </section>
  </details>;
}

const SESSION_THINKING_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;


/** List-card actions use the same runtime control without opening or moving a workspace pane. */
function SessionModelDialog({ session, onClose, onUpdated }: { session: SessionSummary; onClose: () => void; onUpdated: (session: SessionEdit) => void | Promise<void> }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    window.addEventListener('agentopsdeck:auth-required', onClose);
    return () => {
      window.removeEventListener('agentopsdeck:auth-required', onClose);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);
  return <dialog ref={dialog} className="action-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="mb-3 flex items-center justify-between gap-3"><h2 id={titleId} className="font-semibold">{t('Session model')}</h2>
      <Button type="button" size="sm" variant="ghost" onClick={onClose} aria-label={t('Close')}><X size={16} /></Button></div>
    <p className="mb-4 break-words text-sm text-slate-500">{displayTitle(session)}</p>
    <SessionModelOverrideControl session={session} onUpdated={onUpdated} />
  </dialog>;
}

function SessionModelOverrideControl({ session, onUpdated, active = true }: { session: SessionSummary; onUpdated?: ((session: SessionEdit) => void | Promise<void>) | undefined; active?: boolean }) {
  const { t: tr } = useI18n();
  const { model: currentModel, thinking: currentThinking } = sessionRuntimeDraft(session);
  const [modelDraft, setModelDraft] = useState(currentModel);
  const [thinkingDraft, setThinkingDraft] = useState(currentThinking);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [modelChoices, setModelChoices] = useState<Array<{ id: string; label: string }>>([]);
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [customModel, setCustomModel] = useState(false);
  const modelConnectionId = (session as SessionSummary & { envConnectionId?: string }).envConnectionId;
  useEffect(() => {
    if (!active) return;
    setModelChoices([]); setCustomModel(false);
    const runtime = sessionRuntimeUi(session).modelCatalog;
    if (!modelConnectionId || !runtime) { setCatalogState('error'); return; }
    const controller = new AbortController();
    setCatalogState('loading');
    void api.runtimeModels(modelConnectionId, runtime, controller.signal)
      .then(result => {
        if (!Array.isArray(result?.models) || result.models.some(model => !model || typeof model.id !== 'string' || typeof model.label !== 'string')) throw new Error('Invalid model catalog');
        if (!controller.signal.aborted) { setModelChoices(result.models); setCatalogState('ready'); }
      })
      .catch(() => { if (!controller.signal.aborted) setCatalogState('error'); });
    return () => controller.abort();
  }, [active, modelConnectionId, session.source, catalogAttempt]);
  const previousRuntime = useRef({ key: session.sessionKey, model: currentModel, thinking: currentThinking });
  const activeSessionKey = useRef(session.sessionKey);
  const settingsEpoch = useRef(0);
  if (activeSessionKey.current !== session.sessionKey) {
    activeSessionKey.current = session.sessionKey;
    settingsEpoch.current++;
  }
  useEffect(() => () => { settingsEpoch.current++; }, []);

  useEffect(() => {
    const previous = previousRuntime.current;
    const current = { model: currentModel, thinking: currentThinking };
    if (previous.key !== session.sessionKey) {
      setModelDraft(currentModel); setThinkingDraft(currentThinking); setMessage(undefined); setSaving(false);
    } else {
      setModelDraft(draft => reconcileRuntimeDraft({ model: draft, thinking: previous.thinking }, previous, current).model);
      setThinkingDraft(draft => reconcileRuntimeDraft({ model: previous.model, thinking: draft }, previous, current).thinking);
    }
    previousRuntime.current = { key: session.sessionKey, ...current };
  }, [session.sessionKey, currentModel, currentThinking]);

  async function applyChanges() {
    const model = modelDraft.trim();
    const thinking = thinkingDraft.trim();
    if (saving || (model === currentModel && thinking === currentThinking)) return;
    setSaving(true);
    setMessage(undefined);
    const epoch = ++settingsEpoch.current;
    try {
      const updatedSession = await updateSettingsWithRecovery(session.sessionKey, { model: model || null, ...(!sessionRuntimeUi(session).sdk ? { thinking: thinking || null } : {}) });
      if (settingsEpoch.current !== epoch) return;
      setMessage(tr('Settings change accepted; refreshing current view.'));
      await onUpdated?.(updatedSession);
    } catch (error) {
      if (settingsEpoch.current === epoch) setMessage(tr('Update unavailable: {error}', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (settingsEpoch.current === epoch) setSaving(false);
    }
  }

  async function resetDefaults() {
    if ((!currentModel && !currentThinking) || saving) return;
    setSaving(true);
    setMessage(undefined);
    const epoch = ++settingsEpoch.current;
    try {
      const updatedSession = await updateSettingsWithRecovery(session.sessionKey, { model: null, ...(!sessionRuntimeUi(session).sdk ? { thinking: null } : {}) });
      if (settingsEpoch.current !== epoch) return;
      setMessage(tr('Settings reset accepted; refreshing current view.'));
      await onUpdated?.(updatedSession);
    } catch (error) {
      if (settingsEpoch.current === epoch) setMessage(tr('Reset unavailable: {error}', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (settingsEpoch.current === epoch) setSaving(false);
    }
  }

  const hasChanges = modelDraft.trim() !== currentModel || thinkingDraft.trim() !== currentThinking;
  const hasOverrides = Boolean(currentModel || currentThinking);

  if (session.source === 'hermes') return <span className="block min-w-0 max-w-full truncate text-xs text-slate-500" title={tr("Set provider and model in the dedicated Hermes configuration")}>{tr("Hermes · configured model")}</span>;

  return <div className="relative flex min-w-0 max-w-full shrink flex-wrap items-center gap-1.5 text-xs font-semibold" title={message ?? (sessionRuntimeUi(session).sdk ? tr('Update model for this session') : tr('Update model and thinking overrides for this session'))}>
    <select name="main-select-9" className="desktop-chat-toolbar-control h-8 min-w-0 w-44 max-w-full rounded-xl border border-slate-200/80 bg-white/75 px-3 text-slate-700 outline-none focus:ring-1 focus:ring-blue-300 2xl:w-52" value={customModel ? '__custom_model__' : modelDraft} onChange={event => { const value = event.currentTarget.value; setCustomModel(value === '__custom_model__'); if (value !== '__custom_model__') setModelDraft(value); }} aria-label={tr("Session model")}>
      <option value="">{tr('Default model')}</option>
      {modelChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      {modelDraft && !modelChoices.some(choice => choice.id === modelDraft) ? <option value={modelDraft}>{modelDraft}</option> : null}
      {catalogState === 'loading' ? <option disabled>{tr('Loading models…')}</option> : null}
      {!sessionRuntimeUi(session).sdk ? <option value="__custom_model__">{tr('Custom model…')}</option> : null}
    </select>
    {customModel ? <input name="main-input-10" className="h-8 w-44 rounded-xl border border-slate-200 px-3" value={modelDraft} onChange={event => setModelDraft(event.currentTarget.value)} aria-label={tr('Custom model ID')} placeholder={tr('Model ID')} maxLength={4096} /> : null}
    {catalogState === 'error' ? <button type="button" className="text-xs text-slate-500 underline" onClick={() => setCatalogAttempt(value => value + 1)} title={tr('Model list unavailable; check Connector version and model permissions')}>{tr('Retry models')}</button> : null}
    {!sessionRuntimeUi(session).sdk ? <select name="main-select-11" className="desktop-chat-toolbar-control h-8 min-w-0 w-24 rounded-xl border border-slate-200/80 bg-white/75 px-3 tracking-normal text-slate-700 shadow-sm shadow-slate-200/30 outline-none hover:bg-slate-50 focus:bg-blue-50 focus:ring-1 focus:ring-blue-300" value={thinkingDraft} onChange={(event) => setThinkingDraft(event.currentTarget.value)} aria-label={tr("Session thinking level")}>
      {SESSION_THINKING_OPTIONS.map((option) => <option value={option.value} key={option.value}>{tr(option.label)}</option>)}
      {currentThinking && !SESSION_THINKING_OPTIONS.some((option) => option.value === currentThinking) ? <option value={currentThinking}>{currentThinking}</option> : null}
    </select> : null}
    {hasChanges ? <Button type="button" variant="primary" size="sm" className="desktop-chat-toolbar-control h-8 shrink-0 rounded-xl px-3 shadow-sm shadow-blue-200 transition-all" disabled={saving} onClick={() => void applyChanges()}>{saving ? tr("Applying…") : tr("Apply")}</Button> : null}
    {hasOverrides ? <Button type="button" variant="secondary" size="sm" className="h-8 shrink-0 rounded-xl border-slate-200/80 bg-white/75 text-slate-500" disabled={saving} onClick={() => void resetDefaults()} aria-label={sessionRuntimeUi(session).sdk ? tr('Reset model default') : tr('Reset model and thinking defaults')} title={sessionRuntimeUi(session).sdk ? tr('Reset model default') : tr('Reset model and thinking defaults')}><RotateCcw size={14} />{tr("Reset defaults")}</Button> : null}
    {message ? <span className="absolute right-0 top-full z-30 mt-2 max-w-sm rounded-xl border border-slate-200 bg-white p-3 text-xs font-normal text-slate-700 shadow-lg" role="status">{message}<button type="button" className="ml-2 underline" onClick={() => setMessage(undefined)}>{tr("Dismiss")}</button></span> : null}
  </div>;
}

async function confirmSignOut() {
  if (await confirmAction({ title: translate('Sign out?'), description: translate('This signs out this browser. Your sessions and running tasks will continue.'), confirmLabel: translate('Sign out') })) lockDeck();
}

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  const { locale } = useI18n();
  return <div className="flex items-center justify-between gap-3 rounded-2xl bg-white/60 px-3 py-2"><dt className="text-slate-500">{translate(label, locale)}</dt><dd className="font-bold text-slate-800">{value}</dd></div>;
}

type AgentsPageProps = {
  agents: AgentSummary[];
  sessions: HubSessionsState;
  compact?: boolean;
  mode?: 'full' | 'rail' | 'browser';
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  creating?: boolean;
  onOpenSession?: (session: SessionSummary) => void;
  onCreateSession?: (agentId: string, title: string) => void | Promise<void>;
};

type AgentPageItem = AgentSummary & {
  nativeAgentId: string;
  connectionId: string;
  sessions: SessionSummary[];
  latestSession?: SessionSummary | undefined;
  displayStatus: SessionSummary['status'];
  sessionCount: number;
  runningCount: number;
  failedCount: number;
  totalMessages: number;
  totalTokens: number;
  groupLabel: string;
};

function AgentsPage({ agents, sessions, compact = false, mode = 'full', selectedAgentId: controlledSelectedAgentId, onSelectAgent }: AgentsPageProps) {
  const { t: tr } = useI18n();
  const [agentSearch, setAgentSearch] = useState('');
  const [localSelectedAgentId, setLocalSelectedAgentId] = useState('');
  const selectedAgentId = controlledSelectedAgentId ?? localSelectedAgentId;
  const setSelectedAgentId = onSelectAgent ?? setLocalSelectedAgentId;
  const deferredAgentSearch = useDeferredValue(agentSearch);
  const [inventory, setInventory] = useState<Array<{ connectionId: string; agent: AgentSummary }>>([]);
  const [inventoryError, setInventoryError] = useState('');
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const connectionKey = JSON.stringify((sessions.connections ?? []).map(connection => [connection.id, connection.ownerUserId, connection.connectorUrl, connection.updatedAt, connection.status === 'disabled']));
  useEffect(() => {
    const controller = new AbortController();
    setInventory([]); setInventoryError(''); setInventoryLoading(true);
    void Promise.all((sessions.connections ?? []).filter(connection => connection.status !== 'disabled').map(async connection => {
      try { return { id: connection.id, agents: (await api.hubConnectionAgents(connection.id, controller.signal)).agents }; }
      catch { return { id: connection.id, agents: [] as AgentSummary[], unavailable: true }; }
    })).then(results => {
      if (controller.signal.aborted) return;
      setInventoryLoading(false);
      setInventory(results.flatMap(result => result.agents.map(agent => ({ connectionId: result.id, agent }))));
      if (results.some(result => result.unavailable)) setInventoryError('Some environments could not load their agent inventory. Showing known sessions; workspace access still requires Connector permission.');
    });
    return () => controller.abort();
  }, [connectionKey]);
  const effectiveAgents = useMemo<AgentPageItem[]>(() => {
    const byId = new Map<string, { agent: AgentSummary; connectionId: string }>();
    const identity = (connectionId: string, agentId: string) => JSON.stringify([connectionId, agentId]);
    for (const row of inventory) byId.set(identity(row.connectionId, row.agent.id), row);
    for (const group of sessions.groups) {
      for (const session of group.sessions) {
        const connectionId = (session as SessionSummary & { envConnectionId?: string }).envConnectionId;
        if (!connectionId) continue;
        const key = identity(connectionId, group.agentId);
        if (!byId.has(key)) byId.set(key, { connectionId, agent: { id: group.agentId, label: group.agentId, status: 'active' } });
      }
    }
    return [...byId.entries()].map(([id, { agent, connectionId }]) => {
      const agentSessions = (sessions.groups.find((group) => group.agentId === agent.id)?.sessions ?? []).filter(session => (session as SessionSummary & { envConnectionId?: string }).envConnectionId === connectionId);
      const orderedSessions = [...agentSessions].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
      const statuses = orderedSessions.map(effectiveSessionStatus);
      const displayStatus = aggregateAgentStatus(agent.status, statuses);
      return {
        ...agent,
        id, nativeAgentId: agent.id, connectionId,
        sessions: orderedSessions,
        latestSession: orderedSessions[0],
        displayStatus,
        sessionCount: orderedSessions.length,
        runningCount: statuses.filter((status) => status === 'running').length,
        failedCount: statuses.filter((status) => status === 'failed').length,
        totalMessages: orderedSessions.reduce((sum, session) => sum + (session.messageCount ?? 0), 0),
        totalTokens: orderedSessions.reduce((sum, session) => sum + (session.totalTokens ?? session.estimatedTokens ?? 0), 0),
        groupLabel: sessions.connections?.find(connection => connection.id === connectionId)?.label ?? connectionId,
      };
    }).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || agentRank(a.nativeAgentId) - agentRank(b.nativeAgentId) || a.nativeAgentId.localeCompare(b.nativeAgentId));
  }, [inventory, sessions]);

  const filteredAgents = useMemo(() => {
    const query = deferredAgentSearch.trim().toLowerCase();
    if (!query) return effectiveAgents;
    return effectiveAgents.filter((agent) => [
      agent.id,
      agent.label,
      agent.status,
      agent.displayStatus,
      agent.groupLabel,
      agent.latestSession?.title,
      agent.latestSession?.recent,
      agent.latestSession?.model,
    ].some((value) => value?.toLowerCase().includes(query)));
  }, [deferredAgentSearch, effectiveAgents]);

  const pageStats = useMemo(() => ({
    running: effectiveAgents.reduce((sum, agent) => sum + agent.runningCount, 0),
    sessions: effectiveAgents.reduce((sum, agent) => sum + agent.sessionCount, 0),
    failed: effectiveAgents.reduce((sum, agent) => sum + agent.failedCount, 0),
  }), [effectiveAgents]);

  useEffect(() => {
    if (effectiveAgents.length === 0) return;
    if (selectedAgentId && filteredAgents.some((agent) => agent.id === selectedAgentId)) return;
    const fallbackAgent = filteredAgents[0] ?? effectiveAgents[0];
    if (fallbackAgent) setSelectedAgentId(fallbackAgent.id);
  }, [effectiveAgents, filteredAgents, selectedAgentId]);

  const selectedAgent = useMemo(() => effectiveAgents.find((agent) => agent.id === selectedAgentId) ?? filteredAgents[0] ?? effectiveAgents[0], [effectiveAgents, filteredAgents, selectedAgentId]);

  const agentRail = <AgentFileBrowserRail
    agentSearch={agentSearch}
    setAgentSearch={setAgentSearch}
    deferredAgentSearch={deferredAgentSearch}
    effectiveAgents={effectiveAgents}
    filteredAgents={filteredAgents}
    selectedAgent={selectedAgent}
    onSelectAgent={setSelectedAgentId}
  />;

  const browserPanel = selectedAgent ? <FileBrowser
    key={selectedAgent.id}
    title={tr("Workspace browser")}
    description={tr("Read-only workspace on the selected Connector. Sensitive files are hidden server-side.")}
    mode="agent"
    connectionId={selectedAgent.connectionId}
    agentIds={[selectedAgent.nativeAgentId]}
    initialAgentId={selectedAgent.nativeAgentId}
    hideAgentSelector
  /> : <Card className="grid min-h-80 place-items-center border-white/70 bg-white/70 p-6 text-center text-sm font-semibold text-slate-500">{tr("Select an agent to browse its workspace.")}</Card>;

  if (mode === 'rail') return <>{inventoryLoading && <p role="status">{tr("Loading environments…")}</p>}{inventoryError && <p role="status" className="p-2 text-xs text-amber-800">{translate(inventoryError)}</p>}{agentRail}</>;
  if (mode === 'browser') return <>{inventoryError && <p role="status" className="p-3 text-sm text-amber-800">{translate(inventoryError)}</p>}{browserPanel}</>;

  if (effectiveAgents.length === 0) {
    return <div className="page-stack"><article className="card" role="status"><strong>{inventoryLoading ? tr("Loading environments…") : tr('No agents available')}</strong><p>{inventoryError ? translate(inventoryError) : tr('Connect an environment and enable an agent to browse its configured workspace.')}</p></article></div>;
  }

  return <div className="space-y-3">
    {inventoryError && <p role="status" className="p-3 text-sm text-amber-800">{translate(inventoryError)}</p>}
    {!compact ? <Card className="overflow-hidden border-white/70 bg-white/72 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-black uppercase tracking-[0.18em] text-blue-600">{tr("Agent files")}</p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.04em] text-slate-950">{tr("Browse agent workspaces")}</h2>
          <p className="mt-1 text-xs font-semibold text-slate-500">{tr('{agents} agents · {sessions} sessions · {running} run · {failed} failed', { agents: effectiveAgents.length, sessions: pageStats.sessions, running: pageStats.running, failed: pageStats.failed })}</p>
        </div>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[1.2rem] bg-blue-600 text-white shadow-lg shadow-blue-600/20"><Bot size={21} /></span>
      </div>
    </Card> : null}

    <div className="grid gap-3 xl:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]">
      <Card className="overflow-hidden border-white/70 bg-white/72 p-0 shadow-sm">
        <div className="border-b border-slate-200/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[0.62rem] font-black uppercase tracking-[0.16em] text-blue-600">{tr("Agents")}</p>
              <p className="text-xs font-semibold text-slate-500">{tr("Pick one workspace")}</p>
            </div>
            <Badge variant="muted" className="px-2 py-0.5 text-[0.6rem]">{filteredAgents.length}/{effectiveAgents.length}</Badge>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <Input aria-label={tr("Search agents")} className="h-8 rounded-2xl border-white/80 bg-white/75 pl-8 pr-8 text-[0.72rem] shadow-none" placeholder={tr("Search agents...")} value={agentSearch} onChange={(event) => setAgentSearch(event.currentTarget.value)} />
            {agentSearch ? <button type="button" className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-xs font-black text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" onClick={() => setAgentSearch('')} aria-label={tr("Clear agent search")}>×</button> : null}
          </div>
        </div>

        <div className="max-h-[calc(100vh-14rem)] overflow-auto p-2">
          {filteredAgents.length === 0 ? <div className="rounded-2xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">{tr('No agents match “{query}”.', { query: deferredAgentSearch.trim() })}</div> : null}
          {filteredAgents.map((agent) => {
            const tone = agentTone(agent.nativeAgentId);
            const active = agent.id === selectedAgent?.id;
            return <button
              key={agent.id}
              type="button"
              className={cn('mb-1.5 grid w-full gap-1 rounded-2xl border px-2.5 py-2 text-left transition last:mb-0 hover:-translate-y-px hover:bg-white', active ? 'border-blue-200 bg-blue-50/80 shadow-sm shadow-blue-600/10' : 'border-transparent bg-white/45')}
              onClick={() => setSelectedAgentId(agent.id)}
              aria-pressed={active}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span style={{ background: tone.gradient }} className="grid h-7 w-7 shrink-0 place-items-center rounded-xl text-[0.68rem] font-black text-white shadow-sm">{agentInitial(agent.nativeAgentId)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-black leading-4 text-slate-900">{agent.label ?? shortAgent(agent.nativeAgentId)}</span>
                  <span className="block truncate text-[0.64rem] font-semibold text-slate-500">{agent.nativeAgentId}</span>
                </span>
                <Badge variant={sessionStatusBadgeVariant(agent.displayStatus)} className="shrink-0 px-1.5 py-0 text-[0.56rem] uppercase">{translate(sessionStatusLabel(agent.displayStatus))}</Badge>
              </span>
              <span className="flex items-center justify-between gap-2 pl-9 text-[0.62rem] font-bold text-slate-500">
                <span>{agent.groupLabel}</span>
                <span>{tr('{count} sessions', { count: formatCompactNumber(agent.sessionCount) })}</span>
              </span>
            </button>;
          })}
        </div>
      </Card>

      <div className="min-w-0">
        {selectedAgent ? <FileBrowser
          key={selectedAgent.id}
          title={tr("Workspace browser")}
          description={tr("Read-only workspace on the selected Connector. Sensitive files are hidden server-side.")}
          mode="agent"
          connectionId={selectedAgent.connectionId}
          agentIds={[selectedAgent.nativeAgentId]}
          initialAgentId={selectedAgent.nativeAgentId}
          hideAgentSelector
        /> : <Card className="grid min-h-80 place-items-center border-white/70 bg-white/70 p-6 text-center text-sm font-semibold text-slate-500">{tr("Select an agent to browse its workspace.")}</Card>}
      </div>
    </div>
  </div>;
}


function AgentFileBrowserRail({
  agentSearch,
  setAgentSearch,
  deferredAgentSearch,
  effectiveAgents,
  filteredAgents,
  selectedAgent,
  onSelectAgent,
}: {
  agentSearch: string;
  setAgentSearch: (value: string) => void;
  deferredAgentSearch: string;
  effectiveAgents: AgentPageItem[];
  filteredAgents: AgentPageItem[];
  selectedAgent: AgentPageItem | undefined;
  onSelectAgent: (agentId: string) => void;
}) {
  const { t: tr } = useI18n();
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <div className="border-b border-white/60 px-1 pb-3 pt-1">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[0.62rem] font-black uppercase tracking-[0.16em] text-blue-600">{tr("Agents")}</p>
          <p className="text-xs font-semibold text-slate-500">{tr("Pick one workspace")}</p>
        </div>
        <Badge variant="muted" className="px-2 py-0.5 text-[0.6rem]">{filteredAgents.length}/{effectiveAgents.length}</Badge>
      </div>
      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
        <Input aria-label={tr("Search agents")} className="h-8 rounded-2xl border-white/80 bg-white/75 pl-8 pr-8 text-[0.72rem] shadow-none" placeholder={tr("Search agents...")} value={agentSearch} onChange={(event) => setAgentSearch(event.currentTarget.value)} />
        {agentSearch ? <button type="button" className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-xs font-black text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" onClick={() => setAgentSearch('')} aria-label={tr("Clear agent search")}>×</button> : null}
      </div>
    </div>

    <div className="min-h-0 flex-1 overflow-auto px-0.5 py-2">
      {filteredAgents.length === 0 ? <div className="rounded-2xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">{tr('No agents match “{query}”.', { query: deferredAgentSearch.trim() })}</div> : null}
      {filteredAgents.map((agent) => {
        const tone = agentTone(agent.nativeAgentId);
        const active = agent.id === selectedAgent?.id;
        return <button
          key={agent.id}
          type="button"
          className={cn('mb-1.5 grid w-full gap-1 rounded-2xl border px-2.5 py-2 text-left transition last:mb-0 hover:-translate-y-px hover:bg-white', active ? 'border-blue-200 bg-blue-50/80 shadow-sm shadow-blue-600/10' : 'border-transparent bg-white/45')}
          onClick={() => onSelectAgent(agent.id)}
          aria-pressed={active}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span style={{ background: tone.gradient }} className="grid h-7 w-7 shrink-0 place-items-center rounded-xl text-[0.68rem] font-black text-white shadow-sm">{agentInitial(agent.nativeAgentId)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-black leading-4 text-slate-900">{agent.label ?? shortAgent(agent.nativeAgentId)}</span>
              <span className="block truncate text-[0.64rem] font-semibold text-slate-500">{agent.nativeAgentId}</span>
            </span>
            <Badge variant={sessionStatusBadgeVariant(agent.displayStatus)} className="shrink-0 px-1.5 py-0 text-[0.56rem] uppercase">{translate(sessionStatusLabel(agent.displayStatus))}</Badge>
          </span>
          <span className="flex items-center justify-between gap-2 pl-9 text-[0.62rem] font-bold text-slate-500">
            <span>{agent.groupLabel}</span>
            <span>{tr('{count} sessions', { count: formatCompactNumber(agent.sessionCount) })}</span>
          </span>
        </button>;
      })}
    </div>
  </div>;
}

function MetricPill({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="min-w-0 rounded-2xl bg-white/70 px-2.5 py-2 ring-1 ring-slate-200/70"><dt className="truncate text-slate-400">{label}</dt><dd className="truncate font-black text-slate-800">{value}</dd></div>;
}

function aggregateAgentStatus(agentStatus: string | undefined, statuses: SessionSummary['status'][]): SessionSummary['status'] {
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('pending_subagent')) return 'pending_subagent';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('idle')) return 'idle';
  if (isKnownSessionStatus(agentStatus)) return agentStatus;
  if (agentStatus === 'active' || agentStatus === 'online') return 'idle';
  return 'unknown';
}

function isKnownSessionStatus(value: string | undefined): value is SessionSummary['status'] {
  return value === 'idle' || value === 'running' || value === 'failed' || value === 'waiting' || value === 'pending_subagent' || value === 'unknown';
}


// ---------------------------------------------------------------------------
// EnvFilterChips — shown in the sessions rail when multiple environments exist
// ---------------------------------------------------------------------------
type EnvOption = { id: string; label: string; kind: 'local' | 'remote' };

function EnvFilterChips({
  envOptions,
  selected,
  connections,
  onChange,
}: {
  envOptions: EnvOption[];
  selected: string;
  connections?: HubConnection[] | undefined;
  onChange: (id: string) => void;
}) {
  const { t: tr } = useI18n();
  /** Map connectionId → status from hub connections state for health indicators */
  const connStatus = React.useMemo(() => {
    const map = new Map<string, import('./api').HubConnectionStatus>();
    for (const c of (connections ?? [])) map.set(c.id, c.status);
    return map;
  }, [connections]);

  // Helper to get a non-undefined status (for exactOptionalPropertyTypes)
  function getConnStatus(id: string): import('./api').HubConnectionStatus | undefined {
    return connStatus.get(id);
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1 xl:mt-3" role="group" aria-label={tr("Filter by environment")}>
      <EnvChip active={selected === 'all'} onClick={() => onChange('all')} label="All" />
      {envOptions.map((env) => {
        const envStatus = getConnStatus(env.id);
        return (
          <EnvChip
            key={env.id}
            active={selected === env.id}
            onClick={() => onChange(env.id)}
            label={env.label}
            kind={env.kind}
            status={envStatus}
          />
        );
      })}
    </div>
  );
}

function EnvChip({
  active,
  onClick,
  label,
  kind,
  status,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  kind?: 'local' | 'remote' | undefined;
  status?: import('./api').HubConnectionStatus | undefined;
}) {
  const degraded = status === 'degraded';
  const disabled = status === 'disabled';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50',
        active
          ? 'border-blue-400/60 bg-blue-600 text-white shadow'
          : degraded
            ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
            : disabled
              ? 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100'
              : 'border-white/70 bg-white/60 text-slate-600 hover:bg-white/90 hover:text-slate-900',
      )}
      aria-pressed={active}
    >
      {degraded && !active ? <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" /> : null}
      {!degraded && kind === 'remote' && !active ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> : null}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// EnvironmentHealthSummary — shown in GatewayPage above HubConnectionsPanel
// ---------------------------------------------------------------------------
function EnvironmentHealthSummary({ connections }: { connections: HubConnection[] }) {
  const { t: tr } = useI18n();
  const summary = connectionHealthSummary(connections);
  if (summary.total === 0) return null;

  const hasDegraded = summary.degraded > 0;

  return (
    <div
      className={cn(
        'rounded-2xl border px-4 py-3',
        hasDegraded
          ? 'border-red-200 bg-red-50'
          : 'border-emerald-200 bg-emerald-50',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn('text-sm font-black', hasDegraded ? 'text-red-700' : 'text-emerald-800')}>
            {hasDegraded ? tr('⚠️ Environment Health Issue') : tr('✅ Environments Healthy')}
          </span>
          <ConnectionHealthPill connections={connections} />
        </div>
        <span className="text-xs text-slate-500">
          {tr('{healthy} healthy · {degraded} degraded · {disabled} disabled of {total}', { healthy: summary.enabled, degraded: summary.degraded, disabled: summary.disabled, total: summary.total })}
        </span>
      </div>
      {hasDegraded && (
        <ul className="mt-2 space-y-1">
          {connections.filter((c) => c.status === 'degraded').map((c) => (
            <li key={c.id} className="flex min-w-0 items-start gap-2 text-xs text-red-700">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
              <span><strong>{c.environmentLabel ?? c.label ?? c.id}</strong>{c.error ? <span className="ml-1 font-normal opacity-80">— {c.error}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UsersAccessPage({ connections }: { connections: HubConnection[] }) {
  const { t: tr } = useI18n();
  const [principal, setPrincipal] = useState<import('./api').HubPrincipal>();
  const [principalError, setPrincipalError] = useState(false);
  const [hubUsers, setHubUsers] = useState<HubUser[]>([]);
  const [hubUsersLoading, setHubUsersLoading] = useState(true);
  const [hubUsersError, setHubUsersError] = useState<string>();
  const [connectorUsers, setConnectorUsers] = useState<ConnectorUsersByConnection[]>([]);
  const [connectorUsersLoading, setConnectorUsersLoading] = useState(true);
  const [connectorUsersError, setConnectorUsersError] = useState<string>();
  const [directoryWrites, setDirectoryWrites] = useState(0);

  const refreshHubUsers = useCallback(async () => {
    setHubUsersLoading(true);
    setHubUsersError(undefined);
    setConnectorUsersLoading(true);
    setConnectorUsersError(undefined);
    await Promise.all([
      api.hubMe().then(actor => { setPrincipal(actor); setPrincipalError(false); })
        .catch(() => { setPrincipal(undefined); setPrincipalError(true); }),
      api.hubUsers().then(data => setHubUsers(data.users))
        .catch(error => setHubUsersError(error instanceof Error ? error.message : String(error)))
        .finally(() => setHubUsersLoading(false)),
      api.hubConnectorUsers().then(data => setConnectorUsers(data.connections))
        .catch(error => setConnectorUsersError(error instanceof Error ? error.message : String(error)))
        .finally(() => setConnectorUsersLoading(false)),
    ]);
  }, []);

  useEffect(() => {
    void refreshHubUsers();
  }, [refreshHubUsers]);

  async function createHubUser(label: string) {
    const { user } = await api.hubCreateUser({ label });
    setHubUsers((current) => [...current.filter((item) => item.id !== user.id), user]);
    return user;
  }

  async function renameHubUser(id: string, label: string) {
    const { user } = await api.hubUpdateUser(id, { label });
    setHubUsers((current) => current.map((item) => item.id === id ? user : item));
  }

  async function createConnectorUser(connectionId: string, label: string) {
    const { user } = await api.hubCreateConnectorUser(connectionId, { label });
    setConnectorUsers(current => current.map(connection => {
      if (connection.id !== connectionId) return connection;
      const users = [...connection.users.filter(item => item.id !== user.id), user];
      return { ...connection, users, userCount: users.length };
    }));
  }

  async function renameConnectorUser(connectionId: string, id: string, label: string) {
    const { user } = await api.hubUpdateConnectorUser(connectionId, id, { label });
    setConnectorUsers(current => current.map(connection => connection.id !== connectionId ? connection : {
      ...connection, users: connection.users.map(item => item.id === id ? user : item),
    }));
  }

  async function directoryWrite<Result>(operation: () => Promise<Result>) {
    setDirectoryWrites(count => count + 1);
    try { return await operation(); }
    finally { setDirectoryWrites(count => count - 1); }
  }

  return <div className="w-full min-w-0 space-y-2" aria-label={tr("Users and access workspace")}>
    {principalError ? <p role="alert">{tr("Current permissions unavailable. Administration is disabled; refresh to retry.")}</p> : null}
    <div className="flex justify-end"><Button variant="secondary" disabled={hubUsersLoading || connectorUsersLoading || directoryWrites > 0} onClick={() => void refreshHubUsers()}>{tr("Refresh directories")}</Button></div>
    {hubUsersError ? <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{tr("Hub directory unavailable; any previous records may be stale:")}{hubUsersError}</p> : null}
    {connectorUsersError ? <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{tr("Connector directory unavailable; any previous records may be stale:")}{connectorUsersError}</p> : null}
    <AccessControlPage
      principal={principal}
      users={hubUsers}
      connections={connections}
      connectorConnections={connectorUsers}
      loading={hubUsersLoading}
      connectorLoading={connectorUsersLoading}
      hubUnavailable={Boolean(hubUsersError)}
      connectorUnavailable={Boolean(connectorUsersError)}
      onCreate={label => directoryWrite(() => createHubUser(label))}
      onRename={(id, label) => directoryWrite(() => renameHubUser(id, label))}
      onCreateConnectorUser={(connectionId, label) => directoryWrite(() => createConnectorUser(connectionId, label))}
      onRenameConnectorUser={(connectionId, id, label) => directoryWrite(() => renameConnectorUser(connectionId, id, label))}
    />
  </div>;
}

function GatewayPage({ gateway, hubConnections }: { gateway: GatewayHealth | undefined; hubConnections?: HubConnection[] }) {
  const { t: tr } = useI18n();
  return <div className="space-y-4">
    <GatewayStatus gateway={gateway} />
    {hubConnections && hubConnections.length > 0 ? <EnvironmentHealthSummary connections={hubConnections} /> : null}
    <HubConnectionsPanel {...(hubConnections ? { initialConnections: hubConnections } : {})} />
    <FileBrowser
      title={tr("Gateway OpenClaw browser")}
      description={tr("Rooted at the server's configured OpenClaw home. Sensitive items are hidden/blocked; openclaw.json files are read-only and not downloadable.")}
      mode="gateway"
    />
  </div>;
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return <article className="card hero"><strong>{title}</strong><p>{text}</p></article>;
}

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const { t: tr } = useI18n();
  const tabs: { id: Tab; icon: React.ReactNode }[] = [
    { id: 'dashboard', icon: <BarChart3 size={14} /> },
    { id: 'sessions', icon: <Home size={14} /> },
    { id: 'agents', icon: <Bot size={14} /> },
    { id: 'media', icon: <Film size={14} /> },
    { id: 'channels', icon: <NavIcon name="ops" /> },
    { id: 'gateway', icon: <ServerCog size={14} /> },
    { id: 'users', icon: <UserCog size={14} /> },
  ];
  return <nav className="mobile-bottom-nav">
    <div className="mobile-bottom-nav-inner">
      {tabs.map((item) => <button
        className={cn('flex min-h-9 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1 text-[0.58rem] font-bold leading-none text-slate-500 transition active:scale-[0.98]', tab === item.id && 'aod-blue-gradient text-white shadow-sm')}
        onClick={() => setTab(item.id)}
        key={item.id}
      >{item.icon}<span className="truncate max-w-full">{tr(navLabel(item.id))}</span></button>)}
    </div>
  </nav>;
}

function NavIcon({ name }: { name: 'messages' | 'agents' | 'ops' | 'gateway' | 'refresh' | 'back' | 'image' }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (name === 'messages') return <svg {...common}><path d="M4.5 6.5A3.5 3.5 0 0 1 8 3h8a3.5 3.5 0 0 1 3.5 3.5v5A3.5 3.5 0 0 1 16 15H9l-4.5 4v-12.5Z" /><path d="M8 8h8M8 11h5" /></svg>;
  if (name === 'agents') return <svg {...common}><path d="M16 18.5a4 4 0 0 0-8 0" /><circle cx="12" cy="10" r="3" /><path d="M19 19a3 3 0 0 0-2.2-2.9M5 19a3 3 0 0 1 2.2-2.9" /></svg>;
  if (name === 'ops') return <svg {...common}><path d="M12 3v4M12 17v4M4.2 7.5l3.5 2M16.3 14l3.5 2M19.8 7.5l-3.5 2M7.7 14l-3.5 2" /><circle cx="12" cy="12" r="3.2" /></svg>;
  if (name === 'gateway') return <svg {...common}><path d="M5 18.5h14" /><path d="M7 18.5V8.2A2.2 2.2 0 0 1 9.2 6h5.6A2.2 2.2 0 0 1 17 8.2v10.3" /><path d="M10 10h4M10 13h4" /></svg>;
  if (name === 'refresh') return <svg {...common}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></svg>;
  if (name === 'image') return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.4" /><path d="M7 16l3.2-3.2a1.2 1.2 0 0 1 1.7 0L14 15l1.1-1.1a1.2 1.2 0 0 1 1.7 0L18 15.1" /></svg>;
  return <svg {...common}><path d="M15 18l-6-6 6-6" /></svg>;
}


function PendingAttachmentPreview({ item, onRemove, size }: { item: SendMessageUpload; onRemove: () => void; size: 'desktop' | 'mobile' }) {
  const isImage = item.type === 'image';
  const boxClass = size === 'desktop' ? 'h-16 w-16 rounded-2xl' : 'h-12 w-12 rounded-xl';
  const fileClass = size === 'desktop' ? 'h-16 max-w-[13rem] rounded-2xl px-2.5' : 'h-12 max-w-[11rem] rounded-xl px-2';
  if (isImage) return <span className={cn('relative shrink-0 overflow-hidden border border-white/80 bg-slate-100 shadow-sm', boxClass)} title={`${item.name} · ${formatBytes(item.size ?? estimateDataUrlBytes(item.dataUrl))}`}>
    <img className="h-full w-full object-cover" src={item.dataUrl} alt={item.name} />
    <button className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-slate-950/70 text-xs font-bold text-white" type="button" onClick={onRemove} aria-label={`Remove ${item.name}`}>×</button>
  </span>;
  return <span className={cn('relative flex shrink-0 items-center gap-2 border border-slate-200 bg-slate-50 pr-7 text-left shadow-sm', fileClass)} title={`${item.name} · ${attachmentTypeLabel(item)} · ${formatBytes(item.size ?? estimateDataUrlBytes(item.dataUrl))}`}>
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-base" aria-hidden="true">📎</span>
    <span className="min-w-0">
      <span className="block truncate text-xs font-black text-slate-800">{item.name}</span>
      <span className="block truncate text-[0.62rem] font-bold text-slate-500">{attachmentTypeLabel(item)} · {formatBytes(item.size ?? estimateDataUrlBytes(item.dataUrl))}</span>
    </span>
    <button className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-slate-950/70 text-xs font-bold text-white" type="button" onClick={onRemove} aria-label={`Remove ${item.name}`}>×</button>
  </span>;
}

function attachmentTypeLabel(item: Pick<SendMessageUpload, 'mimeType' | 'type'>) {
  if (item.type === 'image') return 'image';
  return item.mimeType?.split('/').pop()?.replace(/^x-/, '') || 'file';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mergePendingUploads(current: SendMessageUpload[], incoming: SendMessageUpload[]) {
  const next = [...current, ...incoming];
  if (next.length > COMPOSER_MAX_MEDIA_ITEMS) throw new Error(`Max ${COMPOSER_MAX_MEDIA_ITEMS} attachments per message.`);
  const totalBytes = next.reduce((sum, item) => sum + estimateDataUrlBytes(item.dataUrl), 0);
  if (totalBytes > COMPOSER_MAX_TOTAL_MEDIA_BYTES) throw new Error('Attachments are too large. Max 24MB per message.');
  return next;
}

async function filesToUploads(files: File[]): Promise<SendMessageUpload[]> {
  if (files.length > COMPOSER_MAX_MEDIA_ITEMS) throw new Error(`Max ${COMPOSER_MAX_MEDIA_ITEMS} attachments per message.`);
  return Promise.all(files.map(async (file, index) => {
    const mimeType = normalizeAttachmentMimeType(file);
    if (!isSupportedAttachment(file, mimeType)) throw new Error(`${file.name || 'attachment'} is not supported. Supported: images, MP4, audio, PDF, text/data files, Office documents, and ZIP/GZip/TAR.`);
    if (file.size > COMPOSER_MAX_MEDIA_BYTES) throw new Error(`${file.name || 'attachment'} is too large. Max 12MB.`);
    const type = mimeType.startsWith('image/') ? 'image' as const : 'file' as const;
    return {
      type,
      name: file.name || (type === 'image' ? `pasted-image-${Date.now()}-${index}.png` : `attachment-${Date.now()}-${index}.${extensionForMimeType(mimeType)}`),
      mimeType,
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    };
  }));
}

function normalizeAttachmentMimeType(file: File) {
  const fromExtension = mimeTypeFromName(file.name);
  if (fromExtension) return fromExtension;
  return file.type || fromExtension || 'application/octet-stream';
}

function isSupportedAttachment(file: File, mimeType: string) {
  const extensionMimeType = mimeTypeFromName(file.name);
  return COMPOSER_ALLOWED_MIME_TYPES.has(mimeType) || Boolean(extensionMimeType && COMPOSER_ALLOWED_MIME_TYPES.has(extensionMimeType));
}

function mimeTypeFromName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt' || ext === 'log') return 'text/plain';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json') return 'application/json';
  if (ext === 'yaml' || ext === 'yml') return 'application/yaml';
  if (ext === 'xml') return 'application/xml';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
  if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (ext === 'zip') return 'application/zip';
  if (ext === 'gz') return 'application/gzip';
  if (ext === 'tar') return 'application/x-tar';
  return undefined;
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/mp4') return 'm4a';
  if (mimeType === 'audio/wav') return 'wav';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/plain') return 'txt';
  if (mimeType === 'text/markdown') return 'md';
  if (mimeType === 'text/csv') return 'csv';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'application/yaml') return 'yaml';
  if (mimeType === 'application/xml') return 'xml';
  if (mimeType === 'application/msword') return 'doc';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mimeType === 'application/vnd.ms-excel') return 'xls';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (mimeType === 'application/vnd.ms-powerpoint') return 'ppt';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') return 'zip';
  if (mimeType === 'application/gzip') return 'gz';
  if (mimeType === 'application/x-tar') return 'tar';
  return 'bin';
}

function estimateDataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.split(',')[1] ?? '';
  return Math.ceil(base64.length * 0.75);
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

function readableSessionName(session: SessionSummary) {
  return displayTitle(session);
}

function readableEventSessionName(event: DeckEvent) {
  const payload = event.payload as Partial<SessionSummary> | undefined;
  if (payload?.sessionKey || payload?.title || payload?.agentId) {
    return readableSessionName({
      ...(payload as SessionSummary),
      sessionKey: String(payload.sessionKey ?? event.sessionKey ?? ''),
      agentId: String(payload.agentId ?? event.agentId ?? 'agent'),
      status: (payload.status as SessionSummary['status']) ?? 'idle',
    });
  }
  if (event.sessionKey) return displayTitle({ sessionKey: event.sessionKey, agentId: event.agentId ?? 'agent', status: 'idle' } as SessionSummary);
  return event.agentId ? shortAgent(event.agentId) : undefined;
}

function readableEnvLabel(label: string | undefined) {
  if (!label || label === 'Local Connector') return undefined;
  return label.length > 32 ? compactKey(label) : label;
}

function sessionContextPercent(session: SessionSummary) {
  const { used, limit } = contextUsageValues(session);
  if (used === undefined || !limit) return 'n/a';
  return `${Math.max(0, Math.min(100, Math.round((Number(used) / limit) * 100)))}%`;
}

function statusAgeLabel(session: SessionSummary, status: SessionSummary['status'], now = Date.now()) {
  if (status === 'idle') return '';
  // Running age must be based on the current run only. lastActiveAt can be the
  // age of the whole session and produced misleading RUNNING@242H badges.
  const startedAt = status === 'running' ? session.runStartedAt : session.lastActiveAt;
  if (!startedAt) return '';
  const minutes = Math.max(0, Math.round((now - startedAt) / 60_000));
  if (minutes < 60) return String(minutes) + 'm';
  const hours = minutes / 60;
  return (hours < 10 ? hours.toFixed(1) : String(Math.round(hours))) + 'H';
}

function sessionStatusToneClass(status: SessionSummary['status'], selected: boolean) {
  if (selected) {
    if (status === 'running') return 'bg-blue-200 text-blue-950 ring-1 ring-blue-100/60';
    if (status === 'failed') return 'bg-red-200 text-red-900 ring-1 ring-red-100/70';
    if (status === 'waiting' || status === 'pending_subagent') return 'bg-amber-200 text-amber-950 ring-1 ring-amber-100/70';
    return 'bg-white/15 text-white';
  }
  if (status === 'running') return 'bg-blue-100 text-blue-800 ring-1 ring-blue-200';
  if (status === 'failed') return 'bg-red-100 text-red-700 ring-1 ring-red-200';
  if (status === 'waiting' || status === 'pending_subagent') return 'bg-amber-100 text-amber-800 ring-1 ring-amber-200';
  return 'bg-slate-100 text-slate-500 ring-1 ring-slate-200';
}

let completionNotification = createCompletionTracker();
const completionViews = new Map<string, Set<(cursor: unknown) => boolean>>();
function registerCompletionView(key: string, ready: (cursor: unknown) => boolean) {
  const views = completionViews.get(key) ?? new Set();
  views.add(ready); completionViews.set(key, views);
  return () => { views.delete(ready); if (!views.size) completionViews.delete(key); };
}
function completionMetadataCurrent(session: SessionSummary | undefined) {
  return !!session && !hasQueueBlockingRun(session) && (!session.runtime?.sync || session.runtime.sync === 'current');
}
const completionDelivery = createCompletionDelivery<{ event: DeckEvent; notification: NonNullable<ReturnType<typeof completionNotification>> }>({
  scope: recoveryScope,
  enabled: () => sharedSessionRoute(location.hash).kind === 'owner',
  read: key => api.sessionMessages(key, MESSAGE_DESKTOP_INITIAL_LOAD_LIMIT),
  ready: (key, cursor) => document.visibilityState === 'hidden' ||
    [...(completionViews.get(key) ?? [])].every(ready => ready(cursor)),
  // Allow React to commit metadata/messages before the OS or peek notification.
  settle: () => new Promise(resolve => {
    if (document.visibilityState === 'hidden') { resolve(); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }),
  deliver: ({ event, notification }) => deliverDeckNotification(event, notification),
});
function deliverDeckNotification(event: DeckEvent, notification: NonNullable<ReturnType<typeof completionNotification>>) {
  if (notification && event.type !== 'queued_message.failed') {
    const payload = event.payload as { session?: SessionSummary; sessionKey?: string } | undefined;
    const session = payload?.session ?? (payload && 'agentId' in payload ? payload as SessionSummary : undefined);
    const key = event.sessionKey ?? session?.sessionKey;
    if (key) window.dispatchEvent(new CustomEvent(SESSION_COMPLETED_EVENT, { detail: { key, tag: notification.tag } }));
  }
  if (notification) void showDesktopNotification(translate(notification.title), {
    body: readableEventSessionName(event) ?? (notification.body === 'Open AgentOpsDeck to view the result.' ? translate(notification.body) : notification.body), tag: notification.tag,
  });
}
function notifyForDeckEvent(event: DeckEvent, barriers: Promise<unknown>[]) {
  // Notebook resource subscriptions may keep the account feed alive in a
  // shared view. Its owner events must not trigger owner transcript reads.
  if (sharedSessionRoute(location.hash).kind !== 'owner') {
    completionDelivery.clear();
    completionNotification = createCompletionTracker();
    return;
  }
  const payload = event.payload as { session?: SessionSummary; runtime?: SessionSummary['runtime']; sessionKey?: string } | undefined;
  const session = payload?.session ?? payload;
  const key = event.sessionKey ?? session?.sessionKey;
  if (event.type === 'stream.reset') completionDelivery.clear();
  if (key && ['starting', 'running', 'waiting'].includes(session?.runtime?.phase ?? '')) completionDelivery.clear(key);
  const notification = completionNotification(event);
  if (notification && event.type === 'queued_message.failed') deliverDeckNotification(event, notification);
  else if (notification && key) completionDelivery.enqueue(key, { event, notification }, event.remoteEventId);
  if (key) void completionDelivery.flush(key, barriers);
}

type DeckEventSubscription = { close: () => void };

const deckEventListeners = new Set<(event: DeckEvent) => void | Promise<unknown>>();
let sharedDeckStream: ReturnType<typeof createReconnectingEventStream> | undefined;
let deckStreamConnection: StreamConnection = 'connecting';
const streamConnectionListeners = new Set<() => void>();
function setDeckStreamConnection(connection: typeof deckStreamConnection) {
  deckStreamConnection = connection;
  for (const listener of streamConnectionListeners) listener();
}

function openDeckEventStream(onEvent: (event: DeckEvent) => void | Promise<unknown>) {
  if (typeof EventSource === 'undefined') return undefined;
  deckEventListeners.add(onEvent);
  if (sharedDeckStream) {
    sharedDeckStream.ensureConnected();
    return closeDeckEventSubscription(onEvent);
  }
  const streamScope = recoveryScope();
  const handleMessage = (message: MessageEvent<string>) => {
    try {
      if (message.type === 'workspace.revisions') {
        if (streamScope && streamScope === recoveryScope()) workspaceResourceEvents.receive(streamScope, JSON.parse(message.data));
        return; // Resource updates must not invalidate transcripts or notify completion.
      }
      const event = JSON.parse(message.data) as DeckEvent;
      if (streamScope && streamScope === recoveryScope()) layoutUnreadEvents.receive(streamScope, event);
      if (event.type === 'interaction.updated') {
        if (streamScope && streamScope === recoveryScope()) sessionInteractionReads.receive(streamScope, event);
        return; // No transcript read or completion notification for a question.
      }
      invalidateNavigationHistory(key => shouldRefreshMessagesForEvent(event, key));
      if (event.type === 'stream.reset') {
        invalidateStreamSnapshotReads(event);
        if (streamScope && streamScope === recoveryScope()) sessionInteractionReads.connected(streamScope);
      }
      if (event.type === 'gateway.status_changed' || event.type === 'channel.status_changed') invalidateMetadataReads();
      const barriers: Promise<unknown>[] = [];
      for (const listener of Array.from(deckEventListeners)) {
        const result = listener(event);
        if (result) { void result.catch(() => {}); barriers.push(result); }
      }
      notifyForDeckEvent(event, barriers);
    } catch {
      // Ignore malformed realtime packets; fallback polling still protects freshness.
    }
  };
  sharedDeckStream = createReconnectingEventStream({
    url: eventStreamUrl, eventTypes: [...DECK_EVENT_TYPES, 'workspace.revisions'],
    onMessage: handleMessage, onConnection: setDeckStreamConnection,
    onOpen: () => {
      if (streamScope && streamScope === recoveryScope()) sessionInteractionReads.connected(streamScope);
      if (streamScope && streamScope === recoveryScope()) workspaceResourceEvents.connected(streamScope);
      // The browser cursor cannot describe every upstream connector. Always
      // refresh snapshots on (re)connect to close that consistency gap.
      const event: DeckEvent = { id: 'stream-open', type: 'stream.reset', ts: Date.now(), payload: { reason: 'connected' } };
      if (streamScope && streamScope === recoveryScope()) layoutUnreadEvents.receive(streamScope, event);
      notifyForDeckEvent(event, []);
      invalidateStreamSnapshotReads(event);
      for (const listener of Array.from(deckEventListeners)) { const result = listener(event); if (result) void result.catch(() => {}); }
    },
  });
  sharedDeckStream.start();
  window.addEventListener('online', wakeDeckEventStream);
  window.addEventListener('focus', wakeDeckEventStream);
  window.addEventListener('pageshow', wakeDeckEventStream);
  document.addEventListener('visibilitychange', wakeDeckEventStream);
  return closeDeckEventSubscription(onEvent);
}

function wakeDeckEventStream() {
  if (document.visibilityState !== 'hidden') sharedDeckStream?.wake();
}

function closeDeckEventSubscription(onEvent: (event: DeckEvent) => void | Promise<unknown>): DeckEventSubscription {
  return {
    close: () => {
      deckEventListeners.delete(onEvent);
      if (deckEventListeners.size === 0) {
        sharedDeckStream?.stop();
        sharedDeckStream = undefined;
        completionNotification = createCompletionTracker();
        completionDelivery.clear();
        window.removeEventListener('online', wakeDeckEventStream);
        window.removeEventListener('focus', wakeDeckEventStream);
        window.removeEventListener('pageshow', wakeDeckEventStream);
        document.removeEventListener('visibilitychange', wakeDeckEventStream);
      }
    },
  };
}

const DECK_EVENT_TYPES = [
  'interaction.updated',
  'stream.reset',
  'stream.status',
  'session.updated',
  'message.created',
  'message.updated',
  'run.updated',
  'run.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'queued_message.created',
  'queued_message.sent',
  'queued_message.failed',
  'gateway.status_changed',
  'channel.status_changed',
  'cron.failure',
] as const satisfies readonly DeckEvent['type'][];
workspaceResourceEvents.configure(() => openDeckEventStream(() => {}));
layoutUnreadEvents.configure(() => openDeckEventStream(() => {}));
sessionInteractionReads.configure(() => openDeckEventStream(() => {}));

function shouldRefreshSessionsForEvent(event: DeckEvent) {
  return isStreamCatchup(event) || event.type === 'session.updated'
    || event.type === 'run.updated'
    || event.type === 'run.completed'
    || event.type === 'queued_message.sent'
    || event.type === 'queued_message.failed'
    || event.type === 'gateway.status_changed'
    || event.type === 'channel.status_changed';
}

function shouldRefreshMessagesForEvent(event: DeckEvent, sessionKey: string) {
  if (isStreamCatchup(event)) return !event.envConnectionId || sessionKey.startsWith(`${event.envConnectionId}:`);
  if (event.sessionKey !== sessionKey) return false;
  return event.type === 'message.created'
    || event.type === 'message.updated'
    || event.type === 'session.updated'
    || event.type === 'run.updated'
    || event.type === 'run.completed'
    || event.type === 'tool.started'
    || event.type === 'tool.completed'
    || event.type === 'tool.failed'
    || event.type === 'queued_message.sent'
    || event.type === 'queued_message.failed';
}

// UI-side defense: even if the server status field momentarily reads idle,
// an active run (hasActiveRun) is authoritative for the "running" badge.
// Keeps desktop/mobile status in sync with agent activity after refresh.
function App() {
  const { t: tr } = useI18n();
  const width = useWindowWidth();
  const { standalone } = usePwaViewportMode();
  const [unlocked, setUnlocked] = useState(false);
  const [authBlocked, setAuthBlocked] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authMessage, setAuthMessage] = useState<string>();
  const [remoteMode, setRemoteMode] = useState(() => location.hash === '#/remote');
  useEffect(() => { const change = () => setRemoteMode(location.hash === '#/remote'); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);

  const authChecked = useCallback((status: StartupAuthStatus) => {
    if (status.authenticated) {
      setRecoveryScope(status.recoveryScope);
      const preload = preloadOsDesktopChunks(status.recoveryScope);
      if (preload) {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          setUnlocked(true);
          setAuthBlocked(false);
          setCheckingAuth(false);
        };
        const timer = window.setTimeout(finish, 600);
        void preload.finally(() => {
          window.clearTimeout(timer);
          finish();
        });
        return;
      }
      setUnlocked(true);
      setAuthBlocked(false);
    }
    setCheckingAuth(false);
  }, []);

  useEffect(() => {
    const onAuthRequired = (event: Event) => {
      setAuthBlocked(true);
      setAuthMessage((event as CustomEvent<{ reason?: string }>).detail?.reason === 'passkey-revoked'
        ? 'Passkey removed. This sign-in session has ended. Sign in with your access key or another passkey.'
        : 'Session expired or the server restarted. Unlock again; your current view is preserved underneath.');
    };
    window.addEventListener('agentopsdeck:auth-required', onAuthRequired);
    return () => window.removeEventListener('agentopsdeck:auth-required', onAuthRequired);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const register = async () => {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => undefined);
      if (!registration) return;
      await registration.update().catch(() => undefined);
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      registration.active?.postMessage({ type: 'CLEAR_CACHES' });
    };
    if (document.readyState === 'complete') {
      void register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  if (checkingAuth && !unlocked) return <Suspense fallback={typeof document !== 'undefined' && document.documentElement.dataset.osDesktopImmersive === 'true' ? <OsPowerBootFallback progress="18%" stage="01" subtitleKey="Checking AgentOpsDeck auth…" /> : null}><StartupAuth onChecked={authChecked} /></Suspense>;

  if (!unlocked) {
    return <UnlockScreen message={authMessage} onUnlocked={() => window.location.reload()} />;
  }
  // Keep phones and touch/mobile webviews on the mobile list → chat detail flow.
  // Width alone is unreliable: some phone browsers / embedded containers report desktop-ish CSS width.
  const workspace = remoteMode ? <Suspense fallback={<p role="status">{tr('Loading…')}</p>}><WorkspaceRemote key={recoveryScope()} /></Suspense> : isMobileLikeDevice(width, standalone) ? <MobileApp /> : <DesktopWorkspace viewportWidth={width} />;
  return <>
    {remoteMode ? workspace : <WorkspacePreferencesProvider key={recoveryScope()} paused={authBlocked}><GlobalNotebookProvider paused={authBlocked}><SharedSessionBoundary paused={authBlocked}><InstantToolbarTooltips /><SessionCompletionPreviews paused={authBlocked} />{workspace}</SharedSessionBoundary></GlobalNotebookProvider></WorkspacePreferencesProvider>}
    {authBlocked ? <UnlockScreen message={authMessage} onUnlocked={() => window.location.reload()} /> : null}
  </>;
}



type RootHost = HTMLElement & { __agentopsdeckRoot?: Root };
const rootHost = document.getElementById('root') as RootHost | null;
if (!rootHost) throw new Error('Missing #root container');
const root = rootHost.__agentopsdeckRoot ?? createRoot(rootHost);
rootHost.__agentopsdeckRoot = root;
root.render(<RenderRecoveryBoundary><FontPreferencesProvider><App /></FontPreferencesProvider></RenderRecoveryBoundary>);
