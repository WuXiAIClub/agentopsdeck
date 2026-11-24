import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubGrantCommand, validHubGrantReply, hubGrantReplyExpectation, type HubGrantCommand } from './member-grant-domain.js';
import type { NodeGrantPolicy } from './node-grants.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Definite original policy outcome, never a SQL/COMMIT/ACK failure. */
export class HubMemberGrantPolicyError extends HubMemberRequestError {
  constructor(readonly reason: 'missing' | 'recipient' | 'managed' | 'changed' | 'unverified' | 'capacity') {
    super(reason === 'missing' ? 404 : reason === 'recipient' ? 400 : 409);
  }
}

/** Candidate HTTP port, not application activation. Pins original credentials
 * and node authority before body IO; no remote effect, writer replacement or
 * mutation replay. A deadline cannot settle a durable command. */
export class AsyncHubMemberGrants {
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
  async begin(request: Request, connectionId: string) {
    if (typeof connectionId !== 'string' || !connectionId || Buffer.byteLength(connectionId) > 16_384) throw new HubMemberRequestError(400);
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    const target = Object.freeze({ ownerUserId: authority.principal.userId, connectionId });
    const proof = { evidence, expectedScope: authority.recoveryScope };
    const run = async (input: HubGrantCommand) => {
      if (!validHubGrantCommand(input)) throw new HubMemberRequestError(400);
      // Own policy/actions before any permission await.
      const command = hubGrantReplyExpectation(input);
      await authority.check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      let value;
      try {
        value = command.action === 'create' || command.action === 'replace' || command.action === 'revoke'
          ? (await this.persistence.run(41, () => this.owner.command('grantChange', { ...proof, command }))).value
          : (await this.reads.run(original, 40, () => this.owner.command('grantRead', { ...proof, command }))).value;
      } catch (error) {
        await authority.check(); // Current identity denial has priority, never compensation/replay.
        throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
      }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check(); // Does not undo an already committed original effect.
      if (!validHubGrantReply(command, value)) throw new HubMemberRequestError(503);
      if ('error' in value) {
        // The owner target comes from the original identity, so an absent own
        // connection preserves original 404; Hub admin is not another owner.
        if (value.error === 'denied') throw new HubMemberRequestError(404);
        throw new HubMemberGrantPolicyError(value.error);
      }
      return value;
    };
    const initial = await run({ action: 'authorize', target });
    if (initial.action !== 'authorize') throw new HubMemberRequestError(503);
    const pinned = Object.freeze({ ...initial.authority });
    return {
      authority: pinned,
      async check() {
        const current = await run({ action: 'authorize', target });
        if (current.action !== 'authorize') throw new HubMemberRequestError(503);
        if (current.authority.nodeVersion !== pinned.nodeVersion) throw new HubMemberGrantPolicyError('changed');
      },
      async list(after: string, limit: number) {
        const value = await run({ action: 'list', target, after, limit });
        if (value.action !== 'list') throw new HubMemberRequestError(503);
        return { ...value.authority, grants: value.grants, nextCursor: value.nextCursor };
      },
      async create(userId: string, nodeVersion: number, policy: NodeGrantPolicy) {
        if (nodeVersion !== pinned.nodeVersion) throw new HubMemberGrantPolicyError('changed');
        const value = await run({ action: 'create', target, userId, nodeVersion, policy });
        if (!('grant' in value)) throw new HubMemberRequestError(503);
        return { grant: value.grant };
      },
      async replace(id: string, version: number, nodeVersion: number, policy: NodeGrantPolicy) {
        if (nodeVersion !== pinned.nodeVersion) throw new HubMemberGrantPolicyError('changed');
        const value = await run({ action: 'replace', target, id, version, nodeVersion, policy });
        if (!('grant' in value)) throw new HubMemberRequestError(503);
        return { grant: value.grant };
      },
      async revoke(id: string, version: number) {
        const value = await run({ action: 'revoke', target, id, version, nodeVersion: pinned.nodeVersion });
        if (!('grant' in value)) throw new HubMemberRequestError(503);
        return { grant: value.grant };
      },
    };
  }
}
