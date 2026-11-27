import { registerHubDockerSandboxes, isHubDockerSandboxRequest } from './hub-docker-sandboxes.js';
import { registerHubAccountDirectory } from './hub-account-directory.js';
import { registerAsyncHubDiscovery, isAsyncHubDiscoveryRequest } from './hub-discovery-async.js';
import { registerAsyncHubOwnerControls, isAsyncHubOwnerControlRequest } from './hub-owner-controls-async.js';
import { registerAsyncHubPermissions, isAsyncHubPermissionRequest } from './hub-permissions-async.js';
import { registerAsyncHubGovernance, isAsyncHubGovernanceRequest } from './hub-governance-async.js';
import { registerHubConnectionFiles, isHubConnectionFileRequest } from './hub-connection-files.js';
import { registerHubConnectionControl, isHubConnectionControlRequest } from './hub-connection-control.js';
import { registerHubConnectionVerification, isHubConnectionVerificationRequest } from './hub-connection-verification.js';
import { validBoardId } from '@agentopsdeck/shared';
import { proxyHubConnectorUserMutation } from './hub-connector-user-mutation.js';
import { registerHubConnectorUserManagement, isHubConnectorUserManagementRequest } from './hub-connector-user-management.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { requestConnectorClient } from '../hub/request-connector-client.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { ConnectorResponseBudgetPool, ConnectorResponseBudgetExceeded } from '../hub/response-budget.js';
import { encodeHubSessionId, decodeHubSessionId } from '../hub/session-id.js';
import { registerHubSessionPreferences } from './hub-session-preferences.js';
import { registerSynchronousHubConnectionMutations } from './hub-connection-mutations.js';
import { registerAsyncHubConnectionMutations } from './hub-connection-mutations-async.js';
import { registerHubDelegations } from './hub-workspace-delegations.js';
import { registerHubWorkspaceContent } from './hub-workspace-content.js';
import { registerAsyncHubContentDocuments } from './hub-async-workspace-content-documents.js';
import { registerAsyncHubContentOverview } from './hub-async-workspace-content-overview.js';
import { registerAsyncHubContentBindings } from './hub-async-workspace-content-bindings.js';
import { registerAsyncHubContentBatches } from './hub-async-workspace-content-batches.js';
import { contentReplicaTransport } from '../hub/workspace-content-transport.js';
import { AsyncContentBackground } from '../hub/async-content-background.js';
import { delegationDirectory } from '../hub/workspace-delegation-directory.js';
import { registerHubTaskSessions } from './hub-task-sessions.js';
import { registerHubUsageManifests } from './hub-usage-manifests.js';
import { registerHubSessionGuidance } from './hub-session-guidance.js';
import { registerAsyncHubSessionGuidance } from './hub-session-guidance-async.js';
import { registerHubAutomation } from './hub-automation.js';
import { HistoryDiagnostics } from '../storage/history-diagnostics.js';
export { encodeHubSessionId, decodeHubSessionId } from '../hub/session-id.js';
import { Hono, type Context } from 'hono';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { AsyncNativeFileBackground } from '../hub/async-native-file-background.js';
import { HTTPException } from 'hono/http-exception';
import { registerHubWorkspacePreferences } from './hub-workspace-preferences.js';
import { registerHubWorkspaceLayouts } from './hub-workspace-layouts.js';
import { registerHubSessionNotebookRoutes } from './hub-session-notebooks.js';
import { sessionNotebookWriteRoute } from './hub-session-notebook-scope.js';
import { isAsyncHubWorkspaceBoardRequest, registerHubWorkspaceBoardRoutes } from './hub-workspace-boards.js';
import { isAsyncHubWorkspaceVisualReadRequest } from './hub-native-file-write.js';
import { registerHubBoardBindings } from './hub-workspace-board-bindings.js';
import { registerAsyncHubBoardBindings } from './hub-async-workspace-board-bindings.js';
import { registerAsyncHubDelegations } from './hub-async-workspace-delegations.js';
import { registerAsyncHubUsageManifests } from './hub-async-usage-manifests.js';
import { registerHubWorkspaceCards } from './hub-workspace-cards.js';
import { registerHubWorkspaceDrawingRoutes } from './hub-workspace-drawings.js';
import { registerHubNativeDrawioRoutes } from './hub-workspace-native-drawio.js';
import { registerHubWebsiteRoutes } from './hub-websites.js';
import { registerHubAhp } from '../ahp/hub-http.js';
import { registerHubResearchRoutes } from './hub-workspace-research.js';
import { registerHubQuickChat } from './hub-quick-chat.js';
import { QuickChatService } from '../hub/quick-chat-service.js';
import { registerHubRemoteRoutes } from './hub-workspace-remote.js';
import { registerHubWeixin } from './hub-weixin.js';
import { WeixinService } from '../hub/weixin-service.js';
import { HttpWeixinTransport, type WeixinTransport } from '../hub/weixin-transport.js';
import { weixinBridge, weixinRequestBinding } from '../hub/weixin-bridge.js';
import { registerHubTerminals } from './hub-terminals.js';
import { registerHubBrowser } from './hub-workspace-browser.js';
import { registerHubWebsiteAccess } from './hub-website-access.js';
import { registerHubWebsiteActions } from './hub-website-actions.js';
import { registerHubTokenUsage } from './hub-token-usage.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { registerHubEventRoutes } from '../hub/event-http.js';
import { registerHubRoleAccessRoutes } from './hub-role-access.js';
import { registerHubCompletions, registerHubCompletionRoutes } from './hub-completions.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { registerHubCompactRoutes } from '../hub/compact-http.js';
import { ConnectorNotDispatchedError } from '../hub/connector-connect.js';
import { AOD_MODEL_SET_ID, isAgentRuntimeId } from '@agentopsdeck/shared';
import type { ChatMessage, SessionSummary, SessionsState } from '@agentopsdeck/shared';
import type { ServerConfig } from '../config.js';
import type { ConnectorUser } from '../connector/connector-user-store.js';
import type { HubConnection, HubStore, SessionPreferences } from '../hub/hub-store.js';
import { normalizeConnectorUrl } from '../hub/hub-store.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { registerHubHistoryMedia } from './hub-history-media.js';
import { registerHubSessionAuxiliary } from './hub-session-auxiliary.js';
import { usesInProcessConnector } from '../server-role.js';
import { hubDefaultConnection, initializeHubDefaultConnection } from '../hub/member-owner-bootstrap.js';
import { ConnectorClient, ConnectorClientError, HistoryPreparing, type ConnectorClientResolver } from '../hub/connector-client.js';
import { historyPendingBody } from '@agentopsdeck/shared';
import { HubEventBrokers } from '../hub/event-broker.js';
import { LEGACY_HUB_PRINCIPAL, type HubPrincipal } from '../hub/identity.js';
import { readJsonBody } from '../utils/http-body.js';
import { sessionRef } from '../hub/session-ref.js';
import { createHash } from 'node:crypto';
import { registerHubExecutionIssuerRoutes } from './hub-execution-issuers.js';
import { registerHubNodeGrantRoutes } from './hub-node-grants.js';
import { registerHubSharedDirectoryRoutes } from './hub-shared-directory.js';
import type { Dispatch } from '../connector/transport.js';
import type { HubExecutionSync } from '../hub/execution-sync.js';
import { registerHubSharedCommandRoutes } from './hub-shared-commands.js';
import { registerHubSharedReadRoutes } from './hub-shared-reads.js';
import { registerAsyncHubSharedSessions, isAsyncHubSharedSessionRequest } from './hub-shared-sessions-async.js';
import { projectMessageMedia } from '../hub/message-projection.js';
import { registerHubQueueRoutes } from '../hub/queue-http.js';
import { registerHubMessageRoutes } from '../hub/message-http.js';
import { registerHubDeletionRoutes } from '../hub/deletion-http.js';
import { registerHubCreationRoutes } from '../hub/creation-http.js';
import { registerHubSettingsRoutes } from '../hub/settings-http.js';
import { registerHubMaintenanceRoutes } from '../hub/maintenance-http.js';
import { registerRetiredHubUpdates } from './hub-retired-updates.js';
import { registerStorageDiagnostics } from '../storage/diagnostics-http.js';
import { pinHubRequestAuthority, synchronousHubPrincipalCall } from '../hub/request-authority.js';
import { linuxMetricsProvider, MetricsSampler } from '../system/metrics.js';
import { registerHubMetrics, registerAsyncHubMetrics } from '../system/metrics-http.js';
import { registerHubLifecycleRoutes } from '../hub/lifecycle-http.js';
import { registerHubSharedCreationRoutes } from './hub-shared-creation.js';
import { isAsyncHubSharedCreationRequest, registerAsyncHubSharedCreation } from './hub-shared-creation-async.js';
import { registerHubSessionSharingRoutes } from './hub-session-sharing.js';
import { registerHubOwnedSessionSharingRoutes } from './hub-owned-session-sharing.js';
import { isAsyncHubWorkspaceSyncRequest, registerHubWorkspaceSync } from './hub-workspace-sync.js';
import type { LocalMaintenance } from '../hub/maintenance-commands.js';
import { AGENTOPSDECK_VERSION, AGENTOPSDECK_BUILD, CONNECTOR_PROTOCOL } from '@agentopsdeck/shared';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { observeSessionState } from '../hub/session-state-diagnostics.js';
import { registerHubConnectorUserDisplay } from './hub-connector-users.js';
import { registerHubUserMutations, registerSynchronousHubUserMutations } from './hub-user-mutations.js';
import { registerAsyncHubMemberKeys } from './hub-member-keys.js';
import type { HubAdministrativeServices } from '../hub/administrative-route-services.js';
import { hubInfo as presentHubInfo, publicConnectorUserConnection, normalizeRemoteConnectorUser,
  wrapMessage, connectorReadError } from './hub-wire-presentation.js';

