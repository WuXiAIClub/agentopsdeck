import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { nanoid } from 'nanoid';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { ChangeSignal } from '../utils/change-signal.js';
import { summarizeToolMessage } from '../messages/tool-summary.js';
import { indexHistoryPages } from '../messages/history-page.js';
import { mergeMessageIdentities } from '../messages/identity.js';
import { sessionExecutionSnapshot } from './session-execution.js';
import { changeSessionOverride, changeSessionPreference, saveSessionPreferences } from './session-preference-file.js';
import { validLocalPreferenceSnapshot, type AcceptedLocalPreference, type LocalPreferenceSnapshot } from '../auth/local-preference-domain.js';
import { projectSessionDirectory } from './session-directory.js';
import type { OpenClawExecutions } from '../openclaw/executions.js';
import { parseGatewayReply } from '../openclaw/gateway-reply.js';
import { gatewayEventRunState, gatewayRunId } from '../openclaw/gateway-observation.js';
import type { CodexExecutions } from '../codex/executions.js';
import { projectRuntime } from '../codex/run-state.js';
import type {
  ActivityEntry,
  ChatMessage,
  DeckEvent,
  DeckEventType,
  GatewayHealth,
  SessionSummary,
  SessionsState,
  SessionDirectoryQuery,
} from '@agentopsdeck/shared';

/** Memory observations only. Admission is synchronous; the sink retains and
 * settles physical writes itself. There is deliberately no synchronous cursor
 * or replay method: callers must use the owning journal's awaited read ports. */
export type DeckProjectionEvents = {
  readonly changes: ChangeSignal;
  append(events: readonly DeckEvent[]): void;
};

export type DeckStoreOptions = {
  // Only durable accepted deletion, never in-flight/outcome_unknown. Reuse the
  // owner's receipt fact; do not keep a second tombstone cache in the projection.
  sessionDeleted?: (sessionKey: string) => boolean;
  eventLog?: {
    changes?: ChangeSignal;
    append: (event: DeckEvent) => DeckEvent;
    appendBatch: (events: readonly DeckEvent[]) => unknown;
    recoverProjection?: () => boolean;
    latestEventId: () => string;
    hasEvent: (id: string) => boolean;
    getEventsSince: (id?: string) => DeckEvent[];
  };
  projectionEvents?: DeckProjectionEvents;
  sessionTitlesFile?: string;
  sessionThinkingOverridesFile?: string;
  hiddenSessionsFile?: string;
  archivedSessionsFile?: string;
  pinnedSessionsFile?: string;
  /** Sole external owner supplies initial facts and subsequent committed ACKs.
   * Cannot coexist with legacy synchronous preference file ownership. */
  committedPreferences?: LocalPreferenceSnapshot;
  maxResidentMessageBytes?: number;
  maxResidentMessageSessions?: number;
  minResidentIdleMs?: number;
  now?: () => number;
};

// Display observations only. Never use this source for authorization, queue
// admission or native-idle proof. The async consumer owns freshness/failure.
export type OpenClawExecutionProjection = Pick<OpenClawExecutions, 'get' | 'sessionPage'>;
export type CodexExecutionProjection = Pick<CodexExecutions, 'get' | 'sessionPage'>;

const ACTIVE_RUN_STICKY_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RESIDENT_MESSAGE_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_RESIDENT_MESSAGE_SESSIONS = 16;
const DEFAULT_MIN_RESIDENT_IDLE_MS = 15 * 60_000;

export class DeckStore {
  private readonly externalPreferenceOwner: boolean;
  private readonly maxResidentMessageBytes: number;
  private readonly maxResidentMessageSessions: number;
  private readonly minResidentIdleMs: number;
  private readonly nowMs: () => number;
  private openClawExecutions?: OpenClawExecutions;
  private openClawProjection?: OpenClawExecutionProjection;
  private codexExecutions?: CodexExecutions;
  private codexProjection?: CodexExecutionProjection;
  private codexExecutionUnavailable = false;
  private codexConnectionId?: () => string | undefined;
  private codexConnectionChangedAt = 0;
  private openClawExecutionUnavailable = false;
  private openClawConnectionId: (() => string | undefined) | undefined;
  private openClawConnectionChangedAt = 0;
  readonly changes: ChangeSignal;
  private events: DeckEvent[] = [];
  private sessions = new Map<string, SessionSummary>();
  private messages = new Map<string, ChatMessage[]>();
  private messageEvictionPolicies: Array<(sessionKey: string) => boolean> = [];
  private messageTouchedAt = new Map<string, number>();
  private approxMessageBytesBySession = new Map<string, number>();
  private totalApproxMessageBytes = 0;
  private evictedMessageMetrics = new Map<string, { messageCount: number; estimatedTokens: number; latestMessageAt?: number }>();
  private evictedTranscriptCount = 0;
  private historyPages = new WeakMap<ChatMessage[], ReturnType<typeof indexHistoryPages>>();
  private mergedHistoryPages = new WeakMap<ChatMessage[], ReturnType<typeof indexHistoryPages>>();
  private messageIndexes = new WeakMap<ChatMessage[], Map<string, number>>();
  private messageListVersions = new Map<string, number>();
  private listMetricsCache = new WeakMap<ChatMessage[], {
    messageCount: number;
    estimatedTokens: number;
    latestMessageAt?: number;
    terminal?: { at: number; status: SessionSummary['status'] };
    hasUnpinnedLocalState: boolean;
  }>();
  private activities = new Map<string, ActivityEntry[]>();
  private sessionTitleOverrides = new Map<string, string>();
  private sessionThinkingOverrides = new Map<string, SessionSummary['thinkingLevel']>();
  private hiddenSessions = new Set<string>();
  private archivedSessions = new Set<string>();
  private pinnedSessions = new Set<string>();
  private localBusyUntil = new Map<string, number>();
  private runStartedAt = new Map<string, number>();
  private runCompletedAt = new Map<string, number>();
  private gateway: GatewayHealth = { ok: false, status: 'unknown', updatedAt: Date.now() };

  constructor(private readonly options: DeckStoreOptions = {}) {
    this.externalPreferenceOwner = options.committedPreferences !== undefined;
    this.maxResidentMessageBytes = options.maxResidentMessageBytes !== undefined
      ? Math.max(0, Math.floor(options.maxResidentMessageBytes))
      : DEFAULT_MAX_RESIDENT_MESSAGE_BYTES;
    this.maxResidentMessageSessions = options.maxResidentMessageSessions !== undefined
      ? Math.max(0, Math.floor(options.maxResidentMessageSessions))
      : DEFAULT_MAX_RESIDENT_MESSAGE_SESSIONS;
    this.minResidentIdleMs = options.minResidentIdleMs !== undefined
      ? Math.max(0, Math.floor(options.minResidentIdleMs))
      : DEFAULT_MIN_RESIDENT_IDLE_MS;
    this.nowMs = options.now ?? Date.now;
    if (options.eventLog && options.projectionEvents) throw new Error('Deck event owners cannot be mixed');
    if (options.committedPreferences !== undefined && (!validLocalPreferenceSnapshot(options.committedPreferences)
      || options.hiddenSessionsFile !== undefined || options.archivedSessionsFile !== undefined || options.pinnedSessionsFile !== undefined)) {
      throw new Error('Deck preference owners cannot be mixed');
    }
    this.changes = options.projectionEvents?.changes ?? options.eventLog?.changes ?? new ChangeSignal();
    this.loadSessionTitleOverrides();
    this.loadSessionThinkingOverrides();
    if (options.committedPreferences !== undefined) {
      this.hiddenSessions = new Set(options.committedPreferences.hidden);
      this.archivedSessions = new Set(options.committedPreferences.archived);
      this.pinnedSessions = new Set(options.committedPreferences.pinned);
    } else {
      this.loadHiddenSessions(); this.loadArchivedSessions(); this.loadPinnedSessions();
    }
  }

  bindOpenClawExecutions(executions: OpenClawExecutions, connectionId?: () => string | undefined) {
    if (this.openClawProjection) throw new Error('OpenClaw execution projection already bound');
    if (this.openClawExecutions && this.openClawExecutions !== executions) throw new Error('OpenClaw execution owner already bound');
    this.openClawExecutions = executions;
    if (connectionId) this.openClawConnectionId = connectionId;
  }

  bindOpenClawExecutionProjection(projection: OpenClawExecutionProjection, connectionId: () => string | undefined) {
    if (this.openClawExecutions || this.openClawProjection) throw new Error('OpenClaw execution owner already bound');
    this.openClawProjection = projection;
    this.openClawConnectionId = connectionId;
  }

  bindCodexExecutions(executions: CodexExecutions, connectionId: () => string | undefined) {
    if (this.codexProjection) throw new Error('Codex execution projection already bound');
    if (this.codexExecutions && this.codexExecutions !== executions) throw new Error('Codex execution owner already bound');
    this.codexExecutions = executions; this.codexConnectionId = connectionId;
  }

  bindMessageEvictionPolicy(canEvict: (sessionKey: string) => boolean) {
    this.messageEvictionPolicies.push(canEvict);
  }

  hasMessages(sessionKey: string): boolean {
    return !this.options.sessionDeleted?.(sessionKey) && this.messages.has(sessionKey);
  }

  memoryStats() {
    let residentMessages = 0;
    for (const list of this.messages.values()) residentMessages += list.length;
    return {
      sessions: this.sessions.size,
      residentMessageSessions: this.messages.size,
      residentMessages,
      approxMessageBytes: this.totalApproxMessageBytes,
      evictedMessageSessions: this.evictedMessageMetrics.size,
      evictedTranscriptsTotal: this.evictedTranscriptCount,
      activitySessions: this.activities.size,
      retainedEvents: this.events.length,
    };
  }

  bindCodexExecutionProjection(projection: CodexExecutionProjection, connectionId: () => string | undefined) {
    if (this.codexExecutions || this.codexProjection) throw new Error('Codex execution owner already bound');
    this.codexProjection = projection;
    this.codexConnectionId = connectionId;
  }

  private withCodexExecution(session: SessionSummary): SessionSummary {
    if (this.codexExecutionUnavailable) throw new Error('Codex execution facts unavailable');
    const fact = (this.codexProjection ?? this.codexExecutions)?.get(session.sessionKey);
    if (!fact) return session;
    const connectionId = this.codexConnectionId?.();
    const terminal = ['completed', 'failed', 'interrupted'].includes(fact.phase);
    const phase = !terminal && connectionId !== fact.connectionId ? 'unknown' : fact.phase;
    const { runCompletedAt: _completed, ...base } = session;
    return projectRuntime({ ...base, runStartedAt: fact.startedAt,
      ...(fact.completedAt === undefined ? {} : { runCompletedAt: fact.completedAt }) }, {
      ...(fact.runId ? { turnId: fact.runId } : {}), phase,
      operation: 'message',
      ...(fact.nativeHistory ? { executionProtection: {
        state: fact.nativeHistory.connectionId === connectionId ? fact.nativeHistory.state : 'blocked' as const,
        nativeTurnId: fact.nativeHistory.turnId,
        reason: fact.nativeHistory.connectionId === connectionId ? fact.nativeHistory.reason : 'restarted',
      } } : {}),
      ...(session.runtime?.threadActivity ? { threadActivity: session.runtime.threadActivity } : {}),
      connection: connectionId ? 'connected' : 'disconnected', sync: fact.sync, lastEventAt: Math.max(fact.updatedAt, this.codexConnectionChangedAt,
        session.runtime?.threadActivity ? session.runtime.lastEventAt : 0),
      ...(!terminal && connectionId !== fact.connectionId ? { reason: connectionId ? 'connection_replaced' : 'connection_lost' }
        : fact.reason ? { reason: fact.reason }
          : session.runtime && session.runtime.turnId === fact.runId && session.runtime.reason
            && ((phase === 'running' && session.runtime.phase === 'running' && session.runtime.connection === 'connected')
              || (terminal && fact.sync === 'error' && session.runtime.sync === 'error' && session.runtime.phase === phase))
            ? { reason: session.runtime.reason } : {}),
    });
  }

