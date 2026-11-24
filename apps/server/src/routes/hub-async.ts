import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ServerConfig } from '../config.js';
import type { HubAdministrativeServices } from '../hub/administrative-route-services.js';
import type { createHubConnectorReadServices } from '../hub/connector-read-services.js';
import type { HubEventFeedPort } from '../hub/async-event-feed.js';
import type { WebsiteGateway } from '../hub/website-gateway.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { HistoryDiagnostics } from '../storage/history-diagnostics.js';
import { HubEventBrokers } from '../hub/event-broker.js';
import { registerHubEventRoutes } from '../hub/event-http.js';
import { AsyncNativeFileBackground } from '../hub/async-native-file-background.js';
import { AsyncContentBackground } from '../hub/async-content-background.js';
import { contentReplicaTransport } from '../hub/workspace-content-transport.js';
import { QuickChatService } from '../hub/quick-chat-service.js';
import { WeixinService } from '../hub/weixin-service.js';
import { HttpWeixinTransport, type WeixinTransport } from '../hub/weixin-transport.js';
import { weixinBridge } from '../hub/weixin-bridge.js';
import { linuxMetricsProvider, MetricsSampler } from '../system/metrics.js';
import { registerAsyncHubMetrics } from '../system/metrics-http.js';
import { registerStorageDiagnostics } from '../storage/diagnostics-http.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { publicConnection, publicConnectionWithUser } from './hub-session-presentation.js';
import { hubInfo, publicConnectorUserConnection, normalizeRemoteConnectorUser, wrapMessage, connectorReadError } from './hub-wire-presentation.js';
import { registerAsyncHubDiscovery } from './hub-discovery-async.js';
import { registerAsyncHubOwnerControls } from './hub-owner-controls-async.js';
import { registerAsyncHubPermissions } from './hub-permissions-async.js';
import { registerAsyncHubGovernance } from './hub-governance-async.js';
import { registerRetiredHubUpdates } from './hub-retired-updates.js';
import { registerAsyncHubSharedCreation } from './hub-shared-creation-async.js';
import { registerAsyncHubSharedSessions } from './hub-shared-sessions-async.js';
import { registerHubWorkspaceSync } from './hub-workspace-sync.js';
import { registerHubConnectorUserManagement } from './hub-connector-user-management.js';
import { registerAsyncHubConnectionMutations } from './hub-connection-mutations-async.js';
import { registerHubUserMutations } from './hub-user-mutations.js';
import { registerHubDockerSandboxes } from './hub-docker-sandboxes.js';
import { registerAsyncHubMemberKeys } from './hub-member-keys.js';
import { registerHubConnectionFiles } from './hub-connection-files.js';
import { registerHubConnectionControl } from './hub-connection-control.js';
import { registerHubConnectionVerification } from './hub-connection-verification.js';
import { registerHubHistoryMedia } from './hub-history-media.js';
import { registerHubSessionAuxiliary } from './hub-session-auxiliary.js';
import { registerHubAutomation } from './hub-automation.js';
import { registerHubTokenUsage } from './hub-token-usage.js';
import { registerHubWebsiteRoutes } from './hub-websites.js';
import { registerAsyncHubSessionGuidance } from './hub-session-guidance-async.js';
import { registerAsyncHubBoardBindings } from './hub-async-workspace-board-bindings.js';
import { registerAsyncHubDelegations } from './hub-async-workspace-delegations.js';
import { registerAsyncHubUsageManifests } from './hub-async-usage-manifests.js';
import { registerHubTaskSessions } from './hub-task-sessions.js';
import { registerHubRemoteRoutes } from './hub-workspace-remote.js';
import { registerHubResearchRoutes } from './hub-workspace-research.js';
import { registerHubBrowser } from './hub-workspace-browser.js';
import { registerHubQuickChat } from './hub-quick-chat.js';
import { registerHubTerminals } from './hub-terminals.js';
import { registerHubWebsiteActions } from './hub-website-actions.js';
import { registerHubWebsiteAccess } from './hub-website-access.js';
import { registerHubWeixin } from './hub-weixin.js';
import { registerHubWorkspacePreferences } from './hub-workspace-preferences.js';
import { registerHubWorkspaceLayouts } from './hub-workspace-layouts.js';
import { registerHubCompletionRoutes } from './hub-completions.js';
import { registerHubSessionNotebookRoutes } from './hub-session-notebooks.js';
import { registerHubWorkspaceBoardRoutes } from './hub-workspace-boards.js';
import { registerHubCardFiles } from './hub-workspace-card-files.js';
import { registerHubBoardFiles } from './hub-workspace-board-files.js';
import { registerHubWorkspaceCards } from './hub-workspace-cards.js';
import { registerHubWorkspaceDrawingRoutes } from './hub-workspace-drawings.js';
import { registerHubNativeDrawioRoutes } from './hub-workspace-native-drawio.js';
import { registerAsyncHubContentDocuments } from './hub-async-workspace-content-documents.js';
import { registerAsyncHubContentOverview } from './hub-async-workspace-content-overview.js';
import { registerAsyncHubContentBindings } from './hub-async-workspace-content-bindings.js';
import { registerAsyncHubContentBatches } from './hub-async-workspace-content-batches.js';