export function registerHubRoutes(app: Hono, deps: {
  websiteGateway?: import('../hub/website-gateway.js').WebsiteGateway;
  config: ServerConfig;
  hubStore: HubStore;
  /** Original persistent identity delivered by the ready owner, not a new ID. */
  hubId?: string;
  connectorClient: ConnectorClientResolver;
  asyncConnectorClient?: AsyncConnectorClientResolver;
  eventFeed?: (ownerUserId: string) => import('../hub/async-event-feed.js').HubEventFeedPort;
  asyncSharedDirectory?: Pick<import('../hub/async-shared-directory.js').AsyncHubSharedDirectory, 'sessions'>
    & Partial<Pick<import('../hub/async-shared-directory.js').AsyncHubSharedDirectory, 'close'>>;
  asyncOwnerControl?: import('../hub/owner-control.js').AsyncOwnerControlPort;
  asyncSharedCommands?: import('../hub/shared-command-port.js').AsyncSharedCommandPort;
  asyncLifecycle?: import('../hub/async-lifecycle-commands.js').AsyncHubLifecyclePort;
  asyncMaintenance?: import('../hub/async-maintenance-commands.js').AsyncHubMaintenancePort;
  asyncSharedCreation?: import('../hub/async-shared-creation.js').AsyncHubSharedCreationPort;
  asyncIssuerManagement?: import('../hub/async-issuer-management.js').AsyncHubIssuerManagementPort;
  asyncCreationDiscovery?: Pick<import('../hub/async-creation-discovery.js').AsyncHubCreationDiscovery, 'environments' | 'close'>;
  asyncEvents?: import('../hub/async-event-replay.js').AsyncHubEventReplayPort;
  asyncSharedReads?: import('../hub/async-shared-reads.js').AsyncHubSharedReadsPort;
  administrative?: HubAdministrativeServices;
  boardBindingClient?: ConnectorClientResolver;
  fileBoardClient?: ConnectorClientResolver;
  fileCardClient?: ConnectorClientResolver;
  contentReplicaClient?: ConnectorClientResolver;
  normalizeError: (error: unknown) => string;
  principal?: (request: Request) => HubPrincipal | undefined;
  localIssuerTransport?: { connectionId: string; dispatch: Dispatch };
  localExecutionOperator?: import('./hub-execution-issuers.js').LocalExecutionOperator;
  localMaintenanceTransport?: LocalMaintenance;
  executionSync?: HubExecutionSync;
  weixinTransport?: WeixinTransport;
  weixinAdministrator?: (request: Request) => boolean;
  internalRequests?: WeakMap<Request, () => HubPrincipal | undefined>;
  sessionStateResponseLimits?: { requestBytes: number; retainedBytes: number };
}) {
  if (!deps.config.hub.enabled) return;
  const base = '/api/hub/v1';
  // Bound aggregate readonly work across this Hub, not just each request.
  // No queue, retries or timer release: original reads retain their slot.
  let sessionStateReads = 0;
  const maxSessionStateReads = 8;
  // Collected transport bytes only; parsed objects, output JSON and SQL owners
  // remain independent. No deadline or cancellation-driven reservation refund.
  const requestResponseBytes = deps.sessionStateResponseLimits?.requestBytes ?? 32 * 1024 * 1024;
  const responseBudget = new ConnectorResponseBudgetPool(deps.sessionStateResponseLimits?.retainedBytes ?? 128 * 1024 * 1024);
  responseBudget.acquire(requestResponseBytes).close(); // Validate once at registration.
  const historyDiagnostics = new HistoryDiagnostics();
  const systemAccess = deps.administrative?.createSystemAccess();
  const asyncMetrics = systemAccess && deps.asyncConnectorClient;
  ensureDefaultHubConnection(deps.config, deps.hubStore);
  const brokers = deps.eventFeed ? new HubEventBrokers({ mode: 'async', feed: deps.eventFeed })
    : new HubEventBrokers(deps.hubStore, deps.connectorClient);
  const internal = deps.internalRequests ?? new WeakMap<Request, () => HubPrincipal | undefined>();
  const ownerControlApp = new Hono();
  const ownerControls = deps.administrative && deps.asyncConnectorClient
    ? registerAsyncHubOwnerControls(ownerControlApp, { mode: 'async',
      controls: deps.administrative.createOwnerControlAccess(deps.asyncConnectorClient) }) : undefined;
  const sharedCreationApp = new Hono();
  const sharedCreation = deps.asyncSharedCreation && deps.asyncCreationDiscovery
    ? registerAsyncHubSharedCreation(sharedCreationApp, { mode: 'async',
      creation: deps.asyncSharedCreation, discovery: deps.asyncCreationDiscovery }) : undefined;
  const sharedSessionApp = new Hono();
  const permissionApp = new Hono();
  const permissions = deps.administrative ? registerAsyncHubPermissions(permissionApp, { mode: 'async',
    access: deps.administrative.createPermissionAccess(), services: deps.administrative }) : undefined;
  const governanceApp = new Hono();
  const connectorUserApp = new Hono();
  const connectorUserAccess = deps.administrative && deps.asyncConnectorClient
    ? deps.administrative.createConnectionVerificationAccess() : undefined;
  const connectorUserManagement = connectorUserAccess && deps.asyncConnectorClient
    ? registerHubConnectorUserManagement(connectorUserApp, { mode: 'async', access: {
      begin: request => connectorUserAccess.requests.begin(request), close: () => connectorUserAccess.close(),
    }, asyncConnectorClient: deps.asyncConnectorClient, readError: connectorReadError,
    presentDirectory: (connection, users, supported, remoteUsers, error) => publicConnectorUserConnection(connection, users, supported,
      remoteUsers.map(normalizeRemoteConnectorUser).filter((user): user is ConnectorUser => Boolean(user)), error),
    presentMutation: (connection, users, user) => publicConnectorUserConnection(connection, users, true, [user]),
    }) : undefined;
  const governance = deps.administrative && deps.asyncIssuerManagement && deps.asyncMaintenance && deps.asyncLifecycle
    ? registerAsyncHubGovernance(governanceApp, { mode: 'async', access: deps.administrative.createGovernanceAccess(),
      services: { issuerManagement: deps.asyncIssuerManagement, maintenance: deps.asyncMaintenance, lifecycle: deps.asyncLifecycle } }) : undefined;
  const sharedDirectory = deps.asyncSharedDirectory;
  const sharedSessions = sharedDirectory && sharedDirectory.close && deps.asyncSharedReads && deps.asyncSharedCommands && deps.asyncConnectorClient
    ? registerAsyncHubSharedSessions(sharedSessionApp, { mode: 'async',
      directory: { sessions: (request, target) => sharedDirectory.sessions(request, target), close: () => sharedDirectory.close!() },
      reads: deps.asyncSharedReads, commands: deps.asyncSharedCommands, connector: deps.asyncConnectorClient, brokers }) : undefined;
  const workspaceSyncApp = new Hono();
  const workspaceAccess = deps.administrative && deps.asyncConnectorClient
    ? deps.administrative.createConnectionVerificationAccess() : undefined;
  const workspaceSync = workspaceAccess && deps.asyncConnectorClient
    ? registerHubWorkspaceSync(workspaceSyncApp, { mode: 'async', access: workspaceAccess.requests,
      asyncConnectorClient: deps.asyncConnectorClient, wrap: wrapMessage }) : undefined;
  const external = deps.principal ?? (() => LEGACY_HUB_PRINCIPAL);
  const authenticate = (request: Request) => internal.has(request)
    ? synchronousHubPrincipalCall(internal.get(request)!, []) : synchronousHubPrincipalCall(external, [request]);
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith(`${base}/`) && !path.startsWith('/api/sessions/')) return next();
    // Include early identity/scope refusals, not only downstream route results.
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    // Select the complete async composition before any synchronous principal.
    // Exact private legacy actors remain a distinct lane, never an error
    // fallback. Weixin retains its original Request binding into the worker.
    if (ownerControls && (!internal.has(c.req.raw) || weixinRequestBinding(c.req.raw))
      && isAsyncHubOwnerControlRequest(c.req.method, path)) return ownerControlApp.fetch(c.req.raw);
    if (sharedCreation && !internal.has(c.req.raw) && isAsyncHubSharedCreationRequest(c.req.method, path)) return sharedCreationApp.fetch(c.req.raw);
    if (sharedSessions && !internal.has(c.req.raw) && isAsyncHubSharedSessionRequest(c.req.method, path)) return sharedSessionApp.fetch(c.req.raw);
    if (permissions && !internal.has(c.req.raw) && isAsyncHubPermissionRequest(c.req.method, path)) return permissionApp.fetch(c.req.raw);
    if (governance && !internal.has(c.req.raw) && isAsyncHubGovernanceRequest(c.req.method, path)) return governanceApp.fetch(c.req.raw);
    if (connectorUserManagement && !internal.has(c.req.raw) && isHubConnectorUserManagementRequest(c.req.method, path)) return connectorUserApp.fetch(c.req.raw);
    if (workspaceSync && !internal.has(c.req.raw) && isAsyncHubWorkspaceSyncRequest(c.req.method, path)) return workspaceSyncApp.fetch(c.req.raw);
    if (deps.administrative && deps.asyncConnectorClient && isAsyncHubDiscoveryRequest(c.req.method, path)) return next();
    if (systemAccess && (
      ['GET','HEAD'].includes(c.req.method) && [ `${base}/maintenance/storage`, `${base}/maintenance/storage/recovery` ].includes(path)
      || c.req.method === 'POST' && path === `${base}/maintenance/storage/checkpoint`)) return next();
    if (asyncMetrics && ['GET','HEAD'].includes(c.req.method) && (
      [ `${base}/system/metrics/hub`, `${base}/system/metrics/sources` ].includes(path)
      || /^\/api\/hub\/v1\/system\/metrics\/connectors\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && path === `${base}/weixin`
      || c.req.method === 'POST' && (path === `${base}/weixin/bindings` || /^\/api\/hub\/v1\/weixin\/bindings\/[^/]+\/poll$/.test(path))
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/weixin\/bindings\/[^/]+$/.test(path))) return next();
    // Binding HTTP (including atomic archive upgrade) carries original request
    // evidence through the async port. Editor PUTs below also pin the original
    // member proof, including the unbound/private alternative. Other editor
    // families retain their separate migration boundaries.
    if (deps.administrative && deps.asyncConnectorClient && (
      deps.fileBoardClient && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/file-binding(?:\/(?:capabilities|[^/]+(?:\/(?:cancel|writes(?:\/[^/]+)?))?))?$/.test(path)
      || deps.fileCardClient && /^\/api\/hub\/v1\/workspace\/file-cards\/[^/]+\/file-binding(?:\/(?:capabilities|[^/]+(?:\/(?:cancel|writes(?:\/[^/]+)?))?))?$/.test(path)
      || deps.fileCardClient && c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/file-cards\/[^/]+\/file-binding\/[^/]+\/include-archive$/.test(path)
    )) return next();
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && c.req.method === 'PUT' && /^\/api\/hub\/v1\/workspace\/(?:boards|cards|drawings|native-drawio)\/[^/]+$/.test(path)) return next();
    // Private visual/board reads and board capability management use the same
    // complete async composition as writes, with original identity checks.
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && (isAsyncHubWorkspaceBoardRequest(c.req.method, path)
        || isAsyncHubWorkspaceVisualReadRequest(c.req.method, path))) return next();
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && c.req.method === 'PUT' && /^\/api\/hub\/v1\/workspace\/file-cards\/[^/]+\/document$/.test(path)) return next();
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && c.req.method === 'PUT' && (path === '/api/hub/v1/notebook'
        || /^\/api\/hub\/v1\/notebooks\/[^/]+(?:\/(?:layout|archive))?$/.test(path))) return next();
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && (['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/notebooks\/[^/]+\/moves\/[^/]+$/.test(path)
        || c.req.method === 'POST' && /^\/api\/hub\/v1\/notebooks\/[^/]+\/moves$/.test(path))) return next();
    // Canonical private Notebook reads and capability management are one
    // awaited package. Session/shared, machine and unknown paths stay guarded.
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && (['GET', 'HEAD'].includes(c.req.method) && (path === '/api/hub/v1/notebook' || path === '/api/hub/v1/notebooks'
        || /^\/api\/hub\/v1\/notebooks\/[^/]+(?:\/(?:layout|archive|search|capabilities))?$/.test(path))
        || c.req.method === 'POST' && /^\/api\/hub\/v1\/notebooks\/[^/]+\/capabilities$/.test(path)
        || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/notebooks\/[^/]+\/capabilities\/[^/]+$/.test(path))) return next();
    // The composed session package owns exact read and write/control routes.
    // Shared capabilities and unknown suffixes retain normal authorization.
    if (deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient)
      && (sessionNotebookWriteRoute(c.req.method, path) || ['GET', 'HEAD'].includes(c.req.method)
      && /^\/api\/hub\/v1\/(?:shared\/[^/]+\/)?sessions\/[^/]+\/notebook(?:\/(?:archive|search))?$/.test(path))) return next();
    // This complete owner proxy package carries its original proof through
    // transport, response delivery and every media chunk. No shared approvals.
    if (deps.administrative && deps.asyncConnectorClient && (
      ['GET', 'HEAD', 'PUT'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/guidance$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/sessions\/[^/]+\/guidance\/submissions(?:\/[^/]+\/submit)?$/.test(path)
      || ['GET', 'HEAD', 'DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/guidance\/submissions\/[^/]+$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/task-sessions(?:\/[^/]+\/[^/]+)?$/.test(path)
      || ['GET', 'HEAD', 'DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/task-sessions\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/messages(?:\/[^/]+(?:\/media\/[^/]+)?)?$/.test(path)
      || ['POST', 'DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/messages\/[^/]+\/media\/[^/]+\/approval$/.test(path)
      || ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/connections\/[^/]+\/media\/inbound\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/token-usage(?:\/export|\/snapshots\/[^/]+)?$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/sessions\/[^/]+\/token-usage\/snapshots$/.test(path))) return next();
    if (deps.administrative && c.req.method === 'POST' && /^\/api\/hub\/v1\/completions\/(?:summary|observe|read)$/.test(path)) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/connections\/[^/]+\/website-actions\/(?:catalog\/[^/]+|[^/]+)$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/website-actions(?:\/[^/]+\/execute)?$/.test(path)
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/connections\/[^/]+\/website-actions\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      c.req.method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/website-access(?:\/[^/]+\/(?:resource|browser))?$/.test(path)
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/connections\/[^/]+\/website-access\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/connections\/[^/]+\/terminals\/(?:targets|[^/]+\/output)$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/terminals(?:\/[^/]+\/(?:input|resize))?$/.test(path)
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/connections\/[^/]+\/terminals\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/connections\/[^/]+\/websites\/(?:catalog|[^/]+\/snapshot)$/.test(path)
      || ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/automation(?:\/configuration\/[^/]+)?$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/sessions\/[^/]+\/automation\/configuration\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/sessions\/[^/]+\/(?:interactions|skills|files)$/.test(path)
      || c.req.method === 'PATCH' && /^\/api\/hub\/v1\/sessions\/[^/]+\/interaction-mode$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/sessions\/[^/]+\/interactions\/[^/]+\/answer$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/sessions\/[^/]+\/files\/rebuild(?:\/[^/]+)?$/.test(path)
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/sessions\/[^/]+\/files\/rebuild\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      c.req.method === 'POST' && path === `${base}/usage-manifests`
      || ['GET','HEAD','DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/usage-manifests\/[^/]+$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/usage-manifests\/[^/]+\/(?:confirm|continue)$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD', 'PUT'].includes(c.req.method) && path === `${base}/workspace/preferences`
      || ['GET', 'HEAD', 'PUT'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/layouts\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && path === `${base}/workspace/browser/config`
      || c.req.method === 'POST' && path === `${base}/workspace/browser/sessions`
      || ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/browser\/sessions\/[^/]+\/frame$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/browser\/sessions\/[^/]+\/actions$/.test(path)
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/workspace\/browser\/sessions\/[^/]+$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && path === `${base}/workspace/research/config`
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/research\/(?:search|synthesize|read(?:\/synthesize(?:-many)?)?)$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD', 'POST'].includes(c.req.method) && path === `${base}/workspace/remote/devices`
      || ['PUT', 'DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/remote\/devices\/[^/]+$/.test(path)
      || ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/remote\/devices\/[^/]+\/receive$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/remote\/devices\/[^/]+\/(?:commands|ack)$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD'].includes(c.req.method) && (path === `${base}/quick-chat` || /^\/api\/hub\/v1\/quick-chat\/requests\/[^/]+$/.test(path))
      || c.req.method === 'PUT' && /^\/api\/hub\/v1\/quick-chat\/profiles\/[^/]+$/.test(path)
      || c.req.method === 'POST' && (path === `${base}/quick-chat/requests` || /^\/api\/hub\/v1\/quick-chat\/requests\/[^/]+\/cancel$/.test(path))
      || c.req.method === 'DELETE' && /^\/api\/hub\/v1\/quick-chat\/requests\/[^/]+\/result$/.test(path))) return next();
    if (deps.administrative && (
      ['GET', 'HEAD', 'POST'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/bindings$/.test(path)
      || ['GET', 'HEAD', 'DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/bindings\/[^/]+$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/bindings\/[^/]+\/cancel-intent$/.test(path))) return next();
    if (deps.administrative && deps.fileCardClient && (
      c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/(?:migrate|migrations\/[^/]+\/recover|writes\/[^/]+\/[^/]+\/recover)$/.test(path)
      || c.req.method === 'PUT' && /^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/document$/.test(path)
      || ['GET','HEAD'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+(?:\/(?:migrations\/[^/]+|writes\/[^/]+\/[^/]+))?$/.test(path))) return next();
    if (deps.administrative && deps.fileCardClient && deps.asyncConnectorClient && (
      ['GET','HEAD','PUT','DELETE'].includes(c.req.method)&&/^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/bindings\/[^/]+$/.test(path)
      ||['GET','HEAD'].includes(c.req.method)&&/^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/bindings\/[^/]+\/(?:conflicts|proposals\/[^/]+)$/.test(path)
      ||c.req.method==='POST'&&/^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/bindings\/[^/]+\/(?:sync|resolve)$/.test(path)
      ||['GET','HEAD','PUT','DELETE'].includes(c.req.method)&&/^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/batches\/[^/]+$/.test(path)
      ||c.req.method==='POST'&&/^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+\/batches\/[^/]+\/confirm$/.test(path))) return next();
    if (deps.administrative && (
      c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/delegations$/.test(path)
      || ['GET','HEAD','DELETE'].includes(c.req.method) && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/delegations\/[^/]+$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/delegations\/[^/]+\/confirm$/.test(path))) return next();
    if (deps.asyncIssuerManagement && (['GET', 'HEAD', 'PUT', 'DELETE'].includes(c.req.method)
      && /^\/api\/hub\/v1\/connections\/[^/]+\/execution-issuer$/.test(path)
      || c.req.method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/execution-issuer\/local$/.test(path))) return next();
    if (deps.asyncCreationDiscovery && ['GET', 'HEAD'].includes(c.req.method) && path === `${base}/shared/creation-environments`) return next();
    if (deps.asyncSharedCreation && (c.req.method === 'POST'
      && /^\/api\/hub\/v1\/shared\/[^/]+\/connections\/[^/]+\/agents\/[^/]+\/sessions$/.test(path)
      || ['GET', 'HEAD'].includes(c.req.method)
      && /^\/api\/hub\/v1\/shared\/[^/]+\/connections\/[^/]+\/agents\/[^/]+\/sessions\/creation-commands\/[^/]+$/.test(path))) return next();
    // This one owner SSE entry owns its async proof/scope and per-frame checks.
    if (deps.administrative && isHubConnectionFileRequest(c.req.method, path)) return next();
    if (deps.administrative && isHubConnectionControlRequest(c.req.method, path)) return next();
    if (deps.administrative && isHubConnectionVerificationRequest(c.req.method, path)) return next();
    if (deps.administrative && deps.asyncConnectorClient && ['GET', 'HEAD', 'POST'].includes(c.req.method)
      && /^\/api\/hub\/v1\/connections\/[^/]+\/ahp$/.test(path)) return next();
    if (deps.administrative && isHubDockerSandboxRequest(c.req.method, path)) return next();
    if (deps.asyncEvents && ['GET', 'HEAD'].includes(c.req.method) && path === `${base}/events/stream`) return next();
    if (deps.asyncSharedReads && ['GET', 'HEAD'].includes(c.req.method)
      && /^\/api\/hub\/v1\/shared\/[^/]+\/sessions\/[^/]+\/(?:state|messages(?:\/[^/]+(?:\/media\/[^/]+)?)?|events\/stream)$/.test(path)) return next();
    const initialActor = authenticate(c.req.raw);
    if (!initialActor) return c.json({ error: 'unauthorized' }, 401);
    const authority = pinHubRequestAuthority(initialActor, () => authenticate(c.req.raw));
    const actor = authority.principal;
    // Native EventSource cannot set headers. This public correlation marker is
    // accepted in the stream URL only; it is never an authentication token.
    const expectedScope = c.req.header('x-agentopsdeck-recovery-scope')
      ?? (path.endsWith('/events/stream') && path.startsWith(`${base}/`) ? c.req.query('recoveryScope') : undefined);
    if (expectedScope !== undefined && expectedScope !== deps.hubStore.identities.recoveryScope(actor)) {
      return c.json({ error: 'Authenticated account or Hub changed; reload before continuing' }, 409);
    }
    c.set('hubPrincipal', actor);
    c.set('hubAuthorize', authority.check);
    // Only the exact private Weixin Request can enter this lane. The fixed
    // owner-control command rechecks the current binding, original confirmed
    // run and exact /stop payload inside its transaction. Do not read the old
    // main-thread directory first, or generalize this to arbitrary internals.
    if (deps.asyncOwnerControl && weixinRequestBinding(c.req.raw) && c.req.method === 'POST'
      && /^\/api\/hub\/v1\/sessions\/[^/]+\/messages$/.test(path)) return next();
    if (!actor.admin && path.startsWith(`${base}/users`) && (c.req.method !== 'GET' || path !== `${base}/users`)) return c.json({ error: 'forbidden' }, 403);
    // Node ownership is the initial grant boundary; no body/query user ID can
    // select another user's directory, credentials, preferences or delivery log.
    const sessionMatch = /^\/api\/(?:hub\/v1\/)?sessions\/([^/]+)/.exec(path);
    // Only the aggregate read has no session ID. A mutation named "state"
    // must not skip validation and fall through to an administrator's legacy API.
    const aggregateRead = ['GET', 'HEAD'].includes(c.req.method) && path === `${base}/sessions/state`;
    if (sessionMatch && !aggregateRead) {
      let sessionId: string;
      try { sessionId = decodeURIComponent(sessionMatch[1]!); } catch { return c.json({ error: 'invalid session ID' }, 400); }
      const decoded = decodeHubSessionId(sessionId);
      const canonical = decoded && encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) === sessionId;
      if (!canonical) return actor.admin && !path.startsWith(base) ? next() : c.json({ error: 'session not found' }, 404);
      const connection = deps.hubStore.getConnection(decoded.connectionId, actor.userId);
      if (!connection || connection.status === 'disabled') return c.json({ error: 'session not found' }, 404);
    }
    await next();
    // Do not disclose a buffered upstream response after its login was revoked.
    // Already-admitted execution is not interrupted by this delivery gate.
    try { principal(c); }
    catch {
      const previous = c.res;
      c.header('Cache-Control', 'no-store');
      c.res = c.json({ error: 'unauthorized' }, 401);
      void previous.body?.cancel().catch(() => {});
      return c.res;
    }
  });

  const storageRoutes = registerStorageDiagnostics(app, `${base}/maintenance/storage`, systemAccess ? {
    access: async c => {
      const invoke = async <T>(work: () => Promise<T>) => {
        try { return await work(); }
        catch (e) { if (e instanceof HubMemberRequestError) throw new HTTPException(e.status === 499 ? 503 : e.status); throw e; }
      };
      const handle = await invoke(() => systemAccess.requests.begin(c.req.raw));
      if (!handle.principal.admin) throw new HTTPException(403);
      return { check: () => invoke(handle.check), stats: () => invoke(() => handle.storage('stats')),
        recovery: () => invoke(() => handle.storage('recovery')), checkpoint: () => invoke(() => handle.storage('checkpoint')) };
    }, history: historyDiagnostics,
  } : {
    authorize: c => { const check = () => { if (!principal(c).admin) throw new HTTPException(403); }; check(); return check; },
    recovery: () => deps.hubStore.storageRecovery(),
    stats: () => deps.hubStore.storageStats(), checkpoint: check => deps.hubStore.checkpointStorage(check), history: historyDiagnostics,
  });
  const metricsHubId = deps.hubId ?? deps.hubStore.identities.hubId;
  const metricsSampler = new MetricsSampler({ kind: 'hub', id: metricsHubId }, linuxMetricsProvider(deps.config.metricVolumes));
  const metricsRoutes = asyncMetrics ? registerAsyncHubMetrics(app, systemAccess.requests, asyncMetrics, metricsHubId, metricsSampler)
    : registerHubMetrics(app, deps.hubStore, principal, deps.connectorClient, metricsSampler);
  const drainSystemRoutes = createIndependentDrain([() => metricsRoutes.close(), () => storageRoutes.close()], 'hub-route-drain');
  const closeSystemRoutes = async () => { await drainSystemRoutes(); await systemAccess?.close(); };
  if (!(deps.administrative && deps.asyncConnectorClient)) app.get(`${base}/me`, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(principal(c));
  });
  const fileTarget = (client: ConnectorClientResolver) => (userId: string, sessionId: string) => {
      const decoded = decodeHubSessionId(sessionId);
      if (!decoded || !/^(codex|claude-code|ghcp|antigravity):/.test(decoded.remoteSessionKey)) throw new HubFileBoardError(400);
      const connection = deps.hubStore.getConnection(decoded.connectionId, userId);
      const authority = deps.hubStore.connectionAuthority(decoded.connectionId, userId);
      if (!connection?.nodeId || connection.status === 'disabled' || authority === undefined) throw new HubFileBoardError(404);
      return { connectionId: decoded.connectionId, authority, sessionKey: decoded.remoteSessionKey,
        client: client(decoded.connectionId, false, userId), valid: () => {
          if (deps.hubStore.connectionAuthority(decoded.connectionId, userId) !== authority) throw new HubFileBoardError(403);
        } };
    };
  const asyncFileTransport = !!(deps.administrative && deps.asyncConnectorClient && (deps.fileBoardClient || deps.fileCardClient));
  const fileBoards = deps.fileBoardClient && !asyncFileTransport ? new HubFileBoardService(
    deps.hubStore.boardFiles, deps.hubStore.boards, fileTarget(deps.fileBoardClient)) : undefined;
  const fileCards = deps.fileCardClient && !asyncFileTransport ? new HubFileCardService(deps.hubStore.cardFiles, fileTarget(deps.fileCardClient)) : undefined;
  const nativeFiles = asyncFileTransport && deps.administrative && deps.asyncConnectorClient
    ? deps.administrative.createNativeFiles(deps.asyncConnectorClient) : undefined;
  const nativeFileBackgroundAccess = nativeFiles && deps.asyncConnectorClient?.nativeFileBackground
    ? deps.administrative!.createNativeFileBackgroundAccess() : undefined;
  const nativeFileBackground = nativeFileBackgroundAccess ? new AsyncNativeFileBackground(nativeFileBackgroundAccess,
    reference => deps.asyncConnectorClient!.nativeFileBackground!(nativeFileBackgroundAccess, reference)) : undefined;
  const hasSharedContentTransport=!!deps.fileCardClient;
  // Only partial/legacy compositions need the synchronous route fallback.
  // Full async compositions must not open a second content coordinator.
  const sharedContent=deps.fileCardClient&&(!deps.administrative||!deps.asyncConnectorClient)?deps.hubStore.createContentCoordinator((owner,sessionId)=>{
    const target=fileTarget(deps.contentReplicaClient??deps.fileCardClient!)(owner,sessionId);
    return {...target,sessionId,transport:contentReplicaTransport(target.client)};
  }):undefined;
  const contentDocuments=hasSharedContentTransport&&deps.administrative?registerAsyncHubContentDocuments(app,{
    access:deps.administrative.createContentDocumentAccess(),enabled:()=>!!deps.config.boardFilesEnabled}):undefined;
  const contentOverview=hasSharedContentTransport&&deps.administrative?registerAsyncHubContentOverview(app,{
    access:deps.administrative.createContentDocumentAccess(),enabled:()=>!!deps.config.boardFilesEnabled}):undefined;
  const contentBindings=hasSharedContentTransport&&deps.administrative&&deps.asyncConnectorClient?registerAsyncHubContentBindings(app,{
    access:deps.administrative.createContentDocumentAccess(),enabled:()=>!!deps.config.boardFilesEnabled,
    transport:async(request,target)=>contentReplicaTransport(await deps.asyncConnectorClient!(request,target.connectionId,{boardBindingsOnly:'content-replicas'})),
  }):undefined;
  const contentBatches=hasSharedContentTransport&&deps.administrative&&deps.asyncConnectorClient?registerAsyncHubContentBatches(app,{
    access:deps.administrative.createContentDocumentAccess(),enabled:()=>!!deps.config.boardFilesEnabled,
    clients:deps.asyncConnectorClient,
    transport:async(request,target)=>contentReplicaTransport(await deps.asyncConnectorClient!(request,target.connectionId,{boardBindingsOnly:'content-replicas'})),
  }):undefined;
  const contentBackgroundAccess=hasSharedContentTransport&&deps.administrative&&deps.asyncConnectorClient?.contentBackground
    ? deps.administrative.createContentBackgroundAccess() : undefined;
  const contentBackground=contentBackgroundAccess
    ? new AsyncContentBackground(contentBackgroundAccess,
      async reference=>contentReplicaTransport(await deps.asyncConnectorClient!.contentBackground!(contentBackgroundAccess!,reference)),
      ()=>!!deps.config.boardFilesEnabled) : undefined;
  if(sharedContent){
    const batches=contentBatches?undefined:deps.hubStore.createContentBatches(sharedContent,delegationDirectory(deps.hubStore,deps.connectorClient));
    registerHubWorkspaceContent(app,{coordinator:sharedContent,...(batches?{batches}:{}),principal,asyncDocuments:!!contentDocuments,asyncOverview:!!contentOverview,asyncBindings:!!contentBindings,
      asyncBatches:!!contentBatches,native:(owner,resource)=>deps.hubStore.cardFileProjection.get(owner,resource),enabled:()=>!!deps.config.boardFilesEnabled});
    if(!deps.administrative&&deps.config.boardFilesEnabled)sharedContent.start(()=>!!deps.config.boardFilesEnabled);
  }
  if(contentBackground&&deps.config.boardFilesEnabled)contentBackground.start();
  // HTTP cancellation only ends delivery. This owner retains each original
  // read until settlement, and its independent shutdown lane precedes DB close.
  const workspaceReadOwner = new AuthRoutePersistence();
  const workspaceReadWait = new AuthRouteReadWait(workspaceReadOwner);
  const nativeFileDeps = { hubStore: deps.hubStore, principal, readWait: workspaceReadWait, ...(fileCards ? { fileCards } : {}), fileCardsEnabled: !!deps.config.boardFilesEnabled };
  const notebookMachine = nativeFiles && deps.administrative ? deps.administrative.createNotebookMachine(nativeFiles) : undefined;
  const visualEditorDeps = nativeFiles && deps.administrative
    ? {mode: 'async' as const, nativeFiles, editorAccess: deps.administrative.members,
      fileCardsEnabled: !!deps.config.boardFilesEnabled, visuals: deps.administrative.visuals}
    : {...nativeFileDeps, ...(deps.administrative ? {visuals: deps.administrative.visuals} : {})};
  registerHubSessionNotebookRoutes(app, nativeFiles && notebookMachine && deps.administrative
    ? {mode: 'async', nativeFiles, notebookMachine, editorAccess: deps.administrative.members,
      fileCardsEnabled: !!deps.config.boardFilesEnabled, privateNotebooks: deps.administrative.privateNotebooks,
      sessionNotebooks: deps.administrative.privateNotebooks, notebookControl: deps.administrative.notebookControl}
    : { ...nativeFileDeps, ...(deps.administrative
    ? { privateNotebooks: deps.administrative.privateNotebooks, sessionNotebooks: deps.administrative.privateNotebooks,
      notebookControl: deps.administrative.notebookControl } : {}) });
  const completions = deps.administrative ? registerHubCompletionRoutes(app, {
    principal: c => deps.administrative!.completions.principal(c.req.raw), port: deps.administrative.completions,
    atomicDeliveryAuthority: true, readWait: workspaceReadWait,
  }) : registerHubCompletions(app, deps.hubStore, principal, workspaceReadWait);
  registerHubWorkspaceBoardRoutes(app, nativeFiles && deps.administrative
    ? {mode: 'async', nativeFiles, editorAccess: deps.administrative.members,
      fileCardsEnabled: !!deps.config.boardFilesEnabled, boards: deps.administrative.boards,
      capabilities: deps.administrative.boardCapabilities}
    : { ...nativeFileDeps, ...(deps.administrative
      ? { boards: deps.administrative.boards, capabilities: deps.administrative.boardCapabilities } : {}) });
  if (nativeFiles && deps.administrative) registerHubCardFiles(app, {mode: 'async', nativeFiles,
    editorAccess: deps.administrative.members, configurations: deps.administrative.configurations,
    projections: deps.administrative.projections, reports: deps.administrative.reports, enabled: !!deps.config.boardFilesEnabled});
  else registerHubCardFiles(app, { store: deps.hubStore, principal, ...(deps.administrative ? { bindingReads: deps.administrative.fileBindingReads, configurations: deps.administrative.configurations, projections: deps.administrative.projections, reports: deps.administrative.reports } : {}), ...(fileCards ? { service: fileCards } : {}), enabled: !!deps.config.boardFilesEnabled });
  if (fileCards && !nativeFileBackground && deps.config.boardFilesEnabled) fileCards.start();
  if (nativeFiles && deps.fileBoardClient) {
    registerHubBoardFiles(app, {mode: 'async', nativeFiles, enabled: !!deps.config.boardFilesEnabled});
  } else if (fileBoards) {
    registerHubBoardFiles(app, { principal, ...(nativeFiles ? {nativeFiles} : {}), ...(deps.administrative ? { bindingReads: deps.administrative.fileBindingReads } : {}), files: deps.hubStore.boardFiles, service: fileBoards, enabled: !!deps.config.boardFilesEnabled });
    if (!nativeFileBackground && deps.config.boardFilesEnabled) fileBoards.start();
  } else app.get(`${base}/workspace/boards/:boardId/file-binding`, async c => {
    c.header('Cache-Control', 'no-store');
    const actor = principal(c), owner = actor.userId, admin = actor.admin, resourceId = c.req.param('boardId');
    try {
      // Legacy no-service requests for malformed IDs return an empty binding.
      const binding = deps.administrative
        ? validBoardId(resourceId) ? await deps.administrative.fileBindingReads.read(c.req.raw, owner, { domain: 'board', action: 'current', resourceId }) : null
        : deps.hubStore.boardFiles.current(owner, resourceId);
      const current = principal(c);
      if (current.userId !== owner || current.admin !== admin) throw new HTTPException(401);
      return c.json({ enabled: false, binding: binding ? publicFileBoardBinding(binding) : null });
    } catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'File binding temporarily unavailable' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      return c.json({ error: 'File binding temporarily unavailable' }, error.status);
    }
  });
  if (nativeFileBackground && deps.config.boardFilesEnabled) nativeFileBackground.start();
  const boardBindings = deps.administrative
    ? registerAsyncHubBoardBindings(app, {access: deps.administrative.createBoardBindingAccess(),
      ...(deps.config.boardAgentEndpoint ? {endpoint: deps.config.boardAgentEndpoint} : {}),
      ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})})
    : registerHubBoardBindings(app, {hubStore: deps.hubStore, principal,
      connectorClient: deps.boardBindingClient ?? deps.connectorClient, endpoint: deps.config.boardAgentEndpoint,
      ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})});
  const delegations = deps.administrative
    ? registerAsyncHubDelegations(app, {access: deps.administrative.createDelegationAccess(),
      ...(deps.config.boardAgentEndpoint ? {endpoint: deps.config.boardAgentEndpoint} : {}),
      ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})})
    : registerHubDelegations(app, {hubStore: deps.hubStore, principal, connectorClient: deps.boardBindingClient ?? deps.connectorClient,
      endpoint: deps.config.boardAgentEndpoint, ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})});
  const usageManifests = deps.administrative
    ? registerAsyncHubUsageManifests(app, {access: deps.administrative.createUsageManifestAccess(),
      ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})})
    : registerHubUsageManifests(app, {hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
      ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})});
  const sessionGuidance = deps.administrative && deps.asyncConnectorClient
    ? registerAsyncHubSessionGuidance(app, {mode:'async',guidance:deps.administrative.createGuidanceAccess(),asyncConnectorClient:deps.asyncConnectorClient})
    : deps.administrative
    ? registerAsyncHubSessionGuidance(app, { guidance: deps.administrative.guidance,
      connectorClient: (_request, connectionId, userId) => deps.connectorClient(connectionId, false, userId) })
    : registerHubSessionGuidance(app, { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient });
  const connectionProxyDeps = () => deps.administrative && deps.asyncConnectorClient
    ? {mode: 'async' as const, access: deps.administrative.createConnectionProxyAccess(), asyncConnectorClient: deps.asyncConnectorClient}
    : {hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
      ...(deps.administrative ? {access: deps.administrative.createConnectionProxyAccess()} : {}),
      ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {})};
  const automation = registerHubAutomation(app, connectionProxyDeps());
  const tokenUsage = registerHubTokenUsage(app, connectionProxyDeps());
  const taskSessions = registerHubTaskSessions(app, deps.administrative && deps.asyncConnectorClient
    ? {mode:'async',...deps.administrative.createTaskSessionServices(deps.asyncConnectorClient),asyncConnectorClient:deps.asyncConnectorClient,endpoint:deps.config.boardAgentEndpoint}
    : { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}),
    ...(deps.boardBindingClient ? { bindingClient: deps.boardBindingClient } : {}), endpoint: deps.config.boardAgentEndpoint });
  registerHubWorkspaceCards(app, visualEditorDeps);
  registerHubWorkspaceDrawingRoutes(app, visualEditorDeps);
  registerHubNativeDrawioRoutes(app, { ...visualEditorDeps, editorUrl: deps.config.hub.drawioEditorUrl });
  const websites = registerHubWebsiteRoutes(app, connectionProxyDeps());
  const ahp = registerHubAhp(app, connectionProxyDeps());
  const research = registerHubResearchRoutes(app, { config: deps.config.hub.research,
    ...(deps.administrative ? { mode: 'async' as const, access: deps.administrative.createWorkspaceResearchAccess() }
      : { principal, audit: deps.hubStore.identities.audit }),
    modelCatalog: { discoverModels: true,
      ...(deps.config.codex.modelProvider === 'litellm' ? { defaultModel: deps.config.codex.defaultModel } : {}) } });
  const quickChat = registerHubQuickChat(app, {
    ...(deps.administrative ? { mode: 'async' as const, recovery: deps.administrative.quickChatRecovery } : { principal }),
    service: new QuickChatService(deps.administrative ? undefined : deps.hubStore.quickChat,
    deps.config.hub.research?.synthesis, fetch, 45_000, { discoverModels: true,
      ...(deps.administrative ? { persistence: deps.administrative.createQuickChatExecution() } : {}),
      ...(deps.config.codex.modelProvider === 'litellm' ? { defaultModel: deps.config.codex.defaultModel } : {}) }) });
  const remote = registerHubRemoteRoutes(app, deps.administrative
    ? { mode: 'async', access: deps.administrative.createWorkspaceRemoteAccess() }
    : { principal, audit: deps.hubStore.identities.audit });
  const weixinTransport = deps.weixinTransport ?? new HttpWeixinTransport();
  const weixinBackground = deps.administrative?.createWeixinBackgroundAccess();
  const weixin = weixinBackground ? new WeixinService({ mode: 'async', background: weixinBackground, transport: weixinTransport,
    bridge: weixinBridge(app, { mode: 'async', access: weixinBackground, internal }) })
    : new WeixinService(deps.hubStore.weixin, weixinTransport, weixinBridge(app, deps.hubStore, internal),
      (userId, reason, ok) => { deps.hubStore.identities.audit.append({ event: 'api_authz', outcome: ok ? 'success' : 'failure', userId, reason }); });
  const weixinRoutes = registerHubWeixin(app, deps.administrative
    ? { service: weixin, access: deps.administrative.createWeixinAccess(), transport: weixinTransport }
    : { store: deps.hubStore, service: weixin, principal,
      ...(deps.weixinAdministrator ? { administrator: deps.weixinAdministrator } : {}) });
  const terminalAccess = deps.administrative?.createTerminalAccess();
  const terminals = registerHubTerminals(app, terminalAccess && deps.asyncConnectorClient ? {
    mode: 'async', access: terminalAccess.access, asyncConnectorClient: deps.asyncConnectorClient,
    audit: terminalAccess.audit, closeAccess: terminalAccess.close,
  } : { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
    audit: terminalAccess ? terminalAccess.audit : deps.hubStore.identities.audit,
    ...(terminalAccess ? { access: terminalAccess.access, closeAccess: terminalAccess.close } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}) });
  const browser = registerHubBrowser(app, { config: deps.config.hub.browser,
    ...(deps.administrative ? { mode: 'async' as const, access: deps.administrative.createWorkspaceBrowserAccess() }
      : { principal, audit: deps.hubStore.identities.audit }) });
  const websiteActionAccess = deps.administrative?.createWebsiteActionAccess();
  const websiteActions = registerHubWebsiteActions(app, websiteActionAccess && deps.asyncConnectorClient ? {
    mode: 'async', access: websiteActionAccess.access, asyncConnectorClient: deps.asyncConnectorClient,
    audit: websiteActionAccess.audit, closeAccess: websiteActionAccess.close,
  } : { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
    ...(websiteActionAccess ? { access: websiteActionAccess.access, audit: websiteActionAccess.audit, closeAccess: websiteActionAccess.close } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}) });
  const websiteAccessAuthority = deps.administrative?.createWebsiteAccess();
  const websiteAccess = registerHubWebsiteAccess(app, websiteAccessAuthority && deps.asyncConnectorClient ? {
    mode: 'async', access: websiteAccessAuthority.access, asyncConnectorClient: deps.asyncConnectorClient,
    closeAccess: websiteAccessAuthority.close,
    ...(deps.websiteGateway ? { gateway: deps.websiteGateway } : {}),
  } : { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
    ...(websiteAccessAuthority ? { access: websiteAccessAuthority.access, closeAccess: websiteAccessAuthority.close } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}),
    ...(deps.websiteGateway ? { gateway: deps.websiteGateway } : {}) });
  const workspacePreferences = registerHubWorkspacePreferences(app, deps.administrative ? {
    principal: c => deps.administrative!.workspace.principal(c.req.raw), port: deps.administrative.workspace,
    readWait: workspaceReadWait,
  } : { principal, synchronousStoreAuthority: principal, readWait: workspaceReadWait, port: {
    get: (_request, userId) => deps.hubStore.workspacePreferencesAsync(userId),
    save: (_request, userId, document) => deps.hubStore.workspace.save(userId, document),
  } });
  const workspaceLayouts = registerHubWorkspaceLayouts(app, deps.administrative ? {
    principal: c => deps.administrative!.layouts.principal(c.req.raw), port: deps.administrative.layouts,
    readWait: workspaceReadWait,
  } : { principal, synchronousStoreAuthority: principal, readWait: workspaceReadWait, port: {
    get: (_request, userId, kind) => deps.hubStore.workspaceLayoutAsync(userId, kind),
    save: (_request, userId, kind, value) => deps.hubStore.layouts.save(userId, kind, value),
  } });
  app.use(`${base}/users/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  if (deps.administrative) registerAsyncHubMemberKeys(app, deps.administrative.members, !!deps.config.accessKey);
  else {
  app.post(`${base}/users/:userId/login-keys`, (c) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.config.accessKey) return c.json({ error: 'Configure an administrator access key before enabling member logins' }, 409);
    try { return c.json(deps.hubStore.identities.issueKey(c.req.param('userId'), { actorUserId: principal(c).userId, ...fingerprintRequest(c.req.raw) }), 201); }
    catch { return c.json({ error: 'Cannot issue login key' }, 400); }
  });
  app.get(`${base}/users/:userId/login-keys`, (c) => c.json({ keys: deps.hubStore.identities.listKeys(c.req.param('userId')) }));
  app.delete(`${base}/users/:userId/login-keys/:keyId`, (c) => c.json({
    ok: deps.hubStore.identities.revokeKey(c.req.param('userId'), c.req.param('keyId'), { actorUserId: principal(c).userId, ...fingerprintRequest(c.req.raw) }),
  }));
  }

  registerHubExecutionIssuerRoutes(app, { hubStore: deps.hubStore, principal, local: deps.localIssuerTransport,
    operator: deps.localExecutionOperator, ...(deps.asyncIssuerManagement ? { asyncManagement: deps.asyncIssuerManagement } : {}) });
  registerHubMaintenanceRoutes(app, { store: deps.hubStore, principal, local: deps.localMaintenanceTransport,
    ...(deps.asyncMaintenance ? { asyncMaintenance: deps.asyncMaintenance } : {}) });
  registerHubLifecycleRoutes(app, { store: deps.hubStore, principal,
    ...(deps.asyncLifecycle ? { asyncLifecycle: deps.asyncLifecycle } : {}) });
  registerHubNodeGrantRoutes(app, { hubStore: deps.hubStore, principal,
    ...(deps.administrative ? { asyncGrants: deps.administrative.grants, asyncReceived: deps.administrative.received } : {}) });
  registerHubRoleAccessRoutes(app, { hubStore: deps.hubStore, principal,
    ...(deps.administrative ? { asyncRoles: deps.administrative.roles,
      asyncMemberships: deps.administrative.memberships, asyncDirectory: deps.administrative.directory } : {}) });
  registerHubSharedDirectoryRoutes(app, { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
    ...(!sharedSessions && deps.asyncSharedDirectory ? { asyncDirectory: deps.asyncSharedDirectory } : {}) });
  registerHubSharedCommandRoutes(app, { hubStore: deps.hubStore, principal, sync: deps.executionSync, local: deps.localIssuerTransport,
    ...(!sharedSessions && deps.asyncSharedCommands ? { asyncSharedCommands: deps.asyncSharedCommands } : {}) });
  registerHubSharedCreationRoutes(app, { hubStore: deps.hubStore, principal, local: deps.localIssuerTransport,
    asyncCreation: deps.asyncSharedCreation, asyncDiscovery: deps.asyncCreationDiscovery });
  registerHubSessionSharingRoutes(app, { hubStore: deps.hubStore, principal,
    ...(deps.administrative ? { asyncCollaborators: deps.administrative.collaborators, asyncSharing: deps.administrative.sharing } : {}) });
  registerHubOwnedSessionSharingRoutes(app, { hubStore: deps.hubStore, principal,
    ...(deps.administrative ? { asyncOwnedSharing: deps.administrative.ownedSharing } : {}) });
  registerHubSharedReadRoutes(app, { hubStore: deps.hubStore, principal, connectorClient: deps.connectorClient,
    ...(!sharedSessions && deps.asyncSharedReads ? { asyncSharedReads: deps.asyncSharedReads } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), brokers });
  const legacyWorkspaceSync = registerHubWorkspaceSync(app, { store: deps.hubStore, client: deps.connectorClient, owner, wrap: wrapMessage,
    ...(deps.administrative ? { access: deps.administrative.members } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}) });

  const hubInfo = presentHubInfo(deps.config);

  const discovery = deps.administrative && deps.asyncConnectorClient ? registerAsyncHubDiscovery(app, {
    mode: 'async', access: deps.administrative.createDiscoveryAccess(), asyncConnectorClient: deps.asyncConnectorClient,
    info: hubInfo, ...(deps.sessionStateResponseLimits ? { responseLimits: deps.sessionStateResponseLimits } : {}),
  }) : undefined;
  if (!discovery) app.get(`${base}/info`, c => c.json(hubInfo));

  if (!discovery) registerHubAccountDirectory(app, {
    store: deps.hubStore, principal, present: publicConnectionsWithUsers,
    ...(deps.administrative ? { access: deps.administrative.members } : {}),
  });

  if (deps.administrative) registerHubUserMutations(app, {
    normalizeError: deps.normalizeError,
    begin: c => {
      const raw = c.req.raw;
      return deps.administrative!.members.begin(new Request(raw.url, { headers: new Headers(raw.headers), signal: raw.signal }));
    },
  });
  else registerSynchronousHubUserMutations(app, deps.hubStore, principal, deps.normalizeError);

  // Exact internal actors retain the old lane; external selected requests are
  // already dispatched into the async-only subapp, never error-fallback here.
  const connectorUserDisplay = registerHubConnectorUserDisplay(app, {
    ...(deps.administrative ? { access: deps.administrative.members } : {}),
    store: deps.hubStore, principal, client: deps.connectorClient,
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}),
    present: (connection, users, supported, remoteUsers, error) => publicConnectorUserConnection(
      connection, users, supported,
      remoteUsers.map(normalizeRemoteConnectorUser).filter((user): user is ConnectorUser => Boolean(user)), error),
  });

  app.post(`${base}/connections/:connectionId/connector-users`, async (c) => {
    return proxyConnectorUserMutation(c, deps, 'POST');
  });

  app.patch(`${base}/connections/:connectionId/connector-users/:userId`, async (c) => {
    return proxyConnectorUserMutation(c, deps, 'PATCH', c.req.param('userId'));
  });

  const connectionMutations = deps.administrative ? registerAsyncHubConnectionMutations(app, {
    requests: deps.administrative.members, present: publicConnectionWithUser,
  }) : undefined;
  if (!deps.administrative) registerSynchronousHubConnectionMutations(app, {
    store: deps.hubStore, principal, present: publicConnectionWithUser,
  });

  registerHubDockerSandboxes(app, {
    base,
    principal,
    members: deps.administrative?.members,
  });

  if (!deps.administrative) app.post(`${base}/connections/:connectionId/verify`, async (c) => {
    const userId = owner(c), id = c.req.param('connectionId');
    const version = deps.hubStore.connectionAuthority(id, userId);
    if (version === undefined) return c.json({ error: 'connection not found' }, 404);
    try {
      const nodeId = await (await requestConnectorClient(deps, c.req.raw, id, false, userId)).identity(c.req.raw.signal);
      principal(c);
      try {
        const connection = deps.hubStore.pinConnectionNode(id, userId, version, nodeId);
        return c.json({ connection: publicConnection(connection) });
      } catch { return c.json({ error: 'Connector identity or authorization changed' }, 409); }
    } catch (error) { return connectorReadError(c, error); }
  });

  const connectionFiles = registerHubConnectionFiles(app, { ...connectionProxyDeps(), error: connectorReadError });
  const connectionControl = deps.administrative ? registerHubConnectionControl(app, {
    ...(deps.asyncConnectorClient ? {mode: 'async' as const, asyncConnectorClient: deps.asyncConnectorClient}
      : {connectorClient: deps.connectorClient}), error: connectorReadError,
    createAccess: () => deps.administrative!.createConnectionControlAccess(),
    ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {}),
  }) : undefined;
  const connectionVerification = deps.administrative ? registerHubConnectionVerification(app, {
    ...(deps.asyncConnectorClient ? {mode: 'async' as const, asyncConnectorClient: deps.asyncConnectorClient}
      : {connectorClient: deps.connectorClient}), error: connectorReadError,
    createAccess: () => deps.administrative!.createConnectionVerificationAccess(),
    defaultConnectionId: deps.config.hub.defaultConnectionId,
    present: (connection, users) => users ? publicConnectionWithUser(connection, users) : publicConnection(connection),
    ...(deps.asyncConnectorClient ? {asyncConnectorClient: deps.asyncConnectorClient} : {}),
  }) : undefined;
  // Legacy injected compositions retain their original branch. Administrative
  // production requests never fall back here, even on missing capabilities.
  if (!deps.administrative) {
  app.get(`${base}/connections/:connectionId/capabilities`, async (c) => proxyConnectorControl(c, deps, 'GET', 'capabilities', 'connector.capabilities.checked'));
  app.get(`${base}/connections/:connectionId/gateway/model-set`, async (c) => proxyConnectorControl(c, deps, 'GET', 'gateway/model-set', undefined, undefined, true));
  app.post(`${base}/connections/:connectionId/gateway/model-set/reconcile`, async (c) => {
    const raw = await c.req.json().catch(() => ({})) as { setId?: unknown; idempotencyKey?: unknown; dryRun?: unknown };
    if (raw.setId !== undefined && raw.setId !== AOD_MODEL_SET_ID) return c.json({ error: 'unsupported model set' }, 400);
    const body = { setId: AOD_MODEL_SET_ID, ...(typeof raw.idempotencyKey === 'string' ? { idempotencyKey: raw.idempotencyKey } : {}), ...(raw.dryRun === true ? { dryRun: true } : {}) };
    return proxyConnectorControl(c, deps, 'POST', 'gateway/model-set/reconcile', 'gateway.model_set.reconciled', body, true);
  });
  app.get(`${base}/connections/:connectionId/update/status`, async (c) => proxyConnectorControl(c, deps, 'GET', 'update/status'));
  app.get(`${base}/connections/:connectionId/maintenance/status`, async context => {
    context.header('Cache-Control', 'no-store');
    return proxyConnectorControl(context, deps, 'GET', 'maintenance/status', undefined, undefined, true);
  });
  app.post(`${base}/connections/:connectionId/update/check`, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { channel?: 'stable' | 'candidate' };
    if (body.channel !== undefined && body.channel !== 'stable' && body.channel !== 'candidate') return c.json({ error: 'unsupported update channel' }, 400);
    return proxyConnectorControl(c, deps, 'POST', 'update/check', 'connector.update.checked', { channel: body.channel }, true);
  });
  }
  // Do not translate legacy writes into new commands: the caller may already
  // have dispatched the old request and has no durable recovery identity.
  registerRetiredHubUpdates(app);

  if (!deps.administrative) app.post(`${base}/connections/test`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await c.req.json().catch(() => undefined) as { connectorUrl?: string; token?: string } | undefined;
    const connectorUrl = normalizeConnectorUrl(body?.connectorUrl);
    if (connectorUrl && connectorUrl !== 'local://aod-connector') {
      return c.json(await testRemoteConnection(connectorUrl, body?.token, c.req.raw.signal));
    }
    const { userId, admin } = principal(c);
    try {
      const id = deps.config.hub.defaultConnectionId;
      const connection = deps.hubStore.getConnection(id, userId);
      const version = deps.hubStore.connectionAuthority(id, userId);
      const directoryVersion = deps.hubStore.connectionDirectoryVersion(userId);
      const current = () => {
        const actor = principal(c);
        if (actor.userId !== userId || actor.admin !== admin) throw new HTTPException(401);
        if (c.req.raw.signal.aborted) throw new ConnectorClientError(499, 'Connector request cancelled');
        if (deps.hubStore.connectionDirectoryVersion(userId) !== directoryVersion
          || deps.hubStore.connectionAuthority(id, userId) !== version)
          throw new ConnectorClientError(503, 'Connector authorization changed; refresh required');
      };
      // Display metadata uses the original scoped readonly worker. Failure
      // never falls back to a full synchronous users scan or publishes an
      // earlier connection/capabilities response after its authority changed.
      const users = await deps.hubStore.listUsersAsync(userId, admin);
      current();
      const connector = await (await requestConnectorClient(deps, c.req.raw, id, false, userId)).json('/capabilities', { signal: c.req.raw.signal });
      current();
      const response = c.json({ ok: true, connection: connection ? publicConnectionWithUser(connection, users) : undefined, connector, updatedAt: Date.now() });
      current();
      return response;
    } catch (error) {
      // A revoked principal outranks a concurrent readonly/capability failure.
      const actor = principal(c);
      if (actor.userId !== userId || actor.admin !== admin) throw new HTTPException(401);
      if (error instanceof HTTPException && error.status === 401) throw error;
      return connectorReadError(c, error);
    }
  });

  // Resolve stable references to compatibility routes without migrating
  // receipt keys or claiming that the native session already exists.
  if (!discovery) app.get(`${base}/session-reference`, (c) => {
    c.header('Cache-Control', 'no-store');
    const ref = { nodeId: c.req.query('nodeId') ?? '', runtimeId: c.req.query('runtimeId') ?? '', nativeSessionKey: c.req.query('nativeSessionKey') ?? '' };
    if (!isAgentRuntimeId(ref.runtimeId)) return c.json({ error: 'invalid session reference' }, 400);
    try {
      const resolved = deps.hubStore.resolveSessionReference({ ...ref, runtimeId: ref.runtimeId }, owner(c));
      if (!resolved) return c.json({ error: 'session reference unavailable or ambiguous' }, 404);
      return c.json({ sessionRef: ref, sessionKey: encodeHubSessionId(resolved.connectionId, resolved.remoteSessionKey) });
    } catch { return c.json({ error: 'invalid session reference' }, 400); }
  });

  if (!discovery) app.get(`${base}/sessions/state`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const observation = observeSessionState(c.req.raw.signal);
    let buffered = false, records = 0, reserved = false;
    let collector: ReturnType<ConnectorResponseBudgetPool['acquire']> | undefined;
    try {
      const { userId, admin } = principal(c);
      const pending = sessionStateReads;
      if (pending >= maxSessionStateReads) {
        observation.admission(pending, false);
        return c.json({ error: 'hub_session_reads_busy' }, 503);
      }
      sessionStateReads++; reserved = true;
      collector = responseBudget.acquire(requestResponseBytes);
      observation.admission(pending, true);
      const current = () => {
        const actor = principal(c);
        if (actor.userId !== userId || actor.admin !== admin) {
          observation.changed(); throw new HTTPException(401, { message: 'unauthorized' });
        }
      };
      const includeHidden = c.req.query('includeHidden') === '1' || c.req.query('includeHidden') === 'true';
      const includeArchived = c.req.query('includeArchived') === '1' || c.req.query('includeArchived') === 'true';
      const access = await deps.administrative?.members.begin(c.req.raw);
      current();
      if (c.req.raw.signal.aborted || deps.administrative && !access) return c.json({ error: 'hub_sessions_unavailable' }, 503);
      if (access && (access.principal.userId !== userId || access.principal.admin !== admin)) throw new HTTPException(401);
      const initialState = await access?.sessionState();
      current();
      if (c.req.raw.signal.aborted || access && !initialState) return c.json({ error: 'hub_sessions_unavailable' }, 503);
      let users: Awaited<ReturnType<typeof deps.hubStore.listUsersAsync>>;
      try { users = initialState ? initialState.users : await deps.hubStore.listUsersAsync(userId, admin); }
      catch {
        current(); // Current revocation outranks a display snapshot refusal.
        return c.json({ error: 'hub_users_unavailable' }, 503);
      }
      current();
      if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
      // Discovery is readonly; it never grants Connector access. Every fan-in
      // contribution still uses the original owner's current node authority.
      observation.stage(2);
      let connections: Awaited<ReturnType<typeof deps.hubStore.listConnectionsAsync>>;
      try { connections = initialState ? initialState.connections : await deps.hubStore.listConnectionsAsync(userId); }
      catch {
        current(); // Revocation outranks a failed directory snapshot.
        return c.json({ error: 'hub_connections_unavailable' }, 503);
      }
      current();
      if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
      const authorities = new Map(connections.map((connection) => [connection.id, initialState ? initialState.authority(connection.id) : deps.hubStore.connectionAuthority(connection.id, connection.ownerUserId)]));
      // Directory size must not become unbounded concurrent Connector IO.
      // These are original readonly requests: no retries and no early release
      // of a lane while its accepted read is still pending.
      const readableConnections = connections.filter(connection => connection.status !== 'disabled');
      const readConnection = async (connection: typeof connections[number]) => {
        try {
          const state = await (await requestConnectorClient(deps, c.req.raw, connection.id, false, connection.ownerUserId)).sessions(c.req.raw.signal, collector);
          return { connectionId: connection.id, state: 'ready' as const, sourceCursor: state.sourceCursor, groups: state.groups.map((group) => ({
            ...group, sessions: group.sessions.map((session) => wrapSession(session, connection)),
          })) };
        } catch (error) {
          if (error instanceof ConnectorResponseBudgetExceeded) throw error;
          return { connectionId: connection.id, state: error instanceof ConnectorClientError && [401, 403, 404].includes(error.status) ? 'denied' as const : 'unavailable' as const,
            groups: [], error: error instanceof ConnectorClientError ? error.message : 'Connector unavailable' };
        }
      };
      const pendingResults = new Array<Awaited<ReturnType<typeof readConnection>>>(readableConnections.length);
      let nextConnection = 0, refused = false;
      const lane = async () => {
        try {
          while (!refused && !collector?.snapshot().refused && nextConnection < readableConnections.length) {
            current();
            if (c.req.raw.signal.aborted) throw new HTTPException(503);
            const index = nextConnection++;
            pendingResults[index] = await readConnection(readableConnections[index]!);
          }
        } catch (error) { refused = true; throw error; }
      };
      const lanes = await Promise.allSettled(Array.from({ length: Math.min(4, readableConnections.length) }, lane));
      current();
      if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
      const failed = lanes.find(result => result.status === 'rejected');
      if (collector?.snapshot().refused) return c.json({ error: 'hub_session_response_busy' }, 503);
      if (failed?.status === 'rejected') throw failed.reason;
      observation.stage(3);
      let preferences: Awaited<ReturnType<typeof deps.hubStore.sessionPreferencesAsync>>;
      let currentConnections: Awaited<ReturnType<typeof deps.hubStore.listConnectionsAsync>>;
      let finalState: typeof initialState;
      if (access) {
        // Final directory, epochs and privacy flags are one original-owner
        // snapshot. One cheap atomic proof fences both generations afterwards.
        finalState = await access.sessionState();
        current();
        if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
        preferences = finalState.preferences;
        currentConnections = finalState.connections;
        users = finalState.users;
        observation.stage(4);
        await finalState.check();
        current();
        if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
      } else {
        const preferenceVersion = deps.hubStore.sessionPreferenceVersion;

        try { preferences = await deps.hubStore.sessionPreferencesAsync(userId); }
        catch {
          // No stale/unfiltered fallback: missing preferences can disclose hidden
          // sessions. Also recheck authentication before publishing an error.
          current();
          return c.json({ error: 'hub_session_preferences_unavailable' }, 503);
        }
        current();
        if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
        // The shared owner may commit a hide/archive mutation after the observer's
        // snapshot but before this continuation. Never publish that stale view.
        if (preferenceVersion !== deps.hubStore.sessionPreferenceVersion) {
          observation.changed();
          const trace = performanceDiagnostics.start('hub-preference-read'); trace.add('step', 2); trace.add('changed', 1); trace.finish(true);
          return c.json({ error: 'hub_session_preferences_changed' }, 503);
        }
        // A fast node may be revoked while other nodes or preferences are read.
        // Re-read the owner-scoped directory asynchronously, then fence every
        // contribution using original authority at the final synchronous response.
        observation.stage(4);

        try { currentConnections = await deps.hubStore.listConnectionsAsync(userId); }
        catch {
          current();
          return c.json({ error: 'hub_connections_unavailable' }, 503);
        }
        current();
        if (c.req.raw.signal.aborted) return c.json({ error: 'request_aborted' }, 503);
        // Hiding/archiving a session may commit during this new directory wait.
        // A completed snapshot is not permission to disclose older preferences.
        if (preferenceVersion !== deps.hubStore.sessionPreferenceVersion) {
          observation.changed();
          const trace = performanceDiagnostics.start('hub-preference-read'); trace.add('step', 3); trace.add('changed', 1); trace.finish(true);
          return c.json({ error: 'hub_session_preferences_changed' }, 503);
        }
      }
      const byConnection = new Map(pendingResults.map((result) => [result.connectionId, result]));
      const viewKey = createHash('sha256').update(JSON.stringify([includeHidden, includeArchived,
        [...preferences].sort(([a], [b]) => a.localeCompare(b)),
      ])).digest('hex');
      const results = currentConnections.map((connection) => {
        const authority = finalState ? finalState.authority(connection.id) : deps.hubStore.connectionAuthority(connection.id, connection.ownerUserId);
        if (connection.status === 'disabled') return { connectionId: connection.id, authority, state: 'disabled' as const, sourceCursor: undefined, groups: [] };
        const result = byConnection.get(connection.id);
        if (!result || authority !== authorities.get(connection.id)) return {
          connectionId: connection.id, authority, state: 'changed' as const, sourceCursor: undefined, groups: [], error: 'Connector authorization changed; refresh required',
        };
        return { ...result, authority };
      }).map((result) => ({ ...result, ...filterHiddenSessionGroups(mergeSessionGroups(result.groups), preferences, includeHidden, includeArchived) }));
      const mergedGroups = mergeSessionGroups(results.flatMap((result) => result.groups));
      const groups = mergedGroups;
      const hiddenCount = results.reduce((sum, result) => sum + result.hiddenCount, 0);
      const archivedCount = results.reduce((sum, result) => sum + result.archivedCount, 0);
      const pinnedCount = results.reduce((sum, result) => sum + result.pinnedCount, 0);
      const finalByConnection = new Map(results.map((result) => [result.connectionId, result]));
      const publicConnections = currentConnections.map((connection) => {
        const result = finalByConnection.get(connection.id);
        return result?.error ? { ...publicConnectionWithUser(connection, users), status: 'degraded' as const, error: result.error }
          : publicConnectionWithUser(connection, users);
      });
      observation.stage(5);
      const response = c.json({
        groups,
        // Independent source watermarks, never a synthetic combined node cursor.
        sources: results.flatMap((result) => result.sourceCursor ? [{ connectionId: result.connectionId, cursor: result.sourceCursor }] : []),
        // Failed/changed sources carry no rows or cursor. Failure is not proof of
        // continuing read authority: clients must discard, never revive old rows.
        sourceStates: results.map((result) => ({ connectionId: result.connectionId, authority: result.authority, state: result.state,
          hiddenCount: result.hiddenCount, archivedCount: result.archivedCount, pinnedCount: result.pinnedCount,
          ...(result.sourceCursor ? { cursor: result.sourceCursor } : {}) })),
        viewKey,
        connections: publicConnections,
        hiddenCount,
        archivedCount,
        pinnedCount,
        updatedAt: Date.now(),
        revision: stableGatewayRowsRevision([
          { id: 'snapshot-view', text: [viewKey, results.map(({ connectionId, authority, state, hiddenCount, archivedCount, pinnedCount }) => ({ connectionId, authority, state, hiddenCount, archivedCount, pinnedCount }))] },
          ...groups,
          ...publicConnections.map((connection) => ({
            id: `connection:${connection.id}`,
            status: connection.status,
            label: connection.environmentLabel ?? connection.label,
            source: connection.environmentId,
            hasActiveRun: connection.hasCredential,
            text: 'error' in connection ? connection.error : undefined,
          })),
        ]),
      });
      buffered = true;
      records = groups.reduce((count, group) => count + group.sessions.length, 0);
      return response;
    } catch (error) {
      if (error instanceof HubMemberRequestError) return c.json({ error: 'hub_sessions_unavailable' }, error.status === 499 ? 503 : error.status);
      throw error;
    } finally {
      // Original route/client Promise settlement only, NOT proof of original
      // SQL worker exit. SQL owner replacement retains its separate exit fence.
      if (collector) {
        const snapshot = collector.snapshot();
        observation.responseBudget(snapshot.retainedBytes, snapshot.refused);
        collector.close();
      }
      if (reserved) sessionStateReads--;
      observation.finish(buffered, records);
    }
  });

  if (!discovery) registerHubSessionPreferences(app, { principal, synchronousStoreAuthority: principal, port: deps.administrative?.sessionPreferences ?? {
    set: (_request, userId, change) => {
      const decoded = decodeHubSessionId(change.sessionKey)!;
      const connection = deps.hubStore.getConnection(decoded.connectionId, userId);
      if (!connection || connection.status === 'disabled') throw new HTTPException(404);
      deps.hubStore.setSessionPreference(change.sessionKey, change.field, change.value, userId);
    },
  } });

  registerHubDeletionRoutes(app, {
    store: deps.hubStore, client: deps.connectorClient, internalRequests: internal,
    ...(deps.asyncOwnerControl ? { asyncOwnerControl: deps.asyncOwnerControl } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner, error: connectorReadError,
  });

  registerHubSettingsRoutes(app, {
    store: deps.hubStore, client: deps.connectorClient, internalRequests: internal,
    ...(deps.asyncOwnerControl ? { asyncOwnerControl: deps.asyncOwnerControl } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner, error: connectorReadError,
  });

  const sessionAuxiliary = registerHubSessionAuxiliary(app, { ...connectionProxyDeps(), error: connectorReadError });

  const historyMedia = registerHubHistoryMedia(app, { ...connectionProxyDeps(),
    wrap: wrapMessage, error: connectorReadError, historyDiagnostics });

  registerHubQueueRoutes(app, `${base}/sessions/:hubSessionId`, {
    store: deps.hubStore, client: deps.connectorClient, internalRequests: internal,
    ...(deps.asyncOwnerControl ? { asyncOwnerControl: deps.asyncOwnerControl } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner, error: connectorReadError,
  });

  registerHubMessageRoutes(app, `${base}/sessions/:hubSessionId`, {
    store: deps.hubStore, client: deps.connectorClient, internalRequests: internal,
    ...(deps.asyncOwnerControl ? { asyncOwnerControl: deps.asyncOwnerControl } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner, error: connectorReadError,
  });

  registerHubCompactRoutes(app, {
    store: deps.hubStore, client: deps.connectorClient, internalRequests: internal,
    ...(deps.asyncOwnerControl ? { asyncOwnerControl: deps.asyncOwnerControl } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner, error: connectorReadError,
  });

  registerHubCreationRoutes(app, {
    store: deps.hubStore, client: deps.connectorClient, internalRequests: internal,
    ...(deps.asyncOwnerControl ? { asyncOwnerControl: deps.asyncOwnerControl } : {}),
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}), owner, error: connectorReadError,
  });

  registerHubEventRoutes(app, base, deps.asyncEvents ? { brokers, asyncEvents: deps.asyncEvents }
    : { store: deps.hubStore, brokers, principal });
  // Keep workspace/completion HTTP owners in one lifecycle group. All receive
  // their close signal before any ACK is awaited; a failed peer cannot omit
  // another owner or authorize closing its database early.
  const closeWorkspace = createIndependentDrain([
    () => workspaceSync?.close(), () => legacyWorkspaceSync.close(),
    () => workspacePreferences.close(), () => workspaceLayouts.close(), () => workspaceReadOwner.close(),
    () => completions.close(), () => websites.close(), () => ahp.close(), () => automation.close(), () => tokenUsage.close(),
  ], 'hub-route-drain');
  const closeContent = createIndependentDrain([
    () => fileBoards?.close(), () => fileCards?.close(), () => sharedContent?.close(),
    () => notebookMachine?.close(), () => nativeFiles?.close(), () => nativeFileBackground?.close(),
    () => contentDocuments?.close(), () => contentOverview?.close(), () => contentBindings?.close(), () => contentBatches?.close(), () => contentBackground?.close(),
  ], 'hub-route-drain');
  const closeConnectionProxies = createIndependentDrain([() => connectionFiles.close(), () => connectionControl?.close(),
    () => connectionVerification?.close(), () => connectorUserManagement?.close(), () => connectorUserDisplay.close()], 'hub-route-drain');
  // Keep the root's bounded fan-out independent of the number of control
  // domains. Each child is still signalled in the same turn, before any await;
  // a pending or failed child cannot omit a peer or permit database close.
  const closeControlDomains = createIndependentDrain([
    () => ownerControls?.close(),
    () => sharedCreation?.close(),
    () => sharedSessions?.close(),
    () => permissions?.close(),
    () => governance?.close(),
    () => !governance ? deps.asyncIssuerManagement?.close() : undefined, () => deps.asyncSharedCreation?.close(), () => deps.asyncCreationDiscovery?.close(),
    () => !sharedSessions ? deps.asyncSharedReads?.close() : undefined, () => deps.asyncEvents?.close(), () => !governance ? deps.asyncMaintenance?.close() : undefined,
    () => !governance ? deps.asyncLifecycle?.close() : undefined, () => !sharedSessions ? deps.asyncSharedCommands?.close() : undefined,
    () => !sharedSessions ? deps.asyncSharedDirectory?.close?.() : undefined,
    () => deps.asyncOwnerControl?.close?.(),
  ], 'hub-route-drain');
  const close = createIndependentDrain([
    () => discovery?.close(),
    closeSystemRoutes,
    () => quickChat.close(), () => sessionGuidance.close(), () => usageManifests.close(),
    () => weixinRoutes.close(), () => browser.close(), () => boardBindings.close(), () => delegations.close(),
    () => taskSessions.close(), () => websiteActions.close(), () => terminals.close(), () => remote.close(),
    () => research.close(), () => websiteAccess.close(), () => brokers.drain(), () => historyMedia.close(), () => sessionAuxiliary.close(), closeConnectionProxies,
    closeContent,
    closeWorkspace,
    closeControlDomains,
    () => connectionMutations?.close(), () => deps.administrative?.close(),
  ], 'hub-route-drain');
  weixin.startWorker();
  return { close };
}

function principal(c: Context): HubPrincipal { return c.get('hubAuthorize')?.() ?? c.get('hubPrincipal') ?? LEGACY_HUB_PRINCIPAL; }
function owner(c: Context) { return principal(c).userId; }

function ensureDefaultHubConnection(config: ServerConfig, hubStore: HubStore) {
  initializeHubDefaultConnection(hubStore, hubDefaultConnection(config));
}



async function testRemoteConnection(connectorUrl: string, token: string | undefined, signal: AbortSignal) {
  const client = new ConnectorClient(connectorUrl, token ?? '');
  try {
    const [info, health] = await Promise.all([
      client.json('/info', { signal }), client.json('/health', { signal }),
    ]);
    return { ok: true, connectorUrl, connector: info, health, updatedAt: Date.now() };
  } catch (error) {
    return { ok: false, connectorUrl, error: error instanceof ConnectorClientError ? error.message : 'Connector connection failed', updatedAt: Date.now() };
  }
}



type RemoteSessionsResult = {
  connectionId: string;
  groups: Array<{ agentId: string; sessions: ReturnType<typeof wrapSession>[] }>;
  error?: string | undefined;
};

type HubRouteDeps = Parameters<typeof registerHubRoutes>[1];

async function proxyConnectorUserMutation(
  c: Context,
  deps: HubRouteDeps,
  method: 'POST' | 'PATCH',
  userId?: string,
) {
  return proxyHubConnectorUserMutation(c, {
    store: deps.hubStore, principal, connectorClient: deps.connectorClient,
    ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}),
    ...(deps.administrative ? { access: deps.administrative.members } : {}),
    present: (connection, users, user) => publicConnectorUserConnection(connection, users, true, [user]),
    readError: connectorReadError,
  }, method, userId);
}

async function proxyConnectorControl(
  c: Context,
  deps: Parameters<typeof registerHubRoutes>[1],
  method: 'GET' | 'POST',
  path: string,
  auditAction?: Parameters<HubStore['audit']>[0],
  body?: unknown,
  preferMaintenance = false,
) {
  const connectionId = c.req.param('connectionId');
  if (!connectionId) return c.json({ error: 'connection id is required' }, 400);
  const connection = deps.hubStore.getConnection(connectionId, owner(c));
  if (!connection) return c.json({ error: 'connection not found' }, 404);
  try {
    const result = await (await requestConnectorClient(deps, c.req.raw, connection.id, preferMaintenance, owner(c))).jsonResponse<unknown>(`/${path}`, {
      method, signal: c.req.raw.signal,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    });
    if (auditAction) deps.hubStore.audit(auditAction, connection.id, safeAuditDetail(body, result.body), owner(c));
    return c.json(result.body as any, result.status as any);
  } catch (error) {
    return connectorReadError(c, error);
  }
}

function safeAuditDetail(request: unknown, response: unknown) {
  return { request: request && typeof request === 'object' ? Object.fromEntries(Object.entries(request as Record<string, unknown>).filter(([key]) => !/token|secret|password/i.test(key))) : request, state: (response as any)?.state, ok: (response as any)?.ok, updatedAt: Date.now() };
}


function clampMessageLimit(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

import { fingerprintRequest } from '../auth/security.js';
import { registerHubBoardFiles } from './hub-workspace-board-files.js';
import { publicFileBoardBinding } from '../hub/workspace-board-files.js';
import { HubFileBoardService, HubFileBoardError } from '../hub/workspace-board-file-service.js';
import { HubFileCardService } from '../hub/workspace-card-file-service.js';
import { registerHubCardFiles } from './hub-workspace-card-files.js';
import { publicConnection, publicConnectionWithUser, publicConnectionsWithUsers, wrapSession, filterHiddenSessionGroups, mergeSessionGroups } from './hub-session-presentation.js';
