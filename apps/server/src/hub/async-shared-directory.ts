import { HubRequestWork } from './async-request-work.js';
import { copyOriginalRequest, pinOriginalRequestScope } from './original-request-scope.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import type { SessionDirectoryQuery } from '@agentopsdeck/shared';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_SHARED_DIRECTORY_BYTES, validHubSharedDirectoryCommand, validHubSharedDirectoryReply,
  type HubSharedDirectoryCommand } from './member-shared-directory-domain.js';
import { parseSessionDirectoryQuery } from '../projection/session-directory.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Original identity/grant checks bracket remote discovery. Grant maintenance
 * can write: its original ACK must settle, never time out, replay or release
 * ownership early. This port neither creates sessions nor execution authority. */
export class AsyncHubSharedDirectory {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly work = new HubRequestWork();
  private readonly drain: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly connector: AsyncConnectorClientResolver,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  get pendingRequests() { return this.work.pending; }
  close(): Promise<void> { void this.work.close(); return this.drain(); }
  sessions(request: Request, target: HubSharedDirectoryCommand['target']) {
    return this.work.run(() => this.sessionsOriginal(request, target));
  }
  private async sessionsOriginal(request: Request, target: HubSharedDirectoryCommand['target']) {
    const original = copyOriginalRequest(request);
    // Reject accessors/proxies and own route parameters before the first await.
    let opening: HubSharedDirectoryCommand;
    try { opening = JSON.parse(encodeHubMemberJson({ action: 'open', target }, HUB_SHARED_DIRECTORY_BYTES)); }
    catch { throw new HubMemberRequestError(400); }
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    const scope = original.headers.get('x-agentopsdeck-recovery-scope');
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    pinOriginalRequestScope(original, authority.recoveryScope);
    pinOriginalRequestScope(request, authority.recoveryScope);
    const command = async (input: HubSharedDirectoryCommand) => {
      if (!validHubSharedDirectoryCommand(input)) throw new HubMemberRequestError(400);
      await authority.check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      let value;
      try { value = (await this.persistence.run(74, () => this.owner.command('sharedDirectory', {
        evidence, expectedScope: authority.recoveryScope, command: input }))).value; }
      catch { await authority.check(); throw new HubMemberRequestError(503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check();
      if (!validHubSharedDirectoryReply(input, value)) throw new HubMemberRequestError(503);
      if ('error' in value) throw new HubMemberRequestError(value.error === 'missing' ? 404 : 403);
      if (value.userId !== authority.principal.userId) throw new HubMemberRequestError(503);
      return value;
    };
    // Preserve authentication/grant denial priority over invalid query errors.
    const opened = await command(opening);
    if (opened.action !== 'open') throw new HubMemberRequestError(503);
    let query: SessionDirectoryQuery;
    try {
      const params = new URL(original.url).searchParams;
      if ([...params.keys()].some(key => !['after', 'limit'].includes(key))) throw Error('invalid_page');
      query = { ...parseSessionDirectoryQuery(params), ...opened.resource };
    } catch { throw new HubMemberRequestError(400); }
    this.work.check();
    const client = await this.connector(original, opened.target.connectionId,
      { grant: opened.proof, expectedUserId: authority.principal.userId });
    this.work.check();
    await authority.check(); this.work.check();
    const page = await client.withLocalFence(() => this.work.check()).sessionDirectoryOriginal(query, original.signal);
    this.work.check();
    // Copy remote data before the next permission await. No remote/caller edit
    // may change the page being projected by the original database owner.
    let project: HubSharedDirectoryCommand;
    try { project = JSON.parse(encodeHubMemberJson({ action: 'project', target: opened.target,
      proof: opened.proof, query, page }, HUB_SHARED_DIRECTORY_BYTES)); }
    catch { throw new HubMemberRequestError(503); }
    if (!validHubSharedDirectoryCommand(project)) throw new HubMemberRequestError(503);
    const projected = await command(project);
    if (projected.action !== 'project') throw new HubMemberRequestError(503);
    return projected.page;
  }
}
