import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence, type HubMemberCommands } from './member-owner-domain.js';
import type { HubPrincipal } from './identity.js';

/** Awaited port for original application HTTP identity/scope observations.
 * Metadata is not a permission grant. All mutations still require original
 * credentials and their own in-transaction authority, never these user/key IDs.
 * No second writer, callback transport, cached principal, retry or replay. */
export class AsyncHubAuthIdentity {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private closed = false;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
  }
  get pending() { return this.persistence.pending; }
  close(): Promise<void> { this.closed = true; return this.persistence.close(); }
  private async read(request: Request, input: HubMemberCommands['memberIdentity']['input']) {
    if (this.closed) return this.persistence.refuse(12);
    const { value } = await this.reads.run(request, 12, () => this.owner.command('memberIdentity', input));
    if (this.closed) throw new AuthPersistenceError();
    return value === null ? undefined : Object.freeze({ userId: value.userId, keyId: value.keyId });
  }
  readonly memberIdentity = (request: Request) => this.read(request, { action: 'request', evidence: hubMemberEvidence(request) });
  readonly keyIdentity = (key: string | undefined) => this.read(new Request('http://auth.invalid/'), {
    action: 'key', ...(key === undefined ? {} : { key }),
  });
  private async snapshot(request: Request) {
    if (this.closed) return this.persistence.refuse(6);
    const evidence = Object.freeze(hubMemberEvidence(request));
    const { value } = await this.reads.run(request, 6, () => this.owner.command('memberSnapshot', evidence));
    if (this.closed) throw new AuthPersistenceError();
    return value === null ? undefined : Object.freeze({
      principal: Object.freeze({ userId: value.principal.userId, admin: value.principal.admin }),
      recoveryScope: value.recoveryScope,
    });
  }
  readonly requestPrincipal = async (request: Request) => (await this.snapshot(request))?.principal;
  readonly recoveryScope = async (request: Request, expected: HubPrincipal) => {
    // Pin primitive expected identity BEFORE awaiting; this is comparison
    // evidence only, never caller-supplied permission for an SQL mutation.
    const userId = expected.userId, admin = expected.admin;
    const value = await this.snapshot(request);
    return value?.principal.userId === userId && value.principal.admin === admin ? value.recoveryScope : undefined;
  };
}
