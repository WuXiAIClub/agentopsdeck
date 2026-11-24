import { Hono } from 'hono';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWebBundle } from './web-bundle.js';
import type { ServerConfig } from './config.js';
import { createAsyncLocalHubLayer } from './application-hub-async.js';
import { createAsyncConnectorSurface, type AsyncConnectorSurfaceOptions } from './connector/async-connector-surface.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { createIndependentDrain } from './lifecycle/independent-drain.js';
import { createShutdownCleanup } from './lifecycle/shutdown-cleanup.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { performanceDiagnostics } from './diagnostics/performance.js';
import { guardedTrace } from './diagnostics/guarded-trace.js';
import { AuthPersistenceError } from './auth/private-store.js';
import type { ApplicationCommandIntent, ApplicationCommandScope } from './auth/application-command-scope.js';
import { createApplicationMessageIngress } from './application-message-ingress.js';
import { registerApplicationMessagesHttp } from './application-message-http.js';
import { createApplicationStopIngress } from './application-stop-ingress.js';
import { createApplicationStatusIngress } from './application-status-ingress.js';
import { createApplicationCompactIngress } from './application-compact-ingress.js';
import { registerApplicationQueueHttp } from './application-queue-http.js';
import { registerApplicationSdkLocalHttp } from './application-sdk-local-http.js';
import { registerApplicationNativeCreationHttp } from './application-native-creation-http.js';
import { registerApplicationCodexSettingsHttp } from './application-codex-settings-http.js';
import { registerApplicationSessionTitleHttp } from './application-session-title-http.js';
import { registerApplicationDeletionHttp } from './application-deletion-http.js';
import { registerApplicationInteractionsHttp } from './application-interactions-http.js';
import { registerApplicationFilesHttp } from './application-files-http.js';
import { registerApplicationUsageHttp } from './application-usage-http.js';
import { registerApplicationMetadataHttp } from './application-metadata-http.js';
import { registerApplicationSystemReadsHttp } from './application-system-reads-http.js';
import { registerApplicationFileBrowserHttp } from './application-file-browser-http.js';
import { registerApplicationMediaHttp } from './application-media-http.js';

type HubLayer = Awaited<ReturnType<typeof createAsyncLocalHubLayer>>;
type Surface = Awaited<ReturnType<typeof createAsyncConnectorSurface>>;
export type CombinedAsyncLayerOptions = Omit<AsyncConnectorSurfaceOptions,
  'config' | 'legacyReads' | 'committedPreferences' | 'projectionConsumersDrain'>;

/** Borrowed-owner all-role composition, selected by the owned process factory.
 * Original application evidence crosses the private transaction gate, never
 * a manufactured Connector identity. The startup SQL owner must outlive this
 * layer's acknowledged close. */
