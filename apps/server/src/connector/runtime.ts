import { InteractionRuntime } from '../commands/interaction-runtime.js';
import { readOpenClawAgentNames } from '../openclaw/cli.js';
import { dirname, join, relative } from 'node:path';
import { Hono } from 'hono';
import { localIssuerPlan } from './local-issuer-plan.js';
import { executeConnectorGrant, type ConnectorGrantCommands } from './connector-grant-domain.js';
import { registerRequestDrain, type AdmissionPause } from '../lifecycle/request-drain.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { createShutdownCleanup } from '../lifecycle/shutdown-cleanup.js';
import { ConnectorUpdateService, type MaintenanceFence } from './update-service.js';
import type { MaintenanceBusinessObservation } from './maintenance-readiness.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { NODE_ID_HEADER } from './node-identity.js';
import { AdminRpcClient } from '../gateway/admin-client.js';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { ConnectorAutomationHost } from './automation-host.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { localCredentialPlan } from './local-credential-plan.js';
import { DeckStore } from '../projection/deck-store.js';
import { createMirrorDispatcher, resolveExplicitChannelRoute } from '../messages/mirror.js';
import { bridgeRawMediaDirectives } from '../messages/media-bridge.js';
import { ArtifactRegistry, bridgeArtifactReferences, openArtifactDownload, artifactResponse, withArtifactCapability } from '../messages/artifact-receiver.js';
import { normalizeMessageText } from '../messages/normalize.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { registerEventRoutes } from '../routes/events.js';
import type { RequestAuthorization } from '../auth/awaited-request-authorization.js';
import { synchronousAuthorizationCall } from '../auth/synchronous-authorization.js';
import { registerFileRoutes } from '../routes/files.js';
import { registerMediaRoutes } from '../routes/media.js';
import { MediaLibrary } from '../routes/media-library.js';
import { registerSystemRoutes } from '../routes/system.js';
import { registerSessionRoutes } from '../routes/sessions.js';
import { createOpenClawSessionSource } from './openclaw-session-source.js';
import { createConnectorSessionDiscovery } from './session-discovery.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { createOpenClawDispatch } from '../openclaw/dispatch.js';
import { createOpenClawHistory } from '../openclaw/history-projection.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import { createHistoryReadScheduler } from '../refresh/history-read-scheduler.js';
import { CodexAppServer } from '../codex/app-server.js';
import { HermesRuntime } from '../hermes/runtime.js';
import { ClaudeConnectorRuntime } from '../claude/connector-runtime.js';
import { CopilotConnectorRuntime } from '../copilot/connector-runtime.js';
import { AntigravityConnectorRuntime } from '../antigravity/sdk-runtime.js';
import { ConnectorAgentRuntimes } from './agent-runtimes.js';
import { createFallbackAgentCatalog } from './agent-catalog.js';
import type { ServerConfig } from '../config.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { registerConnectorFileBoards, registerConnectorWorkspaceFiles } from './workspace-board-files-http.js';
import { registerConnectorContentReplicas } from './workspace-content-http.js';
import { fileBoardRuntime, fileBoardRuntimes, fileBoardWritable, LOCAL_FILE_BOARD_OWNER } from './workspace-board-file-policy.js';
import { workspaceFileContext } from './workspace-file-context.js';
import { createMirrorAuthorizer } from './mirror-authorization.js';
import { createConnectorMaintenanceCommands } from './connector-maintenance-domain.js';
import { RuntimeMaintenancePersistence } from './runtime-maintenance-persistence.js';

import { startupApplicationCleanup, type StartupOwnership } from '../lifecycle/startup-cleanup.js';
import { observeBackgroundStartup, reportStartupFailure } from '../lifecycle/startup-observation.js';

// Internal construction seam for isolated process-lifecycle acceptance. These
// factories are never read from configuration or accepted in Hub requests.
export type SdkRuntimeFactories = {
  startupOwnership?: StartupOwnership;
  deferActivation?: boolean;
  claude?: (options: ConstructorParameters<typeof ClaudeConnectorRuntime>[0]) => ClaudeConnectorRuntime;
  copilot?: (options: ConstructorParameters<typeof CopilotConnectorRuntime>[0]) => CopilotConnectorRuntime;
  antigravity?: (options: ConstructorParameters<typeof AntigravityConnectorRuntime>[0]) => AntigravityConnectorRuntime;
};

export function createConnectorRuntime(config: ServerConfig, isAuthorizedRequest: (request: Request) => boolean,
  sdkFactories: SdkRuntimeFactories = {}) {
  startupApplicationCleanup.assertAvailable();
  const startup: StartupOwnership = sdkFactories.startupOwnership ?? { drains: [], cleanups: [], failed: false };
  let connectorTokens: ConnectorTokenStore;
  const connectorUsers = new ConnectorUserStore(config.connector.usersDatabaseFile,
    (tokenId, action) => connectorTokens.hasScope(tokenId, 'execution:delegate') && connectorTokens.hasScope(tokenId, 'messages:send')
      && (action !== 'messages:mirror' || connectorTokens.hasScope(tokenId, 'messages:mirror')),
    { runtimeOwner: true });
  startup.drains.push(() => { connectorUsers.stopTurnStarts(); });
  startup.cleanups.push(() => connectorUsers.close());
  try {
    const updateService = new ConnectorUpdateService(config, { nodeId: connectorUsers.nodeId, receipts: connectorUsers.commands });
    const maintenance = updateService.maintenanceAtStartup();
    if (maintenance && maintenance.state !== 'released') connectorUsers.pauseTurnStarts();
    connectorTokens = new ConnectorTokenStore(config.connector.tokenFile, config.connector.bootstrapToken);
    return createOwnedRuntime(config, isAuthorizedRequest, connectorUsers, connectorTokens, updateService, maintenance, sdkFactories, startup);
  } catch (error) {
    startup.failed = true;
    if (!sdkFactories.startupOwnership) startupApplicationCleanup.abandon(startup.drains, startup.cleanups);
    throw error;
  }
}

