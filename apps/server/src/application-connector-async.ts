import type { ServerConfig } from './config.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';
import { createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import type { ConnectorOwnerConfig } from './connector/connector-owner-domain.js';
import { createAsyncCombinedLayer, type CombinedAsyncLayerOptions } from './application-combined-async.js';
import { createAsyncStandaloneConnectorLayer } from './application-standalone-connector-async.js';
import { createShutdownCleanup } from './lifecycle/shutdown-cleanup.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';

type Layer = Awaited<ReturnType<typeof createAsyncCombinedLayer>> | Awaited<ReturnType<typeof createAsyncStandaloneConnectorLayer>>;
type BootstrapOptions = Pick<CombinedAsyncLayerOptions, 'bind' | 'sampler' | 'diagnostics' | 'waitMs'>;

/** Trusted process bootstrap, not a public command or a fallback. Preserve the
 * original paths/catalogs/policies and transfer the whole SQL owner exactly once. */
export function applicationConnectorOwnerConfig(config: ServerConfig): ConnectorOwnerConfig {
  return {
    file: config.connector.usersDatabaseFile, tokenFile: config.connector.tokenFile,
    ...(config.connector.bootstrapToken !== undefined ? { bootstrapToken: config.connector.bootstrapToken } : {}),
    codexQueueFile: config.codex.queueFile, openClawQueueFile: config.queueFile, mirrorOutboxFile: config.mirrorOutboxFile,
    codexBoardTools: !!(config.codex.boardToolsDirectory || config.boardFiles),
    ...(config.boardFiles ? { boardFiles: config.boardFiles } : {}),
    sdkModels: {
      ...(config.claude ? { 'claude-code': { model: config.claude.model,
        ...(config.claude.modelChoices ? { modelChoices: config.claude.modelChoices } : {}) } } : {}),
      ...(config.copilot ? { ghcp: { model: config.copilot.model,
        ...(config.copilot.modelChoices ? { modelChoices: config.copilot.modelChoices } : {}) } } : {}),
    },
    fileToolPolicies: {
      ...(config.claude?.toolPolicy !== undefined ? { claude: { toolPolicy: config.claude.toolPolicy } } : {}),
      ...(config.copilot?.toolPolicy !== undefined ? { copilot: { toolPolicy: config.copilot.toolPolicy } } : {}),
    },
  };
}

/** Owned all/connector production root. No listener is published until recovery,
 * real native preparation and the original Auth/Hub transaction link are ready. */
export async function createAsyncConnectorApplication(provided: ServerConfig, options: BootstrapOptions = {}) {
  startupApplicationCleanup.assertAvailable();
  const config = structuredClone(provided);
  if (!shouldRegisterConnectorRoutes(config)) throw Error('Async Connector application requires a Connector role');
  const transaction = createApplicationTransactionLink();
  let owner: AsyncConnectorOwner | undefined, layer: Layer | undefined;
  const close = createShutdownCleanup(async () => { await layer?.close(); }, [
    () => owner?.closeForShutdown(), () => transaction.closeUnused(),
  ], options.diagnostics, { stopAfterFailure: true });
  try {
    owner = new AsyncConnectorOwner(applicationConnectorOwnerConfig(config), options.diagnostics,
      undefined, 30_000, transaction.connector);
    await owner.open();
    const deps = { ...options, owner, connector: config.connector };
    layer = shouldRegisterHubRoutes(config)
      ? await createAsyncCombinedLayer(config, deps)
      : await createAsyncStandaloneConnectorLayer(config, deps);
    await layer.start();
    if (!layer.ready) throw Error('Async Connector application is not ready');
    return { app: layer.app, websiteGateway: 'websiteGateway' in layer ? layer.websiteGateway : undefined, close };
  } catch (error) {
    // A failed sub-constructor may already retain original consumers. Finish
    // observing those owners BEFORE registering ours: waitForCurrentCleanup
    // checks the current pending set after yielding, not just its first snapshot.
    // Merely capturing its promise would let it include our own outer drain.
    let innerFailed = false, innerFailure: unknown;
    try { await startupApplicationCleanup.waitForCurrentCleanup(); }
    catch (failure) { innerFailed = true; innerFailure = failure; }
    startupApplicationCleanup.abandon([
      async () => {
        await layer?.close();
        // Unknown consumers must keep their original Connector owner fenced.
        if (innerFailed) throw innerFailure;
      },
    ], [() => transaction.closeUnused(), () => owner?.closeForShutdown()]);
    try { await startupApplicationCleanup.waitForCurrentCleanup(); } catch { /* Exact owners remain fenced. */ }
    throw error;
  }
}
