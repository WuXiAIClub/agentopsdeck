import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from './config.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';
import { createApplicationHttpShell } from './application-http-shell.js';
import { AsyncHubMemberOwner } from './hub/async-member-owner.js';
import { AsyncHubAuthRoutePort } from './hub/async-auth-route-port.js';
import { hubDefaultConnection } from './hub/member-owner-bootstrap.js';
import { createHubAdministrativeServices } from './hub/administrative-route-services.js';
import { createHubConnectorReadServices } from './hub/connector-read-services.js';
import { createHubEventFeedPort } from './hub/async-event-feed.js';
import { AsyncHubExecutionLeases } from './hub/async-execution-leases.js';
import { AsyncHubExecutionIssuers } from './hub/async-execution-issuers.js';
import { HubExecutionSync } from './hub/execution-sync.js';
import { HubExecutionWorker } from './hub/execution-worker.js';
import { HubExecutionUsage } from './hub/execution-usage.js';
import { WebsiteGateway } from './hub/website-gateway.js';
import { registerApplicationAuthorization } from './auth/application-authorization.js';
import { createApplicationAuthObservations } from './auth/application-auth-observations.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import type { ApplicationTransactionAuthEndpoint } from './auth/application-transaction-gate.js';
import { AuthPersistenceError } from './auth/private-store.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOriginalLocalPreferences, type LocalPreferenceProjection } from './auth/local-preference-http.js';
import type { LocalPreferenceSnapshot } from './auth/local-preference-domain.js';
import { hubMemberEvidence } from './hub/member-owner-domain.js';
import { registerAsyncHubRoutes } from './routes/hub-async.js';
import { registerWorkspaceAgentRoutes } from './routes/workspace-agent.js';
import { createIndependentDrain } from './lifecycle/independent-drain.js';
import { createShutdownCleanup } from './lifecycle/shutdown-cleanup.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { registerWebBundle } from './web-bundle.js';
import type { createAsyncConnectorSurface } from './connector/async-connector-surface.js';

type ConnectorSurface = Awaited<ReturnType<typeof createAsyncConnectorSurface>>;
type LocalHubLink = ReturnType<ConnectorSurface['localHubLink']>;
type LocalHubOptions = {
  deferActivation?: boolean;
  signedStream?: (request: Request) => boolean;
  applicationTransactions?: ApplicationTransactionAuthEndpoint;
  /** Original local read lanes, including physical work after HTTP timeout.
   * Must not await the entire Connector surface close (parent/child cycle). */
  legacyConsumersDrain?: () => Promise<void>;
  preferences?: LocalPreferenceProjection & { install(snapshot: LocalPreferenceSnapshot): void };
};

/** Real Hub-only process root. Auth and Hub retain their original files and
 * one co-located worker owner. Never open a synchronous peer or recover a
 * failed worker startup by entering the legacy application constructor. */
export async function createAsyncHubApplication(config: ServerConfig) {
  if (!shouldRegisterHubRoutes(config) || shouldRegisterConnectorRoutes(config)) {
    throw Error('Async Hub application requires the Hub-only server role');
  }
  const { app, websiteGateway, close } = await assembleAsyncHub(config);
  return { app, websiteGateway, close };
}

/** Private Hub sub-application for the combined parent. The caller owns the
 * ready Connector and MUST drain this layer before closing that surface.
 * This does not publish an all-role process root or its legacy write routes. */
export async function createAsyncLocalHubLayer(config: ServerConfig,
  connector: Pick<ConnectorSurface, 'ready' | 'localHubLink'> & Partial<Pick<ConnectorSurface, 'prepared'>>,
  options: LocalHubOptions = {}) {
  startupApplicationCleanup.assertAvailable();
  if (config.serverRole !== 'all' || !shouldRegisterHubRoutes(config)
    || !(connector.ready === true || options.deferActivation === true && connector.prepared === true)) {
    throw Error('Local Hub layer requires an all-role ready Connector');
  }
  const link = connector.localHubLink(options.deferActivation ? { allowPrepared: true } : undefined);
  if (link.local.connectionId !== config.hub.defaultConnectionId) {
    throw Error('Local Hub connection binding mismatch');
  }
  return assembleAsyncHub(config, link, options);
}