function createOwnedRuntime(config: ServerConfig, isAuthorizedRequest: (request: Request) => boolean,
  connectorUsers: ConnectorUserStore, connectorTokens: ConnectorTokenStore, updateService: ConnectorUpdateService,
  maintenance: MaintenanceFence | undefined, sdkFactories: SdkRuntimeFactories, startup: StartupOwnership) {
  const projectionTasks = createTaskDrain();
  startup.drains.push(() => projectionTasks.close());
  const maintenancePersistence = new RuntimeMaintenancePersistence({ command: createConnectorMaintenanceCommands(connectorUsers) });
  startup.drains.push(() => maintenancePersistence.close());
  const historyReads = createHistoryReadScheduler();
  startup.drains.push(() => historyReads.close());
  connectorUsers.mirrorOutbox.importLegacy(config.mirrorOutboxFile);
  const authorizeTurn = createTurnAuthorizer(connectorUsers.executionGrants, (id, scope) => connectorTokens.hasScope(id, scope));
  const fileBoardAllowed = (owner: string, key: string) => {
    const runtime = fileBoardRuntime(key);
    return !!runtime && fileBoardWritable(runtime, config)
      && !!config.boardFiles?.policies.some(p => p.owner === owner && p.runtime === runtime)
      && !connectorUsers.commands.sessionDeletion(key) && connectorTokens.hasScope(owner, 'boards:files')
      && authorizeTurn(owner === LOCAL_FILE_BOARD_OWNER ? 'local:daily' : owner, { runtime, sessionKey: key }, 'messages:send');
  };
  const fileBoards = config.boardFiles ? connectorUsers.createFileBoards(config.boardFiles.root, fileBoardAllowed) : undefined;
  const fileCards = config.boardFiles ? connectorUsers.createFileCards(config.boardFiles.root, fileBoardAllowed) : undefined;
  const fileBoardContext = (key: string, actorId?: string, delegated?: unknown) => {
    return workspaceFileContext(fileBoards, fileCards, fileBoardAllowed, key, actorId, delegated);
  };
  const sdkFileBoardContext = (key: string, actorId?: string, delegated?: unknown) => {
    const text = fileBoardContext(key, actorId, delegated);
    if (!text || !fileBoards || !actorId) return '';
    const owner = actorId === 'local:daily' ? LOCAL_FILE_BOARD_OWNER : actorId;
    return { text, files: [...fileBoards.filesForSession(owner, key), ...fileCards?.filesForSession(owner, key) ?? []] };
  };
  connectorUsers.events.beginEpoch();
  const store = new DeckStore({ eventLog: connectorUsers.events,
    sessionDeleted: sessionKey => connectorUsers.commands.sessionDeletion(sessionKey) === 'accepted',
    sessionTitlesFile: config.sessionTitlesFile, sessionThinkingOverridesFile: config.sessionThinkingOverridesFile, hiddenSessionsFile: config.hiddenSessionsFile, archivedSessionsFile: config.archivedSessionsFile, pinnedSessionsFile: config.pinnedSessionsFile });
  const artifactRegistry = new ArtifactRegistry(config.artifactReceiver.indexFile);
  let openclawQueue: OpenClawTurnQueue;
  let discovery: ReturnType<typeof createConnectorSessionDiscovery> | undefined;
  const mediaLibrary = new MediaLibrary({ ...config.mediaLibrary, signingSecret: config.mediaLibrary.signingSecret ?? config.accessKey });
  const gateway = new GatewayWsClient({
    url: config.gatewayWsUrl,
    ownerToken: config.ownerToken,
    password: config.password,
    onEvent: (event, connectionId) => { if (store.ingestGatewayEvent(event, connectionId)) openclawQueue?.wake(); },
    onConnectionChange: () => {
      discovery?.invalidate();
      refreshOpenClawHistory.invalidate();
      try { store.projectOpenClawConnection(); openclawQueue?.wake(); }
      catch { store.invalidateOpenClawExecutionFacts(); }
    },
  });
  startup.cleanups.push(() => gateway.closeAndDrain());
  const interactions = new InteractionRuntime(connectorUsers.interactions, () => connectorUsers.sdkCommandAdmissionOpen,
    sessionKey => store.append('interaction.updated', {}, { sessionKey }));
  startup.cleanups.push(() => interactions.close());
  const codex = new CodexAppServer({
    ...config.codex,
    store,
    interactions: { runtime: interactions, nodeId: connectorUsers.nodeId },
    fileIndex: connectorUsers.fileIndex,
    tokenUsage: connectorUsers.tokenUsage,
    turnQueue: connectorUsers.turns,
    executions: connectorUsers.codexExecutions,
    authorizeTurn,
    fileBoardContext,
    projectAssistant: async (text) => {
      const row = { role: 'assistant', text };
      const artifacts = await bridgeArtifactReferences(row, 'assistant', config.artifactReceiver, artifactRegistry);
      return {
        text: normalizeMessageText(row, { bridgedRawMediaReferences: artifacts.bridgedReferences }),
        media: artifacts.media,
      };
    },
  });
  startup.drains.push(() => codex.close());
  const automation = new ConnectorAutomationHost(owner => connectorUsers.createCodexAutomation(codex, owner,
    connectorUsers.nodeId, target => connectorTokens.hasScope(owner, 'automation:manage')
      && !connectorUsers.commands.sessionDeletion(target.sessionId)
      && authorizeTurn(owner, { runtime: 'codex', sessionKey: target.sessionId }, 'messages:send')),
    owner => connectorTokens.hasScope(owner, 'automation:manage') && connectorTokens.hasScope(owner, 'messages:send'));
  startup.drains.push(() => automation.close());
  const admin = new AdminRpcClient({ url: config.adminRpcUrl, ownerToken: config.ownerToken });
  const hermes = config.hermes?.enabled ? new HermesRuntime({ config: config.hermes,
    journal: connectorUsers.hermesJournal, turns: connectorUsers.turns, store, authorize: authorizeTurn,
    admissionAvailable: () => connectorUsers.sdkCommandAdmissionOpen }) : undefined;
  if (hermes) startup.drains.push(() => hermes.close());
  const claude = config.claude ? (sdkFactories.claude ?? (options => new ClaudeConnectorRuntime(options)))({ config: config.claude, store: connectorUsers, projection: store,
    interactions,
    turnContext: (key, actor) => sdkFileBoardContext(key, actor.actorId, actor.executionGrant),
    authorize: (key, actor, action) => authorizeTurn(actor.actorId,
      { runtime: 'claude-code', sessionKey: key }, action, actor.executionGrant) }) : undefined;
  if (claude) startup.drains.push(() => claude.close());
  const copilot = config.copilot ? (sdkFactories.copilot ?? (options => new CopilotConnectorRuntime(options)))({ config: config.copilot, store: connectorUsers, projection: store,
    interactions,
    turnContext: (key, actor) => sdkFileBoardContext(key, actor.actorId, actor.executionGrant),
    authorize: (key, actor, action) => authorizeTurn(actor.actorId,
      { runtime: 'ghcp', sessionKey: key }, action, actor.executionGrant) }) : undefined;
  if (copilot) startup.drains.push(() => copilot.close());
  const antigravity = config.antigravity ? (sdkFactories.antigravity ?? (options => new AntigravityConnectorRuntime(options)))({
    config: config.antigravity, store: connectorUsers, projection: store,
    turnContext: (key, actor) => sdkFileBoardContext(key, actor.actorId, actor.executionGrant),
    authorize: (key, actor, action) => authorizeTurn(actor.actorId,
      { runtime: 'antigravity', sessionKey: key }, action, actor.executionGrant),
  }) : undefined;
  if (antigravity) startup.drains.push(() => antigravity.close());
  const agentRuntimes = new ConnectorAgentRuntimes([
    { id: 'codex', refreshSession: (key, options) => codex.refreshSession(key, options),
      isSessionHistoryReady: key => codex.isSessionHistoryReady(key), pauseQueueWorker: () => codex.pauseQueueWorker(), close: () => codex.close() },
    ...(hermes ? [{ id: 'hermes' as const, refreshSession: (key: string, options: HistoryRefreshOptions) => hermes.refreshSession(key, options),
      isSessionHistoryReady: (key: string) => hermes.isSessionHistoryReady(key), pauseQueueWorker: () => hermes.pauseQueueWorker(), close: () => hermes.close() }] : []),
    ...(claude ? [claude] : []),
    ...(copilot ? [copilot] : []),
    ...(antigravity ? [antigravity] : []),
  ]);

  // Model discovery is a daily read, not a maintenance operation. Keep this
  // local capability explicit: do not broaden existing remote/default tokens.
  const credentials = new Map(localCredentialPlan(config).map(spec => {
    const credential = connectorTokens.createTransient(spec.scopes, spec.identity);
    startup.cleanups.push(() => credential.dispose());
    return [spec.role, credential] as const;
  }));
  const localCredential = credentials.get('daily')!, maintenanceCredential = credentials.get('maintenance')!;
  const boardCredential = credentials.get('boards'), fileBoardCredential = credentials.get('files'), sourceApprovalCredential = credentials.get('sourceApproval');
  const mirrorDispatcher = createMirrorDispatcher(connectorUsers.mirrorOutbox, { store, normalizeError, localOpenClawCli: config.localOpenClawCli,
    authorizeTarget: createMirrorAuthorizer(authorizeTurn, config.defaultAgentId) });
  startup.drains.push(() => { mirrorDispatcher.stopAdmissions(); return mirrorDispatcher.close(); });
  const openclawDispatch = createOpenClawDispatch({ gateway, store, allowCliFallback: config.localOpenClawCli,
    authorizeTurn, executions: connectorUsers.openClawExecutions, mirrorOutbox: connectorUsers.mirrorOutbox, onSettled: () => openclawQueue?.wake(),
    message: (text) => withArtifactCapability(text, config.artifactReceiver.enabled && config.artifactReceiver.injectCapability, config.artifactReceiver.maxBytes) });
  startup.drains.push(() => { openclawDispatch.stopAdmissions(); return openclawDispatch.close(); });
  openclawQueue = new OpenClawTurnQueue({
    recovery: { connectionId: () => gateway.connectionId(),
      query: async (runId, connectionId) => (await gateway.requestBound('agent.wait', { runId, timeoutMs: 0 }, connectionId)).payload },
    turns: connectorUsers.turns, executions: connectorUsers.openClawExecutions, mirrorOutbox: connectorUsers.mirrorOutbox, queueFile: config.queueFile, store,
    authorizeTurn,
    refreshSessions: () => refreshSessions({ maxAgeMs: 2000 }),
    refreshMessages: (sessionKey, options) => refreshMessages(sessionKey, { maxAgeMs: 0, ...options }),
    send: openclawDispatch,
    reconcileMirror: mirrorDispatcher.reconcileSession,
    mirror: async (turn) => {
      if (turn.payload.explicitRoute) await mirrorDispatcher.mirrorAssistantReplyToChannel({ sessionKey: turn.sessionKey,
        after: turn.createdAt, inputText: turn.payload.message, explicitRoute: turn.payload.explicitRoute, idempotencyKey: turn.id,
        ...(turn.payload.actorId ? { actorId: turn.payload.actorId } : {}),
        ...(turn.payload.executionGrant ? { executionGrant: turn.payload.executionGrant } : {}) });
    },
  });
  startup.drains.push(() => openclawQueue.close());
  const app = new Hono();
  app.use('/api/connector/v1/*', async (context, next) => {
    context.header(CONNECTOR_PROTOCOL_HEADER, '1');
    context.header(NODE_ID_HEADER, connectorUsers.nodeId);
    await next();
  });
  let maintenanceProbes = 0;
  const drainRequests = registerRequestDrain(app, { writesOnRead: true, isControl: request => {
    const pathname = new URL(request.url).pathname;
    if (request.method === 'POST') return /^\/api\/connector\/v1\/maintenance\/(commands\/(pause|resume)|readiness)$/.test(pathname);
    return ['GET', 'HEAD'].includes(request.method)
      && (!/^\/api(?:\/|$)/.test(pathname) || pathname === '/api/health'
        || /^\/api\/connector\/v1\/(identity|health|maintenance\/(status|inspection|storage\/recovery)|maintenance\/commands\/(pause|resume)\/[^/]+)$/.test(pathname));
  } });
  const legacyEventRoutes = new Set<ReturnType<typeof registerEventRoutes>>();
  const closeLegacyEvents = () => Promise.all([...legacyEventRoutes].map(routes => routes.close())).then(() => undefined);
  startup.drains.push(closeLegacyEvents);
  const legacySessionRoutes = new Set<ReturnType<typeof registerSessionRoutes>>();
  const closeLegacySessionReads = () => Promise.all([...legacySessionRoutes].map(routes => routes.close())).then(() => undefined);
  startup.drains.push(closeLegacySessionReads);
  const legacySystemRoutes = new Set<ReturnType<typeof registerSystemRoutes>>();
  const closeLegacySystems = () => Promise.all([...legacySystemRoutes].map(routes => routes.close())).then(() => undefined);
  startup.drains.push(closeLegacySystems);
  const legacyFileRoutes = new Set<ReturnType<typeof registerFileRoutes>>();
  const closeLegacyFiles = () => Promise.all([...legacyFileRoutes].map(routes => routes.close())).then(() => undefined);
  startup.drains.push(closeLegacyFiles);
  const stopAdmissions = () => {
    connectorUsers.stopTurnStarts(); openclawDispatch.stopAdmissions(); mirrorDispatcher.stopAdmissions();
    return Promise.all([automation.close(), projectionTasks.close(), historyReads.close(), drainRequests(), closeLegacyEvents(), closeLegacySessionReads(), closeLegacySystems(), closeLegacyFiles()]).then(() => undefined);
  };
  startup.drains.push(() => drainRequests());
  let maintenancePause: AdmissionPause | undefined;
  const pauseForMaintenance = (): AdmissionPause => {
    if (maintenancePause) return maintenancePause;
    const requests = drainRequests.pauseWrites();
    const projections = projectionTasks.pause();
    const turnStarts = connectorUsers.pauseTurnStarts();
    const openclaw = openclawQueue.pause(), agentWorkers = agentRuntimes.pauseQueueWorkers();
    const mirror = mirrorDispatcher.pauseAdmissions();
    let settled = false;
    const lease: AdmissionPause = {
      drained: Promise.all([requests.drained, projections.drained, openclaw.drained, agentWorkers.drained, mirror.drained])
        .then(() => openclawDispatch.drainCli()).then(() => { settled = true; }),
      resume: () => {
        if (maintenancePause !== lease || !settled || drainRequests.isStopping()) return false;
        if (!turnStarts() || !mirror.resume() || !openclaw.resume() || !agentWorkers.resume() || !projections.resume() || !requests.resume()) {
          maintenancePause = undefined;
          pauseForMaintenance();
          return false;
        }
        maintenancePause = undefined;
        return true;
      },
    };
    maintenancePause = lease;
    return lease;
  };
  updateService.bindMaintenanceLifecycle(pauseForMaintenance, maintenance);
  const inspectMaintenance = async (authorize: () => void, historyRecovery = false) => {
    // Do not infer Hermes/OpenClaw native quiescence from projected idle state.
    // Those adapters need their own exhaustive child/background-task proof.
    if (hermes?.enabled || config.gatewayWsUrl || config.localOpenClawCli) throw new Error('Native inspection unsupported for configured runtime');
    const observedAt = Date.now();
    const before = await updateService.maintenanceStatus(authorize);
    const check = () => {
      authorize();
      if (drainRequests.isStopping() || !['released', 'paused'].includes(before.state)
        || (before.state === 'paused') !== drainRequests.isPaused()
        || Date.now() - observedAt >= 4000) throw new Error('Maintenance state changed');
    };
    check();
    const native = await codex.inspectMaintenance(check, observedAt + 4000);
    const sdkRuntimes = [claude, copilot, antigravity].filter(runtime => !!runtime);
    const sdkFacts = await Promise.all(sdkRuntimes.map(runtime => runtime.inspectMaintenance()));
    check();
    const persisted = await maintenancePersistence.command('runtimeMaintenanceObserve', { historyRecovery }, check);
    const after = await updateService.maintenanceStatus(authorize);
    // All asynchronous facts must settle before the FINAL authority, deadline,
    // fence and native checks. A pre-await idle snapshot is not a current proof.
    check(); native.assertCurrent();
    sdkFacts.forEach(facts => facts.assertCurrent());
    if (before.state !== after.state || before.fenceId !== after.fenceId) throw new Error('Maintenance fence changed');
    return { ...persisted, observedAt, nativeVerified: true as const,
      activeRuns: native.activeRuns + sdkFacts.reduce((sum, facts) => sum + facts.nativeWorkers, 0), backgroundTerminals: native.backgroundTerminals,
      inFlightWrites: drainRequests.activeWrites() + native.inFlightWrites + maintenanceProbes
        + sdkFacts.reduce((sum, facts) => sum + facts.admissionInFlight + facts.startupWorkers, 0),
      ...(after.state === 'paused' && after.fenceId ? { fenceId: after.fenceId } : {}) };
  };
  const probeMaintenance = async (sessionKey: string, authorize: () => void): Promise<Omit<MaintenanceBusinessObservation, 'fenceId'>> => {
    const revision = config.connector.revision;
    const deadline = Date.now() + 55_000;
    const sdkProbe = sessionKey.startsWith('claude-code:') ? claude : sessionKey.startsWith('ghcp:') ? copilot : sessionKey.startsWith('antigravity:') ? antigravity : undefined;
    if ((!sdkProbe && (!codex.enabled || !codex.owns(sessionKey))) || hermes?.enabled || config.gatewayWsUrl || config.localOpenClawCli
      || !revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('Pinned runtime business probe unavailable');
    const check = () => {
      authorize();
      if (Date.now() >= deadline || closing || drainRequests.isStopping() || !drainRequests.isPaused() || maintenanceProbes !== 1
        || config.connector.revision !== revision) throw new Error('Business probe isolation changed');
    };
    maintenanceProbes++;
    try {
      check();
      // Admission pause alone does not prove native idleness. History recovery
      // may resume a native thread, so reject live work BEFORE hydration too.
      // A restarted process deliberately invalidates terminal projections.
      // Permit ONLY that history recovery here; public idle proof stays strict.
      const before = await inspectMaintenance(check, true);
      check();
      if (!before.fenceId || before.activeRuns || before.backgroundTerminals
        || before.pendingExecutions || before.inFlightWrites !== 1) {
        throw new Error('Business probe requires native quiescence');
      }
      // The update service holds the original fence's cross-process lock.
      // Bypass ONLY the paused projection scheduler; turn-start/queue gates
      // remain closed. Ordinary business routes are not put on the allowlist.
      await sessionDiscovery.refresh({ maxAgeMs: 0 }); check();
      if (codex.enabled) { await codex.refreshSessions({ maxAgeMs: 0 }); check(); }
      if ((sdkProbe && !await maintenancePersistence.command('runtimeMaintenanceSdkSession', { key: sessionKey, runtime: sdkProbe.id }, check))
        || !store.getSession(sessionKey)) {
        throw new Error('Probe requires an existing owned session');
      }
      // Every durable terminal was invalidated on restart, not just the probe
      // session. Recover them under the same fence before certifying idle.
      const recovering = await maintenancePersistence.command('runtimeMaintenanceHistory', {}, check);
      for (const key of recovering) {
        check();
        await codex.recoverMaintenanceHistory(key, check); check();
      }
      if (sdkProbe) { await sdkProbe.refreshSession(sessionKey, { fresh: true }); check(); }
      else if (!recovering.includes(sessionKey)) { await codex.refreshSession(sessionKey, { maxAgeMs: 0 }); check(); }
      for (const key of await maintenancePersistence.command('runtimeMaintenanceInteractions', {}, check)) {
        store.append('interaction.updated', {}, { sessionKey: key });
      }
      const preservation = await maintenancePersistence.command('runtimeMaintenancePreservation', { key: sessionKey, codex: !sdkProbe }, check);
      const observation = await inspectMaintenance(check);
      check();
      if (!observation.fenceId || observation.activeRuns || observation.backgroundTerminals
        || observation.pendingExecutions || observation.queuedMessages !== before.queuedMessages || observation.inFlightWrites !== 1
        || !discovery?.current || (codex.enabled && !codex.isSessionListReady())
        || !(sdkProbe ? sdkProbe.isSessionHistoryReady(sessionKey) : codex.isSessionHistoryReady(sessionKey))) {
        throw new Error('Business projection is not quiescent and current');
      }
      // Read the same projected business state used by sessions/state and
      // messages, without serializing a transcript to a maintenance principal.
      const state = store.getSessionsState({ includeHidden: true, includeArchived: true });
      const session = state.groups.flatMap(group => group.sessions).find(row => row.sessionKey === sessionKey);
      const messages = store.getMessages(sessionKey);
      const execution = preservation.execution;
      const recoveredRunId = session?.runtime?.phase === 'interrupted' && execution?.runId
        && execution.cleanupRecovered ? execution.runId : undefined;
      if (!session || session.hasActiveRun || session.runtime?.sync !== 'current'
        || !['completed', 'failed', 'interrupted'].includes(session.runtime.phase)
        || !messages.some(message => message.role === 'user')
        || (!recoveredRunId && !messages.some(message => message.role === 'assistant'))
        || messages.some(message => message.status === 'sending' && !(message.role === 'tool' && message.turnId
          && execution?.sync === 'current' && execution.runId && execution.runId === session.runtime?.turnId
          && message.turnId !== execution.runId))) throw new Error('Original business history unavailable');
      return { nodeId: connectorUsers.nodeId, observedAt: Date.now(), revision, sessionKey, messageCount: messages.length,
        projectionVerified: true, businessReadVerified: true, ...(recoveredRunId ? { recoveredRunId } : {}),
        preservation: { queueSha256: preservation.queueSha256,
          ...(execution ? { execution: { commandId: execution.commandId, connectionId: execution.connectionId,
            runId: execution.runId, phase: execution.phase, sync: execution.sync,
            ...(execution.executionProtection ? { executionProtection: execution.executionProtection } : {}) } } : {}) } };
    } finally { maintenanceProbes--; }
  };
  const agentCatalog = createFallbackAgentCatalog({
    groups: () => store.getSessionsState().groups,
    ...(config.localOpenClawCli ? { registry: () => readOpenClawAgentNames(config.nativeFileRoots.home) } : {}),
    ...((config.localOpenClawCli || config.gatewayWsUrl || config.adminRpcUrl) ? { defaultAgentId: config.defaultAgentId } : {}),
    runtimes: () => [
      ...(codex.enabled ? [{ id: 'codex', label: 'Codex · local harness', status: 'available' }] : []),
      ...(hermes ? [{ id: 'hermes', label: 'Hermes · dedicated runtime', status: hermes.ready ? 'available' : 'degraded' }] : []),
      ...(claude ? [{ id: 'claude-code', label: 'Claude Code', status: claude.ready ? 'available' : 'degraded', readiness: claude.status }] : []),
      ...(copilot ? [{ id: 'ghcp', label: 'GitHub Copilot', status: copilot.ready ? 'available' : 'degraded', readiness: copilot.status }] : []),
      ...(antigravity ? [{ id: 'antigravity', label: 'Antigravity', status: antigravity.ready ? 'available' : 'degraded', readiness: antigravity.status }] : []),
    ],
  });
  const fallbackAgents = (error?: string) => agentCatalog.list(error);
  startup.drains.push(() => agentCatalog.close());
  const routes = registerConnectorRoutes(app, { config, interactions, automation, updateService, inspectMaintenance, probeMaintenance, tokens: connectorTokens, connectorUsers, store, gateway, codex, ...(hermes ? { hermes } : {}), ...(claude ? { claude } : {}), ...(copilot ? { copilot } : {}), ...(antigravity ? { antigravity } : {}), artifactRegistry, openclawQueue, refreshSessions,
    sessionSnapshotReady: () => discovery?.current === true && codex.isSessionListReady(),
    historySnapshotReady: key => agentRuntimes.historyReady(key) ?? refreshOpenClawHistory.ready(key),
    refreshMessages, fallbackAgents, isAuthorizedRequest, normalizeError });
  startup.drains.push(() => routes.close());
  const fileSession = async (key: string) => {
      if (connectorUsers.commands.sessionDeletion(key)) return { exists: false, ready: false };
      if (key.startsWith('codex:')) {
        // Creating a native thread can finish before the initial list refresh.
        // Join that read instead of freezing a valid binding as uncertain. This
        // does not start a turn or skip native readiness/deletion checks.
        if (codex.enabled && !codex.isSessionListReady()) await codex.refreshSessions();
        return { exists: !connectorUsers.commands.sessionDeletion(key) && !!store.getSession(key),
          ready: codex.enabled && codex.isSessionListReady() };
      }
      const journal = key.startsWith('claude-code:') ? connectorUsers.claudeJournal : key.startsWith('ghcp:') ? connectorUsers.copilotJournal : key.startsWith('antigravity:') ? connectorUsers.antigravityJournal : undefined;
      return { exists: !!journal?.session(key) && !journal.deletion(key), ready: key.startsWith('claude-code:') ? !!claude?.ready : key.startsWith('ghcp:') ? !!copilot?.ready : !!antigravity?.ready };
    };
  const fileRuntimes = (owner: string) => fileBoardRuntimes(owner, config);
  const contentReplicas = fileCards ? connectorUsers.createContentReplicas(fileCards) : undefined;
  if (contentReplicas) startup.drains.push(() => contentReplicas.close());
  const fileBoardRoutes = fileBoards ? registerConnectorFileBoards(app, { tokens: connectorTokens, boards: fileBoards, session: fileSession, runtimes: fileRuntimes }) : undefined;
  if (fileBoardRoutes) startup.drains.push(async () => { await contentReplicas?.close(); await fileBoardRoutes.close(); });
  const fileCardRoutes = fileCards ? registerConnectorWorkspaceFiles(app, { tokens: connectorTokens, boards: fileCards, session: fileSession, runtimes: fileRuntimes }) : undefined;
  if (fileCardRoutes) startup.drains.push(async () => { await contentReplicas?.close(); await fileCardRoutes.close(); });
  if (fileCards && contentReplicas) registerConnectorContentReplicas(app, { tokens: connectorTokens, files: fileCards,
    replicas: contentReplicas, session: fileSession,
    available: () => connectorUsers.sdkCommandAdmissionOpen });
  const bindingsReady = Promise.all([routes.boardBindingsReady, fileBoardRoutes?.ready, fileCardRoutes?.ready]);
  // This aggregate exists even when no native adapter needs managed files, or
  // activation is deferred. Freeze may reject a child's ready before an owner
  // awaits it. Observe this derived promise too; preserve its rejection for
  // startup consumers instead of turning cancelled recovery into readiness.
  void bindingsReady.catch(() => {});
  function registerLegacyRoutes(app: Hono, isLegacyAuthorized: RequestAuthorization = isAuthorizedRequest) {
  drainRequests.register(app);
  legacySystemRoutes.add(registerSystemRoutes(app, {
    config, admin, gateway, codex, store, refreshSessions, fallbackAgents, normalizeError,
    memoryDiagnostics: () => ({ codex: codex.memoryDiagnostics() }),
  }));
  registerMediaRoutes(app, {
    inboundDir: config.inboundMediaDir,
    publicBaseUrl: config.publicBaseUrl,
    artifact: {
      config: config.artifactReceiver,
      registry: artifactRegistry,
      open: openArtifactDownload,
      response: artifactResponse,
    },
  });
  mediaLibrary.register(app);

  const sessions = registerSessionRoutes(app, {
    inboundDir: config.inboundMediaDir,
    commands: connectorUsers.commands,
    deletionAdmission: sessionKey => connectorUsers.canDeleteSession(sessionKey),
    settingsAdmission: sessionKey => connectorUsers.canChangeSettings(sessionKey),
    store,
    gateway,
    refreshSessions,
    refreshMessages,
    resolveExplicitChannelRoute: (sessionKey) => resolveExplicitChannelRoute(sessionKey, config.defaultAgentId),
    mirrorAssistantReplyToChannel: mirrorDispatcher.mirrorAssistantReplyToChannel,
    normalizeError,
    queue: openclawQueue,
    queueActor: (request) => synchronousAuthorizationCall(isAuthorizedRequest, [request]) ? 'local:daily' : undefined,
    observeActor: async request => (await isLegacyAuthorized(request)) === true ? 'local:daily' : undefined,
    artifactCapability: {
      enabled: config.artifactReceiver.enabled && config.artifactReceiver.injectCapability,
      maxBytes: config.artifactReceiver.maxBytes,
    },
  });

  legacySessionRoutes.add(sessions);
  if (startup.failed || drainRequests.isStopping()) void sessions.close();

  const events = registerEventRoutes(app, store, isLegacyAuthorized);
  legacyEventRoutes.add(events);
  if (startup.failed || drainRequests.isStopping()) void events.close();
  legacyFileRoutes.add(registerFileRoutes(app));


  }
  const sessionSource = createOpenClawSessionSource(config);
  startup.drains.push(() => sessionSource.close());
  discovery = createConnectorSessionDiscovery({ gateway, projection: store,
    local: config.localOpenClawCli, configured: !!(config.localOpenClawCli || config.gatewayWsUrl),
    readLocal: sessionSource.readSessions,
    refreshDirectories: () => { claude?.refreshDirectory(); copilot?.refreshDirectory(); antigravity?.refreshDirectory(); } });
  const sessionDiscovery = discovery;
  startup.drains.push(() => sessionDiscovery.close());
  const refreshOpenClawHistory = createOpenClawHistory({ gateway, local: config.localOpenClawCli,
    readLocal: sessionSource.readTranscript, projection: store,
    bridgeMedia: (row, role) => bridgeRawMediaDirectives(row, role, { ...config.mediaBridge, inboundDir: config.inboundMediaDir }),
    bridgeArtifacts: (row, role) => bridgeArtifactReferences(row, role, config.artifactReceiver, artifactRegistry),
  });
  startup.drains.push(() => refreshOpenClawHistory.close());

  async function refreshSessions(options: { maxAgeMs?: number } = {}) {
    if (closing) throw new Error('Connector runtime is closing');
    return projectionTasks.run(() => sessionDiscovery.refresh(options));
  }

  async function refreshMessages(sessionKey: string, options: HistoryRefreshOptions = {}) {
    if (closing) throw new Error('Connector runtime is closing');
    const agent = agentRuntimes.forSession(sessionKey);
    const result = await projectionTasks.run(() => historyReads.run(sessionKey, options, () => agent
      ? agent.refreshSession(sessionKey, options) : refreshOpenClawHistory(sessionKey, options)));
    for (const key of connectorUsers.reconcileEndedInteractions(sessionKey)) {
      store.append('interaction.updated', {}, { sessionKey: key });
    }
    return result;
  }

  function normalizeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }


  // A completed native turn can outlive its rollout file. On restart, recover
  // that terminal projection before the Codex queue worker is allowed to see
  // its successor. The runtime owns the database exclusively here and neither
  // queue worker has started, so newly admitted messages may only queue; they
  // cannot overtake or be replayed by this history-only operation.
  const startWorkers = async () => {
    if (startup.failed) return;
    try {
      for (const sessionKey of connectorUsers.codexExecutions.maintenanceHistorySessions()) {
        if (startup.failed || closing || drainRequests.isStopping()) return;
        const fact = connectorUsers.codexExecutions.get(sessionKey);
        if (fact?.sync === 'error' && ['completed', 'failed'].includes(fact.phase)) {
          try {
            await codex.recoverMaintenanceHistory(sessionKey, () => {
              if (startup.failed || closing || drainRequests.isStopping()) throw new Error('Runtime is closing');
            });
          } catch {
            if (startup.failed || closing || drainRequests.isStopping()) return;
            // One untrusted native snapshot must not prevent independent
            // sessions from recovering. Do not log RPC text or clear its fence.
            console.warn('[codex-startup-history-recovery-pending]', { phase: fact.phase });
          }
        }
      }
    } catch {
      // Preserve the durable fence on any failed native proof. The ordinary
      // worker may reconcile other sessions but canStart still blocks this one.
      reportStartupFailure(4);
    }
    if (startup.failed || closing || drainRequests.isStopping()) return;
    for (const sessionKey of connectorUsers.reconcileEndedInteractions()) {
      store.append('interaction.updated', {}, { sessionKey });
    }
    codex.startQueueWorker();
    openclawQueue.start();
    try { automation.start(connectorUsers.automationOwners()); }
    catch {
      reportStartupFailure(5); // Corrupt/capacity evidence fails closed.
      void observeBackgroundStartup(6, () => automation.close());
    }
  };
  let closing: Promise<void> | undefined;
  let bindingFailure: Error | undefined;
  const closeOwners = createShutdownCleanup(async () => {
    const requests = stopAdmissions();
    await contentReplicas?.close();
    await Promise.all([fileBoardRoutes?.close(), fileCardRoutes?.close()]);
    await requests;
    await agentCatalog.close();
    bindingFailure = await routes.close().then(() => undefined, () => new Error('Private task binding shutdown reconciliation failed'));
    interactions.close();
    localCredential.dispose(); maintenanceCredential.dispose(); boardCredential?.dispose(); fileBoardCredential?.dispose();
    const gatewayClosed = gateway.closeAndDrain();
    await Promise.all([gatewayClosed, agentRuntimes.close(), openclawQueue.close(), openclawDispatch.close(), mirrorDispatcher.close(),
      Promise.allSettled([sessionDiscovery.close(), refreshOpenClawHistory.close()])
        .then(() => sessionSource.close())]);
  }, [() => maintenancePersistence.close(), () => connectorUsers.close(), () => { if (bindingFailure) throw bindingFailure; }]);
  let activated = false;
  function activate() {
    // Parent applications finish all route/resource assembly before requesting
    // activation. A late ACK or repeated call must never resurrect stopped work.
    if (activated || startup.failed || closing || drainRequests.isStopping()) return;
    activated = true;
    if (config.codex.boardToolsDirectory || fileBoardRoutes) {
      void observeBackgroundStartup(1, async () => { await bindingsReady; await startWorkers(); });
    } else void observeBackgroundStartup(1, startWorkers);
    // Opt-in only; a failed Hermes boot must not bring down existing runtimes.
    if (hermes) void observeBackgroundStartup(2, () => hermes.start());
    // No native worker can load managed credentials before startup reconciliation.
    if (config.claude?.boardToolsDirectory || config.copilot?.boardToolsDirectory || fileBoardRoutes) {
      void observeBackgroundStartup(3, async () => {
        await bindingsReady;
        if (!startup.failed && !closing && !drainRequests.isStopping()) { claude?.activate(); copilot?.activate(); antigravity?.activate(); }
      });
    } else {
      try { claude?.activate(); copilot?.activate(); antigravity?.activate(); }
      catch (error) { reportStartupFailure(3); throw error; }
    }
  }
  if (!sdkFactories.deferActivation) activate();
  return { app, stopAdmissions, activate, localToken: localCredential.token, localMaintenanceToken: maintenanceCredential.token,
    localBoardBindingToken: boardCredential?.token,
    localFileBoardToken: fileBoardCredential?.token,
    localSourceApprovalToken: sourceApprovalCredential?.token,
    localExecutionOperator: {
      create: (hubId: string, createSessions = false) => connectorTokens.create(localIssuerPlan(hubId, createSessions)),
      revoke: (id: string) => connectorTokens.revoke(id),
      revokeRetiredGrant: (input: ConnectorGrantCommands['localRetiredGrantRevoke']['input']) =>
        executeConnectorGrant('localRetiredGrantRevoke', input, {
          nodeId: connectorUsers.nodeId,
          tokens: connectorTokens,
          grants: connectorUsers.executionGrants,
          turns: connectorUsers.turns,
          mirrorOutbox: connectorUsers.mirrorOutbox,
        }),
    },
    store, gateway, codex, hermes, claude, copilot, antigravity, connectorUsers, mediaLibrary, refreshSessions, refreshMessages, normalizeError, registerLegacyRoutes,
    inspectHistoryReads: historyReads.inspect,
    close: () => closing = closeOwners(),
  };
}
