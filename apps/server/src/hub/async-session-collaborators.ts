import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubSessionCollaboratorCommand, validHubSessionCollaboratorReply, type HubSessionCollaboratorCommand } from './member-session-collaborators-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Original listing transaction includes maintenance. No timeout/replay or
 * execution admission. Final check pins BOTH original grant versions. */
export class AsyncHubSessionCollaborators {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
  }
  get pending() { return this.requests.pendingReads + this.persistence.pending; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async collaborators(request: Request, ownerUserId: string, sessionId: string) {
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    const list = Object.freeze({ action: 'list' as const, userId: authority.principal.userId, ownerUserId, sessionId });
    if (!validHubSessionCollaboratorCommand(list)) throw new HubMemberRequestError(404);
    const run = async (command: HubSessionCollaboratorCommand) => {
      await authority.check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      let value;
      try { value = (await this.persistence.run(44, () => this.owner.command('sessionCollaborators', {
        evidence, expectedScope: authority.recoveryScope, command,
      }))).value; }
      catch { await authority.check(); throw new HubMemberRequestError(503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check();
      if (!validHubSessionCollaboratorReply(command, value)) throw new HubMemberRequestError(503);
      if (value.status !== 200) throw new HubMemberRequestError(value.status);
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      return value;
    };
    const value = await run(list);
    await run(Object.freeze({ ...list, action: 'check' as const, proof: Object.freeze({ ...value.proof! }) }));
    return value.page!;
  }
}
