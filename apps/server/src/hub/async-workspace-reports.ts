import type { WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { HUB_REPORT_RPC_BYTES, validHubReportCommand, validHubReportReply, type HubReportCommand } from './member-report-domain.js';

/** Original local report CAS/receipts; never a file writer, retry or second SQL owner. */
export class AsyncHubWorkspaceReports {
  private readonly persistence: AuthRoutePersistence;
  private readonly requests: AsyncHubMemberRequests;
  private readonly work = new HubRequestWork();
  private readonly drain: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close(): Promise<void> { void this.work.close(); return this.drain(); }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  get pendingWork() { return this.work.pending; }
  readonly save = (request: Request, userId: string, resourceId: string, document: WorkspaceFileCardWrite) => this.work.run(async () => {
    let command: HubReportCommand;
    try {
      command = JSON.parse(encodeHubMemberJson({ resourceId, document }, HUB_REPORT_RPC_BYTES));
      if (!validHubReportCommand(command)) throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const evidence = Object.freeze(hubMemberEvidence(request));
    const pinned = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const authority = await this.requests.begin(pinned);
    this.work.check();
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    let value;
    try {
      value = (await this.persistence.run(80, () => {
        this.work.check();
        return this.owner.command('workspaceReport', { evidence, expectedScope: authority.recoveryScope, command });
      })).value;
      if (!validHubReportReply(command.resourceId, value)) throw Error('invalid_owner_reply');
    } catch { throw new HubMemberRequestError(503); }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check(); this.work.check(); return value;
  });
}
