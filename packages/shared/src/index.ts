export * from './agent-interaction.js';
export type { AntigravityQuotaWindow, AntigravityUsage } from './antigravity-usage.js';
export * from './shared-message-input.js';
export { readCodexGoal, type CodexGoal } from './codex-goal.js';
export { goalActions, readGoalControl, readGoalControlSnapshot, type GoalAction, type GoalControl, type GoalControlSnapshot } from './codex-goal-control.js';
export * from './native-token-usage.js';
export * from './native-token-export.js';
export * from './native-token-snapshot.js';
export * from './workspace-drawing.js';
export * from './workspace-remote.js';
export { readSessionSettingsResult, type SessionSettingsResult } from './session-settings.js';
export { BOARD_MAX_TASKS, BOARD_MAX_CHARS, BOARD_MAX_BODY_BYTES, BOARD_STATUSES, BOARD_PRIORITIES, copyBoardTask, validBoardDueDate, validBoardId, validBoardUuid, validBoardContent, validBoardWrite, summarizeBoard, type BoardSummary, type BoardStatus, type BoardPriority, type BoardTask, type BoardContent, type BoardDocument, type BoardWrite } from './workspace-board.js';
export { AGENTOPSDECK_VERSION, AGENTOPSDECK_PRODUCT_NAME, CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, negotiateConnectorProtocol, acceptsConnectorProtocolHeader, type ProtocolRange } from './protocol.js';
export { AGENTOPSDECK_BUILD } from './build-info.generated.js';
export { WORKSPACE_SYNC_VERSION, WORKSPACE_SYNC_MAX_ITEMS, WORKSPACE_SYNC_MAX_FRAME_BYTES, parseWorkspaceSyncRequest, type WorkspaceSyncItem, type WorkspaceSyncFrame } from './workspace-sync.js';
export { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta, HISTORY_DELTA_HEADER, type HistoryTransportPage, type SessionHistoryStatus } from './history-transport.js';
export { HISTORY_ASYNC_HEADER, HISTORY_PENDING_CODE, historyPendingBody, isHistoryPending } from './history-pending.js';

export type GatewayHealth = {
  ok: boolean;
  enabled?: boolean;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  version?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  updatedAt: number;
  error?: string;
  degraded?: boolean;
  note?: string;
  gatewayWs?: { configured: boolean; connected?: boolean; url?: string | undefined };
  adminRpc?: { configured: boolean; url?: string | undefined };
  details?: Record<string, unknown>;
};

export type SessionStatus = 'idle' | 'running' | 'failed' | 'waiting' | 'pending_subagent' | 'unknown';
export type SessionRunState = 'idle' | 'running' | 'failed' | 'waiting' | 'unknown';
export type SessionChildState = 'idle' | 'pending' | 'unknown';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | (string & {});

/** Execution truth, independent of transcript delivery and transport health. */
export type AgentRuntime = {
  turnId?: string;
  operation?: 'message' | 'compact';
  stopRequested?: boolean;
  phase: 'starting' | 'running' | 'waiting' | 'finalizing' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  /** Native thread availability, not the outcome or identity of this turn. */
  threadActivity?: 'idle' | 'running' | 'waiting' | 'unknown';
  connection: 'connected' | 'disconnected';
  sync: 'current' | 'syncing' | 'error';
  /** Native-history admission is independent of transcript transport and of
   * this command's immutable turnId/outcome. Optional for older connectors. */
  executionProtection?: { state: 'verified' | 'blocked'; nativeTurnId: string; reason: string };
  lastEventAt: number;
  reason?: string;
};

export type SessionStructuredStatus = {
  /** Parent session execution state. Child/subagent activity must not overwrite this. */
  runState: SessionRunState;
  /** Child/subagent work associated with this session. */
  childState: SessionChildState;
  pendingSubagentCount: number;
  hasActiveRun: boolean;
  /** Deprecated flat compatibility projection for older clients. */
  displayStatus: SessionStatus;
};

/** Installation/runtime identity; connection aliases and URLs are not identity. */
export const AGENT_RUNTIME_IDS = ['openclaw', 'codex', 'hermes', 'claude-code', 'ghcp', 'antigravity'] as const;
export type AgentRuntimeId = typeof AGENT_RUNTIME_IDS[number];
export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return typeof value === 'string' && (AGENT_RUNTIME_IDS as readonly string[]).includes(value);
}
export function sessionRuntimeId(key: string): AgentRuntimeId {
  const separator = key.indexOf(':');
  const prefix = separator < 0 ? '' : key.slice(0, separator);
  return isAgentRuntimeId(prefix) ? prefix : 'openclaw';
}
/** Identity support does not enable a runtime or expand delegated permissions.
 * Check both fields: an OpenClaw label must not disguise an owner-only key. */
