import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeModelId, parseAntigravityQuotaWait, type AgentReadiness, type AntigravityQuotaWaitState, type CodexSubagentObservation } from '@agentopsdeck/shared';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { ConnectorAgentLifecycle } from '../connector/agent-runtimes.js';
import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import type { PrivateWorkerDeletion } from '../connector/private-worker-preflight.js';
import type { SdkInputAttachment } from '../connector/sdk-attachment-input.js';
import type { SdkDispatchAdapter, SdkSettlement } from '../connector/sdk-dispatch.js';
import { SdkExecutionDriver, type SdkDriverOptions, type SdkOwnedTurn } from '../connector/sdk-execution-driver.js';
import type { SdkExecution, SdkExecutionRef, SdkCompactRef, SdkCompactResult, SdkCompactSettlement, SdkTerminalOutcome } from '../connector/sdk-execution-journal.js';
import type { SdkCompactExecution } from '../connector/sdk-compact-dispatch.js';
import { validateCompactExecution, type SdkOwnedCompactWorker } from '../connector/sdk-compact-worker.js';
import { SdkOwnedRuntime, type SdkPreflight } from '../connector/sdk-owned-runtime.js';
import { sdkModelAllowed } from '../connector/sdk-models.js';
import type { SdkTurnContext } from '../connector/sdk-turn-context.js';
import { AsyncSdkConnectorRuntime } from '../connector/async-sdk-connector-runtime.js';
import { AsyncSdkExecutionDriver, type AsyncSdkDriverOptions } from '../connector/async-sdk-execution-driver.js';
import { AsyncSdkOwnedRuntime, type AsyncSdkOwnedOptions } from '../connector/async-sdk-owned-runtime.js';
import type { AsyncSdkProjection } from '../connector/async-sdk-projection.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import { COPILOT_MESSAGE_TEXT_LIMIT, type CopilotProjectedMessage } from '../copilot/message-projection.js';
import { AntigravitySessionProjection } from '../copilot/session-projection.js';
import type { CopilotTextStream } from '../copilot/stream-projection.js';
import type { CopilotToolDetail } from '../copilot/tool-details.js';
import type { SdkMetricSample } from '../connector/sdk-metrics.js';
import { AntigravityAcpError, type AntigravityPromptBlock, type AntigravitySessionUpdate } from './acp-client.js';
import type { AntigravityConfig } from './config.js';
import { verifyAntigravityEnvironment } from './environment.js';
import { AntigravityProcessWorker } from './execution-worker.js';
import { AntigravityQuotaRetryManager } from './quota-retry.js';
import {
  classifyAntigravityTool,
  extractAntigravitySourceFiles,
  formatAntigravityToolCallDetail,
  formatAntigravityToolResultDetail,
  type AntigravityToolMeta,
} from './tool-formatting.js';

const failure = () => new Error('Antigravity execution could not be confirmed');
const unavailable = () => new Error('Antigravity runtime unavailable; inspect local configuration and ownership');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const ANTIGRAVITY_SUBAGENT_ACTIONS: Record<string, CodexSubagentObservation['action']> = {
  'Run invoke_subagent': 'spawnAgent',
  'Run define_subagent': 'spawnAgent',
  'Run send_message': 'sendInput',
  'Run manage_subagents': 'closeAgent',
};

export function antigravitySubagentObservation(
  title: string | undefined,
  toolCallId: string,
  status: 'running' | 'completed' | 'errored',
  observedAt: number,
  outputText?: string,
): CodexSubagentObservation | undefined {
  if (!title) return undefined;
  const action = ANTIGRAVITY_SUBAGENT_ACTIONS[title];
  if (!action) return undefined;
  const trimmed = outputText?.trim();
  return {
    action,
    source: 'live',
    observedAt,
    agents: [{
      id: toolCallId,
      path: title,
      status,
      ...(trimmed ? { latestText: trimmed.slice(0, 600) } : {}),
    }],
  };
}

const sanitizeId = (value: string) => {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 512);
  if (!normalized) throw failure();
  return normalized;
};
const sanitizeToolName = (value: string) => {
  const normalized = value.replace(/[^A-Za-z0-9_.:/-]/g, '_').slice(0, 512);
  if (!normalized) throw failure();
  return normalized;
};

export type AntigravityProjection = {
  project: (row: CopilotProjectedMessage, detail?: CopilotToolDetail) => void;
  stream: (snapshot: CopilotTextStream) => void;
  metrics?: (sample: SdkMetricSample) => void;
};

export type AntigravityWorkerFactory = (options: {
  config: AntigravityConfig;
  assertOwnership: () => void;
  update: (update: AntigravitySessionUpdate) => void;
}) => Pick<AntigravityProcessWorker, 'initialize' | 'newSession' | 'resumeOwnedSession' | 'setModel' | 'prompt' | 'cancel' | 'stopAndDrain'>;

const defaultWorkerFactory: AntigravityWorkerFactory = options => new AntigravityProcessWorker(options);

function sessionBindingsDirectory(config: AntigravityConfig): string {
  verifyAntigravityEnvironment(config);
  const directory = join(config.homeDirectory, 'data', 'session-bindings');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o077) !== 0) throw failure();
  return directory;
}

function sessionBindingPath(config: AntigravityConfig, nativeSessionId: string): string {
  if (!uuid.test(nativeSessionId)) throw failure();
  return join(sessionBindingsDirectory(config), `${nativeSessionId}.json`);
}

export function writeAntigravitySessionBinding(config: AntigravityConfig, nativeSessionId: string, agySessionId: string): void {
  if (!uuid.test(nativeSessionId) || !identity(agySessionId)) throw failure();
  const target = sessionBindingPath(config, nativeSessionId);
  if (existsSync(target)) {
    const existing = readAntigravitySessionBinding(config, nativeSessionId);
    if (existing !== agySessionId) throw failure();
    return;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ nativeSessionId, agySessionId }), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}

