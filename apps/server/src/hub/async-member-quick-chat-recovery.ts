import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberQuickChatState } from './async-member-quick-chat-state.js';
import { AsyncHubMemberQuickChatCleanup } from './async-member-quick-chat-cleanup.js';
import { HubMemberRequestError } from './async-member-request.js';
import { QuickChatConflict, type QuickChatReceipt } from './quick-chat-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Existing browser response shapes over ONE original complete Hub owner.
 * This is a caller port, not application activation or a second SQL writer.
 * Queries never invoke discovery, provider inference or original-request POST.
 * Cancel/clear await the original transaction ACK before any response read. */
export class AsyncHubMemberQuickChatRecovery {
  private readonly state: AsyncHubMemberQuickChatState;
  private readonly cleanup: AsyncHubMemberQuickChatCleanup;
  constructor(owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.state = new AsyncHubMemberQuickChatState(owner, diagnostics, warningMs, timeoutMs);
    this.cleanup = new AsyncHubMemberQuickChatCleanup(owner, diagnostics, warningMs, timeoutMs);
  }
  get pending() { return this.state.pending + this.cleanup.pending; }
  close(): Promise<void> {
    const queries = this.state.close(), commands = this.cleanup.close();
    return Promise.all([queries, commands]).then(() => {});
  }
  async begin(request: Request) {
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const state = await this.state.begin(original), cleanup = await this.cleanup.begin(original);
    if (cleanup.ownerUserId !== state.ownerUserId) throw new HubMemberRequestError(401);
    // Strip only the SAME three fields as QuickChatService.inspect. Do not
    // expose internal digest/authority fields or invent new browser tokens.
    const view = (receipt: QuickChatReceipt) => {
      const { fingerprint: _, capabilityEpoch: __, resultRef: ___, ...safe } = receipt; return safe;
    };
    const inspect = async (requestId: string) => {
      const value = await state.inspect(requestId);
      if (!value.receipt) throw new QuickChatConflict('missing'); // Original HTTP 409.
      return { receipt: view(value.receipt), output: value.output };
    };
    return Object.freeze({ ownerUserId: state.ownerUserId, check: state.check,
      list: async () => {
        const value = await state.list();
        return { profiles: value.profiles!, receipts: value.receipts!.map(view) };
      }, inspect,
      cancel: async (requestId: string) => { await cleanup.cancel(requestId); return inspect(requestId); },
      clear: async (requestId: string) => { await cleanup.clear(requestId); return inspect(requestId); },
    });
  }
}