export function isOwnerOnlyRuntimeResource(resource: { runtime?: unknown; sessionKey?: unknown }): boolean {
  const ownerOnly = (id: unknown) => id === 'hermes' || id === 'claude-code' || id === 'ghcp' || id === 'antigravity';
  return ownerOnly(resource.runtime)
    || typeof resource.sessionKey === 'string' && ownerOnly(sessionRuntimeId(resource.sessionKey));
}
export type SessionRef = {
  nodeId: string;
  runtimeId: AgentRuntimeId;
  nativeSessionKey: string;
};

export { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES, LONG_MESSAGE_PREVIEW_CHARS, LEGACY_MAX_MESSAGE_CHARS, resolveMessageLimits, type MessageLimits } from './message-limits.js';

export type SessionSummary = {
  /** Last native goal observation. null proves absence; omitted is unknown.
   * Not a dispatch capability or a session/billing token total. */
  codexGoal?: import('./codex-goal.js').CodexGoal | null;
  sessionRef?: SessionRef | undefined;
  runtime?: AgentRuntime;
  controlCapabilities?: { compact: boolean; attachments?: boolean };
  sessionKey: string;
  agentId?: string;
  title: string;
  recent?: string;
  status: SessionStatus;
  source?: string;
  lastActiveAt?: number;
  hasActiveRun?: boolean;
  runStartedAt?: number;
  runCompletedAt?: number;
  pendingSubagentCount?: number;
  structuredStatus?: SessionStructuredStatus;
  messageCount?: number;
  estimatedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  /** Current native context sample, distinct from lifetime totalTokens. null = invalidated by compaction. */
  contextUsedTokens?: number | null;
  /** Native sample semantics; last-request input is not current/lifetime usage. */
  contextSampleBasis?: 'native-context' | 'last-request-input' | 'post-compaction';
  /** Latest root-agent native usage; not cumulative session/billing totals. */
  nativeUsage?: { scope: 'last-turn' | 'last-call'; inputTokens: number; outputTokens: number;
    cacheReadTokens?: number; cacheWriteTokens?: number };
  compactionCount?: number;
  rolloutBytes?: number;
  lastTurnCompactions?: number;
  maxTurnCompactions?: number;
  totalTokensFresh?: boolean;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: ThinkingLevel;
  hidden?: boolean;
  archived?: boolean;
  pinned?: boolean;
};

export type SessionsState = {
  /** Connector projection watermark, distinct from the Hub delivery cursor. */
  sourceCursor?: string | undefined;
  groups: Array<{
    agentId: string;
    sessions: SessionSummary[];
  }>;
  updatedAt: number;
  revision?: string;
  hiddenCount?: number;
  archivedCount?: number;
  pinnedCount?: number;
};

/** Last known execution projection at sourceCursor, NOT a runtime health probe.
 * No personal labels, preferences, agent catalog or message text are included.
 * Browser transport/synchronization state must remain separate from these facts.
 */
export type SessionExecutionSnapshot = {
  sessionKey: string;
  sessionRef?: SessionRef;
  status: SessionStatus;
  runtime?: Omit<AgentRuntime, 'reason'>;
  structuredStatus?: SessionStructuredStatus;
  hasActiveRun?: boolean;
  runStartedAt?: number;
  runCompletedAt?: number;
  sourceCursor?: string;
};

export const NODE_ACTIONS = ['sessions:read', 'sessions:create', 'sessions:share', 'sessions:configure', 'messages:read', 'messages:send', 'messages:mirror',
  'events:read', 'media:read', 'agents:read', 'queue:manage', 'runs:interrupt', 'runs:compact', 'node:manage'] as const;
export type NodeAction = typeof NODE_ACTIONS[number];
export type NodeResource = { runtime?: AgentRuntimeId; agentId?: string; sessionKey?: string };
export type NodeGrantPolicy = NodeResource & { actions: NodeAction[] };
/** Last-known resource discovery, not execution state or a read authorization. */
export type SessionDirectoryQuery = { runtime?: AgentRuntimeId; sessionKey?: string; after?: string; limit?: number };
export type SessionDirectoryPage = {
  sessions: Array<{ sessionKey: string; runtime: AgentRuntimeId }>;
  nextCursor: string | null;
  sourceCursor: string;
};
export type SharedSessionDirectoryPage = Omit<SessionDirectoryPage, 'sessions'> & {
  sessions: Array<SessionDirectoryPage['sessions'][number] & { sessionId: string | null }>;
};
/** UI hints from current Hub policy, not a reusable proof or runtime readiness. */
export type SharedSessionAccessHints = { messagesSend: boolean; messagesMirror?: boolean; eventsRead: boolean; sessionsShare?: boolean };
export type SharedGrantSummary = {
  id: string; ownerUserId: string; connectionId: string; version: number; nodeVersion: number;
  policy: NodeGrantPolicy;
  availability: 'available' | 'reauthorization_required' | 'disabled' | 'unverified';
  // A navigation hint, never a read proof or a claim that the Agent is online.
  // Null keeps broad/agent/non-readable grants visible without catalog fan-out.
  sessionId: string | null;
};
export type SharedGrantPage = { grants: SharedGrantSummary[]; nextCursor: string | null };

