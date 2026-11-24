import { Hono } from 'hono';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWebBundle } from './web-bundle.js';
import type { ServerConfig } from './config.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';
import { createAsyncStandaloneAuthLayer } from './application-standalone-auth-async.js';
import { createAsyncConnectorSurface, type AsyncConnectorSurfaceOptions } from './connector/async-connector-surface.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { createIndependentDrain } from './lifecycle/independent-drain.js';
import { createShutdownCleanup } from './lifecycle/shutdown-cleanup.js';
import { performanceDiagnostics } from './diagnostics/performance.js';
import { guardedTrace } from './diagnostics/guarded-trace.js';
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

type AuthLayer = Awaited<ReturnType<typeof createAsyncStandaloneAuthLayer>>;
type Surface = Awaited<ReturnType<typeof createAsyncConnectorSurface>>;
export type StandaloneConnectorLayerOptions = Omit<AsyncConnectorSurfaceOptions,
  'config' | 'legacyReads' | 'committedPreferences' | 'projectionConsumersDrain'> & {
  signedStream?: (request: Request) => boolean;
};

/** Standalone Auth/application + Connector v1 composition, borrowed by the
 * owned process factory. Original Cookie/Key evidence goes to transaction Auth,
 * never a manufactured Connector identity. Startup owns the borrowed Connector
 * DB and must drain us before closing it. */
