import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_WORKSPACE_BYTES, HUB_WORKSPACE_NODES, validHubWorkspaceDocument } from './member-workspace-domain.js';
import type { HubWorkspacePreferencesPort } from '../routes/hub-workspace-preferences.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';

/** Awaitable caller of the COMPLETE original Hub owner; this facade alone
 * does not move SQL off-thread. Capture the document before the first await; original request
 * credentials and SQL role/scope are authoritative, never the supplied user ID.
 * A cancelled HTTP response cannot cancel a CAS or release its reservation. */
export class AsyncHubWorkspacePreferences implements HubWorkspacePreferencesPort {
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
    this.work.check();
    // Evidence is extracted before any permission wait, so caller mutation of
    // Request headers cannot transfer the original command to another account.
    const evidence = Object.freeze(hubMemberEvidence(request));
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const scope = original.headers.get('x-agentopsdeck-recovery-scope');
    const authority = await this.requests.begin(original);
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    return { evidence, expectedScope: authority.recoveryScope, authority };
  }
  readonly get = (request: Request, userId: string) => this.work.run(() => this.getOriginal(request, userId));
  private readonly getOriginal = async (request: Request, userId: string) => {
    const { authority, ...proof } = await this.pin(request, userId);
    try {
      const { value } = await this.reads.run(request, 20, () => this.owner.command('workspaceGet', proof));
      if (!value || !('document' in value)) throw new HubMemberRequestError(401);
      await authority.check();
      return value.document;
    } catch (error) {
      if (error instanceof HubMemberRequestError) throw error;
      throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
    }
  };
  readonly save = (request: Request, userId: string, document: WorkspacePreferences) =>
    this.work.run(() => this.saveOriginal(request, userId, document));
  private readonly saveOriginal = async (request: Request, userId: string, document: WorkspacePreferences) => {
    let copied: WorkspacePreferences;
    try {
      copied = JSON.parse(encodeHubMemberJson(document, HUB_WORKSPACE_BYTES, HUB_WORKSPACE_NODES));
      if (!validHubWorkspaceDocument(copied)) throw new HubMemberRequestError(400);
    } catch { throw new HubMemberRequestError(400); }
    const { authority, ...proof } = await this.pin(request, userId);
    // No read timeout or abort race around mutation. Final proof can deny
    // delivery after COMMIT, but never rewinds, retries or regenerates the CAS.
    let value;
    try { value = (await this.persistence.run(21, () => this.owner.command('workspaceSave', { ...proof, document: copied }))).value; }
    catch { throw new HubMemberRequestError(503); }
    if (!value) throw new HubMemberRequestError(401);
    await authority.check();
    return 'document' in value ? value.document : undefined;
  };
}
