import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';

/** Request-scoped awaited auth dependencies; not an off-thread owner claim.
 * One service budget covers all requests; mutation waits never expire or replay.
 * HTTP cancellation suppresses delivery, not the original session transaction.
 * Existing auth routes still own limiter, audit and final cookie publication. */
export class AsyncHubMemberSessions {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly requests = new WeakMap<Request, ReturnType<AsyncHubMemberSessions['createRequestPort']>>();
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
  }
  get pending() { return this.persistence.pending; }
  private closed = false;
  /** Freeze retained request closures before draining their original work. */
  close(): Promise<void> { this.closed = true; return this.persistence.close(); }

  // Stable request identity carries a failed/unknown fence through all final
  // proofs. A later method call must not silently construct a fresh grant.
  // Weak ownership avoids retaining completed requests or credential closures.
  readonly memberLogin = (key: string | undefined, request: Request) => this.forRequest(request).memberLogin(key);
  readonly memberSessionCurrent = (token: string, request: Request) => this.forRequest(request).memberSessionCurrent(token);
  readonly revokeMemberSession = (token: string, request: Request) => this.forRequest(request).revokeMemberSession(token);

  forRequest(request: Request) {
    let port = this.requests.get(request);
    if (!port) { port = this.createRequestPort(request); this.requests.set(request, port); }
    return port;
  }

  private createRequestPort(request: Request) {
    let failed = false;
    const current = (step: 8 | 11 | 13) => {
      if (this.closed || failed) throw new AuthPersistenceError();
      if (request.signal.aborted) {
        try {
          const trace = this.diagnostics.start('auth-route-persistence');
          trace.add('step', step); trace.add('cancelled', 1); trace.add('pending', this.pending); trace.finish(true);
        } catch { /* Observation cannot dispatch or prolong a cancelled request. */ }
        throw new AuthReadCancelledError();
      }
    };
    const sessionCurrent = async (token: string) => {
      current(13);
      try {
        const result = await this.reads.run(request, 13,
          () => this.owner.command('memberSnapshot', { sessionToken: token }));
        current(13);
        return result.value !== null;
      } catch (error) { failed = true; throw error; }
    };
    return Object.freeze({
      memberLogin: async (key: string | undefined): Promise<string | undefined> => {
        current(8);
        // The shared login route probes member login before administrator
        // login. Preserve its original non-member/invalid-key no-op instead
        // of sending those values into the strict member mutation protocol.
        // Lifecycle, cancellation and unknown-write fences still apply first.
        if (key === undefined || !/^hub_key_[A-Za-z0-9_-]{43}$/.test(key)) return undefined;
        try {
          const result = await this.persistence.run(8, () => this.owner.command('memberSessionCreate', { key }));
          // An invalid key is a known refusal. An owner failure is unknown;
          // neither case may become a new issuance attempt on this request.
          if (result.value === null) return undefined;
          current(8);
          return await sessionCurrent(result.value.token) ? result.value.token : undefined;
        } catch (error) { failed = true; throw error; }
      },
      memberSessionCurrent: sessionCurrent,
      revokeMemberSession: async (token: string): Promise<void> => {
        current(11);
        // Logout also visits this facade for administrator and invalid
        // cookies. They cannot name a member session. Check cancellation,
        // close and the request's unknown-write fence BEFORE this no-op.
        if (!/^hub_session_[A-Za-z0-9_-]{43}$/.test(token)) return;
        try {
          await this.persistence.run(11, () => this.owner.command('memberSessionDelete', { token }));
          current(11);
        } catch (error) { failed = true; throw error; }
      },
    });
  }
}
