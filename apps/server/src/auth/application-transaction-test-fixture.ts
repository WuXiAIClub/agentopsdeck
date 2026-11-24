import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import type { ApplicationTransactionAuthEndpoint } from './application-transaction-gate.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncSqliteAuthRoutePort } from './async-sqlite-route-port.js';
import { AsyncHubAuthRoutePort } from '../hub/async-auth-route-port.js';

/** Test-only composition: the SAME physical runtime scenarios must exercise
 * each original Auth root, not a substitute authorize() implementation. */
export function originalApplicationAuthFixture(root: string, role: 'hub' | 'standalone',
  mode: 'json' | 'sqlite', key: string | undefined, diagnostics: PerformanceDiagnostics,
  peer: ApplicationTransactionAuthEndpoint) {
  const digest = key === undefined ? undefined : createHash('sha256').update(key).digest('hex');
  const standalone = role === 'standalone' ? new AsyncSqliteAuthOwner({
    ...(mode === 'json' ? { kind: 'json' as const, passkeysFile: join(root, 'passkeys.json'), sessionsFile: join(root, 'sessions.json') }
      : { file: join(root, 'auth.sqlite'), legacyFiles: [] }),
    ...(digest ? { accessKeyDigest: digest } : {}),
  }, diagnostics, undefined, 30_000, peer) : undefined;
  const hub = role === 'hub' ? new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite'),
    ...(key === undefined ? {} : { administratorKey: key }),
    auth: mode === 'json' ? { kind: 'json', passkeysFile: join(root, 'passkeys.json'), sessionsFile: join(root, 'sessions.json') }
      : { file: join(root, 'auth.sqlite'), legacyFiles: [] },
  }, diagnostics, undefined, 30_000, peer) : undefined;
  return {
    open: () => standalone ? standalone.open() : hub!.open(),
    closeForShutdown: () => standalone ? standalone.closeForShutdown() : hub!.closeForShutdown(),
    issueSession: (token: string) => {
      const input = { token, evidence: digest ? { suppliedKeyDigest: digest } : {} };
      return standalone ? standalone.command('issueAdministratorSession', input)
        : hub!.command('legacyAuth', { kind: 'issueAdministratorSession', input });
    },
    revokeSession: (token: string) => standalone ? standalone.command('deleteSession', { token })
      : hub!.command('legacyAuth', { kind: 'deleteSession', input: { token } }),
    authorize: (request: Request) => standalone ? new AsyncSqliteAuthRoutePort(standalone, digest).authority.authorize(request)
      : new AsyncHubAuthRoutePort(hub!, digest).authority.authorize(request),
  };
}