export { parseSourceReference, sourceReferences } from './source-reference.js';
export type { SourceReference, SourcePreview } from './source-reference.js';
export { normalizeSourceFiles } from './source-files.js';
export type { SourceFileChange } from './source-files.js';

export type ChatMessageMedia = {
  type: 'image' | 'file';
  url: string;
  name: string;
  mimeType?: string;
  size?: number;
  sourceReference?: import('./source-reference.js').SourceReference;
};

export type ChatMessage = {
  /** Native Codex child observations, bounded independently from tool text previews. */
  codexSubagent?: import('./codex-subagent.js').CodexSubagentObservation;
  sessionRef?: SessionRef | undefined;
  turnId?: string;
  /** Native subagent scope. Absence is the root conversation; child output
   * must not be treated as a root final answer or root tool completion. */
  parentToolUseId?: string;
  contentTruncated?: boolean;
  phase?: 'commentary' | 'final_answer';
  id: string;
  sessionKey: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  text: string;
  toolPreview?: string;
  toolDetailAvailable?: boolean;
  toolLineCount?: number;
  toolCallId?: string;
  toolName?: string;
  toolPhase?: 'call' | 'result' | 'history';
  /** Bounded completed native file operations; absence means unknown, not no edits. */
  sourceFiles?: import('./source-files.js').SourceFileChange[];
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  media?: ChatMessageMedia[];
  status?: 'sending' | 'sent' | 'failed' | 'queued' | 'outcome_unknown';
  // Version captured with the projected queued text, never enriched at read time.
  queueVersion?: string | undefined;
  // Admission/preparation is not necessarily waiting behind another turn.
  queueDisposition?: 'waiting' | 'preparing' | undefined;
  /** Browser-only lightweight queue observation; absence is NOT execution proof. */
  queueObservation?: 'dispatching' | 'absent' | 'unknown' | 'blocked' | undefined;
  /** Local ACK ownership only; never infer ownership from visible history. */
  localAdmission?: boolean;
  createdAt: number;
  updatedAt?: number;
  failureReason?: string;
};

export type ActivityEntry = {
  id: string;
  status: 'running' | 'done' | 'error';
  toolName: string;
  summary?: string;
  outputPreview?: string;
  outputTruncated?: boolean;
  runId: string;
  toolCallId: string;
  sessionKey?: string;
  hiddenArgumentCount: number;
  updatedAt: number;
  durationMs: number;
};


export type DeckEventType =
  | 'stream.reset'
  | 'stream.status'
  | 'session.updated'
  | 'interaction.updated'
  | 'session.stale_active_run_reconciled'
  | 'message.created'
  | 'message.updated'
  | 'run.updated'
  | 'run.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'queued_message.created'
  | 'queued_message.sent'
  | 'queued_message.failed'
  | 'gateway.status_changed'
  | 'channel.status_changed'
  | 'cron.failure';

export type DeckEvent<TPayload = unknown> = {
  id: string;
  type: DeckEventType;
  ts: number;
  sessionKey?: string;
  agentId?: string;
  payload: TPayload;
};

export type SendDeliveryMode = 'web-only' | 'mirror';

export type QueuedMessagePage = {
  items: Array<{ id: string; state: 'queued' | 'dispatching' | 'outcome_unknown' | 'blocked'; createdAt: number; version: string }>;
  nextCursor: string | null;
};

// Actor-only metadata. Null means no unique persisted original command mapping;
// it is not permission to guess a runtime ID or dispatch another command.
export type QueuedCommandPage = {
  items: Array<Omit<QueuedMessagePage['items'][number], 'id'> & { commandKey: string | null }>;
  nextCursor: string | null;
};

export type SharedQueuedCommandPage = {
  availability: 'available' | 'unavailable';
  items: Array<QueuedCommandPage['items'][number] & { commandState: CommandReceipt['state'] | null }>;
  nextCursor: string | null;
};

// Absence is only a queue observation, never proof of execution completion.
export type CommandQueueObservation =
  | { presence: 'present'; state: QueuedMessagePage['items'][number]['state']; createdAt: number; version?: string }
  | { presence: 'absent' }
  | { presence: 'unknown' };

export type SendMessageUpload = {
  type: 'image' | 'file';
  name: string;
  mimeType?: string;
  size?: number;
  dataUrl: string;
};