export function readAntigravitySessionBinding(config: AntigravityConfig, nativeSessionId: string): string | undefined {
  const target = sessionBindingPath(config, nativeSessionId);
  if (!existsSync(target)) return undefined;
  const stats = lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o077) !== 0 || stats.size > 4096) throw failure();
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as { nativeSessionId?: unknown; agySessionId?: unknown };
  if (!parsed || typeof parsed !== 'object' || parsed.nativeSessionId !== nativeSessionId || !identity(parsed.agySessionId)) {
    throw failure();
  }
  return parsed.agySessionId;
}

export function removeAntigravitySessionBinding(config: AntigravityConfig, nativeSessionId: string): void {
  const target = sessionBindingPath(config, nativeSessionId);
  if (existsSync(target)) {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw failure();
    rmSync(target, { force: true });
  }
}

export class AntigravityWorkerPreflight implements SdkPreflight {
  private quiescent = false;
  readonly finished: Promise<void>;
  readonly ready: Promise<boolean>;
  private readonly worker: ReturnType<AntigravityWorkerFactory> | undefined;

  constructor(config: AntigravityConfig, createWorker: AntigravityWorkerFactory = defaultWorkerFactory) {
    let worker: ReturnType<AntigravityWorkerFactory> | undefined;
    try {
      worker = createWorker({ config, assertOwnership: () => {}, update: () => {} });
    } catch {
      this.quiescent = true;
      this.finished = Promise.resolve();
      this.ready = Promise.resolve(false);
      return;
    }
    this.worker = worker;
    const run = (async () => {
      let initialized = false;
      try {
        await worker.initialize();
        initialized = true;
      } catch {
        initialized = false;
      }
      const drained = await worker.stopAndDrain();
      this.quiescent = drained.cleaned && drained.quiescent;
      return initialized && this.quiescent;
    })();
    this.ready = run.catch(() => false);
    this.finished = this.ready.then(() => undefined);
  }

  inspectQuiescence(): boolean {
    return this.quiescent;
  }

  close(): void {
    if (this.worker) {
      void this.worker.stopAndDrain().then(drained => {
        this.quiescent = drained.cleaned;
      });
    }
  }
}

export class AntigravityWorkerDeletion implements SdkPreflight {
  private quiescent = false;
  readonly finished: Promise<void>;
  readonly ready: Promise<boolean>;

  constructor(config: AntigravityConfig, request: PrivateWorkerDeletion) {
    const run = Promise.resolve().then(() => {
      if (request.kind !== 'delete-native' || !identity(request.id) || !uuid.test(request.nativeSessionId)) throw failure();
      removeAntigravitySessionBinding(config, request.nativeSessionId);
      this.quiescent = true;
      return true;
    }).catch(() => {
      this.quiescent = false;
      return false;
    });
    this.ready = run;
    this.finished = run.then(() => undefined);
  }

  inspectQuiescence(): boolean {
    return this.quiescent;
  }

  close(): void {}
}

export class AntigravityCompactWorker implements SdkOwnedCompactWorker {
  private readonly worker: ReturnType<AntigravityWorkerFactory>;
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly finished: Promise<void>;
  readonly result: Promise<SdkCompactRef & SdkCompactResult>;
  private cleaned = false;
  private drained = false;
  private failed = false;
  private stopRequested = false;
  private promptAdmitted = false;
  private agySessionId: string | undefined;
  private proof: (SdkCompactRef & SdkCompactResult) | undefined;
  private resolveFinished!: () => void;

  constructor(private readonly options: {
    config: AntigravityConfig;
    execution: SdkCompactExecution;
    assertOwnership: () => void;
    createWorker?: AntigravityWorkerFactory;
    timeoutMs?: number;
  }) {
    validateCompactExecution(options.execution, 'antigravity');
    const timeoutMs = options.timeoutMs ?? options.config.compactTimeoutMs ?? 600_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw failure();
    const createWorker = options.createWorker ?? defaultWorkerFactory;
    this.worker = createWorker({
      config: options.config,
      assertOwnership: options.assertOwnership,
      update: event => this.handleUpdate(event),
    });
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
    this.timer = setTimeout(() => this.close(), timeoutMs);
    this.result = this.run();
    void this.result.catch(() => {});
  }

  private handleUpdate(event: AntigravitySessionUpdate): void {
    if (this.failed || !this.agySessionId || event.sessionId !== this.agySessionId) {
      this.failed = true;
    }
  }

