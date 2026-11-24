import { createHash } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { shouldRegisterConnectorRoutes, shouldRegisterHubRoutes } from './server-role.js';
import { AsyncSqliteAuthOwner } from './auth/async-sqlite-owner.js';
import { AsyncSqliteAuthRoutePort } from './auth/async-sqlite-route-port.js';
import { AuthPersistenceError } from './auth/private-store.js';
import { AuthAuditLog, LoginAttemptLimiter } from './auth/security.js';
import { createApplicationAuthObservations } from './auth/application-auth-observations.js';
import { registerApplicationAuthorization } from './auth/application-authorization.js';
import { registerAuthRoutes } from './routes/auth.js';
import { createApplicationHttpShell } from './application-http-shell.js';
import { createIndependentDrain } from './lifecycle/independent-drain.js';
import { createShutdownCleanup } from './lifecycle/shutdown-cleanup.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { registerAsyncLocalPreferences, type LocalPreferenceProjection } from './auth/local-preference-http.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import type { PerformanceDiagnostics } from './diagnostics/performance.js';
import type { ApplicationTransactionAuthEndpoint } from './auth/application-transaction-gate.js';

/** Private standalone Auth sub-application. The parent still owns Connector
 * activation, legacy commands, signed media and process publication. This is
 * NOT an alternate process root or a fallback for a failed Hub constructor. */
export async function createAsyncStandaloneAuthLayer(config: ServerConfig,
  options: { signedStream?: (request: Request) => boolean; preferences?: LocalPreferenceProjection;
    diagnostics?: PerformanceDiagnostics; legacyConsumersDrain?: () => Promise<void>;
    applicationTransactions?: ApplicationTransactionAuthEndpoint } = {}) {
  startupApplicationCleanup.assertAvailable();
  if (shouldRegisterHubRoutes(config) || !shouldRegisterConnectorRoutes(config) || config.websiteGateway) {
    throw Error('Standalone Auth layer requires a Connector without Hub or website gateway');
  }
  const digestOfKey = () => config.accessKey ? createHash('sha256').update(config.accessKey).digest('hex') : undefined;
  const digest = digestOfKey();
  const drains: (() => void | Promise<void>)[] = [], cleanups: (() => void | Promise<void>)[] = [];
  let frozen = false;
  const freeze = () => { frozen = true; };
  // Install the local fence before any acquired resources can escape.
  const legacyConsumersDrain = options.legacyConsumersDrain;
  drains.push(freeze, () => legacyConsumersDrain?.());
  try {
    const legacyPreferences = options.preferences ? { hidden: config.hiddenSessionsFile,
      archived: config.archivedSessionsFile, pinned: config.pinnedSessionsFile } : undefined;
    const owner = new AsyncSqliteAuthOwner(config.authSqliteFile
      ? { file: config.authSqliteFile, legacyFiles: [config.passkeysFile, config.authSessionsFile],
        ...(legacyPreferences ? { legacyPreferences } : {}),
        ...(digest === undefined ? {} : { accessKeyDigest: digest }) }
      : { kind: 'json', passkeysFile: config.passkeysFile, sessionsFile: config.authSessionsFile,
        ...(legacyPreferences ? { legacyPreferences } : {}),
        ...(digest === undefined ? {} : { accessKeyDigest: digest }) }, options.diagnostics, undefined, 30_000,
      options.applicationTransactions);
    cleanups.push(() => owner.closeForShutdown());
    await owner.open();
    const auth = new AsyncSqliteAuthRoutePort(owner, digest);
    // Read only from the original fixed-file owner before the parent creates
    // its projection or starts any native producers. No bootstrap file writes.
    const preferenceSnapshot = options.preferences ? await owner.localPreferenceSnapshot() : undefined;
    const assertAvailable = () => {
      if (frozen || digestOfKey() !== digest) throw new AuthPersistenceError();
    };
    const authorize = async (request: Request) => {
      assertAvailable();
      const allowed = await auth.authority.authorize(request);
      assertAvailable();
      return allowed === true;
    };
    const commands = createApplicationCommandScopes({ authorize, assertAvailable,
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) });
    drains.push(() => commands.close());
    // An observation retains the original stable actor ID only. No caller may
    // install this as a synchronous command/native-effect authority callback.
    const observeActor = async (request: Request) => await authorize(request) ? 'local:daily' : undefined;
    const observations = createApplicationAuthObservations({ hasHub: false,
      principal: () => undefined, standaloneAuthorization: authorize,
      memberIdentity: () => undefined, keyIdentity: () => undefined, recoveryScope: () => undefined });
    const audit = new AuthAuditLog(), loginLimiter = new LoginAttemptLimiter(config.authRateLimit);
    const { app, stopAdmissions, allowedBrowserOrigin } = createApplicationHttpShell(config);
    drains.push(stopAdmissions);
    const authorization = registerApplicationAuthorization(app, { hasHub: false,
      principal: () => { assertAvailable(); return undefined; }, authorize,
      recordActivity: () => undefined, audit, signedStream: options.signedStream ?? (() => false), allowedBrowserOrigin });
    drains.push(() => authorization.close());
    const routes = registerAuthRoutes(app, {
      get accessKey() { return config.accessKey; },
      passkeys: auth.passkeys, sessions: auth.sessions, authority: auth.authority, ...observations,
      auditLog: audit, loginLimiter, lockoutSeconds: Math.ceil(config.authRateLimit.lockoutMs / 1000),
    });
    drains.push(() => routes.close());
    if (options.preferences) {
      const projection = options.preferences;
      const preferences = registerAsyncLocalPreferences(app, {
        originalJson: owner.originalJson !== undefined, change: input => owner.localPreference(input),
        assertAvailable: () => { assertAvailable(); projection.assertAvailable(); },
        project: result => projection.project(result),
      });
      drains.push(() => preferences.close());
    }
    const close = createShutdownCleanup(createIndependentDrain(drains, 'auth-route-drain'), cleanups,
      undefined, { stopAfterFailure: true });
    return { app, observeActor, commands, close, preferenceSnapshot };
  } catch (error) {
    startupApplicationCleanup.abandon(drains, cleanups);
    try { await startupApplicationCleanup.waitForCurrentCleanup(); } catch { /* Original failure wins. */ }
    throw error;
  }
}
