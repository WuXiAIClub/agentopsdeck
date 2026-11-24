import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { NodeGrantTarget } from './node-grants.js';
import type { MembershipChange } from './role-access.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubMembershipCommand, validHubMembershipReply, hubMembershipReplyExpectation,
  type HubMembershipCommand, type HubMembershipSnapshot } from './member-membership-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Definite original policy rejection only, not an unknown SQL/ACK outcome. */
export class HubMemberMembershipConflictError extends HubMemberRequestError {
  constructor() { super(409); }
}

/** Awaited original membership/grant/audit transaction, not worker activation.
 * A request deadline cannot cancel, release or repeat a durable mutation. */
export class AsyncHubMemberMemberships {
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
  authorize(request: Request, target: NodeGrantTarget) { return this.run(request, { action: 'authorize', target }); }
  read(request: Request, target: NodeGrantTarget) { return this.run(request, { action: 'read', target }); }
  set(request: Request, target: NodeGrantTarget, membership: MembershipChange) {
    return this.run(request, { action: 'set', target, membership });
  }
  private run(request: Request, command: Extract<HubMembershipCommand, { action: 'authorize' }>): Promise<void>;
  private run(request: Request, command: Extract<HubMembershipCommand, { action: 'read' | 'set' }>): Promise<HubMembershipSnapshot>;
  private async run(request: Request, input: HubMembershipCommand): Promise<HubMembershipSnapshot | void> {
    if (!validHubMembershipCommand(input)) throw new HubMemberRequestError(400);
    // Own every mutable field before the first await; credentials/target cannot
    // be replaced by caller edits while identity or final proof is pending.
    const command = hubMembershipReplyExpectation(input);
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    await authority.check();
    if (original.signal.aborted) throw new HubMemberRequestError(499);
    const proof = { evidence, expectedScope: authority.recoveryScope };
    let value;
    try {
      value = command.action === 'set'
        ? (await this.persistence.run(39, () => this.owner.command('membershipSet', { ...proof, command }))).value
        : (await this.reads.run(original, 38, () => this.owner.command('membershipRead', { ...proof, command }))).value;
    } catch (error) {
      await authority.check(); // Revoked current identity takes priority; no replay.
      throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
    }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check(); // Does not undo any already committed effect.
    if (!validHubMembershipReply(command, value)) throw new HubMemberRequestError(503);
    if ('error' in value) {
      if (value.error === 'denied') throw new HubMemberRequestError(403);
      if (value.error === 'conflict') throw new HubMemberMembershipConflictError();
      throw new HubMemberRequestError(404);
    }
    if ('snapshot' in value) return value.snapshot;
  }
}