  invalidateCodexExecutionFacts() {
    this.codexExecutionUnavailable = true;
    this.changes.notify();
  }

  projectCodexConnection() {
    const source = this.codexProjection ?? this.codexExecutions;
    if (!source) return;
    this.codexConnectionChangedAt = Date.now();
    let after = '';
    for (;;) {
      const page = source.sessionPage(after, 64);
      if (!page.length) break;
      for (const key of page) this.projectExecution(key);
      after = page.at(-1)!;
    }
  }

  projectOpenClawConnection() {
    const source = this.openClawProjection ?? this.openClawExecutions;
    if (!source || !this.openClawConnectionId) return;
    this.openClawConnectionChangedAt = Date.now();
    // Only managed facts, in bounded primary-key pages; do not enumerate all
    // native sessions or load transcripts on a connection transition.
    let after = '';
    for (;;) {
      const page = source.sessionPage(after, 64);
      if (!page.length) break;
      for (const key of page) this.projectOpenClawExecution(key);
      after = page.at(-1)!;
    }
  }

  invalidateOpenClawExecutionFacts() {
    this.openClawExecutionUnavailable = true;
    this.changes.notify();
  }

  projectOpenClawExecution(sessionKey: string) {
    return this.projectExecution(sessionKey);
  }

  projectCodexExecution(sessionKey: string) {
    return this.projectExecution(sessionKey);
  }

  private projectExecution(sessionKey: string) {
    if (this.options.sessionDeleted?.(sessionKey)) return false;
    const current = this.sessions.get(sessionKey);
    if (!current) return false;
    const next = this.withExecution(current);
    this.localBusyUntil.delete(sessionKey);
    if (sameSessionSummary(current, next)) return false;
    this.sessions.set(sessionKey, next);
    const completed = (next.status === 'idle' || next.status === 'failed') && current.status !== 'idle' && current.status !== 'failed';
    this.append(completed ? 'run.completed' : 'run.updated', next, sessionContext(next));
    return completed;
  }

  private withExecution(session: SessionSummary): SessionSummary {
    if (session.sessionKey.startsWith('hermes:') || isSdkSessionKey(session.sessionKey)) return session;
    if (session.source === 'codex' || session.agentId === 'codex') return this.withCodexExecution(session);
    if (this.openClawExecutionUnavailable) throw new Error('OpenClaw execution facts unavailable');
    const fact = (this.openClawProjection ?? this.openClawExecutions)?.get(session.sessionKey);
    if (!fact) return session;
    const { runCompletedAt: _completed, runtime: _runtime, ...base } = session;
    const connectionId = this.openClawConnectionId?.();
    const tracksConnection = fact.origin === 'gateway' && !!this.openClawConnectionId;
    const terminal = fact.phase === 'completed' || fact.phase === 'failed';
    const unconfirmed = tracksConnection && !terminal && (!connectionId
      || (!!fact.gatewayConnectionId && fact.gatewayConnectionId !== connectionId));
    const phase = unconfirmed ? 'unknown' : fact.phase;
    const runState = phase === 'starting' ? 'running' : phase === 'completed' ? 'idle' : phase;
    return syncSessionStatus({ ...base, runStartedAt: fact.startedAt,
      ...(tracksConnection ? { runtime: {
        turnId: fact.commandId, operation: 'message' as const, phase, connection: connectionId ? 'connected' as const : 'disconnected' as const,
        sync: fact.historySync?.state === 'pending' ? 'syncing' as const : fact.historySync?.state === 'error' ? 'error' as const : 'current' as const,
        lastEventAt: Math.max(fact.updatedAt, this.openClawConnectionChangedAt),
        ...(unconfirmed ? { reason: connectionId ? 'connection_replaced' : 'connection_lost' } : fact.reason ? { reason: fact.reason } : {}),
      } } : {}),
      ...(fact.completedAt === undefined ? {} : { runCompletedAt: fact.completedAt }) }, { runState });
  }

  append<T>(type: DeckEventType, payload: T, context: { sessionKey?: string; agentId?: string } = {}) {
    const event = projectionEvent(type, payload, context);
    let stored = event;
    if (this.options.projectionEvents) this.options.projectionEvents.append([event]);
    else if (this.options.eventLog) stored = this.options.eventLog.append(event) as DeckEvent<T>;
    else {
      this.events.push(event);
      if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    }
    // A failed production journal wakes readers to an unavailable cursor, not
    // a healthy snapshot. It never throws into already-executing runtime work.
    this.changes.notify();
    return stored;
  }

  private appendBatch(events: DeckEvent[]) {
    if (!events.length) return;
    if (this.options.projectionEvents) this.options.projectionEvents.append(events);
    else if (this.options.eventLog) this.options.eventLog.appendBatch(events);
    else {
      // Copy only the bounded tail; batch payloads are references to the newly
      // installed projection, never another serialized transcript cache.
      this.events = this.events.concat(events.slice(-500)).slice(-500);
    }
    this.changes.notify();
  }

  replaceSessions(rows: unknown[]) {
    const previous = this.sessions;
    const next = new Map<string, SessionSummary>();
    const events: DeckEvent[] = [];
    const pendingSubagents = countPendingSubagentsByParent(rows);
    for (const row of rows) {
      // SDK identities belong exclusively to their Connector journal, never
      // to OpenClaw discovery (even if a gateway reports a matching key).
      if (isSdkSessionKey(sessionKeyOf(row))) continue;
      if (this.options.sessionDeleted?.(sessionKeyOf(row))) continue;
      const item = this.withExecution(this.withLocalSessionOverrides(this.mapGatewaySession(row, pendingSubagents.get(sessionKeyOf(row)) ?? 0, previous.get(sessionKeyOf(row)))));
      if (!isPreviewVisibleAgent(item.agentId)) continue;
      if (!isUserFacingSession(item)) continue;
      next.set(item.sessionKey, item);
      if (!sameSessionSummary(previous.get(item.sessionKey), item)) {
        events.push(projectionEvent('session.updated', item, sessionContext(item)));
      }
    }
    for (const [sessionKey, item] of previous) {
      if (next.has(sessionKey)) continue;
      if (this.options.sessionDeleted?.(sessionKey)) {
        events.push(projectionEvent('session.updated', { sessionKey, status: 'deleted' }, sessionContext(item)));
        continue;
      }
      if (isSyntheticWebSession(item) || item.source === 'codex' || item.source === 'hermes' || isSdkSessionKey(sessionKey) || (this.openClawProjection ?? this.openClawExecutions)?.get(sessionKey)) {
        next.set(sessionKey, item);
        continue;
      }
      events.push(projectionEvent('session.updated', { ...item, status: 'unknown' }, sessionContext(item)));
    }
    this.sessions = next;
    this.appendBatch(events);
  }

  upsertSession(session: SessionSummary) {
    if (this.options.sessionDeleted?.(session.sessionKey)) return;
    if (!isUserFacingSession(session)) return;
    const next = this.withExecution(this.withLocalSessionOverrides(session));
    // Native catalog reads can run inside an authoritative snapshot refresh.
    // Publishing the same observation would advance its durable event head on
    // every read, so the bounded consistency check could never converge. Keep
    // the complete summary comparison: real metadata/runtime changes still
    // need a journal event even when the visible title/status is unchanged.
    if (isDeepStrictEqual(this.sessions.get(next.sessionKey), next)) return;
    this.sessions.set(next.sessionKey, next);
    this.append('session.updated', next, sessionContext(next));
  }

  renameSession(sessionKey: string, title: string, acknowledged?: (session: SessionSummary) => void) {
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    const current = this.sessions.get(sessionKey);
    if (!current) return undefined;
    const trimmed = this.persistSessionTitleOverride(sessionKey, title);
    const next = { ...current, title: trimmed };
    acknowledged?.(next);
    this.sessions.set(sessionKey, next);
    this.append('session.updated', next, sessionContext(next));
    return this.withMessageMetrics(next);
  }

  private sessionTitleEffect(sessionKey: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('session title is required');
    if (trimmed.length > 120) throw new Error('session title is too long');
    const overrides = this.options.sessionDeleted?.(sessionKey) ? this.sessionTitleOverrides
      : changeSessionOverride(this.sessionTitleOverrides, this.options.sessionTitlesFile, sessionKey, trimmed);
    return { trimmed, overrides };
  }

  persistSessionTitleOverride(sessionKey: string, title: string) {
    const { trimmed, overrides } = this.sessionTitleEffect(sessionKey, title);
    this.sessionTitleOverrides = overrides;
    return trimmed;
  }

  /** Persist the original file, await worker ACK, then publish only this field.
   * A native notification during ACK must not be overwritten by an old view. */
  async renameSessionOwned(sessionKey: string, title: string, acknowledge: (session: SessionSummary) => Promise<void>) {
    const current = this.sessions.get(sessionKey);
    if (!current || this.options.sessionDeleted?.(sessionKey)) throw new Error('session not found');
    // File durability is not permission to publish its value through getSession.
    // Keep the original visible override until ACK persistence and publication
    // authority both succeed; never roll back a possibly committed file.
    const { trimmed } = this.sessionTitleEffect(sessionKey, title);
    await acknowledge({ ...current, title: trimmed });
    const latest = this.sessions.get(sessionKey);
    if (latest && !this.options.sessionDeleted?.(sessionKey)) {
      this.sessionTitleOverrides.set(sessionKey, trimmed);
      const next = { ...latest, title: trimmed };
      this.sessions.set(sessionKey, next);
      this.append('session.updated', next, sessionContext(next));
    }
  }

  /** File effect only, shared by synchronous and owned settings writers. */
  persistSessionThinkingEffect(sessionKey: string, thinkingLevel: SessionSummary['thinkingLevel'] | null | undefined) {
    const current = this.sessions.get(sessionKey);
    if (thinkingLevel === undefined) return current;
    this.sessionThinkingOverrides = changeSessionOverride(this.sessionThinkingOverrides, this.options.sessionThinkingOverridesFile, sessionKey, thinkingLevel);
    return current ? (thinkingLevel === null ? withoutThinkingLevel(current) : { ...current, thinkingLevel }) : undefined;
  }

  persistSessionThinkingOverride(sessionKey: string, thinkingLevel: SessionSummary['thinkingLevel'] | null | undefined,
    acknowledged?: (session: SessionSummary | undefined) => void) {
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    const current = this.sessions.get(sessionKey);
    if (thinkingLevel === undefined) {
      acknowledged?.(current);
      return current ? this.withMessageMetrics(current) : undefined;
    }
    const next = this.persistSessionThinkingEffect(sessionKey, thinkingLevel);
    // Persisted settings are authoritative even if a later view/event update
    // fails. Callers may durably ACK here before publishing the projection.
    acknowledged?.(next);
    if (next) {
      this.sessions.set(sessionKey, next);
      this.append('session.updated', next, sessionContext(next));
    }
    return next ? this.withMessageMetrics(next) : undefined;
  }

