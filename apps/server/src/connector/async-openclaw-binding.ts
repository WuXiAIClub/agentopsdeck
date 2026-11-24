import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import { GatewayWsClient, type GatewayAsyncObserver } from '../gateway/ws-client.js';
import { bridgeArtifactReferences, withArtifactCapability, type ArtifactRegistryAccess } from '../messages/artifact-receiver.js';
import { AsyncArtifactRegistry } from '../messages/async-artifact-registry.js';
import { bridgeRawMediaDirectives } from '../messages/media-bridge.js';
import { persistUploadedMedia } from '../messages/send-message.js';
import { createOpenClawHistory } from '../openclaw/history-projection.js';
import type { DeckStore } from '../projection/deck-store.js';
import { createHistoryReadScheduler } from '../refresh/history-read-scheduler.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncOpenClawApplicationOptions } from './async-openclaw-application.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { createOpenClawSessionSource } from './openclaw-session-source.js';
import { createConnectorSessionDiscovery, type ConnectorSessionDiscoveryOptions } from './session-discovery.js';

type Source = ReturnType<typeof createOpenClawSessionSource>;
type History = ReturnType<typeof createOpenClawHistory>;
type BoundApplication = { readonly gatewayObserver: GatewayAsyncObserver };
export type AsyncOpenClawBindingOptions = {
  config: ServerConfig;
  deck: DeckStore;
  snapshot: EventSnapshotRead;
  /** The configured SDK directories, not an alternate session cache. */
  refreshDirectories(settings?: { maxAgeMs?: number }): void | Promise<void>;
  admissionAvailable(): boolean;
  queueChanged?(key: string): void | Promise<void>;
  artifactRegistry?: ArtifactRegistryAccess;
  diagnostics?: PerformanceDiagnostics;
};
export type AsyncOpenClawBindingPorts = {
  /** Original I/O boundaries only; never supply SQL, authority or an executor. */
  gateway?: (options: ConstructorParameters<typeof GatewayWsClient>[0]) => GatewayWsClient;
  source?: (config: ServerConfig) => Source;
  readDiskUsage?: ConnectorSessionDiscoveryOptions['readDiskUsage'];
};

/** Concrete original transport/read binding for the async composition root.
 * Does not own SQL, start native executors, discover or connect at construction.
 * Attach once before activation. Root drains application consumers first, then
 * closes this binding, then releases its sole database owner. */