export async function createAsyncStandaloneConnectorLayer(config: ServerConfig, options: StandaloneConnectorLayerOptions) {
  startupApplicationCleanup.assertAvailable();
  if (shouldRegisterHubRoutes(config) || !shouldRegisterConnectorRoutes(config) || config.websiteGateway) {
    throw new ConnectorOwnerUnavailable();
  }
  const diagnostics = options.diagnostics ?? performanceDiagnostics;
  const applicationTransactions = options.owner.applicationTransactionAuthEndpoint;
  const report = (step: number, failed = false) => {
    const trace = guardedTrace(diagnostics, 'standalone-connector-layer'); trace.add('step', step); trace.finish(failed);
  };
  let auth: AuthLayer | undefined, surface: Surface | undefined;
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
  let frozen = false, started = false, starting: Promise<void> | undefined, authClosing: Promise<void> | undefined;
  const ready = () => !frozen && started && surface?.ready === true;
  const freeze = () => { frozen = true; report(4); };
  const closeAuth = () => authClosing ??= auth ? auth.close() : Promise.resolve();
  const drains = [freeze, closeAuth, () => surface?.close()];
  const close = createShutdownCleanup(createIndependentDrain(drains, 'auth-route-drain', diagnostics), [], diagnostics);
  try {
    auth = await createAsyncStandaloneAuthLayer(config, {
      diagnostics,
      ...(applicationTransactions ? { applicationTransactions } : {}),
      legacyConsumersDrain: async () => { await Promise.all([messages?.close(), queue?.close(), sdkLocal?.close(), nativeCreation?.close(), codexSettings?.close(), sessionTitles?.close(), deletions?.close(), interactions?.close(), files?.close(), usage?.close(), metadata?.close(), systemReads?.close(), fileBrowser?.close(), media?.close(), surface?.closeLegacyReads()]); },
      signedStream: request => surface?.media?.library.isSignedStreamRequest(request) === true || options.signedStream?.(request) === true,
      preferences: {
        assertAvailable() { if (!ready()) throw new ConnectorOwnerUnavailable(); },
        project(result) {
          // ACK is an existing durable fact even when close has frozen new
          // admissions. The surface retains its projection until Auth drains.
          if (!surface) throw new ConnectorOwnerUnavailable();
          surface.deck.projectLocalPreference(result);
        },
      },
    });
    if (!auth.preferenceSnapshot) throw new ConnectorOwnerUnavailable();
    report(1);
    surface = await createAsyncConnectorSurface({ ...options, config,
      legacyReads: { observeActor: auth.observeActor }, committedPreferences: auth.preferenceSnapshot,
      projectionConsumersDrain: closeAuth });
    report(2);
    const originalSurface = surface, originalAuth = auth;
    // Server-only original-command lifetime port. Not an HTTP capability,
    // Connector bearer or permission to bypass a native/transaction guard.
    const commands = Object.freeze({
      run<Result>(request: Request, intent: ApplicationCommandIntent, task: (scope: ApplicationCommandScope) => Promise<Result>) {
        if (!ready()) return Promise.reject(new ConnectorOwnerUnavailable());
        return originalAuth.commands.run(request, intent, task);
      },
      get pending() { return originalAuth.commands.pending; },
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
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!ready()) return c.json({ error: 'server_not_ready' }, 503);
      return next();
    });
    // Register the original shell/auth first, so request drain, CORS, origin
    // and application authority also protect the legacy routes below it.
    app.route('/', originalAuth.app);
    if (applicationTransactions) messages = registerApplicationMessagesHttp(app, {
      commands, ingress: messageIngress, stopIngress, statusIngress, compactIngress, credentials: originalSurface.credentials,
      observeActor: originalAuth.observeActor, available: ready, diagnostics,
      ports: {
        codex: originalSurface.runtimes.http.codexMessages?.messages,
        openclaw: originalSurface.runtimes.http.openClawMessages?.messages,
        sdk: originalSurface.runtimes.http.sdkMessages?.messages,
        hermes: originalSurface.runtimes.http.hermesMessages?.messages,
      },
    });
    if (applicationTransactions) queue = registerApplicationQueueHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      sdk: originalSurface.runtimes.http.sdkQueue, hermes: originalSurface.runtimes.http.hermesQueue,
      native: originalSurface.runtimes.http.nativeQueue,
      transactions: true, diagnostics,
    });
    if (applicationTransactions) sdkLocal = registerApplicationSdkLocalHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      sdk: originalSurface.runtimes.http.sdkLocal, transactions: true, diagnostics,
    });
    if (applicationTransactions) nativeCreation = registerApplicationNativeCreationHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexCreation, hermes: originalSurface.runtimes.http.hermesCreation,
      transactions: true, diagnostics,
    });
    if (applicationTransactions) codexSettings = registerApplicationCodexSettingsHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexSettings, transactions: true, diagnostics,
    });
    if (applicationTransactions) sessionTitles = registerApplicationSessionTitleHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      titles: originalSurface.runtimes.http.sessionTitles, transactions: true, diagnostics,
    });
    if (applicationTransactions) deletions = registerApplicationDeletionHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexDeletion, hermes: originalSurface.runtimes.http.hermesDeletion,
      sdk: originalSurface.runtimes.http.sdkDeletion, transactions: true, diagnostics,
    });
    if (applicationTransactions) interactions = registerApplicationInteractionsHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexInteractions, sdk: originalSurface.runtimes.http.sdkInteractions,
      transactions: true, diagnostics,
    });
    if (applicationTransactions) files = registerApplicationFilesHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexFiles, sdk: originalSurface.runtimes.http.sdkFiles,
      transactions: true, diagnostics,
    });
    if (applicationTransactions) usage = registerApplicationUsageHttp(app, {
      commands, credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexPublicUsage, sdk: originalSurface.runtimes.http.sdkUsage,
      transactions: true, diagnostics,
    });
    metadata = registerApplicationMetadataHttp(app, {
      credentials: originalSurface.credentials, observeActor: originalAuth.observeActor, available: ready,
      codex: originalSurface.runtimes.http.codexCatalog, sdk: originalSurface.runtimes.http.sdkMetadata, diagnostics,
    });
    if (originalSurface.system) systemReads = registerApplicationSystemReadsHttp(app, {
      ...originalSurface.system, config, store: originalSurface.deck, commands,
      observeActor: originalAuth.observeActor, available: ready, diagnostics,
      normalizeError: () => 'system_operation_failed',
    });
    if (originalSurface.media) media = registerApplicationMediaHttp(app, {
      ...originalSurface.media, commands, observeActor: originalAuth.observeActor, available: ready, diagnostics,
      ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    });
    fileBrowser = registerApplicationFileBrowserHttp(app, {
      roots: config.nativeFileRoots,
      commands, observeActor: originalAuth.observeActor, available: ready, diagnostics,
    });
    app.route('/', originalSurface.app);
    registerWebBundle(app, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'), { publicBaseUrl: config.publicBaseUrl });
    const start = (): Promise<void> => {
      if (frozen) return Promise.reject(new ConnectorOwnerUnavailable());
      if (starting) return starting;
      return starting = originalSurface.start().then(() => {
        if (frozen || !originalSurface.ready) throw new ConnectorOwnerUnavailable();
        started = true; report(3);
      }).catch(async () => {
        report(5, true);
        try { await close(); } catch { /* Original drain remains retained. */ }
        throw new ConnectorOwnerUnavailable();
      });
    };
    return { app, start, close, commands, messageIngress, stopIngress, statusIngress, compactIngress, deck: originalSurface.deck, connector: originalSurface,
      get ready() { return ready(); } };
  } catch {
    report(6, true);
    // The caller cannot retain a failed constructor. Register the exact
    // existing lanes; never create replacement workers or replay a business
    // command to make startup appear successful.
    startupApplicationCleanup.abandon(drains, []);
    try { await startupApplicationCleanup.waitForCurrentCleanup(); } catch { /* Still fenced. */ }
    throw new ConnectorOwnerUnavailable();
  }
}
