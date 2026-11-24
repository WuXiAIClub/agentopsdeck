import type { WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { HUB_CONFIGURATION_RPC_BYTES, validHubConfigurationCommand, validHubConfigurationReply,
  hubConfigurationExpectation, type HubConfigurationKind, type HubConfigurationCommand,
  type HubConfigurationResult } from './member-configuration-domain.js';

/** Original configuration CAS/receipts, with one original writer and no replay. */
export class AsyncHubWorkspaceConfigurations {
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
  private run(request: Request, userId: string, input: HubConfigurationCommand): Promise<HubConfigurationResult> {
    return this.work.run(async () => {
      let command: HubConfigurationCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input, HUB_CONFIGURATION_RPC_BYTES));
        if (!validHubConfigurationCommand(command)) throw Error('invalid');
      } catch { throw new HubMemberRequestError(400); }
      const evidence = Object.freeze(hubMemberEvidence(request));
      const pinned = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
      const expected = hubConfigurationExpectation(command);
      const authority = await this.requests.begin(pinned);
      this.work.check();
      if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
      const effect = () => { this.work.check(); return this.owner.command('workspaceConfiguration', {
        evidence, expectedScope: authority.recoveryScope, command }); };
      let value: HubConfigurationResult;
      try {
        value = command.action === 'save' ? (await this.persistence.run(78, effect)).value
          : (await this.reads.run(pinned, 77, effect)).value;
        if (!validHubConfigurationReply(expected, value)) throw Error('invalid_owner_reply');
      } catch (error) { throw new HubMemberRequestError(command.action !== 'save' && error instanceof AuthReadCancelledError ? 499 : 503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check(); this.work.check(); return value;
    });
  }
  readonly get = async (request: Request, userId: string, kind: HubConfigurationKind, resourceId: string) => {
    const v = await this.run(request, userId, { kind, action: 'get', resourceId });
    if (!v || v.action !== 'get') throw new HubMemberRequestError(503);
    return v.document;
  };
  readonly save = async (request: Request, userId: string, kind: HubConfigurationKind, resourceId: string, document: WorkspaceFileCardWrite) => {
    const v = await this.run(request, userId, { kind, action: 'save', resourceId, document });
    if (!v || v.action !== 'save') throw new HubMemberRequestError(503);
    return v.result;
  };
}