export async function createAsyncCombinedLayer(config: ServerConfig, options: CombinedAsyncLayerOptions) {
  startupApplicationCleanup.assertAvailable();
  if (config.serverRole !== 'all') throw new ConnectorOwnerUnavailable();
  const diagnostics = options.diagnostics ?? performanceDiagnostics;
  // Capture the actual constructor-bound peer before assembly or caller I/O.
  // An unlinked borrowed owner retains its observation-only contract.
  const applicationTransactions = options.owner.applicationTransactionAuthEndpoint;
  let startupStage = 0;
  const report = (step: number, failed = false) => {
    const trace = guardedTrace(diagnostics, 'combined-application-layer');
    trace.add('step', step); trace.add('startupStage', startupStage); trace.finish(failed);
  };
  let surface: Surface | undefined, hub: HubLayer | undefined;
  let messages: ReturnType<typeof registerApplicationMessagesHttp> | undefined;
  let queue: ReturnType<typeof registerApplicationQueueHttp> | undefined;
  let sdkLocal: ReturnType<typeof registerApplicationSdkLocalHttp> | undefined;
  let nativeCreation: ReturnType<typeof registerApplicationNativeCreationHttp> | undefined;
  let codexSettings: ReturnType<typeof registerApplicationCodexSettingsHttp> | undefined;
  let sessionTitles: ReturnType<typeof registerApplicationSessionTitleHttp> | undefined;
  let deletions: ReturnType<typeof registerApplicationDeletionHttp> | undefined;
  let interactions: ReturnType<typeof registerApplicationInteractionsHttp> | undefined;
  let files: ReturnType<typeof registerApplicationFilesHttp> | undefined;
  let usage: ReturnType<typeof registerApplicationUsageHttp> | undefined;
  let metadata: ReturnType<typeof registerApplicationMetadataHttp> | undefined;
  let systemReads: ReturnType<typeof registerApplicationSystemReadsHttp> | undefined;
  let fileBrowser: ReturnType<typeof registerApplicationFileBrowserHttp> | undefined;
  let media: ReturnType<typeof registerApplicationMediaHttp> | undefined;
  let frozen = false, started = false, starting: Promise<void> | undefined, physicalStart: Promise<void> | undefined;
  let assemblingHub: Promise<HubLayer> | undefined, hubClosing: Promise<void> | undefined;
  const ready = () => !frozen && started && surface?.ready === true && hub?.ready === true;
  const closeHub = (): Promise<void> => hubClosing ??= Promise.resolve().then(async () => {
    // Assembly owns its partial failure cleanup. Retain the actual successful
    // result even if close raced the worker open; never close a replacement.
    if (assemblingHub) { try { hub = await assemblingHub; } catch { return; } }
    await hub?.close();
  });
  const close = createShutdownCleanup(createIndependentDrain([
    () => { frozen = true; started = false; report(6); }, closeHub, () => surface?.close(),
    () => physicalStart?.then(() => {}, () => {}),
  ], 'hub-route-drain', diagnostics), [], diagnostics);
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!ready()) return c.json({ error: 'server_not_ready' }, 503);
    return next();
  });
  // Keep the router fixed even if a health/readiness probe arrives before
  // start. Hono may compile its matcher on that first rejected request.
  app.all('*', c => hub!.app.fetch(c.req.raw));
  try {
    surface = await createAsyncConnectorSurface({ ...options, config, projectionConsumersDrain: closeHub,
      // The original Hub worker installs the actual snapshot after prepare,
      // before either native activation or public ready. Deck never owns files.
      committedPreferences: { hidden: [], archived: [], pinned: [] },
      legacyReads: { observeActor(request) {
        if (!ready() || !hub) throw new AuthPersistenceError();
        return hub.observeActor(request);
      } },
    });
    const originalSurface = surface;
    const commands = Object.freeze({
      run<Result>(request: Request, intent: ApplicationCommandIntent, task: (scope: ApplicationCommandScope) => Promise<Result>) {
        if (!ready() || !hub) return Promise.reject(new ConnectorOwnerUnavailable());
        return hub.commands.run(request, intent, task);
      },
      get pending() { return hub?.commands.pending ?? 0; },
    });
    const messageIngress = createApplicationMessageIngress(commands, {
      codex: originalSurface.runtimes.http.codexMessages?.messages,
      openclaw: originalSurface.runtimes.http.openClawMessages?.messages,
      sdk: originalSurface.runtimes.http.sdkMessages?.messages,
      hermes: originalSurface.runtimes.http.hermesMessages?.messages,
    }, { messageTransactions: applicationTransactions !== undefined });
    const stopIngress = createApplicationStopIngress(commands, {
      codex: originalSurface.runtimes.http.codexMessages?.stop,
      openclaw: originalSurface.runtimes.http.openClawMessages?.stop,
      sdk: originalSurface.runtimes.http.sdkMessages,
      hermes: originalSurface.runtimes.http.hermesMessages?.stop,
    }, { transactions: applicationTransactions !== undefined });
    const statusIngress = createApplicationStatusIngress(commands, {
      openclaw: originalSurface.runtimes.http.openClawMessages?.status,
      sdk: originalSurface.runtimes.http.sdkMessages?.status,
      hermes: originalSurface.runtimes.http.hermesMessages?.localControl,
    }, { transactions: applicationTransactions !== undefined });
    const compactIngress = createApplicationCompactIngress(commands, {
      openclaw: originalSurface.runtimes.http.openClawMessages?.compact,
      sdk: originalSurface.runtimes.http.sdkCompact,
    }, { transactions: applicationTransactions !== undefined });
    const assertLive = () => { if (frozen) throw new ConnectorOwnerUnavailable(); };
    const start = (): Promise<void> => {
      if (frozen) return Promise.reject(new ConnectorOwnerUnavailable());
      if (starting) return starting;
      physicalStart = Promise.resolve().then(async () => {
        startupStage = 1;
        assertLive(); await originalSurface.prepare(); assertLive(); report(1);
        startupStage = 2;
        assemblingHub = createAsyncLocalHubLayer(config, originalSurface, { deferActivation: true,
          ...(applicationTransactions ? { applicationTransactions } : {}),
          signedStream: request => originalSurface.media?.library.isSignedStreamRequest(request) === true,
          legacyConsumersDrain: async () => { await Promise.all([messages?.close(), queue?.close(), sdkLocal?.close(), nativeCreation?.close(), codexSettings?.close(), sessionTitles?.close(), deletions?.close(), interactions?.close(), files?.close(), usage?.close(), metadata?.close(), systemReads?.close(), fileBrowser?.close(), media?.close(), originalSurface.closeLegacyReads()]); },
          preferences: {
            install(snapshot) {
              assertLive();
              if (!originalSurface.prepared || originalSurface.ready) throw new ConnectorOwnerUnavailable();
              originalSurface.deck.installLocalPreferenceSnapshot(snapshot);
            },
            assertAvailable() { if (!ready()) throw new ConnectorOwnerUnavailable(); },
            project: result => originalSurface.deck.projectLocalPreference(result),
          } });
        hub = await assemblingHub; assertLive(); report(2);
        startupStage = 3;
        await originalSurface.start(); assertLive(); report(3);
        startupStage = 4;
        await hub.activate(); assertLive(); report(4);
        startupStage = 5;
        if (!originalSurface.ready || !hub.ready) throw new ConnectorOwnerUnavailable();
        if (applicationTransactions) messages = registerApplicationMessagesHttp(hub.app, {
          commands, ingress: messageIngress, stopIngress, statusIngress, compactIngress, credentials: originalSurface.credentials,
          observeActor: hub.observeActor, available: ready, diagnostics,
          ports: {
            codex: originalSurface.runtimes.http.codexMessages?.messages,
            openclaw: originalSurface.runtimes.http.openClawMessages?.messages,
            sdk: originalSurface.runtimes.http.sdkMessages?.messages,
            hermes: originalSurface.runtimes.http.hermesMessages?.messages,
          },
        });
        if (applicationTransactions) queue = registerApplicationQueueHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          sdk: originalSurface.runtimes.http.sdkQueue, hermes: originalSurface.runtimes.http.hermesQueue,
          native: originalSurface.runtimes.http.nativeQueue,
          transactions: true, diagnostics,
        });
        if (applicationTransactions) sdkLocal = registerApplicationSdkLocalHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          sdk: originalSurface.runtimes.http.sdkLocal, transactions: true, diagnostics,
        });
        if (applicationTransactions) nativeCreation = registerApplicationNativeCreationHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexCreation, hermes: originalSurface.runtimes.http.hermesCreation,
          transactions: true, diagnostics,
        });
        if (applicationTransactions) codexSettings = registerApplicationCodexSettingsHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexSettings, transactions: true, diagnostics,
        });
        if (applicationTransactions) sessionTitles = registerApplicationSessionTitleHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          titles: originalSurface.runtimes.http.sessionTitles, transactions: true, diagnostics,
        });
        if (applicationTransactions) deletions = registerApplicationDeletionHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexDeletion, hermes: originalSurface.runtimes.http.hermesDeletion,
          sdk: originalSurface.runtimes.http.sdkDeletion, transactions: true, diagnostics,
        });
        if (applicationTransactions) interactions = registerApplicationInteractionsHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexInteractions, sdk: originalSurface.runtimes.http.sdkInteractions,
          transactions: true, diagnostics,
        });
        if (applicationTransactions) files = registerApplicationFilesHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexFiles, sdk: originalSurface.runtimes.http.sdkFiles,
          transactions: true, diagnostics,
        });
        if (applicationTransactions) usage = registerApplicationUsageHttp(hub.app, {
          commands, credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexPublicUsage, sdk: originalSurface.runtimes.http.sdkUsage,
          transactions: true, diagnostics,
        });
        metadata = registerApplicationMetadataHttp(hub.app, {
          credentials: originalSurface.credentials, observeActor: hub.observeActor, available: ready,
          codex: originalSurface.runtimes.http.codexCatalog, sdk: originalSurface.runtimes.http.sdkMetadata, diagnostics,
        });
        if (originalSurface.system) systemReads = registerApplicationSystemReadsHttp(hub.app, {
          ...originalSurface.system, config, store: originalSurface.deck, commands,
          observeActor: hub.observeActor, available: ready, diagnostics,
          normalizeError: error => error instanceof Error ? error.message : String(error),
        });
        if (originalSurface.media) media = registerApplicationMediaHttp(hub.app, {
          ...originalSurface.media, commands, observeActor: hub.observeActor, available: ready, diagnostics,
          ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
        });
        fileBrowser = registerApplicationFileBrowserHttp(hub.app, {
          roots: config.nativeFileRoots,
          commands, observeActor: hub.observeActor, available: ready, diagnostics,
        });
        // The original Hub shell (origin/auth/drain) still wraps Connector's
        // own machine authority; neither layer manufactures user authority.
        for (const path of ['/api/connector/v1/*', '/api/sessions/*', '/api/agents', '/api/events/stream', '/api/attention']) {
          hub.app.all(path, c => originalSurface.app.fetch(c.req.raw));
        }
        registerWebBundle(hub.app, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'), { publicBaseUrl: config.publicBaseUrl });
        started = true; report(5);
      });
      return starting = physicalStart.catch(async () => {
        report(7, true);
        try { await close(); } catch { /* Original resources remain fenced. */ }
        throw new ConnectorOwnerUnavailable();
      });
    };
    return { app, start, close, commands, messageIngress, stopIngress, statusIngress, compactIngress, connector: originalSurface,
      get websiteGateway() { return hub?.websiteGateway; }, get ready() { return ready(); } };
  } catch {
    report(8, true);
    try { await close(); } catch { startupApplicationCleanup.abandon([close], []); }
    throw new ConnectorOwnerUnavailable();
  }
}
