import type { BoardWrite } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { HUB_BOARD_RPC_BYTES, HUB_BOARD_RPC_NODES, validHubBoardCommand, validHubBoardReply, hubBoardReplyExpectation,
  type HubBoardCommand, type HubBoardResult } from './member-board-domain.js';

/** Complete private-board caller boundary, not application activation. Native
 * file bindings/capabilities remain with their original coherent coordinator.
 * No mutation is timed out, cancelled, automatically retried or replayed. */
export class AsyncHubWorkspaceBoards {
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
  readonly principal = (request: Request) => this.work.run(async () => (await this.requests.begin(request)).principal);
  private run(request: Request, userId: string, command: HubBoardCommand): Promise<HubBoardResult> {
    return this.work.run(() => this.runOriginal(request, userId, command));
  }
  private async runOriginal(request: Request, userId: string, originalCommand: HubBoardCommand): Promise<HubBoardResult> {
    let command: HubBoardCommand;
    try {
      command = JSON.parse(encodeHubMemberJson(originalCommand, HUB_BOARD_RPC_BYTES, HUB_BOARD_RPC_NODES));
      if (!validHubBoardCommand(command)) throw new Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    // Copy all original evidence and correlation data before the first await.
    const evidence = Object.freeze(hubMemberEvidence(request));
    const pinned = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const expected = hubBoardReplyExpectation(command);
    const authority = await this.requests.begin(pinned);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    const work = () => this.owner.command('workspaceBoard', { evidence, expectedScope: authority.recoveryScope, command });
    let value: HubBoardResult;
    try {
      value = command.action === 'save' ? (await this.persistence.run(66, work)).value
        : (await this.reads.run(request, 65, work)).value;
      if (!validHubBoardReply(expected, value)) throw new Error('invalid_owner_reply');
    } catch (error) { throw new HubMemberRequestError(command.action !== 'save' && error instanceof AuthReadCancelledError ? 499 : 503); }
    if (value === null) throw new HubMemberRequestError(401);
    // Denial after commit affects delivery only; the durable mutationId remains
    // the user's explicit reconciliation path, never a newly generated write.
    await authority.check();
    return value;
  }
  readonly list = async (request: Request, userId: string) => {
    const value = await this.run(request, userId, { action: 'list' });
    if (!value || value.action !== 'list') throw new HubMemberRequestError(503);
    return value.summaries;
  };
  readonly get = async (request: Request, userId: string, resourceId: string) => {
    const value = await this.run(request, userId, { action: 'get', resourceId });
    if (!value || value.action !== 'get') throw new HubMemberRequestError(503);
    return value.document;
  };
  readonly summary = async (request: Request, userId: string, resourceId: string) => {
    const value = await this.run(request, userId, { action: 'summary', resourceId });
    if (!value || value.action !== 'summary') throw new HubMemberRequestError(503);
    return value.summary;
  };
  /** Board projection and public binding are observed in one identity savepoint. */
  readonly snapshot = async (request: Request, userId: string, resourceId: string) => {
    const value = await this.run(request, userId, { action: 'snapshot', resourceId });
    if (!value || value.action !== 'snapshot') throw new HubMemberRequestError(503);
    return { document: value.document, binding: value.binding };
  };
  readonly save = async (request: Request, userId: string, resourceId: string, document: BoardWrite) => {
    const value = await this.run(request, userId, { action: 'save', resourceId, document });
    if (!value || value.action !== 'save') throw new HubMemberRequestError(503);
    return value.result;
  };
}