export type AsyncHubRouteDeps = {
  config: ServerConfig;
  /** Already bootstrapped by the unique owner, never read from a second store. */
  hubId: string;
  administrative: HubAdministrativeServices;
  reads: ReturnType<typeof createHubConnectorReadServices>;
  eventFeed(ownerUserId: string): HubEventFeedPort;
  normalizeError(error: unknown): string;
  websiteGateway?: WebsiteGateway;
  weixinTransport?: WeixinTransport;
  sessionStateResponseLimits?: { requestBytes?: number; retainedBytes?: number };
};

type Close = () => void | Promise<void>;
const base = '/api/hub/v1';
const isHubPath = (path: string) => {
  if (path === base || path.startsWith(`${base}/`)) return true;
  // Native session aliases belong to the original application. Only a real
  // Hub session ID may enter this route tree (including percent-encoded IDs).
  const alias = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(path);
  try { return !!alias && !!decodeHubSessionId(decodeURIComponent(alias[1]!)); }
  catch { return false; }
};

/** Complete async-only HTTP composition. Borrowed application service groups
 * and the database owner outlive this route tree. No sync store/principal/
 * resolver is accepted, constructed, cast or used as a fallback.
 *
 * Build privately -> publish once -> explicit activate. Failure drains every
 * acquired owner before rejecting; closing freezes all independent lanes in
 * the same turn, then awaits their original acknowledgements, not deadlines. */
