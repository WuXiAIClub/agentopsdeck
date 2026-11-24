import type { CardWrite, DrawingWrite, NativeDrawioWrite } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { HUB_VISUAL_RPC_BYTES, HUB_VISUAL_RPC_NODES, validHubVisualCommand, validHubVisualReply,
  hubVisualExpectation, type HubVisualCommand, type HubVisualResult } from './member-visual-domain.js';

/** Awaited original card/drawing/native draw.io commands. No second writer, native-file
 * bypass, cancelled write, uncertain-write replay or synchronous fallback. */
export class AsyncHubWorkspaceVisuals {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly requests: AsyncHubMemberRequests;
  private readonly work = new HubRequestWork();
  private readonly drain: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close(): Promise<void> { void this.work.close(); return this.drain(); }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  get pendingWork() { return this.work.pending; }
  private run(request: Request, userId: string, input: HubVisualCommand): Promise<HubVisualResult> {
    return this.work.run(async () => {
      let command: HubVisualCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input, HUB_VISUAL_RPC_BYTES, HUB_VISUAL_RPC_NODES));
        if (!validHubVisualCommand(command)) throw Error('invalid');
      } catch { throw new HubMemberRequestError(400); }
      const evidence = Object.freeze(hubMemberEvidence(request));
      const pinned = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
      const expected = hubVisualExpectation(command);
      const authority = await this.requests.begin(pinned);
      this.work.check();
      if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
      const effect = () => { this.work.check(); return this.owner.command('workspaceVisual', {
        evidence, expectedScope: authority.recoveryScope, command }); };
      let value: HubVisualResult;
      try {
        value = command.action === 'save' ? (await this.persistence.run(76, effect)).value
          : (await this.reads.run(pinned, 75, effect)).value;
        if (!validHubVisualReply(expected, value)) throw Error('invalid_owner_reply');
      } catch (error) { throw new HubMemberRequestError(command.action !== 'save' && error instanceof AuthReadCancelledError ? 499 : 503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check();
      this.work.check();
      return value;
    });
  }
  readonly listNativeDrawio = async (request: Request, userId: string) => {
    const v = await this.run(request, userId, { kind: 'native-drawio', action: 'list' });
    if (!v || v.kind !== 'native-drawio' || v.action !== 'list') throw new HubMemberRequestError(503);
    return v.summaries;
  };
  readonly getNativeDrawio = async (request: Request, userId: string, resourceId: string) => {
    const v = await this.run(request, userId, { kind: 'native-drawio', action: 'get', resourceId });
    if (!v || v.kind !== 'native-drawio' || v.action !== 'get') throw new HubMemberRequestError(503);
    return v.document;
  };
  readonly saveNativeDrawio = async (request: Request, userId: string, resourceId: string, document: NativeDrawioWrite) => {
    const v = await this.run(request, userId, { kind: 'native-drawio', action: 'save', resourceId, document });
    if (!v || v.kind !== 'native-drawio' || v.action !== 'save') throw new HubMemberRequestError(503);
    return v.result;
  };
  readonly listCards = async (request: Request, userId: string) => {
    const v = await this.run(request, userId, { kind: 'card', action: 'list' });
    if (!v || v.kind !== 'card' || v.action !== 'list') throw new HubMemberRequestError(503);
    return v.summaries;
  };
  readonly getCard = async (request: Request, userId: string, resourceId: string) => {
    const v = await this.run(request, userId, { kind: 'card', action: 'get', resourceId });
    if (!v || v.kind !== 'card' || v.action !== 'get') throw new HubMemberRequestError(503);
    return v.document;
  };
  readonly saveCard = async (request: Request, userId: string, resourceId: string, document: CardWrite) => {
    const v = await this.run(request, userId, { kind: 'card', action: 'save', resourceId, document });
    if (!v || v.kind !== 'card' || v.action !== 'save') throw new HubMemberRequestError(503);
    return v.result;
  };
  readonly listDrawings = async (request: Request, userId: string) => {
    const v = await this.run(request, userId, { kind: 'drawing', action: 'list' });
    if (!v || v.kind !== 'drawing' || v.action !== 'list') throw new HubMemberRequestError(503);
    return v.summaries;
  };
  readonly getDrawing = async (request: Request, userId: string, resourceId: string) => {
    const v = await this.run(request, userId, { kind: 'drawing', action: 'get', resourceId });
    if (!v || v.kind !== 'drawing' || v.action !== 'get') throw new HubMemberRequestError(503);
    return v.document;
  };
  readonly saveDrawing = async (request: Request, userId: string, resourceId: string, document: DrawingWrite) => {
    const v = await this.run(request, userId, { kind: 'drawing', action: 'save', resourceId, document });
    if (!v || v.kind !== 'drawing' || v.action !== 'save') throw new HubMemberRequestError(503);
    return v.result;
  };
}