  addMessage(message: ChatMessage) {
    if (this.options.sessionDeleted?.(message.sessionKey)) return;
    const list = this.messages.get(message.sessionKey) ?? [];
    this.historyPages.delete(list);
    this.mergedHistoryPages.delete(list);
    this.listMetricsCache.delete(list);
    this.bumpMessageListVersion(message.sessionKey);
    const indexMap = this.getOrBuildMessageIndex(list);
    const existingIndex = indexMap.get(message.id) ?? -1;
    const previous = existingIndex >= 0 ? list[existingIndex] : undefined;
    let ordered = true;
    if (existingIndex >= 0) {
      ordered = (existingIndex === 0 || list[existingIndex - 1]!.createdAt <= message.createdAt)
        && (existingIndex === list.length - 1 || message.createdAt <= list[existingIndex + 1]!.createdAt);
      list[existingIndex] = message;
    } else {
      ordered = list.length === 0 || list[list.length - 1]!.createdAt <= message.createdAt;
      list.push(message);
      if (ordered) indexMap.set(message.id, list.length - 1);
    }
    if (!ordered) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      this.messageIndexes.delete(list);
    }
    const previousSessionBytes = this.approxMessageBytesBySession.get(message.sessionKey) ?? 0;
    const byteDelta = approxChatMessageBytes(message) - (previous ? approxChatMessageBytes(previous) : 0);
    const nextSessionBytes = Math.max(0, previousSessionBytes + byteDelta);
    this.messages.set(message.sessionKey, list);
    this.approxMessageBytesBySession.set(message.sessionKey, nextSessionBytes);
    this.totalApproxMessageBytes = Math.max(0, this.totalApproxMessageBytes - previousSessionBytes + nextSessionBytes);
    this.messageTouchedAt.set(message.sessionKey, this.nowMs());
    this.evictedMessageMetrics.delete(message.sessionKey);
    this.evictColdMessages(message.sessionKey);
    this.append(previous ? 'message.updated' : 'message.created', summarizeToolMessage(message), { sessionKey: message.sessionKey });
  }

  removeMessage(sessionKey: string, messageId: string) {
    if (this.options.sessionDeleted?.(sessionKey)) return false;
    const list = this.messages.get(sessionKey) ?? [];
    const next = list.filter((item) => item.id !== messageId);
    if (next.length === list.length) return false;
    this.setResidentMessages(sessionKey, next);
    this.append('message.updated', { id: messageId, sessionKey, deleted: true }, { sessionKey });
    return true;
  }

  replaceActivities(sessionKey: string, activities: ActivityEntry[]) {
    if (this.options.sessionDeleted?.(sessionKey)) return;
    if (activities.length === 0) return;
    const previous = this.activities.get(sessionKey) ?? [];
    const byId = new Map(previous.map((activity) => [activity.id, activity]));
    for (const activity of activities) byId.set(activity.id, { ...byId.get(activity.id), ...activity });
    const next = [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(-100);
    this.activities.set(sessionKey, next);
    this.appendBatch(activities.map(activity => projectionEvent(activity.status === 'running' ? 'tool.started' : activity.status === 'error' ? 'tool.failed' : 'tool.completed', activity, { sessionKey })));
  }

  replaceMessages(sessionKey: string, messages: ChatMessage[], options: { authoritative?: boolean } = {}) {
    const mismatched = messages.find((message) => message.sessionKey !== sessionKey);
    if (mismatched) throw new Error(`message ${mismatched.id} belongs to ${mismatched.sessionKey}, not ${sessionKey}`);
    if (this.options.sessionDeleted?.(sessionKey)) return;
    const previousList = this.messages.get(sessionKey) ?? [];
    const previous = new Map(previousList.map((message) => [message.id, message]));
    const deduped = new Map<string, ChatMessage>();
    const consumedMatches = new Set<string>();
    for (const message of messages) deduped.set(message.id, message);
    for (const message of previousList) {
      // SDK snapshots include the durable queue itself. Retaining a missing
      // pending row would resurrect a cancelled command on every refresh.
      if (options.authoritative && isSdkSessionKey(sessionKey)) continue;
      // Local reports and their queries are not native transcript entries.
      const localStatus = (message.role === 'assistant' && message.id.startsWith('local-status:'))
        || (message.role === 'user' && previous.get(`local-status:${message.id}`)?.role === 'assistant');
      if (options.authoritative && !localStatus && message.status !== 'queued' && message.status !== 'sending' && message.status !== 'outcome_unknown' && !(message.role === 'user' && message.status === 'failed')) continue;
      const shouldPreserveLocal = Boolean(message.status) || Boolean(message.media?.length);
      const mustKeepLocal = localStatus || message.status === 'queued' || message.status === 'sending' || message.status === 'failed' || message.status === 'outcome_unknown';
      const matchingMessageId = !mustKeepLocal && !deduped.has(message.id)
        ? findMatchingMessage(deduped, message, consumedMatches)
        : undefined;
      if (matchingMessageId) {
        consumedMatches.add(matchingMessageId);
        const matched = deduped.get(matchingMessageId);
        if (matched) deduped.set(matchingMessageId, mergeLocalEchoMedia(matched, message));
      }
      else if (shouldPreserveLocal && !deduped.has(message.id)) deduped.set(message.id, message);
      else if (!deduped.has(message.id)) deduped.set(message.id, message);
    }
    const pending = (message: ChatMessage) => isSdkSessionKey(sessionKey) && message.role === 'user'
      && (message.status === 'queued' || message.status === 'sending');
    const next = [...deduped.values()].sort((a, b) => Number(pending(a)) - Number(pending(b)) || a.createdAt - b.createdAt);
    const events: DeckEvent[] = [];
    if (previousList.some((message) => !deduped.has(message.id))) events.push(projectionEvent('stream.reset', { reason: 'messages_reconciled' }, { sessionKey }));

    // Only emit realtime events for actual message deltas. Emitting the latest N
    // rows after every history refresh creates a self-triggered SSE/refetch loop
    // while the user is reading a busy session.
    for (const message of next) {
      const prior = previous.get(message.id);
      if (!prior) events.push(projectionEvent('message.created', summarizeToolMessage(message), { sessionKey }));
      else if (!sameChatMessage(prior, message)) events.push(projectionEvent('message.updated', summarizeToolMessage(message), { sessionKey }));
    }
    this.setResidentMessages(sessionKey, next);
    this.appendBatch(events);
  }

  applySessionUsage(usages: Map<string, Partial<SessionSummary>>) {
    for (const [sessionKey, usage] of usages) {
      // This feed belongs to OpenClaw disk/Gateway discovery. SDK runtime
      // state and usage require their own native evidence, never this merge.
      if (isSdkSessionKey(sessionKey)) continue;
      if (this.options.sessionDeleted?.(sessionKey)) continue;
      const current = this.sessions.get(sessionKey);
      if (!current) continue;
      const localBusy = (this.localBusyUntil.get(sessionKey) ?? 0) > Date.now();
      if (!localBusy) this.localBusyUntil.delete(sessionKey);
      const merged = { ...current, ...usage };
      const next = this.withExecution(localBusy
        ? this.withRunTiming(syncSessionStatus({
          ...merged,
          lastActiveAt: Math.max(current.lastActiveAt ?? 0, usage.lastActiveAt ?? 0, Date.now()),
        }, { runState: 'running' }), current, usage)
        : syncSessionStatus(merged));
      this.sessions.set(sessionKey, next);
      if (!sameSessionSummary(current, next)) this.append('session.updated', next, sessionContext(next));
    }
  }

  ingestGatewayEvent(raw: any, gatewayConnectionId?: string) {
    // The new consumer must await the ORIGINAL worker transaction first.
    // Reject a forgotten await/legacy caller rather than losing a lifecycle
    // observation or silently creating a second synchronous writer.
    if (this.openClawProjection) throw new Error('OpenClaw event requires async observation');
    return this.applyGatewayEvent(raw, gatewayConnectionId, true);
  }

  presentCommittedGatewayEvent(raw: unknown, observed: boolean) {
    if (!this.openClawProjection) throw new Error('OpenClaw async projection not bound');
    return this.applyGatewayEvent(raw, undefined, false, observed);
  }

  private applyGatewayEvent(raw: any, gatewayConnectionId: string | undefined, persist: boolean, committedObservation = false) {
    const eventName = String(raw?.event ?? raw?.type ?? raw?.name ?? '').toLowerCase();
    const payload = raw?.payload ?? raw?.data ?? raw;
    const sessionKey = stringValue(payload?.sessionKey ?? payload?.session?.key ?? payload?.session?.sessionKey ?? raw?.sessionKey);
    if (sessionKey && isSdkSessionKey(sessionKey)) return false;
    const agentId = stringValue(payload?.agentId ?? payload?.agent?.id ?? raw?.agentId ?? (sessionKey ? inferAgentId(sessionKey) : undefined));

    const runStatus = gatewayEventRunState(eventName, payload);
    let settled = false;
    let managed;
    try { managed = sessionKey && (this.openClawProjection ?? this.openClawExecutions)?.get(sessionKey); }
    catch (error) { this.invalidateOpenClawExecutionFacts(); if (!persist) throw error; return false; }
    if (managed && sessionKey) {
      try {
        const chatState = (eventName === 'chat' || eventName.startsWith('chat.')) ? payload?.state : undefined;
        const reply = parseGatewayReply(raw);
        const phase = runStatus === 'idle' ? 'completed' : runStatus
          ?? (chatState === 'error' || chatState === 'aborted' ? 'failed' : reply ? 'completed' : undefined);
        const runId = gatewayRunId(payload);
        const observed = persist && phase && runId
          ? this.openClawExecutions!.observe(sessionKey, { runId, phase, gatewayConnectionId, ...(reply ? { reply, replyOnly: true as const } : {}) }) : false;
        if (persist && !runId && (phase === 'running' || phase === 'waiting' || phase === 'unknown')) this.openClawExecutions!.unownedActivity(sessionKey);
        settled = this.projectOpenClawExecution(sessionKey) || !!reply;
        const committed = (this.openClawProjection ?? this.openClawExecutions)?.get(sessionKey);
        if ((observed || committedObservation) && phase === 'failed' && runId && committed?.phase === 'failed'
          && committed.runId === runId) this.addAssistantFailureMessage(sessionKey, payload, raw);
      } catch (error) {
        // Losing a lifecycle write cannot leave an old terminal projection
        // available for admissions. Readers fail closed until owner recovery.
        this.invalidateOpenClawExecutionFacts();
        if (!persist) throw error;
      }
    }
    // Keep causal execution observations above, even after deletion. Suppress
    // only presentation: a deletion ACK is not proof of native quiescence.
    if (sessionKey && this.options.sessionDeleted?.(sessionKey)) return settled;
    if (!managed && sessionKey && runStatus !== undefined) {
      const current = this.sessions.get(sessionKey);
      if (current) {
        const next = this.withRunTiming(syncSessionStatus({
          ...current,
          lastActiveAt: Number(payload?.updatedAt ?? payload?.ts ?? raw?.ts ?? Date.now()),
        }, { runState: runStatus }), current, payload);
        this.sessions.set(sessionKey, next);
        this.append(runStatus === 'idle' || runStatus === 'failed' ? 'run.completed' : 'run.updated', next, {
          sessionKey,
          ...(agentId ? { agentId } : {}),
        });
        if (runStatus === 'failed') this.addAssistantFailureMessage(sessionKey, payload, raw);
      }
    }

    // The Gateway chat stream signals a failed/aborted assistant turn with a
    // chat event carrying state:"error"/"aborted" (errorKind/errorMessage),
    // NOT a run-named event. Surface it immediately so the user does not have
    // to refresh or send another message to learn the turn failed.
    const chatState = stringValue(payload?.state ?? raw?.state)?.toLowerCase();
    if (!managed && sessionKey && (eventName === 'chat' || eventName.startsWith('chat.')) && (chatState === 'error' || chatState === 'aborted')) {
      const current = this.sessions.get(sessionKey);
      if (current && (current.status === 'running' || current.hasActiveRun)) {
        const next = this.withRunTiming(syncSessionStatus({
          ...current,
          lastActiveAt: Number(payload?.updatedAt ?? payload?.ts ?? raw?.ts ?? Date.now()),
        }, { runState: 'failed' }), current, payload);
        this.sessions.set(sessionKey, next);
        this.append('run.completed', next, { sessionKey, ...(agentId ? { agentId } : {}) });
      }
      this.addAssistantFailureMessage(sessionKey, payload, raw);
    }

    const activity = activityFromGatewayEvent(raw, payload, eventName, sessionKey);
    if (activity) {
      this.upsertActivity(activity);
      this.append(activity.status === 'running' ? 'tool.started' : activity.status === 'error' ? 'tool.failed' : 'tool.completed', activity, {
        ...(activity.sessionKey ? { sessionKey: activity.sessionKey } : {}),
        ...(agentId ? { agentId } : {}),
      });
    }
    return settled;
  }

  updateGateway(gateway: GatewayHealth) {
    this.gateway = gateway;
    this.append('gateway.status_changed', gateway);
  }

  getGateway() {
    return this.gateway;
  }

  getSessionsState(options: { includeHidden?: boolean; includeArchived?: boolean } = {}): SessionsState {
    const byAgent = new Map<string, SessionSummary[]>();
    let hiddenCount = 0;
    let archivedCount = 0;
    let pinnedCount = 0;
    for (const session of this.sessions.values()) {
      if (this.options.sessionDeleted?.(session.sessionKey)) continue;
      const hidden = this.isSessionHidden(session.sessionKey);
      const archived = this.isSessionArchived(session.sessionKey);
      const pinned = this.isSessionPinned(session.sessionKey);
      if (hidden) hiddenCount += 1;
      if (archived) archivedCount += 1;
      if (pinned) pinnedCount += 1;
      if (hidden && !options.includeHidden) continue;
      if (archived && !options.includeArchived) continue;
      const agentId = session.agentId ?? 'unknown';
      const list = byAgent.get(agentId) ?? [];
      list.push(this.withMessageMetrics({
        ...session,
        ...(hidden ? { hidden: true } : {}),
        ...(archived ? { archived: true } : {}),
        ...(pinned ? { pinned: true } : {}),
      }));
      byAgent.set(agentId, list);
    }
    const groups = [...byAgent.entries()]
      .map(([agentId, sessions]) => ({
        agentId,
        sessions: sessions.sort(comparePinnedSessions),
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    return { groups, updatedAt: Date.now(), revision: stableGatewayRowsRevision(groups), hiddenCount, archivedCount, pinnedCount };
  }

  /** Startup-only parent handoff: no file reads/writes and no invented event.
   * The parent installs the original owner's snapshot before public ready. */
  installLocalPreferenceSnapshot(snapshot: LocalPreferenceSnapshot) {
    if (!this.externalPreferenceOwner || !validLocalPreferenceSnapshot(snapshot)) {
      throw new Error('Session preference requires the original async owner');
    }
    this.hiddenSessions = new Set(snapshot.hidden);
    this.archivedSessions = new Set(snapshot.archived);
    this.pinnedSessions = new Set(snapshot.pinned);
  }

  /** ACK-only projection; the configured sole owner has already saved the
   * full current set. Never call legacy persistence methods from this port. */
  projectLocalPreference(result: AcceptedLocalPreference) {
    const values = new Set(result.values);
    if (result.field === 'hidden') this.hiddenSessions = values;
    else if (result.field === 'archived') this.archivedSessions = values;
    else this.pinnedSessions = values;
    if (this.options.sessionDeleted?.(result.key)) return;
    const session = this.sessions.get(result.key);
    if (session) this.append('session.updated', { ...session, [result.field]: result.enabled }, sessionContext(session));
  }

  private assertSynchronousPreferenceOwner() {
    if (this.externalPreferenceOwner) throw new Error('Session preference requires the original async owner');
  }

  hideSession(sessionKey: string) {
    this.assertSynchronousPreferenceOwner();
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    this.hiddenSessions = changeSessionPreference(this.hiddenSessions, this.options.hiddenSessionsFile, sessionKey, true);
    const session = this.sessions.get(sessionKey);
    if (session) this.append('session.updated', { ...session, hidden: true }, sessionContext(session));
    return session ? this.withMessageMetrics({ ...session, hidden: true }) : undefined;
  }

  unhideSession(sessionKey: string) {
    this.assertSynchronousPreferenceOwner();
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    this.hiddenSessions = changeSessionPreference(this.hiddenSessions, this.options.hiddenSessionsFile, sessionKey, false);
    const session = this.sessions.get(sessionKey);
    if (session) this.append('session.updated', { ...session, hidden: false }, sessionContext(session));
    return session ? this.withMessageMetrics({ ...session, hidden: false }) : undefined;
  }

  isSessionHidden(sessionKey: string) {
    return this.hiddenSessions.has(sessionKey);
  }

  archiveSession(sessionKey: string) {
    this.assertSynchronousPreferenceOwner();
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    this.archivedSessions = changeSessionPreference(this.archivedSessions, this.options.archivedSessionsFile, sessionKey, true);
    const session = this.sessions.get(sessionKey);
    if (session) this.append('session.updated', { ...session, archived: true }, sessionContext(session));
    return session ? this.withMessageMetrics({ ...session, archived: true }) : undefined;
  }

  unarchiveSession(sessionKey: string) {
    this.assertSynchronousPreferenceOwner();
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    this.archivedSessions = changeSessionPreference(this.archivedSessions, this.options.archivedSessionsFile, sessionKey, false);
    const session = this.sessions.get(sessionKey);
    if (session) this.append('session.updated', { ...session, archived: false }, sessionContext(session));
    return session ? this.withMessageMetrics({ ...session, archived: false }) : undefined;
  }

  isSessionArchived(sessionKey: string) {
    return this.archivedSessions.has(sessionKey);
  }

  pinSession(sessionKey: string) {
    this.assertSynchronousPreferenceOwner();
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    this.pinnedSessions = changeSessionPreference(this.pinnedSessions, this.options.pinnedSessionsFile, sessionKey, true);
    const session = this.sessions.get(sessionKey);
    if (session) this.append('session.updated', { ...session, pinned: true }, sessionContext(session));
    return session ? this.withMessageMetrics({ ...session, pinned: true }) : undefined;
  }

  unpinSession(sessionKey: string) {
    this.assertSynchronousPreferenceOwner();
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    this.pinnedSessions = changeSessionPreference(this.pinnedSessions, this.options.pinnedSessionsFile, sessionKey, false);
    const session = this.sessions.get(sessionKey);
    if (session) this.append('session.updated', { ...session, pinned: false }, sessionContext(session));
    return session ? this.withMessageMetrics({ ...session, pinned: false }) : undefined;
  }

  isSessionPinned(sessionKey: string) {
    return this.pinnedSessions.has(sessionKey);
  }

  getSession(sessionKey: string) {
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    const session = this.sessions.get(sessionKey);
    return session ? this.withMessageMetrics(this.withLocalSessionOverrides(session)) : undefined;
  }

  /** Local native-observation veto only. Deliberately bypasses durable deletion,
   * preferences and execution decorators: none may run SQL in an owned runtime.
   * Presence here never grants authority or proves a session is not deleted. */
  localCodexAutomationObservation(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    return session ? { codexGoal: structuredClone(session.codexGoal) } : undefined;
  }

  /** Non-SQL local thinking level lookup for owned native Codex turn/resume
   * requests. Bypasses durable deletion and execution decorators so owned
   * dispatch stays off main-thread SQL. */
  localSessionThinkingLevel(sessionKey: string): SessionSummary['thinkingLevel'] | undefined {
    return this.sessions.get(sessionKey)?.thinkingLevel ?? this.sessionThinkingOverrides.get(sessionKey);
  }

  getSessionDirectory(query: SessionDirectoryQuery = {}, sourceCursor = this.latestEventId() ?? '') {
    const keys = query.sessionKey === undefined ? this.sessions.keys()
      : this.sessions.has(query.sessionKey) ? [query.sessionKey] : [];
    return projectSessionDirectory(this.visibleSessionKeys(keys), query, sourceCursor);
  }

  private *visibleSessionKeys(keys: Iterable<string>) {
    for (const key of keys) if (!this.options.sessionDeleted?.(key)) yield key;
  }

  getSessionExecution(sessionKey: string, sourceCursor?: string) {
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    const session = this.sessions.get(sessionKey);
    // Unlike the legacy summary getter, do not scan messages, estimate tokens
    // or infer a completed run from an assistant transcript item.
    return session ? sessionExecutionSnapshot(this.withExecution(session), sessionKey, (sourceCursor ?? this.latestEventId()) || undefined) : undefined;
  }

  markSessionBusy(sessionKey: string, durationMs = ACTIVE_RUN_STICKY_MS) {
    try {
      if (this.openClawProjection?.get(sessionKey)) {
        // Display-only consumers cannot manufacture unowned execution evidence.
        this.projectOpenClawExecution(sessionKey);
        return;
      }
      if (this.openClawExecutions?.get(sessionKey)) {
        this.openClawExecutions.unownedActivity(sessionKey);
        this.projectOpenClawExecution(sessionKey);
        return;
      }
    } catch (error) { this.invalidateOpenClawExecutionFacts(); throw error; }
    if (this.options.sessionDeleted?.(sessionKey)) return;
    const until = Date.now() + durationMs;
    this.localBusyUntil.set(sessionKey, until);
    if (!this.runStartedAt.has(sessionKey)) this.runStartedAt.set(sessionKey, Date.now());
    const current = this.sessions.get(sessionKey);
    if (!current) return;
    const startedAt = this.runStartedAt.get(sessionKey) ?? Date.now();
    const next = syncSessionStatus({ ...current, runStartedAt: startedAt, lastActiveAt: Date.now() }, { runState: 'running' });
    this.sessions.set(sessionKey, next);
    this.append('run.updated', next, sessionContext(next));
  }

  removeSession(sessionKey: string) {
    const current = this.sessions.get(sessionKey);
    const removed = this.sessions.delete(sessionKey);
    this.deleteResidentMessages(sessionKey, false);
    this.activities.delete(sessionKey);
    this.localBusyUntil.delete(sessionKey);
    this.runStartedAt.delete(sessionKey);
    this.runCompletedAt.delete(sessionKey);
    // Publish removal before fallible preference cleanup. A retry/restart must
    // derive visibility from the receipt, not replay deletion or old choices.
    if (removed || this.options.sessionDeleted?.(sessionKey)) {
      this.append('session.updated', { sessionKey, status: 'deleted' }, { sessionKey, ...(current?.agentId ? { agentId: current.agentId } : {}) });
    }
    const hiddenChanged = this.hiddenSessions.delete(sessionKey);
    const archivedChanged = this.archivedSessions.delete(sessionKey);
    const pinnedChanged = this.pinnedSessions.delete(sessionKey);
    if (hiddenChanged) this.saveHiddenSessions();
    if (archivedChanged) this.saveArchivedSessions();
    if (pinnedChanged) this.savePinnedSessions();
    return removed;
  }

  getMessages(sessionKey: string) {
    if (this.options.sessionDeleted?.(sessionKey)) return [];
    const list = this.messages.get(sessionKey);
    if (!list) return [];
    this.messageTouchedAt.set(sessionKey, this.nowMs());
    return list;
  }

  getMessageListVersion(sessionKey: string): number {
    return this.messageListVersions.get(sessionKey) ?? 0;
  }

  getMessage(sessionKey: string, messageId: string): ChatMessage | undefined {
    if (this.options.sessionDeleted?.(sessionKey)) return undefined;
    const list = this.messages.get(sessionKey);
    if (!list) return undefined;
    this.messageTouchedAt.set(sessionKey, this.nowMs());
    const idx = this.getOrBuildMessageIndex(list).get(messageId);
    return idx !== undefined ? list[idx] : undefined;
  }

  hasMessage(sessionKey: string, messageId: string): boolean {
    return this.getMessage(sessionKey, messageId) !== undefined;
  }

  getMessageHistoryPage(sessionKey: string, limit: number, before?: string) {
    const messages = this.getMessages(sessionKey);
    let page = this.historyPages.get(messages);
    if (!page) {
      page = indexHistoryPages(messages);
      this.historyPages.set(messages, page);
    }
    return page(limit, before);
  }

  getMergedMessageHistoryPage(sessionKey: string, limit: number, before?: string) {
    const messages = this.getMessages(sessionKey);
    let page = this.mergedHistoryPages.get(messages);
    if (!page) {
      page = indexHistoryPages(mergeMessageIdentities(messages));
      this.mergedHistoryPages.set(messages, page);
    }
    return page(limit, before);
  }

  getActivity(sessionKey: string) {
    if (this.options.sessionDeleted?.(sessionKey)) return [];
    return this.activities.get(sessionKey) ?? [];
  }

  private upsertActivity(activity: ActivityEntry) {
    if (!activity.sessionKey) return;
    const list = this.activities.get(activity.sessionKey) ?? [];
    const idx = list.findIndex((item) => item.toolCallId === activity.toolCallId || item.id === activity.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...activity };
    else list.push(activity);
    list.sort((a, b) => a.updatedAt - b.updatedAt);
    this.activities.set(activity.sessionKey, list.slice(-100));
  }

  getAttention() {
    return {
      gateway: this.gateway,
      sessions: [...this.sessions.values()].filter((session) => !this.options.sessionDeleted?.(session.sessionKey)
        && (session.status === 'running' || session.status === 'failed')),
      updatedAt: Date.now(),
    };
  }

  get requiresAsyncEvents() { return this.options.projectionEvents !== undefined; }

  private synchronousEventRead() {
    if (this.requiresAsyncEvents) throw new Error('Deck event reads require awaited owner ports');
  }

  getEventsSince(lastEventId?: string) {
    this.synchronousEventRead();
    this.recoverProjectionJournal();
    if (this.options.eventLog) return this.options.eventLog.getEventsSince(lastEventId);
    if (!lastEventId) return this.events.slice(-50);
    const idx = this.events.findIndex((event) => event.id === lastEventId);
    return idx >= 0 ? this.events.slice(idx + 1) : this.events.slice(-50);
  }

  latestEventId() {
    this.synchronousEventRead();
    this.recoverProjectionJournal();
    if (this.options.eventLog) return this.options.eventLog.latestEventId();
    return this.events.at(-1)?.id;
  }

  hasEvent(id: string) {
    this.synchronousEventRead();
    this.recoverProjectionJournal();
    return this.options.eventLog ? this.options.eventLog.hasEvent(id) : this.events.some((event) => event.id === id);
  }

  private recoverProjectionJournal() {
    if (!this.codexExecutionUnavailable && !this.openClawExecutionUnavailable) this.options.eventLog?.recoverProjection?.();
  }

  private withLocalSessionOverrides(session: SessionSummary): SessionSummary {
    const title = this.sessionTitleOverrides.get(session.sessionKey);
    const thinkingLevel = session.thinkingLevel ?? this.sessionThinkingOverrides.get(session.sessionKey);
    return {
      ...session,
      ...(title ? { title } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  private loadSessionTitleOverrides() {
    if (!this.options.sessionTitlesFile || !existsSync(this.options.sessionTitlesFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.sessionTitlesFile, 'utf8')) as Record<string, unknown>;
      for (const [sessionKey, title] of Object.entries(parsed)) {
        if (typeof title === 'string' && title.trim()) this.sessionTitleOverrides.set(sessionKey, title.trim());
      }
    } catch {
      // Ignore corrupt local override state; Gateway session data remains source-of-truth.
    }
  }

  private loadSessionThinkingOverrides() {
    if (!this.options.sessionThinkingOverridesFile || !existsSync(this.options.sessionThinkingOverridesFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.sessionThinkingOverridesFile, 'utf8')) as Record<string, unknown>;
      for (const [sessionKey, thinkingLevel] of Object.entries(parsed)) {
        if (typeof thinkingLevel === 'string' && thinkingLevel.trim()) this.sessionThinkingOverrides.set(sessionKey, thinkingLevel.trim() as SessionSummary['thinkingLevel']);
      }
    } catch {
      // Ignore corrupt local thinking override state; Gateway session data remains source-of-truth.
    }
  }

  private loadHiddenSessions() {
    if (!this.options.hiddenSessionsFile || !existsSync(this.options.hiddenSessionsFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.hiddenSessionsFile, 'utf8')) as unknown;
      const values = Array.isArray(parsed) ? parsed : Object.keys(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {});
      for (const value of values) if (typeof value === 'string' && value.trim()) this.hiddenSessions.add(value.trim());
    } catch {
      // Ignore corrupt local hidden state; sessions remain visible.
    }
  }

  private saveHiddenSessions() {
    if (!this.options.hiddenSessionsFile) return;
    saveSessionPreferences(this.options.hiddenSessionsFile, this.hiddenSessions);
  }

  private loadArchivedSessions() {
    if (!this.options.archivedSessionsFile || !existsSync(this.options.archivedSessionsFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.archivedSessionsFile, 'utf8')) as unknown;
      const values = Array.isArray(parsed) ? parsed : Object.keys(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {});
      for (const value of values) if (typeof value === 'string' && value.trim()) this.archivedSessions.add(value.trim());
    } catch {
      // Ignore corrupt local archive state; sessions remain visible.
    }
  }

  private saveArchivedSessions() {
    if (!this.options.archivedSessionsFile) return;
    saveSessionPreferences(this.options.archivedSessionsFile, this.archivedSessions);
  }

  private loadPinnedSessions() {
    if (!this.options.pinnedSessionsFile || !existsSync(this.options.pinnedSessionsFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.pinnedSessionsFile, 'utf8')) as unknown;
      const values = Array.isArray(parsed) ? parsed : Object.keys(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {});
      for (const value of values) if (typeof value === 'string' && value.trim()) this.pinnedSessions.add(value.trim());
    } catch {
      // Ignore corrupt local pin state; sessions remain in normal activity order.
    }
  }

  private savePinnedSessions() {
    if (!this.options.pinnedSessionsFile) return;
    saveSessionPreferences(this.options.pinnedSessionsFile, this.pinnedSessions);
  }

  private withMessageMetrics(session: SessionSummary): SessionSummary {
    if (!this.messages.has(session.sessionKey)) {
      const evicted = this.evictedMessageMetrics.get(session.sessionKey);
      const activitySession = evicted?.latestMessageAt && evicted.latestMessageAt > (session.lastActiveAt ?? 0)
        ? { ...session, lastActiveAt: evicted.latestMessageAt }
        : session;
      const reconciled = this.withTerminalMessageState(activitySession);
      if (!evicted || evicted.messageCount === 0 || isSdkSessionKey(session.sessionKey)) return reconciled;
      return {
        ...reconciled,
        messageCount: evicted.messageCount,
        estimatedTokens: evicted.estimatedTokens,
        totalTokens: reconciled.totalTokens ?? evicted.estimatedTokens,
      };
    }
    const messages = this.messages.get(session.sessionKey) ?? [];
    const metrics = this.getListMetrics(messages);
    const activitySession = metrics.latestMessageAt && metrics.latestMessageAt > (session.lastActiveAt ?? 0)
      ? { ...session, lastActiveAt: metrics.latestMessageAt }
      : session;
    const reconciled = this.withTerminalMessageState(activitySession);
    if (messages.length === 0 || isSdkSessionKey(session.sessionKey)) return reconciled;
    return {
      ...reconciled,
      messageCount: metrics.messageCount,
      estimatedTokens: metrics.estimatedTokens,
      totalTokens: reconciled.totalTokens ?? metrics.estimatedTokens,
    };
  }

  private bumpMessageListVersion(sessionKey: string) {
    this.messageListVersions.set(sessionKey, (this.messageListVersions.get(sessionKey) ?? 0) + 1);
  }

  private getOrBuildMessageIndex(list: ChatMessage[]) {
    let indexMap = this.messageIndexes.get(list);
    if (!indexMap) {
      indexMap = new Map<string, number>();
      for (let i = 0; i < list.length; i += 1) indexMap.set(list[i]!.id, i);
      this.messageIndexes.set(list, indexMap);
    }
    return indexMap;
  }

  private getListMetrics(list: ChatMessage[]) {
    let cached = this.listMetricsCache.get(list);
    if (!cached) {
      let latest = 0;
      let estimatedTokens = 0;
      let hasUnpinnedLocalState = false;
      for (const message of list) {
        latest = Math.max(latest, message.updatedAt ?? message.createdAt ?? 0);
        estimatedTokens += estimateTextTokens(message.text);
        if (!hasUnpinnedLocalState && (
          message.id.startsWith('local-status:')
          || message.status === 'queued'
          || message.status === 'sending'
          || message.status === 'outcome_unknown'
          || (message.role === 'user' && message.status === 'failed')
          || Boolean(message.media?.length)
        )) {
          hasUnpinnedLocalState = true;
        }
      }
      const terminal = latestRunTerminalMessage(list);
      cached = {
        messageCount: list.length,
        estimatedTokens,
        ...(latest ? { latestMessageAt: latest } : {}),
        ...(terminal ? { terminal } : {}),
        hasUnpinnedLocalState,
      };
      this.listMetricsCache.set(list, cached);
    }
    return cached;
  }

  private setResidentMessages(sessionKey: string, list: ChatMessage[]) {
    const previousBytes = this.approxMessageBytesBySession.get(sessionKey) ?? 0;
    const nextBytes = approxChatMessagesBytes(list);
    this.bumpMessageListVersion(sessionKey);
    this.messages.set(sessionKey, list);
    this.approxMessageBytesBySession.set(sessionKey, nextBytes);
    this.totalApproxMessageBytes = Math.max(0, this.totalApproxMessageBytes - previousBytes + nextBytes);
    this.messageTouchedAt.set(sessionKey, this.nowMs());
    this.evictedMessageMetrics.delete(sessionKey);
    this.evictColdMessages(sessionKey);
  }

  private deleteResidentMessages(sessionKey: string, preserveEvictedMetrics: boolean) {
    const list = this.messages.get(sessionKey);
    const previousBytes = this.approxMessageBytesBySession.get(sessionKey) ?? 0;
    if (preserveEvictedMetrics && list && list.length > 0 && !isSdkSessionKey(sessionKey)) {
      const metrics = this.getListMetrics(list);
      this.evictedMessageMetrics.set(sessionKey, {
        messageCount: metrics.messageCount,
        estimatedTokens: metrics.estimatedTokens,
        ...(metrics.latestMessageAt !== undefined ? { latestMessageAt: metrics.latestMessageAt } : {}),
      });
    } else if (!preserveEvictedMetrics) {
      this.evictedMessageMetrics.delete(sessionKey);
    }
    this.bumpMessageListVersion(sessionKey);
    this.messages.delete(sessionKey);
    this.approxMessageBytesBySession.delete(sessionKey);
    this.messageTouchedAt.delete(sessionKey);
    this.totalApproxMessageBytes = Math.max(0, this.totalApproxMessageBytes - previousBytes);
  }

  private evictColdMessages(protectedKey?: string) {
    if (this.messageEvictionPolicies.length === 0) return;
    const now = this.nowMs();
    while (this.messages.size > this.maxResidentMessageSessions || this.totalApproxMessageBytes > this.maxResidentMessageBytes) {
      let victimKey: string | undefined;
      let victimTouchedAt = Infinity;
      for (const [key, list] of this.messages) {
        if (key === protectedKey) continue;
        const touchedAt = this.messageTouchedAt.get(key) ?? 0;
        if (now - touchedAt < this.minResidentIdleMs) continue;
        if ((this.localBusyUntil.get(key) ?? 0) > now) continue;
        if (!this.messageEvictionPolicies.some(policy => policy(key))) continue;
        const rawSession = this.sessions.get(key);
        if (rawSession) {
          let exec: SessionSummary;
          try { exec = this.withExecution(rawSession); } catch { continue; }
          if (exec.status === 'running' || exec.hasActiveRun
            || ['running', 'starting', 'waiting', 'unknown'].includes(exec.runtime?.phase ?? '')
            || exec.runtime?.sync === 'syncing') continue;
        }
        if (this.getListMetrics(list).hasUnpinnedLocalState) continue;
        if (touchedAt < victimTouchedAt) {
          victimTouchedAt = touchedAt;
          victimKey = key;
        }
      }
      if (!victimKey) break;
      this.deleteResidentMessages(victimKey, true);
      this.evictedTranscriptCount++;
    }
  }

  private withTerminalMessageState(session: SessionSummary): SessionSummary {
    const execution = this.withExecution(session);
    if (execution !== session) return execution;
    // Codex and Hermes own their turn lifecycle. An assistant item may only be commentary,
    // and transcript delivery must never control execution or queue dispatch.
    if (session.source === 'codex' || session.agentId === 'codex' || session.source === 'hermes' || isSdkSessionKey(session.sessionKey)) return session;
    if (session.status !== 'running' && session.status !== 'failed' && !session.hasActiveRun) return session;
    const list = this.messages.get(session.sessionKey);
    const terminal = list ? this.getListMetrics(list).terminal : undefined;
    if (!terminal) return session;
    const startedAt = session.runStartedAt ?? this.runStartedAt.get(session.sessionKey) ?? session.lastActiveAt;
    // A newer run that started after the terminal row is legitimate and should
    // continue to display as running. Otherwise the terminal row is the freshest
    // run signal and the list must not keep saying running.
    if (startedAt && startedAt > terminal.at) return session;
    const completedAt = Math.max(session.runCompletedAt ?? 0, terminal.at);
    return syncSessionStatus({
      ...session,
      lastActiveAt: Math.max(session.lastActiveAt ?? 0, terminal.at),
      ...(completedAt ? { runCompletedAt: completedAt } : {}),
    }, { runState: terminal.status === 'failed' ? 'failed' : (terminal.status === 'waiting' ? 'waiting' : 'idle') });
  }

  private mapGatewaySession(row: any, pendingSubagentCount = 0, previous?: SessionSummary): SessionSummary {
    const key = String(row?.key ?? row?.sessionKey ?? row?.id ?? 'unknown');
    const rawStatus = normalizeSessionStatus(row);
    const lastActiveAt = Number(row?.updatedAt ?? row?.lastActiveAt ?? row?.lastRun?.updatedAt ?? row?.run?.updatedAt ?? row?.startedAt ?? Date.now());
    const localBusy = (this.localBusyUntil.get(key) ?? 0) > Date.now();
    // Do not age an explicit/locally-known running state back to idle just
    // because the session summary timestamp is quiet. Long agent turns can go
    // minutes without producing session-list activity; terminal transcript rows
    // and explicit failed/idle statuses below are the reliable completion signal.
    const runState = localBusy ? 'running' : (rawStatus === 'pending_subagent' ? 'idle' : rawStatus);
    if (!localBusy) this.localBusyUntil.delete(key);
    const childState = pendingSubagentCount > 0 ? 'pending' : 'idle';
    const recent = normalizeOptionalSessionText(row?.lastMessage ?? row?.preview ?? row?.subject);
    const session = this.withRunTiming(syncSessionStatus({
      sessionKey: key,
      agentId: row?.agentId ?? inferAgentId(key),
      title: titleForGatewaySession(row, key),
      ...(recent ? { recent } : {}),
      source: row?.surface ?? row?.kind,
      lastActiveAt,
      ...(pendingSubagentCount > 0 ? { pendingSubagentCount } : {}),
      ...numericSessionFields(row),
      ...modelFields(row),
    } as SessionSummary, { runState, childState, pendingSubagentCount }), previous, row);
    return session;
  }

  private withRunTiming(session: SessionSummary, previous?: SessionSummary, raw?: any): SessionSummary {
    // Gateway row.startedAt is the session lifetime start, not necessarily the
    // current agent run. Likewise lastRun belongs to a completed run. Only use
    // fields scoped to the active/current run for the running-duration badge.
    const startedAt = numericTime(raw?.runStartedAt, raw?.activeRun?.startedAt, raw?.currentRun?.startedAt, raw?.run?.startedAt);
    const completedAt = numericTime(raw?.runCompletedAt, raw?.completedAt, raw?.finishedAt, raw?.activeRun?.completedAt, raw?.currentRun?.completedAt, raw?.run?.completedAt, raw?.lastRun?.completedAt);
    const previousRunning = previous?.status === 'running' || previous?.hasActiveRun;
    if (session.status === 'running') {
      const continuedStartedAt = previousRunning ? (previous?.runStartedAt ?? this.runStartedAt.get(session.sessionKey)) : undefined;
      const value = startedAt ?? continuedStartedAt ?? Date.now();
      this.runStartedAt.set(session.sessionKey, value);
      const completedValue = this.runCompletedAt.get(session.sessionKey);
      if (completedValue && completedValue <= value) this.runCompletedAt.delete(session.sessionKey);
      // A currently running session must not expose a stale completed timestamp
      // from an older run; that confuses list badges and makes active sessions
      // look like long-dead/stuck work.
      const { runCompletedAt: _completedAt, ...activeSession } = session;
      return { ...activeSession, runStartedAt: value };
    }
    if (session.status === 'waiting' || session.status === 'unknown') {
      // A non-terminal observation may pause or lose visibility of a run;
      // neither establishes when that run completed.
      const knownStartedAt = previous?.runStartedAt ?? this.runStartedAt.get(session.sessionKey) ?? startedAt;
      return { ...session, ...(knownStartedAt ? { runStartedAt: knownStartedAt } : {}) };
    }
    const inferredCompletedAt = completedAt ?? (previousRunning ? (session.lastActiveAt ?? Date.now()) : undefined);
    if (inferredCompletedAt) this.runCompletedAt.set(session.sessionKey, inferredCompletedAt);
    if (!previousRunning && previous?.runStartedAt) this.runStartedAt.set(session.sessionKey, previous.runStartedAt);
    const knownStartedAt = previous?.runStartedAt ?? this.runStartedAt.get(session.sessionKey) ?? startedAt;
    const knownCompletedAt = inferredCompletedAt ?? previous?.runCompletedAt ?? this.runCompletedAt.get(session.sessionKey);
    return {
      ...session,
      ...(knownStartedAt ? { runStartedAt: knownStartedAt } : {}),
      ...(knownCompletedAt ? { runCompletedAt: knownCompletedAt } : {}),
    };
  }

  private addAssistantFailureMessage(sessionKey: string, payload: any, raw: any) {
    const runId = stringValue(payload?.runId ?? payload?.run?.id ?? payload?.id ?? raw?.id) ?? 'current';
    const explicitReason = stringValue(payload?.errorMessage ?? payload?.error ?? payload?.reason ?? raw?.errorMessage ?? raw?.error ?? raw?.message);
    const kindReason = friendlyChatErrorKind(stringValue(payload?.errorKind ?? raw?.errorKind));
    const reason = explicitReason ?? kindReason;
    const aborted = stringValue(payload?.state ?? raw?.state)?.toLowerCase() === 'aborted';
    this.addMessage({
      id: `assistant-failed:${runId}`,
      sessionKey,
      role: 'assistant',
      text: aborted ? 'Assistant turn was stopped before producing content.' : 'Assistant turn failed before producing content.',
      status: 'failed',
      ...(reason ? { failureReason: reason } : {}),
      createdAt: Number(payload?.updatedAt ?? payload?.ts ?? raw?.ts ?? Date.now()),
      updatedAt: Date.now(),
    });
  }
}

function projectionEvent<T>(type: DeckEventType, payload: T, context: { sessionKey?: string; agentId?: string } = {}): DeckEvent<T> {
  return { id: nanoid(), type, ts: Date.now(), ...context, payload };
}

function normalizeSessionText(value: unknown) {
  const text = String(value ?? '').trim();
  return normalizeDashboardTitle(repairUtf8Mojibake(text));
}

function normalizeOptionalSessionText(value: unknown) {
  const text = stringValue(value);
  return text ? normalizeDashboardTitle(repairUtf8Mojibake(text)) : undefined;
}

function titleForGatewaySession(row: any, key: string) {
  for (const candidate of [row?.label, row?.subject, row?.derivedTitle, row?.displayName, row?.title]) {
    const text = normalizeOptionalSessionText(candidate);
    if (text) return text;
  }
  const recovered = firstUserMessageTitle(row);
  if (recovered) return recovered;
  return normalizeSessionText(dashboardTitleFromSessionKey(key) ?? key);
}

function firstUserMessageTitle(row: any) {
  for (const message of rowMessages(row)) {
    const role = normalizeMessageRole(message?.role ?? message?.authorRole ?? message?.message?.role ?? message?.type);
    if (role !== 'user') continue;
    const text = messageText(message);
    if (!text) continue;
    return boundedSessionTitle(text);
  }
  return undefined;
}

function rowMessages(row: any) {
  const candidates = [row?.messages, row?.transcript, row?.history, row?.chatHistory, row?.messageRows, row?.transcriptRows];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate;
  return [];
}

function normalizeMessageRole(role: unknown) {
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool' ? role : undefined;
}

function messageText(message: any) {
  const content = message?.text ?? message?.content ?? message?.message?.text ?? message?.message?.content ?? message?.message?.message;
  const text = extractMessageText(content).trim();
  return text ? normalizeOpenClawUserTitleEnvelope(repairUtf8Mojibake(text)) : '';
}

function extractMessageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => extractMessageText(item)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.message === 'string') return record.message;
  }
  return '';
}

