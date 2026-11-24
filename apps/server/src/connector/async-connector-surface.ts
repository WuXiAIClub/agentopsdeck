import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AGENTOPSDECK_BUILD, AOD_MODEL_SET_ID, CONNECTOR_PROTOCOL, MAX_MESSAGE_CHARS, type AgentSummary, type ConnectorCapabilities } from '@agentopsdeck/shared';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import { isOpenClawCliAvailable } from '../openclaw/cli.js';
import { readGatewayModelSetStatus, reconcileGatewayModelSet } from './model-set.js';
import { UpdateAuthorizationError } from './update-service.js';
import type { ServerConfig } from '../config.js';
import { DeckStore } from '../projection/deck-store.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { linuxMetricsProvider, MetricsSampler } from '../system/metrics.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { ExecutionProjectionChanged } from './execution-projection-inventory.js';
import { AsyncLocalCredentials } from './async-local-credentials.js';
import { localCredentialPlan } from './local-credential-plan.js';
import { AsyncConnectorReadAuthority } from './read-authority.js';
import { AsyncSessionReads } from './async-session-reads.js';
import { AsyncConnectorControl } from './async-connector-control.js';
import { createAsyncRuntimeAssembly, type AsyncRuntimeAssemblyOptions, type AsyncRuntimeAssemblyPorts } from './async-runtime-assembly.js';
import { registerAsyncRuntimeHttp } from './async-runtime-http.js';
import type { ConnectorPublicReads } from './public-reads-http.js';
import { registerConnectorMachineHttp } from './machine-http.js';
import { workerConnectorMachineAuthority } from './machine-authority.js';
import { registerAsyncConnectorWorkspaceHttp, type WorkspaceSessionRead } from './workspace-http.js';
import { registerConnectorBoardBindings, type BoardBindingSessionRead } from './board-bindings-http.js';
import { createAsyncFileSessions } from './async-file-sessions.js';
import { createAsyncConfiguredBinding } from './async-configured-binding.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { createAsyncConnectorMaintenance } from './async-connector-maintenance.js';
import type { SessionReadActor } from '../auth/session-read-authority.js';
import { registerAsyncLegacySessionReads } from './async-legacy-session-reads.js';
import { createHistoryReadScheduler } from '../refresh/history-read-scheduler.js';
import { createHotSessionWarmer, HotSessionTracker } from '../refresh/hot-sessions.js';
import { AsyncLocalIssuerOperator } from './async-local-issuer-operator.js';
import type { LocalPreferenceSnapshot } from '../auth/local-preference-domain.js';
import type { SystemReadDependencies } from '../routes/system.js';
import type { ApplicationMediaPorts } from '../application-media-http.js';
import { readJsonBody } from '../utils/http-body.js';

type Assembly = Awaited<ReturnType<typeof createAsyncRuntimeAssembly>>;
export type ConnectorSurfaceBinding = {
  /** Original configured transports, borrowed until all HTTP work drains. */
  system?: Pick<SystemReadDependencies, 'admin' | 'gateway' | 'memoryDiagnostics'>;
  media?: ApplicationMediaPorts;
  runtimes: Omit<AsyncRuntimeAssemblyOptions, 'owner' | 'deck' | 'nodeId' | 'snapshot' | 'diagnostics'>;
  native?: AsyncRuntimeAssemblyPorts;
  /** Once, after inert assembly construction and before any activation. */
  attach?(assembly: Assembly): void | Promise<void>;
  /** Original full discovery, not a single-runtime display refresh. Must not
   * call snapshot recursively or wait for a continuing Goal to become idle. */
  refreshSessions(settings?: { maxAgeMs?: number }): Promise<void>;
  agents(): AgentSummary[] | PromiseLike<AgentSummary[]>;
  /** Original native/journal lookup, not a Deck-only readiness guess. */
  workspaceSession?: WorkspaceSessionRead;
  /** Original native ID/deletion/readiness lookup for private tool grants. */
  boardBindingSession?: BoardBindingSessionRead;
  /** Original external discovery/gateway resources, after all consumers drain. */
  close(): Promise<void>;
};
export type ConnectorSurfaceContext = {
  deck: DeckStore; nodeId: string; snapshot: EventSnapshotRead;
  credentials: Pick<AsyncLocalCredentials, 'token'>;
  /** Resolve only from a native turn, after construction/startup. */
  workspace(): Pick<ReturnType<typeof registerAsyncConnectorWorkspaceHttp>, 'boards' | 'cards' | 'replicas'> | undefined;
};
export type AsyncConnectorSurfaceOptions = {
  owner: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile' | 'authorityChanges'>
    & Partial<Pick<AsyncConnectorOwner, 'applicationTransactionAuthEndpoint'>>;
  config: ServerConfig;
  connector: ConnectorPublicReads['connector'];
  /** Inert original native/discovery wiring. It must clean its own partial
   * construction if it throws; it must not start workers or open another SQL. */
  bind?(context: ConnectorSurfaceContext): ConnectorSurfaceBinding | Promise<ConnectorSurfaceBinding>;
  sampler?: ConnectorPublicReads['sampler'];
  diagnostics?: PerformanceDiagnostics;
  waitMs?: number;
  /** Original application admin identity. Omitted in standalone Connector;
   * bootstrap/Connector tokens never implicitly authorize old frontend APIs. */
  legacyReads?: { observeActor: SessionReadActor };
  /** Parent owns all three original files; this surface must not read or write
   * them synchronously, including during construction. */
  committedPreferences?: LocalPreferenceSnapshot;
  /** Freeze/drain parent ACK-only consumers before disposing the event
   * projection. Must not wait for this surface.close() (dependency cycle). */
  projectionConsumersDrain?: () => Promise<void>;
};

