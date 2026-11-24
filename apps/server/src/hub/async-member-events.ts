import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { encodeHubEventJson, validHubEventCommand, validHubEventResult,
  type HubEventCommand, type HubEventResult } from './member-event-domain.js';

/** Awaited member event caller boundary. Runtime/legacy-admin feeds and the
 * synchronous application root are not activated by constructing this port.
 * Admission captures immutable JSON BEFORE authority IO. Mutation warnings or
 * caller disconnect never ACK, cancel, replace or replay the original command.
 * The original worker still owns the complete event/cursor/completion commit. */
export class AsyncHubMemberEvents {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner,'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner,diagnostics,warningMs,timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics,warningMs);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  async begin(request: Request) {
    const original = new Request(request.url,{headers:new Headers(request.headers),signal:request.signal});
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    const proof = {evidence,expectedScope:authority.recoveryScope};
    const append = async (input: HubEventCommand) => {
      let command: HubEventCommand;
      try {
        command = JSON.parse(encodeHubEventJson(input));
        if (!validHubEventCommand(command)) throw Error('invalid_event');
      } catch { throw new HubMemberRequestError(400); }
      await authority.check();
      let result: HubEventResult;
      try {
        result = (await this.persistence.run(51,async () => {
          const value = await this.owner.command('eventAppend',{...proof,command});
          // Descriptor-only copy: a broken port's ACK cannot execute accessors
          // or be advertised as settled, including after the SQL has committed.
          const copied: unknown = JSON.parse(encodeHubMemberJson(value,16_384));
          if (!validHubEventResult(copied)) throw Error('invalid_event_ack');
          return copied;
        })).value;
      } catch { throw new HubMemberRequestError(503); } // UNKNOWN, never a retry.
      if (result === null) throw new HubMemberRequestError(401);
      await authority.check(); // Late denial never undoes a committed event.
      return Object.freeze({appended:result.appended});
    };
    return Object.freeze({ownerUserId:authority.principal.userId,check:authority.check,append});
  }
}