export async function createAsyncOpenClawBinding(options: AsyncOpenClawBindingOptions, ports: AsyncOpenClawBindingPorts = {}) {
  const { config, deck } = options, diagnostics = options.diagnostics ?? performanceDiagnostics;
  const tasks = createTaskDrain(), historyReads = createHistoryReadScheduler();
  const epoch = randomUUID();
  let application: BoundApplication | undefined, closed = false, faulted = false;
  let closing: Promise<void> | undefined;
  let ownedArtifacts: AsyncArtifactRegistry | undefined;
  let gateway: GatewayWsClient | undefined, source: Source | undefined;
  let discovery: ReturnType<typeof createConnectorSessionDiscovery> | undefined, history: History | undefined;
  const report = (step: number, failed: boolean) => {
    const trace = guardedTrace(diagnostics, 'connector-runtime-assembly');
    trace.add('step', step); trace.finish(failed);
  };
  const current = () => {
    if (closed || faulted || !application) throw new ConnectorOwnerUnavailable();
    return application;
  };
  const fail = () => {
    faulted = true;
    try { application?.gatewayObserver.unavailable(); } catch { /* No fallback observer. */ }
    report(43, true);
  };
  const observer: GatewayAsyncObserver = {
    // Forward the original evidence to the application's owned persistence lane.
    // No direct Deck.ingestGatewayEvent, invented actor or journal fallback.
    event: (raw, connectionId) => {
      try { return current().gatewayObserver.event(raw, connectionId); }
      catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    },
    connectionChanged: connectionId => {
      // Only the intentional final transport disconnect is suppressed after
      // consumers drain; it must not turn normal shutdown into observer failure.
      if (closed && connectionId === undefined) return Promise.resolve();
      try { return current().gatewayObserver.connectionChanged(connectionId); }
      catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    },
    unavailable: fail,
  };
  const refreshSessions = (settings: { maxAgeMs?: number } = {}) => tasks.run(async () => {
    current();
    if (config.gatewayWsUrl) await gateway!.prepareReadConnection();
    current();
    await discovery!.refresh(settings);
    current();
  });
  const refreshMessages = (key: string, settings: HistoryRefreshOptions = {}) => tasks.run(async () => {
    current();
    if (config.gatewayWsUrl) await gateway!.prepareReadConnection();
    current();
    await historyReads.run(key, settings, () => history!(key, settings));
    current();
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Freeze all reads synchronously, retaining the accepted physical work.
    const drained = tasks.close();
    const scheduled = historyReads.close();
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([drained, scheduled]);
      // Do not close sources while accepted discovery/media/history I/O is held.
      for (const releases of [[() => discovery?.close(), () => history?.close()],
        [() => source?.close(), () => gateway?.closeAndDrain()], [() => ownedArtifacts?.close()]]) {
        results.push(...await Promise.allSettled(releases.map(release => Promise.resolve().then(release))));
      }
      const failed = results.some(result => result.status === 'rejected'); report(44, failed);
      if (failed) throw new ConnectorOwnerUnavailable();
    });
    return closing;
  };
  try {
    gateway = (ports.gateway ?? (settings => new GatewayWsClient(settings)))({
      url: config.gatewayWsUrl, ownerToken: config.ownerToken, password: config.password,
      asyncObserver: observer, diagnostics,
    });
    source = ports.source ? ports.source(config) : createOpenClawSessionSource(config, { diagnostics });
    const originalGateway = gateway, originalSource = source;
    const registry = options.artifactRegistry ?? (ownedArtifacts = await AsyncArtifactRegistry.open(config.artifactReceiver.indexFile));
    discovery = createConnectorSessionDiscovery({ gateway: originalGateway, projection: deck,
      local: config.localOpenClawCli, configured: !!(config.localOpenClawCli || config.gatewayWsUrl),
      readLocal: () => originalSource.readSessions(), refreshDirectories: settings => options.refreshDirectories(settings),
      ...(ports.readDiskUsage ? { readDiskUsage: ports.readDiskUsage } : {}), diagnostics });
    history = createOpenClawHistory({ gateway: originalGateway, local: config.localOpenClawCli,
      readLocal: key => originalSource.readTranscript(key), projection: deck,
      bridgeMedia: (row, role) => bridgeRawMediaDirectives(row, role, { ...config.mediaBridge, inboundDir: config.inboundMediaDir }),
      bridgeArtifacts: (row, role) => bridgeArtifactReferences(row, role, config.artifactReceiver, registry), diagnostics });
    const originalHistory = history, originalDiscovery = discovery;
    const runtimes: Omit<AsyncOpenClawApplicationOptions, 'owner' | 'deck' | 'diagnostics'> = {
      defaultAgentId: config.defaultAgentId,
      persist: (items, options) => persistUploadedMedia(items, { ...options, inboundDir: config.inboundMediaDir }),
      admissionAvailable: () => !closed && !faulted && options.admissionAvailable() === true,
      gatewayStatus: () => originalGateway.status().connected ? 'connected' : 'disconnected',
      dispatch: { gateway: originalGateway,
        // This lifetime epoch is not the connection ID. prepareWriteConnection
        // may establish the first connection; the dispatch separately binds its
        // exact connection before worker authorization and before native send.
        native: { available: () => !closed && !faulted, epoch: () => epoch },
        allowCliFallback: config.localOpenClawCli,
        message: text => withArtifactCapability(text,
          config.artifactReceiver.enabled && config.artifactReceiver.injectCapability, config.artifactReceiver.maxBytes),
      },
      recovery: { connectionId: () => originalGateway.connectionId(),
        query: async (runId, connectionId) => (await originalGateway.requestBound('agent.wait', { runId, timeoutMs: 0 }, connectionId)).payload },
      refreshSessions: () => refreshSessions({ maxAgeMs: 2000 }),
      refreshMessages: (key, settings) => refreshMessages(key, { maxAgeMs: 0, ...settings }),
      nativeSession: key => deck.getSessionExecution(key),
      invalidateDiscovery: () => originalDiscovery.invalidate(),
      history: { snapshot: options.snapshot, refresh: refreshMessages,
        historyReady: key => !closed && !faulted && originalHistory.ready(key),
        invalidate: () => originalHistory.invalidate(), close: () => originalHistory.close() },
      ...(options.queueChanged ? { queueChanged: key => options.queueChanged!(key) } : {}),
      mirror: { localOpenClawCli: config.localOpenClawCli },
    };
    return {
      runtimes, gateway: originalGateway, refreshSessions, refreshMessages, close,
      attach(value: BoundApplication) {
        if (application || closed || faulted || !value?.gatewayObserver
          || ['event', 'connectionChanged', 'unavailable'].some(key =>
            typeof value.gatewayObserver[key as keyof GatewayAsyncObserver] !== 'function')) throw new ConnectorOwnerUnavailable();
        application = value; report(42, false);
      },
      get current() { return !closed && !faulted && !!application && originalDiscovery.current; },
    };
  } catch {
    // Construction is inert, but ownership cannot escape a partial failure.
    faulted = true; report(41, true); await close().catch(() => {});
    throw new ConnectorOwnerUnavailable();
  }
}
