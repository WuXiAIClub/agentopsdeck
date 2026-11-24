import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { HUB_FILE_BINDING_RPC_BYTES, validHubFileBindingCommand, validHubFileBindingReply, type HubFileBindingCommand } from './member-file-binding-domain.js';

/** Awaited original read, not an activated SQL worker or a write capability. */
export class AsyncHubFileBindingReads {
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
  readonly read = (request: Request, userId: string, input: HubFileBindingCommand) => this.work.run(async () => {
    let command: HubFileBindingCommand;
    try {
      command = JSON.parse(encodeHubMemberJson(input, HUB_FILE_BINDING_RPC_BYTES));
      if (!validHubFileBindingCommand(command)) throw Error('invalid');
    } catch { throw new HubMemberRequestError(400); }
    const evidence = Object.freeze(hubMemberEvidence(request));
    const pinned = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const authority = await this.requests.begin(pinned);
    this.work.check();
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    let value;
    try {
      value = (await this.reads.run(pinned, 81, () => {
        this.work.check();
        return this.owner.command('fileBindingRead', { evidence, expectedScope: authority.recoveryScope, command });
      })).value;
      if (!validHubFileBindingReply(command, value)) throw Error('invalid_owner_reply');
    } catch (error) { throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503); }
    if (value === null) throw new HubMemberRequestError(401);
    await authority.check(); this.work.check(); return value.binding;
  });
}