/** Public/control/runtime sub-root. Borrows the sole startup SQL owner; no
 * synchronous SQL fallback, second token writer or unknown-effect replay.
 * Remaining legacy consumers still have to join before default-root cutover.
 * Constructing this surface does not activate any native executor. */
export async function createAsyncConnectorSurface(options: AsyncConnectorSurfaceOptions) {
  const { owner, config } = options, diagnostics = options.diagnostics ?? performanceDiagnostics;
  // This dependency belongs to the acquired surface, not to a mutable caller
  // configuration. Retain it before the first owner await so shutdown cannot
  // accidentally release a projection that still has a committed ACK producer.
  const projectionConsumersDrain = options.projectionConsumersDrain;
  const localHubEnabled = config.serverRole === 'all', localIssuerEnabled = config.hub.allowLocalExecutionSetup === true;
  const localConnectionId = config.hub.defaultConnectionId;
  let startupStage = 0;
  const report = (step: number, failed: boolean) => {
    const trace = guardedTrace(diagnostics, 'connector-runtime-assembly');
    trace.add('step', step); trace.add('startupStage', startupStage); trace.finish(failed);
  };
  const events = new AsyncConnectorEventProjection(owner, diagnostics, true);
  const credentials = new AsyncLocalCredentials(owner, localCredentialPlan(config), diagnostics);
  let binding: ConnectorSurfaceBinding | undefined, assembly: Assembly | undefined;
  let reads: AsyncSessionReads | undefined, authority: AsyncConnectorReadAuthority | undefined;
  let control: AsyncConnectorControl | undefined, http: ReturnType<typeof registerAsyncRuntimeHttp> | undefined;
  let machine: ReturnType<typeof registerConnectorMachineHttp> | undefined;
  let workspace: ReturnType<typeof registerAsyncConnectorWorkspaceHttp> | undefined;
  let boardBindings: ReturnType<typeof registerConnectorBoardBindings> | undefined;
  let sampler: ConnectorPublicReads['sampler'] | undefined;
  let maintenance: ReturnType<typeof createAsyncConnectorMaintenance> | undefined;
  let legacyReads: ReturnType<typeof registerAsyncLegacySessionReads> | undefined;
  let hotSessions: ReturnType<typeof createHotSessionWarmer> | undefined;
  let surfaceDeck: DeckStore | undefined;
  const hotTracker = new HotSessionTracker();
  const refreshes = createTaskDrain();
  const surfaceRoutes = createTaskDrain();
  const historyReads = createHistoryReadScheduler();
  let state: 'created' | 'starting' | 'prepared' | 'ready' | 'failed' | 'closing' | 'closed' = 'created';
  let physicalPreparation: Promise<void> | undefined, preparing: Promise<void> | undefined;
  let prepared = false;
  let physicalStart: Promise<void> | undefined, starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  let refreshWork: Promise<void> | undefined;
  // Native connectivity/maintenance pauses gate execution in its original
  // runtime, NOT public catalog/receipt delivery. Never require Goal idle.
  const ready = () => state === 'ready' && assembly?.state === 'ready';
  const localOperator = new AsyncLocalIssuerOperator(owner, () => localHubEnabled && localIssuerEnabled && ready(), diagnostics);
  const assertLive = () => {
    if (state !== 'starting' && state !== 'prepared' && state !== 'ready') throw new ConnectorOwnerUnavailable();
  };
  const refreshOriginals = (settings: { maxAgeMs?: number } = {}): Promise<void> => {
    try { assertLive(); } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    if (refreshWork) return refreshWork;
    const discoveryMaxAgeMs = settings.maxAgeMs ?? (ready() ? 2_000 : 0);
    // Start every original participant despite a peer's synchronous failure;
    // keep the physical operation retained through timeout/close.
    const work = Promise.resolve().then(async () => {
      assertLive();
      const results = await Promise.allSettled([
        () => binding!.refreshSessions({ maxAgeMs: discoveryMaxAgeMs }), () => assembly!.refreshProjection({ maxAgeMs: 0 }),
      ].map(run => Promise.resolve().then(run)));
      assertLive();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) {
        if (failures.every(result => result.reason instanceof ExecutionProjectionChanged)) throw new ExecutionProjectionChanged();
        throw new ConnectorOwnerUnavailable();
      }
    });
    refreshWork = work;
    void work.then(() => { if (refreshWork === work) refreshWork = undefined; },
      () => { if (refreshWork === work) refreshWork = undefined; });
    return work;
  };
  // Startup alone prepares the original catalog under restored maintenance,
  // while public admission is still shut. Later background/display refreshes
  // participate in the same physical maintenance barrier as HTTP writers.
  const fullRefresh = (settings?: { maxAgeMs?: number }): Promise<void> => {
    const work = state === 'starting' || state === 'prepared' ? refreshOriginals({ maxAgeMs: 0 }) : refreshes.run(() => refreshOriginals(settings));
    void work.then(() => { if (ready()) hotSessions?.scheduleWarm(); }, () => {});
    return work;
  };
  const refreshMessages = (key: string, settings: { maxAgeMs?: number; priority?: number } = {}): Promise<void> => refreshes.run(async () => {
    if (!ready()) throw new ConnectorOwnerUnavailable();
    const priority = settings.priority ?? hotTracker.foregroundPriorityFor(surfaceDeck?.getSession(key), key);
    const selection = { maxAgeMs: settings.maxAgeMs ?? 1500, readOnly: true as const, priority };
    await historyReads.run(key, selection, async () => {
      assertLive();
      // Reserved Agent keys must never be interpreted as OpenClaw sessions,
      // even if that Agent is disabled or its native connection is unavailable.
      const agent = assembly!.agents.forSession(key);
      if (agent) await agent.refreshSession(key, selection);
      else await binding!.runtimes.openclaw.history.refresh(key, selection);
      assertLive();
    });
  });
  const snapshot: EventSnapshotRead = capture => events.snapshot(capture, fullRefresh);
  const safe = (action: () => Promise<unknown> | undefined) => {
    try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    state = 'closing';
    // Fence HTTP, all read/control owners and every executor synchronously.
    const consumers = safe(() => projectionConsumersDrain?.());
    const drains = [() => localOperator.close(), () => surfaceRoutes.close(), () => hotSessions?.close(), () => maintenance?.close(), () => legacyReads?.close(), () => http?.close(), () => machine?.close(), () => workspace?.close(), () => boardBindings?.close(), () => reads?.close(), () => control?.close(),
      () => authority?.close(), () => refreshes.close(), () => historyReads.close()].map(safe);
    const preparation = physicalPreparation, start = physicalStart, refresh = refreshWork;
    void Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...drains, consumers, ...(preparation ? [preparation] : []), ...(start ? [start] : []), ...(refresh ? [refresh] : [])]);
      // A failed parent drain is not evidence that no future committed ACK
      // can arrive. Keep its projection and retained owners, never certify
      // disposal or replace the borrowed SQL owner.
      if (results[drains.length]?.status !== 'fulfilled') {
        state = 'failed'; report(12, true); throw new ConnectorOwnerUnavailable();
      }
      // Startup/refresh failure is already reported to its caller. Cleanup
      // failures remain visible and never cause another lease acquisition.
      let failed = results.slice(0, drains.length).some(result => result.status === 'rejected');
      for (const release of [() => assembly?.close(), () => binding?.close(), () => events.close(), () => credentials.close(), () => http ? undefined : sampler?.close()]) {
        const result = await Promise.allSettled([safe(release)]);
        if (result[0].status === 'rejected') failed = true;
      }
      state = failed ? 'failed' : 'closed'; report(12, failed);
      if (failed) throw new ConnectorOwnerUnavailable();
    }).then(resolve, reject);
    return closing;
  };
  try {
    const nodeId = await owner.command('nodeIdentity', {});
    if (!validConnectorOwnerOutput('nodeIdentity', nodeId)) throw new ConnectorOwnerUnavailable();
    const deck = surfaceDeck = new DeckStore({ projectionEvents: events.deckEvents,
      sessionTitlesFile: config.sessionTitlesFile, sessionThinkingOverridesFile: config.sessionThinkingOverridesFile,
      ...(options.committedPreferences === undefined ? { hiddenSessionsFile: config.hiddenSessionsFile,
        archivedSessionsFile: config.archivedSessionsFile, pinnedSessionsFile: config.pinnedSessionsFile }
        : { committedPreferences: options.committedPreferences }) });
    const context = { deck, nodeId, snapshot, credentials, workspace: () => workspace };
    binding = await (options.bind ? options.bind(context) : createAsyncConfiguredBinding(config, context, diagnostics));
    const directories = {
      ...(config.claude?.boardToolsDirectory ? { 'claude-code': config.claude.boardToolsDirectory } : {}),
      ...(config.codex.boardToolsDirectory ? { codex: config.codex.boardToolsDirectory } : {}),
      ...(config.copilot?.boardToolsDirectory ? { ghcp: config.copilot.boardToolsDirectory } : {}),
    };
    assembly = await createAsyncRuntimeAssembly({ ...binding.runtimes,
      ...(binding.runtimes.media ? { media: { ...binding.runtimes.media, refreshMessages } } : {}),
      owner, deck, nodeId, snapshot, diagnostics }, binding.native);
    await binding.attach?.(assembly);
    hotSessions = createHotSessionWarmer({
      getSessions: () => deck.getSessionsState().groups.flatMap(group => group.sessions),
      isHistoryReady: key => {
        const readyState = assembly!.agents.historyReady(key);
        return readyState !== undefined ? readyState : binding!.runtimes.openclaw.history.historyReady(key);
      },
      refreshSession: (key, warmOptions) => refreshMessages(key, warmOptions),
      getLoadSnapshot: () => historyReads.inspect(),
      tracker: hotTracker,
    });
    const fileSessions = createAsyncFileSessions(owner, assembly, deck);
    const timeout = options.waitMs === undefined ? {} : { timeoutMs: options.waitMs };
    const wait = options.waitMs === undefined ? {} : { waitMs: options.waitMs };
    authority = new AsyncConnectorReadAuthority(owner, { diagnostics, ...timeout });
    reads = new AsyncSessionReads(owner, { projection: deck, snapshot, refreshers: [fullRefresh],
      snapshotReady: ready, connector: options.connector, ...timeout, diagnostics });
    control = new AsyncConnectorControl(owner, { diagnostics, ...wait });
    sampler = options.sampler ?? new MetricsSampler({ kind: 'connector', id: nodeId }, linuxMetricsProvider(config.metricVolumes));
    const app = new Hono();
    http = registerAsyncRuntimeHttp(app, nodeId, { ...assembly.http, sessionReads: { reads }, control, available: ready,
      beforeRoutes: () => {
        maintenance = createAsyncConnectorMaintenance(app, { owner, nodeId, config, runtimes: assembly!, deck,
          available: ready, pauseRefresh: refreshes.pause, diagnostics });
      },
      publicReads: { authority, changes: events.changes, replay: after => events.replay(after), agents: () => binding!.agents(),
        mediaRoot: config.inboundMediaDir, sampler, connector: options.connector, diagnostics, ...wait } });
    const base = '/api/connector/v1';
    const authFailure = (error: unknown, scope: string): { error: string; status: 403 | 408 | 503 } => {
      const status = error instanceof UpdateAuthorizationError ? 403
        : error instanceof HTTPException ? error.status
        : error instanceof ReadRequestError ? error.status : 503;
      const code = status === 403 ? 403 : status === 408 ? 408 : 503;
      return { error: code === 403 ? `missing ${scope} scope` : 'Connector unavailable', status: code };
    };
    app.get(`${base}/info`, c => {
      c.header('Cache-Control', 'no-store');
      return c.json({
        service: 'aod-connector',
        version: config.connector.version,
        environment: {
          idHint: options.connector.environmentId,
          label: options.connector.environmentLabel,
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
      });
    });
    app.get(`${base}/health`, c => {
      c.header('Cache-Control', 'no-store');
      const gateway = deck.getGateway();
      const cliAvailable = config.localOpenClawCli && isOpenClawCliAvailable();
      const codexReady = assembly!.codex.enabled === true && assembly!.codex.isSessionListReady();
      const claude = assembly!.sdk.claude, copilot = assembly!.sdk.copilot, hermes = assembly!.hermes;
      const hermesEnabled = !!config.hermes?.enabled || hermes.agents.length > 0;
      return c.json({
        ok: true,
        status: gateway.ok || cliAvailable || codexReady || hermes.ready || claude?.ready || copilot?.ready ? 'online' : 'degraded',
        gateway,
        codex: { enabled: assembly!.codex.enabled === true, sessionListReady: codexReady },
        hermes: { enabled: hermesEnabled, ready: hermes.ready === true, status: hermesEnabled ? hermes.status : 'disabled' },
        claude: { enabled: !!claude, ready: claude?.ready === true, status: claude?.status ?? 'disabled' },
        copilot: { enabled: !!copilot, ready: copilot?.ready === true, status: copilot?.status ?? 'disabled' },
        fallback: { openclawCli: cliAvailable },
        updatedAt: Date.now(),
      });
    });
    app.get(`${base}/capabilities`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        return await surfaceRoutes.run(async () => {
          const handle = await authority!.begin(c.req.raw, 'sessions:read');
          const update = await maintenance!.status(c.req.raw);
          await handle.check();
          const claude = assembly!.sdk.claude, copilot = assembly!.sdk.copilot, hermes = assembly!.hermes;
          const hermesEnabled = !!config.hermes?.enabled || hermes.agents.length > 0;
          const capabilities: ConnectorCapabilities & { principal: { tokenId: string; label: string }; limits: { maxRequestsPerMinute: number; maxSseConnections: number } } = {
            principal: { tokenId: handle.principal.tokenId, label: handle.principal.label },
            protocol: CONNECTOR_PROTOCOL,
            connector: { service: 'aod-connector', version: config.connector.version, revision: config.connector.revision, build: AGENTOPSDECK_BUILD },
            environment: { idHint: options.connector.environmentId, label: options.connector.environmentLabel },
            features: {
              scopedTokens: true, sessions: true, messages: true, events: true, media: true, users: true, pairing: false,
              modelSet: true, interactions: true, sessionFileIndex: true,
              connectorUpdate: config.connector.updateEnabled, workspaceFiles: !!Object.keys(config.fileBrowserRoots ?? {}).length,
            },
            runtimes: {
              hermes: { enabled: hermesEnabled, ready: hermes.ready === true, ownerOnly: true,
                features: { text: true, queue: true, interrupt: true, history: true, attachments: false, compact: false, delete: true, modelOverride: false, interactions: false } },
              'claude-code': { enabled: !!claude, ready: claude?.ready === true, status: claude?.status ?? 'disabled', ownerOnly: true,
                features: { text: true, queue: true, interrupt: true, history: true, attachments: true, compact: true, delete: true, modelOverride: true, interactions: claude?.ready === true } },
              ghcp: { enabled: !!copilot, ready: copilot?.ready === true, status: copilot?.status ?? 'disabled', ownerOnly: true,
                features: { text: true, queue: true, interrupt: true, history: true, attachments: true, compact: true, delete: true, modelOverride: true, interactions: copilot?.ready === true } },
            },
            scopes: handle.principal.scopes,
            limits: { maxMessageChars: MAX_MESSAGE_CHARS, maxRequestsPerMinute: 120, maxSseConnections: 2 },
            gateway: { statusVisible: handle.principal.scopes.includes('models:read'), opsAllowed: handle.principal.scopes.includes('models:write'), version: config.connector.gatewayVersion },
            update,
          };
          return c.json(capabilities);
        });
      } catch (error) {
        const res = authFailure(error, 'sessions:read');
        return c.json({ error: res.error }, res.status);
      }
    });
    app.get(`${base}/gateway/model-set`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        return await surfaceRoutes.run(async () => {
          const handle = await authority!.begin(c.req.raw, 'models:read');
          const status = await readGatewayModelSetStatus(config);
          await handle.check();
          return c.json({ ...status, ...(status.error ? { error: 'Model set status unavailable' } : {}) });
        });
      } catch (error) {
        const res = authFailure(error, 'models:read');
        return c.json({ error: res.error }, res.status);
      }
    });
    app.post(`${base}/gateway/model-set/reconcile`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        return await surfaceRoutes.run(async () => {
          const writer = await control!.writeScope(c.req.raw, 'models:write');
          const body = await readJsonBody(c.req.raw, 8192) as { setId?: unknown; dryRun?: unknown };
          assertLive();
          await writer.check();
          assertLive();
          if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'JSON object required' }, 400);
          if (body.setId !== AOD_MODEL_SET_ID) return c.json({ error: 'unsupported model set' }, 400);
          if (Object.prototype.hasOwnProperty.call(body, 'models') || Object.prototype.hasOwnProperty.call(body, 'aliases')) {
            return c.json({ error: 'arbitrary model lists are not accepted' }, 400);
          }
          try {
            const result = await reconcileGatewayModelSet(config, body.dryRun === true, {
              checkWriteAuthority: async () => {
                assertLive();
                await writer.check();
                assertLive();
              },
            });
            assertLive();
            await writer.check();
            assertLive();
            return c.json({ ...result, status: { ...result.status,
              ...(result.status.error ? { error: 'Model set status unavailable' } : {}) } });
          } catch (error) {
            if (
              error instanceof HTTPException
              || error instanceof ReadRequestError
              || error instanceof ConnectorOwnerUnavailable
              || error instanceof UpdateAuthorizationError
            ) {
              throw error;
            }
            return c.json({ error: 'Model set reconciliation unavailable' }, 400);
          }
        });
      } catch (error) {
        if (error instanceof HTTPException && [400, 413].includes(error.status)) return error.getResponse();
        const res = authFailure(error, 'models:write');
        return c.json({ error: res.error }, res.status);
      }
    });
    app.get(`${base}/models/:runtime`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        return await surfaceRoutes.run(async () => {
          const handle = await authority!.begin(c.req.raw, 'models:read');
          const runtime = c.req.param('runtime');
          if (runtime !== 'openclaw') {
            await handle.check();
            return c.json({ error: 'Model selection is unavailable for this runtime' }, 404);
          }
          try {
            const models = (await readGatewayModelSetStatus(config)).observed.map(model => ({ id: model.alias, label: model.alias }));
            await handle.check();
            return c.json({ models });
          } catch {
            return c.json({ error: 'Model catalog unavailable; retry when the runtime is ready' }, 503);
          }
        });
      } catch (error) {
        const res = authFailure(error, 'models:read');
        return c.json({ error: res.error }, res.status);
      }
    });
    if (options.legacyReads) legacyReads = registerAsyncLegacySessionReads(app, {
      deck, observeActor: options.legacyReads.observeActor, available: ready,
      refreshSessions: fullRefresh, refreshMessages, snapshot, replay: after => events.replay(after),
      agents: () => binding!.agents(), diagnostics, ...wait,
    });
    const machineAuthority = workerConnectorMachineAuthority(owner);
    machine = registerConnectorMachineHttp(app, machineAuthority, config);
    boardBindings = registerConnectorBoardBindings(app, { tokens: machineAuthority, directories,
      policies: config.boardBindingPolicies ?? [], resolveSession: binding.boardBindingSession ?? fileSessions.boardBindingSession,
      deferredStart: true, available: ready });
    if (config.boardFiles) workspace = registerAsyncConnectorWorkspaceHttp(app, { owner,
      config: { ...config, boardFiles: config.boardFiles }, session: binding.workspaceSession ?? fileSessions.workspaceSession, available: ready, diagnostics });
    const runtimes = assembly;
    const startupFailed = async () => {
      if (state !== 'closing' && state !== 'closed') state = 'failed';
      report(11, true);
      try { await close(); } catch { /* Close has its own redacted diagnostic. */ }
      throw new ConnectorOwnerUnavailable();
    };
    const prepare = (): Promise<void> => {
      if (state !== 'created' && state !== 'starting' && state !== 'prepared' && state !== 'ready') return Promise.reject(new ConnectorOwnerUnavailable());
      if (preparing) return preparing;
      state = 'starting';
      // No native executor is activated here. The trusted parent may assemble
      // Auth/Hub against the retained private link before execution starts.
      physicalPreparation = Promise.resolve().then(async () => {
        assertLive();
        startupStage = 1;
        await maintenance!.start(); assertLive();
        startupStage = 2;
        if (!await events.recover()) throw new ConnectorOwnerUnavailable();
        startupStage = 3;
        assertLive(); await machine!.ready; assertLive();
        startupStage = 4;
        await credentials.open(); assertLive();
        // Recover managed grants and file receipts before native workers can
        // consume them. Neither recovery guesses session readiness from Deck.
        startupStage = 5;
        await boardBindings!.start(); assertLive();
        startupStage = 6;
        if (workspace) { await workspace.start(); assertLive(); }
        report(34, false);
        prepared = true; state = 'prepared'; report(35, false);
      });
      // Cleanup waits on raw preparation, never on this cleanup-bearing catch.
      return preparing = physicalPreparation.catch(startupFailed);
    };
    const start = (): Promise<void> => {
      if (state !== 'created' && state !== 'starting' && state !== 'prepared' && state !== 'ready') return Promise.reject(new ConnectorOwnerUnavailable());
      if (starting) return starting;
      const preparation = prepare();
      physicalStart = Promise.resolve().then(async () => {
        // Observe the raw work: the public prepare rejection itself awaits
        // close, which drains physicalStart and must not form a wait cycle.
        await physicalPreparation; assertLive();
        state = 'starting';
        startupStage = 7;
        await runtimes.start(); assertLive();
        startupStage = 8;
        await fullRefresh(); assertLive();
        // Prove the shared catalog against the original journal/facts head.
        startupStage = 9;
        await events.startupSnapshot(fullRefresh); assertLive();
        if (runtimes.state !== 'ready') throw new ConnectorOwnerUnavailable();
        state = 'ready'; report(10, false);
        hotSessions?.scheduleWarm();
      });
      void preparation.catch(() => {});
      return starting = physicalStart.catch(startupFailed);
    };
    // Trusted parent only. Drain Hub consumers BEFORE closing this surface.
    // This is transport authority, never the original caller's user evidence.
    let localLink: ReturnType<typeof makeLocalLink> | undefined;
    function makeLocalLink() {
      const token = credentials.token('daily');
      if (!token) throw new ConnectorOwnerUnavailable();
      const maintenanceToken = credentials.token('maintenance'), boardBindingToken = credentials.token('boards');
      const fileBoardToken = credentials.token('files'), sourceApprovalToken = credentials.token('sourceApproval');
      const dispatch = (request: Request): Response | Promise<Response> => {
        if (!ready()) return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
        return app.fetch(request);
      };
      return Object.freeze({ local: Object.freeze({ connectionId: localConnectionId, token,
        ...(maintenanceToken ? { maintenanceToken } : {}), ...(boardBindingToken ? { boardBindingToken } : {}),
        ...(fileBoardToken ? { fileBoardToken } : {}), ...(sourceApprovalToken ? { sourceApprovalToken } : {}), dispatch }), operator: localOperator });
    }
    const localHubLink = (options: { allowPrepared?: boolean } = {}) => {
      if (!localHubEnabled || !(ready() || options.allowPrepared === true && prepared && state === 'prepared')) throw new ConnectorOwnerUnavailable();
      return localLink ??= makeLocalLink();
    };
    // A parent Auth/Hub owner must retain authority through physical reads,
    // even after their HTTP waiters ended. This lane never waits on close().
    const closeLegacyReads = () => legacyReads?.close() ?? Promise.resolve();
    return { app, nodeId, deck, events, credentials, runtimes, workspace, boardBindings, snapshot, prepare, start, close, localHubLink, closeLegacyReads,
      system: binding.system,
      media: binding.media,
      get prepared() { return prepared && (state === 'prepared' || state === 'ready'); },
      get ready() { return ready(); }, get state() { return state; } };
  } catch {
    report(9, true); try { await close(); } catch { /* Original failure remains unavailable. */ }
    throw new ConnectorOwnerUnavailable();
  }
}
