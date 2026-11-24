import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { matchesWeixinBackgroundReply, validWeixinBackgroundResult, type WeixinBackgroundCommand,
  type WeixinBackgroundOwner } from './weixin-background-domain.js';
import type { WeixinBinding } from './weixin-store.js';
import { WeixinError } from './weixin-transport.js';

/** Independently owned by service/bridge; administrative freeze cannot retire
 * the original receive, provider result, reader or settlement ACK prematurely. */
export class AsyncWeixinBackgroundAccess {
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly background: WeixinBackgroundOwner, diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  async command(command: WeixinBackgroundCommand) {
    const result = (await this.persistence.run(106, () => this.background.command(command))).value;
    if (!validWeixinBackgroundResult(result) || !matchesWeixinBackgroundReply(command, result)) throw new HubMemberOwnerUnavailable();
    if ('error' in result) throw new WeixinError(result.error);
    return result;
  }
  async principal(row: WeixinBinding) {
    const snapshot = (await this.persistence.run(6, () => this.owner.command('memberSnapshot', {
      weixinBinding: {id: row.id, user: row.user, keyId: row.keyId},
    }))).value;
    if (!snapshot || snapshot.principal.userId !== row.user) throw new WeixinError('denied');
    return snapshot.principal;
  }
  close() { return this.persistence.close(); }
}
