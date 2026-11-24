import type { LayoutDocument, LayoutKind } from './workspace-layouts.js';
import { HUB_LAYOUT_RPC_BYTES, validHubLayoutDocument, validHubLayoutKind } from './member-layout-domain.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubWorkspaceLayoutsPort } from '../routes/hub-workspace-layouts.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';

/** Awaitable complete-owner caller, not an off-thread SQL owner. Neither an
 * abort nor a wait deadline cancels/replays an admitted layout CAS. */
export class AsyncHubWorkspaceLayouts implements HubWorkspaceLayoutsPort {
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
  readonly principal = (request: Request) => this.work.run(async () => {
    const scope = request.headers.get('x-agentopsdeck-recovery-scope');
    const authority = await this.requests.begin(request);
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    return authority.principal;
  });
  private async pin(request: Request, userId: string) {
    const evidence = Object.freeze(hubMemberEvidence(request));
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const scope = original.headers.get('x-agentopsdeck-recovery-scope');
    const authority = await this.requests.begin(original);
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    return { evidence, expectedScope: authority.recoveryScope, authority };
  }
  readonly get = (request: Request, userId: string, layoutKind: LayoutKind) =>
    this.work.run(() => this.getOriginal(request, userId, layoutKind));
  private readonly getOriginal = async (request: Request, userId: string, layoutKind: LayoutKind) => {
    if (!validHubLayoutKind(layoutKind)) throw new HubMemberRequestError(400);
    const { authority, ...proof } = await this.pin(request, userId);
    try {
      const { value } = await this.reads.run(request, 22, () => this.owner.command('layoutGet', { ...proof, layoutKind }));
      if (!value || !('document' in value)) throw new HubMemberRequestError(401);
      await authority.check(); return value.document;
    } catch (error) {
      if (error instanceof HubMemberRequestError) throw error;
      throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
    }
  };
  readonly save = (request: Request, userId: string, layoutKind: LayoutKind, document: LayoutDocument) =>
    this.work.run(() => this.saveOriginal(request, userId, layoutKind, document));
  private readonly saveOriginal = async (request: Request, userId: string, layoutKind: LayoutKind, document: LayoutDocument) => {
    let copied: LayoutDocument;
    try {
      copied = JSON.parse(encodeHubMemberJson(document, HUB_LAYOUT_RPC_BYTES));
      if (!validHubLayoutKind(layoutKind) || !validHubLayoutDocument(copied, layoutKind)) throw Error('Invalid layout');
    } catch { throw new HubMemberRequestError(400); }
    const { authority, ...proof } = await this.pin(request, userId);
    let value;
    try { value = (await this.persistence.run(23, () => this.owner.command('layoutSave', { ...proof, layoutKind, document: copied }))).value; }
    catch { throw new HubMemberRequestError(503); }
    if (!value) throw new HubMemberRequestError(401);
    await authority.check();
    return 'document' in value ? value.document : undefined;
  };
}