  private async run(): Promise<SdkCompactRef & SdkCompactResult> {
    const { config, execution, assertOwnership } = this.options;
    let outcome: SdkTerminalOutcome | undefined;
    try {
      assertOwnership();
      const bound = readAntigravitySessionBinding(config, execution.nativeSessionId);
      if (!bound) throw failure();
      await this.worker.initialize();
      if (this.failed) throw failure();
      assertOwnership();
      await this.worker.resumeOwnedSession(bound, resumedId => {
        if (resumedId !== bound) throw failure();
      });
      this.agySessionId = bound;
      if (this.failed) throw failure();
      const targetModel = execution.model && execution.model !== 'default'
        ? execution.model
        : config.model && config.model !== 'default'
          ? config.model
          : undefined;
      if (targetModel) {
        await this.worker.setModel(targetModel);
      }
      if (this.failed) throw failure();
      if (this.stopRequested) {
        outcome = 'interrupted';
      } else {
        const promptResult = await this.worker.prompt('/compact', async sessionId => {
          assertOwnership();
          if (this.failed || !this.agySessionId || sessionId !== this.agySessionId) throw failure();
          this.promptAdmitted = true;
        });
        if (this.failed) throw failure();
        if (promptResult.stopReason === 'end_turn') {
          outcome = this.stopRequested ? 'interrupted' : 'completed';
        } else if (promptResult.stopReason === 'cancelled' && this.stopRequested) {
          outcome = 'interrupted';
        } else {
          throw failure();
        }
      }
    } catch (error) {
      if (error instanceof AntigravityAcpError && this.promptAdmitted && !this.failed) {
        outcome = 'failed';
      } else {
        this.failed = true;
      }
    } finally {
      clearTimeout(this.timer);
      const drained = await this.worker.stopAndDrain();
      this.cleaned = drained.cleaned;
      this.drained = true;
      this.resolveFinished();
    }
    if (this.failed || !outcome || !this.cleaned) throw failure();
    const suffix = outcome === 'completed' ? '' : `_${outcome}`;
    const proof: SdkCompactRef & SdkCompactResult = {
      id: execution.id,
      key: execution.key,
      epoch: execution.epoch,
      nativeSessionId: execution.nativeSessionId,
      nativeRequestId: execution.id,
      completionEventId: sanitizeId(`compact_${execution.id}${suffix}`),
      outcome,
    };
    this.proof = proof;
    return structuredClone(proof);
  }

  async interrupt(): Promise<void> {
    if (this.failed || this.drained || this.proof || this.stopRequested) throw failure();
    this.stopRequested = true;
    if (this.promptAdmitted) {
      this.worker.cancel();
    }
  }

  async inspectQuiescence(): Promise<boolean> {
    return this.drained && this.cleaned;
  }

  async inspectSettlement(): Promise<SdkCompactSettlement> {
    const proof = await this.result;
    const bound = readAntigravitySessionBinding(this.options.config, this.options.execution.nativeSessionId);
    const validBinding = Boolean(bound && this.agySessionId && bound === this.agySessionId);
    return {
      id: proof.id,
      key: proof.key,
      epoch: proof.epoch,
      nativeSessionId: proof.nativeSessionId,
      completionEventId: proof.completionEventId,
      historyPersisted: validBinding && !this.failed,
      nativeQuiescent: await this.inspectQuiescence(),
    };
  }

  close(): void {
    clearTimeout(this.timer);
    if (this.drained) return;
    this.failed = true;
    void this.worker.stopAndDrain().then(drained => {
      this.cleaned = drained.cleaned;
      this.drained = true;
      this.resolveFinished();
    });
  }
}

export class AntigravitySdkTurn implements SdkOwnedTurn {
  private readonly worker: ReturnType<AntigravityWorkerFactory>;
  private readonly admitResolve!: (value: { nativeRequestId: string }) => void;
  private readonly admitReject!: (error: Error) => void;
  readonly admitted: Promise<{ nativeRequestId: string }>;
  readonly finished: Promise<void>;
  private cleaned = false;
  private quiescent = false;
  private failed = false;
  private stopRequested = false;
  private outcome: SdkTerminalOutcome | undefined;
  private agySessionId: string | undefined;
  private sequence = 0;
  private assistantText = '';
  private assistantTruncated = false;
  private promptAdmitted = false;
  private streamDirty = false;
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly seenTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly toolTitles = new Map<string, string>();
  private readonly toolMetas = new Map<string, AntigravityToolMeta>();
  private detectedQuotaWait: AntigravityQuotaWaitState | undefined;

  constructor(private readonly options: {
    config: AntigravityConfig;
    execution: SdkExecution;
    text: string;
    context?: SdkTurnContext;
    attachments?: SdkInputAttachment[];
    projection: AntigravityProjection;
    assertOwnership: () => void;
    createWorker?: AntigravityWorkerFactory;
    onQuotaWait?: (wait: AntigravityQuotaWaitState, resumePrompt: string) => void;
    now?: () => number;
  }) {
    const { execution, text } = options;
    if (execution.kind === 'compact' || !execution.key.startsWith('antigravity:') || execution.key.length <= 12
      || !uuid.test(execution.nativeSessionId) || !['create', 'resume'].includes(execution.nativeMode)
      || (!text.trim() && !options.attachments?.length) || text.length > COPILOT_MESSAGE_TEXT_LIMIT) throw failure();
    let resolveAdmitted!: (value: { nativeRequestId: string }) => void;
    let rejectAdmitted!: (error: Error) => void;
    this.admitted = new Promise((resolve, reject) => {
      resolveAdmitted = resolve;
      rejectAdmitted = reject;
    });
    this.admitResolve = resolveAdmitted;
    this.admitReject = rejectAdmitted;
    const createWorker = options.createWorker ?? defaultWorkerFactory;
    this.worker = createWorker({
      config: options.config,
      assertOwnership: options.assertOwnership,
      update: update => this.handleUpdate(update),
    });
    this.finished = this.run();
  }

  private now(): number {
    const value = (this.options.now ?? Date.now)();
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }

  private flushStream(): void {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    if (!this.streamDirty || this.failed) return;
    this.streamDirty = false;
    this.options.projection.stream({
      messageId: sanitizeId(`assistant_${this.options.execution.id}`),
      text: this.assistantText,
      truncated: this.assistantTruncated,
    });
  }

