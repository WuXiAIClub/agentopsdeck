import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { HubRequestWork } from './async-request-work.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_NOTEBOOK_CONTROL_COMMAND_BYTES, hubNotebookControlExpectation, validHubNotebookControlCommand, validHubNotebookControlReply,
  type HubNotebookControlCommand } from './member-notebook-control-domain.js';
import type { HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { NotebookMoveConflict, type NotebookMove } from './notebook-operations.js';
import type { NotebookCapabilities } from './notebook-capabilities.js';
import { copyOriginalRequest } from './original-request-scope.js';

export class AsyncHubNotebookControl {
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
  private run(request: Request, userId: string, command: HubNotebookControlCommand) {
    return this.work.run(() => this.runOriginal(request, userId, command));
  }
  private async runOriginal(request: Request, userId: string, original: HubNotebookControlCommand) {
    let command: HubNotebookControlCommand;
    try {
      command = JSON.parse(encodeHubMemberJson(original, HUB_NOTEBOOK_CONTROL_COMMAND_BYTES));
      if (!validHubNotebookControlCommand(command)) throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const evidence = Object.freeze(hubMemberEvidence(request));
    const pinned = copyOriginalRequest(request);
    const expectation = hubNotebookControlExpectation(command);
    const authority = await this.requests.begin(pinned);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    const write = command.action === 'move' || command.action === 'issue' || command.action === 'revoke';
    const work = () => this.owner.command('notebookControl', { evidence, expectedScope: authority.recoveryScope, command });
    let value;
    try {
      value = write ? (await this.persistence.run(72, work)).value : (await this.reads.run(request, 71, work)).value;
      if (!validHubNotebookControlReply(expectation, value)) throw Error('invalid_owner_reply');
    } catch (error) { throw new HubMemberRequestError(!write && error instanceof AuthReadCancelledError ? 499 : 503); }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check();
    if (value.action === 'denied') throw new HubMemberRequestError(403);
    return value;
  }
  readonly move = async (request: Request, userId: string, resourceId: string, input: NotebookMove, authority?: HubSessionNotebookAuthority) => {
    const v = await this.run(request, userId, { action: 'move', resourceId, input, ...(authority ? { authority } : {}) });
    if (v.action !== 'move') throw new HubMemberRequestError(503);
    if (!v.result) throw new NotebookMoveConflict(v.conflict!);
    return v.result;
  };
  readonly receipt = async (request: Request, userId: string, resourceId: string, requestId: string, authority?: HubSessionNotebookAuthority) => {
    const v = await this.run(request, userId, { action: 'receipt', resourceId, requestId, ...(authority ? { authority } : {}) });
    if (v.action !== 'receipt') throw new HubMemberRequestError(503); return v.result ?? undefined;
  };
  readonly capabilities = async (request: Request, userId: string, resourceId: string, authority?: HubSessionNotebookAuthority) => {
    const v = await this.run(request, userId, { action: 'capabilities', resourceId, ...(authority ? { authority } : {}) });
    if (v.action !== 'capabilities') throw new HubMemberRequestError(503); return v.capabilities;
  };
  readonly issue = async (request: Request, userId: string, resourceId: string, input: Parameters<NotebookCapabilities['issue']>[2], authority?: HubSessionNotebookAuthority) => {
    const v = await this.run(request, userId, { action: 'issue', resourceId, input, ...(authority ? { authority } : {}) });
    if (v.action !== 'issue') throw new HubMemberRequestError(503); return v.issued ?? undefined;
  };
  readonly revoke = async (request: Request, userId: string, resourceId: string, capabilityId: string, authority?: HubSessionNotebookAuthority) => {
    const v = await this.run(request, userId, { action: 'revoke', resourceId, capabilityId, ...(authority ? { authority } : {}) });
    if (v.action !== 'revoke') throw new HubMemberRequestError(503); return v.revoked;
  };
}
