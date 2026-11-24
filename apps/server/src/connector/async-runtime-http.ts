import type { Hono } from 'hono';
import { registerConnectorProtocol } from './protocol-http.js';
import { registerSessionReadsHttp, type SessionReadsHttp } from './session-reads-http.js';
import { registerConnectorControlHttp, type ConnectorControlHttp } from './control-http.js';
import { registerOpenClawMessagesHttp } from './openclaw-messages-http.js';
import { registerOpenClawReadsHttp } from './openclaw-reads-http.js';
import { registerCodexMessagesHttp } from './codex-messages-http.js';
import { registerCodexReadsHttp } from './codex-reads-http.js';
import { registerCodexCreationHttp } from './codex-creation-http.js';
import { registerCodexInteractionsHttp } from './codex-interactions-http.js';
import { registerCodexCatalogHttp } from './codex-catalog-http.js';
import { registerCodexSettingsHttp } from './codex-settings-http.js';
import { registerSessionTitleHttp } from './session-title-http.js';
import { registerCodexDeletionHttp } from './codex-deletion-http.js';
import { registerCodexPublicUsageHttp } from './codex-public-usage-http.js';
import { registerCodexFilesHttp } from './codex-files-http.js';
import { registerHermesMessagesHttp } from './hermes-messages-http.js';
import { registerHermesDeletionHttp } from './hermes-deletion-http.js';
import { registerHermesCreationHttp } from './hermes-creation-http.js';
import { registerNativeQueueHttp } from './native-queue-http.js';
import { registerHermesQueueHttp } from './hermes-queue-http.js';
import { registerHermesReadsHttp } from './hermes-reads-http.js';
import { registerSdkMessagesHttp } from './sdk-messages-http.js';
import { registerSdkLocalHttp } from './sdk-local-http.js';
import { registerSdkQueueHttp } from './sdk-queue-http.js';
import { registerSdkDeletionHttp } from './sdk-deletion-http.js';
import { registerSdkCompactHttp } from './sdk-compact-http.js';
import { registerSdkInteractionsHttp } from './sdk-interactions-http.js';
import { registerSdkHistoryHttp } from './sdk-history-http.js';
import { registerSdkUsageHttp } from './sdk-usage-http.js';
import { registerSdkFilesHttp } from './sdk-files-http.js';
import { registerSdkMetadataHttp } from './sdk-metadata-http.js';
import { registerAsyncConnectorAutomation } from './async-automation-http.js';
import { registerSessionMediaRoutes } from './session-media-http.js';
import { registerConnectorPublicReads, type ConnectorPublicReads } from './public-reads-http.js';
export type AsyncRuntimeHttp = {
  sessionMedia?: Parameters<typeof registerSessionMediaRoutes>[1];
  openClawMessages?: Parameters<typeof registerOpenClawMessagesHttp>[2];
  openClawReads?: Parameters<typeof registerOpenClawReadsHttp>[2];
  codexMessages?: Parameters<typeof registerCodexMessagesHttp>[2];
  codexReads?: Parameters<typeof registerCodexReadsHttp>[2];
  codexCreation?: Parameters<typeof registerCodexCreationHttp>[2];
  codexInteractions?: Parameters<typeof registerCodexInteractionsHttp>[2];
  codexCatalog?: Parameters<typeof registerCodexCatalogHttp>[2];
  codexSettings?: Parameters<typeof registerCodexSettingsHttp>[2];
  sessionTitles?: Parameters<typeof registerSessionTitleHttp>[2];
  codexDeletion?: Parameters<typeof registerCodexDeletionHttp>[2];
  codexPublicUsage?: Parameters<typeof registerCodexPublicUsageHttp>[2];
  codexFiles?: Parameters<typeof registerCodexFilesHttp>[2];
  hermesMessages?: Parameters<typeof registerHermesMessagesHttp>[2];
  hermesDeletion?: Parameters<typeof registerHermesDeletionHttp>[2];
  hermesCreation?: Parameters<typeof registerHermesCreationHttp>[2];
  nativeQueue?: Parameters<typeof registerNativeQueueHttp>[2];
  hermesQueue?: Parameters<typeof registerHermesQueueHttp>[2];
  hermesReads?: Parameters<typeof registerHermesReadsHttp>[2];
  sdkMessages?: Parameters<typeof registerSdkMessagesHttp>[2];
  sdkLocal?: Parameters<typeof registerSdkLocalHttp>[2];
  sdkQueue?: Parameters<typeof registerSdkQueueHttp>[2];
  sdkDeletion?: Parameters<typeof registerSdkDeletionHttp>[2];
  sdkCompact?: Parameters<typeof registerSdkCompactHttp>[2];
  sdkInteractions?: Parameters<typeof registerSdkInteractionsHttp>[2];
  sdkHistory?: Parameters<typeof registerSdkHistoryHttp>[2];
  sdkUsage?: Parameters<typeof registerSdkUsageHttp>[2];
  sdkFiles?: Parameters<typeof registerSdkFilesHttp>[2];
  sdkMetadata?: Parameters<typeof registerSdkMetadataHttp>[2];
  automationConfiguration?: Parameters<typeof registerAsyncConnectorAutomation>[2]['configuration'];
};

