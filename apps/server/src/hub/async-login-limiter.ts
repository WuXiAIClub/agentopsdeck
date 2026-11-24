import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { copyLoginAttemptDecision } from '../auth/login-attempt-decision.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';

/** Awaited original persistent limiter, not an off-thread owner claim.
 * All requests share admission. No timeouts, per-request policy, clock or
 * cancellation can discard a failure/success transaction or reset a ban. */
export class AsyncHubLoginLimiter {
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
  }
  get pending() { return this.persistence.pending; }
  /** Drain ban/success commits without expiring, releasing or replaying them. */
  close(): Promise<void> { return this.persistence.close(); }
  readonly check = async (subject: string) => copyLoginAttemptDecision(
    (await this.persistence.run(17, () => this.owner.command('loginLimiterCheck', { subject }))).value);
  readonly recordFailure = async (subject: string) => copyLoginAttemptDecision(
    (await this.persistence.run(18, () => this.owner.command('loginLimiterFailure', { subject }))).value);
  readonly recordSuccess = async (subject: string): Promise<void> => {
    await this.persistence.run(19, () => this.owner.command('loginLimiterSuccess', { subject }));
  };
}
