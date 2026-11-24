import { copyOriginalRequest, pinOriginalRequestScope } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubReceivedGrantCommand, validHubReceivedGrantReply } from './member-received-grants-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** GET has original role-maintenance writes. Await the original settlement,
 * not a read timeout; never replace its owner, repeat work, or authorize execution. */
export class AsyncHubReceivedGrants {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner,diagnostics,warningMs,timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics,warningMs);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async received(request: Request, after: string, limit: number) {
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    // A stale browser account/Hub hint must not discover the current recipient
    // or trigger administrator-derived maintenance. Only the server snapshot
    // establishes the private pin; the public header is never authority.
    const scope = original.headers.get('x-agentopsdeck-recovery-scope');
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    pinOriginalRequestScope(original, authority.recoveryScope);
    pinOriginalRequestScope(request, authority.recoveryScope);
    // Authenticate before query rejection, matching the original route. Invalid
    // input must not initiate administrator-derived maintenance writes.
    if ([...new URL(original.url).searchParams.keys()].some(key=>!['limit','after'].includes(key))) throw new HubMemberRequestError(400);
    const command = Object.freeze({userId:authority.principal.userId,after,limit});
    if (!validHubReceivedGrantCommand(command)) throw new HubMemberRequestError(400);
    await authority.check();
    if (original.signal.aborted) throw new HubMemberRequestError(499);
    let value;
    try { value = (await this.persistence.run(42,()=>this.owner.command('receivedGrants',{
      evidence,expectedScope:authority.recoveryScope,command}))).value; }
    catch { await authority.check(); throw new HubMemberRequestError(503); }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check(); // Original committed maintenance is not undone by final denial.
    if (!validHubReceivedGrantReply(command,value)) throw new HubMemberRequestError(503);
    return value.page;
  }
}
