import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';

/** Awaited original-owner activity port, not off-thread SQL. Never discard an
 * outstanding activity write, reconnect its owner, or replay a lost reply. */
export class AsyncHubMemberActivity {
  private readonly persistence: AuthRoutePersistence;
  private readonly requests: AsyncHubMemberRequests;
  private readonly work = new HubRequestWork();
  readonly close: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    const drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
    // Fence before diagnostics can synchronously reenter any retained method.
    this.close = () => { void this.work.close(); return drain(); };
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  get pendingWork() { return this.work.pending; }
  readonly recordActivity = (request: Request): Promise<void> => this.work.run(() => this.recordOriginal(request));
  private async recordOriginal(request: Request): Promise<void> {
    // Capture credential and cancellation evidence before the first await.
    const evidence = Object.freeze(hubMemberEvidence(request));
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const authority = await this.requests.begin(original);
    let value;
    try {
      value = (await this.persistence.run(30, () => this.owner.command('memberActivity', {
        evidence, expectedScope: authority.recoveryScope,
      }))).value;
    } catch { throw new HubMemberRequestError(503); }
    if (!value) throw new HubMemberRequestError(401);
    // Delivery refusal cannot undo or repeat an already committed activity.
    await authority.check();
  }
}
