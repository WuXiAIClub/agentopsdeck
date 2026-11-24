import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { encodeHubMemberJson } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { HubRequestWork } from './async-request-work.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { copyOriginalRequest } from './original-request-scope.js';
import { HUB_EVENT_REPLAY_COMMAND_BYTES, decodeHubEventReplay, validHubEventReplayCommand,
  validHubEventReplayReply, type HubEventReplayCommand } from './member-event-replay-domain.js';
import { DeliverySnapshotReadRejected, type DeliveryPage, type WorkspaceRevisions } from './delivery-reader-protocol.js';

export type HubEventReplayPort = {
  readonly ownerUserId: string;
  readonly initialCursor: string | undefined;
  check(): Promise<void>;
  page(cursor: string | undefined, domains: Map<string, string>): Promise<DeliveryPage>;
  revisions(): Promise<WorkspaceRevisions>;
};
export type AsyncHubEventReplayPort = { open(request: Request): Promise<HubEventReplayPort>; close(): Promise<void> };

/** Request credentials remain evidence, never an owner/admin supplied by HTTP.
 * Cancelling an SSE wait cannot release or replace its original SQL owner. */
export class AsyncHubEventReplay implements AsyncHubEventReplayPort {
  private readonly work = new HubRequestWork();
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  private revisionTail: Promise<void> = Promise.resolve();
  private revisionPending = 0;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close() { void this.work.close(); return this.drain(); }
  open(request: Request): Promise<HubEventReplayPort> { return this.work.run(() => this.openOriginal(request)); }
  private async openOriginal(request: Request): Promise<HubEventReplayPort> {
    const original = copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    this.work.check();
    const scope = original.headers.get('x-agentopsdeck-recovery-scope') ?? new URL(original.url).searchParams.get('recoveryScope');
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    let failed = false;
    const check = async () => {
      this.work.check();
      if (failed) throw new HubMemberRequestError(503);
      await authority.check(); this.work.check();
    };
    const read = async (input: HubEventReplayCommand) => {
      await check();
      let command: HubEventReplayCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input, HUB_EVENT_REPLAY_COMMAND_BYTES));
        if (!validHubEventReplayCommand(command)) throw Error('invalid');
      } catch { throw new HubMemberRequestError(400); }
      try {
        const result = await this.reads.run(original, 92, () => {
          this.work.check();
          const invoke = () => {
            this.work.check();
            if (original.signal.aborted) throw new AuthReadCancelledError();
            return this.owner.command('eventReplay', { evidence, expectedScope: authority.recoveryScope, command });
          };
          if (command.action !== 'revisions') return invoke();
          if (this.revisionPending >= 64) throw new HubMemberRequestError(503);
          this.revisionPending++;
          // Follow the actual owner ACK, never the cancel/timeout race above.
          const acknowledgement = this.revisionTail.then(invoke);
          this.revisionTail = acknowledgement.then(() => { this.revisionPending--; }, () => { this.revisionPending--; });
          return acknowledgement;
        });
        this.work.check();
        if (!validHubEventReplayReply(command, result.value)) throw Error('invalid_ack');
        if (result.value === null) throw new HubMemberRequestError(401);
        const data = decodeHubEventReplay(result.value);
        await check();
        return data;
      } catch (error) {
        failed = true;
        throw error instanceof HubMemberRequestError ? error
          : new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
      }
    };
    // Capture before the route acquires/starts its broker subscription.
    const first = await read({ action: 'cursor' });
    if (first.action !== 'cursor') throw new HubMemberRequestError(503);
    return Object.freeze({ ownerUserId: authority.principal.userId, initialCursor: first.cursor ?? undefined,
      check: () => this.work.run(check),
      page: (cursor: string | undefined, domains: Map<string, string>) => this.work.run(async () => {
        const data = await read({ action: 'page', cursor: cursor ?? null, domains: [...domains] });
        if (data.action !== 'page') throw new HubMemberRequestError(503);
        return { ...data.page, cursor: data.page.cursor ?? undefined };
      }),
      revisions: () => this.work.run(async () => {
        const data = await read({ action: 'revisions' });
        if (data.action !== 'revisions') throw new HubMemberRequestError(503);
        // This is a validated, completed original ACK, not an unknown read.
        // Preserve the chat cursor while the SSE metadata backoff runs.
        if ('rejected' in data) throw new DeliverySnapshotReadRejected();
        return data.revisions;
      }),
    });
  }
}
