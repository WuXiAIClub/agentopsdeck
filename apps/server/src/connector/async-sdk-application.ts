import type { AgentReadiness } from '@agentopsdeck/shared';
import type { ApplicationCompactParticipants } from '../application-compact-ingress.js';
import { createAsyncClaudeConnectorRuntime, type AsyncClaudeOwnedOptions, type AsyncClaudeOwnedPorts } from '../claude/async-owned-runtime.js';
import { createAsyncCopilotConnectorRuntime, type AsyncCopilotOwnedOptions, type AsyncCopilotOwnedPorts } from '../copilot/async-owned-runtime.js';
import { createAsyncAntigravityConnectorRuntime, type AsyncAntigravityOwnedOptions, type AsyncAntigravityOwnedPorts } from '../antigravity/sdk-runtime.js';
import { createAntigravityModelsReader } from '../antigravity/models.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { ConnectorAgentLifecycle } from './agent-runtimes.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ConnectorOwnerCommands, ConnectorOwnerKind } from './connector-owner-domain.js';
import type { AsyncSdkExecutionDriver } from './async-sdk-execution-driver.js';
import type { SdkOwnedTurn } from './sdk-execution-driver.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkMessagesHttp } from './sdk-messages-http.js';
import type { SdkLocalHttp } from './sdk-local-http.js';
import type { SdkQueueHttp } from './sdk-queue-http.js';
import type { SdkDeletionHttp } from './sdk-deletion-http.js';
import type { SdkCompactHttp } from './sdk-compact-http.js';
import type { SdkInteractionsHttp } from './sdk-interactions-http.js';
import { AsyncSdkInteractionRuntime } from './async-sdk-interaction-runtime.js';
import { AsyncSdkHistory } from './async-sdk-history.js';
import { AsyncSdkUsage } from './async-sdk-usage.js';
import { AsyncSdkFiles } from './async-sdk-files.js';
import { AsyncSdkMetadata } from './async-sdk-metadata.js';
import type { SdkMetadataHttp } from './sdk-metadata-http.js';
import type { SdkFilesHttp } from './sdk-files-http.js';
import type { SdkUsageHttp } from './sdk-usage-http.js';
import type { SdkHistoryHttp } from './sdk-history-http.js';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { AsyncSdkStatus } from './async-sdk-status.js';
import { AsyncSdkLocal } from './async-sdk-local.js';
import { AsyncSdkQueue } from './async-sdk-queue.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ApplicationStopParticipants } from '../application-stop-ingress.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';

export type AsyncSdkApplicationHttp = {
  sdkMessages: SdkMessagesHttp & Required<Pick<SdkMessagesHttp, 'status' | 'stop'>>;
  sdkLocal: SdkLocalHttp; sdkQueue: SdkQueueHttp; sdkDeletion: SdkDeletionHttp; sdkCompact: SdkCompactHttp; sdkInteractions: SdkInteractionsHttp;
  sdkHistory: SdkHistoryHttp;
  sdkUsage: SdkUsageHttp;
  sdkFiles: SdkFilesHttp;
  sdkMetadata: SdkMetadataHttp;
};
type Original = {
  driver: Pick<AsyncSdkExecutionDriver<SdkOwnedTurn>, 'wake' | 'interruptMessage'> & Partial<Pick<AsyncSdkExecutionDriver<SdkOwnedTurn>, 'compact'>>;
  remove: (key: string, commandKey: string, authorization: string, signal?: AbortSignal,
    application?: ApplicationTransactionEvidence, authority?: ApplicationCommandScope) => ReturnType<SdkDeletionHttp['remove']>;
};
type Runtime = ConnectorAgentLifecycle & {
  readonly ready: boolean; readonly status: AgentReadiness; activate(): void; whenStarted(): Promise<void>; whenPrepared(): Promise<void>;
  withReady<T>(run: (original: Original) => T): T;
  withRetainedOwner<T>(run: (original: Original) => T): T;
  refreshProjection(): Promise<void>;
  refreshDirectory(): Promise<void>;
  refreshSession(key: string, options: { fresh: true }): Promise<void>;
  isSessionHistoryReady(key: string): boolean;
  inspectMaintenance(): ReturnType<ReturnType<typeof createAsyncClaudeConnectorRuntime>['inspectMaintenance']>;
};
export type AsyncSdkApplicationOptions = {
  owner: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'>;
  projection: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession' | 'getSession' | 'addMessage'>;
  claude?: AsyncClaudeOwnedOptions['config']; copilot?: AsyncCopilotOwnedOptions['config'];
  antigravity?: AsyncAntigravityOwnedOptions['config'];
  turnContext?: AsyncClaudeOwnedOptions['turnContext'];
  gateway?: () => string; changed?: (key: string) => void;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
};
export type AsyncSdkApplicationPorts = { claude?: AsyncClaudeOwnedPorts; copilot?: AsyncCopilotOwnedPorts; antigravity?: AsyncAntigravityOwnedPorts };
const unavailable = () => Error('SDK application unavailable; original command ownership retained');