  private handleUpdate(event: AntigravitySessionUpdate): void {
    if (this.failed || !this.agySessionId || event.sessionId !== this.agySessionId) {
      this.failed = true;
      return;
    }
    try {
      const { update } = event;
      const { execution, projection } = this.options;
      if (update.sessionUpdate === 'agent_message_chunk') {
        const chunk = update.content.text;
        const slice = chunk.slice(0, COPILOT_MESSAGE_TEXT_LIMIT - this.assistantText.length);
        if (slice.length < chunk.length) this.assistantTruncated = true;
        this.assistantText += slice;
        this.streamDirty = true;
        if (!this.streamTimer) {
          this.streamTimer = setTimeout(() => {
            this.streamTimer = undefined;
            try { this.flushStream(); } catch { this.failed = true; }
          }, 50);
        }
        return;
      }
      this.flushStream();
      if (update.sessionUpdate === 'usage_update') {
        const metricSequence = ++this.sequence;
        try {
          projection.metrics?.({
            sequence: metricSequence,
            eventId: sanitizeId(`evt_${execution.id}_usage_${metricSequence}`),
            context: { used: update.used, limit: update.size, basis: 'native-context' },
          });
        } catch { /* Advisory usage telemetry must never abort an active turn. */ }
        return;
      }
      const toolCallId = sanitizeId(update.toolCallId);
      if (update.title) this.toolTitles.set(toolCallId, update.title);
      const toolTitle = update.title ?? this.toolTitles.get(toolCallId);
      const eventIndex = ++this.sequence;
      if (!this.seenTools.has(toolCallId)) {
        this.seenTools.add(toolCallId);
        const meta = classifyAntigravityTool(update, toolTitle);
        this.toolMetas.set(toolCallId, meta);
        const toolName = sanitizeToolName(meta.toolName);
        const detail = formatAntigravityToolCallDetail(meta, update, toolTitle);
        const subagent = antigravitySubagentObservation(toolTitle, toolCallId, 'running', this.now());
        projection.project({
          nativeEventId: sanitizeId(`evt_${execution.id}_call_${eventIndex}`),
          role: 'tool',
          toolCallId,
          toolName,
          toolPhase: 'call',
          text: toolName,
          truncated: false,
          createdAt: this.now(),
          ...(subagent ? { codexSubagent: subagent } : {}),
        }, detail);
      }
      if ((update.status === 'completed' || update.status === 'failed') && !this.completedTools.has(toolCallId)) {
        this.completedTools.add(toolCallId);
        const meta = this.toolMetas.get(toolCallId) ?? classifyAntigravityTool(update, toolTitle);
        const resultIndex = ++this.sequence;
        const resultDetail = formatAntigravityToolResultDetail(meta, update);
        const sourceFiles = extractAntigravitySourceFiles(meta, update, this.options.config.workspace);
        const subagent = antigravitySubagentObservation(
          toolTitle,
          toolCallId,
          update.status === 'failed' ? 'errored' : 'completed',
          this.now(),
          update.outputText,
        );
        projection.project({
          nativeEventId: sanitizeId(`evt_${execution.id}_result_${resultIndex}`),
          role: 'tool',
          toolCallId,
          toolPhase: 'result',
          text: '',
          truncated: false,
          toolError: update.status === 'failed',
          createdAt: this.now(),
          ...(sourceFiles.length ? { sourceFiles } : {}),
          ...(subagent ? { codexSubagent: subagent } : {}),
        }, resultDetail);
      }
    } catch {
      this.failed = true;
    }
  }

