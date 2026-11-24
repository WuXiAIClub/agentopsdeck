import { copyOriginalRequest } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubRoleCommand, validHubRoleReply, hubRoleReplyExpectation, type HubRoleCommand } from './member-role-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Explicit domain rejection, distinct from authorization or an unknown write.
 * The HTTP adapter preserves the original v2.3.7 conflict wire contract. */
export class HubMemberRoleConflictError extends HubMemberRequestError {
  constructor(readonly reason: 'missing' | 'self' | 'changed') {
    super(reason === 'missing' ? 404 : reason === 'self' ? 403 : 409);
  }
}

/** Candidate caller boundary only, not application activation. Original
 * durable role/grant/audit writes are never cancelled, replaced or replayed. */
export class AsyncHubMemberRoles {
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
  async authorize(request: Request) {
    const authority = await this.requests.begin(request);
    if (!authority.principal.admin) throw new HubMemberRequestError(403);
    await authority.check();
  }
  read(request: Request, userId: string) { return this.run(request, { action: 'read', userId }); }
  set(request: Request, userId: string, role: 'member' | 'admin', version: number) {
    return this.run(request, { action: 'set', userId, role, version });
  }
  private async run(request: Request, command: HubRoleCommand) {
    // Own primitives and headers before awaits. A consumer cannot retarget an
    // in-flight change or change its credentials by editing the original.
    if (!validHubRoleCommand(command)) throw new HubMemberRequestError(400);
    const expected = hubRoleReplyExpectation(command);
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    if (!authority.principal.admin) throw new HubMemberRequestError(403);
    await authority.check();
    if (original.signal.aborted) throw new HubMemberRequestError(499);
    const proof = { evidence, expectedScope: authority.recoveryScope };
    let value;
    try {
      value = command.action === 'read'
        ? (await this.reads.run(original, 35, () => this.owner.command('roleRead', { ...proof, command }))).value
        : (await this.persistence.run(36, () => this.owner.command('roleSet', { ...proof, command }))).value;
    } catch (error) {
      await authority.check(); // Current denial takes priority over a concurrent SQL/ACK fault.
      throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
    }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check(); // A denial cannot undo an already committed effect.
    if (!validHubRoleReply(expected, value)) throw new HubMemberRequestError(503);
    if ('error' in value) {
      if (command.action === 'set') throw new HubMemberRoleConflictError(value.error);
      throw new HubMemberRequestError(404);
    }
    return { role: value.role, version: value.version };
  }
}