/** One complete SDK assembly using the startup owner's existing DB connection.
 * Construction has no native/DB/HOME effects. Close drains this module, NOT the
 * shared owner: startup must close that owner only after all consumers drain. */
export class AsyncSdkApplication {
  readonly claude: Runtime | undefined;
  readonly copilot: Runtime | undefined;
  readonly antigravity: Runtime | undefined;
  readonly http: AsyncSdkApplicationHttp & { sdkMessages: { messages: Pick<AsyncSdkMessages, 'sendPhysical' | 'readReceiptPhysical' | 'readSendReceiptPhysical'>;
    stopPhysical: NonNullable<ApplicationStopParticipants['sdk']>['stopPhysical']; status: AsyncSdkStatus };
    sdkCompact: NonNullable<ApplicationCompactParticipants['sdk']> };
  private readonly interactions: AsyncSdkInteractionRuntime;
  private readonly history: AsyncSdkHistory;
  private readonly usage: AsyncSdkUsage;
  private readonly files: AsyncSdkFiles;
  private readonly metadata: AsyncSdkMetadata;
  private readonly messages: AsyncSdkMessages;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly diagnostics: PerformanceDiagnostics;
  private projectionRefresh: Promise<void> | undefined;
  private projectionGeneration = 0;

  constructor(options: AsyncSdkApplicationOptions, ports: AsyncSdkApplicationPorts = {}) {
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK application deadline required');
    this.interactions = new AsyncSdkInteractionRuntime(options.owner, options.changed, this.diagnostics);
    const common = { owner: options.owner, projection: options.projection, diagnostics: this.diagnostics, interactions: this.interactions,
      ...(options.changed ? { changed: options.changed } : {}),
      ...(options.turnContext ? { turnContext: options.turnContext } : {}) };
    this.claude = options.claude ? createAsyncClaudeConnectorRuntime({ ...common, config: structuredClone(options.claude) }, ports.claude) : undefined;
    this.copilot = options.copilot ? createAsyncCopilotConnectorRuntime({ ...common, config: structuredClone(options.copilot) }, ports.copilot) : undefined;
    this.antigravity = options.antigravity ? createAsyncAntigravityConnectorRuntime({
      owner: options.owner, projection: options.projection, diagnostics: this.diagnostics,
      ...(options.changed ? { changed: options.changed } : {}),
      ...(options.turnContext ? { turnContext: options.turnContext } : {}),
      config: structuredClone(options.antigravity),
    }, ports.antigravity) : undefined;
    const runtime = (id: SdkAgentId) => id === 'claude-code' ? this.claude : id === 'ghcp' ? this.copilot : this.antigravity;
    const original = (id: SdkAgentId) => { const target = runtime(id); if (this.closed || !target) throw unavailable(); return target; };
    const ready = (id: SdkAgentId) => !this.closed && runtime(id)?.ready === true;
    const originalCommand = options.owner.command.bind(options.owner);
    const owner: Pick<AsyncConnectorOwner, 'command'> = {
      command: <K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> => {
        if (this.closed) return Promise.reject(unavailable());
        return this.track(originalCommand(kind, input));
      },
    };
    this.history = new AsyncSdkHistory(owner, { timeoutMs, diagnostics: this.diagnostics });
    this.usage = new AsyncSdkUsage(owner, { timeoutMs, diagnostics: this.diagnostics });
    this.files = new AsyncSdkFiles(owner, { timeoutMs, diagnostics: this.diagnostics });
    const discoverModels = options.antigravity && !options.antigravity.modelChoices
      ? { antigravity: createAntigravityModelsReader(structuredClone(options.antigravity)) }
      : undefined;
    this.metadata = new AsyncSdkMetadata(owner, { timeoutMs, diagnostics: this.diagnostics, ...(discoverModels ? { discoverModels } : {}) });
    const notify = (id: SdkAgentId, key: string, wake: boolean) => {
      if (this.closed || !runtime(id)) return;
      return this.observe(Promise.resolve().then(() => {
        if (this.closed) return;
        return wake ? original(id).withRetainedOwner(value => value.driver.wake(key)) : original(id).refreshSession(key, { fresh: true });
      }), wake ? 1 : 2);
    };
    const local = new AsyncSdkLocal(owner, (id, key) => notify(id, key, false));
    const messages = this.messages = new AsyncSdkMessages(owner, (id, key) => notify(id, key, true), this.diagnostics);
    const status = new AsyncSdkStatus(owner, (id, key) => {
      const session = options.projection.getSession(key);
      // Copy display fields only; never pass projection status/authority to SQL.
      const fields = ['modelProvider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'contextTokens', 'compactionCount'] as const;
      const display = Object.fromEntries(fields.filter(field => session?.[field] !== undefined).map(field => [field, session![field]]));
      return { connected: ready(id), gateway: options.gateway?.() ?? 'unknown', session: display };
    }, report => {
      if (this.closed) throw unavailable();
      for (const message of report) options.projection.addMessage(message);
    }, this.diagnostics);
    const controls = { ready, timeoutMs, diagnostics: this.diagnostics };
    this.http = {
      sdkHistory: { history: this.history },
      sdkUsage: { usage: this.usage, timeoutMs },
      sdkFiles: { files: this.files, timeoutMs },
      sdkMetadata: { metadata: this.metadata, ready, configured: id => runtime(id) !== undefined },
      sdkMessages: { ...controls, messages, status,
        stopPhysical: (input, authority) => original(input.runtime).withRetainedOwner(value => value.driver.interruptMessage(input, authority)),
        stop: input => original(input.runtime).withRetainedOwner(value => value.driver.interruptMessage(input)) },
      sdkLocal: { ...controls, local, physical: local }, sdkQueue: { ...controls, queue: new AsyncSdkQueue(owner) },
      sdkDeletion: { ...controls, owner, remove: (id, key, commandKey, authorization, signal) =>
        original(id).withReady(value => value.remove(key, commandKey, authorization, signal)),
        removePhysical: (input, authority) => original(input.runtime).withReady(value =>
          value.remove(input.key, input.commandKey, input.authorization, undefined, input.application, authority)) },
      sdkCompact: { ...controls, owner, compact: (id, key, commandKey, authorization, signal) =>
        original(id).withReady(value => {
          if (!value.driver.compact) return Promise.resolve('not_started' as const);
          return value.driver.compact(key, commandKey, authorization, signal);
        }),
        compactPhysical: (input, authority) => original(input.runtime).withReady(value =>
          value.driver.compact
            ? value.driver.compact(input.key, input.commandKey, input.authorization, undefined, input.application, authority)
            : Promise.resolve('not_started' as const)),
        readPhysical: async (input, authority) => {
          const result = await this.track(owner.command('sdkCompactReceiptRead', input));
          await authority.authorize('prepare'); authority.local(); return result;
        } },
      sdkInteractions: { ...controls, interactions: {
        observe: input => this.closed ? Promise.reject(unavailable()) : this.track(this.interactions.observe(input)),
        mode: input => this.closed ? Promise.reject(unavailable()) : this.track(this.interactions.mode(input)),
        answer: input => this.closed ? Promise.reject(unavailable()) : this.track(this.interactions.answer(input)),
      } },
    };
  }
  private track<T>(physical: Promise<T>): Promise<T> {
    this.pending.add(physical);
    void physical.then(() => this.pending.delete(physical), () => this.pending.delete(physical));
    return physical;
  }
  private observe(physical: Promise<void>, step: number): Promise<void> {
    return this.track(physical.catch(() => {
      const trace = guardedTrace(this.diagnostics, 'sdk-owned-lifecycle'); trace.add('step', 20 + step); trace.finish(true);
    }));
  }
  activate(): void { if (!this.closed) { this.claude?.activate(); this.copilot?.activate(); this.antigravity?.activate(); } }
  start(): Promise<void> {
    return this.startOriginals(false);
  }
  /** Assembly-only bootstrap: a retained maintenance lease can prepare owned
   * projections while keeping original native preflight deferred until resume. */
  prepare(): Promise<void> {
    return this.startOriginals(true);
  }
  private startOriginals(maintenance: boolean): Promise<void> {
    if (this.closed) return Promise.reject(unavailable());
    return this.track(Promise.resolve().then(async () => {
      if (this.closed) throw unavailable();
      const results = await Promise.allSettled([this.claude, this.copilot, this.antigravity].filter((target): target is Runtime => !!target)
        .map(target => Promise.resolve().then(() => maintenance ? target.whenPrepared() : target.whenStarted())));
      if (this.closed || results.some(result => result.status === 'rejected')) throw unavailable();
    }));
  }
  /** Stable callback identity for the SDK FRAGMENT of a global causal refresh.
   * No cached main-side status or native-idle inference replaces worker reads. */
  readonly refreshProjection = (): Promise<void> => {
    if (this.closed) return Promise.reject(unavailable());
    ++this.projectionGeneration;
    if (this.projectionRefresh) return this.projectionRefresh;
    const work = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const generation = this.projectionGeneration;
        // A failed/synchronously throwing peer must neither skip its sibling
        // nor release physical ownership while that sibling is still reading.
        const results = await Promise.allSettled([this.claude, this.copilot, this.antigravity].filter((target): target is Runtime => !!target)
          .map(target => Promise.resolve().then(() => target.refreshProjection())));
        if (results.some(result => result.status === 'rejected')) throw unavailable();
        if (this.closed) throw unavailable();
        if (generation === this.projectionGeneration) return;
      }
      throw unavailable();
    }).finally(() => { if (this.projectionRefresh === work) this.projectionRefresh = undefined; });
    this.projectionRefresh = this.track(work);
    return work;
  };
  /** The original configured native directories, retained through close even
   * if a sibling fails; never infer execution readiness from this display read. */
  readonly refreshDirectories = (): Promise<void> => {
    if (this.closed) return Promise.reject(unavailable());
    return this.track(Promise.resolve().then(async () => {
      if (this.closed) throw unavailable();
      const results = await Promise.allSettled([this.claude, this.copilot, this.antigravity].filter((target): target is Runtime => !!target)
        .map(target => Promise.resolve().then(() => target.refreshDirectory())));
      if (this.closed || results.some(result => result.status === 'rejected')) throw unavailable();
    }));
  };
  get agents(): readonly ConnectorAgentLifecycle[] { return [this.claude, this.copilot, this.antigravity].filter((value): value is Runtime => !!value); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.interactions.freeze();
    const history = this.history.close();
    const usage = this.usage.close();
    const files = this.files.close();
    const metadata = this.metadata.close();
    const messages = this.messages.close();
    return this.closing = Promise.resolve().then(async () => {
      // Interrupt native owners immediately, but retain every original SQL
      // promise even if its HTTP waiter already timed out or was cancelled.
      const closing = this.agents.map(agent => Promise.resolve().then(() => agent.close()));
      const results = await Promise.allSettled(closing);
      const interactions = await Promise.allSettled([this.interactions.close(), history, usage, files, metadata, messages]);
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      if ([...results, ...interactions].some(value => value.status === 'rejected')) throw unavailable();
    });
  }
}