/** The ORIGINAL owned-route order, shared by both roots. No synchronous SQL
 * dependencies. Protocol/node middleware precedes every runtime handler. The
 * owning root must close its runtime services after freezing HTTP admission. */
export function registerAsyncRuntimeHttp(app: Hono, nodeId: string, ports: AsyncRuntimeHttp & {
  sessionReads?: SessionReadsHttp; control?: ConnectorControlHttp;
  publicReads?: ConnectorPublicReads;
  /** Root readiness is independent of protocol/installation identity. */
  available?: () => boolean;
  /** Install control routes after protocol identity, before ordinary readiness.
   * Recovery controls must remain reachable while execution is paused. */
  beforeRoutes?: () => void;
}) {
  const base = '/api/connector/v1', session = `${base}/sessions/:sessionKey`;
  registerConnectorProtocol(app, base, nodeId);
  ports.beforeRoutes?.();
  let closed = false;
  app.use(`${base}/*`, async (c, next) => {
    if (closed || ports.available && !ports.available()) return c.json({ error: 'Connector unavailable' }, 503);
    await next();
  });
  if (ports.sessionReads) registerSessionReadsHttp(app, `${base}/sessions`, ports.sessionReads);
  if (ports.openClawMessages) registerOpenClawMessagesHttp(app, session, ports.openClawMessages);
  if (ports.codexMessages) registerCodexMessagesHttp(app, session, ports.codexMessages);
  if (ports.codexReads) registerCodexReadsHttp(app, session, ports.codexReads);
  const control = ports.control ? registerConnectorControlHttp(app, nodeId, ports.control) : undefined;
  if (ports.openClawReads) registerOpenClawReadsHttp(app, session, ports.openClawReads);
  if (ports.hermesMessages) registerHermesMessagesHttp(app, session, ports.hermesMessages);
  if (ports.hermesDeletion) registerHermesDeletionHttp(app, session, ports.hermesDeletion);
  if (ports.hermesCreation) registerHermesCreationHttp(app, base, ports.hermesCreation);
  if (ports.codexCreation) registerCodexCreationHttp(app, base, ports.codexCreation);
  if (ports.nativeQueue) registerNativeQueueHttp(app, session, ports.nativeQueue);
  if (ports.hermesQueue) registerHermesQueueHttp(app, session, ports.hermesQueue);
  if (ports.hermesReads) registerHermesReadsHttp(app, session, ports.hermesReads);
  if (ports.sdkMessages) registerSdkMessagesHttp(app, session, ports.sdkMessages);
  if (ports.sdkLocal) registerSdkLocalHttp(app, base, ports.sdkLocal);
  if (ports.sdkQueue) registerSdkQueueHttp(app, session, ports.sdkQueue);
  if (ports.sdkDeletion) registerSdkDeletionHttp(app, session, ports.sdkDeletion);
  if (ports.sdkCompact) registerSdkCompactHttp(app, session, ports.sdkCompact);
  if (ports.sdkInteractions) registerSdkInteractionsHttp(app, session, ports.sdkInteractions);
  if (ports.sdkHistory) registerSdkHistoryHttp(app, session, ports.sdkHistory);
  if (ports.sdkUsage) registerSdkUsageHttp(app, session, ports.sdkUsage);
  if (ports.codexPublicUsage) registerCodexPublicUsageHttp(app, session, ports.codexPublicUsage);
  if (ports.codexFiles) registerCodexFilesHttp(app, session, ports.codexFiles);
  if (ports.sdkFiles) registerSdkFilesHttp(app, session, ports.sdkFiles);
  if (ports.sdkMetadata) registerSdkMetadataHttp(app, base, ports.sdkMetadata);
  if (ports.codexInteractions) registerCodexInteractionsHttp(app, session, ports.codexInteractions);
  if (ports.codexCatalog) registerCodexCatalogHttp(app, base, ports.codexCatalog);
  if (ports.codexSettings) registerCodexSettingsHttp(app, session, ports.codexSettings);
  if (ports.sessionTitles) registerSessionTitleHttp(app, session, ports.sessionTitles);
  if (ports.codexDeletion) registerCodexDeletionHttp(app, session, ports.codexDeletion);
  if (ports.automationConfiguration) registerAsyncConnectorAutomation(app, `${base}/automation`, {
    configuration: ports.automationConfiguration,
  });
  if (ports.sessionMedia) registerSessionMediaRoutes(app, ports.sessionMedia);
  const publicReads = ports.publicReads ? registerConnectorPublicReads(app, base, ports.publicReads) : undefined;
  let closing: Promise<void> | undefined;
  return { close() {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    closed = true;
    // Call every fence synchronously; retain all physical drains even when a
    // participant fails. Root releases credentials only after this settles.
    void Promise.allSettled([control, publicReads].filter(value => value !== undefined)
      .map(value => { try { return value.close(); } catch (error) { return Promise.reject(error); } }))
      .then(results => { if (results.some(value => value.status === 'rejected')) throw new Error('Connector HTTP drain failed'); })
      .then(resolve, reject);
    return closing;
  } };
}
