import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_NOTEBOOK_RPC_BYTES, validHubNotebookCommand, validHubNotebookReply, hubNotebookReplyExpectation,
  type HubNotebookCommand, type HubNotebookResult, type PrivateNotebookRead, type SessionNotebookRead } from './member-notebook-domain.js';
import type { NotebookMove } from './notebook-operations.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { pinOriginalRequestScope, copyOriginalRequest } from './original-request-scope.js';
import type { HubPrincipal } from './identity.js';
import type { HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import type { SessionNotebookTarget } from './member-notebook-domain.js';

export type SessionNotebookRequest = {
  request: Request; principal: Readonly<HubPrincipal>; resourceId: string;
  authority: HubSessionNotebookAuthority; check: () => Promise<void>;
};

/** Personal-data commands and session read/proof delivery boundary. Native-file
 * effects retain their separate coherent owner; this is not root activation. */
export class AsyncHubSessionNotebooks {
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
  /** Own the complete HTTP body/effect/settlement/delivery lifetime, not just
   * a snapshot await. No callback crosses the database owner boundary. */
  readonly withSession = <T>(request: Request, target: SessionNotebookTarget,
    effect: (scope: SessionNotebookRequest) => Promise<T>): Promise<T> => this.work.run(async () => {
    let command: HubNotebookCommand;
    try {
      command = JSON.parse(encodeHubMemberJson({action: 'resolveSession', target}, HUB_NOTEBOOK_RPC_BYTES));
      if (!validHubNotebookCommand(command) || command.action !== 'resolveSession') throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const pinned = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(pinned));
    const original = await this.requests.begin(pinned);
    pinOriginalRequestScope(pinned, original.recoveryScope);
    const execute = async (input: HubNotebookCommand) => {
      const expectation = hubNotebookReplyExpectation(input);
      let value;
      try {
        value = (await this.reads.run(pinned, 71, () => this.owner.command('personalNotebook',
          {evidence, expectedScope: original.recoveryScope, command: input}))).value;
        if (!validHubNotebookReply(expectation, value)) throw Error('invalid_owner_reply');
      } catch (error) { throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503); }
      if (!value) throw new HubMemberRequestError(401);
      return value;
    };
    const value = await execute(command);
    if (value.action !== 'resolveSession') throw new HubMemberRequestError(503);
    await original.check();
    if (!value.authority || value.resourceId === null) throw new HubMemberRequestError(404);
    if (value.authority.kind === 'owner' && JSON.parse(value.resourceId)[0] !== original.principal.userId)
      throw new HubMemberRequestError(503);
    // Keep an independent original check command; callbacks cannot retarget it.
    const proof: HubNotebookCommand = JSON.parse(encodeHubMemberJson({action: 'checkSession',
      authority: value.authority, resourceId: value.resourceId}, HUB_NOTEBOOK_RPC_BYTES));
    const check = async () => {
      const checked = await execute(proof);
      await original.check();
      if (checked.action !== 'checkSession' || !checked.current) throw new HubMemberRequestError(403);
    };
    await check();
    const result = await effect({request: pinned, principal: original.principal,
      authority: value.authority, resourceId: value.resourceId, check});
    await check();
    return result;
  });
  private run(request: Request, userId: string, command: HubNotebookCommand): Promise<HubNotebookResult> {
    return this.work.run(() => this.runOriginal(request, userId, command));
  }
  private async runOriginal(request: Request, userId: string, original: HubNotebookCommand): Promise<HubNotebookResult> {
    let command: HubNotebookCommand;
    try { command = JSON.parse(encodeHubMemberJson(original, HUB_NOTEBOOK_RPC_BYTES));
      if (!validHubNotebookCommand(command)) throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const evidence = Object.freeze(hubMemberEvidence(request));
    const pinned = copyOriginalRequest(request);
    const expected = hubNotebookReplyExpectation(command);
    const authority = await this.requests.begin(pinned);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    const work = () => this.owner.command('personalNotebook', { evidence, expectedScope: authority.recoveryScope, command });
    let value: HubNotebookResult;
    try {
      value = command.action === 'save' || command.action === 'saveArchive' || command.action === 'savePrivate' || command.action === 'saveSession' || command.action === 'move'
        ? (await this.persistence.run(72, work)).value : (await this.reads.run(request, 71, work)).value;
      if (!validHubNotebookReply(expected, value)) throw Error('invalid_owner_reply');
    } catch (error) { throw new HubMemberRequestError(!['save', 'saveArchive', 'savePrivate', 'saveSession', 'move'].includes(command.action)
      && error instanceof AuthReadCancelledError ? 499 : 503); }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check();
    return value;
  }
  readonly saveSession = async (request: Request, userId: string,
    document: { resourceId: string; revision: number; text: string }, area: 'hot' | 'cold', styled: boolean,
    authority: import('./member-session-notebook-authority.js').HubSessionNotebookAuthority) => {
    const v = await this.run(request, userId, { action: 'saveSession', document, area, styled, authority });
    if (!v || v.action !== 'saveSession') throw new HubMemberRequestError(503);
    return v;
  };
  readonly snapshotPrivate = async (request: Request, userId: string, read: PrivateNotebookRead) => {
    const v = await this.run(request, userId, {action: 'snapshotPrivate', read});
    if (!v || v.action !== 'snapshotPrivate') throw new HubMemberRequestError(503);
    return v.snapshot;
  };
  readonly snapshotSession = (request: Request, read: SessionNotebookRead) => this.work.run(async () => {
    // Pin the full target and original credentials before the first await.
    let command: HubNotebookCommand;
    try {
      command = JSON.parse(encodeHubMemberJson({action: 'snapshotSession', read}, HUB_NOTEBOOK_RPC_BYTES));
      if (!validHubNotebookCommand(command) || command.action !== 'snapshotSession') throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const pinned = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(pinned));
    const authority = await this.requests.begin(pinned);
    const execute = async (original: HubNotebookCommand) => {
      const expected = hubNotebookReplyExpectation(original);
      let value: HubNotebookResult;
      try {
        value = (await this.reads.run(pinned, 71, () => this.owner.command('personalNotebook',
          {evidence, expectedScope: authority.recoveryScope, command: original}))).value;
        if (!validHubNotebookReply(expected, value)) throw Error('invalid_owner_reply');
      } catch (error) { throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503); }
      if (value === null) throw new HubMemberRequestError(401);
      return value;
    };
    const value = await execute(command);
    if (value.action !== 'snapshotSession') throw new HubMemberRequestError(503);
    if (!value.authority || value.resourceId === null || !value.snapshot) {
      await authority.check();
      throw new HubMemberRequestError(404);
    }
    // An owner result must belong to the pinned actor, never another user's
    // resource tuple, even if a malformed owner reply is structurally valid.
    if (value.authority.kind === 'owner' && JSON.parse(value.resourceId)[0] !== authority.principal.userId)
      throw new HubMemberRequestError(503);
    const checked = await execute({action: 'checkSession', authority: value.authority, resourceId: value.resourceId});
    if (checked.action !== 'checkSession') throw new HubMemberRequestError(503);
    await authority.check();
    if (!checked.current) throw new HubMemberRequestError(403);
    return value.snapshot;
  });
  readonly savePrivate = async (request: Request, userId: string,
    document: { resourceId: string; revision: number; text: string }, area: 'hot' | 'cold' | 'layout', styled: boolean) => {
    const v = await this.run(request, userId, { action: 'savePrivate', document, area, styled });
    if (!v || v.action !== 'savePrivate') throw new HubMemberRequestError(503);
    return v;
  };
  readonly get = async (request: Request, userId: string, resourceId: string) => {
    const v = await this.run(request, userId, { action: 'get', resourceId });
    if (!v || v.action !== 'get') throw new HubMemberRequestError(503); return v.document;
  };
  readonly getArchive = async (request: Request, userId: string, resourceId: string) => {
    const v = await this.run(request, userId, { action: 'archive', resourceId });
    if (!v || v.action !== 'archive') throw new HubMemberRequestError(503); return v.document;
  };
  readonly save = async (request: Request, userId: string, document: { resourceId: string; revision: number; text: string }) => {
    const v = await this.run(request, userId, { action: 'save', document });
    if (!v || v.action !== 'save') throw new HubMemberRequestError(503); return v.document ?? undefined;
  };
  readonly saveArchive = async (request: Request, userId: string, document: { resourceId: string; revision: number; text: string }) => {
    const v = await this.run(request, userId, { action: 'saveArchive', document });
    if (!v || v.action !== 'saveArchive') throw new HubMemberRequestError(503); return v.document ?? undefined;
  };
  readonly searchAreas = async (request: Request, userId: string, resourceId: string, query: string, area: 'hot' | 'cold' | 'both') => {
    const v = await this.run(request, userId, { action: 'search', resourceId, query, area });
    if (!v || v.action !== 'search') throw new HubMemberRequestError(503); return v.result;
  };
  readonly moveReceipt = async (request: Request, userId: string, resourceId: string, requestId: string) => {
    const v = await this.run(request, userId, { action: 'receipt', resourceId, requestId });
    if (!v || v.action !== 'receipt') throw new HubMemberRequestError(503); return v.result ?? undefined;
  };
  readonly move = async (request: Request, userId: string, resourceId: string, input: NotebookMove) => {
    const v = await this.run(request, userId, { action: 'move', resourceId, input });
    if (!v || v.action !== 'move') throw new HubMemberRequestError(503); return v.result ?? undefined;
  };
}
