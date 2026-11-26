import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WindowsProcessJob } from './windows-process-job.js';
import { windowsControlEnvironment } from '../connector/windows-private-worker.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { SECRET_DIRECTORY_ACL_SCRIPT, windowsAsyncControl } from '../connector/windows-async-control.js';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { drainNativeDiagnostics } from '../execution/native-diagnostics.js';
import { prepareExecutionHome } from '../execution/private-environment.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { requiredSynchronousEffectAuthority as synchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import { nanoid } from 'nanoid';
import { readModelCatalog, type ModelChoice } from './model-catalog.js';
import { configuredModelProvider, ProviderModelCatalog } from './provider-model-catalog.js';
import { resolveCodexReasoningParams } from './reasoning-compat.js';
import { createToolImageCompatibilityRelay, toolImageCompatibilityArguments, type ToolImageCompatibilityOptions } from './tool-image-compat.js';
import { goalSnapshot, goalMutation, goalAcknowledged, GoalControlConflict } from './goal-control.js';
import { GoalDiagnostics, type GoalDiagnosticTrace } from './goal-diagnostics.js';
import { RuntimeDiagnostics, type RuntimeDiagnosticSource } from './runtime-diagnostics.js';
import { HistoryDiagnostics } from './history-diagnostics.js';
import { CodexRpcError } from './rpc-error.js';
import { CodexNativeObservations, codexRpcNeedsObservationBarrier } from './native-observations.js';
import { consumeCodexOutput } from './native-output.js';
import { recoverCodexStartup, readCodexStartupQueue } from './startup-recovery.js';
import type { NativeResumeInput, NativeResumeReceipt } from './native-resume.js';
import { codexQueueDisposition, codexQueuedTurnMessage } from './queued-turn-projection.js';
import { codexMessageAdmission, type CodexMessageAdmission } from '../connector/connector-codex-message-domain.js';
import type { CodexStopIntent, CodexStopObservation } from '../connector/connector-codex-stop-domain.js';
import { validConnectorExecutionOutput } from '../connector/connector-execution-domain.js';
import type { CodexQueueRecovery } from '../connector/async-codex-queue.js';

export type CodexPreparedCredentials = {
  text: string;
  connectionId: string;
  /** Transfers resource ownership before requesting a worker claim. No await. */
  dispatching(): void;
  finish(outcome: 'not_started' | 'admitted' | 'unknown'): Promise<void>;
};
import { settleCodexNativeNotification, type CodexNativeNotification, type CodexNativeNotificationResult } from './native-notification.js';
import { admitCodexQueued, acknowledgeCodexDispatch, settleCodexDispatchFailure, codexAdmissionProof, codexAdmissionMatches,
  CodexAdmissionConflict, type CodexAdmissionProof } from './dispatch-admission.js';
import { performanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { CodexAutomationCompletions } from './automation-completions.js';
import { CodexSubagentLiveTracker } from './subagent-live-tracker.js';
import { AGENTOPSDECK_PRODUCT_NAME, AGENTOPSDECK_VERSION, readGoalControl, type GoalControl, type GoalControlSnapshot } from '@agentopsdeck/shared';
import { CodexBoardTools, codexBoardToolSpecs } from './board-tools.js';
import { completedFileChanges } from './file-change-evidence.js';
import { appendTurnContext } from './turn-context.js';
import { projectSkills, SessionSkillsCache } from './skills.js';
import type { ActivityEntry, AgentRuntime, ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import type { DeckStore } from '../projection/deck-store.js';
import { SessionPreferencePersistenceError } from '../projection/session-preference-file.js';
import { HistoryReadSuperseded, type HistoryRefreshOptions } from '../refresh/history.js';
import { mimeTypeFor } from '../utils/mime.js';
import { inboundMediaReadDirectory } from '../messages/send-message.js';
import { projectRuntime, runtimeBusy, snapshotRuntime } from './run-state.js';
import { TurnQueue, TurnAuthorizationError, isRecord, type QueuedTurn, type TurnQueueCommit } from '../commands/turn-queue.js';
import { requireExpectedRun, RunControlConflict } from '../commands/run-control.js';
import { TurnWorker } from '../commands/turn-worker.js';
import { readRecoveryPage } from '../commands/recovery-page.js';
import type { AuthorizeTurn, ExecutionAction, ExecutionGrantAuthority } from '../connector/execution-grants.js';
import { settleCodexConnectionRecoveryPage } from '../connector/connector-execution-domain.js';
import type { CodexExecution, CodexExecutions } from './executions.js';
import { nativeHistoryFingerprint, nativeGoalEvidence, nativeGoalProtection, hasNativeChildWork, type NativeHistoryCheckpoint } from './native-history.js';
import { readCodexGoal } from '@agentopsdeck/shared';
import { CODEX_AUTONOMY_INSTRUCTIONS } from './autonomy-policy.js';
import { subagentObservation } from './subagent-observation.js';
import { inspectNativeChildren, rehydrateNativeChildren } from './child-drain.js';
import { observeCompaction, type CompactionEvidence } from './compaction.js';
import { backgroundTerminals, BackgroundTerminalDrainError, terminateBackgroundTerminals } from './background-terminals.js';
import { requireInterruptedDispatchSettled, InterruptedDispatchUnconfirmed } from './interrupted-dispatch.js';
import { inspectCodexMaintenance } from './maintenance.js';
import { waitForLinuxProcessGroupExit } from './process-group.js';
import { describeBatch, waitingBatch, type CodexBatch } from './queued-batch.js';
import { expandCodexHistory, type CodexHistoryPlan, type CodexHistoryReader } from './history-plan.js';
import { codexContextUsage, codexCumulativeUsage, createRolloutUsageAccumulator } from './usage.js';
import { createRolloutModelAccumulator } from './rollout-model.js';
export { threadModelFromRollout } from './rollout-model.js';
import { CodexRolloutReader, RolloutObservationPendingError, type RolloutSourceVersion } from './rollout-reader.js';
import type { RolloutCachePolicy } from './rollout-cache-policy.js';
import { RolloutProjection, rolloutLines, type RolloutSource } from './rollout-projection.js';
import { compactToolHistoryContent } from './tool-history-content.js';
import { bindToolRecord, rolloutToolOutputText, type IndexedToolOutput } from './indexed-tool-output.js';

type JsonRpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string; code?: number } };
type GoalWriteReceipt = { beforeWrite: () => void; acknowledge: (raw: unknown) => void | Promise<void>; trace?: GoalDiagnosticTrace };
type CodexDisplayHistory = { source: RolloutSourceVersion; connection: string; generation: number; projection: number;
  execution: unknown; runtime: unknown; activity(): boolean };
type CodexQueuedPayload = { text: string; images: CodexImageAttachment[]; actorId?: string; executionGrant?: ExecutionGrantAuthority };
type QueuedAdmission = { proof: CodexAdmissionProof };
type CodexAdmission = { runId: string; idempotencyKey: string; status: 'queued'; media: NonNullable<ChatMessage['media']>;
  admission?: { createdAt: number; queueVersion: string; disposition: 'waiting' | 'preparing' } };
// Only a rejected execution.begin proves no native mutation was attempted here.
// A command that already owns preparation must still remain unknown, not replay.
class TurnStartDeferred extends Error {
  constructor() { super('Codex execution is not available for dispatch'); }
}
/** A read window changed, not a failed/ambiguous native effect. Only the
 * post-ACK cold-load observer may restart this read-only proof. */
class OwnedLoadObservationChanged extends TurnStartDeferred {}
/** Recovery needs its own permission; sending alone does not grant it. */
class RecoveryAuthorizationError extends TurnAuthorizationError {}
class NativeHistoryReadError extends Error {
  constructor(readonly fault: 'schema' | 'system-error' | 'identity' | 'item-view' | 'native-read' | 'incomplete', message: string) { super(message); }
}
/** The ACK may strengthen only the original history fence. It cannot bless a
 * concurrent tool, ownership, phase or execution-identity change. */
function resumeProtectionOnly(before: CodexExecution, after: CodexExecution | null | undefined) {
  return !!after && after.revision === before.revision + 1
    && isDeepStrictEqual(after, { ...before, revision: after.revision, updatedAt: after.updatedAt,
      sync: 'syncing', nativeHistory: { ...(before.nativeHistory ?? { turnId: before.runId,
        fingerprint: '0'.repeat(64), connectionId: before.connectionId }), state: 'blocked', reason: 'changed' } });
}
/** Internal observer timeout, not an optional enrichment rejection. */
class HistoricalProjectionPendingError extends NativeHistoryReadError {
  constructor() { super('incomplete', 'Historical assistant projection is still pending'); }
}
function historyFailureDiagnostic(error: unknown, stage: string) {
  return { stage, fault: error instanceof NativeHistoryReadError ? error.fault
    : error instanceof RolloutObservationPendingError ? 'rollout-pending'
    : error instanceof BackgroundTerminalDrainError ? 'background-terminals'
    : error instanceof InterruptedDispatchUnconfirmed ? 'interrupted-dispatch'
    : error instanceof RunControlConflict ? 'authority-changed' : 'unavailable',
    ...(error instanceof BackgroundTerminalDrainError ? { ownership: error.ownership, lifecycle: error.lifecycle } : {}) };
}
export type CodexImageAttachment = { filePath: string; media: NonNullable<ChatMessage['media']>[number] };
export type CodexAssistantProjector = (text: string) => Promise<{ text: string; media: NonNullable<ChatMessage['media']> }>;

const CODEX_MEDIA_BUDGET_INSTRUCTIONS = [
  'Keep image payloads out of long-running thread context.',
  'Generate or inspect at most 2 high-resolution images in one turn. For larger batches, stop after 2, report their file paths, and ask to continue with the next batch.',
  'Do not reopen or attach every generated image in a batch. Preserve subsequent context using file paths and concise text summaries instead of image bytes.',
].join(' ');
const CODEX_REQUEST_TIMEOUT_MS = 30_000;
// A full native transcript plus its immutable rollout is not a status RPC.
// Large sessions already take more than the ordinary RPC budget to read.
// Verification still has ONE bounded budget across reads/projection/retries;
// expiry retains the original execution/queue protection, never grants input.
const CODEX_HISTORY_VERIFICATION_TIMEOUT_MS = 120_000;
const GOAL_LATE_ACK_TTL_MS = 10 * 60_000;
const GOAL_ACK_CAPACITY = 128;
const CODEX_SESSION_LIST_PAGE_SIZE = 100;
const CODEX_SESSION_LIST_MAX_PAGES = 100;
const CODEX_RUNNING_RECOVERY_INTERVAL_MS = 30_000;
const CODEX_BACKGROUND_WORK_RECOVERY_INTERVAL_MS = 5_000;
const CODEX_RETRY_NOTICE = 'Model connection interrupted · Codex is retrying…';
const CODEX_ERROR_NOTICE = 'Codex reported an error · waiting for final run status';
const MAX_PROJECTED_TOOL_TEXT_CHARS = 16 * 1024;
const MAX_LIVE_TOOL_DELTA_BATCH_CHARS = 256 * 1024;
const MAX_LIVE_TOOL_PREVIEW_CHARS = 2 * 1024;
const OPAQUE_SECRET_MIN_LENGTH = 256;
const MAX_RUNTIME_OVERRIDE_BYTES = 64 * 1024;
const MAX_RUNTIME_OVERRIDE_ENTRIES = 512;
const MAX_RUNTIME_OVERRIDE_VALUE_CHARS = 128;
const MAX_ASSISTANT_ITEM_BYTES = 1024 * 1024;
const MAX_ASSISTANT_TURN_BYTES = 8 * 1024 * 1024;
const MAX_ASSISTANT_TURN_ITEMS = 128;
const MAX_ASSISTANT_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_ASSISTANT_RETAINED_ITEMS = 1024;

import { CodexInteractionBridge } from './interaction-bridge.js';
import { defaultModeQuestionFeature, probeDefaultModeQuestions } from './interaction-capability.js';
import type { InteractionRuntime } from '../commands/interaction-runtime.js';
import { conflictingNativeNotificationIdentity, nativeNotificationThread, nativeNotificationTurn, successorItemTurn, terminalHistoryActivity } from './terminal-history-activity.js';

/** One complete journal port: opting in must not leave connection replacement
 * on a different writer from native settlement. Receiver ownership and its
 * observation barrier still belong to the original executor. */
export type CodexNativeJournal = {
  fileIndexProjection(input: import('../connector/connector-codex-file-index-domain.js').CodexFileIndexInput): Promise<boolean>;
  cumulativeUsage(input: import('../connector/connector-codex-usage-domain.js').CodexCumulativeUsageInput): Promise<boolean>;
  /** Display-only view of the same owner. Never used for dispatch authority. */
  projection: import('../projection/deck-store.js').CodexExecutionProjection;
  readExecution(sessionKey: string): Promise<CodexExecution | undefined>;
  readHistory(sessionKey: string): Promise<import('../connector/connector-execution-domain.js').CodexHistoryObservation>;
  readMaintenance(): Promise<import('../connector/connector-execution-domain.js').CodexMaintenanceObservation>;
  prepareResume(input: NativeResumeInput): Promise<NativeResumeReceipt | null>;
  beginResume(receipt: NativeResumeReceipt): Promise<boolean>;
  finishResume(receipt: NativeResumeReceipt, outcome: 'acknowledged' | 'not_dispatched'): Promise<boolean>;
  recoverTerminal(expected: CodexExecution, runId: string, phase: 'completed' | 'failed' | 'interrupted'): Promise<boolean>;
  observeTerminal(expected: CodexExecution, connectionId: string, runId: string, phase: 'completed' | 'failed' | 'interrupted'): Promise<boolean>;
  cleanupRecovered(sessionKey: string, runId: string): Promise<boolean>;
  settleHistory(expected: CodexExecution, sync: 'current' | 'error', checkpoint?: NativeHistoryCheckpoint): Promise<boolean>;
  invalidateHistory(sessionKey: string): Promise<void>;
  settle(event: CodexNativeNotification): Promise<CodexNativeNotificationResult>;
  settleConnectionPage(after: string, previousConnectionId: string | undefined,
    nextConnectionId: string | undefined): Promise<string[]>;
};
export type CodexMaintenanceRecoveryAuthority = {
  authorize: () => Promise<void>;
  local: () => void;
  resumes: Pick<CodexNativeJournal, 'prepareResume' | 'beginResume' | 'finishResume'>;
};

type CodexAppServerCommonOptions = {
  tokenUsage?: import('../connector/native-token-usage.js').NativeTokenUsageStore;
  interactions?: { runtime: InteractionRuntime; nodeId: string };
  ownedInteractions?: { nodeId: string };
  boardToolsDirectory?: string | undefined;
  fileIndex?: SessionFileIndex;
  historyCache?: RolloutCachePolicy;
  enabled: boolean;
  command: string;
  homeDirectory?: string | undefined;
  defaultCwd: string;
  defaultModel: string;
  modelProvider?: string | undefined;
  modelProviderEnvironment?: Readonly<Record<string, string | undefined>> | undefined;
  toolImageCompatibility?: ToolImageCompatibilityOptions | undefined;
  autoCompactTokenLimit?: number | undefined;
  disableRemoteCompaction?: boolean | undefined;
  approvalPolicy: 'never' | 'on-request' | 'untrusted';
  store: DeckStore;
  nativeJournal?: CodexNativeJournal;
  /** Original TurnWorker consumes same-owner observations. The paired FIFO
   * consumer owns complete prepare/claim/effect/settlement, never sync fallback. */
  scheduling?: Pick<import('../connector/async-codex-scheduling.js').AsyncCodexScheduling,
    'observe' | 'recheck' | 'rejectHead' | 'sessionPage' | 'recoveryPage' | 'onAdmission'>;
  queuedConsumer?: Pick<import('../connector/async-codex-queue.js').AsyncCodexQueue, 'run' | 'close'>;
  /** Complete original startup consumer, under the application's admission
   * gate. Never mix worker import/recovery with constructor SQL recovery. */
  startup?: Pick<import('../connector/async-codex-startup.js').AsyncCodexStartup, 'open' | 'close'>;
  /** Original worker observation for resource disposal only, never authority. */
  credentialExecutionReader?: { get(sessionKey: string): Promise<CodexExecution | undefined> };
  historyReader?: CodexHistoryReader;
  authorizeTurn: AuthorizeTurn;
  fileBoardContext?: (sessionKey: string, actorId?: string, delegated?: unknown) => string;
  projectAssistant?: CodexAssistantProjector;
  requestTimeoutMs?: number;
  queueFile?: string;
  runtimeOverridesFile?: string;
};

/** A complete worker-owned executor has no synchronous database handles.
 * Legacy callers retain their original paired stores until their whole
 * production ownership graph is ready for coordinated cutover. */
export type CodexAppServerOptions = CodexAppServerCommonOptions & (
  { turnQueue: TurnQueue; executions: CodexExecutions }
  | { turnQueue?: never; executions?: never;
      nativeJournal: CodexNativeJournal;
      startup: NonNullable<CodexAppServerCommonOptions['startup']>;
      scheduling: NonNullable<CodexAppServerCommonOptions['scheduling']>;
      queuedConsumer: NonNullable<CodexAppServerCommonOptions['queuedConsumer']>;
      historyReader: CodexHistoryReader;
      credentialExecutionReader: NonNullable<CodexAppServerCommonOptions['credentialExecutionReader']>;
      interactions?: never; fileIndex?: never; tokenUsage?: never; fileBoardContext?: never;
    }
);

/**
 * Local-only bridge for Codex App Server.  It intentionally uses stdio: the
 * Deck never exposes a Codex listener through its HTTP server or tunnel.
 */
export class CodexAppServer {
  private get legacyTurnQueue(): TurnQueue {
    if (!this.options.turnQueue) throw new Error('Synchronous queue is unavailable in worker-owned Codex');
    return this.options.turnQueue;
  }
  private get legacyExecutions(): CodexExecutions {
    if (!this.options.executions) throw new Error('Synchronous executions are unavailable in worker-owned Codex');
    return this.options.executions;
  }
  private readonly interactions: CodexInteractionBridge | undefined;
  private nativeQuestionsSupported = false;
  private readonly boardTools: CodexBoardTools;
  private pendingBoardThreadStarts = 0;
  private readonly rolloutReader: CodexRolloutReader;

  private readRolloutSnapshot(path: unknown, options: Parameters<CodexRolloutReader['readSnapshot']>[1] = {},
    timeoutMs = this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS) {
    return this.rolloutReader.readSnapshotWithin(path, options, timeoutMs);
  }

  private validateRolloutSnapshot(path: unknown) {
    return this.rolloutReader.validateWithin(path, this.options.requestTimeoutMs ?? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS);
  }
  private connectionId: string | undefined;
  private automationConnectedSince = 0;
  private readonly automationCompletions = new CodexAutomationCompletions();
  private disconnectedConnectionId: string | undefined;
  private executionUnavailable = false;
  private maintenanceEpoch = 0;
  // Maintenance remains process-wide; a send proof must only depend on its
  // own native thread and the child subtree actually read by that proof.
  private nativeActivityVersions = new Map<string, number>();
  private nativeUnscopedActivityEpoch = 0;
  private readonly terminalHistoryObservers = new Set<(method: string, params: any) => void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private toolImageRelay: Awaited<ReturnType<typeof createToolImageCompatibilityRelay>> | undefined;
  private childLifetimes = new Map<ChildProcessWithoutNullStreams, { closed: Promise<void>; stopRequested: boolean; job?: WindowsProcessJob }>();
  private starting: Promise<void> | undefined;
  private initializing: Promise<void> | undefined;
  private initializationDrain: Promise<void> | undefined;
  private readonly maintenanceDrains = new Set<Promise<void>>();
  private readonly maintenanceRecovery = new AsyncLocalStorage<CodexMaintenanceRecoveryAuthority & { active: boolean }>();
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  // Physical worker-authority waits belong to this executor, not an HTTP waiter.
  private readonly authorizingEffects = new Set<Promise<unknown>>();
  // Only exact RPC replies may settle a timed-out Goal write. Notifications and
  // subsequent reads cannot establish the outcome of the original intent.
  private readonly goalDiagnostics = new GoalDiagnostics();
  private readonly runtimeDiagnostics = new RuntimeDiagnostics();
  private readonly historyDiagnostics = new HistoryDiagnostics();
  private goalWriteReceipts = new Map<number, { connection: string; acknowledge: (raw: unknown) => void | Promise<void>; trace?: GoalDiagnosticTrace; timer?: NodeJS.Timeout }>();
  private readonly goalAcknowledgementDrains = new Set<Promise<void>>();
  private assistantText = new Map<string, string>();
  private readonly assistantRetention = new Map<string, { identity: string; bytes: number; items: Map<string, number> }>();
  private assistantRetainedBytes = 0;
  private assistantRetainedItems = 0;
  private readonly modelProviderEnvironment: Readonly<Record<string, string | undefined>>;
  private completedAssistantItems = new Set<string>();
  private activeTurnIds = new Map<string, string>();
  private projectionVersions = new Map<string, number>();
  private readonly queueHistoryLeases = new Map<string, Promise<void>>();
  private goalObservationVersions = new Map<string, number>();
  private goalExecutionVersions = new Map<string, number>();
  // Reject overlapping local intents; never queue/replay a control against a
  // later Goal. This is not a lock on independent native clients. Durable
  // receipt protection still owns unknown outcomes after this call settles.
  private readonly goalChangesInflight = new Set<string>();
  private goalReadAttempted = new Set<string>();
  private goalReadInflight = new Map<string, Promise<void>>();
  private goalObservationInflight = new Map<string, {
    connection: string; version: number; timeoutMs: number; trace: GoalDiagnosticTrace;
    task: Promise<{ raw: unknown; version: number }>;
  }>();
  private completedTurnIds = new Map<string, string>();
  private queuedDrainInflight = new Map<string, Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly turnWorker: TurnWorker;
  private assistantProjections = new Map<string, Set<Promise<void>>>();
  private toolStartedAt = new Map<string, number>();
  private toolCallText = new Map<string, string>();
  private toolOutput = new Map<string, string>();
  private loadedThreadIds = new Set<string>();
  private unmaterializedThreadIds = new Set<string>();
  private threadModels = new Map<string, string>();
  private threadModelOverrides = new Map<string, string>();
  private threadEfforts = new Map<string, string>();
  private threadsWithStickyEffort = new Set<string>();
  private compactWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout;
    check: () => void; evidence: CompactionEvidence; accepting: boolean; previousRunId?: string }>();
  private activeSecretFiles = new Map<string, { commandId: string; connectionId?: string; directory: string; dispatched: boolean }>();
  private preparingSecretFiles = new Map<string, Promise<void>>();
  private ownedCredentialPreparations = new Map<string, Promise<void>>();
  private ownedHistoryPreparations = new Map<string, Promise<void>>();
  private cleaningSecretFiles = new Map<string, Promise<void>>();
  private completingTurns = new Map<string, Promise<void>>();
  private refreshInflight: Promise<void> | undefined;
  private threadRefreshInflight = new Map<string, Promise<void>>();
  // Covers the initial owner read as well as native projection. Keep this
  // independent of native deduplication: completion joins must not self-join.
  private readonly historyRefreshDrains = new Set<Promise<void>>();
  private readonly displayHistory = new Map<string, CodexDisplayHistory>();
  private threadRefreshResult = new Map<string, { at: number; available: boolean; readOnly?: boolean; liveTurnId?: string; terminalIdentity?: string | undefined; recoveryAt?: number;
    display?: CodexDisplayHistory;
    coldFailure?: { at: number; revision: number; connectionId: string; current: () => boolean } }>();
  private maintenanceHistoryRecovery = new Set<string>();
  private rolloutlessHistoryRecovered = new Set<string>();
  private refreshedAt = 0;
  private readonly nativeObservations: CodexNativeObservations;
  private nativeConnectionGeneration = 0;
  private readonly subagentTracker = new CodexSubagentLiveTracker((parentSessionKey, anchorMessageId, _childId, now) => {
    if (this.closed) return;
    const current = this.options.store.getMessage(parentSessionKey, anchorMessageId);
    if (!current?.codexSubagent) return;
    const nextObservation = this.subagentTracker.applyToObservation(parentSessionKey, current.codexSubagent);
    if (nextObservation === current.codexSubagent) return;
    this.options.store.addMessage({ ...current, codexSubagent: nextObservation, updatedAt: now });
    this.touchProjection(parentSessionKey);
  });

  constructor(private readonly options: CodexAppServerOptions) {
    this.modelProviderEnvironment = Object.freeze(Object.assign(Object.create(null), options.modelProviderEnvironment ?? {}));
    // Validate before allocating readers, native bridges or recovery work.
    // JavaScript callers must obey the same complete-mode boundary as TS.
    if (!options.turnQueue || !options.executions) {
      if (options.turnQueue || options.executions || !options.nativeJournal || !options.startup
        || !options.scheduling || !options.queuedConsumer || !options.historyReader || !options.credentialExecutionReader
        || options.interactions || options.fileIndex || options.tokenUsage || options.fileBoardContext) {
        throw new Error('Worker-owned Codex requires complete async ports and no synchronous database consumers');
      }
    }
    this.nativeObservations = new CodexNativeObservations({ unavailable: () => this.invalidateExecution() });
    if (options.ownedInteractions && (options.interactions || !options.nativeJournal)) throw new Error('Worker interactions require the original native journal and no synchronous interaction store');
    this.interactions = options.interactions || options.ownedInteractions ? new CodexInteractionBridge({ ...(options.interactions ?? options.ownedInteractions!),
      connection: () => this.connectionId,
      // A local veto only; original worker binding checks supply authority.
      execution: key => options.ownedInteractions ? options.nativeJournal!.projection.get(key) : this.legacyExecutions.get(key),
      permitted: (key, actor) => !this.closed && !this.executionUnavailable && this.authorized(key, actor),
      request: (method, params) => this.request(method, params), write: message => this.write(message),
    }) : undefined;
    this.boardTools = new CodexBoardTools(options.boardToolsDirectory);
    this.rolloutReader = new CodexRolloutReader({ indexToolOutputs: true, maxConcurrentScans: 4, ...(options.historyCache ? { cachePolicy: options.historyCache } : {}) });
    if (options.startup && !options.nativeJournal) throw new Error('Worker startup requires the complete native journal');
    if (!!options.scheduling !== !!options.queuedConsumer || options.scheduling && (!options.nativeJournal || !options.startup || !options.historyReader)) {
      throw new Error('Worker scheduling requires original startup, native journal, history reader and complete FIFO consumer');
    }
    if (!options.startup) recoverCodexStartup({ turns: this.legacyTurnQueue, codexExecutions: this.legacyExecutions }, options.queueFile);
    if (options.nativeJournal) options.store.bindCodexExecutionProjection(options.nativeJournal.projection, () => this.connectionId);
    else options.store.bindCodexExecutions(this.legacyExecutions, () => this.connectionId);
    options.store.bindMessageEvictionPolicy(sessionKey => this.canEvictProjectedMessages(sessionKey));
    if (!options.startup) this.loadQueuedTurns();
    this.loadRuntimeOverrides();
    this.turnWorker = new TurnWorker({ queue: options.scheduling ?? this.legacyTurnQueue, runtime: 'codex', isolateRecovery: true,
      additionalSessionPage: async (after, limit, isCurrent) => {
        const connectionId = this.connectionId;
        return readRecoveryPage(after, limit,
          [(cursor, size) => options.scheduling ? options.scheduling.recoveryPage(cursor, size, connectionId)
            : this.legacyExecutions.recoveryPage(cursor, size, connectionId)],
          () => isCurrent() && !this.closed && !this.executionUnavailable && this.connectionId === connectionId);
      },
      reconcile: async (sessionKey) => {
      if (this.executionUnavailable) return;
      const scheduled = options.scheduling ? await options.scheduling.observe(sessionKey) : undefined;
      if (this.closed || this.executionUnavailable || scheduled?.deleted || scheduled?.outcomeUnknown) return;
      // Observation is pure-read. Rejection is a separate current-authority
      // transaction bound to this exact head/version and execution revision;
      // otherwise an unauthorized queued head never reaches the FIFO consumer.
      if (scheduled?.head?.state === 'queued' && !scheduled.head.authorized && scheduled.admissionOpen) {
        const changed = await options.scheduling!.rejectHead({ sessionKey,
          executionRevision: scheduled.execution?.revision ?? null,
          headId: scheduled.head.id, headVersion: scheduled.head.version });
        if (this.closed || this.executionUnavailable) return;
        if (changed) await this.projectOwnedBlockedHead(sessionKey, scheduled.head.id);
        if (this.closed || this.executionUnavailable) return;
      }
      const blocked = scheduled ? !scheduled.head?.authorized : this.blockUnauthorizedHead(sessionKey);
      const pending = scheduled ? scheduled.execution ?? undefined : this.legacyExecutions.get(sessionKey);
      const queuedContinuation = scheduled ? scheduled.head?.state === 'queued' && scheduled.head.authorized
        : !blocked && this.legacyTurnQueue.head<CodexQueuedPayload>('codex', sessionKey)?.state === 'queued';
      const readExecution = () => options.nativeJournal ? this.readExecutionFact(sessionKey)
        : Promise.resolve(this.legacyExecutions.get(sessionKey));
      const running = pending?.runId && pending.phase === 'running' && pending.connectionId === this.connectionId;
      const restarted = pending?.runId && pending.phase === 'unknown' && pending.reason === 'restarted';
      // An unacknowledged, preparing, fenced, or connection-replaced execution
      // has no recoverable native runId and keeps canStart false. Do not spin
      // the queue worker on unloaded terminal-cleanup proof for that fact.
      if (pending && (!pending.runId || pending.preparation
        || (!running && !restarted && (!['completed', 'failed', 'interrupted'].includes(pending.phase) || !!pending.reason)))) return;
      // A successor's authorization cannot prevent read-only reconciliation
      // of its already acknowledged predecessor on the original connection.
      if (blocked && !(pending?.runId && (running || restarted
        || (['completed', 'failed', 'interrupted'].includes(pending.phase) && (pending.sync !== 'current' || pending.nativeHistory?.state === 'blocked'))))) return;
      // Readable protected sessions do not need their potentially huge rollout
      // hydrated on every queue tick. Only a worker recovery advances this
      // deadline: browser reads must not indefinitely postpone cold loading.
      // Native activity invalidates this existing marker and bypasses the delay.
      const readable = this.threadRefreshResult.get(sessionKey);
      // Only failed no-checkpoint cold loading is throttled here. In particular,
      // ordinary sync errors waiting for a terminal's natural exit stay prompt.
      const coldFailure = readable?.coldFailure;
      if (coldFailure && pending?.sync === 'error' && !pending.nativeHistory
        && pending.revision === coldFailure.revision && this.connectionId === coldFailure.connectionId
        && coldFailure.current() && Date.now() >= coldFailure.at
        && Date.now() - coldFailure.at < CODEX_RUNNING_RECOVERY_INTERVAL_MS) return;
      const recoveryIntervalMs = (pending?.nativeHistory?.reason === 'background-work'
        && this.loadedThreadIds.has(this.threadId(sessionKey))
        || pending?.nativeHistory?.reason === 'native-unavailable')
        ? CODEX_BACKGROUND_WORK_RECOVERY_INTERVAL_MS
        : CODEX_RUNNING_RECOVERY_INTERVAL_MS;
      if (!queuedContinuation && pending?.sync === 'current' && pending.nativeHistory?.state === 'blocked'
        && pending.nativeHistory.connectionId === this.connectionId && readable?.available
        && readable.recoveryAt !== undefined
        && Date.now() - readable.recoveryAt < recoveryIntervalMs) {
        if (!blocked && !this.closed) await this.drainQueuedTurn(sessionKey);
        return;
      }
      if (running) {
        await this.ensureStarted();
        if (this.closed || this.executionUnavailable || pending.connectionId !== this.connectionId
          || (await readExecution())?.revision !== pending.revision) return;
      }
      // A maintenance-certified terminal already has its complete projected
      // history. Re-reading a missing rollout here would re-fence the session
      // before its preserved successor can start.
      if (this.rolloutlessHistoryRecovered.has(sessionKey) && pending?.sync === 'current') {
        if (!blocked && !this.closed) await this.drainQueuedTurn(sessionKey);
        if ((await readExecution())?.commandId !== pending.commandId) {
          this.rolloutlessHistoryRecovered.delete(sessionKey);
        }
        return;
      }
      // Reuse the existing read coalescer/cache and worker: no second timer or
      // per-run polling map. Terminal notifications bypass this recovery delay.
      const queuedInput = scheduled ? undefined : this.legacyTurnQueue.head<CodexQueuedPayload>('codex', sessionKey);
      const continuation = scheduled?.head?.authorized ? { headId: scheduled.head.id, headVersion: scheduled.head.version } : null;
      const userContinuation = scheduled ? !!continuation : !blocked && queuedInput?.state === 'queued'
        && this.authorized(sessionKey, queuedInput.payload.actorId, queuedInput.payload.executionGrant);
      if (continuation && !await options.scheduling!.recheck({ sessionKey,
        executionRevision: pending?.revision ?? null, ...continuation })) return;
      if (this.closed || this.executionUnavailable) return;
      const coldActivity = pending?.sync === 'error' && !pending.nativeHistory && pending.runId
        && !pending.preparation && !pending.reason && ['completed', 'failed'].includes(pending.phase)
        ? this.nativeHistoryActivityGuard(this.threadId(sessionKey)) : undefined;
      const coldConnection = this.connectionId;
      const canFastVerifyBlockedDisplay = (candidate: CodexExecution | undefined) => !userContinuation
        && !this.threadRefreshInflight.has(sessionKey)
        && !!candidate?.runId && !candidate.preparation && !candidate.reason
        && ['completed', 'failed', 'interrupted'].includes(candidate.phase)
        && candidate.sync === 'current' && candidate.nativeHistory?.state === 'blocked'
        && this.threadRefreshResult.get(sessionKey)?.available === true
        && !!this.threadRefreshResult.get(sessionKey)?.display;
      const skipRehydrateBeforeReconcile = canFastVerifyBlockedDisplay(pending)
        && (pending?.nativeHistory?.reason === 'goal-blocked' || this.loadedThreadIds.has(this.threadId(sessionKey)));
      if (!skipRehydrateBeforeReconcile) {
        const checkContinuation = () => {
          if (scheduled) {
            if (this.closed || this.executionUnavailable) throw new RunControlConflict();
            return; // prepare/begin recheck current worker authority + exact FIFO.
          }
          if (!userContinuation) return;
          const head = this.legacyTurnQueue.head<CodexQueuedPayload>('codex', sessionKey);
          if (head?.id !== queuedInput!.id || head.state !== 'queued'
            || !this.authorized(sessionKey, head.payload.actorId, head.payload.executionGrant)) throw new TurnAuthorizationError();
        };
        try {
          await this.rehydrateCheckpointThread(sessionKey, checkContinuation, userContinuation, continuation);
          if (userContinuation) await this.loadFailedContinuation(sessionKey, checkContinuation, continuation);
        } catch (error) {
          // A failed read is never execution evidence. Record scheduling metadata
          // only if the exact fact and native activity are still unchanged.
          if (coldActivity?.current() && coldConnection && coldConnection === this.connectionId
            && !this.closed && !this.executionUnavailable
            && (await readExecution())?.revision === pending?.revision) {
            const cached = this.threadRefreshResult.get(sessionKey);
            this.threadRefreshResult.set(sessionKey, { at: Date.now(), available: false, ...cached,
              coldFailure: { at: Date.now(), revision: pending!.revision,
                connectionId: coldConnection, current: coldActivity.current } });
            this.goalDiagnostics.trace(sessionKey, coldConnection, 'recovery')('terminal_recovery_failed', { version: pending!.revision });
          }
          throw error;
        }
      }
      const beforeRefresh = await readExecution();
      if (this.closed || this.executionUnavailable) return;
      const finalizationOwnsHistory = beforeRefresh?.runId && beforeRefresh.completedAt !== undefined && beforeRefresh.sync === 'syncing'
        && beforeRefresh.connectionId === this.connectionId && !beforeRefresh.nativeHistory
        && this.loadedThreadIds.has(this.threadId(sessionKey))
        && ['completed', 'failed', 'interrupted'].includes(beforeRefresh.phase)
        && !this.maintenanceHistoryRecovery.has(sessionKey);
      const skipRefreshBeforeReconcile = canFastVerifyBlockedDisplay(beforeRefresh) || finalizationOwnsHistory;
      if (!skipRefreshBeforeReconcile) {
        // Hydration is a read, not permission to resume native work. In
        // particular a cold terminal with no checkpoint may still have a
        // blocked Goal. Let final reconciliation record that execution fence;
        // rehydrateCheckpointThread owns any later authorized native load.
        await this.refreshSession(sessionKey, { maxAgeMs: running || restarted ? CODEX_RUNNING_RECOVERY_INTERVAL_MS : 0,
          readOnly: !!beforeRefresh && ['completed', 'failed', 'interrupted'].includes(beforeRefresh.phase) });
      }
      const fact = skipRefreshBeforeReconcile ? beforeRefresh : await readExecution();
      if (this.closed || this.executionUnavailable) return;
      if (fact?.runId && ['completed', 'failed', 'interrupted'].includes(fact.phase)
        && (fact.sync !== 'current' || fact.nativeHistory?.state === 'blocked')) {
        this.reconcileCompletedTurn(sessionKey, this.threadId(sessionKey), fact.completedAt!, fact.runId, fact.phase as 'completed' | 'failed' | 'interrupted');
        await this.completingTurns.get(sessionKey);
      }
      const recovered = this.threadRefreshResult.get(sessionKey);
      if (recovered?.available) recovered.recoveryAt = Date.now();
      if (!blocked && !this.closed) await this.drainQueuedTurn(sessionKey);
    } });
  }

  get enabled() { return this.options.enabled; }
  get interactionReady() { return this.nativeQuestionsSupported && this.enabled && !this.closed && !this.executionUnavailable && !!this.connectionId; }
  /** Explicit bootstrap barrier, not process startup. A failed import is
   * latched; neither later callers nor automatic recovery may replay it. */
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex App Server closed'));
    if (!this.enabled || !this.options.startup) return Promise.resolve();
    if (!this.initializing) {
      const work = Promise.resolve().then(() => {
        if (this.closed || this.executionUnavailable) throw new Error('Codex startup unavailable');
        return this.options.startup!.open();
      }).then(() => {
        if (this.closed || this.executionUnavailable) throw new Error('Codex startup unavailable');
      }, error => { this.invalidateExecution(); throw error; });
      // Capture physical completion before exposing the Promise to callers.
      this.initializationDrain = work.then(() => {}, () => {});
      this.initializing = work;
    }
    return this.initializing;
  }
  startQueueWorker() {
    if (!this.enabled || this.closed) return;
    if (!this.options.startup) { this.turnWorker.start(); return; }
    void this.ready().then(() => {
      if (!this.closed && !this.executionUnavailable) this.turnWorker.start();
    }, () => this.invalidateExecution());
  }
  pauseQueueWorker() { return this.turnWorker.pause(); }

  async requestSessionRecovery(sessionKey: string, expectedRunId: string) {
    const connection = this.connectionId;
    if (!connection || this.closed || this.executionUnavailable) return false;
    const observed = await this.readHistoryFact(sessionKey);
    if (this.closed || this.executionUnavailable || connection !== this.connectionId
      || observed.deleted || observed.execution?.runId !== expectedRunId) return false;
    const readable = this.threadRefreshResult.get(sessionKey);
    if (readable) {
      delete readable.recoveryAt;
      delete readable.coldFailure;
    }
    return this.turnWorker.wake();
  }

  /** Owner-authorized cleanup for terminals still running after a finished turn.
   * Never interrupts a running/successor turn or touches unattributed terminals;
   * queue protection still clears only through normal worker reconciliation. */
  async stopOwnedBackgroundTerminals(sessionKey: string, expectedRunId: string) {
    const connection = this.connectionId;
    if (!connection || this.closed || this.executionUnavailable || !expectedRunId) return false;
    const initial = await this.readHistoryFact(sessionKey);
    const fact = initial.execution;
    const validFact = (observed: typeof initial) => {
      const current = observed.execution;
      return !observed.deleted && !observed.outcomeUnknown && !!current && !current.preparation
        && current.commandId === fact?.commandId && current.runId === expectedRunId
        && current.connectionId === connection
        && ['completed', 'failed', 'interrupted'].includes(current.phase)
        && current.nativeHistory?.state === 'blocked'
        && current.nativeHistory.reason === 'background-work'
        && current.nativeHistory.turnId === expectedRunId
        && current.nativeHistory.connectionId === connection;
    };
    if (!validFact(initial)) return false;
    const threadId = this.threadId(sessionKey);
    const activity = this.nativeHistoryActivityGuard(threadId);
    const check = async () => {
      if (this.closed || this.executionUnavailable || connection !== this.connectionId || !activity.current()) throw new RunControlConflict();
      const latest = await this.readHistoryFact(sessionKey);
      if (this.closed || this.executionUnavailable || connection !== this.connectionId || !activity.current() || !validFact(latest)) {
        throw new RunControlConflict();
      }
    };
    try {
      await check();
      const thread = historyThread(await activity.request('thread/read', { threadId, includeTurns: true }), threadId);
      await check();
      const latestTurn = arrayValue(thread.turns).at(-1);
      if (thread.status?.type !== 'idle' || latestTurn?.id !== expectedRunId || latestTurn.status !== fact!.phase) return false;
      const itemIds = new Set<string>([
        ...arrayValue(latestTurn.items).filter(item => item.type === 'commandExecution').map(item => String(item.id)),
        ...(fact!.pendingCommandTools ?? []),
      ]);
      await terminateBackgroundTerminals(activity.request, threadId, () => new Set(itemIds), check);
      await check();
      const readable = this.threadRefreshResult.get(sessionKey);
      if (readable) {
        delete readable.recoveryAt;
        delete readable.coldFailure;
      }
      void this.turnWorker.wake();
      return true;
    } catch {
      return false;
    }
  }

  /** History-only recovery under the caller's maintenance fence. Unlike the
   * queue worker, this never authorizes, drains or starts a successor turn.
   */
  recoverMaintenanceHistory(sessionKey: string, check: () => void) {
    return this.trackMaintenance(this.recoverMaintenanceHistoryWork(sessionKey, check));
  }

  /** Same complete recovery, with fresh worker authority at native transport.
   * No async callback is passed to an original synchronous effect guard. */
  recoverMaintenanceHistoryAsync(sessionKey: string, authority: CodexMaintenanceRecoveryAuthority) {
    return this.withMaintenanceRecovery(authority, local => this.recoverMaintenanceHistoryWork(sessionKey, local));
  }

  refreshMaintenanceSessionsAsync(authority: CodexMaintenanceRecoveryAuthority) {
    return this.withMaintenanceRecovery(authority, () => this.refreshSessions({ maxAgeMs: 0 }));
  }

  refreshMaintenanceSessionAsync(sessionKey: string, authority: CodexMaintenanceRecoveryAuthority) {
    return this.withMaintenanceRecovery(authority, local =>
      this.refreshSessionWithAuthority(sessionKey, { maxAgeMs: 0, fresh: true }, local));
  }

  private withMaintenanceRecovery<T>(authority: CodexMaintenanceRecoveryAuthority, action: (local: () => void) => Promise<T>) {
    const scope = { ...authority, resumes: { ...authority.resumes }, active: true };
    const local = () => {
      if (!scope.active || this.closed || this.executionUnavailable) throw new RunControlConflict();
      synchronousEffectAuthority(scope.local, () => new RunControlConflict());
    };
    const work = this.maintenanceRecovery.run(scope, async () => {
      try {
        local(); await scope.authorize(); local();
        const value = await action(local);
        local(); await scope.authorize(); local();
        return value;
      } finally { scope.active = false; }
    });
    return this.trackMaintenance(work);
  }

  private async authorizeMaintenanceRecovery() {
    const scope = this.maintenanceRecovery.getStore();
    if (!scope) return;
    const local = () => {
      if (!scope.active || this.closed || this.executionUnavailable) throw new RunControlConflict();
      synchronousEffectAuthority(scope.local, () => new RunControlConflict());
    };
    local(); await scope.authorize(); local();
  }

  private trackMaintenance<T>(work: Promise<T>): Promise<T> {
    // Retain an unexposed physical drain: replacing a caller's Promise methods
    // must not let close release the database while recovery is still running.
    const done = () => { this.maintenanceDrains.delete(drain); };
    const drain = work.then(done, done);
    this.maintenanceDrains.add(drain);
    return work;
  }

  private async recoverMaintenanceHistoryWork(sessionKey: string, check: () => void) {
    if (this.closed) throw new Error('Codex App Server closed');
    synchronousEffectAuthority(check, () => new RunControlConflict());
    const initial = await this.readHistoryFact(sessionKey);
    if (this.options.nativeJournal) synchronousEffectAuthority(check, () => new RunControlConflict());
    if (initial.deleted) return;
    if (initial.outcomeUnknown) throw new RunControlConflict();
    const fact = initial.execution;
    if (!fact?.runId || fact.preparation || fact.reason
      || !['completed', 'failed', 'interrupted'].includes(fact.phase)
      || (!['syncing', 'error'].includes(fact.sync) && !fact.nativeHistory)) {
      throw new Error('Maintenance recovery requires a durable terminal');
    }
    const connection = this.connectionId, child = this.child, generation = this.nativeConnectionGeneration;
    const local = () => {
      synchronousEffectAuthority(check, () => new RunControlConflict());
      if (this.closed || this.executionUnavailable || connection !== this.connectionId
        || child !== this.child || generation !== this.nativeConnectionGeneration) throw new RunControlConflict();
    };
    const currentFact = async () => {
      const observed = await this.readHistoryFact(sessionKey);
      local();
      const current = observed.execution;
      if (observed.deleted || observed.outcomeUnknown || !current || current.commandId !== fact.commandId || current.runId !== fact.runId
        || current.phase !== fact.phase || current.connectionId !== fact.connectionId || current.preparation || current.reason) {
        throw new Error('Maintenance terminal changed');
      }
      return current;
    };
    // Maintenance must use the same native-head ownership contract as ordinary
    // history reconciliation. The older rolloutless recovery below is valid
    // only when the owned run is still the native head; it must never clear a
    // successor checkpoint merely to make readiness pass.
    local();
    const observed = historyThread(await this.request('thread/read', {
      threadId: this.threadId(sessionKey), includeTurns: true,
    }), this.threadId(sessionKey));
    local();
    const before = await currentFact();
    if (before.revision !== fact.revision) throw new RunControlConflict();
    if (fact.nativeHistory || before.nativeHistory || observed.turns.at(-1)?.id !== fact.runId) {
      await this.rehydrateCheckpointThread(sessionKey, local);
      this.reconcileCompletedTurn(sessionKey, this.threadId(sessionKey), fact.completedAt!, fact.runId,
        fact.phase as 'completed' | 'failed' | 'interrupted');
      await this.completingTurns.get(sessionKey);
      local();
      const settled = await currentFact();
      if (settled?.commandId !== fact.commandId || settled.runId !== fact.runId || settled.phase !== fact.phase
        || settled.connectionId !== fact.connectionId || settled.sync !== 'current' || !settled.nativeHistory
        || !this.isSessionHistoryReady(sessionKey)) throw new Error('Maintenance native history unavailable');
      return;
    }
    const rolloutless = fact.sync === 'error' && ['completed', 'failed'].includes(fact.phase);
    const recoveringConnection = this.connectionId;
    if (rolloutless) this.maintenanceHistoryRecovery.add(sessionKey);
    try { await this.refreshSessionWithAuthority(sessionKey, { maxAgeMs: 0 }, local); }
    catch (error) {
      local();
      const current = await currentFact();
      if (!(error instanceof RunControlConflict) || this.closed || this.executionUnavailable
        || recoveringConnection !== this.connectionId || !current?.nativeHistory
        || current.commandId !== fact.commandId || current.connectionId !== fact.connectionId
        || current.runId !== fact.runId || current.phase !== fact.phase || current.preparation || current.reason) throw error;
      await this.recoverMaintenanceHistory(sessionKey, local);
      return;
    }
    finally { if (rolloutless) this.maintenanceHistoryRecovery.delete(sessionKey); }
    local();
    const current = await currentFact();
    if (rolloutless) {
      // Refresh can have installed a successor checkpoint. Never flatten it
      // into a rolloutless success. The ordinary final-history owner proves it.
      if (current.nativeHistory && !resumeProtectionOnly(fact, current)) {
        await this.recoverMaintenanceHistory(sessionKey, local);
        return;
      }
      // A known resume ACK now installs its own blocked checkpoint. Only that
      // exact strengthening belongs to this recovery; prove the current native
      // head/Goal again before replacing it, never clear a successor's fence.
      let checkpoint: NativeHistoryCheckpoint | undefined;
      let settlementCurrent = local;
      if (current.nativeHistory) {
        const activity = this.nativeHistoryActivityGuard(this.threadId(sessionKey));
        const proofCurrent = () => { local(); if (!activity.current()) throw new RunControlConflict(); };
        settlementCurrent = proofCurrent;
        const thread = historyThread(await activity.request('thread/read', {
          threadId: this.threadId(sessionKey), includeTurns: true,
        }), this.threadId(sessionKey));
        proofCurrent();
        checkpoint = await this.inspectNativeHistory(thread, current, proofCurrent, false, false, activity.request);
        proofCurrent();
        if (checkpoint.state !== 'verified' || (await currentFact()).revision !== current.revision)
          throw new RunControlConflict();
      }
      if (this.options.nativeJournal) {
        let accepted: boolean;
        try { accepted = await this.options.nativeJournal.settleHistory(current, 'current', checkpoint); }
        catch { this.invalidateExecution(); throw new RunControlConflict(); }
        if (!accepted) throw new RunControlConflict();
        try { settlementCurrent(); }
        catch (error) {
          // A physical COMMIT is not a publication lease. Strengthen protection
          // before returning; no successor dispatch or replay on a lost ACK.
          try { await this.options.nativeJournal.invalidateHistory(sessionKey); }
          catch { this.invalidateExecution(); }
          throw error;
        }
      } else if (!(checkpoint ? this.legacyExecutions.settleNativeHistory(current, checkpoint)
        : this.legacyExecutions.settleHistory(current, 'current'))) throw new RunControlConflict();
      this.rolloutlessHistoryRecovered.add(sessionKey);
      const projected = this.options.store.getSession(sessionKey);
      if (projected?.runtime) {
        const { reason: _reason, ...runtime } = projected.runtime;
        this.publishRun(sessionKey, { ...runtime, turnId: fact.runId, phase: fact.phase,
          connection: this.child ? 'connected' : projected.runtime.connection, sync: 'current', lastEventAt: Date.now() });
      }
    }
    else {
      this.reconcileCompletedTurn(sessionKey, this.threadId(sessionKey), fact.completedAt!, fact.runId,
        fact.phase as 'completed' | 'failed' | 'interrupted');
      await this.completingTurns.get(sessionKey);
    }
    local();
    const settled = await currentFact();
    if (settled?.commandId !== fact.commandId || settled.runId !== fact.runId || settled.phase !== fact.phase
      || settled.sync !== 'current' || !this.isSessionHistoryReady(sessionKey)) throw new Error('Maintenance terminal history unavailable');
  }

  /** Observes only the owned native process; never starts/resumes an Agent. */
  inspectMaintenance(checkAuthority: () => void = () => {}, deadline = Date.now() + 4000) {
    return this.trackMaintenance(this.inspectMaintenanceWork(checkAuthority, deadline));
  }

  /** Worker authority is explicitly awaited; the synchronous callback here
   * checks ONLY caller-owned local state, never a cached permission grant. */
  inspectMaintenanceAsync(authorize: () => Promise<void>, assertLocal: () => void, deadline = Date.now() + 4000) {
    return this.trackMaintenance(this.inspectMaintenanceWork(assertLocal, deadline, authorize));
  }

  private async inspectMaintenanceWork(checkAuthority: () => void, deadline: number, authorize?: () => Promise<void>) {
    if (this.options.startup) await this.ready();
    const epoch = this.maintenanceEpoch, child = this.child, connection = this.connectionId,
      generation = this.nativeConnectionGeneration;
    const check = () => {
      synchronousEffectAuthority(checkAuthority, () => new RunControlConflict());
      if (authorize && Date.now() >= deadline) throw new Error('Native maintenance inspection timed out');
      if (this.closed || this.executionUnavailable || this.starting || epoch !== this.maintenanceEpoch
        || generation !== this.nativeConnectionGeneration
        || child !== this.child || connection !== this.connectionId
        || this.childLifetimes.size !== (child ? 1 : 0)
        || (child && (!connection || !this.childLifetimes.has(child)))) {
        throw new Error('Codex maintenance observation changed or is unavailable');
      }
    };
    const authorized = async () => {
      check();
      await authorize!();
      check();
    };
    check();
    if (authorize) await authorized();
    // Reuse the original exhaustive native algorithm. Its synchronous guard
    // remains local; every actual RPC waits current worker authority on both
    // sides, recomputing the original deadline after that wait.
    const request = authorize ? async (method: string, params: unknown, timeoutMs?: number) => {
      await authorized();
      check();
      const result = await this.request(method, params, Math.min(timeoutMs ?? Infinity, deadline - Date.now()));
      await authorized();
      check();
      return result;
    } : this.request.bind(this);
    const native = child
      ? await inspectCodexMaintenance(request, check, deadline, this.unmaterializedThreadIds)
      : { loadedThreads: 0, activeRuns: 0, backgroundTerminals: 0 };
    check();
    if (authorize) await authorized();
    check();
    const durable = this.options.nativeJournal ? await this.options.nativeJournal.readMaintenance()
      : { pendingExecutions: this.legacyExecutions.maintenancePending(), queuedMessages: this.legacyTurnQueue.maintenanceCount('codex') };
    if (authorize) await authorized();
    check();
    return { ...native, assertCurrent: check, ...durable,
      inFlightWrites: this.pending.size + this.authorizingEffects.size + this.nativeObservations.status().pending + this.boardTools.inFlight + this.activeTurnIds.size + this.completingTurns.size
        + this.queuedDrainInflight.size + this.compactWaiters.size + this.historyRefreshDrains.size
        + this.preparingSecretFiles.size + this.cleaningSecretFiles.size + this.ownedCredentialPreparations.size + this.ownedHistoryPreparations.size
        + Number(Boolean(this.refreshInflight))
        + [...this.assistantProjections.values()].reduce((sum, tasks) => sum + tasks.size, 0) };
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.closeRuntime();
    }
    return this.closing;
  }

  private async closeRuntime() {
    const boardClosed = this.boardTools.close();
    const toolImagesClosed = this.toolImageRelay?.close();
    this.child = undefined;
    this.setConnection(undefined);
    const observationsClosed = this.nativeObservations.close();
    this.loadedThreadIds.clear();
    this.activeTurnIds.clear();
    this.clearTransientBuffers();
    this.rejectAll(new Error('Codex App Server closed'));
    // Retired children still own native work. Signal before awaiting startup,
    // which may itself be waiting for a retired child to actually close.
    for (const child of this.childLifetimes.keys()) this.stopChild(child);
    // Settle queue bookkeeping before the owning Connector closes SQLite.
    // Closed guards prevent waiting sends/completions from launching more work.
    await Promise.allSettled([
      boardClosed,
      toolImagesClosed,
      observationsClosed,
      this.providerModelCatalog.close(),
      this.initializationDrain,
      this.options.startup?.close(),
      this.options.queuedConsumer?.close(),
      ...this.maintenanceDrains,
      ...this.authorizingEffects,
      ...this.goalAcknowledgementDrains,
      this.options.historyReader?.close(),
      this.turnWorker.close(),
      ...this.queuedDrainInflight.values(),
      ...this.completingTurns.values(),
      ...Array.from(this.assistantProjections.values()).flatMap(tasks => [...tasks]),
      ...this.threadRefreshInflight.values(), this.refreshInflight, this.starting,
      ...this.historyRefreshDrains,
      ...this.preparingSecretFiles.values(),
      ...this.ownedCredentialPreparations.values(),
      ...this.ownedHistoryPreparations.values(),
      ...Array.from(this.childLifetimes.values(), lifetime => lifetime.closed),
    ]);
    await Promise.all([...this.activeSecretFiles.keys()].map(sessionKey => this.cleanupSecretFiles(sessionKey, true)));
    await this.rolloutReader.close();
  }
  owns(sessionKey: string) { return sessionKey.startsWith('codex:'); }

  private goalControlGuard(sessionKey: string, authorize: () => void) {
    const connection = this.connectionId;
    const check = () => {
      synchronousEffectAuthority(authorize, () => new GoalControlConflict());
      if (!connection || this.closed || !this.enabled || this.executionUnavailable
        || this.connectionId !== connection || !this.owns(sessionKey) || !this.options.store.getSession(sessionKey)) throw new GoalControlConflict();
    };
    check();
    return { connection: connection!, check };
  }

  async readGoalControl(sessionKey: string, authorize: () => void): Promise<GoalControlSnapshot> {
    return (await this.readGoalControlObservation(sessionKey, authorize)).snapshot;
  }

  private async readGoalControlObservation(sessionKey: string, authorize: () => void) {
    // Opening a control panel cannot start/load native work or repair a session.
    const { connection, check } = this.goalControlGuard(sessionKey, authorize);
    const { raw, version } = await this.observeGoal(sessionKey, 10_000);
    check();
    if (version !== this.goalObservationVersions.get(sessionKey)) throw new GoalControlConflict();
    return { snapshot: goalSnapshot(raw, this.threadId(sessionKey), connection), version };
  }

  async changeGoal(sessionKey: string, input: GoalControl, authorize: () => void, begin: () => void, acknowledge: () => void) {
    return this.changeGoalInternal(sessionKey, input, authorize, begin, acknowledge);
  }

  /** Original native writer with awaited durable worker boundaries. */
  async changeGoalOwned(sessionKey: string, input: GoalControl, local: () => void,
    begin: () => Promise<void>, acknowledge: () => Promise<void>) {
    return this.changeGoalInternal(sessionKey, input, local, begin, acknowledge, true);
  }

  private async changeGoalInternal(sessionKey: string, input: GoalControl, authorize: () => void,
    begin: (() => void) | (() => Promise<void>), acknowledge: (() => void) | (() => Promise<void>), owned = false) {
    const control = readGoalControl(input);
    const trace = this.goalDiagnostics.trace(sessionKey, this.connectionId, control?.action ?? 'invalid');
    trace('change_started');
    let stage: 'preflight_failed' | 'prewrite_failed' | 'outcome_unknown' | 'post_ack_failed' = 'preflight_failed';
    let acquired = false;
    try {
      if (!control) throw new GoalControlConflict();
      const { connection, check } = this.goalControlGuard(sessionKey, authorize);
      if (this.goalChangesInflight.has(sessionKey)) {
        trace('local_write_conflict');
        throw new GoalControlConflict();
      }
      this.goalChangesInflight.add(sessionKey);
      acquired = true;
      const { snapshot: before, version } = await this.readGoalControlObservation(sessionKey, check);
      check();
      const threadId = this.threadId(sessionKey), mutation = goalMutation(control, before, threadId);
      let acknowledged = false, acceptance: Promise<void> | undefined;
      const accept = (raw: unknown): void | Promise<void> => {
        if (acknowledged) return acceptance;
        if (!goalAcknowledged(raw, control, threadId)) {
          trace('ack_invalid');
          throw new Error('Goal acknowledgement unavailable');
        }
        acknowledged = true;
        if (owned) return acceptance = (async () => {
          try { await acknowledge(); }
          catch (error) { trace('ack_persist_failed'); throw error; }
          trace('ack_persisted');
        })();
        try { synchronousEffectAuthority(acknowledge); }
        catch (error) { trace('ack_persist_failed'); throw error; }
        trace('ack_persisted');
      };
      stage = 'prewrite_failed';
      const current = () => {
        check();
        if (version !== this.goalObservationVersions.get(sessionKey)) {
          trace('read_conflict', { version, currentVersion: this.goalObservationVersions.get(sessionKey) });
          throw new GoalControlConflict();
        }
      };
      const receipt: GoalWriteReceipt = { trace, acknowledge: accept, beforeWrite: () => {
        current();
        if (!owned) {
          synchronousEffectAuthority(begin);
          stage = 'outcome_unknown';
        }
      } };
      const raw = owned ? await this.requestAuthorized(mutation.method, mutation.params, async () => {
        current();
        if (this.goalWriteReceipts.size >= GOAL_ACK_CAPACITY) throw new GoalControlConflict();
        await begin();
        stage = 'outcome_unknown';
      }, current, undefined, current, receipt) : await this.request(mutation.method, mutation.params, undefined, receipt);
      // ACK from the original connection is evidence even if the reader was
      // revoked/disconnected. Persist it before projection, never resend on error.
      await accept(raw);
      stage = 'post_ack_failed';
      if (!this.closed && connection === this.connectionId && version === this.goalObservationVersions.get(sessionKey)) {
        this.projectGoal(sessionKey, control.action === 'clear' ? { goal: null } : raw, threadId);
      } else trace('projection_skipped');
      if (!this.closed && !this.executionUnavailable && connection === this.connectionId) {
        const readable = this.threadRefreshResult.get(sessionKey);
        if (readable) delete readable.recoveryAt;
        this.turnWorker.wake();
      }
    } catch (error) {
      if (error instanceof GoalControlConflict) trace('control_conflict');
      trace(stage);
      throw error;
    } finally {
      if (acquired) this.goalChangesInflight.delete(sessionKey);
    }
  }

  private modelCatalogCache: { at: number; models: ModelChoice[] } | undefined;
  private readonly providerModelCatalog = new ProviderModelCatalog();
  private readonly skillsCache = new SessionSkillsCache();
  async listSessionSkills(sessionKey: string) {
    if (this.closed || !this.enabled || !this.owns(sessionKey) || !this.options.store.getSession(sessionKey)) throw new Error('Codex session unavailable');
    await this.ensureStarted();
    const connection = this.connectionId;
    const check = () => {
      if (this.closed || connection !== this.connectionId || !this.options.store.getSession(sessionKey)) throw new Error('Codex session changed');
    };
    const value = await this.skillsCache.read(JSON.stringify([connection, sessionKey]), async () => {
      check();
      const threadId = this.threadId(sessionKey);
      const response = await this.request('thread/read', { threadId, includeTurns: false });
      check();
      const thread = response?.thread;
      if (thread?.id !== threadId || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)
        || thread.cwd.length > 4096) throw new Error('Native thread directory unavailable');
      const result = await this.request('skills/list', { cwds: [thread.cwd], forceReload: false });
      check();
      return projectSkills(result, thread.cwd);
    });
    check();
    return value;
  }
  private modelCatalogInflight: Promise<ModelChoice[]> | undefined;
  async listModels(): Promise<ModelChoice[]> {
    if (this.closed) throw new Error('Codex App Server closed');
    if (this.modelCatalogInflight) return this.modelCatalogInflight;
    this.modelCatalogInflight = (async () => {
      await this.ensureStarted();
      const connection = this.connectionId;
      const config = await this.request('config/read', { includeLayers: false, cwd: null });
      const provider = configuredModelProvider(config, this.options.modelProvider, this.effectiveModelProviderEnvironment());
      const check = () => { if (this.closed || connection !== this.connectionId) throw new Error('Codex model catalog changed'); };
      check();
      if (provider) { const models = await this.providerModelCatalog.read(provider); check(); return models; }
      if (this.modelCatalogCache && Date.now() - this.modelCatalogCache.at < 60_000) return structuredClone(this.modelCatalogCache.models);
      const models = await readModelCatalog(params => this.request('model/list', params));
      check();
      this.modelCatalogCache = { at: Date.now(), models };
      return models;
    })().finally(() => { this.modelCatalogInflight = undefined; });
    return this.modelCatalogInflight;
  }

  isSessionListReady() { return !this.enabled || (!this.closed && this.refreshedAt > 0 && !this.refreshInflight); }

  isSessionHistoryReady(sessionKey: string) {
    return !this.closed && !this.threadRefreshInflight.has(sessionKey) && !this.completingTurns.has(sessionKey)
      && this.threadRefreshResult.get(sessionKey)?.available === true && this.options.store.hasMessages(sessionKey);
  }

  memoryDiagnostics() {
    return {
      rolloutCache: this.rolloutReader.cacheStats(),
      warmHistorySessions: this.threadRefreshResult.size,
      displayHistorySessions: this.displayHistory.size,
      loadedThreads: this.loadedThreadIds.size,
      threadRefreshInflight: this.threadRefreshInflight.size,
      activeTurns: this.activeTurnIds.size,
    };
  }

  private canEvictProjectedMessages(sessionKey: string): boolean {
    if (!this.owns(sessionKey) || this.closed || this.executionUnavailable) return false;
    if (this.threadRefreshInflight.has(sessionKey) || this.completingTurns.has(sessionKey)
      || this.activeTurnIds.has(sessionKey) || this.queueHistoryLeases.has(sessionKey)
      || this.ownedHistoryPreparations.has(sessionKey) || this.maintenanceHistoryRecovery.has(sessionKey)
      || this.rolloutlessHistoryRecovered.has(sessionKey)) return false;
    if (this.threadRefreshResult.get(sessionKey)?.available !== true) return false;
    try {
      const fact = this.options.nativeJournal
        ? this.options.nativeJournal.projection.get(sessionKey)
        : this.legacyExecutions.get(sessionKey);
      if (fact) {
        if (fact.preparation || fact.reason || fact.sync !== 'current'
          || !['completed', 'failed', 'interrupted'].includes(fact.phase)) return false;
      }
      if (!this.options.nativeJournal && this.legacyTurnQueue.list('codex', sessionKey).length > 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Read-only automation admission proof. Never starts/hydrates the native
   * process or treats an absent execution record as positive idle evidence.
   * The normal worker still rechecks native history/Goal before dispatch. */
  automationObservation(sessionKey: string, actorId: string) {
    if (this.options.nativeJournal) throw new Error('Owned automation requires worker authority and local observation');
    const now = Date.now(), session = this.options.store.getSession(sessionKey);
    const online = !!this.connectionId && this.automationConnectedSince > 0 && this.enabled
      && !this.closed && !this.executionUnavailable && !this.starting && this.owns(sessionKey) && !!session;
    const fact = online ? this.legacyExecutions.get(sessionKey) : undefined;
    const goal = session?.codexGoal;
    // Revalidate the projected shape as well; a partial/malformed `complete`
    // observation must not release any safety fence.
    const parsedGoal = goal === null ? null : readCodexGoal({ goal: { ...goal, threadId: this.threadId(sessionKey) } }, this.threadId(sessionKey));
    const idle = online && this.isSessionHistoryReady(sessionKey) && !!fact
      && fact.nativeHistory?.state === 'verified' && fact.nativeHistory.connectionId === this.connectionId
      && this.legacyExecutions.canStart(sessionKey) && (parsedGoal === null || parsedGoal?.status === 'complete')
      && !this.activeTurnIds.has(sessionKey) && !this.goalChangesInflight.has(sessionKey)
      && !this.goalReadInflight.has(sessionKey) && !this.goalObservationInflight.has(sessionKey);
    return { now, connectedSince: this.automationConnectedSince, online, idle,
      admissionAllowed: online && this.authorized(sessionKey, actorId) };
  }

  takeAutomationCompletions(actorId: string) {
    if (this.options.nativeJournal) throw new Error('Owned automation requires worker completion settlement');
    return this.automationCompletions.take(actorId, this.connectionId, Date.now(),
      key => this.legacyExecutions.get(key), key => {
        const view = this.automationObservation(key, actorId);
        return view.idle && view.admissionAllowed;
      });
  }

  /** Negative local evidence only. Current authority, deletion, maintenance,
   * pending resume and FIFO admission MUST still be checked by the worker. */
  ownedAutomationObservation(sessionKey: string) {
    if (!this.options.nativeJournal) throw new Error('Owned automation requires the original native journal');
    const now = Date.now(), session = this.options.store.localCodexAutomationObservation(sessionKey);
    const online = !!this.connectionId && this.automationConnectedSince > 0 && this.enabled
      && !this.closed && !this.executionUnavailable && !this.starting && this.owns(sessionKey) && !!session;
    let fact: CodexExecution | undefined;
    try { if (online) fact = this.options.nativeJournal.projection.get(sessionKey); }
    catch { /* An unavailable/stale projection cannot yield positive idle evidence. */ }
    const goal = session?.codexGoal;
    const parsedGoal = goal === null ? null : readCodexGoal({ goal: { ...goal, threadId: this.threadId(sessionKey) } }, this.threadId(sessionKey));
    const idle = online && this.isSessionHistoryReady(sessionKey) && !!fact?.runId
      && ['completed', 'failed', 'interrupted'].includes(fact.phase) && fact.sync === 'current'
      && !fact.reason && !fact.preparation
      && fact.nativeHistory?.state === 'verified' && fact.nativeHistory.turnId === fact.runId
      && fact.nativeHistory.connectionId === this.connectionId && fact.connectionId === this.connectionId
      && (parsedGoal === null || parsedGoal?.status === 'complete')
      && !this.activeTurnIds.has(sessionKey) && !this.goalChangesInflight.has(sessionKey)
      && !this.goalReadInflight.has(sessionKey) && !this.goalObservationInflight.has(sessionKey);
    return { now, connectedSince: this.automationConnectedSince, online, idle };
  }

  takeOwnedAutomationCompletions(actorId: string) {
    if (!this.options.nativeJournal) throw new Error('Owned automation requires the original native journal');
    return this.automationCompletions.take(actorId, this.connectionId, Date.now(), key => {
      try { return this.options.nativeJournal!.projection.get(key); }
      catch { return undefined; }
    }, key => this.ownedAutomationObservation(key).idle);
  }

  async refreshSessions(options: { maxAgeMs?: number } = {}) {
    if (!this.enabled) return;
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (this.refreshInflight) return this.refreshInflight;
    if (maxAgeMs > 0 && Date.now() - this.refreshedAt < maxAgeMs) return;
    this.refreshedAt = 0;
    this.refreshInflight = this.restoreSessions().then(connectionId => {
      if (connectionId !== this.connectionId) throw new Error('Codex session list connection changed');
      this.refreshedAt = Date.now();
    }).finally(() => {
      this.refreshInflight = undefined;
    });
    return this.refreshInflight;
  }

  async refreshSession(sessionKey: string, options: HistoryRefreshOptions = {}) {
    return this.refreshSessionWithAuthority(sessionKey, options);
  }

  prepareSessionDisplay(sessionKey: string) {
    return this.trackHistoryRead(async () => {
      const display = this.displayHistory.get(sessionKey);
      if (!display) return;
      const child = this.child;
      const activity = this.nativeHistoryActivityGuard(this.threadId(sessionKey));
      const current = () => {
        try {
          return !this.closed && !this.executionUnavailable && child === this.child
            && this.options.store.hasMessages(sessionKey)
            && this.displayHistory.get(sessionKey) === display && display.activity() && activity.current()
            && display.connection === this.connectionId && display.generation === this.nativeConnectionGeneration
            && display.projection === this.projectionVersion(sessionKey) && !this.activeTurnIds.has(sessionKey)
            && isDeepStrictEqual(display.runtime, this.options.store.getSession(sessionKey)?.runtime)
            && isDeepStrictEqual(display.execution, this.options.nativeJournal
              ? this.options.nativeJournal.projection.get(sessionKey) ?? null : this.legacyExecutions.get(sessionKey) ?? null);
        } catch { return false; }
      };
      const verify = () => this.trackHistoryRead(async () => {
        if (!current()) return false;
        const observed = await this.readHistoryFact(sessionKey);
        if (!current() || observed.deleted || observed.outcomeUnknown || !isDeepStrictEqual(display.execution, observed.execution)) return false;
        if (!await this.rolloutReader.sourceUnchanged(display.source, this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS)) return false;
        const confirmed = await this.readHistoryFact(sessionKey);
        return current() && !confirmed.deleted && !confirmed.outcomeUnknown && isDeepStrictEqual(display.execution, confirmed.execution);
      });
      return await verify() ? { current, verify } : undefined;
    });
  }

  private terminalReadIdentity(sessionKey: string, execution?: CodexExecution | null) {
    const runtime = this.options.store.getSession(sessionKey)?.runtime;
    if (this.closed || this.executionUnavailable || !this.connectionId || runtime?.connection !== 'connected'
      || runtime.sync !== 'current' || !runtime.turnId || !['completed', 'failed', 'interrupted'].includes(runtime.phase)) return;
    const current = execution === undefined
      ? (this.options.nativeJournal ? this.options.nativeJournal.projection.get(sessionKey) : this.legacyExecutions.get(sessionKey))
      : execution;
    return JSON.stringify([this.connectionId, runtime.turnId, runtime.phase, current?.commandId,
      current?.revision, this.projectionVersion(sessionKey)]);
  }

  private trackHistoryRead<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex App Server closed'));
    const task = Promise.resolve().then(operation);
    const release = () => { this.historyRefreshDrains.delete(drain); };
    const drain = task.then(release, release);
    this.historyRefreshDrains.add(drain);
    return task;
  }

  private refreshSessionWithAuthority(sessionKey: string, options: HistoryRefreshOptions,
    checkAuthority?: () => void): Promise<void> {
    // Reserve before the first owner await, even when the caller discards or
    // replaces its public promise. close() drains the captured continuation.
    return this.trackHistoryRead(() => this.refreshSessionOperation(sessionKey, options, checkAuthority));
  }

  private async refreshSessionOperation(sessionKey: string, options: HistoryRefreshOptions,
    checkAuthority?: () => void): Promise<void> {
    const authority = () => {
      if (this.closed) throw new Error('Codex App Server closed');
      if (checkAuthority) synchronousEffectAuthority(checkAuthority, () => new RunControlConflict());
    };
    authority();
    const initial = await this.readHistoryFact(sessionKey);
    authority();
    if (initial.deleted) throw new Error('Codex session was deleted');
    // Completion already owns a fresh, authoritative native read. A concurrent
    // browser refresh must join it, not start a second full-history projection
    // that will be rejected as obsolete and send the browser into backoff.
    const completing = this.completingTurns.get(sessionKey);
    let completionHandoff = false;
    if (completing) {
      const completionConnection = this.connectionId, completionGeneration = this.nativeConnectionGeneration;
      const completionChild = this.child;
      await completing;
      authority();
      const ready = this.isSessionHistoryReady(sessionKey);
      if (!ready) {
        const current = await this.readHistoryFact(sessionKey);
        authority();
        // Failure to certify execution is not failure to display its history.
        // After that owner drains, obtain our own guarded snapshot below.
        // Read eligibility must not depend on whether its settlement left
        // sync:syncing or sync:error. Neither outcome certifies execution;
        // snapshot publication and execution recovery keep their own gates.
        if (!options.readOnly || current.deleted || current.outcomeUnknown || this.executionUnavailable
          || completionConnection !== this.connectionId || completionGeneration !== this.nativeConnectionGeneration
          || completionChild !== this.child
          || initial.execution?.commandId !== current.execution?.commandId
          || initial.execution?.runId !== current.execution?.runId)
          throw new Error('Codex final history unavailable');
        completionHandoff = true;
      }
      // Degraded completion can publish readable successor history while the
      // bound command remains fenced. Maintenance must obtain its own exact
      // latest-turn proof below before it can settle a sync:error execution.
      if (ready && !this.maintenanceHistoryRecovery.has(sessionKey)) {
        if (options.readOnly) await this.hydrateGoal(sessionKey, options.fresh === true);
        return;
      }
    }
    const maxAgeMs = options.maxAgeMs ?? 0;
    const existing = this.threadRefreshInflight.get(sessionKey);
    let joinedFailure = false;
    if (existing) {
      try { await existing; authority(); return; }
      catch (error) {
        authority();
        if (!options.readOnly) throw error;
        // A drained execution-recovery failure is not a failed text read.
        // Obtain our own guarded snapshot; do not reuse its negative cache or
        // retry/resume its native mutation. Original ownership has settled.
        joinedFailure = true;
        // Several browsers may have joined the same failed worker. Only the
        // first owns the replacement read; later waiters join that owner.
        if (this.threadRefreshInflight.has(sessionKey))
          return this.refreshSessionOperation(sessionKey, { ...options, fresh: true }, checkAuthority);
      }
    }
    const cached = this.threadRefreshResult.get(sessionKey);
    if (options.readOnly && !options.fresh && maxAgeMs > 0 && cached?.available && !cached.display && cached.terminalIdentity
      && this.options.store.hasMessages(sessionKey)
      && Date.now() - cached.at < CODEX_RUNNING_RECOVERY_INTERVAL_MS
      && cached.terminalIdentity === this.terminalReadIdentity(sessionKey, initial.execution)) {
      await this.hydrateGoal(sessionKey);
      return;
    }
    // Browser history reads consume the already hydrated, event-updated replica
    // of the SAME connected live turn. They must not rescan an entire rollout
    // every 1.5 seconds while every delta is already being projected. Reconcile
    // at the existing native recovery interval; no new timer and no extension
    // of this deadline by deltas. Lifecycle/maintenance reads never use this path.
    if (options.readOnly && !options.fresh && maxAgeMs > 0 && cached?.available && cached.liveTurnId
      && this.options.store.hasMessages(sessionKey)
      && Date.now() - cached.at < CODEX_RUNNING_RECOVERY_INTERVAL_MS && !this.closed && !this.executionUnavailable && this.connectionId) {
      const runtime = this.options.store.getSession(sessionKey)?.runtime;
      const execution = initial.execution;
      if (runtime?.turnId === cached.liveTurnId && runtime.connection === 'connected' && runtime.sync === 'current'
        && ['running', 'waiting'].includes(runtime.phase)
        && (execution ? execution.phase === 'running' && execution.runId === cached.liveTurnId
          && execution.connectionId === this.connectionId && !execution.preparation
          : this.activeTurnIds.get(sessionKey) === cached.liveTurnId)) {
        await this.hydrateGoal(sessionKey);
        return;
      }
    }
    if (!joinedFailure && !options.fresh && cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs
      && (!cached.readOnly || options.readOnly)
      && (!cached.available || this.options.store.hasMessages(sessionKey))) {
      if (!cached.available) throw new Error('Codex thread snapshot unavailable');
      if (options.readOnly) await this.hydrateGoal(sessionKey);
      return;
    }
    if (options.readOnly) {
      const lease = this.queueHistoryLeases.get(sessionKey);
      if (lease) {
        await lease;
        authority();
        return this.refreshSessionOperation(sessionKey, options, checkAuthority);
      }
    }
    this.threadRefreshResult.delete(sessionKey);
    const recoveryActivity = this.nativeHistoryActivityGuard(this.threadId(sessionKey));
    let connectionId = this.connectionId;
    let liveTurnId: string | undefined;
    let obsolete = false;
    let readStage = 'startup';
    let failureCurrent = () => false;
    let publicationCurrent = () => false;
    let failureCacheCurrent = () => false;
    let refreshFact: (() => Promise<void>) | undefined;
    let display: CodexDisplayHistory | undefined;
    let sourceVersion: RolloutSourceVersion | undefined;
    let reusedDisplay = false;
    let displayCurrent = () => false;
    const historyTrace = guardedTrace(performanceDiagnostics, 'codex-history-read');
    let historyFailed = true;
    const task = (async () => {
      await this.ensureStarted(checkAuthority);
      authority();
      const version = this.projectionVersion(sessionKey);
      connectionId = this.connectionId;
      const child = this.child, generation = this.nativeConnectionGeneration;
      const displayActivity = this.nativeHistoryActivityGuard(this.threadId(sessionKey));
      // A failed read may retain its negative cache on the same physical
      // connection even when execution is unavailable. That is not permission
      // to publish history/activity or to reuse a previous successful cache.
      failureCacheCurrent = () => !this.closed && child === this.child
        && generation === this.nativeConnectionGeneration && connectionId === this.connectionId;
      publicationCurrent = () => failureCacheCurrent() && !this.executionUnavailable;
      let observed = await this.readHistoryFact(sessionKey);
      let execution = observed.execution ?? undefined;
      // Immutable degraded-read eligibility must survive our own resume ACK's
      // history-only strengthening; that ACK is not execution safety proof.
      const degradedTerminal = execution?.sync === 'error'
        && ['completed', 'failed', 'interrupted'].includes(execution.phase);
      let resumedOwnedTerminal = false;
      refreshFact = async () => { observed = await this.readHistoryFact(sessionKey); };
      const sameRead = () => {
        authority();
        const current = this.options.nativeJournal ? observed.execution : this.legacyExecutions.get(sessionKey);
        return !(this.options.nativeJournal ? observed.deleted : this.legacyExecutions.isDeletedTerminal(sessionKey))
          && child === this.child && generation === this.nativeConnectionGeneration
          && connectionId === this.connectionId && current?.commandId === execution?.commandId && current?.revision === execution?.revision;
      };
      const checkpoint = async () => { await refreshFact!(); return sameRead(); };
      failureCurrent = () => !this.closed && sameRead() && version === this.projectionVersion(sessionKey) && !this.completingTurns.has(sessionKey);
      const threadId = this.threadId(sessionKey);
      const reusable = () => options.readOnly && !options.fresh && maxAgeMs > 0 && cached?.available
        && this.options.store.hasMessages(sessionKey)
        && cached.display && !observed.outcomeUnknown && !this.executionUnavailable
        && cached.display.connection === connectionId && cached.display.generation === generation
        && cached.display.projection === this.projectionVersion(sessionKey)
        && isDeepStrictEqual(cached.display.execution, observed.execution)
        && isDeepStrictEqual(cached.display.runtime, this.options.store.getSession(sessionKey)?.runtime)
        && !this.activeTurnIds.has(sessionKey) && !this.completingTurns.has(sessionKey);
      historyTrace.add('step', !cached?.display ? 1 : reusable() ? 2 : 3);
      if (reusable() && await this.rolloutReader.sourceUnchanged(cached!.display!.source,
        this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS) && await checkpoint() && reusable() && publicationCurrent()) {
        reusedDisplay = true;
        historyTrace.add('cacheHit', 1);
        displayCurrent = () => sameRead() && !!reusable() && publicationCurrent();
        return true;
      }
      let result;
      let unmaterialized = false;
      try {
        readStage = 'native-read';
        authority();
        const nativeStarted = performance.now();
        result = await this.request('thread/read', { threadId, includeTurns: true });
        if (!options.readOnly) {
          const hasResumeJournal = Boolean(this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal?.prepareResume);
          result = hasResumeJournal
            ? await this.reloadJournaledErroredTerminal(sessionKey, result)
            : await this.reloadErroredTerminal(sessionKey, result);
        }
        historyTrace.add('bodyMs', performance.now() - nativeStarted);
        this.unmaterializedThreadIds.delete(threadId);
      } catch (error) {
        if (!await checkpoint() || execution || (!options.readOnly && !this.unmaterializedThreadIds.has(threadId))
          || !(error instanceof Error)
          || error.message !== `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`) throw error;
        result = await this.request('thread/read', { threadId, includeTurns: false });
        readStage = 'native-snapshot';
        const initial = historyThread(result, threadId);
        if (!sameRead() || (!options.readOnly && !this.unmaterializedThreadIds.has(threadId))
          || initial.status?.type !== 'idle' || initial.turns.length) throw error;
        // Exact native error + idle metadata restores only empty-thread source
        // tracking. Subsequent dispatch still obtains its own execution proof.
        this.unmaterializedThreadIds.add(threadId);
        unmaterialized = true;
      }
      if (!await checkpoint()) return;
      readStage = 'native-snapshot';
      let thread = historyThread(result, this.threadId(sessionKey));
      // A drained owner is permission to observe again, not evidence that its
      // failed final snapshot became complete. Re-prove causal ownership before
      // any recovery RPC; validate the projected content separately below.
      if (completionHandoff) readStage = 'history-ownership';
      const handoffOwner = completionHandoff && execution
        ? terminalHistoryOwner(thread, execution.runId,
          execution.phase === 'unknown' && execution.reason === 'restarted' ? undefined : execution.phase)
        : undefined;
      if (completionHandoff && !handoffOwner)
        throw new NativeHistoryReadError('identity', 'Codex final history unavailable');
      if (!options.readOnly && !execution && thread.status?.type === 'notLoaded' && thread.turns.length === 0) {
        await this.validateRolloutSnapshot(thread.path);
        if (this.closed || !await checkpoint()) throw new RunControlConflict();
        await this.ensureThreadLoaded(threadId);
        if (this.closed || !await checkpoint()) throw new RunControlConflict();
        thread = historyThread(await this.request('thread/read', { threadId, includeTurns: true }), threadId);
        if (!sameRead() || thread.status?.type !== 'idle' || thread.turns.length !== 0) throw new RunControlConflict();
      }
      const persistedTurn = thread.turns.at(-1);
      const restartedTerminal = execution?.phase === 'unknown' && execution.reason === 'restarted' && !execution.preparation
        && ['completed', 'failed', 'interrupted'].includes(persistedTurn?.status);
      // A sync:error terminal is permanently fenced from execution. Its
      // includeTurns snapshot is sufficient for a read-only degraded view;
      // resuming a thread with a still-running background terminal can itself
      // report non-idle and hide otherwise valid immutable history.
      const maintenanceRecovery = this.maintenanceHistoryRecovery.has(sessionKey)
        || !!(execution?.runId && (this.options.nativeJournal
          ? await this.options.nativeJournal.cleanupRecovered(sessionKey, execution.runId)
          : this.legacyExecutions.cleanupRecovered(sessionKey, execution.runId)));
      if (this.maintenanceHistoryRecovery.has(sessionKey) && execution?.runId
        && (persistedTurn?.id !== execution.runId || persistedTurn.status !== execution.phase)) {
        throw new Error('Maintenance terminal history identity changed');
      }
      // A cold includeTurns snapshot already contains immutable text. Loading
      // its native thread can activate a Goal and requires execution recovery
      // proof; a browser GET must not require (or perform) that side effect.
      // Keep the exact owned terminal identity and every durable fence. This
      // is only display hydration, never final reconciliation or admission.
      const coldOwnedDisplay = options.readOnly && !this.maintenanceHistoryRecovery.has(sessionKey) && !observed.outcomeUnknown
        && thread.status?.type === 'notLoaded' && !!execution?.runId && execution.runId === persistedTurn?.id
        && (restartedTerminal || ['completed', 'failed', 'interrupted'].includes(execution.phase)
          && execution.phase === persistedTurn.status)
        && !this.activeTurnIds.has(sessionKey);
      let coldProtectedRestarted = false;
      if (!coldOwnedDisplay && !execution?.nativeHistory && thread.status?.type === 'notLoaded' && (execution?.sync !== 'error' || maintenanceRecovery) && execution?.runId === persistedTurn?.id
        && execution?.runId && (restartedTerminal || (['completed', 'failed', 'interrupted'].includes(execution.phase)
          && persistedTurn.status === execution.phase))) {
        const terminalPhase = persistedTurn.status;
        const fingerprint = nativeHistoryFingerprint(thread);
        const activity = this.nativeHistoryActivityGuard(threadId);
        const check = () => {
          if (this.closed || this.executionUnavailable || !sameRead()) throw new RunControlConflict();
        };
        const beforeResume = () => { check(); if (!activity.current()) throw new RunControlConflict(); };
        if (restartedTerminal) await this.validateRolloutSnapshot(thread.path);
        if (!await checkpoint()) throw new RunControlConflict();
        check();
        // A history GET is never permission to continue a blocked/active Goal.
        // Resume can activate native work, so repeat Goal evidence and the
        // exact persisted head before acquiring the original durable intent.
        if (this.options.nativeJournal) {
          readStage = 'cold-recovery-goal';
          const goal = nativeGoalEvidence(await this.request('thread/goal/get', { threadId }), threadId);
          if (!await checkpoint()) throw new RunControlConflict();
          if (nativeGoalProtection(goal.status)) {
            if (!restartedTerminal) throw new RunControlConflict();
            coldProtectedRestarted = true;
          }
          check();
          if (!coldProtectedRestarted) {
            readStage = 'cold-recovery-recheck';
            const latest = historyThread(await this.request('thread/read', { threadId, includeTurns: true }), threadId);
            if (!await checkpoint() || latest.status?.type !== 'notLoaded'
              || nativeHistoryFingerprint(latest) !== fingerprint) throw new RunControlConflict();
            readStage = 'cold-recovery-goal';
            const recheckedGoal = nativeGoalEvidence(await this.request('thread/goal/get', { threadId }), threadId);
            if (!await checkpoint() || recheckedGoal.version !== goal.version || nativeGoalProtection(recheckedGoal.status))
              throw new RunControlConflict();
          }
        }
        if (!coldProtectedRestarted) {
          readStage = 'cold-recovery-resume';
          beforeResume();
          const resumed = historyThread(await this.resumeRecoveredThread(execution, threadId, fingerprint, beforeResume, null, undefined, true), threadId);
          readStage = 'cold-recovery-confirm';
          const resumedFact = await this.readHistoryFact(sessionKey);
          check();
          if (resumedFact.deleted || resumedFact.outcomeUnknown || !resumedFact.execution
            || !isDeepStrictEqual(execution, resumedFact.execution) && !resumeProtectionOnly(execution, resumedFact.execution))
            throw new RunControlConflict();
          // Only our exact acknowledged strengthening may advance this read's
          // baseline; all subsequent async checkpoints compare to that fact.
          observed = resumedFact; execution = resumedFact.execution;
          resumedOwnedTerminal = true;
          if (!await checkpoint()) throw new RunControlConflict();
          check();
          const resumedTurn = resumed.turns.at(-1);
          if (resumed.status?.type !== 'idle'
            || (resumedTurn && (resumedTurn.id !== execution.runId || resumedTurn.status !== terminalPhase))) {
            throw new RunControlConflict();
          }
          thread = historyThread(await this.request('thread/read', { threadId, includeTurns: true }), threadId);
          if (!await checkpoint()) throw new RunControlConflict();
          check();
          const rechecked = thread.turns.at(-1);
          if (thread.status?.type !== 'idle' || rechecked?.id !== execution.runId || rechecked.status !== terminalPhase) {
            throw new RunControlConflict();
          }
          this.loadedThreadIds.add(threadId);
        }
      }
      const known = this.options.store.getSession(sessionKey)?.runtime, turn = thread.turns.at(-1);
      // External completion evidence is stronger than a later contradictory read.
      if (!execution && known?.turnId && this.completedTurnIds.get(sessionKey) === known.turnId
        && turn?.id === known.turnId && ['completed', 'failed', 'interrupted'].includes(known.phase)
        && turn.status !== known.phase) throw new Error('Codex thread outcome conflicts with known completion');
      if (!this.options.store.getSession(sessionKey)) {
        this.options.store.upsertSession(this.session(sessionKey, { title: codexThreadTitle(thread), status: 'unknown' }));
      }
      const permanentlyFencedTerminal = degradedTerminal || execution?.sync === 'error'
        && ['completed', 'failed', 'interrupted'].includes(execution.phase);
      let rollout: RolloutSource = '', rolloutUnavailable = false;
      let history: Awaited<ReturnType<typeof historicalProjection>> | undefined;
      const projectionBudget = this.options.requestTimeoutMs ?? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS;
      const projectionDeadline = performance.now() + projectionBudget;
      try {
      readStage = 'rollout-snapshot';
      if (!unmaterialized) {
        try {
          // Only an explicitly running native turn may use a verified prefix.
          // Terminal/idle reads and all execution-safety checks stay strict.
          // Snapshot IO and its pure enrichment share one observation window.
          // Expiry leaves the original iterator/lease with the reader; it must
          // not reach this caller's publication or finally-disposal path late.
          const projected = await this.rolloutReader.readProjectedSnapshotWithin(thread.path, {
            consistency: turn?.status === 'inProgress' ? 'live-prefix' : 'stable',
          }, projectionBudget, async snapshot => {
            readStage = 'history-projection';
            sourceVersion = this.rolloutReader.sourceVersion(snapshot);
            return historicalProjection(sessionKey, thread.turns,
              this.historyAssistantProjector(sessionKey, projectionDeadline), snapshot, thread.path);
          });
          rollout = projected.snapshot;
          history = projected.value;
        } catch (error) {
          // A terminal execution whose history synchronization already failed
          // cannot execute again. Its native includeTurns transcript remains
          // useful even when the optional rollout enrichment has disappeared.
          // Keep every execution-safety check unconfirmed and therefore fenced.
          if (!permanentlyFencedTerminal || !(error instanceof Error)
            || error.message !== 'Codex rollout unavailable') throw error;
          rolloutUnavailable = true;
        }
      }
      readStage = 'history-projection';
      history ??= await historicalProjection(sessionKey, thread.turns,
        this.historyAssistantProjector(sessionKey, projectionDeadline), rollout, thread.path);
      if (!await checkpoint()) return;
      const messages = preserveUnfinishedAssistantStreams(thread.turns, this.options.store.getMessages(sessionKey), history.messages);
      if (handoffOwner) {
        readStage = 'history-completeness';
        const turns = arrayValue(thread.turns), trackedIndex = turns.indexOf(handoffOwner);
        const finalIds = new Set(turns.slice(trackedIndex)
          .filter(turn => ['completed', 'failed', 'interrupted'].includes(turn.status)).map(turn => turn.id));
        const missing = finalHistoryGaps(handoffOwner.id, finalIds, this.options.store.getMessages(sessionKey), messages);
        if (missing.assistants || missing.tools || missing.unfinished)
          throw new NativeHistoryReadError('incomplete', 'Codex final history unavailable');
      }
      const latestTurn = arrayValue(thread.turns).at(-1);
      // Native terminal enumeration requires a loaded thread. Do not resume a
      // permanently fenced terminal merely to serve its immutable transcript.
      // A missing rollout also leaves dispatch-settled evidence unavailable.
      let executionSafetyUnconfirmed = completionHandoff || coldOwnedDisplay || coldProtectedRestarted
        || options.readOnly && thread.status?.type === 'notLoaded' || !maintenanceRecovery && (
        (permanentlyFencedTerminal && (options.readOnly || thread.status?.type === 'notLoaded' || rolloutUnavailable))
        // Displaying a cold native checkpoint must preserve its existing fence.
        // Only recovery/explicit continuation may load it and re-prove safety.
        || (execution?.nativeHistory?.state === 'blocked' && thread.status?.type === 'notLoaded')
        // A read-only display read on an unloaded thread with unsettled/unknown
        // execution, or an unacknowledged/fenced/connection-replaced execution
        // on an unloaded thread, must preserve the existing fence without
        // calling loaded-only native terminal enumeration.
        || (options.readOnly && thread.status?.type === 'notLoaded')
        || (thread.status?.type === 'notLoaded' && !!execution && (!execution.runId || !!execution.preparation
          || (!['completed', 'failed', 'interrupted'].includes(execution.phase)
            && !(execution.phase === 'running' && execution.connectionId === connectionId)
            && !(execution.phase === 'unknown' && execution.reason === 'restarted'))))
      );
      // Preserve cold, unmanaged transcript viewing: native terminal listing
      // requires a loaded thread. This is the existing read-only display path,
      // not a managed execution drain proof or permission to resume the thread.
      const coldTranscriptOnly = !execution && thread.status?.type === 'notLoaded'
        && latestTurn?.status !== 'interrupted'
        && !arrayValue(latestTurn?.items).some(item => item.type === 'commandExecution');
      // A cold Goal successor cannot enumerate native terminals yet. Record
      // only the lost owned outcome below, then let final reconciliation save
      // a blocked checkpoint. The existing worker can load/re-prove that
      // checkpoint; this snapshot alone never clears execution protection.
      const coldSuccessorRecovery = thread.status?.type === 'notLoaded'
        && (execution?.phase === 'running' && execution.connectionId === connectionId
          || execution?.phase === 'unknown' && execution.reason === 'restarted')
        && !!terminalSuccessorOwner(thread, execution?.runId);
      if (latestTurn && ['completed', 'failed', 'interrupted'].includes(latestTurn.status)) {
        readStage = 'terminal-cleanup-proof';
        try { if (!executionSafetyUnconfirmed && !coldTranscriptOnly && !coldSuccessorRecovery) {
          const terminalCheck = () => {
            if (this.closed || this.executionUnavailable || !sameRead()) throw new RunControlConflict();
          };
          if (rollout instanceof RolloutProjection) {
            const observed = await this.rolloutReader.observeLeasedProjectionWithin(thread.path,
              Math.max(1, Math.ceil(projectionDeadline - performance.now())), () => {
                // Transfer only once the reader admits this original observer.
                const snapshot = rollout as RolloutProjection;
                rollout = '';
                return snapshot;
              }, async (snapshot, expired) => {
                const check = () => { if (expired()) throw new RolloutObservationPendingError(); terminalCheck(); };
                check();
                await this.requireBackgroundTerminalsDrained(threadId, latestTurn, check, snapshot);
                if (expired()) throw new RolloutObservationPendingError();
              });
            rollout = observed.snapshot;
          } else await this.requireBackgroundTerminalsDrained(threadId, latestTurn, terminalCheck, rollout);
        } } catch (error) {
          // Native history and execution admission are separate facts. An
          // interrupted executor without dispatch-settled evidence must keep
          // the run/queue fenced, but its immutable transcript is still safe
          // to inspect. A positive native terminal list likewise fences only
          // execution, not the immutable transcript. Identity/read errors and
          // unknown outcomes must still fail closed.
          if (!(error instanceof Error) || (!error.message.startsWith('Native tool cleanup is unconfirmed:')
            && !(error instanceof BackgroundTerminalDrainError && options.readOnly && execution?.runId
              && !observed.outcomeUnknown && ['completed', 'failed', 'interrupted'].includes(execution.phase))
            && !(permanentlyFencedTerminal && error.message === 'Codex background terminals are still running'))) throw error;
          executionSafetyUnconfirmed = true;
        }
        this.projectInterruptedTools(sessionKey, latestTurn, messages, execution ?? null);
      }
      // The pure history/proof is ready, but its original lease is not yet
      // settled. Finish cleanup BEFORE applying history or execution state.
      // Expiry transfers no publication rights and retains original ownership.
      if (typeof rollout !== 'string') {
        readStage = 'rollout-cleanup';
        const snapshot = rollout; rollout = '';
        await this.rolloutReader.disposeSnapshotWithin(thread.path, snapshot,
          Math.max(1, Math.ceil(projectionDeadline - performance.now())));
      }
      readStage = 'history-storage-read';
      const historyPlan = await this.prepareHistory(sessionKey, messages);
      readStage = 'projection-apply';
      const persistedModel = thread?.id === threadId && !this.threadModelOverrides.has(threadId)
        ? history.model : undefined;
      const rolloutUsage = history.usage;
      if (!await checkpoint()) return;
      if (this.closed || this.executionUnavailable || !sameRead() || this.completingTurns.has(sessionKey)) return;
      const changedWhileReading = version !== this.projectionVersion(sessionKey);
      const currentRuntime = this.options.store.getSession(sessionKey)?.runtime;
      // A complete read of the SAME active turn may hydrate older history while
      // streaming advances. Do not let old text overwrite live deltas, or use
      // this exception to certify completion, reconnects or a different turn.
      const liveAdvanced = changedWhileReading && latestTurn?.status === 'inProgress'
        && currentRuntime && currentRuntime.turnId === latestTurn.id && currentRuntime.sync === 'current'
        && currentRuntime.connection === 'connected'
        && ['running', 'waiting'].includes(currentRuntime.phase)
        && (execution ? execution.phase === 'running' && execution.runId === latestTurn.id
          && execution.connectionId === connectionId && !execution.preparation
          : this.activeTurnIds.get(sessionKey) === latestTurn.id);
      if (changedWhileReading && !liveAdvanced) return;
      if (!liveAdvanced && this.options.nativeJournal) {
        // Persist ONLY the metadata from this verified read, before visible
        // publication. A changed worker fact cannot replace a newer index.
        if (!await this.options.nativeJournal.fileIndexProjection({ sessionKey, expected: execution ?? null,
          evidence: projectionFileEvidence(sessionKey, messages) })) return;
        if (!await checkpoint() || this.closed || this.executionUnavailable || !sameRead()
          || version !== this.projectionVersion(sessionKey) || this.completingTurns.has(sessionKey)) return;
      }
      if (!liveAdvanced) {
        this.projectUsage(sessionKey, {
          ...rolloutUsage,
          ...(sourceVersion ? { rolloutBytes: sourceVersion.stat.size } : {}),
        });
      }
      // Model discovery belongs to on-demand hydration (including the existing
      // queue recovery worker), never the list path. Current settings win.
      const model = this.threadModelOverrides.get(threadId) ?? persistedModel;
      if (model !== undefined) {
        this.threadModels.set(threadId, model);
        const current = this.options.store.getSession(sessionKey);
        if (current && current.model !== model) this.options.store.upsertSession({ ...current, model });
      }
      // Preserve live output only for the same active turn and item kind.
      // Native replay can reuse positional item IDs for different input/output.
      // In particular, user input must remain the native snapshot until ACK-bound
      // batch validation/expansion below; stale projection text is not evidence.
      // Polling only hydrates; final reconciliation is authoritative.
      const live = new Map(this.options.store.getMessages(sessionKey).map((message) => [message.id, message]));
      // Even the first hydration must retain completion evidence for an
      // unsettled owned run. Otherwise a missing live reply disappears before
      // reconcileCompletedTurn can detect it and incorrectly grants admission.
      const unsettledOwned = observed.outcomeUnknown
        || (execution?.runId && (execution.sync !== 'current' || ['running', 'unknown'].includes(execution.phase)))
        || (!!execution && !execution.runId);
      this.applyHistory(sessionKey, { ...historyPlan, messages: historyPlan.messages.map((message) => {
        const previous = live.get(message.id);
        if (!previous || message.role === 'user' || previous.role !== message.role || previous.turnId !== message.turnId) return message;
        return liveAdvanced && message.turnId === latestTurn?.id ? previous
          : { ...previous, ...message, createdAt: previous.createdAt };
      }) }, version === 0 && !liveAdvanced && !unsettledOwned);
      if (!liveAdvanced) this.options.fileIndex?.replaceProjection(sessionKey, messages);
      // Never turn a read-only degraded snapshot into execution clearance.
      // The existing sync:error execution fact continues to fence successors.
      if (!liveAdvanced) {
        // Native terminal identity is independent from executor cleanup proof.
        // Persist the exact restarted terminal even when an unanswered executor
        // keeps history sync and every successor fenced. Stopped maintenance can
        // then certify cleanup for that durable interrupted run; leaving it as
        // unknown would make the supported recovery path unreachable.
        if (!completionHandoff && executionSafetyUnconfirmed && !this.closed && !this.executionUnavailable && connectionId
          && connectionId === this.connectionId && execution?.phase === 'unknown' && execution.reason === 'restarted'
          && thread.id === threadId && (thread.status?.type === 'idle' || coldProtectedRestarted) && latestTurn?.id === execution.runId
          && ['completed', 'failed', 'interrupted'].includes(latestTurn.status)) {
          if (this.options.nativeJournal) await this.options.nativeJournal.recoverTerminal(execution, latestTurn.id, latestTurn.status);
          else this.legacyExecutions.recoverTerminal(execution, latestTurn.id, latestTurn.status);
        } else if (!executionSafetyUnconfirmed) await this.syncThreadLifecycle(sessionKey, thread, connectionId, execution,
          this.options.nativeJournal ? observed.outcomeUnknown : undefined, () => {
            authority();
            return !this.closed && !this.executionUnavailable && child === this.child
              && generation === this.nativeConnectionGeneration && connectionId === this.connectionId;
          });
      }
      liveTurnId = latestTurn?.status === 'inProgress' ? latestTurn.id : undefined;
      if (resumedOwnedTerminal && !maintenanceRecovery && !executionSafetyUnconfirmed
        && execution?.runId && ['completed', 'failed', 'interrupted'].includes(execution.phase)) {
        // Hydration is not settlement. The original final-history owner must
        // freshly verify and commit after our resume invalidated idle proof.
        this.reconcileCompletedTurn(sessionKey, threadId, execution.completedAt!, execution.runId,
          execution.phase as 'completed' | 'failed' | 'interrupted');
      }
      // A terminal-owned native process can keep the thread active after its
      // last turn finished. That is execution protection, not mutable history.
      // Retain exact execution/activity/source guards for this display proof.
      const protectedTerminalDisplay = options.readOnly && !this.maintenanceHistoryRecovery.has(sessionKey) && !observed.outcomeUnknown
        && execution?.nativeHistory?.state === 'blocked' && !execution.preparation
        && ['completed', 'failed', 'interrupted'].includes(execution.phase)
        && thread.turns.some((candidate: any) => candidate.id === execution.runId && candidate.status === execution.phase)
        && thread.turns.every((candidate: any) => ['completed', 'failed', 'interrupted'].includes(candidate.status));
      const terminalDisplay = ['completed', 'failed', 'interrupted'].includes(latestTurn?.status)
        && (thread.status?.type === 'idle' || thread.status?.type === 'notLoaded'
          || protectedTerminalDisplay && thread.status?.type === 'active');
      historyTrace.add('deferred', thread.status?.type === 'notLoaded' ? 1 : 0);
      const fencedDisplay = options.readOnly && (!this.maintenanceHistoryRecovery.has(sessionKey) || coldOwnedDisplay) && (completionHandoff || coldOwnedDisplay || permanentlyFencedTerminal
        || (thread.status?.type === 'notLoaded' && !execution && !observed.outcomeUnknown)
        || protectedTerminalDisplay || execution?.sync === 'syncing' && execution.nativeHistory?.state === 'blocked' && !execution.preparation
          && ['completed', 'failed', 'interrupted'].includes(execution.phase));
      if (sourceVersion?.complete && terminalDisplay && !liveAdvanced && (!executionSafetyUnconfirmed || fencedDisplay)
        && !this.activeTurnIds.has(sessionKey) && !this.completingTurns.has(sessionKey) && connectionId) {
        const publishedVersion = this.projectionVersion(sessionKey);
        const current = await this.readHistoryFact(sessionKey);
        if (publicationCurrent() && publishedVersion === this.projectionVersion(sessionKey)
          && !this.activeTurnIds.has(sessionKey) && !this.completingTurns.has(sessionKey)
          && (!runtimeBusy(this.options.store.getSession(sessionKey)?.runtime) || protectedTerminalDisplay || coldOwnedDisplay && restartedTerminal
            || completionHandoff && !!handoffOwner)
          && !current.deleted && !current.outcomeUnknown && (!current.execution
          || (current.execution.sync === 'current' || fencedDisplay && isDeepStrictEqual(current.execution, execution))
            && (['completed', 'failed', 'interrupted'].includes(current.execution.phase)
              || (coldOwnedDisplay && restartedTerminal || completionHandoff && !!handoffOwner)
                && isDeepStrictEqual(current.execution, execution)))) {
          display = { source: sourceVersion, connection: connectionId, generation,
            projection: this.projectionVersion(sessionKey), execution: structuredClone(current.execution),
            runtime: structuredClone(this.options.store.getSession(sessionKey)?.runtime), activity: displayActivity.current };
        }
      }
      historyTrace.add('admitted', display ? 1 : 0);
      historyTrace.add('sourceBytes', sourceVersion?.stat.size ?? 0);
      return true;
      } finally {
        if (typeof rollout !== 'string') {
          const originalStage = readStage;
          readStage = 'rollout-cleanup';
          const snapshot = rollout; rollout = '';
          await this.rolloutReader.disposeSnapshotWithin(thread.path, snapshot,
            Math.max(1, Math.ceil(projectionDeadline - performance.now())));
          readStage = originalStage;
        }
      }
    })().then(async applied => {
      if (!applied || !publicationCurrent() || reusedDisplay && !displayCurrent()) {
        obsolete = true;
        const runtime = this.options.store.getSession(sessionKey)?.runtime;
        if (publicationCurrent() && !(await this.readHistoryFact(sessionKey)).deleted && publicationCurrent()
          && runtime?.connection !== 'disconnected' && runtime?.sync !== 'error')
          throw new HistoryReadSuperseded('Codex thread snapshot obsolete');
        throw new Error('Codex thread snapshot obsolete');
      }
      const recoveryAt = this.threadRefreshResult.get(sessionKey)?.recoveryAt
        ?? (recoveryActivity.current() ? cached?.recoveryAt : undefined);
      const coldFailure = recoveryActivity.current() ? cached?.coldFailure : undefined;
      this.threadRefreshResult.set(sessionKey, reusedDisplay ? cached! : { at: Date.now(), available: true,
        ...(options.readOnly ? { readOnly: true } : {}),
        ...(display ? { display } : {}),
        ...(recoveryAt !== undefined ? { recoveryAt } : {}), ...(coldFailure ? { coldFailure } : {}),
        ...(liveTurnId ? { liveTurnId } : { terminalIdentity: this.terminalReadIdentity(sessionKey) }) });
      if (display) this.displayHistory.set(sessionKey, display);
      // Only hydrate goals for an explicitly opened/refreshed thread, never the
      // session directory. Optional metadata failure cannot fail chat history.
      if (options.readOnly) await this.hydrateGoal(sessionKey, options.fresh === true);
      historyFailed = false;
    }).catch(async error => {
      // Static stage/counts only: upstream errors can contain transcript or secrets.
      // Obsolete reads are expected races, not a failed native history gate.
      if (!obsolete) {
        this.historyDiagnostics.failure('refresh', sessionKey, connectionId, liveTurnId, historyFailureDiagnostic(error, readStage));
      }
      // Preserve the worker's read cooldown without certifying a failed read.
      // A terminal reconciliation may have published a newer authoritative
      // result while this older read was in flight. Never overwrite it.
      if (!obsolete && failureCacheCurrent() && !this.threadRefreshResult.has(sessionKey)) {
        this.threadRefreshResult.set(sessionKey, { at: Date.now(), available: false,
          ...(recoveryActivity.current() && cached?.coldFailure ? { coldFailure: cached.coldFailure } : {}) });
      }
      if (refreshFact) {
        try { await refreshFact(); } catch { this.invalidateExecution(); }
      }
      if (failureCurrent()) this.publishThreadActivity(sessionKey, 'unknown');
      if (completionHandoff) throw new Error('Codex final history unavailable', { cause: error });
      throw error;
    }).finally(() => {
      this.threadRefreshInflight.delete(sessionKey);
      historyTrace.finish(historyFailed);
    });
    this.threadRefreshInflight.set(sessionKey, task);
    return task;
  }

  /** Same original transport/policies, but all durable creation authority lives
   * in the owner. requestAuthorized drains observations BEFORE worker handoff
   * and refuses new observations after that await; no cached sync authority. */
  async createSessionOwned(intent: import('../connector/connector-codex-creation-domain.js').CodexCreationIntent,
    port: import('../connector/async-codex-creation.js').CodexCreationPort) {
    port.local();
    if (intent.boardTools !== !!this.options.boardToolsDirectory) throw Error('Codex creation configuration mismatch');
    await this.ensureStarted(); port.local();
    const connection = this.connectionId, generation = this.nativeConnectionGeneration;
    const local = () => {
      port.local();
      if (connection !== this.connectionId || generation !== this.nativeConnectionGeneration) throw Error('Codex creation connection changed');
    };
    const model = intent.model || this.options.defaultModel;
    const result = await this.requestAuthorized('thread/start', {
      cwd: this.options.defaultCwd, ...(model ? { model } : {}),
      ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}),
      approvalPolicy: this.options.approvalPolicy, sandbox: 'danger-full-access',
      developerInstructions: `${CODEX_MEDIA_BUDGET_INSTRUCTIONS} ${CODEX_AUTONOMY_INSTRUCTIONS}`,
      ...(intent.boardTools ? { dynamicTools: codexBoardToolSpecs } : {}),
    }, port.ready, local);
    const threadId = stringValue(result?.thread?.id ?? result?.id);
    if (!threadId) throw Error('Codex did not return a thread id');
    // Preserve the known ID even if the native connection/authority changed.
    await port.identify(threadId);
    local();
    await this.requestAuthorized('thread/name/set', { threadId, name: intent.title }, port.nameReady, local);
    await port.accept();
    // Durable receipt wins even if a local projection fails or is now stale.
    local();
    const key = this.sessionKey(threadId);
    this.loadedThreadIds.add(threadId); this.unmaterializedThreadIds.add(threadId); this.threadModels.set(threadId, model);
    this.options.store.persistSessionTitleOverride(key, intent.title);
    this.options.store.upsertSession(this.session(key, { title: intent.title, status: 'idle', model }));
    return { key };
  }

  async createSession(params: { title?: string; model?: string }, acceptIdentity: (sessionKey: string) => void, authorize: () => void,
    validateIdentity: (sessionKey: string) => void = () => {}) {
    synchronousEffectAuthority(authorize);
    if (this.options.boardToolsDirectory && !this.legacyExecutions.canEnrollBoardTools()) throw new Error('Task tool thread capacity reached');
    await this.ensureStarted();
    synchronousEffectAuthority(authorize);
    // Reserve before the native side effect: concurrent creates must not both
    // consume the last enrollment slot while thread/start is pending.
    let boardSlot = false;
    if (this.options.boardToolsDirectory) {
      if (!this.legacyExecutions.canEnrollBoardTools(this.pendingBoardThreadStarts)) throw new Error('Task tool thread capacity reached');
      this.pendingBoardThreadStarts++;
      boardSlot = true;
    }
    try {
      const model = params.model || this.options.defaultModel;
      const connectionId = this.connectionId;
      const beforeDispatch = () => {
        synchronousEffectAuthority(authorize);
        if (this.closed || this.executionUnavailable || connectionId !== this.connectionId)
          throw new Error('Codex creation connection changed');
      };
      const result = await this.request('thread/start', {
        cwd: this.options.defaultCwd,
        ...(model ? { model } : {}),
        ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}),
        approvalPolicy: this.options.approvalPolicy,
        sandbox: 'danger-full-access',
        developerInstructions: `${CODEX_MEDIA_BUDGET_INSTRUCTIONS} ${CODEX_AUTONOMY_INSTRUCTIONS}`,
        ...(this.options.boardToolsDirectory ? { dynamicTools: codexBoardToolSpecs } : {}),
      }, undefined, undefined, beforeDispatch);
      const threadId = stringValue(result?.thread?.id ?? result?.id);
      if (!threadId) throw new Error('Codex did not return a thread id');
      const sessionKey = this.sessionKey(threadId);
      // Native creation has already happened. Reject an unusable identity before
      // changing local state; never archive/recreate it to compensate for a clash.
      validateIdentity(sessionKey);
      if (this.options.boardToolsDirectory) this.legacyExecutions.enrollBoardTools(threadId);
      if (boardSlot) { this.pendingBoardThreadStarts--; boardSlot = false; }
      const title = params.title?.trim() || 'New Codex task';
      await this.request('thread/name/set', { threadId, name: title }, undefined, undefined, beforeDispatch);
      acceptIdentity(sessionKey);
      this.loadedThreadIds.add(threadId);
      if (connectionId && connectionId === this.connectionId) this.unmaterializedThreadIds.add(threadId);
      this.threadModels.set(threadId, model);
      this.options.store.persistSessionTitleOverride(sessionKey, title);
      this.options.store.upsertSession(this.session(sessionKey, {
        title,
        status: 'idle',
        model,
      }));
      return { key: sessionKey };
    } finally {
      if (boardSlot) this.pendingBoardThreadStarts--;
    }
  }

  /** Existing native threads cannot be silently retrofitted on resume. */
  get boardToolsAvailable(): boolean {
    // Local executor fence only. Owned mode must read enrollment in its worker,
    // never through legacyExecutions (which deliberately rejects that mode).
    return !!this.options.boardToolsDirectory && !this.closed && !this.executionUnavailable;
  }

  hasBoardTools(sessionKey: string): boolean {
    return this.boardToolsAvailable
      && sessionKey.startsWith('codex:') && this.legacyExecutions.hasBoardTools(sessionKey.slice(6))
      && !this.legacyExecutions.isDeletedTerminal(sessionKey);
  }

  updateSessionRuntime(sessionKey: string, params: { model?: string | null; thinking?: string | null },
    acknowledged?: (session: SessionSummary) => void) {
    const threadId = this.threadId(sessionKey);
    const current = this.options.store.getSession(sessionKey);
    if (!current) throw new Error('session not found');
    const model = params.model === null ? this.options.defaultModel : params.model?.trim() || current.model || this.options.defaultModel;
    // A rejected local save cannot silently change the next native dispatch.
    // Model and thinking remain separate legacy files: a later thinking/ACK
    // failure is still an unknown composite outcome, never proof to replay.
    this.threadModelOverrides = this.changeRuntimeOverride(threadId, model, params.model);
    this.threadModels.set(threadId, model);
    const updated = this.options.store.persistSessionThinkingOverride(sessionKey, params.thinking, session => {
      // This callback is after durable thinking persistence and before ACK or
      // projection. Preserve durable values if either later observer fails.
      if (params.thinking === null) {
        this.threadEfforts.delete(threadId);
        this.threadsWithStickyEffort.add(threadId);
      }
      else if (params.thinking?.trim()) this.threadEfforts.set(threadId, params.thinking.trim());
      acknowledged?.(this.session(sessionKey, { ...(session ?? current), model }));
    });
    this.options.store.upsertSession(this.session(sessionKey, { ...(updated ?? current), model }));
    return this.options.store.getSession(sessionKey)!;
  }

  async updateSessionRuntimeOwned(sessionKey: string, params: { model: string | null; thinking?: string | null },
    acknowledge: (session: SessionSummary) => Promise<void>, local: () => void) {
    synchronousEffectAuthority(local);
    const threadId = this.threadId(sessionKey), current = this.options.store.getSession(sessionKey);
    if (this.closed || !current) throw new Error('session not found');
    const model = params.model === null ? this.options.defaultModel : params.model.trim();
    // Reuse the original files/format. If the second write or ACK fails, the
    // first durable write is still authoritative and the receipt stays unknown.
    this.threadModelOverrides = this.changeRuntimeOverride(threadId, model, params.model);
    this.threadModels.set(threadId, model);
    const updated = this.options.store.persistSessionThinkingEffect(sessionKey, params.thinking);
    if (params.thinking === null) {
      this.threadEfforts.delete(threadId);
      this.threadsWithStickyEffort.add(threadId);
    }
    else if (params.thinking?.trim()) this.threadEfforts.set(threadId, params.thinking.trim());
    await acknowledge(this.session(sessionKey, { ...(updated ?? current), model }));
    const latest = this.options.store.getSession(sessionKey);
    if (!this.closed && latest) {
      const { thinkingLevel: _thinking, ...withoutThinking } = latest;
      this.options.store.upsertSession(this.session(sessionKey, { ...(params.thinking === null ? withoutThinking : latest), model,
        ...(params.thinking != null ? { thinkingLevel: params.thinking } : {}) }));
    }
  }

  /** Local DISPLAY/veto only. The worker revalidates authority and SQL facts. */
  get messageAdmissionReady() { return !this.closed && this.enabled; }

  messageAdmissionState(sessionKey: string) {
    const session = this.options.store.getSession(sessionKey);
    return { ready: this.messageAdmissionReady,
      exists: this.owns(sessionKey) && !!this.threadId(sessionKey) && !!session,
      blocked: codexQueueDisposition('', { headId: null, executionCommandId: null }, session) === 'waiting' };
  }

  /** Post-commit original projection. No SQL, authorization or native effect.
   * A delayed admission reply cannot overwrite a newer visible execution/edit. */
  publishMessageAdmission(sessionKey: string, text: string, result: CodexMessageAdmission) {
    if (this.closed || !this.owns(sessionKey) || !this.options.store.getSession(sessionKey)
      || !codexMessageAdmission(result) || !result.runId.startsWith(`${sessionKey}:codex-queued-`)) return;
    const existing = this.options.store.getMessage(sessionKey, result.runId);
    if (existing) return;
    this.options.store.addMessage({ id: result.runId, sessionKey, role: 'user', text, status: 'queued',
      queueVersion: result.admission.queueVersion, queueDisposition: result.admission.disposition,
      createdAt: result.admission.createdAt, updatedAt: result.admission.createdAt,
      ...(result.media.length ? { media: result.media } : {}) });
  }

  async send(sessionKey: string, text: string, images: CodexImageAttachment[] = [],
    admission?: { actorId?: string; executionGrant?: ExecutionGrantAuthority; accept?: (result: CodexAdmission) => Parameters<TurnQueue['enqueue']>[2] }) {
    // Preserve the caller's original authority across the asynchronous wait;
    // never authorize one grant while committing a mutable replacement.
    admission = admission && { ...admission, ...(admission.executionGrant ? { executionGrant: { ...admission.executionGrant } } : {}) };
    if (this.closed) throw new Error('Codex App Server closed');
    if (!this.enabled) throw new Error('Codex App Server disabled');
    if (this.options.startup) await this.ready();
    if (!this.owns(sessionKey) || !this.threadId(sessionKey) || !this.options.store.getSession(sessionKey)) throw new Error('session not found');
    if (!text.trim() && images.length === 0) throw new Error('message or image is required');
    if (!this.authorized(sessionKey, admission?.actorId, admission?.executionGrant)) throw new TurnAuthorizationError();
    const id = codexScopedId(sessionKey, `codex-queued-${nanoid()}`), now = Date.now();
    const result: CodexAdmission = { runId: id, idempotencyKey: id, status: 'queued', media: images.map((image) => image.media) };
    const check = () => {
      if (this.closed) throw new Error('Codex App Server closed');
      if (!this.enabled) throw new Error('Codex App Server disabled');
      if (!this.options.store.getSession(sessionKey)) throw new Error('session not found');
      if (!this.authorized(sessionKey, admission?.actorId, admission?.executionGrant)) throw new TurnAuthorizationError();
    };
    await this.legacyTurnQueue.enqueueAsync('codex', { id, sessionKey, payload: { text, images, actorId: admission?.actorId, executionGrant: admission?.executionGrant }, createdAt: now }, (db, turn) => {
      // Construct the observation after insertion, inside the SAME transaction
      // as the durable receipt, before the worker can observe the admission.
      result.admission = { createdAt: now, queueVersion: this.legacyTurnQueue.version('codex', sessionKey, id)!,
        disposition: this.queueDisposition(sessionKey, id) };
      admission?.accept?.(result)?.(db, turn);
    }, check);
    check();
    this.options.store.addMessage({ id, sessionKey, role: 'user', text, status: 'queued', queueVersion: result.admission!.queueVersion,
      queueDisposition: result.admission!.disposition, createdAt: now, updatedAt: now, ...(images.length ? { media: result.media } : {}) });
    return result;
  }

  editQueued(sessionKey: string, id: string, text: string, expectedVersion?: string, commitReceipt?: TurnQueueCommit) {
    const changed = this.legacyTurnQueue.edit<CodexQueuedPayload>('codex', sessionKey, id, (payload) => ({ ...payload, text }), expectedVersion, commitReceipt);
    const message = this.options.store.getMessage(sessionKey, id);
    if (changed && message) this.options.store.addMessage({ ...message, text, queueVersion: this.legacyTurnQueue.version('codex', sessionKey, id), updatedAt: Date.now() });
    return changed;
  }

  cancelQueued(sessionKey: string, id: string, expectedVersion?: string, commitReceipt?: TurnQueueCommit) {
    const changed = this.legacyTurnQueue.cancel('codex', sessionKey, id, expectedVersion, commitReceipt);
    if (changed) this.options.store.removeMessage(sessionKey, id);
    return changed;
  }

  // Only the durable worker may invoke a runtime turn. HTTP admission above
  // does not start a process, hydrate a thread, or wait for runtime readiness.
  private authorized(sessionKey: string, actorId?: string, executionGrant?: ExecutionGrantAuthority, action: ExecutionAction = 'messages:send') {
    return this.options.authorizeTurn(actorId, { runtime: 'codex', sessionKey }, action, executionGrant);
  }

  private async sendQueued(sessionKey: string, text: string, images: CodexImageAttachment[], queuedId: string, actorId?: string, executionGrant?: ExecutionGrantAuthority,
    batch?: CodexBatch, entries?: QueuedTurn<CodexQueuedPayload>[], blockedGoalInput = false, admission?: QueuedAdmission) {
    if (this.closed) throw new Error('Codex App Server closed');
    const threadId = this.threadId(sessionKey);
    if (!text.trim() && images.length === 0) throw new Error('message or image is required');
    await this.ensureStarted();
    // thread/resume may activate native goal continuation. Verify an observed
    // native head BEFORE loading, and again immediately before turn/start.
    if (this.legacyExecutions.get(sessionKey)?.nativeHistory) (await this.requireNativeHistoryForDispatch(sessionKey, threadId, blockedGoalInput))?.();
    await this.ensureThreadLoaded(threadId);
    if (!this.authorized(sessionKey, actorId, executionGrant)) throw new TurnAuthorizationError();
    let current = this.options.store.getSession(sessionKey);
    if (!current) {
      this.options.store.upsertSession(this.session(sessionKey, {
        title: 'Recovered Codex task',
        status: 'idle',
        model: this.threadModels.get(threadId) ?? this.options.defaultModel,
        lastActiveAt: Date.now(),
      }));
      current = this.options.store.getSession(sessionKey);
    }
    if (!current) throw new Error('Codex session projection could not be restored');
    // Loading may yield to another read or invalidation after the worker's read.
    if (!this.isSessionHistoryReady(sessionKey) || (!this.legacyExecutions.get(sessionKey) && this.activeTurnIds.has(sessionKey)) || runtimeBusy(current.runtime) || (current.runtime && current.runtime.sync !== 'current') || current.hasActiveRun || current.status === 'running') {
      return { runId: queuedId, status: 'queued' as const, idempotencyKey: queuedId, media: images.map((image) => image.media) };
    }
    const recoveryContext = await this.recoverPayloadTooLargeThread(sessionKey, threadId, queuedId, actorId, executionGrant, batch, admission);
    if (!this.authorized(sessionKey, actorId, executionGrant)) throw new TurnAuthorizationError();
    if (recoveryContext === false || !this.isSessionHistoryReady(sessionKey)) {
      // Recovery may already own native mutations: never defer that command for replay.
      if (this.legacyExecutions.get(sessionKey)?.commandId === queuedId) throw new RunControlConflict();
      return { runId: queuedId, status: 'queued' as const, idempotencyKey: queuedId, media: images.map((image) => image.media) };
    }
    const now = Date.now();
    const messageId = queuedId;
    const media = images.map((image) => image.media);
    const message: ChatMessage = { id: messageId, sessionKey, role: 'user', text, status: 'sending', createdAt: now, updatedAt: now, ...(media.length ? { media } : {}) };
    if (admission && !codexAdmissionMatches<CodexQueuedPayload>(this.legacyTurnQueue, sessionKey, admission.proof,
      entry => this.authorized(sessionKey, entry.payload.actorId, entry.payload.executionGrant),
      this.legacyExecutions.get(sessionKey)?.commandId === queuedId ? 'dispatching' : 'queued')) throw new TurnStartDeferred();
    if (batch && entries) {
      const ids = new Set(entries.map(entry => entry.id));
      // Replace the batch together: updating timestamps one row at a time can
      // reverse equal-time members as the not-yet-updated row sorts first.
      this.options.store.replaceMessages(sessionKey, [
        ...this.options.store.getMessages(sessionKey).filter(message => !ids.has(message.id)),
        ...entries.map(entry => ({ ...this.queuedTurnMessage(entry), createdAt: now, updatedAt: now,
          status: 'sending' as const, queueVersion: undefined, queueDisposition: undefined })),
      ]);
    } else this.options.store.addMessage(message);
    try {
    // Retire a proven predecessor before begin replaces its current fact.
      const preparationConnection = this.connectionId;
      if (this.activeSecretFiles.has(sessionKey)) await this.cleanupSecretFiles(sessionKey);
      if (this.activeSecretFiles.has(sessionKey)) throw new Error('Previous Codex credential resources are unresolved');
      if (this.closed || this.executionUnavailable || preparationConnection !== this.connectionId) throw new Error('Codex credential preparation was invalidated');
      const bridgedText = text.trim() ? await this.bridgeOpaqueSecrets(sessionKey, text, messageId) : text;
      if (this.closed || this.executionUnavailable || preparationConnection !== this.connectionId) throw new Error('Codex credential preparation was invalidated');
      const input = [
        ...(text.trim() ? [{ type: 'text', text: recoveryContext
          ? `[Recovered context from the oversized failed turn]\n${recoveryContext}\n\n[Current request]\n${bridgedText}`
          : bridgedText }]
          : []),
        ...images.map((image) => ({ type: 'localImage', path: image.filePath })),
      ];
      const turnId = await this.startTurn(sessionKey, threadId, input, messageId, actorId, executionGrant, batch, blockedGoalInput, admission);
      return { runId: turnId, status: 'started' as const, idempotencyKey: messageId, media };
    } catch (error) {
      const execution = this.legacyExecutions.get(sessionKey);
      // ACK already committed: projection failure is not dispatch failure, and
      // the native turn may still be reading its staged credential files.
      if (execution?.commandId === messageId && execution.runId) throw error;
      await this.cleanupSecretFiles(sessionKey, true);
      // With atomic admission, no owning fact means native turn/start was
      // never authorized. A proved rollback or stale preparation is not an
      // unknown external execution; preserve the editable waiting queue.
      if ((admission || error instanceof TurnStartDeferred) && execution?.commandId !== messageId) throw error;
      const runtime = this.options.store.getSession(sessionKey)?.runtime;
      // A start RPC error can follow native side effects or even completion.
      // Do not invent a terminal outcome or overwrite one already observed.
      if (!runtime || !['finalizing', 'completed', 'interrupted', 'failed'].includes(runtime.phase)) {
        this.publishRun(sessionKey, { ...(runtime?.turnId ? { turnId: runtime.turnId } : {}),
          phase: 'unknown', connection: this.child ? 'connected' : 'disconnected', sync: 'error',
          lastEventAt: Date.now(), reason: 'Codex dispatch outcome is unknown' }, { runCompletedAt: undefined });
      }
      throw error;
    }
  }

  private beginQueuedExecution(sessionKey: string, commandId: string, connectionId: string, preparing: boolean, batch: CodexBatch | undefined,
    blockedGoalInput: boolean, context: ReturnType<typeof appendTurnContext>['proof'], admission?: QueuedAdmission) {
    if (!admission) return this.legacyExecutions.begin(sessionKey, commandId, connectionId, preparing, batch, blockedGoalInput, context);
    try {
      const claimed = admitCodexQueued<CodexQueuedPayload>({ turns: this.legacyTurnQueue, codexExecutions: this.legacyExecutions },
        sessionKey, commandId, connectionId, admission.proof,
        entry => this.authorized(sessionKey, entry.payload.actorId, entry.payload.executionGrant),
        { preparing, blockedGoalInput, ...(batch ? { batch } : {}), ...(context ? { context } : {}) });
      if (!claimed) return false;
      admission.proof = claimed.proof;
      return true;
    } catch (error) {
      if (error instanceof CodexAdmissionConflict) throw new TurnStartDeferred();
      throw error;
    }
  }

  private async startTurn(sessionKey: string, threadId: string, input: any[], clientUserMessageId: string, actorId?: string, executionGrant?: ExecutionGrantAuthority, batch?: CodexBatch, blockedGoalInput = false, admission?: QueuedAdmission) {
    if (this.legacyExecutions.get(sessionKey)?.nativeHistory) (await this.requireNativeHistoryForDispatch(sessionKey, threadId, blockedGoalInput))?.();
    if (this.closed || this.executionUnavailable) throw new Error('Codex execution is not available for dispatch');
    if (!this.authorized(sessionKey, actorId, executionGrant)) throw new TurnAuthorizationError();
    // Additional ordinary file context belongs to this admitted turn only;
    // never enqueue a hidden user message or rewrite the durable command.
    const fileContext = this.options.fileBoardContext?.(sessionKey, actorId, executionGrant);
    const contextual = appendTurnContext(input, fileContext ?? '');
    input = contextual.input;
    const connectionId = this.connectionId;
    if (!connectionId) throw new Error('Codex execution is not available for dispatch');
    if (actorId && this.options.interactions?.runtime.store.mode({ ownerId: actorId,
      nodeId: this.options.interactions.nodeId, sessionKey }) === 'interactive' && (!this.interactionReady || executionGrant)) {
      throw new Error('Codex interactive mode is unavailable; automatic execution was not substituted');
    }
    if (!this.beginQueuedExecution(sessionKey, clientUserMessageId, connectionId, false, batch, blockedGoalInput, contextual.proof, admission)) throw new TurnStartDeferred();
    const interactive = this.interactionReady && (this.interactions?.begin(sessionKey, actorId, clientUserMessageId, !!executionGrant) ?? false);
    if (this.hasBoardTools(sessionKey)) this.boardTools.begin(threadId, turnId => {
      const current = this.legacyExecutions.get(sessionKey);
      return !this.closed && !this.executionUnavailable && this.connectionId === connectionId
        && current?.connectionId === connectionId && current.commandId === clientUserMessageId
        && current.phase === 'running' && current.runId === turnId
        && this.authorized(sessionKey, actorId, executionGrant);
    });
    this.unmaterializedThreadIds.delete(threadId);
    const now = Date.now();
    this.publishRun(sessionKey, { phase: 'starting', connection: 'connected', sync: 'current', lastEventAt: now }, { runStartedAt: now, runCompletedAt: undefined, lastActiveAt: now });
    // Capture before ACK consumes the queue row. Mixed/batched/delegated work
    // has no single proven automation origin and deliberately cannot trigger.
    const completionOwner = !batch && !executionGrant && actorId
      && this.legacyTurnQueue.interactionOwner('codex', sessionKey, [clientUserMessageId]) === actorId ? actorId : undefined;
    this.automationCompletions.begin(sessionKey, clientUserMessageId, connectionId, completionOwner, now);
    const resources = this.activeSecretFiles.get(sessionKey);
    if (resources?.commandId === clientUserMessageId) resources.dispatched = true;
    const beforeDispatch = () => {
      if (!this.authorized(sessionKey, actorId, executionGrant)) throw new TurnAuthorizationError();
      const current = this.legacyExecutions.get(sessionKey);
      if (this.closed || this.executionUnavailable || this.connectionId !== connectionId
        || !this.options.store.getSession(sessionKey) || current?.connectionId !== connectionId
        || current.commandId !== clientUserMessageId || current.phase !== 'starting'
        || current.preparation || current.reason || current.runId) throw new TurnStartDeferred();
      if (admission && !codexAdmissionMatches<CodexQueuedPayload>(this.legacyTurnQueue, sessionKey, admission.proof,
        entry => this.authorized(sessionKey, entry.payload.actorId, entry.payload.executionGrant), 'dispatching')) throw new TurnStartDeferred();
    };
    const result = await this.request('turn/start', this.turnStartParams(threadId, clientUserMessageId, input, interactive),
      undefined, undefined, beforeDispatch);
    const turnId = stringValue(result?.turn?.id ?? result?.id);
    if (!turnId) throw new Error('Codex start ACK did not identify a native turn');
    if (this.connectionId !== connectionId || !acknowledgeCodexDispatch({ turns: this.legacyTurnQueue, codexExecutions: this.legacyExecutions },
      sessionKey, clientUserMessageId, connectionId, turnId)) throw new Error('Codex start ACK identity could not be bound');
    this.automationCompletions.acknowledge(sessionKey, clientUserMessageId, connectionId, turnId);
    const execution = this.legacyExecutions.get(sessionKey);
    // A managed ACK retires legacy markers; durable facts now own lifecycle.
    this.activeTurnIds.delete(sessionKey);
    this.completedTurnIds.delete(sessionKey);
    if (execution && ['completed', 'failed', 'interrupted'].includes(execution.phase)) {
      this.boardTools.stop(threadId);
      await this.cleanupSecretFiles(sessionKey);
    }
    // ACK's durable phase owns early completion, not an in-memory marker.
    if (execution?.phase === 'running') {
      this.publishRun(sessionKey, { turnId, phase: 'running', connection: 'connected', sync: 'current', lastEventAt: Date.now() });
    }
    return turnId;
  }

  private turnStartParams(threadId: string, clientUserMessageId: string, input: unknown[], interactive: boolean) {
    const model = (this.threadModels.get(threadId) ?? this.options.defaultModel) || null;
    const rawEffort = this.effectiveRawEffort(threadId);
    const reasoning = resolveCodexReasoningParams({
      model,
      rawEffort,
      hadActiveEffort: this.threadsWithStickyEffort.has(threadId),
    });
    if (reasoning.effort) this.threadsWithStickyEffort.add(threadId);
    else if (reasoning.clearStickyEffort && model && !rawEffort) this.threadsWithStickyEffort.delete(threadId);
    return { threadId, clientUserMessageId, input, cwd: this.options.defaultCwd,
      approvalPolicy: interactive ? 'untrusted' : this.options.approvalPolicy,
      sandboxPolicy: { type: 'dangerFullAccess' },
      model,
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      ...(reasoning.summary ? { summary: reasoning.summary } : {}),
      ...(reasoning.clearStickyEffort && model ? {
        collaborationMode: {
          mode: 'default',
          settings: { model, reasoning_effort: null, developer_instructions: null },
        },
      } : {}) };
  }

  private effectiveRawEffort(threadId: string): string | undefined {
    return this.threadEfforts.get(threadId) ?? this.options.store.localSessionThinkingLevel(this.sessionKey(threadId));
  }

  private threadResumeEffort(threadId: string): string | undefined {
    const model = (this.threadModels.get(threadId) ?? this.options.defaultModel) || null;
    const reasoning = resolveCodexReasoningParams({
      model,
      rawEffort: this.effectiveRawEffort(threadId),
      hadActiveEffort: this.threadsWithStickyEffort.has(threadId),
    });
    if (reasoning.effort) this.threadsWithStickyEffort.add(threadId);
    return reasoning.effort;
  }

  /** Install the original native task bridge using worker-owned authority.
   * No legacy store/authorization reads may enter this local lifetime fence. */
  bindOwnedBoardTools(input: { sessionKey: string; commandId: string; connectionId: string },
    authorize: (runId: string) => Promise<boolean>): () => Promise<void> {
    const threadId = input.sessionKey.startsWith('codex:') ? input.sessionKey.slice(6) : '';
    const local = () => !this.closed && !this.executionUnavailable && this.connectionId === input.connectionId;
    if (!threadId || !this.options.boardToolsDirectory || !local()) throw new TurnStartDeferred();
    return this.boardTools.begin(threadId, async runId => local() && await authorize(runId) === true && local());
  }

  /** Internal native phase for an already prepared/worker-claimed turn, never
   * an HTTP or general RPC API. Preparation, interaction/tool ownership and
   * durable ACK settlement belong to the enclosing dispatch lifecycle. */
  installOwnedInteractions(binding: import('../connector/connector-codex-interaction-domain.js').CodexInteractionBinding,
    runtime: import('../commands/interaction-port.js').NativeInteractionRuntime, permitted: () => Promise<boolean>): () => void {
    if (!this.options.ownedInteractions || !this.interactions || binding.scope.nodeId !== this.options.ownedInteractions.nodeId
      || binding.scope.sessionKey !== binding.ref.sessionKey || !this.interactionReady) throw new TurnStartDeferred();
    const ref = structuredClone(binding.ref);
    return this.interactions.beginOwned(ref.sessionKey, binding.scope.ownerId, ref.commandId, ref.connectionId, runtime, permitted);
  }

  async startOwnedTurn(input: { sessionKey: string; commandId: string; connectionId: string; input: unknown[]; interactive: boolean;
    /** Provenance captured by the worker from the original claimed FIFO only. */
    completionOwnerId?: string },
    port: { authorize(): Promise<void>; local(): void; dispatched(): void; beforeEffect?(): void;
      load?: { begin(fingerprint: string): Promise<NativeResumeReceipt>; acknowledge(receipt: NativeResumeReceipt): Promise<void>;
        finish(receipt: NativeResumeReceipt): Promise<void> } }) {
    if (!input.sessionKey.startsWith('codex:')) throw new TurnStartDeferred();
    const threadId = this.threadId(input.sessionKey), connectionId = input.connectionId;
    const local = () => {
      // DeckStore.getSession decorates its display with synchronous execution
      // reads in the legacy composition. It is neither a local identity fence
      // nor current authority. The enclosing preparation owner supplies the
      // local veto; the worker checks durable execution/deletion/queue facts.
      if (!threadId || this.connectionId !== connectionId) throw new TurnStartDeferred();
      synchronousEffectAuthority(() => port.local());
    };
    local();
    let beforeEffect = port.beforeEffect;
    if (!this.loadedThreadIds.has(threadId)) {
      if (!port.load) throw new TurnStartDeferred();
      // Cold loading is an EFFECT of this original claimed FIFO task. Reads,
      // display refresh and scheduler observation never resume native work.
      await port.authorize(); local();
      const before = await this.proveOwnedLoadIdle(threadId, local, false);
      let receipt: NativeResumeReceipt | undefined;
      await this.requestAuthorized('thread/resume', {
        threadId, ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}),
        cwd: this.options.defaultCwd,
        ...(this.threadModels.get(threadId) ? { model: this.threadModels.get(threadId) } : {}),
        ...(this.threadResumeEffort(threadId) ? { effort: this.threadResumeEffort(threadId) } : {}),
        approvalPolicy: input.interactive ? 'untrusted' : this.options.approvalPolicy,
        sandbox: 'danger-full-access', developerInstructions: `${CODEX_MEDIA_BUDGET_INSTRUCTIONS} ${CODEX_AUTONOMY_INSTRUCTIONS}`,
      }, async () => {
        await port.authorize(); local(); before.check();
        receipt = await port.load!.begin(before.fingerprint);
        local(); before.check();
      }, local, undefined, port.beforeEffect);
      // An original ACK is evidence even if local/permission checks now fail.
      await port.load.acknowledge(receipt!);
      const after = await this.proveOwnedLoadIdleAfterAck(threadId, local);
      if (after.fingerprint !== before.fingerprint || after.goalVersion !== before.goalVersion) throw new TurnStartDeferred();
      await port.load.finish(receipt!); local(); after.check();
      this.loadedThreadIds.add(threadId);
      // Resume invalidates the old native activity lease. Replace it ONLY
      // after unchanged full history, Goal, child and background-work proof;
      // connection/Goal ownership and worker FIFO authority remain original.
      beforeEffect = after.check;
    }
    const result = await this.requestAuthorized('turn/start', this.turnStartParams(threadId, input.commandId, input.input, input.interactive),
      () => port.authorize(), () => {
        local(); synchronousEffectAuthority(() => port.dispatched());
        this.automationCompletions.begin(input.sessionKey, input.commandId, connectionId, input.completionOwnerId, Date.now());
      },
      undefined, beforeEffect);
    // Preserve an original ACK even if authority/connection changed meanwhile.
    // The worker settles it against the original command and connection only.
    const turnId = stringValue(result?.turn?.id ?? result?.id);
    if (!turnId) throw new Error('Codex start ACK did not identify a native turn');
    this.automationCompletions.acknowledge(input.sessionKey, input.commandId, connectionId, turnId);
    return turnId;
  }

  private async proveOwnedLoadIdleAfterAck(threadId: string, local: () => void) {
    // Installed native can deliver resume's status/token/Goal notifications
    // after its original ACK, even during the first thread/read. They invalidate
    // that entire read window, but do not authorize a second resume or input.
    // Discard the evidence and take at most three fresh, fully fenced proofs.
    // Unsafe history/Goal/tool evidence, missing replies and authority changes
    // are NOT stabilization failures and must still retain the original claim.
    for (let attempt = 0; ; attempt++) {
      await this.nativeObservations.beforeEffect(); local();
      try { return await this.proveOwnedLoadIdle(threadId, local, true); }
      catch (error) {
        if (!(error instanceof OwnedLoadObservationChanged) || attempt >= 2) throw error;
      }
    }
  }

  private async proveOwnedLoadIdle(threadId: string, local: () => void, loaded: boolean) {
    const activity = this.nativeHistoryActivityGuard(threadId);
    const check = () => { local(); if (!activity.current()) throw new OwnedLoadObservationChanged(); };
    const read = activity.request;
    check();
    const thread = historyThread(await read('thread/read', { threadId, includeTurns: true }), threadId);
    check();
    const available = (value: any) => value.status?.type === 'idle' && value.canAcceptDirectInput === true
      || !loaded && value.status?.type === 'notLoaded';
    if (!available(thread) || thread.turns.some((turn: any) => !['completed', 'failed', 'interrupted'].includes(turn.status)))
      throw new TurnStartDeferred();
    const goal = nativeGoalEvidence(await read('thread/goal/get', { threadId }), threadId);
    check();
    // Unknown or continuing Goals cannot be hydrated on behalf of a new send.
    if (nativeGoalProtection(goal.status)) throw new TurnStartDeferred();
    const notLoaded = thread.status?.type === 'notLoaded';
    // Installed native exposes terminal enumeration only for loaded threads.
    // This pre-load pass is NOT a drain certificate: after the original owned
    // resume ACK we require a fresh loaded idle/input/terminal proof below.
    if (!notLoaded && (await backgroundTerminals(read, threadId, check)).length) throw new TurnStartDeferred();
    check();
    // An empty live terminal list is not proof that an interrupted wrapper or
    // command has settled. Reuse the normal immutable rollout cleanup proof;
    // never terminate tools or infer success from a terminal turn status.
    const cleanupTurns = thread.turns.filter((turn: any) => turn.status === 'interrupted'
      || turn.items.some((item: any) => item.type === 'commandExecution'));
    if (cleanupTurns.length) {
      // Missing rollout provenance is not an empty/settled tool proof.
      if (typeof thread.path !== 'string' || !thread.path.trim()) throw new TurnStartDeferred();
      if (cleanupTurns.some((turn: any) => turn.items.some((item: any) => item.type === 'commandExecution'
        && item.status !== 'completed' && item.status !== 'declined' && item.status !== 'failed'))) throw new TurnStartDeferred();
      const interruptedTurnIds = cleanupTurns.filter((turn: any) => turn.status === 'interrupted').map((turn: any) => String(turn.id));
      await this.rolloutReader.projectTurnsAndDisposeWithin(thread.path, interruptedTurnIds,
        this.options.requestTimeoutMs ?? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS, async (rollout, expired) => {
          const guarded = () => { check(); if (expired()) throw new TurnStartDeferred(); };
          const terminals = this.backgroundTerminalObservation(threadId, guarded, read);
          for (const turn of cleanupTurns) {
            guarded();
            if (notLoaded) await this.requireInterruptedTurnSettled(threadId, turn, guarded, rollout);
            else await this.requireBackgroundTerminalsDrained(threadId, turn, guarded, rollout, read, terminals);
          }
          guarded();
        });
      check();
    }
    if (thread.turns.some((turn: any) => hasNativeChildWork(turn.items, threadId))) {
      await inspectNativeChildren(threadId, thread.turns.flatMap((turn: any) => turn.items), read, check,
        undefined, new Set<string>(thread.turns.map((turn: any) => turn.id)));
      check();
    }
    const fingerprint = nativeHistoryFingerprint(thread);
    const latest = historyThread(await read('thread/read', { threadId, includeTurns: true }), threadId);
    const afterGoal = nativeGoalEvidence(await read('thread/goal/get', { threadId }), threadId);
    check();
    if (!available(latest) || fingerprint !== nativeHistoryFingerprint(latest) || goal.version !== afterGoal.version
      || nativeGoalProtection(afterGoal.status)) throw new TurnStartDeferred();
    return { fingerprint, goalVersion: goal.version, check };
  }

  private async recoverPayloadTooLargeThread(sessionKey: string, threadId: string, commandId: string, actorId?: string, executionGrant?: ExecutionGrantAuthority, batch?: CodexBatch, admission?: QueuedAdmission) {
    const latestFailure = [...this.options.store.getMessages(sessionKey)].reverse().find((message) => message.status === 'failed');
    if (!isPayloadTooLargeError(latestFailure?.failureReason ?? latestFailure?.text)) return;
    // User continuation of a blocked goal is not permission to compact/rollback.
    if (this.legacyExecutions.get(sessionKey)?.nativeHistory?.reason === 'goal-blocked'
      && !this.legacyExecutions.canStart(sessionKey)) throw new TurnStartDeferred();
    const connectionId = this.connectionId;
    let execution = this.legacyExecutions.get(sessionKey), preparing = false;
    const previousRunId = execution?.runId;
    const check = (mutating = false) => {
      if (!this.authorized(sessionKey, actorId, executionGrant)) throw new TurnAuthorizationError();
      if (mutating && !this.authorized(sessionKey, actorId, executionGrant, 'runs:compact')) throw new RecoveryAuthorizationError();
      const current = this.legacyExecutions.get(sessionKey);
      if (this.closed || this.executionUnavailable || !connectionId || this.connectionId !== connectionId
        || current?.commandId !== execution?.commandId || current?.revision !== execution?.revision
        || (preparing ? current?.phase !== 'starting' || current.preparation !== 'active' : !this.legacyExecutions.canStart(sessionKey))
        || (!current && this.activeTurnIds.has(sessionKey))) throw new RunControlConflict();
    };
    check();
    const version = this.projectionVersion(sessionKey);
    const historyCurrent = () => this.isSessionHistoryReady(sessionKey) && version === this.projectionVersion(sessionKey);
    // Only prewrite read failures can defer; never catch rollback/compact here.
    const defer = () => { this.threadRefreshResult.delete(sessionKey); return false as const; };
    let thread;
    try {
      thread = historyThread(await this.request('thread/read', { threadId, includeTurns: true }), threadId);
    } catch {
      check(); // A changed authority or execution still uses its existing failure path.
      return defer();
    }
    check();
    // Readable history is not idle evidence: a terminal predecessor can coexist
    // with native thread activity. Defer even if no rollback would be needed.
    if (!historyCurrent() || snapshotRuntime(thread, Date.now()).threadActivity !== 'idle') return defer();
    const turns = thread.turns;
    const rollbackStart = this.payloadRecoveryStart(turns);
    const numTurns = turns.length - rollbackStart;
    // Recovery mutates history as well as sending a message. Delegation must
    // explicitly permit compaction before even the first rollback side effect.
    check(numTurns > 0);
    let messages: ChatMessage[];
    try { messages = await historicalMessages(sessionKey, turns,
      this.historyAssistantProjector(sessionKey, performance.now() + (this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS))); }
    catch {
      check(numTurns > 0);
      // Diagnostics cannot grant execution or turn safe deferral into failure.
      // Do not serialize errors, prompts, paths or native history here.
      try { console.warn('[codex-history-recovery-deferred]', { stage: 'history-projection', fault: 'unverified' }); }
      catch { /* A failed diagnostic sink must preserve the original recovery boundary. */ }
      return defer();
    }
    check(numTurns > 0);
    if (!historyCurrent()) return defer();
    if (numTurns === 0) return;
    const { recoveryContext, retainedMessages } = this.payloadRecoveryMessages(sessionKey, turns, rollbackStart, messages);
    // Claim the original queued command before the first history mutation.
    // Preparation is execution, not an idle predecessor or another queue.
    await this.cleanupSecretFiles(sessionKey);
    if (this.activeSecretFiles.has(sessionKey)) throw new Error('Previous Codex credential resources are unresolved');
    check(true);
    if (this.legacyExecutions.get(sessionKey)?.nativeHistory) (await this.requireNativeHistoryForDispatch(sessionKey, threadId))?.();
    check(true);
    if (!this.beginQueuedExecution(sessionKey, commandId, connectionId!, true, batch, false, undefined, admission)) throw new TurnStartDeferred();
    execution = this.legacyExecutions.get(sessionKey)!; preparing = true;
    await this.request('thread/rollback', { threadId, numTurns }, undefined, undefined, () => check(true));
    check(true);
    const historyPlan = await this.prepareHistory(sessionKey, retainedMessages);
    check(true);
    for (const message of this.options.store.getMessages(sessionKey)) {
      if (message.status === 'failed' && isPayloadTooLargeError(message.failureReason ?? message.text)) {
        this.options.store.removeMessage(sessionKey, message.id);
      }
    }
    this.applyHistory(sessionKey, historyPlan, true);
    await this.compactThread(threadId, execution, previousRunId);
    check(true);
    if (!this.legacyExecutions.finishPreparation(execution)) throw new RunControlConflict();
    return recoveryContext;
  }

  private payloadRecoveryStart(turns: any[]): number {
    let start = turns.length;
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn?.status !== 'failed' || !isPayloadTooLargeError(codexTurnFailureReason({ turn }))) break;
      start = index;
    }
    for (let index = Math.max(0, turns.length - 8); index < start; index++) {
      if (isOversizedMediaTurn(turns[index])) start = Math.min(start, index);
    }
    return start;
  }

  private payloadRecoveryMessages(sessionKey: string, turns: any[], start: number, messages: ChatMessage[]) {
    const recoveryContext = ([...this.options.store.getMessages(sessionKey)].reverse()
      .find(message => message.role === 'assistant' && message.status !== 'failed' && message.text.trim())
      ?? [...messages].reverse().find(message => message.role === 'assistant' && message.status !== 'failed' && message.text.trim()))
      ?.text.slice(-2_000);
    const retained = new Set<string>(turns.slice(0, start).map(turn => turn.id));
    return { recoveryContext, retainedMessages: messages.filter(message => message.turnId && retained.has(message.turnId)) };
  }

  private async compactThread(threadId: string, preparation?: CodexExecution, previousRunId?: string) {
    if (!preparation && this.legacyExecutions.get(this.sessionKey(threadId))?.nativeHistory) {
      (await this.requireNativeHistoryForDispatch(this.sessionKey(threadId), threadId))?.();
    }
    if (this.closed || this.executionUnavailable || !this.connectionId || this.compactWaiters.has(threadId)) throw new Error('Codex compaction is not available');
    const sessionKey = this.sessionKey(threadId), connectionId = this.connectionId;
    const execution = this.legacyExecutions.get(sessionKey);
    if ((preparation ? execution?.commandId !== preparation.commandId || execution?.revision !== preparation.revision
      || execution?.connectionId !== connectionId || execution?.phase !== 'starting' || execution?.preparation !== 'active'
      : !this.legacyExecutions.canStart(sessionKey)) || (!execution && this.activeTurnIds.has(sessionKey))) throw new Error('Codex compaction is not available');
    const check = () => {
      const current = this.legacyExecutions.get(sessionKey);
      if (this.closed || this.executionUnavailable || this.connectionId !== connectionId
        || current?.commandId !== execution?.commandId || current?.revision !== execution?.revision) throw new Error('Codex compaction execution identity changed');
    };
    const predecessorRunId = previousRunId ?? execution?.runId;
    return this.compactOperation(threadId, check, predecessorRunId,
      () => this.request('thread/compact/start', { threadId }, undefined, undefined, check));
  }

  /** Original compactor under worker-owned preparation. No SQL, DeckStore,
   * process startup or history selection. Enclosing recovery owns rollback and
   * projection; this port proves only the original compaction effect. */
  compactOwnedPreparation(input: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'connectionId' | 'revision'> & { previousRunId?: string },
    port: { authorize(): Promise<void>; local(): void; dispatched(): void }): Promise<void> {
    return this.ownHistoryPreparation(input, async snapshot => {
      const { threadId, local } = this.ownedPreparationGuards(snapshot, port);
      await this.compactOwnedOperation(threadId, snapshot.previousRunId, local, port);
    });
  }

  /** Original live-scheduler observation for worker FIFO dispatch. This neither
   * starts/resumes a process nor claims work. Verified heads repeat the native
   * proof instead of trusting a persisted bit. Only an original authorized
   * queued input may reprove a goal-blocked head; other blocked reasons must
   * first be reconciled by their original recovery owner.
   * The returned local lease spans claim, recovery, credentials and native ACK;
   * only the preclaim fence includes history that recovery itself may replace. */
  observeOwnedQueue(sessionKey: string, blockedGoalInput = false): Promise<CodexQueueRecovery> {
    const connectionId = this.connectionId, child = this.child, generation = this.nativeConnectionGeneration;
    const goal = this.goalExecutionVersions.get(sessionKey);
    const local = () => {
      if (!connectionId || !child || this.closed || this.executionUnavailable || !this.enabled || !this.owns(sessionKey)
        || this.connectionId !== connectionId || this.child !== child || this.nativeConnectionGeneration !== generation
        || this.goalExecutionVersions.get(sessionKey) !== goal)
        throw new TurnStartDeferred();
    };
    return this.ownHistoryPreparation({ sessionKey }, async () => {
      local();
      if (!this.options.credentialExecutionReader || !this.options.historyReader) throw new TurnStartDeferred();
      const version = this.projectionVersion(sessionKey);
      const activity = this.nativeHistoryActivityGuard(this.threadId(sessionKey));
      // This immutable local evidence survives worker claim. Unlike display
      // readiness, it cannot be invalidated by our own starting receipt.
      const beforeEffect = () => {
        local();
        if (!this.isSessionHistoryReady(sessionKey) || version !== this.projectionVersion(sessionKey)
          || !activity.current()) throw new TurnStartDeferred();
      };
      const beforeClaim = () => {
        beforeEffect();
        const current = this.options.store.getSession(sessionKey);
        if (!current || !this.isSessionHistoryReady(sessionKey) || version !== this.projectionVersion(sessionKey)
          || goal !== this.goalExecutionVersions.get(sessionKey) || !activity.current()
          || runtimeBusy(current.runtime) || current.runtime && current.runtime.sync !== 'current'
          || current.hasActiveRun || current.status === 'running') throw new TurnStartDeferred();
      };
      beforeClaim();
      const previous = await this.options.credentialExecutionReader.get(sessionKey);
      beforeClaim();
      if (previous?.preparation || previous?.reason
        || previous && (!['completed', 'failed', 'interrupted'].includes(previous.phase) || previous.sync !== 'current')
        || !previous && this.activeTurnIds.has(sessionKey)) throw new TurnStartDeferred();
      if (previous?.nativeHistory) {
        // A persisted verified checkpoint is necessary, but never sufficient:
        // repeat the ORIGINAL native proof before replacing the predecessor.
        // A blocked Goal may accept an ORIGINAL authorized queued input, but
        // only after the same fresh terminal/child/process proof as legacy
        // dispatch. Never clear the checkpoint or admit other blocked reasons.
        const blockedContinuation = blockedGoalInput && previous.nativeHistory.state === 'blocked'
          && previous.nativeHistory.reason === 'goal-blocked';
        if (previous.nativeHistory.state !== 'verified' && !blockedContinuation
          || previous.nativeHistory.connectionId !== connectionId)
          throw new TurnStartDeferred();
        const threadId = this.threadId(sessionKey);
        const thread = historyThread(await activity.request('thread/read', { threadId, includeTurns: true }), threadId);
        beforeClaim();
        if (nativeHistoryFingerprint(thread) !== previous.nativeHistory.fingerprint) throw new TurnStartDeferred();
        const proof = await this.inspectNativeHistory(thread, previous, beforeClaim, false, blockedGoalInput, activity.request, false);
        beforeClaim();
        if (proof.state !== 'verified') throw new TurnStartDeferred();
      }
      // Dispose only against the predecessor fact, before a preparing claim
      // replaces it. An unknown disposal observation retains its resources.
      await this.cleanupSecretFiles(sessionKey);
      beforeClaim();
      if (this.activeSecretFiles.has(sessionKey) || this.cleaningSecretFiles.has(sessionKey)) throw new TurnStartDeferred();
      const current = await this.options.credentialExecutionReader.get(sessionKey);
      beforeClaim();
      if (current?.revision !== previous?.revision || current?.commandId !== previous?.commandId) throw new TurnStartDeferred();
      const latestFailure = [...this.options.store.getMessages(sessionKey)].reverse().find(message => message.status === 'failed');
      // Permission to supply input to a blocked Goal is NOT permission to
      // rollback/compact it. Preserve its original queue and execution owner.
      if (previous?.nativeHistory?.state === 'blocked'
        && isPayloadTooLargeError(latestFailure?.failureReason ?? latestFailure?.text)) throw new TurnStartDeferred();
      if (this.queueHistoryLeases.has(sessionKey) || this.queueHistoryLeases.size >= 128) throw new TurnStartDeferred();
      let release!: () => void;
      const lease = new Promise<void>(resolve => { release = resolve; });
      this.queueHistoryLeases.set(sessionKey, lease);
      return { connectionId: connectionId!, blockedGoalInput, local, beforeClaim, beforeEffect,
        release: () => {
          if (this.queueHistoryLeases.get(sessionKey) === lease) this.queueHistoryLeases.delete(sessionKey);
          release();
        },
        predecessor: previous ? { commandId: previous.commandId, connectionId: previous.connectionId, revision: previous.revision } : null,
        needed: isPayloadTooLargeError(latestFailure?.failureReason ?? latestFailure?.text),
        ...(previous?.runId ? { previousRunId: previous.runId } : {}) };
    });
  }

  /** Already-claimed original payload recovery. Display reads are never write
   * authority; every native delivery is separately checked in the DB worker. */
  recoverOwnedPreparation(input: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'connectionId' | 'revision'> & { previousRunId?: string },
    port: { authorize(): Promise<void>; local(): void; dispatched(): void }): Promise<{ state: 'recovered' | 'not_needed'; context?: string }> {
    return this.ownHistoryPreparation(input, async snapshot => {
      const { sessionKey } = snapshot;
      const { threadId, local } = this.ownedPreparationGuards(snapshot, port);
      // A synchronous fallback, decorated execution getter, or clearing a
      // predecessor's resource from the new preparing fact is not permitted.
      if (!this.options.historyReader || this.activeSecretFiles.has(sessionKey) || this.cleaningSecretFiles.has(sessionKey))
        throw new TurnStartDeferred();
      let version = this.projectionVersion(sessionKey);
      const current = () => {
        local();
        if (!this.isSessionHistoryReady(sessionKey) || this.projectionVersion(sessionKey) !== version) throw new TurnStartDeferred();
      };
      const check = async () => { current(); await port.authorize(); current(); };
      current();
      const thread = historyThread(await this.requestAuthorized('thread/read', { threadId, includeTurns: true }, check, current), threadId);
      current();
      if (snapshotRuntime(thread, Date.now()).threadActivity !== 'idle') throw new TurnStartDeferred();
      const start = this.payloadRecoveryStart(thread.turns), numTurns = thread.turns.length - start;
      if (numTurns === 0) { await check(); return { state: 'not_needed' as const }; }
      const messages = await historicalMessages(sessionKey, thread.turns,
        this.historyAssistantProjector(sessionKey, performance.now() + (this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS)));
      await check();
      const { retainedMessages, recoveryContext } = this.payloadRecoveryMessages(sessionKey, thread.turns, start, messages);
      await this.requestAuthorized('thread/rollback', { threadId, numTurns }, check, () => {
        current(); synchronousEffectAuthority(() => port.dispatched()); current();
      });
      local();
      // Rollback may legitimately invalidate the old version. Bind subsequent
      // display preparation to the version AFTER its ACK, never to a stale read.
      version = this.projectionVersion(sessionKey);
      const plan = await this.options.historyReader.prepare(sessionKey, retainedMessages);
      await check();
      for (const message of this.options.store.getMessages(sessionKey)) {
        if (message.status === 'failed' && isPayloadTooLargeError(message.failureReason ?? message.text))
          this.options.store.removeMessage(sessionKey, message.id);
      }
      this.applyHistory(sessionKey, plan, true);
      // Publishing our own display changes is not native idle evidence. The
      // worker and native observation barrier guard the following effect again.
      await this.compactOwnedOperation(threadId, snapshot.previousRunId, local, port);
      return { state: 'recovered' as const, ...(recoveryContext === undefined ? {} : { context: recoveryContext }) };
    });
  }

  private ownedPreparationGuards(input: Pick<CodexExecution, 'sessionKey' | 'connectionId'>,
    port: { local(): void }) {
    const threadId = this.threadId(input.sessionKey);
    const child = this.child, generation = this.nativeConnectionGeneration;
    const local = () => {
      if (!threadId || this.closed || this.executionUnavailable || this.connectionId !== input.connectionId
        || this.child !== child || this.nativeConnectionGeneration !== generation)
        throw new RunControlConflict();
      synchronousEffectAuthority(() => port.local());
    };
    local();
    if (this.compactWaiters.has(threadId!)) throw new RunControlConflict();
    return { threadId: threadId!, local };
  }

  private compactOwnedOperation(threadId: string, previousRunId: string | undefined, local: () => void,
    port: { authorize(): Promise<void>; dispatched(): void }) {
    return this.compactOperation(threadId, local, previousRunId,
      () => this.requestAuthorized('thread/compact/start', { threadId }, () => port.authorize(), () => {
        local(); synchronousEffectAuthority(() => port.dispatched()); local();
        this.compactWaiters.get(threadId)!.accepting = true;
      }), true);
  }

  private ownHistoryPreparation<T, I extends { sessionKey: string }>(input: I, work: (snapshot: I) => Promise<T>): Promise<T> {
    if (this.closed || this.ownedHistoryPreparations.size >= 128 || this.ownedHistoryPreparations.has(input.sessionKey))
      return Promise.reject(new Error('Codex preparation unavailable'));
    const key = input.sessionKey;
    let snapshot: typeof input, copyFailure: { error: unknown } | undefined;
    const task = Promise.resolve().then(() => {
      if (copyFailure) throw copyFailure.error;
      return work(snapshot);
    });
    const release = () => { this.ownedHistoryPreparations.delete(key); };
    const drain = task.then(release, release);
    this.ownedHistoryPreparations.set(key, drain);
    try { snapshot = structuredClone(input); } catch (error) { copyFailure = { error }; }
    return task;
  }

  private async compactOperation(threadId: string, check: () => void, predecessorRunId: string | undefined,
    request: () => Promise<unknown>, guarded = false) {
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Codex thread compaction timed out'));
      }, 120_000);
      timeout.unref();
      this.compactWaiters.set(threadId, { resolve, reject, timeout, check, evidence: {}, accepting: !guarded,
        ...(predecessorRunId ? { previousRunId: predecessorRunId } : {}) });
    });
    const waiter = this.compactWaiters.get(threadId)!;
    try {
      // Completion can fail before the RPC ACK. Observe both immediately so
      // timeout/disconnect cannot leave an unhandled or two-minute orphan wait.
      await Promise.all([completion, request()]);
      check();
      if (waiter.evidence.failure) throw new Error(waiter.evidence.failure);
    } finally {
      clearTimeout(waiter.timeout);
      if (this.compactWaiters.get(threadId) === waiter) this.compactWaiters.delete(threadId);
    }
  }

  async interrupt(sessionKey: string, expectedRunId: string, actorId: string, executionGrant?: ExecutionGrantAuthority,
    acknowledged?: () => void) {
    const turnId = requireExpectedRun(expectedRunId);
    const connectionId = this.connectionId;
    const execution = this.legacyExecutions.get(sessionKey);
    const check = (afterInterrupt = false) => {
      if (!this.options.authorizeTurn(actorId, { runtime: 'codex', sessionKey }, 'runs:interrupt', executionGrant)) throw new TurnAuthorizationError();
      if (this.closed || this.executionUnavailable || connectionId !== this.connectionId) throw new RunControlConflict();
      const current = this.legacyExecutions.get(sessionKey);
      if (execution?.commandId !== current?.commandId) throw new RunControlConflict();
      if (current) {
        if ((current.phase !== 'running' && !(afterInterrupt && ['completed', 'failed', 'interrupted'].includes(current.phase)))
          || current.connectionId !== connectionId || current.runId !== turnId
          // Successor activity invalidates native history without adopting its
          // run ID. The old run binding alone cannot authorize more cleanup.
          || current.nativeHistory?.state === 'blocked') throw new RunControlConflict();
      } else if (this.activeTurnIds.get(sessionKey) !== turnId
        && !(afterInterrupt && this.options.store.getSession(sessionKey)?.runtime?.turnId === turnId)) throw new RunControlConflict();
    };
    return this.interruptOperation(sessionKey, turnId, { check, local: check,
      pendingTools: () => this.legacyExecutions.get(sessionKey)?.pendingCommandTools ?? [],
      cleanupRecovered: () => this.legacyExecutions.cleanupRecovered(sessionKey, turnId),
      ...(acknowledged ? { acknowledged } : {}) });
  }

  /** Connection owner veto only; never grants SQL or execution authority. */
  get stopConnectionId() { return !this.closed && !this.executionUnavailable ? this.connectionId ?? null : null; }

  interruptOwned(intent: CodexStopIntent, port: {
    check(afterInterrupt: boolean): Promise<CodexStopObservation>;
    acknowledged(): Promise<void>; dispatched(): void;
  }) {
    let observation: CodexStopObservation = { pendingCommandTools: [], cleanupRecovered: false };
    const local = (after: boolean) => {
      if (this.closed || this.executionUnavailable || this.connectionId !== intent.connectionId || !this.threadId(intent.key)) throw new RunControlConflict();
      if (intent.commandId === null && this.activeTurnIds.get(intent.key) !== intent.runId
        && !(after && this.options.store.getSession(intent.key)?.runtime?.turnId === intent.runId)) throw new RunControlConflict();
    };
    return this.interruptOperation(intent.key, requireExpectedRun(intent.runId), {
      check: async after => { observation = await port.check(after); local(after); }, local,
      pendingTools: () => observation.pendingCommandTools, cleanupRecovered: () => observation.cleanupRecovered,
      acknowledged: () => port.acknowledged(), dispatched: () => port.dispatched() });
  }

  /** One native implementation for legacy and worker-authorized ingress.
   * Guards must be awaited; a final local veto occurs immediately before IO. */
  private async interruptOperation(sessionKey: string, turnId: string, port: {
    check(afterInterrupt: boolean): void | Promise<void>; local(afterInterrupt: boolean): void;
    pendingTools(): string[]; cleanupRecovered(): boolean;
    acknowledged?: () => void | Promise<void>; dispatched?: () => void;
  }) {
    const trace = performanceDiagnostics.start('codex-interrupt-observation');
    let step = 1, dispatched = false, accepted = false, failed = true;
    const threadId = this.threadId(sessionKey);
    const check = async (after = false) => { await port.check(after); port.local(after); };
    const request = (method: string, params: unknown, timeout?: number) => {
      port.local(accepted);
      if (method === 'turn/interrupt') { dispatched = true; port.dispatched?.(); }
      return this.request(method, params, timeout);
    };
    try {
    await check();
    await this.ensureStarted();
    await check(); // Process startup can yield to completion, a new turn or revoke.
    port.local(false);
    this.boardTools.stop(threadId);
    this.interactions?.stop(sessionKey);
    step = 2;
    await request('turn/interrupt', { threadId, turnId });
    step = 3; accepted = true;
    await port.acknowledged?.(); // Persist native ACK before cleanup; NOT terminal.
    await check(true);
    step = 4;
    const thread = historyThread(await request('thread/read', { threadId, includeTurns: true }), threadId);
    await check(true);
    const turn = arrayValue(thread.turns).at(-1);
    if (turn?.id !== turnId) throw new RunControlConflict();
    const itemIds = new Set<string>(arrayValue(turn.items).filter(item => item.type === 'commandExecution').map(item => item.id));
    step = 5;
    await terminateBackgroundTerminals(request, threadId, () => new Set([
      ...itemIds, ...port.pendingTools(),
    ]), () => check(true));
    // The interrupt RPC above is a real effect. A read/proof/cleanup deadline
    // below only ends observation; it cannot replay that effect, cancel an
    // active iterator, or release the original execution's protection.
    step = 6;
    await this.rolloutReader.projectTurnsAndDisposeWithin(thread.path,
      turn.status === 'interrupted' ? [String(turn.id)] : [],
      this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS, async (rollout, expired) => {
        const proofCheck = async () => { await check(true); if (expired()) throw new RunControlConflict(); };
        await proofCheck();
        if (!port.cleanupRecovered()) await requireInterruptedDispatchSettled(rollout, turn);
        await proofCheck();
      });
    await check(true); // Cleanup can yield to a successor, disconnect, or revocation.
    step = 7; failed = false;
    } finally {
      trace.add('step', step);
      trace.add('admitted', accepted ? 1 : 0); // Native ACK, NOT execution completion.
      trace.add('unknown', dispatched && failed ? 1 : 0); // Cleanup/effect observation remains uncertain.
      trace.finish(failed);
    }
  }

  /** One exhaustive thread-level list belongs to one guarded proof window,
   * not to each historical turn. Never retain this observation across reads,
   * retries, connections or publication. Each consumer rechecks its own IO
   * lease and native activity; final dispatch proof still obtains a fresh list.
   * Rejection stays rejection: no cache reset, automatic retry or cleanup. */
  private backgroundTerminalObservation(threadId: string, check: () => void, nativeRead = this.request.bind(this)) {
    let original: ReturnType<typeof backgroundTerminals> | undefined;
    return async () => {
      check();
      const terminals = await (original ??= backgroundTerminals(nativeRead, threadId, check));
      check();
      return terminals;
    };
  }

  private async requireBackgroundTerminalsDrained(threadId: string, turn: any, check: () => void, rollout: RolloutSource = '',
    nativeRead = this.request.bind(this), observation?: () => ReturnType<typeof backgroundTerminals>) {
    // A missing command item (including missed live notifications) is not an
    // empty-terminal proof. Unknown or older-run work must also block admission.
    const terminals = await (observation ? observation() : backgroundTerminals(nativeRead, threadId, check));
    check();
    const execution = await this.readExecutionFact(this.sessionKey(threadId));
    check();
    const itemIds = new Set<string>(arrayValue(turn.items).filter(item => item.type === 'commandExecution').map(item => item.id));
    if (execution && execution.runId === turn.id && execution.connectionId === this.connectionId) {
      for (const itemId of execution.pendingCommandTools ?? []) itemIds.add(itemId);
    }
    if (terminals.length) throw new BackgroundTerminalDrainError(terminals, itemIds);
    if (turn.status !== 'interrupted' && !itemIds.size) return;
    await this.requireInterruptedTurnSettled(threadId, turn, check, rollout);
  }

  private async requireInterruptedTurnSettled(threadId: string, turn: any, check: () => void, rollout: RolloutSource) {
    if (turn.status !== 'interrupted') return;
    const recovered = this.options.nativeJournal
      ? await this.options.nativeJournal.cleanupRecovered(this.sessionKey(threadId), turn.id)
      : this.legacyExecutions.cleanupRecovered(this.sessionKey(threadId), turn.id);
    check();
    if (!recovered) await requireInterruptedDispatchSettled(rollout, turn);
    check();
  }

  private projectInterruptedTools(sessionKey: string, turn: any, messages: ChatMessage[],
    execution: CodexExecution | null = this.legacyExecutions.get(sessionKey) ?? null) {
    if (turn.status !== 'interrupted') return;
    for (const message of messages) {
      if (message.turnId !== turn.id || message.role !== 'tool' || message.status !== 'sending') continue;
      message.status = 'failed';
      message.failureReason = 'Turn interrupted; native tool completion output is unavailable. Side effects may have occurred.';
    }
    if (!execution || execution.runId !== turn.id) return;
    const itemIds = new Set(execution.pendingCommandTools ?? []);
    for (const itemId of itemIds) {
      const matching = (message: ChatMessage) => message.turnId === turn.id && message.role === 'tool' && message.toolCallId === itemId;
      if (messages.some(message => matching(message) && message.toolPhase === 'result')) continue;
      const reason = 'Turn interrupted; command is no longer running. Native completion output is unavailable.';
      const message = toolMessage({ sessionKey, turnId: turn.id, itemId, phase: 'call', text: reason, toolName: 'commandExecution',
        createdAt: execution.startedAt, status: 'failed', failureReason: reason });
      const index = messages.findIndex(candidate => candidate.id === message.id);
      if (index < 0) messages.push(message); else messages[index] = message;
    }
  }

  async remove(sessionKey: string, authorize: () => void, acknowledged?: () => void) {
    synchronousEffectAuthority(authorize);
    await this.ensureStarted();
    synchronousEffectAuthority(authorize);
    const connectionId = this.connectionId;
    const beforeDispatch = () => {
      synchronousEffectAuthority(authorize);
      if (this.closed || this.executionUnavailable || connectionId !== this.connectionId)
        throw new Error('Codex archive connection changed');
    };
    // Error text is not authoritative absence or a successful archive ACK.
    // Keep the projection on failure, including a lost response after writing.
    await this.request('thread/archive', { threadId: this.threadId(sessionKey) }, undefined, undefined, beforeDispatch);
    this.unmaterializedThreadIds.delete(this.threadId(sessionKey));
    this.subagentTracker.clearSession(sessionKey);
    acknowledged?.();
    this.options.store.removeSession(sessionKey);
  }

  /** Worker admission and receipt, with the original transport as sole archive
   * executor. HTTP timeout never cancels an original-connection late ACK. */
  async removeOwned(sessionKey: string, local: () => void, authorize: () => Promise<void>, acknowledged: () => Promise<void>) {
    synchronousEffectAuthority(local);
    await this.ensureStarted();
    synchronousEffectAuthority(local);
    const connection = this.connectionId, generation = this.nativeConnectionGeneration;
    const check = () => {
      synchronousEffectAuthority(local);
      if (this.closed || this.executionUnavailable || connection !== this.connectionId || generation !== this.nativeConnectionGeneration)
        throw new Error('Codex archive connection changed');
    };
    let settlement: Promise<void> | undefined;
    const accept = () => settlement ??= Promise.resolve().then(async () => {
      await acknowledged();
      // Persist the ACK first. Never project an old ACK onto a new connection.
      if (!this.closed && connection === this.connectionId && generation === this.nativeConnectionGeneration) {
        this.unmaterializedThreadIds.delete(this.threadId(sessionKey));
        this.subagentTracker.clearSession(sessionKey);
        this.options.store.removeSession(sessionKey);
      }
    });
    await this.requestAuthorized('thread/archive', { threadId: this.threadId(sessionKey) }, authorize, check,
      undefined, undefined, { beforeWrite: check, acknowledge: accept });
    await accept();
  }

  private async ensureStarted(checkAuthority?: () => void) {
    if (this.closed) throw new Error('Codex App Server closed');
    if (!this.enabled) throw new Error('Codex connector is disabled (set AOD_CODEX_ENABLED=true)');
    if (this.options.startup) {
      await this.ready();
      if (this.closed || this.executionUnavailable) throw new Error('Codex startup unavailable');
    }
    if (checkAuthority) synchronousEffectAuthority(checkAuthority, () => new RunControlConflict());
    if (this.maintenanceRecovery.getStore()) await this.authorizeMaintenanceRecovery();
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed) return;
    if (!this.starting) this.starting = this.start();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async restoreSessions() {
    const deadline = performance.now() + (this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS);
    const remaining = () => {
      const ms = deadline - performance.now();
      if (ms <= 0) throw new Error('Codex session list timed out');
      return ms;
    };
    await this.ensureStarted();
    const connectionId = this.connectionId;
    const checkConnection = () => {
      if (connectionId !== this.connectionId) throw new Error('Codex session list connection changed');
    };
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      if (cursors.size >= CODEX_SESSION_LIST_MAX_PAGES) throw new Error('Codex session list page limit exceeded');
      const result = await this.request('thread/list', {
        cursor,
        limit: CODEX_SESSION_LIST_PAGE_SIZE,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        modelProviders: [],
        // Codex 0.146 records App Server clients initialized as `agentopsdeck`
        // under the `vscode` source kind. Keep `appServer` for newer versions.
        sourceKinds: ['vscode', 'appServer'],
        archived: false,
      }, remaining());
      remaining();
      checkConnection();
      if (!isRecord(result) || !Array.isArray(result.data)
        || result.data.length > CODEX_SESSION_LIST_PAGE_SIZE
        || result.data.some(thread => !isRecord(thread) || !stringValue(thread.id))
        || (result.nextCursor != null && !stringValue(result.nextCursor))) {
        throw new Error('Invalid Codex session list');
      }
      cursor = stringValue(result.nextCursor) ?? null;
      if (cursor && cursors.has(cursor)) throw new Error('Invalid Codex session list cursor cycle');
      if (cursor) cursors.add(cursor);
      for (const thread of result.data) {
        this.restoreThread(thread, connectionId);
        checkConnection();
      }
    } while (cursor);
    remaining();
    return connectionId;
  }

  private restoreThread(thread: any, connectionId = this.connectionId) {
    const threadId = stringValue(thread?.id);
    if (!threadId) return;
    const sessionKey = this.sessionKey(threadId);
    const updatedAt = secondsToMilliseconds(thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt) ?? Date.now();
    const modelProvider = stringValue(thread?.modelProvider);
    if (connectionId !== this.connectionId) throw new Error('Codex session list connection changed');
    const model = this.threadModelOverrides.get(threadId) ?? this.threadModels.get(threadId);
    if (model !== undefined) this.threadModels.set(threadId, model);
    const current = this.options.store.getSession(sessionKey);
    this.options.store.upsertSession(this.session(sessionKey, {
      ...current,
      title: codexThreadTitle(thread),
      ...(!current ? { status: 'unknown' as const, hasActiveRun: false } : {}),
      lastActiveAt: updatedAt,
      ...(model !== undefined ? { model } : {}),
      ...(modelProvider ? { modelProvider } : {}),
    }));
  }

  private async syncThreadLifecycle(sessionKey: string, thread: any, connectionId: string | undefined, execution: CodexExecution | undefined,
    outcomeUnknown?: boolean, localCurrent: () => boolean = () => true) {
    if (!localCurrent()) return;
    const current = this.options.store.getSession(sessionKey);
    if (!current || !thread) return;
    if (execution || (!this.options.nativeJournal && this.legacyExecutions.get(sessionKey))) {
      this.publishThreadActivity(sessionKey, snapshotRuntime(thread, Date.now()).threadActivity!);
      // A lost completion notification may be followed by native Goal turns.
      // Recover the acknowledged turn, never adopt the successor's identity.
      // This only establishes its outcome; final reconciliation must still
      // prove Goal/children/terminals quiescent before permitting new input.
      const successorOwner = terminalSuccessorOwner(thread, execution?.runId);
      const turn = successorOwner ?? arrayValue(thread.turns).at(-1);
      if (!this.closed && !this.executionUnavailable && connectionId && connectionId === this.connectionId
        && execution?.phase === 'unknown' && execution.reason === 'restarted'
        && thread.id === this.threadId(sessionKey) && (thread.status?.type === 'idle' || successorOwner)
        && turn?.id === execution.runId && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
        const changed = this.options.nativeJournal
          ? await this.options.nativeJournal.recoverTerminal(execution, turn.id, turn.status)
          : this.legacyExecutions.recoverTerminal(execution, turn.id, turn.status);
        if (!localCurrent()) return;
        if (changed && successorOwner) {
          this.goalDiagnostics.trace(sessionKey, connectionId, 'recovery')('owned_terminal_recovered', { version: execution.revision });
        }
      }
      if (!this.closed && !this.executionUnavailable && connectionId && connectionId === this.connectionId && execution?.connectionId === connectionId
        && execution.phase === 'running' && thread.id === this.threadId(sessionKey)
        && turn?.id === execution.runId && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
        const changed = this.options.nativeJournal
          ? await this.options.nativeJournal.observeTerminal(execution, connectionId, turn.id, turn.status)
          : this.legacyExecutions.observe(sessionKey, connectionId, turn.id, turn.status, execution);
        if (!changed || !localCurrent()) return;
        if (successorOwner) this.goalDiagnostics.trace(sessionKey, connectionId, 'recovery')('owned_terminal_recovered', { version: execution.revision });
        this.handleNotification('turn/completed', { threadId: thread.id, turn });
      }
      return;
    }
    // turn/completed is delivered before every trailing item notification has
    // necessarily been projected.  Completion reconciliation owns the final
    // authoritative message replacement and the running -> idle transition.
    if (this.completingTurns.has(sessionKey)) return;
    const activeTurnId = this.activeTurnIds.get(sessionKey);
    const latestTurnId = stringValue(arrayValue(thread?.turns).at(-1)?.id);
    if (current.runtime?.phase === 'starting') return;
    if ((outcomeUnknown ?? this.legacyTurnQueue.head('codex', sessionKey)?.state === 'outcome_unknown')
      && !activeTurnId && !(current.runtime?.turnId && this.completedTurnIds.get(sessionKey) === current.runtime.turnId)) {
      this.publishRun(sessionKey, { phase: 'unknown', connection: 'connected', sync: 'error', lastEventAt: current.runtime?.lastEventAt ?? Date.now(),
        reason: 'Codex dispatch outcome is unknown' }, { runCompletedAt: undefined });
      return;
    }
    if (activeTurnId && latestTurnId !== activeTurnId) return;
    const now = Date.now();
    const runtime = snapshotRuntime(thread, now);
    if (runtime.turnId === current.runtime?.turnId && runtime.phase === 'running' && current.runtime?.reason
      && [CODEX_RETRY_NOTICE, CODEX_ERROR_NOTICE].includes(current.runtime.reason)) runtime.reason = current.runtime.reason;
    if (runtime.phase === current.runtime?.phase && runtime.turnId === current.runtime?.turnId
      && runtime.threadActivity === current.runtime?.threadActivity) runtime.lastEventAt = current.runtime.lastEventAt;
    // Terminal turn identity is absorbing: an old in-progress read cannot
    // resurrect a completed turn. Unknown/notLoaded is never idle.
    if (latestTurnId && this.completedTurnIds.get(sessionKey) === latestTurnId && runtimeBusy(runtime)) return;
    const unfinishedTool = latestTurnId && this.options.store.getMessages(sessionKey).some((message) => message.turnId === latestTurnId && message.role === 'tool' && message.status === 'sending');
    if (!runtimeBusy(runtime) && (activeTurnId || current.runtime?.sync === 'error' || unfinishedTool)) {
      if (latestTurnId) this.completedTurnIds.delete(sessionKey);
      this.handleNotification('turn/completed', { threadId: this.threadId(sessionKey), turn: arrayValue(thread.turns).at(-1) });
      return;
    }
    if (runtimeBusy(runtime) && latestTurnId) this.activeTurnIds.set(sessionKey, latestTurnId);
    const turn = arrayValue(thread?.turns).at(-1);
    this.publishRun(sessionKey, runtime, runtimeBusy(runtime)
      ? { runStartedAt: codexTimestampMilliseconds(turn?.startedAt) ?? current.runStartedAt ?? now, runCompletedAt: undefined }
      : { runCompletedAt: codexTimestampMilliseconds(turn?.completedAt) ?? current.runCompletedAt }, 'native-snapshot');
  }

  private projectionVersion(sessionKey: string) { return this.projectionVersions.get(sessionKey) ?? 0; }

  private historyAssistantProjector(sessionKey: string, deadline: number): CodexAssistantProjector | undefined {
    const projector = this.options.projectAssistant;
    if (!projector) return undefined;
    return async text => {
      const pending = this.assistantProjections.get(sessionKey) ?? new Set<Promise<void>>();
      let remaining = deadline - performance.now();
      // A previous observation may have timed out. Keep its ORIGINAL task in
      // the same live/shutdown ownership set; a new read cannot replace it.
      if (pending.size && remaining > 0) {
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...pending]),
            new Promise<void>(resolve => { waitTimer = setTimeout(resolve, Math.max(1, Math.min(80, Math.ceil(remaining)))); }),
          ]);
        } finally { clearTimeout(waitTimer); }
        remaining = deadline - performance.now();
      }
      if (pending.size || remaining <= 0) throw new HistoricalProjectionPendingError();
      const original = Promise.resolve().then(() => projector(text));
      const tracked = original.then(() => { pending.delete(tracked); }, () => {
        pending.delete(tracked);
        // Never stringify projector exceptions, user text, paths or tokens.
        try { console.warn('[codex-assistant-projection-failed]', { stage: 'history-projection', fault: 'unavailable' }); }
        catch { /* An observer cannot change original task settlement. */ }
      });
      pending.add(tracked);
      this.assistantProjections.set(sessionKey, pending);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([original, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HistoricalProjectionPendingError()), Math.max(1, Math.ceil(remaining)));
        })]);
      } finally { clearTimeout(timer); }
    };
  }

  /** Coalesce only overlapping metadata reads, never native safety checkpoints
   * or writes. Each control caller still rechecks its own authority afterward. */
  private observeGoal(sessionKey: string, maxTimeoutMs = 2000): Promise<{ raw: unknown; version: number }> {
    const { connection, check } = this.goalControlGuard(sessionKey, () => {});
    const child = this.child, generation = this.nativeConnectionGeneration;
    const current = () => {
      check();
      if (child !== this.child || generation !== this.nativeConnectionGeneration) throw new GoalControlConflict();
    };
    const timeoutMs = Math.min(this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS, maxTimeoutMs);
    const version = this.goalObservationVersions.get(sessionKey) ?? 0;
    const pending = this.goalObservationInflight.get(sessionKey);
    if (pending?.connection === connection && pending.version === version && pending.timeoutMs >= timeoutMs) {
      pending.trace('read_joined', { version });
      return pending.task;
    }
    const trace = this.goalDiagnostics.trace(sessionKey, connection, 'read');
    trace('read_started', { version });
    const task = (async () => {
      try {
        const deleted = this.options.nativeJournal ? (await this.readHistoryFact(sessionKey)).deleted
          : this.legacyExecutions.isDeletedTerminal(sessionKey);
        current();
        if (deleted) throw new GoalControlConflict();
        const raw = await this.request('thread/goal/get', { threadId: this.threadId(sessionKey) }, timeoutMs);
        const nowDeleted = this.options.nativeJournal ? (await this.readHistoryFact(sessionKey)).deleted
          : this.legacyExecutions.isDeletedTerminal(sessionKey);
        current();
        if (nowDeleted
          || version !== (this.goalObservationVersions.get(sessionKey) ?? 0)) throw new GoalControlConflict();
        this.projectGoal(sessionKey, raw, this.threadId(sessionKey));
        trace('read_completed', { version, currentVersion: this.goalObservationVersions.get(sessionKey) });
        return { raw, version: this.goalObservationVersions.get(sessionKey)! };
      } catch (error) {
        trace(error instanceof GoalControlConflict ? 'read_conflict' : 'read_failed',
          { version, currentVersion: this.goalObservationVersions.get(sessionKey) });
        throw error;
      }
    })().finally(() => {
      if (this.goalObservationInflight.get(sessionKey)?.task === task) this.goalObservationInflight.delete(sessionKey);
    });
    this.goalObservationInflight.set(sessionKey, { connection, version, timeoutMs, task, trace });
    return task;
  }

  private projectGoal(sessionKey: string, result: unknown, threadId: string) {
    const current = this.options.store.getSession(sessionKey);
    if (!current) return;
    this.goalObservationVersions.set(sessionKey, (this.goalObservationVersions.get(sessionKey) ?? 0) + 1);
    const goal = readCodexGoal(result, threadId);
    if (JSON.stringify(current.codexGoal ?? null) !== JSON.stringify(goal ?? null)) {
      this.goalExecutionVersions.set(sessionKey, (this.goalExecutionVersions.get(sessionKey) ?? 0) + 1);
    }
    if (JSON.stringify(current.codexGoal) === JSON.stringify(goal)) return;
    const { codexGoal: previous, ...rest } = current;
    this.options.store.upsertSession(goal === undefined ? rest : { ...rest, codexGoal: goal });
    // Metadata only. Do not invalidate the history verification performing this
    // read, adopt a successor run, wake work, or issue another native request.
    if (!this.projectionVersions.has(sessionKey)) this.projectionVersions.set(sessionKey, 0);
  }

  private hydrateGoal(sessionKey: string, fresh = false): Promise<void> {
    const pending = this.goalReadInflight.get(sessionKey);
    if (pending) return pending;
    if (this.closed || this.executionUnavailable || !this.connectionId
      || (!this.options.nativeJournal && this.legacyExecutions.isDeletedTerminal(sessionKey))
      || !this.options.store.getSession(sessionKey)
      || !fresh && (this.goalReadAttempted.has(sessionKey) || this.options.store.getSession(sessionKey)?.codexGoal !== undefined)) return Promise.resolve();
    const connectionId = this.connectionId, version = this.goalObservationVersions.get(sessionKey) ?? 0;
    const child = this.child, generation = this.nativeConnectionGeneration;
    const threadId = this.threadId(sessionKey);
    this.goalReadAttempted.add(sessionKey);
    const current = () => !this.closed && !this.executionUnavailable && connectionId === this.connectionId
      && child === this.child && generation === this.nativeConnectionGeneration
      && version === (this.goalObservationVersions.get(sessionKey) ?? 0);
    const task = (async () => {
      try {
        await this.observeGoal(sessionKey);
      } catch {
        try {
          const deleted = this.options.nativeJournal ? (await this.readHistoryFact(sessionKey)).deleted
            : this.legacyExecutions.isDeletedTerminal(sessionKey);
          if (current() && !deleted) this.projectGoal(sessionKey, undefined, threadId);
        } catch { /* Unknown worker observation cannot publish a metadata fallback. */ }
      }
    })().finally(() => { if (this.goalReadInflight.get(sessionKey) === task) this.goalReadInflight.delete(sessionKey); });
    this.goalReadInflight.set(sessionKey, task);
    return task;
  }

  private projectUsage(sessionKey: string, usage: Partial<SessionSummary>) {
    const current = this.options.store.getSession(sessionKey);
    if (!current || !Object.entries(usage).some(([key, value]) => current[key as keyof SessionSummary] !== value)) return;
    this.options.store.upsertSession({ ...current, ...usage });
  }

  private touchProjection(sessionKey: string) {
    this.displayHistory.delete(sessionKey);
    this.projectionVersions.set(sessionKey, this.projectionVersion(sessionKey) + 1);
  }

  private publishThreadActivity(sessionKey: string, threadActivity: NonNullable<AgentRuntime['threadActivity']>) {
    const runtime = this.options.store.getSession(sessionKey)?.runtime;
    if (runtime && runtime.threadActivity !== threadActivity) {
      this.publishRun(sessionKey, { ...runtime, threadActivity, lastEventAt: Date.now() }, {}, 'native-activity');
    }
  }

  private publishRun(sessionKey: string, runtime: AgentRuntime, timing: { runStartedAt?: number; runCompletedAt?: number | undefined; lastActiveAt?: number } = {}, source: RuntimeDiagnosticSource = 'runtime') {
    const current = this.options.store.getSession(sessionKey);
    if (!current) return;
    const next = { ...current, ...timing };
    if (next.runCompletedAt === undefined) delete next.runCompletedAt;
    const projected = projectRuntime(next as SessionSummary, {
      ...runtime, ...(!runtime.threadActivity && current.runtime?.threadActivity ? { threadActivity: current.runtime.threadActivity } : {}),
    });
    if (JSON.stringify(current) === JSON.stringify(projected)) return;
    this.touchProjection(sessionKey);
    this.options.store.upsertSession(projected);
    try {
      this.runtimeDiagnostics.transition(sessionKey, this.connectionId, current.runtime, projected.runtime!, source,
        // Diagnostics may use the display snapshot, never reopen the legacy
        // writer merely to decorate an already-committed publication.
        (this.options.nativeJournal?.projection ?? this.legacyExecutions).get(sessionKey));
    } catch { /* Diagnostics cannot fail a committed runtime publication. */ }
  }

  private markDisconnected(error: Error) {
    if (this.executionUnavailable) return;
    for (const sessionKey of this.projectionVersions.keys()) {
      const current = this.options.store.getSession(sessionKey);
      if (!current?.runtime) continue;
      this.publishRun(sessionKey, { ...current.runtime, connection: 'disconnected', sync: 'error', reason: error.message }, {}, 'disconnect');
    }
  }

  private setConnection(id: string | undefined) {
    if (id === this.connectionId) return;
    const previousConnectionId = this.connectionId ?? this.disconnectedConnectionId;
    // Disconnection alone must not launch native work. Make the old lease
    // recoverable only once an independently established connection exists.
    this.disconnectedConnectionId = id ? undefined : previousConnectionId;
    this.interactions?.reset();
    this.boardTools.reset();
    this.maintenanceEpoch++;
    this.nativeUnscopedActivityEpoch++;
    this.nativeActivityVersions.clear();
    this.connectionId = id;
    const generation = ++this.nativeConnectionGeneration;
    this.automationConnectedSince = id ? Date.now() : 0;
    this.automationCompletions.reset();
    this.goalReadAttempted.clear();
    this.goalReadInflight.clear();
    this.goalObservationInflight.clear();
    this.unmaterializedThreadIds.clear();
    this.refreshedAt = 0;
    this.threadRefreshResult.clear();
    this.displayHistory.clear();
    this.nativeObservations.accept(() => this.observeConnection(id, previousConnectionId, generation), 0, 2);
  }

  private settleNativeConnectionPage(after: string, previousConnectionId: string | undefined, nextConnectionId: string | undefined): string[] | Promise<string[]> {
    if (this.options.nativeJournal) return this.options.nativeJournal.settleConnectionPage(after, previousConnectionId, nextConnectionId);
    return settleCodexConnectionRecoveryPage({ after, limit: 64, previousConnectionId: previousConnectionId ?? null,
      nextConnectionId: nextConnectionId ?? null }, this.legacyExecutions);
  }

  private observeConnection(id: string | undefined, previousConnectionId: string | undefined, generation: number): void | Promise<void> {
    if (this.executionUnavailable) return;
    const finish = () => {
      if (generation === this.nativeConnectionGeneration) {
        for (const key of this.projectionVersions.keys()) {
          this.projectGoal(key, undefined, this.threadId(key));
          if (this.options.store.getSession(key)?.runtime?.threadActivity) this.publishThreadActivity(key, 'unknown');
        }
        this.options.store.projectCodexConnection();
      }
    };
    const advance = (keys: string[], after: string): string | undefined => {
      if (!Array.isArray(keys) || keys.length > 64 || keys.some((key, index) => typeof key !== 'string'
        || !key || key.includes('\0') || Buffer.byteLength(key) > 4096 || Buffer.compare(Buffer.from(key), Buffer.from(after)) <= 0
        || index > 0 && Buffer.compare(Buffer.from(keys[index - 1]!), Buffer.from(key)) >= 0)) {
        throw new Error('Codex connection recovery page unavailable');
      }
      return keys.length === 64 ? keys.at(-1)! : undefined;
    };
    const drain = (after: string): void | Promise<void> => {
      // Finish all accepted protection work, even after a new generation was
      // installed. Its queued observer runs next; only final projection is
      // generation-bound. No cancellation pretends a physical page stopped.
      for (;;) {
        const page = this.settleNativeConnectionPage(after, previousConnectionId, id);
        if (types.isPromise(page)) return Promise.prototype.then.call(page, (keys: string[]) => {
          const next = advance(keys, after);
          return next === undefined ? finish() : drain(next);
        }) as Promise<void>;
        const next = advance(page, after);
        if (next === undefined) { finish(); return; }
        after = next;
      }
    };
    try {
      // Native-process replacement invalidates observations even when the
      // Connector itself did not restart and there is no queued successor.
      return drain('');
    }
    catch { this.nativeObservations.unavailable(2); }
  }

  private async ensureThreadLoaded(threadId: string) {
    if (this.loadedThreadIds.has(threadId)) return;
    const resumeEffort = this.threadResumeEffort(threadId);
    await this.request('thread/resume', {
      threadId,
      ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}),
      cwd: this.options.defaultCwd,
      ...(this.threadModels.get(threadId) ? { model: this.threadModels.get(threadId) } : {}),
      ...(resumeEffort ? { effort: resumeEffort } : {}),
      approvalPolicy: this.options.approvalPolicy,
      sandbox: 'danger-full-access',
      developerInstructions: `${CODEX_MEDIA_BUDGET_INSTRUCTIONS} ${CODEX_AUTONOMY_INSTRUCTIONS}`,
    });
    this.loadedThreadIds.add(threadId);
  }

  private erroredThreadReloads = new Map<string, { identity: string; effectStarted: boolean; reloading: boolean }>();

  private async loadFailedContinuation(
    sessionKey: string,
    authorize: () => void,
    continuation: NativeResumeInput['continuation'] = null,
  ) {
    let observed = await this.readHistoryFact(sessionKey);
    const expected = observed.execution, connectionId = this.connectionId;
    if (observed.deleted || observed.outcomeUnknown || !expected?.runId || expected.phase !== 'failed'
      || expected.sync !== 'error' || expected.nativeHistory || expected.preparation || expected.reason || !connectionId) return;
    const threadId = this.threadId(sessionKey), version = this.projectionVersion(sessionKey);
    const check = (allowProtectionOnly = false) => {
      const journaled = Boolean(this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal?.prepareResume);
      authorize();
      const current = this.options.nativeJournal ? observed.execution : this.legacyExecutions.get(sessionKey);
      if (this.closed || this.executionUnavailable || connectionId !== this.connectionId
        || (this.options.nativeJournal ? observed.deleted || observed.outcomeUnknown : this.legacyExecutions.isDeletedTerminal(sessionKey))
        || !current
        || (current.revision !== expected.revision && !(allowProtectionOnly && journaled && resumeProtectionOnly(expected, current)))
        || current.commandId !== expected.commandId
        || current.runId !== expected.runId
        || this.projectionVersion(sessionKey) !== version) throw new RunControlConflict();
    };
    check();
    const before = historyThread(await this.request('thread/read', { threadId, includeTurns: true }), threadId);
    observed = await this.readHistoryFact(sessionKey);
    check();
    if (before.status?.type !== 'notLoaded' || before.turns.at(-1)?.id !== expected.runId
      || before.turns.at(-1)?.status !== expected.phase || typeof before.path !== 'string' || !before.path.trim()
      || before.turns.some((turn: any) => !['completed', 'failed', 'interrupted'].includes(turn.status)
        || hasNativeChildWork(turn.items, threadId))) return;
    const goal = nativeGoalEvidence(await this.request('thread/goal/get', { threadId }), threadId);
    observed = await this.readHistoryFact(sessionKey);
    if (nativeGoalProtection(goal.status)) return;
    check();
    await this.validateRolloutSnapshot(before.path);
    observed = await this.readHistoryFact(sessionKey);
    check();
    this.loadedThreadIds.delete(threadId);
    const fingerprint = nativeHistoryFingerprint(before);
    await this.resumeRecoveredThread(expected, threadId, fingerprint, () => check(false), continuation, undefined, true);
    observed = await this.readHistoryFact(sessionKey);
    check(true);
    const after = historyThread(await this.request('thread/read', { threadId, includeTurns: true }), threadId);
    observed = await this.readHistoryFact(sessionKey);
    check(true);
    if (after.status?.type !== 'idle' || fingerprint !== nativeHistoryFingerprint(after)) throw new RunControlConflict();
    const afterGoal = nativeGoalEvidence(await this.request('thread/goal/get', { threadId }), threadId);
    observed = await this.readHistoryFact(sessionKey);
    check(true);
    if (nativeGoalProtection(afterGoal.status) || afterGoal.version !== goal.version) throw new RunControlConflict();
    this.loadedThreadIds.add(threadId);
  }

  private async reloadErroredTerminal(sessionKey: string, result: any,
    nativeRead: (method: string, params: unknown, timeoutMs?: number) => Promise<any> = this.request.bind(this),
    authorityCheck: () => void = () => {}) {
    if (result?.thread?.status?.type !== 'systemError') return result;
    let observed = await this.readHistoryFact(sessionKey);
    const expected = observed.execution, connectionId = this.connectionId;
    let gate = 'eligibility';
    const report = (fault: string) => this.historyDiagnostics.failure('recovery', sessionKey, connectionId, expected?.runId,
      { stage: 'terminal-reload', fault, gate });
    const hasResumeJournal = Boolean(this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal?.prepareResume);
    if (hasResumeJournal || observed.deleted || observed.outcomeUnknown || !expected?.runId || !connectionId
      || expected.connectionId !== connectionId || expected.phase !== 'failed'
      || expected.preparation || expected.reason || !expected.completedAt) { report('protected'); return result; }
    const identity = `${connectionId}:${expected.runId}`;
    gate = 'single-attempt';
    if (this.erroredThreadReloads.get(sessionKey)?.identity === identity) { report('protected'); return result; }
    // Reserve before awaiting preflight to exclude concurrent recovery. Only a
    // no-effect attempt may be retried: a lost unsubscribe/resume ACK must never
    // turn a repeated history read into a repeated native mutation.
    const reservation = { identity, effectStarted: false, reloading: true };
    this.erroredThreadReloads.set(sessionKey, reservation);
    try {
      const version = this.projectionVersion(sessionKey), threadId = this.threadId(sessionKey);
      const check = (allowProtectionOnly = false) => {
        const journaled = Boolean(this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal?.prepareResume);
        authorityCheck();
        const current = this.options.nativeJournal ? observed.execution : this.legacyExecutions.get(sessionKey);
        if (this.closed || this.executionUnavailable || connectionId !== this.connectionId
          || (this.options.nativeJournal ? observed.deleted || observed.outcomeUnknown : this.legacyExecutions.isDeletedTerminal(sessionKey))
          || !current
          || (current.revision !== expected.revision && !(allowProtectionOnly && journaled && resumeProtectionOnly(expected, current)))
          || current.commandId !== expected.commandId
          || current.runId !== expected.runId || this.projectionVersion(sessionKey) !== version) throw new RunControlConflict();
      };
      const read = async (method: string, params: unknown, timeoutMs?: number) => {
        const response = await nativeRead(method, params, timeoutMs);
        observed = await this.readHistoryFact(sessionKey);
        return response;
      };
      check();
      gate = 'native-schema';
      const before = historyThread({ thread: { ...result.thread, status: { type: 'idle' } } }, threadId);
      const head = before.turns.at(-1);
      const skip = () => { report('protected'); return result; };
      gate = 'path';
      if (typeof before.path !== 'string' || !before.path.trim()) return skip();
      gate = 'head';
      if (head?.id !== expected.runId || head.status !== expected.phase) return skip();
      gate = 'active-history';
      if (before.turns.some((turn: any) => !['completed', 'failed', 'interrupted'].includes(turn.status))) return skip();
      gate = 'child-work';
      if (before.turns.some((turn: any) => hasNativeChildWork(turn.items, threadId))) return skip();
      gate = 'goal';
      const goal = nativeGoalEvidence(await read('thread/goal/get', { threadId }), threadId);
      if (nativeGoalProtection(goal.status)) return skip();
      check();
      gate = 'background-work';
      if ((await backgroundTerminals(read, threadId, check)).length) return skip();
      gate = 'rollout';
      await this.validateRolloutSnapshot(before.path);
      observed = await this.readHistoryFact(sessionKey);
      check();
      gate = 'unsubscribe';
      reservation.effectStarted = true;
      const unloaded = await read('thread/unsubscribe', { threadId });
      if (unloaded?.status === 'unsubscribed' && connectionId === this.connectionId) this.loadedThreadIds.delete(threadId);
      check();
      if (unloaded?.status !== 'unsubscribed') return skip();
      gate = 'resume';
      await this.resumeRecoveredThread(expected, threadId, nativeHistoryFingerprint(before), () => check(false));
      observed = await this.readHistoryFact(sessionKey);
      check(true);
      gate = 'confirm';
      const refreshed = await read('thread/read', { threadId, includeTurns: true });
      check(true);
      const after = historyThread(refreshed, threadId);
      gate = 'confirm-status';
      if (after.status?.type !== 'idle') throw new RunControlConflict();
      gate = 'confirm-history';
      if (nativeHistoryFingerprint(after) !== nativeHistoryFingerprint(before)) throw new RunControlConflict();
      gate = 'confirm-goal';
      const afterGoal = nativeGoalEvidence(await read('thread/goal/get', { threadId }), threadId);
      if (nativeGoalProtection(afterGoal.status) || afterGoal.version !== goal.version) throw new RunControlConflict();
      check(true);
      this.loadedThreadIds.add(threadId);
      gate = 'recovered';
      report('recovered');
      return refreshed;
    } catch (error) {
      report(error instanceof RunControlConflict ? 'authority-changed' : 'unavailable');
      throw error;
    } finally {
      reservation.reloading = false;
      if (!reservation.effectStarted && this.erroredThreadReloads.get(sessionKey) === reservation) {
        this.erroredThreadReloads.delete(sessionKey);
      }
    }
  }

  /** Journaled systemError reload for owned-journal mode: persists the durable
   * resume intent BEFORE thread/unsubscribe or thread/resume so a crash or
   * lost ACK can never leave an unjournaled native mutation. */
  private async reloadJournaledErroredTerminal(sessionKey: string, result: any,
    nativeRead: (method: string, params: unknown, timeoutMs?: number) => Promise<any> = this.request.bind(this),
    authorityCheck: () => void = () => {},
    continuation: NativeResumeInput['continuation'] = null) {
    if (result?.thread?.status?.type !== 'systemError') return result;
    const journal = this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal;
    let observed = await this.readHistoryFact(sessionKey);
    const expected = observed.execution, connectionId = this.connectionId;
    const child = this.child, generation = this.nativeConnectionGeneration;
    let gate = 'eligibility';
    const report = (fault: string) => this.historyDiagnostics.failure('recovery', sessionKey, connectionId, expected?.runId,
      { stage: 'terminal-reload', fault, gate });
    if (!journal?.prepareResume || observed.deleted || observed.outcomeUnknown || !expected?.runId || !connectionId
      || expected.connectionId !== connectionId || expected.phase !== 'failed'
      || expected.preparation || expected.reason || !expected.completedAt || this.authorizingEffects.size >= 128) {
      report('protected'); return result;
    }
    const identity = `${connectionId}:${expected.runId}`;
    gate = 'single-attempt';
    if (this.erroredThreadReloads.get(sessionKey)?.identity === identity) { report('protected'); return result; }
    const reservation = { identity, effectStarted: false, reloading: true };
    this.erroredThreadReloads.set(sessionKey, reservation);
    try {
      const version = this.projectionVersion(sessionKey), threadId = this.threadId(sessionKey);
      const local = () => {
        if (this.closed || this.executionUnavailable || connectionId !== this.connectionId
          || child !== this.child || generation !== this.nativeConnectionGeneration) throw new RunControlConflict();
      };
      const check = (allowProtectionOnly = false) => {
        authorityCheck();
        local();
        const current = this.options.nativeJournal ? observed.execution : this.legacyExecutions.get(sessionKey);
        if ((this.options.nativeJournal ? observed.deleted || observed.outcomeUnknown : this.legacyExecutions.isDeletedTerminal(sessionKey))
          || !current
          || (current.revision !== expected.revision && !(allowProtectionOnly && resumeProtectionOnly(expected, current)))
          || current.commandId !== expected.commandId
          || current.runId !== expected.runId || this.projectionVersion(sessionKey) !== version) throw new RunControlConflict();
      };
      const read = async (method: string, params: unknown, timeoutMs?: number) => {
        const response = await nativeRead(method, params, timeoutMs);
        observed = await this.readHistoryFact(sessionKey);
        return response;
      };
      check();
      gate = 'native-schema';
      const before = historyThread({ thread: { ...result.thread, status: { type: 'idle' } } }, threadId);
      const head = before.turns.at(-1);
      const skip = () => { report('protected'); return result; };
      gate = 'path';
      if (typeof before.path !== 'string' || !before.path.trim()) return skip();
      gate = 'head';
      if (head?.id !== expected.runId || head.status !== expected.phase) return skip();
      gate = 'active-history';
      if (before.turns.some((turn: any) => !['completed', 'failed', 'interrupted'].includes(turn.status))) return skip();
      gate = 'child-work';
      if (before.turns.some((turn: any) => hasNativeChildWork(turn.items, threadId))) return skip();
      gate = 'goal';
      const goal = nativeGoalEvidence(await read('thread/goal/get', { threadId }), threadId);
      if (nativeGoalProtection(goal.status)) return skip();
      check();
      gate = 'background-work';
      if ((await backgroundTerminals(read, threadId, check)).length) return skip();
      gate = 'rollout';
      await this.validateRolloutSnapshot(before.path);
      observed = await this.readHistoryFact(sessionKey);
      check();
      const fingerprint = nativeHistoryFingerprint(before);
      const resumeParams = { threadId, excludeTurns: true,
        ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}) };
      const effect = Promise.resolve().then(async () => {
        let receipt: NativeResumeReceipt | null = null, preparing = false, dispatched = false, finished = false;
        const resume = async () => {
          gate = 'resume';
          const response = await this.request('thread/resume', resumeParams, undefined, undefined,
            () => { local(); authorityCheck(); dispatched = true; });
          gate = 'resume-ack';
          const thread = response?.thread;
          if (thread?.id !== threadId || !['idle', 'active', 'systemError'].includes(thread.status?.type)) {
            throw new NativeHistoryReadError('schema', 'Invalid Codex resume acknowledgement');
          }
          return thread.status.type;
        };
        try {
          gate = 'journal-prepare';
          local(); check();
          preparing = true;
          receipt = await journal.prepareResume({
            expected: {
              sessionKey: expected.sessionKey, commandId: expected.commandId,
              connectionId: expected.connectionId, runId: expected.runId!, revision: expected.revision,
            },
            nativeConnectionId: connectionId, threadId, fingerprint, continuation,
          });
          preparing = false;
          if (!receipt) throw new RunControlConflict();
          gate = 'journal-begin';
          local(); check();
          if (!await journal.beginResume(receipt)) throw new RunControlConflict();
          local(); check();
          gate = 'unsubscribe';
          reservation.effectStarted = true;
          const unloaded = await this.request('thread/unsubscribe', { threadId }, undefined, undefined,
            () => { local(); authorityCheck(); dispatched = true; });
          if (unloaded?.status === 'unsubscribed' && connectionId === this.connectionId) this.loadedThreadIds.delete(threadId);
          local(); authorityCheck();
          if (unloaded?.status !== 'unsubscribed') throw new RunControlConflict();
          let resumedStatus = await resume();
          // codex-cli 0.147+ keeps systemError threads loaded across thread/unsubscribe;
          // archive -> unarchive -> resume genuinely evicts the errored in-memory state
          // while preserving turns, path, title, and goal.
          if (resumedStatus === 'systemError') {
            local(); authorityCheck();
            gate = 'archive';
            await this.request('thread/archive', { threadId }, undefined, undefined,
              () => { local(); authorityCheck(); dispatched = true; });
            if (connectionId === this.connectionId) this.loadedThreadIds.delete(threadId);
            local(); authorityCheck();
            gate = 'unarchive';
            await this.request('thread/unarchive', { threadId }, undefined, undefined,
              () => { local(); authorityCheck(); dispatched = true; });
            local(); authorityCheck();
            resumedStatus = await resume();
          }
          gate = 'journal-finish';
          if (!await journal.finishResume(receipt, 'acknowledged')) throw new RunControlConflict();
          finished = true;
          if (resumedStatus === 'systemError') throw new NativeHistoryReadError('system-error', 'Codex thread unavailable');
          local();
        } catch (error) {
          if (preparing) this.invalidateExecution();
          else if (receipt && !dispatched) {
            try { if (!await journal.finishResume(receipt, 'not_dispatched')) this.invalidateExecution(); }
            catch { this.invalidateExecution(); }
          } else if (dispatched && !finished) this.invalidateExecution();
          throw error;
        }
      });
      const physical = new Promise<void>(resolve => { void Promise.prototype.then.call(effect, () => resolve(), () => resolve()); });
      this.authorizingEffects.add(physical);
      void physical.then(() => { this.authorizingEffects.delete(physical); });
      await effect;
      observed = await this.readHistoryFact(sessionKey);
      check(true);
      gate = 'confirm';
      const refreshed = await read('thread/read', { threadId, includeTurns: true });
      check(true);
      const after = historyThread(refreshed, threadId);
      gate = 'confirm-status';
      if (after.status?.type !== 'idle') throw new RunControlConflict();
      gate = 'confirm-history';
      if (nativeHistoryFingerprint(after) !== fingerprint) throw new RunControlConflict();
      gate = 'confirm-goal';
      const afterGoal = nativeGoalEvidence(await read('thread/goal/get', { threadId }), threadId);
      if (nativeGoalProtection(afterGoal.status) || afterGoal.version !== goal.version) throw new RunControlConflict();
      check(true);
      this.loadedThreadIds.add(threadId);
      gate = 'recovered';
      report('recovered');
      return refreshed;
    } catch (error) {
      report(error instanceof RunControlConflict ? 'authority-changed'
        : error instanceof NativeHistoryReadError ? error.fault : 'unavailable');
      throw error;
    } finally {
      reservation.reloading = false;
      if (!reservation.effectStarted && this.erroredThreadReloads.get(sessionKey) === reservation) {
        this.erroredThreadReloads.delete(sessionKey);
      }
    }
  }

  private validateRuntimeOverrides(parsed: unknown, content?: string) {
    if (!isRecord(parsed)) throw new SessionPreferencePersistenceError();
    const entries = Object.entries(parsed);
    if (entries.length > MAX_RUNTIME_OVERRIDE_ENTRIES || entries.some(([threadId, model]) =>
      !threadId.trim() || threadId.length > MAX_RUNTIME_OVERRIDE_VALUE_CHARS
      || typeof model !== 'string' || model.length > MAX_RUNTIME_OVERRIDE_VALUE_CHARS)) {
      throw new SessionPreferencePersistenceError();
    }
    const text = content ?? JSON.stringify(parsed, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_RUNTIME_OVERRIDE_BYTES) throw new SessionPreferencePersistenceError();
    return { overrides: new Map(entries.map(([threadId, model]) => [threadId, (model as string).trim()])), text };
  }

  private readRuntimeOverrides(file: string): Map<string, string> {
    try {
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      let content: string;
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size > MAX_RUNTIME_OVERRIDE_BYTES) throw new SessionPreferencePersistenceError();
        const buffer = Buffer.alloc(MAX_RUNTIME_OVERRIDE_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = readSync(descriptor, buffer, size, buffer.length - size, null);
          if (!read) break;
          size += read;
        }
        if (size > MAX_RUNTIME_OVERRIDE_BYTES) throw new SessionPreferencePersistenceError();
        content = buffer.toString('utf8', 0, size);
      } finally { closeSync(descriptor); }
      return this.validateRuntimeOverrides(JSON.parse(content), content).overrides;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { if (lstatSync(file).isSymbolicLink()) throw new SessionPreferencePersistenceError(); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw new SessionPreferencePersistenceError(); }
        return new Map(this.threadModelOverrides);
      }
      throw new SessionPreferencePersistenceError();
    }
  }

  private changeRuntimeOverride(threadId: string, model: string, requestedModel?: string | null): Map<string, string> {
    this.validateRuntimeOverrides({ [threadId]: requestedModel ?? model });
    const file = this.options.runtimeOverridesFile;
    const next = file ? this.readRuntimeOverrides(file) : new Map(this.threadModelOverrides);
    next.set(threadId, model);
    const validated = this.validateRuntimeOverrides(Object.fromEntries(next));
    if (file) this.saveRuntimeOverrides(file, validated.text);
    return validated.overrides;
  }

  private saveRuntimeOverrides(file: string, text: string): void {
    let target = file;
    let mode = 0o600;
    let temporary: string | undefined;
    let descriptor: number | undefined;
    let owned = false;
    try {
      try {
        const entry = lstatSync(file);
        if (entry.isSymbolicLink()) target = realpathSync(file);
        const metadata = statSync(target);
        if (!metadata.isFile() || metadata.nlink > 1) throw new SessionPreferencePersistenceError();
        mode = metadata.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { if (lstatSync(file).isSymbolicLink()) throw new SessionPreferencePersistenceError(); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      }
      mkdirSync(path.dirname(target), { recursive: true });
      temporary = `${target}.${randomUUID()}.tmp`;
      descriptor = openSync(temporary, 'wx', mode); owned = true;
      writeFileSync(descriptor, text, 'utf8');
      if (process.platform !== 'win32') fchmodSync(descriptor, mode);
      fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, target); owned = false;
    } catch { throw new SessionPreferencePersistenceError(); }
    finally {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      if (owned && temporary) { try { unlinkSync(temporary); } catch {} }
    }
  }

  private loadRuntimeOverrides() {
    const file = this.options.runtimeOverridesFile;
    if (!file) return;
    try {
      this.threadModelOverrides = this.readRuntimeOverrides(file);
    } catch {
      try { console.warn('[codex] Runtime overrides unavailable'); } catch {}
    }
  }

  private effectiveModelProviderEnvironment(): Readonly<Record<string, string | undefined>> {
    const homeEnv = this.options.homeDirectory ? readPrivateCodexHomeEnv(this.options.homeDirectory) : undefined;
    if (!homeEnv) return this.modelProviderEnvironment;
    return Object.freeze(Object.assign(Object.create(null), homeEnv, this.modelProviderEnvironment));
  }

  private async start() {
    if (this.childLifetimes.size) {
      await Promise.all(Array.from(this.childLifetimes.values(), lifetime => lifetime.closed));
    }
    if (this.closed) throw new Error('Codex App Server closed');
    if (this.maintenanceRecovery.getStore()) await this.authorizeMaintenanceRecovery();
    if (!this.options.homeDirectory) throw new Error('Native execution private configuration could not be verified');
    const baseEnv = prepareExecutionHome(this.options.homeDirectory, [this.options.defaultCwd, this.options.command]);
    const providerEnv = this.effectiveModelProviderEnvironment();
    const env = {
      ...baseEnv,
      ...providerEnv,
      ...baseEnv,
      CODEX_HOME: this.options.homeDirectory,
      NO_PROXY: 'localhost,127.0.0.1,::1',
    };
    this.nativeQuestionsSupported = process.platform !== 'win32' && !!this.interactions && await probeDefaultModeQuestions(
      this.options.command, this.options.defaultCwd, this.options.homeDirectory, env);
    if (this.closed) throw new Error('Codex App Server closed');
    if (this.options.toolImageCompatibility) {
      if (this.options.modelProvider !== this.options.toolImageCompatibility.provider) {
        throw new Error('Tool image compatibility requires the selected model provider');
      }
      this.toolImageRelay ??= await createToolImageCompatibilityRelay(this.options.toolImageCompatibility);
      if (this.closed) { await this.toolImageRelay.close(); throw new Error('Codex App Server closed'); }
    }
    const args = [
      '--sandbox', 'danger-full-access',
      '--ask-for-approval', this.options.approvalPolicy,
      ...(this.nativeQuestionsSupported ? ['--enable', defaultModeQuestionFeature] : []),
      ...(this.options.disableRemoteCompaction ? ['--disable', 'remote_compaction_v2'] : []),
      ...(this.options.autoCompactTokenLimit ? ['-c', `model_auto_compact_token_limit=${this.options.autoCompactTokenLimit}`] : []),
      ...(this.toolImageRelay && this.options.toolImageCompatibility
        ? toolImageCompatibilityArguments(this.options.toolImageCompatibility, this.toolImageRelay.baseUrl) : []),
      'app-server',
    ];
    let temporary: string | undefined;
    if (process.platform === 'win32') {
      temporary = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-codex-job-'));
      try { await windowsAsyncControl(SECRET_DIRECTORY_ACL_SCRIPT, { AOD_SECRET_DIRECTORY: temporary }); }
      catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
      if (this.closed) { await rm(temporary, { recursive: true, force: true }); throw new Error('Codex App Server closed'); }
    }
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './windows-app-server-entry.ts' : './windows-app-server-entry.js', import.meta.url);
    const bootstrap = source
      ? ['--input-type=module', '-e', `const {tsImport}=await import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}); await tsImport(${JSON.stringify(entry.href)},${JSON.stringify(entry.href)});`]
      : [fileURLToPath(entry)];
    if (this.maintenanceRecovery.getStore()) {
      try { await this.authorizeMaintenanceRecovery(); }
      catch (error) {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    const child = spawn(process.platform === 'win32' ? process.execPath : this.options.command,
      process.platform === 'win32' ? bootstrap : args, {
      cwd: this.options.defaultCwd,
      stdio: process.platform === 'win32' ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
      env: temporary ? windowsControlEnvironment({ TEMP: temporary, TMP: temporary }) : env,
      windowsHide: true,
      detached: process.platform === 'linux',
    }) as ChildProcessWithoutNullStreams;
    // Registered before asynchronous assignment. An unconfirmed assignment
    // must never let a successor bypass this lifetime by closing the launcher.
    let resolveWindowsDrain!: () => void;
    const windowsDrain = new Promise<void>(resolve => { resolveWindowsDrain = resolve; });
    let windowsLaunchAuthorized = false;
    let stdoutDrain = Promise.resolve();
    const closed = new Promise<void>(resolve => child.once('close', () => {
      this.stopChild(child);
      // A dormant bootstrap cannot have native descendants. Losing assignment
      // before sending launch must not wedge all future starts. Once launch is
      // sent (even with an unknown IPC result), only job evidence may release.
      if (process.platform === 'win32' && !windowsLaunchAuthorized) resolveWindowsDrain();
      const drained = process.platform === 'win32' ? windowsDrain
        : process.platform === 'linux' && child.pid ? waitForLinuxProcessGroupExit(child.pid) : Promise.resolve();
      void Promise.all([drained, stdoutDrain]).then(() => { this.childLifetimes.delete(child); resolve(); });
    }));
    this.childLifetimes.set(child, { closed, stopRequested: false });
    this.child = child;
    const connectionId = nanoid();
    this.setConnection(connectionId);
    child.on('error', (error) => this.recycleChild(child, error));
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.setConnection(undefined);
      this.markDisconnected(new Error(`Codex App Server exited${code === null ? '' : ` (${code})`}`));
      this.loadedThreadIds.clear();
      this.activeTurnIds.clear();
      this.clearTransientBuffers();
      this.rejectAll(new Error(`Codex App Server exited${code === null ? '' : ` (${code})`}`));
    });
    child.stdin.on('error', (error) => this.recycleChild(child, error));
    child.stdout.on('error', (error) => this.recycleChild(child, error));
    child.stderr.on('error', () => {});
    stdoutDrain = consumeCodexOutput(child.stdout, {
      receive: line => { if (this.child === child) this.receive(line); },
      holdIngress: () => this.nativeObservations.holdIngress(),
      pressure: () => this.nativeObservations.pressure(),
    }).catch(error => { this.recycleChild(child, error); });
    drainNativeDiagnostics(child.stderr);
    try {
      if (temporary) {
        if (!child.pid) { await rm(temporary, { recursive: true, force: true }); resolveWindowsDrain(); throw new Error('Windows bootstrap failed'); }
        const job = await WindowsProcessJob.assign(child.pid, temporary);
        const lifetime = this.childLifetimes.get(child)!;
        lifetime.job = job;
        // stop may race assignment, before the guardian was attached.
        if (lifetime.stopRequested) job.stop();
        void job.drained.then(async () => {
          try { await rm(temporary!, { recursive: true, force: true }); }
          catch { console.warn('[codex] Could not clean Windows job compiler directory'); }
          resolveWindowsDrain();
        });
        if (lifetime.stopRequested || this.closed || this.child !== child || this.connectionId !== connectionId) {
          job.stop(); throw new Error('Windows bootstrap ownership changed');
        }
        child.on('message', value => {
          const feature = value as { kind?: unknown; supported?: unknown };
          if (this.child === child && this.connectionId === connectionId && feature.kind === 'features' && typeof feature.supported === 'boolean') {
            this.nativeQuestionsSupported = !!this.interactions && feature.supported;
          }
        });
        windowsLaunchAuthorized = true;
        child.send!({ kind: 'launch', command: this.options.command, args, cwd: this.options.defaultCwd, env, questions: !!this.interactions }, error => {
          if (error) this.recycleChild(child, new Error('Windows bootstrap launch unconfirmed'));
        });
      }
      await this.request('initialize', { clientInfo: { name: 'agentopsdeck', title: AGENTOPSDECK_PRODUCT_NAME, version: AGENTOPSDECK_VERSION }, capabilities: { experimentalApi: true } });
      if (this.closed || this.child !== child || this.connectionId !== connectionId) throw new Error('Codex initialization connection changed');
      this.notify('initialized', {});
      this.turnWorker.wake();
    } catch (error) {
      this.recycleChild(child, error instanceof Error ? error : new Error('Codex initialization failed'));
      throw error;
    }
  }

  /** Await worker authority using the original RPC/ACK transport. Goal receipts
   * retain their separate synchronous durable fence. No retries or startup. */
  private requestAuthorized(method: string, params: unknown, authorize: () => Promise<void>, local: () => void,
    timeoutMs = this.options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS, beforeEffect?: () => void, goalReceipt?: GoalWriteReceipt,
    trackEffect = true) {
    if (this.closed || this.authorizingEffects.size >= 128) return Promise.reject(new Error('Codex effect authorization unavailable'));
    const child = this.child, connection = this.connectionId, generation = this.nativeConnectionGeneration;
    // A drained observation queue is not proof of unchanged native activity.
    // Check before dispatchRequest records our own effect, never after its ACK.
    const threadId = stringValue((params as any)?.threadId);
    const activity = threadId ? this.nativeHistoryActivityGuard(threadId) : undefined;
    const check = () => {
      if (this.closed || this.executionUnavailable || !this.enabled || !connection || !child?.stdin.writable
        || child !== this.child || connection !== this.connectionId || generation !== this.nativeConnectionGeneration)
        throw new Error('Codex effect connection changed or unavailable');
    };
    // Register before any callback/serialization. Reentrant close must retain
    // the physical authorization even when a caller has stopped waiting.
    if (trackEffect) this.maintenanceEpoch++;
    let snapshot: unknown, snapshotFailure: { error: unknown } | undefined;
    const task = Promise.resolve().then(async () => {
      const trace = guardedTrace(performanceDiagnostics, 'codex-native-effect');
      let failed = true;
      try {
        check();
        if (snapshotFailure) throw snapshotFailure.error;
        await this.nativeObservations.beforeEffect();
        check(); trace.add('step', 1);
        trace.reportPending({ step: 1, pending: 1 });
        await authorize();
        check(); trace.add('step', 2);
        // New observations conservatively veto this attempt. Do not loop on
        // worker authority against a continuously running Goal.
        this.nativeObservations.assertEffectAllowed();
        if (activity && !activity.current()) throw new TurnStartDeferred();
        // Check the original observation before dispatchRequest records this
        // effect's activity. Never run a stale observation after native ACK.
        if (beforeEffect !== undefined) synchronousEffectAuthority(beforeEffect);
        const result = await this.dispatchRequest(method, snapshot, timeoutMs, goalReceipt, () => {
          check(); synchronousEffectAuthority(local); check();
          this.nativeObservations.assertEffectAllowed();
          trace.add('step', 3);
        });
        failed = false; trace.add('settled', 1); return result;
      } finally { trace.finish(failed); }
    });
    this.authorizingEffects.add(task);
    try { snapshot = structuredClone(params); } catch (error) { snapshotFailure = { error }; }
    const release = () => { this.authorizingEffects.delete(task); };
    void task.then(release, release);
    return task;
  }

  private request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs
    ?? (method === 'thread/read' && (params as any)?.includeTurns === true
      ? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS : CODEX_REQUEST_TIMEOUT_MS),
    goalReceipt?: GoalWriteReceipt, beforeDispatch?: () => void) {
    const scope = this.maintenanceRecovery.getStore();
    if (scope) {
      const local = () => {
        if (!scope.active) throw new RunControlConflict();
        synchronousEffectAuthority(scope.local, () => new RunControlConflict());
      };
      return this.requestAuthorized(method, params, async () => {
        local(); await scope.authorize(); local();
      }, () => { local(); if (beforeDispatch) synchronousEffectAuthority(beforeDispatch); local(); },
      timeoutMs, undefined, goalReceipt, codexRpcNeedsObservationBarrier(method));
    }
    // Waiting adds a revocation window. Only original synchronous proof at the
    // eventual write may authorize it; unguarded effects refuse pending work.
    if (codexRpcNeedsObservationBarrier(method) && this.nativeObservations.status().pending && (goalReceipt || beforeDispatch)) {
      const connection = this.connectionId, generation = this.nativeConnectionGeneration;
      return this.nativeObservations.beforeEffect().then(() => {
        if (connection !== this.connectionId || generation !== this.nativeConnectionGeneration)
          throw new Error('Codex observation connection changed');
        return this.dispatchRequest(method, params, timeoutMs, goalReceipt, beforeDispatch);
      });
    }
    return this.dispatchRequest(method, params, timeoutMs, goalReceipt, beforeDispatch);
  }

  private dispatchRequest(method: string, params: unknown, timeoutMs: number, goalReceipt?: GoalWriteReceipt, beforeDispatch?: () => void) {
    if (this.closed) {
      goalReceipt?.trace?.('transport_unavailable');
      return Promise.reject(new Error('Codex App Server closed'));
    }
    if (goalReceipt && (!this.connectionId || this.goalWriteReceipts.size >= GOAL_ACK_CAPACITY)) {
      goalReceipt.trace?.('transport_unavailable');
      return Promise.reject(new Error('Goal acknowledgement capacity unavailable'));
    }
    if (codexRpcNeedsObservationBarrier(method)) {
      try { this.nativeObservations.assertEffectAllowed(); }
      catch (error) { goalReceipt?.trace?.('transport_unavailable'); return Promise.reject(error); }
    }
    // A bounded state-only status snapshot must not invalidate its own
    // maintenance proof. Keep ordinary rollout-scanning list requests unchanged.
    const maintenanceStatusRead = method === 'thread/list' && isRecord(params) && params.useStateDbOnly === true;
    if (!maintenanceStatusRead
      && !['thread/loaded/list', 'thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get', 'skills/list'].includes(method)) {
      this.maintenanceEpoch++;
      if (!['thread/list', 'model/list', 'config/read'].includes(method)) this.recordNativeActivity(stringValue((params as any)?.threadId));
    }
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new Error(`Codex App Server request timed out: ${method}`);
        // A slow read must not kill every active turn in the shared process.
        this.pending.delete(id);
        const receipt = this.goalWriteReceipts.get(id);
        if (receipt) {
          receipt.trace?.('write_timeout', { rpcId: id });
          receipt.timer = setTimeout(() => {
            receipt.trace?.('ack_expired', { rpcId: id });
            this.goalWriteReceipts.delete(id);
          }, GOAL_LATE_ACK_TTL_MS).unref();
        }
        reject(error);
        if (method === 'initialize') this.recycleChild(this.child, error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (goalReceipt) {
          // Serialize/check transport BEFORE marking the durable dispatch fence.
          // No await between that fence and the single stdin write. A throwing
          // write after the fence is ambiguous and must stay protected.
          const child = this.child, generation = this.nativeConnectionGeneration;
          const line = `${JSON.stringify({ method, id, params })}\n`;
          if (!child?.stdin.writable) throw new Error('Codex App Server is not running');
          this.goalWriteReceipts.set(id, { connection: this.connectionId!, acknowledge: goalReceipt.acknowledge,
            ...(goalReceipt.trace ? { trace: goalReceipt.trace } : {}) });
          goalReceipt.beforeWrite();
          if (beforeDispatch) synchronousEffectAuthority(beforeDispatch);
          goalReceipt.trace?.('dispatch_started', { rpcId: id });
          this.nativeObservations.assertEffectAllowed();
          if (child !== this.child || generation !== this.nativeConnectionGeneration) throw new Error('Codex observation connection changed');
          child.stdin.write(line);
          goalReceipt.trace?.('write_returned', { rpcId: id });
        } else this.write({ method, id, params }, codexRpcNeedsObservationBarrier(method), beforeDispatch);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.goalWriteReceipts.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown) { this.write({ method, params }); }
  private write(message: unknown, fenced = false, beforeDispatch?: () => void) {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server is not running');
    const child = this.child, generation = this.nativeConnectionGeneration;
    const line = `${JSON.stringify(message)}\n`;
    if (beforeDispatch) synchronousEffectAuthority(beforeDispatch);
    if (fenced) {
      this.nativeObservations.assertEffectAllowed();
      if (child !== this.child || generation !== this.nativeConnectionGeneration) throw new Error('Codex observation connection changed');
    }
    child.stdin.write(line);
  }

  private receive(line: string) {
    if (this.closed) return;
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; } catch { return; }
    if (!isRecord(message)) return;
    if (typeof message.method === 'string' && (typeof message.id === 'number' || typeof message.id === 'string')) {
      this.maintenanceEpoch++;
      this.recordNativeActivity(nativeNotificationThread(message.params));
      if (message.method === 'item/tool/call') {
        const child = this.child, connection = this.connectionId;
        void this.boardTools.invoke(message.params).then(result => {
          // A response belongs only to the child that made the request. Never
          // write an old async result into a replacement process's RPC stream.
          if (this.closed || this.child !== child || this.connectionId !== connection) return;
          try { this.write({ id: message.id, result }); }
          catch { this.recycleChild(child, new Error('Codex task tool response could not be written')); }
        }).catch(() => this.recycleChild(child, new Error('Codex task tool response failed')));
        return;
      }
      try {
        if (this.interactions?.handle(message.method, message.id, message.params)) return;
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          this.write({ id: message.id, result: { decision: 'cancel' } });
        } else {
          this.write({ id: message.id, error: { code: -32601, message: 'Interactive Codex requests are not supported by AgentOpsDeck' } });
        }
      } catch { this.recycleChild(this.child, new Error('Codex server request response could not be written')); }
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      const goalReceipt = this.goalWriteReceipts.get(message.id);
      if (goalReceipt) {
        clearTimeout(goalReceipt.timer);
        this.goalWriteReceipts.delete(message.id);
        goalReceipt.trace?.(goalReceipt.connection !== this.connectionId ? 'ack_connection_lost'
          : message.error ? 'rpc_error' : pending ? 'ack_received' : 'late_ack_received', { rpcId: message.id });
      }
      if (!pending) {
        if (goalReceipt && goalReceipt.connection === this.connectionId && !message.error) {
          // A receipt persistence/validation failure remains unknown. Never
          // project a late response over newer notifications or retry the RPC.
          this.retainGoalAcknowledgement(goalReceipt, message.result);
        }
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error.message, message.error.code));
      else if (goalReceipt && goalReceipt.connection === this.connectionId) {
        // Register the physical ACK before yielding to close or HTTP waiters.
        // Both timely and late responses use this same durability boundary.
        void this.retainGoalAcknowledgement(goalReceipt, message.result).then(() => pending.resolve(message.result), pending.reject);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      // Only the current native notification stream creates live evidence;
      // history recovery's calls to handleNotification deliberately do not.
      if (message.method === 'turn/completed' && this.connectionId) {
        const threadId = nativeNotificationThread(message.params), turnId = nativeNotificationTurn(message.params);
        if (threadId && turnId) this.automationCompletions.live(this.sessionKey(threadId), this.connectionId,
          turnId, stringValue(message.params?.turn?.status) ?? 'unknown', Date.now());
      }
      this.handleNotification(message.method, message.params ?? {}, Buffer.byteLength(line));
    }
  }

  private retainGoalAcknowledgement(receipt: Pick<GoalWriteReceipt, 'acknowledge'>, raw: unknown): Promise<void> {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const work = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const release = () => { this.goalAcknowledgementDrains.delete(drain); };
    const drain = Promise.prototype.then.call(work, release, release) as Promise<void>;
    this.goalAcknowledgementDrains.add(drain);
    try { void Promise.resolve(receipt.acknowledge(raw)).then(resolve, reject); }
    catch (error) { reject(error); }
    return work;
  }

  private handleNotification(method: string, params: any, sourceBytes?: number) {
    if (this.closed) return;
    if (method === 'deprecationNotice' && isRecord(params) && Object.keys(params).length === 2
      && typeof params.summary === 'string' && (params.details === null || typeof params.details === 'string')) return;
    this.maintenanceEpoch++;
    // Native metadata invalidation is not evidence that a turn loaded a skill.
    // Clear without polling; stale in-flight replies must not repopulate it.
    if (method === 'skills/changed') { this.skillsCache.invalidate(); return; }
    if ((method === 'account/rateLimits/updated' || method === 'account/updated' || method === 'mcpServer/startupStatus/updated')
      && !conflictingNativeNotificationIdentity(params) && !nativeNotificationThread(params)) return;
    this.recordNativeActivity(nativeNotificationThread(params));
    try { for (const observe of this.terminalHistoryObservers) observe(method, params); }
    catch { this.nativeObservations.unavailable(1); return; }
    // Contradictory aliases cannot settle an interaction owner either. Still
    // invalidate original read windows above; valid unscoped notices proceed.
    if (conflictingNativeNotificationIdentity(params)) {
      try { this.goalDiagnostics.trace('codex:unscoped', this.connectionId, 'recovery')('native_identity_rejected'); }
      catch { /* Diagnostics cannot change the identity refusal. */ }
      return;
    }
    if (this.executionUnavailable) return;
    const connection = this.connectionId, generation = this.nativeConnectionGeneration;
    const project = (notification: any) => {
      if (this.closed || this.executionUnavailable || this.connectionId !== connection || generation !== this.nativeConnectionGeneration) return;
      this.interactions?.notification(method, notification);
      return this.projectNotification(method, notification);
    };
    const bytes = sourceBytes ?? Buffer.byteLength(JSON.stringify({ method, params }));
    const deltaField = typeof params?.delta === 'string' ? 'delta' : method === 'item/agentMessage/delta' && typeof params?.text === 'string' ? 'text' : undefined;
    if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'].includes(method) && deltaField
      && nativeNotificationThread(params) && nativeNotificationTurn(params) && stringValue(params?.itemId ?? params?.item?.id)) {
      const metadata = { ...params };
      delete metadata[deltaField];
      this.nativeObservations.acceptText(JSON.stringify([connection, generation, method, metadata]), params[deltaField], bytes,
        text => project({ ...metadata, [deltaField]: text }));
      return;
    }
    this.nativeObservations.accept(() => project(params), bytes, 1);
  }

  private recordNativeActivity(threadId: string | undefined) {
    if (threadId) this.nativeActivityVersions.set(threadId, (this.nativeActivityVersions.get(threadId) ?? 0) + 1);
    else this.nativeUnscopedActivityEpoch++;
  }

  private nativeHistoryActivityGuard(threadId: string) {
    const watched = new Set([threadId]);
    const snapshots: Map<string, number>[] = [];
    const watch = (id: string) => {
      if (watched.has(id)) return;
      watched.add(id);
      for (const versions of snapshots) versions.set(id, this.nativeActivityVersions.get(id) ?? 0);
    };
    const checkpoint = () => {
      const epoch = this.nativeUnscopedActivityEpoch;
      const versions = new Map([...watched].map(id => [id, this.nativeActivityVersions.get(id) ?? 0]));
      snapshots.push(versions);
      return () => {
        if (epoch !== this.nativeUnscopedActivityEpoch) return false;
        for (const [id, version] of versions) if (version !== (this.nativeActivityVersions.get(id) ?? 0)) return false;
        return true;
      };
    };
    return {
      current: checkpoint(), checkpoint,
      // Register before issuing the read, not after awaiting its reply. This
      // also covers grandchildren discovered from native structured items.
      request: (method: string, params: unknown, timeoutMs?: number) => {
        const id = stringValue((params as any)?.threadId);
        if (id) watch(id);
        return this.request(method, params, timeoutMs);
      },
    };
  }

  private invalidateExecution() {
    this.interactions?.reset();
    this.boardTools.reset();
    this.executionUnavailable = true;
    this.options.store.invalidateCodexExecutionFacts();
  }

  // This is the original receiver's sole journal boundary, not an optional
  // worker beside a live SQL writer. Sole-owner assembly replaces the port
  // only when the remaining journal consumers have migrated together.
  private settleNativeNotification(event: CodexNativeNotification): CodexNativeNotificationResult | Promise<CodexNativeNotificationResult> {
    if (this.options.nativeJournal) return this.options.nativeJournal.settle(event);
    return settleCodexNativeNotification(this.legacyExecutions, event);
  }

  private projectNotification(method: string, params: any): void | Promise<void> {
    const threadId = nativeNotificationThread(params);
    if (!threadId) return;
    if (method.startsWith('turn/') || method.startsWith('item/')) this.unmaterializedThreadIds.delete(threadId);
    const sessionKey = this.sessionKey(threadId);
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
      this.projectGoal(sessionKey, method === 'thread/goal/cleared' ? { goal: null } : params, threadId);
    }
    const compact = this.compactWaiters.get(threadId);
    if (compact && compact.accepting) {
      try { compact.check(); }
      catch (error) { compact.reject(error instanceof Error ? error : new Error('Codex compaction identity unavailable')); return; }
      observeCompaction(compact.evidence, method, params, compact.previousRunId);
      if (compact.evidence.failure) compact.reject(new Error(method === 'turn/completed' && params?.turn?.status === 'failed'
        ? codexTurnFailureReason(params) : compact.evidence.failure));
      else if (compact.evidence.itemCompleted && compact.evidence.terminal === 'completed') compact.resolve();
      // Explicit compaction has a separate evidence path. Its lifecycle (or a
      // delayed predecessor lifecycle) must not mutate the normal execution.
      if (method === 'turn/started' || method === 'turn/completed' || params?.item?.type === 'contextCompaction') return;
    }
    const nativeTurnId = nativeNotificationTurn(params);
    const observed = method === 'turn/started' ? 'running' : method === 'turn/completed' ? params?.turn?.status : undefined;
    const connection = this.connectionId, generation = this.nativeConnectionGeneration;
    const item = params?.item, toolId = stringValue(item?.id ?? params?.itemId);
    // Native command lifecycle requires the original item identity. Never
    // fabricate a projection-only id or accept an alias that the terminal
    // projector cannot settle against the same durable tool identity.
    if (item?.type === 'commandExecution' && ['item/started', 'item/completed'].includes(method)
      && !stringValue(item.id)) return;
    const event: CodexNativeNotification = {
      sessionKey, connectionId: connection ?? null, runId: nativeTurnId ?? null,
      kind: method === 'turn/started' ? 'start' : method === 'turn/completed' ? 'complete'
        : method.startsWith('turn/') ? 'turn' : method.startsWith('item/') ? 'item' : ['thread/goal/updated', 'thread/goal/cleared'].includes(method) ? 'goal'
        : method === 'thread/status/changed' ? 'status' : 'other',
      phase: ['running', 'completed', 'failed', 'interrupted'].includes(observed) ? observed : null,
      successorItemTurnId: successorItemTurn(method, params) ?? null,
      projectable: !!this.options.store.getSession(sessionKey),
      tool: item?.type === 'commandExecution' && toolId && ['item/started', 'item/completed'].includes(method)
        ? { id: toolId, event: method === 'item/started' ? 'started'
          : ['completed', 'failed', 'declined'].includes(item.status) ? 'completed' : 'unsettled' } : null,
    };
    const settled = this.settleNativeNotification(event);
    const project = (result: CodexNativeNotificationResult) => {
      if (this.closed || this.executionUnavailable || connection !== this.connectionId || generation !== this.nativeConnectionGeneration) return;
      if (result.invalidate) this.threadRefreshResult.delete(sessionKey);
      if (result.wake) this.turnWorker.wake();
      if (result.kind === 'ignore' && !this.options.store.getSession(sessionKey) && this.subagentTracker.hasChild(threadId)) {
        this.subagentTracker.observeChildNotification(threadId, method, params);
      }
      if (result.kind === 'ignore' || result.kind === 'successor') return;
      return this.projectSettledNotification(method, params, result);
    };
    // Retain synchronous current-owner semantics. Async owner commands are
    // physically owned by nativeObservations, never detached or timed out.
    if (types.isPromise(settled)) return Promise.prototype.then.call(settled, project) as Promise<void>;
    return project(settled);
  }

  private projectSettledNotification(method: string, params: any, result: CodexNativeNotificationResult) {
    const threadId = nativeNotificationThread(params)!;
    const sessionKey = this.sessionKey(threadId), nativeTurnId = nativeNotificationTurn(params);
    const observed = method === 'turn/started' ? 'running' : method === 'turn/completed' ? params?.turn?.status : undefined;
    const execution = result.execution ?? undefined;
    const current = this.options.store.getSession(sessionKey);
    if (!current) return;
    const now = Date.now();
    if (result.kind === 'late_tool' && execution?.runId) {
      const itemId = stringValue(params.item.id);
      if (!itemId || !this.connectionId) return;
      if (method === 'item/started') {
        // Duplicate old notifications cannot reopen an already synchronized
        // tool, but a new same-run command must invalidate idle immediately.
        this.recordToolStarted(sessionKey, itemId, params.item, numberValue(params.startedAtMs) ?? now);
      } else {
        this.recordToolCompleted(sessionKey, itemId, params.item, numberValue(params.completedAtMs) ?? now);
      }
      this.threadRefreshResult.delete(sessionKey);
      this.publishRun(sessionKey, { turnId: execution.runId, phase: 'finalizing', connection: 'connected', sync: 'syncing', lastEventAt: now });
      this.reconcileCompletedTurn(sessionKey, threadId, execution.completedAt ?? now, execution.runId,
        execution.phase as 'completed' | 'failed' | 'interrupted');
      return;
    }
    const notifiedTurnId = nativeTurnId;
    if (!execution && method === 'turn/completed' && current.runtime?.phase === 'starting' && notifiedTurnId === this.completedTurnIds.get(sessionKey)) return;
    const activeTurnId = execution ? (execution.phase === 'running' ? execution.runId : undefined) : this.activeTurnIds.get(sessionKey);
    const completedTurnId = execution
      ? (['completed', 'failed', 'interrupted'].includes(execution.phase) && execution.sync === 'current' ? execution.runId : undefined)
      : this.completedTurnIds.get(sessionKey);
    if (method !== 'turn/started' && notifiedTurnId && activeTurnId && notifiedTurnId !== activeTurnId) return;
    if (method === 'thread/tokenUsage/updated') {
      // Usage is subject to the same connection/turn fence as transcript events.
      // Reject a late predecessor sample even after the active turn has ended.
      if (notifiedTurnId && completedTurnId && !activeTurnId && notifiedTurnId !== completedTurnId) return;
      const cumulative = codexCumulativeUsage(params?.tokenUsage);
      const publishUsage = () => {
        const usage = { ...codexContextUsage(params?.tokenUsage),
          ...(cumulative && notifiedTurnId && (notifiedTurnId === activeTurnId || notifiedTurnId === completedTurnId)
            ? { inputTokens: cumulative.inputTokens, outputTokens: cumulative.outputTokens } : {}) };
        if (Object.keys(usage).length) {
          this.touchProjection(sessionKey);
          this.projectUsage(sessionKey, usage);
        }
      };
      if (cumulative && notifiedTurnId && (notifiedTurnId === activeTurnId || notifiedTurnId === completedTurnId)) {
        if (this.options.nativeJournal) {
          const connectionId = this.connectionId, generation = this.nativeConnectionGeneration;
          if (!connectionId) return;
          // This physical promise belongs to nativeObservations, including close
          // drain. A stale ACK must not publish a view on a replacement connection.
          const recording = this.options.nativeJournal.cumulativeUsage({ sessionKey, connectionId, runId: notifiedTurnId,
            expected: execution ?? null, counts: cumulative });
          return Promise.prototype.then.call(recording, (accepted: boolean) => {
            if (!accepted || this.closed || this.executionUnavailable || this.connectionId !== connectionId
              || this.nativeConnectionGeneration !== generation) return;
            publishUsage();
          }) as Promise<void>;
        }
        this.options.tokenUsage?.cumulative(sessionKey, notifiedTurnId, cumulative);
      }
      publishUsage();
      return;
    }
    if (method.startsWith('item/') && notifiedTurnId && notifiedTurnId === completedTurnId
      && (execution || (current.runtime?.sync === 'current' && !runtimeBusy(current.runtime)))) return;
    if (method === 'turn/completed' && notifiedTurnId === completedTurnId
      && (execution || (current.runtime && current.runtime.turnId === notifiedTurnId && ['completed', 'failed', 'interrupted'].includes(current.runtime.phase)
        && observed !== current.runtime.phase))) return;
    if (method === 'error') {
      if (!notifiedTurnId || notifiedTurnId !== activeTurnId || typeof params?.willRetry !== 'boolean'
        || !current.runtime || !['running', 'waiting'].includes(current.runtime.phase)) return;
      const recover = !params.willRetry && current.runtime.reason !== CODEX_ERROR_NOTICE;
      this.publishRun(sessionKey, { ...current.runtime, lastEventAt: now,
        reason: params.willRetry ? CODEX_RETRY_NOTICE : CODEX_ERROR_NOTICE });
      if (recover) {
        this.threadRefreshResult.delete(sessionKey);
        if (execution) this.turnWorker.wake();
        else void this.refreshSession(sessionKey, { fresh: true }).catch(() => undefined);
      }
      return;
    }
    if (method.startsWith('item/') && notifiedTurnId === activeTurnId && current.runtime?.reason
      && [CODEX_RETRY_NOTICE, CODEX_ERROR_NOTICE].includes(current.runtime.reason)
      && ['running', 'waiting'].includes(current.runtime.phase)) {
      const { reason: _reason, ...runtime } = current.runtime;
      this.publishRun(sessionKey, { ...runtime, lastEventAt: now });
    }
    if (method === 'thread/started') return;
    const reload = this.erroredThreadReloads.get(sessionKey);
    if (method === 'thread/status/changed' && ['idle', 'notLoaded'].includes(params.status?.type)
      && !notifiedTurnId && reload?.reloading && reload.effectStarted && execution?.phase === 'failed'
      && reload.identity === `${this.connectionId}:${execution.runId}`) {
      this.threadRefreshResult.delete(sessionKey);
      return;
    }
    this.touchProjection(sessionKey);
    if (method === 'thread/status/changed') {
      const status = params.status;
      if (status?.type === 'active') {
        // Repeated waiting/running notifications of the same identified turn
        // do not erase its hydrated replica. New/unknown activity still does.
        if (!activeTurnId || current.runtime?.turnId !== activeTurnId || current.runtime.sync !== 'current'
          || !['running', 'waiting'].includes(current.runtime.phase)) this.threadRefreshResult.delete(sessionKey);
        this.publishThreadActivity(sessionKey, status.activeFlags?.length ? 'waiting' : 'running');
        if (!activeTurnId && (execution || (current.runtime && !runtimeBusy(current.runtime)))) {
          void this.refreshSession(sessionKey).catch(() => undefined);
          return;
        }
        if (current.runtime?.phase !== 'finalizing') this.publishRun(sessionKey, {
          ...(activeTurnId ? { turnId: activeTurnId } : current.runtime?.turnId ? { turnId: current.runtime.turnId } : {}),
          phase: status.activeFlags?.length ? 'waiting' : 'running', connection: 'connected', sync: 'current', lastEventAt: now,
          ...(status.activeFlags?.length ? { reason: status.activeFlags.join(', ') } : {}),
        });
      } else if (status?.type === 'systemError' || (status?.type === 'notLoaded' && (!current.runtime || runtimeBusy(current.runtime)))) {
        this.threadRefreshResult.delete(sessionKey);
        const phase = current.runtime && current.runtime.turnId === completedTurnId && !runtimeBusy(current.runtime) ? current.runtime.phase : 'unknown';
        this.publishRun(sessionKey, { ...current.runtime, phase, threadActivity: 'unknown', connection: 'connected', sync: 'error', lastEventAt: now, reason: `Codex thread ${status.type}` });
      } else {
        // Idle is a thread availability signal, not proof that final messages
        // have arrived. Reconcile the identified turn before exposing completion.
        void this.refreshSession(sessionKey).catch(() => undefined);
      }
      return;
    }
    if (method === 'turn/started') {
      const turnId = nativeTurnId;
      if (turnId && completedTurnId === turnId) return;
      if (!execution && turnId) this.activeTurnIds.set(sessionKey, turnId);
      this.publishRun(sessionKey, { ...(turnId ? { turnId } : {}), phase: 'running', threadActivity: 'running', connection: 'connected', sync: 'current', lastEventAt: now }, { runStartedAt: now, runCompletedAt: undefined, lastActiveAt: now });
      return;
    }
    if (method === 'turn/completed') {
      this.boardTools.stop(threadId);
      const turnId = notifiedTurnId ?? activeTurnId;
      // A retry observes the same completion; it is not a new completion event.
      const completedAt = codexTimestampMilliseconds(params?.turn?.completedAt)
        ?? (current.runtime?.turnId === turnId ? current.runCompletedAt : undefined) ?? now;
      if (!execution) {
        if (turnId && completedTurnId === turnId && current.runtime?.sync !== 'error') return;
        if (turnId) this.completedTurnIds.set(sessionKey, turnId);
        this.activeTurnIds.delete(sessionKey);
      }
      const status = params?.turn?.status === 'failed' ? 'failed' : 'idle';
      if (status === 'failed') {
        for (const message of this.options.store.getMessages(sessionKey)) {
          if (message.turnId === turnId && message.role === 'tool' && message.status === 'sending') {
            this.options.store.addMessage({ ...message, status: 'failed', updatedAt: now, failureReason: 'Turn failed before tool completion was received' });
          }
        }
        // Failure is terminal evidence for the native turn, not settlement of
        // an original projector that may still own these buffers.
        if (!this.assistantProjections.get(sessionKey)?.size) this.clearTransientBuffers(sessionKey);
        this.publishRun(sessionKey, { ...(turnId ? { turnId } : {}), phase: 'failed', connection: 'connected', sync: 'syncing', lastEventAt: now, reason: codexTurnFailureReason(params) }, { runCompletedAt: completedAt, lastActiveAt: completedAt });
        const failureReason = codexTurnFailureReason(params);
        const failureTurnId = nativeTurnId ?? nanoid();
        this.options.store.addMessage({
          id: codexScopedId(sessionKey, `codex-turn-failure-${failureTurnId}`),
          sessionKey,
          role: 'assistant',
          text: failureReason,
          status: 'failed',
          failureReason,
          createdAt: now,
          updatedAt: now,
        });
        // A failed turn may already have performed side effects. Only a new
        // durable queue admission can authorize another turn, including 413s.
        void this.cleanupSecretFiles(sessionKey).catch(() => {
          console.warn('[codex] Temporary credential cleanup evidence unavailable; resources retained');
        });
        this.reconcileCompletedTurn(sessionKey, threadId, completedAt, turnId, 'failed');
      } else {
        void this.cleanupSecretFiles(sessionKey).catch(() => {
          console.warn('[codex] Temporary credential cleanup evidence unavailable; resources retained');
        });
        // Keep the run visibly active until thread/read and the rollout file
        // agree on the final timeline. This prevents a brief idle state and
        // prevents late custom tools from being appended after the response.
        this.publishRun(sessionKey, { ...(turnId ? { turnId } : {}), phase: 'finalizing', connection: 'connected', sync: 'syncing', lastEventAt: now }, { runCompletedAt: completedAt, lastActiveAt: completedAt });
        this.reconcileCompletedTurn(sessionKey, threadId, completedAt, turnId, params?.turn?.status === 'interrupted' ? 'interrupted' : 'completed');
      }
      return;
    }
    const item = params?.item;
    const itemId = stringValue(item?.id ?? params?.itemId) ?? `codex-item-${nanoid()}`;
    if (method === 'item/started' && isToolItem(item)) {
      this.recordToolStarted(sessionKey, itemId, item, numberValue(params?.startedAtMs) ?? now);
      return;
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/mcpToolCall/progress') {
      this.recordToolProgress(sessionKey, itemId, stringValue(params?.delta ?? params?.message) ?? '', now);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const id = codexScopedId(sessionKey, `codex-${itemId}`);
      if (this.completedAssistantItems.has(`${id}:${JSON.stringify([execution?.commandId, notifiedTurnId])}`)) return;
      const delta = typeof params?.delta === 'string' ? params.delta : typeof params?.text === 'string' ? params.text : '';
      if (!delta) return;
      const key = `${sessionKey}:${itemId}`;
      const previousText = this.assistantText.get(key) ?? '';
      if (!this.retainAssistantOutput(sessionKey, itemId, Buffer.byteLength(previousText) + Buffer.byteLength(delta), execution, notifiedTurnId)) return;
      const text = previousText + delta;
      this.assistantText.set(key, text);
      const previous = this.options.store.getMessage(sessionKey, id);
      this.options.store.addMessage({ ...previous, id, sessionKey, ...(notifiedTurnId ? { turnId: notifiedTurnId } : {}), role: 'assistant', text, createdAt: previous?.createdAt ?? now, updatedAt: now });
      return;
    }
    if (method === 'item/completed') {
      const text = itemText(item);
      if (item?.type === 'agentMessage') {
        const id = codexScopedId(sessionKey, `codex-${itemId}`);
        if (this.completedAssistantItems.has(`${id}:${JSON.stringify([execution?.commandId, notifiedTurnId])}`)) return;
        const assistantText = text || this.assistantText.get(`${sessionKey}:${itemId}`) || '';
        if (!assistantText.trim()) {
          this.completedAssistantItems.add(`${id}:${JSON.stringify([execution?.commandId, notifiedTurnId])}`);
          this.assistantText.delete(`${sessionKey}:${itemId}`);
          this.releaseAssistantItemRetention(sessionKey, itemId);
          const placeholder = this.options.store.getMessage(sessionKey, id);
          if (placeholder && !placeholder.text.trim() && !placeholder.media?.length) {
            this.touchProjection(sessionKey);
            this.options.store.removeMessage(sessionKey, id);
          }
          return;
        }
        if (!this.retainAssistantOutput(sessionKey, itemId, Buffer.byteLength(assistantText), execution, notifiedTurnId)) return;
        const pending = this.assistantProjections.get(sessionKey) ?? new Set<Promise<void>>();
        const task = this.recordAssistantMessage(sessionKey, itemId, assistantText, now, notifiedTurnId, item?.phase, execution)
          .catch(() => {
            // Projectors may reject with paths, content, credentials or even
            // hostile coercion. Diagnostics must not inspect that value or
            // turn a handled projection failure into a rejected owner task.
            try { console.warn('[codex-assistant-projection-failed]', { stage: 'assistant-projection', fault: 'unavailable' }); }
            catch { /* Observation only; original settlement is unchanged. */ }
          })
          .finally(() => pending.delete(task));
        pending.add(task);
        this.assistantProjections.set(sessionKey, pending);
      }
      this.assistantText.delete(`${sessionKey}:${itemId}`);
      if (isToolItem(item)) {
        this.recordToolCompleted(sessionKey, itemId, item, numberValue(params?.completedAtMs) ?? now);
      }
    }
  }

  private async readExecutionFact(sessionKey: string): Promise<CodexExecution | undefined> {
    if (this.options.startup) await this.ready();
    return this.options.nativeJournal ? this.options.nativeJournal.readExecution(sessionKey) : this.legacyExecutions.get(sessionKey);
  }

  private async readHistoryFact(sessionKey: string): Promise<import('../connector/connector-execution-domain.js').CodexHistoryObservation> {
    if (this.options.startup) await this.ready();
    if (this.options.nativeJournal) return this.options.nativeJournal.readHistory(sessionKey);
    return { execution: this.legacyExecutions.get(sessionKey) ?? null,
      deleted: this.legacyExecutions.isDeletedTerminal(sessionKey),
      outcomeUnknown: this.legacyTurnQueue.head('codex', sessionKey)?.state === 'outcome_unknown' };
  }

  private reconcileCompletedTurn(sessionKey: string, threadId: string, completedAt: number, turnId?: string, outcome: 'completed' | 'failed' | 'interrupted' = 'completed') {
    if (this.completingTurns.has(sessionKey)) return;
    const previousRefresh = this.threadRefreshResult.get(sessionKey);
    this.threadRefreshResult.delete(sessionKey);
    let execution: CodexExecution | undefined;
    let observed: CodexExecution | undefined, failureExpected: CodexExecution | undefined;
    const connectionId = this.connectionId;
    const child = this.child, generation = this.nativeConnectionGeneration;
    const localCurrent = () => !this.closed && !this.executionUnavailable && connectionId === this.connectionId
      && child === this.child && generation === this.nativeConnectionGeneration;
    const sameTurn = () => {
      if (!localCurrent()) return false;
      // A worker observation is read evidence only. Synchronous native guards
      // retain LOCAL ownership; only the final worker revision CAS can commit.
      const current = this.options.nativeJournal ? observed : this.legacyExecutions.get(sessionKey);
      if (!execution) return !current && (!turnId || this.options.store.getSession(sessionKey)?.runtime?.turnId === turnId);
      return current?.commandId === execution.commandId && (!current.runId || current.runId === turnId);
    };
    let completedSuccessfully = false;
    let historyCommitted = false;
    let historyDelivered = false, reconciliationFailed = false;
    let trace: PerformanceTrace | undefined, pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let incompleteReason = 'Final turn snapshot is incomplete';
    let readStage = 'native-read', attempts = 0;
    // Numeric, bounded diagnostics only. They do not grant execution authority
    // or shorten the lifetime of the original read/projection/cleanup owner.
    const diagnosticSnapshot = () => ({ step: Math.max(0, ['native-read', 'assistant-projection-wait',
      'native-snapshot', 'rollout-snapshot', 'history-projection', 'execution-verification',
      'rollout-cleanup', 'final-history', 'history-storage-read'].indexOf(readStage) + 1), records: attempts });
    // ALL native verification reads share one budget, not just thread/read.
    // Goal/terminal/child checks otherwise each add another full timeout on
    // every retry, leaving a finished session apparently checking for minutes.
    let readBudget = this.options.requestTimeoutMs ?? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS;
    const activity = this.nativeHistoryActivityGuard(threadId);
    const terminalActivity = terminalHistoryActivity(threadId);
    this.terminalHistoryObservers.add(terminalActivity.observe);
    const nativeRead = async (method: string, params: unknown, timeoutMs?: number) => {
      if (readBudget <= 0) throw new Error('Codex final verification read budget exhausted');
      const started = performance.now();
      try { return await activity.request(method, params, Math.min(timeoutMs ?? readBudget, readBudget)); }
      finally { readBudget -= performance.now() - started; }
    };
    const waitForOriginalProjections = async () => {
      const pending = this.assistantProjections.get(sessionKey);
      if (!pending?.size) return;
      readStage = 'assistant-projection-wait';
      if (readBudget <= 0) throw new NativeHistoryReadError('incomplete', 'Assistant projection is still pending');
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // This bounds the HISTORY OBSERVER, not the original projector. Its
        // task remains in assistantProjections (and the shutdown drain) until
        // it actually settles. No execution lease, IO owner or queue is freed.
        await Promise.race([Promise.all(pending), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new NativeHistoryReadError('incomplete', 'Assistant projection is still pending')),
            Math.max(1, Math.ceil(readBudget)));
        })]);
      } finally {
        clearTimeout(timer); readBudget -= performance.now() - started;
      }
    };
    const task = (async () => {
      execution = observed = failureExpected = await this.readExecutionFact(sessionKey);
      if (!sameTurn()) return;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        if (!sameTurn()) return;
        await waitForOriginalProjections();
        if (!sameTurn()) return;
        const version = this.projectionVersion(sessionKey);
        const activityCurrent = activity.checkpoint();
        const terminalActivityCurrent = terminalActivity.checkpoint();
        const expected = observed = failureExpected = await this.readExecutionFact(sessionKey);
        if (!sameTurn()) return;
        const revision = expected?.revision;
        attempts = attempt + 1;
        readStage = 'native-read';
        if (readBudget <= 0) {
          incompleteReason = 'Codex final thread read unavailable';
          break;
        }
        let result;
        try { result = await nativeRead('thread/read', { threadId, includeTurns: true }); }
        catch {
          // Reading is non-mutating. Use the same bounded retry budget as an
          // incomplete snapshot, never replay a turn or relax execution proof.
          if (!sameTurn()) return;
          incompleteReason = 'Codex final thread read unavailable';
          continue;
        }
        const hasResumeJournal = Boolean(this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal?.prepareResume);
        result = hasResumeJournal
          ? await this.reloadJournaledErroredTerminal(sessionKey, result, nativeRead)
          : await this.reloadErroredTerminal(sessionKey, result, nativeRead);
        if (!sameTurn()) return;
        if (revision !== (this.options.nativeJournal ? observed : this.legacyExecutions.get(sessionKey))?.revision) continue;
        let thread;
        readStage = 'native-snapshot';
        try { thread = historyThread(result, threadId); }
        catch (error) {
          incompleteReason = error instanceof NativeHistoryReadError ? error.message : 'Invalid Codex thread history';
          if (attempt === 4) throw error;
          continue;
        }
        // A later successful read must replace a stale transient failure reason.
        incompleteReason = 'Final turn snapshot is incomplete';
        const turns = arrayValue(thread.turns);
        const latestTurn = turns.at(-1);
        // Native continuations can finish after the command-bound turn. They
        // are transcript evidence, not authority to rebind that command or
        // release its queue. Keep the exact terminal identity/outcome checks,
        // but allow a full successor transcript to be read fenced. A known
        // terminal's history is not contingent on a continuing Goal stopping.
        // Only the native head may be in progress; ambiguous middle turns and
        // unknown statuses still cannot certify this snapshot.
        const trackedIndex = turnId ? turns.findIndex(turn => turn.id === turnId) : -1;
        const successorHistory = !!execution && execution.runId === turnId && execution.phase === outcome
          && trackedIndex >= 0 && trackedIndex < turns.length - 1
          && !!terminalHistoryOwner(thread, turnId, outcome);
        const turn = successorHistory ? turns[trackedIndex] : latestTurn;
        if (turn?.status !== outcome) continue;
        if (!turn || (turnId && turn.id !== turnId) || !['completed', 'interrupted', 'failed'].includes(turn.status)) {
          incompleteReason = 'Final turn identity does not match the latest native turn';
          continue;
        }
        if (attempt === 0 && expected && connectionId && expected.sync === 'current'
          && expected.nativeHistory?.state === 'blocked' && expected.nativeHistory.connectionId === connectionId
          && expected.nativeHistory.reason !== 'cleanup-unconfirmed'
          && (thread.status?.type !== 'notLoaded' || expected.nativeHistory.reason === 'goal-blocked')
          && expected.nativeHistory.turnId === latestTurn?.id
          && expected.nativeHistory.fingerprint === nativeHistoryFingerprint(thread)
          && previousRefresh?.available && previousRefresh.display
          && previousRefresh.display.connection === connectionId
          && previousRefresh.display.generation === generation
          && previousRefresh.display.projection === version
          && isDeepStrictEqual(previousRefresh.display.execution, expected)
          && isDeepStrictEqual(previousRefresh.display.runtime, this.options.store.getSession(sessionKey)?.runtime)
          && !this.activeTurnIds.has(sessionKey)) {
          const checkUnchanged = () => {
            if (!sameTurn() || !activityCurrent()) throw new RunControlConflict();
            if (revision !== (this.options.nativeJournal ? observed : this.legacyExecutions.get(sessionKey))?.revision
              || version !== this.projectionVersion(sessionKey)) throw new RunControlConflict();
          };
          try {
            const coldCleanupUnconfirmed = thread.status?.type === 'notLoaded'
              ? (expected.nativeHistory.reason === 'background-work' ? 'background-work' : false)
              : false;
            const recheckedHistory = await this.inspectNativeHistory(thread, expected, checkUnchanged, coldCleanupUnconfirmed, false, nativeRead);
            if (isDeepStrictEqual(recheckedHistory, expected.nativeHistory)
              && await this.rolloutReader.sourceUnchanged(previousRefresh.display.source, Math.max(1, Math.ceil(readBudget)))) {
              const current = await this.readHistoryFact(sessionKey);
              if (sameTurn() && activityCurrent() && !current.deleted && !current.outcomeUnknown
                && current.execution?.revision === revision && version === this.projectionVersion(sessionKey)) {
                this.threadRefreshResult.set(sessionKey, { ...previousRefresh, at: Date.now(), available: true, recoveryAt: Date.now() });
                historyDelivered = true;
                return;
              }
            }
          } catch {
            // Fall through to full verification on any read/conflict error.
          }
        }
        readStage = 'rollout-snapshot';
        if (readBudget <= 0) throw new NativeHistoryReadError('incomplete', 'Final verification read budget exhausted');
        const rolloutStarted = performance.now();
        let projected: { snapshot: Awaited<ReturnType<CodexRolloutReader['readSnapshot']>>;
          value: Awaited<ReturnType<typeof historicalProjection>> };
        let projectionSettling = false;
        try {
          const deadline = rolloutStarted + readBudget;
          projected = await this.rolloutReader.readProjectedSnapshotWithin(thread.path, {}, Math.max(1, Math.ceil(readBudget)), async snapshot => {
            readStage = 'history-projection';
            return historicalProjection(sessionKey, thread.turns,
              this.historyAssistantProjector(sessionKey, deadline), snapshot, thread.path);
          });
        } catch (error) {
          if (error instanceof HistoricalProjectionPendingError && attempt === 0
            && !this.assistantProjections.get(sessionKey)?.size
            && readBudget - (performance.now() - rolloutStarted) > 0) {
            projectionSettling = true;
          } else throw error;
        }
        finally { readBudget -= performance.now() - rolloutStarted; }
        if (projectionSettling) { incompleteReason = 'Assistant output projection still settling'; continue; }
        projected = projected!;
        let rollout = projected.snapshot;
        const projection = projected.value;
        const displaySource = this.rolloutReader.sourceVersion(rollout);
        let rolloutTransferred = false;
        try {
        let messages = projection.messages;
        const usage = projection.usage;
        if (!sameTurn()) return;
        if (revision !== (this.options.nativeJournal ? observed : this.legacyExecutions.get(sessionKey))?.revision || version !== this.projectionVersion(sessionKey)) {
          incompleteReason = 'New execution or live events arrived during final synchronization'; continue;
        }
        const check = () => {
          if (!sameTurn()) throw new RunControlConflict();
          if (!activityCurrent()) throw new RunControlConflict();
          if (revision !== (this.options.nativeJournal ? observed : this.legacyExecutions.get(sessionKey))?.revision || version !== this.projectionVersion(sessionKey)) throw new RunControlConflict();
        };
        // An item delta of the exact active successor may invalidate a dispatch
        // read, but cannot change the owned terminal's identity/outcome. Keep
        // those proofs separate: this fallback can ONLY publish a BLOCKED
        // checkpoint, never idle/verified, and never wake the send worker.
        const readableDuringSuccessorActivity = () => successorHistory && latestTurn.status === 'inProgress'
          && !activityCurrent() && terminalActivityCurrent(latestTurn.id) && sameTurn()
          && revision === (this.options.nativeJournal ? observed : this.legacyExecutions.get(sessionKey))?.revision && version === this.projectionVersion(sessionKey);
        const protectedCheckpoint = (): NativeHistoryCheckpoint => ({ turnId: latestTurn.id,
          fingerprint: nativeHistoryFingerprint(thread), connectionId: connectionId!, state: 'blocked', reason: 'background-work' });
        let nativeHistory: NativeHistoryCheckpoint | undefined;
        let protectedRead = false;
        readStage = 'execution-verification';
        const terminalObservation = this.backgroundTerminalObservation(threadId, check, nativeRead);
        const observeTerminalDrain = async (candidate: any) => {
          if (readBudget <= 0) throw new NativeHistoryReadError('incomplete', 'Final verification read budget exhausted');
          const started = performance.now(), before = readBudget;
          try {
            const observed = await this.rolloutReader.observeLeasedProjectionWithin(thread.path,
              Math.max(1, Math.ceil(before)), () => { rolloutTransferred = true; return rollout; },
              async (snapshot, expired) => {
                const guarded = () => { if (expired()) throw new RolloutObservationPendingError(); check(); };
                guarded();
                try {
                  await this.requireBackgroundTerminalsDrained(threadId, candidate, guarded, snapshot, nativeRead, terminalObservation);
                } catch (error) {
                  if (expired()) throw new RolloutObservationPendingError();
                  // A timely conservative cleanup refusal must return the lease
                  // for the independent protected-history checkpoint below.
                  return { error };
                }
                if (expired()) throw new RolloutObservationPendingError();
                return {};
              });
            rollout = observed.snapshot;
            rolloutTransferred = false;
            if ('error' in observed.value) throw observed.value.error;
          } finally {
            // nativeRead already debits its own RPC time; debit the whole proof
            // window once, not again for the nested portion of that window.
            readBudget = Math.min(readBudget, before - (performance.now() - started));
          }
        };
        try {
        if (expected && connectionId) {
          let cleanupUnconfirmed: boolean | 'background-work' = false;
          // Interruption/background ambiguity in ANY successor is an execution
          // fence, not failure to deliver an otherwise complete transcript.
          for (const candidate of turns.slice(Math.max(0, trackedIndex))) {
            // Running successor work is expected, not an old-turn cleanup
            // failure. inspectNativeHistory retains its independent fence.
            if (candidate.status === 'inProgress') continue;
            // A cold checkpoint cannot enumerate terminals until loaded. With
            // no dispatch/tool evidence, leave that proof to inspectNativeHistory:
            // it either retains a goal fence or requires a native terminal list.
            // Explicit queued input must load and re-prove before dispatch.
            if (thread.status?.type === 'notLoaded') {
              if (candidate.status === 'interrupted' || (expected.runId === candidate.id && expected.pendingCommandTools?.length)) {
                const recovered = this.options.nativeJournal
                  ? await this.options.nativeJournal.cleanupRecovered(sessionKey, candidate.id)
                  : this.legacyExecutions.cleanupRecovered(sessionKey, candidate.id);
                check();
                if (!recovered) {
                  cleanupUnconfirmed = expected.nativeHistory?.reason === 'background-work' ? 'background-work' : true;
                  break;
                }
              }
              continue;
            }
            try { await observeTerminalDrain(candidate); }
            catch (error) {
              if (error instanceof RolloutObservationPendingError) throw error;
              check(); cleanupUnconfirmed = error instanceof BackgroundTerminalDrainError ? 'background-work' : true; break;
            }
          }
          // Initial completion needs the same protected-history checkpoint as
          // successors when cleanup is unconfirmed. A running terminal is not
          // a failed final-history read; it must never certify queue admission.
          if (successorHistory || expected.nativeHistory || thread.status?.type === 'notLoaded' || cleanupUnconfirmed) {
            nativeHistory = await this.inspectNativeHistory(thread, expected, check, cleanupUnconfirmed, false, nativeRead);
          }
          if (nativeHistory?.reason === 'changed') {
            incompleteReason = 'Native history or goal changed during verification'; continue;
          }
        } else await observeTerminalDrain(turn);
        } catch (error) {
          if (!(error instanceof RunControlConflict)) throw error;
          if (!expected || !connectionId || !readableDuringSuccessorActivity()) {
            // Activity invalidates THIS proof, not the original completed run.
            // Retry a wholly fresh snapshot within the existing attempt/time
            // budget only if its durable and local owners are still exact.
            // Never reuse the rejected messages or certify changed ownership.
            observed = await this.readExecutionFact(sessionKey);
            if (sameTurn() && revision === observed?.revision && version === this.projectionVersion(sessionKey)
              && !activityCurrent() && readBudget > 0) {
              incompleteReason = 'Native activity changed during execution verification';
              continue;
            }
            throw error;
          }
          nativeHistory = protectedCheckpoint(); protectedRead = true;
        }
        // Original cleanup belongs to the proof window, not to a post-commit
        // finally. After the actual disposal settles, recheck the original
        // activity/revision before any message or execution publication.
        if (!rolloutTransferred) {
          readStage = 'rollout-cleanup';
          rolloutTransferred = true;
          const cleanupStarted = performance.now();
          try { await this.rolloutReader.disposeSnapshotWithin(thread.path, rollout, Math.max(1, Math.ceil(readBudget))); }
          finally { readBudget -= performance.now() - cleanupStarted; }
        }
        readStage = 'history-storage-read';
        messages = preserveUnfinishedAssistantStreams(turns, this.options.store.getMessages(sessionKey), messages);
        const historyPlan = await this.prepareHistory(sessionKey, messages);
        observed = await this.readExecutionFact(sessionKey);
        if (!activityCurrent()) {
          if (!expected || !connectionId || !readableDuringSuccessorActivity()) {
            incompleteReason = 'Native activity changed during final synchronization'; continue;
          }
          nativeHistory = protectedCheckpoint(); protectedRead = true;
        }
        if (!sameTurn()) return;
        if (revision !== observed?.revision || version !== this.projectionVersion(sessionKey)) {
          incompleteReason = 'New execution or live events arrived during final synchronization'; continue;
        }
        // Never let a final read erase an assistant item already delivered live.
        const live = this.options.store.getMessages(sessionKey);
        if (protectedRead) {
          // Never roll an already-visible successor delta back to the earlier
          // snapshot. Its live rows are outside this terminal's read proof.
          const terminalIds = new Set(turns.slice(0, trackedIndex + 1).map(turn => turn.id));
          const retained = new Map(messages.map(message => [message.id, message]));
          for (const message of live) if (!message.turnId || !terminalIds.has(message.turnId)) retained.set(message.id, message);
          messages = [...retained.values()];
          // These are current live successor rows, outside the old terminal's
          // ACK-bound expansion proof. Preserve them without another SQL read.
          const prepared = new Map(historyPlan.messages.map(message => [message.id, message]));
          for (const message of live) if (!message.turnId || !terminalIds.has(message.turnId)) prepared.set(message.id, message);
          historyPlan.messages = [...prepared.values()];
        }
        readStage = 'final-history';
        this.projectInterruptedTools(sessionKey, turn, messages, expected ?? null);
        // The original interrupted-tool mapper can append/replace tool rows.
        // Preserve its final mapping without redoing user evidence or SQL.
        const toolRows = new Map(messages.filter(message => message.role === 'tool').map(message => [message.id, message]));
        historyPlan.messages = historyPlan.messages.map(message => toolRows.get(message.id) ?? message);
        const plannedIds = new Set(historyPlan.messages.map(message => message.id));
        for (const message of toolRows.values()) if (!plannedIds.has(message.id)) historyPlan.messages.push(message);
        const finalTurnIds = new Set(successorHistory ? turns.slice(trackedIndex)
          .filter(turn => ['completed', 'failed', 'interrupted'].includes(turn.status)).map(turn => turn.id) : [turn.id]);
        const gaps = finalHistoryGaps(turn.id, finalTurnIds, live, messages);
        const placeholders = gaps.placeholders;
        if (gaps.assistants || gaps.tools || gaps.unfinished) {
          incompleteReason = `Final history missing ${gaps.assistants} assistant items, ${gaps.tools} live tools; ${gaps.unfinished} tools still incomplete`;
          continue;
        }
        // Commit BEFORE touching visible messages/activities. A stale CAS must
        // not leave a partially published successful final response. During the
        // await, this original completion reservation continues blocking sends.
        if (this.options.nativeJournal && expected) {
          const publishedCurrent = () => sameTurn() && version === this.projectionVersion(sessionKey)
            && (protectedRead ? readableDuringSuccessorActivity() : activityCurrent());
          if (!publishedCurrent()) continue;
          let settled: boolean;
          try { settled = await this.options.nativeJournal.settleHistory(expected, 'current', nativeHistory); }
          catch {
            // Missing ACK is not a failed CAS. Do not follow an unknown write
            // with an error settlement or replay; retain the original fence.
            reconciliationFailed = true; this.invalidateExecution(); return;
          }
          if (!settled) {
            incompleteReason = 'Execution changed during final history settlement';
            // A durable unresolved resume/delivery cannot be cured by reading
            // the same large transcript five times. Stop only on fresh,
            // unchanged worker evidence; a changed fact still gets the bounded
            // reconciliation path. Never publish or unlock a rejected CAS.
            const current = await this.readHistoryFact(sessionKey);
            observed = current.execution ?? undefined;
            if (!localCurrent()) return;
            if (sameTurn() && current.outcomeUnknown && !current.deleted && isDeepStrictEqual(current.execution, expected)) {
              incompleteReason = 'Native resume or delivery outcome remains unresolved';
              break;
            }
            continue;
          }
          historyCommitted = true;
          if (!publishedCurrent()) {
            // A native event can arrive after DB COMMIT but before its ACK.
            // Strengthen the checkpoint, never retry that write as an unlock.
            await this.options.nativeJournal.invalidateHistory(sessionKey);
            historyCommitted = false;
            if (!localCurrent()) return;
            incompleteReason = 'Native activity changed during final history settlement'; continue;
          }
        }
        if (this.options.nativeJournal) {
          // settleHistory refreshed the owner's display fact. Keep this
          // completion reservation until its structured evidence is drained.
          const indexed = await this.options.nativeJournal.fileIndexProjection({ sessionKey,
            expected: this.options.nativeJournal.projection.get(sessionKey) ?? null,
            evidence: projectionFileEvidence(sessionKey, messages) });
          if (!indexed) { incompleteReason = 'Execution changed during file evidence settlement'; continue; }
          if (!sameTurn() || version !== this.projectionVersion(sessionKey)
            || !(protectedRead ? readableDuringSuccessorActivity() : activityCurrent())) {
            await this.options.nativeJournal.invalidateHistory(sessionKey); historyCommitted = false; continue;
          }
        } else if (expected && turnId) {
          // Bind settlement to this successful read, not the revision captured
          // before retries. A rejected CAS must never publish current history.
          const settled = nativeHistory
            ? this.legacyExecutions.settleNativeHistory(expected, nativeHistory)
            : this.legacyExecutions.settleHistory({ ...expected, runId: turnId }, 'current');
          if (!settled) {
            incompleteReason = 'Execution changed during final history settlement'; continue;
          }
          historyCommitted = true;
        }
        // Only content-free starts proven covered by a full terminal snapshot
        // may be retired. Real unmatched tool input/output still blocks sync.
        for (const id of placeholders) this.options.store.removeMessage(sessionKey, id);
        const retiredCallIds = new Set(live.filter((message) => placeholders.has(message.id)).map((message) => message.toolCallId));
        this.options.store.replaceActivities(sessionKey, this.options.store.getActivity(sessionKey)
          .filter((activity) => activity.status === 'running' && retiredCallIds.has(activity.toolCallId))
          .map((activity) => ({ ...activity, status: 'done', summary: 'Search start resolved by final tool history', updatedAt: completedAt })));
        const interruptedTools = new Set(messages.filter(message => message.turnId === turn.id && message.role === 'tool'
          && message.status === 'failed' && turn.status === 'interrupted').map(message => message.toolCallId));
        this.options.store.replaceActivities(sessionKey, this.options.store.getActivity(sessionKey)
          .filter(activity => activity.status === 'running' && interruptedTools.has(activity.toolCallId))
          .map(activity => ({ ...activity, status: 'error', summary: 'Turn interrupted; native completion output unavailable', updatedAt: completedAt })));
        if (!protectedRead) {
          this.projectUsage(sessionKey, {
            ...usage,
            ...(displaySource ? { rolloutBytes: displaySource.stat.size } : {}),
          });
        }
        this.applyHistory(sessionKey, historyPlan, true);
        this.options.fileIndex?.replaceProjection(sessionKey, messages);
        completedAt = codexTimestampMilliseconds(turn.completedAt) ?? completedAt;
        const hasReply = messages.some((message) => message.turnId === turn.id && message.role === 'assistant');
        this.publishThreadActivity(sessionKey, snapshotRuntime(thread, Date.now()).threadActivity!);
        this.publishRun(sessionKey, {
          turnId: turn.id, phase: outcome, connection: 'connected', sync: 'current', lastEventAt: completedAt,
          ...(nativeHistory ? { executionProtection: { state: nativeHistory.state, nativeTurnId: nativeHistory.turnId, reason: nativeHistory.reason } } : {}),
          ...(nativeHistory?.state === 'blocked' ? { reason: 'History is current; native execution requires verification' }
            : !hasReply && outcome === 'completed' ? { reason: 'Completed without a text response' } : {}),
        }, { runCompletedAt: completedAt, lastActiveAt: completedAt }, 'final-history');
        const publishedVersion = this.projectionVersion(sessionKey);
        const current = await this.readHistoryFact(sessionKey);
        const protectedTerminalDisplay = nativeHistory?.state === 'blocked'
          && thread.turns.every((candidate: any) => ['completed', 'failed', 'interrupted'].includes(candidate.status));
        const terminalDisplay = ['completed', 'failed', 'interrupted'].includes(latestTurn?.status)
          && (['idle', 'notLoaded'].includes(thread.status?.type) || protectedTerminalDisplay && thread.status?.type === 'active');
        const display = displaySource?.complete && connectionId && terminalDisplay && !protectedRead && localCurrent() && activityCurrent()
          && publishedVersion === this.projectionVersion(sessionKey) && !current.deleted && !current.outcomeUnknown
          && current.execution?.commandId === execution?.commandId && current.execution?.runId === turnId
          && !this.activeTurnIds.has(sessionKey) && (!runtimeBusy(this.options.store.getSession(sessionKey)?.runtime) || protectedTerminalDisplay)
          && current.execution?.sync === 'current' && ['completed', 'failed', 'interrupted'].includes(current.execution.phase)
          ? { source: displaySource, connection: connectionId, generation, projection: publishedVersion,
            execution: structuredClone(current.execution), runtime: structuredClone(this.options.store.getSession(sessionKey)?.runtime), activity: activity.current }
          : undefined;
        if (localCurrent() && publishedVersion === this.projectionVersion(sessionKey)) {
          this.threadRefreshResult.set(sessionKey, { at: Date.now(), available: true, recoveryAt: Date.now(),
            terminalIdentity: this.terminalReadIdentity(sessionKey, current.execution), ...(display ? { display } : {}) });
          if (display) this.displayHistory.set(sessionKey, display);
        }
        if (successorHistory && nativeHistory?.state === 'blocked') {
          this.goalDiagnostics.trace(sessionKey, connectionId, 'recovery')(protectedRead
            ? 'terminal_history_readable_during_activity' : 'terminal_history_readable_protected', { version: expected?.revision });
        }
        completedSuccessfully = !nativeHistory || nativeHistory.state === 'verified';
        historyDelivered = true;
        return;
        } finally {
          if (!rolloutTransferred) {
            const originalStage = readStage;
            readStage = 'rollout-cleanup';
            rolloutTransferred = true;
            const cleanupStarted = performance.now();
            try { await this.rolloutReader.disposeSnapshotWithin(thread.path, rollout, Math.max(1, Math.ceil(readBudget))); }
            finally { readBudget -= performance.now() - cleanupStarted; }
            readStage = originalStage;
          }
        }
      }
      throw new NativeHistoryReadError(readStage === 'native-read' ? 'native-read' : 'incomplete', incompleteReason);
    })().catch(async (error) => {
      if (this.executionUnavailable) return;
      if (historyCommitted) {
        // Publication can fail after the physical commit. It is not safe to
        // mark that old revision as an error or wake a successor. Strengthen
        // the persisted fence and leave recovery to a fresh observer.
        reconciliationFailed = true;
        try {
          if (this.options.nativeJournal) await this.options.nativeJournal.invalidateHistory(sessionKey);
          else this.legacyExecutions.invalidateNativeHistory(sessionKey);
        }
        finally { this.invalidateExecution(); }
        return;
      }
      // A failed reconciliation must be visible instead of silently dropping
      // the final response and pretending the session is idle.
      const current = this.options.store.getSession(sessionKey);
      if (!sameTurn()) return;
      reconciliationFailed = true;
      if (this.options.nativeJournal && failureExpected && turnId) {
        if (!await this.options.nativeJournal.settleHistory(failureExpected, 'error') || !localCurrent()) return;
      } else if (!this.options.nativeJournal && failureExpected && turnId) this.legacyExecutions.settleHistory({ ...failureExpected, runId: turnId }, 'error');
      this.historyDiagnostics.failure('final', sessionKey, connectionId, turnId,
        { outcome, attempts, ...historyFailureDiagnostic(error, readStage) });
      // Native RPC/projection failures can contain user content or credentials.
      const reason = error instanceof NativeHistoryReadError || error instanceof BackgroundTerminalDrainError || error instanceof InterruptedDispatchUnconfirmed || error instanceof RolloutObservationPendingError
        ? error.message : 'Final response unavailable';
      const message = `Codex ${outcome}, but AgentOpsDeck could not load the final response: ${reason}`;
      if (current) this.publishRun(sessionKey, { ...(turnId ? { turnId } : {}), phase: outcome, connection: this.child ? 'connected' : 'disconnected', sync: 'error', lastEventAt: Date.now(), reason: message }, { runCompletedAt: completedAt }, 'final-history-error');
    }).catch(() => { reconciliationFailed = true; this.invalidateExecution(); }).finally(() => {
      clearTimeout(pendingTimer);
      // Finish while the original task is still reserved: a logging callback
      // must not reenter and replace the history owner at the settlement edge.
      const metrics = { ...diagnosticSnapshot(), settled: Number(historyDelivered),
        deferred: Number(historyDelivered && !completedSuccessfully), unknown: Number(reconciliationFailed),
        cancelled: Number(!historyDelivered && !reconciliationFailed) };
      for (const [metric, value] of Object.entries(metrics)) trace?.add(metric as Parameters<PerformanceTrace['add']>[0], value);
      trace?.finish(reconciliationFailed);
      this.terminalHistoryObservers.delete(terminalActivity.observe);
      this.completingTurns.delete(sessionKey);
      // A bounded observer timeout must not retire the original projector's
      // live completion markers or buffers. A later read can recover after
      // actual settlement; it must not be a replacement projection owner.
      if (sameTurn() && !this.assistantProjections.get(sessionKey)?.size) this.clearTransientBuffers(sessionKey);
      if (completedSuccessfully && !this.closed) this.turnWorker.wake();
    });
    this.completingTurns.set(sessionKey, task);
    // Reserve before starting the clock or sink; diagnostic callbacks can reenter.
    trace = performanceDiagnostics.start('codex-final-history');
    pendingTimer = setTimeout(() => trace?.reportPending({ ...diagnosticSnapshot(), pending: 1 }), 1000);
    pendingTimer.unref();
  }

  /** The original physical effect, not a new executor or retry queue. Journal
   * ACK failures latch unavailability; a dispatched intent is NEVER cleared in
   * catch/finally. Register before callbacks so close drains the real task. */
  private resumeRecoveredThread(execution: CodexExecution, threadId: string, fingerprint: string,
    check: () => void, continuation: NativeResumeInput['continuation'] = null, timeoutMs?: number, excludeTurns = false) {
    const journal = this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal;
    const params = { threadId, ...(excludeTurns ? { excludeTurns: true } : {}),
      ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {}) };
    if (!journal) { check(); return this.request('thread/resume', params, timeoutMs); }
    const runId = execution.runId;
    if (!runId || this.closed || this.executionUnavailable || this.authorizingEffects.size >= 128) return Promise.reject(new RunControlConflict());
    const child = this.child, connectionId = this.connectionId, generation = this.nativeConnectionGeneration;
    const local = () => {
      if (this.closed || this.executionUnavailable || !connectionId || connectionId !== this.connectionId
        || child !== this.child || generation !== this.nativeConnectionGeneration) throw new RunControlConflict();
    };
    const task = Promise.resolve().then(async () => {
      let receipt: NativeResumeReceipt | null = null, preparing = false, dispatched = false, finished = false;
      try {
        local(); check();
        preparing = true;
        receipt = await journal.prepareResume({ expected: { sessionKey: execution.sessionKey, commandId: execution.commandId,
          connectionId: execution.connectionId, runId, revision: execution.revision },
          nativeConnectionId: connectionId!, threadId, fingerprint, continuation });
        preparing = false;
        if (!receipt) throw new RunControlConflict();
        local(); check();
        if (!await journal.beginResume(receipt)) throw new RunControlConflict();
        local(); check();
        // Final transport guard is synchronous, after observation waits and
        // before the original stdin write. Do not reuse pre-write activity
        // epochs here: dispatchRequest records our own effect first.
        // Observation/authorization waits may reject before reaching transport.
        // Only the original write callback can establish possible dispatch.
        const result = await this.request('thread/resume', params, timeoutMs, undefined,
          () => { local(); dispatched = true; });
        const resumed = historyThread(result, threadId);
        // An exact resume ACK settles transport only; empty turns are never
        // evidence of history or permission to start another turn.
        if (excludeTurns && !['idle', 'active'].includes(resumed.status?.type)) {
          throw new NativeHistoryReadError('schema', 'Invalid Codex resume status');
        }
        if (!await journal.finishResume(receipt, 'acknowledged')) throw new RunControlConflict();
        finished = true;
        local();
        return result;
      } catch (error) {
        if (preparing) this.invalidateExecution();
        else if (receipt && !dispatched) {
          try { if (!await journal.finishResume(receipt, 'not_dispatched')) this.invalidateExecution(); }
          catch { this.invalidateExecution(); }
        } else if (dispatched && !finished) this.invalidateExecution();
        throw error;
      }
    });
    // Keep an unexposed physical lifetime. Caller-owned Promise properties
    // cannot turn the close barrier into an already-settled/thenless value.
    const physical = new Promise<void>(resolve => { void Promise.prototype.then.call(task, () => resolve(), () => resolve()); });
    this.authorizingEffects.add(physical);
    void physical.then(() => { this.authorizingEffects.delete(physical); });
    return task;
  }

  private async rehydrateCheckpointThread(sessionKey: string, authorityCheck: () => void = () => {}, blockedGoalInput = false,
    continuation: NativeResumeInput['continuation'] = null) {
    let observed = await this.readHistoryFact(sessionKey);
    const execution = observed.execution;
    // A failed final read may never have produced a nativeHistory checkpoint.
    // Cold terminal enumeration then fails forever unless the worker can load
    // this exact owned terminal using the same guarded recovery as a checkpoint.
    // This is loading only: fresh reconciliation must still prove execution safe.
    if (observed.deleted || observed.outcomeUnknown || !execution || !execution.runId || execution.preparation || execution.reason
      || !['completed', 'failed', 'interrupted'].includes(execution.phase)) return;
    if (!execution.nativeHistory && (execution.sync !== 'error' || !['completed', 'failed'].includes(execution.phase))) return;
    await this.ensureStarted(authorityCheck);
    const connectionId = this.connectionId;
    const child = this.child, generation = this.nativeConnectionGeneration;
    const version = this.projectionVersion(sessionKey);
    const activity = this.nativeHistoryActivityGuard(this.threadId(sessionKey));
    let readBudget = this.options.requestTimeoutMs ?? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS;
    const nativeRead = async (method: string, params: unknown, timeoutMs?: number) => {
      if (readBudget <= 0) throw new Error('Codex cold recovery read budget exhausted');
      const started = performance.now();
      try {
        const result = await activity.request(method, params, Math.min(timeoutMs ?? readBudget, readBudget));
        observed = await this.readHistoryFact(sessionKey);
        return result;
      }
      finally { readBudget -= performance.now() - started; }
    };
    const guard = () => {
      const current = activity.checkpoint();
      return () => {
        authorityCheck();
        if (this.closed || this.executionUnavailable || !connectionId || connectionId !== this.connectionId
          || child !== this.child || generation !== this.nativeConnectionGeneration
          || (this.options.nativeJournal ? observed.deleted || observed.outcomeUnknown || observed.execution?.revision !== execution.revision
            : this.legacyExecutions.isDeletedTerminal(sessionKey) || this.legacyExecutions.get(sessionKey)?.revision !== execution.revision)
          || this.projectionVersion(sessionKey) !== version || !current()) throw new RunControlConflict();
      };
    };
    const check = guard();
    check();
    const threadId = this.threadId(sessionKey);
    const snapshot = await nativeRead('thread/read', { threadId, includeTurns: true });
    check();
    // This dedicated load-only path uses the terminal reload's exact ownership,
    // Goal, child-work and projection fences. Its own native effects invalidate
    // the activity snapshot above: do not reuse/reset it or certify readiness.
    // The worker must perform fresh final reconciliation after loading.
    // Read-only refreshes remain pure.
    if (snapshot?.thread?.status?.type === 'systemError') {
      const hasResumeJournal = Boolean(this.maintenanceRecovery.getStore()?.resumes ?? this.options.nativeJournal?.prepareResume);
      const recovered = hasResumeJournal
        ? await this.reloadJournaledErroredTerminal(sessionKey, snapshot, nativeRead, authorityCheck, continuation)
        : await this.reloadErroredTerminal(sessionKey, snapshot, nativeRead, authorityCheck);
      historyThread(recovered, threadId);
      authorityCheck();
      return;
    }
    const thread = historyThread(snapshot, threadId);
    check();
    const head = thread.turns.at(-1);
    const ownedIndex = thread.turns.findIndex((turn: any) => turn.id === execution.runId);
    // Loading a proven terminal successor is not adoption of its run identity.
    // The saved head must still match, and the entire owned-to-head interval
    // must be terminal; referenced child work gets its own independent proof.
    if (!['notLoaded', 'idle'].includes(thread.status?.type) || !head || ownedIndex < 0
      || thread.turns[ownedIndex].status !== execution.phase
      || (execution.nativeHistory ? execution.nativeHistory.turnId : execution.runId) !== head.id
      || thread.turns.slice(ownedIndex).some((turn: any) => !['completed', 'failed', 'interrupted'].includes(turn.status))) return;
    const children = thread.turns.slice(ownedIndex).some((turn: any) => hasNativeChildWork(turn.items, threadId));
    if (thread.status?.type !== 'notLoaded' && !children) return;
    const before = nativeGoalEvidence(await nativeRead('thread/goal/get', { threadId }), threadId);
    check();
    if (nativeGoalProtection(before.status) && !(blockedGoalInput && before.status === 'blocked')) return;
    if (children) {
      try {
        const items = thread.turns.slice(ownedIndex).flatMap((turn: any) => turn.items);
        const turnIds = new Set<string>(thread.turns.map((turn: any) => turn.id));
        if (await rehydrateNativeChildren(threadId, items, nativeRead, guard,
          async path => { if (typeof path !== 'string') throw new RunControlConflict(); await this.validateRolloutSnapshot(path); }, turnIds, undefined,
          async (id, fingerprint, timeoutMs) => {
            const current = guard();
            observed = await this.readHistoryFact(sessionKey); current();
            return this.resumeRecoveredThread(execution, id, fingerprint, current, null, timeoutMs);
          })) {
          // Loading never certifies completion. The worker now does fresh
          // reconciliation, including process lists and final dispatch guards.
          this.threadRefreshResult.delete(sessionKey);
          return;
        }
        await inspectNativeChildren(threadId, items, nativeRead, check, undefined, turnIds);
      } catch { guard()(); return; }
    }
    if (thread.status?.type !== 'notLoaded') return;
    await this.validateRolloutSnapshot(thread.path);
    check();
    const latest = historyThread(await nativeRead('thread/read', { threadId, includeTurns: true }), threadId);
    check();
    if (latest.status?.type !== 'notLoaded' || nativeHistoryFingerprint(latest) !== nativeHistoryFingerprint(thread)) return;
    const after = nativeGoalEvidence(await nativeRead('thread/goal/get', { threadId }), threadId);
    check();
    if (before.version !== after.version || nativeGoalProtection(after.status) && !(blockedGoalInput && after.status === 'blocked')) return;
    const trace = this.goalDiagnostics.trace(sessionKey, connectionId, 'recovery');
    observed = await this.readHistoryFact(sessionKey);
    check();
    trace('terminal_load_started', { version: execution.revision });
    if (this.options.nativeJournal && blockedGoalInput && !continuation) throw new TurnAuthorizationError();
    const resumedPayload = await this.resumeRecoveredThread(execution, threadId, nativeHistoryFingerprint(thread), check, continuation, undefined, true);
    const ack = historyThread(resumedPayload, threadId);
    authorityCheck();
    if (ack.status?.type !== 'idle') return;
    const resumed = historyThread(await nativeRead('thread/read', { threadId, includeTurns: true }), threadId);
    authorityCheck();
    observed = await this.readHistoryFact(sessionKey);
    authorityCheck();
    const current = observed.execution;
    // Loading itself can emit a Goal/status notification. Its sole persistent
    // change is to strengthen history protection, not transfer execution
    // ownership. Accept exactly that one transition after resume; tool, run,
    // queue and connection changes still conflict. Before resume the original
    // exact-revision guard remains mandatory.
    const protectionOnly = resumeProtectionOnly(execution, current);
    if (this.closed || this.executionUnavailable || connectionId !== this.connectionId
      || child !== this.child || generation !== this.nativeConnectionGeneration || observed.deleted
      || current?.commandId !== execution.commandId || current.runId !== execution.runId
      || current.revision !== execution.revision && !protectionOnly
      || current.connectionId !== execution.connectionId || current.phase !== execution.phase
      || current.preparation || current.reason) throw new RunControlConflict();
    if (resumed.status?.type === 'idle' && nativeHistoryFingerprint(resumed) === nativeHistoryFingerprint(thread)) {
      this.loadedThreadIds.add(threadId);
      if (!execution.nativeHistory) {
        const checkpoint: NativeHistoryCheckpoint = { turnId: head.id, fingerprint: nativeHistoryFingerprint(thread), connectionId: connectionId!,
          state: 'blocked', reason: 'native-unavailable' };
        let settled: boolean;
        try {
          settled = this.options.nativeJournal
            ? await this.options.nativeJournal.settleHistory(current, 'current', checkpoint)
            : this.legacyExecutions.settleNativeHistory(current, checkpoint);
        } catch (error) {
          // An absent ACK is not permission to load native work a second time.
          this.invalidateExecution();
          throw error;
        }
        if (!settled) throw new RunControlConflict();
        if (this.closed || this.executionUnavailable || connectionId !== this.connectionId
          || child !== this.child || generation !== this.nativeConnectionGeneration) {
          if (this.options.nativeJournal) await this.options.nativeJournal.invalidateHistory(sessionKey);
          throw new RunControlConflict();
        }
      }
      trace('terminal_load_completed', { version: current.revision });
    }
    this.threadRefreshResult.delete(sessionKey);
  }

  /** Read-only bounded proof. No resume, goal mutation, adoption, or replay.
   * The scheduler uses projectGoal=false: proof reads cannot overwrite its
   * pinned Goal projection/version. Reconciliation retains original display. */
  private async inspectNativeHistory(thread: any, execution: CodexExecution, check: () => void,
    cleanupUnconfirmed: boolean | 'background-work' = false, blockedGoalInput = false,
    nativeRead?: (method: string, params: unknown, timeoutMs?: number) => Promise<any>, projectGoal = true): Promise<NativeHistoryCheckpoint> {
    const activity = nativeRead ? undefined : this.nativeHistoryActivityGuard(thread.id);
    const read = nativeRead ?? activity!.request;
    const authorityCheck = check;
    check = () => {
      authorityCheck();
      if (activity && !activity.current()) throw new RunControlConflict();
    };
    const checkpoint: NativeHistoryCheckpoint = { turnId: thread.turns.at(-1).id,
      fingerprint: nativeHistoryFingerprint(thread), connectionId: this.connectionId!, state: 'blocked', reason: 'native-unavailable' };
    const blocked = (reason: NativeHistoryCheckpoint['reason']) => ({ ...checkpoint, reason });
    const goal = async () => {
      try {
        const result = await read('thread/goal/get', { threadId: thread.id });
        check();
        if (projectGoal) {
          this.goalReadAttempted.add(this.sessionKey(thread.id));
          this.projectGoal(this.sessionKey(thread.id), result, thread.id);
        }
        return nativeGoalEvidence(result, thread.id);
      }
      catch {
        check();
        if (projectGoal) {
          this.goalReadAttempted.add(this.sessionKey(thread.id));
          this.projectGoal(this.sessionKey(thread.id), undefined, thread.id);
        }
        return nativeGoalEvidence(undefined, thread.id);
      }
      finally { check(); }
    };
    check();
    const before = await goal();
    const goalReason = nativeGoalProtection(before.status);
    if (cleanupUnconfirmed) return blocked(cleanupUnconfirmed === 'background-work' ? 'background-work' : 'cleanup-unconfirmed');
    if (goalReason && !(blockedGoalInput && before.status === 'blocked')) return blocked(goalReason);
    if (execution.nativeHistory && !thread.turns.some((turn: any) => turn.id === execution.nativeHistory!.turnId)) return blocked('changed');
    const start = thread.turns.findIndex((turn: any) => turn.id === execution.runId);
    if (start < 0 || thread.turns[start].status !== execution.phase) return blocked('changed');
    if (thread.turns.slice(start).some((turn: any) => !['completed', 'failed', 'interrupted'].includes(turn.status))) {
      return blocked('background-work');
    }
    // Parent/tool completion alone is not child completion. Prove the actual
    // referenced subtree instead of permanently blocking any past child use.
    const children = thread.turns.slice(start).some((turn: any) => hasNativeChildWork(turn.items, thread.id));
    if (children) {
      try { await inspectNativeChildren(thread.id, thread.turns.slice(start).flatMap((turn: any) => turn.items),
        read, check, undefined, new Set<string>(thread.turns.map((turn: any) => turn.id))); }
      catch { check(); return blocked('subagent-review'); }
    }
    const available = (value: any) => value.status?.type === 'notLoaded'
      || value.status?.type === 'idle' && value.canAcceptDirectInput === true;
    if (!available(thread)) return checkpoint;
    try {
      if (blockedGoalInput && before.status === 'blocked') {
        // Older blocked checkpoints could hide an unconfirmed interruption
        // cleanup behind the goal reason. Re-prove the entire terminal window.
        try {
          const targetTurns = thread.turns.slice(start);
          const interruptedTurnIds = targetTurns.filter((turn: any) => turn.status === 'interrupted').map((turn: any) => String(turn.id));
          await this.rolloutReader.projectTurnsAndDisposeWithin(thread.path, interruptedTurnIds,
            this.options.requestTimeoutMs ?? CODEX_HISTORY_VERIFICATION_TIMEOUT_MS, async (rollout, expired) => {
              const proofCheck = () => { check(); if (expired()) throw new RunControlConflict(); };
              // Pure proof only: original IO, iterator, and cleanup retain one
              // owner. Never publish Goal/execution state from this callback.
              proofCheck();
              const terminalObservation = this.backgroundTerminalObservation(thread.id, proofCheck, read);
              for (const turn of targetTurns) {
                proofCheck();
                await this.requireBackgroundTerminalsDrained(thread.id, turn, proofCheck, rollout, read, terminalObservation);
                proofCheck();
              }
            });
        } catch { check(); return blocked('cleanup-unconfirmed'); }
        check();
      }
      if ((await backgroundTerminals(read, thread.id, check)).length) return blocked('background-work');
      const latest = historyThread(await read('thread/read', { threadId: thread.id, includeTurns: true }), thread.id);
      check();
      const after = await goal();
      if (before.version !== after.version || nativeGoalProtection(after.status) && !(blockedGoalInput && after.status === 'blocked')
        || !available(latest) || nativeHistoryFingerprint(latest) !== checkpoint.fingerprint) return blocked('changed');
    } catch { check(); return blocked('native-unavailable'); }
    check();
    return { ...checkpoint, state: 'verified', reason: 'settled' };
  }

  private async requireNativeHistoryForDispatch(sessionKey: string, threadId: string, blockedGoalInput = false) {
    const execution = this.legacyExecutions.get(sessionKey);
    if (!execution?.nativeHistory) return;
    const connectionId = this.connectionId;
    const version = this.projectionVersion(sessionKey);
    const activity = this.nativeHistoryActivityGuard(threadId);
    const check = () => {
      if (this.closed || this.executionUnavailable || !connectionId || connectionId !== this.connectionId
        || this.legacyExecutions.get(sessionKey)?.revision !== execution.revision
        || this.projectionVersion(sessionKey) !== version || !activity.current()) throw new TurnStartDeferred();
    };
    try {
      check();
      if (!this.legacyExecutions.canStart(sessionKey, blockedGoalInput) || execution.nativeHistory.connectionId !== connectionId) throw new TurnStartDeferred();
      const thread = historyThread(await activity.request('thread/read', { threadId, includeTurns: true }), threadId);
      check();
      if (nativeHistoryFingerprint(thread) !== execution.nativeHistory.fingerprint) throw new TurnStartDeferred();
      // Cleanup is proven for this immutable history by reconciliation; repeat
      // native availability, goal, terminal-list and snapshot checks at send.
      const proof = await this.inspectNativeHistory(thread, execution, check, false, blockedGoalInput, activity.request);
      check();
      if (proof.state !== 'verified') throw new TurnStartDeferred();
      // The caller must check once more after its await resumes, in the same
      // synchronous turn as resume/start/compact. A notification can invalidate
      // the proof in that last microtask gap as well as during native reads.
      return check;
    } catch {
      // Invalidate only the predecessor inspected here, not a newly begun run.
      if (this.legacyExecutions.get(sessionKey)?.revision === execution.revision) {
        this.legacyExecutions.invalidateNativeHistory(sessionKey);
        this.threadRefreshResult.delete(sessionKey);
      }
      throw new TurnStartDeferred();
    }
  }

  private drainQueuedTurn(sessionKey: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.queuedDrainInflight.get(sessionKey);
    if (existing) return existing;
    const task = (this.options.queuedConsumer ? this.options.queuedConsumer.run(sessionKey).then(() => {})
      : this.dispatchQueuedTurn(sessionKey)).finally(() => this.queuedDrainInflight.delete(sessionKey));
    this.queuedDrainInflight.set(sessionKey, task);
    return task;
  }

  private async dispatchQueuedTurn(sessionKey: string) {
    if (this.executionUnavailable) return;
    if (this.blockUnauthorizedHead(sessionKey)) return;
    if (!this.legacyExecutions.canStart(sessionKey, true)) return;
    const current = this.options.store.getSession(sessionKey);
    if (!current || runtimeBusy(current.runtime) || (current.runtime && current.runtime.sync !== 'current') || current.hasActiveRun
      || (!this.legacyExecutions.get(sessionKey) && this.activeTurnIds.has(sessionKey))) return;
    const entries = waitingBatch(this.legacyTurnQueue.list<CodexQueuedPayload>('codex', sessionKey, 16),
      entry => this.authorized(sessionKey, entry.payload.actorId, entry.payload.executionGrant));
    const next = entries[0];
    if (!next) return;
    const admission = { proof: codexAdmissionProof(this.legacyTurnQueue, entries) };
    const batch = describeBatch(entries);
    const text = entries.map(entry => entry.payload.text).join(batch?.separator ?? '');
    const images = entries.flatMap(entry => entry.payload.images);
    const defer = () => {
      // No claim exists until begin's owning transaction commits. Refresh
      // original rows, never restore an old edited/cancelled snapshot or defer
      // work claimed by another consumer while input preparation was waiting.
      const ids = new Set(entries.map(entry => entry.id));
      for (const entry of this.legacyTurnQueue.list<CodexQueuedPayload>('codex', sessionKey, 16))
        if (ids.has(entry.id)) this.projectQueuedTurn(entry);
    };
    try {
      const result = await this.sendQueued(sessionKey, text, images, next.id, next.payload.actorId, next.payload.executionGrant, batch, entries, true, admission);
      if (result.status === 'queued') {
        defer();
        return;
      }
      for (const entry of entries) {
        const dispatched = this.options.store.getMessage(sessionKey, entry.id);
        this.options.store.addMessage({ ...this.queuedTurnMessage(entry), turnId: result.runId,
          createdAt: dispatched?.createdAt ?? Date.now(),
          queueVersion: undefined, queueDisposition: undefined, status: 'sent' });
      }
    } catch (error) {
      try {
        const execution = this.legacyExecutions.get(sessionKey);
        if (execution?.commandId === next.id && execution.runId) {
          this.invalidateExecution();
          return;
        }
        if (execution?.commandId !== next.id && !(error instanceof TurnAuthorizationError)) {
          defer();
          // A pre-claim identity race is safely retryable. A storage/resource
          // failure is not: preserve the editable waiting rows, but stop this
          // owner's automatic dispatch until its original recovery lifecycle.
          if (!(error instanceof TurnStartDeferred || error instanceof RunControlConflict)) this.invalidateExecution();
          return;
        }
        const outcome = settleCodexDispatchFailure<CodexQueuedPayload>(
          { turns: this.legacyTurnQueue, codexExecutions: this.legacyExecutions }, sessionKey, next.id,
          execution ? { commandId: execution.commandId, connectionId: execution.connectionId, revision: execution.revision } : null,
          admission.proof, error instanceof TurnAuthorizationError,
          entry => this.authorized(sessionKey, entry.payload.actorId, entry.payload.executionGrant)
            && (!(error instanceof RecoveryAuthorizationError)
              || this.authorized(sessionKey, entry.payload.actorId, entry.payload.executionGrant, 'runs:compact')));
        if (!outcome) {
          if (execution?.commandId !== next.id) { defer(); return; }
          this.invalidateExecution(); return;
        }
        if (!this.executionUnavailable) for (const entry of entries) this.projectQueuedTurn({ ...entry, state: outcome });
      } catch {
        this.invalidateExecution();
      }
    }
  }

  private blockUnauthorizedHead(sessionKey: string) {
    const head = this.legacyTurnQueue.head<CodexQueuedPayload>('codex', sessionKey);
    if (head?.state === 'blocked') return true;
    if (head?.state !== 'queued' || this.authorized(sessionKey, head.payload.actorId, head.payload.executionGrant)) return false;
    this.legacyTurnQueue.block('codex', head.id);
    this.projectQueuedTurn({ ...head, state: 'blocked' });
    return true;
  }

  private async projectOwnedBlockedHead(sessionKey: string, headId: string) {
    const version = this.projectionVersion(sessionKey);
    const plan = await this.options.historyReader!.prepare(sessionKey, []);
    if (this.closed || this.executionUnavailable || this.projectionVersion(sessionKey) !== version) return;
    const row = plan.queue.find(({ entry }) => entry.id === headId && entry.state === 'blocked');
    if (row) this.options.store.addMessage(codexQueuedTurnMessage(row.entry, row.metadata,
      this.options.store.getSession(sessionKey)));
  }

  private projectQueuedTurn(entry: QueuedTurn<CodexQueuedPayload>) {
    this.options.store.addMessage(this.queuedTurnMessage(entry));
  }

  private queueDisposition(sessionKey: string, id: string): 'waiting' | 'preparing' {
    return codexQueueDisposition(id, {
      headId: this.legacyTurnQueue.headId('codex', sessionKey) ?? null,
      executionCommandId: this.legacyExecutions.get(sessionKey)?.commandId ?? null,
    }, this.options.store.getSession(sessionKey));
  }

  private queuedTurnMessage(entry: QueuedTurn<CodexQueuedPayload>, updatedAt = Date.now()): ChatMessage {
    return codexQueuedTurnMessage(entry, {
      version: this.legacyTurnQueue.version('codex', entry.sessionKey, entry.id),
      headId: this.legacyTurnQueue.headId('codex', entry.sessionKey) ?? null,
      executionCommandId: this.legacyExecutions.get(entry.sessionKey)?.commandId ?? null,
    }, this.options.store.getSession(entry.sessionKey), updatedAt);
  }

  private replaceHistory(sessionKey: string, messages: ChatMessage[], authoritative: boolean) {
    if (this.options.historyReader) throw new Error('Async history requires prepared publication');
    this.applyHistory(sessionKey, this.prepareHistorySync(sessionKey, messages), authoritative);
  }

  private prepareHistory(sessionKey: string, messages: ChatMessage[]): Promise<CodexHistoryPlan> {
    return this.options.historyReader ? this.options.historyReader.prepare(sessionKey, messages)
      : Promise.resolve(this.prepareHistorySync(sessionKey, messages));
  }

  private prepareHistorySync(sessionKey: string, messages: ChatMessage[]): CodexHistoryPlan {
    messages = this.legacyExecutions.normalizeTurnContexts(sessionKey, messages);
    const headId = this.legacyTurnQueue.headId('codex', sessionKey) ?? null;
    const executionCommandId = this.legacyExecutions.get(sessionKey)?.commandId ?? null;
    return { messages: expandCodexHistory(messages, runId => this.legacyExecutions.batchForRun(sessionKey, runId)),
      sourceIds: messages.map(message => message.id),
      queue: this.legacyTurnQueue.list<CodexQueuedPayload>('codex', sessionKey).map(entry => {
        const version = this.legacyTurnQueue.version('codex', sessionKey, entry.id);
        if (!version) throw new Error('connector_storage_unavailable');
        return { entry, metadata: { version, headId, executionCommandId } };
      }) };
  }

  private applyHistory(sessionKey: string, plan: CodexHistoryPlan, authoritative: boolean) {
    const enrichedMessages = this.subagentTracker.enrichMessages(sessionKey, plan.messages);
    const merged = new Map(enrichedMessages.map((message) => [message.id, message]));
    const previous = new Map(this.options.store.getMessages(sessionKey).map((message) => [message.id, message]));
    for (const { entry, metadata } of plan.queue) {
      merged.set(entry.id, codexQueuedTurnMessage(entry, metadata, this.options.store.getSession(sessionKey), previous.get(entry.id)?.updatedAt ?? entry.createdAt));
    }
    // An expanded envelope is replaced by its durable member IDs. Ordinary
    // hydration preserves unmatched live rows, so explicitly retire only these
    // validated source IDs; queued overlays above must never be removed.
    for (const id of plan.sourceIds) if (!merged.has(id)) this.options.store.removeMessage(sessionKey, id);
    this.options.store.replaceMessages(sessionKey, [...merged.values()], { authoritative });
  }

  private loadQueuedTurns() {
    for (const entry of readCodexStartupQueue(this.legacyTurnQueue)) this.projectQueuedTurn(entry);
  }

  /**
   * App Server tools cannot read raw chat input, and putting credentials in a
   * shell argument would expose them in the tool timeline. Materialize only
   * long, opaque values into private files and give Codex a safe file handle.
   */
  prepareOwnedCredentials(sessionKey: string, text: string, commandId: string): Promise<CodexPreparedCredentials> {
    if (!this.options.credentialExecutionReader || this.closed || this.ownedCredentialPreparations.has(sessionKey)
      || this.ownedCredentialPreparations.size >= 128) return Promise.reject(new Error('Codex credential preparation unavailable'));
    const connectionId = this.connectionId, child = this.child, generation = this.nativeConnectionGeneration;
    const check = () => {
      if (!connectionId || this.closed || this.executionUnavailable || this.connectionId !== connectionId || !this.owns(sessionKey)
        || this.child !== child || this.nativeConnectionGeneration !== generation) {
        throw new Error('Codex credential preparation was invalidated');
      }
    };
    const work = Promise.resolve().then(async (): Promise<CodexPreparedCredentials> => {
      check();
      await this.cleanupSecretFiles(sessionKey);
      check();
      if (this.activeSecretFiles.has(sessionKey)) throw new Error('Previous Codex credential resources are unresolved');
      const bridged = await this.bridgeOpaqueSecrets(sessionKey, text, commandId);
      const resources = this.activeSecretFiles.get(sessionKey);
      try { check(); }
      catch (error) { await this.cleanupSecretFiles(sessionKey, true); throw error; }
      let handed = false, finish: Promise<void> | undefined;
      return { text: bridged, connectionId: connectionId!, dispatching: () => {
        check();
        if (finish || handed || this.cleaningSecretFiles.has(sessionKey) || this.activeSecretFiles.get(sessionKey) !== resources) {
          throw new Error('Codex credential preparation was invalidated');
        }
        // Claim may commit even if its reply is lost. Protect before that IPC,
        // not only before native write or ACK.
        handed = true;
        if (resources) resources.dispatched = true;
      }, finish: outcome => {
        if (finish) return finish.then(() => {});
        finish = Promise.resolve().then(async () => {
          if (outcome !== 'not_started' || this.activeSecretFiles.get(sessionKey) !== resources) return;
          if (resources) resources.dispatched = false;
          await this.cleanupSecretFiles(sessionKey, true);
        });
        // Return only a wrapper; the idempotent physical finish stays private.
        return finish.then(() => {});
      } };
    });
    const release = () => { this.ownedCredentialPreparations.delete(sessionKey); };
    const drain = work.then(release, release);
    this.ownedCredentialPreparations.set(sessionKey, drain);
    return work;
  }

  private bridgeOpaqueSecrets(sessionKey: string, text: string, commandId: string) {
    if (this.preparingSecretFiles.has(sessionKey)) return Promise.reject(new Error('Previous Codex credential resources are unresolved'));
    const connectionId = this.connectionId;
    const task = Promise.resolve().then(() => {
      if (this.closed || connectionId !== this.connectionId) throw new Error('Codex credential preparation was invalidated');
      return this.prepareOpaqueSecrets(sessionKey, text, commandId);
    });
    const release = () => { this.preparingSecretFiles.delete(sessionKey); };
    const drain = task.then(release, release);
    this.preparingSecretFiles.set(sessionKey, drain);
    return task;
  }

  private async prepareOpaqueSecrets(sessionKey: string, text: string, commandId: string) {
    const candidates = findOpaqueSecrets(text);
    if (!candidates.length) return text;
    if (this.activeSecretFiles.has(sessionKey)) throw new Error('Previous Codex credential resources are unresolved');
    const connectionId = this.connectionId;
    const check = () => {
      if (this.closed || this.executionUnavailable || connectionId !== this.connectionId) throw new Error('Codex credential preparation was invalidated');
    };
    check();
    const baseDir = path.join(path.dirname(this.options.queueFile ?? path.join(this.options.defaultCwd, '.agentopsdeck-codex-queue.json')), '.agentopsdeck-codex-secrets');
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    const turnDir = await mkdtemp(path.join(baseDir, 'turn-'));
    let bridged = text;
    try {
      if (process.platform === 'win32') {
        await windowsAsyncControl(SECRET_DIRECTORY_ACL_SCRIPT, { AOD_SECRET_DIRECTORY: turnDir });
      }
      check();
      for (const [index, secret] of candidates.entries()) {
        const file = path.join(turnDir, `secret-${index + 1}.txt`);
        const rawSecret = secret.startsWith('[[AOD_SECRET:') && secret.endsWith(']]')
          ? secret.slice('[[AOD_SECRET:'.length, -2)
          : secret;
        await writeFile(file, rawSecret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        bridged = bridged.replace(secret, `[secure value ${index + 1} stored at ${file}]`);
      }
      check();
    } catch {
      await rm(turnDir, { recursive: true, force: true });
      throw new Error('Unable to prepare the temporary credential directory');
    }
    this.activeSecretFiles.set(sessionKey, { commandId, ...(connectionId ? { connectionId } : {}), directory: turnDir, dispatched: false });
    return `${bridged}\n\nSecurity note: Read each secure value directly from its absolute file path as stdin/input. Do not print, echo, log, or copy its contents into command arguments. The files are private and will be deleted after this command is confirmed terminal.`;
  }

  private async cleanupSecretFiles(sessionKey: string, allowUndispatched = false) {
    const pending = this.cleaningSecretFiles.get(sessionKey);
    if (pending) return pending;
    const resources = this.activeSecretFiles.get(sessionKey);
    if (!resources) return;
    // Keep ownership published until deletion finishes. A successor must wait
    // for this exact resource, not allocate files while its predecessor drains.
    const task = Promise.resolve().then(async () => {
      if (!(allowUndispatched && !resources.dispatched)) {
        if (this.executionUnavailable) return;
        let execution: CodexExecution | undefined;
        try {
          if (this.options.credentialExecutionReader) {
            execution = await this.options.credentialExecutionReader.get(sessionKey);
            if (!validConnectorExecutionOutput('codexExecutionRead', execution ?? null)) throw new Error('Invalid resource observation');
          } else execution = this.legacyExecutions.get(sessionKey);
        } catch {
          try { console.warn('[codex] Temporary credential observation unavailable; resources retained'); }
          catch { /* A diagnostic sink cannot change resource ownership. */ }
          return;
        }
        if (execution?.sessionKey !== sessionKey || execution.commandId !== resources.commandId || !execution.runId
          || resources.connectionId && execution.connectionId !== resources.connectionId
          || !['completed', 'failed', 'interrupted'].includes(execution.phase)) return;
      }
      if (this.activeSecretFiles.get(sessionKey) !== resources) return;
      try {
        await rm(resources.directory, { recursive: true, force: true });
        if (this.activeSecretFiles.get(sessionKey) === resources) this.activeSecretFiles.delete(sessionKey);
      } catch {
        // Retain ownership for a later retry; file paths and native errors may
        // contain sensitive data. Cleanup failure is not a dispatch failure.
        try { console.warn('[codex] Temporary credential cleanup incomplete; resources retained'); }
        catch { /* A diagnostic sink cannot change resource ownership. */ }
      }
    });
    this.cleaningSecretFiles.set(sessionKey, task);
    try { await task; }
    finally {
      if (this.cleaningSecretFiles.get(sessionKey) === task) this.cleaningSecretFiles.delete(sessionKey);
    }
  }

  private async recordAssistantMessage(sessionKey: string, itemId: string, text: string, createdAt: number, turnId?: string, phase?: ChatMessage['phase'], execution?: CodexExecution) {
    const id = codexScopedId(sessionKey, `codex-${itemId}`);
    const connectionId = this.connectionId;
    const generation = this.nativeConnectionGeneration;
    // Use the original settled notification, not a synchronous journal that
    // does not exist in the worker-owned production composition.
    this.completedAssistantItems.add(`${id}:${JSON.stringify([execution?.commandId, turnId])}`);
    const projected = await projectAssistant(text, this.options.projectAssistant);
    const localCurrent = () => !this.closed && !this.executionUnavailable
      && connectionId === this.connectionId && generation === this.nativeConnectionGeneration;
    if (!localCurrent()) return;
    const current = this.options.nativeJournal ? await this.readExecutionFact(sessionKey) : this.legacyExecutions.get(sessionKey);
    // The worker read is itself asynchronous: connection ABA or shutdown
    // during that read must not allow the retired callback to publish.
    if (!localCurrent()) return;
    // Artifact work can outlive its command. Permit that command's ACK and
    // terminal transition, but never let a retired callback alter a successor.
    if (current?.phase === 'unknown' || execution?.commandId !== current?.commandId
      || (execution?.runId && execution.runId !== current?.runId)
      || (turnId && current?.runId && turnId !== current.runId)) return;
    const live = this.options.store.getMessages(sessionKey);
    // Native streams can complete an empty commentary item. History omits
    // these content-free records; retaining one live would block final sync
    // forever as a "missing assistant". Retire only its empty placeholder,
    // never another item's text or a media-only assistant message.
    if (!text.trim() && !projected.media.length) {
      this.releaseAssistantItemRetention(sessionKey, itemId);
      const placeholder = live.find(message => message.id === id);
      if (placeholder && !placeholder.text.trim() && !placeholder.media?.length) {
        this.touchProjection(sessionKey);
        this.options.store.removeMessage(sessionKey, id);
      }
      return;
    }
    if (!this.retainAssistantOutput(sessionKey, itemId, Buffer.byteLength(projected.text), execution, turnId)) return;
    // Some Codex streams use an opaque delta ID, then a canonical item-N ID
    // at completion. Replace only a unique, unfinished alias in this turn;
    // completed commentary and identical replies in other turns are distinct.
    // Match the raw text before artifact projection can rewrite local links.
    const aliases = turnId ? live.filter((message) => message.id !== id
      && snapshotCoversAssistantDelta(message, [{ id, sessionKey, turnId, role: 'assistant', status: 'sent', text, createdAt }])) : [];
    const alias = aliases.length === 1 ? aliases[0] : undefined;
    const previous = live.find((message) => message.id === id) ?? alias;
    if (alias) {
      this.completedAssistantItems.add(`${alias.id}:${JSON.stringify([execution?.commandId, turnId])}`);
      this.options.store.removeMessage(sessionKey, alias.id);
    }
    this.touchProjection(sessionKey);
    this.options.store.addMessage({
      id,
      sessionKey,
      ...(turnId ? { turnId } : {}),
      ...(phase ? { phase } : {}),
      role: 'assistant',
      status: 'sent',
      text: projected.text,
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: Date.now(),
      ...(projected.media.length ? { media: projected.media } : {}),
    });
  }

  private recordToolStarted(sessionKey: string, itemId: string, item: any, startedAt: number) {
    const key = `${sessionKey}:${itemId}`;
    const projection = toolProjection(item);
    const parentThreadId = sessionKey.startsWith('codex:') ? sessionKey.slice('codex:'.length) || undefined : undefined;
    const turnId = this.options.store.getSession(sessionKey)?.runtime?.turnId;
    const callId = codexScopedId(sessionKey, `codex-tool-${itemId}-call`);
    const codexSubagent = this.subagentTracker.registerParentObservation(
      sessionKey,
      turnId,
      callId,
      subagentObservation(item, startedAt, parentThreadId),
    );
    this.toolStartedAt.set(key, startedAt);
    this.toolCallText.set(key, projection.callText);
    this.options.store.addMessage(toolMessage({ sessionKey, turnId, itemId, phase: 'call', text: projection.callText, toolName: projection.toolName, codexSubagent, createdAt: startedAt, status: 'sending' }));
    this.recordToolActivity(sessionKey, itemId, item, startedAt, 'running', 0);
  }

  private recordToolProgress(sessionKey: string, itemId: string, delta: string, now: number) {
    if (!delta) return;
    const key = `${sessionKey}:${itemId}`;
    const callText = this.toolCallText.get(key);
    if (!callText) return;
    const output = appendBoundedTail(this.toolOutput.get(key) ?? '', delta, MAX_LIVE_TOOL_PREVIEW_CHARS);
    this.toolOutput.set(key, output);
    const current = this.options.store.getMessage(sessionKey, codexScopedId(sessionKey, `codex-tool-${itemId}-call`));
    this.options.store.addMessage(toolMessage({
      sessionKey,
      itemId,
      phase: 'call',
      text: `${callText}\n\nActivity: running\nRecent output preview (last 2 KB max):\n${output}`,
      toolName: current?.toolName ?? 'tool',
      codexSubagent: current?.codexSubagent,
      turnId: current?.turnId,
      createdAt: current?.createdAt ?? now,
      status: 'sending',
      updatedAt: now,
    }));
  }

  private recordToolCompleted(sessionKey: string, itemId: string, item: any, completedAt: number) {
    const key = `${sessionKey}:${itemId}`;
    const projection = toolProjection(item);
    const parentThreadId = sessionKey.startsWith('codex:') ? sessionKey.slice('codex:'.length) || undefined : undefined;
    const callId = codexScopedId(sessionKey, `codex-tool-${itemId}-call`);
    const resultId = codexScopedId(sessionKey, `codex-tool-${itemId}-result`);
    const callMessage = this.options.store.getMessage(sessionKey, callId);
    const startedAt = this.toolStartedAt.get(key) ?? callMessage?.createdAt ?? Math.max(0, completedAt - (numberValue(item?.durationMs) ?? 0));
    const failed = toolFailed(item);
    const turnId = this.options.store.getSession(sessionKey)?.runtime?.turnId;
    const startedObservation = this.subagentTracker.applyToObservation(sessionKey, callMessage?.codexSubagent);
    const completedObservation = this.subagentTracker.registerParentObservation(
      sessionKey,
      turnId,
      resultId,
      subagentObservation(item, completedAt, parentThreadId),
    );
    this.options.store.addMessage(toolMessage({ sessionKey, turnId, itemId, phase: 'call', text: this.toolCallText.get(key) ?? projection.callText, toolName: projection.toolName, codexSubagent: startedObservation, createdAt: startedAt, status: 'sent', updatedAt: completedAt }));
    this.options.store.addMessage(toolMessage({
      sessionKey,
      turnId,
      itemId,
      phase: 'result',
      text: projection.resultText,
      toolName: projection.toolName,
      codexSubagent: completedObservation,
      sourceFiles: completedFileChanges(item),
      createdAt: completedAt,
      status: failed ? 'failed' : 'sent',
      ...(failed ? { failureReason: projection.resultText.slice(0, 500) } : {}),
    }));
    this.recordToolActivity(sessionKey, itemId, item, completedAt, failed ? 'error' : 'done', numberValue(item?.durationMs) ?? Math.max(0, completedAt - startedAt));
    this.toolStartedAt.delete(key);
    this.toolCallText.delete(key);
    this.toolOutput.delete(key);
  }

  private recordToolActivity(sessionKey: string, itemId: string, item: any, now: number, status: ActivityEntry['status'], durationMs: number) {
    const projection = toolProjection(item);
    const activity: ActivityEntry = {
      id: `codex-${itemId}`, status, toolName: projection.toolName,
      summary: projection.callText.slice(0, 240), outputPreview: projection.resultText.slice(0, 1_000), runId: itemId,
      toolCallId: itemId, sessionKey, hiddenArgumentCount: 0, updatedAt: now, durationMs,
    };
    this.options.store.replaceActivities(sessionKey, [activity]);
  }

  private sessionKey(threadId: string) { return `codex:${threadId}`; }
  private threadId(sessionKey: string) {
    const threadId = sessionKey.slice('codex:'.length);
    if (!threadId) throw new Error('invalid Codex session key');
    return threadId;
  }
  private session(sessionKey: string, values: Partial<SessionSummary>): SessionSummary {
    return { sessionKey, agentId: 'codex', title: 'Codex task', status: 'idle', source: 'codex', ...values };
  }
  private recycleChild(child: ChildProcessWithoutNullStreams | undefined, error: Error) {
    if (child && this.child !== child) return;
    if (child) this.child = undefined;
    this.setConnection(undefined);
    this.markDisconnected(error);
    this.loadedThreadIds.clear();
    this.activeTurnIds.clear();
    this.clearTransientBuffers();
    this.rejectAll(error);
    if (child) this.stopChild(child);
  }
  private stopChild(child: ChildProcessWithoutNullStreams) {
    const lifetime = this.childLifetimes.get(child);
    if (!lifetime || lifetime.stopRequested || !child.pid) return;
    if (process.platform !== 'linux' && process.platform !== 'win32' && (child.killed || child.exitCode != null || child.signalCode != null)) return;
    lifetime.stopRequested = true;
    // Signal/helper success is not termination evidence. Only the owned
    // child's close event releases its lifetime, including on signal failure.
    try {
      if (process.platform === 'win32') {
        if (lifetime.job) lifetime.job.stop();
        else child.kill(); // dormant bootstrap only; assignment still owns the lifetime fence
      } else if (process.platform === 'linux') {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      } else if (!child.kill('SIGTERM')) {
        console.warn('[codex] Could not signal App Server; still waiting for child close');
      }
    } catch {
      console.warn('[codex] Could not stop App Server; still waiting for child close');
    }
  }
  private retainAssistantOutput(sessionKey: string, itemId: string, bytes: number, execution: CodexExecution | undefined, turnId: string | undefined) {
    const identity = JSON.stringify([this.connectionId, execution?.commandId, turnId]);
    let retained = this.assistantRetention.get(sessionKey);
    if (retained && retained.identity !== identity && !this.assistantProjections.get(sessionKey)?.size) {
      this.assistantRetainedBytes -= retained.bytes;
      this.assistantRetainedItems -= retained.items.size;
      this.assistantRetention.delete(sessionKey);
      retained = undefined;
    }
    const previousBytes = retained?.items.get(itemId);
    const addedBytes = Math.max(0, bytes - (previousBytes ?? 0));
    const addedItems = previousBytes === undefined ? 1 : 0;
    if ((retained && retained.identity !== identity) || itemId.length > 512 || sessionKey.length > 512 || identity.length > 4096
      || bytes > MAX_ASSISTANT_ITEM_BYTES
      || (retained?.bytes ?? 0) + addedBytes > MAX_ASSISTANT_TURN_BYTES
      || (retained?.items.size ?? 0) + addedItems > MAX_ASSISTANT_TURN_ITEMS
      || this.assistantRetainedBytes + addedBytes > MAX_ASSISTANT_RETAINED_BYTES
      || this.assistantRetainedItems + addedItems > MAX_ASSISTANT_RETAINED_ITEMS) {
      this.threadRefreshResult.delete(sessionKey);
      try {
        this.options.store.addMessage({ id: `${sessionKey}:codex-output-incomplete-${createHash('sha256').update(identity).digest('hex')}`,
          sessionKey, ...(turnId ? { turnId } : {}), role: 'system', status: 'failed', createdAt: Date.now(),
          text: 'Assistant output budget exceeded; display incomplete; execution outcome unconfirmed' });
      } finally { this.nativeObservations.unavailable(3); }
      return false;
    }
    const next = retained ?? { identity, bytes: 0, items: new Map<string, number>() };
    next.bytes += addedBytes;
    next.items.set(itemId, Math.max(previousBytes ?? 0, bytes));
    this.assistantRetention.set(sessionKey, next);
    this.assistantRetainedBytes += addedBytes;
    this.assistantRetainedItems += addedItems;
    return true;
  }
  private releaseAssistantItemRetention(sessionKey: string, itemId: string) {
    const retained = this.assistantRetention.get(sessionKey);
    const previousBytes = retained?.items.get(itemId);
    if (retained === undefined || previousBytes === undefined) return;
    retained.bytes -= previousBytes;
    retained.items.delete(itemId);
    this.assistantRetainedBytes -= previousBytes;
    this.assistantRetainedItems -= 1;
    if (!retained.items.size) this.assistantRetention.delete(sessionKey);
  }
  private clearTransientBuffers(sessionKey?: string) {
    if (!sessionKey) {
      this.assistantRetention.clear();
      this.assistantRetainedBytes = 0;
      this.assistantRetainedItems = 0;
      this.subagentTracker.clearAll();
      this.assistantText.clear();
      this.completedAssistantItems.clear();
      this.toolStartedAt.clear();
      this.toolCallText.clear();
      this.toolOutput.clear();
      return;
    }
    const retained = this.assistantRetention.get(sessionKey);
    if (retained) {
      this.assistantRetainedBytes -= retained.bytes;
      this.assistantRetainedItems -= retained.items.size;
      this.assistantRetention.delete(sessionKey);
    }
    const prefix = `${sessionKey}:`;
    for (const key of this.completedAssistantItems) if (key.startsWith(prefix)) this.completedAssistantItems.delete(key);
    for (const key of this.assistantText.keys()) if (key.startsWith(prefix)) this.assistantText.delete(key);
    for (const key of this.toolStartedAt.keys()) if (key.startsWith(prefix)) this.toolStartedAt.delete(key);
    for (const key of this.toolCallText.keys()) if (key.startsWith(prefix)) this.toolCallText.delete(key);
    for (const key of this.toolOutput.keys()) if (key.startsWith(prefix)) this.toolOutput.delete(key);
  }
  private rejectAll(error: Error) {
    for (const [rpcId, receipt] of this.goalWriteReceipts) {
      clearTimeout(receipt.timer);
      receipt.trace?.('ack_connection_lost', { rpcId });
    }
    this.goalWriteReceipts.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.compactWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.compactWaiters.clear();
  }
}

function stringValue(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function itemText(item: any) { return stringValue(item?.text ?? item?.message ?? item?.content?.text ?? item?.output ?? item?.summary) ?? ''; }
function isToolItem(item: any) {
  return new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'collabToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration']).has(String(item?.type));
}

function toolProjection(item: any) {
  const type = stringValue(item?.type) ?? 'tool';
  if (type === 'subAgentActivity') {
    const activity = ['started', 'interacted', 'interrupted'].includes(item?.kind) ? item.kind : 'unknown';
    const text = prettyJson(compactToolHistoryContent({ activity,
      agentThreadId: stringValue(item?.agentThreadId), agentPath: stringValue(item?.agentPath) }));
    // Activity items describe an observation, not a completed child execution.
    // Whitelist metadata; do not replicate unrelated native payload fields.
    return { toolName: 'subagent/activity', callText: `[tool subagent/activity]\nObserved activity:\n${text}`,
      resultText: `[tool subagent/activity]\nObserved activity:\n${text}\nThis activity is not proof that the sub-agent has finished or stopped.` };
  }
  const toolName = type === 'mcpToolCall'
    ? [stringValue(item?.server), stringValue(item?.tool)].filter(Boolean).join('/') || type
    : type === 'dynamicToolCall'
      ? [stringValue(item?.namespace), stringValue(item?.tool)].filter(Boolean).join('/') || type
      : stringValue(item?.tool) ?? type;
  const input = type === 'commandExecution'
    ? { command: item?.command, cwd: item?.cwd }
    : type === 'fileChange'
      ? { changes: arrayValue(item?.changes).map((change: any) => ({ path: change?.path, kind: change?.kind })) }
      : type === 'mcpToolCall' || type === 'dynamicToolCall'
        ? { arguments: item?.arguments }
        : withoutKeys(item, ['id', 'type', 'status', 'result', 'error', 'durationMs', 'aggregatedOutput', 'exitCode', 'contentItems']);
  const result = type === 'commandExecution'
    ? { status: item?.status, exitCode: item?.exitCode, durationMs: item?.durationMs, output: item?.aggregatedOutput }
    : type === 'fileChange'
      ? { status: item?.status, changes: item?.changes }
      : type === 'mcpToolCall'
        ? { status: item?.status, durationMs: item?.durationMs, result: item?.result, error: item?.error }
        : type === 'dynamicToolCall'
          ? { status: item?.status, durationMs: item?.durationMs, success: item?.success, contentItems: item?.contentItems }
          : withoutKeys(item, ['id', 'type']);
  return {
    toolName,
    callText: `[tool ${toolName}]\nTool input:\n\`\`\`json\n${prettyJson(compactToolHistoryContent(input))}\n\`\`\``,
    resultText: `[tool ${toolName}]\nstatus: ${stringValue(item?.status) ?? (toolFailed(item) ? 'failed' : 'completed')}\noutput:\n${prettyJson(compactToolHistoryContent(result))}`,
  };
}

function boundedProjectionText(value: string) {
  if (value.length <= MAX_PROJECTED_TOOL_TEXT_CHARS) return value;
  const marker = '\n\n[AgentOpsDeck omitted tool details; showing beginning and end]\n\n';
  const headChars = Math.floor((MAX_PROJECTED_TOOL_TEXT_CHARS - marker.length) / 3);
  const tailChars = MAX_PROJECTED_TOOL_TEXT_CHARS - marker.length - headChars;
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function appendBoundedTail(current: string, delta: string, maxChars: number) {
  if (delta.length >= maxChars) return delta.slice(-maxChars);
  return `${current}${delta}`.slice(-maxChars);
}

function toolMessage(params: { sessionKey: string; turnId?: string | undefined; itemId: string; phase: 'call' | 'result'; text: string; toolName: string; codexSubagent?: ChatMessage['codexSubagent']; sourceFiles?: ChatMessage['sourceFiles']; createdAt: number; updatedAt?: number; status: NonNullable<ChatMessage['status']>; failureReason?: string }): ChatMessage {
  return {
    id: codexScopedId(params.sessionKey, `codex-tool-${params.itemId}-${params.phase}`),
    sessionKey: params.sessionKey,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    role: 'tool',
    text: params.text,
    toolPreview: params.text.slice(0, 1_000),
    toolDetailAvailable: params.text.length > 1_000,
    toolLineCount: params.text.split(/\r?\n/).length,
    toolCallId: params.itemId,
    toolName: params.toolName,
    toolPhase: params.phase,
    ...(params.codexSubagent ? { codexSubagent: params.codexSubagent } : {}),
    ...(params.sourceFiles?.length ? { sourceFiles: params.sourceFiles } : {}),
    createdAt: params.createdAt,
    updatedAt: params.updatedAt ?? params.createdAt,
    status: params.status,
    ...(params.failureReason ? { failureReason: params.failureReason } : {}),
  };
}

function toolFailed(item: any) { return item?.status === 'failed' || item?.status === 'declined' || item?.success === false || Boolean(item?.error) || (typeof item?.exitCode === 'number' && item.exitCode !== 0); }

function codexScopedId(sessionKey: string, id: string) {
  return `${sessionKey}:${id}`;
}

function codexTurnFailureReason(params: any) {
  return stringValue(params?.turn?.error?.message ?? params?.error?.message ?? params?.turn?.error ?? params?.error)
    ?? 'Codex turn failed without an error message';
}

function isPayloadTooLargeError(value: unknown) {
  return /\b413\b.*payload too large|payload too large.*\b413\b/i.test(String(value ?? ''));
}

function isOversizedMediaTurn(turn: unknown) {
  const serialized = JSON.stringify(turn ?? {});
  const mediaItems = (serialized.match(/"type":"(?:imageView|imageGeneration|localImage|input_image|image)"/g) ?? []).length;
  return Buffer.byteLength(serialized, 'utf8') > 8 * 1024 * 1024 || mediaItems > 8;
}

/** Immutable transcript ownership only; never execution/admission authority. */
function terminalHistoryOwner(thread: any, runId: string | undefined, outcome?: string) {
  if (!runId || !['idle', 'notLoaded', 'active'].includes(thread.status?.type)) return undefined;
  const turns = arrayValue(thread.turns), index = turns.findIndex(turn => turn.id === runId);
  const owner = turns[index];
  if (!owner || !['completed', 'failed', 'interrupted'].includes(owner.status)
    || outcome !== undefined && owner.status !== outcome) return undefined;
  return turns.slice(index + 1).every((turn, offset) => ['completed', 'failed', 'interrupted'].includes(turn.status)
    || turn.status === 'inProgress' && index + 1 + offset === turns.length - 1) ? owner : undefined;
}

function terminalSuccessorOwner(thread: any, runId: string | undefined) {
  if (!runId || !['idle', 'notLoaded'].includes(thread.status?.type)) return undefined;
  const turns = arrayValue(thread.turns), index = turns.findIndex(turn => turn.id === runId);
  return index >= 0 && index < turns.length - 1
    && turns.slice(index).every(turn => ['completed', 'failed', 'interrupted'].includes(turn.status))
    ? turns[index] : undefined;
}

function historyThread(result: any, threadId: string) {
  const record = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const thread = result?.thread;
  if (!record(thread) || thread.id !== threadId || !Array.isArray(thread.turns)
    || thread.turns.some((turn: any) => !record(turn) || !Array.isArray(turn.items) || turn.items.some((item: any) => !record(item)))) {
    throw new NativeHistoryReadError('schema', 'Invalid Codex thread history');
  }
  if (thread.status?.type === 'systemError') throw new NativeHistoryReadError('system-error', 'Codex thread unavailable');
  // Projection keys are session-scoped. Anonymous or colliding native identities
  // cannot certify history readiness (including before recovery mutations).
  const turnIds = new Set<string>(), itemIds = new Set<string>();
  const unique = (id: unknown, seen: Set<string>) => {
    if (typeof id !== 'string' || !id || stringValue(id) !== id || seen.has(id)) throw new NativeHistoryReadError('identity', 'Invalid Codex thread history identity');
    seen.add(id);
  };
  for (const turn of thread.turns) {
    if (turn.itemsView && turn.itemsView !== 'full') throw new NativeHistoryReadError('item-view', 'Invalid Codex thread history item view');
    unique(turn.id, turnIds);
    for (const item of turn.items) {
      if (item.type === 'userMessage' || item.type === 'agentMessage' || isToolItem(item)) unique(item.id, itemIds);
    }
  }
  return thread;
}
function arrayValue(value: unknown) { return Array.isArray(value) ? value : []; }
function withoutKeys(value: any, keys: string[]) { return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key))); }
function prettyJson(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value ?? ''); }
}

export async function historicalMessages(sessionKey: string, turns: unknown, projector?: CodexAssistantProjector, rollout: RolloutSource = '', rolloutPath?: string): Promise<ChatMessage[]> {
  return (await historicalProjection(sessionKey, turns, projector, rollout, rolloutPath)).messages;
}

/** One immutable snapshot supplies all enrichment. Execution safety is checked separately. */
export async function historicalProjection(sessionKey: string, turns: unknown, projector?: CodexAssistantProjector, rollout: RolloutSource = '', rolloutPath?: string) {
  const messages: ChatMessage[] = [];
  const facts = await historicalRolloutFacts(rollout);
  const { itemTimes: rolloutTimes, assistantTimes } = facts;
  const parentThreadId = sessionKey.startsWith('codex:') ? sessionKey.slice('codex:'.length) || undefined : undefined;
  for (const [turnIndex, turn] of arrayValue(turns).entries()) {
    const turnId = turn.id;
    const turnStartedAt = codexTimestampMilliseconds(turn?.startedAt) ?? turnIndex;
    for (const [itemIndex, item] of arrayValue(turn?.items).entries()) {
      const itemId = item.id;
      const createdAt = rolloutTimes.get(itemId) ?? codexTimestampMilliseconds(item?.createdAt) ?? turnStartedAt + itemIndex * 2;
      if (item?.type === 'userMessage') {
        // User input is lossless: trimming breaks code indentation and the
        // boundaries of batches with an image-only first/last message.
        const text = arrayValue(item?.content).filter((input: any) => input?.type === 'text' && typeof input.text === 'string').map((input: any) => input.text).join('\n');
        const media = historicalUserImages(item?.content);
        if (text || media.length) messages.push({
          id: stringValue(item?.clientId) ?? codexScopedId(sessionKey, `codex-${itemId}`),
          sessionKey,
          turnId,
          role: 'user',
          text,
          status: 'sent',
          createdAt,
          updatedAt: createdAt,
          ...(media.length ? { media } : {}),
        });
        continue;
      }
      if (item?.type === 'agentMessage') {
        const text = stringValue(item?.text);
        if (text) {
          const matchedTimes = assistantTimes.get(assistantTimelineKey(text));
          const assistantCreatedAt = matchedTimes?.shift() ?? createdAt;
          const projected = await projectAssistant(text, projector);
          messages.push({ id: codexScopedId(sessionKey, `codex-${itemId}`), sessionKey, turnId, ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}), role: 'assistant', text: projected.text, status: 'sent', createdAt: assistantCreatedAt, updatedAt: assistantCreatedAt, ...(projected.media.length ? { media: projected.media } : {}) });
        }
        continue;
      }
      if (isToolItem(item)) {
        const projection = toolProjection(item);
        const failed = toolFailed(item);
        const executing = ['inProgress', 'in_progress', 'running'].includes(item.status);
        const subagent = subagentObservation(item, undefined, parentThreadId);
        messages.push(toolMessage({ sessionKey, turnId, itemId, phase: 'call', text: projection.callText, toolName: projection.toolName, codexSubagent: subagent, createdAt, status: executing ? 'sending' : 'sent' }));
        if (executing) continue;
        messages.push(toolMessage({
          sessionKey,
          turnId,
          itemId,
          phase: 'result',
          text: projection.resultText,
          toolName: projection.toolName,
          codexSubagent: subagent,
          sourceFiles: completedFileChanges(item),
          createdAt: createdAt + 1,
          status: failed ? 'failed' : 'sent',
          ...(failed ? { failureReason: projection.resultText.slice(0, 500) } : {}),
        }));
      }
    }
    const failureReason = turn?.status === 'failed' ? codexTurnFailureReason({ turn }) : undefined;
    if (failureReason) {
      const completedAt = codexTimestampMilliseconds(turn?.completedAt) ?? turnStartedAt + arrayValue(turn?.items).length * 2;
      messages.push({
        id: codexScopedId(sessionKey, `codex-turn-failure-${turnId}`),
        sessionKey,
        turnId,
        role: 'assistant',
        text: failureReason,
        status: 'failed',
        failureReason,
        createdAt: completedAt,
        updatedAt: completedAt,
      });
    }
  }
  const nativeToolIds = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId));
  for (const message of historicalRolloutToolMessages(sessionKey, facts, rolloutPath, arrayValue(turns))) {
    if (!nativeToolIds.has(message.toolCallId)) messages.push(message);
  }
  if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error('Invalid Codex thread history message identity');
  return { messages: messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    model: facts.model, usage: facts.usage };
}

const assistantTimelineKey = (text: string) => createHash('sha256').update(text).digest('hex');
// One pass over the immutable, already verified projection. Do not retain
// parsed records or full source text, or cache session-scoped mutable facts.
async function historicalRolloutFacts(rollout: RolloutSource) {
  const model = createRolloutModelAccumulator(), usage = createRolloutUsageAccumulator();
  const itemTimes = new Map<string, number>();
  const assistantTimes = new Map<string, number[]>();
  const calls = new Map<string, { name: string; input: unknown; createdAt: number; status?: string; turnId?: string; compactionEpoch: number }>();
  const outputs = new Map<string, { output: unknown; createdAt: number; indexed?: IndexedToolOutput }>();
  const compactionEpochs = new Map<string, number>();
  let turnId: string | undefined;
  let sequence = 0;
  for await (const line of rolloutLines(rollout)) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    model.accept(entry);
    usage.accept(entry);
    const payload = entry?.payload;
    if (entry?.type === 'turn_context' || (entry?.type === 'event_msg' && payload?.type === 'task_started')) {
      turnId = stringValue(payload?.turn_id) ?? turnId;
    }
    // Compaction can abandon a transcript call without persisting its output.
    // Track the boundary by turn, not by tool name, wall clock or elapsed time.
    if (entry?.type === 'compacted' && turnId) compactionEpochs.set(turnId, (compactionEpochs.get(turnId) ?? 0) + 1);
    if (entry?.type !== 'response_item') continue;
    const createdAt = codexTimestampMilliseconds(entry?.timestamp);
    for (const value of [entry?.payload?.id, entry?.payload?.call_id]) {
      const itemId = stringValue(value);
      if (itemId && createdAt !== undefined && !itemTimes.has(itemId)) itemTimes.set(itemId, createdAt);
    }
    if (entry?.payload?.type === 'message' && entry?.payload?.role === 'assistant' && createdAt !== undefined) {
      const text = arrayValue(entry?.payload?.content).map((part: any) => stringValue(part?.text)).filter(Boolean).join('\n');
      if (text) {
        const key = assistantTimelineKey(text), times = assistantTimes.get(key) ?? [];
        times.push(createdAt); assistantTimes.set(key, times);
      }
    }
    const callId = stringValue(payload?.call_id);
    if (!callId) continue;
    const parsedAt = Date.parse(String(entry?.timestamp ?? ''));
    // Preserve the tool fallback clock independently of native item timestamps.
    const toolCreatedAt = Number.isFinite(parsedAt) ? parsedAt : sequence++;
    if (payload?.type === 'custom_tool_call' || payload?.type === 'function_call') {
      const status = stringValue(payload?.status);
      const input = parseJsonValue(payload.type === 'function_call' ? payload.arguments : payload.input);
      calls.set(callId, {
        name: codexCustomToolName(stringValue(payload?.name) ?? 'customTool', input),
        input,
        createdAt: toolCreatedAt,
        compactionEpoch: turnId ? compactionEpochs.get(turnId) ?? 0 : 0,
        ...(turnId ? { turnId } : {}),
        ...(status ? { status } : {}),
      });
    }
    if (payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output') outputs.set(callId, {
      output: payload?.output, createdAt: toolCreatedAt, ...(payload?.agentopsdeckIndexedOutput ? { indexed: payload.agentopsdeckIndexedOutput } : {}),
    });
  }
  return { itemTimes, assistantTimes, calls, outputs, compactionEpochs, model: model.result(), usage: usage.result() };
}

function historicalRolloutToolMessages(sessionKey: string, { calls, outputs, compactionEpochs }: Awaited<ReturnType<typeof historicalRolloutFacts>>,
  rolloutPath: string | undefined, turns: unknown): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const terminalCompactedTurns = new Set(arrayValue(turns).filter(turn => turn.status === 'failed'
    || turn.status === 'completed'
      && arrayValue(turn.items).some(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()))
    .map(turn => turn.id));
  for (const [callId, call] of calls) {
    const callText = `[tool ${call.name}]\nTool input:\n\`\`\`json\n${prettyJson(call.input)}\n\`\`\``;
    const output = outputs.get(callId);
    // A rollout-only call superseded by compaction is missing transcript
    // evidence, not evidence of a still-running native tool. Preserve the call
    // and explicitly UNKNOWN result; never fabricate an output or success.
    // Native tool rows override these fallbacks in historicalProjection, and
    // terminal/child/dispatch/Goal/ownership/CAS checks remain independent.
    const abandoned = !output && !!call.turnId && terminalCompactedTurns.has(call.turnId)
      && (compactionEpochs.get(call.turnId) ?? 0) > call.compactionEpoch;
    messages.push(toolMessage({ sessionKey, turnId: call.turnId, itemId: callId, phase: 'call', text: callText, toolName: call.name,
      createdAt: call.createdAt, status: output ? 'sent' : abandoned ? 'failed' : 'sending',
      ...(abandoned ? { failureReason: 'Native history compacted before a tool completion output was recorded. Result unavailable; side effects are unknown.' } : {}) }));
    if (!output) continue;
    const prefix = `[tool ${call.name}]\nstatus: ${call.status ?? 'completed'}\noutput:\n`;
    const resultText = prefix + (output.indexed ? output.indexed.preview : rolloutToolOutputText(output.output));
    const message = toolMessage({ sessionKey, turnId: call.turnId, itemId: callId, phase: 'result', text: resultText, toolName: call.name, createdAt: output.createdAt, status: 'sent' });
    if (output.indexed) {
      if (!rolloutPath) throw new Error('Indexed tool source unavailable');
      bindToolRecord(message, rolloutPath, output.indexed, prefix);
    }
    messages.push(message);
  }
  return messages;
}

function parseJsonValue(value: unknown) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function findOpaqueSecrets(text: string) {
  // JWTs contain dots; ordinary Base64/Base64URL blobs do not. Requiring a
  // substantial length avoids turning normal identifiers and prose into files.
  // Explicit [[AOD_SECRET:...]] envelopes are also materialized to 0600 files.
  const matches = text.match(new RegExp(`\\[\\[AOD_SECRET:[^\\]\\r\\n]{8,}\\]\\]|[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/_-]{${OPAQUE_SECRET_MIN_LENGTH},}={0,2}`, 'g')) ?? [];
  return [...new Set(matches)].sort((left, right) => right.length - left.length);
}

/**
 * Codex exposes harness activity as one outer `exec` custom tool whose input is
 * JavaScript. Surface the actual tools used by that script without evaluating
 * it. Multiple distinct calls remain one timeline entry because Codex provides
 * only one call id and one combined result for the outer invocation.
 */
export function codexCustomToolName(outerName: string, input: unknown) {
  if (outerName !== 'exec') return outerName;
  const source = typeof input === 'string'
    ? input
    : input && typeof input === 'object'
      ? stringValue((input as Record<string, unknown>).code ?? (input as Record<string, unknown>).source ?? (input as Record<string, unknown>).cmd)
      : undefined;
  if (!source) return outerName;
  const names: string[] = [];
  const matcher = /\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(matcher)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.join(' + ') : outerName;
}

const unfinishedAssistantStreamReason = 'Stream ended without a completed native item; partial text preserved, not a completed reply.';

/** Preserve display evidence without confusing a stream draft with execution.
 * Only a full native terminal read may retire a root text-only draft, and only
 * when that same turn contains a durable assistant reply. Completed/phased/media
 * items remain strict completeness requirements. This never proves tool cleanup,
 * native ownership, goals or admission: those checks remain with the caller.
 */
function preserveUnfinishedAssistantStreams(turns: any[], live: ChatMessage[], snapshot: ChatMessage[]): ChatMessage[] {
  const terminal = new Map(turns.filter(turn => ['completed', 'failed', 'interrupted'].includes(turn.status)).map(turn => [turn.id, turn.status]));
  const ids = new Set(snapshot.map(message => message.id));
  const retained = live.filter(message => {
    const turnStatus = message.turnId ? terminal.get(message.turnId) : undefined;
    if (message.role !== 'assistant' || !turnStatus || ids.has(message.id)
      || message.phase || message.media?.length || message.parentToolUseId || !message.text.trim()) return false;
    if (message.status && !(message.status === 'failed' && message.failureReason === unfinishedAssistantStreamReason)) return false;
    if (snapshotCoversAssistantDelta(message, snapshot, live)) return false;
    if (turnStatus === 'completed') {
      return snapshot.some(candidate => candidate.sessionKey === message.sessionKey && candidate.turnId === message.turnId
        && candidate.role === 'assistant' && candidate.status === 'sent' && !candidate.parentToolUseId && candidate.text.trim());
    }
    return true;
  }).map(message => ({ ...message, status: 'failed' as const, failureReason: unfinishedAssistantStreamReason }));
  return retained.length ? [...snapshot, ...retained] : snapshot;
}

function snapshotCoversAssistantDelta(message: ChatMessage, snapshot: ChatMessage[], live?: ChatMessage[]) {
  if (message.role !== 'assistant' || !message.turnId || message.status || message.phase || message.media?.length) return false;
  const text = message.text.replace(/\s/g, '');
  const candidates = snapshot.filter((candidate) => candidate.sessionKey === message.sessionKey && candidate.turnId === message.turnId
    && candidate.role === 'assistant' && candidate.status === 'sent');
  if (candidates.some(candidate => candidate.text.replace(/\s/g, '') === text)) return true;
  // A resumed/replayed stream may expose only the tail under an opaque ID,
  // followed by the complete item under its canonical ID. Cover only a unique
  // exact suffix (not an arbitrary substring or whitespace-rewritten tail).
  // Completed, phased and media-bearing messages are independent evidence.
  const tail = message.text.trim();
  if (!tail) return false;
  const covering = candidates.filter(candidate => candidate.text.trim().endsWith(tail));
  if (covering.length !== 1) return false;
  const candidate = covering[0]!;
  return !live || !live.some(other => other.id !== message.id && other.sessionKey === message.sessionKey
    && other.turnId === message.turnId && other.role === 'assistant' && !other.status && !other.phase && !other.media?.length
    && other.text.trim() && candidate.text.trim().endsWith(other.text.trim()));
}

/** Shared display/finalization completeness; cleanup and CAS stay caller-owned. */
function finalHistoryGaps(turnId: string, finalTurnIds: Set<string>, live: ChatMessage[], snapshot: ChatMessage[]) {
  const ids = new Set(snapshot.map(message => message.id));
  const placeholders = completedSearchPlaceholders(turnId, live, snapshot);
  return {
    placeholders,
    assistants: missingFinalAssistants(turnId, live, snapshot).length,
    tools: live.filter(message => message.turnId === turnId && message.role === 'tool' && message.status === 'sending'
      && !ids.has(message.id) && !placeholders.has(message.id)).length,
    unfinished: snapshot.filter(message => finalTurnIds.has(message.turnId!)
      && message.role === 'tool' && message.status === 'sending').length,
  };
}

function missingFinalAssistants(turnId: string, live: ChatMessage[], snapshot: ChatMessage[]) {
  // Content-free stream aliases from older projections have no history item.
  // A media-only message is substantive and must still be accounted for.
  const observed = live.filter(message => message.turnId === turnId && message.role === 'assistant'
    && (message.text.trim() || message.media?.length));
  const ids = new Set(snapshot.map(message => message.id));
  const observedIds = new Set(observed.map(message => message.id));
  const available = snapshot.filter(message => message.turnId === turnId && message.role === 'assistant'
    && message.status === 'sent' && !observedIds.has(message.id));
  return observed.filter(message => {
    if (ids.has(message.id) || snapshotCoversAssistantDelta(message, snapshot, observed)) return false;
    if (message.status !== 'sent') return true;
    const index = available.findIndex(candidate => candidate.sessionKey === message.sessionKey && candidate.phase === message.phase
      && candidate.text === message.text && JSON.stringify(candidate.media ?? []) === JSON.stringify(message.media ?? []));
    if (index < 0) return true;
    available.splice(index, 1);
    return false;
  });
}

function completedSearchPlaceholders(turnId: string, live: ChatMessage[], snapshot: ChatMessage[]) {
  // webSearch starts have no query/action yet and their encrypted IDs can
  // differ from completion/history IDs. They are UI placeholders, not another
  // execution. Only a full terminal snapshot with enough finished searches
  // can supersede them; never apply this rule to populated calls or commands.
  const emptyStart = toolProjection({ type: 'webSearch', query: '', action: { type: 'other' }, results: null }).callText;
  const placeholders = live.filter((message) => message.turnId === turnId && message.role === 'tool'
    && message.toolName === 'webSearch' && message.toolPhase === 'call' && message.status === 'sending' && message.text === emptyStart);
  const completedIds = new Set(snapshot.filter((message) => message.turnId === turnId && message.role === 'tool'
    && message.toolName === 'webSearch' && message.toolPhase === 'result' && message.status === 'sent').map((message) => message.toolCallId));
  const calls = snapshot.filter((message) => message.turnId === turnId && message.role === 'tool'
    && message.toolName === 'webSearch' && message.toolPhase === 'call' && message.status === 'sent'
    && message.text !== emptyStart && completedIds.has(message.toolCallId));
  if (new Set(calls.map((message) => message.toolCallId)).size < placeholders.length) return new Set<string>();
  const ids = new Set(snapshot.map((message) => message.id));
  return new Set(placeholders.filter((message) => !ids.has(message.id)).map((message) => message.id));
}

async function projectAssistant(text: string, projector?: CodexAssistantProjector) {
  if (!projector) return { text, media: [] };
  try { return await projector(text); } catch (error) {
    // Optional enrichment may still fall back to original text. A pending
    // original owner is different: do not silently certify incomplete history.
    if (error instanceof HistoricalProjectionPendingError) throw error;
    return { text, media: [] };
  }
}

function historicalUserImages(content: unknown): NonNullable<ChatMessage['media']> {
  return arrayValue(content).flatMap((input: any) => {
    if (input?.type !== 'localImage') return [];
    const imagePath = stringValue(input?.path);
    if (!imagePath) return [];
    const resolvedPath = path.resolve(imagePath);
    const storedName = path.basename(resolvedPath);
    if (path.dirname(resolvedPath) !== inboundMediaReadDirectory(storedName)) return [];
    const name = storedName.match(/^agentopsdeck-\d+-[A-Za-z0-9_-]{8}-(.+)$/)?.[1] ?? storedName;
    return [{
      type: 'image' as const,
      url: `/api/media/inbound/${encodeURIComponent(storedName)}`,
      name,
      mimeType: mimeTypeFor(storedName),
    }];
  });
}

function codexThreadTitle(thread: any) {
  return stringValue(thread?.name) ?? stringValue(thread?.preview)?.split(/\r?\n/, 1)[0]?.slice(0, 120) ?? `Codex ${String(thread?.id ?? '').slice(0, 8)}`;
}

function secondsToMilliseconds(value: unknown) {
  const seconds = numberValue(value);
  return seconds === undefined ? undefined : seconds * 1_000;
}

function codexTimestampMilliseconds(value: unknown) {
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
import type { SessionFileIndex } from '../messages/session-file-index.js';
import { projectionFileEvidence } from '../messages/session-file-evidence.js';

const FORBIDDEN_CODEX_HOME_ENV = /^(?:AOD_.*|LD_.*|DYLD_.*|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|BASH_ENV|ENV|SHELLOPTS|PS4|IFS|CDPATH|GLOBIGNORE|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_.*|TMPDIR|TMP|TEMP|PATH|CODEX_HOME|HERMES_HOME|OPENCLAW_.*)$/i;

function readPrivateCodexHomeEnv(homeDirectory: string): Record<string, string> | undefined {
  const file = path.join(homeDirectory, '.env');
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Native execution private configuration could not be verified');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536
    || (process.platform !== 'win32' && (process.getuid?.() === undefined || info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error('Native execution private configuration could not be verified');
  }
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch { throw new Error('Native execution private configuration could not be verified'); }
  const result: Record<string, string> = Object.create(null);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]!;
    if (FORBIDDEN_CODEX_HOME_ENV.test(key)) throw new Error('Native execution private configuration could not be verified');
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length > 0 && !/[\x00\r\n]/.test(value)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
