import { HUB_COMPLETION_RPC_BYTES, validHubCompletionAction, type HubCompletionAction, type HubCompletionResult } from './member-completion-domain.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubCompletionsPort } from '../routes/hub-completions.js';
import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

/** Candidate complete-owner caller; not application activation. Observation
 * tokens and read ACKs are mutations. No abort/deadline ends those original
 * writes, releases their slots, reconnects the owner or resends a request. */
export class AsyncHubCompletions implements HubCompletionsPort {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly requests: AsyncHubMemberRequests;
  private readonly work = new HubRequestWork();
  readonly close: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    const drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
    this.close = () => { void this.work.close(); return drain(); };
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  readonly principal = (request: Request) => this.work.run(async () => {
    const scope = request.headers.get('x-agentopsdeck-recovery-scope');
    const authority = await this.requests.begin(request);
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    return authority.principal;
  });
  readonly command = (request: Request, userId: string, command: HubCompletionAction): Promise<HubCompletionResult> =>
    this.work.run(() => this.commandOriginal(request, userId, command));
  private readonly commandOriginal = async (request: Request, userId: string, command: HubCompletionAction): Promise<HubCompletionResult> => {
    let copied: HubCompletionAction;
    try {
      copied = JSON.parse(encodeHubMemberJson(command, HUB_COMPLETION_RPC_BYTES));
      if (!validHubCompletionAction(copied)) throw Error('Invalid completion command');
    } catch { throw new HubMemberRequestError(400); }
    // Copy caller-owned input and credentials before the first permission await.
    const evidence = Object.freeze(hubMemberEvidence(request));
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const scope = original.headers.get('x-agentopsdeck-recovery-scope');
    const authority = await this.requests.begin(original);
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    if (authority.principal.userId !== userId) throw new HubMemberRequestError(401);
    const proof = { evidence, expectedScope: authority.recoveryScope, command: copied };
    let value: HubCompletionResult;
    try {
      const pin = (await this.reads.run(original, 82, () => this.owner.command('connectionDirectoryVersion', {
        evidence, expectedScope: authority.recoveryScope, command: { action: 'version' },
      }))).value;
      if (!pin) throw new HubMemberRequestError(401);
      if (pin.action !== 'version') throw new HubMemberRequestError(503);
      this.work.check();
      if (copied.action === 'summary') value = (await this.reads.run(request, 26, () => this.owner.command('completionSummary', proof))).value;
      else if (copied.action === 'observe') value = (await this.persistence.run(27, () => this.owner.command('completionObserve', proof))).value;
      else value = (await this.persistence.run(28, () => this.owner.command('completionRead', proof))).value;
      if (!value) throw new HubMemberRequestError(401);
      await authority.check(); // COMMIT may already have occurred; never undo/replay.
      // Both identity and directory authority are proved inside each original
      // savepoint. No separate principal await may reopen a split final proof.
      for (let delivery = 0; delivery < 2; delivery++) {
        this.work.check();
        const current = (await this.reads.run(original, 83, () => this.owner.command('connectionDirectoryCheck', {
          evidence, expectedScope: authority.recoveryScope, command: { action: 'check', version: pin.version },
        }))).value;
        if (!current) throw new HubMemberRequestError(401);
        if (current.action !== 'check' || current.version !== pin.version || current.target !== undefined || !current.ok) {
          const trace = guardedTrace(this.diagnostics, 'hub-completion-summary-read');
          trace.add('step', 3); trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
          throw new HubMemberRequestError(503);
        }
      }
    } catch (error) {
      if (error instanceof HubMemberRequestError) throw error;
      throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
    }
    return value;
  };
}
