import { randomUUID } from 'node:crypto';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { HistoryDiagnostics, timeHistoryAsync, timeHistorySync, withoutHistoryDiagnostics } from '../storage/history-diagnostics.js';
import { tokenUsageRange, tokenSnapshotRequestId, tokenSnapshotSelection } from '@agentopsdeck/shared';
import { NativeTokenSnapshotConflict, NativeTokenSnapshotLimit } from '../connector/native-token-snapshots.js';
import { NativeTokenExportTooLarge } from '../connector/native-token-usage.js';
import { registerInteractions } from '../connector/interactions-http.js';
import type { SdkInteractionsHttp } from '../connector/sdk-interactions-http.js';
import type { SdkMessagesHttp } from '../connector/sdk-messages-http.js';
import type { HermesMessagesHttp } from '../connector/hermes-messages-http.js';
import type { OpenClawMessagesHttp } from '../connector/openclaw-messages-http.js';
import type { CodexMessagesHttp } from '../connector/codex-messages-http.js';
import type { SdkLocalHttp } from '../connector/sdk-local-http.js';
import type { InteractionRuntime } from '../commands/interaction-runtime.js';
import { AGENTOPSDECK_BUILD, CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { registerConnectorMachineHttp } from '../connector/machine-http.js';
import { closeMachineServices } from '../connector/machine-authority.js';
import { registerConnectorBoardBindings } from '../connector/board-bindings-http.js';
import { isSdkCompactCommand } from '../connector/sdk-text-command.js';
import { registerMaintenanceInspection, type NativeMaintenanceObservation } from '../connector/maintenance-inspection.js';
import { clampMessageLimit } from '../messages/history-page.js';
import type { SdkHistoryHttp } from '../connector/sdk-history-http.js';
import type { SdkUsageHttp } from '../connector/sdk-usage-http.js';
import type { CodexPublicUsageHttp } from '../connector/codex-public-usage-http.js';
import type { SdkFilesHttp } from '../connector/sdk-files-http.js';
import type { CodexFilesHttp } from '../connector/codex-files-http.js';
import type { SdkMetadataHttp } from '../connector/sdk-metadata-http.js';
import { createConditionalHistory } from '../messages/conditional-history.js';
import { createHistoryPreparation } from '../refresh/history-preparation.js';
import { HISTORY_ASYNC_HEADER, historyPendingBody } from '@agentopsdeck/shared';
import { summarizeToolMessage } from '../messages/tool-summary.js';
import { readIndexedToolMessage } from '../codex/indexed-tool-output.js';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { SdkQueueHttp } from '../connector/sdk-queue-http.js';
import type { SdkDeletionHttp } from '../connector/sdk-deletion-http.js';
import type { HermesDeletionHttp } from '../connector/hermes-deletion-http.js';
import type { HermesCreationHttp } from '../connector/hermes-creation-http.js';
import type { CodexCreationHttp } from '../connector/codex-creation-http.js';
import type { HermesQueueHttp } from '../connector/hermes-queue-http.js';
import type { HermesReadsHttp } from '../connector/hermes-reads-http.js';
import type { CodexReadsHttp } from '../connector/codex-reads-http.js';
import type { SdkCompactHttp } from '../connector/sdk-compact-http.js';
import type { SdkRecoveryHttp } from '../connector/sdk-recovery-http.js';
import { HTTPException } from 'hono/http-exception';
import { registerCompactReceipts, registerCreationReceipts, registerDeletionReceipts, registerMessageReceipts, reply } from '../commands/http.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { requireExpectedRun, RunControlConflict } from '../commands/run-control.js';
import { SessionDeletionConflict, TurnAuthorizationError } from '../commands/turn-queue.js';
import { replayStoreEvents, type EventReplayRead, type EventSnapshotRead } from './events.js';
import { ReadRequestOwner, ReadRequestError } from '../lifecycle/read-request-owner.js';
import { AOD_MODEL_SET_ID, sessionRuntimeId } from '@agentopsdeck/shared';
import type { HermesRuntime } from '../hermes/runtime.js';
import type { ClaudeConnectorRuntime } from '../claude/connector-runtime.js';
import { claudeHistoryPage, claudeHistoryMessage } from '../claude/history.js';
import type { CopilotConnectorRuntime } from '../copilot/connector-runtime.js';
import { copilotHistoryPage, copilotHistoryMessage, antigravityHistoryPage, antigravityHistoryMessage } from '../copilot/history.js';
import type { AntigravityConnectorRuntime } from '../antigravity/sdk-runtime.js';
import { createAntigravityModelsReader } from '../antigravity/models.js';
import { sdkModelAllowed, sdkModelChoices } from '../connector/sdk-models.js';
import type { AgentSummary, ConnectorCapabilities } from '@agentopsdeck/shared';
import type { ServerConfig } from '../config.js';
import type { ConnectorPrincipal, ConnectorScope, ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { CodexAppServer } from '../codex/app-server.js';
import type { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { interruptOpenClawRun } from '../openclaw/run-control.js';
import { MAX_TOTAL_MEDIA_BYTES, normalizeSendMessageRequest, persistUploadedMedia } from '../messages/send-message.js';
import { resolveExplicitChannelRoute } from '../messages/mirror.js';
import { shouldUseOpenClawCliFallback, createCliFallbackDisplaySessionKey, isOpenClawCliAvailable } from '../openclaw/cli.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { readGatewayModelSetStatus, reconcileGatewayModelSet } from '../connector/model-set.js';
import { ConnectorUpdateService } from '../connector/update-service.js';
import { registerConnectorUpdates, synchronousUpdateAuthority, type ConnectorUpdateAuthority } from '../connector/update-http.js';
import { readJsonBody } from '../utils/http-body.js';
import { EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { registerAsyncRuntimeHttp } from '../connector/async-runtime-http.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { registerConnectorTokenRoutes } from '../connector/token-http.js';
import { resolveExecutionActor } from '../connector/execution-authority.js';
import type { ExecutionAction } from '../connector/execution-grants.js';
import { registerSessionMediaRoutes } from '../connector/session-media-http.js';
import { prepareSdkAttachments } from '../connector/sdk-attachment-input.js';
import type { ArtifactRegistryAccess } from '../messages/artifact-receiver.js';
import { registerQueueRoutes } from '../connector/queue-http.js';
import { parseSessionDirectoryQuery } from '../projection/session-directory.js';
import { deleteConnectorSession } from '../connector/session-delete.js';
import { registerSessionSettingsRoutes } from '../connector/session-settings-http.js';
import { reportSessionStatus } from '../connector/session-status.js';
import { registerAsyncMaintenanceReadiness, registerMaintenanceReadiness, type MaintenanceBusinessObservation } from '../connector/maintenance-readiness.js';
import { registerStorageDiagnostics } from '../storage/diagnostics-http.js';
import { linuxMetricsProvider, MetricsSampler } from '../system/metrics.js';
import { registerConnectorAutomation } from '../connector/automation-http.js';
import type { AsyncAutomationHttp } from '../connector/async-automation-http.js';
import type { CodexInteractionsHttp } from '../connector/codex-interactions-http.js';
import type { CodexCatalogHttp } from '../connector/codex-catalog-http.js';
import type { CodexSettingsHttp } from '../connector/codex-settings-http.js';
import type { CodexDeletionHttp } from '../connector/codex-deletion-http.js';
import type { ConnectorAutomationHost } from '../connector/automation-host.js';
import { synchronousConnectorUsersRequests } from '../connector/async-users-request.js';
import type { ConnectorControlHttp } from '../connector/control-http.js';
import { registerConnectorUsersHttp } from '../connector/users-http.js';
import { synchronousConnectorReadAuthority, type ConnectorReadAuthority } from '../connector/read-authority.js';
import type { AsyncSdkApplicationHttp } from '../connector/async-sdk-application.js';
import type { AsyncHermesApplicationHttp } from '../connector/async-hermes-application.js';
import type { AsyncOpenClawApplicationHttp } from '../connector/async-openclaw-application.js';
import type { SessionReadsHttp } from '../connector/session-reads-http.js';

async function readPreferenceBody(request: Request) {
  try { return await readJsonBody(request, 64 * 1024); }
  catch (error) {
    if (error instanceof HTTPException && error.status === 400) return {};
    throw error;
  }
}

export function registerConnectorRoutes(app: Hono, deps: {
  config: ServerConfig;
  interactions?: InteractionRuntime;
  automation?: ConnectorAutomationHost;
  automationConfiguration?: AsyncAutomationHttp['configuration'];
  codexInteractions?: CodexInteractionsHttp;
  codexCatalog?: CodexCatalogHttp;
  codexSettings?: CodexSettingsHttp;
  codexDeletion?: CodexDeletionHttp;
  updateService?: ConnectorUpdateService;
  updateAuthority?: ConnectorUpdateAuthority;
  inspectMaintenance?: (check: () => void) => Promise<NativeMaintenanceObservation>;
  probeMaintenance?: (sessionKey: string, check: () => void) => Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>>;
  probeMaintenanceAsync?: (sessionKey: string, check: () => Promise<void>) => Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>>;
  tokens: ConnectorTokenStore;
  control?: ConnectorControlHttp;
  connectorUsers: ConnectorUserStore;
  store: DeckStore;
  eventReplay?: EventReplayRead;
  eventSnapshot?: EventSnapshotRead;
  eventReadWaitMs?: number;
  publicReadAuthority?: ConnectorReadAuthority;
  gateway: GatewayWsClient;
  codex?: CodexAppServer;
  hermes?: HermesRuntime;
  claude?: ClaudeConnectorRuntime;
  copilot?: CopilotConnectorRuntime;
  antigravity?: AntigravityConnectorRuntime;
  artifactRegistry?: ArtifactRegistryAccess;
  openclawQueue?: OpenClawTurnQueue;
  refreshSessions: (options?: { maxAgeMs?: number }) => Promise<void>;
  sessionSnapshotReady: () => boolean;
  historySnapshotReady: (sessionKey: string) => boolean;
  refreshMessages: (sessionKey: string, options?: import('../refresh/history.js').HistoryRefreshOptions) => Promise<void>;
  fallbackAgents: (error?: string) => AgentSummary[] | PromiseLike<AgentSummary[]>;
  isAuthorizedRequest: (request: Request) => boolean;
  normalizeError: (error: unknown) => string;
  sdkApplication?: AsyncSdkApplicationHttp;
  hermesApplication?: AsyncHermesApplicationHttp;
  openclawApplication?: AsyncOpenClawApplicationHttp;
  sessionReads?: SessionReadsHttp;
  sdkMessages?: SdkMessagesHttp;
  hermesMessages?: HermesMessagesHttp;
  openclawMessages?: OpenClawMessagesHttp;
  codexMessages?: CodexMessagesHttp;
  codexReads?: CodexReadsHttp;
  hermesDeletion?: HermesDeletionHttp;
  hermesCreation?: HermesCreationHttp;
  codexCreation?: CodexCreationHttp;
  hermesQueue?: HermesQueueHttp;
  hermesReads?: HermesReadsHttp;
  sdkLocal?: SdkLocalHttp;
  sdkQueue?: SdkQueueHttp;
  sdkDeletion?: SdkDeletionHttp;
  sdkCompact?: SdkCompactHttp;
  sdkRecovery?: SdkRecoveryHttp;
  sdkInteractions?: SdkInteractionsHttp;
  sdkHistory?: SdkHistoryHttp;
  sdkUsage?: SdkUsageHttp;
  codexPublicUsage?: CodexPublicUsageHttp;
  codexFiles?: CodexFilesHttp;
  sdkFiles?: SdkFilesHttp;
  sdkMetadata?: SdkMetadataHttp;
}) {
  if (deps.store?.requiresAsyncEvents && (typeof deps.eventReplay !== 'function' || typeof deps.eventSnapshot !== 'function')) {
    throw new Error('Async Deck requires complete event replay and snapshot ports');
  }
  if ((deps.codexInteractions || deps.codexCatalog || deps.codexSettings || deps.codexDeletion || deps.codexPublicUsage || deps.codexFiles) && deps.codex) {
    throw new Error('Owned Codex HTTP cannot be mixed with a synchronous Codex runtime');
  }
  if (deps.automationConfiguration && deps.automation) {
    throw new Error('Automation configuration cannot be mixed with a synchronous automation host');
  }
  if (deps.openclawApplication && (deps.openclawMessages || deps.openclawQueue)) {
    throw new Error('OpenClaw application cannot be mixed with a synchronous queue or individual assembly');
  }
  const openclawMessages = deps.openclawApplication?.openClawMessages ?? deps.openclawMessages;
  if (openclawMessages && deps.openclawQueue) throw new Error('Async OpenClaw messages cannot be mixed with a synchronous queue writer');
  if (deps.openclawApplication) {
    const ports = deps.openclawApplication.openClawMessages;
    if (!ports || typeof ports.ready !== 'function'
      || typeof ports.messages?.send !== 'function' || typeof ports.messages?.readReceipt !== 'function' || typeof ports.messages?.readSendReceipt !== 'function'
      || typeof ports.stop?.stop !== 'function' || typeof ports.status?.send !== 'function' || typeof ports.status?.read !== 'function'
      || typeof ports.status?.readForSend !== 'function' || typeof ports.compact?.compact !== 'function'
      || typeof ports.compact?.read !== 'function' || typeof ports.compact?.readForSend !== 'function'
      || typeof deps.openclawApplication.openClawReads?.reads?.state !== 'function'
      || typeof deps.openclawApplication.openClawReads?.reads?.page !== 'function'
      || typeof deps.openclawApplication.openClawReads?.reads?.message !== 'function') {
      throw new Error('OpenClaw application requires complete messages, control and read ports');
    }
  }
  if (deps.sdkApplication && [deps.sdkMessages, deps.sdkLocal, deps.sdkQueue, deps.sdkDeletion, deps.sdkCompact, deps.sdkRecovery, deps.sdkInteractions, deps.sdkHistory, deps.sdkUsage, deps.sdkFiles, deps.sdkMetadata].some(Boolean)) {
    throw new Error('SDK application ports cannot be mixed with legacy individual assembly');
  }
  const sdkHttp = deps.sdkApplication ?? deps;
  if (deps.hermesApplication && [deps.hermes, deps.hermesMessages, deps.hermesDeletion, deps.hermesCreation, deps.hermesQueue, deps.hermesReads].some(Boolean)) {
    throw new Error('Hermes application cannot be mixed with another Hermes runtime or individual assembly');
  }
  const hermesHttp = deps.hermesApplication ?? deps;
  const base = '/api/connector/v1';
  const historyDiagnostics = new HistoryDiagnostics();
  const sdk = (runtime: string) => runtime === 'claude-code' ? deps.claude : runtime === 'ghcp' ? deps.copilot : runtime === 'antigravity' ? deps.antigravity : undefined;
  const sdkJournal = (runtime: 'claude-code' | 'ghcp' | 'antigravity') => runtime === 'claude-code' ? deps.connectorUsers.claudeJournal : runtime === 'ghcp' ? deps.connectorUsers.copilotJournal : deps.connectorUsers.antigravityJournal;
  const fileRebuilds = new SessionFileRebuilds(deps.connectorUsers.fileIndex, key => {
    const runtime = sessionRuntimeId(key);
    if (runtime === 'codex') return deps.store.getSession(key) && !deps.connectorUsers.commands.sessionDeletion(key)
      ? deps.connectorUsers.fileIndex.projectionBinding(key) : undefined;
    if ((runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity') || deps.connectorUsers.commands.sessionDeletion(key)
      || sdkJournal(runtime).deletion(key)?.phase === 'deleted') return undefined;
    return sdkJournal(runtime).session(key)?.nativeSessionId;
  }, (key, before) => {
    if (sessionRuntimeId(key) === 'codex') return deps.connectorUsers.fileIndex.projectionEvidencePage(key, before);
    if (sessionRuntimeId(key) === 'ghcp') return deps.connectorUsers.copilotTranscript.fileEvidencePage(key, before);
    if (sessionRuntimeId(key) === 'antigravity') return deps.connectorUsers.antigravityTranscript.fileEvidencePage(key, before);
    return deps.connectorUsers.claudeTranscript.fileEvidencePage(key, before);
  }, Date.now, key => sessionRuntimeId(key) === 'codex' ? 'verified-projection' : 'durable-events');
  const replayEvents: EventReplayRead = deps.eventReplay ?? (after => replayStoreEvents(deps.store, after));
  const snapshotEvents: EventSnapshotRead = deps.eventSnapshot ?? (capture => capture(deps.store.latestEventId()));
  const snapshotReads = new ReadRequestOwner('connector-event-projection', { waitMs: deps.eventReadWaitMs });
  let closing: Promise<void> | undefined;
  let closed = false;
  const snapshotResponse = async <T>(c: Context, tokenId: string, scope: ConnectorScope, capture: (cursor: string | undefined) => T): Promise<T> => {
    const check = () => {
      if (closed) throw new HTTPException(503, { res: Response.json({ error: 'Connector is closing' }, { status: 503 }) });
      if (c.req.raw.signal.aborted) throw new HTTPException(408, { res: Response.json({ error: 'Request interrupted' }, { status: 408 }) });
      if (!deps.tokens.hasScope(tokenId, scope)) throw new HTTPException(403, { res: Response.json({ error: `missing ${scope} scope` }, { status: 403 }) });
    };
    check();
    // HTTP cancellation/deadline only ends delivery. The read owner retains
    // admission and drains the exact original callback, including late errors.
    return (await snapshotReads.run(c.req.raw, async context => {
      check();
      const { value } = await context.stage(6, () => snapshotEvents(cursor => {
        context.check(); check(); return capture(cursor);
      }));
      check(); return value;
    })).value;
  };
  const snapshotError = (c: Context, error: unknown, message: string) => error instanceof HTTPException
    ? error.getResponse() : error instanceof ReadRequestError
      ? c.json({ error: error.status === 408 ? 'Request interrupted' : message }, error.status)
      : c.json({ error: message }, 503);
  const executionActor = (c: Context, action?: ExecutionAction) => {
    const sessionKey = c.req.param('sessionKey');
    if (!sessionKey) throw new HTTPException(400, { res: Response.json({ error: 'Session key required' }, { status: 400 }) });
    return resolveExecutionActor(c.req.raw,
      { tokens: deps.tokens, grants: deps.connectorUsers.executionGrants, nodeId: deps.connectorUsers.nodeId },
      { runtime: sessionRuntimeId(sessionKey), sessionKey }, action);
  };

  const controlRoutes = registerAsyncRuntimeHttp(app, deps.connectorUsers.nodeId, {
    ...sdkHttp, ...hermesHttp,
    publicReads: {
      authority: deps.publicReadAuthority ?? synchronousConnectorReadAuthority(deps.tokens),
      changes: deps.store.changes, replay: replayEvents, agents: () => deps.fallbackAgents(),
      sampler: new MetricsSampler({ kind: 'connector', id: deps.connectorUsers.nodeId }, linuxMetricsProvider(deps.config.metricVolumes)),
      connector: connectorMeta(deps.config), ...(deps.eventReadWaitMs === undefined ? {} : { waitMs: deps.eventReadWaitMs }),
    },
    ...(deps.sessionReads ? { sessionReads: deps.sessionReads } : {}),
    ...(deps.control ? { control: deps.control } : {}),
    ...(openclawMessages ? { openClawMessages: openclawMessages } : {}),
    ...(deps.openclawApplication ? { openClawReads: deps.openclawApplication.openClawReads } : {}),
    ...(deps.codexMessages ? { codexMessages: deps.codexMessages } : {}),
    ...(deps.codexReads ? { codexReads: deps.codexReads } : {}),
    ...(deps.codexCreation ? { codexCreation: deps.codexCreation } : {}),
    ...(deps.codexPublicUsage ? { codexPublicUsage: deps.codexPublicUsage } : {}),
    ...(deps.codexFiles ? { codexFiles: deps.codexFiles } : {}),
    ...(deps.codexInteractions ? { codexInteractions: deps.codexInteractions } : {}),
    ...(deps.codexCatalog ? { codexCatalog: deps.codexCatalog } : {}),
    ...(deps.codexSettings ? { codexSettings: deps.codexSettings } : {}),
    ...(deps.codexDeletion ? { codexDeletion: deps.codexDeletion } : {}),
    ...(deps.automationConfiguration ? { automationConfiguration: deps.automationConfiguration } : {}),
  });
  if (!deps.automationConfiguration && deps.automation) registerConnectorAutomation(app, `${base}/automation`, {
    tokens: deps.tokens, host: deps.automation, nodeId: deps.connectorUsers.nodeId,
  });
  // Hono routes registered earlier would bypass that middleware entirely.
  // Until adapters are wired, reject every reserved session path (including
  // settings/deletion/media), not merely sends. No fallback may reach OpenClaw.
  for (const route of [`${base}/sessions/:sessionKey`, `${base}/sessions/:sessionKey/*`]) {
    app.use(route, async (c, next) => {
      const runtime = sessionRuntimeId(c.req.param('sessionKey')!);
      if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
        // Bindings have their own narrow principal and session/readiness checks.
        // Do not force that credential through ordinary execution permissions.
        const suffix = c.req.path.split('/sessions/')[1]?.split('/').slice(1).join('/') ?? '';
        if (/^board-binding(?:\/[^/]+)?$/.test(suffix)) { await next(); return; }
        if (!deps.tokens.authenticate(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
        const owned = sdk(runtime);
        if (!owned) return c.json({ error: 'Requested Agent runtime is disabled' }, 409);
        executionActor(c); // Reject delegation on reads as well as writes.
        const read = c.req.method === 'GET' && /^(?:token-usage(?:\/export)?|files|state|messages(?:\/[^/]+(?:\/media\/[a-f0-9]{64})?)?|queue(?:\/.*)?|commands(?:\/.*)?|compact-commands\/[^/]+|settings-commands\/[^/]+|deletion-commands\/[^/]+)$/.test(suffix);
        const send = c.req.method === 'POST' && (suffix === 'messages' || suffix === 'compact' || suffix === 'recovery');
        const queueWrite = ['PATCH', 'DELETE'].includes(c.req.method) && /^(?:queue\/[^/]+|commands\/[^/]+\/queue)$/.test(suffix);
        const settings = c.req.method === 'PATCH' && suffix === '';
        const remove = c.req.method === 'DELETE' && suffix === '';
        const rebuild = c.req.method === 'POST' && /^files\/rebuild(?:\/[a-f0-9-]{36})?$/.test(suffix)
          || c.req.method === 'DELETE' && /^files\/rebuild\/[a-f0-9-]{36}$/.test(suffix);
        const interaction = c.req.method === 'GET' && suffix === 'interactions'
          || c.req.method === 'PATCH' && suffix === 'interaction-mode'
          || c.req.method === 'POST' && /^interactions\/[^/]+\/answer$/.test(suffix);
        const tokenSnapshot = c.req.method === 'POST' && suffix === 'token-usage/snapshots'
          || c.req.method === 'GET' && /^token-usage\/snapshots\/[^/]+$/.test(suffix);
        if (!read && !send && !queueWrite && !settings && !remove && !rebuild && !interaction && !tokenSnapshot) return c.json({ error: 'This SDK capability is not supported' }, 409);
        if (c.req.method === 'GET' && /^(?:files|state|messages|queue)(?:\/|$)/.test(suffix)
          && sdkJournal(runtime).deletion(c.req.param('sessionKey')!)?.phase === 'deleted') return c.json({ error: 'Session was deleted' }, 404);
        // Sends reach receipt lookup before readiness checks, so an accepted
        // retry during maintenance keeps its original outcome. Fresh sends
        // are rejected definitively by the handler before runtime admission.
        if (queueWrite && c.req.method === 'PATCH' && !owned.ready) return c.json({ error: 'Agent is not ready' }, 503);
      }
      await next();
    });
  }
  app.post(`${base}/sessions/:sessionKey/recovery`, async c => {
    const sessionKey = c.req.param('sessionKey')!;
    const runtime = sessionRuntimeId(sessionKey);
    if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
      if (!requireScope(c.req.raw, deps.tokens, 'messages:read')) return c.json({ error: 'Session recovery access denied' }, 403);
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid execution identity' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
        || !('expectedRunId' in body) || typeof body.expectedRunId !== 'string' || !body.expectedRunId.length
        || body.expectedRunId.length > 512 || /[\x00-\x1f\x7f]/.test(body.expectedRunId)) {
        return c.json({ error: 'Invalid execution identity' }, 400);
      }
      const owned = sdk(runtime);
      if (!owned?.ready) return c.json({ error: 'Agent is not ready; recovery unavailable' }, 409);
      if (!sdkJournal(runtime).session(sessionKey) || sdkJournal(runtime).deletion(sessionKey)?.phase === 'deleted') {
        return c.json({ error: 'Session not found' }, 404);
      }
      return owned.recoverSession(sessionKey, body.expectedRunId)
        ? c.json({ requested: true })
        : c.json({ error: 'Execution changed or recovery unavailable; refresh session state' }, 409);
    }
    return c.json({ error: 'Session recovery is unavailable on this Connector' }, 409);
  });
  const machine = registerConnectorMachineHttp(app, deps.tokens, deps.config);
  if (deps.interactions) registerInteractions(app, { runtime: deps.interactions, users: deps.connectorUsers, tokens: deps.tokens,
    exists: key => {
      const runtime = sessionRuntimeId(key);
      return runtime === 'claude-code' || runtime === 'ghcp' ? !!sdkJournal(runtime).session(key) && sdkJournal(runtime).deletion(key)?.phase !== 'deleted'
        : !!deps.store.getSession(key);
    },
    ready: key => sessionRuntimeId(key) === 'codex' ? !!deps.codex?.interactionReady : !!sdk(sessionRuntimeId(key))?.ready,
    changed: sessionKey => { deps.store.append('interaction.updated', {}, { sessionKey }); },
  });
  const boardBindings = registerConnectorBoardBindings(app, { tokens: deps.tokens,
    directories: { ...(deps.config.claude?.boardToolsDirectory ? { 'claude-code': deps.config.claude.boardToolsDirectory } : {}),
      ...(deps.config.codex.boardToolsDirectory ? { codex: deps.config.codex.boardToolsDirectory } : {}),
      ...(deps.config.copilot?.boardToolsDirectory ? { ghcp: deps.config.copilot.boardToolsDirectory } : {}) },
    policies: deps.config.boardBindingPolicies ?? [], resolveSession: key => {
      const runtime = sessionRuntimeId(key);
      if (runtime === 'codex') {
        if (deps.connectorUsers.commands.sessionDeletion(key) || !deps.codex?.hasBoardTools(key)) return;
        return { runtime, sessionId: key.slice(6), ready: deps.codex.enabled };
      }
      if (runtime !== 'claude-code' && runtime !== 'ghcp') return;
      if (deps.connectorUsers.commands.sessionDeletion(key) || sdkJournal(runtime).deletion(key)) return;
      const entry = sdkJournal(runtime).session(key);
      return entry ? { runtime, sessionId: entry.nativeSessionId, ready: sdk(runtime)?.ready === true } : undefined;
    } });
  registerMaintenanceInspection(app, { nodeId: deps.connectorUsers.nodeId, tokens: deps.tokens,
    ...(deps.inspectMaintenance ? { inspect: deps.inspectMaintenance } : {}) });
  if (!deps.control) app.get(`${base}/identity`, (c) => {
    if (!deps.tokens.authenticate(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    return c.json({ nodeId: deps.connectorUsers.nodeId, protocol: 1 });
  });

  if (!deps.control) registerExecutionGrantRoutes(app, { nodeId: deps.connectorUsers.nodeId, tokens: deps.tokens,
    grants: deps.connectorUsers.executionGrants, turns: deps.connectorUsers.turns, mirrorOutbox: deps.connectorUsers.mirrorOutbox });
  registerSessionMediaRoutes(app, { tokens: deps.tokens, store: deps.store, refreshMessages: deps.refreshMessages, sdkAttachments: deps.connectorUsers.sdkAttachments,
    sourceMessage: (key, id) => {
      if (sessionRuntimeId(key) === 'ghcp') {
        try { return deps.connectorUsers.copilotTranscript.message(key, id) ?? null; }
        catch { return null; }
      }
      if (sessionRuntimeId(key) === 'claude-code') {
        const anchor = claudeMessageAnchor(key, id);
        const message = anchor && deps.connectorUsers.claudeTranscript.message(key, anchor);
        return message ? claudeChatMessages(key, [message]).find(row => row.id === id) ?? null : null;
      }
      return undefined;
    },
    ...(deps.config.sourcePreview ? { sourcePreview: deps.config.sourcePreview } : {}),
    inboundDir: deps.config.inboundMediaDir, artifactConfig: deps.config.artifactReceiver,
    ...(deps.artifactRegistry ? { artifactRegistry: deps.artifactRegistry } : {}) });

  const updateService = deps.updateService ?? new ConnectorUpdateService(deps.config, { nodeId: deps.connectorUsers.nodeId, receipts: deps.connectorUsers.commands });
  const updateAuthority = deps.updateAuthority ?? synchronousUpdateAuthority(deps.tokens, deps.connectorUsers.nodeId);
  if (deps.updateAuthority && deps.probeMaintenance) throw new Error('Async update authority requires awaited maintenance probe');
  const readinessRoutes = deps.updateAuthority
    ? registerAsyncMaintenanceReadiness(app, { nodeId: deps.connectorUsers.nodeId, authority: updateAuthority, updateService,
      ...(deps.probeMaintenanceAsync ? { probe: deps.probeMaintenanceAsync } : {}) })
    : registerMaintenanceReadiness(app, { nodeId: deps.connectorUsers.nodeId, tokens: deps.tokens, updateService,
      ...(deps.probeMaintenance ? { probe: deps.probeMaintenance } : {}) });

  app.get(`${base}/info`, (c) => c.json({
    service: 'aod-connector',
    version: deps.config.connector.version,
    environment: {
      idHint: deps.config.connector.environmentId,
      label: deps.config.connector.environmentLabel,
    },
    features: {
      scopedTokens: true,
      sessions: true,
      messages: true,
      events: true,
      media: true,
      users: true,
      pairing: false,
    },
  }));

  if (!deps.control) registerConnectorUsersHttp(app, base, synchronousConnectorUsersRequests(deps.connectorUsers, deps.tokens));

  app.get(`${base}/health`, (c) => {
    const gateway = deps.store.getGateway();
    const cliAvailable = deps.config.localOpenClawCli && isOpenClawCliAvailable();
    const codexReady = deps.codex?.enabled === true && deps.codex.isSessionListReady();
    return c.json({
      ok: true,
      status: gateway.ok || cliAvailable || codexReady || deps.hermes?.ready || deps.claude?.ready || deps.copilot?.ready || deps.antigravity?.ready ? 'online' : 'degraded',
      gateway,
      codex: { enabled: deps.codex?.enabled === true, sessionListReady: codexReady },
      hermes: { enabled: !!deps.hermes, ready: deps.hermes?.ready === true, status: deps.hermes?.status ?? 'disabled' },
      claude: { enabled: !!deps.claude, ready: deps.claude?.ready === true, status: deps.claude?.status ?? 'disabled' },
      copilot: { enabled: !!deps.copilot, ready: deps.copilot?.ready === true, status: deps.copilot?.status ?? 'disabled' },
      antigravity: { enabled: !!deps.antigravity, ready: deps.antigravity?.ready === true, status: deps.antigravity?.status ?? 'disabled' },
      fallback: { openclawCli: cliAvailable },
      updatedAt: Date.now(),
    });
  });

  app.get(`${base}/capabilities`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:read');
    if (!principal) return c.json({ error: 'missing sessions:read scope' }, 403);
    const capabilities: ConnectorCapabilities & { principal: { tokenId: string; label: string }; limits: { maxRequestsPerMinute: number; maxSseConnections: number } } = {
      principal: { tokenId: principal.tokenId, label: principal.label },
      protocol: CONNECTOR_PROTOCOL,
      connector: { service: 'aod-connector', version: deps.config.connector.version, revision: deps.config.connector.revision, build: AGENTOPSDECK_BUILD },
      environment: { idHint: deps.config.connector.environmentId, label: deps.config.connector.environmentLabel },
      features: { scopedTokens: true, sessions: true, messages: true, events: true, media: true, users: true, pairing: false, modelSet: true, interactions: !!deps.interactions || !!sdkHttp.sdkInteractions || !!deps.codexInteractions, sessionFileIndex: true, connectorUpdate: deps.config.connector.updateEnabled, workspaceFiles: !!Object.keys(deps.config.fileBrowserRoots ?? {}).length },
      runtimes: { hermes: { enabled: !!deps.hermes, ready: deps.hermes?.ready === true, ownerOnly: true,
        features: { text: true, queue: true, interrupt: true, history: true, attachments: false, compact: false, delete: true, modelOverride: false, interactions: false } },
        'claude-code': { enabled: !!deps.claude, ready: deps.claude?.ready === true, status: deps.claude?.status ?? 'disabled', ownerOnly: true,
          features: { text: true, queue: true, interrupt: true, history: true, attachments: true, compact: true, delete: true, modelOverride: true, interactions: sdkHttp.sdkInteractions ? sdkHttp.sdkInteractions.ready('claude-code') === true : !!deps.interactions && deps.claude?.ready === true } },
        ghcp: { enabled: !!deps.copilot, ready: deps.copilot?.ready === true, status: deps.copilot?.status ?? 'disabled', ownerOnly: true,
          features: { text: true, queue: true, interrupt: true, history: true, attachments: true, compact: true, delete: true, modelOverride: true, interactions: sdkHttp.sdkInteractions ? sdkHttp.sdkInteractions.ready('ghcp') === true : !!deps.interactions && deps.copilot?.ready === true } },
        antigravity: { enabled: !!deps.antigravity, ready: deps.antigravity?.ready === true, status: deps.antigravity?.status ?? 'disabled', ownerOnly: true,
          features: { text: true, queue: true, interrupt: true, history: true, attachments: false, compact: true, delete: true, modelOverride: true, interactions: false } } },
      scopes: principal.scopes,
      limits: { maxMessageChars: MAX_MESSAGE_CHARS, maxRequestsPerMinute: 120, maxSseConnections: 2 },
      // Capabilities must not depend on an optional OpenClaw model lookup.
      // Its independently authorized status endpoint carries that information.
      gateway: { statusVisible: principal.scopes.includes('models:read'), opsAllowed: principal.scopes.includes('models:write'), version: deps.config.connector.gatewayVersion },
      update: await updateAuthority.run(c.req.raw, 'status', operator => updateService.status(false, operator.check)),
    };
    return c.json(capabilities);
  });

  app.get(`${base}/gateway/model-set`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'models:read');
    if (!principal) return c.json({ error: 'missing models:read scope' }, 403);
    return c.json(await readGatewayModelSetStatus(deps.config));
  });

  app.post(`${base}/gateway/model-set/reconcile`, async (c) => {
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    const evidence = new Request('http://connector.example.invalid/', { headers: { authorization } });
    const principal = requireScope(evidence, deps.tokens, 'models:write');
    if (!principal) return c.json({ error: 'missing models:write scope' }, 403);
    const checkWriteAuthority = () => {
      if (c.req.raw.signal.aborted) throw new HTTPException(408, { message: 'Request aborted' });
      if (requireScope(evidence, deps.tokens, 'models:write')?.tokenId !== principal.tokenId) {
        throw new HTTPException(403, { message: 'missing models:write scope' });
      }
    };
    const body = await readJsonBody(c.req.raw, 8192) as { setId?: unknown; dryRun?: unknown };
    try {
      checkWriteAuthority();
    } catch (error) {
      if (error instanceof HTTPException) {
        return c.json({ error: error.status === 403 ? 'missing models:write scope' : 'Connector unavailable' }, error.status as 403 | 408);
      }
      throw error;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'JSON object required' }, 400);
    if (body.setId !== AOD_MODEL_SET_ID) return c.json({ error: 'unsupported model set' }, 400);
    if (Object.prototype.hasOwnProperty.call(body, 'models') || Object.prototype.hasOwnProperty.call(body, 'aliases')) return c.json({ error: 'arbitrary model lists are not accepted' }, 400);
    try {
      const result = await reconcileGatewayModelSet(deps.config, body.dryRun === true, { checkWriteAuthority });
      checkWriteAuthority();
      return c.json(result);
    } catch (error) {
      if (error instanceof HTTPException) {
        return c.json({ error: error.status === 403 ? 'missing models:write scope' : 'Connector unavailable' }, error.status as 403 | 408);
      }
      return c.json({ error: deps.normalizeError(error) }, 400);
    }
  });

  const antigravityModels = deps.config.antigravity && !deps.config.antigravity.modelChoices
    ? createAntigravityModelsReader(deps.config.antigravity)
    : undefined;

  app.get(`${base}/models/:runtime`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'models:read');
    if (!principal) return c.json({ error: 'missing models:read scope' }, 403);
    c.header('Cache-Control', 'no-store');
    let models: Array<{ id: string; label: string }>;
    const runtime = c.req.param('runtime');
    try {
      if (runtime === 'codex' && deps.codex?.enabled) {
        const configured = deps.config.codex.modelChoices ?? [];
        // Native OpenAI catalog is not a promise of availability in a custom provider.
        const ids = [...new Set([...configured, deps.config.codex.defaultModel].filter(Boolean))];
        models = configured.length || deps.config.codex.modelProvider
          ? ids.map(id => ({ id, label: id })) : await deps.codex.listModels();
        for (const id of ids) if (!models.some(model => model.id === id)) models = [...models, { id, label: id }];
      } else if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
        if (principal.scopes.includes('execution:delegate') || c.req.header('x-agentopsdeck-execution-grant')) {
          return c.json({ error: 'SDK model discovery requires owner authority' }, 403);
        }
        const settings = runtime === 'claude-code' ? deps.config.claude : runtime === 'ghcp' ? deps.config.copilot : deps.config.antigravity;
        if (!settings || !sdk(runtime)) return c.json({ error: 'Model catalog unavailable for this runtime' }, 404);
        // Configured choices are not a claim of provider authentication.
        if (runtime === 'antigravity' && antigravityModels) {
          try {
            models = await antigravityModels();
          } catch {
            models = sdkModelChoices(settings.model ?? 'default', settings.modelChoices).map(id => ({ id, label: id }));
          }
        } else {
          models = sdkModelChoices(settings.model ?? 'default', settings.modelChoices).map(id => ({ id, label: id }));
        }
      } else if (runtime === 'openclaw') {
        models = (await readGatewayModelSetStatus(deps.config)).observed.map(model => ({ id: model.alias, label: model.alias }));
      } else return c.json({ error: 'Model selection is unavailable for this runtime' }, 404);
      if (!deps.tokens.hasScope(principal.tokenId, 'models:read')) return c.json({ error: 'Model access was revoked' }, 403);
      return c.json({ models });
    } catch { return c.json({ error: 'Model catalog unavailable; retry when the runtime is ready' }, 503); }
  });

  const updateRoutes = registerConnectorUpdates(app, base, { config: deps.config, service: updateService,
    authority: updateAuthority, normalizeError: deps.normalizeError });

  // An independent supervisor needs admission fencing, not artifact-selection
  // authority. Legacy update callers retain their existing boundary. Lifecycle
  // callers must explicitly bind protocol + node and cannot come from browsers.
  const admissionPrincipal = (request: Request) => {
    const updater = requireScope(request, deps.tokens, 'connector:update');
    if (updater) return updater;
    if (request.headers.has('Origin') || request.headers.get(CONNECTOR_PROTOCOL_HEADER) !== '1'
      || request.headers.get(EXPECTED_NODE_HEADER) !== deps.connectorUsers.nodeId) return undefined;
    return requireScope(request, deps.tokens, 'connector:lifecycle');
  };
  const storageRoutes = !deps.control ? registerStorageDiagnostics(app, `${base}/maintenance/storage`, {
    authorize: context => {
      const principal = admissionPrincipal(context.req.raw);
      if (!principal) throw new HTTPException(403);
      const check = () => { if (closed || admissionPrincipal(context.req.raw)?.tokenId !== principal.tokenId) throw new HTTPException(403); };
      check(); return check;
    },
    recovery: () => deps.connectorUsers.storageRecovery(),
    stats: () => deps.connectorUsers.storageStats(), checkpoint: check => deps.connectorUsers.checkpointStorage(check), history: historyDiagnostics,
  }) : undefined;


  registerConnectorTokenRoutes(app, deps);

  app.get(`${base}/sessions/directory`, async c => {
    c.header('Cache-Control', 'no-store');
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:read');
    if (!principal) return c.json({ error: 'missing sessions:read scope' }, 403);
    let query;
    try { query = parseSessionDirectoryQuery(new URL(c.req.url).searchParams); }
    catch { return c.json({ error: 'Invalid session directory query' }, 400); }
    try {
      return c.json(await snapshotResponse(c, principal.tokenId, 'sessions:read', cursor => deps.store.getSessionDirectory(query, cursor ?? '')));
    } catch (error) { return snapshotError(c, error, 'Session directory unavailable'); }
  });

  app.get(`${base}/sessions/state`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:read');
    if (!principal) return c.json({ error: 'missing sessions:read scope' }, 403);
    const includeHidden = c.req.query('includeHidden') === '1' || c.req.query('includeHidden') === 'true';
    const includeArchived = c.req.query('includeArchived') === '1' || c.req.query('includeArchived') === 'true';
    try {
      await Promise.all([
        deps.refreshSessions({ maxAgeMs: 2_000 }),
        deps.codex?.refreshSessions({ maxAgeMs: 2_000 }),
      ]);
      // The first runtime can be invalidated while the other is still reading.
      // Recheck current proof and authority with no await before publishing.
      if (!requireScope(c.req.raw, deps.tokens, 'sessions:read')) return c.json({ error: 'missing sessions:read scope' }, 403);
      if (!deps.sessionSnapshotReady()) throw new Error('Session snapshot invalidated');
    } catch { return c.json({ error: 'Session snapshot unavailable' }, 503); }
    try {
      const body = await snapshotResponse(c, principal.tokenId, 'sessions:read', cursor => {
        if (!deps.sessionSnapshotReady()) throw new Error('Session snapshot invalidated');
        return { ...deps.store.getSessionsState({ includeHidden, includeArchived }), sourceCursor: cursor, connector: connectorMeta(deps.config) };
      });
      if (!deps.sessionSnapshotReady()) throw new Error('Session snapshot invalidated');
      return c.json(body);
    } catch (error) { return snapshotError(c, error, 'Session snapshot unavailable'); }
  });

  app.patch(`${base}/sessions/:sessionKey/archive`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
    if (!principal) return c.json({ error: 'missing sessions:create scope' }, 403);
    const sessionKey = c.req.param('sessionKey');
    const body = await readPreferenceBody(c.req.raw) as { archived?: boolean };
    const archived = body.archived !== false;
    if (c.req.raw.signal.aborted) return c.json({ error: 'Request cancelled' }, 408);
    if (requireScope(c.req.raw, deps.tokens, 'sessions:create')?.tokenId !== principal.tokenId) return c.json({ error: 'missing sessions:create scope' }, 403);
    if (archived) deps.store.archiveSession(sessionKey);
    else deps.store.unarchiveSession(sessionKey);
    return c.json({ ok: true, sessionKey, archived, updatedAt: Date.now() });
  });

  app.patch(`${base}/sessions/:sessionKey/pin`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
    if (!principal) return c.json({ error: 'missing sessions:create scope' }, 403);
    const sessionKey = c.req.param('sessionKey');
    const body = await readPreferenceBody(c.req.raw) as { pinned?: boolean };
    const pinned = body.pinned !== false;
    if (c.req.raw.signal.aborted) return c.json({ error: 'Request cancelled' }, 408);
    if (requireScope(c.req.raw, deps.tokens, 'sessions:create')?.tokenId !== principal.tokenId) return c.json({ error: 'missing sessions:create scope' }, 403);
    if (pinned) deps.store.pinSession(sessionKey);
    else deps.store.unpinSession(sessionKey);
    return c.json({ ok: true, sessionKey, pinned, updatedAt: Date.now() });
  });

  registerDeletionReceipts(app, `${base}/sessions/:sessionKey`, {
    receipts: deps.connectorUsers.commands,
    deletionAdmission: c => deps.connectorUsers.canDeleteSession(c.req.param('sessionKey')!),
    scope: c => {
      const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
      if (!principal) throw new HTTPException(403, { message: 'missing sessions:create scope' });
      return JSON.stringify([principal.tokenId, c.req.param('sessionKey')]);
    },
  });
  app.delete(`${base}/sessions/:sessionKey`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
    if (!principal) return c.json({ error: 'missing sessions:create scope' }, 403);
    const sessionKey = c.req.param('sessionKey');
    const authorize = () => {
      c.req.raw.signal.throwIfAborted();
      if (!deps.tokens.hasScope(principal.tokenId, 'sessions:create')) throw new TurnAuthorizationError();
      if (!deps.connectorUsers.canDeleteSession(sessionKey)) throw new SessionDeletionConflict();
    };
    try {
      return c.json(await deleteConnectorSession(deps, sessionKey, authorize,
        body => c.get('acknowledgeDeletion')({ status: 200, body })));
    } catch (error) {
      if (error instanceof SessionDeletionConflict) return c.json({ error: error.message }, 409);
      if (error instanceof TurnAuthorizationError) return c.json({ error: 'session authorization changed' }, 403);
      return c.json({ error: deps.normalizeError(error) }, 502);
    }
  });

  registerSessionSettingsRoutes(app, `${base}/sessions/:sessionKey`, {
    ...deps, receipts: deps.connectorUsers.commands, sessionKey: c => c.req.param('sessionKey')!,
    sdkSettingsAdmission: key => {
      const owned = sdk(sessionRuntimeId(key));
      if (!owned?.ready) throw new HTTPException(409, { message: 'Agent is not ready; settings were not changed' });
      owned.commands.assertSettingsAvailable(key);
    },
    sdkModelUpdate: (key, model, authorize, acknowledge) => {
      const runtime = sessionRuntimeId(key), owned = sdk(runtime);
      const settings = runtime === 'claude-code' ? deps.config.claude : runtime === 'ghcp' ? deps.config.copilot : deps.config.antigravity;
      if (!owned?.ready || !settings) throw new HTTPException(409, { message: 'Agent is not ready; settings were not changed' });
      const policy = runtime === 'antigravity' && !settings.modelChoices
        ? { model: settings.model ?? 'default', dynamicModels: true }
        : { model: settings.model ?? 'default', ...(settings.modelChoices ? { modelChoices: settings.modelChoices } : {}) };
      if (model !== null && !sdkModelAllowed(policy, model)) {
        throw new HTTPException(400, { message: 'Model is not in this Connector catalog' });
      }
      owned.commands.updateModel(key, model, authorize, acknowledge);
    },
    settingsAdmission: key => deps.connectorUsers.canChangeSettings(key),
    actor: c => {
      const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
      if (!principal) throw new HTTPException(403, { message: 'Missing sessions:create scope' });
      return principal.tokenId;
    },
  });

  app.get(`${base}/sessions/:sessionKey/state`, async c => {
    c.header('Cache-Control', 'no-store');
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:read');
    if (!principal) return c.json({ error: 'missing messages:read scope' }, 403);
    try {
      const key = c.req.param('sessionKey');
      const session = await snapshotResponse(c, principal.tokenId, 'messages:read', cursor => deps.connectorUsers.commands.sessionDeletion(key)
        ? undefined : deps.store.getSessionExecution(key, cursor ?? ''));
      return session && deps.store.getSession(key) && !deps.connectorUsers.commands.sessionDeletion(key)
        ? c.json(session) : c.json({ error: 'session not found' }, 404);
    } catch (error) { return snapshotError(c, error, 'Session state unavailable'); }
  });

  for (const exporting of [false, true]) app.get(`${base}/sessions/:sessionKey/token-usage${exporting ? '/export' : ''}`, c => {
    c.header('Cache-Control', 'no-store');
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:read');
    if (!principal || principal.scopes.includes('execution:delegate') || c.req.header('x-agentopsdeck-execution-grant')) return c.json({ error: 'Token usage requires owner authority' }, 403);
    executionActor(c);
    const key = c.req.param('sessionKey'), runtime = sessionRuntimeId(key);
    if (runtime !== 'codex' && runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity') return c.json({ error: 'Unsupported runtime' }, 409);
    const exists = runtime === 'codex' ? deps.store.getSession(key) : sdkJournal(runtime).session(key);
    if (!exists || deps.connectorUsers.commands.sessionDeletion(key)) return c.json({ error: 'session not found' }, 404);
    let range;
    try { range = tokenUsageRange(c.req.query('from'), c.req.query('to'), c.req.query('bucketMs')); }
    catch { return c.json({ error: 'Invalid token usage range' }, 400); }
    try {
      return c.json(exporting ? deps.connectorUsers.tokenUsage.export(runtime, key, range.from, range.to, range.bucketMs)
        : deps.connectorUsers.tokenUsage.range(runtime, key, range.from, range.to, range.bucketMs));
    } catch (error) {
      if (error instanceof NativeTokenExportTooLarge) return c.json({ error: 'Shorten the token export period', code: 'token_export_limit' }, 413);
      throw error;
    }
  });
  for (const creating of [false, true]) app.on(creating ? 'POST' : 'GET', `${base}/sessions/:sessionKey/token-usage/snapshots${creating ? '' : '/:requestId'}`, async c => {
    c.header('Cache-Control', 'no-store');
    const authorized = () => {
      const principal = requireScope(c.req.raw, deps.tokens, 'messages:read');
      return principal && !principal.scopes.includes('execution:delegate') && !c.req.header('x-agentopsdeck-execution-grant') ? principal : undefined;
    };
    const principal = authorized();
    if (!principal) return c.json({ error: 'Token snapshots require owner authority' }, 403);
    executionActor(c);
    let selection, requestId;
    if (creating) {
      const raw = await readJsonBody(c.req.raw, 1024);
      try { selection = tokenSnapshotSelection(raw); requestId = selection.requestId; }
      catch { return c.json({ error: 'Invalid token snapshot selection' }, 400); }
    } else {
      try { requestId = tokenSnapshotRequestId(c.req.param('requestId')); }
      catch { return c.json({ error: 'Invalid token snapshot request ID' }, 400); }
    }
    if (authorized()?.tokenId !== principal.tokenId) return c.json({ error: 'Owner authority revoked' }, 403);
    if (c.req.raw.signal.aborted) return c.json({ error: 'Request interrupted' }, 408);
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    if (runtime !== 'codex' && runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity') return c.json({ error: 'Unsupported runtime' }, 409);
    const exists = runtime === 'codex' ? deps.store.getSession(key) : sdkJournal(runtime).session(key);
    if (!exists || deps.connectorUsers.commands.sessionDeletion(key)
      || runtime !== 'codex' && sdkJournal(runtime).deletion(key)?.phase === 'deleted') return c.json({ error: 'session not found' }, 404);
    const guard = () => {
      if (closed || authorized()?.tokenId !== principal.tokenId) throw new HTTPException(403, { message: 'Owner authority revoked' });
      if (c.req.raw.signal.aborted) throw new HTTPException(408, { message: 'Request interrupted' });
      if (!(runtime === 'codex' ? deps.store.getSession(key) : sdkJournal(runtime).session(key))
        || deps.connectorUsers.commands.sessionDeletion(key)
        || runtime !== 'codex' && sdkJournal(runtime).deletion(key)?.phase === 'deleted') throw new HTTPException(404, { message: 'session not found' });
    };
    try {
      const result = selection ? await deps.connectorUsers.tokenUsage.snapshotAsync(runtime, key, requestId, selection.from, selection.to, selection.bucketMs, guard)
        : deps.connectorUsers.tokenUsage.readSnapshot(runtime, key, requestId);
      guard();
      return result ? c.json(result) : c.json({ error: 'snapshot not found' }, 404);
    } catch (error) {
      if (error instanceof NativeTokenSnapshotConflict) return c.json({ error: 'Snapshot selection conflict' }, 409);
      if (error instanceof NativeTokenSnapshotLimit || error instanceof NativeTokenExportTooLarge) return c.json({ error: 'Token snapshot capacity exceeded' }, 413);
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Token snapshot admission unavailable' }, 503);
      throw error;
    }
  });
  const conditionalHistory = createConditionalHistory();
  const prepareHistory = createHistoryPreparation();
  app.get(`${base}/sessions/:sessionKey/skills`, async c => {
    c.header('Cache-Control', 'no-store');
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:read');
    if (!principal) return c.json({ error: 'missing messages:read scope' }, 403);
    // Discovery exposes workspace metadata, not shared transcript content.
    // Do not inherit a delegated/shared execution proof for this new surface.
    if (principal.scopes.includes('execution:delegate') || c.req.header('x-agentopsdeck-execution-grant')) return c.json({ error: 'Skill discovery requires owner authority' }, 403);
    const key = c.req.param('sessionKey');
    executionActor(c);
    if (sessionRuntimeId(key) !== 'codex' || !deps.codex?.enabled) return c.json({ error: 'Skill discovery is unavailable for this runtime' }, 409);
    if (!deps.store.getSession(key) || deps.connectorUsers.commands.sessionDeletion(key)) return c.json({ error: 'session not found' }, 404);
    try {
      c.req.raw.signal.throwIfAborted();
      const result = await deps.codex.listSessionSkills(key);
      if (!deps.tokens.hasScope(principal.tokenId, 'messages:read')) return c.json({ error: 'Skill access was revoked' }, 403);
      executionActor(c);
      if (!deps.store.getSession(key) || deps.connectorUsers.commands.sessionDeletion(key)) return c.json({ error: 'session not found' }, 404);
      c.req.raw.signal.throwIfAborted();
      return c.json(result);
    } catch { return c.json({ error: 'Skill discovery unavailable; this Codex may not support skills/list' }, 503); }
  });
  app.get(`${base}/sessions/:sessionKey/files`, c => {
    c.header('Cache-Control', 'no-store');
    if (!requireScope(c.req.raw, deps.tokens, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
    const key = c.req.param('sessionKey'), runtime = sessionRuntimeId(key);
    executionActor(c);
    if (deps.connectorUsers.commands.sessionDeletion(key)) return c.json({ error: 'session not available' }, 404);
    const exists = runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? sdkJournal(runtime).session(key) : deps.store.getSession(key);
    if (!exists) return c.json({ error: 'session not found' }, 404);
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && (!cursor.length || cursor.length > 1024)) return c.json({ error: 'Invalid file cursor' }, 400);
    try { return c.json({ ...deps.connectorUsers.fileIndex.page(key, cursor,
      runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? sdkJournal(runtime).session(key)?.nativeSessionId : undefined),
      ...((runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' || runtime === 'codex' && deps.connectorUsers.fileIndex.projectionBinding(key))
        ? { rebuildAvailable: true } : {}) }); }
    catch (error) {
      if (error instanceof FileIndexCursorError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  const rebuildFiles = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    if (!requireScope(c.req.raw, deps.tokens, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
    const initial = executionActor(c);
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key), id = c.req.param('jobId');
    if (runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity' && runtime !== 'codex') return c.json({ error: 'Historical file rebuild is not supported for this runtime' }, 409);
    let step = 0;
    if (id && c.req.method === 'POST') {
      const body = await readJsonBody(c.req.raw, 256);
      if (!body || typeof body !== 'object' || !('step' in body) || !Number.isSafeInteger(body.step)
        || Number(body.step) < 0 || Number(body.step) > 10_000) return c.json({ error: 'Invalid file rebuild step' }, 400);
      step = Number(body.step);
    }
    // Body I/O can race revocation. All following work is synchronous and bounded.
    const current = executionActor(c);
    const actor = (value: typeof current) => JSON.stringify([value.principal.tokenId, value.actorId, value.executionGrant?.id]);
    if (actor(initial) !== actor(current) || !requireScope(c.req.raw, deps.tokens, 'messages:read')) return c.json({ error: 'File rebuild authority changed' }, 403);
    if (c.req.raw.signal.aborted) return c.json({ error: 'Request interrupted' }, 408);
    try {
      return c.json(!id ? fileRebuilds.start(key, actor(current)) : c.req.method === 'DELETE'
        ? fileRebuilds.cancel(key, actor(current), id) : fileRebuilds.step(key, actor(current), id, step));
    } catch (error) {
      if (error instanceof FileRebuildError) return c.json({ error: error.message }, error.status);
      return c.json({ error: 'File index rebuild unavailable' }, 503);
    }
  };
  app.post(`${base}/sessions/:sessionKey/files/rebuild`, rebuildFiles);
  app.post(`${base}/sessions/:sessionKey/files/rebuild/:jobId`, rebuildFiles);
  app.delete(`${base}/sessions/:sessionKey/files/rebuild/:jobId`, rebuildFiles);
  app.use(`${base}/sessions/:sessionKey/messages`, historyDiagnostics.middleware());
  app.get(`${base}/sessions/:sessionKey/messages`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:read');
    if (!principal) return c.json({ error: 'missing messages:read scope' }, 403);
    const sessionKey = c.req.param('sessionKey');
    const before = c.req.query('before');
    if (before !== undefined && (!before.length || before.length > 4096)) return c.json({ error: 'Invalid history anchor' }, 400);
    const runtime = sessionRuntimeId(sessionKey);
    if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
      if (!sdkJournal(runtime).session(sessionKey)) return c.json({ error: 'session not found' }, 404);
      try {
        const body = await snapshotResponse(c, principal.tokenId, 'messages:read', cursor => {
          if (!sdkJournal(runtime).session(sessionKey) || sdkJournal(runtime).deletion(sessionKey)
            || deps.connectorUsers.commands.sessionDeletion(sessionKey)) throw new HTTPException(404, { res: Response.json({ error: 'session not found' }, { status: 404 }) });
          const page = timeHistorySync('page', () => (runtime === 'claude-code' ? claudeHistoryPage : runtime === 'ghcp' ? copilotHistoryPage : antigravityHistoryPage)(deps.connectorUsers, sessionKey, Math.min(200, clampMessageLimit(c.req.query('limit'))), before));
          return page ? { ...page, updatedAt: Date.now(), revision: stableGatewayRowsRevision(page.messages),
            sourceCursor: cursor, limits: { maxMessageChars: MAX_MESSAGE_CHARS } } : null;
        });
        if (!sdkJournal(runtime).session(sessionKey) || sdkJournal(runtime).deletion(sessionKey)
          || deps.connectorUsers.commands.sessionDeletion(sessionKey)) return c.json({ error: 'session not found' }, 404);
        return body ? conditionalHistory(c, body) : c.json({ error: 'History anchor unavailable; refresh history' }, 409);
      } catch (error) { return snapshotError(c, error, 'SDK history unavailable'); }
    }
    // Older pages belong to the already-hydrated projection. Re-reading every
    // native turn (and re-projecting attachments) for each page is both costly
    // and unnecessary. Cold/invalidated/reconciling projections still hydrate.
    const cachedPage = before !== undefined && deps.historySnapshotReady(sessionKey)
      && deps.store.hasMessage(sessionKey, before);
    const read = () => withoutHistoryDiagnostics(() => deps.refreshMessages(sessionKey, { maxAgeMs: 1_500, readOnly: true }));
    const asynchronous = c.req.header(HISTORY_ASYNC_HEADER) === '1';
    const outcome = cachedPage ? 'ready' : await timeHistoryAsync('hydrateWait', () => asynchronous
      ? prepareHistory(sessionKey, read, () => deps.historySnapshotReady(sessionKey), c.req.raw.signal)
      : read().then(() => 'ready', () => 'failed'));
    if (!deps.tokens.hasScope(principal.tokenId, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
    c.req.raw.signal.throwIfAborted();
    // Preparation and the HTTP continuation are separate promise jobs. A new
    // runtime-owned reconciliation can invalidate a successful read between
    // them. Do not publish stale rows or misreport that handoff as a source error.
    if (outcome === 'pending' || (asynchronous && outcome === 'ready' && !deps.historySnapshotReady(sessionKey))) {
      c.header('Retry-After', '1');
      return c.json(historyPendingBody(), 202);
    }
    if (outcome !== 'ready' || !deps.historySnapshotReady(sessionKey)) return c.json({ error: 'Session history unavailable' }, 503);
    try {
      const body = await snapshotResponse(c, principal.tokenId, 'messages:read', cursor => {
        if (deps.connectorUsers.commands.sessionDeletion(sessionKey)) throw new HTTPException(404, { res: Response.json({ error: 'session not found' }, { status: 404 }) });
        if (!deps.historySnapshotReady(sessionKey)) throw new Error('History snapshot invalidated');
        const page = timeHistorySync('page', () => deps.store.getMergedMessageHistoryPage(sessionKey, clampMessageLimit(c.req.query('limit')), before));
        if (!page) return null;
        const messages = timeHistorySync('page', () => page.messages.map(summarizeToolMessage));
        return { ...page, messages, updatedAt: Date.now(), revision: stableGatewayRowsRevision(messages), sourceCursor: cursor, limits: { maxMessageChars: MAX_MESSAGE_CHARS } };
      });
      if (deps.connectorUsers.commands.sessionDeletion(sessionKey)) return c.json({ error: 'session not found' }, 404);
      if (!deps.historySnapshotReady(sessionKey)) throw new Error('History snapshot invalidated');
      return body ? conditionalHistory(c, body) : c.json({ error: 'History anchor unavailable; refresh history' }, 409);
    } catch (error) { return snapshotError(c, error, 'Session history unavailable'); }
  });

  app.get(`${base}/sessions/:sessionKey/messages/:messageId`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:read');
    if (!principal) return c.json({ error: 'missing messages:read scope' }, 403);
    const sessionKey = c.req.param('sessionKey');
    const cached = deps.historySnapshotReady(sessionKey) && deps.store.hasMessage(sessionKey, c.req.param('messageId'));
    const runtime = sessionRuntimeId(sessionKey);
    if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
      try {
        const body = await snapshotResponse(c, principal.tokenId, 'messages:read', cursor => {
          if (!sdkJournal(runtime).session(sessionKey) || sdkJournal(runtime).deletion(sessionKey)
            || deps.connectorUsers.commands.sessionDeletion(sessionKey)) return null;
          const message = (runtime === 'claude-code' ? claudeHistoryMessage : runtime === 'ghcp' ? copilotHistoryMessage : antigravityHistoryMessage)(deps.connectorUsers, sessionKey, c.req.param('messageId'));
          return message ? { message, updatedAt: Date.now(), sourceCursor: cursor } : null;
        });
        if (!sdkJournal(runtime).session(sessionKey) || sdkJournal(runtime).deletion(sessionKey)
          || deps.connectorUsers.commands.sessionDeletion(sessionKey)) return c.json({ error: 'message not found' }, 404);
        return body ? c.json(body) : c.json({ error: 'message not found' }, 404);
      } catch (error) { return snapshotError(c, error, 'Agent history unavailable'); }
    }
    const refreshed = cached || await deps.refreshMessages(sessionKey, { maxAgeMs: 1_500, readOnly: true }).then(() => true, () => false);
    if (!deps.tokens.hasScope(principal.tokenId, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
    c.req.raw.signal.throwIfAborted();
    if (!refreshed || !deps.historySnapshotReady(sessionKey)) return c.json({ error: 'Session history unavailable' }, 503);
    const message = deps.store.getMessage(sessionKey, c.req.param('messageId'));
    if (!message) return c.json({ error: 'message not found' }, 404);
    let detail;
    try { detail = await readIndexedToolMessage(message); }
    catch {
      if (!deps.tokens.hasScope(principal.tokenId, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
      c.req.raw.signal.throwIfAborted();
      return c.json({ error: 'Tool detail source changed; refresh history' }, 409);
    }
    // On-demand disk reads yield: authority, deletion and projection identity
    // must still hold before exposing the body. Never overwrite the summary.
    if (!deps.tokens.hasScope(principal.tokenId, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
    c.req.raw.signal.throwIfAborted();
    if (!deps.historySnapshotReady(sessionKey)
      || deps.store.getMessage(sessionKey, message.id) !== message) {
      return c.json({ error: 'Tool detail projection changed; retry' }, 409);
    }
    try {
      const current = () => !deps.connectorUsers.commands.sessionDeletion(sessionKey) && deps.historySnapshotReady(sessionKey)
        && deps.store.getMessage(sessionKey, message.id) === message;
      const body = await snapshotResponse(c, principal.tokenId, 'messages:read', cursor => current()
        ? { message: detail, updatedAt: Date.now(), sourceCursor: cursor } : null);
      return body && current() ? c.json(body) : c.json({ error: 'Tool detail projection changed; retry' }, 409);
    } catch (error) { return snapshotError(c, error, 'Tool detail snapshot unavailable'); }
  });

  registerQueueRoutes(app, `${base}/sessions/:sessionKey`, { actor: executionActor, users: deps.connectorUsers,
    store: deps.store, codex: deps.codex, hermes: deps.hermes, claude: deps.claude, copilot: deps.copilot, antigravity: deps.antigravity, openclaw: deps.openclawQueue });

  registerCompactReceipts(app, `${base}/sessions/:sessionKey`, {
    receipts: deps.connectorUsers.commands,
    scope: (c, write) => {
      if (!requireScope(c.req.raw, deps.tokens, write ? 'messages:send' : 'messages:read')) throw new HTTPException(403);
      const actor = executionActor(c, write ? 'runs:compact' : undefined);
      if (actor.executionGrant || actor.actorId.startsWith('actor_')) throw new HTTPException(403);
      return JSON.stringify([actor.actorId, c.req.param('sessionKey')]);
    },
  });
  app.post(`${base}/sessions/:sessionKey/compact`, async c => {
    const sessionKey = c.req.param('sessionKey'), runtime = sessionRuntimeId(sessionKey), owned = sdk(runtime);
    if (runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity') return c.json({ error: 'Dedicated compact control is not supported for this runtime' }, 409);
    if (!owned?.ready) return c.json({ error: 'Agent is not ready; command was not admitted', code: 'agent_not_ready' }, 409);
    if (!sdkJournal(runtime).session(sessionKey)) return c.json({ error: 'session not found' }, 404);
    // registerCompactReceipts has already consumed and strictly validated the
    // bounded body. Reading the Request again fails on the real HTTP server.
    try {
      const actor = executionActor(c, 'runs:compact');
      const scope = JSON.stringify(['compact', JSON.stringify([actor.actorId, sessionKey])]);
      const result = owned.commands.compact(sessionKey, { ...actor, signal: c.req.raw.signal,
        accept: result => db => {
          if (!requireScope(c.req.raw, deps.tokens, 'messages:send') || executionActor(c, 'runs:compact').actorId !== actor.actorId) throw new TurnAuthorizationError();
          deps.connectorUsers.commands.queueCommit(scope, c.get('commandKey'), { status: 200, body: { ok: true, ...result } })(db);
        },
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ error: 'Compaction was not admitted; session must be ready and queue empty' },
        error instanceof TurnAuthorizationError ? 403 : error instanceof SessionDeletionConflict ? 409 : 503);
    }
  });

  app.post(`${base}/sessions/:sessionKey/messages`, async (c, next) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:send');
    if (!principal) throw new HTTPException(403);
    const actor = executionActor(c).actorId;
    const body = await readJsonBody(c.req.raw, MAX_TOTAL_MEDIA_BYTES * 4 / 3 + MAX_TEXT_MESSAGE_BODY_BYTES);
    if (requireScope(c.req.raw, deps.tokens, 'messages:send')?.tokenId !== principal.tokenId || executionActor(c).actorId !== actor) throw new HTTPException(403);
    c.req.bodyCache.json = Promise.resolve(body);
    await next();
  });
  registerMessageReceipts(app, `${base}/sessions/:sessionKey`, {
    queue: (c, key) => {
      const actor = executionActor(c), sessionKey = c.req.param('sessionKey')!;
      return deps.connectorUsers.turns.commandState(sessionRuntimeId(sessionKey), sessionKey, key, actor.actorId);
    },
    receipts: deps.connectorUsers.commands,
    scope: (c, write) => {
      const actor = requireScope(c.req.raw, deps.tokens, write ? 'messages:send' : 'messages:read');
      if (!actor) throw new HTTPException(403, { message: 'Missing message scope' });
      return JSON.stringify([executionActor(c).actorId, c.req.param('sessionKey')]);
    },
  });
  app.post(`${base}/sessions/:sessionKey/messages`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'messages:send');
    if (!principal) return c.json({ error: 'missing messages:send scope' }, 403);
    const sessionKey = c.req.param('sessionKey');
    const rawBody = await c.req.json().catch(() => ({}));
    const validated = normalizeSendMessageRequest(rawBody);
    if ('error' in validated) return c.json({ error: validated.error }, 400);
    const action = validated.message.trim() === '/stop' ? 'runs:interrupt' : 'messages:send';
    const actor = executionActor(c, action);
    const mirror = validated.deliveryMode === 'mirror';
    const explicitRoute = mirror ? resolveExplicitChannelRoute(sessionKey, deps.config.defaultAgentId) : undefined;
    const authorizeMirror = () => {
      if (!mirror) return;
      if (actor.actorId !== 'local:daily' && !requireScope(c.req.raw, deps.tokens, 'messages:mirror')) {
        throw new HTTPException(403, { res: c.json({ error: 'missing messages:mirror scope' }, 403) });
      }
      executionActor(c, 'messages:mirror');
    };
    if (mirror && (sessionRuntimeId(sessionKey) !== 'openclaw' || deps.codex?.owns(sessionKey)
      || ['/stop', '/status', '/compact'].includes(validated.message.trim()))) {
      return c.json({ error: 'Mirror requires an ordinary OpenClaw message' }, 409);
    }
    if (mirror && !explicitRoute) return c.json({ error: 'Mirror requires a channel-scoped session' }, 400);
    authorizeMirror();
    if (actor.executionGrant && (['/compact', '/status'].includes(validated.message.trim())
      || (!sessionKey.startsWith('codex:') && validated.message.trim() === '/stop'))) {
      return c.json({ error: 'Delegated control is not supported by this runtime protocol' }, 409);
    }
    if (!validated.media.length && validated.message.trim() === '/status') {
      if (!requireScope(c.req.raw, deps.tokens, 'messages:read')) return c.json({ error: 'missing messages:read scope' }, 403);
      const result = reportSessionStatus(deps.store, sessionKey, randomUUID(), validated.message);
      return result ? c.json(result) : c.json({ error: 'session not found' }, 404);
    }
    const runtime = sessionRuntimeId(sessionKey);
    if (runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') {
      const owned = sdk(runtime);
      // This check precedes any runtime side effect. Persist a definitive
      // rejection, not a 5xx that receipt recovery must treat as uncertain.
      // Receipt middleware still returns earlier accepted duplicates first.
      if (!owned?.ready) return c.json({ error: 'Agent is not ready; command was not admitted', code: 'agent_not_ready' }, 409);
      if (!sdkJournal(runtime).session(sessionKey)) return c.json({ error: 'session not found' }, 404);
      if (isSdkCompactCommand(validated.message)) return c.json({ error: 'Use the explicit compact control' }, 409);
      if (runtime === 'antigravity' && validated.media.length) return c.json({ error: 'Antigravity attachments are not supported' }, 409);
      if (validated.message.trim() === '/stop' && validated.media.length) return c.json({ error: 'Stop control does not accept attachments' }, 400);
      let attachments;
      try { attachments = prepareSdkAttachments(validated.media); }
      catch { return c.json({ error: 'SDK attachments: PNG/JPEG/GIF/WebP or UTF-8 text/data only; up to 8 files, 5 MiB each, 20 MiB total' }, 400); }
      try {
        if (validated.message.trim() === '/stop') {
          const expected = requireExpectedRun(validated.expectedRunId);
          const outcome = await owned.commands.interrupt(sessionKey, expected, actor);
          if (outcome === 'unknown') return reply(c, deps.connectorUsers.commands.get(JSON.stringify([actor.actorId, sessionKey]), c.get('commandKey'))!);
          return c.json({ ok: true, status: 'interrupt_requested', runId: expected, idempotencyKey: c.get('commandKey'), media: [] });
        }
        return c.json({ ok: true, ...await owned.commands.sendAsync(sessionKey, validated.message, {
          ...actor, signal: c.req.raw.signal,
          accept: result => deps.connectorUsers.commands.queueCommit(JSON.stringify([actor.actorId, sessionKey]),
            c.get('commandKey'), { status: 200, body: { ok: true, ...result } }),
        }, attachments) });
      } catch (error) {
        return c.json({ error: 'Agent command unavailable' }, error instanceof TurnAuthorizationError ? 403 : error instanceof RunControlConflict || error instanceof SessionDeletionConflict ? 409 : 503);
      }
    }
    if (sessionRuntimeId(sessionKey) === 'hermes') {
      if (!deps.hermes?.ready) return c.json({ error: 'Hermes is not ready' }, 503);
      if (!deps.store.getSession(sessionKey)) return c.json({ error: 'session not found' }, 404);
      if (validated.media.length || validated.message.trim() === '/compact') return c.json({ error: 'Hermes attachments and compaction are not supported yet' }, 409);
      try {
        if (validated.message.trim() === '/stop') {
          const expected = requireExpectedRun(validated.expectedRunId);
          await deps.hermes.interrupt(sessionKey, expected, actor.actorId, actor.executionGrant);
          return c.json({ ok: true, status: 'interrupt_requested', runId: expected, idempotencyKey: c.get('commandKey'), media: [] });
        }
        return c.json({ ok: true, ...await deps.hermes.send(sessionKey, validated.message, {
          actorId: actor.actorId, signal: c.req.raw.signal, ...(actor.executionGrant ? { executionGrant: actor.executionGrant } : {}),
          accept: result => deps.connectorUsers.commands.queueCommit(JSON.stringify([actor.actorId, sessionKey]),
            c.get('commandKey'), { status: 200, body: { ok: true, ...result } }),
        }) });
      } catch (error) {
        return c.json({ error: deps.normalizeError(error) }, error instanceof TurnAuthorizationError ? 403 : error instanceof RunControlConflict || error instanceof SessionDeletionConflict ? 409 : 503);
      }
    }
    if (sessionKey.startsWith('codex:') || deps.codex?.owns(sessionKey)) {
      if (!deps.codex) return c.json({ error: 'Codex connector is not configured' }, 503);
      if (validated.media.some((item) => !(item.mimeType || item.dataUrl.match(/^data:([^;,]+);base64,/)?.[1] || '').toLowerCase().startsWith('image/'))) {
        return c.json({ error: 'Codex connector currently accepts image attachments only' }, 400);
      }
      try {
        if (validated.message.trim() === '/stop') {
          if (validated.media.length) return c.json({ error: 'Stop controls cannot include media' }, 400);
          const expected = requireExpectedRun(validated.expectedRunId);
          await deps.codex.interrupt(sessionKey, expected, actor.actorId, actor.executionGrant, () => {
            c.get('acknowledgeControl')({ status: 200, body: { ok: true, runId: expected,
              status: 'interrupt_requested', idempotencyKey: c.get('commandKey'), media: [] } });
          });
          // RPC ACK means requested, not terminal runtime completion.
          return c.json({ ok: true, runId: expected, status: 'interrupt_requested', idempotencyKey: c.get('commandKey'), media: [] });
        }
        if (deps.codex.enabled === false) return c.json({ error: 'Codex connector is disabled' }, 503);
        if (!deps.store.getSession(sessionKey)) return c.json({ error: 'session not found' }, 404);
        const uploadedMedia = await persistUploadedMedia(validated.media, { inboundDir: deps.config.inboundMediaDir });
        if (!requireScope(c.req.raw, deps.tokens, 'messages:send')) return c.json({ error: 'missing messages:send scope' }, 403);
        executionActor(c, action);
        return c.json({ ok: true, ...(await deps.codex.send(sessionKey, validated.message,
          uploadedMedia.map(({ filePath, media }) => ({ filePath, media })),
          { actorId: actor.actorId, ...(actor.executionGrant ? { executionGrant: actor.executionGrant } : {}),
            accept: (result) => {
              // Admission now waits for space: revalidate this exact HTTP
              // principal before committing queue and receipt together.
              if (c.req.raw.signal.aborted || !requireScope(c.req.raw, deps.tokens, 'messages:send')
                || executionActor(c, action).actorId !== actor.actorId) throw new TurnAuthorizationError();
              return deps.connectorUsers.commands.queueCommit(JSON.stringify([actor.actorId, sessionKey]),
                c.get('commandKey'), { status: 200, body: { ok: true, ...result } });
            } })) });
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'queue admission unavailable' }, 503);
        return c.json({ error: deps.normalizeError(error) }, error instanceof RunControlConflict || error instanceof SessionDeletionConflict ? 409 : error instanceof TurnAuthorizationError ? 403 : 502);
      }
    }
    if (validated.message.trim() === '/stop') {
      if (validated.media.length) return c.json({ error: 'Stop controls cannot include media' }, 400);
      try {
        const runId = await interruptOpenClawRun({ sessionKey, expectedRunId: validated.expectedRunId,
          executions: deps.connectorUsers.openClawExecutions, gateway: deps.gateway,
          authorize: () => { executionActor(c, 'runs:interrupt'); } });
        return c.json({ ok: true, runId, status: 'interrupt_requested', idempotencyKey: c.get('commandKey'), media: [] });
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        return c.json({ error: deps.normalizeError(error) }, error instanceof RunControlConflict ? 409 : 502);
      }
    }
    if (validated.expectedRunId !== undefined) return c.json({ error: 'Run identity is only supported for stop controls' }, 409);
    const uploadedMedia = await persistUploadedMedia(validated.media, { inboundDir: deps.config.inboundMediaDir });
    if (!requireScope(c.req.raw, deps.tokens, 'messages:send')) return c.json({ error: 'missing messages:send scope' }, 403);
    executionActor(c, action);
    authorizeMirror();
    if (!uploadedMedia.length && validated.message.trim() === '/compact') {
      // Compact still uses the legacy command protocol. Stop has its own
      // run-bound path above and must never fall back to a session-wide command.
      const idempotencyKey = randomUUID();
      try {
        const { payload: result } = await deps.gateway.requestBound<any>('agent', { sessionKey, message: validated.message,
          deliver: false, idempotencyKey, attachments: [] }, undefined, () => {
          if (c.req.raw.signal.aborted) throw new HTTPException(408, { res: c.json({ error: 'Request cancelled' }, 408) });
          if (!requireScope(c.req.raw, deps.tokens, 'messages:send') || executionActor(c, action).actorId !== actor.actorId) {
            throw new HTTPException(403, { res: c.json({ error: 'Session authorization changed' }, 403) });
          }
        });
        return c.json({ ok: true, runId: String(result?.runId ?? result?.id ?? idempotencyKey),
          status: result?.status ?? 'started', idempotencyKey, media: [] });
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        return c.json({ error: deps.normalizeError(error) }, 502);
      }
    }
    if (!deps.openclawQueue) return c.json({ error: 'OpenClaw queue is not configured' }, 503);
    if (!deps.store.getSession(sessionKey)) return c.json({ error: 'session not found' }, 404);
    // Every ordinary turn enters the same FIFO, including an idle session.
    // Receipt keys are actor-scoped; runtime identities must be node-wide.
    const id = randomUUID();
    const result = { ok: true, runId: id, idempotencyKey: id, status: 'queued', media: uploadedMedia.map((item) => item.media) };
    const commitReceipt = deps.connectorUsers.commands.queueCommit(JSON.stringify([actor.actorId, sessionKey]),
      c.get('commandKey'), { status: 200, body: result });
    try {
      await deps.openclawQueue.enqueueAsync({ id, sessionKey, createdAt: Date.now(), payload: { message: validated.message,
        actorId: actor.actorId, ...(actor.executionGrant ? { executionGrant: actor.executionGrant } : {}),
        deliveryMode: validated.deliveryMode, ...(explicitRoute ? { explicitRoute } : {}),
        media: uploadedMedia.map(({ media, filePath }) => ({ media, filePath })) } }, commitReceipt, () => {
          if (c.req.raw.signal.aborted || !requireScope(c.req.raw, deps.tokens, 'messages:send')
            || executionActor(c, action).actorId !== actor.actorId) throw new TurnAuthorizationError();
        });
      return c.json(result);
    } catch (error) {
      // Delegated revalidation can throw an HTTP 403, not just the queue's
      // authorization error. Preserve definitive rejection for the receipt;
      // converting it to 503 would strand an uncommitted command as unknown.
      if (error instanceof HTTPException) throw error;
      if (error instanceof SessionDeletionConflict) return c.json({ error: error.message }, 409);
      return error instanceof TurnAuthorizationError
        ? c.json({ error: 'Execution authorization changed' }, 403)
        : c.json({ error: 'queue admission unavailable' }, 503);
    }
  });

  for (const runtime of ['claude-code', 'ghcp', 'antigravity']) app.post(`${base}/agents/${runtime}/sessions`, async (c, next) => {
    const owned = sdk(runtime);
    if (!owned) return next(); // Keep the existing explicit disabled receipt.
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
    if (!principal || principal.scopes.includes('execution:delegate') || c.req.header('x-agentopsdeck-execution-grant')) return c.json({ error: 'SDK creation requires owner authority' }, 403);
    if (!owned.ready) return c.json({ error: 'Agent is not ready', code: 'agent_not_ready', runtime, readiness: owned.status }, 503);
    return next();
  });
  app.post(`${base}/agents/:agentId/sessions`, async (c, next) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
    if (!principal) return c.json({ error: 'session authorization changed' }, 403);
    const body = await readJsonBody(c.req.raw, 64 * 1024);
    if (requireScope(c.req.raw, deps.tokens, 'sessions:create')?.tokenId !== principal.tokenId) return c.json({ error: 'session authorization changed' }, 403);
    c.req.bodyCache.json = Promise.resolve(body);
    await next();
  });
  registerCreationReceipts(app, `${base}/agents/:agentId/sessions`, {
    receipts: deps.connectorUsers.commands,
    scope: c => {
      const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
      if (!principal) throw new HTTPException(403, { res: c.json({ error: 'session authorization changed' }, 403) });
      return JSON.stringify([principal.tokenId, c.req.param('agentId')]);
    },
  });
  app.post(`${base}/agents/:agentId/sessions`, async (c) => {
    const principal = requireScope(c.req.raw, deps.tokens, 'sessions:create');
    if (!principal) return c.json({ error: 'missing sessions:create scope' }, 403);
    const agentId = c.req.param('agentId');
    if ((agentId === 'ghcp' || agentId === 'claude-code' || agentId === 'antigravity') && !sdk(agentId)) return c.json({ error: 'Requested Agent runtime is disabled' }, 409);
    const body = await c.req.json().catch(() => ({})) as { title?: string; label?: string; model?: string };
    const title = String(body.title ?? body.label ?? 'New chat').trim() || 'New chat';
    const validateIdentity = (sessionKey: string) => {
      if (deps.connectorUsers.commands.sessionDeletion(sessionKey)) throw new SessionDeletionConflict();
    };
    const acceptIdentity = (sessionKey: string) => {
      validateIdentity(sessionKey);
      c.get('acknowledgeCreation')({ status: 201, body: { key: sessionKey, agentId, title } });
    };
    const authorize = () => {
      c.req.raw.signal.throwIfAborted();
      if (!deps.tokens.hasScope(principal.tokenId, 'sessions:create')) throw new TurnAuthorizationError();
    };
    if (agentId === 'claude-code' || agentId === 'ghcp' || agentId === 'antigravity') {
      const config = agentId === 'claude-code' ? deps.config.claude : agentId === 'ghcp' ? deps.config.copilot : deps.config.antigravity;
      const expectedModel = agentId === 'antigravity' ? (config?.model ?? 'default') : config?.model;
      if (body.model && body.model !== expectedModel) return c.json({ error: 'Use the configured Agent model' }, 409);
      if (title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) return c.json({ error: 'Invalid SDK session title' }, 400);
      try {
        const created = sdk(agentId)!.commands.createSession(title, { authorize,
          accept: result => c.get('commitCreation')({ status: 201, body: result }) });
        return c.json(created, 201);
      } catch (error) { return c.json({ error: 'Agent creation unavailable' }, error instanceof TurnAuthorizationError ? 403 : 503); }
    }
    if (agentId === 'hermes') {
      if (!deps.hermes?.ready) return c.json({ error: 'Hermes is not ready' }, 503);
      if (body.model) return c.json({ error: 'Configure the model in the dedicated Hermes home' }, 409);
      try {
        const created = await deps.hermes.createSession(title, acceptIdentity, authorize);
        return c.json({ key: created.key, agentId, title }, 201);
      } catch (error) { return c.json({ error: deps.normalizeError(error) }, error instanceof TurnAuthorizationError ? 403 : 502); }
    }
    if (agentId === 'codex') {
      if (!deps.codex || deps.codex.enabled === false) return c.json({ error: 'Codex connector is disabled' }, 409);
      try {
        authorize();
        const created = await deps.codex.createSession({ title, ...(body.model ? { model: body.model } : {}) }, acceptIdentity, authorize, validateIdentity);
        return c.json({ key: created.key, agentId, title }, 201);
      } catch (error) {
        if (error instanceof TurnAuthorizationError) return c.json({ error: 'session authorization changed' }, 403);
        return c.json({ error: deps.normalizeError(error) }, error instanceof SessionDeletionConflict ? 409 : 502);
      }
    }
    if (!deps.config.localOpenClawCli && !deps.config.gatewayWsUrl && !deps.config.adminRpcUrl) {
      return c.json({ error: 'OpenClaw is disabled on this Connector; select an enabled agent' }, 409);
    }
    try {
      authorize();
      const { payload: result } = await deps.gateway.requestBound<any>('sessions.create', {
        agentId,
        label: title,
        ...(body.model ? { model: body.model } : {}),
      }, undefined, authorize);
      const sessionKey = String(result?.key ?? result?.sessionKey);
      if (!sessionKey || sessionKey === 'undefined') return c.json({ error: 'gateway did not return a session key' }, 502);
      acceptIdentity(sessionKey);
      deps.store.persistSessionTitleOverride(sessionKey, title);
      deps.store.upsertSession({ sessionKey, agentId, title, recent: '', status: 'idle', source: 'web', lastActiveAt: Date.now() });
      return c.json({ key: sessionKey, agentId, title }, 201);
    } catch (error) {
      if (error instanceof TurnAuthorizationError) return c.json({ error: 'session authorization changed' }, 403);
      if (error instanceof SessionDeletionConflict) return c.json({ error: error.message }, 409);
      if (deps.config.localOpenClawCli && shouldUseOpenClawCliFallback(error, 'sessions.create')) {
        if (c.req.raw.signal.aborted || !deps.tokens.hasScope(principal.tokenId, 'sessions:create')) return c.json({ error: 'session authorization changed' }, 403);
        const sessionKey = createCliFallbackDisplaySessionKey(agentId);
        if (deps.connectorUsers.commands.sessionDeletion(sessionKey)) return c.json({ error: new SessionDeletionConflict().message }, 409);
        c.get('acknowledgeCreation')({ status: 201, body: { key: sessionKey, agentId, title, fallback: 'openclaw-cli', cliSessionKey: sessionKey } });
        deps.store.persistSessionTitleOverride(sessionKey, title);
        deps.store.upsertSession({ sessionKey, agentId, title, recent: '', status: 'idle', source: 'web', lastActiveAt: Date.now() });
        return c.json({ key: sessionKey, agentId, title, fallback: 'openclaw-cli', cliSessionKey: sessionKey }, 201);
      }
      return c.json({ error: deps.normalizeError(error) }, 502);
    }
  });

  const boardBindingsReady = Promise.all([boardBindings.ready, machine.ready]).then(() => undefined);
  // Construction publishes readiness before its caller can await it. Closing
  // during recovery rejects delivery, but must not leave this derived promise
  // unobserved. Keep the original rejection available to the startup owner.
  void boardBindingsReady.catch(() => {});
  return { boardBindingsReady, close() {
    if (closing) return closing;
    // Closing a response is not settlement of the original owner read. Drain
    // accepted work before the owner is closed; never time out/replay it.
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    closed = true; fileRebuilds.close();
    void closeMachineServices([() => machine.close(), () => controlRoutes?.close(), () => storageRoutes?.close(),
      () => readinessRoutes.close(), () => updateRoutes.close(), () => boardBindings.close(),
      () => snapshotReads.close()]).then(resolve, reject);
    return closing;
  } };
}

function requireScope(request: Request, tokens: ConnectorTokenStore, scope: ConnectorScope): ConnectorPrincipal | undefined {
  return tokens.requireScope(request, scope);
}


function connectorMeta(config: ServerConfig) {
  return {
    environmentId: config.connector.environmentId,
    environmentLabel: config.connector.environmentLabel,
  };
}
import { FileIndexCursorError } from '../messages/session-file-index.js';
import { SessionFileRebuilds, FileRebuildError } from '../messages/session-file-rebuild.js';
import { claudeChatMessages, claudeMessageAnchor } from '../claude/session-view.js';