  private buildPromptBlocks(): AntigravityPromptBlock[] {
    const blocks: AntigravityPromptBlock[] = [];
    const contextText = typeof this.options.context === 'string'
      ? this.options.context.trim()
      : this.options.context?.text?.trim() ?? '';
    const textParts: string[] = [];
    if (contextText) textParts.push(contextText);
    if (this.options.text.trim()) textParts.push(this.options.text);
    for (const attachment of this.options.attachments ?? []) {
      if (attachment.mimeType.startsWith('image/')) {
        blocks.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data });
      } else {
        const decoded = Buffer.from(attachment.data, 'base64').toString('utf8');
        textParts.push(`[Attachment: ${attachment.name} (${attachment.mimeType})]\n${decoded}`);
      }
    }
    const combinedText = textParts.join('\n\n').trim();
    if (combinedText) blocks.unshift({ type: 'text', text: combinedText });
    if (blocks.length === 0) blocks.push({ type: 'text', text: 'Please inspect the attached content.' });
    return blocks;
  }

  private async run(): Promise<void> {
    const { config, execution, text, projection, assertOwnership } = this.options;
    const userMessageId = sanitizeId(execution.id);
    const assistantMessageId = sanitizeId(`assistant_${execution.id}`);
    try {
      assertOwnership();
      await this.worker.initialize();
      assertOwnership();
      if (execution.nativeMode === 'create') {
        this.agySessionId = await this.worker.newSession();
      } else {
        const bound = readAntigravitySessionBinding(config, execution.nativeSessionId);
        if (!bound) throw failure();
        await this.worker.resumeOwnedSession(bound, resumedId => {
          if (resumedId !== bound) throw failure();
        });
        this.agySessionId = bound;
      }
      const targetModel = execution.model && execution.model !== 'default'
        ? execution.model
        : config.model && config.model !== 'default'
          ? config.model
          : undefined;
      if (targetModel) {
        await this.worker.setModel(targetModel);
      }
      const blocks = this.buildPromptBlocks();
      const result = await this.worker.prompt(blocks, async sessionId => {
        assertOwnership();
        if (!this.agySessionId || sessionId !== this.agySessionId) throw failure();
        writeAntigravitySessionBinding(config, execution.nativeSessionId, sessionId);
        projection.project({
          nativeEventId: sanitizeId(`evt_${execution.id}_user`),
          role: 'user',
          messageId: userMessageId,
          text,
          truncated: false,
          createdAt: this.now(),
        });
        this.admitResolve({ nativeRequestId: userMessageId });
        this.promptAdmitted = true;
      });
      if (this.failed) throw failure();
      if (!['end_turn', 'cancelled', 'refusal', 'max_tokens', 'max_turn_requests'].includes(result.stopReason)) throw failure();
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
      this.streamDirty = false;
      if (result.usage) {
        const metricSequence = ++this.sequence;
        const metricModel = targetModel && nativeModelId(targetModel) ? targetModel : undefined;
        projection.metrics?.({
          sequence: metricSequence,
          eventId: sanitizeId(`evt_${execution.id}_turn_usage`),
          ...(metricModel ? { model: metricModel } : {}),
          usage: {
            scope: 'last-turn',
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(result.usage.cachedReadTokens !== undefined ? { cacheReadTokens: result.usage.cachedReadTokens } : {}),
            ...(result.usage.cachedWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cachedWriteTokens } : {}),
          },
        });
      }
      const fallbackText = this.assistantText.length === 0 && result.stopReason === 'cancelled' && !this.stopRequested
        ? 'Antigravity requested a tool permission that is disabled in this sandboxed connector.'
        : this.assistantText;
      if (fallbackText.length > 0 || result.stopReason === 'end_turn') {
        projection.project({
          nativeEventId: sanitizeId(`evt_${execution.id}_assistant`),
          role: 'assistant',
          messageId: assistantMessageId,
          text: fallbackText,
          truncated: this.assistantTruncated,
          createdAt: this.now(),
        });
      }
      if (!this.stopRequested) {
        this.detectedQuotaWait = parseAntigravityQuotaWait(this.assistantText, this.now());
      }
      this.outcome = this.stopRequested ? 'interrupted' : 'completed';
    } catch (error) {
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
      this.streamDirty = false;
      if (error instanceof AntigravityAcpError && this.promptAdmitted && !this.failed) {
        if (this.assistantText.length > 0) {
          try {
            projection.project({
              nativeEventId: sanitizeId(`evt_${execution.id}_assistant`),
              role: 'assistant',
              messageId: assistantMessageId,
              text: this.assistantText,
              truncated: this.assistantTruncated,
              createdAt: this.now(),
            });
          } catch {
            this.failed = true;
            this.admitReject(error);
          }
        }
        if (!this.failed) {
          if (!this.stopRequested) {
            this.detectedQuotaWait = error.quotaWait ?? parseAntigravityQuotaWait(this.assistantText, this.now());
          }
          this.outcome = 'failed';
        }
      } else {
        this.failed = true;
        this.admitReject(error instanceof Error ? error : failure());
      }
    } finally {
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
      const drained = await this.worker.stopAndDrain();
      this.cleaned = drained.cleaned;
      this.quiescent = drained.cleaned && drained.quiescent;
      if (this.detectedQuotaWait && !this.failed && !this.stopRequested) {
        const resumePrompt = this.seenTools.size > 0
          ? 'Continue from where you stopped.'
          : this.options.text;
        try {
          this.options.onQuotaWait?.(this.detectedQuotaWait, resumePrompt);
        } catch {
          /* Quota retry scheduling must never abort turn cleanup. */
        }
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.failed) throw failure();
    this.stopRequested = true;
    this.worker.cancel();
  }

  inspectQuiescence(): Promise<boolean> {
    return Promise.resolve(this.cleaned && (this.quiescent || this.stopRequested));
  }

  inspectCleaned(): Promise<boolean> {
    return Promise.resolve(this.cleaned);
  }

  inspectSettlement(): Promise<{ historyPersisted: boolean; nativeQuiescent: boolean }> {
    try {
      const bound = readAntigravitySessionBinding(this.options.config, this.options.execution.nativeSessionId);
      const validBinding = Boolean(bound && this.agySessionId && bound === this.agySessionId);
      // Once ACP returned a verified terminal result (or clean AntigravityAcpError)
      // and stopAndDrain() confirmed the process group is empty (this.cleaned),
      // forced cleanup of a lingering post-turn descendant must not wedge the session.
      return Promise.resolve({
        historyPersisted: !this.failed && validBinding && this.outcome !== undefined,
        nativeQuiescent: this.cleaned,
      });
    } catch {
      return Promise.resolve({ historyPersisted: false, nativeQuiescent: false });
    }
  }

  terminalOutcome(): SdkTerminalOutcome | undefined {
    return this.failed ? undefined : this.outcome;
  }

  close(): void {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    this.streamDirty = false;
    this.failed = true;
    this.admitReject(failure());
    void this.worker.stopAndDrain().then(drained => {
      this.cleaned = drained.cleaned;
      this.quiescent = false;
    });
  }
}

type ActiveSlot = {
  execution: SdkExecution;
  turn: AntigravitySdkTurn;
  failed: boolean;
};

export class AntigravityDispatchAdapter implements SdkDispatchAdapter {
  private readonly active = new Map<string, ActiveSlot>();
  private available = true;

