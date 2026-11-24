import type { BoardCapabilityInput } from './workspace-board-capabilities.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { validHubBoardCapabilityCommand, validHubBoardCapabilityReply, hubBoardCapabilityReplyExpectation,
  type HubBoardCapabilityCommand } from './member-board-capability-domain.js';

/** Candidate of the complete Hub owner, never a second live writer. Issuance
 * and revocation have no abort/deadline/replay: a lost ACK remains unknown.
 * The original SQL identity/scope check belongs to the same transaction. */
export class AsyncHubWorkspaceBoardCapabilities {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly requests: AsyncHubMemberRequests;
  private readonly work = new HubRequestWork();
  readonly close: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    const drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
    this.close = () => { void this.work.close(); return drain(); };
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  get pendingWork() { return this.work.pending; }
  private run(request: Request, userId: string, command: HubBoardCapabilityCommand) {
    return this.work.run(() => this.runOriginal(request, userId, command));
  }
  private async runOriginal(request: Request, userId: string, original: HubBoardCapabilityCommand) {
    let command: HubBoardCapabilityCommand;
    try {
      command = JSON.parse(encodeHubMemberJson(original, 16_384));
      if (!validHubBoardCapabilityCommand(command)) throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const evidence = Object.freeze(hubMemberEvidence(request));
    const pinned = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const expected = hubBoardCapabilityReplyExpectation(command);
    const authority = await this.requests.begin(pinned);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    const work = () => this.owner.command('boardCapability', { evidence, expectedScope: authority.recoveryScope, command });
    let value;
    try {
      value = command.action === 'issue' || command.action === 'revoke' ? (await this.persistence.run(68, work)).value
        : (await this.reads.run(request, 67, work)).value;
      if (!validHubBoardCapabilityReply(expected, value)) throw Error('invalid_owner_reply');
    } catch (error) { throw new HubMemberRequestError(command.action !== 'issue' && command.action !== 'revoke'
      && error instanceof AuthReadCancelledError ? 499 : 503); }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check();
    return value;
  }
  readonly list = async (request: Request, userId: string, resourceId: string) => {
    const value = await this.run(request, userId, { action: 'list', resourceId });
    if (value.action !== 'list') throw new HubMemberRequestError(503);
    return value.capabilities;
  };
  readonly issue = async (request: Request, userId: string, resourceId: string, input: BoardCapabilityInput) => {
    const value = await this.run(request, userId, { action: 'issue', resourceId, input });
    if (value.action !== 'issue') throw new HubMemberRequestError(503);
    return value.issued ?? undefined;
  };
  readonly revoke = async (request: Request, userId: string, resourceId: string, capabilityId: string) => {
    const value = await this.run(request, userId, { action: 'revoke', resourceId, capabilityId });
    if (value.action !== 'revoke') throw new HubMemberRequestError(503);
    return value.revoked;
  };
  readonly events = async (request: Request, userId: string, resourceId: string, before = Number.MAX_SAFE_INTEGER) => {
    const value = await this.run(request, userId, { action: 'events', resourceId, before });
    if (value.action !== 'events') throw new HubMemberRequestError(503);
    return value.events;
  };
}
