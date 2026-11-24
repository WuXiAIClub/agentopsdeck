import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubAccessDirectoryReply } from './member-access-directory-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Awaited display read only; never caches management or execution authority. */
export class AsyncHubMemberDirectory {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async read(request: Request) {
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    await authority.check();
    let value;
    try { value = (await this.reads.run(original, 37, () => this.owner.command('accessDirectory', {
      evidence, expectedScope: authority.recoveryScope,
    }))).value; }
    catch (error) {
      await authority.check();
      throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
    }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check();
    if (!validHubAccessDirectoryReply(authority.recoveryScope, value)
      || value.directory.administrator !== authority.principal.admin) throw new HubMemberRequestError(503);
    return value.directory;
  }
}
