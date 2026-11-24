import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_QUICK_CHAT_STATE_COMMAND_BYTES, validHubQuickChatStateCommand, validHubQuickChatStateReply,
  type HubQuickChatStateCommand } from './member-quick-chat-state-domain.js';

/** Awaited recovery queries only. Observer deadlines do not release the
 * original SQL owner, settle UNKNOWN or authorize a provider POST. */
export class AsyncHubMemberQuickChatState {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner,diagnostics,warningMs,timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics,warningMs);
    this.reads = new AuthRouteReadWait(this.persistence,diagnostics,timeoutMs);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  async begin(request: Request) {
    const original = new Request(request.url,{headers:new Headers(request.headers),signal:request.signal});
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    const proof = {evidence,expectedScope:authority.recoveryScope};
    const run = async (input: HubQuickChatStateCommand) => {
      let command: HubQuickChatStateCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input,HUB_QUICK_CHAT_STATE_COMMAND_BYTES));
        if (!validHubQuickChatStateCommand(command)) throw Error('invalid_chat_query');
      } catch { throw new HubMemberRequestError(400); }
      await authority.check();
      let value;
      try { value = (await this.reads.run(original,49,()=>this.owner.command('quickChatState',{...proof,command}))).value; }
      catch (error) { throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503); }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check();
      if (!validHubQuickChatStateReply(command,value)) throw new HubMemberRequestError(503);
      return value;
    };
    return Object.freeze({ownerUserId:authority.principal.userId,check:authority.check,
      list:()=>run({action:'list'}),inspect:(requestId:string)=>run({action:'inspect',requestId})});
  }
}