  constructor(private readonly options: {
    epoch: string;
    start: (execution: SdkExecution, text: string, context?: SdkTurnContext,
      attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => AntigravitySdkTurn;
    terminal: (ref: SdkExecutionRef, outcome: SdkTerminalOutcome) => boolean | Promise<boolean>;
    unknown: (ref: SdkExecutionRef) => void;
    drained?: (ref: SdkExecutionRef) => void;
  }) {
    if (!identity(options.epoch)) throw failure();
  }

  get epoch(): string | undefined {
    return this.available ? this.options.epoch : undefined;
  }

  get ready(): boolean {
    return this.available;
  }

  async send(execution: SdkExecution, text: string, context?: SdkTurnContext,
    attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext): Promise<{ nativeRequestId: string }> {
    if (!this.available || execution.kind === 'compact' || execution.epoch !== this.options.epoch
      || !execution.key.startsWith('antigravity:') || interaction
      || this.active.has(execution.key)) throw failure();
    const turn = this.options.start(execution, text, context, attachments, interaction);
    const slot: ActiveSlot = { execution: { ...execution }, turn, failed: false };
    this.active.set(execution.key, slot);
    void this.consume(slot);
    try {
      const admitted = await turn.admitted;
      if (!this.available || slot.failed || this.active.get(execution.key) !== slot) throw failure();
      slot.execution.nativeRequestId = admitted.nativeRequestId;
      return admitted;
    } catch (error) {
      this.fail(slot);
      throw error;
    }
  }

  private async consume(slot: ActiveSlot): Promise<void> {
    try {
      await slot.turn.finished;
      const outcome = slot.turn.terminalOutcome();
      if (!outcome || !this.available || slot.failed || this.active.get(slot.execution.key) !== slot) {
        throw failure();
      }
      const accepted = await this.options.terminal(slot.execution, outcome);
      if (accepted !== true) throw failure();
    } catch {
      this.fail(slot);
    } finally {
      try {
        this.options.drained?.(slot.execution);
      } catch {
        this.fail(slot);
      }
    }
  }

  async interrupt(execution: SdkExecution): Promise<void> {
    const slot = this.active.get(execution.key);
    if (!this.available || !slot || slot.failed || slot.execution.id !== execution.id
      || slot.execution.epoch !== execution.epoch || !execution.stopRequested) throw failure();
    try {
      await slot.turn.interrupt();
    } catch (error) {
      this.fail(slot);
      throw error;
    }
  }

  async inspectSettlement(execution: SdkExecution): Promise<SdkSettlement> {
    const slot = this.active.get(execution.key);
    if (!this.available || !slot || slot.failed || slot.execution.id !== execution.id
      || slot.execution.epoch !== execution.epoch || slot.execution.nativeSessionId !== execution.nativeSessionId) {
      throw failure();
    }
    const settlement = await slot.turn.inspectSettlement();
    if (settlement.historyPersisted && settlement.nativeQuiescent) {
      this.active.delete(execution.key);
    }
    return {
      id: execution.id,
      key: execution.key,
      epoch: execution.epoch,
      nativeSessionId: execution.nativeSessionId,
      historyPersisted: settlement.historyPersisted,
      nativeQuiescent: settlement.nativeQuiescent,
    };
  }

  releaseRecovered(ref: SdkExecutionRef): void {
    const slot = this.active.get(ref.key);
    if (!slot || slot.execution.id !== ref.id || slot.execution.epoch !== ref.epoch) return;
    slot.failed = true;
    this.active.delete(ref.key);
  }

  close(): void {
    this.available = false;
    for (const slot of [...this.active.values()]) this.fail(slot);
  }

  private fail(slot: ActiveSlot): void {
    if (this.active.get(slot.execution.key) === slot) this.active.delete(slot.execution.key);
    if (slot.failed) return;
    slot.failed = true;
    try { slot.turn.close(); } catch {}
    try { this.options.unknown(slot.execution); } catch {}
  }
}

export class AntigravityExecutionDriver extends SdkExecutionDriver<AntigravitySdkTurn> {
  constructor(options: Pick<SdkDriverOptions<AntigravitySdkTurn>, 'deadlineMs' | 'admissionReady' | 'authorize' | 'changed' | 'startCompact' | 'compactTimeoutMs' | 'turnContext'> & {
    store: Pick<ConnectorUserStore, 'turns' | 'antigravityJournal' | 'antigravityTranscript'>;
    start: (execution: SdkExecution, text: string, projection: AntigravityProjection, context?: SdkTurnContext) => AntigravitySdkTurn;
  }) {
    const { store } = options;
    super({
      ...options,
      journal: store.antigravityJournal,
      turns: store.turns,
      adapter: callbacks => new AntigravityDispatchAdapter(callbacks),
      endStreams: ref => store.antigravityTranscript.endStreams(ref),
      start: (execution, text, changed, context) => options.start(execution, text, {
        project: (row, detail) => { store.antigravityTranscript.append(execution, row, text, detail); changed(); },
        stream: snapshot => { if (store.antigravityTranscript.updateStream(execution, snapshot)) changed(); },
        metrics: sample => { if (store.antigravityJournal.recordMetrics(execution, sample)) changed(); },
      }, context),
    });
  }
}

export class AsyncAntigravityExecutionDriver extends AsyncSdkExecutionDriver<AntigravitySdkTurn> {
  constructor(options: Omit<AsyncSdkDriverOptions<AntigravitySdkTurn>, 'runtime' | 'start' | 'adapter'> & {
    start: (execution: SdkExecution, text: string, projection: ReturnType<AsyncSdkProjection['antigravity']>,
      context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => AntigravitySdkTurn;
  }) {
    super({
      ...options,
      runtime: 'antigravity',
      adapter: callbacks => new AntigravityDispatchAdapter(callbacks),
      start: (execution, text, projection, context, attachments, interaction) =>
        options.start(execution, text, projection.antigravity(execution, text), context, attachments, interaction),
    });
  }
}

type OwnedDriverOptions = ConstructorParameters<typeof AntigravityExecutionDriver>[0];
export type AntigravityOwnedOptions = {
  store: ConnectorUserStore;
  config: AntigravityConfig;
  authorize: OwnedDriverOptions['authorize'];
  changed?: OwnedDriverOptions['changed'];
  turnContext?: OwnedDriverOptions['turnContext'];
  projection?: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession'>;
};
export type AntigravityStarter = (execution: SdkExecution, text: string, projection: AntigravityProjection,
  assertOwnership: () => void) => AntigravitySdkTurn;

export class AntigravityOwnedRuntime extends SdkOwnedRuntime<'antigravity', AntigravityConfig, AntigravityExecutionDriver> {
  private readonly quotaRetries: AntigravityQuotaRetryManager;

