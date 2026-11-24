import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AsyncHubMemberQuickChatRecovery } from './async-member-quick-chat-recovery.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_QUICK_CHAT_EXECUTION_BYTES, validHubQuickChatExecutionCommand, validHubQuickChatExecutionReply,
  validHubQuickChatEffectCommand, validHubQuickChatEffectReply,
  type HubQuickChatExecutionCommand, type HubQuickChatEffectCommand } from './member-quick-chat-execution-domain.js';
import { QuickChatConflict, type QuickChatCapability, type QuickChatProfile } from './quick-chat-store.js';

/** One service-owned lifetime, deliberately independent of the administrative
 * group's admission gate. Close only AFTER the original provider work drains. */
export class AsyncQuickChatExecution {
  private closed = false;
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly recovery: AsyncHubMemberQuickChatRecovery;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.recovery = new AsyncHubMemberQuickChatRecovery(owner, diagnostics, warningMs, timeoutMs);
  }
  close() {
    this.closed = true;
    return Promise.all([this.requests.close(), this.persistence.close(), this.recovery.close()]).then(() => {});
  }
  async begin(request: Request) {
    if (this.closed) throw new HubMemberRequestError(503);
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original), recovery = await this.recovery.begin(original);
    if (this.closed) throw new HubMemberRequestError(503);
    if (authority.principal.userId !== recovery.ownerUserId) throw new HubMemberRequestError(401);
    const proof = { evidence, expectedScope: authority.recoveryScope };
    const run = async (input: HubQuickChatExecutionCommand) => {
      let command: HubQuickChatExecutionCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input, HUB_QUICK_CHAT_EXECUTION_BYTES));
        if (!validHubQuickChatExecutionCommand(command)) throw Error('invalid_chat_command');
      } catch { throw new HubMemberRequestError(400); }
      if (this.closed) throw new HubMemberRequestError(503);
      await authority.check();
      let value;
      try { value = (await this.persistence.run(97, () => this.owner.command('quickChatExecution', { ...proof, command }))).value; }
      catch { throw new HubMemberRequestError(503); } // Unknown ACK: no permit, fallback or replay.
      if (value === null) throw new HubMemberRequestError(401);
      if (!validHubQuickChatExecutionReply(command, value)) throw new HubMemberRequestError(503);
      await authority.check();
      if (value.error) throw new QuickChatConflict(value.error);
      return value;
    };
    return Object.freeze({ ...recovery, check: authority.check,
      lookup: (requestId: string, profileId: string) => run({ action: 'lookup', requestId, profileId }),
      save: (revision: number, profile: Omit<QuickChatProfile, 'revision'>, capability: QuickChatCapability) =>
        run({ action: 'save', revision, profile, capability }),
      admit: (requestId: string, profileId: string, revision: number, identityInput: string, capability: QuickChatCapability) =>
        run({ action: 'admit', requestId, profileId, revision, identityInput, capability }),
      claim: (requestId: string, identityInput: string, capability: QuickChatCapability) =>
        run({ action: 'claim', requestId, identityInput, capability }),
    });
  }
  /** Internal original-effect settlement. Revoked HTTP credentials must not
   * erase facts; owner-generation proof is required instead. Never HTTP-exposed. */
  async effect(input: HubQuickChatEffectCommand) {
    let command: HubQuickChatEffectCommand;
    try {
      command = JSON.parse(encodeHubMemberJson(input, HUB_QUICK_CHAT_EXECUTION_BYTES));
      if (!validHubQuickChatEffectCommand(command)) throw Error('invalid_chat_effect');
    } catch { throw new HubMemberRequestError(400); }
    if (this.closed) throw new HubMemberRequestError(503);
    let value;
    try { value = (await this.persistence.run(98, () => this.owner.command('quickChatEffect', command))).value; }
    catch { throw new HubMemberRequestError(503); }
    if (!validHubQuickChatEffectReply(command, value) || !value.ok) throw new HubMemberRequestError(503);
  }
}
export type AsyncQuickChatContext = Awaited<ReturnType<AsyncQuickChatExecution['begin']>>;
