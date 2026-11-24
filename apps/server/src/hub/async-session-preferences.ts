import { HUB_SESSION_PREFERENCE_RPC_BYTES, validHubSessionPreferenceChange, type HubSessionPreferenceChange } from './member-session-preference-domain.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubSessionPreferencesPort } from '../routes/hub-session-preferences.js';
import { HubRequestWork } from './async-request-work.js';
import { copyOriginalRequest } from './original-request-scope.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';

/** Mutation-only candidate. The original unbounded preference Map is NOT
 * silently converted to a bounded/truncated RPC result. Not app activation. */
export class AsyncHubSessionPreferences implements HubSessionPreferencesPort {
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
    this.close = () => { void this.work.close(); return drain(); };
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  readonly principal = (request: Request) => this.work.run(async () => (await this.requests.begin(request)).principal);
  readonly set = (request: Request, userId: string, change: HubSessionPreferenceChange) =>
    this.work.run(() => this.setOriginal(request, userId, change));
  private readonly setOriginal = async (request: Request, userId: string, change: HubSessionPreferenceChange) => {
    let copied: HubSessionPreferenceChange;
    // Serialization capacity refusal is 503, not a destructive schema migration.
    try { copied = JSON.parse(encodeHubMemberJson(change, HUB_SESSION_PREFERENCE_RPC_BYTES)); }
    catch { throw new HubMemberRequestError(503); }
    if (!validHubSessionPreferenceChange(copied)) throw new HubMemberRequestError(400);
    const evidence = Object.freeze(hubMemberEvidence(request));
    const original = copyOriginalRequest(request);
    const authority = await this.requests.begin(original);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    let value;
    try { value = (await this.persistence.run(29, () => this.owner.command('sessionPreferenceSet', {
      evidence, expectedScope: authority.recoveryScope, change: copied,
    }))).value; }
    catch { throw new HubMemberRequestError(503); }
    await authority.check(); // Deny delivery, never undo/replay a committed write.
    if (!value) throw new HubMemberRequestError(401);
    if ('error' in value) throw new HubMemberRequestError(404);
  };
}
