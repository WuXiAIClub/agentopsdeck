import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { createApplicationHttpShell } from './application-http-shell.js';
import type { ServerConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { createHubEventFeedPort } from './hub/async-event-feed.js';
import { createHubAdministrativeServices } from './hub/administrative-route-services.js';
import { createHubConnectorReadServices } from './hub/connector-read-services.js';
import type { HubPrincipal } from './hub/identity.js';
import { synchronousHubPrincipalCall } from './hub/request-authority.js';
import { createApplicationConnectorClient } from './hub/application-connector-client.js';
import { HubExecutionSync } from './hub/execution-sync.js';
import { HubExecutionWorker } from './hub/execution-worker.js';
import { HubExecutionUsage } from './hub/execution-usage.js';
import { AsyncHubExecutionLeases } from './hub/async-execution-leases.js';
import { AsyncHubExecutionIssuers } from './hub/async-execution-issuers.js';
import { accessKeyFromRequest, createAccessKeyGuard, createAdministratorKeyGuard, isValidAccessKey } from './auth/access-key.js';
import { PasskeyManager, PersistentDeckSessionSet, sessionTokenFromRequest } from './auth/passkeys.js';
import { openSqliteAuth } from './auth/sqlite-store.js';
import { createShutdownCleanup } from './lifecycle/shutdown-cleanup.js';
import { performanceDiagnostics } from './diagnostics/performance.js';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from './auth/security.js';
import { registerApplicationAuthorization } from './auth/application-authorization.js';
import { createApplicationAuthObservations } from './auth/application-auth-observations.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHubRoutes } from './routes/hub.js';
import { registerWorkspaceAgentRoutes } from './routes/workspace-agent.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';
import { createConnectorRuntime } from './connector/runtime.js';
import { createConnectorClientResolver } from './hub/connector-client.js';
import { WebsiteGateway } from './hub/website-gateway.js';
import { registerWebBundle } from './web-bundle.js';
import { startupApplicationCleanup, type StartupOwnership } from './lifecycle/startup-cleanup.js';

export function createApplication(config: ServerConfig, connectorFactory = createConnectorRuntime) {
  startupApplicationCleanup.assertAvailable();
  const startupDrains: (() => void | Promise<void>)[] = [];
  const startupCleanups: (() => void | Promise<void>)[] = [];
  const sharedAuth = config.authSqliteFile ? openSqliteAuth(config.authSqliteFile,
    [config.passkeysFile, config.authSessionsFile], () => config.accessKey ? keyIdentityHash(config.accessKey) : undefined) : undefined;
  if (sharedAuth) startupCleanups.push(() => sharedAuth.close());
  try {
  const passkeys = sharedAuth?.passkeys ?? new PasskeyManager(config.passkeysFile);
  const authSessions = sharedAuth?.sessions ?? new PersistentDeckSessionSet(config.authSessionsFile, binding =>
    binding.keyIdentityHash === (config.accessKey ? keyIdentityHash(config.accessKey) : undefined)
      && passkeys.isCredentialCurrent(binding.credentialHash, binding.keyIdentityHash));
  const legacyAuthorized = createAccessKeyGuard(config.accessKey, authSessions);
  const connectorRoutesEnabled = shouldRegisterConnectorRoutes(config);
  const hubRoutesEnabled = shouldRegisterHubRoutes(config);
  if (config.websiteGateway && (!hubRoutesEnabled || config.websiteGateway.port === config.port)) {
    throw new Error('Website gateway requires an enabled Hub and a separate listening port');
  }
  const websiteGateway = config.websiteGateway ? new WebsiteGateway(config.websiteGateway) : undefined;
  if (websiteGateway) startupDrains.push(() => websiteGateway.close());
  const hubStore = hubRoutesEnabled ? new HubStore(config.hub.databaseFile, config.hub.vaultSecret, config.hub.lifecycleEndpoints,
    config.accessKey, legacyAuthorized, connectorRoutesEnabled ? config.hub.defaultConnectionId : undefined,
    createAdministratorKeyGuard(config.accessKey, authSessions)) : undefined;
  if (hubStore) {
    startupDrains.push(() => hubStore.executionCommands.close(), () => hubStore.maintenanceCommands.close(),
      () => hubStore.lifecycleCommands.close(), () => hubStore.executionIssuers.close());
    startupCleanups.push(() => hubStore.close());
      if (hubStore.identities.hasKeys() && !config.accessKey) {
        throw new Error('An administrator access key is required when Hub member logins are configured');
      }
      // Reject ambiguous/corrupt migration before all constructs any runtime workers.
      hubStore.importLegacySessionPreferences({ hidden: config.hiddenSessionsFile,
        archived: config.archivedSessionsFile, pinned: config.pinnedSessionsFile }, config.hub.legacyPreferencesOwner);
      hubStore.reconcileStrandedOwnerFileBindings();
  }
  // Production HTTP callers now use fixed awaited administrative commands.
  // Their SQL is STILL the original single synchronous Hub writer until all
  // shared runtime callers can move together; never start a peer writer here.
  // Construct the ORIGINAL persistent limiter once, with the existing policy.
  // The awaited port must not create another policy, clock, map or SQL owner.
  const originalLoginLimiter = hubStore?.createLoginLimiter(config.authRateLimit);
  const administrativeCommands = hubStore ? new OriginalHubAdministrativeCommands(hubStore,
    performanceDiagnostics, originalLoginLimiter) : undefined;
  const administrative = administrativeCommands ? createHubAdministrativeServices(administrativeCommands) : undefined;
  if (administrative) startupDrains.push(() => administrative.close());
  if (administrativeCommands) startupDrains.push(() => administrativeCommands.close());
  const internalRequests = new WeakMap<Request, () => HubPrincipal | undefined>();
  const principal = (request: Request) => internalRequests.has(request)
    ? synchronousHubPrincipalCall(internalRequests.get(request)!, [])
    : synchronousHubPrincipalCall(() => hubStore?.identities.requestPrincipal(request, legacyAuthorized), []);
  // HTTP observations may wait for an original owner. Keep the separate
  // synchronous principal above for callers that still enter original SQL
  // mutation callbacks; an awaited observation is not their transaction grant.
  const observePrincipal = (request: Request) => internalRequests.has(request)
    ? synchronousHubPrincipalCall(internalRequests.get(request)!, [])
    : administrative?.authIdentity.requestPrincipal(request);
  const isAuthorizedRequest = (request: Request) => hubStore ? Boolean(principal(request)) : legacyAuthorized(request);
  const authObservations = createApplicationAuthObservations({
    hasHub: !!hubStore, principal: observePrincipal, standaloneAuthorization: legacyAuthorized,
    memberIdentity: request => administrative?.authIdentity.memberIdentity(request),
    keyIdentity: key => administrative?.authIdentity.keyIdentity(key),
    recoveryScope: (actor, request) => internalRequests.has(request) ? hubStore?.identities.recoveryScope(actor)
      : administrative?.authIdentity.recoveryScope(request, actor),
  });
  const authAuditLog = administrative?.audit ?? new AuthAuditLog();
  const loginLimiter = administrative?.loginLimiter ?? new LoginAttemptLimiter(config.authRateLimit);

  // Retain partial factory owners in the parent's dependency scope. Successful
  // construction replaces them with the runtime's existing drain/close protocol.
  const drainCheckpoint = startupDrains.length, cleanupCheckpoint = startupCleanups.length;
  const startupOwnership: StartupOwnership = { drains: startupDrains, cleanups: startupCleanups, failed: false };
  const runtime = connectorRoutesEnabled ? connectorFactory(config, isAuthorizedRequest, { startupOwnership, deferActivation: true }) : undefined;
  startupDrains.length = drainCheckpoint; startupCleanups.length = cleanupCheckpoint;
  if (runtime) { startupDrains.push(() => runtime.stopAdmissions()); startupCleanups.push(() => runtime.close()); }
  const connectorClient = hubStore ? createConnectorClientResolver(hubStore, runtime ? {
    connectionId: config.hub.defaultConnectionId, token: runtime.localToken,
    maintenanceToken: runtime.localMaintenanceToken,
    ...(runtime.localSourceApprovalToken ? { sourceApprovalToken: runtime.localSourceApprovalToken } : {}),
    dispatch: request => runtime.app.fetch(request),
  } : undefined) : undefined;
  const localIssuerTransport = runtime ? { connectionId: config.hub.defaultConnectionId,
    dispatch: (request: Request) => runtime.app.fetch(request) } : undefined;
  // Fixed awaited domains, not a second owner. SQL remains on the original
  // HubStore until all shared callers can migrate together. No sync fallback.
  const executionLeases = administrativeCommands ? new AsyncHubExecutionLeases(administrativeCommands) : undefined;
  const executionIssuers = administrativeCommands ? new AsyncHubExecutionIssuers(administrativeCommands, localIssuerTransport) : undefined;
  const issuerClient = (lease: import('./hub/execution-leases.js').ExecutionLease) => executionIssuers!.clientFor(lease);
  const localOperator = runtime && config.hub.allowLocalExecutionSetup ? runtime.localExecutionOperator : undefined;
  const revokeRetiredLocal = hubStore && executionIssuers && localOperator ? async (
    lease: import('./hub/execution-leases.js').ExecutionLease,
    binding: { principalId: string; grantKey: string; version: number; runtime: string | undefined; sessionKey: string | undefined },
  ) => {
    if (!executionIssuers.isLocalLease(lease) || !localOperator.revokeRetiredGrant) return undefined;
    const reply = await localOperator.revokeRetiredGrant({
      expectedNode: lease.nodeId,
      issuerTokenId: lease.issuerId,
      hubId: hubStore.identities.hubId,
      body: binding,
    });
    return reply.status === 200 ? reply.value : undefined;
  } : undefined;
  const executionSync = hubStore && executionLeases ? new HubExecutionSync(executionLeases, hubStore.identities.hubId, issuerClient, undefined, undefined, undefined, revokeRetiredLocal) : undefined;
  const connectorReads = administrativeCommands ? createHubConnectorReadServices(administrativeCommands, runtime ? {
    connectionId: config.hub.defaultConnectionId, token: runtime.localToken,
    maintenanceToken: runtime.localMaintenanceToken,
    ...(runtime.localBoardBindingToken ? { boardBindingToken: runtime.localBoardBindingToken } : {}),
    ...(runtime.localFileBoardToken ? { fileBoardToken: runtime.localFileBoardToken } : {}),
    dispatch: request => runtime.app.fetch(request),
  } : undefined, undefined, executionSync,
    localOperator) : undefined;
  if (connectorReads) startupDrains.push(() => connectorReads.close());
  const executionWorker = hubStore && executionSync && executionLeases ? new HubExecutionWorker(executionSync, 3_000,
    new HubExecutionUsage(executionLeases, hubStore.identities.hubId, executionSync, issuerClient)) : undefined;
  if (executionWorker) startupDrains.push(() => executionWorker.close());

  const { app, stopAdmissions, allowedBrowserOrigin } = createApplicationHttpShell(config);
  startupDrains.push(() => stopAdmissions());
  const authorizationRoutes = registerApplicationAuthorization(app, {
    hasHub: !!hubStore, principal: observePrincipal, authorize: isAuthorizedRequest,
    // Trusted in-process requests retain their original non-serializable
    // authority. External HTTP activity uses credential-bound fixed commands.
    recordActivity: request => internalRequests.has(request) ? hubStore?.identities.recordActivity(request)
      : administrative?.activity.recordActivity(request),
    audit: authAuditLog, signedStream: request => runtime?.mediaLibrary.isSignedStreamRequest(request) === true,
    allowedBrowserOrigin,
  });
  startupDrains.push(() => authorizationRoutes.close());

  if (administrative) registerWorkspaceAgentRoutes(app, administrative.boardMachine);
  const authRoutes = registerAuthRoutes(app, {
    accessKey: config.accessKey,
    passkeys: sharedAuth?.routePasskeys ?? passkeys,
    sessions: authSessions,
    isAuthorizedRequest,
    ...authObservations,
    auditLog: authAuditLog,
    loginLimiter,
    lockoutSeconds: Math.ceil(config.authRateLimit.lockoutMs / 1000),
    memberLogin: (key, request) => administrative?.authSessions.memberLogin(key, request),
    revokeMemberSession: (token, request) => administrative?.authSessions.revokeMemberSession(token, request),
  });
  startupDrains.push(() => authRoutes.close());
  if (runtime) app.all('/api/connector/v1/*', context => runtime.app.fetch(context.req.raw));
  const hub = hubRoutesEnabled && hubStore ? registerHubRoutes(app, {
    ...(websiteGateway ? { websiteGateway } : {}),
    config, hubStore, normalizeError: () => 'Connector request failed',
    ...(administrative ? { administrative } : {}),
    ...(connectorReads ? { asyncSharedDirectory: connectorReads.directory, asyncOwnerControl: connectorReads.ownerControl,
      asyncSharedCommands: connectorReads.sharedCommands, asyncLifecycle: connectorReads.lifecycleCommands,
      asyncMaintenance: connectorReads.maintenanceCommands, asyncEvents: connectorReads.eventReplay, asyncSharedReads: connectorReads.sharedReads,
      asyncSharedCreation: connectorReads.sharedCreation, asyncCreationDiscovery: connectorReads.creationDiscovery,
      asyncIssuerManagement: connectorReads.issuerManagement,
      eventFeed: ownerUserId => createHubEventFeedPort(administrativeCommands!, ownerUserId, runtime ? {
        connectionId: config.hub.defaultConnectionId, token: runtime.localToken,
        dispatch: request => runtime.app.fetch(request),
      } : undefined),
      asyncConnectorClient: createApplicationConnectorClient(connectorReads.connector, internalRequests, connectorClient!) } : {}),
    principal, internalRequests, ...(executionSync ? { executionSync } : {}),
    weixinAdministrator: request => {
      if (!config.accessKey) return false;
      const supplied = accessKeyFromRequest(request), session = sessionTokenFromRequest(request);
      return supplied ? isValidAccessKey(supplied, config.accessKey) : !!session && authSessions.isAccessKeySession(session);
    },
    ...(localIssuerTransport ? { localIssuerTransport } : {}),
    ...(runtime && config.hub.allowLocalExecutionSetup ? { localExecutionOperator: runtime.localExecutionOperator } : {}),
    ...(runtime ? { localMaintenanceTransport: { connectionId: config.hub.defaultConnectionId,
      maintenanceToken: runtime.localMaintenanceToken, dispatch: (request: Request) => runtime.app.fetch(request) } } : {}),
    boardBindingClient: createConnectorClientResolver(hubStore, runtime?.localBoardBindingToken ? {
      connectionId: config.hub.defaultConnectionId,
      token: runtime.localBoardBindingToken,
      dispatch: request => runtime.app.fetch(request),
    } : undefined, true),
    fileBoardClient: createConnectorClientResolver(hubStore, runtime?.localFileBoardToken ? {
      connectionId: config.hub.defaultConnectionId, token: runtime.localFileBoardToken,
      dispatch: request => runtime.app.fetch(request),
    } : undefined, 'file-boards'),
    fileCardClient: createConnectorClientResolver(hubStore, runtime?.localFileBoardToken ? {
      connectionId: config.hub.defaultConnectionId, token: runtime.localFileBoardToken,
      dispatch: request => runtime.app.fetch(request),
    } : undefined, 'card-files'),
    contentReplicaClient: createConnectorClientResolver(hubStore, runtime?.localFileBoardToken ? {
      connectionId: config.hub.defaultConnectionId, token: runtime.localFileBoardToken,
      dispatch: request => runtime.app.fetch(request),
    } : undefined, 'content-replicas'),
    connectorClient: connectorClient!,
  }) : undefined;
  if (hub) startupDrains.push(() => hub.close());
  if (runtime) runtime.registerLegacyRoutes(app, async request => hubStore
    ? (await observePrincipal(request))?.admin === true
    : authObservations.observeAuthorization(request));
  else app.get('/api/health', (c) => c.json({ ok: true, role: config.serverRole, connector: false, ts: Date.now() }));

  // Serve the built web bundle (production) same-origin so no Vite dev server / HMR is needed.
  const webDistAbs = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (registerWebBundle(app, webDistAbs, { publicBaseUrl: config.publicBaseUrl })) {
    console.log(`Serving web bundle from ${webDistAbs}`);
  }

  const close = createShutdownCleanup(async () => {
    // Latch both public and all-mode internal transports before any await.
    // Rejected late requests must not reach auth against a closed Hub store.
    // Signal every independent original lane before awaiting any ACK. Catch
    // each synchronous failure separately so it cannot suppress peer signals.
    // All original flights must settle before the dependent owner cleanup;
    // a rejected or pending drain remains retained by createShutdownCleanup.
    const drains = [() => stopAdmissions(), () => runtime?.stopAdmissions(),
      () => websiteGateway?.close(), () => hub?.close(), () => executionWorker?.close(),
      () => hubStore?.executionCommands.close(), () => hubStore?.maintenanceCommands.close(),
      () => hubStore?.lifecycleCommands.close(), () => hubStore?.executionIssuers.close(),
      () => authorizationRoutes.close(), () => authRoutes.close(),
      () => administrative?.close(), () => connectorReads?.close(), () => administrativeCommands?.close()];
    const flights = drains.map(async (drain, index) => {
      const trace = performanceDiagnostics.start('application-drain');
      trace.add('step', index + 1);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000);
      warning.unref();
      let failed = true;
      try {
        const result: unknown = drain();
        if (result !== undefined) {
          if (!types.isPromise(result)) throw Error('Invalid application drain acknowledgement');
          // Observe the actual native Promise, not a caller then accessor or
          // a subclass observer. Only void completion proves original idle.
          await new Promise<void>((resolve, reject) => {
            try {
              void Promise.prototype.then.call(result, (value: unknown) => {
                if (value === undefined) resolve();
                else reject(Error('Invalid application drain acknowledgement'));
              }, reject);
            } catch (error) { reject(error); }
          });
        }
        failed = false; trace.add('settled', 1);
      } catch (error) { trace.add('unknown', 1); throw error; }
      finally { clearTimeout(warning); trace.finish(failed); }
    });
    const outcomes = await Promise.allSettled(flights);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }, [() => runtime?.close(), () => hubStore?.close(), () => sharedAuth?.close()], undefined, { stopAfterFailure: true });
  runtime?.activate?.();
  return {
    app,
    websiteGateway,
    close,
  };
  } catch (error) { startupApplicationCleanup.abandon(startupDrains, startupCleanups); throw error; }
}