  constructor(options: AntigravityOwnedOptions,
    start?: AntigravityStarter,
    check: (config: AntigravityConfig) => SdkPreflight = value => new AntigravityWorkerPreflight(value),
    deleteNative: (config: AntigravityConfig, request: PrivateWorkerDeletion) => SdkPreflight = (value, request) => new AntigravityWorkerDeletion(value, request),
    compact?: (execution: SdkCompactExecution, assertOwnership: () => void) => SdkOwnedCompactWorker) {
    const config = structuredClone(options.config);
    const ownedConfig = { ...config, model: config.model ?? 'default', ...(!config.modelChoices ? { dynamicModels: true } : {}) };
    const lastActors = new Map<string, { actorId: string }>();
    let notifyChanged: ((key: string) => void) | undefined;
    let wakeSession: ((key: string) => void) | undefined;
    const quotaRetries = new AntigravityQuotaRetryManager({
      onChange: key => notifyChanged?.(key),
    });
    const projection = options.projection
      ? new AntigravitySessionProjection(options.store, options.projection, config.model, key => quotaRetries.get(key))
      : undefined;
    super({
      ...options,
      config: ownedConfig,
      runtime: 'antigravity',
      journal: options.store.antigravityJournal,
      hasNativeBinding: (value, nativeSessionId) => {
        try { return Boolean(readAntigravitySessionBinding(value, nativeSessionId)); }
        catch { return false; }
      },
      check,
      deleteNative,
      projection,
      driver: hooks => {
        notifyChanged = hooks.changed;
        const driver = new AntigravityExecutionDriver({
          store: options.store,
          deadlineMs: config.startupTimeoutMs,
          ...(options.turnContext ? { turnContext: options.turnContext } : {}),
          authorize: (key, actor, action) => {
            if (action === 'messages:send' && actor.actorId) {
              lastActors.set(key, { actorId: actor.actorId });
            }
            return (action === 'runs:interrupt'
              || sdkModelAllowed(ownedConfig, options.store.antigravityJournal.session(key)?.model))
              && options.authorize(key, actor, action);
          },
          admissionReady: hooks.admissionReady,
          changed: hooks.changed,
          compactTimeoutMs: config.compactTimeoutMs ?? 600_000,
          startCompact: execution => {
            hooks.assertOwnership();
            quotaRetries.cancel(execution.key);
            if (compact) return compact(execution, hooks.assertOwnership);
            return new AntigravityCompactWorker({
              config: structuredClone(config),
              execution,
              assertOwnership: hooks.assertOwnership,
              timeoutMs: config.compactTimeoutMs ?? 600_000,
            });
          },
          start: (execution, text, turnProjection) => {
            hooks.assertOwnership();
            quotaRetries.cancel(execution.key);
            if (start) return start(execution, text, turnProjection, hooks.assertOwnership);
            return new AntigravitySdkTurn({
              config: structuredClone(config),
              execution,
              text,
              projection: turnProjection,
              assertOwnership: hooks.assertOwnership,
              onQuotaWait: (wait, resumePrompt) => {
                quotaRetries.schedule(execution.key, wait, resumePrompt, (key, prompt) => {
                  const actor = lastActors.get(key);
                  if (!actor || !hooks.admissionReady()) return;
                  if (!options.store.antigravityJournal.canStart(key) || options.store.turns.hasPending('antigravity', key)) return;
                  if (!options.authorize(key, { text: prompt, actorId: actor.actorId, images: [] }, 'messages:send')) return;
                  options.store.turns.enqueue('antigravity', {
                    id: randomUUID(),
                    sessionKey: key,
                    createdAt: Date.now(),
                    payload: { text: prompt, actorId: actor.actorId, images: [] },
                  });
                  wakeSession?.(key);
                });
              },
            });
          },
        });
        wakeSession = key => { void driver.wake(key); };
        return driver;
      },
    });
    this.quotaRetries = quotaRetries;
  }

  getQuotaWait(key: string): AntigravityQuotaWaitState | undefined {
    return this.quotaRetries.get(key);
  }

  cancelQuotaWait(key: string): boolean {
    return this.quotaRetries.cancel(key);
  }

  override close(): Promise<void> {
    this.quotaRetries.close();
    return super.close();
  }
}

export class AntigravityConnectorRuntime implements ConnectorAgentLifecycle {
  readonly id = 'antigravity' as const;
  private owned?: AntigravityOwnedRuntime;
  private activated = false;
  private failed = false;
  private closed = false;
  private pause: AdmissionPause | undefined;
  private ownedPause: AdmissionPause | undefined;
  private closing?: Promise<void>;

  constructor(private readonly options: AntigravityOwnedOptions,
    private readonly createOwner = (value: AntigravityOwnedOptions) => new AntigravityOwnedRuntime(value)) {}

  activate() {
    if (this.activated || this.closed) return;
    this.activated = true;
    if (this.pause) {
      try {
        this.owned = this.createOwner(this.options);
        this.ownedPause = this.owned.pauseQueueWorker();
      } catch { this.failed = true; }
      return;
    }
    this.start();
  }

  private start() {
    if (this.closed || this.pause || this.failed) return;
    try {
      this.owned ??= this.createOwner(this.options);
      void this.owned.initialize().catch(() => { this.failed = true; });
    } catch { this.failed = true; }
  }

  get status(): AgentReadiness {
    if (this.closed) return 'closed';
    const ownedStatus = this.owned?.status;
    if (this.failed || ownedStatus === 'failed') return 'failed';
    if (this.pause) return 'maintenance';
    return ownedStatus ?? 'starting';
  }
  get ready() { return this.status === 'ready'; }
  get commands() {
    if (this.closed || this.pause || !this.owned) throw unavailable();
    return this.owned.commands;
  }
  refreshDirectory() { this.owned?.refreshDirectory(); }
  remove(key: string, authorize: () => void, acknowledge: () => void) {
    if (!this.ready || !this.owned) throw unavailable();
    return this.owned.remove(key, authorize, acknowledge);
  }
  async refreshSession(key: string, options: HistoryRefreshOptions = {}) {
    if (this.closed || this.failed || !this.owned) throw unavailable();
    await this.owned.refreshSession(key, options);
  }
  isSessionHistoryReady(key: string) { return !this.closed && !!this.owned?.isSessionHistoryReady(key); }
  recoverSession(key: string, expectedRunId: string) { return !this.closed && !this.failed && !!this.owned?.recoverSession(key, expectedRunId); }

