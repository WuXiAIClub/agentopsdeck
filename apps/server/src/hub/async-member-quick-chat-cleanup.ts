import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubQuickChatCleanupCommand, validHubQuickChatCleanupReply,
  type HubQuickChatCleanupCommand } from './member-quick-chat-cleanup-domain.js';

/** Await the ORIGINAL cleanup ACK. A warning/disconnect cannot manufacture a
 * successful cancel, delete receipt, release SQL or replay an unknown write. */
export class AsyncHubMemberQuickChatCleanup {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner,diagnostics,warningMs,timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics,warningMs);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async begin(request: Request) {
    const original = new Request(request.url,{headers:new Headers(request.headers),signal:request.signal});
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    const proof = {evidence,expectedScope:authority.recoveryScope};
    const run = async (input: HubQuickChatCleanupCommand) => {
      let command: HubQuickChatCleanupCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input,16_384));
        if (!validHubQuickChatCleanupCommand(command)) throw Error('invalid_chat_cleanup');
      } catch { throw new HubMemberRequestError(400); }
      await authority.check();
      let value;
      try { value = (await this.persistence.run(50,()=>this.owner.command('quickChatCleanup',{...proof,command}))).value; }
      catch { throw new HubMemberRequestError(503); } // UNKNOWN, never a retry.
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check(); // Late denial cannot undo a committed effect.
      if (!validHubQuickChatCleanupReply(command,value)) throw new HubMemberRequestError(503);
      if (value.status !== 200) throw new HubMemberRequestError(409);
      return value;
    };
    return Object.freeze({ownerUserId:authority.principal.userId,check:authority.check,
      cancel:(requestId:string)=>run({action:'cancel',requestId}),clear:(requestId:string)=>run({action:'clear',requestId})});
  }
}