function normalizeOpenClawUserTitleEnvelope(text: string) {
  let current = text.trim();
  current = current.replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:UTC|GMT[+-]\d{1,2}|GMT[+-]\d{2}:?\d{2})\]\s*/i, '').trim();
  current = current.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '').trim();
  return current.replace(/\s+/g, ' ').trim();
}

function boundedSessionTitle(text: string) {
  const normalized = normalizeDashboardTitle(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 77).trimEnd()}…`;
}

function normalizeDashboardTitle(text: string) {
  return dashboardTitleFromSessionKey(text) ?? text;
}

function dashboardTitleFromSessionKey(value: string) {
  const match = /^(?:agent:)?[^:]+:dashboard:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value.trim());
  if (!match?.[1]) return undefined;
  return `Dashboard · ${match[1].split('-').map((part) => part.toUpperCase()).join(' ')}`;
}

function repairUtf8Mojibake(text: string) {
  if (!looksLikeUtf8Mojibake(text)) return text;
  const repaired = decodeWindows1252AsUtf8(text);
  if (!repaired || repaired.includes('\uFFFD')) return text;
  return mojibakeScore(repaired) + 2 < mojibakeScore(text) ? repaired : text;
}

function looksLikeUtf8Mojibake(text: string) {
  return /(?:Ã.|Â.|â[\u0080-\u00bf€šƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]|[æèé][\u0080-\u00bf¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿€šƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]|ð[\u0080-\u00bf])/.test(text);
}

function decodeWindows1252AsUtf8(text: string) {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const mapped = WINDOWS_1252_REVERSE.get(code);
    if (mapped !== undefined) bytes.push(mapped);
    else if (code <= 0xff) bytes.push(code);
    else return undefined;
  }
  return Buffer.from(bytes).toString('utf8');
}

function mojibakeScore(text: string) {
  let score = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\uFFFD') score += 20;
    else if (/[\u4e00-\u9fff]/u.test(char)) score -= 3;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) score -= 2;
    else if (code >= 0x80 && code <= 0xff) score += 1;
  }
  const suspiciousMatches = text.match(/Ã|Â|â|æ|è|é|ð|[\u0080-\u009f]|[€šƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g);
  score += (suspiciousMatches?.length ?? 0) * 3;
  return score;
}

const WINDOWS_1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

function friendlyChatErrorKind(kind: string | undefined): string | undefined {
  switch (kind) {
    case 'timeout': return 'provider timeout';
    case 'rate_limit': return 'rate limited';
    case 'context_length': return 'context length exceeded';
    case 'refusal': return 'model refused the request';
    case 'unknown': return undefined;
    default: return kind;
  }
}

function latestMessageActivityAt(messages: ChatMessage[]) {
  let latest = 0;
  for (const message of messages) latest = Math.max(latest, message.updatedAt ?? message.createdAt ?? 0);
  return latest || undefined;
}

function latestRunTerminalMessage(messages: ChatMessage[]): { at: number; status: SessionSummary['status'] } | undefined {
  let latest: { at: number; status: SessionSummary['status'] } | undefined;
  for (const message of messages) {
    // A local status report describes a snapshot; it cannot end that run.
    if (message.id.startsWith('local-status:')) continue;
    const text = message.text.toLowerCase();
    const assistantFailureTerminal = message.role === 'assistant' && (
      message.status === 'failed'
      || message.id.startsWith('assistant-failed:')
      || text.includes('assistant turn failed before producing content')
      || text.includes('assistant turn was stopped before producing content')
    );
    const assistantSuccessTerminal = message.role === 'assistant' && message.status === 'sent';
    const sessionsYieldTerminal = message.role === 'tool'
      && message.toolName === 'sessions_yield'
      && (message.toolPhase === 'result' || message.toolPhase === 'call' || /"status"\s*:\s*"yielded"/.test(message.text));
    const compactTerminal = message.role === 'system' && /^compaction\b/i.test(message.text.trim());
    if (!assistantFailureTerminal && !assistantSuccessTerminal && !sessionsYieldTerminal && !compactTerminal) continue;
    const at = message.updatedAt ?? message.createdAt ?? 0;
    if (!at || (latest && at <= latest.at)) continue;
    latest = { at, status: assistantFailureTerminal ? 'failed' : (sessionsYieldTerminal ? 'waiting' : 'idle') };
  }
  return latest;
}

const LOCAL_MEDIA_ECHO_WINDOW_MS = 120_000;

function mergeLocalEchoMedia(realMessage: ChatMessage, localMessage: ChatMessage) {
  if (!localMessage.media?.length) return realMessage;
  const media = [...(realMessage.media ?? [])];
  for (const item of localMessage.media) {
    if (!media.some((existing) => existing.name === item.name && existing.type === item.type)) media.push(item);
  }
  return media.length === (realMessage.media?.length ?? 0) ? realMessage : { ...realMessage, media };
}

function findMatchingMessage(messages: Map<string, ChatMessage>, candidate: ChatMessage, consumedMatches: Set<string>) {
  for (const [id, message] of messages) {
    if (consumedMatches.has(id)) continue;
    if (message.role !== candidate.role) continue;
    if (message.parentToolUseId !== candidate.parentToolUseId) continue;
    if (!isMatchingEchoText(message, candidate)) continue;
    if (mediaKey(message) === mediaKey(candidate)) return id;
    if (isLikelyLocalTextAndMediaEcho(message, candidate)) return id;
    if (isLikelyLocalMediaEcho(message, candidate)) return id;
  }
  return undefined;
}

function isMatchingEchoText(message: ChatMessage, candidate: ChatMessage) {
  if (message.text.trim() === candidate.text.trim()) return true;
  if (!candidate.status) return false;
  if (Math.abs(message.createdAt - candidate.createdAt) > LOCAL_MEDIA_ECHO_WINDOW_MS) return false;
  return canonicalEchoText(message.text) === canonicalEchoText(candidate.text);
}

function canonicalEchoText(value: string) {
  return value
    .trim()
    .replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:UTC|GMT[+-]\d{1,2}|GMT[+-]\d{2}:?\d{2})\]\s*/i, '')
    .trim();
}

function isLikelyLocalTextAndMediaEcho(message: ChatMessage, candidate: ChatMessage) {
  if (!candidate.status || !candidate.media?.length) return false;
  if (message.media?.length) return false;
  return Math.abs(message.createdAt - candidate.createdAt) <= LOCAL_MEDIA_ECHO_WINDOW_MS;
}

function isLikelyLocalMediaEcho(message: ChatMessage, candidate: ChatMessage) {
  if (!candidate.status) return false;
  if (!mediaMetadataKey(message) || mediaMetadataKey(message) !== mediaMetadataKey(candidate)) return false;
  return Math.abs(message.createdAt - candidate.createdAt) <= LOCAL_MEDIA_ECHO_WINDOW_MS;
}

function sameChatMessage(left: ChatMessage, right: ChatMessage) {
  return left.sessionKey === right.sessionKey
    && left.role === right.role
    && left.text === right.text
    && left.status === right.status
    && left.queueVersion === right.queueVersion
    && left.queueDisposition === right.queueDisposition
    && left.turnId === right.turnId
    && left.parentToolUseId === right.parentToolUseId
    && left.contentTruncated === right.contentTruncated
    && left.phase === right.phase
    && left.failureReason === right.failureReason
    && JSON.stringify(left.sourceFiles) === JSON.stringify(right.sourceFiles)
    && JSON.stringify(left.codexSubagent) === JSON.stringify(right.codexSubagent)
    && left.createdAt === right.createdAt
    && mediaKey(left) === mediaKey(right);
}

function mediaKey(message: ChatMessage) {
  return (message.media ?? []).map((item) => item.type + ':' + item.url + ':' + item.name).join('|');
}

function mediaMetadataKey(message: ChatMessage) {
  return (message.media ?? []).map((item) => item.type + ':' + item.name).join('|');
}

function estimateMessagesTokens(messages: ChatMessage[]) {
  return messages.reduce((sum, message) => sum + estimateTextTokens(message.text), 0);
}

function estimateTextTokens(text: string | undefined) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function sameSessionSummary(left: SessionSummary | undefined, right: SessionSummary) {
  return Boolean(left)
    && left!.agentId === right.agentId
    && left!.title === right.title
    && left!.recent === right.recent
    && left!.status === right.status
    && JSON.stringify(left!.runtime) === JSON.stringify(right.runtime)
    && JSON.stringify(left!.codexGoal) === JSON.stringify(right.codexGoal)
    && JSON.stringify(left!.controlCapabilities) === JSON.stringify(right.controlCapabilities)
    && left!.source === right.source
    && left!.lastActiveAt === right.lastActiveAt
    && left!.hasActiveRun === right.hasActiveRun
    && left!.runStartedAt === right.runStartedAt
    && left!.runCompletedAt === right.runCompletedAt
    && left!.inputTokens === right.inputTokens
    && left!.outputTokens === right.outputTokens
    && left!.totalTokens === right.totalTokens
    && left!.contextTokens === right.contextTokens
    && left!.contextUsedTokens === right.contextUsedTokens
    && left!.contextSampleBasis === right.contextSampleBasis
    && JSON.stringify(left!.nativeUsage) === JSON.stringify(right.nativeUsage)
    && left!.compactionCount === right.compactionCount
    && left!.rolloutBytes === right.rolloutBytes
    && left!.lastTurnCompactions === right.lastTurnCompactions
    && left!.maxTurnCompactions === right.maxTurnCompactions
    && left!.model === right.model
    && left!.modelProvider === right.modelProvider
    && left!.thinkingLevel === right.thinkingLevel
    && sameStructuredStatus(left!.structuredStatus, right.structuredStatus);
}

function withoutThinkingLevel(session: SessionSummary): SessionSummary {
  const { thinkingLevel: _thinkingLevel, ...rest } = session;
  return rest;
}

function sameStructuredStatus(left: SessionSummary['structuredStatus'], right: SessionSummary['structuredStatus']) {
  return left?.runState === right?.runState
    && left?.childState === right?.childState
    && left?.pendingSubagentCount === right?.pendingSubagentCount
    && left?.hasActiveRun === right?.hasActiveRun
    && left?.displayStatus === right?.displayStatus;
}

function sessionContext(session: SessionSummary) {
  return {
    sessionKey: session.sessionKey,
    ...(session.agentId ? { agentId: session.agentId } : {}),
  };
}

function activityFromGatewayEvent(raw: any, payload: any, eventName: string, sessionKey: string | undefined): ActivityEntry | undefined {
  const toolLike = eventName.includes('tool') || payload?.tool || payload?.toolName || payload?.toolCallId || payload?.function?.name;
  if (!toolLike) return undefined;
  const toolCallId = stringValue(payload?.toolCallId ?? payload?.tool_call_id ?? payload?.id ?? raw?.id) ?? nanoid();
  const runId = stringValue(payload?.runId ?? payload?.run?.id ?? payload?.turnId ?? payload?.messageId) ?? 'current';
  const status = normalizeActivityStatus(eventName, payload?.status ?? payload?.state ?? payload?.phase);
  const startedAt = Number(payload?.startedAt ?? payload?.createdAt ?? payload?.ts ?? raw?.ts ?? Date.now());
  const updatedAt = Number(payload?.updatedAt ?? payload?.completedAt ?? payload?.ts ?? raw?.ts ?? Date.now());
  const summary = summarizeToolPayload(payload);
  const outputPreview = stringValue(payload?.outputPreview ?? payload?.output ?? payload?.result ?? payload?.error)?.slice(0, 800);
  const durationMs = Number(payload?.durationMs ?? (updatedAt - startedAt));
  return {
    id: `${runId}:${toolCallId}`,
    status,
    toolName: stringValue(payload?.toolName ?? payload?.tool?.name ?? payload?.name ?? payload?.function?.name) ?? 'tool',
    ...(summary ? { summary } : {}),
    ...(outputPreview ? { outputPreview } : {}),
    outputTruncated: Boolean(payload?.outputTruncated),
    runId,
    toolCallId,
    ...(sessionKey ? { sessionKey } : {}),
    hiddenArgumentCount: Number(payload?.hiddenArgumentCount ?? 0),
    updatedAt,
    durationMs: Math.max(0, Number.isFinite(durationMs) ? durationMs : 0),
  };
}

function normalizeActivityStatus(eventName: string, status: unknown): ActivityEntry['status'] {
  const value = `${eventName} ${String(status ?? '')}`.toLowerCase();
  if (value.includes('fail') || value.includes('error')) return 'error';
  if (value.includes('complete') || value.includes('done') || value.includes('success') || value.includes('ok')) return 'done';
  return 'running';
}

function summarizeToolPayload(payload: any) {
  const args = payload?.arguments ?? payload?.args ?? payload?.input ?? payload?.params;
  if (typeof args === 'string') return args.slice(0, 240);
  if (args && typeof args === 'object') return Object.keys(args).slice(0, 6).join(', ');
  return stringValue(payload?.summary ?? payload?.description ?? payload?.message)?.slice(0, 240);
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numericTime(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function numericSessionFields(row: any): Partial<Pick<SessionSummary, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'estimatedTokens' | 'contextTokens' | 'contextUsedTokens' | 'compactionCount' | 'rolloutBytes' | 'lastTurnCompactions' | 'maxTurnCompactions'>> {
  return {
    ...numericField('inputTokens', row?.inputTokens),
    ...numericField('outputTokens', row?.outputTokens),
    ...numericField('totalTokens', row?.totalTokens),
    ...numericField('estimatedTokens', row?.estimatedTokens),
    ...numericField('contextTokens', row?.contextTokens),
    ...(row?.contextUsedTokens === null ? { contextUsedTokens: null } : numericField('contextUsedTokens', row?.contextUsedTokens)),
    ...numericField('compactionCount', row?.compactionCount),
    ...numericField('rolloutBytes', row?.rolloutBytes),
    ...numericField('lastTurnCompactions', row?.lastTurnCompactions),
    ...numericField('maxTurnCompactions', row?.maxTurnCompactions),
  };
}

function numericField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const number = Number(value);
  return Number.isFinite(number) ? { [key]: number } as { [P in K]?: number } : {};
}

function modelFields(row: any): Partial<Pick<SessionSummary, 'model' | 'modelProvider'>> {
  const model = stringValue(row?.model ?? row?.selectedModel ?? row?.configuredModel ?? row?.runtime?.model ?? row?.overrides?.model);
  const modelProvider = stringValue(row?.modelProvider ?? row?.provider ?? row?.runtime?.modelProvider ?? row?.runtime?.provider ?? row?.overrides?.modelProvider);
  const thinkingLevel = stringValue(row?.thinkingLevel ?? row?.runtime?.thinkingLevel ?? row?.overrides?.thinkingLevel ?? row?.thinking);
  return {
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as SessionSummary['thinkingLevel'] } : {}),
  };
}

function inferAgentId(sessionKey: string) {
  const match = sessionKey.match(/^(agent:)?([^:]+):/);
  return match?.[2];
}

function toLegacySessionStatus(runState: NonNullable<SessionSummary['structuredStatus']>['runState'], childState: NonNullable<SessionSummary['structuredStatus']>['childState']): SessionSummary['status'] {
  if (runState === 'failed' || runState === 'running' || runState === 'waiting' || runState === 'unknown') return runState;
  if (childState === 'pending') return 'pending_subagent';
  return 'idle';
}

function syncSessionStatus(
  session: Omit<SessionSummary, 'status'> & Partial<Pick<SessionSummary, 'status' | 'hasActiveRun' | 'structuredStatus'>>,
  overrides: Partial<Pick<NonNullable<SessionSummary['structuredStatus']>, 'runState' | 'childState' | 'pendingSubagentCount'>> = {},
): SessionSummary {
  const prior = session.structuredStatus;
  const pendingSubagentCount = overrides.pendingSubagentCount ?? session.pendingSubagentCount ?? prior?.pendingSubagentCount ?? 0;
  const childState = overrides.childState ?? (pendingSubagentCount > 0 ? 'pending' : (prior?.childState ?? (session.status === 'pending_subagent' ? 'pending' : 'idle')));
  const runState = overrides.runState ?? legacyRunState(session.status, session.hasActiveRun, prior?.runState);
  const hasActiveRun = runState === 'running';
  const displayStatus = toLegacySessionStatus(runState, childState);
  const { pendingSubagentCount: _pendingSubagentCount, ...base } = session;
  return {
    ...base,
    status: displayStatus,
    hasActiveRun,
    ...(pendingSubagentCount > 0 ? { pendingSubagentCount } : {}),
    structuredStatus: {
      runState,
      childState,
      pendingSubagentCount,
      hasActiveRun,
      displayStatus,
    },
  };
}

function legacyRunState(status: SessionSummary['status'] | undefined, hasActiveRun: boolean | undefined, fallback: NonNullable<SessionSummary['structuredStatus']>['runState'] | undefined): NonNullable<SessionSummary['structuredStatus']>['runState'] {
  if (hasActiveRun && status !== 'failed') return 'running';
  if (status === 'running' || status === 'failed' || status === 'waiting' || status === 'unknown' || status === 'idle') return status;
  return fallback ?? 'idle';
}

/** Events are partial observations, not session-list snapshots. No state field
 * is not idle; lastRun and substring matches cannot establish completion. */
function normalizeSessionStatus(row: any): SessionSummary['status'] {
  const statusValues = [
    row?.status,
    row?.state,
    row?.phase,
    row?.runStatus,
    row?.activeRun?.status,
    row?.currentRun?.status,
    row?.run?.status,
    row?.lastRun?.status,
  ].map((value) => String(value ?? '').toLowerCase()).filter(Boolean);
  if (row?.abortedLastRun === true) return 'failed';
  const explicitActiveRun = row?.hasActiveRun === true || row?.running === true || row?.busy === true;
  if (explicitActiveRun) return 'running';
  if (statusValues.some((value) => value.includes('running') || value.includes('in_progress') || value.includes('processing') || value.includes('queued') || value.includes('started'))) return 'running';
  if (Boolean(row?.waitingForInput) || statusValues.some((value) => value.includes('waiting') || value.includes('blocked') || value.includes('input'))) return 'waiting';
  if (statusValues.some((value) => value.includes('fail') || value.includes('error') || value.includes('crash') || value.includes('timeout') || value.includes('timed_out') || value.includes('aborted') || value.includes('cancelled') || value.includes('canceled'))) return 'failed';
  if (statusValues.some((value) => value.includes('unknown'))) return 'unknown';
  return 'idle';
}

function countPendingSubagentsByParent(rows: unknown[]) {
  const counts = new Map<string, number>();
  const orphanChildren: any[] = [];
  for (const row of rows) {
    if (!isSubagentSession(row) || !isPendingChildSession(row)) continue;
    const parentKey = parentSessionKeyOf(row);
    if (parentKey) counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1);
    else orphanChildren.push(row);
  }
  for (const child of orphanChildren) {
    const inferred = inferLegacyParentSessionKey(rows, child);
    if (inferred) counts.set(inferred, (counts.get(inferred) ?? 0) + 1);
  }
  return counts;
}

const LEGACY_ORPHAN_SUBAGENT_PARENT_WINDOW_MS = 30 * 60_000;

function inferLegacyParentSessionKey(rows: unknown[], child: any): string | undefined {
  const childUpdatedAt = numericTime(child?.updatedAt, child?.lastActiveAt, child?.createdAt, child?.startedAt);
  if (!childUpdatedAt) return undefined;
  const candidates = rows
    .filter((row: any) => !isSubagentSession(row))
    .map((row: any) => ({ row, key: sessionKeyOf(row), updatedAt: numericTime(row?.updatedAt, row?.lastActiveAt, row?.createdAt, row?.startedAt) }))
    .filter((item) => item.key && item.updatedAt && Math.abs(item.updatedAt - childUpdatedAt) <= LEGACY_ORPHAN_SUBAGENT_PARENT_WINDOW_MS)
    .map((item) => mapLegacyParentCandidate(item.row, item.key));
  const visible = candidates.filter((candidate): candidate is string => Boolean(candidate));
  return visible.length === 1 ? visible[0] : undefined;
}

function mapLegacyParentCandidate(row: any, key: string) {
  const lastActiveAt = numericTime(row?.updatedAt, row?.lastActiveAt, row?.createdAt, row?.startedAt);
  const session: SessionSummary = {
    sessionKey: key,
    agentId: row?.agentId ?? inferAgentId(key),
    title: normalizeSessionText(row?.label ?? row?.subject ?? dashboardTitleFromSessionKey(key) ?? key),
    status: normalizeSessionStatus(row),
    source: row?.surface ?? row?.kind,
    ...(lastActiveAt ? { lastActiveAt } : {}),
  };
  return isPreviewVisibleAgent(session.agentId) && isUserFacingSession(session) ? key : undefined;
}

function sessionKeyOf(row: any) {
  return String(row?.key ?? row?.sessionKey ?? row?.id ?? 'unknown');
}

function parentSessionKeyOf(row: any): string | undefined {
  const direct = firstString(
    row?.parentSessionKey,
    row?.parentKey,
    row?.parentSession,
    row?.parent?.sessionKey,
    row?.parent?.key,
    row?.parent?.id,
    row?.requesterSessionKey,
    row?.requesterSession,
    row?.requester?.sessionKey,
    row?.requester?.key,
    row?.originatingSessionKey,
    row?.originSessionKey,
    row?.sourceSessionKey,
    row?.spawnedBySessionKey,
    row?.metadata?.parentSessionKey,
    row?.metadata?.requesterSessionKey,
    row?.metadata?.requesterSession,
    row?.context?.parentSessionKey,
    row?.context?.requesterSessionKey,
    row?.context?.requesterSession,
    row?.request?.sessionKey,
  );
  return direct && direct !== sessionKeyOf(row) ? direct : undefined;
}

function isSubagentSession(row: any) {
  const key = sessionKeyOf(row).toLowerCase();
  const candidates = [
    key,
    row?.channel,
    row?.surface,
    row?.kind,
    row?.type,
    row?.shape,
    row?.metadata?.channel,
    row?.metadata?.kind,
    row?.context?.channel,
    row?.context?.kind,
  ].map((value) => String(value ?? '').toLowerCase());
  return candidates.some((value) => value.includes('subagent'));
}

function isPendingChildSession(row: any) {
  const status = normalizeSessionStatus(row);
  if (status === 'failed') return false;
  if (status === 'running' || status === 'waiting' || status === 'pending_subagent') return true;
  return row?.hasActiveRun === true
    || row?.running === true
    || row?.busy === true
    || row?.pending === true
    || row?.inFlight === true;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isSyntheticWebSession(session: SessionSummary) {
  return session.source === 'web' && session.sessionKey.toLowerCase().includes(':dashboard:agentopsdeck-web-');
}

function isUserFacingSession(session: SessionSummary) {
  if (isSdkSessionKey(session.sessionKey)) return session.source === session.sessionKey.split(':', 1)[0];
  if (session.source === 'hermes' && session.sessionKey.startsWith('hermes:')) return true;
  if (session.source === 'codex' || session.agentId === 'codex') return true;
  const parts = session.sessionKey.toLowerCase().split(':');
  const offset = parts[0] === 'agent' ? 2 : 0;
  const channel = parts[offset];
  const shape = parts[offset + 1];
  const target = parts.slice(offset + 2).join(':');
  if (!channel || !shape) return false;

  // AgentOpsDeck-created web sessions use agent:<id>:dashboard:<uuid> keys.
  // Keep these visible while still excluding isolated/subagent/internal sessions.
  if (channel === 'dashboard') return true;
  if (channel === 'web') return ['direct', 'session'].includes(shape) && Boolean(target);

  if (['feishu', 'telegram', 'wechat', 'openclaw-weixin', 'signal', 'discord', 'slack', 'matrix'].includes(channel)) {
    return Boolean(target) && ['direct', 'group', 'channel', 'thread'].includes(shape);
  }

  return false;
}

function isSdkSessionKey(key: string) {
  return key.startsWith('claude-code:') || key.startsWith('ghcp:');
}

function isPreviewVisibleAgent(agentId: string | undefined) {
  return Boolean(agentId && !agentId.includes(':'));
}

function comparePinnedSessions(a: SessionSummary, b: SessionSummary) {
  const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDelta !== 0) return pinnedDelta;
  return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
}

function approxChatMessageBytes(m: ChatMessage): number {
  return 160
    + (m.id.length + m.sessionKey.length + (m.text?.length ?? 0) + (m.failureReason?.length ?? 0) + (m.turnId?.length ?? 0)) * 2
    + (m.media?.length ?? 0) * 256;
}

function approxChatMessagesBytes(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += approxChatMessageBytes(m);
  }
  return total;
}