  pauseQueueWorker(): AdmissionPause {
    if (this.closed) throw unavailable();
    if (this.pause) return this.pause;
    this.ownedPause = this.owned?.pauseQueueWorker();
    let drained = false;
    const pause: AdmissionPause = {
      drained: Promise.resolve().then(() => this.ownedPause?.drained).then(() => { drained = true; }),
      resume: () => {
        if (!drained || this.closed || this.pause !== pause || this.ownedPause && !this.ownedPause.resume()) return false;
        this.pause = undefined;
        this.ownedPause = undefined;
        if (this.activated) this.start();
        return true;
      },
    };
    this.pause = pause;
    return pause;
  }

  inspectMaintenance() {
    if (this.closed || this.failed || !this.owned) throw unavailable();
    const original = this.owned, pause = this.pause;
    const facts = original.inspectMaintenance();
    if (!facts.ownershipHeld || facts.cleanupUnconfirmed || facts.closed || facts.faulted) throw unavailable();
    return {
      ...facts,
      assertCurrent: () => {
        if (this.closed || this.failed || this.owned !== original || this.pause !== pause) throw unavailable();
        facts.assertCurrent();
      },
    };
  }

  close() {
    this.closed = true;
    return this.closing ??= this.owned?.close() ?? Promise.resolve();
  }
}

type AsyncLifecycle = AsyncSdkOwnedOptions<'antigravity', AntigravityConfig, AsyncAntigravityExecutionDriver>;
export type AsyncAntigravityOwnedOptions = Pick<AsyncLifecycle, 'owner' | 'config' | 'projection' | 'changed' | 'diagnostics'>
  & Pick<AsyncSdkDriverOptions<AntigravitySdkTurn>, 'turnContext'>;
export type AsyncAntigravityOwnedPorts = Partial<Pick<AsyncLifecycle, 'check' | 'deleteNative'>> & {
  start?: ConstructorParameters<typeof AsyncAntigravityExecutionDriver>[0]['start'];
  compact?: (execution: SdkCompactExecution, assertOwnership: () => void) => SdkOwnedCompactWorker;
};

export function createAsyncAntigravityConnectorRuntime(options: AsyncAntigravityOwnedOptions, ports: AsyncAntigravityOwnedPorts = {}) {
  return new AsyncSdkConnectorRuntime('antigravity', () => createAsyncAntigravityOwnedRuntime(options, ports), options.diagnostics);
}

export async function createAsyncAntigravityOwnedRuntime(options: AsyncAntigravityOwnedOptions, ports: AsyncAntigravityOwnedPorts = {}) {
  const config = structuredClone(options.config);
  const compactModels = {
    model: config.model ?? 'default',
    ...(config.modelChoices ? { modelChoices: config.modelChoices } : { dynamicModels: true }),
  };
  let notifyChanged: ((key: string) => void) | undefined;
  const quotaRetries = new AntigravityQuotaRetryManager({
    onChange: key => notifyChanged?.(key),
  });
  const owned = await AsyncSdkOwnedRuntime.create({
    ...options,
    config,
    runtime: 'antigravity',
    getQuotaWait: key => quotaRetries.get(key),
    hasNativeBinding: (value, nativeSessionId) => {
      try { return Boolean(readAntigravitySessionBinding(value, nativeSessionId)); }
      catch { return false; }
    },
    check: ports.check ?? (value => new AntigravityWorkerPreflight(value)),
    deleteNative: ports.deleteNative ?? ((value, request) => new AntigravityWorkerDeletion(value, request)),
    driver: hooks => {
      notifyChanged = hooks.changed;
      return new AsyncAntigravityExecutionDriver({
        owner: options.owner,
        deadlineMs: config.startupTimeoutMs,
        ...(options.turnContext ? { turnContext: options.turnContext } : {}),
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        admissionReady: hooks.admissionReady,
        changed: hooks.changed,
        compact: {
          models: compactModels,
          timeoutMs: config.compactTimeoutMs ?? 600_000,
          start: execution => {
            hooks.assertOwnership();
            quotaRetries.cancel(execution.key);
            if (ports.compact) return ports.compact(execution, hooks.assertOwnership);
            return new AntigravityCompactWorker({
              config: structuredClone(config),
              execution,
              assertOwnership: hooks.assertOwnership,
              timeoutMs: config.compactTimeoutMs ?? 600_000,
            });
          },
        },
        start: (execution, text, projection, context, attachments, interaction) => {
          hooks.assertOwnership();
          quotaRetries.cancel(execution.key);
          if (ports.start) return ports.start(execution, text, projection, context, attachments, interaction);
          return new AntigravitySdkTurn({
            config: structuredClone(config),
            execution,
            text,
            ...(context ? { context } : {}),
            ...(attachments?.length ? { attachments } : {}),
            projection,
            assertOwnership: hooks.assertOwnership,
            onQuotaWait: (wait, resumePrompt) => {
              quotaRetries.schedule(execution.key, wait, resumePrompt, () => {
                // Async worker mode notifies subscribers when wait expires so
                // either the active client or next turn continues seamlessly.
              });
            },
          });
        },
      });
    },
  });
  const originalClose = owned.close.bind(owned);
  owned.close = () => {
    quotaRetries.close();
    return originalClose();
  };
  return owned;
}
