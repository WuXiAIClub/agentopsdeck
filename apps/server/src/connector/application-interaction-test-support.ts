import type { Hono } from 'hono';
import { originalApplicationAuthFixture } from '../auth/application-transaction-test-fixture.js';
import { createApplicationTransactionLink } from '../auth/application-transaction-gate.js';
import { createApplicationCommandScopes } from '../auth/application-command-scope.js';
import { registerApplicationInteractionsHttp } from '../application-interactions-http.js';
import type { CodexInteractionsHttp } from './codex-interactions-http.js';
import type { SdkInteractionsHttp } from './sdk-interactions-http.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerApplicationFilesHttp } from '../application-files-http.js';
import type { CodexFilesHttp } from './codex-files-http.js';
import type { SdkFilesHttp } from './sdk-files-http.js';
import { registerApplicationUsageHttp } from '../application-usage-http.js';
import type { CodexPublicUsageHttp } from './codex-public-usage-http.js';
import type { SdkUsageHttp } from './sdk-usage-http.js';
import { registerApplicationMetadataHttp } from '../application-metadata-http.js';
import type { CodexCatalogHttp } from './codex-catalog-http.js';
import type { SdkMetadataHttp } from './sdk-metadata-http.js';

export type InteractionApplicationOptions = { role: 'hub' | 'standalone'; mode: 'sqlite' | 'json'; withKey?: boolean; timeoutMs?: number };
/** Tests use the original physical Auth peer, including request observations;
 * neither the scope nor the transaction path substitutes a boolean grant. */
export async function applicationInteractionTestSupport(root: string, options: InteractionApplicationOptions,
  diagnostics: PerformanceDiagnostics, token: string) {
  const session = 'a'.repeat(43), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, options.role, options.mode, options.withKey === false ? undefined : 'isolated-key', diagnostics, link.auth);
  await auth.open(); if (options.withKey !== false) await auth.issueSession(session);
  const commands = createApplicationCommandScopes({ authorize: request => Promise.resolve(auth.authorize(request)), assertAvailable() {}, diagnostics });
  let http: ReturnType<typeof registerApplicationInteractionsHttp> | undefined;
  let filesHttp: ReturnType<typeof registerApplicationFilesHttp> | undefined;
  let usageHttp: ReturnType<typeof registerApplicationUsageHttp> | undefined;
  let metadataHttp: ReturnType<typeof registerApplicationMetadataHttp> | undefined;
  return {
    endpoint: link.connector, headers: options.withKey === false ? {} : { cookie: `agentopsdeck_session=${session}` },
    evidence: options.withKey === false ? {} : { cookie: `agentopsdeck_session=${session}` },
    revoke: () => auth.revokeSession(session),
    register(app: Hono, ports: { codex?: CodexInteractionsHttp; sdk?: SdkInteractionsHttp }) {
      http = registerApplicationInteractionsHttp(app, { commands, credentials: { token: () => token },
        observeActor: async request => await auth.authorize(request) ? 'original-administrator' : undefined,
        available: () => true, transactions: true, diagnostics, timeoutMs: options.timeoutMs ?? 10_000, ...ports });
    },
    registerFiles(app: Hono, ports: { codex?: CodexFilesHttp; sdk?: SdkFilesHttp }) {
      filesHttp = registerApplicationFilesHttp(app, { commands, credentials: { token: () => token },
        observeActor: async request => await auth.authorize(request) ? 'original-administrator' : undefined,
        available: () => true, transactions: true, diagnostics, timeoutMs: options.timeoutMs ?? 10_000, ...ports });
    },
    registerUsage(app: Hono, ports: { codex?: CodexPublicUsageHttp; sdk?: SdkUsageHttp }) {
      usageHttp = registerApplicationUsageHttp(app, { commands, credentials: { token: () => token },
        observeActor: async request => await auth.authorize(request) ? 'original-administrator' : undefined,
        available: () => true, transactions: true, diagnostics, timeoutMs: options.timeoutMs ?? 10_000, ...ports });
    },
    closeUsage: () => usageHttp?.close(),
    registerMetadata(app: Hono, ports: { codex?: CodexCatalogHttp; sdk?: SdkMetadataHttp }) {
      metadataHttp = registerApplicationMetadataHttp(app, { credentials: { token: () => token },
        observeActor: async request => await auth.authorize(request) ? 'original-administrator' : undefined,
        available: () => true, diagnostics, timeoutMs: options.timeoutMs ?? 10_000, ...ports });
    },
    closeMetadata: () => metadataHttp?.close(),
    async close() { await Promise.all([http?.close(), filesHttp?.close(), usageHttp?.close(), metadataHttp?.close(), commands.close()]); await auth.closeForShutdown(); link.closeUnused(); },
  };
}