export async function registerAsyncHubRoutes(outer: Hono, deps: AsyncHubRouteDeps) {
  const services = deps.administrative, reads = deps.reads, resolver = reads?.connector;
  if (!deps.hubId || typeof deps.eventFeed !== 'function' || typeof deps.normalizeError !== 'function'
    || typeof services?.members?.begin !== 'function' || typeof resolver !== 'function'
    || typeof resolver.contentBackground !== 'function' || typeof resolver.nativeFileBackground !== 'function'
    || typeof resolver.notebookMachine !== 'function') throw Error('hub_async_composition_ports_required');
  const app = new Hono(), work = new HubRequestWork();
  const cleanups: { close: Close }[] = [{ close: () => work.close() }];
  let state: 'prepared' | 'activating' | 'active' | 'closing' = 'prepared';
  let closing: Promise<void> | undefined;
  let activation: Promise<void> | undefined;
  // Registration owns its access only after it succeeds. Before that, the
  // immediate acquisition record ensures a throwing registrar cannot leak it.
  const own = <T extends { close: Close }>(owner: T): T => { cleanups.push({ close: () => owner.close() }); return owner; };
  const build = <A, T extends { close: Close }>(access: A, close: () => void | Promise<void>,
    register: (access: A) => T): T => {
    const entry = { close }; cleanups.push(entry);
    const routes = register(access); entry.close = () => routes.close(); return routes;
  };
  const drain = () => {
    // Bounded fan-out without staggering the freeze of any child lane.
    const groups: Close[] = [];
    for (let offset = 0; offset < cleanups.length; offset += 32) {
      groups.push(createIndependentDrain(cleanups.slice(offset, offset + 32).map(entry => entry.close), 'hub-route-drain'));
    }
    return createIndependentDrain(groups, 'hub-route-drain')();
  };
  const close = () => {
    if (closing) return closing;
    state = 'closing';
    // Publish before diagnostic/owner code can reenter close().
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((ok, bad) => { resolve = ok; reject = bad; });
    void drain().then(resolve, reject); return closing;
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (state !== 'active') return c.json({ error: 'hub_unavailable' }, 503);
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    try {
      await work.run(async () => {
        // Retain the exact Request: Weixin's private binding is NOT copyable.
        // Pin HTTP credentials to the same account across all child begins.
        const proof = await services.members.begin(c.req.raw); work.check();
        const expected = c.req.header('x-agentopsdeck-recovery-scope');
        if (expected !== undefined && expected !== proof.recoveryScope) throw new HubMemberRequestError(409);
        pinOriginalRequestScope(c.req.raw, proof.recoveryScope);
        await next();
      });
    } catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      return c.json({ error: error.status === 409 ? 'Authenticated account or Hub changed; reload before continuing'
        : error.status === 401 ? 'unauthorized' : 'hub_unavailable' }, error.status === 499 ? 503 : error.status);
    }
  });
  try {
    const brokers = new HubEventBrokers({ mode: 'async', feed: deps.eventFeed });
    cleanups.push({ close: () => brokers.drain() });
    const history = new HistoryDiagnostics();
    const discovery = services.createDiscoveryAccess();
    build(discovery, () => discovery.close(), access => registerAsyncHubDiscovery(app, {
      mode: 'async', access, asyncConnectorClient: resolver, info: hubInfo(deps.config),
      ...(deps.sessionStateResponseLimits ? { responseLimits: deps.sessionStateResponseLimits } : {}),
    }));
    const controls = services.createOwnerControlAccess(resolver);
    build(controls, () => controls.close(), access => registerAsyncHubOwnerControls(app, { mode: 'async', controls: access }));
    const permissions = services.createPermissionAccess();
    build(permissions, () => permissions.close(), access => registerAsyncHubPermissions(app, { mode: 'async', access, services }));
    const governance = services.createGovernanceAccess();
    build(governance, () => governance.close(), access => registerAsyncHubGovernance(app, { mode: 'async', access,
      services: { issuerManagement: reads.issuerManagement, maintenance: reads.maintenanceCommands, lifecycle: reads.lifecycleCommands } }));
    registerRetiredHubUpdates(app);
    own(registerAsyncHubSharedCreation(app, { mode: 'async', creation: reads.sharedCreation, discovery: reads.creationDiscovery }));
    own(registerAsyncHubSharedSessions(app, { mode: 'async', directory: reads.directory, reads: reads.sharedReads,
      commands: reads.sharedCommands, connector: resolver, brokers }));
    const sync = services.createConnectionVerificationAccess();
    build(sync, () => sync.close(), access => {
      const routes = registerHubWorkspaceSync(app, { mode: 'async', access: access.requests, asyncConnectorClient: resolver, wrap: wrapMessage });
      const finish = createIndependentDrain([() => routes.close(), () => access.close()], 'hub-route-drain');
      return { close: finish };
    });
    const users = services.createConnectionVerificationAccess();
    build(users, () => users.close(), access => registerHubConnectorUserManagement(app, { mode: 'async',
      access: { begin: request => access.requests.begin(request), close: () => access.close() }, asyncConnectorClient: resolver,
      readError: connectorReadError,
      presentDirectory: (connection, owners, supported, remote, error) => publicConnectorUserConnection(connection, owners,
        supported, remote.map(normalizeRemoteConnectorUser).filter((user): user is NonNullable<typeof user> => !!user), error),
      presentMutation: (connection, owners, user) => publicConnectorUserConnection(connection, owners, true, [user]) }));
    own(registerAsyncHubConnectionMutations(app, { requests: services.members, present: publicConnectionWithUser }));
    registerHubUserMutations(app, { normalizeError: deps.normalizeError, begin: async c => {
      const authority = await services.members.begin(c.req.raw); work.check();
      return { ...authority, check: async () => { work.check(); await authority.check(); work.check(); } };
    } });
    registerAsyncHubMemberKeys(app, services.members, !!deps.config.accessKey);
    registerHubDockerSandboxes(app, { base, members: { begin: async request => {
      const authority = await services.members.begin(request); work.check();
      return { ...authority, check: async () => { work.check(); await authority.check(); work.check(); } };
    } } });
    registerHubEventRoutes(app, base, { brokers, asyncEvents: reads.eventReplay });

    // Each proxy owns original resolver, body and transport/cancel ACKs.
    const proxy = <T extends { close: Close }>(register: (access: ReturnType<HubAdministrativeServices['createConnectionProxyAccess']>) => T) => {
      const access = services.createConnectionProxyAccess(); return build(access, () => access.close(), register);
    };
    proxy(access => registerHubConnectionFiles(app, { mode: 'async', access, asyncConnectorClient: resolver, error: connectorReadError }));
    proxy(access => registerHubHistoryMedia(app, { mode: 'async', access, asyncConnectorClient: resolver,
      error: connectorReadError, wrap: wrapMessage, historyDiagnostics: history }));
    proxy(access => registerHubSessionAuxiliary(app, { mode: 'async', access, asyncConnectorClient: resolver, error: connectorReadError }));
    proxy(access => registerHubAutomation(app, { mode: 'async', access, asyncConnectorClient: resolver }));
    proxy(access => registerHubTokenUsage(app, { mode: 'async', access, asyncConnectorClient: resolver }));
    proxy(access => registerHubWebsiteRoutes(app, { mode: 'async', access, asyncConnectorClient: resolver }));
    own(registerHubConnectionControl(app, { mode: 'async', asyncConnectorClient: resolver,
      createAccess: () => services.createConnectionControlAccess(), error: connectorReadError }));
    own(registerHubConnectionVerification(app, { mode: 'async', asyncConnectorClient: resolver,
      createAccess: () => services.createConnectionVerificationAccess(), defaultConnectionId: deps.config.hub.defaultConnectionId,
      present: (connection, owners) => owners ? publicConnectionWithUser(connection, owners) : publicConnection(connection), error: connectorReadError }));
    const guidance = services.createGuidanceAccess();
    build(guidance, () => guidance.close(), access => registerAsyncHubSessionGuidance(app, { mode: 'async', guidance: access, asyncConnectorClient: resolver }));
    const bindings = services.createBoardBindingAccess();
    build(bindings, () => bindings.close(), access => registerAsyncHubBoardBindings(app, { access,
      ...(deps.config.boardAgentEndpoint ? { endpoint: deps.config.boardAgentEndpoint } : {}), asyncConnectorClient: resolver }));
    const delegations = services.createDelegationAccess();
    build(delegations, () => delegations.close(), access => registerAsyncHubDelegations(app, { access,
      ...(deps.config.boardAgentEndpoint ? { endpoint: deps.config.boardAgentEndpoint } : {}), asyncConnectorClient: resolver }));
    const manifests = services.createUsageManifestAccess();
    build(manifests, () => manifests.close(), access => registerAsyncHubUsageManifests(app, { access, asyncConnectorClient: resolver }));
    const tasks = services.createTaskSessionServices(resolver);
    build(tasks, createIndependentDrain([() => tasks.access.close(), () => tasks.controls.close()], 'hub-route-drain'),
      access => registerHubTaskSessions(app, { mode: 'async', ...access, asyncConnectorClient: resolver, endpoint: deps.config.boardAgentEndpoint }));

    const remote = services.createWorkspaceRemoteAccess();
    build(remote, () => remote.close(), access => registerHubRemoteRoutes(app, { mode: 'async', access }));
    const modelCatalog = { discoverModels: true,
      ...(deps.config.codex.modelProvider === 'litellm' ? { defaultModel: deps.config.codex.defaultModel } : {}) };
    const research = services.createWorkspaceResearchAccess();
    build(research, () => research.close(), access => registerHubResearchRoutes(app, { mode: 'async', access, config: deps.config.hub.research, modelCatalog }));
    const browser = services.createWorkspaceBrowserAccess();
    build(browser, () => browser.close(), access => registerHubBrowser(app, { mode: 'async', access, config: deps.config.hub.browser }));
    const quickChat = services.createQuickChatExecution();
    build(quickChat, () => quickChat.close(), persistence => registerHubQuickChat(app, { mode: 'async', recovery: services.quickChatRecovery,
      service: new QuickChatService(undefined, deps.config.hub.research?.synthesis, fetch, 45_000, { ...modelCatalog, persistence }) }));
    const terminal = services.createTerminalAccess();
    build(terminal, () => terminal.close(), access => registerHubTerminals(app, { mode: 'async', ...access,
      closeAccess: access.close, asyncConnectorClient: resolver }));
    const actions = services.createWebsiteActionAccess();
    build(actions, () => actions.close(), access => registerHubWebsiteActions(app, { mode: 'async', ...access,
      closeAccess: access.close, asyncConnectorClient: resolver }));
    const website = services.createWebsiteAccess();
    build(website, () => website.close(), access => registerHubWebsiteAccess(app, { mode: 'async', ...access,
      closeAccess: access.close, asyncConnectorClient: resolver, ...(deps.websiteGateway ? { gateway: deps.websiteGateway } : {}) }));

    const readOwner = own(new AuthRoutePersistence()), readWait = new AuthRouteReadWait(readOwner);
    own(registerHubWorkspacePreferences(app, { principal: c => services.workspace.principal(c.req.raw), port: services.workspace, readWait }));
    own(registerHubWorkspaceLayouts(app, { principal: c => services.layouts.principal(c.req.raw), port: services.layouts, readWait }));
    own(registerHubCompletionRoutes(app, { principal: c => services.completions.principal(c.req.raw), port: services.completions,
      atomicDeliveryAuthority: true, readWait }));

    const enabled = !!deps.config.boardFilesEnabled, nativeFiles = own(services.createNativeFiles(resolver));
    const notebookMachine = own(services.createNotebookMachine(nativeFiles));
    const visuals = { mode: 'async' as const, nativeFiles, editorAccess: services.members, fileCardsEnabled: enabled, visuals: services.visuals };
    registerHubSessionNotebookRoutes(app, { mode: 'async', nativeFiles, notebookMachine, editorAccess: services.members,
      fileCardsEnabled: enabled, privateNotebooks: services.privateNotebooks, sessionNotebooks: services.privateNotebooks, notebookControl: services.notebookControl });
    registerHubWorkspaceBoardRoutes(app, { mode: 'async', nativeFiles, editorAccess: services.members, fileCardsEnabled: enabled,
      boards: services.boards, capabilities: services.boardCapabilities });
    registerHubCardFiles(app, { mode: 'async', nativeFiles, editorAccess: services.members, configurations: services.configurations,
      projections: services.projections, reports: services.reports, enabled });
    registerHubBoardFiles(app, { mode: 'async', nativeFiles, enabled });
    registerHubWorkspaceCards(app, visuals);
    registerHubWorkspaceDrawingRoutes(app, visuals);
    registerHubNativeDrawioRoutes(app, { ...visuals, editorUrl: deps.config.hub.drawioEditorUrl });
    const document = services.createContentDocumentAccess();
    build(document, () => document.close(), access => registerAsyncHubContentDocuments(app, { access, enabled: () => enabled }));
    const overview = services.createContentDocumentAccess();
    build(overview, () => overview.close(), access => registerAsyncHubContentOverview(app, { access, enabled: () => enabled }));
    const contentBindings = services.createContentDocumentAccess();
    build(contentBindings, () => contentBindings.close(), access => registerAsyncHubContentBindings(app, { access, enabled: () => enabled,
      transport: async (request, target) => contentReplicaTransport(await resolver(request, target.connectionId, { boardBindingsOnly: 'content-replicas' })) }));
    const batches = services.createContentDocumentAccess();
    build(batches, () => batches.close(), access => registerAsyncHubContentBatches(app, { access, enabled: () => enabled, clients: resolver,
      transport: async (request, target) => contentReplicaTransport(await resolver(request, target.connectionId, { boardBindingsOnly: 'content-replicas' })) }));
    const nativeBackgroundAccess = services.createNativeFileBackgroundAccess();
    const nativeBackground = build(nativeBackgroundAccess, () => nativeBackgroundAccess.close(), access =>
      new AsyncNativeFileBackground(access, reference => resolver.nativeFileBackground!(access, reference)));
    const contentBackgroundAccess = services.createContentBackgroundAccess();
    const contentBackground = build(contentBackgroundAccess, () => contentBackgroundAccess.close(), access =>
      new AsyncContentBackground(access, async reference => contentReplicaTransport(await resolver.contentBackground!(access, reference)), () => enabled));

    const transport = deps.weixinTransport ?? new HttpWeixinTransport();
    const background = services.createWeixinBackgroundAccess();
    const weixin = build(background, () => background.close(), access => new WeixinService({ mode: 'async', background: access,
      transport, bridge: weixinBridge(app, { mode: 'async', access, internal: new WeakMap() }) }));
    const weixinAccess = services.createWeixinAccess();
    // Transfer service ownership only after its HTTP registrar succeeds.
    build(weixinAccess, () => weixinAccess.close(), access => registerHubWeixin(app, { service: weixin, access, transport }));
    // Both close() methods are idempotent; the service keeps its private
    // background access until original sends and settlements acknowledge.

    const system = services.createSystemAccess();
    build(system, () => system.close(), access => {
      const storage = registerStorageDiagnostics(app, `${base}/maintenance/storage`, { access: async c => {
        const invoke = async <T>(call: () => Promise<T>) => {
          try { return await call(); }
          catch (error) { if (error instanceof HubMemberRequestError) throw new HTTPException(error.status === 499 ? 503 : error.status); throw error; }
        };
        const handle = await invoke(() => access.requests.begin(c.req.raw));
        if (!handle.principal.admin) throw new HTTPException(403);
        return { check: () => invoke(handle.check), stats: () => invoke(() => handle.storage('stats')),
          recovery: () => invoke(() => handle.storage('recovery')), checkpoint: () => invoke(() => handle.storage('checkpoint')) };
      }, history });
      // Register the first owner even if creating the second one throws.
      const storageEntry: { close: Close } = { close: () => storage.close() }; cleanups.push(storageEntry);
      const metrics = registerAsyncHubMetrics(app, access.requests, resolver, deps.hubId,
        new MetricsSampler({ kind: 'hub', id: deps.hubId }, linuxMetricsProvider(deps.config.metricVolumes)));
      storageEntry.close = () => undefined;
      const first = createIndependentDrain([() => metrics.close(), () => storage.close()], 'hub-route-drain');
      return { close: async () => { await first(); await access.close(); } };
    });

    // The outer application is untouched until every dependency is validated
    // and every acquired local owner has an installed cleanup.
    outer.use('/api/*', async (c, next) => isHubPath(c.req.path) ? app.fetch(c.req.raw) : next());
    return { close, activate(): Promise<void> {
      if (state === 'closing') return Promise.reject(Error('hub_async_composition_closed'));
      if (activation) return activation;
      state = 'activating';
      // Publish before starting any owner. Failed or reentrant activation must
      // freeze all lanes and drain the original effects before rejecting.
      activation = Promise.resolve().then(async () => {
        const check = () => { if (state === 'closing') throw Error('hub_async_composition_closed'); };
        try {
          check();
          if (enabled) { nativeBackground.start(); check(); contentBackground.start(); check(); }
          weixin.startWorker(); check();
          state = 'active';
        } catch (error) {
          try { await close(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'hub_async_activation_cleanup_failed'); }
          throw error;
        }
      });
      return activation;
    }, routes: Object.freeze(app.routes.map(route => Object.freeze({ method: route.method, path: route.path }))) };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'hub_async_composition_cleanup_failed'); }
    throw error;
  }
}