export type SendMessageRequest = {
  /** Required for Codex /stop; never infer its target at dispatch time. */
  expectedRunId?: string;
  message: string;
  idempotencyKey?: string;
  deliveryMode?: SendDeliveryMode;
  media?: SendMessageUpload[];
};

export type CommandReceipt = {
  id: string;
  key: string;
  state: 'accepted' | 'rejected' | 'outcome_unknown';
  createdAt: number;
  updatedAt: number;
  /** Separately audited start permission; never evidence of the original write outcome. */
  settingsStartReleased?: true;
  result?: { status: number; body: Record<string, unknown> };
};

export type SendMessageResponse = {
  /** Immutable observation committed atomically with this admission, not live execution state. */
  admission?: { createdAt: number; queueVersion: string; disposition: 'waiting' | 'preparing' };
  runId?: string;
  status: 'started' | 'in_flight' | 'ok' | 'queued' | 'stopped' | 'interrupt_requested' | 'outcome_unknown';
  idempotencyKey?: string;
  command?: CommandReceipt;
  deliveryMode?: SendDeliveryMode;
  deliver?: boolean;
  media?: ChatMessageMedia[];
  explicitRoute?: {
    originatingChannel: string;
    originatingTo: string;
    originatingAccountId: string;
    outboundTarget: string;
  };
};

export type CompactSessionResponse = SendMessageResponse & {
  message?: string;
  estimatedSkipReason?: string;
};

export type CreateSessionRequest = {
  label?: string;
  model?: string;
};

export type CreateSessionResponse = {
  key: string;
};

export type AgentSummary = {
  id: string;
  label?: string;
  status?: string;
  /** Admission readiness, not session activity or provider authentication. */
  readiness?: AgentReadiness;
};

export type AgentReadiness = 'disabled' | 'starting' | 'ready' | 'maintenance' | 'failed' | 'closed';

export type FileBrowserScope =
  | { type: 'gateway'; rootLabel: string }
  | { type: 'agent'; agentId: string; rootLabel: string };

export type FileBrowserRoot = {
  type: 'gateway' | 'agent';
  agentId?: string;
  label: string;
  path: string;
  readOnly?: boolean;
};

export type FileBrowserEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  modifiedAt: number;
  mimeType?: string;
  protected?: boolean;
  reason?: 'hidden_sensitive' | 'openclaw_config_read_only';
  canPreview: boolean;
  canDownload: boolean;
  canRename: boolean;
  canDelete: boolean;
  canUpload: boolean;
};

export type FileBrowserListResponse = {
  scope: FileBrowserScope;
  root: string;
  path: string;
  entries: FileBrowserEntry[];
  hiddenCount: number;
  updatedAt: number;
};

export type FileBrowserPreviewResponse = {
  /** Exact UTF-8 byte revision; absent means editing is unavailable. */
  revision?: string;
  canEdit?: boolean;
  scope: FileBrowserScope;
  path: string;
  name: string;
  size: number;
  mimeType?: string;
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'too_large';
  text?: string;
  dataUrl?: string;
  downloadUrl?: string;
  capped?: boolean;
  maxPreviewBytes?: number;
};

export type MediaLibraryRoot = {
  id: string;
  label: string;
};

export type MediaLibraryEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'video';
  size?: number;
  modifiedAt: number;
  mimeType?: string;
  playable?: boolean;
  playbackUrl?: string;
};

export type MediaLibraryListResponse = {
  enabled: boolean;
  roots: MediaLibraryRoot[];
  root?: string;
  path: string;
  entries: MediaLibraryEntry[];
  truncated?: boolean;
  updatedAt: number;
};

export * from "./model-set.js";
export * from './command-key.js';
export type { WorkspaceGroup, WorkspaceSessionStyle, WorkspacePreferences } from './workspace-preferences.js';
export { validSessionTags } from './workspace-preferences.js';
export { NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS, NOTEBOOK_BODY_MAX_BYTES, DEFAULT_HUB_NOTEBOOK_LAYOUT, validHubNotebookLayout, type HubNotebookLayout, type SessionNotebookDocument } from './session-notebook.js';
export type { ConnectorLifecycleOperation, ConnectorLifecycleJob, ConnectorLifecycleStatus, ConnectorLifecycleReceipt } from './connector-lifecycle.js';
export * from './session-file-index.js';
export * from './session-skills.js';
export * from './workspace-native-drawio.js';
export * from './connector-websites.js';
export * from './workspace-research.js';
export * from './workspace-card.js';
export * from './website-actions.js';
export * from './workspace-file-card.js';
export type { WeixinStatus } from './weixin.js';
export * from './system-metrics.js';
export * from './automation-policy.js';
export * from './automation-configuration.js';
export type { CodexSubagentObservation, CodexSubagentStep } from './codex-subagent.js';