async function assembleAsyncHub(config: ServerConfig, link?: LocalHubLink, options: LocalHubOptions = {}) {
  startupApplicationCleanup.assertAvailable();
  if (config.websiteGateway && config.websiteGateway.port === config.port) {
    throw Error('Website gateway requires an enabled Hub and a separate listening port');
  }
  let frozen = false, active = false, physicalActivation: Promise<void> | undefined;
  let activating: Promise<void> | undefined, executionWorker: HubExecutionWorker | undefined;
  const legacyConsumersDrain = options.legacyConsumersDrain;
  const preferenceProjection = options.preferences;
  const drains: (() => void | Promise<void>)[] = [() => { frozen = true; active = false; },
    () => physicalActivation?.then(() => {}, () => {}), () => executionWorker?.close(),
    () => legacyConsumersDrain?.()];
  const cleanups: (() => void | Promise<void>)[] = [];
  try {
    const digest = config.accessKey ? createHash('sha256').update(config.accessKey).digest('hex') : undefined;
    const owner = new AsyncHubMemberOwner({ file: config.hub.databaseFile,
      ...(config.hub.vaultSecret === undefined ? {} : { encryptionSecret: config.hub.vaultSecret }),
      ...(config.hub.lifecycleEndpoints === undefined ? {} : { lifecycleEndpoints: config.hub.lifecycleEndpoints }),
      ...(config.accessKey === undefined ? {} : { administratorKey: config.accessKey }), loginLimiter: config.authRateLimit,
      auth: config.authSqliteFile ? { file: config.authSqliteFile,
        legacyFiles: [config.passkeysFile, config.authSessionsFile] }
        : { kind: 'json', passkeysFile: config.passkeysFile, sessionsFile: config.authSessionsFile },
      bootstrap: { legacyPreferences: { hidden: config.hiddenSessionsFile,
        archived: config.archivedSessionsFile, pinned: config.pinnedSessionsFile },
        ...(preferenceProjection ? { ownLocalPreferences: true as const } : {}),
        ...(config.hub.legacyPreferencesOwner === undefined ? {} : { legacyPreferencesOwner: config.hub.legacyPreferencesOwner }),
        ...(hubDefaultConnection(config) ? { defaultConnection: hubDefaultConnection(config)! } : {}) },
    }, undefined, undefined, 30_000, options.applicationTransactions);
    cleanups.push(() => owner.closeForShutdown());
    await owner.open();
    if (preferenceProjection) {
      const snapshot = await owner.command('legacyAuth', { kind: 'localPreferenceSnapshot', input: {} });
      if (snapshot.kind !== 'localPreferenceSnapshot') throw new AuthPersistenceError();
      preferenceProjection.install(snapshot.value);
    }
    const hubId = owner.metadata.hubId;
    const auth = new AsyncHubAuthRoutePort(owner, digest);
    // Configuration mutation must not leave the old constructor Key accepted.
    // Rotation is a private owner epoch operation, never a cached HTTP grant.
    const assertKeyBinding = () => {
      const current = config.accessKey ? createHash('sha256').update(config.accessKey).digest('hex') : undefined;
      if (current !== digest) throw new AuthPersistenceError();
    };
    const administrative = createHubAdministrativeServices(owner);
    drains.push(() => administrative.close());
    const principal = async (request: Request) => {
      assertKeyBinding();
      const actor = await administrative.authIdentity.requestPrincipal(request);
      // An original worker ACK is not authority for a different configured
      // owner. The Key can change while this physical observation is pending.
      assertKeyBinding();
      return actor;
    };
    const assertAvailable = () => {
      if (!active || frozen) throw new AuthPersistenceError();
      // Shared by asynchronous admission/rechecks AND the synchronous final
      // effect fence; never leave a previously authorized scope usable after
      // an owner-binding change. Committed ACK projection does not call this.
      assertKeyBinding();
    };
    const authorizeCommand = async (request: Request) => {
      assertAvailable();
      const actor = await principal(request);
      assertAvailable();
      return actor?.admin === true;
    };
    const commands = createApplicationCommandScopes({ authorize: authorizeCommand, assertAvailable });
    drains.push(() => commands.close());
    // Only the original application administrator can observe local legacy
    // sessions. This observation is NOT a Connector transaction/native grant.
    const observeActor = async (request: Request) => {
      assertAvailable();
      const actor = await principal(request);
      assertAvailable();
      return actor?.admin === true ? `administrator:${actor.userId}` : undefined;
    };
    const observations = createApplicationAuthObservations({ hasHub: true, principal,
      standaloneAuthorization: request => auth.authority.authorize(request),
      memberIdentity: request => administrative.authIdentity.memberIdentity(request),
      keyIdentity: key => administrative.authIdentity.keyIdentity(key),
      recoveryScope: (actor, request) => administrative.authIdentity.recoveryScope(request, actor),
    });
    const leases = new AsyncHubExecutionLeases(owner);
    const issuers = new AsyncHubExecutionIssuers(owner, link?.local);
    const issuerClient = (lease: import('./hub/execution-leases.js').ExecutionLease) => issuers.clientFor(lease);
    const revokeRetiredLocal = link?.operator ? async (
      lease: import('./hub/execution-leases.js').ExecutionLease,
      binding: { principalId: string; grantKey: string; version: number; runtime: string | undefined; sessionKey: string | undefined },
    ) => {
      if (!issuers.isLocalLease(lease) || !link.operator.revokeRetiredGrant) return undefined;
      const reply = await link.operator.revokeRetiredGrant({
        expectedNode: lease.nodeId,
        issuerTokenId: lease.issuerId,
        hubId,
        body: binding,
      });
      return reply.status === 200 ? reply.value : undefined;
    } : undefined;
    const executionSync = new HubExecutionSync(leases, hubId, issuerClient, undefined, undefined, undefined, revokeRetiredLocal);
    drains.push(() => executionSync.close());
    const reads = createHubConnectorReadServices(owner, link?.local, undefined, executionSync, link?.operator);
    drains.push(() => reads.close());
    const websiteGateway = config.websiteGateway ? new WebsiteGateway(config.websiteGateway) : undefined;
    if (websiteGateway) drains.push(() => websiteGateway.close());
    const { app, stopAdmissions, allowedBrowserOrigin } = createApplicationHttpShell(config);
    drains.push(() => stopAdmissions());
    app.use('*', async (c, next) => {
      if (!active || frozen) return c.json({ error: 'server_not_ready' }, 503);
      return next();
    });
    const authorization = registerApplicationAuthorization(app, { hasHub: true, principal,
      authorize: observations.observeAuthorization, recordActivity: request => administrative.activity.recordActivity(request),
      audit: administrative.audit, signedStream: options.signedStream ?? (() => false), allowedBrowserOrigin });
    drains.push(() => authorization.close());
    registerWorkspaceAgentRoutes(app, administrative.boardMachine);
    const authRoutes = registerAuthRoutes(app, {
      get accessKey() { return config.accessKey; },
      passkeys: auth.passkeys, sessions: auth.sessions, authority: auth.authority, ...observations,
      auditLog: administrative.audit, loginLimiter: administrative.loginLimiter,
      lockoutSeconds: Math.ceil(config.authRateLimit.lockoutMs / 1000),
      memberLogin: (key, request) => administrative.authSessions.memberLogin(key, request),
      revokeMemberSession: (token, request) => administrative.authSessions.revokeMemberSession(token, request),
    });
    drains.push(() => authRoutes.close());
    const hub = await registerAsyncHubRoutes(app, { config, hubId, administrative, reads,
      eventFeed: userId => createHubEventFeedPort(owner, userId, link?.local),
      normalizeError: () => 'Connector request failed', ...(websiteGateway ? { websiteGateway } : {}) });
    drains.push(() => hub.close());
    // Canonical Hub session preference routes were installed above. Only raw
    // local session keys fall through to this original file-owned write lane.
    if (preferenceProjection) {
      const preferences = registerOriginalLocalPreferences(app, {
        evidence: hubMemberEvidence,
        assertAvailable() { assertAvailable(); preferenceProjection.assertAvailable(); },
        async change(input) {
          const result = await owner.command('legacyAuth', { kind: 'localPreferenceChange', input });
          if (result.kind !== 'localPreferenceChange') throw new AuthPersistenceError();
          return result.value;
        },
        project: result => preferenceProjection.project(result),
      });
      drains.push(() => preferences.close());
    }
    if (!link) {
      // The combined parent owns process health and frontend publication. A
      // Hub-only sub-app must never advertise a fully wired all-role process.
      app.get('/api/health', c => c.json({ ok: true, role: config.serverRole, connector: false, ts: Date.now() }));
      const webDistAbs = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
      if (registerWebBundle(app, webDistAbs, { publicBaseUrl: config.publicBaseUrl })) console.log(`Serving web bundle from ${webDistAbs}`);
    }
    // No reconciliation timer or external route is published before ready and
    // complete assembly. Record every acquired owner before starting its peer.
    const drain = createIndependentDrain(drains, 'hub-route-drain');
    const close = createShutdownCleanup(drain, cleanups, undefined, { stopAfterFailure: true });
    const activateWork = (): Promise<void> => {
      if (frozen) return Promise.reject(Error('Hub layer is closing'));
      return physicalActivation ??= Promise.resolve().then(async () => {
        if (frozen) throw Error('Hub layer is closing');
        await hub.activate();
        if (frozen) throw Error('Hub layer is closing');
        executionWorker = new HubExecutionWorker(executionSync, 3_000,
          new HubExecutionUsage(leases, hubId, executionSync, issuerClient));
        active = true;
      });
    };
    const activate = (): Promise<void> => {
      if (frozen) return Promise.reject(Error('Hub layer is closing'));
      return activating ??= activateWork().catch(async error => {
        try { await close(); } catch { /* Retain the exact failed owner. */ }
        throw error;
      });
    };
    if (!options.deferActivation) await activateWork();
    return { app, websiteGateway, close, activate, observeActor, commands, get ready() { return active && !frozen; } };
  } catch (error) {
    // Retain exact owners before awaiting. A pending ACK fences construction;
    // cleanup failure never certifies idle or permits replacement/replay.
    startupApplicationCleanup.abandon(drains, cleanups);
    try { await startupApplicationCleanup.waitForCurrentCleanup(); } catch { /* original startup error wins */ }
    throw error;
  }
}
